/**
 * ============================================================================
 * ANALYTICS — privacy-preserving, zero-dependency
 * ============================================================================
 *
 * Audit finding CRO-1: the product had no instrumentation at all, so no
 * question about player behaviour could be answered and no improvement could
 * be validated.
 *
 * Design constraints, chosen to match the project's stated no-tracking stance:
 *
 *   - **No cookies.** Nothing is written that would require a consent banner.
 *   - **No personal data.** No email, no display name, no IP handling here.
 *   - **No third-party script by default.** The module buffers events locally
 *     and only forwards them if a sink is explicitly installed.
 *   - **Never breaks gameplay.** Every path is wrapped; a failing analytics
 *     provider must not surface to the player.
 *
 * To enable a hosted provider (Plausible/Umami), add its script tag and call
 * `useProvider()`. Without that, events are still counted locally and shown in
 * Settings → diagnostics, which is enough to validate a funnel during
 * development.
 */

/** Canonical event names. Using constants prevents silent typos in funnels. */
export const EVENTS = Object.freeze({
  DEMO_START: 'demo_start',
  GUEST_START: 'guest_start',
  REGISTER: 'register',
  LOGIN: 'login',
  FIRST_SUMMON: 'first_summon',
  SUMMON_SINGLE: 'summon_single',
  SUMMON_MULTI: 'summon_multi',
  RARE_PULL: 'rare_pull',
  FIRST_BATTLE: 'first_battle',
  BATTLE_COMPLETE: 'battle_complete',
  BATTLE_FORFEIT: 'battle_forfeit',
  TUTORIAL_COMPLETE: 'tutorial_complete',
  MISSION_CLAIM: 'mission_claim',
  FIGHTER_TRAINED: 'fighter_trained',
  DAY2_RETURN: 'day2_return',
});

/** Local counters, used when no provider is installed. */
const counts = new Map();

/** Milestones that should fire exactly once per browser. */
const ONCE_KEY = 'drh_analytics_once';

/** @type {((event: string, props: Record<string, unknown>) => void) | null} */
let provider = null;

/**
 * Install a forwarding sink.
 * @param {(event: string, props: Record<string, unknown>) => void} fn
 */
export function useProvider(fn) {
  provider = typeof fn === 'function' ? fn : null;
}

/**
 * Convenience wiring for Plausible, which exposes `window.plausible`.
 * Safe to call when the script is absent or blocked.
 */
export function usePlausible() {
  useProvider((event, props) => {
    const p = /** @type {any} */ (window).plausible;
    if (typeof p === 'function') p(event, { props });
  });
}

/** Which one-shot milestones have already fired. */
function loadOnce() {
  try {
    return new Set(JSON.parse(localStorage.getItem(ONCE_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function saveOnce(set) {
  try {
    localStorage.setItem(ONCE_KEY, JSON.stringify([...set]));
  } catch {
    // Storage full or blocked (private mode). Analytics is not important
    // enough to degrade the session over.
  }
}

/**
 * Record an event.
 *
 * @param {string} event One of `EVENTS`.
 * @param {Record<string, unknown>} [props] Low-cardinality properties only —
 *        never anything that could identify a player.
 */
export function track(event, props = {}) {
  try {
    counts.set(event, (counts.get(event) ?? 0) + 1);
    provider?.(event, props);
  } catch {
    // Analytics must never throw into gameplay.
  }
}

/**
 * Record an event at most once per browser (first summon, first battle…).
 * @param {string} event
 * @param {Record<string, unknown>} [props]
 * @returns {boolean} true if this call fired it
 */
export function trackOnce(event, props = {}) {
  const fired = loadOnce();
  if (fired.has(event)) return false;
  fired.add(event);
  saveOnce(fired);
  track(event, props);
  return true;
}

/**
 * Fire `DAY2_RETURN` when a player comes back on a later calendar day.
 * Stores only a date string — no identifier, nothing transmitted.
 */
export function trackReturnVisit() {
  const KEY = 'drh_last_visit';
  try {
    const today = new Date().toISOString().slice(0, 10);
    const last = localStorage.getItem(KEY);
    if (last && last !== today) {
      const days = Math.round(
        (Date.parse(today) - Date.parse(last)) / 86_400_000
      );
      track(EVENTS.DAY2_RETURN, { daysSince: days });
    }
    localStorage.setItem(KEY, today);
  } catch {
    // Storage unavailable — skip silently, this is a nice-to-have signal.
  }
}

/** Local event tallies, surfaced in Settings → diagnostics. */
export function localCounts() {
  return Object.fromEntries(counts);
}
