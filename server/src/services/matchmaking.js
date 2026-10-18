// MatchmakingEngine. Waiting tickets live in Redis so the queue survives a restart of
// any one connection; a short Redis lock serialises matching so two people can never
// be paired with the same partner.
import crypto from 'node:crypto';
import { redis } from '../redis.js';
import { query, one } from '../db.js';
import { aliasPair } from './aliases.js';
import { LOW_TRUST } from './trust.js';

const WAITING = 'mm:waiting';
const LOCK = 'mm:lock';

async function withLock(fn) {
  const token = crypto.randomUUID();
  for (let i = 0; i < 50; i++) {
    if ((await redis.set(LOCK, token, 'PX', 3000, 'NX')) === 'OK') {
      try {
        return await fn();
      } finally {
        // Release only our own lock.
        await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", 1, LOCK, token);
      }
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('matchmaking is busy, please try again');
}

const overlap = (a, b) => a.filter((x) => b.includes(x)).length;

// Higher is better; null means the pair is not allowed for this mode/filter.
export function compatibility(me, other, now = Date.now()) {
  if (me.userId === other.userId) return null;
  if (me.mode !== other.mode) return null;
  if (me.mode === 'campus' && me.collegeId !== other.collegeId) return null;
  if (me.mode === 'cross' && me.collegeId === other.collegeId) return null;

  const sharedInterests = overlap(me.interests, other.interests);
  const sharedTraits = overlap(me.personality, other.personality);
  // Each side's filter must be satisfied for both of them.
  for (const t of [me, other]) {
    if (t.filter === 'interest' && sharedInterests === 0) return null;
    if (t.filter === 'personality' && sharedTraits === 0) return null;
  }

  let score = 0;
  if (me.filter === 'interest' || other.filter === 'interest') score += sharedInterests * 10;
  if (me.filter === 'personality' || other.filter === 'personality') score += sharedTraits * 10;
  if (me.filter === 'mystery' && other.filter === 'mystery') score += crypto.randomInt(0, 10);
  // Trust: similar scores pair up, and well-behaved users are kept away from low-trust ones.
  score -= Math.abs(me.trust - other.trust) / 5;
  if ((me.trust < LOW_TRUST) !== (other.trust < LOW_TRUST)) score -= 25;
  // Fairness: the longer someone has waited, the sooner they get matched.
  score += Math.min(30, (now - other.joinedAt) / 1000);
  return score;
}

async function blockedSet(userId) {
  const { rows } = await query(
    'SELECT blocked AS id FROM blocks WHERE blocker = $1 UNION SELECT blocker AS id FROM blocks WHERE blocked = $1',
    [userId],
  );
  return new Set(rows.map((r) => r.id));
}

export async function leaveQueue(userId) {
  await redis.hdel(WAITING, userId);
}

export async function isWaiting(userId) {
  return (await redis.hexists(WAITING, userId)) === 1;
}

// Returns { session } when a partner was found, or { waiting: true }.
export async function joinQueue(user, { mode, filter }) {
  const ticket = {
    userId: user.id,
    mode,
    filter,
    collegeId: user.college_id,
    interests: user.interests || [],
    personality: user.personality || [],
    trust: user.trust_score,
    joinedAt: Date.now(),
  };
  const blocked = await blockedSet(user.id);

  return withLock(async () => {
    const all = await redis.hgetall(WAITING);
    let best = null;
    for (const raw of Object.values(all)) {
      const other = JSON.parse(raw);
      if (blocked.has(other.userId)) continue;
      const score = compatibility(ticket, other);
      if (score !== null && (!best || score > best.score)) best = { other, score };
    }
    if (!best) {
      await redis.hset(WAITING, user.id, JSON.stringify(ticket));
      return { waiting: true };
    }
    await redis.hdel(WAITING, best.other.userId, user.id);
    const [aliasA, aliasB] = aliasPair();
    const session = await one(
      `INSERT INTO chat_sessions (user_a, user_b, mode, filter, alias_a, alias_b)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [best.other.userId, user.id, mode, best.other.filter === 'mystery' ? filter : best.other.filter, aliasA, aliasB],
    );
    return { session };
  });
}

export async function clearQueue() {
  await redis.del(WAITING, LOCK);
}
