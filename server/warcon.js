// Player history from WarCon (the WPG server's own player log, read-only API). Every hour it reads every
// player's totals (Steam ID, kills, deaths, sessions, playtime) into the WPG server leaderboard.
// For each number we keep whichever is higher, ours or WarCon's, so nothing is counted twice.
// Needs WARCON_API_KEY in the host's environment (never in the code). WARCON_URL can change the address.
import { q, one } from './db.js';
import { bus } from './bus.js';

const BASE = (process.env.WARCON_URL || 'https://warcon.taild5e8b5.ts.net:8443').replace(/\/+$/, '');
const WPG_JOIN_CODE = 'bf019b3b-7670-4879-9220-b541edc58e1b';
const PAGE = 1000;

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${process.env.WARCON_API_KEY}` },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401) throw new Error('WarCon rejected the API key');
  if (!res.ok) throw new Error(`WarCon returned ${res.status}`);
  return res.json();
}

export async function syncWarcon() {
  if (!process.env.WARCON_API_KEY) return { ok: false, reason: 'WARCON_API_KEY is not set' };
  const server = await one('SELECT id FROM game_servers WHERE join_code=$1', [WPG_JOIN_CODE]);
  if (!server) return { ok: false, reason: 'WPG server not found' };

  let players = [];
  for (let offset = 0; offset < 100000; offset += PAGE) {
    const data = await get(`/v1/players?limit=${PAGE}&offset=${offset}`);
    const page = Array.isArray(data?.players) ? data.players : [];
    players = players.concat(page);
    if (page.length < PAGE) break;
  }

  // All players go to the database in one trip (not three per player).
  const num = (v) => Math.max(0, Math.round(Number(v) || 0));
  const rows = new Map();
  for (const p of players) {
    const sid = String(p.steamId || '');
    if (!/^\d{17}$/.test(sid)) continue;
    const name = String(p.name || '').trim().slice(0, 64) || sid;
    const seen = p.lastSeen && !Number.isNaN(Date.parse(p.lastSeen)) ? new Date(p.lastSeen).toISOString() : null;
    rows.set(sid, { steam_id: sid, name, kills: num(p.kills), deaths: num(p.deaths), matches: num(p.sessions), playtime_s: num(p.playtimeSeconds), last_seen: seen });
  }
  const json = JSON.stringify([...rows.values()]);
  await q(
    `INSERT INTO server_players (server_id, steam_id, name, kills, deaths, matches, playtime_s, last_seen)
     SELECT $1, steam_id, name, kills, deaths, matches, playtime_s, last_seen
       FROM jsonb_to_recordset($2::jsonb) AS x(steam_id text, name text, kills int, deaths int, matches int, playtime_s int, last_seen timestamptz)
     ON CONFLICT (server_id, steam_id) DO UPDATE SET
       name = CASE WHEN EXCLUDED.last_seen >= COALESCE(server_players.last_seen, EXCLUDED.last_seen) THEN EXCLUDED.name ELSE server_players.name END,
       kills=GREATEST(server_players.kills, EXCLUDED.kills), deaths=GREATEST(server_players.deaths, EXCLUDED.deaths),
       matches=GREATEST(server_players.matches, EXCLUDED.matches), playtime_s=GREATEST(server_players.playtime_s, EXCLUDED.playtime_s),
       last_seen=GREATEST(server_players.last_seen, EXCLUDED.last_seen)`,
    [server.id, json],
  );
  // A row imported earlier by name only (from a screenshot) is the same player: fold it in.
  await q(
    `WITH m AS (
       SELECT DISTINCT ON (n.steam_id) n.steam_id AS old_id, x.steam_id AS sid, n.matches, n.playtime_s, n.wins, n.losses
         FROM jsonb_to_recordset($2::jsonb) AS x(steam_id text, name text)
         JOIN server_players n ON n.server_id = $1 AND n.steam_id = 'name:' || x.name),
     u AS (
       UPDATE server_players sp SET matches=GREATEST(sp.matches, m.matches), playtime_s=GREATEST(sp.playtime_s, m.playtime_s),
              wins=GREATEST(sp.wins, m.wins), losses=GREATEST(sp.losses, m.losses)
         FROM m WHERE sp.server_id = $1 AND sp.steam_id = m.sid
       RETURNING m.old_id)
     DELETE FROM server_players WHERE server_id = $1 AND steam_id IN (SELECT old_id FROM u)`,
    [server.id, json],
  );
  const n = rows.size;
  bus.emit('server:board', server.id);
  const sessions = await syncSessions().catch((e) => { console.warn('[warcon] sessions', e.message); return 0; });
  return { ok: true, players: n, sessions };
}

// Play sessions (join to leave) for cheat watch. After the first full copy, only sessions active in
// the last day are fetched again (they may still have been running last time).
async function syncSessions() {
  const last = await one('SELECT MAX(last_seen) AS t FROM server_sessions');
  const since = last?.t ? new Date(new Date(last.t).getTime() - 24 * 3600 * 1000).toISOString() : null;
  let n = 0;
  for (let offset = 0; offset < 200000; offset += PAGE) {
    const data = await get(`/v1/sessions?limit=${PAGE}&offset=${offset}${since ? `&since=${encodeURIComponent(since)}` : ''}`);
    const page = Array.isArray(data?.sessions) ? data.sessions : [];
    // Each page of up to 1000 sessions is saved in one trip.
    const when = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
    const rows = new Map();
    for (const s of page) {
      const sid = String(s.steamId || '');
      if (!/^\d{17}$/.test(sid) || s.id === undefined || s.id === null) continue;
      rows.set(String(s.id), { id: String(s.id), steam_id: sid, name: String(s.name || '').slice(0, 64), joined_at: when(s.joinedAt),
        last_seen: when(s.lastSeen), left_at: when(s.leftAt), kills: Math.max(0, Math.round(Number(s.kills) || 0)), deaths: Math.max(0, Math.round(Number(s.deaths) || 0)) });
    }
    if (rows.size) {
      await q(
        `INSERT INTO server_sessions (id, steam_id, name, joined_at, last_seen, left_at, kills, deaths)
         SELECT id, steam_id, name, joined_at, last_seen, left_at, kills, deaths
           FROM jsonb_to_recordset($1::jsonb) AS x(id text, steam_id text, name text, joined_at timestamptz, last_seen timestamptz, left_at timestamptz, kills int, deaths int)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, last_seen=EXCLUDED.last_seen, left_at=EXCLUDED.left_at,
           kills=EXCLUDED.kills, deaths=EXCLUDED.deaths`,
        [JSON.stringify([...rows.values()])],
      );
      n += rows.size;
    }
    if (page.length < PAGE) break;
  }
  return n;
}

export function startWarconSync(onDone) {
  if (!process.env.WARCON_API_KEY) {
    console.log('[WPG] WARCON_API_KEY not set: WarCon player history will not sync.');
    return;
  }
  const run = async () => {
    try {
      const r = await syncWarcon();
      if (r.ok) {
        console.log(`[warcon] synced ${r.players} players`);
        await onDone?.();
      } else console.warn('[warcon]', r.reason);
    } catch (e) {
      console.warn('[warcon]', e.message);
    }
    setTimeout(run, 60 * 60 * 1000);
  };
  setTimeout(run, 60 * 1000);
}
