// Copies all WPG data from one database to another (e.g. Replit → Supabase).
//   node scripts/copy-db.mjs "<FROM database URL>" "<TO database URL>"
// Use "pglite:<folder>" for a local test database. The TO database gets the table layout first,
// then every row is copied (existing rows with the same key are left alone).
import { pgConfig } from '../server/db.js';
import { syncSchema } from '../server/migrate.js';

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const [fromUrl, toUrl] = args.filter((a) => a !== '--replace');
if (!fromUrl || !toUrl) {
  console.log('Usage: node scripts/copy-db.mjs "<FROM url>" "<TO url>" [--replace]');
  process.exit(1);
}

async function open(url) {
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite(url.slice(7));
    await db.waitReady;
    return { query: (t, p) => db.query(t, p), exec: (t) => db.exec(t), close: () => db.close() };
  }
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ ...pgConfig(url), max: 2 });
  return { query: (t, p) => pool.query(t, p), exec: (t) => pool.query(t), close: () => pool.end() };
}

// Parents before children, so links between tables are always valid.
const ORDER = ['settings', 'ranks', 'users', 'friends', 'channels', 'messages', 'dms', 'games', 'user_games', 'awards', 'user_awards',
  'announcements', 'profile_fields', 'audit_log', 'wardogs_stats', 'stat_defs', 'user_stats', 'steam_achievements', 'user_achievements',
  'unlocks', 'artillery', 'xp_counters', 'game_servers', 'sessions'];

const from = await open(fromUrl);
const to = await open(toUrl);
try {
  await syncSchema((t) => to.exec(t));
  if (replace) {
    // Empty the target first so it becomes an exact copy of the source.
    const have = new Set((await to.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map((r) => r.table_name));
    const wipe = ORDER.filter((t) => have.has(t));
    await to.exec(`TRUNCATE ${wipe.map((t) => `"${t}"`).join(', ')} CASCADE`);
    console.log(`Emptied ${wipe.length} tables in the target.`);
  }
  const existing = new Set((await from.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map((r) => r.table_name));
  for (const table of ORDER) {
    if (!existing.has(table)) { console.log(`- ${table}: not in source, skipped`); continue; }
    const rows = (await from.query(`SELECT * FROM "${table}"`)).rows;
    const targetCols = new Set((await to.query('SELECT column_name FROM information_schema.columns WHERE table_name=$1', [table])).rows.map((r) => r.column_name));
    let copied = 0;
    for (const row of rows) {
      const cols = Object.keys(row).filter((c) => targetCols.has(c));
      const vals = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' && !(row[c] instanceof Date) ? JSON.stringify(row[c]) : row[c]));
      const res = await to.query(
        `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`,
        vals,
      );
      copied += res.rowCount ?? res.affectedRows ?? 0;
    }
    // Make new rows continue numbering after the copied ones.
    const idSeq = targetCols.has('id') ? (await to.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [table])).rows[0]?.s : null;
    if (idSeq) await to.query(`SELECT setval('${idSeq}', GREATEST((SELECT COALESCE(MAX(id), 0) FROM "${table}"), 1))`);
    console.log(`- ${table}: ${copied} of ${rows.length} rows copied`);
  }
  console.log('Done.');
} finally {
  await from.close();
  await to.close();
}
