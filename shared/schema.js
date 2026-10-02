// The WPG database layout (Drizzle ORM). This file is the single source of truth:
// the app syncs the database to it on every start (adding only, never deleting),
// and `npm run db:push` does the same by hand.
import {
  pgTable, serial, text, integer, boolean, jsonb, timestamp, numeric, primaryKey, index,
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
  steam_private: boolean().notNull().default(false),
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

export const awards = pgTable('awards', {
  id: serial().primaryKey(),
  name: text().notNull(),
  description: text().notNull().default(''),
  colors: text().notNull().default('#1f3a93,#ffffff,#b22234'),
  sort_order: integer().notNull().default(0),
  // Automatic medal rule, e.g. 'class:assault:20' (class level) or 'hours:300' (hours played). Empty = given by hand.
  auto_rule: text().notNull().default(''),
});

export const userAwards = pgTable('user_awards', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  award_id: integer().notNull().references(() => awards.id, { onDelete: 'cascade' }),
  given_by: integer().references(() => users.id, { onDelete: 'set null' }),
  reason: text().notNull().default(''),
  given_at: now(),
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
  // Worldwide ranks: { id, name, tag, level, worth, cash, total }
  ranks: jsonb(),
  ranks_synced: timestamp({ withTimezone: true }),
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

// WPG server progression (WPG XP + the 200 ranks), copied from the Discord bot, which is the source
// of truth. The app never works these out itself. Separate from clan ranks / clan XP.
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
  sort_order: integer().notNull().default(0),
});

export const sessions = pgTable('sessions', {
  sid: text().primaryKey(),
  sess: jsonb().notNull(),
  expire: timestamp({ withTimezone: true }).notNull(),
});
