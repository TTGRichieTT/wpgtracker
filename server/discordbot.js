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
import { MOD_COMMANDS, modCommandDefinitions, handleComponent } from './discordmod.js';
import { guildId as serverId, loadMap } from './discordserver.js';
import { guildId } from './discord.js';
import { usersWithRanks, topTierOnly, ACCOUNT_WORTH_SQL } from './routes.js';
import { shownFrames, frameLookFor, TRACKER_METRICS, framesFor } from './frames.js';
import { liveMatch } from './servers.js';
import { cleanName } from './util.js';
import { rankProgress } from './wpgxp.js';

const API = process.env.DISCORD_API_URL || 'https://discord.com/api/v10'; // overridable for local tests only
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
const shown = (n, format = num) => n === null || n === undefined ? '—' : format(n);
const hours = (secs) => `${Math.floor((Number(secs) || 0) / 3600)}h ${Math.floor(((Number(secs) || 0) % 3600) / 60)}m`;
// "SERGEANT VII" -> "Sergeant VII"
const wpgRank = (name) => String(name || 'RECRUIT I').split(/\s+/)
  .map((w) => (/^(WPG|[IVX]+)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
const ROLES = [['assault', 'Assault'], ['medic', 'Medic'], ['recon', 'Recon'], ['support', 'Support'], ['driver', 'Driver'], ['pilot', 'Pilot']];

export async function discordFetch(path, method = 'GET', body) {
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
const TRACKER_CREDIT = 'Data provided by [wardogs.tools](<https://wardogs.tools>)';
// Every post with wardogs.tools stats also gets a button to their site.
const TRACKER_BUTTON = { type: 2, style: 5, label: 'Data: wardogs.tools', url: 'https://wardogs.tools' };
function withTrackerButton(out) {
  if (!out || typeof out !== 'object') return out;
  const row = (out.components || []).find((r) => r.type === 1 && r.components.length < 5);
  if (row) {
    if (!row.components.some((c) => c.url === TRACKER_BUTTON.url)) row.components.push(TRACKER_BUTTON);
  } else out.components = [...(out.components || []), { type: 1, components: [TRACKER_BUTTON] }];
  return out;
}
// Automatic medals for class / career levels are worked out from wardogs.tools stats.
const trackerMedal = (m) => /^(class|career):/i.test(m?.auto_rule || '');

// Everything on the career card for one member.
async function careerData(u) {
  const [ws, prog, srv, awards, game] = await Promise.all([
    one(`SELECT ws.official, ws.ranks, CASE WHEN ws.official IS NULL OR ws.ranks->>'source' IS DISTINCT FROM 'wardogs.tools' THEN NULL ELSE ${ACCOUNT_WORTH_SQL} END AS worth FROM wardogs_stats ws WHERE ws.user_id=$1`, [u.id]),
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
  const currentWardogs = ws?.ranks?.source === 'wardogs.tools';
  return {
    // The name used on the WPG server (with the clan tag), else the Steam name.
    // (No Steam ID or Discord name: cards are posted in Discord, so they stay private.)
    name: cleanName(prog?.bot_name || srv?.name, '') || cleanName(u.persona_name),
    official: currentWardogs && ws?.official ? { ...ws.official, worth: ws.worth === null ? null : Number(ws.worth) } : null,
    worldRank: currentWardogs ? ws.ranks?.position || null : null,
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
// Global stats come from wardogs.tools (credited with a link); found players are re-read every six hours.
const CREDIT = TRACKER_CREDIT;
async function freshWardogs(user) {
  let ws = await one('SELECT official, ranks, ranks_synced FROM wardogs_stats WHERE user_id=$1', [user.id]);
  let refreshError = null;
  if (ws?.ranks?.source !== 'wardogs.tools' || !ws.ranks_synced || Date.now() - new Date(ws.ranks_synced).getTime() > 6 * 60 * 60 * 1000) {
    const { syncWardogs } = await import('./wardogs.js');
    try {
      const result = await syncWardogs(user);
      if (!result.ok && !['missing', 'unsynced'].includes(result.state)) refreshError = result.reason;
    } catch (e) {
      problem('Refreshing Wardogs stats', e.message);
      refreshError = e.message;
    }
    ws = await one('SELECT official, ranks, ranks_synced FROM wardogs_stats WHERE user_id=$1', [user.id]);
  }
  if (refreshError) return `${CREDIT} · Could not refresh stats: ${refreshError}.`;
  if (ws?.ranks?.source !== 'wardogs.tools' || !ws.official) return `${CREDIT} · **${user.persona_name}** isn't on wardogs.tools yet (they link their Wardogs account there).`;
  if (ws.ranks?.state && ws.ranks.state !== 'active') return `${CREDIT} · wardogs.tools has stopped updating **${user.persona_name}** (${ws.ranks.state}): relink at <https://wardogs.tools/account>.`;
  return CREDIT;
}

async function cmdStats(data, caller) {
  const f = await findMember(data, caller);
  if (f.error) {
    // A Discord ID is accepted by the stats API; names are never used for a Tracker lookup.
    const mention = option(data, 'member');
    const { trackerByDiscord } = await import('./ranking.js');
    let t = null;
    if (mention) {
      try {
        t = await trackerByDiscord(String(mention));
      } catch (e) {
        problem('Fetching WARDOGS stats by Discord ID', e.message);
        return { content: `WARDOGS stats could not be fetched: ${e.message}` };
      }
    }
    if (!t) return { content: f.error };
    const o = t.official;
    const rank = t.ranks;
    return {
      embeds: [{
        title: `${t.name} · Wardogs stats`, url: 'https://wardogs.tools', color: COLOR,
        description: `<@${mention}> isn't in WPG Barracks. ${TRACKER_CREDIT}.`,
        fields: [
          { name: 'Wardog level', value: shown(o.wardogLevel), inline: true },
          { name: 'Global rank', value: rank.position ? `#${num(rank.position)}${rank.total ? ` of ${num(rank.total)}` : ''}` : '—', inline: true },
          { name: 'Cash', value: shown(o.cash, money), inline: true },
          { name: 'Worth', value: shown(o.worth, money), inline: true },
          { name: 'Gold', value: shown(o.gold), inline: true },
          { name: 'Unlocks', value: shown(o.unlocks), inline: true },
          { name: 'Classes', value: ROLES.map(([k, l]) => `${l} **${shown(o.roles?.[k]?.level)}** · ${shown(o.roles?.[k]?.xp)} XP`).join(' · ') },
        ],
        footer: { text: 'Data provided by wardogs.tools' },
        timestamp: o.syncedAt || undefined,
      }],
      components: [{ type: 1, components: [TRACKER_BUTTON] }],
    };
  }
  const warning = await freshWardogs(f.user);
  try {
    const card = await careerCard(f.user);
    return {
      ...(warning ? { content: warning } : {}),
      files: [{ name: 'wpg-career.jpg', data: card, type: 'image/jpeg' }],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Open in WPG Barracks', url: `${SITE()}/#/u/${f.user.id}` }, TRACKER_BUTTON] }],
    };
  } catch (e) {
    problem('/stats picture (sent text instead)', e.message);
    return withTrackerButton(await statsEmbed(f));
  }
}

async function statsEmbed(f) {
  const ws = await one('SELECT official, ranks, official_synced FROM wardogs_stats WHERE user_id=$1', [f.user.id]);
  const o = ws?.ranks?.source === 'wardogs.tools' ? ws.official : null;
  if (!o) return { content: `${TRACKER_CREDIT} · No stats were returned for **${f.user.persona_name}**.` };
  const r = ws.ranks || {};
  return {
    embeds: [{
      ...header(f.user),
      title: 'Wardogs stats',
      color: COLOR,
      fields: [
        { name: 'Wardog level', value: shown(o.wardogLevel), inline: true },
        { name: 'Cash', value: shown(o.cash, money), inline: true },
        { name: 'Worth', value: shown(o.worth, money), inline: true },
        { name: 'Unlocks', value: shown(o.unlocks), inline: true },
        { name: 'Gold', value: shown(o.gold), inline: true },
        { name: 'Classes', value: ROLES.map(([k, l]) => `${l} **${shown(o.roles?.[k]?.level)}** · ${shown(o.roles?.[k]?.xp)} XP`).join(' · ') },
        { name: 'Global rank', value: r.position ? `#${num(r.position)}${r.total ? ` of ${num(r.total)}` : ''}${r.bracket ? ` · top ${num(r.bracket)}%` : ''}` : '—' },
        { name: 'XP/min', value: shown(o.rates?.xpPerMinute), inline: true },
        { name: 'Cash/min', value: shown(o.rates?.cashPerMinute), inline: true },
      ],
      footer: { text: 'Data provided by wardogs.tools · WPG Barracks' },
      url: 'https://wardogs.tools',
      timestamp: o.syncedAt || ws.official_synced || undefined,
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
// The profile frame a member shows around their picture (frames.js), for the cards.
const frameOf = async (u) => (u ? (await shownFrames([u])).get(u.id) || null : null);
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
  const p = await one('SELECT xp, rank_level, rank_name FROM server_progress WHERE steam_id=$1', [f.user.steam_id]);
  const [pos, total, ranks, wpgNext] = await Promise.all([
    p ? one('SELECT COUNT(*)::int + 1 AS n FROM server_progress WHERE xp > $1', [p.xp]) : null,
    one('SELECT COUNT(*)::int AS n FROM server_progress'),
    q('SELECT * FROM ranks ORDER BY sort_order, id'),
    rankProgress(p?.xp || 0),
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
        ...(wpgNext?.next ? [{ name: 'Next WPG rank', value: `${wpgRank(wpgNext.next.name)} in ${num(Math.max(0, wpgNext.next.xp - (p?.xp || 0)))} XP`, inline: false }] : []),
        { name: 'Clan rank', value: pmc ? 'PMC (guest)' : f.pub.rank ? `**${f.pub.rank.name}**` : '—', inline: true },
        { name: 'Clan XP', value: num(f.user.xp), inline: true },
      ],
      footer: { text: 'WPG rank and WPG XP are earned on the WPG server · WPG Barracks' },
    }],
  });
  return asPicture('rank', async (cards) => cards.renderRankCard({
    name: await cardName(f.user),
    avatar: avatarOf(f.user),
    frame: f.pub?.frame || null,
    wpg: { rank: p?.rank_name || 'RECRUIT I', level: p?.rank_level || 1, xp: p?.xp || 0, position: pos?.n || null, total: total?.n || 0, from: wpgNext?.from || 0, next: wpgNext?.next || null },
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
  const out = await asPicture('medals', async (cards) => cards.renderMedalsCard({
    name: await cardName(f.user),
    avatar: avatarOf(f.user),
    frame: f.pub?.frame || null,
    medals: awards,
    achievements: { game: game?.name || '', total: total?.n || 0, earned },
  }), text, profileLink(f.user));
  // Class / career level medals come from wardogs.tools stats.
  if (awards.some(trackerMedal)) {
    out.content = `${out.content ? `${out.content}\n` : ''}Class and career level medals: ${TRACKER_CREDIT}`;
    withTrackerButton(out);
  }
  return out;
}

// /frames: a member's profile frames as an achievement list, earned ones first, then what's left to earn.
async function cmdFrames(data, caller) {
  const f = await findMember(data, caller);
  if (f.error) return { content: f.error };
  const d = await framesFor(f.user);
  const groups = [
    ['permanent', 'Permanent'], ['clan', 'Clan'],
    ['season', d.season ? `Season ${d.season.number}${d.season.name && d.season.name.trim().toLowerCase() !== `season ${d.season.number}` ? ` · ${d.season.name}` : ''}` : 'This season'], ['past', 'Past seasons'],
  ];
  const all = groups.flatMap(([k]) => d.groups[k] || []);
  const earned = all.filter((x) => x.unlocked);
  const when = (iso) => (iso ? ` · <t:${Math.floor(Date.parse(iso) / 1000)}:d>` : '');
  const progress = (x) => {
    if (x.locked_reason) return ` · ${x.locked_reason}`;
    const p = x.progress;
    if (!p) return '';
    const amount = (v) => (p.unit === '$' ? `$${num(v)}` : `${num(v)}${p.unit ? ` ${p.unit}` : ''}`);
    return ` · ${amount(p.value)} / ${amount(p.target)}`;
  };
  const fields = [];
  for (const [key, label] of groups) {
    const list = d.groups[key] || [];
    if (!list.length) continue;
    const got = list.filter((x) => x.unlocked);
    const todo = list.filter((x) => !x.unlocked);
    const lines = [
      ...got.map((x) => `🏅 **${x.name}**${x.position ? ` (${x.position}${x.unit_role ? ` · ${x.unit_role}` : ''})` : x.unit_role ? ` (${x.unit_role})` : ''}${x.id === d.selected ? ' · *wearing*' : ''}${when(x.unlocked_at)}`),
      ...todo.slice(0, 4).map((x) => `🔒 ${x.name}${progress(x)}`),
      ...(todo.length > 4 ? [`…and ${todo.length - 4} more to earn`] : []),
    ];
    let value = '';
    for (const l of lines) { if ((value + l).length > 1000) { value += '\n…'; break; } value += `${value ? '\n' : ''}${l}`; }
    fields.push({ name: `${label} (${got.length}/${list.length})`, value: value || '—' });
  }
  const text = () => ({
    embeds: [{
      ...header(f.user),
      title: `Frames (${earned.length}/${all.length})`,
      color: GOLD,
      description: (f.user.membership !== 'pmc' && f.pub?.rank?.name ? `**${f.pub.rank.name}**\n` : '') + (earned.length ? 'Profile frames earned in WPG Barracks. 🔒 = still to earn.' : 'No frames earned yet. 🔒 = still to earn.'),
      fields: fields.slice(0, 25),
      footer,
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, ...profileLink(f.user) }] }],
  });
  // The picture card: every frame's own art around their picture (text list if the picture can't be made).
  const credit = earned.some((x) => x.source === 'wardogs.tools');
  const out = await asPicture('frames', async (cards) => cards.renderFramesCard({
    name: await cardName(f.user),
    avatar: avatarOf(f.user),
    frame: f.pub?.frame || null,
    selected: d.selected,
    rank: f.user.membership !== 'pmc' ? f.pub?.rank || null : null,
    credit,
    groups: groups.map(([key, label]) => ({ label, frames: d.groups[key] || [] })),
  }), text, profileLink(f.user));
  // Frames worked out from wardogs.tools stats are credited.
  if (credit) {
    out.content = `Class, Wardog level and cash frames: ${TRACKER_CREDIT}`;
    withTrackerButton(out);
  }
  return out;
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
    frame: f.pub?.frame || null,
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
           WHERE u.status='active' AND ws.ranks->>'source'='wardogs.tools' AND ws.official->>'wardogLevel' IS NOT NULL ORDER BY v DESC NULLS LAST LIMIT 10`,
    show: (r) => `Level **${num(r.v)}**`,
    value: (r) => `LEVEL ${num(r.v)}`,
  },
  worth: {
    title: 'Account worth',
    sql: `SELECT u.persona_name AS name, ${ACCOUNT_WORTH_SQL} AS v FROM users u JOIN wardogs_stats ws ON ws.user_id=u.id
           WHERE u.status='active' AND ws.ranks->>'source'='wardogs.tools' AND ${ACCOUNT_WORTH_SQL} IS NOT NULL ORDER BY v DESC NULLS LAST LIMIT 10`,
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
      url: b === BOARDS.level || b === BOARDS.worth ? 'https://wardogs.tools' : `${SITE()}/#/leaderboard`,
      color: GOLD,
      description: rows.map((r, i) => `${medal[i] || `**${i + 1}.**`} ${cleanName(r.name)} — ${b.show(r)}`).join('\n') || 'No data yet.',
      footer: b === BOARDS.level || b === BOARDS.worth ? { text: 'Data provided by wardogs.tools' } : footer,
    }],
  });
  const tracker = b === BOARDS.level || b === BOARDS.worth;
  const result = await asPicture('leaderboard', (cards) => cards.renderLeaderboardCard({
    title: b.title,
    accent: 'top 10',
    credit: tracker,
    rows: rows.map((r) => ({ name: cleanName(r.name), value: b.value(r), extra: r.extra || '' })),
  }), text, { label: 'All leaderboards', url: `${SITE()}/#/leaderboard` });
  if (tracker) {
    result.content = TRACKER_CREDIT;
    withTrackerButton(result);
  }
  return result;
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
  const warning = await freshWardogs(f.user);
  const ws = await one('SELECT official, ranks FROM wardogs_stats WHERE user_id=$1', [f.user.id]);
  const o = ws?.ranks?.source === 'wardogs.tools' ? ws.official : null;
  if (!o) return { content: `${TRACKER_CREDIT} · No synced Wardogs stats were returned for **${f.user.persona_name}**.` };
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
      footer: { text: 'Levels: data provided by wardogs.tools · Tick what you have bought on the Progression page · WPG Barracks' },
    }],
  });
  const out = await asPicture('progress', async (cards) => cards.renderProgressCard({
    name: await cardName(f.user),
    avatar: avatarOf(f.user),
    frame: f.pub?.frame || null,
    rows,
    readyCount,
    readyCost,
    spent,
  }), text, { label: 'Open Progression', url: `${SITE()}/#/progression` });
  if (warning && !out.content) out.content = warning;
  if (!out.content) out.content = TRACKER_CREDIT;
  return withTrackerButton(out);
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
  if (u) bus.emit('discord:unlinked', caller);
  return { content: u ? 'Your Discord is no longer linked to the Barracks app.' : "Your Discord wasn't linked." };
}

// /report: tell staff about a suspected cheater. Only the reporter sees the reply.
const reportTimes = new Map();
async function cmdReport(data, caller, callerName) {
  const times = (reportTimes.get(caller) || []).filter((t) => Date.now() - t < 3600 * 1000);
  if (times.length >= 5) return { content: 'You have sent a lot of reports — please try again later.' };
  const linked = caller ? await one("SELECT id, persona_name FROM users WHERE discord_id=$1 AND status='active'", [caller]) : null;
  const { createReport } = await import('./cheatwatch.js');
  try {
    const r = await createReport({
      name: option(data, 'player'), reason: option(data, 'reason'),
      reporterUserId: linked?.id || null, reporterName: linked?.persona_name || callerName || 'Discord member', source: 'discord',
    });
    reportTimes.set(caller, [...times, Date.now()]);
    return { content: `Thanks — your report about **${r.name || 'that player'}** has been sent to WPG staff. They'll look into it.` };
  } catch (e) {
    return { content: e.message || 'Could not send that report.' };
  }
}

// ---------- Combat Command ----------
// The caller, if they've linked their Discord and are a WPG member (or staff). Board replies are private.
async function wpgCaller(caller) {
  const u = caller ? await one("SELECT * FROM users WHERE discord_id=$1 AND status='active'", [caller]) : null;
  if (!u) return { error: "Link your Discord to the Barracks app first: type **/link**." };
  const { isWpg } = await import('./combat.js');
  if (!isWpg(u)) return { error: 'The Combat Command board is for WPG members only.' };
  return { user: u };
}

// /apply: where to apply, and how the application is going.
async function cmdApply(_data, caller) {
  const link = `${SITE()}/#/recruitment`;
  const u = caller ? await one("SELECT * FROM users WHERE discord_id=$1 AND status='active'", [caller]) : null;
  if (!u) return { content: `Apply in the WPG Barracks app: ${link}\n(Not in the app yet? Sign in there with Steam first. Already in? Type **/link** so the bot knows you.)` };
  const app = await one('SELECT status, primary_role FROM recruit_applications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [u.id]);
  if (app?.status === 'new') return { content: `Your application (**${app.primary_role}**) is with staff. You'll get a message when it's reviewed.\n${link}` };
  if (u.membership === 'pmc') {
    const r = await one('SELECT status FROM apply_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [u.id]);
    if (r?.status === 'allowed') return { content: `Staff have allowed you to apply — fill in the form here: ${link}` };
    if (r?.status === 'pending') return { content: `Your request to apply is with staff. You'll get a message when they answer.\n${link}` };
    return { content: `As a PMC you ask staff first: open Recruitment and press **Ask to apply**.\n${link}` };
  }
  return { content: `Fill in the WPG application here (primary role, backup role, skills, leadership, pilot): ${link}` };
}

// /roster: the whole force as a picture (WPG members only, only you see it).
async function cmdRoster(_data, caller) {
  const w = await wpgCaller(caller);
  if (w.error) return { content: w.error };
  const { boardData } = await import('./combat.js');
  const b = await boardData();
  const text = () => ({
    content: b.units.map((u) => `**${u.name}** (${u.filled}/${u.size})\n${u.roles.map((r) => `· ${r.name}: ${r.members.map((m) => m.name).join(', ') || '_open_'}`).join('\n')}`).join('\n\n').slice(0, 1900),
  });
  return asPicture('roster', (cards) => cards.renderRosterCard(b), text, { label: 'Open Combat Command', url: `${SITE()}/#/command` });
}

// /unit [name]: one unit as a picture — yours if you don't name one.
async function cmdUnit(data, caller) {
  const w = await wpgCaller(caller);
  if (w.error) return { content: w.error };
  const { boardData } = await import('./combat.js');
  const b = await boardData();
  const asked = String(option(data, 'name') || '').trim().toLowerCase();
  let unit = asked ? b.units.find((u) => u.name.toLowerCase() === asked) || b.units.find((u) => u.name.toLowerCase().startsWith(asked) || u.label.toLowerCase().includes(asked)) : null;
  if (!asked) {
    const mine = await one('SELECT unit_id FROM combat_postings WHERE user_id=$1', [w.user.id]);
    unit = b.units.find((u) => u.id === mine?.unit_id);
    if (!unit) return { content: `You're not posted to a unit yet. Name one: ${b.units.map((u) => `**${u.name}**`).join(', ')}` };
  }
  if (!unit) return { content: `No unit called **${asked}**. Units: ${b.units.map((u) => `**${u.name}**`).join(', ')}` };
  const text = () => ({ content: `**${unit.name}** — ${unit.label}\n${unit.mission}\n${unit.roles.map((r) => `· ${r.name}: ${r.members.map((m) => m.name).join(', ') || '_open_'}`).join('\n')}`.slice(0, 1900) });
  return asPicture('unit', (cards) => cards.renderUnitCard(unit), text, { label: 'Open Combat Command', url: `${SITE()}/#/command` });
}

// Recruitment news: new applications / requests go to the recruitment channel (or the staff channel);
// decisions go to the member as a Discord direct message (if they've linked their Discord).
bus.on('recruit', async (a) => {
  try {
    if (a.type === 'staff') {
      const key = String((await setting('discord_recruit_channel')) || '').trim() ? 'discord_recruit_channel' : 'discord_staff_channel';
      await postToChannel({ embeds: [{ color: GOLD, title: `📋 ${a.title}`, description: `${a.body}\n[Review in the app](${SITE()}/#/admin/recruitment)` }] }, key);
    } else if (a.type === 'member') {
      const u = await one('SELECT discord_id FROM users WHERE id=$1', [a.userId]);
      if (!u?.discord_id || !TOKEN()) return;
      const dm = await discordFetch('/users/@me/channels', 'POST', { recipient_id: u.discord_id });
      await discordFetch(`/channels/${dm.id}/messages`, 'POST', { embeds: [{ color: GOLD, title: a.title, description: `${a.body}\n[Open Recruitment](${SITE()}/#/recruitment)` }] });
    }
  } catch (e) {
    problem('Recruitment message', e.message);
  }
});

// wardogs.tools stopped updating a member (ranking.js): ask them to relink, by Discord direct message. If their DMs
// are closed, WPG members are asked in the automatic posts channel instead (with a mention).
bus.on('tracker:relink', async (a) => {
  try {
    const u = await one('SELECT * FROM users WHERE id=$1', [a.userId]);
    if (!u?.discord_id || !TOKEN()) return;
    const { RELINK_URL } = await import('./ranking.js');
    const why = a.state && !['missing', 'unsynced'].includes(a.state) ? ` (wardogs.tools says your account is **${a.state}**)` : '';
    const embed = {
      color: 0xf5a524,
      title: `🔗 ${a.reminder ? 'Reminder: relink' : 'Relink'} your Wardogs account on wardogs.tools`,
      description: `wardogs.tools has stopped updating your Wardogs stats${why}, so your level, cash and class levels in WPG Barracks are out of date.\n\n`
        + `**1.** Open [wardogs.tools/account](${RELINK_URL}), sign in and link your Wardogs account again.\n`
        + `**2.** Then press **Check now** on your profile in WPG Barracks.`,
      footer: { text: 'Data provided by wardogs.tools · WPG Barracks' },
    };
    const buttons = [{ type: 1, components: [
      { type: 2, style: 5, label: 'Relink on wardogs.tools', url: RELINK_URL },
      { type: 2, style: 5, label: 'Open my profile', url: `${SITE()}/#/u/${u.id}` },
    ] }];
    try {
      const dm = await discordFetch('/users/@me/channels', 'POST', { recipient_id: u.discord_id });
      await discordFetch(`/channels/${dm.id}/messages`, 'POST', { embeds: [embed], components: buttons });
    } catch (e) {
      if (!isWpgMember(u)) throw e;
      await postToChannel({ content: `<@${u.discord_id}> please relink your Wardogs account on wardogs.tools.`, embeds: [embed], components: buttons, allowed_mentions: { users: [u.discord_id] } });
    }
  } catch (e) {
    problem('Relink message', e.message);
  }
});

// Live match money from Steam (steambot.js) for WPG members who switched it on: who's in a match now with the match's
// running profit / loss, and the last 24 hours' totals. Used by /money and the live board.
const signedMoney = (n) => `${n < 0 ? '-' : '+'}$${num(Math.abs(n))}`;
async function moneyEmbed({ live = false } = {}) {
  const { TONIGHT_ROWS } = await import('./steambot.js');
  const [now, tonight] = await Promise.all([
    q(`SELECT u.persona_name AS name, lp.text, lp.money FROM live_presence lp JOIN users u ON u.id = lp.user_id
        WHERE lp.opted_in AND lp.in_game AND lp.text <> '' AND u.status='active' AND u.membership <> 'pmc'
          AND lp.seen_at > now() - interval '15 minutes' ORDER BY lp.money DESC NULLS LAST LIMIT 15`),
    q(`SELECT u.persona_name AS name, SUM(t.money)::int AS total, COUNT(*) FILTER (WHERE t.done)::int AS matches, BOOL_OR(NOT t.done) AS playing
         FROM (${TONIGHT_ROWS}) t JOIN users u ON u.id = t.user_id
        WHERE u.status='active' AND u.membership <> 'pmc' GROUP BY u.id ORDER BY total DESC LIMIT 10`),
  ]);
  const medal = ['🥇', '🥈', '🥉'];
  const matches = (r) => `${r.matches} match${r.matches === 1 ? '' : 'es'}${r.playing ? ' + 1 in progress' : ''}`;
  return {
    title: live ? '💰 Live match money' : '💰 Wardogs match money',
    url: `${SITE()}/#/leaderboard?by=tonight`,
    color: GOLD,
    fields: [
      { name: '🎮 In a match now', value: now.map((r) => `**${cleanName(r.name)}** · ${r.text}`).join('\n').slice(0, 1000) || 'Nobody right now.' },
      { name: '📅 Last 24 hours', value: tonight.map((r, i) => `${medal[i] || `**${i + 1}.**`} ${cleanName(r.name)} — **${signedMoney(r.total)}** (${matches(r)})`).join('\n').slice(0, 1000) || 'No matches in the last 24 hours.' },
    ],
    footer: { text: `${live ? 'Updates by itself · ' : ''}Live from Steam · members who switched on Live match money in WPG Barracks` },
    ...(live ? { timestamp: new Date().toISOString() } : {}),
  };
}
const moneyButtons = () => [{ type: 1, components: [
  { type: 2, style: 5, label: '24-hour money', url: `${SITE()}/#/leaderboard?by=tonight` },
  { type: 2, style: 5, label: 'Switch it on in WPG Barracks', url: `${SITE()}/#/u/me` },
] }];
async function cmdMoney() {
  return { embeds: [await moneyEmbed()], components: moneyButtons() };
}

// The live board: one message in the live match money channel that the bot keeps editing (at most once a minute, and
// only when something changed, or every 10 minutes to refresh its time). Remembered across restarts; if it's deleted
// (or the channel changes), a new one is posted.
const BOARD_KEY = '_money_board_msg';
let boardLast = { body: '', at: 0 };
let boardDirty = true;
bus.on('money:changed', () => { boardDirty = true; });
export async function updateMoneyBoard() {
  if (!TOKEN() || !(await flag('discord_money_board'))) return;
  const channel = String((await setting('discord_money_channel')) || '').trim();
  if (!/^\d{15,22}$/.test(channel)) return;
  const embed = await moneyEmbed({ live: true });
  const body = JSON.stringify(embed.fields);
  if (!boardDirty && body === boardLast.body && Date.now() - boardLast.at < 10 * 60 * 1000) return;
  const payload = { embeds: [embed], components: moneyButtons() };
  const saved = String((await one('SELECT value FROM settings WHERE key=$1', [BOARD_KEY]))?.value || '');
  const [savedChannel, savedId] = saved.split(':');
  let posted = false;
  if (savedChannel === channel && savedId) {
    try {
      await discordFetch(`/channels/${channel}/messages/${savedId}`, 'PATCH', payload);
      posted = true;
    } catch (e) {
      if (!/ 404|10008|Unknown Message/.test(e.message)) throw e; // deleted: post a new one below
    }
  }
  if (!posted) {
    const msg = await discordFetch(`/channels/${channel}/messages`, 'POST', payload);
    await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [BOARD_KEY, `${channel}:${msg.id}`]);
  }
  boardLast = { body, at: Date.now() };
  boardDirty = false;
}

const COMMANDS = {
  stats: { run: cmdStats, description: 'Wardogs stats: level, cash, worth, classes, world ranks' },
  rank: { run: cmdRank, description: 'WPG rank + WPG XP, and clan rank' },
  medals: { run: cmdMedals, description: 'Medals earned' },
  frames: { run: cmdFrames, description: 'Profile frames earned (and still to earn) as an achievement list' },
  server: { run: cmdServer, description: 'WPG server stats: kills, K/D, matches, playtime' },
  progress: { run: cmdProgress, description: 'Next unlocks for each class' },
  leaderboard: { run: cmdLeaderboard, description: 'Top 10 leaderboards' },
  money: { run: cmdMoney, description: "Live Wardogs match money: who's in a match and the last 24 hours' totals" },
  serverboard: { run: cmdServerBoard, description: 'The WPG server leaderboard (top 14)' },
  live: { run: cmdLive, description: 'What is happening on the WPG server right now' },
  link: { run: cmdLink, description: 'Link your Discord to the Barracks app', private: true },
  unlink: { run: cmdUnlink, description: 'Unlink your Discord from the Barracks app', private: true },
  report: { run: cmdReport, description: 'Report a suspected cheater on the WPG server to staff', private: true },
  apply: { run: cmdApply, description: 'Apply to join a WPG combat unit', private: true },
  roster: { run: cmdRoster, description: 'The WPG Combat Command board (WPG members only)', private: true },
  unit: { run: cmdUnit, description: 'One WPG unit and who is in it (WPG members only)', private: true },
};
// Every command: the member commands above plus the moderator ones (discordmod.js), looked up when used.
const allCommands = () => ({ ...COMMANDS, ...MOD_COMMANDS });
const WHO = [
  { type: 6, name: 'member', description: 'Which member (leave empty for yourself)', required: false },
  { type: 3, name: 'name', description: 'Or search by name', required: false },
];
// ---------- Who can use each command (Discord control → Commands) ----------
// Each command has the groups allowed to use it (any combination). "everyone" = anyone on Discord;
// "pmc" = PMC guests linked to the app; "member" = WPG members; "mod" / "admin" = staff. No groups = off.
export const COMMAND_GROUPS = [['everyone', 'Anyone'], ['pmc', 'PMC'], ['member', 'WPG members'], ['mod', 'Mods'], ['admin', 'Admins']];
const GROUP_KEYS = COMMAND_GROUPS.map(([k]) => k);
const TIER = { everyone: 0, pmc: 1, member: 2, mod: 3, admin: 4 };
const defaultGroups = (name) => (MOD_COMMANDS[name] ? ['mod', 'admin'] : ['roster', 'unit'].includes(name) ? ['member', 'mod', 'admin'] : ['everyone']);
// Saved as { name: [groups] } (older saves had one level per command: that level and everyone above it).
function readGroups(v) {
  if (Array.isArray(v)) return GROUP_KEYS.filter((g) => v.includes(g));
  if (v === 'off') return [];
  if (typeof v === 'string' && v in TIER) return v === 'everyone' ? ['everyone'] : GROUP_KEYS.filter((g) => g !== 'everyone' && TIER[g] >= TIER[v]);
  return null;
}
export async function commandAccess() {
  let saved = {};
  try { saved = JSON.parse((await setting('discord_command_access')) || '{}') || {}; } catch { /* keep defaults */ }
  return Object.fromEntries(Object.keys(allCommands()).map((n) => [n, readGroups(saved[n]) ?? defaultGroups(n)]));
}
export const commandList = () => Object.entries(allCommands()).map(([name, c]) => ({ name, description: c.description, moderator: !!MOD_COMMANDS[name], default: defaultGroups(name) }));
// Which group the person running a command is in: the higher of their app rank (once linked with /link) and
// their Discord permissions (Administrator = admin; kick / ban / timeout = mod). Not linked and no staff
// permissions = just "everyone".
async function callerGroup(body) {
  let tier = 0;
  try {
    const p = BigInt(body.member?.permissions || 0);
    if (p & (1n << 3n)) tier = 4;
    else if (p & ((1n << 1n) | (1n << 2n) | (1n << 40n))) tier = 3;
  } catch { /* no permissions sent */ }
  const id = String(body.member?.user?.id || body.user?.id || '');
  const u = id ? await one('SELECT role, status, membership FROM users WHERE discord_id=$1', [id]) : null;
  if (u && u.status === 'active') tier = Math.max(tier, u.role === 'admin' ? 4 : u.role === 'mod' ? 3 : u.membership === 'pmc' ? 1 : 2);
  // On the WPG server, the WPG Member role counts as a WPG member and Wardogs as a PMC guest.
  const guild = await serverId().catch(() => '');
  if (guild && body.guild_id === guild && Array.isArray(body.member?.roles)) {
    const roles = (await loadMap(guild)).roles || {};
    if (roles.wpg && body.member.roles.includes(roles.wpg)) tier = Math.max(tier, 2);
    else if (roles.pmc && body.member.roles.includes(roles.pmc)) tier = Math.max(tier, 1);
  }
  return GROUP_KEYS.find((g) => TIER[g] === tier);
}
const allowedFor = (groups, group) => groups.includes('everyone') || groups.includes(group);
// Hides a command in Discord from people who can't use it, where Discord can tell (only staff groups ticked).
const MOD_PERMS = String((1n << 1n) | (1n << 2n) | (1n << 40n));
function visibility(groups, def) {
  if (groups.some((g) => ['everyone', 'pmc', 'member'].includes(g))) return null; // Discord can't tell: the bot checks
  if (groups.includes('mod')) return def.default_member_permissions || MOD_PERMS;
  return '8'; // admins only
}

async function commandDefinitions() {
  const access = await commandAccess();
  return baseDefinitions().filter((d) => access[d.name].length).map((d) => ({ ...d, default_member_permissions: visibility(access[d.name], d) }));
}
function baseDefinitions() {
  return Object.entries(COMMANDS).map(([name, c]) => {
    const def = { name, description: c.description, type: 1, dm_permission: false };
    if (['stats', 'rank', 'medals', 'frames', 'server', 'progress'].includes(name)) def.options = WHO;
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
    if (name === 'unit') {
      def.options = [{ type: 3, name: 'name', description: 'Unit name, e.g. ALPHA (leave empty for your own unit)', required: false, max_length: 30 }];
    }
    if (name === 'report') {
      def.options = [
        { type: 3, name: 'player', description: 'Their in-game name', required: true, max_length: 64 },
        { type: 3, name: 'reason', description: 'What you saw (when, which map, what happened)', required: true, max_length: 500 },
      ];
    }
    return def;
  }).concat(modCommandDefinitions());
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
  const done = await discordFetch(`/applications/${realAppId()}/commands`, 'PUT', await commandDefinitions());
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
  if (name.startsWith('post:') && POST_PREVIEWS[name.slice(5)]) return POST_PREVIEWS[name.slice(5)](user);
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
    commands_wanted: Object.keys(allCommands()),
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
  const appId = /^\d{15,22}$/.test(String(body.application_id || '')) ? body.application_id : APP_ID();
  // Buttons (3) and pop-up forms (5): the entry check, role buttons, tickets, staff decisions.
  if (body.type === 3 || body.type === 5) {
    let out;
    try {
      out = await handleComponent(body);
    } catch (e) {
      problem(`Button ${body.data?.custom_id || ''}`, e.message);
      return res.json({ type: 4, data: { content: 'Something went wrong. Try again in a minute.', flags: 64 } });
    }
    res.json(out.now);
    if (out.later) {
      let reply;
      try {
        reply = await out.later();
      } catch (e) {
        problem(`Button ${body.data?.custom_id || ''}`, e.message);
        reply = { content: 'Something went wrong. Try again in a minute.' };
      }
      if (reply) await sendReply(`${API}/webhooks/${appId}/${body.token}/messages/@original`, reply);
    }
    return;
  }
  if (body.type !== 2) return res.status(400).json({ error: 'Unsupported' });

  const name = body.data?.name;
  const cmd = allCommands()[name];
  const who = body.member?.user || body.user || {};
  // Who may use it (Discord control → Commands): answered privately when they can't.
  if (cmd) {
    const groups = (await commandAccess())[name];
    if (!groups.length) return res.json({ type: 4, data: { content: 'That command is switched off.', flags: 64 } });
    const group = await callerGroup(body);
    if (!allowedFor(groups, group)) {
      const names = COMMAND_GROUPS.filter(([k]) => groups.includes(k)).map(([, l]) => l);
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
      const hint = group === 'everyone' && groups.some((g) => g === 'pmc' || g === 'member') ? ' Link your Discord to the WPG app with /link first.' : '';
      return res.json({ type: 4, data: { content: `Sorry, /${name} is only for ${list}.${hint}`, flags: 64 } });
    }
  }
  // Answer "thinking…" at once (Discord only waits 3 s), then fill in the real reply.
  res.json({ type: 5, data: cmd?.private ? { flags: 64 } : {} });
  let reply;
  try {
    reply = cmd ? await cmd.run(body.data || {}, String(who.id || ''), who.global_name || who.username, body) : { content: 'Unknown command.' };
  } catch (e) {
    problem(`/${name}`, e.message);
    // Moderator commands say what Discord refused (e.g. the bot's role is below theirs).
    reply = { content: MOD_COMMANDS[name] ? `Couldn't do that: ${e.message.replace(/^Discord \S+ \S+ returned /, '')}` : 'Something went wrong getting that. Try again in a minute.' };
  }
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
    await sendToChannel(channel, payload).catch((e) => problem('Posting to a channel', e.message));
    await new Promise((r) => setTimeout(r, 1500));
  }
  posting = false;
}
// Sends one message; pictures (files) go as attachments.
export async function sendToChannel(channel, { files, ...rest }) {
  const payload = { allowed_mentions: { parse: [] }, ...rest };
  if (!files?.length) return discordFetch(`/channels/${channel}/messages`, 'POST', payload);
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ ...payload, attachments: files.map((x, i) => ({ id: i, filename: x.name })) }));
  files.forEach((x, i) => form.append(`files[${i}]`, new Blob([x.data], { type: x.type || 'image/jpeg' }), x.name));
  const res = await fetch(`${API}/channels/${channel}/messages`, { method: 'POST', headers: { Authorization: `Bot ${TOKEN()}` }, body: form, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Discord said ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json().catch(() => null);
}
// Posts to the channel in a setting: the public post channel, or the staff channel for cheat watch.
export async function postToChannel(payload, settingKey = 'discord_post_channel') {
  if (!TOKEN()) return { ok: false, reason: 'DISCORD_BOT_TOKEN is not set' };
  const channel = String((await setting(settingKey)) || '').trim();
  if (!/^\d{15,22}$/.test(channel)) return { ok: false, reason: 'No channel set for that (Admin → Settings)' };
  postQueue.push({ channel, payload });
  drain();
  return { ok: true };
}

// Cheat watch alerts and reports go to the staff channel (never the public one).
bus.on('staff:alert', (payload) => {
  postToChannel(payload, 'discord_staff_channel').catch((e) => problem('Staff alert', e.message));
});

const mentionFor = (u) => (u?.discord_id ? ` (<@${u.discord_id}>)` : '');

const STREAM_COLORS = { twitch: 0x9146ff, youtube: 0xff0000, kick: 0x53fc18 };
// "🔴 X is live on Twitch" with a link to the stream and to watch it in the app.
function streamEmbed(s, u) {
  const watch = s.live_url || (s.platform === 'youtube' && s.video_id ? `https://www.youtube.com/watch?v=${s.video_id}` : s.channel_url);
  const lines = [
    s.title ? `**${s.title.slice(0, 200)}**` : '',
    s.game ? `Playing ${s.game.slice(0, 100)}` : '',
    `[Watch on ${s.platform_name}](${watch}) · [Watch in the Barracks app](${SITE()}/#/streams/${s.id})`,
  ].filter(Boolean);
  return {
    embeds: [{
      color: STREAM_COLORS[s.platform] || COLOR,
      title: `🔴 ${u.persona_name} is live on ${s.platform_name}`,
      url: watch,
      description: `${lines.join('\n')}${mentionFor(u) ? `\n${mentionFor(u).trim().replace(/^\(|\)$/g, '')}` : ''}`,
      ...(s.thumbnail ? { image: { url: `${s.thumbnail}${s.thumbnail.includes('?') ? '&' : '?'}t=${Date.now()}` } } : {}),
    }],
  };
}
// The live post as a WPG-style picture, with buttons to watch; the plain post if the picture can't be made.
async function streamPost(s, u) {
  const watch = s.live_url || (s.platform === 'youtube' && s.video_id ? `https://www.youtube.com/watch?v=${s.video_id}` : s.channel_url);
  try {
    const { renderStreamCard } = await import('./cards.js');
    const jpg = await renderStreamCard({
      name: u.persona_name, avatar: String(u.custom_avatar || u.avatar || '').startsWith('https://') ? (u.custom_avatar || u.avatar) : '',
      platform: s.platform, platformName: s.platform_name, title: s.title, game: s.game, viewers: s.viewers,
      thumbnail: s.thumbnail ? `${s.thumbnail}${s.thumbnail.includes('?') ? '&' : '?'}t=${Date.now()}` : '',
    });
    return {
      content: `🔴 **${u.persona_name}** is live on ${s.platform_name}!${u.discord_id ? ` <@${u.discord_id}>` : ''}`,
      files: [{ name: 'wpg-live.jpg', data: jpg, type: 'image/jpeg' }],
      components: [{ type: 1, components: [
        { type: 2, style: 5, label: `Watch on ${s.platform_name}`, url: watch },
        { type: 2, style: 5, label: 'Watch in WPG Barracks', url: `${SITE()}/#/streams/${s.id}` },
      ] }],
    };
  } catch (e) {
    problem('Live post picture (sent text instead)', e.message);
    return streamEmbed(s, u);
  }
}
// Channel posts (promotion, medal, WPG rank up) as WPG picture cards, with a one-line summary above
// (that's what shows in phone notifications). Falls back to the plain post if the picture can't be made.
async function announcePicture(kind, text, render, fallback, link) {
  const out = await asPicture(kind, render, fallback, link);
  return out.files ? { content: text, ...out } : out;
}
// rank / from: rows from the ranks table (name, abbr, colour, insignia).
async function promotionPost(u, rank, from) {
  const text = `⬆️ **${u.persona_name}**${mentionFor(u)} has been promoted to **${rank.name}** (${rank.abbr}). Salute!`;
  return announcePicture('promotion', text, async (cards) => cards.renderPromotionCard({
    name: await cardName(u), avatar: avatarOf(u), frame: await frameOf(u), rank, from, xp: u.xp,
  }), () => ({ embeds: [{ color: GOLD, title: '⬆️ Promotion', description: text.replace(/^⬆️ /, ''), url: `${SITE()}/#/u/${u.id}` }] }), profileLink(u));
}
async function medalPost(u, names) {
  const rows = await q('SELECT DISTINCT ON (name) name, description, colors, auto_rule FROM awards WHERE name = ANY($1) ORDER BY name, id', [names]);
  const medals = names.map((n) => rows.find((m) => m.name === n) || { name: n, description: '', colors: '' });
  const tracker = medals.some(trackerMedal); // a class / career level medal: from wardogs.tools stats
  const text = `🎖️ **${u.persona_name}**${mentionFor(u)} earned ${names.map((n) => `**${n}**`).join(', ')}.${tracker ? ` ${TRACKER_CREDIT}` : ''}`;
  const out = await announcePicture('medal', text, async (cards) => cards.renderMedalAwardCard({ name: await cardName(u), avatar: avatarOf(u), frame: await frameOf(u), medals }),
    () => ({ embeds: [{ color: GOLD, title: names.length === 1 ? '🎖️ Medal awarded' : '🎖️ Medals awarded', description: text.replace(/^🎖️ /, ''), url: `${SITE()}/#/u/${u.id}` }] }), profileLink(u));
  return tracker ? withTrackerButton(out) : out;
}
// u may be null (a player on the WPG server who isn't in the app); name is then the bot's name for them.
async function wpgRankPost(u, name, rank, xp, level) {
  const text = `📈 **${u?.persona_name || name}**${mentionFor(u)} reached **${wpgRank(rank)}** (${num(xp)} WPG XP).`;
  const [pos, prog] = await Promise.all([
    one('SELECT COUNT(*)::int + 1 AS n, (SELECT COUNT(*)::int FROM server_progress) AS total FROM server_progress WHERE xp > $1', [xp]),
    rankProgress(xp),
  ]);
  return announcePicture('wpgrank', text, async (cards) => cards.renderWpgRankUpCard({
    name: u ? await cardName(u) : cleanName(name), avatar: u ? avatarOf(u) : '', frame: await frameOf(u), rank, level, xp, position: pos?.n, total: pos?.total,
    from: prog?.from || 0, next: prog?.next || null,
  }), () => ({ embeds: [{ color: COLOR, title: '📈 WPG rank up', description: text.replace(/^📈 /, '') }] }), u ? profileLink(u) : null);
}
// Profile frames (frames.js): a member unlocked one.
async function framePost(u, f) {
  const season = f.category === 'season' ? await one("SELECT name FROM seasons WHERE status='active' ORDER BY number DESC LIMIT 1") : null;
  const kind = f.category === 'season' ? `${season?.name || 'Season'} frame` : f.category === 'clan' ? 'Clan frame' : 'Permanent frame';
  const tracker = TRACKER_METRICS.has(f.metric); // worked out from wardogs.tools stats (level, cash, class level)
  const text = `🖼️ **${u.persona_name}**${mentionFor(u)} unlocked the **${f.name}** profile frame.${tracker ? ` ${TRACKER_CREDIT}` : ''}`;
  const look = await frameLookFor(u, f);
  const out = await announcePicture('frame', text, async (cards) => cards.renderFrameUnlockCard({
    name: await cardName(u), avatar: avatarOf(u), frame: look, description: f.description, kind, credit: tracker,
  }), () => ({ embeds: [{ color: GOLD, title: '🖼️ Profile frame unlocked', description: `${text.replace(/^🖼️ /, '')}\n${f.description}`, url: `${SITE()}/#/u/${u.id}` }] }), profileLink(u));
  return tracker ? withTrackerButton(out) : out;
}
// A new season (the game wiped), and the last season's results: one post each.
async function seasonPost(a) {
  const open = { type: 1, components: [{ type: 2, style: 5, label: 'Open WPG Barracks', url: `${SITE()}/#/leaderboard` }] };
  if (a.type === 'season') {
    return { embeds: [{ color: COLOR, title: `🗓️ ${a.name || `Season ${a.number}`} has begun`,
      description: `The game has wiped. Season frames start again from today, and your WPG XP for the season starts from zero.${a.prev ? ` Season ${a.prev} placings have their permanent frames.` : ''}`,
      footer }], components: [open] };
  }
  const users = await q('SELECT * FROM users WHERE id = ANY($1)', [a.top.map((t) => t.userId)]);
  const medal = ['🥇', '🥈', '🥉'];
  const lines = a.top.map((t) => {
    const u = users.find((x) => x.id === t.userId);
    if (!u) return null;
    const who = isWpgMember(u) ? `**${u.persona_name}**${mentionFor(u)}` : `**${u.persona_name}** (PMC)`;
    return `${medal[t.place - 1] || `**${t.place}.**`} ${who} · ${num(t.gained)} WPG XP`;
  }).filter(Boolean);
  return { embeds: [{ color: GOLD, title: `🏆 Season ${a.number} results`,
    description: `${lines.join('\n')}\n\nThe top 100 earned the Season ${a.number} Top 100 frame, the top 10 the Top 10 frame, and the Champion the Champion frame.`,
    footer }], components: [open] };
}

// Giveaways (giveaways.js): one post when it starts, one with the winners.
async function giveawayPost(a) {
  const button = { type: 1, components: [{ type: 2, style: 5, label: 'Open Giveaways', url: `${SITE()}/#/giveaways` }] };
  const image = /^https:\/\//.test(a.image || '') ? { image: { url: a.image } } : {};
  if (a.event === 'start') {
    const ends = `<t:${Math.floor(new Date(a.end_at).getTime() / 1000)}:R>`;
    const prizes = (a.prizes || []).map((p) => `• ${p.places ? `**${p.places}:** ` : ''}${p.label}${!p.places && p.count > 1 ? ` ×${p.count}` : ''}`).join('\n');
    const stay = `stay until the end of that match${a.drop_min_minutes ? ` and play at least ${a.drop_min_minutes} minutes of it` : ''}`;
    const how = a.kind === 'drop'
      ? `${a.drop_mode === 'manual' ? 'Drops can trigger at any time' : 'Drops trigger at random times'} until ${ends}. Be on the WPG server when one triggers and ${stay}: ${a.drop_to === 'all' ? '**everyone** who does gets the prize' : 'one of you wins'}.`
      : a.kind === 'top' ? `**${a.metric}** on the WPG server until ${ends} wins (finished matches only).`
        : `Runs for the next **${a.matches} match${a.matches === 1 ? '' : 'es'}** on the WPG server (starting now). ${a.entry === 'auto' ? 'Play to be entered.' : 'Press **Enter** in WPG Barracks to take part.'}${a.min_minutes ? ` Play at least ${a.min_minutes} minutes during them.` : ''} The draw is at the end of the last match: be on the server then.`;
    const title = a.kind === 'drop' ? `🎁 Drops: ${a.title}` : a.kind === 'top' ? `🏆 Top players: ${a.title}` : `🎁 Giveaway: ${a.title}`;
    return { embeds: [{ color: GOLD, title, description: `${how}\n\n**Prizes**\n${prizes}${a.description ? `\n\n${a.description}` : ''}`, ...image }], components: [button] };
  }
  const users = new Map((await q('SELECT * FROM users WHERE id = ANY($1)', [(a.winners || []).map((w) => w.userId)])).map((u) => [u.id, u]));
  const all = (a.winners || []).map((w) => {
    const u = users.get(w.userId);
    const who = `**${u?.persona_name || 'Someone'}**${mentionFor(u)}`;
    return a.kind === 'top' ? `**${w.place}.** ${who} (${w.score}): ${w.prize}` : `${who} won **${w.prize}**`;
  });
  // A drop to everyone can have lots of winners: keep the post short.
  const lines = all.length > 25 ? [...all.slice(0, 25), `…and ${all.length - 25} more`] : all;
  const title = a.kind === 'top' ? `🏆 Top players results: ${a.title}` : a.kind === 'drop' ? `🎉 Drop: ${a.title}` : `🎉 Giveaway winners: ${a.title}`;
  return { embeds: [{ color: GOLD, title, description: `${a.kind === 'top' ? `${a.metric}\n\n` : ''}${lines.join('\n')}\n\nGG!`, ...image }], components: [button] };
}
// Admin → Settings preview of the channel posts, made from the admin's own rank, medals and WPG rank.
const POST_PREVIEWS = {
  promotion: async (u) => {
    const rank = (u.rank_id && (await one('SELECT * FROM ranks WHERE id=$1', [u.rank_id]))) || (await one('SELECT * FROM ranks ORDER BY sort_order LIMIT 1'));
    if (!rank) throw new Error('No ranks set up yet.');
    return promotionPost(u, rank, await one('SELECT * FROM ranks WHERE sort_order < $1 ORDER BY sort_order DESC LIMIT 1', [rank.sort_order]));
  },
  medal: async (u) => {
    const got = await q('SELECT a.name FROM user_awards ua JOIN awards a ON a.id = ua.award_id WHERE ua.user_id=$1 ORDER BY ua.given_at DESC LIMIT 1', [u.id]);
    const names = got.length ? got.map((r) => r.name) : (await q('SELECT name FROM awards ORDER BY sort_order, id LIMIT 1')).map((r) => r.name);
    if (!names.length) throw new Error('No medals set up yet.');
    return medalPost(u, names);
  },
  wpgrank: async (u) => {
    const p = await one('SELECT * FROM server_progress WHERE steam_id=$1', [u.steam_id]);
    return wpgRankPost(u, u.persona_name, p?.rank_name || 'RECRUIT I', p?.xp || 0, p?.rank_level || 1);
  },
};
// Promotion, medal and WPG rank-up posts are for WPG members only (not PMC guests or players who aren't in the
// app), so the clan channel isn't filled with news about people outside the clan. PMCs who want them apply to join.
const isWpgMember = (u) => !!u && u.status === 'active' && u.membership !== 'pmc';

// Other parts of the app raise 'announce' events; each type can be switched off in Admin → Settings.
bus.on('announce', async (a) => {
  try {
    if (a.type === 'promotion' && (await flag('discord_post_promotions'))) {
      const u = await one('SELECT * FROM users WHERE id=$1', [a.userId]);
      if (isWpgMember(u)) await postToChannel(await promotionPost(u, a.rank, a.from));
    } else if (a.type === 'medals' && (await flag('discord_post_medals'))) {
      const u = await one('SELECT * FROM users WHERE id=$1', [a.userId]);
      if (isWpgMember(u) && a.names?.length) await postToChannel(await medalPost(u, a.names));
    } else if (a.type === 'wpgrank' && (await flag('discord_post_wpg_ranks'))) {
      const u = await one("SELECT * FROM users WHERE steam_id=$1 AND status='active'", [a.steamId]);
      if (isWpgMember(u)) await postToChannel(await wpgRankPost(u, a.name, a.rank, a.xp, a.level));
    } else if (a.type === 'giveaway' && (await flag('discord_post_giveaways'))) {
      const { giveawayChannelKey } = await import('./giveaways.js');
      await postToChannel(await giveawayPost(a), await giveawayChannelKey());
    } else if (a.type === 'bigwin' && (await flag('discord_post_big_wins'))) {
      const u = await one('SELECT * FROM users WHERE id=$1', [a.userId]);
      if (isWpgMember(u)) {
        // The live match money channel (Admin → Steam bot), else the channel for the other automatic posts.
        const key = String((await setting('discord_money_channel')) || '').trim() ? 'discord_money_channel' : 'discord_post_channel';
        await postToChannel({
          content: `💰 **${u.persona_name}**${mentionFor(u)} just made **+$${num(a.money)}** profit in one Wardogs match!`,
          components: [{ type: 1, components: [{ type: 2, style: 5, label: '24-hour money', url: `${SITE()}/#/leaderboard?by=tonight` }] }],
        }, key);
      }
    } else if (a.type === 'frame' && (await flag('discord_post_frames'))) {
      const [u, f] = await Promise.all([one('SELECT * FROM users WHERE id=$1', [a.userId]), one('SELECT * FROM frames WHERE id=$1', [a.frameId])]);
      if (isWpgMember(u) && f) await postToChannel(await framePost(u, f));
    } else if ((a.type === 'season' || a.type === 'season-results') && (await flag('discord_post_frames'))) {
      await postToChannel(await seasonPost(a));
    } else if (a.type === 'stream' && (await flag('discord_post_streams'))) {
      const { streamForAnnounce } = await import('./streams.js');
      const d = await streamForAnnounce(a.accountId);
      if (d?.user) await postToChannel(await streamPost(d.stream, d.user), 'discord_stream_channel');
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
  // The live match money board (once a minute; it only edits when something changed).
  setInterval(() => updateMoneyBoard().catch((e) => problem('Live money board', e.message)), 60 * 1000);
}
