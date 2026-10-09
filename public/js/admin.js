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
  { key: 'giveaways', label: 'Giveaways', group: 'People' },
  { key: 'ranks', label: 'Ranks', group: 'Game' },
  { key: 'awards', label: 'Medals', group: 'Game' },
  { key: 'stat-defs', label: 'Stats', group: 'Game' },
  { key: 'game-servers', label: 'Game servers', group: 'Game' },
  { key: 'games', label: 'Games', group: 'Game' },
  { key: 'unlocks', label: 'Unlocks', group: 'Game' },
  { key: 'artillery', label: 'Artillery', group: 'Game' },
  { key: 'wpgxp', label: 'WPG XP', group: 'Game' },
  { key: 'frames', label: 'Frames & seasons', group: 'Game' },
  { key: 'badges', label: 'Badges', group: 'Game' },
  { key: 'events', label: 'Events & tournaments', mod: true, group: 'People' },
  { key: 'settings', label: 'Settings', group: 'App' },
  { key: 'discord-server', label: 'Discord (own page)', group: 'App' },
  { key: 'channels', label: 'Chat channels', group: 'App' },
  { key: 'steambot', label: 'Steam bot', group: 'App' },
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
    help: 'Create medals here. Give one by hand from the Members tab, or pick a tracked stat (our WPG server, wardogs.tools, Steam or WPG Barracks) and a target: members get it by themselves once they reach it, checked after every stats sync, after every match on the WPG server and every hour.',
    prep: async () => { TRACKED = TRACKED || await api('admin/tracked-stats'); },
    fields: [
      { k: 'name', label: 'Medal name' },
      { k: 'description', label: 'What it is for', type: 'textarea' },
      { k: 'colors', label: 'Ribbon stripes', type: 'colors' },
      { k: 'auto_rule', label: 'Given', type: 'medalrule' },
      { k: 'rarity', label: 'Rarity (achievement medals)', type: 'select', options: [['', 'None (older medal)'], ['common', 'Common'], ['uncommon', 'Uncommon'], ['rare', 'Rare'], ['epic', 'Epic'], ['legendary', 'Legendary'], ['mythic', 'Mythic'], ['exclusive', 'Exclusive']] },
      { k: 'points', label: 'Achievement Points', type: 'number' },
      { k: 'category', label: 'Category (for Discord posts)', type: 'select', options: [['', 'None'], ['streaming', 'Streaming'], ['nitro', 'Nitro boosts'], ['loyalty', 'WPG loyalty'], ['chat', 'Discord chat'], ['voice', 'Discord voice'], ['recruitment', 'Recruitment'], ['events', 'Events & tournaments'], ['special', 'Special'], ['wardogs', 'Wardogs'], ['other', 'Other']] },
      { k: 'sort_order', label: 'Order', type: 'number' },
    ],
    defaults: { colors: '#1f3a93,#ffffff,#b22234' },
    row: (r) => `${ribbon(r.colors)}<div class="grow"><b>${esc(r.name)}</b> ${r.auto_rule ? `<span class="pill mod">auto · ${esc(ruleText(r.auto_rule))}</span>` : ''}${r.rarity ? ` <span class="muted small">${esc(r.rarity)} · ${r.points} pts</span>` : ''}<div class="muted small">${esc(r.description)}</div></div>`,
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
    help: 'What each class unlocks at each level, stored in our own database. Add, change or remove items here after game updates. Members see their last and next unlock under each class, and the full list on the Progression page. "Career" is the overall Wardog level.',
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
  if (tab.key === 'discord-server') { location.hash = `#/discord${query().get('s') ? `?s=${encodeURIComponent(query().get('s'))}` : ''}`; return; }
  if (tab.key === 'recruitment') return (await import('./combat.js')).recruitmentTab(body);
  if (tab.key === 'units') return (await import('./combat.js')).unitsTab(body);
  if (tab.key === 'streams') return (await import('./streams.js')).streamsAdminTab(body);
  if (tab.key === 'wpgxp') return (await import('./wpgxp.js')).wpgXpAdminTab(body);
  if (tab.key === 'giveaways') return (await import('./giveaways.js')).giveawaysAdminTab(body);
  if (tab.key === 'frames') return (await import('./frames.js')).framesAdminTab(body);
  if (tab.key === 'badges') return (await import('./badges.js')).badgesAdminTab(body);
  if (tab.key === 'events') return (await import('./badges.js')).eventsAdminTab(body);
  if (tab.key === 'steambot') return (await import('./live.js')).steamBotAdminTab(body);
  return resourceTab(body, tab.key);
}

// ---------- Generic editor ----------
async function resourceTab(body, name) {
  const cfg = RESOURCES[name];
  const key = cfg.key || 'id';
  if (cfg.prep) await cfg.prep();
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
    case 'medalrule': {
      // Given by hand, or automatically from a tracked stat (grouped by where it comes from) once a target is reached.
      const [kind, a, b] = String(v || '').split(':');
      const legacy = v && kind !== 'stat';
      const cur = kind === 'stat' ? a : legacy ? '_legacy' : '';
      const groups = {};
      for (const [k, x] of Object.entries(TRACKED || {})) (groups[x.source] ||= []).push([k, x]);
      return `<div class="field" style="grid-column:1/-1"><span style="display:block;font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px">How it's given</span>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <select name="rule_stat" class="grow" style="min-width:240px">
            <option value="" ${cur === '' ? 'selected' : ''}>By hand (staff give it)</option>
            ${legacy ? `<option value="_legacy" selected>Keep: ${esc(ruleText(v))}</option>` : ''}
            ${Object.entries(groups).map(([src, list]) => `<optgroup label="Automatic: ${esc(src)}">${list.map(([k, x]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</optgroup>`).join('')}
          </select>
          <label class="row small" style="gap:6px">at least <input type="number" name="rule_target" min="0" step="any" style="width:120px" value="${esc(kind === 'stat' ? b : '')}"></label>
        </div>
        <input type="hidden" name="rule_legacy" value="${esc(legacy ? v : '')}">
        <span class="muted small">Members get it by themselves once their number reaches the target, and keep it for good.</span></div>`;
    }
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
      if (f.type === 'medalrule') {
        const st = form.rule_stat.value;
        out[f.k] = st === '_legacy' ? form.rule_legacy.value : st ? `stat:${st}:${form.rule_target.value || 0}` : '';
      } else if (f.type === 'insignia') out[f.k] = readInsignia();
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
      <div id="memberBadges" style="border-top:1px solid var(--line);padding-top:14px"><div class="spinner"></div></div>
      ${isAdmin() ? `<div style="border-top:1px solid var(--line);padding-top:14px"><button class="btn danger" id="udel">${icon('trash')} Delete account</button> <span class="muted small">Removes them and all their messages.</span></div>` : ''}
    </div>`);
  const close = () => { m.close(); reload(); };
  m.el.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  import('./badges.js').then((mod) => mod.memberBadgesSection(m.el.querySelector('#memberBadges'), u.id)).catch((x) => { m.el.querySelector('#memberBadges').innerHTML = `<p class="muted small">${esc(x.message)}</p>`; });
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

// ---------- Discord control panel: everything the WPG Discord bot does, in one place ----------
const DISCORD_SECTIONS = [
  ['bot', 'Bot'], ['server', 'Server & roles'], ['entry', 'Entry & rules'], ['commands', 'Commands'], ['filters', 'Filters & moderation'],
  ['logs', 'Logs & extras'], ['posts', 'Posts & channels'], ['rooms', 'Rooms'], ['botposts', 'Bot posts & guides'], ['scheduled', 'Scheduled announcements'], ['cases', 'Cases'],
];
// [setting, label, help] for the on / off switches, by section.
const DISCORD_SWITCHES = {
  filters: [
    ['AutoMod filters (Discord blocks the message before anyone sees it; staff are exempt)', [
      ['discord_automod_slurs', 'Offensive language filter', 'Slurs, hate speech and sexual content'],
      ['discord_automod_spam', 'Spam filter (Discord\'s own)', 'Messages Discord thinks are spam'],
      ['discord_automod_mentions', 'Mass mentions', 'More than 6 people or roles tagged in one message, and mention raids'],
      ['discord_automod_links', 'Invite and scam links', 'Other servers\' invites, fake Nitro and fake Steam links'],
      ['discord_automod_words', 'Blocked words list', 'The extra words and phrases below'],
    ]],
    ['Bot spam filter', [
      ['discord_filter_repeats', 'Repeated messages', 'The same message 3 times in 30 seconds is removed'],
      ['discord_filter_flood', 'Message floods', '6 messages in 8 seconds = 2-minute mute'],
      ['discord_filter_caps', 'Caps lock', 'Messages that are mostly CAPITALS are removed'],
    ]],
    ['Moderation', [
      ['discord_mod_commands', 'Moderator commands', '/warn /timeout /untimeout /kick /ban /unban /purge /slowmode /lock /unlock /cases /unwarn'],
      ['discord_dm_members', 'Tell members by DM', 'Warnings, timeouts, kicks, bans and entry decisions are sent to the member'],
    ]],
  ],
  logs: [
    ['#mod-log (cases, purges, locks and tickets are always logged)', [
      ['discord_log_joins', 'Joins and leaves', 'With the account\'s age; new accounts are flagged'],
      ['discord_log_messages', 'Edited and deleted messages', 'Before and after, and what was deleted'],
      ['discord_log_members', 'Role and nickname changes', 'Not the roles the app gives out itself'],
      ['discord_log_bans', 'Bans and unbans', 'Including ones made outside the bot'],
    ]],
    ['Extras', [
      ['discord_welcome_posts', 'Welcome posts', 'A welcome message in #welcome for each new joiner'],
      ['discord_raid_alarm', 'Raid alarm', '10 joins in a minute pauses entry for 15 minutes and pings Moderators'],
      ['discord_tickets', 'Tickets', 'The Contact staff button in #contact-staff'],
      ['discord_role_buttons', 'Role buttons', 'Platforms and 18+ in #pick-roles'],
      ['discord_game_roles', 'Steam game roles', 'Grey roles for games played 100+ hours (switching off removes them)'],
      ['discord_raise_verification', 'Raise Discord\'s verification level on Build', 'Verified email, account 5+ minutes old, media scanning'],
    ]],
  ],
};
// Tracked stats a medal can be given from (loaded when the Medals tab opens), and a rule in words.
let TRACKED = null;
const CLASS_LABEL = { recon: 'Recon', assault: 'Assault', medic: 'Medic', support: 'Support', driver: 'Driver', pilot: 'Pilot' };
function ruleText(rule) {
  const [kind, a, b] = String(rule || '').split(':');
  if (kind === 'stat') return `${TRACKED?.[a]?.label || a} ≥ ${Number(b).toLocaleString()}`;
  if (kind === 'class') return `${CLASS_LABEL[a] || a} class level ≥ ${b}`;
  if (kind === 'career') return `Wardog level ≥ ${a}`;
  if (kind === 'hours') return `Hours on Steam (enabled games) ≥ ${a}`;
  return rule;
}
// Settings saved through Admin → Settings' store, shown in Posts & channels.
const DISCORD_POSTS = [
  ['Discord server link and voice list', [
    ['discord_invite', 'Discord invite link (shown in the app)'],
    ['discord_voice_enabled', 'Show who is in the Discord voice channels (HQ + Comms)', 'check'],
    ['discord_server_id', 'Server for the voice list (optional; found from the invite link if empty)'],
  ]],
  ['Automatic posts', [
    ['discord_post_channel', 'Channel ID for posts (right-click the channel → Copy Channel ID). Empty = no posts'],
    ['discord_post_promotions', 'Clan promotions (WPG members only)', 'check'],
    ['discord_post_medals', 'New medals (WPG members only)', 'check'],
    ['discord_post_wpg_ranks', 'WPG rank-ups (WPG members only)', 'check'],
    ['discord_post_frames', 'Profile frame unlocks and new seasons', 'check'],
  ]],
  ['Giveaways', [
    ['discord_giveaway_channel', 'Channel ID for giveaways (empty = the posts channel)'],
    ['discord_post_giveaways', 'Post giveaways', 'check'],
  ]],
  ['Streams', [
    ['discord_stream_channel', 'Channel ID for "… is live" posts. Empty = no posts'],
    ['discord_post_streams', 'Post when an approved streamer goes live', 'check'],
  ]],
  ['Live match money', [
    ['discord_money_channel', 'Channel ID for the live money board and big wins (empty = the posts channel)'],
    ['discord_leaderboard_channel', 'Channel ID for the live WPG server leaderboard (one message the bot keeps updating). Empty = off'],
    ['discord_money_board', 'Live money board (one message the bot keeps updating)', 'check'],
    ['discord_post_big_wins', 'Post big wins', 'check'],
    ['big_win_amount', 'A big win is at least …', 'number'],
  ]],
  ['Staff channels', [
    ['discord_staff_channel', 'Staff-only channel ID for cheat alerts and reports (keep it private!). Empty = app alerts only'],
    ['discord_recruit_channel', 'Channel ID for new unit applications (empty = the staff channel)'],
  ]],
];

// The Discord control page (#/discord, admins): each part is a drop-down section; the ones left open stay open.
const OPEN_KEY = 'wpg.discord.open';
const openSections = () => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '["bot"]')); } catch { return new Set(['bot']); } };
export async function viewDiscordControl(main) {
  if (state.me.role !== 'admin') {
    main.innerHTML = '<div class="panel empty">Admins only.</div>';
    return;
  }
  main.innerHTML = `<h1>${icon('discord', 'width="26" height="26" style="vertical-align:-4px;color:var(--accent)"')} Discord control</h1>
    <p class="muted small" style="margin-top:-6px">Everything the WPG Discord bot does. Tap a section to open it. These control the bot, not Discord's own settings.</p>
    <div id="dcBody"><div class="spinner"></div></div>`;
  const wanted = query().get('s');
  if (wanted) { const o = openSections(); o.add(wanted); try { localStorage.setItem(OPEN_KEY, JSON.stringify([...o])); } catch { /* storage blocked */ } }
  return discordServerTab(main.querySelector('#dcBody'));
}

// ---------- Discord control → Rooms: view only and auto-clear, per room (server/discordrooms.js) ----------
const clearLabel = (m) => (!m ? 'Off' : m < 60 ? `${m} minutes` : m < 1440 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m / 1440} day${m === 1440 ? '' : 's'}`);
async function roomsPanel(box) {
  let d;
  try { d = await api('admin/discord-rooms'); } catch (x) { box.innerHTML = `<p class="muted small">${esc(x.message)}</p>`; return; }
  const row = (r) => {
    if (!r.text) return `<div class="dc-room off"><span class="grow">${r.type === 2 ? '🔊' : '#'} ${esc(r.name)}</span><span class="muted small">${r.type === 2 ? 'voice' : 'not a text room'}</span></div>`;
    return `<div class="dc-room" data-room="${esc(r.id)}">
      <span class="grow"><b># ${esc(r.name)}</b>${r.posts ? ` <span class="pill" title="Bot posts in this room">${r.posts} bot post${r.posts === 1 ? '' : 's'}</span>` : ''}
        <span class="muted small">${r.last_cleared_at ? `Cleared ${esc(timeAgo(r.last_cleared_at))} (${r.last_cleared_count})` : ''}</span>
        ${r.problem ? `<br><span class="small" style="color:var(--red)">${esc(r.problem)}</span>` : ''}</span>
      <label class="check small" title="Members can read but not post or use /commands. Staff and the bot still can."><input type="checkbox" data-view ${r.view_only ? 'checked' : ''}> View only</label>
      ${r.no_clear ? '<span class="muted small" title="Rules, logs, tickets and friend codes are never auto-cleared">Never cleared</span>'
    : `<label class="small" title="Members' messages and the replies to their /commands are deleted after this">Auto-clear <select data-clear>${d.clear_choices.map((m) => `<option value="${m}"${m === r.clear_minutes ? ' selected' : ''}>${clearLabel(m)}</option>`).join('')}</select></label>`}
    </div>`;
  };
  box.innerHTML = `<div class="panel">
      <p class="muted small" style="margin-top:0"><b>View only</b>: members can read the room (leaderboards, live cash…) but not post, start threads or use /commands; staff and the bot still can, and the room's permissions are put back exactly when you switch it off.
        <b>Auto-clear</b>: members' messages and the replies to their /commands are deleted after the time you pick. Staff messages, the bot's own posts and announcements, other bots' posts and pinned messages are never auto-deleted (remove those by hand).
        New rooms and categories made in Discord show up here by themselves.</p>
      <div class="row"><button class="btn small" id="dsRoomsSync">${icon('refresh')} Refresh from Discord</button>${d.guild ? '' : '<span class="muted small">Set the Discord server first (Server &amp; roles).</span>'}</div>
    </div>
    ${d.groups.map((g) => {
    const others = g.rooms.filter((r) => !r.text);
    return `<div class="panel"><div class="panel-title" style="margin-bottom:6px">${esc(g.name)}</div>${g.rooms.filter((r) => r.text).map(row).join('')}
      ${others.filter((r) => r.voice).length ? `<div class="dc-room"><span class="grow small">🔊 <b>Voice rooms</b> <span class="muted">· tick to show the real name in the app's Discord comms panel (rooms that need a role stay locked on Discord)</span>
        <span class="row" style="gap:6px 14px;margin-top:6px;flex-wrap:wrap">${others.filter((r) => r.voice).map((r) => `<label class="check small"><input type="checkbox" data-show="${esc(r.id)}"${r.show_in_app ? ' checked' : ''}> ${esc(r.name)}</label>`).join('')}</span></span></div>` : ''}
      ${others.filter((r) => !r.voice).length ? `<div class="dc-room off"><span class="grow small">${others.filter((r) => !r.voice).map((r) => esc(r.name)).join(' · ')}</span><span class="muted small">other</span></div>` : ''}
      ${g.rooms.length ? '' : '<p class="muted small" style="margin:0">No rooms.</p>'}</div>`;
  }).join('')}`;
  box.querySelector('#dsRoomsSync').onclick = async () => {
    try { const r = await api('admin/discord-rooms/sync', { method: 'POST', body: {} }); if (r.ok === false) throw new Error(r.reason); toast('Rooms up to date'); roomsPanel(box); } catch (x) { fail(x); }
  };
  box.querySelectorAll('[data-show]').forEach((el) => {
    el.onchange = async () => {
      try { await api(`admin/discord-rooms/${el.dataset.show}`, { method: 'PUT', body: { show_in_app: el.checked } }); toast(el.checked ? 'Shown in the app' : 'Hidden in the app'); } catch (x) { el.checked = !el.checked; fail(x); }
    };
  });
  box.querySelectorAll('[data-room]').forEach((el) => {
    const save = async (body, undo) => {
      try {
        const r = await api(`admin/discord-rooms/${el.dataset.room}`, { method: 'PUT', body });
        if (r.problem) toast('Saved, with a problem', r.problem); else toast('Saved');
      } catch (x) { undo(); fail(x); }
    };
    const v = el.querySelector('[data-view]');
    v.onchange = () => save({ view_only: v.checked }, () => { v.checked = !v.checked; });
    const c = el.querySelector('[data-clear]');
    if (c) { const was = c.value; c.onchange = () => save({ clear_minutes: Number(c.value) }, () => { c.value = was; }); }
  });
}

// How a bot post will look on Discord: the banner, then each text box (blue edge) or the plain message.
let previewNames = {};
function discordMd(t) {
  return esc(t).replace(/&lt;@&amp;(\d+)&gt;/g, (m, id) => `<span class="dp-cmd">${esc(previewNames[id] || '@role')}</span>`)
    .replace(/&lt;@(\d+)&gt;/g, '<span class="dp-cmd">@member</span>').replace(/&lt;#(\d+)&gt;/g, (m, id) => `<span class="dp-cmd">${esc(previewNames[id] || '#room')}</span>`).replace(/&lt;\/([\w-]+):\d+&gt;/g, '<span class="dp-cmd">/$1</span>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^### (.+)$/gm, '<b>$1</b>').replace(/^## (.+)$/gm, '<b style="font-size:1.15em">$1</b>').replace(/^-# (.+)$/gm, '<span class="muted small">$1</span>').replace(/\n/g, '<br>');
}
function discordPreview(r) {
  previewNames = r.names || {};
  if (!r.embeds?.length) return `<div class="dp-msg">${discordMd(r.text || '')}</div>`;
  return `<div class="dp-msg">${r.text ? `<div style="margin-bottom:6px">${discordMd(r.text).replace(/&lt;@\d+&gt;/g, '<span class="dp-cmd">@member</span>')}</div>` : ''}${r.embeds.map((e, i) => `<div class="dp-embed" style="--ec:#${Number(e.color || 0x33d1ff).toString(16).padStart(6, '0')}">
      ${e.title ? `<div class="dp-title">${esc(e.title)}</div>` : ''}
      ${e.description ? `<div>${discordMd(e.description)}</div>` : ''}
      ${i === 0 && r.banner ? `<img src="${r.banner}" alt="" style="width:100%;border-radius:4px;margin-top:${e.description ? '8px' : '0'}">` : ''}
      ${e.footer ? `<div class="muted small" style="margin-top:6px">${esc(e.footer.text)}</div>` : ''}</div>`).join('')}</div>`;
}

// ---------- Weekly welcome (server/discordwelcome.js) ----------
async function weeklyWelcomePanel(el, roomOptions) {
  let d;
  try { d = await api('admin/discord-welcome'); } catch (x) { el.innerHTML = `<p class="muted small">${esc(x.message)}</p>`; return; }
  const s = d.settings;
  el.innerHTML = `<div class="panel-title">👋 Weekly welcome</div>
    <p class="muted small" style="margin-top:0">Once a week the bot @mentions everyone who joined the Discord in the last 7 days (still on the server, not bots;
      with the entry check on, only those who got in), thanks them, and reminds them to follow us on Facebook and sign up to the app. Members already in the
      app are ticked; the rest get a friendly nudge. Nobody is welcomed twice, and nothing is posted when nobody new joined.
      The Facebook button uses the link in Admin → Settings.</p>
    <form id="wwForm" class="stack">
      <div class="form-grid">
        <label class="check" style="grid-column:1/-1"><input type="checkbox" name="on"${s.weekly_welcome_on === 'true' ? ' checked' : ''}> Weekly welcome on</label>
        <label class="field"><span>Room</span><select name="channel"><option value="">Pick a room…</option>${roomOptions(s.weekly_welcome_channel)}</select></label>
        <label class="field"><span>Day (UK time)</span><select name="day"><option value="">Pick a day…</option>${d.days.map((n, i) => `<option value="${i}"${String(i) === s.weekly_welcome_day ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field"><span>Time (UK time)</span><input type="time" name="time" value="${esc(s.weekly_welcome_time)}"></label>
        <label class="check small"><input type="checkbox" name="ping"${s.weekly_welcome_ping === 'true' ? ' checked' : ''}> Ping everyone named</label>
        <label class="check small"><input type="checkbox" name="nudge"${s.weekly_welcome_nudge === 'true' ? ' checked' : ''}> Show who is / isn't in the app yet</label>
      </div>
      <label class="field"><span>Top line ({mentions} = the new members, {count} = how many)</span><input type="text" name="title" maxlength="300" value="${esc(s.weekly_welcome_title)}"></label>
      <label class="field"><span>Message</span><textarea name="text" rows="5">${esc(s.weekly_welcome_text)}</textarea></label>
      <p class="small" style="margin:0">${d.when ? `Posts on <b>${esc(d.when)}</b>.` : '<b style="color:var(--amber, #f5a524)">Pick a day and time to start it.</b>'}
        <span class="muted">${d.waiting} new member${d.waiting === 1 ? '' : 's'} waiting to be welcomed${d.waiting ? ` (${d.waiting_in_app} already in the app)` : ''}.</span></p>
      <div id="wwPreview"></div>
      <div class="row"><button class="btn primary">Save</button><button type="button" class="btn" id="wwPrev">Preview</button><button type="button" class="btn ghost" id="wwNow">Post now</button></div>
    </form>`;
  const f = el.querySelector('#wwForm');
  const body = () => ({ on: f.on.checked, channel: f.channel.value, day: f.day.value, time: f.time.value, ping: f.ping.checked, nudge: f.nudge.checked, title: f.title.value, text: f.text.value });
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await api('admin/discord-welcome', { method: 'PUT', body: body() }); toast('Saved', r.when ? `Posts on ${r.when}.` : 'Pick a day and time to start it.'); weeklyWelcomePanel(el, roomOptions); } catch (x) { fail(x); }
  };
  el.querySelector('#wwPrev').onclick = async () => {
    const out = el.querySelector('#wwPreview');
    out.innerHTML = '<div class="spinner"></div>';
    try {
      await api('admin/discord-welcome', { method: 'PUT', body: body() });
      const r = await api('admin/discord-welcome/preview', { method: 'POST', body: {} });
      out.innerHTML = `${r.sample ? '<p class="muted small" style="margin:6px 0 0">Nobody new to welcome right now: this shows a sample member.</p>' : ''}${discordPreview(r)}`;
    } catch (x) { out.innerHTML = ''; fail(x); }
  };
  el.querySelector('#wwNow').onclick = async () => {
    if (!(await confirmBox(`Post the welcome now? It pings the ${d.waiting} new member${d.waiting === 1 ? '' : 's'} and they won't be welcomed again on the day.`))) return;
    try {
      await api('admin/discord-welcome', { method: 'PUT', body: body() });
      const r = await api('admin/discord-welcome/post', { method: 'POST', body: {} });
      if (!r.ok) throw new Error(r.reason);
      toast(r.posted ? 'Posted' : 'Nothing to post', r.posted ? `${r.count} new member${r.count === 1 ? '' : 's'} welcomed.` : r.reason);
      weeklyWelcomePanel(el, roomOptions);
    } catch (x) { fail(x); }
  };
}

// The boxes editor (bot posts, scheduled announcements). The boxes are kept as one text: the first box first,
// "## Heading" (or "---" with no heading) before each next one.
function boxEditor(boxesEl, addBtn, initial) {
  const toBoxes = (text) => {
    const out = [{ title: '', text: [] }];
    for (const line of String(text || '').split(/\r?\n/)) {
      if (/^#{1,3}\s+\S/.test(line.trim())) out.push({ title: line.trim().replace(/^#+\s*/, ''), text: [] });
      else if (/^-{3,}$/.test(line.trim())) out.push({ title: '', text: [] });
      else out[out.length - 1].text.push(line);
    }
    return out.map((b) => ({ title: b.title, text: b.text.join('\n').replace(/^\n+|\n+$/g, '') }));
  };
  const boxHtml = (b, i) => `<div class="dp-boxedit" data-box>
      <div class="row" style="gap:8px"><input type="text" data-btitle maxlength="80" class="grow" placeholder="${i ? 'Heading (optional)' : 'Opening box: no heading'}" value="${esc(b.title)}"${i ? '' : ' disabled'}>
        ${i ? '<button type="button" class="btn small ghost" data-bdel title="Remove this box">✕</button>' : ''}</div>
      <textarea data-btext rows="5" placeholder="Text">${esc(b.text)}</textarea></div>`;
  const draw = (list) => {
    boxesEl.innerHTML = list.map(boxHtml).join('');
    boxesEl.querySelectorAll('[data-bdel]').forEach((btn) => { btn.onclick = () => { btn.closest('[data-box]').remove(); }; });
  };
  const read = () => [...boxesEl.querySelectorAll('[data-box]')].map((el) => ({ title: el.querySelector('[data-btitle]').value.trim(), text: el.querySelector('[data-btext]').value }));
  const text = () => read().map((b, i) => (i === 0 ? b.text : `${b.title ? `## ${b.title}` : '---'}\n${b.text}`)).join('\n').trim();
  draw(toBoxes(initial).length ? toBoxes(initial) : [{ title: '', text: '' }]);
  addBtn.onclick = () => { const list = read(); list.push({ title: '', text: '' }); draw(list); };
  return { text };
}

// ---------- Discord control → Scheduled announcements (server/discordschedule.js) ----------
const SCHED_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Times are entered and shown in the admin's own time zone (saved with the announcement), so a US admin's 4pm is 9pm UK.
const MY_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London'; } catch { return 'Europe/London'; } })();
// Short zone names: "CDT" / "EST" for US zones, "BST" / "GMT" for UK ones.
const zoneLabel = (tz, at = new Date()) => {
  const name = (loc) => { try { return new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((x) => x.type === 'timeZoneName')?.value || ''; } catch { return ''; } };
  const us = name('en-US');
  return (us && !us.startsWith('GMT') ? us : name('en-GB')) || tz;
};
const localWhen = (iso) => (iso ? `${new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} ${zoneLabel(MY_TZ, new Date(iso))}` : '—');
const ymdIn = (at, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);
const hmIn = (at, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
// A scheduled announcement's day, time and weekdays as the viewing admin sees them (it may have been set in another zone).
function schedLocal(s) {
  if (!s.start_at || (s.tz || 'Europe/London') === MY_TZ) return { date: s.date, time: s.time, weekdays: s.weekdays || [] };
  const at = new Date(s.start_at);
  const date = ymdIn(at, MY_TZ);
  const shift = Math.round((Date.parse(date) - Date.parse(s.date)) / 86400e3);
  return { date, time: hmIn(at, MY_TZ), weekdays: (s.weekdays || []).map((d) => (Number(d) + shift + 7) % 7) };
}
const nth = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
function repeatText(row) {
  const s = { ...row, ...schedLocal(row) };
  const base = {
    none: 'Once',
    daily: 'Every day',
    weekly: `Every week on ${(s.weekdays || []).slice().sort().map((d) => SCHED_DAYS[d]).join(', ')}`,
    fortnightly: 'Every 2 weeks',
    monthly: `Every month on the ${nth(Number(String(s.date).slice(8, 10)))}`,
    days: `Every ${s.every_days} days`,
  }[s.repeat] || 'Once';
  const ends = [s.until_date ? `until ${s.until_date.split('-').reverse().join('/')}` : '', s.max_sends ? `${s.sends || 0} of ${s.max_sends} sent` : ''].filter(Boolean).join(' · ');
  const elsewhere = (row.tz || 'Europe/London') !== MY_TZ ? ` (set as ${row.time} ${zoneLabel(row.tz, new Date(row.start_at || Date.now()))})` : '';
  return `${base} at ${s.time} your time${elsewhere}${ends ? ` · ${ends}` : ''}`;
}
async function scheduledPanel(box) {
  let d;
  let rooms;
  try { [d, rooms] = await Promise.all([api('admin/discord-scheduled'), api('admin/discord-rooms')]); } catch (x) { box.innerHTML = `<p class="muted small">${esc(x.message)}</p>`; return; }
  const ANNOUNCE = '1216495498035200102';
  const roomName = Object.fromEntries(rooms.groups.flatMap((g) => g.rooms.map((r) => [r.id, r.name])));
  const roomOptions = (sel) => rooms.groups.map((g) => {
    const list = g.rooms.filter((r) => r.text);
    return list.length ? `<optgroup label="${esc(g.name)}">${list.map((r) => `<option value="${esc(r.id)}"${r.id === sel ? ' selected' : ''}># ${esc(r.name)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  const link = (h) => (d.guild && h.message_id ? `https://discord.com/channels/${d.guild}/${h.channel_id}/${h.message_id}` : '');
  box.innerHTML = `<div class="panel">
      <p class="muted small" style="margin-top:0">Write an announcement now and the bot posts it at the day and time you pick (in your own time zone: <b>${esc(zoneLabel(MY_TZ))}</b>; other admins see it in theirs), as a fresh message (WPG banner + text boxes, or plain text).
        It can repeat (every day, chosen weekdays, every 2 weeks, every month or every few days). Once a one-off is sent it leaves this list; it's never deleted from Discord.
        Tick <b>Show in the app</b> to add it to the app's announcements on HQ too. Every send is kept in the history below.</p>
      <button class="btn primary" id="saNew">${icon('plus')} New scheduled announcement</button></div>
    <div class="panel"><div class="panel-title">Scheduled <span class="sub">${d.list.length}</span></div>
      ${d.list.length ? d.list.map((s) => `<div class="dc-room"${s.paused ? ' style="opacity:.6"' : ''}><span class="grow"><b>${esc(s.title || 'Announcement')}</b>
          <span class="muted small">in # ${esc(roomName[s.channel_id] || s.channel_id)}${s.show_in_app ? ' · also in the app' : ''}${s.ping ? ' · pings' : ''}</span><br>
          <span class="small">${s.paused ? '⏸ Paused' : `Next: <b>${esc(localWhen(s.next_at))}</b>`} <span class="muted">· ${esc(repeatText(s))}</span></span></span>
        <button class="btn small" data-edit="${s.id}">${icon('edit')} Edit</button>
        <button class="btn small ghost" data-pause="${s.id}">${s.paused ? '▶ Resume' : '⏸ Pause'}</button>
        <button class="btn small ghost" data-send="${s.id}">Send now</button>
        <button class="btn small danger" data-del="${s.id}">Delete</button></div>`).join('')
    : '<p class="muted small" style="margin:0">Nothing scheduled.</p>'}</div>
    <div class="panel"><div class="panel-title">History <span class="sub">newest ${d.history.length}</span></div>
      ${d.history.length ? d.history.map((h) => `<div class="dc-room"><span class="grow"><b>${esc(h.title || 'Announcement')}</b>
          <span class="muted small">in # ${esc(roomName[h.channel_id] || h.channel_id)} · ${esc(localWhen(h.sent_at))}${h.how === 'now' ? ' · sent by hand' : ''}</span>
          ${h.ok ? '' : `<br><span class="small" style="color:var(--red)">${h.how === 'skipped' ? '' : 'Not sent: '}${esc(h.problem || 'unknown problem')}</span>`}</span>
        <button class="btn small ghost" data-view="${h.id}">View</button>
        ${link(h) ? `<a class="btn small ghost" href="${esc(link(h))}" target="_blank" rel="noopener">On Discord</a>` : ''}
        <button class="btn small" data-again="${h.id}">Use again</button></div>`).join('')
    : '<p class="muted small" style="margin:0">Nothing sent yet.</p>'}</div>`;
  const reload = () => scheduledPanel(box);
  const open = (s, copy) => {
    const v = s ? { ...s, ...schedLocal(s) } : { channel_id: copy?.channel_id || ANNOUNCE, title: copy?.title || '', body: copy?.body || '', style: copy?.style || 'card', ping: false, show_in_app: false, date: ymdIn(new Date(), MY_TZ), time: '', repeat: 'none', weekdays: [], every_days: 3, until_date: '', max_sends: 0 };
    const m = modal(`<form class="stack" id="saForm">
      <div class="row between"><h3 style="margin:0">${s ? 'Edit' : 'New'} scheduled announcement</h3><button type="button" class="btn ghost small" data-close>✕</button></div>
      <label class="field"><span>Room</span><select name="channel_id" required><option value="">Pick a room…</option>${roomOptions(v.channel_id)}</select></label>
      <label class="field"><span>Title (on the picture)</span><input type="text" name="title" maxlength="60" value="${esc(v.title)}"></label>
      <div class="field"><span style="display:block;font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Boxes</span>
        <p class="muted small" style="margin:0 0 6px">Each box shows as its own box on Discord. Write <b>@Role Name</b> or <b>#room-name</b> for real mentions (check them in Preview).</p>
        <div id="saBoxes" class="stack" style="gap:10px"></div>
        <button type="button" class="btn small" id="saAddBox" style="margin-top:8px">+ Add box</button></div>
      <div class="row" style="gap:16px">
        <label class="check small"><input type="radio" name="style" value="card"${v.style !== 'text' ? ' checked' : ''}> WPG banner + text boxes</label>
        <label class="check small"><input type="radio" name="style" value="text"${v.style === 'text' ? ' checked' : ''}> Plain text</label>
        <label class="check small"><input type="checkbox" name="ping"${v.ping ? ' checked' : ''}> Ping the roles you @mention</label>
        <label class="check small" title="Also adds it to the app's announcements (HQ) when it's sent"><input type="checkbox" name="show_in_app"${v.show_in_app ? ' checked' : ''}> Show in the app as well</label>
      </div>
      <div class="form-grid">
        <label class="field"><span>Day (your time)</span><input type="date" name="date" required value="${esc(v.date)}"></label>
        <label class="field"><span>Time (your time)</span><input type="time" name="time" required value="${esc(v.time)}"></label>
        <label class="field"><span>Repeat</span><select name="repeat">${[['none', 'Don\'t repeat'], ['daily', 'Every day'], ['weekly', 'Every week (pick days)'], ['fortnightly', 'Every 2 weeks'], ['monthly', 'Every month (same date)'], ['days', 'Every few days']]
          .map(([k, l]) => `<option value="${k}"${k === v.repeat ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <p class="muted small" id="saZone" style="margin:0"></p>
      <div class="row" data-r="weekly" style="gap:12px">${SCHED_DAYS.map((n, i) => `<label class="check small"><input type="checkbox" name="wd" value="${i}"${(v.weekdays || []).map(Number).includes(i) ? ' checked' : ''}> ${n}</label>`).join('')}</div>
      <div class="form-grid" data-r="repeat">
        <label class="field" data-r="days"><span>Every how many days</span><input type="number" name="every_days" min="1" max="365" value="${esc(v.every_days || 3)}"></label>
        <label class="field"><span>Stop after this day (optional)</span><input type="date" name="until_date" value="${esc(v.until_date || '')}"></label>
        <label class="field"><span>Stop after this many sends (optional)</span><input type="number" name="max_sends" min="0" max="10000" value="${v.max_sends || ''}" placeholder="No limit"></label>
      </div>
      <div id="saPreview"></div>
      <div class="row"><button type="button" class="btn" id="saPrev">Preview</button><button class="btn primary">${s ? 'Save' : 'Schedule it'}</button></div>
    </form>`);
    const f = m.el.querySelector('#saForm');
    const boxes = boxEditor(m.el.querySelector('#saBoxes'), m.el.querySelector('#saAddBox'), v.body);
    const sync = () => {
      const r = f.repeat.value;
      m.el.querySelector('[data-r="weekly"]').style.display = r === 'weekly' ? '' : 'none';
      m.el.querySelector('[data-r="repeat"]').style.display = r === 'none' ? 'none' : '';
      m.el.querySelector('[data-r="days"]').style.display = r === 'days' ? '' : 'none';
    };
    f.repeat.onchange = sync;
    sync();
    // "Your time" plus the same moment in UK time, so nobody has to work it out.
    const zone = () => {
      const at = f.date.value && f.time.value ? new Date(`${f.date.value}T${f.time.value}`) : null;
      const uk = at && !Number.isNaN(at.getTime()) && MY_TZ !== 'Europe/London'
        ? ` That's <b>${esc(at.toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} UK time</b>.` : '';
      m.el.querySelector('#saZone').innerHTML = `Times are in your time zone (<b>${esc(zoneLabel(MY_TZ, at || new Date()))}</b>, ${esc(MY_TZ)}).${uk}`;
    };
    f.date.oninput = zone;
    f.time.oninput = zone;
    zone();
    const body = () => ({ tz: MY_TZ,
      channel_id: f.channel_id.value, title: f.title.value, body: boxes.text(), style: f.style.value, ping: f.ping.checked, show_in_app: f.show_in_app.checked,
      date: f.date.value, time: f.time.value, repeat: f.repeat.value, weekdays: [...f.querySelectorAll('[name="wd"]:checked')].map((x) => Number(x.value)),
      every_days: f.every_days.value, until_date: f.until_date.value, max_sends: f.max_sends.value,
    });
    m.el.querySelector('#saPrev').onclick = async () => {
      const out = m.el.querySelector('#saPreview');
      out.innerHTML = '<div class="spinner"></div>';
      try { out.innerHTML = discordPreview(await api('admin/discord-posts/preview', { method: 'POST', body: { ...body(), kind: 'custom' } })); } catch (x) { out.innerHTML = ''; fail(x); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api(s ? `admin/discord-scheduled/${s.id}` : 'admin/discord-scheduled', { method: s ? 'PUT' : 'POST', body: body() });
        toast(s ? 'Saved' : 'Scheduled', `Goes out ${localWhen(r.next_at)}.`);
        m.close();
        reload();
      } catch (x) { fail(x); }
    };
  };
  box.querySelector('#saNew').onclick = () => open(null);
  const byId = (list, id) => list.find((x) => x.id === Number(id));
  box.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => open(byId(d.list, b.dataset.edit)); });
  box.querySelectorAll('[data-pause]').forEach((b) => {
    b.onclick = async () => {
      const s = byId(d.list, b.dataset.pause);
      try { await api(`admin/discord-scheduled/${s.id}/pause`, { method: 'POST', body: { paused: !s.paused } }); toast(s.paused ? 'Resumed' : 'Paused'); reload(); } catch (x) { fail(x); }
    };
  });
  box.querySelectorAll('[data-send]').forEach((b) => {
    b.onclick = async () => {
      const s = byId(d.list, b.dataset.send);
      if (!(await confirmBox(`Send "${s.title || 'this announcement'}" now? It stays scheduled for its next time as well.`))) return;
      try { const r = await api(`admin/discord-scheduled/${s.id}/send`, { method: 'POST', body: {} }); if (r.ok) toast('Sent'); else toast('Not sent', r.problem); reload(); } catch (x) { fail(x); }
    };
  });
  box.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmBox('Delete this scheduled announcement? Anything it already posted stays on Discord.'))) return;
      try { await api(`admin/discord-scheduled/${b.dataset.del}`, { method: 'DELETE' }); toast('Deleted'); reload(); } catch (x) { fail(x); }
    };
  });
  box.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = async () => {
      const h = byId(d.history, b.dataset.view);
      const m = modal(`<div class="stack"><div class="row between"><h3 style="margin:0">${esc(h.title || 'Announcement')}</h3><button type="button" class="btn ghost small" data-close>✕</button></div>
        <p class="muted small" style="margin:0">Sent ${esc(localWhen(h.sent_at))} in # ${esc(roomName[h.channel_id] || h.channel_id)}</p><div id="saView"><div class="spinner"></div></div></div>`);
      try { m.el.querySelector('#saView').innerHTML = discordPreview(await api('admin/discord-posts/preview', { method: 'POST', body: { channel_id: h.channel_id, kind: 'custom', title: h.title, body: h.body } })); } catch { m.el.querySelector('#saView').innerHTML = `<pre class="small" style="white-space:pre-wrap">${esc(h.body)}</pre>`; }
    };
  });
  box.querySelectorAll('[data-again]').forEach((b) => { b.onclick = () => open(null, byId(d.history, b.dataset.again)); });
}

// ---------- Discord control → Bot posts & guides ----------
async function botPostsPanel(box) {
  let d;
  try { d = await api('admin/discord-rooms'); } catch (x) { box.innerHTML = `<p class="muted small">${esc(x.message)}</p>`; return; }
  const kinds = Object.fromEntries(d.kinds.map((k) => [k.key, k]));
  const roomOptions = (sel) => d.groups.map((g) => {
    const list = g.rooms.filter((r) => r.text);
    return list.length ? `<optgroup label="${esc(g.name)}">${list.map((r) => `<option value="${esc(r.id)}"${r.id === sel ? ' selected' : ''}># ${esc(r.name)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  box.innerHTML = `<div class="panel" id="wwBox"><div class="spinner"></div></div>
    <div class="panel">
      <p class="muted small" style="margin-top:0">The bot posts these in the room you pick, pins them and keeps them up to date by editing the same message.
        Ready-made guides rebuild themselves when commands are added or who can use them changes. Posts have the WPG banner on top with the text in boxes underneath (real Discord text, easy to read on phones), or plain text.</p>
      <button class="btn primary" id="bpNew">${icon('plus')} New bot post</button></div>
    <div class="panel"><div class="panel-title">Posts</div>
      ${d.posts.length ? d.posts.map((p) => `<div class="dc-room"><span class="grow"><b>${esc(p.title || kinds[p.kind]?.label || 'Post')}</b> <span class="muted small">in # ${esc(p.room)} · ${esc(kinds[p.kind]?.label || p.kind)} · ${p.style === 'text' ? 'plain text' : 'banner + text boxes'}${p.message_id ? '' : ' · not posted yet'}</span>
          ${p.problem ? `<br><span class="small" style="color:var(--red)">${esc(p.problem)}</span>` : ''}</span>
        <button class="btn small" data-edit="${p.id}">${icon('edit')} Edit</button><button class="btn small ghost" data-repost="${p.id}">Update now</button><button class="btn small danger" data-del="${p.id}">Delete</button></div>`).join('')
    : '<p class="muted small" style="margin:0">No bot posts yet.</p>'}</div>`;
  const open = (p) => {
    const v = p || { channel_id: '', kind: 'custom', title: '', body: '', style: 'card', pin: true };
    const m = modal(`<form class="stack" id="bpForm">
      <div class="row between"><h3 style="margin:0">${p ? 'Edit' : 'New'} bot post</h3><button type="button" class="btn ghost small" data-close>✕</button></div>
      <label class="field"><span>Room</span><select name="channel_id" required><option value="">Pick a room…</option>${roomOptions(v.channel_id)}</select></label>
      <label class="field"><span>What to post</span><select name="kind">${d.kinds.map((k) => `<option value="${k.key}"${k.key === v.kind ? ' selected' : ''}>${esc(k.label)}</option>`).join('')}</select></label>
      <p class="muted small" id="bpHelp" style="margin:0"></p>
      <label class="field" data-custom><span>Title (on the picture)</span><input type="text" name="title" maxlength="60" value="${esc(v.title)}"></label>
      <div class="field" data-custom><span style="display:block;font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Boxes</span>
        <p class="muted small" style="margin:0 0 6px">Each box shows as its own box on Discord. Blank lines stay as gaps. Write <b>@Role Name</b> or <b>#room-name</b> and they become real mentions (check them in Preview). A line like "Login - Use Steam" shows "Login" in blue.</p>
        <div id="bpBoxes" class="stack" style="gap:10px"></div>
        <button type="button" class="btn small" id="bpAddBox" style="margin-top:8px">+ Add box</button></div>
      <div class="row" style="gap:16px">
        <label class="check small"><input type="radio" name="style" value="card"${v.style !== 'text' ? ' checked' : ''}> WPG banner + text boxes</label>
        <label class="check small"><input type="radio" name="style" value="text"${v.style === 'text' ? ' checked' : ''}> Plain text</label>
        <label class="check small"><input type="checkbox" name="pin"${v.pin !== false ? ' checked' : ''}> Pin it</label>
        <label class="check small" title="Puts the roles you @mention at the top so Discord notifies them (only when it's first posted, not on edits)"><input type="checkbox" name="ping"${v.ping ? ' checked' : ''}> Ping the roles you @mention</label>
      </div>
      <div id="bpPreview"></div>
      <div class="row"><button type="button" class="btn" id="bpPrev">Preview</button><button class="btn primary">${p ? 'Save & update on Discord' : 'Post on Discord'}</button></div>
    </form>`);
    const f = m.el.querySelector('#bpForm');
    const boxes = boxEditor(m.el.querySelector('#bpBoxes'), m.el.querySelector('#bpAddBox'), v.body);
    const boxesText = boxes.text;
    const sync = () => {
      const custom = f.kind.value === 'custom';
      f.querySelectorAll('[data-custom]').forEach((el) => { el.style.display = custom ? '' : 'none'; });
      m.el.querySelector('#bpHelp').textContent = kinds[f.kind.value]?.help || '';
    };
    f.kind.onchange = sync;
    sync();
    const body = () => ({ channel_id: f.channel_id.value, kind: f.kind.value, title: f.title.value, body: boxesText(), style: f.style.value, pin: f.pin.checked, ping: f.ping.checked });
    m.el.querySelector('#bpPrev').onclick = async () => {
      const out = m.el.querySelector('#bpPreview');
      out.innerHTML = '<div class="spinner"></div>';
      try {
        const r = await api('admin/discord-posts/preview', { method: 'POST', body: body() });
        out.innerHTML = discordPreview(r);
      } catch (x) { out.innerHTML = ''; fail(x); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api(p ? `admin/discord-posts/${p.id}` : 'admin/discord-posts', { method: p ? 'PUT' : 'POST', body: body() });
        if (r.problem) toast('Saved, with a problem', r.problem); else toast(p ? 'Updated on Discord' : 'Posted on Discord');
        m.close();
        botPostsPanel(box);
      } catch (x) { fail(x); }
    };
  };
  weeklyWelcomePanel(box.querySelector('#wwBox'), roomOptions);
  box.querySelector('#bpNew').onclick = () => open(null);
  box.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => open(d.posts.find((x) => x.id === Number(b.dataset.edit))); });
  box.querySelectorAll('[data-repost]').forEach((b) => {
    b.onclick = async () => { try { const r = await api(`admin/discord-posts/${b.dataset.repost}/repost`, { method: 'POST', body: {} }); toast(r.problem ? 'Problem' : 'Updated', r.problem || ''); botPostsPanel(box); } catch (x) { fail(x); } };
  });
  box.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmBox('Delete this post from Discord too?'))) return;
      try { await api(`admin/discord-posts/${b.dataset.del}`, { method: 'DELETE' }); toast('Deleted'); botPostsPanel(box); } catch (x) { fail(x); }
    };
  });
}

async function discordServerTab(body) {
  const d = await api('admin/discord-server');
  const s = d.sync || {};
  const when = (iso) => { try { return timeAgo(iso); } catch { return ''; } };
  const open = openSections();
  const onCount = (groups) => { const keys = groups.flatMap(([, list]) => list.map(([k]) => k)); return `${keys.filter((k) => d.switches[k]).length} of ${keys.length} on`; };
  const summary = {
    bot: d.gateway.connected ? `✅ connected${d.gateway.limited ? ' (limited)' : ''}` : '⚠️ not connected',
    server: d.guild_id ? `${s.at ? (s.ok ? '✅ roles in step' : '⚠️ sync problem') : 'not synced yet'}` : 'no server set',
    entry: `${d.entry.enabled ? 'on' : 'off'}${d.held.length ? ` · ${d.held.length} waiting` : ''}`,
    commands: `${d.commands.filter((c) => c.groups.length).length} of ${d.commands.length} on`,
    filters: onCount(DISCORD_SWITCHES.filters),
    logs: `${onCount(DISCORD_SWITCHES.logs)}${d.tickets ? ` · ${d.tickets} open ticket${d.tickets === 1 ? '' : 's'}` : ''}`,
    posts: 'channels for automatic posts',
    rooms: 'view only & auto-clear, per room',
    botposts: 'guides and your own posts as the bot',
    scheduled: 'announcements posted at a set day and time, and the history',
    cases: d.cases.length ? `${d.cases.length} recent` : 'none yet',
  };
  const status = `<p class="small" style="margin:0 0 10px">${d.gateway.connected
    ? `✅ Bot connected to Discord${d.gateway.since ? ` since ${esc(when(d.gateway.since))}` : ''}${d.gateway.limited ? ' <b>(limited: see below)</b>' : ''}`
    : '⚠️ The bot isn\'t connected to Discord yet (it starts a few seconds after the app does, once the bot token is set).'}
    ${d.gateway.problem ? `<br><span style="color:var(--red)">${esc(d.gateway.problem)}</span>` : ''}
    <button type="button" class="btn small ghost" id="dsReconnect" style="margin-left:6px">Reconnect</button></p>`;
  const switchList = (groups) => groups.map(([title, list]) => `<div style="margin-bottom:14px"><b class="small">${esc(title)}</b>
    ${list.map(([k, label, help]) => `<label class="check" style="margin-top:8px;align-items:flex-start"><input type="checkbox" data-sw="${k}" ${d.switches[k] ? 'checked' : ''}>
      <span><b>${esc(label)}</b><br><span class="muted small">${esc(help)}</span></span></label>`).join('')}</div>`).join('');
  const html = {
    bot: () => `<div class="panel"><div class="panel-title">${icon('discord')} Discord bot</div>${status}
        <p class="muted small" style="margin:0">Everything the WPG Discord bot does is set up here: the server layout and roles, the entry check and rules,
          filters and moderation, the mod log, automatic posts and the case history. These switches control the bot, not Discord's own settings.</p></div>
      <div class="panel" id="discordBot"><div class="spinner"></div></div>
      <div class="panel"><div class="panel-title">Permissions the bot needs</div>
        <ol class="small" style="margin:0;padding-left:18px">
          <li><a class="btn small" href="${esc(d.invite_url)}" target="_blank" rel="noopener">${icon('discord')} Add the bot to the server</a> (with Administrator, so it can make roles and channels).</li>
          <li style="margin-top:6px">In Discord → Server Settings → <b>Roles</b>, drag the bot's role to the <b>top</b>: it can only manage roles below its own.</li>
          <li style="margin-top:6px"><a href="${esc(d.portal_url)}" target="_blank" rel="noopener">Developer Portal → Bot</a> → turn on <b>Server Members Intent</b> and <b>Message Content Intent</b> → Save, then press Reconnect above.</li>
        </ol></div>`,
    server: () => `<div class="panel"><div class="panel-title">Server</div>
        <p class="muted small" style="margin-top:0">The bot builds the WPG layout (roles, categories, channels and who can see or talk in each) and keeps
          members' roles in step with the app. Start on a test server, then switch the ID to the main server and build again:
          it reuses what's already there by name and never deletes channels or roles it didn't make.</p>
        <form id="dsForm" class="form-grid">
          <label class="field"><span>Discord server ID (right-click the server → Copy Server ID)</span><input type="text" name="guild_id" value="${esc(d.guild_id)}" inputmode="numeric"></label>
          <label class="field"><span>Game roles: hours played on Steam</span><input type="number" name="game_hours" min="10" value="${esc(d.game_hours)}"></label>
          <label class="field"><span>Wardogs role: hours of Wardogs on Steam</span><input type="number" name="wardogs_hours" min="1" value="${esc(d.wardogs_hours)}"></label>
          <label class="check" style="grid-column:1/-1"><input type="checkbox" name="sync_roles" ${d.sync_roles ? 'checked' : ''}> Keep members' roles in step (every 2 minutes and straight after changes in the app)</label>
          <div class="row" style="grid-column:1/-1"><button class="btn primary">Save</button></div>
        </form></div>
      <div class="panel"><div class="panel-title">Build the layout</div>
        <label class="check small"><input type="checkbox" id="dsPosts"> Also send the app's Discord posts here (go-live, rank-ups, live leaderboard, staff alerts, voice list). Leave off on a test server.</label>
        <div class="row" style="margin-top:10px"><button class="btn" id="dsPreview">Preview</button><button class="btn primary" id="dsBuild">Build server</button></div>
        <div id="dsOut" class="small" style="margin-top:10px"></div></div>
      <div class="panel"><div class="panel-title">Staff roles</div>
        <p class="small muted" style="margin-top:0">Your server's own Owner, Administrator and Moderator roles (in Discord: Server Settings → Roles → ⋯ → Copy Role ID).
          Owner and Administrator get full admin, Moderator the moderator permissions, and the bot puts them straight under its own role in that order
          (and keeps them there). The staff channels open to Administrator and Moderator.</p>
        <form id="dsStaffRoles" class="form-grid">
          <label class="field"><span>Owner role ID</span><input type="text" name="owner" inputmode="numeric" value="${esc(d.staff_roles.owner)}" required></label>
          <label class="field"><span>Administrator role ID</span><input type="text" name="admin" inputmode="numeric" value="${esc(d.staff_roles.admin)}" required></label>
          <label class="field"><span>Moderator role ID</span><input type="text" name="mod" inputmode="numeric" value="${esc(d.staff_roles.mod)}" required></label>
          ${d.me_owner ? `<label class="check" style="grid-column:1/-1"><input type="checkbox" name="give_me" ${d.me_linked ? 'checked' : 'disabled'}> Give me Administrator on Discord${d.me_linked ? '' : ' <span class="muted">(link your Discord first: type /link in Discord)</span>'}</label>` : ''}
          <div class="row" style="grid-column:1/-1"><button class="btn primary">Save &amp; fix staff roles now</button>${d.me_linked && d.staff_roles.owner ? '<button type="button" class="btn ghost" id="dsDropOwner">Take the Owner role off me</button>' : ''}</div>
        </form>
        <div id="dsStaffRolesOut" class="small" style="margin-top:8px"></div></div>
      <div class="panel"><div class="panel-title">Roles</div>
        <p class="small muted" style="margin-top:0">The app gives <b>WPG Community</b> to everyone who passes the entry check (to everyone if it's off), <b>Wardogs</b> to Wardogs players (they say yes to "Do you play Wardogs?" after the entry check or tap <b>Wardogs player</b> in #pick-roles, or they've linked the app with ${esc(d.wardogs_hours)}+ hours of Wardogs on Steam) and <b>WPG Member</b> to full members. For members who linked their Discord with <b>/link</b> it also manages
          Admin / Moderator (given to app admins and mods, never taken away), WPG Member, Combat Command (CO, XO, Deputy), their unit, Unit Leader, their faction and a grey role for every Steam game
          they've played ${esc(d.game_hours)}+ hours (show only). Content Creator, Partner and Military Vet are given by hand; members pick PC / Xbox / PlayStation / Switch / 18+ in #pick-roles.
          Roles on members who haven't linked are never taken away.</p>
        <div class="small">${s.at ? `${s.ok ? '✅' : '⚠️'} Last sync ${esc(when(s.at))}: ${s.ok
          ? `${s.members} on the server, ${s.linked} linked · ${s.added} roles given, ${s.removed} taken away · ${s.game_roles} game roles`
          : `<span style="color:var(--red)">${esc(s.reason || 'failed')}</span>`}` : '<span class="muted">Not synced yet.</span>'}</div>
        <div class="row" style="margin-top:10px"><button class="btn" id="dsSyncNow">${icon('refresh')} Sync roles now</button>${d.backup_at ? '<button class="btn ghost" id="dsStaffBack">Give old staff their roles back</button>' : ''}</div>
        <div id="dsStaffOut" class="small" style="margin-top:10px"></div></div>
      <div class="panel"><div class="panel-title">Tidy up an existing server</div>
        <p class="small muted" style="margin-top:0">For a server that's been running a while. Channels keep their names, places and messages; they're matched
          to the layout by name (emoji and brackets ignored) and get the layout's permissions. Roles with 5 or more members are kept, plus staff, the
          app's roles, dividers and bots' roles; the rest are removed (untick any to keep them). Kept roles lose risky permissions unless they're staff.
          Bots are left alone. Everything is backed up first. <b>Scan</b> changes nothing.</p>
        <div class="form-grid">
          <label class="field"><span>Count members from another server (optional: when testing on a copy, put the real server's ID here)</span><input type="text" id="dsCountFrom" inputmode="numeric" placeholder="Leave empty normally"></label>
        </div>
        <div class="row" style="margin-top:6px"><button class="btn" id="dsTidyScan">Scan</button>${d.backup_at ? `<a class="btn ghost" href="/api/admin/discord-server/backup">Download backup (${esc(when(d.backup_at))})</a>` : ''}</div>
        <div id="dsTidyOut" class="small" style="margin-top:10px"></div></div>
      <div class="panel"><div class="panel-title">Other bots</div>
        <p class="small muted" style="margin-top:0">Lists every other bot on the server, what it can do and what bots have changed lately (from Discord's audit log).
          You choose which bots to kick (security bots are ticked). The rest lose every role and permission: their own built-in role is left with no permissions,
          roles only bots had are deleted and channel permissions given to bots are removed. Everything is backed up first. <b>Scan</b> changes nothing.
          The WPG bot can only change bots whose role is <b>below</b> its own, so drag the WPG Barracks role to the top of the role list first.</p>
        <div class="row"><button class="btn" id="dsBotScan">Scan bots</button></div>
        <div id="dsBotOut" class="small" style="margin-top:10px"></div></div>`,
    entry: () => `<div class="panel"><div class="panel-title">Entry check &amp; rules</div>
        <p class="small muted" style="margin-top:0">New joiners only see #welcome and #rules. The button under the rules asks them to type a short code and answer
          one question; passing gives <b>WPG Community</b>. Accounts newer than the minimum age wait for staff (Let in / Kick in #staff-chat or below).
          3 failed tries = removed; anyone not in after the time limit is removed (they can rejoin). Members already on the server are never affected.</p>
        <form id="dsEntry" class="form-grid">
          <label class="check" style="grid-column:1/-1"><input type="checkbox" name="enabled" ${d.entry.enabled ? 'checked' : ''}> Entry check on${d.entry.since ? ` <span class="muted small">(since ${esc(when(d.entry.since))})</span>` : ''}</label>
          <label class="field"><span>Accounts younger than … days wait for staff</span><input type="number" name="min_age_days" min="0" value="${esc(d.entry.min_age_days)}"></label>
          <label class="field"><span>Remove people not in after … hours</span><input type="number" name="kick_hours" min="1" value="${esc(d.entry.kick_hours)}"></label>
          <label class="field" style="grid-column:1/-1"><span>Server rules (shown in #rules)</span><textarea name="rules" rows="10">${esc(d.entry.rules)}</textarea></label>
          <label class="field" style="grid-column:1/-1"><span>Entry questions: one per line, "question | answer" (several answers with commas). Questions up to 45 characters.</span><textarea name="quiz" rows="4">${esc(d.entry.quiz)}</textarea></label>
          <div class="row" style="grid-column:1/-1"><button class="btn primary">Save</button><button type="button" class="btn" id="dsPosts2">Update the rules post &amp; buttons on Discord</button></div>
        </form>
        ${d.held.length ? `<div style="margin-top:12px"><b>Waiting to be let in</b>${d.held.map((h) => `<div class="row" style="margin-top:6px;gap:8px"><span class="grow">${esc(h.user_name)} <span class="muted small">· ${esc(when(h.updated_at))}</span></span>
          <button class="btn small" data-held="${esc(h.discord_id)}" data-act="letin">Let in</button><button class="btn small danger" data-held="${esc(h.discord_id)}" data-act="kick">Kick</button></div>`).join('')}</div>` : '<p class="muted small" style="margin:10px 0 0">Nobody is waiting to be let in.</p>'}
      </div>`,
    commands: () => `<div class="panel"><div class="panel-title">Who can use each command</div>
        <p class="muted small" style="margin-top:0">Tick who can use each command (any mix). <b>Anyone</b> = everyone on Discord. People count as their app rank once
          linked with /link; Discord admins count as Admins, and anyone who can kick, ban or time out counts as Mods. Nothing ticked = the command is
          removed from Discord. Commands only for Mods / Admins are also hidden in Discord from everyone else. /link and /unlink are Anyone or off.</p>
        <form id="dsCmds"><div class="dc-cmds">
          <div class="dc-cmd head"><span></span>${d.command_groups.map(([, l]) => `<span>${esc(l)}</span>`).join('')}</div>
          ${d.commands.map((c, i) => `${i === 0 || c.moderator !== d.commands[i - 1].moderator ? `<div class="dc-cmd group"><b>${c.moderator ? 'Moderator commands' : 'Member commands'}</b></div>` : ''}
            <div class="dc-cmd" title="${esc(c.description)}"><span><b>/${esc(c.name)}</b> <em>${esc(c.description)}</em></span>
              ${d.command_groups.map(([k, l]) => `<label aria-label="${esc(l)}"><input type="checkbox" data-cmd="${esc(c.name)}" value="${k}"${c.groups.includes(k) ? ' checked' : ''}${['link', 'unlink'].includes(c.name) && k !== 'everyone' ? ' disabled' : ''}></label>`).join('')}</div>`).join('')}
        </div>
        <div class="row" style="margin-top:12px"><button class="btn primary">Save &amp; update Discord</button><button type="button" class="btn ghost" id="dsCmdDefaults">Back to defaults</button></div>
        </form></div>`,
    filters: () => `<div class="panel"><div class="panel-title">Filters &amp; moderation</div>
        <form id="dsMod">
          ${switchList(DISCORD_SWITCHES.filters)}
          <div class="form-grid">
            <label class="field"><span>Warnings before a 1-hour timeout</span><input type="number" name="timeout_at" min="1" value="${esc(d.mod.timeout_at)}"></label>
            <label class="field"><span>Warnings before a kick</span><input type="number" name="kick_at" min="1" value="${esc(d.mod.kick_at)}"></label>
            <label class="field" style="grid-column:1/-1"><span>Blocked words or phrases (one per line; * = anything)</span><textarea name="blocked_words" rows="3">${esc(d.mod.blocked_words)}</textarea></label>
          </div>
          <div class="row" style="margin-top:10px"><button class="btn primary">Save &amp; update Discord</button></div>
        </form></div>`,
    logs: () => `<div class="panel"><div class="panel-title">Logs &amp; extras</div>
        <form id="dsLogs">${switchList(DISCORD_SWITCHES.logs)}
          <div class="row"><button class="btn primary">Save</button></div></form>
        ${d.tickets ? `<p class="small" style="margin:10px 0 0"><b>${d.tickets} open ticket${d.tickets === 1 ? '' : 's'}</b> in 🎫 TICKETS.</p>` : ''}</div>`,
    posts: () => '<div id="dsPostsBox"><div class="spinner"></div></div>',
    rooms: () => '<div id="dsRoomsBox"><div class="spinner"></div></div>',
    botposts: () => '<div id="dsBotPostsBox"><div class="spinner"></div></div>',
    scheduled: () => '<div id="dsSchedBox"><div class="spinner"></div></div>',
    cases: () => `<div class="panel"><div class="panel-title">Cases <span class="sub">newest 40</span></div>
        ${d.cases.length ? `<div class="small">${d.cases.map((c) => `<div style="padding:6px 0;border-bottom:1px solid var(--line)${c.removed ? ';opacity:.5;text-decoration:line-through' : ''}">
          <b>#${c.id}</b> ${esc(c.action)}${c.minutes ? ` ${c.minutes} min` : ''} · <b>${esc(c.user_name)}</b> <span class="muted">(${esc(c.user_id)})</span> · by ${esc(c.mod_name)} · ${esc(when(c.created_at))}${c.reason ? `<br><span class="muted">${esc(c.reason)}</span>` : ''}</div>`).join('')}</div>` : '<p class="muted small" style="margin:0">None yet.</p>'}
        <p class="muted small" style="margin:10px 0 0">In Discord, staff can use /cases on a member, and /unwarn with a case number to remove a warning.</p></div>`,
  };
  body.innerHTML = `<div class="stack">${DISCORD_SECTIONS.map(([k, label]) => `<details class="panel dc-sec" data-sec="${k}"${open.has(k) ? ' open' : ''}>
      <summary><b>${esc(label)}</b><span class="muted small">${esc(summary[k])}</span></summary>
      <div class="dc-in">${html[k]()}</div></details>`).join('')}</div>`;
  // Remember which sections are open; load the slow ones (bot checklist, post settings) when first opened.
  const loaded = new Set();
  const load = (k) => {
    if (loaded.has(k)) return;
    loaded.add(k);
    if (k === 'bot') discordBotPanel(body.querySelector('#discordBot'));
    if (k === 'posts') loadPosts();
    if (k === 'rooms') roomsPanel(body.querySelector('#dsRoomsBox'));
    if (k === 'botposts') botPostsPanel(body.querySelector('#dsBotPostsBox'));
    if (k === 'scheduled') scheduledPanel(body.querySelector('#dsSchedBox'));
  };
  body.querySelectorAll('details.dc-sec').forEach((el) => {
    if (el.open) load(el.dataset.sec);
    el.addEventListener('toggle', () => {
      const o = openSections();
      if (el.open) { o.add(el.dataset.sec); load(el.dataset.sec); } else o.delete(el.dataset.sec);
      try { localStorage.setItem(OPEN_KEY, JSON.stringify([...o])); } catch { /* storage blocked */ }
    });
  });
  const reload = () => discordServerTab(body);
  const switches = (form) => Object.fromEntries([...form.querySelectorAll('[data-sw]')].map((el) => [el.dataset.sw, el.checked]));
  const pushPosts = async () => {
    const r = await api('admin/discord-server/posts', { method: 'POST', body: {} });
    toast('Discord updated', r.log.length ? r.log.join(' · ').slice(0, 200) : 'The rules post, buttons and AutoMod are up to date.');
  };
  body.querySelector('#dsReconnect')?.addEventListener('click', async () => {
    try { await api('admin/discord-server/reconnect', { method: 'POST', body: {} }); toast('Reconnecting', 'Give it a few seconds, then reopen this page.'); } catch (x) { fail(x); }
  });
  {
    const out = body.querySelector('#dsOut');
    const show = (title, lines) => { out.innerHTML = `<b>${esc(title)}</b>${lines.length ? `<ul style="margin:6px 0 0;padding-left:18px;max-height:320px;overflow:auto">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p class="muted" style="margin:4px 0 0">Nothing to change: the server already matches.</p>'}`; };
    body.querySelector('#dsForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try { await api('admin/discord-server', { method: 'PUT', body: { guild_id: f.guild_id.value, game_hours: f.game_hours.value, wardogs_hours: f.wardogs_hours.value, sync_roles: f.sync_roles.checked } }); toast('Saved'); reload(); } catch (x) { fail(x); }
    };
    body.querySelector('#dsPreview').onclick = async () => {
      out.innerHTML = '<div class="spinner"></div>';
      try {
        const r = await api('admin/discord-server/preview', { method: 'POST', body: { use_posts: body.querySelector('#dsPosts').checked } });
        show(`Preview for ${r.server}: ${r.actions.length} change${r.actions.length === 1 ? '' : 's'}`, r.actions);
      } catch (x) { out.innerHTML = `<span style="color:var(--red)">${esc(x.message)}</span>`; }
    };
    body.querySelector('#dsBuild').onclick = async () => {
      if (!(await confirmBox('Build the layout on this Discord server now?'))) return;
      try {
        await api('admin/discord-server/build', { method: 'POST', body: { use_posts: body.querySelector('#dsPosts').checked } });
        const poll = async () => {
          if (!document.body.contains(out)) return;
          const st = (await api('admin/discord-server')).build;
          show(st.running ? 'Building…' : st.error ? 'Build stopped' : 'Build finished', st.log);
          if (st.running) setTimeout(poll, 1500);
        };
        poll();
      } catch (x) { fail(x); }
    };
    const tidyOut = body.querySelector('#dsTidyOut');
    body.querySelector('#dsTidyScan').onclick = async () => {
      tidyOut.innerHTML = '<div class="spinner"></div>';
      const countFrom = body.querySelector('#dsCountFrom').value.trim();
      try {
        const r = await api('admin/discord-server/tidy/scan', { method: 'POST', body: { count_from: countFrom } });
        const removing = r.roles.filter((x) => !x.keep).length;
        tidyOut.innerHTML = `<b>${esc(r.server)}</b>${r.count_from ? ` <span class="muted">(member counts from server ${esc(r.count_from)})</span>` : ''}
          <div style="margin:8px 0 4px"><b>Roles</b> <span class="muted">· ${r.roles.length} roles, ${removing} to remove (ticked)</span></div>
          <div style="max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:8px">${r.roles.map((x) => `<label class="row" style="gap:8px;padding:6px 8px;border-bottom:1px solid var(--line);flex-wrap:nowrap;${x.keep ? '' : 'background:rgba(229,72,77,.08)'}">
            <input type="checkbox" data-remove="${esc(x.id)}"${x.keep ? '' : ' checked'}${x.locked ? ' disabled' : ''} title="Remove this role">
            <span style="width:12px;height:12px;border-radius:50%;flex:none;background:${esc(x.color || '#5d7a94')}"></span>
            <span class="grow" style="min-width:0"><b>${esc(x.name)}</b> <span class="muted">· ${esc(x.reason)}</span>${x.fix.length ? `<br><span style="color:#f5a524">Takes off: ${esc(x.fix.join(', '))}</span>` : ''}</span>
            <span class="muted" style="flex:none">${x.members}</span></label>`).join('')}</div>
          <p class="muted" style="margin:4px 0 0">Ticked = removed. Greyed-out boxes can't be removed (staff, app, divider or bot roles).</p>
          <div style="margin:10px 0 4px"><b>Bots</b> <span class="muted">· kept (the server owner can kick any that aren't needed)</span></div>
          <div class="muted">${r.bots.map((b) => esc(b.name)).join(', ') || 'None'}</div>
          <details style="margin-top:10px"><summary><b>Channels &amp; layout</b> <span class="muted">· ${r.actions.length} change${r.actions.length === 1 ? '' : 's'}</span></summary>
            <ul style="margin:6px 0 0;padding-left:18px;max-height:300px;overflow:auto">${r.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></details>
          <div class="row" style="margin-top:12px"><button class="btn primary" id="dsTidyGo">Back up &amp; tidy up now</button></div>`;
        tidyOut.querySelector('#dsTidyGo').onclick = async () => {
          const remove = [...tidyOut.querySelectorAll('[data-remove]:checked:not(:disabled)')].map((el) => el.dataset.remove);
          if (!(await confirmBox(`Tidy up ${r.server} now? ${remove.length} role${remove.length === 1 ? '' : 's'} will be removed and channel permissions reset. A backup is made first.`))) return;
          try {
            await api('admin/discord-server/tidy', { method: 'POST', body: { remove, count_from: countFrom } });
            const poll = async () => {
              if (!document.body.contains(tidyOut)) return;
              const st = (await api('admin/discord-server')).build;
              tidyOut.innerHTML = `<b>${st.running ? 'Tidying up…' : st.error ? 'Stopped' : 'Finished'}</b><ul style="margin:6px 0 0;padding-left:18px;max-height:360px;overflow:auto">${st.log.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${st.running ? '' : '<p class="muted">Press <b>Sync roles now</b> above to give everyone their roles straight away (it also runs by itself every 2 minutes).</p>'}`;
              if (st.running) setTimeout(poll, 1500);
            };
            poll();
          } catch (x) { fail(x); }
        };
      } catch (x) { tidyOut.innerHTML = `<span style="color:var(--red)">${esc(x.message)}</span>`; }
    };
    const botOut = body.querySelector('#dsBotOut');
    body.querySelector('#dsBotScan').onclick = async () => {
      botOut.innerHTML = '<div class="spinner"></div>';
      try {
        const r = await api('admin/discord-server/bots/scan', { method: 'POST', body: {} });
        const stuck = r.bots.filter((b) => b.above);
        botOut.innerHTML = `<b>${esc(r.server)}</b> <span class="muted">· ${r.bots.length} other bot${r.bots.length === 1 ? '' : 's'}</span>
          ${stuck.length ? `<p style="color:var(--red);margin:6px 0">${stuck.map((b) => esc(b.name)).join(', ')} ${stuck.length === 1 ? 'has a role' : 'have roles'} above the WPG bot's, so the WPG bot can't kick or change ${stuck.length === 1 ? 'it' : 'them'}. Drag the WPG Barracks role to the very top (Server Settings → Roles) and scan again, or the server owner can kick ${stuck.length === 1 ? 'it' : 'them'} by hand.</p>` : ''}
          <div style="max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:8px;margin-top:8px">${r.bots.map((b) => `<label class="row" style="gap:8px;padding:6px 8px;border-bottom:1px solid var(--line);flex-wrap:nowrap;align-items:flex-start;${b.security ? 'background:rgba(229,72,77,.08)' : ''}">
            <input type="checkbox" data-kick="${esc(b.id)}"${b.security && !b.above ? ' checked' : ''}${b.above ? ' disabled' : ''} title="Kick this bot" style="margin-top:3px">
            <span class="grow" style="min-width:0"><b>${esc(b.name)}</b>${b.security ? ' <span style="color:var(--red)">· security bot</span>' : ''}${b.above ? ' <span style="color:var(--red)">· above the WPG bot</span>' : ''}
              <br><span class="muted">Roles: ${b.roles.map((x) => `${esc(x.name)}${x.risky.length ? ` <span style="color:#f5a524">(${esc(x.risky.join(', '))})</span>` : ''}`).join(', ') || 'none'}</span>
              ${b.made?.length ? `<br><span style="color:#f5a524">Made: ${esc(b.made.join(', '))}</span>` : ''}
              ${b.channels.length ? `<br><span class="muted">Own permissions in: ${esc(b.channels.slice(0, 12).join(', '))}${b.channels.length > 12 ? ` and ${b.channels.length - 12} more` : ''}</span>` : ''}</span></label>`).join('') || '<div class="muted" style="padding:8px">No other bots.</div>'}</div>
          <p class="muted" style="margin:4px 0 0">Ticked = kicked.</p>
          <details style="margin-top:10px"${r.changes.length ? ' open' : ''}><summary><b>What bots changed lately</b> <span class="muted">· ${r.changes.length} change${r.changes.length === 1 ? '' : 's'}</span></summary>
            ${r.audit_problem ? `<p style="color:var(--red)">${esc(r.audit_problem)}</p>` : ''}
            <ul style="margin:6px 0 0;padding-left:18px;max-height:300px;overflow:auto">${r.changes.map((c) => `<li><span class="muted">${esc(when(c.at))}</span> <b>${esc(c.bot)}</b> ${esc(c.what)}${c.reason ? ` <span class="muted">(${esc(c.reason)})</span>` : ''}</li>`).join('') || '<li class="muted">Nothing in the audit log.</li>'}</ul></details>
          <label class="check" style="margin-top:10px"><input type="checkbox" id="dsBotUndo" checked> Delete the channels and roles the kicked bots made (e.g. a security bot's verify channel and Unverified role), so new joiners go through the WPG entry check. Anyone still waiting to get in gets a fresh 24 hours.</label>
          <label class="check"><input type="checkbox" id="dsBotStrip" checked> Take every role and permission off the bots that stay</label>
          <label class="check"><input type="checkbox" id="dsBotLayout"${r.backup_at ? ' checked' : ''}> Then set the WPG layout's channel permissions again (as Tidy up does, no roles removed), so #welcome and #rules are open to new joiners</label>
          ${r.backup_at ? `<label class="check"><input type="checkbox" id="dsBotOrder"> Put channels back in the order and categories they had before the tidy-up (backup of ${esc(when(r.backup_at))})</label>` : ''}
          <div class="row" style="margin-top:12px"><button class="btn primary" id="dsBotGo">Back up &amp; clean up bots now</button></div>`;
        botOut.querySelector('#dsBotGo').onclick = async () => {
          const kick = [...botOut.querySelectorAll('[data-kick]:checked:not(:disabled)')].map((el) => el.dataset.kick);
          const strip = botOut.querySelector('#dsBotStrip').checked;
          const order = !!botOut.querySelector('#dsBotOrder')?.checked;
          const undo = botOut.querySelector('#dsBotUndo').checked;
          const relayout = botOut.querySelector('#dsBotLayout').checked;
          if (!(await confirmBox(`Clean up bots on ${r.server} now? ${kick.length} bot${kick.length === 1 ? '' : 's'} will be kicked${strip ? ' and the others lose their roles and permissions' : ''}. A backup is made first.`))) return;
          try {
            await api('admin/discord-server/bots', { method: 'POST', body: { kick, strip, undo, order, relayout } });
            const poll = async () => {
              if (!document.body.contains(botOut)) return;
              const st = (await api('admin/discord-server')).build;
              botOut.innerHTML = `<b>${st.running ? 'Cleaning up…' : st.error ? 'Stopped' : 'Finished'}</b><ul style="margin:6px 0 0;padding-left:18px;max-height:360px;overflow:auto">${st.log.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${st.running ? '' : '<p class="muted"><a href="/api/admin/discord-server/bots/backup">Download the backup</a> · Scan bots again to check.</p>'}`;
              if (st.running) setTimeout(poll, 1500);
            };
            poll();
          } catch (x) { fail(x); }
        };
      } catch (x) { botOut.innerHTML = `<span style="color:var(--red)">${esc(x.message)}</span>`; }
    };
    body.querySelector('#dsStaffRoles').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const out = body.querySelector('#dsStaffRolesOut');
      f.querySelector('button').disabled = true;
      out.innerHTML = '<div class="spinner"></div>';
      try {
        const r = await api('admin/discord-server/staff-roles', { method: 'POST', body: { owner: f.owner.value, admin: f.admin.value, mod: f.mod.value, give_me: !!f.give_me?.checked } });
        out.innerHTML = `<ul style="margin:0;padding-left:18px">${r.log.map((l) => `<li>${esc(l)}</li>`).join('') || '<li>Nothing needed changing.</li>'}</ul>`;
      } catch (x) { out.innerHTML = `<span style="color:var(--red)">${esc(x.message)}</span>`; }
      f.querySelector('button').disabled = false;
    };
    const dropOwner = body.querySelector('#dsDropOwner');
    if (dropOwner) dropOwner.onclick = async () => {
      const out = body.querySelector('#dsStaffRolesOut');
      dropOwner.disabled = true;
      try {
        const r = await api('admin/discord-server/staff-roles/drop-owner', { method: 'POST', body: {} });
        out.innerHTML = `<ul style="margin:0;padding-left:18px">${r.log.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
      } catch (x) { out.innerHTML = `<span style="color:var(--red)">${esc(x.message)}</span>`; }
      dropOwner.disabled = false;
    };
    const staffOut = body.querySelector('#dsStaffOut');
    const staffBtn = body.querySelector('#dsStaffBack');
    if (staffBtn) staffBtn.onclick = async () => {
      staffOut.innerHTML = '<div class="spinner"></div>';
      try {
        const r = await api('admin/discord-server/restore-staff', { method: 'POST', body: {} });
        if (!r.people.length) { staffOut.innerHTML = `<span class="muted">Everyone who was staff at the backup (${esc(when(r.backup_at))}) still has their roles.</span>`; return; }
        staffOut.innerHTML = `<b>From the backup of ${esc(when(r.backup_at))}</b>
          <ul style="margin:6px 0 0;padding-left:18px;max-height:300px;overflow:auto">${r.people.map((p) => `<li><b>${esc(p.name)}</b> <span class="muted">had ${esc(p.had.join(', '))}</span> → gets ${esc(p.give.join(', '))}</li>`).join('')}</ul>
          <div class="row" style="margin-top:8px"><button class="btn primary" id="dsStaffGo">Give ${r.people.length} ${r.people.length === 1 ? 'person' : 'people'} their roles back</button></div>`;
        staffOut.querySelector('#dsStaffGo').onclick = async (e) => {
          e.target.disabled = true;
          try {
            const done = await api('admin/discord-server/restore-staff', { method: 'POST', body: { apply: true } });
            staffOut.innerHTML = `✅ Gave ${done.people.length} ${done.people.length === 1 ? 'person' : 'people'} their staff roles back.`;
          } catch (x) { fail(x); e.target.disabled = false; }
        };
      } catch (x) { staffOut.innerHTML = `<span style="color:var(--red)">${esc(x.message)}</span>`; }
    };
    body.querySelector('#dsSyncNow').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('admin/discord-server/sync', { method: 'POST', body: {} });
        if (!r.ok) toast('Not synced', r.reason); else toast('Roles synced', `${r.added} given, ${r.removed} taken away`);
        reload();
      } catch (x) { fail(x); e.target.disabled = false; }
    };
  }
  {
    body.querySelector('#dsEntry').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('admin/discord-server', { method: 'PUT', body: { entry: { enabled: f.enabled.checked, min_age_days: f.min_age_days.value, kick_hours: f.kick_hours.value, rules: f.rules.value, quiz: f.quiz.value } } });
        toast('Saved', 'Press "Update the rules post" to show new rules on Discord.');
        reload();
      } catch (x) { fail(x); }
    };
    body.querySelector('#dsPosts2').onclick = async () => { try { await pushPosts(); } catch (x) { fail(x); } };
    body.querySelectorAll('[data-held]').forEach((b) => {
      b.onclick = async () => {
        try { await api(`admin/discord-server/held/${b.dataset.held}`, { method: 'POST', body: { action: b.dataset.act } }); toast(b.dataset.act === 'letin' ? 'Let in' : 'Kicked'); reload(); } catch (x) { fail(x); }
      };
    });
  }
  body.querySelector('#dsCmds').onsubmit = async (e) => {
    e.preventDefault();
    const commands = Object.fromEntries(d.commands.map((c) => [c.name, [...e.target.querySelectorAll(`[data-cmd="${c.name}"]:checked`)].map((el) => el.value)]));
    try {
      const r = await api('admin/discord-server/commands', { method: 'PUT', body: { commands } });
      toast('Saved', r.discord?.ok ? 'Discord has the new command list (it can take a minute to show; restart Discord with Ctrl+R if not).' : `Saved in the app. Discord's list wasn't updated: ${r.discord?.reason || 'try Re-check & fix Discord setup in the Bot section'}`);
      reload();
    } catch (x) { fail(x); }
  };
  body.querySelector('#dsCmdDefaults').onclick = () => {
    for (const c of d.commands) body.querySelectorAll(`[data-cmd="${c.name}"]`).forEach((el) => { el.checked = c.default.includes(el.value); });
    toast('Defaults ticked', 'Press Save to use them.');
  };
  {
    body.querySelector('#dsMod').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('admin/discord-server', { method: 'PUT', body: { switches: switches(f), mod: { timeout_at: f.timeout_at.value, kick_at: f.kick_at.value, blocked_words: f.blocked_words.value } } });
        await pushPosts().catch((x) => toast('Saved', `Discord's AutoMod wasn't updated: ${x.message}`));
        reload();
      } catch (x) { fail(x); }
    };
  }
  {
    body.querySelector('#dsLogs').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('admin/discord-server', { method: 'PUT', body: { switches: switches(e.target) } });
        if (d.guild_id) await pushPosts().catch(() => {});
        toast('Saved');
        reload();
      } catch (x) { fail(x); }
    };
  }
  async function loadPosts() {
    const st = await api('admin/settings');
    const box = body.querySelector('#dsPostsBox');
    const input = ([k, label, type]) => {
      const v = st[k] ?? '';
      if (type === 'check') return `<label class="check" style="grid-column:1/-1"><input type="checkbox" name="${k}" ${v === 'true' ? 'checked' : ''}> ${esc(label)}</label>`;
      return `<label class="field"><span>${esc(label)}</span><input type="${type === 'number' ? 'number' : 'text'}" name="${k}" value="${esc(v)}"></label>`;
    };
    box.innerHTML = `<form id="dsPostForm" class="stack">
      ${DISCORD_POSTS.map(([title, list]) => `<div class="panel"><div class="panel-title">${esc(title)}</div><div class="form-grid">${list.filter(([k]) => k in st).map(input).join('')}</div></div>`).join('')}
      <div class="row"><button class="btn primary">Save</button></div></form>
      <p class="muted small">Channel ID: in Discord turn on Developer Mode (Settings → Advanced), then right-click the channel → Copy Channel ID. Build server can fill these in for you.</p>`;
    box.querySelector('#dsPostForm').onsubmit = async (e) => {
      e.preventDefault();
      const out = {};
      for (const [, list] of DISCORD_POSTS) {
        for (const [k, , type] of list) {
          const el = e.target.elements[k];
          if (el) out[k] = type === 'check' ? String(el.checked) : el.value;
        }
      }
      try { await api('admin/settings', { method: 'PUT', body: out }); toast('Saved'); } catch (x) { fail(x); }
    };
  }
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
    ['facebook_url', 'Facebook page link'],
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
    ['tracker_enabled', 'Get global Wardogs stats from the keyed wardogs.tools player API (level, rank, cash, gold, worth, classes and rates)', 'check'],
    ['tracker_relink_prompts', 'When wardogs.tools stops updating a member, ask them to relink (in the app and by Discord message, reminded every 3 days, 3 times at most)', 'check'],
    ['sync_minutes', 'Re-sync each member every … minutes (min 15)', 'number'],
  ]],
  ['Cheat watch (staff only)', [
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
      ${step(d.post_channel, 'Channel for automatic posts', 'In Discord, right-click the channel → <b>Copy Channel ID</b> (turn on Developer Mode in Discord settings → Advanced if you can\'t see it). Paste it in <b>Channel ID for posts</b> under <a href="#/admin/discord-server?s=posts">Posts &amp; channels</a> (or let <b>Build server</b> fill it in), then <b>Send a test post</b>.')}
    </ol>
    <div class="row">
      <button type="button" class="btn" id="dbTest"${d.token && d.post_channel ? '' : ' disabled'}>Send a test post</button>
      <button type="button" class="btn ghost" id="dbReg"${d.token ? '' : ' disabled'}>Re-check &amp; fix Discord setup</button>
    </div>
    <p class="muted small" style="margin:10px 0 0">Commands: ${(d.commands_wanted || []).map((c) => `/${esc(c)}`).join(' ')}. Members type /link once to connect their Discord. Choose who can use each one in the Commands section.</p>
    <div style="border-top:1px solid var(--line);margin-top:14px;padding-top:12px">
      <b>Preview a card</b> <span class="muted small">— made here exactly as the bot makes it, without Discord.</span>
      <div class="row" style="margin-top:8px">
        <select id="dbCmd">${(d.commands_wanted || []).filter((c) => !['link', 'unlink', 'report'].includes(c)).map((c) => `<option value="${esc(c)}">/${esc(c)}</option>`).join('')}
          <optgroup label="Channel posts"><option value="post:promotion">Promotion post</option><option value="post:medal">Medal post</option><option value="post:wpgrank">WPG rank-up post</option><option value="post:bigwin">Big win post</option></optgroup></select>
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
  const ELSEWHERE = new Set(['combat_specialties', 'discord_recruit_channel', 'discord_giveaway_channel', 'discord_post_giveaways', 'discord_post_frames', 'steam_bot_enabled', 'discord_post_big_wins', 'big_win_amount', 'discord_money_channel', 'discord_money_board', 'discord_build_server_id', 'discord_sync_roles', 'discord_game_role_hours']); // Admin → Recruitment / Giveaways / Frames / Steam bot / Discord server
  const extra = Object.keys(s).filter((k) => !known.has(k) && !ELSEWHERE.has(k) && !k.startsWith('wpgxp_') && !k.startsWith('discord_')); // WPG XP amounts: Admin → WPG XP
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
    <p class="muted small" style="margin-top:16px">Discord bot settings (posts, channels, filters, entry check, server layout) are on the <a href="#/discord">Discord control</a> page.</p>
    <div class="panel" id="wardogsTest" style="margin-top:16px">
      <div class="panel-title">${icon('target')} wardogs.tools connection <span class="sub">global Wardogs stats</span></div>
      <p class="muted small" style="margin:0 0 10px">Asks wardogs.tools right now for the developer's example player and for you, and shows exactly what it answers. Only the key's length and first/last 3 characters are shown.</p>
      <button type="button" class="btn" id="wtTest">${icon('refresh')} Test the connection</button>
      <div id="wtOut" style="margin-top:10px"></div>
    </div>`;
  document.getElementById('wtTest').onclick = async (e) => {
    const btn = e.currentTarget;
    const out = document.getElementById('wtOut');
    btn.disabled = true;
    out.innerHTML = '<p class="muted small">Asking wardogs.tools…</p>';
    try {
      const d = await api('admin/wardogs-test', { method: 'POST', body: {} });
      const meaning = (r) => (r.error ? `couldn't reach wardogs.tools: ${r.error}`
        : r.status === 200 ? '✅ worked'
          : r.status === 401 || r.status === 403 ? '❌ key refused'
            : r.status === 404 ? 'not found (key accepted)' : `answered ${r.status}`);
      out.innerHTML = `<p class="small" style="margin:0 0 6px">Running version <b>${esc(d.version)}</b> · Key: ${d.key.set
        ? `<b>${d.key.length}</b> characters, starts <code>${esc(d.key.starts)}</code>, ends <code>${esc(d.key.ends)}</code>${d.key.tidied ? ' (spaces or quote marks were removed)' : ''}`
        : '<span style="color:var(--red)">WARDOGS_API_KEY is not set on this server</span>'}</p>
        ${d.results.map((r) => `<div class="small" style="margin-top:8px"><b>${esc(r.id)}</b>: ${esc(meaning(r))}${r.status ? ` <span class="muted">(${r.status}${r.server ? ` · ${esc(r.server)}` : ''})</span>` : ''}
          ${r.body ? `<pre class="small" style="white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0 0;max-height:160px;overflow:auto">${esc(r.body)}</pre>` : ''}</div>`).join('')}`;
    } catch (x) {
      out.innerHTML = `<p class="small" style="color:var(--red)">${esc(x.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  };
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
