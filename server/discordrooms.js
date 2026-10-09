// Discord rooms and bot posts (Discord control → Rooms / Bot posts).
//  - Rooms: every channel on the server, kept in step with Discord (new, renamed, moved or deleted rooms and
//    categories show up in the app straight away; admins are told about new ones). Admins choose per room:
//      view only: members can read it but not post, start threads or use /commands (staff and the bot still can);
//      auto-clear: members' messages and the replies to their /commands are deleted after the room's time.
//    Auto-clear never deletes staff messages, the bot's own posts and announcements, other bots' posts or pinned
//    messages: those are removed by hand. Some rooms can't be auto-cleared at all (rules, logs, tickets, friend codes).
//  - Bot posts: messages the bot posts in a room the admin picks and keeps up to date (edited in place, pinned):
//    ready-made guides (the #stats-bot guide lists the member commands, staff ones hidden, and rebuilds itself
//    when commands change) and the admins' own posts, as a picture in the WPG artwork or plain text.
import crypto from 'node:crypto';
import { q, one } from './db.js';
import { bus } from './bus.js';
import { discordFetch, sendToChannel, editMessage, botReady, commandList, commandAccess, commandIds } from './discordbot.js';
import { guildId, loadMap, staffRoles } from './discordserver.js';
import { MOD_COMMANDS } from './discordmod.js';

const SITE = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://wpg-barracks.onrender.com').replace(/\/$/, '');
const BIT = {
  ADMIN: 1n << 3n, VIEW: 1n << 10n, SEND: 1n << 11n, MANAGE_MESSAGES: 1n << 13n, EMBED: 1n << 14n, ATTACH: 1n << 15n, HISTORY: 1n << 16n,
  COMMANDS: 1n << 31n, PUBLIC_THREADS: 1n << 35n, PRIVATE_THREADS: 1n << 36n, SEND_IN_THREADS: 1n << 38n, PIN: 1n << 51n,
};
// What view only takes away from members.
const MEMBER_POSTING = BIT.SEND | BIT.SEND_IN_THREADS | BIT.PUBLIC_THREADS | BIT.PRIVATE_THREADS | BIT.COMMANDS;
const BOT_NEEDS = BIT.VIEW | BIT.SEND | BIT.EMBED | BIT.ATTACH | BIT.HISTORY | BIT.MANAGE_MESSAGES;
const P = (n) => String(n);
const TEXT_TYPES = new Set([0, 5]); // text and announcement channels
const VOICE_TYPES = new Set([2, 13]); // voice and stage channels
export const CLEAR_CHOICES = [0, 5, 15, 30, 60, 360, 720, 1440, 4320, 10080, 20160]; // minutes (0 = off); 14 days is Discord's limit
const DAY = 86400e3;

// ---------- Rooms list: kept in step with Discord ----------
export async function syncRooms({ announce = false } = {}) {
  const guild = await guildId();
  if (!guild || !botReady()) return { ok: false, reason: 'No Discord server set (Discord control → Server).' };
  const channels = await discordFetch(`/guilds/${guild}/channels`);
  const have = new Map((await q('SELECT channel_id FROM discord_rooms WHERE guild_id=$1', [guild])).map((r) => [r.channel_id, r]));
  const seen = new Set();
  for (const c of channels) {
    seen.add(c.id);
    const isNew = !have.has(c.id);
    await saveRoom(guild, c);
    if (isNew && announce) newRoomNotice(c, channels);
  }
  const gone = [...have.keys()].filter((id) => !seen.has(id));
  if (gone.length) {
    await q('DELETE FROM discord_rooms WHERE channel_id = ANY($1)', [gone]);
    await q('DELETE FROM discord_bot_posts WHERE channel_id = ANY($1)', [gone]);
  }
  bus.emit('config:changed', 'discord-rooms');
  return { ok: true, rooms: channels.length, removed: gone.length };
}
async function saveRoom(guild, c) {
  await q(`INSERT INTO discord_rooms (channel_id, guild_id, name, type, parent_id, position) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (channel_id) DO UPDATE SET guild_id=EXCLUDED.guild_id, name=EXCLUDED.name, type=EXCLUDED.type, parent_id=EXCLUDED.parent_id, position=EXCLUDED.position`,
  [c.id, guild, String(c.name || '').slice(0, 100), Number(c.type) || 0, c.parent_id || '', Number(c.position) || 0]);
}
function newRoomNotice(c, channels = []) {
  const cat = c.parent_id ? channels.find((x) => x.id === c.parent_id)?.name : '';
  const what = c.type === 4 ? 'category' : c.type === 2 ? 'voice room' : 'room';
  bus.emit('staff:notify', {
    title: `New Discord ${what}: ${c.type === 4 ? c.name : `#${c.name}`}`,
    body: `${cat ? `In ${cat}. ` : ''}Set it up in Discord control → Rooms (view only, auto-clear, bot posts).`,
    link: '#/discord?s=rooms',
  });
}

// Live from the gateway: rooms and categories made, changed or deleted in Discord.
bus.on('discord:event', async ({ t, d }) => {
  try {
    if (!['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'GUILD_CREATE'].includes(t)) return;
    const guild = await guildId();
    if (!guild) return;
    if (t === 'GUILD_CREATE') { if (d.id === guild) await syncRooms({ announce: true }); return; }
    if (d.guild_id !== guild) return;
    if (t === 'CHANNEL_DELETE') {
      await q('DELETE FROM discord_rooms WHERE channel_id=$1', [d.id]);
      await q('DELETE FROM discord_bot_posts WHERE channel_id=$1', [d.id]);
    } else {
      const isNew = !(await one('SELECT 1 FROM discord_rooms WHERE channel_id=$1', [d.id]));
      await saveRoom(guild, d);
      if (isNew && t === 'CHANNEL_CREATE') {
        const parent = d.parent_id ? await one('SELECT name FROM discord_rooms WHERE channel_id=$1', [d.parent_id]) : null;
        newRoomNotice(d, parent ? [{ id: d.parent_id, name: parent.name }] : []);
      }
    }
    bus.emit('config:changed', 'discord-rooms');
  } catch (e) {
    console.warn('[rooms] channel event', e.message);
  }
});

// Rooms auto-clear can never touch: the rules, the logs, tickets and the Steam friend codes.
async function protectedRooms(guild) {
  const map = await loadMap(guild);
  const ch = map.channels || {};
  const ids = new Set(['start:rules', 'staff:mod-log', 'staff:warcon-admin-log', 'staff:app-admin-log', 'community:steam-friend-codes'].map((k) => ch[k]).filter(Boolean));
  const tickets = ch['cat:tickets'];
  const rows = await q('SELECT channel_id, name, parent_id FROM discord_rooms WHERE guild_id=$1', [guild]);
  for (const r of rows) {
    if (tickets && (r.parent_id === tickets || r.channel_id === tickets)) ids.add(r.channel_id);
    if (/(^|-)(rules|mod-log|admin-log|steam-friend-codes)$/.test(r.name) || /^ticket-/.test(r.name)) ids.add(r.channel_id);
  }
  return ids;
}

export async function roomsOverview() {
  const guild = await guildId();
  const rows = guild ? await q('SELECT * FROM discord_rooms WHERE guild_id=$1 ORDER BY position, name', [guild]) : [];
  const locked = guild ? await protectedRooms(guild) : new Set();
  const posts = await q('SELECT * FROM discord_bot_posts ORDER BY id');
  const cats = rows.filter((r) => r.type === 4);
  const groups = [{ id: '', name: 'No category', rooms: [] }, ...cats.map((c) => ({ id: c.channel_id, name: c.name, position: c.position, rooms: [] }))];
  for (const r of rows.filter((x) => x.type !== 4)) {
    (groups.find((g) => g.id === r.parent_id) || groups[0]).rooms.push({
      id: r.channel_id, name: r.name, type: r.type, text: TEXT_TYPES.has(r.type), voice: VOICE_TYPES.has(r.type), show_in_app: r.show_in_app, view_only: r.view_only, clear_minutes: r.clear_minutes,
      no_clear: locked.has(r.channel_id), last_cleared_at: r.last_cleared_at, last_cleared_count: r.last_cleared_count, problem: r.problem,
      posts: posts.filter((p) => p.channel_id === r.channel_id).length,
    });
  }
  for (const g of groups) g.rooms.sort((a, b) => (a.type === 2) - (b.type === 2) || 0);
  return {
    guild,
    groups: groups.filter((g) => g.rooms.length || g.id),
    posts: posts.map((p) => ({ ...p, room: rows.find((r) => r.channel_id === p.channel_id)?.name || '?' })),
    clear_choices: CLEAR_CHOICES,
    kinds: Object.entries(KINDS).map(([k, v]) => ({ key: k, label: v.label, help: v.help })),
  };
}

// ---------- Room settings ----------
export async function setRoom(channelId, { view_only, clear_minutes, show_in_app }) {
  const room = await one('SELECT * FROM discord_rooms WHERE channel_id=$1', [channelId]);
  if (!room) throw new Error('That room is no longer on the server.');
  if (show_in_app !== undefined) {
    if (!VOICE_TYPES.has(room.type)) throw new Error('Only voice rooms show in the app.');
    await q('UPDATE discord_rooms SET show_in_app=$2 WHERE channel_id=$1', [channelId, !!show_in_app]);
    bus.emit('config:changed', 'discord-rooms');
    return { ok: true, problem: '' };
  }
  if (!TEXT_TYPES.has(room.type)) throw new Error('Only text rooms can be view only or auto-cleared.');
  let problem = '';
  if (clear_minutes !== undefined) {
    const mins = CLEAR_CHOICES.includes(Number(clear_minutes)) ? Number(clear_minutes) : 0;
    if (mins && (await protectedRooms(room.guild_id)).has(channelId)) throw new Error("This room can't be auto-cleared (rules, logs, tickets and friend codes are kept).");
    await q('UPDATE discord_rooms SET clear_minutes=$2 WHERE channel_id=$1', [channelId, mins]);
    if (mins) problem = await ensureBotCan(channelId);
  }
  if (view_only !== undefined && !!view_only !== room.view_only) {
    problem = (await (view_only ? makeViewOnly(room) : undoViewOnly(room))) || problem;
  }
  await q('UPDATE discord_rooms SET problem=$2 WHERE channel_id=$1', [channelId, problem]);
  bus.emit('config:changed', 'discord-rooms');
  return { ok: !problem, problem };
}

let botIdCache = null;
const botId = async () => (botIdCache ||= (await discordFetch('/users/@me')).id);
async function staffRoleIds(guild) {
  const map = await loadMap(guild);
  const s = await staffRoles().catch(() => ({}));
  return new Set([map.roles?.admin, map.roles?.mod, s.owner, s.admin, s.mod].filter((x) => x && !String(x).startsWith('new:')));
}
// The bot's own permissions in a room (for auto-clear it needs to read history and manage messages).
async function ensureBotCan(channelId) {
  try {
    const id = await botId();
    const ch = await discordFetch(`/channels/${channelId}`);
    const mine = (ch.permission_overwrites || []).find((o) => o.id === id);
    const allow = BigInt(mine?.allow || 0) | BOT_NEEDS;
    const deny = BigInt(mine?.deny || 0) & ~BOT_NEEDS;
    if (!mine || BigInt(mine.allow) !== allow || BigInt(mine.deny) !== deny) {
      await discordFetch(`/channels/${channelId}/permissions/${id}`, 'PUT', { type: 1, allow: P(allow), deny: P(deny) });
    }
    return '';
  } catch (e) {
    return `The bot couldn't give itself Manage Messages here: ${e.message}`;
  }
}
// View only: members keep seeing the room but can't post, start threads or use /commands. Staff roles and the bot
// are let post. The room's permissions before are saved and put back exactly when it's switched off.
async function makeViewOnly(room) {
  try {
    const ch = await discordFetch(`/channels/${room.channel_id}`);
    const before = ch.permission_overwrites || [];
    await q('UPDATE discord_rooms SET view_saved=$2, view_only=true WHERE channel_id=$1', [room.channel_id, JSON.stringify(before)]);
    const staff = await staffRoleIds(room.guild_id);
    const me = await botId();
    const ows = before.some((o) => o.id === room.guild_id) ? before : [...before, { id: room.guild_id, type: 0, allow: '0', deny: '0' }];
    for (const o of ows) {
      if (Number(o.type) !== 0 || staff.has(o.id)) continue;
      await discordFetch(`/channels/${room.channel_id}/permissions/${o.id}`, 'PUT', { type: 0, allow: P(BigInt(o.allow) & ~MEMBER_POSTING), deny: P(BigInt(o.deny) | MEMBER_POSTING) });
    }
    for (const id of staff) {
      const o = before.find((x) => x.id === id);
      await discordFetch(`/channels/${room.channel_id}/permissions/${id}`, 'PUT', { type: 0, allow: P(BigInt(o?.allow || 0) | BIT.SEND | BIT.SEND_IN_THREADS), deny: P(BigInt(o?.deny || 0) & ~(BIT.SEND | BIT.SEND_IN_THREADS)) });
    }
    const mine = before.find((x) => x.id === me);
    await discordFetch(`/channels/${room.channel_id}/permissions/${me}`, 'PUT', { type: 1, allow: P(BigInt(mine?.allow || 0) | BOT_NEEDS), deny: P(BigInt(mine?.deny || 0) & ~BOT_NEEDS) });
    return '';
  } catch (e) {
    return `Couldn't make it view only: ${e.message}`;
  }
}
async function undoViewOnly(room) {
  try {
    const before = Array.isArray(room.view_saved) ? room.view_saved : [];
    const ch = await discordFetch(`/channels/${room.channel_id}`);
    const had = new Set(before.map((o) => o.id));
    for (const o of before) await discordFetch(`/channels/${room.channel_id}/permissions/${o.id}`, 'PUT', { type: Number(o.type), allow: String(o.allow), deny: String(o.deny) });
    for (const o of ch.permission_overwrites || []) if (!had.has(o.id)) await discordFetch(`/channels/${room.channel_id}/permissions/${o.id}`, 'DELETE').catch(() => {});
    await q('UPDATE discord_rooms SET view_saved=NULL, view_only=false WHERE channel_id=$1', [room.channel_id]);
    return '';
  } catch (e) {
    return `Couldn't open the room again: ${e.message}`;
  }
}

// ---------- Auto-clear ----------
const staffCache = new Map(); // discord id → { staff, at }
async function isStaffUser(guild, userId, staff, ownerId) {
  if (!userId) return false;
  if (userId === ownerId) return true;
  const c = staffCache.get(userId);
  if (c && Date.now() - c.at < 10 * 60e3) return c.staff;
  let yes = false;
  try {
    const m = await discordFetch(`/guilds/${guild}/members/${userId}`);
    yes = (m.roles || []).some((r) => staff.has(r));
  } catch { yes = false; } // left the server: not staff
  staffCache.set(userId, { staff: yes, at: Date.now() });
  return yes;
}
// Which messages auto-clear removes: members' own messages and the replies to members' /commands. Never staff,
// the bot's or other bots' own posts (announcements, boards, guides), or pinned messages.
export async function clearable(m, { guild, staff, ownerId, keep }) {
  if (m.pinned || keep.has(m.id)) return false;
  const by = m.author || {};
  if (m.type === 6) return !!by.bot; // "WPG pinned a message" notices
  const invoker = m.interaction_metadata?.user?.id || m.interaction?.user?.id || '';
  if (by.bot || m.webhook_id) return !!invoker && !(await isStaffUser(guild, invoker, staff, ownerId));
  return !(await isStaffUser(guild, by.id, staff, ownerId));
}
async function clearRoom(room, ctx) {
  const cutoff = Date.now() - room.clear_minutes * 60e3;
  const oldest = Date.now() - 14 * DAY + 3600e3; // bulk delete only takes messages under 14 days old
  const out = [];
  let before = '';
  for (let page = 0; page < 10; page++) {
    const list = await discordFetch(`/channels/${room.channel_id}/messages?limit=100${before ? `&before=${before}` : ''}`);
    if (!list.length) break;
    for (const m of list) {
      const at = Date.parse(m.timestamp);
      if (at >= cutoff || at < oldest) continue;
      if (await clearable(m, ctx)) out.push(m.id);
    }
    before = list[list.length - 1].id;
    if (list.length < 100 || Date.parse(list[list.length - 1].timestamp) < oldest) break;
  }
  for (let i = 0; i < out.length; i += 100) {
    const chunk = out.slice(i, i + 100);
    if (chunk.length === 1) await discordFetch(`/channels/${room.channel_id}/messages/${chunk[0]}`, 'DELETE');
    else await discordFetch(`/channels/${room.channel_id}/messages/bulk-delete`, 'POST', { messages: chunk });
  }
  return out.length;
}
let sweeping = false;
export async function sweepRooms() {
  if (sweeping || !botReady()) return;
  sweeping = true;
  try {
    const guild = await guildId();
    if (!guild) return;
    const rooms = await q('SELECT * FROM discord_rooms WHERE guild_id=$1 AND clear_minutes > 0', [guild]);
    if (!rooms.length) return;
    const locked = await protectedRooms(guild);
    const staff = await staffRoleIds(guild);
    const ownerId = (await discordFetch(`/guilds/${guild}`).catch(() => null))?.owner_id || '';
    const keep = new Set((await q("SELECT message_id FROM discord_bot_posts WHERE message_id <> ''")).map((r) => r.message_id));
    for (const room of rooms) {
      if (locked.has(room.channel_id)) continue;
      try {
        const n = await clearRoom(room, { guild, staff, ownerId, keep });
        if (n) await q('UPDATE discord_rooms SET last_cleared_at=now(), last_cleared_count=$2, problem=$3 WHERE channel_id=$1', [room.channel_id, n, '']);
        else if (room.problem) await q("UPDATE discord_rooms SET problem='' WHERE channel_id=$1", [room.channel_id]);
      } catch (e) {
        await q('UPDATE discord_rooms SET problem=$2 WHERE channel_id=$1', [room.channel_id, `Auto-clear: ${e.message}`.slice(0, 300)]);
      }
    }
  } finally {
    sweeping = false;
  }
}

// ---------- Bot posts ----------
// The member command groups for the #stats-bot guide; commands not listed here go under "More".
const STATS_GROUPS = [
  ['Get started', 'link your account', ['link', 'unlink']],
  ['Your stats', 'anyone: add a member or name', ['stats', 'rank', 'server', 'progress']],
  ['Achievements', 'badges, medals & frames', ['achievements', 'badges', 'medals', 'frames', 'loyalty', 'streamstats']],
  ['Boards & live', 'who is on top', ['leaderboard', 'serverboard', 'live', 'money']],
  ['Clan', 'combat command', ['apply', 'roster', 'unit']],
  ['Help', 'staff & reports', ['report']],
];
const STAFF_GROUPS = [
  ['Moderation', 'every action is a case', ['warn', 'unwarn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'cases']],
  ['Channels', 'this room', ['purge', 'slowmode', 'lock', 'unlock']],
];
// Member commands: on for anyone who isn't staff (admin-only and mod-only commands are left out).
async function memberCommands() {
  const access = await commandAccess();
  return commandList().filter((c) => !c.moderator && (access[c.name] || []).some((g) => g !== 'mod' && g !== 'admin'))
    .map((c) => ({ ...c, membersOnly: !(access[c.name] || []).includes('everyone') }));
}
function grouped(list, groups, more = 'More') {
  const by = new Map(list.map((c) => [c.name, c]));
  const used = new Set();
  const out = groups.map(([title, accent, names]) => ({
    title, accent,
    rows: names.filter((n) => by.has(n)).map((n) => { used.add(n); const c = by.get(n); return { name: `/${n}`, text: `${c.description}${c.membersOnly && !/WPG members/i.test(c.description) ? ' (WPG members)' : ''}` }; }),
  })).filter((s) => s.rows.length);
  const rest = list.filter((c) => !used.has(c.name));
  if (rest.length) out.push({ title: more, accent: 'new', rows: rest.map((c) => ({ name: `/${c.name}`, text: c.description })) });
  return out;
}
const clearNote = (mins) => {
  if (!mins) return '';
  const t = mins < 60 ? `${mins} minutes` : mins < 1440 ? `${mins / 60} hour${mins === 60 ? '' : 's'}` : `${mins / 1440} day${mins === 1440 ? '' : 's'}`;
  return `Your messages and command results here are cleared after ${t}.`;
};
const KINDS = {
  stats: {
    label: 'Stats bot guide',
    help: 'Every member command, grouped (staff commands hidden). Rebuilds itself when commands are added or who can use them changes.',
    build: async (room) => ({
      heading: 'BOT COMMANDS',
      intro: 'Type / in this room and pick a command. Most work for you or for someone else: add a member, or type their name.',
      sections: grouped(await memberCommands(), STATS_GROUPS),
      footer: [clearNote(room?.clear_minutes), 'Full stats, medals and badges: WPG Barracks app'].filter(Boolean),
    }),
  },
  staff: {
    label: 'Staff commands guide',
    help: 'The moderation and channel commands (post it in a staff room). Rebuilds itself when commands change.',
    build: async () => ({
      heading: 'STAFF COMMANDS',
      intro: 'Every action is saved as a case and the member is told by DM. Staff can\'t be targeted. Who can use each command is set in the app: Discord control → Commands.',
      sections: grouped(Object.entries(MOD_COMMANDS).map(([name, c]) => ({ name, description: c.description })), STAFF_GROUPS, 'More staff commands'),
      footer: ['Buttons: Let in / Kick (new accounts) · Close ticket'],
    }),
  },
  all: {
    label: 'Complete commands guide',
    help: 'Every command, members\' and staff, with who can use each (post it in a staff room). Rebuilds itself when commands change.',
    build: async (room) => {
      const access = await commandAccess();
      const who = (name) => {
        const g = access[name] || [];
        if (!g.length) return 'off';
        if (g.includes('everyone')) return 'everyone';
        return g.map((x) => ({ pmc: 'PMC', member: 'WPG members', mod: 'Mods', admin: 'Admins' }[x] || x)).join(', ');
      };
      const all = commandList().map((c) => ({ ...c, description: `${c.description} · ${who(c.name)}` }));
      return {
        heading: 'ALL BOT COMMANDS',
        intro: 'Every command the WPG bot has, and who can use it now (set in the app: Discord control → Commands). Staff commands are hidden from members in Discord.',
        sections: [
          ...grouped(all.filter((c) => !c.moderator), STATS_GROUPS, 'More member commands').map((sec) => ({ ...sec, accent: 'members' })),
          ...grouped(all.filter((c) => c.moderator), STAFF_GROUPS, 'More staff commands').map((sec) => ({ ...sec, accent: 'staff' })),
        ],
        footer: [clearNote(room?.clear_minutes), 'Buttons: Let in / Kick (new accounts) · Close ticket'].filter(Boolean),
      };
    },
  },
  setup: {
    label: 'App setup guide',
    help: 'Step by step from the web address to every profile field, linking Discord and wardogs.tools, and the extras. Uses your web address, profile fields and join settings, and updates when they change.',
    build: async () => {
      const { setting, flag } = await import('./db.js');
      const site = SITE();
      const approval = await flag('require_approval');
      const fields = await q('SELECT key, label, type, options FROM profile_fields ORDER BY sort_order, key');
      const tag = String((await setting('clan_tag')) || 'WPG');
      const fieldText = (f) => {
        if (f.key === 'wardogs_name') return 'Your Wardogs name with its 4 numbers (Name#1234). Only needed if wardogs.tools can\'t find you by your Steam account.';
        if (f.key === 'discord') return 'Your Discord name, shown on your profile.';
        return f.type === 'select' ? `Pick one: ${String(f.options || '').split(',').map((o) => o.trim()).filter(Boolean).join(', ')}.` : 'Fill it in (optional).';
      };
      return {
        heading: 'APP SETUP GUIDE',
        intro: `Everything you need to get set up in ${tag} Barracks, the ${tag} app: your profile, stats, medals, badges, Combat Command and more. It takes about 5 minutes. Do the steps in order.`,
        sections: [
          { title: 'Step 1', accent: 'open the app', rows: [
            { name: 'Web address', text: site },
            { name: 'On your phone', text: 'Open it in your browser, then use the browser menu → Add to Home Screen. It then opens like an app.' },
          ] },
          { title: 'Step 2', accent: 'sign in with Steam', rows: [
            { name: 'Sign in', text: 'Press Sign in through Steam and log in on Steam\'s own page. The app never sees your Steam password. Your name and picture come from Steam.' },
            { name: 'New here?', text: approval ? 'Staff approve new accounts first: you\'ll get in once they have.' : `You start as a PMC guest. Staff make you a ${tag} member once you've joined the clan (apply in Step 8).` },
            { name: 'Steam privacy', text: 'In Steam → Edit Profile → Privacy Settings, set Game details to Public so your hours and achievements show.' },
          ] },
          { title: 'Step 3', accent: 'your profile', rows: [
            { name: 'Where', text: 'Open My Career (your profile), then press Edit profile.' },
            { name: 'Callsign', text: 'Your nickname, shown under your name.' },
            { name: 'Country', text: 'Your flag on your profile and the boards.' },
            ...fields.map((f) => ({ name: f.label.replace(/\s*\(.*\)$/, ''), text: fieldText(f) })),
            { name: 'About me', text: 'A few lines about you.' },
            { name: 'My skills', text: 'Tick what you\'re good at (shown on your profile and to Combat Command).' },
            { name: 'Picture link', text: 'Optional: an https picture link instead of your Steam picture.' },
            { name: 'Banner colour', text: 'The colour behind your name box.' },
            { name: 'Save', text: 'Press Save profile at the bottom of that box.' },
          ] },
          { title: 'Step 4', accent: 'friends & Steam', rows: [
            { name: 'Friend requests', text: 'Leave ticked so members can add you in the app.' },
            { name: 'Steam buttons', text: 'Leave ticked to show Add on Steam, Steam profile and your friend code on your profile.' },
            { name: 'Invite link', text: 'In Steam: Friends → Add a Friend → copy your Quick Invite link and paste it in Edit profile. Steam links last 30 days: the bot reminds you from day 27 to paste a new one.' },
          ] },
          { title: 'Step 5', accent: 'link Discord', rows: [
            { name: 'In Discord', text: 'Type /link anywhere on the server. The bot gives you a code (only you see it).' },
            { name: 'In the app', text: 'Edit profile → Discord box → type the code → Link.' },
            { name: 'You get', text: 'Your clan, unit, faction and game roles here automatically, and every bot command shows your stats.' },
          ] },
          { title: 'Step 6', accent: 'Wardogs stats', rows: [
            { name: 'wardogs.tools', text: 'Open https://wardogs.tools, sign in and link your Wardogs account (one time only).' },
            { name: 'Check now', text: 'Back on your profile press Check now. Your level, cash, gold, class levels and world rank then update by themselves about 30 minutes after you close Wardogs.' },
            { name: 'Not found?', text: 'Add your in-game name with its 4 numbers in Edit profile (Step 3), then press Check now again.' },
          ] },
          { title: 'Step 7', accent: 'extras', rows: [
            { name: 'Live money', text: 'On your profile tick Show my live match money, then add the WPG Barracks Steam account as a friend when asked. Your match money then shows live in the app and in /money.' },
            { name: 'Streams', text: 'Edit profile → My streams: add your Twitch, YouTube or Kick so your go-live posts here and your streaming badges work.' },
            { name: 'Showcase', text: 'My Career → Medals, badges & frames: pick up to 5 badges to show under your name, and the frame around your picture.' },
          ] },
          { title: 'Step 8', accent: 'join a unit', rows: [
            { name: 'Apply', text: `Recruitment in the app (or /apply here) to join a ${tag} combat unit. Staff look at every application.` },
          ] },
        ],
        footer: ['Stuck? Ask in #app-help or press Contact staff in #contact-staff'],
      };
    },
  },
  leaderboards: {
    label: 'Leaderboards guide',
    help: 'What the live boards in this room show and how often they update.',
    build: async () => ({
      heading: 'LIVE LEADERBOARDS',
      intro: 'These boards update by themselves. Want your own numbers? Use /leaderboard, /serverboard or /money in the bot room.',
      sections: [{ title: 'Boards', accent: 'top 20', rows: [
        { name: 'WPG rank', text: 'WPG XP earned on the WPG server' },
        { name: 'Wardog level', text: 'Wardogs level from wardogs.tools' },
        { name: 'Account worth', text: 'Cash and items, from wardogs.tools' },
        { name: 'Server kills', text: 'Kills on the WPG server' },
        { name: 'Achievement pts', text: 'Badges and achievement medals' },
        { name: 'Live money', text: 'Who is in a match now and the last 24 hours' },
      ] }],
      footer: ['Updated every minute'],
    }),
  },
  custom: {
    label: 'Your own post',
    help: 'Your own title and text, in as many boxes as you like (each shows as its own box on Discord). Blank lines stay as gaps. @Role and #room become real mentions. "name - text" lines show the name in blue.',
    // The text: what comes first is the opening box; "## Heading" starts a box with a heading, "---" one without.
    // Blank lines are kept (as one gap).
    build: async (_room, p) => {
      const boxes = [{ title: '', rows: [] }];
      for (const raw of String(p.body || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (/^#{1,3}\s+\S/.test(line)) { boxes.push({ title: line.replace(/^#+\s*/, ''), rows: [] }); continue; }
        if (/^-{3,}$/.test(line)) { boxes.push({ title: '', rows: [] }); continue; }
        const rows = boxes[boxes.length - 1].rows;
        if (!line) { if (rows.length && rows[rows.length - 1].text !== '') rows.push({ text: '' }); continue; }
        const m = line.replace(/^[-•*]\s*/, '').match(/^(\S[^–—-]{0,24}?)\s+[–—-]\s+(.+)$/);
        rows.push(m ? { name: m[1], text: m[2] } : { text: line });
      }
      for (const b of boxes) while (b.rows.length && b.rows[b.rows.length - 1].text === '') b.rows.pop();
      const [first, ...rest] = boxes;
      return {
        heading: p.title || 'WPG BARRACKS',
        intro: first.rows.map((r) => (r.name ? `**${r.name}** — ${r.text}` : r.text)).join('\n'),
        sections: rest.filter((b) => b.rows.length || b.title),
      };
    },
  },
};

// @Role and #room in a post's text become real Discord mentions: "@WPG Community" → the role (clickable, and pinged
// when the post asks for it), "#pick-roles" → a link to the room. Names are matched without emoji, brackets, dashes
// or capitals ("#roles" finds "『🎮』pick-roles" when it's the only room ending that way).
const plainName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+]/g, '');
let rolesCache = { at: 0, list: [] };
async function guildRoles() {
  if (Date.now() - rolesCache.at < 5 * 60e3) return rolesCache.list;
  const guild = await guildId();
  const list = guild ? await discordFetch(`/guilds/${guild}/roles`).catch(() => []) : [];
  rolesCache = { at: Date.now(), list: (list || []).filter((r) => r.id !== guild && !r.managed && plainName(r.name)) };
  return rolesCache.list;
}
export async function mentionTools() {
  const guild = await guildId();
  const rooms = guild ? await q('SELECT channel_id, name FROM discord_rooms WHERE guild_id=$1 AND type <> 4', [guild]) : [];
  const roles = (await guildRoles()).slice().sort((a, b) => b.name.length - a.name.length);
  const names = {};
  const pinged = new Set();
  const findRoom = (word) => {
    const k = plainName(word);
    if (!k) return null;
    const exact = rooms.filter((r) => plainName(r.name) === k);
    if (exact.length) return exact[0];
    const ends = rooms.filter((r) => plainName(r.name).endsWith(k));
    return ends.length === 1 ? ends[0] : null;
  };
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const convert = (text) => {
    let t = String(text || '');
    for (const r of roles) {
      const re = new RegExp(`@${esc(r.name.trim())}(?![\\w])`, 'gi');
      if (re.test(t)) {
        t = t.replace(re, `<@&${r.id}>`);
        pinged.add(r.id);
        names[r.id] = `@${r.name}`;
      }
    }
    t = t.replace(/(^|[\s(])#([a-z0-9][\w-]*)/gi, (m, pre, word) => {
      const room = findRoom(word);
      if (!room) return m;
      names[room.channel_id] = `#${room.name}`;
      return `${pre}<#${room.channel_id}>`;
    });
    return t;
  };
  return { convert, names, pinged };
}

// A post is the WPG banner (header art with its title) and the text as Discord embeds underneath: real text, so it reads
// at Discord's normal size on any screen (a tall picture gets shrunk to fit Discord's preview). Commands are clickable.
const EMBED_COLOR = 0x33d1ff;
const STAFF_COLOR = 0xf5a524;
function embedsFor(d, ids) {
  const cmd = (name) => {
    const n = String(name).replace(/^\//, '');
    return name.startsWith('/') && ids.get(n) ? `</${n}:${ids.get(n)}>` : `**${name}**`;
  };
  // "/link" written in the text is clickable too (when it's one of the bot's commands).
  const inline = (t) => String(t || '').replace(/(^|\s)\/([a-z]+)\b/g, (m, pre, n) => (ids.get(n) ? `${pre}</${n}:${ids.get(n)}>` : m));
  const lines = (s) => s.rows.map((r) => (r.name ? `${cmd(r.name)} — ${inline(r.text)}` : inline(r.text))).join('\n');
  // The banner on its own first (Discord puts an embed's picture under its text), then the intro.
  const out = [{ color: EMBED_COLOR, image: { url: 'attachment://banner.jpg' } }];
  if (d.intro) out.push({ color: EMBED_COLOR, description: d.intro.slice(0, 4000) });
  for (const s of d.sections) {
    const title = `${String(s.title || '').toUpperCase()}${s.accent ? ` · ${s.accent}` : ''}`.slice(0, 250);
    const e = { color: s.accent === 'staff' ? STAFF_COLOR : EMBED_COLOR, ...(title ? { title } : {}), description: (lines(s) || '\u200b').slice(0, 4000) };
    // Discord takes 10 embeds a message: anything after the 10th joins the last one.
    if (out.length < 10) out.push(e);
    else out[9].description = `${out[9].description}\n\n${e.title ? `**${e.title}**\n` : ''}${e.description}`.slice(0, 4000);
  }
  if (d.footer?.length) out[out.length - 1].footer = { text: d.footer.join(' · ').slice(0, 2000) };
  // Discord's limit is 6000 characters across a message's embeds: shorten the longest ones if it's over.
  const size = () => out.reduce((a, e) => a + (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length, 0);
  while (size() > 5900) {
    const e = out.reduce((a, b) => ((b.description || '').length > (a.description || '').length ? b : a));
    e.description = `${e.description.slice(0, Math.floor(e.description.length * 0.9))}…`;
  }
  return out;
}
async function postPayload(p) {
  const room = await one('SELECT * FROM discord_rooms WHERE channel_id=$1', [p.channel_id]);
  const kind = KINDS[p.kind] || KINDS.custom;
  const d = await kind.build(room, p);
  // @Role and #room mentions in the text.
  const m = await mentionTools().catch(() => null);
  if (m) {
    d.intro = m.convert(d.intro);
    for (const s of d.sections) s.rows = s.rows.map((r) => ({ ...r, text: m.convert(r.text) }));
  }
  const pingRoles = p.ping && m ? [...m.pinged] : [];
  const ping = pingRoles.length ? { content: pingRoles.map((id) => `<@&${id}>`).join(' '), allowed_mentions: { parse: [], roles: pingRoles } } : {};
  const ids = await commandIds().catch(() => new Map());
  const buttons = [{ type: 1, components: [{ type: 2, style: 5, label: 'Open WPG Barracks', url: SITE() }] }];
  const hash = crypto.createHash('sha1').update(JSON.stringify([p.style, d, [...ids], pingRoles])).digest('hex');
  const names = m?.names || {};
  if (p.style === 'text') {
    const cmd = (name) => (name.startsWith('/') && ids.get(name.slice(1)) ? `</${name.slice(1)}:${ids.get(name.slice(1))}>` : `**${name}**`);
    const lines = [`## ${d.heading}`, d.intro || null, ...d.sections.flatMap((s) => [s.title ? `### ${s.title}` : '', ...s.rows.map((r) => (r.name ? `${cmd(r.name)} — ${r.text}` : r.text))]), ...(d.footer || []).map((f) => `-# ${f}`)].filter((x) => x !== undefined && x !== null);
    const body = lines.join('\n');
    return { hash, names, payload: { ...ping, content: `${ping.content ? `${ping.content}\n` : ''}${body}`.slice(0, 2000), components: buttons } };
  }
  const { renderBanner } = await import('./cards.js');
  const data = await renderBanner(d.heading);
  return { hash, names, payload: { content: '', ...ping, embeds: embedsFor(d, ids), files: [{ name: 'banner.jpg', data, type: 'image/jpeg' }], components: buttons } };
}
// Posts it (or edits the message it already has) and pins it. force: post again even if nothing changed.
export async function publishPost(id, { force = false } = {}) {
  const p = await one('SELECT * FROM discord_bot_posts WHERE id=$1', [id]);
  if (!p) throw new Error('Post not found.');
  const { hash, payload } = await postPayload(p);
  if (!force && p.message_id && p.hash === hash) return { ok: true, unchanged: true };
  let messageId = p.message_id;
  let problem = '';
  try {
    let edited = false;
    if (messageId) edited = await editMessage(p.channel_id, messageId, payload).then(() => true).catch(() => false);
    if (!edited) {
      const m = await sendToChannel(p.channel_id, payload);
      messageId = m?.id || '';
      if (p.pin && messageId) await discordFetch(`/channels/${p.channel_id}/pins/${messageId}`, 'PUT').catch((e) => { problem = `Posted, but couldn't pin it: ${e.message}`; });
    }
  } catch (e) {
    problem = e.message;
  }
  await q('UPDATE discord_bot_posts SET message_id=$2, hash=$3, problem=$4, updated_at=now() WHERE id=$1', [id, messageId, problem ? p.hash : hash, problem.slice(0, 300)]);
  return { ok: !problem, problem };
}
export async function savePost(id, b, userId) {
  const kind = KINDS[b.kind] ? b.kind : 'custom';
  const room = await one('SELECT * FROM discord_rooms WHERE channel_id=$1', [String(b.channel_id || '')]);
  if (!room || !TEXT_TYPES.has(room.type)) throw new Error('Pick a text room.');
  const vals = [String(b.channel_id), kind, String(b.title || '').slice(0, 60), String(b.body || '').slice(0, 4000), b.style === 'text' ? 'text' : 'card', b.pin !== false, !!b.ping];
  if (kind === 'custom' && !vals[3].trim()) throw new Error('Write the text first.');
  let row;
  if (id) {
    const old = await one('SELECT * FROM discord_bot_posts WHERE id=$1', [id]);
    if (!old) throw new Error('Post not found.');
    // Moved to another room: the old message is removed and it's posted again in the new one.
    if (old.channel_id !== vals[0] && old.message_id) await discordFetch(`/channels/${old.channel_id}/messages/${old.message_id}`, 'DELETE').catch(() => {});
    row = await one(`UPDATE discord_bot_posts SET channel_id=$2, kind=$3, title=$4, body=$5, style=$6, pin=$7, ping=$8,
      message_id=CASE WHEN channel_id=$2 THEN message_id ELSE '' END WHERE id=$1 RETURNING *`, [id, ...vals]);
  } else {
    row = await one('INSERT INTO discord_bot_posts (channel_id, kind, title, body, style, pin, ping, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [...vals, userId]);
  }
  return { id: row.id, ...(await publishPost(row.id, { force: true })) };
}
export async function deletePost(id) {
  const p = await one('DELETE FROM discord_bot_posts WHERE id=$1 RETURNING *', [id]);
  if (p?.message_id) await discordFetch(`/channels/${p.channel_id}/messages/${p.message_id}`, 'DELETE').catch(() => {});
}
export async function previewPost(b) {
  const { payload, names } = await postPayload({ channel_id: String(b.channel_id || ''), kind: KINDS[b.kind] ? b.kind : 'custom', title: b.title || '', body: b.body || '', style: b.style === 'text' ? 'text' : 'card', ping: !!b.ping });
  return { ...payload, names };
}
// Keeps every post up to date (only edits the ones whose content changed, e.g. a new command or new access).
let refreshing = null;
export function refreshPosts() {
  refreshing ||= (async () => {
    try {
      for (const p of await q('SELECT id FROM discord_bot_posts')) await publishPost(p.id).catch((e) => console.warn('[rooms] post', e.message));
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// The first guides, posted once (if those rooms are on the server): the member guide in #stats-bot and the
// complete guide in the admin bot commands room. After that they're managed in Discord control → Bot posts.
const FIRST_POSTS = [['1557707461870362635', 'stats'], ['1557425534944673802', 'all'], ['1554989526244393023', 'setup']];
async function firstPosts() {
  const { setting } = await import('./db.js');
  let done = [];
  try { done = JSON.parse((await setting('_discord_first_posts_list')) || '[]') || []; } catch { done = []; }
  // Posted before this list was kept: the first two.
  if ((await setting('_discord_first_posts')) && !done.length) done = FIRST_POSTS.slice(0, 2).map(([c, k]) => `${c}:${k}`);
  const before = done.length;
  for (const [channel, kind] of FIRST_POSTS) {
    const key = `${channel}:${kind}`;
    if (done.includes(key)) continue; // posted once already: if an admin deleted it, it stays deleted
    if (!(await one('SELECT 1 FROM discord_rooms WHERE channel_id=$1', [channel]))) continue;
    if (!(await one('SELECT 1 FROM discord_bot_posts WHERE channel_id=$1 AND kind=$2', [channel, kind]))) {
      const row = await one('INSERT INTO discord_bot_posts (channel_id, kind, style, pin) VALUES ($1,$2,\'card\',true) RETURNING id', [channel, kind]);
      await publishPost(row.id, { force: true });
    }
    done.push(key);
  }
  if (done.length !== before) await q("INSERT INTO settings (key, value) VALUES ('_discord_first_posts_list', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(done)]);
}

// The faction voice rooms (🐺 WARDOGS category) and the AFK room show their names in the app from the start; the rest
// is up to the admins.
const FIRST_SHOWN_CATEGORY = '1553006810431102996';
const FIRST_SHOWN_ROOMS = ['1521623295252758600'];
async function firstShown() {
  const { setting } = await import('./db.js');
  if (await setting('_discord_first_shown')) return;
  if (!(await one('SELECT 1 FROM discord_rooms WHERE channel_id=$1', [FIRST_SHOWN_CATEGORY]))) return;
  await q('UPDATE discord_rooms SET show_in_app=true WHERE (parent_id=$1 OR channel_id = ANY($3)) AND type = ANY($2)', [FIRST_SHOWN_CATEGORY, [...VOICE_TYPES], FIRST_SHOWN_ROOMS]);
  await q("INSERT INTO settings (key, value) VALUES ('_discord_first_shown', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [new Date().toISOString()]);
}
// Voice rooms whose names the app may show although @everyone can't see them (Discord's widget hides those).
export async function shownVoiceRooms() {
  return q('SELECT channel_id, name, position, parent_id FROM discord_rooms WHERE show_in_app = true AND type = ANY($1) ORDER BY position, name', [[...VOICE_TYPES]]);
}

export function startDiscordRooms() {
  if (!botReady()) return;
  setTimeout(async () => {
    await syncRooms().catch((e) => console.warn('[rooms] sync', e.message));
    await firstPosts().catch((e) => console.warn('[rooms] first posts', e.message));
    await firstShown().catch((e) => console.warn('[rooms] first shown', e.message));
    refreshPosts();
  }, 20e3);
  setInterval(() => sweepRooms().catch((e) => console.warn('[rooms] clear', e.message)), 60e3);
  setInterval(() => syncRooms().catch(() => {}), 30 * 60e3); // catches anything missed while the bot was offline
  setInterval(() => refreshPosts(), 60 * 60e3);
  let t = null;
  const soon = () => { clearTimeout(t); t = setTimeout(() => refreshPosts(), 5000); };
  bus.on('discord:commands', soon);
  bus.on('config:changed', (name) => { if (name !== 'discord-rooms') soon(); });
}
