# Running WPG Barracks on Replit

- Start the website from the repository root with `npm start`.
- The server listens on port 3000; Replit maps this port to the web preview.
- The app uses Replit's PostgreSQL database through `DATABASE_URL`.
- Add `STEAM_API_KEY` in Replit Secrets to enable Steam profile and game-stat syncing. Steam login is available without that key.
- Do not set `DEV_LOGIN` on the live app.

## Database (Drizzle)

- The schema is defined with Drizzle ORM in `shared/schema.js`. That file is the only place tables are defined.
- To change the database: edit `shared/schema.js`, then run `npm run db:push` (drizzle-kit push). Config is in `drizzle.config.js`.
- On every start the app also syncs the database to `shared/schema.js` (`server/migrate.js`). It only adds missing
  tables, columns, indexes and foreign keys — it never drops anything.
- Starter data (ranks, channels, medals, the WPG game server) is in `server/seed.js`.
- Before publishing: restart the app in the workspace so the development database matches the schema.
  If the publish screen proposes `DROP TABLE` or dropping columns, cancel — the development database is out of date.
- Do not use `drizzle-kit push --force`.
