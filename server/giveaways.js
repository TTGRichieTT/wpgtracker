// Giveaways, linked to the WPG server.
//  - Giveaway: runs for a number of matches on the WPG server, starting with the next match (after its start
//    time). Members press Enter (or everyone who plays is entered), optionally with things to do on the WPG
//    server during those matches (minutes played, matches, kills: finished matches only). Winners are drawn at
//    random at the end of the last match, from those on the server then.
//  - Drops: trigger at secret random times between start and end, or whenever staff press the button. Everyone
//    who can win and is on the WPG server when one triggers is in it; when that match ends, those still on who
//    played enough of it get the prize (everyone, or one at random). Crash or nobody qualified? It tries again later.
//  - Top players: whoever does best on the WPG server between start and end (most kills, time played,
//    matches, wins, WPG XP earned, or the WPG rank leaderboard) wins by place.
// Each giveaway has a list of prizes, in order (first prize → first winner / drop / place). A prize is
// something real (staff hand it over; optional codes, one per winner, shown only to them once they claim),
// Clan XP, WPG XP or a medal (those three are given straight away).
// Winners hear about it in the app, on Discord (its own channel if set) and in-game.
import express from 'express';
import crypto from 'crypto';
import { q, one, audit, setting, clearSettingsCache } from './db.js';
import { bus } from './bus.js';
import { HttpError, member, role, roleAtLeast, str, int, bool, safeUrl } from './util.js';
import { seal, open } from './secretbox.js';
import { rcon } from './servers.js';
import { recalcXp } from './steam.js';
import { grantWpgXp, appIsSource } from './wpgxp.js';

export const giveaways = express.Router();

const ONLINE_MS = 2 * 60 * 1000; // seen on the server this recently = on it now
const RETRY_MS = 10 * 60 * 1000; // a drop with nobody on the server tries again this much later
const MAX_SLOTS = 50;
const KINDS = ['scheduled', 'drop', 'top'];
const PRIZE_TYPES = ['item', 'clan_xp', 'wpg_xp', 'medal'];
export const METRICS = {
  kills: 'Most kills', minutes: 'Most time played', matches: 'Most matches', wins: 'Most wins',
  wpg_xp: 'Most WPG XP earned', rank: 'Highest WPG XP (WPG rank leaderboard)',
};
const isStaff = (u) => roleAtLeast(u?.role, 'mod');
const changed = () => bus.emit('config:changed', 'giveaways');
const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;

// Fair random pick of n from a list (crypto-strength shuffle).
function pick(list, n) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// ---------- Prizes ----------
// The prize list (giveaways made before prize lists had one prize in the reward_* columns).
function prizesOf(g) {
  if (Array.isArray(g.prizes) && g.prizes.length) return g.prizes;
  return [{ type: g.reward_type, text: g.reward_text, amount: g.reward_amount, medal: g.reward_medal, count: g.winners, codes: g.reward_codes || [] }];
}
// One slot per winner / drop / place, in order: which prize it gets.
function slots(g) {
  return prizesOf(g).flatMap((p, i) => Array.from({ length: Math.max(1, int(p.count, 1)) }, () => i)).slice(0, MAX_SLOTS);
}
const medalNames = new Map();
async function medalName(id) {
  if (!id) return 'a medal';
  if (!medalNames.has(id)) medalNames.set(id, (await one('SELECT name FROM awards WHERE id=$1', [id]))?.name || 'a medal');
  return medalNames.get(id);
}
export async function prizeText(p) {
  if (p.type === 'clan_xp') return `${Number(p.amount).toLocaleString('en-GB')} Clan XP`;
  if (p.type === 'wpg_xp') return `${Number(p.amount).toLocaleString('en-GB')} WPG XP`;
  if (p.type === 'medal') return `the ${await medalName(p.medal)} medal`;
  return p.text || 'a prize';
}
// For members and admins: the prizes without codes, with labels and who gets them.
async function prizeList(g) {
  let n = 0;
  return Promise.all(prizesOf(g).map(async (p) => {
    const count = Math.max(1, int(p.count, 1));
    const from = n + 1;
    const to = (n += count); // worked out before the await below, so each prize keeps its own places
    return {
      type: p.type, text: p.type === 'item' ? p.text || '' : '', amount: int(p.amount), medal: p.medal || null,
      label: await prizeText(p), count, codes: (p.codes || []).length,
      places: g.kind === 'top' ? (count === 1 ? ordinal(from) : `${ordinal(from)}–${ordinal(to)}`) : null,
    };
  }));
}
async function prizeSummary(g) {
  const list = await prizeList(g);
  return list.map((p) => (p.places ? `${p.places}: ${p.label}` : `${p.label}${p.count > 1 ? ` ×${p.count}` : ''}`)).join(' · ');
}

// ---------- Who can win, and what they've done on the WPG server ----------
const wpgServers = () => q("SELECT * FROM game_servers WHERE wpg_xp = true AND rcon_url <> '' AND rcon_password <> ''");

// Who is on a WPG XP server right now: Steam ID → server id.
async function onServerNow() {
  const rows = await q('SELECT ts.server_id, ts.state FROM server_track_state ts JOIN game_servers g ON g.id = ts.server_id WHERE g.wpg_xp = true');
  const ids = new Map();
  for (const r of rows) {
    for (const [sid, p] of Object.entries(r.state?.players || {})) if (Date.now() - (p.seen || 0) <= ONLINE_MS) ids.set(sid, r.server_id);
  }
  return ids;
}

function canWin(g, u) {
  if (!u || u.status !== 'active') return false;
  if (g.no_staff && isStaff(u)) return false;
  if (g.who === 'members' && u.membership === 'pmc' && !isStaff(u)) return false;
  return true;
}

// Minutes / matches / kills on the WPG server during the giveaway, per user (counted as each match ends).
async function progressFor(g, userIds, until = g.end_at) {
  if (!userIds.length) return new Map();
  const rows = await q(
    `SELECT u.id AS user_id, COALESCE(SUM(mp.seconds), 0)::int AS secs, COUNT(mp.id)::int AS matches, COALESCE(SUM(mp.kills), 0)::int AS kills
       FROM users u JOIN match_players mp ON mp.steam_id = u.steam_id
       JOIN game_servers s ON s.id = mp.server_id AND s.wpg_xp = true
      WHERE u.id = ANY($1) AND mp.ended_at >= $2 AND mp.ended_at <= LEAST($3::timestamptz, now()) AND mp.stayed IS NOT FALSE
      GROUP BY u.id`,
    [userIds, g.start_at, until],
  );
  return new Map(rows.map((r) => [r.user_id, { minutes: Math.floor(r.secs / 60), matches: r.matches, kills: r.kills }]));
}
const hasRules = (g) => g.min_minutes > 0 || g.min_matches > 0 || g.min_kills > 0;
const meets = (g, p) => (p?.minutes || 0) >= g.min_minutes && (p?.matches || 0) >= g.min_matches && (p?.kills || 0) >= g.min_kills;

// Everyone who could win a giveaway draw now (not counting people who've already won it). until: count matches
// that ended up to then (the draw itself happens when the match running at the end time ends).
async function candidates(g, until = g.end_at) {
  const already = new Set((await q('SELECT user_id FROM giveaway_winners WHERE giveaway_id=$1', [g.id])).map((r) => r.user_id));
  const users = g.entry === 'enter'
    ? await q('SELECT u.* FROM giveaway_entries e JOIN users u ON u.id = e.user_id WHERE e.giveaway_id=$1', [g.id])
    // Automatic entry: everyone who played on the WPG server during the giveaway.
    : await q(
      `SELECT DISTINCT u.* FROM users u JOIN match_players mp ON mp.steam_id = u.steam_id
         JOIN game_servers s ON s.id = mp.server_id AND s.wpg_xp = true
        WHERE mp.ended_at >= $1 AND mp.ended_at <= LEAST($2::timestamptz, now()) AND mp.stayed IS NOT FALSE`,
      [g.start_at, until],
    );
  const ok = users.filter((u) => canWin(g, u) && !already.has(u.id));
  if (!hasRules(g)) return ok;
  const prog = await progressFor(g, ok.map((u) => u.id), until);
  return ok.filter((u) => meets(g, prog.get(u.id)));
}

// Top players: everyone who can win, best first, with their score (above 0). Equal scores are put in random order.
async function standings(g) {
  const win = [g.start_at, g.end_at];
  const fromMatches = (expr) => q(
    `SELECT u.*, ${expr}::int AS score FROM users u JOIN match_players mp ON mp.steam_id = u.steam_id
       JOIN game_servers s ON s.id = mp.server_id AND s.wpg_xp = true
      WHERE mp.ended_at >= $1 AND mp.ended_at <= LEAST($2::timestamptz, now()) AND mp.stayed IS NOT FALSE GROUP BY u.id`, win,
  );
  let rows;
  if (g.metric === 'kills') rows = await fromMatches('SUM(mp.kills)');
  else if (g.metric === 'minutes') rows = await fromMatches('FLOOR(SUM(mp.seconds) / 60)');
  else if (g.metric === 'matches') rows = await fromMatches('COUNT(mp.id)');
  else if (g.metric === 'wins') rows = await fromMatches('SUM(CASE WHEN mp.won THEN 1 ELSE 0 END)');
  else if (g.metric === 'wpg_xp') {
    rows = await q(
      `SELECT u.*, SUM(l.xp)::int AS score FROM users u JOIN wpg_xp_log l ON l.steam_id = u.steam_id
        WHERE l.server_id IS NOT NULL AND l.created_at >= $1 AND l.created_at <= LEAST($2::timestamptz, now())
          AND COALESCE((l.detail->>'stayed')::boolean, true) GROUP BY u.id`, win,
    );
  } else rows = await q('SELECT u.*, p.xp AS score FROM users u JOIN server_progress p ON p.steam_id = u.steam_id');
  return pick(rows.filter((u) => u.score > 0 && canWin(g, u)), rows.length).sort((a, b) => b.score - a.score);
}
const UNITS = { kills: 'kills', minutes: 'min', matches: 'matches', wins: 'wins', wpg_xp: 'WPG XP', rank: 'WPG XP' };
const metricUnit = (m, n) => `${Number(n).toLocaleString('en-GB')}${UNITS[m] ? ` ${UNITS[m]}` : ''}`;

// ---------- Handing prizes over ----------
// Gives slot `index` of giveaway g to user u. code: a sealed code (or '' to use the next one for that prize).
async function giveReward(g, u, index, { place = null, score = null, code = null } = {}) {
  const prizes = prizesOf(g);
  const pi = slots(g)[index] ?? 0;
  const p = prizes[pi] || prizes[0];
  if (code === null) {
    const used = (await one('SELECT COUNT(*)::int AS n FROM giveaway_winners WHERE giveaway_id=$1 AND prize_index=$2', [g.id, pi])).n;
    code = (p.codes || [])[used] || '';
  }
  const reason = `Giveaway: ${g.title}`;
  let status = 'won';
  try {
    if (p.type === 'clan_xp') {
      await q('UPDATE users SET bonus_xp = bonus_xp + $2 WHERE id=$1', [u.id, int(p.amount)]);
      await recalcXp(u.id);
      status = 'given';
    } else if (p.type === 'wpg_xp') {
      await grantWpgXp(u.steam_id, u.persona_name, int(p.amount), reason);
      status = 'given';
    } else if (p.type === 'medal' && p.medal) {
      await q('INSERT INTO user_awards (user_id, award_id, given_by, reason) VALUES ($1,$2,NULL,$3)', [u.id, p.medal, reason]);
      bus.emit('announce', { type: 'medals', userId: u.id, names: [await medalName(p.medal)] });
      status = 'given';
    }
  } catch (e) {
    // Couldn't hand it over automatically (e.g. WPG XP while the Discord bot is in charge): staff sort it out.
    console.warn('[giveaways] prize not given automatically', e.message);
    bus.emit('staff:notify', { title: 'Giveaway prize needs handing over', body: `${u.persona_name} won ${await prizeText(p)} but it couldn't be given automatically: ${e.message}`, link: '#/admin/giveaways' });
  }
  const snapshot = { type: p.type, text: p.text || '', amount: int(p.amount), medal: p.medal || null };
  await q(
    'INSERT INTO giveaway_winners (giveaway_id, user_id, code, status, prize_index, prize, place, score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [g.id, u.id, code || '', status, pi, JSON.stringify(snapshot), place, score],
  );
  const prize = await prizeText(p);
  bus.emit('notify', u.id, {
    title: place ? `🏆 ${ordinal(place)} place!` : '🎁 You won a giveaway!',
    body: status === 'given' ? `${g.title}: ${prize} is yours.` : `${g.title}: you won ${prize}. Open Giveaways to claim it within ${g.claim_days} days.`,
    link: '#/giveaways',
  });
  bus.emit('user:changed', u.id);
  return { user: u, status, prize, place, score };
}

// In-game messages on the WPG servers (never stops a draw if the server can't be reached).
async function sayInGame(g, text, whisper) {
  if (!g.in_game) return;
  for (const s of await wpgServers()) {
    await rcon(s, 'POST', '/broadcast', { message: text.slice(0, 256) }).catch(() => {}); // the game's limit
    for (const [steamId, msg] of whisper || []) {
      await rcon(s, 'POST', `/players/${steamId}/message`, { message: msg.slice(0, 256) }).catch(() => {});
    }
  }
}

async function announceWinners(g, won) {
  if (!won.length) return;
  const online = await onServerNow();
  const line = g.kind === 'top'
    ? `WPG TOP PLAYERS (${METRICS[g.metric] || 'results'}): ${won.slice(0, 5).map((w) => `${ordinal(w.place)} ${w.user.persona_name}`).join(', ')}${won.length > 5 ? '…' : ''}. GG!`
    : won.length > 3 && new Set(won.map((w) => w.prize)).size === 1
      ? `WPG ${g.kind === 'drop' ? 'DROP' : 'GIVEAWAY'}: ${won.length} players got ${won[0].prize}! GG`
      : `WPG ${g.kind === 'drop' ? 'DROP' : 'GIVEAWAY'}: ${won.map((w) => `${w.user.persona_name} won ${w.prize}`).join(', ')}! GG`;
  await sayInGame(g, line,
    won.filter((w) => online.has(w.user.steam_id)).map((w) => [w.user.steam_id, `You won ${w.prize}! ${w.status === 'given' ? 'It is yours already.' : 'Open WPG Barracks > Giveaways to claim it.'}`]));
  bus.emit('announce', {
    type: 'giveaway', event: 'winners', id: g.id, kind: g.kind, title: g.title, image: g.image, metric: METRICS[g.metric] || '',
    winners: won.map((w) => ({ userId: w.user.id, prize: w.prize, place: w.place, score: w.score !== null && w.score !== undefined ? metricUnit(g.metric, w.score) : '' })),
  });
}

// ---------- Draws ----------
async function finish(g, actor, pool, won) {
  await audit(actor, 'giveaway.draw', `${g.title} (#${g.id})`, { kind: g.kind, entrants: pool, winners: won.map((w) => `${w.user.persona_name}: ${w.prize}`) });
  await announceWinners(g, won);
  if (!won.length) bus.emit('staff:notify', { title: 'Giveaway ended with no winner', body: `Nobody qualified for "${g.title}".`, link: '#/admin/giveaways' });
  changed();
  return won;
}

// atEnd: Steam ID → seconds played in the match that just ended, for those on the WPG server at its end: only they can win.
async function drawScheduled(g, actor, atEnd) {
  // Only one copy of the app may draw (during a deploy two can briefly run).
  const locked = await one("UPDATE giveaways SET status='done', pending='[]', end_at=LEAST(end_at, now()) WHERE id=$1 AND status IN ('open','drawing') RETURNING *", [g.id]);
  if (!locked) return [];
  const pool = (await candidates(locked, new Date())).filter((u) => atEnd.has(u.steam_id));
  const won = [];
  const n = slots(locked).length;
  for (const [i, u] of pick(pool, n).entries()) won.push(await giveReward(locked, u, i));
  return finish(locked, actor, pool.length, won);
}

async function drawTop(g, actor = null) {
  const locked = await one("UPDATE giveaways SET status='done' WHERE id=$1 AND status='open' RETURNING *", [g.id]);
  if (!locked) return [];
  const ranked = await standings(locked);
  const won = [];
  const n = slots(locked).length;
  for (const [i, u] of ranked.slice(0, n).entries()) won.push(await giveReward(locked, u, i, { place: i + 1, score: u.score }));
  return finish(locked, actor, ranked.length, won);
}

// Whoever is on the WPG server now, counted as having played enough (when a draw can't wait for a match end).
const onNowAsPlayed = async () => new Map([...(await onServerNow()).keys()].map((sid) => [sid, Number.MAX_SAFE_INTEGER]));

// ---------- Drops ----------
// A drop triggers (now, or at a secret random time): everyone who can win and is on the WPG server right then is
// in it. When that match ends, those still on who played enough of it get the prize (everyone, or one at random).
const LONG_MATCH_MS = 90 * 60 * 1000; // a match that hasn't ended after this long: decide with whoever is on now

// Changes a giveaway's pending draws (and fired / fire times) only if nobody else changed them meanwhile.
async function updateDraws(id, fn) {
  for (let i = 0; i < 5; i++) {
    const g = await one('SELECT * FROM giveaways WHERE id=$1', [id]);
    if (!g) return null;
    const change = await fn(g);
    if (!change) return { g, changed: false };
    const row = await one(
      'UPDATE giveaways SET pending=$2, fired=$3, fire_times=$4 WHERE id=$1 AND pending=$5::jsonb AND fired=$6 RETURNING *',
      [id, JSON.stringify(change.pending ?? g.pending), change.fired ?? g.fired, JSON.stringify(change.fire_times ?? g.fire_times),
        JSON.stringify(g.pending), g.fired],
    );
    if (row) return { g: row, changed: true };
  }
  return null;
}
const pendingOf = (g) => (Array.isArray(g.pending) ? g.pending : []);

// Triggers the next drop (or `retry`, a drop being tried again). Returns { players, slot }, { nobody: true } or { none: true }.
async function triggerDrop(id, retry = null) {
  const online = await onServerNow();
  let out = { nobody: true };
  const r = await updateDraws(id, async (g) => {
    if (g.status !== 'open') { out = { none: true }; return null; }
    if (!retry && g.fired >= slots(g).length) { out = { none: true }; return null; }
    const already = g.drop_to === 'all' ? new Set() : new Set((await q('SELECT user_id FROM giveaway_winners WHERE giveaway_id=$1', [g.id])).map((x) => x.user_id));
    const users = online.size ? await q('SELECT * FROM users WHERE steam_id = ANY($1)', [[...online.keys()]]) : [];
    const pool = users.filter((u) => canWin(g, u) && !already.has(u.id));
    if (!pool.length) { out = { nobody: true }; return null; }
    // The server most of them are on (normally there's only one WPG server).
    const counts = new Map();
    for (const u of pool) counts.set(online.get(u.steam_id), (counts.get(online.get(u.steam_id)) || 0) + 1);
    const server = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const slot = retry ? retry.slot : g.fired;
    const entry = { slot, at: new Date().toISOString(), server, pool: pool.filter((u) => online.get(u.steam_id) === server).map((u) => u.steam_id) };
    out = { players: entry.pool.length, slot };
    const rest = pendingOf(g).filter((e) => !(retry && e.retry_at && e.slot === retry.slot));
    return { pending: [...rest, entry], fired: retry ? g.fired : g.fired + 1 };
  });
  if (r?.changed && out.players) {
    const g = r.g;
    const prize = await prizeText(prizesOf(g)[slots(g)[out.slot] ?? 0]);
    const need = g.drop_min_minutes ? ` and play at least ${g.drop_min_minutes} min of it` : '';
    await sayInGame(g, `DROP TRIGGERED: ${prize}! ${g.drop_to === 'all' ? 'Everyone' : 'One player'} on the server now who stays until the END OF THIS MATCH${need} ${g.drop_to === 'all' ? 'gets it' : 'is in the draw'}!`);
    changed();
  }
  return out;
}

// Hands out one triggered drop. stayed: Map Steam ID → seconds played in the match, for those still on at its end.
async function settleDrop(g, entry, stayed) {
  const need = (g.drop_min_minutes || 0) * 60;
  const sids = entry.pool.filter((sid) => stayed.has(sid) && stayed.get(sid) >= need);
  const users = sids.length ? await q('SELECT * FROM users WHERE steam_id = ANY($1)', [sids]) : [];
  const already = g.drop_to === 'all' ? new Set() : new Set((await q('SELECT user_id FROM giveaway_winners WHERE giveaway_id=$1', [g.id])).map((x) => x.user_id));
  const ok = users.filter((u) => canWin(g, u) && !already.has(u.id));
  const chosen = g.drop_to === 'all' ? ok : pick(ok, 1);
  const won = [];
  for (const u of chosen) won.push(await giveReward(g, u, entry.slot));
  if (won.length) {
    await audit(null, 'giveaway.drop', `${g.title} (#${g.id})`, { in_draw: entry.pool.length, qualified: ok.length, winners: won.map((w) => `${w.user.persona_name}: ${w.prize}`) });
    await announceWinners(g, won);
  }
  return won.length;
}

// Takes the drops waiting on `server` (or, with server null, those waiting too long) and settles or re-queues them.
async function settleDrops(server, stayed, trusted) {
  for (const { id } of await q("SELECT id FROM giveaways WHERE kind='drop' AND status='open' AND jsonb_array_length(pending) > 0")) {
    let due = [];
    const r = await updateDraws(id, async (g) => {
      due = [];
      const keep = [];
      for (const e of pendingOf(g)) {
        const mine = e.pool && (server === null ? Date.now() - new Date(e.at).getTime() > LONG_MATCH_MS : e.server === server);
        if (mine) due.push(e); else keep.push(e);
      }
      return due.length ? { pending: keep } : null;
    });
    if (!r?.changed) continue;
    const requeue = [];
    for (const e of due) {
      // Can't trust who stayed (crash / app restart), or nobody qualified: try this drop again in 10 minutes.
      const given = trusted ? await settleDrop(r.g, e, stayed) : 0;
      if (!given) requeue.push({ slot: e.slot, retry_at: new Date(Date.now() + RETRY_MS).toISOString() });
    }
    if (requeue.length) await updateDraws(id, async (g) => ({ pending: [...pendingOf(g), ...requeue] }));
    changed();
  }
}

// Called by the server tracker when a match on a WPG XP server ends. stayed: Steam ID → seconds played in it, for
// everyone still on at the end. trusted: false if the app lost sight of the server or half the players dropped at once.
// real: false for a very short match (restarted or skipped straight away), which doesn't count.
export async function matchEnded(serverId, stayed, { trusted, real = true }) {
  // A very short match (staff restarted or skipped it straight away) decides nothing: drops wait for the next one and
  // giveaways don't count it. Giveaways waiting to start still start with the match beginning now.
  if (real) await settleDrops(serverId, stayed, trusted);
  // Giveaways count their matches; after the last one, the draw is among whoever qualifies and is on now.
  // A match that can't be trusted (crash, app restart) doesn't count: the giveaway runs one more.
  if (trusted && real) {
    for (const g of await q("SELECT * FROM giveaways WHERE status='drawing'")) await drawScheduled(g, null, stayed);
    for (const g of await q("SELECT * FROM giveaways WHERE kind='scheduled' AND status='open' AND match_server=$1", [serverId])) {
      const done = await one("UPDATE giveaways SET matches_done = matches_done + 1 WHERE id=$1 AND status='open' AND matches_done=$2 RETURNING *", [g.id, g.matches_done]);
      if (!done) continue;
      if (done.matches_done >= done.matches) await drawScheduled(done, null, stayed);
      else {
        if (done.matches_done === done.matches - 1) await sayInGame(done, `WPG GIVEAWAY "${done.title}": this is the LAST MATCH. Be on the server at the end of it to be in the draw!`);
        changed();
      }
    }
  }
  // Giveaways waiting to start: they start with the match beginning now.
  for (const g of await q(
    "UPDATE giveaways SET status='open', start_at=now(), matches_done=0, match_server=$1 WHERE kind='scheduled' AND status='scheduled' AND start_at <= now() RETURNING *",
    [serverId],
  )) await announceStart(g);
}

// Random times for drops, spread over the window (from now if it has already started).
function dropTimes(start, end, n) {
  if (n <= 0) return [];
  const from = Math.max(new Date(start).getTime(), Date.now() + 60 * 1000);
  const to = new Date(end).getTime() - 5 * 60 * 1000;
  if (to <= from) throw new HttpError(400, 'The drop window is too short: make it end at least 10 minutes from now.');
  return Array.from({ length: n }, () => from + crypto.randomInt(Math.max(1, to - from))).sort((a, b) => a - b).map((t) => new Date(t).toISOString());
}

async function announceStart(g) {
  const prizes = await prizeSummary(g);
  await sayInGame(g, g.kind === 'drop'
    ? `WPG DROPS are on: be on the server when one triggers and stay until the end of the match! (${prizes})`
    : g.kind === 'top'
      ? `WPG TOP PLAYERS is on: ${METRICS[g.metric] || ''} on this server wins prizes. Open WPG Barracks > Giveaways.`
      : `WPG GIVEAWAY "${g.title}" starts now and runs for ${g.matches} match${g.matches === 1 ? '' : 'es'} (this one is match 1). ${g.entry === 'auto' ? 'Play to be entered.' : 'Enter in WPG Barracks > Giveaways.'} Be on at the end of the last match for the draw!`);
  bus.emit('announce', {
    type: 'giveaway', event: 'start', id: g.id, kind: g.kind, title: g.title, image: g.image, description: g.description,
    end_at: g.end_at, entry: g.entry, metric: METRICS[g.metric] || '', prizes: await prizeList(g),
    drop_to: g.drop_to, drop_min_minutes: g.drop_min_minutes, drop_mode: g.drop_mode, matches: g.matches, min_minutes: g.min_minutes,
  });
  changed();
}

// ---------- The clock ----------
async function tick() {
  // Starting (drops and top players; giveaways start with a match, in matchEnded).
  for (const g of await q("UPDATE giveaways SET status='open' WHERE status='scheduled' AND kind <> 'scheduled' AND start_at <= now() RETURNING *")) await announceStart(g);
  // Ending: top players hand out by place.
  for (const g of await q("SELECT * FROM giveaways WHERE status='open' AND kind='top' AND end_at <= now()")) await drawTop(g);
  // A giveaway draw whose match never ended (e.g. the server emptied): draw from whoever is on now.
  for (const g of await q("SELECT * FROM giveaways WHERE status='drawing' AND end_at < now() - interval '90 minutes'")) {
    await drawScheduled(g, null, await onNowAsPlayed());
  }
  // Drops waiting too long for their match to end: decide with whoever is on now.
  await settleDrops(null, await onNowAsPlayed(), true);
  for (const g of await q("SELECT * FROM giveaways WHERE status='open' AND kind='drop'")) {
    const end = new Date(g.end_at).getTime();
    const times = Array.isArray(g.fire_times) ? g.fire_times : [];
    // A secret random time is due.
    if (g.drop_mode !== 'manual' && g.fired < times.length && new Date(times[g.fired]).getTime() <= Date.now()) {
      const r = await triggerDrop(g.id);
      if (r.nobody) {
        // Nobody on the server: try again in 10 minutes, or give up on that drop if the window has closed.
        const retry = Date.now() + RETRY_MS;
        await updateDraws(g.id, async (x) => {
          if (x.fired !== g.fired) return null;
          return retry < end ? { fire_times: times.map((t, i) => (i === x.fired ? new Date(retry).toISOString() : t)) } : { fired: x.fired + 1 };
        });
      }
    }
    // Drops being tried again.
    const fresh = await one('SELECT * FROM giveaways WHERE id=$1', [g.id]);
    for (const e of pendingOf(fresh).filter((x) => x.retry_at && new Date(x.retry_at).getTime() <= Date.now())) {
      const r = Date.now() < end ? await triggerDrop(g.id, e) : { nobody: true };
      if (r.nobody) {
        const again = Date.now() + RETRY_MS;
        await updateDraws(g.id, async (x) => ({
          pending: pendingOf(x).flatMap((y) => {
            if (!(y.retry_at && y.slot === e.slot)) return [y];
            return again < end ? [{ ...y, retry_at: new Date(again).toISOString() }] : [];
          }),
        }));
      }
    }
    // Finished: nothing waiting, and every drop done (or the window closed).
    const last = await one('SELECT * FROM giveaways WHERE id=$1', [g.id]);
    if (!pendingOf(last).length && (last.fired >= slots(last).length || Date.now() >= end)) {
      if (await one("UPDATE giveaways SET status='done' WHERE id=$1 AND status='open' AND pending='[]'::jsonb RETURNING id", [g.id])) changed();
    }
  }
  // Prizes not claimed in time.
  const expired = await q(
    `UPDATE giveaway_winners w SET status='expired' FROM giveaways g
      WHERE g.id = w.giveaway_id AND w.status='won' AND w.won_at < now() - make_interval(days => g.claim_days)
      RETURNING w.user_id, g.title`,
  );
  for (const e of expired) {
    bus.emit('staff:notify', { title: 'Giveaway prize not claimed', body: `A winner of "${e.title}" didn't claim in time. You can draw someone else in Admin → Giveaways.`, link: '#/admin/giveaways' });
  }
  if (expired.length) changed();
}

export function startGiveaways() {
  const run = async () => {
    try { await tick(); } catch (e) { console.warn('[giveaways]', e.message); }
    setTimeout(run, 30 * 1000);
  };
  setTimeout(run, 20 * 1000);
}

// Discord: the giveaways channel if one is set, otherwise the channel for the other automatic posts.
export async function giveawayChannelKey() {
  return /^\d{15,22}$/.test(String((await setting('discord_giveaway_channel')) || '').trim()) ? 'discord_giveaway_channel' : 'discord_post_channel';
}

// ---------- What members see ----------
async function publicGiveaway(g, extra = {}) {
  return {
    id: g.id, kind: g.kind, title: g.title, description: g.description, image: g.image,
    prizes: (await prizeList(g)).map(({ codes, ...p }) => p), metric: g.metric, metric_label: METRICS[g.metric] || '',
    start_at: g.start_at, end_at: g.end_at, who: g.who, no_staff: g.no_staff, entry: g.entry,
    min_minutes: g.min_minutes, min_matches: g.min_matches, min_kills: g.min_kills, claim_days: g.claim_days, status: g.status,
    drop_mode: g.drop_mode, drop_to: g.drop_to, drop_min_minutes: g.drop_min_minutes, matches: g.matches, matches_done: g.matches_done,
    ...extra,
  };
}
// Drops: how many are still to come (never when), and any triggered drop waiting for its match to end.
function dropState(g, steamId = null) {
  const pend = pendingOf(g);
  const waiting = pend.filter((e) => e.pool);
  return {
    drops_left: Math.max(0, slots(g).length - g.fired) + pend.filter((e) => e.retry_at).length,
    triggered: waiting.map((e) => ({ at: e.at, players: e.pool.length, ...(steamId ? { in_it: e.pool.includes(steamId) } : {}) })),
  };
}
const winLabel = async (w) => prizeText(w.prize?.type ? w.prize : { type: w.reward_type, text: w.reward_text, amount: w.reward_amount, medal: w.reward_medal });

giveaways.get('/giveaways', member, async (req, res) => {
  const me = req.user;
  const [live, past, mine] = await Promise.all([
    q("SELECT * FROM giveaways WHERE status IN ('scheduled','open','drawing') ORDER BY start_at"),
    q("SELECT * FROM giveaways WHERE status='done' ORDER BY end_at DESC LIMIT 10"),
    q(`SELECT w.*, g.title, g.reward_type, g.reward_text, g.reward_amount, g.reward_medal, g.claim_days
         FROM giveaway_winners w JOIN giveaways g ON g.id = w.giveaway_id WHERE w.user_id=$1 ORDER BY w.won_at DESC LIMIT 20`, [me.id]),
  ]);
  const ids = live.map((g) => g.id);
  const [entries, counts] = await Promise.all([
    ids.length ? q('SELECT giveaway_id FROM giveaway_entries WHERE user_id=$1 AND giveaway_id = ANY($2)', [me.id, ids]) : [],
    ids.length ? q('SELECT giveaway_id, COUNT(*)::int AS n FROM giveaway_entries WHERE giveaway_id = ANY($1) GROUP BY giveaway_id', [ids]) : [],
  ]);
  const entered = new Set(entries.map((e) => e.giveaway_id));
  const count = new Map(counts.map((c) => [c.giveaway_id, c.n]));
  const winnersOf = past.length ? await q(
    `SELECT w.giveaway_id, w.prize, w.place, u.id, u.persona_name AS name FROM giveaway_winners w JOIN users u ON u.id = w.user_id
      WHERE w.giveaway_id = ANY($1) AND w.status <> 'expired' ORDER BY w.place NULLS LAST, w.won_at`, [past.map((g) => g.id)],
  ) : [];
  res.json({
    live: await Promise.all(live.map(async (g) => {
      const extra = { can_win: canWin(g, me), entered: entered.has(g.id), entrants: count.get(g.id) || 0 };
      if (g.kind === 'top' && g.status === 'open') {
        // Live standings: the prize places plus a few more, and your own place.
        const ranked = await standings(g);
        const n = slots(g).length;
        extra.standings = ranked.slice(0, n + 3).map((u, i) => ({ place: i + 1, id: u.id, name: u.persona_name, score: metricUnit(g.metric, u.score), prize: i < n }));
        const mineAt = ranked.findIndex((u) => u.id === me.id);
        extra.my_place = mineAt >= 0 ? { place: mineAt + 1, score: metricUnit(g.metric, ranked[mineAt].score) } : null;
      } else if (g.kind === 'scheduled') {
        extra.progress = (await progressFor(g, [me.id])).get(me.id) || { minutes: 0, matches: 0, kills: 0 };
      } else if (g.kind === 'drop') {
        Object.assign(extra, dropState(g, me.steam_id));
      }
      return publicGiveaway(g, extra);
    })),
    past: await Promise.all(past.map(async (g) => publicGiveaway(g, {
      winners_list: await Promise.all(winnersOf.filter((w) => w.giveaway_id === g.id).map(async (w) => ({ id: w.id, name: w.name, place: w.place, prize: await winLabel(w) }))),
    }))),
    // Your wins. A code is only shown once you've claimed the prize.
    mine: await Promise.all(mine.map(async (w) => ({
      id: w.id, giveaway_id: w.giveaway_id, title: w.title, prize: await winLabel(w), place: w.place, status: w.status, won_at: w.won_at,
      claim_by: new Date(new Date(w.won_at).getTime() + w.claim_days * 86400000).toISOString(),
      code: w.code && ['claimed', 'sent'].includes(w.status) ? await open(w.code).catch(() => '') : '',
      has_code: !!w.code,
    }))),
  });
});

// For HQ: anything live, and prizes waiting to be claimed.
giveaways.get('/giveaways/summary', member, async (req, res) => {
  const [live, unclaimed] = await Promise.all([
    one("SELECT COUNT(*)::int AS n FROM giveaways WHERE status IN ('open','drawing')"),
    one("SELECT COUNT(*)::int AS n FROM giveaway_winners WHERE user_id=$1 AND status='won'", [req.user.id]),
  ]);
  res.json({ live: live.n, unclaimed: unclaimed.n });
});

giveaways.post('/giveaways/:id/enter', member, async (req, res) => {
  const g = await one("SELECT * FROM giveaways WHERE id=$1 AND status IN ('scheduled','open') AND kind='scheduled' AND entry='enter'", [int(req.params.id)]);
  if (!g) throw new HttpError(404, 'That giveaway isn\'t taking entries.');
  if (!canWin(g, req.user)) throw new HttpError(403, g.who === 'members' ? 'This giveaway is for WPG members.' : 'You can\'t enter this one.');
  await q('INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g.id, req.user.id]);
  changed();
  res.json({ ok: true });
});
giveaways.delete('/giveaways/:id/enter', member, async (req, res) => {
  await q("DELETE FROM giveaway_entries e USING giveaways g WHERE g.id = e.giveaway_id AND e.giveaway_id=$1 AND e.user_id=$2 AND g.status IN ('scheduled','open')", [int(req.params.id), req.user.id]);
  changed();
  res.json({ ok: true });
});

giveaways.post('/giveaways/wins/:id/claim', member, async (req, res) => {
  const w = await one("UPDATE giveaway_winners SET status='claimed', claimed_at=now() WHERE id=$1 AND user_id=$2 AND status='won' RETURNING *", [int(req.params.id), req.user.id]);
  if (!w) throw new HttpError(400, 'Nothing to claim there (already claimed, or the time ran out).');
  const g = await one('SELECT * FROM giveaways WHERE id=$1', [w.giveaway_id]);
  bus.emit('staff:notify', { title: 'Giveaway prize claimed', body: `${req.user.persona_name} claimed ${await winLabel({ ...w, ...g, prize: w.prize })} (${g.title}). Mark it sent in Admin → Giveaways once it's with them.`, link: '#/admin/giveaways' });
  changed();
  res.json({ ok: true, code: w.code ? await open(w.code).catch(() => '') : '' });
});

// ---------- Admin ----------
// The prize list from the form. Codes typed for a prize replace its saved ones; untouched prizes keep theirs.
async function readPrizes(list, old = []) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Add at least one prize.');
  const wpgOk = await appIsSource();
  const out = [];
  for (const [i, p] of list.slice(0, 20).entries()) {
    const type = PRIZE_TYPES.includes(p.type) ? p.type : 'item';
    const prize = { type, text: '', amount: 0, medal: null, count: Math.max(1, Math.min(MAX_SLOTS, int(p.count, 1))), codes: [] };
    if (type === 'item') {
      prize.text = str(p.text, 200);
      if (!prize.text) throw new HttpError(400, `Prize ${i + 1}: say what it is.`);
      const typed = String(p.codes || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      prize.codes = typed.length ? await Promise.all(typed.slice(0, prize.count).map((c) => seal(c.slice(0, 300)))) : (old[i]?.type === 'item' && old[i]?.text === prize.text ? old[i].codes || [] : []);
    } else if (type === 'medal') {
      prize.medal = int(p.medal) || null;
      if (!prize.medal || !(await one('SELECT id FROM awards WHERE id=$1', [prize.medal]))) throw new HttpError(400, `Prize ${i + 1}: pick a medal.`);
    } else {
      prize.amount = Math.max(0, Math.min(1000000, int(p.amount)));
      if (!prize.amount) throw new HttpError(400, `Prize ${i + 1}: how much XP?`);
      if (type === 'wpg_xp' && !wpgOk) throw new HttpError(400, 'WPG XP prizes work once WPG XP is switched over to the app (Admin → WPG XP). Use Clan XP for now.');
    }
    out.push(prize);
  }
  if (out.reduce((n, p) => n + p.count, 0) > MAX_SLOTS) throw new HttpError(400, `That's more than ${MAX_SLOTS} winners in total.`);
  return out;
}

function readBody(b, existing) {
  const kind = existing?.kind || (KINDS.includes(b.kind) ? b.kind : 'scheduled');
  const g = {
    kind,
    title: str(b.title, 100),
    description: str(b.description, 1500),
    image: safeUrl(b.image),
    metric: kind === 'top' ? (METRICS[b.metric] ? b.metric : 'kills') : '',
    // Giveaways run for a number of matches: start_at = don't start before; end_at only caps how long it can wait.
    start_at: kind === 'scheduled' && !b.start_at ? new Date() : new Date(b.start_at),
    end_at: kind === 'scheduled' ? new Date(new Date(b.start_at || Date.now()).getTime() + 60 * 86400000) : new Date(b.end_at),
    matches: kind === 'scheduled' ? Math.max(1, Math.min(20, int(b.matches, 1))) : 1,
    who: b.who === 'everyone' ? 'everyone' : 'members',
    no_staff: bool(b.no_staff),
    entry: b.entry === 'auto' ? 'auto' : 'enter',
    min_minutes: kind === 'scheduled' ? Math.max(0, int(b.min_minutes)) : 0,
    min_matches: kind === 'scheduled' ? Math.max(0, int(b.min_matches)) : 0,
    min_kills: kind === 'scheduled' ? Math.max(0, int(b.min_kills)) : 0,
    claim_days: Math.max(1, Math.min(60, int(b.claim_days, 7))),
    in_game: b.in_game === undefined ? true : bool(b.in_game),
    drop_mode: kind === 'drop' && b.drop_mode === 'manual' ? 'manual' : 'random',
    drop_to: kind === 'drop' && b.drop_to === 'all' ? 'all' : 'one',
    // Drops: minutes played in the match the drop is decided in.
    drop_min_minutes: kind === 'drop' ? Math.max(0, Math.min(180, int(b.drop_min_minutes))) : 0,
    live_draw: kind === 'scheduled',
  };
  if (!g.title) throw new HttpError(400, 'Give it a title.');
  if (Number.isNaN(g.start_at.getTime()) || Number.isNaN(g.end_at.getTime())) throw new HttpError(400, 'Pick a start and an end time.');
  if (g.end_at <= g.start_at) throw new HttpError(400, 'The end has to be after the start.');
  if (g.end_at <= new Date()) throw new HttpError(400, 'The end time has already passed.');
  return g;
}

const COLS = ['kind', 'title', 'description', 'image', 'metric', 'start_at', 'end_at', 'who', 'no_staff', 'entry',
  'min_minutes', 'min_matches', 'min_kills', 'claim_days', 'in_game', 'prizes', 'winners', 'reward_type',
  'drop_mode', 'drop_to', 'drop_min_minutes', 'live_draw', 'matches'];
const rowValues = (g) => COLS.map((c) => (c === 'prizes' ? JSON.stringify(g.prizes) : g[c]));

giveaways.get('/admin/giveaways', role('admin'), async (_req, res) => {
  const list = await q('SELECT * FROM giveaways ORDER BY (status IN (\'scheduled\',\'open\',\'drawing\')) DESC, start_at DESC LIMIT 100');
  const ids = list.map((g) => g.id);
  const [winners, entries] = await Promise.all([
    ids.length ? q(`SELECT w.id, w.giveaway_id, w.status, w.won_at, w.prize, w.place, u.id AS user_id, u.persona_name AS name
                      FROM giveaway_winners w JOIN users u ON u.id = w.user_id WHERE w.giveaway_id = ANY($1) ORDER BY w.place NULLS LAST, w.won_at`, [ids]) : [],
    ids.length ? q('SELECT giveaway_id, COUNT(*)::int AS n FROM giveaway_entries WHERE giveaway_id = ANY($1) GROUP BY giveaway_id', [ids]) : [],
  ]);
  const count = new Map(entries.map((e) => [e.giveaway_id, e.n]));
  res.json({
    wpg_xp_ok: await appIsSource(),
    servers: (await wpgServers()).map((s) => s.name || s.join_code),
    metrics: METRICS,
    channel: String((await setting('discord_giveaway_channel')) || ''),
    posting: String(await setting('discord_post_giveaways')) === 'true',
    list: await Promise.all(list.map(async (g) => {
      const { reward_codes: _c, fire_times: _t, prizes: _p, pending: _w, ...rest } = g;
      return {
        ...rest,
        prizes: await prizeList(g),
        metric_label: METRICS[g.metric] || '',
        ...(g.kind === 'drop' ? dropState(g) : {}),
        entrants: count.get(g.id) || 0,
        winners_list: await Promise.all(winners.filter((w) => w.giveaway_id === g.id).map(async (w) => ({ ...w, prize_type: w.prize?.type || g.reward_type, prize: await winLabel({ ...g, prize: w.prize }) }))),
      };
    })),
  });
});

giveaways.post('/admin/giveaways', role('admin'), async (req, res) => {
  const g = readBody(req.body || {});
  g.prizes = await readPrizes(req.body?.prizes);
  g.winners = g.prizes.reduce((n, p) => n + p.count, 0);
  g.reward_type = g.prizes[0].type;
  const times = g.kind === 'drop' && g.drop_mode === 'random' ? dropTimes(g.start_at, g.end_at, g.winners) : [];
  const row = await one(
    `INSERT INTO giveaways (${COLS.join(', ')}, fire_times, created_by)
     VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}, $${COLS.length + 1}, $${COLS.length + 2}) RETURNING id, title`,
    [...rowValues(g), JSON.stringify(times), req.user.id],
  );
  await audit(req.user.id, 'giveaway.create', `${row.title} (#${row.id})`, { kind: g.kind, prizes: g.prizes.length, winners: g.winners });
  changed();
  res.json({ ok: true, id: row.id });
});

giveaways.put('/admin/giveaways/:id', role('admin'), async (req, res) => {
  const old = await one("SELECT * FROM giveaways WHERE id=$1 AND status IN ('scheduled','open')", [int(req.params.id)]);
  if (!old) throw new HttpError(400, 'Only giveaways that haven\'t finished can be changed.');
  const g = readBody(req.body || {}, old);
  if (old.kind === 'scheduled' && old.status === 'open') {
    g.matches = Math.max(g.matches, old.matches_done + 1);
    g.start_at = old.start_at; // already started
  }
  g.prizes = await readPrizes(req.body?.prizes, prizesOf(old));
  g.winners = g.prizes.reduce((n, p) => n + p.count, 0);
  g.reward_type = g.prizes[0].type;
  // Random drops get fresh secret times for the ones still to come if the window, number or timing changed.
  let times = old.fire_times || [];
  if (old.kind === 'drop' && g.drop_mode === 'manual') times = times.slice(0, old.fired);
  else if (old.kind === 'drop' && (old.drop_mode !== g.drop_mode || +new Date(old.start_at) !== +g.start_at || +new Date(old.end_at) !== +g.end_at || old.winners !== g.winners)) {
    times = [...times.slice(0, old.fired), ...dropTimes(g.start_at, g.end_at, Math.max(0, g.winners - old.fired))];
  }
  await q(
    `UPDATE giveaways SET ${COLS.map((c, i) => `${c}=$${i + 2}`).join(', ')}, fire_times=$${COLS.length + 2} WHERE id=$1`,
    [old.id, ...rowValues(g), JSON.stringify(times)],
  );
  await audit(req.user.id, 'giveaway.edit', `${g.title} (#${old.id})`);
  changed();
  res.json({ ok: true });
});

giveaways.post('/admin/giveaways/:id/cancel', role('admin'), async (req, res) => {
  const g = await one("UPDATE giveaways SET status='cancelled', pending='[]' WHERE id=$1 AND status IN ('scheduled','open','drawing') RETURNING *", [int(req.params.id)]);
  if (!g) throw new HttpError(400, 'Only giveaways that haven\'t finished can be cancelled.');
  await audit(req.user.id, 'giveaway.cancel', `${g.title} (#${g.id})`);
  changed();
  res.json({ ok: true });
});

giveaways.delete('/admin/giveaways/:id', role('admin'), async (req, res) => {
  const g = await one('DELETE FROM giveaways WHERE id=$1 RETURNING *', [int(req.params.id)]);
  if (g) await audit(req.user.id, 'giveaway.delete', `${g.title} (#${g.id})`);
  changed();
  res.json({ ok: true });
});

// Drops: trigger the next drop now (handed out when the match ends). Giveaway: end it, drawing at the end of the
// match running now (or, if it's already waiting, right now from whoever is on). Top players: hand out now.
giveaways.post('/admin/giveaways/:id/draw', role('admin'), async (req, res) => {
  const g = await one("SELECT * FROM giveaways WHERE id=$1 AND status IN ('open','drawing')", [int(req.params.id)]);
  if (!g) throw new HttpError(400, 'Only a running giveaway can be drawn (a giveaway starts with the next match on the WPG server).');
  if (g.kind === 'drop') {
    const r = await triggerDrop(g.id);
    if (r.none) throw new HttpError(400, 'All the drops in this one have been used.');
    if (r.nobody) throw new HttpError(400, 'Nobody who can win is on the WPG server right now.');
    await audit(req.user.id, 'giveaway.trigger', `${g.title} (#${g.id})`, { players: r.players });
    return res.json({ ok: true, winners: [], note: `Drop triggered: ${r.players} player${r.players === 1 ? '' : 's'} on the server ${r.players === 1 ? 'is' : 'are'} in it. It's handed out when this match ends.` });
  }
  if (g.kind === 'scheduled' && g.status === 'open') {
    await q("UPDATE giveaways SET matches = matches_done + 1 WHERE id=$1 AND status='open'", [g.id]);
    await sayInGame(g, `WPG GIVEAWAY "${g.title}": this is now the LAST MATCH. Be on the server at the end of it to be in the draw!`);
    changed();
    return res.json({ ok: true, winners: [], note: 'This is now the last match: the draw happens when it ends, among those on the server for it.' });
  }
  const won = g.kind === 'top' ? await drawTop(g, req.user.id) : await drawScheduled(g, req.user.id, await onNowAsPlayed());
  res.json({ ok: true, winners: won.map((w) => `${w.user.persona_name} (${w.prize})`), note: won.length ? '' : 'Nobody qualified, so there was no winner.' });
});

// A winner didn't claim (or can't be reached): someone else gets that prize (and its code).
// Giveaways: a new random draw. Drops: someone on the server now. Top players: the next player down.
giveaways.post('/admin/giveaways/winners/:id/redraw', role('admin'), async (req, res) => {
  const w = await one("UPDATE giveaway_winners SET status='expired' WHERE id=$1 AND status IN ('won','expired') RETURNING *", [int(req.params.id)]);
  if (!w) throw new HttpError(400, 'Only unclaimed prizes can be drawn again.');
  const g = await one('SELECT * FROM giveaways WHERE id=$1', [w.giveaway_id]);
  const taken = new Set((await q('SELECT user_id FROM giveaway_winners WHERE giveaway_id=$1', [g.id])).map((r) => r.user_id));
  let u;
  if (g.kind === 'top') u = (await standings(g)).find((x) => !taken.has(x.id));
  else {
    const pool = g.kind === 'drop'
      ? (await q('SELECT * FROM users WHERE steam_id = ANY($1)', [[...(await onServerNow()).keys()]])).filter((x) => canWin(g, x))
      : await candidates(g);
    [u] = pick(pool.filter((x) => !taken.has(x.id)), 1);
  }
  if (!u) {
    await q("UPDATE giveaway_winners SET status='won' WHERE id=$1 AND status='expired' AND won_at > now() - make_interval(days => $2)", [w.id, g.claim_days]);
    throw new HttpError(400, g.kind === 'drop' ? 'Nobody who can win is on the WPG server right now.' : 'There\'s nobody else who qualifies.');
  }
  // Same prize slot as the one being handed on.
  const index = slots(g).findIndex((pi) => pi === w.prize_index);
  const won = await giveReward(g, u, Math.max(0, index), { place: w.place, score: g.kind === 'top' ? u.score : null, code: w.code });
  await q("UPDATE giveaway_winners SET code='' WHERE id=$1", [w.id]);
  await audit(req.user.id, 'giveaway.redraw', `${g.title} (#${g.id})`, { new_winner: u.persona_name });
  await announceWinners(g, [won]);
  changed();
  res.json({ ok: true, winner: u.persona_name });
});

giveaways.post('/admin/giveaways/winners/:id/sent', role('admin'), async (req, res) => {
  const w = await one("UPDATE giveaway_winners SET status='sent', sent_at=now() WHERE id=$1 AND status IN ('won','claimed') RETURNING *", [int(req.params.id)]);
  if (!w) throw new HttpError(400, 'That prize isn\'t waiting to be sent.');
  const g = await one('SELECT title FROM giveaways WHERE id=$1', [w.giveaway_id]);
  bus.emit('notify', w.user_id, { title: '🎁 Prize on its way', body: `Staff have sent your prize for "${g?.title || 'the giveaway'}".`, link: '#/giveaways' });
  await audit(req.user.id, 'giveaway.sent', `winner #${w.id}`);
  changed();
  res.json({ ok: true });
});

// The giveaways' own Discord channel and on/off switch (kept with the giveaways, not in Settings).
giveaways.put('/admin/giveaways-discord', role('admin'), async (req, res) => {
  const channel = str(req.body?.channel, 30).replace(/\D/g, '');
  if (channel && !/^\d{15,22}$/.test(channel)) throw new HttpError(400, 'That doesn\'t look like a Discord channel ID (a long number: right-click the channel → Copy Channel ID).');
  for (const [k, v] of [['discord_giveaway_channel', channel], ['discord_post_giveaways', String(bool(req.body?.posting))]]) {
    await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
  }
  clearSettingsCache();
  await audit(req.user.id, 'giveaway.discord', channel || '(main posts channel)');
  res.json({ ok: true });
});
