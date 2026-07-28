'use strict';
/**
 * Cryptographic primitives: password hashing, stateless signed tokens,
 * constant-time comparison, and the provably-fair RNG seed chain.
 *
 * Design notes
 * ------------
 * - Passwords use scrypt (memory-hard) with a per-user 16-byte salt. The
 *   parameters live in config so they can be raised as hardware improves; the
 *   encoded hash records the parameters used, enabling transparent rehashing.
 * - Session tokens are opaque 32-byte random values. Only a SHA-256 digest of
 *   the token is persisted, so a database leak cannot be replayed as a login.
 * - CSRF uses the signed double-submit pattern: a random value in a readable
 *   cookie must match the `X-CSRF-Token` header, and both are bound to the
 *   session by an HMAC.
 */

const crypto = require('node:crypto');
const config = require('../config');

/** Timing-safe string comparison that tolerates unequal lengths. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  // Hash first so lengths always match; prevents length leakage via early exit.
  const digestA = crypto.createHash('sha256').update(bufA).digest();
  const digestB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Hash a plaintext password.
 * @returns {Promise<string>} Encoded as `scrypt$N$r$p$saltB64$hashB64`.
 */
function hashPassword(plaintext) {
  const { N, r, p, keylen, maxmem } = config.security.scrypt;
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(plaintext, salt, keylen, { N, r, p, maxmem }, (err, derived) => {
      if (err) return reject(err);
      resolve(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`);
    });
  });
}

/**
 * Verify a plaintext password against an encoded hash.
 * Always performs the full KDF so failures cost the same as successes.
 * @returns {Promise<boolean>}
 */
function verifyPassword(plaintext, encoded) {
  return new Promise((resolve) => {
    if (typeof encoded !== 'string') return resolve(false);
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);
    const N = Number.parseInt(parts[1], 10);
    const r = Number.parseInt(parts[2], 10);
    const p = Number.parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return resolve(false);
    crypto.scrypt(
      plaintext,
      salt,
      expected.length,
      { N, r, p, maxmem: config.security.scrypt.maxmem },
      (err, derived) => {
        if (err) return resolve(false);
        resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
      }
    );
  });
}

/** Generate a cryptographically random, URL-safe opaque token. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** One-way digest used to store session tokens at rest. */
function tokenDigest(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** RFC 4122 v4 identifier. */
function uuid() {
  return crypto.randomUUID();
}

/** Short, sortable, collision-resistant id: `<base36 time><random>`. */
function shortId(prefix = '') {
  const time = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString('base64url');
  return `${prefix}${time}${rand}`;
}

/** Keyed HMAC-SHA256, hex encoded. */
function hmac(value, key = config.security.sessionSecret) {
  return crypto.createHmac('sha256', key).update(String(value)).digest('hex');
}

/**
 * Derive a CSRF token bound to a session id. Deterministic, so it can be
 * re-derived on any node without shared state.
 */
function csrfTokenFor(sessionId) {
  return hmac(`csrf:${sessionId}`).slice(0, 40);
}

/** Validate a submitted CSRF token against the session it claims to belong to. */
function csrfValid(sessionId, submitted) {
  if (!sessionId || !submitted) return false;
  return safeEqual(csrfTokenFor(sessionId), submitted);
}

/**
 * Provably-fair RNG stream.
 *
 * Uniform values are derived from HMAC-SHA512(serverSeed, `${clientSeed}:${nonce}:${cursor}`).
 * The SHA-256 of the server seed is published *before* any pull, so once the
 * seed is rotated and revealed, a player can recompute every outcome and verify
 * the house never re-rolled. This is the same construction used by audited
 * casino RNGs and is what makes the free gacha economy trustworthy.
 */
class FairRandom {
  /**
   * @param {string} serverSeed Secret seed for the current epoch.
   * @param {string} clientSeed Player-supplied (or player-visible) seed.
   * @param {number} nonce      Monotonically increasing per-player counter.
   */
  constructor(serverSeed, clientSeed, nonce) {
    this.serverSeed = serverSeed;
    this.clientSeed = String(clientSeed);
    this.nonce = Number(nonce);
    this.cursor = 0;
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
  }

  /** Refill the entropy buffer with the next HMAC block. */
  #refill() {
    this.buffer = crypto
      .createHmac('sha512', this.serverSeed)
      .update(`${this.clientSeed}:${this.nonce}:${this.cursor}`)
      .digest();
    this.cursor += 1;
    this.offset = 0;
  }

  /** @returns {number} Uniform float in [0, 1). */
  next() {
    if (this.offset + 6 > this.buffer.length) this.#refill();
    // 48 bits of entropy → exactly representable as a double.
    const value = this.buffer.readUIntBE(this.offset, 6);
    this.offset += 6;
    return value / 0x1000000000000;
  }

  /** @returns {number} Uniform integer in [min, max] inclusive. */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** @returns {*} Uniformly chosen element of a non-empty array. */
  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }

  /**
   * Weighted selection.
   * @param {Array<{weight:number}>} entries
   */
  weighted(entries) {
    const total = entries.reduce((sum, e) => sum + e.weight, 0);
    let roll = this.next() * total;
    for (const entry of entries) {
      roll -= entry.weight;
      if (roll <= 0) return entry;
    }
    return entries[entries.length - 1];
  }

  /** In-place Fisher–Yates shuffle driven by the fair stream. */
  shuffle(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/** Public commitment to the current server seed. */
function serverSeedHash(serverSeed = config.security.gachaSecret) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

module.exports = {
  safeEqual,
  hashPassword,
  verifyPassword,
  randomToken,
  tokenDigest,
  uuid,
  shortId,
  hmac,
  csrfTokenFor,
  csrfValid,
  FairRandom,
  serverSeedHash,
};
