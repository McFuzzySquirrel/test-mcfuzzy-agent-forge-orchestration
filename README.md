# Tasker Mail

A simple task manager with automatic email notifications. Create and complete tasks; Tasker Mail emails the task's configured recipient every time a task is **created** or **completed**.

Built with **Node.js (v22)**, **Express 5**, **PostgreSQL 16**, and **nodemailer**. Runs fully locally with Docker Compose (PostgreSQL + MailHog as a dev email sink).

---

## Features

- Full task CRUD over a REST API: create, list, get, update, complete, reopen, delete
- **Email on create** and **email on complete** to the task's `notify_email`
- No email on field-only updates or reopening (FR-11, FR-12)
- Delivery status tracked per task (`pending` / `sent` / `failed`) with a retry-once on SMTP failure
- Minimal server-served web UI (no build step) on top of the same API
- Versioned SQL migrations applied on boot
- 48 automated integration tests covering CRUD, notifications, and failure paths

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js v22 |
| Web framework | Express ^5.2.1 |
| Database | PostgreSQL 16 (driver `pg` ^8.23.0) |
| Email | nodemailer ^9.0.5 |
| Tests | Jest ^30.4.2 + supertest ^7.2.2 |
| Dev email sink | MailHog (Docker) |

---

## Prerequisites

- Node.js v22+
- Docker + Docker Compose (for PostgreSQL and MailHog)

---

## Quick Start

```bash
# 1. Start PostgreSQL and MailHog
docker compose up -d

# 2. Configure environment
cp .env.example .env        # defaults match the docker-compose services

# 3. Install dependencies
npm install

# 4. Start the app (applies migrations on boot)
npm start                   # http://localhost:3000
```

- Web UI: http://localhost:3000
- MailHog UI (view captured emails): http://localhost:8025

---

## Usage

### Web UI

Create a task with a title, description, and recipient email. The task list shows each task's status (`pending` / `completed`) and notification status, with buttons to complete, reopen, and delete.

### REST API

| Method | Path | Purpose | Success |
|--------|------|---------|---------|
| GET | `/api/tasks` | List all tasks, newest first | 200 |
| POST | `/api/tasks` | Create a task | 201 |
| GET | `/api/tasks/:id` | Get a single task | 200 |
| PATCH | `/api/tasks/:id` | Update fields, or complete/reopen | 200 |
| DELETE | `/api/tasks/:id` | Delete a task | 200 |
| GET | `/health` | Liveness check (DB reachable) | 200 |

Errors return `{ "error": "message" }` with 400 (invalid input), 404 (unknown id), or 500.

#### Create a task

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Ship the release","description":"Cut v1.0","notify_email":"me@example.com"}'
```

#### Complete a task (sends the "completed" email)

```bash
curl -X PATCH http://localhost:3000/api/tasks/1 \
  -H 'Content-Type: application/json' \
  -d '{"status":"completed"}'
```

#### Reopen a task (no email)

```bash
curl -X PATCH http://localhost:3000/api/tasks/1 \
  -H 'Content-Type: application/json' \
  -d '{"status":"pending"}'
```

---

## Email Notifications

- **Created** → `[Tasker Mail] Task created: <title>`
- **Completed** → `[Tasker Mail] Task completed: <title>`
- Sent synchronously within the request, with a single in-process retry on SMTP failure
- The API request succeeds even if delivery fails; the outcome is recorded on the task as `notif_status`
- In development, emails land in MailHog at http://localhost:8025 — no real SMTP server needed

Configure a real relay by editing `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` in `.env`.

---

## Running Tests

```bash
npm test       # 48 integration tests (requires compose services up)
npm run lint   # node --check across src/ and tests/
```

Tests run against an isolated `tasker_mail_test` database and require no network access beyond localhost (MailHog on 1025, PostgreSQL on 5432).

---

## Project Structure

```
src/
├── server.js            # Express app (json parser, routes, error handler)
├── index.js             # listen() entrypoint (applies migrations on boot)
├── config.js            # env loading + validation
├── db/
│   ├── pool.js          # shared pg.Pool
│   └── migrations/      # versioned SQL migrations + apply-on-boot runner
├── routes/
│   ├── tasks.js         # task REST router
│   └── health.js        # GET /health
├── services/
│   ├── tasksService.js  # task CRUD + notification triggers
│   └── mailer.js        # nodemailer wrapper (SMTP via env)
├── middleware/
│   └── errorHandler.js  # central { "error": ... } responses
└── public/              # web UI (index.html + app.js)
tests/                   # Jest + supertest integration suites
docs/                    # PRD, PROGRESS, Agent Forge execution artifacts
```

---

## Environment Variables

All variables are documented in `.env.example`. Key ones:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | `localhost` / `5432` / `tasker_mail` / `tasker` / `tasker` | PostgreSQL connection |
| `SMTP_HOST` / `SMTP_PORT` | `localhost` / `1025` | SMTP server (MailHog in dev) |
| `SMTP_USER` / `SMTP_PASS` | *(empty)* | SMTP credentials |
| `SMTP_FROM` | `Tasker Mail <noreply@tasker.local>` | From address |

---

## How This Solution Was Built

Tasker Mail was created end-to-end by the **Agent Forge** pipeline using the new **orchestration DAG** engine from [McFuzzySquirrel/mcfuzzy-agent-forge](https://github.com/McFuzzySquirrel/mcfuzzy-agent-forge) (the "mcffuzy-agent-forge" repo). The pipeline ran fully autonomously after a single pre-flight approval:

1. **Idea** → `docs/IDEA.md` (one-line product idea)
2. **PRD** → `docs/PRD.md` (generated by `forge-build-prd`: goals, requirements, phases, acceptance criteria)
3. **Agent team** → 5 specialist agents + 2 skills under `.opencode/` (generated by `forge-build-agent-team`)
4. **Manifest compile** → `docs/EXECUTION-MANIFEST.json` (compiled by `forge-execution-adapter`: phases, dependency-ordered tasks, owner agents, expected outputs)
5. **DAG-driven build** → the `forge-workflow-engine` builds a live task graph from the manifest, executes every task through the OpenCode harness (each task invokes its owning agent via `opencode run --agent <name>`), applies retry-once, and syncs state after each task
6. **Committed result** → each agent committed its own work; the run reached `status: "complete"` with 18/18 tasks

The engine's DAG logic, task graph execution, retry behavior, and resume semantics live in the `forge-workflow-engine` skill (`.opencode/skills/forge-workflow-engine/`). Note: the engine's OpenCode adapter was patched during this run to invoke `opencode run --agent <name>` (instead of the unsupported `--system-prompt`) and to pass arguments via `spawnSync` (no shell), so task text containing backticks executes safely.

---

## Workflow Orchestration Evidence

Every artifact produced by the orchestration run is committed under `docs/`:

| Artifact | Purpose |
|----------|---------|
| [`docs/IDEA.md`](docs/IDEA.md) | Original one-line product idea |
| [`docs/PRD.md`](docs/PRD.md) | Product Requirements Document (goals, requirements, phases, acceptance criteria) |
| [`docs/EXECUTION-MANIFEST.json`](docs/EXECUTION-MANIFEST.json) | Compiled execution plan: 4 phases, 18 tasks, owner agents, dependencies, expected outputs |
| [`docs/WORKFLOW-STATE.json`](docs/WORKFLOW-STATE.json) | Machine-readable run state: per-task status/attempts/outputs, final `status: "complete"` |
| [`docs/EXECUTION-AUDIT.jsonl`](docs/EXECUTION-AUDIT.jsonl) | Append-only audit trail of every state transition, including the `run.complete` event |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | Human-readable progress log synced after every task (complete task list) |
| [`docs/prompt-playbook.md`](docs/prompt-playbook.md) | Agent Forge command/prompt reference used to bootstrap this run |

Commit history tells the same story: `chore: bootstrap Agent Forge agent and skill templates` → one `feat:`/`test:`/`fix:` commit per phase task → `chore: auto-build complete - all phases delivered`.

---

## License

MIT
