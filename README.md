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
   - `WARDOGS_API_KEY`: the private API key supplied by the WARDOGS site owner (also set it as a secret in Render)
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
- **Server tools (admins, under Server controls):**
  - A status line: RCON healthy / busy / not answering, uptime, connections, the server's Wardogs build and host ID.
    Controls the server's version doesn't have are hidden (and refused).
  - **Reserved slots:** players on the list skip the join queue, so they can join even when the server is full. Pick a
    member to give one; nobody gets one automatically. The server only picks up changes when it restarts (daily), so
    new and removed ones are labelled "starts / ends at the next restart". MaxReservedSlots is how many player places
    are held back for them, not a limit on the list.
  - **Server action log:** what admins did on the game server (kicks, bans, config changes), from any tool.
  - **Server banner:** the picture shown for the server (1024×256 PNG/JPEG; its site must be on the server's allow-list).
- **Matches:** a new match is spotted when the match clock starts again (the server's, or the kill feed's: live builds
  don't send theirs over RCON), or the map/mode changes. Where the server reports its score target, a match counts as
  "finished" when a team (nearly) reached it; one staff stopped or skipped doesn't give leaving-early penalties. A
  match under 5 minutes doesn't count for giveaways. The Servers page shows how the last match ended.
- **In-game chat** can't be read: WARDOGS doesn't make it available to RCON or the kill feed yet. In-game messages
  (broadcasts, whispers) are limited to 256 characters by the game.
- **Live kill feed (staff):** on the Servers page, under the server the kill feed is connected to (Admin → Cheat watch →
  Connect kill feed): who killed whom, weapon, distance and headshots, updating as kills happen. The game posts to the
  address it's given plus "/api/ingest/events"; the app answers both.
- RCON reference used for these: the unofficial [wardogs.tech RCON reference](https://wardogs.tech/rcon-reference).
  The RCON port is plain http, so the password travels unencrypted: ask the host to keep it behind a secure proxy or
  limit which addresses can reach it.

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

## 4c. Situation rooms

A shared map for a group during a match (menu → **Situation rooms**, or the button on the Arty map). WPG members only:
PMC guests can't see or use them.

- **One room per faction** (Lonestar, Valkyra, Manticore), so at most 3 at once. Any WPG member can open a free one;
  they pick the map they're playing on (it doesn't have to be our server).
- **Getting in:** the room's creator invites people from the members list, or members press **Ask to join** and the
  creator lets them in. Admins can also look into any room, join it, or close it. A member is in one room at a time.
- **Outside a room** members only see its name and who's in it, never its map.
- **Inside:** a floating icon toolbar on the left of the map holds the marks (my position, FOB, enemy, need,
  objective, danger), the drawings (attack and flank arrows with real arrow heads, defend lines, routes, areas,
  labels), the colours and the gun. Press **?** for a key of every icon and colour. Everyone in the room sees changes
  straight away. Requests (ammo, build, fuel or mechanical supplies, medic, transport, repair, fire support, backup) go in the **Needs** list, where anyone can press **I'm on it** and then **Done**.
- **Stacking:** several things can be marked in one spot. With a tool picked, tapping an existing mark adds the new one
  in the same place. Marks in one spot show a count there and line up beside it, so each can still be seen and tapped.
- **Enemies (3 teams):** each room has two enemy colours, the other two factions (a Lonestar room marks Valkyra in red
  and Manticore in green). Enemy marks are icons: infantry, sniper (crosshair), mortar, artillery (cannon), tank,
  spawn APC, armed vehicle, supply/unarmed (truck) and air (helicopter).
- Positions fade after 2 minutes and enemy spots after 3–5 minutes unless refreshed; a spawn APC stays until removed.
  The creator (or an admin) can change the map or press **New match / clear board**, both of which clear the board. A
  room nobody uses for 30 minutes closes by itself; if the creator leaves, the longest-serving member takes over.
- **Artillery:** pick your gun and place it in the side panel; its min/max range rings show on the map, enemy marks out
  of range are faded and in-range ones are tagged. Hover (or right-click / long-press) anywhere for elevation, bearing
  and distance. **Share my gun** (optional, per person) shows your gun and its rings to the room so others can see who
  can hit what. Tap your gun on the map (or **Remove** in the panel) to move it or take it off the map; this also
  removes it from the Arty map and stops sharing it.
- **Fire mission:** tap an enemy, danger or objective mark → **Fire mission** shows elevation, bearing and distance
  from your gun (the same saved position as the Arty map) and which shared guns are in range. **I'm firing on it**
  shows "💥 Name firing" on the mark for everyone; **Open in Arty map** adds it as a target there.
- **Room chat:** a small text box for quick messages (kept until the room closes).
- **Alerts:** a beep (and a buzz on phones) for new needs, enemy spots, messages and, for the room's creator, join
  requests. Each member can switch them off with **🔔 Alerts on / off**.
- **Last matches (admins):** each time a board is cleared (new match, map change, room closed) a copy is kept for
  14 days; admins see them at the bottom of the Situation rooms page and can open each on its map (read only).
- New maps: rooms use the same map files as the Arty map (`public/maps`).

## 4d. Discord control (its own page: menu → Discord control, admins)

The bot builds the WPG Discord layout and keeps members' roles in step with the app.

Everything the WPG Discord bot does is on one page (menu → **Discord control**), each part a drop-down section that stays open or closed as you left it: **Bot** (setup checklist, connection, test post, card
previews), **Server & roles**, **Entry & rules**, **Filters & moderation**, **Logs & extras**, **Posts & channels**
and **Cases**. **Commands** is a compact table of tick boxes: for each bot command, tick any mix of Anyone (everyone on
Discord), PMC, WPG members, Mods and Admins. Nothing ticked removes the command from Discord. People count as their app
rank once linked with /link; Discord admins count as Admins and anyone who can kick / ban / time out as Mods.
/link and /unlink are Anyone or off. Each bot feature has its own on / off switch (e.g. the offensive language filter, each spam filter, the
moderator commands, DMs to members, each kind of mod log, welcome posts, raid alarm, tickets, role buttons, game roles).
Switching an AutoMod filter off turns the bot's rule off on Discord; switching it back on turns it on again. These
switches control the bot, not Discord's own server settings. The Discord parts of Admin → Settings live here now.

- **Set up:** put the server ID in Admin → Discord server, press **Add the bot to the server** (Administrator), drag the
  bot's role to the top of the role list, and in the Discord Developer Portal → Bot switch on **Server Members Intent**
  (needed to list the server's members). Optional: switch on Community for a rules screen.
- **Build:** **Preview** lists what would be made; **Build server** makes it: roles (Admin, Moderator, CO / XO / Deputy,
  Unit Leader, WPG Member, one per unit, Lonestar / Valkyra / Manticore, Content Creator, Partner, Military Vet,
  WPG Community, Wardogs, 18+, divider roles) and the categories Start here, Information, Community, Wardogs, WPG App, WPG Clan, Guild halls and
  Staff, with who can see and talk in each. It reuses roles and channels that already exist by name and never deletes
  anything it didn't make, so it's safe on the main server too. The **Also send the app's Discord posts here** box points
  go-live, rank-up and staff-alert posts at the new channels; leave it off on a test server.
- **Roles (when "Keep members' roles in step" is on, every 2 minutes and straight after changes in the app):**
  everyone on the server gets **WPG Community** (after the entry check). Members who linked with **/link**
  also get Admin / Moderator, **WPG Member** (full members) or **Wardogs** (PMC guests), their Combat Command post or unit (and Unit Leader), their
  faction, and a grey show-only role for every Steam game they've played for 100+ hours (the hours can be changed).
  Content Creator, Partner, Military Vet and 18+ are given by hand. Roles on members who haven't linked are never
  taken away; unlinking takes the app's roles off again.

**/frames** in Discord shows a member's profile frames as a picture card (the WPG card art, every frame drawn with its
own artwork around their picture; locked ones dimmed with a lock and a progress bar) and an achievement list (yours, or another member's with the member
or name option): what they've earned with the date, the frame they're wearing, and the next few still to earn with
progress, by Permanent, Clan, this season and past seasons.

**Tidy up an existing server** (Server & roles): for the old WPG Discord. **Scan** changes nothing and lists every role
with its member count and what will happen to it. Kept: roles with 5+ members, staff / owner roles, the layout's roles
(matched by name, e.g. WPG Community = everyone, WarDogs = the PMC role, 🛡️|Administrator = Admin), divider roles and bots'
roles; the rest are ticked for removal (untick any to keep them). Kept roles that aren't staff lose risky permissions.
Channels keep their names, places and messages; they're matched to the layout by name (emoji and brackets ignored) and
get exactly the layout's permissions (single-member and bot overwrites kept); channels not in the layout take their
category's. Missing layout channels and roles are added and the roles put in order under dividers. Bots are left alone.
A full backup (roles, channels, permissions, everyone's roles) is made first and can be downloaded. To test on a copy of
the real server, put the real server's ID in "Count members from another server". **WPG Community** is everyone in WPG,
**Wardogs** is PMC guests (the app gives it to linked PMC guests and takes it off anyone with WPG Member) and **WPG Member**
is full members.

### Entry check, rules and moderation (same page)

The bot also does what mod bots like Carl-bot, Captcha.bot and Ticket Tool did. It keeps a live connection to Discord,
so switch on **Server Members Intent** and **Message Content Intent** in the Developer Portal → Bot, then press
**Reconnect** on the page.

- **Entry check:** new joiners only see #welcome and #rules. Under the rules (edited on the page, then **Update the rules
  post**) is an **I've read the rules, let me in** button: type a 5-letter code and answer one yes / no question → they
  get **WPG Community**. Accounts younger than 7 days wait for staff (Let in / Kick buttons in #staff-chat or on the page). 3
  wrong tries = removed; anyone not in after 24 hours is removed (both told they can rejoin). Members already on the
  server when it was switched on are never affected. 10 joins in a minute pauses entry for 15 minutes and pings staff.
  Discord's own verification level (verified email, account 5+ minutes old) and media scanning are switched on too.
- **AutoMod (Discord's own, set up by the bot):** slurs and sexual content, spam, mass mentions, invite and scam links
  and the page's extra blocked words. Staff are exempt; alerts go to #mod-log.
- **Spam filter:** the same message 3 times in 30 seconds is removed, 6 messages in 8 seconds = 2-minute mute, caps-lock
  shouting is removed.
- **Commands (staff only):** /warn /timeout /untimeout /kick /ban /unban /purge /slowmode /lock /unlock /cases /unwarn.
  Members are told by DM. Warnings count for 30 days: 3 = 1-hour timeout, 5 = kick (changeable). Staff can't be targeted.
- **#mod-log:** joins (with account age), leaves, edited and deleted messages, role and nickname changes, bans, every
  case, purges, locks and ticket transcripts. Every case is also listed on the page.
- **#pick-roles:** buttons for PC, Xbox, PlayStation, Switch and 18+ (asks them to confirm they're 18+).
- **#contact-staff:** a button that opens a private ticket channel with staff; closing it posts the transcript to #mod-log.
- **#welcome:** a welcome post for each new joiner pointing them at #rules.

## 5. How stats and XP work

- **Global Wardogs stats** come from [wardogs.tools](https://wardogs.tools)'s player stats API, with the private key
  its developer gave the clan. Put it in Render (and Replit Secrets if used) as **`WARDOGS_API_KEY`**; it never goes in
  the code. Members are found by their Steam ID; their wardogs.tools id is then remembered and used from then on.
  The developer's name search is only used as a last resort, for members who typed their in-game name (Name#1234) in
  Edit profile. Discord `/stats` for someone not in the app looks them up by their Discord ID.
- As the developer asked, every request sends the app's User-Agent and the stats always show
  "Data provided by wardogs.tools" with a link (profiles, leaderboards, progression, Discord).
- Requests are gentle: one at a time, 10 seconds apart, and paused when wardogs.tools says so. Found players are
  re-read every six hours, and 30 minutes after the app sees them stop playing Wardogs on Steam (wardogs.tools can only
  read an account once the game is closed), so stats update soon after each session with nothing for members to press. "Not found" is asked again after 30 minutes, or straight away when the member presses
  **Check now** (members who've just linked their account there don't have to wait).
- Shown: Wardog level, world rank (position out of everyone, top %, change), cash, gold, account worth and its
  breakdown, unlock count, each class's level and XP, XP and cash per minute. wardogs.tools doesn't give total
  career XP or achievements, so those aren't shown.
- **WPG server kills, deaths and matches** come from our own server (RCON and the game's kill feed).
- **Steam playtime and achievements** come from Steam. The member's Steam "Game details" must be set to Public.
- **Clan XP** = Steam hours + achievements + WPG server kills + server stats + bonus XP.
  You can change every XP value in Admin (Games, Stats, Settings).
- Stats update by themselves on a timer (Admin → Settings), and when a member presses **Sync stats**.

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
- **Stats not updating:** check that `WARDOGS_API_KEY` is set in Render, and that the member has linked their Wardogs account on wardogs.tools (then they press **Check now** on HQ). Found players update every six hours. For Steam playtime, check `STEAM_API_KEY` in Secrets and that the member has public Steam game details.
- **Locked out of admin:** another admin can fix your role in Admin → Members.
- **Android app says "Can't reach HQ":** the website is down or the phone is offline.

---

Global Wardogs stats are provided by [wardogs.tools](https://wardogs.tools).

---

### Member types

- **WPG member:** a full clan member with a rank.
- **PMC (guest):** a friend of the clan using the app. PMCs have **no rank** and show an orange **PMC** badge.
  Approve new sign-ups with **Approve as member** or **Approve as PMC**, or change it later in Admin → Members → Edit → *Member type*.
  If *New sign-ups need approval* is **off** (Admin → Settings), new sign-ups join straight away as **PMCs**, and staff get a
  notice. Make them a WPG member later in Admin → Members → Edit → *Member type*.
- **What PMCs can see:** no Combat Command, and only the chat channels ticked *PMCs (guests) can see it* in
  Admin → Chat channels (#wardogs and #looking-for-group to start with). Staff see every channel.

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

### WPG rank and WPG XP (Admin → WPG XP)

- **WPG rank** (Recruit I → Wardog X) and **WPG XP** are earned only on servers ticked *Matches here earn WPG XP*
  in Admin → Game servers (the WPG server is ticked; it needs RCON). Separate from Clan rank / Clan XP.
- **Two ways to run it.** At first the **Discord bot** is in charge and the app copies its numbers every 5 minutes.
  Meanwhile the app counts every match by itself without changing anyone's XP. Admin → WPG XP compares the two.
- **Ranks:** the 200 standard ranks are built in (Recruit I at 0 → Wardog X at 650,000 XP; each needs 2,000–4,550 XP
  more than the last, so one match can't climb two ranks). Everyone's shown rank uses this list, even while the bot is
  in charge. Change it in Admin → WPG XP (one per line, e.g. `Recruit II = 2000`).
- **Switching over:** check the comparison, then press **Switch WPG XP over to this app**. Everyone starts from their bot XP that day and the bot is no longer read.
  **Go back to the Discord bot** undoes it (XP earned in the app after the switch isn't kept).
- **How XP is counted** (amounts in Admin → WPG XP), when each match ends: XP for kills, time played, finishing and
  winning; minus XP for a loss, a bad K/D (more deaths than kills) and leaving early. Leaving early isn't counted
  if the app lost sight of the server during the match, or half the players dropped out at once (a crash).
  With *no rank loss* ticked, penalties never take anyone below the start of their rank.
- **Badges:** each WPG rank has a badge like the clan ranks: the tier sets the insignia and colour (bronze enlisted,
  silver NCOs, gold officers, red generals, blue Field Commander / Wardog) and a tab shows I–X. Shown on the leaderboard
  (with all 200 ranks under *All WPG ranks*), HQ, profiles and the Discord cards.
- Members see **XP to their next rank** on HQ, their profile, the leaderboard and the Discord /rank card, and their
  last matches (what each gave or took) under the WPG rank leaderboard.

### Giveaways (Admin → Giveaways)

- **Giveaway:** runs for a set number of matches on the WPG server, starting with the next match (optionally not
  before a set time). Members press **Enter**, or everyone who plays on the WPG server is entered. Optional
  requirements during those matches (minutes played, matches, kills: finished matches only). Winners are drawn at
  random at the end of the last match, from those on the server then. A crashed match doesn't count (it runs one
  more). **Make this the last match** ends it early.
- **Drops:** trigger at secret random times in the window, or only when you press **Trigger a drop now** (which also
  works any time). Everyone on the WPG server when a drop triggers is in it; when that match ends, those still on who
  played at least the set minutes of it get the prize: **everyone who qualifies**, or **one random player**. If the app
  lost sight of the server or half the players dropped out at once (a crash), or nobody qualified, the drop triggers
  again 10 minutes later. A match that never ends is settled after 90 minutes with whoever is on.
- **Top players:** whoever does best on the WPG server in the time window wins by place: most kills, time played,
  matches, wins, WPG XP earned, or highest on the WPG rank leaderboard. Members see the live standings.
- **Finished matches only:** requirements and Top players count only matches the player stayed in until the end.
- **Prizes:** each giveaway has a list of prizes, in order (the first goes to the first winner / drop / place), each
  with how many winners, drops or places get it, e.g. 1st: £25 card, 2nd–3rd: 500 Clan XP, 4th–10th: 100 Clan XP.
  A prize is something real (the winner presses **Claim** in the app within the days you set, then you press **Mark
  sent**; optional codes/keys, one per winner, are shown only to that winner once claimed), Clan XP, WPG XP (once WPG
  XP is switched over to the app) or a medal. XP and medals are given straight away.
- Winners are told in the app, on Discord and on the WPG server. **Discord:** put the giveaways channel ID at the top of
  Admin → Giveaways (empty = the channel for the other automatic posts). **Draw someone else** / **Give to the next
  player** hands an unclaimed prize on. Members see everything on the **Giveaways** page.

### Live match money from Steam (Admin → Steam bot)

- While someone plays Wardogs, Steam shows their friends a line under their name, e.g. **-$10,793 Loss**. The app
  reads it through a separate **WPG Barracks Steam account** (the bot) that members friend.
- **Setup:** make a new Steam account (never anyone's own, and don't play on it). In Render → Environment add
  `STEAM_BOT_USERNAME` and `STEAM_BOT_PASSWORD` (and `STEAM_BOT_SHARED_SECRET` only if it uses the Steam mobile
  authenticator), then restart. If Steam emails a Steam Guard code, staff get a notification: type it in
  **Admin → Steam bot**. After the first login the sign-in is remembered (encrypted), so restarts need no code.
- **Members switch it on** on their profile (**Show my live match money**), then press **Add the bot on Steam**: their
  own single-use Steam quick invite link (a new Steam account can't send friend requests, but quick links always
  work). The bot also tries sending a request and accepts members' requests; members already on its friends list are
  switched on by themselves; anyone who isn't an app member is removed. Switching it off, or unfriending the bot,
  stops it.
- **How it's counted:** Steam shows the match's running profit / loss (e.g. **+$4,500 Profit**, **-$10,793 Loss**),
  which goes back to $0 when the next match starts. Each match's result is its last figure before it resets (or
  before they leave Wardogs); loading screens and menus in between don't split a match.
- **Where it shows:** next to "🎮 WARDOGS" across the app, on their profile (this match or the last one, and the last
  24 hours' total), the **24-hour money** leaderboard (last 24 hours, the match in progress included) and **/money** in
  Discord (WPG members).
- **Discord live board:** one message in the live match money channel (Admin → Steam bot) that the bot keeps up to
  date: who's in a match with their running profit / loss, and the last 24 hours' top earners. Optional post for a big match
  (off until you switch it on, with the amount).

### Profile frames and seasons (Admin → Frames & seasons)

- **Frames** are borders around a member's picture, earned from what they do. Each member picks one unlocked frame
  on their profile (**Use this frame**); it shows around their picture across the app and on their Discord cards.
  Their profile shows every frame with progress towards the ones still locked.
- **Permanent:** kept forever (Founding Member, Sharpshooter, Long Shot, Specialist, Lucky, Old Guard, and the season
  placings below). **Clan:** WPG members only, while it applies (Clan Colours, Unit Colours in their Combat Command
  unit's colour, Officer). PMCs can earn permanent and season frames.
- **Seasons follow the game's wipes.** Each season has its own set of season frames (Centurion, Marksman, Ironman,
  Victor, Millionaire, Tycoon, Battle-Hardened), in its own looks with its season number on them (S1, S2…). They can
  only be earned while that season runs; members keep the ones they earned for good. Season 2 starts with the first
  wipe on **15 October 2026**.
- When a season starts (by itself at the date set, or **Start new season now** if the game wipes early): the last
  season's top 100, top 10 and Champion by WPG XP earned in it get permanent placing frames (one Discord post with the
  results), and the new season gets last season's challenges in new looks, unless you made its set first with
  **Make Season N's frames now** (then change their looks before the wipe). Staff are warned if several members'
  Wardog levels drop at once (the game probably wiped).
- **Add frame** / **Edit:** look, colour, corner badge, what unlocks it and the target. A new frame's first check is
  quiet, so members who already qualify get it without a flood of posts; after that each unlock gets an app
  notification and, for WPG members, a Discord post (switch off on the same page). **Give** hands a frame to a member
  by hand; **Who has it** lists holders and can take it away.
- **Your own frame art:** pick the look **Uploaded picture**, press **Download the template**, draw over it and upload:
  512 x 512 px PNG, WebP or GIF (animated is fine), up to 1 MB, with the middle (378 x 378 px, from 67 to 445 px)
  transparent so the member's picture shows through. The app refuses the wrong shape, a covered middle or a JPEG, and
  makes bigger squares 512 x 512. The editor previews it at every size members see it (lists, Discord cards, profile).
- **Corner badge "Their clan rank badge"** shows each member's own clan rank in the bottom-right corner (Clan Colours
  uses it). Season frames show their season (S1, S2…) bottom left; untick **Season tag** if the art already has it.

### Progression page and artillery data

- **Unlocks** (Admin → Unlocks): the full Wardogs progression — 197 unlocks with levels, costs and pictures.
  Imported once from WARDOGS Tracker and now stored in our own database.
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
- Map pictures were imported once from WARDOGS Tracker into `public/maps/`; spawn/tower positions
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
