// Game servers: live status from Wardog Servers (https://wardogservers.com, free, credit required)
// and admin controls through the official WARDOGS RCON HTTP API (needs the host's RCON address + password).
import express from 'express';
import { q, one, audit } from './db.js';
import { usersWithRanks } from './routes.js';
import { HttpError, member, role, roleAtLeast, str, int } from './util.js';

export const servers = express.Router();

const LIVE_API = 'https://api.wardogservers.com/v1';
let liveCache = { at: 0, byCode: new Map(), stale: false };

async function liveFetch(path) {
  const res = await fetch(`${LIVE_API}${path}`, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'WPG-Barracks/1.0' },
  });
  if (!res.ok) throw new Error(`Wardog Servers returned ${res.status}`);
  return res.json();
}

async function liveStatus(joinCodes) {
  if (Date.now() - liveCache.at < 60 * 1000 && joinCodes.every((c) => liveCache.byCode.has(c))) return liveCache;
  const byCode = new Map();
  let stale = false;
  for (const code of joinCodes) {
    try {
      const data = await liveFetch(`/servers?q=${encodeURIComponent(code)}&limit=5`);
      stale = stale || !!data.meta?.stale;
      byCode.set(code, (data.data || []).find((s) => s.serverId === code) || null);
    } catch {
      byCode.set(code, liveCache.byCode.get(code) ?? null);
      stale = true;
    }
  }
  liveCache = { at: Date.now(), byCode, stale };
  return liveCache;
}

function shape(row, live, staff) {
  return {
    id: row.id,
    join_code: row.join_code,
    name: row.name || live?.name || 'Server',
    description: row.description,
    has_rcon: !!(row.rcon_url && row.rcon_password),
    ...(staff ? { rcon_url: row.rcon_url } : {}),
    online: !!live,
    live: live
      ? {
          name: live.name,
          players: live.players,
          maxPlayers: live.maxPlayers,
          reservedPlayers: live.reservedPlayers,
          region: live.region,
          map: live.map?.variant || '',
          world: live.map?.base || '',
          mode: live.mode?.experience || '',
          rulesets: live.rulesets || [],
          passwordProtected: !!live.passwordProtected,
          observedAt: live.observedAt,
        }
      : null,
  };
}

servers.get('/servers', member, async (req, res) => {
  const rows = await q('SELECT * FROM game_servers WHERE enabled = true ORDER BY sort_order, id');
  const live = await liveStatus(rows.map((r) => r.join_code));
  const staff = roleAtLeast(req.user.role, 'mod');
  res.json({ servers: rows.map((r) => shape(r, live.byCode.get(r.join_code), staff)), stale: live.stale });
});

// ---------- RCON ----------
async function rcon(server, method, path, body) {
  if (!server.rcon_url || !server.rcon_password) throw new HttpError(400, 'RCON is not set up for this server yet.');
  const base = server.rcon_url.replace(/\/+$/, '').replace(/\/v1$/, '');
  let res;
  try {
    res = await fetch(`${base}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${server.rcon_password}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new HttpError(502, `Can't reach the game server's RCON (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'The game server rejected the RCON password.');
  if (!res.ok) throw new HttpError(502, `Game server said: ${data?.error?.message || data?.error || data?.message || res.status}`);
  return data;
}

async function getServer(id) {
  const s = await one('SELECT * FROM game_servers WHERE id=$1', [int(id)]);
  if (!s) throw new HttpError(404, 'Server not found.');
  return s;
}

const playersCache = new Map();

// Who's on the server right now. Members can see it; Steam IDs are matched to WPG profiles.
servers.get('/servers/:id/players', member, async (req, res) => {
  const s = await getServer(req.params.id);
  const cached = playersCache.get(s.id);
  let players;
  if (cached && Date.now() - cached.at < 15000) players = cached.players;
  else {
    const data = await rcon(s, 'GET', '/players');
    players = Array.isArray(data?.players) ? data.players : Array.isArray(data) ? data : [];
    playersCache.set(s.id, { at: Date.now(), players });
  }
  const ids = players.map((p) => String(p.steamId || '')).filter(Boolean);
  const users = ids.length ? await usersWithRanks(await q("SELECT * FROM users WHERE steam_id = ANY($1) AND status='active'", [ids])) : [];
  const bySteam = new Map(users.map((u) => [u.steam_id, u]));
  res.json(players.map((p) => ({
    name: str(p.name, 64),
    steamId: String(p.steamId || ''),
    faction: p.faction ?? '',
    kills: p.kills ?? null,
    deaths: p.deaths ?? null,
    pingMs: p.pingMs ?? null,
    member: bySteam.get(String(p.steamId || '')) || null,
  })));
});

servers.get('/admin/servers/:id/status', role('mod'), async (req, res) => {
  const s = await getServer(req.params.id);
  res.json(await rcon(s, 'GET', '/status'));
});

servers.get('/admin/servers/:id/bans', role('admin'), async (req, res) => {
  const s = await getServer(req.params.id);
  res.json(await rcon(s, 'GET', '/bans'));
});

// Mods: broadcast, kick, kill. Admins: also ban, unban, restart, end match, change map.
const ACTIONS = {
  broadcast: { min: 'mod', run: (s, b) => rcon(s, 'POST', '/broadcast', { message: need(str(b.message, 300), 'Type a message.') }) },
  kick: { min: 'mod', run: (s, b) => rcon(s, 'POST', `/players/${steamId(b)}/kick`, { reason: str(b.reason, 200) || 'Kicked by WPG staff' }) },
  kill: { min: 'mod', run: (s, b) => rcon(s, 'POST', `/players/${steamId(b)}/kill`) },
  ban: { min: 'admin', run: (s, b) => rcon(s, 'POST', '/bans', { steamId: steamId(b), reason: str(b.reason, 200) || 'Banned by WPG staff' }) },
  unban: { min: 'admin', run: (s, b) => rcon(s, 'DELETE', `/bans/${steamId(b)}`) },
  restart: { min: 'admin', run: (s) => rcon(s, 'POST', '/match/restart') },
  end: { min: 'admin', run: (s) => rcon(s, 'POST', '/match/end') },
  map: { min: 'admin', run: (s, b) => rcon(s, 'POST', '/match/map', { map: need(str(b.map, 80), 'Type a map name.') }) },
};
function need(v, msg) {
  if (!v) throw new HttpError(400, msg);
  return v;
}
function steamId(b) {
  const id = String(b.steamId || '').trim();
  if (!/^\d{17}$/.test(id)) throw new HttpError(400, 'That is not a valid Steam ID.');
  return id;
}

servers.post('/admin/servers/:id/action', role('mod'), async (req, res) => {
  const s = await getServer(req.params.id);
  const b = req.body || {};
  const action = ACTIONS[b.action];
  if (!action) throw new HttpError(400, 'Unknown action.');
  if (!roleAtLeast(req.user.role, action.min)) throw new HttpError(403, 'Only admins can do that.');
  const result = await action.run(s, b);
  playersCache.delete(s.id);
  await audit(req.user.id, `server.${b.action}`, s.name || s.join_code, {
    steamId: b.steamId, reason: b.reason, message: b.message, map: b.map,
  });
  res.json({ ok: true, result });
});

// Admin helper: find a server in the public list by name or join code.
servers.get('/admin/servers/search', role('admin'), async (req, res) => {
  const term = str(req.query.q, 200);
  if (term.length < 2) return res.json([]);
  const data = await liveFetch(`/servers?q=${encodeURIComponent(term)}&limit=20`);
  res.json((data.data || []).map((s) => ({ join_code: s.serverId, name: s.name, players: s.players, maxPlayers: s.maxPlayers, region: s.region, type: s.type })));
});
