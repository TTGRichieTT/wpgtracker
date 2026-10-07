// Profile frames, drawn as SVG around a member's picture (used by the app and the Discord cards).
// A frame is { style, color?, badge?, label?, crown?, season?, season_tag?, image?, rank?, title? }:
//  title: words on a plate across the top (the Officer frame shows the member's clan rank title there);
//  season: the season number it's from (shown as S1, S2… unless season_tag is false);
//  image: an uploaded frame picture (style 'image', 512 x 512 with a transparent middle);
//  badge 'rank': the member's clan rank badge in the corner (rank: their rank's name, abbr, colour, insignia). The picture sits in the middle 74% of the square (13–87 of 0–100);
// the frame is drawn around it, with a small badge in the corner that says what kind of frame it is.

import { rankBadge } from './insignia.js';

// Words on a plate across the top of the frame (e.g. the member's clan rank title on the Officer frame).
function titlePlate(text, color) {
  const t = String(text || '').trim().toUpperCase();
  if (!t) return '';
  const fs = t.length > 16 ? 6 : t.length > 11 ? 7 : 8.4;
  const w = Math.min(92, t.length * fs * 0.66 + 10);
  return `<g><rect x="${(50 - w / 2).toFixed(1)}" y="1" width="${w.toFixed(1)}" height="12.5" rx="3" fill="#0b1520" stroke="${color}" stroke-width="1.5"/><text x="50" y="${(7.6 + fs * 0.34).toFixed(1)}" text-anchor="middle" font-family="Rajdhani, Arial Narrow, sans-serif" font-weight="700" font-size="${fs}" fill="#fff" letter-spacing=".5">${esc(t)}</text></g>`;
}

let uid = 0;
const METALS = {
  bronze: ['#f6c896', '#b06a2c', '#5b3212'],
  silver: ['#ffffff', '#a9b3bd', '#4a535c'],
  gold: ['#fff1a8', '#d4a22c', '#6b4a07'],
  steel: ['#d6ecff', '#5d7a94', '#1d2b38'],
};
const CAMO = {
  woodland: ['#4b5a2a', ['#2e3a1a', '#7a6a3a', '#1e2412', '#5f7034']],
  desert: ['#c8a96b', ['#9c7c45', '#e3cf9c', '#6e5530', '#b39258']],
};
const okColor = (c, d) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : d);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The ring around the picture (outer rounded square minus the inner one).
const RING = 'M4 18Q4 4 18 4H82Q96 4 96 18V82Q96 96 82 96H18Q4 96 4 82Z M15 21Q15 13 23 13H77Q85 13 85 21V79Q85 87 77 87H23Q15 87 15 79Z';

// Small glyphs for the corner badge (drawn in a 0–20 box, white).
const GLYPHS = {
  star: '<polygon points="10,2.5 12.2,7.6 17.6,8 13.4,11.5 14.8,16.8 10,13.9 5.2,16.8 6.6,11.5 2.4,8 7.8,7.6" fill="#fff"/>',
  crosshair: '<circle cx="10" cy="10" r="5.5" fill="none" stroke="#fff" stroke-width="2"/><path d="M10 1.5v5M10 13.5v5M1.5 10h5M13.5 10h5" stroke="#fff" stroke-width="2"/>',
  target: '<circle cx="10" cy="10" r="7" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="10" cy="10" r="3" fill="#fff"/>',
  gear: '<circle cx="10" cy="10" r="3.2" fill="none" stroke="#fff" stroke-width="2"/><path d="M10 2v3M10 15v3M2 10h3M15 10h3M4.3 4.3l2.1 2.1M13.6 13.6l2.1 2.1M4.3 15.7l2.1-2.1M13.6 6.4l2.1-2.1" stroke="#fff" stroke-width="2"/>',
  clover: '<circle cx="7" cy="7" r="3.3" fill="#fff"/><circle cx="13" cy="7" r="3.3" fill="#fff"/><circle cx="7" cy="13" r="3.3" fill="#fff"/><circle cx="13" cy="13" r="3.3" fill="#fff"/>',
  clock: '<circle cx="10" cy="10" r="7" fill="none" stroke="#fff" stroke-width="2"/><path d="M10 5.5V10l3 2" stroke="#fff" stroke-width="2" fill="none"/>',
  crown: '<path d="M3 15L4 6l4 4 2-6 2 6 4-4 1 9z" fill="#fff"/>',
  dollar: '<path d="M13.5 6.5C12.8 5.3 11.6 4.8 10 4.8 8 4.8 6.6 5.8 6.6 7.4c0 3.6 7 1.8 7 5.4 0 1.6-1.5 2.6-3.6 2.6-1.8 0-3.1-.6-3.8-1.9M10 2.5v15" stroke="#fff" stroke-width="2" fill="none"/>',
  chevrons: '<path d="M4 12l6-4 6 4M4 16l6-4 6 4" stroke="#fff" stroke-width="2.2" fill="none"/>',
  flag: '<path d="M5 18V3M5 4h10l-2.5 3.5L15 11H5" stroke="#fff" stroke-width="2" fill="none"/>',
  shield: '<path d="M10 2.5l6.5 2.5v5c0 4-3 6.5-6.5 8-3.5-1.5-6.5-4-6.5-8V5z" fill="#fff"/>',
  medal: '<circle cx="10" cy="12" r="5" fill="#fff"/><path d="M6.5 2.5l3.5 5 3.5-5" stroke="#fff" stroke-width="2" fill="none"/>',
  fist: '<path d="M5 9h10v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" fill="#fff"/><path d="M5 9V5.5M8.3 9V4.5M11.6 9V4.5M15 9V5.5" stroke="#fff" stroke-width="2.4"/>',
};

function metalGrad(id, m) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m[0]}"/><stop offset=".5" stop-color="${m[1]}"/><stop offset="1" stop-color="${m[2]}"/></linearGradient>`;
}
function badge(name, color, rank) {
  // The member's clan rank badge, a little bigger than the glyphs (falls back to the shield without a rank).
  if (name === 'rank') {
    if (!rank) return badge('shield', color);
    return rankBadge(rank, 28).replace(/^<svg class="insignia" /, '<svg x="72" y="70" ');
  }
  if (!name || !GLYPHS[name]) return '';
  return `<g transform="translate(77 77)"><circle cx="10" cy="10" r="10.5" fill="#0b1520" stroke="${color}" stroke-width="2"/><g transform="translate(2.5 2.5) scale(.75)">${GLYPHS[name]}</g></g>`;
}
// Season frames carry their season in the other bottom corner (S1, S2…), so each season's set looks its own.
function seasonTag(n, color) {
  if (!Number(n)) return '';
  return `<g transform="translate(3 77)"><circle cx="10" cy="10" r="10.5" fill="#0b1520" stroke="${color}" stroke-width="2"/><text x="10" y="13.5" text-anchor="middle" font-family="Rajdhani, Arial Narrow, Arial, sans-serif" font-weight="700" font-size="${Number(n) > 9 ? 8.5 : 10}" fill="#fff">S${Number(n)}</text></g>`;
}
// Laurel leaves up both sides (for season placings).
function laurel(fill, dark) {
  let out = '';
  for (let i = 0; i < 8; i++) {
    const a = (205 - i * 19) * (Math.PI / 180);
    for (const side of [-1, 1]) {
      const x = 50 + side * Math.cos(a) * 47;
      const y = 54 - Math.sin(a) * 45;
      const rot = side * (i * 19 - 25);
      out += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="3.4" ry="7" transform="rotate(${rot.toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})" fill="${fill}" stroke="${dark}" stroke-width=".6"/>`;
    }
  }
  return out;
}

// The frame as an SVG overlay (transparent in the middle, where the picture shows through).
// overlayOnly: just the corner badge and season tag (the Discord cards draw an uploaded picture themselves).
export function frameSVG(frame, size = 100, { overlayOnly = false } = {}) {
  const f = frame || {};
  const id = `fr${++uid}`;
  const color = okColor(f.color, '#29b6f6');
  let defs = '';
  let body = '';
  let badgeColor = color;
  const style = String(f.style || 'metal-gold');
  if (style === 'image') {
    body = f.image && !overlayOnly ? `<image href="${esc(f.image)}" x="0" y="0" width="100" height="100" preserveAspectRatio="none"/>` : '';
  } else if (style.startsWith('metal-')) {
    const m = METALS[style.slice(6)] || METALS.gold;
    defs += metalGrad(`${id}m`, m);
    body = `<path d="${RING}" fill="url(#${id}m)" fill-rule="evenodd" stroke="${m[2]}" stroke-width="1"/>`;
    badgeColor = m[1];
  } else if (style.startsWith('camo-')) {
    const [base, spots] = CAMO[style.slice(5)] || CAMO.woodland;
    defs += `<clipPath id="${id}c"><path d="${RING}" clip-rule="evenodd"/></clipPath>`;
    let blots = '';
    const pts = [[8, 10, 9], [30, 6, 7], [55, 9, 10], [80, 7, 8], [93, 30, 8], [91, 58, 10], [94, 85, 9], [70, 93, 8], [45, 95, 10], [18, 92, 8], [6, 70, 9], [7, 42, 8], [20, 20, 5], [80, 20, 5], [80, 80, 6], [20, 80, 6]];
    pts.forEach(([x, y, r], i) => { blots += `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${(r * 0.7).toFixed(1)}" transform="rotate(${(i * 37) % 180} ${x} ${y})" fill="${spots[i % spots.length]}"/>`; });
    body = `<path d="${RING}" fill="${base}" fill-rule="evenodd"/><g clip-path="url(#${id}c)">${blots}</g><path d="${RING}" fill="none" stroke="#11160c" stroke-width="1"/>`;
    badgeColor = spots[1];
  } else if (style === 'hazard') {
    defs += `<pattern id="${id}h" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="10" fill="#f5c400"/><rect width="5" height="10" fill="#151515"/></pattern>`;
    body = `<path d="${RING}" fill="url(#${id}h)" fill-rule="evenodd" stroke="#151515" stroke-width="1.2"/>`;
    badgeColor = '#f5c400';
  } else if (style === 'rangefinder') {
    body = `<path d="${RING}" fill="#121a12" fill-rule="evenodd"/>
      <rect x="7.5" y="7.5" width="85" height="85" rx="11" fill="none" stroke="#b6d84a" stroke-width="2.4" stroke-dasharray="3 3"/>
      <path d="M6 22V6h16M78 6h16v16M94 78v16H78M22 94H6V78" fill="none" stroke="#e7ff7a" stroke-width="3"/>`;
    badgeColor = '#b6d84a';
  } else if (style.startsWith('laurel-')) {
    const m = METALS[style.slice(7)] || METALS.gold;
    defs += metalGrad(`${id}m`, m);
    body = `<path d="M10 20Q10 10 20 10H80Q90 10 90 20V80Q90 90 80 90H20Q10 90 10 80Z M15 21Q15 13 23 13H77Q85 13 85 21V79Q85 87 77 87H23Q15 87 15 79Z" fill="url(#${id}m)" fill-rule="evenodd"/>
      ${laurel(`url(#${id}m)`, m[2])}
      ${f.crown ? `<path d="M36 13L38 1l7 6 5-7 5 7 7-6 2 12z" fill="url(#${id}m)" stroke="${m[2]}" stroke-width=".8"/>` : ''}
      ${f.label ? `<g><rect x="34" y="86" width="32" height="13" rx="6.5" fill="#0b1520" stroke="${m[1]}" stroke-width="1.6"/><text x="50" y="95.6" text-anchor="middle" font-family="Rajdhani, Arial Narrow, sans-serif" font-weight="700" font-size="10" fill="${m[0]}">${esc(f.label)}</text></g>` : ''}`;
    badgeColor = m[1];
  } else if (style === 'glow') {
    defs += `<filter id="${id}g" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter>`;
    body = `<rect x="7" y="7" width="86" height="86" rx="13" fill="none" stroke="${color}" stroke-width="6" filter="url(#${id}g)" opacity=".9"/>
      <path d="${RING}" fill="#0b1520" fill-rule="evenodd" opacity=".85"/>
      <rect x="6" y="6" width="88" height="88" rx="13" fill="none" stroke="${color}" stroke-width="2.4"/>
      <rect x="13.5" y="11.5" width="73" height="77" rx="8" fill="none" stroke="${color}" stroke-width="1.4" opacity=".8"/>`;
  } else if (style === 'unit') {
    body = `<path d="${RING}" fill="${color}" fill-rule="evenodd" stroke="#0b1520" stroke-width="1"/>
      <path d="M4 30L16 18M4 42L16 30M96 30L84 18M96 42L84 30" stroke="#0b1520" stroke-width="3" opacity=".55"/>`;
  } else if (style === 'clan') {
    body = `<path d="${RING}" fill="${color}" fill-rule="evenodd" stroke="#0b1520" stroke-width="1"/>
      <path d="M8 8H92V12H8Z" fill="#fff" opacity=".35"/>
      <g><rect x="31" y="85" width="38" height="13" rx="3" fill="#0b1520" stroke="${color}" stroke-width="1.6"/><text x="50" y="94.8" text-anchor="middle" font-family="Rajdhani, Arial Narrow, sans-serif" font-weight="700" font-size="9.5" fill="#fff" letter-spacing="1">${esc(f.label || 'WPG')}</text></g>`;
  } else {
    body = `<path d="${RING}" fill="${color}" fill-rule="evenodd"/>`;
  }
  return `<svg class="frame-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true"><defs>${defs}</defs>${overlayOnly ? '' : body}${titlePlate(f.title, f.rank?.color || badgeColor)}${badge(f.badge, badgeColor, f.rank)}${f.season_tag === false ? '' : seasonTag(f.season, badgeColor)}</svg>`;
}

// The look presets admins can pick (key → label).
export const FRAME_STYLES = {
  'metal-bronze': 'Bronze', 'metal-silver': 'Silver', 'metal-gold': 'Gold', 'metal-steel': 'Steel',
  'camo-woodland': 'Woodland camo', 'camo-desert': 'Desert camo', hazard: 'Hazard stripes', rangefinder: 'Rangefinder',
  'laurel-bronze': 'Bronze laurel', 'laurel-silver': 'Silver laurel', 'laurel-gold': 'Gold laurel',
  glow: 'Glow (pick a colour)', unit: 'Solid colour (pick a colour)', clan: 'Clan colours (pick a colour)',
  image: 'Uploaded picture',
};
export const FRAME_BADGES = Object.keys(GLYPHS); // plus 'rank': the member's clan rank badge

// A new season's frames are last season's challenges in new looks: each style moves on along this list
// (glow / solid colours change colour), so no two seasons' sets look the same. Admins can change any of them.
const ROTATE = ['metal-silver', 'rangefinder', 'metal-steel', 'glow', 'camo-woodland', 'metal-gold', 'camo-desert', 'hazard', 'metal-bronze', 'unit'];
const PALETTE = ['#e53935', '#f5a524', '#2ecc71', '#29b6f6', '#b84dff', '#ff6ec7', '#c9a227', '#00e5c0'];
export function nextSeasonLook(f, seasonNumber) {
  if (f.style === 'image') return { style: 'image', color: '' }; // same picture until an admin uploads the new season's
  const at = ROTATE.indexOf(f.style);
  const style = ROTATE[((at < 0 ? 0 : at) + 3) % ROTATE.length];
  const ci = PALETTE.indexOf(String(f.color || '').toLowerCase());
  const color = ['glow', 'unit'].includes(style) ? PALETTE[((ci < 0 ? Number(seasonNumber) || 0 : ci) + 3) % PALETTE.length] : '';
  return { style, color };
}
