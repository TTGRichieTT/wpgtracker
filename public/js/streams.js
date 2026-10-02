// Streams tab: who is live, the stream's own player and chat, and WPG chat underneath.
// Twitch, YouTube and Kick chat are shown by the app itself; members sign in with their own account on that
// platform to type in them (no bot). Twitch and YouTube can also use the platform's own chat box.
// Also the "Chat in streams" and "My streams" boxes on Edit profile and the Streams tab in the Command panel.
import { api, esc, state, toast, fail, confirmBox, onLive, avatar, fmtNum, fmtTime, fmtDate, timeAgo, userLine, query } from './app.js';
import { icon } from './icons.js';

const PLATFORM_ORDER = ['twitch', 'youtube', 'kick'];
const NAMES = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
const SIGN_IN = ['twitch', 'youtube', 'kick']; // members link their own account on each to chat from the app
const enc = encodeURIComponent;
const isStaff = () => ['mod', 'admin'].includes(state.me?.role);
const platformPill = (p) => `<span class="pill plat ${esc(p)}">${esc(NAMES[p] || p)}</span>`;
const livePill = () => '<span class="pill live-pill">● Live</span>';
const viewersText = (s) => (s.viewers !== null && s.viewers !== undefined ? `${fmtNum(s.viewers)} watching` : '');

// ---------- Embeds ----------
// Twitch and YouTube check the page's address (parent / embed_domain), so it must be this site's.
function playerSrc(s) {
  const host = enc(location.hostname);
  if (s.platform === 'twitch') return `https://player.twitch.tv/?channel=${enc(s.handle)}&parent=${host}&autoplay=true`;
  if (s.platform === 'youtube') {
    if (s.video_id) return `https://www.youtube.com/embed/${enc(s.video_id)}?autoplay=1`;
    if (s.channel_id) return `https://www.youtube.com/embed/live_stream?channel=${enc(s.channel_id)}&autoplay=1`;
    return '';
  }
  if (s.platform === 'kick') return `https://player.kick.com/${enc(s.handle)}?autoplay=true`;
  return '';
}
function chatSrc(s) {
  const host = enc(location.hostname);
  if (s.platform === 'twitch') return `https://www.twitch.tv/embed/${enc(s.handle)}/chat?parent=${host}&darkpopout`;
  if (s.platform === 'youtube' && s.video_id) return `https://www.youtube.com/live_chat?v=${enc(s.video_id)}&embed_domain=${host}`;
  return '';
}
// Where the platform's own chat is when it can't be shown inside the app.
function chatOutside(s) {
  if (s.platform === 'kick') return `https://kick.com/popout/${enc(s.handle)}/chat`;
  if (s.platform === 'youtube' && s.video_id) return `https://www.youtube.com/watch?v=${enc(s.video_id)}`;
  return s.channel_url;
}
const watchOutside = (s) => (s.platform === 'youtube' && s.video_id ? `https://www.youtube.com/watch?v=${enc(s.video_id)}` : s.channel_url);
const frame = (src, title, cls) => `<iframe class="${cls}" src="${esc(src)}" title="${esc(title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;

// ---------- Streams list ----------
export async function viewStreams(main, [id], alive) {
  if (id) return viewWatch(main, Number(id), alive);
  const d = await api('streams');
  if (!alive()) return;
  const live = d.streams.filter((s) => s.is_live);
  // Offline streamers, one row per person with all their platforms.
  const offline = new Map();
  for (const s of d.streams.filter((x) => !x.is_live)) {
    if (live.some((l) => l.user?.id === s.user?.id)) continue;
    if (!offline.has(s.user?.id)) offline.set(s.user?.id, { user: s.user, list: [] });
    offline.get(s.user?.id).list.push(s);
  }
  const card = (s) => `<a class="stream-card" href="#/streams/${s.id}">
      <div class="thumb plat-bg ${esc(s.platform)}">${s.thumbnail ? `<img src="${esc(s.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${esc(NAMES[s.platform])}</span>`}
        <div class="tl">${livePill()}</div>${viewersText(s) ? `<div class="br">${esc(viewersText(s))}</div>` : ''}</div>
      <div class="meta">${avatar(s.user, 'sm')}<div class="grow" style="min-width:0">
        <div class="ttl">${esc(s.title || `${s.user?.name || 'Someone'} is live`)}</div>
        <div class="muted small">${esc(s.user?.name || '')} · ${platformPill(s.platform)}${s.game ? ` · ${esc(s.game)}` : ''}</div></div></div>
    </a>`;
  main.innerHTML = `
    <div class="stack">
      <div class="row between">
        <h1 style="margin:0">${icon('live', 'width="26" height="26" style="vertical-align:-4px;color:var(--accent)"')} Streams <span class="muted small">${live.length} live</span></h1>
        <a class="btn small ghost" href="#/profile/edit#streams">${icon('edit')} My streams</a>
      </div>
      ${live.length ? `<div class="stream-grid">${live.map(card).join('')}</div>`
        : `<div class="panel empty"><h3>Nobody is live right now</h3><p>When a WPG streamer goes live on Twitch, YouTube or Kick it shows here — watch and chat without leaving the app.</p></div>`}
      <div class="panel">
        <div class="panel-title">${icon('users')} WPG streamers <span class="sub">${offline.size + new Set(live.map((s) => s.user?.id)).size}</span></div>
        <div class="list">${[...offline.values()].map((o) => `<div class="item">${userLine(o.user, 'Offline')}
            <div class="row" style="gap:6px">${o.list.map((s) => `<a class="btn small ghost" href="#/streams/${s.id}">${esc(NAMES[s.platform])}</a>`).join('')}</div></div>`).join('')
          || (live.length ? '' : '<p class="muted">No streamers yet.</p>')}</div>
        <p class="muted small" style="margin:10px 0 0">Do you stream? Link your channel in <a href="#/profile/edit#streams">Edit profile → My streams</a>. Staff approve it, then it shows here and in Discord when you go live.</p>
      </div>
    </div>`;
  onLive('streams', async () => { if (alive()) viewStreams(main, [], alive).catch(() => {}); });
}

// ---------- Watch a stream ----------
async function viewWatch(main, id, alive) {
  let d = await api(`streams/${id}`);
  if (!alive()) return;
  let s = d.stream;
  const streamerId = s.user?.id;
  const native = SIGN_IN.includes(s.platform);
  let chatTab = native || chatSrc(s) ? 'platform' : 'wpg';
  let useOwnBox = false; // the platform's own chat box (Twitch / YouTube) instead of the app's
  const logins = native ? await api('me/chat-logins').catch(() => ({ logins: [], available: {} })) : null;
  if (!alive()) return;
  signinNotice();

  const infoHtml = () => `
    <div class="row" style="align-items:flex-start;gap:12px">
      <a href="#/u/${s.user?.id}">${avatar(s.user)}</a>
      <div class="grow" style="min-width:0">
        <div class="ttl" style="font:700 19px var(--head);overflow-wrap:anywhere">${esc(s.title || (s.is_live ? `${s.user?.name} is live` : `${s.user?.name}'s channel`))}</div>
        <div class="muted small">${s.is_live ? `${livePill()} ` : '<span class="pill">Offline</span> '}<a href="#/u/${s.user?.id}">${esc(s.user?.name || '')}</a> · ${platformPill(s.platform)}${s.game ? ` · ${esc(s.game)}` : ''}${viewersText(s) ? ` · ${esc(viewersText(s))}` : ''}${s.is_live && s.live_since ? ` · started ${esc(timeAgo(s.live_since))}` : ''}</div>
      </div>
      <a class="btn small ghost" href="${esc(watchOutside(s))}" target="_blank" rel="noopener">Open on ${esc(NAMES[s.platform])}</a>
    </div>
    ${d.others.length ? `<div class="row small" style="gap:6px;margin-top:10px"><span class="muted">Also on:</span>${d.others.map((o) => `<a class="btn small${o.is_live ? '' : ' ghost'}" href="#/streams/${o.id}">${esc(NAMES[o.platform])}${o.is_live ? ' ●' : ''}</a>`).join('')}</div>` : ''}`;

  const playerHtml = () => {
    const src = playerSrc(s);
    // Twitch shows its own offline screen; the others need a stream to show.
    if (src && (s.is_live || s.platform === 'twitch')) return frame(src, `${s.user?.name} on ${NAMES[s.platform]}`, 'stream-player');
    return `<div class="stream-player off"><div><b>${s.is_live ? 'This stream can\'t be shown here' : 'Offline'}</b>
      <p class="muted small">${s.is_live ? `Watch it on ${esc(NAMES[s.platform])} instead.` : `${esc(s.user?.name || 'They')} isn't live on ${esc(NAMES[s.platform])} right now.`}</p>
      <a class="btn small" href="${esc(watchOutside(s))}" target="_blank" rel="noopener">Open on ${esc(NAMES[s.platform])}</a></div></div>`;
  };

  const signedIn = () => !!logins?.logins.some((l) => l.platform === s.platform);
  const platformChatHtml = () => {
    // Stream chats are only for members signed in with their own account on that platform.
    if (native && !signedIn()) {
      return `<div class="msgs pchat"><div class="empty"><p>Sign in with your own ${esc(NAMES[s.platform])} account to see and join this stream's chat.</p></div></div>
        <div id="pfoot">${chatFootHtml(s, logins)}</div>`;
    }
    if (native && !useOwnBox) {
      return `<div class="msgs pchat" id="pmsgs"><p class="empty small" data-pwait>Connecting to ${esc(NAMES[s.platform])} chat…</p></div>
        <div id="pfoot">${chatFootHtml(s, logins)}</div>`;
    }
    const src = chatSrc(s);
    if (src) {
      return frame(src, `${NAMES[s.platform]} chat`, 'stream-chat-frame')
        + `<div class="pchat-note small"><a href="#" data-ownbox="0">Back to the app's ${esc(NAMES[s.platform])} chat</a></div>`;
    }
    const why = s.is_live ? 'YouTube chat shows here once the app knows which video is live.' : 'YouTube chat shows here while the stream is live.';
    return `<div class="empty"><p>${esc(why)}</p><a class="btn small" href="${esc(chatOutside(s))}" target="_blank" rel="noopener">Open ${esc(NAMES[s.platform])} chat</a>
      <p class="muted small" style="margin-top:12px">Or talk to WPG in the <b>WPG chat</b> tab.</p></div>`;
  };

  main.innerHTML = `
    <div class="stream-watch">
      <div class="stack" style="min-width:0">
        <div><a href="#/streams" class="small">← All streams</a></div>
        <div id="playerBox">${playerHtml()}</div>
        <div class="panel" id="infoBox">${infoHtml()}</div>
      </div>
      <div class="panel stream-side">
        <div class="tabs" style="margin:0;padding:10px 10px 0">
          <a href="#" data-tab="platform">${esc(NAMES[s.platform])} chat</a>
          <a href="#" data-tab="wpg">WPG chat</a>
        </div>
        <div class="stream-chat" data-pane="platform"></div>
        <div class="stream-chat" data-pane="wpg">
          <div class="pchat-note small muted" style="border-top:0;border-bottom:1px solid var(--line)">${icon('lock', 'width="13" height="13" style="vertical-align:-2px"')} WPG chat stays inside the app — only WPG members see it.</div>
          <div class="msgs" id="smsgs"><div class="spinner"></div></div>
          <form class="composer" id="scomposer"><textarea name="body" placeholder="Chat with WPG" maxlength="500" rows="1"></textarea><button class="btn primary" aria-label="Send">${icon('send')}</button></form>
        </div>
      </div>
    </div>`;
  const showTab = () => {
    main.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === chatTab));
    main.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== chatTab; });
    if (chatTab === 'wpg') box.scrollTop = box.scrollHeight;
  };
  main.querySelectorAll('[data-tab]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); chatTab = a.dataset.tab; showTab(); };
  });

  // ----- WPG chat -----
  const box = document.getElementById('smsgs');
  const canDelete = (m) => m.user_id === state.me.id || streamerId === state.me.id || isStaff();
  const msgHtml = (m) => {
    const u = state.users.get(m.user_id) || { id: m.user_id, name: 'Unknown' };
    return `<div class="msg" data-id="${m.id}"><a href="#/u/${u.id}">${avatar(u, 'sm')}</a><div class="grow">
      <div><a class="who" href="#/u/${u.id}" style="color:${esc(u.rank?.color || 'var(--text)')}">${u.rank ? `[${esc(u.rank.abbr)}] ` : ''}${esc(u.name)}</a>${u.id === streamerId ? ' <span class="pill live-pill">Streamer</span>' : ''}<span class="time">${fmtTime(m.created_at)}</span></div>
      <div class="body">${esc(m.body)}</div></div>
      ${canDelete(m) ? `<button class="btn ghost small del" data-del="${m.id}" title="Delete" aria-label="Delete">${icon('trash')}</button>` : ''}</div>`;
  };
  const r = await api(`streams/chat/${streamerId}`);
  if (!alive()) return;
  r.users.forEach((u) => state.users.set(u.id, u));
  box.innerHTML = r.messages.length ? r.messages.map(msgHtml).join('') : '<p class="empty">No messages yet. Say hello!</p>';
  showTab();
  box.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del && (await confirmBox('Delete this message?'))) api(`streams/chat/messages/${del.dataset.del}`, { method: 'DELETE' }).catch(fail);
  });
  onLive('stream:chat', ({ message }) => {
    if (message.streamer_id !== streamerId) return;
    box.querySelector('.empty')?.remove();
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
    box.insertAdjacentHTML('beforeend', msgHtml(message));
    if (near || message.user_id === state.me.id) box.scrollTop = box.scrollHeight;
  });
  onLive('stream:chat:deleted', ({ id: mid }) => box.querySelector(`[data-id="${mid}"]`)?.remove());
  const form = document.getElementById('scomposer');
  const ta = form.body;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); form.requestSubmit(); }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body) return;
    ta.value = '';
    try { await api(`streams/chat/${streamerId}`, { method: 'POST', body: { body } }); } catch (x) { ta.value = body; fail(x); }
  };

  // ----- Twitch / Kick chat, shown by the app -----
  let stopReader = () => {};
  const startPlatformChat = () => {
    stopReader();
    const pane = main.querySelector('[data-pane="platform"]');
    pane.innerHTML = platformChatHtml();
    pane.querySelector('[data-ownbox]')?.addEventListener('click', (e) => { e.preventDefault(); useOwnBox = false; startPlatformChat(); });
    if (!native || useOwnBox) return;
    if (!signedIn()) { bindChatFoot(pane.querySelector('#pfoot'), s, logins, () => {}); return; }
    const pbox = pane.querySelector('#pmsgs');
    stopReader = startReader(s, pbox, alive);
    bindChatFoot(pane.querySelector('#pfoot'), s, logins, () => { useOwnBox = true; startPlatformChat(); });
  };
  startPlatformChat();

  // Live / offline changes: refresh the details, and the player only if the stream itself changed.
  onLive('streams', async () => {
    const nd = await api(`streams/${id}`).catch(() => null);
    if (!nd || !alive()) return;
    const old = s;
    d = nd;
    s = nd.stream;
    document.getElementById('infoBox').innerHTML = infoHtml();
    if (old.is_live !== s.is_live || old.video_id !== s.video_id || old.live_url !== s.live_url) {
      document.getElementById('playerBox').innerHTML = playerHtml();
      if (!native) main.querySelector('[data-pane="platform"]').innerHTML = platformChatHtml();
      else if (s.platform === 'youtube') startPlatformChat(); // new live video: new chat
    }
  });
}

// ---------- Twitch / YouTube / Kick chat ----------
// "Signed in with Twitch" etc. after coming back from the platform's sign-in page.
function signinNotice() {
  const qs = query();
  const r = qs.get('signin');
  if (!r) return;
  const n = NAMES[qs.get('p')] || 'that site';
  const [title, body] = {
    ok: [`Signed in with ${n}`, 'You can chat in streams as yourself now.'],
    cancelled: ['Sign-in cancelled', `You didn't finish signing in with ${n}.`],
    expired: ['Sign-in timed out', 'Please try again.'],
    failed: [`${n} sign-in didn't work`, 'Please try again in a minute.'],
    setup: [`${n} sign-in isn't set up yet`, 'Staff need to add the app keys first.'],
    nochannel: ['No YouTube channel', 'Chatting on YouTube needs a YouTube channel on your Google account. Make one on youtube.com, then sign in again.'],
  }[r] || ['Sign-in', ''];
  toast(title, body, { error: r !== 'ok' });
  history.replaceState(null, '', location.href.split('?')[0]);
}

const signInUrl = (platform, ret) => `/auth/${platform}/start?return=${enc(ret)}`;
function chatFootHtml(s, logins) {
  const n = NAMES[s.platform];
  const mine = logins.logins.find((l) => l.platform === s.platform);
  const twitchBox = chatSrc(s) && mine ? ` · <a href="#" data-useown>Use ${n}'s own chat box</a>` : '';
  if (!logins.available[s.platform]) {
    return `<div class="pchat-note small muted">Chatting from the app isn't set up for ${n} yet. <a href="${esc(chatOutside(s))}" target="_blank" rel="noopener">Open ${n} chat</a>${twitchBox}</div>`;
  }
  if (!mine) {
    return `<div class="pchat-note"><a class="btn primary small plat-btn ${s.platform}" href="${esc(signInUrl(s.platform, `#/streams/${s.id}`))}">Sign in with ${n} to chat</a>
      <div class="small muted" style="margin-top:6px">Stream chat is only for members signed in with their own ${n} account. No account? Make one on ${n} first, or use WPG chat.</div></div>`;
  }
  return `<form class="composer" id="pcomposer"><textarea name="body" placeholder="Chat on ${n} as ${esc(mine.display_name || mine.login)}" maxlength="500" rows="1"></textarea><button class="btn primary" aria-label="Send">${icon('send')}</button></form>
    <div class="pchat-note small muted" style="padding-top:0">Chatting as <b>${esc(mine.display_name || mine.login)}</b> on ${n}${twitchBox}</div>`;
}
function bindChatFoot(foot, s, logins, useOwnBox) {
  foot.querySelector('[data-useown]')?.addEventListener('click', (e) => { e.preventDefault(); useOwnBox(); });
  const form = foot.querySelector('#pcomposer');
  if (!form) return;
  const ta = form.body;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); form.requestSubmit(); }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body) return;
    ta.value = '';
    try {
      await api(`streams/${s.id}/platform-chat`, { method: 'POST', body: { body } });
    } catch (x) {
      ta.value = body;
      fail(x);
      if (x.code === 'chat_signin') {
        logins.logins = logins.logins.filter((l) => l.platform !== s.platform);
        foot.innerHTML = chatFootHtml(s, logins);
        bindChatFoot(foot, s, logins, useOwnBox);
      }
    }
  };
}

// One chat line. Emotes become pictures: Twitch gives their positions, Kick writes [emote:id:name].
function chatLine(m) {
  let text;
  if (m.emotes) {
    const chars = Array.from(m.text);
    const spots = [];
    for (const part of m.emotes.split('/')) {
      const [id, ranges] = part.split(':');
      for (const r of (ranges || '').split(',')) {
        const [a, b] = r.split('-').map(Number);
        if (/^[\w-]+$/.test(id) && Number.isInteger(a) && Number.isInteger(b)) spots.push([a, b, id]);
      }
    }
    spots.sort((x, y) => x[0] - y[0]);
    let out = '';
    let at = 0;
    for (const [a, b, id] of spots) {
      if (a < at) continue;
      out += esc(chars.slice(at, a).join(''));
      const name = chars.slice(a, b + 1).join('');
      out += `<img class="emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0" alt="${esc(name)}" title="${esc(name)}">`;
      at = b + 1;
    }
    text = out + esc(chars.slice(at).join(''));
  } else {
    text = esc(m.text).replace(/\[emote:(\d+):([^\]]{1,40})\]/g, (_, id, name) => `<img class="emote" src="https://files.kick.com/emotes/${id}/fullsize" alt="${name}" title="${name}">`);
  }
  return `<div class="pmsg" data-pid="${esc(m.id)}" data-puser="${esc(m.uid || '')}"><b style="color:${esc(m.color || 'var(--accent2)')}">${esc(m.user)}</b>${m.action ? ' ' : ': '}<span${m.action ? ' style="font-style:italic"' : ''}>${text}</span></div>`;
}
function addLine(box, m) {
  box.querySelector('[data-pwait]')?.remove();
  if (m.id && box.querySelector(`[data-pid="${CSS.escape(m.id)}"]`)) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
  box.insertAdjacentHTML('beforeend', chatLine(m));
  while (box.children.length > 200) box.firstElementChild.remove();
  if (near) box.scrollTop = box.scrollHeight;
}

// Reads the stream's chat into `box`. Returns a function that stops reading.
function startReader(s, box, alive) {
  if (s.platform === 'kick') {
    api(`streams/${s.id}/platform-chat`).then((r) => {
      if (!alive()) return;
      const wait = box.querySelector('[data-pwait]');
      if (wait) wait.textContent = r.reading ? 'No chat yet. Say hello!' : 'Kick chat messages show here once staff finish setting up Kick chat. You can still send messages.';
      r.messages.forEach((m) => addLine(box, m));
    }).catch((x) => {
      const wait = box.querySelector('[data-pwait]');
      if (wait && x.code === 'chat_signin') wait.textContent = 'Your Kick sign-in has ended. Sign in again in Edit profile → Linked accounts.';
    });
    onLive('platform:chat', (d) => { if (d.platform === 'kick' && d.channel === s.channel_id) addLine(box, d.message); });
    return () => {};
  }
  if (s.platform === 'youtube') return youtubeReader(s, box, alive);
  return twitchReader(s.handle, box, alive);
}

// YouTube chat comes through the app (it reads it once for everyone watching), asked for every 5 seconds.
function youtubeReader(s, box, alive) {
  let stopped = false;
  let seq = 0;
  let timer;
  const status = (text) => { const w = box.querySelector('[data-pwait]'); if (w) w.textContent = text; };
  const PROBLEMS = {
    notlive: 'YouTube chat shows here while the stream is live.',
    nochat: 'This stream has no live chat (or the streamer turned it off).',
    ended: 'This stream\'s chat has ended.',
    quota: 'The app has used up today\'s YouTube allowance. Use YouTube\'s own chat box below until tomorrow.',
  };
  const tick = async () => {
    if (stopped || !alive()) return;
    try {
      const r = await api(`streams/${s.id}/platform-chat?since=${seq}`);
      if (stopped || !alive()) return;
      seq = r.seq;
      r.deleted.forEach((id) => box.querySelector(`[data-pid="${CSS.escape(id)}"]`)?.remove());
      r.messages.forEach((m) => addLine(box, m));
      if (r.problem) status(PROBLEMS[r.problem] || `YouTube chat: ${r.problem}`);
      else status('✓ Connected to YouTube chat. No messages yet — new ones show here as soon as someone types.');
    } catch (x) {
      if (x.code === 'chat_signin') { status('Your YouTube sign-in has ended. Sign in again in Edit profile → Linked accounts.'); return; }
    }
    timer = setTimeout(tick, 5000);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

// Twitch chat is public: the browser joins it anonymously to read (sending goes through the app with the
// member's own sign-in). https://dev.twitch.tv/docs/chat/irc/
function twitchReader(channel, box, alive) {
  let ws;
  let stopped = false;
  let wait = 1000;
  const stop = () => { stopped = true; try { ws?.close(); } catch { /* already closed */ } };
  const tagsOf = (raw) => Object.fromEntries(raw.slice(1).split(';').map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i), kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\')];
  }));
  const status = (text) => { const w = box.querySelector('[data-pwait]'); if (w) w.textContent = text; };
  const connect = () => {
    if (stopped || !alive()) return;
    ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws.onopen = () => {
      wait = 1000;
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      ws.send(`JOIN #${channel}`);
    };
    ws.onmessage = (e) => {
      if (!alive()) return stop();
      for (const line of String(e.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        const m = /^(@\S+ )?:(\S+?)(?:!\S+)? (\S+)(?: #\S+)?(?: :(.*))?$/.exec(line);
        if (!m) continue;
        const tags = m[1] ? tagsOf(m[1].trim()) : {};
        const cmd = m[3];
        if (cmd === 'JOIN' || cmd === 'ROOMSTATE') status('✓ Connected to Twitch chat. No messages yet — new ones show here as soon as someone types (Twitch only sends new messages, not older ones).');
        if (cmd === 'PRIVMSG') {
          let text = m[4] || '';
          const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
          if (action) text = action[1];
          addLine(box, { id: tags.id, uid: tags['user-id'], user: tags['display-name'] || m[2], color: /^#[0-9a-f]{6}$/i.test(tags.color || '') ? tags.color : '', text, emotes: tags.emotes || '', action: !!action });
        } else if (cmd === 'CLEARMSG' && tags['target-msg-id']) {
          box.querySelector(`[data-pid="${CSS.escape(tags['target-msg-id'])}"]`)?.remove();
        } else if (cmd === 'CLEARCHAT') {
          const who = tags['target-user-id'];
          box.querySelectorAll(who ? `[data-puser="${CSS.escape(who)}"]` : '.pmsg').forEach((el) => el.remove());
        }
      }
    };
    ws.onclose = () => {
      if (stopped || !alive()) return;
      status('Reconnecting to Twitch chat…');
      setTimeout(connect, wait);
      wait = Math.min(wait * 2, 30000);
    };
  };
  connect();
  return stop;
}

// ---------- Edit profile: Linked accounts (my Twitch / YouTube / Kick sign-ins) ----------
export async function chatLoginsPanel(el) {
  const d = await api('me/chat-logins');
  signinNotice();
  const row = (p) => {
    const mine = d.logins.find((l) => l.platform === p);
    const action = mine
      ? `<span class="small">Signed in as <b>${esc(mine.display_name || mine.login)}</b></span><button type="button" class="btn small ghost" data-signout="${p}">Sign out</button>`
      : d.available[p] ? `<a class="btn small plat-btn ${p}" href="${esc(signInUrl(p, '#/profile/edit'))}">Sign in with ${NAMES[p]}</a>`
        : '<span class="muted small">Not set up yet</span>';
    return `<div class="row between stream-acct" style="flex-direction:row">${platformPill(p)}<div class="row" style="gap:8px">${action}</div></div>`;
  };
  el.innerHTML = `<div class="panel-title" style="margin:0">${icon('chat')} Linked accounts <span class="sub">Twitch · YouTube · Kick</span></div>
    <p style="margin:0"><b>Linking these 3 accounts is for viewing, chatting and streaming within the app on live streams.</b></p>
    <p class="muted small" style="margin:0">Watch WPG streams here, see and join their chat under your own name (just like typing on the site — there's no bot), and if you stream, link your channel in <b>My streams</b> below so your live stream shows here. A stream's chat only shows once you've linked that platform. WPG chat stays inside the app and every member can use it.</p>
    ${SIGN_IN.map(row).join('')}`;
  el.querySelectorAll('[data-signout]').forEach((b) => {
    b.onclick = async () => {
      try { await api(`me/chat-logins/${b.dataset.signout}`, { method: 'DELETE' }); chatLoginsPanel(el); } catch (x) { fail(x); }
    };
  });
}

// ---------- HQ: "Live now" strip ----------
export async function liveStrip(el) {
  if (!el || !state.liveStreams) { if (el) el.hidden = true; return; }
  const d = await api('streams').catch(() => null);
  const live = (d?.streams || []).filter((s) => s.is_live);
  if (!live.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<div class="panel-title">${icon('live')} Live now <span class="sub">${live.length}</span> <a class="small" href="#/streams" style="margin-left:auto">All streams →</a></div>
    <div class="row" style="gap:10px">${live.slice(0, 6).map((s) => `<a class="btn" href="#/streams/${s.id}">${avatar(s.user, 'sm')} ${esc(s.user?.name || '')} <span class="muted small">${esc(NAMES[s.platform])}${s.viewers ? ` · ${fmtNum(s.viewers)}` : ''}</span></a>`).join('')}</div>`;
}

// ---------- Edit profile: My streams ----------
const STATUS = {
  pending: '<span class="pill pending">Waiting for staff</span>',
  approved: '<span class="pill mod">Approved</span>',
  rejected: '<span class="pill banned">Not approved</span>',
};
const HANDLE_HINT = {
  twitch: 'Channel name or link, e.g. twitch.tv/wpgrichie',
  youtube: '@handle or channel link, e.g. youtube.com/@WPGRichie',
  kick: 'Channel name or link, e.g. kick.com/wpgrichie',
};

export async function myStreamsPanel(el) {
  const d = await api('me/streams');
  const by = Object.fromEntries(d.accounts.map((a) => [a.platform, a]));
  const block = (p) => {
    const a = by[p];
    const auto = d.platforms[p]?.auto;
    const liveBit = !a || a.status !== 'approved' ? '' : a.is_live
      ? `<div class="row small" style="gap:8px">${livePill()} <span>You're live${a.manual ? ' (you switched this on)' : ''}.</span>
          <a class="btn small ghost" href="#/streams/${a.id}">View</a>${a.manual ? `<button type="button" class="btn small ghost" data-act="end">I've finished</button>` : ''}</div>`
      : `<div class="small"><span class="muted">${auto ? 'Shows as live by itself within about 2 minutes of you starting.' : `Going live? Press <b>I'm live</b>${p === 'youtube' ? ' and paste your live video link' : ''}.`}</span>
          <div class="row" style="margin-top:6px">${p === 'youtube' && !auto ? '<input type="url" name="live_url" class="grow" style="min-width:180px" placeholder="https://www.youtube.com/live/…">' : ''}
          <button type="button" class="btn small${auto ? ' ghost' : ' primary'}" data-act="live">● I'm live</button></div></div>`;
    const keyBit = !a ? '' : a.key_saved
      ? `<div class="row small" style="gap:8px">${icon('lock', 'width="14" height="14" style="vertical-align:-2px"')} <span>Stream key saved${a.key_set_at ? ` ${esc(fmtDate(a.key_set_at))}` : ''} — hidden for good.</span>
          <button type="button" class="btn small ghost" data-act="key-replace">Replace</button><button type="button" class="btn small ghost" data-act="key-remove">Remove</button></div>`
      : '';
    const keyForm = !a ? '' : `<div class="row" data-keyform${a.key_saved ? ' hidden' : ''}>
        <input type="password" name="stream_key" class="grow" style="min-width:180px" placeholder="${a.key_saved ? 'New stream key' : 'Stream key (optional)'}" autocomplete="new-password" spellcheck="false" autocapitalize="off">
        <button type="button" class="btn small" data-act="key-save">Save key</button></div>`;
    return `<div class="stream-acct" data-platform="${p}">
      <div class="row between"><b>${platformPill(p)}</b>${a ? STATUS[a.status] || '' : '<span class="muted small">Not linked</span>'}</div>
      <div class="row">
        <input type="text" name="handle" class="grow" style="min-width:180px" maxlength="300" value="${esc(a?.handle || '')}" placeholder="${esc(HANDLE_HINT[p])}">
        <button type="button" class="btn small primary" data-act="link">${a ? 'Save' : 'Link'}</button>
        ${a ? '<button type="button" class="btn small ghost" data-act="unlink">Unlink</button>' : ''}
      </div>
      ${a?.status === 'approved' ? `<a class="small" href="${esc(a.channel_url)}" target="_blank" rel="noopener">${esc(a.channel_url)}</a>` : ''}
      ${liveBit}${keyBit}${keyForm}
    </div>`;
  };
  el.innerHTML = `<div class="panel-title" style="margin:0">${icon('live')} My streams <span class="sub">Twitch · YouTube · Kick</span></div>
    <p class="muted small" style="margin:0">Link the channels you stream on. Staff check each one, then it shows on the <a href="#/streams">Streams</a> tab and WPG's Discord says when you go live. Keep streaming the way you do now — the app shows your stream and chat.</p>
    <p class="small" style="margin:0">${icon('lock', 'width="14" height="14" style="vertical-align:-2px"')} <b>Stream keys:</b> saving one is optional. It's encrypted the moment you save it and is <b>never shown again</b> — not to you, not to staff. You can only replace or remove it. If you think your key has leaked, reset it on the platform.</p>
    ${PLATFORM_ORDER.map(block).join('')}`;

  const reload = () => myStreamsPanel(el).catch(fail);
  el.querySelectorAll('.stream-acct').forEach((box) => {
    const p = box.dataset.platform;
    const act = (name, fn) => box.querySelector(`[data-act="${name}"]`)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await fn(); } catch (x) { fail(x); btn.disabled = false; }
    });
    act('link', async () => {
      const r = await api(`me/streams/${p}`, { method: 'PUT', body: { handle: box.querySelector('[name=handle]').value } });
      toast('Saved', r.status === 'pending' ? 'Staff will check your channel soon.' : 'Up to date.');
      reload();
    });
    act('unlink', async () => {
      if (!(await confirmBox(`Unlink your ${NAMES[p]} channel? Your saved stream key for it is deleted too.`))) { reload(); return; }
      await api(`me/streams/${p}`, { method: 'DELETE' });
      reload();
    });
    act('key-save', async () => {
      const input = box.querySelector('[name=stream_key]');
      const key = input.value;
      input.value = ''; // don't leave it sitting in the page
      await api(`me/streams/${p}/key`, { method: 'PUT', body: { key } });
      toast('Stream key saved', 'It is encrypted and hidden for good.');
      reload();
    });
    act('key-replace', async () => {
      box.querySelector('[data-keyform]').hidden = false;
      box.querySelector('[name=stream_key]').focus();
    });
    act('key-remove', async () => {
      if (!(await confirmBox(`Remove your saved ${NAMES[p]} stream key?`))) { reload(); return; }
      await api(`me/streams/${p}/key`, { method: 'DELETE' });
      reload();
    });
    act('live', async () => {
      const url = box.querySelector('[name=live_url]')?.value || '';
      const r = await api(`me/streams/${p}/live`, { method: 'POST', body: { url } });
      toast('You\'re live!', 'You\'re on the Streams tab now.', { link: `#/streams/${r.id}` });
      reload();
    });
    act('end', async () => {
      await api(`me/streams/${p}/live`, { method: 'DELETE' });
      reload();
    });
  });
}

// ---------- Command panel: Streams (mods + admins) ----------
export async function streamsAdminTab(body) {
  const d = await api('admin/streams');
  const pending = d.accounts.filter((a) => a.status === 'pending');
  const row = (a) => `<div class="item" data-id="${a.id}">
      ${a.user ? userLine(a.user) : '<div class="grow">Unknown member</div>'}
      <div class="stream-admin-side">
        <div class="row" style="gap:6px">${platformPill(a.platform)} ${STATUS[a.status] || ''} ${a.is_live ? livePill() : ''}</div>
        <a class="small" href="${esc(a.channel_url)}" target="_blank" rel="noopener" style="overflow-wrap:anywhere">${esc(a.channel_url)}</a>
        <div class="row" style="gap:6px">
          ${a.status !== 'approved' ? '<button class="btn small primary" data-act="approve">Approve</button>' : ''}
          ${a.status !== 'rejected' ? '<button class="btn small ghost" data-act="reject">Reject</button>' : ''}
          <button class="btn small ghost" data-act="remove" title="Remove">${icon('trash')}</button>
        </div>
      </div></div>`;
  const autoLine = Object.entries(d.platforms).map(([k, p]) => `${esc(p.name)}: ${p.auto
    ? (d.problems[k] ? `<span style="color:var(--red)">problem — ${esc(d.problems[k].message)}</span>` : '<b>automatic</b>') : '<span style="color:#f5a524">"I\'m live" button (no API key)</span>'}`).join(' · ');
  const c = await api('admin/stream-chat').catch(() => null);
  const copy = (t) => `<code style="overflow-wrap:anywhere;background:#06101c;border:1px solid var(--line);border-radius:6px;padding:2px 6px">${esc(t)}</code>`;
  const chatSetup = c ? `<div class="panel">
      <div class="panel-title">${icon('chat')} Linked accounts <span class="sub">members chat with their own Twitch / YouTube / Kick account</span></div>
      <p class="small" style="margin:0 0 8px"><b>Twitch</b> ${c.twitch.ready ? '✅' : '⬜ needs TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET'} — in the Twitch developer console, add this <b>OAuth Redirect URL</b> to the app: ${copy(c.twitch.redirect)}</p>
      <p class="small" style="margin:0 0 6px"><b>Kick</b> ${c.kick.ready ? '✅' : '⬜ needs KICK_CLIENT_ID + KICK_CLIENT_SECRET'} — in Kick's developer settings for the app: <b>Redirect URL</b> ${copy(c.kick.redirect)}, turn <b>Webhooks</b> on with the URL ${copy(c.kick.webhook)}, and tick the <b>chat:write</b>, <b>user:read</b> and <b>events:subscribe</b> scopes.</p>
      <p class="small" style="margin:0 0 8px"><b>YouTube</b> ${c.youtube.ready ? '✅' : '⬜ needs GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET'} — in Google Cloud (the project with <b>YouTube Data API v3</b> turned on): <b>APIs &amp; Services → Credentials → Create OAuth client ID → Web application</b>, add the <b>Authorized redirect URI</b> ${copy(c.youtube.redirect)}. On the <b>OAuth consent screen</b> add the <b>youtube.force-ssl</b> scope and press <b>Publish app</b> (Google shows members an "unverified app" warning until Google verifies it).${c.youtube.quota_problem_at ? ` <span style="color:var(--red)">YouTube allowance ran out ${esc(timeAgo(c.youtube.quota_problem_at))}.</span>` : ''}</p>
      <p class="small muted" style="margin:0">Kick chat: reading ${fmtNum(c.kick.channels_reading)} channel${c.kick.channels_reading === 1 ? '' : 's'}${c.kick.last_message_at ? `, last message ${esc(timeAgo(c.kick.last_message_at))}` : ''}${c.kick.problem ? ` · <span style="color:var(--red)">${esc(c.kick.problem)}</span>` : ''}</p>
    </div>` : '';
  body.innerHTML = `<div class="stack">
    <div class="panel">
      <div class="panel-title">${icon('live')} Streams <span class="sub">${pending.length} waiting</span></div>
      <p class="muted small" style="margin:0 0 6px">Open each channel link and check it really belongs to that member before approving. Approved channels show on the Streams tab and get a Discord post when they go live.</p>
      <p class="small" style="margin:0 0 6px">Spotting live streams — ${autoLine}</p>
      <p class="muted small" style="margin:0">Keys go in Render → Environment: <b>TWITCH_CLIENT_ID</b> + <b>TWITCH_CLIENT_SECRET</b>, <b>YOUTUBE_API_KEY</b>, <b>KICK_CLIENT_ID</b> + <b>KICK_CLIENT_SECRET</b>. Discord posts: Settings → Streams.</p>
    </div>
    ${chatSetup}
    <div class="panel"><div class="panel-title">Channels <span class="sub">${d.accounts.length}</span></div>
      <div class="list">${d.accounts.map(row).join('') || '<p class="empty">No channels linked yet.</p>'}</div></div>
  </div>`;
  body.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const id = b.closest('[data-id]').dataset.id;
      try {
        if (b.dataset.act === 'remove') {
          if (!(await confirmBox('Remove this channel? The member can link it again.'))) return;
          await api(`admin/streams/${id}`, { method: 'DELETE' });
        } else {
          await api(`admin/streams/${id}/${b.dataset.act}`, { method: 'POST', body: {} });
        }
        streamsAdminTab(body);
      } catch (x) { fail(x); }
    };
  });
}
