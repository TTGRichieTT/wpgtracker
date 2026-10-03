// Draws WPG rank insignia as SVG from a simple spec, e.g. { chevrons: 3, rockers: 1, crown: true }.
// Parts mix US Army (up-chevrons, rockers, bars, oak leaf, general stars)
// and British Army (crown, Bath-star pips, crossed sword & baton) symbols.

const METALS = {
  gold: ['#fbe29a', '#c8962e', '#5a3d0a'],
  silver: ['#ffffff', '#aab4bd', '#3d4650'],
};

export const INSIGNIA_PARTS = [
  { key: 'chevrons', label: 'Chevrons (US/UK)', max: 3 },
  { key: 'rockers', label: 'Rockers (US)', max: 3 },
  { key: 'pips', label: 'Pips / Bath stars (UK)', max: 3 },
  { key: 'bars', label: 'Officer bars (US)', max: 2 },
  { key: 'stars', label: 'General stars (US)', max: 5 },
  { key: 'crown', label: 'Crown (UK)', bool: true },
  { key: 'oak', label: 'Oak leaf (US)', bool: true },
  { key: 'swords', label: 'Sword & baton (UK)', bool: true },
  { key: 'wreath', label: 'Wreath', bool: true },
];

function starPoints(cx, cy, outer, inner, tips, rot = -90) {
  const pts = [];
  for (let i = 0; i < tips * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((rot + (i * 180) / tips) * Math.PI) / 180;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

let uidCounter = 0;

// tag: a short label on a tab at the foot of the shield (WPG ranks use it for I–X).
export function insigniaSVG(spec, { size = 48, color = '#c9a227', abbr = '', plate = true, title = '', tag = '' } = {}) {
  let s = spec;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { s = {}; }
  }
  s = s || {};
  const uid = `ins${++uidCounter}`;
  const [m0, m1, mDark] = METALS[s.metal === 'silver' ? 'silver' : 'gold'];
  const metal = `url(#${uid}m)`;
  const rank = /^#[0-9a-f]{6}$/i.test(color) ? color : '#c9a227';

  // Build the stacked parts top-to-bottom at native size, then scale to fit.
  const parts = [];
  const add = (h, draw) => parts.push({ h, draw });
  const n = (k, max) => Math.max(0, Math.min(max, Number(s[k]) || 0));

  if (s.crown) {
    add(25, (y) => `
      <g transform="translate(50 ${y})">
        <circle cx="0" cy="2.4" r="2.4" fill="${metal}" stroke="${mDark}" stroke-width=".6"/>
        <path d="M-16 21 L-18 6 L-9.5 12.5 L-5 4 L0 11 L5 4 L9.5 12.5 L18 6 L16 21 Z" fill="${metal}" stroke="${mDark}" stroke-width="1"/>
        <path d="M-12.5 18.5 L-13.5 10.5 L-8.5 14.5 L-4.5 9 L0 14.5 L4.5 9 L8.5 14.5 L13.5 10.5 L12.5 18.5 Z" fill="#b22234"/>
        <rect x="-17" y="19.5" width="34" height="5.5" rx="1.2" fill="${metal}" stroke="${mDark}" stroke-width=".8"/>
        <circle cx="-9" cy="22.2" r="1.3" fill="#1f3a93"/><circle cx="0" cy="22.2" r="1.3" fill="#b22234"/><circle cx="9" cy="22.2" r="1.3" fill="#1f3a93"/>
      </g>`);
  }

  const stars = n('stars', 5);
  const starRow = () => {
    const r = stars >= 4 ? 7 : 8.5;
    const gap = stars >= 4 ? 15.5 : 20;
    add(r * 2 + 1, (y) => {
      let out = '';
      for (let i = 0; i < stars; i++) {
        const cx = 50 + (i - (stars - 1) / 2) * gap;
        out += `<polygon points="${starPoints(cx, y + r, r, r * 0.42, 5)}" fill="${metal}" stroke="${mDark}" stroke-width=".8"/>`;
      }
      return out;
    });
  };
  const chevrons = n('chevrons', 3);
  if (stars && !chevrons) starRow();

  const pips = n('pips', 3);
  if (pips) {
    add(21, (y) => {
      let out = '';
      for (let i = 0; i < pips; i++) {
        const cx = 50 + (i - (pips - 1) / 2) * 23;
        const cy = y + 10.5;
        out += `<polygon points="${starPoints(cx, cy, 10, 3.6, 8, -90)}" fill="${metal}" stroke="${mDark}" stroke-width=".7"/>`;
        out += `<circle cx="${cx}" cy="${cy}" r="4.2" fill="#b22234" stroke="${mDark}" stroke-width=".6"/>`;
        out += `<circle cx="${cx}" cy="${cy}" r="1.7" fill="${metal}"/>`;
      }
      return out;
    });
  }

  const bars = n('bars', 2);
  if (bars) {
    add(bars * 12 - 3, (y) => {
      let out = '';
      for (let i = 0; i < bars; i++) {
        out += `<rect x="29" y="${y + i * 12}" width="42" height="9" rx="1.5" fill="${metal}" stroke="${mDark}" stroke-width=".8"/>`;
      }
      return out;
    });
  }

  if (s.oak) {
    add(32, (y) => `
      <path transform="translate(0 ${y})" fill="${metal}" stroke="${mDark}" stroke-width=".9"
        d="M50,0 C56,4 62,2 60,8 C66,9 68,14 62,16 C67,20 64,25 58,23 C58,27 54,28 52,26 L51,32 L49,32 L48,26 C46,28 42,27 42,23 C36,25 33,20 38,16 C32,14 34,9 40,8 C38,2 44,4 50,0 Z"/>
      <path transform="translate(0 ${y})" d="M50 5 V29" stroke="${mDark}" stroke-width=".8" fill="none" opacity=".6"/>`);
  }

  if (chevrons) {
    add(16 + (chevrons - 1) * 10, (y) => {
      let out = '';
      for (let i = 0; i < chevrons; i++) {
        const yy = y + i * 10;
        const d = `M16 ${yy + 16} L50 ${yy + 1} L84 ${yy + 16}`;
        out += `<path d="${d}" stroke="#0a0f14" stroke-width="9" fill="none" stroke-linejoin="miter"/>`;
        out += `<path d="${d}" stroke="${rank}" stroke-width="6" fill="none" stroke-linejoin="miter"/>`;
      }
      return out;
    });
    if (stars) starRow();
  }

  const rockers = n('rockers', 3);
  if (rockers) {
    add(rockers * 10 + 4, (y) => {
      let out = '';
      for (let i = 0; i < rockers; i++) {
        const yy = y + 2 + i * 10;
        const d = `M16 ${yy} Q50 ${yy + 15} 84 ${yy}`;
        out += `<path d="${d}" stroke="#0a0f14" stroke-width="9" fill="none"/>`;
        out += `<path d="${d}" stroke="${rank}" stroke-width="6" fill="none"/>`;
      }
      return out;
    });
  }

  const GAP = 5;
  const total = parts.reduce((t, p) => t + p.h, 0) + Math.max(0, parts.length - 1) * GAP;
  const room = s.wreath ? 58 : 72;
  const scale = total > room ? room / total : 1;
  let y = 0;
  let body = '';
  for (const p of parts) {
    body += p.draw(y);
    y += p.h + GAP;
  }
  const centreY = s.wreath ? 48 : 52;
  let content = parts.length
    ? `<g transform="translate(50 ${centreY}) scale(${scale.toFixed(3)}) translate(-50 ${(-total / 2).toFixed(2)})">${body}</g>`
    : `<text x="50" y="60" text-anchor="middle" font-family="Rajdhani, Arial Narrow, sans-serif" font-weight="700" font-size="24" fill="${rank}" letter-spacing="1">${escapeText(abbr || 'RCT')}</text>`;

  let back = '';
  if (s.swords) {
    back += `<g stroke="${mDark}" stroke-width="1" opacity=".95">
      <path d="M25 80 L75 22" stroke="${metal}" stroke-width="4" stroke-linecap="round"/>
      <path d="M21 74 L31 84" stroke="${metal}" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M75 80 L27 24" stroke="#7a1f1f" stroke-width="5" stroke-linecap="round"/>
      <circle cx="27" cy="24" r="3" fill="${metal}"/><circle cx="75" cy="80" r="3" fill="${metal}"/>
    </g>`;
  }
  if (s.wreath) {
    let leaves = '';
    for (let i = 0; i < 9; i++) {
      const a = (120 + i * 13) * (Math.PI / 180);
      for (const side of [-1, 1]) {
        const x = 50 + side * -Math.cos(a) * 38;
        const yy = 54 + Math.sin(a) * 36;
        const rot = side * (i * 13 - 30);
        leaves += `<ellipse cx="${x.toFixed(1)}" cy="${yy.toFixed(1)}" rx="3.2" ry="6.2" transform="rotate(${rot.toFixed(0)} ${x.toFixed(1)} ${yy.toFixed(1)})" fill="${metal}" stroke="${mDark}" stroke-width=".5"/>`;
      }
    }
    back += `<g>${leaves}</g>`;
  }

  const plateSvg = plate
    ? `<path d="M50 3 L91 13 V50 C91 75 72 90 50 97 C28 90 9 75 9 50 V13 Z" fill="url(#${uid}p)" stroke="${rank}" stroke-opacity=".75" stroke-width="2.2"/>
       <path d="M50 8 L86 16.5 V20 L50 12 L14 20 V16.5 Z" fill="#b22234" opacity=".85"/>
       <path d="M50 12 L86 20 V22.5 L50 15 L14 22.5 V20 Z" fill="#ffffff" opacity=".7"/>
       <path d="M50 15 L86 22.5 V25 L50 17.5 L14 25 V22.5 Z" fill="#1f3a93" opacity=".9"/>`
    : '';

  const tagSvg = tag
    ? `<rect x="33" y="78" width="34" height="15" rx="4" fill="#070d16" stroke="${rank}" stroke-width="1.6"/>
       <text x="50" y="90" text-anchor="middle" font-family="Rajdhani, Arial Narrow, sans-serif" font-weight="700" font-size="13" fill="${rank}" letter-spacing=".5">${escapeText(tag)}</text>`
    : '';
  if (tag && parts.length) content = content.replace(`translate(50 ${centreY})`, `translate(50 ${centreY - 4})`);

  return `<svg class="insignia" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${escapeText(title || abbr || 'Rank')}">
    <defs>
      <linearGradient id="${uid}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${m0}"/><stop offset="1" stop-color="${m1}"/></linearGradient>
      <linearGradient id="${uid}p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16263a"/><stop offset="1" stop-color="#070d16"/></linearGradient>
    </defs>
    ${plateSvg}${back}${content}${tagSvg}
  </svg>`;
}

export function rankBadge(rank, size = 40) {
  if (!rank) return insigniaSVG({}, { size, abbr: '?' });
  return insigniaSVG(rank.insignia, { size, color: rank.color, abbr: rank.abbr, title: `${rank.name} (${rank.abbr})` });
}

// ---------- WPG server ranks (Recruit I → Wardog X) ----------
// 20 tiers of 10 (I–X). The tier sets the insignia and colour; the numeral tab shows the step within it.
// Enlisted in bronze, NCOs in silver, officers in gold, generals in red, Field Commander and Wardog in WPG blue.
export const WPG_TIERS = [
  { name: 'Recruit', abbr: 'RCT', color: '#8a8f7a', insignia: {} },
  { name: 'Private', color: '#cd7f32', insignia: { chevrons: 1 } },
  { name: 'Private First Class', color: '#cd7f32', insignia: { chevrons: 1, rockers: 1 } },
  { name: 'Lance Corporal', color: '#cd7f32', insignia: { chevrons: 2 } },
  { name: 'Corporal', color: '#cd7f32', insignia: { chevrons: 2, rockers: 1 } },
  { name: 'Sergeant', color: '#c0c8d0', insignia: { chevrons: 3, metal: 'silver' } },
  { name: 'Staff Sergeant', color: '#c0c8d0', insignia: { chevrons: 3, rockers: 1, metal: 'silver' } },
  { name: 'Sergeant Major', color: '#c0c8d0', insignia: { chevrons: 3, rockers: 2, metal: 'silver' } },
  { name: 'Warrant Officer', color: '#c0c8d0', insignia: { crown: true, metal: 'silver' } },
  { name: 'Second Lieutenant', color: '#c9a227', insignia: { pips: 1 } },
  { name: 'Lieutenant', color: '#c9a227', insignia: { pips: 2 } },
  { name: 'Captain', color: '#c9a227', insignia: { pips: 3 } },
  { name: 'Major', color: '#c9a227', insignia: { oak: true } },
  { name: 'Lieutenant Colonel', color: '#c9a227', insignia: { oak: true, metal: 'silver' } },
  { name: 'Colonel', color: '#c9a227', insignia: { crown: true, pips: 2 } },
  { name: 'Brigadier', color: '#c9a227', insignia: { crown: true, pips: 3 } },
  { name: 'General', color: '#e5484d', insignia: { swords: true, stars: 3 } },
  { name: 'Field Marshal', color: '#e5484d', insignia: { swords: true, crown: true, wreath: true } },
  { name: 'Field Commander', color: '#29b6f6', insignia: { stars: 5 } },
  { name: 'Wardog', color: '#7fdcff', insignia: { crown: true, stars: 3, wreath: true } },
];
const WPG_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

// Which tier and step a WPG rank is: from its level (1 = Recruit I), or from its name if there's no level.
export function wpgTierOf(level, name = '') {
  let lv = Math.round(Number(level) || 0);
  if (lv < 1 && name) {
    const m = /^(.*?)\s+([IVX]+)$/i.exec(String(name).trim());
    const t = m ? WPG_TIERS.findIndex((x) => x.name.toLowerCase() === m[1].toLowerCase()) : -1;
    const n = m ? WPG_NUMERALS.indexOf(m[2].toUpperCase()) : -1;
    if (t >= 0 && n >= 0) lv = t * 10 + n + 1;
  }
  lv = Math.max(1, lv || 1);
  return { tier: WPG_TIERS[Math.min(WPG_TIERS.length - 1, Math.floor((lv - 1) / 10))], numeral: WPG_NUMERALS[(lv - 1) % 10] };
}

export function wpgBadge(level, size = 40, name = '') {
  const { tier, numeral } = wpgTierOf(level, name);
  return insigniaSVG(tier.insignia, { size, color: tier.color, abbr: tier.abbr || '', tag: numeral, title: name || `${tier.name} ${numeral}` });
}
