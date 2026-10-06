// Global Wardogs stats from WARDOGS Tracker (https://wardogstracker.gg), through its free public stats API
// (https://wardogstracker.gg/developers). Used as its terms allow: credited with a link wherever the stats are
// shown, a gentle request rate (well under its 120 a minute, one request at a time), answers kept for a while
// rather than asked again, and never presented as official. WARDOGS Tracker is a fan site, not BULKHEAD.
//  - Per member, by Steam ID: Wardog level, career XP, cash, gold, unlocks, each class's level and XP, achievements,
//    world rank by level, when they last synced on WARDOGS Tracker, and their WARDOGS Tracker / Twitch links.
//  - World ranks for career XP, cash, gold and unlocks come from its leaderboards, read once an hour.
// It only knows players who have signed in on WARDOGS Tracker and synced their stats there. Private profiles
// and hidden players are never returned; cash and gold are null for players who hide them.
import { q, one } from './db.js';

export const TRACKER = { name: 'WARDOGS Tracker', url: 'https://wardogstracker.gg' };
const API = 'https://wardogstracker.gg/api/v1';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'WPG-Barracks/1.0 (WPG clan app; https://wpg-barracks.onrender.com)' };
const GAP_MS = 700; // between requests: at most ~85 a minute, under the 120 allowed
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// One request at a time, spaced out; a 429 waits as long as the site asks (Retry-After) and tries once more.
let chain = Promise.resolve();
let last = 0;
function get(path) {
  const run = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = last + GAP_MS - Date.now();
      if (wait > 0) await pause(wait);
      last = Date.now();
      const res = await fetch(`${API}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      if (res.status === 429 && attempt === 0) {
        await pause(Math.min(60, Number(res.headers.get('retry-after')) || 10) * 1000);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`WARDOGS Tracker answered ${res.status}`);
      return res.json();
    }
    throw new Error('WARDOGS Tracker is busy (too many requests); try again in a minute');
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// ---------- World ranks from the leaderboards (read once an hour) ----------
const BOARDS = ['xp', 'cash', 'gold', 'unlocks'];
let boards = { at: 0, total: null, ranks: {} };
let refreshing = null;
async function readBoards() {
  const ranks = {};
  let total = null;
  for (const sort of BOARDS) {
    const map = new Map();
    for (let offset = 0; offset < 20000; offset += 100) {
      const page = await get(`/leaderboard?sort=${sort}&limit=100&offset=${offset}`);
      const rows = Array.isArray(page?.players) ? page.players : [];
      total = Number(page?.total) || total;
      for (const r of rows) if (/^\d{17}$/.test(String(r.steamId))) map.set(String(r.steamId), Number(r.rank) || null);
      if (rows.length < 100) break;
    }
    ranks[sort] = map;
  }
  boards = { at: Date.now(), total, ranks };
}
// Starts a refresh in the background when the last one is over an hour old (members' syncs never wait for it).
function boardRanks(steamId) {
  if (Date.now() - boards.at > 3600 * 1000 && !refreshing) {
    refreshing = readBoards().catch((e) => console.warn('[tracker] leaderboards', e.message)).finally(() => { refreshing = null; });
  }
  return { total: boards.total, ...Object.fromEntries(BOARDS.map((b) => [b, boards.ranks[b]?.get(steamId) || null])) };
}

// ---------- One player ----------
const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
// A WARDOGS Tracker player → the stats shape the rest of the app uses (wardogs_stats.official / .ranks).
function shape(p) {
  const s = p.stats || {};
  const roles = Object.fromEntries(Object.entries(s.roles || {}).map(([k, v]) => [k.toLowerCase(), { level: n(v?.level) || 0, xp: n(v?.xp) }]));
  return {
    official: {
      wardogLevel: n(s.wardogLevel) || 0, careerXp: n(s.careerXp), cash: n(s.cash), gold: n(s.gold), unlocks: n(s.unlocks),
      roles, achievements: n(p.achievements), syncedAt: s.syncedAt || null,
    },
    ranks: {
      source: 'wardogstracker', level: n(p.leaderboardRank), polled_at: s.syncedAt || null,
      profile_url: /^https:\/\/wardogstracker\.gg\//.test(p.profileUrl || '') ? p.profileUrl : `${TRACKER.url}/profile/${p.steamId}`,
      twitch: /^https:\/\/(www\.)?twitch\.tv\/[\w-]+$/i.test(p.twitch || '') ? p.twitch : '',
      // When the member last synced on WARDOGS Tracker: more than a week ago = "old" (they should sync there again).
      state: s.syncedAt && Date.now() - Date.parse(s.syncedAt) > 7 * 86400 * 1000 ? 'old' : 'syncing',
    },
  };
}

// Reads the member's stats from WARDOGS Tracker and saves them. { ok, official, state, reason? }
export async function syncRanks(user) {
  if (!/^\d{17}$/.test(user.steam_id || '')) return { ok: false, reason: 'Test account (not a real Steam ID)' };
  const data = await get(`/players/${user.steam_id}`);
  const p = data?.player;
  if (!p) {
    // Not on WARDOGS Tracker (or a private profile): note why there are no stats.
    await saveRanks(user.id, { source: 'wardogstracker', state: 'missing' });
    return { ok: false, state: 'missing', reason: 'Not on WARDOGS Tracker yet: sign in there once with Steam and sync your stats' };
  }
  if (!p.stats) {
    await saveRanks(user.id, { source: 'wardogstracker', state: 'unsynced', profile_url: `${TRACKER.url}/profile/${user.steam_id}` });
    return { ok: false, state: 'unsynced', reason: 'Signed in on WARDOGS Tracker, but stats not synced there yet: press Sync on your WARDOGS Tracker profile' };
  }
  const { official, ranks } = shape(p);
  Object.assign(ranks, boardRanks(user.steam_id));
  await q(
    `INSERT INTO wardogs_stats (user_id, official, official_synced, ranks, ranks_synced) VALUES ($1,$2,now(),$3,now())
     ON CONFLICT (user_id) DO UPDATE SET official=EXCLUDED.official, official_synced=now(), ranks=EXCLUDED.ranks, ranks_synced=now()`,
    [user.id, JSON.stringify(official), JSON.stringify(ranks)],
  );
  return { ok: true, official: true, state: ranks.state };
}
// Not (or no longer) on WARDOGS Tracker. Stats saved earlier from the old source (wardogs.tools, which the clan may no
// longer use) are cleared then, so only WARDOGS Tracker figures are ever shown; WARDOGS Tracker's own are kept.
async function saveRanks(userId, ranks) {
  await q(
    `INSERT INTO wardogs_stats (user_id, ranks, ranks_synced) VALUES ($1,$2,now())
     ON CONFLICT (user_id) DO UPDATE SET ranks=EXCLUDED.ranks, ranks_synced=now()`,
    [userId, JSON.stringify(ranks)],
  );
  await q("UPDATE wardogs_stats SET official=NULL, official_synced=NULL WHERE user_id=$1 AND official IS NOT NULL AND NOT (official ? 'syncedAt')", [userId]);
}

// For the Discord bot: a player who isn't in the app, by the Discord account they linked on WARDOGS Tracker.
export async function trackerByDiscord(discordId) {
  if (!/^\d{15,22}$/.test(String(discordId || ''))) return null;
  const data = await get(`/players/by-discord/${discordId}`).catch(() => null);
  return data?.player?.stats ? { name: data.player.name, steamId: data.player.steamId, ...shape(data.player) } : null;
}

// Members whose saved stats are older than this are re-read by the regular sync (steam.js).
export const STALE_MS = 30 * 60 * 1000;
export async function needsRefresh(userId) {
  const r = await one('SELECT ranks_synced FROM wardogs_stats WHERE user_id=$1', [userId]);
  return !r?.ranks_synced || Date.now() - new Date(r.ranks_synced).getTime() > STALE_MS;
}
