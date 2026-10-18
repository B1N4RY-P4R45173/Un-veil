import fs from 'node:fs';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { pool } from '../src/db.js';
import { redis } from '../src/redis.js';
import { createApp } from '../src/app.js';
import { attachSockets } from '../src/socket.js';
import { outbox } from '../src/services/mailer.js';

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await pool.query(`INSERT INTO colleges (name, email_domain) VALUES ('Demo University', 'demo.edu'), ('Sample College', 'sample.edu')`);
  await redis.flushdb();
}

export async function startServer() {
  const app = createApp();
  const server = http.createServer(app);
  const io = attachSockets(server);
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    app,
    async close() {
      await new Promise((r) => setTimeout(r, 500)); // let disconnect grace timers finish
      io.close();
      await new Promise((r) => server.close(r));
    },
  };
}

export async function shutdown() {
  await pool.end();
  redis.disconnect();
}

function solveCaptcha(question) {
  const [, a, op, b] = question.match(/(\d+) ([+×]) (\d+)/);
  return op === '+' ? Number(a) + Number(b) : Number(a) * Number(b);
}

// An agent that keeps the auth cookie and always sends the CSRF header.
export function client(app) {
  const agent = request.agent(app);
  const withHeader = (m) => (url) => agent[m](url).set('X-Requested-With', 'unveil');
  return {
    agent,
    get: (url) => agent.get(url),
    post: withHeader('post'),
    patch: withHeader('patch'),
    delete: withHeader('delete'),
    cookie: () => agent.jar.getCookie('unveil_token', { path: '/', domain: '127.0.0.1', secure: false, script: false })?.toString(),
  };
}

export async function registerStudent(app, { email, password = 'password123', displayName = 'Test Student', profile = true } = {}) {
  const c = client(app);
  const cap = (await c.get('/api/auth/captcha')).body;
  const reg = await c.post('/api/auth/register').send({
    email, password, displayName, captchaToken: cap.token, captchaAnswer: solveCaptcha(cap.question), acceptTerms: true,
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const mail = [...outbox].reverse().find((m) => m.to === email);
  const code = mail.text.match(/\b(\d{6})\b/)[1];
  const ver = await c.post('/api/auth/verify').send({ email, code });
  if (ver.status !== 200) throw new Error(`verify failed: ${JSON.stringify(ver.body)}`);
  if (profile) {
    await c.patch('/api/me').send({ interests: ['coding', 'music'], personality: ['introvert', 'curious'], bio: `I am ${displayName}` });
  }
  return c;
}

export async function createAdmin(app, email = 'admin@unveil.test', password = 'adminpass123') {
  const hash = await bcrypt.hash(password, 4);
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, role, status) VALUES ($1, $2, 'Admin', 'admin', 'active')",
    [email, hash],
  );
  const c = client(app);
  const r = await c.post('/api/auth/login').send({ email, password });
  if (r.status !== 200) throw new Error('admin login failed');
  return c;
}

export function connect(url, c) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      transports: ['websocket'],
      extraHeaders: { cookie: `unveil_token=${c.cookie().split('=')[1].split(';')[0]}` },
      forceNew: true,
      reconnection: false,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

export const once = (socket, event, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

export const emit = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ack for ${event}`)), 3000);
    socket.emit(event, payload, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
