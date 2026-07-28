'use strict';
/**
 * ============================================================================
 * COMBAT ENGINE — authoritative, deterministic, server-side
 * ============================================================================
 *
 * Design principles
 * -----------------
 * 1. AUTHORITATIVE. The client never computes damage. It sends intents
 *    ("play card 2", "vanish", "switch to slot 1") and renders the state the
 *    server returns. This makes the game cheat-resistant by construction.
 *
 * 2. DETERMINISTIC. Every random decision draws from a seeded `FairRandom`
 *    stream stored on the battle. Replaying the same battle seed with the same
 *    action sequence reproduces the exact same result — essential for replays,
 *    debugging and dispute resolution.
 *
 * 3. EVENT-SOURCED PRESENTATION. Each action returns a list of timeline
 *    `events` describing what happened in order (`damage`, `vanish`,
 *    `rising_rush`, `ko`, ...). The client plays these back as animation. The
 *    engine therefore drives the visuals without knowing anything about the
 *    renderer.
 *
 * Battle model
 * ------------
 * Two teams of three. One active fighter per side. A shared "timer count"
 * advances as actions are taken and drives regeneration, buff expiry and
 * ability triggers. Arts cards are drawn into a 4-card hand; playing them
 * costs Ki. Filling all seven Dragon Ball slots unlocks the Rising Rush.
 */

const { FairRandom } = require('../core/crypto');
const { CATALOGUE, RARITIES, ARTS, elementMultiplier, STAR_STAT_BONUS } = require('./content');

// ------------------------------------------------------------- constants --

const HAND_SIZE = 4;
const MAX_KI = 100;
const START_KI = 50;
const KI_PER_COUNT = 8;
const VANISH_COST = 50;          // vanishing gauge units
const VANISH_MAX = 100;
const VANISH_REGEN = 12;         // per timer count
const DRAGON_BALLS_TO_RUSH = 7;
const SUBSTITUTION_START = 4;    // counts before a cover-change is available
const COMBO_WINDOW = 3;          // cards chainable in one combo string
const CRIT_MULTIPLIER = 1.65;
const RISING_RUSH_POWER = 6.2;

/** Cards that may be chained into a combo string. */
const COMBOABLE = new Set(['STRIKE', 'BLAST', 'SPECIAL']);

// ------------------------------------------------------- stat computation --

/**
 * Resolve a roster entry (level, stars, soul boosts) into battle stats.
 * @param {object} fighter Catalogue definition.
 * @param {object} entry   Player's roster entry, or null for a raw NPC.
 */
function computeStats(fighter, entry = null) {
  const level = entry?.level ?? 1;
  const stars = entry?.stars ?? 0;
  const boosts = entry?.soulBoosts ?? {};

  // Level curve: +6.2% of base per level, compounding mildly.
  const levelScale = 1 + (level - 1) * 0.062;
  // Stars: flat 5% of base each.
  const starScale = 1 + stars * STAR_STAT_BONUS;

  const scale = levelScale * starScale;
  return {
    hp:     Math.round(fighter.stats.hp     * scale + (boosts.hp     ?? 0) * 260),
    strike: Math.round(fighter.stats.strike * scale + (boosts.strike ?? 0) * 42),
    blast:  Math.round(fighter.stats.blast  * scale + (boosts.blast  ?? 0) * 42),
    strDef: Math.round(fighter.stats.strDef * scale + (boosts.strDef ?? 0) * 34),
    blsDef: Math.round(fighter.stats.blsDef * scale + (boosts.blsDef ?? 0) * 34),
    crit:   Math.min(60, fighter.stats.crit + stars * 0.7 + (boosts.crit ?? 0) * 0.5),
    kiRegen: fighter.stats.kiRegen,
  };
}

/**
 * Z-Ability team buffs: each fighter buffs teammates sharing its tag.
 * Applied once at battle start to the whole team.
 */
function applyZAbilities(combatants, roster) {
  const buffs = [];
  for (const source of combatants) {
    const entry = roster?.get(source.fighterId);
    const stars = entry?.stars ?? 0;
    const za = source.def.zAbility;
    const percent = za.tiers[Math.min(za.tiers.length - 1, stars)];
    buffs.push({ tag: za.tag, stat: za.stat, percent });
  }
  for (const target of combatants) {
    let multiplier = 1;
    for (const buff of buffs) {
      if (target.def.tags.includes(buff.tag)) multiplier += buff.percent / 100;
    }
    // Cap the stacking so a mono-tag team cannot run away with the game.
    multiplier = Math.min(multiplier, 2.2);
    for (const buff of buffs) {
      if (!target.def.tags.includes(buff.tag)) continue;
      const stat = buff.stat;
      if (stat === 'hp') {
        target.maxHp = Math.round(target.maxHp * (1 + buff.percent / 200));
        target.hp = target.maxHp;
      } else if (target.stats[stat] !== undefined) {
        target.stats[stat] = Math.round(target.stats[stat] * (1 + buff.percent / 200));
      }
    }
    target.zMultiplier = Math.round(multiplier * 100) / 100;
  }
}

// ------------------------------------------------------------- combatants --

/**
 * Build a combatant from a fighter id.
 * @param {string} fighterId
 * @param {object|null} entry Roster entry for player-owned fighters.
 * @param {number} forcedLevel Override level for NPC scaling.
 */
function makeCombatant(fighterId, entry, forcedLevel = null) {
  const def = CATALOGUE.byId.get(fighterId);
  if (!def) throw new Error(`Unknown fighter: ${fighterId}`);

  const effectiveEntry = forcedLevel !== null
    ? { level: forcedLevel, stars: Math.min(7, Math.floor(forcedLevel / 18)), soulBoosts: {} }
    : entry;

  const stats = computeStats(def, effectiveEntry);
  return {
    fighterId,
    def,
    name: def.title,
    element: def.element,
    rarity: def.rarity,
    level: effectiveEntry?.level ?? 1,
    stars: effectiveEntry?.stars ?? 0,
    stats,
    maxHp: stats.hp,
    hp: stats.hp,
    ki: START_KI,
    vanish: VANISH_MAX,
    /** Counts remaining before this fighter can cover-change. */
    substitution: SUBSTITUTION_START,
    /** Unique Gauge 0-100. */
    gauge: 0,
    gaugeFullTriggered: false,
    /** Active timed modifiers. */
    buffs: [],
    /** One-shot ability activations already consumed. */
    consumed: {},
    alive: true,
    zMultiplier: 1,
    mainAbilityUsed: false,
  };
}

// ------------------------------------------------------------------ buffs --

/** Sum the value of every active buff of a given key. */
function buffValue(combatant, key) {
  let total = 0;
  for (const buff of combatant.buffs) {
    if (buff.key === key) total += buff.value;
  }
  return total;
}

/** Add a timed modifier. `duration` of 0 means permanent for the battle. */
function addBuff(combatant, key, value, duration = 10, source = 'ability') {
  combatant.buffs.push({ key, value, remaining: duration, permanent: duration === 0, source });
}

/** Decrement buff timers and drop the expired ones. */
function tickBuffs(combatant, counts = 1) {
  combatant.buffs = combatant.buffs.filter((buff) => {
    if (buff.permanent) return true;
    buff.remaining -= counts;
    return buff.remaining > 0;
  });
}

/**
 * Evaluate a fighter's data-driven abilities for a given trigger and apply
 * the effects. This is what turns the 464 generated kits into live behaviour.
 */
function fireAbilities(state, side, trigger, events) {
  const combatant = activeOf(state, side);
  if (!combatant?.alive) return;

  for (let i = 0; i < combatant.def.abilities.length; i += 1) {
    const ability = combatant.def.abilities[i];
    if (ability.trigger !== trigger) continue;

    // One-shot triggers fire once per battlefield entry.
    const key = `ab:${i}:${trigger}`;
    if (trigger === 'onEntry' || trigger === 'battleStart') {
      if (combatant.consumed[key]) continue;
      combatant.consumed[key] = true;
    }

    const applied = [];
    for (const effect of ability.effects) {
      applied.push(applyEffect(state, side, combatant, effect, ability.duration));
    }
    events.push({
      type: 'ability',
      side,
      fighterId: combatant.fighterId,
      trigger,
      triggerText: ability.triggerText,
      effects: applied,
    });
  }
}

/** Apply a single ability effect. @returns {object} description for the timeline. */
function applyEffect(state, side, combatant, effect, duration) {
  const opponent = activeOf(state, side === 'player' ? 'enemy' : 'player');
  const { key, value } = effect;
  switch (key) {
    case 'dmgUp': case 'strikeUp': case 'blastUp': case 'ultimateUp':
    case 'dmgCut': case 'critRate': case 'kiRegen': case 'artsCostDown':
    case 'drawSpeed':
      addBuff(combatant, key, value, duration);
      break;
    case 'healOnEntry': {
      const healed = Math.round(combatant.maxHp * (value / 100));
      combatant.hp = Math.min(combatant.maxHp, combatant.hp + healed);
      break;
    }
    case 'enemyKiDrain':
      if (opponent?.alive) opponent.ki = Math.max(0, opponent.ki - value);
      break;
    case 'vanishRegen':
      combatant.vanish = Math.min(VANISH_MAX, combatant.vanish + value);
      break;
    case 'subCountDown':
      combatant.substitution = Math.max(0, combatant.substitution - value);
      break;
    case 'endurance':
      addBuff(combatant, 'endurance', value, 0);
      break;
    case 'cardDestroy': {
      const hand = side === 'player' ? state.enemy.hand : state.player.hand;
      for (let n = 0; n < value && hand.length > 0; n += 1) {
        hand.splice(state.rng.int(0, hand.length - 1), 1);
      }
      break;
    }
    case 'sealArts':
      if (opponent?.alive) addBuff(opponent, 'sealed', value, value);
      break;
    default:
      addBuff(combatant, key, value, duration);
  }
  return { key, value, text: effect.text };
}

// ------------------------------------------------------------------- deck --

/**
 * Draw an Arts card. Weighting favours Strike/Blast so combos flow, with
 * Special/Ultimate appearing often enough to feel explosive.
 */
function drawCard(state, side) {
  const combatant = activeOf(state, side);
  const weights = [
    { arts: 'STRIKE',   weight: 34 },
    { arts: 'BLAST',    weight: 34 },
    { arts: 'SPECIAL',  weight: 20 },
    { arts: 'ULTIMATE', weight: 9 },
    { arts: 'AWAKEN',   weight: 3 },
  ];
  // Draw-speed buffs bias towards the powerful end of the deck.
  const speed = combatant ? buffValue(combatant, 'drawSpeed') : 0;
  if (speed > 0) {
    weights[2].weight += speed * 6;
    weights[3].weight += speed * 4;
  }
  const chosen = state.rng.weighted(weights);
  const base = ARTS[chosen.arts];
  const costReduction = combatant ? buffValue(combatant, 'artsCostDown') : 0;
  return {
    uid: `c${state.cardSeq++}`,
    arts: chosen.arts,
    label: base.label,
    cost: Math.max(0, base.cost - costReduction),
    colour: base.colour,
    icon: base.icon,
    /** Special/Ultimate cards carry the fighter's signature move name. */
    moveName:
      chosen.arts === 'SPECIAL' ? combatant?.def.moves.special.name
      : chosen.arts === 'ULTIMATE' ? combatant?.def.moves.ultimate.name
      : chosen.arts === 'AWAKEN' ? combatant?.def.mainAbility.name
      : null,
    vfx:
      chosen.arts === 'SPECIAL' ? combatant?.def.moves.special.vfx
      : chosen.arts === 'ULTIMATE' ? combatant?.def.moves.ultimate.vfx
      : null,
  };
}

/** Top a hand up to HAND_SIZE. */
function refillHand(state, side) {
  const hand = state[side].hand;
  while (hand.length < HAND_SIZE) hand.push(drawCard(state, side));
}

// ---------------------------------------------------------------- helpers --

/** The currently active combatant for a side. */
function activeOf(state, side) {
  const team = state[side];
  return team.members[team.active] ?? null;
}

/** Is every member of a side knocked out? */
function teamDefeated(state, side) {
  return state[side].members.every((m) => !m.alive);
}

// --------------------------------------------------------------- damage ---

/**
 * Core damage formula.
 *
 * Attack and defence are opposed on a soft curve so that stat gaps matter
 * without becoming binary. Element advantage, criticals, buffs, combo scaling
 * and Arts power all fold in multiplicatively.
 */
function computeDamage(state, attacker, defender, card, options = {}) {
  const isBlastType = card.arts === 'BLAST' || card.arts === 'SPECIAL' || card.arts === 'ULTIMATE';
  const rawAttack = isBlastType ? attacker.stats.blast : attacker.stats.strike;
  const rawDefence = isBlastType ? defender.stats.blsDef : defender.stats.strDef;

  // Arts base power.
  const artsPower = {
    STRIKE: 1.0,
    BLAST: 1.05,
    SPECIAL: attacker.def.moves.special.power,
    ULTIMATE: attacker.def.moves.ultimate.power,
    AWAKEN: 1.2,
  }[card.arts] ?? 1;

  // Soft-opposed core: attack scaled by a defence ratio that never fully nulls.
  const ratio = rawAttack / (rawAttack + rawDefence * 0.86);
  let damage = rawAttack * ratio * artsPower * 0.92;

  // Element wheel.
  const element = elementMultiplier(attacker.element, defender.element);
  damage *= element;

  // Offensive buffs.
  let offense = 1 + buffValue(attacker, 'dmgUp') / 100;
  if (card.arts === 'STRIKE') offense += buffValue(attacker, 'strikeUp') / 100;
  if (card.arts === 'BLAST') offense += buffValue(attacker, 'blastUp') / 100;
  if (card.arts === 'ULTIMATE') offense += buffValue(attacker, 'ultimateUp') / 100;
  damage *= offense;

  // Defensive buffs.
  damage *= Math.max(0.15, 1 - buffValue(defender, 'dmgCut') / 100);

  // Combo scaling: each chained card in a string adds damage.
  const comboBonus = 1 + (options.comboIndex ?? 0) * 0.16;
  damage *= comboBonus;

  // Critical hit.
  const critChance = attacker.stats.crit + buffValue(attacker, 'critRate');
  const isCritical = state.rng.next() * 100 < critChance;
  if (isCritical) damage *= CRIT_MULTIPLIER;

  // Rising Rush override.
  if (options.risingRush) damage *= RISING_RUSH_POWER;

  // ±4% spread so identical exchanges are not visually identical.
  damage *= 0.96 + state.rng.next() * 0.08;

  return {
    amount: Math.max(1, Math.round(damage)),
    isCritical,
    element,
    elementLabel: element > 1 ? 'advantage' : element < 1 ? 'resisted' : 'neutral',
  };
}

/**
 * Apply damage, handling Endurance ("survive with X% once") and KO.
 */
function dealDamage(state, side, attacker, defender, result, events, meta = {}) {
  const before = defender.hp;
  defender.hp = Math.max(0, defender.hp - result.amount);

  events.push({
    type: 'damage',
    side,
    attackerId: attacker.fighterId,
    defenderId: defender.fighterId,
    amount: result.amount,
    critical: result.isCritical,
    element: result.elementLabel,
    hpBefore: before,
    hpAfter: defender.hp,
    maxHp: defender.maxHp,
    ...meta,
  });

  // Endurance: cheat death once.
  if (defender.hp === 0) {
    const endurance = buffValue(defender, 'endurance');
    if (endurance > 0 && !defender.consumed.endurance) {
      defender.consumed.endurance = true;
      defender.hp = Math.round(defender.maxHp * (endurance / 100));
      defender.buffs = defender.buffs.filter((b) => b.key !== 'endurance');
      events.push({
        type: 'endurance',
        side: side === 'player' ? 'enemy' : 'player',
        fighterId: defender.fighterId,
        hp: defender.hp,
        maxHp: defender.maxHp,
      });
    }
  }

  if (defender.hp === 0 && defender.alive) {
    defender.alive = false;
    events.push({
      type: 'ko',
      side: side === 'player' ? 'enemy' : 'player',
      fighterId: defender.fighterId,
    });
    // Auto-advance to the next living member.
    const defSide = side === 'player' ? 'enemy' : 'player';
    const next = state[defSide].members.findIndex((m) => m.alive);
    if (next !== -1) {
      state[defSide].active = next;
      const incoming = state[defSide].members[next];
      incoming.substitution = SUBSTITUTION_START;
      events.push({ type: 'switch', side: defSide, fighterId: incoming.fighterId, forced: true });
      fireAbilities(state, defSide, 'onEntry', events);
      state[defSide].hand = [];
      refillHand(state, defSide);
      fireAbilities(state, side, 'onAllyDown', events);
    }
  }
}

// ------------------------------------------------------------ timer ticks --

/** Advance the shared timer, regenerating resources and expiring buffs. */
function advanceCounts(state, counts, events) {
  state.count += counts;
  for (const side of ['player', 'enemy']) {
    for (const member of state[side].members) {
      if (!member.alive) continue;
      const kiBonus = 1 + buffValue(member, 'kiRegen') / 100;
      member.ki = Math.min(MAX_KI, member.ki + KI_PER_COUNT * counts * member.stats.kiRegen * kiBonus);
      member.ki = Math.round(member.ki);
      member.vanish = Math.min(VANISH_MAX, member.vanish + VANISH_REGEN * counts);
      member.substitution = Math.max(0, member.substitution - counts);
      tickBuffs(member, counts);
    }
  }
  events.push({ type: 'tick', count: state.count });
}

/** Award a Dragon Ball, unlocking Rising Rush at seven. */
function grantDragonBall(state, side, events) {
  const team = state[side];
  if (team.dragonBalls >= DRAGON_BALLS_TO_RUSH) return;
  team.dragonBalls += 1;
  events.push({ type: 'dragon_ball', side, total: team.dragonBalls });
  if (team.dragonBalls === DRAGON_BALLS_TO_RUSH) {
    events.push({ type: 'rising_rush_ready', side });
  }
}

// ---------------------------------------------------------------- battle ---

/**
 * Create a new battle.
 *
 * @param {object} params
 * @param {string[]} params.playerTeam Fighter ids (max 3).
 * @param {Map<string,object>} params.roster Roster entries by fighter id.
 * @param {string[]} params.enemyTeam Fighter ids.
 * @param {number} params.enemyLevel Level to scale NPCs to.
 * @param {string} params.seed Server seed for the fair RNG.
 * @param {string} params.mode 'story' | 'pvp' | 'training'
 */
function createBattle({ playerTeam, roster, enemyTeam, enemyLevel, seed, mode = 'story', stageId = null }) {
  const rng = new FairRandom(seed, 'battle', 0);

  const state = {
    mode,
    stageId,
    seed,
    rng,
    count: 0,
    cardSeq: 1,
    turn: 'player',
    status: 'active',
    winner: null,
    comboIndex: 0,
    player: {
      members: playerTeam.map((id) => makeCombatant(id, roster?.get(id) ?? null)),
      active: 0,
      hand: [],
      dragonBalls: 0,
    },
    enemy: {
      members: enemyTeam.map((id) => makeCombatant(id, null, enemyLevel)),
      active: 0,
      hand: [],
      dragonBalls: 0,
    },
    events: [],
  };

  applyZAbilities(state.player.members, roster);
  applyZAbilities(state.enemy.members, null);

  const events = [];
  events.push({ type: 'battle_start', mode, stageId });
  fireAbilities(state, 'player', 'battleStart', events);
  fireAbilities(state, 'enemy', 'battleStart', events);
  fireAbilities(state, 'player', 'onEntry', events);
  fireAbilities(state, 'enemy', 'onEntry', events);
  refillHand(state, 'player');
  refillHand(state, 'enemy');
  state.events = events;
  return state;
}

/**
 * Play a card from the active hand.
 * @returns {object[]} timeline events
 */
function playCard(state, side, cardUid) {
  const events = [];
  const team = state[side];
  const attacker = activeOf(state, side);
  const foeSide = side === 'player' ? 'enemy' : 'player';
  const defender = activeOf(state, foeSide);

  const index = team.hand.findIndex((c) => c.uid === cardUid);
  if (index === -1) throw new Error('CARD_NOT_IN_HAND');
  const card = team.hand[index];

  if (buffValue(attacker, 'sealed') > 0 && card.arts !== 'STRIKE') {
    throw new Error('ARTS_SEALED');
  }
  if (attacker.ki < card.cost) throw new Error('INSUFFICIENT_KI');

  // Spend resources.
  attacker.ki -= card.cost;
  team.hand.splice(index, 1);

  // Unique Gauge charges on every Arts use.
  attacker.gauge = Math.min(100, attacker.gauge + attacker.def.uniqueGauge.chargePerArts);
  if (attacker.gauge >= 100 && !attacker.gaugeFullTriggered) {
    attacker.gaugeFullTriggered = true;
    const applied = attacker.def.uniqueGauge.fullEffects.map((e) =>
      applyEffect(state, side, attacker, e, 15)
    );
    events.push({
      type: 'gauge_full',
      side,
      fighterId: attacker.fighterId,
      gaugeName: attacker.def.uniqueGauge.name,
      effects: applied,
    });
  }

  events.push({
    type: 'card_play',
    side,
    fighterId: attacker.fighterId,
    arts: card.arts,
    moveName: card.moveName,
    vfx: card.vfx,
    comboIndex: state.comboIndex,
  });

  fireAbilities(state, side, 'onArtsUse', events);

  // Resolve the attack.
  if (defender?.alive) {
    const result = computeDamage(state, attacker, defender, card, { comboIndex: state.comboIndex });
    dealDamage(state, side, attacker, defender, result, events, {
      arts: card.arts,
      moveName: card.moveName,
      vfx: card.vfx,
    });
    if (result.isCritical) fireAbilities(state, side, 'onCritical', events);
    // The struck side reacts.
    if (defender.alive) fireAbilities(state, foeSide, 'onHit', events);
  }

  // Dragon Ball economy: Special and Ultimate cards fill slots faster.
  const balls = card.arts === 'ULTIMATE' ? 2 : card.arts === 'SPECIAL' ? 1 : state.rng.next() > 0.45 ? 1 : 0;
  for (let i = 0; i < balls; i += 1) grantDragonBall(state, side, events);

  // Combo chaining.
  if (COMBOABLE.has(card.arts) && state.comboIndex < COMBO_WINDOW - 1) {
    state.comboIndex += 1;
  } else {
    state.comboIndex = 0;
    advanceCounts(state, 1, events);
  }

  refillHand(state, side);
  checkVictory(state, events);
  return events;
}

/**
 * Vanishing Step — spend the gauge to evade and reset the opponent's combo.
 */
function vanish(state, side) {
  const events = [];
  const combatant = activeOf(state, side);
  if (combatant.vanish < VANISH_COST) throw new Error('VANISH_NOT_READY');

  combatant.vanish -= VANISH_COST;
  state.comboIndex = 0;
  events.push({ type: 'vanish', side, fighterId: combatant.fighterId });
  fireAbilities(state, side, 'onVanish', events);
  advanceCounts(state, 1, events);
  checkVictory(state, events);
  return events;
}

/**
 * Switch the active fighter (cover change). Requires the substitution
 * counter to have expired.
 */
function switchFighter(state, side, slot) {
  const events = [];
  const team = state[side];
  const target = team.members[slot];
  if (!target) throw new Error('INVALID_SLOT');
  if (!target.alive) throw new Error('FIGHTER_DEFEATED');
  if (slot === team.active) throw new Error('ALREADY_ACTIVE');

  const outgoing = activeOf(state, side);
  if (outgoing.substitution > 0) throw new Error('SUBSTITUTION_ON_COOLDOWN');

  team.active = slot;
  outgoing.substitution = SUBSTITUTION_START;
  target.substitution = Math.max(target.substitution, 2);
  state.comboIndex = 0;

  events.push({
    type: 'switch',
    side,
    fighterId: target.fighterId,
    fromId: outgoing.fighterId,
    forced: false,
  });
  fireAbilities(state, side, 'onCoverChange', events);
  fireAbilities(state, side, 'onEntry', events);

  team.hand = [];
  refillHand(state, side);
  advanceCounts(state, 1, events);
  checkVictory(state, events);
  return events;
}

/**
 * Rising Rush — the signature team attack. Consumes all seven Dragon Balls
 * and strikes with the whole team.
 */
function risingRush(state, side) {
  const events = [];
  const team = state[side];
  if (team.dragonBalls < DRAGON_BALLS_TO_RUSH) throw new Error('RISING_RUSH_NOT_READY');

  const foeSide = side === 'player' ? 'enemy' : 'player';
  const attacker = activeOf(state, side);
  const defender = activeOf(state, foeSide);
  team.dragonBalls = 0;

  events.push({
    type: 'rising_rush',
    side,
    fighterId: attacker.fighterId,
    team: team.members.filter((m) => m.alive).map((m) => ({
      fighterId: m.fighterId,
      name: m.name,
      element: m.element,
      art: m.def.art,
    })),
  });

  if (defender?.alive) {
    const card = { arts: 'ULTIMATE', cost: 0 };
    const result = computeDamage(state, attacker, defender, card, { risingRush: true });
    dealDamage(state, side, attacker, defender, result, events, {
      arts: 'RISING_RUSH',
      moveName: 'RISING RUSH',
      vfx: 'NOVA',
    });
  }

  state.comboIndex = 0;
  advanceCounts(state, 2, events);
  checkVictory(state, events);
  return events;
}

/**
 * Charge — hold position to regenerate Ki and the Vanishing Gauge.
 *
 * This is the engine's guaranteed-legal action. In a real-time fighter the
 * clock always advances, so a player is never without options; in this
 * turn-based translation `charge` fills that role and makes deadlock
 * impossible (no Ki, empty vanish gauge and a spent Main Ability would
 * otherwise leave no legal move).
 */
function charge(state, side) {
  const events = [];
  const combatant = activeOf(state, side);
  if (!combatant?.alive) throw new Error('NO_ACTIVE_FIGHTER');

  // Charging is deliberately generous but costs tempo: the opponent also
  // gains counts, and a charging fighter builds no Dragon Balls.
  const before = combatant.ki;
  combatant.ki = Math.min(MAX_KI, combatant.ki + 25);
  combatant.vanish = Math.min(VANISH_MAX, combatant.vanish + 25);
  state.comboIndex = 0;

  events.push({
    type: 'charge',
    side,
    fighterId: combatant.fighterId,
    kiBefore: before,
    kiAfter: combatant.ki,
  });
  advanceCounts(state, 2, events);
  checkVictory(state, events);
  return events;
}

/** Use the fighter's Main Ability once the required counts have elapsed. */
function mainAbility(state, side) {
  const events = [];
  const combatant = activeOf(state, side);
  if (combatant.mainAbilityUsed) throw new Error('MAIN_ABILITY_USED');
  if (state.count < combatant.def.mainAbility.requires) throw new Error('MAIN_ABILITY_NOT_READY');

  combatant.mainAbilityUsed = true;
  const applied = combatant.def.mainAbility.effects.map((e) =>
    applyEffect(state, side, combatant, e, 20)
  );
  events.push({
    type: 'main_ability',
    side,
    fighterId: combatant.fighterId,
    name: combatant.def.mainAbility.name,
    effects: applied,
  });
  advanceCounts(state, 1, events);
  checkVictory(state, events);
  return events;
}

/** Determine whether the battle has ended. */
function checkVictory(state, events) {
  if (state.status !== 'active') return;
  const playerDown = teamDefeated(state, 'player');
  const enemyDown = teamDefeated(state, 'enemy');
  if (playerDown || enemyDown) {
    state.status = 'complete';
    state.winner = enemyDown && !playerDown ? 'player' : 'enemy';
    events.push({ type: 'battle_end', winner: state.winner, counts: state.count });
  }
}

// ------------------------------------------------------------------- AI ----

/**
 * Enemy AI.
 *
 * Difficulty scales the quality of decisions rather than the enemy's stats,
 * which keeps fights feeling fair. The AI evaluates: finish a kill, exploit
 * element advantage, defend when low, or build Ki.
 */
function enemyTurn(state) {
  const events = [];
  if (state.status !== 'active') return events;

  const ai = activeOf(state, 'enemy');
  const foe = activeOf(state, 'player');
  if (!ai?.alive || !foe?.alive) return events;

  const skill = Math.min(0.95, 0.42 + (ai.level / 100) * 0.5);
  const smart = state.rng.next() < skill;

  // 1. Rising Rush when available and it would be decisive.
  if (state.enemy.dragonBalls >= DRAGON_BALLS_TO_RUSH && smart) {
    try { return risingRush(state, 'enemy'); } catch { /* fall through */ }
  }

  // 2. Retreat when critically hurt and a healthier ally is ready.
  if (smart && ai.hp / ai.maxHp < 0.24 && ai.substitution === 0) {
    const better = state.enemy.members.findIndex(
      (m, i) => m.alive && i !== state.enemy.active && m.hp / m.maxHp > 0.55
    );
    if (better !== -1) {
      try { return switchFighter(state, 'enemy', better); } catch { /* fall through */ }
    }
  }

  // 3. Main ability when it is up.
  if (smart && !ai.mainAbilityUsed && state.count >= ai.def.mainAbility.requires) {
    try { return mainAbility(state, 'enemy'); } catch { /* fall through */ }
  }

  // 4. Play the strongest affordable card (weakest when playing badly).
  const affordable = state.enemy.hand.filter((c) => ai.ki >= c.cost);
  if (affordable.length > 0) {
    const ranked = affordable.sort((a, b) => {
      const rank = { STRIKE: 1, BLAST: 2, AWAKEN: 3, SPECIAL: 4, ULTIMATE: 5 };
      return (rank[b.arts] ?? 0) - (rank[a.arts] ?? 0);
    });
    const card = smart ? ranked[0] : ranked[ranked.length - 1];
    try { return playCard(state, 'enemy', card.uid); } catch { /* fall through */ }
  }

  // 5. Nothing affordable — charge Ki.
  return charge(state, 'enemy');
}

// --------------------------------------------------- serialisation for UI --

/** Strip engine internals, exposing only what the client must render. */
function serialiseCombatant(c) {
  return {
    fighterId: c.fighterId,
    name: c.name,
    element: c.element,
    rarity: c.rarity,
    level: c.level,
    stars: c.stars,
    hp: c.hp,
    maxHp: c.maxHp,
    ki: c.ki,
    maxKi: MAX_KI,
    vanish: c.vanish,
    maxVanish: VANISH_MAX,
    substitution: c.substitution,
    gauge: c.gauge,
    gaugeName: c.def.uniqueGauge.name,
    alive: c.alive,
    art: c.def.art,
    buffs: c.buffs.map((b) => ({ key: b.key, value: b.value, remaining: b.remaining, permanent: b.permanent })),
    mainAbility: {
      name: c.def.mainAbility.name,
      requires: c.def.mainAbility.requires,
      used: c.mainAbilityUsed,
    },
  };
}

/** Full client-facing battle view. */
function serialiseBattle(state) {
  return {
    status: state.status,
    winner: state.winner,
    count: state.count,
    mode: state.mode,
    stageId: state.stageId,
    comboIndex: state.comboIndex,
    player: {
      members: state.player.members.map(serialiseCombatant),
      active: state.player.active,
      hand: state.player.hand,
      dragonBalls: state.player.dragonBalls,
      risingRushReady: state.player.dragonBalls >= DRAGON_BALLS_TO_RUSH,
    },
    enemy: {
      members: state.enemy.members.map(serialiseCombatant),
      active: state.enemy.active,
      handCount: state.enemy.hand.length,
      dragonBalls: state.enemy.dragonBalls,
      risingRushReady: state.enemy.dragonBalls >= DRAGON_BALLS_TO_RUSH,
    },
  };
}

/**
 * Persist a battle to a plain JSON document (the RNG is rebuilt from seed +
 * nonce on load, preserving determinism across process restarts).
 */
function snapshotBattle(state) {
  const strip = (c) => ({
    fighterId: c.fighterId, level: c.level, stars: c.stars, stats: c.stats,
    maxHp: c.maxHp, hp: c.hp, ki: c.ki, vanish: c.vanish, substitution: c.substitution,
    gauge: c.gauge, gaugeFullTriggered: c.gaugeFullTriggered, buffs: c.buffs,
    consumed: c.consumed, alive: c.alive, zMultiplier: c.zMultiplier,
    mainAbilityUsed: c.mainAbilityUsed,
  });
  return {
    mode: state.mode,
    stageId: state.stageId,
    seed: state.seed,
    rngCursor: state.rng.cursor,
    count: state.count,
    cardSeq: state.cardSeq,
    status: state.status,
    winner: state.winner,
    comboIndex: state.comboIndex,
    player: {
      members: state.player.members.map(strip),
      active: state.player.active,
      hand: state.player.hand,
      dragonBalls: state.player.dragonBalls,
    },
    enemy: {
      members: state.enemy.members.map(strip),
      active: state.enemy.active,
      hand: state.enemy.hand,
      dragonBalls: state.enemy.dragonBalls,
    },
  };
}

/** Rehydrate a snapshot into a live battle state. */
function restoreBattle(snapshot) {
  const rng = new FairRandom(snapshot.seed, 'battle', 0);
  // Fast-forward the stream so continued play stays on the same sequence.
  rng.cursor = snapshot.rngCursor ?? 0;

  const hydrate = (raw) => {
    const def = CATALOGUE.byId.get(raw.fighterId);
    if (!def) throw new Error(`Unknown fighter in snapshot: ${raw.fighterId}`);
    return {
      fighterId: raw.fighterId,
      def,
      name: def.title,
      element: def.element,
      rarity: def.rarity,
      level: raw.level,
      stars: raw.stars,
      stats: raw.stats,
      maxHp: raw.maxHp,
      hp: raw.hp,
      ki: raw.ki,
      vanish: raw.vanish,
      substitution: raw.substitution,
      gauge: raw.gauge,
      gaugeFullTriggered: raw.gaugeFullTriggered,
      buffs: raw.buffs ?? [],
      consumed: raw.consumed ?? {},
      alive: raw.alive,
      zMultiplier: raw.zMultiplier ?? 1,
      mainAbilityUsed: raw.mainAbilityUsed ?? false,
    };
  };

  return {
    mode: snapshot.mode,
    stageId: snapshot.stageId,
    seed: snapshot.seed,
    rng,
    count: snapshot.count,
    cardSeq: snapshot.cardSeq,
    turn: 'player',
    status: snapshot.status,
    winner: snapshot.winner,
    comboIndex: snapshot.comboIndex ?? 0,
    player: {
      members: snapshot.player.members.map(hydrate),
      active: snapshot.player.active,
      hand: snapshot.player.hand,
      dragonBalls: snapshot.player.dragonBalls,
    },
    enemy: {
      members: snapshot.enemy.members.map(hydrate),
      active: snapshot.enemy.active,
      hand: snapshot.enemy.hand,
      dragonBalls: snapshot.enemy.dragonBalls,
    },
    events: [],
  };
}

module.exports = {
  createBattle,
  playCard,
  vanish,
  switchFighter,
  risingRush,
  mainAbility,
  charge,
  enemyTurn,
  serialiseBattle,
  serialiseCombatant,
  snapshotBattle,
  restoreBattle,
  computeStats,
  computeDamage,
  activeOf,
  teamDefeated,
  constants: {
    HAND_SIZE, MAX_KI, VANISH_COST, VANISH_MAX, DRAGON_BALLS_TO_RUSH,
    SUBSTITUTION_START, COMBO_WINDOW, CRIT_MULTIPLIER, RISING_RUSH_POWER,
  },
};
