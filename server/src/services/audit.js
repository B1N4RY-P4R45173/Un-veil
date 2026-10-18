import { query } from '../db.js';

export async function audit(action, { actorId = null, ip = null, meta = {} } = {}) {
  try {
    await query('INSERT INTO audit_log (actor_id, action, ip, meta) VALUES ($1, $2, $3, $4)', [actorId, action, ip, meta]);
  } catch (err) {
    // Auditing must never break the request that triggered it.
    console.error('audit log write failed', err.message);
  }
}
