import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MICROSOFT_CLIENT_ID = 'test-client';
process.env.MICROSOFT_CLIENT_SECRET = 'test-secret';
process.env.PUBLIC_URL = 'https://unveil.example';

const { resetDb, startServer, shutdown, client, registerStudent } = await import('./helpers.js');
const { pool } = await import('../src/db.js');
const { userFromMicrosoft } = await import('../src/services/microsoft.js');
const { config } = await import('../src/config.js');

let srv;
before(async () => {
  await resetDb();
  srv = await startServer();
});
after(async () => {
  await srv.close();
  await shutdown();
});

const claims = (over = {}) => ({ tid: 'tenant-1', oid: 'oid-1', name: 'Asha Menon', preferred_username: 'Asha@demo.edu', ...over });

test('sign-in starts at Microsoft with PKCE and a state', async () => {
  const r = await client(srv.app).get('/api/auth/microsoft');
  assert.equal(r.status, 302);
  const url = new URL(r.headers.location);
  assert.equal(url.origin, 'https://login.microsoftonline.com');
  assert.equal(url.searchParams.get('client_id'), 'test-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://unveil.example/api/auth/microsoft/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('state'));
  assert.equal((await client(srv.app).get('/api/meta')).body.microsoftLogin, true);
});

test('a callback with an unknown state is refused', async () => {
  const r = await client(srv.app).get('/api/auth/microsoft/callback?code=x&state=forged');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/login?error=ms_failed');
  const denied = await client(srv.app).get('/api/auth/microsoft/callback?error=consent_required');
  assert.equal(denied.headers.location, '/login?error=ms_consent');
});

test('first Microsoft sign-in creates an active student with the directory name', async () => {
  const r = await userFromMicrosoft(claims());
  assert.equal(r.created, true);
  const { rows: [u] } = await pool.query('SELECT email, display_name, status, ms_oid, terms_accepted_at FROM users WHERE id = $1', [r.user.id]);
  assert.deepEqual([u.email, u.display_name, u.status, u.ms_oid], ['asha@demo.edu', 'Asha Menon', 'active', 'oid-1']);
  assert.ok(u.terms_accepted_at);
  const again = await userFromMicrosoft(claims({ name: 'Asha M' }));
  assert.equal(again.user.id, r.user.id);
  assert.equal(again.created, false);
});

test('Microsoft accounts outside the colleges or allowed tenants are refused', async () => {
  assert.equal((await userFromMicrosoft(claims({ oid: 'x', preferred_username: 'someone@gmail.com' }))).error, 'not_college');
  config.microsoft.allowedTenants = ['college-tenant'];
  assert.equal((await userFromMicrosoft(claims({ oid: 'y', preferred_username: 'b@demo.edu' }))).error, 'not_allowed');
  config.microsoft.allowedTenants = [];
});

test('an existing email account is linked and its name locked', async () => {
  const c = await registerStudent(srv.app, { email: 'link@demo.edu', displayName: 'Made Up Name' });
  await userFromMicrosoft(claims({ oid: 'oid-link', preferred_username: 'link@demo.edu', name: 'Real Name' }));
  const me = (await c.get('/api/me')).body;
  assert.equal(me.displayName, 'Real Name');
  assert.equal(me.nameLocked, true);
  const change = await c.patch('/api/me').send({ displayName: 'Something Else' });
  assert.equal(change.status, 400);
  assert.equal((await c.patch('/api/me').send({ bio: 'hi' })).status, 200);
});

test('Microsoft-only accounts delete by typing DELETE', async () => {
  const { user } = await userFromMicrosoft(claims({ oid: 'oid-del', preferred_username: 'del@demo.edu', name: 'Del User' }));
  const { issueToken } = await import('../src/middleware/auth.js');
  let cookie;
  issueToken({ cookie: (n, v) => { cookie = `${n}=${v}`; } }, user);
  const agent = (await import('supertest')).default(srv.app);
  const del = (body) => agent.delete('/api/me').set('Cookie', cookie).set('X-Requested-With', 'unveil').send(body);
  assert.equal((await del({ confirm: 'nope' })).status, 400);
  assert.equal((await del({ confirm: 'DELETE' })).status, 200);
  const { rows: [u] } = await pool.query('SELECT status, ms_oid FROM users WHERE id = $1', [user.id]);
  assert.deepEqual([u.status, u.ms_oid], ['deleted', null]);
});
