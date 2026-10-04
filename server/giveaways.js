// Giveaways, linked to the WPG server.
//  - Giveaway: runs from start to end. Members press Enter (or everyone who plays is entered), optionally
//    with things to do on the WPG server during it (minutes played, matches, kills). Winners are drawn at
//    random when it ends.
//  - Random drops: between start and end the app picks secret random times; at each one, a random person
//    who is on the WPG server right then wins. Nobody on? It tries again 10 minutes later.
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

// Steam IDs on a WPG XP server right now.
async function onServerNow() {
  const rows = await q('SELECT ts.state FROM server_track_state ts JOIN game_servers g ON g.id = ts.server_id WHERE g.wpg_xp = true');
  const ids = new Set();
  for (const r of rows) {
    for (const [sid, p] of Object.entries(r.state?.players || {})) if (Date.now() - (p.seen || 0) <= ONLINE_MS) ids.add(sid);
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
async function progressFor(g, userIds) {
  if (!userIds.length) return new Map();
  const rows = await q(
    `SELECT u.id AS user_id, COALESCE(SUM(mp.seconds), 0)::int AS secs, COUNT(mp.id)::int AS matches, COALESCE(SUM(mp.kills), 0)::int AS kills
       FROM users u JOIN match_players mp ON mp.steam_id = u.steam_id
       JOIN game_servers s ON s.id = mp.server_id AND s.wpg_xp = true
      WHERE u.id = ANY($1) AND mp.ended_at >= $2 AND mp.ended_at <= LEAST($3::timestamptz, now())
      GROUP BY u.id`,
    [userIds, g.start_at, g.end_at],
  );
  return new Map(rows.map((r) => [r.user_id, { minutes: Math.floor(r.secs / 60), matches: r.matches, kills: r.kills }]));
}
const hasRules = (g) => g.min_minutes > 0 || g.min_matches > 0 || g.min_kills > 0;
const meets = (g, p) => (p?.minutes || 0) >= g.min_minutes && (p?.matches || 0) >= g.min_matches && (p?.kills || 0) >= g.min_kills;

// Everyone who could win a giveaway draw now (not counting people who've already won it).
async function candidates(g) {
  const already = new Set((await q('SELECT user_id FROM giveaway_winners WHERE giveaway_id=$1', [g.id])).map((r) => r.user_id));
  const users = g.entry === 'enter'
    ? await q('SELECT u.* FROM giveaway_entries e JOIN users u ON u.id = e.user_id WHERE e.giveaway_id=$1', [g.id])
    // Automatic entry: everyone who played on the WPG server during the giveaway.
    : await q(
      `SELECT DISTINCT u.* FROM users u JOIN match_players mp ON mp.steam_id = u.steam_id
         JOIN game_servers s ON s.id = mp.server_id AND s.wpg_xp = true
        WHERE mp.ended_at >= $1 AND mp.ended_at <= LEAST($2::timestamptz, now())`,
      [g.start_at, g.end_at],
    );
  const ok = users.filter((u) => canWin(g, u) && !already.has(u.id));
  if (!hasRules(g)) return ok;
  const prog = await progressFor(g, ok.map((u) => u.id));
  return ok.filter((u) => meets(g, prog.get(u.id)));
}

// Top players: everyone who can win, best first, with their score (above 0). Equal scores are put in random order.
async function standings(g) {
  const win = [g.start_at, g.end_at];
  const fromMatches = (expr) => q(
    `SELECT u.*, ${expr}::int AS score FROM users u JOIN match_players mp ON mp.steam_id = u.steam_id
       JOIN game_servers s ON s.id = mp.server_id AND s.wpg_xp = true
      WHERE mp.ended_at >= $1 AND mp.ended_at <= LEAST($2::timestamptz, now()) GROUP BY u.id`, win,
  );
  let rows;
  if (g.metric === 'kills') rows = await fromMatches('SUM(mp.kills)');
  else if (g.metric === 'minutes') rows = await fromMatches('FLOOR(SUM(mp.seconds) / 60)');
  else if (g.metric === 'matches') rows = await fromMatches('COUNT(mp.id)');
  else if (g.metric === 'wins') rows = await fromMatches('SUM(CASE WHEN mp.won THEN 1 ELSE 0 END)');
  else if (g.metric === 'wpg_xp') {
    rows = await q(
      `SELECT u.*, SUM(l.xp)::int AS score FROM users u JOIN wpg_xp_log l ON l.steam_id = u.steam_id
        WHERE l.server_id IS NOT NULL AND l.created_at >= $1 AND l.created_at <= LEAST($2::timestamptz, now()) GROUP BY u.id`, win,
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
    await rcon(s, 'POST', '/broadcast', { message: text.slice(0, 300) }).catch(() => {});
    for (const [steamId, msg] of whisper || []) {
      await rcon(s, 'POST', `/players/${steamId}/message`, { message: msg.slice(0, 300) }).catch(() => {});
    }
  }
}

async function announceWinners(g, won) {
  if (!won.length) return;
  const online = await onServerNow();
  const line = g.kind === 'top'
    ? `WPG TOP PLAYERS (${METRICS[g.metric] || 'results'}): ${won.slice(0, 5).map((w) => `${ordinal(w.place)} ${w.user.persona_name}`).join(', ')}${won.length > 5 ? '…' : ''}. GG!`
    : `WPG GIVEAWAY: ${won.map((w) => `${w.user.persona_name} won ${w.prize}`).join(', ')}! GG`;
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

async function drawScheduled(g, actor = null) {
  // Only one copy of the app may draw (during a deploy two can briefly run).
  const locked = await one("UPDATE giveaways SET status='done' WHERE id=$1 AND status='open' RETURNING *", [g.id]);
  if (!locked) return [];
  const pool = await candidates(locked);
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

// One random drop that's due: a random eligible person on the WPG server right now wins.
async function fireDrop(g) {
  const times = Array.isArray(g.fire_times) ? g.fire_times : [];
  const online = await onServerNow();
  const already = new Set((await q('SELECT user_id FROM giveaway_winners WHERE giveaway_id=$1', [g.id])).map((r) => r.user_id));
  const users = online.size ? await q('SELECT * FROM users WHERE steam_id = ANY($1)', [[...online]]) : [];
  const pool = users.filter((u) => canWin(g, u) && !already.has(u.id));
  if (!pool.length) {
    // Nobody to win right now: try again in 10 minutes, unless the window has closed.
    const retry = Date.now() + RETRY_MS;
    if (retry < new Date(g.end_at).getTime()) {
      const next = [...times];
      next[g.fired] = new Date(retry).toISOString();
      await q('UPDATE giveaways SET fire_times=$2 WHERE id=$1 AND fired=$3', [g.id, JSON.stringify(next), g.fired]);
    } else {
      await q("UPDATE giveaways SET fired = fired + 1, status = CASE WHEN fired + 1 >= $2 THEN 'done' ELSE status END WHERE id=$1 AND fired=$3", [g.id, times.length, g.fired]);
      changed();
    }
    return null;
  }
  const locked = await one(
    "UPDATE giveaways SET fired = fired + 1, status = CASE WHEN fired + 1 >= $2 THEN 'done' ELSE status END WHERE id=$1 AND fired=$3 RETURNING *",
    [g.id, times.length, g.fired],
  );
  if (!locked) return null;
  const [u] = pick(pool, 1);
  const w = await giveReward(locked, u, g.fired);
  await audit(null, 'giveaway.drop', `${g.title} (#${g.id})`, { on_server: pool.length, winner: `${u.persona_name}: ${w.prize}` });
  await announceWinners(locked, [w]);
  changed();
  return w;
}

// Random times for drops, spread over the window (from now if it has already started).
function dropTimes(start, end, n) {
  if (n <= 0) return [];
  const from = Math.max(new Date(start).getTime(), Date.now() + 60 * 1000);
  const to = new Date(end).getTime() - 5 * 60 * 1000;
  if (to <= from) throw new HttpError(400, 'The drop window is too short: make it end at least 10 minutes from now.');
  return Array.from({ length: n }, () => from + crypto.randomInt(Math.max(1, to - from))).sort((a, b) => a - b).map((t) => new Date(t).toISOString());
}

// ---------- The clock ----------
async function tick() {
  // Starting.
  for (const g of await q("UPDATE giveaways SET status='open' WHERE status='scheduled' AND start_at <= now() RETURNING *")) {
    const prizes = await prizeSummary(g);
    await sayInGame(g, g.kind === 'drop'
      ? `WPG RANDOM DROPS are live: stay on the server for a chance to win! (${prizes})`
      : g.kind === 'top'
        ? `WPG TOP PLAYERS is on: ${METRICS[g.metric] || ''} on this server wins prizes. Open WPG Barracks > Giveaways.`
        : `WPG GIVEAWAY started: ${g.title}. Open WPG Barracks > Giveaways to take part.`);
    bus.emit('announce', {
      type: 'giveaway', event: 'start', id: g.id, kind: g.kind, title: g.title, image: g.image, description: g.description,
      end_at: g.end_at, entry: g.entry, metric: METRICS[g.metric] || '', prizes: await prizeList(g),
    });
    changed();
  }
  // Ending (giveaways, top players) and dropping (drops).
  for (const g of await q("SELECT * FROM giveaways WHERE status='open' AND kind='scheduled' AND end_at <= now()")) await drawScheduled(g);
  for (const g of await q("SELECT * FROM giveaways WHERE status='open' AND kind='top' AND end_at <= now()")) await drawTop(g);
  for (const g of await q("SELECT * FROM giveaways WHERE status='open' AND kind='drop'")) {
    const times = Array.isArray(g.fire_times) ? g.fire_times : [];
    if (g.fired >= times.length) {
      await q("UPDATE giveaways SET status='done' WHERE id=$1 AND status='open'", [g.id]);
      changed();
    } else if (new Date(times[g.fired]).getTime() <= Date.now()) {
      await fireDrop(g);
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
  const times = Array.isArray(g.fire_times) ? g.fire_times : [];
  return {
    id: g.id, kind: g.kind, title: g.title, description: g.description, image: g.image,
    prizes: (await prizeList(g)).map(({ codes, ...p }) => p), metric: g.metric, metric_label: METRICS[g.metric] || '',
    start_at: g.start_at, end_at: g.end_at, who: g.who, no_staff: g.no_staff, entry: g.entry,
    min_minutes: g.min_minutes, min_matches: g.min_matches, min_kills: g.min_kills, claim_days: g.claim_days, status: g.status,
    // Drops: how many are left, never when.
    ...(g.kind === 'drop' ? { drops_left: Math.max(0, times.length - g.fired) } : {}),
    ...extra,
  };
}
const winLabel = async (w) => prizeText(w.prize?.type ? w.prize : { type: w.reward_type, text: w.reward_text, amount: w.reward_amount, medal: w.reward_medal });

giveaways.get('/giveaways', member, async (req, res) => {
  const me = req.user;
  const [live, past, mine] = await Promise.all([
    q("SELECT * FROM giveaways WHERE status IN ('scheduled','open') ORDER BY start_at"),
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
    one("SELECT COUNT(*)::int AS n FROM giveaways WHERE status='open'"),
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
    start_at: new Date(b.start_at),
    end_at: new Date(b.end_at),
    who: b.who === 'everyone' ? 'everyone' : 'members',
    no_staff: bool(b.no_staff),
    entry: b.entry === 'auto' ? 'auto' : 'enter',
    min_minutes: kind === 'scheduled' ? Math.max(0, int(b.min_minutes)) : 0,
    min_matches: kind === 'scheduled' ? Math.max(0, int(b.min_matches)) : 0,
    min_kills: kind === 'scheduled' ? Math.max(0, int(b.min_kills)) : 0,
    claim_days: Math.max(1, Math.min(60, int(b.claim_days, 7))),
    in_game: b.in_game === undefined ? true : bool(b.in_game),
  };
  if (!g.title) throw new HttpError(400, 'Give it a title.');
  if (Number.isNaN(g.start_at.getTime()) || Number.isNaN(g.end_at.getTime())) throw new HttpError(400, 'Pick a start and an end time.');
  if (g.end_at <= g.start_at) throw new HttpError(400, 'The end has to be after the start.');
  if (g.end_at <= new Date()) throw new HttpError(400, 'The end time has already passed.');
  return g;
}

const COLS = ['kind', 'title', 'description', 'image', 'metric', 'start_at', 'end_at', 'who', 'no_staff', 'entry',
  'min_minutes', 'min_matches', 'min_kills', 'claim_days', 'in_game', 'prizes', 'winners', 'reward_type'];
const rowValues = (g) => COLS.map((c) => (c === 'prizes' ? JSON.stringify(g.prizes) : g[c]));

giveaways.get('/admin/giveaways', role('admin'), async (_req, res) => {
  const list = await q('SELECT * FROM giveaways ORDER BY (status IN (\'scheduled\',\'open\')) DESC, start_at DESC LIMIT 100');
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
      const { reward_codes: _c, fire_times: times, prizes: _p, ...rest } = g;
      return {
        ...rest,
        prizes: await prizeList(g),
        metric_label: METRICS[g.metric] || '',
        drops_left: g.kind === 'drop' ? Math.max(0, (times || []).length - g.fired) : null,
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
  const times = g.kind === 'drop' ? dropTimes(g.start_at, g.end_at, g.winners) : [];
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
  g.prizes = await readPrizes(req.body?.prizes, prizesOf(old));
  g.winners = g.prizes.reduce((n, p) => n + p.count, 0);
  g.reward_type = g.prizes[0].type;
  // Drops get fresh random times for the ones still to come if the window or number changed.
  let times = old.fire_times || [];
  if (old.kind === 'drop' && (+new Date(old.start_at) !== +g.start_at || +new Date(old.end_at) !== +g.end_at || old.winners !== g.winners)) {
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
  const g = await one("UPDATE giveaways SET status='cancelled' WHERE id=$1 AND status IN ('scheduled','open') RETURNING *", [int(req.params.id)]);
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

// Giveaway / top players: end it and hand out the prizes now. Drops: do the next drop now.
giveaways.post('/admin/giveaways/:id/draw', role('admin'), async (req, res) => {
  const g = await one("SELECT * FROM giveaways WHERE id=$1 AND status='open'", [int(req.params.id)]);
  if (!g) throw new HttpError(400, 'Only a running giveaway can be drawn.');
  if (g.kind === 'drop') {
    const w = await fireDrop(g);
    return res.json({ ok: true, winners: w ? [`${w.user.persona_name} (${w.prize})`] : [], note: w ? '' : 'Nobody who can win is on the WPG server right now, so this drop will try again in 10 minutes.' });
  }
  const won = g.kind === 'top' ? await drawTop(g, req.user.id) : await drawScheduled(g, req.user.id);
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
      ? (await q('SELECT * FROM users WHERE steam_id = ANY($1)', [[...(await onServerNow())]])).filter((x) => canWin(g, x))
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
