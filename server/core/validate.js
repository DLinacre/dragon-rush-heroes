'use strict';
/**
 * Declarative schema validation.
 *
 * Every inbound payload passes through a schema before reaching domain code —
 * there is no path where raw client JSON touches business logic. Validators
 * both *check* and *coerce*, returning a clean, typed object so downstream code
 * can trust its inputs absolutely.
 *
 * Usage:
 *   const dto = validate(body, {
 *     email:    rules.email(),
 *     password: rules.string({ min: 10, max: 200 }),
 *     count:    rules.int({ min: 1, max: 10, default: 1 }),
 *   });
 */

const { validationFailed } = require('./errors');

/** Strip control characters and normalise unicode to prevent homograph tricks. */
function sanitiseText(value) {
  return String(value)
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

const rules = {
  /** Bounded, sanitised string. */
  string({ min = 0, max = 1000, pattern = null, patternMessage = 'has an invalid format', optional = false, default: def } = {}) {
    return (raw) => {
      if (raw === undefined || raw === null || raw === '') {
        if (def !== undefined) return def;
        if (optional) return undefined;
        return { __error: 'is required' };
      }
      if (typeof raw !== 'string') return { __error: 'must be a string' };
      const value = sanitiseText(raw);
      if (value.length < min) return { __error: `must be at least ${min} characters` };
      if (value.length > max) return { __error: `must be at most ${max} characters` };
      if (pattern && !pattern.test(value)) return { __error: patternMessage };
      return value;
    };
  },

  /** RFC-pragmatic email check plus length ceiling, lower-cased for uniqueness. */
  email({ optional = false } = {}) {
    return (raw) => {
      if (raw === undefined || raw === null || raw === '') {
        return optional ? undefined : { __error: 'is required' };
      }
      if (typeof raw !== 'string') return { __error: 'must be a string' };
      const value = sanitiseText(raw).toLowerCase();
      if (value.length > 254) return { __error: 'is too long' };
      if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) return { __error: 'must be a valid email address' };
      return value;
    };
  },

  /**
   * Password policy: length is the dominant strength factor, so we require 10+
   * characters and reject the most common leaked passwords rather than
   * mandating awkward character-class rules (NIST SP 800-63B guidance).
   */
  password() {
    const COMMON = new Set([
      'password', 'password1', 'password123', '1234567890', 'qwertyuiop',
      'letmein123', 'iloveyou1', 'dragonball', 'superman1', 'welcome123',
      'admin12345', 'football12', 'baseball12', 'sunshine12', 'princess12',
    ]);
    return (raw) => {
      if (typeof raw !== 'string' || raw.length === 0) return { __error: 'is required' };
      if (raw.length < 10) return { __error: 'must be at least 10 characters' };
      if (raw.length > 200) return { __error: 'must be at most 200 characters' };
      if (COMMON.has(raw.toLowerCase())) return { __error: 'is too common — choose something less guessable' };
      if (/^(.)\1+$/.test(raw)) return { __error: 'cannot be a single repeated character' };
      return raw;
    };
  },

  /** Integer with inclusive bounds. */
  int({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, optional = false, default: def } = {}) {
    return (raw) => {
      if (raw === undefined || raw === null || raw === '') {
        if (def !== undefined) return def;
        return optional ? undefined : { __error: 'is required' };
      }
      const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
      if (!Number.isFinite(value) || !Number.isInteger(value)) return { __error: 'must be an integer' };
      if (value < min) return { __error: `must be at least ${min}` };
      if (value > max) return { __error: `must be at most ${max}` };
      return value;
    };
  },

  /** Strict boolean, tolerant of "true"/"false" strings from query params. */
  bool({ optional = false, default: def } = {}) {
    return (raw) => {
      if (raw === undefined || raw === null || raw === '') {
        if (def !== undefined) return def;
        return optional ? undefined : { __error: 'is required' };
      }
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === '1' || raw === 1) return true;
      if (raw === 'false' || raw === '0' || raw === 0) return false;
      return { __error: 'must be a boolean' };
    };
  },

  /** Value restricted to an allow-list. */
  enum(allowed, { optional = false, default: def } = {}) {
    const set = new Set(allowed);
    return (raw) => {
      if (raw === undefined || raw === null || raw === '') {
        if (def !== undefined) return def;
        return optional ? undefined : { __error: 'is required' };
      }
      const value = sanitiseText(raw);
      if (!set.has(value)) return { __error: `must be one of: ${allowed.join(', ')}` };
      return value;
    };
  },

  /** Homogeneous array with a size cap and a per-item validator. */
  array(itemRule, { min = 0, max = 100, optional = false } = {}) {
    return (raw) => {
      if (raw === undefined || raw === null) return optional ? undefined : { __error: 'is required' };
      if (!Array.isArray(raw)) return { __error: 'must be an array' };
      if (raw.length < min) return { __error: `must contain at least ${min} item(s)` };
      if (raw.length > max) return { __error: `must contain at most ${max} item(s)` };
      const out = [];
      for (let i = 0; i < raw.length; i += 1) {
        const result = itemRule(raw[i]);
        if (result && typeof result === 'object' && result.__error) {
          return { __error: `item ${i} ${result.__error}` };
        }
        out.push(result);
      }
      return out;
    };
  },

  /** Opaque identifier: URL-safe characters only, prevents path/SQL injection shapes. */
  id({ optional = false, max = 64 } = {}) {
    return rules.string({
      min: 1,
      max,
      optional,
      pattern: /^[A-Za-z0-9_-]+$/,
      patternMessage: 'may only contain letters, numbers, hyphens and underscores',
    });
  },

  /** Public display name: letters, numbers, spaces and a few safe symbols. */
  displayName() {
    return rules.string({
      min: 2,
      max: 20,
      pattern: /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/,
      patternMessage: 'must start alphanumerically and contain only letters, numbers, spaces, dots, hyphens or underscores',
    });
  },
};

/**
 * Apply a schema to an input object.
 * @throws {AppError} 400 VALIDATION_FAILED with a per-field error map.
 * @returns {object} A new object containing only schema-declared keys.
 */
function validate(input, schema) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const output = {};
  const fieldErrors = {};

  for (const [field, rule] of Object.entries(schema)) {
    const result = rule(source[field]);
    if (result && typeof result === 'object' && !Array.isArray(result) && result.__error) {
      fieldErrors[field] = `${field} ${result.__error}`;
    } else if (result !== undefined) {
      output[field] = result;
    }
  }

  if (Object.keys(fieldErrors).length > 0) throw validationFailed(fieldErrors);
  return output;
}

/** Escape a string for safe interpolation into HTML (defence in depth). */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { validate, rules, sanitiseText, escapeHtml };
