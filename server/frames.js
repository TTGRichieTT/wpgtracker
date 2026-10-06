// Profile frames: borders around a member's picture, earned from what they do (like the frames on WARDOGS Tracker).
//  - Permanent: kept forever (Founding Member, Sharpshooter, Long Shot, Specialist, Lucky, Old Guard, season placings).
//  - Clan: WPG members only, while it applies (Clan Colours, their Combat Command unit's colour, Officer).
//  - Season: each season (between the game's wipes) has its own set, in its own looks with its season number on
//    them. They can only be earned while that season runs; members keep the ones they earned for good.
// A member picks one unlocked frame to show around their picture across the app and on Discord cards.
// Seasons follow the game's wipes: the next wipe date is set in Admin → Frames (Season 2: 15 October 2026), and the
// app also warns staff if it looks like the game wiped (most members' Wardog levels dropping at once).
// When a season ends, its Top 100 / Top 10 / Champion (by WPG XP earned that season) get permanent frames.
// Admins can also upload their own frame pictures (512 x 512 PNG / WebP / GIF with a transparent middle).
import express from 'express';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { q, one, audit, flag } from './db.js';
import { bus } from './bus.js';
import { HttpError, member, role, str, int, bool, color } from './util.js';
import { nextSeasonLook } from '../public/js/frameart.js';

export const framesRouter = express.Router();

const isWpgMember = (u) => !!u && u.status === 'active' && u.membership !== 'pmc';
const changed = () => bus.emit('config:changed', 'frames');

// What can earn a frame. scope: all (all-time) or season (this season only). unit: how progress is shown.
export const METRICS = {
  founding: { label: 'Joined in Season 1', scope: 'all', yesno: true },
  headshots: { label: 'Headshots on the WPG server', scope: 'all' },
  longest_kill: { label: 'Longest kill on the WPG server (m)', scope: 'all', unit: 'm' },
  max_class_level: { label: 'Highest class level (WARDOGS Tracker)', scope: 'all' },
  giveaway_wins: { label: 'Giveaways won', scope: 'all' },
  days_in_wpg: { label: 'Days in WPG Barracks', scope: 'all', unit: 'days' },
  kills: { label: 'Kills on the WPG server (all time)', scope: 'all' },
  hours: { label: 'Hours on the WPG server (all time)', scope: 'all', unit: 'h' },
  wins: { label: 'Wins on the WPG server (all time)', scope: 'all' },
  wpg_xp: { label: 'WPG XP (all time)', scope: 'all' },
  medals: { label: 'Medals', scope: 'all' },
  steam_hours: { label: 'Wardogs hours on Steam', scope: 'all', unit: 'h' },
  season_kills: { label: 'Kills on the WPG server this season', scope: 'season' },
  season_hours: { label: 'Hours on the WPG server this season', scope: 'season', unit: 'h' },
  season_wins: { label: 'Wins on the WPG server this season', scope: 'season' },
  season_finished: { label: 'Matches finished (not left early) this season', scope: 'season' },
  season_wpg_xp: { label: 'WPG XP earned this season', scope: 'season' },
  wardog_level: { label: 'Wardog level (WARDOGS Tracker)', scope: 'season' },
  cash: { label: 'Cash held (WARDOGS Tracker)', scope: 'season', unit: '$' },
  clan_member: { label: 'WPG member', scope: 'clan', yesno: true },
  unit: { label: 'Posted to a Combat Command unit (its colour)', scope: 'clan', yesno: true },
  officer: { label: 'Clan rank of at least the target rank order', scope: 'clan', yesno: true },
  manual: { label: 'Given by hand', scope: 'all', yesno: true },
  placement: { label: 'Season placing', scope: 'all', yesno: true },
};

// ---------- Seasons ----------
export async function currentSeason() {
  return one("SELECT * FROM seasons WHERE status='active' ORDER BY number DESC LIMIT 1");
}
async function nextSeason() {
  return one("SELECT * FROM seasons WHERE status='scheduled' ORDER BY start_at LIMIT 1");
}

// ---------- Frames list (cached; cleared when an admin changes them) ----------
let framesCache = null;
async function allFrames() {
  if (!framesCache) {
    framesCache = await q(`SELECT f.*, s.number AS season_number, s.status AS season_status FROM frames f
                             LEFT JOIN seasons s ON s.id = f.season_id ORDER BY f.sort_order, f.id`);
  }
  return framesCache;
}
const clearFrames = () => { framesCache = null; };
const imageUrl = (id) => (id ? `/frame-img/${id}` : '');
const lookOf = (f, extra = {}) => ({
  id: f.id, name: f.name, style: f.style, color: f.color, badge: f.badge, label: f.label, crown: f.crown,
  season: f.category === 'season' ? f.season_number || null : null, season_tag: f.season_tag !== false,
  image: f.style === 'image' ? imageUrl(f.image_id) : '', ...extra,
});
// The clan rank badge a frame with badge 'rank' shows (WPG members with a rank only).
const RANK_COLS = 'id, name, abbr, color, insignia';
async function rankOf(user) {
  return isWpgMember(user) && user.rank_id ? one(`SELECT ${RANK_COLS} FROM ranks WHERE id=$1`, [user.rank_id]) : null;
}
// A member's look for one frame (unit colour, clan rank badge), e.g. for the Discord unlock post.
export async function frameLookFor(user, f) {
  const extra = {};
  if (f.metric === 'unit') {
    const unit = await one('SELECT cu.name, cu.color FROM combat_postings cp JOIN combat_units cu ON cu.id = cp.unit_id WHERE cp.user_id=$1', [user.id]);
    if (unit) Object.assign(extra, { color: unit.color, name: `${unit.name} unit` });
  }
  if (f.badge === 'rank') extra.rank = await rankOf(user);
  const row = (await allFrames()).find((x) => x.id === f.id) || f;
  return lookOf(row, extra);
}

// ---------- What a member has done ----------
async function metricsFor(user, season) {
  const sid = user.steam_id;
  const real = /^\d{17}$/.test(sid || '');
  const since = season?.start_at || new Date(0);
  const [srvSeason, srvAll, kf, ws, gw, medals, prog, startXp, steam, rank, posting] = await Promise.all([
    real ? one(`SELECT COALESCE(SUM(mp.kills),0)::int kills, COALESCE(SUM(mp.seconds),0)::int secs, COALESCE(SUM(CASE WHEN mp.won THEN 1 ELSE 0 END),0)::int wins,
                       COUNT(*) FILTER (WHERE mp.stayed)::int finished
                  FROM match_players mp JOIN game_servers g ON g.id = mp.server_id AND g.wpg_xp = true
                 WHERE mp.steam_id=$1 AND mp.ended_at >= $2 AND mp.stayed IS NOT FALSE`, [sid, since]) : null,
    real ? one('SELECT COALESCE(SUM(kills),0)::int kills, COALESCE(SUM(playtime_s),0)::int secs, COALESCE(SUM(wins),0)::int wins FROM server_players WHERE steam_id=$1', [sid]) : null,
    real ? one('SELECT COUNT(*) FILTER (WHERE headshot)::int hs, COALESCE(MAX(distance),0)::float far FROM kill_events WHERE killer=$1', [sid]) : null,
    one('SELECT official FROM wardogs_stats WHERE user_id=$1', [user.id]),
    one("SELECT COUNT(*)::int n FROM giveaway_winners WHERE user_id=$1 AND status <> 'expired'", [user.id]),
    one('SELECT COUNT(*)::int n FROM user_awards WHERE user_id=$1', [user.id]),
    real ? one('SELECT xp FROM server_progress WHERE steam_id=$1', [sid]) : null,
    real && season ? one('SELECT xp FROM season_start_xp WHERE season_id=$1 AND steam_id=$2', [season.id, sid]) : null,
    one('SELECT COALESCE(SUM(playtime_forever),0)::int mins FROM user_games WHERE user_id=$1', [user.id]),
    user.rank_id ? one('SELECT sort_order FROM ranks WHERE id=$1', [user.rank_id]) : null,
    one('SELECT cu.name, cu.color FROM combat_postings cp JOIN combat_units cu ON cu.id = cp.unit_id WHERE cp.user_id=$1', [user.id]),
  ]);
  const o = ws?.official || null;
  // Tracker figures only count for a season once they've been synced since it started (a wipe resets them).
  const freshTracker = o?.syncedAt && Date.parse(o.syncedAt) >= new Date(since).getTime();
  const firstSeasonEnd = (await one('SELECT start_at FROM seasons WHERE number=2'))?.start_at;
  return {
    founding: user.joined_at && (!firstSeasonEnd || new Date(user.joined_at) < new Date(firstSeasonEnd)) ? 1 : 0,
    headshots: kf?.hs || 0,
    longest_kill: Math.round(kf?.far || 0),
    max_class_level: o ? Math.max(0, ...Object.values(o.roles || {}).map((r) => Number(r?.level ?? r) || 0)) : 0,
    giveaway_wins: gw?.n || 0,
    days_in_wpg: user.joined_at ? Math.floor((Date.now() - new Date(user.joined_at).getTime()) / 86400000) : 0,
    kills: srvAll?.kills || 0,
    hours: Math.floor((srvAll?.secs || 0) / 3600),
    wins: srvAll?.wins || 0,
    wpg_xp: prog?.xp || 0,
    medals: medals?.n || 0,
    steam_hours: Math.floor((steam?.mins || 0) / 60),
    season_kills: srvSeason?.kills || 0,
    season_hours: Math.floor((srvSeason?.secs || 0) / 3600),
    season_wins: srvSeason?.wins || 0,
    season_finished: srvSeason?.finished || 0,
    season_wpg_xp: Math.max(0, (prog?.xp || 0) - (startXp?.xp || 0)),
    wardog_level: freshTracker ? Number(o.wardogLevel) || 0 : 0,
    cash: freshTracker ? Number(o.cash) || 0 : 0,
    clan_member: isWpgMember(user) ? 1 : 0,
    unit: isWpgMember(user) && posting ? 1 : 0,
    unitInfo: posting || null,
    officer: isWpgMember(user) ? rank?.sort_order ?? -1 : -1,
  };
}
const met = (f, m) => {
  if (f.metric === 'manual' || f.metric === 'placement') return false;
  if (f.metric === 'officer') return m.officer >= Number(f.target);
  return (Number(m[f.metric]) || 0) >= Math.max(1, Number(f.target) || 0);
};

// ---------- Unlocking ----------
// Checks one member against every frame and records what they've newly earned. announce: post/notify (only for
// frames whose first quiet check of everyone is done, so a new frame never floods Discord).
export async function checkFrames(userId, { announce = true } = {}) {
  const user = await one("SELECT * FROM users WHERE id=$1 AND status='active'", [userId]);
  if (!user) return [];
  const season = await currentSeason();
  const m = await metricsFor(user, season);
  // Season frames: only the running season's can be earned (earlier seasons' are kept by whoever earned them).
  const list = (await allFrames()).filter((f) => f.enabled && f.category !== 'clan' && f.metric !== 'manual' && f.metric !== 'placement'
    && (f.category !== 'season' || (season && f.season_id === season.id)));
  const have = new Set((await q('SELECT frame_id FROM user_frames WHERE user_id=$1', [user.id])).map((r) => r.frame_id));
  const won = [];
  for (const f of list) {
    if (have.has(f.id) || !met(f, m)) continue;
    const row = await one('INSERT INTO user_frames (user_id, frame_id, season_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [user.id, f.id, f.season_id || 0]);
    if (row) won.push(f);
  }
  if (won.length) {
    bus.emit('user:changed', user.id);
    for (const f of won) {
      if (!announce || !f.swept) continue;
      bus.emit('notify', user.id, { title: '🖼️ New profile frame!', body: `You unlocked ${f.name}. Pick it on your profile to show it around your picture.`, link: `#/u/${user.id}` });
      if (isWpgMember(user)) bus.emit('announce', { type: 'frame', userId: user.id, frameId: f.id });
    }
  }
  return won;
}

// Everyone, every hour (and new frames' first, quiet check).
async function sweep() {
  const users = await q("SELECT id FROM users WHERE status='active'");
  const fresh = (await allFrames()).filter((f) => f.enabled && !f.swept);
  for (const u of users) await checkFrames(u.id, { announce: true }).catch((e) => console.warn('[frames]', e.message));
  if (fresh.length) {
    await q('UPDATE frames SET swept=true WHERE id = ANY($1)', [fresh.map((f) => f.id)]);
    clearFrames();
  }
  // Selected frames that no longer apply (a season ended, left a unit, became a PMC…) are taken off.
  await clearInvalidSelections();
  // Uploaded pictures no frame uses (replaced, or uploaded and never saved) go after a day.
  await q("DELETE FROM frame_images i WHERE i.created_at < now() - interval '1 day' AND NOT EXISTS (SELECT 1 FROM frames f WHERE f.image_id = i.id)");
}

async function clearInvalidSelections() {
  const season = await currentSeason();
  const rows = await q("SELECT u.* FROM users u WHERE u.frame_id IS NOT NULL AND u.status='active'");
  for (const u of rows) if (!(await holds(u, u.frame_id, season))) await q('UPDATE users SET frame_id=NULL WHERE id=$1', [u.id]);
}
// Does this member hold this frame right now?
async function holds(user, frameId, season) {
  const f = (await allFrames()).find((x) => x.id === frameId);
  if (!f || !f.enabled) return false;
  if (f.category === 'clan') {
    if (!isWpgMember(user)) return false;
    const m = await metricsFor(user, season);
    return met(f, m);
  }
  return !!(await one('SELECT 1 FROM user_frames WHERE user_id=$1 AND frame_id=$2', [user.id, f.id]));
}

// For usersWithRanks: the frame each member shows (look only), with the unit frame in their unit's colour.
export async function shownFrames(users) {
  const ids = users.filter((u) => u?.frame_id).map((u) => u.id);
  if (!ids.length) return new Map();
  const list = await allFrames();
  const byId = new Map(list.map((f) => [f.id, f]));
  const needUnit = users.some((u) => byId.get(u.frame_id)?.metric === 'unit');
  const units = needUnit
    ? new Map((await q('SELECT cp.user_id, cu.name, cu.color FROM combat_postings cp JOIN combat_units cu ON cu.id = cp.unit_id WHERE cp.user_id = ANY($1)', [ids])).map((r) => [r.user_id, r]))
    : new Map();
  const rankIds = [...new Set(users.filter((u) => u?.rank_id && byId.get(u.frame_id)?.badge === 'rank').map((u) => u.rank_id))];
  const ranks = rankIds.length ? new Map((await q(`SELECT ${RANK_COLS} FROM ranks WHERE id = ANY($1)`, [rankIds])).map((r) => [r.id, r])) : new Map();
  const out = new Map();
  for (const u of users) {
    const f = byId.get(u.frame_id);
    if (!f || !f.enabled) continue;
    if (f.category === 'clan' && !isWpgMember(u)) continue;
    const extra = f.badge === 'rank' ? { rank: isWpgMember(u) ? ranks.get(u.rank_id) || null : null } : {};
    if (f.metric === 'unit') {
      const unit = units.get(u.id);
      if (!unit) continue;
      out.set(u.id, lookOf(f, { ...extra, color: unit.color, name: `${unit.name} unit` }));
    } else out.set(u.id, lookOf(f, extra));
  }
  return out;
}

// ---------- Season roll-over (the game wiped) ----------
// Ends the active season: its placings get permanent frames (Top 100 / Top 10 / Champion, by WPG XP earned in it),
// its frames can't be earned any more (members keep theirs), the next season starts with its own set of frames,
// and everyone's WPG XP is noted as its start.
export async function startSeason(next, actorId = null) {
  const prev = await currentSeason();
  const now = new Date();
  if (prev) {
    await q("UPDATE seasons SET status='ended', end_at=$2 WHERE id=$1", [prev.id, now]);
    await awardPlacings(prev);
  }
  await q("UPDATE seasons SET status='active', start_at=LEAST(start_at, $2) WHERE id=$1", [next.id, now]);
  await q(`INSERT INTO season_start_xp (season_id, steam_id, xp) SELECT $1, steam_id, xp FROM server_progress ON CONFLICT DO NOTHING`, [next.id]);
  if (prev) await copySeasonFrames(prev, next);
  clearFrames();
  await audit(actorId, 'season.start', `Season ${next.number}`);
  bus.emit('announce', { type: 'season', number: next.number, name: next.name, prev: prev ? prev.number : null });
  bus.emit('staff:notify', { title: `Season ${next.number} has started`, body: prev ? `Season ${prev.number}'s placings have their frames.` : '', link: '#/admin/frames' });
  changed();
}

// The new season's frames: last season's challenges in new looks (skipped if admins already made the new season's).
export async function copySeasonFrames(from, to) {
  if (await one("SELECT 1 FROM frames WHERE category='season' AND season_id=$1", [to.id])) return 0;
  const old = await q("SELECT * FROM frames WHERE category='season' AND season_id=$1 AND enabled ORDER BY sort_order, id", [from.id]);
  for (const f of old) {
    const look = nextSeasonLook(f, to.number);
    await q(
      `INSERT INTO frames (key, name, description, category, style, color, badge, label, crown, metric, target, season_id, sort_order, enabled, image_id, season_tag)
       VALUES ($1,$2,$3,'season',$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14)`,
      [f.key ? `${f.key}-s${to.number}` : '', f.name, f.description, look.style, look.color, f.badge, f.label, f.crown, f.metric, f.target, to.id, f.sort_order,
        look.style === 'image' ? f.image_id : null, f.season_tag],
    );
  }
  clearFrames();
  return old.length;
}

async function awardPlacings(season) {
  const rows = await q(
    `SELECT u.id, u.persona_name, u.membership, u.status, GREATEST(0, p.xp - COALESCE(s.xp, 0)) AS gained
       FROM users u JOIN server_progress p ON p.steam_id = u.steam_id
       LEFT JOIN season_start_xp s ON s.season_id = $1 AND s.steam_id = u.steam_id
      WHERE u.status='active' AND p.xp - COALESCE(s.xp, 0) > 0
      ORDER BY gained DESC, u.id LIMIT 100`,
    [season.id],
  );
  if (!rows.length) return;
  const mk = async (key, name, style, label, crown, order) => (await one(
    `INSERT INTO frames (key, name, description, category, style, badge, label, crown, metric, season_id, sort_order, swept)
     VALUES ($1,$2,$3,'permanent',$4,'crown',$5,$6,'placement',$7,$8,true) RETURNING id`,
    [key, name, `Finished Season ${season.number} ${label ? `in the top ${label}` : 'as Champion'} (WPG XP earned that season)`, style, label, crown, season.id, order],
  )).id;
  const top100 = await mk(`s${season.number}-top100`, `Season ${season.number} Top 100`, 'laurel-bronze', '100', false, 900 + season.number * 3);
  const top10 = await mk(`s${season.number}-top10`, `Season ${season.number} Top 10`, 'laurel-silver', '10', false, 901 + season.number * 3);
  const champ = await mk(`s${season.number}-champion`, `Season ${season.number} Champion`, 'laurel-gold', '', true, 902 + season.number * 3);
  clearFrames();
  for (const [i, r] of rows.entries()) {
    const give = [top100, ...(i < 10 ? [top10] : []), ...(i === 0 ? [champ] : [])];
    for (const fid of give) await q('INSERT INTO user_frames (user_id, frame_id, season_id) VALUES ($1,$2,0) ON CONFLICT DO NOTHING', [r.id, fid]);
    bus.emit('notify', r.id, { title: i === 0 ? `🏆 Season ${season.number} Champion!` : `🏅 Season ${season.number}: #${i + 1}`, body: `You finished #${i + 1} in WPG XP this season and earned ${i === 0 ? 'the Champion frame' : i < 10 ? 'the Top 10 frame' : 'the Top 100 frame'}.`, link: `#/u/${r.id}` });
  }
  // One Discord post for the results (not one per player).
  bus.emit('announce', { type: 'season-results', number: season.number, top: rows.slice(0, 10).map((r, i) => ({ place: i + 1, userId: r.id, gained: Number(r.gained) })) });
}

// The wipe check: Wardog levels from WARDOGS Tracker dropping hard for several members within a day = the game wiped.
const drops = [];
export function noteLevelDrop(userId) {
  const now = Date.now();
  drops.push({ userId, at: now });
  while (drops.length && now - drops[0].at > 86400000) drops.shift();
  if (new Set(drops.map((d) => d.userId)).size < 3) return;
  wipeWarning().catch(() => {});
}
let warnedAt = 0;
async function wipeWarning() {
  const cur = await currentSeason();
  if (cur && Date.now() - new Date(cur.start_at).getTime() < 3 * 86400000) return; // a season only just started
  if (Date.now() - warnedAt < 3 * 86400000) return;
  warnedAt = Date.now();
  bus.emit('staff:notify', { title: 'Looks like the game wiped', body: "Several members' Wardog levels just dropped. If it's a wipe, start the new season in Admin → Frames.", link: '#/admin/frames' });
}

// ---------- The clock ----------
export function startFrames() {
  const run = async () => {
    try {
      await seedFrames();
      // A scheduled season whose date has come: the game wiped, start it.
      const next = await nextSeason();
      if (next && new Date(next.start_at) <= new Date()) await startSeason(next);
      await sweep();
    } catch (e) {
      console.warn('[frames]', e.message);
    }
    setTimeout(run, 60 * 60 * 1000);
  };
  setTimeout(run, 45 * 1000);
  // Season start times are checked every minute (the hourly sweep does the rest).
  setInterval(async () => {
    try {
      const next = await nextSeason();
      if (next && new Date(next.start_at) <= new Date()) await startSeason(next);
    } catch { /* next minute */ }
  }, 60 * 1000);
}

// ---------- The starting frames and seasons (once) ----------
const STARTERS = [
  ['founding', 'Founding Member', 'Joined WPG Barracks in Season 1', 'permanent', 'metal-gold', '', 'star', 'founding', 0],
  ['sharpshooter', 'Sharpshooter', '500 headshots on the WPG server', 'permanent', 'metal-steel', '', 'crosshair', 'headshots', 500],
  ['longshot', 'Long Shot', 'A kill from 500 m or more on the WPG server', 'permanent', 'camo-desert', '', 'target', 'longest_kill', 500],
  ['specialist', 'Specialist', 'Get a class to level 100', 'permanent', 'hazard', '', 'gear', 'max_class_level', 100],
  ['lucky', 'Lucky', 'Win a giveaway', 'permanent', 'glow', '#2ecc71', 'clover', 'giveaway_wins', 1],
  ['oldguard', 'Old Guard', 'A year in WPG Barracks', 'permanent', 'metal-bronze', '', 'clock', 'days_in_wpg', 365],
  ['clan', 'Clan Colours', 'Be a WPG member (shows your clan rank badge)', 'clan', 'clan', '#29b6f6', 'rank', 'clan_member', 0],
  ['unit', 'Unit Colours', 'Be posted to a Combat Command unit (shows in its colour)', 'clan', 'unit', '', 'flag', 'unit', 0],
  ['officer', 'Officer', 'Hold the clan rank of Sergeant or higher', 'clan', 'glow', '#c9a227', 'chevrons', 'officer', 0],
  ['centurion', 'Centurion', 'Reach Wardog level 100 in the season', 'season', 'metal-silver', '', 'chevrons', 'wardog_level', 100],
  ['marksman', 'Marksman', '1,000 kills on the WPG server in the season', 'season', 'rangefinder', '', 'crosshair', 'season_kills', 1000],
  ['ironman', 'Ironman', '50 hours on the WPG server in the season', 'season', 'metal-steel', '', 'clock', 'season_hours', 50],
  ['victor', 'Victor', '25 wins on the WPG server in the season', 'season', 'glow', '#e53935', 'medal', 'season_wins', 25],
  ['millionaire', 'Millionaire', 'Hold $1 million in cash in the season', 'season', 'camo-woodland', '', 'dollar', 'cash', 1000000],
  ['tycoon', 'Tycoon', 'Hold $10 million in cash in the season', 'season', 'metal-gold', '', 'dollar', 'cash', 10000000],
  ['battlehardened', 'Battle-Hardened', '50 matches finished on the WPG server in the season, without leaving early', 'season', 'glow', '#f5a524', 'fist', 'season_finished', 50],
];
let seeded = false;
async function seedFrames() {
  if (seeded) return;
  if (!(await one("SELECT value FROM settings WHERE key='_frames_seeded'"))) {
    // Season 1 began with the game's early access (10 Sept 2026); the first wipe, and Season 2, is on 15 October.
    if (!(await one('SELECT 1 FROM seasons'))) {
      await q("INSERT INTO seasons (number, name, start_at, status) VALUES (1, 'Season 1', '2026-09-10T00:00:00Z', 'active')");
      await q("INSERT INTO seasons (number, name, start_at, status) VALUES (2, 'Season 2', '2026-10-15T00:00:00+01:00', 'scheduled')");
    }
    const s1 = (await currentSeason())?.id || null;
    const sergeant = (await one("SELECT sort_order FROM ranks WHERE name='Sergeant'"))?.sort_order ?? 50;
    for (const [i, [key, name, desc, cat, style, col, badge, metric, target]] of STARTERS.entries()) {
      await q(
        `INSERT INTO frames (key, name, description, category, style, color, badge, metric, target, sort_order, season_id)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 WHERE NOT EXISTS (SELECT 1 FROM frames WHERE key=$1)`,
        [key, name, desc, cat, style, col, badge, metric, metric === 'officer' ? sergeant : target, (i + 1) * 10, cat === 'season' ? s1 : null],
      );
    }
    await q("INSERT INTO settings (key, value) VALUES ('_frames_seeded', 'true') ON CONFLICT DO NOTHING");
    clearFrames();
  }
  // Once: Clan Colours shows the member's clan rank badge in the corner (it had a shield).
  if (!(await one("SELECT value FROM settings WHERE key='_frames_rank_badge'"))) {
    await q("UPDATE frames SET badge='rank', description='Be a WPG member (shows your clan rank badge)' WHERE key='clan' AND badge='shield'");
    await q("INSERT INTO settings (key, value) VALUES ('_frames_rank_badge', 'true') ON CONFLICT DO NOTHING");
    clearFrames();
  }
  seeded = true;
}

// ---------- What members see ----------
const fmtN = (n) => Number(n || 0).toLocaleString('en-GB');
framesRouter.get('/users/:id/frames', member, async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id=$1', [int(req.params.id)]);
  if (!user) throw new HttpError(404, 'Member not found.');
  const season = await currentSeason();
  const next = await nextSeason();
  const m = await metricsFor(user, season);
  const owned = await q('SELECT frame_id, unlocked_at FROM user_frames WHERE user_id=$1', [user.id]);
  const myRank = await rankOf(user);
  const list = (await allFrames()).filter((f) => f.enabled);
  // past: frames from earlier seasons they earned (kept for good, can't be earned any more).
  const out = { permanent: [], clan: [], season: [], past: [] };
  for (const f of list) {
    const own = owned.find((o) => o.frame_id === f.id);
    let unlocked = !!own;
    if (f.category === 'clan') unlocked = isWpgMember(user) && met(f, m);
    if (f.metric === 'placement' && !own) continue; // only show placings someone earned
    let group = f.category;
    if (f.category === 'season' && f.season_id !== season?.id) {
      if (!own || f.season_status === 'scheduled') continue; // next season's aren't shown until it starts
      group = 'past';
    }
    const def = METRICS[f.metric] || {};
    const extra = f.badge === 'rank' ? { rank: myRank } : {};
    const look = f.metric === 'unit' && m.unitInfo ? lookOf(f, { ...extra, color: m.unitInfo.color, name: `${m.unitInfo.name} unit` }) : lookOf(f, extra);
    if (f.metric === 'unit' && !m.unitInfo) look.color = '#5d7a94';
    out[group]?.push({
      ...look, description: f.description, category: f.category, unlocked, unlocked_at: own?.unlocked_at || null,
      season_number: f.season_number || null,
      locked_reason: f.category === 'clan' && !isWpgMember(user) ? 'WPG members only' : '',
      progress: unlocked || def.yesno || group === 'past' ? null : { value: Math.min(Number(m[f.metric]) || 0, Number(f.target)), target: Number(f.target), unit: def.unit || '' },
    });
  }
  res.json({
    season: season ? { number: season.number, name: season.name, start_at: season.start_at } : null,
    next: next ? { number: next.number, start_at: next.start_at } : null,
    selected: user.frame_id, mine: user.id === req.user.id,
    groups: out,
  });
});

framesRouter.put('/me/frame', member, async (req, res) => {
  const id = req.body?.frameId ? int(req.body.frameId) : null;
  if (id && !(await holds(req.user, id, await currentSeason()))) throw new HttpError(400, "You haven't unlocked that frame.");
  await q('UPDATE users SET frame_id=$2 WHERE id=$1', [req.user.id, id]);
  bus.emit('user:changed', req.user.id);
  res.json({ ok: true });
});

// ---------- Admin → Frames ----------
framesRouter.get('/admin/frames', role('admin'), async (_req, res) => {
  const [list, seasons, counts] = await Promise.all([
    allFrames(),
    q('SELECT * FROM seasons ORDER BY number'),
    q('SELECT frame_id, COUNT(*)::int n FROM user_frames GROUP BY frame_id'),
  ]);
  const n = new Map(counts.map((c) => [c.frame_id, c.n]));
  res.json({ frames: list.map((f) => ({ ...f, target: Number(f.target), holders: n.get(f.id) || 0, image: imageUrl(f.image_id) })), seasons, metrics: METRICS, posting: await flag('discord_post_frames') });
});

function readFrame(b) {
  const f = {
    name: str(b.name, 60),
    description: str(b.description, 200),
    category: ['permanent', 'clan', 'season'].includes(b.category) ? b.category : 'permanent',
    style: str(b.style, 30) || 'metal-gold',
    color: b.color ? color(b.color, '') : '',
    badge: str(b.badge, 20),
    label: str(b.label, 6),
    crown: bool(b.crown),
    metric: METRICS[b.metric] ? b.metric : 'manual',
    target: Math.max(0, Number(b.target) || 0),
    sort_order: int(b.sort_order, 500),
    enabled: b.enabled === undefined ? true : bool(b.enabled),
    image_id: b.style === 'image' ? int(b.image_id) || null : null,
    season_tag: b.season_tag === undefined ? true : bool(b.season_tag),
  };
  if (!f.name) throw new HttpError(400, 'Give the frame a name.');
  if (f.style === 'image' && !f.image_id) throw new HttpError(400, 'Upload the frame picture first.');
  if (f.metric === 'placement') throw new HttpError(400, 'Season placing frames are made by the app when a season ends.');
  const scope = METRICS[f.metric].scope;
  if (scope === 'clan' && f.category !== 'clan') f.category = 'clan';
  if (scope === 'season' && f.category === 'permanent') f.category = 'season';
  f.season_id = f.category === 'season' ? int(b.season_id) || null : null;
  return f;
}
async function checkImage(f) {
  if (f.image_id && !(await one('SELECT 1 FROM frame_images WHERE id=$1', [f.image_id]))) throw new HttpError(400, 'That picture is gone: upload it again.');
}
// A season frame goes in the running season or the next one (earlier seasons' sets are closed).
async function checkSeason(f, keep = null) {
  if (f.category !== 'season') return;
  if (keep && f.season_id === keep) return;
  const ok = f.season_id && (await one("SELECT 1 FROM seasons WHERE id=$1 AND status IN ('active','scheduled')", [f.season_id]));
  if (!ok) f.season_id = (await currentSeason())?.id || null;
  if (!f.season_id) throw new HttpError(400, 'There is no season running to add it to.');
}
const FRAME_COLS = ['name', 'description', 'category', 'style', 'color', 'badge', 'label', 'crown', 'metric', 'target', 'sort_order', 'enabled', 'season_id', 'image_id', 'season_tag'];
framesRouter.post('/admin/frames', role('admin'), async (req, res) => {
  const f = readFrame(req.body || {});
  await checkImage(f);
  await checkSeason(f);
  const row = await one(`INSERT INTO frames (key, ${FRAME_COLS.join(', ')}) VALUES ('', ${FRAME_COLS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, FRAME_COLS.map((c) => f[c]));
  clearFrames();
  await audit(req.user.id, 'frame.create', f.name);
  changed();
  res.json({ ok: true, id: row.id });
});
framesRouter.put('/admin/frames/:id', role('admin'), async (req, res) => {
  const old = await one('SELECT * FROM frames WHERE id=$1', [int(req.params.id)]);
  if (!old) throw new HttpError(404, 'Frame not found.');
  const f = readFrame({ ...req.body, metric: old.metric === 'placement' ? 'manual' : req.body?.metric });
  if (old.metric === 'placement') { f.metric = 'placement'; f.category = 'permanent'; f.season_id = old.season_id; }
  // An ended season's frames keep their season and challenge (only the look and wording can change).
  if (old.category === 'season' && (await one("SELECT 1 FROM seasons WHERE id=$1 AND status='ended'", [old.season_id]))) {
    Object.assign(f, { category: 'season', season_id: old.season_id, metric: old.metric, target: Number(old.target) });
  } else await checkSeason(f, old.category === 'season' ? old.season_id : null);
  await checkImage(f);
  await q(`UPDATE frames SET ${FRAME_COLS.map((c, i) => `${c}=$${i + 2}`).join(', ')} WHERE id=$1`, [old.id, ...FRAME_COLS.map((c) => f[c])]);
  clearFrames();
  await audit(req.user.id, 'frame.edit', f.name);
  changed();
  res.json({ ok: true });
});
framesRouter.delete('/admin/frames/:id', role('admin'), async (req, res) => {
  const f = await one('DELETE FROM frames WHERE id=$1 RETURNING name, image_id', [int(req.params.id)]);
  await q('UPDATE users SET frame_id=NULL WHERE frame_id=$1', [int(req.params.id)]);
  if (f?.image_id) await q('DELETE FROM frame_images WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM frames WHERE image_id=$1)', [f.image_id]);
  clearFrames();
  if (f) await audit(req.user.id, 'frame.delete', f.name);
  changed();
  res.json({ ok: true });
});
// Give or take a frame by hand.
framesRouter.post('/admin/frames/:id/give', role('admin'), async (req, res) => {
  const f = await one('SELECT * FROM frames WHERE id=$1', [int(req.params.id)]);
  const u = await one("SELECT * FROM users WHERE id=$1 AND status='active'", [int(req.body?.userId)]);
  if (!f || !u) throw new HttpError(404, 'Frame or member not found.');
  if (f.category === 'clan') throw new HttpError(400, 'Clan frames follow membership, unit and rank, so they can\'t be given by hand.');
  const row = await one('INSERT INTO user_frames (user_id, frame_id, season_id, given_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [u.id, f.id, f.season_id || 0, req.user.id]);
  if (!row) throw new HttpError(400, `${u.persona_name} already has it.`);
  bus.emit('notify', u.id, { title: '🖼️ New profile frame!', body: `You were given ${f.name}. Pick it on your profile to show it.`, link: `#/u/${u.id}` });
  if (isWpgMember(u)) bus.emit('announce', { type: 'frame', userId: u.id, frameId: f.id });
  bus.emit('user:changed', u.id);
  await audit(req.user.id, 'frame.give', `${f.name} → ${u.persona_name}`);
  res.json({ ok: true });
});
framesRouter.delete('/admin/frames/:id/give/:userId', role('admin'), async (req, res) => {
  await q('DELETE FROM user_frames WHERE frame_id=$1 AND user_id=$2', [int(req.params.id), int(req.params.userId)]);
  await q('UPDATE users SET frame_id=NULL WHERE id=$1 AND frame_id=$2', [int(req.params.userId), int(req.params.id)]);
  bus.emit('user:changed', int(req.params.userId));
  await audit(req.user.id, 'frame.take', `frame #${req.params.id} from user #${req.params.userId}`);
  res.json({ ok: true });
});
framesRouter.get('/admin/frames/:id/holders', role('admin'), async (req, res) => {
  res.json(await q(`SELECT u.id, u.persona_name AS name, uf.season_id, uf.unlocked_at FROM user_frames uf JOIN users u ON u.id = uf.user_id
                     WHERE uf.frame_id=$1 ORDER BY uf.unlocked_at DESC LIMIT 300`, [int(req.params.id)]));
});
// Seasons: set the next wipe date, or start the new season now (the game wiped).
framesRouter.put('/admin/seasons/next', role('admin'), async (req, res) => {
  const at = new Date(req.body?.start_at);
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'Pick the date and time of the wipe.');
  const cur = await currentSeason();
  const next = await nextSeason();
  if (next) await q('UPDATE seasons SET start_at=$2, name=$3 WHERE id=$1', [next.id, at, str(req.body?.name, 40) || next.name]);
  else {
    const number = (cur?.number || 0) + 1;
    await q("INSERT INTO seasons (number, name, start_at, status) VALUES ($1,$2,$3,'scheduled')", [number, str(req.body?.name, 40) || `Season ${number}`, at]);
  }
  await audit(req.user.id, 'season.schedule', at.toISOString());
  changed();
  res.json({ ok: true });
});
framesRouter.post('/admin/seasons/start-now', role('admin'), async (req, res) => {
  let next = await nextSeason();
  if (!next) {
    const number = ((await currentSeason())?.number || 0) + 1;
    next = await one("INSERT INTO seasons (number, name, start_at, status) VALUES ($1,$2,now(),'scheduled') RETURNING *", [number, `Season ${number}`]);
  }
  await startSeason(next, req.user.id);
  res.json({ ok: true, number: next.number });
});
// Make the next season's frames now (this season's challenges in new looks), to change them before the wipe.
framesRouter.post('/admin/seasons/next/frames', role('admin'), async (req, res) => {
  const [cur, next] = [await currentSeason(), await nextSeason()];
  if (!cur || !next) throw new HttpError(400, 'Set the next wipe date first.');
  const n = await copySeasonFrames(cur, next);
  if (!n) throw new HttpError(400, `${next.name || `Season ${next.number}`} already has its frames.`);
  await audit(req.user.id, 'season.frames', `Season ${next.number}: ${n} frames`);
  changed();
  res.json({ ok: true, count: n });
});
framesRouter.put('/admin/frames-discord', role('admin'), async (req, res) => {
  await q("INSERT INTO settings (key, value) VALUES ('discord_post_frames', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [String(bool(req.body?.posting))]);
  const { clearSettingsCache } = await import('./db.js');
  clearSettingsCache();
  res.json({ ok: true });
});

// ---------- Uploaded frame pictures ----------
// The guide admins see (Admin → Frames & seasons, and the template): 512 x 512, the member's picture shows through
// the transparent middle 378 x 378 (67–445 px), the frame art goes in the 67 px border.
export const FRAME_SIZE = 512;
const PIC_FROM = 67;
const PIC_TO = 445;
const MAX_IN = 4 * 1024 * 1024; // what can be sent (bigger squares are made 512 x 512)
const MAX_SAVED = 1024 * 1024;
const TYPES = { png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
function sniff(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
const kb = (n) => `${Math.round(n / 1024)} KB`;

framesRouter.post('/admin/frame-images', role('admin'), async (req, res) => {
  const m = /^data:[\w/+.-]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(req.body?.data || ''));
  if (!m) throw new HttpError(400, 'Pick a PNG, WebP or GIF file.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_IN) throw new HttpError(400, `That file is ${kb(buf.length)}: the most is ${kb(MAX_IN)} (and ${kb(MAX_SAVED)} once it's 512 x 512).`);
  const kind = sniff(buf);
  if (!kind) throw new HttpError(400, 'Frames must be PNG, WebP or GIF (with a transparent middle). JPEG has no transparency.');
  const img = await loadImage(buf).catch(() => null);
  if (!img) throw new HttpError(400, "That picture couldn't be read. Save it again as PNG and try once more.");
  const { width: w, height: h } = img;
  if (w !== h) throw new HttpError(400, `It's ${w} x ${h} px: frames must be square, ${FRAME_SIZE} x ${FRAME_SIZE} px.`);
  if (w < 256) throw new HttpError(400, `It's ${w} x ${h} px: too small. Make it ${FRAME_SIZE} x ${FRAME_SIZE} px.`);
  const notes = [];
  let out = buf;
  let mime = TYPES[kind];
  if (w !== FRAME_SIZE) {
    // Animated GIFs would lose their animation if resized, so they must already be the right size.
    if (kind === 'gif') throw new HttpError(400, `It's ${w} x ${h} px: animated GIFs must be exactly ${FRAME_SIZE} x ${FRAME_SIZE} px.`);
    const c = createCanvas(FRAME_SIZE, FRAME_SIZE);
    c.getContext('2d').drawImage(img, 0, 0, FRAME_SIZE, FRAME_SIZE);
    out = await c.encode('png');
    mime = TYPES.png;
    notes.push(`Resized from ${w} x ${h} to ${FRAME_SIZE} x ${FRAME_SIZE} px.`);
  }
  if (out.length > MAX_SAVED) throw new HttpError(400, `At ${FRAME_SIZE} x ${FRAME_SIZE} it's ${kb(out.length)}: the most is ${kb(MAX_SAVED)}. Export with fewer colours (PNG-8) or as WebP.`);
  // The member's picture has to show through: the middle must be (nearly all) see-through.
  const c = createCanvas(FRAME_SIZE, FRAME_SIZE);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, FRAME_SIZE, FRAME_SIZE);
  const inner = g.getImageData(PIC_FROM + 30, PIC_FROM + 30, PIC_TO - PIC_FROM - 60, PIC_TO - PIC_FROM - 60).data;
  let solid = 0;
  for (let i = 3; i < inner.length; i += 4) if (inner[i] > 40) solid++;
  const solidPct = (solid / (inner.length / 4)) * 100;
  if (solidPct > 15) throw new HttpError(400, `The middle isn't transparent (${Math.round(solidPct)}% of it is covered), so members' pictures wouldn't show. Keep the area from ${PIC_FROM} to ${PIC_TO} px clear: see the template.`);
  if (solidPct > 3) notes.push(`A little of the middle is covered (${Math.round(solidPct)}%): check the preview.`);
  const all = g.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE).data;
  let border = 0;
  let borderPx = 0;
  for (let y = 0; y < FRAME_SIZE; y += 2) {
    for (let x = 0; x < FRAME_SIZE; x += 2) {
      if (x >= PIC_FROM && x < PIC_TO && y >= PIC_FROM && y < PIC_TO) continue;
      borderPx++;
      if (all[(y * FRAME_SIZE + x) * 4 + 3] > 40) border++;
    }
  }
  if (border / borderPx < 0.05) notes.push('The border looks empty: the frame art goes in the outer 67 px.');
  const row = await one('INSERT INTO frame_images (mime, data, width, height, bytes, created_by) VALUES ($1,$2,$3,$3,$4,$5) RETURNING id',
    [mime, out.toString('base64'), FRAME_SIZE, out.length, req.user.id]);
  res.json({ ok: true, id: row.id, url: imageUrl(row.id), bytes: out.length, type: mime, notes });
});

// The pictures themselves (public, like the rest of the artwork). A new upload is a new id, so they never change.
const imageCache = new Map();
async function frameImage(id) {
  if (imageCache.has(id)) return imageCache.get(id);
  const r = await one('SELECT mime, data FROM frame_images WHERE id=$1', [id]);
  const img = r ? { mime: r.mime, buf: Buffer.from(r.data, 'base64') } : null;
  if (img) {
    if (imageCache.size > 100) imageCache.clear();
    imageCache.set(id, img);
  }
  return img;
}
export async function frameImageRoute(req, res) {
  const img = await frameImage(int(req.params.id));
  if (!img) throw new HttpError(404, 'Not found');
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(img.buf);
}
// For the Discord cards: the picture behind a look's image link.
export async function frameImageBuffer(url) {
  const id = Number(/^\/frame-img\/(\d+)$/.exec(url || '')?.[1]);
  return id ? (await frameImage(id))?.buf || null : null;
}

// A 512 x 512 template to draw over: the picture area (keep transparent), the border, and the corners the
// app can draw over (clan rank / badge bottom right, season tag bottom left).
framesRouter.get('/admin/frames/template.png', role('admin'), async (_req, res) => {
  const S = FRAME_SIZE;
  const c = createCanvas(S, S);
  const g = c.getContext('2d');
  const round = (x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };
  // Border zone (blue): where the frame art goes. Picture area (grey): keep it transparent in the real frame.
  g.fillStyle = 'rgba(60,70,80,0.55)';
  round(PIC_FROM, PIC_FROM, PIC_TO - PIC_FROM, PIC_TO - PIC_FROM, 42);
  g.fill();
  g.fillStyle = 'rgba(41,182,246,0.45)';
  round(PIC_FROM, PIC_FROM, PIC_TO - PIC_FROM, PIC_TO - PIC_FROM, 42);
  g.rect(0, 0, S, S);
  g.fill('evenodd');
  // Picture area outline.
  g.setLineDash([10, 8]);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3;
  round(PIC_FROM, PIC_FROM, PIC_TO - PIC_FROM, PIC_TO - PIC_FROM, 42);
  g.stroke();
  g.setLineDash([]);
  // Corners the app may draw over.
  for (const [cx, label] of [[S - 52, 'BADGE / RANK'], [52, 'SEASON TAG']]) {
    g.fillStyle = 'rgba(245,165,36,0.45)';
    g.beginPath(); g.arc(cx, S - 52, 50, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff';
    g.font = 'bold 13px sans-serif';
    g.textAlign = 'center';
    g.fillText(label, cx, S - 48);
  }
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.shadowColor = 'rgba(0,0,0,0.8)';
  g.shadowBlur = 4;
  g.font = 'bold 22px sans-serif';
  g.fillText('FRAME ART: OUTER 67 px', S / 2, 42);
  g.font = 'bold 20px sans-serif';
  g.fillText("MEMBER'S PICTURE", S / 2, S / 2 - 40);
  g.font = '16px sans-serif';
  g.fillText(`${PIC_TO - PIC_FROM} x ${PIC_TO - PIC_FROM} px, from ${PIC_FROM} to ${PIC_TO} px`, S / 2, S / 2 - 12);
  g.fillText('keep this area transparent', S / 2, S / 2 + 12);
  g.font = '14px sans-serif';
  g.fillText(`Whole frame: ${S} x ${S} px`, S / 2, S / 2 + 50);
  g.fillText('PNG, WebP or GIF, up to 1 MB', S / 2, S / 2 + 70);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', 'attachment; filename="wpg-frame-template-512.png"');
  res.send(await c.encode('png'));
});
