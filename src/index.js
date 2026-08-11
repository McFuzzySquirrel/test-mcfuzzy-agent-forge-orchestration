'use strict';

const config = require('./config');
const pool = require('./db/pool');
const { applyMigrations } = require('./db/migrations');
const { createApp } = require('./server');

/**
 * Application entrypoint (PRD §7.2 `src/index.js`, NF-01).
 *
 * Boot sequence (Section 13):
 *   1. Apply pending migrations (NF-05) - fail fast with a clear message if
 *      PostgreSQL is unreachable, rather than starting a broken server.
 *   2. Listen on PORT.
 *   3. Shut down cleanly on SIGINT/SIGTERM.
 */
async function main() {
  let applied;
  try {
    applied = await applyMigrations();
  } catch (err) {
    console.error('[boot] failed to apply database migrations:', err.message);
    console.error(
      '[boot] is PostgreSQL running? Try `docker compose up -d` first.'
    );
    process.exit(1);
  }

  if (applied.length > 0) {
    console.log(`[boot] applied migrations: ${applied.join(', ')}`);
  }

  const app = createApp();
  const server = app.listen(config.PORT, () => {
    console.log(`[boot] Tasker Mail listening on http://localhost:${config.PORT}`);
  });

  server.on('error', (err) => {
    console.error('[boot] failed to start server:', err.message);
    process.exit(1);
  });

  // Graceful shutdown: stop accepting connections, then close the pool.
  const shutdown = (signal) => {
    console.log(`[boot] received ${signal}, shutting down`);
    server.close(async () => {
      try {
        await pool.end();
      } finally {
        process.exit(0);
      }
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
