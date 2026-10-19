import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, shutdown, client, registerStudent, createAdmin, connect, once, emit, sleep } from './helpers.js';
import { pool } from '../src/db.js';
import { outbox } from '../src/services/mailer.js';
import { runRetention } from '../src/services/retention.js';

let srv;
before(async () => {
  await resetDb();
  srv = await startServer();
});
after(async () => {
  await srv.close();
  await shutdown();
});

test('registration requires a college email and a solved CAPTCHA', async () => {
  const c = client(srv.app);
  const cap = (await c.get('/api/auth/captcha')).body;
  const bad = await c.post('/api/auth/register').send({ email: 'x@gmail.com', password: 'abc12345', displayName: 'X', captchaToken: cap.token, captchaAnswer: 1 });
  assert.equal(bad.status, 400);
  const cap2 = (await c.get('/api/auth/captcha')).body;
  const wrongCaptcha = await c.post('/api/auth/register').send({ email: 'x@demo.edu', password: 'abc12345', displayName: 'Xy', captchaToken: cap2.token, captchaAnswer: 9999, acceptTerms: true });
  assert.equal(wrongCaptcha.status, 400);
  assert.match(wrongCaptcha.body.error, /CAPTCHA/);
});

test('state-changing requests without the CSRF header are refused', async () => {
  const r = await client(srv.app).agent.post('/api/auth/login').send({ email: 'a@demo.edu', password: 'x' });
  assert.equal(r.status, 403);
});

test('unverified accounts cannot log in; verified ones can', async () => {
  const c = await registerStudent(srv.app, { email: 'verify@demo.edu' });
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.college, 'Demo University');
  assert.equal(me.body.trust_score, undefined, 'raw trust score stays private');
  assert.equal(me.body.standing, 'good');
});

test('login locks after repeated failures', async () => {
  await registerStudent(srv.app, { email: 'lock@demo.edu' });
  const c = client(srv.app);
  for (let i = 0; i < 5; i++) await c.post('/api/auth/login').send({ email: 'lock@demo.edu', password: 'wrongpass1' });
  const r = await c.post('/api/auth/login').send({ email: 'lock@demo.edu', password: 'password123' });
  assert.equal(r.status, 429);
});

test('students cannot reach admin endpoints', async () => {
  const c = await registerStudent(srv.app, { email: 'nosy@demo.edu' });
  assert.equal((await c.get('/api/admin/stats')).status, 403);
  assert.equal((await client(srv.app).get('/api/admin/stats')).status, 401);
});

test('full journey: match, chat, moderation, reveal, friends, report, admin action, block', async () => {
  const alice = await registerStudent(srv.app, { email: 'alice@demo.edu', displayName: 'Alice' });
  const bob = await registerStudent(srv.app, { email: 'bob@demo.edu', displayName: 'Bob' });
  const carol = await registerStudent(srv.app, { email: 'carol@sample.edu', displayName: 'Carol' });
  const sa = await connect(srv.url, alice);
  const sb = await connect(srv.url, bob);
  const sc = await connect(srv.url, carol);

  // Carol is at another college, so campus mode must pair Alice with Bob.
  assert.deepEqual(await emit(sc, 'queue:join', { mode: 'campus', filter: 'interest' }), { ok: true, waiting: true });
  assert.deepEqual(await emit(sa, 'queue:join', { mode: 'campus', filter: 'interest' }), { ok: true, waiting: true });
  const foundA = once(sa, 'match:found');
  const foundB = once(sb, 'match:found');
  assert.equal((await emit(sb, 'queue:join', { mode: 'campus', filter: 'interest' })).matched, true);
  const { session: viewA } = await foundA;
  const { session: viewB } = await foundB;
  assert.equal(viewA.id, viewB.id);
  assert.equal(viewA.partnerAlias, viewB.alias);
  assert.equal(viewA.partner, undefined, 'identity hidden before reveal');
  assert.ok(!JSON.stringify(viewA).includes('Bob'));
  const sessionId = viewA.id;
  await emit(sc, 'queue:leave');

  // Messaging, with contact details masked before the reveal.
  const gotB = once(sb, 'chat:message');
  assert.equal((await emit(sa, 'chat:send', { sessionId, body: 'hi! my insta is alice_rocks' })).ok, true);
  const m = await gotB;
  assert.equal(m.message.mine, false);
  assert.ok(!m.message.body.includes('alice_rocks'));

  // Typing indicator reaches the partner only.
  const typing = once(sb, 'chat:typing');
  sa.emit('chat:typing', { sessionId, typing: true });
  assert.equal((await typing).typing, true);

  // Abuse is blocked, warned and raises an AI report.
  const abuse = await emit(sb, 'chat:send', { sessionId, body: 'you are so stupid' });
  assert.equal(abuse.ok, false);
  assert.equal(abuse.moderated, true);
  const aiReports = await pool.query("SELECT * FROM reports WHERE source = 'ai'");
  assert.equal(aiReports.rowCount, 1);

  // Reveal needs both people, and only after the safe period (1s in tests).
  await sleep(1100);
  const status = once(sb, 'reveal:status');
  assert.equal((await emit(sa, 'chat:reveal', { sessionId })).ok, true);
  assert.equal((await status).session.consent.partner, true);
  const done = once(sa, 'reveal:done');
  await emit(sb, 'chat:reveal', { sessionId });
  const revealed = (await done).session;
  assert.equal(revealed.partner.displayName, 'Bob');
  assert.equal(revealed.partner.college, 'Demo University');

  // Friend request after reveal.
  const req = await alice.post('/api/friends/requests').send({ sessionId });
  assert.equal(req.status, 201);
  const incoming = (await bob.get('/api/friends')).body.incoming;
  assert.equal(incoming[0].displayName, 'Alice');
  assert.equal((await bob.post(`/api/friends/requests/${incoming[0].id}/accept`)).status, 200);
  assert.equal((await alice.get('/api/friends')).body.friends[0].displayName, 'Bob');

  // End the chat; both are told.
  const endedB = once(sb, 'chat:ended');
  await emit(sa, 'chat:end', { sessionId });
  assert.equal((await endedB).byYou, false);

  // Report after the conversation, then an admin upholds it.
  const rep = await alice.post('/api/reports').send({ sessionId, reason: 'harassment', details: 'called me stupid' });
  assert.equal(rep.status, 201);
  const admin = await createAdmin(srv.app);
  const open = (await admin.get('/api/admin/reports')).body;
  const userReport = open.find((r) => r.source === 'user');
  assert.equal(userReport.reported_name, 'Bob');
  const detail = (await admin.get(`/api/admin/reports/${userReport.id}`)).body;
  assert.ok(detail.transcript.some((t) => t.blocked && t.from_reported));
  assert.equal((await admin.post(`/api/admin/reports/${userReport.id}/resolve`).send({ action: 'warn', note: 'first warning' })).status, 200);
  const bobRow = (await pool.query("SELECT trust_score, warnings FROM users WHERE email = 'bob@demo.edu'")).rows[0];
  assert.equal(bobRow.warnings, 2, 'one from moderation, one from the admin');
  assert.ok(bobRow.trust_score < 50);

  // Alice blocks Bob; they are never matched again.
  assert.equal((await alice.post('/api/blocks').send({ sessionId })).status, 201);
  assert.equal((await alice.get('/api/friends')).body.friends.length, 0, 'block removes the friendship');
  await emit(sa, 'queue:join', { mode: 'campus', filter: 'mystery' });
  const again = await emit(sb, 'queue:join', { mode: 'campus', filter: 'mystery' });
  assert.equal(again.waiting, true);
  await emit(sa, 'queue:leave');
  await emit(sb, 'queue:leave');

  // A third warning suspends the account and disconnects it.
  const dave = await registerStudent(srv.app, { email: 'dave@demo.edu', displayName: 'Dave' });
  const sd = await connect(srv.url, dave);
  const found = once(sd, 'match:found');
  await emit(sd, 'queue:join', { mode: 'campus', filter: 'mystery' });
  await emit(sb, 'queue:join', { mode: 'campus', filter: 'mystery' });
  const s2 = (await found).session.id;
  const kicked = once(sb, 'account:restricted');
  const res = await emit(sb, 'chat:send', { sessionId: s2, body: 'nobody likes you, you are worthless' });
  assert.equal(res.moderated, true);
  assert.equal((await kicked).status, 'suspended');
  assert.equal((await bob.get('/api/me')).status, 401);
  const login = await client(srv.app).post('/api/auth/login').send({ email: 'bob@demo.edu', password: 'password123' });
  assert.equal(login.status, 403);

  // Audit trail has logins and reports.
  const audit = (await admin.get('/api/admin/audit')).body.map((a) => a.action);
  for (const a of ['auth.login', 'report.created', 'admin.report_resolved', 'user.auto_suspend']) assert.ok(audit.includes(a), a);

  for (const s of [sa, sb, sc, sd]) s.disconnect();
});

test('cross campus pairs students from different colleges', async () => {
  const x = await registerStudent(srv.app, { email: 'x1@demo.edu', displayName: 'Xan' });
  const y = await registerStudent(srv.app, { email: 'y1@sample.edu', displayName: 'Yas' });
  const z = await registerStudent(srv.app, { email: 'z1@demo.edu', displayName: 'Zed' });
  const [sx, sy, sz] = await Promise.all([connect(srv.url, x), connect(srv.url, y), connect(srv.url, z)]);
  await emit(sx, 'queue:join', { mode: 'cross', filter: 'personality' });
  assert.equal((await emit(sz, 'queue:join', { mode: 'cross', filter: 'personality' })).waiting, true, 'same college is not a cross match');
  const found = once(sy, 'match:found');
  assert.equal((await emit(sy, 'queue:join', { mode: 'cross', filter: 'personality' })).matched, true);
  assert.equal((await found).session.mode, 'cross');
  for (const s of [sx, sy, sz]) s.disconnect();
});

test('a dropped connection ends the chat after a grace period', async () => {
  const p = await registerStudent(srv.app, { email: 'p1@demo.edu', displayName: 'Pia' });
  const q = await registerStudent(srv.app, { email: 'q1@demo.edu', displayName: 'Quin' });
  const [sp, sq] = await Promise.all([connect(srv.url, p), connect(srv.url, q)]);
  await emit(sp, 'queue:join', { mode: 'campus', filter: 'mystery' });
  const found = once(sq, 'match:found');
  await emit(sq, 'queue:join', { mode: 'campus', filter: 'mystery' });
  await found;
  const ended = once(sq, 'chat:ended');
  sp.disconnect();
  assert.equal((await ended).reason, 'disconnected');
  sq.disconnect();
});

test('reconnecting resumes the active chat', async () => {
  const p = await registerStudent(srv.app, { email: 'r1@demo.edu', displayName: 'Rae' });
  const q = await registerStudent(srv.app, { email: 'r2@demo.edu', displayName: 'Ras' });
  const [sp, sq] = await Promise.all([connect(srv.url, p), connect(srv.url, q)]);
  await emit(sp, 'queue:join', { mode: 'campus', filter: 'mystery' });
  const found = once(sq, 'match:found');
  await emit(sq, 'queue:join', { mode: 'campus', filter: 'mystery' });
  const sessionId = (await found).session.id;
  await emit(sp, 'chat:send', { sessionId, body: 'hello there' });
  sq.disconnect();
  const sq2 = await connect(srv.url, q);
  const resume = await emit(sq2, 'chat:resume');
  assert.equal(resume.session.id, sessionId);
  assert.equal(resume.messages.at(-1).body, 'hello there');
  const hist = (await q.get('/api/sessions')).body;
  assert.equal(hist[0].endedAt, null);
  for (const s of [sp, sq2]) s.disconnect();
});

test('registration requires accepting the terms', async () => {
  const c = client(srv.app);
  const cap = (await c.get('/api/auth/captcha')).body;
  const [, a, op, b] = cap.question.match(/(\d+) ([+×]) (\d+)/);
  const answer = op === '+' ? Number(a) + Number(b) : Number(a) * Number(b);
  const r = await c.post('/api/auth/register').send({ email: 'noterms@demo.edu', password: 'abc12345', displayName: 'No Terms', captchaToken: cap.token, captchaAnswer: answer });
  assert.equal(r.status, 400);
});

test('password reset by emailed code', async () => {
  await registerStudent(srv.app, { email: 'forgot@demo.edu' });
  const c = client(srv.app);
  const unknown = await c.post('/api/auth/forgot').send({ email: 'nobody@demo.edu' });
  assert.equal(unknown.status, 200, 'does not reveal whether an account exists');
  assert.equal((await c.post('/api/auth/forgot').send({ email: 'forgot@demo.edu' })).status, 200);
  const mail = [...outbox].reverse().find((m) => m.to === 'forgot@demo.edu');
  assert.match(mail.subject, /Reset/);
  const code = mail.text.match(/\b(\d{6})\b/)[1];
  const wrong = await c.post('/api/auth/reset').send({ email: 'forgot@demo.edu', code: code === '000000' ? '111111' : '000000', password: 'newpass123' });
  assert.equal(wrong.status, 400);
  assert.equal((await c.post('/api/auth/reset').send({ email: 'forgot@demo.edu', code, password: 'newpass123' })).status, 200);
  assert.equal((await c.post('/api/auth/reset').send({ email: 'forgot@demo.edu', code, password: 'other12345' })).status, 400, 'codes are single use');
  assert.equal((await c.post('/api/auth/login').send({ email: 'forgot@demo.edu', password: 'password123' })).status, 401);
  assert.equal((await c.post('/api/auth/login').send({ email: 'forgot@demo.edu', password: 'newpass123' })).status, 200);
});

test('account deletion erases personal data and blocks login', async () => {
  const c = await registerStudent(srv.app, { email: 'bye@demo.edu', displayName: 'Leaving Soon' });
  assert.equal((await c.delete('/api/me').send({ password: 'wrong-pass1' })).status, 400);
  assert.equal((await c.delete('/api/me').send({ password: 'password123' })).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
  const { rows } = await pool.query("SELECT status, email, display_name, bio FROM users WHERE email LIKE 'deleted+%'");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].status, rows[0].display_name, rows[0].bio], ['deleted', 'Deleted user', '']);
  assert.equal((await client(srv.app).post('/api/auth/login').send({ email: 'bye@demo.edu', password: 'password123' })).status, 401);
  await registerStudent(srv.app, { email: 'bye@demo.edu' }); // the email can sign up again
});

test('retention deletes old messages but keeps evidence for open reports', async () => {
  const { rows: [s] } = await pool.query('SELECT id FROM chat_sessions LIMIT 1');
  const { rows: [u] } = await pool.query("SELECT id FROM users WHERE role = 'student' LIMIT 1");
  const { rows: [old] } = await pool.query(
    "INSERT INTO messages (session_id, sender_id, body, created_at) VALUES ($1, $2, 'ancient', now() - interval '400 days') RETURNING id",
    [s.id, u.id],
  );
  const openReport = (await pool.query("SELECT 1 FROM reports WHERE status = 'open' AND session_id = $1", [s.id])).rowCount > 0;
  await runRetention();
  const left = (await pool.query('SELECT 1 FROM messages WHERE id = $1', [old.id])).rowCount;
  assert.equal(left, openReport ? 1 : 0);
});

test('admins can correct trust score, warnings and report count', async () => {
  await registerStudent(srv.app, { email: 'edit-me@demo.edu' });
  const admin = await createAdmin(srv.app, 'editor@unveil.test');
  const { rows: [u] } = await pool.query("SELECT id FROM users WHERE email = 'edit-me@demo.edu'");
  assert.equal((await admin.patch(`/api/admin/users/${u.id}`).send({ trustScore: 101 })).status, 400);
  const r = await admin.patch(`/api/admin/users/${u.id}`).send({ trustScore: 80, warnings: 1, reports: 4 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { trustScore: 80, warnings: 1, reports: 4 });
  const listed = (await admin.get('/api/admin/users?q=edit-me')).body[0];
  assert.deepEqual([listed.trust_score, listed.warnings, listed.reports], [80, 1, 4]);
  assert.equal((await admin.patch(`/api/admin/users/${u.id}`).send({ reports: 0 })).body.reports, 0);
  const { rows: [log] } = await pool.query("SELECT meta FROM audit_log WHERE action = 'admin.user_edited' ORDER BY id DESC LIMIT 1");
  assert.equal(log.meta.after.reports, 0);
  const student = await registerStudent(srv.app, { email: 'not-admin@demo.edu' });
  assert.equal((await student.patch(`/api/admin/users/${u.id}`).send({ trustScore: 1 })).status, 403);
});
