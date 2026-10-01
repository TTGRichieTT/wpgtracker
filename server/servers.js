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
// Turns low-level network errors into advice a person can act on.
function reachReason(e, base) {
  const cause = e?.cause || {};
  const code = String(cause.code || cause.errno || '');
  const msg = `${e?.message || ''} ${cause.message || ''}`;
  if (e?.name === 'TimeoutError' || /TIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(code)) {
    return 'no answer (timed out). The port may be blocked by the host or a firewall, or the server is offline.';
  }
  if (/ECONNREFUSED/i.test(code)) return 'connection refused. Check the port number, and that RCON is switched on (Remote Access) in the host panel.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(code)) return 'address not found. Check the IP / address for typos.';
  if (/SSL|TLS|EPROTO|wrong version/i.test(`${code} ${msg}`) || (/ECONNRESET|UND_ERR_SOCKET/i.test(code) && base.startsWith('https:'))) {
    return 'secure-connection error. The server speaks plain http — change the address to start with http:// instead of https://.';
  }
  if (/ECONNRESET/i.test(code)) return 'the connection was dropped by the server or a firewall.';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(code)) return 'the network path to the server is blocked.';
  return `${code || 'network error'}${cause.message ? ` (${cause.message})` : ''}.`;
}

export async function rcon(server, method, path, body) {
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
    throw new HttpError(502, `Can't reach the game server's RCON at ${base}: ${reachReason(e, base)}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'The game server rejected the RCON password. Fix it in Servers → Server settings (use the same password that works on rcon.wardogs.com).');
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

// ---------- Live match (via RCON), shown to all members ----------
const spaceCamel = (t) => String(t || '').replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
const isModifier = (id) => /^KOTH_(InfantryOnly|Hardcore)|infantry|hardcore/i.test(String(id)) && !/_KOTH_\d+$/i.test(String(id));
const modeLabel = (id) => (!id ? '' : /koth|kingofthehill/i.test(String(id).replace(/[_\s]/g, '')) ? 'King of the Hill' : spaceCamel(id));
const modLabel = (id) => (/infantry/i.test(id) ? 'Infantry only' : /hardcore/i.test(id) ? 'Hardcore' : spaceCamel(id));
// Servers only report internal map IDs; these are the names players see (same as the official RCON console).
const MAP_NAMES = { Kavkazi: 'Bakurani', Europe: 'Ozeti', NorthAmerica: 'Zestafona', Madrid: 'Ozeti', Detroit: 'Zestafona' };
const expLabel = (id) => (isModifier(id) ? modLabel(id) : modeLabel(id));
// "ZoneAlternator.Ozeti.Church.Circle" -> "Church Circle"
const zoneLabel = (z) => { const parts = String(z || '').replace(/^ZoneAlternator./, '').split('.').slice(1); return parts.includes('Default') ? '' : spaceCamel(parts.join(' ')); };

const catalogCache = new Map();
async function catalog(s) {
  const hit = catalogCache.get(s.id);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit;
  const maps = await rcon(s, 'GET', '/catalog/maps').catch(() => ({}));
  const entry = {
    at: Date.now(),
    maps: new Map((maps?.maps || []).map((m) => [m.id, m.displayName || m.id])),
  };
  catalogCache.set(s.id, entry);
  return entry;
}

const liveCacheRcon = new Map();
servers.get('/servers/:id/live', member, async (req, res) => {
  const s = await getServer(req.params.id);
  const hit = liveCacheRcon.get(s.id);
  if (hit && Date.now() - hit.at < 15000) return res.json(hit.data);
  const [st, cat, rot] = await Promise.all([
    rcon(s, 'GET', '/status'),
    catalog(s),
    rcon(s, 'GET', '/rotation').catch(() => null),
  ]);
  const mapName = (id) => MAP_NAMES[id] || (cat.maps.get(id) !== id && cat.maps.get(id)) || spaceCamel(id) || '—';
  const exps = Array.isArray(st?.experiences) ? st.experiences : [];
  const entries = Array.isArray(rot?.entries) ? rot.entries : [];
  const next = rot?.enabled ? entries.find((e) => e.status === 'next') : null;
  const data = {
    name: str(st?.serverName, 120),
    map: mapName(st?.map),
    mode: modeLabel(exps.find((e) => !isModifier(e))) || '—',
    modifiers: exps.filter(isModifier).map(modLabel),
    lighting: spaceCamel(st?.lighting) || '—',
    players: Number(st?.players?.current ?? 0),
    maxPlayers: Number(st?.players?.max ?? 0),
    matchSeconds: Number.isFinite(Number(st?.matchSeconds)) && st?.matchSeconds !== undefined ? Number(st.matchSeconds) : null,
    zone: zoneLabel(st?.alternator),
    scoreCap: Number(st?.scoreCap) || 100,
    scores: (Array.isArray(st?.factionScores) ? st.factionScores : []).slice(0, 6).map((f) => ({
      name: str(f?.name, 40),
      score: Number(f?.score) || 0,
      color: /^#?[0-9a-f]{6}$/i.test(String(f?.colorHex || '')) ? `#${String(f.colorHex).replace('#', '')}` : '',
    })),
    queued: !!(await queuedMap(s.id)),
    next: next ? { map: mapName(next.map), mode: modeLabel((next.experiences || []).find((e) => !isModifier(e))) || '', lighting: spaceCamel(next.lighting), zone: zoneLabel(next.zoneAlternator) } : null,
  };
  liveCacheRcon.set(s.id, { at: Date.now(), data });
  res.json(data);
});

servers.get('/admin/servers/:id/status', role('mod'), async (req, res) => {
  const s = await getServer(req.params.id);
  res.json(await rcon(s, 'GET', '/status'));
});

// Map list for "Change map". Map IDs differ from in-game names (e.g. Kavkazi = Bakurani).
servers.get('/admin/servers/:id/maps', role('admin'), async (req, res) => {
  const s = await getServer(req.params.id);
  const data = await rcon(s, 'GET', '/catalog/maps');
  res.json((data?.maps || []).map((m) => ({ id: m.id, name: MAP_NAMES[m.id] || m.displayName || m.id })));
});

servers.get('/admin/servers/:id/maps/:mapId/modes', role('admin'), async (req, res) => {
  const s = await getServer(req.params.id);
  const mapId = encodeURIComponent(str(req.params.mapId, 80));
  const [forMap, all] = await Promise.all([
    rcon(s, 'GET', `/catalog/maps/${mapId}/experiences`),
    rcon(s, 'GET', '/catalog/experiences').catch(() => ({})),
  ]);
  const names = new Map((all?.experiences || []).map((e) => [e.id, e.displayName || e.id]));
  res.json((forMap?.experiences || []).map((id) => ({ id: String(id), name: expLabel(id) || names.get(id) || String(id) })));
});

// Time-of-day presets and control zones for "Change map" (and the time-of-day button).
const catalogIds = (data, key) => {
  const list = Array.isArray(data) ? data : data?.[key] || [];
  return list.map((x) => (typeof x === 'string' ? x : x?.id || x?.name)).filter(Boolean).map(String);
};
servers.get('/admin/servers/:id/lightings', role('admin'), async (req, res) => {
  const s = await getServer(req.params.id);
  res.json(catalogIds(await rcon(s, 'GET', '/catalog/lightings'), 'lightings'));
});
servers.get('/admin/servers/:id/maps/:mapId/zones', role('admin'), async (req, res) => {
  const s = await getServer(req.params.id);
  const mapId = encodeURIComponent(str(req.params.mapId, 80));
  res.json(catalogIds(await rcon(s, 'GET', `/catalog/maps/${mapId}/alternators`).catch(() => []), 'alternators'));
});
// Faction names for "Move player to faction".
servers.get('/admin/servers/:id/factions', role('mod'), async (req, res) => {
  const s = await getServer(req.params.id);
  const st = await rcon(s, 'GET', '/status');
  res.json((st?.factionScores || []).map((f) => f.name).filter(Boolean));
});

servers.get('/admin/servers/:id/bans', role('admin'), async (req, res) => {
  const s = await getServer(req.params.id);
  res.json(await rcon(s, 'GET', '/bans'));
});

// ---------- Map queue ----------
// The rotation is random, so a map can't simply be slotted in "next". Instead the rotation is
// saved, set to just the queued map, and put back by the tracker as soon as that map starts.
// Only the rotation lines are touched; the rest of the config is left exactly as it is.
const ROT_SECTION = '[/Script/WDGame.WDServerMapRotationSettings]';
const SAFE_ID = /^[A-Za-z0-9_.+-]+$/;

function rotationLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === ROT_SECTION);
  if (start < 0) throw new HttpError(502, "The server's config has no map rotation.");
  let end = lines.findIndex((l, i) => i > start && l.trim().startsWith('['));
  if (end < 0) end = lines.length;
  const entries = [];
  for (let i = start + 1; i < end; i++) if (lines[i].trim().startsWith('.RotationEntries=')) entries.push(i);
  return { lines, start, end, entries, eol: String(text).includes('\r\n') ? '\r\n' : '\n' };
}
function withEntries(text, newEntries) {
  const r = rotationLines(text);
  const at = r.entries.length ? r.entries[0] : r.end;
  const kept = r.lines.filter((_, i) => !r.entries.includes(i));
  kept.splice(at, 0, ...newEntries);
  return kept.join(r.eol);
}
async function saveConfig(s, text, revision) {
  const check = await rcon(s, 'POST', '/config/validate', { text, revision });
  if (!check?.ok || check.errors?.length) {
    const why = (check?.errors || []).map((e) => e?.message || e).join(' ');
    throw new HttpError(502, `The server would not accept the change${why ? `: ${why}` : '.'}`);
  }
  return rcon(s, 'PUT', '/config', { text, revision });
}

export async function queuedMap(serverId) {
  const row = await one('SELECT data FROM rotation_queue WHERE server_id=$1', [serverId]);
  return row?.data?.original ? row.data : null;
}

async function queueMap(s, b) {
  const map = need(str(b.map, 80), 'Pick a map.');
  const exps = (Array.isArray(b.experiences) ? b.experiences : []).map((e) => str(e, 80)).filter(Boolean).slice(0, 10);
  const lighting = str(b.lighting, 60);
  const alternator = str(b.alternator, 120);
  for (const v of [map, ...exps, lighting, alternator]) {
    if (v && !SAFE_ID.test(v)) throw new HttpError(400, 'That map choice has odd characters in it.');
  }
  const rot = await rcon(s, 'GET', '/rotation');
  if (!rot?.enabled) throw new HttpError(400, 'Map rotation is turned off on this server, so nothing can be queued.');
  const cfg = await rcon(s, 'GET', '/config');
  if (!cfg?.writable) throw new HttpError(400, "This server's config can't be changed over RCON.");
  const saved = await queuedMap(s.id);
  const r = rotationLines(cfg.text);
  if (!saved && !r.entries.length) throw new HttpError(502, 'The rotation has no maps in it to save.');
  const original = saved ? saved.original : r.entries.map((i) => r.lines[i]);
  const fields = [`Map="${map}"`];
  if (exps.length) fields.push(`Experience="${exps.join('+')}"`);
  if (lighting) fields.push(`Lighting="${lighting}"`);
  if (alternator) fields.push(`ZoneAlternator="${alternator}"`);
  await saveConfig(s, withEntries(cfg.text, [`.RotationEntries=(${fields.join(',')})`]), cfg.revision);
  // Saved only after the server took the change, so a failed queue never leaves a stale copy.
  await q(
    `INSERT INTO rotation_queue (server_id, data, created_at) VALUES ($1,$2,now())
     ON CONFLICT (server_id) DO UPDATE SET data=EXCLUDED.data, created_at=now()`,
    [s.id, JSON.stringify({ original, map, alternator, at: Date.now() })],
  );
}

// Puts the saved rotation back. Safe to call when nothing is queued.
export async function restoreRotation(s) {
  const saved = await queuedMap(s.id);
  if (!saved) return false;
  const cfg = await rcon(s, 'GET', '/config');
  await saveConfig(s, withEntries(cfg.text, saved.original), cfg.revision);
  await q('DELETE FROM rotation_queue WHERE server_id=$1', [s.id]);
  liveCacheRcon.delete(s.id);
  return true;
}

// Mods: broadcast, whisper, kick, kill, move faction. Admins: also ban, unban, restart, end/next, map, time of day.
const ACTIONS = {
  broadcast: { min: 'mod', run: (s, b) => rcon(s, 'POST', '/broadcast', { message: need(str(b.message, 300), 'Type a message.') }) },
  kick: { min: 'mod', run: (s, b) => rcon(s, 'POST', `/players/${steamId(b)}/kick`, { reason: str(b.reason, 200) || 'Kicked by WPG staff' }) },
  kill: { min: 'mod', run: (s, b) => rcon(s, 'POST', `/players/${steamId(b)}/kill`) },
  ban: { min: 'admin', run: (s, b) => rcon(s, 'POST', '/bans', { steamId: steamId(b), reason: str(b.reason, 200) || 'Banned by WPG staff' }) },
  unban: { min: 'admin', run: (s, b) => rcon(s, 'DELETE', `/bans/${steamId(b)}`) },
  whisper: {
    min: 'mod',
    run: (s, b) => rcon(s, 'POST', `/players/${steamId(b)}/message`, { message: need(str(b.message, 300), 'Type a message.') }),
  },
  faction: {
    min: 'mod',
    run: (s, b) => rcon(s, 'PATCH', `/players/${steamId(b)}`, { faction: need(str(b.faction, 40), 'Pick a faction.') }),
  },
  restart: { min: 'admin', run: (s) => rcon(s, 'POST', '/match/restart') },
  end: { min: 'admin', run: (s) => rcon(s, 'POST', '/match/end') },
  // Same server call as "end", but only when the rotation has a next map to go to.
  next: {
    min: 'admin',
    run: async (s) => {
      const st = await rcon(s, 'GET', '/status');
      if (st?.rotation?.nextIndex === null || st?.rotation?.nextIndex === undefined) throw new HttpError(400, 'There is no next map in the rotation.');
      return rcon(s, 'POST', '/match/end');
    },
  },
  queue: { min: 'admin', run: (s, b) => queueMap(s, b) },
  unqueue: {
    min: 'admin',
    run: async (s) => {
      if (!(await restoreRotation(s))) throw new HttpError(400, 'Nothing is queued.');
    },
  },
  lighting: { min: 'admin', run: (s, b) => rcon(s, 'PUT', '/world/lighting', { lighting: need(str(b.lighting, 60), 'Pick a time of day.') }) },
  map: {
    min: 'admin',
    run: (s, b) => {
      // Same body as the official Wardogs RCON console: { map, experiences?, lighting?, alternator? }
      const body = { map: need(str(b.map, 80), 'Pick a map.') };
      const exps = (Array.isArray(b.experiences) ? b.experiences : []).map((e) => str(e, 80)).filter(Boolean).slice(0, 10);
      if (exps.length) body.experiences = exps;
      const lighting = str(b.lighting, 60);
      if (lighting) body.lighting = lighting;
      const alternator = str(b.alternator, 120);
      if (alternator) body.alternator = alternator;
      return rcon(s, 'POST', '/match/map', body);
    },
  },
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
  liveCacheRcon.delete(s.id);
  await audit(req.user.id, `server.${b.action}`, s.name || s.join_code, {
    steamId: b.steamId, reason: b.reason, message: b.message, map: b.map, faction: b.faction, lighting: b.lighting,
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

// ---------- Server leaderboard ----------
const BOARD_SORT = {
  kills: 'kills DESC, playtime_s DESC',
  kd: '(kills::float / GREATEST(deaths, 1)) DESC, kills DESC',
  wins: 'wins DESC, matches DESC',
  matches: 'matches DESC, playtime_s DESC',
  playtime: 'playtime_s DESC',
};
servers.get('/server-leaderboard', member, async (req, res) => {
  const list = await q("SELECT id, name, join_code FROM game_servers WHERE enabled = true AND rcon_url <> '' ORDER BY sort_order, id");
  const server = list.find((s) => s.id === int(req.query.server)) || list[0];
  if (!server) return res.json({ servers: [], rows: [] });
  const by = BOARD_SORT[req.query.by] ? req.query.by : 'kills';
  const rows = await q(
    `SELECT sp.*, u.id AS user_id FROM server_players sp LEFT JOIN users u ON u.steam_id = sp.steam_id AND u.status = 'active'
      WHERE sp.server_id = $1 ORDER BY ${BOARD_SORT[by]}, sp.name LIMIT 200`,
    [server.id],
  );
  const memberIds = rows.map((r) => r.user_id).filter(Boolean);
  const members = memberIds.length ? await usersWithRanks(await q('SELECT * FROM users WHERE id = ANY($1)', [memberIds])) : [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const st = await one('SELECT updated_at FROM server_track_state WHERE server_id=$1', [server.id]);
  res.json({
    servers: list.map((s) => ({ id: s.id, name: s.name || s.join_code })),
    server: server.id,
    by,
    updated: st?.updated_at || null,
    rows: rows.map((r) => ({
      name: r.name,
      kills: r.kills,
      deaths: r.deaths,
      matches: r.matches,
      wins: r.wins,
      losses: r.losses,
      playtime_s: r.playtime_s,
      last_seen: r.last_seen,
      member: r.user_id ? byId.get(r.user_id) || null : null,
    })),
  });
});
