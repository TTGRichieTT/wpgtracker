import crypto from 'node:crypto';
import session from 'express-session';
import { q, one } from './db.js';

export const ROLE_LEVEL = { member: 1, mod: 2, admin: 3 };

// Main admins: always admin, always approved, and nobody can demote, ban or delete them.
// Add more by setting OWNER_STEAM_IDS in Replit Secrets (comma separated Steam IDs).
export const OWNER_IDS = new Set(
  (process.env.OWNER_STEAM_IDS || '76561198809535860').split(',').map((s) => s.trim()).filter((s) => /^\d{17}$/.test(s)),
);
export const isOwner = (u) => !!u && OWNER_IDS.has(u.steam_id);

// Made admin (and approved) when their account is first created. Unlike main admins they can be demoted later.
// Change with ADMIN_STEAM_IDS in Replit Secrets (comma separated Steam IDs).
export const START_ADMIN_IDS = new Set(
  (process.env.ADMIN_STEAM_IDS || '76561198099451925').split(',').map((s) => s.trim()).filter((s) => /^\d{17}$/.test(s)),
);
export const roleAtLeast = (role, min) => (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[min] || 99);
// Chat channels: role first; PMC guests only see channels opened to PMCs (staff see everything their role allows).
export const canSeeChannel = (user, ch) =>
  roleAtLeast(user.role, ch.min_role) && (user.membership !== 'pmc' || roleAtLeast(user.role, 'mod') || !!ch.pmc_access);

// Sign-ins are kept in the database (so they survive restarts) with a short in-memory copy, so most
// requests don't need a database trip just to know who you are. The "keep me signed in" time is
// pushed forward at most once an hour per person, not on every click.
const SESSION_CACHE_MS = 5 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
export class PgSessionStore extends session.Store {
  constructor() {
    super();
    this.cache = new Map(); // sid -> { sess, at }
    this.touched = new Map(); // sid -> last time the expiry was saved
  }
  get(sid, cb) {
    const hit = this.cache.get(sid);
    if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return cb(null, JSON.parse(hit.json));
    one('SELECT sess FROM sessions WHERE sid=$1 AND expire > now()', [sid])
      .then((row) => {
        if (row) this.cache.set(sid, { json: JSON.stringify(row.sess), at: Date.now() });
        else this.cache.delete(sid);
        cb(null, row ? row.sess : null);
      })
      .catch(cb);
  }
  set(sid, sess, cb) {
    const expire = new Date(sess.cookie?.expires || Date.now() + 30 * 864e5);
    const json = JSON.stringify(sess);
    this.cache.set(sid, { json, at: Date.now() });
    this.touched.set(sid, Date.now());
    if (this.cache.size > 5000) this.cache.clear();
    q(
      `INSERT INTO sessions (sid, sess, expire) VALUES ($1,$2,$3)
       ON CONFLICT (sid) DO UPDATE SET sess=EXCLUDED.sess, expire=EXCLUDED.expire`,
      [sid, json, expire],
    )
      .then(() => cb?.(null))
      .catch((e) => cb?.(e));
  }
  destroy(sid, cb) {
    this.cache.delete(sid);
    this.touched.delete(sid);
    q('DELETE FROM sessions WHERE sid=$1', [sid]).then(() => cb?.(null)).catch((e) => cb?.(e));
  }
  touch(sid, sess, cb) {
    if (Date.now() - (this.touched.get(sid) || 0) < TOUCH_EVERY_MS) return cb?.(null);
    this.touched.set(sid, Date.now());
    if (this.touched.size > 5000) this.touched.clear();
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

// In-game names can be made of invisible characters (format/tag characters, unassigned code points,
// blank "filler" letters). Strip those; a name with nothing visible left gets the fallback.
const FILLERS = String.fromCodePoint(0x115f, 0x1160, 0x2800, 0x3164, 0xffa0);
const INVISIBLE = new RegExp(`[\\p{Cf}\\p{Cc}\\p{Cn}\\p{Z}${FILLERS}]+`, 'gu');
export function cleanName(name, fallback = 'Unknown player') {
  return String(name ?? '').replace(INVISIBLE, ' ').trim() || fallback;
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
    developer: isOwner(u),
    status: u.status,
    membership: u.membership || 'member',
    xp: u.xp,
    rank_id: u.rank_id,
    rank: rank || null,
    custom_fields: u.custom_fields || {},
    skills: Array.isArray(u.skills) ? u.skills : [],
    joined_at: u.joined_at,
    last_seen: u.last_seen,
    last_sync: u.last_sync,
    steam_private: u.steam_private,
    friend_requests: u.friend_requests !== false,
    steam_add_button: u.steam_add_button !== false,
  };
}

// "Remember me" keys (see /auth/resume). Only a hash of each key is stored.
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export async function issueRememberToken(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q('INSERT INTO remember_tokens (user_id, token_hash) VALUES ($1,$2)', [userId, hashToken(token)]);
  return token;
}
