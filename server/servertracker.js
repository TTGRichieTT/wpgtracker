// Server leaderboard tracker. Every 30 seconds it reads each RCON-enabled game server and adds up
// kills, deaths, matches, wins, losses and playtime for every player (members and guests).
//  - RCON kill/death counters are per match, so we add the change since the last check.
//  - A new match is spotted when the map/mode changes or the team scores drop back towards zero;
//    players who were in the finished match get a win (their team had the top score) or a loss.
//  - Members' totals also go to their career page and WPG XP.
import { q, one } from './db.js';
import { rcon, queuedMap, restoreRotation } from './servers.js';
import { recalcXp } from './steam.js';
import { bus } from './bus.js';

const POLL_MS = 30 * 1000;
const RECENT_MS = 3 * 60 * 1000; // must have been seen this recently at match end to get a win/loss
const MEMBER_PUSH_MS = 5 * 60 * 1000;

const totalScore = (st) => (st?.factionScores || []).reduce((n, f) => n + (Number(f.score) || 0), 0);
const matchKey = (st) => `${st?.map || ''}|${(st?.experiences || []).join('+')}`;

// Ends the match in `state`: hands out wins and losses.
async function finishMatch(serverId, state) {
  const scores = state.scores || [];
  const best = Math.max(0, ...scores.map((f) => Number(f.score) || 0));
  const winners = scores.filter((f) => (Number(f.score) || 0) === best);
  if (best <= 0 || winners.length !== 1) return; // empty or tied match: no result
  const winner = winners[0].name;
  for (const [sid, p] of Object.entries(state.players || {})) {
    if (!p.faction || Date.now() - (p.seen || 0) > RECENT_MS) continue;
    const won = p.faction === winner;
    await q(`UPDATE server_players SET ${won ? 'wins = wins + 1' : 'losses = losses + 1'} WHERE server_id=$1 AND steam_id=$2`, [serverId, sid]);
  }
}

// First time we see a real Steam ID for a name imported earlier, merge the imported totals in.
async function claimImported(serverId, sid, name) {
  const old = await one('SELECT * FROM server_players WHERE server_id=$1 AND steam_id=$2', [serverId, `name:${name}`]);
  if (!old) return;
  await q(
    `UPDATE server_players SET kills=kills+$3, deaths=deaths+$4, matches=matches+$5, wins=wins+$6, losses=losses+$7, playtime_s=playtime_s+$8
      WHERE server_id=$1 AND steam_id=$2`,
    [serverId, sid, old.kills, old.deaths, old.matches, old.wins, old.losses, old.playtime_s],
  );
  await q('DELETE FROM server_players WHERE server_id=$1 AND steam_id=$2', [serverId, `name:${name}`]);
}

export async function pollServer(server) {
  const [status, list] = await Promise.all([rcon(server, 'GET', '/status'), rcon(server, 'GET', '/players')]);
  const players = Array.isArray(list?.players) ? list.players : [];
  const row = await one('SELECT state FROM server_track_state WHERE server_id=$1', [server.id]);
  let state = row?.state && row.state.key ? row.state : { key: matchKey(status), total: totalScore(status), scores: status.factionScores || [], players: {}, at: Date.now() };

  const now = Date.now();
  const newMatch = state.key !== matchKey(status) || totalScore(status) + 5 < (state.total || 0);
  // A queued map has started (or it's been hours): put the server's normal rotation back.
  const queued = await queuedMap(server.id);
  if (queued && ((newMatch && status.map === queued.map && now - queued.at > 60 * 1000) || now - queued.at > 6 * 60 * 60 * 1000)) {
    await restoreRotation(server).catch((e) => console.warn('[tracker] rotation restore failed', e.message));
  }
  if (newMatch) {
    await finishMatch(server.id, state);
    state = { key: matchKey(status), total: 0, scores: [], players: {}, at: now };
  }
  const gap = Math.min(Math.max(0, now - (state.at || now)), 90 * 1000); // cap: don't credit long outages

  for (const p of players) {
    const sid = String(p.steamId || '');
    if (!/^\d{17}$/.test(sid)) continue;
    const name = String(p.name || '').slice(0, 64);
    const prev = state.players[sid];
    const kills = Number(p.kills) || 0;
    const deaths = Number(p.deaths) || 0;
    const dk = prev ? (kills >= prev.kills ? kills - prev.kills : kills) : kills;
    const dd = prev ? (deaths >= prev.deaths ? deaths - prev.deaths : deaths) : deaths;
    const secs = prev ? Math.round(gap / 1000) : 0;
    const exists = await one('SELECT 1 FROM server_players WHERE server_id=$1 AND steam_id=$2', [server.id, sid]);
    await q(
      `INSERT INTO server_players (server_id, steam_id, name, kills, deaths, matches, playtime_s, last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (server_id, steam_id) DO UPDATE SET name=EXCLUDED.name, kills=server_players.kills+EXCLUDED.kills,
         deaths=server_players.deaths+EXCLUDED.deaths, matches=server_players.matches+EXCLUDED.matches,
         playtime_s=server_players.playtime_s+EXCLUDED.playtime_s, last_seen=now()`,
      [server.id, sid, name, dk, dd, prev ? 0 : 1, secs],
    );
    if (!exists) await claimImported(server.id, sid, name);
    state.players[sid] = { kills, deaths, faction: p.faction || '', seen: now };
  }
  state.scores = status.factionScores || [];
  state.total = totalScore(status);
  state.at = now;
  await q(
    `INSERT INTO server_track_state (server_id, state, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (server_id) DO UPDATE SET state=EXCLUDED.state, updated_at=now()`,
    [server.id, JSON.stringify(state)],
  );
  if (players.length) bus.emit('server:board', server.id);
  return { players: players.length, newMatch };
}

// Copies members' server totals (all our servers combined) to their career page stats and WPG XP.
export async function pushMemberStats() {
  const rows = await q(
    `SELECT u.id, SUM(sp.kills)::int k, SUM(sp.deaths)::int d, SUM(sp.matches)::int m, SUM(sp.wins)::int w, SUM(sp.losses)::int l,
            SUM(sp.playtime_s)::int t
       FROM server_players sp JOIN users u ON u.steam_id = sp.steam_id GROUP BY u.id`,
  );
  const defs = new Set((await q('SELECT key FROM stat_defs')).map((r) => r.key));
  for (const r of rows) {
    const server = { kills: r.k, deaths: r.d, kd: r.d ? +(r.k / r.d).toFixed(2) : r.k };
    await q(
      `INSERT INTO wardogs_stats (user_id, server, server_synced) VALUES ($1,$2,now())
       ON CONFLICT (user_id) DO UPDATE SET server=EXCLUDED.server, server_synced=now()`,
      [r.id, JSON.stringify(server)],
    );
    for (const [key, value] of [['matches', r.m], ['wins', r.w], ['losses', r.l], ['playtime_minutes', Math.floor(r.t / 60)]]) {
      if (!defs.has(key)) continue;
      await q(
        `INSERT INTO user_stats (user_id, key, value, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (user_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [r.id, key, value],
      );
    }
    await recalcXp(r.id).catch(() => {});
  }
}

export function startServerTracker() {
  let lastPush = 0;
  const tick = async () => {
    try {
      const servers = await q("SELECT * FROM game_servers WHERE enabled = true AND rcon_url <> '' AND rcon_password <> ''");
      let matchEnded = false;
      for (const s of servers) {
        const r = await pollServer(s).catch((e) => { console.warn('[tracker]', s.name || s.id, e.message); return null; });
        if (r?.newMatch) matchEnded = true;
      }
      if (servers.length && (matchEnded || Date.now() - lastPush > MEMBER_PUSH_MS)) {
        lastPush = Date.now();
        await pushMemberStats();
      }
    } catch (e) {
      console.warn('[tracker] loop error', e.message);
    }
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, 15 * 1000);
}
