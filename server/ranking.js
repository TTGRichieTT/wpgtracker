// External Wardogs Tracker requests are disabled. Keep saved rankings and official stats as-is.
export async function syncRanks(_user, _opts = {}) {
  return { ok: false, reason: 'Wardogs Tracker sync is disabled; saved stats will not be refreshed' };
}
