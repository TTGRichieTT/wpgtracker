# Running WPG Barracks on Replit

- Start the website from the repository root with `npm start`.
- The server listens on port 3000; Replit maps this port to the web preview.
- The app uses Replit's PostgreSQL database through `DATABASE_URL` and initializes its schema when it starts.
- Add `STEAM_API_KEY` in Replit Secrets to enable Steam profile and game-stat syncing. Steam login is available without that key.
- Do not set `DEV_LOGIN` on the live app.