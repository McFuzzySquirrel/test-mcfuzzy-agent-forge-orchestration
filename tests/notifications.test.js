'use strict';

/**
 * Notification behaviour tests (Phase 3, task 3.5; PRD §8.2 FR-09..FR-14).
 *
 * The mailer is mocked so these tests are deterministic: they exercise the
 * real Express app + service + DB stack, but replace `src/services/mailer`'s
 * `sendEmail` with a controllable stub. This lets us assert the notification
 * contract (trigger points, subject/body content, retry-once, and FR-13
 * status recording) without depending on a live SMTP sink.
 *
 * Live SMTP delivery through the real nodemailer transport + MailHog is
 * covered separately in `tests/mailhog.test.js`.
 *
 * Covered:
 *   FR-09  create task         -> email to notify_email, subject contains title
 *   FR-10  complete task       -> email with "completed" notice
 *   FR-11  reopen a task       -> no email
 *   FR-12  update fields       -> no email
 *   FR-13  record notif_status + notified_at on the task
 *   FR-14  SMTP failure        -> retry once, notif_status=failed, request 2xx
 */

// Use a dedicated test database so this suite can run in parallel with the
// other suites (each worker truncates only its own DB between tests).
process.env.PGDATABASE = 'tasker_mail_test_notif';

// Hoisted by jest before `helpers` loads, so the app's lazy `require('./mailer')`
// resolves to this stub. It exposes both shapes the service accepts:
// `{ sendEmail }` and `{ mailer: { sendEmail } }`.
jest.mock('../src/services/mailer', () => ({
  sendEmail: jest.fn(),
  mailer: { sendEmail: jest.fn() },
}));

const mailer = require('../src/services/mailer');
const { request, setupTestDb, resetDb, closeDb, validTask } = require('./helpers');

// Both export shapes point at the same stub function (the service prefers
// `mailerModule.sendEmail`, but either works).
const sendEmail = mailer.sendEmail;

describe('Email notifications (FR-09..FR-14)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    // Default: a successful delivery. Individual tests override as needed.
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({ messageId: 'test-message-id' });
  });

  afterAll(async () => {
    await closeDb();
  });

  // --- FR-09: email on create ----------------------------------------------

  describe('creating a task (FR-09)', () => {
    it('sends an email to the task notify_email with a "created" subject', async () => {
      const res = await request
        .post('/api/tasks')
        .send(validTask({ title: 'Ship the crate' }));

      expect(res.status).toBe(201);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'tester@example.com',
          subject: '[Tasker Mail] Task created: Ship the crate',
          text: expect.stringContaining('Ship the crate'),
        })
      );
    });

    it('records notif_status=sent and a notified_at timestamp (FR-13)', async () => {
      const res = await request.post('/api/tasks').send(validTask());

      expect(res.status).toBe(201);
      expect(res.body.notif_status).toBe('sent');
      expect(res.body.notified_at).toBeTruthy();
    });

    it('sends to a custom notify_email, not the default one', async () => {
      const res = await request
        .post('/api/tasks')
        .send(validTask({ notify_email: 'custom@example.com' }));

      expect(res.status).toBe(201);
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'custom@example.com' })
      );
    });
  });

  // --- FR-10: email on complete --------------------------------------------

  describe('completing a task (FR-10)', () => {
    it('sends a "completed" email on the pending -> completed transition', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      sendEmail.mockClear();

      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'tester@example.com',
          subject: '[Tasker Mail] Task completed: Write integration tests',
          text: expect.stringContaining('completed'),
        })
      );
      expect(res.body.notif_status).toBe('sent');
      expect(res.body.notified_at).toBeTruthy();
    });

    it('does not re-send when completing an already-completed task', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'completed' });
      sendEmail.mockClear();

      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  // --- FR-11: no email on reopen -------------------------------------------

  describe('reopening a task (FR-11)', () => {
    it('does not send an email when reopening a completed task', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'completed' });
      sendEmail.mockClear();

      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'pending' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.completed_at).toBeNull();
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  // --- FR-12: no email on field updates -------------------------------------

  describe('updating a task (FR-12)', () => {
    it('does not send an email when updating title/description/email', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      sendEmail.mockClear();

      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({
          title: 'Updated title',
          description: 'Updated description',
          notify_email: 'updated@example.com',
        });

      expect(res.status).toBe(200);
      expect(sendEmail).not.toHaveBeenCalled();
      // The create-time notif_status is preserved - updates don't overwrite it.
      expect(res.body.notif_status).toBe('sent');
    });
  });

  // --- FR-13: notification status recording ---------------------------------

  describe('notification status recording (FR-13)', () => {
    it('persists notif_status and notified_at on the task row', async () => {
      const created = await request.post('/api/tasks').send(validTask());

      const res = await request.get(`/api/tasks/${created.body.id}`);

      expect(res.status).toBe(200);
      expect(res.body.notif_status).toBe('sent');
      expect(res.body.notified_at).toBeTruthy();
    });
  });

  // --- FR-14: retry-once on SMTP failure ------------------------------------

  describe('SMTP failure (FR-14)', () => {
    it('retries once, records notif_status=failed, and the request still succeeds', async () => {
      sendEmail.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:9999'));

      const res = await request.post('/api/tasks').send(validTask());

      expect(sendEmail).toHaveBeenCalledTimes(2); // initial attempt + one retry
      expect(res.status).toBe(201);
      expect(res.body.notif_status).toBe('failed');
      expect(res.body.notified_at).toBeTruthy();
    });

    it('marks a failed completion email as failed without failing the API request', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      sendEmail.mockClear();
      sendEmail.mockRejectedValue(new Error('ECONNREFUSED'));

      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
      expect(sendEmail).toHaveBeenCalledTimes(2);
      expect(res.body.status).toBe('completed');
      expect(res.body.notif_status).toBe('failed');
    });
  });
});
