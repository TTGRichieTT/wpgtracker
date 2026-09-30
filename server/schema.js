export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ranks (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  abbr TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  min_xp INT NOT NULL DEFAULT 0,
  auto BOOLEAN NOT NULL DEFAULT true,
  color TEXT NOT NULL DEFAULT '#c9a227',
  insignia JSONB NOT NULL DEFAULT '{}',
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  steam_id TEXT UNIQUE NOT NULL,
  persona_name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  profile_url TEXT NOT NULL DEFAULT '',
  callsign TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  custom_avatar TEXT NOT NULL DEFAULT '',
  banner_color TEXT NOT NULL DEFAULT '#3b4a2f',
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',
  rank_id INT REFERENCES ranks(id) ON DELETE SET NULL,
  rank_locked BOOLEAN NOT NULL DEFAULT false,
  xp INT NOT NULL DEFAULT 0,
  bonus_xp INT NOT NULL DEFAULT 0,
  muted_until TIMESTAMPTZ,
  custom_fields JSONB NOT NULL DEFAULT '{}',
  steam_private BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS friends (
  requester_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  min_role TEXT NOT NULL DEFAULT 'member',
  read_only BOOLEAN NOT NULL DEFAULT false,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  channel_id INT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages(channel_id, id DESC);

CREATE TABLE IF NOT EXISTS dms (
  id SERIAL PRIMARY KEY,
  sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dms_pair_idx ON dms(sender_id, recipient_id, id DESC);
CREATE INDEX IF NOT EXISTS dms_recipient_idx ON dms(recipient_id, read_at);

CREATE TABLE IF NOT EXISTS games (
  app_id INT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  featured BOOLEAN NOT NULL DEFAULT false,
  xp_per_hour INT NOT NULL DEFAULT 10,
  xp_per_achievement INT NOT NULL DEFAULT 25,
  stat_labels TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS user_games (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id INT NOT NULL REFERENCES games(app_id) ON DELETE CASCADE,
  playtime_forever INT NOT NULL DEFAULT 0,
  playtime_2weeks INT NOT NULL DEFAULT 0,
  ach_unlocked INT NOT NULL DEFAULT 0,
  ach_total INT NOT NULL DEFAULT 0,
  stats JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app_id)
);

CREATE TABLE IF NOT EXISTS awards (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  colors TEXT NOT NULL DEFAULT '#1f3a93,#ffffff,#b22234',
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_awards (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  award_id INT NOT NULL REFERENCES awards(id) ON DELETE CASCADE,
  given_by INT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  given_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  pinned BOOLEAN NOT NULL DEFAULT false,
  author_id INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile_fields (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  options TEXT NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wardogs_stats (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  official JSONB,
  official_synced TIMESTAMPTZ,
  server JSONB,
  server_synced TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stat_defs (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'number',
  xp_each NUMERIC NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_stats (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL REFERENCES stat_defs(key) ON DELETE CASCADE ON UPDATE CASCADE,
  value NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
`;

const DEFAULT_SETTINGS = {
  clan_name: '[WPG] Wasted Prodigy Gamers',
  clan_tag: 'WPG',
  motto: 'Two nations. One squad.',
  welcome_message:
    'Welcome to the WPG barracks, soldier. Link up with your squad, check your rank, and get on comms.',
  require_approval: 'true',
  auto_promote: 'true',
  announce_promotions: 'true',
  dm_friends_only: 'false',
  sync_minutes: '60',
  discord_invite: '',
  accent_color: '#29b6f6',
  logo_url: '/img/logo.svg',
  tracker_enabled: 'true',
  tracker_server: '',
  xp_per_server_kill: '2',
};

// Insignia combine US and UK army symbols:
// chevrons point up (US), rockers (US), crown (UK), pips / Bath stars (UK),
// bars + oak leaf (US), general stars (US), crossed sword & baton (UK), wreath (both).
const DEFAULT_RANKS = [
  ['Recruit', 'RCT', 0, true, '#8a8f7a', {}, 'Fresh off the bus. Welcome to WPG.'],
  ['Private', 'PVT', 100, true, '#c9a227', { chevrons: 1 }, ''],
  ['Lance Corporal', 'LCPL', 300, true, '#c9a227', { chevrons: 1, rockers: 1 }, ''],
  ['Corporal', 'CPL', 600, true, '#c9a227', { chevrons: 2 }, ''],
  ['Sergeant', 'SGT', 1000, true, '#c9a227', { chevrons: 3 }, ''],
  ['Staff Sergeant', 'SSGT', 1600, true, '#c9a227', { chevrons: 3, rockers: 1, crown: true }, ''],
  ['Colour Sergeant', 'CSGT', 2500, true, '#c9a227', { chevrons: 3, rockers: 2, crown: true }, ''],
  ['Sergeant Major', 'SGM', 4000, true, '#c9a227', { chevrons: 3, rockers: 3, stars: 1 }, ''],
  ['Warrant Officer', 'WO', 0, false, '#c9a227', { crown: true, wreath: true }, 'Appointed by command.'],
  ['Second Lieutenant', '2LT', 0, false, '#d4af37', { bars: 1, pips: 1, metal: 'gold' }, 'Appointed by command.'],
  ['Lieutenant', 'LT', 0, false, '#c0c6cc', { bars: 1, pips: 2, metal: 'silver' }, 'Appointed by command.'],
  ['Captain', 'CPT', 0, false, '#c0c6cc', { bars: 2, pips: 3, metal: 'silver' }, 'Appointed by command.'],
  ['Major', 'MAJ', 0, false, '#d4af37', { oak: true, crown: true, metal: 'gold' }, 'Appointed by command.'],
  ['Lieutenant Colonel', 'LTC', 0, false, '#c0c6cc', { oak: true, crown: true, pips: 1, metal: 'silver' }, 'Appointed by command.'],
  ['Colonel', 'COL', 0, false, '#c0c6cc', { crown: true, pips: 2, wreath: true, metal: 'silver' }, 'Appointed by command.'],
  ['Brigadier', 'BRIG', 0, false, '#c0c6cc', { stars: 1, crown: true, pips: 3, metal: 'silver' }, 'Appointed by command.'],
  ['Major General', 'MG', 0, false, '#c0c6cc', { stars: 2, pips: 1, swords: true, metal: 'silver' }, 'Appointed by command.'],
  ['General', 'GEN', 0, false, '#c0c6cc', { stars: 4, crown: true, swords: true, metal: 'silver' }, 'Appointed by command.'],
  ['Clan Commander', 'CDR', 0, false, '#d4af37', { stars: 5, crown: true, swords: true, wreath: true, metal: 'gold' }, 'Leader of WPG.'],
];

export async function seed({ q, one }) {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [key, value]);
  }
  const done = await one("SELECT value FROM settings WHERE key = '_seeded'");
  if (done) return;

  let order = 0;
  for (const [name, abbr, minXp, auto, color, insignia, description] of DEFAULT_RANKS) {
    await q(
      'INSERT INTO ranks (name, abbr, sort_order, min_xp, auto, color, insignia, description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [name, abbr, (order += 10), minXp, auto, color, JSON.stringify(insignia), description],
    );
  }
  const channels = [
    ['general', 'Main comms for the whole clan', 'member'],
    ['wardogs', 'Wardogs chat, tactics and clips', 'member'],
    ['looking-for-group', 'Find a squad and get in game', 'member'],
    ['staff-room', 'Mods and admins only', 'mod'],
  ];
  order = 0;
  for (const [name, description, minRole] of channels) {
    await q('INSERT INTO channels (name, description, min_role, sort_order) VALUES ($1,$2,$3,$4)', [
      name, description, minRole, (order += 10),
    ]);
  }
  await q(
    "INSERT INTO games (app_id, name, enabled, featured, stat_labels) VALUES (1867240, 'WARDOGS', true, true, '') ON CONFLICT DO NOTHING",
  );
  const awards = [
    ['Founding Member', 'Was here when WPG began.', '#1f3a93,#ffffff,#b22234,#ffffff,#1f3a93'],
    ['Wardogs Veteran', '100+ hours in Wardogs.', '#3b4a2f,#c9a227,#3b4a2f'],
    ['Squad Leader', 'Led a squad to victory.', '#b22234,#1f3a93,#b22234'],
    ['Good Conduct', 'A model soldier on and off comms.', '#7a1f1f,#ffffff,#7a1f1f'],
  ];
  order = 0;
  for (const [name, description, colors] of awards) {
    await q('INSERT INTO awards (name, description, colors, sort_order) VALUES ($1,$2,$3,$4)', [
      name, description, colors, (order += 10),
    ]);
  }
  await q(
    "INSERT INTO profile_fields (key, label, type, options, sort_order) VALUES ('discord', 'Discord name', 'text', '', 5), ('main_role', 'Main role', 'select', 'Rifleman,Medic,Sniper,Support,Engineer,Squad Lead', 10), ('platform', 'Platform', 'select', 'PC,Steam Deck', 20) ON CONFLICT DO NOTHING",
  );
  await q(
    `INSERT INTO stat_defs (key, label, format, xp_each, sort_order) VALUES
      ('matches', 'Matches', 'number', 3, 10),
      ('wins', 'Wins', 'number', 10, 20),
      ('losses', 'Losses', 'number', 0, 30),
      ('playtime_minutes', 'Playtime', 'minutes', 0.1, 40)
     ON CONFLICT DO NOTHING`,
  );
  await q("INSERT INTO settings (key, value) VALUES ('_seeded', 'true')");
}
