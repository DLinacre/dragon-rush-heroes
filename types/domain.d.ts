/**
 * ============================================================================
 * DOMAIN TYPE CONTRACTS
 * ============================================================================
 *
 * The canonical, strict description of every data shape that crosses a module
 * boundary. These are *ambient declarations*: they exist only at check time,
 * emit nothing, and add zero bytes to the shipped bundle.
 *
 * Consumed by both the server (CommonJS) and the client (ES modules), so the
 * two can never disagree about a payload shape.
 */

// ---------------------------------------------------------------- elements --

/** The five core elements plus the two special ones. */
export type ElementId =
  | 'RED' | 'YELLOW' | 'PURPLE' | 'GREEN' | 'BLUE' | 'DARK' | 'LIGHT';

export interface ElementDef {
  readonly id: ElementId;
  /** Player-facing name, e.g. "Crimson". */
  readonly label: string;
  /** Element this one is strong against; `'*'` for DARK (beats all core). */
  readonly beats: ElementId | '*';
  readonly hex: string;
  readonly glow: string;
}

// ---------------------------------------------------------------- rarities --

export type RarityId = 'HERO' | 'EXTREME' | 'SPARKING' | 'LEGENDS' | 'ULTRA';

export interface RarityDef {
  readonly id: RarityId;
  readonly label: string;
  /** 1 (HERO) … 5 (ULTRA). Used for ordering and gating. */
  readonly tier: 1 | 2 | 3 | 4 | 5;
  /** Base-stat multiplier. */
  readonly power: number;
  /** Z-Power granted per duplicate pull. */
  readonly zPowerPerPull: number;
  readonly unlockCost: number;
  readonly colour: string;
  readonly accent: string;
}

// -------------------------------------------------------------------- arts --

export type ArtsId = 'STRIKE' | 'BLAST' | 'SPECIAL' | 'ULTIMATE' | 'AWAKEN';

export interface ArtsDef {
  readonly id: ArtsId;
  readonly label: string;
  /** Ki cost before modifiers. */
  readonly cost: number;
  readonly colour: string;
  readonly icon: string;
}

/** A single card in a hand. `uid` is unique for the lifetime of the battle. */
export interface ArtsCard {
  readonly uid: string;
  readonly arts: ArtsId;
  readonly label: string;
  /** Ki cost after `artsCostDown` modifiers. */
  readonly cost: number;
  readonly colour: string;
  readonly icon: string;
  /** Signature move name for SPECIAL/ULTIMATE/AWAKEN; `null` otherwise. */
  readonly moveName: string | null;
  /** VFX profile key; `null` for basic arts. */
  readonly vfx: VfxKind | null;
}

// --------------------------------------------------------------------- vfx --

export type VfxKind =
  | 'BEAM' | 'BARRAGE' | 'METEOR' | 'VORTEX' | 'SLASH'
  | 'NOVA' | 'CHAIN' | 'CRUSH' | 'SPIRAL' | 'ERUPTION';

export interface VfxProfile {
  /** Emitter name consumed by the particle engine. */
  readonly kind: string;
  readonly particles: number;
  /** Screen-shake magnitude in pixels. */
  readonly shake: number;
  /** Flash intensity, 0–1. */
  readonly flash: number;
  readonly duration: number;
}

// --------------------------------------------------------------- abilities --

/** Every effect the combat engine knows how to apply. */
export type AbilityEffectKey =
  | 'dmgUp' | 'dmgCut' | 'kiRegen' | 'critRate' | 'healOnEntry'
  | 'drawSpeed' | 'artsCostDown' | 'enemyKiDrain' | 'vanishRegen'
  | 'subCountDown' | 'endurance' | 'strikeUp' | 'blastUp'
  | 'ultimateUp' | 'cardDestroy' | 'sealArts';

/** Conditions on which an ability fires. */
export type AbilityTrigger =
  | 'onEntry' | 'onArtsUse' | 'onVanish' | 'onCoverChange' | 'onHit'
  | 'onCritical' | 'onGaugeFull' | 'onAllyDown' | 'battleStart';

export interface AbilityEffect {
  readonly key: AbilityEffectKey;
  readonly value: number;
  /** Pre-rendered player-facing description. */
  readonly text: string;
}

export interface Ability {
  readonly trigger: AbilityTrigger;
  readonly triggerText: string;
  readonly effects: readonly AbilityEffect[];
  /** Timer counts the effect lasts; `0` means permanent for the battle. */
  readonly duration: number;
}

// ----------------------------------------------------------------- fighter --

export type ArchetypeId = 'BRAWLER' | 'CANNON' | 'BULWARK' | 'DUELIST' | 'TRICKSTER';

/** Base stat block. All values are absolute, not multipliers. */
export interface FighterStats {
  readonly hp: number;
  readonly strike: number;
  readonly blast: number;
  readonly strDef: number;
  readonly blsDef: number;
  /** Critical chance as a percentage. */
  readonly crit: number;
  readonly kiRegen: number;
}

export interface SignatureMove {
  readonly name: string;
  readonly arts: ArtsId;
  readonly vfx: VfxKind;
  /** Damage multiplier. */
  readonly power: number;
}

export interface MainAbility {
  readonly name: string;
  /** Timer counts that must elapse before it becomes available. */
  readonly requires: number;
  readonly effects: readonly AbilityEffect[];
}

export interface UniqueGauge {
  readonly name: string;
  readonly chargePerArts: number;
  readonly fullEffects: readonly AbilityEffect[];
}

export interface ZAbility {
  readonly stat: 'strike' | 'blast' | 'strDef' | 'blsDef' | 'hp';
  /** Tag whose holders receive the buff. */
  readonly tag: string;
  /** Buff percentage indexed by star rating, 0–7. */
  readonly tiers: readonly number[];
}

/** Everything the procedural renderer needs to draw a portrait. */
export interface FighterArt {
  readonly hue: number;
  readonly hue2: number;
  readonly aura: string;
  /** Deterministic seed — identical input always yields identical art. */
  readonly seed: string;
  readonly build: ArchetypeId;
  /** Aura strength, 0–1. */
  readonly intensity: number;
}

/** An immutable catalogue entry. Generated, never hand-authored. */
export interface Fighter {
  readonly id: string;
  readonly lineage: string;
  readonly name: string;
  readonly form: string;
  /** Full display name, e.g. "Ascendant Kalen". */
  readonly title: string;
  readonly rarity: RarityId;
  readonly element: ElementId;
  readonly tags: readonly string[];
  readonly archetype: ArchetypeId;
  readonly stats: FighterStats;
  readonly moves: { readonly special: SignatureMove; readonly ultimate: SignatureMove };
  readonly mainAbility: MainAbility;
  readonly abilities: readonly Ability[];
  readonly uniqueGauge: UniqueGauge;
  readonly zAbility: ZAbility;
  readonly art: FighterArt;
  readonly lore: string;
}

// ------------------------------------------------------------------ banner --

export interface Banner {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly description: string;
  /** Fighter ids with boosted odds. */
  readonly featured: readonly string[];
  /** Probability per rarity. Must sum to 1. */
  readonly rates: Readonly<Record<RarityId, number>>;
  /** Portion of a rarity's probability reserved for featured fighters. */
  readonly featuredShare: number;
  readonly accent: string;
  readonly art: string;
}

// ------------------------------------------------------------------- stage --

export interface StageRewards {
  readonly zeni: number;
  readonly crystals: number;
  readonly xp: number;
  readonly souls: number;
}

export interface Stage {
  readonly id: string;
  readonly chapter: string;
  readonly chapterName: string;
  readonly theme: string;
  readonly index: number;
  readonly name: string;
  readonly isBoss: boolean;
  readonly level: number;
  readonly enemyTeam: readonly string[];
  readonly staminaCost: number;
  readonly rewards: StageRewards;
  readonly firstClear: { readonly crystals: number; readonly souls: number };
}

// ----------------------------------------------------------------- mission --

export type MissionScope = 'daily' | 'career';

export type MissionMetric =
  | 'logins' | 'battlesWon' | 'battlesPlayed' | 'summons'
  | 'upgrades' | 'risingRush' | 'rosterSize' | 'stagesCleared';

export interface MissionReward {
  readonly crystals?: number;
  readonly zeni?: number;
  readonly souls?: number;
}

export interface Mission {
  readonly id: string;
  readonly scope: MissionScope;
  readonly name: string;
  readonly target: number;
  readonly metric: MissionMetric;
  readonly reward: MissionReward;
}

/** A mission with the current player's progress folded in. */
export interface MissionProgress extends Mission {
  readonly progress: number;
  readonly complete: boolean;
  readonly claimed: boolean;
  readonly claimable: boolean;
}

// ------------------------------------------------------------------ player --

export type CurrencyKind = 'crystals' | 'zeni' | 'souls';

export interface PlayerCounters {
  logins: number;
  battlesWon: number;
  battlesPlayed: number;
  summons: number;
  upgrades: number;
  risingRush: number;
  rosterSize: number;
  stagesCleared: number;
}

/**
 * The Legends Pass. `expiresAt` is `null` for every account, permanently —
 * this is the type-level expression of the free-forever guarantee, and is
 * mirrored by a database CHECK constraint.
 */
export interface PlayerPass {
  readonly active: true;
  readonly tier: 'LEGENDS_PASS_FREE';
  readonly grantedAt: string;
  readonly expiresAt: null;
  readonly perks: readonly string[];
}

export interface PlayerStamina {
  readonly current: number;
  readonly max: number;
  /** Always `true`. Stamina is modelled for UI parity but never consumed. */
  readonly unlimited: true;
  readonly lastTickAt: string;
}

export interface PityState {
  sinceSparking: number;
  sinceLegends: number;
}

export type ThemeId = 'nebula' | 'inferno' | 'glacier' | 'void';

export interface PlayerSettings {
  reducedMotion: boolean;
  screenShake: boolean;
  damageNumbers: boolean;
  autoAdvance: boolean;
  soundEnabled: boolean;
  /** Wait for explicit confirmation instead of auto-advancing (WCAG 2.2.1). */
  untimedMode: boolean;
  theme: ThemeId;
}

export interface Player {
  readonly id: string;
  displayName: string;
  level: number;
  xp: number;
  crystals: number;
  zeni: number;
  souls: number;
  pass: PlayerPass;
  stamina: PlayerStamina;
  pity: PityState;
  summonNonce: number;
  clientSeed: string;
  counters: PlayerCounters;
  claimedMissions: Record<string, string>;
  clearedStages: Record<string, string>;
  lastDailyResetAt: string;
  settings: PlayerSettings;
  readonly createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ roster --

export type SoulBoostStat = 'hp' | 'strike' | 'blast' | 'strDef' | 'blsDef' | 'crit';

export interface RosterEntry {
  readonly id: string;
  readonly playerId: string;
  readonly fighterId: string;
  level: number;
  zPower: number;
  /** Derived from `zPower`; kept in sync by the economy layer. */
  stars: number;
  soulBoosts: Partial<Record<SoulBoostStat, number>>;
  readonly acquiredAt: string;
  updatedAt: string;
}

/** Star progression toward the next tier. `next` is `null` at 7 stars. */
export interface StarProgress {
  readonly stars: number;
  readonly next: number | null;
  readonly current: number;
  readonly required: number | null;
  readonly percent: number;
}

/** A roster entry enriched with catalogue data for display. */
export interface DecoratedRosterEntry extends RosterEntry {
  readonly title: string;
  readonly rarity: RarityId;
  readonly element: ElementId;
  readonly tags: readonly string[];
  readonly archetype: ArchetypeId;
  readonly art: FighterArt;
  readonly moves: { readonly special: SignatureMove; readonly ultimate: SignatureMove };
  readonly stats: FighterStats;
  /** Single scalar used for sorting and team-power display. */
  readonly power: number;
  readonly starProgress: StarProgress;
  readonly maxLevel: number;
  /** `null` when the fighter is at its star-gated level cap. */
  readonly nextTrainingCost: number | null;
}

// -------------------------------------------------------------------- team --

export interface Team {
  readonly id: string;
  readonly playerId: string;
  readonly slotIndex: number;
  name: string;
  members: string[];
  readonly createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ combat --

export type BattleSide = 'player' | 'enemy';
export type BattleStatus = 'active' | 'complete' | 'forfeit' | 'abandoned';

export interface ActiveBuff {
  readonly key: string;
  readonly value: number;
  remaining: number;
  readonly permanent: boolean;
  readonly source: string;
}

/** A fighter's live state inside a battle. */
export interface Combatant {
  readonly fighterId: string;
  readonly name: string;
  readonly element: ElementId;
  readonly rarity: RarityId;
  readonly level: number;
  readonly stars: number;
  stats: FighterStats;
  readonly maxHp: number;
  hp: number;
  ki: number;
  /** Vanishing Gauge, 0–100. */
  vanish: number;
  /** Counts remaining before a cover change is permitted. */
  substitution: number;
  /** Unique Gauge, 0–100. */
  gauge: number;
  gaugeFullTriggered: boolean;
  buffs: ActiveBuff[];
  /** One-shot ability activations already consumed. */
  consumed: Record<string, boolean>;
  alive: boolean;
  zMultiplier: number;
  mainAbilityUsed: boolean;
}

export type BattleAction =
  | { action: 'card'; cardUid: string }
  | { action: 'vanish' }
  | { action: 'switch'; slot: number }
  | { action: 'rising_rush' }
  | { action: 'main_ability' }
  | { action: 'charge' };

/**
 * Timeline events. The server emits an ordered list; the client replays it as
 * animation. This discriminated union is what makes the playback loop
 * exhaustively checkable.
 */
export type BattleEvent =
  | { type: 'battle_start'; mode: string; stageId: string | null }
  | { type: 'card_play'; side: BattleSide; fighterId: string; arts: ArtsId;
      moveName: string | null; vfx: VfxKind | null; comboIndex: number }
  | { type: 'damage'; side: BattleSide; attackerId: string; defenderId: string;
      amount: number; critical: boolean; element: 'advantage' | 'resisted' | 'neutral';
      hpBefore: number; hpAfter: number; maxHp: number;
      arts?: string; moveName?: string | null; vfx?: VfxKind | null }
  | { type: 'ability'; side: BattleSide; fighterId: string; trigger: AbilityTrigger;
      triggerText: string; effects: readonly AbilityEffect[] }
  | { type: 'gauge_full'; side: BattleSide; fighterId: string; gaugeName: string;
      effects: readonly AbilityEffect[] }
  | { type: 'main_ability'; side: BattleSide; fighterId: string; name: string;
      effects: readonly AbilityEffect[] }
  | { type: 'vanish'; side: BattleSide; fighterId: string }
  | { type: 'charge'; side: BattleSide; fighterId: string; kiBefore?: number; kiAfter?: number }
  | { type: 'switch'; side: BattleSide; fighterId: string; fromId?: string; forced: boolean }
  | { type: 'rush_orb'; side: BattleSide; total: number }
  | { type: 'rising_rush_ready'; side: BattleSide }
  | { type: 'rising_rush'; side: BattleSide; fighterId: string;
      team: readonly { fighterId: string; name: string; element: ElementId; art: FighterArt }[] }
  | { type: 'endurance'; side: BattleSide; fighterId: string; hp: number; maxHp: number }
  | { type: 'ko'; side: BattleSide; fighterId: string }
  | { type: 'tick'; count: number }
  | { type: 'battle_end'; winner: BattleSide; counts: number };

/** Client-facing view of a combatant — engine internals stripped. */
export interface CombatantView {
  readonly fighterId: string;
  readonly name: string;
  readonly element: ElementId;
  readonly rarity: RarityId;
  readonly level: number;
  readonly stars: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly ki: number;
  readonly maxKi: number;
  readonly vanish: number;
  readonly maxVanish: number;
  readonly substitution: number;
  readonly gauge: number;
  readonly gaugeName: string;
  readonly alive: boolean;
  readonly art: FighterArt;
  readonly buffs: readonly { key: string; value: number; remaining: number; permanent: boolean }[];
  readonly mainAbility: { name: string; requires: number; used: boolean };
}

export interface BattleView {
  readonly status: BattleStatus;
  readonly winner: BattleSide | null;
  readonly count: number;
  readonly mode: string;
  readonly stageId: string | null;
  readonly comboIndex: number;
  readonly player: {
    readonly members: readonly CombatantView[];
    readonly active: number;
    readonly hand: readonly ArtsCard[];
    readonly rushOrbs: number;
    readonly risingRushReady: boolean;
  };
  readonly enemy: {
    readonly members: readonly CombatantView[];
    readonly active: number;
    /** Count only — the enemy's actual hand is never sent to the client. */
    readonly handCount: number;
    readonly rushOrbs: number;
    readonly risingRushReady: boolean;
  };
}

export interface BattleRewards {
  readonly won: boolean;
  readonly crystals: number;
  readonly zeni: number;
  readonly souls: number;
  readonly xp: number;
  readonly firstClear: boolean;
  readonly level?: number;
  readonly totalCrystals?: number;
}

// ------------------------------------------------------------------ summon --

export interface SummonResult {
  readonly fighterId: string;
  readonly title: string;
  readonly rarity: RarityId;
  readonly element: ElementId;
  readonly featured: boolean;
  /** Which pity rule fired, if any. */
  readonly pityApplied: 'sparking' | 'legends' | 'multi_guarantee' | null;
  readonly zPower: number;
  readonly art: FighterArt;
  readonly isNew: boolean;
  readonly zPowerTotal: number;
  readonly stars: number;
  readonly starsGained: number;
}

/** Everything needed to independently recompute a summon. */
export interface SummonVerification {
  readonly serverSeedHash: string;
  readonly clientSeed: string;
  readonly nonce: number;
  readonly algorithm: string;
}

// --------------------------------------------------------------- api shapes --

/** Success envelope. */
export interface ApiSuccess<T> { readonly data: T; }

/** Failure envelope. Clients switch on `code`, never on `message`. */
export interface ApiFailure {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export interface LedgerEntry {
  readonly id: string;
  readonly playerId: string;
  readonly currency: CurrencyKind;
  readonly delta: number;
  readonly balanceAfter: number;
  readonly reason: string;
  readonly refId: string | null;
  readonly createdAt: string;
}

/** The full authenticated player payload returned by `GET /api/player`. */
export interface PlayerStatePayload {
  readonly profile: Player & { readonly xpForNext: number };
  readonly roster: readonly DecoratedRosterEntry[];
  readonly teams: readonly Team[];
  readonly activeBattleId: string | null;
  readonly missions: readonly MissionProgress[];
  readonly fairness: {
    readonly serverSeedHash: string;
    readonly clientSeed: string;
    readonly nonce: number;
  };
}

/** Static reference data returned by `GET /api/catalogue`. */
export interface CataloguePayload {
  readonly fighters: readonly Fighter[];
  readonly elements: Readonly<Record<ElementId, ElementDef>>;
  readonly rarities: Readonly<Record<RarityId, RarityDef>>;
  readonly arts: Readonly<Record<ArtsId, ArtsDef>>;
  readonly vfx: Readonly<Record<VfxKind, VfxProfile>>;
  readonly banners: readonly Banner[];
  readonly stages: readonly Stage[];
  readonly missions: readonly Mission[];
  readonly economy: EconomySummary;
  readonly combat: Readonly<Record<string, number>>;
}

export interface EconomySummary {
  readonly founderGrant: number;
  readonly founderGrantGBPEquivalent: number;
  readonly referenceRate: {
    readonly crystalsPerReferencePack: number;
    readonly referencePackPriceGBP: number;
    readonly founderGrantGBPEquivalent: number;
  };
  readonly summonCostSingle: number;
  readonly summonCostMulti: number;
  readonly multiSize: number;
  readonly pitySparking: number;
  readonly pityLegends: number;
  /** Structural guarantees, expressed as literal types. */
  readonly freeForever: true;
  readonly monetisation: 'none';
  readonly passIncluded: true;
  readonly staminaUnlimited: true;
}
