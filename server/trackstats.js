// Tracked stats: one list of everything a profile frame or an automatic medal can be earned from, and the code that
// works out each member's numbers. Sources: our own WPG server (kills, matches, the kill feed, WPG XP), wardogs.tools
// (Wardog level, class levels, cash, gold, worth, unlocks), Steam (playtime, achievements) and WPG Barracks itself.
//   scope: all = all-time · season = this season only (since it started) · clan = WPG members while it applies
//   unit: how the target is shown · yesno: earned or not (target 1) · source: shown in the admin pickers and credits
import { q, one } from './db.js';

const SERVER = 'WPG server';
const TRACKER = 'wardogs.tools';
const STEAM = 'Steam';
const APP = 'WPG Barracks';
const CLASS_NAMES = [['recon', 'Recon'], ['assault', 'Assault'], ['medic', 'Medic'], ['support', 'Support'], ['driver', 'Driver'], ['pilot', 'Pilot']];

export const STATS = {
  // Our own WPG server (all time).
  kills: { label: 'Kills on the WPG server (all time)', scope: 'all', source: SERVER },
  matches: { label: 'Matches played on the WPG server', scope: 'all', source: SERVER },
  finished: { label: 'Matches finished (not left early) on the WPG server', scope: 'all', source: SERVER },
  wins: { label: 'Wins on the WPG server (all time)', scope: 'all', source: SERVER },
  hours: { label: 'Hours on the WPG server (all time)', scope: 'all', source: SERVER, unit: 'h' },
  kd: { label: 'K/D on the WPG server (needs 50+ kills)', scope: 'all', source: SERVER, unit: 'K/D' },
  best_match_kills: { label: 'Most kills in one match on the WPG server', scope: 'all', source: SERVER },
  headshots: { label: 'Headshots on the WPG server', scope: 'all', source: SERVER },
  longest_kill: { label: 'Longest kill on the WPG server (m)', scope: 'all', source: SERVER, unit: 'm' },
  wpg_xp: { label: 'WPG XP (all time)', scope: 'all', source: SERVER },
  // Our own WPG server (this season).
  season_kills: { label: 'Kills on the WPG server this season', scope: 'season', source: SERVER },
  season_hours: { label: 'Hours on the WPG server this season', scope: 'season', source: SERVER, unit: 'h' },
  season_wins: { label: 'Wins on the WPG server this season', scope: 'season', source: SERVER },
  season_finished: { label: 'Matches finished (not left early) this season', scope: 'season', source: SERVER },
  season_wpg_xp: { label: 'WPG XP earned this season', scope: 'season', source: SERVER },
  // wardogs.tools (the game's own numbers).
  wardog_level: { label: 'Wardog level (this season)', scope: 'season', source: TRACKER },
  cash: { label: 'Cash held (this season)', scope: 'season', source: TRACKER, unit: '$' },
  max_class_level: { label: 'Highest class level', scope: 'all', source: TRACKER },
  min_class_level: { label: 'Every class at least level', scope: 'all', source: TRACKER },
  ...Object.fromEntries(CLASS_NAMES.map(([k, l]) => [`class_${k}`, { label: `${l} class level`, scope: 'all', source: TRACKER }])),
  gold: { label: 'Gold held', scope: 'all', source: TRACKER },
  worth: { label: 'Account worth', scope: 'all', source: TRACKER, unit: '$' },
  unlocks: { label: 'Items unlocked', scope: 'all', source: TRACKER },
  // Steam.
  steam_hours: { label: 'Hours played on Steam (tracked games)', scope: 'all', source: STEAM, unit: 'h' },
  steam_achievements: { label: 'Steam achievements unlocked (tracked games)', scope: 'all', source: STEAM },
  rare_achievements: { label: 'Rare Steam achievements (under 10% of players have them)', scope: 'all', source: STEAM },
  // WPG Barracks.
  founding: { label: 'Joined in Season 1', scope: 'all', source: APP, yesno: true },
  days_in_wpg: { label: 'Days in WPG Barracks', scope: 'all', source: APP, unit: 'days' },
  clan_xp: { label: 'Clan XP', scope: 'all', source: APP },
  giveaway_wins: { label: 'Giveaways won', scope: 'all', source: APP },
  medals: { label: 'Medals held', scope: 'all', source: APP },
  // Clan (WPG members, while it applies): frames only.
  clan_member: { label: 'WPG member', scope: 'clan', source: APP, yesno: true },
  unit: { label: 'Posted to a Combat Command unit (its colour)', scope: 'clan', source: APP, yesno: true },
  officer: { label: 'Clan rank of at least the target rank order', scope: 'clan', source: APP, yesno: true },
};

// Stats from wardogs.tools: credited wherever a frame or medal from them is shown or posted.
export const TRACKER_STATS = new Set(Object.entries(STATS).filter(([, s]) => s.source === TRACKER).map(([k]) => k));
// Which stats an automatic medal can use (medals are kept for good, so not the clan ones).
export const MEDAL_STATS = Object.fromEntries(Object.entries(STATS).filter(([, s]) => s.scope !== 'clan'));
// An automatic medal rule worked out from wardogs.tools: class:… / career:… or stat:<a wardogs.tools stat>:…
export const isTrackerRule = (rule) => {
  const [kind, key] = String(rule || '').toLowerCase().split(':');
  return kind === 'class' || kind === 'career' || (kind === 'stat' && TRACKER_STATS.has(key));
};

const isWpgMember = (u) => !!u && u.status === 'active' && u.membership !== 'pmc';
const currentSeason = () => one("SELECT * FROM seasons WHERE status='active' ORDER BY number DESC LIMIT 1");

// Every stat for one member (a users row). season: the current season (looked up if not given).
export async function statsFor(user, season) {
  if (season === undefined) season = await currentSeason();
  const sid = user.steam_id;
  const real = /^\d{17}$/.test(sid || '');
  const since = season?.start_at || new Date(0);
  const [srvSeason, srvAll, finished, kf, ws, gw, medals, prog, startXp, steam, rare, rank, posting] = await Promise.all([
    real ? one(`SELECT COALESCE(SUM(mp.kills),0)::int kills, COALESCE(SUM(mp.seconds),0)::int secs, COALESCE(SUM(CASE WHEN mp.won THEN 1 ELSE 0 END),0)::int wins,
                       COUNT(*) FILTER (WHERE mp.stayed)::int finished
                  FROM match_players mp JOIN game_servers g ON g.id = mp.server_id AND g.wpg_xp = true
                 WHERE mp.steam_id=$1 AND mp.ended_at >= $2 AND mp.stayed IS NOT FALSE`, [sid, since]) : null,
    real ? one(`SELECT COALESCE(SUM(kills),0)::int kills, COALESCE(SUM(deaths),0)::int deaths, COALESCE(SUM(playtime_s),0)::int secs,
                       COALESCE(SUM(wins),0)::int wins, COALESCE(SUM(matches),0)::int matches FROM server_players WHERE steam_id=$1`, [sid]) : null,
    real ? one('SELECT COUNT(*) FILTER (WHERE stayed)::int n, COALESCE(MAX(kills),0)::int best FROM match_players WHERE steam_id=$1', [sid]) : null,
    real ? one('SELECT COUNT(*) FILTER (WHERE headshot)::int hs, COALESCE(MAX(distance),0)::float far FROM kill_events WHERE killer=$1', [sid]) : null,
    one('SELECT official, ranks FROM wardogs_stats WHERE user_id=$1', [user.id]),
    one("SELECT COUNT(*)::int n FROM giveaway_winners WHERE user_id=$1 AND status <> 'expired'", [user.id]),
    one('SELECT COUNT(*)::int n FROM user_awards WHERE user_id=$1', [user.id]),
    real ? one('SELECT xp FROM server_progress WHERE steam_id=$1', [sid]) : null,
    real && season ? one('SELECT xp FROM season_start_xp WHERE season_id=$1 AND steam_id=$2', [season.id, sid]) : null,
    one(`SELECT COALESCE(SUM(ug.playtime_forever),0)::int mins, COALESCE(SUM(ug.ach_unlocked) FILTER (WHERE g.enabled),0)::int ach
           FROM user_games ug LEFT JOIN games g ON g.app_id = ug.app_id WHERE ug.user_id=$1`, [user.id]),
    one(`SELECT COUNT(*)::int n FROM user_achievements ua JOIN steam_achievements sa ON sa.app_id = ua.app_id AND sa.api_name = ua.api_name
          WHERE ua.user_id=$1 AND sa.percent IS NOT NULL AND sa.percent < 10`, [user.id]),
    user.rank_id ? one('SELECT sort_order FROM ranks WHERE id=$1', [user.rank_id]) : null,
    one(`SELECT cu.name, cu.color, cu.roles, cp.role_id, prof.primary_role FROM combat_postings cp JOIN combat_units cu ON cu.id = cp.unit_id
           LEFT JOIN combat_profiles prof ON prof.user_id = cp.user_id WHERE cp.user_id=$1`, [user.id]),
  ]);
  const o = ws?.ranks?.source === 'wardogs.tools' ? ws.official : null;
  // Tracker figures only count for a season once they've been synced since it started (a wipe resets them).
  const freshTracker = o?.syncedAt && Date.parse(o.syncedAt) >= new Date(since).getTime();
  const firstSeasonEnd = (await one('SELECT start_at FROM seasons WHERE number=2'))?.start_at;
  const classLevel = (k) => Number(o?.roles?.[k]?.level ?? o?.roles?.[k]) || 0;
  const levels = CLASS_NAMES.map(([k]) => classLevel(k));
  const n = (v) => Number(v) || 0;
  return {
    kills: srvAll?.kills || 0,
    matches: srvAll?.matches || 0,
    finished: finished?.n || 0,
    wins: srvAll?.wins || 0,
    hours: Math.floor((srvAll?.secs || 0) / 3600),
    kd: (srvAll?.kills || 0) >= 50 ? Math.round((srvAll.kills / Math.max(1, srvAll.deaths)) * 100) / 100 : 0,
    best_match_kills: finished?.best || 0,
    headshots: kf?.hs || 0,
    longest_kill: Math.round(kf?.far || 0),
    wpg_xp: prog?.xp || 0,
    season_kills: srvSeason?.kills || 0,
    season_hours: Math.floor((srvSeason?.secs || 0) / 3600),
    season_wins: srvSeason?.wins || 0,
    season_finished: srvSeason?.finished || 0,
    season_wpg_xp: Math.max(0, (prog?.xp || 0) - (startXp?.xp || 0)),
    wardog_level: freshTracker ? n(o.wardogLevel) : 0,
    cash: freshTracker ? n(o.cash) : 0,
    max_class_level: o ? Math.max(0, ...levels) : 0,
    min_class_level: o ? Math.min(...levels) : 0,
    ...Object.fromEntries(CLASS_NAMES.map(([k]) => [`class_${k}`, classLevel(k)])),
    gold: n(o?.gold),
    worth: n(o?.worth),
    unlocks: n(o?.unlocks),
    steam_hours: Math.floor((steam?.mins || 0) / 60),
    steam_achievements: steam?.ach || 0,
    rare_achievements: rare?.n || 0,
    founding: user.joined_at && (!firstSeasonEnd || new Date(user.joined_at) < new Date(firstSeasonEnd)) ? 1 : 0,
    days_in_wpg: user.joined_at ? Math.floor((Date.now() - new Date(user.joined_at).getTime()) / 86400000) : 0,
    clan_xp: n(user.xp),
    giveaway_wins: gw?.n || 0,
    medals: medals?.n || 0,
    clan_member: isWpgMember(user) ? 1 : 0,
    unit: isWpgMember(user) && posting ? 1 : 0,
    unitInfo: posting || null,
    officer: isWpgMember(user) ? rank?.sort_order ?? -1 : -1,
  };
}

// Has a member reached a target on a stat? (Officer compares rank order; everything else is "at least".)
export function reached(key, target, s) {
  if (key === 'officer') return s.officer >= Number(target);
  return (Number(s[key]) || 0) >= Math.max(key === 'kd' ? 0.01 : 1, Number(target) || 0);
}
