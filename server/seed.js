import fs from 'node:fs';
import { starterMedals } from './medals.js';

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
  xp_event_message: '',
  // Barracks Discord bot: automatic posts (channel ID empty = no posts).
  discord_post_channel: '',
  discord_post_promotions: 'true',
  discord_post_medals: 'true',
  discord_post_wpg_ranks: 'true',
  // Cheat watch: staff-only alerts (Discord channel ID empty = app alerts only).
  discord_staff_channel: '',
  cheat_alerts: 'true',
  cheat_live_kills: '15',
  // Streams: Discord post when an approved streamer goes live (channel ID empty = no posts).
  discord_stream_channel: '',
  discord_post_streams: 'true',
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

const OLD_STARTER = ['Galil', 'M4', 'FAL', 'MP5', 'PP-19 50-round drum', 'Super-45', 'SV98', 'MK22', 'Large Hammer', 'M500', 'M249 SAW', 'PKM',
  'URAL', 'Dune Buggy', 'Heavy Tank', 'Z20 Lakota', 'Level 1 Armor & Helmet', 'Field Backpack', 'Level 2 Armor & Helmet',
  'Level 3 Armor & Helmet', 'Deagle', 'Artillery Tank', 'Arsenal Backpack'];

// Reads a bundled data file. If it's missing the import is skipped (and retried next start) instead of crashing.
function readData(name) {
  try {
    return JSON.parse(fs.readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8'));
  } catch (e) {
    console.warn(`[seed] Skipping import of server/data/${name}: ${e.message}`);
    return null;
  }
}

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
  // One-off imports, stored in our own database from then on (admins edit them in Admin):
  //  - unlocks: full WARDOGS progression, from WARDOGS Tracker (used with permission), pictures in public/img/unlocks
  //  - artillery: firing tables from wardogs-calculator by Apollyon (MIT licence, server/data/LICENSE-wardogs-calculator.txt)
  if (!(await one("SELECT value FROM settings WHERE key = '_imported_unlocks_v2'"))) {
    const unlocks = readData('unlocks.json');
    if (unlocks) {
    // Replace the old short starter list (and any earlier test import); keep anything admins added themselves.
    await q("DELETE FROM unlocks WHERE source <> 'manual' OR name = ANY($1)", [OLD_STARTER]);
    for (const u of unlocks) {
      await q("INSERT INTO unlocks (role, level, name, kind, cost, vendor_price, image, source) VALUES ($1,$2,$3,$4,$5,$6,$7,'import')",
        [u.role, u.level, u.name, u.kind, u.cost, u.price || 0, u.image]);
    }
    await q("INSERT INTO settings (key, value) VALUES ('_imported_unlocks_v2', 'true') ON CONFLICT DO NOTHING");
    }
  }
  if (!(await one("SELECT value FROM settings WHERE key = '_imported_artillery'"))) {
    const data = readData('firing-tables.json');
    if (data) {
    const gun = (id) => data.weapons.find((w) => w.id === id);
    const lines = (pairs) => pairs.map(([r, m]) => `${r},${m}`).join('\n');
    const mortar = gun('mortar');
    const sph = gun('spg');
    const rows = [
      ['l81', 'L81 Mortar', 'High angle only', Math.round(mortar.minRangeKm * 1000), Math.round(mortar.maxRangeKm * 1000), lines(mortar.ballistics.single), 10],
      ['sph-low', 'SPH-2 · Low arc', 'Faster, flatter', Math.min(...sph.ballistics.low.map(([r]) => r)), Math.max(...sph.ballistics.low.map(([r]) => r)), lines(sph.ballistics.low), 20],
      ['sph-high', 'SPH-2 · High arc', 'Over cover', Math.round(sph.minRangeKm * 1000), Math.max(...sph.ballistics.high.map(([r]) => r)), lines(sph.ballistics.high), 30],
    ];
    for (const r of rows) {
      await q(`INSERT INTO artillery (id, label, note, min_m, max_m, table_data, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (id) DO NOTHING`, r);
    }
    await q("INSERT INTO settings (key, value) VALUES ('_imported_artillery', 'true') ON CONFLICT DO NOTHING");
    }
  }

  // Automatic medals: class levels 10-50 and 100-500 hours played (added once; admins can edit them).
  if (!(await one("SELECT value FROM settings WHERE key = '_seeded_auto_medals'"))) {
    for (const m of starterMedals()) {
      await q('INSERT INTO awards (name, description, colors, sort_order, auto_rule) VALUES ($1,$2,$3,$4,$5)',
        [m.name, m.description, m.colors, m.sort_order, m.auto_rule]);
    }
    await q("INSERT INTO settings (key, value) VALUES ('_seeded_auto_medals', 'true') ON CONFLICT DO NOTHING");
  }

  // Profile box used to find a member's worldwide rank when their in-game name differs from Steam.
  if (!(await one("SELECT value FROM settings WHERE key = '_seeded_wardogs_name'"))) {
    await q("INSERT INTO profile_fields (key, label, type, options, sort_order) VALUES ('wardogs_name', 'Wardogs in-game name (e.g. Richie_TT#6201)', 'text', '', 3) ON CONFLICT (key) DO NOTHING");
    await q("INSERT INTO settings (key, value) VALUES ('_seeded_wardogs_name', 'true') ON CONFLICT DO NOTHING");
  }

  // Server leaderboard starting data (from the Discord bot's leaderboard, 1 Oct 2026). Rows join up with
  // the real player when the tracker first sees that name on the server.
  if (!(await one("SELECT value FROM settings WHERE key = '_seeded_server_board'"))) {
    const wpg = await one("SELECT id FROM game_servers WHERE join_code = 'bf019b3b-7670-4879-9220-b541edc58e1b'");
    if (wpg) {
      const start = [
        ['[WPG] Ninjas Dynasty', 3, 33], ['[WPG] Fang1127', 1, 27], ['[WPG] Joshy', 3, 20], ['Cadicristein', 2, 18],
        ['[WPG] Richie_TT', 1, 12], ['Bodo', 1, 8], ['NoxLVR', 1, 6], ['[WPG] Gus Gallows', 1, 6], ['[WPG] mrtacosauce', 1, 8],
        ['lithocreations', 1, 7], ['mrbrandywine', 1, 6], ['(Nirvana) AVERAGE PE', 0, 0], ['- HAGGARD', 0, 0], ['-0-PERKY-0-', 0, 0],
      ];
      for (const [name, matches, mins] of start) {
        await q(`INSERT INTO server_players (server_id, steam_id, name, matches, playtime_s) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT DO NOTHING`, [wpg.id, `name:${name}`, name, matches, mins * 60]);
      }
    }
    await q("INSERT INTO settings (key, value) VALUES ('_seeded_server_board', 'true') ON CONFLICT DO NOTHING");
  }

  // Server leaderboard: 19 players with Steam IDs (list from 1 Oct 2026). Merged with any existing row by
  // keeping the higher number, so nothing is counted twice. Members link up by Steam ID automatically.
  if (!(await one("SELECT value FROM settings WHERE key = '_seeded_server_board_v2'"))) {
    const wpg = await one("SELECT id FROM game_servers WHERE join_code = 'bf019b3b-7670-4879-9220-b541edc58e1b'");
    if (wpg) {
      // [name, steam id, minutes played, visits, kills, deaths, last seen]
      const list = [
        ['[WPG] Richie_TT', '76561198809535860', 312, 1, 0, 0, '2026-10-01T07:13:44Z'],
        ['[WPG] looper', '76561199046396052', 75, 5, 0, 0, '2026-10-01T03:00:42Z'],
        ['[WPG] Joshy', '76561198076671525', 64, 2, 0, 0, '2026-10-01T03:00:30Z'],
        ['Tempyst Mage', '76561198009221727', 55, 1, 0, 0, '2026-10-01T03:00:22Z'],
        ['Baron', '76561198062063394', 48, 2, 0, 0, '2026-10-01T03:06:24Z'],
        ['[WPG] Ninjas Dynasty', '76561198099451925', 8, 1, 0, 0, '2026-10-01T17:52:53Z'],
        ['Colonel_Cracker', '76561199108691306', 4, 1, 0, 0, '2026-10-01T02:45:46Z'],
        ['tacoslocos0_o', '76561198092757762', 2, 1, 0, 0, '2026-10-01T02:38:16Z'],
        ['swagbluntz', '76561199073399382', 1, 1, 0, 0, '2026-10-01T02:43:32Z'],
        ['rileyegore', '76561199744829128', 1, 1, 0, 0, '2026-10-01T02:46:30Z'],
        ['I3lankSPACE', '76561199059898810', 1, 1, 0, 0, '2026-10-01T02:46:30Z'],
        ['drewbies02', '76561199712686870', 1, 1, 0, 0, '2026-10-01T02:57:58Z'],
        ['McSwaqqy', '76561198909765832', 1, 2, 0, 0, '2026-10-01T02:47:02Z'],
        ['daithi2', '76561197979363017', 1, 2, 0, 0, '2026-10-01T06:10:24Z'],
        ['[BLU] lemonroadanthony', '76561198818415348', 1, 1, 0, 0, '2026-09-30T22:07:28Z'],
        ['Mellowerx', '76561198313135353', 0, 1, 0, 0, '2026-10-01T02:58:08Z'],
        ['Simple_surmise', '76561198084029677', 0, 1, 0, 0, '2026-10-01T06:05:42Z'],
        ['Gator', '76561198113368264', 0, 1, 0, 0, '2026-10-01T00:56:15Z'],
        ['[843] Vodka Champion', '76561199876427913', 0, 0, 0, 0, null],
      ];
      for (const [name, sid, mins, visits, kills, deaths, seen] of list) {
        // Fold in a row imported earlier by name (from the screenshot), keeping the higher numbers.
        const byName = await one('SELECT * FROM server_players WHERE server_id=$1 AND steam_id=$2', [wpg.id, `name:${name}`]);
        await q(
          `INSERT INTO server_players (server_id, steam_id, name, kills, deaths, matches, playtime_s, last_seen)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (server_id, steam_id) DO UPDATE SET
             kills=GREATEST(server_players.kills, EXCLUDED.kills), deaths=GREATEST(server_players.deaths, EXCLUDED.deaths),
             matches=GREATEST(server_players.matches, EXCLUDED.matches), playtime_s=GREATEST(server_players.playtime_s, EXCLUDED.playtime_s),
             last_seen=GREATEST(server_players.last_seen, EXCLUDED.last_seen)`,
          [wpg.id, sid, name, kills, deaths, Math.max(visits, byName?.matches || 0), Math.max(mins * 60, byName?.playtime_s || 0), seen],
        );
        if (byName) await q('DELETE FROM server_players WHERE server_id=$1 AND steam_id=$2', [wpg.id, `name:${name}`]);
      }
    }
    await q("INSERT INTO settings (key, value) VALUES ('_seeded_server_board_v2', 'true') ON CONFLICT DO NOTHING");
  }

  // Streams now use each platform's own chat box, so the app no longer keeps members' Twitch / YouTube /
  // Kick chat sign-ins. Delete the stored (encrypted) tokens once.
  if (!(await one("SELECT value FROM settings WHERE key = '_cleared_chat_logins'"))) {
    await q('DELETE FROM chat_logins').catch(() => {});
    await q("INSERT INTO settings (key, value) VALUES ('_cleared_chat_logins', 'true') ON CONFLICT DO NOTHING");
  }

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
