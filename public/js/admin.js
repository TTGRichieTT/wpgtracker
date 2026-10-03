import { api, esc, state, toast, fail, modal, confirmBox, promptBox, userLine, fmtNum, fmtDate, timeAgo, query, ribbon, COUNTRIES, flag, refreshMe } from './app.js';
import { icon } from './icons.js';
import { insigniaSVG, rankBadge, INSIGNIA_PARTS } from './insignia.js';

const isAdmin = () => state.me.role === 'admin';

// Grouped in the section drop-down; Members stays first (the default section).
const TABS = [
  { key: 'users', label: 'Members', mod: true, group: 'People' },
  { key: 'announcements', label: 'News', mod: true, group: 'People' },
  { key: 'recruitment', label: 'Recruitment', mod: true, group: 'People' },
  { key: 'units', label: 'Units', group: 'People' },
  { key: 'cheatwatch', label: 'Cheat watch', mod: true, group: 'People' },
  { key: 'streams', label: 'Streams', mod: true, group: 'People' },
  { key: 'ranks', label: 'Ranks', group: 'Game' },
  { key: 'awards', label: 'Medals', group: 'Game' },
  { key: 'stat-defs', label: 'Stats', group: 'Game' },
  { key: 'game-servers', label: 'Game servers', group: 'Game' },
  { key: 'games', label: 'Games', group: 'Game' },
  { key: 'unlocks', label: 'Unlocks', group: 'Game' },
  { key: 'artillery', label: 'Artillery', group: 'Game' },
  { key: 'wpgxp', label: 'WPG XP', group: 'Game' },
  { key: 'settings', label: 'Settings', group: 'App' },
  { key: 'channels', label: 'Chat channels', group: 'App' },
  { key: 'profile-fields', label: 'Profile fields', group: 'App' },
  { key: 'cleanup', label: 'Clean up', group: 'App' },
  { key: 'audit', label: 'Audit log', mod: true, group: 'App' },
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
      { k: 'wpg_xp', label: 'Matches here earn WPG XP (needs RCON)', type: 'check' },
      { k: 'sort_order', label: 'Order', type: 'number' },
    ],
    defaults: { enabled: true, sort_order: 10 },
    row: (r) => `<div class="grow"><b>${esc(r.name || r.join_code)}</b> ${r.enabled ? '' : '<span class="pill banned">hidden</span>'} ${r.rcon_url && r.has_rcon_password ? '<span class="pill mod">RCON ready</span>' : '<span class="pill">no RCON</span>'} ${r.wpg_xp ? '<span class="pill">WPG XP</span>' : ''}<div class="muted small" style="overflow-wrap:anywhere">${esc(r.join_code)}</div></div>`,
  },
  channels: {
    one: 'channel',
    title: 'Chat channels',
    help: 'Who can see: Members = WPG members (plus PMC guests if “PMCs can see it” is ticked), Mods = mods and admins, Admins = admins only.',
    fields: [
      { k: 'name', label: 'Channel name' },
      { k: 'description', label: 'Description' },
      { k: 'min_role', label: 'Who can see it', type: 'select', options: [['member', 'Members'], ['mod', 'Mods'], ['admin', 'Admins']] },
      { k: 'pmc_access', label: 'PMCs (guests) can see it', type: 'check' },
      { k: 'read_only', label: 'Only staff can post', type: 'check' },
      { k: 'sort_order', label: 'Order', type: 'number' },
    ],
    defaults: { min_role: 'member', sort_order: 100 },
    row: (r) => `<div class="grow"><b># ${esc(r.name)}</b> ${r.min_role !== 'member' ? `<span class="pill mod">${esc(r.min_role)}s</span>` : ''} ${r.pmc_access && r.min_role === 'member' ? '<span class="pill pmc">PMCs too</span>' : ''} ${r.read_only ? '<span class="pill">read only</span>' : ''}<div class="muted small">${esc(r.description)}</div></div>`,
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
    <label class="field admin-section"><span>Section</span><select id="adminSection">${[...new Set(tabs.map((t) => t.group))].map((g) => `<optgroup label="${g}">${
      tabs.filter((t) => t.group === g).map((t) => `<option value="${t.key}" ${t.key === tab.key ? 'selected' : ''}>${t.label}</option>`).join('')}</optgroup>`).join('')}</select></label>
    <div id="adminBody"><div class="spinner"></div></div>`;
  document.getElementById('adminSection').onchange = (e) => { location.hash = `#/admin/${e.target.value}`; };
  const body = document.getElementById('adminBody');
  if (tab.key === 'users') return usersTab(body);
  if (tab.key === 'settings') return settingsTab(body);
  if (tab.key === 'audit') return auditTab(body);
  if (tab.key === 'cleanup') return cleanupTab(body);
  if (tab.key === 'cheatwatch') return cheatTab(body);
  if (tab.key === 'recruitment') return (await import('./combat.js')).recruitmentTab(body);
  if (tab.key === 'units') return (await import('./combat.js')).unitsTab(body);
  if (tab.key === 'streams') return (await import('./streams.js')).streamsAdminTab(body);
  if (tab.key === 'wpgxp') return (await import('./wpgxp.js')).wpgXpAdminTab(body);
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
    ['require_approval', 'New sign-ups need approval (when off, they join as PMC guests)', 'check'],
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
    ['discord_post_wpg_ranks', 'Post WPG rank-ups', 'check'],
  ]],
  ['Streams', [
    ['discord_stream_channel', 'Discord channel ID for "… is live" posts (right-click the channel → Copy Channel ID). Empty = no posts'],
    ['discord_post_streams', 'Post in Discord when an approved streamer goes live', 'check'],
  ]],
  ['Cheat watch (staff only)', [
    ['discord_staff_channel', 'Staff-only Discord channel ID for cheat alerts and reports (keep this channel private!). Empty = app alerts only'],
    ['cheat_alerts', 'Send cheat-watch alerts (flagged player joins, live kill spikes, new reports)', 'check'],
    ['cheat_live_kills', 'Live spike alert: kills in 5 minutes', 'number'],
  ]],
];

// Setup checklist for the Barracks Discord bot. Each step is ticked once it has really worked.
async function discordBotPanel(el) {
  let d;
  try { d = await api('admin/discord-bot'); } catch (x) { el.innerHTML = `<p class="muted small">${esc(x.message)}</p>`; return; }
  const copy = (text) => `<code style="overflow-wrap:anywhere;background:#06101c;border:1px solid var(--line);border-radius:6px;padding:4px 8px">${esc(text)}</code>`;
  const portal = `<a href="https://discord.com/developers/applications/${esc(d.app_id)}/information" target="_blank" rel="noopener">Discord Developer Portal</a>`;
  const step = (done, title, todo) => `<li style="margin-bottom:10px"><b>${done ? '✅' : '⬜'} ${title}</b>${done ? '' : `<div class="small muted" style="margin-top:4px">${todo}</div>`}</li>`;
  // Commands the app has that Discord doesn't (yet).
  const missing = Array.isArray(d.commands_on_discord) ? (d.commands_wanted || []).filter((c) => !d.commands_on_discord.includes(c)) : [];
  const commandsOk = d.commands_ready && !missing.length;
  const allDone = d.endpoint_checked && d.token && d.in_server && commandsOk && d.post_channel;
  const when = (iso) => { try { return timeAgo(iso); } catch { return ''; } };
  el.innerHTML = `<div class="panel-title">${icon('discord')} Barracks Discord bot <span class="sub">${allDone ? '✅ all set' : 'setup'}${d.bot_name ? ` · ${esc(d.bot_name)}` : ''}</span></div>
    ${d.token_problem ? `<p style="color:var(--red);margin:0 0 10px">${esc(d.token_problem)}</p>` : ''}
    <ol style="margin:0 0 6px;padding-left:4px;list-style:none">
      ${step(d.endpoint_checked, 'Discord can reach the app', `${d.token
        ? `The app sets this up by itself once the token is in. Press <b>Re-check &amp; fix Discord setup</b> below to try now.${d.endpoint_on_discord !== null ? `<br>Discord has: ${d.endpoint_on_discord ? copy(d.endpoint_on_discord) : '<b>nothing yet</b>'} — it should be ${copy(d.endpoint_wanted || d.interactions_url)}` : ''}${d.endpoint_problem ? `<br><span style="color:var(--red)">${esc(d.endpoint_problem)}</span>` : ''}`
        : `Happens by itself once the bot token is in Render. (Or by hand: ${portal} → <b>General Information</b> → <b>Interactions Endpoint URL</b> = ${copy(d.interactions_url)} → <b>Save Changes</b>.)`}`)}
      ${step(d.token, 'Bot token added to Render', `In the ${portal} → <b>Bot</b> → <b>Reset Token</b> → copy it. In Render → your app → <b>Environment</b> → add <b>DISCORD_BOT_TOKEN</b> with the token → <b>Save</b>. The app restarts by itself (a few minutes). Never share the token anywhere else.`)}
      ${step(d.in_server, 'Bot added to the WPG Discord', `<a class="btn small" href="${esc(d.invite_url)}" target="_blank" rel="noopener">${icon('discord')} Add the bot to Discord</a>${d.token ? '' : ' (you can do this before or after the token)'}`)}
      ${step(commandsOk, 'Commands set up', d.token
        ? `${missing.length ? `<span style="color:var(--red)">Discord is missing: ${missing.map((c) => `/${esc(c)}`).join(' ')}</span><br>` : ''}This happens by itself within a few minutes, or press <b>Re-check &amp; fix Discord setup</b> below.`
        : 'Happens by itself once the token is added.')}
      ${Array.isArray(d.commands_on_discord) && commandsOk ? `<li class="small muted" style="margin:-6px 0 10px 26px">Discord has: ${d.commands_on_discord.map((c) => `/${esc(c)}`).join(' ')}. New commands can take a minute to show — restart Discord (Ctrl+R) if one is missing from the list.</li>` : ''}
      ${step(d.post_channel, 'Channel for automatic posts', 'In Discord, right-click the channel → <b>Copy Channel ID</b> (turn on Developer Mode in Discord settings → Advanced if you can\'t see it). Paste it in <b>Channel ID for posts</b> above, press <b>Save settings</b>, then <b>Send a test post</b>.')}
    </ol>
    <div class="row">
      <button type="button" class="btn" id="dbTest"${d.token && d.post_channel ? '' : ' disabled'}>Send a test post</button>
      <button type="button" class="btn ghost" id="dbReg"${d.token ? '' : ' disabled'}>Re-check &amp; fix Discord setup</button>
    </div>
    <p class="muted small" style="margin:10px 0 0">Commands: /stats /rank /medals /server /progress /leaderboard /serverboard /live /report /link /unlink. Members type /link once to connect their Discord.</p>
    <div style="border-top:1px solid var(--line);margin-top:14px;padding-top:12px">
      <b>Preview a card</b> <span class="muted small">— made here exactly as the bot makes it, without Discord.</span>
      <div class="row" style="margin-top:8px">
        <select id="dbCmd">${(d.commands_wanted || []).filter((c) => !['link', 'unlink', 'report'].includes(c)).map((c) => `<option value="${esc(c)}">/${esc(c)}</option>`).join('')}
          <optgroup label="Channel posts"><option value="post:promotion">Promotion post</option><option value="post:medal">Medal post</option><option value="post:wpgrank">WPG rank-up post</option></optgroup></select>
        <button type="button" class="btn" id="dbPreview">Preview</button>
      </div>
      <div id="dbPreviewOut" style="margin-top:10px"></div>
    </div>
    ${d.recent?.length ? `<div style="margin-top:12px"><b>Recent commands</b><div class="small muted">${d.recent.map((r) => `${esc(r.name)} — ${esc(r.how)} · ${esc(when(r.at))}`).join('<br>')}</div></div>` : ''}
    ${d.problems?.length ? `<div style="margin-top:12px"><b style="color:var(--red)">Recent problems</b><div class="small">${d.problems.map((p) => `<div style="margin-top:4px"><b>${esc(p.where)}</b> · <span class="muted">${esc(when(p.at))}</span><br><span class="muted">${esc(p.message)}</span></div>`).join('')}</div></div>` : ''}`;
  el.querySelector('#dbPreview').onclick = async () => {
    const out = el.querySelector('#dbPreviewOut');
    const btn = el.querySelector('#dbPreview');
    btn.disabled = true;
    out.innerHTML = '<div class="spinner" style="margin:6px 0"></div>';
    try {
      const res = await fetch('/api/admin/discord-bot/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: el.querySelector('#dbCmd').value }),
      });
      if ((res.headers.get('content-type') || '').startsWith('image/')) {
        // The page only allows data: pictures, so turn the picture into one.
        const blob = await res.blob();
        const url = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
        out.innerHTML = `<img src="${url}" alt="Card preview" style="max-width:100%;border-radius:8px;border:1px solid var(--line)">`;
      } else {
        const j = await res.json().catch(() => ({}));
        out.innerHTML = `<p class="small" style="margin:0">${esc(j.text || j.error || `Preview failed (${res.status})`)}</p>${j.problem ? `<p class="small" style="color:var(--red);margin:6px 0 0">${esc(j.problem.where)}: ${esc(j.problem.message)}</p>` : ''}`;
      }
    } catch (x) {
      out.innerHTML = `<p class="small" style="color:var(--red);margin:0">${esc(x.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  };
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
  // Settings with their own page aren't repeated here (saving them from a one-line box would lose their line breaks).
  const ELSEWHERE = new Set(['combat_specialties', 'discord_recruit_channel']); // Admin → Recruitment
  const extra = Object.keys(s).filter((k) => !known.has(k) && !ELSEWHERE.has(k) && !k.startsWith('wpgxp_')); // WPG XP amounts: Admin → WPG XP
  const input = ([k, label, type]) => {
    const v = s[k] ?? '';
    if (type === 'check') return `<label class="check" style="grid-column:1/-1"><input type="checkbox" name="${k}" ${v === 'true' ? 'checked' : ''}> ${esc(label)}</label>`;
    if (type === 'textarea' || String(v).includes('\n')) return `<label class="field" style="grid-column:1/-1"><span>${esc(label)}</span><textarea name="${k}">${esc(v)}</textarea></label>`;
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

// ---------- Cheat watch (staff) ----------
// Signs for staff to check — never automatic bans. Flags come from Steam ban records, kill rate, K/D,
// single-match spikes, headshots / long kills (once the kill feed is connected) and member reports.
const SEVERITY = {
  high: ['High', '#e05252'], medium: ['Medium', '#f5a524'], watch: ['Watch list', '#33d1ff'], low: ['Low', '#8a9bb0'], '': ['Cleared', '#4ade80'],
};
const sevPill = (s, status) => {
  const [label, c] = status === 'cleared' ? SEVERITY[''] : SEVERITY[s] || SEVERITY.low;
  return `<span class="pill" style="color:${c};border-color:${c}">${label}</span>`;
};
const hrs = (s) => `${Math.floor((Number(s) || 0) / 3600)}h ${Math.floor(((Number(s) || 0) % 3600) / 60)}m`;

async function cheatTab(body, { showLow = false } = {}) {
  let d;
  try { d = await api('admin/cheat'); } catch (x) { body.innerHTML = `<div class="panel"><p style="color:var(--red)">${esc(x.message)}</p></div>`; return; }
  const flags = d.flags.filter((f) => showLow || !['low', ''].includes(f.severity) || f.status === 'watch');
  const count = (s) => d.flags.filter((f) => f.severity === s).length;
  const open = d.reports.filter((r) => r.status === 'open');
  const feed = d.feed || {};
  body.innerHTML = `
    <div class="stack">
      <div class="panel">
        <div class="panel-title">${icon('shield')} Cheat watch <span class="sub">signs for staff to check — never automatic bans</span></div>
        <div class="row" style="gap:8px;margin-bottom:10px">
          ${sevPill('high')} <b>${count('high')}</b> ${sevPill('medium')} <b>${count('medium')}</b> ${sevPill('watch')} <b>${count('watch')}</b> ${sevPill('low')} <b>${count('low')}</b>
          <span class="muted">·</span> <b>${open.length}</b> open report${open.length === 1 ? '' : 's'}
          <span class="muted small">· ${fmtNum(d.players)} players on record</span>
        </div>
        <p class="muted small" style="margin:0 0 6px">Normal on the WPG server: <b>${d.norms.kpm.toFixed(2)}</b> kills a minute and a K/D of <b>${d.norms.kd.toFixed(2)}</b> (middle player). Flags mean "far above that" — good players can trip them too, so look before acting.</p>
        <p class="small" style="margin:0 0 6px">Steam ban checks: ${d.checks.steam_key ? `<b>${fmtNum(d.checks.n)}</b> players checked${d.checks.last ? ` (last ${esc(timeAgo(d.checks.last))})` : ''} — every player is re-checked daily.` : '<span style="color:#f5a524">needs the Steam API key in Render (STEAM_API_KEY)</span>'}
          ${d.can_admin && d.checks.steam_key ? '<button class="btn small ghost" id="cwCheck">Check now</button>' : ''}</p>
        <p class="small" style="margin:0">Kill feed (headshots, distances, weapons): ${feed.n ? `<b>${fmtNum(feed.n)}</b> kills received, last ${esc(timeAgo(feed.last))}${!feed.read_ok ? ' — <span style="color:var(--red)">the format isn&#39;t understood yet (send the sample below to the app&#39;s developer)</span>' : ''}`
          : feed.connected ? 'connected — waiting for the game server to restart and send its first kills' : 'not connected yet'}
          ${d.can_admin ? `<button class="btn small ghost" id="cwFeed">${feed.connected ? 'Reconnect kill feed' : 'Connect kill feed'}</button>` : ''}</p>
        ${feed.sample ? `<details style="margin-top:6px"><summary class="small muted">Latest kill as the game server sent it</summary><pre class="small" style="white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0">${esc(JSON.stringify(feed.sample, null, 1).slice(0, 2000))}</pre></details>` : ''}
        ${feed.rejected?.length ? `<details style="margin-top:6px"><summary class="small" style="color:var(--red)">${feed.rejected.length} kill-feed message(s) refused (wrong token)</summary><pre class="small" style="white-space:pre-wrap;margin:6px 0 0">${esc(JSON.stringify(feed.rejected, null, 1).slice(0, 2000))}</pre></details>` : ''}
      </div>

      <div class="panel">
        <div class="row between" style="margin-bottom:8px">
          <div class="panel-title" style="margin:0">Flagged players <span class="sub">${flags.length}</span></div>
          <label class="check small"><input type="checkbox" id="cwLow" ${showLow ? 'checked' : ''}> Show low &amp; cleared</label>
        </div>
        ${flags.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Player</th><th>Flag</th><th>Why</th><th>Kills/min</th><th>K/D</th><th>Kills</th><th>Played</th><th>Last seen</th><th></th></tr></thead>
          <tbody>${flags.map((f) => `<tr>
            <td><b>${esc(f.name)}</b>${f.member_id ? ' <span class="pill">Member</span>' : ''}</td>
            <td>${sevPill(f.severity, f.status)}</td>
            <td class="small" style="max-width:380px">${f.reasons.slice(0, 2).map(esc).join('<br>')}${f.reasons.length > 2 ? `<br><span class="muted">+${f.reasons.length - 2} more</span>` : ''}${!f.reasons.length && f.status === 'watch' ? '<span class="muted">On the watch list</span>' : ''}</td>
            <td>${f.kpm ?? '—'}</td><td>${f.kd}</td><td>${fmtNum(f.kills)}</td><td>${hrs(f.playtime)}</td>
            <td class="small muted">${f.last_seen ? esc(timeAgo(f.last_seen)) : '—'}</td>
            <td><button class="btn small" data-cw="${esc(f.steam_id)}">Open</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nobody flagged right now. 👍</p>'}
      </div>

      <div class="panel">
        <div class="panel-title">Reports <span class="sub">from members (app and Discord /report)</span></div>
        ${d.reports.length ? d.reports.map((r) => `
          <div style="padding:10px 0;border-bottom:1px solid var(--line)">
            <div class="row between">
              <div><b>${esc(r.name || 'Unknown player')}</b> <span class="muted small">reported by ${esc(r.reporter_name || 'a member')} · ${r.source === 'discord' ? 'Discord' : 'app'} · ${esc(timeAgo(r.created_at))}</span></div>
              <div class="row" style="gap:6px">
                ${r.steam_id ? `<button class="btn small ghost" data-cw="${esc(r.steam_id)}">Open player</button>` : '<span class="muted small">no match on our server</span>'}
                ${r.status === 'open' ? `<button class="btn small" data-close="${r.id}">Close</button>` : `<span class="pill">Closed${r.closed_by_name ? ` by ${esc(r.closed_by_name)}` : ''}</span>`}
                <button class="btn small ghost" data-delrep="${r.id}" title="Delete report">${icon('trash')}</button>
              </div>
            </div>
            <div style="white-space:pre-wrap;margin-top:4px">${esc(r.reason)}</div>
          </div>`).join('') : '<p class="muted">No reports yet.</p>'}
      </div>
    </div>`;
  body.querySelector('#cwLow').onchange = (e) => cheatTab(body, { showLow: e.target.checked });
  body.querySelectorAll('[data-delrep]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmBox('Delete this report? This can’t be undone.'))) return;
      try { await api(`admin/cheat/reports/${b.dataset.delrep}`, { method: 'DELETE' }); cheatTab(body, { showLow }); } catch (x) { fail(x); }
    };
  });
  body.querySelectorAll('[data-cw]').forEach((b) => { b.onclick = () => cheatPlayer(b.dataset.cw, () => cheatTab(body, { showLow })); });
  body.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = async () => {
      const note = await promptBox('Close this report?', 'What you found (optional)', { okLabel: 'Close report' });
      if (note === null) return;
      try { await api(`admin/cheat/reports/${b.dataset.close}/close`, { method: 'POST', body: { note } }); cheatTab(body, { showLow }); } catch (x) { fail(x); }
    };
  });
  body.querySelector('#cwCheck')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { const r = await api('admin/cheat/check-now', { method: 'POST', body: {} }); toast('Steam checks done', `${fmtNum(r.checked)} players checked.`); cheatTab(body, { showLow }); } catch (x) { fail(x); e.target.disabled = false; }
  });
  body.querySelector('#cwFeed')?.addEventListener('click', async () => {
    if (!(await confirmBox('Point the WPG game server’s kill feed at this app? Only the kill-feed setting is changed. It starts working after the game server’s next restart.'))) return;
    try { await api('admin/cheat/killfeed/connect', { method: 'POST', body: {} }); toast('Kill feed connected', 'Kills will start arriving after the game server next restarts.'); cheatTab(body, { showLow }); } catch (x) { fail(x); }
  });
}

async function cheatPlayer(steamId, onChange) {
  const m = modal('<div class="spinner" style="margin:20px auto"></div>');
  let p;
  try { p = await api(`admin/cheat/player/${encodeURIComponent(steamId)}`); } catch (x) { m.close(); fail(x); return; }
  const s = p.stats || {};
  const kd = (Number(s.kills || 0) / Math.max(1, Number(s.deaths || 0))).toFixed(2);
  const kpm = s.playtime >= 600 ? (s.kills / (s.playtime / 60)).toFixed(2) : '—';
  const c = p.check;
  const age = c?.account_created ? Math.floor((Date.now() - new Date(c.account_created).getTime()) / 86400000) : null;
  const f = p.feed || {};
  const tile = (label, val) => `<div style="padding:10px;background:rgba(255,255,255,.04);border-radius:8px"><div class="muted small">${label}</div><b style="font-size:18px">${val}</b></div>`;
  m.el.innerHTML = `
    <div class="row between"><h2 style="margin:0">${esc(p.name)} ${p.flag ? sevPill(p.flag.severity, p.status) : p.status === 'cleared' ? sevPill('', 'cleared') : ''}</h2><button type="button" class="btn ghost small" data-close>✕</button></div>
    ${p.member ? `<p class="small muted" style="margin:4px 0 0">Barracks member: <a href="#/u/${p.member.id}">${esc(p.member.name)}</a></p>` : ''}
    ${p.flag?.reasons?.length ? `<ul style="margin:10px 0">${p.flag.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '<p class="muted">No warning signs right now.</p>'}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin:10px 0">
      ${tile('Kills', fmtNum(s.kills))}${tile('Deaths', fmtNum(s.deaths))}${tile('K/D', kd)}${tile('Kills/min', kpm)}
      ${tile('Matches', fmtNum(s.matches))}${tile('Wins / losses', `${fmtNum(s.wins)} / ${fmtNum(s.losses)}`)}${tile('Played', hrs(s.playtime))}${tile('Last seen', s.last_seen ? esc(timeAgo(s.last_seen)) : '—')}
    </div>
    <p class="small" style="margin:6px 0">Steam: ${c ? `${c.vac_bans || c.game_bans ? `<b style="color:var(--red)">${c.vac_bans} VAC + ${c.game_bans} game ban(s), last ${fmtNum(c.days_since_last_ban)} days ago</b>` : 'no VAC or game bans'}${c.community_banned ? ' · community banned' : ''}${age !== null ? ` · account ${fmtNum(age)} days old` : ''}` : '<span class="muted">not checked yet</span>'}</p>
    <p class="small" style="margin:6px 0">Kill feed: ${f.kills ? `${fmtNum(f.kills)} kills recorded${f.hs_known ? ` · ${Math.round((f.hs / f.hs_known) * 100)}% headshots` : ''}${f.max_dist ? ` · longest ${Math.round(f.max_dist)} m` : ''}${f.weapons?.length ? ` · weapons: ${f.weapons.map(esc).join(', ')}` : ''}` : '<span class="muted">no kill details yet</span>'}</p>
    ${p.matches.length ? `<details open><summary><b>Recent matches</b> <span class="muted small">(our tracker)</span></summary><div class="table-wrap"><table class="small"><thead><tr><th>When</th><th>Kills</th><th>Deaths</th><th>Minutes</th><th>Kills/min</th><th>Result</th></tr></thead><tbody>
      ${p.matches.map((x) => `<tr><td>${esc(timeAgo(x.ended_at))}</td><td>${x.kills}</td><td>${x.deaths}</td><td>${Math.round(x.seconds / 60)}</td><td>${(x.kills / Math.max(1, x.seconds / 60)).toFixed(2)}</td><td>${x.won === null ? '—' : x.won ? 'Win' : 'Loss'}</td></tr>`).join('')}
    </tbody></table></div></details>` : ''}
    ${p.sessions.length ? `<details ${p.matches.length ? '' : 'open'}><summary><b>Play sessions</b> <span class="muted small">(WarCon history)</span></summary><div class="table-wrap"><table class="small"><thead><tr><th>Joined</th><th>Kills</th><th>Deaths</th><th>Minutes</th><th>Kills/min</th></tr></thead><tbody>
      ${p.sessions.map((x) => `<tr><td>${x.joined_at ? esc(timeAgo(x.joined_at)) : '—'}</td><td>${x.kills}</td><td>${x.deaths}</td><td>${Math.round((x.secs || 0) / 60)}</td><td>${(x.kills / Math.max(1, (x.secs || 0) / 60)).toFixed(2)}</td></tr>`).join('')}
    </tbody></table></div></details>` : ''}
    ${p.reports.length ? `<details><summary><b>Reports</b> (${p.reports.length})</summary>${p.reports.map((r) => `<p class="small" style="margin:6px 0"><b>${esc(r.reporter_name || 'a member')}</b> · ${esc(timeAgo(r.created_at))} · ${esc(r.status)}<br>${esc(r.reason)}</p>`).join('')}</details>` : ''}
    <div style="margin-top:10px"><b>Staff notes</b>
      ${p.notes.length ? p.notes.map((n) => `<p class="small" style="margin:6px 0"><b>${esc(n.author || 'staff')}</b> · <span class="muted">${esc(timeAgo(n.created_at))}</span>${n.author_id === state.me.id || isAdmin() ? ` <button type="button" class="btn small ghost" data-delnote="${n.id}" title="Delete note" style="padding:0 6px">${icon('trash')}</button>` : ''}<br>${esc(n.text)}</p>`).join('') : '<p class="small muted">No notes yet.</p>'}
      <form class="row" id="cwNote" style="margin-top:6px"><input type="text" name="text" maxlength="1000" placeholder="Add a note (what you checked, clips, decisions)" class="grow"><button class="btn small">Add</button></form>
    </div>
    <div class="row" style="margin-top:14px;gap:6px">
      <button class="btn small" data-st="watch"${p.status === 'watch' ? ' disabled' : ''}>Watch list</button>
      <button class="btn small" data-st="cleared"${p.status === 'cleared' ? ' disabled' : ''}>Checked &amp; cleared</button>
      ${p.status ? '<button class="btn small ghost" data-st="">Remove status</button>' : ''}
      ${p.can_admin && p.server_id ? '<span class="grow"></span><button class="btn small" data-act="kick">Kick (if on now)</button><button class="btn small danger" data-act="ban">Ban</button>' : ''}
    </div>`;
  const reload = () => { m.close(); cheatPlayer(steamId, onChange); onChange?.(); };
  m.el.querySelector('[data-close]').onclick = () => { m.close(); onChange?.(); };
  m.el.querySelectorAll('[data-delnote]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmBox('Delete this note?'))) return;
      try { await api(`admin/cheat/notes/${b.dataset.delnote}`, { method: 'DELETE' }); reload(); } catch (x) { fail(x); }
    };
  });
  m.el.querySelector('#cwNote').onsubmit = async (e) => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (!text) return;
    try { await api(`admin/cheat/player/${encodeURIComponent(steamId)}/notes`, { method: 'POST', body: { text } }); reload(); } catch (x) { fail(x); }
  };
  m.el.querySelectorAll('[data-st]').forEach((b) => {
    b.onclick = async () => {
      try { await api(`admin/cheat/player/${encodeURIComponent(steamId)}/status`, { method: 'POST', body: { status: b.dataset.st } }); reload(); } catch (x) { fail(x); }
    };
  });
  m.el.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const action = b.dataset.act;
      const reason = await promptBox(`${action === 'ban' ? 'Ban' : 'Kick'} ${p.name}?`, 'Reason (shown to them)', { danger: action === 'ban', okLabel: action === 'ban' ? 'Ban' : 'Kick' });
      if (reason === null) return;
      try {
        await api(`admin/servers/${p.server_id}/action`, { method: 'POST', body: { action, steamId, reason } });
        await api(`admin/cheat/player/${encodeURIComponent(steamId)}/notes`, { method: 'POST', body: { text: `${action === 'ban' ? 'Banned' : 'Kicked'}${reason ? `: ${reason}` : ''}` } });
        toast('Done', `${p.name} was ${action === 'ban' ? 'banned' : 'kicked'}.`);
        reload();
      } catch (x) { fail(x); }
    };
  });
}

// ---------- Clean up (admins) ----------
// Delete old items by hand, or set them to delete themselves after a number of days.
const AGES = [[7, '1 week'], [30, '1 month'], [90, '3 months'], [180, '6 months'], [365, '1 year'], [730, '2 years']];
const sizeText = (b) => (b === null || b === undefined ? '' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
async function cleanupTab(body) {
  const d = await api('admin/cleanup');
  const ageOpts = (min, sel) => AGES.filter(([n]) => n >= min).map(([n, l]) => `<option value="${n}"${n === sel ? ' selected' : ''}>${l}</option>`).join('');
  body.innerHTML = `<div class="stack">
    <div class="panel"><div class="panel-title">${icon('trash')} Clean up <span class="sub">delete old items</span></div>
      <p class="muted small" style="margin:0">Pick an age, check how many items it would delete, then delete them. Or set <b>Auto-delete</b> and the app does it by itself once a day.
        Open reports, new applications, waiting requests and pinned news are never deleted. Every clean-up is written to the audit log.
        ${d.database_bytes ? ` Database size now: <b>${sizeText(d.database_bytes)}</b> (free plan limit 500 MB).` : ''}</p></div>
    <div class="panel cu-list">${d.types.map((t) => `<div class="cu-row" data-type="${t.key}">
      <div class="row between"><div><b>${esc(t.label)}</b> <span class="muted small">${fmtNum(t.deletable)}${t.deletable !== t.total ? ` of ${fmtNum(t.total)}` : ''} item${t.total === 1 ? '' : 's'}${t.oldest ? ` · oldest ${esc(timeAgo(t.oldest))}` : ''}${t.bytes ? ` · ${sizeText(t.bytes)}` : ''}</span></div></div>
      <p class="muted small" style="margin:4px 0 10px">${esc(t.help)}</p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <span class="small">Delete older than</span><select data-age>${ageOpts(t.min, Math.max(t.min, 90))}</select>
        <button class="btn small" data-check>Check</button>
        <button class="btn small danger" data-go hidden>Delete</button>
        <span class="small" data-result></span>
        <span class="grow"></span>
        <span class="small">Auto-delete after</span><select data-auto><option value="0">Never</option>${ageOpts(t.min, t.auto)}</select>
      </div></div>`).join('')}</div>
  </div>`;
  body.querySelectorAll('[data-type]').forEach((row) => {
    const key = row.dataset.type;
    const age = row.querySelector('[data-age]');
    const go = row.querySelector('[data-go]');
    const out = row.querySelector('[data-result]');
    const reset = () => { go.hidden = true; out.textContent = ''; };
    age.onchange = reset;
    row.querySelector('[data-check]').onclick = async () => {
      try {
        const r = await api(`admin/cleanup/${key}/preview`, { method: 'POST', body: { days: Number(age.value) } });
        out.textContent = r.count ? `${fmtNum(r.count)} item${r.count === 1 ? '' : 's'} would be deleted.` : 'Nothing that old.';
        go.hidden = !r.count;
        go.textContent = `Delete ${fmtNum(r.count)}`;
      } catch (x) { fail(x); }
    };
    go.onclick = async () => {
      const label = d.types.find((t) => t.key === key).label;
      if (!(await confirmBox(`Delete ${go.textContent.replace('Delete ', '')} ${label.toLowerCase()} older than ${age.options[age.selectedIndex].text}? This can't be undone.`))) return;
      try {
        const r = await api(`admin/cleanup/${key}`, { method: 'POST', body: { days: Number(age.value) } });
        toast('Cleaned up', `${fmtNum(r.deleted)} deleted.`);
        cleanupTab(body);
      } catch (x) { fail(x); }
    };
    row.querySelector('[data-auto]').onchange = async (e) => {
      try {
        await api('admin/cleanup/auto', { method: 'PUT', body: { [key]: Number(e.target.value) } });
        toast('Saved', Number(e.target.value) ? `Auto-delete after ${e.target.options[e.target.selectedIndex].text}.` : 'Auto-delete turned off.');
      } catch (x) { fail(x); }
    };
  });
}
