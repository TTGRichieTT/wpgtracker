import express from 'express';
import { q, one, getSettings, flag } from './db.js';
import { bus } from './bus.js';
import { syncUser, recalcXp } from './steam.js';
import { combatFor, isWpg, specialties } from './combat.js';
import { syncWardogs } from './wardogs.js';
import { rankProgress } from './wpgxp.js';
import { parseMentions, mentionedUserIds, mentionRecipients, plainText } from './mentions.js';
import {
  HttpError, signedIn, member, roleAtLeast, canSeeChannel, publicUser, str, int, bool, color, safeUrl, steamInviteAccount,
  issueRememberToken,
} from './util.js';
import { shownFrames } from './frames.js';

export const api = express.Router();

const PUBLIC_SETTINGS = ['clan_name', 'clan_tag', 'motto', 'welcome_message', 'discord_invite', 'facebook_url', 'accent_color', 'logo_url', 'require_approval', 'dm_friends_only'];

export async function rankMap() {
  const ranks = await q('SELECT * FROM ranks ORDER BY sort_order');
  return new Map(ranks.map((r) => [r.id, r]));
}
export async function usersWithRanks(users) {
  const [ranks, frames] = await Promise.all([rankMap(), shownFrames(users)]);
  return users.map((u) => u && { ...publicUser(u, ranks.get(u.rank_id)), frame: frames.get(u.id) || null });
}
async function userOut(u) {
  return (await usersWithRanks([u]))[0];
}

api.get('/settings/public', async (_req, res) => {
  const s = await getSettings();
  res.json(Object.fromEntries(PUBLIC_SETTINGS.map((k) => [k, s[k]])));
});

api.get('/me', signedIn, async (req, res) => {
  const unread = await one('SELECT COUNT(*)::int AS n FROM dms WHERE recipient_id=$1 AND read_at IS NULL', [req.user.id]);
  const requests = await one("SELECT COUNT(*)::int AS n FROM friends WHERE addressee_id=$1 AND status='pending'", [req.user.id]);
  const tracker = await one(
    `SELECT (official IS NOT NULL AND ranks->>'source'='wardogs.tools') AS linked,
            CASE WHEN ranks->>'source'='wardogs.tools' THEN ranks->>'state' END AS state,
            CASE WHEN ranks->>'source'='wardogs.tools' THEN ranks->>'polled_at' END AS polled_at,
            (ranks->>'source'='wardogs.tools' AND ranks->>'lost' = 'true') AS lost, relink_prompts
       FROM wardogs_stats WHERE user_id=$1`,
    [req.user.id],
  );
  const prog = await one('SELECT xp, rank_level, rank_name FROM server_progress WHERE steam_id=$1', [req.user.steam_id]);
  // Hand this device a "remember me" key once per sign-in, so it can sign back in if the cookie is lost.
  let rememberToken;
  if (!req.session.rememberSent) {
    rememberToken = await issueRememberToken(req.user.id);
    req.session.rememberSent = true;
  }
  res.json({
    user: await userOut(req.user),
    unread_dms: unread.n,
    friend_requests: requests.n,
    tracker_linked: !!tracker?.linked,
    // API-provided status (for example, active or paused); missing/unsynced are lookup outcomes.
    tracker_state: tracker?.state || null,
    tracker_polled_at: tracker?.polled_at || null,
    // wardogs.tools has stopped updating them for a day (status not active, or a linked account no longer found)
    // and they've been asked to relink (ranking.js); cleared as soon as it's updating them again.
    tracker_relink: !!tracker && tracker.relink_prompts > 0 && ((tracker.linked && !!tracker.state && tracker.state !== 'active') || !!tracker.lost),
    wpg_server: { xp: prog?.xp || 0, level: prog?.rank_level || 1, name: prog?.rank_name || 'RECRUIT I', ...(await rankProgress(prog?.xp)) },
    real_steam: /^\d{17}$/.test(req.user.steam_id),
    discord_linked: !!req.user.discord_id,
    ...(rememberToken ? { remember_token: rememberToken } : {}),
  });
});

// Links my Discord account using the code from the bot's /link command (works for 15 minutes).
api.post('/me/discord-link', member, async (req, res) => {
  const code = str(req.body?.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) throw new HttpError(400, 'Type the code the bot gave you.');
  const row = await one("DELETE FROM discord_link_codes WHERE code=$1 AND created_at > now() - interval '15 minutes' RETURNING *", [code]);
  if (!row) throw new HttpError(400, 'That code is wrong or has run out. Type /link in Discord again for a new one.');
  // One Discord account per member: take it off anyone else first.
  const before = await one('SELECT discord_id FROM users WHERE id=$1', [req.user.id]);
  if (before?.discord_id && before.discord_id !== row.discord_id) bus.emit('discord:unlinked', before.discord_id);
  await q("UPDATE users SET discord_id='' WHERE discord_id=$1 AND id<>$2", [row.discord_id, req.user.id]);
  await q('UPDATE users SET discord_id=$2 WHERE id=$1', [req.user.id, row.discord_id]);
  // Fill in the "Discord name" profile box if it's empty.
  if (row.discord_name && !req.user.custom_fields?.discord) {
    await q("UPDATE users SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || jsonb_build_object('discord', $2::text) WHERE id=$1", [req.user.id, row.discord_name]);
  }
  bus.emit('user:changed', req.user.id);
  res.json({ ok: true, discord_name: row.discord_name });
});
api.delete('/me/discord-link', member, async (req, res) => {
  const before = await one("SELECT discord_id FROM users WHERE id=$1 AND discord_id <> ''", [req.user.id]);
  await q("UPDATE users SET discord_id='' WHERE id=$1", [req.user.id]);
  if (before) bus.emit('discord:unlinked', before.discord_id);
  bus.emit('user:changed', req.user.id);
  res.json({ ok: true });
});

// Looks up my global stats on wardogs.tools now (e.g. just after I've linked my account there).
const trackerChecks = new Map();
api.post('/me/tracker-check', member, async (req, res) => {
  const last = trackerChecks.get(req.user.id) || 0;
  if (Date.now() - last < 10 * 1000) throw new HttpError(429, 'Checking too often.');
  trackerChecks.set(req.user.id, Date.now());
  const r = await syncWardogs(req.user, { force: true }).catch((e) => ({ ok: false, reason: e.message }));
  if (r.official && !r.cached) await recalcXp(req.user.id);
  res.json({ linked: !!r.official, state: r.state || null, reason: r.ok ? '' : r.reason });
});

// ---------- Profile ----------
api.put('/me/profile', member, async (req, res) => {
  const b = req.body || {};
  const fields = await q('SELECT * FROM profile_fields');
  const custom = { ...(req.user.custom_fields || {}) };
  for (const f of fields) {
    if (b.custom_fields && f.key in b.custom_fields) custom[f.key] = str(b.custom_fields[f.key], 200);
  }
  // Skills: only ones from the recruitment roles list (or ones they already had, if staff renamed the list since).
  let skills = Array.isArray(req.user.skills) ? req.user.skills : [];
  if (Array.isArray(b.skills)) {
    const allowed = new Set([...(await specialties()), ...skills]);
    skills = [...new Set(b.skills.map((s) => str(s, 60)))].filter((s) => allowed.has(s)).slice(0, 30);
  }
  // Friend request choices: kept as they are unless sent.
  const choice = (k) => (k in b ? bool(b[k]) : req.user[k] !== false);
  // Their Steam quick invite link: must be a Steam invite link.
  let invite = req.user.steam_invite || '';
  if ('steam_invite' in b) {
    invite = String(b.steam_invite || '').trim();
    if (invite) {
      const acct = steamInviteAccount(invite);
      if (acct === null) throw new HttpError(400, 'That isn\'t a Steam invite link. In Steam: Friends → Add a Friend → copy the Quick Invite link (it starts https://s.team/p/).');
    }
  }
  const u = await one(
    `UPDATE users SET callsign=$2, bio=$3, country=$4, custom_avatar=$5, banner_color=$6, custom_fields=$7, skills=$8,
            friend_requests=$9, steam_add_button=$10, steam_invite=$11
     WHERE id=$1 RETURNING *`,
    [req.user.id, str(b.callsign, 40), str(b.bio, 1000), str(b.country, 4), safeUrl(b.custom_avatar), color(b.banner_color, '#0d2238'), JSON.stringify(custom), JSON.stringify(skills),
      choice('friend_requests'), choice('steam_add_button'), invite.slice(0, 200)],
  );
  bus.emit('user:changed', u.id);
  res.json({ user: await userOut(u) });
});

api.post('/me/sync', member, async (req, res) => {
  const last = req.user.last_sync ? new Date(req.user.last_sync).getTime() : 0;
  if (Date.now() - last < 60 * 1000) throw new HttpError(429, 'Please wait a minute before syncing again.');
  res.json(await syncUser(req.user.id, { force: true }));
});

api.get('/profile-fields', member, async (_req, res) => {
  res.json(await q('SELECT * FROM profile_fields ORDER BY sort_order, id'));
});
// For Edit profile: the skills to pick from (the recruitment roles), and the ones ticked on their last application
// (offered until they pick their own).
api.get('/me/skills', member, async (req, res) => {
  const app = await one("SELECT skills FROM recruit_applications WHERE user_id=$1 AND jsonb_array_length(skills) > 0 ORDER BY created_at DESC LIMIT 1", [req.user.id]);
  res.json({ list: await specialties(), suggested: Array.isArray(app?.skills) ? app.skills : [] });
});
api.get('/ranks', member, async (_req, res) => {
  res.json(await q('SELECT * FROM ranks ORDER BY sort_order'));
});
// Current XP rates, for the "How to earn XP" guide on the Ranks page.
api.get('/xp-rules', member, async (_req, res) => {
  const s = await getSettings();
  const [stats, games] = await Promise.all([
    q('SELECT key, label, format, xp_each FROM stat_defs WHERE xp_each <> 0 ORDER BY sort_order, key'),
    q('SELECT name, xp_per_hour, xp_per_achievement FROM games WHERE enabled = true ORDER BY featured DESC, name'),
  ]);
  res.json({
    per_kill: Number(s.xp_per_server_kill) || 0,
    auto_promote: s.auto_promote === 'true',
    sync_minutes: Math.max(15, Number(s.sync_minutes) || 60),
    event: s.xp_event_message || '',
    stats: stats.map((d) => ({ key: d.key, label: d.label, format: d.format, xp: Number(d.xp_each) })),
    games: games.map((g) => ({ name: g.name, per_hour: g.xp_per_hour, per_achievement: g.xp_per_achievement })),
  });
});

api.get('/artillery', member, async (_req, res) => {
  const rows = await q('SELECT * FROM artillery ORDER BY sort_order, id');
  res.json(rows.map((r) => ({
    id: r.id, label: r.label, note: r.note, min: r.min_m, max: r.max_m,
    table: r.table_data.split('\n').map((l) => l.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)),
  })));
});

api.get('/unlocks', member, async (_req, res) => {
  res.json(await q('SELECT id, role, level, name, kind, cost, vendor_price, image, source FROM unlocks ORDER BY role, level, id'));
});

// Items this member has ticked as bought.
api.get('/me/unlocks', member, async (req, res) => {
  res.json(await q('SELECT role, name FROM user_unlocks WHERE user_id=$1', [req.user.id]));
});

// Tick/untick one item, or (with upTo) every item in a class up to a level.
api.post('/me/unlocks', member, async (req, res) => {
  const b = req.body || {};
  const role = str(b.role, 20);
  const bought = b.bought !== false;
  let names = [];
  if (b.upTo !== undefined) {
    names = (await q('SELECT name FROM unlocks WHERE role=$1 AND level <= $2', [role, int(b.upTo)])).map((r) => r.name);
  } else if (b.name) {
    names = [str(b.name, 80)];
  }
  for (const name of names) {
    if (bought) await q('INSERT INTO user_unlocks (user_id, role, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.user.id, role, name]);
    else await q('DELETE FROM user_unlocks WHERE user_id=$1 AND role=$2 AND name=$3', [req.user.id, role, name]);
  }
  res.json({ ok: true, changed: names.length });
});

api.get('/awards', member, async (_req, res) => {
  res.json(await q('SELECT * FROM awards ORDER BY sort_order, id'));
});
api.get('/games', member, async (_req, res) => {
  res.json(await q('SELECT * FROM games WHERE enabled = true ORDER BY featured DESC, name'));
});
api.get('/stat-defs', member, async (_req, res) => {
  res.json(await q('SELECT * FROM stat_defs ORDER BY sort_order, key'));
});

// ---------- Members & profiles ----------
api.get('/members', member, async (req, res) => {
  const search = str(req.query.search, 60);
  const rows = await q(
    `SELECT u.* FROM users u LEFT JOIN ranks r ON r.id = u.rank_id
      WHERE u.status='active' AND ($1 = '' OR u.persona_name ILIKE '%' || $1 || '%' OR u.callsign ILIKE '%' || $1 || '%')
      ORDER BY r.sort_order DESC NULLS LAST, u.xp DESC LIMIT 300`,
    [search],
  );
  res.json(await usersWithRanks(rows));
});

api.get('/users/:id', member, async (req, res) => {
  const u = await one("SELECT * FROM users WHERE id=$1 AND (status='active' OR $2)", [int(req.params.id), roleAtLeast(req.user.role, 'mod')]);
  if (!u) throw new HttpError(404, 'Member not found.');
  const [games, awards, wardogs, stats, friendship] = await Promise.all([
    q(
      `SELECT ug.*, g.name, g.stat_labels FROM user_games ug JOIN games g ON g.app_id = ug.app_id
        WHERE ug.user_id=$1 AND g.enabled = true ORDER BY g.featured DESC, ug.playtime_forever DESC`,
      [u.id],
    ),
    q(
      `SELECT ua.id, ua.reason, ua.given_at, a.name, a.description, a.colors, a.auto_rule, a.sort_order, a.rarity, a.points
         FROM user_awards ua JOIN awards a ON a.id = ua.award_id WHERE ua.user_id=$1 ORDER BY a.sort_order, ua.given_at`,
      [u.id],
    ),
    one(`SELECT ws.*, CASE WHEN ws.official IS NULL THEN NULL ELSE ${ACCOUNT_WORTH_SQL} END AS account_worth FROM wardogs_stats ws WHERE ws.user_id=$1`, [u.id]),
    q('SELECT key, value FROM user_stats WHERE user_id=$1', [u.id]),
    one(
      `SELECT * FROM friends WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)`,
      [req.user.id, u.id],
    ),
  ]);
  const serverRank = await one(
    `SELECT COUNT(*)::int + 1 AS pos FROM users WHERE status='active' AND xp > $1`,
    [u.xp],
  );
  // WPG server rank + WPG XP (separate from clan rank / clan XP).
  const prog = await one('SELECT xp, rank_level, rank_name FROM server_progress WHERE steam_id=$1', [u.steam_id]);
  const progPos = prog ? await one('SELECT COUNT(*)::int + 1 AS pos FROM server_progress WHERE xp > $1', [prog.xp]) : null;
  // Every achievement of each tracked game, marked earned or not (only games this member has synced).
  const medals = await q(
    `SELECT sa.app_id, g.name AS game, sa.api_name, sa.name, sa.description, sa.icon, sa.icon_gray,
            sa.percent::float AS percent, ua.unlocked_at, (ua.user_id IS NOT NULL) AS earned
       FROM steam_achievements sa
       JOIN games g ON g.app_id = sa.app_id AND g.enabled = true
       LEFT JOIN user_achievements ua ON ua.app_id = sa.app_id AND ua.api_name = sa.api_name AND ua.user_id = $1
      WHERE EXISTS (SELECT 1 FROM user_games ug WHERE ug.user_id = $1 AND ug.app_id = sa.app_id)
         OR ua.user_id IS NOT NULL
      ORDER BY g.featured DESC, g.name, (ua.user_id IS NULL), sa.percent ASC NULLS LAST, sa.sort_order`,
    [u.id],
  );
  let friend = 'none';
  if (friendship) {
    if (friendship.status === 'accepted') friend = 'friends';
    else friend = friendship.requester_id === req.user.id ? 'outgoing' : 'incoming';
  }
  const currentWardogs = wardogs?.ranks?.source === 'wardogs.tools'
    ? wardogs
    : wardogs ? { ...wardogs, official: null, ranks: null, account_worth: null } : null;
  res.json({
    user: await userOut(u),
    games,
    awards: topTierOnly(awards),
    medals,
    wardogs: currentWardogs?.official ? {
      ...currentWardogs,
      official: {
        ...currentWardogs.official,
        accountWorth: currentWardogs.account_worth === null || currentWardogs.account_worth === undefined ? null : Number(currentWardogs.account_worth),
      },
    } : currentWardogs || {},
    stats: Object.fromEntries(stats.map((s) => [s.key, Number(s.value)])),
    wpg_position: serverRank.pos,
    wpg_server: { xp: prog?.xp || 0, level: prog?.rank_level || 1, name: prog?.rank_name || 'RECRUIT I', position: progPos?.pos || null, ...(await rankProgress(prog?.xp)) },
    // Combat Command posting and roles: WPG members and staff only (not PMC guests).
    combat: isWpg(req.user) ? await combatFor(u.id) : null,
    friend,
  });
});

// Automatic medals in the same series (e.g. every Recon level medal, every hours medal, or every medal on one tracked
// stat such as WPG server kills) only show
// the highest one held, so a new tier replaces the old one on the ribbon rack.
export function topTierOnly(awards) {
  const series = (rule) => { const [kind, a] = String(rule || '').split(':'); return kind === 'class' || kind === 'stat' ? `${kind}:${a}` : kind; };
  const level = (rule) => Number(String(rule).split(':').pop()) || 0;
  const best = new Map();
  for (const a of awards) {
    if (!a.auto_rule) continue;
    const k = series(a.auto_rule);
    if (!best.has(k) || level(a.auto_rule) > level(best.get(k).auto_rule)) best.set(k, a);
  }
  return awards.filter((a) => !a.auto_rule || best.get(series(a.auto_rule)) === a);
}

// Account worth is shown only when the stats API supplies it; the app does not estimate it.
export const ACCOUNT_WORTH_SQL = `NULLIF(ws.official->>'worth', '')::bigint`;
api.get('/leaderboard', member, async (req, res) => {
  const by = str(req.query.by, 20);
  let rows;
  if (by === 'kills') {
    rows = await q(
      `SELECT u.*, COALESCE((ws.server->>'kills')::int, 0) AS score FROM users u
         LEFT JOIN wardogs_stats ws ON ws.user_id = u.id
        WHERE u.status='active' ORDER BY score DESC, u.xp DESC LIMIT 100`,
    );
  } else if (by === 'level') {
    rows = await q(
      `SELECT u.*, CASE WHEN ws.ranks->>'source'='wardogs.tools' THEN (ws.official->>'wardogLevel')::int END AS score FROM users u
         LEFT JOIN wardogs_stats ws ON ws.user_id = u.id
        WHERE u.status='active' ORDER BY score DESC NULLS LAST, u.xp DESC LIMIT 100`,
    );
  } else if (by === 'cash') {
    rows = await q(
      `SELECT u.*, CASE WHEN ws.ranks->>'source'='wardogs.tools' THEN (ws.official->>'cash')::bigint END AS score FROM users u
         LEFT JOIN wardogs_stats ws ON ws.user_id = u.id
        WHERE u.status='active' ORDER BY score DESC NULLS LAST, u.xp DESC LIMIT 100`,
    );
  } else if (by === 'worth') {
    rows = await q(
      `SELECT u.*, CASE WHEN ws.ranks->>'source'='wardogs.tools' THEN ${ACCOUNT_WORTH_SQL} END AS score FROM users u
         LEFT JOIN wardogs_stats ws ON ws.user_id = u.id
        WHERE u.status='active' ORDER BY score DESC NULLS LAST, u.xp DESC LIMIT 100`,
    );
  } else if (by === 'gold' || by === 'unlocks') {
    const key = { gold: 'gold', unlocks: 'unlocks' }[by];
    rows = await q(
      `SELECT u.*, CASE WHEN ws.ranks->>'source'='wardogs.tools' THEN (ws.official->>'${key}')::bigint END AS score FROM users u
         LEFT JOIN wardogs_stats ws ON ws.user_id = u.id
        WHERE u.status='active' ORDER BY score DESC NULLS LAST, u.xp DESC LIMIT 100`,
    );
  } else if (by === 'tonight') {
    // Match money read from Steam over the last 24 hours (members who switched live match money on; steambot.js).
    const { TONIGHT_ROWS } = await import('./steambot.js');
    rows = await q(
      `SELECT u.*, SUM(t.money)::int AS score FROM users u JOIN (${TONIGHT_ROWS}) t ON t.user_id = u.id
        WHERE u.status='active' GROUP BY u.id ORDER BY score DESC LIMIT 100`,
    );
  } else if (by === 'hours') {
    rows = await q(
      `SELECT u.*, COALESCE(SUM(ug.playtime_forever), 0)::int / 60 AS score FROM users u
         LEFT JOIN user_games ug ON ug.user_id = u.id
        WHERE u.status='active' GROUP BY u.id ORDER BY score DESC LIMIT 100`,
    );
  } else {
    rows = await q("SELECT u.*, u.xp AS score FROM users u WHERE u.status='active' ORDER BY u.xp DESC LIMIT 100");
  }
  const out = await usersWithRanks(rows);
  res.json(out.map((u, i) => ({ ...u, score: rows[i].score === null || rows[i].score === undefined ? null : Number(rows[i].score) })));
});

api.get('/announcements', member, async (_req, res) => {
  res.json(
    await q(
      `SELECT a.*, u.persona_name AS author FROM announcements a LEFT JOIN users u ON u.id = a.author_id
        ORDER BY a.pinned DESC, a.created_at DESC LIMIT 30`,
    ),
  );
});

// ---------- Friends ----------
api.get('/friends', member, async (req, res) => {
  const rows = await q(
    `SELECT f.*, u.* , f.status AS fstatus, f.created_at AS since FROM friends f
       JOIN users u ON u.id = CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END
      WHERE (f.requester_id=$1 OR f.addressee_id=$1) AND u.status='active'`,
    [req.user.id],
  );
  const users = await usersWithRanks(rows);
  const out = { friends: [], incoming: [], outgoing: [] };
  rows.forEach((r, i) => {
    if (r.fstatus === 'accepted') out.friends.push(users[i]);
    else if (r.requester_id === req.user.id) out.outgoing.push(users[i]);
    else out.incoming.push(users[i]);
  });
  res.json(out);
});

// Send a request, or accept one they sent you.
api.post('/friends/:id', member, async (req, res) => {
  const other = await one("SELECT id, persona_name, friend_requests FROM users WHERE id=$1 AND status='active'", [int(req.params.id)]);
  if (!other || other.id === req.user.id) throw new HttpError(400, 'You cannot add that member.');
  const incoming = await one('SELECT * FROM friends WHERE requester_id=$1 AND addressee_id=$2', [other.id, req.user.id]);
  // Accepting their request always works; a new request only if they take them.
  if (!incoming && other.friend_requests === false) throw new HttpError(403, `${other.persona_name} isn't taking friend requests.`);
  if (incoming) {
    await q("UPDATE friends SET status='accepted' WHERE requester_id=$1 AND addressee_id=$2", [other.id, req.user.id]);
    bus.emit('notify', other.id, { title: 'Friend request accepted', body: `${req.user.persona_name} accepted your request.` });
  } else {
    await q('INSERT INTO friends (requester_id, addressee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, other.id]);
    bus.emit('notify', other.id, { title: 'Friend request', body: `${req.user.persona_name} wants to be friends.`, link: '#/friends' });
  }
  bus.emit('friends:changed', [req.user.id, other.id]);
  res.json({ ok: true });
});

// Remove a friend, decline a request, or cancel your own.
api.delete('/friends/:id', member, async (req, res) => {
  const id = int(req.params.id);
  await q('DELETE FROM friends WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)', [req.user.id, id]);
  bus.emit('friends:changed', [req.user.id, id]);
  res.json({ ok: true });
});

// ---------- Chat ----------
async function visibleChannels(user) {
  const all = await q('SELECT * FROM channels ORDER BY sort_order, id');
  return all.filter((c) => canSeeChannel(user, c));
}
export { visibleChannels };

api.get('/channels', member, async (req, res) => {
  res.json(await visibleChannels(req.user));
});

const MESSAGE_SELECT = `SELECT m.id, m.channel_id, m.user_id, m.body, m.created_at, m.deleted FROM messages m`;

api.get('/channels/:id/messages', member, async (req, res) => {
  const ch = (await visibleChannels(req.user)).find((c) => c.id === int(req.params.id));
  if (!ch) throw new HttpError(404, 'Channel not found.');
  const before = int(req.query.before, 2147483647);
  const msgs = await q(
    `${MESSAGE_SELECT} WHERE m.channel_id=$1 AND m.id < $2 AND m.deleted = false ORDER BY m.id DESC LIMIT 60`,
    [ch.id, before],
  );
  const ids = [...new Set([...msgs.map((m) => m.user_id).filter(Boolean), ...mentionedUserIds(msgs)])];
  const users = ids.length ? await usersWithRanks(await q('SELECT * FROM users WHERE id = ANY($1)', [ids])) : [];
  res.json({ messages: msgs.reverse(), users });
});

function checkMuted(user) {
  if (user.muted_until && new Date(user.muted_until) > new Date()) {
    throw new HttpError(403, `You are muted until ${new Date(user.muted_until).toLocaleString('en-GB')}.`);
  }
}

api.post('/channels/:id/messages', member, async (req, res) => {
  checkMuted(req.user);
  const ch = (await visibleChannels(req.user)).find((c) => c.id === int(req.params.id));
  if (!ch) throw new HttpError(404, 'Channel not found.');
  if (ch.read_only && !roleAtLeast(req.user.role, 'mod')) throw new HttpError(403, 'Only staff can post here.');
  const body = str(req.body?.body, 2000);
  if (!body) throw new HttpError(400, 'Message is empty.');
  const mentions = parseMentions(body);
  if (mentions.groups.has('everyone') && !roleAtLeast(req.user.role, 'mod')) {
    throw new HttpError(403, 'Only mods and admins can mention @everyone.');
  }
  const msg = await one('INSERT INTO messages (channel_id, user_id, body) VALUES ($1,$2,$3) RETURNING *', [ch.id, req.user.id, body]);
  bus.emit('chat:new', msg);
  res.json(msg);

  try {
    const recipients = await mentionRecipients(mentions, ch, req.user.id);
    if (recipients.length) {
      const text = (await plainText(body)).slice(0, 120);
      const note = { title: `${req.user.persona_name} mentioned you in #${ch.name}`, body: text, link: `#/chat/${ch.id}` };
      for (const id of recipients) bus.emit('notify', id, note);
    }
  } catch (e) {
    console.warn('[chat] mention notify failed:', e.message);
  }
});

api.delete('/messages/:id', member, async (req, res) => {
  const msg = await one('SELECT * FROM messages WHERE id=$1', [int(req.params.id)]);
  if (!msg) throw new HttpError(404, 'Message not found.');
  if (msg.user_id !== req.user.id && !roleAtLeast(req.user.role, 'mod')) throw new HttpError(403, 'You can only delete your own messages.');
  await q('UPDATE messages SET deleted=true WHERE id=$1', [msg.id]);
  bus.emit('chat:deleted', msg);
  res.json({ ok: true });
});

// ---------- Private messages ----------
api.get('/dms', member, async (req, res) => {
  const rows = await q(
    `SELECT DISTINCT ON (other) other, id, body, created_at, sender_id FROM (
        SELECT CASE WHEN sender_id=$1 THEN recipient_id ELSE sender_id END AS other, id, body, created_at, sender_id
          FROM dms WHERE sender_id=$1 OR recipient_id=$1
     ) t ORDER BY other, id DESC`,
    [req.user.id],
  );
  const unread = await q(
    'SELECT sender_id, COUNT(*)::int AS n FROM dms WHERE recipient_id=$1 AND read_at IS NULL GROUP BY sender_id',
    [req.user.id],
  );
  const unreadBy = new Map(unread.map((r) => [r.sender_id, r.n]));
  const users = rows.length ? await usersWithRanks(await q('SELECT * FROM users WHERE id = ANY($1)', [rows.map((r) => r.other)])) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const convos = rows
    .map((r) => ({ user: byId.get(r.other), last: { body: r.body, created_at: r.created_at, mine: r.sender_id === req.user.id }, unread: unreadBy.get(r.other) || 0 }))
    .filter((c) => c.user)
    .sort((a, b) => new Date(b.last.created_at) - new Date(a.last.created_at));
  res.json(convos);
});

api.get('/dms/:userId', member, async (req, res) => {
  const other = await one('SELECT * FROM users WHERE id=$1', [int(req.params.userId)]);
  if (!other) throw new HttpError(404, 'Member not found.');
  const before = int(req.query.before, 2147483647);
  const msgs = await q(
    `SELECT * FROM dms WHERE ((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)) AND id < $3
      ORDER BY id DESC LIMIT 60`,
    [req.user.id, other.id, before],
  );
  await q('UPDATE dms SET read_at=now() WHERE sender_id=$2 AND recipient_id=$1 AND read_at IS NULL', [req.user.id, other.id]);
  bus.emit('dms:read', req.user.id);
  res.json({ user: await userOut(other), messages: msgs.reverse() });
});

api.post('/dms/:userId', member, async (req, res) => {
  checkMuted(req.user);
  const other = await one("SELECT * FROM users WHERE id=$1 AND status='active'", [int(req.params.userId)]);
  if (!other || other.id === req.user.id) throw new HttpError(400, 'You cannot message that member.');
  if ((await flag('dm_friends_only')) && !roleAtLeast(req.user.role, 'mod') && !roleAtLeast(other.role, 'mod')) {
    const f = await one(
      "SELECT 1 FROM friends WHERE status='accepted' AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))",
      [req.user.id, other.id],
    );
    if (!f) throw new HttpError(403, 'You can only message friends.');
  }
  const body = str(req.body?.body, 2000);
  if (!body) throw new HttpError(400, 'Message is empty.');
  const dm = await one('INSERT INTO dms (sender_id, recipient_id, body) VALUES ($1,$2,$3) RETURNING *', [req.user.id, other.id, body]);
  bus.emit('dm:new', dm, req.user);
  res.json(dm);
});
