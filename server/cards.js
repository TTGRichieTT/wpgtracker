// Picture cards for the Discord bot's other commands (/rank, /server, /medals, /progress,
// /leaderboard, /live), in the same style as the career card: the WPG design's header (with a new
// title on a plate) and footer art around panels drawn here.
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  prepare, icon, fitText, roundRect, panel, title, ribbon, medalIcon, trophyIcon,
  W, FOOT_SRC, FOOT, MID_X, BAND_BG, BOX_FILL, WHITE, CYAN, GREEN, AMBER, VALUE_FONT, LABEL_FONT,
} from './careercard.js';
import { rankBadge } from '../public/js/insignia.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HEAD_H = 246; // the design's header art (logo, WARDOGS, soldier, slogans)
const MUTED = '#9fb3c6';
const LABEL = '#8fc4e8';
const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
const money = (n) => `$${fmt(Math.round(Number(n) || 0))}`;
// "SERGEANT VII" -> "Sergeant VII" style is for chat; the cards use capitals like the design.
const upper = (s) => String(s || '').toUpperCase();
function playtime(secs) {
  const m = Math.floor((Number(secs) || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
function ago(date) {
  if (!date) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hours ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

// The new title, on a dark plate where the design says "PLAYER CAREER PROFILE" (between its cyan arrows).
function titlePlate(g, text) {
  const x = 528;
  const y = 136;
  const w = 450;
  const h = 54;
  const c = 10;
  g.beginPath();
  g.moveTo(x + c, y); g.lineTo(x + w - c, y); g.lineTo(x + w, y + c); g.lineTo(x + w, y + h - c);
  g.lineTo(x + w - c, y + h); g.lineTo(x + c, y + h); g.lineTo(x, y + h - c); g.lineTo(x, y + c);
  g.closePath();
  const bg = g.createLinearGradient(0, y, 0, y + h);
  bg.addColorStop(0, '#0d1c2e');
  bg.addColorStop(1, '#050c16');
  g.fillStyle = bg;
  g.fill();
  g.save();
  g.shadowColor = 'rgba(41,182,246,0.8)';
  g.shadowBlur = 10;
  g.strokeStyle = 'rgba(56,170,235,0.9)';
  g.lineWidth = 1.6;
  g.stroke();
  g.restore();
  let size = 50;
  g.font = `700 ${size}px ${LABEL_FONT}`;
  while (size > 26 && g.measureText(text).width > w - 30) { size -= 2; g.font = `700 ${size}px ${LABEL_FONT}`; }
  const metal = g.createLinearGradient(0, y + 8, 0, y + h - 8);
  metal.addColorStop(0, '#ffffff');
  metal.addColorStop(0.55, '#dfe7ef');
  metal.addColorStop(1, '#9fb0c2');
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.8)';
  g.shadowBlur = 6;
  g.shadowOffsetY = 2;
  g.fillStyle = metal;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x + w / 2, y + h / 2 + 3);
  g.restore();
}

// Header art, title plate, dark content area, footer art. draw(g, top) fills the content area.
async function frame(heading, contentH, draw) {
  const art = await prepare();
  const footY = HEAD_H + contentH;
  const canvas = createCanvas(W, footY + FOOT);
  const g = canvas.getContext('2d');
  g.drawImage(art, 0, 0, W, HEAD_H, 0, 0, W, HEAD_H);
  // Fade out the tops of the design's panels at the bottom of the header, then write back the
  // slogan's last word ("LASTS"), which sits in that strip.
  const fade = g.createLinearGradient(0, 219, 0, 232);
  fade.addColorStop(0, 'rgba(4,11,20,0)');
  fade.addColorStop(1, BAND_BG);
  g.fillStyle = fade;
  g.fillRect(0, 219, W, 13);
  g.fillStyle = BAND_BG;
  g.fillRect(0, 232, W, HEAD_H - 232);
  g.font = `700 16px ${LABEL_FONT}`;
  g.fillStyle = '#dfe6ec';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  let lx = 1406;
  for (const ch of 'LASTS') { g.fillText(ch, lx, 235); lx += g.measureText(ch).width + 1.6; }
  titlePlate(g, heading);
  g.fillStyle = BAND_BG;
  g.fillRect(0, HEAD_H, W, contentH);
  // Footer art; its first rows still show the bottom of the design's panels, so hide those.
  g.drawImage(art, 0, FOOT_SRC, W, FOOT, 0, footY, W, FOOT);
  const coverH = 28;
  g.fillStyle = BAND_BG;
  g.fillRect(0, footY, MID_X - 14, coverH);
  const side = g.createLinearGradient(MID_X - 14, 0, MID_X + 26, 0);
  side.addColorStop(0, BAND_BG);
  side.addColorStop(1, 'rgba(4,11,20,0)');
  g.fillStyle = side;
  g.fillRect(MID_X - 14, footY, 40, coverH);
  const down = g.createLinearGradient(0, footY + coverH, 0, footY + coverH + 16);
  down.addColorStop(0, BAND_BG);
  down.addColorStop(1, 'rgba(4,11,20,0)');
  g.fillStyle = down;
  g.fillRect(0, footY + coverH, MID_X, 16);
  const seam = g.createLinearGradient(0, footY, 0, footY + 14);
  seam.addColorStop(0, BAND_BG);
  seam.addColorStop(1, 'rgba(4,11,20,0)');
  g.fillStyle = seam;
  g.fillRect(MID_X, footY, W - MID_X, 14);
  await draw(g, HEAD_H + 6);
  return canvas.encode('jpeg', 90);
}

// The member's name (and Steam picture) across the top of the content.
async function playerStrip(g, top, name, avatarUrl) {
  const img = await icon(avatarUrl);
  g.font = `800 38px ${VALUE_FONT}`;
  let size = 38;
  while (size > 20 && g.measureText(name).width > 1100) { size -= 2; g.font = `800 ${size}px ${VALUE_FONT}`; }
  const tw = g.measureText(name).width;
  const total = tw + (img ? 64 : 0);
  let x = W / 2 - total / 2;
  const cy = top + 32;
  if (img) {
    g.save();
    g.beginPath(); g.arc(x + 25, cy, 25, 0, Math.PI * 2); g.clip();
    g.drawImage(img, x, cy - 25, 50, 50);
    g.restore();
    g.strokeStyle = 'rgba(56,170,235,0.9)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(x + 25, cy, 25, 0, Math.PI * 2); g.stroke();
    x += 64;
  }
  g.fillStyle = WHITE;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(name, x, cy + 1);
  const line = g.createLinearGradient(W / 2 - 400, 0, W / 2 + 400, 0);
  line.addColorStop(0, 'rgba(51,209,255,0)');
  line.addColorStop(0.5, 'rgba(51,209,255,0.9)');
  line.addColorStop(1, 'rgba(51,209,255,0)');
  g.fillStyle = line;
  g.fillRect(W / 2 - 400, top + 64, 800, 2);
  return top + 76;
}

function label(g, text, x, y, { align = 'left', size = 22, color = LABEL } = {}) {
  g.font = `700 ${size}px ${LABEL_FONT}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(text, x, y);
}

function bigValue(g, text, x, y, maxW, { size = 40, color = WHITE, align = 'left', font = VALUE_FONT, weight = 800 } = {}) {
  let s = size;
  g.font = `${weight} ${s}px ${font}`;
  while (s > 12 && g.measureText(text).width > maxW) { s -= 2; g.font = `${weight} ${s}px ${font}`; }
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(text, x, y);
}

function bar(g, x, y, w, h, pct, from = '#1e88e5', to = CYAN) {
  g.fillStyle = BOX_FILL;
  roundRect(g, x, y, w, h, h / 2);
  g.fill();
  const p = Math.max(0, Math.min(1, Number(pct) || 0));
  if (p <= 0) return;
  const grad = g.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, from);
  grad.addColorStop(1, to);
  g.fillStyle = grad;
  roundRect(g, x, y, Math.max(h, w * p), h, h / 2);
  g.fill();
}

// A stat tile: label on top, big value below, in a dark box like the design's.
function tile(g, x, y, w, h, name, val, color = WHITE) {
  g.fillStyle = BOX_FILL;
  roundRect(g, x, y, w, h, 8);
  g.fill();
  label(g, upper(name), x + w / 2, y + 26, { align: 'center' });
  bigValue(g, String(val), x + w / 2, y + h - 36, w - 24, { size: 40, color, align: 'center' });
}

function chevrons(g, cx, cy, s = 1) {
  g.save();
  const grad = g.createLinearGradient(0, cy - 26 * s, 0, cy + 26 * s);
  grad.addColorStop(0, '#d6f3ff');
  grad.addColorStop(1, '#6cc6f0');
  g.fillStyle = grad;
  for (const dy of [-12, 10]) {
    g.beginPath();
    g.moveTo(cx - 24 * s, cy + (dy + 8) * s); g.lineTo(cx, cy + (dy - 10) * s); g.lineTo(cx + 24 * s, cy + (dy + 8) * s);
    g.lineTo(cx + 24 * s, cy + (dy + 18) * s); g.lineTo(cx, cy + dy * s); g.lineTo(cx - 24 * s, cy + (dy + 18) * s);
    g.closePath();
    g.fill();
  }
  g.restore();
}

function skull(g, cx, cy) {
  g.save();
  g.fillStyle = '#e8f4ff';
  g.beginPath(); g.arc(cx, cy - 4, 14, Math.PI, 0); g.lineTo(cx + 14, cy + 6); g.lineTo(cx + 8, cy + 10); g.lineTo(cx + 8, cy + 16);
  g.lineTo(cx - 8, cy + 16); g.lineTo(cx - 8, cy + 10); g.lineTo(cx - 14, cy + 6); g.closePath(); g.fill();
  g.fillStyle = '#0a1622';
  g.beginPath(); g.arc(cx - 6, cy + 1, 4, 0, Math.PI * 2); g.arc(cx + 6, cy + 1, 4, 0, Math.PI * 2); g.fill();
  g.restore();
}

// ---------- /rank ----------
// d: { name, avatar, wpg{rank,xp,position,total,from,next{name,xp}}, clan{pmc,rank,xp,next{name,min_xp},from} }
export function renderRankCard(d) {
  return frame('RANK REPORT', 76 + 300 + 20, async (g, top) => {
    const y = await playerStrip(g, top, d.name, d.avatar);
    // WPG server rank (WPG XP earned on the WPG server).
    panel(g, 28, y + 6, 794, 290);
    chevrons(g, 64, y + 42, 0.8);
    title(g, 100, y + 42, 'WPG RANK', '(WPG SERVER)');
    bigValue(g, upper(d.wpg.rank || 'RECRUIT I'), 56, y + 124, 730, { size: 72, color: CYAN, font: LABEL_FONT, weight: 700 });
    label(g, 'WPG XP', 58, y + 186);
    bigValue(g, fmt(d.wpg.xp), 58, y + 222, 300, { size: 36 });
    label(g, 'POSITION', 400, y + 186);
    bigValue(g, d.wpg.position ? `#${fmt(d.wpg.position)}${d.wpg.total ? ` of ${fmt(d.wpg.total)}` : ''}` : '—', 400, y + 222, 390, { size: 36 });
    if (d.wpg.next) {
      // Rank list set up (Admin → WPG XP): progress through the current rank.
      const xp = Number(d.wpg.xp) || 0;
      bar(g, 58, y + 252, 736, 12, (xp - (d.wpg.from || 0)) / Math.max(1, d.wpg.next.xp - (d.wpg.from || 0)));
      label(g, `NEXT: ${upper(d.wpg.next.name)} IN ${fmt(Math.max(0, d.wpg.next.xp - xp))} WPG XP`, 58, y + 278, { size: 17, color: MUTED });
    } else {
      const pct = Math.min(1, (Number(d.wpg.xp) || 0) / 650000);
      bar(g, 58, y + 252, 736, 12, pct);
      label(g, `${(pct * 100).toFixed(pct < 0.01 ? 2 : 1)}% OF THE WAY TO WARDOG X (650,000 WPG XP)`, 58, y + 278, { size: 17, color: MUTED });
    }

    // Clan rank (the app's own ranks).
    panel(g, 834, y + 6, 674, 290);
    medalIcon(g, 872, y + 42);
    title(g, 904, y + 42, 'CLAN RANK', '(BARRACKS)');
    if (d.clan.pmc) {
      bigValue(g, 'PMC — GUEST', 870, y + 140, 600, { size: 54, color: AMBER, font: LABEL_FONT, weight: 700 });
      label(g, `CLAN XP ${fmt(d.clan.xp)}  ·  PMCs don't hold a clan rank`, 870, y + 200, { size: 20, color: MUTED });
      return;
    }
    const r = d.clan.rank;
    if (r) {
      const badge = await loadImage(Buffer.from(rankBadge(r, 170))).catch(() => null);
      if (badge) g.drawImage(badge, 858, y + 80, 170, 170);
    }
    const tx = r ? 1046 : 870;
    bigValue(g, upper(r ? r.name : 'NO RANK'), tx, y + 112, 1480 - tx, { size: 46, font: LABEL_FONT, weight: 700 });
    if (r?.abbr) label(g, upper(r.abbr), tx, y + 150, { size: 24, color: CYAN });
    label(g, 'CLAN XP', tx, y + 186);
    bigValue(g, fmt(d.clan.xp), tx, y + 222, 400, { size: 36 });
    if (d.clan.next) {
      const span = Math.max(1, d.clan.next.min_xp - (d.clan.from || 0));
      bar(g, tx, y + 252, 1480 - tx, 12, ((Number(d.clan.xp) || 0) - (d.clan.from || 0)) / span, '#c9a227', '#ffe08a');
      label(g, `NEXT: ${upper(d.clan.next.name)} AT ${fmt(d.clan.next.min_xp)} CLAN XP`, tx, y + 278, { size: 17, color: MUTED });
    } else {
      label(g, r && !r.auto ? 'APPOINTED RANK' : 'TOP OF THE CLAN XP LADDER', tx, y + 262, { size: 19, color: MUTED });
    }
  });
}

// ---------- /server ----------
// d: { name, avatar, kills, deaths, matches, wins, losses, playtime, lastSeen, killsPos, playtimePos, players, wpgRank, wpgXp }
export function renderServerCard(d) {
  return frame('WPG SERVER STATS', 76 + 380 + 20, async (g, top) => {
    const y = await playerStrip(g, top, d.name, d.avatar);
    panel(g, 28, y + 6, 1480, 370);
    skull(g, 66, y + 42);
    title(g, 100, y + 42, 'WPG SERVER STATS', '(ALL TIME)');
    const tw = (1480 - 56 - 3 * 20) / 4;
    const tiles = [
      ['Kills', fmt(d.kills)], ['Deaths', fmt(d.deaths)], ['K/D ratio', (d.kills / Math.max(1, d.deaths)).toFixed(2)], ['Matches', fmt(d.matches)],
      ['Wins', fmt(d.wins), GREEN], ['Losses', fmt(d.losses)], ['W/L ratio', (d.wins / Math.max(1, d.losses)).toFixed(2)], ['Playtime', playtime(d.playtime)],
    ];
    tiles.forEach(([n, v, c], i) => tile(g, 56 + (i % 4) * (tw + 20), y + 80 + Math.floor(i / 4) * 128, tw, 112, n, v, c));
    const facts = [
      d.killsPos ? `KILLS #${fmt(d.killsPos)} OF ${fmt(d.players)}` : null,
      d.playtimePos ? `PLAYTIME #${fmt(d.playtimePos)}` : null,
      `WPG RANK ${upper(d.wpgRank || 'RECRUIT I')} (${fmt(d.wpgXp)} WPG XP)`,
      `LAST SEEN ${upper(ago(d.lastSeen))}`,
    ].filter(Boolean);
    label(g, facts.join('   ·   '), W / 2, y + 350, { align: 'center', size: 20, color: MUTED });
  });
}

// ---------- /medals ----------
// d: { name, avatar, medals[{name,description,colors}], achievements{game,total,earned[{name,icon,percent}]} }
export function renderMedalsCard(d) {
  const medals = d.medals || [];
  const ach = d.achievements || { earned: [], total: 0 };
  const mRows = Math.min(8, Math.ceil(Math.max(1, medals.length) / 2));
  const aRows = Math.min(9, Math.max(1, ach.earned.length));
  const leftH = 84 + mRows * 66 + 24;
  const rightH = 110 + aRows * 54 + 20;
  const bodyH = Math.max(300, leftH, rightH);
  return frame('MEDAL RACK', 76 + bodyH + 20, async (g, top) => {
    const y = await playerStrip(g, top, d.name, d.avatar);
    // Medals, two columns.
    panel(g, 28, y + 6, 794, bodyH);
    medalIcon(g, 66, y + 42);
    title(g, 100, y + 42, 'MEDALS', '(TOP TIER)');
    label(g, `${medals.length} ${medals.length === 1 ? 'MEDAL' : 'MEDALS'}`, 794, y + 44, { align: 'right', color: MUTED });
    if (!medals.length) {
      g.font = `600 18px ${VALUE_FONT}`;
      g.fillStyle = MUTED;
      g.textAlign = 'left';
      g.fillText('No medals yet — they come with class levels, hours played and from staff.', 58, y + 120);
    }
    const shown = medals.length > 16 ? medals.slice(0, 15) : medals;
    shown.forEach((m, i) => {
      const cx = 56 + (i % 2) * 382;
      const cy = y + 84 + Math.floor(i / 2) * 66;
      ribbon(g, cx, cy + 6, 84, 26, m.colors);
      bigValue(g, upper(m.name), cx + 98, cy + 12, 262, { size: 21, font: LABEL_FONT, weight: 700 });
      g.font = `600 14px ${VALUE_FONT}`;
      g.fillStyle = MUTED;
      g.textAlign = 'left';
      let desc = String(m.description || '');
      while (desc.length > 3 && g.measureText(desc).width > 262) desc = `${desc.slice(0, -2)}…`;
      g.fillText(desc, cx + 98, cy + 38);
    });
    if (medals.length > shown.length) label(g, `+${medals.length - shown.length} MORE IN THE APP`, 56 + 382, y + 84 + 7 * 66 + 18, { color: CYAN });

    // Steam achievements, one per row with icon, name and rarity.
    panel(g, 834, y + 6, 674, bodyH);
    trophyIcon(g, 872, y + 42);
    title(g, 904, y + 42, 'ACHIEVEMENTS', ach.game ? `(${upper(ach.game)})` : '');
    label(g, `${ach.earned.length} / ${ach.total || ach.earned.length}`, 1480, y + 44, { align: 'right', size: 24, color: WHITE });
    bar(g, 862, y + 74, 618, 10, ach.total ? ach.earned.length / ach.total : 0);
    if (!ach.earned.length) {
      g.font = `600 18px ${VALUE_FONT}`;
      g.fillStyle = MUTED;
      g.textAlign = 'left';
      g.fillText(ach.total ? 'None yet (or Steam game details are private).' : 'Show once Steam stats have synced.', 862, y + 130);
      return;
    }
    const list = ach.earned.length > 9 ? ach.earned.slice(0, 8) : ach.earned;
    const imgs = await Promise.all(list.map((a) => icon(a.icon)));
    list.forEach((a, i) => {
      const ry = y + 100 + i * 54;
      g.save();
      roundRect(g, 862, ry, 44, 44, 6);
      g.clip();
      if (imgs[i]) g.drawImage(imgs[i], 862, ry, 44, 44);
      else { g.fillStyle = BOX_FILL; g.fillRect(862, ry, 44, 44); }
      g.restore();
      bigValue(g, a.name, 920, ry + 14, 440, { size: 19, weight: 700 });
      g.font = `600 14px ${VALUE_FONT}`;
      g.fillStyle = MUTED;
      g.textAlign = 'left';
      g.fillText(a.percent !== null && a.percent !== undefined ? `${Number(a.percent).toFixed(1)}% of players have this` : '', 920, ry + 34);
    });
    if (ach.earned.length > list.length) label(g, `+${ach.earned.length - list.length} MORE`, 920, y + 100 + 8 * 54 + 22, { color: CYAN });
  });
}

// ---------- /progress ----------
// d: { name, avatar, rows[{label,color,level,max,next{name,level,image}}], readyCount, readyCost, spent }
export function renderProgressCard(d) {
  const rows = d.rows || [];
  const bodyH = 84 + rows.length * 66 + 70;
  return frame('PROGRESSION', 76 + bodyH + 20, async (g, top) => {
    const y = await playerStrip(g, top, d.name, d.avatar);
    panel(g, 28, y + 6, 1480, bodyH);
    chevrons(g, 64, y + 42, 0.8);
    title(g, 100, y + 42, 'UNLOCK PROGRESS', '(EVERY CLASS)');
    const imgs = await Promise.all(rows.map((r) => (r.next?.image
      ? loadImage(path.join(PUBLIC, String(r.next.image).replace(/^\/+/, ''))).catch(() => null)
      : null)));
    rows.forEach((r, i) => {
      const ry = y + 84 + i * 66;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)';
      roundRect(g, 48, ry, 1440, 58, 8);
      g.fill();
      g.fillStyle = r.color;
      roundRect(g, 48, ry, 6, 58, 3);
      g.fill();
      label(g, upper(r.label), 72, ry + 30, { size: 28, color: r.color });
      bigValue(g, `LVL ${fmt(r.level)}`, 300, ry + 30, 150, { size: 26 });
      bar(g, 460, ry + 24, 470, 12, r.max ? r.level / r.max : 0, r.color, '#ffffff');
      label(g, r.max ? `${fmt(r.level)} / ${fmt(r.max)}` : '', 940, ry + 30, { size: 18, color: MUTED });
      const nx = 1040;
      if (imgs[i]) {
        const ih = 42;
        const iw = Math.min(90, (imgs[i].width / imgs[i].height) * ih);
        g.drawImage(imgs[i], nx, ry + 8, iw, ih);
      }
      const textX = imgs[i] ? nx + 100 : nx;
      if (r.next) {
        label(g, `NEXT AT ${fmt(r.next.level)}`, textX, ry + 18, { size: 16, color: MUTED });
        bigValue(g, r.next.name, textX, ry + 40, 1470 - textX, { size: 19, weight: 700 });
      } else {
        label(g, 'ALL UNLOCKED', textX, ry + 30, { size: 22, color: GREEN });
      }
    });
    const sy = y + 84 + rows.length * 66 + 34;
    label(g, `REACHED BUT NOT BOUGHT: ${d.readyCount ? `${fmt(d.readyCount)} ITEMS · ${money(d.readyCost)}` : 'NOTHING WAITING'}`, 72, sy, { size: 22, color: d.readyCount ? AMBER : GREEN });
    label(g, `TICKED AS BOUGHT: ${money(d.spent)}`, 1470, sy, { align: 'right', size: 22, color: MUTED });
  });
}

// ---------- /leaderboard ----------
// d: { title, accent, rows[{name,value,extra}] }
export function renderLeaderboardCard(d) {
  const rows = d.rows || [];
  const bodyH = 84 + Math.max(1, rows.length) * 58 + 24;
  return frame('LEADERBOARD', bodyH + 20, async (g, top) => {
    const y = top + 4;
    panel(g, 28, y, 1480, bodyH);
    trophyIcon(g, 66, y + 38);
    title(g, 100, y + 38, upper(d.title), d.accent ? `(${upper(d.accent)})` : '');
    if (!rows.length) {
      label(g, 'NO DATA YET', 72, y + 110, { size: 24, color: MUTED });
      return;
    }
    const podium = ['#ffd54f', '#cfd8dc', '#d7955b'];
    rows.forEach((r, i) => {
      const ry = y + 78 + i * 58;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.055)';
      roundRect(g, 48, ry, 1440, 50, 8);
      g.fill();
      if (i < 3) {
        g.fillStyle = podium[i];
        g.beginPath(); g.arc(92, ry + 25, 19, 0, Math.PI * 2); g.fill();
        bigValue(g, String(i + 1), 92, ry + 26, 30, { size: 22, color: '#0a1622', align: 'center' });
      } else {
        bigValue(g, String(i + 1), 92, ry + 26, 40, { size: 22, color: MUTED, align: 'center' });
      }
      bigValue(g, String(r.name || 'Unknown').trim() || 'Unknown', 136, ry + 26, 760, { size: 24, weight: 700 });
      if (r.extra) label(g, upper(r.extra), 1060, ry + 26, { align: 'right', size: 22, color: CYAN });
      bigValue(g, r.value, 1470, ry + 26, 380, { size: 26, align: 'right', color: i < 3 ? podium[i] : WHITE });
    });
  });
}

// ---------- /serverboard (the WPG server leaderboard, in the style of the WPG design) ----------
// Small line icons for the column headings.
function colIcon(g, kind, cx, cy) {
  g.save();
  g.strokeStyle = '#e6f3ff';
  g.fillStyle = '#e6f3ff';
  g.lineWidth = 2.4;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const s = 12;
  switch (kind) {
    case 'medal': medalIcon(g, cx, cy - 2); break;
    case 'crosshair':
      g.beginPath(); g.arc(cx, cy, s, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(cx, cy, 3, 0, Math.PI * 2); g.fill();
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) { g.beginPath(); g.moveTo(cx + dx * 7, cy + dy * 7); g.lineTo(cx + dx * 16, cy + dy * 16); g.stroke(); }
      break;
    case 'skull': skull(g, cx, cy - 2); break;
    case 'bars':
      [[-10, 6], [-3, 11], [4, 16], [11, 22]].forEach(([dx, h]) => { g.fillRect(cx + dx - 3, cy + 11 - h, 6, h); });
      break;
    case 'clipboard':
      g.strokeRect(cx - 10, cy - 12, 20, 25);
      g.fillRect(cx - 5, cy - 15, 10, 5);
      for (const dy of [-4, 2, 8]) { g.beginPath(); g.moveTo(cx - 5, cy + dy); g.lineTo(cx + 5, cy + dy); g.stroke(); }
      break;
    case 'trophy': trophyIcon(g, cx, cy); break;
    case 'clock':
      g.beginPath(); g.arc(cx, cy, s + 1, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(cx, cy - 7); g.lineTo(cx, cy); g.lineTo(cx + 6, cy + 4); g.stroke();
      break;
    case 'chevrons': chevrons(g, cx, cy, 0.62); break;
    case 'star': {
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 6 : 15;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        g.lineTo(cx + Math.cos(a) * r, cy + 1 + Math.sin(a) * r);
      }
      g.closePath(); g.fill();
      break;
    }
    case 'person':
      g.beginPath(); g.arc(cx, cy - 7, 7, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(cx - 13, cy + 14); g.quadraticCurveTo(cx - 12, cy + 1, cx, cy + 1); g.quadraticCurveTo(cx + 12, cy + 1, cx + 13, cy + 14); g.closePath(); g.fill();
      break;
    default: break;
  }
  g.restore();
}

function crown(g, cx, cy) {
  g.save();
  g.fillStyle = CYAN;
  g.beginPath();
  g.moveTo(cx - 18, cy + 10); g.lineTo(cx - 20, cy - 10); g.lineTo(cx - 9, cy - 1); g.lineTo(cx, cy - 15);
  g.lineTo(cx + 9, cy - 1); g.lineTo(cx + 20, cy - 10); g.lineTo(cx + 18, cy + 10);
  g.closePath(); g.fill();
  g.fillRect(cx - 18, cy + 13, 36, 5);
  g.restore();
}

function refreshIcon(g, cx, cy) {
  g.save();
  g.strokeStyle = CYAN;
  g.fillStyle = CYAN;
  g.lineWidth = 3.5;
  g.beginPath(); g.arc(cx, cy, 12, Math.PI * 0.15, Math.PI * 0.95); g.stroke();
  g.beginPath(); g.arc(cx, cy, 12, Math.PI * 1.15, Math.PI * 1.95); g.stroke();
  g.beginPath(); g.moveTo(cx + 13, cy - 9); g.lineTo(cx + 15, cy + 1); g.lineTo(cx + 5, cy - 1); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(cx - 13, cy + 9); g.lineTo(cx - 15, cy - 1); g.lineTo(cx - 5, cy + 1); g.closePath(); g.fill();
  g.restore();
}

const BOARD_COLS = [
  ['pos', 22, 75, '#', null],
  ['name', 75, 313, 'PLAYER NAME', 'person'],
  ['serverRank', 313, 427, 'SERVER RANK', 'medal'],
  ['kills', 427, 526, 'KILLS', 'crosshair'],
  ['deaths', 526, 626, 'DEATHS', 'skull'],
  ['kd', 626, 727, 'KD', 'bars'],
  ['matches', 727, 827, 'MATCHES', 'clipboard'],
  ['wins', 827, 929, 'WINS', 'trophy'],
  ['losses', 929, 1036, 'LOSSES', 'skull'],
  ['wl', 1036, 1137, 'W/L', 'bars'],
  ['playtime', 1137, 1270, 'PLAYTIME', 'clock'],
  ['wpgRank', 1270, 1393, 'WPG RANK', 'chevrons'],
  ['wpgXp', 1393, 1515, 'WPG XP', 'star'],
];

// d: { serverName, map, updated (text), sortLabel, rows[{name, serverRank, kills, deaths, matches, wins, losses, playtime, wpgRank, wpgXp}] }
export function renderServerBoardCard(d) {
  const rows = (d.rows || []).slice(0, 14);
  const ROW = 29;
  const titleH = 62;
  const headH = 76;
  const bodyH = Math.max(1, rows.length) * ROW;
  const panelH = titleH + headH + bodyH + 14;
  return frame('PRIVATE SERVER', panelH + 30, async (g, top) => {
    // The leaderboard design's motto under the WPG logo.
    g.font = `700 21px ${LABEL_FONT}`;
    g.fillStyle = '#e8f1f8';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('PLAY  •  FIGHT  •  BUILD  •  BELONG', 226, 234);

    const px = 10;
    const pw = 1516;
    const py = top + 8;
    panel(g, px, py, pw, panelH);

    // Title row.
    crown(g, 62, py + 34);
    g.font = `700 40px ${LABEL_FONT}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const metal = g.createLinearGradient(0, py + 16, 0, py + 52);
    metal.addColorStop(0, '#ffffff');
    metal.addColorStop(1, '#c2ccd6');
    g.fillStyle = metal;
    g.fillText('SERVER', 106, py + 34);
    const sw = g.measureText('SERVER ').width;
    g.fillStyle = CYAN;
    g.fillText('LEADERBOARD', 106 + sw, py + 34);
    g.fillStyle = CYAN;
    g.fillRect(600, py + 20, 3, 28);
    const info = [d.serverName || '[WPG] WASTED PRODIGY', 'REAL PLAYERS • REAL SQUADS', `MAP: ${upper(d.map || '—')}`, d.sortLabel ? `BY ${upper(d.sortLabel)}` : null].filter(Boolean).join('  |  ');
    bigValue(g, upper(info), 622, py + 35, 1340 - 622, { size: 22, font: LABEL_FONT, weight: 700, color: '#e8f1f8' });
    refreshIcon(g, 1384, py + 34);
    label(g, 'LAST UPDATED', 1414, py + 26, { size: 16, color: CYAN });
    label(g, upper(d.updated || '—'), 1414, py + 44, { size: 15, color: WHITE });

    // Column headings.
    const hy = py + titleH;
    g.fillStyle = 'rgba(12,30,50,0.95)';
    g.fillRect(px + 12, hy, pw - 24, headH);
    g.strokeStyle = 'rgba(56,170,235,0.55)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(px + 12, hy + headH); g.lineTo(px + pw - 12, hy + headH); g.stroke();
    for (const [key, x0, x1, name, ic] of BOARD_COLS) {
      const cx = (x0 + x1) / 2;
      if (key === 'pos') {
        bigValue(g, '#', cx, hy + headH / 2, 40, { size: 32, align: 'center' });
      } else if (key === 'name') {
        colIcon(g, 'person', x0 + 36, hy + headH / 2);
        label(g, name, x0 + 64, hy + headH / 2, { size: 19, color: WHITE });
      } else {
        colIcon(g, ic, cx, hy + 24);
        label(g, name, cx, hy + 58, { align: 'center', size: 18, color: WHITE });
      }
    }

    // Rows.
    const by = hy + headH;
    rows.forEach((r, i) => {
      const ry = by + i * ROW;
      g.fillStyle = i % 2 ? 'rgba(8,22,38,0.95)' : 'rgba(16,38,60,0.95)';
      g.fillRect(px + 12, ry, pw - 24, ROW);
      const mid = ry + ROW / 2 + 1;
      const cell = (key) => BOARD_COLS.find((c) => c[0] === key);
      const center = (key, text, opts = {}) => {
        const [, x0, x1] = cell(key);
        bigValue(g, text, (x0 + x1) / 2, mid, x1 - x0 - 10, { size: 16, align: 'center', ...opts });
      };
      center('pos', String(i + 1), { color: CYAN, size: 17 });
      const [, nx0, nx1] = cell('name');
      bigValue(g, String(r.name || 'Unknown').trim() || 'Unknown', nx0 + 20, mid, nx1 - nx0 - 26, { size: 15 });
      center('serverRank', r.serverRank ? String(r.serverRank) : '—', { size: 15 });
      center('kills', fmt(r.kills));
      center('deaths', fmt(r.deaths));
      center('kd', (Number(r.kills || 0) / Math.max(1, Number(r.deaths || 0))).toFixed(2));
      center('matches', fmt(r.matches));
      center('wins', fmt(r.wins));
      center('losses', fmt(r.losses));
      center('wl', (Number(r.wins || 0) / Math.max(1, Number(r.losses || 0))).toFixed(2));
      center('playtime', playtime(r.playtime));
      center('wpgRank', upper(r.wpgRank || 'RECRUIT I'), { size: 12, color: CYAN });
      center('wpgXp', fmt(r.wpgXp));
    });
    if (!rows.length) label(g, 'NOBODY ON THE BOARD YET', W / 2, by + ROW / 2, { align: 'center', size: 20, color: MUTED });

    // Column dividers through the headings and rows.
    g.strokeStyle = 'rgba(56,120,170,0.35)';
    g.lineWidth = 1;
    for (const [, x0] of BOARD_COLS.slice(1)) {
      g.beginPath(); g.moveTo(x0 + 0.5, hy + 4); g.lineTo(x0 + 0.5, by + bodyH); g.stroke();
    }
  });
}

// ---------- /live ----------
// d: { servers[{name, joinCode, error, map, mode, lighting, zone, players, maxPlayers, scoreCap, scores[{name,score,color}], next}] }
export function renderLiveCard(d) {
  const list = d.servers || [];
  const each = 300;
  return frame('LIVE MATCH', list.length * (each + 14) + 10, async (g, top) => {
    list.forEach((s, k) => {
      const y = top + 4 + k * (each + 14);
      panel(g, 28, y, 1480, each);
      title(g, 64, y + 40, upper(s.name || 'WPG SERVER'), s.error ? '(OFFLINE)' : '(LIVE)');
      if (s.error) {
        label(g, "CAN'T REACH THE SERVER RIGHT NOW", 64, y + 130, { size: 28, color: AMBER });
        return;
      }
      bigValue(g, upper(s.map), 64, y + 112, 640, { size: 64, font: LABEL_FONT, weight: 700 });
      label(g, upper([s.mode, s.lighting, s.zone].filter(Boolean).join('  ·  ')), 66, y + 162, { size: 24, color: CYAN });
      label(g, 'PLAYERS', 66, y + 204);
      bigValue(g, `${fmt(s.players)} / ${fmt(s.maxPlayers)}`, 66, y + 240, 300, { size: 38 });
      if (s.next) label(g, `NEXT MAP: ${upper(s.next.map)}${s.next.mode ? ` · ${upper(s.next.mode)}` : ''}`, 360, y + 240, { size: 20, color: MUTED });
      label(g, `JOIN CODE: ${s.joinCode || ''}`, 66, y + 278, { size: 17, color: MUTED });
      // Team scores.
      const cap = Math.max(1, Number(s.scoreCap) || 100);
      (s.scores || []).slice(0, 4).forEach((t, i) => {
        const ty = y + 84 + i * 52;
        label(g, upper(t.name), 780, ty, { size: 26, color: t.color || WHITE });
        bigValue(g, fmt(t.score), 1470, ty, 160, { size: 30, align: 'right' });
        bar(g, 780, ty + 18, 690, 12, t.score / cap, t.color || '#1e88e5', t.color || CYAN);
      });
      if (s.scores?.length) label(g, `FIRST TO ${fmt(cap)}`, 1470, y + 278, { align: 'right', size: 17, color: MUTED });
    });
  });
}

// ---------- Combat Command: /roster and /unit ----------
// Wraps text into lines that fit maxW (at the current font).
function wrapLines(g, text, maxW, maxLines = 4) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width <= maxW || !cur) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\W*\w*$/, '')}…`; }
  return lines;
}

// A small filled star (fonts here have no ★).
function drawStar(g, cx, cy, r, colour) {
  g.fillStyle = colour;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

// Green = on the WPG server now, blue = in a game (Steam), nothing = offline.
function presenceDot(g, x, y, m) {
  if (!m || (!m.on_server && !m.in_game)) return;
  g.fillStyle = m.on_server ? GREEN : CYAN;
  g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
}

// Slot rows for a unit: every role's places, filled with members or shown as OPEN.
function slotRows(unit) {
  const rows = [];
  for (const r of unit.roles) {
    const n = Math.max(r.slots, r.members.length);
    for (let i = 0; i < n; i++) rows.push({ role: r.name, leader: r.leader, member: r.members[i] || null });
  }
  for (const m of unit.unplaced || []) rows.push({ role: 'No role', member: m });
  return rows;
}

function unitPanel(g, u, x, y, w, h, { big = false } = {}) {
  panel(g, x, y, w, h);
  g.fillStyle = u.color || CYAN;
  g.fillRect(x + 14, y + 18, 6, 34);
  title(g, x + 32, y + 36, u.name, u.label ? `(${upper(u.label)})` : '');
  label(g, `${u.filled}/${u.size}`, x + w - 24, y + 37, { align: 'right', size: 22, color: u.open ? AMBER : GREEN });
  let ry = y + 70;
  if (big && u.mission) {
    g.font = `600 18px ${VALUE_FONT}`;
    const lines = wrapLines(g, u.mission, w - 60, 3); // missionLines() below must match
    g.fillStyle = MUTED; g.textAlign = 'left'; g.textBaseline = 'middle';
    lines.forEach((l, i) => g.fillText(l, x + 30, ry + i * 26));
    ry += lines.length * 26 + 14;
  }
  const rowH = big ? 46 : 32;
  slotRows(u).forEach((r, i) => {
    const cy = ry + i * rowH + rowH / 2;
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)';
    roundRect(g, x + 18, cy - rowH / 2 + 2, w - 36, rowH - 4, 6);
    g.fill();
    if (r.leader) drawStar(g, x + 40, cy, big ? 9 : 7, '#ffd54f');
    label(g, upper(r.role), x + (r.leader ? 56 : 32), cy + 1, { size: big ? 20 : 17, color: r.leader ? '#ffd54f' : LABEL });
    const nameX = x + (big ? 380 : Math.round(w * 0.52));
    if (r.member) {
      presenceDot(g, nameX - 14, cy, r.member);
      bigValue(g, r.member.name, nameX, cy + 1, x + w - 30 - nameX - (big ? 190 : 0), { size: big ? 20 : 16, weight: 700 });
      if (big) {
        const what = r.member.on_server ? 'ON WPG SERVER' : r.member.in_game ? upper(r.member.in_game) : (r.member.combat?.primary_role ? upper(r.member.combat.primary_role) : '');
        if (what) label(g, what, x + w - 30, cy + 1, { align: 'right', size: 16, color: r.member.on_server ? GREEN : r.member.in_game ? CYAN : MUTED });
      }
    } else {
      label(g, 'OPEN', nameX, cy + 1, { size: big ? 20 : 17, color: AMBER });
    }
  });
}
// How many lines the mission takes in the big (one unit) layout.
function missionLines(u, w) {
  if (!u.mission) return 0;
  const g = createCanvas(10, 10).getContext('2d');
  g.font = `600 18px ${VALUE_FONT}`;
  return wrapLines(g, u.mission, w - 60, 3).length;
}
const unitHeight = (u, big = false, w = 1480) => 70 + slotRows(u).length * (big ? 46 : 32) + 20 + (big && u.mission ? missionLines(u, w) * 26 + 14 : 0);

// d: boardData() — command chain on top, then every unit in two columns.
export function renderRosterCard(d) {
  const chain = d.chain || [];
  const units = (d.units || []).filter((u) => u.kind !== 'command');
  const perRow = 4;
  const chainRows = Math.max(1, Math.ceil(chain.length / perRow));
  const chainH = 70 + chainRows * 74 + 16;
  const pairs = [];
  for (let i = 0; i < units.length; i += 2) pairs.push(units.slice(i, i + 2));
  const pairH = pairs.map((p) => Math.max(...p.map((u) => unitHeight(u))));
  const bodyH = chainH + 12 + pairH.reduce((n, h) => n + h + 12, 0);
  return frame('COMBAT COMMAND', bodyH + 20, async (g, top) => {
    let y = top + 4;
    // Command and the line of succession.
    panel(g, 28, y, 1480, chainH);
    chevrons(g, 64, y + 36, 0.8);
    title(g, 100, y + 36, 'COMMAND', '(LINE OF SUCCESSION)');
    const cw = (1480 - 56 - (perRow - 1) * 14) / perRow;
    chain.forEach((c, i) => {
      const cx = 56 + (i % perRow) * (cw + 14);
      const cy = y + 70 + Math.floor(i / perRow) * 74;
      g.fillStyle = BOX_FILL;
      roundRect(g, cx, cy, cw, 62, 8);
      g.fill();
      g.fillStyle = i === 0 ? '#ffd54f' : CYAN;
      g.beginPath(); g.arc(cx + 24, cy + 31, 15, 0, Math.PI * 2); g.fill();
      bigValue(g, String(i + 1), cx + 24, cy + 32, 24, { size: 17, color: '#0a1622', align: 'center' });
      label(g, upper(c.title), cx + 50, cy + 19, { size: 15, color: LABEL });
      if (c.user) {
        presenceDot(g, cx + cw - 16, cy + 19, c.user);
        bigValue(g, c.user.name, cx + 50, cy + 43, cw - 62, { size: 18, weight: 700 });
      } else {
        label(g, 'OPEN', cx + 50, cy + 43, { size: 18, color: AMBER });
      }
    });
    y += chainH + 12;
    // Units, two per row.
    pairs.forEach((p, k) => {
      p.forEach((u, j) => unitPanel(g, u, 28 + j * 746, y, 734, pairH[k]));
      y += pairH[k] + 12;
    });
    label(g, 'GREEN DOT = ON THE WPG SERVER   ·   BLUE DOT = IN GAME   ·   GOLD STAR = UNIT LEADER', W / 2, y + 2, { align: 'center', size: 16, color: MUTED });
  });
}

// One unit, bigger, with its mission and what each member is doing right now.
export function renderUnitCard(u) {
  const h = unitHeight(u, true);
  return frame(`${upper(u.name)} UNIT`, h + 30, async (g, top) => {
    unitPanel(g, u, 28, top + 4, 1480, h, { big: true });
    label(g, 'GREEN DOT = ON THE WPG SERVER   ·   BLUE DOT = IN GAME   ·   GOLD STAR = UNIT LEADER', W / 2, top + h + 18, { align: 'center', size: 16, color: MUTED });
  });
}

// ---------- Channel posts: promotion, medal awarded, WPG rank up ----------
// A medal hanging from its ribbon (the ribbon's stripes are the medal's colours), gold star medallion.
function hangingMedal(g, cx, top, colors, s = 1) {
  const list = String(colors || '#888888').split(',').map((c) => (/^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : '#888888'));
  const rw = 74 * s;
  const rh = 92 * s;
  g.save();
  g.beginPath();
  g.moveTo(cx - rw / 2, top); g.lineTo(cx + rw / 2, top); g.lineTo(cx + rw / 2, top + rh - 18 * s); g.lineTo(cx, top + rh); g.lineTo(cx - rw / 2, top + rh - 18 * s);
  g.closePath();
  g.clip();
  const step = rw / list.length;
  list.forEach((c, i) => { g.fillStyle = c; g.fillRect(cx - rw / 2 + i * step, top, step + 1, rh); });
  const shade = g.createLinearGradient(cx - rw / 2, 0, cx + rw / 2, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.3)');
  shade.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  shade.addColorStop(1, 'rgba(0,0,0,0.3)');
  g.fillStyle = shade;
  g.fillRect(cx - rw / 2, top, rw, rh);
  g.restore();
  const cy = top + rh + 34 * s;
  const r = 44 * s;
  const gold = g.createLinearGradient(0, cy - r, 0, cy + r);
  gold.addColorStop(0, '#fff2b8');
  gold.addColorStop(0.45, '#e2b84a');
  gold.addColorStop(1, '#8a6414');
  g.save();
  g.shadowColor = 'rgba(255,200,80,0.45)';
  g.shadowBlur = 18;
  g.fillStyle = gold;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.restore();
  g.strokeStyle = '#6b4c0c';
  g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, r - 7 * s, 0, Math.PI * 2); g.stroke();
  drawStar(g, cx, cy, 24 * s, '#fff6d4');
}

// d: { name, avatar, rank{name,abbr,color,insignia}, from{name}, xp }
export function renderPromotionCard(d) {
  return frame('PROMOTION', 76 + 300 + 20, async (g, top) => {
    const y = await playerStrip(g, top, d.name, d.avatar);
    panel(g, 28, y + 6, 1480, 290);
    const badge = await loadImage(Buffer.from(rankBadge(d.rank, 240))).catch(() => null);
    if (badge) g.drawImage(badge, 70, y + 30, 240, 240);
    const tx = badge ? 350 : 70;
    label(g, 'PROMOTED TO', tx, y + 60, { size: 26 });
    bigValue(g, upper(d.rank?.name), tx, y + 128, 1470 - tx, { size: 80, color: CYAN, font: LABEL_FONT, weight: 700 });
    if (d.rank?.abbr) label(g, upper(d.rank.abbr), tx, y + 184, { size: 30, color: WHITE });
    label(g, [d.from?.name ? `FROM ${upper(d.from.name)}` : null, `CLAN XP ${fmt(d.xp)}`].filter(Boolean).join('   ·   '), tx, y + 236, { size: 22, color: MUTED });
    bigValue(g, 'SALUTE!', 1470, y + 236, 300, { size: 44, color: AMBER, font: LABEL_FONT, weight: 700, align: 'right' });
  });
}

// d: { name, avatar, medals[{name, description, colors}] }
export function renderMedalAwardCard(d) {
  const list = (d.medals || []).slice(0, 3);
  const more = (d.medals || []).length - list.length;
  const each = 250;
  const bodyH = list.length * each + (more > 0 ? 40 : 0);
  return frame(list.length > 1 ? 'MEDALS AWARDED' : 'MEDAL AWARDED', 76 + bodyH + 20, async (g, top) => {
    const y = await playerStrip(g, top, d.name, d.avatar);
    list.forEach((m, i) => {
      const py = y + 6 + i * each;
      panel(g, 28, py, 1480, each - 14);
      hangingMedal(g, 170, py + 20, m.colors, 1);
      label(g, 'AWARDED THE', 300, py + 50, { size: 26 });
      bigValue(g, upper(m.name), 300, py + 112, 1170, { size: 70, color: CYAN, font: LABEL_FONT, weight: 700 });
      g.font = `600 24px ${VALUE_FONT}`;
      g.fillStyle = MUTED;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      wrapLines(g, m.description, 1170, 2).forEach((line, k) => g.fillText(line, 300, py + 168 + k * 32));
    });
    if (more > 0) label(g, `+${more} MORE — SEE THEIR PROFILE IN WPG BARRACKS`, W / 2, y + 6 + list.length * each + 12, { align: 'center', size: 22, color: CYAN });
  });
}

// d: { name, avatar, rank, xp, position, total }
export function renderWpgRankUpCard(d) {
  return frame('WPG RANK UP', 76 + 300 + 20, async (g, top) => {
    const y = await playerStrip(g, top, d.name, d.avatar);
    panel(g, 28, y + 6, 1480, 290);
    chevrons(g, 170, y + 150, 3.2);
    label(g, 'NOW RANKED', 320, y + 60, { size: 26 });
    bigValue(g, upper(d.rank || 'RECRUIT I'), 320, y + 128, 1150, { size: 80, color: CYAN, font: LABEL_FONT, weight: 700 });
    label(g, 'WPG XP', 322, y + 186);
    bigValue(g, fmt(d.xp), 322, y + 220, 300, { size: 34 });
    if (d.position) {
      label(g, 'POSITION', 660, y + 186);
      bigValue(g, `#${fmt(d.position)}${d.total ? ` of ${fmt(d.total)}` : ''}`, 660, y + 220, 400, { size: 34 });
    }
    const pct = Math.min(1, (Number(d.xp) || 0) / 650000);
    bar(g, 322, y + 250, 1148, 12, pct);
    label(g, `${(pct * 100).toFixed(pct < 0.01 ? 2 : 1)}% OF THE WAY TO WARDOG X (650,000 WPG XP)`, 322, y + 276, { size: 17, color: MUTED });
  });
}

// ---------- Discord "… is live" post ----------
const PLATFORM_COLORS = { twitch: '#9146ff', youtube: '#ff0000', kick: '#53fc18' };
// Card fonts have no emoji, so drop them (and their joiners) rather than show empty boxes.
const noEmoji = (t) => String(t || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu, '').replace(/\s{2,}/g, ' ').trim();
// d: { name, avatar, platform, platformName, title, game, viewers, thumbnail }
export function renderStreamCard(d) {
  d = { ...d, name: noEmoji(d.name) || 'WPG streamer', title: noEmoji(d.title), game: noEmoji(d.game) };
  const bodyH = 470;
  return frame('LIVE NOW', bodyH + 20, async (g, top) => {
    const y = top + 4;
    panel(g, 28, y, 1480, bodyH);
    const pc = PLATFORM_COLORS[d.platform] || CYAN;
    // Stream preview (16:9) on the left.
    const tw = 760;
    const th = 428;
    const tx = 50;
    const ty = y + 21;
    const thumb = await icon(d.thumbnail);
    g.save();
    roundRect(g, tx, ty, tw, th, 10);
    g.clip();
    if (thumb) {
      const scale = Math.max(tw / thumb.width, th / thumb.height);
      const w = thumb.width * scale;
      const h = thumb.height * scale;
      g.drawImage(thumb, tx + (tw - w) / 2, ty + (th - h) / 2, w, h);
    } else {
      const grad = g.createLinearGradient(tx, ty, tx + tw, ty + th);
      grad.addColorStop(0, '#0b1a2b');
      grad.addColorStop(1, pc);
      g.fillStyle = grad;
      g.fillRect(tx, ty, tw, th);
      label(g, upper(d.platformName || 'LIVE'), tx + tw / 2, ty + th / 2, { align: 'center', size: 64, color: WHITE });
    }
    g.restore();
    g.save();
    g.shadowColor = pc;
    g.shadowBlur = 14;
    g.strokeStyle = pc;
    g.lineWidth = 3;
    roundRect(g, tx, ty, tw, th, 10);
    g.stroke();
    g.restore();
    // LIVE badge on the preview.
    g.fillStyle = '#e53935';
    roundRect(g, tx + 16, ty + 16, 104, 38, 6);
    g.fill();
    g.fillStyle = WHITE;
    g.beginPath(); g.arc(tx + 38, ty + 35, 7, 0, Math.PI * 2); g.fill();
    label(g, 'LIVE', tx + 54, ty + 36, { size: 24, color: WHITE });
    if (d.viewers !== null && d.viewers !== undefined) {
      g.fillStyle = 'rgba(0,0,0,0.7)';
      roundRect(g, tx + tw - 196, ty + th - 52, 180, 36, 6);
      g.fill();
      label(g, `${fmt(d.viewers)} WATCHING`, tx + tw - 106, ty + th - 33, { align: 'center', size: 20, color: WHITE });
    }
    // Right side: who, what, where.
    const rx = tx + tw + 40;
    const rw = 28 + 1480 - rx - 30;
    const av = await icon(d.avatar);
    if (av) {
      g.save();
      g.beginPath(); g.arc(rx + 44, y + 76, 44, 0, Math.PI * 2); g.clip();
      g.drawImage(av, rx, y + 32, 88, 88);
      g.restore();
      g.strokeStyle = pc;
      g.lineWidth = 3;
      g.beginPath(); g.arc(rx + 44, y + 76, 44, 0, Math.PI * 2); g.stroke();
    }
    const nx = av ? rx + 108 : rx;
    bigValue(g, d.name, nx, y + 62, rw - (nx - rx), { size: 36 });
    g.fillStyle = pc;
    roundRect(g, nx, y + 92, 130, 30, 6);
    g.fill();
    label(g, upper(d.platformName), nx + 65, y + 108, { align: 'center', size: 19, color: d.platform === 'kick' ? '#06120a' : WHITE });
    // Title, wrapped to 4 lines.
    g.font = `700 26px ${VALUE_FONT}`;
    const lines = wrapLines(g, d.title || `${d.name} is live`, rw, 4);
    g.fillStyle = WHITE;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    lines.forEach((l, i) => g.fillText(l, rx, y + 172 + i * 36));
    let iy = y + 172 + lines.length * 36 + 18;
    if (d.game) { label(g, 'PLAYING', rx, iy, { size: 18 }); bigValue(g, upper(d.game), rx + 92, iy + 1, rw - 92, { size: 22, font: LABEL_FONT, weight: 700, color: CYAN }); iy += 40; }
    label(g, 'WATCH AND CHAT IN THE WPG BARRACKS APP', rx, y + bodyH - 34, { size: 18, color: MUTED });
  });
}
