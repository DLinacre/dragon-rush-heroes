'use strict';
/**
 * Unit + integration test suite (zero dependencies).
 *
 * Covers the security-critical and economy-critical paths: crypto, validation,
 * the durable store's transaction/rollback semantics, the combat engine's
 * determinism and invariants, gacha rates and pity, and the full HTTP surface
 * including auth, CSRF and rate limiting.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Isolated environment: never touch the developer's real data directory.
const TEST_DATA = path.join(__dirname, '..', '.data-test');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TEST_DATA;
process.env.SESSION_SECRET = 'test-session-secret-test-session-secret';
process.env.GACHA_SECRET = 'test-gacha-secret-test-gacha-secret-abc';
process.env.LOG_LEVEL = 'silent';
process.env.PORT = '3501'; // config rejects 0; the test binds to an ephemeral port itself
fs.rmSync(TEST_DATA, { recursive: true, force: true });

/* ------------------------------------------------------------ test runner */

const tests = [];
let currentSuite = 'general';

const describe = (name, fn) => { currentSuite = name; fn(); };
const it = (name, fn) => tests.push({ suite: currentSuite, name, fn });

async function run() {
  let passed = 0;
  const failures = [];
  let suite = null;

  for (const test of tests) {
    if (test.suite !== suite) {
      suite = test.suite;
      console.log(`\n\x1b[1m${suite}\x1b[0m`);
    }
    try {
      await test.fn();
      passed += 1;
      console.log(`  \x1b[32m✓\x1b[0m ${test.name}`);
    } catch (err) {
      failures.push({ ...test, err });
      console.log(`  \x1b[31m✗\x1b[0m ${test.name}`);
      console.log(`    \x1b[31m${err.message.split('\n')[0]}\x1b[0m`);
    }
  }

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`${passed}/${tests.length} passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
  if (failures.length) {
    console.log('\nFailure detail:');
    for (const f of failures) {
      console.log(`\n  ${f.suite} › ${f.name}`);
      console.log(`  ${f.err.stack?.split('\n').slice(0, 4).join('\n  ')}`);
    }
  }
  return failures.length === 0 ? 0 : 1;
}

/* ================================== crypto ================================ */

const crypto = require('../server/core/crypto');

describe('core/crypto', () => {
  it('hashes and verifies a password', async () => {
    const hash = await crypto.hashPassword('correct horse battery');
    assert.ok(hash.startsWith('scrypt$'));
    assert.equal(await crypto.verifyPassword('correct horse battery', hash), true);
    assert.equal(await crypto.verifyPassword('wrong password', hash), false);
  });

  it('produces a unique salt per hash', async () => {
    const a = await crypto.hashPassword('same');
    const b = await crypto.hashPassword('same');
    assert.notEqual(a, b);
  });

  it('rejects malformed hashes without throwing', async () => {
    assert.equal(await crypto.verifyPassword('x', 'garbage'), false);
    assert.equal(await crypto.verifyPassword('x', null), false);
  });

  it('compares in constant time across lengths', () => {
    assert.equal(crypto.safeEqual('abc', 'abc'), true);
    assert.equal(crypto.safeEqual('abc', 'abcd'), false);
    assert.equal(crypto.safeEqual('', ''), true);
  });

  it('binds CSRF tokens to a session id', () => {
    const token = crypto.csrfTokenFor('session-1');
    assert.equal(crypto.csrfValid('session-1', token), true);
    assert.equal(crypto.csrfValid('session-2', token), false);
    assert.equal(crypto.csrfValid('session-1', 'forged'), false);
  });

  it('FairRandom is deterministic for a given seed triple', () => {
    const a = new crypto.FairRandom('server', 'client', 7);
    const b = new crypto.FairRandom('server', 'client', 7);
    const seqA = Array.from({ length: 40 }, () => a.next());
    const seqB = Array.from({ length: 40 }, () => b.next());
    assert.deepEqual(seqA, seqB);
  });

  it('FairRandom diverges when the nonce changes', () => {
    const a = new crypto.FairRandom('server', 'client', 1).next();
    const b = new crypto.FairRandom('server', 'client', 2).next();
    assert.notEqual(a, b);
  });

  it('FairRandom stays within [0,1)', () => {
    const rng = new crypto.FairRandom('s', 'c', 0);
    for (let i = 0; i < 5000; i += 1) {
      const v = rng.next();
      assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    }
  });

  it('FairRandom.int respects inclusive bounds', () => {
    const rng = new crypto.FairRandom('s', 'c', 3);
    for (let i = 0; i < 2000; i += 1) {
      const v = rng.int(5, 9);
      assert.ok(v >= 5 && v <= 9 && Number.isInteger(v));
    }
  });
});

/* ================================ validation ============================== */

const { validate, rules, escapeHtml } = require('../server/core/validate');

describe('core/validate', () => {
  it('accepts a well-formed payload and strips unknown keys', () => {
    const out = validate(
      { email: 'A@B.CO', password: 'longenoughpw', extra: 'dropped' },
      { email: rules.email(), password: rules.password() }
    );
    assert.equal(out.email, 'a@b.co');
    assert.equal(out.extra, undefined);
  });

  it('rejects short passwords with a field error', () => {
    assert.throws(
      () => validate({ password: 'short' }, { password: rules.password() }),
      (err) => err.code === 'VALIDATION_FAILED' && Boolean(err.details.fields.password)
    );
  });

  it('rejects common passwords', () => {
    assert.throws(() => validate({ password: 'password123' }, { password: rules.password() }));
  });

  it('rejects invalid emails', () => {
    for (const bad of ['no-at', 'a@b', '@b.co', 'a b@c.co']) {
      assert.throws(() => validate({ email: bad }, { email: rules.email() }), undefined, bad);
    }
  });

  it('strips control characters from strings', () => {
    const out = validate({ n: 'ab\u0000\u0007cd' }, { n: rules.string({ min: 1 }) });
    assert.equal(out.n, 'abcd');
  });

  it('enforces integer bounds', () => {
    assert.throws(() => validate({ n: 99 }, { n: rules.int({ min: 1, max: 10 }) }));
    assert.equal(validate({ n: '5' }, { n: rules.int({ min: 1, max: 10 }) }).n, 5);
  });

  it('applies defaults for absent optional fields', () => {
    assert.equal(validate({}, { n: rules.int({ default: 3 }) }).n, 3);
  });

  it('enforces array size caps', () => {
    assert.throws(() =>
      validate({ a: [1, 2, 3, 4] }, { a: rules.array(rules.int(), { max: 3 }) })
    );
  });

  it('rejects unsafe display names', () => {
    // Note: leading/trailing whitespace is trimmed by the sanitiser before the
    // pattern is applied, so ' Solvane' is valid (and normalised) by design.
    for (const bad of ['<script>', 'a', '!!!', '_leading', 'x'.repeat(21)]) {
      assert.throws(() => validate({ d: bad }, { d: rules.displayName() }), undefined, bad);
    }
    assert.equal(validate({ d: 'Solvane_01' }, { d: rules.displayName() }).d, 'Solvane_01');
    assert.equal(validate({ d: '  Solvane  ' }, { d: rules.displayName() }).d, 'Solvane');
  });

  it('escapes HTML metacharacters', () => {
    assert.equal(escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  });
});

/* ================================== store ================================= */

const { Store } = require('../server/data/store');

describe('data/store', () => {
  const dir = path.join(TEST_DATA, 'store-unit');

  it('persists writes and reads them back', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    const store = new Store(dir);
    store.collection('things', ['kind']);
    await store.open();
    await store.transaction(() => {
      store.collection('things').put({ id: 't1', kind: 'a', value: 1 });
    });
    assert.equal(store.collection('things').get('t1').value, 1);
    await store.close();
  });

  it('recovers state from the WAL after an unclean restart', async () => {
    const dir2 = path.join(TEST_DATA, 'store-wal');
    fs.rmSync(dir2, { recursive: true, force: true });
    const a = new Store(dir2);
    a.collection('things');
    await a.open();
    await a.transaction(() => a.collection('things').put({ id: 'x', v: 42 }));
    // Simulate a crash: drop the handle without compacting.
    await a.walHandle.close();
    a.walHandle = null;
    a.closed = true;

    const b = new Store(dir2);
    b.collection('things');
    await b.open();
    assert.equal(b.collection('things').get('x').v, 42);
    await b.close();
  });

  it('rolls back every mutation when a transaction throws', async () => {
    const dir3 = path.join(TEST_DATA, 'store-rollback');
    fs.rmSync(dir3, { recursive: true, force: true });
    const store = new Store(dir3);
    const col = store.collection('things');
    await store.open();
    await store.transaction(() => col.put({ id: 'keep', v: 1 }));

    await assert.rejects(store.transaction(() => {
      col.put({ id: 'keep', v: 999 });
      col.put({ id: 'new', v: 2 });
      throw new Error('abort');
    }));

    assert.equal(col.get('keep').v, 1, 'existing row must be restored');
    assert.equal(col.get('new'), undefined, 'new row must be removed');
    await store.close();
  });

  it('returns defensive copies so callers cannot mutate committed state', async () => {
    const dir4 = path.join(TEST_DATA, 'store-copy');
    fs.rmSync(dir4, { recursive: true, force: true });
    const store = new Store(dir4);
    const col = store.collection('things');
    await store.open();
    await store.transaction(() => col.put({ id: 'a', nested: { n: 1 } }));
    const copy = col.get('a');
    copy.nested.n = 500;
    assert.equal(col.get('a').nested.n, 1);
    await store.close();
  });

  it('maintains secondary indexes through updates', async () => {
    const dir5 = path.join(TEST_DATA, 'store-index');
    fs.rmSync(dir5, { recursive: true, force: true });
    const store = new Store(dir5);
    const col = store.collection('things', ['kind']);
    await store.open();
    await store.transaction(() => {
      col.put({ id: '1', kind: 'a' });
      col.put({ id: '2', kind: 'a' });
      col.put({ id: '3', kind: 'b' });
    });
    assert.equal(col.findBy('kind', 'a').length, 2);
    await store.transaction(() => col.update('1', (d) => { d.kind = 'b'; return d; }));
    assert.equal(col.findBy('kind', 'a').length, 1);
    assert.equal(col.findBy('kind', 'b').length, 2);
    await store.close();
  });

  it('serialises concurrent transactions', async () => {
    const dir6 = path.join(TEST_DATA, 'store-concurrent');
    fs.rmSync(dir6, { recursive: true, force: true });
    const store = new Store(dir6);
    const col = store.collection('counter');
    await store.open();
    await store.transaction(() => col.put({ id: 'c', n: 0 }));
    // 50 interleaved read-modify-writes must not lose an increment.
    await Promise.all(Array.from({ length: 50 }, () =>
      store.transaction(() => col.update('c', (d) => { d.n += 1; return d; }))
    ));
    assert.equal(col.get('c').n, 50);
    await store.close();
  });
});

/* ================================= content ================================ */

const content = require('../server/domain/content');

describe('domain/content', () => {
  it('builds a roster of at least 400 fighters', () => {
    assert.ok(content.CATALOGUE.fighters.length >= 400,
      `only ${content.CATALOGUE.fighters.length}`);
  });

  it('gives every fighter a unique id', () => {
    const ids = new Set(content.CATALOGUE.fighters.map((f) => f.id));
    assert.equal(ids.size, content.CATALOGUE.fighters.length);
  });

  it('is deterministic across rebuilds', () => {
    const rebuilt = content.buildCatalogue();
    assert.equal(rebuilt.fighters.length, content.CATALOGUE.fighters.length);
    assert.deepEqual(rebuilt.fighters[0], content.CATALOGUE.fighters[0]);
    assert.deepEqual(
      rebuilt.fighters[rebuilt.fighters.length - 1],
      content.CATALOGUE.fighters[content.CATALOGUE.fighters.length - 1]
    );
  });

  it('gives every fighter complete, well-formed data', () => {
    for (const f of content.CATALOGUE.fighters) {
      assert.ok(content.RARITIES[f.rarity], `bad rarity on ${f.id}`);
      assert.ok(content.ELEMENTS[f.element], `bad element on ${f.id}`);
      assert.ok(f.stats.hp > 0 && f.stats.strike > 0 && f.stats.blast > 0, `bad stats on ${f.id}`);
      assert.ok(f.abilities.length >= 1, `no abilities on ${f.id}`);
      assert.ok(f.moves.special.name && f.moves.ultimate.name, `no moves on ${f.id}`);
      assert.ok(f.art.seed && typeof f.art.hue === 'number', `no art on ${f.id}`);
      assert.ok(Array.isArray(f.tags) && f.tags.length > 0, `no tags on ${f.id}`);
    }
  });

  it('scales stats upward with rarity', () => {
    const avg = (rarity, key) => {
      const list = content.CATALOGUE.fighters.filter((f) => f.rarity === rarity);
      return list.reduce((s, f) => s + f.stats[key], 0) / list.length;
    };
    assert.ok(avg('ULTRA', 'hp') > avg('SPARKING', 'hp'));
    assert.ok(avg('SPARKING', 'hp') > avg('EXTREME', 'hp'));
    assert.ok(avg('EXTREME', 'hp') > avg('HERO', 'hp'));
  });

  it('implements the element wheel correctly', () => {
    const m = content.elementMultiplier;
    assert.equal(m('RED', 'YELLOW'), 1.5);
    assert.equal(m('YELLOW', 'RED'), 0.65);
    assert.equal(m('RED', 'RED'), 1);
    assert.equal(m('DARK', 'RED'), 1.5);
    assert.equal(m('LIGHT', 'DARK'), 1.5);
    assert.equal(m('DARK', 'LIGHT'), 0.65);
    assert.equal(m('RED', 'LIGHT'), 1);
  });

  it('covers every element in the roster', () => {
    const present = new Set(content.CATALOGUE.fighters.map((f) => f.element));
    for (const e of Object.keys(content.ELEMENTS)) {
      assert.ok(present.has(e), `element ${e} has no fighters`);
    }
  });

  it('resolves every banner and stage reference', () => {
    for (const banner of content.BANNERS) {
      for (const id of banner.featured) {
        assert.ok(content.CATALOGUE.byId.has(id), `banner ${banner.id} → missing ${id}`);
      }
      const total = Object.values(banner.rates).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - 1) < 0.001, `banner ${banner.id} rates sum to ${total}`);
    }
    for (const stage of content.STAGES) {
      for (const id of stage.enemyTeam) {
        assert.ok(content.CATALOGUE.byId.has(id), `stage ${stage.id} → missing ${id}`);
      }
    }
  });
});

/* ================================= economy ================================ */

const economy = require('../server/domain/economy');

describe('domain/economy', () => {
  it('grants the £500-equivalent founder bundle', () => {
    assert.equal(economy.FOUNDER_GRANT_CRYSTALS, 25000);
    assert.equal(economy.FOUNDER_GRANT_CRYSTALS / economy.SUMMON_COST_MULTI, 25);
  });

  it('creates players with the free permanent pass and unlimited stamina', () => {
    const p = economy.createPlayerDocument({ userId: 'u1', displayName: 'Tester' });
    assert.equal(p.pass.active, true);
    assert.equal(p.pass.expiresAt, null, 'pass must never expire');
    assert.equal(p.stamina.unlimited, true);
    assert.equal(p.crystals, 25000);
  });

  it('reports no monetisation in the economy summary', () => {
    const s = economy.economySummary();
    assert.equal(s.freeForever, true);
    assert.equal(s.monetisation, 'none');
    assert.equal(s.passIncluded, true);
    assert.equal(s.staminaUnlimited, true);
  });

  it('maps Z-Power onto the star ladder', () => {
    assert.equal(economy.starsForZPower(0), 0);
    assert.equal(economy.starsForZPower(500), 1);
    assert.equal(economy.starsForZPower(499), 0);
    assert.equal(economy.starsForZPower(32000), 7);
    assert.equal(economy.starsForZPower(999999), 7, 'stars must cap at 7');
  });

  it('raises the level cap with each class-up tier', () => {
    assert.ok(economy.maxLevelForStars(7) > economy.maxLevelForStars(0));
    assert.equal(economy.maxLevelForStars(99), economy.maxLevelForStars(7));
  });

  it('summons are reproducible for identical seeds', () => {
    const banner = economy.getBanner('legendary-rising');
    const args = {
      banner, count: 10, pity: { sinceSparking: 0, sinceLegends: 0 },
      serverSeed: 'srv', clientSeed: 'cli', nonce: 5,
    };
    const a = economy.performSummon(args);
    const b = economy.performSummon(args);
    assert.deepEqual(a.results.map((r) => r.fighterId), b.results.map((r) => r.fighterId));
  });

  it('guarantees Sparking-or-better in every multi', () => {
    const banner = economy.getBanner('legendary-rising');
    for (let n = 0; n < 40; n += 1) {
      const { results } = economy.performSummon({
        banner, count: 10, pity: { sinceSparking: 0, sinceLegends: 0 },
        serverSeed: 'srv', clientSeed: 'cli', nonce: n,
      });
      const best = Math.max(...results.map((r) => content.RARITIES[r.rarity].tier));
      assert.ok(best >= 3, `multi #${n} had no Sparking+`);
    }
  });

  it('hard pity forces a Legends drop', () => {
    const banner = economy.getBanner('ascension');
    const { results } = economy.performSummon({
      banner, count: 1, pity: { sinceSparking: 0, sinceLegends: economy.PITY_LEGENDS },
      serverSeed: 'srv', clientSeed: 'cli', nonce: 1,
    });
    assert.ok(content.RARITIES[results[0].rarity].tier >= 4, `got ${results[0].rarity}`);
  });

  it('observed rates track published rates over a large sample', () => {
    const banner = economy.getBanner('legendary-rising');
    let pity = { sinceSparking: 0, sinceLegends: 0 };
    const tally = {};
    const PULLS = 400;
    for (let n = 0; n < PULLS; n += 1) {
      const r = economy.performSummon({
        banner, count: 1, pity, serverSeed: 'srv', clientSeed: 'cli', nonce: n,
      });
      pity = r.pity;
      tally[r.results[0].rarity] = (tally[r.results[0].rarity] ?? 0) + 1;
    }
    // Pity inflates the high end, so assert direction rather than exact rates.
    assert.ok((tally.HERO ?? 0) > (tally.EXTREME ?? 0), 'HERO should dominate');
    assert.ok((tally.EXTREME ?? 0) > (tally.LEGENDS ?? 0), 'EXTREME beats LEGENDS');
    assert.equal(Object.values(tally).reduce((a, b) => a + b, 0), PULLS);
  });

  it('merges duplicates into Z-Power instead of new entries', () => {
    const roster = new Map();
    const results = [
      { fighterId: 'f1', rarity: 'SPARKING', zPower: 1200 },
      { fighterId: 'f1', rarity: 'SPARKING', zPower: 1200 },
    ];
    const first = economy.applySummonToRoster([results[0]], roster);
    assert.equal(first[0].isNew, true);
    roster.set('f1', { zPower: first[0].zPowerTotal });
    const second = economy.applySummonToRoster([results[1]], roster);
    assert.equal(second[0].isNew, false);
    assert.equal(second[0].zPowerTotal, 2400);
  });
});

/* ================================== combat ================================ */

const combat = require('../server/domain/combat');

describe('domain/combat', () => {
  const ids = content.CATALOGUE.fighters.slice(0, 3).map((f) => f.id);
  const foes = content.CATALOGUE.fighters.slice(50, 53).map((f) => f.id);
  const newBattle = (seed = 'seed-a') => combat.createBattle({
    playerTeam: ids, roster: new Map(), enemyTeam: foes,
    enemyLevel: 20, seed, mode: 'story', stageId: 'ch1-1',
  });

  it('starts with a full hand and both teams alive', () => {
    const s = newBattle();
    assert.equal(s.player.hand.length, combat.constants.HAND_SIZE);
    assert.equal(s.status, 'active');
    assert.ok(s.player.members.every((m) => m.alive));
    assert.ok(s.enemy.members.every((m) => m.alive));
  });

  it('playing a card spends Ki and deals damage', () => {
    const s = newBattle();
    const attacker = combat.activeOf(s, 'player');
    const card = s.player.hand.find((c) => attacker.ki >= c.cost);
    const kiBefore = attacker.ki;
    const hpBefore = combat.activeOf(s, 'enemy').hp;
    const events = combat.playCard(s, 'player', card.uid);
    assert.ok(combat.activeOf(s, 'player').ki < kiBefore || card.cost === 0);
    assert.ok(events.some((e) => e.type === 'damage'));
    assert.ok(combat.activeOf(s, 'enemy').hp < hpBefore);
  });

  it('rejects a card the player cannot afford', () => {
    const s = newBattle();
    const attacker = combat.activeOf(s, 'player');
    attacker.ki = 0;
    const costly = s.player.hand.find((c) => c.cost > 0);
    if (costly) {
      assert.throws(() => combat.playCard(s, 'player', costly.uid), /INSUFFICIENT_KI/);
    }
  });

  it('rejects a card that is not in hand', () => {
    const s = newBattle();
    assert.throws(() => combat.playCard(s, 'player', 'not-a-real-card'), /CARD_NOT_IN_HAND/);
  });

  it('charge always succeeds and restores Ki (no deadlock)', () => {
    const s = newBattle();
    const a = combat.activeOf(s, 'player');
    a.ki = 0;
    a.vanish = 0;
    a.mainAbilityUsed = true;
    const events = combat.charge(s, 'player');
    assert.ok(events.some((e) => e.type === 'charge'));
    assert.ok(combat.activeOf(s, 'player').ki > 0, 'charge must restore Ki');
  });

  it('vanish requires a charged gauge', () => {
    const s = newBattle();
    combat.activeOf(s, 'player').vanish = 0;
    assert.throws(() => combat.vanish(s, 'player'), /VANISH_NOT_READY/);
  });

  it('rising rush requires all seven dragon balls', () => {
    const s = newBattle();
    s.player.dragonBalls = 3;
    assert.throws(() => combat.risingRush(s, 'player'), /RISING_RUSH_NOT_READY/);
    s.player.dragonBalls = 7;
    const events = combat.risingRush(s, 'player');
    assert.ok(events.some((e) => e.type === 'rising_rush'));
    assert.equal(s.player.dragonBalls, 0, 'balls must be consumed');
  });

  it('switching is blocked while the substitution counter is up', () => {
    const s = newBattle();
    combat.activeOf(s, 'player').substitution = 4;
    assert.throws(() => combat.switchFighter(s, 'player', 1), /SUBSTITUTION_ON_COOLDOWN/);
  });

  it('cannot switch to a defeated fighter', () => {
    const s = newBattle();
    combat.activeOf(s, 'player').substitution = 0;
    s.player.members[1].alive = false;
    assert.throws(() => combat.switchFighter(s, 'player', 1), /FIGHTER_DEFEATED/);
  });

  it('element advantage increases damage', () => {
    // Find a matched pair where the attacker counters the defender.
    const red = content.CATALOGUE.fighters.find((f) => f.element === 'RED' && f.rarity === 'SPARKING');
    const yellow = content.CATALOGUE.fighters.find((f) => f.element === 'YELLOW');
    const blue = content.CATALOGUE.fighters.find((f) => f.element === 'BLUE');
    const advantaged = combat.createBattle({
      playerTeam: [red.id], roster: new Map(), enemyTeam: [yellow.id],
      enemyLevel: 1, seed: 'elem', mode: 'training',
    });
    const disadvantaged = combat.createBattle({
      playerTeam: [red.id], roster: new Map(), enemyTeam: [blue.id],
      enemyLevel: 1, seed: 'elem', mode: 'training',
    });
    const card = { arts: 'STRIKE', cost: 15 };
    const strong = combat.computeDamage(advantaged,
      combat.activeOf(advantaged, 'player'), combat.activeOf(advantaged, 'enemy'), card);
    const weak = combat.computeDamage(disadvantaged,
      combat.activeOf(disadvantaged, 'player'), combat.activeOf(disadvantaged, 'enemy'), card);
    assert.equal(strong.element, 1.5);
    assert.equal(weak.element, 0.65);
  });

  it('hp never goes negative and KO ends the fight', () => {
    const s = newBattle();
    for (const m of s.enemy.members) { m.hp = 1; }
    let guard = 0;
    while (s.status === 'active' && guard < 300) {
      const a = combat.activeOf(s, 'player');
      const card = s.player.hand.find((c) => a.ki >= c.cost);
      try {
        if (card) combat.playCard(s, 'player', card.uid);
        else combat.charge(s, 'player');
      } catch { combat.charge(s, 'player'); }
      guard += 1;
    }
    assert.equal(s.status, 'complete');
    assert.equal(s.winner, 'player');
    for (const m of [...s.player.members, ...s.enemy.members]) {
      assert.ok(m.hp >= 0, 'hp went negative');
    }
  });

  it('plays out a full battle deterministically', () => {
    const play = (seed) => {
      const s = newBattle(seed);
      let guard = 0;
      while (s.status === 'active' && guard < 400) {
        const a = combat.activeOf(s, 'player');
        const card = s.player.hand.find((c) => a.ki >= c.cost);
        try {
          if (s.player.dragonBalls >= 7) combat.risingRush(s, 'player');
          else if (card) combat.playCard(s, 'player', card.uid);
          else combat.charge(s, 'player');
        } catch { combat.charge(s, 'player'); }
        if (s.status === 'active') combat.enemyTurn(s);
        guard += 1;
      }
      return `${s.winner}:${s.count}:${s.player.members.map((m) => m.hp).join(',')}`;
    };
    assert.equal(play('same-seed'), play('same-seed'));
    assert.notEqual(play('seed-1'), play('seed-2'));
  });

  it('survives a snapshot/restore round trip', () => {
    const s = newBattle();
    const a = combat.activeOf(s, 'player');
    const card = s.player.hand.find((c) => a.ki >= c.cost);
    combat.playCard(s, 'player', card.uid);
    const restored = combat.restoreBattle(JSON.parse(JSON.stringify(combat.snapshotBattle(s))));
    assert.equal(restored.status, s.status);
    assert.equal(restored.count, s.count);
    assert.equal(combat.activeOf(restored, 'enemy').hp, combat.activeOf(s, 'enemy').hp);
    assert.equal(restored.player.hand.length, s.player.hand.length);
  });

  it('never leaks internal engine fields to the client view', () => {
    const view = combat.serialiseBattle(newBattle());
    assert.equal(view.player.members[0].def, undefined);
    assert.equal(view.enemy.hand, undefined, 'enemy hand must stay hidden');
    assert.ok(typeof view.enemy.handCount === 'number');
  });

  it('AI always produces a legal action', () => {
    const s = newBattle();
    for (let i = 0; i < 60 && s.status === 'active'; i += 1) {
      const events = combat.enemyTurn(s);
      assert.ok(Array.isArray(events));
    }
  });
});

/* ============================== HTTP integration ========================== */

describe('http integration', () => {
  let server;
  let base;
  let stopApp;
  const jar = {};

  /** Minimal fetch helper that maintains a cookie jar. */
  function call(method, urlPath, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const cookieHeader = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      const req = http.request(
        `${base}${urlPath}`,
        {
          method,
          headers: {
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            ...(jar.dbh_csrf ? { 'X-CSRF-Token': jar.dbh_csrf } : {}),
            ...extraHeaders,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => {
            for (const raw of res.headers['set-cookie'] ?? []) {
              const [pair] = raw.split(';');
              const idx = pair.indexOf('=');
              const key = pair.slice(0, idx);
              const value = decodeURIComponent(pair.slice(idx + 1));
              if (value === '') delete jar[key]; else jar[key] = value;
            }
            let json = null;
            try { json = JSON.parse(text); } catch { /* non-JSON */ }
            resolve({ status: res.statusCode, body: json, headers: res.headers });
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it('boots the application', async () => {
    const { createApp } = require('../server/index.js');
    const built = await createApp();
    stopApp = built.stop;
    server = built.app.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const res = await call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'healthy');
  });

  it('serves the catalogue with 400+ fighters', async () => {
    const res = await call('GET', '/api/catalogue');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.fighters.length >= 400);
    assert.equal(res.body.data.economy.freeForever, true);
  });

  it('sets strict security headers', async () => {
    const res = await call('GET', '/api/health');
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.ok(res.headers['referrer-policy']);
  });

  it('reports an anonymous session before login', async () => {
    const res = await call('GET', '/api/auth/session');
    assert.equal(res.body.data.authenticated, false);
  });

  it('rejects registration with a weak password', async () => {
    const res = await call('POST', '/api/auth/register', {
      email: 'weak@test.com', password: 'short', displayName: 'Weak',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });

  it('registers an account with the founder grant', async () => {
    const res = await call('POST', '/api/auth/register', {
      email: 'hero@test.com', password: 'verySecurePass123', displayName: 'Hero',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.player.crystals, 25000);
    assert.equal(res.body.data.player.pass.active, true);
    assert.ok(jar.dbh_session, 'session cookie must be set');
    assert.ok(jar.dbh_csrf, 'csrf cookie must be set');
  });

  it('never returns a password hash', async () => {
    const res = await call('GET', '/api/player');
    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(res.body).includes('passwordHash'));
    assert.ok(!JSON.stringify(res.body).includes('scrypt$'));
  });

  it('rejects a duplicate email', async () => {
    const res = await call('POST', '/api/auth/register', {
      email: 'hero@test.com', password: 'anotherPass12345', displayName: 'Clone',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EMAIL_TAKEN');
  });

  it('rejects a mutating request without a CSRF token', async () => {
    const saved = jar.dbh_csrf;
    delete jar.dbh_csrf;
    const res = await call('POST', '/api/summon', { bannerId: 'legendary-rising', count: 1 });
    jar.dbh_csrf = saved;
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'CSRF_REJECTED');
  });

  it('rejects a forged CSRF token', async () => {
    const res = await call('POST', '/api/summon',
      { bannerId: 'legendary-rising', count: 1 }, { 'X-CSRF-Token': 'forged-token' });
    assert.equal(res.status, 403);
  });

  it('performs a multi-summon and debits crystals', async () => {
    const before = (await call('GET', '/api/player')).body.data.profile.crystals;
    const res = await call('POST', '/api/summon', { bannerId: 'legendary-rising', count: 10 });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.results.length, 10);
    assert.equal(res.body.data.crystals, before - 1000);
    assert.ok(res.body.data.verification.serverSeedHash);
  });

  it('rejects an unknown banner', async () => {
    const res = await call('POST', '/api/summon', { bannerId: 'does-not-exist', count: 1 });
    assert.equal(res.status, 404);
  });

  it('rejects an invalid summon count', async () => {
    const res = await call('POST', '/api/summon', { bannerId: 'legendary-rising', count: 5 });
    assert.equal(res.status, 400);
  });

  it('runs a battle from start to reward', async () => {
    const player = (await call('GET', '/api/player')).body.data;
    const team = player.roster.slice(0, 3).map((r) => r.fighterId);
    const start = await call('POST', '/api/battles', { stageId: 'ch1-1', members: team });
    assert.equal(start.status, 201);
    const battleId = start.body.data.battleId;

    let rewards = null;
    for (let i = 0; i < 200 && !rewards; i += 1) {
      const view = (await call('GET', `/api/battles/${battleId}`)).body.data.state;
      if (view.status !== 'active') break;
      const active = view.player.members[view.player.active];
      const card = view.player.hand.find((c) => active.ki >= c.cost);
      const action = view.player.risingRushReady
        ? { action: 'rising_rush' }
        : card ? { action: 'card', cardUid: card.uid } : { action: 'charge' };
      const res = await call('POST', `/api/battles/${battleId}/action`, action);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      if (res.body.data.rewards) rewards = res.body.data.rewards;
    }
    assert.ok(rewards, 'battle should conclude');
    assert.equal(typeof rewards.won, 'boolean');
  });

  it('blocks a second concurrent battle', async () => {
    const player = (await call('GET', '/api/player')).body.data;
    const team = player.roster.slice(0, 3).map((r) => r.fighterId);
    const first = await call('POST', '/api/battles', { stageId: 'ch1-2', members: team });
    assert.equal(first.status, 201);
    const second = await call('POST', '/api/battles', { stageId: 'ch1-3', members: team });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'BATTLE_IN_PROGRESS');
    await call('POST', `/api/battles/${first.body.data.battleId}/forfeit`);
  });

  it('refuses a team containing an unowned fighter', async () => {
    const res = await call('POST', '/api/battles', {
      stageId: 'ch1-1', members: ['not-a-real-fighter'],
    });
    assert.ok(res.status === 422 || res.status === 400, `got ${res.status}`);
  });

  it('refuses to train a fighter the player does not own', async () => {
    const res = await call('POST', '/api/roster/train', { fighterId: 'ghost-fighter', levels: 1 });
    assert.equal(res.status, 404);
  });

  it('writes every currency movement to the ledger', async () => {
    const res = await call('GET', '/api/player/ledger?limit=50');
    assert.equal(res.status, 200);
    const reasons = res.body.data.entries.map((e) => e.reason);
    assert.ok(reasons.includes('founder_grant'), 'grant must be recorded');
    assert.ok(reasons.some((r) => r.startsWith('summon')), 'summons must be recorded');
  });

  it('persists settings changes', async () => {
    const res = await call('PATCH', '/api/player/settings', { reducedMotion: true, theme: 'void' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.settings.reducedMotion, true);
    const check = await call('GET', '/api/player');
    assert.equal(check.body.data.profile.settings.reducedMotion, true);
  });

  it('rejects an invalid settings enum', async () => {
    const res = await call('PATCH', '/api/player/settings', { theme: 'not-a-theme' });
    assert.equal(res.status, 400);
  });

  it('enforces display-name uniqueness', async () => {
    const other = {};
    // Register a second account in an isolated jar.
    const saved = { ...jar };
    for (const k of Object.keys(jar)) delete jar[k];
    await call('POST', '/api/auth/register', {
      email: 'second@test.com', password: 'anotherGoodPass1', displayName: 'Second',
    });
    const clash = await call('PATCH', '/api/player/profile', { displayName: 'Hero' });
    assert.equal(clash.status, 409);
    for (const k of Object.keys(jar)) delete jar[k];
    Object.assign(jar, saved);
  });

  it('returns 404 JSON for unknown API routes', async () => {
    const res = await call('GET', '/api/not-a-real-endpoint');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  it('serves the SPA shell for unknown page routes', async () => {
    const res = await call('GET', '/some/deep/link');
    assert.equal(res.status, 200);
  });

  it('blocks path traversal on static files', async () => {
    const res = await call('GET', '/../../package.json');
    assert.notEqual(res.status, 200);
  });

  it('logs out and clears the session', async () => {
    for (const k of Object.keys(jar)) delete jar[k];
    const reg = await call('POST', '/api/auth/register', {
      email: 'bye@test.com', password: 'goodbyePass1234', displayName: 'Bye',
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.ok(jar.dbh_session, 'session cookie set on register');
    const out = await call('POST', '/api/auth/logout');
    assert.equal(out.status, 200);
    const check = await call('GET', '/api/auth/session');
    assert.equal(check.body.data.authenticated, false);
  });

  it('requires authentication for protected routes', async () => {
    for (const k of Object.keys(jar)) delete jar[k];
    const res = await call('GET', '/api/player');
    assert.equal(res.status, 401);
  });

  // Runs last: this deliberately exhausts the per-IP auth budget, which would
  // otherwise cause every subsequent credential request in the suite to 429.
  it('rate limits credential endpoints', async () => {
    for (const k of Object.keys(jar)) delete jar[k];
    let limited = false;
    for (let i = 0; i < 30; i += 1) {
      const res = await call('POST', '/api/auth/login', {
        email: `rl${i}@test.com`, password: 'wrongPassword123',
      });
      if (res.status === 429) { limited = true; break; }
    }
    assert.ok(limited, 'auth endpoint should rate limit');
  });

  it('shuts down cleanly', async () => {
    await new Promise((resolve) => server.close(resolve));
    await stopApp();
    assert.ok(true);
  });
});

/* ---------------------------------------------------------------- execute */

run().then((code) => {
  fs.rmSync(TEST_DATA, { recursive: true, force: true });
  process.exit(code);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
