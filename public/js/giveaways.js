// Giveaways: the members' page (what's on, entering, standings, your prizes) and Admin → Giveaways (making and
// running them, and their Discord channel).
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
const KIND = { scheduled: ['Giveaway', ''], drop: ['Drops', 'mod'], top: ['Top players', 'pmc'] };
const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;

const WIN_STATUS = {
  given: ['Yours', 'var(--green)'],
  won: ['Claim it', '#f5a524'],
  claimed: ['Claimed: staff will send it', 'var(--accent2)'],
  sent: ['Sent', 'var(--green)'],
  expired: ['Not claimed in time', 'var(--muted)'],
};

// The prizes, in order (places for top players, "× 3" for several winners).
const prizesHtml = (g) => `<div class="ga-prizes">${g.prizes.map((p) => `<div class="ga-prize">${icon('gift')}
  ${p.places ? `<span class="ga-place">${esc(p.places)}</span>` : ''}<span>${esc(p.label)}${!p.places && p.count > 1 ? ` <span class="muted small">× ${fmtNum(p.count)}</span>` : ''}</span></div>`).join('')}</div>`;

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

// Top players: who's winning right now.
function standingsHtml(g) {
  if (g.kind !== 'top' || g.status !== 'open') return '';
  const rows = g.standings || [];
  return `<div class="ga-rules"><div class="small muted" style="margin-bottom:4px">Standings now (counted as each match ends)</div>
    ${rows.length ? rows.map((r) => `<div class="small row between"${r.prize ? '' : ' style="opacity:.6"'}><span><b>${r.place}.</b> <a href="#/u/${r.id}">${esc(r.name)}</a></span><span>${esc(r.score)}</span></div>`).join('') : '<div class="small muted">Nobody yet: play a match on the WPG server.</div>'}
    ${g.my_place ? `<div class="small" style="margin-top:6px">You're <b>${ordinal(g.my_place.place)}</b> (${esc(g.my_place.score)})</div>` : ''}</div>`;
}

// Drops: the rule in one line.
const dropRule = (g) => `Be on the <b>WPG server</b> when a drop triggers and stay until the <b>end of that match</b>${g.drop_min_minutes ? `, playing at least <b>${fmtNum(g.drop_min_minutes)} minutes</b> of it` : ''}: ${g.drop_to === 'all' ? '<b>everyone</b> who does gets the prize.' : 'one of you wins it.'}`;
// A triggered drop waiting for its match to end.
const triggeredHtml = (g) => (g.triggered || []).map((t) => `<div class="ga-trigger">🎁 <b>Drop triggered</b> ${esc(timeAgo(t.at))}: ${fmtNum(t.players)} player${t.players === 1 ? '' : 's'} in it.
  ${t.in_it ? `<b>You're in it!</b> Stay until the end of this match${g.drop_min_minutes ? ` (and play ${fmtNum(g.drop_min_minutes)} min of it)` : ''}.` : 'Handed out when this match ends.'}</div>`).join('');

function liveCard(g) {
  const open = g.status === 'open' || g.status === 'drawing';
  const [kindName, kindCls] = KIND[g.kind] || KIND.scheduled;
  const timing = g.status === 'drawing' ? 'Draw at the end of the current match'
    : open
      ? g.kind === 'drop' ? `${fmtNum(g.drops_left)} drop${g.drops_left === 1 ? '' : 's'} left · ends ${until(g.end_at)}` : `Ends ${until(g.end_at)} (${when(g.end_at)})`
      : `Starts ${until(g.start_at)} (${when(g.start_at)})`;
  let action = '';
  if (!g.can_win) action = `<p class="small muted" style="margin:0">${g.who === 'members' ? 'This one is for WPG members.' : 'Staff can\'t win this one.'}</p>`;
  else if (g.status === 'drawing') action = `<p class="small" style="margin:0"><b>The draw is at the end of the match on the WPG server.</b> ${g.entered || g.entry === 'auto' ? 'Be on the server until it ends to be in it.' : ''}</p>`;
  else if (g.kind === 'drop') action = `<p class="small" style="margin:0">${dropRule(g)}${g.drop_mode === 'manual' ? ' Drops can trigger at any time.' : ''}</p>`;
  else if (g.kind === 'top') action = `<p class="small" style="margin:0"><b>${esc(g.metric_label)}</b> on the WPG server ${open ? 'until it ends' : 'once it starts'} wins. No need to enter.</p>`;
  else if (g.entry === 'auto') action = '<p class="small" style="margin:0">No need to enter: play on the <b>WPG server</b> during the giveaway and you\'re in.</p>';
  else action = (g.entered
    ? `<div class="row" style="gap:8px"><span style="color:var(--green);font-weight:700">✓ You're in</span><button class="btn small ghost" data-leave="${g.id}">Leave</button></div>`
    : `<button class="btn primary" data-enter="${g.id}">${icon('plus')} Enter</button>`)
    + (g.live_draw ? '<p class="small muted" style="margin:6px 0 0">Live draw: you must be on the WPG server at the end of the match when it ends.</p>' : '');
  return `<div class="panel ga-card${open ? ' glow' : ''}">
    ${g.image ? `<img class="ga-img" src="${esc(g.image)}" alt="" loading="lazy">` : ''}
    <div class="row between" style="gap:8px;align-items:flex-start">
      <div><span class="pill ${kindCls}">${kindName}</span> ${g.status === 'drawing' ? '<span class="pill" style="color:#f5a524;border-color:#f5a524">Drawing</span>' : open ? '<span class="pill" style="color:var(--green);border-color:var(--green)">Live</span>' : '<span class="pill">Coming up</span>'}</div>
      <span class="small muted">${esc(timing)}</span>
    </div>
    <h3 style="margin:8px 0 6px">${esc(g.title)}</h3>
    ${prizesHtml(g)}
    ${g.description ? `<p class="small" style="margin:8px 0;white-space:pre-line">${esc(g.description)}</p>` : ''}
    ${triggeredHtml(g)}${rulesHtml(g)}${standingsHtml(g)}
    <div style="margin-top:10px">${action}</div>
    ${g.kind === 'scheduled' && g.entry === 'enter' ? `<p class="small muted" style="margin:8px 0 0">${fmtNum(g.entrants)} entered${g.who === 'everyone' ? ' · PMCs welcome' : ''}</p>` : ''}
  </div>`;
}

export async function viewGiveaways(main) {
  const d = await api('giveaways');
  onLive('config', (name) => { if (name === 'giveaways') viewGiveaways(main); });
  const live = d.live.filter((g) => g.status !== 'scheduled');
  const soon = d.live.filter((g) => g.status === 'scheduled');
  main.innerHTML = `<h1>${icon('gift', 'width="28" height="28" style="vertical-align:-4px;color:var(--accent)"')} Giveaways</h1>
    ${d.mine.length ? `<div class="panel"><div class="panel-title">${icon('star')} Your prizes</div>
      <div class="list">${d.mine.map((w) => `<div class="item"><div class="grow"><b>${esc(w.prize)}</b> <span class="muted small">· ${w.place ? `${ordinal(w.place)} place · ` : ''}${esc(w.title)} · won ${esc(timeAgo(w.won_at))}</span>
          ${w.status === 'won' ? `<div class="small" style="color:#f5a524">Claim by ${esc(when(w.claim_by))}</div>` : ''}
          ${w.code ? `<div class="small" style="margin-top:4px">Your code: <code class="ga-code">${esc(w.code)}</code></div>` : ''}</div>
        ${w.status === 'won' ? `<button class="btn primary small" data-claim="${w.id}">${icon('gift')} Claim</button>` : `<span class="small" style="color:${WIN_STATUS[w.status]?.[1]}">${esc(WIN_STATUS[w.status]?.[0] || w.status)}</span>`}</div>`).join('')}</div></div>` : ''}
    ${live.length ? `<div class="ga-grid">${live.map(liveCard).join('')}</div>` : '<div class="panel empty"><p>No giveaways running right now. Keep an eye on Discord and the WPG server: random drops can happen any time.</p></div>'}
    ${soon.length ? `<h2 style="margin:20px 0 10px">Coming up</h2><div class="ga-grid">${soon.map(liveCard).join('')}</div>` : ''}
    ${d.past.length ? `<div class="panel" style="margin-top:16px"><div class="panel-title">${icon('trophy')} Past winners</div>
      <div class="list">${d.past.map((g) => `<div class="item"><div class="grow"><b>${esc(g.title)}</b> <span class="muted small">· ${esc(KIND[g.kind]?.[0] || '')} · ${esc(fmtDate(g.end_at))}</span>
        <div class="small">${g.winners_list.length ? g.winners_list.map((w) => `${w.place ? `${w.place}. ` : ''}<a href="#/u/${w.id}">${esc(w.name)}</a> <span class="muted">(${esc(w.prize)})</span>`).join(', ') : '<span class="muted">No winner</span>'}</div></div></div>`).join('')}</div></div>` : ''}`;
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
const STATUS = { scheduled: ['Coming up', 'var(--accent2)'], open: ['Live', 'var(--green)'], drawing: ['Drawing at the end of the match', '#f5a524'], done: ['Finished', 'var(--muted)'], cancelled: ['Cancelled', 'var(--red)'] };
const localInput = (d) => {
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`;
};

export async function giveawaysAdminTab(body) {
  const d = await api('admin/giveaways');
  body.innerHTML = `<div class="panel">
      <div class="row between"><div class="panel-title" style="margin:0">${icon('gift')} Giveaways</div><button class="btn primary" id="gaNew">${icon('plus')} New giveaway</button></div>
      <p class="muted small"><b>Giveaway</b>: runs between two times and draws its winners at random at the end. <b>Drops</b>: at secret random times (or whenever you press <b>Trigger a drop now</b>), for players on the WPG server who stay until the end of that match (and play long enough).
        <b>Top players</b>: whoever does best on the WPG server in the time window (most kills, time played…) wins by place.
        Each can have several prizes. Clan XP, WPG XP and medals are given automatically; real prizes are claimed by the winner in the app and you mark them sent here.
        Server: ${d.servers.length ? esc(d.servers.join(', ')) : '<span style="color:var(--red)">none ticked "Matches here earn WPG XP" with RCON (Admin → Game servers): drops, top players and requirements need one</span>'}.</p>
    </div>
    <form class="panel" id="gaDiscord">
      <div class="panel-title">${icon('discord')} Discord</div>
      <div class="form-grid">
        <label class="field"><span>Giveaways channel ID (right-click the channel in Discord → Copy Channel ID)</span><input type="text" name="channel" inputmode="numeric" value="${esc(d.channel)}" placeholder="Empty = the channel for the other automatic posts"></label>
      </div>
      <label class="check"><input type="checkbox" name="posting"${d.posting ? ' checked' : ''}> Post giveaways in Discord (when one starts, and the winners)</label>
      <div class="row" style="margin-top:8px"><button class="btn">Save Discord settings</button></div>
    </form>
    ${d.list.length ? d.list.map((g) => `<div class="panel ga-admin">
      <div class="row between" style="gap:8px">
        <div><b style="font:700 18px var(--head);text-transform:uppercase">${esc(g.title)}</b>
          <span class="pill ${KIND[g.kind]?.[1] || ''}">${KIND[g.kind]?.[0] || g.kind}</span>
          <b class="small" style="color:${STATUS[g.status][1]}">${STATUS[g.status][0]}</b></div>
        <div class="row" style="gap:6px">
          ${['scheduled', 'open'].includes(g.status) ? `<button class="btn small" data-edit="${g.id}">${icon('edit')} Edit</button>` : ''}
          ${['open', 'drawing'].includes(g.status) ? `<button class="btn small primary" data-draw="${g.id}">${g.kind === 'drop' ? `${icon('gift')} Trigger a drop now` : g.kind === 'top' ? 'End & give prizes now'
            : g.status === 'drawing' ? 'Draw now (whoever is on)' : g.live_draw ? 'End: draw at the end of this match' : 'End & draw now'}</button>` : ''}
          ${['scheduled', 'open', 'drawing'].includes(g.status) ? `<button class="btn small ghost" data-cancel="${g.id}">Cancel</button>` : `<button class="btn small ghost" data-del="${g.id}">${icon('trash')}</button>`}
        </div>
      </div>
      <div class="small" style="margin-top:6px">${esc(when(g.start_at))} → ${esc(when(g.end_at))} · ${g.who === 'everyone' ? 'members + PMCs' : 'WPG members'}${g.no_staff ? ', no staff' : ''}
        ${g.kind === 'top' ? ` · <b>${esc(g.metric_label)}</b>` : ''}
        ${g.kind === 'drop' ? ` · ${g.drop_mode === 'manual' ? 'drops when you trigger them' : 'drops at random times'} · ${g.drop_to === 'all' ? 'everyone who qualifies gets it' : 'one winner each'}${g.drop_min_minutes ? ` · ${mins(g.drop_min_minutes)} in the match` : ''}${g.status !== 'done' ? ` · ${fmtNum(g.drops_left)} of ${fmtNum(g.winners)} left` : ''}` : ''}
        ${g.kind === 'scheduled' && g.live_draw ? ' · live draw' : ''}
        ${g.kind === 'scheduled' ? ` · ${g.entry === 'auto' ? 'everyone who plays is entered' : `${fmtNum(g.entrants)} entered`}` : ''}
        ${g.min_minutes || g.min_matches || g.min_kills ? ` · needs ${[g.min_minutes && mins(g.min_minutes), g.min_matches && `${g.min_matches} matches`, g.min_kills && `${g.min_kills} kills`].filter(Boolean).join(', ')}` : ''}</div>
      <div class="small" style="margin-top:4px">${g.prizes.map((p) => `${icon('gift')} ${p.places ? `<b>${esc(p.places)}</b>: ` : ''}${esc(p.label)}${!p.places && p.count > 1 ? ` ×${p.count}` : ''}${p.codes ? ` <span class="muted">(${p.codes} code${p.codes === 1 ? '' : 's'})</span>` : ''}`).join(' &nbsp; ')}</div>
      ${(g.triggered || []).map((t) => `<div class="ga-trigger">🎁 Drop triggered ${esc(timeAgo(t.at))}: ${fmtNum(t.players)} in it, handed out when the match ends.</div>`).join('')}
      ${g.winners_list.length ? `<div class="list" style="margin-top:8px">${g.winners_list.map((w) => `<div class="item"><div class="grow">${w.place ? `<b>${w.place}.</b> ` : ''}<a href="#/u/${w.user_id}"><b>${esc(w.name)}</b></a> <span class="small">· ${esc(w.prize)}</span>
          <span class="small" style="color:${WIN_STATUS[w.status]?.[1]}"> · ${esc(w.status === 'won' ? 'waiting to claim' : WIN_STATUS[w.status]?.[0] || w.status)}</span> <span class="muted small">· ${esc(timeAgo(w.won_at))}</span></div>
          ${['won', 'claimed'].includes(w.status) && w.prize_type === 'item' ? `<button class="btn small" data-sent="${w.id}">Mark sent</button>` : ''}
          ${['won', 'expired'].includes(w.status) ? `<button class="btn small ghost" data-redraw="${w.id}">${g.kind === 'top' ? 'Give to the next player' : 'Draw someone else'}</button>` : ''}</div>`).join('')}</div>` : ''}
    </div>`).join('') : '<div class="panel empty"><p>No giveaways yet. Press <b>New giveaway</b> to make one.</p></div>'}`;

  const reload = () => giveawaysAdminTab(body);
  const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg(r)); reload(); } catch (x) { fail(x); } };
  body.querySelector('#gaDiscord').onsubmit = (e) => {
    e.preventDefault();
    act(() => api('admin/giveaways-discord', { method: 'PUT', body: { channel: e.target.channel.value, posting: e.target.posting.checked } }), () => 'Discord settings saved');
  };
  body.querySelector('#gaNew').onclick = () => giveawayForm(null, d, reload);
  body.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => giveawayForm(d.list.find((g) => g.id === Number(b.dataset.edit)), d, reload); });
  body.querySelectorAll('[data-draw]').forEach((b) => {
    b.onclick = async () => {
      const g = d.list.find((x) => x.id === Number(b.dataset.draw));
      const ask = g.kind === 'drop' ? 'Trigger a drop now? Everyone on the WPG server right now is in it, and it\'s handed out when this match ends.'
        : g.kind === 'top' ? `End "${g.title}" now and give the prizes to the top players so far?` : `End "${g.title}" now and draw the winners?`;
      if (!(await confirmBox(ask))) return;
      act(() => api(`admin/giveaways/${g.id}/draw`, { method: 'POST', body: {} }), (r) => (r.winners.length ? `Winners: ${r.winners.join(', ')}` : r.note || 'Done'));
    };
  });
  body.querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = async () => { if (await confirmBox('Cancel this giveaway? Nobody will win it.')) act(() => api(`admin/giveaways/${b.dataset.cancel}/cancel`, { method: 'POST', body: {} }), () => 'Cancelled'); }; });
  body.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { if (await confirmBox('Delete this giveaway and its winner list for good?')) act(() => api(`admin/giveaways/${b.dataset.del}`, { method: 'DELETE' }), () => 'Deleted'); }; });
  body.querySelectorAll('[data-sent]').forEach((b) => { b.onclick = () => act(() => api(`admin/giveaways/winners/${b.dataset.sent}/sent`, { method: 'POST', body: {} }), () => 'Marked as sent'); });
  body.querySelectorAll('[data-redraw]').forEach((b) => { b.onclick = async () => { if (await confirmBox('Give this prize to someone else? The current winner loses it.')) act(() => api(`admin/giveaways/winners/${b.dataset.redraw}/redraw`, { method: 'POST', body: {} }), (r) => `New winner: ${r.winner}`); }; });
}

async function giveawayForm(g, d, done) {
  const medals = await api('admin/awards').catch(() => []);
  const now = Date.now();
  const v = g ? { ...g } : {
    kind: 'scheduled', title: '', description: '', image: '', metric: 'kills', drop_mode: 'random', drop_to: 'one', drop_min_minutes: 0, live_draw: false,
    start_at: new Date(now + 5 * 60000).toISOString(), end_at: new Date(now + 7 * 86400000).toISOString(),
    who: 'members', no_staff: false, entry: 'enter', min_minutes: 0, min_matches: 0, min_kills: 0, claim_days: 7, in_game: true,
  };
  // Prizes being edited (codes are never sent back: typing new ones replaces the saved ones).
  const prizes = g ? g.prizes.map((p) => ({ type: p.type, text: p.text, amount: p.amount || 500, medal: p.medal || medals[0]?.id, count: p.count, savedCodes: p.codes, codes: '' }))
    : [{ type: 'item', text: '', amount: 500, medal: medals[0]?.id, count: 1, codes: '' }];
  const m = modal(`<form id="gaf" class="stack" style="max-width:700px">
    <div class="row between"><h2 style="margin:0">${g ? 'Edit giveaway' : 'New giveaway'}</h2><button type="button" class="btn ghost small" data-close>✕</button></div>
    ${g ? '' : `<div class="stack" style="gap:6px">
      <label class="check"><input type="radio" name="kind" value="scheduled"${v.kind === 'scheduled' ? ' checked' : ''}> <b>Giveaway</b> <span class="small muted">— winners drawn at random at the end</span></label>
      <label class="check"><input type="radio" name="kind" value="drop"${v.kind === 'drop' ? ' checked' : ''}> <b>Drops</b> <span class="small muted">— at random times or when you trigger one, for players on the WPG server who stay to the end of the match</span></label>
      <label class="check"><input type="radio" name="kind" value="top"${v.kind === 'top' ? ' checked' : ''}> <b>Top players</b> <span class="small muted">— best on the WPG server in the time window win by place</span></label></div>`}
    <label class="field"><span>Title</span><input type="text" name="title" maxlength="100" required value="${esc(v.title)}" placeholder="e.g. Weekend kill race"></label>
    <div class="form-grid" data-kind="drop">
      <label class="field"><span>When drops happen</span><select name="drop_mode"><option value="random"${v.drop_mode !== 'manual' ? ' selected' : ''}>Random times</option><option value="manual"${v.drop_mode === 'manual' ? ' selected' : ''}>When we trigger them</option></select></label>
      <label class="field"><span>Who gets each drop</span><select name="drop_to"><option value="all"${v.drop_to === 'all' ? ' selected' : ''}>Everyone who qualifies</option><option value="one"${v.drop_to !== 'all' ? ' selected' : ''}>One random player</option></select></label>
      <label class="field"><span>Minutes in the match to qualify</span><input type="number" name="drop_min_minutes" min="0" max="180" value="${esc(v.drop_min_minutes)}"></label>
    </div>
    <p class="small muted" data-kind="drop" style="margin:-6px 0 0">To qualify, players must be on the WPG server when the drop triggers and stay until the end of that match. You can also trigger a drop any time with <b>Trigger a drop now</b>.</p>
    <label class="field" data-kind="top"><span>What counts</span><select name="metric">${Object.entries(d.metrics).map(([k, l]) => `<option value="${k}"${v.metric === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <div><div class="row between"><b style="font:600 13px var(--head);color:var(--accent2);text-transform:uppercase;letter-spacing:.8px">Prizes</b>
      <button type="button" class="btn small" id="gaAdd">${icon('plus')} Add a prize</button></div>
      <p class="small muted" style="margin:4px 0 8px" id="gaPrizeHelp"></p>
      <div id="gaPrizes" class="stack" style="gap:8px"></div></div>
    <label class="field"><span>Description (optional)</span><textarea name="description" maxlength="1500">${esc(v.description)}</textarea></label>
    <label class="field"><span>Picture link (optional, https)</span><input type="url" name="image" value="${esc(v.image)}"></label>
    <div class="form-grid">
      <label class="field"><span>Starts</span><input type="datetime-local" name="start_at" required value="${localInput(v.start_at)}"></label>
      <label class="field"><span>Ends</span><input type="datetime-local" name="end_at" required value="${localInput(v.end_at)}"></label>
      <label class="field"><span>Who can win</span><select name="who"><option value="members"${v.who === 'members' ? ' selected' : ''}>WPG members</option><option value="everyone"${v.who === 'everyone' ? ' selected' : ''}>WPG members and PMCs</option></select></label>
      <label class="field" data-kind="scheduled"><span>Taking part</span><select name="entry"><option value="enter"${v.entry === 'enter' ? ' selected' : ''}>Members press Enter</option><option value="auto"${v.entry === 'auto' ? ' selected' : ''}>Everyone who plays on the WPG server</option></select></label>
      <label class="field" data-items><span>Days to claim real prizes</span><input type="number" name="claim_days" min="1" max="60" value="${esc(v.claim_days)}"></label>
    </div>
    <div data-kind="scheduled"><span class="small muted">Must do on the WPG server during the giveaway (0 = no need):</span>
      <div class="form-grid" style="margin-top:6px">
        <label class="field"><span>Minutes played</span><input type="number" name="min_minutes" min="0" value="${esc(v.min_minutes)}"></label>
        <label class="field"><span>Matches</span><input type="number" name="min_matches" min="0" value="${esc(v.min_matches)}"></label>
        <label class="field"><span>Kills</span><input type="number" name="min_kills" min="0" value="${esc(v.min_kills)}"></label>
      </div></div>
    <label class="check" data-kind="scheduled"><input type="checkbox" name="live_draw"${v.live_draw ? ' checked' : ''}> Live draw: winners must be on the WPG server at the end of the match running at the end time</label>
    <label class="check"><input type="checkbox" name="no_staff"${v.no_staff ? ' checked' : ''}> Staff (mods and admins) can't win</label>
    <label class="check"><input type="checkbox" name="in_game"${v.in_game ? ' checked' : ''}> Announce on the WPG server (start and winners)</label>
    <p class="small muted" style="margin:0">Times are in your own time zone. Only people with a WPG Barracks account can win. Winners are told in the app, on Discord and in-game.</p>
    <div class="row"><button class="btn primary">${g ? 'Save changes' : 'Create'}</button></div>
  </form>`);
  const f = m.el.querySelector('#gaf');
  m.el.querySelector('[data-close]').onclick = m.close;
  const kind = () => (g ? g.kind : f.querySelector('[name=kind]:checked').value);
  const box = f.querySelector('#gaPrizes');

  // One row per prize: type, details, how many winners / drops / places, and codes for real prizes.
  const drawPrizes = () => {
    const k = kind();
    let place = 0;
    f.querySelector('#gaPrizeHelp').textContent = k === 'top'
      ? 'In order: the first prize goes to 1st place. "Places" = how many places get it (e.g. 100 Clan XP to 10 places = 1st–10th).'
      : k === 'drop' ? 'In order: the first drop gives the first prize. "Drops" = how many drops give it (each drop goes to everyone who qualifies, or one random player, as set above).'
        : 'In order: the first prize is drawn first. "Winners" = how many people win it.';
    box.innerHTML = prizes.map((p, i) => {
      const from = place + 1;
      place += Math.max(1, Number(p.count) || 1);
      const range = k === 'top' ? (from === place ? ordinal(from) : `${ordinal(from)}–${ordinal(place)}`) : '';
      return `<div class="ga-prize-row" data-i="${i}">
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
          ${range ? `<span class="ga-place">${range}</span>` : ''}
          <label class="field" style="flex:1 1 170px"><span>Prize ${i + 1}</span><select data-k="type">
            <option value="item"${p.type === 'item' ? ' selected' : ''}>Something real</option>
            <option value="clan_xp"${p.type === 'clan_xp' ? ' selected' : ''}>Clan XP</option>
            <option value="wpg_xp"${p.type === 'wpg_xp' ? ' selected' : ''}${d.wpg_xp_ok ? '' : ' disabled'}>WPG XP${d.wpg_xp_ok ? '' : ' (after the switch-over)'}</option>
            <option value="medal"${p.type === 'medal' ? ' selected' : ''}>A medal</option></select></label>
          ${p.type === 'item' ? `<label class="field" style="flex:2 1 200px"><span>What is it?</span><input type="text" data-k="text" maxlength="200" value="${esc(p.text)}" placeholder="e.g. £20 Steam gift card"></label>`
            : p.type === 'medal' ? `<label class="field" style="flex:2 1 200px"><span>Which medal?</span><select data-k="medal">${medals.map((x) => `<option value="${x.id}"${Number(p.medal) === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('') || '<option value="">No medals yet (Admin → Medals)</option>'}</select></label>`
              : `<label class="field" style="flex:1 1 120px"><span>How much XP?</span><input type="number" data-k="amount" min="1" value="${esc(p.amount)}"></label>`}
          <label class="field" style="flex:0 0 96px"><span>${k === 'top' ? 'Places' : k === 'drop' ? 'Drops' : 'Winners'}</span><input type="number" data-k="count" min="1" max="50" value="${esc(p.count)}"></label>
          ${prizes.length > 1 ? `<button type="button" class="btn small ghost" data-remove="${i}" title="Remove this prize">${icon('trash')}</button>` : ''}
        </div>
        ${p.type === 'item' ? `<textarea data-k="codes" rows="2" style="margin-top:6px;min-height:0" placeholder="${p.savedCodes ? `${p.savedCodes} code(s) saved. Type new ones to replace them.` : 'Codes / keys (optional): one per line, one per winner, shown only to that winner after they claim'}">${esc(p.codes)}</textarea>` : ''}
      </div>`;
    }).join('');
    f.querySelectorAll('[data-items]').forEach((el) => { el.style.display = prizes.some((p) => p.type === 'item') ? '' : 'none'; });
  };
  // Keep typed values when the list redraws.
  box.addEventListener('input', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row || !e.target.dataset.k) return;
    prizes[Number(row.dataset.i)][e.target.dataset.k] = e.target.value;
    if (e.target.dataset.k === 'count' && kind() === 'top') { const pos = e.target.selectionStart; drawPrizes(); const el = box.querySelector(`[data-i="${row.dataset.i}"] [data-k=count]`); el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* number inputs */ } }
  });
  box.addEventListener('change', (e) => { if (e.target.dataset.k === 'type') { prizes[Number(e.target.closest('[data-i]').dataset.i)].type = e.target.value; drawPrizes(); } });
  box.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { prizes.splice(Number(rm.dataset.remove), 1); drawPrizes(); }
  });
  f.querySelector('#gaAdd').onclick = () => { prizes.push({ type: 'clan_xp', text: '', amount: 500, medal: medals[0]?.id, count: 1, codes: '' }); drawPrizes(); };

  const sync = () => { f.querySelectorAll('[data-kind]').forEach((el) => { el.style.display = el.dataset.kind === kind() ? '' : 'none'; }); drawPrizes(); };
  f.querySelectorAll('[name=kind]').forEach((r) => r.addEventListener('change', sync));
  sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const b = {
      kind: kind(), title: f.title.value, description: f.description.value, image: f.image.value, metric: f.metric.value,
      prizes: prizes.map((p) => ({ type: p.type, text: p.text, amount: p.amount, medal: p.medal, count: p.count, codes: p.codes })),
      claim_days: f.claim_days.value, start_at: new Date(f.start_at.value).toISOString(), end_at: new Date(f.end_at.value).toISOString(),
      who: f.who.value, entry: f.entry.value, min_minutes: f.min_minutes.value, min_matches: f.min_matches.value, min_kills: f.min_kills.value,
      no_staff: f.no_staff.checked, in_game: f.in_game.checked,
      drop_mode: f.drop_mode.value, drop_to: f.drop_to.value, drop_min_minutes: f.drop_min_minutes.value, live_draw: f.live_draw.checked,
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
    ${s.unclaimed ? '<b>You won a prize!</b> Open Giveaways to claim it.' : `<b>${s.live === 1 ? 'A giveaway is' : `${s.live} giveaways are`} live</b> · take part on the Giveaways page.`}</div><span class="btn small primary">Open</span></a>`;
}
