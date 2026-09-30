import { q, one, flag, setting } from './db.js';
import { bus } from './bus.js';
import { syncWardogs } from './wardogs.js';

const OPENID = 'https://steamcommunity.com/openid/login';
const API = 'https://api.steampowered.com';
const CLAIMED_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

export function steamLoginUrl(baseUrl) {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': `${baseUrl}/auth/steam/return`,
    'openid.realm': baseUrl,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${OPENID}?${params}`;
}

// Returns the 64-bit Steam ID if Steam confirms the login, otherwise null.
export async function verifySteamLogin(query, baseUrl) {
  if (query['openid.mode'] !== 'id_res') return null;
  if (query['openid.op_endpoint'] !== OPENID) return null;
  if (!String(query['openid.return_to'] || '').startsWith(`${baseUrl}/auth/steam/return`)) return null;
  const match = CLAIMED_ID_RE.exec(query['openid.claimed_id'] || '');
  if (!match) return null;

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith('openid.')) body.set(k, String(v));
  }
  body.set('openid.mode', 'check_authentication');
  const res = await fetch(OPENID, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  return /is_valid\s*:\s*true/.test(text) ? match[1] : null;
}

async function steamGet(path, params) {
  const key = process.env.STEAM_API_KEY;
  if (!key) throw new Error('STEAM_API_KEY is not set');
  const url = `${API}${path}?${new URLSearchParams({ key, format: 'json', ...params })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const err = new Error(`Steam API ${path} returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Name + picture. Uses the Web API when a key is set, otherwise the public profile page (no key needed).
export async function fetchSummary(steamId) {
  if (process.env.STEAM_API_KEY) {
    const data = await steamGet('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId }).catch(() => null);
    const p = data?.response?.players?.[0];
    if (p) return { persona_name: p.personaname, avatar: p.avatarfull, profile_url: p.profileurl };
  }
  const res = await fetch(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const xml = await res.text();
  const field = (tag) => new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(xml)?.[1]?.trim();
  const name = field('steamID');
  if (!name) return null;
  const avatar = field('avatarFull') || '';
  return {
    persona_name: name.slice(0, 64),
    avatar: avatar.startsWith('https://') ? avatar : '',
    profile_url: `https://steamcommunity.com/profiles/${steamId}`,
  };
}

export async function syncUser(userId) {
  const user = await one('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) return { ok: false, reason: 'User not found' };
  if (!/^\d{17}$/.test(user.steam_id)) return { ok: false, reason: 'Test account (not a real Steam ID)' };

  const summary = await fetchSummary(user.steam_id).catch(() => null);
  if (summary) {
    await q('UPDATE users SET persona_name=$2, avatar=$3, profile_url=$4 WHERE id=$1', [
      userId, summary.persona_name, summary.avatar || user.avatar, summary.profile_url,
    ]);
  }

  const result = { ok: true };
  if (process.env.STEAM_API_KEY) {
    result.steam = await syncSteam(user).catch((e) => ({ ok: false, reason: e.message }));
  } else {
    result.steam = { ok: false, reason: 'Steam API key not set up yet' };
  }
  result.wardogs = await syncWardogs(user).catch((e) => ({ ok: false, reason: e.message }));
  await q('UPDATE users SET last_sync=now() WHERE id=$1', [userId]);
  await recalcXp(userId);
  return result;
}

async function syncSteam(user) {
  const userId = user.id;
  const owned = await steamGet('/IPlayerService/GetOwnedGames/v1/', {
    steamid: user.steam_id,
    include_appinfo: 'false',
    include_played_free_games: 'true',
  }).catch(() => null);
  const ownedGames = owned?.response?.games;
  const isPrivate = !ownedGames;
  const byApp = new Map((ownedGames || []).map((g) => [g.appid, g]));

  const games = await q('SELECT * FROM games WHERE enabled = true');
  for (const game of games) {
    const g = byApp.get(game.app_id);
    if (!g) continue;
    let achUnlocked = 0;
    let achTotal = 0;
    const ach = await steamGet('/ISteamUserStats/GetPlayerAchievements/v1/', {
      steamid: user.steam_id,
      appid: game.app_id,
    }).catch(() => null);
    const list = ach?.playerstats?.achievements;
    if (Array.isArray(list)) {
      achTotal = list.length;
      achUnlocked = list.filter((a) => a.achieved === 1).length;
    }
    const statsRes = await steamGet('/ISteamUserStats/GetUserStatsForGame/v2/', {
      steamid: user.steam_id,
      appid: game.app_id,
    }).catch(() => null);
    const stats = Object.fromEntries((statsRes?.playerstats?.stats || []).map((s) => [s.name, s.value]));

    await q(
      `INSERT INTO user_games (user_id, app_id, playtime_forever, playtime_2weeks, ach_unlocked, ach_total, stats, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (user_id, app_id) DO UPDATE SET
         playtime_forever=EXCLUDED.playtime_forever, playtime_2weeks=EXCLUDED.playtime_2weeks,
         ach_unlocked=EXCLUDED.ach_unlocked, ach_total=EXCLUDED.ach_total, stats=EXCLUDED.stats, updated_at=now()`,
      [userId, game.app_id, g.playtime_forever || 0, g.playtime_2weeks || 0, achUnlocked, achTotal, JSON.stringify(stats)],
    );
  }

  await q('UPDATE users SET steam_private=$2 WHERE id=$1', [userId, isPrivate]);
  return { ok: true, private: isPrivate };
}

// Everything that earns WPG XP for a user right now: its running total and the XP rate in force.
// canDrop: whether a lower total should take XP back (only for stats admins/bots type in, i.e. corrections).
async function xpSources(userId) {
  const sources = [];
  const games = await q(
    `SELECT ug.app_id, ug.playtime_forever, ug.ach_unlocked, g.xp_per_hour, g.xp_per_achievement
       FROM user_games ug JOIN games g ON g.app_id = ug.app_id AND g.enabled = true WHERE ug.user_id = $1`,
    [userId],
  );
  for (const g of games) {
    sources.push({ source: `game:${g.app_id}:minutes`, value: Number(g.playtime_forever) || 0, rate: (Number(g.xp_per_hour) || 0) / 60 });
    sources.push({ source: `game:${g.app_id}:achievements`, value: Number(g.ach_unlocked) || 0, rate: Number(g.xp_per_achievement) || 0 });
  }
  const stats = await q(
    'SELECT us.key, us.value, d.xp_each FROM user_stats us JOIN stat_defs d ON d.key = us.key WHERE us.user_id = $1',
    [userId],
  );
  for (const s of stats) sources.push({ source: `stat:${s.key}`, value: Number(s.value) || 0, rate: Number(s.xp_each) || 0, canDrop: true });
  const ws = await one('SELECT server FROM wardogs_stats WHERE user_id=$1', [userId]);
  if (ws?.server && ws.server.kills !== undefined && ws.server.kills !== null) {
    sources.push({ source: 'kills', value: Number(ws.server.kills) || 0, rate: Number(await setting('xp_per_server_kill')) || 0 });
  }
  return sources;
}

// WPG XP = XP earned from activity (Steam hours/achievements, WPG server kills, server stats)
//        + bonus XP given by admins.
// Activity XP is added as it happens, at the rate in force when it's counted. Changing a rate
// (e.g. 10 XP per kill for an event) only affects new activity, never XP already earned.
export async function recalcXp(userId) {
  const user = await one('SELECT * FROM users WHERE id=$1', [userId]);
  if (!user) return;
  const sources = await xpSources(userId);
  let earned = Number(user.earned_xp) || 0;

  if (!user.xp_ledger) {
    // First time: start the ledger from today's totals at today's rates (same as the old sum).
    earned = sources.reduce((sum, s) => sum + s.value * s.rate, 0);
  } else {
    const rows = await q('SELECT source, last_value FROM xp_counters WHERE user_id=$1', [userId]);
    const last = new Map(rows.map((r) => [r.source, Number(r.last_value)]));
    for (const s of sources) {
      const before = last.has(s.source) ? last.get(s.source) : 0;
      let delta = s.value - before;
      if (delta < 0 && !s.canDrop) delta = 0; // e.g. a tracker hiccup must never take XP away
      earned += delta * s.rate;
    }
  }
  for (const s of sources) {
    await q(
      `INSERT INTO xp_counters (user_id, source, last_value, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (user_id, source) DO UPDATE SET
         last_value = CASE WHEN $4 THEN EXCLUDED.last_value ELSE GREATEST(xp_counters.last_value, EXCLUDED.last_value) END,
         updated_at = now()`,
      [userId, s.source, s.value, !!s.canDrop],
    );
  }
  earned = Math.max(0, earned);
  const updated = await one(
    'UPDATE users SET earned_xp=$2::numeric, xp_ledger=true, xp = GREATEST(0, FLOOR($2::numeric)::int + bonus_xp) WHERE id=$1 RETURNING *',
    [userId, earned],
  );
  await autoPromote(updated);
}

// Promotes (never demotes) through ranks marked "auto" once the member has enough XP.
export async function autoPromote(user) {
  if (!user || user.rank_locked || user.status !== 'active' || user.membership === 'pmc' || !(await flag('auto_promote'))) return;
  const current = user.rank_id ? await one('SELECT * FROM ranks WHERE id=$1', [user.rank_id]) : null;
  if (current && !current.auto) return;
  const target = await one(
    'SELECT * FROM ranks WHERE auto = true AND min_xp <= $1 ORDER BY sort_order DESC LIMIT 1',
    [user.xp],
  );
  if (!target || (current && target.sort_order <= current.sort_order)) return;
  await q('UPDATE users SET rank_id=$2 WHERE id=$1', [user.id, target.id]);
  await announceRankChange(user, current, target);
}

export async function announceRankChange(user, from, to) {
  bus.emit('user:changed', user.id);
  if (!to || (from && from.id === to.id)) return;
  const promoted = !from || to.sort_order > from.sort_order;
  bus.emit('notify', user.id, {
    title: promoted ? 'Promotion!' : 'Rank change',
    body: `You are now ${to.name} (${to.abbr}).`,
  });
  if (promoted && from && (await flag('announce_promotions'))) {
    const general = await one('SELECT id FROM channels ORDER BY sort_order LIMIT 1');
    if (general) {
      const msg = await one(
        'INSERT INTO messages (channel_id, user_id, body) VALUES ($1, NULL, $2) RETURNING *',
        [general.id, `${user.persona_name} has been promoted to ${to.name} (${to.abbr}). Salute!`],
      );
      bus.emit('chat:new', msg);
    }
  }
}

let timer;
export function startSyncLoop() {
  const run = async () => {
    try {
      {
        const minutes = Math.max(15, Number(await setting('sync_minutes')) || 60);
        const due = await q(
          `SELECT id FROM users WHERE status='active' AND steam_id ~ '^[0-9]{17}$'
             AND (last_sync IS NULL OR last_sync < now() - ($1 || ' minutes')::interval)
           ORDER BY last_sync NULLS FIRST LIMIT 50`,
          [String(minutes)],
        );
        for (const { id } of due) {
          await syncUser(id).catch((e) => console.warn('[sync] user', id, e.message));
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    } catch (e) {
      console.warn('[sync] loop error', e.message);
    }
    timer = setTimeout(run, 5 * 60 * 1000);
  };
  timer = setTimeout(run, 10 * 1000);
}
