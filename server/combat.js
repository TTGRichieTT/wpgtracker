// Combat Command: recruitment applications, the WPG units with their roles and slots, who is posted where,
// each member's specialties, and the doctrine.
//  - Members (not PMC guests) apply straight away. PMCs ask first; staff allow them, then they can apply.
//  - Mods and admins review applications and post people into units. Admins edit the units themselves.
//  - The Combat Command board and the doctrine are for WPG members and staff only (never PMCs).
import express from 'express';
import { q, one, audit, setting } from './db.js';
import { bus } from './bus.js';
import { HttpError, member, role, roleAtLeast, str, int, bool, color } from './util.js';
import { usersWithRanks } from './routes.js';
import { playingNow } from './playing.js';
import { recalcXp } from './steam.js';

export const combat = express.Router();

const isStaff = (u) => roleAtLeast(u?.role, 'mod');
const isPmc = (u) => u?.membership === 'pmc';
// WPG members (and staff) only: PMC guests can't see the board or doctrine.
export const isWpg = (u) => !!u && u.status === 'active' && (!isPmc(u) || isStaff(u));
function wpgOnly(req, _res, next) {
  if (!isWpg(req.user)) throw new HttpError(403, 'Combat Command is for WPG members only.');
  next();
}

export async function specialties() {
  return String((await setting('combat_specialties')) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 60);
}

// ---------- Board ----------
const ONLINE_MS = 2 * 60 * 1000;
async function onServerSteamIds() {
  const rows = await q('SELECT state FROM server_track_state');
  const ids = new Set();
  for (const r of rows) {
    for (const [sid, p] of Object.entries(r.state?.players || {})) if (Date.now() - (p.seen || 0) < ONLINE_MS) ids.add(sid);
  }
  return ids;
}

export async function boardData() {
  const [units, posts, profiles] = await Promise.all([
    q('SELECT * FROM combat_units ORDER BY sort_order, id'),
    q(`SELECT cp.unit_id, cp.role_id, cp.assigned_at, u.* FROM combat_postings cp JOIN users u ON u.id = cp.user_id
        WHERE u.status = 'active' ORDER BY cp.assigned_at`),
    q('SELECT * FROM combat_profiles'),
  ]);
  const people = await usersWithRanks(posts);
  const prof = new Map(profiles.map((p) => [p.user_id, p]));
  const playing = playingNow();
  const onServer = await onServerSteamIds();
  const person = (p, row) => ({
    ...p,
    assigned_at: row.assigned_at,
    combat: prof.get(p.id) || null,
    in_game: playing[p.id]?.game || '',
    on_server: onServer.has(row.steam_id),
  });
  const byUnit = new Map();
  posts.forEach((row, i) => {
    if (!byUnit.has(row.unit_id)) byUnit.set(row.unit_id, []);
    byUnit.get(row.unit_id).push({ row, p: person(people[i], row) });
  });
  const out = units.map((u) => {
    const mine = byUnit.get(u.id) || [];
    const roles = (Array.isArray(u.roles) ? u.roles : []).map((r) => {
      const members = mine.filter((m) => m.row.role_id === r.id).map((m) => m.p);
      return { ...r, slots: Math.max(1, int(r.slots, 1)), members, open: Math.max(0, Math.max(1, int(r.slots, 1)) - members.length) };
    });
    const known = new Set(roles.map((r) => r.id));
    const unplaced = mine.filter((m) => !known.has(m.row.role_id)).map((m) => m.p);
    const size = roles.reduce((n, r) => n + r.slots, 0);
    const filled = roles.reduce((n, r) => n + Math.min(r.slots, r.members.length), 0);
    return {
      id: u.id, name: u.name, kind: u.kind, label: u.label, mission: u.mission, color: u.color, sort_order: u.sort_order,
      roles, unplaced, size, filled, open: size - filled,
      in_game: [...roles.flatMap((r) => r.members), ...unplaced].filter((m) => m.in_game || m.on_server).length,
    };
  });
  // Line of succession: the command unit's roles in order, then the other units' leaders, most senior rank first.
  const chain = [];
  const command = out.find((u) => u.kind === 'command');
  for (const r of command?.roles || []) {
    if (r.members.length) r.members.forEach((m) => chain.push({ title: r.name, user: m }));
    else chain.push({ title: r.name, user: null });
  }
  const leaders = out.filter((u) => u.kind !== 'command').flatMap((u) => u.roles.filter((r) => r.leader).flatMap((r) => r.members.map((m) => ({ title: `${u.name} — ${r.name}`, user: m }))));
  leaders.sort((a, b) => (b.user.rank?.sort_order ?? -1) - (a.user.rank?.sort_order ?? -1) || new Date(a.user.assigned_at) - new Date(b.user.assigned_at));
  chain.push(...leaders);
  return { units: out, chain };
}

combat.get('/combat/board', member, wpgOnly, async (req, res) => {
  res.json({ ...(await boardData()), can_edit: roleAtLeast(req.user.role, 'admin'), can_assign: isStaff(req.user) });
});

// ---------- Doctrine ----------
combat.get('/combat/doctrine', member, wpgOnly, async (req, res) => {
  res.json({ text: (await setting('_combat_doctrine')) || '', can_edit: roleAtLeast(req.user.role, 'admin') });
});
combat.put('/combat/doctrine', role('admin'), async (req, res) => {
  const text = String(req.body?.text ?? '').slice(0, 20000);
  await q("INSERT INTO settings (key, value) VALUES ('_combat_doctrine', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [text]);
  await audit(req.user.id, 'combat.doctrine', '', { length: text.length });
  res.json({ ok: true });
});

// ---------- My recruitment status ----------
async function myStatus(user) {
  const [app, request, posting, profile, list] = await Promise.all([
    one('SELECT * FROM recruit_applications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [user.id]),
    one('SELECT * FROM apply_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [user.id]),
    one(`SELECT cp.*, cu.name AS unit_name, cu.roles FROM combat_postings cp JOIN combat_units cu ON cu.id = cp.unit_id WHERE cp.user_id=$1`, [user.id]),
    one('SELECT * FROM combat_profiles WHERE user_id=$1', [user.id]),
    specialties(),
  ]);
  const pmc = isPmc(user) && !isStaff(user);
  const allowed = !pmc || request?.status === 'allowed';
  return {
    pmc,
    can_apply: allowed && app?.status !== 'new',
    application: app,
    request: pmc ? request : null,
    posting: posting ? { unit: posting.unit_name, role: (posting.roles || []).find((r) => r.id === posting.role_id)?.name || '' } : null,
    profile,
    specialties: list,
  };
}
combat.get('/combat/me', member, async (req, res) => {
  res.json(await myStatus(req.user));
});

// Tells staff (app + Discord) about something waiting in Recruitment.
function tellStaff(title, body) {
  bus.emit('staff:notify', { title, body, link: '#/admin/recruitment' });
  bus.emit('recruit', { type: 'staff', title, body });
}

// PMC: ask permission to apply.
combat.post('/combat/apply-request', member, async (req, res) => {
  if (!isPmc(req.user) || isStaff(req.user)) throw new HttpError(400, 'WPG members can apply straight away.');
  const last = await one('SELECT * FROM apply_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.user.id]);
  if (last?.status === 'pending') throw new HttpError(400, 'Your request is already with staff.');
  if (last?.status === 'allowed') throw new HttpError(400, 'You have been allowed to apply — fill in the form.');
  if (last?.status === 'declined' && Date.now() - new Date(last.reviewed_at || last.created_at).getTime() < 7 * 24 * 3600 * 1000) {
    throw new HttpError(400, 'Your last request was declined. You can ask again a week after that.');
  }
  await q('INSERT INTO apply_requests (user_id, message) VALUES ($1,$2)', [req.user.id, str(req.body?.message, 500)]);
  tellStaff('PMC asking to apply', `${req.user.persona_name} wants to apply to a WPG unit.`);
  res.json(await myStatus(req.user));
});

const pickRole = (list, v) => {
  const s = str(v, 80);
  return list.find((x) => x.toLowerCase() === s.toLowerCase()) || '';
};

combat.post('/combat/applications', member, async (req, res) => {
  const status = await myStatus(req.user);
  if (status.pmc && status.request?.status !== 'allowed') throw new HttpError(403, 'PMCs need staff to allow them before applying. Use "Ask to apply".');
  if (status.application?.status === 'new') throw new HttpError(400, 'You already have an application waiting. Withdraw it first to change it.');
  const b = req.body || {};
  const list = status.specialties;
  const primary = pickRole(list, b.primary_role);
  if (!primary) throw new HttpError(400, 'Pick your primary role.');
  const secondary = pickRole(list, b.secondary_role);
  if (!secondary) throw new HttpError(400, 'Pick your secondary (backup) role.');
  if (secondary === primary) throw new HttpError(400, 'Your secondary role should be different from your primary role.');
  const skills = [...new Set((Array.isArray(b.skills) ? b.skills : []).map((s) => pickRole(list, s)).filter((s) => s && s !== primary && s !== secondary))];
  const app = await one(
    `INSERT INTO recruit_applications (user_id, primary_role, secondary_role, skills, leadership, pilot, availability, region, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.user.id, primary, secondary, JSON.stringify(skills), bool(b.leadership), bool(b.pilot), str(b.availability, 200), str(b.region, 60), str(b.notes, 1000)],
  );
  if (status.pmc) await q("UPDATE apply_requests SET status='used' WHERE id=$1", [status.request.id]);
  tellStaff('New WPG application', `${req.user.persona_name}: ${primary} (backup ${secondary})${bool(b.leadership) ? ' · leadership' : ''}${bool(b.pilot) ? ' · pilot' : ''}`);
  await audit(req.user.id, 'recruit.apply', `#${app.id}`, { primary, secondary });
  res.json(await myStatus(req.user));
});

combat.post('/combat/applications/withdraw', member, async (req, res) => {
  await q("UPDATE recruit_applications SET status='withdrawn' WHERE user_id=$1 AND status='new'", [req.user.id]);
  res.json(await myStatus(req.user));
});

// ---------- Staff: recruitment ----------
// What staff see next to an application: the applicant's real numbers.
async function statsFor(userIds) {
  if (!userIds.length) return new Map();
  const [ws, games, server, prog, users] = await Promise.all([
    q('SELECT user_id, official FROM wardogs_stats WHERE user_id = ANY($1)', [userIds]),
    q(`SELECT ug.user_id, SUM(ug.playtime_forever)::int mins FROM user_games ug JOIN games g ON g.app_id = ug.app_id AND g.enabled
        WHERE ug.user_id = ANY($1) GROUP BY ug.user_id`, [userIds]),
    q(`SELECT u.id AS user_id, SUM(sp.kills)::int kills, SUM(sp.deaths)::int deaths, SUM(sp.matches)::int matches, SUM(sp.playtime_s)::int playtime
         FROM users u JOIN server_players sp ON sp.steam_id = u.steam_id WHERE u.id = ANY($1) GROUP BY u.id`, [userIds]),
    q('SELECT u.id AS user_id, p.xp, p.rank_name FROM users u JOIN server_progress p ON p.steam_id = u.steam_id WHERE u.id = ANY($1)', [userIds]),
    q('SELECT id, custom_fields FROM users WHERE id = ANY($1)', [userIds]),
  ]);
  const m = new Map(userIds.map((id) => [id, {}]));
  ws.forEach((r) => {
    const o = r.official || {};
    m.get(r.user_id).wardogs = { level: o.wardogLevel ?? null, roles: Object.fromEntries(Object.entries(o.roles || {}).map(([k, v]) => [k, Number(v?.level ?? v) || 0])) };
  });
  games.forEach((r) => { m.get(r.user_id).hours = Math.round(r.mins / 60); });
  server.forEach((r) => { m.get(r.user_id).server = r; });
  prog.forEach((r) => { m.get(r.user_id).wpg = { xp: r.xp, rank: r.rank_name }; });
  users.forEach((r) => { m.get(r.id).discord = r.custom_fields?.discord || ''; });
  return m;
}

// Units for the "post them to…" picker: every role with how many places are free.
async function unitChoices() {
  const b = await boardData();
  return b.units.map((u) => ({ id: u.id, name: u.name, label: u.label, roles: u.roles.map((r) => ({ id: r.id, name: r.name, open: r.open, slots: r.slots })) }));
}

combat.get('/admin/recruitment', role('mod'), async (_req, res) => {
  const [apps, requests] = await Promise.all([
    q(`SELECT a.*, r.persona_name AS reviewer FROM recruit_applications a LEFT JOIN users r ON r.id = a.reviewed_by
        ORDER BY (a.status = 'new') DESC, a.created_at DESC LIMIT 100`),
    q(`SELECT ar.*, r.persona_name AS reviewer FROM apply_requests ar LEFT JOIN users r ON r.id = ar.reviewed_by
        ORDER BY (ar.status = 'pending') DESC, ar.created_at DESC LIMIT 50`),
  ]);
  const ids = [...new Set([...apps.map((a) => a.user_id), ...requests.map((r) => r.user_id)])];
  const users = ids.length ? await usersWithRanks(await q('SELECT * FROM users WHERE id = ANY($1)', [ids])) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const stats = await statsFor(ids);
  const units = await q('SELECT id, name, roles FROM combat_units');
  const unitName = (id, roleId) => {
    const u = units.find((x) => x.id === id);
    return u ? `${u.name}${roleId ? ` — ${(u.roles || []).find((r) => r.id === roleId)?.name || ''}` : ''}` : '';
  };
  res.json({
    applications: apps.map((a) => ({ ...a, user: byId.get(a.user_id) || null, stats: stats.get(a.user_id) || {}, posted_to: a.unit_id ? unitName(a.unit_id, a.role_id) : '' })),
    requests: requests.map((r) => ({ ...r, user: byId.get(r.user_id) || null, stats: stats.get(r.user_id) || {} })),
    units: await unitChoices(),
    specialties: await specialties(),
  });
});

combat.post('/admin/recruitment/requests/:id/:decision', role('mod'), async (req, res) => {
  const decision = { allow: 'allowed', decline: 'declined' }[req.params.decision];
  if (!decision) throw new HttpError(404, 'Not found');
  const r = await one(
    "UPDATE apply_requests SET status=$2, reviewed_by=$3, reviewed_at=now(), note=$4 WHERE id=$1 AND status='pending' RETURNING *",
    [int(req.params.id), decision, req.user.id, str(req.body?.note, 300)],
  );
  if (!r) throw new HttpError(404, 'That request was already dealt with.');
  const ok = decision === 'allowed';
  tellMember(r.user_id, ok ? 'You can apply to WPG' : 'Request to apply declined',
    ok ? 'Staff have allowed you to apply. Open Recruitment and fill in the form.' : (r.note || 'Staff declined your request to apply for now.'));
  await audit(req.user.id, `recruit.request.${decision}`, `#${r.id}`);
  res.json({ ok: true });
});

function tellMember(userId, title, body) {
  bus.emit('notify', userId, { title, body, link: '#/recruitment' });
  bus.emit('recruit', { type: 'member', userId, title, body });
}

// Puts a member into a unit role (or moves them). Checks the role exists; doesn't block over-filling, but says so.
async function postMember(userId, unitId, roleId, byId) {
  const unit = await one('SELECT * FROM combat_units WHERE id=$1', [int(unitId)]);
  if (!unit) throw new HttpError(400, 'Pick a unit.');
  const r = (unit.roles || []).find((x) => x.id === roleId);
  if (!r) throw new HttpError(400, 'Pick a role in that unit.');
  await q(
    `INSERT INTO combat_postings (user_id, unit_id, role_id, assigned_by, assigned_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (user_id) DO UPDATE SET unit_id=EXCLUDED.unit_id, role_id=EXCLUDED.role_id, assigned_by=EXCLUDED.assigned_by, assigned_at=now()`,
    [userId, unit.id, r.id, byId],
  );
  bus.emit('combat:changed');
  return { unit, role: r };
}

combat.post('/admin/recruitment/applications/:id/accept', role('mod'), async (req, res) => {
  const a = await one("SELECT * FROM recruit_applications WHERE id=$1 AND status='new'", [int(req.params.id)]);
  if (!a) throw new HttpError(404, 'That application was already dealt with.');
  const user = await one('SELECT * FROM users WHERE id=$1', [a.user_id]);
  if (!user || user.status !== 'active') throw new HttpError(400, 'That member is no longer active.');
  const b = req.body || {};
  // Placing them in a unit is optional (they can be accepted onto the roster first and posted later).
  let posted = null;
  if (b.unit_id) posted = await postMember(user.id, b.unit_id, str(b.role_id, 40), req.user.id);
  await q(
    `INSERT INTO combat_profiles (user_id, primary_role, secondary_role, qualifications, leadership, pilot, availability, region, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (user_id) DO UPDATE SET primary_role=EXCLUDED.primary_role, secondary_role=EXCLUDED.secondary_role,
       qualifications=EXCLUDED.qualifications, leadership=EXCLUDED.leadership, pilot=EXCLUDED.pilot,
       availability=EXCLUDED.availability, region=EXCLUDED.region, updated_at=now()`,
    [user.id, a.primary_role, a.secondary_role, JSON.stringify(a.skills || []), a.leadership, a.pilot, a.availability, a.region],
  );
  await q(
    "UPDATE recruit_applications SET status='accepted', reviewed_by=$2, reviewed_at=now(), decision_note=$3, unit_id=$4, role_id=$5 WHERE id=$1",
    [a.id, req.user.id, str(b.note, 500), posted?.unit.id || null, posted?.role.id || ''],
  );
  // A PMC who is accepted joins WPG as a member (starting at the lowest rank), unless staff untick it.
  let joined = false;
  if (isPmc(user) && b.make_member !== false) {
    const lowest = await one('SELECT id FROM ranks ORDER BY sort_order LIMIT 1');
    await q("UPDATE users SET membership='member', rank_id=COALESCE(rank_id, $2) WHERE id=$1", [user.id, lowest?.id || null]);
    await recalcXp(user.id).catch(() => {});
    bus.emit('user:changed', user.id);
    joined = true;
  }
  tellMember(user.id, 'Application accepted!', `${posted ? `You're posted to ${posted.unit.name} as ${posted.role.name}.` : 'Welcome to the WPG force.'}${joined ? ' You are now a WPG member.' : ''}${b.note ? ` ${str(b.note, 300)}` : ''}`);
  await audit(req.user.id, 'recruit.accept', `${user.persona_name} (#${user.id})`, { unit: posted?.unit.name, role: posted?.role.name, joined });
  res.json({ ok: true });
});

combat.post('/admin/recruitment/applications/:id/decline', role('mod'), async (req, res) => {
  const note = str(req.body?.note, 500);
  const a = await one(
    "UPDATE recruit_applications SET status='declined', reviewed_by=$2, reviewed_at=now(), decision_note=$3 WHERE id=$1 AND status='new' RETURNING *",
    [int(req.params.id), req.user.id, note],
  );
  if (!a) throw new HttpError(404, 'That application was already dealt with.');
  tellMember(a.user_id, 'Application declined', note || 'Staff have declined your application for now. You can apply again later.');
  await audit(req.user.id, 'recruit.decline', `#${a.id}`, { note });
  res.json({ ok: true });
});

// ---------- Staff: postings and specialties ----------
combat.put('/admin/combat/postings/:userId', role('mod'), async (req, res) => {
  const user = await one("SELECT * FROM users WHERE id=$1 AND status='active'", [int(req.params.userId)]);
  if (!user) throw new HttpError(404, 'Member not found.');
  if (isPmc(user)) throw new HttpError(400, 'PMCs can\'t be posted to a unit. Accept their application (which makes them a member) or change them to a member first.');
  const posted = await postMember(user.id, req.body?.unit_id, str(req.body?.role_id, 40), req.user.id);
  tellMember(user.id, 'New posting', `You're posted to ${posted.unit.name} as ${posted.role.name}.`);
  await audit(req.user.id, 'combat.post', `${user.persona_name} (#${user.id})`, { unit: posted.unit.name, role: posted.role.name });
  res.json({ ok: true });
});
combat.delete('/admin/combat/postings/:userId', role('mod'), async (req, res) => {
  const r = await one('DELETE FROM combat_postings WHERE user_id=$1 RETURNING *', [int(req.params.userId)]);
  if (r) {
    bus.emit('combat:changed');
    await audit(req.user.id, 'combat.unpost', `#${r.user_id}`);
  }
  res.json({ ok: true });
});
combat.put('/admin/combat/profiles/:userId', role('mod'), async (req, res) => {
  const user = await one('SELECT id, persona_name FROM users WHERE id=$1', [int(req.params.userId)]);
  if (!user) throw new HttpError(404, 'Member not found.');
  const list = await specialties();
  const b = req.body || {};
  const primary = pickRole(list, b.primary_role);
  const secondary = pickRole(list, b.secondary_role);
  const quals = [...new Set((Array.isArray(b.qualifications) ? b.qualifications : []).map((s) => pickRole(list, s)).filter(Boolean))];
  await q(
    `INSERT INTO combat_profiles (user_id, primary_role, secondary_role, qualifications, leadership, pilot, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (user_id) DO UPDATE SET primary_role=EXCLUDED.primary_role, secondary_role=EXCLUDED.secondary_role,
       qualifications=EXCLUDED.qualifications, leadership=EXCLUDED.leadership, pilot=EXCLUDED.pilot, updated_at=now()`,
    [user.id, primary, secondary, JSON.stringify(quals), bool(b.leadership), bool(b.pilot)],
  );
  bus.emit('combat:changed');
  await audit(req.user.id, 'combat.profile', `${user.persona_name} (#${user.id})`, { primary, secondary });
  res.json({ ok: true });
});

// ---------- Admins: units ----------
function cleanUnit(b) {
  const seen = new Set();
  const roles = (Array.isArray(b.roles) ? b.roles : []).slice(0, 20).map((r, i) => {
    let id = str(r?.id, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || `role-${Date.now().toString(36)}-${i}`;
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    return { id, name: str(r?.name, 60) || 'Role', slots: Math.min(20, Math.max(1, int(r?.slots, 1))), leader: bool(r?.leader) };
  });
  return {
    name: str(b.name, 30).toUpperCase() || 'UNIT',
    kind: ['command', 'combat', 'support'].includes(b.kind) ? b.kind : 'combat',
    label: str(b.label, 40),
    mission: str(b.mission, 600),
    color: color(b.color, '#29b6f6'),
    roles,
    sort_order: int(b.sort_order, 100),
  };
}
combat.post('/admin/combat/units', role('admin'), async (req, res) => {
  const u = cleanUnit(req.body || {});
  const row = await one('INSERT INTO combat_units (name, kind, label, mission, color, roles, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [u.name, u.kind, u.label, u.mission, u.color, JSON.stringify(u.roles), u.sort_order]);
  bus.emit('combat:changed');
  await audit(req.user.id, 'combat.unit.create', u.name);
  res.json(row);
});
combat.put('/admin/combat/units/:id', role('admin'), async (req, res) => {
  const u = cleanUnit(req.body || {});
  const row = await one('UPDATE combat_units SET name=$2, kind=$3, label=$4, mission=$5, color=$6, roles=$7, sort_order=$8 WHERE id=$1 RETURNING *',
    [int(req.params.id), u.name, u.kind, u.label, u.mission, u.color, JSON.stringify(u.roles), u.sort_order]);
  if (!row) throw new HttpError(404, 'Unit not found.');
  bus.emit('combat:changed');
  await audit(req.user.id, 'combat.unit.edit', u.name);
  res.json(row);
});
combat.delete('/admin/combat/units/:id', role('admin'), async (req, res) => {
  const row = await one('DELETE FROM combat_units WHERE id=$1 RETURNING name', [int(req.params.id)]);
  await q('DELETE FROM combat_postings WHERE unit_id=$1', [int(req.params.id)]);
  bus.emit('combat:changed');
  if (row) await audit(req.user.id, 'combat.unit.delete', row.name);
  res.json({ ok: true });
});

// ---------- For profiles ----------
export async function combatFor(userId) {
  const [posting, profile] = await Promise.all([
    one('SELECT cp.role_id, cu.name, cu.label, cu.color, cu.roles FROM combat_postings cp JOIN combat_units cu ON cu.id = cp.unit_id WHERE cp.user_id=$1', [userId]),
    one('SELECT primary_role, secondary_role, qualifications, leadership, pilot FROM combat_profiles WHERE user_id=$1', [userId]),
  ]);
  if (!posting && !profile) return null;
  return {
    unit: posting ? { name: posting.name, label: posting.label, color: posting.color } : null,
    role: posting ? (posting.roles || []).find((r) => r.id === posting.role_id)?.name || '' : '',
    ...(profile || {}),
  };
}

