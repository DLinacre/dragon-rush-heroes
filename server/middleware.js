'use strict';
/**
 * Cross-cutting HTTP middleware: security headers, CORS, rate limiting,
 * session resolution, CSRF enforcement and auth guards.
 */

const config = require('./config');
const { tooManyRequests, unauthorized, forbidden } = require('./core/errors');
const { tokenDigest, csrfTokenFor, csrfValid } = require('./core/crypto');

/**
 * Content-Security-Policy.
 *
 * The client is hand-written ES modules with no inline scripts, so we can run
 * a strict policy with no `unsafe-inline` for scripts. Styles need
 * `unsafe-inline` only because the battle engine writes dynamic transform
 * values to `style` attributes for 60fps animation; that is a deliberate,
 * documented trade-off (style injection cannot execute script).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Google Fonts serves the stylesheet from fonts.googleapis.com and the font
  // binaries from fonts.gstatic.com. Both are allow-listed explicitly rather
  // than opening styles to the whole web.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

/** Baseline hardening applied to every response. */
function securityHeaders() {
  return (req, res, next) => {
    res.header('Content-Security-Policy', CSP);
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.header('Cross-Origin-Opener-Policy', 'same-origin');
    res.header('Cross-Origin-Resource-Policy', 'same-origin');
    res.header(
      'Permissions-Policy',
      'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()'
    );
    if (config.isProd) {
      res.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
    next();
  };
}

/** Same-origin by default; explicit allow-list when configured. */
function cors() {
  const allowed = new Set(config.security.corsOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.header('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.noContent();
      return; // terminate: do not call next()
    }
    next();
  };
}

/**
 * Fixed-window rate limiter with per-bucket budgets.
 *
 * In a multi-node deployment this map moves to Redis; the interface is
 * unchanged. Memory is bounded by periodic sweeping of expired windows.
 */
class RateLimiter {
  constructor() {
    /** @type {Map<string, {count:number, resetAt:number}>} */
    this.windows = new Map();
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  sweep() {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }

  /**
   * @returns {{allowed:boolean, retryAfter:number, remaining:number}}
   */
  hit(key, limit, windowMs = 60_000) {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return {
      allowed: window.count <= limit,
      retryAfter: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      remaining: Math.max(0, limit - window.count),
    };
  }

  stop() {
    clearInterval(this.sweepTimer);
  }
}

const limiter = new RateLimiter();

/**
 * Build a rate-limit middleware.
 * @param {string} bucket Logical bucket name (keeps budgets independent).
 * @param {number} limit  Requests per minute.
 */
function rateLimit(bucket, limit) {
  return (req, res, next) => {
    // Authenticated players get a per-account budget so shared NATs (schools,
    // offices, mobile carriers) don't throttle each other.
    const identity = req.session?.userId ?? req.ip ?? 'unknown';
    const result = limiter.hit(`${bucket}:${identity}`, limit);
    res.header('X-RateLimit-Limit', String(limit));
    res.header('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) throw tooManyRequests(result.retryAfter);
    next();
  };
}

/**
 * Resolve the session cookie into `req.session` / `req.user` / `req.player`.
 * Never rejects — downstream guards decide whether auth was required.
 */
function sessionLoader(repos) {
  return (req, res, next) => {
    req.session = null;
    req.user = null;
    req.player = null;

    const token = req.cookies[config.security.cookieName];
    if (!token) return next();

    const session = repos.findSessionByTokenHash(tokenDigest(token));
    if (!session || session.revokedAt || Date.parse(session.expiresAt) < Date.now()) {
      // Stale cookie: clear it so the browser stops sending it.
      res.clearCookie(config.security.cookieName);
      return next();
    }

    const user = repos.findUserById(session.userId);
    if (!user || user.status !== 'active') {
      repos.transaction(() => repos.revokeSession(session.id)).catch(() => {});
      res.clearCookie(config.security.cookieName);
      return next();
    }

    req.session = session;
    req.user = user;
    req.player = repos.findPlayerById(session.userId);
    req.log = req.log.child({ userId: user.id });
    next();
  };
}

/**
 * CSRF: signed double-submit cookie.
 *
 * Safe methods pass through and (re)issue the token cookie. Unsafe methods
 * must present a matching `X-CSRF-Token` header. Combined with `SameSite=Lax`
 * this defeats both classic form CSRF and subdomain-injected requests.
 */
function csrfProtection() {
  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  return (req, res, next) => {
    if (req.session) {
      const expected = csrfTokenFor(req.session.id);
      // Readable by JS on purpose — the client echoes it back in the header.
      if (req.cookies[config.security.csrfCookieName] !== expected) {
        res.cookie(config.security.csrfCookieName, expected, {
          httpOnly: false,
          sameSite: 'Lax',
          maxAge: config.security.sessionTtlMs,
        });
      }
    }

    if (SAFE.has(req.method)) return next();

    // Unauthenticated POSTs (login/register) are protected by SameSite +
    // origin checking rather than a session-bound token.
    if (!req.session) {
      const origin = req.headers.origin;
      if (origin) {
        const host = req.headers.host;
        let originHost = null;
        try { originHost = new URL(origin).host; } catch { /* malformed */ }
        const allowed = config.security.corsOrigins.includes(origin) || originHost === host;
        if (!allowed) throw forbidden('Cross-origin request rejected.', 'CSRF_REJECTED');
      }
      return next();
    }

    const submitted = req.headers['x-csrf-token'] ?? req.body?.csrfToken;
    if (!csrfValid(req.session.id, submitted)) {
      throw forbidden('Invalid or missing CSRF token.', 'CSRF_REJECTED');
    }
    next();
  };
}

/** Guard: require an authenticated session. */
function requireAuth(req, res, next) {
  if (!req.session || !req.user) throw unauthorized('You must be signed in to do that.');
  if (!req.player) throw unauthorized('Player profile is missing. Please sign in again.');
  next();
}

module.exports = {
  securityHeaders,
  cors,
  rateLimit,
  sessionLoader,
  csrfProtection,
  requireAuth,
  limiter,
  RateLimiter,
  CSP,
};
