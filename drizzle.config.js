import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Used by `npm run db:push` / `npm run db:studio`. The app also syncs the schema itself on start.
export default defineConfig(
  process.env.DATABASE_URL
    ? {
        dialect: 'postgresql',
        schema: './shared/schema.js',
        out: './migrations',
        dbCredentials: { url: process.env.DATABASE_URL },
      }
    : {
        dialect: 'postgresql',
        driver: 'pglite',
        schema: './shared/schema.js',
        out: './migrations',
        dbCredentials: { url: process.env.LOCAL_DB_DIR || './data/pglite' },
      },
);
