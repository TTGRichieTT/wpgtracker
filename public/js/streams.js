// Streams tab: who is live, the stream's own player and chat, and WPG chat underneath.
// Also the "My streams" box on Edit profile and the Streams tab in the Command panel.
import { api, esc, state, toast, fail, confirmBox, onLive, avatar, fmtNum, fmtTime, fmtDate, timeAgo, userLine } from './app.js';
import { icon } from './icons.js';

const PLATFORM_ORDER = ['twitch', 'youtube', 'kick', 'facebook'];
const NAMES = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', facebook: 'Facebook' };
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
  if (s.platform === 'facebook') return s.live_url ? `https://www.facebook.com/plugins/video.php?href=${enc(s.live_url)}&show_text=false&autoplay=true` : '';
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
  if (s.platform === 'facebook') return s.live_url || s.channel_url;
  if (s.platform === 'youtube' && s.video_id) return `https://www.youtube.com/watch?v=${enc(s.video_id)}`;
  return s.channel_url;
}
const watchOutside = (s) => s.live_url || (s.platform === 'youtube' && s.video_id ? `https://www.youtube.com/watch?v=${enc(s.video_id)}` : s.channel_url);
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
        : `<div class="panel empty"><h3>Nobody is live right now</h3><p>When a WPG streamer goes live on Twitch, YouTube, Kick or Facebook it shows here — watch and chat without leaving the app.</p></div>`}
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
  let chatTab = chatSrc(s) ? 'platform' : 'wpg';

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

  const platformChatHtml = () => {
    const src = chatSrc(s);
    if (src) return frame(src, `${NAMES[s.platform]} chat`, 'stream-chat-frame');
    const why = {
      kick: 'Kick doesn\'t let other sites show its chat.',
      facebook: 'Facebook doesn\'t let other sites show live comments.',
      youtube: s.is_live ? 'YouTube chat shows here once the app knows which video is live.' : 'YouTube chat shows here while the stream is live.',
    }[s.platform] || '';
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
        <div class="stream-chat" data-pane="platform">${platformChatHtml()}</div>
        <div class="stream-chat" data-pane="wpg">
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
      main.querySelector('[data-pane="platform"]').innerHTML = platformChatHtml();
    }
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
  facebook: 'Page name or link, e.g. facebook.com/WPGRichie',
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
      : `<div class="small"><span class="muted">${auto && p !== 'facebook' ? 'Shows as live by itself within about 2 minutes of you starting.' : `Going live? Press <b>I'm live</b>${p === 'facebook' ? ' and paste the link to your live video' : p === 'youtube' ? ' and paste your live video link' : ''}.`}</span>
          <div class="row" style="margin-top:6px">${p === 'facebook' || (p === 'youtube' && !auto) ? `<input type="url" name="live_url" class="grow" style="min-width:180px" placeholder="${p === 'facebook' ? 'https://www.facebook.com/…/videos/…' : 'https://www.youtube.com/live/…'}">` : ''}
          <button type="button" class="btn small${auto && p !== 'facebook' ? ' ghost' : ' primary'}" data-act="live">● I'm live</button></div></div>`;
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
  el.innerHTML = `<div class="panel-title" style="margin:0">${icon('live')} My streams <span class="sub">Twitch · YouTube · Kick · Facebook</span></div>
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
  const autoLine = Object.entries(d.platforms).map(([k, p]) => `${esc(p.name)}: ${k === 'facebook' ? '<span class="muted">"I\'m live" button</span>'
    : p.auto ? (d.problems[k] ? `<span style="color:var(--red)">problem — ${esc(d.problems[k].message)}</span>` : '<b>automatic</b>') : '<span style="color:#f5a524">"I\'m live" button (no API key)</span>'}`).join(' · ');
  body.innerHTML = `<div class="stack">
    <div class="panel">
      <div class="panel-title">${icon('live')} Streams <span class="sub">${pending.length} waiting</span></div>
      <p class="muted small" style="margin:0 0 6px">Open each channel link and check it really belongs to that member before approving. Approved channels show on the Streams tab and get a Discord post when they go live.</p>
      <p class="small" style="margin:0 0 6px">Spotting live streams — ${autoLine}</p>
      <p class="muted small" style="margin:0">Keys go in Render → Environment: <b>TWITCH_CLIENT_ID</b> + <b>TWITCH_CLIENT_SECRET</b>, <b>YOUTUBE_API_KEY</b>, <b>KICK_CLIENT_ID</b> + <b>KICK_CLIENT_SECRET</b>. Discord posts: Settings → Streams.</p>
    </div>
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
