// Stateless arithmetic CAPTCHA: the answer is bound to an HMAC-signed, expiring token,
// so the server keeps no state and a token cannot be reused after it is redeemed once.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { redis } from '../redis.js';

const TTL_MS = 5 * 60 * 1000;

function sign(payload) {
  return crypto.createHmac('sha256', config.captchaSecret).update(payload).digest('base64url');
}

export function createCaptcha() {
  const a = crypto.randomInt(2, 13);
  const b = crypto.randomInt(2, 13);
  const op = crypto.randomInt(0, 2) === 0 ? '+' : '×';
  const answer = op === '+' ? a + b : a * b;
  const nonce = crypto.randomBytes(9).toString('base64url');
  const payload = `${nonce}.${Date.now() + TTL_MS}.${answer}`;
  const [n, exp] = payload.split('.');
  return { question: `What is ${a} ${op} ${b}?`, token: `${n}.${exp}.${sign(payload)}` };
}

export async function verifyCaptcha(token, answer) {
  if (typeof token !== 'string' || answer === undefined || answer === null) return false;
  const [nonce, exp, mac] = token.split('.');
  if (!nonce || !exp || !mac || Number(exp) < Date.now()) return false;
  const expected = sign(`${nonce}.${exp}.${String(answer).trim()}`);
  const ok = expected.length === mac.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac));
  if (!ok) return false;
  // Single use.
  const fresh = await redis.set(`captcha:used:${nonce}`, '1', 'PX', TTL_MS, 'NX');
  return fresh === 'OK';
}
