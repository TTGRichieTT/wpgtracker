// Global Wardogs stats and worldwide ranks for members: Wardog level, cash, gold, account worth, XP,
// unlocks and each class level. Used with permission from the source site and never shown with its
// name. Fetched gently: a few small lookups per member, and the 1000-player blocks are shared and cached.
import { q, one } from './db.js';
import { bus } from './bus.js';

const BASE = 'https://wardogs.tools/api/leaderboards';
const UA = { 'User-Agent': 'WPG-Barracks/1.0 (clan app, with permission)' };
const BOARDS = ['level', 'worth', 'cash'];
// Class order in each leaderboard row; "infantry" is our "assault".
const ROW_ROLES = ['assault', 'medic', 'recon', 'support', 'driver', 'pilot'];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Rankings returned ${res.status}`);
  return res.json();
}

let totalCache = { at: 0, n: null };
async function totalPlayers() {
  if (Date.now() - totalCache.at < 3600 * 1000) return totalCache.n;
  const data = await getJson(`${BASE}?by=level&dir=desc`);
  totalCache = { at: Date.now(), n: Number(data?.totalRanked) || null };
  return totalCache.n;
}

// The level board comes in blocks of 1000 players; members in the same block share one download.
const blockCache = new Map();
async function levelBlock(block) {
  const hit = blockCache.get(block);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit.rows; // short: just enough to share during an "everyone" sync
  const data = await getJson(`${BASE}?by=level&dir=desc&block=${block}`);
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  blockCache.set(block, { at: Date.now(), rows });
  return rows;
}

// One leaderboard row → the stats shape the rest of the app uses.
function rowStats(r) {
  const n = (v) => (v === null || v === undefined ? null : Number(v) || 0);
  const roles = Object.fromEntries(ROW_ROLES.map((role, i) => [role, { level: n(r[6 + i]) || 0 }]));
  return {
    wardogLevel: n(r[3]) || 0,
    cash: n(r[4]) || 0,
    gold: n(r[5]) || 0,
    roles,
    worth: n(r[6 + ROW_ROLES.length + 2]),
    unlocks: n(r[6 + ROW_ROLES.length + 3]),
    careerXp: n(r[6 + ROW_ROLES.length + 4]),
  };
}

// "Name#1234" → { name, tag }
function parseName(v) {
  const m = /^\s*(.+?)\s*#\s*(\d{3,6})\s*$/.exec(String(v || ''));
  return m ? { name: m[1], tag: m[2] } : null;
}

// Finds the member's in-game account: the "Wardogs in-game name" profile box if filled in
// (exact name + tag), otherwise their Steam name if exactly one player has it.
async function findPlayer(user) {
  const typed = parseName(user.custom_fields?.wardogs_name);
  const name = typed?.name || user.persona_name;
  const data = await getJson(`${BASE}/locate?by=level&dir=desc&q=${encodeURIComponent(name)}`);
  const same = (data?.candidates || []).filter((c) => String(c.displayName).toLowerCase() === name.toLowerCase());
  if (typed) return same.find((c) => String(c.discriminator) === typed.tag) || null;
  return same.length === 1 ? same[0] : null;
}

// How the source is reading this player's account: wardogs.tools re-reads linked accounts every
// 15 minutes, but stops when the player's link to WARDOGS expires ("paused"), and the figures then go
// stale. state: syncing | delayed | stalled | paused | resuming | unavailable. Null if it can't be read.
const SITE = 'https://wardogs.tools';
async function linkStatus(socialId) {
  const res = await fetch(`${SITE}/player/${encodeURIComponent(socialId)}`, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const html = await res.text();
  const m = /lastPolledAt\\?":\\?"([0-9T:.\-Z]+)\\?",\\?"state\\?":\\?"([a-z]+)/.exec(html);
  return m ? { polled_at: m[1], state: m[2] } : null;
}
// Link problems members need to fix themselves (by linking again on the source site).
export const STALE_STATES = ['paused', 'stalled', 'unavailable'];
const STATUS_EVERY_MS = 3 * 3600 * 1000;

// Tells a member (Discord DM + app notice) when their link has stopped working, then once more after
// 3 days if it still hasn't been fixed, then not again until it has been fixed. "Stalled" can sort itself
// out, so it only counts once nothing has come through for 12 hours. Updates `ranks` (saved by the caller).
const REMIND_AFTER_MS = 3 * 24 * 3600 * 1000;
function linkAlert(user, ranks, known) {
  const polledAgo = Date.now() - (Date.parse(ranks.polled_at || '') || Date.now());
  const broken = ranks.state === 'paused' || ranks.state === 'unavailable' || (ranks.state === 'stalled' && polledAgo > 12 * 3600 * 1000);
  if (!broken) return; // working (or unknown): nothing carried over, so a later expiry alerts again
  ranks.alerted_at = known?.alerted_at || null;
  ranks.reminded = !!known?.reminded;
  const now = Date.now();
  let kind = null;
  if (!ranks.alerted_at) kind = 'first';
  else if (!ranks.reminded && now - Date.parse(ranks.alerted_at) > REMIND_AFTER_MS) kind = 'reminder';
  if (!kind) return;
  if (kind === 'first') ranks.alerted_at = new Date(now).toISOString();
  else ranks.reminded = true;
  bus.emit('wardogs:link', { userId: user.id, state: ranks.state, polled_at: ranks.polled_at, reminder: kind === 'reminder' });
}

// Fetches the member's global stats and world ranks and saves them. { ok, official, reason? }
// force: also re-check the link status now (when the member presses Sync stats / Find my stats).
export async function syncRanks(user, { force = false } = {}) {
  const row = await one('SELECT ranks FROM wardogs_stats WHERE user_id=$1', [user.id]);
  const typed = parseName(user.custom_fields?.wardogs_name);
  let known = row?.ranks?.id ? row.ranks : null;
  // Re-find the account if the member changed their in-game name box.
  if (known && typed && (known.name.toLowerCase() !== typed.name.toLowerCase() || known.tag !== typed.tag)) known = null;
  const player = known ? { socialId: known.id, displayName: known.name, discriminator: known.tag } : await findPlayer(user);
  if (!player) return { ok: false, reason: typed ? 'In-game name not found in the rankings' : 'Not found by Steam name — add your in-game name (Name#1234) in Edit profile' };

  const ranks = { id: player.socialId, name: player.displayName, tag: String(player.discriminator), total: await totalPlayers().catch(() => null) };
  // Link status: re-checked every 3 hours (or now if asked); otherwise the last result is kept.
  const sameAccount = known && known.id === player.socialId;
  const checkedAt = sameAccount ? Date.parse(known.status_checked || '') || 0 : 0;
  if (force || Date.now() - checkedAt > STATUS_EVERY_MS) {
    const st = await linkStatus(player.socialId).catch(() => null);
    if (st) Object.assign(ranks, st, { status_checked: new Date().toISOString() });
    else if (sameAccount) Object.assign(ranks, { polled_at: known.polled_at, state: known.state, status_checked: known.status_checked });
  } else if (sameAccount) {
    Object.assign(ranks, { polled_at: known.polled_at, state: known.state, status_checked: known.status_checked });
  }
  linkAlert(user, ranks, sameAccount ? known : null);
  let offset = null;
  for (const by of BOARDS) {
    await pause(300);
    const data = await getJson(`${BASE}/locate?by=${by}&dir=desc&socialId=${encodeURIComponent(player.socialId)}`);
    ranks[by] = Number(data?.position?.rank) || null;
    if (by === 'level' && Number.isFinite(Number(data?.position?.offset))) offset = Number(data.position.offset);
  }

  let official = null;
  if (offset !== null) {
    // Positions shift as players level up, so a player near the edge of a 1000-player block can be in
    // the next or previous one by the time we read it. Look there too, and re-download a stale block.
    const home = Math.floor(offset / 1000);
    const tries = [[home, false], [home, true], [home + 1, false], [home - 1, false]].filter(([b]) => b >= 0);
    for (const [block, fresh] of tries) {
      if (fresh) blockCache.delete(block);
      const r = (await levelBlock(block)).find((x) => x[0] === player.socialId);
      if (r) { official = rowStats(r); break; }
    }
  }
  await q(
    `INSERT INTO wardogs_stats (user_id, ranks, ranks_synced) VALUES ($1,$2,now())
     ON CONFLICT (user_id) DO UPDATE SET ranks=EXCLUDED.ranks, ranks_synced=now()`,
    [user.id, JSON.stringify(ranks)],
  );
  if (official) {
    await q(
      `INSERT INTO wardogs_stats (user_id, official, official_synced) VALUES ($1,$2,now())
       ON CONFLICT (user_id) DO UPDATE SET official=EXCLUDED.official, official_synced=now()`,
      [user.id, JSON.stringify(official)],
    );
  }
  return { ok: true, official: !!official, ...ranks };
}
