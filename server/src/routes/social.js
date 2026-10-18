// Chat history, reporting, blocking and friends. Everything a student does to another
// student is addressed by chat session id, so anonymous partners never learn user ids.
import { Router } from 'express';
import { z } from 'zod';
import { query, one, tx } from '../db.js';
import { wrap, parse, HttpError, clientIp } from '../http.js';
import { REPORT_REASONS } from '../constants.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getSession, side, partnerId, endSession } from '../services/chat.js';
import { adjustTrust, TRUST_EVENTS } from '../services/trust.js';
import { audit } from '../services/audit.js';
import { emitToUser } from '../services/presence.js';

const router = Router();
router.use(requireAuth, requireRole('student'));

const uuid = z.string().uuid();

async function mySession(sessionId, userId) {
  const session = await getSession(sessionId);
  if (!session || !side(session, userId)) throw new HttpError(404, 'Conversation not found.');
  return session;
}

router.get('/sessions', wrap(async (req, res) => {
  const me = req.user.id;
  const { rows } = await query(
    `SELECT s.*, 
       CASE WHEN s.user_a = $1 THEN s.alias_a ELSE s.alias_b END AS my_alias,
       CASE WHEN s.user_a = $1 THEN s.alias_b ELSE s.alias_a END AS partner_alias,
       CASE WHEN s.revealed_at IS NOT NULL THEN p.display_name END AS partner_name,
       EXISTS (SELECT 1 FROM reports r WHERE r.session_id = s.id AND r.reporter_id = $1) AS reported,
       EXISTS (SELECT 1 FROM blocks b WHERE b.blocker = $1 AND b.blocked = p.id) AS blocked,
       (SELECT f.status FROM friendships f
          WHERE LEAST(f.requester, f.addressee) = LEAST($1::uuid, p.id) AND GREATEST(f.requester, f.addressee) = GREATEST($1::uuid, p.id)) AS friendship
     FROM chat_sessions s
     JOIN users p ON p.id = CASE WHEN s.user_a = $1 THEN s.user_b ELSE s.user_a END
     WHERE s.user_a = $1 OR s.user_b = $1
     ORDER BY s.started_at DESC LIMIT 30`,
    [me],
  );
  res.json(rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    alias: r.my_alias,
    partnerAlias: r.partner_alias,
    partnerName: r.partner_name,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    endReason: r.end_reason,
    revealed: Boolean(r.revealed_at),
    reported: r.reported,
    blocked: r.blocked,
    friendship: r.friendship,
  })));
}));

router.post('/reports', wrap(async (req, res) => {
  const body = parse(z.object({
    sessionId: uuid,
    reason: z.enum(REPORT_REASONS),
    details: z.string().trim().max(1000).optional().default(''),
  }), req.body);
  const session = await mySession(body.sessionId, req.user.id);
  const reported = partnerId(session, req.user.id);
  const dup = await one('SELECT id FROM reports WHERE session_id = $1 AND reporter_id = $2', [session.id, req.user.id]);
  if (dup) throw new HttpError(409, 'You already reported this conversation.');
  const severity = ['harassment', 'hate speech', 'sexual content'].includes(body.reason) ? 'medium' : 'low';
  const report = await one(
    `INSERT INTO reports (reporter_id, reported_id, session_id, source, reason, details, severity)
     VALUES ($1, $2, $3, 'user', $4, $5, $6) RETURNING id`,
    [req.user.id, reported, session.id, body.reason, body.details, severity],
  );
  await audit('report.created', { actorId: req.user.id, ip: clientIp(req), meta: { reportId: report.id, reason: body.reason } });
  res.status(201).json({ ok: true, id: report.id });
}));

router.get('/blocks', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT b.session_id, b.created_at,
       CASE WHEN s.user_a = $1 THEN s.alias_b ELSE s.alias_a END AS alias,
       CASE WHEN s.revealed_at IS NOT NULL THEN u.display_name END AS name
     FROM blocks b
     JOIN users u ON u.id = b.blocked
     LEFT JOIN chat_sessions s ON s.id = b.session_id
     WHERE b.blocker = $1 ORDER BY b.created_at DESC`,
    [req.user.id],
  );
  res.json(rows.map((r) => ({ sessionId: r.session_id, alias: r.alias, name: r.name, blockedAt: r.created_at })));
}));

router.post('/blocks', wrap(async (req, res) => {
  const body = parse(z.object({ sessionId: uuid }), req.body);
  const session = await mySession(body.sessionId, req.user.id);
  const other = partnerId(session, req.user.id);
  const { rowCount } = await query(
    'INSERT INTO blocks (blocker, blocked, session_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [req.user.id, other, session.id],
  );
  if (rowCount) {
    await adjustTrust(other, TRUST_EVENTS.blocked, 'blocked by a user');
    // Blocking also ends any friendship between the two.
    await query(
      'DELETE FROM friendships WHERE LEAST(requester, addressee) = LEAST($1::uuid, $2::uuid) AND GREATEST(requester, addressee) = GREATEST($1::uuid, $2::uuid)',
      [req.user.id, other],
    );
    await audit('user.block', { actorId: req.user.id, ip: clientIp(req), meta: { sessionId: session.id } });
  }
  if (!session.ended_at) await endSession(session.id, { byUserId: req.user.id, reason: 'blocked' });
  res.status(201).json({ ok: true });
}));

router.delete('/blocks/:sessionId', wrap(async (req, res) => {
  const sessionId = parse(uuid, req.params.sessionId);
  await query('DELETE FROM blocks WHERE blocker = $1 AND session_id = $2', [req.user.id, sessionId]);
  res.json({ ok: true });
}));

router.get('/friends', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT f.id, f.status, f.created_at, f.requester = $1 AS outgoing,
       u.display_name, u.bio, u.interests, c.name AS college
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.requester = $1 THEN f.addressee ELSE f.requester END
     LEFT JOIN colleges c ON c.id = u.college_id
     WHERE (f.requester = $1 OR f.addressee = $1) AND f.status <> 'declined'
     ORDER BY f.created_at DESC`,
    [req.user.id],
  );
  const view = (r) => ({ id: r.id, displayName: r.display_name, college: r.college, bio: r.bio, interests: r.interests, since: r.created_at });
  res.json({
    friends: rows.filter((r) => r.status === 'accepted').map(view),
    incoming: rows.filter((r) => r.status === 'pending' && !r.outgoing).map(view),
    outgoing: rows.filter((r) => r.status === 'pending' && r.outgoing).map(view),
  });
}));

// Friend requests are only possible after both people chose to reveal.
router.post('/friends/requests', wrap(async (req, res) => {
  const body = parse(z.object({ sessionId: uuid }), req.body);
  const session = await mySession(body.sessionId, req.user.id);
  if (!session.revealed_at) throw new HttpError(400, 'You can add someone as a friend once you have both revealed.');
  const other = partnerId(session, req.user.id);
  const existing = await one(
    `SELECT id, status, requester FROM friendships
     WHERE LEAST(requester, addressee) = LEAST($1::uuid, $2::uuid) AND GREATEST(requester, addressee) = GREATEST($1::uuid, $2::uuid)`,
    [req.user.id, other],
  );
  if (existing?.status === 'accepted') throw new HttpError(409, 'You are already friends.');
  if (existing?.status === 'pending' && existing.requester === other) {
    // They already asked us: treat this as accepting.
    await acceptFriendship(existing.id, req.user.id);
    return res.json({ ok: true, status: 'accepted' });
  }
  if (existing?.status === 'pending') throw new HttpError(409, 'Friend request already sent.');
  if (existing) await query('DELETE FROM friendships WHERE id = $1', [existing.id]);
  await query(
    'INSERT INTO friendships (requester, addressee, session_id) VALUES ($1, $2, $3)',
    [req.user.id, other, session.id],
  );
  emitToUser(other, 'friend:request', { from: req.user.display_name });
  res.status(201).json({ ok: true, status: 'pending' });
}));

async function acceptFriendship(id, userId) {
  const f = await tx(async (c) => {
    const { rows } = await c.query(
      "UPDATE friendships SET status = 'accepted', responded_at = now() WHERE id = $1 AND addressee = $2 AND status = 'pending' RETURNING *",
      [id, userId],
    );
    return rows[0];
  });
  if (!f) throw new HttpError(404, 'Friend request not found.');
  await adjustTrust(f.requester, TRUST_EVENTS.friendAccepted, 'friend request accepted');
  await adjustTrust(f.addressee, TRUST_EVENTS.friendAccepted, 'friend request accepted');
  emitToUser(f.requester, 'friend:accepted', {});
  return f;
}

router.post('/friends/requests/:id/accept', wrap(async (req, res) => {
  await acceptFriendship(parse(uuid, req.params.id), req.user.id);
  res.json({ ok: true });
}));

router.post('/friends/requests/:id/decline', wrap(async (req, res) => {
  const { rowCount } = await query(
    "UPDATE friendships SET status = 'declined', responded_at = now() WHERE id = $1 AND addressee = $2 AND status = 'pending'",
    [parse(uuid, req.params.id), req.user.id],
  );
  if (!rowCount) throw new HttpError(404, 'Friend request not found.');
  res.json({ ok: true });
}));

router.delete('/friends/:id', wrap(async (req, res) => {
  await query('DELETE FROM friendships WHERE id = $1 AND (requester = $2 OR addressee = $2)', [parse(uuid, req.params.id), req.user.id]);
  res.json({ ok: true });
}));

export default router;
