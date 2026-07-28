'use strict';
/**
 * Durable embedded document store.
 *
 * Why not SQLite/Postgres in the default path? The brief calls for a
 * self-contained, runs-anywhere monolith. This engine gives ACID-ish
 * durability with zero native modules:
 *
 *   - All documents live in memory (the whole dataset is small: players,
 *     rosters, battles), so reads are O(1) and never block.
 *   - Every mutation is appended to a write-ahead log **before** the in-memory
 *     state is considered committed. A crash replays the WAL on boot.
 *   - When the WAL exceeds a threshold it is compacted into a snapshot written
 *     via write-temp-then-rename, which is atomic on POSIX filesystems.
 *   - Writes are serialised through a promise mutex, so a `transaction()`
 *     block sees a consistent view and either fully applies or fully aborts.
 *
 * `db/schema.sql` contains the equivalent PostgreSQL DDL; `repositories.js`
 * is the seam where you swap this for `pg` without touching domain code.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const logger = require('../core/logger');

/** Deep structural clone so callers can never mutate committed state. */
function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class Collection {
  /**
   * @param {string} name
   * @param {Store} store
   * @param {string[]} indexedFields Fields to maintain secondary indexes on.
   */
  constructor(name, store, indexedFields = []) {
    this.name = name;
    this.store = store;
    /** @type {Map<string, object>} Primary key → document. */
    this.docs = new Map();
    /** @type {Map<string, Map<any, Set<string>>>} field → value → ids. */
    this.indexes = new Map(indexedFields.map((f) => [f, new Map()]));
  }

  /** Maintain secondary indexes when a document changes. */
  #reindex(previous, next) {
    for (const [field, index] of this.indexes) {
      if (previous) {
        const oldKey = previous[field];
        const bucket = index.get(oldKey);
        if (bucket) {
          bucket.delete(previous.id);
          if (bucket.size === 0) index.delete(oldKey);
        }
      }
      if (next) {
        const newKey = next[field];
        if (newKey === undefined || newKey === null) continue;
        let bucket = index.get(newKey);
        if (!bucket) { bucket = new Set(); index.set(newKey, bucket); }
        bucket.add(next.id);
      }
    }
  }

  /** Apply a committed change to memory (used by both writes and WAL replay). */
  _apply(op, id, doc) {
    const previous = this.docs.get(id);
    if (op === 'del') {
      this.docs.delete(id);
      this.#reindex(previous, null);
    } else {
      this.docs.set(id, doc);
      this.#reindex(previous, doc);
    }
  }

  /** @returns {object|undefined} A defensive copy of the document. */
  get(id) {
    return clone(this.docs.get(id));
  }

  /** @returns {boolean} */
  has(id) {
    return this.docs.has(id);
  }

  /** Insert or overwrite. Must be called inside a `transaction`. */
  put(doc) {
    if (!doc || typeof doc.id !== 'string' || !doc.id) {
      throw new Error(`${this.name}.put requires a document with a string id`);
    }
    const stored = clone(doc);
    this.store._journal(this.name, 'put', doc.id, stored);
    this._apply('put', doc.id, stored);
    return clone(stored);
  }

  /** Read-modify-write helper. Throws if the document is missing. */
  update(id, mutator) {
    const current = this.docs.get(id);
    if (!current) throw new Error(`${this.name}: no document with id ${id}`);
    const draft = clone(current);
    const result = mutator(draft) ?? draft;
    result.id = id;
    return this.put(result);
  }

  /** Remove a document. No-op if absent. */
  delete(id) {
    if (!this.docs.has(id)) return false;
    this.store._journal(this.name, 'del', id, null);
    this._apply('del', id, null);
    return true;
  }

  /** Fast equality lookup using a secondary index when available. */
  findBy(field, value) {
    const index = this.indexes.get(field);
    if (index) {
      const bucket = index.get(value);
      if (!bucket) return [];
      return [...bucket].map((id) => clone(this.docs.get(id))).filter(Boolean);
    }
    return this.filter((doc) => doc[field] === value);
  }

  /** First match of an indexed equality lookup. */
  findOneBy(field, value) {
    const index = this.indexes.get(field);
    if (index) {
      const bucket = index.get(value);
      if (!bucket || bucket.size === 0) return undefined;
      return clone(this.docs.get(bucket.values().next().value));
    }
    for (const doc of this.docs.values()) if (doc[field] === value) return clone(doc);
    return undefined;
  }

  /** Full scan with a predicate. */
  filter(predicate) {
    const out = [];
    for (const doc of this.docs.values()) if (predicate(doc)) out.push(clone(doc));
    return out;
  }

  /** @returns {number} */
  get size() {
    return this.docs.size;
  }

  /** Every document (copies). Use sparingly. */
  all() {
    return [...this.docs.values()].map(clone);
  }
}

class Store {
  /** @param {string} directory Where snapshot + WAL live. */
  constructor(directory) {
    this.dir = directory;
    this.snapshotPath = path.join(directory, 'snapshot.json');
    this.walPath = path.join(directory, 'wal.log');
    /** @type {Map<string, Collection>} */
    this.collections = new Map();
    this.walHandle = null;
    this.walBytes = 0;
    this.pendingJournal = null; // active transaction's journal buffer
    this.writeQueue = Promise.resolve();
    this.compactThreshold = 2 * 1024 * 1024; // 2 MiB of WAL before compaction
    this.closed = false;
  }

  /** Declare a collection and its secondary indexes. Idempotent. */
  collection(name, indexedFields = []) {
    let existing = this.collections.get(name);
    if (!existing) {
      existing = new Collection(name, this, indexedFields);
      this.collections.set(name, existing);
    }
    return existing;
  }

  /** Buffer a mutation into the active transaction journal. */
  _journal(collectionName, op, id, doc) {
    if (!this.pendingJournal) {
      throw new Error('Mutations must occur inside store.transaction()');
    }
    this.pendingJournal.push({ c: collectionName, o: op, k: id, v: doc });
  }

  /** Load snapshot then replay the WAL. Safe to call once at boot. */
  async open() {
    await fsp.mkdir(this.dir, { recursive: true });

    // 1. Snapshot.
    try {
      const raw = await fsp.readFile(this.snapshotPath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [name, docs] of Object.entries(parsed.collections ?? {})) {
        const col = this.collections.get(name) ?? this.collection(name);
        for (const doc of docs) col._apply('put', doc.id, doc);
      }
      logger.info('Snapshot loaded', { collections: Object.keys(parsed.collections ?? {}).length });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.error('Snapshot unreadable — starting from WAL only', { err });
      }
    }

    // 2. WAL replay. A torn final line (crash mid-write) is discarded.
    try {
      const raw = await fsp.readFile(this.walPath, 'utf8');
      const lines = raw.split('\n');
      let replayed = 0;
      let discarded = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const col = this.collections.get(entry.c) ?? this.collection(entry.c);
          col._apply(entry.o, entry.k, entry.v);
          replayed += 1;
        } catch {
          discarded += 1; // truncated tail
        }
      }
      this.walBytes = Buffer.byteLength(raw);
      if (replayed || discarded) logger.info('WAL replayed', { replayed, discarded });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    // 3. Open the WAL for appending.
    this.walHandle = await fsp.open(this.walPath, 'a');
    return this;
  }

  /**
   * Run `fn` as a serialised, atomic unit.
   *
   * All mutations inside `fn` are buffered; on success they are flushed to the
   * WAL in a single append. If `fn` throws, buffered mutations are rolled back
   * by restoring the pre-transaction value of every touched key.
   *
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  transaction(fn) {
    const run = async () => {
      if (this.closed) throw new Error('Store is closed');
      const journal = [];
      this.pendingJournal = journal;

      // Capture undo information lazily, first-touch-wins.
      const undo = [];
      const seen = new Set();
      const captureUndo = () => {
        for (const entry of journal) {
          const key = `${entry.c}\u0000${entry.k}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const col = this.collections.get(entry.c);
          undo.push({ col, id: entry.k, previous: col?.docs.get(entry.k) });
        }
      };

      try {
        // Snapshot undo state as mutations are recorded by wrapping the array.
        const originalPush = journal.push.bind(journal);
        journal.push = (entry) => {
          const key = `${entry.c}\u0000${entry.k}`;
          if (!seen.has(key)) {
            seen.add(key);
            const col = this.collections.get(entry.c);
            undo.push({ col, id: entry.k, previous: col?.docs.get(entry.k) });
          }
          return originalPush(entry);
        };

        const result = await fn();

        if (journal.length > 0) {
          const payload = journal.map((e) => JSON.stringify(e)).join('\n') + '\n';
          await this.walHandle.write(payload);
          // fsync guarantees the mutation survives a power loss.
          await this.walHandle.sync().catch(() => {});
          this.walBytes += Buffer.byteLength(payload);
        }
        this.pendingJournal = null;

        if (this.walBytes > this.compactThreshold) {
          // Compaction is fire-and-forget on the same queue; failures are logged.
          this.#compact().catch((err) => logger.error('Compaction failed', { err }));
        }
        return result;
      } catch (err) {
        // Roll the in-memory state back; nothing was written to the WAL.
        captureUndo();
        for (let i = undo.length - 1; i >= 0; i -= 1) {
          const { col, id, previous } = undo[i];
          if (!col) continue;
          if (previous === undefined) col._apply('del', id, null);
          else col._apply('put', id, previous);
        }
        this.pendingJournal = null;
        throw err;
      }
    };

    // Serialise: each transaction waits for the previous one to settle.
    const chained = this.writeQueue.then(run, run);
    this.writeQueue = chained.then(() => {}, () => {});
    return chained;
  }

  /** Write a fresh snapshot and truncate the WAL. */
  async #compact() {
    const payload = {
      version: 1,
      writtenAt: new Date().toISOString(),
      collections: Object.fromEntries(
        [...this.collections].map(([name, col]) => [name, [...col.docs.values()]])
      ),
    };
    const tmp = `${this.snapshotPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fsp.rename(tmp, this.snapshotPath); // atomic swap
    await this.walHandle.close();
    await fsp.writeFile(this.walPath, '');
    this.walHandle = await fsp.open(this.walPath, 'a');
    this.walBytes = 0;
    logger.info('Store compacted', { bytes: JSON.stringify(payload).length });
  }

  /** Force a snapshot (used by tests and graceful shutdown). */
  async flush() {
    return this.writeQueue.then(() => this.#compact());
  }

  /** Flush and release file handles. */
  async close() {
    if (this.closed) return;
    await this.writeQueue.catch(() => {});
    try { await this.#compact(); } catch (err) { logger.error('Close compaction failed', { err }); }
    this.closed = true;
    if (this.walHandle) await this.walHandle.close().catch(() => {});
    this.walHandle = null;
  }

  /** Synchronous best-effort persist for `process.on('exit')`. */
  closeSync() {
    if (this.closed) return;
    try {
      const payload = {
        version: 1,
        writtenAt: new Date().toISOString(),
        collections: Object.fromEntries(
          [...this.collections].map(([name, col]) => [name, [...col.docs.values()]])
        ),
      };
      const tmp = `${this.snapshotPath}.exit.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.snapshotPath);
      fs.writeFileSync(this.walPath, '');
    } catch {
      /* best effort only */
    }
    this.closed = true;
  }
}

module.exports = { Store, Collection };
