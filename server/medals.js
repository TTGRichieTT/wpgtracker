// Automatic medals: given when a member's synced stats meet a medal's rule.
//   class:<recon|assault|medic|support|driver|pilot>:<level>  — class level from global Wardogs stats
//   career:<level>                                            — overall Wardog level
//   hours:<hours>                                             — hours played in tracked Steam games
//   stat:<stat>:<target>                                      — any tracked stat (trackstats.js): WPG server kills,
//                                                               headshots, K/D, wardogs.tools gold, Steam achievements…
// Medals are never taken away automatically.
// Season medals: the game's wipe puts class and Wardog levels back to 0, so level medals (class:, career:, and stat:
// rules on class levels or this-season stats) are earned per season and kept in that season's record; they can be won
// again each season. Everything else is earned once, for good.
import { q, one } from './db.js';
import { bus } from './bus.js';
import { MEDAL_STATS, statsFor as trackedStats, reached, isTrackerRule } from './trackstats.js';

export const CLASSES = [
  ['recon', 'Recon', '#c62828'],
  ['assault', 'Assault', '#1e5bc6'],
  ['medic', 'Medic', '#1b9e5a'],
  ['support', 'Support', '#d68910'],
  ['driver', 'Driver', '#7b3fb3'],
  ['pilot', 'Pilot', '#1590c4'],
];
const TIERS = [['#b0753a', 'Bronze'], ['#c9ced6', 'Silver'], ['#e3b341', 'Gold'], ['#e9f1f7', 'Platinum'], ['#7fdcff', 'Diamond']];

// Starter set: levels 10–50 for every class, and 100–500 hours played.
export function starterMedals() {
  const list = [];
  let order = 1000;
  for (const [key, label, color] of CLASSES) {
    [10, 20, 30, 40, 50].forEach((lvl, i) => {
      const [metal, tier] = TIERS[i];
      list.push({
        name: `${label} ${tier} — Level ${lvl}`,
        description: `Reached level ${lvl} in the ${label} class.`,
        colors: [color, metal, color, metal, color].join(','),
        sort_order: (order += 1),
        auto_rule: `class:${key}:${lvl}`,
      });
    });
  }
  [100, 200, 300, 400, 500].forEach((h, i) => {
    const [metal, tier] = TIERS[i];
    list.push({
      name: `${h} Hours Served`,
      description: `Played ${h} hours of Wardogs (${tier} service ribbon).`,
      colors: ['#3b4a2f', metal, '#3b4a2f', metal, '#3b4a2f'].join(','),
      sort_order: (order += 1),
      auto_rule: `hours:${h}`,
    });
  });
  return list;
}

export function isSeasonalRule(rule) {
  const [kind, key = ''] = String(rule || '').trim().toLowerCase().split(':');
  if (kind === 'class' || kind === 'career') return true;
  if (kind !== 'stat') return false;
  return MEDAL_STATS[key]?.scope === 'season' || key === 'max_class_level' || key === 'min_class_level' || key.startsWith('class_');
}
const activeSeason = () => one("SELECT id, number, start_at FROM seasons WHERE status='active' ORDER BY number DESC LIMIT 1");

// Season medals given before seasons were tracked go in the season they were given in (once per start, before any
// medals are given, so nobody gets one twice).
let placed = null;
const placeOnce = () => (placed ||= placeSeasonMedals().catch((e) => console.warn('[medals] season medals', e.message)));
export async function placeSeasonMedals() {
  const ids = (await q("SELECT id, auto_rule FROM awards WHERE auto_rule <> ''")).filter((a) => isSeasonalRule(a.auto_rule)).map((a) => a.id);
  if (!ids.length) return;
  await q(`UPDATE user_awards ua SET season_id = COALESCE((SELECT s.id FROM seasons s WHERE s.status <> 'scheduled' AND s.start_at <= ua.given_at
             ORDER BY s.start_at DESC LIMIT 1), (SELECT s.id FROM seasons s WHERE s.status <> 'scheduled' ORDER BY s.start_at LIMIT 1), 0)
           WHERE ua.season_id = 0 AND ua.award_id = ANY($1)`, [ids]);
}

export function ruleMet(rule, s) {
  const [kind, a, b] = String(rule || '').trim().toLowerCase().split(':');
  if (kind === 'stat') return !!s.tracked && !!MEDAL_STATS[a] && reached(a, b, s.tracked);
  if (kind === 'class') return (s.classes[a] ?? -1) >= Number(b);
  if (kind === 'career') return (s.career ?? -1) >= Number(a);
  if (kind === 'hours') return s.hours >= Number(a);
  return false;
}

async function statsFor(userId) {
  const ws = await one('SELECT official, ranks FROM wardogs_stats WHERE user_id=$1', [userId]);
  const official = ws?.ranks?.source === 'wardogs.tools' ? ws.official : null;
  const classes = {};
  for (const [k, v] of Object.entries(official?.roles || {})) {
    const level = v?.level ?? (typeof v === 'number' ? v : null);
    if (level !== null && level !== undefined) classes[k.toLowerCase()] = Number(level) || 0;
  }
  const mins = await one(
    'SELECT COALESCE(SUM(ug.playtime_forever), 0)::int AS m FROM user_games ug JOIN games g ON g.app_id = ug.app_id AND g.enabled = true WHERE ug.user_id = $1',
    [userId],
  );
  const career = official?.wardogLevel;
  return { classes, career: career === null || career === undefined ? null : Number(career) || 0, hours: mins.m / 60, syncedAt: official?.syncedAt || null };
}

// A rule string is valid: class / career / hours, or stat:<a stat medals can use>:<target>. Returns it cleaned, or null.
export function cleanRule(v) {
  const r = String(v || '').toLowerCase().replace(/\s+/g, '');
  if (!r) return '';
  if (/^(class:(recon|assault|medic|support|driver|pilot):\d{1,3}|career:\d{1,3}|hours:\d{1,5})$/.test(r)) return r;
  const m = r.match(/^stat:([a-z_]+):(\d{1,9}(\.\d{1,2})?)$/);
  return m && MEDAL_STATS[m[1]] ? r : null;
}

// Gives any automatic medals this member now qualifies for. Returns the new medal names.
export async function giveAutoMedals(userId, { notify = true } = {}) {
  const rules = (await q("SELECT id, name, auto_rule FROM awards WHERE auto_rule <> ''")).map((r) => ({ ...r, seasonal: isSeasonalRule(r.auto_rule) }));
  if (!rules.length) return [];
  await placeOnce();
  const season = await activeSeason();
  const sid = season?.id || 0;
  const seasonalIds = new Set(rules.filter((r) => r.seasonal).map((r) => r.id));
  // Held: for good, or (season medals) this season.
  const held = new Set((await q('SELECT award_id, season_id FROM user_awards WHERE user_id=$1', [userId]))
    .filter((r) => !seasonalIds.has(r.award_id) || r.season_id === sid).map((r) => r.award_id));
  const s = await statsFor(userId);
  // wardogs.tools levels only count for this season once they've been synced since it started (the wipe resets them).
  const freshTracker = !season || (s.syncedAt && Date.parse(s.syncedAt) >= new Date(season.start_at).getTime());
  // Tracked stats are only worked out when a medal uses one (they take a few lookups).
  if (rules.some((r) => r.auto_rule.startsWith('stat:') && !held.has(r.id))) {
    const user = await one("SELECT * FROM users WHERE id=$1 AND status='active'", [userId]);
    s.tracked = user ? await trackedStats(user) : null;
  }
  const won = [];
  for (const r of rules) {
    if (held.has(r.id)) continue;
    if (r.seasonal && !freshTracker && isTrackerRule(r.auto_rule)) continue;
    if (!ruleMet(r.auto_rule, s)) continue;
    await q("INSERT INTO user_awards (user_id, award_id, given_by, reason, season_id) VALUES ($1,$2,NULL,'Earned automatically',$3)", [userId, r.id, r.seasonal ? sid : 0]);
    won.push(r);
  }
  // Only announce the highest new tier in each series (the rack shows just that one).
  const series = (rule) => rule.split(':').slice(0, -1).join(':');
  const level = (rule) => Number(rule.split(':').pop()) || 0;
  const fresh = won
    .filter((r) => !won.some((o) => o !== r && series(o.auto_rule) === series(r.auto_rule) && level(o.auto_rule) > level(r.auto_rule)))
    .map((r) => r.name);
  if (fresh.length) {
    if (notify) {
      bus.emit('notify', userId, {
        title: fresh.length === 1 ? 'Medal awarded!' : `${fresh.length} medals awarded!`,
        body: fresh.slice(0, 3).join(', ') + (fresh.length > 3 ? ` and ${fresh.length - 3} more` : ''),
        link: `#/u/${userId}/rewards`,
      });
      bus.emit('announce', { type: 'medals', userId, names: fresh });
    }
    bus.emit('user:changed', userId);
  }
  return fresh;
}

// Catch up every active member (e.g. after new medals are added). Quiet: no pop-ups.
export async function giveAutoMedalsToAll() {
  const users = await q("SELECT id FROM users WHERE status='active'");
  let total = 0;
  for (const { id } of users) total += (await giveAutoMedals(id, { notify: false })).length;
  return { users: users.length, given: total };
}
