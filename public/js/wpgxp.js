// Admin → WPG XP: who's in charge of WPG XP (the Discord bot or this app), the XP amounts and penalties,
// the WPG rank list, and how the app's own count compares with the bot's before switching over.
import { api, esc, toast, fail, confirmBox, fmtNum, timeAgo } from './app.js';
import { icon } from './icons.js';

const AMOUNTS = [
  ['Earned', [
    ['wpgxp_kill', 'XP per kill'],
    ['wpgxp_per5min', 'XP per 5 minutes played'],
    ['wpgxp_finish', 'XP for finishing a match (still on at the end)'],
    ['wpgxp_win', 'Extra XP for a win'],
  ]],
  ['Penalties', [
    ['wpgxp_penalties', 'Take XP away for losses, bad K/D and leaving early', 'check'],
    ['wpgxp_loss', 'XP lost for a loss'],
    ['wpgxp_leave', 'XP lost for leaving early'],
    ['wpgxp_leave_minutes', '… only after playing at least (minutes)'],
    ['wpgxp_kd_each', 'Bad K/D: XP lost per death more than kills'],
    ['wpgxp_kd_cap', 'Bad K/D: most XP lost in one match'],
    ['wpgxp_kd_minutes', 'Bad K/D: only after playing at least (minutes)'],
  ]],
  ['Fairness', [
    ['wpgxp_rank_floor', "Penalties can't take anyone below the start of their current rank (no rank loss)", 'check'],
    ['wpgxp_min_players', 'Players needed for match XP and penalties (0 = any)'],
  ]],
];

const when = (iso) => (iso ? `${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} (${timeAgo(iso)})` : '—');
const ranksText = (ranks) => ranks.map((r) => `${r.name} = ${r.min_xp}`).join('\n');

export async function wpgXpAdminTab(body) {
  const [d, s] = await Promise.all([api('admin/wpg-xp'), api('admin/settings')]);
  const app = d.source === 'app';
  const earning = d.servers.filter((x) => x.wpg_xp);
  const input = ([k, label, type]) => (type === 'check'
    ? `<label class="check" style="grid-column:1/-1"><input type="checkbox" name="${k}" ${s[k] === 'true' ? 'checked' : ''}> ${esc(label)}</label>`
    : `<label class="field"><span>${esc(label)}</span><input type="number" min="0" name="${k}" value="${esc(s[k] ?? '')}"></label>`);

  const cmp = d.comparison || [];
  const botTotal = cmp.reduce((t, r) => t + r.bot, 0);
  const appTotal = cmp.reduce((t, r) => t + r.app, 0);
  const penTotal = cmp.reduce((t, r) => t + r.penalty, 0);
  const pct = (a, b) => (b ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : '—');

  body.innerHTML = `
    <div class="panel">
      <div class="panel-title">${icon('trophy')} WPG XP <span class="sub">${app ? 'worked out by this app' : 'from the Discord bot'}</span></div>
      ${app
        ? `<p>The app works out WPG XP from every match since <b>${when(d.switched)}</b>. The Discord bot is no longer read.</p>
           <div class="row"><button class="btn" id="wxBot">Go back to the Discord bot</button></div>
           <p class="muted small" style="margin:8px 0 0">Going back shows the bot's numbers again. Anything earned here after the switch is not sent to the bot.</p>`
        : `<p>The leaderboard, profiles and Discord show the <b>Discord bot's</b> WPG XP. Since <b>${when(d.since)}</b> the app has also been counting every match by itself (below), without changing anyone's XP, so you can check the two agree.</p>
           <p class="small">When you're happy with the comparison, switch over. Everyone starts from their bot XP on that day and the app takes it from there (with penalties, if they're on).</p>
           <div class="row"><button class="btn primary" id="wxApp" ${d.ranks.length < 2 ? 'disabled title="Paste the rank list first"' : ''}>Switch WPG XP over to this app</button></div>`}
      <p class="small" style="margin:12px 0 0"><b>Servers that earn WPG XP:</b> ${earning.length ? earning.map((x) => `${esc(x.name)}${x.rcon ? '' : ' <span class="pill banned">no RCON — not counted</span>'}`).join(', ') : '<span style="color:var(--red)">none</span>'}
        <span class="muted">· change in <a href="#/admin/game-servers">Game servers</a> (“Matches here earn WPG XP”)</span></p>
    </div>

    <form class="panel" id="wxRates">
      <div class="panel-title">XP amounts</div>
      ${app ? '' : '<p class="muted small" style="margin-top:0">Used by the app\'s own count now, and for everyone after the switch. Until then the bot uses its own amounts.</p>'}
      ${AMOUNTS.map(([title, list]) => `<b class="small" style="display:block;margin:10px 0 6px;color:var(--accent2);text-transform:uppercase">${esc(title)}</b><div class="form-grid">${list.map(input).join('')}</div>`).join('')}
      <p class="muted small">Leaving early only counts when the match ended normally, the app was watching the server the whole match, and fewer than half the players dropped out at once (a crash). Keep leaving dearer than losing, or people will quit games they're losing.</p>
      <p class="small" id="wxWarn" style="color:var(--red)"></p>
      <button class="btn primary">Save amounts</button>
    </form>

    <div class="panel">
      <div class="panel-title">WPG ranks <span class="sub">${d.ranks.length ? `${d.ranks.length} ranks · ${esc(d.ranks[0].name)} → ${esc(d.ranks[d.ranks.length - 1].name)}` : 'not set up yet'}</span></div>
      <p class="small" style="margin-top:0">One rank per line, lowest first, with the XP it starts at: <code>Recruit I = 0</code>. Commas, tabs (pasted from a spreadsheet) or spaces work too. Everyone's rank and "XP to next rank" use this list, even before the switch. It starts as the standard 200 ranks (each needs 2,000–4,550 XP more than the last, so one match can't climb two ranks).</p>
      <textarea id="wxRanks" style="min-height:240px;font-family:ui-monospace,Consolas,monospace;font-size:14px" placeholder="Recruit I = 0&#10;Recruit II = 1500&#10;…">${esc(ranksText(d.ranks))}</textarea>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="wxSaveRanks">Save rank list</button>
        ${d.seen.length ? '<button class="btn ghost" id="wxSeen">Fill in from the bot\'s data</button>' : ''}
      </div>
      ${d.seen.length ? `<p class="muted small" style="margin:8px 0 0">"Fill in from the bot's data" uses the rank names the bot has given players, with the <b>lowest XP anyone at that rank has</b>. That's only close to where each rank starts, and ranks nobody has reached are missing, so check it against the bot's real list before saving.</p>` : ''}
    </div>

    ${app ? '' : `<div class="panel">
      <div class="panel-title">App count vs the bot <span class="sub">since ${when(d.since)}</span></div>
      ${cmp.length ? `
        <p class="small" style="margin-top:0">XP gained since then: bot <b>${fmtNum(botTotal)}</b> · app <b>${fmtNum(appTotal)}</b> (${pct(appTotal, botTotal)})${penTotal ? ` · app penalties not included: <b>−${fmtNum(penTotal)}</b>` : ''}.
          Small differences are normal (the bot copies every 5 minutes; the app counts when a match ends).</p>
        <div class="table-wrap"><table class="sb-table">
          <thead><tr><th>Player</th><th>Matches</th><th>Bot gained</th><th>App counted</th><th>Difference</th><th class="sb-x">Penalties</th></tr></thead>
          <tbody>${cmp.map((r) => `<tr><td class="sb-name">${esc(r.name)}</td><td>${fmtNum(r.matches)}</td><td>${fmtNum(r.bot)}</td><td>${fmtNum(r.app)}</td>
            <td style="color:${Math.abs(r.app - r.bot) > Math.max(200, r.bot * 0.15) ? 'var(--red)' : 'inherit'}">${r.app - r.bot >= 0 ? '+' : ''}${fmtNum(r.app - r.bot)}</td>
            <td class="sb-x">${r.penalty ? `−${fmtNum(r.penalty)}` : '—'}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">Nothing yet. Rows appear after matches finish on a WPG XP server.</p>'}
      <div class="row" style="margin-top:10px"><button class="btn ghost" id="wxReset">${icon('refresh')} Start the comparison again from now</button></div>
    </div>`}`;

  const form = body.querySelector('#wxRates');
  const warn = () => {
    const v = (k) => Number(form.elements[k].value) || 0;
    body.querySelector('#wxWarn').textContent = form.elements.wpgxp_penalties.checked && v('wpgxp_leave') <= v('wpgxp_loss')
      ? 'Leaving early costs no more than losing, so quitting a losing match would pay. Make leaving dearer.' : '';
  };
  form.oninput = warn;
  warn();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const out = {};
    for (const el of form.elements) if (el.name) out[el.name] = el.type === 'checkbox' ? String(el.checked) : String(Math.max(0, Math.round(Number(el.value) || 0)));
    try { await api('admin/settings', { method: 'PUT', body: out }); toast('Saved', 'New amounts count from the next match that ends.'); } catch (x) { fail(x); }
  };

  body.querySelector('#wxSaveRanks').onclick = async () => {
    try {
      const r = await api('admin/wpg-xp/ranks', { method: 'PUT', body: { text: body.querySelector('#wxRanks').value } });
      toast('Rank list saved', `${r.ranks} ranks.`);
      wpgXpAdminTab(body);
    } catch (x) { fail(x); }
  };
  const seenBtn = body.querySelector('#wxSeen');
  if (seenBtn) seenBtn.onclick = async () => {
    const box = body.querySelector('#wxRanks');
    if (box.value.trim() && !(await confirmBox('Replace what is in the box?'))) return;
    // Lowest XP seen at each rank; the first rank always starts at 0, and each must be above the last.
    let last = -1;
    box.value = d.seen.map((r, i) => {
      const xp = i === 0 ? 0 : Math.max(r.lowest, last + 1);
      last = xp;
      return `${r.name || `Rank ${r.level}`} = ${xp}`;
    }).join('\n');
  };

  body.querySelector('#wxApp')?.addEventListener('click', async () => {
    if (!(await confirmBox('Switch WPG XP over to this app? Everyone starts from their Discord bot XP right now, and from then on the app works it out (penalties included if they are on). You can go back later.'))) return;
    try {
      const r = await api('admin/wpg-xp/switch', { method: 'POST', body: { to: 'app' } });
      toast('Switched over', r.note || 'The app now works out WPG XP. Turn off the XP part of the Discord bot.');
      wpgXpAdminTab(body);
    } catch (x) { fail(x); }
  });
  body.querySelector('#wxBot')?.addEventListener('click', async () => {
    if (!(await confirmBox('Go back to the Discord bot for WPG XP? Everyone\'s XP shows the bot\'s numbers again; XP earned here since the switch is not kept.'))) return;
    try {
      const r = await api('admin/wpg-xp/switch', { method: 'POST', body: { to: 'bot' } });
      toast('Back on the bot', r.note || 'WPG XP comes from the Discord bot again.');
      wpgXpAdminTab(body);
    } catch (x) { fail(x); }
  });
  body.querySelector('#wxReset')?.addEventListener('click', async () => {
    if (!(await confirmBox('Start the comparison again from now? The app\'s counts go back to 0 and the bot\'s XP now becomes the starting point.'))) return;
    try { await api('admin/wpg-xp/reset-comparison', { method: 'POST', body: {} }); toast('Comparison restarted'); wpgXpAdminTab(body); } catch (x) { fail(x); }
  });
}
