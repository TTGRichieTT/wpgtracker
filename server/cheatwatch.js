// Cheat watch (staff only). Nothing here bans anyone: it gathers signs for staff to review.
//  - Steam's public ban records (VAC / game bans) and account age for everyone who plays on our server.
//  - Warning signs from our own numbers: kill rate, K/D and single-match spikes, compared with what's
//    normal on the WPG server; plus headshot rate and long-range kills once the kill feed is connected.
//  - Alerts to staff (app + a staff Discord channel) when a flagged player joins, or someone's kill rate
//    spikes during a live match. Member reports (app or Discord /report) land here too.
import crypto from 'crypto';
import express from 'express';
import { q, one, setting, flag, audit } from './db.js';
import { bus } from './bus.js';
import { HttpError, member, role, roleAtLeast, str, cleanName } from './util.js';
import { steamGet } from './steam.js';

const SITE = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://wpg-barracks.onrender.com').replace(/\/$/, '');
const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
const mins = (s) => Math.round((Number(s) || 0) / 60);
const isSteam = (id) => /^\d{17}$/.test(String(id || ''));

// ---------- Steam ban checks ----------
export async function checkSteamBans(limit = 300) {
  if (!process.env.STEAM_API_KEY) return { ok: false, reason: 'The Steam API key is not set' };
  const due = await q(
    `SELECT DISTINCT sp.steam_id FROM server_players sp LEFT JOIN player_checks pc ON pc.steam_id = sp.steam_id
      WHERE sp.steam_id ~ '^[0-9]{17}$' AND (pc.steam_id IS NULL OR pc.checked_at < now() - interval '1 day')
      LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (let i = 0; i < due.length; i += 100) {
    const ids = due.slice(i, i + 100).map((r) => r.steam_id);
    const [bans, sums] = await Promise.all([
      steamGet('/ISteamUser/GetPlayerBans/v1/', { steamids: ids.join(',') }),
      steamGet('/ISteamUser/GetPlayerSummaries/v2/', { steamids: ids.join(',') }).catch(() => null),
    ]);
    const created = new Map((sums?.response?.players || []).map((p) => [String(p.steamid), p.timecreated ? new Date(p.timecreated * 1000) : null]));
    for (const b of bans?.players || []) {
      await q(
        `INSERT INTO player_checks (steam_id, vac_bans, game_bans, community_banned, days_since_last_ban, account_created, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (steam_id) DO UPDATE SET vac_bans=EXCLUDED.vac_bans, game_bans=EXCLUDED.game_bans, community_banned=EXCLUDED.community_banned,
           days_since_last_ban=EXCLUDED.days_since_last_ban, account_created=COALESCE(EXCLUDED.account_created, player_checks.account_created), checked_at=now()`,
        [String(b.SteamId), Number(b.NumberOfVACBans) || 0, Number(b.NumberOfGameBans) || 0, !!b.CommunityBanned,
          (b.NumberOfVACBans || b.NumberOfGameBans) ? Number(b.DaysSinceLastBan) || 0 : null, created.get(String(b.SteamId)) || null],
      );
      n++;
    }
  }
  if (n) cache = null;
  return { ok: true, checked: n };
}

// ---------- Warning signs ----------
const median = (list) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

let cache = null; // { at, list, norms }
export async function assessAll({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 5 * 60 * 1000) return cache;
  const [players, checks, matchBest, sessionBest, feed, watch, reports, members] = await Promise.all([
    q(`SELECT steam_id, (ARRAY_AGG(name ORDER BY last_seen DESC NULLS LAST))[1] AS name, SUM(kills)::int kills, SUM(deaths)::int deaths,
              SUM(matches)::int matches, SUM(playtime_s)::int playtime, MAX(last_seen) last_seen
         FROM server_players WHERE steam_id ~ '^[0-9]{17}$' GROUP BY steam_id`),
    q('SELECT * FROM player_checks'),
    q(`SELECT DISTINCT ON (steam_id) steam_id, kills, seconds, ended_at FROM match_players WHERE seconds >= 300
        ORDER BY steam_id, (kills::float / seconds) DESC`),
    q(`SELECT DISTINCT ON (steam_id) steam_id, kills, secs, joined_at FROM (
         SELECT steam_id, kills, joined_at, EXTRACT(EPOCH FROM (COALESCE(left_at, last_seen) - joined_at))::int AS secs FROM server_sessions
       ) s WHERE secs >= 300 ORDER BY steam_id, (kills::float / secs) DESC`),
    q(`SELECT killer, COUNT(*)::int kills, COUNT(*) FILTER (WHERE headshot)::int hs, COUNT(*) FILTER (WHERE headshot IS NOT NULL)::int hs_known,
              COUNT(*) FILTER (WHERE distance >= 400)::int long, MAX(distance)::float max_dist
         FROM kill_events WHERE killer <> '' GROUP BY killer`),
    q('SELECT steam_id, status FROM player_watch'),
    q("SELECT steam_id, COUNT(*)::int n FROM player_reports WHERE status='open' AND steam_id <> '' GROUP BY steam_id"),
    q("SELECT id, steam_id FROM users WHERE steam_id ~ '^[0-9]{17}$'"),
  ]);
  const by = (rows, key = 'steam_id') => new Map(rows.map((r) => [r[key], r]));
  const C = by(checks); const MB = by(matchBest); const SB = by(sessionBest); const F = by(feed, 'killer');
  const Wt = by(watch); const R = by(reports); const M = by(members);

  // What's normal on our server (players with at least 30 minutes).
  const kpms = players.filter((p) => p.playtime >= 1800).map((p) => p.kills / (p.playtime / 60));
  const kds = players.filter((p) => p.kills >= 10).map((p) => p.kills / Math.max(1, p.deaths));
  const norms = { kpm: median(kpms) || 0.1, kd: median(kds) || 1 };

  const list = [];
  for (const p of players) {
    const status = Wt.get(p.steam_id)?.status || '';
    const reasons = [];
    const add = (pts, text) => reasons.push({ pts, text });
    const kpm = p.playtime >= 1200 ? p.kills / (p.playtime / 60) : null;
    const kd = p.kills / Math.max(1, p.deaths);
    if (kpm !== null) {
      const ratio = kpm / norms.kpm;
      if (kpm >= Math.max(2.5, norms.kpm * 5)) add(3, `${kpm.toFixed(2)} kills a minute — ${ratio.toFixed(0)}× the server's normal`);
      else if (kpm >= Math.max(1.5, norms.kpm * 3)) add(2, `${kpm.toFixed(2)} kills a minute — ${ratio.toFixed(0)}× the server's normal`);
    }
    if (p.kills >= 40) {
      if (kd >= Math.max(10, norms.kd * 8)) add(3, `K/D ${kd.toFixed(1)} over ${fmt(p.kills)} kills`);
      else if (kd >= Math.max(6, norms.kd * 4)) add(2, `K/D ${kd.toFixed(1)} over ${fmt(p.kills)} kills`);
    }
    const spike = [MB.get(p.steam_id) && { kills: MB.get(p.steam_id).kills, secs: MB.get(p.steam_id).seconds, what: 'match' },
      SB.get(p.steam_id) && { kills: SB.get(p.steam_id).kills, secs: SB.get(p.steam_id).secs, what: 'session' }]
      .filter(Boolean).sort((a, b) => b.kills / b.secs - a.kills / a.secs)[0];
    if (spike && spike.kills >= 25 && spike.kills / (spike.secs / 60) >= Math.max(2, norms.kpm * 4)) {
      add(2, `${fmt(spike.kills)} kills in one ${mins(spike.secs)}-minute ${spike.what}`);
    }
    const c = C.get(p.steam_id);
    if (c && (c.vac_bans || c.game_bans)) {
      const what = [c.vac_bans && `${c.vac_bans} VAC ban${c.vac_bans > 1 ? 's' : ''}`, c.game_bans && `${c.game_bans} game ban${c.game_bans > 1 ? 's' : ''}`].filter(Boolean).join(' + ');
      add(c.days_since_last_ban !== null && c.days_since_last_ban <= 730 ? 3 : 1, `Steam: ${what}, last one ${fmt(c.days_since_last_ban)} days ago`);
    }
    if (c?.community_banned) add(1, 'Steam: community ban');
    const ageDays = c?.account_created ? Math.floor((Date.now() - new Date(c.account_created).getTime()) / 86400000) : null;
    if (ageDays !== null && ageDays < 30 && ((kpm !== null && kpm >= norms.kpm * 2) || (p.kills >= 20 && kd >= 3))) {
      add(1, `Brand-new Steam account (${ageDays} days old) with high numbers`);
    }
    const f = F.get(p.steam_id);
    if (f && f.hs_known >= 40) {
      const pct = f.hs / f.hs_known;
      if (pct >= 0.8) add(3, `${Math.round(pct * 100)}% headshots over ${fmt(f.hs_known)} kills`);
      else if (pct >= 0.65) add(2, `${Math.round(pct * 100)}% headshots over ${fmt(f.hs_known)} kills`);
    }
    if (f && f.long >= 10 && f.long / f.kills >= 0.3) add(1, `${fmt(f.long)} kills from 400 m or more (longest ${Math.round(f.max_dist)} m)`);
    const open = R.get(p.steam_id)?.n || 0;
    if (open) add(Math.min(2, open), `${open} open report${open > 1 ? 's' : ''} from members`);

    let points = reasons.reduce((n, r) => n + r.pts, 0);
    if (status === 'cleared') points = 0;
    const severity = status === 'watch' && points < 2 ? 'watch' : points >= 4 ? 'high' : points >= 2 ? 'medium' : points >= 1 ? 'low' : '';
    if (!severity && status !== 'cleared') continue;
    list.push({
      steam_id: p.steam_id, name: cleanName(p.name), severity, points, status, reasons: reasons.map((r) => r.text),
      kills: p.kills, deaths: p.deaths, kd: Number(kd.toFixed(2)), kpm: kpm === null ? null : Number(kpm.toFixed(2)),
      playtime: p.playtime, matches: p.matches, last_seen: p.last_seen, account_days: ageDays,
      bans: c ? { vac: c.vac_bans, game: c.game_bans, days: c.days_since_last_ban } : null,
      member_id: M.get(p.steam_id)?.id || null, reports: open,
    });
  }
  const order = { high: 0, medium: 1, watch: 2, low: 3, '': 4 };
  list.sort((a, b) => order[a.severity] - order[b.severity] || b.points - a.points || (b.kpm || 0) - (a.kpm || 0));
  cache = { at: Date.now(), list, norms, players: players.length };
  return cache;
}

// ---------- Staff alerts ----------
// Sends one alert per player per kind within the quiet time (so staff aren't spammed).
async function alertStaff(steamId, kind, quietMinutes, { title, lines, color }) {
  if (!(await flag('cheat_alerts'))) return;
  const recent = await one(`SELECT 1 FROM watch_alerts WHERE steam_id=$1 AND kind=$2 AND sent_at > now() - ($3 || ' minutes')::interval`, [steamId, kind, String(quietMinutes)]);
  if (recent) return;
  await q(`INSERT INTO watch_alerts (steam_id, kind, sent_at) VALUES ($1,$2,now()) ON CONFLICT (steam_id, kind) DO UPDATE SET sent_at=now()`, [steamId, kind]);
  bus.emit('staff:notify', { title, body: lines[0] || '', link: '#/admin/cheatwatch' });
  bus.emit('staff:alert', { embeds: [{ title, description: lines.join('\n').slice(0, 3800), color, url: `${SITE()}/#/admin/cheatwatch` }] });
}

// Called by the server tracker after every check (every 30 s) with who is on the server.
export async function watchPoll(server, players, prevState, state) {
  const now = Date.now();
  const before = prevState?.players || {};
  const assessed = await assessAll().catch(() => null);
  const flagged = new Map((assessed?.list || []).map((p) => [p.steam_id, p]));
  const spikeKills = Math.max(5, Number(await setting('cheat_live_kills')) || 15);
  for (const p of players) {
    const sid = String(p.steamId || '');
    if (!isSteam(sid)) continue;
    const name = cleanName(p.name);
    // Joined since the last check: tell staff if they're flagged or on the watch list.
    const wasHere = before[sid] && now - (before[sid].seen || 0) < 2 * 60 * 1000;
    const f = flagged.get(sid);
    if (!wasHere && f && (f.severity === 'high' || f.severity === 'medium' || f.status === 'watch')) {
      await alertStaff(sid, 'join', f.status === 'watch' ? 120 : 360, {
        title: `⚠️ Cheat watch: ${name} joined the WPG server`,
        lines: [`Flag: **${f.severity === 'watch' ? 'On the watch list' : f.severity.toUpperCase()}**`, ...f.reasons.map((r) => `• ${r}`),
          `K/D ${f.kd} · ${f.kpm ?? '—'} kills/min · ${fmt(f.kills)} kills · ${fmt(mins(f.playtime))} min played`],
        color: f.severity === 'high' ? 0xe05252 : 0xf5a524,
      });
    }
    // Live spike: lots of kills in the last 5 minutes of this match.
    const hist = state.players[sid]?.hist || [];
    const fiveAgo = hist.find(([t]) => now - t <= 5 * 60 * 1000 + 15000);
    const gained = fiveAgo ? (Number(p.kills) || 0) - fiveAgo[1] : 0;
    if (gained >= spikeKills && flagged.get(sid)?.status !== 'cleared') {
      await alertStaff(sid, 'spike', 20, {
        title: `⚡ Live spike: ${name} — ${gained} kills in 5 minutes`,
        lines: [`On the WPG server right now (${fmt(p.kills)} kills, ${fmt(p.deaths)} deaths this match).`, 'Worth a look — open Cheat watch in the app.'],
        color: 0xe05252,
      });
    }
  }
}

// ---------- Reports ----------
export async function createReport({ name, steamId, reason, reporterUserId = null, reporterName = '', source = 'app' }) {
  const who = cleanName(name, '');
  const why = str(reason, 500);
  if (!who && !isSteam(steamId)) throw new HttpError(400, 'Say which player you are reporting.');
  if (!why) throw new HttpError(400, 'Say what you saw.');
  // Match the name to a player who has been on our server.
  let sid = isSteam(steamId) ? String(steamId) : '';
  let shown = who;
  if (!sid) {
    const p = await one(
      `SELECT steam_id, name FROM server_players WHERE lower(name) = lower($1) OR name ILIKE $2
        ORDER BY (lower(name) = lower($1)) DESC, last_seen DESC NULLS LAST LIMIT 1`,
      [who, `%${who.replace(/[%_]/g, '')}%`],
    );
    if (p) { sid = p.steam_id; shown = cleanName(p.name); }
  }
  const r = await one(
    `INSERT INTO player_reports (steam_id, name, reason, reporter_user_id, reporter_name, source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [sid, shown.slice(0, 64), why, reporterUserId, String(reporterName || '').slice(0, 64), source],
  );
  cache = null;
  bus.emit('staff:notify', { title: 'New player report', body: `${shown}: ${why.slice(0, 120)}`, link: '#/admin/cheatwatch' });
  if (await flag('cheat_alerts')) {
    bus.emit('staff:alert', { embeds: [{ title: `📣 Report: ${shown}`, description: `${why}\n\nReported by ${reporterName || 'a member'}${source === 'discord' ? ' on Discord' : ' in the app'}.`, color: 0xf5a524, url: `${SITE()}/#/admin/cheatwatch` }] });
  }
  return r;
}

// ---------- Kill feed (from the game server) ----------
// The game server can post every kill to a web address ([WDServerFeed] Url + Token). The game always adds
// "/api/ingest/events" to the address it's given, and sends batches like
// { serverId, serverName, events: [{ type: "killed", eventTime, matchId, killerSteamId, killerName, victimSteamId,
//   victimName, cause: "Id.Item.AK74M", distance (centimetres), contextTags: ["…KillContext.Headshot", …] }] }.
// Every event is stored as it came; other field names are read too, in case a build changes them.
const feedLog = { rejected: [] };
const pick = (o, keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((a, part) => (a === null || a === undefined ? a : a[part]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};
const steamOf = (o, side) => {
  const v = pick(o, [`${side}SteamId`, `${side}_steam_id`, `${side}SteamID`, `${side}Id`, `${side}_id`, `${side}.steamId`, `${side}.steam_id`, `${side}.steamID`, `${side}.id`, side]);
  return isSteam(v) ? String(v) : '';
};
function readKill(ev) {
  const killer = steamOf(ev, 'killer') || steamOf(ev, 'attacker') || steamOf(ev, 'instigator');
  const victim = steamOf(ev, 'victim') || steamOf(ev, 'killed') || steamOf(ev, 'target');
  const weapon = String(pick(ev, ['weapon', 'weaponName', 'weapon_name', 'weapon.name', 'weaponId', 'cause', 'damageCauser', 'causer', 'item', 'itemName']) ?? '').replace(/^Id\.Item\./, '').slice(0, 80);
  // The game's own format gives distance in centimetres (Unreal units); other field names are already metres.
  const gameFormat = Array.isArray(ev.contextTags) || ev.type === 'killed' || 'cause' in ev;
  let distance = Number(pick(ev, ['distanceM', 'distanceMeters', 'distance_m']));
  if (!Number.isFinite(distance)) {
    const d = Number(pick(ev, ['distance', 'range', 'dist']));
    distance = Number.isFinite(d) ? (gameFormat ? d / 100 : d) : null;
  }
  if (distance === null) {
    const cm = Number(pick(ev, ['distanceCm', 'distance_cm']));
    distance = Number.isFinite(cm) ? cm / 100 : null;
  }
  let headshot = pick(ev, ['headshot', 'isHeadshot', 'is_headshot', 'headShot']);
  if (headshot === undefined && Array.isArray(ev.contextTags)) headshot = ev.contextTags.some((t) => /\.Headshot$/i.test(String(t)));
  else if (headshot === undefined) {
    const bone = pick(ev, ['bone', 'hitBone', 'hit_bone', 'boneName', 'hitLocation']);
    headshot = bone === undefined ? null : /head|neck/i.test(String(bone));
  } else headshot = headshot === true || /^(true|1|yes)$/i.test(String(headshot));
  return { killer, victim, weapon, distance, headshot };
}

export const killFeed = express.Router();
// "/feed/kills" is the address the app gives the game; the game posts to it plus "/api/ingest/events".
killFeed.post(['/feed/kills', '/feed/kills/api/ingest/events'], express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const token = (await one("SELECT value FROM settings WHERE key='_killfeed_token'"))?.value || '';
  const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { text: text.slice(0, 2000) }; }
  // The token may come in any header (with or without "Bearer"), the address, or the body.
  const given = [...Object.values(req.headers).map((v) => String(v).replace(/^Bearer\s+/i, '')), req.query?.token, body?.token]
    .filter(Boolean).map(String);
  const ok = token && given.some((g) => g.length === token.length && crypto.timingSafeEqual(Buffer.from(g), Buffer.from(token)));
  if (!ok) {
    feedLog.rejected.unshift({ at: new Date().toISOString(), headers: Object.keys(req.headers), bodyKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 20) : [] });
    feedLog.rejected.length = Math.min(feedLog.rejected.length, 5);
    return res.status(401).json({ error: 'bad token' });
  }
  const events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : Array.isArray(body?.kills) ? body.kills : Array.isArray(body?.data) ? body.data : [body];
  const added = [];
  for (const ev of events.slice(0, 500)) {
    if (!ev || typeof ev !== 'object') continue;
    const k = readKill(ev);
    const raw = JSON.stringify(ev);
    added.push(await one(
      'INSERT INTO kill_events (killer, victim, weapon, distance, headshot, raw) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [k.killer, k.victim, k.weapon, k.distance, k.headshot, raw.length > 4000 ? JSON.stringify({ truncated: raw.slice(0, 4000) }) : raw],
    ));
  }
  res.json({ ok: true });
  // Staff watching the live kill feed (Servers page) see them straight away.
  if (added.length) shapeKills(added.slice(-50)).then((evs) => bus.emit('killfeed:new', evs)).catch(() => {});
});

export async function killFeedToken() {
  let row = await one("SELECT value FROM settings WHERE key='_killfeed_token'");
  if (!row?.value) {
    const t = crypto.randomBytes(24).toString('hex');
    await q("INSERT INTO settings (key, value) VALUES ('_killfeed_token', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [t]);
    row = { value: t };
  }
  return row.value;
}

// ---------- Staff pages (API) ----------
export const cheat = express.Router();

cheat.get('/admin/cheat', role('mod'), async (req, res) => {
  const a = await assessAll({ fresh: req.query.fresh === '1' });
  const [reports, feed, sample, checks, sessions] = await Promise.all([
    q(`SELECT r.*, u.persona_name AS closed_by_name FROM player_reports r LEFT JOIN users u ON u.id = r.closed_by
        ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 60`),
    one('SELECT COUNT(*)::int n, MAX(received_at) last, COUNT(*) FILTER (WHERE killer <> \'\')::int read_ok FROM kill_events'),
    one('SELECT raw, received_at FROM kill_events ORDER BY id DESC LIMIT 1'),
    one('SELECT COUNT(*)::int n, MAX(checked_at) last FROM player_checks'),
    one('SELECT COUNT(*)::int n FROM server_sessions'),
  ]);
  res.json({
    flags: a.list, norms: a.norms, players: a.players, reports,
    feed: { ...feed, sample: sample?.raw || null, rejected: feedLog.rejected, connected: !!(await one("SELECT 1 FROM settings WHERE key='_killfeed_on'")) },
    checks: { ...checks, steam_key: !!process.env.STEAM_API_KEY }, sessions: sessions?.n || 0,
    can_admin: roleAtLeast(req.user.role, 'admin'),
  });
});

cheat.get('/admin/cheat/player/:sid', role('mod'), async (req, res) => {
  const sid = String(req.params.sid);
  if (!isSteam(sid)) throw new HttpError(400, 'Not a player.');
  const a = await assessAll();
  const [stats, matches, sessions, check, feed, notes, reports, watch, memberRow] = await Promise.all([
    one(`SELECT (ARRAY_AGG(name ORDER BY last_seen DESC NULLS LAST))[1] AS name, SUM(kills)::int kills, SUM(deaths)::int deaths,
                SUM(matches)::int matches, SUM(wins)::int wins, SUM(losses)::int losses, SUM(playtime_s)::int playtime, MAX(last_seen) last_seen
           FROM server_players WHERE steam_id=$1`, [sid]),
    q('SELECT kills, deaths, seconds, won, faction, ended_at FROM match_players WHERE steam_id=$1 ORDER BY ended_at DESC LIMIT 20', [sid]),
    q(`SELECT kills, deaths, joined_at, EXTRACT(EPOCH FROM (COALESCE(left_at, last_seen) - joined_at))::int AS secs
         FROM server_sessions WHERE steam_id=$1 ORDER BY joined_at DESC LIMIT 20`, [sid]),
    one('SELECT * FROM player_checks WHERE steam_id=$1', [sid]),
    one(`SELECT COUNT(*)::int kills, COUNT(*) FILTER (WHERE headshot)::int hs, COUNT(*) FILTER (WHERE headshot IS NOT NULL)::int hs_known,
                MAX(distance)::float max_dist, (ARRAY_AGG(weapon ORDER BY weapon) FILTER (WHERE weapon <> ''))[1:3] AS weapons
           FROM kill_events WHERE killer=$1`, [sid]),
    q('SELECT n.*, u.persona_name AS author FROM player_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.steam_id=$1 ORDER BY n.created_at DESC', [sid]),
    q('SELECT * FROM player_reports WHERE steam_id=$1 ORDER BY created_at DESC LIMIT 20', [sid]),
    one('SELECT status FROM player_watch WHERE steam_id=$1', [sid]),
    one("SELECT id, persona_name FROM users WHERE steam_id=$1", [sid]),
  ]);
  if (!stats?.name && !matches.length && !reports.length) throw new HttpError(404, 'No record of that player on the WPG server.');
  const server = await one("SELECT id FROM game_servers WHERE enabled = true AND rcon_url <> '' ORDER BY sort_order, id LIMIT 1");
  res.json({
    steam_id: sid, name: cleanName(stats?.name), stats, matches, sessions, check, feed, notes, reports,
    status: watch?.status || '', flag: a.list.find((p) => p.steam_id === sid) || null, norms: a.norms,
    member: memberRow ? { id: memberRow.id, name: memberRow.persona_name } : null,
    can_admin: roleAtLeast(req.user.role, 'admin'), server_id: server?.id || null,
  });
});

cheat.post('/admin/cheat/player/:sid/status', role('mod'), async (req, res) => {
  const sid = String(req.params.sid);
  if (!isSteam(sid)) throw new HttpError(400, 'Not a player.');
  const status = ['watch', 'cleared'].includes(req.body?.status) ? req.body.status : '';
  if (status) {
    await q(`INSERT INTO player_watch (steam_id, status, updated_by, updated_at) VALUES ($1,$2,$3,now())
             ON CONFLICT (steam_id) DO UPDATE SET status=EXCLUDED.status, updated_by=EXCLUDED.updated_by, updated_at=now()`, [sid, status, req.user.id]);
  } else {
    await q('DELETE FROM player_watch WHERE steam_id=$1', [sid]);
  }
  await q('INSERT INTO player_notes (steam_id, author_id, text) VALUES ($1,$2,$3)', [sid, req.user.id,
    status === 'watch' ? 'Put on the watch list.' : status === 'cleared' ? 'Checked and cleared.' : 'Watch / cleared status removed.']);
  cache = null;
  res.json({ ok: true });
});

cheat.post('/admin/cheat/player/:sid/notes', role('mod'), async (req, res) => {
  const sid = String(req.params.sid);
  const text = str(req.body?.text, 1000);
  if (!isSteam(sid) || !text) throw new HttpError(400, 'Type a note.');
  await q('INSERT INTO player_notes (steam_id, author_id, text) VALUES ($1,$2,$3)', [sid, req.user.id, text]);
  res.json({ ok: true });
});

cheat.post('/admin/cheat/reports/:id/close', role('mod'), async (req, res) => {
  const r = await one("UPDATE player_reports SET status='closed', closed_by=$2, closed_at=now() WHERE id=$1 RETURNING *", [Number(req.params.id) || 0, req.user.id]);
  if (!r) throw new HttpError(404, 'Report not found.');
  if (r.steam_id && str(req.body?.note, 1000)) await q('INSERT INTO player_notes (steam_id, author_id, text) VALUES ($1,$2,$3)', [r.steam_id, req.user.id, `Report closed: ${str(req.body.note, 1000)}`]);
  cache = null;
  res.json({ ok: true });
});

// Points the WPG game server's kill feed at this app (it starts sending after the server's next restart).
cheat.post('/admin/cheat/killfeed/connect', role('admin'), async (req, res) => {
  const server = await one("SELECT * FROM game_servers WHERE enabled = true AND rcon_url <> '' AND rcon_password <> '' ORDER BY sort_order, id LIMIT 1");
  if (!server) throw new HttpError(400, 'No game server with RCON details is set up.');
  const { setKillFeed } = await import('./servers.js');
  await setKillFeed(server, `${SITE()}/feed/kills`, await killFeedToken());
  await q("INSERT INTO settings (key, value) VALUES ('_killfeed_on', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [new Date().toISOString()]);
  res.json({ ok: true });
});

// Delete one report (any staff) or one staff note (its author, or an admin).
cheat.delete('/admin/cheat/reports/:id', role('mod'), async (req, res) => {
  const r = await one('DELETE FROM player_reports WHERE id=$1 RETURNING name, reason', [Number(req.params.id) || 0]);
  if (!r) throw new HttpError(404, 'Report not found.');
  await audit(req.user.id, 'cheat.report.delete', r.name, { reason: r.reason.slice(0, 200) });
  cache = null;
  res.json({ ok: true });
});
cheat.delete('/admin/cheat/notes/:id', role('mod'), async (req, res) => {
  const n = await one('SELECT * FROM player_notes WHERE id=$1', [Number(req.params.id) || 0]);
  if (!n) throw new HttpError(404, 'Note not found.');
  if (n.author_id !== req.user.id && !roleAtLeast(req.user.role, 'admin')) throw new HttpError(403, 'Only the person who wrote it, or an admin, can delete a note.');
  await q('DELETE FROM player_notes WHERE id=$1', [n.id]);
  await audit(req.user.id, 'cheat.note.delete', n.steam_id, { text: n.text.slice(0, 200) });
  res.json({ ok: true });
});

cheat.post('/admin/cheat/check-now', role('admin'), async (_req, res) => {
  const r = await checkSteamBans(1000);
  if (!r.ok) throw new HttpError(400, r.reason);
  cache = null;
  res.json(r);
});

// Members: report a player (from the app).
const reportTimes = new Map();
cheat.post('/reports', member, async (req, res) => {
  const times = (reportTimes.get(req.user.id) || []).filter((t) => Date.now() - t < 3600 * 1000);
  if (times.length >= 5) throw new HttpError(429, 'You have sent a lot of reports — try again later.');
  await createReport({ name: req.body?.name, steamId: req.body?.steamId, reason: req.body?.reason, reporterUserId: req.user.id, reporterName: req.user.persona_name, source: 'app' });
  reportTimes.set(req.user.id, [...times, Date.now()]);
  res.json({ ok: true });
});

// ---------- Background jobs ----------
export function startCheatWatch() {
  const steam = async () => {
    await checkSteamBans().catch((e) => console.warn('[cheat watch] Steam checks:', e.message));
    setTimeout(steam, 10 * 60 * 1000);
  };
  setTimeout(steam, 2 * 60 * 1000);
  const tidy = async () => {
    await q("DELETE FROM kill_events WHERE received_at < now() - interval '180 days'").catch(() => {});
    await q("DELETE FROM watch_alerts WHERE sent_at < now() - interval '7 days'").catch(() => {});
    setTimeout(tidy, 24 * 3600 * 1000);
  };
  setTimeout(tidy, 10 * 60 * 1000);
}

// ---------- Live kill feed (staff) ----------
// Names for Steam IDs: the name they last played under on our servers, or their WPG Barracks name.
async function namesFor(sids) {
  const ids = [...new Set(sids.filter(isSteam))];
  if (!ids.length) return new Map();
  const [played, members] = await Promise.all([
    q(`SELECT DISTINCT ON (steam_id) steam_id, name FROM server_players WHERE steam_id = ANY($1) ORDER BY steam_id, last_seen DESC NULLS LAST`, [ids]),
    q("SELECT id, steam_id, persona_name FROM users WHERE steam_id = ANY($1) AND status='active'", [ids]),
  ]);
  const out = new Map();
  for (const p of played) out.set(p.steam_id, { name: cleanName(p.name), user: null });
  for (const u of members) out.set(u.steam_id, { name: out.get(u.steam_id)?.name || u.persona_name, user: u.id });
  return out;
}
// "BP_AK74M_C" / "Weapon_AK74M" → "AK74M"
const weaponName = (w) => String(w || '').replace(/^(BP_|Weapon_|WPN_|W_)/i, '').replace(/_C$/, '').replace(/_/g, ' ').trim();
async function shapeKills(rows) {
  const names = await namesFor(rows.flatMap((r) => [r.killer, r.victim]));
  const side = (sid, fallback) => ({ sid: isSteam(sid) ? sid : '', name: names.get(sid)?.name || cleanName(fallback, '') || (isSteam(sid) ? `…${sid.slice(-4)}` : '?'), user: names.get(sid)?.user || null });
  return rows.map((r) => {
    const raw = r.raw && typeof r.raw === 'object' ? r.raw : {};
    return {
      id: r.id, at: r.received_at,
      killer: side(r.killer, pick(raw, ['killerName', 'killer_name', 'killer.name', 'attackerName', 'attacker.name', 'instigatorName'])),
      victim: side(r.victim, pick(raw, ['victimName', 'victim_name', 'victim.name', 'killedName', 'targetName'])),
      weapon: weaponName(r.weapon), distance: r.distance === null || r.distance === undefined ? null : Math.round(Number(r.distance)), headshot: r.headshot,
    };
  });
}
async function feedServerId() {
  return (await one("SELECT id FROM game_servers WHERE enabled = true AND rcon_url <> '' AND rcon_password <> '' ORDER BY sort_order, id LIMIT 1"))?.id || null;
}
cheat.get('/admin/cheat/killfeed', role('mod'), async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const rows = await q('SELECT * FROM kill_events ORDER BY id DESC LIMIT $1', [limit]);
  res.json({
    server_id: await feedServerId(),
    connected: !!(await one("SELECT 1 FROM settings WHERE key='_killfeed_on'")),
    events: await shapeKills(rows),
  });
});
