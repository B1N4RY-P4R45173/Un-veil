import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, one } from '../db.js';
import { sendMail } from './mailer.js';

const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

function hashCode(userId, code) {
  return crypto.createHmac('sha256', config.jwtSecret).update(`${userId}:${code}`).digest('hex');
}

// A plain HTML version alongside the text one: text-only mail scores worse with spam filters.
// No links or images, which new sending domains get penalised for.
function codeHtml(intro, code, mins, footer) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f4ef;font-family:Arial,Helvetica,sans-serif;color:#1f1b2e">
<div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
<p style="margin:0 0 4px;font-size:18px;font-weight:bold">Unveil</p>
<p style="margin:0 0 20px;font-size:15px">${intro}</p>
<p style="margin:0 0 20px;font-size:32px;letter-spacing:6px;font-weight:bold">${code}</p>
<p style="margin:0 0 8px;font-size:14px;color:#5b5670">This code expires in ${mins} minutes.</p>
<p style="margin:0;font-size:13px;color:#5b5670">${footer}</p>
</div></body></html>`;
}

const MAIL = {
  verify: {
    subject: 'Your Unveil verification code',
    text: (code, mins) => `Your Unveil verification code is ${code}. It expires in ${mins} minutes. If you did not sign up, ignore this email.`,
    html: (code, mins) => codeHtml('Here is your code to finish signing up:', code, mins, 'If you did not sign up for Unveil, you can ignore this email.'),
  },
  reset: {
    subject: 'Reset your Unveil password',
    text: (code, mins) => `Your Unveil password reset code is ${code}. It expires in ${mins} minutes. If you did not ask to reset your password, ignore this email; your password has not changed.`,
    html: (code, mins) => codeHtml('Here is your code to reset your password:', code, mins, 'If you did not ask to reset your password, ignore this email. Your password has not changed.'),
  },
};

export async function issueOtp(user, { force = false, purpose = 'verify' } = {}) {
  const existing = await one('SELECT sent_at FROM email_otps WHERE user_id = $1', [user.id]);
  if (!force && existing && Date.now() - new Date(existing.sent_at).getTime() < RESEND_COOLDOWN_MS) {
    return { ok: false, error: 'Please wait a minute before requesting another code.' };
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await query(
    `INSERT INTO email_otps (user_id, code_hash, expires_at, attempts, sent_at)
     VALUES ($1, $2, now() + make_interval(secs => $3), 0, now())
     ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = now()`,
    [user.id, hashCode(user.id, code), config.otpTtlSeconds],
  );
  await sendMail({
    to: user.email,
    subject: MAIL[purpose].subject,
    text: MAIL[purpose].text(code, config.otpTtlSeconds / 60),
    html: MAIL[purpose].html(code, config.otpTtlSeconds / 60),
  });
  return { ok: true };
}

export async function checkOtp(userId, code) {
  const row = await one('SELECT code_hash, expires_at, attempts FROM email_otps WHERE user_id = $1', [userId]);
  if (!row) return { ok: false, error: 'No code was requested. Ask for a new one.' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Too many attempts. Ask for a new code.' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, error: 'This code has expired. Ask for a new one.' };
  const expected = Buffer.from(row.code_hash);
  const actual = Buffer.from(hashCode(userId, String(code)));
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    await query('UPDATE email_otps SET attempts = attempts + 1 WHERE user_id = $1', [userId]);
    return { ok: false, error: 'That code is not right.' };
  }
  await query('DELETE FROM email_otps WHERE user_id = $1', [userId]);
  return { ok: true };
}
