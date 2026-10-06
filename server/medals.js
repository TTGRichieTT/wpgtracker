// Automatic medals: given when a member's synced stats meet a medal's rule.
//   class:<recon|assault|medic|support|driver|pilot>:<level>  — class level from global Wardogs stats
//   career:<level>                                            — overall Wardog level
//   hours:<hours>                                             — hours played in tracked Steam games
// Medals are never taken away automatically.
import { q, one } from './db.js';
import { bus } from './bus.js';

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

export function ruleMet(rule, s) {
  const [kind, a, b] = String(rule || '').trim().toLowerCase().split(':');
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
  return { classes, career: career === null || career === undefined ? null : Number(career) || 0, hours: mins.m / 60 };
}

// Gives any automatic medals this member now qualifies for. Returns the new medal names.
export async function giveAutoMedals(userId, { notify = true } = {}) {
  const rules = await q("SELECT id, name, auto_rule FROM awards WHERE auto_rule <> ''");
  if (!rules.length) return [];
  const held = new Set((await q('SELECT award_id FROM user_awards WHERE user_id=$1', [userId])).map((r) => r.award_id));
  const s = await statsFor(userId);
  const won = [];
  for (const r of rules) {
    if (held.has(r.id) || !ruleMet(r.auto_rule, s)) continue;
    await q("INSERT INTO user_awards (user_id, award_id, given_by, reason) VALUES ($1,$2,NULL,'Earned automatically')", [userId, r.id]);
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
        link: `#/u/${userId}`,
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
