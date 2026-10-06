// Wardogs stats are fetched only from the owner's keyed stats API, by Steam, social, or Discord ID.
import { flag, q, one } from './db.js';
import { noteLevelDrop } from './frames.js';

const API = 'https://wardogs.tools/api/player/stats';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'WPG-Barracks/1.0 (WPG clan app; https://wpg-barracks.onrender.com)' };
const CACHE_MS = 6 * 60 * 60 * 1000;
const REQUEST_GAP_MS = 10 * 1000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let requestChain = Promise.resolve();
let lastRequestAt = 0;
let retryAfterAt = 0;
const responseCache = new Map();
const inFlight = new Map();

function playerId(value) {
  const id = String(value || '');
  return /^\d{15,22}$/.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function scheduleRequest(id) {
  const run = async () => {
    const key = process.env.WARDOGS_API_KEY;
    if (!key) throw new Error('WARDOGS_API_KEY is not configured');
    const waitUntil = Math.max(lastRequestAt + REQUEST_GAP_MS, retryAfterAt);
    if (waitUntil > Date.now()) await pause(waitUntil - Date.now());
    lastRequestAt = Date.now();
    const url = new URL(`${API}/${encodeURIComponent(id)}`);
    url.searchParams.set('key', key);
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const seconds = Number(header);
      const retryAt = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : Date.parse(header);
      retryAfterAt = Number.isFinite(retryAt) && retryAt > Date.now() ? retryAt : Date.now() + 60 * 1000;
      throw new Error('WARDOGS stats API is rate-limiting requests; try again later');
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`WARDOGS stats API returned ${response.status}`);
    return response.json();
  };
  const request = requestChain.then(run, run);
  requestChain = request.catch(() => {});
  return request;
}

async function statsForId(id) {
  if (!playerId(id)) throw new Error('Invalid WARDOGS player ID');
  const cached = responseCache.get(id);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  if (inFlight.has(id)) return inFlight.get(id);
  const pending = (async () => {
    const saved = await one('SELECT response, fetched_at FROM wardogs_api_cache WHERE player_id=$1', [id]);
    if (saved?.fetched_at && Date.now() - new Date(saved.fetched_at).getTime() < CACHE_MS) {
      if (responseCache.size > 5000) responseCache.clear();
      const item = { at: new Date(saved.fetched_at).getTime(), data: saved.response };
      responseCache.set(id, item);
      return saved.response;
    }
    const data = await scheduleRequest(id);
    if (responseCache.size > 5000) responseCache.clear();
    const item = { at: Date.now(), data };
    const socialId = data?.player?.socialId;
    await q(
      `INSERT INTO wardogs_api_cache (player_id, response, fetched_at)
       VALUES ($1,$2,now()) ON CONFLICT (player_id) DO UPDATE SET response=EXCLUDED.response, fetched_at=now()`,
      [id, data === null ? null : JSON.stringify(data)],
    );
    if (playerId(socialId) && socialId !== id) {
      await q(
        `INSERT INTO wardogs_api_cache (player_id, response, fetched_at)
         VALUES ($1,$2,now()) ON CONFLICT (player_id) DO UPDATE SET response=EXCLUDED.response, fetched_at=now()`,
        [socialId, JSON.stringify(data)],
      );
    }
    await q("DELETE FROM wardogs_api_cache WHERE fetched_at < now() - interval '1 day'");
    responseCache.set(id, item);
    if (playerId(socialId)) responseCache.set(socialId, item);
    return data;
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, pending);
  return pending;
}

const numberOrNull = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

function shape(data) {
  const player = data.player;
  const stats = data.stats;
  const worth = stats.worth || {};
  const rank = stats.rank || {};
  const sync = stats.sync || {};
  const roles = Object.fromEntries((Array.isArray(stats.roles) ? stats.roles : []).map((role) => {
    const key = String(role.roleId || '').toLowerCase();
    return [key === 'infantry' ? 'assault' : key, { level: numberOrNull(role.level), xp: numberOrNull(role.totalXp) }];
  }).filter(([key]) => key));
  const position = numberOrNull(rank.position);
  return {
    official: {
      wardogLevel: numberOrNull(stats.wardogLevel),
      careerXp: null,
      cash: numberOrNull(stats.cash),
      gold: numberOrNull(stats.gold),
      unlocks: numberOrNull(worth.unlockedCount),
      worth: numberOrNull(worth.total),
      worthDetails: {
        cash: numberOrNull(worth.cash),
        unlockValue: numberOrNull(worth.unlockValue),
        goldValue: numberOrNull(worth.goldValue),
        vaultValue: numberOrNull(worth.vaultValue),
        cosmeticValue: numberOrNull(worth.cosmeticValue),
        unlockedCount: numberOrNull(worth.unlockedCount),
      },
      rates: {
        xpPerMinute: numberOrNull(stats.rates?.xpPerMinute),
        cashPerMinute: numberOrNull(stats.rates?.cashPerMinute),
      },
      roles,
      achievements: null,
      syncedAt: sync.syncedAt || null,
      lastPolledAt: sync.lastPolledAt || null,
      status: sync.status || null,
    },
    ranks: {
      source: 'wardogs.tools',
      socialId: player.socialId,
      displayName: player.displayName || '',
      discriminator: player.discriminator || '',
      position,
      level: position,
      total: numberOrNull(rank.total),
      bracket: numberOrNull(rank.bracket),
      change: {
        places: numberOrNull(rank.change?.places),
        since: rank.change?.since || null,
      },
      polled_at: sync.lastPolledAt || sync.syncedAt || null,
      state: sync.status || null,
    },
  };
}

async function saveMissing(userId, state) {
  await q(
    `INSERT INTO wardogs_stats (user_id, official, official_synced, ranks, ranks_synced)
     VALUES ($1,NULL,NULL,$2,now())
     ON CONFLICT (user_id) DO UPDATE SET official=NULL, official_synced=NULL, ranks=EXCLUDED.ranks, ranks_synced=now()`,
    [userId, JSON.stringify({ source: 'wardogs.tools', state })],
  );
}

// Member responses, including "not found", are cached in the database for six hours.
export async function syncRanks(user) {
  if (!/^\d{17}$/.test(user.steam_id || '')) return { ok: false, reason: 'Test account (not a real Steam ID)' };
  const saved = await one('SELECT official, ranks, ranks_synced FROM wardogs_stats WHERE user_id=$1', [user.id]);
  const savedAt = saved?.ranks_synced ? new Date(saved.ranks_synced).getTime() : 0;
  if (saved?.ranks?.source === 'wardogs.tools' && Date.now() - savedAt < CACHE_MS) {
    const state = saved.ranks.state;
    const reason = saved.official ? '' : state === 'missing'
      ? 'No WARDOGS stats found for this Steam ID'
      : 'WARDOGS returned no stats for this account yet';
    return { ok: !!saved.official, official: !!saved.official, cached: true, state, reason };
  }

  const id = playerId(saved?.ranks?.socialId) ? saved.ranks.socialId : user.steam_id;
  const data = await statsForId(id);
  if (!data?.player || !data?.stats) {
    const state = data?.player ? 'unsynced' : 'missing';
    await saveMissing(user.id, state);
    return { ok: false, state, reason: state === 'missing' ? 'No WARDOGS stats found for this Steam ID' : 'WARDOGS returned no stats for this account yet' };
  }

  const { official, ranks } = shape(data);
  const before = (await one(
    "SELECT (official->>'wardogLevel')::int AS lvl FROM wardogs_stats WHERE user_id=$1 AND ranks->>'source'='wardogs.tools' AND official ? 'syncedAt'",
    [user.id],
  ))?.lvl || 0;
  if (before >= 10 && official.wardogLevel !== null && official.wardogLevel <= before / 2) noteLevelDrop(user.id);
  await q(
    `INSERT INTO wardogs_stats (user_id, official, official_synced, ranks, ranks_synced) VALUES ($1,$2,now(),$3,now())
     ON CONFLICT (user_id) DO UPDATE SET official=EXCLUDED.official, official_synced=now(), ranks=EXCLUDED.ranks, ranks_synced=now()`,
    [user.id, JSON.stringify(official), JSON.stringify(ranks)],
  );
  return { ok: true, official: true, state: ranks.state };
}

// Discord commands for people outside the app use their Discord ID directly; no name lookup is made.
export async function trackerByDiscord(discordId) {
  if (!/^\d{15,22}$/.test(String(discordId || ''))) return null;
  if (!(await flag('tracker_enabled'))) throw new Error('Global Wardogs stats are switched off in settings');
  const data = await statsForId(String(discordId));
  if (!data?.player || !data?.stats) return null;
  const { official, ranks } = shape(data);
  return { name: data.player.displayName || 'WARDOGS player', steamId: '', official, ranks };
}
