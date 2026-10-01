import { icon } from './icons.js';
import { rankBadge, insigniaSVG } from './insignia.js';

// ---------- Shared helpers ----------
export const state = {
  me: null,
  settings: {},
  online: new Set(),
  unread: 0,
  friendReq: 0,
  socket: null,
  users: new Map(),
};

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export async function api(path, { method = 'GET', body } = {}) {
  const url = path.startsWith('/') ? path : `/api/${path}`;
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

export function toast(title, body = '', { error = false, link = '' } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = `<b>${esc(title)}</b>${esc(body)}`;
  el.onclick = () => {
    if (link) location.hash = link;
    el.remove();
  };
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}
export const fail = (e) => toast('Error', e.message, { error: true });

export function modal(inner) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal panel glow">${inner}</div>`;
  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  return { el: back.firstElementChild, close };
}

export function confirmBox(text) {
  return new Promise((resolve) => {
    const m = modal(`<p>${esc(text)}</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>Cancel</button><button class="btn danger" data-yes>Confirm</button></div>`);
    m.el.querySelector('[data-no]').onclick = () => { m.close(); resolve(false); };
    m.el.querySelector('[data-yes]').onclick = () => { m.close(); resolve(true); };
  });
}

export const fmtNum = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 }));
export const fmtMoney = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
export function fmtMins(m) {
  if (m === null || m === undefined || m === '') return '—';
  const mins = Math.round(Number(m));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h.toLocaleString('en-GB')}h ${mins % 60}m`;
}
export function timeAgo(d) {
  if (!d) return 'never';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(d).toLocaleDateString('en-GB');
}
export const fmtTime = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const FLAGS = { US: '🇺🇸', GB: '🇬🇧', CA: '🇨🇦', AU: '🇦🇺', IE: '🇮🇪', NZ: '🇳🇿', DE: '🇩🇪', FR: '🇫🇷', NL: '🇳🇱' };
export const COUNTRIES = [['', 'Not set'], ['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'], ['AU', 'Australia'], ['IE', 'Ireland'], ['NZ', 'New Zealand'], ['DE', 'Germany'], ['FR', 'France'], ['NL', 'Netherlands']];
export const flag = (c) => FLAGS[c] || '';

const FALLBACK_AVATAR = '/img/icon-192.png';
export function avatar(u, cls = '') {
  const on = state.online.has(u?.id);
  return `<span class="av-wrap"><img class="avatar ${cls}" src="${esc(u?.avatar || FALLBACK_AVATAR)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="dot ${on ? 'on' : ''}" data-online="${u?.id}"></span></span>`;
}
export function rolePill(u) {
  const dev = (u.developer ? ' <span class="pill dev">Developer</span>' : '') + (u.membership === 'pmc' ? ' <span class="pill pmc">PMC</span>' : '');
  if (u.status === 'pending') return `<span class="pill pending">Pending</span>${dev}`;
  if (u.status === 'banned') return `<span class="pill banned">Banned</span>${dev}`;
  if (u.role === 'admin') return `<span class="pill admin">Admin</span>${dev}`;
  if (u.role === 'mod') return `<span class="pill mod">Mod</span>${dev}`;
  return dev.trim();
}
const isPmc = (u) => u?.membership === 'pmc';
// PMCs (guests) have no rank, so they get a PMC badge instead.
export function badgeFor(u, size) {
  return isPmc(u) ? insigniaSVG({}, { size, abbr: 'PMC', color: '#f5a524', title: 'PMC (guest)' }) : rankBadge(u?.rank, size);
}
const rankName = (u) => (isPmc(u) ? 'PMC · Guest' : u?.rank ? u.rank.name : 'No rank');
export function userLine(u, meta = '') {
  return `<div class="user-line">${avatar(u)}${badgeFor(u, 34)}
    <div class="grow"><div class="name">${esc(u.name)} ${rolePill(u)}</div>
    <div class="meta">${esc(rankName(u))}${u.callsign ? ` · “${esc(u.callsign)}”` : ''}${meta ? ` · ${meta}` : ''}</div></div></div>`;
}

const isStaff = () => ['mod', 'admin'].includes(state.me?.role);

// The clan's artwork logo, unless an admin has set a different one in Settings.
const brandLogo = () => {
  const u = state.settings.logo_url;
  return !u || u === '/img/logo.svg' ? '/img/brand/wpg-logo.webp' : u;
};
const footerArt = () => `<footer class="site-footer"><img src="/img/brand/footer.webp" alt="Same game, bigger brotherhood. Wasted Prodigy Gamers. Play harder together." loading="lazy"></footer>`;

// ---------- View lifecycle ----------
let viewListeners = [];
export function onLive(event, fn) {
  viewListeners.push([event, fn]);
}
function emitLive(event, data) {
  for (const [e, fn] of viewListeners) if (e === event) fn(data);
}

// ---------- Boot ----------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  state.settings = await api('settings/public').catch(() => ({}));
  if (state.settings.accent_color) document.documentElement.style.setProperty('--accent', state.settings.accent_color);
  document.title = state.settings.clan_tag ? `${state.settings.clan_tag} Barracks` : 'WPG Barracks';
  try {
    let me;
    try {
      me = await api('me');
    } catch (e) {
      // Sign-in cookie lost (e.g. the Android app closed too quickly)? Use this device's remember key.
      if (e.status !== 401 || !(await resumeSignIn())) throw e;
      me = await api('me');
    }
    applyMe(me);
  } catch (e) {
    if (e.status === 401 || e.code === 'banned') return renderLogin(e.code === 'banned' ? 'banned' : '');
    document.getElementById('app').innerHTML = `<div class="login"><div class="box panel"><h2>Can't reach HQ</h2><p class="muted">${esc(e.message)}</p><button class="btn primary" id="retry">Try again</button></div></div>`;
    document.getElementById('retry').onclick = () => location.reload();
    return;
  }
  if (state.me.status === 'pending') return renderPending();
  renderShell();
  connectSocket();
  window.addEventListener('hashchange', route);
  route();
}

const REMEMBER_KEY = 'wpg.remember';
const getRemember = () => { try { return localStorage.getItem(REMEMBER_KEY) || ''; } catch { return ''; } };
const setRemember = (t) => { try { if (t) localStorage.setItem(REMEMBER_KEY, t); else localStorage.removeItem(REMEMBER_KEY); } catch { /* storage blocked */ } };
async function resumeSignIn() {
  const token = getRemember();
  if (!token) return false;
  try {
    await api('/auth/resume', { method: 'POST', body: { token } });
    return true;
  } catch (e) {
    if (e.status === 401) setRemember('');
    return false;
  }
}

function applyMe(me) {
  if (me.remember_token) setRemember(me.remember_token);
  state.me = me.user;
  state.unread = me.unread_dms;
  state.friendReq = me.friend_requests;
  state.trackerLinked = !!me.tracker_linked;
  state.realSteam = !!me.real_steam;
  state.users.set(me.user.id, me.user);
}

async function refreshMe() {
  try {
    applyMe(await api('me'));
    updateNav();
    emitLive('me', state.me);
  } catch (e) {
    if (e.status === 401 || e.status === 403) location.reload();
  }
}

// ---------- Login / pending ----------
async function renderLogin(reason = '') {
  const s = state.settings;
  const cfg = await api('/auth/config').catch(() => ({}));
  const err = new URLSearchParams(location.hash.split('?')[1] || '').get('error') || reason;
  const msg = { steam: 'Steam sign-in did not complete. Please try again.', banned: 'This account has been banned.', server: 'Server error during sign-in. Try again.' }[err];
  document.getElementById('app').innerHTML = `
    <div class="login"><div class="box">
      <img class="logo" src="${esc(brandLogo())}" alt="${esc(s.clan_name || 'WPG')}">
      <div class="tagline" style="margin-top:6px">Real players <b>•</b> Real squads <b>•</b> Real community</div>
      ${s.motto ? `<p class="accent" style="font:600 18px var(--head);letter-spacing:1px;text-transform:uppercase;margin:10px 0 0">${esc(s.motto)}</p>` : ''}
      <div class="panel glow stack" style="margin-top:24px">
        <p>Members only. Sign in with your Steam account. Your Steam name is your name here.</p>
        ${msg ? `<p style="color:var(--red)">${esc(msg)}</p>` : ''}
        <a class="btn steam-btn" href="/auth/steam">${icon('steam')} Sign in through Steam</a>
        ${cfg.dev_login ? `<form id="dev" class="row" style="border-top:1px solid var(--line);padding-top:14px">
            <input type="text" name="name" placeholder="Test name" class="grow" maxlength="32">
            <button class="btn">Test login</button></form>
            <p class="small muted">Test login is on (DEV_LOGIN). Turn it off before going live.</p>` : ''}
      </div>
      <div class="scripts"><span class="script">More than a game</span><span class="script">Play harder together</span></div>
    </div></div>`;
  document.getElementById('dev')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/auth/dev', { method: 'POST', body: { name: e.target.name.value } });
      location.hash = '#/';
      location.reload();
    } catch (x) { fail(x); }
  });
}

function renderPending() {
  document.getElementById('app').innerHTML = `
    <div class="login"><div class="box">
      <img class="logo" src="${esc(brandLogo())}" alt="">
      <div class="panel glow stack" style="margin-top:20px">
        <h2>Awaiting orders</h2>
        <p>Thanks, <b>${esc(state.me.name)}</b>. Your account is waiting for a mod or admin to approve it.</p>
        <p class="muted">You will get full access as soon as you are approved. Check back soon.</p>
        <div class="row" style="justify-content:center">
          <button class="btn primary" id="recheck">${icon('refresh')} Check again</button>
          <button class="btn ghost" id="logout">${icon('logout')} Sign out</button>
        </div>
      </div></div></div>`;
  document.getElementById('logout').onclick = logout;
  document.getElementById('recheck').onclick = () => location.reload();
}

async function logout() {
  await api('/auth/logout', { method: 'POST', body: { token: getRemember() } }).catch(() => {});
  setRemember('');
  location.hash = '#/';
  location.reload();
}

// ---------- Shell & nav ----------
const NAV = [
  { href: '#/', key: 'home', label: 'HQ', icon: 'home' },
  { href: '#/chat', key: 'chat', label: 'Comms', icon: 'chat' },
  { href: '#/messages', key: 'messages', label: 'Messages', icon: 'mail', count: () => state.unread },
  { href: '#/friends', key: 'friends', label: 'Friends', icon: 'friends', count: () => state.friendReq },
  { href: '#/servers', key: 'servers', label: 'Servers', icon: 'server' },
  { href: '#/members', key: 'members', label: 'Members', icon: 'users' },
  { href: '#/leaderboard', key: 'leaderboard', label: 'Leaderboard', icon: 'trophy' },
  { href: '#/map', key: 'map', label: 'Arty map', icon: 'target' },
  { href: '#/progression', key: 'progression', label: 'Progression', icon: 'unlock' },
  { href: '#/ranks', key: 'ranks', label: 'Ranks', icon: 'chevrons' },
  { sep: true },
  { href: () => `#/u/${state.me.id}`, key: 'me', label: 'My career', icon: 'user' },
  { href: '#/profile/edit', key: 'edit', label: 'Edit profile', icon: 'edit' },
  { href: '#/admin', key: 'admin', label: 'Admin', icon: 'shield', staff: true },
];
const BOTTOM = ['home', 'chat', 'messages', 'friends'];

function navLink(n) {
  const href = typeof n.href === 'function' ? n.href() : n.href;
  const c = n.count?.() || 0;
  return `<a href="${href}" data-nav="${n.key}">${icon(n.icon)}<span>${n.label}</span>${c ? `<span class="badge-count">${c}</span>` : ''}</a>`;
}

function renderShell() {
  const s = state.settings;
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><img class="brand-logo" src="${esc(brandLogo())}" alt="${esc(s.clan_name || 'WPG')}"><div class="tag">Barracks</div></div>
        <nav class="nav" id="nav"></nav>
        <div class="sidebar-art"><span class="script">More than a game</span></div>
        <div class="me-card" id="mecard"></div>
      </aside>
      <div style="min-width:0">
        <header class="topbar">
          <button class="btn ghost small" id="menuBtn" aria-label="Menu">${icon('menu')}</button>
          <img src="/img/icon-192.png" alt=""><div class="title" id="topTitle">${esc(s.clan_name || 'WPG')}</div>
        </header>
        <main class="main" id="main"></main>
        <div class="main footer-wrap">${footerArt()}</div>
      </div>
      <nav class="bottomnav" id="bottomnav"></nav>
    </div>`;
  const sidebar = document.getElementById('sidebar');
  let scrim;
  const closeMenu = () => { sidebar.classList.remove('open'); scrim?.remove(); scrim = null; };
  document.getElementById('menuBtn').onclick = () => {
    sidebar.classList.add('open');
    scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.onclick = closeMenu;
    document.body.append(scrim);
  };
  sidebar.addEventListener('click', (e) => { if (e.target.closest('a')) closeMenu(); });
  updateNav();
}

function updateNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.innerHTML = NAV.filter((n) => !n.staff || isStaff()).map((n) => (n.sep ? '<div class="sep"></div>' : navLink(n))).join('');
  document.getElementById('bottomnav').innerHTML =
    NAV.filter((n) => BOTTOM.includes(n.key)).map(navLink).join('') +
    `<a href="#" id="moreBtn">${icon('menu')}<span>More</span></a>`;
  document.getElementById('moreBtn').onclick = (e) => { e.preventDefault(); document.getElementById('menuBtn').click(); };
  const me = state.me;
  document.getElementById('mecard').innerHTML = `${avatar(me, 'sm')}<div class="grow"><b>${esc(me.name)}</b><div class="muted">${isPmc(me) ? 'PMC' : me.rank ? esc(me.rank.abbr) : 'No rank'} · ${fmtNum(me.xp)} XP</div></div>
    <button class="btn ghost small" id="logoutBtn" title="Sign out" aria-label="Sign out">${icon('logout')}</button>`;
  document.getElementById('logoutBtn').onclick = logout;
  markActive();
}

function markActive() {
  const key = currentKey();
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
}
function currentKey() {
  const [first, second] = parts();
  if (!first) return 'home';
  if (first === 'u' && Number(second) === state.me.id) return 'me';
  if (first === 'profile') return 'edit';
  return first;
}
const parts = () => location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
export const query = () => new URLSearchParams(location.hash.split('?')[1] || '');

// ---------- Socket ----------
function connectSocket() {
  if (!window.io) return;
  const socket = window.io({ transports: ['websocket', 'polling'] });
  state.socket = socket;
  socket.on('presence', (ids) => {
    state.online = new Set(ids);
    document.querySelectorAll('[data-online]').forEach((d) => d.classList.toggle('on', state.online.has(Number(d.dataset.online))));
    emitLive('presence', ids);
  });
  socket.on('chat:new', (d) => {
    if (d.user) state.users.set(d.user.id, d.user);
    (d.mentioned || []).forEach((u) => state.users.set(u.id, u));
    emitLive('chat:new', d);
  });
  socket.on('chat:deleted', (d) => emitLive('chat:deleted', d));
  socket.on('typing', (d) => emitLive('typing', d));
  socket.on('dm:new', (d) => {
    const mine = d.dm.sender_id === state.me.id;
    const openHere = parts()[0] === 'messages' && Number(parts()[1]) === d.dm.sender_id;
    if (!mine && !openHere) {
      state.unread++;
      updateNav();
      toast(`Message from ${d.user.name}`, d.dm.body.slice(0, 80), { link: `#/messages/${d.dm.sender_id}` });
    }
    emitLive('dm:new', d);
  });
  socket.on('counts', refreshMe);
  socket.on('notify', (n) => {
    toast(n.title, n.body, { link: n.link });
    refreshMe();
  });
  socket.on('me:changed', refreshMe);
  socket.on('friends:changed', () => { refreshMe(); emitLive('friends', null); });
  socket.on('server:board', () => emitLive('server-board'));
  socket.on('config:changed', async (name) => {
    if (name === 'settings') state.settings = await api('settings/public').catch(() => state.settings);
    emitLive('config', name);
  });
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') refreshMe();
  });
}

// ---------- Router ----------
let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  viewListeners = [];
  markActive();
  const main = document.getElementById('main');
  main.onclick = null;
  main.innerHTML = '<div class="spinner"></div>';
  window.scrollTo(0, 0);
  const [first, ...rest] = parts();
  const views = {
    '': viewHome,
    chat: viewChat,
    messages: viewMessages,
    friends: viewFriends,
    members: viewMembers,
    servers: viewServers,
    leaderboard: viewLeaderboard,
    progression: viewTools,
    tools: () => { location.hash = '#/progression'; },
    map: async (m, r, alive) => (await import('./artymap.js')).viewArtyMap(m, r, alive),
    ranks: viewRanks,
    u: viewProfile,
    profile: viewEditProfile,
    admin: async (m, r) => (await import('./admin.js')).viewAdmin(m, r),
    login: () => { location.hash = '#/'; },
  };
  const view = views[first || ''] || viewNotFound;
  try {
    await view(main, rest, () => seq === routeSeq);
  } catch (e) {
    if (seq !== routeSeq) return;
    main.innerHTML = `<div class="panel empty"><h3>Something went wrong</h3><p>${esc(e.message)}</p></div>`;
  }
}

function viewNotFound(main) {
  main.innerHTML = '<div class="panel empty"><h2>Lost in the fog</h2><p>That page does not exist.</p><a class="btn" href="#/">Back to HQ</a></div>';
}

// ---------- HQ ----------
async function viewHome(main) {
  const me = state.me;
  const [ranks, news, members] = await Promise.all([api('ranks'), api('announcements'), api('members')]);
  const next = ranks.filter((r) => r.auto && r.min_xp > me.xp).sort((a, b) => a.min_xp - b.min_xp)[0];
  const cur = me.rank;
  let progress = '';
  if (isPmc(me)) {
    progress = `<p class="muted small">You're a PMC (guest) — PMCs don't hold a ${esc(state.settings.clan_tag || 'WPG')} rank. You still earn XP (${fmtNum(me.xp)}).</p>`;
  } else if (cur && !cur.auto) {
    progress = '<p class="muted small">Appointed rank — promotions from here are given by command.</p>';
  } else if (next) {
    const base = cur?.auto ? cur.min_xp : 0;
    const pct = Math.max(0, Math.min(100, ((me.xp - base) / (next.min_xp - base)) * 100));
    progress = `<div class="row between small"><span>${fmtNum(me.xp)} XP</span><span class="muted">Next: ${esc(next.name)} at ${fmtNum(next.min_xp)} XP</span></div>
      <div class="xpbar"><div style="width:${pct.toFixed(1)}%"></div></div>`;
  } else {
    progress = '<p class="muted small">Top of the XP ladder. Higher ranks are appointed by command.</p>';
  }
  const onlineOthers = () => members.filter((u) => u.id !== me.id && state.online.has(u.id));
  const onlineHtml = () => {
    const list = onlineOthers();
    return list.length ? list.map((u) => `<a class="item" href="#/u/${u.id}">${userLine(u)}</a>`).join('') : '<p class="muted">Nobody else is online right now.</p>';
  };
  main.innerHTML = `
    <div class="stack">
      <div class="panel glow hero">
        <div class="hero-art"></div>
        <div class="hero-script script">Play harder<br>together</div>
        <div class="hero-body">
          ${badgeFor(me, 110)}
          <div class="who grow" style="min-width:220px">
            <div class="tagline">Welcome back, soldier</div>
            <div class="metal" style="font-size:34px;line-height:1.1;overflow-wrap:anywhere">${esc(me.name)}</div>
            <div class="accent" style="font:700 19px var(--head);text-transform:uppercase;letter-spacing:1px">${isPmc(me) ? 'PMC · Guest' : cur ? `${esc(cur.name)} · ${esc(cur.abbr)}` : 'Unranked'}</div>
            <div style="margin-top:10px;max-width:520px">${progress}</div>
            ${state.settings.welcome_message ? `<p class="muted" style="margin:10px 0 0;max-width:560px">${esc(state.settings.welcome_message)}</p>` : ''}
            <div class="row" style="margin-top:14px"><a class="btn primary" href="#/u/${me.id}">${icon('user')} My career</a><button class="btn" id="syncBtn">${icon('refresh')} Sync stats</button></div>
          </div>
        </div>
      </div>
      ${needsTracker() ? trackerCardHtml() : ''}
      <div class="grid two">
        <div class="panel">
          <div class="panel-title">${icon('bell')} Orders & news</div>
          ${news.length ? news.map((n) => `
            <div style="padding:10px 0;border-bottom:1px solid #13263d">
              <div class="row between"><b style="font:700 17px var(--head);text-transform:uppercase">${n.pinned ? '📌 ' : ''}${esc(n.title)}</b><span class="muted small">${fmtDate(n.created_at)}</span></div>
              <div style="white-space:pre-wrap">${esc(n.body)}</div>
              ${n.author ? `<div class="muted small">— ${esc(n.author)}</div>` : ''}
            </div>`).join('') : '<p class="muted">No announcements yet.</p>'}
        </div>
        <div class="panel">
          <div class="panel-title">${icon('users')} On duty now <span class="sub" id="onlineCount">${onlineOthers().length}</span></div>
          <div class="list" id="onlineList">${onlineHtml()}</div>
        </div>
      </div>
      <div class="panel discord-panel" id="voicePanel"><div class="panel-title">${icon('discord')} Discord <span class="sub">comms</span></div><div data-voice></div></div>
    </div>`;
  document.getElementById('syncBtn').onclick = syncMine;
  startVoice(main.querySelector('#voicePanel [data-voice]'), { alive: () => document.body.contains(main.querySelector('#voicePanel')) });
  onLive('presence', () => {
    const el = document.getElementById('onlineList');
    if (!el) return;
    el.innerHTML = onlineHtml();
    document.getElementById('onlineCount').textContent = onlineOthers().length;
  });
}

async function syncMine(e) {
  const btn = e?.currentTarget;
  if (btn) btn.disabled = true;
  try {
    const r = await api('me/sync', { method: 'POST', body: {} });
    const notes = [];
    if (r.steam && !r.steam.ok) notes.push(`Steam: ${r.steam.reason}`);
    if (r.steam?.private) notes.push('Steam: your game details are private, so playtime cannot be read.');
    if (r.wardogs && !r.wardogs.ok) notes.push(`Wardogs: ${r.wardogs.reason}`);
    else if (r.wardogs && !r.wardogs.official) notes.push('Wardogs: no global stats found. Sign in at wardogstracker.gg once to share them.');
    toast('Stats synced', notes.join(' ') || 'All up to date.');
    await refreshMe();
    route();
  } catch (x) {
    fail(x);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- WARDOGS Tracker linking ----------
// Players must sign in on WARDOGS Tracker themselves (their Steam login can't be done for them).
// We open the tracker's own "Sync my stats" page and then keep checking until their stats appear.
const TRACKER_CONNECT = 'https://wardogstracker.gg/api/wardogs/connect?redirect=/';
const needsTracker = () => state.realSteam && !state.trackerLinked;

function trackerCardHtml() {
  return `<div class="panel glow tracker-card" data-tracker-card>
    <div class="row" style="align-items:flex-start;gap:16px">
      <img src="/img/brand/wolf-emblem.webp" alt="" style="width:74px;border-radius:6px">
      <div class="grow" style="min-width:220px">
        <div class="panel-title" style="margin-bottom:8px">${icon('target')} Link your <span class="sub">Wardogs stats</span></div>
        <p style="margin:0 0 6px">One-time, about a minute: sign in to <b>WARDOGS Tracker</b> with Steam and press <b>Sync</b>.
          Your level, XP, cash and role levels then show here and <b>update by themselves</b>.</p>
        <p class="muted small" data-tracker-status style="margin:0 0 10px">We'll spot it automatically when you're done.</p>
        <div class="row">
          <a class="btn primary" href="${TRACKER_CONNECT}" target="_blank" rel="noopener" data-tracker-link>${icon('steam')} Link WARDOGS Tracker</a>
          <button class="btn ghost" type="button" data-tracker-check>I've done it — check now</button>
        </div>
      </div>
    </div>
  </div>`;
}

let trackerWatch = null;
function stopTrackerWatch() {
  if (!trackerWatch) return;
  clearInterval(trackerWatch.timer);
  document.removeEventListener('visibilitychange', trackerWatch.onVisible);
  trackerWatch = null;
}
async function trackerCheck(manual) {
  const status = document.querySelector('[data-tracker-status]');
  try {
    const r = await api('me/tracker-check', { method: 'POST', body: {} });
    if (r.linked) {
      state.trackerLinked = true;
      stopTrackerWatch();
      toast('Wardogs stats linked!', 'Your global stats are now on your career profile.', { link: `#/u/${state.me.id}` });
      route();
      return;
    }
    if (status) {
      status.textContent = manual
        ? 'Not found yet — make sure you signed in and pressed Sync on WARDOGS Tracker, then try again.'
        : 'Waiting for WARDOGS Tracker… finish signing in there, then come back here.';
    }
  } catch (x) {
    if (manual && x.status !== 429) fail(x);
  }
}
function startTrackerWatch() {
  stopTrackerWatch();
  const until = Date.now() + 10 * 60 * 1000;
  const onVisible = () => { if (document.visibilityState === 'visible') trackerCheck(false); };
  const timer = setInterval(() => {
    if (Date.now() > until || state.trackerLinked) return stopTrackerWatch();
    trackerCheck(false);
  }, 15000);
  document.addEventListener('visibilitychange', onVisible);
  trackerWatch = { timer, onVisible };
  const status = document.querySelector('[data-tracker-status]');
  if (status) status.textContent = 'Waiting for WARDOGS Tracker… finish signing in there, then come back here.';
}
// One listener for every link card, wherever it appears.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-tracker-link]')) startTrackerWatch();
  else if (e.target.closest('[data-tracker-check]')) trackerCheck(true);
});

// ---------- Unlocks (admin-maintained list) ----------
export function lastNextUnlock(list, role, level) {
  const mine = list.filter((u) => u.role === role).sort((a, b) => a.level - b.level);
  const done = mine.filter((u) => u.level <= level);
  return { last: done[done.length - 1] || null, next: mine.find((u) => u.level > level) || null, total: mine.length, unlocked: done.length };
}
function unlockLinesHtml(list, role, level) {
  const { last, next, total } = lastNextUnlock(list, role, level);
  if (!total) return '';
  return `<div class="ul">
    <div title="${esc(last ? `${last.name} (level ${last.level})` : '')}"><span>Last</span> ${last ? esc(last.name) : '—'}</div>
    <div title="${esc(next ? `${next.name} at level ${next.level}` : '')}"><span>Next</span> ${next ? `${esc(next.name)} <em>L${next.level}</em>` : 'All done ✓'}</div>
  </div>`;
}
function careerUnlockHtml(list, level) {
  const { last, next, total } = lastNextUnlock(list, 'career', level);
  if (!total) return '';
  return `<div class="career-unlock">${icon('unlock')}
    <span><span class="muted">Last career unlock:</span> <b>${last ? `${esc(last.name)}` : '—'}</b></span>
    <span><span class="muted">Next:</span> <b>${next ? `${esc(next.name)}` : 'All done ✓'}</b>${next ? ` <span class="muted">at Wardog level ${next.level} (${next.level - level} to go)</span>` : ''}</span>
    <a href="#/progression" class="small">See all unlocks →</a></div>`;
}

// ---------- Career profile ----------
// [colour, fallback icon, artwork] — artwork is from the WPG career card.
const ROLE_STYLE = {
  recon: ['#ff4545', 'recon', 'recon'],
  assault: ['#3d8bff', 'assault', 'assault'],
  medic: ['#22d38a', 'medic', 'medic'],
  support: ['#f5a524', 'support', 'support'],
  engineer: ['#b04bff', 'engineer', 'engineer'],
  driver: ['#b04bff', 'driver', 'engineer'],
  pilot: ['#29b6f6', 'pilot', 'pilot'],
};
const ROLE_ORDER = ['recon', 'assault', 'medic', 'support', 'engineer', 'driver', 'pilot'];
function tile(ic, label, value, cls = '') {
  return `<div class="tile"><div class="ic">${icon(ic)}</div><div class="grow"><div class="lbl">${esc(label)}</div><div class="val ${cls}">${esc(value)}</div></div></div>`;
}
function statBox(ic, label, value) {
  return `<div class="stat-box"><div class="ic">${icon(ic)}</div><div class="lbl" style="font:700 13px var(--head);color:var(--accent2);text-transform:uppercase">${esc(label)}</div><div class="tile"><div class="val grow">${esc(value)}</div></div></div>`;
}
const ratio = (a, b) => (a === undefined || a === null ? '—' : (Number(a) / Math.max(1, Number(b) || 0)).toFixed(2));

function formatStat(def, v) {
  if (v === undefined || v === null) return '—';
  if (def.format === 'minutes') return fmtMins(v);
  if (def.format === 'money') return fmtMoney(v);
  if (def.format === 'ratio') return Number(v).toFixed(2);
  return fmtNum(v);
}

async function viewProfile(main, [id]) {
  const [p, defs, fields, unlockList] = await Promise.all([api(`users/${Number(id)}`), api('stat-defs'), api('profile-fields'), api('unlocks').catch(() => [])]);
  const u = p.user;
  const mine = u.id === state.me.id;
  const off = p.wardogs.official;
  const srv = p.wardogs.server || {};
  const st = p.stats || {};
  const val = (k) => (st[k] !== undefined ? st[k] : srv[k]);
  const kills = val('kills');
  const deaths = val('deaths');
  const kd = st.kills !== undefined || st.deaths !== undefined ? ratio(kills, deaths) : srv.kd !== undefined ? Number(srv.kd).toFixed(2) : kills !== undefined ? ratio(kills, deaths) : '—';
  const known = new Set(['matches', 'wins', 'losses', 'playtime_minutes', 'kills', 'deaths']);
  const extraDefs = defs.filter((d) => !known.has(d.key));
  const defBy = Object.fromEntries(defs.map((d) => [d.key, d]));

  const customFields = fields.filter((f) => u.custom_fields?.[f.key]).map((f) => `<span class="pill">${esc(f.label)}: ${esc(u.custom_fields[f.key])}</span>`).join(' ');

  const friendBtn = mine ? '' : {
    none: `<button class="btn" data-friend="add">${icon('friends')} Add friend</button>`,
    outgoing: `<button class="btn ghost" data-friend="remove">Request sent · Cancel</button>`,
    incoming: `<button class="btn primary" data-friend="add">${icon('friends')} Accept friend</button>`,
    friends: `<button class="btn ghost" data-friend="remove">Friends ✓ · Remove</button>`,
  }[p.friend];

  // Worldwide ranks (out of every ranked Wardogs player).
  const wr = p.wardogs.ranks;
  const of = (n) => (n ? `#${fmtNum(n)}${wr?.total ? ` of ${fmtNum(wr.total)}` : ''}` : '—');
  const worldRanksHtml = wr?.level ? `<div class="tiles" style="margin-bottom:12px">
      ${tile('trophy', 'World rank', of(wr.level))}
      ${tile('growth', 'Worth rank', of(wr.worth))}
      ${tile('coins', 'Cash rank', of(wr.cash))}
    </div>` : '';
  const rankHint = !wr?.level && mine && state.realSteam
    ? '<p class="muted small" style="margin:0 0 10px">No world rank found yet. If your in-game name is different from your Steam name, add it in <a href="#/profile/edit">Edit profile</a> as Name#1234, then press Sync stats.</p>'
    : '';

  let officialHtml;
  if (off) {
    const rank = (n) => { const i = ROLE_ORDER.indexOf(n.toLowerCase()); return i < 0 ? 99 : i; };
    const roles = Object.entries(off.roles || {}).sort(([a], [b]) => rank(a) - rank(b));
    officialHtml = `${worldRanksHtml}${rankHint}
      <div class="tiles">
        ${tile('chevrons', 'Wardog level', fmtNum(off.wardogLevel))}
        ${tile('xp', 'Total XP', fmtNum(off.careerXp))}
        ${tile('coins', 'Cash on hand', fmtMoney(off.cash))}
        ${off.accountWorth !== undefined ? tile('growth', 'Account worth', fmtMoney(off.accountWorth)) : ''}
        ${tile('gold', 'Gold', fmtNum(off.gold))}
        ${tile('unlock', 'Unlocks', fmtNum(off.unlocks))}
      </div>
      ${roles.length ? `<h4 style="margin:18px 0 10px" class="row">${icon('chevrons', 'width="18" height="18" style="color:var(--gold)"')} Official role progression</h4>
      <div class="roles">${roles.map(([name, r]) => {
        const [c, ic, art] = ROLE_STYLE[name.toLowerCase()] || ['#29b6f6', 'star', ''];
        const pic = art ? `<img class="art" src="/img/brand/roles/${art}.webp" alt="" loading="lazy">` : `<div style="padding-top:10px">${icon(ic)}</div>`;
        const lvl = Number(r?.level ?? r) || 0;
        return `<div class="role-card" style="--rc:${c}">${pic}<div class="rn">${esc(name)}</div><div class="rl">${fmtNum(lvl)}</div>${unlockLinesHtml(unlockList, name.toLowerCase(), lvl)}</div>`;
      }).join('')}</div>` : ''}
      ${careerUnlockHtml(unlockList, Number(off.wardogLevel) || 0)}
      <div class="credit">Global stats by <a href="https://wardogstracker.gg" target="_blank" rel="noopener">WARDOGS Tracker</a>${p.wardogs.official_synced ? ` · updated ${timeAgo(p.wardogs.official_synced)}` : ''}</div>`;
  } else {
    officialHtml = worldRanksHtml + (mine && state.realSteam
      ? `<p class="muted" style="margin-top:0">No global Wardogs stats yet.</p>${trackerCardHtml()}`
      : '<p class="muted">No global Wardogs stats yet. They show once this player links WARDOGS Tracker.</p>');
  }

  const games = p.games.map((g) => {
    const labels = Object.fromEntries(String(g.stat_labels || '').split('\n').map((l) => l.split('=')).filter((x) => x.length >= 2).map(([k, ...v]) => [k.trim(), v.join('=').trim()]));
    const shown = Object.entries(labels).filter(([k]) => g.stats?.[k] !== undefined);
    return `<div style="padding:10px 0;border-bottom:1px solid #13263d">
      <div class="row between"><b style="font:700 17px var(--head);text-transform:uppercase">${esc(g.name)}</b><span class="muted small">updated ${timeAgo(g.updated_at)}</span></div>
      <div class="tiles" style="margin-top:8px">
        ${tile('clock', 'Total hours', fmtMins(g.playtime_forever))}
        ${tile('calendar', 'Last 2 weeks', fmtMins(g.playtime_2weeks))}
        ${g.ach_total ? tile('medal', 'Achievements', `${g.ach_unlocked} / ${g.ach_total}`) : ''}
        ${shown.map(([k, label]) => tile('chart', label, fmtNum(g.stats[k]))).join('')}
      </div></div>`;
  }).join('');

  main.innerHTML = `
    <div class="stack">
      <img class="banner-img" src="/img/brand/header-career.webp" alt="Wardogs player career profile">
      <div class="panel glow">
        <div class="banner" style="background:linear-gradient(90deg, ${esc(u.banner_color)}, transparent)"></div>
        <div class="profile-head">
          <img class="avatar lg" src="${esc(u.avatar || '/img/icon-192.png')}" alt="" referrerpolicy="no-referrer">
          <div class="who">
            <div class="pname">${esc(u.name)} ${flag(u.country)}</div>
            ${u.callsign ? `<div class="accent">“${esc(u.callsign)}”</div>` : ''}
            <div class="row" style="margin-top:6px">${rolePill(u)} <span class="muted small">${state.online.has(u.id) ? '<span style="color:var(--green)">● Online</span>' : `Last seen ${timeAgo(u.last_seen)}`} · Joined ${fmtDate(u.joined_at)}</span></div>
            ${customFields ? `<div class="row" style="margin-top:8px">${customFields}</div>` : ''}
          </div>
          <div style="text-align:center">${badgeFor(u, 88)}<div style="font:700 15px var(--head);text-transform:uppercase">${esc(isPmc(u) ? 'PMC' : u.rank ? u.rank.name : 'Unranked')}</div></div>
        </div>
        ${u.bio ? `<p style="white-space:pre-wrap;margin:14px 0 0">${esc(u.bio)}</p>` : ''}
        <div class="row" style="margin-top:14px">
          ${mine ? `<a class="btn" href="#/profile/edit">${icon('edit')} Edit profile</a><button class="btn" id="syncBtn">${icon('refresh')} Sync stats</button>` : `<a class="btn primary" href="#/messages/${u.id}">${icon('mail')} Message</a>${friendBtn}`}
          ${u.profile_url ? `<a class="btn ghost" href="${esc(u.profile_url)}" target="_blank" rel="noopener">${icon('steam')} Steam</a>` : ''}
          ${isStaff() ? `<a class="btn ghost" href="#/admin/users?edit=${u.id}">${icon('shield')} Admin edit</a>` : ''}
        </div>
      </div>

      <div class="panel player-info">
        <img class="emblem" src="/img/brand/wolf-emblem.webp" alt="WPG Wardogs private server">
        <div>
          <div class="panel-title">${icon('user')} Player <span class="sub">information</span></div>
          <div class="tiles">
            ${tile('user', 'Player name', u.name)}
            ${tile('steam', 'Steam ID', /^\d{17}$/.test(u.steam_id) ? u.steam_id : 'Test account', 'fit')}
            ${u.custom_fields?.discord ? tile('discord', 'Discord', u.custom_fields.discord) : ''}
            ${u.membership === 'pmc'
            ? tile('swords', `${state.settings.clan_tag || 'WPG'} member`, 'PMC', 'pmc')
            : tile('users', `${state.settings.clan_tag || 'WPG'} member`, u.status === 'active' ? 'YES' : 'NO', u.status === 'active' ? 'good' : '')}
          </div>
        </div>
      </div>

      <div class="grid two">
        <div class="panel">
          <div class="panel-title">${icon('target')} Official Wardogs <span class="sub">(global server)</span></div>
          ${officialHtml}
        </div>
        <div class="panel">
          <div class="panel-title">${icon('chevrons')} ${esc(state.settings.clan_tag || 'WPG')} Server <span class="sub">(private server)</span></div>
          <div class="tiles">
            ${tile('trophy', 'Server rank', `#${fmtNum(p.wpg_position)}`)}
            ${tile('chevrons', `${state.settings.clan_tag || 'WPG'} rank`, isPmc(u) ? 'PMC — no rank' : u.rank ? u.rank.name : '—', isPmc(u) ? 'pmc' : '')}
            ${tile('star', `${state.settings.clan_tag || 'WPG'} XP`, fmtNum(u.xp))}
          </div>
          <h4 style="margin:18px 0 10px" class="row">${icon('skull', 'width="18" height="18"')} ${esc(state.settings.clan_tag || 'WPG')} server stats <span class="accent">(all time)</span></h4>
          <div class="tiles" style="grid-template-columns:repeat(auto-fill,minmax(100px,1fr))">
            ${statBox('crosshair', 'Kills', fmtNum(kills))}
            ${statBox('skull', 'Deaths', fmtNum(deaths))}
            ${statBox('chart', 'K/D ratio', kd)}
            ${statBox('calendar', 'Matches', formatStat(defBy.matches || {}, st.matches))}
            ${statBox('win', 'Wins', formatStat(defBy.wins || {}, st.wins))}
            ${statBox('skull', 'Losses', formatStat(defBy.losses || {}, st.losses))}
            ${statBox('chart', 'W/L ratio', st.wins !== undefined ? ratio(st.wins, st.losses) : '—')}
            ${statBox('clock', 'Playtime', fmtMins(st.playtime_minutes))}
            ${srv.headshots !== undefined ? statBox('target', 'Headshots', fmtNum(srv.headshots)) : ''}
            ${srv.topWeapon ? statBox('assault', 'Top weapon', srv.topWeapon) : ''}
            ${extraDefs.map((d) => statBox('star', d.label, formatStat(d, st[d.key]))).join('')}
          </div>
          ${p.wardogs.server_synced ? `<div class="credit">Kills by <a href="https://wardogstracker.gg" target="_blank" rel="noopener">WARDOGS Tracker</a> · updated ${timeAgo(p.wardogs.server_synced)}</div>` : ''}
        </div>
      </div>

      <div class="grid two">
        <div class="panel">
          <div class="panel-title">${icon('steam')} Steam <span class="sub">playtime</span></div>
          ${games || `<p class="muted">${u.steam_private ? 'Steam game details are private. Set “Game details” to Public in Steam privacy settings.' : 'No tracked games synced yet.'}</p>`}
        </div>
        <div class="panel">
          <div class="panel-title">${icon('medal')} Medals & ribbons</div>
          ${p.awards.length ? `<div class="ribbon-rack">${p.awards.map((a) => `
            <div class="rack-item" title="${esc(`${a.name} — ${a.description}${a.reason && a.reason !== 'Earned automatically' ? ` (${a.reason})` : ''} · ${fmtDate(a.given_at)}`)}">
              ${ribbon(a.colors)}<b>${esc(a.name)}</b><span class="muted small">${fmtDate(a.given_at)}</span></div>`).join('')}</div>` : `<p class="muted">${p.medals?.length ? 'No WPG medals yet.' : 'No medals yet.'}</p>`}
          ${steamMedalsHtml(p.medals || [])}
        </div>
      </div>
    </div>`;

  document.getElementById('syncBtn')?.addEventListener('click', syncMine);
  main.querySelectorAll('[data-friend]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`friends/${u.id}`, { method: b.dataset.friend === 'add' ? 'POST' : 'DELETE', body: b.dataset.friend === 'add' ? {} : undefined });
        route();
      } catch (x) { fail(x); }
    };
  });
  onLive('me', () => { if (mine) route(); });
}

// Steam achievements shown as medals: earned in colour, the rest greyed out. Rare ones (<10% of players) get gold.
function steamMedalsHtml(medals) {
  if (!medals.length) return '';
  const byGame = new Map();
  for (const m of medals) {
    if (!byGame.has(m.game)) byGame.set(m.game, []);
    byGame.get(m.game).push(m);
  }
  return [...byGame].map(([game, list]) => {
    const earned = list.filter((m) => m.earned).length;
    return `<h4 class="row" style="margin:16px 0 8px">${icon('medal', 'width="18" height="18" style="color:var(--gold)"')} ${esc(game)} achievement medals
        <span class="muted small">${earned} / ${list.length}</span></h4>
      <div class="xpbar" style="margin-bottom:10px"><div style="width:${((earned / list.length) * 100).toFixed(1)}%"></div></div>
      <div class="steam-medals">${list.map((m) => {
        const rare = m.percent !== null && m.percent < 10;
        const tip = `${m.name} — ${m.description}${m.percent !== null ? ` (${m.percent}% of players)` : ''}${m.earned && m.unlocked_at ? ` · earned ${fmtDate(m.unlocked_at)}` : m.earned ? '' : ' · not earned yet'}`;
        return `<div class="steam-medal${m.earned ? ' earned' : ''}${rare ? ' rare' : ''}" title="${esc(tip)}">
          <img src="${esc(m.earned ? m.icon : (m.icon_gray || m.icon))}" alt="" loading="lazy" referrerpolicy="no-referrer">
          <div class="nm">${esc(m.name)}</div>
          <div class="sub">${m.earned ? (m.unlocked_at ? fmtDate(m.unlocked_at) : 'Earned') : 'Locked'}${m.percent !== null ? ` · ${m.percent}%` : ''}</div>
        </div>`;
      }).join('')}</div>`;
  }).join('');
}

export function ribbon(colors) {
  const list = String(colors || '#888888').split(',').map((c) => (/^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : '#888888'));
  const step = 100 / list.length;
  const stops = list.map((c, i) => `${c} ${(i * step).toFixed(1)}% ${((i + 1) * step).toFixed(1)}%`).join(', ');
  return `<span class="ribbon" style="background:linear-gradient(90deg, ${stops})"></span>`;
}

// ---------- Edit profile ----------
async function viewEditProfile(main) {
  const fields = await api('profile-fields');
  const u = state.me;
  main.innerHTML = `
    <h1>Edit profile</h1>
    <form class="panel stack" id="pf">
      <p class="muted">Your name and picture come from Steam (<b>${esc(u.name)}</b>). They update each time you sign in.</p>
      <div class="form-grid">
        <label class="field"><span>Callsign / nickname</span><input type="text" name="callsign" maxlength="40" value="${esc(u.callsign)}"></label>
        <label class="field"><span>Country</span><select name="country">${COUNTRIES.map(([c, n]) => `<option value="${c}" ${u.country === c ? 'selected' : ''}>${flag(c)} ${n}</option>`).join('')}</select></label>
        ${fields.map((f) => `<label class="field"><span>${esc(f.label)}</span>${f.type === 'select'
          ? `<select name="cf_${esc(f.key)}"><option value="">—</option>${f.options.split(',').map((o) => o.trim()).filter(Boolean).map((o) => `<option ${u.custom_fields?.[f.key] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
          : `<input type="text" name="cf_${esc(f.key)}" maxlength="200" value="${esc(u.custom_fields?.[f.key] || '')}">`}</label>`).join('')}
      </div>
      <label class="field"><span>About me</span><textarea name="bio" maxlength="1000">${esc(u.bio)}</textarea></label>
      <div class="form-grid">
        <label class="field"><span>Custom picture link (optional, https)</span><input type="url" name="custom_avatar" value="${esc(u.avatar && !u.avatar.includes('steamstatic') ? u.avatar : '')}" placeholder="Leave empty to use your Steam picture"></label>
        <label class="field"><span>Banner colour</span><input type="color" name="banner_color" value="${esc(u.banner_color || '#0d2238')}"></label>
      </div>
      <div class="row"><button class="btn primary">Save profile</button><a class="btn ghost" href="#/u/${u.id}">Cancel</a></div>
    </form>`;
  document.getElementById('pf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const custom = {};
    for (const fd of fields) custom[fd.key] = f[`cf_${fd.key}`]?.value || '';
    try {
      await api('me/profile', { method: 'PUT', body: { callsign: f.callsign.value, country: f.country.value, bio: f.bio.value, custom_avatar: f.custom_avatar.value, banner_color: f.banner_color.value, custom_fields: custom } });
      toast('Saved', 'Profile updated.');
      await refreshMe();
      location.hash = `#/u/${u.id}`;
    } catch (x) { fail(x); }
  };
}

// ---------- Chat ----------
// ---------- Discord voice (from Discord's server widget) ----------
function joinDiscordBtn(url, cls = 'btn discord-join') {
  return url ? `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener">${icon('discord')} Join the Discord</a>` : '';
}

function voiceHtml(v, compact) {
  const invite = v.invite || state.settings.discord_invite || '';
  if (!v.enabled) {
    if (v.reason === 'off') return compact ? '' : joinDiscordBtn(invite);
    const staffHelp = {
      no_server: 'Add your Discord invite link in Admin → Settings to show who is in voice.',
      widget_disabled: 'In Discord: Server Settings → Widget → turn on “Enable Server Widget”. Then voice channels show here.',
    }[v.reason] || `Discord voice unavailable: ${v.reason}`;
    if (compact) return isStaff() ? `<p class="muted small">${esc(staffHelp)}</p>` : '';
    return `${isStaff() ? `<p class="muted small">${esc(staffHelp)}</p>` : ''}${joinDiscordBtn(invite)}`;
  }
  const busy = v.channels.filter((c) => c.members.length);
  const person = (m) => `<div class="vc-user"><img src="${esc(m.avatar || '/img/icon-192.png')}" alt="" loading="lazy" referrerpolicy="no-referrer">
    <span class="grow">${esc(m.name)}${m.game && !compact ? `<span class="muted small"> · ${esc(m.game)}</span>` : ''}</span>
    ${m.deafened ? `<span class="vc-flag" title="Deafened">${icon('deaf')}</span>` : m.muted ? `<span class="vc-flag" title="Muted">${icon('micoff')}</span>` : ''}</div>`;
  const chan = (c) => `<div class="vc-chan${c.members.length ? ' live' : ''}"><div class="vc-name">${icon(c.hidden ? 'lock' : 'headset')} ${esc(c.name)}${c.members.length ? ` <span class="pill mod">${c.members.length}</span>` : ''}</div>${c.members.map(person).join('')}</div>`;
  if (compact) {
    return `<h3 style="margin-top:14px">Voice <span class="muted small">${v.inVoice} in voice</span></h3>
      ${busy.length ? busy.map(chan).join('') : '<p class="muted small">Nobody in voice right now.</p>'}
      ${joinDiscordBtn(invite, 'btn small discord-join')}`;
  }
  return `<div class="row between" style="margin-bottom:10px"><span class="muted">${fmtNum(v.online)} online on Discord · <b style="color:var(--text)">${v.inVoice}</b> in voice</span>${joinDiscordBtn(invite)}</div>
    <div class="vc-grid">${v.channels.map(chan).join('') || '<p class="muted">Nobody is in voice right now.</p>'}</div>
    ${v.hiddenChannels && isStaff() ? '<p class="muted small" style="margin:10px 0 0">Tip for staff: Discord hides the names of voice channels that @everyone cannot see. To show the real names here, let @everyone <b>View Channel</b> on those voice channels in Discord (you can still block <b>Connect</b> so only members can join).</p>' : ''}`;
}

// Loads and refreshes the voice list every 30 seconds while the element is on screen.
function startVoice(el, { compact = false, alive }) {
  if (!el) return;
  const load = async () => {
    try {
      const v = await api('discord/voice');
      if (alive()) el.innerHTML = voiceHtml(v, compact);
    } catch { /* keep the last view */ }
  };
  load();
  const t = setInterval(() => (alive() ? load() : clearInterval(t)), 30000);
}

// ---------- @mentions ----------
// Stored in messages as <@u:ID> (user), <@r:ID> (rank), <@g:NAME> (group).
const MENTION_GROUPS = [
  { id: 'everyone', label: 'everyone', desc: 'Everyone who can see this channel', staff: true },
  { id: 'admin', label: 'Admins', desc: 'All admins' },
  { id: 'mod', label: 'Mods', desc: 'All mods' },
  { id: 'member', label: 'Members', desc: 'All WPG members' },
  { id: 'pmc', label: 'PMC', desc: 'All PMC guests' },
];
const MENTION_TOKEN = /&lt;@(u|r|g):([a-z0-9]{1,20})&gt;/g;

function mentionsMe(body) {
  const me = state.me;
  const tokens = [...String(body).matchAll(/<@(u|r|g):([a-z0-9]{1,20})>/g)];
  return tokens.some(([, kind, id]) => (kind === 'u' && Number(id) === me.id)
    || (kind === 'r' && !isPmc(me) && Number(id) === me.rank_id)
    || (kind === 'g' && (id === 'everyone' || (id === 'admin' && me.role === 'admin') || (id === 'mod' && me.role === 'mod')
      || (id === 'member' && !isPmc(me)) || (id === 'pmc' && isPmc(me)))));
}

function renderBody(body, rankById) {
  return esc(body).replace(MENTION_TOKEN, (_, kind, id) => {
    if (kind === 'u') {
      const u = state.users.get(Number(id));
      return `<a class="mention${Number(id) === state.me.id ? ' me' : ''}" href="#/u/${Number(id)}">@${esc(u?.name || 'unknown')}</a>`;
    }
    if (kind === 'r') {
      const r = rankById.get(Number(id));
      return `<span class="mention" style="--mc:${esc(r?.color || '#29b6f6')}">@${esc(r?.name || 'rank')}</span>`;
    }
    const g = MENTION_GROUPS.find((x) => x.id === id);
    return `<span class="mention group">@${esc(g?.label || id)}</span>`;
  });
}

async function viewChat(main, [idParam], alive) {
  const [channels, ranks, members] = await Promise.all([api('channels'), api('ranks'), api('members').catch(() => [])]);
  const rankById = new Map(ranks.map((r) => [r.id, r]));
  members.forEach((u) => { if (!state.users.has(u.id)) state.users.set(u.id, u); });
  if (!channels.length) { main.innerHTML = '<div class="panel empty">No channels yet.</div>'; return; }
  const ch = channels.find((c) => c.id === Number(idParam)) || channels[0];
  main.innerHTML = `
    <div class="chat">
      <div class="panel channels"><h3>Channels</h3>${channels.map((c) => `<a href="#/chat/${c.id}" class="${c.id === ch.id ? 'active' : ''}"># ${esc(c.name)}</a>`).join('')}
        <div class="voice-mini" data-voice-mini></div></div>
      <div class="panel chat-main">
        <div class="chat-head"><b style="font:700 18px var(--head);text-transform:uppercase"># ${esc(ch.name)}</b> <span class="muted small">${esc(ch.description)}</span></div>
        <div class="msgs" id="msgs"><div class="spinner"></div></div>
        <div class="typing" id="typing"></div>
        ${ch.read_only && !isStaff() ? '<div class="composer muted small">Only staff can post in this channel.</div>' : `
        <div class="mention-pop hidden" id="mentionPop" role="listbox" aria-label="Mention someone"></div>
        <form class="composer" id="composer"><textarea name="body" placeholder="Message #${esc(ch.name)} — type @ to mention" maxlength="2000" rows="1"></textarea><button class="btn primary" aria-label="Send">${icon('send')}</button></form>`}
      </div>
    </div>`;
  const box = document.getElementById('msgs');
  let oldest = null;
  startVoice(main.querySelector('[data-voice-mini]'), { compact: true, alive });

  const msgHtml = (m) => {
    if (!m.user_id) return `<div class="msg system" data-id="${m.id}">⭐ ${esc(m.body)}</div>`;
    const u = state.users.get(m.user_id) || { name: 'Unknown', id: m.user_id };
    const canDel = m.user_id === state.me.id || isStaff();
    return `<div class="msg${mentionsMe(m.body) && m.user_id !== state.me.id ? ' mention-me' : ''}" data-id="${m.id}"><a href="#/u/${u.id}">${avatar(u)}</a><div class="grow">
      <div><a class="who" href="#/u/${u.id}" style="color:${isPmc(u) ? '#ffb347' : esc(u.rank?.color || 'var(--text)')}">${isPmc(u) ? '[PMC] ' : u.rank ? `[${esc(u.rank.abbr)}] ` : ''}${esc(u.name)}</a>${u.developer ? ' <span class="pill dev">Developer</span>' : ''}<span class="time">${fmtTime(m.created_at)}</span></div>
      <div class="body">${renderBody(m.body, rankById)}</div></div>
      ${canDel ? `<button class="btn ghost small del" data-del="${m.id}" title="Delete" aria-label="Delete">${icon('trash')}</button>` : ''}</div>`;
  };

  async function load(before) {
    const r = await api(`channels/${ch.id}/messages${before ? `?before=${before}` : ''}`);
    r.users.forEach((u) => state.users.set(u.id, u));
    return r.messages;
  }
  const first = await load();
  if (!alive()) return;
  oldest = first[0]?.id;
  box.innerHTML = (first.length === 60 ? '<button class="btn ghost small" id="older" style="align-self:center">Load older</button>' : '') + (first.length ? first.map(msgHtml).join('') : '<p class="empty">No messages yet. Say hello!</p>');
  box.scrollTop = box.scrollHeight;

  box.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      if (await confirmBox('Delete this message?')) api(`messages/${del.dataset.del}`, { method: 'DELETE' }).catch(fail);
    }
    if (e.target.id === 'older') {
      const older = await load(oldest);
      e.target.remove();
      if (!older.length) return;
      oldest = older[0].id;
      const h = box.scrollHeight;
      box.insertAdjacentHTML('afterbegin', (older.length === 60 ? '<button class="btn ghost small" id="older" style="align-self:center">Load older</button>' : '') + older.map(msgHtml).join(''));
      box.scrollTop = box.scrollHeight - h;
    }
  });

  onLive('chat:new', ({ message }) => {
    if (message.channel_id !== ch.id) return;
    box.querySelector('.empty')?.remove();
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
    box.insertAdjacentHTML('beforeend', msgHtml(message));
    if (nearBottom || message.user_id === state.me.id) box.scrollTop = box.scrollHeight;
  });
  onLive('chat:deleted', ({ id }) => box.querySelector(`[data-id="${id}"]`)?.remove());
  const typingEl = document.getElementById('typing');
  const typers = new Map();
  onLive('typing', ({ channelId, userId, name }) => {
    if (channelId !== ch.id) return;
    clearTimeout(typers.get(userId)?.t);
    typers.set(userId, { name, t: setTimeout(() => { typers.delete(userId); showTyping(); }, 3000) });
    showTyping();
  });
  function showTyping() {
    const names = [...typers.values()].map((t) => t.name);
    typingEl.textContent = names.length ? `${names.slice(0, 3).join(', ')} ${names.length > 1 ? 'are' : 'is'} typing…` : '';
  }

  const form = document.getElementById('composer');
  if (form) {
    const ta = form.body;
    let lastTyping = 0;
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(140, ta.scrollHeight)}px`;
      if (Date.now() - lastTyping > 2000) { lastTyping = Date.now(); state.socket?.emit('typing', ch.id); }
    });
    // ----- @mention pick-list -----
    const pop = document.getElementById('mentionPop');
    const picked = new Map(); // "@Display" -> token
    let options = [];
    let sel = 0;
    let query = null; // { start, text } of the "@word" being typed
    const canEveryone = isStaff();

    function findQuery() {
      const before = ta.value.slice(0, ta.selectionStart);
      const m = /(^|\s)@([^\s@]{0,30})$/.exec(before);
      return m ? { start: before.length - m[2].length - 1, text: m[2].toLowerCase() } : null;
    }
    function buildOptions(text) {
      const has = (s) => String(s || '').toLowerCase().includes(text);
      const groups = MENTION_GROUPS.filter((g) => (!g.staff || canEveryone) && (has(g.label) || has(g.id)))
        .map((g) => ({ token: `<@g:${g.id}>`, display: `@${g.label}`, label: `@${g.label}`, sub: g.desc, kind: 'Group' }));
      const rks = ranks.filter((r) => has(r.name) || has(r.abbr))
        .map((r) => ({ token: `<@r:${r.id}>`, display: `@${r.name}`, label: `@${r.name}`, sub: `Everyone ranked ${r.abbr}`, kind: 'Rank', rank: r }));
      const people = [...state.users.values()].filter((u) => u.status === 'active' && (has(u.name) || has(u.callsign)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((u) => ({ token: `<@u:${u.id}>`, display: `@${u.name}`, label: u.name, sub: rankName(u), kind: 'Person', user: u }));
      return [...people.slice(0, 8), ...rks.slice(0, 5), ...groups].slice(0, 14);
    }
    function closePop() { pop.classList.add('hidden'); query = null; options = []; }
    function drawPop() {
      if (!options.length) return closePop();
      pop.innerHTML = options.map((o, i) => `<button type="button" class="mention-opt${i === sel ? ' sel' : ''}" data-i="${i}" role="option">
        ${o.user ? avatar(o.user, 'sm') : o.rank ? rankBadge(o.rank, 28) : `<span class="mention group" style="margin:0">@</span>`}
        <span class="grow"><b>${esc(o.label)}</b><span class="muted small"> · ${esc(o.sub)}</span></span><span class="pill">${o.kind}</span></button>`).join('');
      pop.classList.remove('hidden');
      pop.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    }
    function refreshPop() {
      query = findQuery();
      if (!query) return closePop();
      options = buildOptions(query.text);
      sel = 0;
      drawPop();
    }
    function choose(i) {
      const o = options[i];
      if (!o || !query) return;
      const end = ta.selectionStart;
      ta.value = `${ta.value.slice(0, query.start)}${o.display} ${ta.value.slice(end)}`;
      const caret = query.start + o.display.length + 1;
      ta.setSelectionRange(caret, caret);
      picked.set(o.display, o.token);
      closePop();
      ta.focus();
    }
    ta.addEventListener('input', refreshPop);
    ta.addEventListener('click', refreshPop);
    ta.addEventListener('blur', () => setTimeout(closePop, 150));
    pop.addEventListener('mousedown', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) { e.preventDefault(); choose(Number(b.dataset.i)); }
    });

    ta.addEventListener('keydown', (e) => {
      if (!pop.classList.contains('hidden') && options.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % options.length; return drawPop(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + options.length) % options.length; return drawPop(); }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return choose(sel); }
        if (e.key === 'Escape') { e.preventDefault(); return closePop(); }
      }
      if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); form.requestSubmit(); }
    });

    // Swap the "@Name" text the user sees for mention tokens before sending.
    const withTokens = (text) => [...picked.entries()]
      .sort((a, b) => b[0].length - a[0].length)
      .reduce((out, [display, token]) => out.split(display).join(token), text);

    form.onsubmit = async (e) => {
      e.preventDefault();
      const typed = ta.value.trim();
      if (!typed) return;
      const body = withTokens(typed);
      ta.value = '';
      ta.style.height = '';
      closePop();
      try {
        await api(`channels/${ch.id}/messages`, { method: 'POST', body: { body } });
        picked.clear();
      } catch (x) { ta.value = typed; fail(x); }
    };
  }
}

// ---------- Private messages ----------
async function viewMessages(main, [otherId], alive) {
  if (otherId) return viewConversation(main, Number(otherId), alive);
  const convos = await api('dms');
  main.innerHTML = `
    <div class="row between"><h1>Messages</h1><a class="btn" href="#/members">${icon('plus')} New message</a></div>
    <div class="panel list">${convos.length ? convos.map((c) => `
      <a class="item" href="#/messages/${c.user.id}">
        <div class="grow">${userLine(c.user, `${c.last.mine ? 'You: ' : ''}${esc(c.last.body.slice(0, 60))}`)}</div>
        <span class="muted small">${timeAgo(c.last.created_at)}</span>
        ${c.unread ? `<span class="badge-count">${c.unread}</span>` : ''}
      </a>`).join('') : '<p class="empty">No messages yet. Open a member\'s profile to message them.</p>'}</div>`;
  onLive('dm:new', () => route());
}

async function viewConversation(main, otherId, alive) {
  const r = await api(`dms/${otherId}`);
  if (!alive()) return;
  refreshMe();
  const u = r.user;
  main.innerHTML = `
    <div class="chat" style="grid-template-columns:1fr">
      <div class="panel chat-main">
        <div class="chat-head row"><a class="btn ghost small" href="#/messages" aria-label="Back">${icon('back')}</a><a href="#/u/${u.id}" class="grow">${userLine(u)}</a></div>
        <div class="msgs" id="msgs"></div>
        <form class="composer" id="composer"><textarea name="body" placeholder="Message ${esc(u.name)}" maxlength="2000" rows="1"></textarea><button class="btn primary" aria-label="Send">${icon('send')}</button></form>
      </div>
    </div>`;
  const box = document.getElementById('msgs');
  const bubble = (m) => `<div class="dm-bubble ${m.sender_id === state.me.id ? 'mine' : ''}">${esc(m.body)}<span class="time">${fmtTime(m.created_at)} · ${fmtDate(m.created_at)}</span></div>`;
  box.innerHTML = r.messages.length ? r.messages.map(bubble).join('') : '<p class="empty">Start the conversation.</p>';
  box.scrollTop = box.scrollHeight;
  onLive('dm:new', ({ dm }) => {
    const involved = [dm.sender_id, dm.recipient_id];
    if (!involved.includes(u.id)) return;
    box.querySelector('.empty')?.remove();
    box.insertAdjacentHTML('beforeend', bubble(dm));
    box.scrollTop = box.scrollHeight;
    if (dm.sender_id === u.id) api(`dms/${u.id}?before=0`).catch(() => {});
  });
  const form = document.getElementById('composer');
  const ta = form.body;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); form.requestSubmit(); }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body) return;
    ta.value = '';
    try { await api(`dms/${u.id}`, { method: 'POST', body: { body } }); } catch (x) { ta.value = body; fail(x); }
  };
}

// ---------- Friends ----------
async function viewFriends(main) {
  const f = await api('friends');
  const section = (title, list, actions, emptyText) => `
    <div class="panel"><div class="panel-title">${title} <span class="sub">${list.length}</span></div>
      <div class="list">${list.length ? list.map((u) => `<div class="item"><a href="#/u/${u.id}" class="grow" style="color:inherit">${userLine(u)}</a><div class="row">${actions(u)}</div></div>`).join('') : `<p class="muted">${emptyText}</p>`}</div></div>`;
  main.innerHTML = `
    <div class="row between"><h1>Friends</h1><a class="btn" href="#/members">${icon('plus')} Find members</a></div>
    <div class="stack">
      ${f.incoming.length ? section(`${icon('bell')} Requests`, f.incoming, (u) => `<button class="btn primary small" data-add="${u.id}">Accept</button><button class="btn ghost small" data-remove="${u.id}">Decline</button>`, '') : ''}
      ${section(`${icon('friends')} Squad`, f.friends, (u) => `<a class="btn small" href="#/messages/${u.id}">${icon('mail')}</a><button class="btn ghost small" data-remove="${u.id}">Remove</button>`, 'No friends yet. Find members and send a request.')}
      ${f.outgoing.length ? section('Sent requests', f.outgoing, (u) => `<button class="btn ghost small" data-remove="${u.id}">Cancel</button>`, '') : ''}
    </div>`;
  main.onclick = async (e) => {
    const add = e.target.closest('[data-add]');
    const rem = e.target.closest('[data-remove]');
    try {
      if (add) await api(`friends/${add.dataset.add}`, { method: 'POST', body: {} });
      else if (rem) await api(`friends/${rem.dataset.remove}`, { method: 'DELETE' });
      else return;
      route();
    } catch (x) { fail(x); }
  };
  onLive('friends', () => route());
}

// ---------- Members ----------
async function viewMembers(main, _r, alive) {
  main.innerHTML = `<h1>Members</h1>
    <input type="search" id="search" placeholder="Search by name or callsign" style="margin-bottom:14px">
    <div class="panel list" id="mlist"><div class="spinner"></div></div>`;
  const input = document.getElementById('search');
  let t;
  async function load() {
    const list = await api(`members?search=${encodeURIComponent(input.value)}`);
    if (!alive()) return;
    document.getElementById('mlist').innerHTML = list.length ? list.map((u) => `
      <a class="item" href="#/u/${u.id}"><div class="grow">${userLine(u, `${fmtNum(u.xp)} XP`)}</div>${flag(u.country)}</a>`).join('') : '<p class="empty">No members found.</p>';
  }
  input.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  await load();
}

// ---------- Game servers ----------
export function promptBox(title, placeholder = '', { danger = false, okLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    const m = modal(`<form class="stack"><h3 style="margin:0">${esc(title)}</h3>
      <input type="text" name="v" maxlength="300" placeholder="${esc(placeholder)}">
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-no>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}">${esc(okLabel)}</button></div></form>`);
    const f = m.el.querySelector('form');
    f.v.focus();
    m.el.querySelector('[data-no]').onclick = () => { m.close(); resolve(null); };
    f.onsubmit = (e) => { e.preventDefault(); m.close(); resolve(f.v.value.trim()); };
  });
}

// Pick a map and game mode from the server's own list (like the official Wardogs RCON console).
async function changeMapBox(sid, act) {
  const m = modal(`<div class="row between"><h2 style="margin:0">Change map</h2><button type="button" class="btn ghost small" data-close>✕</button></div>
    <div id="mapBody"><div class="spinner" style="margin:20px auto"></div></div>`);
  m.el.querySelector('[data-close]').onclick = m.close;
  const body = m.el.querySelector('#mapBody');
  let maps;
  try {
    maps = await api(`admin/servers/${sid}/maps`);
  } catch (x) {
    body.innerHTML = `<p style="color:var(--red)">${esc(x.message)}</p>`;
    return;
  }
  if (!maps.length) { body.innerHTML = '<p class="muted">The server did not send a map list.</p>'; return; }
  body.innerHTML = `<form class="stack" id="mapForm">
      <label class="field"><span>Map</span><select name="map">${maps.map((mp) => `<option value="${esc(mp.id)}">${esc(mp.name)}</option>`).join('')}</select></label>
      <div class="field"><span style="display:block;font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;margin-bottom:6px">Game mode</span><div id="modeList" class="stack"></div></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Change map</button></div>
    </form>`;
  const form = body.querySelector('#mapForm');
  form.querySelector('[data-close]').onclick = m.close;
  const modeList = form.querySelector('#modeList');
  const loadModes = async () => {
    modeList.innerHTML = '<div class="spinner" style="margin:6px 0"></div>';
    try {
      const modes = await api(`admin/servers/${sid}/maps/${encodeURIComponent(form.map.value)}/modes`);
      modeList.innerHTML = modes.length
        ? modes.map((md, i) => `<label class="check"><input type="checkbox" name="mode" value="${esc(md.id)}" ${i === 0 ? 'checked' : ''}> ${esc(md.name)} <span class="muted small">${esc(md.id)}</span></label>`).join('')
        : '<p class="muted small">No modes listed — the server will use its default.</p>';
    } catch (x) {
      modeList.innerHTML = `<p class="muted small">${esc(x.message)}</p>`;
    }
  };
  form.map.onchange = loadModes;
  loadModes();
  form.onsubmit = (e) => {
    e.preventDefault();
    const experiences = [...form.querySelectorAll('[name=mode]:checked')].map((c) => c.value);
    const name = form.map.options[form.map.selectedIndex].text;
    m.close();
    act(sid, { action: 'map', map: form.map.value, experiences }, `Changing map to ${name}.`);
  };
}

// The public server list reports internal map names; show what players see in game.
const MAP_NAMES = { Madrid: 'Ozeti', Detroit: 'Zestafona', Europe: 'Ozeti', NorthAmerica: 'Zestafona', Kavkazi: 'Bakurani' };
const mapDisplay = (m) => MAP_NAMES[m] || m || '—';

const regionName = (r) => String(r || '').split('-').map((p) => (p.length <= 2 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join(' ');
const modeName = (exp, map) => String(exp || '').split('+')[0].replace(new RegExp(`^${map}_`, 'i'), '').replace(/_\d+$/, '').replace(/_/g, ' ') || '—';

async function viewServers(main, _r, alive) {
  const staff = isStaff();
  const admin = state.me.role === 'admin';
  const { servers, stale } = await api('servers');
  if (!alive()) return;
  const adminTools = () => import('./admin.js');
  const addServer = async () => {
    try { await (await adminTools()).addGameServer(() => route()); } catch (x) { fail(x); }
  };
  if (!servers.length) {
    main.innerHTML = `<h1>Servers</h1><div class="panel empty">No servers added yet.${admin ? `<div style="margin-top:12px"><button class="btn primary" id="srvAdd">${icon('plus')} Add server</button></div>` : ''}</div>`;
    document.getElementById('srvAdd')?.addEventListener('click', addServer);
    return;
  }

  const serverCard = (s) => {
    const l = s.live;
    const pct = l ? Math.min(100, (l.players / Math.max(1, l.maxPlayers)) * 100) : 0;
    return `
      <div class="panel glow" data-server="${s.id}">
        <div class="row between" style="align-items:flex-start">
          <div class="grow">
            <div style="font:700 22px var(--head);text-transform:uppercase;line-height:1.15">${esc(l?.name || s.name)}</div>
            ${l && s.name && s.name !== l.name ? `<div class="muted small">${esc(s.name)}</div>` : ''}
          </div>
          <span class="pill ${s.online ? 'mod' : 'banned'}">${s.online ? '● Online' : 'Offline'}</span>
        </div>
        ${s.description ? `<p class="muted" style="margin:8px 0 0">${esc(s.description)}</p>` : ''}
        ${l ? `
          <div style="margin:14px 0 6px" class="row between"><b style="font:700 18px var(--head)" data-live-players="${s.id}">${l.players} / ${l.maxPlayers} players</b>
            <span class="row">${l.rulesets.map((r) => `<span class="pill">${esc(r)}</span>`).join('')}${l.passwordProtected ? `<span class="pill pending">${icon('lock', 'width="12" height="12"')} Password</span>` : ''}</span></div>
          <div class="xpbar"><div style="width:${pct.toFixed(1)}%"></div></div>
          <div class="tiles" style="margin-top:14px">
            <span data-live-map="${s.id}">${tile('target', 'Map', mapDisplay(l.map))}</span>
            <span data-live-mode="${s.id}">${tile('swords', 'Mode', modeName(l.mode, l.map))}</span>
            ${tile('chart', 'Region', regionName(l.region))}
          </div>` : '<p class="muted">This server is not showing in the live server list right now. It may be offline or restarting.</p>'}
        ${s.has_rcon ? `<div data-live="${s.id}" style="margin-top:16px"></div>` : ''}
        <div class="row" style="margin-top:14px">
          <span class="muted small" style="text-transform:uppercase;font:700 13px var(--head);color:var(--accent2)">Server ID</span>
          <code style="background:#06101c;border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-size:13px;overflow-wrap:anywhere">${esc(s.join_code)}</code>
          <button class="btn small" data-copy="${esc(s.join_code)}">${icon('copy')} Copy</button>
        </div>
        ${s.has_rcon ? `<div style="margin-top:18px"><h4 class="row" style="margin:0 0 8px">${icon('users', 'width="18" height="18"')} On the server now</h4><div class="list" data-players="${s.id}"><div class="spinner" style="margin:10px auto"></div></div></div>` : ''}
        ${staff ? controlsHtml(s) : ''}
      </div>`;
  };

  const controlsHtml = (s) => {
    if (!s.has_rcon) {
      return `<div class="row" style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
        <p class="muted small grow" style="margin:0">${icon('shield', 'width="14" height="14"')} ${admin
          ? 'Add this server\'s RCON address and password to control it from here.'
          : 'An admin can add this server\'s RCON details so staff can control it from here.'}</p>
        ${admin ? `<button class="btn small primary" data-settings="${s.id}">${icon('settings')} Add RCON details</button>` : ''}</div>`;
    }
    return `
      <div style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px" class="stack">
        <div class="row between"><h4 class="row" style="margin:0">${icon('shield', 'width="18" height="18" style="color:var(--gold)"')} Server controls</h4>
          ${admin ? `<button class="btn small" data-settings="${s.id}">${icon('settings')} Server settings</button>` : ''}</div>
        <form class="row" data-broadcast="${s.id}"><input type="text" name="message" class="grow" maxlength="300" placeholder="Message everyone on the server" style="min-width:180px"><button class="btn">${icon('megaphone')} Broadcast</button></form>
        ${admin ? `
        <div class="row">
          <button class="btn" data-act="restart" data-sid="${s.id}">${icon('refresh')} Restart match</button>
          <button class="btn" data-act="end" data-sid="${s.id}">End match</button>
          <button class="btn" data-act="map" data-sid="${s.id}">${icon('target')} Change map</button>
          <button class="btn ghost" data-act="unban" data-sid="${s.id}">Unban a Steam ID</button>
        </div>` : '<p class="muted small">Mods can broadcast, kick and kill. Admins can also ban and control the match.</p>'}
      </div>`;
  };

  main.innerHTML = `<div class="row between"><h1>Servers</h1><div class="row">
      ${admin ? `<button class="btn primary" id="srvAdd">${icon('plus')} Add server</button>` : ''}
      <button class="btn" id="srvRefresh">${icon('refresh')} Refresh</button></div></div>
    ${stale ? '<p class="muted small">⚠ Live server data may be a few minutes old.</p>' : ''}
    <div class="stack">${servers.map(serverCard).join('')}</div>
    <div class="credit">Live server data by <a href="https://wardogservers.com" target="_blank" rel="noopener">Wardog Servers</a></div>`;

  async function loadPlayers(s) {
    const box = main.querySelector(`[data-players="${s.id}"]`);
    if (!box) return;
    try {
      const players = await api(`servers/${s.id}/players`);
      if (!alive()) return;
      box.innerHTML = players.length ? players.map((p) => `
        <div class="item player-item">
          <div class="grow" style="min-width:0">
            ${p.member ? `<a href="#/u/${p.member.id}" style="color:inherit">${userLine(p.member)}</a>` : `<b>${esc(p.name)}</b>`}
            <div class="muted small">${p.kills !== null ? `${p.kills} kills · ${p.deaths} deaths` : ''}${p.pingMs !== null ? ` · ${p.pingMs} ms` : ''}${p.member ? '' : ' · not in app'}</div>
          </div>
          ${staff && p.steamId ? `<div class="row">
            <button class="btn small" data-act="kick" data-sid="${s.id}" data-steam="${esc(p.steamId)}" data-name="${esc(p.name)}">Kick</button>
            <button class="btn small ghost" data-act="kill" data-sid="${s.id}" data-steam="${esc(p.steamId)}" data-name="${esc(p.name)}">Kill</button>
            ${admin ? `<button class="btn small danger" data-act="ban" data-sid="${s.id}" data-steam="${esc(p.steamId)}" data-name="${esc(p.name)}">Ban</button>` : ''}
          </div>` : ''}
        </div>`).join('') : '<p class="muted">Nobody on right now.</p>';
    } catch (e) {
      box.innerHTML = `<p class="muted small">Couldn't load players: ${esc(e.message)}</p>`;
    }
  }
  servers.filter((s) => s.has_rcon).forEach(loadPlayers);

  // Live match straight from the server (RCON): real map name, mode, weather, scores, next map.
  async function loadLive(s) {
    const box = main.querySelector(`[data-live="${s.id}"]`);
    if (!box) return;
    try {
      const m = await api(`servers/${s.id}/live`);
      if (!alive()) return;
      const mapTile = main.querySelector(`[data-live-map="${s.id}"]`);
      const modeTile = main.querySelector(`[data-live-mode="${s.id}"]`);
      if (mapTile) mapTile.innerHTML = tile('target', 'Map', m.map);
      const pl = main.querySelector(`[data-live-players="${s.id}"]`);
      if (pl && m.maxPlayers) pl.textContent = `${m.players} / ${m.maxPlayers} players`;
      if (modeTile) modeTile.innerHTML = tile('swords', 'Mode', [m.mode, ...m.modifiers].join(' + '));
      const clock = m.matchSeconds === null ? '' : ` · ${Math.floor(m.matchSeconds / 60)}m ${m.matchSeconds % 60}s`;
      box.innerHTML = `
        <h4 class="row" style="margin:0 0 10px">${icon('crosshair', 'width="18" height="18"')} Live match <span class="muted small">· ${esc(m.lighting)}${m.zone ? ` · ${esc(m.zone)}` : ''}${clock} · first to ${m.scoreCap}</span></h4>
        ${m.scores.length ? `<div class="grid three" style="gap:10px">${m.scores.map((f) => `
          <div class="score-tile" style="--fc:${esc(f.color || '#29b6f6')}">
            <div class="row between"><b>${esc(f.name)}</b><b style="font:700 20px var(--head)">${fmtNum(f.score)}</b></div>
            <div class="xpbar"><div style="width:${Math.min(100, (f.score / Math.max(1, m.scoreCap)) * 100).toFixed(1)}%;background:var(--fc);box-shadow:0 0 10px var(--fc)"></div></div>
          </div>`).join('')}</div>` : ''}
        ${m.next ? `<p class="muted small" style="margin:10px 0 0">Next map: <b style="color:var(--text)">${esc(m.next.map)}</b>${m.next.mode ? ` · ${esc(m.next.mode)}` : ''}${m.next.lighting ? ` · ${esc(m.next.lighting)}` : ''}${m.next.zone ? ` · ${esc(m.next.zone)}` : ''}</p>` : ''}`;
    } catch (e) {
      box.innerHTML = staff ? `<p class="muted small">Live match unavailable: ${esc(e.message)}</p>` : '';
    }
  }
  servers.filter((s) => s.has_rcon).forEach(loadLive);

  async function act(sid, body, done) {
    try {
      await api(`admin/servers/${sid}/action`, { method: 'POST', body });
      toast('Done', done);
      const s = servers.find((x) => x.id === Number(sid));
      if (s) loadPlayers(s);
    } catch (x) { fail(x); }
  }

  main.onclick = async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Copied', 'Server ID copied.'); } catch { toast('Copy failed', 'Select the ID and copy it by hand.', { error: true }); }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act: a, sid, steam, name } = b.dataset;
    if (a === 'kick') {
      const reason = await promptBox(`Kick ${name}?`, 'Reason (optional)', { okLabel: 'Kick' });
      if (reason !== null) act(sid, { action: 'kick', steamId: steam, reason }, `${name} was kicked.`);
    } else if (a === 'kill') {
      if (await confirmBox(`Kill ${name} in game?`)) act(sid, { action: 'kill', steamId: steam }, `${name} was killed.`);
    } else if (a === 'ban') {
      const reason = await promptBox(`Ban ${name} from the server?`, 'Reason (optional)', { danger: true, okLabel: 'Ban' });
      if (reason !== null) act(sid, { action: 'ban', steamId: steam, reason }, `${name} was banned.`);
    } else if (a === 'unban') {
      const id = await promptBox('Unban which Steam ID?', '17-digit Steam ID', { okLabel: 'Unban' });
      if (id) act(sid, { action: 'unban', steamId: id }, 'Ban removed.');
    } else if (a === 'restart') {
      if (await confirmBox('Restart the current match for everyone?')) act(sid, { action: 'restart' }, 'Match restarting.');
    } else if (a === 'end') {
      if (await confirmBox('End the current match now?')) act(sid, { action: 'end' }, 'Match ended.');
    } else if (a === 'map') {
      changeMapBox(sid, act);
    }
  };
  main.querySelectorAll('[data-broadcast]').forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const message = f.message.value.trim();
      if (!message) return;
      act(f.dataset.broadcast, { action: 'broadcast', message }, 'Message sent to the server.');
      f.message.value = '';
    };
  });

  const timer = setInterval(() => {
    if (!alive()) return clearInterval(timer);
    servers.filter((s) => s.has_rcon).forEach((s) => { loadPlayers(s); loadLive(s); });
  }, 20000);
  document.getElementById('srvRefresh').onclick = () => route();
  document.getElementById('srvAdd')?.addEventListener('click', addServer);
  main.querySelectorAll('[data-settings]').forEach((b) => {
    b.onclick = async () => {
      try { await (await adminTools()).editGameServer(b.dataset.settings, () => route()); } catch (x) { fail(x); }
    };
  });
}

// ---------- Leaderboard ----------
// The WPG game server's own leaderboard (counted live from the server).
const SERVER_SORTS = [['kills', 'Kills'], ['kd', 'K/D'], ['wins', 'Wins'], ['matches', 'Matches'], ['playtime', 'Playtime']];
async function serverBoardHtml(sort, serverId) {
  const d = await api(`server-leaderboard?by=${sort}${serverId ? `&server=${serverId}` : ''}`);
  if (!d.servers.length) {
    return '<div class="panel empty">The server leaderboard starts once a game server has its RCON details (Servers → Server settings).</div>';
  }
  const tag = state.settings.clan_tag || 'WPG';
  const ratio = (a, b) => (a / Math.max(1, b)).toFixed(2);
  const link = (extra) => `#/leaderboard?by=server&sort=${extra.sort ?? sort}${(extra.server ?? d.server) ? `&server=${extra.server ?? d.server}` : ''}`;
  return `
    ${d.servers.length > 1 ? `<div class="tabs">${d.servers.map((s) => `<a href="${link({ server: s.id })}" class="${s.id === d.server ? 'active' : ''}">${esc(s.name)}</a>`).join('')}</div>` : ''}
    <div class="panel glow sb-panel">
      <div class="row between" style="margin-bottom:10px">
        <div class="panel-title" style="margin:0">${icon('trophy')} Server <span class="sub">leaderboard</span></div>
        <span class="muted small">${d.updated ? `Updated ${timeAgo(d.updated)}` : 'Waiting for the first check'} · counts every 30 s</span>
      </div>
      <div class="row" style="gap:6px;margin-bottom:12px"><span class="muted small">Sort by</span>
        ${SERVER_SORTS.map(([k, l]) => `<a class="btn small${k === d.by ? ' primary' : ''}" href="${link({ sort: k })}">${l}</a>`).join('')}</div>
      <div class="table-wrap"><table class="sb-table">
        <thead><tr><th>#</th><th>Player</th><th>Kills</th><th class="sb-x">Deaths</th><th>K/D</th><th class="sb-m">Matches</th><th>Wins</th><th class="sb-x">Losses</th><th class="sb-x">W/L</th><th>Playtime</th><th class="sb-x">${esc(tag)} rank</th><th class="sb-x">${esc(tag)} XP</th></tr></thead>
        <tbody>${d.rows.map((r, i) => `<tr>
          <td><b style="color:${i === 0 ? 'var(--gold)' : i < 3 ? 'var(--accent2)' : 'var(--muted)'}">${i + 1}</b></td>
          <td class="sb-name">${r.member ? `<a href="#/u/${r.member.id}">${esc(r.name)}</a>` : esc(r.name)}</td>
          <td>${fmtNum(r.kills)}</td><td class="sb-x">${fmtNum(r.deaths)}</td><td>${ratio(r.kills, r.deaths)}</td>
          <td class="sb-m">${fmtNum(r.matches)}</td><td>${fmtNum(r.wins)}</td><td class="sb-x">${fmtNum(r.losses)}</td><td class="sb-x">${ratio(r.wins, r.losses)}</td>
          <td>${fmtMins(Math.floor(r.playtime_s / 60))}</td>
          <td class="sb-x">${r.member ? `<span class="accent" style="font:700 13px var(--head);text-transform:uppercase">${esc(isPmc(r.member) ? 'PMC' : r.member.rank?.abbr || '—')}</span>` : '<span class="muted small">Guest</span>'}</td>
          <td class="sb-x">${r.member ? fmtNum(r.member.xp) : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="12" class="muted">Nobody yet — stats appear after players join the server.</td></tr>'}</tbody>
      </table></div>
      <p class="muted small" style="margin:10px 0 0">Wins and losses count when a match ends (your team had the top score). Guests are players not in the app.</p>
    </div>`;
}

async function viewLeaderboard(main) {
  const by = query().get('by') || 'xp';
  const tabs = [['server', `${state.settings.clan_tag || 'WPG'} server`], ['xp', `${state.settings.clan_tag || 'WPG'} XP`], ['level', 'Wardog level'], ['worth', 'Account worth'], ['cash', 'Cash held'], ['kills', 'Server kills'], ['hours', 'Steam hours']];
  if (by === 'server') {
    main.innerHTML = `<h1>Leaderboard</h1>
      <div class="tabs">${tabs.map(([k, l]) => `<a href="#/leaderboard?by=${k}" class="${k === by ? 'active' : ''}">${l}</a>`).join('')}</div>
      ${await serverBoardHtml(query().get('sort') || 'kills', query().get('server'))}`;
    onLive('server-board', () => route());
    return;
  }
  const list = await api(`leaderboard?by=${by}`);
  const unit = { xp: 'XP', level: 'LVL', kills: 'kills', hours: 'h' }[by] || '';
  main.innerHTML = `<h1>Leaderboard</h1>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/leaderboard?by=${k}" class="${k === by ? 'active' : ''}">${l}</a>`).join('')}</div>
    ${by === 'worth' ? '<p class="muted small" style="margin:-4px 0 12px">Account worth = cash on hand + the value of every unlock the player has reached (from their WARDOGS Tracker levels).</p>' : ''}${by === 'worth' || by === 'cash' || by === 'level' ? '<p class="muted small" style="margin:-4px 0 12px">Members show $0 / 0 until they link WARDOGS Tracker on HQ.</p>' : ''}
    <div class="panel list">${list.map((u, i) => `
      <a class="item" href="#/u/${u.id}">
        <b style="font:700 22px var(--head);width:42px;text-align:center;color:${i === 0 ? 'var(--gold)' : i < 3 ? 'var(--accent2)' : 'var(--muted)'}">#${i + 1}</b>
        <div class="grow">${userLine(u)}</div>
        <b style="font:700 18px var(--head)">${by === 'cash' || by === 'worth' ? fmtMoney(u.score) : `${fmtNum(u.score)} <span class="muted small">${unit}</span>`}</b>
      </a>`).join('') || '<p class="empty">No data yet.</p>'}</div>`;
}

// ---------- Progression (unlocks by class) ----------
const TOOL_ROLES = [['career', 'Career'], ['recon', 'Recon'], ['assault', 'Assault (Infantry)'], ['medic', 'Medic'], ['support', 'Support'], ['driver', 'Driver'], ['pilot', 'Pilot']];

// Artillery firing tables live in our database (Admin → Artillery); originally from wardogs-calculator by Apollyon (MIT licence).
// Straight-line interpolation in a [range m, elevation mil] table. Returns null when out of range.
export function elevationFor(table, minM, maxM, range) {
  if (!(range >= minM && range <= maxM)) return null;
  for (let i = 0; i < table.length - 1; i++) {
    const [r1, m1] = table[i];
    const [r2, m2] = table[i + 1];
    if ((range >= r1 && range <= r2) || (range <= r1 && range >= r2)) {
      if (r1 === r2) return Math.round((m1 + m2) / 2);
      return Math.round(m1 + ((range - r1) / (r2 - r1)) * (m2 - m1));
    }
  }
  return null;
}

async function viewTools(main) {
  const [list, mine] = await Promise.all([
    api('unlocks'),
    api(`users/${state.me.id}`).catch(() => null),
  ]);
  const off = mine?.wardogs?.official;
  const levelOf = (role) => {
    if (!off) return null;
    if (role === 'career') return Number(off.wardogLevel) || 0;
    const r = off.roles?.[role];
    return r === undefined ? null : Number(r?.level ?? r) || 0;
  };
  const tab = query().get('role') || 'career';
  const level = levelOf(tab);
  const items = list.filter((u) => u.role === tab).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  const [c, , art] = ROLE_STYLE[tab] || ['#29b6f6', 'star', ''];
  const totalCost = items.reduce((sum, u) => sum + (u.cost || 0), 0);

  main.innerHTML = `<h1>Progression</h1>
    <div class="stack">
      <div class="panel">
        <div class="panel-title">${icon('unlock')} Progression <span class="sub">unlocks by class</span></div>
        <div class="tabs">${TOOL_ROLES.map(([k, l]) => `<a href="#/progression?role=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
        <div class="row" style="align-items:flex-start;gap:16px">
          ${art ? `<img src="/img/brand/roles/${art}.webp" alt="" style="width:96px;border-radius:6px;border:1px solid ${c}">` : '<img src="/img/brand/wolf-emblem.webp" alt="" style="width:96px;border-radius:6px">'}
          <div class="grow" style="min-width:240px">
            <div style="font:700 20px var(--head);text-transform:uppercase">${esc(TOOL_ROLES.find(([k]) => k === tab)?.[1] || tab)}${tab === 'career' ? ' (Wardog level)' : ''}</div>
            <div class="muted">${items.length} unlocks${totalCost ? ` · ${fmtMoney(totalCost)} to unlock everything` : ''}</div>
            <div class="muted">${level === null
              ? (state.realSteam && !state.trackerLinked ? 'Link WARDOGS Tracker on HQ to see your progress here.' : 'Your level for this class is not known yet.')
              : `You are level <b style="color:var(--text)">${level}</b> — ${items.filter((u) => u.level <= level).length} of ${items.length} unlocked.`}</div>
          </div>
        </div>
        <div class="unlock-list">${items.map((u) => {
          const got = level !== null && u.level <= level;
          return `<div class="unlock ${got ? 'got' : ''}"><b class="lv">L${u.level}</b>
            ${u.image ? `<img class="ui" src="${esc(u.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="ui"></span>'}
            <span class="grow">${esc(u.name)} <span class="muted small">· ${esc(u.kind || 'Unlock')}</span></span>
            <span class="small cost">${u.cost ? fmtMoney(u.cost) : 'Free'}</span>
            <span class="small state">${got ? '<span style="color:var(--green)">✓ Unlocked</span>' : level === null ? '' : `${u.level - level} to go`}</span></div>`;
        }).join('') || '<p class="muted">No unlocks listed for this class yet.</p>'}</div>
      </div>
    </div>`;
  onLive('config', (name) => { if (name === 'unlocks') route(); });

}

// ---------- Ranks ----------
// "How to earn XP", built from the live settings so it changes as soon as an admin changes a rate.
function xpRulesHtml(x) {
  const tag = state.settings.clan_tag || 'WPG';
  const per = (n) => `+${fmtNum(Number(n.toFixed(2)))} XP`;
  const rows = [];
  if (x.per_kill) rows.push(['crosshair', `Kills on the ${tag} server`, `${per(x.per_kill)} per kill`]);
  for (const s of x.stats) {
    if (s.format === 'minutes') rows.push(['clock', s.label, `${per(s.xp * 60)} per hour`]);
    else rows.push([s.key === 'wins' ? 'win' : s.key === 'matches' ? 'calendar' : 'chart', s.label, `${per(s.xp)} each`]);
  }
  for (const g of x.games) {
    if (g.per_hour) rows.push(['steam', `Playing ${g.name} (Steam hours)`, `${per(g.per_hour)} per hour`]);
    if (g.per_achievement) rows.push(['medal', `${g.name} Steam achievements`, `${per(g.per_achievement)} each`]);
  }
  rows.push(['star', 'Bonus XP from staff', 'events, good conduct, winning tournaments…']);
  return `
    ${x.event ? `<div class="panel glow xp-event"><span class="script" style="font-size:22px">XP event</span><div style="font:700 20px var(--head);text-transform:uppercase;margin-top:6px">${esc(x.event)}</div></div>` : ''}
    <div class="panel">
      <div class="panel-title">${icon('xp')} How to earn <span class="sub">${esc(tag)} XP</span></div>
      <div class="xp-rules">${rows.map(([ic, what, how]) => `
        <div class="xp-rule"><span class="ic">${icon(ic)}</span><span class="grow">${esc(what)}</span><b>${esc(how)}</b></div>`).join('')}</div>
      <ul class="muted small" style="margin:14px 0 0;padding-left:18px;line-height:1.7">
        <li>Your stats sync by themselves every ${x.sync_minutes} minutes, or press <b>Sync stats</b> on HQ. XP is added when they sync.</li>
        <li>New activity earns the rate <b>at the time it's counted</b>. When staff change a rate (for example an XP event), XP you've already earned stays the same.</li>
        <li>Global Wardogs stats need <b>WARDOGS Tracker</b> linked — see the card on HQ if you haven't.</li>
        <li>${x.auto_promote ? 'Ranks marked with XP are given automatically as soon as you reach them.' : 'Automatic promotions are paused right now — staff promote by hand.'} Ranks marked <b>Appointed</b> are given by command.</li>
        ${isPmc(state.me) ? '<li>You\'re a PMC (guest): you earn XP but don\'t hold a rank.</li>' : ''}
      </ul>
    </div>`;
}

async function viewRanks(main) {
  const [ranks, rules] = await Promise.all([api('ranks'), api('xp-rules')]);
  onLive('config', (name) => { if (['settings', 'stat-defs', 'games', 'ranks'].includes(name)) route(); });
  onLive('me', () => route());
  main.innerHTML = `<h1>Rank structure</h1>
    <p class="muted">Our insignia combine US and British Army symbols: US chevrons, rockers, bars, oak leaves and stars with the British crown, pips and crossed sword &amp; baton.
    Ranks marked <b>XP</b> are earned automatically. Ranks marked <b>Appointed</b> are given by command.
    You have <b style="color:var(--text)">${fmtNum(state.me.xp)} XP</b>.</p>
    <div class="stack" style="margin-bottom:16px">${xpRulesHtml(rules)}</div>
    <div class="panel">${[...ranks].reverse().map((r) => `
      <div class="rank-row" style="${state.me.rank_id === r.id ? 'background:rgba(41,182,246,.08);border-radius:8px' : ''}">
        ${rankBadge(r, 64)}
        <div class="grow"><b style="font:700 19px var(--head);text-transform:uppercase">${esc(r.name)}</b> <span class="pill">${esc(r.abbr)}</span>
          ${state.me.rank_id === r.id ? '<span class="pill mod">You</span>' : ''}
          <div class="muted small">${esc(r.description)}</div></div>
        <div style="text-align:right;font:700 16px var(--head)">${r.auto ? `${fmtNum(r.min_xp)} XP` : '<span class="accent">Appointed</span>'}</div>
      </div>`).join('')}</div>`;
}

export { refreshMe, route };

boot();
