/**
 * ============================================================================
 * CLIENT ERROR HANDLING
 * ============================================================================
 *
 * Before this module the client had 6 silent `catch {}` blocks. Silent
 * swallows are the worst failure mode in a game client: the player sees
 * nothing happen, assumes the game is broken, and leaves — while the developer
 * has no signal at all.
 *
 * Policy, in order of preference:
 *
 *   1. RECOVERABLE + USER-VISIBLE  → `reportError()`  — toast + console + telemetry
 *   2. RECOVERABLE + BACKGROUND    → `reportQuiet()`  — console + telemetry, no toast
 *   3. EXPECTED / NON-ERROR        → `ignoreExpected()` — documents *why* it is safe
 *
 * Nothing is ever swallowed without a recorded reason.
 */

/** @typedef {'network'|'api'|'render'|'storage'|'unknown'} ErrorCategory */

/** Ring buffer of recent errors, surfaced in Settings for support. */
const RECENT = [];
const RECENT_LIMIT = 25;

/** Optional sink installed by the analytics layer. */
let telemetrySink = null;

/**
 * Register a telemetry callback. Kept optional so the module has no
 * dependency on any analytics provider.
 * @param {(entry: object) => void} fn
 */
export function setErrorTelemetry(fn) {
  telemetrySink = typeof fn === 'function' ? fn : null;
}

/** Push onto the ring buffer and forward to telemetry. */
function record(category, message, detail) {
  const entry = {
    at: new Date().toISOString(),
    category,
    message: String(message ?? 'Unknown error'),
    detail: detail ? String(detail).slice(0, 400) : undefined,
  };
  RECENT.push(entry);
  if (RECENT.length > RECENT_LIMIT) RECENT.shift();

  try {
    telemetrySink?.({ event: 'client_error', ...entry });
  } catch {
    // A failing telemetry sink must never escalate into a second error.
  }
  return entry;
}

/** Recent errors, newest last. Rendered in Settings → diagnostics. */
export function recentErrors() {
  return RECENT.slice();
}

/**
 * Turn any thrown value into a message safe to show a player.
 * Never leaks stack traces or internal identifiers.
 * @param {unknown} err
 */
export function toUserMessage(err) {
  if (err && typeof err === 'object') {
    const e = /** @type {{ code?: string, message?: string }} */ (err);
    if (e.code === 'NETWORK_ERROR') return 'Cannot reach the server. Check your connection.';
    if (e.code === 'RATE_LIMITED') return 'Slow down a moment, then try again.';
    if (e.code === 'UNAUTHORIZED') return 'Your session expired. Please sign in again.';
    if (typeof e.message === 'string' && e.message) return e.message;
  }
  if (typeof err === 'string' && err) return err;
  return 'Something went wrong. Please try again.';
}

/**
 * Handle a user-facing failure: record it and show a toast.
 *
 * @param {unknown} err
 * @param {object} [options]
 * @param {ErrorCategory} [options.category]
 * @param {string} [options.fallback] Message when the error carries none.
 * @param {(msg: string, kind: string) => void} [options.toast] Injected to
 *        avoid a circular import with ui.js.
 * @returns {string} the message shown
 */
export function reportError(err, { category = 'unknown', fallback, toast } = {}) {
  const message = fallback ?? toUserMessage(err);
  record(category, message, err instanceof Error ? err.stack : undefined);
  if (import.meta.env?.DEV !== false) console.error(`[${category}]`, err);
  toast?.(message, 'err');
  return message;
}

/**
 * Handle a background failure the player does not need to see — a refresh
 * that will retry, a non-critical sync. Recorded, never toasted.
 *
 * @param {unknown} err
 * @param {string} context Short description of what was being attempted.
 * @param {ErrorCategory} [category]
 */
export function reportQuiet(err, context, category = 'unknown') {
  record(category, `${context}: ${toUserMessage(err)}`,
    err instanceof Error ? err.stack : undefined);
  console.warn(`[${category}] ${context}`, err);
}

/**
 * Explicitly ignore an expected non-error.
 *
 * Use only where failure is a normal branch — a body that is legitimately not
 * JSON, a malformed Origin header. The `reason` argument forces the author to
 * state why, so `catch {}` never appears unexplained again.
 *
 * @param {string} reason
 */
export function ignoreExpected(reason) {
  void reason; // documentation only — intentionally does nothing
}

/**
 * Install global handlers so nothing escapes unnoticed.
 *
 * @param {(msg: string, kind: string) => void} [toast]
 */
export function installGlobalErrorHandlers(toast) {
  window.addEventListener('error', (event) => {
    // Resource load failures surface here with no `error` object.
    if (!event.error) {
      reportQuiet(event.message, 'resource failed to load', 'network');
      return;
    }
    record('unknown', event.message, event.error?.stack);
    console.error('[uncaught]', event.error);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    record('unknown', toUserMessage(reason), reason?.stack);
    console.error('[unhandled rejection]', reason);
    // Rejections that reach here are bugs, but the game should keep running.
    event.preventDefault();
    toast?.('Something went wrong, but the game is still running.', 'err');
  });
}
