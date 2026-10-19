// "Sign in with Microsoft" (OpenID Connect, authorization code flow with PKCE).
// Students use their college Microsoft 365 account, so no Unveil password or email code is
// needed, and their name comes from the college directory instead of being typed in.
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';
import { one } from '../db.js';
import { redis } from '../redis.js';

const AUTHORITY = 'https://login.microsoftonline.com';
const STATE_TTL_SECONDS = 600;
let jwks;

export const microsoftEnabled = () => Boolean(config.microsoft);

export function redirectUri() {
  return `${config.publicUrl}/api/auth/microsoft/callback`;
}

const b64url = (buf) => buf.toString('base64url');

// Builds the Microsoft sign-in URL and remembers the state, nonce and PKCE verifier for the callback.
export async function startLogin() {
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  await redis.set(`oauth:ms:${state}`, JSON.stringify({ nonce, verifier }), 'EX', STATE_TTL_SECONDS);
  const params = new URLSearchParams({
    client_id: config.microsoft.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTHORITY}/${config.microsoft.tenant}/oauth2/v2.0/authorize?${params}`;
}

// Exchanges the code for an ID token and returns its verified claims.
export async function finishLogin({ code, state }) {
  const key = `oauth:ms:${state}`;
  const saved = await redis.get(key);
  if (!saved) throw new Error('expired_state');
  await redis.del(key);
  const { nonce, verifier } = JSON.parse(saved);

  const res = await fetch(`${AUTHORITY}/${config.microsoft.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.microsoft.clientId,
      client_secret: config.microsoft.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) throw new Error(`token_exchange_failed: ${body.error || res.status}`);

  jwks ??= createRemoteJWKSet(new URL(`${AUTHORITY}/common/discovery/v2.0/keys`));
  const { payload } = await jwtVerify(body.id_token, jwks, { audience: config.microsoft.clientId });
  // Multi-tenant apps get tokens from many tenants; the issuer must match the token's own tenant.
  if (payload.iss !== `${AUTHORITY}/${payload.tid}/v2.0`) throw new Error('bad_issuer');
  if (payload.nonce !== nonce) throw new Error('bad_nonce');
  return payload;
}

// Turns verified Microsoft claims into an Unveil user: creates the account on first sign-in,
// links an existing account with the same email, and always takes the name from Microsoft.
export async function userFromMicrosoft(claims) {
  const allowed = config.microsoft?.allowedTenants ?? [];
  if (allowed.length && !allowed.includes(claims.tid)) return { error: 'not_allowed' };

  // preferred_username is the sign-in name (UPN). Its domain has to be verified by the tenant,
  // unlike the optional email claim, so it is what proves the college address.
  const email = String(claims.preferred_username || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return { error: 'no_email' };
  const college = await one('SELECT id FROM colleges WHERE email_domain = $1', [email.split('@')[1]]);
  if (!college) return { error: 'not_college' };

  const name = String(claims.name || email.split('@')[0]).trim().slice(0, 40);
  const existing = await one(
    'SELECT id, role, status FROM users WHERE ms_oid = $1 OR email = $2 ORDER BY (ms_oid = $1) DESC NULLS LAST LIMIT 1',
    [claims.oid, email],
  );
  if (existing) {
    if (existing.role !== 'student') return { error: 'not_student' };
    if (existing.status === 'suspended') return { error: 'suspended' };
    if (existing.status === 'banned') return { error: 'banned' };
    if (existing.status === 'deleted') return { error: 'deleted' };
    const user = await one(
      `UPDATE users SET ms_oid = $2, display_name = $3, email = $4, college_id = $5,
         status = 'active', terms_accepted_at = COALESCE(terms_accepted_at, now())
       WHERE id = $1 RETURNING id, role`,
      [existing.id, claims.oid, name, email, college.id],
    );
    return { user, created: false };
  }
  const user = await one(
    `INSERT INTO users (email, password_hash, display_name, college_id, status, ms_oid, terms_accepted_at)
     VALUES ($1, '!', $2, $3, 'active', $4, now()) RETURNING id, role`,
    [email, name, college.id, claims.oid],
  );
  return { user, created: true };
}
