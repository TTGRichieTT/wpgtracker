// Badges and achievements (server/badges.js): the Badge collection on profiles (with the 5-badge showcase),
// Admin → Badges, Admin → Events & tournaments, and the badges / WPG join date part of the member editor.
import { api, esc, state, toast, fail, modal, confirmBox, fmtNum, fmtDate } from './app.js';
import { icon } from './icons.js';
import { badgeHTML, RARITY } from './badgeart.js';

const RARITY_ORDER = Object.keys(RARITY);
const unitText = (n, unit) => (unit === '$' ? `$${fmtNum(n)}` : `${fmtNum(n)}${unit ? ` ${unit}` : ''}`);
const rarityPill = (r) => `<span class="pill" style="color:${RARITY[r]?.color};border-color:${RARITY[r]?.color}">${esc(RARITY[r]?.label || r)}</span>`;
const hours = (h) => (h >= 1 ? `${fmtNum(Math.round(h * 10) / 10)} h` : `${Math.round(h * 60)} min`);

function progressHtml(p) {
  if (!p) return '';
  const pct = Math.max(0, Math.min(100, (p.value / Math.max(0.01, p.target)) * 100));
  return `<div class="xpbar" style="height:6px;margin:6px 0 2px"><div style="width:${pct.toFixed(1)}%"></div></div><div class="muted small">${unitText(p.value, p.unit)} / ${unitText(p.target, p.unit)}</div>`;
}
function badgeModal(b, mine = false) {
  const md = modal(`<div class="row between"><h3 style="margin:0">${esc(b.name)}</h3><button class="btn ghost small" data-close>✕</button></div>
    <div class="row" style="gap:18px;align-items:center;margin-top:10px">${badgeHTML(b, 150, { locked: !b.unlocked })}
      <div class="stack" style="gap:6px">${rarityPill(b.rarity)} <span class="muted small">${esc(b.points)} Achievement Points</span>
        <div>${esc(b.description)}</div>
        ${b.limited ? '<b style="color:#ffe066">Limited edition</b>' : ''}
        ${b.temporary ? '<span class="muted small">Held while it applies.</span>' : ''}
        ${b.unlocked ? `<b style="color:var(--green)">Earned ${fmtDate(b.earned_at)}</b>` : `<span class="muted small">${esc(b.how || '')}</span>${progressHtml(b.progress)}`}
      </div></div>`);
  md.el.querySelector('[data-close]').onclick = md.close;
  if (mine && b.unlocked) {
    md.el.insertAdjacentHTML('beforeend', `<div class="row" style="margin-top:12px"><button class="btn primary" id="bdShare">${icon('discord')} Share to Discord</button><span class="small muted" id="bdShareMsg"></span></div>`);
    md.el.querySelector('#bdShare').onclick = async (e) => {
      e.target.disabled = true;
      try {
        await api(`me/badges/${b.id}/share`, { method: 'POST', body: {} });
        md.el.querySelector('#bdShareMsg').textContent = 'Posted to the WPG Discord.';
      } catch (x) { md.el.querySelector('#bdShareMsg').textContent = x.message; e.target.disabled = false; }
    };
  }
}

// ---------- Profile ----------
// Showcase: the badges a member picked, under their name.
export function showcaseHtml(list, size = 40) {
  return list?.length ? `<div class="row" style="gap:6px;margin-top:8px">${list.map((b) => `<span title="${esc(`${b.name} · ${RARITY[b.rarity]?.label || ''}`)}">${badgeHTML(b, size)}</span>`).join('')}</div>` : '';
}
export async function profileBadgesPanel(box, user, showBox) {
  const mine = user.id === state.me.id;
  let d;
  try { d = await api(`users/${user.id}/badges`); } catch (x) { box.innerHTML = ''; return; }
  const byId = new Map(d.badges.map((b) => [b.id, b]));
  if (showBox) showBox.innerHTML = showcaseHtml(d.showcase.map((id) => byId.get(id)).filter(Boolean));
  let sort = 'rarity';
  let picking = null;
  // Earned badges first; all of them (78+) only when asked, a screenful at a time.
  let show = d.badges.some((b) => b.unlocked) ? 'earned' : 'all';
  let more = false;
  const t = d.totals;
  const st = d.stream;
  const draw = () => {
    const list = [...d.badges];
    if (sort === 'rarity') list.sort((a, b) => (b.unlocked - a.unlocked) || RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity));
    if (sort === 'category') list.sort((a, b) => a.category.localeCompare(b.category) || (b.unlocked - a.unlocked));
    if (sort === 'date') list.sort((a, b) => (b.unlocked - a.unlocked) || new Date(b.earned_at || 0) - new Date(a.earned_at || 0));
    const filtered = picking || show === 'earned' ? list.filter((b) => b.unlocked) : show === 'locked' ? list.filter((b) => !b.unlocked) : list;
    const shown = more || picking ? filtered : filtered.slice(0, 21);
    box.innerHTML = `<div class="panel">
      <div class="row between"><div class="panel-title" style="margin:0">${icon('medal')} Badge collection</div>
        <div class="row small" style="gap:6px">
          <select id="bdShow" class="small">${[['earned', 'Earned'], ['all', 'All badges'], ['locked', 'Not earned yet']].map(([k, l]) => `<option value="${k}" ${show === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <select id="bdSort" class="small">${[['rarity', 'By rarity'], ['category', 'By category'], ['date', 'By date earned']].map(([k, l]) => `<option value="${k}" ${sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          ${mine ? (picking ? `<button class="btn small primary" id="bdSave">Save showcase (${picking.size}/5)</button><button class="btn small ghost" id="bdCancel">Cancel</button>` : '<button class="btn small" id="bdPick">Choose showcase</button>') : ''}
        </div></div>
      <div class="row" style="gap:18px;margin:10px 0;flex-wrap:wrap">
        <div><b style="font:700 26px var(--head)">${fmtNum(t.points)}</b> <span class="muted small">Achievement Points</span></div>
        <div><b style="font:700 22px var(--head)">${t.badges} / ${t.badges_total}</b> <span class="muted small">badges</span></div>
        <div><b style="font:700 22px var(--head)">${t.medals}</b> <span class="muted small">medals</span></div>
        <div><b style="font:700 22px var(--head)">${t.completion}%</b> <span class="muted small">complete</span></div>
      </div>
      ${d.loyalty.joined ? `<p class="small" style="margin:0 0 6px">🐺 In WPG since <b>${fmtDate(d.loyalty.joined)}</b> (${d.loyalty.months >= 12 ? `${Math.floor(d.loyalty.months / 12)} yr ${d.loyalty.months % 12} mo` : `${d.loyalty.months} months`})${d.loyalty.verified ? ' · verified by staff' : ''}</p>`
        : '<p class="muted small" style="margin:0 0 6px">🐺 Loyalty badges start once staff have checked their original WPG join date.</p>'}
      ${st.streams || st.hours ? `<p class="small" style="margin:0 0 10px">📺 <b>${fmtNum(st.streams)}</b> streams · <b>${hours(st.hours)}</b> streamed · best day <b>${hours(st.bestDay)}</b> · longest <b>${hours(st.longest)}</b> · streak <b>${st.streak}</b> day${st.streak === 1 ? '' : 's'} (best ${st.bestStreak})</p>` : ''}
      ${picking ? '<p class="small" style="margin:0 0 8px">Tap up to 5 badges to show under your name.</p>' : ''}
      <div class="badge-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px">${shown.map((b) => `
        <button type="button" class="badge-cell" data-b="${b.id}" style="background:${picking?.has(b.id) ? 'rgba(41,182,246,.18)' : 'rgba(255,255,255,.03)'};border:1px solid ${picking?.has(b.id) ? 'var(--accent)' : 'var(--line)'};border-radius:10px;padding:8px 6px;color:inherit;text-align:center;cursor:pointer" title="${esc(`${b.name} — ${b.description}`)}">
          ${badgeHTML(b, 64, { locked: !b.unlocked })}
          <div style="font:600 12px var(--head);text-transform:uppercase;margin-top:4px;line-height:1.15">${esc(b.name)}</div>
          <div style="font-size:11px;color:${RARITY[b.rarity]?.color}">${esc(RARITY[b.rarity]?.label || '')}${b.limited ? ' · Limited' : ''}</div>
          ${b.unlocked ? `<div class="muted" style="font-size:11px">${fmtDate(b.earned_at)}</div>` : b.progress ? progressHtml(b.progress) : '<div class="muted" style="font-size:11px">Given by staff</div>'}
        </button>`).join('') || '<p class="muted">No badges here yet.</p>'}</div>
      ${shown.length < filtered.length ? `<div class="row" style="justify-content:center;margin-top:10px"><button class="btn small" id="bdMore">Show all ${filtered.length}</button></div>` : ''}</div>`;
    box.querySelector('#bdSort').onchange = (e) => { sort = e.target.value; draw(); };
    box.querySelector('#bdShow').onchange = (e) => { show = e.target.value; more = false; draw(); };
    box.querySelector('#bdMore')?.addEventListener('click', () => { more = true; draw(); });
    box.querySelector('#bdPick')?.addEventListener('click', () => { picking = new Set(d.showcase); draw(); });
    box.querySelector('#bdCancel')?.addEventListener('click', () => { picking = null; draw(); });
    box.querySelector('#bdSave')?.addEventListener('click', async () => {
      try {
        const r = await api('me/badge-showcase', { method: 'PUT', body: { ids: [...picking] } });
        d.showcase = r.showcase;
        picking = null;
        if (showBox) showBox.innerHTML = showcaseHtml(d.showcase.map((id) => byId.get(id)).filter(Boolean));
        toast('Showcase saved');
        draw();
      } catch (x) { fail(x); }
    });
    box.querySelectorAll('[data-b]').forEach((el) => {
      el.onclick = () => {
        const b = byId.get(Number(el.dataset.b));
        if (!picking) return badgeModal(b, mine);
        if (picking.has(b.id)) picking.delete(b.id);
        else if (picking.size < 5) picking.add(b.id);
        else toast('Up to 5', 'Take one off first.');
        draw();
      };
    });
  };
  draw();
}

// ---------- Admin → Badges ----------
const fileData = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(file); });
export async function badgesAdminTab(body) {
  const d = await api('admin/badges');
  const groups = {};
  for (const b of d.badges) (groups[b.category] ||= []).push(b);
  const s = d.settings;
  body.innerHTML = `
    <div class="panel">
      <div class="row between"><div class="panel-title" style="margin:0">Badges <span class="sub">${d.badges.length}</span></div><button class="btn primary" id="bNew">${icon('plus')} New badge</button></div>
      <p class="muted small">Collectible badges with artwork, rarity and Achievement Points. Automatic ones are earned from a tracked stat (WPG server, wardogs.tools, Steam, streaming, Discord, boosts, WPG membership, events); the rest are given by staff from Admin → Members. A new badge is given quietly to everyone who already qualifies, then announced for everyone after.</p>
      <div class="frame-upload" style="margin-top:8px"><b>Upload artwork for many badges at once</b>
        <ul class="small"><li>Square <b>PNG or WebP</b> (animated WebP / GIF are fine), <b>512 x 512</b> is best, with a <b>real transparent background</b>. Pictures with a checkerboard drawn in are refused.</li>
          <li>Name each file after its badge, e.g. <b>one-year-veteran.png</b> for "One-Year Veteran". Up to 40 at a time.</li>
          <li>Don't draw a rarity border: the app adds a glow in the rarity's colour.</li></ul>
        <label class="btn small primary" style="cursor:pointer">${icon('plus')} Pick files<input type="file" id="bBulk" accept="image/png,image/webp,image/gif" multiple hidden></label>
        <div id="bBulkOut" class="small" style="margin-top:8px"></div></div>
      ${Object.entries(groups).map(([cat, list]) => `<h3 style="margin:16px 0 6px">${esc(d.categories[cat] || cat)} <span class="muted small">${list.length}</span></h3>
        <div class="list">${list.map((b) => `<div class="item">${badgeHTML(b, 44)}<div class="grow"><b>${esc(b.name)}</b> ${rarityPill(b.rarity)} <span class="muted small">${b.points} pts${b.enabled ? '' : ' · off'}${b.temporary ? ' · while it applies' : ''}${b.image ? '' : ' · default art'}</span>
          <div class="muted small">${esc(b.description)} · ${b.holders} held</div></div><button class="btn small" data-edit="${b.id}">${icon('edit')} Edit</button></div>`).join('')}</div>`).join('')}
    </div>
    <form class="panel stack" id="bSet" style="margin-top:16px">
      <div class="panel-title" style="margin:0">Discord posts</div>
      <label class="check"><input type="checkbox" name="posting" ${s.posting ? 'checked' : ''}> Post "ACHIEVEMENT UNLOCKED" when a WPG member earns a badge (several at once are one post)</label>
      <label class="field"><span>Channel ID for badge posts (empty = the app's posts channel)</span><input type="text" name="channel" inputmode="numeric" value="${esc(s.channel)}"></label>
      <div class="field"><span style="display:block;font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Post these categories (badges and achievement medals)</span>
        <div class="row" style="flex-wrap:wrap;gap:10px">${Object.entries(d.categories).map(([k, l]) => `<label class="check small"><input type="checkbox" name="cat" value="${k}" ${s.quiet.includes(k) ? '' : 'checked'}> ${esc(l)}</label>`).join('')}</div></div>
      <label class="field"><span>Achievement Points for an Exclusive badge</span><input type="number" name="points_exclusive" min="0" value="${esc(s.points_exclusive)}"></label>
      <div class="row"><button class="btn primary">Save</button></div>
    </form>`;
  body.querySelector('#bNew').onclick = () => badgeEditor(d, null, () => badgesAdminTab(body));
  body.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => badgeEditor(d, d.badges.find((x) => x.id === Number(b.dataset.edit)), () => badgesAdminTab(body)); });
  body.querySelector('#bSet').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('admin/badge-settings', { method: 'PUT', body: { posting: f.posting.checked, channel: f.channel.value, points_exclusive: f.points_exclusive.value, quiet: [...f.querySelectorAll('[name=cat]')].filter((x) => !x.checked).map((x) => x.value) } });
      toast('Saved');
    } catch (x) { fail(x); }
  };
  body.querySelector('#bBulk').onchange = async (e) => {
    const files = [...e.target.files].slice(0, 40);
    e.target.value = '';
    const out = body.querySelector('#bBulkOut');
    const results = [];
    for (let i = 0; i < files.length; i += 6) {
      out.textContent = `Uploading ${Math.min(i + 6, files.length)} of ${files.length}…`;
      const part = await Promise.all(files.slice(i, i + 6).map(async (f) => ({ name: f.name, data: await fileData(f) })));
      try { results.push(...(await api('admin/badges/bulk-art', { method: 'POST', body: { files: part } })).results); } catch (x) { results.push(...part.map((p) => ({ file: p.name, ok: false, message: x.message }))); }
    }
    out.innerHTML = `<ul style="margin:0;padding-left:18px">${results.map((r) => `<li style="color:${r.ok ? 'var(--green)' : 'var(--red)'}">${esc(r.file)}: ${r.ok ? `✓ ${esc(r.badge)}${r.notes?.length ? ` (${esc(r.notes.join(' '))})` : ''}` : `${r.badge ? `${esc(r.badge)}: ` : ''}${esc(r.message)}`}</li>`).join('')}</ul>
      <button class="btn small" id="bReload" style="margin-top:6px">Show the new artwork</button>`;
    out.querySelector('#bReload').onclick = () => badgesAdminTab(body);
  };
}

function badgeEditor(d, b, done) {
  const v = b || { name: '', description: '', category: 'other', rarity: 'rare', points: '', rule: '', temporary: false, limited: false, enabled: true, sort_order: 900, image: '', image_id: null };
  const [kind, stat, target] = String(v.rule || '').split(':');
  const groups = {};
  for (const [k, x] of Object.entries(d.stats)) (groups[x.source] ||= []).push([k, x]);
  let image = { id: v.image_id || null, url: v.image || '' };
  const m = modal(`<form class="stack" id="bForm">
    <div class="row between"><h3 style="margin:0">${b ? 'Edit badge' : 'New badge'}</h3><button type="button" class="btn ghost small" data-close>✕</button></div>
    <div class="row" style="gap:16px;align-items:flex-start"><div id="bPrev" style="flex:none"></div>
      <div class="grow stack">
        <label class="field"><span>Name</span><input type="text" name="name" maxlength="60" value="${esc(v.name)}" required></label>
        <label class="field"><span>How to earn it (shown to members)</span><input type="text" name="description" maxlength="200" value="${esc(v.description)}"></label>
      </div></div>
    <div class="row">
      <label class="field"><span>Category</span><select name="category">${Object.entries(d.categories).map(([k, l]) => `<option value="${k}" ${v.category === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="field"><span>Rarity</span><select name="rarity">${Object.entries(d.rarities).map(([k, x]) => `<option value="${k}" ${v.rarity === k ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
      <label class="field"><span>Achievement Points (empty = the rarity's)</span><input type="number" name="points" min="0" value="${esc(b ? v.points : '')}"></label>
    </div>
    <div class="field"><span style="display:block;font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px">How it's earned</span>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <select name="stat" class="grow" style="min-width:240px"><option value="">Given by staff</option>${Object.entries(groups).map(([src, list]) => `<optgroup label="Automatic: ${esc(src)}">${list.map(([k, x]) => `<option value="${k}" ${kind === 'stat' && stat === k ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</optgroup>`).join('')}</select>
        <label class="row small" style="gap:6px">at least <input type="number" name="target" min="0" step="any" style="width:120px" value="${esc(kind === 'stat' ? target : '')}"></label>
      </div></div>
    <div class="row" style="flex-wrap:wrap;gap:14px">
      <label class="check small"><input type="checkbox" name="temporary" ${v.temporary ? 'checked' : ''}> Only while it applies (taken away when it stops, e.g. staff positions)</label>
      <label class="check small"><input type="checkbox" name="limited" ${v.limited ? 'checked' : ''}> Limited edition</label>
      <label class="check small"><input type="checkbox" name="enabled" ${v.enabled ? 'checked' : ''}> On</label>
      <label class="field"><span>Order</span><input type="number" name="sort_order" value="${esc(v.sort_order)}" style="width:90px"></label>
    </div>
    <div class="row"><label class="btn small" style="cursor:pointer">${icon('plus')} Upload artwork<input type="file" id="bFile" accept="image/png,image/webp,image/gif" hidden></label>
      <button type="button" class="btn small ghost" id="bNoArt">Use the default design</button><span class="small" id="bArtMsg"></span></div>
    <div class="row between">
      <div class="row"><button class="btn primary">Save</button>${b ? '<button type="button" class="btn" id="bHolders">Who has it</button>' : ''}</div>
      ${b ? `<button type="button" class="btn danger" id="bDel">${icon('trash')} Delete</button>` : ''}
    </div></form>`);
  const f = m.el.querySelector('#bForm');
  const short = () => {
    const n = Number(f.target.value) || 0;
    const ini = f.name.value.split(/\s+/).filter((w) => /^[A-Z0-9]/.test(w)).map((w) => w[0]).join('').slice(0, 3) || 'WPG';
    if (!f.stat.value || d.stats[f.stat.value]?.yesno) return ini;
    if (/months/.test(f.stat.value)) return n >= 12 && n % 12 === 0 ? `${n / 12}Y` : `${n}M`;
    return n >= 1000 ? `${Number((n / 1000).toFixed(1))}K` : String(n || ini);
  };
  const prev = () => { m.el.querySelector('#bPrev').innerHTML = `${badgeHTML({ name: f.name.value, rarity: f.rarity.value, category: f.category.value, image: image.url, short: short() }, 120)}<div class="row" style="gap:6px;margin-top:6px">${badgeHTML({ name: '', rarity: f.rarity.value, category: f.category.value, image: image.url, short: short() }, 40)}${badgeHTML({ name: '', rarity: f.rarity.value, category: f.category.value, image: image.url, short: short() }, 28)}</div>`; };
  f.addEventListener('input', prev);
  f.addEventListener('change', prev);
  prev();
  m.el.querySelector('[data-close]').onclick = m.close;
  m.el.querySelector('#bFile').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const msg = m.el.querySelector('#bArtMsg');
    msg.textContent = 'Checking…';
    try {
      const r = await api('admin/badge-images', { method: 'POST', body: { data: await fileData(file) } });
      image = { id: r.id, url: r.url };
      msg.innerHTML = `<span style="color:var(--green)">✓ Uploaded.</span> ${esc((r.notes || []).join(' '))}`;
      prev();
    } catch (x) { msg.innerHTML = `<span style="color:var(--red)">${esc(x.message)}</span>`; }
  };
  m.el.querySelector('#bNoArt').onclick = () => { image = { id: null, url: '' }; prev(); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      name: f.name.value, description: f.description.value, category: f.category.value, rarity: f.rarity.value, points: f.points.value,
      rule: f.stat.value ? `stat:${f.stat.value}:${f.target.value || 0}` : '', temporary: f.temporary.checked, limited: f.limited.checked,
      enabled: f.enabled.checked, sort_order: f.sort_order.value, image_id: image.id,
    };
    try {
      await api(b ? `admin/badges/${b.id}` : 'admin/badges', { method: b ? 'PUT' : 'POST', body });
      toast('Saved');
      m.close();
      done();
    } catch (x) { fail(x); }
  };
  m.el.querySelector('#bDel')?.addEventListener('click', async () => {
    if (!(await confirmBox(`Delete "${b.name}"? Everyone who has it loses it.`))) return;
    try { await api(`admin/badges/${b.id}`, { method: 'DELETE' }); m.close(); done(); } catch (x) { fail(x); }
  });
  m.el.querySelector('#bHolders')?.addEventListener('click', async () => {
    const list = await api(`admin/badges/${b.id}/holders`);
    modal(`<h3 style="margin:0 0 8px">${esc(b.name)}: ${list.length} held</h3><div class="list">${list.map((h) => `<div class="item"><a class="grow" href="#/u/${h.user_id}">${esc(h.name)}</a><span class="muted small">${fmtDate(h.earned_at)} · ${esc(h.reason)}</span></div>`).join('') || '<p class="muted">Nobody yet.</p>'}</div>`);
  });
}

// ---------- Admin → Events & tournaments ----------
export async function eventsAdminTab(body) {
  const d = await api('admin/events');
  const names = new Map(d.members.map((u) => [u.id, u.name]));
  body.innerHTML = `<div class="panel">
    <div class="row between"><div class="panel-title" style="margin:0">Events &amp; tournaments</div><button class="btn primary" id="eNew">${icon('plus')} Record an event</button></div>
    <p class="muted small">Official WPG events and tournaments, recorded by staff once they've happened: who took part and (for tournaments) who won. These count towards the event and tournament achievements.</p>
    <div class="list">${d.events.map((e) => `<div class="item"><div class="grow"><b>${esc(e.name)}</b> <span class="pill">${e.kind === 'tournament' ? '🏆 Tournament' : '🎉 Event'}</span>
      <div class="muted small">${fmtDate(e.held_at)} · ${e.people.length} took part${e.kind === 'tournament' && e.people.some((p) => p.won) ? ` · won by ${esc(e.people.filter((p) => p.won).map((p) => names.get(p.user_id) || '?').join(', '))}` : ''}</div></div>
      <button class="btn small" data-edit="${e.id}">${icon('edit')} Edit</button></div>`).join('') || '<p class="empty">Nothing recorded yet.</p>'}</div></div>`;
  const open = (e) => {
    const v = e || { name: '', kind: 'event', held_at: new Date().toISOString(), notes: '', people: [] };
    const inIt = new Map(v.people.map((p) => [p.user_id, p]));
    const m = modal(`<form class="stack" id="eForm">
      <div class="row between"><h3 style="margin:0">${e ? 'Edit' : 'Record an'} event</h3><button type="button" class="btn ghost small" data-close>✕</button></div>
      <div class="row">
        <label class="field grow"><span>Name</span><input type="text" name="name" maxlength="100" value="${esc(v.name)}" required></label>
        <label class="field"><span>Type</span><select name="kind"><option value="event" ${v.kind === 'event' ? 'selected' : ''}>Event</option><option value="tournament" ${v.kind === 'tournament' ? 'selected' : ''}>Tournament</option></select></label>
        <label class="field"><span>Date</span><input type="date" name="held_at" value="${esc(String(v.held_at).slice(0, 10))}"></label>
      </div>
      <label class="field"><span>Notes</span><input type="text" name="notes" maxlength="500" value="${esc(v.notes)}"></label>
      <input type="search" id="eFind" placeholder="Find a member…">
      <div class="small muted">Tick who took part. For tournaments, also tick who won.</div>
      <div id="ePeople" style="max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:8px">${d.members.map((u) => `<div class="row" data-name="${esc(u.name.toLowerCase())}" style="padding:5px 8px;border-bottom:1px solid var(--line);gap:12px;flex-wrap:nowrap">
        <label class="check small grow"><input type="checkbox" data-in="${u.id}" ${inIt.has(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>
        <label class="check small" data-wonbox><input type="checkbox" data-won="${u.id}" ${inIt.get(u.id)?.won ? 'checked' : ''}> Won</label></div>`).join('')}</div>
      <div class="row between"><button class="btn primary">Save</button>${e && state.me.role === 'admin' ? `<button type="button" class="btn danger" id="eDel">${icon('trash')} Delete</button>` : ''}</div></form>`);
    const f = m.el.querySelector('#eForm');
    const kindView = () => m.el.querySelectorAll('[data-wonbox]').forEach((x) => { x.style.display = f.kind.value === 'tournament' ? '' : 'none'; });
    f.kind.onchange = kindView;
    kindView();
    m.el.querySelector('[data-close]').onclick = m.close;
    m.el.querySelector('#eFind').oninput = (ev) => {
      const t = ev.target.value.trim().toLowerCase();
      m.el.querySelectorAll('[data-name]').forEach((r) => { r.style.display = !t || r.dataset.name.includes(t) ? '' : 'none'; });
    };
    m.el.querySelectorAll('[data-won]').forEach((w) => { w.onchange = () => { if (w.checked) m.el.querySelector(`[data-in="${w.dataset.won}"]`).checked = true; }; });
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const people = [...m.el.querySelectorAll('[data-in]:checked')].map((x) => ({ user_id: Number(x.dataset.in), won: !!m.el.querySelector(`[data-won="${x.dataset.in}"]`)?.checked }));
      try {
        await api(e ? `admin/events/${e.id}` : 'admin/events', { method: e ? 'PUT' : 'POST', body: { name: f.name.value, kind: f.kind.value, held_at: f.held_at.value, notes: f.notes.value, people } });
        toast('Saved');
        m.close();
        eventsAdminTab(body);
      } catch (x) { fail(x); }
    };
    m.el.querySelector('#eDel')?.addEventListener('click', async () => {
      if (!(await confirmBox(`Delete "${v.name}"? Achievements already earned from it are kept.`))) return;
      try { await api(`admin/events/${e.id}`, { method: 'DELETE' }); m.close(); eventsAdminTab(body); } catch (x) { fail(x); }
    });
  };
  body.querySelector('#eNew').onclick = () => open(null);
  body.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => open(d.events.find((x) => x.id === Number(b.dataset.edit))); });
}

// ---------- Member editor: badges and the original WPG join date ----------
export async function memberBadgesSection(box, userId) {
  const [d, all] = await Promise.all([api(`admin/users/${userId}/badges`), state.me.role === 'admin' ? api('admin/badges') : Promise.resolve(null)]);
  const held = d.badges.filter((b) => b.unlocked);
  const manual = (all?.badges || d.badges).filter((b) => !held.some((h) => h.id === b.id));
  box.innerHTML = `<h3>Badges <span class="muted small">${held.length} · ${fmtNum(d.totals.points)} points</span></h3>
    <div class="list">${held.map((b) => `<div class="item">${badgeHTML(b, 34)}<div class="grow"><b>${esc(b.name)}</b> ${rarityPill(b.rarity)}<div class="muted small">${fmtDate(b.earned_at)}</div></div><button class="btn ghost small" data-rmb="${b.id}">Take away</button></div>`).join('') || '<p class="muted">None yet.</p>'}</div>
    <form class="row" id="giveB"><select name="badge_id" style="max-width:240px">${manual.map((b) => `<option value="${b.id}">${esc(b.name)}${b.manual ? '' : ' (automatic)'}</option>`).join('')}</select>
      <input type="text" name="reason" placeholder="Reason" class="grow"><button class="btn">${icon('medal')} Give badge</button></form>
    ${state.me.role === 'admin' ? `<h3 style="margin-top:16px">Original WPG join date</h3>
    <p class="muted small" style="margin:0">Loyalty badges count from this. Set it once it's been checked (WPG existed before Discord and this app). Every change is logged.</p>
    <form class="row" id="wpgJ" style="flex-wrap:wrap">
      <input type="date" name="date" value="${esc(d.wpg_joined_at ? String(d.wpg_joined_at).slice(0, 10) : '')}">
      <input type="text" name="note" class="grow" maxlength="200" placeholder="How it was checked (e.g. founder confirmed)" value="${esc(d.wpg_joined_note || '')}">
      <button class="btn">Save date</button></form>
    ${d.history.length ? `<details class="small" style="margin-top:6px"><summary>History</summary><ul style="margin:4px 0 0;padding-left:18px">${d.history.map((h) => `<li>${fmtDate(h.created_at)} · ${esc(h.actor || 'system')}: ${esc(h.action === 'member.wpg_joined' ? `WPG join date ${h.details.to ? fmtDate(h.details.to) : 'cleared'}${h.details.note ? ` (${h.details.note})` : ''}` : `${h.action === 'badge.give' ? 'gave' : 'took'} ${h.details.badge || ''}${h.details.reason ? ` (${h.details.reason})` : ''}`)}</li>`).join('')}</ul></details>` : ''}` : ''}`;
  const reload = () => memberBadgesSection(box, userId);
  box.querySelector('#giveB').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`admin/users/${userId}/badges`, { method: 'POST', body: { badge_id: Number(e.target.badge_id.value), reason: e.target.reason.value } }); toast('Badge given'); reload(); } catch (x) { fail(x); }
  };
  box.querySelectorAll('[data-rmb]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmBox('Take this badge away?'))) return;
      try { await api(`admin/users/${userId}/badges/${b.dataset.rmb}`, { method: 'DELETE' }); reload(); } catch (x) { fail(x); }
    };
  });
  box.querySelector('#wpgJ')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api(`admin/users/${userId}/wpg-joined`, { method: 'PUT', body: { date: e.target.date.value, note: e.target.note.value } }); toast('Saved', 'Loyalty badges will update shortly.'); reload(); } catch (x) { fail(x); }
  });
}
