'use strict';

const { Router } = require('express');
const pool = require('../db/pool');

/**
 * Liveness endpoint (PRD §7.3, Phase 1 task 1.5).
 *
 * GET /health — returns 200 when the application is up and the database is
 * reachable (verified with `SELECT 1`), 500 otherwise. The body stays
 * machine-friendly and uses the standard error shape (NF-04).
 */
const healthRouter = Router();

healthRouter.get('/', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', db: 'up' });
  } catch (err) {
    // Only the sanitized message is exposed/logged (SP-05) - never credentials.
    console.error('[health] database check failed:', err.message);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

module.exports = healthRouter;
