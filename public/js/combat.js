// Combat Command: the recruitment form, the board of units (WPG members only), and the doctrine page.
// Also the Recruitment and Units tabs in the Command panel (mods review, admins edit units).
import { api, esc, state, toast, fail, modal, confirmBox, promptBox, onLive, fmtNum, timeAgo, userLine } from './app.js';
import { icon } from './icons.js';
import { rankBadge, wpgBadge } from './insignia.js';

const isStaff = () => ['mod', 'admin'].includes(state.me?.role);
const isAdmin = () => state.me?.role === 'admin';
const isWpg = () => state.me && (state.me.membership !== 'pmc' || isStaff());
const KINDS = [['command', 'Command'], ['combat', 'Combat unit'], ['support', 'Support unit']];

const tabsHtml = (active) => `<div class="tabs">
    ${isWpg() ? `<a href="#/command" class="${active === 'command' ? 'active' : ''}">Combat Command</a>
    <a href="#/doctrine" class="${active === 'doctrine' ? 'active' : ''}">Doctrine</a>` : ''}
    <a href="#/recruitment" class="${active === 'recruitment' ? 'active' : ''}">Recruitment</a>
  </div>`;
const header = (active) => `<h1>${icon('shield', 'width="26" height="26" style="vertical-align:-4px;color:var(--accent)"')} Combat Command</h1>
  <p class="muted small" style="margin:-6px 0 12px">One faction · One force · One objective — <b style="color:#ffd54f">control the HZ</b>.</p>${tabsHtml(active)}`;

// What a member is doing right now (green = on the WPG server, blue = in a game).
function presence(m) {
  if (m.on_server) return '<span class="pill" style="color:var(--green);border-color:var(--green)">On WPG server</span>';
  if (m.in_game) return `<span class="pill">${esc(m.in_game)}</span>`;
  return '';
}

// ---------- Board ----------
export async function viewCommand(main, _r, alive, again) {
  if (!isWpg()) { main.innerHTML = `${header('recruitment')}<div class="panel empty"><h3>WPG members only</h3><p>The Combat Command board is for WPG members. Apply on the Recruitment tab.</p></div>`; return; }
  const d = await api('combat/board');
  if (!alive()) return;
  const onlyOn = new URLSearchParams(location.hash.split('?')[1] || '').get('on') === '1';
  const people = d.units.flatMap((u) => [...u.roles.flatMap((r) => r.members), ...u.unplaced]);
  const onNow = people.filter((m) => m.on_server || m.in_game).length;
  const slot = (u, r, m) => {
    if (!m) return `<div class="cc-slot open"><span class="cc-role">${r.leader ? '★ ' : ''}${esc(r.name)}</span><span class="cc-open">OPEN</span>
      ${d.can_assign ? `<button class="btn small ghost" data-fill="${u.id}" data-role="${esc(r.id)}">Fill</button>` : ''}</div>`;
    if (onlyOn && !m.on_server && !m.in_game) return '';
    // Clan rank + WPG rank badges and the full name (tap for their profile); where they are shows on hover.
    const where = m.on_server ? 'On the WPG server now' : m.in_game ? `Playing ${m.in_game}` : '';
    return `<div class="cc-slot"><span class="cc-role">${r.leader ? '★ ' : ''}${esc(r.name)}</span>
      <a class="cc-who" href="#/u/${m.id}"${where ? ` title="${esc(where)}"` : ''}>
        <span class="cc-badges">${rankBadge(m.rank, 24)}${wpgBadge(m.wpg?.level, 24, m.wpg?.name)}</span><b>${esc(m.name)}</b></a>
      ${d.can_assign ? `<button class="btn small ghost" data-move="${m.id}" title="Move or remove">⋯</button>` : ''}</div>`;
  };
  const unitHtml = (u) => `<div class="panel cc-unit" style="--uc:${esc(u.color)}">
      <div class="row between"><div class="panel-title" style="margin:0"><span class="cc-bar"></span>${esc(u.name)} <span class="sub">${esc(u.label)}</span></div>
        <b style="color:${u.open ? '#f5a524' : 'var(--green)'}">${u.filled}/${u.size}</b></div>
      ${u.mission ? `<p class="muted small" style="margin:6px 0 10px">${esc(u.mission)}</p>` : ''}
      ${u.in_game ? `<p class="small" style="margin:0 0 8px;color:var(--green)">● ${u.in_game} in game now</p>` : ''}
      <div class="cc-slots">${u.roles.flatMap((r) => Array.from({ length: Math.max(r.slots, r.members.length) }, (_, i) => slot(u, r, r.members[i] || null))).join('')}
        ${u.unplaced.map((m) => slot(u, { name: 'No role', id: '' }, m)).join('')}</div>
    </div>`;
  const command = d.units.find((u) => u.kind === 'command');
  main.innerHTML = `${header('command')}
    <div class="stack">
      <div class="panel">
        <div class="row between">
          <div class="panel-title" style="margin:0">${icon('chevrons')} Line of succession</div>
          <div class="row" style="gap:6px">
            <a class="btn small${onlyOn ? ' primary' : ' ghost'}" href="#/command${onlyOn ? '' : '?on=1'}">● ${onNow} on now${onlyOn ? ' (showing)' : ''}</a>
            ${d.can_edit ? '<a class="btn small ghost" href="#/admin/units">Edit units</a>' : ''}
          </div>
        </div>
        <p class="muted small" style="margin:6px 0 10px">WPG does not depend on one person being online. If someone above isn't on, the next person takes command and follows the same doctrine.</p>
        <div class="cc-chain">${d.chain.map((c, i) => `<div class="cc-link${c.user ? '' : ' open'}"><span class="cc-num">${i + 1}</span>
          <div><div class="small muted">${esc(c.title)}</div>${c.user ? `<a href="#/u/${c.user.id}"><b>${esc(c.user.name)}</b></a> ${presence(c.user)}` : '<b style="color:#f5a524">OPEN</b>'}</div></div>`).join('<span class="cc-arrow">→</span>')}</div>
      </div>
      ${command ? unitHtml(command) : ''}
      <div class="cc-grid">${d.units.filter((u) => u.kind !== 'command').map(unitHtml).join('')}</div>
    </div>`;
  if (d.can_assign) bindAssign(main, d);
  // Redraws in place when units or who's playing change. Listen once only (a redraw must not add more listeners).
  if (!again) {
    const redraw = () => { if (alive()) viewCommand(main, _r, alive, true).catch(() => {}); };
    onLive('combat', redraw);
    onLive('playing', redraw);
  }
}

// Staff: fill an open slot, or move / remove someone.
function bindAssign(main, d) {
  main.querySelectorAll('[data-fill]').forEach((b) => {
    b.onclick = async () => {
      const unit = d.units.find((u) => u.id === Number(b.dataset.fill));
      const r = unit.roles.find((x) => x.id === b.dataset.role);
      const members = (await api('members')).filter((m) => m.membership !== 'pmc');
      const posted = new Set(d.units.flatMap((u) => [...u.roles.flatMap((x) => x.members), ...u.unplaced]).map((m) => m.id));
      const m = modal(`<div class="row between"><h2 style="margin:0">${esc(unit.name)} — ${esc(r.name)}</h2><button class="btn ghost small" data-close>✕</button></div>
        <input type="search" placeholder="Search members" id="ccSearch" style="margin:10px 0">
        <div class="list" id="ccList" style="max-height:50vh;overflow:auto"></div>`);
      m.el.querySelector('[data-close]').onclick = m.close;
      const draw = () => {
        const t = m.el.querySelector('#ccSearch').value.toLowerCase();
        m.el.querySelector('#ccList').innerHTML = members.filter((x) => x.name.toLowerCase().includes(t)).slice(0, 60)
          .map((x) => `<button class="item" style="width:100%;text-align:left" data-pick="${x.id}">${userLine(x, posted.has(x.id) ? 'already posted — this moves them' : '')}</button>`).join('') || '<p class="muted">Nobody found.</p>';
        m.el.querySelectorAll('[data-pick]').forEach((p) => {
          p.onclick = async () => {
            try { await api(`admin/combat/postings/${p.dataset.pick}`, { method: 'PUT', body: { unit_id: unit.id, role_id: r.id } }); m.close(); toast('Posted', `${r.name} filled.`); } catch (x) { fail(x); }
          };
        });
      };
      m.el.querySelector('#ccSearch').oninput = draw;
      draw();
    };
  });
  main.querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = () => {
      const id = Number(b.dataset.move);
      const who = d.units.flatMap((u) => [...u.roles.flatMap((x) => x.members), ...u.unplaced]).find((x) => x.id === id);
      const opts = d.units.flatMap((u) => u.roles.map((r) => `<option value="${u.id}|${esc(r.id)}">${esc(u.name)} — ${esc(r.name)}${r.open ? ` (${r.open} open)` : ' (full)'}</option>`)).join('');
      const m = modal(`<div class="row between"><h2 style="margin:0">${esc(who?.name || 'Member')}</h2><button class="btn ghost small" data-close>✕</button></div>
        <label class="field" style="margin-top:10px"><span>Move to</span><select id="ccTo">${opts}</select></label>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="ccGo">Move</button><button class="btn danger" id="ccOut">Remove from units</button></div>`);
      m.el.querySelector('[data-close]').onclick = m.close;
      m.el.querySelector('#ccGo').onclick = async () => {
        const [unit_id, role_id] = m.el.querySelector('#ccTo').value.split('|');
        try { await api(`admin/combat/postings/${id}`, { method: 'PUT', body: { unit_id: Number(unit_id), role_id } }); m.close(); } catch (x) { fail(x); }
      };
      m.el.querySelector('#ccOut').onclick = async () => {
        if (!(await confirmBox(`Take ${who?.name || 'them'} out of their unit?`))) return;
        try { await api(`admin/combat/postings/${id}`, { method: 'DELETE' }); m.close(); } catch (x) { fail(x); }
      };
    };
  });
}

// ---------- Doctrine ----------
// A small, safe text format: "## heading", "- point", **bold**. Everything is escaped first.
function doctrineHtml(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^- /.test(line)) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(line.slice(2))}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if (!line) continue;
    if (/^## /.test(line)) out.push(`<h3 class="dz-h">${inline(line.slice(3))}</h3>`);
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}
export async function viewDoctrine(main, _r, alive) {
  if (!isWpg()) { main.innerHTML = `${header('recruitment')}<div class="panel empty"><h3>WPG members only</h3></div>`; return; }
  const d = await api('combat/doctrine');
  if (!alive()) return;
  main.innerHTML = `${header('doctrine')}
    <div class="panel doctrine">${doctrineHtml(d.text) || '<p class="muted">No doctrine written yet.</p>'}
      ${d.can_edit ? '<div class="row" style="margin-top:14px"><button class="btn small" id="dzEdit">Edit doctrine</button></div>' : ''}</div>`;
  document.getElementById('dzEdit')?.addEventListener('click', () => {
    const m = modal(`<div class="row between"><h2 style="margin:0">Edit doctrine</h2><button class="btn ghost small" data-close>✕</button></div>
      <p class="muted small">Start a line with <b>## </b> for a heading and <b>- </b> for a point. Put <b>**two stars**</b> around words to make them bold.</p>
      <textarea id="dzText" style="min-height:50vh;font-family:monospace">${esc(d.text)}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="dzSave">Save</button></div>`);
    m.el.querySelector('[data-close]').onclick = m.close;
    m.el.querySelector('#dzSave').onclick = async () => {
      try { await api('combat/doctrine', { method: 'PUT', body: { text: m.el.querySelector('#dzText').value } }); m.close(); toast('Saved', 'Doctrine updated.'); viewDoctrine(main, _r, alive); } catch (x) { fail(x); }
    };
  });
}

// ---------- Recruitment (apply) ----------
const STATUS = {
  new: ['With staff', '#33d1ff'], accepted: ['Accepted', 'var(--green)'], declined: ['Declined', 'var(--red)'], withdrawn: ['Withdrawn', 'var(--muted)'],
};
export async function viewRecruitment(main, _r, alive) {
  const d = await api('combat/me');
  if (!alive()) return;
  const a = d.application;
  const roleOpts = (sel) => `<option value="">— pick one —</option>${d.specialties.map((s) => `<option${s === sel ? ' selected' : ''}>${esc(s)}</option>`).join('')}`;
  let body;
  if (d.pmc && !d.can_apply && a?.status !== 'new') {
    // PMC guests ask staff before they can apply.
    const r = d.request;
    body = `<div class="panel stack">
      <div class="panel-title" style="margin:0">${icon('target')} Ask to apply</div>
      <p style="margin:0">You're a <b>PMC</b> (guest). To join a WPG unit, ask staff first. Once they say yes, the application form opens here.</p>
      ${r?.status === 'pending' ? `<p style="margin:0;color:#33d1ff">✓ Your request is with staff (sent ${esc(timeAgo(r.created_at))}). You'll get a message when they answer.</p>`
        : `${r?.status === 'declined' ? `<p class="small" style="margin:0;color:var(--red)">Your last request was declined${r.note ? `: ${esc(r.note)}` : ''}. You can ask again a week after that.</p>` : ''}
        <form id="askForm" class="stack"><textarea name="message" maxlength="500" placeholder="Tell staff a bit about yourself and why you'd like to join (optional)"></textarea>
        <div class="row"><button class="btn primary">Ask to apply</button></div></form>`}
    </div>`;
  } else if (a?.status === 'new') {
    body = `<div class="panel stack">
      <div class="panel-title" style="margin:0">${icon('target')} Your application</div>
      <p style="margin:0;color:#33d1ff">✓ Sent ${esc(timeAgo(a.created_at))} — staff will review it. You'll get a message in the app${state.discordLinked ? ' and on Discord' : ''}.</p>
      ${appSummary(a)}
      <div class="row"><button class="btn ghost" id="withdraw">Withdraw (to change it)</button></div>
    </div>`;
  } else {
    const prev = a?.status === 'withdrawn' || a?.status === 'declined' ? a : null;
    body = `${a && a.status !== 'withdrawn' ? `<div class="panel" style="margin-bottom:12px">
        <b style="color:${STATUS[a.status]?.[1]}">Last application: ${STATUS[a.status]?.[0]}</b> <span class="muted small">${esc(timeAgo(a.reviewed_at || a.created_at))}</span>
        ${a.decision_note ? `<p class="small" style="margin:6px 0 0">${esc(a.decision_note)}</p>` : ''}</div>` : ''}
      <form class="panel stack" id="applyForm">
        <div class="panel-title" style="margin:0">${icon('target')} Apply to a WPG unit</div>
        <p class="muted small" style="margin:0">Every member gets a <b>primary role</b> (main specialty), a <b>secondary role</b> (backup) and <b>qualifications</b> (other jobs you can do). Assignments are based on skill, availability and what WPG needs. Your class levels, hours and WPG server stats are added for staff automatically.</p>
        <div class="form-grid">
          <label class="field"><span>Primary role wanted</span><select name="primary_role" required>${roleOpts(prev?.primary_role)}</select></label>
          <label class="field"><span>Secondary (backup) role</span><select name="secondary_role" required>${roleOpts(prev?.secondary_role)}</select></label>
        </div>
        <div class="field"><span style="display:block;font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;margin-bottom:6px">Other skills (tick any)</span>
          <div class="cc-skills">${d.specialties.map((s) => `<label class="check small"><input type="checkbox" name="skills" value="${esc(s)}"${prev?.skills?.includes(s) ? ' checked' : ''}> ${esc(s)}</label>`).join('')}</div></div>
        <div class="row" style="gap:20px">
          <label class="check"><input type="checkbox" name="leadership"${prev?.leadership ? ' checked' : ''}> I can lead (unit leader / command)</label>
          <label class="check"><input type="checkbox" name="pilot"${prev?.pilot ? ' checked' : ''}> I can fly (pilot)</label>
        </div>
        <div class="form-grid">
          <label class="field"><span>When do you usually play?</span><input type="text" name="availability" maxlength="200" placeholder="e.g. weekday evenings 7–11pm UK, weekends" value="${esc(prev?.availability || '')}"></label>
          <label class="field"><span>Region</span><select name="region">${['', 'UK / Europe', 'North America', 'South America', 'Asia', 'Oceania', 'Other'].map((x) => `<option value="${esc(x)}"${prev?.region === x ? ' selected' : ''}>${x || '—'}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Anything else staff should know</span><textarea name="notes" maxlength="1000">${esc(prev?.notes || '')}</textarea></label>
        <div class="row"><button class="btn primary">Send application</button></div>
      </form>`;
  }
  main.innerHTML = `${header('recruitment')}
    ${d.posting ? `<div class="panel" style="margin-bottom:12px"><b>Your posting:</b> ${esc(d.posting.unit)} — ${esc(d.posting.role)} ${isWpg() ? '<a href="#/command" class="small">See the board →</a>' : ''}</div>` : ''}
    ${d.profile ? `<div class="panel" style="margin-bottom:12px">${roleLine(d.profile)}</div>` : ''}
    ${body}`;
  document.getElementById('askForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('combat/apply-request', { method: 'POST', body: { message: e.target.message.value } }); toast('Sent', 'Your request is with staff.'); viewRecruitment(main, _r, alive); } catch (x) { fail(x); }
  });
  document.getElementById('withdraw')?.addEventListener('click', async () => {
    if (!(await confirmBox('Withdraw your application? You can send a new one straight away.'))) return;
    try { await api('combat/applications/withdraw', { method: 'POST', body: {} }); viewRecruitment(main, _r, alive); } catch (x) { fail(x); }
  });
  const f = document.getElementById('applyForm');
  if (f) {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body2 = {
        primary_role: f.primary_role.value, secondary_role: f.secondary_role.value,
        skills: [...f.querySelectorAll('[name=skills]:checked')].map((x) => x.value),
        leadership: f.leadership.checked, pilot: f.pilot.checked, availability: f.availability.value, region: f.region.value, notes: f.notes.value,
      };
      try { await api('combat/applications', { method: 'POST', body: body2 }); toast('Application sent', 'Staff will review it. Good luck, soldier.'); viewRecruitment(main, _r, alive); } catch (x) { fail(x); }
    };
  }
}

function roleLine(p) {
  const quals = Array.isArray(p.qualifications) ? p.qualifications : [];
  return `<b>Primary:</b> ${esc(p.primary_role || '—')} · <b>Secondary:</b> ${esc(p.secondary_role || '—')}${quals.length ? ` · <b>Qualified:</b> ${quals.map(esc).join(', ')}` : ''}${p.leadership ? ' · <span class="pill">Leadership</span>' : ''}${p.pilot ? ' · <span class="pill">Pilot</span>' : ''}`;
}
function appSummary(a) {
  return `<div class="small"><b>Primary:</b> ${esc(a.primary_role)} · <b>Secondary:</b> ${esc(a.secondary_role)}
    ${a.skills?.length ? `<br><b>Other skills:</b> ${a.skills.map(esc).join(', ')}` : ''}
    <br><b>Leadership:</b> ${a.leadership ? 'Yes' : 'No'} · <b>Pilot:</b> ${a.pilot ? 'Yes' : 'No'}
    ${a.availability ? `<br><b>Plays:</b> ${esc(a.availability)}` : ''}${a.region ? ` · <b>Region:</b> ${esc(a.region)}` : ''}
    ${a.notes ? `<br><b>Notes:</b> ${esc(a.notes)}` : ''}</div>`;
}

// Profile box: posting and roles (shown on a member's career page to WPG members).
export function profileCombatHtml(c) {
  if (!c) return '';
  return `<div class="panel"><div class="panel-title">${icon('shield')} Combat Command</div>
    ${c.unit ? `<p style="margin:0 0 6px"><span class="pill" style="color:${esc(c.unit.color)};border-color:${esc(c.unit.color)}">${esc(c.unit.name)}</span> <b>${esc(c.role)}</b> <span class="muted small">${esc(c.unit.label)}</span></p>` : '<p class="muted small" style="margin:0 0 6px">Not posted to a unit yet.</p>'}
    ${c.primary_role || c.secondary_role ? `<p class="small" style="margin:0">${roleLine(c)}</p>` : ''}</div>`;
}

// ---------- Command panel: Recruitment (mods + admins) ----------
const statLine = (s) => {
  const parts = [];
  if (s.wardogs?.level !== null && s.wardogs?.level !== undefined) parts.push(`Wardog level <b>${s.wardogs.level}</b>`);
  const roles = Object.entries(s.wardogs?.roles || {});
  if (roles.length) parts.push(roles.map(([k, v]) => `${k} ${v}`).join(' · '));
  if (s.hours !== undefined) parts.push(`<b>${fmtNum(s.hours)}</b> h played`);
  if (s.server) parts.push(`WPG server: ${fmtNum(s.server.kills)} kills / ${fmtNum(s.server.deaths)} deaths · ${fmtNum(s.server.matches)} matches`);
  if (s.wpg) parts.push(`${esc(s.wpg.rank)} (${fmtNum(s.wpg.xp)} WPG XP)`);
  if (s.discord) parts.push(`Discord: ${esc(s.discord)}`);
  return parts.length ? `<div class="small muted" style="margin-top:4px">${parts.join(' · ')}</div>` : '<div class="small muted">No stats yet.</div>';
};

export async function recruitmentTab(body) {
  const d = await api('admin/recruitment');
  const fresh = d.applications.filter((a) => a.status === 'new');
  const waiting = d.requests.filter((r) => r.status === 'pending');
  const appHtml = (a) => `<div class="item" style="display:block" data-app="${a.id}">
      <div class="row between">${a.user ? userLine(a.user) : '<b>Unknown member</b>'}
        <div class="row" style="gap:6px"><span class="pill" style="color:${STATUS[a.status]?.[1]};border-color:${STATUS[a.status]?.[1]}">${STATUS[a.status]?.[0]}</span><span class="muted small">${esc(timeAgo(a.created_at))}</span></div></div>
      ${appSummary(a)}
      ${statLine(a.stats || {})}
      ${a.status === 'new' ? `<div class="row" style="margin-top:8px;gap:6px"><button class="btn small primary" data-accept="${a.id}">Accept…</button><button class="btn small ghost" data-decline="${a.id}">Decline</button></div>`
        : `<div class="row" style="margin-top:6px;gap:8px"><span class="small muted grow">${esc(STATUS[a.status]?.[0] || a.status)}${a.reviewer ? ` by ${esc(a.reviewer)}` : ''}${a.posted_to ? ` · posted to ${esc(a.posted_to)}` : ''}${a.decision_note ? ` · "${esc(a.decision_note)}"` : ''}</span><button class="btn small ghost" data-delapp="${a.id}" title="Delete">${icon('trash')}</button></div>`}
    </div>`;
  body.innerHTML = `<div class="stack">
    <div class="panel"><div class="panel-title">${icon('target')} PMCs asking to apply <span class="sub">${waiting.length} waiting</span></div>
      <div class="list">${d.requests.map((r) => `<div class="item" style="display:block">
        <div class="row between">${r.user ? userLine(r.user) : '<b>Unknown</b>'}<span class="muted small">${esc(({ pending: 'Waiting', allowed: 'Allowed to apply', declined: 'Declined', used: 'Applied' })[r.status] || r.status)} · ${esc(timeAgo(r.created_at))}</span></div>
        ${r.message ? `<p class="small" style="margin:6px 0">${esc(r.message)}</p>` : ''}${statLine(r.stats || {})}
        ${r.status === 'pending' ? `<div class="row" style="margin-top:8px;gap:6px"><button class="btn small primary" data-allow="${r.id}">Allow to apply</button><button class="btn small ghost" data-refuse="${r.id}">Decline</button></div>` : `<div class="row" style="margin-top:6px"><span class="grow"></span><button class="btn small ghost" data-delreq="${r.id}" title="Delete">${icon('trash')}</button></div>`}
      </div>`).join('') || '<p class="muted">No requests.</p>'}</div></div>
    <div class="panel"><div class="panel-title">Applications <span class="sub">${fresh.length} new</span></div>
      <div class="list">${d.applications.map(appHtml).join('') || '<p class="muted">No applications yet. Members apply on the Recruitment page (or /apply in Discord).</p>'}</div></div>
  </div>`;
  const again = () => recruitmentTab(body);
  body.querySelectorAll('[data-delapp],[data-delreq]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmBox('Delete this? The member keeps any unit and roles they were given.'))) return;
      const path = b.dataset.delapp ? `admin/recruitment/applications/${b.dataset.delapp}` : `admin/recruitment/requests/${b.dataset.delreq}`;
      try { await api(path, { method: 'DELETE' }); again(); } catch (x) { fail(x); }
    };
  });
  body.querySelectorAll('[data-allow],[data-refuse]').forEach((b) => {
    b.onclick = async () => {
      const allow = !!b.dataset.allow;
      const note = allow ? '' : await promptBox('Decline this request?', 'Reason (shown to them, optional)', { okLabel: 'Decline' });
      if (note === null) return;
      try { await api(`admin/recruitment/requests/${b.dataset.allow || b.dataset.refuse}/${allow ? 'allow' : 'decline'}`, { method: 'POST', body: { note } }); again(); } catch (x) { fail(x); }
    };
  });
  body.querySelectorAll('[data-decline]').forEach((b) => {
    b.onclick = async () => {
      const note = await promptBox('Decline this application?', 'Reason (shown to them, optional)', { okLabel: 'Decline', danger: true });
      if (note === null) return;
      try { await api(`admin/recruitment/applications/${b.dataset.decline}/decline`, { method: 'POST', body: { note } }); again(); } catch (x) { fail(x); }
    };
  });
  body.querySelectorAll('[data-accept]').forEach((b) => {
    b.onclick = () => {
      const a = d.applications.find((x) => x.id === Number(b.dataset.accept));
      const pmc = a.user?.membership === 'pmc';
      // Suggest roles whose name matches what they asked for.
      const want = [a.primary_role, a.secondary_role].map((s) => s.toLowerCase().split(/[ /]+/)[0]);
      const opts = d.units.flatMap((u) => u.roles.map((r) => {
        const match = want.some((w) => w && r.name.toLowerCase().includes(w));
        return { v: `${u.id}|${r.id}`, t: `${u.name} — ${r.name}${r.open ? ` (${r.open} open)` : ' (full)'}`, score: (match ? 2 : 0) + (r.open ? 1 : 0) };
      })).sort((x, y) => y.score - x.score);
      const m = modal(`<div class="row between"><h2 style="margin:0">Accept ${esc(a.user?.name || 'applicant')}</h2><button class="btn ghost small" data-close>✕</button></div>
        <p class="small muted">They asked for <b>${esc(a.primary_role)}</b> (backup ${esc(a.secondary_role)}). Their primary, secondary and skills are saved to their profile.</p>
        <label class="field"><span>Post them to</span><select id="acTo"><option value="">Don't post yet (accept onto the roster only)</option>${opts.map((o) => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join('')}</select></label>
        ${pmc ? '<label class="check" style="margin-top:8px"><input type="checkbox" id="acMember" checked> Make them a WPG member (they are a PMC now)</label>' : ''}
        <label class="field" style="margin-top:8px"><span>Message to them (optional)</span><input type="text" id="acNote" maxlength="300" placeholder="e.g. Welcome to Alpha — join voice on Friday"></label>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="acGo">Accept</button></div>`);
      m.el.querySelector('[data-close]').onclick = m.close;
      m.el.querySelector('#acGo').onclick = async () => {
        const [unit_id, role_id] = (m.el.querySelector('#acTo').value || '|').split('|');
        try {
          await api(`admin/recruitment/applications/${a.id}/accept`, { method: 'POST', body: { unit_id: unit_id ? Number(unit_id) : null, role_id, note: m.el.querySelector('#acNote').value, make_member: m.el.querySelector('#acMember') ? m.el.querySelector('#acMember').checked : undefined } });
          m.close();
          toast('Accepted', `${a.user?.name || 'Applicant'} has been told.`);
          again();
        } catch (x) { fail(x); }
      };
    };
  });
}

// ---------- Command panel: Units (admins) ----------
export async function unitsTab(body) {
  const d = await api('combat/board');
  const s = await api('admin/settings');
  body.innerHTML = `<div class="stack">
    <div class="panel"><div class="row between"><div class="panel-title" style="margin:0">${icon('shield')} Units <span class="sub">${d.units.length}</span></div>
      <button class="btn primary" id="unAdd">${icon('plus')} Add unit</button></div>
      <p class="muted small">The Command unit's roles are the line of succession, in order (CO first). Other units: tick "Leader" on the role that leads it — leaders join the succession after Command. Changing a role's name keeps the people in it.</p>
      <div class="list">${d.units.map((u) => `<div class="item"><div class="grow"><b style="color:${esc(u.color)}">${esc(u.name)}</b> <span class="muted small">${esc(u.label)} · ${u.filled}/${u.size} · ${esc(KINDS.find((k) => k[0] === u.kind)?.[1] || u.kind)}</span>
        <div class="muted small">${u.roles.map((r) => `${esc(r.name)}${r.slots > 1 ? ` ×${r.slots}` : ''}${r.leader ? ' ★' : ''}`).join(' · ')}</div></div>
        <button class="btn small" data-unit="${u.id}">${icon('edit')} Edit</button></div>`).join('')}</div></div>
    <form class="panel stack" id="specForm"><div class="panel-title" style="margin:0">Roles people can apply for</div>
      <p class="muted small" style="margin:0">One per line. These are the choices on the application form and the member's primary / secondary / qualifications.</p>
      <textarea name="combat_specialties" style="min-height:220px">${esc(s.combat_specialties || '')}</textarea>
      <label class="field"><span>Discord channel ID for new applications (empty = the staff channel)</span><input type="text" name="discord_recruit_channel" value="${esc(s.discord_recruit_channel || '')}"></label>
      <div class="row"><button class="btn primary">Save</button></div></form>
  </div>`;
  body.querySelector('#specForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('admin/settings', { method: 'PUT', body: { combat_specialties: e.target.combat_specialties.value, discord_recruit_channel: e.target.discord_recruit_channel.value } }); toast('Saved', 'Recruitment roles updated.'); } catch (x) { fail(x); }
  };
  body.querySelector('#unAdd').onclick = () => unitEditor(null, () => unitsTab(body));
  body.querySelectorAll('[data-unit]').forEach((b) => { b.onclick = () => unitEditor(d.units.find((u) => u.id === Number(b.dataset.unit)), () => unitsTab(body)); });
}

function unitEditor(u, done) {
  const roles = (u?.roles || []).map((r) => ({ id: r.id, name: r.name, slots: r.slots, leader: !!r.leader }));
  const m = modal(`<div class="row between"><h2 style="margin:0">${u ? `Edit ${esc(u.name)}` : 'New unit'}</h2><button class="btn ghost small" data-close>✕</button></div>
    <form id="unForm" class="stack" style="margin-top:10px">
      <div class="form-grid">
        <label class="field"><span>Name</span><input type="text" name="name" maxlength="30" value="${esc(u?.name || '')}" placeholder="e.g. DELTA"></label>
        <label class="field"><span>What it is</span><input type="text" name="label" maxlength="40" value="${esc(u?.label || '')}" placeholder="e.g. HZ Assault"></label>
        <label class="field"><span>Type</span><select name="kind">${KINDS.map(([k, l]) => `<option value="${k}"${(u?.kind || 'combat') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Colour</span><input type="color" name="color" value="${esc(u?.color || '#29b6f6')}"></label>
        <label class="field"><span>Order</span><input type="number" name="sort_order" value="${u?.sort_order ?? 100}"></label>
      </div>
      <label class="field"><span>Mission</span><textarea name="mission" maxlength="600">${esc(u?.mission || '')}</textarea></label>
      <div><b>Roles</b> <span class="muted small">(slots = how many people)</span><div id="unRoles" class="stack" style="margin-top:6px"></div>
        <button type="button" class="btn small" id="unRoleAdd" style="margin-top:6px">${icon('plus')} Add role</button></div>
      <div class="row"><button class="btn primary">Save</button>${u ? '<span class="grow"></span><button type="button" class="btn danger" id="unDel">Delete unit</button>' : ''}</div>
    </form>`);
  m.el.querySelector('[data-close]').onclick = m.close;
  const box = m.el.querySelector('#unRoles');
  const draw = () => {
    box.innerHTML = roles.map((r, i) => `<div class="row" style="gap:6px" data-i="${i}">
      <input type="text" class="grow" data-k="name" value="${esc(r.name)}" placeholder="Role name" maxlength="60">
      <input type="number" data-k="slots" value="${r.slots}" min="1" max="20" style="width:70px" title="Slots">
      <label class="check small"><input type="checkbox" data-k="leader"${r.leader ? ' checked' : ''}> Leader</label>
      <button type="button" class="btn small ghost" data-up="${i}" title="Move up">↑</button>
      <button type="button" class="btn small ghost" data-rm="${i}" title="Remove">✕</button></div>`).join('') || '<p class="muted small">No roles yet.</p>';
    box.querySelectorAll('[data-i]').forEach((row) => {
      const r = roles[Number(row.dataset.i)];
      row.querySelector('[data-k=name]').oninput = (e) => { r.name = e.target.value; };
      row.querySelector('[data-k=slots]').oninput = (e) => { r.slots = Number(e.target.value) || 1; };
      row.querySelector('[data-k=leader]').onchange = (e) => { r.leader = e.target.checked; };
    });
    box.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { roles.splice(Number(b.dataset.rm), 1); draw(); }; });
    box.querySelectorAll('[data-up]').forEach((b) => {
      b.onclick = () => { const i = Number(b.dataset.up); if (i > 0) { [roles[i - 1], roles[i]] = [roles[i], roles[i - 1]]; draw(); } };
    });
  };
  draw();
  m.el.querySelector('#unRoleAdd').onclick = () => { roles.push({ id: '', name: '', slots: 1, leader: false }); draw(); };
  m.el.querySelector('#unDel')?.addEventListener('click', async () => {
    if (!(await confirmBox(`Delete ${u.name}? Everyone posted to it is taken out of it.`))) return;
    try { await api(`admin/combat/units/${u.id}`, { method: 'DELETE' }); m.close(); done(); } catch (x) { fail(x); }
  });
  m.el.querySelector('#unForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const payload = { name: f.name.value, label: f.label.value, kind: f.kind.value, color: f.color.value, sort_order: f.sort_order.value, mission: f.mission.value, roles: roles.filter((r) => r.name.trim()) };
    try {
      await api(u ? `admin/combat/units/${u.id}` : 'admin/combat/units', { method: u ? 'PUT' : 'POST', body: payload });
      m.close();
      done();
    } catch (x) { fail(x); }
  };
}

