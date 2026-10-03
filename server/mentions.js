// @mentions in chat. Messages store mentions as tokens:
//   <@u:12>        a user (by id)
//   <@r:5>         everyone with a rank (by rank id)
//   <@g:admin>     a group: admin, mod, member (WPG members), pmc (guests), everyone
import { q } from './db.js';
import { canSeeChannel } from './util.js';

export const GROUPS = ['admin', 'mod', 'member', 'pmc', 'everyone'];
const TOKEN = /<@(u|r|g):([a-z0-9]{1,20})>/g;

export function parseMentions(body) {
  const out = { users: new Set(), ranks: new Set(), groups: new Set() };
  for (const [, kind, id] of String(body).matchAll(TOKEN)) {
    if (kind === 'u' && /^\d+$/.test(id)) out.users.add(Number(id));
    if (kind === 'r' && /^\d+$/.test(id)) out.ranks.add(Number(id));
    if (kind === 'g' && GROUPS.includes(id)) out.groups.add(id);
  }
  return out;
}

// Users mentioned by id in these messages, so the client can show their names.
export function mentionedUserIds(messages) {
  const ids = new Set();
  for (const m of messages) for (const id of parseMentions(m.body).users) ids.add(id);
  return [...ids];
}

// Everyone who should be notified: active users who can see the channel (not the author).
export async function mentionRecipients(mentions, channel, authorId) {
  const { users, ranks, groups } = mentions;
  if (!users.size && !ranks.size && !groups.size) return [];
  const rows = await q(
    `SELECT id, role, membership FROM users
      WHERE status = 'active' AND id <> $1 AND (
            id = ANY($2)
         OR (rank_id = ANY($3) AND membership <> 'pmc')
         OR ($4 AND role = 'admin')
         OR ($5 AND role = 'mod')
         OR ($6 AND membership <> 'pmc')
         OR ($7 AND membership = 'pmc')
         OR $8)
      LIMIT 1000`,
    [
      authorId, [...users], [...ranks],
      groups.has('admin'), groups.has('mod'), groups.has('member'), groups.has('pmc'), groups.has('everyone'),
    ],
  );
  return rows.filter((u) => canSeeChannel(u, channel)).map((u) => u.id);
}

const GROUP_NAMES = { admin: 'Admins', mod: 'Mods', member: 'Members', pmc: 'PMC', everyone: 'everyone' };

// Message text with tokens swapped for readable names (for notifications).
export async function plainText(body) {
  const m = parseMentions(body);
  const users = m.users.size ? await q('SELECT id, persona_name FROM users WHERE id = ANY($1)', [[...m.users]]) : [];
  const ranks = m.ranks.size ? await q('SELECT id, name FROM ranks WHERE id = ANY($1)', [[...m.ranks]]) : [];
  const un = new Map(users.map((u) => [String(u.id), u.persona_name]));
  const rn = new Map(ranks.map((r) => [String(r.id), r.name]));
  return String(body).replace(TOKEN, (_, kind, id) => {
    if (kind === 'u') return `@${un.get(id) || 'unknown'}`;
    if (kind === 'r') return `@${rn.get(id) || 'rank'}`;
    return `@${GROUP_NAMES[id] || id}`;
  });
}
