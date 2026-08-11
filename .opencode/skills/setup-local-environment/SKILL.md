---
name: setup-local-environment
description: >
  Starts Tasker Mail's local development environment: PostgreSQL and MailHog via
  Docker Compose, applies database migrations, and verifies the app boots. Use this
  whenever you need a running DB, a mail sink, or a working app instance for manual
  testing or debugging.
---

# Skill: Setup Local Environment

Boots the full Tasker Mail local stack - PostgreSQL, MailHog, migrations, and the app - so any agent can develop and test against a real environment.

---

## Process

### Step 1: Start Infrastructure

```bash
docker compose up -d
```

Wait for both services to be healthy:

```bash
docker compose ps
```

Both `db` (postgres:16-alpine) and `mailhog` must report `healthy`. If the DB is not healthy after ~30s, run `docker compose logs db` and retry.

### Step 2: Configure Environment

Copy `.env.example` to `.env` if it does not exist, or verify existing values:

```bash
cp -n .env.example .env
```

Defaults target the local compose services: `PGHOST=localhost`, `PGPORT=5432`, `PGDATABASE=tasker`, `PGUSER=tasker`, `PGPASSWORD=tasker`, `SMTP_HOST=localhost`, `SMTP_PORT=1025`.

### Step 3: Install Dependencies

```bash
npm install
```

### Step 4: Start the App (applies migrations on boot)

```bash
npm start
```

The server applies pending migrations from `src/db/migrations/` before listening on `PORT` (default 3000).

### Step 5: Verify

- `GET http://localhost:3000/health` returns 200
- `GET http://localhost:3000/api/tasks` returns a JSON array
- MailHog UI is reachable at `http://localhost:8025`

---

## Output Format

A working local environment: Postgres accepting connections, MailHog capturing SMTP, migrations applied, and the app responding on `PORT`.

---

## Validation

- [ ] `docker compose ps` shows both services healthy
- [ ] `/health` returns 200
- [ ] `/api/tasks` returns valid JSON
- [ ] MailHog UI loads at `http://localhost:8025`

If validation fails: check `docker compose logs`, verify `.env` values match compose, and re-run the failing step.

---

## Gotchas

- PostgreSQL takes a few seconds to accept connections after startup - use the compose healthcheck before running `npm start`
- MailHog SMTP port is **1025**; its HTTP UI/API port is **8025** - never mix them up
- `.env` is gitignored; only `.env.example` is committed
- The app fails fast if the DB is unreachable - start compose before `npm start`

---

## Reference

See [docs/PRD.md](../../../docs/PRD.md) for the full specification:

- **Section 7.2** - Project structure and file locations
- **Section 9** - Non-functional requirements (NF-01 startup, NF-03 config)
