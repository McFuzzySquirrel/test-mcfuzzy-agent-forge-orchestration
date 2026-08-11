-- 001_init.sql
-- Initial Tasker Mail schema: the `tasks` table.
--
-- Column notes (see docs/PRD.md):
--   title          FR-01: required, 1-200 chars (enforced here and in the API)
--   notify_email   FR-01: required recipient for notification emails
--   status         lifecycle pending -> completed -> pending (Section 13)
--   completed_at   set when status becomes completed (FR-05), cleared on reopen (FR-06)
--   notif_status   FR-13: pending / sent / failed after the last email attempt
--   notified_at    FR-13: timestamp of the last notification attempt
--   created_at     FR-02: tasks are listed newest-first

CREATE TABLE tasks (
    id            serial PRIMARY KEY,
    title         text        NOT NULL
                  CONSTRAINT tasks_title_length
                  CHECK (char_length(title) BETWEEN 1 AND 200),
    description   text,
    notify_email  text        NOT NULL,
    status        text        NOT NULL DEFAULT 'pending'
                  CONSTRAINT tasks_status_value
                  CHECK (status IN ('pending', 'completed')),
    completed_at  timestamptz,
    notif_status  text        NOT NULL DEFAULT 'pending'
                  CONSTRAINT tasks_notif_status_value
                  CHECK (notif_status IN ('pending', 'sent', 'failed')),
    notified_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Support the default list ordering (FR-02: newest first).
CREATE INDEX tasks_created_at_idx ON tasks (created_at DESC);
