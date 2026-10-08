// Streams: members who stream on Twitch, YouTube or Kick link their channel, staff approve it,
// and the Streams tab shows who is live with the stream's own player and chat plus a WPG chat underneath.
//  - Live checks every 90 seconds, using each platform's API (keys in Render, see README):
//      Twitch  TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET
//      YouTube YOUTUBE_API_KEY
//      Kick    KICK_CLIENT_ID + KICK_CLIENT_SECRET
//    When the checker for a platform isn't set up, streamers press "I'm live" instead.
//  - Stream keys are encrypted and write-only: no route ever sends one (or any part of one) back out.
import express from 'express';
import { q, one, audit } from './db.js';
import { bus } from './bus.js';
import { seal } from './secretbox.js';
import { usersWithRanks } from './routes.js';
import { HttpError, member, role, roleAtLeast, str, int } from './util.js';

export const streams = express.Router();

export const PLATFORMS = {
  twitch: { name: 'Twitch', channel: (h) => `https://www.twitch.tv/${h}` },
  youtube: { name: 'YouTube', channel: (h, cid) => (h.startsWith('@') ? `https://www.youtube.com/${h}` : `https://www.youtube.com/channel/${cid || h}`) },
  kick: { name: 'Kick', channel: (h) => `https://kick.com/${h}` },
};
export const env = (k) => String(process.env[k] || '').trim();
const AUTO = {
  twitch: () => !!(env('TWITCH_CLIENT_ID') && env('TWITCH_CLIENT_SECRET')),
  youtube: () => !!env('YOUTUBE_API_KEY'),
  kick: () => !!(env('KICK_CLIENT_ID') && env('KICK_CLIENT_SECRET')),
};

const POLL_MS = 90 * 1000;
const MISSES_TO_END = 2; // a stream must be missing from two checks in a row before it counts as ended
const MANUAL_HOURS = 12; // "I'm live" switches itself off after this long
const ANNOUNCE_GAP_MS = 30 * 60 * 1000; // no second Discord post if they drop and come back within this

// ---------- Channel names and links ----------
function urlPath(v, hosts) {
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    const host = u.hostname.replace(/^(www|m|mobile)\./, '');
    return hosts.includes(host) ? u : null;
  } catch {
    return null;
  }
}

// Turns whatever the member typed (name or link) into the channel name we store. Throws if it isn't one.
export function cleanHandle(platform, raw) {
  let v = str(raw, 300).replace(/\s+/g, '');
  const bad = (msg) => { throw new HttpError(400, msg); };
  if (!v) bad('Type your channel name or paste its link.');
  if (platform === 'twitch' || platform === 'kick') {
    const u = /[./]/.test(v) ? urlPath(v, platform === 'twitch' ? ['twitch.tv'] : ['kick.com']) : null;
    if (u) v = u.pathname.split('/').filter(Boolean)[0] || '';
    v = v.replace(/^@/, '').toLowerCase();
    const ok = platform === 'twitch' ? /^[a-z0-9_]{3,25}$/ : /^[a-z0-9_-]{3,30}$/;
    if (!ok.test(v)) bad(`That doesn't look like a ${PLATFORMS[platform].name} channel name.`);
    return v;
  }
  if (platform === 'youtube') {
    const u = /[./]/.test(v) ? urlPath(v, ['youtube.com']) : null;
    if (u) {
      const [a, b] = u.pathname.split('/').filter(Boolean);
      v = a === 'channel' ? b || '' : a || '';
    }
    if (/^UC[\w-]{22}$/.test(v)) return v;
    if (!v.startsWith('@')) v = `@${v}`;
    if (!/^@[\w.-]{3,30}$/.test(v)) bad('Use your YouTube @handle (like @WPGRichie) or your channel link.');
    return v;
  }
  bad('Unknown platform.');
}

// "I'm live" links. Returns what to store, or throws.
function cleanLiveLink(platform, raw) {
  const v = str(raw, 500);
  if (platform === 'youtube') {
    if (!v) return { live_url: '', video_id: '' }; // the player can still find the live stream from the channel
    const u = urlPath(v, ['youtube.com', 'youtu.be']);
    let id = '';
    if (u?.hostname.endsWith('youtu.be')) id = u.pathname.slice(1);
    else if (u) id = u.searchParams.get('v') || (/^\/(live|embed|shorts)\/([\w-]{11})/.exec(u.pathname)?.[2] ?? '');
    if (!/^[\w-]{11}$/.test(id)) throw new HttpError(400, 'Paste the link to your YouTube live video (youtube.com/watch?v=… or youtube.com/live/…).');
    return { live_url: '', video_id: id };
  }
  return { live_url: '', video_id: '' };
}

// ---------- Stream keys ----------
// Encrypted with seal() (secretbox.js) and write-only: nothing ever opens them or sends them back out.

// ---------- What the browser gets ----------
// Never includes stream_key_enc.
const PUBLIC_COLS = `sa.id, sa.user_id, sa.platform, sa.handle, sa.channel_id, sa.status, sa.is_live, sa.manual, sa.title, sa.game,
  sa.viewers, sa.thumbnail, sa.video_id, sa.live_url, sa.live_since, sa.last_checked, sa.created_at,
  (sa.stream_key_enc <> '') AS key_saved, sa.key_set_at`;

async function withUsers(rows) {
  const ids = [...new Set(rows.map((r) => r.user_id))];
  const users = ids.length ? await usersWithRanks(await q('SELECT * FROM users WHERE id = ANY($1)', [ids])) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => streamOut(r, byId.get(r.user_id)));
}
function streamOut(r, user) {
  const p = PLATFORMS[r.platform];
  return {
    id: r.id,
    platform: r.platform,
    platform_name: p?.name || r.platform,
    handle: r.handle,
    channel_id: r.channel_id,
    channel_url: p ? p.channel(r.handle, r.channel_id) : '',
    status: r.status,
    is_live: r.is_live,
    manual: r.manual,
    title: r.title,
    game: r.game,
    viewers: r.viewers,
    thumbnail: r.thumbnail,
    video_id: r.video_id,
    live_url: r.live_url,
    live_since: r.live_since,
    user: user || null,
  };
}
const platformsOut = () => Object.fromEntries(Object.entries(PLATFORMS).map(([k, p]) => [k, { name: p.name, auto: AUTO[k]() }]));

let liveCount = 0;
export const liveStreamCount = () => liveCount;
async function changed() {
  const r = await one(`SELECT COUNT(DISTINCT sa.user_id)::int AS n FROM stream_accounts sa JOIN users u ON u.id = sa.user_id
    WHERE sa.status='approved' AND sa.is_live AND u.status='active'`);
  liveCount = r?.n || 0;
  bus.emit('streams:changed', liveCount);
}

// ---------- Live checks ----------
export async function getJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const err = new Error(`${new URL(url).hostname} answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// App sign-in for Twitch and Kick (client credentials), kept until shortly before it runs out.
const tokens = {};
export async function appToken(name, url, id, secret) {
  const t = tokens[name];
  if (t && t.exp > Date.now()) return t.value;
  const d = await getJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
  });
  tokens[name] = { value: d.access_token, exp: Date.now() + Math.max(60, (Number(d.expires_in) || 3600) - 300) * 1000 };
  return d.access_token;
}

// Each checker returns Map(account id -> live details) for the accounts it could check, or null if it can't check.
const CHECK = {
  async twitch(rows) {
    if (!AUTO.twitch()) return null;
    const id = env('TWITCH_CLIENT_ID');
    const call = async (url) => {
      const token = await appToken('twitch', 'https://id.twitch.tv/oauth2/token', id, env('TWITCH_CLIENT_SECRET'));
      return getJson(url, { headers: { 'Client-Id': id, Authorization: `Bearer ${token}` } });
    };
    const live = new Map();
    for (const part of chunks(rows, 100)) {
      const url = `https://api.twitch.tv/helix/streams?first=100&${part.map((r) => `user_login=${encodeURIComponent(r.handle)}`).join('&')}`;
      let d;
      try {
        d = await call(url);
      } catch (e) {
        if (e.status !== 401) throw e;
        delete tokens.twitch; // token withdrawn early: get a new one and try once more
        d = await call(url);
      }
      const byLogin = new Map((d.data || []).filter((s) => s.type === 'live').map((s) => [String(s.user_login).toLowerCase(), s]));
      for (const r of part) {
        const s = byLogin.get(r.handle);
        if (s) {
          live.set(r.id, {
            title: s.title, game: s.game_name, viewers: s.viewer_count, live_since: s.started_at, ref: String(s.id || s.started_at || ''),
            thumbnail: String(s.thumbnail_url || '').replace('{width}', '640').replace('{height}', '360'),
          });
        }
      }
    }
    // Twitch account ids (sending chat needs them), looked up once per channel.
    const missing = rows.filter((r) => !r.channel_id);
    for (const part of chunks(missing, 100)) {
      const d = await call(`https://api.twitch.tv/helix/users?${part.map((r) => `login=${encodeURIComponent(r.handle)}`).join('&')}`);
      const byLogin = new Map((d.data || []).map((u) => [String(u.login).toLowerCase(), String(u.id)]));
      for (const r of part) {
        const uid = byLogin.get(r.handle);
        if (uid) { r.channel_id = uid; await q('UPDATE stream_accounts SET channel_id=$2 WHERE id=$1', [r.id, uid]); }
      }
    }
    return live;
  },

  // YouTube: each channel's public video feed (free) gives its latest videos, then one cheap API call
  // per 50 videos says which is live. (Search would use 100 quota units a time, so it isn't used.)
  async youtube(rows) {
    if (!AUTO.youtube()) return null;
    const key = env('YOUTUBE_API_KEY');
    const live = new Map();
    const videoOwner = new Map(); // video id -> account row
    for (const r of rows) {
      if (!r.channel_id) {
        const d = await getJson(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(r.handle)}&key=${key}`).catch(() => null);
        const cid = d?.items?.[0]?.id;
        if (!cid) continue;
        r.channel_id = cid;
        await q('UPDATE stream_accounts SET channel_id=$2 WHERE id=$1', [r.id, cid]);
      }
      const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(r.channel_id)}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
      const xml = res?.ok ? await res.text() : '';
      const ids = [...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map((m) => m[1]).slice(0, 5);
      if (r.is_live && r.video_id) ids.unshift(r.video_id); // keep checking the stream we already know about
      for (const v of ids) if (!videoOwner.has(v)) videoOwner.set(v, r);
    }
    for (const part of chunks([...videoOwner.keys()], 50)) {
      const d = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${part.join(',')}&key=${key}`);
      for (const v of d.items || []) {
        const r = videoOwner.get(v.id);
        if (!r || live.has(r.id) || v.snippet?.liveBroadcastContent !== 'live') continue;
        const th = v.snippet.thumbnails || {};
        live.set(r.id, {
          title: v.snippet.title, game: '', viewers: v.liveStreamingDetails?.concurrentViewers ?? null,
          live_since: v.liveStreamingDetails?.actualStartTime || null, thumbnail: (th.high || th.medium || th.default || {}).url || '', video_id: v.id, ref: v.id,
        });
      }
    }
    return live;
  },

  async kick(rows) {
    if (!AUTO.kick()) return null;
    const token = await appToken('kick', 'https://id.kick.com/oauth/token', env('KICK_CLIENT_ID'), env('KICK_CLIENT_SECRET'));
    const live = new Map();
    for (const part of chunks(rows, 50)) {
      const d = await getJson(`https://api.kick.com/public/v1/channels?${part.map((r) => `slug=${encodeURIComponent(r.handle)}`).join('&')}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch((e) => { if (e.status === 401) delete tokens.kick; throw e; });
      const bySlug = new Map((d.data || []).map((c) => [String(c.slug).toLowerCase(), c]));
      for (const r of part) {
        const c = bySlug.get(r.handle);
        // Kick account id: sending and reading chat need it.
        const uid = c?.broadcaster_user_id ? String(c.broadcaster_user_id) : '';
        if (uid && uid !== r.channel_id) { r.channel_id = uid; await q('UPDATE stream_accounts SET channel_id=$2 WHERE id=$1', [r.id, uid]); }
        const s = c?.stream;
        if (s?.is_live) {
          live.set(r.id, {
            title: c.stream_title || '', game: c.category?.name || '', viewers: s.viewer_count ?? null,
            live_since: s.start_time && !String(s.start_time).startsWith('0001') ? s.start_time : null,
            ref: String(s.start_time || ''),
            thumbnail: typeof s.thumbnail === 'string' ? s.thumbnail : s.thumbnail?.url || '',
          });
        }
      }
    }
    bus.emit('kick:channels', rows.filter((r) => r.channel_id).map((r) => r.channel_id));
    return live;
  },
};

const misses = new Map(); // account id -> checks in a row it wasn't found live

// ---------- Verified stream history (stream_sessions) ----------
// Only streams the platform's API says are live are recorded. The same stream (same platform id), or a reconnect
// within RECONNECT_MS of the last sighting, carries on the same row, so restarts and bot restarts never add a
// second stream or count time twice. The start is the platform's own start time where it gives one.
const RECONNECT_MS = 10 * 60 * 1000;
async function seenLive(r, s) {
  const ref = String(s.ref || '').slice(0, 120);
  const open = await one(
    `SELECT id FROM stream_sessions WHERE account_id=$1 AND ((stream_ref <> '' AND stream_ref=$2) OR last_seen_at > now() - $3 * interval '1 millisecond')
      ORDER BY last_seen_at DESC LIMIT 1`,
    [r.id, ref, RECONNECT_MS],
  );
  if (open) {
    await q('UPDATE stream_sessions SET last_seen_at=now(), ended_at=NULL WHERE id=$1', [open.id]);
    return;
  }
  const since = s.live_since && !Number.isNaN(Date.parse(s.live_since)) ? new Date(s.live_since) : new Date();
  // A start time from the platform, but never earlier than 24h before we first saw it (bad data guard).
  const start = new Date(Math.min(Date.now(), Math.max(since.getTime(), Date.now() - 24 * 3600e3)));
  await q('INSERT INTO stream_sessions (user_id, account_id, platform, stream_ref, started_at, last_seen_at) VALUES ($1,$2,$3,$4,$5,now())',
    [r.user_id, r.id, r.platform, ref, start]);
}
async function seenEnded(r) {
  await q('UPDATE stream_sessions SET ended_at=last_seen_at WHERE account_id=$1 AND ended_at IS NULL', [r.id]);
  bus.emit('stats:changed', r.user_id); // streaming achievements
}
// After a restart: streams last seen a while ago are finished at their last sighting.
async function closeStaleSessions() {
  await q(`UPDATE stream_sessions SET ended_at=last_seen_at WHERE ended_at IS NULL AND last_seen_at < now() - $1 * interval '1 millisecond'`, [RECONNECT_MS]);
}
export const lastProblems = {}; // platform -> { at, message }

async function goneLive(r) {
  const fresh = !r.announced_at || Date.now() - new Date(r.announced_at).getTime() > ANNOUNCE_GAP_MS;
  if (!fresh) return;
  await q('UPDATE stream_accounts SET announced_at=now() WHERE id=$1', [r.id]);
  bus.emit('announce', { type: 'stream', accountId: r.id });
}

const https = (u) => (/^https:\/\//.test(String(u || '')) ? String(u).slice(0, 1000) : '');

export async function checkStreams() {
  const rows = await q(`SELECT sa.* FROM stream_accounts sa JOIN users u ON u.id = sa.user_id
    WHERE sa.status='approved' AND u.status='active'`);
  let any = false;
  // "I'm live" runs out after a while, in case the streamer forgets to switch it off.
  for (const r of rows.filter((x) => x.manual && x.is_live && x.live_since && Date.now() - new Date(x.live_since).getTime() > MANUAL_HOURS * 3600e3)) {
    await q("UPDATE stream_accounts SET is_live=false, manual=false, viewers=NULL, live_url='' WHERE id=$1", [r.id]);
    r.is_live = false;
    any = true;
  }
  for (const [platform, check] of Object.entries(CHECK)) {
    const mine = rows.filter((r) => r.platform === platform);
    if (!mine.length) continue;
    let live;
    try {
      live = await check(mine);
    } catch (e) {
      lastProblems[platform] = { at: new Date().toISOString(), message: e.message };
      console.warn(`[streams] ${platform} check failed:`, e.message);
      continue;
    }
    if (!live) continue;
    delete lastProblems[platform];
    for (const r of mine) {
      const s = live.get(r.id);
      if (s) {
        misses.delete(r.id);
        await q(
          `UPDATE stream_accounts SET is_live=true, manual=false, title=$2, game=$3, viewers=$4, thumbnail=$5,
             live_since=COALESCE($6::timestamptz, CASE WHEN is_live THEN live_since ELSE now() END),
             video_id=CASE WHEN $7 = '' THEN video_id ELSE $7 END, last_checked=now() WHERE id=$1`,
          [r.id, str(s.title, 300), str(s.game, 120), s.viewers === null || s.viewers === undefined ? null : int(s.viewers), https(s.thumbnail), s.live_since || null, s.video_id || ''],
        );
        await seenLive(r, s).catch((e) => console.warn('[streams] history', e.message));
        if (!r.is_live) { any = true; await goneLive(r); }
        else if (Number(r.viewers) !== Number(s.viewers) || r.title !== s.title) any = true;
      } else if (r.is_live && !r.manual) {
        const n = (misses.get(r.id) || 0) + 1;
        misses.set(r.id, n);
        if (n >= MISSES_TO_END) {
          misses.delete(r.id);
          await q("UPDATE stream_accounts SET is_live=false, viewers=NULL, video_id='', last_checked=now() WHERE id=$1", [r.id]);
          await seenEnded(r).catch(() => {});
          any = true;
        }
      } else {
        await q('UPDATE stream_accounts SET last_checked=now() WHERE id=$1', [r.id]);
      }
    }
  }
  if (any) await changed();
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await closeStaleSessions(); await checkStreams(); } catch (e) { console.warn('[streams] check failed:', e.message); } finally { running = false; }
}
export function startStreamWatch() {
  // Facebook was dropped (it can't be checked and its chat can't be used from other apps).
  q("DELETE FROM stream_accounts WHERE platform NOT IN ('twitch','youtube','kick')").then(changed).catch(() => {});
  setTimeout(tick, 20 * 1000);
  setInterval(tick, POLL_MS);
  const on = Object.keys(AUTO).filter((k) => AUTO[k]());
  console.log(`[streams] live checks: ${on.length ? on.join(', ') : 'none (no platform keys set) — streamers use "I\'m live"'}`);
}

// ---------- Routes: everyone (members) ----------
const LIVE_ORDER = 'sa.is_live DESC, sa.viewers DESC NULLS LAST, sa.live_since DESC NULLS LAST, sa.id';
streams.get('/streams', member, async (_req, res) => {
  const rows = await q(`SELECT ${PUBLIC_COLS} FROM stream_accounts sa JOIN users u ON u.id = sa.user_id
    WHERE sa.status='approved' AND u.status='active' ORDER BY ${LIVE_ORDER}`);
  res.json({ streams: await withUsers(rows), platforms: platformsOut() });
});

streams.get('/streams/:id', member, async (req, res) => {
  const r = await one(`SELECT ${PUBLIC_COLS} FROM stream_accounts sa JOIN users u ON u.id = sa.user_id
    WHERE sa.id=$1 AND sa.status='approved' AND u.status='active'`, [int(req.params.id)]);
  if (!r) throw new HttpError(404, 'Stream not found.');
  // The streamer's other channels, so viewers can switch platform.
  const others = await q(`SELECT ${PUBLIC_COLS} FROM stream_accounts sa WHERE sa.user_id=$1 AND sa.status='approved' AND sa.id<>$2 ORDER BY ${LIVE_ORDER}`, [r.user_id, r.id]);
  const [stream, ...rest] = await withUsers([r, ...others]);
  res.json({ stream, others: rest, platforms: platformsOut() });
});

// ---------- Routes: my channels ----------
const platformParam = (req) => {
  const p = String(req.params.platform || '').toLowerCase();
  if (!PLATFORMS[p]) throw new HttpError(404, 'Unknown platform.');
  return p;
};
async function myAccount(userId, platform) {
  return one(`SELECT ${PUBLIC_COLS} FROM stream_accounts sa WHERE sa.user_id=$1 AND sa.platform=$2`, [userId, platform]);
}

streams.get('/me/streams', member, async (req, res) => {
  const rows = await q(`SELECT ${PUBLIC_COLS} FROM stream_accounts sa WHERE sa.user_id=$1 ORDER BY sa.id`, [req.user.id]);
  res.json({
    accounts: rows.map((r) => ({ ...streamOut(r, null), key_saved: r.key_saved, key_set_at: r.key_set_at })),
    platforms: platformsOut(),
  });
});

// Link or change my channel on a platform. A new or changed channel waits for staff approval.
streams.put('/me/streams/:platform', member, async (req, res) => {
  const platform = platformParam(req);
  const handle = cleanHandle(platform, req.body?.handle);
  const taken = await one("SELECT id FROM stream_accounts WHERE platform=$1 AND handle=$2 AND user_id<>$3 AND status<>'rejected'", [platform, handle, req.user.id]);
  if (taken) throw new HttpError(400, 'Another member has already linked that channel. Ask staff if it is yours.');
  const old = await myAccount(req.user.id, platform);
  if (old && old.handle === handle) return res.json({ ok: true, status: old.status });
  await q(
    `INSERT INTO stream_accounts (user_id, platform, handle) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, platform) DO UPDATE SET handle=EXCLUDED.handle, channel_id='', status='pending',
       reviewed_by=NULL, reviewed_at=NULL, is_live=false, manual=false, title='', game='', viewers=NULL, thumbnail='',
       video_id='', live_url='', live_since=NULL`,
    [req.user.id, platform, handle],
  );
  await audit(req.user.id, 'stream.link', `${platform}:${handle}`);
  bus.emit('staff:notify', { title: 'Stream channel to approve', body: `${req.user.persona_name} linked ${PLATFORMS[platform].name}: ${handle}`, link: '#/admin/streams' });
  if (old?.is_live) await changed();
  res.json({ ok: true, status: 'pending' });
});

streams.delete('/me/streams/:platform', member, async (req, res) => {
  const platform = platformParam(req);
  const r = await one('DELETE FROM stream_accounts WHERE user_id=$1 AND platform=$2 RETURNING is_live', [req.user.id, platform]);
  await audit(req.user.id, 'stream.unlink', platform);
  if (r?.is_live) await changed();
  res.json({ ok: true });
});

// Save my stream key. It is encrypted straight away and can only be replaced or removed, never read back.
streams.put('/me/streams/:platform/key', member, async (req, res) => {
  const platform = platformParam(req);
  const key = String(req.body?.key ?? '').trim();
  if (!/^[\x21-\x7e]{8,300}$/.test(key)) throw new HttpError(400, 'That doesn\'t look like a stream key (no spaces, 8 characters or more).');
  if (!(await myAccount(req.user.id, platform))) throw new HttpError(400, `Link your ${PLATFORMS[platform].name} channel first.`);
  await q('UPDATE stream_accounts SET stream_key_enc=$3, key_set_at=now() WHERE user_id=$1 AND platform=$2', [req.user.id, platform, await seal(key)]);
  await audit(req.user.id, 'stream.key_saved', platform); // never the key itself
  res.json({ ok: true, key_saved: true });
});

streams.delete('/me/streams/:platform/key', member, async (req, res) => {
  const platform = platformParam(req);
  await q("UPDATE stream_accounts SET stream_key_enc='', key_set_at=NULL WHERE user_id=$1 AND platform=$2", [req.user.id, platform]);
  await audit(req.user.id, 'stream.key_removed', platform);
  res.json({ ok: true });
});

// "I'm live" (when the platform's checker isn't set up or hasn't spotted the stream yet).
streams.post('/me/streams/:platform/live', member, async (req, res) => {
  const platform = platformParam(req);
  const acc = await myAccount(req.user.id, platform);
  if (!acc) throw new HttpError(400, `Link your ${PLATFORMS[platform].name} channel first.`);
  if (acc.status !== 'approved') throw new HttpError(403, 'Staff need to approve this channel first.');
  const link = cleanLiveLink(platform, req.body?.url);
  const title = str(req.body?.title, 200);
  const r = await one(
    `UPDATE stream_accounts SET is_live=true, manual=true, live_since=now(), live_url=$3, video_id=$4,
       title=CASE WHEN $5 = '' THEN title ELSE $5 END, viewers=NULL WHERE user_id=$1 AND platform=$2 RETURNING *`,
    [req.user.id, platform, link.live_url, link.video_id, title],
  );
  if (!acc.is_live) await goneLive(r);
  await changed();
  res.json({ ok: true, id: r.id });
});

streams.delete('/me/streams/:platform/live', member, async (req, res) => {
  const platform = platformParam(req);
  await q("UPDATE stream_accounts SET is_live=false, manual=false, viewers=NULL, live_url='', video_id='' WHERE user_id=$1 AND platform=$2", [req.user.id, platform]);
  await changed();
  res.json({ ok: true });
});

// ---------- Routes: staff ----------
streams.get('/admin/streams', role('mod'), async (_req, res) => {
  const rows = await q(`SELECT ${PUBLIC_COLS}, sa.reviewed_at FROM stream_accounts sa
    ORDER BY (sa.status='pending') DESC, sa.created_at DESC`);
  res.json({ accounts: await withUsers(rows), platforms: platformsOut(), problems: lastProblems });
});

streams.post('/admin/streams/:id/:decision', role('mod'), async (req, res) => {
  const decision = { approve: 'approved', reject: 'rejected' }[req.params.decision];
  if (!decision) throw new HttpError(404, 'Not found');
  const r = await one(
    `UPDATE stream_accounts SET status=$2, reviewed_by=$3, reviewed_at=now(),
       is_live=CASE WHEN $2='approved' THEN is_live ELSE false END WHERE id=$1 RETURNING user_id, platform, handle`,
    [int(req.params.id), decision, req.user.id],
  );
  if (!r) throw new HttpError(404, 'Channel not found.');
  await audit(req.user.id, `stream.${req.params.decision}`, `${r.platform}:${r.handle}`, { user_id: r.user_id });
  bus.emit('notify', r.user_id, decision === 'approved'
    ? { title: 'Stream channel approved', body: `Your ${PLATFORMS[r.platform]?.name} channel now shows on the Streams tab.`, link: '#/streams' }
    : { title: 'Stream channel not approved', body: `Staff didn't approve your ${PLATFORMS[r.platform]?.name} channel. Ask a mod why.`, link: '#/profile/edit' });
  await changed();
  if (decision === 'approved') setTimeout(tick, 1000);
  res.json({ ok: true });
});

streams.delete('/admin/streams/:id', role('mod'), async (req, res) => {
  const r = await one('DELETE FROM stream_accounts WHERE id=$1 RETURNING user_id, platform, handle', [int(req.params.id)]);
  if (r) await audit(req.user.id, 'stream.remove', `${r.platform}:${r.handle}`, { user_id: r.user_id });
  await changed();
  res.json({ ok: true });
});

// ---------- WPG chat under a stream ----------
async function streamerOrThrow(id) {
  const s = await one(`SELECT DISTINCT sa.user_id FROM stream_accounts sa JOIN users u ON u.id = sa.user_id
    WHERE sa.user_id=$1 AND sa.status='approved' AND u.status='active'`, [id]);
  if (!s) throw new HttpError(404, 'Stream not found.');
  return s.user_id;
}

streams.get('/streams/chat/:streamerId', member, async (req, res) => {
  const sid = await streamerOrThrow(int(req.params.streamerId));
  const before = int(req.query.before, 2147483647);
  const msgs = await q(`SELECT id, streamer_id, user_id, body, created_at FROM stream_messages
    WHERE streamer_id=$1 AND id < $2 AND deleted=false ORDER BY id DESC LIMIT 60`, [sid, before]);
  const ids = [...new Set(msgs.map((m) => m.user_id).filter(Boolean))];
  const users = ids.length ? await usersWithRanks(await q('SELECT * FROM users WHERE id = ANY($1)', [ids])) : [];
  res.json({ messages: msgs.reverse(), users });
});

streams.post('/streams/chat/:streamerId', member, async (req, res) => {
  if (req.user.muted_until && new Date(req.user.muted_until) > new Date()) {
    throw new HttpError(403, `You are muted until ${new Date(req.user.muted_until).toLocaleString('en-GB')}.`);
  }
  const sid = await streamerOrThrow(int(req.params.streamerId));
  const body = str(req.body?.body, 500);
  if (!body) throw new HttpError(400, 'Message is empty.');
  const msg = await one('INSERT INTO stream_messages (streamer_id, user_id, body) VALUES ($1,$2,$3) RETURNING id, streamer_id, user_id, body, created_at', [sid, req.user.id, body]);
  bus.emit('stream:chat', msg);
  res.json(msg);
});

streams.delete('/streams/chat/messages/:id', member, async (req, res) => {
  const msg = await one('SELECT * FROM stream_messages WHERE id=$1', [int(req.params.id)]);
  if (!msg) throw new HttpError(404, 'Message not found.');
  const mine = msg.user_id === req.user.id || msg.streamer_id === req.user.id; // streamers can tidy their own chat
  if (!mine && !roleAtLeast(req.user.role, 'mod')) throw new HttpError(403, 'You can only delete your own messages.');
  await q('UPDATE stream_messages SET deleted=true WHERE id=$1', [msg.id]);
  bus.emit('stream:chat:deleted', { id: msg.id, streamer_id: msg.streamer_id });
  res.json({ ok: true });
});

// For the Discord post.
export async function streamForAnnounce(accountId) {
  const r = await one(`SELECT ${PUBLIC_COLS} FROM stream_accounts sa WHERE sa.id=$1 AND sa.status='approved'`, [accountId]);
  if (!r) return null;
  const u = await one('SELECT * FROM users WHERE id=$1', [r.user_id]);
  return { stream: streamOut(r, null), user: u };
}
