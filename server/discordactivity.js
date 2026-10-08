// Discord activity for achievements: chat messages, voice time, Nitro boosts and recruits (invites), per Discord
// account in discord_activity / discord_boosts / discord_recruits. Members get the credit once their Discord is
// linked to the app with /link. Everything is counted from when this tracking started (Discord keeps no history
// of voice time, boosts or invites to go back over).
//  - Messages: real members only (no bots, webhooks or system messages), not commands, at least 10 letters or 3
//    words, not the same as their last counted message, at least 20 seconds after it, and only counted a minute
//    later if it wasn't deleted (by them or by the spam filter).
//  - Voice: a minute counts for each member in a voice channel with at least one other eligible person, not
//    deafened, not in the AFK channel, and not sitting muted without any change for over 2 hours.
//  - Boosts: the start of their current boost comes from Discord (premium_since), checked live and every hour.
//    Each "X just boosted the server" message counts as one boost, once.
//  - Recruits: the invite link a new member used is worked out by comparing invite use counts. It counts for the
//    inviter after 14 days if the member is still here, isn't a bot or the inviter, passed the entry check and
//    their account was at least 7 days old when they joined. A member is only ever recorded once.
import { q, one } from './db.js';
import { bus } from './bus.js';
import { discordFetch, botReady } from './discordbot.js';
import { guildId, allMembers, loadMap } from './discordserver.js';

const MIN_GAP_MS = 20 * 1000;
const COUNT_AFTER_MS = 60 * 1000;
const IDLE_MUTED_MS = 2 * 3600e3;
const RECRUIT_DAYS = 14;
const MIN_ACCOUNT_DAYS = 7;
const BOOST_TYPES = new Set([8, 9, 10, 11]); // Discord's "boosted the server" system messages (and tier-ups)
const COMMAND = /^[!/?.$%&\-+>~;]\S/;
const created = (id) => Number(BigInt(id) >> 22n) + 1420070400000;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// ---------- Messages ----------
const pending = new Map(); // message id → { uid, text, at }
const lastCounted = new Map(); // uid → { text, at } (also kept in the database)
export function validMessage(d) {
  if (!d?.author || d.author.bot || d.webhook_id || d.author.system) return false;
  if (d.type !== 0 && d.type !== 19) return false; // normal messages and replies only
  const text = String(d.content || '').trim();
  if (!text || COMMAND.test(text)) return false;
  const words = text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  return text.replace(/[^a-z0-9]/gi, '').length >= 10 || words.length >= 3;
}
async function flushMessages() {
  const now = Date.now();
  for (const [id, m] of pending) {
    if (now - m.at < COUNT_AFTER_MS) continue;
    pending.delete(id);
    const last = lastCounted.get(m.uid) || await one('SELECT last_msg AS text, last_msg_at AS at FROM discord_activity WHERE discord_id=$1', [m.uid]).then((r) => (r ? { text: r.text, at: r.at ? new Date(r.at).getTime() : 0 } : null));
    if (last && (last.text === m.text || m.at - last.at < MIN_GAP_MS)) continue;
    lastCounted.set(m.uid, { text: m.text, at: m.at });
    await q(`INSERT INTO discord_activity (discord_id, messages, last_msg, last_msg_at) VALUES ($1,1,$2,$3)
             ON CONFLICT (discord_id) DO UPDATE SET messages=discord_activity.messages+1, last_msg=EXCLUDED.last_msg, last_msg_at=EXCLUDED.last_msg_at, updated_at=now()`,
    [m.uid, m.text.slice(0, 200), new Date(m.at)]);
    changed.add(m.uid);
  }
  if (lastCounted.size > 5000) lastCounted.clear();
}

// ---------- Voice ----------
const voice = new Map(); // uid → { channel, deaf, mute, bot, since }
let afkChannel = null;
function setVoice(v) {
  const uid = v.user_id;
  if (!v.channel_id) { voice.delete(uid); return; }
  const deaf = !!(v.deaf || v.self_deaf);
  const mute = !!(v.mute || v.self_mute);
  const old = voice.get(uid);
  const same = old && old.channel === v.channel_id && old.deaf === deaf && old.mute === mute;
  voice.set(uid, { channel: v.channel_id, deaf, mute, bot: !!v.member?.user?.bot, since: same ? old.since : Date.now() });
}
export function eligibleVoice(states, afk, now = Date.now()) {
  const byChannel = new Map();
  for (const [uid, s] of states) {
    if (s.bot || s.deaf || s.channel === afk) continue;
    if (s.mute && now - s.since > IDLE_MUTED_MS) continue;
    if (!byChannel.has(s.channel)) byChannel.set(s.channel, []);
    byChannel.get(s.channel).push(uid);
  }
  return [...byChannel.values()].filter((list) => list.length >= 2).flat();
}
async function voiceTick() {
  const ids = eligibleVoice(voice, afkChannel);
  if (!ids.length) return;
  await q(`INSERT INTO discord_activity (discord_id, voice_minutes) SELECT x, 1 FROM unnest($1::text[]) AS x
           ON CONFLICT (discord_id) DO UPDATE SET voice_minutes=discord_activity.voice_minutes+1, updated_at=now()`, [ids]);
  for (const id of ids) changed.add(id);
}

// ---------- Boosts ----------
async function setBoost(uid, since) {
  const at = since ? new Date(since) : null;
  const r = await one('SELECT boost_since FROM discord_activity WHERE discord_id=$1', [uid]);
  const same = (r?.boost_since ? new Date(r.boost_since).getTime() : null) === (at ? at.getTime() : null);
  if (r && same) return;
  if (!r && !at) return;
  await q(`INSERT INTO discord_activity (discord_id, boost_since) VALUES ($1,$2)
           ON CONFLICT (discord_id) DO UPDATE SET boost_since=EXCLUDED.boost_since, updated_at=now()`, [uid, at]);
  changed.add(uid);
}
async function boostMessage(d) {
  const r = await q('INSERT INTO discord_boosts (message_id, discord_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING message_id', [d.id, d.author.id]);
  if (r.length) changed.add(d.author.id);
}

// ---------- Invites → recruits ----------
let invites = new Map(); // code → { uses, inviter }
async function loadInvites(guild) {
  const list = await discordFetch(`/guilds/${guild}/invites`).catch(() => null);
  if (!list) return null;
  invites = new Map(list.map((i) => [i.code, { uses: i.uses || 0, inviter: i.inviter?.id || '' }]));
  return list;
}
async function recruitJoined(guild, d) {
  const before = invites;
  const list = await loadInvites(guild);
  if (!list) return;
  // The invite whose use count went up (only when exactly one did, so a busy moment can't credit the wrong person).
  const used = list.filter((i) => (i.uses || 0) > (before.get(i.code)?.uses || 0) && i.inviter?.id);
  if (used.length !== 1) return;
  const inv = used[0];
  let rejected = '';
  if (d.user.bot) rejected = 'bot';
  else if (inv.inviter.id === d.user.id) rejected = 'own invite';
  else if (Date.now() - created(d.user.id) < MIN_ACCOUNT_DAYS * 86400e3) rejected = 'account under 7 days old';
  await q('INSERT INTO discord_recruits (member_id, inviter_id, invite_code, rejected) VALUES ($1,$2,$3,$4) ON CONFLICT (member_id) DO NOTHING',
    [d.user.id, inv.inviter.id, inv.code, rejected]);
}
// Recruits that have been here 14 days: still on the server and passed the entry check → verified.
async function checkRecruits(guild, members) {
  const due = await q(`SELECT * FROM discord_recruits WHERE NOT verified AND rejected='' AND joined_at < now() - interval '${RECRUIT_DAYS} days'`);
  if (!due.length) return;
  const map = await loadMap(guild);
  const here = new Map(members.map((m) => [m.user.id, m]));
  const passed = new Set((await q("SELECT discord_id FROM discord_entries WHERE status IN ('passed','let_in')")).map((r) => r.discord_id));
  const linked = new Map((await q("SELECT discord_id, steam_id FROM users WHERE discord_id <> ''")).map((r) => [r.discord_id, r.steam_id]));
  for (const r of due) {
    const m = here.get(r.member_id);
    let why = '';
    if (!m) why = 'left the server';
    else if (!passed.has(r.member_id) && !(map.roles?.wardogs && m.roles.includes(map.roles.wardogs))) why = 'did not pass the entry check';
    // The same Steam account as the inviter: their own second Discord account.
    else if (linked.get(r.member_id) && linked.get(r.member_id) === linked.get(r.inviter_id)) why = 'same person as the inviter';
    if (why) await q('UPDATE discord_recruits SET rejected=$2 WHERE member_id=$1', [r.member_id, why]);
    else { await q('UPDATE discord_recruits SET verified=true WHERE member_id=$1', [r.member_id]); changed.add(r.inviter_id); }
  }
}

// ---------- Events from the gateway ----------
const changed = new Set(); // Discord ids whose numbers changed (their achievements are checked)
async function onEvent({ t, d }) {
  if (!d) return;
  const guild = await guildId();
  if (!guild) return;
  if (t === 'GUILD_CREATE' && d.id === guild) {
    afkChannel = d.afk_channel_id || null;
    voice.clear();
    for (const v of d.voice_states || []) setVoice({ ...v, member: v.member || { user: { bot: (d.members || []).find((m) => m.user.id === v.user_id)?.user?.bot } } });
    for (const m of d.members || []) if (!m.user.bot) await setBoost(m.user.id, m.premium_since);
    await loadInvites(guild);
    return;
  }
  if (t === 'GUILD_UPDATE' && d.id === guild) { afkChannel = d.afk_channel_id || null; return; }
  if (d.guild_id !== guild) return;
  switch (t) {
    case 'MESSAGE_CREATE':
      if (BOOST_TYPES.has(d.type) && d.author && !d.author.bot) await boostMessage(d);
      else if (validMessage(d)) pending.set(d.id, { uid: d.author.id, text: norm(d.content), at: Date.now() });
      return;
    case 'MESSAGE_DELETE':
      pending.delete(d.id);
      return;
    case 'MESSAGE_DELETE_BULK':
      for (const id of d.ids || []) pending.delete(id);
      return;
    case 'VOICE_STATE_UPDATE':
      setVoice(d);
      return;
    case 'GUILD_MEMBER_ADD':
      if (!d.user.bot && d.premium_since) await setBoost(d.user.id, d.premium_since);
      await recruitJoined(guild, d).catch((e) => console.warn('[discord activity] invite', e.message));
      return;
    case 'GUILD_MEMBER_UPDATE':
      if (!d.user.bot) await setBoost(d.user.id, d.premium_since || null);
      return;
    case 'GUILD_MEMBER_REMOVE':
      voice.delete(d.user.id);
      await setBoost(d.user.id, null);
      return;
    case 'INVITE_CREATE':
      invites.set(d.code, { uses: d.uses || 0, inviter: d.inviter?.id || '' });
      return;
    case 'INVITE_DELETE':
      invites.delete(d.code);
      return;
    default:
  }
}

// Hourly: boosts from the member list (catches anything missed while disconnected) and recruits that are due.
async function hourly() {
  const guild = await guildId();
  if (!/^\d{15,22}$/.test(guild)) return;
  const members = await allMembers(guild).catch(() => null);
  if (!members) return;
  for (const m of members) if (!m.user.bot) await setBoost(m.user.id, m.premium_since || null);
  const listed = new Set(members.map((m) => m.user.id));
  for (const r of await q('SELECT discord_id FROM discord_activity WHERE boost_since IS NOT NULL')) {
    if (!listed.has(r.discord_id)) await setBoost(r.discord_id, null);
  }
  await checkRecruits(guild, members);
  if (!invites.size) await loadInvites(guild);
}

// Members whose numbers changed get their achievements checked (in batches, at most once a minute each).
async function announceChanged() {
  if (!changed.size) return;
  const ids = [...changed];
  changed.clear();
  const users = await q("SELECT id FROM users WHERE status='active' AND discord_id = ANY($1)", [ids]);
  for (const u of users) bus.emit('stats:changed', u.id);
}

export function startDiscordActivity() {
  bus.on('discord:event', (ev) => onEvent(ev).catch((e) => console.warn('[discord activity]', ev.t, e.message)));
  setInterval(() => flushMessages().catch((e) => console.warn('[discord activity] messages', e.message)), 30 * 1000);
  setInterval(() => voiceTick().catch((e) => console.warn('[discord activity] voice', e.message)), 60 * 1000);
  setInterval(() => announceChanged().catch(() => {}), 60 * 1000);
  if (botReady()) {
    setTimeout(() => hourly().catch((e) => console.warn('[discord activity] hourly', e.message)), 90 * 1000);
    setInterval(() => hourly().catch((e) => console.warn('[discord activity] hourly', e.message)), 3600e3);
  }
}
