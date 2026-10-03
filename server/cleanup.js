// Clean up: delete old items, by hand (Admin → Clean up) or automatically after a set number of days.
// Only finished items are ever removed: open reports, new applications and waiting requests are kept,
// and pinned news stays. Every clean-up is written to the audit log. Free databases are small, so this
// also keeps the app inside its storage allowance.
import express from 'express';
import { q, one, audit } from './db.js';
import { bus } from './bus.js';
import { HttpError, role, int } from './util.js';

export const cleanup = express.Router();

// key → what it is, which rows count as "old", and the shortest age allowed.
const TYPES = {
  chat: { label: 'Comms chat messages', help: 'Messages in the chat channels (including ones already deleted from view).', table: 'messages', date: 'created_at', min: 7 },
  stream_chat: { label: 'WPG chat under streams', help: 'The WPG chat tab on stream pages.', table: 'stream_messages', date: 'created_at', min: 7 },
  dms: { label: 'Private messages', help: 'Members\' private messages to each other. Nobody reads them here — only how many and how old.', table: 'dms', date: 'created_at', min: 30 },
  reports: { label: 'Player reports (closed)', help: 'Cheat-watch reports that staff have closed. Open reports are never deleted.', table: 'player_reports', date: 'created_at', where: "status <> 'open'", min: 7 },
  notes: { label: 'Staff notes on players', help: 'Notes staff wrote in Cheat watch.', table: 'player_notes', date: 'created_at', min: 30 },
  applications: { label: 'Recruitment applications (decided)', help: 'Accepted, declined and withdrawn applications. New ones waiting for staff are never deleted. Members keep their unit and roles.', table: 'recruit_applications', date: 'created_at', where: "status <> 'new'", min: 7 },
  requests: { label: 'PMC requests to apply (answered)', help: 'Answered "ask to apply" requests. Waiting ones are never deleted.', table: 'apply_requests', date: 'created_at', where: "status <> 'pending'", min: 7 },
  news: { label: 'News & announcements (not pinned)', help: 'Old posts on HQ. Pinned posts are never deleted.', table: 'announcements', date: 'created_at', where: 'pinned = false', min: 7 },
  matches: { label: 'Match history (cheat watch)', help: 'Each player\'s result per match, used for cheat-watch spikes. Leaderboard totals are not affected.', table: 'match_players', date: 'ended_at', min: 30 },
  kills: { label: 'Kill feed (cheat watch)', help: 'Single kills from the game server\'s kill feed (headshots, distances). Deleted after 180 days anyway.', table: 'kill_events', date: 'received_at', min: 7 },
  audit: { label: 'Audit log', help: 'The record of what staff did. Kept at least 90 days so there is always a record of recent actions.', table: 'audit_log', date: 'created_at', min: 90 },
};
const filter = (t) => (t.where ? ` AND ${t.where}` : '');

async function autoSettings() {
  const row = await one("SELECT value FROM settings WHERE key='_cleanup_auto'");
  try { return JSON.parse(row?.value || '{}'); } catch { return {}; }
}

async function sizeOf(table) {
  const r = await one('SELECT pg_total_relation_size($1::regclass)::bigint AS b', [table]).catch(() => null);
  return r ? Number(r.b) : null;
}

export async function deleteOlder(key, days, actorId = null) {
  const t = TYPES[key];
  if (!t) throw new HttpError(404, 'Unknown item type.');
  const d = int(days);
  if (d < t.min) throw new HttpError(400, `${t.label}: the shortest is ${t.min} days.`);
  const r = await one(
    `WITH gone AS (DELETE FROM ${t.table} WHERE ${t.date} < now() - ($1 || ' days')::interval${filter(t)} RETURNING 1) SELECT COUNT(*)::int AS n FROM gone`,
    [String(d)],
  );
  if (r.n) await audit(actorId, `cleanup.${key}`, `${r.n} older than ${d} days`, { auto: !actorId });
  if (r.n && key === 'chat') bus.emit('config:changed', 'channels');
  return r.n;
}

// Admins: what there is, and how much would go.
cleanup.get('/admin/cleanup', role('admin'), async (_req, res) => {
  const auto = await autoSettings();
  const out = [];
  for (const [key, t] of Object.entries(TYPES)) {
    const r = await one(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE true${filter(t)})::int AS deletable, MIN(${t.date}) FILTER (WHERE true${filter(t)}) AS oldest FROM ${t.table}`);
    out.push({ key, label: t.label, help: t.help, min: t.min, total: r.total, deletable: r.deletable, oldest: r.oldest, bytes: await sizeOf(t.table), auto: int(auto[key]) || 0 });
  }
  const db = await one('SELECT pg_database_size(current_database())::bigint AS b').catch(() => null);
  res.json({ types: out, database_bytes: db ? Number(db.b) : null });
});

cleanup.post('/admin/cleanup/:key/preview', role('admin'), async (req, res) => {
  const t = TYPES[req.params.key];
  if (!t) throw new HttpError(404, 'Unknown item type.');
  const d = Math.max(t.min, int(req.body?.days));
  const r = await one(`SELECT COUNT(*)::int AS n FROM ${t.table} WHERE ${t.date} < now() - ($1 || ' days')::interval${filter(t)}`, [String(d)]);
  res.json({ count: r.n, days: d });
});

cleanup.post('/admin/cleanup/:key', role('admin'), async (req, res) => {
  res.json({ deleted: await deleteOlder(req.params.key, req.body?.days, req.user.id) });
});

// Automatic clean-up: days per type (0 = never).
cleanup.put('/admin/cleanup/auto', role('admin'), async (req, res) => {
  const auto = await autoSettings();
  for (const [key, t] of Object.entries(TYPES)) {
    if (!(key in (req.body || {}))) continue;
    const d = int(req.body[key]);
    if (d && d < t.min) throw new HttpError(400, `${t.label}: the shortest is ${t.min} days.`);
    if (d) auto[key] = d; else delete auto[key];
  }
  await q("INSERT INTO settings (key, value) VALUES ('_cleanup_auto', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(auto)]);
  await audit(req.user.id, 'cleanup.auto', '', auto);
  res.json({ ok: true, auto });
});

// Once a day: the automatic clean-ups, plus housekeeping nobody needs to see (expired sign-ins and codes).
export function startCleanup() {
  const run = async () => {
    try {
      const auto = await autoSettings();
      for (const [key, days] of Object.entries(auto)) {
        if (TYPES[key] && int(days) >= TYPES[key].min) await deleteOlder(key, days).catch((e) => console.warn('[cleanup]', key, e.message));
      }
      await q('DELETE FROM sessions WHERE expire < now()').catch(() => {});
      await q("DELETE FROM remember_tokens WHERE last_used < now() - interval '120 days'").catch(() => {});
      await q("DELETE FROM discord_link_codes WHERE created_at < now() - interval '1 day'").catch(() => {});
    } catch (e) {
      console.warn('[cleanup]', e.message);
    }
    setTimeout(run, 24 * 3600 * 1000);
  };
  setTimeout(run, 15 * 60 * 1000);
}
