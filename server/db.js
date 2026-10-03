import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../shared/schema.js';
import { seed } from './seed.js';
import { syncSchema } from './migrate.js';

let impl;
let poolRef = null;

// Drizzle ORM instance (typed queries against shared/schema.js). Most of the app uses q()/one() below.
export let db;

// Hosted databases (Supabase, Neon, Replit) need an encrypted connection. Their certificates
// aren't always in Node's trusted list, so encrypt without strict certificate checks.
// Local databases (localhost) connect without encryption.
export function pgConfig(url) {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname) || u.searchParams.get('sslmode') === 'disable';
  u.searchParams.delete('sslmode');
  // Connections are kept open for 5 minutes when quiet (not 10 seconds): opening a new one to a hosted
  // database takes most of a second, which made the first click after a quiet spell feel slow.
  return {
    connectionString: u.toString(), max: 10, idleTimeoutMillis: 5 * 60 * 1000, keepAlive: true,
    ssl: local ? false : { rejectUnauthorized: false },
  };
}

export async function initDb() {
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pool = new pg.Pool(pgConfig(process.env.DATABASE_URL));
    poolRef = pool;
    // The database may close a quiet connection itself; the pool just opens a new one when needed.
    pool.on('error', (e) => console.warn('[db] a quiet connection was closed:', e.message));
    impl = {
      query: (text, params) => pool.query(text, params),
      exec: (text) => pool.query(text),
      close: () => pool.end(),
    };
    db = drizzle(pool, { schema });
    console.log('[db] Using PostgreSQL (DATABASE_URL)');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const dir = path.resolve(process.env.LOCAL_DB_DIR || './data/pglite');
    fs.mkdirSync(dir, { recursive: true });
    const client = new PGlite(dir);
    await client.waitReady;
    impl = {
      query: (text, params) => client.query(text, params),
      exec: (text) => client.exec(text),
      close: () => client.close(),
    };
    db = drizzle(client, { schema });
    console.log('[db] Using local PGlite database at', dir);
  }
  await syncSchema(impl.exec);
  await seed({ q, one });
}

// For the status check: how long one database trip takes, and whether queries are queueing.
// "busiest" lists the queries run most since the app started (no values, just the query wording).
export async function dbHealth() {
  const t = Date.now();
  await impl.query('SELECT 1');
  const mins = Math.max(1, (Date.now() - statsSince) / 60000);
  const busiest = [...queryStats.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12)
    .map(([sql, s]) => ({ per_min: Math.round(s.n / mins), avg_ms: Math.round(s.ms / s.n), sql }));
  return { ms: Date.now() - t, ...(poolRef ? { open: poolRef.totalCount, idle: poolRef.idleCount, waiting: poolRef.waitingCount } : {}), busiest };
}

export async function closeDb() {
  await impl?.close();
}

// How often each query runs and how long it takes (shown by the status check), to find what keeps the database busy.
const queryStats = new Map();
const statsSince = Date.now();
export async function q(text, params = []) {
  const key = String(text).replace(/\s+/g, ' ').trim().slice(0, 100);
  const st = queryStats.get(key) || { n: 0, ms: 0 };
  if (!queryStats.has(key) && queryStats.size < 500) queryStats.set(key, st);
  const t = Date.now();
  try {
    return (await impl.query(text, params)).rows;
  } finally {
    st.n++;
    st.ms += Date.now() - t;
  }
}

export async function one(text, params = []) {
  return (await q(text, params))[0] || null;
}

let settingsCache = null;
export async function getSettings() {
  if (!settingsCache) {
    const rows = await q('SELECT key, value FROM settings');
    settingsCache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  return settingsCache;
}
export function clearSettingsCache() {
  settingsCache = null;
}
export async function setting(key) {
  return (await getSettings())[key];
}
export async function flag(key) {
  return String(await setting(key)) === 'true';
}

export async function audit(actorId, action, target, details = {}) {
  await q('INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1,$2,$3,$4)', [
    actorId,
    action,
    String(target ?? ''),
    JSON.stringify(details),
  ]);
}
