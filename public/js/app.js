import { icon } from './icons.js';
import { frameSVG } from './frameart.js';
import { rankBadge, insigniaSVG, wpgBadge, wpgTierOf } from './insignia.js';

// ---------- Shared helpers ----------
export const state = {
  me: null,
  settings: {},
  online: new Set(),
  playing: {}, // userId -> { game, appId } from Steam
  unread: 0,
  friendReq: 0,
  liveStreams: 0, // approved streamers live right now
  socket: null,
  users: new Map(),
};

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export async function api(path, { method = 'GET', body } = {}) {
  const url = path.startsWith('/') ? path : `/api/${path}`;
  const send = () => fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  // 502/503/504 come from the host while the app restarts (an update, or waking up): wait and try again.
  const down = (r) => !r || [502, 503, 504].includes(r.status);
  let res = await send().catch(() => null);
  for (let wait = 3000; down(res) && wait <= 12000; wait *= 2) {
    await new Promise((r) => setTimeout(r, wait));
    res = await send().catch(() => null);
  }
  if (down(res)) {
    const err = new Error('The app is restarting (usually after an update). Please try again in a minute.');
    err.status = res?.status || 0;
    throw err;
  }
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
  // In their profile frame (frames.js), if they show one: same space, the picture sits inside the frame.
  const framed = u?.frame ? ` framed ${cls}" title="${esc(u.frame.name)} frame` : '';
  return `<span class="av-wrap${framed}"><img class="avatar ${cls}" src="${esc(u?.avatar || FALLBACK_AVATAR)}" alt="" loading="lazy" referrerpolicy="no-referrer">${u?.frame ? frameSVG(u.frame) : ''}<span class="dot ${on ? 'on' : ''}" data-online="${u?.id}"></span></span>`;
}
export function rolePill(u) {
  const dev = (u.developer ? ' <span class="pill dev">Creator</span>' : '') + (u.membership === 'pmc' ? ' <span class="pill pmc">PMC</span>' : '');
  if (u.status === 'pending') return `<span class="pill pending">Pending</span>${dev}`;
  if (u.status === 'banned') return `<span class="pill banned">Banned</span>${dev}`;
  if (u.role === 'admin') return `<span class="pill admin">Admin</span>${dev}`;
  if (u.role === 'mod') return `<span class="pill mod">Mod</span>${dev}`;
  return dev.trim();
}
const isPmc = (u) => u?.membership === 'pmc';
// WPG server rank as shown in the app: "FIELD COMMANDER IX" -> "Field Commander IX".
export const wpgRankName = (name) => String(name || 'RECRUIT I').split(/\s+/)
  .map((w) => (/^(WPG|[IVX]+)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
// Progress to the next WPG rank, for { xp, from, next: { name, xp } } (no next = top rank or no rank list yet).
const wpgToNext = (w) => (w?.next ? `${fmtNum(Math.max(0, w.next.xp - (w.xp || 0)))} XP to ${wpgRankName(w.next.name)}` : '');
const wpgPct = (w) => (w?.next ? Math.max(0, Math.min(100, (((w.xp || 0) - (w.from || 0)) / Math.max(1, w.next.xp - (w.from || 0))) * 100)) : 100);
// Every WPG rank, one row per tier (I–X), with the badge and the XP each step starts at. Yours is marked.
function ladderHtml(ranks, me) {
  if (!ranks.length) return '';
  const tiers = [];
  for (const r of ranks) (tiers[Math.floor((r.level - 1) / 10)] ||= []).push(r);
  const mineTier = me ? Math.floor(((me.level || 1) - 1) / 10) : -1;
  return `<details class="panel wpg-ladder">
    <summary class="panel-title" style="margin:0;cursor:pointer">${icon('chevrons')} All ${ranks.length} ${esc(state.settings.clan_tag || 'WPG')} ranks <span class="sub">tap to open</span></summary>
    <div class="list" style="margin-top:12px">${tiers.filter(Boolean).map((t, i) => {
      const tierName = t[0].name.replace(/\s+[IVX]+$/i, '');
      return `<div class="item"${i === mineTier ? ' style="background:rgba(41,182,246,.08);border-radius:8px"' : ''}>${wpgBadge(t[0].level, 52, t[0].name)}
        <div class="grow"><b style="font:700 17px var(--head);text-transform:uppercase">${esc(tierName)}</b>${i === mineTier ? ' <span class="pill mod">You</span>' : ''}
          <div class="muted small">${t.map((r) => `${esc(wpgTierOf(r.level, r.name).numeral)} ${fmtNum(r.min_xp)}`).join(' · ')}</div></div></div>`;
    }).join('')}</div>
  </details>`;
}
const wpgBar = (w) => (w?.next ? `<div class="xpbar" title="${esc(wpgToNext(w))}"><div style="width:${wpgPct(w).toFixed(1)}%"></div></div>` : '');
// Clan role, kept apart from any rank.
const roleName = (u) => (!u ? 'Not in app' : u.role === 'admin' ? 'Admin' : u.role === 'mod' ? 'Mod' : isPmc(u) ? 'PMC' : 'Member');
// PMCs (guests) have no rank, so they get a PMC badge instead.
export function badgeFor(u, size) {
  return isPmc(u) ? insigniaSVG({}, { size, abbr: 'PMC', color: '#f5a524', title: 'PMC (guest)' }) : rankBadge(u?.rank, size);
}
const rankName = (u) => (isPmc(u) ? 'PMC · Guest' : u?.rank ? u.rank.name : 'No rank');
// "Playing …" tag from Steam; Wardogs is highlighted. Kept live by the 'playing' socket event.
const isWardogs = (p) => (p && /wardogs/i.test(p.game) ? 1 : 0);
// "🎮 WARDOGS · -$10,793 Loss": the game, plus live match money from Steam for members who switched it on
// (Wardogs only: other games just show their name).
const playingHtml = (p) => (p ? `🎮 ${esc(p.game || '')}${p.live?.text && isWardogs(p) ? ` · <b class="live-money${p.live.money > 0 ? ' up' : p.live.money < 0 ? ' down' : ''}">${esc(p.live.text)}</b>` : ''}` : '');
export function playingTag(u) {
  const p = state.playing[u?.id];
  return `<span class="playing-tag${isWardogs(p) ? ' wd' : ''}" data-playing="${u?.id}"${p ? '' : ' hidden'}>${playingHtml(p)}</span>`;
}
export function userLine(u, meta = '') {
  return `<div class="user-line">${avatar(u)}${badgeFor(u, 34)}
    <div class="grow"><div class="name">${esc(u.name)} ${rolePill(u)} ${playingTag(u)}</div>
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
  renderRelinkBar();
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
  state.trackerState = me.tracker_state || null;
  state.trackerPolledAt = me.tracker_polled_at || null;
  state.trackerRelink = !!me.tracker_relink;
  state.wpgServer = me.wpg_server || null;
  state.discordLinked = !!me.discord_linked;
  state.realSteam = !!me.real_steam;
  state.users.set(me.user.id, me.user);
}

async function refreshMe() {
  try {
    applyMe(await api('me'));
    updateNav();
    renderRelinkBar();
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
      <div class="social-row" style="margin-top:16px">${socialLinks('btn')}</div>
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
  { href: '#/streams', key: 'streams', label: 'Streams', icon: 'live', count: () => state.liveStreams },
  { href: '#/members', key: 'members', label: 'Members', icon: 'users' },
  { href: '#/leaderboard', key: 'leaderboard', label: 'Leaderboard', icon: 'trophy' },
  { href: '#/giveaways', key: 'giveaways', label: 'Giveaways', icon: 'gift' },
  { href: '#/map', key: 'map', label: 'Arty map', icon: 'target' },
  { href: '#/sitrooms', key: 'sitrooms', label: 'Situation rooms', icon: 'crosshair', wpg: true },
  { href: '#/progression', key: 'progression', label: 'Progression', icon: 'unlock' },
  { href: '#/ranks', key: 'ranks', label: 'Clan ranks', icon: 'chevrons' },
  { href: '#/command', key: 'command', label: 'Combat Command', icon: 'shield', wpg: true },
  { href: '#/recruitment', key: 'recruitment', label: 'Recruitment', icon: 'target' },
  { sep: true },
  { href: () => `#/u/${state.me.id}`, key: 'me', label: 'My career', icon: 'user' },
  { href: '#/profile/edit', key: 'edit', label: 'Edit profile', icon: 'edit' },
  { href: '#/admin', key: 'admin', label: 'Admin', icon: 'shield', staff: true },
  { href: '#/discord', key: 'discord', label: 'Discord control', icon: 'discord', adminOnly: true },
];
const BOTTOM = ['home', 'chat', 'messages', 'friends'];

function navLink(n) {
  const href = typeof n.href === 'function' ? n.href() : n.href;
  const c = n.count?.() || 0;
  return `<a href="${href}" data-nav="${n.key}">${icon(n.icon)}<span>${n.label}</span>${c ? `<span class="badge-count">${c}</span>` : ''}</a>`;
}

// The clan's Discord and Facebook (Admin → Settings), as small buttons.
function socialLinks(cls = 'btn small') {
  const s = state.settings;
  const ok = (u) => /^https:\/\//.test(u || '');
  return [
    ok(s.discord_invite) ? `<a class="${cls} discord-join" href="${esc(s.discord_invite)}" target="_blank" rel="noopener">${icon('discord')} Discord</a>` : '',
    ok(s.facebook_url) ? `<a class="${cls} facebook-btn" href="${esc(s.facebook_url)}" target="_blank" rel="noopener">${icon('facebook')} Facebook</a>` : '',
  ].join('');
}

function renderShell() {
  const s = state.settings;
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><img class="brand-logo" src="${esc(brandLogo())}" alt="${esc(s.clan_name || 'WPG')}"><div class="tag">Barracks</div></div>
        <nav class="nav" id="nav"></nav>
        <div class="sidebar-art"><span class="script">More than a game</span></div>
        <div class="social-row">${socialLinks()}</div>
        <div class="me-card" id="mecard"></div>
      </aside>
      <div style="min-width:0">
        <header class="topbar">
          <button class="btn ghost small" id="menuBtn" aria-label="Menu">${icon('menu')}</button>
          <img src="/img/icon-192.png" alt=""><div class="title" id="topTitle">${esc(s.clan_name || 'WPG')}</div>
        </header>
        <div id="relinkBar"></div>
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
  nav.innerHTML = NAV.filter((n) => (!n.staff || isStaff()) && (!n.adminOnly || state.me?.role === 'admin') && (!n.wpg || !isPmc(state.me) || isStaff())).map((n) => (n.sep ? '<div class="sep"></div>' : navLink(n))).join('');
  document.getElementById('bottomnav').innerHTML =
    NAV.filter((n) => BOTTOM.includes(n.key)).map(navLink).join('') +
    `<a href="#" id="moreBtn">${icon('menu')}<span>More</span></a>`;
  document.getElementById('moreBtn').onclick = (e) => { e.preventDefault(); document.getElementById('menuBtn').click(); };
  const me = state.me;
  document.getElementById('mecard').innerHTML = `${avatar(me, 'sm')}<div class="grow"><b>${esc(me.name)}</b><div class="muted">${isPmc(me) ? 'PMC' : me.rank ? esc(me.rank.abbr) : 'No rank'} · ${fmtNum(me.xp)} Clan XP</div></div>
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
  socket.on('app:version', (v) => {
    if (!state.appVersion) state.appVersion = v;
    else if (v !== state.appVersion) updateWaiting = true;
    if (updateWaiting && document.hidden) location.reload();
  });
  socket.on('presence', (ids) => {
    state.online = new Set(ids);
    document.querySelectorAll('[data-online]').forEach((d) => d.classList.toggle('on', state.online.has(Number(d.dataset.online))));
    emitLive('presence', ids);
  });
  socket.on('playing', (map) => {
    state.playing = map || {};
    document.querySelectorAll('[data-playing]').forEach((t) => {
      const p = state.playing[t.dataset.playing];
      t.hidden = !p;
      t.classList.toggle('wd', !!isWardogs(p));
      t.innerHTML = playingHtml(p);
    });
    emitLive('playing', map);
  });
  socket.on('combat', () => emitLive('combat'));
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
  socket.on('killfeed', (evs) => emitLive('killfeed', evs));
  socket.on('notify', (n) => {
    toast(n.title, n.body, { link: n.link });
    refreshMe();
  });
  socket.on('me:changed', refreshMe);
  socket.on('friends:changed', () => { refreshMe(); emitLive('friends', null); });
  socket.on('server:board', () => emitLive('server-board'));
  socket.on('streams', (n) => {
    const changed = state.liveStreams !== n;
    state.liveStreams = Number(n) || 0;
    if (changed) updateNav();
    emitLive('streams', n);
  });
  socket.on('stream:chat', (d) => {
    if (d.user) state.users.set(d.user.id, d.user);
    emitLive('stream:chat', d);
  });
  socket.on('stream:chat:deleted', (d) => emitLive('stream:chat:deleted', d));
  socket.on('sit', (d) => emitLive('sit', d));
  socket.on('sitrooms', () => emitLive('sitrooms'));
  socket.on('config:changed', async (name) => {
    if (name === 'settings') state.settings = await api('settings/public').catch(() => state.settings);
    emitLive('config', name);
  });
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') refreshMe();
  });
}

// ---------- Router ----------
// A new release went live while this tab was open: load it on the next page change, or straight away
// if the tab is in the background (so nobody has to be told to refresh).
let updateWaiting = false;
document.addEventListener('visibilitychange', () => { if (document.hidden && updateWaiting) location.reload(); });
let routeSeq = 0;
async function route() {
  if (updateWaiting) { location.reload(); return; }
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
    streams: async (m, r, alive) => (await import('./streams.js')).viewStreams(m, r, alive),
    leaderboard: viewLeaderboard,
    giveaways: async (m) => (await import('./giveaways.js')).viewGiveaways(m),
    progression: viewTools,
    tools: () => { location.hash = '#/progression'; },
    map: async (m, r, alive) => (await import('./artymap.js')).viewArtyMap(m, r, alive),
    sitrooms: async (m, r, alive) => (await import('./sitroom.js')).viewSitRooms(m, r, alive),
    ranks: viewRanks,
    command: async (m, r, alive) => (await import('./combat.js')).viewCommand(m, r, alive),
    doctrine: async (m, r, alive) => (await import('./combat.js')).viewDoctrine(m, r, alive),
    recruitment: async (m, r, alive) => (await import('./combat.js')).viewRecruitment(m, r, alive),
    u: viewProfile,
    profile: viewEditProfile,
    admin: async (m, r) => (await import('./admin.js')).viewAdmin(m, r),
    discord: async (m) => (await import('./admin.js')).viewDiscordControl(m),
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
  const [ranks, news, members, giveawayLine] = await Promise.all([api('ranks'), api('announcements'), api('members'),
    import('./giveaways.js').then((m) => m.giveawayBanner()).catch(() => '')]);
  const next = ranks.filter((r) => r.auto && r.min_xp > me.xp).sort((a, b) => a.min_xp - b.min_xp)[0];
  const cur = me.rank;
  let progress = '';
  if (isPmc(me)) {
    progress = `<p class="muted small">You're a PMC (guest) — PMCs don't hold a ${esc(state.settings.clan_tag || 'WPG')} rank. You still earn Clan XP (${fmtNum(me.xp)}).</p>`;
  } else if (cur && !cur.auto) {
    progress = '<p class="muted small">Appointed rank — promotions from here are given by command.</p>';
  } else if (next) {
    const base = cur?.auto ? cur.min_xp : 0;
    const pct = Math.max(0, Math.min(100, ((me.xp - base) / (next.min_xp - base)) * 100));
    progress = `<div class="row between small"><span>${fmtNum(me.xp)} Clan XP</span><span class="muted">Next: ${esc(next.name)} at ${fmtNum(next.min_xp)} Clan XP</span></div>
      <div class="xpbar"><div style="width:${pct.toFixed(1)}%"></div></div>`;
  } else {
    progress = '<p class="muted small">Top of the Clan XP ladder. Higher ranks are appointed by command.</p>';
  }
  // In game (from Steam, Wardogs first) and online in the app.
  const inGame = () => members.filter((u) => state.playing[u.id])
    .sort((a, b) => isWardogs(state.playing[b.id]) - isWardogs(state.playing[a.id]) || a.name.localeCompare(b.name));
  const onlineOthers = () => members.filter((u) => u.id !== me.id && state.online.has(u.id) && !state.playing[u.id]);
  const dutyCount = () => inGame().filter((u) => u.id !== me.id).length + onlineOthers().length;
  const onlineHtml = () => {
    const playing = inGame();
    const online = onlineOthers();
    if (!playing.length && !online.length) return '<p class="muted">Nobody else is online right now.</p>';
    const group = (title, list) => (list.length ? `<div class="muted small" style="font:700 12px var(--head);text-transform:uppercase;letter-spacing:1px;margin:4px 0">${title}</div>
      ${list.map((u) => `<a class="item" href="#/u/${u.id}">${userLine(u)}</a>`).join('')}` : '');
    return group('🎮 In game', playing) + group('In the app', online);
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
            <div class="row small" style="margin-top:8px;gap:8px"><span class="pill">${esc(state.settings.clan_tag || 'WPG')} server rank</span>
              ${wpgBadge(state.wpgServer?.level, 30, state.wpgServer?.name)}<b>${esc(wpgRankName(state.wpgServer?.name))}</b><span class="muted">· ${fmtNum(state.wpgServer?.xp || 0)} ${esc(state.settings.clan_tag || 'WPG')} XP${state.wpgServer?.next ? ` · ${esc(wpgToNext(state.wpgServer))}` : ''}</span></div>
            ${state.wpgServer?.next ? `<div style="max-width:520px">${wpgBar(state.wpgServer)}</div>` : ''}
            ${state.settings.welcome_message ? `<p class="muted" style="margin:10px 0 0;max-width:560px">${esc(state.settings.welcome_message)}</p>` : ''}
            <div class="row" style="margin-top:14px"><a class="btn primary" href="#/u/${me.id}">${icon('user')} My career</a><button class="btn" id="syncBtn">${icon('refresh')} Sync stats</button></div>
          </div>
        </div>
      </div>
      ${needsTracker() ? trackerCardHtml() : staleLink() ? staleCardHtml() : ''}
      ${giveawayLine}
      <div class="panel" id="liveNow" hidden></div>
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
          <div class="panel-title">${icon('users')} On duty now <span class="sub" id="onlineCount">${dutyCount()}</span></div>
          <div class="list" id="onlineList">${onlineHtml()}</div>
        </div>
      </div>
      <div class="panel discord-panel" id="voicePanel"><div class="panel-title">${icon('discord')} Discord <span class="sub">comms</span></div><div data-voice></div></div>
    </div>`;
  document.getElementById('syncBtn').onclick = syncMine;
  startVoice(main.querySelector('#voicePanel [data-voice]'), { alive: () => document.body.contains(main.querySelector('#voicePanel')) });
  const redrawDuty = () => {
    const el = document.getElementById('onlineList');
    if (!el) return;
    el.innerHTML = onlineHtml();
    document.getElementById('onlineCount').textContent = dutyCount();
  };
  onLive('presence', redrawDuty);
  onLive('playing', redrawDuty);
  const showLive = () => import('./streams.js').then((m) => m.liveStrip(document.getElementById('liveNow'))).catch(() => {});
  showLive();
  onLive('streams', showLive);
}

async function syncMine(e) {
  const btn = e?.currentTarget;
  if (btn) btn.disabled = true;
  try {
    const r = await api('me/sync', { method: 'POST', body: {} });
    const notes = [];
    if (r.steam && !r.steam.ok) notes.push(`Steam: ${r.steam.reason}`);
    if (r.steam?.private) notes.push('Steam: your game details are private, so playtime cannot be read.');
    if (r.wardogs && !r.wardogs.ok) notes.push(`Wardogs: ${r.wardogs.reason}.`);
    else if (r.wardogs?.state && r.wardogs.state !== 'active') notes.push(`Wardogs: the API reports status “${r.wardogs.state}”.`);
    toast('Stats synced', notes.join(' ') || 'All up to date.');
    await refreshMe();
    route();
  } catch (x) {
    fail(x);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- Wardogs stats ----------
// Fetch stats only from the owner's ID-based API, and credit the source wherever those stats appear.
const TRACKER_URL = 'https://wardogs.tools';
export const trackerCredit = () => `<p class="muted small" style="margin:10px 0 0">Data provided by <a href="${TRACKER_URL}" target="_blank" rel="noopener">wardogs.tools</a>.</p>`;
// Where members (re)link their Wardogs account on wardogs.tools.
const RELINK_URL = 'https://wardogs.tools/account';
const relinkBtn = (cls = 'btn') => `<a class="${cls}" href="${RELINK_URL}" target="_blank" rel="noopener">${icon('refresh')} Relink on wardogs.tools</a>`;
const needsTracker = () => state.realSteam && !state.trackerLinked && !state.trackerRelink;
// wardogs.tools has stopped updating them (its status isn't active, or their linked account can't be found any more).
const staleLink = () => state.trackerRelink; // the server waits a day and never asks mid-game (ranking.js)
function staleCardHtml() {
  const since = state.trackerPolledAt ? ` on ${fmtDate(state.trackerPolledAt)}` : '';
  const why = state.trackerLinked
    ? `wardogs.tools says your account is <b>${esc(state.trackerState)}</b>, so your numbers here are getting old.`
    : "wardogs.tools can't find your Wardogs account any more, so your stats here have stopped.";
  return `<div class="panel glow tracker-card" style="border-color:#f5a524">
    <div class="panel-title" style="margin-bottom:8px;color:#f5a524">${icon('refresh')} Relink your Wardogs account${since && state.trackerLinked ? ` (last read${since})` : ''}</div>
    <p style="margin:0 0 10px">${why} Open <b>wardogs.tools/account</b>, sign in and link your Wardogs account again, then press <b>Check now</b>.</p>
    <p class="muted small" data-tracker-status style="margin:0 0 10px"></p>
    <div class="row">${relinkBtn('btn primary')}<button class="btn" type="button" data-tracker-check>${icon('refresh')} Check now</button></div>
  </div>`;
}
// A slim bar on every page while they need to relink (can be hidden until the next visit).
function renderRelinkBar() {
  const el = document.getElementById('relinkBar');
  if (!el) return;
  let hidden = false;
  try { hidden = sessionStorage.getItem('wpg.relinkHidden') === '1'; } catch { /* storage blocked */ }
  el.innerHTML = state.trackerRelink && !hidden
    ? `<div class="relink-bar tracker-card"><span>${icon('refresh', 'width="16" height="16"')} <b>wardogs.tools has stopped updating your Wardogs stats.</b> Relink your account to keep them up to date.</span>
        <span class="row" style="gap:8px">${relinkBtn('btn small primary')}<button class="btn small" type="button" data-tracker-check>Check now</button><button class="btn small ghost" type="button" data-relink-hide aria-label="Hide">✕</button></span></div>`
    : '';
  el.querySelector('[data-relink-hide]')?.addEventListener('click', () => {
    try { sessionStorage.setItem('wpg.relinkHidden', '1'); } catch { /* storage blocked */ }
    el.innerHTML = '';
  });
}

function trackerCardHtml() {
  const why = { missing: "We couldn't find you on wardogs.tools yet.", unsynced: 'wardogs.tools knows your account but has no stats for you yet.' }[state.trackerState] || '';
  return `<div class="panel glow tracker-card" data-tracker-card>
    <div class="row" style="align-items:flex-start;gap:16px">
      <img src="/img/brand/wolf-emblem.webp" alt="" style="width:74px;border-radius:6px">
      <div class="grow" style="min-width:220px">
        <div class="panel-title" style="margin-bottom:8px">${icon('target')} Show your <span class="sub">Wardogs stats</span></div>
        <p style="margin:0 0 10px">Your Wardog level, cash, gold, account worth, class levels and world rank come from <b>wardogs.tools</b>. The app finds you by your Steam account. One time only:</p>
        <p style="margin:0 0 6px"><b>1.</b> Open wardogs.tools, sign in and <b>link your Wardogs account</b>.</p>
        <p style="margin:0 0 10px"><b>2.</b> Come back and press <b>Check now</b>. After that your stats update by themselves, about 30 minutes after you close Wardogs. Still not found? Add your in-game name with its 4 numbers (Name#1234) in <a href="#/profile/edit">Edit profile</a>.</p>
        ${why ? `<p class="small" style="margin:0 0 10px;color:#f5a524">${why}</p>` : ''}
        <p class="muted small" data-tracker-status style="margin:0 0 10px"></p>
        <div class="row"><a class="btn" href="${TRACKER_URL}" target="_blank" rel="noopener">${icon('target')} Open wardogs.tools</a><button class="btn primary" type="button" data-tracker-check>${icon('refresh')} Check now</button></div>
      </div>
    </div>
  </div>`;
}

// One listener for every "Check now" button, wherever it appears.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-tracker-check]');
  if (!btn) return;
  const status = btn.closest('.tracker-card')?.querySelector('[data-tracker-status]');
  btn.disabled = true;
  if (status) status.textContent = 'Looking…';
  try {
    const r = await api('me/tracker-check', { method: 'POST', body: {} });
    // Found, but wardogs.tools still isn't updating them: the relink hasn't gone through yet.
    if (r.linked && r.state && r.state !== 'active') {
      const msg = `wardogs.tools still says your account is ${r.state}. Relink it at wardogs.tools/account, then check again.`;
      if (status) status.textContent = msg;
      else toast('Not updating yet', msg);
      return;
    }
    if (r.linked) {
      toast('Wardogs stats found!', 'Your global stats are on your career profile now.', { link: `#/u/${state.me.id}` });
      await refreshMe();
      route();
      return;
    }
    if (status) status.textContent = r.reason || 'No stats were returned for your Steam ID.';
    else toast('Not found yet', r.reason || '');
  } catch (x) {
    if (status) status.textContent = x.status === 429 ? 'Wait a few seconds, then try again.' : x.message;
    else fail(x);
  } finally {
    btn.disabled = false;
  }
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
function tile(ic, label, value, cls = '', extra = '') {
  // ic: an icon name, or a ready-made badge (SVG). extra: HTML under the value (e.g. a progress bar).
  return `<div class="tile"><div class="ic">${String(ic).startsWith('<') ? ic : icon(ic)}</div><div class="grow"><div class="lbl">${esc(label)}</div><div class="val ${cls}">${esc(value)}</div>${extra}</div></div>`;
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
  if (id === 'me') id = state.me.id;
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

  // Steam friends: Steam doesn't let other sites send friend requests, so these hand over to Steam. "Add on Steam"
  // only shows for members who added their own Steam quick invite link (Edit profile): it opens their personal
  // add-friend page. Everyone with a Steam account also shows "Steam profile" and their friend code
  // (Steam → Add a Friend → enter the code).
  const hasSteam = !mine && u.steam_add_button !== false && /^\d{17}$/.test(u.steam_id || '');
  const code = hasSteam ? String(BigInt(u.steam_id) - 76561197960265728n) : '';
  const steamBtns = hasSteam
    ? `${u.steam_invite ? `<a class="btn" href="${esc(u.steam_invite)}" target="_blank" rel="noopener" title="Their own Steam invite link: press Add friend there">${icon('friends')} Add on Steam</a>` : ''}<a class="btn ghost" href="https://steamcommunity.com/profiles/${u.steam_id}" target="_blank" rel="noopener" title="Their Steam profile: press Add Friend there">Steam profile</a>
      <button type="button" class="btn ghost" data-copy="${code}" title="In Steam: Friends → Add a Friend → type this code">Friend code ${code}</button>`
    : '';
  const friendBtn = mine ? '' : {
    none: u.friend_requests === false ? '<span class="btn ghost" style="cursor:default;opacity:.7" title="They switched off friend requests">Not taking friend requests</span>' : `<button class="btn" data-friend="add">${icon('friends')} Add friend</button>`,
    outgoing: `<button class="btn ghost" data-friend="remove">Request sent · Cancel</button>`,
    incoming: `<button class="btn primary" data-friend="add">${icon('friends')} Accept friend</button>`,
    friends: `<button class="btn ghost" data-friend="remove">Friends ✓ · Remove</button>`,
  }[p.friend];

  // The API supplies one overall position, not separate XP and cash ranks.
  const wr = p.wardogs.ranks;
  const rankPosition = wr?.position ?? wr?.level;
  const worldRanksHtml = rankPosition ? `<div class="tiles" style="margin-bottom:12px">
      ${tile('trophy', 'Global rank', `#${fmtNum(rankPosition)}${wr?.total ? ` of ${fmtNum(wr.total)}` : ''}`, '',
    `${wr?.bracket ? `<div class="small muted">Top ${fmtNum(wr.bracket)}%</div>` : ''}${wr?.change?.places !== null && wr?.change?.places !== undefined ? `<div class="small muted">Change: ${fmtNum(wr.change.places)} places</div>` : ''}`)}
    </div>` : '';

  let officialHtml;
  if (off) {
    const rank = (n) => { const i = ROLE_ORDER.indexOf(n.toLowerCase()); return i < 0 ? 99 : i; };
    const roles = Object.entries(off.roles || {}).sort(([a], [b]) => rank(a) - rank(b));
    officialHtml = `${worldRanksHtml}
      <div class="tiles">
        ${tile('chevrons', 'Wardog level', off.wardogLevel === null || off.wardogLevel === undefined ? '—' : fmtNum(off.wardogLevel))}
        ${off.careerXp !== null && off.careerXp !== undefined ? tile('xp', 'Total XP', fmtNum(off.careerXp)) : ''}
        ${tile('coins', 'Cash on hand', off.cash === null || off.cash === undefined ? '—' : fmtMoney(off.cash))}
        ${(off.worth ?? off.accountWorth) !== null && (off.worth ?? off.accountWorth) !== undefined ? tile('growth', 'Account worth', fmtMoney(off.worth ?? off.accountWorth)) : ''}
        ${tile('gold', 'Gold', off.gold === null || off.gold === undefined ? '—' : fmtNum(off.gold))}
        ${tile('unlock', 'Unlocks', off.unlocks === null || off.unlocks === undefined ? '—' : fmtNum(off.unlocks))}
        ${off.rates?.xpPerMinute !== null && off.rates?.xpPerMinute !== undefined ? tile('xp', 'XP per minute', fmtNum(off.rates.xpPerMinute)) : ''}
        ${off.rates?.cashPerMinute !== null && off.rates?.cashPerMinute !== undefined ? tile('coins', 'Cash per minute', fmtNum(off.rates.cashPerMinute)) : ''}
      </div>
      ${roles.length ? `<h4 style="margin:18px 0 10px" class="row">${icon('chevrons', 'width="18" height="18" style="color:var(--gold)"')} Role progression</h4>
      <div class="roles">${roles.map(([name, r]) => {
        const [c, ic, art] = ROLE_STYLE[name.toLowerCase()] || ['#29b6f6', 'star', ''];
        const pic = art ? `<img class="art" src="/img/brand/roles/${art}.webp" alt="" loading="lazy">` : `<div style="padding-top:10px">${icon(ic)}</div>`;
        const level = r?.level ?? (typeof r === 'number' ? r : null);
        const lvl = Number(level) || 0;
        return `<div class="role-card" style="--rc:${c}">${pic}<div class="rn">${esc(name)}</div><div class="rl">${level === null ? '—' : fmtNum(lvl)}</div>${r?.xp !== null && r?.xp !== undefined ? `<div class="muted small">${fmtNum(r.xp)} XP</div>` : ''}${level === null ? '' : unlockLinesHtml(unlockList, name.toLowerCase(), lvl)}</div>`;
      }).join('')}</div>` : ''}
      ${off.wardogLevel === null || off.wardogLevel === undefined ? '' : careerUnlockHtml(unlockList, Number(off.wardogLevel) || 0)}`;
  } else {
    officialHtml = worldRanksHtml + (mine && state.realSteam
      ? `<p class="muted" style="margin-top:0">No global Wardogs stats yet.</p>${trackerCardHtml()}`
      : '<p class="muted">No global Wardogs stats were returned for this player.</p>');
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
          ${u.frame ? `<span class="av-wrap framed lg" title="${esc(u.frame.name)} frame"><img class="avatar lg" src="${esc(u.avatar || '/img/icon-192.png')}" alt="" referrerpolicy="no-referrer">${frameSVG(u.frame)}</span>` : `<img class="avatar lg" src="${esc(u.avatar || '/img/icon-192.png')}" alt="" referrerpolicy="no-referrer">`}
          <div class="who">
            <div class="pname">${esc(u.name)} ${flag(u.country)}</div>
            ${u.callsign ? `<div class="accent">“${esc(u.callsign)}”</div>` : ''}
            <div class="row" style="margin-top:6px">${rolePill(u)} ${playingTag(u)} <span class="muted small">${state.online.has(u.id) ? '<span style="color:var(--green)">● Online</span>' : `Last seen ${timeAgo(u.last_seen)}`} · Joined ${fmtDate(u.joined_at)}</span></div>
            ${customFields ? `<div class="row" style="margin-top:8px">${customFields}</div>` : ''}
            <div id="showcaseBox"></div>
            ${p.combat?.unit ? `<div class="row" style="margin-top:8px;gap:8px"><a href="#/command" class="pill" style="color:${esc(p.combat.unit.color)};border-color:${esc(p.combat.unit.color)}">${icon('shield', 'width="12" height="12" style="vertical-align:-1px"')} ${esc(p.combat.unit.name)}</a><b style="font:700 15px var(--head);text-transform:uppercase">${esc(p.combat.role)}</b><span class="muted small">${esc(p.combat.unit.label)}</span></div>` : ''}
          </div>
          <div style="text-align:center">${badgeFor(u, 88)}<div style="font:700 15px var(--head);text-transform:uppercase">${esc(isPmc(u) ? 'PMC' : u.rank ? u.rank.name : 'Unranked')}</div></div>
        </div>
        ${u.bio ? `<p style="white-space:pre-wrap;margin:14px 0 0">${esc(u.bio)}</p>` : ''}
        ${mine && inviteDaysLeft(state.me) !== null && inviteDaysLeft(state.me) <= 3 ? `<p class="small" style="margin:12px 0 0;padding:8px 10px;border:1px solid var(--line);border-radius:8px">⚠️ ${inviteDaysLeft(state.me) <= 0 ? 'Your Steam invite link has run out, so <b>Add on Steam</b> is hidden on your profile.' : `Your Steam invite link runs out in <b>${inviteDaysLeft(state.me)} day${inviteDaysLeft(state.me) === 1 ? '' : 's'}</b>.`} <a href="#/profile/edit">Paste a fresh one</a> (Steam → Friends → Add a Friend).</p>` : ''}
        <div class="row" style="margin-top:14px">
          ${mine ? `<a class="btn" href="#/profile/edit">${icon('edit')} Edit profile</a><button class="btn" id="syncBtn">${icon('refresh')} Sync stats</button>` : `<a class="btn primary" href="#/messages/${u.id}">${icon('mail')} Message</a>${friendBtn}${steamBtns}`}
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
            ${p.combat?.unit ? tile('shield', 'Unit', p.combat.unit.name) + tile('chevrons', 'Role', p.combat.role, 'fit') : ''}
          </div>
          ${u.skills?.length ? `<div class="profile-skills"><div class="lbl">${icon('target')} Skills</div><div class="row" style="gap:6px">${u.skills.map((s) => `<span class="pill">${esc(s)}</span>`).join('')}</div></div>` : ''}
        </div>
      </div>
      <div id="combatBox"></div>

      <div class="grid two">
        <div class="panel">
          <div class="panel-title">${icon('target')} Wardogs <span class="sub">(global stats)</span></div>
          ${off && wr?.polled_at ? `<p class="small" style="margin:-4px 0 10px;color:${wr.state && wr.state !== 'active' ? '#f5a524' : 'var(--muted)'}">Last polled ${esc(fmtDate(wr.polled_at))} ${esc(new Date(wr.polled_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}${wr.state ? ` · ${esc(wr.state)}` : ''}</p>` : ''}
          ${mine && staleLink() ? `<p class="small" style="margin:0 0 10px;color:#f5a524">${icon('refresh', 'width="14" height="14" style="vertical-align:-2px"')} wardogs.tools has stopped updating your stats: relink your account, then press Check now.</p>` : ''}
          ${officialHtml}
          ${off || wr?.position || wr?.level ? trackerCredit() : ''}
          ${mine && state.realSteam ? `<div class="row tracker-card" style="margin-top:10px;gap:8px">${relinkBtn(staleLink() ? 'btn small primary' : 'btn small')}<button class="btn small" type="button" data-tracker-check>${icon('refresh')} Check now</button><span class="muted small" data-tracker-status></span></div>` : ''}
        </div>
        <div class="panel">
          <div class="panel-title">${icon('chevrons')} ${esc(state.settings.clan_tag || 'WPG')} Server <span class="sub">(private server)</span></div>
          <div class="tiles">
            ${tile(wpgBadge(p.wpg_server?.level, 34, p.wpg_server?.name), `${state.settings.clan_tag || 'WPG'} rank`, wpgRankName(p.wpg_server?.name), '', p.wpg_server?.next
              ? `<div class="tile-progress">${wpgBar(p.wpg_server)}<div class="small muted" title="${esc(wpgToNext(p.wpg_server))}">${fmtNum(p.wpg_server.xp || 0)} / ${fmtNum(p.wpg_server.next.xp)} XP</div></div>`
              : '')}
            ${tile('star', `${state.settings.clan_tag || 'WPG'} XP`, fmtNum(p.wpg_server?.xp || 0))}
            ${tile('trophy', 'Server position', p.wpg_server?.position ? `#${fmtNum(p.wpg_server.position)}` : '—')}
            ${p.wpg_server?.next ? tile('chevrons', `Next rank in ${fmtNum(Math.max(0, p.wpg_server.next.xp - (p.wpg_server.xp || 0)))} XP`, wpgRankName(p.wpg_server.next.name)) : ''}
            ${tile('shield', 'Clan rank', isPmc(u) ? 'PMC — no rank' : u.rank ? u.rank.name : '—', isPmc(u) ? 'pmc' : '')}
            ${tile('xp', 'Clan XP', fmtNum(u.xp))}
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
          ${p.wardogs.server_synced ? `<div class="credit">Kills from the WPG server · updated ${timeAgo(p.wardogs.server_synced)}</div>` : ''}
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
            <div class="rack-item" title="${esc(`${a.name} — ${a.description}${a.rarity ? ` · ${a.rarity[0].toUpperCase()}${a.rarity.slice(1)}` : ''}${a.reason && a.reason !== 'Earned automatically' ? ` (${a.reason})` : ''} · ${fmtDate(a.given_at)}`)}"${a.rarity ? ` style="box-shadow:inset 0 -2px 0 ${RARITY_COLORS[a.rarity] || 'transparent'}"` : ''}>
              ${ribbon(a.colors)}<b>${esc(a.name)}</b><span class="muted small">${a.rarity ? `<span style="color:${RARITY_COLORS[a.rarity] || 'inherit'}">${esc(a.rarity[0].toUpperCase() + a.rarity.slice(1))}</span> · ` : ''}${fmtDate(a.given_at)}</span></div>`).join('')}</div>` : `<p class="muted">${p.medals?.length ? 'No WPG medals yet.' : 'No medals yet.'}</p>`}
          ${p.awards.some((a) => /^(class|career):/i.test(a.auto_rule || '')) ? `<p class="muted small" style="margin:8px 0 0">Class and career level medals use stats provided by <a href="${TRACKER_URL}" target="_blank" rel="noopener">wardogs.tools</a>.</p>` : ''}
          ${steamMedalsHtml(p.medals || [])}
        </div>
      </div>
      <div id="liveBox"></div>
      <div id="badgesBox"></div>
      <div id="framesBox"></div>
    </div>`;

  document.getElementById('syncBtn')?.addEventListener('click', syncMine);
  main.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Friend code copied', 'In Steam: Friends → Add a Friend → paste it.'), () => {});
  });
  main.querySelectorAll('[data-friend]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`friends/${u.id}`, { method: b.dataset.friend === 'add' ? 'POST' : 'DELETE', body: b.dataset.friend === 'add' ? {} : undefined });
        route();
      } catch (x) { fail(x); }
    };
  });
  onLive('me', () => { if (mine) route(); });
  // Live match money from Steam (switched on by the member).
  import('./live.js').then((m) => {
    const box = document.getElementById('liveBox');
    if (box) m.profileLivePanel(box, u);
  }).catch(() => {});
  // Badge collection (and the badges they showcase under their name).
  import('./badges.js').then((m) => {
    const box = document.getElementById('badgesBox');
    if (box) m.profileBadgesPanel(box, u, document.getElementById('showcaseBox'));
  }).catch(() => {});
  // Profile frames: what they've unlocked, progress on the rest, and (on your own) which one to show.
  import('./frames.js').then((m) => {
    const box = document.getElementById('framesBox');
    if (box) m.profileFramesPanel(box, u);
  }).catch(() => {});
  // Combat Command posting and roles (the server only sends them to WPG members and staff).
  if (p.combat) {
    import('./combat.js').then((m) => {
      const box = document.getElementById('combatBox');
      if (box) box.innerHTML = m.profileCombatHtml(p.combat);
    }).catch(() => {});
  }
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

const RARITY_COLORS = { common: '#b8c4d0', uncommon: '#3ddc84', rare: '#29b6f6', epic: '#b05cff', legendary: '#f5a524', mythic: '#ff4d6d', exclusive: '#ffe066' };
// Steam quick invite links last 30 days (server/steaminvite.js): how long a member's has left.
function inviteDaysLeft(u) {
  if (!u?.steam_invite_at) return null;
  return Math.ceil((new Date(u.steam_invite_at).getTime() + 30 * 86400e3 - Date.now()) / 86400e3);
}
function inviteNote(u) {
  const left = inviteDaysLeft(u);
  if (left === null) return '';
  if (left <= 0) return ' <b style="color:var(--red)">Your link has run out: paste a new one.</b>';
  return left <= 3 ? ` <b style="color:var(--amber, #f5a524)">Your link runs out in ${left} day${left === 1 ? '' : 's'}: paste a fresh one.</b>` : ` Yours runs out in ${left} days.`;
}
export function ribbon(colors) {
  const list = String(colors || '#888888').split(',').map((c) => (/^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : '#888888'));
  const step = 100 / list.length;
  const stops = list.map((c, i) => `${c} ${(i * step).toFixed(1)}% ${((i + 1) * step).toFixed(1)}%`).join(', ');
  return `<span class="ribbon" style="background:linear-gradient(90deg, ${stops})"></span>`;
}

// ---------- Edit profile ----------
async function viewEditProfile(main) {
  const [fields, sk] = await Promise.all([api('profile-fields'), api('me/skills').catch(() => ({ list: [], suggested: [] }))]);
  const u = state.me;
  // Skills: theirs, or (until they pick their own) the ones from their last recruitment application.
  const fromApp = !u.skills?.length && sk.suggested.length > 0;
  const ticked = new Set(fromApp ? sk.suggested : u.skills || []);
  const skillList = [...sk.list, ...[...ticked].filter((s) => !sk.list.includes(s))];
  main.innerHTML = `
    <h1>Edit profile</h1>
    <form class="panel stack" id="pf">
      <p class="muted">Your name and picture come from Steam (<b>${esc(u.name)}</b>). They update each time you sign in.</p>
      <div class="form-grid">
        <label class="field"><span>Callsign / nickname</span><input type="text" name="callsign" maxlength="40" value="${esc(u.callsign)}"></label>
        <label class="field"><span>Country</span><select name="country">${COUNTRIES.map(([c, n]) => `<option value="${c}" ${u.country === c ? 'selected' : ''}>${flag(c)} ${n}</option>`).join('')}</select></label>
        ${fields.map((f) => `<label class="field"><span>${esc(f.label)}</span>${f.type === 'select'
          ? `<select name="cf_${esc(f.key)}"><option value="">—</option>${f.options.split(',').map((o) => o.trim()).filter(Boolean).map((o) => `<option ${u.custom_fields?.[f.key] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
          : `<input type="text" name="cf_${esc(f.key)}" maxlength="200" value="${esc(u.custom_fields?.[f.key] || '')}"${f.key === 'wardogs_name' ? ' placeholder="Name#1234"' : ''}>`}${f.key === 'wardogs_name'
          ? `<small class="muted">Only needed if wardogs.tools can't find you by your Steam account: your in-game name with its 4 numbers.</small>` : ''}</label>`).join('')}
      </div>
      <label class="field"><span>About me</span><textarea name="bio" maxlength="1000">${esc(u.bio)}</textarea></label>
      ${skillList.length ? `<div class="field"><span style="display:block;font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">My skills <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">— shown on your profile (tick any)</span></span>
        ${fromApp ? '<p class="small muted" style="margin:0 0 6px">Ticked from your recruitment application. Change them if you like, then save.</p>' : ''}
        <div class="cc-skills">${skillList.map((s) => `<label class="check small"><input type="checkbox" name="skills" value="${esc(s)}"${ticked.has(s) ? ' checked' : ''}> ${esc(s)}</label>`).join('')}</div></div>` : ''}
      <div class="form-grid">
        <label class="field"><span>Custom picture link (optional, https)</span><input type="url" name="custom_avatar" value="${esc(u.avatar && !u.avatar.includes('steamstatic') ? u.avatar : '')}" placeholder="Leave empty to use your Steam picture"></label>
        <label class="field"><span>Banner colour</span><input type="color" name="banner_color" value="${esc(u.banner_color || '#0d2238')}"></label>
      </div>
      <div class="field"><span style="display:block;font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Friend requests</span>
        <label class="check small"><input type="checkbox" name="friend_requests" ${u.friend_requests !== false ? 'checked' : ''}> Members can send me friend requests in the app</label>
        <label class="check small"><input type="checkbox" name="steam_add_button" ${u.steam_add_button !== false ? 'checked' : ''}> Show the Add on Steam and Steam profile buttons on my profile</label>
        <label class="field" style="margin-top:8px"><span>My Steam quick invite link (for the Add on Steam button)</span><input type="url" name="steam_invite" maxlength="200" value="${esc(u.steam_invite || '')}" placeholder="https://s.team/p/xxxx-xxxx/XXXXXXXX">
          <small class="muted">In Steam: <b>Friends → Add a Friend</b>, then copy your <b>Quick Invite link</b>. An <b>Add on Steam</b> button then shows on your profile and takes people straight to your own add-friend page (it only shows once you've added your link). Steam's links last <b>30 days</b>: you'll get a reminder from day 27 to paste a fresh one.${inviteNote(u)}${/^\d{17}$/.test(u.steam_id || '') ? ` Your friend code is <b>${String(BigInt(u.steam_id) - 76561197960265728n)}</b>.` : ''}</small></label></div>
      <div class="row"><button class="btn primary">Save profile</button><a class="btn ghost" href="#/u/${u.id}">Cancel</a></div>
    </form>
    <form class="panel stack" id="dlink" style="margin-top:16px">
      <div class="panel-title" style="margin:0">${icon('discord')} Discord <span class="sub">Barracks bot</span></div>
      ${state.discordLinked
        ? `<p style="margin:0">✅ Your Discord is linked. In Discord, <b>/stats</b>, <b>/rank</b>, <b>/medals</b> and the other commands show your stats.</p>
           <div class="row"><button type="button" class="btn ghost" id="dunlink">Unlink Discord</button></div>`
        : `<p style="margin:0">Link once so the Barracks bot in Discord knows who you are. In Discord, type <b>/link</b>. The bot gives you a code — type it here.</p>
           <div class="row"><input type="text" name="code" maxlength="12" placeholder="Code from /link" class="grow" style="min-width:140px;text-transform:uppercase"><button class="btn primary">${icon('discord')} Link</button></div>`}
    </form>
    <div class="panel stack" id="streams" style="margin-top:16px"><div class="spinner"></div></div>`;
  import('./streams.js').then(async (m) => {
    const el = document.getElementById('streams');
    if (!el) return;
    await m.myStreamsPanel(el);
    if (location.hash.endsWith('#streams')) el.scrollIntoView({ behavior: 'smooth' });
  }).catch((x) => { const el = document.getElementById('streams'); if (el) el.innerHTML = `<p class="muted small">${esc(x.message)}</p>`; });
  document.getElementById('dlink').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('me/discord-link', { method: 'POST', body: { code: e.target.code.value } });
      toast('Discord linked', r.discord_name ? `Linked to ${r.discord_name}.` : 'All set.');
      await refreshMe();
      route();
    } catch (x) { fail(x); }
  };
  document.getElementById('dunlink')?.addEventListener('click', async () => {
    if (!(await confirmBox('Unlink your Discord from the Barracks app?'))) return;
    try { await api('me/discord-link', { method: 'DELETE' }); await refreshMe(); route(); } catch (x) { fail(x); }
  });
  document.getElementById('pf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const custom = {};
    for (const fd of fields) custom[fd.key] = f[`cf_${fd.key}`]?.value || '';
    try {
      const skills = [...f.querySelectorAll('[name=skills]:checked')].map((x) => x.value);
      await api('me/profile', { method: 'PUT', body: { callsign: f.callsign.value, country: f.country.value, bio: f.bio.value, custom_avatar: f.custom_avatar.value, banner_color: f.banner_color.value, custom_fields: custom, skills, friend_requests: f.friend_requests.checked, steam_add_button: f.steam_add_button.checked, steam_invite: f.steam_invite.value } });
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
      <div><a class="who" href="#/u/${u.id}" style="color:${isPmc(u) ? '#ffb347' : esc(u.rank?.color || 'var(--text)')}">${isPmc(u) ? '[PMC] ' : u.rank ? `[${esc(u.rank.abbr)}] ` : ''}${esc(u.name)}</a>${u.developer ? ' <span class="pill dev">Creator</span>' : ''}<span class="time">${fmtTime(m.created_at)}</span></div>
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
      <a class="item" href="#/u/${u.id}"><div class="grow">${userLine(u, `${fmtNum(u.xp)} Clan XP`)}</div>${flag(u.country)}</a>`).join('') : '<p class="empty">No members found.</p>';
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
      <div class="field"><span style="display:block;font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;margin-bottom:6px">Game mode + modifications</span><div id="modeList" class="stack"></div></div>
      <label class="field"><span>Time of day</span><select name="lighting"><option value="">Server default</option></select></label>
      <label class="field"><span>Control zone</span><select name="alternator"><option value="">Server default</option></select></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn" value="queue">Queue as next map</button><button type="submit" class="btn primary" value="now">Change map now</button></div>
      <p class="muted small" style="margin:0">Queue = plays after this match ends, then the normal rotation carries on.</p>
    </form>`;
  const form = body.querySelector('#mapForm');
  form.querySelector('[data-close]').onclick = m.close;
  const modeList = form.querySelector('#modeList');
  const fill = (sel, ids, label = (x) => x) => {
    sel.innerHTML = `<option value="">Server default</option>${ids.map((x) => `<option value="${esc(x)}">${esc(label(x))}</option>`).join('')}`;
  };
  api(`admin/servers/${sid}/lightings`).then((l) => fill(form.lighting, l, (x) => x.replace(/([a-z])([A-Z])/g, '$1 $2'))).catch(() => {});
  const loadModes = async () => {
    api(`admin/servers/${sid}/maps/${encodeURIComponent(form.map.value)}/zones`)
      .then((z) => fill(form.alternator, z, (x) => x.replace(/^ZoneAlternator\.[^.]+\./, '').replace(/\./g, ' · ')))
      .catch(() => fill(form.alternator, []));
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
    const queue = e.submitter?.value === 'queue';
    act(sid, { action: queue ? 'queue' : 'map', map: form.map.value, experiences, lighting: form.lighting.value, alternator: form.alternator.value },
      queue ? `${name} is queued as the next map.` : `Changing map to ${name}.`);
  };
}

// Small picker box: pick one option from a list. Resolves to the value, or null if cancelled.
function pickBox(title, label, options, okLabel) {
  return new Promise((resolve) => {
    const m = modal(`<form class="stack"><h2 style="margin:0">${esc(title)}</h2>
      <label class="field"><span>${esc(label)}</span><select name="v">${options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${esc(okLabel)}</button></div></form>`);
    const f = m.el.querySelector('form');
    f.querySelector('[data-close]').onclick = () => { m.close(); resolve(null); };
    f.onsubmit = (e) => { e.preventDefault(); const v = f.v.value; m.close(); resolve(v); };
  });
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
  // Controls a server's version of Wardogs doesn't have (from its capabilities list) are hidden.
  const unsupported = new Map();
  const hideUnsupported = (sid) => {
    const off = unsupported.get(String(sid)) || [];
    main.querySelectorAll(`[data-act][data-sid="${sid}"]`).forEach((b) => { b.hidden = off.includes(b.dataset.act); });
    const bc = main.querySelector(`[data-broadcast="${sid}"]`);
    if (bc) bc.hidden = off.includes('broadcast');
  };
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
        ${s.has_rcon && staff ? `<div data-killfeed="${s.id}" hidden></div>` : ''}
        ${s.has_rcon ? `<div style="margin-top:18px"><h4 class="row" style="margin:0 0 8px">${icon('users', 'width="18" height="18"')} On the server now</h4><div class="list" data-players="${s.id}"><div class="spinner" style="margin:10px auto"></div></div></div>` : ''}
        ${admin ? controlsHtml(s) : ''}
      </div>`;
  };

  const controlsHtml = (s) => {
    if (!s.has_rcon) {
      return `<div class="row" style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
        <p class="muted small grow" style="margin:0">${icon('shield', 'width="14" height="14"')} ${admin
          ? 'Add this server\'s RCON address and password to control it from here.'
          : 'An admin can add this server\'s RCON details so admins can control it from here.'}</p>
        ${admin ? `<button class="btn small primary" data-settings="${s.id}">${icon('settings')} Add RCON details</button>` : ''}</div>`;
    }
    return `
      <div style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px" class="stack">
        <div class="row between"><h4 class="row" style="margin:0">${icon('shield', 'width="18" height="18" style="color:var(--gold)"')} Server controls</h4>
          ${admin ? `<button class="btn small" data-settings="${s.id}">${icon('settings')} Server settings</button>` : ''}</div>
        ${admin ? `<div class="small muted" data-tools="${s.id}">Checking the server…</div>` : ''}
        <form class="row" data-broadcast="${s.id}"><input type="text" name="message" class="grow" maxlength="256" placeholder="Message everyone on the server" style="min-width:180px"><button class="btn">${icon('megaphone')} Broadcast</button></form>
        ${admin ? `
        <div class="row">
          <button class="btn" data-act="map" data-sid="${s.id}">${icon('target')} Override map</button>
          <button class="btn danger" data-act="end" data-sid="${s.id}">Force end match</button>
          <button class="btn" data-act="restart" data-sid="${s.id}">${icon('refresh')} Restart match</button>
          <button class="btn" data-act="next" data-sid="${s.id}">Force next map</button>
          <button class="btn" data-act="lighting" data-sid="${s.id}">Time of day</button>
          <button class="btn ghost" data-act="unban" data-sid="${s.id}">Unban a Steam ID</button>
        </div>
        <div class="row">
          <button class="btn" data-tool="reserved" data-sid="${s.id}">${icon('star')} Reserved slots</button>
          <button class="btn" data-tool="log" data-sid="${s.id}">${icon('chart')} Server action log</button>
          <button class="btn" data-tool="banner" data-sid="${s.id}">${icon('server')} Server banner</button>
        </div>` : ''}
      </div>`;
  };

  main.innerHTML = `<div class="row between"><h1>Servers</h1><div class="row">
      ${admin ? `<button class="btn primary" id="srvAdd">${icon('plus')} Add server</button>` : ''}
      <button class="btn ghost" id="srvReport" title="Report a suspected cheater to staff">${icon('shield')} Report a player</button>
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
          ${admin && p.steamId ? `<div class="row">
            <button class="btn small" data-act="whisper" data-sid="${s.id}" data-steam="${esc(p.steamId)}" data-name="${esc(p.name)}">Whisper</button>
            <button class="btn small" data-act="faction" data-sid="${s.id}" data-steam="${esc(p.steamId)}" data-name="${esc(p.name)}">Move</button>
            <button class="btn small" data-act="kick" data-sid="${s.id}" data-steam="${esc(p.steamId)}" data-name="${esc(p.name)}">Kick</button>
            <button class="btn small ghost" data-act="kill" data-sid="${s.id}" data-steam="${esc(p.steamId)}" data-name="${esc(p.name)}">Kill</button>
            ${admin ? `<button class="btn small danger" data-act="ban" data-sid="${s.id}" data-steam="${esc(p.steamId)}" data-name="${esc(p.name)}">Ban</button>` : ''}
          </div>` : ''}
          ${p.steamId && !admin ? `<button class="btn small ghost" data-report="${esc(p.steamId)}" data-name="${esc(p.name)}" title="Report a suspected cheater to staff">Report</button>` : ''}
        </div>`).join('') : '<p class="muted">Nobody on right now.</p>';
      hideUnsupported(s.id);
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
        ${m.next ? `<p class="muted small row" style="margin:10px 0 0">Next map: <b style="color:var(--text)">${esc(m.next.map)}</b>${m.next.mode ? ` · ${esc(m.next.mode)}` : ''}${m.next.lighting ? ` · ${esc(m.next.lighting)}` : ''}${m.next.zone ? ` · ${esc(m.next.zone)}` : ''}${m.queued ? ' <span class="accent">(queued)</span>' : ''}
          ${m.queued && admin ? `<button class="btn small ghost" data-act="unqueue" data-sid="${s.id}">Cancel queue</button>` : ''}</p>` : ''}
        ${m.last ? `<p class="muted small" style="margin:6px 0 0">Last match: ${m.last.finished === true
          ? `<b style="color:var(--text)">${esc(m.last.winner || 'a team')}</b> won (${fmtNum(m.last.best)} of ${fmtNum(m.last.cap)})`
          : m.last.finished === false ? 'ended early (stopped, restarted or skipped by staff)'
            : m.last.winner ? `<b style="color:var(--text)">${esc(m.last.winner)}</b> had the top score (${fmtNum(m.last.best)})` : 'no winner'}${m.last.seconds ? ` · ${Math.round(m.last.seconds / 60)} min` : ''} · ${esc(timeAgo(m.last.at))}</p>` : ''}`;
    } catch (e) {
      box.innerHTML = staff ? `<p class="muted small">Live match unavailable: ${esc(e.message)}</p>` : '';
    }
  }
  servers.filter((s) => s.has_rcon).forEach(loadLive);

  // Admins: server health, version and which controls this server's build has (others are hidden).
  async function loadTools(s) {
    const box = main.querySelector(`[data-tools="${s.id}"]`);
    if (!box) return;
    try {
      const t = await api(`admin/servers/${s.id}/tools`);
      if (!alive()) return;
      unsupported.set(String(s.id), t.unsupported || []);
      hideUnsupported(s.id);
      const h = t.health;
      const up = h?.uptime ? `up ${h.uptime >= 86400 ? `${Math.floor(h.uptime / 86400)}d ` : ''}${Math.floor((h.uptime % 86400) / 3600)}h` : '';
      const busy = h?.ok && (h.queue > 0 || h.rejected > 0);
      const dot = !h ? '' : !h.ok ? 'var(--red)' : busy ? '#f5a524' : 'var(--green)';
      box.innerHTML = `${dot ? `<span style="color:${dot}">●</span> ` : ''}${!h ? 'RCON connected (this server version has no health check)'
        : !h.ok ? `RCON not answering: ${esc(h.error)}`
          : `RCON ${busy ? `busy (${fmtNum(h.queue)} waiting${h.rejected ? `, ${fmtNum(h.rejected)} turned away` : ''})` : 'healthy'}${up ? ` · ${up}` : ''} · ${fmtNum(h.connections)} connection${h.connections === 1 ? '' : 's'}`}
        ${t.build ? ` · build ${esc(t.build.replace(/^\+\+Wardogs\+Live-/, ''))}` : ''}${t.server_id ? ` · host ID ${esc(t.server_id)}` : ''}
        ${t.unsupported?.length ? ` · <span title="${esc(t.unsupported.join(', '))}">${t.unsupported.length} control${t.unsupported.length === 1 ? '' : 's'} hidden (not in this server version)</span>` : ''}`;
    } catch (e) {
      box.innerHTML = `<span style="color:var(--red)">●</span> ${esc(e.message)}`;
    }
  }
  if (admin) servers.filter((s) => s.has_rcon).forEach(loadTools);

  // Staff: the live kill feed from the game server (who killed whom, weapon, distance, headshot), updating as kills arrive.
  if (staff) {
    const killLine = (k) => `<div class="kf-line"><span class="muted">${esc(new Date(k.at).toLocaleTimeString('en-GB'))}</span>
      <b class="kf-name">${k.killer.user ? `<a href="#/u/${k.killer.user}">${esc(k.killer.name)}</a>` : esc(k.killer.name)}</b>
      <span class="kf-how">${esc(k.weapon || '?')}${k.distance !== null ? ` · ${fmtNum(k.distance)} m` : ''}${k.headshot ? ' · <span class="kf-hs">headshot</span>' : ''}</span>
      <span class="muted">→</span> <span class="kf-name">${k.victim.user ? `<a href="#/u/${k.victim.user}">${esc(k.victim.name)}</a>` : esc(k.victim.name)}</span></div>`;
    api('admin/cheat/killfeed?limit=40').then((f) => {
      if (!alive()) return;
      const box = main.querySelector(`[data-killfeed="${f.server_id}"]`);
      if (!box) return;
      box.hidden = false;
      box.innerHTML = `<div style="margin-top:18px"><h4 class="row" style="margin:0 0 8px">${icon('crosshair', 'width="18" height="18"')} Live kill feed <span class="muted small">· staff only</span></h4>
        <div class="kf-list" data-kflist>${f.events.length ? f.events.map(killLine).join('') : `<p class="muted small" style="margin:0">${f.connected ? 'Waiting for kills…' : 'The kill feed isn\'t connected yet (Admin → Cheat watch → Connect kill feed).'}</p>`}</div></div>`;
      const list = box.querySelector('[data-kflist]');
      onLive('killfeed', (evs) => {
        if (list.querySelector('p')) list.innerHTML = '';
        list.insertAdjacentHTML('afterbegin', evs.slice().reverse().map(killLine).join(''));
        while (list.children.length > 60) list.lastElementChild.remove();
      });
    }).catch(() => {});
  }

  async function act(sid, body, done) {
    try {
      await api(`admin/servers/${sid}/action`, { method: 'POST', body });
      toast('Done', done);
      const s = servers.find((x) => x.id === Number(sid));
      if (s) { loadPlayers(s); loadLive(s); }
    } catch (x) { fail(x); }
  }

  main.onclick = async (e) => {
    const toolBtn = e.target.closest('[data-tool]');
    if (toolBtn) {
      const m = await import('./servertools.js');
      m[toolBtn.dataset.tool](toolBtn.dataset.sid).catch(fail);
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Copied', 'Server ID copied.'); } catch { toast('Copy failed', 'Select the ID and copy it by hand.', { error: true }); }
      return;
    }
    // Members: report a suspected cheater to staff.
    const rep = e.target.closest('[data-report], #srvReport');
    if (rep) {
      const who = rep.dataset.name || await promptBox('Report a player', 'Their in-game name', { okLabel: 'Next' });
      if (!who) return;
      const reason = await promptBox(`Report ${who} to staff`, 'What did you see? (when, which map, what happened)', { okLabel: 'Send report' });
      if (!reason) return;
      try {
        await api('reports', { method: 'POST', body: { steamId: rep.dataset.report || '', name: who, reason } });
        toast('Report sent', 'Thanks — staff will look into it.');
      } catch (x) { fail(x); }
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
      if (await confirmBox('End the current match now? The server moves on once the match-end screen finishes.')) act(sid, { action: 'end' }, 'Match ended.');
    } else if (a === 'unqueue') {
      if (await confirmBox('Cancel the queued map and put the normal rotation back?')) act(sid, { action: 'unqueue' }, 'Queue cancelled.');
    } else if (a === 'next') {
      if (await confirmBox('End this round and go to the next map in the rotation?')) act(sid, { action: 'next' }, 'Going to the next map.');
    } else if (a === 'whisper') {
      const message = await promptBox(`Whisper to ${name}`, 'Only they will see it', { okLabel: 'Send' });
      if (message) act(sid, { action: 'whisper', steamId: steam, message }, `Message sent to ${name}.`);
    } else if (a === 'faction') {
      try {
        const factions = await api(`admin/servers/${sid}/factions`);
        if (!factions.length) return toast('No factions', 'The server did not list any factions.', { error: true });
        const faction = await pickBox(`Move ${name}`, 'Faction', factions.map((f) => [f, f]), 'Move');
        if (faction) act(sid, { action: 'faction', steamId: steam, faction }, `${name} moved to ${faction}.`);
      } catch (x) { fail(x); }
    } else if (a === 'lighting') {
      try {
        const list = await api(`admin/servers/${sid}/lightings`);
        const lighting = await pickBox('Change time of day', 'Time of day', list.map((l) => [l, l.replace(/([a-z])([A-Z])/g, '$1 $2')]), 'Change');
        if (lighting) act(sid, { action: 'lighting', lighting }, 'Time of day changed.');
      } catch (x) { fail(x); }
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
const SERVER_SORTS = [['wpgxp', 'WPG XP'], ['kills', 'Kills'], ['kd', 'K/D'], ['wins', 'Wins'], ['matches', 'Matches'], ['playtime', 'Playtime']];
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
        <thead><tr><th>#</th><th>Player</th><th>Kills</th><th class="sb-x">Deaths</th><th>K/D</th><th class="sb-m">Matches</th><th>Wins</th><th class="sb-x">Losses</th><th class="sb-x">W/L</th><th>Playtime</th><th>${esc(tag)} rank</th><th class="sb-x">${esc(tag)} XP</th><th class="sb-x">Role</th><th class="sb-x">Clan rank</th></tr></thead>
        <tbody>${d.rows.map((r, i) => `<tr>
          <td><b style="color:${i === 0 ? 'var(--gold)' : i < 3 ? 'var(--accent2)' : 'var(--muted)'}">${i + 1}</b></td>
          <td class="sb-name">${r.member ? `<a href="#/u/${r.member.id}">${esc(r.name)}</a>` : esc(r.name)}</td>
          <td>${fmtNum(r.kills)}</td><td class="sb-x">${fmtNum(r.deaths)}</td><td>${ratio(r.kills, r.deaths)}</td>
          <td class="sb-m">${fmtNum(r.matches)}</td><td>${fmtNum(r.wins)}</td><td class="sb-x">${fmtNum(r.losses)}</td><td class="sb-x">${ratio(r.wins, r.losses)}</td>
          <td>${fmtMins(Math.floor(r.playtime_s / 60))}</td>
          <td><span class="wpg-rank">${wpgBadge(r.wpg?.level, 26, r.wpg?.name)}<span class="accent">${esc(wpgRankName(r.wpg?.name))}</span></span></td>
          <td class="sb-x">${fmtNum(r.wpg?.xp || 0)}</td>
          <td class="sb-x">${r.member ? esc(roleName(r.member)) : '<span class="muted small">Not in app</span>'}</td>
          <td class="sb-x">${r.member && !isPmc(r.member) && r.member.rank ? esc(r.member.rank.abbr) : '<span class="muted">—</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="14" class="muted">Nobody yet — stats appear after players join the server.</td></tr>'}</tbody>
      </table></div>
      <p class="muted small" style="margin:10px 0 0">${esc(tag)} rank and ${esc(tag)} XP are earned on the ${esc(tag)} server and match Discord (everyone starts at Recruit I). Clan rank is the app's own member rank. Wins and losses count when a match ends (your team had the top score).</p>
    </div>`;
}

async function viewLeaderboard(main) {
  const by = query().get('by') || 'wpg';
  const tag = state.settings.clan_tag || 'WPG';
  const tabs = [['wpg', `${tag} rank`], ['server', `${tag} server`], ['xp', 'Clan XP'], ['level', 'Wardog level'], ['worth', 'Account worth'], ['cash', 'Cash held'], ['gold', 'Gold'], ['unlocks', 'Unlocks'], ['tonight', '24-hour money'], ['kills', 'Server kills'], ['hours', 'Steam hours']];
  // WPG rank: everyone's WPG XP and rank (from the Discord bot, or the app once switched over in Admin → WPG XP).
  if (by === 'wpg') {
    const d = await api('wpg-ranking');
    const app = d.rules?.source === 'app';
    // Your last matches and what each gave or took (once the app works WPG XP out).
    const history = app ? await api('wpg-xp/history').catch(() => []) : [];
    // Your own place comes from the server, so it shows even outside the top 100.
    const me = d.me;
    // Equal XP = equal place (same rule as your own place, profiles and Discord).
    const places = [];
    d.rows.forEach((r, i) => { places[i] = i && r.xp === d.rows[i - 1].xp ? places[i - 1] : i + 1; });
    const pct = me && d.total ? Math.max(1, Math.ceil((me.position / d.total) * 100)) : null;
    const ru = d.rules || {};
    const rules = app
      ? `Earned only on the ${esc(tag)} server: +${ru.kill} XP per kill, +${ru.per5min} XP every 5 minutes played, +${ru.finish} XP for finishing a match, +${ru.win} XP for a win.${ru.penalties
        ? ` Taken away: −${ru.loss} XP for a loss, −${ru.leave} XP for leaving early (after ${ru.leaveMinutes} min), and −${ru.kdEach} XP per death more than kills (at most −${ru.kdCap}, after ${ru.kdMinutes} min).${ru.floor ? " Penalties never take you below the start of your rank." : ''}`
        : ''} Counted when each match ends.`
      : `Earned only on the ${esc(tag)} server: +15 XP per kill, +5 XP every 5 minutes played, +100 XP per completed match, +250 XP per win. Updates every 5 minutes.`;
    const PARTS = { kill_xp: 'kills', time_xp: 'time', finish: 'finished', win: 'win', loss: 'loss', kd: 'K/D', left: 'left early', bonus: 'prize' };
    const part = (k, v) => `<span style="color:${v < 0 ? 'var(--red)' : 'inherit'}">${v > 0 ? '+' : '−'}${fmtNum(Math.abs(v))} ${PARTS[k]}</span>`;
    main.innerHTML = `<h1>Leaderboard</h1>
      <div class="tabs">${tabs.map(([k, l]) => `<a href="#/leaderboard?by=${k}" class="${k === by ? 'active' : ''}">${l}</a>`).join('')}</div>
      <div class="panel glow">
        <div class="row between" style="margin-bottom:10px">
          <div class="panel-title" style="margin:0">${icon('trophy')} ${esc(tag)} rank <span class="sub">Recruit I → Wardog X</span></div>
          <span class="muted small">${d.updated ? `${app ? 'Last match counted' : `From the ${esc(tag)} Discord bot · updated`} ${timeAgo(d.updated)}` : app ? 'Waiting for the first match' : 'Waiting for the Discord bot'}</span>
        </div>
        ${me ? `<div class="wpg-me">
          <div class="row grow" style="gap:12px;flex-wrap:nowrap;min-width:0">${wpgBadge(me.level, 56, me.rank)}<div class="grow" style="min-width:0"><p class="small" style="margin:0 0 6px">${esc(wpgRankName(me.rank))} · ${fmtNum(me.xp)} ${esc(tag)} XP${me.next ? ` · <b>${esc(wpgToNext(me))}</b>` : ''}</p>${wpgBar(me)}</div></div>
          <div class="wpg-place"><div class="lbl">Your ranking</div><div class="num">#${fmtNum(me.position)}</div><div class="muted small">of ${fmtNum(d.total)}${pct && pct <= 50 ? ` · top ${pct}%` : ''}${me.position > d.rows.length ? ` · not in the top ${fmtNum(d.top || 100)} yet` : ''}</div></div>
        </div>` : `<p class="muted small" style="margin:0 0 12px">You're not on the ${esc(tag)} rank list yet: play a match on the ${esc(tag)} server to get ranked.</p>`}
        <div class="table-wrap"><table class="sb-table">
          <thead><tr><th>#</th><th>Player</th><th>${esc(tag)} rank</th><th>${esc(tag)} XP</th><th class="sb-x">Next rank</th><th class="sb-x">Role</th></tr></thead>
          <tbody>${d.rows.map((r, i) => `<tr${r.member?.id === state.me.id ? ' style="background:rgba(41,182,246,.08)"' : ''}>
            <td><b style="color:${places[i] === 1 ? 'var(--gold)' : places[i] <= 3 ? 'var(--accent2)' : 'var(--muted)'}">${places[i]}</b></td>
            <td class="sb-name">${r.member ? `<a href="#/u/${r.member.id}">${esc(r.name)}</a>` : esc(r.name)}</td>
            <td><span class="wpg-rank">${wpgBadge(r.level, 26, r.rank)}<span class="accent">${esc(wpgRankName(r.rank))}</span></span></td>
            <td><b>${fmtNum(r.xp)}</b></td>
            <td class="sb-x small">${r.next ? esc(wpgToNext(r)) : r.from !== null ? '<span class="muted">Top rank</span>' : '<span class="muted">—</span>'}</td>
            <td class="sb-x">${r.member ? esc(roleName(r.member)) : '<span class="muted small">Not in app</span>'}</td>
          </tr>`).join('') || `<tr><td colspan="6" class="muted">${app ? 'Nobody yet: XP appears after the first match.' : 'No data from the Discord bot yet.'}</td></tr>`}</tbody>
        </table></div>
        <p class="muted small" style="margin:10px 0 0">${rules} ${d.total > d.rows.length ? `Showing the top ${fmtNum(d.rows.length)} of ${fmtNum(d.total)} players ranked.` : `${fmtNum(d.total)} players ranked.`}</p>
      </div>
      ${ladderHtml(d.ladder || [], me)}
      ${history.length ? `<div class="panel">
        <div class="panel-title">${icon('star')} Your last matches <span class="sub">${esc(tag)} XP</span></div>
        <div class="list">${history.map((h) => `<div class="item"><div class="grow small">${Object.keys(PARTS).filter((k) => h.detail?.[k]).map((k) => part(k, h.detail[k])).join(' · ') || '<span class="muted">Nothing earned</span>'}
          <div class="muted">${timeAgo(h.created_at)} · ${h.detail?.reason ? esc(h.detail.reason) : `${fmtNum(h.detail?.minutes || 0)} min · ${fmtNum(h.detail?.kills || 0)} kills / ${fmtNum(h.detail?.deaths || 0)} deaths`}${h.detail?.floor ? ' · kept at the start of your rank' : ''}</div></div>
          <b style="font:700 18px var(--head);color:${h.xp < 0 ? 'var(--red)' : 'var(--accent2)'}">${h.xp > 0 ? '+' : h.xp < 0 ? '−' : ''}${fmtNum(Math.abs(h.xp))}</b></div>`).join('')}</div>
      </div>` : ''}`;
    onLive('server-board', () => route());
    return;
  }
  if (by === 'server') {
    main.innerHTML = `<h1>Leaderboard</h1>
      <div class="tabs">${tabs.map(([k, l]) => `<a href="#/leaderboard?by=${k}" class="${k === by ? 'active' : ''}">${l}</a>`).join('')}</div>
      ${await serverBoardHtml(query().get('sort') || 'wpgxp', query().get('server'))}`;
    onLive('server-board', () => route());
    return;
  }
  const list = await api(`leaderboard?by=${by}`);
  const unit = { xp: 'XP', level: 'LVL', kills: 'kills', hours: 'h', gold: 'gold', unlocks: 'unlocks' }[by] || '';
  main.innerHTML = `<h1>Leaderboard</h1>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/leaderboard?by=${k}" class="${k === by ? 'active' : ''}">${l}</a>`).join('')}</div>
    ${by === 'tonight' ? '<p class="muted small" style="margin:-4px 0 12px">Match money over the last 24 hours, live from Steam, for members who switched on <b>Live match money</b> on their profile.</p>' : ''}
    ${['worth', 'cash', 'level', 'gold', 'unlocks'].includes(by) ? `<p class="muted small" style="margin:-4px 0 12px">Data provided by <a href="${TRACKER_URL}" target="_blank" rel="noopener">wardogs.tools</a>. Members it hasn't found show —.</p>` : ''}
    <div class="panel list">${list.map((u, i) => `
      <a class="item" href="#/u/${u.id}">
        <b style="font:700 22px var(--head);width:42px;text-align:center;color:${i === 0 ? 'var(--gold)' : i < 3 ? 'var(--accent2)' : 'var(--muted)'}">#${i + 1}</b>
        <div class="grow">${userLine(u)}</div>
        <b style="font:700 18px var(--head)">${u.score === null || u.score === undefined ? '—' : by === 'tonight' ? `<span style="color:${u.score < 0 ? 'var(--red)' : 'var(--green)'}">${u.score < 0 ? '-' : '+'}${fmtMoney(Math.abs(u.score))}</span>` : by === 'cash' || by === 'worth' ? fmtMoney(u.score) : `${fmtNum(u.score)} <span class="muted small">${unit}</span>`}</b>
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

const KIND_ICON = { Weapon: 'assault', Attachment: 'crosshair', Ammunition: 'target', Equipment: 'shield', Vehicle: 'driver', Supply: 'coins' };
const KINDS = ['Weapon', 'Attachment', 'Ammunition', 'Equipment', 'Vehicle', 'Supply'];

async function viewTools(main) {
  const [list, mine, ticked] = await Promise.all([
    api('unlocks'),
    api(`users/${state.me.id}`).catch(() => null),
    api('me/unlocks').catch(() => []),
  ]);
  const off = mine?.wardogs?.official;
  const levelOf = (role) => {
    if (!off) return null;
    if (role === 'career') return off.wardogLevel === null || off.wardogLevel === undefined ? null : Number(off.wardogLevel) || 0;
    const r = off.roles?.[role];
    const level = r?.level ?? (typeof r === 'number' ? r : null);
    return level === null || level === undefined ? null : Number(level) || 0;
  };
  const bought = new Set(ticked.map((t) => `${t.role}|${t.name}`));
  const isBought = (u) => bought.has(`${u.role}|${u.name}`);
  // Free items count as bought as soon as they're reached.
  const statusOf = (u) => {
    const lvl = levelOf(u.role);
    if (isBought(u) || (u.cost === 0 && lvl !== null && u.level <= lvl)) return 'bought';
    if (lvl !== null && u.level <= lvl) return 'ready';
    return 'locked';
  };
  const totals = (items) => {
    const t = { bought: 0, ready: 0, spent: 0, togo: 0, count: items.length };
    for (const u of items) {
      const s = statusOf(u);
      if (s === 'bought') { t.bought++; t.spent += u.cost; } else { t.togo += u.cost; if (s === 'ready') t.ready++; }
    }
    return t;
  };

  const q2 = query();
  const tab = q2.get('role') || 'career';
  const kind = q2.get('kind') || '';
  const items = list.filter((u) => u.role === tab && (!kind || u.kind === kind)).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  const level = levelOf(tab);
  const link = (o) => `#/progression?role=${o.role ?? tab}${(o.kind ?? kind) ? `&kind=${o.kind ?? kind}` : ''}`;

  const card = (key, label, t, active) => `<a class="pg-card${active ? ' active' : ''}" href="${link({ role: key, kind: '' })}">
      <b>${esc(label)}</b>${key !== 'all' && levelOf(key) !== null ? `<span class="pg-lvl">Lvl ${levelOf(key)}</span>` : ''}
      <div class="pg-nums"><span><em>${t.bought}/${t.count}</em>Bought</span><span><em>${t.ready}</em>Ready</span>
        <span><em>${fmtMoney(t.spent)}</em>Spent</span><span><em>${fmtMoney(t.togo)}</em>To go</span></div></a>`;

  const cardsHtml = () => `${card('all', 'Totals', totals(list), false).replace('<a class="pg-card"', '<div class="pg-card total"').replace(/<\/a>$/, '</div>')}
        ${TOOL_ROLES.map(([k, l]) => card(k, l, totals(list.filter((u) => u.role === k)), k === tab)).join('')}`;
  const reachedNotBought = items.filter((u) => statusOf(u) === 'ready').length;
  main.innerHTML = `<h1>Progression</h1>
    <div class="stack">
      <div class="pg-cards" id="pgCards">${cardsHtml()}</div>
      ${off ? trackerCredit() : `<p class="muted small" style="margin:0">Your class levels are not known yet. Stats are provided by <a href="${TRACKER_URL}" target="_blank" rel="noopener">wardogs.tools</a>.</p>`}
      <div class="panel">
        <div class="row between" style="margin-bottom:10px">
          <div class="panel-title" style="margin:0">${icon('unlock')} ${esc(TOOL_ROLES.find(([k]) => k === tab)?.[1] || tab)} <span class="sub">${tab === 'career' ? 'Wardog level' : 'class'} unlocks</span></div>
          ${level !== null ? `<button class="btn small" id="pgAll"${reachedNotBought ? '' : ' hidden'}>${icon('unlock')} Mark all <span id="pgAllN">${reachedNotBought}</span> reached as bought</button>` : ''}
        </div>
        <div class="row" style="gap:6px;margin-bottom:10px">
          <a class="btn small${!kind ? ' primary' : ''}" href="${link({ kind: '' })}">All</a>
          ${KINDS.filter((k) => list.some((u) => u.role === tab && u.kind === k)).map((k) => `<a class="btn small${kind === k ? ' primary' : ''}" href="${link({ kind: k })}">${k}</a>`).join('')}
        </div>
        <div class="table-wrap"><table class="pg-table">
          <thead><tr><th>Lvl</th><th></th><th>Name</th><th class="pg-x">Type</th><th>Unlock</th><th class="pg-x">Buy in match</th><th>Status</th></tr></thead>
          <tbody>${items.map((u) => {
            const s = statusOf(u);
            const free = u.cost === 0;
            return `<tr class="pg-${s}">
              <td><b>${u.level}</b></td>
              <td>${u.image ? `<img src="${esc(u.image)}" alt="" loading="lazy">` : `<span class="pg-ic">${icon(KIND_ICON[u.kind] || 'star')}</span>`}</td>
              <td class="pg-name">${esc(u.name)}</td>
              <td class="pg-x muted">${esc(u.kind)}</td>
              <td>${free ? '<span class="muted">Free</span>' : fmtMoney(u.cost)}</td>
              <td class="pg-x">${u.vendor_price ? fmtMoney(u.vendor_price) : '—'}</td>
              <td>${s === 'locked'
                ? `<span class="muted small">${level === null ? 'Locked' : `${u.level - level} to go`}</span>`
                : free ? '<span class="pg-ok">✓ Unlocked</span>'
                : `<label class="pg-tick"><input type="checkbox" data-buy="${esc(u.name)}" ${s === 'bought' ? 'checked' : ''}> <span>${s === 'bought' ? 'Bought' : 'Ready'}</span></label>`}</td>
            </tr>`;
          }).join('') || '<tr><td colspan="7" class="muted">Nothing here.</td></tr>'}</tbody>
        </table></div>
        <p class="muted small" style="margin:10px 0 0">Ready = you've reached the level but haven't bought it yet. Tick what you've bought — Spent and To go update from that.</p>
      </div>
    </div>`;

  // Ticking a box updates just that row and the totals in place (no page reload), then saves.
  const showTick = (cb) => {
    const key = `${tab}|${cb.dataset.buy}`;
    if (cb.checked) bought.add(key); else bought.delete(key);
    const row = cb.closest('tr');
    row.className = `pg-${cb.checked ? 'bought' : 'ready'}`;
    cb.nextElementSibling.textContent = cb.checked ? 'Bought' : 'Ready';
    document.getElementById('pgCards').innerHTML = cardsHtml();
    const left = items.filter((u) => statusOf(u) === 'ready').length;
    const all = document.getElementById('pgAll');
    if (all) { all.hidden = !left; document.getElementById('pgAllN').textContent = left; }
  };
  main.querySelectorAll('[data-buy]').forEach((cb) => {
    cb.onchange = async () => {
      showTick(cb);
      try {
        await api('me/unlocks', { method: 'POST', body: { role: tab, name: cb.dataset.buy, bought: cb.checked } });
      } catch (x) {
        fail(x);
        cb.checked = !cb.checked;
        showTick(cb);
      }
    };
  });
  document.getElementById('pgAll')?.addEventListener('click', async () => {
    if (!(await confirmBox(`Mark every ${TOOL_ROLES.find(([k]) => k === tab)?.[1] || tab} unlock up to level ${level} as bought?`))) return;
    try { await api('me/unlocks', { method: 'POST', body: { role: tab, upTo: level, bought: true } }); route(); } catch (x) { fail(x); }
  });
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
      <div class="panel-title">${icon('xp')} How to earn <span class="sub">Clan XP</span></div>
      <div class="xp-rules">${rows.map(([ic, what, how]) => `
        <div class="xp-rule"><span class="ic">${icon(ic)}</span><span class="grow">${esc(what)}</span><b>${esc(how)}</b></div>`).join('')}</div>
      <ul class="muted small" style="margin:14px 0 0;padding-left:18px;line-height:1.7">
        <li>Your stats sync by themselves every ${x.sync_minutes} minutes, or press <b>Sync stats</b> on HQ. XP is added when they sync.</li>
        <li>New activity earns the rate <b>at the time it's counted</b>. When staff change a rate (for example an XP event), XP you've already earned stays the same.</li>
        <li>Global Wardogs stats need your <b>in-game name</b> (Name#1234) — see the card on HQ if you haven't.</li>
        <li>${x.auto_promote ? 'Ranks marked with XP are given automatically as soon as you reach them.' : 'Automatic promotions are paused right now — staff promote by hand.'} Ranks marked <b>Appointed</b> are given by command.</li>
        ${isPmc(state.me) ? '<li>You\'re a PMC (guest): you earn XP but don\'t hold a rank.</li>' : ''}
      </ul>
    </div>`;
}

async function viewRanks(main) {
  const [ranks, rules] = await Promise.all([api('ranks'), api('xp-rules')]);
  onLive('config', (name) => { if (['settings', 'stat-defs', 'games', 'ranks'].includes(name)) route(); });
  onLive('me', () => route());
  main.innerHTML = `<h1>Clan rank structure</h1>
    <p class="muted small" style="margin:-6px 0 12px">These are the app's clan ranks, earned with Clan XP. The WPG server rank (Recruit I to Wardog X) is earned with WPG XP on the WPG server and shows on the leaderboard and profiles.</p>
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
