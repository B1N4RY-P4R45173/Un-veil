import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, one } from '../db.js';
import { wrap, parse } from '../http.js';
import { INTERESTS, PERSONALITY, REPORT_REASONS } from '../constants.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/meta', wrap(async (req, res) => {
  const { rows } = await query('SELECT name, email_domain FROM colleges ORDER BY name');
  res.json({
    interests: INTERESTS,
    personality: PERSONALITY,
    reportReasons: REPORT_REASONS,
    safePeriodSeconds: config.safePeriodSeconds,
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

export default router;
