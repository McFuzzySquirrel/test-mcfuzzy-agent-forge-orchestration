'use strict';

const { Router } = require('express');
const tasksService = require('../services/tasksService');

/**
 * Task REST router (PRD §7.2 `src/routes/tasks.js`, Phase 2 task 2.2).
 *
 * Thin HTTP layer over `tasksService`: it extracts request data, delegates to
 * the service (which owns all validation and SQL), and maps results/errors to
 * the HTTP contract in PRD §7.3 / §8.1:
 *
 *   Method  Path            Purpose                        Status
 *   GET     /api/tasks      List all tasks (FR-02)         200
 *   POST    /api/tasks      Create a task (FR-01)          201
 *   GET     /api/tasks/:id  Get a single task (FR-03)      200 | 404
 *   PATCH   /api/tasks/:id  Update fields, or complete /
 *                           reopen (FR-04..FR-06)          200 | 400 | 404
 *   DELETE  /api/tasks/:id  Delete a task (FR-07)          200 | 404
 *
 * Error mapping (FR-08, NF-04):
 *   - `tasksService.ValidationError` (status 400) propagates to the central
 *     error handler, which responds 400 with `{ error: message }`.
 *   - Unknown ids are signalled by the service as `null` (get/update/complete/
 *     reopen) or `false` (delete) and mapped here to 404.
 *   - The service never throws for a missing row, so the distinction between
 *     "bad id format" (400) and "unknown id" (404) is deterministic.
 *
 * Notifications are NOT sent from this layer: the service triggers emails on
 * create/complete only (FR-09..FR-14), so this file stays free of mailer
 * concerns.
 */

/** Wrap an async handler so rejections reach the central error handler. */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Shared 404 body - consistent error shape (NF-04). */
function notFound(res) {
  res.status(404).json({ error: 'Task not found' });
}

const router = Router();

/**
 * FR-02: list all tasks, newest first.
 * GET /api/tasks
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const tasks = await tasksService.listTasks();
    res.status(200).json(tasks);
  })
);

/**
 * FR-01: create a task from `{ title, description?, notify_email }`.
 * POST /api/tasks -> 201 with the created task. Invalid input (missing title,
 * bad email, non-string description) throws ValidationError -> 400.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const task = await tasksService.createTask(req.body || {});
    res.status(201).json(task);
  })
);

/**
 * FR-03: get a single task.
 * GET /api/tasks/:id -> 200 with the task, 404 when the id is unknown,
 * 400 when the id is not a positive integer.
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const task = await tasksService.getTask(req.params.id);
    if (!task) {
      notFound(res);
      return;
    }
    res.status(200).json(task);
  })
);

/**
 * FR-04..FR-06: update fields OR transition status.
 * PATCH /api/tasks/:id
 *
 * The request body drives which operation runs:
 *   - `{ status: 'completed' }` -> mark complete (FR-05, sends email)
 *   - `{ status: 'pending' }`   -> reopen (FR-06, no email)
 *   - anything else             -> partial field update of title/description/
 *                                  notify_email only (FR-04, no email)
 * A status value other than the two above is rejected with 400; an empty or
 * field-less body is rejected by the service with 400. Unknown ids -> 404.
 */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const body = req.body || {};

    let task;
    if (body.status !== undefined) {
      if (body.status === 'completed') {
        task = await tasksService.completeTask(id);
      } else if (body.status === 'pending') {
        task = await tasksService.reopenTask(id);
      } else {
        throw new tasksService.ValidationError(
          'status must be "completed" or "pending"'
        );
      }
    } else {
      task = await tasksService.updateTask(id, body);
    }

    if (!task) {
      notFound(res);
      return;
    }
    res.status(200).json(task);
  })
);

/**
 * FR-07: delete a task.
 * DELETE /api/tasks/:id -> 200 with `{ ok: true }`, 404 when the id is unknown,
 * 400 when the id is not a positive integer.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const removed = await tasksService.deleteTask(req.params.id);
    if (!removed) {
      notFound(res);
      return;
    }
    res.status(200).json({ ok: true });
  })
);

module.exports = router;
