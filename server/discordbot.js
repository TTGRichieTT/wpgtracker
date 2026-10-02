// WPG Barracks Discord bot. Slash commands are answered by this app: Discord sends each command to
// POST /discord/interactions, so no always-on bot connection is needed. It also posts promotions,
// medals and WPG rank-ups to a channel set in Admin → Settings.
// The app ID and public key below are public by design (the key only checks that messages really come
// from Discord). The bot token is a password: it lives only in the host's environment as DISCORD_BOT_TOKEN.
// DISCORD_APP_ID / DISCORD_PUBLIC_KEY in the environment override the built-in ones (e.g. a new Discord app).
import express from 'express';
import crypto from 'crypto';
import { q, one, setting, flag } from './db.js';
import { bus } from './bus.js';
import { guildId } from './discord.js';
import { usersWithRanks, topTierOnly } from './routes.js';
import { liveMatch } from './servers.js';
import { cleanName } from './util.js';

const API = 'https://discord.com/api/v10';
const WPG_APP_ID = '1555526462319366165';
const WPG_PUBLIC_KEY = 'f7572684d37e69c27da9c32bcd5519eb2d94683760a64776c155246159f48710';
// Values pasted into the host's settings sometimes carry spaces, quotes or a "Bot " prefix.
const clean = (v) => String(v || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
const APP_ID = () => (/^\d{15,22}$/.test(clean(process.env.DISCORD_APP_ID)) ? clean(process.env.DISCORD_APP_ID) : WPG_APP_ID);
const TOKEN = () => clean(process.env.DISCORD_BOT_TOKEN).replace(/^Bot\s+/i, '');
let keyFromDiscord = ''; // the app's public key as Discord itself reports it (read with the bot token)
// Any of these may sign a genuine request: the key in the host's settings, the built-in WPG key, and
// the key Discord reports. Bad or empty ones are skipped.
const PUBLIC_KEYS = () => [...new Set([clean(process.env.DISCORD_PUBLIC_KEY), keyFromDiscord, WPG_PUBLIC_KEY]
  .map((k) => k.toLowerCase()).filter((k) => /^[0-9a-f]{64}$/.test(k)))];
const SITE = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://wpg-barracks.onrender.com').replace(/\/$/, '');
const ENDPOINT = () => `${SITE()}/discord/interactions`;
const COLOR = 0x29b6f6;
const GOLD = 0xc9a227;

export const botReady = () => !!TOKEN();
export const discordAppId = APP_ID;
// Bot permissions asked for in the invite: View Channels + Send Messages + Embed Links.
export const inviteUrl = () => `https://discord.com/oauth2/authorize?client_id=${APP_ID()}&scope=bot%20applications.commands&permissions=19456`;

// ---------- Small helpers ----------
const num = (n) => Number(n || 0).toLocaleString('en-GB');
const money = (n) => `$${num(Math.round(Number(n) || 0))}`;
const hours = (secs) => `${Math.floor((Number(secs) || 0) / 3600)}h ${Math.floor(((Number(secs) || 0) % 3600) / 60)}m`;
// "SERGEANT VII" -> "Sergeant VII"
const wpgRank = (name) => String(name || 'RECRUIT I').split(/\s+/)
  .map((w) => (/^(WPG|[IVX]+)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
const ROLES = [['assault', 'Assault'], ['medic', 'Medic'], ['recon', 'Recon'], ['support', 'Support'], ['driver', 'Driver'], ['pilot', 'Pilot']];

async function discordFetch(path, method = 'GET', body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bot ${TOKEN()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      const wait = Number((await res.json().catch(() => ({})))?.retry_after) || 2;
      await new Promise((r) => setTimeout(r, wait * 1000 + 250));
      continue;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Discord ${method} ${path.split('?')[0]} returned ${res.status}: ${data?.message || ''}`);
    return data;
  }
  throw new Error('Discord kept saying slow down');
}

// Checks the request really came from Discord (ed25519 signature with the app's public key).
function verified(req, raw) {
  const sig = req.get('X-Signature-Ed25519');
  const ts = req.get('X-Signature-Timestamp');
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  const signed = Buffer.concat([Buffer.from(ts), raw]);
  return PUBLIC_KEYS().some((hex) => {
    try {
      const key = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]),
        format: 'der',
        type: 'spki',
      });
      return crypto.verify(null, signed, key, Buffer.from(sig, 'hex'));
    } catch {
      return false;
    }
  });
}

// ---------- Who is this about? ----------
const option = (data, name) => (data.options || []).find((o) => o.name === name)?.value;

async function findMember(data, callerId) {
  const mention = option(data, 'member');
  const name = String(option(data, 'name') || '').trim();
  let user = null;
  if (mention) {
    user = await one("SELECT * FROM users WHERE discord_id=$1 AND status='active'", [String(mention)]);
    if (!user) return { error: `<@${mention}> hasn't linked their Discord to the Barracks app yet (they type **/link**).` };
  } else if (name) {
    user = await one(
      `SELECT * FROM users WHERE status='active' AND (persona_name ILIKE $1 OR custom_fields->>'wardogs_name' ILIKE $1)
        ORDER BY (lower(persona_name) = lower($2)) DESC, last_seen DESC LIMIT 1`,
      [`%${name.replace(/[%_]/g, '')}%`, name],
    );
    if (!user) return { error: `No Barracks app member found called **${name}**.` };
  } else {
    user = await one("SELECT * FROM users WHERE discord_id=$1 AND status='active'", [callerId]);
    if (!user) return { error: "Your Discord isn't linked to the Barracks app yet. Type **/link** to get a code, then enter it in the app (Edit profile)." };
  }
  const [withRank] = await usersWithRanks([user]);
  return { user, pub: withRank };
}

const header = (u) => ({
  author: { name: u.persona_name, icon_url: /^https:\/\//.test(u.avatar || '') ? u.avatar : undefined, url: `${SITE()}/#/u/${u.id}` },
});
const footer = { text: 'WPG Barracks' };

// Everything on the career card for one member.
async function careerData(u) {
  const [ws, prog, srv, awards, game] = await Promise.all([
    one('SELECT official, ranks FROM wardogs_stats WHERE user_id=$1', [u.id]),
    one('SELECT xp, rank_name, bot_name FROM server_progress WHERE steam_id=$1', [u.steam_id]),
    one(
      `SELECT COALESCE(SUM(kills),0)::int kills, COALESCE(SUM(deaths),0)::int deaths, COALESCE(SUM(matches),0)::int matches,
              COALESCE(SUM(wins),0)::int wins, COALESCE(SUM(losses),0)::int losses, COALESCE(SUM(playtime_s),0)::int playtime,
              (ARRAY_AGG(name ORDER BY last_seen DESC NULLS LAST))[1] AS name
         FROM server_players WHERE steam_id=$1`,
      [u.steam_id],
    ),
    q(
      `SELECT ua.id, ua.given_at, a.name, a.colors, a.auto_rule, a.sort_order
         FROM user_awards ua JOIN awards a ON a.id = ua.award_id WHERE ua.user_id=$1 ORDER BY a.sort_order, ua.given_at`,
      [u.id],
    ),
    one('SELECT app_id, name FROM games WHERE enabled = true ORDER BY featured DESC, name LIMIT 1'),
  ]);
  const pos = prog ? await one('SELECT COUNT(*)::int + 1 AS n FROM server_progress WHERE xp > $1', [prog.xp]) : null;
  let achievements = { earned: [], total: 0, game: '' };
  if (game) {
    const [total, earned] = await Promise.all([
      one('SELECT COUNT(*)::int AS n FROM steam_achievements WHERE app_id=$1', [game.app_id]),
      q(
        `SELECT sa.name, sa.icon, sa.percent::float AS percent FROM user_achievements ua
           JOIN steam_achievements sa ON sa.app_id = ua.app_id AND sa.api_name = ua.api_name
          WHERE ua.user_id=$1 AND ua.app_id=$2 ORDER BY sa.percent ASC NULLS LAST, sa.sort_order`,
        [u.id, game.app_id],
      ),
    ]);
    achievements = { game: game.name, total: total?.n || 0, earned };
  }
  return {
    // The name used on the WPG server (with the clan tag), else the Steam name.
    // (No Steam ID or Discord name: cards are posted in Discord, so they stay private.)
    name: cleanName(prog?.bot_name || srv?.name, '') || cleanName(u.persona_name),
    official: ws?.official || null,
    worldRank: ws?.ranks?.level || null,
    wpg: { rank: prog?.rank_name || 'RECRUIT I', xp: prog?.xp || 0, position: pos?.n || null },
    server: srv || {},
    medals: topTierOnly(awards),
    achievements,
  };
}

// The career card picture (JPEG) for one member. The picture library is loaded only when needed, so a
// problem with it can never stop the app starting.
export async function careerCard(user) {
  const { renderCareerCard } = await import('./careercard.js');
  return renderCareerCard(await careerData(user));
}

// ---------- Commands ----------
// /stats: the WPG career card picture (falls back to a text card if the picture can't be made).
async function cmdStats(data, caller) {
  const f = await findMember(data, caller);
  if (f.error) return { content: f.error };
  try {
    const card = await careerCard(f.user);
    return {
      files: [{ name: 'wpg-career.jpg', data: card, type: 'image/jpeg' }],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Open in WPG Barracks', url: `${SITE()}/#/u/${f.user.id}` }] }],
    };
  } catch (e) {
    problem('/stats picture (sent text instead)', e.message);
    return statsEmbed(f);
  }
}

async function statsEmbed(f) {
  const ws = await one('SELECT official, ranks, official_synced FROM wardogs_stats WHERE user_id=$1', [f.user.id]);
  const o = ws?.official;
  if (!o) return { content: `**${f.user.persona_name}** has no Wardogs stats yet. They add their in-game name (Name#1234) on HQ in the app.` };
  const r = ws.ranks || {};
  const of = r.total ? ` of ${num(r.total)}` : '';
  return {
    embeds: [{
      ...header(f.user),
      title: 'Wardogs stats',
      color: COLOR,
      fields: [
        { name: 'Wardog level', value: num(o.wardogLevel), inline: true },
        { name: 'Cash', value: money(o.cash), inline: true },
        { name: 'Account worth', value: o.worth ? money(o.worth) : '—', inline: true },
        { name: 'Total XP', value: o.careerXp ? num(o.careerXp) : '—', inline: true },
        { name: 'Unlocks', value: o.unlocks ? num(o.unlocks) : '—', inline: true },
        { name: 'Gold', value: num(o.gold), inline: true },
        { name: 'Classes', value: ROLES.map(([k, l]) => `${l} **${num(o.roles?.[k]?.level ?? o.roles?.[k] ?? 0)}**`).join(' · ') },
        { name: 'World rank', value: [r.level && `Level #${num(r.level)}${of}`, r.worth && `Worth #${num(r.worth)}`, r.cash && `Cash #${num(r.cash)}`].filter(Boolean).join(' · ') || '—' },
      ],
      footer,
      timestamp: ws.official_synced || undefined,
    }],
  };
}

// Sends a picture card, or the text version if the picture can't be made. The picture code is loaded
// only when needed, so a problem with it can never stop the app starting.
async function asPicture(name, render, fallback, link) {
  try {
    const cards = await import('./cards.js');
    const jpg = await render(cards);
    const out = { files: [{ name: `wpg-${name}.jpg`, data: jpg, type: 'image/jpeg' }] };
    if (link) out.components = [{ type: 1, components: [{ type: 2, style: 5, label: link.label, url: link.url }] }];
    return out;
  } catch (e) {
    problem(`/${name} picture (sent text instead)`, e.message);
    return fallback();
  }
}
const profileLink = (u) => ({ label: 'Open in WPG Barracks', url: `${SITE()}/#/u/${u.id}` });
const avatarOf = (u) => {
  const a = u.custom_avatar || u.avatar || '';
  return /^https:\/\//.test(a) ? a : '';
};
// How a member shows on cards: their name on the WPG server (with the clan tag), else the Steam name.
async function cardName(u) {
  const r = await one(
    `SELECT COALESCE(
        (SELECT NULLIF(TRIM(bot_name), '') FROM server_progress WHERE steam_id=$1),
        (SELECT NULLIF(TRIM(name), '') FROM server_players WHERE steam_id=$1 ORDER BY last_seen DESC NULLS LAST LIMIT 1)
      ) AS name`,
    [u.steam_id],
  );
  return cleanName(r?.name, '') || cleanName(u.persona_name);
}

async function cmdRank(data, caller) {
  const f = await findMember(data, caller);
  if (f.error) return { content: f.error };
  const p = await one('SELECT xp, rank_name FROM server_progress WHERE steam_id=$1', [f.user.steam_id]);
  const [pos, total, ranks] = await Promise.all([
    p ? one('SELECT COUNT(*)::int + 1 AS n FROM server_progress WHERE xp > $1', [p.xp]) : null,
    one('SELECT COUNT(*)::int AS n FROM server_progress'),
    q('SELECT * FROM ranks ORDER BY sort_order, id'),
  ]);
  const pmc = f.user.membership === 'pmc';
  const cur = ranks.find((r) => r.id === f.user.rank_id) || null;
  // Next rank earned by XP (none if the current rank is appointed by command).
  const next = !pmc && (!cur || cur.auto)
    ? ranks.find((r) => r.auto && (!cur || r.sort_order > cur.sort_order) && r.min_xp > (Number(f.user.xp) || 0)) || null
    : null;
  const text = () => ({
    embeds: [{
      ...header(f.user),
      title: 'Ranks',
      color: GOLD,
      fields: [
        { name: 'WPG rank', value: `**${wpgRank(p?.rank_name)}**`, inline: true },
        { name: 'WPG XP', value: num(p?.xp), inline: true },
        { name: 'Position', value: pos ? `#${num(pos.n)}` : '—', inline: true },
        { name: 'Clan rank', value: pmc ? 'PMC (guest)' : f.pub.rank ? `**${f.pub.rank.name}**` : '—', inline: true },
        { name: 'Clan XP', value: num(f.user.xp), inline: true },
      ],
      footer: { text: 'WPG rank and WPG XP come from the WPG Discord bot · WPG Barracks' },
    }],
  });
  return asPicture('rank', async (cards) => cards.renderRankCard({
    name: await cardName(f.user),
    avatar: avatarOf(f.user),
    wpg: { rank: p?.rank_name || 'RECRUIT I', xp: p?.xp || 0, position: pos?.n || null, total: total?.n || 0 },
    clan: { pmc, rank: cur, xp: Number(f.user.xp) || 0, next, from: cur?.auto ? cur.min_xp : 0 },
  }), text, profileLink(f.user));
}

async function cmdMedals(data, caller) {
  const f = await findMember(data, caller);
  if (f.error) return { content: f.error };
  const awards = topTierOnly(await q(
    `SELECT ua.id, ua.given_at, a.name, a.description, a.colors, a.auto_rule, a.sort_order
       FROM user_awards ua JOIN awards a ON a.id = ua.award_id WHERE ua.user_id=$1 ORDER BY a.sort_order, ua.given_at`,
    [f.user.id],
  ));
  const game = await one('SELECT app_id, name FROM games WHERE enabled = true ORDER BY featured DESC, name LIMIT 1');
  const [total, earned] = game ? await Promise.all([
    one('SELECT COUNT(*)::int AS n FROM steam_achievements WHERE app_id=$1', [game.app_id]),
    q(
      `SELECT sa.name, sa.icon, sa.percent::float AS percent FROM user_achievements ua
         JOIN steam_achievements sa ON sa.app_id = ua.app_id AND sa.api_name = ua.api_name
        WHERE ua.user_id=$1 AND ua.app_id=$2 ORDER BY sa.percent ASC NULLS LAST, sa.sort_order`,
      [f.user.id, game.app_id],
    ),
  ]) : [null, []];
  const text = () => ({
    embeds: [{
      ...header(f.user),
      title: `Medals (${awards.length})`,
      color: GOLD,
      description: (awards.map((a) => `🎖️ **${a.name}**`).join('\n') || 'No medals yet.').slice(0, 3900),
      fields: [{ name: 'Steam achievements', value: `${num(earned.length)}${total?.n ? ` / ${num(total.n)}` : ''}`, inline: true }],
      footer,
    }],
  });
  return asPicture('medals', async (cards) => cards.renderMedalsCard({
    name: await cardName(f.user),
    avatar: avatarOf(f.user),
    medals: awards,
    achievements: { game: game?.name || '', total: total?.n || 0, earned },
  }), text, profileLink(f.user));
}

async function cmdServer(data, caller) {
  const f = await findMember(data, caller);
  if (f.error) return { content: f.error };
  const s = await one(
    `SELECT COALESCE(SUM(kills),0)::int k, COALESCE(SUM(deaths),0)::int d, COALESCE(SUM(matches),0)::int m,
            COALESCE(SUM(wins),0)::int w, COALESCE(SUM(losses),0)::int l, COALESCE(SUM(playtime_s),0)::int t, MAX(last_seen) seen
       FROM server_players WHERE steam_id=$1`,
    [f.user.steam_id],
  );
  if (!s?.seen && !s?.t) return { content: `**${f.user.persona_name}** hasn't played on the WPG server yet.` };
  // Positions among everyone who has played (all WPG servers added together).
  const [killsPos, playPos, players, p] = await Promise.all([
    one('SELECT COUNT(*)::int + 1 AS n FROM (SELECT steam_id, SUM(kills) k FROM server_players GROUP BY steam_id) t WHERE k > $1', [s.k]),
    one('SELECT COUNT(*)::int + 1 AS n FROM (SELECT steam_id, SUM(playtime_s) pt FROM server_players GROUP BY steam_id) t WHERE pt > $1', [s.t]),
    one('SELECT COUNT(DISTINCT steam_id)::int AS n FROM server_players'),
    one('SELECT xp, rank_name FROM server_progress WHERE steam_id=$1', [f.user.steam_id]),
  ]);
  const text = () => ({
    embeds: [{
      ...header(f.user),
      title: 'WPG server stats (all time)',
      color: COLOR,
      fields: [
        { name: 'Kills', value: num(s.k), inline: true },
        { name: 'Deaths', value: num(s.d), inline: true },
        { name: 'K/D', value: (s.k / Math.max(1, s.d)).toFixed(2), inline: true },
        { name: 'Matches', value: num(s.m), inline: true },
        { name: 'Wins / losses', value: `${num(s.w)} / ${num(s.l)}`, inline: true },
        { name: 'Playtime', value: hours(s.t), inline: true },
      ],
      footer,
      timestamp: s.seen || undefined,
    }],
  });
  return asPicture('server', async (cards) => cards.renderServerCard({
    name: await cardName(f.user),
    avatar: avatarOf(f.user),
    kills: s.k, deaths: s.d, matches: s.m, wins: s.w, losses: s.l, playtime: s.t, lastSeen: s.seen,
    killsPos: killsPos?.n, playtimePos: playPos?.n, players: players?.n,
    wpgRank: p?.rank_name || 'RECRUIT I', wpgXp: p?.xp || 0,
  }), text, profileLink(f.user));
}

const BOARDS = {
  wpg: {
    title: 'WPG rank',
    sql: `SELECT bot_name AS name, xp AS v, rank_name AS extra FROM server_progress ORDER BY xp DESC, bot_name LIMIT 10`,
    show: (r) => `**${num(r.v)}** WPG XP · ${wpgRank(r.extra)}`,
    value: (r) => `${num(r.v)} XP`,
  },
  clan: {
    title: 'Clan XP',
    sql: `SELECT persona_name AS name, xp AS v FROM users WHERE status='active' ORDER BY xp DESC LIMIT 10`,
    show: (r) => `**${num(r.v)}** Clan XP`,
    value: (r) => `${num(r.v)} XP`,
  },
  level: {
    title: 'Wardog level',
    sql: `SELECT u.persona_name AS name, (ws.official->>'wardogLevel')::int AS v FROM users u JOIN wardogs_stats ws ON ws.user_id=u.id
           WHERE u.status='active' AND ws.official IS NOT NULL ORDER BY v DESC NULLS LAST LIMIT 10`,
    show: (r) => `Level **${num(r.v)}**`,
    value: (r) => `LEVEL ${num(r.v)}`,
  },
  worth: {
    title: 'Account worth',
    sql: `SELECT u.persona_name AS name, (ws.official->>'worth')::bigint AS v FROM users u JOIN wardogs_stats ws ON ws.user_id=u.id
           WHERE u.status='active' AND ws.official->>'worth' IS NOT NULL ORDER BY v DESC NULLS LAST LIMIT 10`,
    show: (r) => `**${money(r.v)}**`,
    value: (r) => money(r.v),
  },
  kills: {
    title: 'WPG server kills',
    sql: `SELECT MAX(name) AS name, SUM(kills)::int AS v FROM server_players GROUP BY steam_id ORDER BY v DESC LIMIT 10`,
    show: (r) => `**${num(r.v)}** kills`,
    value: (r) => `${num(r.v)} KILLS`,
  },
};
async function cmdLeaderboard(data) {
  const b = BOARDS[option(data, 'board')] || BOARDS.wpg;
  const rows = await q(b.sql);
  const medal = ['🥇', '🥈', '🥉'];
  const text = () => ({
    embeds: [{
      title: `🏆 ${b.title} — top 10`,
      url: `${SITE()}/#/leaderboard`,
      color: GOLD,
      description: rows.map((r, i) => `${medal[i] || `**${i + 1}.**`} ${cleanName(r.name)} — ${b.show(r)}`).join('\n') || 'No data yet.',
      footer,
    }],
  });
  return asPicture('leaderboard', (cards) => cards.renderLeaderboardCard({
    title: b.title,
    accent: 'top 10',
    rows: rows.map((r) => ({ name: cleanName(r.name), value: b.value(r), extra: r.extra || '' })),
  }), text, { label: 'All leaderboards', url: `${SITE()}/#/leaderboard` });
}

// When the tracker last read the server, as a short time ("7:07 AM", or "2 OCT 7:07 AM" if not today).
function updatedText(at) {
  if (!at) return '—';
  const d = new Date(at);
  const tz = 'Europe/London';
  const time = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hourCycle: 'h12', timeZone: tz }).toUpperCase(); // h12: "12:32 PM", not "0:32 PM"
  const day = (x) => x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: tz });
  return day(d) === day(new Date()) ? time : `${day(d).toUpperCase()} ${time}`;
}

// Server rank = place on the main board (by WPG XP, ties split by kills, then playtime), so it's unique.
const MAIN_ORDER = 'COALESCE(wpg_xp, 0) DESC, kills DESC, playtime_s DESC, name';
const SERVER_SORTS = {
  wpgxp: ['WPG XP', MAIN_ORDER],
  kills: ['Kills', 'kills DESC, playtime_s DESC, name'],
  kd: ['K/D', '(kills::float / GREATEST(deaths, 1)) DESC, kills DESC, name'],
  wins: ['Wins', 'wins DESC, matches DESC, name'],
  matches: ['Matches', 'matches DESC, playtime_s DESC, name'],
  playtime: ['Playtime', 'playtime_s DESC, name'],
};
// Names are cleaned with cleanName (util.js): invisible-only names show as "Unknown player", never a Steam ID.
// /serverboard: the WPG server leaderboard (same numbers as the app's WPG server board).
async function cmdServerBoard(data) {
  const server = await one("SELECT * FROM game_servers WHERE enabled = true AND rcon_url <> '' ORDER BY sort_order, id LIMIT 1");
  if (!server) return { content: 'No WPG game server is set up yet.' };
  const sortKey = SERVER_SORTS[option(data, 'sort')] ? option(data, 'sort') : 'wpgxp';
  const [sortLabel, order] = SERVER_SORTS[sortKey];
  const rows = await q(
    `WITH board AS (
       SELECT sp.name, sp.kills, sp.deaths, sp.matches, sp.wins, sp.losses, sp.playtime_s, sp.last_seen, p.xp AS wpg_xp, p.rank_name
         FROM server_players sp LEFT JOIN server_progress p ON p.steam_id = sp.steam_id
        WHERE sp.server_id = $1
     ), ranked AS (
       SELECT board.*, ROW_NUMBER() OVER (ORDER BY ${MAIN_ORDER})::int AS server_rank FROM board
     )
     SELECT * FROM ranked ORDER BY ${order} LIMIT 14`,
    [server.id],
  );
  // When the board last changed: the tracker's last check, else the latest activity on it.
  const st = await one(
    `SELECT COALESCE((SELECT updated_at FROM server_track_state WHERE server_id=$1), (SELECT MAX(last_seen) FROM server_players WHERE server_id=$1)) AS at`,
    [server.id],
  );
  const live = await liveMatch(server).catch(() => null);
  const text = () => ({
    embeds: [{
      title: `🏆 WPG server leaderboard — by ${sortLabel}`,
      url: `${SITE()}/#/leaderboard?by=server`,
      color: GOLD,
      description: rows.map((r, i) => `**${i + 1}.** ${cleanName(r.name)} — ${num(r.wpg_xp)} WPG XP · ${num(r.kills)} kills · ${hours(r.playtime_s)}`).join('\n') || 'Nobody on the board yet.',
      footer,
    }],
  });
  return asPicture('serverboard', (cards) => cards.renderServerBoardCard({
    serverName: '[WPG] WASTED PRODIGY',
    map: live?.map || '—',
    updated: updatedText(st?.at),
    sortLabel: sortKey === 'wpgxp' ? '' : sortLabel,
    rows: rows.map((r) => ({
      name: cleanName(r.name), serverRank: r.server_rank, kills: r.kills, deaths: r.deaths, matches: r.matches,
      wins: r.wins, losses: r.losses, playtime: r.playtime_s, wpgRank: r.rank_name || 'RECRUIT I', wpgXp: r.wpg_xp || 0,
    })),
  }), text, { label: 'Full board in WPG Barracks', url: `${SITE()}/#/leaderboard?by=server` });
}

async function cmdLive() {
  const servers = await q("SELECT * FROM game_servers WHERE enabled = true AND rcon_url <> '' AND rcon_password <> '' ORDER BY sort_order, id");
  if (!servers.length) return { content: 'No game server is set up for live info yet.' };
  const matches = [];
  for (const s of servers.slice(0, 3)) {
    const m = await liveMatch(s).catch((e) => ({ error: e.message }));
    matches.push({ s, m });
  }
  const text = () => ({
    embeds: matches.map(({ s, m }) => (m.error
      ? { title: s.name || 'Game server', color: 0xe05252, description: "Can't reach the server right now." }
      : {
        title: `🎮 ${m.name || s.name || 'WPG server'}`,
        url: `${SITE()}/#/servers`,
        color: COLOR,
        description: `**${m.map}** · ${[m.mode, ...(m.modifiers || [])].join(' + ')} · ${m.lighting}${m.zone ? ` · ${m.zone}` : ''}`,
        fields: [
          { name: 'Players', value: `${num(m.players)} / ${num(m.maxPlayers)}`, inline: true },
          ...m.scores.map((x) => ({ name: x.name, value: num(x.score), inline: true })),
          ...(m.next ? [{ name: 'Next map', value: `${m.next.map}${m.next.mode ? ` · ${m.next.mode}` : ''}` }] : []),
        ],
        footer: { text: `Join code: ${s.join_code} · WPG Barracks` },
      })),
  });
  return asPicture('live', (cards) => cards.renderLiveCard({
    servers: matches.map(({ s, m }) => (m.error
      ? { name: s.name || 'WPG server', error: true }
      : {
        name: m.name || s.name, joinCode: s.join_code, map: m.map, mode: [m.mode, ...(m.modifiers || [])].filter((x) => x && x !== '—').join(' + '),
        lighting: m.lighting, zone: m.zone, players: m.players, maxPlayers: m.maxPlayers, scoreCap: m.scoreCap, scores: m.scores, next: m.next,
      })),
  }), text, { label: 'Servers in WPG Barracks', url: `${SITE()}/#/servers` });
}

async function cmdProgress(data, caller) {
  const f = await findMember(data, caller);
  if (f.error) return { content: f.error };
  const ws = await one('SELECT official FROM wardogs_stats WHERE user_id=$1', [f.user.id]);
  const o = ws?.official;
  if (!o) return { content: `**${f.user.persona_name}** has no Wardogs stats yet. They add their in-game name (Name#1234) on HQ in the app.` };
  const unlocks = await q('SELECT role, level, name, cost, image FROM unlocks ORDER BY level, name');
  const bought = new Set((await q('SELECT role, name FROM user_unlocks WHERE user_id=$1', [f.user.id])).map((r) => `${r.role}|${r.name}`));
  const levelOf = (role) => (role === 'career' ? Number(o.wardogLevel) || 0 : Number(o.roles?.[role]?.level ?? o.roles?.[role]) || 0);
  let readyCount = 0;
  let readyCost = 0;
  let spent = 0;
  const COLORS = { career: '#c9a227', recon: '#e53935', assault: '#1e88e5', medic: '#2ecc71', support: '#f5a524', driver: '#b84dff', pilot: '#29b6f6' };
  const rows = [['career', 'Career'], ['recon', 'Recon'], ['assault', 'Assault'], ['medic', 'Medic'], ['support', 'Support'], ['driver', 'Driver'], ['pilot', 'Pilot']].map(([role, label]) => {
    const lvl = levelOf(role);
    const mine = unlocks.filter((u) => u.role === role);
    for (const u of mine) {
      const isBought = bought.has(`${role}|${u.name}`);
      if (isBought) spent += u.cost;
      else if (u.level <= lvl && u.cost > 0) { readyCount++; readyCost += u.cost; }
    }
    const next = mine.find((u) => u.level > lvl);
    return { role, label, color: COLORS[role], level: lvl, max: mine.length ? Math.max(...mine.map((u) => u.level)) : 0, next: next ? { name: next.name, level: next.level, image: next.image } : null };
  });
  const text = () => ({
    embeds: [{
      ...header(f.user),
      title: 'Progression',
      url: `${SITE()}/#/progression`,
      color: COLOR,
      description: rows.map((r) => `**${r.label}** ${r.level} → ${r.next ? `next: ${r.next.name} at ${r.next.level}` : 'all unlocked'}`).join('\n'),
      fields: [{ name: 'Reached but not bought', value: readyCount ? `${num(readyCount)} items · ${money(readyCost)}` : 'Nothing waiting' }],
      footer: { text: 'Tick what you have bought on the Progression page · WPG Barracks' },
    }],
  });
  return asPicture('progress', async (cards) => cards.renderProgressCard({
    name: await cardName(f.user),
    avatar: avatarOf(f.user),
    rows,
    readyCount,
    readyCost,
    spent,
  }), text, { label: 'Open Progression', url: `${SITE()}/#/progression` });
}

async function cmdLink(_data, caller, callerName) {
  const code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
  await q('DELETE FROM discord_link_codes WHERE discord_id=$1 OR created_at < now() - interval \'1 day\'', [caller]);
  await q('INSERT INTO discord_link_codes (code, discord_id, discord_name) VALUES ($1,$2,$3)', [code, caller, String(callerName || '').slice(0, 64)]);
  return {
    content: `Your link code is **${code}** (works for 15 minutes).\nOpen the Barracks app → **Edit profile** → **Discord**, type the code and press **Link**.\n${SITE()}/#/profile/edit`,
  };
}

async function cmdUnlink(_data, caller) {
  const u = await one("UPDATE users SET discord_id='' WHERE discord_id=$1 RETURNING id", [caller]);
  return { content: u ? 'Your Discord is no longer linked to the Barracks app.' : "Your Discord wasn't linked." };
}

const COMMANDS = {
  stats: { run: cmdStats, description: 'Wardogs stats: level, cash, worth, classes, world ranks' },
  rank: { run: cmdRank, description: 'WPG rank + WPG XP, and clan rank' },
  medals: { run: cmdMedals, description: 'Medals earned' },
  server: { run: cmdServer, description: 'WPG server stats: kills, K/D, matches, playtime' },
  progress: { run: cmdProgress, description: 'Next unlocks for each class' },
  leaderboard: { run: cmdLeaderboard, description: 'Top 10 leaderboards' },
  serverboard: { run: cmdServerBoard, description: 'The WPG server leaderboard (top 14)' },
  live: { run: cmdLive, description: 'What is happening on the WPG server right now' },
  link: { run: cmdLink, description: 'Link your Discord to the Barracks app', private: true },
  unlink: { run: cmdUnlink, description: 'Unlink your Discord from the Barracks app', private: true },
};
const WHO = [
  { type: 6, name: 'member', description: 'Which member (leave empty for yourself)', required: false },
  { type: 3, name: 'name', description: 'Or search by name', required: false },
];
function commandDefinitions() {
  return Object.entries(COMMANDS).map(([name, c]) => {
    const def = { name, description: c.description, type: 1, dm_permission: false };
    if (['stats', 'rank', 'medals', 'server', 'progress'].includes(name)) def.options = WHO;
    if (name === 'leaderboard') {
      def.options = [{
        type: 3, name: 'board', description: 'Which leaderboard', required: false,
        choices: [['WPG rank', 'wpg'], ['Clan XP', 'clan'], ['Wardog level', 'level'], ['Account worth', 'worth'], ['Server kills', 'kills']].map(([n, v]) => ({ name: n, value: v })),
      }];
    }
    if (name === 'serverboard') {
      def.options = [{
        type: 3, name: 'sort', description: 'Order by (WPG XP if left empty)', required: false,
        choices: Object.entries(SERVER_SORTS).map(([v, [n]]) => ({ name: n, value: v })),
      }];
    }
    return def;
  });
}

// Remembers setup milestones (shown as ticks in Admin → Settings). Hidden settings start with "_".
async function remember(key, value) {
  await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
}

// The app's own settings as Discord has them (read with the bot token): its ID, public key and the
// address Discord sends commands to.
let appFromDiscord = null;
let lastEndpointProblem = null;
async function readApplication() {
  const a = await discordFetch('/applications/@me');
  appFromDiscord = a;
  if (/^[0-9a-f]{64}$/i.test(a?.verify_key || '')) keyFromDiscord = a.verify_key.toLowerCase();
  return a;
}
const realAppId = () => appFromDiscord?.id || APP_ID();

// Points Discord at this app ("Interactions Endpoint URL"), so nobody has to paste it in by hand.
// Discord checks the address straight away by sending it a test message, which this app answers.
export async function ensureEndpoint() {
  const a = await readApplication();
  if (a?.interactions_endpoint_url === ENDPOINT()) { lastEndpointProblem = null; return { ok: true, url: ENDPOINT(), changed: false }; }
  try {
    const updated = await discordFetch('/applications/@me', 'PATCH', { interactions_endpoint_url: ENDPOINT() });
    appFromDiscord = { ...a, ...updated };
    lastEndpointProblem = null;
    return { ok: updated?.interactions_endpoint_url === ENDPOINT(), url: updated?.interactions_endpoint_url || '', changed: true };
  } catch (e) {
    lastEndpointProblem = e.message;
    throw e;
  }
}

// Tells Discord which commands exist (for every server the bot is in, so it works whichever order
// the setup steps are done in). Running it again just replaces the list.
export async function registerCommands() {
  if (!botReady()) return { ok: false, reason: 'DISCORD_BOT_TOKEN is not set in Render yet' };
  if (!appFromDiscord) await readApplication();
  const done = await discordFetch(`/applications/${realAppId()}/commands`, 'PUT', commandDefinitions());
  // An earlier version set commands up for the WPG server only; clear those so nothing shows twice.
  const guild = await guildId().catch(() => null);
  if (guild) await discordFetch(`/applications/${realAppId()}/guilds/${guild}/commands`, 'PUT', []).catch(() => {});
  await remember('_discord_commands_ok', new Date().toISOString());
  return { ok: true, count: done?.length || 0, where: 'every server the bot is in' };
}

// Everything the app can set up on Discord by itself: the address and the commands.
export async function setupDiscord() {
  if (!botReady()) return { ok: false, reason: 'DISCORD_BOT_TOKEN is not set in Render yet' };
  const endpoint = await ensureEndpoint().catch((e) => ({ ok: false, reason: e.message }));
  const commands = await registerCommands().catch((e) => ({ ok: false, reason: e.message }));
  if (!endpoint.ok) problem('Setting the bot address', endpoint.reason || 'Discord did not accept it');
  if (!commands.ok) problem('Setting up the commands', commands.reason || 'Discord did not accept them');
  return { ok: !!(endpoint.ok && commands.ok), endpoint, commands };
}

// Recent problems and commands, shown in Admin → Settings so anyone can see what went wrong.
const problems = [];
const recent = [];
function problem(where, message) {
  problems.unshift({ at: new Date().toISOString(), where, message: String(message || '').slice(0, 300) });
  problems.length = Math.min(problems.length, 12);
  console.warn('[discord bot]', where, message);
}
// The newest problem, if it happened in the last `seconds` seconds.
export function latestProblem(seconds) {
  const p = problems[0];
  return p && Date.now() - new Date(p.at).getTime() < seconds * 1000 ? p : null;
}
function noteCommand(name, how) {
  recent.unshift({ at: new Date().toISOString(), name, how });
  recent.length = Math.min(recent.length, 12);
}

// Runs a command as if it came from Discord (for the Preview button in Admin → Settings).
export async function previewCommand(name, user) {
  const cmd = COMMANDS[name];
  if (!cmd || cmd.private) throw new Error('That command has no preview.');
  // Member cards are for the admin themself: by linked Discord, or by their name if not linked.
  const options = user.discord_id ? [] : [{ name: 'name', value: user.persona_name }];
  return cmd.run({ name, options }, String(user.discord_id || ''), user.persona_name);
}

// Setup checklist for Admin → Settings: each step is ticked once it has really worked.
export async function botStatus() {
  const endpoint = await one("SELECT value FROM settings WHERE key='_discord_endpoint_ok'");
  const commands = await one("SELECT value FROM settings WHERE key='_discord_commands_ok'");
  const out = {
    token: botReady(),
    endpoint_checked: endpoint?.value || null,
    endpoint_on_discord: null,
    endpoint_wanted: ENDPOINT(),
    endpoint_problem: lastEndpointProblem,
    commands_ready: commands?.value || null,
    commands_on_discord: null,
    commands_wanted: Object.keys(COMMANDS),
    bot_name: null,
    in_server: null,
    token_problem: null,
    problems,
    recent,
  };
  if (botReady()) {
    try {
      const a = await readApplication();
      out.endpoint_on_discord = a?.interactions_endpoint_url || '';
      if (out.endpoint_on_discord === ENDPOINT() && !out.endpoint_checked) out.endpoint_checked = 'set';
      out.bot_name = a?.bot?.username || a?.name || null;
      const guild = await guildId().catch(() => null);
      const guilds = await discordFetch('/users/@me/guilds');
      out.in_server = guild ? (guilds || []).some((g) => g.id === guild) : (guilds || []).length > 0;
      // The commands Discord actually has for the bot right now.
      const cmds = await discordFetch(`/applications/${realAppId()}/commands`);
      out.commands_on_discord = (cmds || []).map((c) => c.name);
    } catch (e) {
      out.token_problem = /401/.test(e.message) ? 'Discord says the bot token is wrong — reset it on the Bot page and paste the new one into Render.' : e.message;
    }
  }
  return out;
}

// ---------- Incoming commands ----------
export const discordBot = express.Router();

discordBot.post('/discord/interactions', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verified(req, raw)) return res.status(401).send('Bad signature');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).send('Bad JSON'); }

  if (body.type === 1) {
    // Discord checking the address works (it does this when the Interactions Endpoint URL is saved).
    remember('_discord_endpoint_ok', new Date().toISOString()).catch(() => {});
    return res.json({ type: 1 });
  }
  if (body.type !== 2) return res.status(400).json({ error: 'Unsupported' });

  const name = body.data?.name;
  const cmd = COMMANDS[name];
  const who = body.member?.user || body.user || {};
  // Answer "thinking…" at once (Discord only waits 3 s), then fill in the real reply.
  res.json({ type: 5, data: cmd?.private ? { flags: 64 } : {} });
  let reply;
  try {
    reply = cmd ? await cmd.run(body.data || {}, String(who.id || ''), who.global_name || who.username) : { content: 'Unknown command.' };
  } catch (e) {
    problem(`/${name}`, e.message);
    reply = { content: 'Something went wrong getting that. Try again in a minute.' };
  }
  const appId = /^\d{15,22}$/.test(String(body.application_id || '')) ? body.application_id : APP_ID();
  const sent = await sendReply(`${API}/webhooks/${appId}/${body.token}/messages/@original`, reply);
  noteCommand(`/${name}`, !sent ? 'reply failed' : reply.files?.length ? 'picture' : 'text');
});

// Fills in the "thinking…" message. Pictures (files) are sent as attachments.
async function sendReply(url, reply) {
  const { files, ...rest } = reply;
  const payload = { allowed_mentions: { parse: [] }, ...rest };
  let init;
  if (files?.length) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name));
    init = { method: 'PATCH', body: form, signal: AbortSignal.timeout(30000) };
  } else {
    init = { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) };
  }
  try {
    const res = await fetch(url, init);
    if (res.ok) return true;
    problem('Sending the reply to Discord', `${res.status} ${(await res.text().catch(() => '')).slice(0, 250)}`);
  } catch (e) {
    problem('Sending the reply to Discord', e.message);
  }
  return false;
}

// ---------- Automatic posts ----------
const postQueue = [];
let posting = false;
async function drain() {
  if (posting) return;
  posting = true;
  while (postQueue.length) {
    const { channel, payload } = postQueue.shift();
    await discordFetch(`/channels/${channel}/messages`, 'POST', { allowed_mentions: { parse: [] }, ...payload })
      .catch((e) => console.warn('[discord bot] post failed', e.message));
    await new Promise((r) => setTimeout(r, 1500));
  }
  posting = false;
}
export async function postToChannel(payload) {
  if (!TOKEN()) return { ok: false, reason: 'DISCORD_BOT_TOKEN is not set' };
  const channel = String((await setting('discord_post_channel')) || '').trim();
  if (!/^\d{15,22}$/.test(channel)) return { ok: false, reason: 'No post channel set (Admin → Settings)' };
  postQueue.push({ channel, payload });
  drain();
  return { ok: true };
}

const mentionFor = (u) => (u?.discord_id ? ` (<@${u.discord_id}>)` : '');
// Other parts of the app raise 'announce' events; each type can be switched off in Admin → Settings.
bus.on('announce', async (a) => {
  try {
    if (a.type === 'promotion' && (await flag('discord_post_promotions'))) {
      const u = await one('SELECT * FROM users WHERE id=$1', [a.userId]);
      if (u) await postToChannel({ embeds: [{ color: GOLD, title: '⬆️ Promotion', description: `**${u.persona_name}**${mentionFor(u)} has been promoted to **${a.rank.name}** (${a.rank.abbr}). Salute!`, url: `${SITE()}/#/u/${u.id}` }] });
    } else if (a.type === 'medals' && (await flag('discord_post_medals'))) {
      const u = await one('SELECT * FROM users WHERE id=$1', [a.userId]);
      if (u && a.names?.length) await postToChannel({ embeds: [{ color: GOLD, title: a.names.length === 1 ? '🎖️ Medal awarded' : '🎖️ Medals awarded', description: `**${u.persona_name}**${mentionFor(u)} earned ${a.names.map((n) => `**${n}**`).join(', ')}.`, url: `${SITE()}/#/u/${u.id}` }] });
    } else if (a.type === 'wpgrank' && (await flag('discord_post_wpg_ranks'))) {
      const u = await one("SELECT * FROM users WHERE steam_id=$1 AND status='active'", [a.steamId]);
      await postToChannel({ embeds: [{ color: COLOR, title: '📈 WPG rank up', description: `**${u?.persona_name || a.name}**${mentionFor(u)} reached **${wpgRank(a.rank)}** (${num(a.xp)} WPG XP).` }] });
    }
  } catch (e) {
    console.warn('[discord bot] announce failed', e.message);
  }
});

// On every start: point Discord at this app and set the commands up, retrying every 10 minutes until
// both work. The first try waits a minute so the host has switched visitors over to this copy of the app.
export function startDiscordBot() {
  if (!botReady()) {
    console.log('[WPG] Discord bot: commands answer, but DISCORD_BOT_TOKEN is not set, so no command setup or channel posts.');
    return;
  }
  const attempt = async () => {
    const r = await setupDiscord().catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) {
      console.log(`[discord bot] ready: address ${r.endpoint.changed ? 'set' : 'already set'}, ${r.commands.count} commands`);
    } else {
      console.warn('[discord bot] setup not finished, trying again in 10 minutes:', r.reason || r.endpoint?.reason || r.commands?.reason);
      setTimeout(attempt, 10 * 60 * 1000);
    }
  };
  setTimeout(attempt, 60 * 1000);
}
