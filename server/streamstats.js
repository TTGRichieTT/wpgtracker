// A member's verified streaming numbers, from stream_sessions (streams.js).
// Streams on two platforms at once count once: all their sessions are merged into one timeline first, so time is
// never counted twice. Days follow America/New_York and a stream over midnight is split between the two days.
//   streams      — streams of 15+ minutes (shorter ones and quick restarts don't count as a new stream)
//   hours        — all verified streaming time
//   bestDay      — most hours streamed in one day (several streams that day add up)
//   longest      — longest single stream (hours)
//   bestStreak   — most days in a row streamed (a day counts with 30+ minutes)
//   streak       — the current run of days (still counts today if they streamed yesterday)
import { q } from './db.js';

const TZ = 'America/New_York';
const MIN_STREAM_MS = 15 * 60 * 1000;
const MIN_DAY_MS = 30 * 60 * 1000;
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const nyDay = (t) => dayFmt.format(new Date(t)); // "2026-10-08"

// The first New York midnight after t (handles summer / winter time).
function nextMidnight(t) {
  const [h, m, s] = hourFmt.format(new Date(t)).split(':').map(Number);
  let next = t - ((h * 3600 + m * 60 + s) * 1000) + 24 * 3600e3;
  // On clock-change days the day is 23 or 25 hours long: step to the real midnight.
  const [h2, m2] = hourFmt.format(new Date(next)).split(':').map(Number);
  if (h2 !== 0 || m2 !== 0) next -= (h2 >= 12 ? h2 - 24 : h2) * 3600e3 + m2 * 60e3;
  return Math.floor(next / 1000) * 1000;
}
const addDay = (d, n = 1) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

export function summarise(sessions, now = Date.now()) {
  // One timeline: overlapping or touching sessions merged.
  const spans = sessions
    .map((s) => [new Date(s.started_at).getTime(), new Date(s.ended_at || s.last_seen_at).getTime()])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let total = 0;
  let longest = 0;
  let streams = 0;
  const perDay = new Map();
  for (const [a, b] of merged) {
    total += b - a;
    longest = Math.max(longest, b - a);
    if (b - a >= MIN_STREAM_MS) streams++;
    for (let t = a; t < b;) {
      const end = Math.min(b, nextMidnight(t));
      const d = nyDay(t);
      perDay.set(d, (perDay.get(d) || 0) + (end - t));
      t = end;
    }
  }
  const days = [...perDay.entries()].filter(([, ms]) => ms >= MIN_DAY_MS).map(([d]) => d).sort();
  let bestStreak = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i && days[i - 1] === addDay(days[i], -1) ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
  }
  const today = nyDay(now);
  const lastDay = days[days.length - 1];
  const streak = lastDay === today || lastDay === addDay(today, -1) ? run : 0;
  const h = (ms) => Math.floor((ms / 3600e3) * 100) / 100;
  return {
    streams,
    hours: h(total),
    bestDay: h(Math.max(0, ...perDay.values())),
    longest: h(longest),
    bestStreak,
    streak,
    days: days.length,
  };
}

export async function streamStatsFor(userId) {
  const rows = await q('SELECT started_at, last_seen_at, ended_at FROM stream_sessions WHERE user_id=$1', [userId]);
  return summarise(rows);
}
