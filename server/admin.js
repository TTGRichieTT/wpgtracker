import express from 'express';
import crypto from 'node:crypto';
import { q, one, audit, getSettings, clearSettingsCache, setting } from './db.js';
import { bus } from './bus.js';
import { syncUser, recalcXp, announceRankChange } from './steam.js';
import { usersWithRanks } from './routes.js';
import { testConnection, DEVELOPER_EXAMPLE_ID } from './ranking.js';
import { giveAutoMedalsToAll, cleanRule } from './medals.js';
import { MEDAL_STATS } from './trackstats.js';
import { botStatus, discordAppId, inviteUrl, postToChannel, setupDiscord, previewCommand, latestProblem, registerCommands, commandAccess, commandList, COMMAND_GROUPS } from './discordbot.js';
import { buildServer, startBuild, buildStatus, syncRoles, lastSync, guildId, loadMap, saveMap, tidyScan, startTidy, lastBackup, botScan, startBotCleanup, lastBotBackup, restoreStaff, staffRoles, fixStaffRoles, dropOwnerRole } from './discordserver.js';
import { refreshPosts, decideHeld, SWITCHES } from './discordmod.js';
import { gatewayStatus, reconnectGateway } from './discordgateway.js';
import { HttpError, role, roleAtLeast, ROLE_LEVEL, str, int, bool, color, safeUrl, isOwner } from './util.js';

export const admin = express.Router();

// ---------- Users (mods + admins) ----------
admin.get('/users', role('mod'), async (req, res) => {
  const status = str(req.query.status, 20);
  const search = str(req.query.search, 60);
  const rows = await q(
    `SELECT * FROM users WHERE ($1 = '' OR status = $1)
       AND ($2 = '' OR persona_name ILIKE '%' || $2 || '%' OR callsign ILIKE '%' || $2 || '%' OR steam_id = $2)
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, joined_at DESC LIMIT 500`,
    [status, search],
  );
  const users = await usersWithRanks(rows);
  res.json(users.map((u, i) => ({ ...u, bonus_xp: rows[i].bonus_xp, rank_locked: rows[i].rank_locked, muted_until: rows[i].muted_until })));
});

admin.get('/users/:id', role('mod'), async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id=$1', [int(req.params.id)]);
  if (!u) throw new HttpError(404, 'Member not found.');
  const [out] = await usersWithRanks([u]);
  const awards = await q(
    'SELECT ua.*, a.name FROM user_awards ua JOIN awards a ON a.id = ua.award_id WHERE ua.user_id=$1 ORDER BY ua.given_at',
    [u.id],
  );
  const stats = await q('SELECT key, value FROM user_stats WHERE user_id=$1', [u.id]);
  res.json({
    user: { ...out, bonus_xp: u.bonus_xp, rank_locked: u.rank_locked, muted_until: u.muted_until },
    awards,
    stats: Object.fromEntries(stats.map((s) => [s.key, Number(s.value)])),
  });
});

admin.patch('/users/:id', role('mod'), async (req, res) => {
  const actor = req.user;
  const target = await one('SELECT * FROM users WHERE id=$1', [int(req.params.id)]);
  if (!target) throw new HttpError(404, 'Member not found.');
  const isAdmin = actor.role === 'admin';
  if (!isAdmin && ROLE_LEVEL[target.role] >= ROLE_LEVEL[actor.role] && target.id !== actor.id) {
    throw new HttpError(403, 'Mods can only edit regular members.');
  }
  const b = req.body || {};
  if (isOwner(target) && (('status' in b && b.status !== 'active') || ('role' in b && b.role !== 'admin'))) {
    throw new HttpError(403, 'This is a main admin. They cannot be demoted or banned.');
  }
  const sets = [];
  const vals = [target.id];
  const set = (col, v) => {
    vals.push(v);
    sets.push(`${col}=$${vals.length}`);
  };

  if ('status' in b) {
    if (!['pending', 'active', 'banned'].includes(b.status)) throw new HttpError(400, 'Bad status.');
    if (target.id === actor.id) throw new HttpError(400, 'You cannot change your own status.');
    set('status', b.status);
  }
  if ('role' in b) {
    if (!isAdmin) throw new HttpError(403, 'Only admins can change roles.');
    if (!ROLE_LEVEL[b.role]) throw new HttpError(400, 'Bad role.');
    if (target.id === actor.id && b.role !== 'admin') {
      const admins = await one("SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND status='active'");
      if (admins.n <= 1) throw new HttpError(400, 'You are the last admin. Make someone else admin first.');
    }
    set('role', b.role);
  }
  if ('membership' in b && !['member', 'pmc'].includes(b.membership)) {
    throw new HttpError(400, 'Membership must be member or pmc.');
  }
  const membership = b.membership || target.membership || 'member';
  let newRank;
  if (membership === 'pmc') {
    // PMCs (guests) never hold a rank.
    delete b.rank_id;
    if (target.rank_id !== null) set('rank_id', null);
  } else if ('rank_id' in b) {
    newRank = b.rank_id ? await one('SELECT * FROM ranks WHERE id=$1', [int(b.rank_id)]) : null;
    if (b.rank_id && !newRank) throw new HttpError(400, 'Rank not found.');
    set('rank_id', newRank ? newRank.id : null);
  } else if (target.membership === 'pmc' && !target.rank_id) {
    // A PMC who becomes a member starts at the lowest rank.
    const lowest = await one('SELECT id FROM ranks ORDER BY sort_order LIMIT 1');
    if (lowest) set('rank_id', lowest.id);
  }
  if ('membership' in b) set('membership', b.membership);
  if ('rank_locked' in b) set('rank_locked', bool(b.rank_locked));
  if ('bonus_xp' in b) set('bonus_xp', int(b.bonus_xp));
  if ('callsign' in b) set('callsign', str(b.callsign, 40));
  if ('bio' in b) set('bio', str(b.bio, 1000));
  if ('country' in b) set('country', str(b.country, 4));
  if ('custom_avatar' in b) set('custom_avatar', safeUrl(b.custom_avatar));
  if ('banner_color' in b) set('banner_color', color(b.banner_color, '#0d2238'));
  if ('custom_fields' in b && typeof b.custom_fields === 'object') {
    const clean = Object.fromEntries(Object.entries(b.custom_fields).map(([k, v]) => [str(k, 40), str(v, 200)]));
    set('custom_fields', JSON.stringify(clean));
  }
  if ('mute_minutes' in b) {
    const mins = int(b.mute_minutes);
    set('muted_until', mins > 0 ? new Date(Date.now() + mins * 60000) : null);
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to change.');

  const updated = await one(`UPDATE users SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
  await audit(actor.id, 'user.edit', `${target.persona_name} (#${target.id})`, b);

  if (b.status === 'active' && target.status !== 'active') {
    bus.emit('notify', target.id, { title: 'Approved!', body: 'Welcome to WPG. You now have full access.' });
    syncUser(target.id).catch(() => {});
  }
  if (b.status === 'banned') bus.emit('user:kick', target.id);
  if ('rank_id' in b && target.rank_id !== updated.rank_id) {
    const from = target.rank_id ? await one('SELECT * FROM ranks WHERE id=$1', [target.rank_id]) : null;
    await announceRankChange(updated, from, newRank);
  }
  if ('bonus_xp' in b || (target.membership === 'pmc' && membership === 'member')) await recalcXp(target.id);
  bus.emit('user:changed', target.id);
  res.json({ ok: true });
});

admin.put('/users/:id/stats', role('mod'), async (req, res) => {
  const target = await one('SELECT * FROM users WHERE id=$1', [int(req.params.id)]);
  if (!target) throw new HttpError(404, 'Member not found.');
  await saveStats(target.id, req.body || {});
  await audit(req.user.id, 'user.stats', `${target.persona_name} (#${target.id})`, req.body);
  await recalcXp(target.id);
  bus.emit('user:changed', target.id);
  res.json({ ok: true });
});

async function saveStats(userId, values) {
  const defs = new Set((await q('SELECT key FROM stat_defs')).map((d) => d.key));
  for (const [key, value] of Object.entries(values)) {
    if (!defs.has(key)) continue;
    if (value === '' || value === null) {
      await q('DELETE FROM user_stats WHERE user_id=$1 AND key=$2', [userId, key]);
      continue;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    await q(
      `INSERT INTO user_stats (user_id, key, value, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (user_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [userId, key, n],
    );
  }
}

admin.post('/users/:id/sync', role('mod'), async (req, res) => {
  res.json(await syncUser(int(req.params.id)));
});

admin.post('/users/:id/awards', role('mod'), async (req, res) => {
  const target = await one('SELECT * FROM users WHERE id=$1', [int(req.params.id)]);
  const award = await one('SELECT * FROM awards WHERE id=$1', [int(req.body?.award_id)]);
  if (!target || !award) throw new HttpError(404, 'Member or award not found.');
  const { isSeasonalRule } = await import('./medals.js');
  const season = isSeasonalRule(award.auto_rule) ? await one("SELECT id FROM seasons WHERE status='active' ORDER BY number DESC LIMIT 1") : null;
  await q('INSERT INTO user_awards (user_id, award_id, given_by, reason, season_id) VALUES ($1,$2,$3,$4,$5)', [
    target.id, award.id, req.user.id, str(req.body?.reason, 300), season?.id || 0,
  ]);
  await audit(req.user.id, 'award.give', `${target.persona_name} (#${target.id})`, { award: award.name });
  bus.emit('notify', target.id, { title: 'Medal awarded!', body: `You received: ${award.name}` });
  bus.emit('announce', { type: 'medals', userId: target.id, names: [award.name] });
  bus.emit('user:changed', target.id);
  res.json({ ok: true });
});

admin.delete('/user-awards/:id', role('mod'), async (req, res) => {
  const ua = await one('DELETE FROM user_awards WHERE id=$1 RETURNING *', [int(req.params.id)]);
  if (ua) {
    await audit(req.user.id, 'award.remove', `user #${ua.user_id}`, { award_id: ua.award_id });
    bus.emit('user:changed', ua.user_id);
  }
  res.json({ ok: true });
});

admin.delete('/users/:id', role('admin'), async (req, res) => {
  const target = await one('SELECT * FROM users WHERE id=$1', [int(req.params.id)]);
  if (!target) throw new HttpError(404, 'Member not found.');
  if (target.id === req.user.id) throw new HttpError(400, 'You cannot delete yourself.');
  if (isOwner(target)) throw new HttpError(403, 'This is a main admin. They cannot be deleted.');
  await q('DELETE FROM users WHERE id=$1', [target.id]);
  await audit(req.user.id, 'user.delete', `${target.persona_name} (${target.steam_id})`);
  bus.emit('user:kick', target.id);
  res.json({ ok: true });
});

// ---------- Generic editors for simple tables ----------
// Each entry describes a table admins can fully edit from the panel without code.
const RESOURCES = {
  ranks: {
    table: 'ranks', key: 'id', min: 'admin', order: 'sort_order, id',
    fields: {
      name: (v) => str(v, 60) || 'New rank',
      abbr: (v) => str(v, 8).toUpperCase() || 'NEW',
      sort_order: (v) => int(v),
      min_xp: (v) => Math.max(0, int(v)),
      auto: bool,
      color: (v) => color(v, '#c9a227'),
      insignia: (v) => JSON.stringify(cleanInsignia(v)),
      description: (v) => str(v, 300),
    },
  },
  awards: {
    table: 'awards', key: 'id', min: 'admin', order: 'sort_order, id',
    fields: {
      name: (v) => str(v, 60) || 'New award',
      description: (v) => str(v, 300),
      colors: (v) => str(v, 200).split(',').map((c) => color(c.trim(), '#888888')).slice(0, 7).join(','),
      sort_order: (v) => int(v),
      auto_rule: (v) => {
        const r = cleanRule(str(v, 80));
        if (r === null) throw new HttpError(400, 'Pick a stat and a target for the automatic rule (or leave it as given by hand).');
        return r;
      },
      // Achievement medals: rarity (empty = an older medal), Achievement Points and category (for Discord posts).
      rarity: (v) => (['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exclusive'].includes(v) ? v : ''),
      points: (v) => Math.max(0, Math.min(100000, int(v))),
      category: (v) => (['streaming', 'nitro', 'loyalty', 'chat', 'voice', 'recruitment', 'events', 'special', 'wardogs', 'other'].includes(v) ? v : ''),
    },
  },
  channels: {
    table: 'channels', key: 'id', min: 'admin', order: 'sort_order, id',
    fields: {
      name: (v) => str(v, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'channel',
      description: (v) => str(v, 200),
      min_role: (v) => (ROLE_LEVEL[v] ? v : 'member'),
      read_only: bool,
      pmc_access: bool,
      sort_order: (v) => int(v),
    },
  },
  games: {
    table: 'games', key: 'app_id', min: 'admin', order: 'featured DESC, name',
    fields: {
      app_id: (v) => int(v),
      name: (v) => str(v, 80) || 'Game',
      enabled: bool,
      featured: bool,
      xp_per_hour: (v) => Math.max(0, int(v)),
      xp_per_achievement: (v) => Math.max(0, int(v)),
      stat_labels: (v) => str(v, 4000),
    },
  },
  'profile-fields': {
    table: 'profile_fields', key: 'id', min: 'admin', order: 'sort_order, id',
    fields: {
      key: (v) => str(v, 40).toLowerCase().replace(/[^a-z0-9_]+/g, '_') || `field_${Date.now()}`,
      label: (v) => str(v, 60) || 'Field',
      type: (v) => (['text', 'select'].includes(v) ? v : 'text'),
      options: (v) => str(v, 1000),
      sort_order: (v) => int(v),
    },
  },
  'stat-defs': {
    table: 'stat_defs', key: 'key', min: 'admin', order: 'sort_order, key', keyEditable: true,
    fields: {
      key: (v) => str(v, 40).toLowerCase().replace(/[^a-z0-9_]+/g, '_') || `stat_${Date.now()}`,
      label: (v) => str(v, 60) || 'Stat',
      format: (v) => (['number', 'minutes', 'money', 'ratio'].includes(v) ? v : 'number'),
      xp_each: (v) => (Number.isFinite(Number(v)) ? Number(v) : 0),
      sort_order: (v) => int(v),
    },
  },
  unlocks: {
    table: 'unlocks', key: 'id', min: 'admin', order: 'role, level, id',
    fields: {
      role: (v) => (['recon', 'assault', 'medic', 'support', 'driver', 'pilot', 'career'].includes(v) ? v : 'assault'),
      level: (v) => Math.max(1, Math.min(500, int(v, 1))),
      name: (v) => str(v, 80) || 'Unlock',
      kind: (v) => str(v, 30),
      cost: (v) => Math.max(0, int(v)),
      vendor_price: (v) => Math.max(0, int(v)),
    },
  },
  artillery: {
    table: 'artillery', key: 'id', min: 'admin', order: 'sort_order, id',
    fields: {
      id: (v) => str(v, 30).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || `gun-${Date.now()}`,
      label: (v) => str(v, 60) || 'Gun',
      note: (v) => str(v, 60),
      min_m: (v) => Math.max(0, int(v)),
      max_m: (v) => Math.max(0, int(v)),
      table_data: (v) => String(v ?? '').split(/\r?\n/).map((l) => l.trim())
        .filter((l) => /^\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(l)).slice(0, 500).join('\n'),
      sort_order: (v) => int(v),
    },
  },
  'game-servers': {
    table: 'game_servers', key: 'id', min: 'admin', order: 'sort_order, id',
    secrets: ['rcon_password'],
    fields: {
      join_code: (v) => str(v, 100) || `server-${Date.now()}`,
      name: (v) => str(v, 80),
      description: (v) => str(v, 300),
      rcon_url: (v) => {
        const s = str(v, 300);
        if (!s) return '';
        try {
          const u = new URL(s);
          if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
          return u.origin + u.pathname.replace(/\/+$/, '');
        } catch {
          throw new HttpError(400, 'RCON address must start with https:// (or http://).');
        }
      },
      rcon_password: (v) => str(v, 300),
      enabled: bool,
      wpg_xp: bool,
      sort_order: (v) => int(v),
    },
  },
  announcements: {
    table: 'announcements', key: 'id', min: 'mod', order: 'pinned DESC, created_at DESC',
    fields: {
      title: (v) => str(v, 120) || 'Announcement',
      body: (v) => str(v, 5000),
      pinned: bool,
    },
    onCreate: (req) => ({ author_id: req.user.id }),
  },
};

const INSIGNIA_NUM = { chevrons: 3, rockers: 3, pips: 3, bars: 2, stars: 5 };
const INSIGNIA_BOOL = ['crown', 'oak', 'wreath', 'swords', 'plate'];
function cleanInsignia(v) {
  const src = typeof v === 'string' ? safeJson(v) : v || {};
  const out = {};
  for (const [k, max] of Object.entries(INSIGNIA_NUM)) {
    const n = Math.min(max, Math.max(0, int(src[k])));
    if (n) out[k] = n;
  }
  for (const k of INSIGNIA_BOOL) if (bool(src[k])) out[k] = true;
  if (['gold', 'silver'].includes(src.metal)) out.metal = src.metal;
  return out;
}
function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// Secret fields (like RCON passwords) are never sent back; the panel only sees whether one is set.
function hideSecrets(r, row) {
  if (!r.secrets || !row) return row;
  const out = { ...row };
  for (const f of r.secrets) {
    out[`has_${f}`] = !!row[f];
    out[f] = '';
  }
  return out;
}

function redact(r, body) {
  if (!r.secrets) return body;
  const out = { ...body };
  for (const f of r.secrets) if (out[f]) out[f] = '(changed)';
  return out;
}

for (const [name, r] of Object.entries(RESOURCES)) {
  admin.get(`/${name}`, role(r.min), async (_req, res) => {
    res.json((await q(`SELECT * FROM ${r.table} ORDER BY ${r.order}`)).map((row) => hideSecrets(r, row)));
  });

  admin.post(`/${name}`, role(r.min), async (req, res) => {
    const data = { ...(r.onCreate?.(req) || {}) };
    for (const [f, clean] of Object.entries(r.fields)) data[f] = clean(req.body?.[f]);
    const cols = Object.keys(data);
    const row = await one(
      `INSERT INTO ${r.table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      Object.values(data),
    ).catch(dbError);
    await audit(req.user.id, `${name}.create`, row[r.key], redact(r, req.body));
    if (name === 'awards') giveAutoMedalsToAll().catch(() => {});
    bus.emit('config:changed', name);
    res.json(hideSecrets(r, row));
  });

  admin.put(`/${name}/:key`, role(r.min), async (req, res) => {
    const b = req.body || {};
    const sets = [];
    const vals = [req.params.key];
    for (const [f, clean] of Object.entries(r.fields)) {
      if (r.secrets?.includes(f) && b[`clear_${f}`]) {
        sets.push(`${f}=''`);
        continue;
      }
      if (!(f in b)) continue;
      if (f === r.key && !r.keyEditable) continue;
      // An empty secret box means "keep the current one".
      if (r.secrets?.includes(f) && !String(b[f] ?? '').trim()) continue;
      vals.push(clean(b[f]));
      sets.push(`${f}=$${vals.length}`);
    }
    if (!sets.length) throw new HttpError(400, 'Nothing to change.');
    const row = await one(`UPDATE ${r.table} SET ${sets.join(', ')} WHERE ${r.key}::text=$1 RETURNING *`, vals).catch(dbError);
    if (!row) throw new HttpError(404, 'Not found.');
    await audit(req.user.id, `${name}.edit`, req.params.key, redact(r, b));
    if (name === 'awards') giveAutoMedalsToAll().catch(() => {});
    bus.emit('config:changed', name);
    res.json(hideSecrets(r, row));
  });

  admin.delete(`/${name}/:key`, role(r.min), async (req, res) => {
    await q(`DELETE FROM ${r.table} WHERE ${r.key}::text=$1`, [req.params.key]);
    await audit(req.user.id, `${name}.delete`, req.params.key);
    bus.emit('config:changed', name);
    res.json({ ok: true });
  });
}

function dbError(e) {
  if (e.code === '23505') throw new HttpError(400, 'That already exists (the key/ID must be unique).');
  throw e;
}

// ---------- Settings (admins) ----------
// The tracked stats an automatic medal can use (Admin → Medals).
admin.get('/tracked-stats', role('admin'), (_req, res) => res.json(MEDAL_STATS));

admin.get('/settings', role('admin'), async (_req, res) => {
  const s = await getSettings();
  res.json(Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('_'))));
});

admin.put('/settings', role('admin'), async (req, res) => {
  const current = await getSettings();
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!(k in current) || k.startsWith('_')) continue;
    const value = k === 'logo_url' ? safeUrl(v) : str(v, 2000);
    await q('UPDATE settings SET value=$2 WHERE key=$1', [k, value]);
  }
  clearSettingsCache();
  await audit(req.user.id, 'settings.edit', '', req.body);
  bus.emit('config:changed', 'settings');
  res.json({ ok: true });
});

// ---------- Discord server: build the layout and keep members' roles in step (admins) ----------
admin.get('/discord-server', role('admin'), async (req, res) => {
  const guild = await guildId();
  res.json({
    guild_id: guild,
    sync_roles: (await setting('discord_sync_roles')) === 'true',
    game_hours: Number(await setting('discord_game_role_hours')) || 100,
    invite_url: `https://discord.com/oauth2/authorize?client_id=${discordAppId()}&scope=bot%20applications.commands&permissions=8${guild ? `&guild_id=${guild}&disable_guild_select=true` : ''}`,
    portal_url: `https://discord.com/developers/applications/${discordAppId()}/bot`,
    build: buildStatus(),
    backup_at: (await lastBackup())?.at || null,
    staff_roles: guild ? await staffRoles() : { owner: '', admin: '', mod: '' },
    me_linked: !!req.user.discord_id,
    me_owner: isOwner(req.user),
    sync: await lastSync(),
    gateway: gatewayStatus(),
    entry: {
      enabled: (await setting('discord_entry_enabled')) === 'true',
      min_age_days: Number(await setting('discord_entry_min_age_days')) || 7,
      kick_hours: Number(await setting('discord_entry_kick_hours')) || 24,
      rules: (await setting('discord_rules')) || '',
      quiz: (await setting('discord_entry_quiz')) || '',
      since: guild ? (await loadMap(guild)).entry_since || null : null,
    },
    mod: {
      timeout_at: Number(await setting('discord_warn_timeout_at')) || 3,
      kick_at: Number(await setting('discord_warn_kick_at')) || 5,
      blocked_words: (await setting('discord_blocked_words')) || '',
    },
    commands: await (async () => { const access = await commandAccess(); return commandList().map((c) => ({ ...c, groups: access[c.name] })); })(),
    command_groups: COMMAND_GROUPS,
    switches: Object.fromEntries(await Promise.all(SWITCHES.map(async (k) => [k, (await setting(k)) !== 'false']))),
    held: guild ? await q("SELECT discord_id, user_name, updated_at FROM discord_entries WHERE guild_id=$1 AND status='held' ORDER BY updated_at", [guild]) : [],
    cases: guild ? await q('SELECT * FROM discord_cases WHERE guild_id=$1 ORDER BY id DESC LIMIT 40', [guild]) : [],
    tickets: guild ? (await one("SELECT COUNT(*)::int AS n FROM discord_tickets WHERE guild_id=$1 AND status='open'", [guild])).n : 0,
  });
});

admin.put('/discord-server', role('admin'), async (req, res) => {
  const b = req.body || {};
  // Each form on the page sends only its own part; anything not sent is left as it is.
  const values = {};
  if ('guild_id' in b) {
    const g = str(b.guild_id, 30).trim();
    if (g && !/^\d{15,22}$/.test(g)) throw new HttpError(400, 'That isn\'t a Discord server ID (it\'s a long number).');
    values.discord_build_server_id = g;
  }
  if ('sync_roles' in b) values.discord_sync_roles = bool(b.sync_roles) ? 'true' : 'false';
  if ('game_hours' in b) values.discord_game_role_hours = String(Math.min(10000, Math.max(10, int(b.game_hours) || 100)));
  // Entry check and moderation settings (sent by the page's other forms; left alone when not sent).
  const e = b.entry;
  if (e && typeof e === 'object') {
    values.discord_entry_enabled = bool(e.enabled) ? 'true' : 'false';
    values.discord_entry_min_age_days = String(Math.min(365, Math.max(0, int(e.min_age_days))));
    values.discord_entry_kick_hours = String(Math.min(720, Math.max(1, int(e.kick_hours) || 24)));
    values.discord_rules = str(e.rules, 3900);
    // One "question | answer, answer" per line; questions are cut to 45 characters (Discord's limit).
    values.discord_entry_quiz = String(e.quiz || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes('|'))
      .map((l) => { const [qq, ...a] = l.split('|'); return `${qq.trim().slice(0, 45)} | ${a.join('|').trim()}`; }).slice(0, 30).join('\n');
  }
  const m = b.mod;
  if (b.switches && typeof b.switches === 'object') {
    for (const k of SWITCHES) if (k in b.switches) values[k] = bool(b.switches[k]) ? 'true' : 'false';
  }
  if (m && typeof m === 'object') {
    values.discord_warn_timeout_at = String(Math.min(50, Math.max(1, int(m.timeout_at) || 3)));
    values.discord_warn_kick_at = String(Math.min(50, Math.max(1, int(m.kick_at) || 5)));
    values.discord_blocked_words = str(m.blocked_words, 8000);
  }
  for (const [k, v] of Object.entries(values)) {
    await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
  }
  clearSettingsCache();
  // Entry check switched on for a server whose rules post is up: newcomers from now on must pass it.
  const guild = await guildId();
  const gmap = guild ? await loadMap(guild) : null;
  if (values.discord_entry_enabled === 'true' && gmap?.messages?.rules && !gmap.entry_since) {
    await saveMap({ ...gmap, entry_since: new Date().toISOString() });
    clearSettingsCache();
  }
  await audit(req.user.id, 'discord.server.settings', guild, { ...values, discord_rules: undefined });
  res.json({ ok: true });
});

// Who can use each bot command. Saved, then Discord's command list is updated straight away.
admin.put('/discord-server/commands', role('admin'), async (req, res) => {
  const groups = COMMAND_GROUPS.map(([k]) => k);
  const known = new Set(commandList().map((c) => c.name));
  const out = {};
  for (const [name, picked] of Object.entries(req.body?.commands || {})) {
    if (!known.has(name) || !Array.isArray(picked)) continue;
    const list = groups.filter((g) => picked.includes(g));
    // /link and /unlink must stay open to everyone (or off), or nobody new could ever link their Discord.
    out[name] = ['link', 'unlink'].includes(name) ? (list.length ? ['everyone'] : []) : list;
  }
  await q("INSERT INTO settings (key, value) VALUES ('discord_command_access', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(out)]);
  clearSettingsCache();
  await audit(req.user.id, 'discord.commands', '', out);
  const r = await registerCommands().catch((e) => ({ ok: false, reason: e.message }));
  res.json({ ok: true, discord: r });
});

// Discord control → Rooms and Bot posts (discordrooms.js).
admin.get('/discord-rooms', role('admin'), async (_req, res) => {
  const { roomsOverview } = await import('./discordrooms.js');
  res.json(await roomsOverview());
});
admin.post('/discord-rooms/sync', role('admin'), async (_req, res) => {
  const { syncRooms } = await import('./discordrooms.js');
  res.json(await syncRooms().catch((e) => ({ ok: false, reason: e.message })));
});
admin.put('/discord-rooms/:id', role('admin'), async (req, res) => {
  const { setRoom } = await import('./discordrooms.js');
  const b = req.body || {};
  const r = await setRoom(String(req.params.id), {
    view_only: b.view_only === undefined ? undefined : !!b.view_only,
    clear_minutes: b.clear_minutes === undefined ? undefined : int(b.clear_minutes),
    show_in_app: b.show_in_app === undefined ? undefined : !!b.show_in_app,
  }).catch((e) => { throw new HttpError(400, e.message); });
  await audit(req.user.id, 'discord.room', String(req.params.id), b);
  res.json(r);
});
admin.post('/discord-posts/preview', role('admin'), async (req, res) => {
  const { previewPost } = await import('./discordrooms.js');
  const p = await previewPost(req.body || {}).catch((e) => { throw new HttpError(400, e.message); });
  const file = p.files?.[0];
  res.json({ text: p.content || '', embeds: p.embeds || [], banner: file ? `data:image/jpeg;base64,${Buffer.from(file.data).toString('base64')}` : '' });
});
admin.post('/discord-posts', role('admin'), async (req, res) => {
  const { savePost } = await import('./discordrooms.js');
  const r = await savePost(0, req.body || {}, req.user.id).catch((e) => { throw new HttpError(400, e.message); });
  await audit(req.user.id, 'discord.post', String(r.id), { channel: req.body?.channel_id, kind: req.body?.kind });
  res.json(r);
});
admin.put('/discord-posts/:id', role('admin'), async (req, res) => {
  const { savePost } = await import('./discordrooms.js');
  const r = await savePost(int(req.params.id), req.body || {}, req.user.id).catch((e) => { throw new HttpError(400, e.message); });
  await audit(req.user.id, 'discord.post', String(req.params.id), { channel: req.body?.channel_id, kind: req.body?.kind });
  res.json(r);
});
admin.post('/discord-posts/:id/repost', role('admin'), async (req, res) => {
  const { publishPost } = await import('./discordrooms.js');
  res.json(await publishPost(int(req.params.id), { force: true }).catch((e) => { throw new HttpError(400, e.message); }));
});
admin.delete('/discord-posts/:id', role('admin'), async (req, res) => {
  const { deletePost } = await import('./discordrooms.js');
  await deletePost(int(req.params.id));
  await audit(req.user.id, 'discord.post.delete', req.params.id);
  res.json({ ok: true });
});

// Tidy up an existing server: scan (nothing changes), then apply the chosen removals with a backup first.
admin.post('/discord-server/tidy/scan', role('admin'), async (req, res) => {
  try {
    res.json(await tidyScan({ countFrom: str(req.body?.count_from, 30).trim() }));
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});
admin.post('/discord-server/tidy', role('admin'), async (req, res) => {
  const remove = Array.isArray(req.body?.remove) ? req.body.remove.map((x) => String(x)).filter((x) => /^\d{15,22}$/.test(x)) : [];
  try {
    startTidy({ remove, countFrom: str(req.body?.count_from, 30).trim() });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  await audit(req.user.id, 'discord.server.tidy', await guildId(), { remove });
  res.json({ ok: true });
});
admin.get('/discord-server/backup', role('admin'), async (_req, res) => {
  const b = await lastBackup();
  if (!b) throw new HttpError(404, 'No backup yet: one is made each time Tidy up runs.');
  res.setHeader('Content-Disposition', `attachment; filename="discord-backup-${b.guild}-${String(b.at).slice(0, 10)}.json"`);
  res.json(b);
});

// Other bots: scan (nothing changes), then kick the ticked ones and take roles / permissions off the rest.
admin.post('/discord-server/bots/scan', role('admin'), async (_req, res) => {
  try {
    res.json(await botScan());
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});
admin.post('/discord-server/bots', role('admin'), async (req, res) => {
  const kick = Array.isArray(req.body?.kick) ? req.body.kick.map((x) => String(x)).filter((x) => /^\d{15,22}$/.test(x)) : [];
  const opts = { kick, strip: bool(req.body?.strip), undo: bool(req.body?.undo), order: bool(req.body?.order), relayout: bool(req.body?.relayout) };
  try {
    startBotCleanup(opts);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  await audit(req.user.id, 'discord.server.bots', await guildId(), opts);
  res.json({ ok: true });
});
admin.get('/discord-server/bots/backup', role('admin'), async (_req, res) => {
  const b = await lastBotBackup();
  if (!b) throw new HttpError(404, 'No backup yet: one is made each time the bot clean-up runs.');
  res.setHeader('Content-Disposition', `attachment; filename="discord-bots-backup-${b.guild}-${String(b.at).slice(0, 10)}.json"`);
  res.json(b);
});

admin.post('/discord-server/posts', role('admin'), async (_req, res) => {
  try {
    res.json({ ok: true, log: await refreshPosts() });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});

admin.post('/discord-server/reconnect', role('admin'), async (_req, res) => {
  reconnectGateway();
  res.json({ ok: true });
});

admin.post('/discord-server/held/:id', role('mod'), async (req, res) => {
  try {
    await decideHeld(String(req.params.id), req.body?.action === 'letin', req.user.persona_name);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  res.json({ ok: true });
});

admin.post('/discord-server/preview', role('admin'), async (req, res) => {
  try {
    res.json(await buildServer({ apply: false, usePosts: bool(req.body?.use_posts) }));
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});

admin.post('/discord-server/build', role('admin'), async (req, res) => {
  try {
    startBuild({ usePosts: bool(req.body?.use_posts) });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  await audit(req.user.id, 'discord.server.build', await guildId(), { use_posts: bool(req.body?.use_posts) });
  res.json({ ok: true });
});

// Staff roles: the server's Owner / Admin / Moderator by ID; fixes their permissions and order (and gives the
// main admin who asks Administrator on their linked Discord).
admin.post('/discord-server/staff-roles', role('admin'), async (req, res) => {
  const id = (k) => str(req.body?.[k], 30).trim();
  const giveMe = bool(req.body?.give_me) && isOwner(req.user) ? String(req.user.discord_id || '') : '';
  try {
    const r = await fixStaffRoles({ owner: id('owner'), admin: id('admin'), mod: id('mod'), giveTo: giveMe });
    await audit(req.user.id, 'discord.server.staff_roles', await guildId(), { owner: id('owner'), admin: id('admin'), mod: id('mod'), give_me: !!giveMe });
    res.json(r);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});

// Takes the Owner role off the admin asking (on their linked Discord).
admin.post('/discord-server/staff-roles/drop-owner', role('admin'), async (req, res) => {
  if (!req.user.discord_id) throw new HttpError(400, 'Link your Discord first: type /link in Discord.');
  try {
    const r = await dropOwnerRole(String(req.user.discord_id));
    await audit(req.user.id, 'discord.server.drop_owner', await guildId(), {});
    res.json(r);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});

// Old staff back: list (apply false) or give back the staff roles people had at the last Tidy up backup.
admin.post('/discord-server/restore-staff', role('admin'), async (req, res) => {
  try {
    const r = await restoreStaff({ apply: bool(req.body?.apply) });
    if (bool(req.body?.apply)) await audit(req.user.id, 'discord.server.restore_staff', await guildId(), { people: r.people.length });
    res.json(r);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});

admin.post('/discord-server/sync', role('admin'), async (_req, res) => {
  res.json(await syncRoles());
});

// ---------- Barracks Discord bot (admins) ----------
admin.get('/discord-bot', role('admin'), async (_req, res) => {
  res.json({
    ...(await botStatus()),
    app_id: discordAppId(),
    interactions_url: `${(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://wpg-barracks.onrender.com').replace(/\/$/, '')}/discord/interactions`,
    invite_url: inviteUrl(),
    post_channel: !!String((await setting('discord_post_channel')) || '').trim(),
  });
});
admin.post('/discord-bot/test', role('admin'), async (req, res) => {
  const r = await postToChannel({ embeds: [{ color: 0x29b6f6, title: '✅ WPG Barracks bot', description: `Test post from the Barracks app, sent by ${req.user.persona_name}. Promotions, medals and WPG rank-ups will appear here.` }] });
  if (!r.ok) throw new HttpError(400, r.reason);
  res.json({ ok: true });
});
// Points Discord at the app and sets the commands up again (the app also does this by itself).
admin.post('/discord-bot/register', role('admin'), async (_req, res) => {
  const r = await setupDiscord();
  if (!r.ok) throw new HttpError(400, r.reason || [r.endpoint?.reason && `Address: ${r.endpoint.reason}`, r.commands?.reason && `Commands: ${r.commands.reason}`].filter(Boolean).join(' · '));
  res.json({ ok: true, count: r.commands.count, endpoint_changed: r.endpoint.changed });
});
// Makes a command's card here on the server, exactly as the bot would, and sends the picture back.
admin.post('/discord-bot/preview', role('admin'), async (req, res) => {
  const command = str(req.body?.command, 30);
  let reply;
  try {
    reply = await previewCommand(command, req.user);
  } catch (e) {
    // Admins see the real reason, so a screenshot is enough to fix it.
    return res.json({ text: 'The command crashed.', problem: { where: `/${command}`, message: e.message } });
  }
  const file = reply.files?.[0];
  if (file) return res.type('image/jpeg').send(file.data);
  res.json({ text: reply.content || reply.embeds?.[0]?.title || 'The bot sent a text reply.', problem: latestProblem(15) });
});

// Syncs every member (Steam, Wardogs stats, medals) and tells the admin how it went when finished.
let syncAllRunning = false;
admin.post('/sync-all', role('admin'), async (req, res) => {
  if (syncAllRunning) throw new HttpError(409, 'A full sync is already running — you\'ll get a message when it finishes.');
  const users = await q("SELECT id, persona_name FROM users WHERE status='active' AND steam_id ~ '^[0-9]{17}$'");
  res.json({ ok: true, queued: users.length });
  syncAllRunning = true;
  const tally = { done: 0, failed: 0, tracker: 0, missing: [] };
  try {
    for (const u of users) {
      const r = await syncUser(u.id).catch(() => null);
      if (!r) tally.failed++;
      else {
        tally.done++;
        if (r.wardogs?.ok) tally.tracker++;
        else if (['missing', 'unsynced'].includes(r.wardogs?.state)) tally.missing.push(u.persona_name);
        else tally.failed++;
      }
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  } finally {
    syncAllRunning = false;
  }
  bus.emit('notify', req.user.id, {
    title: 'Full sync finished',
    body: `${tally.done} members synced · ${tally.tracker} with global stats from the wardogs.tools API${tally.failed ? ` · ${tally.failed} failed` : ''}.${tally.missing.length
      ? ` No stats were returned for these accounts: ${tally.missing.slice(0, 12).join(', ')}${tally.missing.length > 12 ? ` and ${tally.missing.length - 12} more` : ''}.` : ''}`,
  });
  await audit(req.user.id, 'sync.all', '', { synced: tally.done, tracker: tally.tracker, missing: tally.missing.length, failed: tally.failed });
});

// wardogs.tools connection test: the developer's example player (always exists) and my own Steam account.
admin.post('/wardogs-test', role('admin'), async (req, res) => {
  const ids = [DEVELOPER_EXAMPLE_ID, ...(/^\d{17}$/.test(req.user.steam_id) ? [req.user.steam_id] : [])];
  res.json({ version: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7), ...(await testConnection(ids)) });
});

admin.get('/audit', role('mod'), async (_req, res) => {
  res.json(
    await q(
      `SELECT a.*, u.persona_name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.id DESC LIMIT 200`,
    ),
  );
});

// ---------- Stats push API (for a Discord bot or game server) ----------
// POST /api/ingest/stats   header: Authorization: Bearer <INGEST_KEY>
// body: { "steam_id": "7656...", "stats": { "matches": 12, "wins": 7 } }
//   or: { "players": [ { "steam_id": "...", "stats": {...} }, ... ] }
export const ingest = express.Router();
ingest.post('/stats', async (req, res) => {
  const key = process.env.INGEST_KEY || '';
  const given = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ok = key.length >= 16 && given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
  if (!ok) throw new HttpError(401, 'Bad or missing INGEST_KEY.');
  const players = Array.isArray(req.body?.players) ? req.body.players : [req.body || {}];
  let updated = 0;
  for (const p of players.slice(0, 500)) {
    const user = await one('SELECT id FROM users WHERE steam_id=$1', [String(p.steam_id || '')]);
    if (!user || typeof p.stats !== 'object') continue;
    await saveStats(user.id, p.stats);
    await recalcXp(user.id);
    bus.emit('user:changed', user.id);
    updated++;
  }
  res.json({ ok: true, updated });
});

export { roleAtLeast };
