// Discord server builder and role sync (Admin → Discord server).
//  - Build: the bot creates (or finds by name) the WPG roles, categories, channels and who can see / talk in
//    each, on the server set in discord_build_server_id. It adds and fixes; it never deletes channels or roles
//    it didn't make, and roles that already exist are reused as they are. Preview first lists what it would do.
//  - Sync (when discord_sync_roles is on, every 2 minutes and shortly after changes in the app):
//      · Wardogs for everyone on the server (once they've accepted the rules screen, if there is one);
//      · for members who linked Discord with /link: Admin / Moderator (app role), WPG Member (WPG members, not
//        PMC guests), Combat Command (CO, XO, Deputy…), their unit, Unit Leader, their faction, and a game role
//        for every Steam game they've played for discord_game_role_hours+ hours (show only, no access).
//    Only the app's own roles are changed, and only on linked members; roles given by hand are left alone.
//  Listing the server's members needs SERVER MEMBERS INTENT switched on in the Discord Developer Portal.
import { q, one, setting, clearSettingsCache } from './db.js';
import { bus } from './bus.js';
import { discordFetch } from './discordbot.js';
import { isOwner } from './util.js';
import { setupModeration, entryOn, entryFreePass } from './discordmod.js';

const P = {
  KICK: 1n << 1n, BAN: 1n << 2n, ADMIN: 1n << 3n, ADD_REACTIONS: 1n << 6n, AUDIT_LOG: 1n << 7n, PRIORITY: 1n << 8n,
  VIEW: 1n << 10n, SEND: 1n << 11n, MANAGE_MESSAGES: 1n << 13n, HISTORY: 1n << 16n, EVERYONE: 1n << 17n,
  CONNECT: 1n << 20n, SPEAK: 1n << 21n, MUTE: 1n << 22n, DEAFEN: 1n << 23n, MOVE: 1n << 24n, NICKNAMES: 1n << 27n,
  MANAGE_THREADS: 1n << 34n, PUBLIC_THREADS: 1n << 35n, THREAD_SEND: 1n << 38n, TIMEOUT: 1n << 40n,
};
const bits = (...names) => names.reduce((a, n) => a | P[n], 0n);
const TALK = ['VIEW', 'SEND', 'HISTORY', 'ADD_REACTIONS', 'CONNECT', 'SPEAK', 'THREAD_SEND', 'PUBLIC_THREADS'];
const READ_ONLY = { allow: ['VIEW', 'HISTORY'], deny: ['SEND', 'ADD_REACTIONS', 'PUBLIC_THREADS', 'THREAD_SEND'] };
const TEXT = 0;
const VOICE = 2;
const CATEGORY = 4;
const NEWS = 5;

const FACTIONS = [['lonestar', 'Lonestar', '#4cb1ef'], ['valkyra', 'Valkyra', '#e5484d'], ['manticore', 'Manticore', '#3ddc84']];
const GAME_COLOR = '#7f8c8d';
const MAX_GAME_ROLES = 100;

// Names compared without emoji, brackets, dashes or spaces: "『👋』welcome" = "welcome", "○----[ Special ]-----○" = "Special".
export const plain = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+]/g, '');
const sameName = (have, names) => names.some((n) => plain(n) && plain(n) === plain(have));
const colorInt = (hex) => parseInt(String(hex || '#000000').replace('#', ''), 16) || 0;
const titleCase = (s) => String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const shortName = (s) => String(s).split(' — ')[0].trim().slice(0, 100);

export async function saveSetting(key, value) {
  await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
  clearSettingsCache();
}
async function readJson(key) {
  try { return JSON.parse((await setting(key)) || '{}') || {}; } catch { return {}; }
}
export const guildId = async () => String((await setting('discord_build_server_id')) || '').trim();
// Which Discord ids the app made or adopted on that server: { guild, roles: {key: id}, games: {appId: id}, channels: {key: id} }
export async function loadMap(guild) {
  const m = await readJson('_discord_server_map');
  return m.guild === guild ? { roles: {}, games: {}, channels: {}, ...m } : { guild, roles: {}, games: {}, channels: {} };
}
export const saveMap = (m) => saveSetting('_discord_server_map', JSON.stringify(m));

// ---------- What the server should have ----------
async function roleSpec() {
  const units = await q('SELECT * FROM combat_units ORDER BY sort_order, id');
  const command = units.find((u) => u.kind === 'command');
  // Divider roles: no permissions, just headings in the role list (matched to existing ones by their words).
  const divider = (key, word) => ({ key: `divider:${key}`, name: `○────[ ${word} ]────○`, color: '#7f8c8d', manual: true, divider: true });
  const list = [
    divider('staff', 'Staff'),
    { key: 'admin', name: 'Admin', aliases: ['Administrator'], color: '#e5484d', hoist: true, permissions: bits('ADMIN') },
    { key: 'mod', name: 'Moderator', aliases: ['Mod', 'Mods', 'Moderators'], color: '#f5a524', hoist: true, permissions: bits('KICK', 'BAN', 'MANAGE_MESSAGES', 'TIMEOUT', 'MUTE', 'DEAFEN', 'MOVE', 'NICKNAMES', 'AUDIT_LOG', 'MANAGE_THREADS', 'EVERYONE') },
  ];
  for (const r of command?.roles || []) list.push({ key: `cmd:${r.id}`, name: shortName(r.name), color: command.color || '#c9a227', hoist: true });
  list.push({ key: 'leader', name: 'Unit Leader', color: '#c9a227' });
  list.push(divider('clan', 'Clan'));
  list.push({ key: 'wpg', name: 'WPG Member', aliases: ['WPG Members'], color: '#29b6f6', hoist: true });
  for (const u of units.filter((x) => x.kind !== 'command')) list.push({ key: `unit:${u.id}`, name: titleCase(u.name), color: u.color });
  for (const [id, name, color] of FACTIONS) list.push({ key: `faction:${id}`, name, color });
  // Wardogs = PMC guests (linked to the app as PMC); taken off anyone who is a full WPG member.
  list.push({ key: 'pmc', name: 'Wardogs', aliases: ['PMC'], color: '#3ddc84', hoist: true });
  list.push(divider('special', 'Special'));
  for (const name of ['Content Creator', 'Partner', 'Military Vet']) list.push({ key: `manual:${name}`, name, color: '#9b59b6', manual: true });
  // WPG Community = everyone who's part of WPG (given by the entry check). Its key stays 'wardogs' (older saves).
  list.push({ key: 'wardogs', name: 'WPG Community', aliases: ['Community'], color: '#5865f2', hoist: true });
  list.push(divider('games', 'Game Roles'));
  list.push({ key: 'manual:18+', name: '18+', color: '#636e72', manual: true });
  // Picked by members themselves with the buttons in #pick-roles.
  for (const name of ['PC', 'Xbox', 'PlayStation', 'Switch']) list.push({ key: `manual:${name}`, name, color: '#95a5a6', manual: true });
  return { list, units, command };
}

// Categories and channels. Overwrites name roles by key ('everyone' = @everyone); allow / deny are permission names.
function channelSpec(units, command) {
  const staff = { mod: { allow: [...TALK, 'MANAGE_MESSAGES', 'MUTE', 'MOVE'] } };
  const gated = (who, extra = {}) => ({ everyone: { deny: ['VIEW'] }, [who]: { allow: TALK }, ...staff, ...extra });
  const leadersOnly = {
    wpg: { deny: ['VIEW'] }, leader: { allow: TALK },
    ...Object.fromEntries((command?.roles || []).map((r) => [`cmd:${r.id}`, { allow: TALK }])),
  };
  const t = (name, topic, more = {}) => ({ name, type: TEXT, topic, ...more });
  const v = (name, more = {}) => ({ name, type: VOICE, ...more });
  return [
    { key: 'start', name: '👋 START HERE', aliases: ['Welcome'], ow: { everyone: READ_ONLY }, channels: [
      t('welcome', 'Welcome to Wasted Prodigy Gamers.', { welcome: true }),
      t('rules', 'Read the rules, then press the button under them to get in.'),
    ] },
    { key: 'info', name: '📢 INFORMATION', aliases: ['Information', 'Info'], ow: gated('wardogs', { wardogs: READ_ONLY }), channels: [
      t('announcements', 'News from WPG staff.', { type: NEWS }),
      t('pick-roles', 'Pick your platforms (and 18+) with the buttons.'),
      t('contact-staff', 'Need staff? Press the button for a private ticket.'),
      t('our-servers', 'The WPG game servers.'), t('free-games', 'Free games going.'), t('wardogs-rules', 'Rules on the WPG Wardogs servers.'), t('socials', 'WPG on other sites.', { aliases: ['facebook', 'social-links'] }),
    ] },
    { key: 'community', name: '💬 COMMUNITY', aliases: ['Text chat'], ow: gated('wardogs'), channels: [
      t('general', 'Chat about anything.', { aliases: ['community-chat', 'general-chat'] }), t('intel-updates', 'Wardogs news and patch notes.'), t('steam-friend-codes', 'Add each other on Steam.'),
      t('clips-and-media', 'Your clips and screenshots.'), t('looking-for-group', 'Find people to play with.'),
      t('nsfw-talk', '18+ only.', { nsfw: true, ow: { wardogs: { deny: ['VIEW'] }, 'manual:18+': { allow: TALK } } }),
    ] },
    { key: 'wardogs', name: '🐺 WARDOGS', ow: gated('wardogs'), channels: [
      t('live-cash', 'Cash runs and trades.'), t('server-id', 'Which server we are on.', { aliases: ['wardogs-server-id'] }),
      v('🔵 Lonestar'), v('🔴 Valkyra'), v('🟢 Manticore'),
    ] },
    { key: 'app', name: '📱 WPG APP', ow: gated('wardogs', { wardogs: READ_ONLY }), channels: [
      t('go-live', 'Members going live (posted by the WPG app).', { post: 'discord_stream_channel' }),
      t('rank-ups', 'Promotions, medals and WPG rank-ups (posted by the WPG app).', { post: 'discord_post_channel' }),
      t('leaderboards', 'Leaderboards from the WPG app.'),
      t('app-help', 'Questions about the WPG app. Type /link here to connect your Discord.', { aliases: ['wpg-app'], ow: { wardogs: { allow: TALK } } }),
    ] },
    { key: 'clan', name: '🎖 WPG CLAN', aliases: ['Competative play', 'Competitive play'], ow: gated('wpg'), channels: [
      t('clan-chat', 'WPG members only.'), t('ops-planning', 'Plans for the next op.'),
      t('squad-leaders', 'Command and unit leaders.', { ow: leadersOnly }),
      v('Squad Leaders', { ow: leadersOnly }),
      ...units.filter((u) => u.kind !== 'command').map((u) => v(titleCase(u.name), { ow: { [`unit:${u.id}`]: { allow: ['PRIORITY'] } } })),
    ] },
    { key: 'halls', name: '🏰 GUILD HALLS', aliases: ['Guild halls'], ow: gated('wardogs'), channels: [
      v('guild-hall'), v('the-tavern'), v('war-room'), v('party-up'), v('seeding'), v('stream-lounge'), v('campfire-afk', { afk: true }),
    ] },
    { key: 'staff', name: '🔒 STAFF', ow: { everyone: { deny: ['VIEW'] }, ...staff }, channels: [
      t('staff-chat', 'Staff only.'), t('mod-log', 'Moderation notes.'), t('warcon-admin-log', 'WarCon admin log.'),
      t('app-admin-log', 'Cheat-watch alerts and reports from the WPG app.', { post: 'discord_staff_channel' }),
    ] },
    // Private ticket channels are made in here when someone presses Contact staff.
    { key: 'tickets', name: '🎫 TICKETS', ow: { everyone: { deny: ['VIEW'] }, ...staff }, channels: [] },
  ];
}

const WELCOME = `**Welcome to Wasted Prodigy Gamers!** 🐺

Read the rules in #rules and press the button under them to get in: that gives you the **WPG Community** role, which opens the server.
Already in the WPG app? Type **/link** in #app-help afterwards to connect your Discord. Your clan, unit, faction and game roles then follow your app profile automatically.`;

// ---------- Build (preview or for real) ----------
const building = { running: false, log: [], done: null, error: null, at: null };
export const buildStatus = () => ({ ...building, log: building.log.slice(-200) });

function overwriteList(owSpec, roleIds, guild) {
  const out = [];
  for (const [key, o] of Object.entries(owSpec)) {
    const id = key === 'everyone' ? guild : roleIds[key];
    if (!id) continue;
    out.push({ id, type: 0, allow: bits(...(o.allow || [])).toString(), deny: bits(...(o.deny || [])).toString() });
  }
  return out;
}

// tidy: an existing server being tidied up (Discord control → Server & roles → Tidy up): channels and categories are
// matched by name anywhere (emoji and brackets ignored), keep their names and places, and get exactly the layout's
// permissions (other role overwrites removed; member and bot overwrites kept). Channels that aren't in the layout
// take their category's permissions. removing: role ids being deleted (never matched to the layout's roles).
export async function buildServer({ apply = false, usePosts = false, tidy = false, removing = new Set(), botOnly = new Set() } = {}) {
  const guild = await guildId();
  if (!/^\d{15,22}$/.test(guild)) throw new Error('Set the Discord server ID first.');
  const actions = [];
  const say = (text) => { actions.push(text); if (apply) building.log.push(text); };
  const info = await discordFetch(`/guilds/${guild}`).catch((e) => {
    throw new Error(/40[134]/.test(e.message) ? 'The bot is not on that server yet (or the ID is wrong). Invite it with the button above.' : e.message);
  });
  const map = await loadMap(guild);
  const { list, units, command } = await roleSpec();
  const existingRoles = await discordFetch(`/guilds/${guild}/roles`);
  const byId = new Map(existingRoles.map((r) => [r.id, r]));
  const roleIds = {};
  const usedRoles = new Set();
  for (const spec of list) {
    // By name first (so a role keeps its meaning if the layout's names change), then the one used last time.
    const mapped = byId.get(map.roles[spec.key]);
    const found = existingRoles.find((r) => !r.managed && r.id !== guild && !removing.has(r.id) && !usedRoles.has(r.id) && sameName(r.name, [spec.name, ...(spec.aliases || [])]))
      || (mapped && !removing.has(mapped.id) && !usedRoles.has(mapped.id) && !list.some((o) => o !== spec && sameName(mapped.name, [o.name, ...(o.aliases || [])])) ? mapped : null);
    if (found) { roleIds[spec.key] = found.id; usedRoles.add(found.id); continue; }
    say(`Create role "${spec.name}"`);
    if (apply) {
      const r = await discordFetch(`/guilds/${guild}/roles`, 'POST', {
        name: spec.name, color: colorInt(spec.color), hoist: !!spec.hoist, mentionable: false, permissions: (spec.permissions || 0n).toString(),
      });
      roleIds[spec.key] = r.id;
      usedRoles.add(r.id);
    } else {
      roleIds[spec.key] = `new:${spec.key}`;
    }
  }
  // Roles in order, just under the bot's own highest role (the bot can't place anything above it).
  {
    const me = await discordFetch('/users/@me');
    const mine = await discordFetch(`/guilds/${guild}/members/${me.id}`);
    const fresh = apply ? await discordFetch(`/guilds/${guild}/roles`) : existingRoles;
    const pos = new Map(fresh.map((r) => [r.id, r.position]));
    const top = Math.max(0, ...mine.roles.map((id) => pos.get(id) || 0));
    // The whole order is set at once (below the bot): other bots' roles and owner / admin roles first as they were,
    // then the layout, then the server's other roles (e.g. game roles) under the Game Roles divider.
    const below = fresh.filter((r) => r.id !== guild && !removing.has(r.id) && (pos.get(r.id) || 0) < top).sort((a, b) => b.position - a.position);
    const isTop = (r) => !usedRoles.has(r.id) && (r.managed || botOnly.has(r.id) || (BigInt(r.permissions || 0) & (1n << 3n)) !== 0n);
    const head = below.filter(isTop).map((r) => r.id);
    const rest = below.filter((r) => !isTop(r) && !usedRoles.has(r.id)).map((r) => r.id);
    const ids = [...head, ...list.map((s) => roleIds[s.key]), ...rest];
    const isNew = ids.some((id) => String(id).startsWith('new:'));
    const ours = ids.filter((id) => pos.has(id) && pos.get(id) < top);
    const off = isNew || ours.some((id, i) => i > 0 && pos.get(id) > pos.get(ours[i - 1]));
    if (off) {
      say('Put the roles in order (under the bot\'s own role)');
      if (apply) {
        const wanted = ours.map((id, i) => ({ id, position: Math.max(1, top - 1 - i) }));
        await discordFetch(`/guilds/${guild}/roles`, 'PATCH', wanted).catch((e) => say(`Couldn't reorder roles: ${e.message}`));
      }
    }
  }

  // Categories and channels.
  const channels = await discordFetch(`/guilds/${guild}/channels`);
  const posts = {};
  let afk = null;
  const usedChannels = new Set();
  const wantedFor = new Map(); // category id → the permissions it should have
  const botRoles = new Set([...existingRoles.filter((r) => r.managed).map((r) => r.id), ...botOnly]);
  for (const cat of channelSpec(units, command)) {
    let catCh = channels.find((c) => c.id === map.channels[`cat:${cat.key}`])
      || channels.find((c) => c.type === CATEGORY && !usedChannels.has(c.id) && sameName(c.name, [cat.name, ...(cat.aliases || [])]));
    const catOw = overwriteList(cat.ow, roleIds, guild);
    if (!catCh) {
      say(`Create category ${cat.name}`);
      if (apply) catCh = await discordFetch(`/guilds/${guild}/channels`, 'POST', { name: cat.name, type: CATEGORY, permission_overwrites: catOw });
    } else if (tidy) {
      await replaceOverwrites(catCh, catOw, apply, say, botRoles);
    } else {
      await fixOverwrites(catCh, catOw, apply, say);
    }
    if (catCh) { usedChannels.add(catCh.id); wantedFor.set(catCh.id, catOw); }
    if (catCh) map.channels[`cat:${cat.key}`] = catCh.id;
    for (const ch of cat.channels) {
      const ow = overwriteList({ ...cat.ow, ...(ch.ow || {}) }, roleIds, guild);
      const key = `${cat.key}:${ch.name}`;
      const sameType = (c) => c.type === ch.type || (ch.type === NEWS && c.type === TEXT) || (ch.type === TEXT && c.type === NEWS);
      const names = [ch.name, ...(ch.aliases || [])];
      const free = (c) => sameType(c) && !usedChannels.has(c.id) && sameName(c.name, names);
      let found = channels.find((c) => c.id === map.channels[key])
        || (catCh && channels.find((c) => free(c) && c.parent_id === catCh.id))
        || (tidy ? channels.find(free) : null); // tidying: wherever it is on the server (it stays there)
      if (!found) {
        say(`Create ${ch.type === VOICE ? 'voice' : 'text'} channel ${ch.name} in ${cat.name}`);
        if (apply) {
          const body = { name: ch.name, type: ch.type, parent_id: catCh.id, permission_overwrites: ow, ...(ch.topic && ch.type !== VOICE ? { topic: ch.topic } : {}), ...(ch.nsfw ? { nsfw: true } : {}) };
          found = await discordFetch(`/guilds/${guild}/channels`, 'POST', body).catch(async (e) => {
            // Announcement channels need Community switched on: make a normal text channel instead.
            if (ch.type !== NEWS) throw e;
            return discordFetch(`/guilds/${guild}/channels`, 'POST', { ...body, type: TEXT });
          });
          if (ch.welcome) await discordFetch(`/channels/${found.id}/messages`, 'POST', { content: WELCOME }).catch(() => {});
        }
      } else if (tidy) {
        await replaceOverwrites(found, ow, apply, say, botRoles);
      } else {
        await fixOverwrites(found, ow, apply, say);
      }
      if (found) {
        usedChannels.add(found.id);
        map.channels[key] = found.id;
        if (ch.post) posts[ch.post] = found.id;
        if (ch.afk) afk = found.id;
      }
    }
  }
  // Tidying: categories and channels that aren't part of the layout. Other categories get the community's
  // access (Wardogs and staff); channels not in the layout take their category's permissions.
  if (tidy) {
    const rest = overwriteList({ everyone: { deny: ['VIEW'] }, wardogs: { allow: TALK }, mod: { allow: [...TALK, 'MANAGE_MESSAGES', 'MUTE', 'MOVE'] } }, roleIds, guild);
    for (const c of channels.filter((x) => x.type === CATEGORY && !usedChannels.has(x.id))) {
      await replaceOverwrites(c, rest, apply, say, botRoles);
      wantedFor.set(c.id, rest);
      usedChannels.add(c.id);
    }
    const ticketsCat = map.channels['cat:tickets'];
    for (const c of channels.filter((x) => x.type !== CATEGORY && !usedChannels.has(x.id) && x.parent_id !== ticketsCat)) {
      await replaceOverwrites(c, wantedFor.get(c.parent_id) || rest, apply, say, botRoles);
    }
  }
  if (afk && info.afk_channel_id !== afk) {
    say('Set campfire-afk as the AFK channel');
    if (apply) await discordFetch(`/guilds/${guild}`, 'PATCH', { afk_channel_id: afk, afk_timeout: 900 }).catch((e) => say(`Couldn't set the AFK channel: ${e.message}`));
  } else if (!afk && !apply) {
    say('Set campfire-afk as the AFK channel');
  }
  if (usePosts) {
    say('Point the app\'s Discord posts (go-live, rank-ups, staff alerts) and voice list at this server');
    if (apply) {
      for (const [k, id] of Object.entries(posts)) await saveSetting(k, id);
      await saveSetting('discord_server_id', guild);
      bus.emit('config:changed', 'settings');
    }
  }
  // Rules post with the entry button, role and ticket buttons, AutoMod and Discord's verification level.
  await setupModeration({ guild, info, map, roleIds, apply, say });
  if (apply) {
    map.roles = Object.fromEntries(Object.entries(roleIds).filter(([, id]) => !String(id).startsWith('new:')));
    await saveMap(map);
  }
  return { server: info.name, actions };
}

// Tidying: a channel gets exactly these permissions; overwrites for single members and for bots' roles are kept.
async function replaceOverwrites(ch, wanted, apply, say, botRoles) {
  if (wanted.some((o) => o.id.startsWith('new:'))) { say(`Reset who can see ${ch.name}`); return; }
  const keep = (ch.permission_overwrites || []).filter((o) => o.type === 1 || botRoles.has(o.id));
  const final = [...wanted.filter((o) => !keep.some((k) => k.id === o.id)), ...keep.map((o) => ({ id: o.id, type: o.type, allow: String(o.allow), deny: String(o.deny) }))];
  const key = (list) => list.map((o) => `${o.id}:${o.allow}:${o.deny}`).sort().join('|');
  if (key(final) === key((ch.permission_overwrites || []).map((o) => ({ ...o, allow: String(o.allow), deny: String(o.deny) })))) return;
  say(`Reset who can see ${ch.name}`);
  if (apply) await discordFetch(`/channels/${ch.id}`, 'PATCH', { permission_overwrites: final });
}

// Sets the app's overwrites on an existing channel, leaving anyone else's as they are.
async function fixOverwrites(ch, wanted, apply, say) {
  const have = new Map((ch.permission_overwrites || []).map((o) => [o.id, o]));
  for (const o of wanted) {
    if (o.id.startsWith('new:')) { say(`Set who can see ${ch.name}`); continue; }
    const cur = have.get(o.id);
    if (cur && String(cur.allow) === o.allow && String(cur.deny) === o.deny) continue;
    say(`Set who can see ${ch.name}`);
    if (apply) await discordFetch(`/channels/${ch.id}/permissions/${o.id}`, 'PUT', { type: 0, allow: o.allow, deny: o.deny });
  }
}

export function startBuild(opts) {
  if (building.running) throw new Error('A build is already running.');
  Object.assign(building, { running: true, log: [], done: null, error: null, at: new Date().toISOString() });
  buildServer({ ...opts, apply: true })
    .then((r) => { building.done = r; building.log.push('Done.'); })
    .catch((e) => { building.error = e.message; building.log.push(`Stopped: ${e.message}`); })
    .finally(() => { building.running = false; scheduleSync(3000); });
}

// ---------- Tidy up an existing server ----------
// Scan: every role with how many members have it and what happens to it (kept: the layout's roles, dividers,
// staff / owner roles, bots' and integrations' roles, and any role with 5+ members; the rest removed), risky
// permissions taken off kept roles that aren't staff, the server's bots (all kept), and the channel changes.
// countFrom: another server to take member counts from by role name (for testing on a copy of the real server).
const RISKY = { ADMIN: 1n << 3n, 'Manage Server': 1n << 5n, 'Manage Roles': 1n << 28n, 'Manage Channels': 1n << 4n, Kick: 1n << 1n, Ban: 1n << 2n,
  'Manage Messages': 1n << 13n, Timeout: 1n << 40n, 'Mention @everyone': 1n << 17n, 'Manage Webhooks': 1n << 29n, 'Manage Nicknames': 1n << 27n,
  'Audit log': 1n << 7n, 'Mute members': 1n << 22n, 'Deafen members': 1n << 23n, 'Move members': 1n << 24n, 'Manage Threads': 1n << 34n,
  'Manage Emojis': 1n << 30n, 'Manage Events': 1n << 33n };
const RISKY_ALL = Object.values(RISKY).reduce((a, b) => a | b, 0n);
export const KEEP_AT = 5;

export async function tidyScan({ countFrom = '' } = {}) {
  const guild = await guildId();
  if (!/^\d{15,22}$/.test(guild)) throw new Error('Set the Discord server ID first.');
  const info = await discordFetch(`/guilds/${guild}`);
  const roles = await discordFetch(`/guilds/${guild}/roles`);
  const members = await allMembers(guild).catch(() => { throw new Error("Discord won't list the server's members: switch on SERVER MEMBERS INTENT in the Developer Portal → Bot."); });
  const counts = new Map();
  const humans = new Map(); // role → how many of its members are people (not bots)
  for (const m of members) for (const r of m.roles) { counts.set(r, (counts.get(r) || 0) + 1); if (!m.user.bot) humans.set(r, (humans.get(r) || 0) + 1); }
  // Roles our own bot has, and roles only bots have (bots given an ordinary role, e.g. "YAGPDB.xyz"): never removed.
  const me = await discordFetch('/users/@me');
  const mine = new Set(members.find((m) => m.user.id === me.id)?.roles || []);
  // Testing on a copy: count members on the real server instead, matching roles by name.
  let byName = null;
  if (/^\d{15,22}$/.test(countFrom) && countFrom !== guild) {
    const [srcRoles, srcMembers] = await Promise.all([discordFetch(`/guilds/${countFrom}/roles`), allMembers(countFrom)]);
    const n = new Map();
    for (const m of srcMembers) for (const r of m.roles) n.set(r, (n.get(r) || 0) + 1);
    byName = new Map(srcRoles.map((r) => [plain(r.name), n.get(r.id) || 0]));
  }
  const { list } = await roleSpec();
  const map = await loadMap(guild);
  const used = new Set();
  const specFor = new Map();
  for (const spec of list) {
    const mapped = roles.find((x) => x.id === map.roles[spec.key] && !used.has(x.id) && !list.some((o) => o !== spec && sameName(x.name, [o.name, ...(o.aliases || [])])));
    const r = roles.find((x) => !x.managed && x.id !== guild && !used.has(x.id) && sameName(x.name, [spec.name, ...(spec.aliases || [])])) || mapped;
    if (r) { used.add(r.id); specFor.set(r.id, spec); }
  }
  const out = [];
  for (const r of roles.filter((x) => x.id !== guild).sort((a, b) => b.position - a.position)) {
    const count = byName ? byName.get(plain(r.name)) ?? counts.get(r.id) ?? 0 : counts.get(r.id) || 0;
    const perms = BigInt(r.permissions || 0);
    const spec = specFor.get(r.id);
    const owner = (perms & RISKY.ADMIN) !== 0n;
    let keep = true;
    let locked = true;
    let reason;
    if (r.managed) reason = 'Bot or integration role (goes when the bot / integration is removed)';
    else if (mine.has(r.id)) reason = "This app's bot role";
    else if ((counts.get(r.id) || 0) > 0 && !humans.get(r.id)) reason = 'Only bots have it (kept so the bots keep working)';
    else if (spec?.divider) reason = 'Divider';
    else if (spec) reason = `Used by the app: ${spec.name}`;
    else if (owner) reason = 'Server owner / admin role';
    else {
      locked = false;
      keep = count >= KEEP_AT;
      reason = `${count} member${count === 1 ? '' : 's'}`;
    }
    // Kept roles that aren't staff lose risky permissions (they get their access from the channels instead).
    const botRole = mine.has(r.id) || ((counts.get(r.id) || 0) > 0 && !humans.get(r.id));
    const staffRole = owner || r.managed || botRole || spec?.key === 'admin' || spec?.key === 'mod';
    const fix = keep && !staffRole && (perms & RISKY_ALL) ? Object.entries(RISKY).filter(([, b]) => perms & b).map(([n]) => n) : [];
    out.push({ id: r.id, name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : '', members: count, keep, locked, reason, fix, bot: botRole && !r.managed });
  }
  const bots = members.filter((m) => m.user.bot).map((m) => ({ id: m.user.id, name: m.user.global_name || m.user.username }));
  const removing = new Set(out.filter((r) => !r.keep).map((r) => r.id));
  const layout = await buildServer({ apply: false, tidy: true, removing, botOnly: new Set(out.filter((r) => r.bot).map((r) => r.id)) });
  return { server: info.name, guild, count_from: byName ? countFrom : '', roles: out, bots, actions: layout.actions };
}

// Apply: back everything up, remove the chosen roles, take risky permissions off kept roles, then run the build in
// tidy mode (layout roles, channel permissions, rules post, AutoMod…) and sync everyone's roles.
export function startTidy({ remove = [], countFrom = '' } = {}) {
  if (building.running) throw new Error('A build is already running.');
  Object.assign(building, { running: true, log: [], done: null, error: null, at: new Date().toISOString() });
  const say = (t) => building.log.push(t);
  (async () => {
    const guild = await guildId();
    const scan = await tidyScan({ countFrom });
    // Backup first: roles, channels with their permissions, and every member's roles.
    const [roles, channels, members] = await Promise.all([
      discordFetch(`/guilds/${guild}/roles`), discordFetch(`/guilds/${guild}/channels`), allMembers(guild),
    ]);
    await saveSetting('_discord_backup', JSON.stringify({
      guild, server: scan.server, at: new Date().toISOString(), roles, channels,
      members: members.map((m) => ({ id: m.user.id, name: m.user.username, roles: m.roles })),
    }));
    say(`Backed up ${roles.length} roles, ${channels.length} channels and ${members.length} members' roles (Download backup on this page).`);
    // Only roles the scan allows removing (never the layout's, staff, bots' or dividers).
    const allowed = new Set(scan.roles.filter((r) => !r.locked).map((r) => r.id));
    const removing = new Set(remove.filter((id) => allowed.has(id)));
    for (const r of scan.roles.filter((x) => removing.has(x.id))) {
      say(`Remove role "${r.name}" (${r.members} member${r.members === 1 ? '' : 's'})`);
      await discordFetch(`/guilds/${guild}/roles/${r.id}`, 'DELETE').catch((e) => say(`Couldn't remove "${r.name}": ${e.message}`));
    }
    for (const r of scan.roles.filter((x) => x.fix.length && !removing.has(x.id))) {
      const now = roles.find((x) => x.id === r.id);
      if (!now) continue;
      say(`Take ${r.fix.join(', ')} off "${r.name}"`);
      await discordFetch(`/guilds/${guild}/roles/${r.id}`, 'PATCH', { permissions: String(BigInt(now.permissions) & ~RISKY_ALL) }).catch((e) => say(`Couldn't change "${r.name}": ${e.message}`));
    }
    const done = await buildServer({ apply: true, tidy: true, removing, botOnly: new Set(scan.roles.filter((r) => r.bot).map((r) => r.id)) });
    return done;
  })()
    .then((r) => { building.done = r; building.log.push('Done.'); })
    .catch((e) => { building.error = e.message; building.log.push(`Stopped: ${e.message}`); })
    .finally(() => { building.running = false; scheduleSync(3000); });
}

export async function lastBackup() {
  try { return JSON.parse((await setting('_discord_backup')) || 'null'); } catch { return null; }
}

// ---------- Role sync ----------
export async function allMembers(guild) {
  const out = [];
  let after = '0';
  for (;;) {
    const page = await discordFetch(`/guilds/${guild}/members?limit=1000&after=${after}`);
    out.push(...page);
    if (page.length < 1000) return out;
    after = page[page.length - 1].user.id;
  }
}

let syncing = false;
export async function syncRoles() {
  if ((await setting('discord_sync_roles')) !== 'true') return { ok: false, reason: 'Role sync is off' };
  const guild = await guildId();
  if (!/^\d{15,22}$/.test(guild)) return { ok: false, reason: 'No Discord server set' };
  if (syncing) return { ok: false, reason: 'Already syncing' };
  syncing = true;
  try {
    const map = await loadMap(guild);
    if (!map.roles.wardogs) return record({ ok: false, reason: 'Build the server first (the roles are made by Build server)' });
    let members;
    try {
      members = await allMembers(guild);
    } catch (e) {
      const reason = /403|50001/.test(e.message)
        ? 'Discord won\'t list the server\'s members: switch on SERVER MEMBERS INTENT (Developer Portal → your app → Bot → Privileged Gateway Intents).'
        : e.message;
      return record({ ok: false, reason });
    }
    // Check the app's roles still exist (someone may have deleted one in Discord).
    const roles = await discordFetch(`/guilds/${guild}/roles`);
    const live = new Set(roles.map((r) => r.id));
    const { list, units } = await roleSpec();
    const managedKeys = list.filter((s) => !s.manual).map((s) => s.key);

    const users = await q("SELECT id, role, status, membership, steam_id, discord_id, custom_fields FROM users WHERE discord_id <> ''");
    const byDiscord = new Map(users.map((u) => [u.discord_id, u]));
    const postings = new Map((await q('SELECT user_id, unit_id, role_id FROM combat_postings')).map((p) => [p.user_id, p]));
    const unitById = new Map(units.map((u) => [u.id, u]));
    const fField = await one("SELECT key FROM profile_fields WHERE type='select' AND options ILIKE '%lonestar%' AND options ILIKE '%valkyra%' LIMIT 1");

    // Game roles: games linked members on the server have played for the set hours (Wardogs itself has its own role).
    const hours = Math.max(1, Number(await setting('discord_game_role_hours')) || 100);
    const wardogsApps = new Set((await q("SELECT app_id FROM games WHERE name ILIKE '%wardog%'")).map((g) => g.app_id));
    const onServer = new Set(members.map((m) => m.user.id));
    const linkedHere = users.filter((u) => onServer.has(u.discord_id) && u.status === 'active');
    const plays = linkedHere.length
      ? await q('SELECT user_id, app_id, name FROM steam_playtime WHERE minutes >= $1 AND user_id = ANY($2::int[])', [hours * 60, linkedHere.map((u) => u.id)])
      : [];
    const gamesOf = new Map();
    const count = new Map();
    const names = new Map();
    for (const p of plays) {
      if (wardogsApps.has(p.app_id) || /wardogs/i.test(p.name)) continue;
      if (!gamesOf.has(p.user_id)) gamesOf.set(p.user_id, new Set());
      gamesOf.get(p.user_id).add(p.app_id);
      count.set(p.app_id, (count.get(p.app_id) || 0) + 1);
      names.set(p.app_id, p.name || `Steam app ${p.app_id}`);
    }
    // Game roles switched off: no game roles (the ones made before are removed below).
    if ((await setting('discord_game_roles')) === 'false') count.clear();
    const keepGames = new Set([...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_GAME_ROLES).map(([id]) => id));
    let created = 0;
    let deleted = 0;
    for (const appId of keepGames) {
      if (map.games[appId] && live.has(map.games[appId])) continue;
      const r = await discordFetch(`/guilds/${guild}/roles`, 'POST', { name: names.get(appId).slice(0, 100), color: colorInt(GAME_COLOR), hoist: false, mentionable: false, permissions: '0' });
      map.games[appId] = r.id;
      live.add(r.id);
      created++;
    }
    for (const [appId, id] of Object.entries(map.games)) {
      if (keepGames.has(Number(appId))) continue;
      if (live.has(id)) await discordFetch(`/guilds/${guild}/roles/${id}`, 'DELETE').catch(() => {});
      delete map.games[appId];
      deleted++;
    }
    if (created || deleted) await saveMap(map);

    const rid = (key) => (live.has(map.roles[key]) ? map.roles[key] : null);
    const managed = new Set([...managedKeys.map(rid), ...Object.values(map.games)].filter(Boolean));
    let added = 0;
    let removed = 0;
    let linked = 0;
    // With the entry check on, Wardogs is only for people who passed it (or were let in, or joined before it
    // was switched on, or linked the app). Nobody loses Wardogs for not having done it.
    const gate = await entryOn();
    const passed = gate ? await entryFreePass(guild) : null;
    for (const m of members) {
      if (m.user.bot || m.pending) continue;
      const u = byDiscord.get(m.user.id);
      const want = new Set();
      if (!gate || u || m.roles.includes(rid('wardogs')) || passed(m)) want.add(rid('wardogs'));
      if (u) {
        linked++;
        if (u.status === 'active') {
          if (u.role === 'admin' || isOwner(u)) want.add(rid('admin'));
          else if (u.role === 'mod') want.add(rid('mod'));
          if (u.membership !== 'pmc') want.add(rid('wpg'));
          else want.add(rid('pmc')); // PMC guest: Wardogs
          const p = postings.get(u.id);
          const unit = p && unitById.get(p.unit_id);
          if (unit) {
            if (unit.kind === 'command') want.add(rid(`cmd:${p.role_id}`));
            else {
              want.add(rid(`unit:${unit.id}`));
              if ((unit.roles || []).find((r) => r.id === p.role_id)?.leader) want.add(rid('leader'));
            }
          }
          const f = String(fField ? u.custom_fields?.[fField.key] || '' : '').toLowerCase();
          if (FACTIONS.some(([id]) => id === f)) want.add(rid(`faction:${f}`));
          for (const appId of gamesOf.get(u.id) || []) if (keepGames.has(appId)) want.add(map.games[appId]);
        }
      }
      want.delete(null);
      want.delete(undefined);
      const have = new Set(m.roles);
      for (const id of want) {
        if (have.has(id)) continue;
        await discordFetch(`/guilds/${guild}/members/${m.user.id}/roles/${id}`, 'PUT').catch(() => {});
        added++;
      }
      // Wardogs is for PMC guests: anyone with WPG Member (given here or by hand) doesn't keep it.
      if (rid('pmc') && have.has(rid('pmc')) && (want.has(rid('wpg')) || have.has(rid('wpg'))) && !want.has(rid('pmc'))) {
        await discordFetch(`/guilds/${guild}/members/${m.user.id}/roles/${rid('pmc')}`, 'DELETE').catch(() => {});
        have.delete(rid('pmc'));
        removed++;
      }
      // Only linked members lose roles: the app knows exactly what they should have.
      if (!u) continue;
      for (const id of have) {
        if (!managed.has(id) || want.has(id)) continue;
        await discordFetch(`/guilds/${guild}/members/${m.user.id}/roles/${id}`, 'DELETE').catch(() => {});
        removed++;
      }
    }
    return record({ ok: true, members: members.filter((m) => !m.user.bot).length, linked, added, removed, game_roles: keepGames.size });
  } catch (e) {
    return record({ ok: false, reason: e.message });
  } finally {
    syncing = false;
  }
}
async function record(r) {
  await saveSetting('_discord_sync', JSON.stringify({ ...r, at: new Date().toISOString() }));
  return r;
}
export const lastSync = () => readJson('_discord_sync');

// A Discord account unlinked from the app: take off the roles the app gave it (Wardogs stays).
export async function stripRoles(discordId) {
  const guild = await guildId();
  if (!/^\d{15,22}$/.test(guild) || (await setting('discord_sync_roles')) !== 'true') return;
  const map = await loadMap(guild);
  const { list } = await roleSpec();
  const managed = new Set([...list.filter((s) => !s.manual && s.key !== 'wardogs').map((s) => map.roles[s.key]), ...Object.values(map.games)].filter(Boolean));
  const m = await discordFetch(`/guilds/${guild}/members/${discordId}`).catch(() => null);
  for (const id of m?.roles || []) {
    if (managed.has(id)) await discordFetch(`/guilds/${guild}/members/${discordId}/roles/${id}`, 'DELETE').catch(() => {});
  }
}

let timer = null;
export function scheduleSync(ms = 15000) {
  clearTimeout(timer);
  timer = setTimeout(() => syncRoles().catch((e) => console.warn('[discord roles]', e.message)), ms);
}

export function startDiscordServer() {
  // Changes in the app (approvals, roles, postings, profiles, /link) are passed on shortly after.
  for (const ev of ['user:changed', 'combat:changed']) bus.on(ev, () => scheduleSync());
  bus.on('discord:unlinked', (id) => stripRoles(id).catch((e) => console.warn('[discord roles]', e.message)));
  // New joiners get WPG Community, Steam games and anything missed: every 2 minutes.
  setInterval(() => syncRoles().catch((e) => console.warn('[discord roles]', e.message)), 2 * 60 * 1000);
  scheduleSync(60 * 1000);
}
