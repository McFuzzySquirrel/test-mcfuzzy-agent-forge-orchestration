# Tasker Mail - Task Manager with Email Notifications

## 1. Overview

**Product Name:** Tasker Mail
**Summary:** A simple task manager web application. Users create, list, update, and complete tasks. Every time a task is created or marked complete, the application sends an email notification to the task's configured recipient email address via SMTP.
**Target Platform:** Server-side Node.js web application (Express + PostgreSQL). Delivered as a REST API with a minimal server-rendered web UI for browser use.
**Key Constraints:** Must send reliable email notifications on task create and task complete events. Must be runnable locally with Docker Compose for PostgreSQL. No external SaaS dependency beyond a standard SMTP server (can be a local dev sink such as MailHog).

---

## 2. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-08-11 | Agent Forge | Initial PRD |

---

## 3. Goals and Non-Goals

### 3.1 Goals
- Provide a simple task manager: create, read, update, complete, and delete tasks.
- Send an email notification automatically when a task is created.
- Send an email notification automatically when a task is marked complete.
- Store all tasks and notification status in PostgreSQL.
- Expose the full feature set through a clean REST API that can be consumed by any client.
- Provide a minimal, usable web UI on top of the same API so the product is demonstrable in a browser.

### 3.2 Non-Goals
- No user accounts, authentication, or multi-tenancy in v1 (single-user / per-task recipient email).
- No task assignment, due dates, priority fields, projects, or tags in v1 (kept for future versions).
- No email templating engine or marketing email features.
- No mobile or native clients in v1.
- No background job queue / retry infrastructure beyond a simple in-process retry (resilient queuing is a future consideration).

---

## 4. User Stories / Personas

### 4.1 Personas

| Persona | Description | Key Needs |
|---------|-------------|-----------|
| Solo user | Individual managing personal or work tasks | Create and complete tasks, get email confirmation without opening the app |
| Developer integrator | Builds a small internal tool that drives tasks programmatically | A stable REST API with clear request/response contracts |

### 4.2 User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| US-01 | Solo user | Create a task with a title, description, and recipient email | I receive an email confirming the task was created | Must |
| US-02 | Solo user | List all my tasks with their status | I can see what is pending vs completed | Must |
| US-03 | Solo user | Update a task's title/description/email | I can correct mistakes | Must |
| US-04 | Solo user | Mark a task complete | I receive an email confirming completion | Must |
| US-05 | Solo user | Delete a task | I can remove obsolete tasks | Must |
| US-06 | Solo user | Mark a task back to pending | I can reopen a mistakenly completed task | Should |
| US-07 | Developer integrator | Interact with tasks over a REST API | I can automate task management | Must |
| US-08 | Solo user | See whether the notification email was delivered | I can trust the notifications | Should |

---

## 5. Research Findings

### Technology selection
- **Node.js (v22 LTS) + Express 5** — the requested stack. Express 5.2.x is current and actively maintained. Express 5 is stable and the default on npm since late 2025.
- **PostgreSQL (pg 8.23.x)** — the requested database. `node-postgres` is the de facto driver and is actively maintained. PostgreSQL 16+ is current.
- **nodemailer 9.x** — the standard, actively maintained Node.js email library. Supports SMTP and direct transport.
- **Jest 30 + supertest 7** — current, widely used test stack for Node HTTP applications.

### Notification design
- Email is sent **synchronously within the request** for v1 simplicity, with an in-process retry (2 attempts) on SMTP failure. The notification result (sent/failed) is recorded on the task so users can see delivery status (US-08). A background queue is explicitly deferred to Future Considerations.
- SMTP credentials are supplied via environment variables; development defaults point at a local MailHog sink so the app is fully testable without a real mail server.

### API design
- RESTful, resource-oriented endpoints under `/api/tasks`. JSON request/response bodies. HTTP status codes: 201 (created), 200 (ok), 400 (validation), 404 (not found), 500 (internal error).

---

## 6. Concept

### 6.1 Core Loop / Workflow

```
User creates task (POST /api/tasks)
        │
        ▼
Validate input → insert row (status=pending, notif_status=pending)
        │
        ▼
Send "task created" email to task.notify_email   ──► record notif_status=sent/failed
        │
        ▼
User marks complete (PATCH /api/tasks/:id)  ──► status=completed, completed_at=now
        │
        ▼
Send "task completed" email   ──► record notif_status=sent/failed
```

### 6.2 Success / Completion Criteria
- A task can be created, listed, updated, completed, reopened, and deleted through both the API and the web UI.
- Creating a task produces an email to the specified recipient.
- Completing a task produces an email to the specified recipient.
- Every task row records the last notification status so delivery can be verified.
- All API and UI flows pass the automated test suite.

---

## 7. Technical Architecture

### 7.1 Technology Stack

| Component | Technology | Version Notes |
|-----------|------------|---------------|
| Runtime | Node.js | v22 LTS |
| Web framework | Express | ^5.2.1 |
| Database driver | node-postgres (`pg`) | ^8.23.0 |
| Database | PostgreSQL | 16+ (Docker image `postgres:16-alpine`) |
| Email | nodemailer | ^9.0.5 |
| Config | dotenv | ^17.4.2 |
| Tests | Jest + supertest | ^30.4.2 / ^7.2.2 |
| Dev mail sink | MailHog | Docker image `mailhog/mailhog` |

### 7.2 Project Structure

```
tasker-mail/
├── .env.example
├── .gitignore
├── docker-compose.yml          # PostgreSQL + MailHog
├── package.json
├── src/
│   ├── server.js               # Express app bootstrap
│   ├── index.js                # listen() entrypoint
│   ├── config.js               # env loading + validation
│   ├── db/
│   │   ├── pool.js             # pg Pool
│   │   └── migrations/
│   │       └── 001_init.sql    # tasks table
│   ├── routes/
│   │   └── tasks.js            # task REST router
│   ├── services/
│   │   ├── tasksService.js     # task CRUD + notification trigger
│   │   └── mailer.js           # nodemailer wrapper
│   ├── middleware/
│   │   └── errorHandler.js     # central error handling
│   └── public/
│       ├── index.html          # minimal UI
│       └── app.js              # fetch-based UI client
└── tests/
    ├── tasks.test.js           # supertest integration tests
    └── helpers.js
```

### 7.3 Key APIs / Interfaces

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/tasks` | List all tasks |
| POST | `/api/tasks` | Create a task (title, description, notify_email) |
| GET | `/api/tasks/:id` | Get a single task |
| PATCH | `/api/tasks/:id` | Update fields or mark complete/incomplete |
| DELETE | `/api/tasks/:id` | Delete a task |
| GET | `/health` | Liveness check (db reachable) |

`mailer.js` exposes `sendEmail({ to, subject, text })`; `tasksService.js` calls it after create and after complete transitions.

---

## 8. Functional Requirements

### 8.1 Task CRUD

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-01 | User can create a task with `title` (required, 1–200 chars), `description` (optional), and `notify_email` (required, valid email) | Must |
| FR-02 | User can list all tasks ordered by creation date (newest first) | Must |
| FR-03 | User can retrieve a single task by id | Must |
| FR-04 | User can update a task's title, description, or notify_email | Must |
| FR-05 | User can mark a task complete (sets `status=completed`, `completed_at`) | Must |
| FR-06 | User can mark a task back to pending (clears `completed_at`) | Should |
| FR-07 | User can delete a task | Must |
| FR-08 | Invalid input returns a 400 with a descriptive error message; unknown ids return 404 | Must |

### 8.2 Email Notifications

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-09 | When a task is created, an email is sent to the task's `notify_email` with subject containing the task title and a "created" notice | Must |
| FR-10 | When a task transitions to complete, an email is sent to `notify_email` with a "completed" notice | Must |
| FR-11 | Reopening a task (back to pending) does **not** trigger an email | Should |
| FR-12 | Updating title/description/email does **not** trigger an email | Must |
| FR-13 | The task records `notif_status` (`pending`/`sent`/`failed`) and a timestamp so delivery can be verified | Must |
| FR-14 | On SMTP failure the app retries once (in-process, short delay) before marking `notif_status=failed`; the API request still succeeds | Must |

### 8.3 Web UI

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-15 | The root `/` serves a minimal HTML page listing tasks with a create form | Should |
| FR-16 | The UI allows marking tasks complete and deleting them | Should |
| FR-17 | The UI shows each task's status and notification status | Should |

---

## 9. Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF-01 | App starts with `npm start`; DB and mail sink start with `docker compose up` | Must |
| NF-02 | Tests run with `npm test` and require no external network access (MailHog for SMTP) | Must |
| NF-03 | All env config is read from a `.env` file; `.env.example` documents every variable with a default | Must |
| NF-04 | API responses are JSON with consistent error shape `{ "error": "..." }` | Must |
| NF-05 | Database schema is versioned via a simple SQL migration applied on startup | Must |
| NF-06 | Application performance is sufficient for single-user/small-team usage (<100 tasks) with no caching layer | Should |
| NF-07 | Code is formatted consistently and linted (`npm run lint` if a linter is configured) | Should |

---

## 10. Security and Privacy

| ID | Requirement | Priority |
|----|-------------|----------|
| SP-01 | Email addresses and task content are treated as user data; no data leaves the system except to the configured SMTP server | Must |
| SP-02 | SMTP credentials are stored in `.env` only (never committed); `.env` is gitignored | Must |
| SP-03 | SQL is parameterized (prepared statements) throughout; no string-concatenated queries | Must |
| SP-04 | Express JSON body parser is size-limited (e.g., 100kb) to prevent oversized payloads | Must |
| SP-05 | No sensitive data is logged; notification emails and passwords are redacted from logs | Must |
| SP-06 | Compliance: project is a demo/utility tool; GDPR/CCPA considerations are noted but no data retention policy is required in v1 | Should |

---

## 11. Accessibility

| ID | Requirement | Priority |
|----|-------------|----------|
| ACC-01 | The minimal web UI uses semantic HTML (`<form>`, `<label>`, buttons) and works with keyboard navigation | Should |
| ACC-02 | Form inputs have visible labels; error messages are announced in the DOM | Should |
| ACC-03 | Contrast ratios meet WCAG 2.1 AA for text on backgrounds in the UI stylesheet | Could |

---

## 12. User Interface / Interaction Design

The UI is a single-page, server-served HTML page:
- **Header:** product name.
- **Create form:** title (text), description (textarea), notify email (email input), submit button.
- **Task list:** each row shows title, description (truncated), status badge (pending/completed), notification status badge, and action buttons (**Complete** / **Reopen** and **Delete**).
- No build step; the page uses vanilla JS `fetch()` calls against `/api/tasks`.

---

## 13. System States / Lifecycle

- **Task status:** `pending` → `completed` (via complete action) → `pending` (via reopen).
- **Notification status:** `pending` (no notification attempted yet) → `sent` | `failed` (after an email attempt). A subsequent completed-email attempt overwrites the previous notification status.
- **Server lifecycle:** on boot, apply pending migrations, then listen on `PORT`. If DB is unreachable, fail fast with a clear message.

---

## 14. Implementation Phases

### Phase 1: Foundation & Database
- [ ] Scaffold project: `package.json`, `.gitignore`, `.env.example`, directory structure
- [ ] Add `docker-compose.yml` for PostgreSQL 16 + MailHog
- [ ] Implement `config.js` (env loading + validation) and `db/pool.js`
- [ ] Write `001_init.sql` migration (tasks table) and apply-on-boot logic
- [ ] Add `/health` endpoint

### Phase 2: Task CRUD API
- [ ] Implement `tasksService.js` (create, list, get, update, complete, reopen, delete)
- [ ] Implement `routes/tasks.js` REST endpoints with validation
- [ ] Implement `middleware/errorHandler.js` consistent error responses
- [ ] Write integration tests for all CRUD flows
- [ ] Verify all Phase 2 acceptance criteria (FR-01..FR-08)

### Phase 3: Email Notifications
- [ ] Implement `mailer.js` (nodemailer wrapper, SMTP via env)
- [ ] Wire create + complete flows to send email (FR-09, FR-10)
- [ ] Record `notif_status` + timestamps (FR-13) and implement retry-once (FR-14)
- [ ] Verify no-email-on-update and no-email-on-reopen rules (FR-11, FR-12)
- [ ] Write notification tests

### Phase 4: Web UI & Polish
- [ ] Implement `public/index.html` + `public/app.js` UI (list, create, complete, delete)
- [ ] Wire UI to API and show status badges
- [ ] Run full test suite + lint, update docs/PROGRESS.md

---

## 15. Testing Strategy

| Level | Scope | Tools / Approach |
|-------|-------|------------------|
| Unit Tests | mailer formatting, config validation | Jest |
| Integration Tests | API + DB + notification flow | Jest + supertest against test DB + MailHog |
| Manual / Exploratory | UI flows in browser | Manual run with MailHog to inspect emails |
| Performance | Not applicable at this scale | Smoke check for basic latency |

Key test scenarios:
1. POST `/api/tasks` creates a task and returns 201 with correct fields.
2. POST with missing/invalid title or email returns 400.
3. GET list returns created tasks newest-first.
4. GET by id returns the task; unknown id returns 404.
5. PATCH updates fields; PATCH complete sets status + completed_at; reopen clears it.
6. DELETE removes the task; subsequent GET returns 404.
7. Creating a task delivers an email (asserted via MailHog API) and records `notif_status=sent`.
8. Completing a task delivers a second email with "completed" subject.
9. SMTP failure (point transport at an unreachable port) results in `notif_status=failed` and a still-successful HTTP response.
10. Reopening / updating a task does not deliver a new email.

---

## 16. Analytics / Success Metrics

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Automated tests pass | 100% | `npm test` |
| Email delivered on create | 100% of successful creates | MailHog API / notif_status |
| Email delivered on complete | 100% of completes | MailHog API / notif_status |

No product telemetry is planned; success is evaluated through the automated test suite and manual smoke testing.

---

## 17. Acceptance Criteria

1. `docker compose up` starts PostgreSQL and MailHog; `npm start` boots the app and applies the schema migration.
2. All task CRUD operations (create, list, get, update, complete, reopen, delete) work over the REST API and the web UI.
3. Creating a task sends an email to the specified recipient (verifiable in MailHog).
4. Completing a task sends a completion email to the specified recipient.
5. Updating a task or reopening it does not send an email.
6. Every task exposes its notification status; failed deliveries are recorded without failing the API request.
7. `npm test` passes with no network access beyond localhost (MailHog + test DB).
8. `.env.example` documents every configuration variable; no secrets are committed.

---

## 18. Dependencies and Risks

### 18.1 Dependencies

| Dependency | Type | Risk if Unavailable | Mitigation |
|------------|------|---------------------|------------|
| Express 5 | npm | API cannot serve requests | Pin `^5.2.1`; rely on mature package |
| pg | npm | No DB access | Pin `^8.23.0` |
| nodemailer | npm | No email delivery | Fall back to dev sink (MailHog) |
| PostgreSQL 16 | service (Docker) | App cannot start | `docker compose up`; documented in README |
| MailHog | service (Docker) | Emails not visible in dev | Start via docker compose |

### 18.2 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SMTP server unreachable in production | Medium | Emails not delivered | Retry-once + `notif_status` visibility |
| Express 5 API differences from Express 4 | Medium | Dev friction | Target Express 5 semantics directly; tests catch regressions |
| pg Pool connection exhaustion under load | Low | Slow API | Not applicable at v1 scale; noted for future |
| Email sending blocking the request thread | Low | Slower responses | In-process retry keeps it bounded; queue deferred |

---

## 19. Future Considerations

| Item | Description | Potential Version |
|------|-------------|-------------------|
| Background email queue | Move notifications to a worker with durable retries (e.g., pg-boss, BullMQ) | v2 |
| User accounts & auth | Login, per-user tasks, ownership | v2 |
| Task metadata | Due dates, priorities, tags, assignments | v2 |
| Email templates | HTML templates with branding | v2 |
| Project/workspace support | Group tasks into projects | v3 |
| Mobile/native clients | Native apps against the API | v3 |

---

## 20. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should the product include a frontend in v1? | Minimal server-served vanilla-JS UI (no build step); full SPA deferred |
| 2 | Are user accounts needed? | No - single-user with per-task `notify_email`; auth deferred |
| 3 | How should SMTP be configured for production? | Via `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` env vars |
| 4 | What should happen when SMTP is down? | Retry once in-process, record failure, still return success to client |
| 5 | Should completed tasks also store an `email_sent_at`? | Covered by `notif_status` + `notified_at` on the task row |

---

## 21. Glossary

| Term | Definition |
|------|------------|
| Task | A single to-do item with title, description, status, and recipient email |
| notify_email | The email address that receives notification emails for a task |
| notif_status | Delivery status of the latest notification: pending / sent / failed |
| MailHog | Local SMTP server + web UI used to capture outgoing emails in development |
| Reopen | Transitioning a completed task back to pending status |
