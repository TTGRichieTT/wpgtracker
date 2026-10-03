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
  return { connectionString: u.toString(), max: 10, ssl: local ? false : { rejectUnauthorized: false } };
}

export async function initDb() {
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pool = new pg.Pool(pgConfig(process.env.DATABASE_URL));
    poolRef = pool;
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
export async function dbHealth() {
  const t = Date.now();
  await impl.query('SELECT 1');
  return { ms: Date.now() - t, ...(poolRef ? { open: poolRef.totalCount, idle: poolRef.idleCount, waiting: poolRef.waitingCount } : {}) };
}

export async function closeDb() {
  await impl?.close();
}

export async function q(text, params = []) {
  const res = await impl.query(text, params);
  return res.rows;
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
