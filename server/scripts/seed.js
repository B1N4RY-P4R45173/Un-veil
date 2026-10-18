import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

const colleges = [
  ['Amrita Vishwa Vidyapeetham, Amritapuri', 'am.students.amrita.edu'],
  ['Amrita Vishwa Vidyapeetham, Coimbatore', 'cb.students.amrita.edu'],
  ['Amrita Vishwa Vidyapeetham, Bengaluru', 'bl.students.amrita.edu'],
  ['Demo University', 'demo.edu'],
  ['Sample College', 'sample.edu'],
];

for (const [name, domain] of colleges) {
  await pool.query(
    'INSERT INTO colleges (name, email_domain) VALUES ($1, $2) ON CONFLICT (email_domain) DO NOTHING',
    [name, domain],
  );
}
console.log(`Seeded ${colleges.length} colleges.`);

const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, role, status)
     VALUES (lower($1), $2, 'Administrator', 'admin', 'active')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', status = 'active'`,
    [ADMIN_EMAIL, hash],
  );
  console.log(`Admin account ready: ${ADMIN_EMAIL}`);
} else {
  console.log('Set ADMIN_EMAIL and ADMIN_PASSWORD to create an admin account.');
}
await pool.end();
