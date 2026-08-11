'use strict';

/**
 * Tasker Mail mailer (PRD §7.2 `src/services/mailer.js`, §7.3; FR-09/FR-10).
 *
 * Thin wrapper around nodemailer that owns the SMTP transport. The transport
 * is built once from the validated environment configuration (PRD §7.3, NF-03):
 *
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS  -> transport options
 *   SMTP_FROM                                      -> "From" header
 *
 * Behaviour contract (used by tasksService.notifyTaskEvent):
 * - `sendEmail({ to, subject, text })` resolves when the message is accepted
 *   by the SMTP server and rejects on any transport error, so callers can
 *   record `notif_status` = sent|failed (FR-13) and implement retry-once
 *   (FR-14).
 * - This module owns delivery mechanics only: subject/body content and the
 *   trigger rules live in the notification seam (tasksService, FR-09..FR-14).
 * - Development sink: when no SMTP credentials are configured (empty
 *   SMTP_USER, the `.env.example` default), no AUTH is sent and the transport
 *   uses plain SMTP - matching the local MailHog stack (SMTP_HOST=localhost,
 *   SMTP_PORT=1025). A real relay is configured by setting SMTP_USER/PASS and
 *   a TLS port (465 implicit TLS, or 587 STARTTLS).
 * - Security (SP-05): this module never logs message bodies or SMTP
 *   credentials; callers log only sanitized error messages.
 */

const nodemailer = require('nodemailer');
const config = require('../config');

/** Ports using implicit TLS (per nodemailer guidance and PRD §18). */
const TLS_PORT = 465;

/**
 * Bound the SMTP round-trip so an unreachable or silent relay cannot stall the
 * request thread for nodemailer's default multi-minute timeouts. The service
 * layer retries once (FR-14), so worst case is ~2x this value.
 */
const CONNECT_TIMEOUT_MS = 10000;
const GREETING_TIMEOUT_MS = 10000;

/**
 * Build a nodemailer SMTP transport from the application config.
 *
 * Exported as a factory (in addition to the shared instance) so unit tests can
 * assert the resolved options and construct alternate transports - e.g. an
 * unreachable sink to exercise the FR-14 failure path.
 *
 * nodemailer v9 requires explicit host/port/secure: `secure` must be true for
 * the implicit-TLS port 465 and false for plain/STARTTLS ports such as 1025
 * (MailHog) or 587. Auth is only attached when a username is configured, so
 * the credential-free MailHog default needs no AUTH handshake.
 *
 * @returns {import('nodemailer').Transporter} configured nodemailer transport
 */
function createTransport() {
  const options = {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === TLS_PORT,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
  };

  if (config.SMTP_USER) {
    options.auth = { user: config.SMTP_USER, pass: config.SMTP_PASS };
  }

  return nodemailer.createTransport(options);
}

/**
 * Shared application transport. Built eagerly but lazily connected:
 * nodemailer opens no socket until the first sendMail call.
 */
const transport = createTransport();

/**
 * Send one notification email (PRD §7.3; FR-09/FR-10 delivery path).
 *
 * @param {object}   message
 * @param {string}   message.to      recipient address (task notify_email)
 * @param {string}   message.subject email subject line
 * @param {string}   message.text    plain-text body
 * @returns {Promise<object>} nodemailer send info (messageId, accepted, ...)
 * @throws {Error} on missing required fields or any SMTP transport failure,
 *                 so the caller can record the failure (FR-13/FR-14).
 */
async function sendEmail({ to, subject, text } = {}) {
  if (typeof to !== 'string' || to.trim() === '') {
    throw new Error('sendEmail: "to" (recipient address) is required');
  }
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new Error('sendEmail: "subject" is required');
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('sendEmail: "text" body is required');
  }

  return transport.sendMail({
    from: config.SMTP_FROM,
    to: to.trim(),
    subject,
    text,
  });
}

module.exports = {
  sendEmail,
  // Aliased shape so callers may consume either `mailer.sendEmail` or
  // `mailer.mailer.sendEmail` (see the send-email-notification skill).
  mailer: { sendEmail },
  // Exposed for tests / diagnostics (PRD §15 unit tests).
  createTransport,
  transport,
};
