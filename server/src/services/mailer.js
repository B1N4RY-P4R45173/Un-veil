import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transport = config.smtp ? nodemailer.createTransport(config.smtp) : null;

// Captured in tests so they can read the OTP without a mail server.
export const outbox = [];

export async function sendMail({ to, subject, text, html }) {
  if (config.isTest) {
    outbox.push({ to, subject, text, html });
    return;
  }
  if (!transport) {
    console.log(`\n[mail:dev] To: ${to}\n[mail:dev] Subject: ${subject}\n[mail:dev] ${text}\n`);
    return;
  }
  await transport.sendMail({ from: config.mailFrom, to, subject, text, html });
}
