import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA, seed } from './schema.js';

let impl;

export async function initDb() {
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    impl = {
      query: (text, params) => pool.query(text, params),
      exec: (text) => pool.query(text),
      close: () => pool.end(),
    };
    console.log('[db] Using PostgreSQL (DATABASE_URL)');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = path.resolve(process.env.LOCAL_DB_DIR || './data/pglite');
    fs.mkdirSync(dir, { recursive: true });
    const db = new PGlite(dir);
    await db.waitReady;
    impl = {
      query: (text, params) => db.query(text, params),
      exec: (text) => db.exec(text),
      close: () => db.close(),
    };
    console.log('[db] Using local PGlite database at', dir);
  }
  await impl.exec(SCHEMA);
  await seed({ q, one });
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
