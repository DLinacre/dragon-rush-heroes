'use strict';
/**
 * Zero-dependency structured logger.
 *
 * Emits newline-delimited JSON in production (ready for Loki / CloudWatch /
 * Datadog ingestion) and a colourised human format in development. Supports
 * child loggers so a request-scoped `requestId` is automatically attached to
 * every downstream log line.
 */

const config = require('../config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const COLOURS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

/** Keys whose values must never reach a log sink. */
const REDACTED_KEYS = new Set([
  'password',
  'passwordConfirm',
  'currentPassword',
  'newPassword',
  'token',
  'sessionToken',
  'authorization',
  'cookie',
  'passwordHash',
  'tokenHash',
  'serverSeed',
  'secret',
]);

/**
 * Deep-clone a value while stripping sensitive keys and capping depth so a
 * rogue object graph cannot blow the stack or flood the log.
 */
function redact(value, depth = 0) {
  if (depth > 6) return '[depth-limit]';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED_KEYS.has(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

class Logger {
  /** @param {object} bindings Fields merged into every line this logger emits. */
  constructor(bindings = {}) {
    this.bindings = bindings;
    this.threshold = LEVELS[config.logging.level] ?? LEVELS.info;
  }

  /** Create a derived logger carrying additional persistent fields. */
  child(bindings) {
    return new Logger({ ...this.bindings, ...bindings });
  }

  #write(level, message, meta) {
    if (LEVELS[level] < this.threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...this.bindings,
      ...(meta ? redact(meta) : {}),
    };
    if (config.logging.pretty) {
      const colour = COLOURS[level] ?? '';
      const scope = record.requestId ? ` \x1b[90m[${record.requestId}]${RESET}` : '';
      const { ts, level: _l, msg, requestId: _r, ...rest } = record;
      const tail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      process.stdout.write(
        `${colour}${level.toUpperCase().padEnd(5)}${RESET} ${ts.slice(11, 23)}${scope} ${msg}${tail}\n`
      );
    } else {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    }
  }

  debug(message, meta) { this.#write('debug', message, meta); }
  info(message, meta) { this.#write('info', message, meta); }
  warn(message, meta) { this.#write('warn', message, meta); }
  error(message, meta) { this.#write('error', message, meta); }
}

module.exports = new Logger();
module.exports.Logger = Logger;
