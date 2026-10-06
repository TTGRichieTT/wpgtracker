// Situation rooms: a shared tactical map for one group during a match. WPG members only (not PMC guests).
//  - At most one open room per faction (Lonestar, Valkyra, Manticore), so at most 3 at once. Any WPG member can
//    open one; they pick the faction and the map (they may not be on our server).
//  - The room's creator and admins invite members, let in members who ask to join, remove people, change the map,
//    clear the board and close the room. Admins can also walk into any room.
//  - Members outside a room only see its name and who is in it, never its map.
//  - Everyone in the room places markers (my position, FOB, enemy, need, objective, danger) and draws (attack and
//    flank arrows, defend lines, routes, areas, labels); everyone in it sees them live.
//  - Positions and enemy spots go stale, so they expire; a room nobody has used for 30 minutes closes by itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { q, one, audit } from './db.js';
import { bus } from './bus.js';
import { usersWithRanks } from './routes.js';
import { isWpg } from './combat.js';
import { HttpError, member, roleAtLeast, str, int } from './util.js';

export const sitrooms = express.Router();

export const FACTIONS = [
  { id: 'lonestar', name: 'Lonestar', color: '#4cb1ef' },
  { id: 'valkyra', name: 'Valkyra', color: '#e5484d' },
  { id: 'manticore', name: 'Manticore', color: '#3ddc84' },
];
const FACTION_IDS = FACTIONS.map((f) => f.id);
const IDLE_CLOSE_MS = 30 * 60 * 1000;
const MAX_ITEMS = 300; // per room
const PER_MINUTE = 30; // markers / drawings each member can add a minute
const UNITS = 163.84; // map size in game units (as the arty map)

// Which markers and drawings exist, and how long markers last before they go stale.
const MARKERS = {
  me: { ttl: 2 * 60 * 1000 }, // my position (one each; refreshing it keeps it)
  fob: {},
  enemy: {}, // ttl by what it is (below)
  need: {},
  objective: {},
  danger: {},
};
// Enemy types and minutes before a sighting fades (0 = stays until removed: a spawn APC is a spawn point).
// vehicle / armour are older types, kept so marks made before still show.
const ENEMY = { infantry: 3, sniper: 3, mortar: 5, artillery: 5, tank: 5, apc: 0, armed: 5, supply: 5, air: 3, vehicle: 5, armour: 5 };
const enemyTtl = (what) => (ENEMY[what] ? ENEMY[what] * 60 * 1000 : null);
const NEEDS = ['ammo', 'build', 'fuel', 'mech', 'medic', 'transport', 'repair', 'fire', 'backup'];
const DRAWINGS = ['attack', 'flank', 'defend', 'route', 'area', 'label'];
// Drawing colours: "us" (the room's faction), each faction (the enemy factions' movement) and yellow (caution).
// blue / red / green are older colours, kept so drawings made before still show.
const COLORS = ['us', 'yellow', 'lonestar', 'valkyra', 'manticore', 'blue', 'red', 'green'];
// The two factions the room is fighting (3 teams, each against the other two).
const enemiesOf = (room) => FACTION_IDS.filter((f) => f !== room?.faction);

const MAP_IDS = (() => {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'maps', 'maps.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).map((m) => m.id);
  } catch {
    return [];
  }
})();

const isAdmin = (u) => roleAtLeast(u?.role, 'admin');
function wpgOnly(req, _res, next) {
  if (!isWpg(req.user)) throw new HttpError(403, 'Situation rooms are for WPG members only.');
  next();
}

// ---------- Reading rooms ----------
async function openRoom(id) {
  return one("SELECT * FROM sit_rooms WHERE id=$1 AND status='open'", [id]);
}
const isMember = async (roomId, userId) => !!(await one('SELECT 1 FROM sit_members WHERE room_id=$1 AND user_id=$2', [roomId, userId]));
const canManage = (room, user) => room.creator_id === user.id || isAdmin(user);

// Rooms as everyone sees them: faction, name and who is in it (not the map or anything on it).
async function slots(user) {
  const rooms = await q("SELECT * FROM sit_rooms WHERE status='open' ORDER BY id");
  const members = rooms.length ? await q('SELECT room_id, user_id FROM sit_members WHERE room_id = ANY($1) ORDER BY joined_at', [rooms.map((r) => r.id)]) : [];
  const ids = [...new Set([...members.map((m) => m.user_id), ...rooms.map((r) => r.creator_id).filter(Boolean)])];
  const users = new Map((ids.length ? await usersWithRanks(await q('SELECT * FROM users WHERE id = ANY($1)', [ids])) : []).map((u) => [u.id, u]));
  const mine = await q('SELECT room_id, kind FROM sit_requests WHERE user_id=$1', [user.id]);
  return FACTIONS.map((f) => {
    const r = rooms.find((x) => x.faction === f.id);
    if (!r) return { faction: f, room: null };
    const inIt = members.filter((m) => m.room_id === r.id).map((m) => users.get(m.user_id)).filter(Boolean);
    return {
      faction: f,
      room: {
        id: r.id, name: r.name, creator: users.get(r.creator_id) || null, members: inIt,
        mine: inIt.some((u) => u.id === user.id),
        invited: mine.some((x) => x.room_id === r.id && x.kind === 'invite'),
        asked: mine.some((x) => x.room_id === r.id && x.kind === 'ask'),
      },
    };
  });
}

// Everything inside a room (members of it and admins only).
async function roomFull(room, user) {
  const members = await q('SELECT user_id, joined_at, last_seen FROM sit_members WHERE room_id=$1 ORDER BY joined_at', [room.id]);
  const requests = canManage(room, user) ? await q('SELECT user_id, kind, created_at FROM sit_requests WHERE room_id=$1 ORDER BY created_at', [room.id]) : [];
  const items = await q('SELECT id, user_id, kind, type, data, created_at, updated_at, expires_at FROM sit_items WHERE room_id=$1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY id', [room.id]);
  const messages = (await q('SELECT id, user_id, body, created_at FROM sit_messages WHERE room_id=$1 ORDER BY id DESC LIMIT 60', [room.id])).reverse();
  const ids = [...new Set([...members.map((m) => m.user_id), ...requests.map((r) => r.user_id), ...items.map((i) => i.user_id).filter(Boolean), ...messages.map((m) => m.user_id).filter(Boolean), room.creator_id].filter(Boolean))];
  const users = ids.length ? await usersWithRanks(await q('SELECT * FROM users WHERE id = ANY($1)', [ids])) : [];
  return {
    room: { id: room.id, faction: FACTIONS.find((f) => f.id === room.faction), name: room.name, map_id: room.map_id, creator_id: room.creator_id, created_at: room.created_at },
    members: members.map((m) => ({ user_id: m.user_id, joined_at: m.joined_at, last_seen: m.last_seen })),
    requests,
    items,
    messages,
    users,
    can_manage: canManage(room, user),
    is_member: members.some((m) => m.user_id === user.id),
  };
}

// ---------- Live updates ----------
const roomEvent = (roomId, type, data = {}) => bus.emit('sit:room', roomId, { type, ...data });
const listChanged = () => bus.emit('sit:list');
async function touch(roomId, userId) {
  await q('UPDATE sit_rooms SET last_active_at=now() WHERE id=$1', [roomId]);
  if (userId) await q('UPDATE sit_members SET last_seen=now() WHERE room_id=$1 AND user_id=$2', [roomId, userId]);
}
const notify = (userId, title, body, link) => bus.emit('notify', userId, { title, body, link });

// A copy of the board for admins, taken before it's cleared (new match, map change, room closed). Only if
// there was something on it.
async function archive(room, reason) {
  const items = await q('SELECT user_id, kind, type, data, created_at FROM sit_items WHERE room_id=$1 ORDER BY id', [room.id]);
  const messages = await q('SELECT user_id, body, created_at FROM sit_messages WHERE room_id=$1 ORDER BY id', [room.id]);
  if (!items.length && !messages.length) return;
  const members = await q('SELECT u.id, u.persona_name AS name FROM sit_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 ORDER BY m.joined_at', [room.id]);
  await q(
    'INSERT INTO sit_archives (room_id, faction, name, map_id, reason, items, members, messages) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [room.id, room.faction, room.name, room.map_id, reason, JSON.stringify(items), JSON.stringify(members), JSON.stringify(messages)],
  );
}

async function closeRoom(room, byUserId, why) {
  await archive(room, why).catch((e) => console.warn('[sitrooms] archive', e.message));
  await q("UPDATE sit_rooms SET status='closed', closed_at=now(), closed_by=$2 WHERE id=$1", [room.id, byUserId || null]);
  await q('DELETE FROM sit_messages WHERE room_id=$1', [room.id]);
  const left = await q('DELETE FROM sit_members WHERE room_id=$1 RETURNING user_id', [room.id]);
  await q('DELETE FROM sit_requests WHERE room_id=$1', [room.id]);
  await q('DELETE FROM sit_items WHERE room_id=$1', [room.id]);
  roomEvent(room.id, 'closed', { why });
  for (const m of left) if (m.user_id !== byUserId) notify(m.user_id, 'Situation room closed', `"${room.name}" was ${why}.`, '#/sitrooms');
  listChanged();
}

// Someone left or was removed: if it was the creator, the longest-serving member takes over; empty rooms close.
async function afterLeaving(room, userId) {
  const rest = await q('SELECT user_id FROM sit_members WHERE room_id=$1 ORDER BY joined_at', [room.id]);
  if (!rest.length) return closeRoom(room, userId, 'closed (everyone left)');
  if (room.creator_id === userId) {
    await q('UPDATE sit_rooms SET creator_id=$2 WHERE id=$1', [room.id, rest[0].user_id]);
    notify(rest[0].user_id, 'You run the situation room now', `You took over "${room.name}".`, `#/sitrooms/${room.id}`);
  }
  roomEvent(room.id, 'members');
  listChanged();
}

async function joinRoom(room, userId) {
  const other = await one("SELECT r.id, r.name FROM sit_members m JOIN sit_rooms r ON r.id=m.room_id WHERE m.user_id=$1 AND r.status='open' AND r.id<>$2", [userId, room.id]);
  if (other) throw new HttpError(400, `Leave "${other.name}" first: you can be in one situation room at a time.`);
  await q('INSERT INTO sit_members (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [room.id, userId]);
  await q('DELETE FROM sit_requests WHERE room_id=$1 AND user_id=$2', [room.id, userId]);
  await touch(room.id, userId);
  roomEvent(room.id, 'members');
  listChanged();
}

// ---------- Routes: rooms ----------
const roomParam = async (req) => {
  const room = await openRoom(int(req.params.id));
  if (!room) throw new HttpError(404, 'That situation room has closed.');
  return room;
};
const manager = (room, user) => { if (!canManage(room, user)) throw new HttpError(403, 'Only the room\'s creator or an admin can do that.'); };

sitrooms.get('/sitrooms', member, wpgOnly, async (req, res) => {
  const faction = await one("SELECT key FROM profile_fields WHERE type='select' AND options ILIKE '%lonestar%' AND options ILIKE '%valkyra%' LIMIT 1");
  const myFaction = String(faction ? req.user.custom_fields?.[faction.key] || '' : '').toLowerCase();
  const current = await one("SELECT r.id FROM sit_members m JOIN sit_rooms r ON r.id=m.room_id WHERE m.user_id=$1 AND r.status='open'", [req.user.id]);
  res.json({ slots: await slots(req.user), my_faction: FACTION_IDS.includes(myFaction) ? myFaction : '', my_room: current?.id || null, maps: MAP_IDS, is_admin: isAdmin(req.user) });
});

sitrooms.post('/sitrooms', member, wpgOnly, async (req, res) => {
  const faction = str(req.body?.faction, 20).toLowerCase();
  const mapId = str(req.body?.map, 40);
  if (!FACTION_IDS.includes(faction)) throw new HttpError(400, 'Pick a faction.');
  if (!MAP_IDS.includes(mapId)) throw new HttpError(400, 'Pick the map you\'re playing on.');
  const taken = await one("SELECT name FROM sit_rooms WHERE status='open' AND faction=$1", [faction]);
  if (taken) throw new HttpError(400, `There's already a ${FACTIONS.find((f) => f.id === faction).name} room ("${taken.name}"). Ask to join it instead.`);
  const other = await one("SELECT r.name FROM sit_members m JOIN sit_rooms r ON r.id=m.room_id WHERE m.user_id=$1 AND r.status='open'", [req.user.id]);
  if (other) throw new HttpError(400, `Leave "${other.name}" first: you can be in one situation room at a time.`);
  const name = str(req.body?.name, 40) || `${req.user.persona_name}'s room`;
  const room = await one('INSERT INTO sit_rooms (faction, name, map_id, creator_id) VALUES ($1,$2,$3,$4) RETURNING *', [faction, name, mapId, req.user.id]);
  // Two people creating the same faction's room at the same moment: the later one gives way.
  const first = await one("SELECT id FROM sit_rooms WHERE status='open' AND faction=$1 ORDER BY id LIMIT 1", [faction]);
  if (first.id !== room.id) {
    await q("UPDATE sit_rooms SET status='closed', closed_at=now() WHERE id=$1", [room.id]);
    throw new HttpError(400, 'Someone opened that faction\'s room a moment before you. Ask to join it instead.');
  }
  await q('INSERT INTO sit_members (room_id, user_id) VALUES ($1,$2)', [room.id, req.user.id]);
  await audit(req.user.id, 'sitroom.open', String(room.id), { faction, map: mapId });
  listChanged();
  res.json({ id: room.id });
});

sitrooms.get('/sitrooms/:id', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  if (!(await isMember(room.id, req.user.id)) && !isAdmin(req.user)) throw new HttpError(403, 'Only people in this room can see its map. Ask to join it.');
  await touch(room.id, req.user.id);
  res.json(await roomFull(room, req.user));
});

// Name or map (creator / admin). A new map clears the board.
sitrooms.put('/sitrooms/:id', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  manager(room, req.user);
  const name = req.body?.name !== undefined ? str(req.body.name, 40) || room.name : room.name;
  const mapId = req.body?.map !== undefined ? str(req.body.map, 40) : room.map_id;
  if (!MAP_IDS.includes(mapId)) throw new HttpError(400, 'Unknown map.');
  await q('UPDATE sit_rooms SET name=$2, map_id=$3, last_active_at=now() WHERE id=$1', [room.id, name, mapId]);
  if (mapId !== room.map_id) {
    await archive(room, `map changed by ${req.user.persona_name}`);
    await q('DELETE FROM sit_items WHERE room_id=$1', [room.id]);
  }
  roomEvent(room.id, 'room', { by: req.user.persona_name });
  listChanged();
  res.json({ ok: true });
});

sitrooms.post('/sitrooms/:id/clear', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  manager(room, req.user);
  await archive(room, `new match (cleared by ${req.user.persona_name})`);
  await q('DELETE FROM sit_items WHERE room_id=$1', [room.id]);
  await touch(room.id, req.user.id);
  roomEvent(room.id, 'cleared', { by: req.user.persona_name });
  res.json({ ok: true });
});

sitrooms.post('/sitrooms/:id/close', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  manager(room, req.user);
  await audit(req.user.id, 'sitroom.close', String(room.id));
  await closeRoom(room, req.user.id, `closed by ${req.user.persona_name}`);
  res.json({ ok: true });
});

// Invite members (creator / admin). WPG members only; anyone already in another room can still be invited.
sitrooms.post('/sitrooms/:id/invite', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  manager(room, req.user);
  const ids = (Array.isArray(req.body?.users) ? req.body.users : []).map((v) => int(v)).filter(Boolean).slice(0, 30);
  const people = ids.length ? await q('SELECT * FROM users WHERE id = ANY($1)', [ids]) : [];
  let sent = 0;
  for (const u of people.filter((p) => isWpg(p))) {
    if (await isMember(room.id, u.id)) continue;
    await q(
      `INSERT INTO sit_requests (room_id, user_id, kind, from_id) VALUES ($1,$2,'invite',$3)
       ON CONFLICT (room_id, user_id) DO UPDATE SET kind='invite', from_id=$3, created_at=now()`,
      [room.id, u.id, req.user.id],
    );
    notify(u.id, 'Situation room invite', `${req.user.persona_name} invited you to "${room.name}" (${FACTIONS.find((f) => f.id === room.faction).name}).`, '#/sitrooms');
    sent++;
  }
  if (sent) { roomEvent(room.id, 'requests'); listChanged(); }
  res.json({ ok: true, sent });
});

// Ask to join (any WPG member). The creator gets told; the creator or an admin lets them in.
sitrooms.post('/sitrooms/:id/ask', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  if (await isMember(room.id, req.user.id)) return res.json({ ok: true });
  const other = await one("SELECT r.name FROM sit_members m JOIN sit_rooms r ON r.id=m.room_id WHERE m.user_id=$1 AND r.status='open'", [req.user.id]);
  if (other) throw new HttpError(400, `Leave "${other.name}" first: you can be in one situation room at a time.`);
  const invited = await one("SELECT 1 FROM sit_requests WHERE room_id=$1 AND user_id=$2 AND kind='invite'", [room.id, req.user.id]);
  if (invited) { await joinRoom(room, req.user.id); return res.json({ ok: true, joined: true }); }
  await q("INSERT INTO sit_requests (room_id, user_id, kind, from_id) VALUES ($1,$2,'ask',$2) ON CONFLICT DO NOTHING", [room.id, req.user.id]);
  if (room.creator_id) notify(room.creator_id, 'Asking to join your situation room', `${req.user.persona_name} wants to join "${room.name}".`, `#/sitrooms/${room.id}`);
  roomEvent(room.id, 'requests');
  listChanged();
  res.json({ ok: true });
});

// Accept or decline. Invites: the invited member answers. Asks: the creator or an admin answers.
sitrooms.post('/sitrooms/:id/requests/:userId/:answer', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  const userId = int(req.params.userId);
  const yes = req.params.answer === 'accept';
  if (!yes && req.params.answer !== 'decline') throw new HttpError(404, 'Not found');
  const r = await one('SELECT * FROM sit_requests WHERE room_id=$1 AND user_id=$2', [room.id, userId]);
  if (!r) throw new HttpError(404, 'That invite or request has gone.');
  if (r.kind === 'invite' && userId !== req.user.id) throw new HttpError(403, 'Only the invited member can answer that.');
  if (r.kind === 'ask') manager(room, req.user);
  if (yes) {
    await joinRoom(room, userId);
    if (r.kind === 'ask') notify(userId, 'You\'re in', `You joined the situation room "${room.name}".`, `#/sitrooms/${room.id}`);
  } else {
    await q('DELETE FROM sit_requests WHERE room_id=$1 AND user_id=$2', [room.id, userId]);
    if (r.kind === 'ask') notify(userId, 'Not this time', `You weren't let into "${room.name}".`, '#/sitrooms');
    roomEvent(room.id, 'requests');
    listChanged();
  }
  res.json({ ok: true, room: yes ? room.id : null });
});

// Admins can walk into any room.
sitrooms.post('/sitrooms/:id/join', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  if (!isAdmin(req.user)) throw new HttpError(403, 'Ask to join instead.');
  await joinRoom(room, req.user.id);
  res.json({ ok: true });
});

sitrooms.post('/sitrooms/:id/leave', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  await q('DELETE FROM sit_members WHERE room_id=$1 AND user_id=$2', [room.id, req.user.id]);
  await q("DELETE FROM sit_items WHERE room_id=$1 AND user_id=$2 AND type IN ('me','gun')", [room.id, req.user.id]);
  await afterLeaving(room, req.user.id);
  res.json({ ok: true });
});

sitrooms.post('/sitrooms/:id/remove/:userId', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  manager(room, req.user);
  const userId = int(req.params.userId);
  await q('DELETE FROM sit_members WHERE room_id=$1 AND user_id=$2', [room.id, userId]);
  await q("DELETE FROM sit_items WHERE room_id=$1 AND user_id=$2 AND type IN ('me','gun')", [room.id, userId]);
  notify(userId, 'Removed from situation room', `You were removed from "${room.name}".`, '#/sitrooms');
  roomEvent(room.id, 'removed', { user_id: userId });
  await afterLeaving(room, userId);
  res.json({ ok: true });
});

// ---------- Routes: markers and drawings ----------
const clampPoint = (p) => {
  const x = Number(p?.x);
  const y = Number(p?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > UNITS || y > UNITS) throw new HttpError(400, 'That spot is off the map.');
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
};

// Cleans what a member sent into what we store. Returns { data, ttl }.
function cleanItem(kind, type, body, room) {
  if (kind === 'marker') {
    if (!MARKERS[type]) throw new HttpError(400, 'Unknown marker.');
    const data = { at: clampPoint(body.at), note: str(body.note, 80) };
    let ttl = MARKERS[type].ttl || null;
    if (type === 'enemy') {
      data.what = Object.keys(ENEMY).includes(body.what) ? body.what : 'infantry';
      data.count = Math.max(1, Math.min(50, int(body.count, 1)));
      data.side = enemiesOf(room).includes(body.side) ? body.side : enemiesOf(room)[0];
      ttl = enemyTtl(data.what);
    }
    if (type === 'need') data.need = NEEDS.includes(body.need) ? body.need : 'ammo';
    if (type === 'fob') data.name = str(body.name, 30);
    if (type === 'objective') data.goal = body.goal === 'defend' ? 'defend' : 'attack';
    if (type === 'danger') data.what = ['mines', 'sniper', 'other'].includes(body.what) ? body.what : 'other';
    return { data, ttl };
  }
  if (kind === 'draw') {
    if (!DRAWINGS.includes(type)) throw new HttpError(400, 'Unknown drawing.');
    const pts = (Array.isArray(body.points) ? body.points : []).slice(0, 40).map(clampPoint);
    const need = type === 'label' ? 1 : type === 'area' ? 3 : 2;
    if (pts.length < need) throw new HttpError(400, type === 'area' ? 'Tap at least 3 corners.' : 'Tap at least 2 points.');
    const data = { points: pts, color: COLORS.includes(body.color) ? body.color : type === 'flank' || type === 'attack' ? 'us' : 'yellow' };
    if (type === 'label') {
      data.text = str(body.text, 40);
      if (!data.text) throw new HttpError(400, 'Type the label.');
    }
    return { data, ttl: null };
  }
  throw new HttpError(400, 'Unknown item.');
}

const recent = new Map(); // userId -> times of recent adds
function rateLimit(userId) {
  const now = Date.now();
  const list = (recent.get(userId) || []).filter((t) => now - t < 60 * 1000);
  if (list.length >= PER_MINUTE) throw new HttpError(429, 'Slow down: that\'s a lot of marks in a minute.');
  list.push(now);
  recent.set(userId, list);
}
async function memberOrThrow(room, user) {
  if (!(await isMember(room.id, user.id))) throw new HttpError(403, 'Join the room first.');
}
const itemOut = (i) => ({ id: i.id, user_id: i.user_id, kind: i.kind, type: i.type, data: i.data, created_at: i.created_at, updated_at: i.updated_at, expires_at: i.expires_at });

sitrooms.post('/sitrooms/:id/items', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  await memberOrThrow(room, req.user);
  rateLimit(req.user.id);
  const kind = str(req.body?.kind, 10);
  const type = str(req.body?.type, 20);
  // A shared gun: one per member, with its range from the gun tables, so the room sees who can reach what.
  if (kind === 'gun') {
    const gun = await one('SELECT id, label, min_m, max_m FROM artillery WHERE id=$1', [str(req.body?.weapon, 60)]);
    if (!gun) throw new HttpError(400, 'Pick your gun.');
    const data = { at: clampPoint(req.body?.at), weapon: gun.id, label: gun.label, min: gun.min_m, max: gun.max_m };
    const gone = await q("DELETE FROM sit_items WHERE room_id=$1 AND user_id=$2 AND kind='gun' RETURNING id", [room.id, req.user.id]);
    for (const g of gone) roomEvent(room.id, 'item:removed', { id: g.id });
    const item = await one("INSERT INTO sit_items (room_id, user_id, kind, type, data) VALUES ($1,$2,'gun','gun',$3) RETURNING *", [room.id, req.user.id, JSON.stringify(data)]);
    await touch(room.id, req.user.id);
    roomEvent(room.id, 'item', { item: itemOut(item) });
    return res.json(itemOut(item));
  }
  const { data, ttl } = cleanItem(kind, type, req.body || {}, room);
  const count = await one('SELECT COUNT(*)::int AS n FROM sit_items WHERE room_id=$1', [room.id]);
  if (count.n >= MAX_ITEMS) throw new HttpError(400, 'The board is full: clear some marks first.');
  // "My position": one each, so placing it again moves it.
  if (type === 'me') {
    const gone = await q("DELETE FROM sit_items WHERE room_id=$1 AND user_id=$2 AND type='me' RETURNING id", [room.id, req.user.id]);
    for (const g of gone) roomEvent(room.id, 'item:removed', { id: g.id });
  }
  const item = await one(
    `INSERT INTO sit_items (room_id, user_id, kind, type, data, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [room.id, req.user.id, kind, type, JSON.stringify(data), ttl ? new Date(Date.now() + ttl) : null],
  );
  await touch(room.id, req.user.id);
  roomEvent(room.id, 'item', { item: itemOut(item) });
  res.json(itemOut(item));
});

// Change an item: move it or edit it (its owner), refresh a position / enemy spot (anyone in the room),
// or claim / finish a need (anyone in the room).
sitrooms.patch('/sitrooms/:id/items/:itemId', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  await memberOrThrow(room, req.user);
  const item = await one('SELECT * FROM sit_items WHERE id=$1 AND room_id=$2', [int(req.params.itemId), room.id]);
  if (!item) throw new HttpError(404, 'That mark has gone.');
  const action = str(req.body?.action, 20);
  let data = item.data;
  let expires = item.expires_at;
  if (action === 'refresh') {
    const ttl = item.type === 'me' ? MARKERS.me.ttl : item.type === 'enemy' ? enemyTtl(data.what) : null;
    if (!ttl) throw new HttpError(400, 'That mark doesn\'t expire.');
    expires = new Date(Date.now() + ttl);
  } else if (action === 'firing' || action === 'ceasefire') {
    // Fire mission: shows the room who is shelling this spot.
    if (!['enemy', 'danger', 'objective'].includes(item.type)) throw new HttpError(400, 'Fire missions are for enemy, danger and objective marks.');
    data = { ...data, firing_by: action === 'firing' ? req.user.id : null };
  } else if (action === 'claim' || action === 'unclaim') {
    if (item.type !== 'need') throw new HttpError(400, 'Only requests can be claimed.');
    data = { ...data, claimed_by: action === 'claim' ? req.user.id : null };
  } else if (action === 'move' || action === 'edit') {
    if (item.user_id !== req.user.id && !canManage(room, req.user)) throw new HttpError(403, 'You can only change your own marks.');
    if (action === 'move') {
      if (item.kind === 'marker') data = { ...data, at: clampPoint(req.body?.at) };
      else {
        const pts = (Array.isArray(req.body?.points) ? req.body.points : []).slice(0, 40).map(clampPoint);
        if (pts.length !== data.points.length) throw new HttpError(400, 'Wrong number of points.');
        data = { ...data, points: pts };
      }
    } else {
      data = {
        ...cleanItem(item.kind, item.type, { ...data, ...req.body }, room).data,
        ...(item.kind === 'marker' ? { at: data.at } : { points: data.points }),
        claimed_by: data.claimed_by || null, firing_by: data.firing_by || null,
      };
    }
  } else {
    throw new HttpError(400, 'Unknown change.');
  }
  const out = await one('UPDATE sit_items SET data=$2, expires_at=$3, updated_at=now() WHERE id=$1 RETURNING *', [item.id, JSON.stringify(data), expires]);
  await touch(room.id, req.user.id);
  roomEvent(room.id, 'item', { item: itemOut(out) });
  res.json(itemOut(out));
});

// Remove a mark: its owner, the room's creator or an admin. A need can also be finished ("Done") by
// whoever placed it or claimed it.
sitrooms.delete('/sitrooms/:id/items/:itemId', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  await memberOrThrow(room, req.user);
  const item = await one('SELECT * FROM sit_items WHERE id=$1 AND room_id=$2', [int(req.params.itemId), room.id]);
  if (!item) return res.json({ ok: true });
  const claimed = item.type === 'need' && item.data?.claimed_by === req.user.id;
  if (item.user_id !== req.user.id && !claimed && !canManage(room, req.user)) throw new HttpError(403, 'You can only remove your own marks.');
  await q('DELETE FROM sit_items WHERE id=$1', [item.id]);
  await touch(room.id, req.user.id);
  roomEvent(room.id, 'item:removed', { id: item.id });
  res.json({ ok: true });
});

// ---------- Room text box ----------
sitrooms.post('/sitrooms/:id/messages', member, wpgOnly, async (req, res) => {
  const room = await roomParam(req);
  await memberOrThrow(room, req.user);
  if (req.user.muted_until && new Date(req.user.muted_until) > new Date()) {
    throw new HttpError(403, `You are muted until ${new Date(req.user.muted_until).toLocaleString('en-GB')}.`);
  }
  rateLimit(req.user.id);
  const body = str(req.body?.body, 300);
  if (!body) throw new HttpError(400, 'Message is empty.');
  const msg = await one('INSERT INTO sit_messages (room_id, user_id, body) VALUES ($1,$2,$3) RETURNING id, user_id, body, created_at', [room.id, req.user.id, body]);
  await q('DELETE FROM sit_messages WHERE room_id=$1 AND id < (SELECT id FROM sit_messages WHERE room_id=$1 ORDER BY id DESC OFFSET 199 LIMIT 1)', [room.id]);
  await touch(room.id, req.user.id);
  roomEvent(room.id, 'msg', { message: msg });
  res.json(msg);
});

// ---------- Last matches (admins) ----------
sitrooms.get('/sitrooms-archive', member, wpgOnly, async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Admins only.');
  const rows = await q(`SELECT id, faction, name, map_id, reason, created_at, jsonb_array_length(items) AS marks,
    jsonb_array_length(messages) AS messages, members FROM sit_archives ORDER BY id DESC LIMIT 30`);
  res.json(rows);
});
sitrooms.get('/sitrooms-archive/:id', member, wpgOnly, async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Admins only.');
  const a = await one('SELECT * FROM sit_archives WHERE id=$1', [int(req.params.id)]);
  if (!a) throw new HttpError(404, 'Not found.');
  const ids = [...new Set([...a.items.map((i) => i.user_id), ...a.messages.map((m) => m.user_id), ...a.members.map((m) => m.id)].filter(Boolean))];
  const users = ids.length ? await usersWithRanks(await q('SELECT * FROM users WHERE id = ANY($1)', [ids])) : [];
  res.json({ ...a, faction: FACTIONS.find((f) => f.id === a.faction) || { name: a.faction, color: '#888' }, users });
});

// The room's page sends this every minute while it's open (keeps the room from closing as idle).
export async function sitHeartbeat(roomId, userId) {
  if (await isMember(roomId, userId)) await touch(roomId, userId);
}
// Who may receive a room's live updates: its members, and admins.
export async function maySeeRoom(roomId, user) {
  if (!user || !isWpg(user)) return false;
  if (!(await openRoom(roomId))) return false;
  return isAdmin(user) || isMember(roomId, user.id);
}

// ---------- Tidying ----------
// Expired positions and enemy spots disappear; rooms nobody has used for 30 minutes close.
export function startSitRooms() {
  setInterval(async () => {
    try {
      const gone = await q('DELETE FROM sit_items WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING id, room_id');
      for (const g of gone) roomEvent(g.room_id, 'item:removed', { id: g.id });
      const idle = await q("SELECT * FROM sit_rooms WHERE status='open' AND last_active_at < now() - ($1 || ' milliseconds')::interval", [String(IDLE_CLOSE_MS)]);
      for (const r of idle) await closeRoom(r, null, 'closed (nobody used it for 30 minutes)');
      await q("DELETE FROM sit_archives WHERE created_at < now() - interval '14 days'");
    } catch (e) {
      console.warn('[sitrooms]', e.message);
    }
  }, 20 * 1000);
}
