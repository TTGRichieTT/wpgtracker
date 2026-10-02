// Chat in streams as yourself: members sign in with their own Twitch or Kick account, then chat in that
// platform's streams from the app. There is no bot: every message is sent with the member's own account,
// so anyone who wants to talk in a stream needs an account on that streamer's platform.
//  - Reading Twitch chat: the browser connects to Twitch's public chat itself (no sign-in needed to read).
//  - Reading Kick chat: Kick sends every chat message to /hooks/kick (a webhook); the app passes them on live.
//    Set the webhook address in the Kick app settings (Command panel → Streams shows it).
//  - YouTube keeps YouTube's own chat box (viewers sign in to Google inside it).
// Sign-in tokens are encrypted (secretbox.js), only used here on the server, and never sent to a browser.
import crypto from 'node:crypto';
import express from 'express';
import { q, one, audit } from './db.js';
import { bus } from './bus.js';
import { seal, open } from './secretbox.js';
import { env, getJson, appToken } from './streams.js';
import { HttpError, member, role, str } from './util.js';

export const chatAuth = express.Router(); // /auth/twitch/…, /auth/kick/…
export const streamChat = express.Router(); // /api/…
export const kickHook = express.Router(); // /hooks/kick (needs the raw body, so it goes before the JSON parser)

const site = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const redirectUri = (req, platform) => `${site(req)}/auth/${platform}/return`;

async function call(url, { method = 'GET', token, clientId, form, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (clientId) headers['Client-Id'] = clientId;
  let body;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form); }
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, ok: res.ok, data };
}

const PLATFORMS = {
  twitch: {
    name: 'Twitch',
    id: () => env('TWITCH_CLIENT_ID'),
    secret: () => env('TWITCH_CLIENT_SECRET'),
    authorize: 'https://id.twitch.tv/oauth2/authorize',
    token: 'https://id.twitch.tv/oauth2/token',
    scope: 'user:write:chat',
    async me(token) {
      const r = await call('https://api.twitch.tv/helix/users', { token, clientId: this.id() });
      const u = r.data?.data?.[0];
      if (!u) throw new Error(`Twitch answered ${r.status}`);
      return { id: String(u.id), login: u.login, name: u.display_name || u.login };
    },
    revoke(token) {
      return call('https://id.twitch.tv/oauth2/revoke', { method: 'POST', form: { client_id: this.id(), token } });
    },
    async send(token, login, stream, message) {
      const r = await call('https://api.twitch.tv/helix/chat/messages', {
        method: 'POST', token, clientId: this.id(), json: { broadcaster_id: stream.channel_id, sender_id: login.platform_user_id, message },
      });
      if (r.status === 401) return { auth: false };
      const sent = r.data?.data?.[0];
      if (r.ok && sent?.is_sent) return { ok: true };
      return { ok: false, reason: sent?.drop_reason?.message || r.data?.message || `Twitch answered ${r.status}` };
    },
  },
  kick: {
    name: 'Kick',
    id: () => env('KICK_CLIENT_ID'),
    secret: () => env('KICK_CLIENT_SECRET'),
    authorize: 'https://id.kick.com/oauth/authorize',
    token: 'https://id.kick.com/oauth/token',
    scope: 'user:read chat:write',
    pkce: true,
    async me(token) {
      const r = await call('https://api.kick.com/public/v1/users', { token });
      const u = r.data?.data?.[0];
      if (!u) throw new Error(`Kick answered ${r.status}`);
      return { id: String(u.user_id), login: String(u.name || ''), name: String(u.name || '') };
    },
    revoke(token) {
      return call(`https://id.kick.com/oauth/revoke?token=${encodeURIComponent(token)}&token_hint_type=access_token`, { method: 'POST' });
    },
    async send(token, _login, stream, message) {
      const r = await call('https://api.kick.com/public/v1/chat', {
        method: 'POST', token, json: { broadcaster_user_id: Number(stream.channel_id), content: message, type: 'user' },
      });
      if (r.status === 401) return { auth: false };
      if (r.ok && r.data?.data?.is_sent !== false) return { ok: true, id: r.data?.data?.message_id };
      return { ok: false, reason: r.data?.message || `Kick answered ${r.status}` };
    },
  },
};
const ready = (p) => !!(PLATFORMS[p]?.id() && PLATFORMS[p]?.secret());

// ---------- Sign in with Twitch / Kick ----------
const RETURN_OK = /^#\/(streams\/\d+|profile\/edit)$/;
const b64url = (buf) => buf.toString('base64url');

chatAuth.get('/auth/:platform/start', async (req, res, next) => {
  const platform = req.params.platform;
  const p = PLATFORMS[platform];
  if (!p) return next();
  const ret = RETURN_OK.test(String(req.query.return || '')) ? String(req.query.return) : '#/profile/edit';
  const user = req.session?.userId ? await one('SELECT id, status FROM users WHERE id=$1', [req.session.userId]) : null;
  if (!user || user.status !== 'active') return res.redirect('/#/');
  if (!ready(platform)) return res.redirect(`/${ret}?signin=setup&p=${platform}`);
  const state = b64url(crypto.randomBytes(24));
  const verifier = p.pkce ? b64url(crypto.randomBytes(48)) : '';
  req.session.chatOauth = { platform, state, verifier, ret, at: Date.now() };
  const url = new URL(p.authorize);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: p.id(), redirect_uri: redirectUri(req, platform), scope: p.scope, state,
    ...(p.pkce ? { code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' } : {}),
  }).toString();
  res.redirect(url.toString());
});

chatAuth.get('/auth/:platform/return', async (req, res, next) => {
  const platform = req.params.platform;
  const p = PLATFORMS[platform];
  if (!p) return next();
  const o = req.session?.chatOauth;
  delete req.session.chatOauth;
  const ret = o?.ret || '#/profile/edit';
  const back = (result) => res.redirect(`/${ret}?signin=${result}&p=${platform}`);
  const userId = req.session?.userId;
  if (!userId || !o || o.platform !== platform || o.state !== req.query.state || Date.now() - o.at > 15 * 60 * 1000) return back('expired');
  if (req.query.error || !req.query.code) return back('cancelled');
  try {
    const t = await call(p.token, {
      method: 'POST',
      form: {
        grant_type: 'authorization_code', code: String(req.query.code), client_id: p.id(), client_secret: p.secret(),
        redirect_uri: redirectUri(req, platform), ...(o.verifier ? { code_verifier: o.verifier } : {}),
      },
    });
    if (!t.ok || !t.data?.access_token) throw new Error(`${p.name} sign-in answered ${t.status}`);
    const me = await p.me(t.data.access_token);
    // One member per platform account: signing in here moves it off any other member.
    await q('DELETE FROM chat_logins WHERE platform=$1 AND platform_user_id=$2 AND user_id<>$3', [platform, me.id, userId]);
    await q(
      `INSERT INTO chat_logins (user_id, platform, platform_user_id, login, display_name, access_enc, refresh_enc, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, platform) DO UPDATE SET platform_user_id=EXCLUDED.platform_user_id, login=EXCLUDED.login,
         display_name=EXCLUDED.display_name, access_enc=EXCLUDED.access_enc, refresh_enc=EXCLUDED.refresh_enc, expires_at=EXCLUDED.expires_at`,
      [userId, platform, me.id, str(me.login, 60), str(me.name, 60), await seal(t.data.access_token), await seal(t.data.refresh_token || ''),
        t.data.expires_in ? new Date(Date.now() + Number(t.data.expires_in) * 1000) : null],
    );
    await audit(userId, 'chatlogin.link', `${platform}:${me.login}`);
    back('ok');
  } catch (e) {
    console.warn(`[stream chat] ${platform} sign-in failed:`, e.message);
    back('failed');
  }
});

// A working token for a member, renewed when it has run out. null = they need to sign in (again).
async function memberToken(userId, platform, { force = false } = {}) {
  const row = await one('SELECT * FROM chat_logins WHERE user_id=$1 AND platform=$2', [userId, platform]);
  if (!row) return null;
  const fresh = row.expires_at ? new Date(row.expires_at).getTime() - Date.now() > 60 * 1000 : true;
  if (fresh && !force) return { row, token: await open(row.access_enc) };
  const p = PLATFORMS[platform];
  const refresh = await open(row.refresh_enc);
  const t = refresh ? await call(p.token, {
    method: 'POST', form: { grant_type: 'refresh_token', refresh_token: refresh, client_id: p.id(), client_secret: p.secret() },
  }).catch(() => null) : null;
  if (!t?.ok || !t.data?.access_token) {
    if (t && t.status >= 400 && t.status < 500) await q('DELETE FROM chat_logins WHERE user_id=$1 AND platform=$2', [userId, platform]);
    return null;
  }
  await q('UPDATE chat_logins SET access_enc=$3, refresh_enc=$4, expires_at=$5 WHERE user_id=$1 AND platform=$2', [
    userId, platform, await seal(t.data.access_token), await seal(t.data.refresh_token || refresh),
    t.data.expires_in ? new Date(Date.now() + Number(t.data.expires_in) * 1000) : null,
  ]);
  return { row, token: t.data.access_token };
}

streamChat.get('/me/chat-logins', member, async (req, res) => {
  const rows = await q('SELECT platform, login, display_name, created_at FROM chat_logins WHERE user_id=$1', [req.user.id]);
  res.json({ logins: rows, available: { twitch: ready('twitch'), kick: ready('kick') } });
});

streamChat.delete('/me/chat-logins/:platform', member, async (req, res) => {
  const platform = req.params.platform;
  if (!PLATFORMS[platform]) throw new HttpError(404, 'Unknown platform.');
  const row = await one('DELETE FROM chat_logins WHERE user_id=$1 AND platform=$2 RETURNING access_enc, login', [req.user.id, platform]);
  if (row) {
    const token = await open(row.access_enc);
    if (token) PLATFORMS[platform].revoke(token).catch(() => {}); // tell the platform too, so the app's access ends there
    await audit(req.user.id, 'chatlogin.unlink', `${platform}:${row.login}`);
  }
  res.json({ ok: true });
});

// ---------- Send a chat message as me ----------
const lastSent = new Map(); // user id -> time, max one message a second
streamChat.post('/streams/:id/platform-chat', member, async (req, res) => {
  if (req.user.muted_until && new Date(req.user.muted_until) > new Date()) {
    throw new HttpError(403, `You are muted until ${new Date(req.user.muted_until).toLocaleString('en-GB')}.`);
  }
  const stream = await one(`SELECT sa.* FROM stream_accounts sa JOIN users u ON u.id = sa.user_id
    WHERE sa.id=$1 AND sa.status='approved' AND u.status='active'`, [Number(req.params.id) || 0]);
  const p = PLATFORMS[stream?.platform];
  if (!stream || !p) throw new HttpError(404, 'Stream not found.');
  const message = str(req.body?.body, 500);
  if (!message) throw new HttpError(400, 'Message is empty.');
  if (Date.now() - (lastSent.get(req.user.id) || 0) < 1000) throw new HttpError(429, 'Slow down a little.');
  lastSent.set(req.user.id, Date.now());
  let t = await memberToken(req.user.id, stream.platform);
  if (!t) throw new HttpError(400, `Sign in with ${p.name} to chat here.`, 'chat_signin');
  if (!stream.channel_id) throw new HttpError(400, `The app is still looking this ${p.name} channel up. Try again in a couple of minutes.`);
  let r = await p.send(t.token, t.row, stream, message);
  if (r.auth === false) {
    t = await memberToken(req.user.id, stream.platform, { force: true });
    r = t ? await p.send(t.token, t.row, stream, message) : { auth: false };
    if (r.auth === false) {
      await q('DELETE FROM chat_logins WHERE user_id=$1 AND platform=$2', [req.user.id, stream.platform]);
      throw new HttpError(400, `Your ${p.name} sign-in has ended. Sign in again to chat.`, 'chat_signin');
    }
  }
  if (!r.ok) throw new HttpError(400, `${p.name} didn't send it: ${r.reason}`);
  // Kick: show it straight away (the webhook copy, if it comes, has the same id and is skipped).
  if (stream.platform === 'kick') {
    pushKick(stream.channel_id, {
      id: String(r.id || `local-${Date.now()}`), user: t.row.display_name || t.row.login, color: '', text: message, at: new Date().toISOString(),
    });
  }
  res.json({ ok: true });
});

// ---------- Kick chat (webhook) ----------
const KICK_KEEP = 50;
const kickRecent = new Map(); // Kick user id of the streamer -> last messages
const kickSeen = new Map(); // message id -> time (Kick may send the same message twice)
let kickLastMessageAt = null;
function pushKick(channelId, msg) {
  if (kickSeen.has(msg.id)) return;
  kickSeen.set(msg.id, Date.now());
  if (kickSeen.size > 5000) for (const [k] of [...kickSeen].slice(0, 1000)) kickSeen.delete(k);
  const list = kickRecent.get(channelId) || [];
  list.push(msg);
  if (list.length > KICK_KEEP) list.splice(0, list.length - KICK_KEEP);
  kickRecent.set(channelId, list);
  bus.emit('platform:chat', { platform: 'kick', channel: channelId, message: msg });
}

// Kick signs each webhook with its private key; check it against Kick's public key.
let kickKey = null;
async function kickPublicKey() {
  if (!kickKey || Date.now() - kickKey.at > 24 * 3600e3) {
    const d = await getJson('https://api.kick.com/public/v1/public-key');
    kickKey = { pem: d?.data?.public_key, at: Date.now() };
  }
  return kickKey.pem;
}
async function kickSignedOk(req, raw) {
  const id = req.get('Kick-Event-Message-Id');
  const ts = req.get('Kick-Event-Message-Timestamp');
  const sig = req.get('Kick-Event-Signature');
  if (!id || !ts || !sig) return false;
  try {
    const pem = await kickPublicKey();
    return !!pem && crypto.verify('RSA-SHA256', Buffer.from(`${id}.${ts}.${raw}`), pem, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

kickHook.post('/hooks/kick', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!(await kickSignedOk(req, raw))) return res.status(401).end();
  res.status(200).end();
  if (req.get('Kick-Event-Type') !== 'chat.message.sent') return;
  try {
    const d = JSON.parse(raw);
    const channel = String(d.broadcaster?.user_id || '');
    if (!channel) return;
    kickLastMessageAt = new Date().toISOString();
    pushKick(channel, {
      id: String(d.message_id || `${channel}-${Date.now()}`),
      user: String(d.sender?.username || 'someone').slice(0, 60),
      color: /^#[0-9a-f]{6}$/i.test(d.sender?.identity?.username_color || '') ? d.sender.identity.username_color : '',
      text: String(d.content || '').slice(0, 1000),
      at: d.created_at || new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[stream chat] bad Kick webhook:', e.message);
  }
});

// Ask Kick to send chat for every approved Kick streamer (the live checker hands over their ids).
const kickSubbed = new Set();
let kickSubProblem = '';
let kickSubCheckedAt = 0;
bus.on('kick:channels', async (ids) => {
  const want = ids.filter((id) => !kickSubbed.has(id));
  if (!want.length && Date.now() - kickSubCheckedAt < 6 * 3600e3) return;
  kickSubCheckedAt = Date.now();
  try {
    const token = await appToken('kick', 'https://id.kick.com/oauth/token', env('KICK_CLIENT_ID'), env('KICK_CLIENT_SECRET'));
    const have = await call('https://api.kick.com/public/v1/events/subscriptions', { token });
    if (!have.ok) throw new Error(`Kick answered ${have.status} listing webhooks`);
    for (const s of have.data?.data || []) if (s.event === 'chat.message.sent') kickSubbed.add(String(s.broadcaster_user_id));
    for (const id of ids.filter((x) => !kickSubbed.has(x))) {
      const r = await call('https://api.kick.com/public/v1/events/subscriptions', {
        method: 'POST', token, json: { broadcaster_user_id: Number(id), events: [{ name: 'chat.message.sent', version: 1 }], method: 'webhook' },
      });
      if (!r.ok) throw new Error(`Kick answered ${r.status}${r.data?.message ? `: ${r.data.message}` : ''} adding a chat webhook`);
      kickSubbed.add(id);
    }
    kickSubProblem = '';
  } catch (e) {
    kickSubProblem = e.message;
    console.warn('[stream chat] Kick chat webhooks:', e.message);
  }
});

// Recent Kick chat for a stream page (Twitch chat is read by the browser itself).
streamChat.get('/streams/:id/platform-chat', member, async (req, res) => {
  const s = await one("SELECT platform, channel_id FROM stream_accounts WHERE id=$1 AND status='approved'", [Number(req.params.id) || 0]);
  if (!s) throw new HttpError(404, 'Stream not found.');
  res.json({ messages: s.platform === 'kick' ? kickRecent.get(s.channel_id) || [] : [], reading: s.platform !== 'kick' || kickSubbed.has(s.channel_id) });
});

// ---------- Staff: what to put in the Twitch and Kick developer settings ----------
streamChat.get('/admin/stream-chat', role('mod'), async (req, res) => {
  res.json({
    twitch: { ready: ready('twitch'), redirect: redirectUri(req, 'twitch') },
    kick: {
      ready: ready('kick'), redirect: redirectUri(req, 'kick'), webhook: `${site(req)}/hooks/kick`,
      channels_reading: kickSubbed.size, last_message_at: kickLastMessageAt, problem: kickSubProblem,
    },
  });
});
