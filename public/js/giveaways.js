// Giveaways: the members' page (what's on, entering, your prizes) and Admin → Giveaways (making and running them).
import { api, esc, toast, fail, modal, confirmBox, onLive, fmtNum, fmtDate, fmtTime, timeAgo } from './app.js';
import { icon } from './icons.js';

const when = (d) => `${fmtDate(d)} ${fmtTime(d)}`;
// "in 3h 20m", "in 2d 4h", "in 5m"
function until(d) {
  const s = Math.max(0, Math.round((new Date(d).getTime() - Date.now()) / 1000));
  if (s < 60) return 'in under a minute';
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}
const mins = (n) => (n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ''}` : `${n}m`);

const WIN_STATUS = {
  given: ['Yours', 'var(--green)'],
  won: ['Claim it', '#f5a524'],
  claimed: ['Claimed: staff will send it', 'var(--accent2)'],
  sent: ['Sent', 'var(--green)'],
  expired: ['Not claimed in time', 'var(--muted)'],
};

// What has to be done on the WPG server, with your progress once it's live.
function rulesHtml(g) {
  const p = g.progress || { minutes: 0, matches: 0, kills: 0 };
  const rules = [
    g.min_minutes && [`${mins(g.min_minutes)} played`, p.minutes >= g.min_minutes, mins(p.minutes)],
    g.min_matches && [`${fmtNum(g.min_matches)} match${g.min_matches === 1 ? '' : 'es'}`, p.matches >= g.min_matches, fmtNum(p.matches)],
    g.min_kills && [`${fmtNum(g.min_kills)} kill${g.min_kills === 1 ? '' : 's'}`, p.kills >= g.min_kills, fmtNum(p.kills)],
  ].filter(Boolean);
  if (!rules.length) return '';
  const open = g.status === 'open';
  return `<div class="ga-rules"><div class="small muted" style="margin-bottom:4px">On the WPG server during the giveaway (counted as each match ends):</div>
    ${rules.map(([label, done, have]) => `<div class="small">${open && done ? '✅' : '⬜'} ${esc(label)}${open ? ` <span class="muted">(you: ${esc(have)})</span>` : ''}</div>`).join('')}</div>`;
}

function liveCard(g) {
  const drop = g.kind === 'drop';
  const open = g.status === 'open';
  const timing = open
    ? drop ? `${fmtNum(g.drops_left)} drop${g.drops_left === 1 ? '' : 's'} left · ends ${until(g.end_at)}` : `Ends ${until(g.end_at)} (${when(g.end_at)})`
    : `Starts ${until(g.start_at)} (${when(g.start_at)})`;
  let action = '';
  if (!g.can_win) action = `<p class="small muted" style="margin:0">${g.who === 'members' ? 'This one is for WPG members.' : 'Staff can\'t win this one.'}</p>`;
  else if (drop) action = '<p class="small" style="margin:0">Be on the <b>WPG server</b> while drops are live: at random moments, someone on the server wins.</p>';
  else if (g.entry === 'auto') action = '<p class="small" style="margin:0">No need to enter: play on the <b>WPG server</b> during the giveaway and you\'re in.</p>';
  else action = g.entered
    ? `<div class="row" style="gap:8px"><span style="color:var(--green);font-weight:700">✓ You're in</span><button class="btn small ghost" data-leave="${g.id}">Leave</button></div>`
    : `<button class="btn primary" data-enter="${g.id}">${icon('plus')} Enter</button>`;
  return `<div class="panel ga-card${open ? ' glow' : ''}">
    ${g.image ? `<img class="ga-img" src="${esc(g.image)}" alt="" loading="lazy">` : ''}
    <div class="row between" style="gap:8px;align-items:flex-start">
      <div><span class="pill ${drop ? 'mod' : ''}">${drop ? 'Random drops' : 'Giveaway'}</span> ${open ? '<span class="pill" style="color:var(--green);border-color:var(--green)">Live</span>' : '<span class="pill">Coming up</span>'}</div>
      <span class="small muted">${esc(timing)}</span>
    </div>
    <h3 style="margin:8px 0 4px">${esc(g.title)}</h3>
    <div class="ga-prize">${icon('gift')} ${esc(g.prize)}${g.winners > 1 && !drop ? ` <span class="muted small">× ${fmtNum(g.winners)} winners</span>` : ''}</div>
    ${g.description ? `<p class="small" style="margin:8px 0;white-space:pre-line">${esc(g.description)}</p>` : ''}
    ${rulesHtml(g)}
    <div style="margin-top:10px">${action}</div>
    ${!drop && g.entry === 'enter' ? `<p class="small muted" style="margin:8px 0 0">${fmtNum(g.entrants)} entered${g.who === 'everyone' ? ' · PMCs welcome' : ''}</p>` : ''}
  </div>`;
}

export async function viewGiveaways(main) {
  const d = await api('giveaways');
  onLive('config', (name) => { if (name === 'giveaways') viewGiveaways(main); });
  const live = d.live.filter((g) => g.status === 'open');
  const soon = d.live.filter((g) => g.status !== 'open');
  main.innerHTML = `<h1>${icon('gift', 'width="28" height="28" style="vertical-align:-4px;color:var(--accent)"')} Giveaways</h1>
    ${d.mine.length ? `<div class="panel"><div class="panel-title">${icon('star')} Your prizes</div>
      <div class="list">${d.mine.map((w) => `<div class="item"><div class="grow"><b>${esc(w.prize)}</b> <span class="muted small">· ${esc(w.title)} · won ${esc(timeAgo(w.won_at))}</span>
          ${w.status === 'won' ? `<div class="small" style="color:#f5a524">Claim by ${esc(when(w.claim_by))}</div>` : ''}
          ${w.code ? `<div class="small" style="margin-top:4px">Your code: <code class="ga-code">${esc(w.code)}</code></div>` : ''}</div>
        ${w.status === 'won' ? `<button class="btn primary small" data-claim="${w.id}">${icon('gift')} Claim</button>` : `<span class="small" style="color:${WIN_STATUS[w.status]?.[1]}">${esc(WIN_STATUS[w.status]?.[0] || w.status)}</span>`}</div>`).join('')}</div></div>` : ''}
    ${live.length ? `<div class="ga-grid">${live.map(liveCard).join('')}</div>` : '<div class="panel empty"><p>No giveaways running right now. Keep an eye on Discord and the WPG server: random drops can happen any time.</p></div>'}
    ${soon.length ? `<h2 style="margin:20px 0 10px">Coming up</h2><div class="ga-grid">${soon.map(liveCard).join('')}</div>` : ''}
    ${d.past.length ? `<div class="panel" style="margin-top:16px"><div class="panel-title">${icon('trophy')} Past winners</div>
      <div class="list">${d.past.map((g) => `<div class="item"><div class="grow"><b>${esc(g.title)}</b> <span class="muted small">· ${esc(g.prize)} · ${esc(fmtDate(g.end_at))}</span>
        <div class="small">${g.winners_list.length ? g.winners_list.map((w) => `<a href="#/u/${w.id}">${esc(w.name)}</a>`).join(', ') : '<span class="muted">No winner</span>'}</div></div></div>`).join('')}</div></div>` : ''}`;
  main.querySelectorAll('[data-enter]').forEach((b) => { b.onclick = async () => { try { await api(`giveaways/${b.dataset.enter}/enter`, { method: 'POST', body: {} }); toast('You\'re in', 'Good luck!'); viewGiveaways(main); } catch (x) { fail(x); } }; });
  main.querySelectorAll('[data-leave]').forEach((b) => { b.onclick = async () => { try { await api(`giveaways/${b.dataset.leave}/enter`, { method: 'DELETE' }); viewGiveaways(main); } catch (x) { fail(x); } }; });
  main.querySelectorAll('[data-claim]').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api(`giveaways/wins/${b.dataset.claim}/claim`, { method: 'POST', body: {} });
        toast('Claimed!', r.code ? 'Your code is shown under the prize.' : 'Staff have been told and will send it to you.');
        viewGiveaways(main);
      } catch (x) { fail(x); }
    };
  });
}

// ---------- Admin → Giveaways ----------
const STATUS = { scheduled: ['Coming up', 'var(--accent2)'], open: ['Live', 'var(--green)'], done: ['Finished', 'var(--muted)'], cancelled: ['Cancelled', 'var(--red)'] };
const localInput = (d) => {
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`;
};

export async function giveawaysAdminTab(body) {
  const d = await api('admin/giveaways');
  body.innerHTML = `<div class="panel">
      <div class="row between"><div class="panel-title" style="margin:0">${icon('gift')} Giveaways</div><button class="btn primary" id="gaNew">${icon('plus')} New giveaway</button></div>
      <p class="muted small">A <b>giveaway</b> runs between two times and draws its winners at the end. <b>Random drops</b> pick secret random moments in a time window and give the prize to someone on the WPG server right then.
        Clan XP, WPG XP and medals are given automatically; real prizes are claimed by the winner in the app and you mark them sent here.
        Server: ${d.servers.length ? esc(d.servers.join(', ')) : '<span style="color:var(--red)">none ticked "Matches here earn WPG XP" with RCON (Admin → Game servers): drops and requirements need one</span>'}.</p>
    </div>
    ${d.list.length ? d.list.map((g) => `<div class="panel ga-admin">
      <div class="row between" style="gap:8px">
        <div><b style="font:700 18px var(--head);text-transform:uppercase">${esc(g.title)}</b>
          <span class="pill ${g.kind === 'drop' ? 'mod' : ''}">${g.kind === 'drop' ? 'Random drops' : 'Giveaway'}</span>
          <b class="small" style="color:${STATUS[g.status][1]}">${STATUS[g.status][0]}</b></div>
        <div class="row" style="gap:6px">
          ${['scheduled', 'open'].includes(g.status) ? `<button class="btn small" data-edit="${g.id}">${icon('edit')} Edit</button>` : ''}
          ${g.status === 'open' ? `<button class="btn small primary" data-draw="${g.id}">${g.kind === 'drop' ? 'Drop one now' : 'End & draw now'}</button>` : ''}
          ${['scheduled', 'open'].includes(g.status) ? `<button class="btn small ghost" data-cancel="${g.id}">Cancel</button>` : `<button class="btn small ghost" data-del="${g.id}">${icon('trash')}</button>`}
        </div>
      </div>
      <div class="small" style="margin-top:6px">${icon('gift')} <b>${esc(g.prize)}</b> · ${g.kind === 'drop' ? `${fmtNum(g.winners)} drop${g.winners === 1 ? '' : 's'}${g.drops_left !== null && g.status !== 'done' ? ` (${fmtNum(g.drops_left)} left)` : ''}` : `${fmtNum(g.winners)} winner${g.winners === 1 ? '' : 's'}`}
        · ${esc(when(g.start_at))} → ${esc(when(g.end_at))} · ${g.who === 'everyone' ? 'members + PMCs' : 'WPG members'}${g.no_staff ? ', no staff' : ''}
        ${g.kind === 'scheduled' ? ` · ${g.entry === 'auto' ? 'everyone who plays is entered' : `${fmtNum(g.entrants)} entered`}` : ''}
        ${g.min_minutes || g.min_matches || g.min_kills ? ` · needs ${[g.min_minutes && mins(g.min_minutes), g.min_matches && `${g.min_matches} matches`, g.min_kills && `${g.min_kills} kills`].filter(Boolean).join(', ')}` : ''}
        ${g.codes ? ` · ${g.codes} code${g.codes === 1 ? '' : 's'} saved` : ''}</div>
      ${g.winners_list.length ? `<div class="list" style="margin-top:8px">${g.winners_list.map((w) => `<div class="item"><div class="grow"><a href="#/u/${w.user_id}"><b>${esc(w.name)}</b></a>
          <span class="small" style="color:${WIN_STATUS[w.status]?.[1]}"> · ${esc(w.status === 'won' ? 'waiting to claim' : WIN_STATUS[w.status]?.[0] || w.status)}</span> <span class="muted small">· ${esc(timeAgo(w.won_at))}</span></div>
          ${['won', 'claimed'].includes(w.status) && g.reward_type === 'item' ? `<button class="btn small" data-sent="${w.id}">Mark sent</button>` : ''}
          ${['won', 'expired'].includes(w.status) ? `<button class="btn small ghost" data-redraw="${w.id}">Draw someone else</button>` : ''}</div>`).join('')}</div>` : ''}
    </div>`).join('') : '<div class="panel empty"><p>No giveaways yet. Press <b>New giveaway</b> to make one.</p></div>'}`;

  const reload = () => giveawaysAdminTab(body);
  const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg(r)); reload(); } catch (x) { fail(x); } };
  body.querySelector('#gaNew').onclick = () => giveawayForm(null, d, reload);
  body.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => giveawayForm(d.list.find((g) => g.id === Number(b.dataset.edit)), d, reload); });
  body.querySelectorAll('[data-draw]').forEach((b) => {
    b.onclick = async () => {
      const g = d.list.find((x) => x.id === Number(b.dataset.draw));
      if (!(await confirmBox(g.kind === 'drop' ? 'Do the next random drop right now (to someone on the WPG server)?' : `End "${g.title}" now and draw the winner${g.winners > 1 ? 's' : ''}?`))) return;
      act(() => api(`admin/giveaways/${g.id}/draw`, { method: 'POST', body: {} }), (r) => (r.winners.length ? `Winner: ${r.winners.join(', ')}` : r.note));
    };
  });
  body.querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = async () => { if (await confirmBox('Cancel this giveaway? Nobody will win it.')) act(() => api(`admin/giveaways/${b.dataset.cancel}/cancel`, { method: 'POST', body: {} }), () => 'Cancelled'); }; });
  body.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { if (await confirmBox('Delete this giveaway and its winner list for good?')) act(() => api(`admin/giveaways/${b.dataset.del}`, { method: 'DELETE' }), () => 'Deleted'); }; });
  body.querySelectorAll('[data-sent]').forEach((b) => { b.onclick = () => act(() => api(`admin/giveaways/winners/${b.dataset.sent}/sent`, { method: 'POST', body: {} }), () => 'Marked as sent'); });
  body.querySelectorAll('[data-redraw]').forEach((b) => { b.onclick = async () => { if (await confirmBox('Draw someone else for this prize? The current winner loses it.')) act(() => api(`admin/giveaways/winners/${b.dataset.redraw}/redraw`, { method: 'POST', body: {} }), (r) => `New winner: ${r.winner}`); }; });
}

async function giveawayForm(g, d, done) {
  const medals = await api('admin/awards').catch(() => []);
  const now = Date.now();
  const v = g || {
    kind: 'scheduled', title: '', description: '', image: '', reward_type: 'item', reward_text: '', reward_amount: 500, reward_medal: null, winners: 1,
    start_at: new Date(now + 5 * 60000).toISOString(), end_at: new Date(now + 7 * 86400000).toISOString(),
    who: 'members', no_staff: false, entry: 'enter', min_minutes: 0, min_matches: 0, min_kills: 0, claim_days: 7, in_game: true,
  };
  const m = modal(`<form id="gaf" class="stack" style="max-width:640px">
    <div class="row between"><h2 style="margin:0">${g ? 'Edit giveaway' : 'New giveaway'}</h2><button type="button" class="btn ghost small" data-close>✕</button></div>
    ${g ? '' : `<div class="row" style="gap:16px">
      <label class="check"><input type="radio" name="kind" value="scheduled"${v.kind === 'scheduled' ? ' checked' : ''}> <b>Giveaway</b> <span class="small muted">(winners drawn at the end)</span></label>
      <label class="check"><input type="radio" name="kind" value="drop"${v.kind === 'drop' ? ' checked' : ''}> <b>Random drops</b> <span class="small muted">(random moments, someone on the server)</span></label></div>`}
    <label class="field"><span>Title</span><input type="text" name="title" maxlength="100" required value="${esc(v.title)}" placeholder="e.g. Weekend XP giveaway"></label>
    <label class="field"><span>Description (optional)</span><textarea name="description" maxlength="1500">${esc(v.description)}</textarea></label>
    <label class="field"><span>Picture link (optional, https)</span><input type="url" name="image" value="${esc(v.image)}"></label>
    <div class="form-grid">
      <label class="field"><span>Prize</span><select name="reward_type">
        <option value="item"${v.reward_type === 'item' ? ' selected' : ''}>Something real (staff hand it over)</option>
        <option value="clan_xp"${v.reward_type === 'clan_xp' ? ' selected' : ''}>Clan XP</option>
        <option value="wpg_xp"${v.reward_type === 'wpg_xp' ? ' selected' : ''}${d.wpg_xp_ok ? '' : ' disabled'}>WPG XP${d.wpg_xp_ok ? '' : ' (after the WPG XP switch-over)'}</option>
        <option value="medal"${v.reward_type === 'medal' ? ' selected' : ''}>A medal</option></select></label>
      <label class="field" data-for="item"><span>What is it?</span><input type="text" name="reward_text" maxlength="200" value="${esc(v.reward_text)}" placeholder="e.g. £20 Steam gift card"></label>
      <label class="field" data-for="clan_xp wpg_xp"><span>How much XP?</span><input type="number" name="reward_amount" min="1" value="${esc(v.reward_amount || 500)}"></label>
      <label class="field" data-for="medal"><span>Which medal?</span><select name="reward_medal">${medals.map((x) => `<option value="${x.id}"${v.reward_medal === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('') || '<option value="">No medals yet (Admin → Medals)</option>'}</select></label>
    </div>
    <label class="field" data-for="item"><span>Codes / keys (optional, one per line, one per winner)</span><textarea name="codes" placeholder="${g?.codes ? `${g.codes} saved. Type new ones here to replace them.` : 'Shown only to each winner, after they claim'}"></textarea></label>
    <div class="form-grid">
      <label class="field"><span data-label-winners>${v.kind === 'drop' ? 'Number of drops' : 'Number of winners'}</span><input type="number" name="winners" min="1" max="50" value="${esc(v.winners)}"></label>
      <label class="field" data-for="item"><span>Days to claim</span><input type="number" name="claim_days" min="1" max="60" value="${esc(v.claim_days)}"></label>
      <label class="field"><span>Starts</span><input type="datetime-local" name="start_at" required value="${localInput(v.start_at)}"></label>
      <label class="field"><span>Ends</span><input type="datetime-local" name="end_at" required value="${localInput(v.end_at)}"></label>
      <label class="field"><span>Who can win</span><select name="who"><option value="members"${v.who === 'members' ? ' selected' : ''}>WPG members</option><option value="everyone"${v.who === 'everyone' ? ' selected' : ''}>WPG members and PMCs</option></select></label>
      <label class="field" data-kind="scheduled"><span>Taking part</span><select name="entry"><option value="enter"${v.entry === 'enter' ? ' selected' : ''}>Members press Enter</option><option value="auto"${v.entry === 'auto' ? ' selected' : ''}>Everyone who plays on the WPG server</option></select></label>
    </div>
    <div data-kind="scheduled"><span class="small muted">Must do on the WPG server during the giveaway (0 = no need):</span>
      <div class="form-grid" style="margin-top:6px">
        <label class="field"><span>Minutes played</span><input type="number" name="min_minutes" min="0" value="${esc(v.min_minutes)}"></label>
        <label class="field"><span>Matches</span><input type="number" name="min_matches" min="0" value="${esc(v.min_matches)}"></label>
        <label class="field"><span>Kills</span><input type="number" name="min_kills" min="0" value="${esc(v.min_kills)}"></label>
      </div></div>
    <label class="check"><input type="checkbox" name="no_staff"${v.no_staff ? ' checked' : ''}> Staff (mods and admins) can't win</label>
    <label class="check"><input type="checkbox" name="in_game"${v.in_game ? ' checked' : ''}> Announce on the WPG server (start and winners)</label>
    <p class="small muted" style="margin:0">Times are in your own time zone. Winners are told in the app, on Discord (Admin → Settings → Post giveaways) and in-game.</p>
    <div class="row"><button class="btn primary">${g ? 'Save changes' : 'Create'}</button></div>
  </form>`);
  const f = m.el.querySelector('#gaf');
  m.el.querySelector('[data-close]').onclick = m.close;
  const kind = () => (g ? g.kind : f.querySelector('[name=kind]:checked').value);
  const sync = () => {
    const r = f.reward_type.value;
    f.querySelectorAll('[data-for]').forEach((el) => { el.style.display = el.dataset.for.split(' ').includes(r) ? '' : 'none'; });
    f.querySelectorAll('[data-kind]').forEach((el) => { el.style.display = el.dataset.kind === kind() ? '' : 'none'; });
    f.querySelector('[data-label-winners]').textContent = kind() === 'drop' ? 'Number of drops' : 'Number of winners';
  };
  f.addEventListener('change', sync);
  sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const b = {
      kind: kind(), title: f.title.value, description: f.description.value, image: f.image.value,
      reward_type: f.reward_type.value, reward_text: f.reward_text.value, reward_amount: f.reward_amount.value, reward_medal: f.reward_medal.value,
      codes: f.codes.value, winners: f.winners.value, claim_days: f.claim_days.value,
      start_at: new Date(f.start_at.value).toISOString(), end_at: new Date(f.end_at.value).toISOString(),
      who: f.who.value, entry: f.entry.value, min_minutes: f.min_minutes.value, min_matches: f.min_matches.value, min_kills: f.min_kills.value,
      no_staff: f.no_staff.checked, in_game: f.in_game.checked,
    };
    try {
      await api(g ? `admin/giveaways/${g.id}` : 'admin/giveaways', { method: g ? 'PUT' : 'POST', body: b });
      toast(g ? 'Saved' : 'Giveaway created', g ? '' : 'It starts by itself at the start time.');
      m.close();
      done();
    } catch (x) { fail(x); }
  };
}

// HQ: a line when something's live or a prize is waiting.
export async function giveawayBanner() {
  const s = await api('giveaways/summary').catch(() => null);
  if (!s || (!s.live && !s.unclaimed)) return '';
  return `<a class="panel ga-banner" href="#/giveaways">${icon('gift')}<div class="grow">
    ${s.unclaimed ? `<b>You won a prize!</b> Open Giveaways to claim it.` : `<b>${s.live === 1 ? 'A giveaway is' : `${s.live} giveaways are`} live</b> · take part on the Giveaways page.`}</div><span class="btn small primary">Open</span></a>`;
}
