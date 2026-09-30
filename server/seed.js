// Starter data for a new database: settings, ranks, channels, medals, stats and the WPG server.
// The table layout itself lives in shared/schema.js.
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
  discord_invite: 'https://discord.gg/wxMWWQNxUJ',
  discord_server_id: '',
  discord_voice_enabled: 'true',
  accent_color: '#29b6f6',
  logo_url: '/img/brand/wpg-logo.webp',
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
  // Added after launch, so it has its own flag (and stays deleted if an admin removes it).
  if (!(await one("SELECT value FROM settings WHERE key = '_seeded_servers'"))) {
    await q(
      `INSERT INTO game_servers (join_code, name, description, sort_order)
       VALUES ('bf019b3b-7670-4879-9220-b541edc58e1b', 'WPG Wardogs', 'Our main Wardogs server. Real players, real squads.', 10)
       ON CONFLICT (join_code) DO NOTHING`,
    );
    await q("INSERT INTO settings (key, value) VALUES ('_seeded_servers', 'true') ON CONFLICT DO NOTHING");
  }

  // Fill in the WPG Discord invite once for databases made before it was the default.
  if (!(await one("SELECT value FROM settings WHERE key = '_seeded_discord'"))) {
    await q("UPDATE settings SET value = $1 WHERE key = 'discord_invite' AND COALESCE(value, '') = ''", [DEFAULT_SETTINGS.discord_invite]);
    await q("INSERT INTO settings (key, value) VALUES ('_seeded_discord', 'true') ON CONFLICT DO NOTHING");
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
