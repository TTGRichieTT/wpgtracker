// The weekly welcome (Discord control → Bot posts & guides → Weekly welcome): once a week, on the day and time the
// admins pick (UK time), the bot posts in the announcements room: it @mentions everyone who joined the WPG Discord in
// the last 7 days and is still there (bots left out; with the entry check on, only people who got in), thanks them,
// and reminds them to follow WPG on Facebook and sign up to the app. Those already in the app are ticked; the rest get
// a friendly nudge. Nobody is welcomed twice; no post when nobody new joined; a missed week (app restarting) is posted
// late. The WPG banner on top and the text as Discord embeds, like the guides.
import { q, one, setting } from './db.js';
import { discordFetch, sendToChannel, botReady, commandIds } from './discordbot.js';
import { guildId, loadMap, allMembers } from './discordserver.js';

const SITE = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://wpg-barracks.onrender.com').replace(/\/$/, '');
const COLOR = 0x33d1ff;
const MAX_PINGS = 50;
const DAY = 86400e3;
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DEFAULTS = {
  weekly_welcome_on: 'true',
  weekly_welcome_channel: '1216495498035200102', // #announcements
  weekly_welcome_day: '', // 0 = Sunday … 6 = Saturday; nothing is posted until the admins set a day and time
  weekly_welcome_time: '',
  weekly_welcome_ping: 'true',
  weekly_welcome_nudge: 'true',
  weekly_welcome_title: 'Welcome to the pack {mentions}! Thanks for joining Wasted Prodigy Gamers this week 🐺',
  weekly_welcome_text: "Thanks for joining our community, we're glad to have you!\n\n"
    + '**📘 Follow us on Facebook** for news, events and giveaways.\n'
    + '**📱 Sign up to WPG Barracks**, the WPG app: your stats, medals, badges, Combat Command and more. Sign in with Steam, then type /link here to connect your Discord.',
};
export async function welcomeSettings() {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const saved = await setting(k);
    out[k] = saved === null || saved === undefined ? v : String(saved);
  }
  return out;
}
export async function saveWelcomeSettings(b) {
  const clean = {
    weekly_welcome_on: b.on ? 'true' : 'false',
    weekly_welcome_channel: /^\d{15,22}$/.test(String(b.channel || '')) ? String(b.channel) : '',
    weekly_welcome_day: /^[0-6]$/.test(String(b.day ?? '')) ? String(b.day) : '',
    weekly_welcome_time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time || '')) ? String(b.time) : '',
    weekly_welcome_ping: b.ping === false ? 'false' : 'true',
    weekly_welcome_nudge: b.nudge === false ? 'false' : 'true',
    weekly_welcome_title: String(b.title || DEFAULTS.weekly_welcome_title).slice(0, 300),
    weekly_welcome_text: String(b.text || DEFAULTS.weekly_welcome_text).slice(0, 3000),
  };
  const before = await welcomeSettings();
  for (const [k, v] of Object.entries(clean)) {
    await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
  }
  // A new day or time starts from the next one (not straight away for a slot that has just gone).
  if (before.weekly_welcome_day !== clean.weekly_welcome_day || before.weekly_welcome_time !== clean.weekly_welcome_time) {
    const slot = currentSlot(clean);
    if (slot) await q("INSERT INTO settings (key, value) VALUES ('_weekly_welcome_slot', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [slot.label]);
  }
  return welcomeSettings();
}

// UK time, worked out without a time-zone library: the local wall-clock parts for a moment.
function ukParts(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
// This week's slot (the latest day + time that has already come, UK time) as a label like "2026-10-11 18:00", and how
// many minutes ago it was. null when no day / time is set.
export function currentSlot(s, now = new Date()) {
  if (s.weekly_welcome_day === '' || !s.weekly_welcome_time) return null;
  const [hh, mm] = s.weekly_welcome_time.split(':').map(Number);
  const u = ukParts(now);
  const nowLocal = Date.UTC(u.y, u.m - 1, u.d, u.h, u.mi);
  let back = (u.dow - Number(s.weekly_welcome_day) + 7) % 7;
  let slot = Date.UTC(u.y, u.m - 1, u.d - back, hh, mm);
  if (slot > nowLocal) { back += 7; slot = Date.UTC(u.y, u.m - 1, u.d - back, hh, mm); }
  const t = new Date(slot);
  const label = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')} ${s.weekly_welcome_time}`;
  return { label, minutesAgo: Math.round((nowLocal - slot) / 60e3) };
}
export function nextSlotText(s) {
  if (s.weekly_welcome_day === '' || !s.weekly_welcome_time) return '';
  return `${DAYS[Number(s.weekly_welcome_day)]}s at ${s.weekly_welcome_time} (UK time)`;
}

// Who to welcome: joined in the last 7 days, still on the server, not a bot, not welcomed before; with the entry check
// on, only those who got through it (they have WPG Community).
export async function newJoiners() {
  const guild = await guildId();
  if (!guild) return [];
  const map = await loadMap(guild);
  const entry = (await setting('discord_entry_enabled')) === 'true';
  const community = map.roles?.wardogs && !String(map.roles.wardogs).startsWith('new:') ? map.roles.wardogs : '';
  const since = Date.now() - 7 * DAY;
  const done = new Set((await q('SELECT discord_id FROM discord_welcomed')).map((r) => r.discord_id));
  const members = (await allMembers(guild)).filter((m) => !m.user?.bot && !m.pending && Date.parse(m.joined_at) >= since && !done.has(m.user.id)
    && (!entry || !community || (m.roles || []).includes(community)));
  members.sort((a, b) => Date.parse(a.joined_at) - Date.parse(b.joined_at));
  const linked = new Set((await q("SELECT discord_id FROM users WHERE discord_id = ANY($1) AND status='active'", [members.map((m) => m.user.id)])).map((r) => r.discord_id));
  return members.map((m) => ({ id: m.user.id, name: m.user.global_name || m.user.username || m.user.id, inApp: linked.has(m.user.id) }));
}

async function setupRoom() {
  return (await one("SELECT channel_id FROM discord_bot_posts WHERE kind='setup' ORDER BY id LIMIT 1"))?.channel_id || '';
}
export async function welcomePayload(people, s) {
  const ids = people.map((p) => p.id);
  const pinged = ids.slice(0, MAX_PINGS);
  const more = ids.length - pinged.length;
  const mentions = `${pinged.map((id) => `<@${id}>`).join(' ')}${more > 0 ? ` …and ${more} more` : ''}`;
  const cmds = await commandIds().catch(() => new Map());
  // {mentions} and {count} filled in; "/link" and the other commands written in the text are clickable.
  const { mentionTools } = await import('./discordrooms.js');
  const m = await mentionTools().catch(() => null);
  // @Role and #room written in the text become real mentions (shown, not pinged).
  const fill = (t) => (m ? m.convert : (x) => x)(String(t || '').replaceAll('{mentions}', mentions).replaceAll('{count}', String(ids.length))
    .replace(/(^|\s)\/([a-z]+)\b/g, (x, pre, n) => (cmds.get(n) ? `${pre}</${n}:${cmds.get(n)}>` : x)));
  let content = fill(s.weekly_welcome_title);
  if (!s.weekly_welcome_title.includes('{mentions}')) content = `${mentions}\n${content}`;
  const setup = await setupRoom();
  const fb = String((await setting('facebook_url')) || '').trim();
  const body = `${fill(s.weekly_welcome_text)}${setup ? `\n\nStep-by-step app guide: <#${setup}>` : ''}`;
  const embeds = [{ color: COLOR, image: { url: 'attachment://banner.jpg' } }, { color: COLOR, description: body.slice(0, 4000) }];
  if (s.weekly_welcome_nudge === 'true') {
    const inApp = people.filter((p) => p.inApp);
    const notYet = people.filter((p) => !p.inApp);
    const list = (l) => l.slice(0, 60).map((p) => `<@${p.id}>`).join(' ') + (l.length > 60 ? ` …and ${l.length - 60} more` : '');
    const lines = [];
    if (inApp.length) lines.push(`✅ **Already in the app:** ${list(inApp)}`);
    if (notYet.length) lines.push(`📱 **Not in the app yet:** ${list(notYet)}\nIt only takes 5 minutes: sign in with Steam at ${SITE()}${setup ? ` (guide in <#${setup}>)` : ''}.`);
    if (lines.length) embeds.push({ color: COLOR, title: 'WPG BARRACKS APP', description: lines.join('\n\n').slice(0, 4000) });
  }
  embeds[embeds.length - 1].footer = { text: `${ids.length} new member${ids.length === 1 ? '' : 's'} this week · Wasted Prodigy Gamers` };
  const buttons = [
    ...(/^https:\/\//.test(fb) ? [{ type: 2, style: 5, label: 'Follow on Facebook', url: fb }] : []),
    { type: 2, style: 5, label: 'Open WPG Barracks', url: SITE() },
  ];
  const { renderBanner } = await import('./cards.js');
  return {
    content: content.slice(0, 2000),
    embeds,
    files: [{ name: 'banner.jpg', data: await renderBanner('WELCOME TO THE PACK'), type: 'image/jpeg' }],
    components: [{ type: 1, components: buttons }],
    allowed_mentions: { parse: [], users: s.weekly_welcome_ping === 'true' ? pinged : [] },
  };
}

// Posts it now (or says why not). Marks everyone in it as welcomed.
export async function postWelcome({ force = false } = {}) {
  const s = await welcomeSettings();
  if (!s.weekly_welcome_channel) return { ok: false, reason: 'Pick a room first.' };
  const people = await newJoiners();
  if (!people.length) return { ok: true, posted: false, reason: 'Nobody new joined in the last 7 days.' };
  if (!force && s.weekly_welcome_on !== 'true') return { ok: false, reason: 'The weekly welcome is switched off.' };
  const payload = await welcomePayload(people, s);
  await sendToChannel(s.weekly_welcome_channel, payload);
  for (const p of people) await q('INSERT INTO discord_welcomed (discord_id) VALUES ($1) ON CONFLICT DO NOTHING', [p.id]);
  // A line in the staff mod log.
  const guild = await guildId();
  const log = guild ? (await loadMap(guild)).channels?.['staff:mod-log'] : '';
  if (log) {
    await discordFetch(`/channels/${log}/messages`, 'POST', {
      embeds: [{ color: COLOR, title: '👋 Weekly welcome', description: `${people.length} new member${people.length === 1 ? '' : 's'} welcomed in <#${s.weekly_welcome_channel}> (${people.filter((p) => p.inApp).length} already in the app).` }],
      allowed_mentions: { parse: [] },
    }).catch(() => {});
  }
  return { ok: true, posted: true, count: people.length };
}

// Every 5 minutes: when this week's slot has come and it hasn't been posted yet, post it. A slot missed while the app
// was restarting is still posted, up to 2 days late.
let running = false;
async function tick() {
  if (running || !botReady()) return;
  running = true;
  try {
    const s = await welcomeSettings();
    if (s.weekly_welcome_on !== 'true') return;
    const slot = currentSlot(s);
    if (!slot || slot.minutesAgo > 2 * 24 * 60) return;
    if ((await setting('_weekly_welcome_slot')) === slot.label) return;
    const r = await postWelcome();
    if (r.ok) await q("INSERT INTO settings (key, value) VALUES ('_weekly_welcome_slot', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [slot.label]);
    else console.warn('[welcome]', r.reason);
  } catch (e) {
    console.warn('[welcome]', e.message);
  } finally {
    running = false;
  }
}
export function startWeeklyWelcome() {
  if (!botReady()) return;
  setTimeout(tick, 60e3);
  setInterval(tick, 5 * 60e3);
}
