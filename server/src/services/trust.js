// Trust score: private, 0..100, starts at 50. It nudges matchmaking (see matchmaking.js)
// and three moderation warnings suspend an account pending admin review.
import { query, one } from '../db.js';
import { audit } from './audit.js';

export const TRUST_EVENTS = {
  conversationCompleted: +2,  // stayed past the safe period and ended normally
  revealed: +3,               // both people chose to reveal
  friendAccepted: +2,
  blocked: -5,
  aiWarning: -8,
  aiSevere: -15,
  reportUpheld: -15,
};

export const LOW_TRUST = 25;
export const MAX_WARNINGS = 3;

export async function adjustTrust(userId, delta, reason) {
  const row = await one(
    'UPDATE users SET trust_score = GREATEST(0, LEAST(100, trust_score + $2)) WHERE id = $1 RETURNING trust_score',
    [userId, delta],
  );
  await audit('trust.adjust', { actorId: null, meta: { userId, delta, reason, score: row?.trust_score } });
  return row?.trust_score;
}

// Records a warning; returns true when this warning suspended the account.
export async function addWarning(userId, reason) {
  const row = await one(
    `UPDATE users SET warnings = warnings + 1,
       status = CASE WHEN warnings + 1 >= $2 AND status = 'active' THEN 'suspended' ELSE status END
     WHERE id = $1 RETURNING warnings, status`,
    [userId, MAX_WARNINGS],
  );
  await audit('user.warning', { meta: { userId, reason, warnings: row?.warnings } });
  if (row?.status === 'suspended' && row.warnings === MAX_WARNINGS) {
    await audit('user.auto_suspend', { meta: { userId, warnings: row.warnings } });
    return true;
  }
  return false;
}

export async function isBlockedEitherWay(a, b) {
  const { rowCount } = await query(
    'SELECT 1 FROM blocks WHERE (blocker = $1 AND blocked = $2) OR (blocker = $2 AND blocked = $1)',
    [a, b],
  );
  return rowCount > 0;
}
