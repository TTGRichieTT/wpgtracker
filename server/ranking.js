// Global Wardogs stats from wardogs.tools, with the key its developer gave us (WARDOGS_API_KEY, kept in the host's
// environment). As the developer asked: players are looked up by Steam ID, Discord ID or their wardogs.tools
// "social id" (remembered after the first find), the name search is only a last resort for members who typed
// their in-game name (Name#1234), every request sends our User-Agent, and the data is shown with
// "Data provided by wardogs.tools" and a link.
import { flag, q, one } from './db.js';
import { noteLevelDrop } from './frames.js';

const API = 'https://wardogs.tools/api/player/stats';
const LOCATE = 'https://wardogs.tools/api/leaderboards/locate';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'WPG-Barracks/1.0 (WPG clan app; https://wpg-barracks.onrender.com)' };
const CACHE_MS = 6 * 60 * 60 * 1000;
const NOT_FOUND_MS = 30 * 60 * 1000; // "not found" is only remembered this long (they may link their account any minute)
const FRESH_MS = 60 * 1000; // "Check now" asks again if the last answer is older than this
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
  // Spaces, line breaks or quote marks pasted in with the key would make wardogs.tools refuse it.
  const key = String(process.env.WARDOGS_API_KEY || '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!key) throw new Error('Global Wardogs stats aren\'t set up yet (staff: add WARDOGS_API_KEY in Render)');
  const url = new URL(`${API}/${encodeURIComponent(id)}`);
  url.searchParams.set('key', key);
  return scheduleFetch(url);
}

// Every wardogs.tools request goes through here: one at a time, spaced out, and paused when it says so.
function scheduleFetch(url) {
  const run = async () => {
    const waitUntil = Math.max(lastRequestAt + REQUEST_GAP_MS, retryAfterAt);
    if (waitUntil > Date.now()) await pause(waitUntil - Date.now());
    lastRequestAt = Date.now();
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const seconds = Number(header);
      const retryAt = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : Date.parse(header);
      retryAfterAt = Number.isFinite(retryAt) && retryAt > Date.now() ? retryAt : Date.now() + 60 * 1000;
      throw new Error('WARDOGS stats API is rate-limiting requests; try again later');
    }
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      throw new Error('wardogs.tools didn\'t accept the app\'s key (staff: check WARDOGS_API_KEY in Render matches the key exactly)');
    }
    if (!response.ok) throw new Error(`wardogs.tools answered ${response.status}; try again later`);
    return response.json();
  };
  const request = requestChain.then(run, run);
  requestChain = request.catch(() => {});
  return request;
}

// How long an answer is kept: 6 hours, or 30 minutes for "not found"; when the member presses Check now, 1 minute.
const keepFor = (data, fresh) => (fresh ? FRESH_MS : data === null ? NOT_FOUND_MS : CACHE_MS);

async function statsForId(id, { fresh = false } = {}) {
  if (!playerId(id)) throw new Error('Invalid WARDOGS player ID');
  const cached = responseCache.get(id);
  if (cached && Date.now() - cached.at < keepFor(cached.data, fresh)) return cached.data;
  if (inFlight.has(id)) return inFlight.get(id);
  const pending = (async () => {
    const saved = await one('SELECT response, fetched_at FROM wardogs_api_cache WHERE player_id=$1', [id]);
    if (saved?.fetched_at && Date.now() - new Date(saved.fetched_at).getTime() < keepFor(saved.response, fresh)) {
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

const NOT_FOUND_REASON = 'Not found on wardogs.tools yet: sign in there and link your Wardogs account, or add your in-game name (Name#1234) in Edit profile';
const NO_STATS_REASON = 'Found on wardogs.tools, but it has no stats for you yet';

// "Name#1234" → { name, tag }
function parseName(value) {
  const m = /^\s*(.+?)\s*#\s*(\d{3,6})\s*$/.exec(String(value || ''));
  return m ? { name: m[1], tag: m[2] } : null;
}
// The name search (the developer's /api/leaderboards/locate): only for a member who typed their in-game name and
// wasn't found by Steam ID. Returns their wardogs.tools social id, which is then remembered.
async function socialIdByName(typed) {
  const url = new URL(LOCATE);
  url.searchParams.set('q', typed.name);
  const data = await scheduleFetch(url);
  const list = Array.isArray(data?.candidates) ? data.candidates : [];
  const hit = list.find((c) => String(c.displayName || '').toLowerCase() === typed.name.toLowerCase() && String(c.discriminator) === typed.tag);
  return playerId(hit?.socialId) ? String(hit.socialId) : null;
}

// Found players are re-read every six hours; "not found" is asked again after 30 minutes, or at once
// (well, after a minute) when the member presses Check now (force).
export async function syncRanks(user, { force = false } = {}) {
  if (!/^\d{17}$/.test(user.steam_id || '')) return { ok: false, reason: 'Test account (not a real Steam ID)' };
  const saved = await one('SELECT official, ranks, ranks_synced FROM wardogs_stats WHERE user_id=$1', [user.id]);
  const savedAt = saved?.ranks_synced ? new Date(saved.ranks_synced).getTime() : 0;
  const savedFor = saved?.official ? CACHE_MS : NOT_FOUND_MS;
  if (!force && saved?.ranks?.source === 'wardogs.tools' && Date.now() - savedAt < savedFor) {
    const state = saved.ranks.state;
    const reason = saved.official ? '' : state === 'missing'
      ? NOT_FOUND_REASON
      : NO_STATS_REASON;
    return { ok: !!saved.official, official: !!saved.official, cached: true, state, reason };
  }

  // The remembered social id first, then the Steam ID, then (last resort) the in-game name they typed.
  let data = null;
  if (playerId(saved?.ranks?.socialId)) data = await statsForId(saved.ranks.socialId, { fresh: force });
  if (!data?.stats) data = await statsForId(user.steam_id, { fresh: force });
  const typed = parseName(user.custom_fields?.wardogs_name);
  if (!data?.stats && typed) {
    const socialId = await socialIdByName(typed);
    if (socialId) data = await statsForId(socialId, { fresh: force });
  }
  if (!data?.player || !data?.stats) {
    const state = data?.player ? 'unsynced' : 'missing';
    await saveMissing(user.id, state);
    return { ok: false, state, reason: state === 'missing' ? NOT_FOUND_REASON : NO_STATS_REASON };
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
