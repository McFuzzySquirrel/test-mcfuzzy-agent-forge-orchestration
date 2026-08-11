'use strict';

/**
 * Integration test harness (PRD §7.2 `tests/helpers.js`).
 *
 * Responsibilities:
 * - Point the app at an isolated `tasker_mail_test` database BEFORE any src
 *   module is required (config.js reads process.env at load time), so the
 *   suite never touches developer data in the default `tasker_mail` database.
 * - Create the test database on demand, apply the versioned migrations, and
 *   expose per-test reset/teardown helpers (NF-02: tests run locally with no
 *   external network).
 * - Provide a supertest request against the real Express app (createApp) so
 *   every test exercises the full HTTP + service + DB stack.
 *
 * Mailer note: `src/services/mailer.js` is not implemented until Phase 3, so
 * the notification seam in tasksService returns null and created tasks keep
 * `notif_status = 'pending'` (FR-13 is asserted in Phase 3, task 3.5).
 */

// Set the test database before requiring ../src/config (a singleton that
// captures process.env.PGDATABASE at load time).
process.env.PGDATABASE = process.env.PGDATABASE || 'tasker_mail_test';

const { Pool } = require('pg');
const supertest = require('supertest');
const config = require('../src/config');
const { createApp } = require('../src/server');
const { applyMigrations } = require('../src/db/migrations');
const pool = require('../src/db/pool');

/** supertest request bound to the real Express app (no port binding). */
const request = supertest(createApp());

/** Admin connection used only to (re)create the test database. */
const adminPool = new Pool({
  host: config.PGHOST,
  port: config.PGPORT,
  database: 'postgres',
  user: config.PGUSER,
  password: config.PGPASSWORD,
  connectionTimeoutMillis: 5000,
});

/**
 * Create the test database if it does not exist yet, then apply the versioned
 * migrations (NF-05). Call once from beforeAll().
 */
async function setupTestDb() {
  const { rows } = await adminPool.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [config.PGDATABASE]
  );
  if (rows.length === 0) {
    // CREATE DATABASE cannot run inside a transaction block; adminPool issues
    // it as a standalone statement, which is fine.
    await adminPool.query(`CREATE DATABASE "${config.PGDATABASE}"`);
  }
  await adminPool.end();
  await applyMigrations();
}

/**
 * Wipe task rows and reset the identity sequence so each test starts from a
 * clean, deterministic table. schema_migrations is intentionally preserved so
 * migrations run exactly once per suite.
 */
async function resetDb() {
  await pool.query('TRUNCATE tasks RESTART IDENTITY');
}

/** Close the shared application pool. Call once from afterAll(). */
async function closeDb() {
  await pool.end();
}

/** Minimal valid task payload for happy-path tests (FR-01). */
function validTask(overrides = {}) {
  return {
    title: 'Write integration tests',
    description: 'Cover every CRUD flow',
    notify_email: 'tester@example.com',
    ...overrides,
  };
}

module.exports = {
  request,
  setupTestDb,
  resetDb,
  closeDb,
  validTask,
};
