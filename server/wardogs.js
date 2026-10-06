// Global Wardogs stats are fetched from the owner's keyed player API by account ID (ranking.js).
// Steam hours and achievements are synced separately in steam.js.
import { flag } from './db.js';
import { syncRanks } from './ranking.js';

export async function syncWardogs(user, opts = {}) {
  if (!(await flag('tracker_enabled'))) return { ok: false, reason: 'Global Wardogs stats are switched off in settings' };
  return syncRanks(user, opts);
}
