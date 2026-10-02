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
   - `INGEST_KEY`: a long random password (only needed for a Discord bot, see part 6)
4. Press **Run** to test it.
5. Press **Deploy → Reserved VM**. (Reserved VM keeps chat and stat syncing running all the time.)
   Add the same secrets to the deployment if Replit asks.
6. Copy your live address, e.g. `https://wpgtracker-yourname.replit.app`.

**Main admin:** Richie's Steam account (`76561198809535860`) is always admin, shows a **Developer** tag, and can't be demoted, banned or deleted.
To add more main admins later, add a Secret called `OWNER_STEAM_IDS` with Steam IDs separated by commas (include Richie's too).
**Starting admins:** Steam ID `76561198099451925` becomes admin automatically the first time they sign in (they can be demoted later like anyone).
To change this list, add a Secret called `ADMIN_STEAM_IDS` with Steam IDs separated by commas.
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

## 4. Game servers

The **Servers** page shows WPG's Wardogs servers live: online or offline, players, map, mode and region.
Live data comes from [Wardog Servers](https://wardogservers.com) (free, no key).

- **Add a server:** Servers page → **+ Add server** → search "WPG" → **Add**. (Also in Admin → Game servers.)
- **Control a server from the app:** Servers page → **Add RCON details** (or **Server settings**) → enter the **RCON address** and **RCON password**.
  Get these from your server host's panel (RCON must be switched on there).
  Then staff get a live player list and buttons on the Servers page:
  - **Mods:** broadcast a message, kick, kill.
  - **Admins:** also ban, unban, restart match, end match, change map.
- Every server action is saved in Admin → Audit log.
- The RCON password is never shown again after saving. Leave the box empty to keep it.

## 4b. Streams tab

Members who stream on Twitch, YouTube or Kick link their channel in **Edit profile → My streams**.
A mod approves it in **Command panel → Streams** (open the link first and check it's really theirs). Approved streamers show
on the **Streams** tab with the stream's player, the platform's own chat box, and a WPG chat everyone in the app can use.

- **Spotting who's live** (optional, Render → Environment). Without a key, streamers on that platform press **I'm live** instead.
  - Twitch: `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` from https://dev.twitch.tv/console/apps
  - YouTube: `YOUTUBE_API_KEY` (Google Cloud → enable *YouTube Data API v3* → Credentials → API key)
  - Kick: `KICK_CLIENT_ID` + `KICK_CLIENT_SECRET` from https://kick.com/settings/developer
- **WPG chat** under each stream stays inside the app: only members see it and nothing is sent to Twitch, YouTube or Kick.
- **Stream chats** are each platform's own chat box (Twitch, YouTube, Kick), shown inside the app. People sign in to
  Twitch / YouTube / Kick inside that box to type. The app doesn't read or send stream chat itself.
- **Discord "… is live" posts**: Command panel → Settings → Streams → paste the channel ID.
- **Stream keys** are optional. They're encrypted when saved and never shown again, to anyone. The app doesn't use them.

## 5. How stats and XP work

- **Global Wardogs stats** (level, XP, cash, role levels) come from **WARDOGS Tracker** (wardogstracker.gg).
  Each member must sign in there once with Steam so their stats are public.
- **WPG server kills and deaths** also come from WARDOGS Tracker.
  Put the WPG server's name in Admin → Settings → *WPG server name on WARDOGS Tracker*.
- **Steam playtime and achievements** come from Steam. The member's Steam "Game details" must be set to Public.
- **WPG XP** = Steam hours + achievements + WPG server kills + server stats + bonus XP.
  You can change every XP value in Admin (Games, Stats, Settings).
- Stats update by themselves every hour. Members can also press **Sync stats**.

## 6. Discord bot stats (optional, for whoever runs the bot)

A bot can send in stats like matches, wins, losses and playtime:

```
POST https://YOUR-SITE/api/ingest/stats
Authorization: Bearer <INGEST_KEY>
Content-Type: application/json

{ "players": [ { "steam_id": "76561198099451925", "stats": { "matches": 12, "wins": 7, "losses": 5, "playtime_minutes": 340 } } ] }
```

The stat names must match the **Key** column in Admin → Stats.

## 7. Test on your own PC

```
npm install
npm run dev
```

Then open <http://localhost:3000>.
With `DEV_LOGIN=true` in a `.env` file, you can log in with test names and no Steam.
**Never turn DEV_LOGIN on for the live site.**

## 8. If something goes wrong

- **Updating the live site:** pull the new code → press **Stop** then **Run** in the workspace → **Republish**.
  If the publish screen shows a red **DROP TABLE** or "delete" warning, press **Cancel**, restart the workspace app and try again.

- **Site down:** Replit → Deployments → check the logs → press **Redeploy**.
- **Stats not updating:** check `STEAM_API_KEY` in Secrets. Check the member has public Steam game details and a WARDOGS Tracker profile.
- **Locked out of admin:** another admin can fix your role in Admin → Members.
- **Android app says "Can't reach HQ":** the website is down or the phone is offline.

---

Global Wardogs stats are provided by [WARDOGS Tracker](https://wardogstracker.gg).

---

### Member types

- **WPG member:** a full clan member with a rank.
- **PMC (guest):** a friend of the clan using the app. PMCs have **no rank** and show an orange **PMC** badge.
  Approve new sign-ups with **Approve as member** or **Approve as PMC**, or change it later in Admin → Members → Edit → *Member type*.

### Artwork

The WPG logo, wolf badge, soldier, role pictures and banners are in `public/img/brand/`.
They were cut from the WPG Discord career card. The mountain background is `public/img/brand/scene.svg`.

### XP and XP events

- The **Ranks** page explains how to earn XP, using the current rates. It updates by itself when an admin changes a rate.
- XP is **earned as it happens**, at the rate in force when stats sync. Changing a rate never changes XP already earned.
- **Running an event** (e.g. 10 XP per kill for a weekend):
  1. Admin → Settings → *XP per kill on the WPG server* → **10**. Add a message in *XP event banner* (e.g. "Kill XP is 10 this weekend!").
  2. When the event ends: press **Sync everyone's stats now** first (so the last kills still count at 10), wait a few minutes,
     then set XP per kill back to **2** and clear the banner.
- Other XP rates: Admin → Stats (matches, wins, playtime…) and Admin → Games (Steam hours and achievements).

### Progression page and artillery data

- **Unlocks** (Admin → Unlocks): the full Wardogs progression — 197 unlocks with levels, costs and pictures.
  Imported once from WARDOGS Tracker (used with permission) and now stored in our own database.
  Pictures are in `public/img/unlocks/`. After a game update, edit, add or delete items in Admin → Unlocks.
- **Artillery** (Admin → Artillery): firing tables for the L81 mortar and SPH-2 (low and high arc), used by the
  Arty map. Originally from [wardogs-calculator](https://github.com/apollyon-sys/wardogs-calculator)
  by Apollyon, MIT licence (see `server/data/LICENSE-wardogs-calculator.txt`). Edit a table here if a game update changes a gun.
- Neither depends on other websites after the first start.

### Artillery map

- Menu → **Arty map**: Bakurani, Ozeti and Zestafona. Tap **Place gun** and tap your firing position (or type the
  in-game X, Y), then tap targets. Each target shows **distance**, **bearing** (degrees and mils) and **elevation** for the
  chosen gun, with Add / Drop / Left / Right 10 m corrections. Range rings show the gun's minimum and maximum range.
- Positions use the in-game coordinates (1 unit = 100 m). Saved per map on each device.
- Map pictures were imported once from WARDOGS Tracker (with permission) into `public/maps/`; spawn/tower positions
  and map coordinates from wardogs-calculator (MIT). Map engine: Leaflet (BSD licence, `public/vendor/leaflet/`).

---

## Free hosting: Render + Supabase (instead of Replit)

**1. Database (Supabase, free):** supabase.com → New project (pick a region near your players, set a database password and save it).
Then **Connect** → **Session pooler** → copy the connection string and put your password into it.

**2. Website (Render, free):** render.com → sign in with GitHub → **New → Blueprint** → pick `TTGRichieTT/wpgtracker`.
Render reads `render.yaml`. When it asks, paste the Supabase string into `DATABASE_URL` and your Steam key into `STEAM_API_KEY`.
Your site will be at `https://wpg-barracks.onrender.com` (or similar).

**3. Keep it awake:** free Render apps sleep after 15 minutes with no visitors. uptimerobot.com (free) → New monitor →
HTTP(s) → your site address + `/healthz` → every 5 minutes. (Render gives 750 free hours a month — enough for one app all month.)

**4. Move the data from Replit (once):** run `node scripts/copy-db.mjs "<Replit DATABASE_URL>" "<Supabase URL>"`.
It copies every member, message, medal and setting. Safe to run twice.

**5. Android app:** GitHub → Settings → Secrets and variables → Actions → Variables → change `APP_URL` to the Render address,
then Actions → Build Android app → Run workflow, and share the new APK.

Updates: every push to GitHub redeploys on Render automatically — no "Republish" step.
