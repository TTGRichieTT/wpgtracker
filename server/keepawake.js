// Render's free plan puts the app to sleep after 15 minutes without visitors. Asleep, the Discord bot
// misses Discord's 3-second reply window and the server tracker stops counting matches. A small visit
// to our own public address every 10 minutes keeps it awake (one always-on app fits in the free
// 750 hours a month). Only runs on Render; set KEEP_AWAKE=false in the environment to switch it off.
export function startKeepAwake() {
  const base = String(process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!base || process.env.KEEP_AWAKE === 'false') return;
  setInterval(() => {
    fetch(`${base}/healthz`, { signal: AbortSignal.timeout(30000) }).catch(() => {});
  }, 10 * 60 * 1000);
  console.log('[WPG] Keep-awake on: visiting', `${base}/healthz`, 'every 10 minutes.');
}
