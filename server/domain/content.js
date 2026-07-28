'use strict';
/**
 * ============================================================================
 * GAME CONTENT — Roster, Elements, Rarities, Banners, Stages
 * ============================================================================
 *
 * LEGAL / IP NOTICE
 * -----------------
 * This project is an ORIGINAL anime-fighter RPG. It reproduces the *systems*
 * of the genre (element wheel, Arts-card combat, gacha with pity, Z-Power
 * limit breaks) which are game mechanics and not protected expression, but it
 * uses an entirely ORIGINAL cast, original move names and original artwork
 * generated at runtime. No third-party characters, names, logos, audio or art
 * are included or required. See docs/LEGAL.md.
 *
 * ROSTER CONSTRUCTION
 * -------------------
 * 400+ fighters are produced deterministically from a curated table of
 * "lineages" (a character and their transformation ladder). Determinism
 * matters: fighter ids and stats must be identical on every server instance
 * and across restarts, otherwise saved rosters would break. A seeded xorshift
 * PRNG derives per-fighter variance so no two fighters feel identical while
 * remaining perfectly reproducible.
 */

// ---------------------------------------------------------------- elements --

/**
 * The element wheel. Five core elements form a pentagon of strengths; Dark
 * beats all five, Light beats Dark. Advantage multiplies damage; disadvantage
 * reduces it.
 */
const ELEMENTS = Object.freeze({
  RED:    { id: 'RED',    label: 'Crimson', beats: 'YELLOW', hex: '#ff4d4d', glow: '#ff8a3d' },
  YELLOW: { id: 'YELLOW', label: 'Solar',   beats: 'PURPLE', hex: '#ffd23f', glow: '#fff59d' },
  PURPLE: { id: 'PURPLE', label: 'Void',    beats: 'GREEN',  hex: '#b06bff', glow: '#e0b3ff' },
  GREEN:  { id: 'GREEN',  label: 'Verdant', beats: 'BLUE',   hex: '#3ddc84', glow: '#a5f5c8' },
  BLUE:   { id: 'BLUE',   label: 'Tidal',   beats: 'RED',    hex: '#3da5ff', glow: '#a8d8ff' },
  DARK:   { id: 'DARK',   label: 'Umbral',  beats: '*',      hex: '#8b5cf6', glow: '#3b0764' },
  LIGHT:  { id: 'LIGHT',  label: 'Radiant', beats: 'DARK',   hex: '#fff8e1', glow: '#ffe082' },
});

const CORE_ELEMENTS = ['RED', 'YELLOW', 'PURPLE', 'GREEN', 'BLUE'];

/**
 * Damage multiplier for an attacker/defender element pairing.
 * @returns {number} 1.5 advantage, 0.65 disadvantage, 1.0 neutral.
 */
function elementMultiplier(attacker, defender) {
  if (attacker === defender) return 1;
  if (attacker === 'DARK') return defender === 'LIGHT' ? 0.65 : 1.5;
  if (attacker === 'LIGHT') return defender === 'DARK' ? 1.5 : 1;
  if (defender === 'DARK') return attacker === 'LIGHT' ? 1.5 : 0.65;
  if (defender === 'LIGHT') return 1;
  if (ELEMENTS[attacker]?.beats === defender) return 1.5;
  if (ELEMENTS[defender]?.beats === attacker) return 0.65;
  return 1;
}

// ---------------------------------------------------------------- rarities --

/**
 * Rarity ladder. `power` scales base stats; `zPowerPerPull` is how much
 * limit-break material a duplicate yields; `unlockCost`/`starCosts` mirror the
 * genre-standard 7-star limit-break curve.
 */
const RARITIES = Object.freeze({
  HERO: {
    id: 'HERO', label: 'Hero', tier: 1, power: 1.0, zPowerPerPull: 200,
    unlockCost: 100, colour: '#9ca3af', accent: '#e5e7eb',
  },
  EXTREME: {
    id: 'EXTREME', label: 'Extreme', tier: 2, power: 1.28, zPowerPerPull: 500,
    unlockCost: 200, colour: '#38bdf8', accent: '#bae6fd',
  },
  SPARKING: {
    id: 'SPARKING', label: 'Sparking', tier: 3, power: 1.62, zPowerPerPull: 1200,
    unlockCost: 300, colour: '#f59e0b', accent: '#fde68a',
  },
  LEGENDS: {
    id: 'LEGENDS', label: 'Legends Limited', tier: 4, power: 1.92, zPowerPerPull: 1500,
    unlockCost: 400, colour: '#f43f5e', accent: '#fecdd3',
  },
  ULTRA: {
    id: 'ULTRA', label: 'Ultra', tier: 5, power: 2.25, zPowerPerPull: 2000,
    unlockCost: 500, colour: '#a855f7', accent: '#f3e8ff',
  },
});

/** Cumulative Z-Power required to reach each star (index 0 = unlock). */
const STAR_THRESHOLDS = [0, 500, 1500, 3500, 7000, 12000, 20000, 32000];

/** Per-star flat stat bonus (5% of base per star, matching the genre curve). */
const STAR_STAT_BONUS = 0.05;

// -------------------------------------------------------------------- tags --

/** Team-synergy tags. Z-Abilities buff fighters sharing a tag. */
const TAGS = Object.freeze([
  'Saiyan Blood', 'Guardian Clan', 'Frost Empire', 'Machine Legion', 'Djinn',
  'Time Patrol', 'Tournament', 'Fusion', 'Ascended', 'Rival', 'Regeneration',
  'Powerful Foe', 'Hero', 'Ancient', 'Corrupted', 'Youth', 'Elder', 'Outlaw',
]);

// --------------------------------------------------------------- arts cards --

/**
 * The five Arts types. `cost` is Ki; `combo` marks cards that chain.
 * These are the atoms of the card-battle layer.
 */
const ARTS = Object.freeze({
  STRIKE:  { id: 'STRIKE',  label: 'Strike',  cost: 15, colour: '#ff5d5d', icon: 'fist' },
  BLAST:   { id: 'BLAST',   label: 'Blast',   cost: 15, colour: '#4dabff', icon: 'orb' },
  SPECIAL: { id: 'SPECIAL', label: 'Special', cost: 30, colour: '#ffd23f', icon: 'star' },
  ULTIMATE:{ id: 'ULTIMATE',label: 'Ultimate',cost: 50, colour: '#c084fc', icon: 'burst' },
  AWAKEN:  { id: 'AWAKEN',  label: 'Awakened',cost: 0,  colour: '#34d399', icon: 'spiral' },
});

// ------------------------------------------------------ deterministic PRNG --

/**
 * xorshift32 seeded from a string. Deterministic across platforms and Node
 * versions — critical because fighter stats are derived from it.
 */
function seededRandom(seedText) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedText.length; i += 1) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = h || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;  state >>>= 0;
    return state / 4294967296;
  };
}

// ------------------------------------------------------------- vfx library --

/**
 * Signature-move visual effects. The client's canvas renderer reads these
 * descriptors to build particle systems, so a fighter's "animated ability" is
 * fully data-driven — no bespoke code per character.
 */
const VFX_STYLES = Object.freeze({
  BEAM:     { kind: 'beam',     particles: 220, shake: 14, flash: 0.85, duration: 1500 },
  BARRAGE:  { kind: 'barrage',  particles: 180, shake: 10, flash: 0.45, duration: 1400 },
  METEOR:   { kind: 'meteor',   particles: 260, shake: 18, flash: 0.9,  duration: 1650 },
  VORTEX:   { kind: 'vortex',   particles: 240, shake: 12, flash: 0.7,  duration: 1550 },
  SLASH:    { kind: 'slash',    particles: 140, shake: 16, flash: 0.75, duration: 1250 },
  NOVA:     { kind: 'nova',     particles: 320, shake: 22, flash: 1.0,  duration: 1800 },
  CHAIN:    { kind: 'chain',    particles: 200, shake: 11, flash: 0.6,  duration: 1450 },
  CRUSH:    { kind: 'crush',    particles: 210, shake: 20, flash: 0.8,  duration: 1500 },
  SPIRAL:   { kind: 'spiral',   particles: 230, shake: 13, flash: 0.72, duration: 1520 },
  ERUPTION: { kind: 'eruption', particles: 280, shake: 19, flash: 0.95, duration: 1700 },
});

const VFX_KEYS = Object.keys(VFX_STYLES);

// ------------------------------------------------------- ability templates --

/**
 * Ability effect vocabulary. Every entry is a pure data description that the
 * combat engine interprets — this is what lets 400+ fighters have genuinely
 * distinct kits without 400 bespoke code paths.
 */
const ABILITY_EFFECTS = [
  { key: 'dmgUp',        text: (v) => `+${v}% to damage inflicted`,                  range: [15, 60] },
  { key: 'dmgCut',       text: (v) => `Reduces damage received by ${v}%`,            range: [10, 40] },
  { key: 'kiRegen',      text: (v) => `+${v}% to Ki Recovery`,                       range: [15, 50] },
  { key: 'critRate',     text: (v) => `+${v}% to Critical Rate`,                     range: [10, 40] },
  { key: 'healOnEntry',  text: (v) => `Restores health by ${v}% on entry`,           range: [8, 25] },
  { key: 'drawSpeed',    text: (v) => `Increases Arts Card Draw Speed by ${v} level`,range: [1, 2] },
  { key: 'artsCostDown', text: (v) => `-${v} to Arts costs`,                         range: [3, 10] },
  { key: 'enemyKiDrain', text: (v) => `Reduces enemy Ki by ${v} on hit`,             range: [10, 40] },
  { key: 'vanishRegen',  text: (v) => `Restores Vanishing Gauge by ${v}%`,           range: [20, 70] },
  { key: 'subCountDown', text: (v) => `Shortens substitution count by ${v}`,         range: [1, 4] },
  { key: 'endurance',    text: (v) => `Survives a lethal hit with ${v}% health once`,range: [15, 40] },
  { key: 'strikeUp',     text: (v) => `+${v}% to Strike Arts damage`,                range: [20, 65] },
  { key: 'blastUp',      text: (v) => `+${v}% to Blast Arts damage`,                 range: [20, 65] },
  { key: 'ultimateUp',   text: (v) => `+${v}% to Ultimate damage`,                   range: [25, 80] },
  { key: 'cardDestroy',  text: (v) => `Destroys ${v} enemy Arts card(s)`,            range: [1, 2] },
  { key: 'sealArts',     text: (v) => `Seals an enemy Art for ${v} counts`,          range: [3, 6] },
];

const TRIGGERS = [
  { key: 'onEntry',      text: 'On battlefield entry' },
  { key: 'onArtsUse',    text: 'On Arts Card use' },
  { key: 'onVanish',     text: 'On Vanishing Step' },
  { key: 'onCoverChange',text: 'On cover change' },
  { key: 'onHit',        text: 'When hit by an enemy Arts attack' },
  { key: 'onCritical',   text: 'On landing a critical hit' },
  { key: 'onGaugeFull',  text: 'When the Unique Gauge is full' },
  { key: 'onAllyDown',   text: 'When an ally is defeated' },
  { key: 'battleStart',  text: 'From battle start' },
];

// ------------------------------------------------------------ move naming --

const MOVE_PREFIX = [
  'Crimson', 'Astral', 'Titan', 'Void', 'Solar', 'Glacial', 'Thunder', 'Phantom',
  'Radiant', 'Savage', 'Eternal', 'Rift', 'Blazing', 'Silent', 'Iron', 'Storm',
  'Ember', 'Frost', 'Obsidian', 'Celestial', 'Chaos', 'Prime', 'Echo', 'Twilight',
];
const MOVE_CORE = [
  'Cannon', 'Fang', 'Barrage', 'Lance', 'Crusher', 'Wave', 'Fist', 'Nova',
  'Spiral', 'Havoc', 'Verdict', 'Requiem', 'Impact', 'Rush', 'Edge', 'Storm',
  'Meteor', 'Vortex', 'Bolt', 'Sunder', 'Reaper', 'Bloom', 'Surge', 'Fury',
];
const MOVE_SUFFIX = ['', '', '', ' Zero', ' Omega', ' EX', ' Infinite', ' Prime', ' Final'];

// ---------------------------------------------------------------- lineages --

/**
 * Curated original cast. Each lineage has a base identity and a ladder of
 * transformations. `arch` drives the stat spread, `vfx` the signature effect,
 * `hue` the generated portrait palette.
 *
 * arch: BRAWLER (strike/HP), CANNON (blast/crit), BULWARK (defence/HP),
 *       DUELIST (balanced/crit), TRICKSTER (ki/utility)
 */
const LINEAGES = [
  // --- Saiyan-blood warriors -------------------------------------------------
  { key: 'kale',   name: 'Kalen',      tags: ['Saiyan Blood', 'Hero'],        arch: 'BRAWLER',  hue: 22,  vfx: 'METEOR',
    forms: ['Wanderer', 'Awakened', 'Ascendant', 'Ultra Instinct-Class'] },
  { key: 'brak',   name: 'Brakka',     tags: ['Saiyan Blood', 'Rival'],       arch: 'DUELIST',  hue: 265, vfx: 'BEAM',
    forms: ['Exile', 'Prideful', 'Royal Ascendant', 'Sovereign'] },
  { key: 'radi',   name: 'Radicchio',  tags: ['Saiyan Blood', 'Outlaw'],      arch: 'BRAWLER',  hue: 348, vfx: 'CRUSH',
    forms: ['Marauder', 'Berserk', 'Colossal'] },
  { key: 'sorr',   name: 'Sorrel',     tags: ['Saiyan Blood', 'Youth'],       arch: 'DUELIST',  hue: 200, vfx: 'SLASH',
    forms: ['Cadet', 'Blade Awakened', 'Future Scarred'] },
  { key: 'chard',  name: 'Chard',      tags: ['Saiyan Blood', 'Tournament'],  arch: 'BRAWLER',  hue: 45,  vfx: 'BARRAGE',
    forms: ['Contender', 'Unchained', 'Grand Champion'] },
  { key: 'daik',   name: 'Daikon',     tags: ['Saiyan Blood', 'Elder'],       arch: 'BULWARK',  hue: 12,  vfx: 'ERUPTION',
    forms: ['Veteran', 'Warlord', 'Primal Titan'] },
  { key: 'mizu',   name: 'Mizuna',     tags: ['Saiyan Blood', 'Hero'],        arch: 'CANNON',   hue: 300, vfx: 'NOVA',
    forms: ['Scout', 'Starlit', 'Supernova'] },
  { key: 'endi',   name: 'Endive',     tags: ['Saiyan Blood', 'Youth'],       arch: 'TRICKSTER',hue: 95,  vfx: 'SPIRAL',
    forms: ['Prodigy', 'Unleashed', 'Beyond Limit'] },
  { key: 'cass',   name: 'Cassava',    tags: ['Saiyan Blood', 'Powerful Foe'],arch: 'BRAWLER',  hue: 5,   vfx: 'CRUSH',
    forms: ['Destroyer', 'Wrathborn', 'World Ender'] },
  { key: 'kohl',   name: 'Kohlrabi',   tags: ['Saiyan Blood', 'Rival'],       arch: 'DUELIST',  hue: 210, vfx: 'CHAIN',
    forms: ['Mercenary', 'Bladelord', 'Apex Predator'] },

  // --- Guardian clan (regenerators / strategists) ---------------------------
  { key: 'verd',   name: 'Verdan',     tags: ['Guardian Clan', 'Regeneration'], arch: 'BULWARK', hue: 130, vfx: 'VORTEX',
    forms: ['Sentinel', 'Elder Fused', 'World Guardian'] },
  { key: 'sylv',   name: 'Sylvor',     tags: ['Guardian Clan', 'Ancient'],      arch: 'TRICKSTER',hue: 155, vfx: 'CHAIN',
    forms: ['Acolyte', 'Runeweaver', 'Grand Oracle'] },
  { key: 'thes',   name: 'Thessal',    tags: ['Guardian Clan', 'Hero'],         arch: 'BULWARK', hue: 168, vfx: 'ERUPTION',
    forms: ['Warden', 'Colossus', 'Living Fortress'] },
  { key: 'lore',   name: 'Loreth',     tags: ['Guardian Clan', 'Elder'],        arch: 'CANNON',  hue: 142, vfx: 'BEAM',
    forms: ['Scribe', 'Astral Sage'] },

  // --- Frost Empire (tyrants) -----------------------------------------------
  { key: 'glac',   name: 'Glacius',    tags: ['Frost Empire', 'Powerful Foe'], arch: 'CANNON',  hue: 285, vfx: 'BEAM',
    forms: ['Heir', 'Perfected', 'Golden Tyrant', 'Black Sovereign'] },
  { key: 'cryo',   name: 'Cryonn',     tags: ['Frost Empire', 'Corrupted'],    arch: 'DUELIST', hue: 195, vfx: 'SLASH',
    forms: ['Enforcer', 'Frostblade', 'Absolute Zero'] },
  { key: 'rime',   name: 'Rimeclaw',   tags: ['Frost Empire', 'Outlaw'],       arch: 'BRAWLER', hue: 185, vfx: 'BARRAGE',
    forms: ['Raider', 'Permafrost', 'Glacier King'] },
  { key: 'nive',   name: 'Nivalis',    tags: ['Frost Empire', 'Elder'],        arch: 'BULWARK', hue: 220, vfx: 'CRUSH',
    forms: ['Regent', 'Winter Eternal'] },

  // --- Machine Legion -------------------------------------------------------
  { key: 'u19',    name: 'Unit-19',    tags: ['Machine Legion', 'Corrupted'],  arch: 'BULWARK', hue: 190, vfx: 'CHAIN',
    forms: ['Prototype', 'Field Model', 'Omega Chassis'] },
  { key: 'ciph',   name: 'Cipher',     tags: ['Machine Legion', 'Time Patrol'],arch: 'TRICKSTER',hue: 172, vfx: 'VORTEX',
    forms: ['Analyst', 'Overclocked', 'Singularity'] },
  { key: 'vexx',   name: 'Vex',        tags: ['Machine Legion', 'Rival'],      arch: 'CANNON',  hue: 320, vfx: 'BEAM',
    forms: ['Sentry', 'Railgun Array', 'Annihilator'] },
  { key: 'gear',   name: 'Gearhart',   tags: ['Machine Legion', 'Hero'],       arch: 'BRAWLER', hue: 30,  vfx: 'CRUSH',
    forms: ['Mechanic', 'Powerframe', 'Titan Rig'] },
  { key: 'nexo',   name: 'Nexus-0',    tags: ['Machine Legion', 'Ancient'],    arch: 'DUELIST', hue: 260, vfx: 'SPIRAL',
    forms: ['Dormant', 'Awake', 'Absolute Core'] },

  // --- Djinn ----------------------------------------------------------------
  { key: 'djin',   name: 'Djinnara',   tags: ['Djinn', 'Regeneration'],        arch: 'BULWARK', hue: 330, vfx: 'ERUPTION',
    forms: ['Innocent', 'Ravenous', 'Pure Malice'] },
  { key: 'bubb',   name: 'Bubblor',    tags: ['Djinn', 'Youth'],               arch: 'TRICKSTER',hue: 310, vfx: 'VORTEX',
    forms: ['Playful', 'Distorted', 'Boundless'] },
  { key: 'morg',   name: 'Morgul',     tags: ['Djinn', 'Corrupted'],           arch: 'BRAWLER', hue: 290, vfx: 'CRUSH',
    forms: ['Shade', 'Devourer', 'Abyssal'] },

  // --- Time Patrol ----------------------------------------------------------
  { key: 'aeon',   name: 'Aeon',       tags: ['Time Patrol', 'Hero'],          arch: 'DUELIST', hue: 205, vfx: 'SPIRAL',
    forms: ['Recruit', 'Chronomancer', 'Paradox Warden'] },
  { key: 'tempo',  name: 'Tempora',    tags: ['Time Patrol', 'Ancient'],       arch: 'TRICKSTER',hue: 250, vfx: 'VORTEX',
    forms: ['Archivist', 'Loopbreaker', 'Eternity'] },
  { key: 'kair',   name: 'Kairos',     tags: ['Time Patrol', 'Rival'],         arch: 'CANNON',  hue: 275, vfx: 'NOVA',
    forms: ['Sentinel', 'Fracture', 'Endpoint'] },

  // --- Tournament fighters --------------------------------------------------
  { key: 'ryuk',   name: 'Ryuka',      tags: ['Tournament', 'Hero'],           arch: 'DUELIST', hue: 15,  vfx: 'SLASH',
    forms: ['Challenger', 'Bladesong', 'Sword Saint'] },
  { key: 'tiro',   name: 'Tiron',      tags: ['Tournament', 'Powerful Foe'],   arch: 'BULWARK', hue: 40,  vfx: 'CRUSH',
    forms: ['Brawler', 'Unbreakable', 'Immovable'] },
  { key: 'sena',   name: 'Senara',     tags: ['Tournament', 'Youth'],          arch: 'CANNON',  hue: 340, vfx: 'BARRAGE',
    forms: ['Striker', 'Stormcaller', 'Tempest Queen'] },
  { key: 'oros',   name: 'Oros',       tags: ['Tournament', 'Elder'],          arch: 'BRAWLER', hue: 55,  vfx: 'ERUPTION',
    forms: ['Master', 'Grandmaster'] },
  { key: 'jinn',   name: 'Jinnro',     tags: ['Tournament', 'Rival'],          arch: 'DUELIST', hue: 240, vfx: 'CHAIN',
    forms: ['Duelist', 'Perfect Form', 'Flawless'] },

  // --- Fusions --------------------------------------------------------------
  { key: 'kalb',   name: 'Kalbrak',    tags: ['Fusion', 'Saiyan Blood', 'Ascended'], arch: 'DUELIST', hue: 50, vfx: 'NOVA',
    forms: ['Fused', 'Ascended Fusion', 'Ultimate Fusion'] },
  { key: 'verth',  name: 'Verthess',   tags: ['Fusion', 'Guardian Clan'],      arch: 'BULWARK', hue: 150, vfx: 'ERUPTION',
    forms: ['Merged', 'Perfect Merge'] },
  { key: 'glacy',  name: 'Glacyon',    tags: ['Fusion', 'Frost Empire', 'Corrupted'], arch: 'CANNON', hue: 295, vfx: 'BEAM',
    forms: ['Amalgam', 'Absolute Amalgam'] },

  // --- Wildcards ------------------------------------------------------------
  { key: 'shal',   name: 'Solvane',    tags: ['Hero', 'Ancient', 'Ascended'],  arch: 'DUELIST', hue: 48,  vfx: 'NOVA',
    forms: ['Awakening', 'Trueborn', 'Radiant Ascendant', 'Origin'] },
  { key: 'umbr',   name: 'Umbryx',     tags: ['Corrupted', 'Powerful Foe'],    arch: 'CANNON',  hue: 278, vfx: 'VORTEX',
    forms: ['Shadow', 'Eclipse', 'Total Eclipse'] },
  { key: 'astra',  name: 'Astraea',    tags: ['Ancient', 'Hero'],              arch: 'TRICKSTER',hue: 190, vfx: 'BEAM',
    forms: ['Herald', 'Star Sovereign'] },
  { key: 'ferro',  name: 'Ferrox',     tags: ['Outlaw', 'Powerful Foe'],       arch: 'BRAWLER', hue: 8,   vfx: 'BARRAGE',
    forms: ['Bandit', 'Warboss', 'Doom Herald'] },
  { key: 'lumen',  name: 'Lumen',      tags: ['Hero', 'Youth'],                arch: 'CANNON',  hue: 60,  vfx: 'SPIRAL',
    forms: ['Spark', 'Brilliance', 'Zenith'] },
  { key: 'noct',   name: 'Nocturne',   tags: ['Corrupted', 'Outlaw'],          arch: 'DUELIST', hue: 268, vfx: 'SLASH',
    forms: ['Stalker', 'Nightfall', 'Endless Night'] },
  { key: 'terra',  name: 'Terrayn',    tags: ['Ancient', 'Guardian Clan'],     arch: 'BULWARK', hue: 100, vfx: 'CRUSH',
    forms: ['Stoneborn', 'Mountainheart', 'Continent'] },
  { key: 'zeph',   name: 'Zephyra',    tags: ['Hero', 'Tournament'],           arch: 'TRICKSTER',hue: 175, vfx: 'CHAIN',
    forms: ['Gale', 'Cyclone', 'Hurricane Sovereign'] },

  // --- Expanded cast: Saiyan-blood second generation -------------------------
  { key: 'okra',   name: 'Okrath',     tags: ['Saiyan Blood', 'Powerful Foe'], arch: 'BRAWLER', hue: 358, vfx: 'ERUPTION',
    forms: ['Conscript', 'Bloodroar', 'Warcry Ascendant', 'Ruin Incarnate'] },
  { key: 'yamm',   name: 'Yammi',      tags: ['Saiyan Blood', 'Youth'],        arch: 'TRICKSTER',hue: 88,  vfx: 'SPIRAL',
    forms: ['Sprout', 'Wildgrown', 'Verdant Ascendant'] },
  { key: 'punt',   name: 'Puntar',     tags: ['Saiyan Blood', 'Tournament'],   arch: 'DUELIST', hue: 28,  vfx: 'SLASH',
    forms: ['Gladiator', 'Arena King', 'Undefeated'] },
  { key: 'nira',   name: 'Nirena',     tags: ['Saiyan Blood', 'Hero'],         arch: 'CANNON',  hue: 315, vfx: 'BEAM',
    forms: ['Gunner', 'Starfall', 'Cosmic Lance'] },
  { key: 'gald',   name: 'Galdo',      tags: ['Saiyan Blood', 'Elder'],        arch: 'BULWARK', hue: 18,  vfx: 'CRUSH',
    forms: ['Guardian', 'Ironhide', 'Unyielding'] },

  // --- Guardian clan expansion ----------------------------------------------
  { key: 'moss',   name: 'Mossara',    tags: ['Guardian Clan', 'Regeneration'],arch: 'BULWARK', hue: 120, vfx: 'VORTEX',
    forms: ['Tender', 'Overgrowth', 'Worldroot'] },
  { key: 'cedr',   name: 'Cedrik',     tags: ['Guardian Clan', 'Hero'],        arch: 'DUELIST', hue: 138, vfx: 'SLASH',
    forms: ['Ranger', 'Thornblade', 'Wildking'] },
  { key: 'ivor',   name: 'Ivoryn',     tags: ['Guardian Clan', 'Ancient'],     arch: 'CANNON',  hue: 160, vfx: 'NOVA',
    forms: ['Seer', 'Lightbringer', 'Dawnbreaker'] },

  // --- Frost Empire expansion -----------------------------------------------
  { key: 'bore',   name: 'Boreas',     tags: ['Frost Empire', 'Powerful Foe'], arch: 'CANNON',  hue: 205, vfx: 'BEAM',
    forms: ['Lieutenant', 'Blizzard Lord', 'Endless Winter', 'Absolute Sovereign'] },
  { key: 'shiv',   name: 'Shivara',    tags: ['Frost Empire', 'Rival'],        arch: 'DUELIST', hue: 230, vfx: 'SLASH',
    forms: ['Assassin', 'Icefang', 'Silent Death'] },
  { key: 'perm',   name: 'Permyx',     tags: ['Frost Empire', 'Machine Legion'],arch:'BULWARK', hue: 198, vfx: 'CHAIN',
    forms: ['Cryo-Unit', 'Deepfreeze', 'Absolute Chassis'] },

  // --- Machine Legion expansion ---------------------------------------------
  { key: 'volt',   name: 'Voltrix',    tags: ['Machine Legion', 'Rival'],      arch: 'CANNON',  hue: 55,  vfx: 'CHAIN',
    forms: ['Capacitor', 'Arclight', 'Tesla Crown'] },
  { key: 'rust',   name: 'Rustbane',   tags: ['Machine Legion', 'Outlaw'],     arch: 'BRAWLER', hue: 25,  vfx: 'CRUSH',
    forms: ['Scrapper', 'Junklord', 'Scrapheap Titan'] },
  { key: 'quan',   name: 'Quanta',     tags: ['Machine Legion', 'Time Patrol'],arch: 'TRICKSTER',hue: 182, vfx: 'VORTEX',
    forms: ['Probe', 'Entangled', 'Superposition'] },
  { key: 'omeg',   name: 'Omega-Prime',tags: ['Machine Legion', 'Ancient'],    arch: 'BULWARK', hue: 268, vfx: 'ERUPTION',
    forms: ['Sealed', 'Reactivated', 'Total Dominion', 'Final Directive'] },

  // --- Djinn expansion --------------------------------------------------------
  { key: 'saff',   name: 'Saffrin',    tags: ['Djinn', 'Youth'],               arch: 'TRICKSTER',hue: 335, vfx: 'SPIRAL',
    forms: ['Whimsy', 'Trickster', 'Chaos Weaver'] },
  { key: 'grim',   name: 'Grimalka',   tags: ['Djinn', 'Corrupted'],           arch: 'BRAWLER', hue: 300, vfx: 'ERUPTION',
    forms: ['Hunger', 'Gluttony', 'All-Consuming'] },

  // --- Time Patrol expansion --------------------------------------------------
  { key: 'epoc',   name: 'Epocha',     tags: ['Time Patrol', 'Hero'],          arch: 'BULWARK', hue: 215, vfx: 'CHAIN',
    forms: ['Custodian', 'Timekeeper', 'Age Unending'] },
  { key: 'meri',   name: 'Meridian',   tags: ['Time Patrol', 'Ascended'],      arch: 'DUELIST', hue: 255, vfx: 'NOVA',
    forms: ['Divergent', 'Convergence', 'Absolute Now', 'Beyond Time'] },

  // --- Tournament expansion ---------------------------------------------------
  { key: 'bast',   name: 'Bastion',    tags: ['Tournament', 'Guardian Clan'],  arch: 'BULWARK', hue: 35,  vfx: 'CRUSH',
    forms: ['Defender', 'Aegis', 'Impenetrable'] },
  { key: 'kess',   name: 'Kessa',      tags: ['Tournament', 'Youth'],          arch: 'TRICKSTER',hue: 345, vfx: 'CHAIN',
    forms: ['Acrobat', 'Windstep', 'Blur'] },
  { key: 'drav',   name: 'Dravik',     tags: ['Tournament', 'Powerful Foe'],   arch: 'BRAWLER', hue: 10,  vfx: 'BARRAGE',
    forms: ['Bruiser', 'Ravager', 'Apex Brute'] },
  { key: 'lyra',   name: 'Lyrath',     tags: ['Tournament', 'Ancient'],        arch: 'CANNON',  hue: 288, vfx: 'BEAM',
    forms: ['Songkeeper', 'Resonance', 'Harmonic Zero'] },

  // --- Fusion expansion -------------------------------------------------------
  { key: 'aeku',   name: 'Aekair',     tags: ['Fusion', 'Time Patrol', 'Ascended'], arch: 'TRICKSTER', hue: 232, vfx: 'VORTEX',
    forms: ['Bonded', 'Perfect Bond', 'Infinite Bond'] },
  { key: 'ferrn',  name: 'Ferronoct',  tags: ['Fusion', 'Corrupted'],          arch: 'BRAWLER', hue: 282, vfx: 'CRUSH',
    forms: ['Grafted', 'Abomination', 'Nightmare Prime'] },

  // --- Additional wildcards ----------------------------------------------------
  { key: 'pyra',   name: 'Pyrahn',     tags: ['Powerful Foe', 'Ancient'],      arch: 'CANNON',  hue: 20,  vfx: 'ERUPTION',
    forms: ['Ember', 'Wildfire', 'Sunforge', 'Solar Cataclysm'] },
  { key: 'abys',   name: 'Abyssia',    tags: ['Corrupted', 'Regeneration'],    arch: 'BULWARK', hue: 272, vfx: 'VORTEX',
    forms: ['Drowned', 'Leviathan', 'Fathomless'] },
  { key: 'seren',  name: 'Serenya',    tags: ['Hero', 'Guardian Clan'],        arch: 'TRICKSTER',hue: 165, vfx: 'SPIRAL',
    forms: ['Healer', 'Lifewarden', 'Eternal Bloom'] },
  { key: 'korv',   name: 'Korvax',     tags: ['Outlaw', 'Machine Legion'],     arch: 'DUELIST', hue: 42,  vfx: 'SLASH',
    forms: ['Smuggler', 'Blade Runner', 'Ghost Protocol'] },
  { key: 'thal',   name: 'Thalos',     tags: ['Ancient', 'Powerful Foe'],      arch: 'BULWARK', hue: 108, vfx: 'CRUSH',
    forms: ['Sleeper', 'Awakened Colossus', 'Worldbreaker', 'Genesis'] },
  { key: 'vess',   name: 'Vesper',     tags: ['Hero', 'Rival'],                arch: 'DUELIST', hue: 248, vfx: 'CHAIN',
    forms: ['Nightwatch', 'Duskblade', 'Starless'] },
  { key: 'ignis',  name: 'Ignira',     tags: ['Tournament', 'Outlaw'],         arch: 'BRAWLER', hue: 14,  vfx: 'BARRAGE',
    forms: ['Firebrand', 'Inferno', 'Cinder Empress'] },
  { key: 'orac',   name: 'Oracle-9',   tags: ['Machine Legion', 'Ancient'],    arch: 'TRICKSTER',hue: 178, vfx: 'BEAM',
    forms: ['Query', 'Deep Compute', 'Omniscient'] },
  { key: 'mara',   name: 'Marauth',    tags: ['Powerful Foe', 'Corrupted'],    arch: 'CANNON',  hue: 306, vfx: 'NOVA',
    forms: ['Herald', 'Doomsayer', 'End of Days'] },
  { key: 'kyri',   name: 'Kyrion',     tags: ['Hero', 'Ascended'],             arch: 'DUELIST', hue: 52,  vfx: 'NOVA',
    forms: ['Squire', 'Knight Radiant', 'Dawnlord', 'Sunsovereign'] },
];

/** Base stat spreads per archetype (before rarity/form scaling). */
const ARCHETYPES = {
  BRAWLER:   { hp: 1.15, strike: 1.22, blast: 0.86, strDef: 1.08, blsDef: 0.94, crit: 0.95, ki: 0.95 },
  CANNON:    { hp: 0.90, strike: 0.85, blast: 1.30, strDef: 0.90, blsDef: 1.06, crit: 1.18, ki: 1.12 },
  BULWARK:   { hp: 1.32, strike: 1.00, blast: 0.95, strDef: 1.24, blsDef: 1.22, crit: 0.82, ki: 0.90 },
  DUELIST:   { hp: 1.02, strike: 1.10, blast: 1.10, strDef: 1.02, blsDef: 1.02, crit: 1.15, ki: 1.05 },
  TRICKSTER: { hp: 0.95, strike: 0.98, blast: 1.08, strDef: 0.98, blsDef: 1.04, crit: 1.10, ki: 1.30 },
};

/** Base stat magnitudes at level 1, rarity HERO, form 0. */
const BASE_STATS = { hp: 9200, strike: 1150, blast: 1150, strDef: 980, blsDef: 980, crit: 5, ki: 100 };

/**
 * Rarity assigned by position in the transformation ladder.
 *
 * Produces a proper collection pyramid: many Heroes and Extremes at the base,
 * a broad Sparking mid-tier (the workhorse rarity players actually build
 * teams from), and a deliberately scarce Legends/Ultra apex. Only the final
 * form of a *long* ladder (4+ forms) can reach the apex, and only a minority
 * of those become ULTRA.
 */
function rarityForForm(formIndex, formCount, lineageKey) {
  const isFinal = formIndex === formCount - 1;

  // Base form: always entry rarity.
  if (formIndex === 0) return formCount >= 4 ? 'EXTREME' : 'HERO';

  // Apex rarities are reserved for the final form of a 4+ form lineage.
  if (isFinal && formCount >= 4) {
    const rng = seededRandom(`ultra:${lineageKey}`);
    return rng() > 0.55 ? 'ULTRA' : 'LEGENDS';
  }

  // Final form of a 3-form lineage: a minority ascend to Legends Limited.
  if (isFinal && formCount === 3) {
    const rng = seededRandom(`legends:${lineageKey}`);
    return rng() > 0.80 ? 'LEGENDS' : 'SPARKING';
  }

  // Final form of a 2-form lineage: usually Extreme, occasionally Sparking.
  if (isFinal) {
    const rng = seededRandom(`spark2:${lineageKey}`);
    return rng() > 0.6 ? 'SPARKING' : 'EXTREME';
  }

  // Intermediate forms. Only the penultimate rung of a long ladder reaches
  // Sparking; everything below it is Extreme. This keeps Extreme as the
  // broad mid-game tier and Sparking as a genuine step up.
  return formIndex === formCount - 2 && formCount >= 4 ? 'SPARKING' : 'EXTREME';
}

/** Build a signature move name deterministically. */
function moveName(rng) {
  const p = MOVE_PREFIX[Math.floor(rng() * MOVE_PREFIX.length)];
  const c = MOVE_CORE[Math.floor(rng() * MOVE_CORE.length)];
  const s = MOVE_SUFFIX[Math.floor(rng() * MOVE_SUFFIX.length)];
  return `${p} ${c}${s}`;
}

/** Build an ability clause: trigger + 1-3 effects. */
function buildAbility(rng, tier, usedTriggers) {
  let trigger;
  let guard = 0;
  do {
    trigger = TRIGGERS[Math.floor(rng() * TRIGGERS.length)];
    guard += 1;
  } while (usedTriggers.has(trigger.key) && guard < 12);
  usedTriggers.add(trigger.key);

  const count = 1 + Math.floor(rng() * Math.min(3, 1 + tier / 2));
  const effects = [];
  const usedKeys = new Set();
  for (let i = 0; i < count; i += 1) {
    let template;
    let g = 0;
    do {
      template = ABILITY_EFFECTS[Math.floor(rng() * ABILITY_EFFECTS.length)];
      g += 1;
    } while (usedKeys.has(template.key) && g < 20);
    usedKeys.add(template.key);
    const [lo, hi] = template.range;
    // Higher rarity → values skew to the top of the range.
    const skew = 0.45 + 0.11 * tier;
    const raw = lo + (hi - lo) * Math.min(1, rng() * (1 - skew) + skew);
    const value = Math.max(lo, Math.round(raw));
    effects.push({ key: template.key, value, text: template.text(value) });
  }
  const duration = [0, 5, 10, 15, 20][Math.floor(rng() * 5)];
  return { trigger: trigger.key, triggerText: trigger.text, effects, duration };
}

/**
 * Build the complete fighter catalogue.
 * @returns {{fighters: object[], byId: Map<string, object>}}
 */
function buildCatalogue() {
  const fighters = [];

  for (const lineage of LINEAGES) {
    const formCount = lineage.forms.length;

    for (let formIndex = 0; formIndex < formCount; formIndex += 1) {
      const formLabel = lineage.forms[formIndex];
      const rarityId = rarityForForm(formIndex, formCount, lineage.key);
      const rarity = RARITIES[rarityId];

      // Two element variants per form (a "colour pair") expands the roster to
      // 400+ while giving players meaningful element-coverage choices.
      const variantCount = rarity.tier >= 4 ? 1 : 2;

      for (let variant = 0; variant < variantCount; variant += 1) {
        const id = `${lineage.key}-${formIndex}-${variant}`;
        const rng = seededRandom(`fighter:${id}`);

        // Element assignment.
        //
        // Dark and Light are intentionally scarce "special" elements, but they
        // must exist in large enough numbers to build a team around and to
        // populate the Eclipse banner. Ultra/Legends fighters of Ascended or
        // Hero lineages can be Radiant; Corrupted lineages skew Umbral.
        let element;
        const isApex = rarity.tier >= 4;
        const ascendedLike = lineage.tags.includes('Ascended') || lineage.tags.includes('Ancient');
        if (isApex && (ascendedLike || lineage.tags.includes('Hero')) && rng() > 0.45) {
          element = 'LIGHT';
        } else if (rarity.tier >= 3 && ascendedLike && rng() > 0.82) {
          element = 'LIGHT';
        } else if (lineage.tags.includes('Corrupted') && rng() > 0.55) {
          element = 'DARK';
        } else if (lineage.tags.includes('Powerful Foe') && rarity.tier >= 3 && rng() > 0.8) {
          element = 'DARK';
        } else {
          const offset = (lineage.key.charCodeAt(0) + formIndex * 2 + variant * 3) % 5;
          element = CORE_ELEMENTS[offset];
        }

        const arch = ARCHETYPES[lineage.arch];
        // Form scaling: each transformation adds ~11% power on top of rarity.
        const formScale = 1 + formIndex * 0.11;
        const variance = 0.94 + rng() * 0.12; // ±6% so no two fighters are clones
        const scale = rarity.power * formScale * variance;

        const stats = {
          hp:     Math.round(BASE_STATS.hp     * arch.hp     * scale / 10) * 10,
          strike: Math.round(BASE_STATS.strike * arch.strike * scale),
          blast:  Math.round(BASE_STATS.blast  * arch.blast  * scale),
          strDef: Math.round(BASE_STATS.strDef * arch.strDef * scale),
          blsDef: Math.round(BASE_STATS.blsDef * arch.blsDef * scale),
          crit:   Math.round(BASE_STATS.crit   * arch.crit   * (1 + rarity.tier * 0.14) * 10) / 10,
          kiRegen:Math.round(BASE_STATS.ki     * arch.ki     * (1 + rarity.tier * 0.05)) / 100,
        };

        const usedTriggers = new Set();
        const abilities = [];
        const abilityCount = Math.min(4, 1 + Math.floor(rarity.tier * 0.85));
        for (let i = 0; i < abilityCount; i += 1) {
          abilities.push(buildAbility(rng, rarity.tier, usedTriggers));
        }

        const vfxKey = formIndex === formCount - 1
          ? lineage.vfx
          : VFX_KEYS[Math.floor(rng() * VFX_KEYS.length)];

        // Hue drifts across the transformation ladder so forms read as an
        // evolving palette rather than recolours.
        const hue = (lineage.hue + formIndex * 14 + variant * 24) % 360;

        const zAbilityStat = ['strike', 'blast', 'strDef', 'blsDef', 'hp'][Math.floor(rng() * 5)];
        const zAbilityTag = lineage.tags[Math.floor(rng() * lineage.tags.length)];

        fighters.push({
          id,
          lineage: lineage.key,
          name: lineage.name,
          form: formLabel,
          /** Full display name, e.g. "Ascendant Kalen". */
          title: formIndex === 0 ? lineage.name : `${formLabel} ${lineage.name}`,
          rarity: rarityId,
          element,
          tags: lineage.tags,
          archetype: lineage.arch,
          stats,
          /** Signature moves rendered by the client's particle engine. */
          moves: {
            special:  { name: moveName(rng), arts: 'SPECIAL',  vfx: vfxKey, power: 1.9 + rarity.tier * 0.16 },
            ultimate: { name: moveName(rng), arts: 'ULTIMATE', vfx: lineage.vfx, power: 3.4 + rarity.tier * 0.3 },
          },
          mainAbility: {
            name: moveName(rng),
            /** Timer counts that must elapse before it can be used. */
            requires: 12 + Math.floor(rng() * 14),
            effects: buildAbility(rng, rarity.tier, new Set()).effects,
          },
          abilities,
          uniqueGauge: {
            name: ['Rage', 'Focus', 'Momentum', 'Resolve', 'Overdrive'][Math.floor(rng() * 5)],
            chargePerArts: 12 + Math.floor(rng() * 14),
            fullEffects: buildAbility(rng, rarity.tier, new Set()).effects,
          },
          zAbility: {
            stat: zAbilityStat,
            tag: zAbilityTag,
            /** Percentage buff at each star tier (index = stars). */
            tiers: [10, 12, 15, 18, 20, 22, 25, 28].map((v) => Math.round(v * (0.8 + rarity.tier * 0.1))),
          },
          art: {
            hue,
            /** Secondary hue used for the aura gradient. */
            hue2: (hue + 40 + rarity.tier * 12) % 360,
            aura: ELEMENTS[element].hex,
            /** Deterministic seed the client uses to draw the portrait. */
            seed: id,
            /** Silhouette archetype for the generated portrait. */
            build: lineage.arch,
            /** Visual intensity of the idle aura. */
            intensity: Math.min(1, 0.35 + rarity.tier * 0.16),
          },
          lore: `${formLabel} ${lineage.name} — a ${ELEMENTS[element].label.toLowerCase()} ` +
                `${lineage.arch.toLowerCase()} of the ${lineage.tags[0]} lineage.`,
        });
      }
    }
  }

  const byId = new Map(fighters.map((f) => [f.id, f]));
  return { fighters, byId };
}

const CATALOGUE = buildCatalogue();

// ----------------------------------------------------------------- banners --

/**
 * Summon banners.
 *
 * Rates mirror the genre standard so the experience is authentic, but this
 * build is 100% free: crystals are earned generously and the Legends Pass is
 * permanently granted to every account (see economy.js).
 */
function buildBanners() {
  const ultras = CATALOGUE.fighters.filter((f) => f.rarity === 'ULTRA');
  const legends = CATALOGUE.fighters.filter((f) => f.rarity === 'LEGENDS');
  const sparking = CATALOGUE.fighters.filter((f) => f.rarity === 'SPARKING');

  /** Deterministically pick `n` featured fighters for a banner. */
  const pickFeatured = (pool, n, seed) => {
    const rng = seededRandom(seed);
    const shuffled = pool.slice().sort((a, b) => a.id.localeCompare(b.id));
    const chosen = [];
    while (chosen.length < n && shuffled.length > 0) {
      chosen.push(shuffled.splice(Math.floor(rng() * shuffled.length), 1)[0]);
    }
    return chosen.map((f) => f.id);
  };

  return [
    {
      id: 'legendary-rising',
      name: 'LEGENDARY RISING',
      subtitle: 'Featured Ultra + Legends Limited',
      description: 'The flagship banner. Boosted odds on the newest Ultra-rarity fighters.',
      featured: [...pickFeatured(ultras, 2, 'banner:ultra'), ...pickFeatured(legends, 2, 'banner:ll')],
      /** Probability weights, summing to 1. */
      rates: { ULTRA: 0.005, LEGENDS: 0.015, SPARKING: 0.05, EXTREME: 0.22, HERO: 0.71 },
      /** Portion of a rarity's probability reserved for featured fighters. */
      featuredShare: 0.55,
      accent: '#a855f7',
      art: 'nova',
    },
    {
      id: 'ascension',
      name: 'ASCENSION SUMMON',
      subtitle: 'Sparking rate boosted',
      description: 'Higher Sparking odds and a guaranteed Extreme-or-better every multi.',
      featured: pickFeatured(sparking, 4, 'banner:spark'),
      rates: { ULTRA: 0.002, LEGENDS: 0.01, SPARKING: 0.09, EXTREME: 0.28, HERO: 0.618 },
      featuredShare: 0.5,
      accent: '#f59e0b',
      art: 'spiral',
    },
    {
      id: 'vanguard',
      name: 'VANGUARD BEACON',
      subtitle: 'Guardian & Machine focus',
      description: 'Tag-focused banner for defensive team cores.',
      featured: pickFeatured(
        CATALOGUE.fighters.filter(
          (f) => f.rarity !== 'HERO' && (f.tags.includes('Guardian Clan') || f.tags.includes('Machine Legion'))
        ), 4, 'banner:vanguard'
      ),
      rates: { ULTRA: 0.003, LEGENDS: 0.012, SPARKING: 0.07, EXTREME: 0.26, HERO: 0.655 },
      featuredShare: 0.6,
      accent: '#3ddc84',
      art: 'chain',
    },
    {
      id: 'eclipse',
      name: 'ECLIPSE PROTOCOL',
      subtitle: 'Dark & Light element focus',
      description: 'The only banner featuring Umbral and Radiant element fighters.',
      featured: pickFeatured(
        CATALOGUE.fighters.filter((f) => f.element === 'DARK' || f.element === 'LIGHT'), 4, 'banner:eclipse'
      ),
      rates: { ULTRA: 0.006, LEGENDS: 0.014, SPARKING: 0.06, EXTREME: 0.24, HERO: 0.68 },
      featuredShare: 0.65,
      accent: '#8b5cf6',
      art: 'vortex',
    },
  ];
}

const BANNERS = buildBanners();

// ------------------------------------------------------------------ stages --

/**
 * Story + challenge stages. Each references catalogue fighters for its enemy
 * team and scales their level, producing a smooth difficulty ramp.
 */
function buildStages() {
  const stages = [];
  const chapters = [
    { key: 'ch1', name: 'The Fractured Sky',   theme: 'plains',    entries: 8,  baseLevel: 4 },
    { key: 'ch2', name: 'Ashfall Wastes',      theme: 'volcano',   entries: 8,  baseLevel: 14 },
    { key: 'ch3', name: 'The Frost Citadel',   theme: 'glacier',   entries: 8,  baseLevel: 26 },
    { key: 'ch4', name: 'Machine Depths',      theme: 'foundry',   entries: 8,  baseLevel: 40 },
    { key: 'ch5', name: 'The Void Between',    theme: 'void',      entries: 8,  baseLevel: 56 },
    { key: 'ch6', name: 'Origin Point',        theme: 'celestial', entries: 8,  baseLevel: 72 },
  ];

  const pool = CATALOGUE.fighters.slice().sort((a, b) => a.id.localeCompare(b.id));

  for (const chapter of chapters) {
    for (let i = 0; i < chapter.entries; i += 1) {
      const rng = seededRandom(`stage:${chapter.key}:${i}`);
      const isBoss = i === chapter.entries - 1;
      const level = chapter.baseLevel + i * 2 + (isBoss ? 6 : 0);
      const tierFloor = isBoss ? 3 : Math.min(3, 1 + Math.floor(i / 3));
      const candidates = pool.filter((f) => RARITIES[f.rarity].tier >= tierFloor);
      const team = [];
      while (team.length < 3) {
        const pick = candidates[Math.floor(rng() * candidates.length)];
        if (!team.includes(pick.id)) team.push(pick.id);
      }
      stages.push({
        id: `${chapter.key}-${i + 1}`,
        chapter: chapter.key,
        chapterName: chapter.name,
        theme: chapter.theme,
        index: i + 1,
        name: isBoss ? `${chapter.name}: Confrontation` : `${chapter.name} ${i + 1}`,
        isBoss,
        level,
        enemyTeam: team,
        staminaCost: isBoss ? 8 : 5,
        rewards: {
          zeni: 600 + level * 45,
          crystals: isBoss ? 150 : 35,
          xp: 220 + level * 30,
          souls: isBoss ? 40 : 12,
        },
        /** First-clear-only bonus, mirroring genre convention. */
        firstClear: { crystals: isBoss ? 300 : 75, souls: isBoss ? 60 : 20 },
      });
    }
  }
  return stages;
}

const STAGES = buildStages();

// ---------------------------------------------------------------- missions --

/** Daily and career missions that keep the free economy flowing. */
const MISSIONS = Object.freeze([
  { id: 'daily-login',   scope: 'daily',  name: 'Report for Duty',      target: 1,   metric: 'logins',       reward: { crystals: 150, zeni: 3000 } },
  { id: 'daily-battle3', scope: 'daily',  name: 'Three Skirmishes',     target: 3,   metric: 'battlesWon',   reward: { crystals: 120, zeni: 4000 } },
  { id: 'daily-summon',  scope: 'daily',  name: 'Call the Vanguard',    target: 1,   metric: 'summons',      reward: { crystals: 100, souls: 25 } },
  { id: 'daily-upgrade', scope: 'daily',  name: 'Sharpen the Blade',    target: 1,   metric: 'upgrades',     reward: { crystals: 80,  souls: 30 } },
  { id: 'daily-rising',  scope: 'daily',  name: 'Unleash a Rising Rush',target: 1,   metric: 'risingRush',   reward: { crystals: 130, zeni: 2500 } },
  { id: 'career-win10',  scope: 'career', name: 'Proven Fighter',       target: 10,  metric: 'battlesWon',   reward: { crystals: 500,  souls: 100 } },
  { id: 'career-win50',  scope: 'career', name: 'Battle-Hardened',      target: 50,  metric: 'battlesWon',   reward: { crystals: 1200, souls: 250 } },
  { id: 'career-win200', scope: 'career', name: 'Living Legend',        target: 200, metric: 'battlesWon',   reward: { crystals: 4000, souls: 800 } },
  { id: 'career-roster25',scope:'career', name: 'Gathering Allies',     target: 25,  metric: 'rosterSize',   reward: { crystals: 800,  souls: 150 } },
  { id: 'career-roster100',scope:'career',name: 'Master Collector',     target: 100, metric: 'rosterSize',   reward: { crystals: 3000, souls: 600 } },
  { id: 'career-story',  scope: 'career', name: 'Story Complete',       target: 48,  metric: 'stagesCleared',reward: { crystals: 5000, souls: 1000 } },
]);

module.exports = {
  ELEMENTS,
  CORE_ELEMENTS,
  elementMultiplier,
  RARITIES,
  STAR_THRESHOLDS,
  STAR_STAT_BONUS,
  TAGS,
  ARTS,
  VFX_STYLES,
  ARCHETYPES,
  LINEAGES,
  CATALOGUE,
  BANNERS,
  STAGES,
  MISSIONS,
  seededRandom,
  buildCatalogue,
};
