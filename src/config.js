'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Load the .env file at the project root (NF-03). dotenv never overrides
// variables already present in the real environment, and a missing .env is
// fine because every variable has a local-development default below.
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

/**
 * Defaults for every configuration variable. These match the values documented
 * in .env.example and the services in docker-compose.yml, so the app boots
 * with zero configuration against the local PostgreSQL + MailHog stack.
 */
const DEFAULTS = Object.freeze({
  PORT: '3000',
  PGHOST: 'localhost',
  PGPORT: '5432',
  PGDATABASE: 'tasker_mail',
  PGUSER: 'tasker',
  PGPASSWORD: 'tasker',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_USER: '',
  SMTP_PASS: '',
  SMTP_FROM: 'Tasker Mail <noreply@tasker.local>',
});

/**
 * Variables the application cannot run without. They all ship with
 * local-development defaults, so hitting one of these errors means an operator
 * explicitly removed or blanked a value the app needs at runtime.
 */
const REQUIRED = Object.freeze([
  'PGHOST',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'SMTP_HOST',
  'SMTP_FROM',
]);

/**
 * Variables that must be integers within a valid TCP port range.
 * [name, min, max]
 */
const PORT_RULES = Object.freeze([
  ['PORT', 1, 65535],
  ['PGPORT', 1, 65535],
  ['SMTP_PORT', 1, 65535],
]);

/** Variables whose final value must be a number (parsed from the raw string). */
const NUMERIC_KEYS = new Set(['PORT', 'PGPORT', 'SMTP_PORT']);

/**
 * Read one raw variable from an environment source.
 * - Absent        -> the documented default
 * - Present value -> trimmed string (may be empty if explicitly blanked)
 */
function readRaw(env, name) {
  if (env[name] === undefined) {
    return DEFAULTS[name];
  }
  return String(env[name]).trim();
}

/**
 * Validate a fully-defaulted configuration object.
 * Returns an array of human-readable error messages (empty when valid).
 */
function validate(config) {
  const errors = [];

  for (const name of REQUIRED) {
    if (config[name] === undefined || config[name] === '') {
      errors.push(`Missing required environment variable "${name}".`);
    }
  }

  for (const [name, min, max] of PORT_RULES) {
    const value = config[name];
    if (
      value === undefined ||
      value === '' ||
      !/^\d+$/.test(value) ||
      Number(value) < min ||
      Number(value) > max
    ) {
      errors.push(
        `Invalid "${name}": expected an integer between ${min} and ${max}, got "${value}".`
      );
    }
  }

  if (config.SMTP_FROM && !config.SMTP_FROM.includes('@')) {
    errors.push(
      'Invalid "SMTP_FROM": expected an email address or "Name <email>" form.'
    );
  }

  return errors;
}

/**
 * Build the configuration object from an environment source.
 * Exported as a factory so unit tests can exercise validation with arbitrary
 * environments; the singleton below uses process.env.
 */
function loadConfig(env) {
  const source = env || process.env;
  const raw = {};
  for (const name of Object.keys(DEFAULTS)) {
    raw[name] = readRaw(source, name);
  }

  const errors = validate(raw);
  if (errors.length > 0) {
    throw new Error(
      `Environment configuration is invalid:\n  - ${errors.join('\n  - ')}`
    );
  }

  const config = {};
  for (const name of Object.keys(DEFAULTS)) {
    config[name] = NUMERIC_KEYS.has(name) ? Number(raw[name]) : raw[name];
  }
  return Object.freeze(config);
}

const config = loadConfig(process.env);

// Expose the config object plus helpers (loadConfig for tests, DEFAULTS and
// REQUIRED for introspection) as a single exports object. Other modules access
// config values only through this module, never process.env directly.
module.exports = { ...config, loadConfig, DEFAULTS, REQUIRED };
