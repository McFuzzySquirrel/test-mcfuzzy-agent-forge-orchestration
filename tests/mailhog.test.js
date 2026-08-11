'use strict';

/**
 * Live SMTP delivery tests (Phase 3, task 3.5; PRD §15 scenarios 7-8).
 *
 * Unlike `tests/notifications.test.js` (which mocks the mailer to pin the
 * notification contract), this suite drives the REAL nodemailer transport
 * against the MailHog dev sink and asserts on MailHog's JSON API that the
 * messages actually landed with the right recipients and subjects.
 *
 * The suite is skipped when MailHog is unreachable (e.g. `docker compose` is
 * not running), so `npm test` stays green in environments without the mail
 * sink (NF-02: no external network required).
 *
 * Covered:
 *   FR-09  create task  -> email delivered to notify_email with a "created"
 *                          subject containing the task title
 *   FR-10  complete task -> email delivered with a "completed" subject
 */

// Use a dedicated test database so this suite can run in parallel with the
// other suites (each worker truncates only its own DB between tests).
process.env.PGDATABASE = 'tasker_mail_test_mailhog';

const { execFileSync } = require('child_process');
const { request, setupTestDb, resetDb, closeDb, validTask } = require('./helpers');

const MAILHOG_API_URL = process.env.MAILHOG_API_URL || 'http://localhost:8025';

/**
 * Synchronously probe the MailHog JSON API (used at module load so the suite
 * can be built with `describe.skipIf`). Spawns a tiny node process so the
 * check is blocking; a missing sink returns false without failing the suite.
 */
function mailhogAvailable() {
  try {
    execFileSync(
      'node',
      [
        '-e',
        `fetch('${MAILHOG_API_URL}/api/v2/messages')
           .then((r) => process.exit(r.ok ? 0 : 1))
           .catch(() => process.exit(1))`,
      ],
      { timeout: 5000, stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}

const MAILHOG_UP = mailhogAvailable();

/**
 * Unique per-run suffix for recipient addresses. MailHog retains messages
 * across runs, so fixed addresses would accumulate and break the exact-count
 * assertions below; a run-scoped suffix keeps every run deterministic.
 */
const RUN_SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Fetch all messages currently held by MailHog. */
async function listMessages() {
  const res = await fetch(`${MAILHOG_API_URL}/api/v2/messages`);
  if (!res.ok) {
    throw new Error(`MailHog API returned ${res.status}`);
  }
  const body = await res.json();
  return body.items || [];
}

/** Normalise a MailHog header (always an array of strings) into one string. */
function headerValue(message, name) {
  const headers = message.Content && message.Content.Headers;
  const value = headers && headers[name];
  return Array.isArray(value) ? value.join('') : '';
}

// `describe.skip` is always defined; bind conditionally so the suite is
// skipped (not failed) when the MailHog sink is unavailable.
const describeMailhog = MAILHOG_UP ? describe : describe.skip;
describeMailhog('MailHog email delivery (FR-09, FR-10)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('delivers a "created" email to the task notify_email (FR-09)', async () => {
    const email = `create-notif-${RUN_SUFFIX}@example.com`;
    const res = await request
      .post('/api/tasks')
      .send(validTask({ title: 'Mailhog create check', notify_email: email }));

    expect(res.status).toBe(201);
    expect(res.body.notif_status).toBe('sent');

    const messages = await listMessages();
    const matching = messages.filter(
      (m) =>
        headerValue(m, 'To').includes(email) &&
        headerValue(m, 'Subject').includes('Task created')
    );

    expect(matching).toHaveLength(1);
    expect(headerValue(matching[0], 'Subject')).toBe(
      '[Tasker Mail] Task created: Mailhog create check'
    );
  });

  it('delivers a "completed" email on the pending -> completed transition (FR-10)', async () => {
    const email = `complete-notif-${RUN_SUFFIX}@example.com`;
    const created = await request
      .post('/api/tasks')
      .send(validTask({ title: 'Mailhog complete check', notify_email: email }));

    const res = await request
      .patch(`/api/tasks/${created.body.id}`)
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.notif_status).toBe('sent');

    const messages = await listMessages();
    const matching = messages.filter(
      (m) =>
        headerValue(m, 'To').includes(email) &&
        headerValue(m, 'Subject').includes('Task completed')
    );

    expect(matching).toHaveLength(1);
    expect(headerValue(matching[0], 'Subject')).toBe(
      '[Tasker Mail] Task completed: Mailhog complete check'
    );
  });

  it('sends separate emails for create and complete (one each)', async () => {
    const email = `two-notifs-${RUN_SUFFIX}@example.com`;
    const created = await request
      .post('/api/tasks')
      .send(validTask({ title: 'Two mailhog checks', notify_email: email }));
    await request
      .patch(`/api/tasks/${created.body.id}`)
      .send({ status: 'completed' });

    const messages = await listMessages();
    const toThisRecipient = messages.filter((m) =>
      headerValue(m, 'To').includes(email)
    );
    const subjects = toThisRecipient.map((m) => headerValue(m, 'Subject'));

    expect(toThisRecipient).toHaveLength(2);
    expect(subjects).toEqual(
      expect.arrayContaining([
        '[Tasker Mail] Task created: Two mailhog checks',
        '[Tasker Mail] Task completed: Two mailhog checks',
      ])
    );
  });
});
