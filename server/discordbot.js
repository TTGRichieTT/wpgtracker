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

const API = 'https://discord.com/api/v10';
const WPG_APP_ID = '1555526462319366165';
const WPG_PUBLIC_KEY = 'f7572684d37e69c27da9c32bcd5519eb2d94683760a64776c155246159f48710';
const APP_ID = () => process.env.DISCORD_APP_ID || WPG_APP_ID;
const TOKEN = () => process.env.DISCORD_BOT_TOKEN || '';
const PUBLIC_KEY = () => process.env.DISCORD_PUBLIC_KEY || WPG_PUBLIC_KEY;
const SITE = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://wpg-barracks.onrender.com').replace(/\/$/, '');
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
  if (!sig || !ts || !PUBLIC_KEY()) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(PUBLIC_KEY(), 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.concat([Buffer.from(ts), raw]), key, Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
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

// ---------- Commands ----------
async function cmdStats(data, caller) {
  const f = await findMember(data, caller);
  if (f.error) return { content: f.error };
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

async function cmdRank(data, caller) {
  const f = await findMember(data, caller);
  if (f.error) return { content: f.error };
  const p = await one('SELECT xp, rank_name FROM server_progress WHERE steam_id=$1', [f.user.steam_id]);
  const pos = p ? await one('SELECT COUNT(*)::int + 1 AS n FROM server_progress WHERE xp > $1', [p.xp]) : null;
  const pmc = f.user.membership === 'pmc';
  return {
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
  };
}

async function cmdMedals(data, caller) {
  const f = await findMember(data, caller);
  if (f.error) return { content: f.error };
  const awards = topTierOnly(await q(
    `SELECT ua.id, ua.given_at, a.name, a.description, a.auto_rule, a.sort_order
       FROM user_awards ua JOIN awards a ON a.id = ua.award_id WHERE ua.user_id=$1 ORDER BY a.sort_order, ua.given_at`,
    [f.user.id],
  ));
  const ach = await one('SELECT COUNT(*)::int AS n FROM user_achievements WHERE user_id=$1', [f.user.id]);
  const list = awards.map((a) => `🎖️ **${a.name}**`).join('\n');
  return {
    embeds: [{
      ...header(f.user),
      title: `Medals (${awards.length})`,
      color: GOLD,
      description: (list || 'No medals yet.').slice(0, 3900),
      fields: [{ name: 'Steam achievements', value: num(ach?.n), inline: true }],
      footer,
    }],
  };
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
  return {
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
  };
}

const BOARDS = {
  wpg: {
    title: 'WPG rank',
    sql: `SELECT bot_name AS name, xp AS v, rank_name AS extra FROM server_progress ORDER BY xp DESC, bot_name LIMIT 10`,
    show: (r) => `**${num(r.v)}** WPG XP · ${wpgRank(r.extra)}`,
  },
  clan: {
    title: 'Clan XP',
    sql: `SELECT persona_name AS name, xp AS v FROM users WHERE status='active' ORDER BY xp DESC LIMIT 10`,
    show: (r) => `**${num(r.v)}** Clan XP`,
  },
  level: {
    title: 'Wardog level',
    sql: `SELECT u.persona_name AS name, (ws.official->>'wardogLevel')::int AS v FROM users u JOIN wardogs_stats ws ON ws.user_id=u.id
           WHERE u.status='active' AND ws.official IS NOT NULL ORDER BY v DESC NULLS LAST LIMIT 10`,
    show: (r) => `Level **${num(r.v)}**`,
  },
  worth: {
    title: 'Account worth',
    sql: `SELECT u.persona_name AS name, (ws.official->>'worth')::bigint AS v FROM users u JOIN wardogs_stats ws ON ws.user_id=u.id
           WHERE u.status='active' AND ws.official->>'worth' IS NOT NULL ORDER BY v DESC NULLS LAST LIMIT 10`,
    show: (r) => `**${money(r.v)}**`,
  },
  kills: {
    title: 'WPG server kills',
    sql: `SELECT name, kills AS v FROM server_players ORDER BY kills DESC LIMIT 10`,
    show: (r) => `**${num(r.v)}** kills`,
  },
};
async function cmdLeaderboard(data) {
  const b = BOARDS[option(data, 'board')] || BOARDS.wpg;
  const rows = await q(b.sql);
  const medal = ['🥇', '🥈', '🥉'];
  return {
    embeds: [{
      title: `🏆 ${b.title} — top 10`,
      url: `${SITE()}/#/leaderboard`,
      color: GOLD,
      description: rows.map((r, i) => `${medal[i] || `**${i + 1}.**`} ${String(r.name || '').trim() || 'Unknown'} — ${b.show(r)}`).join('\n') || 'No data yet.',
      footer,
    }],
  };
}

async function cmdLive() {
  const servers = await q("SELECT * FROM game_servers WHERE enabled = true AND rcon_url <> '' AND rcon_password <> '' ORDER BY sort_order, id");
  if (!servers.length) return { content: 'No game server is set up for live info yet.' };
  const embeds = [];
  for (const s of servers.slice(0, 3)) {
    const m = await liveMatch(s).catch((e) => ({ error: e.message }));
    if (m.error) { embeds.push({ title: s.name || 'Game server', color: 0xe05252, description: `Can't reach the server right now.` }); continue; }
    embeds.push({
      title: `🎮 ${m.name || s.name || 'WPG server'}`,
      url: `${SITE()}/#/servers`,
      color: COLOR,
      description: `**${m.map}** · ${[m.mode, ...(m.modifiers || [])].join(' + ')} · ${m.lighting}${m.zone ? ` · ${m.zone}` : ''}`,
      fields: [
        { name: 'Players', value: `${num(m.players)} / ${num(m.maxPlayers)}`, inline: true },
        ...m.scores.map((f) => ({ name: f.name, value: num(f.score), inline: true })),
        ...(m.next ? [{ name: 'Next map', value: `${m.next.map}${m.next.mode ? ` · ${m.next.mode}` : ''}` }] : []),
      ],
      footer: { text: `Join code: ${s.join_code} · WPG Barracks` },
    });
  }
  return { embeds };
}

async function cmdProgress(data, caller) {
  const f = await findMember(data, caller);
  if (f.error) return { content: f.error };
  const ws = await one('SELECT official FROM wardogs_stats WHERE user_id=$1', [f.user.id]);
  const o = ws?.official;
  if (!o) return { content: `**${f.user.persona_name}** has no Wardogs stats yet. They add their in-game name (Name#1234) on HQ in the app.` };
  const unlocks = await q('SELECT role, level, name, cost FROM unlocks ORDER BY level, name');
  const bought = new Set((await q('SELECT role, name FROM user_unlocks WHERE user_id=$1', [f.user.id])).map((r) => `${r.role}|${r.name}`));
  const levelOf = (role) => (role === 'career' ? Number(o.wardogLevel) || 0 : Number(o.roles?.[role]?.level ?? o.roles?.[role]) || 0);
  let readyCount = 0;
  let readyCost = 0;
  const lines = [['career', 'Career'], ...ROLES].map(([role, label]) => {
    const lvl = levelOf(role);
    const mine = unlocks.filter((u) => u.role === role);
    for (const u of mine) {
      if (u.level <= lvl && u.cost > 0 && !bought.has(`${role}|${u.name}`)) { readyCount++; readyCost += u.cost; }
    }
    const next = mine.find((u) => u.level > lvl);
    return `**${label}** ${lvl} → ${next ? `next: ${next.name} at ${next.level}` : 'all unlocked'}`;
  });
  return {
    embeds: [{
      ...header(f.user),
      title: 'Progression',
      url: `${SITE()}/#/progression`,
      color: COLOR,
      description: lines.join('\n'),
      fields: [{ name: 'Reached but not bought', value: readyCount ? `${num(readyCount)} items · ${money(readyCost)}` : 'Nothing waiting' }],
      footer: { text: 'Tick what you have bought on the Progression page · WPG Barracks' },
    }],
  };
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
    return def;
  });
}

// Remembers setup milestones (shown as ticks in Admin → Settings). Hidden settings start with "_".
async function remember(key, value) {
  await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
}

// Tells Discord which commands exist (for every server the bot is in, so it works whichever order
// the setup steps are done in). Running it again just replaces the list.
export async function registerCommands() {
  if (!botReady()) return { ok: false, reason: 'DISCORD_BOT_TOKEN is not set in Render yet' };
  const done = await discordFetch(`/applications/${APP_ID()}/commands`, 'PUT', commandDefinitions());
  await remember('_discord_commands_ok', new Date().toISOString());
  return { ok: true, count: done?.length || 0, where: 'every server the bot is in' };
}

// Setup checklist for Admin → Settings: each step is ticked once it has really worked.
export async function botStatus() {
  const endpoint = await one("SELECT value FROM settings WHERE key='_discord_endpoint_ok'");
  const commands = await one("SELECT value FROM settings WHERE key='_discord_commands_ok'");
  const out = {
    token: botReady(),
    endpoint_checked: endpoint?.value || null,
    commands_ready: commands?.value || null,
    bot_name: null,
    in_server: null,
    token_problem: null,
  };
  if (botReady()) {
    try {
      out.bot_name = (await discordFetch('/users/@me'))?.username || null;
      const guild = await guildId().catch(() => null);
      const guilds = await discordFetch('/users/@me/guilds');
      out.in_server = guild ? (guilds || []).some((g) => g.id === guild) : (guilds || []).length > 0;
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
    console.warn('[discord bot]', name, e.message);
    reply = { content: 'Something went wrong getting that. Try again in a minute.' };
  }
  await fetch(`${API}/webhooks/${APP_ID()}/${body.token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...reply }),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => console.warn('[discord bot] reply failed', e.message));
});

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

// Sets the commands up on every start, and keeps retrying every 10 minutes until it works.
export function startDiscordBot() {
  if (!botReady()) {
    console.log('[WPG] Discord bot: commands answer, but DISCORD_BOT_TOKEN is not set, so no command setup or channel posts.');
    return;
  }
  const attempt = () => {
    registerCommands()
      .then((r) => console.log(`[discord bot] ${r.count} commands ready (${r.where})`))
      .catch((e) => {
        console.warn('[discord bot] could not set up commands, trying again in 10 minutes:', e.message);
        setTimeout(attempt, 10 * 60 * 1000);
      });
  };
  setTimeout(attempt, 10 * 1000);
}
