// Real-time layer: matchmaking queue, anonymous chat, typing, consent-based reveal.
import { Server } from 'socket.io';
import { parseCookie } from 'cookie';
import { z } from 'zod';
import { config } from './config.js';
import { query, one } from './db.js';
import { redis } from './redis.js';
import { COOKIE, userFromToken } from './middleware/auth.js';
import { MODES, FILTERS } from './constants.js';
import { setIo, emitToUser } from './services/presence.js';
import { joinQueue, leaveQueue } from './services/matchmaking.js';
import {
  room, side, partnerId, getSession, getActiveSession, sessionView, sessionMessages,
  messageView, endSession, safePeriodEndsAt, kickUser,
} from './services/chat.js';
import { classify, actionFor } from './services/moderation.js';
import { adjustTrust, addWarning, TRUST_EVENTS } from './services/trust.js';
import { audit } from './services/audit.js';

const DISCONNECT_GRACE_MS = 20_000;
const pendingDisconnects = new Map(); // userId -> timeout

const joinSchema = z.object({ mode: z.enum(MODES), filter: z.enum(FILTERS) });
const sendSchema = z.object({ sessionId: z.string().uuid(), body: z.string().trim().min(1).max(config.maxMessageLength) });
const idSchema = z.object({ sessionId: z.string().uuid() });

async function rateLimited(userId) {
  const key = `rl:msg:${userId}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 5);
  return n > 8; // at most 8 messages per 5 seconds
}

async function recentBodies(sessionId, userId) {
  const { rows } = await query(
    'SELECT body FROM messages WHERE session_id = $1 AND sender_id = $2 ORDER BY id DESC LIMIT 5',
    [sessionId, userId],
  );
  return rows.map((r) => r.body);
}

// Borderline messages this sender already got through in this chat. Persistent
// borderline behaviour escalates even when no single message crosses the line.
async function priorBorderline(sessionId, userId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM messages
     WHERE session_id = $1 AND sender_id = $2 AND moderation->>'severity' = 'low'
       AND moderation->'categories' ?| array['harassment', 'sexual', 'toxic']`,
    [sessionId, userId],
  );
  return rows[0].n;
}

async function raiseAiReport(session, userId, severity, categories, excerpt) {
  await query(
    `INSERT INTO reports (reporter_id, reported_id, session_id, source, reason, details, severity)
     VALUES (NULL, $1, $2, 'ai', $3, $4, $5)`,
    [userId, session.id, categories.join(', ') || 'policy violation', excerpt.slice(0, 500), severity],
  );
}

// Applies a moderation verdict to the sender: warning, trust penalty, suspension.
async function penalise(session, userId, severity, categories, body) {
  await raiseAiReport(session, userId, severity, categories, body);
  await adjustTrust(userId, severity === 'high' ? TRUST_EVENTS.aiSevere : TRUST_EVENTS.aiWarning, `moderation: ${categories.join(', ')}`);
  const suspended = await addWarning(userId, `moderation: ${categories.join(', ')}`);
  if (suspended) {
    await endSession(session.id, { byUserId: userId, reason: 'moderation' });
    // Let the sender receive the acknowledgement before the socket is closed.
    setTimeout(() => kickUser(userId, 'account:restricted', { status: 'suspended' }), 250);
  }
  return suspended;
}

export function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: config.isProd ? undefined : { origin: config.corsOrigin, credentials: true },
    maxHttpBufferSize: 16 * 1024,
  });
  setIo(io);

  // WebSocket authentication: same httpOnly JWT cookie as the REST API.
  io.use(async (socket, next) => {
    try {
      const cookies = parseCookie(socket.handshake.headers.cookie || '');
      const user = await userFromToken(cookies[COOKIE]);
      if (!user) return next(new Error('unauthorized'));
      if (user.role !== 'student') return next(new Error('students only'));
      socket.data.userId = user.id;
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.userId;
    socket.join(`u:${userId}`);

    const timer = pendingDisconnects.get(userId);
    if (timer) {
      clearTimeout(timer);
      pendingDisconnects.delete(userId);
    }

    // Reload the user for each action so suspensions and profile edits apply at once.
    const loadUser = async () => {
      const u = await userFromToken(parseCookie(socket.handshake.headers.cookie || '')[COOKIE]);
      if (!u) {
        socket.emit('account:restricted', {});
        socket.disconnect(true);
      }
      return u;
    };

    const handler = (fn) => async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        reply(await fn(payload ?? {}));
      } catch (err) {
        if (err instanceof z.ZodError) return reply({ ok: false, error: 'Invalid request.' });
        console.error('socket handler error', err);
        reply({ ok: false, error: err.expose ? err.message : 'Something went wrong.' });
      }
    };

    socket.on('queue:join', handler(async (payload) => {
      const { mode, filter } = joinSchema.parse(payload);
      const user = await loadUser();
      if (!user) return { ok: false };
      if (!user.interests.length || !user.personality.length) {
        return { ok: false, error: 'Add a few interests and personality tags to your profile first.' };
      }
      if (await getActiveSession(userId)) return { ok: false, error: 'Finish your current chat first.' };
      const result = await joinQueue(user, { mode, filter });
      if (result.waiting) return { ok: true, waiting: true };

      const s = result.session;
      const sockets = await io.in([`u:${s.user_a}`, `u:${s.user_b}`]).fetchSockets();
      for (const sock of sockets) sock.join(room(s.id));
      for (const uid of [s.user_a, s.user_b]) {
        emitToUser(uid, 'match:found', { session: await sessionView(s, uid) });
      }
      return { ok: true, matched: true };
    }));

    socket.on('queue:leave', handler(async () => {
      await leaveQueue(userId);
      return { ok: true };
    }));

    socket.on('chat:send', handler(async (payload) => {
      const { sessionId, body } = sendSchema.parse(payload);
      const session = await getSession(sessionId);
      if (!session || !side(session, userId) || session.ended_at) return { ok: false, error: 'This chat has ended.' };
      if (await rateLimited(userId)) return { ok: false, error: 'You are sending messages too quickly.' };

      const revealed = Boolean(session.revealed_at);
      const verdict = await classify(body, {
        revealed,
        recent: await recentBodies(sessionId, userId),
        priorBorderline: await priorBorderline(sessionId, userId),
      });
      const action = actionFor(verdict.severity);

      const msg = await one(
        `INSERT INTO messages (session_id, sender_id, body, blocked, moderation)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, sender_id, body, deleted, created_at`,
        [sessionId, userId, action.deliver ? verdict.text : body, !action.deliver,
         { source: 'model', severity: verdict.severity, categories: verdict.categories, scores: verdict.scores }],
      );

      if (!action.deliver) {
        const suspended = await penalise(session, userId, verdict.severity, verdict.categories, body);
        await audit('moderation.blocked', { actorId: userId, meta: { sessionId, severity: verdict.severity, categories: verdict.categories } });
        if (action.endChat && !suspended) {
          emitToUser(partnerId(session, userId), 'chat:notice', { kind: 'moderation', text: 'This chat was ended by moderation to keep you safe.' });
          await endSession(sessionId, { byUserId: userId, reason: 'moderation' });
        }
        return {
          ok: false,
          moderated: true,
          error: suspended
            ? 'Your account has been suspended pending review.'
            : 'That message was not sent because it breaks the community guidelines. This counts as a warning.',
        };
      }

      const partner = partnerId(session, userId);
      emitToUser(userId, 'chat:message', { sessionId, message: messageView(msg, userId) });
      emitToUser(partner, 'chat:message', { sessionId, message: messageView(msg, partner) });
      if (verdict.categories.includes('personal-info')) {
        socket.emit('chat:notice', { kind: 'privacy', text: 'Contact details stay hidden until you both reveal.' });
      }

      return { ok: true, id: String(msg.id) };
    }));

    socket.on('chat:typing', async (payload) => {
      const parsed = idSchema.extend({ typing: z.boolean() }).safeParse(payload);
      if (!parsed.success) return;
      if (!socket.rooms.has(room(parsed.data.sessionId))) return;
      socket.to(room(parsed.data.sessionId)).emit('chat:typing', { sessionId: parsed.data.sessionId, typing: parsed.data.typing });
    });

    socket.on('chat:reveal', handler(async (payload) => {
      const { sessionId } = idSchema.parse(payload);
      const session = await getSession(sessionId);
      const me = session && side(session, userId);
      if (!me || session.ended_at) return { ok: false, error: 'This chat has ended.' };
      if (session.revealed_at) return { ok: true };
      if (Date.now() < safePeriodEndsAt(session).getTime()) {
        return { ok: false, error: 'You can reveal once the safe period is over.' };
      }
      // Set my consent and, if the other side already agreed, reveal atomically.
      const updated = await one(
        `UPDATE chat_sessions SET consent_${me} = true,
           revealed_at = CASE WHEN consent_${me === 'a' ? 'b' : 'a'} THEN now() ELSE revealed_at END
         WHERE id = $1 AND ended_at IS NULL RETURNING *`,
        [sessionId],
      );
      if (!updated) return { ok: false, error: 'This chat has ended.' };
      for (const uid of [updated.user_a, updated.user_b]) {
        const view = await sessionView(updated, uid);
        emitToUser(uid, updated.revealed_at ? 'reveal:done' : 'reveal:status', { session: view });
      }
      if (updated.revealed_at) {
        await adjustTrust(updated.user_a, TRUST_EVENTS.revealed, 'mutual reveal');
        await adjustTrust(updated.user_b, TRUST_EVENTS.revealed, 'mutual reveal');
        await audit('chat.revealed', { meta: { sessionId } });
      }
      return { ok: true };
    }));

    socket.on('chat:end', handler(async (payload) => {
      const { sessionId } = idSchema.parse(payload);
      const session = await getSession(sessionId);
      if (!session || !side(session, userId)) return { ok: false, error: 'Chat not found.' };
      await endSession(sessionId, { byUserId: userId, reason: 'ended' });
      return { ok: true };
    }));

    socket.on('disconnect', async () => {
      const remaining = await io.in(`u:${userId}`).fetchSockets();
      if (remaining.length) return;
      await leaveQueue(userId).catch(() => {});
      // Give a refreshing browser a moment to reconnect before ending the chat.
      pendingDisconnects.set(userId, setTimeout(async () => {
        pendingDisconnects.delete(userId);
        const still = await io.in(`u:${userId}`).fetchSockets();
        if (still.length) return;
        const s = await getActiveSession(userId);
        if (s) await endSession(s.id, { byUserId: userId, reason: 'disconnected' });
      }, config.isTest ? 300 : DISCONNECT_GRACE_MS));
    });

    // Resume an ongoing chat after a refresh or reconnect (listeners are attached first
    // so nothing the client sends meanwhile is lost). The client can also ask again.
    const resume = async () => {
      const active = await getActiveSession(userId);
      if (!active) return { ok: true, session: null };
      socket.join(room(active.id));
      return { ok: true, session: await sessionView(active, userId), messages: await sessionMessages(active, userId) };
    };
    socket.on('chat:resume', handler(resume));
    resume().then((r) => r.session && socket.emit('chat:resume', r)).catch(() => {});
  });

  return io;
}
