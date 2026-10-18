// ChatSession lifecycle shared by the socket handlers and the HTTP routes.
import { config } from '../config.js';
import { one, query } from '../db.js';
import { getIo, emitToUser } from './presence.js';
import { adjustTrust, TRUST_EVENTS } from './trust.js';

export const room = (sessionId) => `s:${sessionId}`;

export function side(session, userId) {
  if (session.user_a === userId) return 'a';
  if (session.user_b === userId) return 'b';
  return null;
}

export function partnerId(session, userId) {
  return session.user_a === userId ? session.user_b : session.user_a;
}

export function safePeriodEndsAt(session) {
  return new Date(new Date(session.started_at).getTime() + config.safePeriodSeconds * 1000);
}

export async function getSession(sessionId) {
  return one('SELECT * FROM chat_sessions WHERE id = $1', [sessionId]);
}

export async function getActiveSession(userId) {
  return one(
    'SELECT * FROM chat_sessions WHERE (user_a = $1 OR user_b = $1) AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
    [userId],
  );
}

async function publicProfile(userId) {
  return one(
    `SELECT u.display_name, u.bio, u.interests, u.personality, c.name AS college
     FROM users u LEFT JOIN colleges c ON c.id = u.college_id WHERE u.id = $1`,
    [userId],
  );
}

// What one participant is allowed to see about a session. The partner's user id and
// identity never leave the server until both have consented.
export async function sessionView(session, userId) {
  const me = side(session, userId);
  const them = me === 'a' ? 'b' : 'a';
  const partner = await publicProfile(session[`user_${them}`]);
  const view = {
    id: session.id,
    mode: session.mode,
    filter: session.filter,
    alias: session[`alias_${me}`],
    partnerAlias: session[`alias_${them}`],
    partnerTags: { interests: partner?.interests ?? [], personality: partner?.personality ?? [] },
    startedAt: session.started_at,
    safePeriodEndsAt: safePeriodEndsAt(session),
    safePeriodSeconds: config.safePeriodSeconds,
    consent: { me: session[`consent_${me}`], partner: session[`consent_${them}`] },
    revealed: Boolean(session.revealed_at),
    endedAt: session.ended_at,
    endReason: session.end_reason,
  };
  if (session.revealed_at && partner) {
    view.partner = { displayName: partner.display_name, college: partner.college, bio: partner.bio };
  }
  return view;
}

export async function sessionMessages(session, userId, limit = 200) {
  const { rows } = await query(
    `SELECT id, sender_id, body, deleted, created_at FROM messages
     WHERE session_id = $1 AND blocked = false ORDER BY id DESC LIMIT $2`,
    [session.id, limit],
  );
  return rows.reverse().map((m) => messageView(m, userId));
}

export function messageView(m, userId) {
  return {
    id: String(m.id),
    mine: m.sender_id === userId,
    body: m.deleted ? '' : m.body,
    deleted: m.deleted,
    at: m.created_at,
  };
}

export async function endSession(sessionId, { byUserId = null, reason = 'ended' } = {}) {
  const session = await one(
    `UPDATE chat_sessions SET ended_at = now(), ended_by = $2, end_reason = $3
     WHERE id = $1 AND ended_at IS NULL RETURNING *`,
    [sessionId, byUserId, reason],
  );
  if (!session) return null;

  for (const uid of [session.user_a, session.user_b]) {
    emitToUser(uid, 'chat:ended', { sessionId, reason, byYou: uid === byUserId });
  }
  getIo()?.in(room(sessionId)).socketsLeave(room(sessionId));

  // Reward conversations that lasted past the safe period and ended without trouble.
  const lasted = Date.now() - new Date(session.started_at).getTime() >= config.safePeriodSeconds * 1000;
  if (lasted && ['ended', 'disconnected'].includes(reason)) {
    const { rowCount } = await query('SELECT 1 FROM reports WHERE session_id = $1', [sessionId]);
    if (rowCount === 0) {
      await adjustTrust(session.user_a, TRUST_EVENTS.conversationCompleted, 'conversation completed');
      await adjustTrust(session.user_b, TRUST_EVENTS.conversationCompleted, 'conversation completed');
    }
  }
  return session;
}

export async function endActiveSessionFor(userId, reason) {
  const active = await getActiveSession(userId);
  if (active) await endSession(active.id, { byUserId: userId, reason });
}

// Disconnects every socket of a user (used on suspension, ban or logout).
export async function kickUser(userId, event = 'account:signed-out', payload = {}) {
  const io = getIo();
  if (!io) return;
  io.to(`u:${userId}`).emit(event, payload);
  io.in(`u:${userId}`).disconnectSockets(true);
}
