import session from 'express-session';
import { q, one } from './db.js';

export const ROLE_LEVEL = { member: 1, mod: 2, admin: 3 };
export const roleAtLeast = (role, min) => (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[min] || 99);

export class PgSessionStore extends session.Store {
  get(sid, cb) {
    one('SELECT sess FROM sessions WHERE sid=$1 AND expire > now()', [sid])
      .then((row) => cb(null, row ? row.sess : null))
      .catch(cb);
  }
  set(sid, sess, cb) {
    const expire = new Date(sess.cookie?.expires || Date.now() + 30 * 864e5);
    q(
      `INSERT INTO sessions (sid, sess, expire) VALUES ($1,$2,$3)
       ON CONFLICT (sid) DO UPDATE SET sess=EXCLUDED.sess, expire=EXCLUDED.expire`,
      [sid, JSON.stringify(sess), expire],
    )
      .then(() => cb?.(null))
      .catch((e) => cb?.(e));
  }
  destroy(sid, cb) {
    q('DELETE FROM sessions WHERE sid=$1', [sid]).then(() => cb?.(null)).catch((e) => cb?.(e));
  }
  touch(sid, sess, cb) {
    const expire = new Date(sess.cookie?.expires || Date.now() + 30 * 864e5);
    q('UPDATE sessions SET expire=$2 WHERE sid=$1', [sid, expire]).then(() => cb?.(null)).catch((e) => cb?.(e));
  }
  prune() {
    return q('DELETE FROM sessions WHERE expire < now()');
  }
}

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function loadUser(req) {
  if (!req.session?.userId) return null;
  return one('SELECT * FROM users WHERE id=$1', [req.session.userId]);
}

// Any signed-in account (including pending ones waiting for approval).
export async function signedIn(req, _res, next) {
  const user = await loadUser(req);
  if (!user) throw new HttpError(401, 'Please sign in with Steam.', 'signed_out');
  if (user.status === 'banned') throw new HttpError(403, 'This account has been banned.', 'banned');
  req.user = user;
  next();
}

// Approved members only.
export async function member(req, res, next) {
  await signedIn(req, res, () => {});
  if (req.user.status !== 'active') throw new HttpError(403, 'Your account is waiting for approval.', 'pending');
  next();
}

export function role(min) {
  return async (req, res, next) => {
    await member(req, res, () => {});
    if (!roleAtLeast(req.user.role, min)) throw new HttpError(403, 'You do not have permission to do that.');
    next();
  };
}

export function str(v, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}
export function int(v, fallback = 0) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
export function bool(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
}
export function color(v, fallback = '#29b6f6') {
  return /^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : fallback;
}
export function safeUrl(v) {
  const s = str(v, 1000);
  if (!s) return '';
  if (s.startsWith('/')) return s.startsWith('//') ? '' : s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

// Public shape of a user, safe to send to other members.
export function publicUser(u, rank) {
  if (!u) return null;
  return {
    id: u.id,
    steam_id: u.steam_id,
    name: u.persona_name,
    callsign: u.callsign,
    avatar: u.custom_avatar || u.avatar,
    profile_url: u.profile_url,
    bio: u.bio,
    country: u.country,
    banner_color: u.banner_color,
    role: u.role,
    status: u.status,
    xp: u.xp,
    rank_id: u.rank_id,
    rank: rank || null,
    custom_fields: u.custom_fields || {},
    joined_at: u.joined_at,
    last_seen: u.last_seen,
    last_sync: u.last_sync,
    steam_private: u.steam_private,
  };
}
