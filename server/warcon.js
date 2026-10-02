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
    const name = String(p.name || '').slice(0, 64) || sid;
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
  return { ok: true, players: n };
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
