// Giveaways, linked to the WPG server.
//  - Scheduled: runs from start to end. Members press Enter (or everyone who plays is entered), optionally
//    with things to do on the WPG server during it (minutes played, matches, kills). Winners are drawn at
//    random when it ends.
//  - Random drops: between start and end the app picks secret random times; at each one, a random person
//    who is on the WPG server right then wins. Nobody on? It tries again 10 minutes later.
// Prizes: something real (staff hand it over; an optional code per winner is shown only to them once they
// claim it), Clan XP, WPG XP or a medal (those three are given straight away).
// Winners hear about it in the app, on Discord and in-game (if they're on the server).
import express from 'express';
import crypto from 'crypto';
import { q, one, audit } from './db.js';
import { bus } from './bus.js';
import { HttpError, member, role, roleAtLeast, str, int, bool, safeUrl } from './util.js';
import { seal, open } from './secretbox.js';
import { rcon } from './servers.js';
import { recalcXp } from './steam.js';
import { grantWpgXp, appIsSource } from './wpgxp.js';

export const giveaways = express.Router();

const ONLINE_MS = 2 * 60 * 1000; // seen on the server this recently = on it now
const RETRY_MS = 10 * 60 * 1000; // a drop with nobody on the server tries again this much later
const KINDS = ['scheduled', 'drop'];
const REWARDS = ['item', 'clan_xp', 'wpg_xp', 'medal'];
const isStaff = (u) => roleAtLeast(u?.role, 'mod');
const changed = () => bus.emit('config:changed', 'giveaways');

// Fair random pick of n from a list (crypto-strength shuffle).
function pick(list, n) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

async function medalName(id) {
  return id ? (await one('SELECT name FROM awards WHERE id=$1', [id]))?.name || 'a medal' : 'a medal';
}
export async function prizeLabel(g) {
  if (g.reward_type === 'clan_xp') return `${Number(g.reward_amount).toLocaleString('en-GB')} Clan XP`;
  if (g.reward_type === 'wpg_xp') return `${Number(g.reward_amount).toLocaleString('en-GB')} WPG XP`;
  if (g.reward_type === 'medal') return `the ${await medalName(g.reward_medal)} medal`;
  return g.reward_text || 'a prize';
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

// Everyone who could win a scheduled giveaway now (not counting people who've already won it).
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

// ---------- Handing prizes over ----------
async function giveReward(g, u, code) {
  const reason = `Giveaway: ${g.title}`;
  let status = 'won';
  try {
    if (g.reward_type === 'clan_xp') {
      await q('UPDATE users SET bonus_xp = bonus_xp + $2 WHERE id=$1', [u.id, g.reward_amount]);
      await recalcXp(u.id);
      status = 'given';
    } else if (g.reward_type === 'wpg_xp') {
      await grantWpgXp(u.steam_id, u.persona_name, g.reward_amount, reason);
      status = 'given';
    } else if (g.reward_type === 'medal' && g.reward_medal) {
      await q('INSERT INTO user_awards (user_id, award_id, given_by, reason) VALUES ($1,$2,NULL,$3)', [u.id, g.reward_medal, reason]);
      bus.emit('announce', { type: 'medals', userId: u.id, names: [await medalName(g.reward_medal)] });
      status = 'given';
    }
  } catch (e) {
    // Couldn't hand it over automatically (e.g. WPG XP while the Discord bot is in charge): staff sort it out.
    console.warn('[giveaways] prize not given automatically', e.message);
    bus.emit('staff:notify', { title: 'Giveaway prize needs handing over', body: `${u.persona_name} won ${await prizeLabel(g)} but it couldn't be given automatically: ${e.message}`, link: '#/admin/giveaways' });
  }
  await q('INSERT INTO giveaway_winners (giveaway_id, user_id, code, status) VALUES ($1,$2,$3,$4)', [g.id, u.id, code || '', status]);
  const prize = await prizeLabel(g);
  bus.emit('notify', u.id, {
    title: '🎁 You won a giveaway!',
    body: status === 'given' ? `${g.title}: ${prize} is yours.` : `${g.title}: you won ${prize}. Open Giveaways to claim it within ${g.claim_days} days.`,
    link: '#/giveaways',
  });
  bus.emit('user:changed', u.id);
  return { user: u, status };
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
  const prize = await prizeLabel(g);
  const names = won.map((w) => w.user.persona_name);
  const online = await onServerNow();
  await sayInGame(g, `WPG GIVEAWAY: ${names.join(', ')} won ${prize}! GG`,
    won.filter((w) => online.has(w.user.steam_id)).map((w) => [w.user.steam_id, `You won ${prize}! ${w.status === 'given' ? 'It is yours already.' : 'Open WPG Barracks > Giveaways to claim it.'}`]));
  bus.emit('announce', { type: 'giveaway', event: 'winners', id: g.id, kind: g.kind, title: g.title, prize, image: g.image, userIds: won.map((w) => w.user.id) });
}

// The next unused code for this giveaway (codes go to winners in order).
async function nextCode(g) {
  const used = (await one('SELECT COUNT(*)::int AS n FROM giveaway_winners WHERE giveaway_id=$1', [g.id])).n;
  return (g.reward_codes || [])[used] || '';
}

// ---------- Draws ----------
async function drawScheduled(g, actor = null) {
  // Only one copy of the app may draw (during a deploy two can briefly run).
  const locked = await one("UPDATE giveaways SET status='done' WHERE id=$1 AND status='open' RETURNING *", [g.id]);
  if (!locked) return [];
  const pool = await candidates(locked);
  const won = [];
  for (const u of pick(pool, locked.winners)) won.push(await giveReward(locked, u, await nextCode(locked)));
  await audit(actor, 'giveaway.draw', `${locked.title} (#${locked.id})`, { entrants: pool.length, winners: won.map((w) => w.user.persona_name) });
  await announceWinners(locked, won);
  if (!won.length) bus.emit('staff:notify', { title: 'Giveaway ended with no winner', body: `Nobody qualified for "${locked.title}".`, link: '#/admin/giveaways' });
  changed();
  return won;
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
  const w = await giveReward(locked, u, await nextCode(g));
  await audit(null, 'giveaway.drop', `${g.title} (#${g.id})`, { on_server: pool.length, winner: u.persona_name });
  await announceWinners(locked, [w]);
  changed();
  return w;
}

// Random times for drops, spread over the window (from now if it has already started).
function dropTimes(start, end, n) {
  const from = Math.max(new Date(start).getTime(), Date.now() + 60 * 1000);
  const to = new Date(end).getTime() - 5 * 60 * 1000;
  if (to <= from) throw new HttpError(400, 'The drop window is too short: make it end at least 10 minutes from now.');
  return Array.from({ length: n }, () => from + crypto.randomInt(Math.max(1, to - from))).sort((a, b) => a - b).map((t) => new Date(t).toISOString());
}

// ---------- The clock ----------
async function tick() {
  // Starting.
  for (const g of await q("UPDATE giveaways SET status='open' WHERE status='scheduled' AND start_at <= now() RETURNING *")) {
    const prize = await prizeLabel(g);
    await sayInGame(g, g.kind === 'drop'
      ? `WPG RANDOM DROPS are live: stay on the server for a chance to win ${prize}!`
      : `WPG GIVEAWAY started: ${g.title} (${prize}). Open WPG Barracks > Giveaways to take part.`);
    bus.emit('announce', { type: 'giveaway', event: 'start', id: g.id, kind: g.kind, title: g.title, prize, image: g.image, description: g.description, end_at: g.end_at, entry: g.entry });
    changed();
  }
  // Ending (scheduled) and dropping (drops).
  for (const g of await q("SELECT * FROM giveaways WHERE status='open' AND kind='scheduled' AND end_at <= now()")) await drawScheduled(g);
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

// ---------- What members see ----------
function publicGiveaway(g, prize, extra = {}) {
  const times = Array.isArray(g.fire_times) ? g.fire_times : [];
  return {
    id: g.id, kind: g.kind, title: g.title, description: g.description, image: g.image, prize, reward_type: g.reward_type,
    winners: g.winners, start_at: g.start_at, end_at: g.end_at, who: g.who, no_staff: g.no_staff, entry: g.entry,
    min_minutes: g.min_minutes, min_matches: g.min_matches, min_kills: g.min_kills, claim_days: g.claim_days, status: g.status,
    // Drops: how many are left, never when.
    ...(g.kind === 'drop' ? { drops_left: Math.max(0, times.length - g.fired) } : {}),
    ...extra,
  };
}

giveaways.get('/giveaways', member, async (req, res) => {
  const me = req.user;
  const [live, past, mine] = await Promise.all([
    q("SELECT * FROM giveaways WHERE status IN ('scheduled','open') ORDER BY start_at"),
    q("SELECT * FROM giveaways WHERE status='done' ORDER BY end_at DESC LIMIT 10"),
    q(`SELECT w.*, g.title, g.reward_type, g.reward_text, g.reward_amount, g.reward_medal, g.claim_days
         FROM giveaway_winners w JOIN giveaways g ON g.id = w.giveaway_id WHERE w.user_id=$1 ORDER BY w.won_at DESC LIMIT 20`, [me.id]),
  ]);
  const ids = live.map((g) => g.id);
  const [entries, counts, prog] = await Promise.all([
    ids.length ? q('SELECT giveaway_id FROM giveaway_entries WHERE user_id=$1 AND giveaway_id = ANY($2)', [me.id, ids]) : [],
    ids.length ? q('SELECT giveaway_id, COUNT(*)::int AS n FROM giveaway_entries WHERE giveaway_id = ANY($1) GROUP BY giveaway_id', [ids]) : [],
    Promise.all(live.map(async (g) => [g.id, (await progressFor(g, [me.id])).get(me.id) || { minutes: 0, matches: 0, kills: 0 }])),
  ]);
  const entered = new Set(entries.map((e) => e.giveaway_id));
  const count = new Map(counts.map((c) => [c.giveaway_id, c.n]));
  const progress = new Map(prog);
  const winnersOf = past.length ? await q(
    `SELECT w.giveaway_id, u.id, u.persona_name AS name FROM giveaway_winners w JOIN users u ON u.id = w.user_id
      WHERE w.giveaway_id = ANY($1) AND w.status <> 'expired' ORDER BY w.won_at`, [past.map((g) => g.id)],
  ) : [];
  res.json({
    live: await Promise.all(live.map(async (g) => publicGiveaway(g, await prizeLabel(g), {
      can_win: canWin(g, me), entered: entered.has(g.id), entrants: count.get(g.id) || 0, progress: progress.get(g.id),
    }))),
    past: await Promise.all(past.map(async (g) => publicGiveaway(g, await prizeLabel(g), {
      winners_list: winnersOf.filter((w) => w.giveaway_id === g.id).map((w) => ({ id: w.id, name: w.name })),
    }))),
    // Your wins. A code is only shown once you've claimed the prize.
    mine: await Promise.all(mine.map(async (w) => ({
      id: w.id, giveaway_id: w.giveaway_id, title: w.title, prize: await prizeLabel(w), status: w.status, won_at: w.won_at,
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
  bus.emit('staff:notify', { title: 'Giveaway prize claimed', body: `${req.user.persona_name} claimed ${await prizeLabel(g)} (${g.title}). Mark it sent in Admin → Giveaways once it's with them.`, link: '#/admin/giveaways' });
  changed();
  res.json({ ok: true, code: w.code ? await open(w.code).catch(() => '') : '' });
});

// ---------- Admin ----------
async function readBody(b, existing) {
  const kind = KINDS.includes(b.kind) ? b.kind : existing?.kind || 'scheduled';
  const reward = REWARDS.includes(b.reward_type) ? b.reward_type : 'item';
  const g = {
    kind,
    title: str(b.title, 100),
    description: str(b.description, 1500),
    image: safeUrl(b.image),
    reward_type: reward,
    reward_text: str(b.reward_text, 200),
    reward_amount: Math.max(0, Math.min(1000000, int(b.reward_amount))),
    reward_medal: int(b.reward_medal) || null,
    winners: Math.max(1, Math.min(50, int(b.winners, 1))),
    start_at: new Date(b.start_at),
    end_at: new Date(b.end_at),
    who: b.who === 'everyone' ? 'everyone' : 'members',
    no_staff: bool(b.no_staff),
    entry: b.entry === 'auto' ? 'auto' : 'enter',
    min_minutes: Math.max(0, int(b.min_minutes)),
    min_matches: Math.max(0, int(b.min_matches)),
    min_kills: Math.max(0, int(b.min_kills)),
    claim_days: Math.max(1, Math.min(60, int(b.claim_days, 7))),
    in_game: b.in_game === undefined ? true : bool(b.in_game),
  };
  if (!g.title) throw new HttpError(400, 'Give it a title.');
  if (Number.isNaN(g.start_at.getTime()) || Number.isNaN(g.end_at.getTime())) throw new HttpError(400, 'Pick a start and an end time.');
  if (g.end_at <= g.start_at) throw new HttpError(400, 'The end has to be after the start.');
  if (g.end_at <= new Date()) throw new HttpError(400, 'The end time has already passed.');
  if (reward === 'item' && !g.reward_text) throw new HttpError(400, 'Say what the prize is.');
  if ((reward === 'clan_xp' || reward === 'wpg_xp') && !g.reward_amount) throw new HttpError(400, 'How much XP?');
  if (reward === 'wpg_xp' && !(await appIsSource())) throw new HttpError(400, 'WPG XP prizes work once WPG XP is switched over to the app (Admin → WPG XP). Use Clan XP for now.');
  if (reward === 'medal' && !(g.reward_medal && (await one('SELECT id FROM awards WHERE id=$1', [g.reward_medal])))) throw new HttpError(400, 'Pick a medal.');
  if (reward !== 'medal') g.reward_medal = null;
  return g;
}

const COLS = ['kind', 'title', 'description', 'image', 'reward_type', 'reward_text', 'reward_amount', 'reward_medal', 'winners', 'start_at', 'end_at',
  'who', 'no_staff', 'entry', 'min_minutes', 'min_matches', 'min_kills', 'claim_days', 'in_game'];

giveaways.get('/admin/giveaways', role('admin'), async (_req, res) => {
  const list = await q('SELECT * FROM giveaways ORDER BY (status IN (\'scheduled\',\'open\')) DESC, start_at DESC LIMIT 100');
  const ids = list.map((g) => g.id);
  const [winners, entries] = await Promise.all([
    ids.length ? q(`SELECT w.id, w.giveaway_id, w.status, w.won_at, w.claimed_at, w.sent_at, u.id AS user_id, u.persona_name AS name
                      FROM giveaway_winners w JOIN users u ON u.id = w.user_id WHERE w.giveaway_id = ANY($1) ORDER BY w.won_at`, [ids]) : [],
    ids.length ? q('SELECT giveaway_id, COUNT(*)::int AS n FROM giveaway_entries WHERE giveaway_id = ANY($1) GROUP BY giveaway_id', [ids]) : [],
  ]);
  const count = new Map(entries.map((e) => [e.giveaway_id, e.n]));
  res.json({
    wpg_xp_ok: await appIsSource(),
    servers: (await wpgServers()).map((s) => s.name || s.join_code),
    list: await Promise.all(list.map(async (g) => {
      const { reward_codes: codes, fire_times: times, ...rest } = g;
      return {
        ...rest,
        prize: await prizeLabel(g),
        codes: (codes || []).length,
        drops_left: g.kind === 'drop' ? Math.max(0, (times || []).length - g.fired) : null,
        entrants: count.get(g.id) || 0,
        winners_list: winners.filter((w) => w.giveaway_id === g.id),
      };
    })),
  });
});

giveaways.post('/admin/giveaways', role('admin'), async (req, res) => {
  const g = await readBody(req.body || {});
  const codes = await Promise.all(String(req.body?.codes || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, g.winners).map((c) => seal(c.slice(0, 300))));
  const times = g.kind === 'drop' ? dropTimes(g.start_at, g.end_at, g.winners) : [];
  const row = await one(
    `INSERT INTO giveaways (${COLS.join(', ')}, reward_codes, fire_times, created_by)
     VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}, $${COLS.length + 1}, $${COLS.length + 2}, $${COLS.length + 3}) RETURNING id, title`,
    [...COLS.map((c) => g[c]), JSON.stringify(codes), JSON.stringify(times), req.user.id],
  );
  await audit(req.user.id, 'giveaway.create', `${row.title} (#${row.id})`, { kind: g.kind, reward: g.reward_type });
  changed();
  res.json({ ok: true, id: row.id });
});

giveaways.put('/admin/giveaways/:id', role('admin'), async (req, res) => {
  const old = await one("SELECT * FROM giveaways WHERE id=$1 AND status IN ('scheduled','open')", [int(req.params.id)]);
  if (!old) throw new HttpError(400, 'Only giveaways that haven\'t finished can be changed.');
  const g = await readBody({ ...req.body, kind: old.kind }, old);
  // New codes replace the old ones only if some were typed in.
  const typed = String(req.body?.codes || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const codes = typed.length ? await Promise.all(typed.slice(0, g.winners).map((c) => seal(c.slice(0, 300)))) : old.reward_codes;
  // Drops get fresh random times for the ones still to come if the window or number changed.
  let times = old.fire_times || [];
  if (old.kind === 'drop' && (+new Date(old.start_at) !== +g.start_at || +new Date(old.end_at) !== +g.end_at || old.winners !== g.winners)) {
    times = [...times.slice(0, old.fired), ...dropTimes(g.start_at, g.end_at, Math.max(0, g.winners - old.fired))];
  }
  await q(
    `UPDATE giveaways SET ${COLS.map((c, i) => `${c}=$${i + 2}`).join(', ')}, reward_codes=$${COLS.length + 2}, fire_times=$${COLS.length + 3} WHERE id=$1`,
    [old.id, ...COLS.map((c) => g[c]), JSON.stringify(codes), JSON.stringify(times)],
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

// Scheduled: end it and draw now. Drops: do the next drop now.
giveaways.post('/admin/giveaways/:id/draw', role('admin'), async (req, res) => {
  const g = await one("SELECT * FROM giveaways WHERE id=$1 AND status='open'", [int(req.params.id)]);
  if (!g) throw new HttpError(400, 'Only a running giveaway can be drawn.');
  if (g.kind === 'drop') {
    const w = await fireDrop(g);
    return res.json({ ok: true, winners: w ? [w.user.persona_name] : [], note: w ? '' : 'Nobody who can win is on the WPG server right now, so this drop will try again in 10 minutes.' });
  }
  const won = await drawScheduled(g, req.user.id);
  res.json({ ok: true, winners: won.map((w) => w.user.persona_name), note: won.length ? '' : 'Nobody qualified, so there was no winner.' });
});

// A winner didn't claim (or can't be reached): draw someone else in their place. Their code goes to the new winner.
giveaways.post('/admin/giveaways/winners/:id/redraw', role('admin'), async (req, res) => {
  const w = await one("UPDATE giveaway_winners SET status='expired' WHERE id=$1 AND status IN ('won','expired') RETURNING *", [int(req.params.id)]);
  if (!w) throw new HttpError(400, 'Only unclaimed prizes can be drawn again.');
  const g = await one('SELECT * FROM giveaways WHERE id=$1', [w.giveaway_id]);
  const pool = g.kind === 'drop'
    ? (await q('SELECT * FROM users WHERE steam_id = ANY($1)', [[...(await onServerNow())]])).filter((u) => canWin(g, u))
    : await candidates(g);
  const taken = new Set((await q('SELECT user_id FROM giveaway_winners WHERE giveaway_id=$1', [g.id])).map((r) => r.user_id));
  const [u] = pick(pool.filter((x) => !taken.has(x.id)), 1);
  if (!u) {
    await q("UPDATE giveaway_winners SET status='won' WHERE id=$1 AND status='expired' AND won_at > now() - make_interval(days => $2)", [w.id, g.claim_days]);
    throw new HttpError(400, g.kind === 'drop' ? 'Nobody who can win is on the WPG server right now.' : 'There\'s nobody else who qualifies.');
  }
  const won = await giveReward(g, u, w.code);
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
