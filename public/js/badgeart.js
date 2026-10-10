// Badge artwork: the owner's uploaded picture with a glow in the badge's rarity colour, or (until a picture is
// uploaded) a default emblem in the rarity's colours with the badge's number on it. Used by the app and by the
// Discord picture cards (server/cards.js draws the same SVG).
export const RARITY = {
  common: { label: 'Common', color: '#b8c4d0', dark: '#3b4652' },
  uncommon: { label: 'Uncommon', color: '#3ddc84', dark: '#0f4a2c' },
  rare: { label: 'Rare', color: '#29b6f6', dark: '#0b3a57' },
  epic: { label: 'Epic', color: '#b05cff', dark: '#3a1660' },
  legendary: { label: 'Legendary', color: '#f5a524', dark: '#5a3404' },
  mythic: { label: 'Mythic', color: '#ff4d6d', dark: '#5c0a1d' },
  exclusive: { label: 'Exclusive', color: '#ffe066', dark: '#4d3d00' },
};
const GLYPH = {
  streaming: 'M-9 -12 L13 0 L-9 12 Z',
  nitro: 'M0 -14 L12 -3 L0 14 L-12 -3 Z M-12 -3 L12 -3',
  loyalty: 'M0 -14 L4 -4 L14 -4 L6 2 L9 13 L0 6 L-9 13 L-6 2 L-14 -4 L-4 -4 Z',
  chat: 'M-13 -10 H13 V6 H-2 L-9 13 V6 H-13 Z',
  voice: 'M-5 -13 H5 V3 A5 5 0 0 1 -5 3 Z M-10 0 A10 10 0 0 0 10 0 M0 10 V15',
  recruitment: 'M-4 -8 A6 6 0 1 1 -4 -7.9 Z M-14 12 A10 9 0 0 1 6 12 Z M10 -6 V6 M4 0 H16',
  events: 'M-10 -13 H10 V-4 A10 10 0 0 1 -10 -4 Z M-3 6 H3 V11 H8 V15 H-8 V11 H-3 Z',
  special: 'M-13 9 L-13 -9 L-6 -1 L0 -13 L6 -1 L13 -9 L13 9 Z',
  wardogs: 'M0 -14 L13 -6 V5 L0 14 L-13 5 V-6 Z',
  other: 'M0 -14 L4 -4 L14 -4 L6 2 L9 13 L0 6 L-9 13 L-6 2 L-14 -4 L-4 -4 Z',
};
Object.assign(GLYPH, { combat: GLYPH.wardogs, community: GLYPH.chat, achievements: GLYPH.loyalty, vip: GLYPH.special, extra: GLYPH.other });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let uid = 0;

// The default emblem: a shield with a metal rim in the rarity colour, the category mark at the top and the
// badge's number (e.g. "1Y", "100", "24H") big in the middle.
export function badgeSVG(b, { locked = false } = {}) {
  const r = RARITY[b.rarity] || RARITY.common;
  const id = `bg${++uid}`;
  const text = String(b.short || 'WPG').slice(0, 4);
  const size = text.length >= 4 ? 30 : text.length === 3 ? 36 : 44;
  return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(b.name)}"${locked ? ' style="filter:grayscale(1);opacity:.45"' : ''}>
  <defs>
    <linearGradient id="${id}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".9"/><stop offset=".45" stop-color="${r.color}"/><stop offset="1" stop-color="${r.dark}"/></linearGradient>
    <radialGradient id="${id}f" cx=".5" cy=".35" r=".75"><stop offset="0" stop-color="${r.color}" stop-opacity=".55"/><stop offset=".6" stop-color="${r.dark}"/><stop offset="1" stop-color="#05101c"/></radialGradient>
  </defs>
  <path d="M60 4 L108 22 V62 C108 88 86 106 60 116 C34 106 12 88 12 62 V22 Z" fill="url(#${id}m)"/>
  <path d="M60 12 L100 27 V62 C100 84 82 99 60 108 C38 99 20 84 20 62 V27 Z" fill="url(#${id}f)" stroke="#000" stroke-opacity=".35"/>
  <g transform="translate(60 33) scale(.62)" fill="${r.color}" stroke="#fff" stroke-opacity=".85" stroke-width="2" stroke-linejoin="round">
    <path d="${GLYPH[b.category] || GLYPH.other}"/>
  </g>
  <text x="60" y="${78 + size * 0.06}" text-anchor="middle" font-family="Oswald, 'Arial Narrow', Arial, sans-serif" font-weight="700" font-size="${size}" fill="#fff" stroke="#000" stroke-opacity=".55" stroke-width="1.2">${esc(text)}</text>
  <path d="M30 96 H90" stroke="${r.color}" stroke-width="3" stroke-linecap="round" opacity=".8"/>
</svg>`;
}

// A badge as HTML: their artwork (with the rarity glow) or the default emblem. size in px.
export function badgeHTML(b, size = 64, { locked = false } = {}) {
  const r = RARITY[b.rarity] || RARITY.common;
  const glow = locked ? 'grayscale(1) opacity(.4)' : `drop-shadow(0 0 ${Math.max(3, size / 14)}px ${r.color})`;
  const inner = b.image
    ? `<img src="${esc(b.image)}" alt="${esc(b.name)}" loading="lazy" style="width:100%;height:100%;object-fit:contain;filter:${glow}">`
    : `<span style="display:block;width:100%;height:100%;filter:${locked ? 'none' : `drop-shadow(0 0 ${Math.max(2, size / 18)}px ${r.color})`}">${badgeSVG(b, { locked })}</span>`;
  return `<span class="badge-art" style="display:inline-block;width:${size}px;height:${size}px;vertical-align:middle">${inner}</span>`;
}

// 3D tilt: a badge leans towards the mouse (or finger) over it and eases back when it leaves. One listener for the
// whole page, so every badge everywhere gets it. Tiny badges (next to names) and "reduce motion" are left still.
const MAX_ROTATE_X = 20;
const MAX_ROTATE_Y = 18;
if (typeof document !== 'undefined' && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
  let current = null;
  const settle = (el) => {
    el.style.transition = 'transform 400ms ease-out';
    el.style.transform = 'perspective(600px) rotateX(0deg) rotateY(0deg)';
  };
  const tilt = (el, e) => {
    const r = el.getBoundingClientRect();
    const halfW = r.width / 2;
    const halfH = r.height / 2;
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
    const rotY = ((halfW - x) * MAX_ROTATE_Y) / halfW;
    const rotX = ((halfH - y) * -MAX_ROTATE_X) / halfH;
    el.style.transform = `perspective(600px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
  };
  const target = (e) => {
    const el = e.target.closest?.('.badge-art');
    return el && el.offsetWidth >= 40 ? el : null;
  };
  document.addEventListener('pointerover', (e) => {
    const el = target(e);
    if (!el || el === current) return;
    if (current) settle(current);
    current = el;
    el.style.transition = 'transform 50ms linear';
    el.style.willChange = 'transform';
  });
  document.addEventListener('pointermove', (e) => {
    if (current && current.contains(e.target)) tilt(current, e);
  }, { passive: true });
  const leave = (e) => {
    if (!current) return;
    if (e.type === 'pointerout' && current.contains(e.relatedTarget)) return; // still over the same badge
    settle(current);
    current = null;
  };
  document.addEventListener('pointerout', leave);
  document.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') leave(e); });
  document.addEventListener('pointercancel', leave);
}
