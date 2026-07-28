'use strict';
/**
 * ============================================================================
 * ECONOMY — currency, gacha, progression
 * ============================================================================
 *
 * FREE-FOREVER CHARTER
 * --------------------
 * This build has no monetisation of any kind. There is no store, no payment
 * integration, no advertising and no paid currency. Concretely:
 *
 *   - Every new account is granted a FOUNDER'S GRANT of 25,000 Chrono
 *     Crystals. Benchmarked against the commercial genre standard of ~2,000
 *     premium crystals for a ~£40 pack, that grant is the equivalent of a
 *     ~£500 head start: 25 ten-pull multis before you play a single stage.
 *   - The LEGENDS PASS (the genre's paid monthly subscription) is granted
 *     permanently and free to every account, and never expires.
 *   - STAMINA IS UNLIMITED. There is no energy meter, no timer, no session
 *     cap and no "come back in 4 hours" gate. Play as long as you like.
 *   - Daily and career missions pay generously so the crystal supply keeps
 *     flowing without ever needing a wallet.
 *
 * The gacha remains, because the *collection loop* is the fun part of the
 * genre — but with no way to spend money on it, it is a pure reward system.
 */

const { FairRandom, serverSeedHash, shortId } = require('../core/crypto');
const {
  CATALOGUE, RARITIES, STAR_THRESHOLDS, BANNERS, MISSIONS,
} = require('./content');

// -------------------------------------------------------- economy constants --

/**
 * Reference exchange rate used *only* to explain the size of the free grant
 * to players. Nothing here is purchasable.
 */
const REFERENCE_RATE = Object.freeze({
  crystalsPerReferencePack: 2000,
  referencePackPriceGBP: 39.99,
  founderGrantGBPEquivalent: 500,
});

/** The founder's grant: ~£500-equivalent of premium currency, free. */
const FOUNDER_GRANT_CRYSTALS = Math.round(
  (REFERENCE_RATE.founderGrantGBPEquivalent / REFERENCE_RATE.referencePackPriceGBP) *
    REFERENCE_RATE.crystalsPerReferencePack / 1000
) * 1000; // → 25,000

const STARTING_ZENI = 500_000;
const STARTING_SOULS = 5_000;

const SUMMON_COST_SINGLE = 100;
const SUMMON_COST_MULTI = 1000;
const MULTI_SIZE = 10;

/** Guaranteed Sparking-or-better once this many pulls pass without one. */
const PITY_SPARKING = 10;
/** Guaranteed Legends-or-better at this pity depth. */
const PITY_LEGENDS = 80;

// ------------------------------------------------------------ level curve --

/** XP required to advance from `level` to `level + 1`. */
function xpForLevel(level) {
  return Math.round(420 * Math.pow(level, 1.42) + 180 * level);
}

/** Zeni cost to train a fighter from `level` to `level + 1`. */
function trainingCost(level, rarityId) {
  const tier = RARITIES[rarityId].tier;
  return Math.round((320 + level * 145) * (0.85 + tier * 0.18));
}

/** Soul cost for a soul-boost point in a given stat. */
function soulBoostCost(currentPoints, rarityId) {
  const tier = RARITIES[rarityId].tier;
  return Math.round((45 + currentPoints * 22) * (0.9 + tier * 0.12));
}

/** Maximum level available at a given star rating (class-up gating). */
function maxLevelForStars(stars) {
  return [40, 50, 60, 70, 80, 90, 100, 110][Math.min(7, stars)];
}

/** Star rating implied by accumulated Z-Power. */
function starsForZPower(zPower) {
  let stars = 0;
  for (let i = 1; i < STAR_THRESHOLDS.length; i += 1) {
    if (zPower >= STAR_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

/** Z-Power still needed for the next star, or null at max. */
function nextStarProgress(zPower) {
  const stars = starsForZPower(zPower);
  if (stars >= STAR_THRESHOLDS.length - 1) {
    return { stars, next: null, current: zPower, required: null, percent: 100 };
  }
  const floor = STAR_THRESHOLDS[stars];
  const ceiling = STAR_THRESHOLDS[stars + 1];
  return {
    stars,
    next: stars + 1,
    current: zPower - floor,
    required: ceiling - floor,
    percent: Math.round(((zPower - floor) / (ceiling - floor)) * 100),
  };
}

// ------------------------------------------------------------------ gacha --

/** Look up a banner definition. */
function getBanner(bannerId) {
  return BANNERS.find((b) => b.id === bannerId) ?? null;
}

/** Fighters eligible for a rarity on a banner, split featured / general. */
function poolFor(banner, rarityId) {
  const all = CATALOGUE.fighters.filter((f) => f.rarity === rarityId);
  const featured = all.filter((f) => banner.featured.includes(f.id));
  const general = all.filter((f) => !banner.featured.includes(f.id));
  return { featured, general };
}

/**
 * Roll a single summon.
 *
 * @param {FairRandom} rng    Provably-fair stream.
 * @param {object} banner
 * @param {object} pity       `{ sinceSparking, sinceLegends }`
 * @param {boolean} guaranteeSparking Force Sparking+ (multi-pull guarantee).
 * @returns {{fighter: object, rarity: string, featured: boolean, pityApplied: string|null}}
 */
function rollOne(rng, banner, pity, guaranteeSparking = false) {
  const order = ['ULTRA', 'LEGENDS', 'SPARKING', 'EXTREME', 'HERO'];
  let chosenRarity = null;
  let pityApplied = null;

  // Hard pity: Legends-or-better.
  if (pity.sinceLegends >= PITY_LEGENDS) {
    chosenRarity = rng.next() < 0.22 ? 'ULTRA' : 'LEGENDS';
    pityApplied = 'legends';
  } else if (guaranteeSparking || pity.sinceSparking >= PITY_SPARKING) {
    // Soft pity: Sparking-or-better, with the apex rarities still possible.
    const roll = rng.next();
    chosenRarity = roll < 0.04 ? 'ULTRA' : roll < 0.16 ? 'LEGENDS' : 'SPARKING';
    pityApplied = guaranteeSparking ? 'multi_guarantee' : 'sparking';
  } else {
    // Standard weighted roll against the banner's published rates.
    const entries = order
      .filter((r) => banner.rates[r] > 0)
      .map((r) => ({ rarity: r, weight: banner.rates[r] }));
    chosenRarity = rng.weighted(entries).rarity;
  }

  const { featured, general } = poolFor(banner, chosenRarity);
  // Featured fighters take a reserved share of their rarity's probability.
  const useFeatured = featured.length > 0 && rng.next() < banner.featuredShare;
  const pool = useFeatured ? featured : (general.length > 0 ? general : featured);
  const fighter = pool[Math.floor(rng.next() * pool.length)];

  return {
    fighter,
    rarity: chosenRarity,
    featured: banner.featured.includes(fighter.id),
    pityApplied,
  };
}

/**
 * Execute a summon session.
 *
 * @param {object} params
 * @param {object} params.banner
 * @param {number} params.count       1 or 10.
 * @param {object} params.pity        Mutated in place.
 * @param {string} params.serverSeed
 * @param {string} params.clientSeed
 * @param {number} params.nonce
 * @returns {{results: object[], pity: object, verification: object}}
 */
function performSummon({ banner, count, pity, serverSeed, clientSeed, nonce }) {
  const rng = new FairRandom(serverSeed, clientSeed, nonce);
  const results = [];
  const working = { ...pity };

  for (let i = 0; i < count; i += 1) {
    // A multi's final pull guarantees Sparking-or-better if none has dropped.
    const isLastOfMulti = count === MULTI_SIZE && i === MULTI_SIZE - 1;
    const noneYet = !results.some((r) => RARITIES[r.rarity].tier >= 3);
    const guarantee = isLastOfMulti && noneYet;

    const roll = rollOne(rng, banner, working, guarantee);

    // Update pity counters.
    if (RARITIES[roll.rarity].tier >= 3) working.sinceSparking = 0;
    else working.sinceSparking += 1;
    if (RARITIES[roll.rarity].tier >= 4) working.sinceLegends = 0;
    else working.sinceLegends += 1;

    results.push({
      fighterId: roll.fighter.id,
      title: roll.fighter.title,
      rarity: roll.rarity,
      element: roll.fighter.element,
      featured: roll.featured,
      pityApplied: roll.pityApplied,
      zPower: RARITIES[roll.rarity].zPowerPerPull,
      art: roll.fighter.art,
    });
  }

  return {
    results,
    pity: working,
    verification: {
      serverSeedHash: serverSeedHash(serverSeed),
      clientSeed,
      nonce,
      /** Published so a player can verify the roll after seed rotation. */
      algorithm: 'HMAC-SHA512(serverSeed, `${clientSeed}:${nonce}:${cursor}`)',
    },
  };
}

/**
 * Merge summon results into a roster, creating or limit-breaking entries.
 *
 * @param {object[]} results
 * @param {Map<string,object>} rosterByFighter Existing entries.
 * @returns {object[]} Per-result outcome annotations.
 */
function applySummonToRoster(results, rosterByFighter) {
  const outcomes = [];
  for (const result of results) {
    const existing = rosterByFighter.get(result.fighterId);
    if (!existing) {
      const zPower = result.zPower;
      outcomes.push({
        ...result,
        isNew: true,
        zPowerTotal: zPower,
        stars: starsForZPower(zPower),
        starsGained: starsForZPower(zPower),
      });
    } else {
      const before = starsForZPower(existing.zPower);
      const total = existing.zPower + result.zPower;
      const after = starsForZPower(total);
      outcomes.push({
        ...result,
        isNew: false,
        zPowerTotal: total,
        stars: after,
        starsGained: after - before,
      });
    }
  }
  return outcomes;
}

// --------------------------------------------------------------- missions --

/** Evaluate mission completion against a player's counters. */
function evaluateMissions(counters, claimed = {}) {
  return MISSIONS.map((mission) => {
    const progress = Math.min(counters[mission.metric] ?? 0, mission.target);
    const complete = progress >= mission.target;
    return {
      ...mission,
      progress,
      complete,
      claimed: Boolean(claimed[mission.id]),
      claimable: complete && !claimed[mission.id],
    };
  });
}

// ---------------------------------------------------------- player factory --

/**
 * Build the initial player document, including the founder's grant and the
 * permanently-active free Legends Pass.
 */
function createPlayerDocument({ userId, displayName }) {
  const now = new Date().toISOString();
  return {
    id: userId,
    displayName,
    level: 1,
    xp: 0,
    crystals: FOUNDER_GRANT_CRYSTALS,
    zeni: STARTING_ZENI,
    souls: STARTING_SOULS,
    /**
     * The Legends Pass equivalent — granted free, permanently, to everyone.
     * `expiresAt: null` means it never lapses.
     */
    pass: {
      active: true,
      tier: 'LEGENDS_PASS_FREE',
      grantedAt: now,
      expiresAt: null,
      perks: [
        'Unlimited stamina — no energy gates, ever',
        'Double Zeni and Souls from every battle',
        '+2 daily summon tickets',
        'Instant training (no timers)',
        'All story chapters unlocked from day one',
      ],
    },
    /** Stamina is tracked for UI parity but never actually consumed. */
    stamina: { current: 999, max: 999, unlimited: true, lastTickAt: now },
    pity: { sinceSparking: 0, sinceLegends: 0 },
    summonNonce: 0,
    clientSeed: shortId('seed_'),
    counters: {
      logins: 1,
      battlesWon: 0,
      battlesPlayed: 0,
      summons: 0,
      upgrades: 0,
      risingRush: 0,
      rosterSize: 0,
      stagesCleared: 0,
    },
    claimedMissions: {},
    clearedStages: {},
    lastDailyResetAt: now,
    settings: {
      reducedMotion: false,
      screenShake: true,
      damageNumbers: true,
      autoAdvance: false,
      soundEnabled: true,
      untimedMode: false,
      theme: 'nebula',
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** Public snapshot of the economy configuration, for the client. */
function economySummary() {
  return {
    founderGrant: FOUNDER_GRANT_CRYSTALS,
    founderGrantGBPEquivalent: REFERENCE_RATE.founderGrantGBPEquivalent,
    referenceRate: REFERENCE_RATE,
    summonCostSingle: SUMMON_COST_SINGLE,
    summonCostMulti: SUMMON_COST_MULTI,
    multiSize: MULTI_SIZE,
    pitySparking: PITY_SPARKING,
    pityLegends: PITY_LEGENDS,
    freeForever: true,
    monetisation: 'none',
    passIncluded: true,
    staminaUnlimited: true,
  };
}

module.exports = {
  FOUNDER_GRANT_CRYSTALS,
  STARTING_ZENI,
  STARTING_SOULS,
  SUMMON_COST_SINGLE,
  SUMMON_COST_MULTI,
  MULTI_SIZE,
  PITY_SPARKING,
  PITY_LEGENDS,
  REFERENCE_RATE,
  xpForLevel,
  trainingCost,
  soulBoostCost,
  maxLevelForStars,
  starsForZPower,
  nextStarProgress,
  getBanner,
  performSummon,
  applySummonToRoster,
  evaluateMissions,
  createPlayerDocument,
  economySummary,
};
