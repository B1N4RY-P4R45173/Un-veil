// Data retention: anonymous chats should not be kept forever. Message bodies older than
// MESSAGE_RETENTION_DAYS are deleted unless an open report still needs them as evidence.
import { config } from '../config.js';
import { query } from '../db.js';

export async function runRetention() {
  const messages = await query(
    `DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)
       AND session_id NOT IN (SELECT session_id FROM reports WHERE status = 'open' AND session_id IS NOT NULL)`,
    [config.messageRetentionDays],
  );
  await query("DELETE FROM email_otps WHERE expires_at < now() - interval '1 day'");
  await query("DELETE FROM audit_log WHERE created_at < now() - interval '365 days'");
  return { messagesDeleted: messages.rowCount };
}

export function scheduleRetention(everyMs = 60 * 60 * 1000) {
  const run = () => runRetention().catch((err) => console.error('retention job failed', err.message));
  run();
  setInterval(run, everyMs).unref();
}
