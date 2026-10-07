// Live match money from Steam (server/steambot.js): the panel on a member's profile, and Admin → Steam bot.
import { api, esc, toast, fail, confirmBox, fmtNum, timeAgo, refreshMe } from './app.js';
import { icon } from './icons.js';

export const signedMoney = (n) => (n === null || n === undefined ? '' : `${n < 0 ? '-' : '+'}$${fmtNum(Math.abs(n))}`);
const moneyClass = (n) => (n > 0 ? 'good' : n < 0 ? 'bad' : '');

// ---------- Profile ----------
export async function profileLivePanel(box, user) {
  let d;
  try {
    d = await api(`users/${user.id}/live`);
  } catch {
    box.innerHTML = '';
    return;
  }
  if (!d.mine && !d.on) { box.innerHTML = ''; return; }
  const friendLine = {
    requested: `The <b>WPG Barracks</b> Steam account has sent you a friend request: accept it in Steam (Friends → Friend requests)${d.bot.profile ? `, or <a href="${esc(d.bot.profile)}" target="_blank" rel="noopener">open its Steam profile</a>` : ''}. Until then it can still read your status while you play, when Steam allows.`,
    friends: '✓ Connected: the WPG Barracks Steam account is your friend.',
    blocked: "You've blocked the WPG Barracks Steam account in Steam, so it can't see your status. Unblock it, then switch this off and on again.",
    add_bot: `Steam didn't let the bot send you a friend request, so add it yourself: ${d.bot.profile ? `<a href="${esc(d.bot.profile)}" target="_blank" rel="noopener"><b>open its Steam profile</b></a> and press <b>Add Friend</b>` : 'its Steam profile link shows here once it is online'}. It accepts straight away.`,
    none: d.bot.online ? 'Sending the friend request…' : "The bot is offline right now: it sends your friend request as soon as it's back.",
  }[d.friend] || '';
  const live = d.live;
  const t = d.tonight;
  box.innerHTML = `<div class="panel">
    <div class="row between" style="align-items:flex-start">
      <div class="panel-title" style="margin-bottom:6px">${icon('coins')} Live match money <span class="sub">from Steam</span></div>
      ${d.mine && d.realSteam ? `<label class="row small" style="gap:6px"><input type="checkbox" id="liveToggle" ${d.on ? 'checked' : ''}> Show my live match money</label>` : ''}
    </div>
    ${d.on ? `
      <div class="tiles" style="margin-bottom:8px">
        <div class="tile"><div class="ic">${icon('swords')}</div><div class="grow"><div class="lbl">${live?.inGame ? 'In a match now' : 'Last reading'}</div>
          <div class="val ${moneyClass(live?.money)}">${live ? esc(live.text) : '—'}</div>${live?.at ? `<div class="muted small">${esc(timeAgo(live.at))}</div>` : ''}</div></div>
        <div class="tile"><div class="ic">${icon('coins')}</div><div class="grow"><div class="lbl">Tonight (last 12 hours)</div>
          <div class="val ${moneyClass(t?.total)}">${t?.matches ? signedMoney(t.total) : '—'}</div>${t?.matches ? `<div class="muted small">${t.matches} match${t.matches === 1 ? '' : 'es'} · ${t.wins} won</div>` : ''}</div></div>
      </div>
      ${d.mine && d.invite ? `<div class="row" style="gap:10px;margin:4px 0 8px"><a class="btn primary small" href="${esc(d.invite)}" target="_blank" rel="noopener">${icon('steam')} Add the bot on Steam</a>
        <span class="muted small">Opens Steam to add the <b>WPG Barracks</b> account as a friend (your own link, works once, valid 7 days).</span></div>` : ''}
      ${d.mine && !(d.invite && d.friend !== 'blocked') ? `<p class="muted small" style="margin:0">${friendLine}</p>` : ''}`
    : d.mine ? `<p class="muted small" style="margin:0">${d.realSteam
      ? "Shows what you're making in Wardogs matches, live, in the app and on Discord (/money). It reads the line Steam shows your friends under your name while you play: switch it on, then add the <b>WPG Barracks</b> Steam account as a friend with the button that appears (or accept its friend request). Switch it off (or unfriend it) any time."
      : 'Only real Steam accounts can show live match money.'}</p>` : ''}
  </div>`;
  box.querySelector('#liveToggle')?.addEventListener('change', async (e) => {
    try {
      const r = await api('me/live', { method: 'PUT', body: { on: e.target.checked } });
      toast(e.target.checked ? 'Live match money on' : 'Live match money off', e.target.checked ? r.note || 'Accept the friend request from the WPG Barracks Steam account in Steam.' : '');
      await refreshMe();
      profileLivePanel(box, user);
    } catch (x) {
      e.target.checked = !e.target.checked;
      fail(x);
    }
  });
}

// ---------- Admin → Steam bot ----------
export async function steamBotAdminTab(body) {
  const d = await api('admin/steambot');
  const s = d.status;
  const stateText = { off: 'Off', connecting: 'Connecting…', guard: 'Waiting for a Steam Guard code', online: 'Online', error: 'Problem' }[s.state] || s.state;
  const color = { online: 'var(--green)', guard: '#f5a524', error: 'var(--red)', connecting: '#f5a524' }[s.state] || 'var(--muted)';
  const yes = (b) => (b ? '<span style="color:var(--green)">✓ set</span>' : '<span style="color:var(--red)">✕ missing</span>');
  body.innerHTML = `
    <div class="panel">
      <div class="panel-title">${icon('steam')} Steam bot <span class="sub">live match money</span></div>
      <p class="muted small" style="margin-top:0">A separate WPG Barracks Steam account that members friend so the app can read the line Steam shows under their name in Wardogs (e.g. "-$10,793 Loss"). Never use anyone's own account, and don't play on it.</p>
      <div class="tiles" style="margin-bottom:12px">
        <div class="tile"><div class="ic">${icon('server')}</div><div class="grow"><div class="lbl">Status</div><div class="val" style="color:${color}">${esc(stateText)}</div>
          ${s.name ? `<div class="muted small">${esc(s.name)}${s.since ? ` · since ${esc(timeAgo(s.since))}` : ''}</div>` : ''}</div></div>
        <div class="tile"><div class="ic">${icon('users')}</div><div class="grow"><div class="lbl">Members switched on</div><div class="val">${fmtNum(d.counts.on_count)}</div>
          <div class="muted small">${fmtNum(d.counts.friends)} friends · ${fmtNum(d.counts.pending)} friend requests waiting${d.counts.add_bot ? ` · ${fmtNum(d.counts.add_bot)} need to add the bot themselves` : ''}</div></div></div>
      </div>
      ${s.error ? `<p class="small" style="color:${s.state === 'error' ? 'var(--red)' : 'var(--muted)'}">${esc(s.error)}</p>` : ''}
      ${s.guard ? `<form class="row" id="guardForm" style="align-items:flex-end;margin-bottom:12px">
          <label class="field"><span>Steam Guard code${s.guard.domain ? ` (emailed to …@${esc(s.guard.domain)})` : ' (Steam mobile app)'}</span><input type="text" name="code" maxlength="5" autocomplete="one-time-code" required style="text-transform:uppercase"></label>
          <button class="btn primary">Send code</button></form>` : ''}
      ${d.profile ? `<p class="small" style="margin:0 0 10px">Bot's Steam profile: <a href="${esc(d.profile)}" target="_blank" rel="noopener">${esc(d.profile)}</a></p>` : ''}
      <div class="row" style="gap:8px;margin-bottom:12px">
        <button class="btn" id="botReconnect">${icon('refresh')} Reconnect</button>
        ${d.setup.savedLogin ? '<button class="btn ghost" id="botForget">Forget saved Steam sign-in</button>' : ''}
        <label class="row small" style="gap:6px"><input type="checkbox" id="botEnabled" ${d.settings.enabled ? 'checked' : ''}> Bot switched on</label>
      </div>
      <h4 style="margin:6px 0">Setup (Render → Environment)</h4>
      <p class="small" style="margin:0">STEAM_BOT_USERNAME ${yes(d.setup.username)} · STEAM_BOT_PASSWORD ${yes(d.setup.password)} · STEAM_BOT_SHARED_SECRET ${d.setup.sharedSecret ? '<span style="color:var(--green)">✓ set</span>' : '<span class="muted">not set (only for the Steam mobile authenticator)</span>'} · Saved Steam sign-in ${d.setup.savedLogin ? '<span style="color:var(--green)">✓ yes</span>' : '<span class="muted">not yet</span>'}</p>
      <p class="muted small">After the first login Steam's sign-in token is kept (encrypted) here, so restarts don't need a code. If Steam asks for an email code, it shows above and staff get a notification.</p>
      ${s.requestsRefused || d.counts.add_bot ? `<p class="small" style="color:#f5a524">Steam refused the bot's friend requests${s.requestsRefused ? ` (${esc(s.requestsRefused)})` : ''}. New Steam accounts are "limited" and can't send friend requests until $5 has been spent on or added to the account. Add $5 to its Steam wallet, or members add the bot themselves (their profile shows how). It accepts members' requests either way.</p>` : ''}
      ${s.pollWorks === false ? '<p class="small" style="color:#f5a524">Steam isn\'t sharing statuses with the bot for members who haven\'t accepted its friend request, so they need to accept it.</p>' : ''}
    </div>
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">${icon('megaphone')} Discord</div>
      <div class="row" style="align-items:flex-end;gap:12px">
        <label class="row small" style="gap:6px"><input type="checkbox" id="bigWins" ${d.settings.bigWins ? 'checked' : ''}> Post big wins (WPG members only)</label>
        <label class="field"><span>Big win: at least ($)</span><input type="number" id="bigWinAmount" min="1000" step="1000" value="${esc(d.settings.bigWinAmount)}"></label>
        <button class="btn" id="saveDiscord">Save</button>
      </div>
      <p class="muted small">Members can also type <b>/money</b> in Discord: who's in a match now and tonight's totals.</p>
    </div>
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">${icon('chart')} What Steam sends <span class="sub">last 40 changes (kept 3 days)</span></div>
      <p class="muted small" style="margin-top:0">The raw values behind each status line, to check what Wardogs sends (is it a running total during a match, or only the result at the end?).</p>
      <div class="list">${d.log.map((l) => `<div class="item"><div class="grow"><b>${esc(l.name)}</b> <span class="muted small">${esc(timeAgo(l.at))}</span>
        <div>${esc(l.text) || '<span class="muted">(no text)</span>'}</div>
        <div class="muted small" style="word-break:break-all">${esc(Object.entries(l.raw || {}).map(([k, v]) => `${k}=${v}`).join(' · '))}</div></div></div>`).join('') || '<p class="empty">Nothing yet: it fills in when members with it switched on play Wardogs.</p>'}</div>
    </div>`;
  const reload = () => steamBotAdminTab(body);
  body.querySelector('#guardForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('admin/steambot/guard', { method: 'POST', body: { code: e.target.code.value } });
      toast('Code sent', 'Logging in…');
      setTimeout(reload, 4000);
    } catch (x) { fail(x); }
  });
  body.querySelector('#botReconnect').onclick = async () => {
    try {
      await api('admin/steambot/reconnect', { method: 'POST', body: {} });
      toast('Reconnecting…');
      setTimeout(reload, 5000);
    } catch (x) { fail(x); }
  };
  body.querySelector('#botForget')?.addEventListener('click', async () => {
    if (!(await confirmBox("Forget the saved Steam sign-in? The next login uses the password (and may ask for a Steam Guard code)."))) return;
    try { await api('admin/steambot/forget', { method: 'POST', body: {} }); reload(); } catch (x) { fail(x); }
  });
  body.querySelector('#botEnabled').onchange = async (e) => {
    try { await api('admin/steambot/settings', { method: 'PUT', body: { enabled: e.target.checked } }); setTimeout(reload, 2500); } catch (x) { fail(x); }
  };
  body.querySelector('#saveDiscord').onclick = async () => {
    try {
      await api('admin/steambot/settings', { method: 'PUT', body: { bigWins: body.querySelector('#bigWins').checked, bigWinAmount: Number(body.querySelector('#bigWinAmount').value) } });
      toast('Saved');
    } catch (x) { fail(x); }
  };
}
