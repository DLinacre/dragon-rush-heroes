/**
 * Reactive application store.
 *
 * A deliberately small observable state container — the whole app needs
 * exactly one source of truth plus subscriptions, and a 90-line store beats
 * pulling in a framework for it.
 *
 * Views subscribe to the slices they care about and are re-rendered only when
 * that slice actually changes (reference equality), which keeps a 464-card
 * roster grid from repainting because a currency counter ticked.
 */

class Store {
  constructor(initial = {}) {
    this.state = initial;
    /** @type {Map<string, Set<Function>>} key → listeners */
    this.listeners = new Map();
    /** @type {Set<Function>} listeners for any change */
    this.globalListeners = new Set();
  }

  /** @returns {*} the current value of a top-level key. */
  get(key) {
    return this.state[key];
  }

  /** @returns {object} the whole state (read-only by convention). */
  all() {
    return this.state;
  }

  /**
   * Merge a patch into state and notify listeners of changed keys only.
   * @param {object} patch
   */
  set(patch) {
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (this.state[key] !== value) {
        this.state[key] = value;
        changed.push(key);
      }
    }
    if (changed.length === 0) return;
    for (const key of changed) {
      const bucket = this.listeners.get(key);
      if (!bucket) continue;
      for (const fn of bucket) fn(this.state[key], this.state);
    }
    for (const fn of this.globalListeners) fn(this.state, changed);
  }

  /**
   * Subscribe to one key.
   * @returns {Function} unsubscribe
   */
  on(key, fn) {
    let bucket = this.listeners.get(key);
    if (!bucket) { bucket = new Set(); this.listeners.set(key, bucket); }
    bucket.add(fn);
    return () => bucket.delete(fn);
  }

  /**
   * Subscribe to every change.
   * @returns {Function} unsubscribe
   */
  onAny(fn) {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }
}

export const store = new Store({
  /** 'boot' | 'auth' | 'ready' */
  phase: 'boot',
  user: null,
  profile: null,
  roster: [],
  teams: [],
  missions: [],
  catalogue: null,
  fairness: null,
  activeBattleId: null,
  route: 'home',
  routeParams: {},
  toasts: [],
});

/** Index the catalogue for O(1) fighter lookups. */
export function indexCatalogue(catalogue) {
  const byId = new Map(catalogue.fighters.map((f) => [f.id, f]));
  return { ...catalogue, byId };
}

/** Convenience: look up a fighter definition. */
export function fighterDef(id) {
  return store.get('catalogue')?.byId?.get(id) ?? null;
}

/** Merge a fresh player payload into the store. */
export function applyPlayerState(payload) {
  store.set({
    profile: payload.profile,
    roster: payload.roster,
    teams: payload.teams,
    missions: payload.missions,
    fairness: payload.fairness,
    activeBattleId: payload.activeBattleId,
  });
}
