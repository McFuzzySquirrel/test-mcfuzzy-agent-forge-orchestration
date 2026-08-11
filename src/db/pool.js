'use strict';

const { Pool } = require('pg');
const config = require('../config');

/**
 * Single shared pg.Pool for the whole application (created once at module
 * load, never per request). All runtime SQL goes through this pool with
 * parameterized queries (SP-03).
 */
const pool = new Pool({
  host: config.PGHOST,
  port: config.PGPORT,
  database: config.PGDATABASE,
  user: config.PGUSER,
  password: config.PGPASSWORD,
  // Fail fast when PostgreSQL is unreachable (e.g. right after
  // `docker compose up -d`) instead of hanging on a connection attempt.
  connectionTimeoutMillis: 5000,
  // Prevent requests from piling up indefinitely if the DB goes away.
  idleTimeoutMillis: 30000,
  max: 10,
});

// node-postgres emits 'error' on the pool for idle-client failures (network
// drops, server restarts). Without a handler this would crash the process.
// Only the sanitized message is logged - never credentials (SP-05).
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

module.exports = pool;
