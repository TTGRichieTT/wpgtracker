// Who is in a game right now, from Steam (the "Playing Wardogs" line). Works on any server, as long as
// the member's Steam game details are public. With a Steam API key it asks about up to 100 members at
// once every minute; without one it reads public profile pages, one member every few seconds.
// Kept in memory only: it's live status, and a restart just re-checks everyone.
import { q } from './db.js';
import { bus } from './bus.js';
import { steamGet } from './steam.js';

const playing = new Map(); // userId -> { game, appId }
export const playingNow = () => Object.fromEntries(playing);

let changed = false;
function setPlaying(userId, game, appId) {
  const old = playing.get(userId);
  if (!game) {
    if (old) { playing.delete(userId); changed = true; }
    return;
  }
  if (old?.game === game && old?.appId === appId) return;
  playing.set(userId, { game: String(game).slice(0, 80), appId: String(appId || '') });
  changed = true;
}
function flush() {
  if (!changed) return;
  changed = false;
  bus.emit('playing', playingNow());
}

const members = () => q("SELECT id, steam_id FROM users WHERE status='active' AND steam_id ~ '^[0-9]{17}$' ORDER BY id");

async function checkWithKey() {
  const list = await members();
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100);
    const data = await steamGet('/ISteamUser/GetPlayerSummaries/v2/', { steamids: batch.map((u) => u.steam_id).join(',') });
    const bySteam = new Map((data?.response?.players || []).map((p) => [String(p.steamid), p]));
    for (const u of batch) {
      const p = bySteam.get(u.steam_id);
      setPlaying(u.id, p?.gameid ? p.gameextrainfo || 'a game' : '', p?.gameid);
    }
  }
}

async function checkProfile(u) {
  const res = await fetch(`https://steamcommunity.com/profiles/${u.steam_id}/?xml=1`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return;
  const xml = await res.text();
  // The status line reads "In-Game<br/>WARDOGS"; the rest of the page lists most-played games, not the current one.
  const inGame = /<onlineState>in-game<\/onlineState>/.test(xml);
  const state = /<stateMessage><!\[CDATA\[([\s\S]*?)\]\]><\/stateMessage>/.exec(xml)?.[1] || '';
  const game = state.split(/<br\s*\/?>/i)[1]?.replace(/<[^>]*>/g, '').trim();
  setPlaying(u.id, inGame ? game || 'a game' : '', '');
}

export function startPlayingWatch() {
  let queue = [];
  const tick = async () => {
    let wait = 60 * 1000;
    try {
      if (process.env.STEAM_API_KEY) {
        await checkWithKey();
      } else {
        if (!queue.length) queue = await members();
        const u = queue.shift();
        if (u) await checkProfile(u);
        wait = 4000;
      }
    } catch (e) {
      console.warn('[playing]', e.message);
    }
    flush();
    setTimeout(tick, wait);
  };
  setTimeout(tick, 20 * 1000);
}
