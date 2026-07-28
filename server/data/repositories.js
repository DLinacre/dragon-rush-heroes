'use strict';
/**
 * Repository layer — the single seam between domain logic and storage.
 *
 * Domain services never touch the store directly; they call repositories.
 * Swapping the embedded engine for PostgreSQL means reimplementing only this
 * file against `pg` (the DDL in `db/schema.sql` mirrors these shapes exactly).
 */

const { Store } = require('./store');
const config = require('../config');
const { shortId } = require('../core/crypto');

/** Collection names, centralised to avoid typo drift. */
const C = Object.freeze({
  USERS: 'users',
  SESSIONS: 'sessions',
  PLAYERS: 'players',
  ROSTER: 'roster_entries',
  TEAMS: 'teams',
  BATTLES: 'battles',
  LEDGER: 'ledger',
  SUMMONS: 'summon_history',
  MISSIONS: 'mission_progress',
});

class Repositories {
  /** @param {Store} store */
  constructor(store) {
    this.store = store;
    this.users = store.collection(C.USERS, ['email']);
    this.sessions = store.collection(C.SESSIONS, ['tokenHash', 'userId']);
    this.players = store.collection(C.PLAYERS, ['displayName']);
    this.roster = store.collection(C.ROSTER, ['playerId', 'fighterId']);
    this.teams = store.collection(C.TEAMS, ['playerId']);
    this.battles = store.collection(C.BATTLES, ['playerId', 'status']);
    this.ledger = store.collection(C.LEDGER, ['playerId']);
    this.summons = store.collection(C.SUMMONS, ['playerId']);
    this.missions = store.collection(C.MISSIONS, ['playerId']);
  }

  /** Convenience proxy so services can express atomic units. */
  transaction(fn) {
    return this.store.transaction(fn);
  }

  // ---------------------------------------------------------------- users --

  /** Look up by normalised (lower-cased) email. */
  findUserByEmail(email) {
    return this.users.findOneBy('email', String(email).toLowerCase());
  }

  findUserById(id) {
    return this.users.get(id);
  }

  createUser({ email, passwordHash }) {
    const now = new Date().toISOString();
    return this.users.put({
      id: shortId('usr_'),
      email: String(email).toLowerCase(),
      passwordHash,
      status: 'active',
      failedLogins: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  updateUser(id, mutator) {
    return this.users.update(id, (doc) => {
      const next = mutator(doc) ?? doc;
      next.updatedAt = new Date().toISOString();
      return next;
    });
  }

  // ------------------------------------------------------------- sessions --

  findSessionByTokenHash(tokenHash) {
    return this.sessions.findOneBy('tokenHash', tokenHash);
  }

  createSession({ userId, tokenHash, ip, userAgent }) {
    const now = Date.now();
    return this.sessions.put({
      id: shortId('ses_'),
      userId,
      tokenHash,
      ip: ip ?? null,
      userAgent: String(userAgent ?? '').slice(0, 250),
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.security.sessionTtlMs).toISOString(),
      revokedAt: null,
    });
  }

  touchSession(id) {
    if (!this.sessions.has(id)) return;
    return this.sessions.update(id, (doc) => {
      doc.lastSeenAt = new Date().toISOString();
      return doc;
    });
  }

  revokeSession(id) {
    if (!this.sessions.has(id)) return false;
    this.sessions.update(id, (doc) => {
      doc.revokedAt = new Date().toISOString();
      return doc;
    });
    return true;
  }

  /** Revoke every live session for a user (password change, "log out everywhere"). */
  revokeAllSessions(userId, exceptId = null) {
    const live = this.sessions.findBy('userId', userId).filter((s) => !s.revokedAt);
    let count = 0;
    for (const session of live) {
      if (session.id === exceptId) continue;
      this.revokeSession(session.id);
      count += 1;
    }
    return count;
  }

  /** Housekeeping: drop rows that are expired or revoked long ago. */
  purgeDeadSessions() {
    const now = Date.now();
    const dead = this.sessions.filter(
      (s) => Date.parse(s.expiresAt) < now || (s.revokedAt && Date.parse(s.revokedAt) < now - 86_400_000)
    );
    for (const session of dead) this.sessions.delete(session.id);
    return dead.length;
  }

  // -------------------------------------------------------------- players --

  findPlayerById(id) {
    return this.players.get(id);
  }

  findPlayerByDisplayName(name) {
    return this.players.findOneBy('displayName', name);
  }

  /** Case-insensitive uniqueness check for display names. */
  displayNameTaken(name, exceptPlayerId = null) {
    const target = String(name).toLowerCase();
    return this.players.filter(
      (p) => p.displayName.toLowerCase() === target && p.id !== exceptPlayerId
    ).length > 0;
  }

  createPlayer(doc) {
    return this.players.put(doc);
  }

  updatePlayer(id, mutator) {
    return this.players.update(id, (doc) => {
      const next = mutator(doc) ?? doc;
      next.updatedAt = new Date().toISOString();
      return next;
    });
  }

  // --------------------------------------------------------------- roster --

  listRoster(playerId) {
    return this.roster.findBy('playerId', playerId);
  }

  findRosterEntry(playerId, fighterId) {
    return this.roster
      .findBy('playerId', playerId)
      .find((entry) => entry.fighterId === fighterId);
  }

  putRosterEntry(entry) {
    return this.roster.put(entry);
  }

  updateRosterEntry(id, mutator) {
    return this.roster.update(id, (doc) => {
      const next = mutator(doc) ?? doc;
      next.updatedAt = new Date().toISOString();
      return next;
    });
  }

  // ---------------------------------------------------------------- teams --

  listTeams(playerId) {
    return this.teams.findBy('playerId', playerId).sort((a, b) => a.slotIndex - b.slotIndex);
  }

  getTeam(id) {
    return this.teams.get(id);
  }

  putTeam(team) {
    return this.teams.put(team);
  }

  // -------------------------------------------------------------- battles --

  getBattle(id) {
    return this.battles.get(id);
  }

  putBattle(battle) {
    return this.battles.put(battle);
  }

  /** The player's single in-progress battle, if any. */
  findActiveBattle(playerId) {
    return this.battles
      .findBy('playerId', playerId)
      .find((b) => b.status === 'active');
  }

  /** Remove finished battles older than the retention window. */
  purgeOldBattles(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    const stale = this.battles.filter(
      (b) => b.status !== 'active' && Date.parse(b.updatedAt) < cutoff
    );
    for (const battle of stale) this.battles.delete(battle.id);
    return stale.length;
  }

  // --------------------------------------------------------------- ledger --

  /**
   * Append an immutable currency movement. Every crystal/zeni change in the
   * system flows through here, giving a full audit trail for support and for
   * detecting economy exploits.
   */
  recordLedger({ playerId, currency, delta, balanceAfter, reason, refId = null }) {
    return this.ledger.put({
      id: shortId('lg_'),
      playerId,
      currency,
      delta,
      balanceAfter,
      reason,
      refId,
      createdAt: new Date().toISOString(),
    });
  }

  listLedger(playerId, limit = 50) {
    return this.ledger
      .findBy('playerId', playerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  // -------------------------------------------------------------- summons --

  recordSummon(doc) {
    return this.summons.put(doc);
  }

  listSummons(playerId, limit = 20) {
    return this.summons
      .findBy('playerId', playerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  // ------------------------------------------------------------- missions --

  getMissions(playerId) {
    return this.missions.findOneBy('playerId', playerId);
  }

  putMissions(doc) {
    return this.missions.put(doc);
  }
}

/** Open the store and build the repository facade. */
async function createRepositories(directory = config.paths.data) {
  const store = new Store(directory);
  const repos = new Repositories(store);
  await store.open();
  return repos;
}

module.exports = { Repositories, createRepositories, COLLECTIONS: C };
