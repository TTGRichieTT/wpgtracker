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

  let n = 0;
  for (const p of players) {
    const sid = String(p.steamId || '');
    if (!/^\d{17}$/.test(sid)) continue;
    const name = String(p.name || '').trim().slice(0, 64) || sid;
    const num = (v) => Math.max(0, Math.round(Number(v) || 0));
    const seen = p.lastSeen && !Number.isNaN(Date.parse(p.lastSeen)) ? new Date(p.lastSeen).toISOString() : null;
    await q(
      `INSERT INTO server_players (server_id, steam_id, name, kills, deaths, matches, playtime_s, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (server_id, steam_id) DO UPDATE SET
         name = CASE WHEN EXCLUDED.last_seen >= COALESCE(server_players.last_seen, EXCLUDED.last_seen) THEN EXCLUDED.name ELSE server_players.name END,
         kills=GREATEST(server_players.kills, EXCLUDED.kills), deaths=GREATEST(server_players.deaths, EXCLUDED.deaths),
         matches=GREATEST(server_players.matches, EXCLUDED.matches), playtime_s=GREATEST(server_players.playtime_s, EXCLUDED.playtime_s),
         last_seen=GREATEST(server_players.last_seen, EXCLUDED.last_seen)`,
      [server.id, sid, name, num(p.kills), num(p.deaths), num(p.sessions), num(p.playtimeSeconds), seen],
    );
    // A row imported earlier by name only (from a screenshot) is the same player: fold it in.
    const byName = await one('SELECT * FROM server_players WHERE server_id=$1 AND steam_id=$2', [server.id, `name:${name}`]);
    if (byName) {
      await q(
        `UPDATE server_players SET matches=GREATEST(matches,$3), playtime_s=GREATEST(playtime_s,$4), wins=GREATEST(wins,$5), losses=GREATEST(losses,$6)
          WHERE server_id=$1 AND steam_id=$2`,
        [server.id, sid, byName.matches, byName.playtime_s, byName.wins, byName.losses],
      );
      await q('DELETE FROM server_players WHERE server_id=$1 AND steam_id=$2', [server.id, `name:${name}`]);
    }
    n++;
  }
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
    for (const s of page) {
      const sid = String(s.steamId || '');
      if (!/^\d{17}$/.test(sid) || s.id === undefined || s.id === null) continue;
      const when = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
      await q(
        `INSERT INTO server_sessions (id, steam_id, name, joined_at, last_seen, left_at, kills, deaths) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, last_seen=EXCLUDED.last_seen, left_at=EXCLUDED.left_at,
           kills=EXCLUDED.kills, deaths=EXCLUDED.deaths`,
        [String(s.id), sid, String(s.name || '').slice(0, 64), when(s.joinedAt), when(s.lastSeen), when(s.leftAt),
          Math.max(0, Number(s.kills) || 0), Math.max(0, Number(s.deaths) || 0)],
      );
      n++;
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
