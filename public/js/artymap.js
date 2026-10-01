// Interactive artillery map: place your gun and targets, get distance, bearing and elevation.
// Map tiles were imported once from WARDOGS Tracker (with permission); map positions use the
// in-game coordinate system (1 unit = 100 m, x to the east, y to the south / down the map).
import { api, esc, fmtNum, elevationFor } from './app.js';
import { icon } from './icons.js';

const UNITS = 163.84; // map width/height in game units
const SCALE = 512 / UNITS; // Leaflet zoom-0 pixels per game unit
const toLL = (p) => window.L.latLng(-p.y * SCALE, p.x * SCALE);
const fromLL = (ll) => ({ x: ll.lng / SCALE, y: -ll.lat / SCALE });
const round2 = (v) => Math.round(v * 100) / 100;
const MAX_TARGETS = 8;
const MAP_STYLES = [['normal', 'Normal'], ['tactical', 'Tactical'], ['night', 'Night']];
let mapStyle = (() => { try { return localStorage.getItem('wpg.arty.style') || 'tactical'; } catch { return 'tactical'; } })();

let leafletReady = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (!leafletReady) {
    leafletReady = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/vendor/leaflet/leaflet.css';
      document.head.append(css);
      const js = document.createElement('script');
      js.src = '/vendor/leaflet/leaflet.js';
      js.onload = () => resolve();
      js.onerror = () => reject(new Error('Could not load the map library'));
      document.head.append(js);
    });
  }
  return leafletReady;
}

// Saved positions (per map) live on this device only.
const storeKey = (mapId) => `wpg.arty.${mapId}`;
function loadSaved(mapId) {
  try { return JSON.parse(localStorage.getItem(storeKey(mapId))) || {}; } catch { return {}; }
}
function save(mapId, data) {
  try { localStorage.setItem(storeKey(mapId), JSON.stringify(data)); } catch { /* storage blocked */ }
}

export function solution(gun, target, weapon) {
  const dx = (target.x - gun.x) * 100; // metres east
  const dy = (target.y - gun.y) * 100; // metres south
  const dist = Math.hypot(dx, dy);
  const bearing = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const mil = weapon ? elevationFor(weapon.table, weapon.min, weapon.max, dist) : null;
  return { dist, bearing, bearingMil: Math.round((bearing * 6400) / 360) % 6400, mil };
}

export async function viewArtyMap(main, _rest, alive) {
  main.innerHTML = '<div class="spinner"></div>';
  const [maps, guns] = await Promise.all([
    fetch('/maps/maps.json').then((r) => r.json()),
    api('artillery').catch(() => []),
    loadLeaflet(),
  ]).then(([m, g]) => [m, g]);
  if (!alive()) return;
  const L = window.L;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const map = maps.find((m) => m.id === params.get('map')) || maps[0];
  const saved = loadSaved(map.id);
  const st = {
    gun: saved.gun || null,
    targets: Array.isArray(saved.targets) ? saved.targets.slice(0, MAX_TARGETS) : [],
    weaponId: guns.some((g) => g.id === saved.weaponId) ? saved.weaponId : guns[0]?.id,
    mode: saved.gun ? 'target' : 'gun',
  };
  const weapon = () => guns.find((g) => g.id === st.weaponId);
  const persist = () => save(map.id, { gun: st.gun, targets: st.targets, weaponId: st.weaponId });

  main.innerHTML = `
    <div class="row between"><h1 style="margin:0">Artillery map</h1>
      <div class="tabs" style="margin:0">${maps.map((m) => `<a href="#/map?map=${m.id}" class="${m.id === map.id ? 'active' : ''}">${esc(m.name)}</a>`).join('')}</div></div>
    <div class="arty-map-wrap">
      <div class="panel arty-map-panel">
        <div id="artyMap" class="arty-map style-${esc(mapStyle)}"></div>
        <div class="arty-styles">${MAP_STYLES.map(([k, l]) => `<button type="button" class="btn small${k === mapStyle ? ' primary' : ''}" data-style="${k}">${l}</button>`).join('')}</div>
        <div class="arty-cursor" id="artyCursor">Tap the map to place your ${st.gun ? 'targets' : 'gun'}</div>
      </div>
      <div class="panel arty-side">
        <div class="arty-modes">
          <button type="button" class="btn small" data-mode="gun">${icon('crosshair')} Place gun</button>
          <button type="button" class="btn small" data-mode="target">${icon('target')} Place target</button>
          <button type="button" class="btn small ghost" id="artyClear">${icon('trash')} Clear</button>
        </div>
        <label class="field"><span>Gun</span><select id="artyWeapon">${guns.map((g) => `<option value="${esc(g.id)}" ${g.id === st.weaponId ? 'selected' : ''}>${esc(g.label)}${g.note ? ` (${esc(g.note)})` : ''}</option>`).join('')}</select></label>
        <div class="arty-coords">
          <span class="lbl">Gun position (in-game X, Y)</span>
          <div class="row" style="gap:6px;flex-wrap:nowrap">
            <input type="number" step="0.01" id="gunX" placeholder="X" inputmode="decimal">
            <input type="number" step="0.01" id="gunY" placeholder="Y" inputmode="decimal">
            <button type="button" class="btn small" id="gunSet">Set</button>
          </div>
          <span class="lbl" style="margin-top:8px">Add a target by coordinates</span>
          <div class="row" style="gap:6px;flex-wrap:nowrap">
            <input type="number" step="0.01" id="tgtX" placeholder="X" inputmode="decimal">
            <input type="number" step="0.01" id="tgtY" placeholder="Y" inputmode="decimal">
            <button type="button" class="btn small" id="tgtAdd">Add</button>
          </div>
        </div>
        <div id="artyResults"></div>
        <p class="muted small" style="margin:10px 0 0">Bearing = compass direction from your gun (0° / 0 mil = north). Elevation assumes gun and target are at the same height —
          fire a ranging shot, then use Add / Drop / Left / Right. Map from <a href="https://wardogstracker.gg/maps" target="_blank" rel="noopener">WARDOGS Tracker</a> (used with permission) ·
          firing tables from <a href="https://github.com/apollyon-sys/wardogs-calculator" target="_blank" rel="noopener">wardogs-calculator</a> (MIT) ·
          map engine <a href="/vendor/leaflet/LICENSE" target="_blank" rel="noopener">Leaflet</a>.</p>
      </div>
    </div>`;

  // ----- the map -----
  const worldBounds = L.latLngBounds(toLL({ x: 0, y: UNITS }), toLL({ x: UNITS, y: 0 }));
  const lmap = L.map('artyMap', {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: 6,
    zoomSnap: 0.25,
    maxBounds: worldBounds.pad(0.05),
    attributionControl: false,
    doubleClickZoom: false,
  });
  L.tileLayer(`/maps/${map.id}/{z}/{x}_{y}.webp`, {
    tileSize: 512,
    minZoom: 0,
    maxNativeZoom: 4,
    maxZoom: 6,
    noWrap: true,
    bounds: worldBounds,
    // A few edge tiles don't exist (empty land outside the playable area): show nothing instead.
    errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
  }).addTo(lmap);
  const play = map.bounds ? L.latLngBounds(toLL({ x: map.bounds.minX, y: map.bounds.maxY }), toLL({ x: map.bounds.maxX, y: map.bounds.minY })) : worldBounds;
  lmap.fitBounds(play);

  // 1 km grid (every 10 units)
  const grid = L.layerGroup().addTo(lmap);
  for (let v = 0; v <= UNITS; v += 10) {
    L.polyline([toLL({ x: v, y: 0 }), toLL({ x: v, y: UNITS })], { color: '#ffffff', weight: 1, opacity: 0.18, interactive: false }).addTo(grid);
    L.polyline([toLL({ x: 0, y: v }), toLL({ x: UNITS, y: v })], { color: '#ffffff', weight: 1, opacity: 0.18, interactive: false }).addTo(grid);
  }
  // Spawn areas + towers / faction markers
  for (const a of map.areas || []) {
    L.polygon(a.points.map(([x, y]) => toLL({ x, y })), { color: a.color, weight: 2, dashArray: '6 6', fillOpacity: 0.12, interactive: false }).addTo(lmap)
      .bindTooltip(esc(a.label), { direction: 'center', className: 'arty-label' });
  }
  for (const m of map.markers || []) {
    const color = { valkyra: '#e5484d', manticore: '#3ddc84', lonestar: '#4cb1ef' }[m.icon] || '#e3b341';
    L.circleMarker(toLL(m), { radius: m.icon === 'tower' ? 5 : 7, color: '#000', weight: 1, fillColor: color, fillOpacity: 0.95 })
      .addTo(lmap).bindTooltip(esc(m.label), { className: 'arty-label' });
  }

  const layer = L.layerGroup().addTo(lmap);
  const gunIcon = L.divIcon({ className: 'arty-pin gun', html: icon('crosshair'), iconSize: [34, 34], iconAnchor: [17, 17] });
  const targetIcon = (n) => L.divIcon({ className: 'arty-pin tgt', html: `<b>${n}</b>`, iconSize: [30, 30], iconAnchor: [15, 15] });

  const results = main.querySelector('#artyResults');
  function redraw() {
    layer.clearLayers();
    const w = weapon();
    if (st.gun) {
      const gm = L.marker(toLL(st.gun), { icon: gunIcon, draggable: true, title: 'Your gun' }).addTo(layer);
      gm.on('drag', (e) => { st.gun = fromLL(e.target.getLatLng()); drawResults(); });
      gm.on('dragend', () => { persist(); redraw(); });
      if (w) {
        const ring = (m, dash) => L.circle(toLL(st.gun), { radius: (m / 100) * SCALE, color: '#29b6f6', weight: 1.5, dashArray: dash, fill: false, interactive: false }).addTo(layer);
        ring(w.max, null);
        if (w.min > 0) ring(w.min, '4 6');
      }
    }
    st.targets.forEach((t, i) => {
      const sol = st.gun ? solution(st.gun, t, w) : null;
      if (st.gun) {
        L.polyline([toLL(st.gun), toLL(t)], { color: sol?.mil === null ? '#e5484d' : '#f5c542', weight: 2, dashArray: '8 6', interactive: false }).addTo(layer);
      }
      const tm = L.marker(toLL(t), { icon: targetIcon(i + 1), draggable: true, title: `Target ${i + 1}` }).addTo(layer);
      if (sol) {
        tm.bindTooltip(`${fmtNum(Math.round(sol.dist))} m · ${sol.bearing.toFixed(1)}° · ${sol.mil === null ? 'out of range' : `${sol.mil} mil`}`, { permanent: true, direction: 'right', offset: [16, 0], className: 'arty-label strong' });
      }
      tm.on('drag', (e) => { st.targets[i] = fromLL(e.target.getLatLng()); drawResults(); });
      tm.on('dragend', () => { persist(); redraw(); });
    });
    drawResults();
    main.querySelector('#gunX').value = st.gun ? round2(st.gun.x) : '';
    main.querySelector('#gunY').value = st.gun ? round2(st.gun.y) : '';
    main.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('primary', b.dataset.mode === st.mode));
  }

  function drawResults() {
    const w = weapon();
    if (!st.gun) { results.innerHTML = '<p class="muted">Tap <b>Place gun</b>, then tap your firing position on the map (or type its X, Y above).</p>'; return; }
    if (!st.targets.length) { results.innerHTML = `<p class="muted">Gun at X ${round2(st.gun.x)}, Y ${round2(st.gun.y)}. Now tap the map to mark a target.</p>`; return; }
    results.innerHTML = st.targets.map((t, i) => {
      const s = solution(st.gun, t, w);
      return `<div class="arty-tgt">
        <div class="row between"><b>Target ${i + 1}</b><span class="muted small">X ${round2(t.x)} · Y ${round2(t.y)}</span>
          <button type="button" class="btn small ghost" data-del-tgt="${i}" aria-label="Remove target ${i + 1}">${icon('trash')}</button></div>
        <div class="arty-sol">
          <div><span>Elevation</span><b class="${s.mil === null ? 'bad' : ''}">${s.mil === null ? 'Out of range' : `${s.mil} mil`}</b></div>
          <div><span>Bearing</span><b>${s.bearing.toFixed(1)}°</b><em>${s.bearingMil} mil</em></div>
          <div><span>Distance</span><b>${fmtNum(Math.round(s.dist))} m</b></div>
        </div>
        <div class="row" style="gap:4px">${[['add', 'Add 10'], ['drop', 'Drop 10'], ['left', 'Left 10'], ['right', 'Right 10']].map(([k, l]) => `<button type="button" class="btn small" data-adj="${k}" data-i="${i}">${l} m</button>`).join('')}</div>
      </div>`;
    }).join('');
  }

  // Move a target 10 m along / across the line of fire.
  function adjust(i, how) {
    const t = st.targets[i];
    const s = solution(st.gun, t, null);
    const rad = (s.bearing * Math.PI) / 180;
    const step = 10 / 100; // 10 m in units
    const fwd = { x: Math.sin(rad), y: -Math.cos(rad) };
    const right = { x: Math.cos(rad), y: Math.sin(rad) };
    const d = { add: [fwd, 1], drop: [fwd, -1], right: [right, 1], left: [right, -1] }[how];
    st.targets[i] = { x: t.x + d[0].x * step * d[1], y: t.y + d[0].y * step * d[1] };
    persist();
    redraw();
  }

  lmap.on('click', (e) => {
    const p = fromLL(e.latlng);
    if (p.x < 0 || p.y < 0 || p.x > UNITS || p.y > UNITS) return;
    if (st.mode === 'gun') {
      st.gun = p;
      st.mode = 'target';
    } else {
      if (!st.gun) { st.gun = p; persist(); redraw(); return; }
      if (st.targets.length >= MAX_TARGETS) st.targets.shift();
      st.targets.push(p);
    }
    persist();
    redraw();
  });
  const cursor = main.querySelector('#artyCursor');
  lmap.on('mousemove', (e) => {
    const p = fromLL(e.latlng);
    let extra = '';
    if (st.gun) { const s = solution(st.gun, p, weapon()); extra = ` · ${fmtNum(Math.round(s.dist))} m · ${s.bearing.toFixed(0)}°${s.mil === null ? '' : ` · ${s.mil} mil`}`; }
    cursor.textContent = `X ${round2(p.x)} · Y ${round2(p.y)}${extra}`;
  });

  main.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { st.mode = b.dataset.mode; redraw(); }; });
  main.querySelectorAll('[data-style]').forEach((b) => {
    b.onclick = () => {
      mapStyle = b.dataset.style;
      try { localStorage.setItem('wpg.arty.style', mapStyle); } catch { /* storage blocked */ }
      const el = main.querySelector('#artyMap');
      MAP_STYLES.forEach(([k]) => el.classList.toggle(`style-${k}`, k === mapStyle));
      main.querySelectorAll('[data-style]').forEach((x) => x.classList.toggle('primary', x === b));
    };
  });
  main.querySelector('#artyClear').onclick = () => { st.gun = null; st.targets = []; st.mode = 'gun'; persist(); redraw(); };
  main.querySelector('#artyWeapon').onchange = (e) => { st.weaponId = e.target.value; persist(); redraw(); };
  const num = (id) => Number(main.querySelector(id).value);
  const inMap = (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= UNITS && p.y <= UNITS;
  main.querySelector('#gunSet').onclick = () => {
    const p = { x: num('#gunX'), y: num('#gunY') };
    if (!inMap(p)) return;
    st.gun = p; st.mode = 'target'; persist(); redraw(); lmap.panTo(toLL(p));
  };
  main.querySelector('#tgtAdd').onclick = () => {
    const p = { x: num('#tgtX'), y: num('#tgtY') };
    if (!inMap(p)) return;
    if (st.targets.length >= MAX_TARGETS) st.targets.shift();
    st.targets.push(p); persist(); redraw();
    main.querySelector('#tgtX').value = ''; main.querySelector('#tgtY').value = '';
  };
  results.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-tgt]');
    const adj = e.target.closest('[data-adj]');
    if (del) { st.targets.splice(Number(del.dataset.delTgt), 1); persist(); redraw(); }
    if (adj) adjust(Number(adj.dataset.i), adj.dataset.adj);
  });
  redraw();
  // Leaflet needs a size check once the layout settles (e.g. on phones).
  setTimeout(() => lmap.invalidateSize(), 200);
}
