// Steam quick invite links (Edit profile → Friend requests) only work for 30 days. From day 27 the member gets a
// reminder once a day (a Discord direct message, plus an app notification if they're in the app) to paste a fresh one;
// on day 30 the link stops being shown (Add on Steam is hidden) and they get a last notice. Pasting a new link starts
// the 30 days again and the reminders stop.
import { q } from './db.js';
import { bus } from './bus.js';

export const INVITE_DAYS = 30;
export const REMIND_FROM_DAY = 27;
const DAY = 86400e3;
// When a member's link stops working (null if they have none).
export const inviteExpires = (u) => (u?.steam_invite && u.steam_invite_at ? new Date(new Date(u.steam_invite_at).getTime() + INVITE_DAYS * DAY) : null);
export const inviteLive = (u) => !!u?.steam_invite && (!inviteExpires(u) || inviteExpires(u) > new Date());

// Checked every hour for everyone (the Discord DM reaches them wherever they are), and when someone opens the app
// (so the app notification arrives while they're there). At most one reminder a day; the profile also shows the warning.
async function remind(ids = null) {
  if (ids && !ids.length) return;
  const due = await q(`SELECT id, steam_invite_at, steam_invite_reminded FROM users
     WHERE ($1::int[] IS NULL OR id = ANY($1)) AND status='active' AND steam_invite <> '' AND steam_invite_at IS NOT NULL
       AND steam_invite_at < now() - interval '${REMIND_FROM_DAY} days'
       AND (steam_invite_reminded IS NULL OR steam_invite_reminded < now() - interval '23 hours')
       AND steam_invite_at > now() - interval '${INVITE_DAYS + 7} days'`, [ids]);
  for (const u of due) {
    const left = Math.ceil((new Date(u.steam_invite_at).getTime() + INVITE_DAYS * DAY - Date.now()) / DAY);
    const expired = left <= 0;
    const note = expired
      ? { title: 'Your Steam invite link has run out', body: "Steam's links last 30 days, so Add on Steam is hidden on your profile. Paste a new one in Edit profile → Friend requests.", link: '#/profile/edit' }
      : { title: `Your Steam invite link runs out in ${left} day${left === 1 ? '' : 's'}`, body: "Steam's links last 30 days. Paste a fresh one in Edit profile → Friend requests to keep Add on Steam on your profile.", link: '#/profile/edit' };
    bus.emit('notify', u.id, note);
    bus.emit('steaminvite:remind', { userId: u.id, expired, ...note }); // Discord DM (discordbot.js)
    // Expired: no more reminders until they paste a new link (that resets steam_invite_reminded).
    await q(`UPDATE users SET steam_invite_reminded=${expired ? "'infinity'" : 'now()'} WHERE id=$1`, [u.id]);
  }
}

export function startSteamInviteReminders() {
  // Links saved before reminders existed: count their 30 days from now.
  q("UPDATE users SET steam_invite_at=now() WHERE steam_invite <> '' AND steam_invite_at IS NULL").catch(() => {});
  // A few seconds after they open the app, so the notification arrives once the page is ready.
  bus.on('user:connected', (id) => setTimeout(() => remind([id]).catch((e) => console.warn('[steam invite]', e.message)), 5000));
  setInterval(() => remind().catch((e) => console.warn('[steam invite]', e.message)), 3600e3);
  setTimeout(() => remind().catch((e) => console.warn('[steam invite]', e.message)), 60e3);
}
