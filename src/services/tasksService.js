'use strict';

const pool = require('../db/pool');

/**
 * Tasker Mail task service (PRD §7.2 `src/services/tasksService.js`).
 *
 * Owns all task business logic: validation (FR-01, FR-08), the CRUD queries
 * (FR-01..FR-07), and the notification trigger points (FR-09..FR-14).
 *
 * Contract notes:
 * - `getTask` / `updateTask` / `completeTask` / `reopenTask` return the task
 *   row, or `null` when the id does not exist (the route maps `null` -> 404,
 *   FR-08).
 * - `deleteTask` returns `true` when a row was removed, `false` when the id
 *   was unknown (the route maps `false` -> 404, FR-08).
 * - Invalid client input throws `ValidationError` (carries `status: 400`) so
 *   the route layer can respond 400 with the message (FR-08, NF-04).
 * - Every query is parameterized (SP-03); no user input is ever interpolated
 *   into SQL. The only dynamic SQL fragments are the fixed, hardcoded column
 *   names in the PATCH SET clause (from an allowlist, never from the client).
 */

/** Columns returned for every task-shaped response (matches the DB schema). */
const TASK_COLUMNS = `
  id, title, description, notify_email, status,
  completed_at, notif_status, notified_at, created_at
`;

/** 400-carrying error for invalid client input (mapped by the route layer). */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

/** Minimal RFC-5322-ish address check - enough for a demo app (FR-01). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate a task id from a URL param; returns it as a positive integer. */
function validateId(id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new ValidationError(`Invalid task id: "${id}"`);
  }
  return numeric;
}

/** FR-01: title is required and 1-200 characters (after trimming). */
function validateTitle(title) {
  if (typeof title !== 'string') {
    throw new ValidationError('title is required and must be a string');
  }
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new ValidationError('title must be between 1 and 200 characters');
  }
  return trimmed;
}

/** FR-01: notify_email is required and must look like an email address. */
function validateNotifyEmail(email) {
  if (typeof email !== 'string') {
    throw new ValidationError('notify_email is required and must be a valid email address');
  }
  const trimmed = email.trim();
  if (!EMAIL_RE.test(trimmed)) {
    throw new ValidationError('notify_email must be a valid email address');
  }
  return trimmed;
}

/** FR-01: description is optional; blank values are stored as NULL. */
function normalizeDescription(description) {
  if (description === undefined || description === null) {
    return null;
  }
  if (typeof description !== 'string') {
    throw new ValidationError('description must be a string');
  }
  const trimmed = description.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Send a notification payload with a single in-process retry on SMTP failure
 * (FR-14), returning the delivery outcome ('sent' | 'failed'). Never throws -
 * the API request must succeed even when delivery fails.
 */
async function sendWithRetry(sendEmail, payload, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await sendEmail(payload);
      return 'sent';
    } catch (err) {
      if (attempt === attempts) {
        // Sanitized server-side log only (SP-05) - never the email body.
        console.error('[tasks] notification delivery failed:', err.message);
        return 'failed';
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return 'failed';
}

/**
 * Notification seam (PRD §7.3, FR-09..FR-14).
 *
 * Called after a task is created and after a task transitions to completed -
 * and only then: field-only updates (FR-12) and reopens (FR-11) never reach
 * this function.
 *
 * The SMTP transport itself is owned by the notifications-specialist:
 * `src/services/mailer.js` (Phase 3, task 3.1). It is required lazily here so
 * this module loads and works before that file exists (Phase 2). The expected
 * export shapes are either `{ sendEmail }` or `{ mailer: { sendEmail } }`
 * (see the send-email-notification skill), accepting
 * `sendEmail({ to, subject, text })`.
 *
 * - Mailer not wired yet -> returns null; `notif_status` stays 'pending' and
 *   task CRUD is unaffected.
 * - Mailer wired -> sends (retry-once, FR-14), records the outcome on the
 *   task (FR-13), and returns `{ notif_status, notified_at }`.
 * - Never throws into the caller; SMTP errors are absorbed by the retry.
 */
async function notifyTaskEvent(task, event) {
  let mailerModule;
  try {
    mailerModule = require('./mailer');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      // Phase 2: mailer.js not implemented yet - skip the notification.
      return null;
    }
    throw err;
  }

  const sendEmail =
    (mailerModule && typeof mailerModule.sendEmail === 'function'
      ? mailerModule.sendEmail
      : null) ||
    (mailerModule &&
    mailerModule.mailer &&
    typeof mailerModule.mailer.sendEmail === 'function'
      ? mailerModule.mailer.sendEmail
      : null);

  if (typeof sendEmail !== 'function') {
    return null;
  }

  const verb = event === 'completed' ? 'completed' : 'created';
  const subject = `[Tasker Mail] Task ${verb}: ${task.title}`;
  const text = `Task "${task.title}" was ${verb}.\n\nStatus: ${task.status}`;

  const outcome = await sendWithRetry(sendEmail, {
    to: task.notify_email,
    subject,
    text,
  });

  // FR-13: overwrite, don't append - a later attempt replaces the previous
  // notif_status and notified_at.
  const { rows } = await pool.query(
    `UPDATE tasks SET notif_status = $1, notified_at = now()
     WHERE id = $2
     RETURNING notified_at`,
    [outcome, task.id]
  );

  return { notif_status: outcome, notified_at: rows[0].notified_at };
}

/** Merge a recorded notification result into an in-memory task row. */
function applyNotification(task, notification) {
  if (notification) {
    task.notif_status = notification.notif_status;
    task.notified_at = notification.notified_at;
  }
  return task;
}

/**
 * FR-01: create a task with title (1-200 chars), optional description, and a
 * valid notify_email. FR-09: a "created" notification fires afterwards and its
 * outcome is recorded on the returned task (FR-13).
 */
async function createTask({ title, description, notify_email } = {}) {
  const values = [
    validateTitle(title),
    normalizeDescription(description),
    validateNotifyEmail(notify_email),
  ];

  const { rows } = await pool.query(
    `INSERT INTO tasks (title, description, notify_email)
     VALUES ($1, $2, $3)
     RETURNING ${TASK_COLUMNS}`,
    values
  );

  const task = rows[0];
  // Await so notif_status is recorded before the response is built (FR-13).
  // notifyTaskEvent never throws, so a mailer outage cannot fail the create.
  return applyNotification(task, await notifyTaskEvent(task, 'created'));
}

/** FR-02: list all tasks ordered newest-first (ties broken by id, also newest). */
async function listTasks() {
  const { rows } = await pool.query(
    `SELECT ${TASK_COLUMNS}
     FROM tasks
     ORDER BY created_at DESC, id DESC`
  );
  return rows;
}

/** FR-03: get a single task by id; returns null when the id is unknown. */
async function getTask(id) {
  const cleanId = validateId(id);
  const { rows } = await pool.query(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`,
    [cleanId]
  );
  return rows[0] || null;
}

/**
 * FR-04: partially update a task's title/description/notify_email (PATCH
 * semantics - only provided fields change). Returns the updated task, or null
 * when the id is unknown. Never triggers a notification (FR-12).
 */
async function updateTask(id, fields = {}) {
  const cleanId = validateId(id);

  const updates = [];
  const values = [];

  if (fields.title !== undefined) {
    updates.push(`title = $${values.length + 1}`);
    values.push(validateTitle(fields.title));
  }
  if (fields.description !== undefined) {
    updates.push(`description = $${values.length + 1}`);
    values.push(normalizeDescription(fields.description));
  }
  if (fields.notify_email !== undefined) {
    updates.push(`notify_email = $${values.length + 1}`);
    values.push(validateNotifyEmail(fields.notify_email));
  }

  if (updates.length === 0) {
    throw new ValidationError(
      'At least one of title, description, or notify_email is required'
    );
  }

  // Column names above come from a fixed allowlist; the values are always
  // parameterized (SP-03).
  values.push(cleanId);
  const { rows } = await pool.query(
    `UPDATE tasks SET ${updates.join(', ')}
     WHERE id = $${values.length}
     RETURNING ${TASK_COLUMNS}`,
    values
  );
  return rows[0] || null;
}

/**
 * FR-05: mark a task complete (status=completed, completed_at=now). The
 * transition only fires for pending tasks, so completing an already-completed
 * task is idempotent and does not re-send the notification (FR-10).
 * Returns the updated task, or null when the id is unknown.
 */
async function completeTask(id) {
  const cleanId = validateId(id);

  const { rows } = await pool.query(
    `UPDATE tasks
     SET status = 'completed', completed_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING ${TASK_COLUMNS}`,
    [cleanId]
  );

  if (rows.length > 0) {
    // FR-10: notify on the pending -> completed transition only.
    return applyNotification(rows[0], await notifyTaskEvent(rows[0], 'completed'));
  }

  // No transition happened: either the id is unknown (null -> 404) or the task
  // was already completed (return the current row unchanged, no email).
  return getTask(cleanId);
}

/**
 * FR-06: reopen a completed task (status=pending, completed_at=NULL). No
 * notification fires (FR-11). Idempotent for already-pending tasks; returns
 * null when the id is unknown.
 */
async function reopenTask(id) {
  const cleanId = validateId(id);

  const { rows } = await pool.query(
    `UPDATE tasks
     SET status = 'pending', completed_at = NULL
     WHERE id = $1 AND status = 'completed'
     RETURNING ${TASK_COLUMNS}`,
    [cleanId]
  );

  if (rows.length > 0) {
    return rows[0];
  }

  // Either unknown (null -> 404) or already pending (return the current row).
  return getTask(cleanId);
}

/** FR-07: delete a task; returns true when removed, false when id unknown. */
async function deleteTask(id) {
  const cleanId = validateId(id);
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [
    cleanId,
  ]);
  return rowCount > 0;
}

module.exports = {
  createTask,
  listTasks,
  getTask,
  updateTask,
  completeTask,
  reopenTask,
  deleteTask,
  ValidationError,
};
