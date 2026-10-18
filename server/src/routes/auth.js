import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { wrap, parse, HttpError, clientIp } from '../http.js';
import { createCaptcha, verifyCaptcha } from '../services/captcha.js';
import { issueOtp, checkOtp } from '../services/otp.js';
import { audit } from '../services/audit.js';
import { issueToken, clearToken, requireAuth } from '../middleware/auth.js';
import { endActiveSessionFor } from '../services/chat.js';
import { leaveQueue } from '../services/matchmaking.js';

const router = Router();

const limiter = (max, windowMinutes) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: config.isTest ? 10_000 : max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
  });

const email = z.string().trim().toLowerCase().email().max(254);
const password = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'must contain a letter')
  .regex(/\d/, 'must contain a number');

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

router.get('/captcha', (req, res) => res.json(createCaptcha()));

router.post('/register', limiter(10, 15), wrap(async (req, res) => {
  const body = parse(z.object({
    email,
    password,
    displayName: z.string().trim().min(2).max(40),
    captchaToken: z.string(),
    captchaAnswer: z.union([z.string(), z.number()]),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You need to accept the Terms and Privacy Policy.' }) }),
  }), req.body);

  if (!(await verifyCaptcha(body.captchaToken, body.captchaAnswer))) {
    throw new HttpError(400, 'The CAPTCHA answer was wrong or expired. Try the new one.');
  }
  const domain = body.email.split('@')[1];
  const college = await one('SELECT id, name FROM colleges WHERE email_domain = $1', [domain]);
  if (!college) {
    throw new HttpError(400, 'Use your college email address. This college is not on Unveil yet.');
  }

  const existing = await one('SELECT id, email, status FROM users WHERE email = $1', [body.email]);
  if (existing) {
    // Same response either way, so the endpoint does not reveal who is registered.
    if (existing.status === 'pending') await issueOtp(existing);
    await audit('auth.register_existing', { ip: clientIp(req), meta: { email: body.email } });
    return res.status(201).json({ ok: true, email: body.email });
  }

  const hash = await bcrypt.hash(body.password, 12);
  const user = await one(
    `INSERT INTO users (email, password_hash, display_name, college_id, terms_accepted_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING id, email`,
    [body.email, hash, body.displayName, college.id],
  );
  await issueOtp(user, { force: true });
  await audit('auth.register', { actorId: user.id, ip: clientIp(req), meta: { college: college.name } });
  res.status(201).json({ ok: true, email: user.email });
}));

router.post('/verify', limiter(20, 15), wrap(async (req, res) => {
  const body = parse(z.object({ email, code: z.string().trim().regex(/^\d{6}$/, 'must be 6 digits') }), req.body);
  const user = await one('SELECT id, role, status FROM users WHERE email = $1', [body.email]);
  if (!user || user.status !== 'pending') throw new HttpError(400, 'That code is not right.');
  const result = await checkOtp(user.id, body.code);
  if (!result.ok) {
    await audit('auth.verify_failed', { actorId: user.id, ip: clientIp(req) });
    throw new HttpError(400, result.error);
  }
  await query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
  await audit('auth.verified', { actorId: user.id, ip: clientIp(req) });
  issueToken(res, user);
  res.json({ ok: true });
}));

router.post('/resend', limiter(5, 15), wrap(async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  const user = await one('SELECT id, email, status FROM users WHERE email = $1', [body.email]);
  if (user?.status === 'pending') {
    const r = await issueOtp(user);
    if (!r.ok) throw new HttpError(429, r.error);
  }
  res.json({ ok: true });
}));

// Password reset by emailed code. Responses never reveal whether an account exists.
router.post('/forgot', limiter(5, 15), wrap(async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  const user = await one('SELECT id, email, status FROM users WHERE email = $1', [body.email]);
  if (user?.status === 'active') {
    const r = await issueOtp(user, { purpose: 'reset' });
    if (r.ok) await audit('auth.reset_requested', { actorId: user.id, ip: clientIp(req) });
  }
  res.json({ ok: true });
}));

router.post('/reset', limiter(10, 15), wrap(async (req, res) => {
  const body = parse(z.object({ email, code: z.string().trim().regex(/^\d{6}$/, 'must be 6 digits'), password }), req.body);
  const user = await one('SELECT id, status FROM users WHERE email = $1', [body.email]);
  if (!user || user.status !== 'active') throw new HttpError(400, 'That code is not right.');
  const result = await checkOtp(user.id, body.code);
  if (!result.ok) {
    await audit('auth.reset_failed', { actorId: user.id, ip: clientIp(req) });
    throw new HttpError(400, result.error);
  }
  const hash = await bcrypt.hash(body.password, 12);
  await query('UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id, hash]);
  await audit('auth.password_reset', { actorId: user.id, ip: clientIp(req) });
  res.json({ ok: true });
}));

router.post('/login', limiter(20, 15), wrap(async (req, res) => {
  const body = parse(z.object({ email, password: z.string().min(1).max(128) }), req.body);
  const ip = clientIp(req);
  const user = await one('SELECT id, role, status, password_hash, locked_until FROM users WHERE email = $1', [body.email]);

  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    await audit('auth.login_locked', { actorId: user.id, ip });
    throw new HttpError(429, `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`);
  }
  // Compare against a dummy hash when the user does not exist so timing does not leak it.
  const ok = await bcrypt.compare(body.password, user?.password_hash ?? '$2b$12$C6UzMDM.H6dfI/f/IKcEeO5w1yR9g3Yb0b9XzZq7vZ1Yp3o1C0bGa');
  if (!user || !ok) {
    if (user) {
      await query(
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
         WHERE id = $1`,
        [user.id, LOCK_AFTER, LOCK_MINUTES],
      );
    }
    await audit('auth.login_failed', { actorId: user?.id ?? null, ip, meta: { email: body.email } });
    throw new HttpError(401, 'Email or password is incorrect.');
  }
  if (user.status === 'pending') throw new HttpError(403, 'Verify your email first.', { needsVerification: true });
  if (user.status === 'suspended') throw new HttpError(403, 'Your account is suspended while a moderator reviews it.');
  if (user.status === 'banned') throw new HttpError(403, 'This account has been banned for breaking the community guidelines.');
  if (user.status === 'deleted') throw new HttpError(401, 'Email or password is incorrect.');

  await query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
  await audit('auth.login', { actorId: user.id, ip });
  issueToken(res, user);
  res.json({ ok: true });
}));

router.post('/logout', requireAuth, wrap(async (req, res) => {
  await leaveQueue(req.user.id);
  await endActiveSessionFor(req.user.id, 'left');
  await audit('auth.logout', { actorId: req.user.id, ip: clientIp(req) });
  clearToken(res);
  res.json({ ok: true });
}));

export default router;
