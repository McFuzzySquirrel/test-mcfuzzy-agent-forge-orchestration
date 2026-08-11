'use strict';

const path = require('path');
const express = require('express');
const healthRouter = require('./routes/health');
const tasksRouter = require('./routes/tasks');
const errorHandler = require('./middleware/errorHandler');

/**
 * Build the Express application (PRD §7.2 `src/server.js`).
 *
 * Exported as a factory so tests can construct the app with supertest without
 * binding a port; `src/index.js` is the only module that calls listen().
 */
function createApp() {
  const app = express();

  // JSON body parsing, size-limited to 100kb (SP-04) to reject oversized
  // payloads before they reach handlers.
  app.use(express.json({ limit: '100kb' }));

  // Liveness check (Phase 1 task 1.5).
  app.use('/health', healthRouter);

  // Task CRUD API (Phase 2 task 2.2) - PRD §7.3.
  app.use('/api/tasks', tasksRouter);

  // Minimal web UI (Phase 4 task 4.1) - PRD §7.2 / FR-15: the root `/` serves
  // the server-rendered page plus its static assets from `src/public/`. This is
  // mounted after the API routers (so `/api/*` always wins) and only handles
  // GET/HEAD for existing files, so unknown paths still fall through to the
  // JSON 404 fallback below.
  app.use(express.static(path.join(__dirname, 'public')));

  // Fallback for unknown routes - consistent error shape (NF-04).
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler (NF-04). JSON parse errors, ValidationError, and
  // other thrown exceptions all land here and are reported as { error: "..." }.
  // Error middleware is identified by its 4-arity signature.
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
