// Discord moderation and the entry check, on the server set in Admin → Discord server.
//  - Entry: new joiners only see #welcome and #rules. The button under the rules opens a short check (type a code,
//    answer a yes / no question about the rules); passing gives WPG Community, which opens the server. Accounts younger than
//    discord_entry_min_age_days are held for staff (Let in / Kick buttons in #staff-chat). Three failed checks = kicked,
//    and anyone who hasn't got in after discord_entry_kick_hours is kicked (with a message that they can rejoin).
//    Lots of joins in a minute pauses entry for 15 minutes and alerts staff (raid alarm).
//  - Moderation: Discord's own AutoMod rules (slurs, sexual content, spam, mass mentions, invite and scam links,
//    staff's blocked words), /warn /timeout /untimeout /kick /ban /unban /purge /slowmode /lock /unlock /cases /unwarn,
//    warnings that escalate (timeout, then kick), a spam filter (repeats, floods, caps) and a mod log of joins, leaves,
//    edits, deletes, role / nickname changes, timeouts and bans. Every action is kept as a case.
//  - Extras: welcome posts, #pick-roles buttons (platforms, 18+) and #contact-staff tickets (private channels).
import { q, one, setting } from './db.js';
import { bus } from './bus.js';
import { discordFetch, sendToChannel } from './discordbot.js';
import { guildId, loadMap, saveMap, allMembers, saveSetting, scheduleSync } from './discordserver.js';

const flagOn = async (k) => (await setting(k)) === 'true';
// Every on / off switch for the bot (Admin → Discord). All on to start with.
export const SWITCHES = [
  'discord_mod_commands', 'discord_dm_members',
  'discord_automod_slurs', 'discord_automod_spam', 'discord_automod_mentions', 'discord_automod_links', 'discord_automod_words',
  'discord_filter_repeats', 'discord_filter_flood', 'discord_filter_caps',
  'discord_log_joins', 'discord_log_messages', 'discord_log_members', 'discord_log_bans',
  'discord_welcome_posts', 'discord_raid_alarm', 'discord_tickets', 'discord_role_buttons', 'discord_game_roles', 'discord_raise_verification',
];
export const entryOn = () => flagOn('discord_entry_enabled');
const num = async (k, d) => { const n = Number(await setting(k)); return Number.isFinite(n) && n > 0 ? n : d; };

const BIT = { ADMIN: 1n << 3n, KICK: 1n << 1n, BAN: 1n << 2n, MANAGE_CHANNELS: 1n << 4n, MANAGE_MESSAGES: 1n << 13n, MODERATE: 1n << 40n, SEND: 1n << 11n, VIEW: 1n << 10n, HISTORY: 1n << 16n, ATTACH: 1n << 15n, EMBED: 1n << 14n };
const COLOR = { red: 0xe5484d, amber: 0xf5a524, green: 0x3ddc84, blue: 0x29b6f6, grey: 0x7f8c8d };
const EPHEMERAL = 64;
const nameOf = (u) => (u ? u.global_name || u.username || u.id : 'someone');
const createdAt = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);
const isStaffPerms = (p) => { try { return (BigInt(p || 0) & (BIT.ADMIN | BIT.MODERATE | BIT.KICK | BIT.BAN)) !== 0n; } catch { return false; } };
const ago = (ms) => { const d = Math.floor(ms / 86400000); return d >= 1 ? `${d} day${d === 1 ? '' : 's'}` : `${Math.max(1, Math.floor(ms / 3600000))} hour(s)`; };
const ephemeral = (content, extra = {}) => ({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...extra } });

async function ctx() {
  const guild = await guildId();
  const map = await loadMap(guild);
  return { guild, map, ch: (k) => map.channels?.[k] || null, role: (k) => map.roles?.[k] || null };
}

// ---------- Mod log, cases, DMs ----------
async function modLog(guild, embed, extra = {}) {
  const c = await ctx();
  if (guild !== c.guild || !c.ch('staff:mod-log')) return;
  await discordFetch(`/channels/${c.ch('staff:mod-log')}/messages`, 'POST', {
    embeds: [{ color: COLOR.blue, timestamp: new Date().toISOString(), ...embed }], allowed_mentions: { parse: [] }, ...extra,
  }).catch((e) => console.warn('[discord mod] log', e.message));
}
const ACTION_LABEL = { warn: '⚠️ Warning', timeout: '⏳ Timeout', untimeout: '✅ Timeout removed', kick: '👢 Kick', ban: '🔨 Ban', unban: '♻️ Unban', spam: '🧹 Spam removed', 'auto-timeout': '⏳ Automatic timeout', 'auto-kick': '👢 Automatic kick', 'entry-kick': '🚪 Entry check: kicked' };
async function addCase(guild, user, action, reason, mod, minutes = 0) {
  const row = await one(
    'INSERT INTO discord_cases (guild_id, user_id, user_name, action, reason, mod_id, mod_name, minutes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [guild, user.id, nameOf(user).slice(0, 64), action, String(reason || '').slice(0, 500), mod?.id || '', mod ? nameOf(mod).slice(0, 64) : 'WPG bot', minutes],
  );
  await modLog(guild, {
    color: ['ban', 'kick', 'auto-kick', 'entry-kick'].includes(action) ? COLOR.red : action === 'unban' || action === 'untimeout' ? COLOR.green : COLOR.amber,
    title: `${ACTION_LABEL[action] || action} · case #${row.id}`,
    description: `**Member:** <@${user.id}> (${nameOf(user)})\n**By:** ${mod ? `<@${mod.id}>` : 'WPG bot'}${minutes ? `\n**For:** ${minutes} min` : ''}${reason ? `\n**Reason:** ${reason}` : ''}`,
  });
  return row.id;
}
async function dm(userId, content) {
  if (!(await flagOn('discord_dm_members'))) return false;
  try {
    const c = await discordFetch('/users/@me/channels', 'POST', { recipient_id: userId });
    await discordFetch(`/channels/${c.id}/messages`, 'POST', { content, allowed_mentions: { parse: [] } });
    return true;
  } catch { return false; }
}
const serverName = async (guild) => (await discordFetch(`/guilds/${guild}`).catch(() => null))?.name || 'the WPG Discord';

const timeoutMember = (guild, id, minutes) => discordFetch(`/guilds/${guild}/members/${id}`, 'PATCH', { communication_disabled_until: minutes ? new Date(Date.now() + minutes * 60000).toISOString() : null });
const kickMember = (guild, id) => discordFetch(`/guilds/${guild}/members/${id}`, 'DELETE');

// Active warnings (last 30 days, not removed) and what they lead to.
async function escalate(guild, user, mod) {
  const n = (await one("SELECT COUNT(*)::int AS n FROM discord_cases WHERE guild_id=$1 AND user_id=$2 AND action='warn' AND NOT removed AND created_at > now() - interval '30 days'", [guild, user.id])).n;
  const timeoutAt = await num('discord_warn_timeout_at', 3);
  const kickAt = await num('discord_warn_kick_at', 5);
  if (n >= kickAt) {
    await dm(user.id, `You've been kicked from ${await serverName(guild)} after ${n} warnings. You can rejoin, but please follow the rules.`);
    await kickMember(guild, user.id).catch(() => {});
    await addCase(guild, user, 'auto-kick', `${n} warnings`, null);
    return `They now have ${n} warnings, so they've been kicked.`;
  }
  if (n >= timeoutAt) {
    await timeoutMember(guild, user.id, 60).catch(() => {});
    await addCase(guild, user, 'auto-timeout', `${n} warnings`, null, 60);
    return `They now have ${n} warnings, so they've had a 1-hour timeout.`;
  }
  return `They have ${n} warning${n === 1 ? '' : 's'} (timeout at ${timeoutAt}, kick at ${kickAt}).`;
}

// ---------- Moderator slash commands ----------
const P = (b) => b.toString();
const userOpt = (description = 'Which member') => ({ type: 6, name: 'member', description, required: true });
const reasonOpt = (required = true) => ({ type: 3, name: 'reason', description: 'Why (they are told this)', required, max_length: 400 });
const opt = (data, name) => (data.options || []).find((o) => o.name === name)?.value;

function target(data, body) {
  const id = opt(data, 'member');
  const user = data.resolved?.users?.[id];
  const member = data.resolved?.members?.[id];
  const caller = body.member?.user || {};
  if (!user) return { error: 'Pick a member.' };
  if (user.id === caller.id) return { error: "You can't do that to yourself." };
  if (user.bot) return { error: "That's a bot." };
  if (member && isStaffPerms(member.permissions)) return { error: "That's a staff member: sort it out in #staff-chat instead." };
  return { user, member, mod: caller };
}

export const MOD_COMMANDS = {
  warn: {
    description: 'Warn a member (they get a DM; warnings lead to a timeout, then a kick)', perms: P(BIT.MODERATE),
    options: [userOpt(), reasonOpt()],
    run: async (data, _c, _n, body) => {
      const t = target(data, body); if (t.error) return { content: t.error };
      const reason = opt(data, 'reason');
      const id = await addCase(body.guild_id, t.user, 'warn', reason, t.mod);
      const told = await dm(t.user.id, `⚠️ You've been warned in ${await serverName(body.guild_id)}: ${reason}`);
      return { content: `Warned ${nameOf(t.user)} (case #${id})${told ? '' : " (their DMs are closed, so they weren't told)"}. ${await escalate(body.guild_id, t.user, t.mod)}` };
    },
  },
  timeout: {
    description: "Time a member out (they can't talk or join voice)", perms: P(BIT.MODERATE),
    options: [userOpt(), { type: 4, name: 'minutes', description: 'How long (1 minute to 28 days)', required: true, min_value: 1, max_value: 40320 }, reasonOpt()],
    run: async (data, _c, _n, body) => {
      const t = target(data, body); if (t.error) return { content: t.error };
      const minutes = Number(opt(data, 'minutes'));
      await timeoutMember(body.guild_id, t.user.id, minutes);
      const id = await addCase(body.guild_id, t.user, 'timeout', opt(data, 'reason'), t.mod, minutes);
      await dm(t.user.id, `⏳ You've been timed out in ${await serverName(body.guild_id)} for ${minutes} minutes: ${opt(data, 'reason')}`);
      return { content: `Timed out ${nameOf(t.user)} for ${minutes} minutes (case #${id}).` };
    },
  },
  untimeout: {
    description: "End a member's timeout", perms: P(BIT.MODERATE), options: [userOpt()],
    run: async (data, _c, _n, body) => {
      const t = target(data, body); if (t.error) return { content: t.error };
      await timeoutMember(body.guild_id, t.user.id, 0);
      const id = await addCase(body.guild_id, t.user, 'untimeout', '', t.mod);
      return { content: `Ended ${nameOf(t.user)}'s timeout (case #${id}).` };
    },
  },
  kick: {
    description: 'Kick a member (they can rejoin)', perms: P(BIT.KICK), options: [userOpt(), reasonOpt()],
    run: async (data, _c, _n, body) => {
      const t = target(data, body); if (t.error) return { content: t.error };
      await dm(t.user.id, `👢 You've been kicked from ${await serverName(body.guild_id)}: ${opt(data, 'reason')}`);
      await kickMember(body.guild_id, t.user.id);
      const id = await addCase(body.guild_id, t.user, 'kick', opt(data, 'reason'), t.mod);
      return { content: `Kicked ${nameOf(t.user)} (case #${id}).` };
    },
  },
  ban: {
    description: 'Ban a member', perms: P(BIT.BAN),
    options: [userOpt(), reasonOpt(), { type: 4, name: 'delete_days', description: 'Delete their messages from the last … days (0-7)', required: false, min_value: 0, max_value: 7 }],
    run: async (data, _c, _n, body) => {
      const t = target(data, body); if (t.error) return { content: t.error };
      await dm(t.user.id, `🔨 You've been banned from ${await serverName(body.guild_id)}: ${opt(data, 'reason')}`);
      await discordFetch(`/guilds/${body.guild_id}/bans/${t.user.id}`, 'PUT', { delete_message_seconds: (Number(opt(data, 'delete_days')) || 0) * 86400 });
      const id = await addCase(body.guild_id, t.user, 'ban', opt(data, 'reason'), t.mod);
      return { content: `Banned ${nameOf(t.user)} (case #${id}).` };
    },
  },
  unban: {
    description: 'Unban someone by their Discord user ID', perms: P(BIT.BAN),
    options: [{ type: 3, name: 'user_id', description: 'Their Discord user ID', required: true, max_length: 22 }, reasonOpt(false)],
    run: async (data, _c, _n, body) => {
      const id = String(opt(data, 'user_id') || '').trim();
      if (!/^\d{15,22}$/.test(id)) return { content: "That isn't a Discord user ID." };
      await discordFetch(`/guilds/${body.guild_id}/bans/${id}`, 'DELETE');
      const c = await addCase(body.guild_id, { id, username: id }, 'unban', opt(data, 'reason') || '', body.member?.user);
      return { content: `Unbanned ${id} (case #${c}).` };
    },
  },
  purge: {
    description: 'Delete recent messages in this channel', perms: P(BIT.MANAGE_MESSAGES),
    options: [{ type: 4, name: 'count', description: 'How many (1-100)', required: true, min_value: 1, max_value: 100 }, { type: 6, name: 'member', description: 'Only messages from this member', required: false }],
    run: async (data, _c, _n, body) => {
      const count = Number(opt(data, 'count'));
      const only = opt(data, 'member');
      const msgs = await discordFetch(`/channels/${body.channel_id}/messages?limit=100`);
      const fresh = Date.now() - 13.9 * 86400000;
      const ids = msgs.filter((m) => (!only || m.author?.id === only) && Date.parse(m.timestamp) > fresh).slice(0, count).map((m) => m.id);
      ids.forEach((id) => selfDeleted.add(id));
      if (ids.length === 1) await discordFetch(`/channels/${body.channel_id}/messages/${ids[0]}`, 'DELETE');
      else if (ids.length > 1) await discordFetch(`/channels/${body.channel_id}/messages/bulk-delete`, 'POST', { messages: ids });
      await modLog(body.guild_id, { title: '🧹 Purge', description: `${ids.length} message(s) deleted in <#${body.channel_id}> by <@${body.member?.user?.id}>${only ? ` (only from <@${only}>)` : ''}.` });
      return { content: `Deleted ${ids.length} message${ids.length === 1 ? '' : 's'}${ids.length < count ? ' (messages older than 14 days can\'t be bulk deleted)' : ''}.` };
    },
  },
  slowmode: {
    description: 'Set slowmode in this channel (0 = off)', perms: P(BIT.MANAGE_CHANNELS),
    options: [{ type: 4, name: 'seconds', description: 'Seconds between messages (0-21600)', required: true, min_value: 0, max_value: 21600 }],
    run: async (data, _c, _n, body) => {
      const s = Number(opt(data, 'seconds'));
      await discordFetch(`/channels/${body.channel_id}`, 'PATCH', { rate_limit_per_user: s });
      await modLog(body.guild_id, { title: '🐢 Slowmode', description: `<#${body.channel_id}>: ${s ? `${s} seconds` : 'off'} (by <@${body.member?.user?.id}>)` });
      return { content: s ? `Slowmode is ${s} seconds here.` : 'Slowmode is off here.' };
    },
  },
  lock: {
    description: 'Stop members talking in this channel (staff still can)', perms: P(BIT.MANAGE_CHANNELS), options: [reasonOpt(false)],
    run: async (data, _c, _n, body) => lockChannel(body, true, opt(data, 'reason')),
  },
  unlock: {
    description: 'Let members talk in this channel again', perms: P(BIT.MANAGE_CHANNELS), options: [],
    run: async (_d, _c, _n, body) => lockChannel(body, false),
  },
  cases: {
    description: "A member's warnings, timeouts, kicks and bans", perms: P(BIT.MODERATE), options: [{ type: 6, name: 'member', description: 'Which member', required: true }],
    run: async (data, _c, _n, body) => {
      const id = opt(data, 'member');
      const rows = await q('SELECT * FROM discord_cases WHERE guild_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT 15', [body.guild_id, id]);
      if (!rows.length) return { content: `<@${id}> has a clean record.` };
      const line = (r) => `${r.removed ? '~~' : ''}**#${r.id}** ${ACTION_LABEL[r.action] || r.action}${r.minutes ? ` ${r.minutes} min` : ''} · ${r.reason || 'no reason'} · ${r.mod_name} · <t:${Math.floor(Date.parse(r.created_at) / 1000)}:R>${r.removed ? '~~' : ''}`;
      return { content: `**Record for <@${id}>** (newest first)\n${rows.map(line).join('\n')}`.slice(0, 1900) };
    },
  },
  unwarn: {
    description: 'Remove a warning by its case number', perms: P(BIT.MODERATE), options: [{ type: 4, name: 'case', description: 'Case number', required: true, min_value: 1 }],
    run: async (data, _c, _n, body) => {
      const row = await one("UPDATE discord_cases SET removed=true WHERE id=$1 AND guild_id=$2 AND action='warn' RETURNING user_id", [opt(data, 'case'), body.guild_id]);
      if (!row) return { content: "There's no warning with that case number here." };
      await modLog(body.guild_id, { color: COLOR.green, title: `↩️ Warning #${opt(data, 'case')} removed`, description: `For <@${row.user_id}>, by <@${body.member?.user?.id}>` });
      return { content: `Removed warning #${opt(data, 'case')}.` };
    },
  },
};

// Moderator commands can be switched off as a whole (Admin → Discord → Filters & moderation).
for (const c of Object.values(MOD_COMMANDS)) {
  const run = c.run;
  c.run = async (...args) => ((await flagOn('discord_mod_commands')) ? run(...args) : { content: 'Moderator commands are switched off in the WPG app (Admin → Discord).' });
}

// Lock: members (every role overwrite except staff, plus @everyone) can't send; unlock puts the overwrites back.
async function lockChannel(body, lock, reason) {
  const chId = body.channel_id;
  const c = await ctx();
  const saved = JSON.parse((await setting('_discord_locks')) || '{}');
  const staff = new Set([c.role('admin'), c.role('mod')].filter(Boolean));
  if (lock) {
    if (saved[chId]) return { content: 'This channel is already locked.' };
    const ch = await discordFetch(`/channels/${chId}`);
    const before = ch.permission_overwrites || [];
    saved[chId] = before;
    await saveSetting('_discord_locks', JSON.stringify(saved));
    const ows = before.some((o) => o.id === body.guild_id) ? before : [...before, { id: body.guild_id, type: 0, allow: '0', deny: '0' }];
    for (const o of ows) {
      if (o.type !== 0 || staff.has(o.id)) continue;
      await discordFetch(`/channels/${chId}/permissions/${o.id}`, 'PUT', { type: 0, allow: P(BigInt(o.allow) & ~BIT.SEND), deny: P(BigInt(o.deny) | BIT.SEND) });
    }
    await discordFetch(`/channels/${chId}/messages`, 'POST', { content: `🔒 This channel is locked by staff${reason ? `: ${reason}` : '.'}` }).catch(() => {});
    await modLog(body.guild_id, { title: '🔒 Channel locked', description: `<#${chId}> by <@${body.member?.user?.id}>${reason ? `: ${reason}` : ''}` });
    return { content: 'Locked.' };
  }
  const before = saved[chId];
  if (!before) return { content: "This channel isn't locked." };
  const ch = await discordFetch(`/channels/${chId}`);
  const had = new Set(before.map((o) => o.id));
  for (const o of before) await discordFetch(`/channels/${chId}/permissions/${o.id}`, 'PUT', { type: o.type, allow: String(o.allow), deny: String(o.deny) });
  for (const o of ch.permission_overwrites || []) if (!had.has(o.id)) await discordFetch(`/channels/${chId}/permissions/${o.id}`, 'DELETE').catch(() => {});
  delete saved[chId];
  await saveSetting('_discord_locks', JSON.stringify(saved));
  await discordFetch(`/channels/${chId}/messages`, 'POST', { content: '🔓 This channel is open again.' }).catch(() => {});
  await modLog(body.guild_id, { color: COLOR.green, title: '🔓 Channel unlocked', description: `<#${chId}> by <@${body.member?.user?.id}>` });
  return { content: 'Unlocked.' };
}

export function modCommandDefinitions() {
  return Object.entries(MOD_COMMANDS).map(([name, c]) => ({ name, description: c.description, type: 1, dm_permission: false, default_member_permissions: c.perms, options: c.options }));
}

// ---------- Entry check ----------
let raidUntil = 0;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const makeCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
async function quiz() {
  const lines = String((await setting('discord_entry_quiz')) || '').split(/\r?\n/).map((l) => l.split('|')).filter((p) => p.length >= 2 && p[0].trim() && p[1].trim());
  return lines.map(([qq, a]) => ({ q: qq.trim().slice(0, 45), answers: a.split(',').map(norm).filter(Boolean) }));
}
// Who doesn't need to do the check: passed / let in, or joined before it was switched on.
export async function entryFreePass(guild) {
  const since = Date.parse((await loadMap(guild)).entry_since || '');
  if (!since) return () => true;
  const ok = new Set((await q("SELECT discord_id FROM discord_entries WHERE guild_id=$1 AND status IN ('passed','let_in')", [guild])).map((r) => r.discord_id));
  return (m) => ok.has(m.user.id) || Date.parse(m.joined_at) < since;
}
async function letIn(guild, user, status) {
  const c = await ctx();
  if (c.role('wardogs')) await discordFetch(`/guilds/${guild}/members/${user.id}/roles/${c.role('wardogs')}`, 'PUT');
  await q(`INSERT INTO discord_entries (discord_id, guild_id, user_name, status) VALUES ($1,$2,$3,$4)
           ON CONFLICT (discord_id) DO UPDATE SET status=EXCLUDED.status, guild_id=EXCLUDED.guild_id, updated_at=now()`, [user.id, guild, nameOf(user).slice(0, 64), status]);
  scheduleSync(5000);
}
const welcomeIn = (c) => `✅ **You're in. Welcome to WPG!**${c.ch('info:pick-roles') ? `\nPick your platform in <#${c.ch('info:pick-roles')}>.` : ''}${c.ch('app:app-help') ? `\nIn the WPG app? Type **/link** in <#${c.ch('app:app-help')}> to get your clan, unit and game roles.` : ''}`;

async function onEnterButton(body) {
  const c = await ctx();
  const user = body.member?.user;
  if (body.guild_id !== c.guild || !user) return { now: ephemeral('This button only works on the WPG server.') };
  if (c.role('wardogs') && body.member.roles?.includes(c.role('wardogs'))) return { now: ephemeral("You're already in. 👍") };
  if (!(await entryOn())) {
    return { now: { type: 5, data: { flags: EPHEMERAL } }, later: async () => { await letIn(c.guild, user, 'passed'); return { content: welcomeIn(c) }; } };
  }
  if (raidUntil > Date.now()) return { now: ephemeral('A lot of people are joining at once, so entry is paused for a few minutes. Please try again shortly.') };
  const entry = await one('SELECT * FROM discord_entries WHERE discord_id=$1', [user.id]);
  if (entry?.status === 'held') return { now: ephemeral('A staff member will let you in shortly. Thanks for waiting.') };
  const minDays = await num('discord_entry_min_age_days', 7);
  const age = Date.now() - createdAt(user.id);
  if (age < minDays * 86400000) {
    return {
      now: { type: 5, data: { flags: EPHEMERAL } },
      later: async () => {
        await q(`INSERT INTO discord_entries (discord_id, guild_id, user_name, status) VALUES ($1,$2,$3,'held')
                 ON CONFLICT (discord_id) DO UPDATE SET status='held', updated_at=now()`, [user.id, c.guild, nameOf(user).slice(0, 64)]);
        if (c.ch('staff:staff-chat')) {
          await discordFetch(`/channels/${c.ch('staff:staff-chat')}/messages`, 'POST', {
            embeds: [{ color: COLOR.amber, title: '🕵️ New account waiting to be let in', description: `<@${user.id}> (${nameOf(user)}) read the rules, but their Discord account is only ${ago(age)} old (the minimum is ${minDays} days).`, timestamp: new Date().toISOString() }],
            components: [{ type: 1, components: [
              { type: 2, style: 3, label: 'Let in', custom_id: `wpg:letin:${user.id}` },
              { type: 2, style: 4, label: 'Kick', custom_id: `wpg:kickheld:${user.id}` },
            ] }],
            allowed_mentions: { parse: [] },
          });
        }
        return { content: 'Thanks! Your Discord account is quite new, so a staff member will let you in shortly.' };
      },
    };
  }
  const list = await quiz();
  const qi = list.length ? Math.floor(Math.random() * list.length) : -1;
  const code = makeCode();
  const rows = [{ type: 1, components: [{ type: 4, custom_id: 'code', label: `Type this code: ${code}`, style: 1, min_length: 5, max_length: 5, required: true }] }];
  if (qi >= 0) rows.push({ type: 1, components: [{ type: 4, custom_id: 'answer', label: list[qi].q, style: 1, max_length: 40, required: true }] });
  return { now: { type: 9, data: { custom_id: `wpg:entry:${code}:${qi}`, title: 'Entry check', components: rows } } };
}

async function onEntrySubmit(body) {
  const c = await ctx();
  const user = body.member?.user;
  const [, , code, qiRaw] = String(body.data.custom_id).split(':');
  const values = Object.fromEntries((body.data.components || []).flatMap((r) => r.components || []).map((x) => [x.custom_id, x.value]));
  const list = await quiz();
  const qi = Number(qiRaw);
  const codeOk = String(values.code || '').trim().toUpperCase() === code;
  const answerOk = qi < 0 || !list[qi] || list[qi].answers.includes(norm(values.answer));
  return {
    now: { type: 5, data: { flags: EPHEMERAL } },
    later: async () => {
      if (codeOk && answerOk) {
        await letIn(c.guild, user, 'passed');
        await modLog(c.guild, { color: COLOR.green, title: '✅ Passed the entry check', description: `<@${user.id}> (${nameOf(user)})` });
        return { content: welcomeIn(c) };
      }
      const row = await one(`INSERT INTO discord_entries (discord_id, guild_id, user_name, status, attempts) VALUES ($1,$2,$3,'started',1)
                             ON CONFLICT (discord_id) DO UPDATE SET attempts=discord_entries.attempts+1, updated_at=now() RETURNING attempts`, [user.id, c.guild, nameOf(user).slice(0, 64)]);
      if (row.attempts >= 3) {
        await dm(user.id, `You didn't pass the entry check on ${await serverName(c.guild)} after 3 tries, so you've been removed. You're welcome to rejoin and try again.`);
        await kickMember(c.guild, user.id).catch(() => {});
        await q("UPDATE discord_entries SET status='kicked', attempts=0 WHERE discord_id=$1", [user.id]);
        await addCase(c.guild, user, 'entry-kick', 'Failed the entry check 3 times', null);
        return { content: "That wasn't right 3 times, so you've been removed. You can rejoin and try again." };
      }
      return { content: `That wasn't quite right${codeOk ? ' (check your answer to the question)' : ' (check the code)'}. Press the button under the rules to try again: ${3 - row.attempts} ${3 - row.attempts === 1 ? 'try' : 'tries'} left.` };
    },
  };
}

async function onHeldDecision(body, letInIt) {
  const c = await ctx();
  if (!isStaffPerms(body.member?.permissions)) return { now: ephemeral('Staff only.') };
  const id = String(body.data.custom_id).split(':')[2];
  const staffer = body.member.user;
  return {
    now: { type: 6 },
    later: async () => {
      const entry = await one('SELECT * FROM discord_entries WHERE discord_id=$1', [id]);
      const user = { id, username: entry?.user_name || id };
      let outcome;
      if (letInIt) {
        await letIn(c.guild, user, 'let_in');
        await dm(id, `✅ You've been let in to ${await serverName(c.guild)}. Welcome!`);
        outcome = `✅ Let in by <@${staffer.id}>`;
      } else {
        await dm(id, `Sorry, you weren't let in to ${await serverName(c.guild)}.`);
        await kickMember(c.guild, id).catch(() => {});
        await q("UPDATE discord_entries SET status='kicked' WHERE discord_id=$1", [id]);
        await addCase(c.guild, user, 'entry-kick', 'New account, not let in', staffer);
        outcome = `👢 Kicked by <@${staffer.id}>`;
      }
      const embed = body.message?.embeds?.[0] || {};
      return { embeds: [{ ...embed, description: `${embed.description || ''}\n\n**${outcome}**` }], components: [] };
    },
  };
}

// Admin → Discord server: let in or kick a held account from the app.
export async function decideHeld(id, letInIt, staffName) {
  const c = await ctx();
  const entry = await one("SELECT * FROM discord_entries WHERE discord_id=$1 AND status='held'", [id]);
  if (!entry) throw new Error('That account is no longer waiting.');
  const user = { id, username: entry.user_name };
  if (letInIt) {
    await letIn(c.guild, user, 'let_in');
    await dm(id, `✅ You've been let in to ${await serverName(c.guild)}. Welcome!`);
  } else {
    await dm(id, `Sorry, you weren't let in to ${await serverName(c.guild)}.`);
    await kickMember(c.guild, id).catch(() => {});
    await q("UPDATE discord_entries SET status='kicked' WHERE discord_id=$1", [id]);
    await addCase(c.guild, user, 'entry-kick', `New account, not let in (by ${staffName} in the app)`, null);
  }
}

// ---------- Buttons: roles, tickets ----------
const PICKS = ['PC', 'Xbox', 'PlayStation', 'Switch'];
async function onRoleButton(body) {
  const c = await ctx();
  const pick = String(body.data.custom_id).slice('wpg:role:'.length);
  const user = body.member?.user;
  if (body.guild_id !== c.guild || !user) return { now: ephemeral('This button only works on the WPG server.') };
  if (!(await flagOn('discord_role_buttons'))) return { now: ephemeral('Role buttons are switched off right now.') };
  if (pick === '18+' && !body.member.roles.includes(c.role('manual:18+'))) {
    return { now: ephemeral('The 18+ role opens the 18+ chat. **Only take it if you are 18 or older.**', {
      components: [{ type: 1, components: [{ type: 2, style: 4, label: "I'm 18 or older", custom_id: 'wpg:role18:yes' }] }],
    }) };
  }
  const key = pick === 'yes18' ? 'manual:18+' : `manual:${pick}`;
  const role = c.role(key);
  if (!role) return { now: ephemeral("That role isn't set up yet: ask staff to run Build server.") };
  const has = body.member.roles.includes(role);
  return {
    now: { type: 5, data: { flags: EPHEMERAL } },
    later: async () => {
      await discordFetch(`/guilds/${c.guild}/members/${user.id}/roles/${role}`, has && pick !== 'yes18' ? 'DELETE' : 'PUT');
      const label = key.slice('manual:'.length);
      return { content: has && pick !== 'yes18' ? `Removed **${label}**.` : `Added **${label}**.` };
    },
  };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'member';
async function onTicket(body) {
  const c = await ctx();
  const user = body.member?.user;
  if (body.guild_id !== c.guild || !user) return { now: ephemeral('This button only works on the WPG server.') };
  if (!(await flagOn('discord_tickets'))) return { now: ephemeral('Tickets are switched off right now: message a staff member instead.') };
  return {
    now: { type: 5, data: { flags: EPHEMERAL } },
    later: async () => {
      const open = await one("SELECT * FROM discord_tickets WHERE guild_id=$1 AND user_id=$2 AND status='open' ORDER BY id DESC LIMIT 1", [c.guild, user.id]);
      if (open) {
        const still = await discordFetch(`/channels/${open.channel_id}`).catch(() => null);
        if (still) return { content: `You already have a ticket open: <#${open.channel_id}>` };
        await q("UPDATE discord_tickets SET status='closed', closed_at=now() WHERE id=$1", [open.id]);
      }
      const ow = [
        { id: c.guild, type: 0, allow: '0', deny: P(BIT.VIEW) },
        { id: user.id, type: 1, allow: P(BIT.VIEW | BIT.SEND | BIT.HISTORY | BIT.ATTACH | BIT.EMBED), deny: '0' },
        ...(c.role('mod') ? [{ id: c.role('mod'), type: 0, allow: P(BIT.VIEW | BIT.SEND | BIT.HISTORY | BIT.ATTACH | BIT.EMBED), deny: '0' }] : []),
      ];
      const ch = await discordFetch(`/guilds/${c.guild}/channels`, 'POST', { name: `ticket-${slug(nameOf(user))}`, type: 0, parent_id: c.ch('cat:tickets') || undefined, permission_overwrites: ow, topic: `Ticket for ${nameOf(user)}` });
      await q('INSERT INTO discord_tickets (guild_id, channel_id, user_id, user_name) VALUES ($1,$2,$3,$4)', [c.guild, ch.id, user.id, nameOf(user).slice(0, 64)]);
      await discordFetch(`/channels/${ch.id}/messages`, 'POST', {
        content: `<@${user.id}> thanks for getting in touch. Tell us what you need and ${c.role('mod') ? `<@&${c.role('mod')}>` : 'staff'} will be with you soon.`,
        components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Close ticket', custom_id: 'wpg:ticketclose' }] }],
        allowed_mentions: { users: [user.id], roles: c.role('mod') ? [c.role('mod')] : [] },
      });
      await modLog(c.guild, { title: '🎫 Ticket opened', description: `<@${user.id}> opened <#${ch.id}>` });
      return { content: `Your ticket is open: <#${ch.id}>` };
    },
  };
}
async function onTicketClose(body) {
  const c = await ctx();
  const t = await one("SELECT * FROM discord_tickets WHERE channel_id=$1 AND status='open'", [body.channel_id]);
  const who = body.member?.user;
  if (!t) return { now: ephemeral('This ticket is already closed.') };
  if (who.id !== t.user_id && !isStaffPerms(body.member?.permissions)) return { now: ephemeral('Only staff or the person who opened it can close this ticket.') };
  return {
    now: { type: 6 },
    later: async () => {
      const msgs = (await discordFetch(`/channels/${t.channel_id}/messages?limit=100`).catch(() => [])).reverse();
      const text = msgs.map((m) => `[${m.timestamp?.slice(0, 16).replace('T', ' ')}] ${nameOf(m.author)}: ${m.content || ''}${m.attachments?.length ? ` (${m.attachments.map((a) => a.url).join(' ')})` : ''}`).join('\n');
      if (c.ch('staff:mod-log')) {
        await sendToChannel(c.ch('staff:mod-log'), {
          embeds: [{ color: COLOR.grey, title: '🎫 Ticket closed', description: `Opened by <@${t.user_id}>, closed by <@${who.id}>. Transcript attached (${msgs.length} messages).`, timestamp: new Date().toISOString() }],
          files: [{ name: `ticket-${t.id}.txt`, data: Buffer.from(text || '(empty)'), type: 'text/plain' }],
        }).catch((e) => console.warn('[discord mod] transcript', e.message));
      }
      await q("UPDATE discord_tickets SET status='closed', closed_by=$2, closed_at=now() WHERE id=$1", [t.id, who.id]);
      await discordFetch(`/channels/${t.channel_id}`, 'DELETE').catch(() => {});
      return null;
    },
  };
}

// Buttons and pop-up forms from Discord (called by the bot's interactions route). Returns the answer to send
// straight away (`now`) and, optionally, work to do afterwards whose result replaces the "thinking…" message.
export async function handleComponent(body) {
  const id = String(body.data?.custom_id || '');
  if (body.type === 5 && id.startsWith('wpg:entry:')) return onEntrySubmit(body);
  if (id === 'wpg:enter') return onEnterButton(body);
  if (id.startsWith('wpg:letin:')) return onHeldDecision(body, true);
  if (id.startsWith('wpg:kickheld:')) return onHeldDecision(body, false);
  if (id === 'wpg:role18:yes') return onRoleButton({ ...body, data: { ...body.data, custom_id: 'wpg:role:yes18' } });
  if (id.startsWith('wpg:role:')) return onRoleButton(body);
  if (id === 'wpg:ticket') return onTicket(body);
  if (id === 'wpg:ticketclose') return onTicketClose(body);
  return { now: ephemeral('That button is no longer in use.') };
}

// ---------- Set up during Build server: rules post, panels, AutoMod, verification level ----------
async function rulesPayload() {
  const rules = String((await setting('discord_rules')) || '').slice(0, 3900);
  return {
    embeds: [{ color: COLOR.blue, title: '📜 WPG server rules', description: rules, footer: { text: 'Press the button below once you have read them.' } }],
    components: [{ type: 1, components: [{ type: 2, style: 3, label: "I've read the rules, let me in", emoji: { name: '✅' }, custom_id: 'wpg:enter' }] }],
  };
}
const ROLES_PANEL = {
  embeds: [{ color: COLOR.blue, title: '🎮 Pick your roles', description: 'Tap a platform to add it, tap again to remove it.\n**18+** opens the 18+ chat: only take it if you are 18 or older.\n\nGame roles come automatically from your Steam library once you /link the WPG app.' }],
  components: [{ type: 1, components: [...PICKS.map((p) => ({ type: 2, style: 2, label: p, custom_id: `wpg:role:${p}` })), { type: 2, style: 4, label: '18+', custom_id: 'wpg:role:18+' }] }],
};
const TICKET_PANEL = {
  embeds: [{ color: COLOR.blue, title: '🎫 Contact staff', description: 'Need help, want to report someone or disagree with a decision? Press the button for a private channel with WPG staff.' }],
  components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Contact staff', emoji: { name: '🎫' }, custom_id: 'wpg:ticket' }] }],
};

// Posts (or updates) one of the bot's own messages, remembering it in the server map.
async function upsertPost(map, key, channel, payload, apply, say, label) {
  map.messages ||= {};
  if (!channel) return;
  const have = map.messages[key];
  if (!apply) { if (!have) say(`Post ${label}`); return; }
  if (have) {
    const ok = await discordFetch(`/channels/${channel}/messages/${have}`, 'PATCH', payload).then(() => true).catch(() => false);
    if (ok) return;
  }
  say(`Post ${label}`);
  const m = await discordFetch(`/channels/${channel}/messages`, 'POST', { ...payload, allowed_mentions: { parse: [] } });
  map.messages[key] = m.id;
}

const SCAM_WORDS = ['discord.gg/*', '*discord.gg/*', '*discord.com/invite/*', '*discordapp.com/invite/*', '*free nitro*', '*nitro for free*', '*discord-nitro*', '*discordgift*', '*discord-gift*', '*dlscord*', '*disc0rd*', '*steamcommunlty*', '*steamcomminuty*', '*steamcommnunity*', '*stearncommunity*', '*steamcommunytu*', '*steam-community.*', '*csgo-skins*', '*free skins*'];

async function setupAutoMod({ guild, map, roleIds, apply, say }) {
  const log = map.channels?.['staff:mod-log'];
  const exempt = [roleIds.admin, roleIds.mod].filter((id) => id && !String(id).startsWith('new:'));
  let existing;
  try { existing = await discordFetch(`/guilds/${guild}/auto-moderation/rules`); } catch (e) { say(`Couldn't read AutoMod: ${e.message}`); return; }
  const words = String((await setting('discord_blocked_words')) || '').split(/[\n,]/).map((w) => w.trim()).filter(Boolean).slice(0, 900).map((w) => (w.includes('*') ? w : `*${w}*`).slice(0, 60));
  const actions = (msg) => [{ type: 1, metadata: { custom_message: msg } }, ...(log ? [{ type: 2, metadata: { channel_id: log } }] : [])];
  const RULES = [
    { key: 'discord_automod_slurs', name: 'WPG: slurs and sexual content', trigger_type: 4, trigger_metadata: { presets: [2, 3] }, actions: actions('That language isn\'t allowed on the WPG server.') },
    { key: 'discord_automod_spam', name: 'WPG: spam', trigger_type: 3, actions: actions('That looks like spam.') },
    { key: 'discord_automod_mentions', name: 'WPG: mass mentions', trigger_type: 5, trigger_metadata: { mention_total_limit: 6, mention_raid_protection_enabled: true }, actions: actions('Too many mentions in one message.') },
    { key: 'discord_automod_links', name: 'WPG: invites and scam links', trigger_type: 1, trigger_metadata: { keyword_filter: SCAM_WORDS }, actions: actions('Invite links and scam links aren\'t allowed. Ask staff if you want to share something.') },
    ...(words.length ? [{ key: 'discord_automod_words', name: 'WPG: blocked words', trigger_type: 1, trigger_metadata: { keyword_filter: words }, actions: actions('That word isn\'t allowed on the WPG server.') }] : []),
  ];
  for (const { key, ...r } of RULES) {
    const have = existing.find((x) => x.name === r.name);
    const body = { ...r, event_type: 1, enabled: true, exempt_roles: exempt };
    // Switched off in the app: turn our rule off on Discord (kept, so switching back on is instant).
    if (!(await flagOn(key))) {
      if (have?.enabled) { say(`Turn off AutoMod: ${r.name.slice(5)}`); if (apply) await discordFetch(`/guilds/${guild}/auto-moderation/rules/${have.id}`, 'PATCH', { enabled: false }).catch(() => {}); }
      continue;
    }
    if (!have) {
      // Discord allows only one spam / preset / mention rule per server: skip ours if another bot already has one.
      const clash = [3, 4, 5].includes(r.trigger_type) && existing.find((x) => x.trigger_type === r.trigger_type);
      if (clash) { say(`AutoMod: kept the server's existing "${clash.name}" rule (only one of that kind is allowed)`); continue; }
      say(`Set up AutoMod: ${r.name.slice(5)}`);
      if (apply) await discordFetch(`/guilds/${guild}/auto-moderation/rules`, 'POST', body).catch((e) => say(`Couldn't set up AutoMod "${r.name}": ${e.message}`));
    } else if (!have.enabled) {
      say(`Turn on AutoMod: ${r.name.slice(5)}`);
      if (apply) await discordFetch(`/guilds/${guild}/auto-moderation/rules/${have.id}`, 'PATCH', { trigger_metadata: r.trigger_metadata, actions: body.actions, exempt_roles: exempt, enabled: true }).catch(() => {});
    } else if (apply) {
      await discordFetch(`/guilds/${guild}/auto-moderation/rules/${have.id}`, 'PATCH', { trigger_metadata: r.trigger_metadata, actions: body.actions, exempt_roles: exempt, enabled: true }).catch(() => {});
    }
  }
  if (!words.length) {
    const old = existing.find((x) => x.name === 'WPG: blocked words');
    if (old) { say('Remove the empty blocked-words AutoMod rule'); if (apply) await discordFetch(`/guilds/${guild}/auto-moderation/rules/${old.id}`, 'DELETE').catch(() => {}); }
  }
}

export async function setupModeration({ guild, info, map, roleIds, apply, say }) {
  await upsertPost(map, 'rules', map.channels?.['start:rules'], await rulesPayload(), apply, say, 'the rules with the entry button in #rules');
  await upsertPost(map, 'roles', map.channels?.['info:pick-roles'], ROLES_PANEL, apply, say, 'the role buttons in #pick-roles');
  await upsertPost(map, 'ticket', map.channels?.['info:contact-staff'], TICKET_PANEL, apply, say, 'the Contact staff button in #contact-staff');
  await setupAutoMod({ guild, map, roleIds, apply, say });
  if ((await flagOn('discord_raise_verification')) && ((info.verification_level ?? 0) < 2 || (info.explicit_content_filter ?? 0) < 2)) {
    say("Raise Discord's own checks: verified email, account older than 5 minutes, scan media from everyone");
    if (apply) await discordFetch(`/guilds/${guild}`, 'PATCH', { verification_level: Math.max(2, info.verification_level || 0), explicit_content_filter: 2 }).catch((e) => say(`Couldn't change the verification level: ${e.message}`));
  }
  // When the entry check started on THIS server: only people who join after it have to do it.
  if (apply && (await entryOn()) && !map.entry_since) map.entry_since = new Date().toISOString();
}

// Admin → Discord server: post the rules and panels again (after editing the rules) and refresh AutoMod.
export async function refreshPosts() {
  const guild = await guildId();
  if (!/^\d{15,22}$/.test(guild)) throw new Error('Set the Discord server ID first.');
  const map = await loadMap(guild);
  if (!map.channels?.['start:rules']) throw new Error('Build the server first.');
  const info = await discordFetch(`/guilds/${guild}`);
  const log = [];
  await setupModeration({ guild, info, map, roleIds: map.roles, apply: true, say: (t) => log.push(t) });
  await saveMap(map);
  return log;
}

// ---------- Live events: mod log, welcome, spam filter, raid alarm ----------
const cache = new Map(); // message id → { author, content, channel }
const memberCache = new Map(); // user id → { nick, roles, until }
const selfDeleted = new Set();
const recentMsgs = new Map(); // user id → [{ id, channel, norm, at }]
let joins = [];

function remember(id, v) {
  cache.set(id, v);
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
}
const managedRoleIds = (map) => new Set([...Object.entries(map.roles || {}).filter(([k]) => !k.startsWith('manual:')).map(([, v]) => v), ...Object.values(map.games || {})]);
async function notice(channel, content) {
  const m = await discordFetch(`/channels/${channel}/messages`, 'POST', { content, allowed_mentions: { parse: ['users'] } }).catch(() => null);
  if (m) setTimeout(() => { selfDeleted.add(m.id); discordFetch(`/channels/${channel}/messages/${m.id}`, 'DELETE').catch(() => {}); }, 8000);
}

async function spamCheck(d, c) {
  const [repeats, flood, caps] = await Promise.all(['discord_filter_repeats', 'discord_filter_flood', 'discord_filter_caps'].map(flagOn));
  if (!repeats && !flood && !caps) return;
  const roles = d.member?.roles || [];
  if (roles.includes(c.role('admin')) || roles.includes(c.role('mod'))) return;
  const uid = d.author.id;
  const now = Date.now();
  const content = String(d.content || '');
  const list = (recentMsgs.get(uid) || []).filter((x) => x.at > now - 30000);
  const n = norm(content) || content.trim().toLowerCase();
  list.push({ id: d.id, channel: d.channel_id, norm: n, at: now });
  recentMsgs.set(uid, list);
  const dups = n ? list.filter((x) => x.norm === n) : [];
  if (repeats && dups.length >= 3) {
    for (const x of dups) { selfDeleted.add(x.id); await discordFetch(`/channels/${x.channel}/messages/${x.id}`, 'DELETE').catch(() => {}); }
    recentMsgs.set(uid, []);
    await notice(d.channel_id, `<@${uid}> please don't repeat the same message.`);
    await addCase(c.guild, d.author, 'spam', 'Same message 3 times in 30 seconds', null);
    return;
  }
  if (flood && list.filter((x) => x.at > now - 8000).length >= 6) {
    recentMsgs.set(uid, []);
    await timeoutMember(c.guild, uid, 2).catch(() => {});
    await notice(d.channel_id, `<@${uid}> slow down: you've been muted for 2 minutes.`);
    await addCase(c.guild, d.author, 'auto-timeout', 'Message flood (6 messages in 8 seconds)', null, 2);
    return;
  }
  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (caps && letters.length >= 15 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8) {
    selfDeleted.add(d.id);
    await discordFetch(`/channels/${d.channel_id}/messages/${d.id}`, 'DELETE').catch(() => {});
    await notice(d.channel_id, `<@${uid}> easy on the caps lock, please.`);
  }
}

async function onEvent({ t, d }) {
  if (!d) return;
  const c = await ctx();
  if (!c.guild) return;
  if (t === 'GUILD_CREATE' && d.id === c.guild) {
    for (const m of d.members || []) memberCache.set(m.user.id, { nick: m.nick, roles: m.roles, until: m.communication_disabled_until });
    return;
  }
  if (d.guild_id !== c.guild) return;
  const logCh = c.ch('staff:mod-log');
  switch (t) {
    case 'MESSAGE_CREATE': {
      if (d.author?.bot || d.webhook_id) return;
      remember(d.id, { author: d.author, content: d.content, channel: d.channel_id, attachments: (d.attachments || []).map((a) => a.url) });
      await spamCheck(d, c);
      return;
    }
    case 'MESSAGE_UPDATE': {
      const old = cache.get(d.id);
      if (!old || d.content === undefined || d.content === old.content) return;
      remember(d.id, { ...old, content: d.content });
      if (d.channel_id === logCh || !(await flagOn('discord_log_messages'))) return;
      await modLog(c.guild, { color: COLOR.amber, title: '✏️ Message edited', description: `<@${old.author.id}> in <#${d.channel_id}> · [jump](https://discord.com/channels/${c.guild}/${d.channel_id}/${d.id})`, fields: [{ name: 'Before', value: (old.content || '(empty)').slice(0, 1000) }, { name: 'After', value: (d.content || '(empty)').slice(0, 1000) }] });
      return;
    }
    case 'MESSAGE_DELETE': {
      const old = cache.get(d.id);
      cache.delete(d.id);
      if (selfDeleted.delete(d.id) || !old || d.channel_id === logCh || !(await flagOn('discord_log_messages'))) return;
      await modLog(c.guild, { color: COLOR.red, title: '🗑️ Message deleted', description: `<@${old.author.id}> in <#${d.channel_id}>`, fields: [{ name: 'Message', value: (old.content || '(no text)').slice(0, 1000) }, ...(old.attachments?.length ? [{ name: 'Attachments', value: old.attachments.join('\n').slice(0, 1000) }] : [])] });
      return;
    }
    case 'MESSAGE_DELETE_BULK': {
      const mine = (d.ids || []).filter((id) => selfDeleted.delete(id)).length;
      if (d.ids.length - mine > 0 && (await flagOn('discord_log_messages'))) await modLog(c.guild, { color: COLOR.red, title: '🗑️ Messages bulk deleted', description: `${d.ids.length - mine} message(s) in <#${d.channel_id}>` });
      return;
    }
    case 'GUILD_MEMBER_ADD': {
      memberCache.set(d.user.id, { nick: d.nick, roles: d.roles || [], until: null });
      if (d.user.bot) return;
      const age = Date.now() - createdAt(d.user.id);
      if (await flagOn('discord_log_joins')) await modLog(c.guild, { color: COLOR.green, title: '📥 Joined', description: `<@${d.user.id}> (${nameOf(d.user)}) · account ${ago(age)} old${age < 7 * 86400000 ? ' ⚠️ new account' : ''}` });
      if (c.ch('start:welcome') && (await flagOn('discord_welcome_posts'))) {
        await discordFetch(`/channels/${c.ch('start:welcome')}/messages`, 'POST', {
          content: `👋 Welcome <@${d.user.id}>! Read the rules in ${c.ch('start:rules') ? `<#${c.ch('start:rules')}>` : '#rules'} and press the button under them to get in.`,
          allowed_mentions: { users: [d.user.id] },
        }).catch(() => {});
      }
      // Raid alarm: 10 joins in a minute pauses entry for 15 minutes.
      const now = Date.now();
      joins = joins.filter((x) => x > now - 60000);
      joins.push(now);
      if (joins.length >= 10 && raidUntil < now && (await flagOn('discord_raid_alarm'))) {
        raidUntil = now + 15 * 60000;
        if (c.ch('staff:staff-chat')) {
          await discordFetch(`/channels/${c.ch('staff:staff-chat')}/messages`, 'POST', {
            content: `🚨 ${c.role('mod') ? `<@&${c.role('mod')}> ` : ''}**Raid alarm:** ${joins.length} accounts joined in the last minute. Entry is paused for 15 minutes; check #mod-log.`,
            allowed_mentions: { roles: c.role('mod') ? [c.role('mod')] : [] },
          }).catch(() => {});
        }
      }
      return;
    }
    case 'GUILD_MEMBER_REMOVE': {
      memberCache.delete(d.user.id);
      if (!d.user.bot && (await flagOn('discord_log_joins'))) await modLog(c.guild, { color: COLOR.grey, title: '📤 Left', description: `<@${d.user.id}> (${nameOf(d.user)})` });
      return;
    }
    case 'GUILD_MEMBER_UPDATE': {
      const old = memberCache.get(d.user.id);
      memberCache.set(d.user.id, { nick: d.nick, roles: d.roles, until: d.communication_disabled_until });
      if (!old) return;
      const lines = [];
      if ((old.nick || null) !== (d.nick || null)) lines.push(`Nickname: **${old.nick || nameOf(d.user)}** → **${d.nick || nameOf(d.user)}**`);
      const managed = managedRoleIds(c.map);
      const added = d.roles.filter((r) => !old.roles.includes(r) && !managed.has(r));
      const removed = old.roles.filter((r) => !d.roles.includes(r) && !managed.has(r));
      if (added.length) lines.push(`Roles added: ${added.map((r) => `<@&${r}>`).join(' ')}`);
      if (removed.length) lines.push(`Roles removed: ${removed.map((r) => `<@&${r}>`).join(' ')}`);
      if (lines.length && (await flagOn('discord_log_members'))) await modLog(c.guild, { color: COLOR.blue, title: '👤 Member updated', description: `<@${d.user.id}>\n${lines.join('\n')}` });
      return;
    }
    case 'GUILD_BAN_ADD':
      if (await flagOn('discord_log_bans')) await modLog(c.guild, { color: COLOR.red, title: '🔨 Banned', description: `<@${d.user.id}> (${nameOf(d.user)})` });
      return;
    case 'GUILD_BAN_REMOVE':
      if (await flagOn('discord_log_bans')) await modLog(c.guild, { color: COLOR.green, title: '♻️ Unbanned', description: `<@${d.user.id}> (${nameOf(d.user)})` });
      return;
    default:
  }
}

// Anyone who hasn't got in after discord_entry_kick_hours (and has no roles at all) is removed. Members who
// were already on the server before the entry check was switched on are never touched.
export async function kickStragglers() {
  if (!(await entryOn())) return 0;
  const c = await ctx();
  if (!c.guild) return 0;
  const since = Date.parse(c.map.entry_since || '');
  if (!since) return 0;
  const hours = await num('discord_entry_kick_hours', 24);
  const grace = Date.parse(c.map.entry_grace || '') || 0; // set when another bot's verification was cleared away
  const held = new Set((await q("SELECT discord_id FROM discord_entries WHERE status='held'")).map((r) => r.discord_id));
  let members;
  try { members = await allMembers(c.guild); } catch { return 0; }
  let n = 0;
  for (const m of members) {
    if (m.user.bot || m.roles.length || held.has(m.user.id)) continue;
    const joined = Date.parse(m.joined_at);
    if (!(joined > since) || Math.max(joined, grace) > Date.now() - hours * 3600000) continue;
    await dm(m.user.id, `You didn't finish getting in to ${await serverName(c.guild)} (read the rules and press the button), so you've been removed. You're welcome to rejoin any time.`);
    await kickMember(c.guild, m.user.id).catch(() => {});
    await q(`INSERT INTO discord_entries (discord_id, guild_id, user_name, status) VALUES ($1,$2,$3,'kicked')
             ON CONFLICT (discord_id) DO UPDATE SET status='kicked', updated_at=now()`, [m.user.id, c.guild, nameOf(m.user).slice(0, 64)]);
    await addCase(c.guild, m.user, 'entry-kick', `Didn't get in within ${hours} hours`, null);
    n++;
  }
  return n;
}

export function startDiscordMod() {
  bus.on('discord:event', (ev) => onEvent(ev).catch((e) => console.warn('[discord mod]', ev.t, e.message)));
  setInterval(() => kickStragglers().catch((e) => console.warn('[discord mod] stragglers', e.message)), 10 * 60 * 1000);
}
