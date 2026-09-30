import express from 'express';
import { q, one, getSettings, flag } from './db.js';
import { bus } from './bus.js';
import { syncUser } from './steam.js';
import { parseMentions, mentionedUserIds, mentionRecipients, plainText } from './mentions.js';
import {
  HttpError, signedIn, member, roleAtLeast, publicUser, str, int, color, safeUrl,
} from './util.js';

export const api = express.Router();

const PUBLIC_SETTINGS = ['clan_name', 'clan_tag', 'motto', 'welcome_message', 'discord_invite', 'accent_color', 'logo_url', 'require_approval', 'dm_friends_only'];

export async function rankMap() {
  const ranks = await q('SELECT * FROM ranks ORDER BY sort_order');
  return new Map(ranks.map((r) => [r.id, r]));
}
export async function usersWithRanks(users) {
  const ranks = await rankMap();
  return users.map((u) => publicUser(u, ranks.get(u.rank_id)));
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
  res.json({ user: await userOut(req.user), unread_dms: unread.n, friend_requests: requests.n });
});

// ---------- Profile ----------
api.put('/me/profile', member, async (req, res) => {
  const b = req.body || {};
  const fields = await q('SELECT * FROM profile_fields');
  const custom = { ...(req.user.custom_fields || {}) };
  for (const f of fields) {
    if (b.custom_fields && f.key in b.custom_fields) custom[f.key] = str(b.custom_fields[f.key], 200);
  }
  const u = await one(
    `UPDATE users SET callsign=$2, bio=$3, country=$4, custom_avatar=$5, banner_color=$6, custom_fields=$7
     WHERE id=$1 RETURNING *`,
    [req.user.id, str(b.callsign, 40), str(b.bio, 1000), str(b.country, 4), safeUrl(b.custom_avatar), color(b.banner_color, '#0d2238'), JSON.stringify(custom)],
  );
  bus.emit('user:changed', u.id);
  res.json({ user: await userOut(u) });
});

api.post('/me/sync', member, async (req, res) => {
  const last = req.user.last_sync ? new Date(req.user.last_sync).getTime() : 0;
  if (Date.now() - last < 60 * 1000) throw new HttpError(429, 'Please wait a minute before syncing again.');
  res.json(await syncUser(req.user.id));
});

api.get('/profile-fields', member, async (_req, res) => {
  res.json(await q('SELECT * FROM profile_fields ORDER BY sort_order, id'));
});
api.get('/ranks', member, async (_req, res) => {
  res.json(await q('SELECT * FROM ranks ORDER BY sort_order'));
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
      `SELECT ua.id, ua.reason, ua.given_at, a.name, a.description, a.colors
         FROM user_awards ua JOIN awards a ON a.id = ua.award_id WHERE ua.user_id=$1 ORDER BY ua.given_at`,
      [u.id],
    ),
    one('SELECT * FROM wardogs_stats WHERE user_id=$1', [u.id]),
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
  let friend = 'none';
  if (friendship) {
    if (friendship.status === 'accepted') friend = 'friends';
    else friend = friendship.requester_id === req.user.id ? 'outgoing' : 'incoming';
  }
  res.json({
    user: await userOut(u),
    games,
    awards,
    wardogs: wardogs || {},
    stats: Object.fromEntries(stats.map((s) => [s.key, Number(s.value)])),
    wpg_position: serverRank.pos,
    friend,
  });
});

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
      `SELECT u.*, COALESCE((ws.official->>'wardogLevel')::int, 0) AS score FROM users u
         LEFT JOIN wardogs_stats ws ON ws.user_id = u.id
        WHERE u.status='active' ORDER BY score DESC, u.xp DESC LIMIT 100`,
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
  res.json(out.map((u, i) => ({ ...u, score: Number(rows[i].score) })));
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
  const other = await one("SELECT id FROM users WHERE id=$1 AND status='active'", [int(req.params.id)]);
  if (!other || other.id === req.user.id) throw new HttpError(400, 'You cannot add that member.');
  const incoming = await one('SELECT * FROM friends WHERE requester_id=$1 AND addressee_id=$2', [other.id, req.user.id]);
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
  return all.filter((c) => roleAtLeast(user.role, c.min_role));
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
