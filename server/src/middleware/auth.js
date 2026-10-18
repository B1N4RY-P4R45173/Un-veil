import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one } from '../db.js';

export const COOKIE = 'unveil_token';

export function issueToken(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.tokenTtlSeconds,
    algorithm: 'HS256',
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProd,
    maxAge: config.tokenTtlSeconds * 1000,
    path: '/',
  });
}

export function clearToken(res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: config.isProd, path: '/' });
}

// Verifies the JWT and loads the user. Suspended or banned users are rejected on
// every request, so a status change takes effect immediately rather than at token expiry.
export async function userFromToken(token) {
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  const user = await one(
    `SELECT u.id, u.email, u.display_name, u.role, u.status, u.college_id, u.bio, u.interests, u.personality,
            u.trust_score, u.warnings, c.name AS college_name
     FROM users u LEFT JOIN colleges c ON c.id = u.college_id WHERE u.id = $1`,
    [payload.sub],
  );
  if (!user || user.status !== 'active') return null;
  return user;
}

export function requireAuth(req, res, next) {
  userFromToken(req.cookies?.[COOKIE])
    .then((user) => {
      if (!user) return res.status(401).json({ error: 'Please log in.' });
      req.user = user;
      next();
    })
    .catch(next);
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) return res.status(403).json({ error: 'You do not have access to this.' });
    next();
  };
}
