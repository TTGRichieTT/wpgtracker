# WPG Barracks

The members-only app for **[WPG] Wasted Prodigy Gamers**.
It runs as a website on Replit, and as an Android app (APK) that opens the same website.

**What members get**
- Sign in with Steam. Your Steam name is your name in the app.
- A career profile with Wardogs stats (global + WPG server), Steam playtime and medals.
- Military ranks with US + UK style badges. Early ranks are earned by XP automatically.
- Live chat channels, private messages and friends.
- Leaderboards.

**What mods and admins get** (the **Admin** menu, on the website and in the app)
- Approve new members, change ranks, roles, XP, stats and profiles.
- Give medals, mute or ban people, post news.
- Admins can also edit ranks and badges, medals, chat channels, games, stats, profile boxes and settings.
- No code needed for any of it.

---

## 1. Put it live on Replit

1. On Replit: **Create App → Import from GitHub →** `TTGRichieTT/wpgtracker`.
2. Add a database: open the **Database** tool and create a **PostgreSQL** database.
   (Replit adds `DATABASE_URL` for you.)
3. Open **Secrets** (padlock icon) and add:
   - `STEAM_API_KEY`: get one free at <https://steamcommunity.com/dev/apikey>
   - `INGEST_KEY`: a long random password (only needed for a Discord bot, see part 5)
4. Press **Run** to test it.
5. Press **Deploy → Reserved VM**. (Reserved VM keeps chat and stat syncing running all the time.)
   Add the same secrets to the deployment if Replit asks.
6. Copy your live address, e.g. `https://wpgtracker-yourname.replit.app`.

**Main admin:** Richie's Steam account (`76561198809535860`) is always admin, shows a **Developer** tag, and can't be demoted, banned or deleted.
To add more main admins later, add a Secret called `OWNER_STEAM_IDS` with Steam IDs separated by commas (include Richie's too).
Everyone else needs approval, except the very first person to sign in, who also becomes admin.

**No Steam API key?** The app still works. Names and pictures come from public Steam profiles.
Only Steam playtime and achievements need the key. Any clan member's Steam account can make the key.

---

## 2. Make the Android app (APK)

GitHub builds the app for you. You don't need Android Studio.

**One-time setup** (in the GitHub repo → **Settings → Secrets and variables → Actions**):

| Type | Name | Value |
|---|---|---|
| Variables tab | `APP_URL` | your live Replit address |
| Secrets tab | `WPG_KEYSTORE_BASE64` | everything inside `WPG_KEYSTORE_BASE64.txt` |
| Secrets tab | `WPG_KEYSTORE_PASSWORD` | everything inside `WPG_KEYSTORE_PASSWORD.txt` |

The two `.txt` files are in the **wpg-signing-key** folder on Richie's PC. That folder is **not** on GitHub. Keep it backed up and private.

**To build:** GitHub → **Actions → Build Android app → Run workflow**.
After about 5 minutes the APK appears under **Releases** as `WPG-Barracks.apk`.
Send members that link.

The app just opens the website. So **changes to the website show up in the app straight away**.
You only rebuild the APK if the web address changes.

---

## 3. Everyday jobs (mods and admins)

- **Approve new members:** Admin → Members → *Waiting approval* → **Approve**.
- **Promote or demote:** Admin → Members → **Edit** → pick a Rank → Save.
  Tick *Lock rank* to stop automatic promotions for that person.
- **Give a medal:** Admin → Members → Edit → *Give medal*.
- **Post news:** Admin → News → Add new. Tick *Pin* to keep it at the top.
- **Enter server stats** (matches, wins, losses, playtime): Admin → Members → Edit → *Server stats*.

## 4. How stats and XP work

- **Global Wardogs stats** (level, XP, cash, role levels) come from **WARDOGS Tracker** (wardogstracker.gg).
  Each member must sign in there once with Steam so their stats are public.
- **WPG server kills and deaths** also come from WARDOGS Tracker.
  Put the WPG server's name in Admin → Settings → *WPG server name on WARDOGS Tracker*.
- **Steam playtime and achievements** come from Steam. The member's Steam "Game details" must be set to Public.
- **WPG XP** = Steam hours + achievements + WPG server kills + server stats + bonus XP.
  You can change every XP value in Admin (Games, Stats, Settings).
- Stats update by themselves every hour. Members can also press **Sync stats**.

## 5. Discord bot stats (optional, for whoever runs the bot)

A bot can send in stats like matches, wins, losses and playtime:

```
POST https://YOUR-SITE/api/ingest/stats
Authorization: Bearer <INGEST_KEY>
Content-Type: application/json

{ "players": [ { "steam_id": "76561198099451925", "stats": { "matches": 12, "wins": 7, "losses": 5, "playtime_minutes": 340 } } ] }
```

The stat names must match the **Key** column in Admin → Stats.

## 6. Test on your own PC

```
npm install
npm run dev
```

Then open <http://localhost:3000>.
With `DEV_LOGIN=true` in a `.env` file, you can log in with test names and no Steam.
**Never turn DEV_LOGIN on for the live site.**

## 7. If something goes wrong

- **Site down:** Replit → Deployments → check the logs → press **Redeploy**.
- **Stats not updating:** check `STEAM_API_KEY` in Secrets. Check the member has public Steam game details and a WARDOGS Tracker profile.
- **Locked out of admin:** another admin can fix your role in Admin → Members.
- **Android app says "Can't reach HQ":** the website is down or the phone is offline.

---

Global Wardogs stats are provided by [WARDOGS Tracker](https://wardogstracker.gg).
