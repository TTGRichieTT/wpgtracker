// Global Wardogs stats for a member (levels, cash, classes and world ranks), from WARDOGS Tracker's public
// stats API (ranking.js). Steam hours and achievements are synced separately in steam.js.
import { flag } from './db.js';
import { syncRanks } from './ranking.js';

export async function syncWardogs(user, opts = {}) {
  if (!(await flag('tracker_enabled'))) return { ok: false, reason: 'Global Wardogs stats are switched off in settings' };
  return syncRanks(user, opts);
}
