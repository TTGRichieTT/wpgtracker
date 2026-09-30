// Brings the database up to date with shared/schema.js on every start.
// Additive only: creates missing tables, columns, indexes and links. It never drops or changes
// existing data, so a mismatch (e.g. Replit's dev vs live database) can't wipe anything.
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../shared/schema.js';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

function idempotent(statement) {
  const s = statement.trim().replace(/;\s*$/, '');
  if (/^CREATE TABLE "/.test(s)) return s.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ');
  if (/^CREATE (UNIQUE )?INDEX "/.test(s)) return s.replace(/^CREATE (UNIQUE )?INDEX /, (m) => `${m}IF NOT EXISTS `);
  const fk = /^ALTER TABLE "([^"]+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \("([^"]+)"\)/.exec(s);
  if (fk) {
    // Skip if that column already has a foreign key (older databases named them differently).
    return `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
         WHERE c.contype = 'f' AND t.relname = ${lit(fk[1])} AND a.attname = ${lit(fk[2])}
      ) THEN EXECUTE ${lit(s)}; END IF;
    END $$`;
  }
  if (/^ALTER TABLE "[^"]+" ADD CONSTRAINT/.test(s)) {
    return `DO $$ BEGIN EXECUTE ${lit(s)}; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$`;
  }
  return null; // anything else (drops, renames, type changes) is never run automatically
}

export async function syncSchema(exec) {
  const empty = generateDrizzleJson({});
  const current = generateDrizzleJson(schema, empty.id);
  const statements = [];

  for (const s of await generateMigration(empty, current)) {
    const safe = idempotent(s);
    if (safe) statements.push(safe);
  }
  // New columns on tables that already exist.
  for (const table of Object.values(current.tables)) {
    for (const col of Object.values(table.columns)) {
      if (col.primaryKey) continue;
      let def = `ALTER TABLE "${table.name}" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`;
      if (col.default !== undefined) def += ` DEFAULT ${col.default}`;
      if (col.notNull) def += ' NOT NULL';
      statements.push(def);
    }
  }

  let failed = 0;
  for (const s of statements) {
    try {
      await exec(s);
    } catch (e) {
      failed++;
      console.warn('[db] Schema step skipped:', e.message, '\n   ', s.split('\n')[0]);
    }
  }
  console.log(`[db] Schema in sync with shared/schema.js${failed ? ` (${failed} step(s) skipped, see above)` : ''}`);
}
