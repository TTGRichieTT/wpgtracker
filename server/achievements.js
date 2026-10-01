// Steam achievements as medals. Uses Steam's public profile pages, so no API key is needed
// (the member's Steam "Game details" must be public).
import { q, one } from './db.js';
import { bus } from './bus.js';

const tag = (block, name) => {
  const m = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(block);
  return m ? m[1].trim() : '';
};
const steamImg = (u) => (/^https:\/\/[a-z0-9.-]*steamstatic\.com\//.test(u) ? u.slice(0, 300) : '');

export function parseAchievementsXml(xml) {
  const items = [];
  let order = 0;
  for (const [, closed, body] of String(xml).matchAll(/<achievement closed="(\d)">([\s\S]*?)<\/achievement>/g)) {
    const api = tag(body, 'apiname').toLowerCase();
    if (!api) continue;
    const ts = Number(tag(body, 'unlockTimestamp'));
    items.push({
      api_name: api.slice(0, 120),
      name: tag(body, 'name').slice(0, 120),
      description: tag(body, 'description').slice(0, 300),
      icon: steamImg(tag(body, 'iconClosed')),
      icon_gray: steamImg(tag(body, 'iconOpen')),
      unlocked: closed === '1',
      unlocked_at: closed === '1' && ts > 0 ? new Date(ts * 1000) : null,
      sort_order: (order += 10),
    });
  }
  const hours = Number(tag(String(xml), 'hoursPlayed'));
  return { items, hours: Number.isFinite(hours) ? hours : null, private: /<privacyState>(private|friendsonly)/i.test(xml) };
}

// How rare each achievement is (share of all players), refreshed at most once a day per game.
const percentAt = new Map();
async function refreshPercents(appId) {
  if (Date.now() - (percentAt.get(appId) || 0) < 24 * 3600 * 1000) return;
  percentAt.set(appId, Date.now());
  const r = await fetch(`https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appId}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return;
  const list = (await r.json())?.achievementpercentages?.achievements || [];
  for (const a of list) {
    await q('UPDATE steam_achievements SET percent=$3 WHERE app_id=$1 AND api_name=$2', [appId, String(a.name).toLowerCase(), Number(a.percent) || 0]);
  }
}

// Returns { ok, unlocked, total, hours } for one game; announces newly earned medals.
export async function syncAchievements(user, game) {
  const res = await fetch(`https://steamcommunity.com/profiles/${user.steam_id}/stats/${game.app_id}/achievements/?xml=1`, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'WPG-Barracks/1.0' },
  });
  if (!res.ok) return { ok: false, reason: `Steam returned ${res.status}` };
  const parsed = parseAchievementsXml(await res.text());
  if (!parsed.items.length) return { ok: false, reason: parsed.private ? 'Steam game details are private' : 'No achievements found' };

  for (const a of parsed.items) {
    await q(
      `INSERT INTO steam_achievements (app_id, api_name, name, description, icon, icon_gray, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (app_id, api_name) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
         icon=EXCLUDED.icon, icon_gray=EXCLUDED.icon_gray, sort_order=EXCLUDED.sort_order`,
      [game.app_id, a.api_name, a.name, a.description, a.icon, a.icon_gray, a.sort_order],
    );
  }
  await refreshPercents(game.app_id).catch(() => {});

  const had = await q('SELECT api_name FROM user_achievements WHERE user_id=$1 AND app_id=$2', [user.id, game.app_id]);
  const firstSync = !(await one('SELECT 1 FROM user_games WHERE user_id=$1 AND app_id=$2', [user.id, game.app_id])) && !had.length;
  const known = new Set(had.map((r) => r.api_name));
  const fresh = [];
  for (const a of parsed.items.filter((x) => x.unlocked)) {
    if (known.has(a.api_name)) continue;
    await q('INSERT INTO user_achievements (user_id, app_id, api_name, unlocked_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [user.id, game.app_id, a.api_name, a.unlocked_at]);
    fresh.push(a);
  }
  // Don't flood someone with pop-ups the first time their medals are loaded.
  if (fresh.length && !firstSync && known.size) {
    const names = fresh.map((a) => a.name).slice(0, 3).join(', ');
    bus.emit('notify', user.id, { title: fresh.length === 1 ? 'Medal earned!' : `${fresh.length} medals earned!`, body: `${game.name}: ${names}`, link: `#/u/${user.id}` });
  }
  return { ok: true, unlocked: parsed.items.filter((x) => x.unlocked).length, total: parsed.items.length, hours: parsed.hours };
}
