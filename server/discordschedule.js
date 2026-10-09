// Scheduled announcements (Discord control → Scheduled announcements, admins only).
// Admins write an announcement (WPG banner + boxes, @Role / #room mentions, optional ping), pick the room (default
// #announcements), a UK date and time, and whether it repeats (daily, chosen weekdays, every 2 weeks, monthly, every
// N days; optional last date or number of sends). The bot posts it as a fresh message at that time; the app never
// edits or deletes it on Discord. A one-off leaves the scheduled list once it's sent; repeating ones stay with their
// next time. Every send goes in the history. Optionally it's also added to the app's announcements on HQ.
// If the app was restarting at send time it's sent late (up to 3 hours); later than that it skips to the next time.
import { q, one } from './db.js';
import { bus } from './bus.js';
import { discordFetch, sendToChannel, botReady } from './discordbot.js';
import { guildId, loadMap } from './discordserver.js';

export const REPEATS = ['none', 'daily', 'weekly', 'fortnightly', 'monthly', 'days'];
const LATE_LIMIT = 3 * 3600e3;
const DAY = 86400e3;

// ---------- UK time ----------
function ukParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}
// A UK wall-clock date and time → the real moment (handles summer time).
export function ukToDate(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const u = ukParts(new Date(guess));
    const shown = Date.UTC(u.y, u.m - 1, u.d, u.h, u.mi);
    guess += wall - shown;
  }
  return new Date(guess);
}
const ymd = (t) => { const x = new Date(t); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`; };
const addDays = (dateStr, n) => { const [y, m, d] = dateStr.split('-').map(Number); return ymd(Date.UTC(y, m - 1, d + n)); };
const weekday = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
function addMonth(dateStr, firstDay) {
  const [y, m] = dateStr.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // days in the next month
  return ymd(Date.UTC(y, m, Math.min(firstDay, last)));
}
// The UK date of the send after `dateStr`, or null when it doesn't repeat.
function nextDate(s, dateStr) {
  switch (s.repeat) {
    case 'daily': return addDays(dateStr, 1);
    case 'fortnightly': return addDays(dateStr, 14);
    case 'monthly': return addMonth(dateStr, Number(s.date.slice(8, 10)));
    case 'days': return addDays(dateStr, Math.max(1, s.every_days || 1));
    case 'weekly': {
      const days = (Array.isArray(s.weekdays) && s.weekdays.length ? s.weekdays : [weekday(s.date)]).map(Number);
      for (let i = 1; i <= 7; i++) if (days.includes(weekday(addDays(dateStr, i)))) return addDays(dateStr, i);
      return addDays(dateStr, 7);
    }
    default: return null;
  }
}
// The first send at or after `from` (a weekly one starts on the first chosen weekday on or after its start date).
export function firstSend(s, from = Date.now()) {
  let date = s.date;
  if (s.repeat === 'weekly' && Array.isArray(s.weekdays) && s.weekdays.length && !s.weekdays.map(Number).includes(weekday(date))) date = nextDate(s, date);
  for (let i = 0; i < 2000 && date; i++) {
    if (s.until_date && date > s.until_date) return null;
    const at = ukToDate(date, s.time);
    if (at.getTime() >= from - 60e3) return at;
    date = nextDate(s, date);
  }
  return null;
}
function ukDateOf(at) { const u = ukParts(new Date(at)); return `${u.y}-${String(u.m).padStart(2, '0')}-${String(u.d).padStart(2, '0')}`; }
// After a send (or a skipped late one): the next time, or null when it's finished.
function afterSend(s, sentAt) {
  if (s.repeat === 'none') return null;
  if (s.max_sends && s.sends >= s.max_sends) return null;
  let date = nextDate(s, ukDateOf(sentAt));
  for (let i = 0; i < 2000 && date; i++) {
    if (s.until_date && date > s.until_date) return null;
    const at = ukToDate(date, s.time);
    if (at.getTime() > Date.now() - 60e3) return at;
    date = nextDate(s, date);
  }
  return null;
}

// ---------- Saving ----------
const clean = (b) => {
  const repeat = REPEATS.includes(b.repeat) ? b.repeat : 'none';
  const out = {
    channel_id: String(b.channel_id || ''),
    title: String(b.title || '').slice(0, 60),
    body: String(b.body || '').slice(0, 4000),
    style: b.style === 'text' ? 'text' : 'card',
    ping: !!b.ping,
    show_in_app: !!b.show_in_app,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? String(b.date) : '',
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time || '')) ? String(b.time) : '',
    repeat,
    weekdays: repeat === 'weekly' ? [...new Set((Array.isArray(b.weekdays) ? b.weekdays : []).map(Number).filter((d) => d >= 0 && d <= 6))] : [],
    every_days: repeat === 'days' ? Math.min(365, Math.max(1, Number(b.every_days) || 1)) : 0,
    until_date: repeat !== 'none' && /^\d{4}-\d{2}-\d{2}$/.test(String(b.until_date || '')) ? String(b.until_date) : '',
    max_sends: repeat !== 'none' ? Math.min(10000, Math.max(0, Number(b.max_sends) || 0)) : 0,
  };
  if (!out.channel_id) throw new Error('Pick a room.');
  if (!out.body.trim()) throw new Error('Write the announcement first.');
  if (!out.date || !out.time) throw new Error('Pick the day and time.');
  if (out.repeat === 'weekly' && !out.weekdays.length) out.weekdays = [weekday(out.date)];
  return out;
};
export async function saveScheduled(id, b, userId) {
  const v = clean(b);
  const next = firstSend(v);
  if (!next) throw new Error('That time has already gone (and it doesn\'t repeat after it). Pick a later time.');
  const cols = Object.keys(v);
  const vals = cols.map((k) => (k === 'weekdays' ? JSON.stringify(v[k]) : v[k]));
  if (id) {
    const row = await one(`UPDATE discord_scheduled SET ${cols.map((k, i) => `${k}=$${i + 2}`).join(', ')}, next_at=$${cols.length + 2}, sends=0 WHERE id=$1 RETURNING *`, [id, ...vals, next]);
    if (!row) throw new Error('Not found.');
    return row;
  }
  return one(`INSERT INTO discord_scheduled (${cols.join(', ')}, next_at, created_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}, $${cols.length + 2}) RETURNING *`, [...vals, next, userId]);
}

// ---------- Sending ----------
// Posts it now (a fresh message every time; never edited or deleted by the app) and records it in the history.
async function send(s, how = 'scheduled') {
  const { buildPostPayload } = await import('./discordrooms.js');
  let messageId = '';
  let problem = '';
  try {
    const m = await sendToChannel(s.channel_id, await buildPostPayload(s));
    messageId = m?.id || '';
  } catch (e) {
    problem = e.message.slice(0, 300);
  }
  await q('INSERT INTO discord_scheduled_log (scheduled_id, channel_id, title, body, message_id, ok, problem, how) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [s.id || null, s.channel_id, s.title, s.body, messageId, !problem, problem, how]);
  if (!problem && s.show_in_app) {
    // The app's own announcements (HQ): the title and the text, with the box markers turned into plain lines.
    const text = String(s.body).split(/\r?\n/).map((l) => (/^-{3,}$/.test(l.trim()) ? '' : l.replace(/^#{1,3}\s+/, '\n'))).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    await q('INSERT INTO announcements (title, body, author_id) VALUES ($1,$2,$3)', [s.title || 'Announcement', text.slice(0, 5000), s.created_by || null]);
    bus.emit('config:changed', 'announcements');
  }
  // A line in the staff mod log.
  const guild = await guildId();
  const log = guild ? (await loadMap(guild)).channels?.['staff:mod-log'] : '';
  if (log) {
    await discordFetch(`/channels/${log}/messages`, 'POST', {
      embeds: [{ color: problem ? 0xe5484d : 0x29b6f6, title: `📢 Scheduled announcement ${problem ? 'failed' : 'sent'}`, description: `**${s.title || 'Announcement'}** in <#${s.channel_id}>${problem ? `\n${problem}` : ''}` }],
      allowed_mentions: { parse: [] },
    }).catch(() => {});
  }
  return { ok: !problem, problem, message_id: messageId };
}
export async function sendNow(id) {
  const s = await one('SELECT * FROM discord_scheduled WHERE id=$1', [id]);
  if (!s) throw new Error('Not found.');
  return send(s, 'now');
}

let running = false;
export async function tick() {
  if (running || !botReady()) return;
  running = true;
  try {
    const due = await q('SELECT * FROM discord_scheduled WHERE NOT paused AND next_at IS NOT NULL AND next_at <= now() ORDER BY next_at');
    for (const s of due) {
      const late = Date.now() - new Date(s.next_at).getTime() > LATE_LIMIT;
      if (!late) {
        await send(s);
        s.sends += 1;
      } else {
        await q('INSERT INTO discord_scheduled_log (scheduled_id, channel_id, title, body, message_id, ok, problem, how) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [s.id, s.channel_id, s.title, s.body, '', false, 'Skipped: the app was offline for more than 3 hours around its time.', 'skipped']);
      }
      const next = afterSend(s, s.next_at);
      // One-offs (and finished repeats) leave the list; the history keeps every send.
      if (!next) await q('DELETE FROM discord_scheduled WHERE id=$1', [s.id]);
      else await q('UPDATE discord_scheduled SET next_at=$2, sends=$3 WHERE id=$1', [s.id, next, s.sends]);
    }
  } catch (e) {
    console.warn('[scheduled]', e.message);
  } finally {
    running = false;
  }
}

export async function overview() {
  const [list, history] = await Promise.all([
    q('SELECT * FROM discord_scheduled ORDER BY paused, next_at NULLS LAST, id'),
    q('SELECT * FROM discord_scheduled_log ORDER BY sent_at DESC LIMIT 200'),
  ]);
  return { list, history, guild: await guildId() };
}

export function startScheduled() {
  if (!botReady()) return;
  setTimeout(() => tick(), 45e3);
  setInterval(() => tick(), 60e3);
}
