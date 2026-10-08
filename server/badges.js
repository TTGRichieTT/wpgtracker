// Achievements: collectible badges and achievement medals, earned from the tracked stats (trackstats.js: the WPG
// server, wardogs.tools, Steam, streaming, Discord, boosts, WPG membership and events).
//  - Badges (this file): artwork (the owner's uploads, or a default design in the badge's rarity until then), a
//    rarity (common … exclusive) and Achievement Points. Earned automatically from a rule 'stat:<stat>:<target>',
//    or given by staff (rule ''). "Temporary" badges (e.g. WPG Staff) are taken away when they stop applying,
//    unless staff gave them by hand. Every other badge is kept for good.
//  - Achievement medals: medals (medals.js) with a rarity, points and category. The starter set below adds both.
//  - Achievement Points: the points of every badge and medal held (older medals have 0 until staff give them some).
//  - Checked: every hour for everyone, when a member's Discord / streaming numbers change ('stats:changed'),
//    after their stats sync and after every WPG server match. A new badge is first given quietly to everyone who
//    already qualifies (no Discord flood); after that each unlock is announced (one post for several at once).
// Also here: the verified WPG join date (Admin → Members) and official events / tournaments (Admin → Events).
import express from 'express';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { q, one, audit, setting } from './db.js';
import { bus } from './bus.js';
import { HttpError, member, role, str, int, bool } from './util.js';
import { STATS, MEDAL_STATS, statsFor, reached } from './trackstats.js';
import { giveAutoMedals } from './medals.js';
import { checkFrames } from './frames.js';

export const badgesRouter = express.Router();

export const RARITIES = {
  common: { label: 'Common', color: '#b8c4d0', points: 10 },
  uncommon: { label: 'Uncommon', color: '#3ddc84', points: 15 },
  rare: { label: 'Rare', color: '#29b6f6', points: 25 },
  epic: { label: 'Epic', color: '#b05cff', points: 50 },
  legendary: { label: 'Legendary', color: '#f5a524', points: 100 },
  mythic: { label: 'Mythic', color: '#ff4d6d', points: 250 },
  exclusive: { label: 'Exclusive', color: '#ffe066', points: 0 }, // set in Admin → Badges (points_exclusive)
};
export const CATEGORIES = {
  streaming: 'Streaming', nitro: 'Nitro boosts', loyalty: 'WPG loyalty', chat: 'Discord chat', voice: 'Discord voice',
  recruitment: 'Recruitment', events: 'Events & tournaments', special: 'Special recognition', wardogs: 'Wardogs', other: 'Other',
};
export async function rarityPoints(rarity) {
  if (rarity === 'exclusive') return Math.max(0, Number(await setting('points_exclusive')) || 500);
  return RARITIES[rarity]?.points ?? 10;
}

// ---------- The starter set (the owner's list) ----------
// [name, target, reward] where reward is 'medal' / 'badge' with a rarity: 'medal' = common medal, 'badge' = rare badge.
const REWARD = (r) => {
  const [rar, kind] = r.includes(' ') ? r.split(' ') : [r === 'medal' ? 'common' : 'rare', r];
  return { kind, rarity: rar };
};
const SERIES = [
  ['streaming', 'stream_count', 'Go live {n} times (verified streams of 15+ minutes)', [
    ['First Time Live', 1, 'medal'], ['Rookie Broadcaster', 5, 'medal'], ['Rising Streamer', 10, 'medal'], ['Dedicated Creator', 25, 'medal'],
    ['Broadcast Veteran', 50, 'medal'], ['Streaming Legend', 100, 'badge'], ['Broadcast Elite', 250, 'badge'],
    ['Streaming Immortal', 500, 'legendary badge'], ['WPG Broadcast Icon', 1000, 'legendary badge']]],
  ['streaming', 'stream_best_day', 'Stream {n} hours in one day (several streams that day add up)', [
    ['Going Strong', 1, 'medal'], ['Stream Grinder', 2, 'medal'], ['Dedicated Streamer', 3, 'medal'], ['Marathon Starter', 4, 'medal'],
    ['Five-Hour Warrior', 5, 'medal'], ['Stream Soldier', 6, 'medal'], ['No Breaks', 8, 'medal'], ['Marathon Champion', 10, 'epic medal'],
    ['Midnight Broadcaster', 12, 'epic medal'], ['Stream Machine', 14, 'epic medal'], ['Streaming Beast', 16, 'legendary medal'],
    ['Ultimate Marathon', 18, 'legendary medal'], ['Broadcast Titan', 20, 'legendary badge'], ['WPG Marathon Legend', 24, 'mythic badge']]],
  ['streaming', 'stream_hours', 'Stream {n} hours in total', [
    ['First Ten', 10, 'medal'], ['Broadcast Rookie', 25, 'medal'], ['Rising Broadcaster', 50, 'medal'], ['Century Streamer', 100, 'medal'],
    ['Stream Veteran', 250, 'badge'], ['Stream Elite', 500, 'badge'], ['Thousand-Hour Legend', 1000, 'legendary badge'],
    ['Broadcast Master', 2500, 'legendary badge'], ['WPG Streaming Immortal', 5000, 'mythic badge'], ['Eternal Broadcaster', 10000, 'mythic badge']]],
  ['streaming', 'stream_streak', 'Stream {n} days in a row (30+ minutes each day)', [
    ['Weekend Streamer', 2, 'medal'], ['Three-Day Grind', 3, 'medal'], ['Weekly Warrior', 7, 'medal'], ['Two-Week Broadcaster', 14, 'medal'],
    ['Monthly Streaming Beast', 30, 'epic badge'], ['Unstoppable Creator', 60, 'legendary badge'], ['Stream Addict', 90, 'legendary badge'],
    ['Broadcast Dedication', 180, 'mythic badge'], ['Year of Streaming', 365, 'mythic badge']]],
  ['nitro', 'boosts_active', 'Have {n} active boosts on the WPG Discord', [
    ['Double Boost', 2, 'medal'], ['Triple Support', 3, 'medal'], ['Boost Commander', 5, 'epic medal']]],
  ['nitro', 'boosts_lifetime', 'Give the WPG Discord {n} boosts (all time)', [
    ['First Boost', 1, 'medal'], ['Nitro Champion', 10, 'epic badge'], ['Server Benefactor', 25, 'legendary badge'], ['WPG Nitro Legend', 50, 'mythic badge']]],
  ['nitro', 'boost_months', 'Boost the WPG Discord for {n} months without a break', [
    ['Nitro Recruit', 1, 'medal'], ['Dedicated Booster', 3, 'medal'], ['Loyal Supporter', 6, 'epic badge'], ['One-Year Nitro Veteran', 12, 'legendary badge'],
    ['Two-Year Nitro Veteran', 24, 'legendary badge'], ['Three-Year Nitro Veteran', 36, 'mythic badge'], ['Four-Year Nitro Veteran', 48, 'mythic badge'],
    ['Five-Year Nitro Legend', 60, 'exclusive badge'], ['Eternal WPG Supporter', 120, 'exclusive badge']]],
  ['loyalty', 'wpg_days', 'Your first day in WPG', [['Welcome to the Pack', 1, 'common badge']]],
  ['loyalty', 'wpg_months', '{n} months in WPG (from your verified WPG join date)', [
    ['Pack Recruit', 1, 'common badge'], ['Established Member', 3, 'common badge'], ['Loyal Pack Member', 6, 'rare badge'],
    ['One-Year Veteran', 12, 'rare badge'], ['Two-Year Veteran', 24, 'rare badge'], ['Three-Year Veteran', 36, 'epic badge'],
    ['Four-Year Veteran', 48, 'epic badge'], ['Five-Year Legacy', 60, 'legendary badge'], ['Six-Year Legacy', 72, 'legendary badge'],
    ['Seven-Year Legend', 84, 'legendary badge'], ['Eight-Year Legend', 96, 'legendary badge'], ['Nine-Year Legend', 108, 'legendary badge'],
    ['Ten-Year WPG Immortal', 120, 'mythic badge'], ['Eleven-Year Veteran', 132, 'mythic badge'], ['Twelve-Year Veteran', 144, 'mythic badge'],
    ['Thirteen-Year Veteran', 156, 'mythic badge'], ['Fourteen-Year Veteran', 168, 'mythic badge'],
    ['Fifteen-Year Eternal Legacy', 180, 'exclusive badge'], ['Twenty-Year WPG Legacy', 240, 'exclusive badge']]],
  ['chat', 'discord_messages', 'Send {n} messages in the WPG Discord', [
    ['First Words', 1, 'medal'], ['Breaking the Ice', 10, 'medal'], ['Getting Social', 50, 'medal'], ['Community Regular', 100, 'medal'],
    ['Chat Warrior', 250, 'medal'], ['Conversation Veteran', 500, 'medal'], ['WPG Chatterbox', 1000, 'epic medal'], ['Community Voice', 2500, 'epic medal'],
    ['Discord Elite', 5000, 'legendary badge'], ['Chat Legend', 10000, 'legendary badge'], ['WPG Social Icon', 25000, 'mythic badge'], ['Voice of WPG', 50000, 'mythic badge']]],
  ['voice', 'voice_hours', 'Spend {n} hours in Discord voice with others', [
    ['Mic Check', 1, 'medal'], ['Squad Communication', 5, 'medal'], ['Voice Rookie', 10, 'medal'], ['Team Player', 25, 'medal'],
    ['Communication Veteran', 50, 'medal'], ['Voice Warrior', 100, 'epic medal'], ['Voice Squad Leader', 250, 'epic badge'],
    ['Voice Elite', 500, 'legendary badge'], ['Comms Legend', 1000, 'legendary badge'], ['WPG Radio Commander', 2500, 'mythic badge'], ['Eternal Comms', 5000, 'mythic badge']]],
  ['recruitment', 'recruits', 'Bring {n} verified members to WPG', [
    ['First Recruit', 1, 'medal'], ['Bringing Friends', 3, 'medal'], ['Squad Recruiter', 5, 'medal'], ['Community Builder', 10, 'medal'],
    ['Recruitment Officer', 25, 'epic medal'], ['Recruitment Veteran', 50, 'epic badge'], ['WPG Ambassador', 100, 'legendary badge'],
    ['Recruitment Legend', 250, 'legendary badge'], ['Pack Architect', 500, 'mythic badge']]],
  ['events', 'events_attended', 'Take part in {n} official WPG events', [
    ['First Event', 1, 'medal'], ['Event Regular', 5, 'medal'], ['Event Veteran', 10, 'medal'], ['Event Enthusiast', 25, 'epic medal'], ['Event Legend', 50, 'legendary badge']]],
  ['events', 'giveaway_wins', 'Win {n} WPG giveaways', [
    ['Lucky Wolf', 1, 'medal'], ['Lucky Streak', 3, 'medal'], ['Fortune Favors You', 5, 'epic badge'], ['WPG Lucky Legend', 10, 'legendary badge']]],
  ['events', 'tournament_wins', 'Win {n} official WPG tournaments', [
    ['First Victory', 1, 'medal'], ['Tournament Veteran', 5, 'epic badge'], ['WPG Champion', 10, 'legendary badge'], ['Tournament Legend', 25, 'mythic badge']]],
];
// Given by staff (or, for the two position badges, while the member holds that position).
const SPECIAL = [
  ['WPG Founder', 'Original founder of WPG', 'exclusive', ''],
  ['WPG Founding Member', 'Verified original WPG community member', 'exclusive', ''],
  ['WPG Staff', 'Current WPG staff member', 'rare', 'stat:is_staff:1', true],
  ['WPG Administrator', 'Current WPG administrator', 'epic', 'stat:is_admin:1', true],
  ['Community Guardian', 'Recognised for exceptional community help', 'epic', ''],
  ['Distinguished Service', 'Outstanding contributions to WPG', 'legendary', ''],
  ['WPG Hall of Fame', 'Official WPG Hall of Fame induction', 'mythic', ''],
  ['Retired Staff Veteran', 'Former staff member with recognised service', 'legendary', ''],
  ['WPG Content Partner', 'Approved WPG content creator', 'epic', ''],
  ['Community Hero', 'Special staff recognition', 'epic', ''],
  ['WPG Tournament Champion', 'Special championship award', 'legendary', ''],
  ['WPG Legacy Award', 'Exceptional long-term contribution', 'mythic', ''],
];
// Ribbon colours for achievement medals: the category colour with the rarity colour.
const CAT_COLOR = { streaming: '#9146ff', nitro: '#ff73fa', loyalty: '#c9a227', chat: '#5865f2', voice: '#3ddc84', recruitment: '#e9c46a', events: '#f08c3c' };
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function starterSet() {
  const badgesOut = [];
  const medalsOut = [];
  let order = 100;
  for (const [category, stat, text, tiers] of SERIES) {
    for (const [name, n, reward] of tiers) {
      const { kind, rarity } = REWARD(reward);
      const description = text.replace('{n}', Number(n).toLocaleString('en-GB'));
      const rule = `stat:${stat}:${n}`;
      order += 1;
      if (kind === 'badge') badgesOut.push({ key: slug(name), name, description, category, series: stat, rarity, rule, sort_order: order });
      else {
        const c = CAT_COLOR[category] || '#29b6f6';
        const r = RARITIES[rarity].color;
        medalsOut.push({ name, description, category, rarity, auto_rule: rule, colors: [c, r, c, r, c].join(','), sort_order: 2000 + order });
      }
    }
  }
  for (const [name, description, rarity, rule, temporary] of SPECIAL) {
    badgesOut.push({ key: slug(name), name, description, category: 'special', series: '', rarity, rule, temporary: !!temporary, sort_order: (order += 1) });
  }
  return { badges: badgesOut, medals: medalsOut };
}

// Adds the starter badges and medals once each. What's been added is remembered, so a starter badge or medal that
// staff rename or delete never comes back on the next start; edits are always kept.
export async function seedAchievements() {
  if (!(await setting('loyalty_auto_from'))) {
    await q("INSERT INTO settings (key, value) VALUES ('loyalty_auto_from', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value WHERE settings.value=''", [new Date().toISOString()]);
  }
  let seeded = {};
  try { seeded = JSON.parse((await setting('_achievements_seeded')) || '{}') || {}; } catch { seeded = {}; }
  const doneB = new Set(seeded.badges || []);
  const doneM = new Set(seeded.medals || []);
  const { badges: list, medals } = starterSet();
  const haveB = new Set((await q("SELECT key FROM badges WHERE key <> ''")).map((r) => r.key));
  const haveM = new Set((await q('SELECT lower(name) AS n FROM awards')).map((r) => r.n));
  let added = 0;
  for (const b of list) {
    if (doneB.has(b.key)) continue;
    doneB.add(b.key);
    if (haveB.has(b.key)) continue;
    await q(`INSERT INTO badges (key, name, description, category, series, rarity, points, rule, temporary, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [b.key, b.name, b.description, b.category, b.series, b.rarity, await rarityPoints(b.rarity), b.rule, !!b.temporary, b.sort_order]);
    added++;
  }
  for (const m of medals) {
    const k = m.name.toLowerCase();
    if (doneM.has(k)) continue;
    doneM.add(k);
    if (haveM.has(k)) continue;
    await q('INSERT INTO awards (name, description, colors, sort_order, auto_rule, rarity, points, category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [m.name, m.description, m.colors, m.sort_order, m.auto_rule, m.rarity, await rarityPoints(m.rarity), m.category]);
    added++;
  }
  await q("INSERT INTO settings (key, value) VALUES ('_achievements_seeded', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
    [JSON.stringify({ badges: [...doneB], medals: [...doneM] })]);
  if (added) {
    console.log(`[badges] Added ${added} starter badges and achievement medals`);
    clearBadges();
    // Medals new to the list: everyone who already qualifies gets them quietly.
    const { giveAutoMedalsToAll } = await import('./medals.js');
    await giveAutoMedalsToAll().catch(() => {});
  }
  await pointsForOlderMedals().catch((e) => console.warn('[badges] older medal points', e.message));
  return added;
}

// Older medals (made before Achievement Points, so no rarity and 0 points) get a rarity and points once, on the same
// scale as the achievement medals: each series (e.g. Recon levels, hours played, one tracked stat) climbs from Common
// up to Legendary as its target gets harder; medals staff give by hand are Rare. Staff can change any of them after
// in Admin → Medals, and this never runs again.
const LADDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export function olderMedalRarities(medals) {
  const out = new Map();
  const series = new Map();
  for (const m of medals) {
    const parts = String(m.auto_rule || '').trim().toLowerCase().split(':');
    if (!parts[0]) { out.set(m.id, 'rare'); continue; }
    const target = Number(parts[parts.length - 1]) || 0;
    const key = parts.slice(0, -1).join(':') || parts[0];
    if (!series.has(key)) series.set(key, []);
    series.get(key).push({ id: m.id, target });
  }
  for (const list of series.values()) {
    list.sort((a, b) => a.target - b.target);
    const n = list.length;
    list.forEach((m, i) => out.set(m.id, LADDER[n <= LADDER.length ? i : Math.round((i * (LADDER.length - 1)) / (n - 1))]));
  }
  return out;
}
async function pointsForOlderMedals() {
  if (await setting('_older_medal_points')) return;
  const older = await q("SELECT id, auto_rule FROM awards WHERE COALESCE(rarity, '') = '' AND COALESCE(points, 0) = 0");
  const rarities = olderMedalRarities(older);
  for (const [id, rarity] of rarities) await q('UPDATE awards SET rarity=$2, points=$3 WHERE id=$1', [id, rarity, await rarityPoints(rarity)]);
  await q("INSERT INTO settings (key, value) VALUES ('_older_medal_points', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [new Date().toISOString()]);
  if (rarities.size) console.log(`[badges] Gave ${rarities.size} older medals a rarity and Achievement Points`);
}

// ---------- Earning ----------
let badgeCache = null;
export async function allBadges() {
  if (!badgeCache) badgeCache = await q('SELECT * FROM badges ORDER BY sort_order, id');
  return badgeCache;
}
const clearBadges = () => { badgeCache = null; };
const ruleParts = (rule) => {
  const [kind, key, target] = String(rule || '').split(':');
  return kind === 'stat' && STATS[key] ? { key, target: Number(target) || 0 } : null;
};
export function badgeMet(b, s) {
  const r = ruleParts(b.rule);
  return !!r && reached(r.key, r.target, s);
}

// Checks one member's badges: gives what they've reached, takes temporary ones that no longer apply.
export async function checkBadges(userId, { announce = true } = {}) {
  const user = await one("SELECT * FROM users WHERE id=$1 AND status='active'", [userId]);
  if (!user) return [];
  const list = (await allBadges()).filter((b) => b.enabled && b.rule);
  if (!list.length) return [];
  const held = new Map((await q('SELECT badge_id, given_by FROM user_badges WHERE user_id=$1', [userId])).map((r) => [r.badge_id, r]));
  const s = await statsFor(user);
  const fresh = [];
  for (const b of list) {
    const ok = badgeMet(b, s);
    if (ok && !held.has(b.id)) {
      const r = await q('INSERT INTO user_badges (user_id, badge_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [userId, b.id, 'Earned automatically']);
      if (r.length) fresh.push(b);
    } else if (!ok && held.has(b.id) && b.temporary && held.get(b.id).given_by === null) {
      await q('DELETE FROM user_badges WHERE user_id=$1 AND badge_id=$2', [userId, b.id]);
      bus.emit('user:changed', userId);
    }
  }
  if (fresh.length) {
    const loud = announce ? fresh.filter((b) => b.swept) : [];
    if (loud.length) {
      bus.emit('notify', userId, {
        title: loud.length === 1 ? '🏅 New badge!' : `🏅 ${loud.length} new badges!`,
        body: loud.slice(0, 3).map((b) => b.name).join(', ') + (loud.length > 3 ? ` and ${loud.length - 3} more` : ''),
        link: `#/u/${userId}`,
      });
      bus.emit('announce', { type: 'badges', userId, badgeIds: loud.map((b) => b.id) });
    }
    bus.emit('user:changed', userId);
  }
  return fresh;
}

// Everything for one member whose numbers changed (Discord activity, streams…): frames, medals and badges.
async function checkAll(userId) {
  await checkFrames(userId).catch((e) => console.warn('[badges] frames', e.message));
  await giveAutoMedals(userId).catch((e) => console.warn('[badges] medals', e.message));
  await checkBadges(userId).catch((e) => console.warn('[badges]', e.message));
}

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const users = await q("SELECT id FROM users WHERE status='active'");
    const fresh = (await allBadges()).filter((b) => b.enabled && !b.swept);
    for (const u of users) await checkBadges(u.id).catch((e) => console.warn('[badges]', e.message));
    if (fresh.length) {
      await q('UPDATE badges SET swept=true WHERE id = ANY($1)', [fresh.map((b) => b.id)]);
      clearBadges();
    }
  } finally {
    sweeping = false;
  }
}

export function startBadges() {
  seedAchievements().catch((e) => console.warn('[badges] seed', e.message));
  bus.on('stats:changed', (userId) => checkAll(userId));
  setTimeout(() => sweep().catch((e) => console.warn('[badges] sweep', e.message)), 60 * 1000);
  setInterval(() => sweep().catch((e) => console.warn('[badges] sweep', e.message)), 3600e3);
}

// ---------- A member's collection ----------
const imageUrl = (id) => (id ? `/badge-img/${id}` : '');
export const badgeOut = (b, extra = {}) => ({
  id: b.id, name: b.name, description: b.description, category: b.category, series: b.series, rarity: b.rarity, points: b.points,
  temporary: b.temporary, limited: b.limited, image: imageUrl(b.image_id), short: shortLabel(b), manual: !b.rule, ...extra,
});
// What the default artwork shows big in the middle until the owner's artwork is uploaded.
const initials = (name) => String(name || '').split(/\s+/).filter((w) => /^[A-Z0-9]/.test(w)).map((w) => w[0]).join('').slice(0, 3) || 'WPG';
export function shortLabel(b) {
  const r = ruleParts(b.rule);
  if (!r) return initials(b.name);
  const n = r.target;
  if (r.key === 'wpg_months' || r.key === 'boost_months') return n >= 12 && n % 12 === 0 ? `${n / 12}Y` : `${n}M`;
  if (r.key === 'wpg_days') return '1D';
  if (STATS[r.key]?.yesno) return initials(b.name);
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}K`;
  if (r.key.startsWith('stream_') && STATS[r.key]?.unit === 'h') return `${n}H`;
  if (r.key === 'stream_streak') return `${n}D`;
  return String(n);
}

export async function pointsFor(userIds) {
  const rows = await q(`SELECT u.id,
      COALESCE((SELECT SUM(b.points) FROM user_badges ub JOIN badges b ON b.id = ub.badge_id WHERE ub.user_id = u.id), 0)::int AS badge_points,
      COALESCE((SELECT SUM(a.points) FROM user_awards ua JOIN awards a ON a.id = ua.award_id WHERE ua.user_id = u.id), 0)::int AS medal_points,
      (SELECT COUNT(*) FROM user_badges ub WHERE ub.user_id = u.id)::int AS badges,
      (SELECT COUNT(DISTINCT award_id) FROM user_awards ua WHERE ua.user_id = u.id)::int AS medals
    FROM users u WHERE u.id = ANY($1)`, [userIds]);
  return new Map(rows.map((r) => [r.id, { points: r.badge_points + r.medal_points, badges: r.badges, medals: r.medals }]));
}

export async function collectionFor(user) {
  const held = new Map((await q('SELECT badge_id, earned_at, reason, given_by FROM user_badges WHERE user_id=$1', [user.id])).map((r) => [r.badge_id, r]));
  // Switched-off badges they still hold are listed too (marked off): they still count for points, and staff need to
  // see them to take them away.
  const all = await allBadges();
  const list = all.filter((b) => b.enabled || held.has(b.id));
  const s = await statsFor(user);
  const badgesList = list.map((b) => {
    const h = held.get(b.id);
    const r = ruleParts(b.rule);
    const progress = r && !h ? { value: Math.min(Number(s[r.key]) || 0, r.target), target: r.target, unit: STATS[r.key]?.unit || '' } : null;
    return badgeOut(b, { unlocked: !!h, earned_at: h?.earned_at || null, progress, how: r ? STATS[r.key]?.label : 'Given by WPG staff', off: !b.enabled });
  });
  const totals = (await pointsFor([user.id])).get(user.id) || { points: 0, badges: 0, medals: 0 };
  const showcase = (Array.isArray(user.badge_showcase) ? user.badge_showcase : []).map(Number).filter((id) => held.has(id)).slice(0, 5);
  const earnedCount = badgesList.filter((b) => b.unlocked).length;
  const medalTotal = (await one("SELECT COUNT(*)::int n FROM awards WHERE auto_rule <> '' OR rarity <> ''")).n;
  const medalsAuto = (await one("SELECT COUNT(DISTINCT ua.award_id)::int n FROM user_awards ua JOIN awards a ON a.id = ua.award_id WHERE ua.user_id=$1 AND (a.auto_rule <> '' OR a.rarity <> '')", [user.id])).n;
  return {
    badges: badgesList,
    showcase,
    frame_badge: user.frame_badge_id && held.has(user.frame_badge_id) ? user.frame_badge_id : null,
    totals: {
      points: totals.points,
      badges: earnedCount,
      badges_total: all.filter((b) => b.enabled).length,
      medals: totals.medals,
      completion: badgesList.length + medalTotal ? Math.round(((earnedCount + medalsAuto) / (badgesList.length + medalTotal)) * 1000) / 10 : 0,
    },
    stream: s.streamInfo,
    loyalty: { joined: s.wpgJoined, months: s.wpg_months, days: s.wpg_days, verified: !!user.wpg_joined_at },
    rarities: RARITIES,
    categories: CATEGORIES,
  };
}

badgesRouter.get('/users/:id/badges', member, async (req, res) => {
  const u = await one("SELECT * FROM users WHERE id=$1 AND status='active'", [int(req.params.id)]);
  if (!u) throw new HttpError(404, 'Member not found.');
  res.json(await collectionFor(u));
});
// Share one of your badges to Discord (the badge posts channel). Once a minute, and each badge once an hour.
const shared = new Map(); // `${userId}` → time, `${userId}:${badgeId}` → time
badgesRouter.post('/me/badges/:id/share', member, async (req, res) => {
  const id = int(req.params.id);
  if (!(await one('SELECT 1 FROM user_badges WHERE user_id=$1 AND badge_id=$2', [req.user.id, id]))) throw new HttpError(400, "You haven't earned that badge yet.");
  const channel = String((await setting('discord_badge_channel')) || (await setting('discord_post_channel')) || '').trim();
  if (!process.env.DISCORD_BOT_TOKEN || !/^\d{15,22}$/.test(channel)) throw new HttpError(400, "Badge posts to Discord aren't set up yet (ask an admin: Admin → Badges).");
  const now = Date.now();
  if (now - (shared.get(String(req.user.id)) || 0) < 60e3) throw new HttpError(429, 'Wait a minute before sharing another badge.');
  if (now - (shared.get(`${req.user.id}:${id}`) || 0) < 3600e3) throw new HttpError(429, 'You shared that badge in the last hour.');
  shared.set(String(req.user.id), now);
  shared.set(`${req.user.id}:${id}`, now);
  if (shared.size > 5000) shared.clear();
  bus.emit('announce', { type: 'badge-share', userId: req.user.id, badgeId: id });
  res.json({ ok: true });
});
// Show an earned badge in your frame's corner instead of your clan rank badge (null = back to the clan rank).
badgesRouter.put('/me/frame-badge', member, async (req, res) => {
  const id = req.body?.badge_id ? int(req.body.badge_id) : null;
  if (id && !(await one('SELECT 1 FROM user_badges WHERE user_id=$1 AND badge_id=$2', [req.user.id, id]))) throw new HttpError(400, "You haven't earned that badge yet.");
  await q('UPDATE users SET frame_badge_id=$2 WHERE id=$1', [req.user.id, id]);
  bus.emit('user:changed', req.user.id);
  res.json({ ok: true, frame_badge_id: id });
});
badgesRouter.put('/me/badge-showcase', member, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((x) => int(x)).filter(Boolean);
  const held = new Set((await q('SELECT badge_id FROM user_badges WHERE user_id=$1', [req.user.id])).map((r) => r.badge_id));
  const pick = [...new Set(ids)].filter((id) => held.has(id)).slice(0, 5);
  await q('UPDATE users SET badge_showcase=$2 WHERE id=$1', [req.user.id, JSON.stringify(pick)]);
  bus.emit('user:changed', req.user.id);
  res.json({ ok: true, showcase: pick });
});
// The badges a list of members show (their showcase), for member lists and cards.
export async function showcasesFor(users) {
  const byId = new Map((await allBadges()).map((b) => [b.id, b]));
  return new Map(users.map((u) => [u.id, (Array.isArray(u.badge_showcase) ? u.badge_showcase : []).map((id) => byId.get(Number(id))).filter(Boolean).map((b) => badgeOut(b))]));
}

// ---------- Achievement Points leaderboard ----------
export async function pointsBoard(limit = 25) {
  return q(`SELECT u.id, u.persona_name AS name, u.custom_avatar, u.avatar,
      (COALESCE((SELECT SUM(b.points) FROM user_badges ub JOIN badges b ON b.id = ub.badge_id WHERE ub.user_id = u.id), 0)
     + COALESCE((SELECT SUM(a.points) FROM user_awards ua JOIN awards a ON a.id = ua.award_id WHERE ua.user_id = u.id), 0))::int AS points,
      (SELECT COUNT(*) FROM user_badges ub WHERE ub.user_id = u.id)::int AS badges
    FROM users u WHERE u.status='active' ORDER BY points DESC, badges DESC, u.persona_name LIMIT $1`, [limit]);
}
badgesRouter.get('/achievements/leaderboard', member, async (_req, res) => {
  res.json(await pointsBoard(50));
});

// ---------- Artwork ----------
const ART = 512;
const TYPES = { png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
function sniff(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
const kb = (n) => `${Math.round(n / 1024)} KB`;
// Checks and stores one picture. Refuses pictures without a real see-through background (including the common
// "checkerboard drawn into the picture" from AI image tools), and makes big ones 512 x 512.
export async function saveBadgeArt(dataUrl) {
  const m = /^data:[\w/+.-]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'Pick a PNG, WebP or GIF file.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 6 * 1024 * 1024) throw new HttpError(400, `That file is ${kb(buf.length)}: the most is 6 MB.`);
  const kind = sniff(buf);
  if (!kind) throw new HttpError(400, 'Badges must be PNG, WebP or GIF with a transparent background (JPEG has no transparency).');
  const img = await loadImage(buf).catch(() => null);
  if (!img) throw new HttpError(400, "That picture couldn't be read. Save it again as PNG and try once more.");
  const { width: w, height: h } = img;
  if (Math.abs(w - h) > Math.max(w, h) * 0.02) throw new HttpError(400, `It's ${w} x ${h} px: badges must be square (512 x 512 is best).`);
  if (w < 128) throw new HttpError(400, `It's ${w} x ${h} px: too small. Use 512 x 512 px.`);
  // The background: the outer edge of the picture should be (nearly all) see-through.
  const c = createCanvas(ART, ART);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, ART, ART);
  const px = g.getImageData(0, 0, ART, ART).data;
  let edge = 0;
  let solid = 0;
  const greys = new Set();
  for (let y = 0; y < ART; y += 2) {
    for (let x = 0; x < ART; x += 2) {
      if (x > 14 && x < ART - 14 && y > 14 && y < ART - 14) continue;
      edge++;
      const i = (y * ART + x) * 4;
      if (px[i + 3] > 40) {
        solid++;
        const [r, gg, b] = [px[i], px[i + 1], px[i + 2]];
        if (Math.max(r, gg, b) - Math.min(r, gg, b) < 12) greys.add(Math.round(r / 16));
      }
    }
  }
  if (solid / edge > 0.5) {
    const checker = greys.size >= 2 && greys.size <= 4;
    throw new HttpError(400, checker
      ? "The background isn't transparent: the grey and white checkerboard is drawn into the picture. Export it again with a real transparent background (PNG or WebP), or remove the background first."
      : "The background isn't transparent. Export the badge as PNG or WebP with a transparent background.");
  }
  let out = buf;
  let mime = TYPES[kind];
  const notes = [];
  if (w !== ART && kind !== 'gif') {
    out = await c.encode('png');
    mime = TYPES.png;
    notes.push(`Resized from ${w} x ${h} to ${ART} x ${ART} px.`);
  }
  if (out.length > 1.5 * 1024 * 1024) throw new HttpError(400, `It's ${kb(out.length)} at ${ART} x ${ART}: the most is 1.5 MB. Export as WebP or with fewer colours.`);
  const row = await one('INSERT INTO badge_images (mime, data) VALUES ($1,$2) RETURNING id', [mime, out.toString('base64')]);
  return { id: row.id, url: imageUrl(row.id), notes };
}
const imageCache = new Map();
async function badgeImage(id) {
  if (imageCache.has(id)) return imageCache.get(id);
  const r = await one('SELECT mime, data FROM badge_images WHERE id=$1', [id]);
  const img = r ? { mime: r.mime, buf: Buffer.from(r.data, 'base64') } : null;
  if (img) {
    if (imageCache.size > 200) imageCache.clear();
    imageCache.set(id, img);
  }
  return img;
}
export async function badgeImageRoute(req, res) {
  const img = await badgeImage(int(req.params.id));
  if (!img) throw new HttpError(404, 'Not found');
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(img.buf);
}
export async function badgeImageBuffer(url) {
  const id = Number(/^\/badge-img\/(\d+)$/.exec(url || '')?.[1]);
  return id ? (await badgeImage(id))?.buf || null : null;
}

// ---------- Admin: badges ----------
const RULE_ERR = 'Pick a stat and a target, or leave it as given by staff.';
async function readBadge(b) {
  const rarity = RARITIES[b.rarity] ? b.rarity : 'common';
  let rule = '';
  if (b.rule) {
    const m = /^stat:([a-z_]+):(\d{1,9}(\.\d{1,2})?)$/.exec(String(b.rule).trim());
    if (!m || !MEDAL_STATS[m[1]]) throw new HttpError(400, RULE_ERR);
    rule = `stat:${m[1]}:${m[2]}`;
  }
  return {
    name: str(b.name, 60) || 'New badge',
    description: str(b.description, 200),
    category: CATEGORIES[b.category] ? b.category : 'other',
    series: str(b.series, 40),
    rarity,
    points: b.points === '' || b.points === undefined ? await rarityPoints(rarity) : Math.max(0, Math.min(100000, int(b.points))),
    rule,
    temporary: bool(b.temporary) && !!rule,
    limited: bool(b.limited),
    image_id: b.image_id ? int(b.image_id) : null,
    sort_order: int(b.sort_order),
    enabled: b.enabled === undefined ? true : bool(b.enabled),
  };
}
badgesRouter.get('/admin/badges', role('admin'), async (_req, res) => {
  const holders = new Map((await q('SELECT badge_id, COUNT(*)::int n FROM user_badges GROUP BY badge_id')).map((r) => [r.badge_id, r.n]));
  res.json({
    badges: (await allBadges()).map((b) => ({ ...badgeOut(b), rule: b.rule, enabled: b.enabled, sort_order: b.sort_order, image_id: b.image_id, key: b.key, holders: holders.get(b.id) || 0 })),
    stats: MEDAL_STATS, rarities: RARITIES, categories: CATEGORIES,
    settings: {
      posting: (await setting('discord_post_badges')) !== 'false',
      channel: (await setting('discord_badge_channel')) || '',
      quiet: String((await setting('discord_badge_quiet')) || '').split(',').filter(Boolean),
      points_exclusive: Number(await setting('points_exclusive')) || 500,
    },
  });
});
badgesRouter.post('/admin/badges', role('admin'), async (req, res) => {
  const b = await readBadge(req.body || {});
  const row = await one(`INSERT INTO badges (name, description, category, series, rarity, points, rule, temporary, limited, image_id, sort_order, enabled)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
  [b.name, b.description, b.category, b.series, b.rarity, b.points, b.rule, b.temporary, b.limited, b.image_id, b.sort_order, b.enabled]);
  clearBadges();
  await audit(req.user.id, 'badge.create', row.id, b);
  res.json({ ok: true, id: row.id });
});
badgesRouter.put('/admin/badges/:id', role('admin'), async (req, res) => {
  const id = int(req.params.id);
  const old = await one('SELECT * FROM badges WHERE id=$1', [id]);
  if (!old) throw new HttpError(404, 'Badge not found.');
  const b = await readBadge({ ...old, ...req.body });
  await q(`UPDATE badges SET name=$2, description=$3, category=$4, series=$5, rarity=$6, points=$7, rule=$8, temporary=$9, limited=$10,
             image_id=$11, sort_order=$12, enabled=$13, swept = swept AND rule = $8 WHERE id=$1`,
  [id, b.name, b.description, b.category, b.series, b.rarity, b.points, b.rule, b.temporary, b.limited, b.image_id, b.sort_order, b.enabled]);
  clearBadges();
  await audit(req.user.id, 'badge.edit', id, b);
  res.json({ ok: true });
});
badgesRouter.delete('/admin/badges/:id', role('admin'), async (req, res) => {
  const id = int(req.params.id);
  const b = await one('DELETE FROM badges WHERE id=$1 RETURNING name', [id]);
  clearBadges();
  await audit(req.user.id, 'badge.delete', id, { name: b?.name });
  res.json({ ok: true });
});
badgesRouter.post('/admin/badge-images', role('admin'), async (req, res) => {
  res.json({ ok: true, ...(await saveBadgeArt(req.body?.data)) });
});
// Many pictures at once: each file is matched to a badge by its file name (the badge name, e.g. one-year-veteran.png).
badgesRouter.post('/admin/badges/bulk-art', role('admin'), async (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 40) : [];
  const list = await allBadges();
  const out = [];
  for (const f of files) {
    const base = slug(String(f.name || '').replace(/\.[a-z0-9]+$/i, ''));
    const b = list.find((x) => x.key === base || slug(x.name) === base);
    if (!b) { out.push({ file: f.name, ok: false, message: 'No badge with that name.' }); continue; }
    try {
      const art = await saveBadgeArt(f.data);
      await q('UPDATE badges SET image_id=$2 WHERE id=$1', [b.id, art.id]);
      out.push({ file: f.name, ok: true, badge: b.name, notes: art.notes });
    } catch (e) {
      out.push({ file: f.name, ok: false, badge: b.name, message: e.message });
    }
  }
  clearBadges();
  await audit(req.user.id, 'badge.art', '', { files: out.length });
  res.json({ results: out });
});
badgesRouter.get('/admin/badges/:id/holders', role('admin'), async (req, res) => {
  res.json(await q(`SELECT ub.user_id, ub.earned_at, ub.reason, ub.given_by, u.persona_name AS name FROM user_badges ub JOIN users u ON u.id = ub.user_id
                     WHERE ub.badge_id=$1 ORDER BY ub.earned_at DESC`, [int(req.params.id)]));
});
badgesRouter.put('/admin/badge-settings', role('admin'), async (req, res) => {
  const b = req.body || {};
  const set = (k, v) => q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
  if ('posting' in b) await set('discord_post_badges', String(bool(b.posting)));
  if ('channel' in b) await set('discord_badge_channel', /^\d{15,22}$/.test(String(b.channel).trim()) ? String(b.channel).trim() : '');
  if ('quiet' in b) await set('discord_badge_quiet', (Array.isArray(b.quiet) ? b.quiet : []).filter((c) => CATEGORIES[c]).join(','));
  if ('points_exclusive' in b) await set('points_exclusive', String(Math.max(0, Math.min(100000, int(b.points_exclusive)))));
  const { clearSettingsCache } = await import('./db.js');
  clearSettingsCache();
  await audit(req.user.id, 'badge.settings', '', b);
  res.json({ ok: true });
});

// ---------- Admin: a member's badges and WPG join date ----------
badgesRouter.get('/admin/users/:id/badges', role('mod'), async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id=$1', [int(req.params.id)]);
  if (!u) throw new HttpError(404, 'Member not found.');
  const c = await collectionFor(u);
  const history = await q("SELECT a.*, x.persona_name AS actor FROM audit_log a LEFT JOIN users x ON x.id = a.actor_id WHERE a.target=$1 AND a.action IN ('member.wpg_joined','badge.give','badge.take') ORDER BY a.id DESC LIMIT 30", [String(u.id)]);
  res.json({ ...c, wpg_joined_at: u.wpg_joined_at, wpg_joined_note: u.wpg_joined_note, history });
});
badgesRouter.post('/admin/users/:id/badges', role('mod'), async (req, res) => {
  const userId = int(req.params.id);
  const b = await one('SELECT * FROM badges WHERE id=$1', [int(req.body?.badge_id)]);
  if (!b) throw new HttpError(404, 'Badge not found.');
  if (b.rarity === 'exclusive' && req.user.role !== 'admin') throw new HttpError(403, 'Only admins can give Exclusive badges.');
  const reason = str(req.body?.reason, 200) || 'Given by staff';
  const r = await q('INSERT INTO user_badges (user_id, badge_id, given_by, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [userId, b.id, req.user.id, reason]);
  if (!r.length) throw new HttpError(400, 'They already have that badge.');
  await audit(req.user.id, 'badge.give', userId, { badge: b.name, reason });
  bus.emit('notify', userId, { title: '🏅 New badge!', body: `${b.name}: ${reason}`, link: `#/u/${userId}` });
  bus.emit('announce', { type: 'badges', userId, badgeIds: [b.id], reason });
  bus.emit('user:changed', userId);
  res.json({ ok: true });
});
badgesRouter.delete('/admin/users/:id/badges/:badgeId', role('mod'), async (req, res) => {
  const userId = int(req.params.id);
  const b = await one('SELECT name FROM badges WHERE id=$1', [int(req.params.badgeId)]);
  await q('DELETE FROM user_badges WHERE user_id=$1 AND badge_id=$2', [userId, int(req.params.badgeId)]);
  await audit(req.user.id, 'badge.take', userId, { badge: b?.name, reason: str(req.query.reason, 200) });
  bus.emit('user:changed', userId);
  res.json({ ok: true });
});
// The verified original WPG join date (admins only, every change logged).
badgesRouter.put('/admin/users/:id/wpg-joined', role('admin'), async (req, res) => {
  const u = await one('SELECT id, wpg_joined_at, wpg_joined_note FROM users WHERE id=$1', [int(req.params.id)]);
  if (!u) throw new HttpError(404, 'Member not found.');
  const raw = String(req.body?.date || '').trim();
  const at = raw ? new Date(`${raw.slice(0, 10)}T12:00:00Z`) : null;
  if (raw && (Number.isNaN(at?.getTime()) || at > new Date() || at < new Date('2000-01-01'))) throw new HttpError(400, 'Pick a real date (not in the future).');
  const note = str(req.body?.note, 200);
  if (raw && !note) throw new HttpError(400, 'Say how it was checked (e.g. "old forum post", "founder confirmed").');
  await q('UPDATE users SET wpg_joined_at=$2, wpg_joined_note=$3 WHERE id=$1', [u.id, at, note]);
  await audit(req.user.id, 'member.wpg_joined', u.id, { from: u.wpg_joined_at, to: at, note });
  bus.emit('stats:changed', u.id);
  res.json({ ok: true });
});

// ---------- Admin: events and tournaments ----------
badgesRouter.get('/admin/events', role('mod'), async (_req, res) => {
  const events = await q('SELECT * FROM wpg_events ORDER BY held_at DESC, id DESC LIMIT 200');
  const people = events.length ? await q('SELECT * FROM wpg_event_people WHERE event_id = ANY($1)', [events.map((e) => e.id)]) : [];
  const members = await q("SELECT id, persona_name AS name FROM users WHERE status='active' ORDER BY lower(persona_name)");
  res.json({ events: events.map((e) => ({ ...e, people: people.filter((p) => p.event_id === e.id).map((p) => ({ user_id: p.user_id, won: p.won })) })), members });
});
async function saveEvent(id, b, actor) {
  const name = str(b.name, 100);
  if (!name) throw new HttpError(400, 'Give the event a name.');
  const kind = b.kind === 'tournament' ? 'tournament' : 'event';
  const at = new Date(b.held_at || Date.now());
  if (Number.isNaN(at.getTime()) || at > new Date(Date.now() + 86400e3)) throw new HttpError(400, 'Pick when it happened (events are recorded once they have happened).');
  const people = (Array.isArray(b.people) ? b.people : []).map((p) => ({ user_id: int(p.user_id), won: kind === 'tournament' && bool(p.won) })).filter((p) => p.user_id);
  const row = id
    ? await one('UPDATE wpg_events SET name=$2, kind=$3, held_at=$4, notes=$5 WHERE id=$1 RETURNING id', [id, name, kind, at, str(b.notes, 500)])
    : await one('INSERT INTO wpg_events (name, kind, held_at, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [name, kind, at, str(b.notes, 500), actor.id]);
  if (!row) throw new HttpError(404, 'Event not found.');
  const before = new Set((await q('SELECT user_id FROM wpg_event_people WHERE event_id=$1', [row.id])).map((r) => r.user_id));
  await q('DELETE FROM wpg_event_people WHERE event_id=$1', [row.id]);
  for (const p of people) await q('INSERT INTO wpg_event_people (event_id, user_id, won) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [row.id, p.user_id, p.won]);
  await audit(actor.id, id ? 'event.edit' : 'event.create', row.id, { name, kind, people: people.length, winners: people.filter((p) => p.won).length });
  for (const uid of new Set([...before, ...people.map((p) => p.user_id)])) bus.emit('stats:changed', uid);
  return row.id;
}
badgesRouter.post('/admin/events', role('mod'), async (req, res) => {
  res.json({ ok: true, id: await saveEvent(null, req.body || {}, req.user) });
});
badgesRouter.put('/admin/events/:id', role('mod'), async (req, res) => {
  res.json({ ok: true, id: await saveEvent(int(req.params.id), req.body || {}, req.user) });
});
badgesRouter.delete('/admin/events/:id', role('admin'), async (req, res) => {
  const id = int(req.params.id);
  const people = (await q('SELECT user_id FROM wpg_event_people WHERE event_id=$1', [id])).map((r) => r.user_id);
  const e = await one('DELETE FROM wpg_events WHERE id=$1 RETURNING name', [id]);
  await audit(req.user.id, 'event.delete', id, { name: e?.name });
  for (const uid of people) bus.emit('stats:changed', uid);
  res.json({ ok: true });
});
