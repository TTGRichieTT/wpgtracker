// The WPG database layout (Drizzle ORM). This file is the single source of truth:
// the app syncs the database to it on every start (adding only, never deleting),
// and `npm run db:push` does the same by hand.
import {
  pgTable, serial, text, integer, boolean, jsonb, timestamp, numeric, primaryKey, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

const now = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: text(),
});

export const ranks = pgTable('ranks', {
  id: serial().primaryKey(),
  name: text().notNull(),
  abbr: text().notNull(),
  sort_order: integer().notNull().default(0),
  min_xp: integer().notNull().default(0),
  auto: boolean().notNull().default(true),
  color: text().notNull().default('#c9a227'),
  insignia: jsonb().notNull().default({}),
  description: text().notNull().default(''),
});

export const users = pgTable('users', {
  id: serial().primaryKey(),
  steam_id: text().notNull().unique('users_steam_id_key'),
  persona_name: text().notNull(),
  avatar: text().notNull().default(''),
  profile_url: text().notNull().default(''),
  callsign: text().notNull().default(''),
  bio: text().notNull().default(''),
  country: text().notNull().default(''),
  custom_avatar: text().notNull().default(''),
  banner_color: text().notNull().default('#3b4a2f'),
  role: text().notNull().default('member'),
  status: text().notNull().default('pending'),
  // 'member' = WPG member, 'pmc' = guest (Private Military Contractor)
  membership: text().notNull().default('member'),
  rank_id: integer().references(() => ranks.id, { onDelete: 'set null' }),
  rank_locked: boolean().notNull().default(false),
  xp: integer().notNull().default(0),
  bonus_xp: integer().notNull().default(0),
  // XP earned from activity, added up as it happens at the rates in force at the time
  // (so changing a rate for an event never rewrites XP already earned).
  earned_xp: numeric().notNull().default('0'),
  xp_ledger: boolean().notNull().default(false),
  muted_until: timestamp({ withTimezone: true }),
  custom_fields: jsonb().notNull().default({}),
  skills: jsonb().notNull().default([]), // skills the member shows on their profile (from the recruitment roles list)
  frame_id: integer(), // the profile frame they show around their picture (frames.js)
  steam_private: boolean().notNull().default(false),
  // Their choice (Edit profile → Friend requests): others can send them friend requests in the app, and their
  // profile shows the Add on Steam / Steam profile buttons.
  friend_requests: boolean().notNull().default(true),
  // Their original WPG join date, set by staff once checked (Admin → Members; every change is in the audit log).
  // Loyalty badges count from it. Members who join the app after loyalty tracking started get their app join date.
  wpg_joined_at: timestamp({ withTimezone: true }),
  wpg_joined_note: text().notNull().default(''),
  badge_showcase: jsonb().notNull().default([]), // up to 5 badge ids they show at the top of their profile
  frame_badge_id: integer(), // an earned badge they show in their frame's corner instead of their clan rank badge
  steam_add_button: boolean().notNull().default(true),
  steam_invite: text().notNull().default(''), // their own Steam quick invite link (s.team/p/…), for Add on Steam
  steam_invite_at: timestamp({ withTimezone: true }), // when they pasted it (Steam's links last 30 days: steaminvite.js)
  steam_invite_reminded: timestamp({ withTimezone: true }), // last "refresh your link" reminder
  discord_id: text().notNull().default(''), // linked with /link in Discord, for the Barracks bot
  joined_at: now(),
  last_seen: now(),
  last_sync: timestamp({ withTimezone: true }),
});

// One-time codes from the Discord /link command; the member types it in the app to link accounts.
export const discordLinkCodes = pgTable('discord_link_codes', {
  code: text().primaryKey(),
  discord_id: text().notNull(),
  discord_name: text().notNull().default(''),
  created_at: now(),
});

export const friends = pgTable('friends', {
  requester_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  addressee_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text().notNull().default('pending'),
  created_at: now(),
}, (t) => [primaryKey({ name: 'friends_pkey', columns: [t.requester_id, t.addressee_id] })]);

export const channels = pgTable('channels', {
  id: serial().primaryKey(),
  name: text().notNull(),
  description: text().notNull().default(''),
  min_role: text().notNull().default('member'),
  read_only: boolean().notNull().default(false),
  pmc_access: boolean().notNull().default(false), // PMC guests can see it (otherwise WPG members and staff only)
  sort_order: integer().notNull().default(0),
});

export const messages = pgTable('messages', {
  id: serial().primaryKey(),
  channel_id: integer().notNull().references(() => channels.id, { onDelete: 'cascade' }),
  user_id: integer().references(() => users.id, { onDelete: 'cascade' }),
  body: text().notNull(),
  deleted: boolean().notNull().default(false),
  created_at: now(),
}, (t) => [index('messages_channel_idx').on(t.channel_id, t.id.desc())]);

export const dms = pgTable('dms', {
  id: serial().primaryKey(),
  sender_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipient_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  body: text().notNull(),
  read_at: timestamp({ withTimezone: true }),
  created_at: now(),
}, (t) => [
  index('dms_pair_idx').on(t.sender_id, t.recipient_id, t.id.desc()),
  index('dms_recipient_idx').on(t.recipient_id, t.read_at),
]);

export const games = pgTable('games', {
  app_id: integer().primaryKey(),
  name: text().notNull(),
  enabled: boolean().notNull().default(true),
  featured: boolean().notNull().default(false),
  xp_per_hour: integer().notNull().default(10),
  xp_per_achievement: integer().notNull().default(25),
  stat_labels: text().notNull().default(''),
});

export const userGames = pgTable('user_games', {
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  app_id: integer().notNull().references(() => games.app_id, { onDelete: 'cascade' }),
  playtime_forever: integer().notNull().default(0),
  playtime_2weeks: integer().notNull().default(0),
  ach_unlocked: integer().notNull().default(0),
  ach_total: integer().notNull().default(0),
  stats: jsonb().notNull().default({}),
  updated_at: now(),
}, (t) => [primaryKey({ name: 'user_games_pkey', columns: [t.user_id, t.app_id] })]);

// Discord moderation: every warning, timeout, kick, ban and automatic action (Admin → Discord server, /cases).
export const discordCases = pgTable('discord_cases', {
  id: serial().primaryKey(),
  guild_id: text().notNull(),
  user_id: text().notNull(),
  user_name: text().notNull().default(''),
  action: text().notNull(), // warn | timeout | untimeout | kick | ban | unban | spam | auto-timeout | auto-kick | entry-kick
  reason: text().notNull().default(''),
  mod_id: text().notNull().default(''),
  mod_name: text().notNull().default(''),
  minutes: integer().notNull().default(0),
  removed: boolean().notNull().default(false),
  created_at: now(),
}, (t) => [index('discord_cases_user_idx').on(t.guild_id, t.user_id)]);

// The Discord entry check (rules button): who passed, who is held for staff (new accounts) and failed tries.
export const discordEntries = pgTable('discord_entries', {
  discord_id: text().primaryKey(),
  guild_id: text().notNull(),
  user_name: text().notNull().default(''),
  status: text().notNull().default('started'), // started | passed | held | let_in | kicked
  attempts: integer().notNull().default(0),
  created_at: now(),
  updated_at: now(),
});

// Private "contact staff" ticket channels.
export const discordTickets = pgTable('discord_tickets', {
  id: serial().primaryKey(),
  guild_id: text().notNull(),
  channel_id: text().notNull().default(''),
  user_id: text().notNull(),
  user_name: text().notNull().default(''),
  status: text().notNull().default('open'),
  closed_by: text().notNull().default(''),
  created_at: now(),
  closed_at: timestamp({ withTimezone: true }),
});

// Every Steam game a member has played for 10+ hours (any game, not only the tracked ones), with its name.
// Used for the show-only game roles on Discord (Admin → Discord server).
export const steamPlaytime = pgTable('steam_playtime', {
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  app_id: integer().notNull(),
  name: text().notNull().default(''),
  minutes: integer().notNull().default(0),
  updated_at: now(),
}, (t) => [primaryKey({ name: 'steam_playtime_pkey', columns: [t.user_id, t.app_id] })]);

export const awards = pgTable('awards', {
  id: serial().primaryKey(),
  name: text().notNull(),
  description: text().notNull().default(''),
  colors: text().notNull().default('#1f3a93,#ffffff,#b22234'),
  sort_order: integer().notNull().default(0),
  // Automatic medal rule, e.g. 'class:assault:20' (class level) or 'hours:300' (hours played). Empty = given by hand.
  auto_rule: text().notNull().default(''),
  // Achievement medals (badges.js): rarity (common … exclusive, empty for older medals), Achievement Points, category.
  rarity: text().notNull().default(''),
  points: integer().notNull().default(0),
  category: text().notNull().default(''),
});

export const userAwards = pgTable('user_awards', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  award_id: integer().notNull().references(() => awards.id, { onDelete: 'cascade' }),
  given_by: integer().references(() => users.id, { onDelete: 'set null' }),
  reason: text().notNull().default(''),
  given_at: now(),
  // The season a level medal was earned in (0 = not a season medal): levels reset each season, so they can be won again.
  season_id: integer().notNull().default(0),
});

export const announcements = pgTable('announcements', {
  id: serial().primaryKey(),
  title: text().notNull(),
  body: text().notNull().default(''),
  pinned: boolean().notNull().default(false),
  author_id: integer().references(() => users.id, { onDelete: 'set null' }),
  created_at: now(),
});

export const profileFields = pgTable('profile_fields', {
  id: serial().primaryKey(),
  key: text().notNull().unique('profile_fields_key_key'),
  label: text().notNull(),
  type: text().notNull().default('text'),
  options: text().notNull().default(''),
  sort_order: integer().notNull().default(0),
});

export const auditLog = pgTable('audit_log', {
  id: serial().primaryKey(),
  actor_id: integer().references(() => users.id, { onDelete: 'set null' }),
  action: text().notNull(),
  target: text().notNull().default(''),
  details: jsonb().notNull().default({}),
  created_at: now(),
});

export const wardogsStats = pgTable('wardogs_stats', {
  user_id: integer().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  official: jsonb(),
  official_synced: timestamp({ withTimezone: true }),
  server: jsonb(),
  server_synced: timestamp({ withTimezone: true }),
  // API rank metadata: { source, socialId, displayName, position, total, bracket, change, polled_at, state, lost? }
  ranks: jsonb(),
  ranks_synced: timestamp({ withTimezone: true }),
  // wardogs.tools stopped updating them: how many times they've been asked to relink, and when last (ranking.js).
  relink_prompts: integer().notNull().default(0),
  relink_prompted_at: timestamp({ withTimezone: true }),
  relink_since: timestamp({ withTimezone: true }), // when wardogs.tools first stopped updating them (prompts wait 24h)
});

// ---------- Live match money from Steam (steambot.js) ----------
// Each member who switched it on: the bot's friendship with them and their latest Wardogs status line from Steam.
// friend: none | requested | friends | blocked
export const livePresence = pgTable('live_presence', {
  user_id: integer().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  steam_id: text().notNull().default(''),
  opted_in: boolean().notNull().default(false),
  friend: text().notNull().default('none'),
  in_game: boolean().notNull().default(false),
  text: text().notNull().default(''), // e.g. "-$10,793 Loss"
  money: integer(),
  result: text().notNull().default(''), // win | loss | ''
  raw: jsonb().notNull().default({}),
  seen_at: timestamp({ withTimezone: true }),
  updated_at: timestamp({ withTimezone: true }),
  // The running profit / loss of the match in progress (Steam shows the match total; it goes back to $0 when the next
  // match starts). Saved as that match's result when it resets, or when they leave Wardogs.
  open_money: integer(),
  invite_link: text().notNull().default(''), // their own single-use Steam quick invite link to add the bot
  invite_expires: timestamp({ withTimezone: true }),
});
// Every finished match read from Steam (for "Tonight's money"): its final profit / loss. result: profit | loss
export const presenceResults = pgTable('presence_results', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  money: integer().notNull().default(0),
  result: text().notNull().default(''),
  text: text().notNull().default(''),
  at: now(),
}, (t) => [index('presence_results_at_idx').on(t.at)]);
// Every change of status line, raw, kept 3 days (for staff checking what Wardogs sends).
export const presenceLog = pgTable('presence_log', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  text: text().notNull().default(''),
  raw: jsonb().notNull().default({}),
  at: now(),
});

export const wardogsApiCache = pgTable('wardogs_api_cache', {
  player_id: text().primaryKey(),
  response: jsonb(),
  fetched_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const statDefs = pgTable('stat_defs', {
  key: text().primaryKey(),
  label: text().notNull(),
  format: text().notNull().default('number'),
  xp_each: numeric().notNull().default('0'),
  sort_order: integer().notNull().default(0),
});

export const userStats = pgTable('user_stats', {
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: text().notNull().references(() => statDefs.key, { onDelete: 'cascade', onUpdate: 'cascade' }),
  value: numeric().notNull().default('0'),
  updated_at: now(),
}, (t) => [primaryKey({ name: 'user_stats_pkey', columns: [t.user_id, t.key] })]);

// Steam achievements for tracked games (shown as medals), and who has unlocked them.
export const steamAchievements = pgTable('steam_achievements', {
  app_id: integer().notNull(),
  api_name: text().notNull(),
  name: text().notNull().default(''),
  description: text().notNull().default(''),
  icon: text().notNull().default(''),
  icon_gray: text().notNull().default(''),
  percent: numeric(),
  sort_order: integer().notNull().default(0),
}, (t) => [primaryKey({ name: 'steam_achievements_pkey', columns: [t.app_id, t.api_name] })]);

export const userAchievements = pgTable('user_achievements', {
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  app_id: integer().notNull(),
  api_name: text().notNull(),
  unlocked_at: timestamp({ withTimezone: true }),
}, (t) => [primaryKey({ name: 'user_achievements_pkey', columns: [t.user_id, t.app_id, t.api_name] })]);

// Unlocks per Wardogs class level (admin-maintained in Admin → Unlocks).
// role: recon | assault | medic | support | driver | pilot | career (Wardog level)
export const unlocks = pgTable('unlocks', {
  id: serial().primaryKey(),
  role: text().notNull(),
  level: integer().notNull(),
  name: text().notNull(),
  kind: text().notNull().default(''),
  cost: integer().notNull().default(0),
  // In-match buy price from the vendor once unlocked.
  vendor_price: integer().notNull().default(0),
  // 'tracker' rows are replaced by the daily WARDOGS Tracker sync; 'manual' rows are kept.
  source: text().notNull().default('manual'),
  image: text().notNull().default(''),
}, (t) => [index('unlocks_role_level_idx').on(t.role, t.level)]);

// Artillery firing tables (Admin → Artillery). table_data: one "range_m,elevation_mil" pair per line.
export const artillery = pgTable('artillery', {
  id: text().primaryKey(),
  label: text().notNull(),
  note: text().notNull().default(''),
  min_m: integer().notNull().default(0),
  max_m: integer().notNull().default(0),
  table_data: text().notNull().default(''),
  sort_order: integer().notNull().default(0),
});

// "Remember me" keys: let a device sign back in if its sign-in cookie is lost. Only a hash is stored.
export const rememberTokens = pgTable('remember_tokens', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  token_hash: text().notNull().unique('remember_tokens_token_hash_key'),
  created_at: now(),
  last_used: now(),
});

// Unlocks each member has ticked as bought (by class + name, so re-imports keep them).
export const userUnlocks = pgTable('user_unlocks', {
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text().notNull(),
  name: text().notNull(),
  created_at: now(),
}, (t) => [primaryKey({ name: 'user_unlocks_pkey', columns: [t.user_id, t.role, t.name] })]);

// Last counted total for each XP source per user (e.g. 'kills', 'stat:wins', 'game:1867240:minutes').
export const xpCounters = pgTable('xp_counters', {
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  source: text().notNull(),
  last_value: numeric().notNull().default('0'),
  updated_at: now(),
}, (t) => [primaryKey({ name: 'xp_counters_pkey', columns: [t.user_id, t.source] })]);

// Server leaderboard: totals per player on our game servers, counted from RCON (members and guests).
// steam_id is 'name:<in-game name>' for rows imported before the tracker had seen that player.
export const serverPlayers = pgTable('server_players', {
  server_id: integer().notNull(),
  steam_id: text().notNull(),
  name: text().notNull().default(''),
  kills: integer().notNull().default(0),
  deaths: integer().notNull().default(0),
  matches: integer().notNull().default(0),
  wins: integer().notNull().default(0),
  losses: integer().notNull().default(0),
  playtime_s: integer().notNull().default(0),
  last_seen: timestamp({ withTimezone: true }),
}, (t) => [primaryKey({ name: 'server_players_pkey', columns: [t.server_id, t.steam_id] })]);

// The tracker's memory of the match in progress, so a restart doesn't double count.
export const serverTrackState = pgTable('server_track_state', {
  server_id: integer().primaryKey(),
  state: jsonb().notNull().default({}),
  updated_at: now(),
});

// A queued map: the server's full rotation is saved here while the rotation is set to just the
// queued map, and put back once that map starts.
export const rotationQueue = pgTable('rotation_queue', {
  server_id: integer().primaryKey(),
  data: jsonb().notNull().default({}),
  created_at: now(),
});

// WPG server progression (WPG XP + the 200 ranks) as shown everywhere (leaderboard, profiles, Discord).
// Filled from the Discord bot, or by the app itself once Admin → WPG XP is switched over (see wpgxp.js).
// Separate from clan ranks / clan XP.
export const serverProgress = pgTable('server_progress', {
  steam_id: text().primaryKey(),
  bot_name: text().notNull().default(''),
  xp: integer().notNull().default(0),
  rank_level: integer().notNull().default(1),
  rank_name: text().notNull().default(''),
  synced_at: now(),
});

export const gameServers = pgTable('game_servers', {
  id: serial().primaryKey(),
  join_code: text().notNull().unique('game_servers_join_code_key'),
  name: text().notNull().default(''),
  description: text().notNull().default(''),
  rcon_url: text().notNull().default(''),
  rcon_password: text().notNull().default(''),
  enabled: boolean().notNull().default(true),
  wpg_xp: boolean().notNull().default(false), // matches here earn WPG XP
  sort_order: integer().notNull().default(0),
});

// ---------- WPG XP worked out by the app (wpgxp.js) ----------
// The WPG ranks in order (Recruit I … Wardog X): level 1 is the first, min_xp is the XP it starts at.
export const wpgRanks = pgTable('wpg_ranks', {
  level: integer().primaryKey(),
  name: text().notNull(),
  min_xp: integer().notNull().default(0),
});

// Each player's WPG XP as the app counts it. Before the switch-over it runs alongside the bot:
// gain / penalty / matches are what the app counted since the comparison started, bot_start the bot's XP then.
export const wpgXp = pgTable('wpg_xp', {
  steam_id: text().primaryKey(),
  name: text().notNull().default(''),
  xp: integer().notNull().default(0),
  best_level: integer().notNull().default(1), // highest rank reached (rank-ups are announced once)
  gain: integer().notNull().default(0),
  penalty: integer().notNull().default(0),
  matches: integer().notNull().default(0),
  bot_start: integer(),
  updated_at: now(),
});

// One row per player per match: how much WPG XP it gave or took, and why (detail).
export const wpgXpLog = pgTable('wpg_xp_log', {
  id: serial().primaryKey(),
  steam_id: text().notNull(),
  server_id: integer(),
  xp: integer().notNull().default(0),
  counted: boolean().notNull().default(false), // false = worked out alongside the bot (not added to anyone's XP)
  detail: jsonb().notNull().default({}),
  created_at: now(),
}, (t) => [index('wpg_xp_log_steam_idx').on(t.steam_id, t.created_at)]);

// ---------- Giveaways (giveaways.js) ----------
// kind: 'scheduled' (runs start → end, winners drawn at the end), 'drop' (random drops: at secret random
// times between start and end, one winner each from whoever is on the WPG server right then) or 'top'
// (top players on the WPG server during start → end, by `metric`, win by place).
// prizes: [{ type: item | clan_xp | wpg_xp | medal, text, amount, medal, count, codes: [sealed] }] in order:
// the first prize goes to the first winner / drop / place. (reward_* columns: giveaways made before prizes lists.)
// status: scheduled | open | done | cancelled
export const giveaways = pgTable('giveaways', {
  id: serial().primaryKey(),
  kind: text().notNull().default('scheduled'),
  title: text().notNull(),
  description: text().notNull().default(''),
  image: text().notNull().default(''),
  reward_type: text().notNull().default('item'),
  reward_text: text().notNull().default(''),
  reward_amount: integer().notNull().default(0),
  reward_medal: integer(),
  reward_codes: jsonb().notNull().default([]), // sealed codes / keys, one per winner (never sent to browsers)
  prizes: jsonb().notNull().default([]),
  metric: text().notNull().default(''), // top: kills | minutes | matches | wins | wpg_xp | rank
  drop_mode: text().notNull().default('random'), // drops: random (secret random times) | manual (only when staff trigger one)
  drop_to: text().notNull().default('one'), // drops: one (a random player who qualifies) | all (everyone who qualifies)
  drop_min_minutes: integer().notNull().default(0), // drops: minutes played in that match to qualify
  live_draw: boolean().notNull().default(false), // (no longer used: giveaways always draw at the end of their last match)
  // Giveaways run for a number of matches on the WPG server: they start with the next match (after start_at)
  // and draw at the end of the last one, among those on the server then.
  matches: integer().notNull().default(1),
  matches_done: integer().notNull().default(0),
  match_server: integer(),
  // Draws waiting for a match to end: drops [{ slot, at, server, pool: [steam ids] }] or { slot, retry_at } to try again.
  pending: jsonb().notNull().default([]),
  winners: integer().notNull().default(1),
  start_at: timestamp({ withTimezone: true }).notNull(),
  end_at: timestamp({ withTimezone: true }).notNull(),
  who: text().notNull().default('members'), // members (WPG members + staff) | everyone (PMCs too)
  no_staff: boolean().notNull().default(false),
  entry: text().notNull().default('enter'), // scheduled: enter (press Enter) | auto (everyone who qualifies)
  min_minutes: integer().notNull().default(0), // played on the WPG server during the giveaway
  min_matches: integer().notNull().default(0),
  min_kills: integer().notNull().default(0),
  fire_times: jsonb().notNull().default([]), // drops: the secret random times (never sent to members)
  fired: integer().notNull().default(0),
  claim_days: integer().notNull().default(7),
  in_game: boolean().notNull().default(true), // announce on the WPG server
  status: text().notNull().default('scheduled'),
  created_by: integer(),
  created_at: now(),
});

export const giveawayEntries = pgTable('giveaway_entries', {
  giveaway_id: integer().notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  created_at: now(),
}, (t) => [primaryKey({ name: 'giveaway_entries_pkey', columns: [t.giveaway_id, t.user_id] })]);

// status: given (XP / medal handed over automatically) | won (prize waiting to be claimed) | claimed | sent | expired
export const giveawayWinners = pgTable('giveaway_winners', {
  id: serial().primaryKey(),
  giveaway_id: integer().notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  code: text().notNull().default(''), // sealed
  prize_index: integer().notNull().default(0),
  prize: jsonb().notNull().default({}), // what they won: { type, text, amount, medal }
  place: integer(), // top players: their place
  score: integer(),
  status: text().notNull().default('won'),
  won_at: now(),
  claimed_at: timestamp({ withTimezone: true }),
  sent_at: timestamp({ withTimezone: true }),
}, (t) => [index('giveaway_winners_user_idx').on(t.user_id)]);

// ---------- Profile frames (frames.js) ----------
// Seasons follow the game's wipes. status: scheduled | active | ended.
export const seasons = pgTable('seasons', {
  id: serial().primaryKey(),
  number: integer().notNull(),
  name: text().notNull().default(''),
  start_at: timestamp({ withTimezone: true }).notNull(),
  end_at: timestamp({ withTimezone: true }),
  status: text().notNull().default('scheduled'),
});
// Everyone's WPG XP when a season started (season WPG XP = now minus this).
export const seasonStartXp = pgTable('season_start_xp', {
  season_id: integer().notNull(),
  steam_id: text().notNull(),
  xp: integer().notNull().default(0),
}, (t) => [primaryKey({ name: 'season_start_xp_pkey', columns: [t.season_id, t.steam_id] })]);
// Frame pictures admins upload (512 x 512, transparent middle), kept in the database because the host's disk is
// wiped on every deploy. data: the file, base64. Served at /frame-img/{id} (frames.js).
export const frameImages = pgTable('frame_images', {
  id: serial().primaryKey(),
  mime: text().notNull().default('image/png'),
  data: text().notNull(),
  width: integer().notNull().default(512),
  height: integer().notNull().default(512),
  bytes: integer().notNull().default(0),
  created_by: integer(),
  created_at: now(),
});
// category: permanent (kept forever) | clan (WPG members, while it applies) | season (earned again each season).
// metric + target: what earns it (frames.js METRICS); 'manual' = given by hand, 'placement' = a season placing.
export const frames = pgTable('frames', {
  id: serial().primaryKey(),
  key: text().notNull().default(''),
  name: text().notNull(),
  description: text().notNull().default(''),
  category: text().notNull().default('permanent'),
  style: text().notNull().default('metal-gold'),
  color: text().notNull().default(''),
  badge: text().notNull().default(''),
  label: text().notNull().default(''),
  crown: boolean().notNull().default(false),
  metric: text().notNull().default('manual'),
  target: numeric().notNull().default('0'),
  season_id: integer(), // season frames and placings: the season they're from
  image_id: integer(), // style 'image': an uploaded picture (frame_images)
  season_tag: boolean().notNull().default(true), // season frames: show S1, S2… in the bottom-left corner
  sort_order: integer().notNull().default(0),
  enabled: boolean().notNull().default(true),
  swept: boolean().notNull().default(false), // first check of everyone done (quietly, so a new frame doesn't flood Discord)
  created_at: now(),
});
// Frames members have earned. season_id: the season a season frame was earned in (0 for permanent ones).
export const userFrames = pgTable('user_frames', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  frame_id: integer().notNull().references(() => frames.id, { onDelete: 'cascade' }),
  season_id: integer().notNull().default(0),
  given_by: integer(),
  unlocked_at: now(),
}, (t) => [uniqueIndex('user_frames_once').on(t.user_id, t.frame_id, t.season_id)]);

export const sessions = pgTable('sessions', {
  sid: text().primaryKey(),
  sess: jsonb().notNull(),
  expire: timestamp({ withTimezone: true }).notNull(),
});

// ---------- Cheat watch (staff) ----------
// Steam's public ban records and account age for everyone who has played on the WPG server.
export const playerChecks = pgTable('player_checks', {
  steam_id: text().primaryKey(),
  vac_bans: integer().notNull().default(0),
  game_bans: integer().notNull().default(0),
  community_banned: boolean().notNull().default(false),
  days_since_last_ban: integer(),
  account_created: timestamp({ withTimezone: true }),
  checked_at: now(),
});

// One row per player per finished match on our server (from the server tracker).
export const matchPlayers = pgTable('match_players', {
  id: serial().primaryKey(),
  server_id: integer().notNull(),
  steam_id: text().notNull(),
  name: text().notNull().default(''),
  faction: text().notNull().default(''),
  kills: integer().notNull().default(0),
  deaths: integer().notNull().default(0),
  seconds: integer().notNull().default(0),
  won: boolean(),
  stayed: boolean(), // still on when the match ended (null: recorded before this was kept)
  ended_at: now(),
}, (t) => [index('match_players_steam_idx').on(t.steam_id)]);

// Play sessions (join to leave) from WarCon's history.
export const serverSessions = pgTable('server_sessions', {
  id: text().primaryKey(), // WarCon's session id
  steam_id: text().notNull(),
  name: text().notNull().default(''),
  joined_at: timestamp({ withTimezone: true }),
  last_seen: timestamp({ withTimezone: true }),
  left_at: timestamp({ withTimezone: true }),
  kills: integer().notNull().default(0),
  deaths: integer().notNull().default(0),
}, (t) => [index('server_sessions_steam_idx').on(t.steam_id)]);

// Kill events from the game server's kill feed (raw kept, plus the fields we could read).
export const killEvents = pgTable('kill_events', {
  id: serial().primaryKey(),
  received_at: now(),
  killer: text().notNull().default(''),
  victim: text().notNull().default(''),
  weapon: text().notNull().default(''),
  distance: numeric(),
  headshot: boolean(),
  raw: jsonb().notNull().default({}),
}, (t) => [index('kill_events_killer_idx').on(t.killer)]);

// Staff decisions: 'watch' (alert every time they join) or 'cleared' (checked, stop flagging).
export const playerWatch = pgTable('player_watch', {
  steam_id: text().primaryKey(),
  status: text().notNull().default('watch'),
  updated_by: integer(),
  updated_at: now(),
});

export const playerNotes = pgTable('player_notes', {
  id: serial().primaryKey(),
  steam_id: text().notNull(),
  author_id: integer(),
  text: text().notNull(),
  created_at: now(),
}, (t) => [index('player_notes_steam_idx').on(t.steam_id)]);

// Reports from members (app or Discord /report).
export const playerReports = pgTable('player_reports', {
  id: serial().primaryKey(),
  steam_id: text().notNull().default(''),
  name: text().notNull().default(''),
  reason: text().notNull().default(''),
  reporter_user_id: integer(),
  reporter_name: text().notNull().default(''),
  source: text().notNull().default('app'),
  status: text().notNull().default('open'),
  created_at: now(),
  closed_by: integer(),
  closed_at: timestamp({ withTimezone: true }),
});

// When each cheat-watch alert was last sent, so staff aren't spammed.
export const watchAlerts = pgTable('watch_alerts', {
  steam_id: text().notNull(),
  kind: text().notNull(),
  sent_at: now(),
}, (t) => [primaryKey({ name: 'watch_alerts_pkey', columns: [t.steam_id, t.kind] })]);

// ---------- Streams ----------
// A member's channel on Twitch, YouTube or Kick (one per platform). Staff approve it before it shows.
export const streamAccounts = pgTable('stream_accounts', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text().notNull(), // twitch | youtube | kick
  handle: text().notNull().default(''), // channel name / @handle / UC… id
  channel_id: text().notNull().default(''), // the platform's id for the channel (Twitch/Kick user id, YouTube UC…), found by the checker
  status: text().notNull().default('pending'), // pending | approved | rejected
  reviewed_by: integer(),
  reviewed_at: timestamp({ withTimezone: true }),
  // The member's stream key, encrypted. Write-only: no part of the app ever sends it back out.
  stream_key_enc: text().notNull().default(''),
  key_set_at: timestamp({ withTimezone: true }),
  is_live: boolean().notNull().default(false),
  manual: boolean().notNull().default(false), // set live by the streamer ("I'm live"), not found by the checker
  title: text().notNull().default(''),
  game: text().notNull().default(''),
  viewers: integer(),
  thumbnail: text().notNull().default(''),
  video_id: text().notNull().default(''), // YouTube video of the current stream (its chat needs it)
  live_url: text().notNull().default(''), // unused since Facebook was dropped
  live_since: timestamp({ withTimezone: true }),
  announced_at: timestamp({ withTimezone: true }),
  last_checked: timestamp({ withTimezone: true }),
  created_at: now(),
}, (t) => [uniqueIndex('stream_accounts_user_platform_key').on(t.user_id, t.platform)]);

// Discord activity per Discord account (discordactivity.js), counted from when tracking started. Credited to a member
// once they link their Discord with /link. messages: valid messages (no bots, commands, spam, repeats or deleted
// messages); voice_minutes: time in voice with someone else there (not deafened, not the AFK channel); boost_since:
// when their current Nitro boost started (Discord's own date; null when not boosting).
export const discordActivity = pgTable('discord_activity', {
  discord_id: text().primaryKey(),
  messages: integer().notNull().default(0),
  voice_minutes: integer().notNull().default(0),
  boost_since: timestamp({ withTimezone: true }),
  last_msg_at: timestamp({ withTimezone: true }),
  last_msg: text().notNull().default(''),
  updated_at: now(),
});
// Each server boost Discord announced (its "X just boosted the server" message): counted once per message.
export const discordBoosts = pgTable('discord_boosts', {
  message_id: text().primaryKey(),
  discord_id: text().notNull(),
  boosted_at: now(),
}, (t) => [index('discord_boosts_user_idx').on(t.discord_id)]);
// Who invited whom (from which invite link was used). Each new member is recorded once, ever, so leaving and
// rejoining never counts again. verified: still on the server 14 days later, a real person who passed the entry check.
export const discordRecruits = pgTable('discord_recruits', {
  member_id: text().primaryKey(),
  inviter_id: text().notNull(),
  invite_code: text().notNull().default(''),
  joined_at: now(),
  verified: boolean().notNull().default(false),
  rejected: text().notNull().default(''), // why it can't count (bot, own account, left, new account…)
}, (t) => [index('discord_recruits_inviter_idx').on(t.inviter_id)]);

// ---------- Collectible badges (badges.js) ----------
// A badge: artwork, rarity and Achievement Points, earned automatically from a tracked stat (rule 'stat:<stat>:<target>'),
// from a position ('role:staff' / 'role:admin', temporary: taken away when it stops applying) or given by staff ('').
export const badges = pgTable('badges', {
  id: serial().primaryKey(),
  key: text().notNull().default(''), // starter set key (empty for badges staff make)
  name: text().notNull(),
  description: text().notNull().default(''),
  category: text().notNull().default('other'), // streaming | nitro | loyalty | chat | voice | recruitment | events | special | wardogs | other
  series: text().notNull().default(''),
  rarity: text().notNull().default('common'), // common | uncommon | rare | epic | legendary | mythic | exclusive
  points: integer().notNull().default(10),
  rule: text().notNull().default(''),
  temporary: boolean().notNull().default(false),
  limited: boolean().notNull().default(false), // shows "Limited edition"
  image_id: integer(),
  sort_order: integer().notNull().default(0),
  enabled: boolean().notNull().default(true),
  swept: boolean().notNull().default(false), // first quiet check of everyone done (so a new badge never floods Discord)
  created_at: now(),
});
export const userBadges = pgTable('user_badges', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  badge_id: integer().notNull().references(() => badges.id, { onDelete: 'cascade' }),
  given_by: integer(),
  reason: text().notNull().default(''),
  earned_at: now(),
}, (t) => [uniqueIndex('user_badges_once').on(t.user_id, t.badge_id)]);
// Badge artwork (kept in the database: the host's disk is wiped on every deploy).
export const badgeImages = pgTable('badge_images', {
  id: serial().primaryKey(),
  mime: text().notNull(),
  data: text().notNull(), // base64
  created_at: now(),
});
// Official WPG events and tournaments, with who attended and who won (Admin → Events & tournaments).
export const wpgEvents = pgTable('wpg_events', {
  id: serial().primaryKey(),
  name: text().notNull(),
  kind: text().notNull().default('event'), // event | tournament
  held_at: timestamp({ withTimezone: true }).notNull(),
  notes: text().notNull().default(''),
  created_by: integer(),
  created_at: now(),
});
export const wpgEventPeople = pgTable('wpg_event_people', {
  event_id: integer().notNull().references(() => wpgEvents.id, { onDelete: 'cascade' }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  won: boolean().notNull().default(false),
}, (t) => [primaryKey({ name: 'wpg_event_people_pkey', columns: [t.event_id, t.user_id] })]);

// Verified stream history: one row per stream the checker saw live on the platform's own API (Twitch, YouTube, Kick).
// "I'm live" button presses are never recorded (they can't be verified). Reconnects within a few minutes continue the
// same row. ended_at is null while live; the stream counts from started_at to last_seen_at (streams.js, trackstats.js).
export const streamSessions = pgTable('stream_sessions', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  account_id: integer().notNull(),
  platform: text().notNull(),
  stream_ref: text().notNull().default(''), // the platform's id for this stream (Twitch stream id, YouTube video id, Kick start time)
  started_at: timestamp({ withTimezone: true }).notNull(),
  last_seen_at: timestamp({ withTimezone: true }).notNull(),
  ended_at: timestamp({ withTimezone: true }),
}, (t) => [index('stream_sessions_user_idx').on(t.user_id), index('stream_sessions_account_idx').on(t.account_id)]);

// WPG's own chat under each streamer's stream (shared by all their platforms).
export const streamMessages = pgTable('stream_messages', {
  id: serial().primaryKey(),
  streamer_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  user_id: integer().references(() => users.id, { onDelete: 'cascade' }),
  body: text().notNull(),
  deleted: boolean().notNull().default(false),
  created_at: now(),
}, (t) => [index('stream_messages_streamer_idx').on(t.streamer_id, t.id.desc())]);

// Members' own Twitch / Kick sign-ins, so they can chat in streams as themselves from the app.
// Tokens are encrypted (secretbox.js) and only ever used by the server.
export const chatLogins = pgTable('chat_logins', {
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text().notNull(), // twitch | kick
  platform_user_id: text().notNull().default(''),
  login: text().notNull().default(''),
  display_name: text().notNull().default(''),
  access_enc: text().notNull().default(''),
  refresh_enc: text().notNull().default(''),
  expires_at: timestamp({ withTimezone: true }),
  created_at: now(),
}, (t) => [primaryKey({ name: 'chat_logins_pkey', columns: [t.user_id, t.platform] })]);

// ---------- Combat Command (recruitment, units, postings) ----------
// Units of the WPG force (COMMAND, ALPHA, BRAVO, EYE…). roles: [{ id, name, slots, leader }] in order;
// for the command unit the order is the line of succession (CO → XO → Deputies).
export const combatUnits = pgTable('combat_units', {
  id: serial().primaryKey(),
  name: text().notNull(),
  kind: text().notNull().default('combat'), // command | combat | support
  label: text().notNull().default(''), // e.g. "HZ Assault"
  mission: text().notNull().default(''),
  color: text().notNull().default('#29b6f6'),
  roles: jsonb().notNull().default([]),
  sort_order: integer().notNull().default(0),
});

// Where each member is posted: one unit + role (role_id from the unit's roles list).
export const combatPostings = pgTable('combat_postings', {
  user_id: integer().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  unit_id: integer().notNull(),
  role_id: text().notNull().default(''),
  assigned_by: integer(),
  assigned_at: now(),
});

// Each member's specialties: primary role, secondary (backup) role and other qualifications.
export const combatProfiles = pgTable('combat_profiles', {
  user_id: integer().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  primary_role: text().notNull().default(''),
  secondary_role: text().notNull().default(''),
  qualifications: jsonb().notNull().default([]),
  leadership: boolean().notNull().default(false),
  pilot: boolean().notNull().default(false),
  availability: text().notNull().default(''),
  region: text().notNull().default(''),
  updated_at: now(),
});

// Applications to join a unit / take a role. status: new | accepted | declined | withdrawn
export const recruitApplications = pgTable('recruit_applications', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text().notNull().default('new'),
  primary_role: text().notNull().default(''),
  secondary_role: text().notNull().default(''),
  skills: jsonb().notNull().default([]),
  leadership: boolean().notNull().default(false),
  pilot: boolean().notNull().default(false),
  availability: text().notNull().default(''),
  region: text().notNull().default(''),
  notes: text().notNull().default(''),
  created_at: now(),
  reviewed_by: integer(),
  reviewed_at: timestamp({ withTimezone: true }),
  decision_note: text().notNull().default(''),
  unit_id: integer(),
  role_id: text().notNull().default(''),
}, (t) => [index('recruit_applications_user_idx').on(t.user_id)]);

// PMCs (guests) ask before they can apply. status: pending | allowed | declined | used
export const applyRequests = pgTable('apply_requests', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  message: text().notNull().default(''),
  status: text().notNull().default('pending'),
  created_at: now(),
  reviewed_by: integer(),
  reviewed_at: timestamp({ withTimezone: true }),
  note: text().notNull().default(''),
}, (t) => [index('apply_requests_user_idx').on(t.user_id)]);

// ---------- Situation rooms ----------
// A shared tactical map for one group in a match. At most one open room per faction (Lonestar, Valkyra, Manticore),
// so at most 3 at once. WPG members only (not PMC guests).
export const sitRooms = pgTable('sit_rooms', {
  id: serial().primaryKey(),
  faction: text().notNull(), // lonestar | valkyra | manticore
  name: text().notNull().default(''),
  map_id: text().notNull().default(''),
  creator_id: integer().references(() => users.id, { onDelete: 'set null' }),
  status: text().notNull().default('open'), // open | closed
  created_at: now(),
  last_active_at: now(),
  closed_at: timestamp({ withTimezone: true }),
  closed_by: integer(),
}, (t) => [index('sit_rooms_status_idx').on(t.status)]);

export const sitMembers = pgTable('sit_members', {
  room_id: integer().notNull().references(() => sitRooms.id, { onDelete: 'cascade' }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  joined_at: now(),
  last_seen: now(),
}, (t) => [primaryKey({ name: 'sit_members_pkey', columns: [t.room_id, t.user_id] })]);

// Waiting invites (sent by the room's creator or an admin) and requests to join (sent by the member).
export const sitRequests = pgTable('sit_requests', {
  room_id: integer().notNull().references(() => sitRooms.id, { onDelete: 'cascade' }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text().notNull(), // invite | ask
  from_id: integer(),
  created_at: now(),
}, (t) => [primaryKey({ name: 'sit_requests_pkey', columns: [t.room_id, t.user_id] })]);

// Everything on a room's map: markers (position, FOB, enemy, need, objective, danger) and drawings (arrows,
// lines, routes, areas, labels). Positions are in-game map units, like the arty map.
export const sitItems = pgTable('sit_items', {
  id: serial().primaryKey(),
  room_id: integer().notNull().references(() => sitRooms.id, { onDelete: 'cascade' }),
  user_id: integer().references(() => users.id, { onDelete: 'set null' }),
  kind: text().notNull(), // marker | draw
  type: text().notNull(),
  data: jsonb().notNull().default({}),
  created_at: now(),
  updated_at: now(),
  expires_at: timestamp({ withTimezone: true }),
}, (t) => [index('sit_items_room_idx').on(t.room_id)]);

// Quick text messages inside a situation room (deleted when the room closes).
export const sitMessages = pgTable('sit_messages', {
  id: serial().primaryKey(),
  room_id: integer().notNull().references(() => sitRooms.id, { onDelete: 'cascade' }),
  user_id: integer().references(() => users.id, { onDelete: 'set null' }),
  body: text().notNull(),
  created_at: now(),
}, (t) => [index('sit_messages_room_idx').on(t.room_id, t.id.desc())]);

// A copy of a room's board each time it's cleared (new match, map change, room closed), for admins. Kept 14 days.
export const sitArchives = pgTable('sit_archives', {
  id: serial().primaryKey(),
  room_id: integer(),
  faction: text().notNull().default(''),
  name: text().notNull().default(''),
  map_id: text().notNull().default(''),
  reason: text().notNull().default(''),
  items: jsonb().notNull().default([]),
  members: jsonb().notNull().default([]),
  messages: jsonb().notNull().default([]),
  created_at: now(),
});
