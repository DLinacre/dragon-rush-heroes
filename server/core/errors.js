'use strict';
/**
 * Error taxonomy.
 *
 * A single `AppError` class carries an HTTP status, a stable machine-readable
 * `code` (which clients switch on), a human message, and optional structured
 * `details`. Anything thrown that is *not* an AppError is treated as an
 * unexpected fault: it is logged with a stack trace and reported to the client
 * as a generic 500 so internal details never leak.
 */

class AppError extends Error {
  /**
   * @param {number} status  HTTP status code.
   * @param {string} code    Stable, screaming-snake machine code.
   * @param {string} message Human-readable, safe to display.
   * @param {object} [details] Optional structured context (field errors, etc.).
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true; // safe to surface to the caller
    Error.captureStackTrace?.(this, AppError);
  }

  /** Serialise into the canonical API error envelope. */
  toJSON() {
    const body = { error: { code: this.code, message: this.message } };
    if (this.details !== undefined) body.error.details = this.details;
    return body;
  }
}

/** 400 — malformed syntax or failed schema validation. */
const badRequest = (message = 'Malformed request.', details) =>
  new AppError(400, 'BAD_REQUEST', message, details);

/** 400 — semantic validation failure with per-field detail. */
const validationFailed = (fieldErrors) =>
  new AppError(400, 'VALIDATION_FAILED', 'One or more fields are invalid.', { fields: fieldErrors });

/** 401 — no credentials, or credentials not understood. */
const unauthorized = (message = 'Authentication required.') =>
  new AppError(401, 'UNAUTHORIZED', message);

/** 403 — authenticated but not permitted (includes CSRF rejection). */
const forbidden = (message = 'You do not have permission to perform this action.', code = 'FORBIDDEN') =>
  new AppError(403, code, message);

/** 404 — resource does not exist, or exists but is not visible to the caller. */
const notFound = (message = 'Resource not found.') => new AppError(404, 'NOT_FOUND', message);

/** 409 — the request conflicts with current state (duplicate email, stale battle). */
const conflict = (message = 'Request conflicts with the current state.', code = 'CONFLICT', details) =>
  new AppError(409, code, message, details);

/** 422 — well-formed but the game rules reject it (insufficient funds, etc.). */
const unprocessable = (code, message, details) => new AppError(422, code, message, details);

/** 429 — rate limited. `retryAfter` is expressed in whole seconds. */
const tooManyRequests = (retryAfter = 60) =>
  new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.', { retryAfter });

/** 413 — request body exceeded the configured ceiling. */
const payloadTooLarge = () =>
  new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the maximum allowed size.');

/** 500 — internal fault. Never constructed with user-supplied text. */
const internal = (message = 'An unexpected error occurred.') => {
  const err = new AppError(500, 'INTERNAL_ERROR', message);
  err.expose = false;
  return err;
};

module.exports = {
  AppError,
  badRequest,
  validationFailed,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  tooManyRequests,
  payloadTooLarge,
  internal,
};
