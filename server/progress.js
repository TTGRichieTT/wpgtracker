// WPG server progression from the Discord bot (its read-only progress API). The bot is the source of
// truth for WPG XP and WPG rank (Recruit I … Wardog X); the app copies them every 5 minutes and shows
// them exactly as the bot has them, so Discord and the app always agree. Nothing is worked out here.
// Uses the same key as WarCon (WARCON_API_KEY); WPG_PROGRESS_URL can change the address.
import { q } from './db.js';
import { bus } from './bus.js';

const BASE = (process.env.WPG_PROGRESS_URL || 'https://warcon.taild5e8b5.ts.net:10000').replace(/\/+$/, '');
const KEY = () => process.env.WPG_PROGRESS_KEY || process.env.WARCON_API_KEY || '';

export async function syncProgress() {
  if (!KEY()) return { ok: false, reason: 'WARCON_API_KEY is not set' };
  const res = await fetch(`${BASE}/v1/progress`, {
    headers: { Authorization: `Bearer ${KEY()}` },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401) throw new Error('The bot progress API rejected the key');
  if (!res.ok) throw new Error(`The bot progress API returned ${res.status}`);
  const data = await res.json();
  const players = Array.isArray(data?.players) ? data.players : null;
  if (!players) throw new Error('The bot progress API sent no player list');

  // Ranks before this sync, to spot rank-ups (new players are never announced, so a first sync is quiet).
  const before = new Map((await q('SELECT steam_id, rank_level FROM server_progress')).map((r) => [r.steam_id, r.rank_level]));
  let n = 0;
  for (const p of players) {
    const sid = String(p.steam_id || '');
    if (!/^\d{17}$/.test(sid)) continue;
    const level = Math.min(200, Math.max(1, Math.round(Number(p.rank_level) || 1)));
    if (before.has(sid) && level > before.get(sid)) {
      bus.emit('announce', { type: 'wpgrank', steamId: sid, name: String(p.name || ''), rank: p.rank_name, xp: p.wpg_xp });
    }
    await q(
      `INSERT INTO server_progress (steam_id, bot_name, xp, rank_level, rank_name, synced_at) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (steam_id) DO UPDATE SET bot_name=EXCLUDED.bot_name, xp=EXCLUDED.xp, rank_level=EXCLUDED.rank_level,
         rank_name=EXCLUDED.rank_name, synced_at=now()`,
      [sid, String(p.name || '').slice(0, 64), Math.max(0, Math.round(Number(p.wpg_xp) || 0)), level, String(p.rank_name || '').slice(0, 40)],
    );
    n++;
  }
  bus.emit('server:board', null);
  return { ok: true, players: n };
}

export function startProgressSync() {
  if (!KEY()) {
    console.log('[WPG] WARCON_API_KEY not set: WPG rank / WPG XP from the bot will not sync.');
    return;
  }
  const run = async () => {
    try {
      const r = await syncProgress();
      if (!r.ok) console.warn('[progress]', r.reason);
    } catch (e) {
      console.warn('[progress]', e.message);
    }
    setTimeout(run, 5 * 60 * 1000);
  };
  setTimeout(run, 30 * 1000);
}
