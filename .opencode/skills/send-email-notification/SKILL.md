---
name: send-email-notification
description: >
  Sends a Tasker Mail notification email for a task event (created or completed) via
  nodemailer and records the delivery status on the task. Use this when wiring email
  side-effects into the task service, fixing notification bugs, or adding a new
  notification trigger.
---

# Skill: Send Email Notification

Fires a notification email for a task event, updates `notif_status`/`notified_at`, and handles the retry-once failure path - the shared pattern behind Tasker Mail's create and complete notifications.

---

## Process

### Step 1: Build the Message

```javascript
const { mailer } = require('../services/mailer');

const subject =
  event === 'created'
    ? `[Tasker Mail] Task created: ${task.title}`
    : `[Tasker Mail] Task completed: ${task.title}`;

const body = `Task "${task.title}" was ${event === 'created' ? 'created' : 'completed'}.\n\nStatus: ${task.status}`;
```

### Step 2: Send with Retry-Once

Wrap the send in a retry-once loop so transient SMTP failures are absorbed without failing the API request:

```javascript
async function sendWithRetry(payload, attempts = 2) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await mailer.sendEmail(payload);
      return 'sent';
    } catch (err) {
      if (i === attempts) return 'failed';
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
```

### Step 3: Record Status on the Task

Persist the outcome so delivery is verifiable (FR-13):

```javascript
await pool.query(
  `UPDATE tasks SET notif_status = $1, notified_at = now() WHERE id = $2`,
  [outcome, task.id]
);
```

Allowed `notif_status` values: `pending` | `sent` | `failed` (PRD Section 13).

---

## Process Rules

- **Trigger only on create and on transition-to-complete.** Do **not** email on field-only updates (FR-12) or on reopening a task (FR-11).
- **Never throw into the route.** Catch all SMTP errors; the API request must succeed even when delivery fails (FR-14).
- **Overwrite, don't append.** A later notification attempt replaces the previous `notif_status` and `notified_at`.

---

## Output Format

A notification email delivered to the task's `notify_email` (verifiable in MailHog) and a task row with updated `notif_status`/`notified_at`.

---

## Validation

- [ ] Create a task -> email appears in MailHog with subject `[Tasker Mail] Task created: <title>` and `notif_status=sent`
- [ ] Complete the task -> second email with `[Tasker Mail] Task completed: <title>` and `notif_status=sent`
- [ ] Point SMTP at an unreachable port -> `notif_status=failed` and the API still returns 200
- [ ] Update or reopen a task -> no new email sent

If validation fails: check `mailer.js` transport config, confirm `SMTP_PORT` targets MailHog (1025) or a real relay, and re-run.

---

## Gotchas

- nodemailer v9 transport needs explicit `host`, `port`, and `secure`; use `secure: false` for ports 1025/587 and `secure: true` for 465
- Use the shared pool from `src/db/pool.js`; never create a new pool in the service
- Do not log email body content with credentials (SP-05)

---

## Reference

See [docs/PRD.md](../../../docs/PRD.md) for the full specification:

- **Section 8.2** - Email notification requirements FR-09..FR-14
- **Section 13** - Notification status lifecycle
- **Section 15** - Notification test scenarios 7-10
