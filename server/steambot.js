// Live match money from Steam: the line under a player's name in the Steam friends list while they play Wardogs
// (e.g. "-$10,793 Loss"), which the game sends to Steam as "rich presence". Steam only shares it with a player's
// friends (and, when it allows, with a Steam client that asks about someone in a game), so a WPG Barracks Steam
// account (the bot) stays logged in here like a Steam client:
//  - Members switch it on on their profile ("Show my live match money") and add the bot with their own single-use
//    Steam quick invite link (a new Steam account can't send friend requests, but quick links always work); the bot
//    also tries sending them a request, and accepts members' requests. Members who were already its friends are
//    switched on by themselves. Non-members who add it are removed. Switching it off, or unfriending it, stops it.
//  - Friends' changes arrive by themselves; members who haven't accepted yet are asked about every minute while
//    Steam says they're playing Wardogs.
//  - The latest line shows next to "Playing Wardogs" across the app; every match result is kept for the
//    "24-hour money" leaderboard and Discord (/money, live board); staff see the raw values in Admin → Steam bot.
// Login: STEAM_BOT_USERNAME and STEAM_BOT_PASSWORD (+ STEAM_BOT_SHARED_SECRET for a mobile authenticator) in the
// host's settings. The first login is done with steam-session and kept open while staff type the emailed Steam
// Guard code in Admin → Steam bot (restarting the login with the code would make Steam email a new one, forever).
// Steam then hands over a sign-in token, kept encrypted in the database, so later starts need neither the password
// nor a code.
import express from 'express';
import { q, one, flag, setting, audit } from './db.js';
import { bus } from './bus.js';
import { seal, open } from './secretbox.js';
import { HttpError, member, role, str, int, bool } from './util.js';

export const steamBotRouter = express.Router();
const WARDOGS_APP = 1867240;
const TOKEN_KEY = '_steam_bot_token';
const isWpgMember = (u) => !!u && u.status === 'active' && u.membership !== 'pmc';

// What the bot is doing right now (Admin → Steam bot).
const status = { state: 'off', error: '', guardDomain: null, steamId: '', name: '', since: null, pollWorks: null, requestsRefused: '' };
let client = null;
let SteamUser = null;
let guardCallback = null;
let retryTimer = null;
let usingToken = false;
let pendingSession = null; // the first login, waiting for the emailed Steam Guard code

const creds = () => ({
  user: String(process.env.STEAM_BOT_USERNAME || '').trim(),
  pass: String(process.env.STEAM_BOT_PASSWORD || ''),
  secret: String(process.env.STEAM_BOT_SHARED_SECRET || '').trim(),
});
const loadToken = async () => open((await one('SELECT value FROM settings WHERE key=$1', [TOKEN_KEY]))?.value || '');
const saveToken = async (t) => q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [TOKEN_KEY, await seal(t)]);
const forgetToken = () => q('DELETE FROM settings WHERE key=$1', [TOKEN_KEY]);

// ---------- Members (Steam ID → member), refreshed every few minutes ----------
let bySteam = new Map();
let bySteamAt = 0;
async function memberBySteam(steamId) {
  if (Date.now() - bySteamAt > 3 * 60 * 1000) {
    bySteam = new Map((await q("SELECT id, steam_id, persona_name, status, membership FROM users WHERE status='active' AND steam_id ~ '^[0-9]{17}$'")).map((u) => [u.steam_id, u]));
    bySteamAt = Date.now();
  }
  return bySteam.get(steamId) || null;
}

// ---------- Reading the line ----------
// "-$10,793 Loss" → { money: -10793, result: 'loss' }; "+$4,200 Profit" → { money: 4200, result: 'profit' }.
// Wardogs shows the match's running profit / loss (it goes back to $0 at the start of the next match).
export function parseLine(text) {
  const t = String(text || '');
  const m = /([-+−–])?\s*\$\s*([\d,]+(?:\.\d+)?)/.exec(t);
  let money = m ? Math.round(Number(m[2].replace(/,/g, ''))) : null;
  if (money !== null && m[1] && m[1] !== '+') money = -money;
  if (money !== null && !Number.isFinite(money)) money = null;
  if (money !== null && money > 0 && !m[1] && /\b(loss|lost)\b/i.test(t)) money = -money; // "$500 Loss" → -500
  return { money, result: money > 0 ? 'profit' : money < 0 ? 'loss' : '' };
}

// A finished match: its final profit / loss, kept for "24-hour money" (a match that ends on exactly $0 isn't kept).
async function finishMatch(userId, money) {
  if (!money) return;
  const result = money > 0 ? 'profit' : 'loss';
  await q('INSERT INTO presence_results (user_id, money, result, text) VALUES ($1,$2,$3,$4)', [userId, money, result, `${money < 0 ? '-' : '+'}$${Math.abs(money).toLocaleString('en-GB')} ${money < 0 ? 'Loss' : 'Profit'}`]);
  bigWin(userId, money).catch(() => {});
  bus.emit('money:changed');
}

// One reading for a member: shown live, and the match in progress followed. A match is finished when the figure goes
// back to $0 (the next match started) or they leave Wardogs. Anything else in between (menus, loading screens) just
// waits, since a new match always starts at $0. A gap of 45 minutes with no news means the last match was missed.
const STALE_MS = 45 * 60 * 1000;
export async function record(userId, { inGame, text, raw }) {
  const row = await one('SELECT * FROM live_presence WHERE user_id=$1', [userId]);
  if (!row?.opted_in) return;
  const clean = String(text || '').slice(0, 200);
  const { money, result } = parseLine(clean);
  const changed = clean && clean !== row.text;
  let open = row.open_money;
  const stale = open !== null && row.seen_at && Date.now() - new Date(row.seen_at).getTime() > STALE_MS;
  if (open !== null && (!inGame || money === 0 || (stale && money !== null))) {
    await finishMatch(userId, open);
    open = null;
  }
  if (inGame && money) open = money;
  await q(
    `UPDATE live_presence SET in_game=$2, text=CASE WHEN $3 <> '' THEN $3 ELSE text END, money=CASE WHEN $3 <> '' THEN $4 ELSE money END,
            result=CASE WHEN $3 <> '' THEN $5 ELSE result END, raw=CASE WHEN $3 <> '' THEN $6 ELSE raw END, open_money=$8,
            seen_at=now(), updated_at=CASE WHEN $7 THEN now() ELSE updated_at END WHERE user_id=$1`,
    [userId, !!inGame, clean, money, result, JSON.stringify(raw || {}), changed || row.in_game !== !!inGame, open],
  );
  if (changed) await q('INSERT INTO presence_log (user_id, text, raw) VALUES ($1,$2,$3)', [userId, clean, JSON.stringify(raw || {})]);
  if (changed || row.in_game !== !!inGame) {
    const { setLive } = await import('./playing.js');
    setLive(userId, inGame && clean ? { text: clean, money, result } : null);
    bus.emit('money:changed');
  }
}

// A big match (Admin → Steam bot sets the amount): one Discord post, WPG members only.
async function bigWin(userId, money) {
  if (money <= 0 || !(await flag('discord_post_big_wins'))) return;
  const min = Number(await setting('big_win_amount')) || 50000;
  if (money < min) return;
  const u = await one('SELECT * FROM users WHERE id=$1', [userId]);
  if (isWpgMember(u)) bus.emit('announce', { type: 'bigwin', userId, money });
}

// ---------- The Steam client ----------
function setState(state, extra = {}) {
  Object.assign(status, { state, error: '', ...extra });
  bus.emit('steambot:status', publicStatus());
}

export async function startSteamBot() {
  const c = creds();
  const token = await loadToken().catch(() => '');
  if (!c.user && !token) {
    setState('off', { error: 'Not set up: add STEAM_BOT_USERNAME and STEAM_BOT_PASSWORD in Render, then restart.' });
    return;
  }
  if (!(await flag('steam_bot_enabled'))) {
    setState('off', { error: 'Switched off in Admin → Steam bot.' });
    return;
  }
  if (!SteamUser) SteamUser = (await import('steam-user')).default;
  if (client) return logOn();
  // dataDirectory null: nothing written to disk (the host wipes it); Steam's sign-in token is kept in the database.
  client = new SteamUser({ autoRelogin: true, renewRefreshTokens: true, dataDirectory: null, language: 'english' });

  client.on('refreshToken', (t) => { saveToken(t).catch((e) => console.warn('[steam bot] token', e.message)); });
  client.on('steamGuard', async (domain, callback, lastCodeWrong) => {
    const secret = creds().secret;
    if (domain === null && secret) {
      // Mobile authenticator: make the code here (wait for a fresh one if the last was refused).
      if (lastCodeWrong) await new Promise((r) => setTimeout(r, 31000));
      const SteamTotp = (await import('steam-totp')).default;
      callback(SteamTotp.generateAuthCode(secret));
      return;
    }
    guardCallback = callback;
    setState('guard', { guardDomain: domain });
    bus.emit('staff:notify', { title: 'Steam bot needs a Steam Guard code', body: domain ? `Check the email at …@${domain} and type the code in Admin → Steam bot.` : 'Type the code from the Steam mobile app in Admin → Steam bot.', link: '#/admin/steambot' });
  });
  client.on('loggedOn', () => {
    guardCallback = null;
    client.setPersona(SteamUser.EPersonaState.Online);
    setState('online', { steamId: client.steamID?.getSteamID64?.() || '', since: new Date().toISOString() });
    console.log('[steam bot] online');
  });
  client.on('accountInfo', (name) => { status.name = name; });
  client.on('friendsList', () => { reconcileFriends().catch((e) => console.warn('[steam bot] friends', e.message)); });
  client.on('friendRelationship', (sid, rel) => { onRelationship(sid.getSteamID64(), rel).catch((e) => console.warn('[steam bot] friend', e.message)); });
  client.on('user', (sid, user) => { onUser(sid.getSteamID64(), user).catch((e) => console.warn('[steam bot] user', e.message)); });
  client.on('disconnected', (eresult, msg) => { if (status.state === 'online') setState('connecting', { error: msg || '' }); });
  client.on('error', async (e) => {
    const E = SteamUser.EResult;
    console.warn('[steam bot] error', e.message);
    // A saved sign-in token that Steam no longer accepts: forget it and use the password (if there is one).
    if (usingToken && [E.InvalidPassword, E.AccessDenied, E.Expired, E.Revoked, E.InvalidSignature].includes(e.eresult)) {
      await forgetToken();
      if (creds().user) return retry(5 * 1000, 'Saved Steam sign-in expired: signing in with the password again.');
    }
    if (e.eresult === E.InvalidPassword) return setState('error', { error: 'Steam says the password is wrong: check STEAM_BOT_PASSWORD in Render, then press Reconnect.' });
    if (e.eresult === E.RateLimitExceeded) return retry(30 * 60 * 1000, 'Steam is limiting logins from here: trying again in 30 minutes.');
    if (e.eresult === E.LoggedInElsewhere || e.eresult === E.LogonSessionReplaced) return retry(5 * 60 * 1000, 'The bot account was logged in somewhere else: trying again in 5 minutes. (Don\'t play on the bot account.)');
    retry(10 * 60 * 1000, e.message);
  });
  logOn();
}

async function logOn() {
  clearTimeout(retryTimer);
  const token = await loadToken().catch(() => '');
  const c = creds();
  setState('connecting');
  usingToken = !!token;
  try {
    if (token) client.logOn({ refreshToken: token, machineName: 'WPG Barracks' });
    else if (c.user && c.pass) await passwordLogin();
    else setState('error', { error: 'No saved Steam sign-in and no STEAM_BOT_PASSWORD: add it in Render, then press Reconnect.' });
  } catch (e) {
    retry(10 * 60 * 1000, e.message);
  }
}

// First login with the password: one Steam login session, kept open until the Steam Guard code is typed (up to
// 15 minutes), then its sign-in token is saved and used to log the bot on.
async function passwordLogin() {
  const ss = await import('steam-session');
  const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } = ss.default || ss;
  const c = creds();
  if (pendingSession) {
    try { pendingSession.cancelLoginAttempt(); } catch { /* already over */ }
    pendingSession = null;
  }
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
  session.loginTimeout = 15 * 60 * 1000;
  session.on('authenticated', async () => {
    pendingSession = null;
    try {
      await saveToken(session.refreshToken);
      usingToken = true;
      setState('connecting');
      client.logOn({ refreshToken: session.refreshToken, machineName: 'WPG Barracks' });
    } catch (e) {
      retry(60 * 1000, e.message);
    }
  });
  session.on('timeout', () => {
    if (pendingSession !== session) return;
    pendingSession = null;
    setState('error', { error: "The Steam Guard code wasn't entered within 15 minutes: press Reconnect to get a new email." });
  });
  session.on('error', (e) => {
    if (pendingSession === session) pendingSession = null;
    retry(10 * 60 * 1000, `Steam login problem: ${e.message}`);
  });
  let start;
  try {
    start = await session.startWithCredentials({ accountName: c.user, password: c.pass });
  } catch (e) {
    if (e.eresult === 5) return setState('error', { error: 'Steam says the password is wrong: check STEAM_BOT_PASSWORD in Render, then press Reconnect.' });
    if (e.eresult === 84) return retry(30 * 60 * 1000, 'Steam is limiting logins from here: trying again in 30 minutes.');
    return retry(10 * 60 * 1000, `Steam login problem: ${e.message}`);
  }
  if (!start.actionRequired) return; // no code needed: 'authenticated' follows
  const actions = start.validActions || [];
  const device = actions.find((a) => a.type === EAuthSessionGuardType.DeviceCode);
  if (device && c.secret) {
    const SteamTotp = (await import('steam-totp')).default;
    await session.submitSteamGuardCode(SteamTotp.generateAuthCode(c.secret));
    return;
  }
  const email = actions.find((a) => a.type === EAuthSessionGuardType.EmailCode);
  pendingSession = session;
  setState('guard', { guardDomain: email ? email.detail || '' : null });
  bus.emit('staff:notify', {
    title: 'Steam bot needs a Steam Guard code',
    body: email ? `Check the email at …@${email.detail} and type the code in Admin → Steam bot (within 15 minutes).` : 'Type the code from the Steam mobile app in Admin → Steam bot.',
    link: '#/admin/steambot',
  });
}
function retry(ms, why) {
  setState('error', { error: why });
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { if (client) logOn(); }, ms);
}

// ---------- Friends ----------
const REL = () => SteamUser.EFriendRelationship;
async function setFriend(userId, friend, extra = '') {
  await q(`UPDATE live_presence SET friend=$2${extra} WHERE user_id=$1`, [userId, friend]);
}
async function onRelationship(steamId, rel) {
  const u = await memberBySteam(steamId);
  const R = REL();
  if (rel === R.RequestRecipient) {
    // Someone added the bot: members are accepted (and that switches live match money on); anyone else is declined.
    if (!u) return client.removeFriend(steamId);
    await ensureRow(u.id, steamId);
    await q('UPDATE live_presence SET opted_in=true WHERE user_id=$1', [u.id]);
    return client.addFriend(steamId);
  }
  if (!u) {
    // Not an app member (e.g. someone used a member's invite link): the bot's friends list is for members.
    if (rel === R.Friend) client.removeFriend(steamId);
    return;
  }
  if (rel === R.Friend) {
    await ensureRow(u.id, steamId);
    await setFriend(u.id, 'friends', ', opted_in=true');
    bus.emit('notify', u.id, { title: 'Live match money is on', body: 'The WPG Barracks Steam account is your friend now: your match money shows in the app while you play Wardogs.', link: `#/u/${u.id}` });
    bus.emit('user:changed', u.id);
  } else if (rel === R.RequestInitiator) {
    await setFriend(u.id, 'requested');
  } else if (rel === R.None) {
    // Unfriended the bot: they don't want it any more.
    await setFriend(u.id, 'none', ", opted_in=false, in_game=false, text=''");
    const { setLive } = await import('./playing.js');
    setLive(u.id, null);
    bus.emit('user:changed', u.id);
  } else if (rel === R.Blocked || rel === R.Ignored || rel === R.IgnoredFriend) {
    await setFriend(u.id, 'blocked', ', opted_in=false');
  }
}
// After logging in: match the friends list with who has it switched on.
async function reconcileFriends() {
  const R = REL();
  const friends = client.myFriends || {};
  for (const [sid, rel] of Object.entries(friends)) {
    if (rel === R.RequestRecipient) await onRelationship(sid, rel);
  }
  // Members who are already the bot's friends (e.g. added before this was switched on): on by themselves.
  for (const [sid, rel] of Object.entries(friends)) {
    if (rel !== R.Friend) continue;
    const u = await memberBySteam(sid);
    if (!u) continue;
    await ensureRow(u.id, sid);
    await q("UPDATE live_presence SET opted_in=true, friend='friends' WHERE user_id=$1 AND (NOT opted_in OR friend <> 'friends')", [u.id]);
  }
  const rows = await q('SELECT lp.*, u.steam_id AS sid FROM live_presence lp JOIN users u ON u.id = lp.user_id');
  for (const r of rows) {
    const rel = friends[r.sid];
    const friend = rel === R.Friend ? 'friends' : rel === R.RequestInitiator ? 'requested' : ['blocked', 'add_bot'].includes(r.friend) ? r.friend : 'none';
    if (friend !== r.friend) await setFriend(r.user_id, friend);
    // Switched on but no friend request out (e.g. switched on while the bot was offline): send one now.
    if (r.opted_in && (friend === 'none' || r.friend === 'add_bot') && rel === undefined) sendRequest(r.user_id, r.sid).catch(() => {});
  }
}
// Steam refuses friend requests from a "limited" account (a new one that hasn't had $5 spent or added to its wallet).
// Then the member adds the bot themselves (friend 'add_bot'); the bot accepts members' requests either way.
function sendRequest(userId, steamId) {
  return new Promise((resolve) => {
    client.addFriend(steamId, async (err) => {
      if (!err) await setFriend(userId, 'requested');
      else if (err.eresult === SteamUser.EResult.Blocked) await setFriend(userId, 'blocked');
      else if (err.eresult === SteamUser.EResult.DuplicateName) await setFriend(userId, client.myFriends?.[steamId] === REL().Friend ? 'friends' : 'requested');
      else {
        await setFriend(userId, 'add_bot');
        status.requestsRefused = err.message || String(err.eresult);
      }
      resolve(err && err.eresult !== SteamUser.EResult.DuplicateName ? "Steam didn't let the bot send you a friend request: add it as a friend yourself from its Steam profile (link on your profile)." : null);
    });
  });
}
// Their own single-use quick invite link to add the bot (valid 7 days; a fresh one when it's used or nearly expired).
async function inviteLinkFor(userId) {
  if (status.state !== 'online') return '';
  const row = await one('SELECT invite_link, invite_expires FROM live_presence WHERE user_id=$1', [userId]);
  if (row?.invite_link && row.invite_expires && new Date(row.invite_expires).getTime() - Date.now() > 60 * 60 * 1000) {
    const check = await client.checkQuickInviteLinkValidity(row.invite_link).catch(() => null);
    if (check?.valid !== false) return row.invite_link;
  }
  const r = await client.createQuickInviteLink({ inviteLimit: 1, inviteDuration: 7 * 24 * 60 * 60 }).catch((e) => {
    console.warn('[steam bot] invite link', e.message);
    return null;
  });
  const link = r?.token?.invite_link || '';
  if (link) await q("UPDATE live_presence SET invite_link=$2, invite_expires=now() + interval '7 days' WHERE user_id=$1", [userId, link]);
  return link;
}
async function ensureRow(userId, steamId) {
  await q('INSERT INTO live_presence (user_id, steam_id) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET steam_id=EXCLUDED.steam_id', [userId, steamId]);
}

// A friend's status changed (Steam sends it by itself).
async function onUser(steamId, user) {
  const u = await memberBySteam(steamId);
  if (!u) return;
  const inGame = String(user.gameid || '') === String(WARDOGS_APP);
  const raw = Object.fromEntries((user.rich_presence || []).map((kv) => [kv.key, kv.value]));
  await record(u.id, { inGame, text: inGame ? user.rich_presence_string || '' : '', raw: inGame ? raw : {} });
}

// Members who switched it on but aren't friends yet: asked about every minute while they're playing Wardogs.
async function poll() {
  if (status.state !== 'online') return;
  const { playingNow } = await import('./playing.js');
  const playing = playingNow();
  const rows = await q("SELECT lp.user_id, u.steam_id FROM live_presence lp JOIN users u ON u.id = lp.user_id WHERE lp.opted_in AND lp.friend <> 'friends'");
  const wanted = rows.filter((r) => /wardogs/i.test(playing[r.user_id]?.game || '') || String(playing[r.user_id]?.appId) === String(WARDOGS_APP));
  // Stopped playing: no longer in a match (their last match is finished).
  const gone = await q("SELECT user_id FROM live_presence WHERE opted_in AND friend <> 'friends' AND (in_game OR open_money IS NOT NULL)");
  for (const r of gone.filter((x) => !wanted.some((w) => w.user_id === x.user_id))) await record(r.user_id, { inGame: false, text: '', raw: {} });
  if (!wanted.length) return;
  const res = await client.requestRichPresence(WARDOGS_APP, wanted.map((r) => r.steam_id)).catch(() => null);
  const users = res?.users || {};
  if (Object.keys(users).length) status.pollWorks = true;
  else if (status.pollWorks === null) status.pollWorks = false;
  for (const r of wanted) {
    const d = users[r.steam_id];
    if (d) await record(r.user_id, { inGame: true, text: d.localizedString || '', raw: d.richPresence || {} });
  }
}

export function startSteamBotLoops() {
  setTimeout(() => startSteamBot().catch((e) => setState('error', { error: e.message })), 25 * 1000);
  setInterval(() => poll().catch((e) => console.warn('[steam bot] poll', e.message)), 60 * 1000);
  // Old raw readings are only for staff checking the format: kept 3 days.
  setInterval(() => q("DELETE FROM presence_log WHERE at < now() - interval '3 days'").catch(() => {}), 6 * 60 * 60 * 1000);
}

// ---------- What the app shows ----------
// Money is tracked over the last 24 hours: every finished match, plus the one in progress.
export const TONIGHT_SQL = "at > now() - interval '24 hours'";
export const TONIGHT_ROWS = `SELECT user_id, money, true AS done FROM presence_results WHERE at > now() - interval '24 hours'
  UNION ALL SELECT user_id, open_money, false FROM live_presence WHERE opted_in AND open_money IS NOT NULL AND updated_at > now() - interval '24 hours'`;
export async function liveFor(userId) {
  const [row, tonight, last] = await Promise.all([
    one('SELECT * FROM live_presence WHERE user_id=$1', [userId]),
    one(`SELECT COALESCE(SUM(money),0)::int total, COUNT(*) FILTER (WHERE done)::int matches, COUNT(*) FILTER (WHERE done AND money > 0)::int wins
           FROM (${TONIGHT_ROWS}) t WHERE user_id=$1`, [userId]),
    one('SELECT money, at FROM presence_results WHERE user_id=$1 ORDER BY at DESC LIMIT 1', [userId]),
  ]);
  return { row, tonight, last };
}
export function publicStatus() {
  return { state: status.state, error: status.error, guard: status.state === 'guard' ? { domain: status.guardDomain } : null, steamId: status.steamId, name: status.name, since: status.since, pollWorks: status.pollWorks, requestsRefused: status.requestsRefused };
}
const botProfile = () => (status.steamId ? `https://steamcommunity.com/profiles/${status.steamId}` : '');

steamBotRouter.get('/users/:id/live', member, async (req, res) => {
  const u = await one('SELECT id, steam_id FROM users WHERE id=$1', [int(req.params.id)]);
  if (!u) throw new HttpError(404, 'Member not found.');
  const mine = u.id === req.user.id;
  const { row, tonight, last } = await liveFor(u.id);
  const on = !!row?.opted_in;
  const invite = mine && on && row?.friend !== 'friends' ? await inviteLinkFor(u.id).catch(() => '') : '';
  res.json({
    mine, on, friend: row?.friend || 'none', invite, bot: { online: status.state === 'online', profile: botProfile(), name: status.name },
    realSteam: /^\d{17}$/.test(u.steam_id || ''),
    live: on && row?.in_game && row?.text ? { inGame: true, text: row.text, money: row.money, result: row.result, at: row.updated_at } : null,
    last: on && last ? { money: last.money, at: last.at } : null,
    tonight: on ? tonight : null,
  });
});
// Switch live match money on (the bot sends a friend request) or off (it unfriends them).
steamBotRouter.put('/me/live', member, async (req, res) => {
  const want = bool(req.body?.on);
  const sid = req.user.steam_id;
  if (!/^\d{17}$/.test(sid || '')) throw new HttpError(400, 'Only real Steam accounts can show live match money.');
  await ensureRow(req.user.id, sid);
  await q('UPDATE live_presence SET opted_in=$2 WHERE user_id=$1', [req.user.id, want]);
  let note = '';
  let invite = '';
  if (want && status.state === 'online') {
    if (client.myFriends?.[sid] === REL().Friend) await setFriend(req.user.id, 'friends');
    else {
      invite = await inviteLinkFor(req.user.id).catch(() => '');
      await sendRequest(req.user.id, sid);
      note = invite ? 'Press "Add the bot on Steam" on your profile to add it as a friend.' : '';
    }
  } else if (want) note = 'The bot is offline right now: your invite link shows on your profile as soon as it\'s back.';
  if (!want) {
    await q("UPDATE live_presence SET friend='none', in_game=false, text='' WHERE user_id=$1", [req.user.id]);
    if (status.state === 'online') client.removeFriend(sid);
    const { setLive } = await import('./playing.js');
    setLive(req.user.id, null);
  }
  res.json({ ok: true, note, invite });
});

// ---------- Admin → Steam bot ----------
steamBotRouter.get('/admin/steambot', role('admin'), async (_req, res) => {
  const [counts, log, settings] = await Promise.all([
    one("SELECT COUNT(*) FILTER (WHERE opted_in)::int on_count, COUNT(*) FILTER (WHERE opted_in AND friend='friends')::int friends, COUNT(*) FILTER (WHERE opted_in AND friend='requested')::int pending, COUNT(*) FILTER (WHERE opted_in AND friend='add_bot')::int add_bot FROM live_presence"),
    q('SELECT l.at, l.text, l.raw, u.persona_name AS name FROM presence_log l JOIN users u ON u.id = l.user_id ORDER BY l.at DESC LIMIT 40'),
    Promise.all([flag('steam_bot_enabled'), flag('discord_post_big_wins'), setting('big_win_amount'), setting('discord_money_channel'), flag('discord_money_board')]),
  ]);
  const c = creds();
  res.json({
    status: publicStatus(), profile: botProfile(), counts, log,
    setup: { username: !!c.user, password: !!c.pass, sharedSecret: !!c.secret, savedLogin: !!(await loadToken().catch(() => '')) },
    settings: { enabled: settings[0], bigWins: settings[1], bigWinAmount: Number(settings[2]) || 50000, moneyChannel: String(settings[3] || ''), board: settings[4] },
  });
});
steamBotRouter.post('/admin/steambot/guard', role('admin'), async (req, res) => {
  const code = str(req.body?.code, 10).toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z0-9]{5}$/.test(code)) throw new HttpError(400, 'Steam Guard codes are 5 letters or numbers.');
  if (pendingSession) {
    // The same login that sent the email: a wrong code just says so (no new email).
    try {
      await pendingSession.submitSteamGuardCode(code);
    } catch (e) {
      if (e.eresult === 65 || e.eresult === 88) throw new HttpError(400, 'Steam says that code is wrong. Use the code from the newest Steam email.');
      throw new HttpError(400, `Steam didn't take the code: ${e.message}. Press Reconnect to get a new email.`);
    }
    setState('connecting');
  } else if (guardCallback) {
    const cb = guardCallback;
    guardCallback = null;
    setState('connecting');
    cb(code);
  } else throw new HttpError(400, "The bot isn't waiting for a code right now. Press Reconnect to start a new login.");
  await audit(req.user.id, 'steambot.guard', 'Steam Guard code entered');
  res.json({ ok: true });
});
steamBotRouter.post('/admin/steambot/reconnect', role('admin'), async (req, res) => {
  if (client) {
    try { client.logOff(); } catch { /* not logged on */ }
  }
  await audit(req.user.id, 'steambot.reconnect', '');
  setTimeout(() => startSteamBot().catch((e) => setState('error', { error: e.message })), 2000);
  res.json({ ok: true });
});
steamBotRouter.post('/admin/steambot/forget', role('admin'), async (req, res) => {
  await forgetToken();
  await audit(req.user.id, 'steambot.forget', 'Saved Steam sign-in removed');
  res.json({ ok: true });
});
steamBotRouter.put('/admin/steambot/settings', role('admin'), async (req, res) => {
  const b = req.body || {};
  const set = (k, v) => q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
  if ('enabled' in b) await set('steam_bot_enabled', String(bool(b.enabled)));
  if ('bigWins' in b) await set('discord_post_big_wins', String(bool(b.bigWins)));
  if ('board' in b) await set('discord_money_board', String(bool(b.board)));
  if ('bigWinAmount' in b) await set('big_win_amount', String(Math.max(1000, int(b.bigWinAmount, 50000))));
  if ('moneyChannel' in b) {
    const ch = str(b.moneyChannel, 30).replace(/\D/g, '');
    if (ch && !/^\d{15,22}$/.test(ch)) throw new HttpError(400, 'That isn\'t a Discord channel ID (right-click the channel → Copy Channel ID).');
    await set('discord_money_channel', ch);
  }
  const { clearSettingsCache } = await import('./db.js');
  clearSettingsCache();
  if ('enabled' in b && !bool(b.enabled) && client) {
    try { client.logOff(); } catch { /* already off */ }
    setState('off', { error: 'Switched off in Admin → Steam bot.' });
  } else if ('enabled' in b && bool(b.enabled) && status.state === 'off') startSteamBot().catch((e) => setState('error', { error: e.message }));
  await audit(req.user.id, 'steambot.settings', JSON.stringify(b));
  res.json({ ok: true });
});
