'use strict';

/**
 * Central Express error handler (PRD §7.2 `src/middleware/errorHandler.js`,
 * Phase 2 task 2.3).
 *
 * Mounted last in the middleware chain so every error that is thrown or
 * passed to `next(err)` lands here, regardless of which layer produced it:
 * the body parser (malformed JSON, oversized payload), the routes (async
 * handler rejections, `tasksService.ValidationError`), or the database layer.
 *
 * Contract (NF-04, FR-08):
 *   - Every response body is JSON with the shape `{ "error": "..." }`.
 *   - Errors carrying a client-meaningful 4xx/5xx `status` (e.g. body-parser
 *     errors and `ValidationError` with status 400) are forwarded with that
 *     status and their message exposed to the client.
 *   - Anything else is a 500 with a generic, non-revealing message.
 *
 * Security (SP-05): 5xx responses never expose stack traces, SQL fragments,
 * SMTP details, or any other internals to the client. The sanitized message
 * is logged server-side only so operators can investigate without leaking
 * secrets into the response path.
 */
function errorHandler(err, req, res, next) {
  // A previous handler already sent the response; nothing left to do. Forward
  // so Express keeps walking the stack without double-sending.
  if (res.headersSent) {
    next(err);
    return;
  }

  // Body-parser errors (e.g. `entity.parse.failed`, `entity.too.large`) carry
  // a `status` and a user-facing message (400 malformed JSON / 413 too large).
  // `ValidationError` from tasksService also sets status 400. Only trust a
  // status inside the valid HTTP error range; everything else is a 500.
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = status === 500 ? 'Internal server error' : err.message;

  if (status === 500) {
    // Never leak stack traces or internals to clients (SP-05 / NF-04); log
    // the sanitized message server-side only.
    console.error('[errorHandler] unhandled error:', err.message);
  }

  res.status(status).json({ error: message });
}

module.exports = errorHandler;
