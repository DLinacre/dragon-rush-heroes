/**
 * ============================================================================
 * DEMO API SHIM  ·  static-hosting fallback
 * ============================================================================
 *
 * GitHub Pages cannot run the Node backend, so this shim intercepts `fetch()`
 * for `/api/*` and answers from `localStorage` instead. The presentation layer
 * (views, portrait renderer, VFX engine) is completely untouched — it cannot
 * tell the difference.
 *
 * ⚠️  SECURITY NOTE — READ THIS
 * In the real deployment the server is authoritative: it owns the RNG, the
 * combat maths and the currency ledger, so a modified client cannot fabricate
 * results. In this static demo there is no server, therefore **the demo is
 * trivially cheatable from devtools**. That is an accepted, documented
 * trade-off for a zero-cost playable marketing build. Never treat demo state
 * as authoritative, and never reuse this file in production.
 *
 * The shim deliberately implements a REDUCED rule set: it drives the real UI
 * for summoning, roster, progression and battles, but the deep combat engine
 * (ability triggers, Unique Gauge, Z-Abilities) lives on the server. Battles
 * here use a faithful but simplified resolver.
 */
(function installDemoApi() {
  'use strict';

  const STORE_KEY = 'drh_demo_state_v1';
  const nativeFetch = window.fetch.bind(window);

  /** Banner is signalled to the UI so it can show a demo notice. */
  window.__DRH_DEMO__ = true;

  let CATALOGUE = null;
  let byId = new Map();

  /* ------------------------------------------------------------- storage */

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* corrupted or unavailable */ }
    return null;
  }

  function save(state) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* quota */ }
  }

  /* --------------------------------------------------------------- utils */

  const uid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  /** Mulberry32 — small, fast, seedable PRNG for the demo's rolls. */
  function rng32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = rng32(Date.now());

  const STAR_THRESHOLDS = [0, 500, 1500, 3500, 7000, 12000, 20000, 32000];
  const starsFor = (z) => {
    let s = 0;
    for (let i = 1; i < STAR_THRESHOLDS.length; i += 1) if (z >= STAR_THRESHOLDS[i]) s = i;
    return s;
  };
  const maxLevelForStars = (s) => [40, 50, 60, 70, 80, 90, 100, 110][Math.min(7, s)];
  const xpForLevel = (l) => Math.round(420 * Math.pow(l, 1.42) + 180 * l);
  const trainingCost = (level, rarity) => {
    const tier = CATALOGUE.rarities[rarity].tier;
    return Math.round((320 + level * 145) * (0.85 + tier * 0.18));
  };

  /* ------------------------------------------------------- state factory */

  function freshState(displayName) {
    const now = new Date().toISOString();
    const econ = CATALOGUE.economy;
    return {
      user: { id: uid('usr_'), email: 'demo@local', createdAt: now },
      profile: {
        id: uid('ply_'), displayName, level: 1, xp: 0,
        crystals: econ.founderGrant, zeni: 500000, souls: 5000,
        pass: {
          active: true, tier: 'LEGENDS_PASS_FREE', grantedAt: now, expiresAt: null,
          perks: [
            'Unlimited stamina — no energy gates, ever',
            'Double Zeni and Souls from every battle',
            '+2 daily summon tickets',
            'Instant training (no timers)',
            'All story chapters unlocked from day one',
          ],
        },
        stamina: { current: 999, max: 999, unlimited: true, lastTickAt: now },
        pity: { sinceSparking: 0, sinceLegends: 0 },
        summonNonce: 0,
        clientSeed: uid('seed_'),
        counters: {
          logins: 1, battlesWon: 0, battlesPlayed: 0, summons: 0,
          upgrades: 0, risingRush: 0, rosterSize: 0, stagesCleared: 0,
        },
        claimedMissions: {}, clearedStages: {},
        settings: {
          reducedMotion: false, screenShake: true, damageNumbers: true,
          autoAdvance: false, soundEnabled: true, theme: 'nebula',
        },
        createdAt: now, updatedAt: now,
      },
      roster: [], teams: [], ledger: [], summons: [], battle: null,
    };
  }

  /* -------------------------------------------------------------- gacha */

  function rollRarity(banner, pity) {
    if (pity.sinceLegends >= CATALOGUE.economy.pityLegends) {
      return rand() < 0.22 ? 'ULTRA' : 'LEGENDS';
    }
    if (pity.sinceSparking >= CATALOGUE.economy.pitySparking) {
      const r = rand();
      return r < 0.04 ? 'ULTRA' : r < 0.16 ? 'LEGENDS' : 'SPARKING';
    }
    let roll = rand();
    for (const [rarity, rate] of Object.entries(banner.rates)) {
      roll -= rate;
      if (roll <= 0) return rarity;
    }
    return 'HERO';
  }

  function performSummon(state, bannerId, count) {
    const banner = CATALOGUE.banners.find((b) => b.id === bannerId);
    if (!banner) return { error: { code: 'NOT_FOUND', message: 'Unknown banner.' } };
    const cost = count === 1
      ? CATALOGUE.economy.summonCostSingle
      : CATALOGUE.economy.summonCostMulti;
    if (state.profile.crystals < cost) {
      return {
        error: {
          code: 'INSUFFICIENT_CRYSTALS',
          message: `You need ${cost.toLocaleString()} Chrono Crystals for this summon.`,
          details: { required: cost, balance: state.profile.crystals },
        },
      };
    }

    const results = [];
    const pity = state.profile.pity;
    for (let i = 0; i < count; i += 1) {
      const lastOfMulti = count === 10 && i === 9;
      const noneYet = !results.some((r) => CATALOGUE.rarities[r.rarity].tier >= 3);
      let rarity = (lastOfMulti && noneYet) ? 'SPARKING' : rollRarity(banner, pity);

      const pool = CATALOGUE.fighters.filter((f) => f.rarity === rarity);
      const featured = pool.filter((f) => banner.featured.includes(f.id));
      const useFeatured = featured.length > 0 && rand() < banner.featuredShare * 0 + 0.55;
      const from = useFeatured ? featured : (pool.length ? pool : featured);
      const fighter = from[Math.floor(rand() * from.length)];
      if (!fighter) continue;

      if (CATALOGUE.rarities[rarity].tier >= 3) pity.sinceSparking = 0; else pity.sinceSparking += 1;
      if (CATALOGUE.rarities[rarity].tier >= 4) pity.sinceLegends = 0; else pity.sinceLegends += 1;

      const zPower = CATALOGUE.rarities[rarity].zPowerPerPull;
      const existing = state.roster.find((r) => r.fighterId === fighter.id);
      let isNew = false, total = zPower, starsGained = 0;
      if (existing) {
        const before = starsFor(existing.zPower);
        existing.zPower += zPower;
        existing.stars = starsFor(existing.zPower);
        total = existing.zPower;
        starsGained = existing.stars - before;
      } else {
        isNew = true;
        const stars = starsFor(zPower);
        starsGained = stars;
        state.roster.push({
          id: uid('rst_'), fighterId: fighter.id, level: 1,
          zPower, stars, soulBoosts: {}, acquiredAt: new Date().toISOString(),
        });
      }

      results.push({
        fighterId: fighter.id, title: fighter.title, rarity,
        element: fighter.element, featured: banner.featured.includes(fighter.id),
        pityApplied: null, zPower, zPowerTotal: total, stars: starsFor(total),
        starsGained, isNew, art: fighter.art,
      });
    }

    state.profile.crystals -= cost;
    state.profile.summonNonce += 1;
    state.profile.counters.summons += count;
    state.profile.counters.rosterSize = state.roster.length;
    state.ledger.unshift({
      id: uid('lg_'), playerId: state.profile.id, currency: 'crystals',
      delta: -cost, balanceAfter: state.profile.crystals,
      reason: count === 1 ? 'summon_single' : 'summon_multi',
      refId: bannerId, createdAt: new Date().toISOString(),
    });

    return {
      results, crystals: state.profile.crystals, pity,
      verification: {
        serverSeedHash: 'demo-build-no-server-seed',
        clientSeed: state.profile.clientSeed,
        nonce: state.profile.summonNonce,
        algorithm: 'DEMO BUILD — rolls are client-side and NOT provably fair.',
      },
      roster: decorateRoster(state),
    };
  }

  /* ------------------------------------------------------------- roster */

  function computeStats(def, entry) {
    const levelScale = 1 + (entry.level - 1) * 0.062;
    const starScale = 1 + entry.stars * 0.05;
    const scale = levelScale * starScale;
    const b = entry.soulBoosts || {};
    return {
      hp: Math.round(def.stats.hp * scale + (b.hp ?? 0) * 260),
      strike: Math.round(def.stats.strike * scale + (b.strike ?? 0) * 42),
      blast: Math.round(def.stats.blast * scale + (b.blast ?? 0) * 42),
      strDef: Math.round(def.stats.strDef * scale + (b.strDef ?? 0) * 34),
      blsDef: Math.round(def.stats.blsDef * scale + (b.blsDef ?? 0) * 34),
      crit: Math.min(60, def.stats.crit + entry.stars * 0.7 + (b.crit ?? 0) * 0.5),
      kiRegen: def.stats.kiRegen,
    };
  }

  function decorateEntry(entry) {
    const def = byId.get(entry.fighterId);
    if (!def) return { ...entry, missing: true };
    const stats = computeStats(def, entry);
    const stars = entry.stars;
    const floor = STAR_THRESHOLDS[stars];
    const ceiling = STAR_THRESHOLDS[stars + 1];
    return {
      ...entry,
      title: def.title, rarity: def.rarity, element: def.element,
      tags: def.tags, archetype: def.archetype, art: def.art, moves: def.moves,
      stats,
      power: Math.round(stats.hp * 0.32 + stats.strike * 1.5 + stats.blast * 1.5 +
                        stats.strDef * 0.9 + stats.blsDef * 0.9 + stats.crit * 90),
      starProgress: ceiling === undefined
        ? { stars, next: null, current: entry.zPower, required: null, percent: 100 }
        : { stars, next: stars + 1, current: entry.zPower - floor,
            required: ceiling - floor,
            percent: Math.round(((entry.zPower - floor) / (ceiling - floor)) * 100) },
      maxLevel: maxLevelForStars(stars),
      nextTrainingCost: entry.level < maxLevelForStars(stars)
        ? trainingCost(entry.level, def.rarity) : null,
    };
  }

  const decorateRoster = (state) => state.roster.map(decorateEntry);

  /* ------------------------------------------------------------ battles */

  const ELEMENT_BEATS = { RED: 'YELLOW', YELLOW: 'PURPLE', PURPLE: 'GREEN', GREEN: 'BLUE', BLUE: 'RED' };
  function elementMultiplier(a, d) {
    if (a === d) return 1;
    if (a === 'DARK') return d === 'LIGHT' ? 0.65 : 1.5;
    if (a === 'LIGHT') return d === 'DARK' ? 1.5 : 1;
    if (d === 'DARK') return a === 'LIGHT' ? 1.5 : 0.65;
    if (d === 'LIGHT') return 1;
    if (ELEMENT_BEATS[a] === d) return 1.5;
    if (ELEMENT_BEATS[d] === a) return 0.65;
    return 1;
  }

  const HAND = 4, MAX_KI = 100, ORBS = 7, SUB_START = 4;
  const ARTS_COST = { STRIKE: 15, BLAST: 15, SPECIAL: 30, ULTIMATE: 50, AWAKEN: 0 };

  function makeCombatant(fighterId, entry, forcedLevel) {
    const def = byId.get(fighterId);
    const e = forcedLevel != null
      ? { level: forcedLevel, stars: Math.min(7, Math.floor(forcedLevel / 18)), soulBoosts: {} }
      : entry;
    const stats = computeStats(def, e);
    return {
      fighterId, name: def.title, element: def.element, rarity: def.rarity,
      level: e.level, stars: e.stars, stats, maxHp: stats.hp, hp: stats.hp,
      ki: 50, vanish: 100, substitution: SUB_START, gauge: 0,
      gaugeName: def.uniqueGauge.name, alive: true, art: def.art, buffs: [],
      mainAbility: { name: def.mainAbility.name, requires: def.mainAbility.requires, used: false },
      def,
    };
  }

  function drawCard(c, seq) {
    const w = [['STRIKE', 34], ['BLAST', 34], ['SPECIAL', 20], ['ULTIMATE', 9], ['AWAKEN', 3]];
    const total = w.reduce((s, x) => s + x[1], 0);
    let r = rand() * total, arts = 'STRIKE';
    for (const [a, wt] of w) { r -= wt; if (r <= 0) { arts = a; break; } }
    return {
      uid: `c${seq}`, arts, label: CATALOGUE.arts[arts].label, cost: ARTS_COST[arts],
      colour: CATALOGUE.arts[arts].colour, icon: CATALOGUE.arts[arts].icon,
      moveName: arts === 'SPECIAL' ? c.def.moves.special.name
        : arts === 'ULTIMATE' ? c.def.moves.ultimate.name
        : arts === 'AWAKEN' ? c.def.mainAbility.name : null,
      vfx: arts === 'SPECIAL' ? c.def.moves.special.vfx
        : arts === 'ULTIMATE' ? c.def.moves.ultimate.vfx : null,
    };
  }

  function view(b) {
    const strip = (c) => ({
      fighterId: c.fighterId, name: c.name, element: c.element, rarity: c.rarity,
      level: c.level, stars: c.stars, hp: c.hp, maxHp: c.maxHp, ki: c.ki, maxKi: MAX_KI,
      vanish: c.vanish, maxVanish: 100, substitution: c.substitution, gauge: c.gauge,
      gaugeName: c.gaugeName, alive: c.alive, art: c.art, buffs: [],
      mainAbility: c.mainAbility,
    });
    return {
      status: b.status, winner: b.winner, count: b.count, mode: b.mode,
      stageId: b.stageId, comboIndex: b.comboIndex,
      player: {
        members: b.player.members.map(strip), active: b.player.active,
        hand: b.player.hand, rushOrbs: b.player.rushOrbs,
        risingRushReady: b.player.rushOrbs >= ORBS,
      },
      enemy: {
        members: b.enemy.members.map(strip), active: b.enemy.active,
        handCount: b.enemy.hand.length, rushOrbs: b.enemy.rushOrbs,
        risingRushReady: b.enemy.rushOrbs >= ORBS,
      },
    };
  }

  const activeOf = (b, side) => b[side].members[b[side].active];

  function damage(b, side, card, rush) {
    const A = activeOf(b, side);
    const D = activeOf(b, side === 'player' ? 'enemy' : 'player');
    const blast = card.arts !== 'STRIKE';
    const atk = blast ? A.stats.blast : A.stats.strike;
    const dfn = blast ? D.stats.blsDef : D.stats.strDef;
    const power = { STRIKE: 1, BLAST: 1.05, SPECIAL: A.def.moves.special.power,
                    ULTIMATE: A.def.moves.ultimate.power, AWAKEN: 1.2 }[card.arts] ?? 1;
    let dmg = atk * (atk / (atk + dfn * 0.86)) * power * 0.92;
    const el = elementMultiplier(A.element, D.element);
    dmg *= el;
    dmg *= 1 + (b.comboIndex ?? 0) * 0.16;
    const crit = rand() * 100 < A.stats.crit;
    if (crit) dmg *= 1.65;
    if (rush) dmg *= 6.2;
    dmg *= 0.96 + rand() * 0.08;
    return {
      amount: Math.max(1, Math.round(dmg)), critical: crit,
      element: el > 1 ? 'advantage' : el < 1 ? 'resisted' : 'neutral',
    };
  }

  function applyDamage(b, side, res, events, meta) {
    const foe = side === 'player' ? 'enemy' : 'player';
    const D = activeOf(b, foe);
    const before = D.hp;
    D.hp = Math.max(0, D.hp - res.amount);
    events.push({
      type: 'damage', side, attackerId: activeOf(b, side).fighterId,
      defenderId: D.fighterId, amount: res.amount, critical: res.critical,
      element: res.element, hpBefore: before, hpAfter: D.hp, maxHp: D.maxHp, ...meta,
    });
    if (D.hp === 0 && D.alive) {
      D.alive = false;
      events.push({ type: 'ko', side: foe, fighterId: D.fighterId });
      const next = b[foe].members.findIndex((m) => m.alive);
      if (next !== -1) {
        b[foe].active = next;
        b[foe].members[next].substitution = SUB_START;
        events.push({ type: 'switch', side: foe, fighterId: b[foe].members[next].fighterId, forced: true });
        b[foe].hand = [];
        while (b[foe].hand.length < HAND) b[foe].hand.push(drawCard(activeOf(b, foe), b.seq++));
      }
    }
  }

  function tick(b, n, events) {
    b.count += n;
    for (const side of ['player', 'enemy']) {
      for (const m of b[side].members) {
        if (!m.alive) continue;
        m.ki = Math.min(MAX_KI, Math.round(m.ki + 8 * n * m.stats.kiRegen));
        m.vanish = Math.min(100, m.vanish + 12 * n);
        m.substitution = Math.max(0, m.substitution - n);
      }
    }
    events.push({ type: 'tick', count: b.count });
  }

  function grantOrb(b, side, events) {
    if (b[side].rushOrbs >= ORBS) return;
    b[side].rushOrbs += 1;
    events.push({ type: 'rush_orb', side, total: b[side].rushOrbs });
    if (b[side].rushOrbs === ORBS) events.push({ type: 'rising_rush_ready', side });
  }

  function checkEnd(b, events) {
    if (b.status !== 'active') return;
    const pDown = b.player.members.every((m) => !m.alive);
    const eDown = b.enemy.members.every((m) => !m.alive);
    if (pDown || eDown) {
      b.status = 'complete';
      b.winner = eDown && !pDown ? 'player' : 'enemy';
      events.push({ type: 'battle_end', winner: b.winner, counts: b.count });
    }
  }

  function enemyTurn(b) {
    const events = [];
    if (b.status !== 'active') return events;
    const ai = activeOf(b, 'enemy');
    if (!ai?.alive) return events;
    if (b.enemy.rushOrbs >= ORBS) {
      b.enemy.rushOrbs = 0;
      events.push({ type: 'rising_rush', side: 'enemy', fighterId: ai.fighterId,
        team: b.enemy.members.filter((m) => m.alive).map((m) => ({
          fighterId: m.fighterId, name: m.name, element: m.element, art: m.art })) });
      applyDamage(b, 'enemy', damage(b, 'enemy', { arts: 'ULTIMATE' }, true), events,
        { arts: 'RISING_RUSH', moveName: 'RISING RUSH', vfx: 'NOVA' });
      tick(b, 2, events); checkEnd(b, events); return events;
    }
    const card = b.enemy.hand.find((c) => ai.ki >= c.cost);
    if (card) {
      ai.ki -= card.cost;
      b.enemy.hand.splice(b.enemy.hand.indexOf(card), 1);
      events.push({ type: 'card_play', side: 'enemy', fighterId: ai.fighterId,
        arts: card.arts, moveName: card.moveName, vfx: card.vfx, comboIndex: 0 });
      applyDamage(b, 'enemy', damage(b, 'enemy', card, false), events,
        { arts: card.arts, moveName: card.moveName, vfx: card.vfx });
      const orbs = card.arts === 'ULTIMATE' ? 2 : card.arts === 'SPECIAL' ? 1 : (rand() > 0.45 ? 1 : 0);
      for (let i = 0; i < orbs; i += 1) grantOrb(b, 'enemy', events);
      while (b.enemy.hand.length < HAND) b.enemy.hand.push(drawCard(ai, b.seq++));
      tick(b, 1, events);
    } else {
      ai.ki = Math.min(MAX_KI, ai.ki + 25);
      events.push({ type: 'charge', side: 'enemy', fighterId: ai.fighterId });
      tick(b, 2, events);
    }
    checkEnd(b, events);
    return events;
  }

  /* --------------------------------------------------------- API router */

  const json = (data, status = 200) =>
    new Response(JSON.stringify(status >= 400 ? data : { data }), {
      status, headers: { 'Content-Type': 'application/json' },
    });

  async function route(method, path, body) {
    let state = load();

    if (path === '/api/health') {
      return json({ status: 'healthy', env: 'demo', uptime: 0, version: 'demo', collections: {} });
    }
    if (path === '/api/catalogue') return json(CATALOGUE);
    if (path === '/api/fairness') {
      return json({ serverSeedHash: 'demo-build-no-server-seed',
        algorithm: 'DEMO BUILD — rolls are client-side and NOT provably fair.',
        note: 'The hosted demo has no server. Run the full build for verifiable summons.' });
    }

    if (path === '/api/auth/session') {
      return json(state ? { authenticated: true, user: state.user } : { authenticated: false });
    }
    if (path === '/api/auth/register' || path === '/api/auth/login') {
      const name = (body && body.displayName) ? body.displayName : (state?.profile.displayName || 'Demo Player');
      if (!state || path === '/api/auth/register') state = freshState(name);
      save(state);
      return json({ user: state.user, player: state.profile, csrfToken: 'demo' },
        path === '/api/auth/register' ? 201 : 200);
    }
    if (path === '/api/auth/logout') { return json({ loggedOut: true }); }

    if (!state) return json({ error: { code: 'UNAUTHORIZED', message: 'Start a demo session first.' } }, 401);

    if (path === '/api/player' && method === 'GET') {
      const roster = decorateRoster(state);
      const counters = { ...state.profile.counters, rosterSize: roster.length };
      return json({
        profile: { ...state.profile, xpForNext: xpForLevel(state.profile.level) },
        roster, teams: state.teams,
        activeBattleId: state.battle ? state.battle.id : null,
        missions: CATALOGUE.missions.map((m) => {
          const progress = Math.min(counters[m.metric] ?? 0, m.target);
          const complete = progress >= m.target;
          return { ...m, progress, complete,
            claimed: Boolean(state.profile.claimedMissions[m.id]),
            claimable: complete && !state.profile.claimedMissions[m.id] };
        }),
        fairness: { serverSeedHash: 'demo-build-no-server-seed',
          clientSeed: state.profile.clientSeed, nonce: state.profile.summonNonce },
      });
    }

    if (path === '/api/player/settings' && method === 'PATCH') {
      Object.assign(state.profile.settings, body || {});
      save(state);
      return json({ settings: state.profile.settings });
    }
    if (path === '/api/player/profile' && method === 'PATCH') {
      if (body && body.displayName) state.profile.displayName = body.displayName;
      save(state);
      return json({ displayName: state.profile.displayName });
    }
    if (path.startsWith('/api/player/ledger')) return json({ entries: state.ledger.slice(0, 50) });
    if (path === '/api/player/export') return json({ exportedAt: new Date().toISOString(), ...state });
    if (path === '/api/player' && method === 'DELETE') {
      localStorage.removeItem(STORE_KEY);
      return json({ deleted: true });
    }

    if (path === '/api/summon' && method === 'POST') {
      const out = performSummon(state, body.bannerId, body.count);
      if (out.error) return json(out, out.error.code === 'NOT_FOUND' ? 404 : 422);
      save(state);
      return json(out);
    }
    if (path === '/api/summon/history') return json({ entries: state.summons.slice(0, 30) });
    if (path === '/api/summon/rotate-seed' && method === 'POST') {
      state.profile.clientSeed = uid('seed_');
      state.profile.summonNonce = 0;
      save(state);
      return json({ clientSeed: state.profile.clientSeed, nonce: 0,
        serverSeedHash: 'demo-build-no-server-seed' });
    }

    if (path === '/api/roster/train' && method === 'POST') {
      const e = state.roster.find((r) => r.fighterId === body.fighterId);
      if (!e) return json({ error: { code: 'NOT_FOUND', message: 'You do not own that fighter.' } }, 404);
      const def = byId.get(e.fighterId);
      const cap = maxLevelForStars(e.stars);
      if (e.level >= cap) {
        return json({ error: { code: 'LEVEL_CAPPED',
          message: `This fighter is capped at level ${cap}. Limit break to raise the cap.` } }, 422);
      }
      let spent = 0, gained = 0;
      for (let i = 0; i < (body.levels || 1) && e.level < cap; i += 1) {
        const step = trainingCost(e.level, def.rarity);
        if (state.profile.zeni - spent < step) break;
        spent += step; e.level += 1; gained += 1;
      }
      if (!gained) return json({ error: { code: 'INSUFFICIENT_ZENI', message: 'Not enough Zeni.' } }, 422);
      state.profile.zeni -= spent;
      state.profile.counters.upgrades += 1;
      save(state);
      return json({ entry: decorateEntry(e), levelsGained: gained, zeni: state.profile.zeni });
    }

    if (path === '/api/roster/soul-boost' && method === 'POST') {
      const e = state.roster.find((r) => r.fighterId === body.fighterId);
      if (!e) return json({ error: { code: 'NOT_FOUND', message: 'You do not own that fighter.' } }, 404);
      const def = byId.get(e.fighterId);
      const tier = CATALOGUE.rarities[def.rarity].tier;
      e.soulBoosts = e.soulBoosts || {};
      const cur = e.soulBoosts[body.stat] ?? 0;
      const cap = 20 + e.stars * 5;
      if (cur >= cap) return json({ error: { code: 'INSUFFICIENT_SOULS', message: 'Stat already maxed.' } }, 422);
      const cost = Math.round((45 + cur * 22) * (0.9 + tier * 0.12));
      if (state.profile.souls < cost) {
        return json({ error: { code: 'INSUFFICIENT_SOULS', message: 'Not enough Souls.' } }, 422);
      }
      state.profile.souls -= cost;
      e.soulBoosts[body.stat] = cur + 1;
      state.profile.counters.upgrades += 1;
      save(state);
      return json({ entry: decorateEntry(e), pointsGained: 1, souls: state.profile.souls });
    }

    if (path === '/api/teams' && method === 'PUT') {
      const i = state.teams.findIndex((t) => t.slotIndex === body.slotIndex);
      const team = { id: uid('tm_'), slotIndex: body.slotIndex, name: body.name, members: body.members };
      if (i >= 0) state.teams[i] = team; else state.teams.push(team);
      save(state);
      return json({ team, teams: state.teams });
    }

    if (path === '/api/battles' && method === 'POST') {
      const stage = CATALOGUE.stages.find((s) => s.id === body.stageId);
      if (!stage) return json({ error: { code: 'NOT_FOUND', message: 'Stage not found.' } }, 404);
      if (state.battle && state.battle.status === 'active') {
        return json({ error: { code: 'BATTLE_IN_PROGRESS', message: 'Battle already running.',
          details: { battleId: state.battle.id } } }, 409);
      }
      const b = {
        id: uid('bt_'), status: 'active', winner: null, count: 0, seq: 1,
        comboIndex: 0, mode: 'story', stageId: stage.id,
        player: {
          members: body.members.map((fid) =>
            makeCombatant(fid, state.roster.find((r) => r.fighterId === fid))),
          active: 0, hand: [], rushOrbs: 0,
        },
        enemy: {
          members: stage.enemyTeam.map((fid) => makeCombatant(fid, null, stage.level)),
          active: 0, hand: [], rushOrbs: 0,
        },
      };
      while (b.player.hand.length < HAND) b.player.hand.push(drawCard(activeOf(b, 'player'), b.seq++));
      while (b.enemy.hand.length < HAND) b.enemy.hand.push(drawCard(activeOf(b, 'enemy'), b.seq++));
      state.battle = b;
      state.profile.counters.battlesPlayed += 1;
      save(state);
      return json({ battleId: b.id, stage, state: view(b),
        events: [{ type: 'battle_start', mode: 'story', stageId: stage.id }],
        stamina: state.profile.stamina }, 201);
    }

    const bm = path.match(/^\/api\/battles\/([^/]+)(\/action|\/forfeit)?$/);
    if (bm) {
      const b = state.battle;
      if (!b || b.id !== bm[1]) return json({ error: { code: 'NOT_FOUND', message: 'Battle not found.' } }, 404);

      if (!bm[2] && method === 'GET') {
        return json({ battleId: b.id, stage: CATALOGUE.stages.find((s) => s.id === b.stageId), state: view(b) });
      }
      if (bm[2] === '/forfeit') {
        b.status = 'forfeit'; b.winner = 'enemy'; state.battle = null; save(state);
        return json({ forfeited: true });
      }

      // ---- action ----
      const events = [];
      const A = activeOf(b, 'player');
      const act = body.action;
      if (act === 'card') {
        const idx = b.player.hand.findIndex((c) => c.uid === body.cardUid);
        if (idx === -1) return json({ error: { code: 'CARD_NOT_IN_HAND', message: 'Card gone.' } }, 422);
        const card = b.player.hand[idx];
        if (A.ki < card.cost) return json({ error: { code: 'INSUFFICIENT_KI', message: 'Not enough Ki.' } }, 422);
        A.ki -= card.cost;
        b.player.hand.splice(idx, 1);
        events.push({ type: 'card_play', side: 'player', fighterId: A.fighterId,
          arts: card.arts, moveName: card.moveName, vfx: card.vfx, comboIndex: b.comboIndex });
        applyDamage(b, 'player', damage(b, 'player', card, false), events,
          { arts: card.arts, moveName: card.moveName, vfx: card.vfx });
        const orbs = card.arts === 'ULTIMATE' ? 2 : card.arts === 'SPECIAL' ? 1 : (rand() > 0.45 ? 1 : 0);
        for (let i = 0; i < orbs; i += 1) grantOrb(b, 'player', events);
        if (['STRIKE', 'BLAST', 'SPECIAL'].includes(card.arts) && b.comboIndex < 2) b.comboIndex += 1;
        else { b.comboIndex = 0; tick(b, 1, events); }
        while (b.player.hand.length < HAND) b.player.hand.push(drawCard(activeOf(b, 'player'), b.seq++));
      } else if (act === 'vanish') {
        if (A.vanish < 50) return json({ error: { code: 'VANISH_NOT_READY', message: 'Gauge not charged.' } }, 422);
        A.vanish -= 50; b.comboIndex = 0;
        events.push({ type: 'vanish', side: 'player', fighterId: A.fighterId });
        tick(b, 1, events);
      } else if (act === 'charge') {
        A.ki = Math.min(MAX_KI, A.ki + 25);
        A.vanish = Math.min(100, A.vanish + 25);
        b.comboIndex = 0;
        events.push({ type: 'charge', side: 'player', fighterId: A.fighterId });
        tick(b, 2, events);
      } else if (act === 'switch') {
        const t = b.player.members[body.slot];
        if (!t) return json({ error: { code: 'INVALID_SLOT', message: 'Empty slot.' } }, 422);
        if (!t.alive) return json({ error: { code: 'FIGHTER_DEFEATED', message: 'Defeated.' } }, 422);
        if (A.substitution > 0) return json({ error: { code: 'SUB_COOLDOWN', message: 'Cover change on cooldown.' } }, 422);
        A.substitution = SUB_START;
        b.player.active = body.slot;
        b.comboIndex = 0;
        events.push({ type: 'switch', side: 'player', fighterId: t.fighterId, forced: false });
        b.player.hand = [];
        while (b.player.hand.length < HAND) b.player.hand.push(drawCard(t, b.seq++));
        tick(b, 1, events);
      } else if (act === 'rising_rush') {
        if (b.player.rushOrbs < ORBS) return json({ error: { code: 'RUSH_NOT_READY', message: 'Need 7 Rush Orbs.' } }, 422);
        b.player.rushOrbs = 0;
        events.push({ type: 'rising_rush', side: 'player', fighterId: A.fighterId,
          team: b.player.members.filter((m) => m.alive).map((m) => ({
            fighterId: m.fighterId, name: m.name, element: m.element, art: m.art })) });
        applyDamage(b, 'player', damage(b, 'player', { arts: 'ULTIMATE' }, true), events,
          { arts: 'RISING_RUSH', moveName: 'RISING RUSH', vfx: 'NOVA' });
        b.comboIndex = 0; tick(b, 2, events);
      } else if (act === 'main_ability') {
        if (A.mainAbility.used) return json({ error: { code: 'ABILITY_USED', message: 'Already used.' } }, 422);
        if (b.count < A.mainAbility.requires) {
          return json({ error: { code: 'ABILITY_NOT_READY', message: 'Not available yet.' } }, 422);
        }
        A.mainAbility.used = true;
        A.ki = Math.min(MAX_KI, A.ki + 40);
        events.push({ type: 'main_ability', side: 'player', fighterId: A.fighterId,
          name: A.mainAbility.name, effects: [] });
        tick(b, 1, events);
      }
      checkEnd(b, events);

      if (b.status === 'active' && b.comboIndex === 0) events.push(...enemyTurn(b));

      let rewards = null;
      if (b.status === 'complete') {
        const stage = CATALOGUE.stages.find((s) => s.id === b.stageId);
        const won = b.winner === 'player';
        if (won) {
          const first = !state.profile.clearedStages[stage.id];
          const crystals = stage.rewards.crystals + (first ? stage.firstClear.crystals : 0);
          const zeni = stage.rewards.zeni * 2;
          const souls = (stage.rewards.souls + (first ? stage.firstClear.souls : 0)) * 2;
          const xp = stage.rewards.xp;
          state.profile.crystals += crystals;
          state.profile.zeni += zeni;
          state.profile.souls += souls;
          state.profile.xp += xp;
          while (state.profile.xp >= xpForLevel(state.profile.level)) {
            state.profile.xp -= xpForLevel(state.profile.level);
            state.profile.level += 1;
          }
          state.profile.counters.battlesWon += 1;
          if (first) {
            state.profile.clearedStages[stage.id] = new Date().toISOString();
            state.profile.counters.stagesCleared = Object.keys(state.profile.clearedStages).length;
          }
          state.ledger.unshift({ id: uid('lg_'), currency: 'crystals', delta: crystals,
            balanceAfter: state.profile.crystals,
            reason: first ? 'stage_first_clear' : 'stage_clear',
            refId: stage.id, createdAt: new Date().toISOString() });
          rewards = { won: true, crystals, zeni, souls, xp, firstClear: first,
            level: state.profile.level, totalCrystals: state.profile.crystals };
        } else {
          rewards = { won: false, crystals: 0, zeni: 0, souls: 0, xp: 0, firstClear: false };
        }
        state.battle = null;
      }
      save(state);
      return json({ state: view(b), events, rewards });
    }

    if (path === '/api/missions/claim' && method === 'POST') {
      const m = CATALOGUE.missions.find((x) => x.id === body.missionId);
      if (!m) return json({ error: { code: 'NOT_FOUND', message: 'Unknown mission.' } }, 404);
      if (state.profile.claimedMissions[m.id]) {
        return json({ error: { code: 'ALREADY_CLAIMED', message: 'Already claimed.' } }, 409);
      }
      const counters = { ...state.profile.counters, rosterSize: state.roster.length };
      if ((counters[m.metric] ?? 0) < m.target) {
        return json({ error: { code: 'MISSION_INCOMPLETE', message: 'Not complete yet.' } }, 422);
      }
      state.profile.crystals += m.reward.crystals ?? 0;
      state.profile.zeni += m.reward.zeni ?? 0;
      state.profile.souls += m.reward.souls ?? 0;
      state.profile.claimedMissions[m.id] = new Date().toISOString();
      save(state);
      return json({ mission: m.id, reward: m.reward, crystals: state.profile.crystals,
        zeni: state.profile.zeni, souls: state.profile.souls,
        missions: CATALOGUE.missions.map((x) => {
          const progress = Math.min(counters[x.metric] ?? 0, x.target);
          const complete = progress >= x.target;
          return { ...x, progress, complete,
            claimed: Boolean(state.profile.claimedMissions[x.id]),
            claimable: complete && !state.profile.claimedMissions[x.id] };
        }) });
    }

    return json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint (demo build).' } }, 404);
  }

  /* -------------------------------------------------------- interception */

  window.fetch = async function demoFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];

    if (!path.startsWith('/api/')) return nativeFetch(input, init);

    if (!CATALOGUE) {
      const res = await nativeFetch('./data/catalogue.json');
      CATALOGUE = await res.json();
      byId = new Map(CATALOGUE.fighters.map((f) => [f.id, f]));
    }

    const method = (init.method || (typeof input === 'object' ? input.method : 'GET') || 'GET').toUpperCase();
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch { body = null; } }

    // Small delay so loading states render naturally.
    await new Promise((r) => setTimeout(r, 40));
    try {
      return await route(method, path, body);
    } catch (err) {
      return json({ error: { code: 'DEMO_ERROR', message: err.message } }, 500);
    }
  };

  // Auto-start a demo session so visitors land straight in the game.
  window.addEventListener('DOMContentLoaded', () => {
    if (!load()) {
      // Seeded on first interaction by the auth view; nothing to do here.
    }
  });
})();
