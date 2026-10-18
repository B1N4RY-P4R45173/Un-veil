import crypto from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function secret(name) {
  if (env[name]) return env[name];
  if (isProd) throw new Error(`${name} must be set in production`);
  // Dev only: a random secret per process means sessions reset on restart.
  return crypto.randomBytes(32).toString('hex');
}

if (isProd && !env.SMTP_HOST) {
  throw new Error('SMTP_HOST must be set in production: students cannot verify their email without it');
}

export const config = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT || 4000),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/unveil',
  redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
  jwtSecret: secret('JWT_SECRET'),
  captchaSecret: secret('CAPTCHA_SECRET'),
  tokenTtlSeconds: Number(env.TOKEN_TTL_SECONDS || 60 * 60 * 12),
  // Minimum time both people must stay in a chat before a reveal can happen.
  safePeriodSeconds: Number(env.SAFE_PERIOD_SECONDS || 300),
  otpTtlSeconds: 10 * 60,
  // Chat messages are deleted after this many days unless an open report needs them.
  messageRetentionDays: Number(env.MESSAGE_RETENTION_DAYS || 30),
  trustProxy: env.TRUST_PROXY === undefined ? 1 : (Number.isNaN(Number(env.TRUST_PROXY)) ? env.TRUST_PROXY : Number(env.TRUST_PROXY)),
  maxMessageLength: 1000,
  corsOrigin: env.CORS_ORIGIN || 'http://localhost:5173',
  clientDist: env.CLIENT_DIST || new URL('../../client/dist', import.meta.url).pathname,
  smtp: env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 587),
        secure: env.SMTP_SECURE === 'true',
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      }
    : null,
  mailFrom: env.MAIL_FROM || 'Unveil <no-reply@unveil.local>',
};
