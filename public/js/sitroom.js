// Situation rooms: a shared tactical map for one group during a match (WPG members only).
// The list shows the 3 faction slots (Lonestar, Valkyra, Manticore); the room shows the map with everyone's
// markers and drawings live, the Needs list, who's in the room and (for its creator and admins) the controls.
import { api, esc, state, toast, fail, modal, confirmBox, onLive, avatar, timeAgo, fmtTime, userLine } from './app.js';
import { icon } from './icons.js';
import { loadLeaflet, buildMap, toLL, fromLL, solution } from './artymap.js';

const UNITS = 163.84;
const MARKERS = {
  me: { emoji: '📍', label: 'My position', help: 'Tap where you are. It fades after 2 minutes unless you refresh it.' },
  fob: { emoji: '⛺', label: 'FOB / rally', help: 'Tap where the FOB or rally point is.' },
  enemy: { emoji: '🔴', label: 'Enemy', help: 'Tap where you saw them. Spots fade after 3–5 minutes.' },
  need: { emoji: '🆘', label: 'Need', help: 'Tap where it\'s needed. It shows in everyone\'s Needs list.' },
  objective: { emoji: '🎯', label: 'Objective', help: 'Tap the objective.' },
  danger: { emoji: '⚠️', label: 'Danger', help: 'Tap the danger spot (mines, sniper…).' },
};
const DRAWINGS = {
  attack: { emoji: '➡️', label: 'Attack arrow', help: 'Tap the start, then each bend, then the end. Press Finish.', min: 2 },
  flank: { emoji: '↪️', label: 'Flank arrow', help: 'Tap the start, then each bend, then the end. Press Finish.', min: 2 },
  defend: { emoji: '🛡️', label: 'Defend line', help: 'Tap along the line to hold. Press Finish.', min: 2 },
  route: { emoji: '〰️', label: 'Route', help: 'Tap along the route. Press Finish.', min: 2 },
  area: { emoji: '⭕', label: 'Area', help: 'Tap the corners (3 or more). Press Finish.', min: 3 },
  label: { emoji: '🔤', label: 'Label', help: 'Tap where the label goes.', min: 1 },
};
const COLORS = { blue: '#4cb1ef', red: '#e5484d', yellow: '#f5c542', green: '#3ddc84' };
const COLOR_NAMES = { blue: 'Our plan', red: 'Enemy', yellow: 'Caution', green: 'Route' };
const ENEMY = [['infantry', 'Infantry'], ['vehicle', 'Vehicle'], ['armour', 'Armour'], ['air', 'Air'], ['artillery', 'Artillery']];
const NEEDS = [['ammo', 'Ammo'], ['medic', 'Medic'], ['transport', 'Transport'], ['repair', 'Repair'], ['fire', 'Fire support'], ['backup', 'Backup']];
const DANGER = [['mines', 'Mines'], ['sniper', 'Sniper'], ['other', 'Other']];
const label = (list, k) => (list.find(([v]) => v === k) || [k, k])[1];

// Alerts: a short beep (and a buzz on phones) for new needs, enemy spots, messages and join requests.
const SOUND_KEY = 'wpg.sit.sound';
const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } };
let audio = null;
function alertBeep(kind = 'need') {
  if (!soundOn()) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const notes = { need: [880, 1175], enemy: [440, 330], msg: [660], ask: [523, 784] }[kind] || [660];
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      const t0 = audio.currentTime + i * 0.14;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.15, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      o.connect(g).connect(audio.destination);
      o.start(t0);
      o.stop(t0 + 0.13);
    });
  } catch { /* no sound on this device */ }
  try { navigator.vibrate?.(kind === 'msg' ? 60 : [80, 60, 80]); } catch { /* no vibration */ }
}

// Your gun position: the same one the Arty map keeps (per map, on this device).
const gunKey = (mapId) => `wpg.arty2.${mapId}`;
function savedGun(mapId) {
  try { return JSON.parse(localStorage.getItem(gunKey(mapId))) || {}; } catch { return {}; }
}
function saveGun(mapId, gun, weaponId) {
  const cur = savedGun(mapId);
  try { localStorage.setItem(gunKey(mapId), JSON.stringify({ ...cur, gun, ...(weaponId ? { weaponId } : {}) })); } catch { /* storage blocked */ }
}

const FACTION_NAMES = { lonestar: 'Lonestar', valkyra: 'Valkyra', manticore: 'Manticore' };
let mapsCache = null;
const loadMaps = async () => (mapsCache ||= await fetch('/maps/maps.json').then((r) => r.json()));

// ---------- Drawing marks on the map (rooms and the admins' last-match view) ----------
function markerIcon(L, it, nameOf) {
  const t = MARKERS[it.type];
  const d2 = it.data;
  const text = it.type === 'me' ? nameOf(it.user_id)
    : it.type === 'enemy' ? `${d2.count > 1 ? `${d2.count}× ` : ''}${label(ENEMY, d2.what)}`
      : it.type === 'need' ? label(NEEDS, d2.need)
        : it.type === 'fob' ? d2.name || 'FOB'
          : it.type === 'objective' ? (d2.goal === 'defend' ? 'Defend' : 'Attack')
            : it.type === 'danger' ? label(DANGER, d2.what) : '';
  const fire = d2.firing_by ? `<span class="t fire">💥 ${esc(nameOf(d2.firing_by))} firing</span>` : '';
  return L.divIcon({
    className: `sit-pin ${it.type}${it.type === 'need' && d2.claimed_by ? ' claimed' : ''}`,
    html: `<span class="e">${t.emoji}</span>${text ? `<span class="t">${esc(text)}</span>` : ''}${fire}`,
    iconSize: null,
    iconAnchor: [14, 14],
  });
}
// Arrowhead at the end of a line, in map units (it scales with the map like the line does).
function arrowHead(L, pts, c) {
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const len = Math.min(3, Math.hypot(b.x - a.x, b.y - a.y) * 0.45);
  const side = (s) => ({ x: b.x - len * Math.cos(ang + s * 0.45), y: b.y - len * Math.sin(ang + s * 0.45) });
  return L.polygon([toLL(b), toLL(side(1)), toLL(side(-1))], { color: c, weight: 1, fillColor: c, fillOpacity: 0.95 });
}
function drawingLayer(L, it) {
  const c = COLORS[it.data.color] || COLORS.blue;
  const lls = it.data.points.map(toLL);
  const g = L.featureGroup();
  if (it.type === 'label') {
    L.marker(lls[0], { icon: L.divIcon({ className: 'sit-label', html: `<span style="color:${c}">${esc(it.data.text)}</span>`, iconSize: null, iconAnchor: [0, 10] }) }).addTo(g);
  } else if (it.type === 'area') {
    L.polygon(lls, { color: c, weight: 2, fillColor: c, fillOpacity: 0.15, dashArray: '6 4' }).addTo(g);
  } else {
    const style = {
      attack: { weight: 5 },
      flank: { weight: 4, dashArray: '10 8' },
      defend: { weight: 7, dashArray: '2 10', lineCap: 'square' },
      route: { weight: 3, dashArray: '4 6' },
    }[it.type];
    L.polyline(lls, { color: c, opacity: 0.9, ...style }).addTo(g);
    if (it.type === 'defend') L.polyline(lls, { color: c, weight: 2, opacity: 0.9 }).addTo(g);
    if (it.type !== 'defend') arrowHead(L, it.data.points, c).addTo(g);
  }
  return g;
}


// ---------- The list of rooms ----------
export async function viewSitRooms(main, [id, sub], alive) {
  if (id === 'archive') return viewArchive(main, Number(sub), alive);
  if (id) return viewRoom(main, Number(id), alive);
  const [d, maps] = await Promise.all([api('sitrooms'), loadMaps()]);
  if (!alive()) return;
  const mapName = (mid) => maps.find((m) => m.id === mid)?.name || mid;
  const inRoom = d.my_room;
  const slot = ({ faction: f, room: r }) => {
    if (!r) {
      return `<div class="panel sit-slot" style="--fc:${f.color}">
        <div class="sit-fac">${esc(f.name)}</div>
        <p class="muted small" style="margin:6px 0 12px">Free</p>
        ${inRoom ? '<p class="muted small">You\'re already in a room.</p>' : `<button class="btn primary" data-create="${f.id}">${icon('plus')} Create room</button>`}
      </div>`;
    }
    const actions = r.mine ? `<a class="btn primary" href="#/sitrooms/${r.id}">Open room</a>`
      : r.invited ? `<button class="btn primary" data-accept="${r.id}">Join (you're invited)</button><button class="btn ghost" data-decline="${r.id}">No thanks</button>`
        : r.asked ? '<span class="muted small">Asked to join — waiting for the room\'s creator</span>'
          : `${inRoom ? '' : `<button class="btn" data-ask="${r.id}">Ask to join</button>`}`;
    const admin = d.is_admin && !r.mine ? `<a class="btn ghost small" href="#/sitrooms/${r.id}">Look in (admin)</a><button class="btn ghost small" data-close="${r.id}">Close</button>` : '';
    return `<div class="panel sit-slot used" style="--fc:${f.color}">
      <div class="sit-fac">${esc(f.name)}</div>
      <div style="font:700 18px var(--head);margin-top:4px">${esc(r.name)}</div>
      <div class="muted small">Run by ${esc(r.creator?.name || 'someone')} · ${r.members.length} in the room</div>
      <div class="sit-people">${r.members.map((u) => `<span title="${esc(u.name)}">${avatar(u, 'sm')}</span>`).join('')}</div>
      <div class="row" style="gap:8px;margin-top:10px">${actions}${admin}</div>
    </div>`;
  };
  main.innerHTML = `
    <div class="stack">
      <div class="row between"><h1 style="margin:0">${icon('target', 'width="26" height="26" style="vertical-align:-4px;color:var(--accent)"')} Situation rooms</h1>
        <a class="btn small ghost" href="#/map">Arty map</a></div>
      <p class="muted" style="margin:0">A shared map for your group during a match: mark positions, FOBs, enemies and what you need, and draw the plan.
        One room per faction, so up to 3 at once. The person who opens a room picks the map and invites people (or lets them in when they ask).</p>
      ${inRoom ? `<div class="panel" style="border-color:var(--accent)">You're in a room. <a class="btn small primary" href="#/sitrooms/${inRoom}">Open it</a></div>` : ''}
      <div class="sit-slots">${d.slots.map(slot).join('')}</div>
      ${d.is_admin ? '<div class="panel" id="srArchive"><div class="panel-title">Last matches <span class="sub">admins · kept 14 days</span></div><div class="spinner"></div></div>' : ''}
    </div>`;
  if (d.is_admin) {
    api('sitrooms-archive').then((list) => {
      const el = main.querySelector('#srArchive');
      if (!el || !alive()) return;
      el.innerHTML = `<div class="panel-title">Last matches <span class="sub">admins · kept 14 days</span></div>
        <p class="muted small" style="margin:0 0 8px">A copy of a room's board is kept each time it's cleared: new match, map change or room closed.</p>
        <div class="list">${list.map((a) => `<a class="item" href="#/sitrooms/archive/${a.id}"><div class="grow"><b>${esc(a.name)}</b>
          <div class="muted small">${esc(FACTION_NAMES[a.faction] || a.faction)} · ${esc(mapName(a.map_id))} · ${a.marks} marks · ${a.messages} messages · ${esc(a.members.map((m) => m.name).join(', '))}</div>
          <div class="muted small">${esc(a.reason)} · ${esc(timeAgo(a.created_at))}</div></div></a>`).join('') || '<p class="muted small">None yet.</p>'}</div>`;
    }).catch(() => {});
  }
  const reload = () => { if (alive()) viewSitRooms(main, [], alive).catch(() => {}); };
  onLive('sitrooms', reload);
  const act = (sel, fn) => main.querySelectorAll(sel).forEach((b) => {
    b.onclick = async () => { b.disabled = true; try { await fn(b); } catch (x) { fail(x); b.disabled = false; } };
  });
  main.querySelectorAll('[data-create]').forEach((b) => { b.onclick = () => createRoom(d, maps, b.dataset.create); });
  act('[data-ask]', async (b) => {
    const r = await api(`sitrooms/${b.dataset.ask}/ask`, { method: 'POST', body: {} });
    if (r.joined) location.hash = `#/sitrooms/${b.dataset.ask}`;
    else { toast('Asked', 'The room\'s creator will let you in.'); reload(); }
  });
  act('[data-accept]', async (b) => {
    await api(`sitrooms/${b.dataset.accept}/requests/${state.me.id}/accept`, { method: 'POST', body: {} });
    location.hash = `#/sitrooms/${b.dataset.accept}`;
  });
  act('[data-decline]', async (b) => { await api(`sitrooms/${b.dataset.decline}/requests/${state.me.id}/decline`, { method: 'POST', body: {} }); reload(); });
  act('[data-close]', async (b) => {
    if (!(await confirmBox('Close this room for everyone in it?'))) { b.disabled = false; return; }
    await api(`sitrooms/${b.dataset.close}/close`, { method: 'POST', body: {} });
    reload();
  });
}

function createRoom(d, maps, factionId) {
  const free = d.slots.filter((s) => !s.room).map((s) => s.faction);
  const pick = free.find((f) => f.id === factionId) ? factionId : free.find((f) => f.id === d.my_faction)?.id || free[0]?.id;
  const m = modal(`<h3 style="margin-top:0">Create a situation room</h3>
    <form class="stack" id="srForm">
      <label class="field"><span>Faction</span><select name="faction">${free.map((f) => `<option value="${f.id}" ${f.id === pick ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Map you're playing on</span><select name="map">${maps.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Room name (optional)</span><input type="text" name="name" maxlength="40" placeholder="${esc(state.me.name)}'s room"></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary">Create</button></div>
    </form>`);
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('#srForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('sitrooms', { method: 'POST', body: { faction: f.faction.value, map: f.map.value, name: f.name.value } });
      m.close();
      location.hash = `#/sitrooms/${r.id}`;
    } catch (x) { fail(x); }
  };
}

// ---------- One room ----------
async function viewRoom(main, id, alive) {
  let d;
  try {
    d = await api(`sitrooms/${id}`);
  } catch (x) {
    main.innerHTML = `<div class="panel empty"><p>${esc(x.message)}</p><a class="btn" href="#/sitrooms">Situation rooms</a></div>`;
    return;
  }
  const maps = await loadMaps();
  await loadLeaflet();
  if (!alive()) return;
  const L = window.L;
  let users = new Map(d.users.map((u) => [u.id, u]));
  const nameOf = (uid) => users.get(uid)?.name || 'Someone';
  let items = d.items;
  let tool = null; // marker type or drawing type
  let color = 'blue';
  let points = []; // drawing in progress
  let messages = d.messages || [];
  let pendingFire = null; // the mark to show a fire mission for once the gun is placed
  let guns = null;

  const map = () => maps.find((m) => m.id === d.room.map_id) || maps[0];
  main.innerHTML = `
    <div class="row between" style="margin-bottom:10px">
      <div><a href="#/sitrooms" class="small">← Situation rooms</a>
        <h1 style="margin:2px 0 0"><span class="sit-fac-dot" style="background:${esc(d.room.faction.color)}"></span> ${esc(d.room.name)} <span class="muted small">${esc(d.room.faction.name)} · <span id="srMapName">${esc(map().name)}</span></span></h1></div>
      <div class="row" style="gap:6px" id="srTop"></div>
    </div>
    <div class="sit-wrap">
      <div style="min-width:0">
      <div class="sit-toolbar">
        <div class="sit-tools">${Object.entries(MARKERS).map(([k, t]) => `<button type="button" class="btn small" data-tool="${k}" title="${esc(t.label)}">${t.emoji} ${esc(t.label)}</button>`).join('')}
          <button type="button" class="btn small" data-tool="gun" title="Your gun (only you see it; same as the Arty map)">🔫 My gun</button></div>
        <div class="sit-tools">${Object.entries(DRAWINGS).map(([k, t]) => `<button type="button" class="btn small" data-tool="${k}" title="${esc(t.label)}">${t.emoji} ${esc(t.label)}</button>`).join('')}
          <span class="sit-colors">${Object.entries(COLORS).map(([k, c]) => `<button type="button" class="sit-swatch" data-color="${k}" style="background:${c}" title="${esc(COLOR_NAMES[k])}" aria-label="${esc(COLOR_NAMES[k])}"></button>`).join('')}
          <span class="muted small" id="srColorName"></span></span></div>
      </div>
      <div class="panel sit-map-panel">
        <div id="srMap" class="arty-map style-tactical"></div>
        <div class="sit-hint" id="srHint">Pick a tool, then tap the map.</div>
        <div class="sit-draw-bar" id="srDrawBar" hidden>
          <button type="button" class="btn small primary" id="srFinish">Finish</button>
          <button type="button" class="btn small ghost" id="srUndoPt">Undo point</button>
          <button type="button" class="btn small ghost" id="srCancel">Cancel</button>
        </div>
      </div>
      </div>
      <div class="sit-side">
        <div class="panel"><div class="panel-title" style="margin-bottom:8px">🆘 Needs <span class="sub" id="srNeedCount"></span></div><div id="srNeeds"></div></div>
        <div class="panel"><div class="panel-title" style="margin-bottom:8px">💬 Room chat</div>
          <div class="sit-msgs" id="srMsgs"></div>
          <form class="row" id="srMsgForm" style="gap:6px;margin-top:8px;flex-wrap:nowrap"><input type="text" name="body" maxlength="300" placeholder="Quick message to the room" class="grow" autocomplete="off"><button class="btn small primary">${icon('send')}</button></form>
        </div>
        <div class="panel"><div class="panel-title" style="margin-bottom:8px">${icon('users')} In the room <span class="sub" id="srCount"></span></div><div id="srMembers"></div></div>
        <div class="panel" id="srManage" hidden></div>
      </div>
    </div>`;

  // ----- map -----
  let lmap = buildMap(L, 'srMap', map());
  let layer = L.layerGroup().addTo(lmap);
  let draft = L.layerGroup().addTo(lmap);
  setTimeout(() => lmap.invalidateSize(), 200);

  function render() {
    layer.clearLayers();
    const now = Date.now();
    items = items.filter((it) => !it.expires_at || Date.parse(it.expires_at) > now);
    for (const it of items) {
      const lay = it.kind === 'marker' ? L.marker(toLL(it.data.at), { icon: markerIcon(L, it, nameOf) }) : drawingLayer(L, it);
      lay.on('click', (e) => { L.DomEvent.stopPropagation(e); if (!tool) itemMenu(it); });
      lay.addTo(layer);
    }
    const g = savedGun(map().id).gun;
    if (g) {
      L.marker(toLL(g), { icon: L.divIcon({ className: 'arty-pin gun', html: icon('crosshair'), iconSize: [30, 30], iconAnchor: [15, 15] }), interactive: false })
        .bindTooltip('Your gun', { className: 'arty-label' }).addTo(layer);
    }
    renderNeeds();
  }

  function renderChat() {
    const box = main.querySelector('#srMsgs');
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.innerHTML = messages.length ? messages.map((m) => `<div class="sit-msg"><b>${esc(nameOf(m.user_id))}</b> <span class="muted small">${fmtTime(m.created_at)}</span><div>${esc(m.body)}</div></div>`).join('')
      : '<p class="muted small" style="margin:0">No messages yet.</p>';
    if (near) box.scrollTop = box.scrollHeight;
  }
  main.querySelector('#srMsgForm').onsubmit = async (e) => {
    e.preventDefault();
    const input = e.target.body;
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    try {
      const m = await api(`sitrooms/${id}/messages`, { method: 'POST', body: { body } });
      if (!messages.some((x) => x.id === m.id)) { messages.push(m); renderChat(); }
    } catch (x) { input.value = body; fail(x); }
  };

  function renderNeeds() {
    const needs = items.filter((it) => it.type === 'need');
    main.querySelector('#srNeedCount').textContent = needs.length || '';
    main.querySelector('#srNeeds').innerHTML = needs.length ? needs.map((it) => {
      const by = it.data.claimed_by;
      return `<div class="sit-need${by ? ' claimed' : ''}">
        <div><b>${esc(label(NEEDS, it.data.need))}</b>${it.data.note ? ` — ${esc(it.data.note)}` : ''}</div>
        <div class="muted small">${esc(nameOf(it.user_id))} · ${esc(timeAgo(it.created_at))}${by ? ` · <b style="color:var(--green)">${esc(nameOf(by))} is on it</b>` : ''}</div>
        <div class="row" style="gap:6px;margin-top:6px">
          ${by === state.me.id ? `<button class="btn small ghost" data-need="unclaim" data-id="${it.id}">Not me</button>` : !by ? `<button class="btn small primary" data-need="claim" data-id="${it.id}">I'm on it</button>` : ''}
          ${it.user_id === state.me.id || by === state.me.id || d.can_manage ? `<button class="btn small" data-need="done" data-id="${it.id}">✓ Done</button>` : ''}
          <button class="btn small ghost" data-need="show" data-id="${it.id}">Show</button>
        </div></div>`;
    }).join('') : '<p class="muted small" style="margin:0">Nothing needed right now.</p>';
  }
  main.querySelector('#srNeeds').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-need]');
    if (!b) return;
    const it = items.find((x) => x.id === Number(b.dataset.id));
    if (!it) return;
    try {
      if (b.dataset.need === 'show') lmap.setView(toLL(it.data.at), Math.max(lmap.getZoom(), 3));
      else if (b.dataset.need === 'done') await api(`sitrooms/${id}/items/${it.id}`, { method: 'DELETE' });
      else await api(`sitrooms/${id}/items/${it.id}`, { method: 'PATCH', body: { action: b.dataset.need } });
    } catch (x) { fail(x); }
  });

  function renderPeople() {
    main.querySelector('#srCount').textContent = d.members.length;
    main.querySelector('#srMembers').innerHTML = d.members.map((m) => {
      const u = users.get(m.user_id) || { id: m.user_id, name: 'Someone' };
      const lead = m.user_id === d.room.creator_id ? ' <span class="pill mod">Runs the room</span>' : '';
      return `<div class="row between" style="gap:8px;padding:4px 0">${userLine(u, `active ${timeAgo(m.last_seen)}`)}${lead}
        ${d.can_manage && m.user_id !== state.me.id ? `<button class="btn small ghost" data-remove="${m.user_id}" title="Remove">✕</button>` : ''}</div>`;
    }).join('');
    // Top buttons
    const top = main.querySelector('#srTop');
    top.innerHTML = `<button class="btn small ghost" id="srSound" title="Beep (and buzz on phones) for new needs, enemy spots, messages and join requests">${soundOn() ? '🔔 Alerts on' : '🔕 Alerts off'}</button>
      ${d.is_member ? '<button class="btn small ghost" id="srLeave">Leave room</button>' : '<button class="btn small primary" id="srJoin">Join (admin)</button>'}`;
    top.querySelector('#srSound').onclick = (e) => {
      const on = !soundOn();
      try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* storage blocked */ }
      e.currentTarget.textContent = on ? '🔔 Alerts on' : '🔕 Alerts off';
      if (on) alertBeep('msg');
    };
    top.querySelector('#srLeave')?.addEventListener('click', async () => {
      if (!(await confirmBox('Leave this room?'))) return;
      try { await api(`sitrooms/${id}/leave`, { method: 'POST', body: {} }); location.hash = '#/sitrooms'; } catch (x) { fail(x); }
    });
    top.querySelector('#srJoin')?.addEventListener('click', async () => {
      try { await api(`sitrooms/${id}/join`, { method: 'POST', body: {} }); await refresh(); } catch (x) { fail(x); }
    });
    // Creator / admin controls
    const box = main.querySelector('#srManage');
    box.hidden = !d.can_manage;
    if (!d.can_manage) return;
    const asks = d.requests.filter((r) => r.kind === 'ask');
    const invites = d.requests.filter((r) => r.kind === 'invite');
    box.innerHTML = `<div class="panel-title" style="margin-bottom:8px">${icon('settings')} Run the room</div>
      ${asks.length ? `<div style="margin-bottom:10px"><b class="small">Asking to join</b>${asks.map((r) => `<div class="row between" style="gap:8px;padding:4px 0">${userLine(users.get(r.user_id) || { id: r.user_id, name: 'Someone' }, timeAgo(r.created_at))}
        <span class="row" style="gap:4px"><button class="btn small primary" data-let="${r.user_id}">Let in</button><button class="btn small ghost" data-deny="${r.user_id}">Decline</button></span></div>`).join('')}</div>` : ''}
      ${invites.length ? `<p class="muted small" style="margin:0 0 10px">Invited, not joined yet: ${invites.map((r) => esc(nameOf(r.user_id))).join(', ')}</p>` : ''}
      <div class="row" style="gap:6px">
        <button class="btn small primary" id="srInvite">${icon('friends')} Invite members</button>
        <select id="srMapPick" class="small" style="width:auto">${maps.map((x) => `<option value="${esc(x.id)}" ${x.id === d.room.map_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <button class="btn small ghost" id="srClear">New match / clear board</button>
        <button class="btn small ghost" id="srClose">Close room</button>
      </div>
      <p class="muted small" style="margin:8px 0 0">Changing the map clears the board.</p>`;
    box.querySelectorAll('[data-let],[data-deny]').forEach((b) => {
      b.onclick = async () => {
        const uid = b.dataset.let || b.dataset.deny;
        try { await api(`sitrooms/${id}/requests/${uid}/${b.dataset.let ? 'accept' : 'decline'}`, { method: 'POST', body: {} }); } catch (x) { fail(x); }
      };
    });
    box.querySelector('#srInvite').onclick = () => inviteBox();
    box.querySelector('#srMapPick').onchange = async (e) => {
      if (!(await confirmBox('Switch map? This clears the board for everyone.'))) { e.target.value = d.room.map_id; return; }
      try { await api(`sitrooms/${id}`, { method: 'PUT', body: { map: e.target.value } }); } catch (x) { fail(x); }
    };
    box.querySelector('#srClear').onclick = async () => {
      if (!(await confirmBox('Clear every mark and drawing for everyone?'))) return;
      try { await api(`sitrooms/${id}/clear`, { method: 'POST', body: {} }); } catch (x) { fail(x); }
    };
    box.querySelector('#srClose').onclick = async () => {
      if (!(await confirmBox('Close this room for everyone in it?'))) return;
      try { await api(`sitrooms/${id}/close`, { method: 'POST', body: {} }); location.hash = '#/sitrooms'; } catch (x) { fail(x); }
    };
  }
  main.querySelector('#srMembers').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b || !(await confirmBox(`Remove ${nameOf(Number(b.dataset.remove))} from the room?`))) return;
    try { await api(`sitrooms/${id}/remove/${b.dataset.remove}`, { method: 'POST', body: {} }); } catch (x) { fail(x); }
  });

  // Invite: WPG members only (no PMC guests), online and in-game first.
  async function inviteBox() {
    const all = await api('members').catch(() => []);
    const inRoom = new Set([...d.members.map((m) => m.user_id), ...d.requests.map((r) => r.user_id)]);
    const list = all.filter((u) => u.status === 'active' && u.membership !== 'pmc' && !inRoom.has(u.id))
      .sort((a, b) => (!!state.playing[b.id] - !!state.playing[a.id]) || (state.online.has(b.id) - state.online.has(a.id)) || a.name.localeCompare(b.name));
    const chosen = new Set();
    const m = modal(`<h3 style="margin-top:0">Invite members</h3>
      <input type="search" id="srSearch" placeholder="Search members" style="width:100%;margin-bottom:8px">
      <div id="srPick" class="sit-pick"></div>
      <div class="row" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="button" class="btn primary" id="srSend">Invite</button></div>`);
    const draw = () => {
      const s = m.el.querySelector('#srSearch').value.toLowerCase();
      m.el.querySelector('#srPick').innerHTML = list.filter((u) => !s || u.name.toLowerCase().includes(s) || (u.callsign || '').toLowerCase().includes(s))
        .slice(0, 60).map((u) => `<label class="sit-pick-row"><input type="checkbox" value="${u.id}" ${chosen.has(u.id) ? 'checked' : ''}>${userLine(u, state.playing[u.id] ? 'in game' : state.online.has(u.id) ? 'online' : '')}</label>`).join('')
        || '<p class="muted small">Nobody left to invite.</p>';
    };
    draw();
    m.el.querySelector('#srSearch').oninput = draw;
    m.el.querySelector('#srPick').onchange = (e) => { const v = Number(e.target.value); if (e.target.checked) chosen.add(v); else chosen.delete(v); };
    m.el.querySelector('[data-cancel]').onclick = m.close;
    m.el.querySelector('#srSend').onclick = async () => {
      if (!chosen.size) return m.close();
      try {
        const r = await api(`sitrooms/${id}/invite`, { method: 'POST', body: { users: [...chosen] } });
        toast('Invites sent', `${r.sent} member${r.sent === 1 ? '' : 's'} invited.`);
        m.close();
      } catch (x) { fail(x); }
    };
  }

  // ----- tools -----
  const hint = main.querySelector('#srHint');
  const drawBar = main.querySelector('#srDrawBar');
  function setTool(t) {
    tool = tool === t ? null : t;
    applyTool();
  }
  function applyTool() {
    points = [];
    draft.clearLayers();
    main.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('primary', b.dataset.tool === tool));
    const def = MARKERS[tool] || DRAWINGS[tool] || (tool === 'gun' ? { help: 'Tap where your gun is. Only you see it (it\'s the same position as on the Arty map).' } : null);
    hint.textContent = !d.is_member && tool !== 'gun' ? 'Join the room to mark the map.' : def ? def.help : 'Pick a tool, then tap the map.';
    drawBar.hidden = !(DRAWINGS[tool] && tool !== 'label');
  }
  function setColor(c) {
    color = c;
    main.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === c));
    main.querySelector('#srColorName').textContent = COLOR_NAMES[c];
  }
  main.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
  main.querySelectorAll('[data-color]').forEach((b) => { b.onclick = () => setColor(b.dataset.color); });
  setColor('blue');
  setTool(null);

  const send = async (body) => {
    try {
      const it = await api(`sitrooms/${id}/items`, { method: 'POST', body });
      upsert(it);
    } catch (x) { fail(x); }
  };
  function drawDraft() {
    draft.clearLayers();
    if (!points.length) return;
    const c = COLORS[color];
    points.forEach((p) => L.circleMarker(toLL(p), { radius: 5, color: '#000', weight: 1, fillColor: c, fillOpacity: 1, interactive: false }).addTo(draft));
    if (points.length > 1) L.polyline(points.map(toLL), { color: c, weight: 3, dashArray: '4 4', interactive: false }).addTo(draft);
  }
  async function finishDrawing() {
    const def = DRAWINGS[tool];
    if (!def) return;
    if (points.length < def.min) { toast('Not yet', def.min === 3 ? 'Tap at least 3 corners.' : 'Tap at least 2 points.', { error: true }); return; }
    await send({ kind: 'draw', type: tool, points, color });
    points = [];
    draft.clearLayers();
  }
  main.querySelector('#srFinish').onclick = finishDrawing;
  main.querySelector('#srUndoPt').onclick = () => { points.pop(); drawDraft(); };
  main.querySelector('#srCancel').onclick = () => setTool(null);

  function bindMapClicks() {
    lmap.on('click', async (e) => {
      if (!tool) return;
      const p = fromLL(e.latlng);
      if (p.x < 0 || p.y < 0 || p.x > UNITS || p.y > UNITS) return;
      if (tool === 'gun') {
        saveGun(map().id, p);
        setTool(null);
        render();
        if (pendingFire) { const it = items.find((x) => x.id === pendingFire); pendingFire = null; if (it) fireBox(it); }
        return;
      }
      if (!d.is_member) return;
      if (DRAWINGS[tool]) {
        if (tool === 'label') {
          const text = await promptText('Label', 'e.g. Wait for smoke');
          if (text) await send({ kind: 'draw', type: 'label', points: [p], text, color });
          return;
        }
        points.push(p);
        drawDraft();
        return;
      }
      const opts = await markerOptions(tool);
      if (opts === null) return;
      await send({ kind: 'marker', type: tool, at: p, ...opts });
      if (tool === 'me') setTool(null);
    });
  }
  bindMapClicks();

  // Asks what kind of enemy / need / etc. Returns the options, or null if cancelled.
  function markerOptions(type) {
    if (type === 'me') return Promise.resolve({});
    const select = (name, list) => `<select name="${name}">${list.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>`;
    const fields = {
      enemy: `<label class="field"><span>What</span>${select('what', ENEMY)}</label><label class="field"><span>How many (rough)</span><input type="number" name="count" value="1" min="1" max="50"></label>`,
      need: `<label class="field"><span>What's needed</span>${select('need', NEEDS)}</label>`,
      fob: '<label class="field"><span>Name (optional)</span><input type="text" name="name" maxlength="30" placeholder="e.g. FOB North"></label>',
      objective: `<label class="field"><span>Attack or defend</span>${select('goal', [['attack', 'Attack'], ['defend', 'Defend']])}</label>`,
      danger: `<label class="field"><span>What</span>${select('what', DANGER)}</label>`,
    }[type] || '';
    return new Promise((resolve) => {
      const m = modal(`<h3 style="margin-top:0">${MARKERS[type].emoji} ${esc(MARKERS[type].label)}</h3>
        <form class="stack" id="srOpt">${fields}<label class="field"><span>Note (optional)</span><input type="text" name="note" maxlength="80"></label>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary">Place</button></div></form>`);
      m.el.querySelector('[data-cancel]').onclick = () => { m.close(); resolve(null); };
      m.el.querySelector('#srOpt').onsubmit = (e) => {
        e.preventDefault();
        const out = Object.fromEntries(new FormData(e.target).entries());
        m.close();
        resolve(out);
      };
    });
  }
  function promptText(title, placeholder) {
    return new Promise((resolve) => {
      const m = modal(`<h3 style="margin-top:0">${esc(title)}</h3><form id="srTxt" class="stack"><input type="text" name="t" maxlength="40" placeholder="${esc(placeholder)}" autofocus>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary">Add</button></div></form>`);
      m.el.querySelector('[data-cancel]').onclick = () => { m.close(); resolve(''); };
      m.el.querySelector('#srTxt').onsubmit = (e) => { e.preventDefault(); const v = e.target.t.value.trim(); m.close(); resolve(v); };
    });
  }

  // Tap a mark: who placed it, when, and what you can do with it.
  function itemMenu(it) {
    const mine = it.user_id === state.me.id;
    const def = MARKERS[it.type] || DRAWINGS[it.type];
    const canDel = mine || d.can_manage || (it.type === 'need' && it.data.claimed_by === state.me.id);
    const refresh = d.is_member && (it.type === 'me' || it.type === 'enemy');
    const details = it.type === 'enemy' ? `${it.data.count}× ${label(ENEMY, it.data.what)}` : it.type === 'need' ? label(NEEDS, it.data.need)
      : it.type === 'fob' ? it.data.name : it.type === 'label' ? it.data.text : it.type === 'objective' ? label([['attack', 'Attack'], ['defend', 'Defend']], it.data.goal)
        : it.type === 'danger' ? label(DANGER, it.data.what) : '';
    const canFire = ['enemy', 'danger', 'objective'].includes(it.type);
    const m = modal(`<h3 style="margin-top:0">${def.emoji} ${esc(def.label)}${details ? ` — ${esc(details)}` : ''}</h3>
      ${it.data.note ? `<p>${esc(it.data.note)}</p>` : ''}
      <p class="muted small">By ${esc(nameOf(it.user_id))} · ${esc(timeAgo(it.created_at))}${it.expires_at ? ` · fades ${esc(fadesIn(it.expires_at))}` : ''}${it.data.firing_by ? ` · 💥 ${esc(nameOf(it.data.firing_by))} is firing on it` : ''}</p>
      <div class="row" style="gap:6px;justify-content:flex-end">
        ${canFire ? '<button class="btn primary" data-a="fire">🎯 Fire mission</button>' : ''}
        ${refresh ? `<button class="btn" data-a="refresh">${it.type === 'me' ? 'I\'m still here' : 'Still there'}</button>` : ''}
        ${canDel ? '<button class="btn danger" data-a="delete">Remove</button>' : ''}
        <button class="btn ghost" data-a="close">Close</button></div>`);
    m.el.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = async () => {
        m.close();
        try {
          if (b.dataset.a === 'refresh') await api(`sitrooms/${id}/items/${it.id}`, { method: 'PATCH', body: { action: 'refresh' } });
          if (b.dataset.a === 'delete') await api(`sitrooms/${id}/items/${it.id}`, { method: 'DELETE' });
          if (b.dataset.a === 'fire') await fireBox(it);
        } catch (x) { fail(x); }
      };
    });
  }
  // Fire mission: distance, bearing and elevation from your gun (the Arty map's) to the mark, and tell the room.
  async function fireBox(it) {
    guns ||= await api('artillery').catch(() => []);
    const saved = savedGun(map().id);
    if (!saved.gun) {
      const m = modal(`<h3 style="margin-top:0">🎯 Fire mission</h3>
        <p>Set your gun position first: tap where your gun is on the map. It's the same position as on the Arty map, and only you see it.</p>
        <div class="row" style="justify-content:flex-end;gap:6px"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-set>Set my gun on the map</button></div>`);
      m.el.querySelector('[data-x]').onclick = m.close;
      m.el.querySelector('[data-set]').onclick = () => { m.close(); pendingFire = it.id; tool = 'gun'; applyTool(); };
      return;
    }
    let weaponId = guns.some((g) => g.id === saved.weaponId) ? saved.weaponId : guns[0]?.id;
    const what = it.type === 'enemy' ? `${it.data.count}× ${label(ENEMY, it.data.what)}` : MARKERS[it.type].label;
    const m = modal(`<h3 style="margin-top:0">🎯 Fire mission — ${esc(what)}</h3>
      ${guns.length ? `<label class="field"><span>Gun</span><select id="fmGun">${guns.map((g) => `<option value="${esc(g.id)}" ${g.id === weaponId ? 'selected' : ''}>${esc(g.label)}</option>`).join('')}</select></label>` : '<p class="muted small">No gun tables set up (Admin → Artillery).</p>'}
      <div id="fmSol" class="arty-sol" style="margin:10px 0"></div>
      <p class="muted small" id="fmWho"></p>
      <div class="row" style="gap:6px;justify-content:flex-end;flex-wrap:wrap">
        <button class="btn" data-f="move">Move my gun</button>
        <a class="btn" href="#/map?map=${encodeURIComponent(map().id)}&target=${it.data.at.x},${it.data.at.y}">Open in Arty map</a>
        <button class="btn primary" data-f="fire"></button>
        <button class="btn ghost" data-f="close">Close</button></div>`);
    const draw = () => {
      const cur = items.find((x) => x.id === it.id) || it;
      const w = guns.find((g) => g.id === weaponId);
      const sol = solution(saved.gun, cur.data.at, w);
      m.el.querySelector('#fmSol').innerHTML = `<div><span>Elevation</span><b class="${sol.mil === null ? 'bad' : ''}">${sol.mil === null ? 'Out of range' : `${sol.mil} mil`}</b></div>
        <div><span>Bearing</span><b>${sol.bearing.toFixed(1)}°</b><em>${sol.bearingMil} mil</em></div>
        <div><span>Distance</span><b>${Math.round(sol.dist).toLocaleString('en-GB')} m</b></div>`;
      const mineFiring = cur.data.firing_by === state.me.id;
      m.el.querySelector('[data-f="fire"]').textContent = mineFiring ? 'Cease fire' : '💥 I\'m firing on it';
      m.el.querySelector('[data-f="fire"]').hidden = !d.is_member;
      m.el.querySelector('#fmWho').textContent = cur.data.firing_by ? `${nameOf(cur.data.firing_by)} is firing on it.` : 'Nobody is firing on it yet.';
    };
    draw();
    m.el.querySelector('#fmGun')?.addEventListener('change', (e) => { weaponId = e.target.value; saveGun(map().id, saved.gun, weaponId); draw(); });
    m.el.querySelector('[data-f="close"]').onclick = m.close;
    m.el.querySelector('[data-f="move"]').onclick = () => { m.close(); pendingFire = it.id; tool = 'gun'; applyTool(); };
    m.el.querySelector('[data-f="fire"]').onclick = async () => {
      const cur = items.find((x) => x.id === it.id) || it;
      try {
        const out = await api(`sitrooms/${id}/items/${it.id}`, { method: 'PATCH', body: { action: cur.data.firing_by === state.me.id ? 'ceasefire' : 'firing' } });
        upsert(out);
        draw();
      } catch (x) { fail(x); }
    };
  }

  const fadesIn = (iso) => {
    const s = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
    return s < 60 ? `in ${s}s` : `in ${Math.round(s / 60)} min`;
  };

  // ----- live -----
  function upsert(it) {
    const i = items.findIndex((x) => x.id === it.id);
    if (i >= 0) items[i] = it; else items.push(it);
    if (it.user_id && !users.has(it.user_id)) refresh().catch(() => {});
    render();
  }
  async function refresh() {
    const nd = await api(`sitrooms/${id}`);
    if (!alive()) return;
    const mapChanged = nd.room.map_id !== d.room.map_id;
    d = nd;
    users = new Map(d.users.map((u) => [u.id, u]));
    items = d.items;
    messages = d.messages || [];
    renderChat();
    if (mapChanged) {
      lmap.remove();
      lmap = buildMap(L, 'srMap', map());
      layer = L.layerGroup().addTo(lmap);
      draft = L.layerGroup().addTo(lmap);
      bindMapClicks();
      main.querySelector('#srMapName').textContent = map().name;
      setTimeout(() => lmap.invalidateSize(), 200);
    }
    render();
    renderPeople();
    applyTool();
  }
  onLive('sit', async (ev) => {
    if (ev.room !== id || !alive()) return;
    if (ev.type === 'item') {
      const isNew = !items.some((x) => x.id === ev.item.id);
      if (isNew && ev.item.user_id !== state.me.id && (ev.item.type === 'need' || ev.item.type === 'enemy')) alertBeep(ev.item.type);
      upsert(ev.item);
    } else if (ev.type === 'msg') {
      if (!messages.some((x) => x.id === ev.message.id)) {
        messages.push(ev.message);
        if (messages.length > 200) messages.shift();
        if (ev.message.user_id !== state.me.id) alertBeep('msg');
        if (ev.message.user_id && !users.has(ev.message.user_id)) refresh().catch(() => {});
        renderChat();
      }
    }
    else if (ev.type === 'item:removed') { items = items.filter((x) => x.id !== ev.id); render(); }
    else if (ev.type === 'cleared') { items = []; render(); toast('Board cleared', `By ${ev.by}.`); }
    else if (ev.type === 'closed') { toast('Room closed', `This room was ${ev.why}.`); location.hash = '#/sitrooms'; }
    else if (ev.type === 'removed' && ev.user_id === state.me.id) { toast('Removed', 'You were removed from the room.'); location.hash = '#/sitrooms'; }
    else {
      const asksBefore = d.requests.filter((r) => r.kind === 'ask').length;
      try { await refresh(); } catch (x) { if (x.status === 403 || x.status === 404) location.hash = '#/sitrooms'; }
      if (ev.type === 'requests' && d.can_manage && d.requests.filter((r) => r.kind === 'ask').length > asksBefore) alertBeep('ask');
      if (ev.type === 'room') toast('Map changed', `${ev.by} switched the map; the board was cleared.`);
    }
  });
  const watch = () => state.socket?.emit('sit:watch', id);
  watch();
  state.socket?.on('connect', watch);
  // Keeps the room open while it's on screen, and drops faded marks.
  const tick = setInterval(() => {
    if (!alive()) {
      clearInterval(tick);
      state.socket?.off('connect', watch);
      state.socket?.emit('sit:unwatch');
      return;
    }
    render();
  }, 10 * 1000);
  const beat = setInterval(() => { if (!alive()) clearInterval(beat); else watch(); }, 60 * 1000);

  render();
  renderPeople();
  renderChat();
}

// ---------- Admins: a saved copy of a board ----------
async function viewArchive(main, id, alive) {
  let a;
  try {
    a = await api(`sitrooms-archive/${id}`);
  } catch (x) {
    main.innerHTML = `<div class="panel empty"><p>${esc(x.message)}</p><a class="btn" href="#/sitrooms">Situation rooms</a></div>`;
    return;
  }
  const maps = await loadMaps();
  await loadLeaflet();
  if (!alive()) return;
  const L = window.L;
  const users = new Map(a.users.map((u) => [u.id, u]));
  const nameOf = (uid) => users.get(uid)?.name || 'Someone';
  const map = maps.find((m) => m.id === a.map_id) || maps[0];
  main.innerHTML = `
    <div style="margin-bottom:10px"><a href="#/sitrooms" class="small">← Situation rooms</a>
      <h1 style="margin:2px 0 0"><span class="sit-fac-dot" style="background:${esc(a.faction.color)}"></span> ${esc(a.name)} <span class="muted small">${esc(a.faction.name)} · ${esc(map.name)} · saved ${esc(timeAgo(a.created_at))}</span></h1>
      <p class="muted small" style="margin:4px 0 0">${esc(a.reason)}. In the room: ${esc(a.members.map((m) => m.name).join(', ') || '—')}. Read only.</p></div>
    <div class="sit-wrap">
      <div class="panel sit-map-panel"><div id="saMap" class="arty-map style-tactical"></div></div>
      <div class="sit-side">
        <div class="panel"><div class="panel-title" style="margin-bottom:8px">Marks <span class="sub">${a.items.length}</span></div>
          <div class="small">${a.items.filter((i) => i.kind === 'marker').map((i) => `<div>${MARKERS[i.type]?.emoji || ''} ${esc(MARKERS[i.type]?.label || i.type)} — ${esc(nameOf(i.user_id))}${i.data?.note ? `: ${esc(i.data.note)}` : ''}</div>`).join('') || '<span class="muted">No marks.</span>'}</div></div>
        <div class="panel"><div class="panel-title" style="margin-bottom:8px">💬 Room chat</div>
          <div class="sit-msgs">${a.messages.map((m) => `<div class="sit-msg"><b>${esc(nameOf(m.user_id))}</b> <span class="muted small">${fmtTime(m.created_at)}</span><div>${esc(m.body)}</div></div>`).join('') || '<p class="muted small" style="margin:0">No messages.</p>'}</div></div>
      </div>
    </div>`;
  const lmap = buildMap(L, 'saMap', map);
  const layer = L.layerGroup().addTo(lmap);
  for (const it of a.items) {
    try {
      (it.kind === 'marker' ? L.marker(toLL(it.data.at), { icon: markerIcon(L, it, nameOf), interactive: false }) : drawingLayer(L, it)).addTo(layer);
    } catch { /* skip a damaged mark */ }
  }
  setTimeout(() => lmap.invalidateSize(), 200);
}
