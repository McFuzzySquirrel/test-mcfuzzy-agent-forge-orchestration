'use strict';

/**
 * Integration tests for the task CRUD API (Phase 2, task 2.4).
 *
 * Covers the acceptance criteria in PRD §8.1 (FR-01..FR-08) and the key test
 * scenarios from PRD §15 (1-6) against a real PostgreSQL test database:
 *
 *   FR-01 create (title 1-200, description optional, valid notify_email)   -> 201
 *   FR-02 list all tasks newest-first                                       -> 200
 *   FR-03 get a single task by id                                           -> 200 | 404
 *   FR-04 update title/description/notify_email                             -> 200 | 400
 *   FR-05 mark complete (status=completed, completed_at set)                -> 200
 *   FR-06 reopen to pending (completed_at cleared)                          -> 200
 *   FR-07 delete a task                                                     -> 200 | 404
 *   FR-08 invalid input -> 400 { error }; unknown ids -> 404 { error }
 *
 * Notification behaviour (FR-09..FR-14) is asserted in the Phase 3 suite
 * (task 3.5); here we only check that a create records a notification outcome
 * instead of leaving notif_status at its untouched 'pending' default.
 */

const { request, setupTestDb, resetDb, closeDb, validTask } = require('./helpers');

describe('Task CRUD API', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  // --- FR-01: create --------------------------------------------------------

  describe('POST /api/tasks', () => {
    it('creates a task and returns 201 with the stored fields', async () => {
      const res = await request.post('/api/tasks').send(validTask());

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        title: 'Write integration tests',
        description: 'Cover every CRUD flow',
        notify_email: 'tester@example.com',
        status: 'pending',
      });
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('created_at');
      // mailer.js is wired now (Phase 3), so the create notification fires:
      // the outcome is 'sent' (MailHog up) or 'failed' (SMTP down) - never the
      // untouched 'pending' default - and notified_at is set either way (FR-13).
      expect(['sent', 'failed']).toContain(res.body.notif_status);
      expect(res.body.notified_at).toBeTruthy();
      expect(res.body.completed_at).toBeNull();
    });

    it('trims title and notify_email and stores blank descriptions as null', async () => {
      const res = await request.post('/api/tasks').send(
        validTask({
          title: '   Trimmed title   ',
          description: '   ',
          notify_email: '  trimmed@example.com  ',
        })
      );

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Trimmed title');
      expect(res.body.notify_email).toBe('trimmed@example.com');
      expect(res.body.description).toBeNull();
    });

    it('allows omitting description entirely', async () => {
      const res = await request
        .post('/api/tasks')
        .send({ title: 'No description', notify_email: 'x@example.com' });

      expect(res.status).toBe(201);
      expect(res.body.description).toBeNull();
    });

    it('accepts a title at the 200-character boundary (FR-01)', async () => {
      const res = await request.post('/api/tasks').send(
        validTask({ title: 'x'.repeat(200) })
      );

      expect(res.status).toBe(201);
      expect(res.body.title).toHaveLength(200);
    });

    it('returns 400 with the error shape when title is missing (FR-01/08, NF-04)', async () => {
      const { notify_email } = validTask();
      const res = await request.post('/api/tasks').send({ notify_email });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining('title') });
    });

    it('returns 400 when title is empty after trimming', async () => {
      const res = await request
        .post('/api/tasks')
        .send(validTask({ title: '   ' }));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining('title') });
    });

    it('returns 400 when title exceeds 200 characters', async () => {
      const res = await request
        .post('/api/tasks')
        .send(validTask({ title: 'x'.repeat(201) }));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining('title') });
    });

    it('returns 400 when notify_email is missing (FR-01/08)', async () => {
      const { title } = validTask();
      const res = await request.post('/api/tasks').send({ title });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: expect.stringContaining('notify_email'),
      });
    });

    it('returns 400 for an invalid notify_email', async () => {
      const res = await request
        .post('/api/tasks')
        .send(validTask({ notify_email: 'not-an-email' }));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: expect.stringContaining('notify_email'),
      });
    });

    it('returns 400 for a non-string description', async () => {
      const res = await request
        .post('/api/tasks')
        .send(validTask({ description: 12345 }));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining('description') });
    });

    it('returns 400 for malformed JSON with the error shape (NF-04)', async () => {
      const res = await request
        .post('/api/tasks')
        .set('Content-Type', 'application/json')
        .send('{ not json');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    });
  });

  // --- FR-02: list ----------------------------------------------------------

  describe('GET /api/tasks', () => {
    it('returns an empty array when no tasks exist', async () => {
      const res = await request.get('/api/tasks');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('lists all tasks ordered newest-first (FR-02)', async () => {
      await request.post('/api/tasks').send(validTask({ title: 'First' }));
      // Slight delay so created_at differs and ordering is observable.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await request.post('/api/tasks').send(validTask({ title: 'Second' }));

      const res = await request.get('/api/tasks');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].title).toBe('Second');
      expect(res.body[1].title).toBe('First');
    });
  });

  // --- FR-03: get by id -----------------------------------------------------

  describe('GET /api/tasks/:id', () => {
    it('returns a single task by id (FR-03)', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      const res = await request.get(`/api/tasks/${created.body.id}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(created.body);
    });

    it('returns 404 for an unknown id (FR-08)', async () => {
      const res = await request.get('/api/tasks/999999');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Task not found' });
    });

    it('returns 400 for a non-numeric id (FR-08)', async () => {
      const res = await request.get('/api/tasks/abc');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining('id') });
    });

    it('returns 400 for a non-positive id (FR-08)', async () => {
      const res = await request.get('/api/tasks/0');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining('id') });
    });
  });

  // --- FR-04: update fields -------------------------------------------------

  describe('PATCH /api/tasks/:id (field updates)', () => {
    it('updates title, description, and notify_email (FR-04)', async () => {
      const created = await request.post('/api/tasks').send(validTask());

      const res = await request.patch(`/api/tasks/${created.body.id}`).send({
        title: 'Updated title',
        description: 'Updated description',
        notify_email: 'updated@example.com',
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        title: 'Updated title',
        description: 'Updated description',
        notify_email: 'updated@example.com',
      });
      // Field updates must not change lifecycle fields (FR-05/FR-06).
      expect(res.body.status).toBe('pending');
      expect(res.body.completed_at).toBeNull();
      expect(res.body.id).toBe(created.body.id);
    });

    it('applies a partial update - only the provided field changes (FR-04)', async () => {
      const created = await request.post('/api/tasks').send(
        validTask({ title: 'Original title' })
      );

      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ title: 'Only title changed' });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Only title changed');
      expect(res.body.description).toBe('Cover every CRUD flow');
      expect(res.body.notify_email).toBe('tester@example.com');
    });

    it('returns 400 for an empty body (no updatable fields)', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      const res = await request.patch(`/api/tasks/${created.body.id}`).send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it('returns 400 when an update contains an invalid email', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ notify_email: 'nope' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining('notify_email') });
    });

    it('returns 400 when an update contains an empty title', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ title: '' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining('title') });
    });

    it('returns 404 when updating an unknown id', async () => {
      const res = await request
        .patch('/api/tasks/999999')
        .send({ title: 'Ghost' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Task not found' });
    });
  });

  // --- FR-05 / FR-06: complete and reopen -----------------------------------

  describe('PATCH /api/tasks/:id (status transitions)', () => {
    it('marks a task complete, setting status and completed_at (FR-05)', async () => {
      const created = await request.post('/api/tasks').send(validTask());

      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.completed_at).toBeTruthy();
    });

    it('reopens a completed task back to pending, clearing completed_at (FR-06)', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'completed' });

      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'pending' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.completed_at).toBeNull();
    });

    it('is idempotent when completing an already-completed task', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'completed' });

      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
    });

    it('is idempotent when reopening an already-pending task', async () => {
      const created = await request.post('/api/tasks').send(validTask());

      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'pending' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
    });

    it('returns 400 for an invalid status value (FR-08)', async () => {
      const created = await request.post('/api/tasks').send(validTask());

      const res = await request
        .patch(`/api/tasks/${created.body.id}`)
        .send({ status: 'archived' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: expect.stringContaining('status'),
      });
    });

    it('returns 404 when completing an unknown id', async () => {
      const res = await request
        .patch('/api/tasks/999999')
        .send({ status: 'completed' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Task not found' });
    });
  });

  // --- FR-07: delete --------------------------------------------------------

  describe('DELETE /api/tasks/:id', () => {
    it('deletes a task and confirms with { ok: true } (FR-07)', async () => {
      const created = await request.post('/api/tasks').send(validTask());

      const res = await request.delete(`/api/tasks/${created.body.id}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('returns 404 on a subsequent get of a deleted task', async () => {
      const created = await request.post('/api/tasks').send(validTask());
      await request.delete(`/api/tasks/${created.body.id}`);

      const res = await request.get(`/api/tasks/${created.body.id}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Task not found' });
    });

    it('returns 404 when deleting an unknown id (FR-08)', async () => {
      const res = await request.delete('/api/tasks/999999');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Task not found' });
    });

    it('returns 400 for a non-numeric id', async () => {
      const res = await request.delete('/api/tasks/abc');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining('id') });
    });
  });

  // --- NF-04: consistent error shape ----------------------------------------

  describe('error contract', () => {
    it('returns a JSON { error } body for an unknown route', async () => {
      const res = await request.get('/api/does-not-exist');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    });

    it('returns JSON for every response (content-type)', async () => {
      const bad = await request.post('/api/tasks').send({});
      expect(bad.headers['content-type']).toMatch(/application\/json/);

      const ok = await request.get('/api/tasks');
      expect(ok.headers['content-type']).toMatch(/application\/json/);
    });
  });
});
