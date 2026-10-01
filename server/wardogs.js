// Wardogs stats from WARDOGS Tracker (https://wardogstracker.gg) — free public API, no key.
// Their terms ask for a visible credit + link, which the app shows next to these stats.
import { q, flag, setting } from './db.js';

const BASE = 'https://wardogstracker.gg/api/v1';

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'WPG-Barracks/1.0' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`WARDOGS Tracker ${path} returned ${res.status}`);
  return res.json();
}

let serverBoard = { key: '', at: 0, players: new Map() };

async function serverLeaderboard(slug) {
  if (serverBoard.key === slug && Date.now() - serverBoard.at < 5 * 60 * 1000) return serverBoard.players;
  const data = await get(`/servers/${encodeURIComponent(slug)}/leaderboard?range=all&limit=100`);
  const players = new Map((data?.players || []).map((p) => [String(p.steamId), p]));
  serverBoard = { key: slug, at: Date.now(), players };
  return players;
}

// How many players are on the tracker's leaderboard (its ranks only count those players). Cached 1 hour.
let totalCache = { at: 0, n: null };
async function trackerPlayerCount() {
  if (Date.now() - totalCache.at < 3600 * 1000) return totalCache.n;
  const data = await get('/leaderboard?limit=1');
  totalCache = { at: Date.now(), n: Number(data?.total) || null };
  return totalCache.n;
}

export async function syncWardogs(user) {
  if (!(await flag('tracker_enabled'))) return { ok: false, reason: 'WARDOGS Tracker is switched off in settings' };
  if (!/^\d{17}$/.test(user.steam_id)) return { ok: false, reason: 'Test account (not a real Steam ID)' };

  const result = { ok: true, official: false, server: false };
  const data = await get(`/players/${user.steam_id}`);
  if (data?.player) {
    const p = data.player;
    const total = await trackerPlayerCount().catch(() => null);
    const official = { ...(p.stats || {}), achievements: p.achievements, leaderboardRank: p.leaderboardRank, leaderboardTotal: total, trackerUrl: p.profileUrl };
    await q(
      `INSERT INTO wardogs_stats (user_id, official, official_synced) VALUES ($1,$2,now())
       ON CONFLICT (user_id) DO UPDATE SET official=EXCLUDED.official, official_synced=now()`,
      [user.id, JSON.stringify(official)],
    );
    result.official = true;
    // Without a Steam API key this is the only place we can get a picture.
    if (!user.avatar && p.avatarUrl) {
      await q("UPDATE users SET avatar=$2 WHERE id=$1 AND avatar=''", [user.id, String(p.avatarUrl).slice(0, 500)]);
    }
  }

  const slug = String((await setting('tracker_server')) || '').trim();
  if (slug) {
    const players = await serverLeaderboard(slug);
    const row = players.get(user.steam_id);
    const server = row
      ? { rank: row.rank, kills: row.kills, deaths: row.deaths, kd: row.kd, headshots: row.headshots, longestKillM: row.longestKillM, topWeapon: row.topWeapon }
      : null;
    await q(
      `INSERT INTO wardogs_stats (user_id, server, server_synced) VALUES ($1,$2,now())
       ON CONFLICT (user_id) DO UPDATE SET server=EXCLUDED.server, server_synced=now()`,
      [user.id, server ? JSON.stringify(server) : null],
    );
    result.server = !!server;
  }
  return result;
}
