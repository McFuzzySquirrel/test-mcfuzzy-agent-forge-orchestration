'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('../pool');

/**
 * Apply-on-boot migration runner (NF-05).
 *
 * - Reads every `*.sql` file in this directory in filename order and applies
 *   the ones not yet recorded in the `schema_migrations` table.
 * - The migrations table plus each migration file run inside a single
 *   transaction per run, so a partially-applied schema is never left behind.
 * - Any failure aborts the whole run and throws, so the boot path in
 *   src/index.js can fail fast with a clear message (Section 13).
 */

const MIGRATIONS_TABLE = 'schema_migrations';

/** Migration files are discovered relative to this module's directory. */
const MIGRATIONS_DIR = __dirname;

/** Create the bookkeeping table if it does not exist yet (first boot). */
async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/** List migration SQL files in this directory, ordered by filename. */
async function listMigrationFiles() {
  const entries = await fs.promises.readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

/**
 * Apply all pending migrations and return the names of the ones applied.
 * Exposed as a factory-style function so tests can run it against a test DB.
 */
async function applyMigrations() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);

    const { rows } = await client.query(
      `SELECT name FROM ${MIGRATIONS_TABLE}`
    );
    const applied = new Set(rows.map((row) => row.name));

    const pending = (await listMigrationFiles()).filter(
      (name) => !applied.has(name)
    );

    for (const name of pending) {
      const sql = await fs.promises.readFile(
        path.join(MIGRATIONS_DIR, name),
        'utf8'
      );
      await client.query(sql);
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`,
        [name]
      );
    }

    await client.query('COMMIT');
    return pending;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applyMigrations, MIGRATIONS_TABLE, listMigrationFiles };
