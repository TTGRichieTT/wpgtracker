// WPG XP worked out by the app from each finished match on servers ticked "Earns WPG XP" (Admin → Game
// servers): XP for kills, time played, finishing and winning, minus penalties for losing, a bad K/D and
// leaving early (amounts in Admin → WPG XP).
//  - Until an admin switches over (Admin → WPG XP), the Discord bot stays in charge: this runs alongside it
//    and only counts, so the two can be compared. Nobody's shown XP changes.
//  - Switching over starts everyone from the bot's XP that day; from then on server_progress (what the
//    leaderboard, profiles and Discord show) is written here and the bot is no longer read.
import express from 'express';
import { q, one, getSettings, setting, clearSettingsCache, audit } from './db.js';
import { bus } from './bus.js';
import { HttpError, member, role, str } from './util.js';
import { syncProgress } from './progress.js';

export const wpgxp = express.Router();

const n = (v) => Math.max(0, Math.round(Number(v) || 0));

export async function appIsSource() {
  return (await setting('_wpg_xp_source')) === 'app';
}

async function saveSetting(key, value) {
  await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
  clearSettingsCache();
}

export async function rates() {
  const s = await getSettings();
  return {
    kill: n(s.wpgxp_kill), per5min: n(s.wpgxp_per5min), finish: n(s.wpgxp_finish), win: n(s.wpgxp_win),
    penalties: s.wpgxp_penalties === 'true',
    loss: n(s.wpgxp_loss), kdEach: n(s.wpgxp_kd_each), kdCap: n(s.wpgxp_kd_cap), kdMinutes: n(s.wpgxp_kd_minutes),
    leave: n(s.wpgxp_leave), leaveMinutes: n(s.wpgxp_leave_minutes),
    minPlayers: n(s.wpgxp_min_players), floor: s.wpgxp_rank_floor === 'true',
  };
}

// ---------- Ranks ----------
let rankCache = null;
export async function wpgRanks() {
  if (!rankCache) rankCache = await q('SELECT level, name, min_xp FROM wpg_ranks ORDER BY level');
  return rankCache;
}

// The rank an XP total sits in (ranks in order, first at 0 XP), where it starts and the next one.
export function rankAt(xp, ranks) {
  if (!ranks.length) return null;
  let i = 0;
  while (i + 1 < ranks.length && ranks[i + 1].min_xp <= xp) i++;
  const next = ranks[i + 1];
  return { level: ranks[i].level, name: ranks[i].name, from: ranks[i].min_xp, next: next ? { name: next.name, xp: next.min_xp } : null };
}

// For showing progress: { from, next: { name, xp } | null }, or null while no rank list is set up.
export async function rankProgress(xp) {
  const r = rankAt(Number(xp) || 0, await wpgRanks());
  return r ? { from: r.from, next: r.next } : null;
}

// The standard 200 WPG ranks (20 tiers × I–X, Recruit I at 0 → Wardog X at 650,000 XP). Each rank needs
// 2,000 XP more than the last at the start, rising steadily to 4,550 near the top (always in 50s). One match
// can't climb two ranks: that would take over 2,000 XP (around 100 kills in an hour-long win).
const TIERS = ['Recruit', 'Private', 'Private First Class', 'Lance Corporal', 'Corporal', 'Sergeant', 'Staff Sergeant',
  'Sergeant Major', 'Warrant Officer', 'Second Lieutenant', 'Lieutenant', 'Captain', 'Major', 'Lieutenant Colonel', 'Colonel',
  'Brigadier', 'General', 'Field Marshal', 'Field Commander', 'Wardog'];
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
export function defaultRanks() {
  const count = TIERS.length * NUMERALS.length;
  const top = 650000;
  const minGap = 2000;
  const step = 50;
  // The XP above 2,000 per rank, in 50s, shared out so each gap is a little bigger than the one before.
  const extra = (top - minGap * (count - 1)) / step;
  const weight = ((count - 1) * (count - 2)) / 2;
  const units = Array.from({ length: count - 1 }, (_, k) => Math.floor((extra * k) / weight));
  for (let k = count - 2, left = extra - units.reduce((a, b) => a + b, 0); left > 0; k--, left--) units[k]++;
  let xp = 0;
  return Array.from({ length: count }, (_, i) => {
    if (i) xp += minGap + units[i - 1] * step;
    return { level: i + 1, name: `${TIERS[Math.floor(i / 10)]} ${NUMERALS[i % 10]}`, min_xp: xp };
  });
}

// One rank per line: "Recruit I = 0", "Recruit II, 1500", "Recruit III 3,000" or tab-separated (pasted
// from a spreadsheet). A leading "1." or "1)" is ignored. XP must start at 0 and go up.
export function parseRanks(text) {
  const ranks = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim().replace(/^\d+\s*[.)]\s+/, '');
    if (!line) return;
    const m = /^(.+?)\s*(?:=|:|,|;|\t|\||-|–)?\s*(\d[\d,]*)\s*(?:xp)?$/i.exec(line);
    if (!m) throw new HttpError(400, `Line ${i + 1} ("${raw.trim().slice(0, 40)}") needs a rank name and its XP, e.g. "Recruit II = 1500".`);
    const name = m[1].trim().replace(/[=:,;|\-–]+$/, '').trim().slice(0, 40);
    const xp = Number(m[2].replace(/,/g, ''));
    if (!name) throw new HttpError(400, `Line ${i + 1} has no rank name.`);
    const prev = ranks[ranks.length - 1];
    if (prev && xp <= prev.min_xp) throw new HttpError(400, `Line ${i + 1}: ${name} (${xp.toLocaleString('en-GB')} XP) must need more XP than ${prev.name} (${prev.min_xp.toLocaleString('en-GB')}).`);
    ranks.push({ level: ranks.length + 1, name, min_xp: xp });
  });
  if (ranks.length > 500) throw new HttpError(400, 'That is more than 500 ranks.');
  if (ranks.length && ranks[0].min_xp !== 0) throw new HttpError(400, `The first rank (${ranks[0].name}) must start at 0 XP.`);
  return ranks;
}

// Writes everyone's rank from their app XP into server_progress (what's shown), without rank-up posts.
async function writeShown(ranks) {
  const rows = (await q('SELECT steam_id, name, xp FROM wpg_xp')).map((r) => {
    const rank = rankAt(r.xp, ranks);
    return { steam_id: r.steam_id, name: r.name, xp: r.xp, level: rank?.level || 1, rank: rank?.name || '' };
  });
  if (!rows.length) return;
  const json = JSON.stringify(rows);
  await q(
    `UPDATE wpg_xp w SET best_level = x.level FROM jsonb_to_recordset($1::jsonb) AS x(steam_id text, level int) WHERE w.steam_id = x.steam_id`,
    [json],
  );
  await upsertShown(json);
}

// While the bot is in charge: everyone's shown rank follows the app's rank list (XP stays the bot's).
// No rank-up posts: this is the list changing, not anyone ranking up.
export async function rerankBotRows(ranks) {
  if (!ranks.length) return;
  const rows = (await q('SELECT steam_id, xp FROM server_progress')).map((r) => {
    const rank = rankAt(r.xp, ranks);
    return { steam_id: r.steam_id, level: rank.level, rank: rank.name };
  });
  if (!rows.length) return;
  await q(
    `UPDATE server_progress p SET rank_level = x.level, rank_name = x.rank
       FROM jsonb_to_recordset($1::jsonb) AS x(steam_id text, level int, rank text) WHERE p.steam_id = x.steam_id`,
    [JSON.stringify(rows)],
  );
}

async function saveRanks(ranks) {
  await q('DELETE FROM wpg_ranks');
  if (ranks.length) {
    await q(
      `INSERT INTO wpg_ranks (level, name, min_xp) SELECT level, name, min_xp FROM jsonb_to_recordset($1::jsonb) AS x(level int, name text, min_xp int)`,
      [JSON.stringify(ranks)],
    );
  }
  rankCache = null;
  // Everyone's shown rank follows the new list straight away (no rank-up posts).
  if (await appIsSource()) await writeShown(ranks);
  else await rerankBotRows(ranks);
}

function upsertShown(json) {
  return q(
    `INSERT INTO server_progress (steam_id, bot_name, xp, rank_level, rank_name, synced_at)
     SELECT steam_id, name, xp, level, rank, now() FROM jsonb_to_recordset($1::jsonb) AS x(steam_id text, name text, xp int, level int, rank text)
     ON CONFLICT (steam_id) DO UPDATE SET bot_name = CASE WHEN EXCLUDED.bot_name <> '' THEN EXCLUDED.bot_name ELSE server_progress.bot_name END,
       xp=EXCLUDED.xp, rank_level=EXCLUDED.rank_level, rank_name=EXCLUDED.rank_name, synced_at=now()`,
    [json],
  );
}

// ---------- Matches ----------
// Called by the server tracker when a match on a WPG XP server ends.
// players: [{ steam_id, name, secs, kills, deaths, stayed, won }] (only those who played 60 s or more)
// match:   { winner (one team had the top score), scored (anyone scored), healthy (the tracker never lost
//            sight of the server during the match, so "left early" can be trusted) }
export async function awardMatch(serverId, players, match) {
  if (!players.length) return;
  const r = await rates();
  const ranks = await wpgRanks();
  const live = await appIsSource();
  const left = players.filter((p) => !p.stayed).length;
  // Half the players or more gone at once = a crash or restart, not people quitting.
  const massExit = left / players.length >= 0.5;
  const enough = players.length >= r.minPlayers;

  const ids = players.map((p) => p.steam_id);
  const before = new Map((await q('SELECT steam_id, xp, best_level FROM wpg_xp WHERE steam_id = ANY($1)', [ids])).map((x) => [x.steam_id, x]));
  const totals = [];
  const log = [];
  const rankUps = [];
  for (const p of players) {
    const d = { minutes: Math.round(p.secs / 60), kills: p.kills, deaths: p.deaths, ...(p.stayed ? {} : { stayed: false }) };
    let gain = 0;
    let penalty = 0;
    const add = (key, v) => {
      if (!v) return;
      d[key] = v;
      if (v > 0) gain += v;
      else penalty -= v;
    };
    add('kill_xp', p.kills * r.kill);
    add('time_xp', Math.round((p.secs / 300) * r.per5min));
    if (enough && p.stayed && match.scored) add('finish', r.finish);
    if (enough && p.won === true) add('win', r.win);
    if (r.penalties) {
      if (enough && p.won === false) add('loss', -r.loss);
      if (p.secs >= r.kdMinutes * 60 && p.deaths > p.kills) add('kd', -Math.min(r.kdCap, (p.deaths - p.kills) * r.kdEach));
      if (enough && !p.stayed && match.winner && match.healthy && !massExit && p.secs >= r.leaveMinutes * 60) add('left', -r.leave);
    }
    const old = before.get(p.steam_id);
    const was = old?.xp || 0;
    let xp = was + gain - penalty;
    // Penalties can't take anyone below the start of the rank they're in (Admin → WPG XP).
    if (r.floor && ranks.length) xp = Math.max(xp, Math.min(was, rankAt(was, ranks).from));
    xp = Math.max(0, xp);
    if (xp !== was + gain - penalty) d.floor = true;
    const rank = rankAt(xp, ranks);
    const best = old?.best_level || 1;
    if (live && rank && rank.level > best) rankUps.push({ steamId: p.steam_id, name: p.name, rank: rank.name, level: rank.level, xp });
    totals.push({ steam_id: p.steam_id, name: p.name, xp, best_level: Math.max(best, rank?.level || 1), gain, penalty, level: rank?.level || 1, rank: rank?.name || '' });
    log.push({ steam_id: p.steam_id, xp: xp - was, detail: d });
  }

  await q(
    `INSERT INTO wpg_xp (steam_id, name, xp, best_level, gain, penalty, matches, updated_at)
     SELECT steam_id, name, xp, best_level, gain, penalty, 1, now()
       FROM jsonb_to_recordset($1::jsonb) AS x(steam_id text, name text, xp int, best_level int, gain int, penalty int)
     ON CONFLICT (steam_id) DO UPDATE SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE wpg_xp.name END,
       xp=EXCLUDED.xp, best_level=EXCLUDED.best_level, gain=wpg_xp.gain+EXCLUDED.gain, penalty=wpg_xp.penalty+EXCLUDED.penalty,
       matches=wpg_xp.matches+1, updated_at=now()`,
    [JSON.stringify(totals)],
  );
  await q(
    `INSERT INTO wpg_xp_log (steam_id, server_id, xp, counted, detail)
     SELECT steam_id, $2, xp, $3, detail FROM jsonb_to_recordset($1::jsonb) AS x(steam_id text, xp int, detail jsonb)`,
    [JSON.stringify(log), serverId, live],
  );
  if (!live) return;
  await upsertShown(JSON.stringify(totals));
  await q("INSERT INTO settings (key, value) VALUES ('_progress_synced', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [new Date().toISOString()]);
  for (const a of rankUps) bus.emit('announce', { type: 'wpgrank', ...a });
  bus.emit('server:board', null);
}

// Extra WPG XP for one player (giveaway prizes), with a line in their match history. Only once the app is in
// charge of WPG XP: while the bot is, its numbers would simply overwrite it.
export async function grantWpgXp(steamId, name, amount, reason) {
  if (!(await appIsSource())) throw new HttpError(400, 'WPG XP prizes work once WPG XP is switched over to the app (Admin → WPG XP).');
  const ranks = await wpgRanks();
  const old = await one('SELECT xp, best_level FROM wpg_xp WHERE steam_id=$1', [steamId]);
  const xp = Math.max(0, (old?.xp || 0) + amount);
  const rank = rankAt(xp, ranks);
  const best = old?.best_level || 1;
  const level = rank?.level || 1;
  await q(
    `INSERT INTO wpg_xp (steam_id, name, xp, best_level) VALUES ($1,$2,$3,$4)
     ON CONFLICT (steam_id) DO UPDATE SET xp=EXCLUDED.xp, best_level=GREATEST(wpg_xp.best_level, EXCLUDED.best_level), updated_at=now()`,
    [steamId, name, xp, Math.max(best, level)],
  );
  await q('INSERT INTO wpg_xp_log (steam_id, xp, counted, detail) VALUES ($1,$2,true,$3)', [steamId, amount, JSON.stringify({ bonus: amount, reason })]);
  await upsertShown(JSON.stringify([{ steam_id: steamId, name, xp, level, rank: rank?.name || '' }]));
  if (rank && level > best) bus.emit('announce', { type: 'wpgrank', steamId, name, rank: rank.name, level, xp });
  bus.emit('server:board', null);
}

// ---------- Comparing with the bot, and switching over ----------
// Starts the comparison afresh: the bot's XP now is everyone's starting point; the app's counts go to 0.
export async function resetComparison() {
  await q(`INSERT INTO wpg_xp (steam_id, name) SELECT steam_id, bot_name FROM server_progress ON CONFLICT (steam_id) DO NOTHING`);
  await q(`UPDATE wpg_xp w SET gain=0, penalty=0, matches=0, bot_start=(SELECT xp FROM server_progress p WHERE p.steam_id = w.steam_id)`);
  await saveSetting('_wpgxp_since', new Date().toISOString());
}

export async function switchSource(to, actor) {
  let note = '';
  if (to === 'app') {
    const ranks = await wpgRanks();
    if (ranks.length < 2) throw new HttpError(400, 'Set up the WPG rank list first (below).');
    // Get the bot's very latest numbers; if it can't be reached, the last ones copied are used.
    const synced = await syncProgress().catch((e) => ({ ok: false, reason: e.message }));
    if (!synced.ok) {
      const last = await setting('_progress_synced');
      note = `Couldn't reach the bot (${synced.reason}), so the numbers copied ${last ? `at ${new Date(last).toUTCString()}` : 'last'} were used.`;
    }
    // Everyone starts from the bot's XP. Players the bot never had keep what the app counted (without penalties).
    await q(`INSERT INTO wpg_xp (steam_id, name, xp) SELECT steam_id, bot_name, xp FROM server_progress
             ON CONFLICT (steam_id) DO UPDATE SET xp = EXCLUDED.xp`);
    await q('UPDATE wpg_xp w SET xp = gain WHERE NOT EXISTS (SELECT 1 FROM server_progress p WHERE p.steam_id = w.steam_id)');
    await writeShown(ranks);
    await saveSetting('_wpg_xp_source', 'app');
    await saveSetting('_wpgxp_switched', new Date().toISOString());
  } else {
    await saveSetting('_wpg_xp_source', 'bot');
    const synced = await syncProgress().catch((e) => ({ ok: false, reason: e.message }));
    if (!synced.ok) note = `Couldn't reach the bot yet (${synced.reason}); its numbers will come back on the next copy.`;
    // The comparison starts again from here.
    await resetComparison();
  }
  await audit(actor.id, 'wpgxp.switch', to, note ? { note } : {});
  bus.emit('server:board', null);
  return note;
}

async function comparison() {
  const rows = await q(
    `SELECT w.steam_id, COALESCE(NULLIF(TRIM(p.bot_name), ''), w.name) AS name, w.gain, w.penalty, w.matches,
            COALESCE(w.bot_start, 0) AS bot_start, p.xp AS bot_xp
       FROM wpg_xp w LEFT JOIN server_progress p ON p.steam_id = w.steam_id
      WHERE w.matches > 0 OR COALESCE(p.xp, 0) <> COALESCE(w.bot_start, 0)
      ORDER BY GREATEST(w.gain, COALESCE(p.xp, 0) - COALESCE(w.bot_start, 0)) DESC
      LIMIT 300`,
  );
  return rows.map((r) => ({
    name: String(r.name || '').trim() || `Player …${r.steam_id.slice(-4)}`,
    bot: (r.bot_xp ?? 0) - r.bot_start,
    app: r.gain,
    penalty: r.penalty,
    matches: r.matches,
  }));
}

// ---------- Routes ----------
wpgxp.get('/admin/wpg-xp', role('admin'), async (_req, res) => {
  const live = await appIsSource();
  const [ranks, seen, servers] = await Promise.all([
    wpgRanks(),
    // What the bot's data shows per rank (lowest XP seen at each), to help fill the list in.
    q(`SELECT rank_level AS level, MIN(rank_name) AS name, MIN(xp)::int AS lowest, COUNT(*)::int AS players
         FROM server_progress GROUP BY rank_level ORDER BY rank_level`),
    q("SELECT id, COALESCE(NULLIF(name, ''), join_code) AS name, wpg_xp, (rcon_url <> '' AND rcon_password <> '') AS rcon FROM game_servers ORDER BY sort_order, id"),
  ]);
  res.json({
    source: live ? 'app' : 'bot',
    since: await setting('_wpgxp_since'),
    switched: await setting('_wpgxp_switched'),
    ranks,
    seen,
    servers,
    comparison: live ? [] : await comparison(),
  });
});

wpgxp.put('/admin/wpg-xp/ranks', role('admin'), async (req, res) => {
  const ranks = parseRanks(str(req.body?.text, 40000));
  await saveRanks(ranks);
  await audit(req.user.id, 'wpgxp.ranks', `${ranks.length} ranks`);
  bus.emit('server:board', null);
  res.json({ ok: true, ranks: ranks.length });
});

wpgxp.post('/admin/wpg-xp/switch', role('admin'), async (req, res) => {
  const to = req.body?.to === 'app' ? 'app' : 'bot';
  const note = await switchSource(to, req.user);
  res.json({ ok: true, source: to, note });
});

wpgxp.post('/admin/wpg-xp/reset-comparison', role('admin'), async (req, res) => {
  if (await appIsSource()) throw new HttpError(400, 'Already switched over: there is nothing to compare.');
  await resetComparison();
  await audit(req.user.id, 'wpgxp.reset-comparison', '');
  res.json({ ok: true });
});

// Your last matches on the WPG server and what each gave or took (only once the app is in charge).
wpgxp.get('/wpg-xp/history', member, async (req, res) => {
  const rows = await q(
    'SELECT xp, detail, created_at FROM wpg_xp_log WHERE steam_id=$1 AND counted = true ORDER BY id DESC LIMIT 15',
    [req.user.steam_id],
  );
  res.json(rows);
});

// The rules as they are now, for the leaderboard ("how WPG XP works").
export async function rulesOut() {
  const live = await appIsSource();
  return live ? { source: 'app', ...(await rates()) } : { source: 'bot' };
}

export async function startWpgXp() {
  try {
    if (!(await setting('_wpgxp_since'))) await resetComparison();
    // The standard 200 ranks, put in once if there's no rank list yet (an admin can change them in Admin → WPG XP).
    if (!(await setting('_wpg_ranks_default'))) {
      if (!(await wpgRanks()).length) await saveRanks(defaultRanks());
      await saveSetting('_wpg_ranks_default', 'true');
    }
    // "WPG Commander" became "Field Commander" (2026-10-03). Rename it once in the saved rank list and in
    // everyone's shown rank; an admin's own names for that tier are left alone.
    if (!(await setting('_wpg_field_commander'))) {
      await q("UPDATE wpg_ranks SET name = 'Field Commander' || substr(name, 14) WHERE name ~ '^WPG Commander [IVX]+$'");
      await q("UPDATE server_progress SET rank_name = 'Field Commander' || substr(rank_name, 14) WHERE rank_name ~ '^WPG Commander [IVX]+$'");
      rankCache = null;
      await saveSetting('_wpg_field_commander', 'true');
    }
  } catch (e) {
    console.warn('[wpgxp]', e.message);
  }
}
