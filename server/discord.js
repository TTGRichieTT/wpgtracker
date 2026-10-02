// Who's in the WPG Discord voice channels, from Discord's public server widget.
// Needs "Enable Server Widget" switched on in Discord (Server Settings → Widget). No bot required.
// Only voice channels that @everyone can see are listed by Discord.
import express from 'express';
import { setting, flag } from './db.js';
import { member } from './util.js';

export const discord = express.Router();

const API = 'https://discord.com/api';
let guildCache = { key: '', id: '', at: 0 };
let widgetCache = { id: '', at: 0, data: null };

function inviteCode(link) {
  const m = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]{2,40})/i.exec(String(link || ''));
  return m ? m[1] : null;
}

export async function guildId() {
  const direct = String((await setting('discord_server_id')) || '').trim();
  if (/^\d{15,22}$/.test(direct)) return direct;
  const code = inviteCode(await setting('discord_invite'));
  if (!code) return null;
  if (guildCache.key === code && Date.now() - guildCache.at < 24 * 3600 * 1000) return guildCache.id;
  const res = await fetch(`${API}/v10/invites/${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const id = (await res.json())?.guild?.id || '';
  guildCache = { key: code, id, at: Date.now() };
  return id || null;
}

async function widget(id) {
  if (widgetCache.id === id && Date.now() - widgetCache.at < 30 * 1000) return widgetCache.data;
  const res = await fetch(`${API}/guilds/${id}/widget.json`, { signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => ({}));
  const out = res.ok ? { ok: true, data } : { ok: false, reason: data?.message || `Discord returned ${res.status}` };
  widgetCache = { id, at: Date.now(), data: out };
  return out;
}

discord.get('/discord/voice', member, async (_req, res) => {
  if (!(await flag('discord_voice_enabled'))) return res.json({ enabled: false, reason: 'off' });
  const id = await guildId().catch(() => null);
  if (!id) return res.json({ enabled: false, reason: 'no_server' });
  const w = await widget(id).catch((e) => ({ ok: false, reason: e.message }));
  if (!w.ok) return res.json({ enabled: false, reason: /disabled/i.test(w.reason) ? 'widget_disabled' : w.reason });

  const d = w.data;
  const members = Array.isArray(d.members) ? d.members : [];
  const person = (m) => ({
    name: String(m.username || 'Someone').slice(0, 40),
    avatar: /^https:\/\/cdn\.discordapp\.com\//.test(m.avatar_url || '') ? m.avatar_url : '',
    status: String(m.status || ''),
    muted: !!(m.mute || m.self_mute || m.suppress),
    deafened: !!(m.deaf || m.self_deaf),
    game: m.game?.name ? String(m.game.name).slice(0, 60) : '',
  });
  const channels = (Array.isArray(d.channels) ? d.channels : [])
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => ({
      id: String(c.id),
      name: String(c.name || '').slice(0, 60),
      members: members.filter((m) => String(m.channel_id || '') === String(c.id)).map(person),
    }));
  // Discord hides the names of voice channels @everyone can't see, but still says who is in voice.
  // Show those people too, grouped by channel, without the (hidden) channel name.
  const known = new Set(channels.map((c) => c.id));
  const hidden = new Map();
  for (const m of members) {
    const id = String(m.channel_id || '');
    if (!id || known.has(id)) continue;
    if (!hidden.has(id)) hidden.set(id, []);
    hidden.get(id).push(person(m));
  }
  let n = 0;
  for (const [id, people] of hidden) {
    n += 1;
    channels.push({ id, name: hidden.size > 1 ? `Members-only voice ${n}` : 'Members-only voice', hidden: true, members: people });
  }
  res.json({
    enabled: true,
    name: String(d.name || 'Discord'),
    online: Number(d.presence_count) || members.length,
    invite: (await setting('discord_invite')) || d.instant_invite || '',
    inVoice: channels.reduce((sum, c) => sum + c.members.length, 0),
    hiddenChannels: hidden.size > 0,
    channels,
  });
});
