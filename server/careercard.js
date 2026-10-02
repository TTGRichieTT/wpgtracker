// Draws a member's "Player career profile" card as a picture (used by the Discord bot's /stats).
// The artwork is the WPG design in assets/career-card.png: each value box is painted clean and the
// member's own numbers are written in. A band with their medals and Steam achievements is added
// between the panels and the footer art. Fonts: Rajdhani and Inter (open licence, assets/fonts).
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const W = 1536;
// The design's panels end at y=905 on the left (class cards) but y=880 on the right, where the footer
// art ("PLAY HARDER TOGETHER", soldiers) already starts. So: the top is copied down to SPLIT, the new
// band goes below it, then the footer art from FOOT_SRC; the overlapping strips are painted over.
const SPLIT = 908;
const RIGHT_END = 882; // right-hand panel's bottom edge
const MID_X = 826; // gap between the left and right panels
const FOOT_SRC = 880;
const FOOT = 1024 - FOOT_SRC;
const BAND = 250;
const BAND_BG = '#040b14';

// Value boxes in the design: x, y, width, height (measured from the artwork).
const BOX = {
  name: [397, 315, 851, 37], steam: [405, 396, 253, 33], discord: [774, 396, 248, 33], member: [1144, 397, 333, 32],
  publicRank: [115, 565, 151, 32], level: [381, 565, 156, 34], totalXp: [638, 565, 156, 34],
  cash: [115, 640, 283, 35], worth: [518, 640, 257, 35],
  serverRank: [929, 566, 125, 34], wpgRank: [1166, 566, 117, 34], wpgXp: [1393, 566, 100, 34],
  kills: [854, 725, 107, 29], deaths: [986, 725, 107, 29], kd: [1118, 725, 107, 29], matches: [1250, 725, 107, 29], wins: [1383, 725, 109, 29],
  losses: [854, 834, 106, 30], wl: [986, 834, 106, 30], playtime: [1220, 810, 273, 31],
  recon: [44, 871, 107, 25], assault: [172, 871, 107, 25], medic: [300, 871, 106, 25],
  support: [426, 871, 107, 25], driver: [555, 871, 108, 25], pilot: [687, 871, 117, 25],
};
const BOX_FILL = 'rgb(21,44,63)';
const WHITE = '#f3f7fb';
const CYAN = '#33d1ff';
const GREEN = '#4ade80';
const AMBER = '#f5a524';

const VALUE_FONT = 'Inter, InterExt, InterCyr';
const LABEL_FONT = 'Rajdhani, RajdhaniExt';

let setup = null;
function prepare() {
  if (!setup) {
    setup = (async () => {
      const font = (file, family) => GlobalFonts.registerFromPath(path.join(ASSETS, 'fonts', file), family);
      font('inter-latin-800-normal.ttf', 'Inter');
      font('inter-latin-600-normal.ttf', 'Inter');
      font('inter-latin-ext-800-normal.ttf', 'InterExt');
      font('inter-latin-ext-600-normal.ttf', 'InterExt');
      font('inter-cyrillic-800-normal.ttf', 'InterCyr');
      font('inter-cyrillic-600-normal.ttf', 'InterCyr');
      font('rajdhani-latin-700-normal.ttf', 'Rajdhani');
      font('rajdhani-latin-ext-700-normal.ttf', 'RajdhaniExt');
      return loadImage(path.join(ASSETS, 'career-card.png'));
    })();
    setup.catch(() => { setup = null; });
  }
  return setup;
}

// Steam achievement icons, fetched once and kept.
const iconCache = new Map();
async function icon(url) {
  if (!/^https:\/\//.test(url || '')) return null;
  if (iconCache.has(url)) return iconCache.get(url);
  const img = await fetch(url, { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((b) => (b ? loadImage(Buffer.from(b)) : null))
    .catch(() => null);
  if (iconCache.size > 400) iconCache.clear();
  iconCache.set(url, img);
  return img;
}

// Writes text centred in a box, shrinking it until it fits.
function fitText(g, text, cx, cy, maxW, size, { font = VALUE_FONT, weight = 800, color = WHITE, minSize = 10 } = {}) {
  let s = size;
  g.font = `${weight} ${s}px ${font}`;
  while (s > minSize && g.measureText(text).width > maxW) {
    s -= 1;
    g.font = `${weight} ${s}px ${font}`;
  }
  let shown = text;
  if (g.measureText(shown).width > maxW) {
    while (shown.length > 1 && g.measureText(`${shown}…`).width > maxW) shown = shown.slice(0, -1);
    shown = `${shown}…`;
  }
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(shown, cx, cy + 1);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Repaints a value box (a flat rounded box in the design) and writes the new value in it.
function value(g, key, text, opts = {}) {
  const [x, y, w, h] = BOX[key];
  g.fillStyle = BOX_FILL;
  roundRect(g, x, y, w, h, 6);
  g.fill();
  const str = String(text);
  const size = opts.size || Math.round(h * 0.56);
  // Long text in a small box (e.g. "COMMAND SERGEANT MAJOR X"): two lines rather than tiny or cut off.
  if (opts.wrap && str.includes(' ')) {
    g.font = `${opts.weight || 800} ${Math.max(13, size - 4)}px ${opts.font || VALUE_FONT}`;
    if (g.measureText(str).width > w - 14) {
      const words = str.split(' ');
      let best = null;
      for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(' ');
        const b = words.slice(i).join(' ');
        const widest = Math.max(g.measureText(a).width, g.measureText(b).width);
        if (!best || widest < best.widest) best = { a, b, widest };
      }
      const lineSize = Math.min(14, Math.floor(h / 2.3));
      fitText(g, best.a, x + w / 2, y + h / 2 - lineSize * 0.58, w - 12, lineSize, { ...opts, minSize: 8 });
      fitText(g, best.b, x + w / 2, y + h / 2 + lineSize * 0.58, w - 12, lineSize, { ...opts, minSize: 8 });
      return;
    }
  }
  fitText(g, str, x + w / 2, y + h / 2, w - 14, size, opts);
}

// A panel in the style of the design: dark, cut corners, thin glowing cyan edge.
function panel(g, x, y, w, h) {
  const c = 16;
  g.beginPath();
  g.moveTo(x + c, y); g.lineTo(x + w, y); g.lineTo(x + w, y + h - c); g.lineTo(x + w - c, y + h); g.lineTo(x, y + h); g.lineTo(x, y + c);
  g.closePath();
  g.fillStyle = 'rgba(6,16,28,0.94)';
  g.fill();
  g.save();
  g.shadowColor = 'rgba(41,182,246,0.75)';
  g.shadowBlur = 10;
  g.strokeStyle = 'rgba(56,170,235,0.85)';
  g.lineWidth = 1.6;
  g.stroke();
  g.restore();
}

// Section title like the design's: white words, then a cyan word in brackets.
function title(g, x, y, main, accent) {
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.font = `700 30px ${LABEL_FONT}`;
  const grad = g.createLinearGradient(0, y - 14, 0, y + 14);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#b9c7d4');
  g.fillStyle = grad;
  g.fillText(main, x, y);
  const mw = g.measureText(main).width;
  g.fillStyle = CYAN;
  g.fillText(accent, x + mw + 12, y);
}

function medalIcon(g, cx, cy) {
  g.save();
  g.fillStyle = '#e8f4ff';
  g.beginPath(); g.moveTo(cx - 11, cy - 16); g.lineTo(cx - 3, cy - 16); g.lineTo(cx + 3, cy - 4); g.lineTo(cx - 5, cy - 4); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(cx + 11, cy - 16); g.lineTo(cx + 3, cy - 16); g.lineTo(cx - 3, cy - 4); g.lineTo(cx + 5, cy - 4); g.closePath(); g.fill();
  g.beginPath(); g.arc(cx, cy + 6, 11, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#0a1622';
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 3 : 7;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(cx + Math.cos(a) * r, cy + 6 + Math.sin(a) * r);
  }
  g.closePath(); g.fill();
  g.restore();
}

function trophyIcon(g, cx, cy) {
  g.save();
  g.fillStyle = '#e8f4ff';
  g.beginPath(); g.moveTo(cx - 12, cy - 14); g.lineTo(cx + 12, cy - 14); g.lineTo(cx + 9, cy + 2); g.quadraticCurveTo(cx, cy + 9, cx - 9, cy + 2); g.closePath(); g.fill();
  g.fillRect(cx - 2, cy + 4, 4, 7);
  g.fillRect(cx - 9, cy + 11, 18, 4);
  g.lineWidth = 3; g.strokeStyle = '#e8f4ff';
  g.beginPath(); g.arc(cx - 13, cy - 7, 5, Math.PI * 0.5, Math.PI * 1.5); g.stroke();
  g.beginPath(); g.arc(cx + 13, cy - 7, 5, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();
  g.restore();
}

function ribbon(g, x, y, w, h, colors) {
  const list = String(colors || '#888888').split(',').map((c) => (/^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : '#888888'));
  const step = w / list.length;
  g.save();
  roundRect(g, x, y, w, h, 3);
  g.clip();
  list.forEach((c, i) => { g.fillStyle = c; g.fillRect(x + i * step, y, step + 1, h); });
  const shine = g.createLinearGradient(0, y, 0, y + h);
  shine.addColorStop(0, 'rgba(255,255,255,0.28)');
  shine.addColorStop(0.5, 'rgba(255,255,255,0)');
  shine.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = shine;
  g.fillRect(x, y, w, h);
  g.restore();
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 1;
  roundRect(g, x + 0.5, y + 0.5, w - 1, h - 1, 3);
  g.stroke();
}

// Wraps a short name onto up to two centred lines.
function twoLines(g, text, cx, y, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [''];
  for (const wd of words) {
    const tryLine = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${wd}` : wd;
    if (g.measureText(tryLine).width <= maxW || !lines[lines.length - 1]) lines[lines.length - 1] = tryLine;
    else if (lines.length < 2) lines.push(wd);
    else { lines[1] = `${lines[1]}…`; break; }
  }
  lines.forEach((l, i) => {
    let s = l;
    while (s.length > 1 && g.measureText(s).width > maxW) s = `${s.slice(0, -2)}…`;
    g.fillText(s, cx, y + i * 17);
  });
}

function medalsPanel(g, x, y, w, h, medals) {
  panel(g, x, y, w, h);
  medalIcon(g, x + 44, y + 34);
  title(g, x + 78, y + 36, 'MEDALS', '(TOP TIER)');
  g.font = `700 22px ${LABEL_FONT}`;
  g.textAlign = 'right';
  g.fillStyle = '#9fb3c6';
  g.fillText(`${medals.length} ${medals.length === 1 ? 'MEDAL' : 'MEDALS'}`, x + w - 28, y + 37);
  if (!medals.length) {
    g.font = `600 18px ${VALUE_FONT}`;
    g.fillStyle = '#9fb3c6';
    g.textAlign = 'left';
    g.fillText('No medals yet — they come with class levels, hours played and from staff.', x + 30, y + 120);
    return;
  }
  const cols = 6;
  const cellW = (w - 40) / cols;
  // Room for 12; with more, the 12th spot says how many more there are.
  const shown = medals.length > 12 ? medals.slice(0, 11) : medals;
  const cellTop = (i) => y + 72 + Math.floor(i / cols) * 80;
  const cellX = (i) => x + 20 + cellW * (i % cols) + cellW / 2;
  g.textAlign = 'center';
  g.textBaseline = 'top';
  shown.forEach((m, i) => {
    ribbon(g, cellX(i) - 46, cellTop(i), 92, 26, m.colors);
    g.font = `700 16px ${LABEL_FONT}`;
    g.fillStyle = '#dfe9f3';
    twoLines(g, m.name.toUpperCase(), cellX(i), cellTop(i) + 32, cellW - 10);
  });
  if (medals.length > shown.length) {
    const i = shown.length;
    g.fillStyle = BOX_FILL;
    roundRect(g, cellX(i) - 46, cellTop(i), 92, 26, 3);
    g.fill();
    g.font = `700 18px ${LABEL_FONT}`;
    g.fillStyle = CYAN;
    g.textBaseline = 'middle';
    g.fillText(`+${medals.length - shown.length}`, cellX(i), cellTop(i) + 14);
    g.textBaseline = 'top';
    g.font = `700 16px ${LABEL_FONT}`;
    g.fillStyle = '#9fb3c6';
    g.fillText('MORE IN THE APP', cellX(i), cellTop(i) + 32);
  }
}

async function achievementsPanel(g, x, y, w, h, ach) {
  panel(g, x, y, w, h);
  trophyIcon(g, x + 42, y + 36);
  title(g, x + 74, y + 36, 'STEAM ACHIEVEMENTS', ach.game ? `(${ach.game.toUpperCase()})` : '');
  g.font = `800 22px ${VALUE_FONT}`;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.fillStyle = WHITE;
  g.fillText(`${ach.earned.length} / ${ach.total || ach.earned.length}`, x + w - 28, y + 37);
  // Progress bar.
  const bx = x + 28;
  const bw = w - 56;
  const by = y + 64;
  g.fillStyle = BOX_FILL;
  roundRect(g, bx, by, bw, 10, 5); g.fill();
  const pct = ach.total ? Math.min(1, ach.earned.length / ach.total) : 0;
  if (pct > 0) {
    const grad = g.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, '#1e88e5');
    grad.addColorStop(1, CYAN);
    g.fillStyle = grad;
    roundRect(g, bx, by, Math.max(10, bw * pct), 10, 5); g.fill();
  }
  if (!ach.earned.length) {
    g.font = `600 18px ${VALUE_FONT}`;
    g.fillStyle = '#9fb3c6';
    g.textAlign = 'left';
    g.fillText(ach.total ? 'No achievements yet (or Steam game details are private).' : 'Achievements show once Steam stats have synced.', x + 28, y + 130);
    return;
  }
  const size = 50;
  const gap = 8;
  const perRow = Math.floor((bw + gap) / (size + gap));
  const shown = ach.earned.slice(0, perRow * 2 - (ach.earned.length > perRow * 2 ? 1 : 0));
  const imgs = await Promise.all(shown.map((a) => icon(a.icon)));
  shown.forEach((a, i) => {
    const ix = bx + (i % perRow) * (size + gap);
    const iy = by + 22 + Math.floor(i / perRow) * (size + gap);
    g.save();
    roundRect(g, ix, iy, size, size, 6);
    g.clip();
    if (imgs[i]) g.drawImage(imgs[i], ix, iy, size, size);
    else { g.fillStyle = BOX_FILL; g.fillRect(ix, iy, size, size); }
    g.restore();
    g.strokeStyle = 'rgba(56,170,235,0.7)';
    g.lineWidth = 1;
    roundRect(g, ix + 0.5, iy + 0.5, size - 1, size - 1, 6);
    g.stroke();
  });
  if (ach.earned.length > shown.length) {
    const i = shown.length;
    const ix = bx + (i % perRow) * (size + gap);
    const iy = by + 22 + Math.floor(i / perRow) * (size + gap);
    g.fillStyle = BOX_FILL;
    roundRect(g, ix, iy, size, size, 6); g.fill();
    g.font = `800 17px ${VALUE_FONT}`;
    g.fillStyle = CYAN;
    g.textAlign = 'center';
    g.fillText(`+${ach.earned.length - shown.length}`, ix + size / 2, iy + size / 2);
  }
  const rarest = ach.earned[0];
  if (rarest?.percent !== null && rarest?.percent !== undefined) {
    g.font = `600 15px ${VALUE_FONT}`;
    g.fillStyle = '#9fb3c6';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    let line = `Rarest: ${rarest.name} — ${Number(rarest.percent).toFixed(1)}% of players`;
    while (line.length > 10 && g.measureText(line).width > bw) line = `${line.slice(0, -2)}…`;
    g.fillText(line, bx, y + h - 13);
  }
}

const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
const money = (n) => `$${fmt(Math.round(Number(n) || 0))}`;
function playtime(secs) {
  const m = Math.floor((Number(secs) || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

// d: { name, steamId, discord, member, official{...}|null, worldRank, wpg{rank,xp,position}, server{...}, medals[], achievements{} }
export async function renderCareerCard(d) {
  const art = await prepare();
  const FOOT_Y = SPLIT + BAND; // where the footer art starts on the card
  const canvas = createCanvas(W, FOOT_Y + FOOT);
  const g = canvas.getContext('2d');

  // Artwork: panels on top, new band in the middle, footer art at the bottom.
  g.drawImage(art, 0, 0, W, SPLIT, 0, 0, W, SPLIT);
  g.drawImage(art, 0, FOOT_SRC, W, FOOT, 0, FOOT_Y, W, FOOT);
  g.fillStyle = BAND_BG;
  g.fillRect(0, SPLIT, W, BAND);
  // Right side: the top copy ran past the right panel into the footer art; hide that strip.
  const rightFade = g.createLinearGradient(0, RIGHT_END, 0, RIGHT_END + 8);
  rightFade.addColorStop(0, 'rgba(4,11,20,0)');
  rightFade.addColorStop(1, BAND_BG);
  g.fillStyle = rightFade;
  g.fillRect(MID_X, RIGHT_END, W - MID_X, 8);
  g.fillStyle = BAND_BG;
  g.fillRect(MID_X, RIGHT_END + 8, W - MID_X, SPLIT - RIGHT_END - 8);
  // Left side: the footer copy starts with the bottom of the class cards; hide that, fading into the art.
  const coverH = SPLIT - FOOT_SRC; // rows of the footer copy that belong to the panels above
  g.fillStyle = BAND_BG;
  g.fillRect(0, FOOT_Y, MID_X - 14, coverH);
  const sideFade = g.createLinearGradient(MID_X - 14, 0, MID_X + 26, 0);
  sideFade.addColorStop(0, BAND_BG);
  sideFade.addColorStop(1, 'rgba(4,11,20,0)');
  g.fillStyle = sideFade;
  g.fillRect(MID_X - 14, FOOT_Y, 40, coverH);
  const downFade = g.createLinearGradient(0, FOOT_Y + coverH, 0, FOOT_Y + coverH + 16);
  downFade.addColorStop(0, BAND_BG);
  downFade.addColorStop(1, 'rgba(4,11,20,0)');
  g.fillStyle = downFade;
  g.fillRect(0, FOOT_Y + coverH, MID_X, 16);
  // Soften the band's bottom edge into the footer art on the right.
  const seam = g.createLinearGradient(0, FOOT_Y, 0, FOOT_Y + 14);
  seam.addColorStop(0, BAND_BG);
  seam.addColorStop(1, 'rgba(4,11,20,0)');
  g.fillStyle = seam;
  g.fillRect(MID_X, FOOT_Y, W - MID_X, 14);

  // The design's fifth class card says ENGINEER; Wardogs calls that class DRIVER.
  g.fillStyle = 'rgb(1,2,5)';
  g.fillRect(566, 845, 84, 24);
  g.font = `700 19px ${LABEL_FONT}`;
  const labelShade = g.createLinearGradient(0, 850, 0, 866);
  labelShade.addColorStop(0, '#ffffff');
  labelShade.addColorStop(1, '#c4ccd4');
  g.fillStyle = labelShade;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('DRIVER', 608, 858);

  // Player information.
  value(g, 'name', d.name || 'Unknown', { size: 22 });
  value(g, 'steam', d.steamId || '—', { size: 17 });
  value(g, 'discord', d.discord || '—', { size: 17 });
  value(g, 'member', d.member || 'YES', { size: 17, color: d.member === 'PMC' ? AMBER : GREEN });

  // Official Wardogs (global).
  const o = d.official;
  value(g, 'publicRank', d.worldRank ? `#${fmt(d.worldRank)}` : '—');
  value(g, 'level', o ? fmt(o.wardogLevel) : '—');
  value(g, 'totalXp', o?.careerXp ? fmt(o.careerXp) : '—');
  value(g, 'cash', o ? money(o.cash) : '—');
  value(g, 'worth', o?.worth ? money(o.worth) : '—');
  for (const role of ['recon', 'assault', 'medic', 'support', 'driver', 'pilot']) {
    const lvl = o?.roles?.[role]?.level ?? o?.roles?.[role];
    value(g, role, o ? fmt(lvl || 0) : '—', { size: 16 });
  }

  // WPG server (private).
  value(g, 'serverRank', d.wpg?.position ? `#${fmt(d.wpg.position)}` : '—');
  value(g, 'wpgRank', String(d.wpg?.rank || 'RECRUIT I').toUpperCase(), { color: CYAN, size: 17, wrap: true });
  value(g, 'wpgXp', fmt(d.wpg?.xp || 0));
  const s = d.server || {};
  value(g, 'kills', fmt(s.kills));
  value(g, 'deaths', fmt(s.deaths));
  value(g, 'kd', (Number(s.kills || 0) / Math.max(1, Number(s.deaths || 0))).toFixed(2));
  value(g, 'matches', fmt(s.matches));
  value(g, 'wins', fmt(s.wins));
  value(g, 'losses', fmt(s.losses));
  value(g, 'wl', (Number(s.wins || 0) / Math.max(1, Number(s.losses || 0))).toFixed(2));
  value(g, 'playtime', playtime(s.playtime));

  // New band: medals and Steam achievements, lined up with the panels above.
  medalsPanel(g, 28, SPLIT + 12, 794, BAND - 24, d.medals || []);
  await achievementsPanel(g, 834, SPLIT + 12, 674, BAND - 24, d.achievements || { earned: [], total: 0 });

  return canvas.encode('jpeg', 90);
}
