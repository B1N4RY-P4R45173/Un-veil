import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db.js';
import { wrap, parse, HttpError, clientIp } from '../http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { adjustTrust, addWarning, TRUST_EVENTS } from '../services/trust.js';
import { endActiveSessionFor, kickUser, room } from '../services/chat.js';
import { leaveQueue } from '../services/matchmaking.js';
import { getIo, emitToUser } from '../services/presence.js';
import { redis } from '../redis.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

const uuid = z.string().uuid();

router.get('/stats', wrap(async (req, res) => {
  const stats = await one(`SELECT
    (SELECT count(*) FROM users WHERE role = 'student')::int AS students,
    (SELECT count(*) FROM users WHERE role = 'student' AND status = 'active')::int AS active_students,
    (SELECT count(*) FROM users WHERE status IN ('suspended', 'banned'))::int AS restricted,
    (SELECT count(*) FROM chat_sessions WHERE ended_at IS NULL)::int AS live_chats,
    (SELECT count(*) FROM chat_sessions WHERE started_at > now() - interval '24 hours')::int AS chats_24h,
    (SELECT count(*) FROM chat_sessions WHERE revealed_at > now() - interval '24 hours')::int AS reveals_24h,
    (SELECT count(*) FROM messages WHERE created_at > now() - interval '24 hours')::int AS messages_24h,
    (SELECT count(*) FROM messages WHERE blocked AND created_at > now() - interval '24 hours')::int AS blocked_messages_24h,
    (SELECT count(*) FROM reports WHERE status = 'open')::int AS open_reports`);
  stats.waiting = await redis.hlen('mm:waiting');
  stats.online = getIo() ? (await getIo().fetchSockets()).length : 0;
  res.json(stats);
}));

router.get('/reports', wrap(async (req, res) => {
  const status = parse(z.enum(['open', 'dismissed', 'warned', 'suspended', 'banned', 'all']).default('open'), req.query.status);
  const { rows } = await query(
    `SELECT r.*, ru.display_name AS reported_name, ru.email AS reported_email, ru.trust_score AS reported_trust,
       ru.warnings AS reported_warnings, ru.status AS reported_status,
       rp.display_name AS reporter_name, rp.email AS reporter_email
     FROM reports r
     JOIN users ru ON ru.id = r.reported_id
     LEFT JOIN users rp ON rp.id = r.reporter_id
     WHERE ($1 = 'all' OR r.status = $1)
     ORDER BY CASE r.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, r.created_at DESC
     LIMIT 200`,
    [status],
  );
  res.json(rows);
}));

router.get('/reports/:id', wrap(async (req, res) => {
  const report = await one(
    `SELECT r.*, ru.display_name AS reported_name, ru.email AS reported_email, rp.display_name AS reporter_name
     FROM reports r JOIN users ru ON ru.id = r.reported_id LEFT JOIN users rp ON rp.id = r.reporter_id WHERE r.id = $1`,
    [parse(uuid, req.params.id)],
  );
  if (!report) throw new HttpError(404, 'Report not found.');
  let transcript = [];
  if (report.session_id) {
    const { rows } = await query(
      `SELECT m.id, m.body, m.blocked, m.deleted, m.moderation, m.created_at, m.sender_id = $2 AS from_reported
       FROM messages m WHERE m.session_id = $1 ORDER BY m.id`,
      [report.session_id, report.reported_id],
    );
    transcript = rows;
  }
  await audit('admin.report_viewed', { actorId: req.user.id, ip: clientIp(req), meta: { reportId: report.id } });
  res.json({ report, transcript });
}));

async function setStatus(userId, status) {
  await query('UPDATE users SET status = $2 WHERE id = $1', [userId, status]);
  if (status === 'suspended' || status === 'banned') {
    await leaveQueue(userId);
    await endActiveSessionFor(userId, status);
    await kickUser(userId, 'account:restricted', { status });
  }
}

router.post('/reports/:id/resolve', wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({
    action: z.enum(['dismiss', 'warn', 'suspend', 'ban']),
    note: z.string().trim().max(1000).optional().default(''),
  }), req.body);
  const report = await one("SELECT * FROM reports WHERE id = $1 AND status = 'open'", [id]);
  if (!report) throw new HttpError(404, 'Open report not found.');

  const status = { dismiss: 'dismissed', warn: 'warned', suspend: 'suspended', ban: 'banned' }[body.action];
  await query(
    'UPDATE reports SET status = $2, admin_note = $3, resolved_by = $4, resolved_at = now() WHERE id = $1',
    [id, status, body.note, req.user.id],
  );
  if (body.action !== 'dismiss') {
    await adjustTrust(report.reported_id, TRUST_EVENTS.reportUpheld, `report ${id} upheld`);
  }
  if (body.action === 'warn') {
    const suspended = await addWarning(report.reported_id, `report ${id}`);
    if (suspended) await setStatus(report.reported_id, 'suspended');
    else emitToUser(report.reported_id, 'account:warning', { text: 'A moderator reviewed a report about you and issued a warning.' });
  }
  if (body.action === 'suspend') await setStatus(report.reported_id, 'suspended');
  if (body.action === 'ban') await setStatus(report.reported_id, 'banned');
  await audit('admin.report_resolved', { actorId: req.user.id, ip: clientIp(req), meta: { reportId: id, action: body.action } });
  res.json({ ok: true });
}));

router.get('/users', wrap(async (req, res) => {
  const q = parse(z.string().trim().max(100).default(''), req.query.q);
  const { rows } = await query(
    `SELECT u.id, u.email, u.display_name, u.role, u.status, u.trust_score, u.warnings, u.created_at, c.name AS college,
       (SELECT count(*) FROM reports r WHERE r.reported_id = u.id)::int AS reports
     FROM users u LEFT JOIN colleges c ON c.id = u.college_id
     WHERE $1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%'
     ORDER BY u.created_at DESC LIMIT 100`,
    [q],
  );
  res.json(rows);
}));

router.post('/users/:id/status', wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ status: z.enum(['active', 'suspended', 'banned']) }), req.body);
  if (id === req.user.id) throw new HttpError(400, 'You cannot change your own status.');
  const user = await one('SELECT id, role FROM users WHERE id = $1', [id]);
  if (!user) throw new HttpError(404, 'User not found.');
  if (user.role === 'admin') throw new HttpError(400, 'Administrators cannot be restricted here.');
  await setStatus(id, body.status);
  if (body.status === 'active') await query('UPDATE users SET warnings = 0 WHERE id = $1', [id]);
  await audit('admin.user_status', { actorId: req.user.id, ip: clientIp(req), meta: { userId: id, status: body.status } });
  res.json({ ok: true });
}));

router.delete('/messages/:id', wrap(async (req, res) => {
  const id = parse(z.coerce.number().int().positive(), req.params.id);
  const msg = await one("UPDATE messages SET deleted = true, body = '[removed by a moderator]' WHERE id = $1 RETURNING session_id", [id]);
  if (!msg) throw new HttpError(404, 'Message not found.');
  getIo()?.to(room(msg.session_id)).emit('chat:deleted', { id: String(id) });
  await audit('admin.message_deleted', { actorId: req.user.id, ip: clientIp(req), meta: { messageId: id } });
  res.json({ ok: true });
}));

router.get('/colleges', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, (SELECT count(*) FROM users u WHERE u.college_id = c.id)::int AS students FROM colleges c ORDER BY c.name`,
  );
  res.json(rows);
}));

router.post('/colleges', wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(3).max(120),
    emailDomain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'must be a domain like college.edu'),
  }), req.body);
  const row = await one(
    'INSERT INTO colleges (name, email_domain) VALUES ($1, $2) ON CONFLICT (email_domain) DO NOTHING RETURNING *',
    [body.name, body.emailDomain],
  );
  if (!row) throw new HttpError(409, 'That email domain is already registered.');
  await audit('admin.college_added', { actorId: req.user.id, ip: clientIp(req), meta: body });
  res.status(201).json(row);
}));

router.get('/audit', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.action, a.ip, a.meta, a.created_at, u.email AS actor
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 200`,
  );
  res.json(rows);
}));

export default router;
