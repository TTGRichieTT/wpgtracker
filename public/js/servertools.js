// Servers page → admin tools for one game server: reserved slots (given by hand to chosen members), the server's
// own action log, and the banner picture shown for the server.
import { api, esc, toast, fail, modal, confirmBox, userLine, fmtDate, fmtTime } from './app.js';

const when = (d) => `${fmtDate(d)} ${fmtTime(d)}`;

// Reserved slots: who has one, and a member picker to give one. Nothing is added automatically.
export async function reserved(sid) {
  const m = modal('<div class="spinner"></div>');
  const draw = async () => {
    let d;
    let people;
    try { [d, people] = await Promise.all([api(`admin/servers/${sid}/reserved`), api('members')]); } catch (x) { m.close(); fail(x); return; }
    const taken = new Set(d.list.map((r) => r.steamId));
    const choices = people.filter((p) => /^\d{17}$/.test(p.steam_id || '') && !taken.has(p.steam_id));
    m.el.innerHTML = `<div class="row between"><h2 style="margin:0">Reserved slots</h2><button class="btn ghost small" data-close>✕</button></div>
      <p class="muted small" style="margin:6px 0 12px">Players with a reserved slot can always get onto the server, even when it's full. ${d.list.length} of ${d.max} used. Only people you choose here get one.</p>
      <div class="list">${d.list.map((r) => `<div class="item"><div class="grow">${r.user ? `<a href="#/u/${r.user.id}" style="color:inherit">${userLine(r.user)}</a>` : `<b>Not in the app</b><div class="muted small">${esc(r.steamId)}</div>`}</div>
        <button class="btn small ghost" data-remove="${esc(r.steamId)}" data-name="${esc(r.user?.name || r.steamId)}">Remove</button></div>`).join('') || '<p class="muted">Nobody has a reserved slot yet.</p>'}</div>
      ${d.list.length < d.max ? `<div style="margin-top:14px"><b class="small" style="color:var(--accent2);text-transform:uppercase">Give a slot to</b>
        <input type="search" id="rsSearch" placeholder="Search members" style="margin:6px 0">
        <div class="list" id="rsChoices" style="max-height:40vh;overflow:auto"></div></div>` : '<p class="small" style="margin-top:12px;color:#f5a524">All reserved slots are in use. Remove someone to give a slot to someone else.</p>'}`;
    m.el.querySelector('[data-close]').onclick = m.close;
    const list = m.el.querySelector('#rsChoices');
    const fill = () => {
      if (!list) return;
      const t = (m.el.querySelector('#rsSearch').value || '').toLowerCase();
      list.innerHTML = choices.filter((p) => p.name.toLowerCase().includes(t)).slice(0, 60)
        .map((p) => `<button class="item" style="width:100%;text-align:left" data-give="${p.id}">${userLine(p, p.membership === 'pmc' ? 'PMC (guest)' : '')}</button>`).join('') || '<p class="muted">Nobody found.</p>';
    };
    m.el.querySelector('#rsSearch')?.addEventListener('input', fill);
    fill();
    m.el.onclick = async (e) => {
      const give = e.target.closest('[data-give]');
      const rm = e.target.closest('[data-remove]');
      try {
        if (give) {
          await api(`admin/servers/${sid}/reserved`, { method: 'POST', body: { userId: Number(give.dataset.give) } });
          toast('Reserved slot given');
          draw();
        } else if (rm && await confirmBox(`Take ${rm.dataset.name}'s reserved slot away?`)) {
          await api(`admin/servers/${sid}/reserved/${rm.dataset.remove}`, { method: 'DELETE' });
          toast('Reserved slot removed');
          draw();
        }
      } catch (x) { fail(x); }
    };
  };
  draw();
}

// The server's own log of admin actions: kicks, bans, config changes… from any tool, not just this app.
export async function log(sid) {
  const m = modal('<div class="spinner"></div>');
  let rows;
  try { rows = await api(`admin/servers/${sid}/audit?limit=200`); } catch (x) { m.close(); fail(x); return; }
  m.el.innerHTML = `<div class="row between"><h2 style="margin:0">Server action log</h2><button class="btn ghost small" data-close>✕</button></div>
    <p class="muted small" style="margin:6px 0 12px">What admins did on the game server, newest first, from any tool (this app, the official console or others). "From" is the address the command came from.</p>
    <div class="table-wrap" style="max-height:60vh;overflow:auto"><table><thead><tr><th>When</th><th>What</th><th>Details</th><th>From</th></tr></thead><tbody>
      ${rows.slice().reverse().map((r) => `<tr><td style="white-space:nowrap">${r.at ? esc(when(r.at)) : ''}</td><td><b>${esc(r.event)}</b></td><td class="small" style="overflow-wrap:anywhere">${esc(r.detail)}</td><td class="small muted">${esc(r.peer)}</td></tr>`).join('')
        || '<tr><td colspan="4" class="muted">Nothing logged yet.</td></tr>'}
    </tbody></table></div>`;
  m.el.querySelector('[data-close]').onclick = m.close;
}

// The banner picture shown for the server (1024×256).
export async function banner(sid) {
  const m = modal('<div class="spinner"></div>');
  let t;
  try { t = await api(`admin/servers/${sid}/tools`); } catch (x) { m.close(); fail(x); return; }
  m.el.innerHTML = `<form id="bnForm" class="stack"><div class="row between"><h2 style="margin:0">Server banner</h2><button type="button" class="btn ghost small" data-close>✕</button></div>
    <p class="muted small" style="margin:0">The picture shown for the server: 1024 × 256 pixels, PNG or JPEG. Its web address must be on the game server's list of allowed picture sites, or the server will refuse it (the message says why). It shows once the server picks it up.</p>
    <div id="bnPreview">${t.banner ? `<img src="${esc(t.banner)}" alt="Current banner" style="width:100%;max-width:640px;aspect-ratio:4/1;object-fit:cover;border-radius:8px;border:1px solid var(--line)">` : '<p class="muted small">No banner set.</p>'}</div>
    <label class="field"><span>Picture link (https)</span><input type="url" name="url" value="${esc(t.banner)}" placeholder="https://…/banner.png"></label>
    <div class="row"><button class="btn primary">Save banner</button><button type="button" class="btn ghost" id="bnClear">Remove banner</button></div></form>`;
  const f = m.el.querySelector('#bnForm');
  m.el.querySelector('[data-close]').onclick = m.close;
  f.url.oninput = () => {
    const u = f.url.value.trim();
    m.el.querySelector('#bnPreview').innerHTML = /^https:\/\//.test(u) ? `<img src="${esc(u)}" alt="Preview" style="width:100%;max-width:640px;aspect-ratio:4/1;object-fit:cover;border-radius:8px;border:1px solid var(--line)">` : '';
  };
  const save = async (url) => {
    try { await api(`admin/servers/${sid}/banner`, { method: 'PUT', body: { url } }); toast(url ? 'Banner saved' : 'Banner removed'); m.close(); } catch (x) { fail(x); }
  };
  f.onsubmit = (e) => { e.preventDefault(); save(f.url.value.trim()); };
  m.el.querySelector('#bnClear').onclick = async () => { if (await confirmBox('Remove the server banner?')) save(''); };
}
