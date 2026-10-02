import { api, esc, state, toast, fail, modal, confirmBox, userLine, fmtNum, fmtDate, timeAgo, query, ribbon, COUNTRIES, flag, refreshMe } from './app.js';
import { icon } from './icons.js';
import { insigniaSVG, rankBadge, INSIGNIA_PARTS } from './insignia.js';

const isAdmin = () => state.me.role === 'admin';

const TABS = [
  { key: 'users', label: 'Members', mod: true },
  { key: 'announcements', label: 'News', mod: true },
  { key: 'ranks', label: 'Ranks' },
  { key: 'awards', label: 'Medals' },
  { key: 'stat-defs', label: 'Stats' },
  { key: 'game-servers', label: 'Game servers' },
  { key: 'unlocks', label: 'Unlocks' },
  { key: 'artillery', label: 'Artillery' },
  { key: 'channels', label: 'Chat channels' },
  { key: 'games', label: 'Games' },
  { key: 'profile-fields', label: 'Profile fields' },
  { key: 'settings', label: 'Settings' },
  { key: 'audit', label: 'Audit log', mod: true },
];

// Field types: text, number, textarea, check, color, select, insignia, colors
const RESOURCES = {
  announcements: {
    one: 'announcement',
    title: 'News & announcements',
    help: 'Shown on everyone\'s HQ page. Pinned posts stay at the top.',
    fields: [
      { k: 'title', label: 'Title' },
      { k: 'body', label: 'Message', type: 'textarea' },
      { k: 'pinned', label: 'Pin to top', type: 'check' },
    ],
    row: (r) => `<div class="grow"><b>${r.pinned ? '📌 ' : ''}${esc(r.title)}</b><div class="muted small">${fmtDate(r.created_at)}</div></div>`,
  },
  ranks: {
    one: 'rank',
    title: 'Ranks',
    help: 'Order sets seniority (bigger number = more senior). Ranks with “Earned by XP” ticked are given automatically when a member reaches that XP. Others are appointed by hand from the Members tab.',
    fields: [
      { k: 'name', label: 'Rank name' },
      { k: 'abbr', label: 'Short name (e.g. SGT)' },
      { k: 'sort_order', label: 'Order (seniority)', type: 'number' },
      { k: 'min_xp', label: 'XP needed', type: 'number' },
      { k: 'auto', label: 'Earned by XP (automatic promotion)', type: 'check' },
      { k: 'color', label: 'Stripe colour', type: 'color' },
      { k: 'description', label: 'Description', type: 'textarea' },
      { k: 'insignia', label: 'Insignia', type: 'insignia' },
    ],
    defaults: { auto: false, color: '#c9a227', insignia: {}, sort_order: 999, min_xp: 0 },
    row: (r) => `${rankBadge(r, 48)}<div class="grow"><b>${esc(r.name)}</b> <span class="pill">${esc(r.abbr)}</span><div class="muted small">${r.auto ? `Earned at ${fmtNum(r.min_xp)} XP` : 'Appointed'} · order ${r.sort_order}</div></div>`,
  },
  awards: {
    one: 'medal',
    title: 'Medals & ribbons',
    help: 'Create medals here, then give them to members from the Members tab. Medals with an automatic rule are given by themselves when members sync their stats (e.g. class:recon:30 = Recon level 30, hours:200 = 200 hours played).',
    fields: [
      { k: 'name', label: 'Medal name' },
      { k: 'description', label: 'What it is for', type: 'textarea' },
      { k: 'colors', label: 'Ribbon stripes', type: 'colors' },
      { k: 'auto_rule', label: 'Give automatically (optional): class:assault:20 · career:50 · hours:300 — leave empty to give by hand' },
      { k: 'sort_order', label: 'Order', type: 'number' },
    ],
    defaults: { colors: '#1f3a93,#ffffff,#b22234' },
    row: (r) => `${ribbon(r.colors)}<div class="grow"><b>${esc(r.name)}</b> ${r.auto_rule ? `<span class="pill mod">auto · ${esc(r.auto_rule)}</span>` : ''}<div class="muted small">${esc(r.description)}</div></div>`,
  },
  'stat-defs': {
    one: 'stat',
    title: 'Server stats',
    help: 'Stats you track for each member (matches, wins…). Mods type them in on the Members tab, or your Discord bot can send them in automatically. “XP each” gives WPG XP per 1 of this stat. Kills and deaths come from the WPG server, but adding a stat with key “kills” or “deaths” lets you override them.',
    key: 'key',
    fields: [
      { k: 'key', label: 'Key (used by bots, e.g. wins)' },
      { k: 'label', label: 'Label shown in app' },
      { k: 'format', label: 'Format', type: 'select', options: [['number', 'Number'], ['minutes', 'Time (minutes)'], ['money', 'Money ($)'], ['ratio', 'Ratio']] },
      { k: 'xp_each', label: 'XP each', type: 'number', step: 'any' },
      { k: 'sort_order', label: 'Order', type: 'number' },
    ],
    defaults: { format: 'number', xp_each: 0 },
    row: (r) => `<div class="grow"><b>${esc(r.label)}</b> <span class="pill">${esc(r.key)}</span><div class="muted small">${esc(r.format)} · ${Number(r.xp_each)} XP each</div></div>`,
  },
  unlocks: {
    one: 'unlock',
    title: 'Wardogs unlocks',
    help: 'What each class unlocks at each level, stored in our own database. The full list was imported once from WARDOGS Tracker (used with permission). Add, change or remove items here after game updates. Members see their last and next unlock under each class, and the full list on the Progression page. "Career" is the overall Wardog level.',
    fields: [
      { k: 'role', label: 'Class', type: 'select', options: [['recon', 'Recon'], ['assault', 'Assault'], ['medic', 'Medic'], ['support', 'Support'], ['driver', 'Driver'], ['pilot', 'Pilot'], ['career', 'Career (Wardog level)']] },
      { k: 'level', label: 'Level', type: 'number' },
      { k: 'name', label: 'What unlocks' },
      { k: 'kind', label: 'Type', type: 'select', options: [['Weapon', 'Weapon'], ['Attachment', 'Attachment'], ['Ammunition', 'Ammunition'], ['Equipment', 'Equipment'], ['Vehicle', 'Vehicle'], ['Supply', 'Supply'], ['Other', 'Other']] },
      { k: 'cost', label: 'Cost in cash (0 if free / unknown)', type: 'number' },
      { k: 'vendor_price', label: 'In-match buy price', type: 'number' },
    ],
    defaults: { role: 'assault', level: 1, kind: 'Weapon', cost: 0 },
    row: (r) => `<div class="grow"><b>${esc(r.name)}</b> <span class="pill">${esc(r.role)} · level ${r.level}</span> <div class="muted small">${esc(r.kind)}${r.cost ? ` · ${fmtNum(r.cost)}` : ''}</div></div>`,
  },
  artillery: {
    one: 'gun',
    title: 'Artillery firing tables',
    help: 'Used by the Arty map. Each line of the firing table is "distance in metres,elevation in mils". If a game update changes a gun, edit its table here.',
    key: 'id',
    fields: [
      { k: 'id', label: 'Short ID (no spaces)', createOnly: true },
      { k: 'label', label: 'Name shown on the button' },
      { k: 'note', label: 'Small note (e.g. "Over cover")' },
      { k: 'min_m', label: 'Shortest range (m)', type: 'number' },
      { k: 'max_m', label: 'Longest range (m)', type: 'number' },
      { k: 'table_data', label: 'Firing table — one "metres,mils" per line', type: 'textarea' },
      { k: 'sort_order', label: 'Order', type: 'number' },
    ],
    defaults: { sort_order: 100 },
    row: (r) => `<div class="grow"><b>${esc(r.label)}</b> <span class="pill">${esc(r.id)}</span><div class="muted small">${fmtNum(r.min_m)}–${fmtNum(r.max_m)} m · ${String(r.table_data || '').split('\n').filter(Boolean).length} table rows</div></div>`,
  },
  'game-servers': {
    one: 'server',
    title: 'Game servers',
    help: 'Servers shown on the Servers page. Server ID is the long code from the game (or use Find a server below). To control a server from the app, add the RCON address and password from your server host. The password is stored safely and never shown again. Leave the password box empty to keep the saved one.',
    search: true,
    fields: [
      { k: 'join_code', label: 'Server ID (from the game)' },
      { k: 'name', label: 'Display name (optional)' },
      { k: 'description', label: 'Description', type: 'textarea' },
      { k: 'rcon_url', label: 'RCON address — http:// (not https) + IP + port, e.g. http://209.102.251.74:9006' },
      { k: 'rcon_password', label: 'RCON password', type: 'secret' },
      { k: 'enabled', label: 'Show on Servers page', type: 'check' },
      { k: 'sort_order', label: 'Order', type: 'number' },
    ],
    defaults: { enabled: true, sort_order: 10 },
    row: (r) => `<div class="grow"><b>${esc(r.name || r.join_code)}</b> ${r.enabled ? '' : '<span class="pill banned">hidden</span>'} ${r.rcon_url && r.has_rcon_password ? '<span class="pill mod">RCON ready</span>' : '<span class="pill">no RCON</span>'}<div class="muted small" style="overflow-wrap:anywhere">${esc(r.join_code)}</div></div>`,
  },
  channels: {
    one: 'channel',
    title: 'Chat channels',
    help: 'Who can see: Members = everyone, Mods = mods and admins, Admins = admins only.',
    fields: [
      { k: 'name', label: 'Channel name' },
      { k: 'description', label: 'Description' },
      { k: 'min_role', label: 'Who can see it', type: 'select', options: [['member', 'Members'], ['mod', 'Mods'], ['admin', 'Admins']] },
      { k: 'read_only', label: 'Only staff can post', type: 'check' },
      { k: 'sort_order', label: 'Order', type: 'number' },
    ],
    defaults: { min_role: 'member', sort_order: 100 },
    row: (r) => `<div class="grow"><b># ${esc(r.name)}</b> ${r.min_role !== 'member' ? `<span class="pill mod">${esc(r.min_role)}s</span>` : ''} ${r.read_only ? '<span class="pill">read only</span>' : ''}<div class="muted small">${esc(r.description)}</div></div>`,
  },
  games: {
    one: 'game',
    title: 'Tracked Steam games',
    help: 'Steam App ID is the number in the game\'s Steam store link (Wardogs = 1867240). Playtime and achievements from these games earn WPG XP. “Steam stats to show” is one per line: statKey=Label.',
    key: 'app_id',
    fields: [
      { k: 'app_id', label: 'Steam App ID', type: 'number', createOnly: true },
      { k: 'name', label: 'Game name' },
      { k: 'enabled', label: 'Track this game', type: 'check' },
      { k: 'featured', label: 'Featured (shown first)', type: 'check' },
      { k: 'xp_per_hour', label: 'XP per hour played', type: 'number' },
      { k: 'xp_per_achievement', label: 'XP per achievement', type: 'number' },
      { k: 'stat_labels', label: 'Steam stats to show (key=Label per line)', type: 'textarea' },
    ],
    defaults: { enabled: true, xp_per_hour: 10, xp_per_achievement: 25 },
    row: (r) => `<div class="grow"><b>${esc(r.name)}</b> <span class="pill">${r.app_id}</span> ${r.enabled ? '' : '<span class="pill banned">off</span>'}<div class="muted small">${r.xp_per_hour} XP/hour · ${r.xp_per_achievement} XP/achievement</div></div>`,
  },
  'profile-fields': {
    one: 'profile field',
    title: 'Profile fields',
    help: 'Extra boxes members fill in on their profile. “Choice list” shows a drop-down: put the choices in Options, separated by commas.',
    fields: [
      { k: 'label', label: 'Label' },
      { k: 'key', label: 'Key (short, no spaces)' },
      { k: 'type', label: 'Type', type: 'select', options: [['text', 'Free text'], ['select', 'Choice list']] },
      { k: 'options', label: 'Options (comma separated)' },
      { k: 'sort_order', label: 'Order', type: 'number' },
    ],
    defaults: { type: 'text' },
    row: (r) => `<div class="grow"><b>${esc(r.label)}</b> <span class="pill">${esc(r.key)}</span><div class="muted small">${r.type === 'select' ? `Choices: ${esc(r.options)}` : 'Free text'}</div></div>`,
  },
};

export async function viewAdmin(main, [tabParam]) {
  if (!['mod', 'admin'].includes(state.me.role)) {
    main.innerHTML = '<div class="panel empty">Staff only.</div>';
    return;
  }
  const tabs = TABS.filter((t) => t.mod || isAdmin());
  const tab = tabs.find((t) => t.key === (tabParam || '').split('?')[0]) || tabs[0];
  main.innerHTML = `<h1>${icon('shield', 'width="26" height="26" style="vertical-align:-4px;color:var(--accent)"')} Command panel</h1>
    <div class="tabs">${tabs.map((t) => `<a href="#/admin/${t.key}" class="${t.key === tab.key ? 'active' : ''}">${t.label}</a>`).join('')}</div>
    <div id="adminBody"><div class="spinner"></div></div>`;
  const body = document.getElementById('adminBody');
  if (tab.key === 'users') return usersTab(body);
  if (tab.key === 'settings') return settingsTab(body);
  if (tab.key === 'audit') return auditTab(body);
  return resourceTab(body, tab.key);
}

// ---------- Generic editor ----------
async function resourceTab(body, name) {
  const cfg = RESOURCES[name];
  const key = cfg.key || 'id';
  const rows = await api(`admin/${name}`);
  body.innerHTML = `
    <div class="panel">
      <div class="row between"><div class="panel-title" style="margin:0">${esc(cfg.title)}</div><button class="btn primary" id="addBtn">${icon('plus')} Add new</button></div>
      <p class="muted small">${esc(cfg.help)}</p>
      <div class="list">${rows.map((r) => `<div class="item">${cfg.row(r)}<button class="btn small" data-edit="${esc(r[key])}">${icon('edit')} Edit</button></div>`).join('') || '<p class="empty">Nothing here yet.</p>'}</div>
    </div>
    ${cfg.search ? `<div class="panel" style="margin-top:16px">
      <div class="panel-title">Find a server</div>
      <form class="row" id="srvSearch"><input type="search" name="q" class="grow" placeholder="Search live servers by name or ID, e.g. WPG"><button class="btn">Search</button></form>
      <div class="list" id="srvResults"></div>
    </div>` : ''}`;
  const sf = document.getElementById('srvSearch');
  if (sf) bindServerSearch(sf, document.getElementById('srvResults'), rows, () => resourceTab(body, name));
  document.getElementById('addBtn').onclick = () => openEditor(cfg, name, key, null, () => resourceTab(body, name));
  body.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openEditor(cfg, name, key, rows.find((r) => String(r[key]) === b.dataset.edit), () => resourceTab(body, name));
  });
}

// Search the live Wardogs server list and add a result with one click.
function bindServerSearch(form, out, existing, onAdded) {
  form.onsubmit = async (e) => {
    e.preventDefault();
    out.innerHTML = '<div class="spinner" style="margin:10px auto"></div>';
    try {
      const found = await api(`admin/servers/search?q=${encodeURIComponent(form.q.value)}`);
      const have = new Set(existing.map((r) => r.join_code));
      out.innerHTML = found.map((s) => `<div class="item"><div class="grow"><b>${esc(s.name)}</b><div class="muted small">${s.players}/${s.maxPlayers} players · ${esc(s.region)} · ${esc(s.type)}</div></div>
        ${have.has(s.join_code) ? '<span class="pill mod">Added</span>' : `<button class="btn small primary" data-add-srv="${esc(s.join_code)}" data-srv-name="${esc(s.name)}">${icon('plus')} Add</button>`}</div>`).join('') || '<p class="muted">No live servers found. Check the name, or add it by server ID.</p>';
      out.querySelectorAll('[data-add-srv]').forEach((b) => {
        b.onclick = async () => {
          try {
            const row = await api('admin/game-servers', { method: 'POST', body: { join_code: b.dataset.addSrv, name: '', description: '', rcon_url: '', rcon_password: '', enabled: true, sort_order: 10 } });
            toast('Server added', b.dataset.srvName);
            onAdded(row);
          } catch (x) { fail(x); }
        };
      });
    } catch (x) { out.innerHTML = ''; fail(x); }
  };
}

// ---------- Shortcuts used on the Servers page ----------
export async function editGameServer(id, done) {
  const rows = await api('admin/game-servers');
  const row = rows.find((r) => r.id === Number(id));
  if (!row) throw new Error('Server not found.');
  openEditor(RESOURCES['game-servers'], 'game-servers', 'id', row, done);
}

export async function addGameServer(done) {
  const rows = await api('admin/game-servers');
  const m = modal(`
    <div class="row between"><h2 style="margin:0">Add a server</h2><button type="button" class="btn ghost small" data-close>✕</button></div>
    <p class="muted">Search for the server by name (e.g. <b>WPG</b>) or paste its server ID from the game.</p>
    <form class="row" id="addSrvSearch"><input type="search" name="q" class="grow" placeholder="Server name or ID"><button class="btn primary">Search</button></form>
    <div class="list" id="addSrvResults"></div>
    <p class="muted small" style="margin-top:14px">Not in the live list (e.g. it's offline)? <button type="button" class="btn small" id="addSrvManual">Enter details by hand</button></p>`);
  m.el.querySelector('[data-close]').onclick = m.close;
  m.el.querySelector('#addSrvManual').onclick = () => {
    m.close();
    openEditor(RESOURCES['game-servers'], 'game-servers', 'id', null, done);
  };
  bindServerSearch(m.el.querySelector('#addSrvSearch'), m.el.querySelector('#addSrvResults'), rows, (row) => {
    m.close();
    done();
    // Go straight on to the RCON details for the new server.
    openEditor(RESOURCES['game-servers'], 'game-servers', 'id', { ...row, rcon_password: '' }, done);
  });
  m.el.querySelector('#addSrvSearch').q.focus();
}

function fieldHtml(f, v, isNew, data = {}) {
  const id = `f_${f.k}`;
  if (f.createOnly && !isNew) return `<label class="field"><span>${esc(f.label)}</span><input type="text" value="${esc(v)}" disabled></label>`;
  switch (f.type) {
    case 'textarea':
      return `<label class="field" style="grid-column:1/-1"><span>${esc(f.label)}</span><textarea name="${f.k}" id="${id}">${esc(v ?? '')}</textarea></label>`;
    case 'number':
      return `<label class="field"><span>${esc(f.label)}</span><input type="number" step="${f.step || '1'}" name="${f.k}" value="${esc(v ?? 0)}"></label>`;
    case 'check':
      return `<label class="check field" style="grid-column:1/-1"><input type="checkbox" name="${f.k}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
    case 'color':
      return `<label class="field"><span>${esc(f.label)}</span><input type="color" name="${f.k}" value="${esc(v || '#c9a227')}"></label>`;
    case 'secret': {
      const saved = !isNew && data[`has_${f.k}`];
      return `<label class="field"><span>${esc(f.label)}${saved ? ' <span class="pill mod">saved</span>' : ''}</span>
          <input type="password" name="${f.k}" autocomplete="new-password" placeholder="${saved ? 'Leave empty to keep the saved one' : 'Type the password'}"></label>
        ${saved ? `<label class="check"><input type="checkbox" name="clear_${f.k}"> Remove saved password</label>` : ''}`;
    }
    case 'select':
      return `<label class="field"><span>${esc(f.label)}</span><select name="${f.k}">${f.options.map(([o, l]) => `<option value="${o}" ${String(v) === o ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    case 'colors': {
      const list = String(v || '#1f3a93,#ffffff,#b22234').split(',');
      return `<div class="field" style="grid-column:1/-1"><span style="display:block;font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;margin-bottom:5px">${esc(f.label)}</span>
        <div class="row" id="stripeRow">${list.map((c) => `<input type="color" data-stripe value="${esc(c.trim())}">`).join('')}
        <button type="button" class="btn small" id="addStripe">+</button><button type="button" class="btn small ghost" id="rmStripe">−</button>
        <span id="ribbonPreview"></span></div></div>`;
    }
    case 'insignia': {
      const s = typeof v === 'string' ? JSON.parse(v || '{}') : v || {};
      return `<div class="panel" style="grid-column:1/-1;background:#06101c">
        <div class="row" style="align-items:flex-start;gap:20px">
          <div id="insPreview" style="text-align:center"></div>
          <div class="grow form-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">
            ${INSIGNIA_PARTS.map((p) => (p.bool
              ? `<label class="check"><input type="checkbox" data-ins="${p.key}" ${s[p.key] ? 'checked' : ''}> ${esc(p.label)}</label>`
              : `<label class="field"><span>${esc(p.label)}</span><select data-ins="${p.key}">${Array.from({ length: p.max + 1 }, (_, i) => `<option ${Number(s[p.key] || 0) === i ? 'selected' : ''}>${i}</option>`).join('')}</select></label>`)).join('')}
            <label class="field"><span>Metal</span><select data-ins="metal"><option value="gold" ${s.metal !== 'silver' ? 'selected' : ''}>Gold</option><option value="silver" ${s.metal === 'silver' ? 'selected' : ''}>Silver</option></select></label>
          </div>
        </div></div>`;
    }
    default:
      return `<label class="field"><span>${esc(f.label)}</span><input type="text" name="${f.k}" value="${esc(v ?? '')}"></label>`;
  }
}

function openEditor(cfg, name, key, row, done) {
  const isNew = !row;
  const data = row || { ...(cfg.defaults || {}) };
  const m = modal(`
    <form id="edForm" class="stack">
      <div class="row between"><h2 style="margin:0">${isNew ? 'Add' : 'Edit'} ${esc(cfg.one || cfg.title.toLowerCase())}</h2><button type="button" class="btn ghost small" data-close>✕</button></div>
      <div class="form-grid">${cfg.fields.map((f) => fieldHtml(f, data[f.k], isNew, data)).join('')}</div>
      <div class="row between">
        <div class="row"><button class="btn primary">Save</button><button type="button" class="btn ghost" data-close>Cancel</button></div>
        ${isNew ? '' : `<button type="button" class="btn danger" id="delBtn">${icon('trash')} Delete</button>`}
      </div>
    </form>`);
  const form = m.el.querySelector('#edForm');
  m.el.querySelectorAll('[data-close]').forEach((b) => { b.onclick = m.close; });

  const readInsignia = () => {
    const s = {};
    form.querySelectorAll('[data-ins]').forEach((el) => {
      if (el.type === 'checkbox') { if (el.checked) s[el.dataset.ins] = true; } else if (el.dataset.ins === 'metal') s.metal = el.value;
      else if (Number(el.value)) s[el.dataset.ins] = Number(el.value);
    });
    return s;
  };
  const insPrev = form.querySelector('#insPreview');
  const drawIns = () => {
    if (!insPrev) return;
    insPrev.innerHTML = insigniaSVG(readInsignia(), { size: 140, color: form.color?.value, abbr: form.abbr?.value }) + `<div class="muted small">Live preview</div>`;
  };
  const stripes = () => [...form.querySelectorAll('[data-stripe]')].map((i) => i.value).join(',');
  const drawRibbon = () => {
    const p = form.querySelector('#ribbonPreview');
    if (p) p.innerHTML = ribbon(stripes()).replace('class="ribbon"', 'class="ribbon" style="width:110px;height:30px;display:inline-block;vertical-align:middle"');
  };
  form.addEventListener('input', () => { drawIns(); drawRibbon(); });
  form.querySelector('#addStripe')?.addEventListener('click', () => {
    const row2 = form.querySelector('#stripeRow');
    const all = row2.querySelectorAll('[data-stripe]');
    if (all.length >= 7) return;
    all[all.length - 1].insertAdjacentHTML('afterend', '<input type="color" data-stripe value="#ffffff">');
    drawRibbon();
  });
  form.querySelector('#rmStripe')?.addEventListener('click', () => {
    const all = form.querySelectorAll('[data-stripe]');
    if (all.length > 1) all[all.length - 1].remove();
    drawRibbon();
  });
  drawIns();
  drawRibbon();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const out = {};
    for (const f of cfg.fields) {
      if (f.createOnly && !isNew) continue;
      if (f.type === 'insignia') out[f.k] = readInsignia();
      else if (f.type === 'colors') out[f.k] = stripes();
      else if (f.type === 'check') out[f.k] = form[f.k].checked;
      else if (f.type === 'secret') {
        out[f.k] = form[f.k].value;
        if (form[`clear_${f.k}`]?.checked) out[`clear_${f.k}`] = true;
      } else out[f.k] = form[f.k].value;
    }
    try {
      if (isNew) await api(`admin/${name}`, { method: 'POST', body: out });
      else await api(`admin/${name}/${encodeURIComponent(row[key])}`, { method: 'PUT', body: out });
      toast('Saved');
      m.close();
      done();
    } catch (x) { fail(x); }
  };
  m.el.querySelector('#delBtn')?.addEventListener('click', async () => {
    if (!(await confirmBox('Delete this for good? This cannot be undone.'))) return;
    try {
      await api(`admin/${name}/${encodeURIComponent(row[key])}`, { method: 'DELETE' });
      toast('Deleted');
      m.close();
      done();
    } catch (x) { fail(x); }
  });
}

// ---------- Members ----------
async function usersTab(body) {
  const q = query();
  let status = q.get('status') ?? '';
  const [ranks, awards] = await Promise.all([api('ranks'), api('awards')]);
  const pendingCount = (await api('admin/users?status=pending')).length;
  if (!q.has('status') && pendingCount) status = 'pending';

  body.innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <div class="tabs" style="margin:0;padding:0">
          ${[['pending', `Waiting approval${pendingCount ? ` (${pendingCount})` : ''}`], ['active', 'Active'], ['banned', 'Banned'], ['', 'All']].map(([k, l]) => `<a href="#" data-status="${k}" class="${status === k ? 'active' : ''}">${l}</a>`).join('')}
        </div>
        <input type="search" id="usearch" placeholder="Search name / Steam ID" class="grow" style="min-width:180px">
      </div>
      <div class="list" id="ulist"><div class="spinner"></div></div>
    </div>`;
  const list = document.getElementById('ulist');
  const search = document.getElementById('usearch');

  async function load() {
    const users = await api(`admin/users?status=${status}&search=${encodeURIComponent(search.value)}`);
    list.innerHTML = users.map((u) => `
      <div class="item">
        <div class="grow">${userLine(u, `${fmtNum(u.xp)} XP · joined ${timeAgo(u.joined_at)}`)}</div>
        <div class="row">
          ${u.status === 'pending' ? `<button class="btn primary small" data-approve="${u.id}">Approve as member</button><button class="btn small" data-approve="${u.id}" data-pmc="1">Approve as PMC</button><button class="btn danger small" data-deny="${u.id}">Deny</button>` : ''}
          <button class="btn small" data-uedit="${u.id}">${icon('edit')} Edit</button>
        </div>
      </div>`).join('') || '<p class="empty">No members here.</p>';
  }
  body.querySelectorAll('[data-status]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); location.hash = `#/admin/users?status=${a.dataset.status}`; };
  });
  let t;
  search.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  list.onclick = async (e) => {
    const ap = e.target.closest('[data-approve]');
    const dn = e.target.closest('[data-deny]');
    const ed = e.target.closest('[data-uedit]');
    try {
      if (ap) {
        const pmc = !!ap.dataset.pmc;
        await api(`admin/users/${ap.dataset.approve}`, { method: 'PATCH', body: { status: 'active', membership: pmc ? 'pmc' : 'member' } });
        toast('Approved', pmc ? 'Joined as a PMC (guest).' : 'Joined as a WPG member.');
        load();
      }
      if (dn && (await confirmBox('Deny and ban this sign-up?'))) { await api(`admin/users/${dn.dataset.deny}`, { method: 'PATCH', body: { status: 'banned' } }); load(); }
      if (ed) editUser(Number(ed.dataset.uedit), ranks, awards, load);
    } catch (x) { fail(x); }
  };
  await load();
  if (q.get('edit')) editUser(Number(q.get('edit')), ranks, awards, load);
}

async function editUser(id, ranks, awards, reload) {
  const [d, fields, defs] = await Promise.all([api(`admin/users/${id}`), api('profile-fields'), api('stat-defs')]);
  const u = d.user;
  const m = modal(`
    <div class="row between"><div class="grow">${userLine(u)}</div><button class="btn ghost small" data-close>✕</button></div>
    <form id="uform" class="stack" style="margin-top:14px">
      <h3>Rank & access</h3>
      <div class="form-grid">
        <label class="field"><span>Rank</span><select name="rank_id"><option value="">No rank</option>${[...ranks].reverse().map((r) => `<option value="${r.id}" ${u.rank_id === r.id ? 'selected' : ''}>${esc(r.name)} (${esc(r.abbr)})</option>`).join('')}</select></label>
        <label class="field"><span>Member type</span><select name="membership">${[['member', 'WPG member'], ['pmc', 'PMC (guest)']].map(([k, l]) => `<option value="${k}" ${(u.membership || 'member') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Status</span><select name="status">${[['active', 'Active'], ['pending', 'Waiting approval'], ['banned', 'Banned']].map(([k, l]) => `<option value="${k}" ${u.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${isAdmin() ? `<label class="field"><span>Role</span><select name="role">${[['member', 'Member'], ['mod', 'Moderator'], ['admin', 'Admin']].map(([k, l]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
        <label class="field"><span>Bonus XP (+/-)</span><input type="number" name="bonus_xp" value="${u.bonus_xp}"></label>
        <label class="field"><span>Mute for (minutes, 0 = unmute)</span><input type="number" name="mute_minutes" placeholder="${u.muted_until && new Date(u.muted_until) > new Date() ? `Muted until ${new Date(u.muted_until).toLocaleString('en-GB')}` : 'Not muted'}"></label>
        <label class="check" style="grid-column:1/-1"><input type="checkbox" name="rank_locked" ${u.rank_locked ? 'checked' : ''}> Lock rank (no automatic promotions)</label>
      </div>
      <h3>Profile</h3>
      <div class="form-grid">
        <label class="field"><span>Callsign</span><input type="text" name="callsign" value="${esc(u.callsign)}"></label>
        <label class="field"><span>Country</span><select name="country">${COUNTRIES.map(([c, n]) => `<option value="${c}" ${u.country === c ? 'selected' : ''}>${flag(c)} ${n}</option>`).join('')}</select></label>
        ${fields.map((f) => `<label class="field"><span>${esc(f.label)}</span><input type="text" name="cf_${esc(f.key)}" value="${esc(u.custom_fields?.[f.key] || '')}"></label>`).join('')}
        <label class="field" style="grid-column:1/-1"><span>Bio</span><textarea name="bio">${esc(u.bio)}</textarea></label>
      </div>
      <h3>Server stats</h3>
      <p class="muted small">Leave a box empty to clear it. Kills & deaths normally come from the WPG server.</p>
      <div class="form-grid">${defs.map((s) => `<label class="field"><span>${esc(s.label)}${s.format === 'minutes' ? ' (minutes)' : ''}</span><input type="number" step="any" data-stat="${esc(s.key)}" value="${d.stats[s.key] ?? ''}"></label>`).join('')}</div>
      <div class="row"><button class="btn primary">Save changes</button><button type="button" class="btn" id="usync">${icon('refresh')} Sync stats now</button></div>
    </form>
    <div class="stack" style="margin-top:20px">
      <h3>Medals</h3>
      <div class="list">${d.awards.map((a) => `<div class="item"><div class="grow"><b>${esc(a.name)}</b><div class="muted small">${esc(a.reason)} · ${fmtDate(a.given_at)}</div></div><button class="btn ghost small" data-rmaward="${a.id}">Remove</button></div>`).join('') || '<p class="muted">None yet.</p>'}</div>
      <form class="row" id="awardForm">
        <select name="award_id" style="max-width:220px">${awards.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
        <input type="text" name="reason" placeholder="Reason (optional)" class="grow">
        <button class="btn">${icon('medal')} Give medal</button>
      </form>
      ${isAdmin() ? `<div style="border-top:1px solid var(--line);padding-top:14px"><button class="btn danger" id="udel">${icon('trash')} Delete account</button> <span class="muted small">Removes them and all their messages.</span></div>` : ''}
    </div>`);
  const close = () => { m.close(); reload(); };
  m.el.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  const f = m.el.querySelector('#uform');
  const syncRankBox = () => {
    f.rank_id.disabled = f.membership.value === 'pmc';
    f.rank_id.title = f.rank_id.disabled ? 'PMCs (guests) have no rank' : '';
  };
  f.membership.onchange = syncRankBox;
  syncRankBox();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const patch = {
      rank_id: f.rank_id.value ? Number(f.rank_id.value) : null,
      rank_locked: f.rank_locked.checked,
      bonus_xp: Number(f.bonus_xp.value) || 0,
      callsign: f.callsign.value,
      country: f.country.value,
      bio: f.bio.value,
      custom_fields: Object.fromEntries(fields.map((fd) => [fd.key, f[`cf_${fd.key}`].value])),
    };
    if (f.status.value !== u.status) patch.status = f.status.value;
    if (f.membership.value !== (u.membership || 'member')) patch.membership = f.membership.value;
    if (f.role && f.role.value !== u.role) patch.role = f.role.value;
    if (f.mute_minutes.value !== '') patch.mute_minutes = Number(f.mute_minutes.value);
    const stats = {};
    f.querySelectorAll('[data-stat]').forEach((i) => { stats[i.dataset.stat] = i.value; });
    try {
      await api(`admin/users/${u.id}`, { method: 'PATCH', body: patch });
      if (defs.length) await api(`admin/users/${u.id}/stats`, { method: 'PUT', body: stats });
      toast('Saved', `${u.name} updated.`);
      if (u.id === state.me.id) refreshMe();
      close();
    } catch (x) { fail(x); }
  };
  m.el.querySelector('#usync').onclick = async () => {
    try {
      const r = await api(`admin/users/${u.id}/sync`, { method: 'POST', body: {} });
      toast('Sync finished', [r.reason, r.steam?.reason, r.wardogs?.reason].filter(Boolean).join(' · ') || 'Stats updated.');
    } catch (x) { fail(x); }
  };
  m.el.querySelector('#awardForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`admin/users/${u.id}/awards`, { method: 'POST', body: { award_id: Number(e.target.award_id.value), reason: e.target.reason.value } });
      toast('Medal given');
      m.close();
      editUser(id, ranks, awards, reload);
    } catch (x) { fail(x); }
  };
  m.el.querySelectorAll('[data-rmaward]').forEach((b) => {
    b.onclick = async () => {
      await api(`admin/user-awards/${b.dataset.rmaward}`, { method: 'DELETE' }).catch(fail);
      m.close();
      editUser(id, ranks, awards, reload);
    };
  });
  m.el.querySelector('#udel')?.addEventListener('click', async () => {
    if (!(await confirmBox(`Delete ${u.name}'s account for good?`))) return;
    try { await api(`admin/users/${u.id}`, { method: 'DELETE' }); toast('Deleted'); close(); } catch (x) { fail(x); }
  });
}

// ---------- Settings ----------
const SETTINGS = [
  ['General', [
    ['clan_name', 'Clan name'],
    ['clan_tag', 'Clan tag (short)'],
    ['motto', 'Motto'],
    ['welcome_message', 'Welcome message on HQ', 'textarea'],
    ['logo_url', 'Logo picture link (https or /img/…)'],
    ['accent_color', 'Accent colour', 'color'],
    ['discord_invite', 'Discord invite link'],
  ]],
  ['Discord voice', [
    ['discord_voice_enabled', 'Show who is in the Discord voice channels (HQ + Comms)', 'check'],
    ['discord_server_id', 'Discord server ID (optional — found from the invite link if left empty)'],
  ]],
  ['Members', [
    ['require_approval', 'New sign-ups need approval (members only)', 'check'],
    ['dm_friends_only', 'Private messages only between friends', 'check'],
  ]],
  ['Ranks & XP', [
    ['auto_promote', 'Promote members automatically by XP', 'check'],
    ['announce_promotions', 'Post promotions in chat', 'check'],
    ['xp_per_server_kill', 'XP per kill on the WPG server (event ending? press "Sync everyone\'s stats now" below FIRST, then set it back)', 'number'],
    ['xp_event_message', 'XP event banner on the Ranks page (e.g. "Kill XP is 10 this weekend!") — leave empty when no event'],
  ]],
  ['Stats syncing', [
    ['tracker_enabled', 'Get global Wardogs stats (level, cash, classes, world ranks)', 'check'],
    ['sync_minutes', 'Re-sync each member every … minutes (min 15)', 'number'],
  ]],
  ['Discord bot (automatic posts)', [
    ['discord_post_channel', 'Channel ID for posts (in Discord: right-click the channel → Copy Channel ID). Empty = no posts'],
    ['discord_post_promotions', 'Post clan promotions', 'check'],
    ['discord_post_medals', 'Post new medals', 'check'],
    ['discord_post_wpg_ranks', 'Post WPG rank-ups (from the WPG bot)', 'check'],
  ]],
];

// Setup checklist for the Barracks Discord bot. Each step is ticked once it has really worked.
async function discordBotPanel(el) {
  let d;
  try { d = await api('admin/discord-bot'); } catch (x) { el.innerHTML = `<p class="muted small">${esc(x.message)}</p>`; return; }
  const copy = (text) => `<code style="overflow-wrap:anywhere;background:#06101c;border:1px solid var(--line);border-radius:6px;padding:4px 8px">${esc(text)}</code>`;
  const portal = `<a href="https://discord.com/developers/applications/${esc(d.app_id)}/information" target="_blank" rel="noopener">Discord Developer Portal</a>`;
  const step = (done, title, todo) => `<li style="margin-bottom:10px"><b>${done ? '✅' : '⬜'} ${title}</b>${done ? '' : `<div class="small muted" style="margin-top:4px">${todo}</div>`}</li>`;
  const allDone = d.endpoint_checked && d.token && d.in_server && d.commands_ready && d.post_channel;
  el.innerHTML = `<div class="panel-title">${icon('discord')} Barracks Discord bot <span class="sub">${allDone ? '✅ all set' : 'setup'}${d.bot_name ? ` · ${esc(d.bot_name)}` : ''}</span></div>
    ${d.token_problem ? `<p style="color:var(--red);margin:0 0 10px">${esc(d.token_problem)}</p>` : ''}
    <ol style="margin:0 0 6px;padding-left:4px;list-style:none">
      ${step(d.endpoint_checked, 'Discord can reach the app', `${d.token
        ? `The app sets this up by itself once the token is in. Press <b>Re-check &amp; fix Discord setup</b> below to try now.${d.endpoint_on_discord !== null ? `<br>Discord has: ${d.endpoint_on_discord ? copy(d.endpoint_on_discord) : '<b>nothing yet</b>'} — it should be ${copy(d.endpoint_wanted || d.interactions_url)}` : ''}${d.endpoint_problem ? `<br><span style="color:var(--red)">${esc(d.endpoint_problem)}</span>` : ''}`
        : `Happens by itself once the bot token is in Render. (Or by hand: ${portal} → <b>General Information</b> → <b>Interactions Endpoint URL</b> = ${copy(d.interactions_url)} → <b>Save Changes</b>.)`}`)}
      ${step(d.token, 'Bot token added to Render', `In the ${portal} → <b>Bot</b> → <b>Reset Token</b> → copy it. In Render → your app → <b>Environment</b> → add <b>DISCORD_BOT_TOKEN</b> with the token → <b>Save</b>. The app restarts by itself (a few minutes). Never share the token anywhere else.`)}
      ${step(d.in_server, 'Bot added to the WPG Discord', `<a class="btn small" href="${esc(d.invite_url)}" target="_blank" rel="noopener">${icon('discord')} Add the bot to Discord</a>${d.token ? '' : ' (you can do this before or after the token)'}`)}
      ${step(d.commands_ready, 'Commands set up', d.token ? 'This happens by itself within a few minutes, or press <b>Re-check &amp; fix Discord setup</b> below.' : 'Happens by itself once the token is added.')}
      ${step(d.post_channel, 'Channel for automatic posts', 'In Discord, right-click the channel → <b>Copy Channel ID</b> (turn on Developer Mode in Discord settings → Advanced if you can\'t see it). Paste it in <b>Channel ID for posts</b> above, press <b>Save settings</b>, then <b>Send a test post</b>.')}
    </ol>
    <div class="row">
      <button type="button" class="btn" id="dbTest"${d.token && d.post_channel ? '' : ' disabled'}>Send a test post</button>
      <button type="button" class="btn ghost" id="dbReg"${d.token ? '' : ' disabled'}>Re-check &amp; fix Discord setup</button>
    </div>
    <p class="muted small" style="margin:10px 0 0">Commands: /stats /rank /medals /server /progress /leaderboard /live /link /unlink. Members type /link once to connect their Discord.</p>`;
  el.querySelector('#dbTest').onclick = async () => {
    try { await api('admin/discord-bot/test', { method: 'POST', body: {} }); toast('Sent', 'Check the post channel in Discord.'); } catch (x) { fail(x); }
  };
  el.querySelector('#dbReg').onclick = async () => {
    try {
      const r = await api('admin/discord-bot/register', { method: 'POST', body: {} });
      toast('Discord set up', `${r.endpoint_changed ? 'Discord now sends commands to the app. ' : ''}${r.count} commands ready. They can take a minute to appear in Discord.`);
      discordBotPanel(el);
    } catch (x) { fail(x); }
  };
}

async function settingsTab(body) {
  const s = await api('admin/settings');
  const known = new Set(SETTINGS.flatMap(([, list]) => list.map(([k]) => k)));
  const extra = Object.keys(s).filter((k) => !known.has(k));
  const input = ([k, label, type]) => {
    const v = s[k] ?? '';
    if (type === 'check') return `<label class="check" style="grid-column:1/-1"><input type="checkbox" name="${k}" ${v === 'true' ? 'checked' : ''}> ${esc(label)}</label>`;
    if (type === 'textarea') return `<label class="field" style="grid-column:1/-1"><span>${esc(label)}</span><textarea name="${k}">${esc(v)}</textarea></label>`;
    if (type === 'color') return `<label class="field"><span>${esc(label)}</span><input type="color" name="${k}" value="${esc(v || '#29b6f6')}"></label>`;
    return `<label class="field"><span>${esc(label)}</span><input type="${type === 'number' ? 'number' : 'text'}" name="${k}" value="${esc(v)}"></label>`;
  };
  body.innerHTML = `
    <form id="sform" class="stack">
      ${SETTINGS.map(([title, list]) => `<div class="panel"><div class="panel-title">${esc(title)}</div><div class="form-grid">${list.map(input).join('')}</div></div>`).join('')}
      ${extra.length ? `<div class="panel"><div class="panel-title">Other</div><div class="form-grid">${extra.map((k) => input([k, k])).join('')}</div></div>` : ''}
      <div class="row"><button class="btn primary">Save settings</button><button type="button" class="btn" id="syncAll">${icon('refresh')} Sync everyone's stats now (Steam + Wardogs + medals)</button></div>
    </form>
    <div class="panel" id="discordBot" style="margin-top:16px"><div class="spinner"></div></div>`;
  discordBotPanel(document.getElementById('discordBot'));
  const form = document.getElementById('sform');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      out[el.name] = el.type === 'checkbox' ? String(el.checked) : el.value;
    }
    try {
      await api('admin/settings', { method: 'PUT', body: out });
      toast('Settings saved', 'Reloading to apply.');
      setTimeout(() => location.reload(), 800);
    } catch (x) { fail(x); }
  };
  document.getElementById('syncAll').onclick = async () => {
    try {
      const r = await api('admin/sync-all', { method: 'POST', body: {} });
      toast('Sync started', `Updating ${r.queued} members (about ${Math.max(1, Math.ceil((r.queued * 4) / 60))} min). You'll get a message with the results when it's done.`);
    } catch (x) { fail(x); }
  };
}

// ---------- Audit ----------
async function auditTab(body) {
  const rows = await api('admin/audit');
  body.innerHTML = `<div class="panel"><div class="panel-title">Audit log <span class="sub">last 200 actions</span></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="small">${timeAgo(r.created_at)}</td><td>${esc(r.actor || '—')}</td><td><span class="pill">${esc(r.action)}</span></td><td>${esc(r.target)}</td>
      <td class="small muted" style="max-width:320px;overflow-wrap:anywhere">${esc(JSON.stringify(r.details)).slice(0, 200)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
