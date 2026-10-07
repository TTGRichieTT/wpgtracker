// Profile frames (server/frames.js): the Frames section on a member's profile, and Admin → Frames.
import { api, esc, state, toast, fail, modal, confirmBox, fmtNum, fmtDate, refreshMe, route } from './app.js';
import { icon } from './icons.js';
import { frameSVG, FRAME_STYLES, FRAME_BADGES } from './frameart.js';

const FALLBACK = '/img/icon-192.png';
const CATS = [
  ['permanent', 'Permanent', 'Kept forever.'],
  ['clan', 'Clan', 'WPG members only, while it applies (membership, unit, rank).'],
  ['season', 'Season', 'Each season has its own set. Earn them before the game wipes: you keep them, but they can\'t be earned after.'],
];
const PROFILE_GROUPS = [...CATS, ['past', 'Earlier seasons', 'Kept for good; these can\'t be earned any more.']];
const seasonName = (s) => (s ? s.name || `Season ${s.number}` : '');
const badgeName = (b) => (b === 'rank' ? "Their clan rank badge" : b[0].toUpperCase() + b.slice(1));
const when = (d) => `${fmtDate(d)} ${new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

// A picture in a frame (for previews): size in px.
export function framedPreview(frame, pic, size = 96) {
  return `<span class="av-wrap framed" style="width:${size}px;height:${size}px"><img class="avatar" src="${esc(pic || FALLBACK)}" alt="" loading="lazy" referrerpolicy="no-referrer">${frameSVG(frame)}</span>`;
}

function progressHtml(p) {
  if (!p) return '';
  const pct = Math.max(0, Math.min(100, (p.value / Math.max(1, p.target)) * 100));
  const fmt = (n) => (p.unit === '$' ? `$${fmtNum(n)}` : `${fmtNum(n)}${p.unit && p.unit !== '$' ? ` ${p.unit}` : ''}`);
  return `<div class="xpbar" style="height:7px;margin:8px 0 3px"><div style="width:${pct.toFixed(1)}%"></div></div><div class="muted small">${fmt(p.value)} / ${fmt(p.target)}</div>`;
}

// ---------- Profile: the member's frames ----------
export async function profileFramesPanel(box, user) {
  let d;
  try {
    d = await api(`users/${user.id}/frames`);
  } catch {
    box.innerHTML = '';
    return;
  }
  const all = [...d.groups.permanent, ...d.groups.clan, ...d.groups.season, ...d.groups.past];
  const got = all.filter((f) => f.unlocked).length;
  const open = all.length - d.groups.past.length; // earlier seasons' only show when earned
  const seasonLine = d.season
    ? `${esc(d.season.name || `Season ${d.season.number}`)}${d.next ? ` · Season ${d.next.number} starts ${esc(fmtDate(d.next.start_at))}` : ''}`
    : '';
  const card = (f) => {
    const sel = d.selected === f.id;
    const tip = f.unlocked_at ? `Unlocked ${fmtDate(f.unlocked_at)}` : '';
    return `<div class="frame-card${f.unlocked ? ' unlocked' : ' locked'}${sel ? ' selected' : ''}" title="${esc(tip)}">
      ${framedPreview(f, user.avatar, 88)}
      <div class="nm">${esc(f.name)}</div>
      ${f.season_number && f.category === 'season' ? `<div class="small" style="color:var(--accent2);font:700 12px var(--head);text-transform:uppercase">Season ${f.season_number}</div>` : ''}
      ${f.position || f.unit_role
        ? `${f.position ? `<div class="small" style="color:var(--accent2);font:700 14px var(--head);text-transform:uppercase;margin-top:2px">${esc(f.position)}</div>` : ''}${f.unit_role ? `<div class="muted small">Role: ${esc(f.unit_role)}</div>` : ''}`
        : `<div class="muted small">${esc(f.description)}</div>`}
      ${f.locked_reason ? `<div class="small" style="color:#f5a524;margin-top:6px">${esc(f.locked_reason)}</div>` : progressHtml(f.progress)}
      ${f.source === 'wardogs.tools' ? '<div class="small muted" style="margin-top:4px">Data: <a href="https://wardogs.tools" target="_blank" rel="noopener">wardogs.tools</a></div>' : ''}
      ${d.mine && f.unlocked ? (sel ? `<span class="pill mod" style="margin-top:8px">✓ Showing</span>` : `<button class="btn small" style="margin-top:8px" data-use-frame="${f.id}">Use this frame</button>`) : ''}
      ${!d.mine && sel ? '<span class="pill mod" style="margin-top:8px">Showing</span>' : ''}
    </div>`;
  };
  box.innerHTML = `<div class="panel">
    <div class="row between" style="align-items:flex-start">
      <div>
        <div class="panel-title" style="margin-bottom:4px">${icon('medal')} Profile frames <span class="sub">${got - d.groups.past.length} / ${open} unlocked${d.groups.past.length ? ` · ${d.groups.past.length} from earlier seasons` : ''}</span></div>
        ${seasonLine ? `<p class="muted small" style="margin:0 0 10px">${seasonLine}</p>` : ''}
      </div>
      ${d.mine && d.selected ? '<button class="btn small ghost" data-use-frame="">Show no frame</button>' : ''}
    </div>
    ${d.mine ? '<p class="muted small" style="margin:0 0 12px">Pick an unlocked frame to show around your picture across the app and on your Discord cards.</p>' : ''}
    ${PROFILE_GROUPS.map(([k, label, help]) => (d.groups[k].length ? `
      <h4 class="row" style="margin:14px 0 4px">${esc(k === 'season' && d.season ? seasonName(d.season) : label)} <span class="muted small" style="font-weight:400;text-transform:none">${esc(help)}</span></h4>
      <div class="frame-grid">${d.groups[k].map(card).join('')}</div>` : '')).join('')}
    ${all.some((f) => f.source === 'wardogs.tools') ? '<p class="muted small" style="margin:12px 0 0">Wardog level, cash and class level frames use stats provided by <a href="https://wardogs.tools" target="_blank" rel="noopener">wardogs.tools</a>.</p>' : ''}
  </div>`;
  box.querySelectorAll('[data-use-frame]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('me/frame', { method: 'PUT', body: { frameId: b.dataset.useFrame ? Number(b.dataset.useFrame) : null } });
        await refreshMe();
        toast(b.dataset.useFrame ? 'Frame on' : 'Frame off', b.dataset.useFrame ? 'Your picture shows it everywhere now.' : '');
        route(); // redraw the page with the new frame
      } catch (x) { fail(x); }
    };
  });
}

// ---------- Admin → Frames ----------
export async function framesAdminTab(body) {
  const d = await api('admin/frames');
  const cur = d.seasons.find((s) => s.status === 'active');
  const next = d.seasons.find((s) => s.status === 'scheduled');
  const local = (v) => {
    if (!v) return '';
    const t = new Date(v);
    return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const label = (sid) => {
    const x = d.seasons.find((z) => z.id === sid);
    if (!x) return 'No season';
    return `${seasonName(x)} · ${x.status === 'active' ? 'now — can be earned' : x.status === 'scheduled' ? `from ${fmtDate(x.start_at)} (members see them when it starts)` : 'ended — kept by members, can\'t be earned'}`;
  };
  // Season frames grouped by season: the running one, the next one, then earlier ones.
  const order = { active: 0, scheduled: 1, ended: 2 };
  const seasonIds = [...new Set(d.frames.filter((f) => f.category === 'season').map((f) => f.season_id))]
    .sort((a, b) => {
      const sa = d.seasons.find((z) => z.id === a);
      const sb = d.seasons.find((z) => z.id === b);
      return (order[sa?.status] ?? 3) - (order[sb?.status] ?? 3) || (sb?.number || 0) - (sa?.number || 0);
    });
  const nextHas = next && d.frames.some((f) => f.category === 'season' && f.season_id === next.id);
  const row = (f) => `<div class="item">
      ${framedPreview({ ...f, season: f.category === 'season' ? f.season_number : null, rank: state.me.rank }, state.me.avatar, 52)}
      <div class="grow"><b>${esc(f.name)}</b>${f.enabled ? '' : ' <span class="pill banned">Off</span>'}
        <div class="muted small">${esc(f.description)}</div>
        <div class="muted small">${esc(d.metrics[f.metric]?.label || f.metric)}${['manual', 'placement', 'founding', 'clan_member', 'unit'].includes(f.metric) ? '' : ` · ${f.metric === 'officer' ? 'rank order' : 'target'} ${fmtNum(f.target)}`}${f.category === 'clan' ? '' : ` · ${fmtNum(f.holders)} unlocked`}${f.swept ? '' : ' · first check (quiet) at the next hourly run'}</div>
        ${f.image_id && d.frames.some((o) => o.id !== f.id && o.image_id === f.image_id && o.season_id !== f.season_id && f.category === 'season') ? '<div class="small" style="color:#f5a524">Same picture as another season: upload this season\'s own.</div>' : ''}</div>
      ${f.category === 'clan' ? '' : `<button class="btn small ghost" data-holders="${f.id}">${icon('users')} Who has it</button>`}
      <button class="btn small" data-edit-frame="${f.id}">${icon('edit')} Edit</button></div>`;
  body.innerHTML = `
    <div class="panel">
      <div class="panel-title">${icon('calendar')} Seasons <span class="sub">follow the game's wipes</span></div>
      <p class="muted small" style="margin-top:0">When the game wipes, a new season starts with its own set of season frames. The last season's frames can't be earned any more (members keep the ones they earned), and its top 100 / top 10 / Champion (by WPG XP earned in it) get permanent frames. It starts by itself at the date below; if the game wipes early, press <b>Start new season now</b>. The app also warns staff when several members' Wardog levels drop at once.</p>
      <div class="tiles" style="margin-bottom:12px">
        <div class="tile"><div class="ic">${icon('calendar')}</div><div class="grow"><div class="lbl">Current</div><div class="val">${esc(cur ? cur.name || `Season ${cur.number}` : 'None')}</div>${cur ? `<div class="muted small">Since ${esc(fmtDate(cur.start_at))}</div>` : ''}</div></div>
        <div class="tile"><div class="ic">${icon('clock')}</div><div class="grow"><div class="lbl">Next wipe</div><div class="val">${esc(next ? fmtDate(next.start_at) : 'Not set')}</div>${next ? `<div class="muted small">${esc(next.name || `Season ${next.number}`)} · ${esc(when(next.start_at))}</div>` : ''}</div></div>
      </div>
      <form class="row" id="nextForm" style="align-items:flex-end">
        <label class="field"><span>Next wipe (your time)</span><input type="datetime-local" name="start_at" value="${esc(local(next?.start_at))}" required></label>
        <label class="field"><span>Season name</span><input type="text" name="name" maxlength="40" value="${esc(next?.name || `Season ${(cur?.number || 0) + 1}`)}"></label>
        <button class="btn primary">Save date</button>
        <button class="btn danger" type="button" id="startNow">Start new season now</button>
      </form>
      ${d.seasons.filter((s) => s.status === 'ended').length ? `<p class="muted small" style="margin:12px 0 0">Past: ${d.seasons.filter((s) => s.status === 'ended').map((s) => `${esc(s.name || `Season ${s.number}`)} (${esc(fmtDate(s.start_at))} – ${esc(fmtDate(s.end_at))})`).join(' · ')}</p>` : ''}
    </div>
    <div class="panel" style="margin-top:16px">
      <div class="row between"><div class="panel-title" style="margin:0">${icon('medal')} Frames</div><button class="btn primary" id="addFrame">${icon('plus')} Add frame</button></div>
      <p class="muted small">Members unlock these from what they do and pick one to show around their picture. A new frame's first check is quiet (no flood of posts for people who already qualify); after that, each unlock gets an app notification and, for WPG members, a Discord post.</p>
      <label class="row small" style="gap:8px;margin:0 0 10px"><input type="checkbox" id="postFrames" ${d.posting ? 'checked' : ''}> Post unlocks (WPG members only) and new seasons in Discord</label>
      ${CATS.filter(([k]) => k !== 'season').map(([k, title, help]) => `<h4 class="row" style="margin:14px 0 6px">${esc(title)} <span class="muted small" style="font-weight:400;text-transform:none">${esc(help)}</span></h4>
        <div class="list">${d.frames.filter((f) => f.category === k).map(row).join('') || '<p class="empty">None yet.</p>'}</div>`).join('')}
      <h4 class="row" style="margin:18px 0 2px">Season <span class="muted small" style="font-weight:400;text-transform:none">${esc(CATS[2][2])}</span></h4>
      <p class="muted small" style="margin:0 0 6px">When a season starts, it gets last season's challenges in new looks (with its season number on them), unless you've made its set already. ${next && !nextHas ? 'You can make the next set now to change the looks before the wipe.' : ''}</p>
      ${next && !nextHas && cur ? `<button class="btn small" id="makeNext" style="margin-bottom:8px">${icon('plus')} Make ${esc(seasonName(next))}'s frames now</button>` : ''}
      ${seasonIds.map((sid) => `<div class="muted small" style="margin:12px 0 4px;font:700 13px var(--head);text-transform:uppercase;color:var(--accent2)">${esc(label(sid))}</div>
        <div class="list">${d.frames.filter((f) => f.category === 'season' && f.season_id === sid).map(row).join('')}</div>`).join('') || '<p class="empty">None yet.</p>'}
    </div>`;
  const reload = () => framesAdminTab(body);
  body.querySelector('#nextForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('admin/seasons/next', { method: 'PUT', body: { start_at: new Date(f.start_at.value).toISOString(), name: f.name.value } });
      toast('Wipe date saved', when(new Date(f.start_at.value)));
      reload();
    } catch (x) { fail(x); }
  };
  body.querySelector('#startNow').onclick = async () => {
    if (!(await confirmBox(`Start ${next?.name || 'the new season'} now? ${cur ? `${cur.name || `Season ${cur.number}`} ends, its top 100 get their placing frames, ` : ''}its frames can't be earned any more (members keep theirs), the new season's set starts and everyone's season WPG XP starts from zero. Only do this if the game has wiped.`))) return;
    try {
      const r = await api('admin/seasons/start-now', { method: 'POST', body: {} });
      toast(`Season ${r.number} started`);
      reload();
    } catch (x) { fail(x); }
  };
  body.querySelector('#postFrames').onchange = async (e) => {
    try {
      await api('admin/frames-discord', { method: 'PUT', body: { posting: e.target.checked } });
      toast(e.target.checked ? 'Discord posts on' : 'Discord posts off');
    } catch (x) { fail(x); }
  };
  body.querySelector('#makeNext')?.addEventListener('click', async () => {
    try {
      const r = await api('admin/seasons/next/frames', { method: 'POST', body: {} });
      toast(`${r.count} frames made`, `Change their looks before ${seasonName(next)} starts.`);
      reload();
    } catch (x) { fail(x); }
  });
  body.querySelector('#addFrame').onclick = () => frameEditor(d, null, reload);
  body.querySelectorAll('[data-edit-frame]').forEach((b) => {
    b.onclick = () => frameEditor(d, d.frames.find((f) => f.id === Number(b.dataset.editFrame)), reload);
  });
  body.querySelectorAll('[data-holders]').forEach((b) => {
    b.onclick = () => holdersModal(d.frames.find((f) => f.id === Number(b.dataset.holders)), reload);
  });
}

function frameEditor(d, f, done) {
  const cur = d.seasons.find((x) => x.status === 'active');
  const v = f || { name: '', description: '', category: 'permanent', style: 'metal-gold', color: '#29b6f6', badge: 'star', label: '', crown: false, metric: 'manual', target: 0, sort_order: 500, enabled: true, season_id: cur?.id || null };
  const placement = v.metric === 'placement';
  const ended = v.category === 'season' && d.seasons.find((x) => x.id === v.season_id)?.status === 'ended';
  const openSeasons = d.seasons.filter((x) => x.status !== 'ended');
  const metrics = Object.entries(d.metrics).filter(([k]) => k !== 'placement');
  let image = { id: v.image_id || null, url: v.image || '' };
  const m = modal(`<form class="stack" id="frameForm">
    <h3 style="margin:0">${f ? 'Edit frame' : 'New frame'}</h3>
    <div class="row" style="gap:16px;align-items:flex-start">
      <div id="framePrev" style="flex:none"></div>
      <div class="grow stack">
        <label class="field"><span>Name</span><input type="text" name="name" maxlength="60" value="${esc(v.name)}" required></label>
        <label class="field"><span>How to unlock it (shown to members)</span><input type="text" name="description" maxlength="200" value="${esc(v.description)}"></label>
      </div>
    </div>
    <div class="row">
      <label class="field grow"><span>Look</span><select name="style">${Object.entries(FRAME_STYLES).map(([k, l]) => `<option value="${k}" ${v.style === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="field"><span>Colour</span><input type="color" name="color" value="${esc(/^#[0-9a-f]{6}$/i.test(v.color) ? v.color : '#29b6f6')}"></label>
      <label class="field"><span>Corner badge</span><select name="badge"><option value="">None</option>${['rank', ...FRAME_BADGES].map((b) => `<option value="${b}" ${v.badge === b ? 'selected' : ''}>${badgeName(b)}</option>`).join('')}</select></label>
    </div>
    <div class="frame-upload" id="uploadBox">
      <b>Frame picture</b>
      <ul class="small">
        <li><b>${512} x ${512} px</b>, square: PNG, WebP or GIF (animated is fine), up to 1 MB.</li>
        <li>The <b>middle must be transparent</b>: the member's picture shows through it, <b>378 x 378 px from 67 to 445 px</b>, with rounded corners.</li>
        <li>The frame art goes in the <b>outer 67 px</b> all round (it can overlap the picture's edge a little).</li>
        <li>Bottom right: the corner badge or clan rank (pick None above to keep that corner clear). Bottom left: the season tag on season frames.</li>
        <li>Bigger squares (up to 4 MB) are made 512 x 512 for you, except animated GIFs.</li>
      </ul>
      <div class="row">
        <a class="btn small" href="/api/admin/frames/template.png" download="wpg-frame-template-512.png">${icon('back', 'style="transform:rotate(-90deg)"')} Download the template</a>
        <label class="btn small primary" style="cursor:pointer">${icon('plus')} ${image.id ? 'Upload a new picture' : 'Upload the picture'}<input type="file" id="frameFile" accept="image/png,image/webp,image/gif" hidden></label>
      </div>
      <p class="small" id="uploadStatus" style="margin:8px 0 0">${image.id ? 'Picture uploaded.' : ''}</p>
    </div>
    <div class="frame-sizes" id="frameSizes"></div>
    <div class="row">
      <label class="field"><span>Plaque text (laurel / clan)</span><input type="text" name="label" maxlength="6" value="${esc(v.label)}"></label>
      <label class="row small" style="gap:6px"><input type="checkbox" name="crown" ${v.crown ? 'checked' : ''}> Crown (laurel)</label>
    </div>
    ${placement ? '<p class="muted small">A season placing frame, made by the app when the season ended. You can change its look and name.</p>' : ended ? '<p class="muted small">From a season that has ended: members keep it, but it can\'t be earned any more. You can change its look and wording.</p>' : `
    <div class="row">
      <label class="field grow"><span>Unlocked by</span><select name="metric">${metrics.map(([k, x]) => `<option value="${k}" ${v.metric === k ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
      <label class="field"><span id="targetLbl">Target</span><input type="number" name="target" min="0" step="any" value="${esc(v.target)}"></label>
    </div>
    <div class="row">
      <label class="field"><span>Kind</span><select name="category">${CATS.map(([k, l]) => `<option value="${k}" ${v.category === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field" id="seasonField"><span>Season</span><select name="season_id">${openSeasons.map((x) => `<option value="${x.id}" ${v.season_id === x.id ? 'selected' : ''}>${esc(seasonName(x))}${x.status === 'scheduled' ? ' (next)' : ''}</option>`).join('')}</select></label>
      <label class="field"><span>Order</span><input type="number" name="sort_order" value="${esc(v.sort_order)}"></label>
      <label class="row small" style="gap:6px"><input type="checkbox" name="enabled" ${v.enabled ? 'checked' : ''}> On</label>
      <label class="row small" style="gap:6px" id="tagField"><input type="checkbox" name="season_tag" ${v.season_tag !== false ? 'checked' : ''}> Season tag (S1, S2…)</label>
    </div>
    <p class="muted small" id="metricHelp"></p>`}
    ${f && f.category !== 'clan' ? `<div class="row"><input type="text" name="giveTo" list="frameMembers" placeholder="Give it to a member…" class="grow"><datalist id="frameMembers"></datalist><button type="button" class="btn" id="giveBtn">${icon('plus')} Give</button></div>` : ''}
    <div class="row" style="justify-content:space-between">
      ${f && !['clan_member', 'unit', 'officer'].includes(f.metric) ? `<button type="button" class="btn danger" id="delFrame">${icon('trash')} Delete</button>` : '<span></span>'}
      <div class="row"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div>
    </div>
  </form>`);
  const form = m.el.querySelector('form');
  const prev = () => {
    const cat = form.category?.value || v.category;
    const sid = form.season_id ? Number(form.season_id.value) : v.season_id;
    const seasonNo = cat === 'season' ? d.seasons.find((x) => x.id === sid)?.number : null;
    const sf = m.el.querySelector('#seasonField');
    if (sf) sf.style.display = cat === 'season' ? '' : 'none';
    // Clan frames always show the member's clan rank badge in the corner.
    if (cat === 'clan') form.badge.value = 'rank';
    form.badge.disabled = cat === 'clan';
    form.badge.title = cat === 'clan' ? "Clan frames always show the member's clan rank badge" : '';
    const tf = m.el.querySelector('#tagField');
    if (tf) tf.style.display = cat === 'season' ? '' : 'none';
    const isImage = form.style.value === 'image';
    m.el.querySelector('#uploadBox').style.display = isImage ? '' : 'none';
    const look = {
      style: form.style.value, color: form.color.value, badge: form.badge.value, label: form.label.value, crown: form.crown.checked,
      season: seasonNo, season_tag: form.season_tag ? form.season_tag.checked : v.season_tag !== false, image: isImage ? image.url : '', rank: state.me.rank,
    };
    m.el.querySelector('#framePrev').innerHTML = framedPreview(look, state.me.avatar, 110);
    // How it looks where members see it (with your picture and clan rank).
    m.el.querySelector('#frameSizes').innerHTML = [[30, 'Chat & lists'], [40, 'Members'], [62, 'Discord cards'], [136, 'Profile']]
      .map(([px, what]) => `<div class="fs">${framedPreview(look, state.me.avatar, px)}<span>${what}<br>${px} px</span></div>`).join('');
    const help = m.el.querySelector('#metricHelp');
    if (help && form.metric) {
      const x = d.metrics[form.metric.value] || {};
      m.el.querySelector('#targetLbl').textContent = form.metric.value === 'officer' ? 'Rank order (Admin → Ranks)' : `Target${x.unit ? ` (${x.unit})` : ''}`;
      help.textContent = x.scope === 'season' ? 'Counts this season only, so it can only be a Season frame.' : x.scope === 'clan' ? 'Follows membership, unit or rank live, so it is a Clan frame (WPG members only).' : x.yesno ? 'Yes or no: no target needed.' : '';
    }
  };
  form.addEventListener('input', prev);
  form.addEventListener('change', prev);
  prev();
  m.el.querySelector('[data-close]').onclick = m.close;
  // Upload: checked here for type and size, then properly by the server (size, square, transparent middle).
  m.el.querySelector('#frameFile').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    const status = m.el.querySelector('#uploadStatus');
    if (!file) return;
    if (!['image/png', 'image/webp', 'image/gif'].includes(file.type)) { status.innerHTML = '<span style="color:var(--red)">Frames must be PNG, WebP or GIF (JPEG has no transparency).</span>'; return; }
    if (file.size > 4 * 1024 * 1024) { status.innerHTML = `<span style="color:var(--red)">That file is ${Math.round(file.size / 1024)} KB: the most is 4 MB.</span>`; return; }
    status.textContent = 'Checking…';
    try {
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error("Couldn't read that file."));
        r.readAsDataURL(file);
      });
      const r = await api('admin/frame-images', { method: 'POST', body: { data } });
      image = { id: r.id, url: r.url };
      status.innerHTML = `<span style="color:var(--green)">✓ Uploaded (${Math.round(r.bytes / 1024)} KB).</span>${r.notes.map((n) => ` <span style="color:#f5a524">${esc(n)}</span>`).join('')} Check the previews, then Save.`;
      prev();
    } catch (x) {
      status.innerHTML = `<span style="color:var(--red)">${esc(x.message)}</span>`;
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const b = {
      name: form.name.value, description: form.description.value, style: form.style.value, color: form.color.value, badge: form.badge.value,
      label: form.label.value, crown: form.crown.checked,
      metric: form.metric?.value || v.metric, target: form.target ? Number(form.target.value) : v.target,
      category: form.category?.value || v.category, sort_order: form.sort_order ? Number(form.sort_order.value) : v.sort_order,
      enabled: form.enabled ? form.enabled.checked : v.enabled,
      season_id: form.season_id ? Number(form.season_id.value) : v.season_id,
      image_id: form.style.value === 'image' ? image.id : null,
      season_tag: form.season_tag ? form.season_tag.checked : v.season_tag !== false,
    };
    if (b.style === 'image' && !b.image_id) return toast('Upload the frame picture first', '', { error: true });
    try {
      await api(f ? `admin/frames/${f.id}` : 'admin/frames', { method: f ? 'PUT' : 'POST', body: b });
      toast(f ? 'Frame saved' : 'Frame added', f ? '' : 'Members who already qualify get it quietly at the next hourly check.');
      m.close();
      done();
    } catch (x) { fail(x); }
  };
  m.el.querySelector('#delFrame')?.addEventListener('click', async () => {
    if (!(await confirmBox(`Delete "${v.name}"? Everyone who unlocked it loses it.`))) return;
    try {
      await api(`admin/frames/${f.id}`, { method: 'DELETE' });
      m.close();
      done();
    } catch (x) { fail(x); }
  });
  const give = m.el.querySelector('#giveBtn');
  if (give) {
    api('members').then((list) => {
      m.el.querySelector('#frameMembers').innerHTML = list.map((u) => `<option value="${esc(u.name)}"></option>`).join('');
      give.onclick = async () => {
        const name = form.giveTo.value.trim().toLowerCase();
        const u = list.find((x) => x.name.toLowerCase() === name);
        if (!u) return toast('Pick a member from the list', '', { error: true });
        try {
          await api(`admin/frames/${f.id}/give`, { method: 'POST', body: { userId: u.id } });
          toast('Frame given', `${u.name} has ${v.name}.`);
          form.giveTo.value = '';
          done();
        } catch (x) { fail(x); }
      };
    }).catch(() => {});
  }
}

async function holdersModal(f, done) {
  const rows = await api(`admin/frames/${f.id}/holders`).catch((x) => { fail(x); return null; });
  if (!rows) return;
  const m = modal(`<h3 style="margin:0 0 10px">${esc(f.name)} <span class="muted small">${fmtNum(rows.length)} unlocked</span></h3>
    <div class="list" style="max-height:60vh;overflow:auto">${rows.map((r) => `<div class="item"><div class="grow"><a href="#/u/${r.id}">${esc(r.name)}</a><div class="muted small">${esc(fmtDate(r.unlocked_at))}${r.season_id ? ' · this season' : ''}</div></div>
      <button class="btn small ghost" data-take="${r.id}">Take away</button></div>`).join('') || '<p class="empty">Nobody yet.</p>'}</div>
    <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn ghost" data-close>Close</button></div>`);
  m.el.querySelector('[data-close]').onclick = m.close;
  m.el.querySelectorAll('[data-take]').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmBox('Take this frame away from them?'))) return;
      try {
        await api(`admin/frames/${f.id}/give/${b.dataset.take}`, { method: 'DELETE' });
        b.closest('.item').remove();
        done();
      } catch (x) { fail(x); }
    };
  });
}
