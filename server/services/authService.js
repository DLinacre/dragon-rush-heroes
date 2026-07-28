'use strict';
/**
 * Authentication service: registration, login, logout, password change.
 *
 * Security posture
 * ----------------
 * - Passwords hashed with scrypt (memory-hard), never logged, never returned.
 * - Login is constant-work: an unknown email still performs a dummy KDF pass
 *   so response timing cannot enumerate accounts.
 * - Failed attempts are counted per account with exponential lockout.
 * - Session tokens are opaque random values; only their SHA-256 digest is
 *   stored, so a database dump cannot be replayed.
 * - Changing a password revokes every other session.
 */

const config = require('../config');
const logger = require('../core/logger');
const { validate, rules } = require('../core/validate');
const { conflict, unauthorized, forbidden, unprocessable } = require('../core/errors');
const {
  hashPassword, verifyPassword, randomToken, tokenDigest, csrfTokenFor,
} = require('../core/crypto');
const { createPlayerDocument } = require('../domain/economy');

/** A valid scrypt hash of a throwaway value, used to equalise login timing. */
let DUMMY_HASH = null;

class AuthService {
  /** @param {import('../data/repositories').Repositories} repos */
  constructor(repos) {
    this.repos = repos;
  }

  /** Pre-compute the timing-equalisation hash once at boot. */
  async warmup() {
    if (!DUMMY_HASH) DUMMY_HASH = await hashPassword('timing-equalisation-placeholder');
  }

  /**
   * Register a new account and its player profile atomically.
   * @returns {Promise<{user, player, token, csrfToken}>}
   */
  async register(input, context = {}) {
    const dto = validate(input, {
      email: rules.email(),
      password: rules.password(),
      displayName: rules.displayName(),
    });

    if (this.repos.findUserByEmail(dto.email)) {
      throw conflict('An account with that email already exists.', 'EMAIL_TAKEN');
    }
    if (this.repos.displayNameTaken(dto.displayName)) {
      throw conflict('That display name is already taken.', 'NAME_TAKEN');
    }

    // Hash outside the transaction: scrypt is deliberately slow and must not
    // hold the store's write lock.
    const passwordHash = await hashPassword(dto.password);
    const token = randomToken();

    const result = await this.repos.transaction(() => {
      // Re-check inside the lock to close the race window.
      if (this.repos.findUserByEmail(dto.email)) {
        throw conflict('An account with that email already exists.', 'EMAIL_TAKEN');
      }
      if (this.repos.displayNameTaken(dto.displayName)) {
        throw conflict('That display name is already taken.', 'NAME_TAKEN');
      }

      const user = this.repos.createUser({ email: dto.email, passwordHash });
      const player = this.repos.createPlayer(
        createPlayerDocument({ userId: user.id, displayName: dto.displayName })
      );

      // Record the founder's grant in the audit ledger.
      this.repos.recordLedger({
        playerId: player.id,
        currency: 'crystals',
        delta: player.crystals,
        balanceAfter: player.crystals,
        reason: 'founder_grant',
      });
      this.repos.recordLedger({
        playerId: player.id,
        currency: 'zeni',
        delta: player.zeni,
        balanceAfter: player.zeni,
        reason: 'founder_grant',
      });

      const session = this.repos.createSession({
        userId: user.id,
        tokenHash: tokenDigest(token),
        ip: context.ip,
        userAgent: context.userAgent,
      });

      return { user, player, session };
    });

    logger.info('Account registered', { userId: result.user.id });
    return {
      user: this.#publicUser(result.user),
      player: result.player,
      token,
      csrfToken: csrfTokenFor(result.session.id),
      maxAge: config.security.sessionTtlMs,
    };
  }

  /**
   * Authenticate and open a session.
   * @returns {Promise<{user, player, token, csrfToken}>}
   */
  async login(input, context = {}) {
    const dto = validate(input, {
      email: rules.email(),
      password: rules.string({ min: 1, max: 200 }),
    });

    const user = this.repos.findUserByEmail(dto.email);

    // Constant-work path for unknown accounts.
    if (!user) {
      await verifyPassword(dto.password, DUMMY_HASH);
      throw unauthorized('Email or password is incorrect.');
    }

    if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
      const seconds = Math.ceil((Date.parse(user.lockedUntil) - Date.now()) / 1000);
      throw forbidden(
        `Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`,
        'ACCOUNT_LOCKED'
      );
    }

    if (user.status !== 'active') {
      throw forbidden('This account is not active.', 'ACCOUNT_DISABLED');
    }

    const valid = await verifyPassword(dto.password, user.passwordHash);

    if (!valid) {
      await this.repos.transaction(() => {
        this.repos.updateUser(user.id, (doc) => {
          doc.failedLogins = (doc.failedLogins ?? 0) + 1;
          if (doc.failedLogins >= config.security.bruteForce.maxFailedLogins) {
            doc.lockedUntil = new Date(Date.now() + config.security.bruteForce.lockoutMs).toISOString();
            doc.failedLogins = 0;
          }
          return doc;
        });
      });
      logger.warn('Failed login', { userId: user.id });
      throw unauthorized('Email or password is incorrect.');
    }

    const token = randomToken();
    const session = await this.repos.transaction(() => {
      this.repos.updateUser(user.id, (doc) => {
        doc.failedLogins = 0;
        doc.lockedUntil = null;
        doc.lastLoginAt = new Date().toISOString();
        return doc;
      });
      return this.repos.createSession({
        userId: user.id,
        tokenHash: tokenDigest(token),
        ip: context.ip,
        userAgent: context.userAgent,
      });
    });

    const player = this.repos.findPlayerById(user.id);
    logger.info('Login succeeded', { userId: user.id });

    return {
      user: this.#publicUser(user),
      player,
      token,
      csrfToken: csrfTokenFor(session.id),
      maxAge: config.security.sessionTtlMs,
    };
  }

  /** Revoke the current session. */
  async logout(sessionId) {
    if (!sessionId) return false;
    return this.repos.transaction(() => this.repos.revokeSession(sessionId));
  }

  /** Change the password and invalidate all other sessions. */
  async changePassword(userId, input, currentSessionId) {
    const dto = validate(input, {
      currentPassword: rules.string({ min: 1, max: 200 }),
      newPassword: rules.password(),
    });

    const user = this.repos.findUserById(userId);
    if (!user) throw unauthorized('Account not found.');

    const valid = await verifyPassword(dto.currentPassword, user.passwordHash);
    if (!valid) throw unauthorized('Your current password is incorrect.');

    if (dto.currentPassword === dto.newPassword) {
      throw unprocessable('SAME_PASSWORD', 'The new password must differ from the current one.');
    }

    const passwordHash = await hashPassword(dto.newPassword);
    const revoked = await this.repos.transaction(() => {
      this.repos.updateUser(userId, (doc) => {
        doc.passwordHash = passwordHash;
        return doc;
      });
      return this.repos.revokeAllSessions(userId, currentSessionId);
    });

    logger.info('Password changed', { userId, sessionsRevoked: revoked });
    return { sessionsRevoked: revoked };
  }

  /**
   * Permanently delete an account and every artefact belonging to it.
   * Implements the GDPR "right to erasure".
   */
  async deleteAccount(userId) {
    return this.repos.transaction(() => {
      for (const entry of this.repos.listRoster(userId)) this.repos.roster.delete(entry.id);
      for (const team of this.repos.listTeams(userId)) this.repos.teams.delete(team.id);
      for (const battle of this.repos.battles.findBy('playerId', userId)) {
        this.repos.battles.delete(battle.id);
      }
      for (const row of this.repos.ledger.findBy('playerId', userId)) this.repos.ledger.delete(row.id);
      for (const row of this.repos.summons.findBy('playerId', userId)) this.repos.summons.delete(row.id);
      this.repos.revokeAllSessions(userId);
      for (const session of this.repos.sessions.findBy('userId', userId)) {
        this.repos.sessions.delete(session.id);
      }
      this.repos.players.delete(userId);
      this.repos.users.delete(userId);
      return true;
    });
  }

  /** Strip secrets before a user object crosses the API boundary. */
  #publicUser(user) {
    return {
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };
  }
}

module.exports = { AuthService };
