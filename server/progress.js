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

  // What we had before this sync: to spot rank-ups (new players are never announced, so a first sync is
  // quiet) and to write only the players whose numbers changed — in one database trip, not one per player.
  const before = new Map((await q('SELECT steam_id, bot_name, xp, rank_level, rank_name FROM server_progress')).map((r) => [r.steam_id, r]));
  const changed = [];
  let n = 0;
  for (const p of players) {
    const sid = String(p.steam_id || '');
    if (!/^\d{17}$/.test(sid)) continue;
    n++;
    const row = {
      steam_id: sid,
      bot_name: String(p.name || '').slice(0, 64),
      xp: Math.max(0, Math.round(Number(p.wpg_xp) || 0)),
      rank_level: Math.min(200, Math.max(1, Math.round(Number(p.rank_level) || 1))),
      rank_name: String(p.rank_name || '').slice(0, 40),
    };
    const old = before.get(sid);
    if (old && row.rank_level > old.rank_level) {
      bus.emit('announce', { type: 'wpgrank', steamId: sid, name: row.bot_name, rank: row.rank_name, xp: row.xp });
    }
    if (!old || old.bot_name !== row.bot_name || old.xp !== row.xp || old.rank_level !== row.rank_level || old.rank_name !== row.rank_name) changed.push(row);
  }
  if (changed.length) {
    await q(
      `INSERT INTO server_progress (steam_id, bot_name, xp, rank_level, rank_name, synced_at)
       SELECT steam_id, bot_name, xp, rank_level, rank_name, now()
         FROM jsonb_to_recordset($1::jsonb) AS x(steam_id text, bot_name text, xp int, rank_level int, rank_name text)
       ON CONFLICT (steam_id) DO UPDATE SET bot_name=EXCLUDED.bot_name, xp=EXCLUDED.xp, rank_level=EXCLUDED.rank_level,
         rank_name=EXCLUDED.rank_name, synced_at=now()`,
      [JSON.stringify(changed)],
    );
    bus.emit('server:board', null);
  }
  // When the bot's list was last read (shown as "updated … ago"), even if nothing changed.
  await q("INSERT INTO settings (key, value) VALUES ('_progress_synced', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [new Date().toISOString()]);
  return { ok: true, players: n, changed: changed.length };
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
