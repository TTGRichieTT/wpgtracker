// A live connection to Discord (the "gateway"), so the bot sees joins, leaves, messages, edits and deletes as
// they happen: used by the mod log, the spam filter, welcome posts and the raid alarm (discordmod.js).
// Events arrive on the bus as 'discord:event' { t, d }.
// Needs SERVER MEMBERS INTENT and MESSAGE CONTENT INTENT switched on in the Discord Developer Portal; without
// them it connects without those and says so in Admin → Discord server.
import { bus } from './bus.js';
import { discordFetch, botReady } from './discordbot.js';

const GUILDS = 1 << 0;
const GUILD_MEMBERS = 1 << 1;
const GUILD_MODERATION = 1 << 2;
const GUILD_MESSAGES = 1 << 9;
const MESSAGE_CONTENT = 1 << 15;
const FULL = GUILDS | GUILD_MEMBERS | GUILD_MODERATION | GUILD_MESSAGES | MESSAGE_CONTENT;
const BASIC = GUILDS | GUILD_MODERATION | GUILD_MESSAGES;

const state = { connected: false, since: null, intents: FULL, problem: null, events: 0, user: null };
export const gatewayStatus = () => ({ ...state, limited: state.intents !== FULL });

let ws = null;
let seq = null;
let sessionId = null;
let resumeUrl = null;
let beat = null;
let acked = true;
let retry = 0;

async function connect() {
  if (!botReady()) return;
  let url = resumeUrl;
  if (!url) {
    try {
      url = (await discordFetch('/gateway/bot')).url;
    } catch (e) {
      state.problem = `Couldn't reach Discord: ${e.message}`;
      return later();
    }
  }
  const token = String(process.env.DISCORD_BOT_TOKEN || '').trim().replace(/^Bot\s+/i, '');
  ws = new WebSocket(`${url}/?v=10&encoding=json`);
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.s !== null && msg.s !== undefined) seq = msg.s;
    if (msg.op === 10) {
      clearInterval(beat);
      acked = true;
      beat = setInterval(() => {
        if (!acked) { ws?.close(4000); return; } // no answer to the last heartbeat: the connection is dead
        acked = false;
        send({ op: 1, d: seq });
      }, msg.d.heartbeat_interval);
      if (sessionId && resumeUrl) send({ op: 6, d: { token, session_id: sessionId, seq } });
      else send({ op: 2, d: { token, intents: state.intents, large_threshold: 250, properties: { os: 'linux', browser: 'wpg-barracks', device: 'wpg-barracks' } } });
    } else if (msg.op === 11) {
      acked = true;
    } else if (msg.op === 1) {
      send({ op: 1, d: seq });
    } else if (msg.op === 7) {
      ws.close(4000); // Discord asks us to reconnect (and resume)
    } else if (msg.op === 9) {
      sessionId = null; resumeUrl = null; seq = null; // session can't be resumed: start a new one
      setTimeout(() => ws?.close(4000), 1500);
    } else if (msg.op === 0) {
      if (msg.t === 'READY') {
        sessionId = msg.d.session_id;
        resumeUrl = msg.d.resume_gateway_url;
        state.user = msg.d.user?.username || null;
        Object.assign(state, { connected: true, since: new Date().toISOString() });
        if (state.intents === FULL) state.problem = null;
        retry = 0;
      }
      if (msg.t === 'RESUMED') { state.connected = true; retry = 0; }
      state.events++;
      try { bus.emit('discord:event', { t: msg.t, d: msg.d }); } catch (e) { console.warn('[gateway] handler', e.message); }
    }
  };
  ws.onclose = (ev) => {
    clearInterval(beat);
    state.connected = false;
    ws = null;
    const code = ev.code;
    if (code === 4004) { state.problem = 'Discord says the bot token is wrong.'; return; }
    if (code === 4014) {
      // Members / message content intents aren't switched on: carry on without them.
      state.problem = 'Switch on SERVER MEMBERS INTENT and MESSAGE CONTENT INTENT (Developer Portal → your app → Bot → Privileged Gateway Intents), then press Reconnect. Until then the mod log, spam filter and welcome posts are limited.';
      state.intents = BASIC;
      sessionId = null; resumeUrl = null;
    }
    if ([4007, 4009, 4010, 4011, 4012, 4013].includes(code)) { sessionId = null; resumeUrl = null; }
    later();
  };
  ws.onerror = () => {};
}
function send(obj) {
  try { ws?.send(JSON.stringify(obj)); } catch { /* closed */ }
}
function later() {
  retry = Math.min(retry + 1, 6);
  setTimeout(connect, 1000 * 2 ** retry);
}

// Admin → Discord server: try again with every intent (after switching them on in the portal).
export function reconnectGateway() {
  state.intents = FULL;
  state.problem = null;
  sessionId = null; resumeUrl = null; seq = null;
  if (ws) ws.close(4000); else connect();
}

export function startGateway() {
  if (!botReady() || typeof WebSocket === 'undefined') return;
  setTimeout(connect, 5000);
}
