'use strict';
/**
 * Game service: the transactional core of the product.
 *
 * Owns summoning, roster progression, team management, battle lifecycle and
 * mission rewards. Every currency mutation is wrapped in a store transaction
 * and mirrored into the audit ledger, so the economy can always be
 * reconstructed and no exploit can silently mint currency.
 */

const config = require('../config');
const logger = require('../core/logger');
const { validate, rules } = require('../core/validate');
const { notFound, unprocessable, conflict, badRequest } = require('../core/errors');
const { shortId, serverSeedHash } = require('../core/crypto');
const {
  CATALOGUE, RARITIES, BANNERS, STAGES, MISSIONS, ELEMENTS, ARTS, VFX_STYLES,
} = require('../domain/content');
const economy = require('../domain/economy');
const combat = require('../domain/combat');

class GameService {
  /** @param {import('../data/repositories').Repositories} repos */
  constructor(repos) {
    this.repos = repos;
  }

  // ------------------------------------------------------------ catalogue --

  /** Static reference data the client caches on boot. */
  getCatalogue() {
    return {
      fighters: CATALOGUE.fighters.map((f) => ({
        id: f.id,
        title: f.title,
        name: f.name,
        form: f.form,
        rarity: f.rarity,
        element: f.element,
        tags: f.tags,
        archetype: f.archetype,
        stats: f.stats,
        moves: f.moves,
        abilities: f.abilities,
        mainAbility: f.mainAbility,
        uniqueGauge: f.uniqueGauge,
        zAbility: f.zAbility,
        art: f.art,
        lore: f.lore,
      })),
      elements: ELEMENTS,
      rarities: RARITIES,
      arts: ARTS,
      vfx: VFX_STYLES,
      banners: BANNERS.map((b) => ({
        id: b.id, name: b.name, subtitle: b.subtitle, description: b.description,
        featured: b.featured, rates: b.rates, accent: b.accent, art: b.art,
      })),
      stages: STAGES,
      missions: MISSIONS,
      economy: economy.economySummary(),
      combat: combat.constants,
    };
  }

  // --------------------------------------------------------------- player --

  /** Assemble the full authenticated player view. */
  getPlayerState(playerId) {
    const player = this.repos.findPlayerById(playerId);
    if (!player) throw notFound('Player profile not found.');

    const roster = this.repos.listRoster(playerId);
    const teams = this.repos.listTeams(playerId);
    const active = this.repos.findActiveBattle(playerId);

    return {
      profile: {
        id: player.id,
        displayName: player.displayName,
        level: player.level,
        xp: player.xp,
        xpForNext: economy.xpForLevel(player.level),
        crystals: player.crystals,
        zeni: player.zeni,
        souls: player.souls,
        pass: player.pass,
        stamina: player.stamina,
        pity: player.pity,
        counters: player.counters,
        clearedStages: player.clearedStages,
        settings: player.settings,
        createdAt: player.createdAt,
      },
      roster: roster.map((entry) => this.#decorateRosterEntry(entry)),
      teams,
      activeBattleId: active?.id ?? null,
      missions: economy.evaluateMissions(
        { ...player.counters, rosterSize: roster.length },
        player.claimedMissions
      ),
      fairness: {
        serverSeedHash: serverSeedHash(),
        clientSeed: player.clientSeed,
        nonce: player.summonNonce,
      },
    };
  }

  /** Attach derived display data to a roster row. */
  #decorateRosterEntry(entry) {
    const def = CATALOGUE.byId.get(entry.fighterId);
    if (!def) return { ...entry, missing: true };
    const stats = combat.computeStats(def, entry);
    return {
      ...entry,
      title: def.title,
      rarity: def.rarity,
      element: def.element,
      tags: def.tags,
      archetype: def.archetype,
      art: def.art,
      moves: def.moves,
      stats,
      power: Math.round(
        stats.hp * 0.32 + stats.strike * 1.5 + stats.blast * 1.5 +
        stats.strDef * 0.9 + stats.blsDef * 0.9 + stats.crit * 90
      ),
      starProgress: economy.nextStarProgress(entry.zPower),
      maxLevel: economy.maxLevelForStars(entry.stars),
      nextTrainingCost: entry.level < economy.maxLevelForStars(entry.stars)
        ? economy.trainingCost(entry.level, def.rarity)
        : null,
    };
  }

  // --------------------------------------------------------------- summon --

  /**
   * Perform a summon. Atomic: crystals are debited, results are merged into
   * the roster, pity advances and the ledger is written in one transaction.
   */
  async summon(playerId, input) {
    const dto = validate(input, {
      bannerId: rules.id(),
      count: rules.int({ min: 1, max: economy.MULTI_SIZE, default: 1 }),
    });

    const banner = economy.getBanner(dto.bannerId);
    if (!banner) throw notFound('That summon banner does not exist.');
    if (dto.count !== 1 && dto.count !== economy.MULTI_SIZE) {
      throw badRequest('Summons must be a single pull or a full multi.');
    }

    const cost = dto.count === 1 ? economy.SUMMON_COST_SINGLE : economy.SUMMON_COST_MULTI;

    return this.repos.transaction(() => {
      const player = this.repos.findPlayerById(playerId);
      if (!player) throw notFound('Player profile not found.');
      if (player.crystals < cost) {
        throw unprocessable(
          'INSUFFICIENT_CRYSTALS',
          `You need ${cost.toLocaleString()} Chrono Crystals for this summon.`,
          { required: cost, balance: player.crystals }
        );
      }

      const summonResult = economy.performSummon({
        banner,
        count: dto.count,
        pity: player.pity,
        serverSeed: config.security.gachaSecret,
        clientSeed: player.clientSeed,
        nonce: player.summonNonce,
      });

      // Merge into the roster.
      const existing = new Map(
        this.repos.listRoster(playerId).map((e) => [e.fighterId, e])
      );
      const outcomes = economy.applySummonToRoster(summonResult.results, existing);

      for (const outcome of outcomes) {
        const current = existing.get(outcome.fighterId);
        if (!current) {
          const created = this.repos.putRosterEntry({
            id: shortId('rst_'),
            playerId,
            fighterId: outcome.fighterId,
            level: 1,
            zPower: outcome.zPower,
            stars: outcome.stars,
            soulBoosts: {},
            acquiredAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          existing.set(outcome.fighterId, created);
        } else {
          const updated = this.repos.updateRosterEntry(current.id, (doc) => {
            doc.zPower = outcome.zPowerTotal;
            doc.stars = outcome.stars;
            return doc;
          });
          existing.set(outcome.fighterId, updated);
        }
      }

      const balanceAfter = player.crystals - cost;
      const updatedPlayer = this.repos.updatePlayer(playerId, (doc) => {
        doc.crystals = balanceAfter;
        doc.pity = summonResult.pity;
        doc.summonNonce += 1;
        doc.counters.summons += dto.count;
        doc.counters.rosterSize = existing.size;
        return doc;
      });

      this.repos.recordLedger({
        playerId,
        currency: 'crystals',
        delta: -cost,
        balanceAfter,
        reason: dto.count === 1 ? 'summon_single' : 'summon_multi',
        refId: banner.id,
      });

      this.repos.recordSummon({
        id: shortId('smn_'),
        playerId,
        bannerId: banner.id,
        count: dto.count,
        results: outcomes.map((o) => ({
          fighterId: o.fighterId, rarity: o.rarity, isNew: o.isNew, featured: o.featured,
        })),
        verification: summonResult.verification,
        createdAt: new Date().toISOString(),
      });

      logger.info('Summon performed', {
        playerId, banner: banner.id, count: dto.count,
        top: outcomes.reduce((best, o) =>
          RARITIES[o.rarity].tier > RARITIES[best].tier ? o.rarity : best, 'HERO'),
      });

      return {
        results: outcomes,
        crystals: balanceAfter,
        pity: summonResult.pity,
        verification: summonResult.verification,
        roster: [...existing.values()].map((e) => this.#decorateRosterEntry(e)),
      };
    });
  }

  // -------------------------------------------------------------- roster ---

  /** Spend Zeni to raise a fighter's level. */
  async trainFighter(playerId, input) {
    const dto = validate(input, {
      fighterId: rules.string({ min: 1, max: 64 }),
      levels: rules.int({ min: 1, max: 50, default: 1 }),
    });

    return this.repos.transaction(() => {
      const player = this.repos.findPlayerById(playerId);
      const entry = this.repos.findRosterEntry(playerId, dto.fighterId);
      if (!entry) throw notFound('You do not own that fighter.');

      const def = CATALOGUE.byId.get(entry.fighterId);
      const maxLevel = economy.maxLevelForStars(entry.stars);
      if (entry.level >= maxLevel) {
        throw unprocessable(
          'LEVEL_CAPPED',
          `This fighter is capped at level ${maxLevel}. Limit break to raise the cap.`,
          { maxLevel, stars: entry.stars }
        );
      }

      // Cost the requested levels, stopping at the cap.
      let totalCost = 0;
      let level = entry.level;
      let applied = 0;
      for (let i = 0; i < dto.levels && level < maxLevel; i += 1) {
        const step = economy.trainingCost(level, def.rarity);
        if (player.zeni - totalCost < step) break;
        totalCost += step;
        level += 1;
        applied += 1;
      }

      if (applied === 0) {
        throw unprocessable('INSUFFICIENT_ZENI', 'You do not have enough Zeni to train further.', {
          required: economy.trainingCost(entry.level, def.rarity),
          balance: player.zeni,
        });
      }

      const updatedEntry = this.repos.updateRosterEntry(entry.id, (doc) => {
        doc.level = level;
        return doc;
      });

      const balanceAfter = player.zeni - totalCost;
      this.repos.updatePlayer(playerId, (doc) => {
        doc.zeni = balanceAfter;
        doc.counters.upgrades += 1;
        return doc;
      });
      this.repos.recordLedger({
        playerId, currency: 'zeni', delta: -totalCost, balanceAfter,
        reason: 'training', refId: entry.fighterId,
      });

      return {
        entry: this.#decorateRosterEntry(updatedEntry),
        levelsGained: applied,
        zeni: balanceAfter,
      };
    });
  }

  /** Spend Souls on a permanent stat boost. */
  async soulBoost(playerId, input) {
    const dto = validate(input, {
      fighterId: rules.string({ min: 1, max: 64 }),
      stat: rules.enum(['hp', 'strike', 'blast', 'strDef', 'blsDef', 'crit']),
      points: rules.int({ min: 1, max: 20, default: 1 }),
    });

    return this.repos.transaction(() => {
      const player = this.repos.findPlayerById(playerId);
      const entry = this.repos.findRosterEntry(playerId, dto.fighterId);
      if (!entry) throw notFound('You do not own that fighter.');

      const def = CATALOGUE.byId.get(entry.fighterId);
      const boosts = { ...(entry.soulBoosts ?? {}) };
      const cap = 20 + entry.stars * 5;

      let spent = 0;
      let applied = 0;
      for (let i = 0; i < dto.points; i += 1) {
        const current = boosts[dto.stat] ?? 0;
        if (current >= cap) break;
        const step = economy.soulBoostCost(current, def.rarity);
        if (player.souls - spent < step) break;
        spent += step;
        boosts[dto.stat] = current + 1;
        applied += 1;
      }

      if (applied === 0) {
        throw unprocessable('INSUFFICIENT_SOULS', 'Not enough Souls, or this stat is already maxed.', {
          balance: player.souls, cap,
        });
      }

      const updatedEntry = this.repos.updateRosterEntry(entry.id, (doc) => {
        doc.soulBoosts = boosts;
        return doc;
      });
      const balanceAfter = player.souls - spent;
      this.repos.updatePlayer(playerId, (doc) => {
        doc.souls = balanceAfter;
        doc.counters.upgrades += 1;
        return doc;
      });
      this.repos.recordLedger({
        playerId, currency: 'souls', delta: -spent, balanceAfter,
        reason: 'soul_boost', refId: entry.fighterId,
      });

      return { entry: this.#decorateRosterEntry(updatedEntry), pointsGained: applied, souls: balanceAfter };
    });
  }

  // ---------------------------------------------------------------- teams --

  /** Create or replace a team in a slot. */
  async saveTeam(playerId, input) {
    const dto = validate(input, {
      slotIndex: rules.int({ min: 0, max: 5 }),
      name: rules.string({ min: 1, max: 24, default: 'Squad' }),
      members: rules.array(rules.string({ min: 1, max: 64 }), { min: 1, max: config.game.teamSize }),
    });

    // Reject duplicates within a team.
    if (new Set(dto.members).size !== dto.members.length) {
      throw badRequest('A team cannot contain the same fighter twice.');
    }

    return this.repos.transaction(() => {
      const owned = new Set(this.repos.listRoster(playerId).map((e) => e.fighterId));
      for (const fighterId of dto.members) {
        if (!owned.has(fighterId)) throw unprocessable('NOT_OWNED', 'That fighter is not in your roster.');
      }

      const existing = this.repos.listTeams(playerId).find((t) => t.slotIndex === dto.slotIndex);
      const team = {
        id: existing?.id ?? shortId('tm_'),
        playerId,
        slotIndex: dto.slotIndex,
        name: dto.name,
        members: dto.members,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.repos.putTeam(team);
      return { team, teams: this.repos.listTeams(playerId) };
    });
  }

  // -------------------------------------------------------------- battles --

  /** Begin a stage battle. Only one battle may be active at a time. */
  async startBattle(playerId, input) {
    const dto = validate(input, {
      stageId: rules.string({ min: 1, max: 32 }),
      members: rules.array(rules.string({ min: 1, max: 64 }), { min: 1, max: config.game.teamSize }),
    });

    const stage = STAGES.find((s) => s.id === dto.stageId);
    if (!stage) throw notFound('That stage does not exist.');
    if (new Set(dto.members).size !== dto.members.length) {
      throw badRequest('A team cannot contain the same fighter twice.');
    }

    return this.repos.transaction(() => {
      const existing = this.repos.findActiveBattle(playerId);
      if (existing) {
        throw conflict('You already have a battle in progress.', 'BATTLE_IN_PROGRESS', {
          battleId: existing.id,
        });
      }

      const rosterEntries = this.repos.listRoster(playerId);
      const rosterMap = new Map(rosterEntries.map((e) => [e.fighterId, e]));
      for (const fighterId of dto.members) {
        if (!rosterMap.has(fighterId)) {
          throw unprocessable('NOT_OWNED', 'That fighter is not in your roster.');
        }
      }

      // Stamina is unlimited in this build — the check is a no-op kept for
      // interface parity with the commercial genre.
      const player = this.repos.findPlayerById(playerId);

      const seed = shortId('btl_');
      const state = combat.createBattle({
        playerTeam: dto.members,
        roster: rosterMap,
        enemyTeam: stage.enemyTeam,
        enemyLevel: stage.level,
        seed,
        mode: 'story',
        stageId: stage.id,
      });

      const now = new Date().toISOString();
      const battle = this.repos.putBattle({
        id: shortId('bt_'),
        playerId,
        stageId: stage.id,
        status: 'active',
        snapshot: combat.snapshotBattle(state),
        createdAt: now,
        updatedAt: now,
      });

      this.repos.updatePlayer(playerId, (doc) => {
        doc.counters.battlesPlayed += 1;
        return doc;
      });

      return {
        battleId: battle.id,
        stage,
        state: combat.serialiseBattle(state),
        events: state.events,
        stamina: player.stamina,
      };
    });
  }

  /**
   * Apply a player action, then let the AI respond.
   * Every action is validated server-side against the authoritative state.
   */
  async battleAction(playerId, battleId, input) {
    const dto = validate(input, {
      action: rules.enum(['card', 'vanish', 'switch', 'rising_rush', 'main_ability', 'charge']),
      cardUid: rules.string({ min: 1, max: 32, optional: true }),
      slot: rules.int({ min: 0, max: 2, optional: true }),
    });

    return this.repos.transaction(() => {
      const battle = this.repos.getBattle(battleId);
      if (!battle || battle.playerId !== playerId) throw notFound('Battle not found.');
      if (battle.status !== 'active') {
        throw conflict('This battle has already finished.', 'BATTLE_COMPLETE');
      }

      const state = combat.restoreBattle(battle.snapshot);
      let events = [];

      try {
        switch (dto.action) {
          case 'card':
            if (!dto.cardUid) throw badRequest('cardUid is required for a card action.');
            events = combat.playCard(state, 'player', dto.cardUid);
            break;
          case 'vanish':
            events = combat.vanish(state, 'player');
            break;
          case 'switch':
            if (dto.slot === undefined) throw badRequest('slot is required for a switch action.');
            events = combat.switchFighter(state, 'player', dto.slot);
            break;
          case 'rising_rush':
            events = combat.risingRush(state, 'player');
            break;
          case 'main_ability':
            events = combat.mainAbility(state, 'player');
            break;
          case 'charge':
            events = combat.charge(state, 'player');
            break;
          default:
            throw badRequest('Unsupported action.');
        }
      } catch (err) {
        // Translate engine errors into typed API errors.
        const map = {
          CARD_NOT_IN_HAND: ['CARD_NOT_IN_HAND', 'That card is no longer in your hand.'],
          INSUFFICIENT_KI: ['INSUFFICIENT_KI', 'Not enough Ki to play that card.'],
          ARTS_SEALED: ['ARTS_SEALED', 'That Art is sealed right now.'],
          VANISH_NOT_READY: ['VANISH_NOT_READY', 'Your Vanishing Gauge is not charged.'],
          INVALID_SLOT: ['INVALID_SLOT', 'That team slot is empty.'],
          FIGHTER_DEFEATED: ['FIGHTER_DEFEATED', 'That fighter has been defeated.'],
          ALREADY_ACTIVE: ['ALREADY_ACTIVE', 'That fighter is already on the battlefield.'],
          SUBSTITUTION_ON_COOLDOWN: ['SUB_COOLDOWN', 'Cover change is still on cooldown.'],
          RISING_RUSH_NOT_READY: ['RUSH_NOT_READY', 'You need all seven Dragon Balls.'],
          MAIN_ABILITY_USED: ['ABILITY_USED', 'Main Ability has already been used.'],
          MAIN_ABILITY_NOT_READY: ['ABILITY_NOT_READY', 'Main Ability is not available yet.'],
          NO_ACTIVE_FIGHTER: ['NO_ACTIVE_FIGHTER', 'You have no fighter on the battlefield.'],
        };
        const [code, message] = map[err.message] ?? [null, null];
        if (code) throw unprocessable(code, message);
        throw err;
      }

      // AI responds while the battle continues and the player has no combo open.
      if (state.status === 'active' && state.comboIndex === 0) {
        events = events.concat(combat.enemyTurn(state));
      }

      let rewards = null;
      if (state.status === 'complete') {
        rewards = this.#settleBattle(playerId, battle, state);
      }

      const now = new Date().toISOString();
      this.repos.putBattle({
        ...battle,
        status: state.status === 'complete' ? 'complete' : 'active',
        snapshot: combat.snapshotBattle(state),
        winner: state.winner ?? null,
        updatedAt: now,
      });

      return {
        state: combat.serialiseBattle(state),
        events,
        rewards,
      };
    });
  }

  /** Award end-of-battle rewards. Must run inside a transaction. */
  #settleBattle(playerId, battle, state) {
    const stage = STAGES.find((s) => s.id === battle.stageId);
    const player = this.repos.findPlayerById(playerId);
    const won = state.winner === 'player';

    if (!won) {
      this.repos.updatePlayer(playerId, (doc) => doc);
      return { won: false, crystals: 0, zeni: 0, souls: 0, xp: 0, firstClear: false };
    }

    const firstClear = !player.clearedStages[stage.id];
    // The free Legends Pass doubles Zeni and Souls for everyone.
    const passMultiplier = player.pass.active ? 2 : 1;

    const crystals = stage.rewards.crystals + (firstClear ? stage.firstClear.crystals : 0);
    const zeni = stage.rewards.zeni * passMultiplier;
    const souls = (stage.rewards.souls + (firstClear ? stage.firstClear.souls : 0)) * passMultiplier;
    const xp = stage.rewards.xp;

    const updated = this.repos.updatePlayer(playerId, (doc) => {
      doc.crystals += crystals;
      doc.zeni += zeni;
      doc.souls += souls;
      doc.xp += xp;
      // Account level-ups.
      while (doc.xp >= economy.xpForLevel(doc.level)) {
        doc.xp -= economy.xpForLevel(doc.level);
        doc.level += 1;
      }
      doc.counters.battlesWon += 1;
      if (firstClear) {
        doc.clearedStages[stage.id] = new Date().toISOString();
        doc.counters.stagesCleared = Object.keys(doc.clearedStages).length;
      }
      const rushed = state.player.dragonBalls === 0 && state.count > 0;
      if (rushed) doc.counters.risingRush += 0; // counted at rush time
      return doc;
    });

    this.repos.recordLedger({
      playerId, currency: 'crystals', delta: crystals, balanceAfter: updated.crystals,
      reason: firstClear ? 'stage_first_clear' : 'stage_clear', refId: stage.id,
    });
    this.repos.recordLedger({
      playerId, currency: 'zeni', delta: zeni, balanceAfter: updated.zeni,
      reason: 'stage_clear', refId: stage.id,
    });

    return {
      won: true, crystals, zeni, souls, xp, firstClear,
      level: updated.level, totalCrystals: updated.crystals,
    };
  }

  /** Fetch an in-progress battle (page refresh recovery). */
  getBattle(playerId, battleId) {
    const battle = this.repos.getBattle(battleId);
    if (!battle || battle.playerId !== playerId) throw notFound('Battle not found.');
    const state = combat.restoreBattle(battle.snapshot);
    return {
      battleId: battle.id,
      stage: STAGES.find((s) => s.id === battle.stageId) ?? null,
      state: combat.serialiseBattle(state),
    };
  }

  /** Abandon an active battle (counts as a loss, frees the slot). */
  async forfeitBattle(playerId, battleId) {
    return this.repos.transaction(() => {
      const battle = this.repos.getBattle(battleId);
      if (!battle || battle.playerId !== playerId) throw notFound('Battle not found.');
      this.repos.putBattle({
        ...battle,
        status: 'forfeit',
        winner: 'enemy',
        updatedAt: new Date().toISOString(),
      });
      return { forfeited: true };
    });
  }

  // ------------------------------------------------------------- missions --

  /** Claim a completed mission's reward. */
  async claimMission(playerId, input) {
    const dto = validate(input, { missionId: rules.string({ min: 1, max: 40 }) });

    return this.repos.transaction(() => {
      const player = this.repos.findPlayerById(playerId);
      const mission = MISSIONS.find((m) => m.id === dto.missionId);
      if (!mission) throw notFound('Unknown mission.');
      if (player.claimedMissions[mission.id]) {
        throw conflict('That reward has already been claimed.', 'ALREADY_CLAIMED');
      }

      const rosterSize = this.repos.listRoster(playerId).length;
      const counters = { ...player.counters, rosterSize };
      if ((counters[mission.metric] ?? 0) < mission.target) {
        throw unprocessable('MISSION_INCOMPLETE', 'That mission is not complete yet.');
      }

      const reward = mission.reward;
      const updated = this.repos.updatePlayer(playerId, (doc) => {
        doc.crystals += reward.crystals ?? 0;
        doc.zeni += reward.zeni ?? 0;
        doc.souls += reward.souls ?? 0;
        doc.claimedMissions[mission.id] = new Date().toISOString();
        return doc;
      });

      if (reward.crystals) {
        this.repos.recordLedger({
          playerId, currency: 'crystals', delta: reward.crystals,
          balanceAfter: updated.crystals, reason: 'mission_reward', refId: mission.id,
        });
      }

      return {
        mission: mission.id,
        reward,
        crystals: updated.crystals,
        zeni: updated.zeni,
        souls: updated.souls,
        missions: economy.evaluateMissions(counters, updated.claimedMissions),
      };
    });
  }

  // ------------------------------------------------------------- settings --

  /** Update client-side preferences. */
  async updateSettings(playerId, input) {
    const dto = validate(input, {
      reducedMotion: rules.bool({ optional: true }),
      screenShake: rules.bool({ optional: true }),
      damageNumbers: rules.bool({ optional: true }),
      autoAdvance: rules.bool({ optional: true }),
      soundEnabled: rules.bool({ optional: true }),
      theme: rules.enum(['nebula', 'inferno', 'glacier', 'void'], { optional: true }),
    });

    return this.repos.transaction(() => {
      const updated = this.repos.updatePlayer(playerId, (doc) => {
        doc.settings = { ...doc.settings, ...dto };
        return doc;
      });
      return { settings: updated.settings };
    });
  }

  /** Change display name (unique, case-insensitive). */
  async updateProfile(playerId, input) {
    const dto = validate(input, { displayName: rules.displayName() });
    return this.repos.transaction(() => {
      if (this.repos.displayNameTaken(dto.displayName, playerId)) {
        throw conflict('That display name is already taken.', 'NAME_TAKEN');
      }
      const updated = this.repos.updatePlayer(playerId, (doc) => {
        doc.displayName = dto.displayName;
        return doc;
      });
      return { displayName: updated.displayName };
    });
  }

  /** Export every piece of data held about the player (GDPR portability). */
  exportData(playerId) {
    return {
      exportedAt: new Date().toISOString(),
      profile: this.repos.findPlayerById(playerId),
      roster: this.repos.listRoster(playerId),
      teams: this.repos.listTeams(playerId),
      ledger: this.repos.listLedger(playerId, 1000),
      summons: this.repos.listSummons(playerId, 500),
    };
  }

  /** Regenerate the client seed, resetting the provably-fair chain. */
  async rotateClientSeed(playerId) {
    return this.repos.transaction(() => {
      const updated = this.repos.updatePlayer(playerId, (doc) => {
        doc.clientSeed = shortId('seed_');
        doc.summonNonce = 0;
        return doc;
      });
      return {
        clientSeed: updated.clientSeed,
        nonce: updated.summonNonce,
        serverSeedHash: serverSeedHash(),
      };
    });
  }
}

module.exports = { GameService };
