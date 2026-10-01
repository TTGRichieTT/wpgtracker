import { Server } from 'socket.io';
import { q, one } from './db.js';
import { bus } from './bus.js';
import { usersWithRanks, visibleChannels } from './routes.js';
import { publicUser } from './util.js';
import { mentionedUserIds } from './mentions.js';
import { playingNow } from './playing.js';

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
    socket.emit('playing', playingNow());
    q('UPDATE users SET last_seen=now() WHERE id=$1', [user.id]).catch(() => {});

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
  bus.on('server:board', (serverId) => io.emit('server:board', serverId));
  bus.on('playing', (map) => io.emit('playing', map));
  bus.on('user:changed', (userId) => io.to(`u:${userId}`).emit('me:changed'));
  bus.on('friends:changed', (ids) => ids.forEach((id) => io.to(`u:${id}`).emit('friends:changed')));
  bus.on('user:kick', (userId) => io.in(`u:${userId}`).disconnectSockets(true));
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
