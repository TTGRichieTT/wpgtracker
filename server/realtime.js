import { Server } from 'socket.io';
import { q, one } from './db.js';
import { bus } from './bus.js';
import { usersWithRanks, visibleChannels } from './routes.js';
import { publicUser } from './util.js';
import { mentionedUserIds } from './mentions.js';
import { playingNow } from './playing.js';
import { liveStreamCount } from './streams.js';
import { maySeeRoom, sitHeartbeat } from './sitrooms.js';

// Which release is running. Open tabs compare it after a reconnect and reload themselves onto a new release.
const APP_VERSION = (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 12);

export function startRealtime(httpServer, sessionMiddleware) {
  const io = new Server(httpServer, { cors: { origin: false } });
  io.engine.use(sessionMiddleware);

  const online = new Map(); // userId -> open socket count
  const broadcastPresence = () => io.emit('presence', [...online.keys()]);

  async function joinChannels(socket, user) {
    for (const room of socket.rooms) if (room.startsWith('c:')) socket.leave(room);
    for (const ch of await visibleChannels(user)) socket.join(`c:${ch.id}`);
  }

  io.on('connection', async (socket) => {
    const userId = socket.request.session?.userId;
    const user = userId ? await one('SELECT * FROM users WHERE id=$1', [userId]) : null;
    if (!user || user.status !== 'active') {
      socket.disconnect(true);
      return;
    }
    socket.data.userId = user.id;
    socket.join(`u:${user.id}`);
    await joinChannels(socket, user);
    online.set(user.id, (online.get(user.id) || 0) + 1);
    broadcastPresence();
    socket.emit('app:version', APP_VERSION);
    socket.emit('playing', playingNow());
    socket.emit('streams', liveStreamCount());
    q('UPDATE users SET last_seen=now() WHERE id=$1', [user.id]).catch(() => {});

    // Situation rooms: the room page asks for its live updates (members and admins only) and says it's still open.
    socket.on('sit:watch', async (roomId) => {
      const id = Number(roomId) || 0;
      const me = await one('SELECT * FROM users WHERE id=$1', [user.id]);
      for (const r of socket.rooms) if (r.startsWith('sit:') && r !== `sit:${id}`) socket.leave(r);
      if (id && (await maySeeRoom(id, me))) {
        socket.join(`sit:${id}`);
        sitHeartbeat(id, user.id).catch(() => {});
      }
    });
    socket.on('sit:unwatch', () => {
      for (const r of socket.rooms) if (r.startsWith('sit:')) socket.leave(r);
    });

    socket.on('typing', (channelId) => {
      if (socket.rooms.has(`c:${channelId}`)) {
        socket.to(`c:${channelId}`).emit('typing', { channelId, userId: user.id, name: user.persona_name });
      }
    });

    socket.on('disconnect', () => {
      const n = (online.get(user.id) || 1) - 1;
      if (n <= 0) online.delete(user.id);
      else online.set(user.id, n);
      broadcastPresence();
      q('UPDATE users SET last_seen=now() WHERE id=$1', [user.id]).catch(() => {});
    });
  });

  bus.on('chat:new', async (msg) => {
    const author = msg.user_id ? await one('SELECT * FROM users WHERE id=$1', [msg.user_id]) : null;
    const [user] = author ? await usersWithRanks([author]) : [null];
    const ids = mentionedUserIds([msg]);
    const mentioned = ids.length ? await usersWithRanks(await q('SELECT * FROM users WHERE id = ANY($1)', [ids])) : [];
    io.to(`c:${msg.channel_id}`).emit('chat:new', { message: msg, user, mentioned });
  });
  bus.on('chat:deleted', (msg) => io.to(`c:${msg.channel_id}`).emit('chat:deleted', { id: msg.id, channel_id: msg.channel_id }));
  bus.on('dm:new', (dm, sender) => {
    const payload = { dm, user: publicUser(sender) };
    io.to(`u:${dm.recipient_id}`).to(`u:${dm.sender_id}`).emit('dm:new', payload);
  });
  bus.on('dms:read', (userId) => io.to(`u:${userId}`).emit('counts'));
  bus.on('notify', (userId, n) => io.to(`u:${userId}`).emit('notify', n));
  bus.on('streams:changed', (n) => io.emit('streams', n));
  // Situation rooms: changes inside a room go to the people watching it; the list of rooms is just a nudge to reload.
  bus.on('sit:room', (roomId, ev) => {
    io.to(`sit:${roomId}`).emit('sit', { room: roomId, ...ev });
    if (ev.type === 'removed') io.in(`u:${ev.user_id}`).socketsLeave(`sit:${roomId}`);
    if (ev.type === 'closed') io.in(`sit:${roomId}`).socketsLeave(`sit:${roomId}`);
  });
  bus.on('sit:list', () => io.emit('sitrooms'));
  bus.on('stream:chat', async (msg) => {
    const author = await one('SELECT * FROM users WHERE id=$1', [msg.user_id]);
    const [user] = author ? await usersWithRanks([author]) : [null];
    io.emit('stream:chat', { message: msg, user });
  });
  bus.on('stream:chat:deleted', (d) => io.emit('stream:chat:deleted', d));
  bus.on('server:board', (serverId) => io.emit('server:board', serverId));
  bus.on('playing', (map) => io.emit('playing', map));
  bus.on('combat:changed', () => io.emit('combat'));
  bus.on('user:changed', (userId) => io.to(`u:${userId}`).emit('me:changed'));
  bus.on('friends:changed', (ids) => ids.forEach((id) => io.to(`u:${id}`).emit('friends:changed')));
  bus.on('user:kick', (userId) => io.in(`u:${userId}`).disconnectSockets(true));
  // Live kill feed to staff (cached list of staff, refreshed every minute; kills can come every few seconds).
  let staffIds = { at: 0, ids: [] };
  bus.on('killfeed:new', async (evs) => {
    if (Date.now() - staffIds.at > 60 * 1000) staffIds = { at: Date.now(), ids: (await q("SELECT id FROM users WHERE role IN ('mod','admin') AND status='active'")).map((r) => r.id) };
    staffIds.ids.forEach((id) => io.to(`u:${id}`).emit('killfeed', evs));
  });
  bus.on('staff:notify', async (n) => {
    const staff = await q("SELECT id FROM users WHERE role IN ('mod','admin') AND status='active'");
    staff.forEach((s) => io.to(`u:${s.id}`).emit('notify', n));
  });
  bus.on('config:changed', async (name) => {
    io.emit('config:changed', name);
    if (name === 'channels' || name === 'user') {
      for (const socket of await io.fetchSockets()) {
        const u = await one('SELECT * FROM users WHERE id=$1', [socket.data.userId]);
        if (u) await joinChannels(socket, u);
      }
    }
  });
  // Role changes affect which channels someone can see.
  bus.on('user:changed', async (userId) => {
    const u = await one('SELECT * FROM users WHERE id=$1', [userId]);
    if (!u) return;
    for (const socket of await io.in(`u:${userId}`).fetchSockets()) await joinChannels(socket, u);
  });

  return io;
}
