import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { initDb, closeDb, q, one, flag, dbHealth } from './db.js';
import { giveAutoMedalsToAll } from './medals.js';
import { bus } from './bus.js';
import { steamLoginUrl, verifySteamLogin, fetchSummary, syncUser, startSyncLoop } from './steam.js';
import { api } from './routes.js';
import { admin, ingest } from './admin.js';
import { servers } from './servers.js';
import { startServerTracker, pushMemberStats } from './servertracker.js';
import { startWarconSync } from './warcon.js';
import { startProgressSync } from './progress.js';
import { discordBot, startDiscordBot } from './discordbot.js';
import { killFeed, cheat, startCheatWatch } from './cheatwatch.js';
import { combat } from './combat.js';
import { cleanup, startCleanup } from './cleanup.js';
import { streams, startStreamWatch } from './streams.js';
import { startKeepAwake } from './keepawake.js';
import { startPlayingWatch } from './playing.js';
import { discord } from './discord.js';
import { startRealtime } from './realtime.js';
import { PgSessionStore, HttpError, str, OWNER_IDS, START_ADMIN_IDS, hashToken } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PROD = process.env.NODE_ENV === 'production' || !!process.env.REPLIT_DEPLOYMENT;

await initDb();
giveAutoMedalsToAll().then((r) => r.given && console.log(`[medals] Gave ${r.given} automatic medals`)).catch(() => {});
if (OWNER_IDS.size) {
  await q("UPDATE users SET role='admin', status='active' WHERE steam_id = ANY($1)", [[...OWNER_IDS]]);
}

// Keep the session secret in the database so logins survive restarts without extra setup.
async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let row = await one("SELECT value FROM settings WHERE key='_session_secret'");
  if (!row) {
    const value = crypto.randomBytes(32).toString('hex');
    await q("INSERT INTO settings (key, value) VALUES ('_session_secret', $1) ON CONFLICT DO NOTHING", [value]);
    row = await one("SELECT value FROM settings WHERE key='_session_secret'");
  }
  return row.value;
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const store = new PgSessionStore();
const sessionMiddleware = session({
  store,
  secret: await sessionSecret(),
  name: 'wpg.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * 24 * 60 * 60 * 1000 },
});

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' https: data:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "script-src 'self'",
      "connect-src 'self' ws: wss:",
      // Stream players and chats on the Streams tab.
      "frame-src https://player.twitch.tv https://www.twitch.tv https://www.youtube.com https://www.youtube-nocookie.com https://player.kick.com https://kick.com",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  next();
});
// Discord bot commands: before the JSON parser, because the signature check needs the raw body.
app.use(discordBot);
app.use(killFeed); // game server kill feed: also reads the raw body (any format)
app.use(express.json({ limit: '200kb' }));
app.use(sessionMiddleware);

// Blocks cross-site form posts: every state-changing API call must be JSON from our own page.
app.use('/api', (req, _res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(req.method) && !req.path.startsWith('/ingest') && !req.is('application/json')) {
    throw new HttpError(415, 'Requests must be JSON.');
  }
  next();
});

// Safety valve: a browser tab stuck in a loop (old app code, a bug) gets turned away before it reaches
// the database, so one tab can't slow the app down for everyone. Normal use never gets near this.
const CALM_WINDOW_MS = 20 * 1000;
const CALM_MAX = 150;
const calls = new Map(); // session (or address) -> { n, since }
app.use('/api', (req, _res, next) => {
  if (req.path.startsWith('/ingest')) return next();
  const who = req.sessionID && req.session?.userId ? `s:${req.sessionID}` : `ip:${req.ip}`;
  const now = Date.now();
  let c = calls.get(who);
  if (!c || now - c.since > CALM_WINDOW_MS) {
    c = { n: 0, since: now };
    calls.set(who, c);
    if (calls.size > 5000) for (const [k, v] of calls) if (now - v.since > CALM_WINDOW_MS) calls.delete(k);
  }
  if (++c.n > CALM_MAX) throw new HttpError(429, 'Too many requests at once. Please reload the page.');
  next();
});

function baseUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// ---------- Login ----------
async function loginSteamId(req, steamId, fallbackName) {
  let user = await one('SELECT * FROM users WHERE steam_id=$1', [steamId]);
  const summary = /^\d{17}$/.test(steamId) ? await fetchSummary(steamId).catch(() => null) : null;
  const owner = OWNER_IDS.has(steamId);
  if (!user) {
    const count = await one('SELECT COUNT(*)::int AS n FROM users');
    const first = count.n === 0 || owner || START_ADMIN_IDS.has(steamId);
    const needsApproval = !first && (await flag('require_approval'));
    const lowest = await one('SELECT id FROM ranks ORDER BY sort_order LIMIT 1');
    user = await one(
      `INSERT INTO users (steam_id, persona_name, avatar, profile_url, role, status, rank_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        steamId,
        summary?.persona_name || fallbackName || `Soldier-${steamId.slice(-4)}`,
        summary?.avatar || '',
        summary?.profile_url || (/^\d{17}$/.test(steamId) ? `https://steamcommunity.com/profiles/${steamId}` : ''),
        first ? 'admin' : 'member',
        needsApproval ? 'pending' : 'active',
        lowest?.id || null,
      ],
    );
    if (needsApproval) {
      bus.emit('staff:notify', { title: 'New recruit waiting', body: `${user.persona_name} is waiting for approval.`, link: '#/admin/users' });
    }
  } else if (summary) {
    user = await one('UPDATE users SET persona_name=$2, avatar=$3, profile_url=$4, last_seen=now() WHERE id=$1 RETURNING *', [
      user.id, summary.persona_name, summary.avatar || user.avatar, summary.profile_url,
    ]);
  }
  if (owner && (user.role !== 'admin' || user.status !== 'active')) {
    user = await one("UPDATE users SET role='admin', status='active' WHERE id=$1 RETURNING *", [user.id]);
  }
  if (user.status === 'banned') throw new HttpError(403, 'This account has been banned.');
  await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.userId = user.id;
  if (user.status === 'active') syncUser(user.id).catch(() => {});
  return user;
}

app.get('/auth/steam', (req, res) => {
  res.redirect(steamLoginUrl(baseUrl(req)));
});

app.get('/auth/steam/return', async (req, res) => {
  const steamId = await verifySteamLogin(req.query, baseUrl(req)).catch(() => null);
  if (!steamId) return res.redirect('/#/login?error=steam');
  try {
    await loginSteamId(req, steamId);
  } catch (e) {
    return res.redirect(`/#/login?error=${e.status === 403 ? 'banned' : 'server'}`);
  }
  res.redirect('/#/');
});

app.get('/auth/config', (_req, res) => {
  res.json({ dev_login: process.env.DEV_LOGIN === 'true' });
});

app.post('/auth/dev', express.json(), async (req, res) => {
  if (process.env.DEV_LOGIN !== 'true') throw new HttpError(404, 'Not found');
  const name = str(req.body?.name, 32) || 'Tester';
  const fakeId = `dev-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const user = await loginSteamId(req, fakeId, name);
  res.json({ ok: true, id: user.id });
});

// "Remember me": a device-held key that signs a member back in if their sign-in cookie is lost.
app.post('/auth/resume', express.json(), async (req, res) => {
  const token = str(req.body?.token, 100);
  if (!token) throw new HttpError(400, 'Missing key.');
  const row = await one(
    `SELECT rt.id, u.id AS user_id, u.status FROM remember_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1 AND rt.last_used > now() - interval '120 days'`,
    [hashToken(token)],
  );
  if (!row || row.status === 'banned') throw new HttpError(401, 'Please sign in with Steam.', 'signed_out');
  await q('UPDATE remember_tokens SET last_used = now() WHERE id = $1', [row.id]);
  await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.userId = row.user_id;
  req.session.rememberSent = true; // this device already has its key
  res.json({ ok: true });
});

app.post('/auth/logout', async (req, res) => {
  const token = str(req.body?.token, 100);
  if (token) await q('DELETE FROM remember_tokens WHERE token_hash = $1', [hashToken(token)]).catch(() => {});
  req.session.destroy(() => {
    res.clearCookie('wpg.sid');
    res.json({ ok: true });
  });
});

// Twitch / Kick sign-in so members can chat in streams as themselves.

// ---------- API ----------
app.use('/api/ingest', ingest);
app.use('/api/admin', admin);
app.use('/api', servers);
app.use('/api', cheat);
app.use('/api', combat);
app.use('/api', cleanup);
app.use('/api', streams);
app.use('/api', discord);
app.use('/api', api);
app.use('/api', (_req, _res) => {
  throw new HttpError(404, 'Not found');
});

// up = seconds since the app started (a small number outside an update means it restarted on its own).
app.get('/healthz', async (req, res) => {
  const out = { ok: true, version: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7), up: Math.round(process.uptime()) };
  // ?db=1: also time one database trip (to spot a slow or busy database).
  if (req.query.db === '1') out.db = await dbHealth().catch((e) => ({ error: e.message }));
  res.json(out);
});

// Map pictures, unlock pictures and artwork never change, so browsers keep them for 30 days
// (saves bandwidth on free hosting). Everything else is re-checked every time so updates show straight away.
const LONG_CACHE = /^\/(maps|img\/unlocks|img\/brand|vendor)\//;
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    const rel = `/${path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/')}`;
    res.setHeader('Cache-Control', LONG_CACHE.test(rel) && !rel.endsWith('.json') ? 'public, max-age=2592000' : 'no-cache');
  },
}));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  // Our own errors (HttpError) have messages written for people, e.g. "wrong RCON password" — show those.
  // Anything unexpected stays hidden and goes to the log.
  const known = err instanceof HttpError;
  if (!known) console.error(err);
  res.status(status).json({ error: known || status < 500 ? err.message : 'Something went wrong on the server.', code: err.code });
});

const server = http.createServer(app);
startRealtime(server, sessionMiddleware);
startSyncLoop();
startServerTracker();
startPlayingWatch();
startWarconSync(pushMemberStats);
startProgressSync();
startDiscordBot();
startCheatWatch();
startCleanup();
startStreamWatch();
startKeepAwake();
setInterval(() => {
  store.prune().catch(() => {});
  q("DELETE FROM remember_tokens WHERE last_used < now() - interval '120 days'").catch(() => {});
}, 6 * 60 * 60 * 1000);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[WPG] ${signal} received, saving and shutting down…`);
  server.close();
  await closeDb().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WPG] Barracks online at http://localhost:${PORT}`);
  if (!process.env.STEAM_API_KEY) console.log('[WPG] STEAM_API_KEY not set: Steam names/avatars/playtime will not sync.');
  if (process.env.DEV_LOGIN === 'true') console.log('[WPG] DEV_LOGIN is ON (test logins without Steam). Turn it off before going live.');
});
