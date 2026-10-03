// Server leaderboard tracker. Every 30 seconds it reads each RCON-enabled game server and adds up
// kills, deaths, matches, wins, losses and playtime for every player (members and guests).
//  - RCON kill/death counters are per match, so we add the change since the last check.
//  - A new match is spotted when the map/mode changes or the team scores drop back towards zero;
//    players who were in the finished match get a win (their team had the top score) or a loss.
//  - Members' totals also go to their career page and WPG XP.
//  - On servers ticked "Earns WPG XP", each finished match also gives (or takes) WPG XP (wpgxp.js).
import { q, one } from './db.js';
import { rcon, queuedMap, restoreRotation } from './servers.js';
import { recalcXp } from './steam.js';
import { bus } from './bus.js';
import { watchPoll } from './cheatwatch.js';
import { awardMatch } from './wpgxp.js';

const POLL_MS = 30 * 1000;
const RECENT_MS = 3 * 60 * 1000; // must have been seen this recently at match end to get a win/loss
const HEALTHY_GAP_MS = 2 * 60 * 1000; // a longer gap between checks (app restart, host outage) = can't tell who left
const MEMBER_PUSH_MS = 5 * 60 * 1000;

const totalScore = (st) => (st?.factionScores || []).reduce((n, f) => n + (Number(f.score) || 0), 0);
const matchKey = (st) => `${st?.map || ''}|${(st?.experiences || []).join('+')}`;

// Ends the match in `state`: hands out wins and losses (none for an empty or tied match), keeps
// one row per player of how their match went (for cheat watch) and works out WPG XP.
async function finishMatch(server, state) {
  const serverId = server.id;
  const scores = state.scores || [];
  const best = Math.max(0, ...scores.map((f) => Number(f.score) || 0));
  const winners = scores.filter((f) => (Number(f.score) || 0) === best);
  const winner = best > 0 && winners.length === 1 ? winners[0].name : null;
  const played = [];
  for (const [sid, p] of Object.entries(state.players || {})) {
    const stayed = p.faction && Date.now() - (p.seen || 0) <= RECENT_MS;
    const won = winner && stayed ? p.faction === winner : null;
    // Kills and deaths in this match (mk/md add up across reconnects; older saved states only had the counters).
    const kills = p.mk ?? p.kills ?? 0;
    const deaths = p.md ?? p.deaths ?? 0;
    if (won !== null) {
      await q(`UPDATE server_players SET ${won ? 'wins = wins + 1' : 'losses = losses + 1'} WHERE server_id=$1 AND steam_id=$2`, [serverId, sid]);
    }
    if ((p.secs || 0) >= 60) {
      await q(
        'INSERT INTO match_players (server_id, steam_id, name, faction, kills, deaths, seconds, won) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [serverId, sid, String(p.name || '').slice(0, 64), p.faction || '', kills, deaths, p.secs, won],
      ).catch((e) => console.warn('[tracker] match row', e.message));
      played.push({ steam_id: sid, name: String(p.name || '').slice(0, 64), secs: p.secs, kills, deaths, stayed: !!stayed, won });
    }
  }
  if (server.wpg_xp) {
    const healthy = (state.maxGap || 0) <= HEALTHY_GAP_MS && Date.now() - (state.at || 0) <= HEALTHY_GAP_MS;
    await awardMatch(serverId, played, { winner: !!winner, scored: best > 0, healthy })
      .catch((e) => console.warn('[tracker] WPG XP', e.message));
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
  const before = state.players || {}; // who was on at the last check (for cheat watch's join alerts)
  const newMatch = state.key !== matchKey(status) || totalScore(status) + 5 < (state.total || 0);
  // A queued map has started (or it's been hours): put the server's normal rotation back.
  const queued = await queuedMap(server.id);
  if (queued && ((newMatch && status.map === queued.map && now - queued.at > 60 * 1000) || now - queued.at > 6 * 60 * 60 * 1000)) {
    await restoreRotation(server).catch((e) => console.warn('[tracker] rotation restore failed', e.message));
  }
  if (newMatch) {
    await finishMatch(server, state);
    state = { key: matchKey(status), total: 0, scores: [], players: {}, at: now, maxGap: 0 };
  }
  const rawGap = Math.max(0, now - (state.at || now));
  state.maxGap = Math.max(state.maxGap || 0, rawGap); // longest time this match went unwatched
  const gap = Math.min(rawGap, 90 * 1000); // cap: don't credit long outages

  // Everyone's changes go to the database in one trip (not two per player), so a busy server doesn't
  // keep the database tied up every 30 seconds.
  const rows = [];
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
    rows.push({ steam_id: sid, name, kills: dk, deaths: dd, matches: prev ? 0 : 1, playtime_s: secs });
    // secs: time in this match; hist: kills over the last few minutes (for live spike alerts).
    const hist = [...(prev?.hist || []).filter(([t]) => now - t <= 7 * 60 * 1000), [now, kills]];
    state.players[sid] = {
      kills, deaths, mk: (prev?.mk ?? prev?.kills ?? 0) + dk, md: (prev?.md ?? prev?.deaths ?? 0) + dd,
      faction: p.faction || '', seen: now, name, secs: (prev?.secs || 0) + secs, hist,
    };
  }
  if (rows.length) {
    // xmax = 0 marks rows that were inserted (first time we've seen this player here).
    const written = await q(
      `INSERT INTO server_players (server_id, steam_id, name, kills, deaths, matches, playtime_s, last_seen)
       SELECT $1, steam_id, name, kills, deaths, matches, playtime_s, now()
         FROM jsonb_to_recordset($2::jsonb) AS x(steam_id text, name text, kills int, deaths int, matches int, playtime_s int)
       ON CONFLICT (server_id, steam_id) DO UPDATE SET name=EXCLUDED.name, kills=server_players.kills+EXCLUDED.kills,
         deaths=server_players.deaths+EXCLUDED.deaths, matches=server_players.matches+EXCLUDED.matches,
         playtime_s=server_players.playtime_s+EXCLUDED.playtime_s, last_seen=now()
       RETURNING steam_id, name, (xmax = 0) AS inserted`,
      [server.id, JSON.stringify(rows)],
    );
    for (const w of written) if (w.inserted) await claimImported(server.id, w.steam_id, w.name);
  }
  await watchPoll(server, players, { players: before }, state).catch((e) => console.warn('[tracker] cheat watch', e.message));
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
