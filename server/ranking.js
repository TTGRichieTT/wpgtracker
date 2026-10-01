// Worldwide Wardogs ranks (level, account worth, cash) for members. Used with permission from the
// source site; fetched gently (a few small requests per member per sync) and never shown with its name.
import { q, one } from './db.js';

const BASE = 'https://wardogs.tools/api/leaderboards';
const UA = { 'User-Agent': 'WPG-Barracks/1.0 (clan app, with permission)' };
const BOARDS = ['level', 'worth', 'cash'];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
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

export async function syncRanks(user) {
  const row = await one('SELECT ranks FROM wardogs_stats WHERE user_id=$1', [user.id]);
  const typed = parseName(user.custom_fields?.wardogs_name);
  let known = row?.ranks?.id ? row.ranks : null;
  // Re-find the account if the member changed their in-game name box.
  if (known && typed && (known.name.toLowerCase() !== typed.name.toLowerCase() || known.tag !== typed.tag)) known = null;
  let player = known ? { socialId: known.id, displayName: known.name, discriminator: known.tag } : await findPlayer(user);
  if (!player) return { ok: false, reason: typed ? 'In-game name not found in the rankings' : 'Not found by Steam name — add your in-game name (Name#1234) in Edit profile' };

  const ranks = { id: player.socialId, name: player.displayName, tag: String(player.discriminator), total: await totalPlayers().catch(() => null) };
  for (const by of BOARDS) {
    await pause(300);
    const data = await getJson(`${BASE}/locate?by=${by}&dir=desc&socialId=${encodeURIComponent(player.socialId)}`);
    ranks[by] = Number(data?.position?.rank) || null;
  }
  await q(
    `INSERT INTO wardogs_stats (user_id, ranks, ranks_synced) VALUES ($1,$2,now())
     ON CONFLICT (user_id) DO UPDATE SET ranks=EXCLUDED.ranks, ranks_synced=now()`,
    [user.id, JSON.stringify(ranks)],
  );
  return { ok: true, ...ranks };
}
