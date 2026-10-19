import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, one } from '../db.js';
import { wrap, parse } from '../http.js';
import { INTERESTS, PERSONALITY, REPORT_REASONS } from '../constants.js';
import bcrypt from 'bcryptjs';
import { requireAuth, requireRole, clearToken } from '../middleware/auth.js';
import { HttpError, clientIp } from '../http.js';
import { audit } from '../services/audit.js';
import { endActiveSessionFor, kickUser } from '../services/chat.js';
import { leaveQueue } from '../services/matchmaking.js';

const router = Router();

router.get('/meta', wrap(async (req, res) => {
  const { rows } = await query('SELECT name, email_domain FROM colleges ORDER BY name');
  res.json({
    interests: INTERESTS,
    personality: PERSONALITY,
    reportReasons: REPORT_REASONS,
    safePeriodSeconds: config.safePeriodSeconds,
    microsoftLogin: Boolean(config.microsoft),
    passwordSignup: config.passwordSignup,
    messageRetentionDays: config.messageRetentionDays,
    colleges: rows.map((r) => ({ name: r.name, domain: r.email_domain })),
  });
}));

// The trust score itself stays private; students see a coarse standing.
export function standing(score) {
  if (score >= 60) return 'excellent';
  if (score >= 40) return 'good';
  if (score >= 25) return 'fair';
  return 'limited';
}

export function meView(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    college: u.college_name,
    bio: u.bio,
    interests: u.interests,
    personality: u.personality,
    standing: standing(u.trust_score),
    warnings: u.warnings,
    // Students who sign in with Microsoft get their name from the college directory.
    nameLocked: Boolean(u.ms_oid),
    hasPassword: u.password_hash ? u.password_hash !== '!' : true,
    profileComplete: u.role === 'admin' || (u.interests.length > 0 && u.personality.length > 0),
  };
}

router.get('/me', requireAuth, (req, res) => res.json(meView(req.user)));

router.patch('/me', requireAuth, wrap(async (req, res) => {
  const body = parse(z.object({
    displayName: z.string().trim().min(2).max(40).optional(),
    bio: z.string().trim().max(280).optional(),
    interests: z.array(z.enum(INTERESTS)).max(8).optional(),
    personality: z.array(z.enum(PERSONALITY)).max(5).optional(),
  }).strict(), req.body);
  if (body.displayName !== undefined && req.user.ms_oid && body.displayName !== req.user.display_name) {
    throw new HttpError(400, 'Your name comes from your Microsoft account and cannot be changed here.');
  }
  await query(
    `UPDATE users SET
       display_name = COALESCE($2, display_name),
       bio = COALESCE($3, bio),
       interests = COALESCE($4, interests),
       personality = COALESCE($5, personality)
     WHERE id = $1`,
    [req.user.id, body.displayName ?? null, body.bio ?? null,
     body.interests ? [...new Set(body.interests)] : null,
     body.personality ? [...new Set(body.personality)] : null],
  );
  const u = await one(
    `SELECT u.*, c.name AS college_name FROM users u LEFT JOIN colleges c ON c.id = u.college_id WHERE u.id = $1`,
    [req.user.id],
  );
  res.json(meView(u));
}));

// Deletes the account. Personal details are erased and the row is kept only as an
// anonymous placeholder, so reports against this person (and their evidence) survive:
// deleting an account must not be a way to escape moderation.
router.delete('/me', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const body = parse(z.object({ password: z.string().max(128).optional(), confirm: z.string().max(20).optional() }), req.body);
  const { password_hash: hash } = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (hash === '!') {
    // Microsoft-only accounts have no Unveil password; they confirm by typing DELETE instead.
    if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.');
  } else if (!body.password || !(await bcrypt.compare(body.password, hash))) {
    throw new HttpError(400, 'That password is not right.');
  }

  const id = req.user.id;
  await leaveQueue(id);
  await endActiveSessionFor(id, 'left');
  await query(
    `DELETE FROM messages WHERE sender_id = $1 AND session_id NOT IN
       (SELECT session_id FROM reports WHERE status = 'open' AND session_id IS NOT NULL)`,
    [id],
  );
  await query('DELETE FROM friendships WHERE requester = $1 OR addressee = $1', [id]);
  await query('DELETE FROM blocks WHERE blocker = $1', [id]);
  await query('DELETE FROM email_otps WHERE user_id = $1', [id]);
  await query(
    `UPDATE users SET status = 'deleted', email = 'deleted+' || id || '@deleted.invalid', display_name = 'Deleted user',
       bio = '', interests = '{}', personality = '{}', password_hash = '!', ms_oid = NULL
     WHERE id = $1`,
    [id],
  );
  await audit('user.deleted_account', { actorId: id, ip: clientIp(req) });
  clearToken(res);
  await kickUser(id);
  res.json({ ok: true });
}));

export default router;
