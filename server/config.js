'use strict';
/**
 * Centralised, validated runtime configuration.
 *
 * Every tunable in the system is resolved here exactly once at boot. Modules
 * import the frozen `config` object rather than reading `process.env` directly,
 * which keeps environment coupling at a single, testable boundary.
 *
 * Secret distribution policy
 * --------------------------
 * Secrets are supplied via environment variables only (12-factor). In
 * development a deterministic secret is derived so contributors can boot with
 * zero setup, but the process refuses to start in production unless real
 * secrets are injected by the orchestrator (Docker secret / K8s Secret / SSM).
 */

const crypto = require('node:crypto');
const path = require('node:path');

/** Read an env var as a string, falling back to a default. */
function str(key, fallback) {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : String(raw);
}

/** Read an env var as an integer with range validation. */
function int(key, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Config error: ${key} must be an integer, received "${raw}"`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`Config error: ${key} must be between ${min} and ${max}, received ${parsed}`);
  }
  return parsed;
}

/** Read an env var as a boolean ("1", "true", "yes" are truthy). */
function bool(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const NODE_ENV = str('NODE_ENV', 'development');
const IS_PROD = NODE_ENV === 'production';

/**
 * Resolve a cryptographic secret. In production a missing secret is fatal:
 * silently generating one would invalidate every session on each restart and
 * break horizontal scaling.
 */
function secret(key, devSeed) {
  const raw = process.env[key];
  if (raw && raw.length >= 32) return raw;
  if (IS_PROD) {
    throw new Error(
      `FATAL: ${key} is required in production and must be >= 32 characters. ` +
        'Inject it through your secret manager (never commit it).'
    );
  }
  if (raw && raw.length > 0) {
    process.emitWarning(`${key} is shorter than 32 chars; padding for development only.`);
  }
  // Deterministic per-machine dev secret: stable across restarts, useless in prod.
  return crypto.createHash('sha256').update(`dbh-dev::${devSeed}::${raw ?? ''}`).digest('hex');
}

const ROOT = path.resolve(__dirname, '..');

const config = Object.freeze({
  env: NODE_ENV,
  isProd: IS_PROD,
  isTest: NODE_ENV === 'test',

  server: Object.freeze({
    host: str('HOST', '0.0.0.0'),
    port: int('PORT', 3000, { min: 1, max: 65535 }),
    // Hard ceiling on request body size; protects against memory-exhaustion DoS.
    maxBodyBytes: int('MAX_BODY_BYTES', 64 * 1024, { min: 1024, max: 8 * 1024 * 1024 }),
    // Socket idle timeout (ms) before the connection is destroyed.
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 15_000, { min: 1000 }),
    shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 10_000, { min: 0 }),
    trustProxy: bool('TRUST_PROXY', false),
  }),

  paths: Object.freeze({
    root: ROOT,
    public: path.join(ROOT, 'public'),
    data: str('DATA_DIR', path.join(ROOT, '.data')),
  }),

  security: Object.freeze({
    sessionSecret: secret('SESSION_SECRET', 'session'),
    // Server seed for provably-fair summon RNG. Rotated per epoch.
    gachaSecret: secret('GACHA_SECRET', 'gacha'),
    sessionTtlMs: int('SESSION_TTL_MS', 7 * 24 * 60 * 60 * 1000, { min: 60_000 }),
    // scrypt parameters — N=2^15 is the OWASP-recommended interactive baseline.
    scrypt: Object.freeze({ N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 }),
    bruteForce: Object.freeze({
      maxFailedLogins: int('MAX_FAILED_LOGINS', 8, { min: 3 }),
      lockoutMs: int('LOCKOUT_MS', 15 * 60 * 1000, { min: 1000 }),
    }),
    cookieName: 'dbh_session',
    csrfCookieName: 'dbh_csrf',
    // Comma-separated allow-list. Empty => same-origin only (no CORS headers).
    corsOrigins: Object.freeze(
      str('CORS_ORIGINS', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  }),

  rateLimit: Object.freeze({
    // Global per-IP budget across all endpoints.
    globalPerMinute: int('RL_GLOBAL_PER_MIN', 300, { min: 10 }),
    // Tighter budget for credential endpoints (login / register).
    authPerMinute: int('RL_AUTH_PER_MIN', 12, { min: 1 }),
    // Write-heavy gameplay endpoints (summon / battle actions).
    actionPerMinute: int('RL_ACTION_PER_MIN', 120, { min: 10 }),
  }),

  game: Object.freeze({
    startingCrystals: int('START_CRYSTALS', 3000, { min: 0 }),
    startingZeni: int('START_ZENI', 5000, { min: 0 }),
    summonCostSingle: 100,
    summonCostMulti: 900, // 10 pulls for the price of 9
    multiPullSize: 10,
    // Guaranteed top-rarity drop once this many pulls have passed without one.
    pityThreshold: 60,
    // Soft-pity ramp begins here, linearly increasing LEGEND odds to the cap.
    softPityStart: 45,
    staminaMax: 60,
    staminaRegenMs: 4 * 60 * 1000, // one point every 4 minutes
    staminaPerBattle: 5,
    teamSize: 3,
    maxFighterLevel: 100,
    maxRosterSize: 400,
  }),

  logging: Object.freeze({
    level: str('LOG_LEVEL', IS_PROD ? 'info' : 'debug'),
    pretty: bool('LOG_PRETTY', !IS_PROD),
  }),
});

module.exports = config;
