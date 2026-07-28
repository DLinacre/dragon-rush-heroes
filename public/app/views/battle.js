/**
 * ============================================================================
 * BATTLE ARENA
 * ============================================================================
 *
 * Two responsibilities:
 *
 *  1. STAGE SELECT — pick a chapter/stage and a team of three.
 *  2. LIVE ARENA   — render the authoritative battle state and play back the
 *                    server's event timeline as animation.
 *
 * Event playback is the heart of it. The server returns an ordered list of
 * events (`card_play`, `damage`, `ko`, `rising_rush`, …). The arena walks that
 * list with per-event delays, firing VFX, floating numbers and gauge tweens so
 * the fight *reads* as a fight rather than a state diff. Input is locked while
 * a sequence plays, then unlocked when the timeline drains.
 */

import { el, mount, num, compact, toast, sleep, confirmDialog, ELEMENT_GLYPH } from '../core/ui.js';
import { store, applyPlayerState } from '../core/store.js';
import { lazyPortrait, renderPortrait } from '../core/portrait.js';
import { VFXEngine } from '../core/vfx.js';
import { api, ApiError } from '../core/api.js';
import { reportQuiet, ignoreExpected } from '../core/errors.js';
import { track, trackOnce, EVENTS } from '../core/analytics.js';

/**
 * Normalised stage anchor points.
 *
 * The player stands front-left and lower on the screen, the enemy back-right
 * and higher — a shallow diagonal that reads as depth on the ground plane and
 * keeps both sprites clear of the HUD and the card dock.
 */
const ANCHOR = {
  player: { x: 0.28, y: 0.52 },
  enemy: { x: 0.72, y: 0.33 },
};

/** Map an element id to a particle hue. */
const ELEMENT_HUE = {
  RED: 2, YELLOW: 46, PURPLE: 276, GREEN: 145, BLUE: 208, DARK: 268, LIGHT: 48,
};

/* ========================================================================== */
/*  STAGE SELECT                                                              */
/* ========================================================================== */

export function renderBattle(host, navigate) {
  const catalogue = store.get('catalogue');
  const profile = store.get('profile');
  const roster = store.get('roster') ?? [];

  if (!catalogue || !profile) {
    mount(host, el('div.center-load', {}, [el('div.spinner')]));
    return;
  }

  // Resume an interrupted battle if one exists.
  const activeId = store.get('activeBattleId');
  if (activeId) {
    (async () => {
      try {
        const payload = await api.getBattle(activeId);
        openArena(payload.battleId, payload.stage, payload.state, [], navigate);
      } catch (err) {
        // The stored battle id is stale (expired, forfeited elsewhere).
        // Expected after a server restart — clear it and re-render.
        ignoreExpected('stale activeBattleId; falling back to stage select');
        store.set({ activeBattleId: null });
        renderBattle(host, navigate);
      }
    })();
    mount(host, el('div.center-load', {}, [el('div.spinner'), el('p.muted', { text: 'Resuming battle…' })]));
    return;
  }

  if (roster.length === 0) {
    mount(host, el('div.view.view-enter', {}, [
      el('div.panel', { style: { textAlign: 'center', padding: '48px 24px' } }, [
        el('h2.h2', { text: 'No fighters yet' }),
        el('p.muted', { text: 'Summon a team before entering battle.', style: { margin: '8px 0 18px' } }),
        el('button.btn.btn-primary', { text: 'Go to Summon', onClick: () => navigate('summon') }),
      ]),
    ]));
    return;
  }

  // Chapters derived from the stage list.
  const chapters = [];
  for (const stage of catalogue.stages) {
    let chapter = chapters.find((c) => c.key === stage.chapter);
    if (!chapter) {
      chapter = { key: stage.chapter, name: stage.chapterName, stages: [] };
      chapters.push(chapter);
    }
    chapter.stages.push(stage);
  }

  let selectedChapter = chapters[0];
  // Default the team to the three strongest owned fighters.
  let team = roster.slice().sort((a, b) => b.power - a.power).slice(0, 3).map((r) => r.fighterId);

  const body = el('div');

  function draw() {
    const cleared = profile.clearedStages ?? {};

    const chapterTabs = el('div', {
      style: { display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '6px', marginBottom: '14px' },
    }, chapters.map((c) =>
      el('button.btn.btn-sm', {
        text: c.name,
        class: c.key === selectedChapter.key ? 'btn-primary' : 'btn-ghost',
        style: { whiteSpace: 'nowrap', flex: '0 0 auto' },
        onClick: () => { selectedChapter = c; draw(); },
      })
    ));

    const stageList = el('div', {
      style: { display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))' },
    }, selectedChapter.stages.map((stage) => {
      const isCleared = Boolean(cleared[stage.id]);
      return el('button', {
        style: {
          textAlign: 'left', padding: '12px 14px',
          background: stage.isBoss
            ? 'linear-gradient(135deg, rgba(244,63,94,.16), var(--bg-deep))'
            : 'var(--bg-panel)',
          border: `1px solid ${stage.isBoss ? 'rgba(244,63,94,.42)' : 'var(--line)'}`,
          borderRadius: 'var(--r-md)', cursor: 'pointer', width: '100%',
        },
        onClick: () => startBattle(stage),
      }, [
        el('div.row', {}, [
          el('span', {
            text: stage.name,
            style: { fontSize: '13.5px', fontWeight: '650', color: stage.isBoss ? '#fb7185' : 'var(--ink)' },
          }),
          el('div.spacer'),
          isCleared ? el('span', { text: '✓', style: { color: 'var(--jade)', fontWeight: '700' } }) : null,
        ]),
        el('div.row', { style: { marginTop: '6px', gap: '10px' } }, [
          el('span.tiny.mono', { text: `Lv ${stage.level}` }),
          el('span.tiny', { text: `💎 ${stage.rewards.crystals}` }),
          el('span.tiny', { text: `⬢ ${num(stage.rewards.zeni)}` }),
        ]),
        // UX-2: surface the enemy elements at the point of decision. Teams
        // were previously assembled blind, which made the element wheel —
        // the core strategic system — pure guesswork.
        el('div.row', {
          style: { marginTop: '6px', gap: '6px', alignItems: 'center' },
          'aria-label': 'Enemy elements: ' + stage.enemyTeam
            .map((id) => catalogue.elements[catalogue.byId.get(id)?.element]?.label)
            .filter(Boolean).join(', '),
        }, [
          el('span.tiny', { text: 'Enemy:', style: { color: 'var(--ink-dim)' } }),
          ...stage.enemyTeam.map((id) => {
            const def = catalogue.byId.get(id);
            if (!def) return null;
            const c = catalogue.elements[def.element].hex;
            return el('span.el-glyph', {
              text: ELEMENT_GLYPH[def.element] ?? '',
              style: { color: c, fontSize: '12px' },
              'aria-hidden': 'true',
            });
          }),
        ]),
      ]);
    }));

    // Team picker.
    const teamSlots = el('div.row', { style: { gap: '8px', flexWrap: 'wrap' } },
      [0, 1, 2].map((i) => {
        const fighterId = team[i];
        const entry = roster.find((r) => r.fighterId === fighterId);
        const canvas = el('canvas', { style: { width: '100%', height: '100%' } });
        if (entry) lazyPortrait(canvas, entry.art, entry.title);
        // The slot's only child is a canvas, which contributes no accessible
        // name — state it explicitly (WCAG 4.1.2 Name, Role, Value).
        return el('button', {
          'aria-label': entry
            ? `Team slot ${i + 1}: ${entry.title}. Activate to change fighter.`
            : `Team slot ${i + 1}: empty. Activate to choose a fighter.`,
          style: {
            width: '78px', height: '96px', borderRadius: 'var(--r-md)',
            border: `1.5px solid ${entry ? 'var(--gold)' : 'var(--line)'}`,
            overflow: 'hidden', background: 'var(--bg-deep)',
            position: 'relative', cursor: 'pointer', flex: '0 0 auto',
          },
          onClick: () => pickFighter(i),
        }, entry ? [canvas] : [el('span', { text: '+', 'aria-hidden': 'true', style: { fontSize: '24px', color: 'var(--ink-dim)' } })]);
      })
    );

    /** Fighter chooser for a team slot. */
    function pickFighter(slot) {
      const list = roster.slice().sort((a, b) => b.power - a.power);
      const gridEl = el('div.grid.grid-auto', { style: { maxHeight: '52vh', overflowY: 'auto' } },
        list.map((entry) => {
          const canvas = el('canvas');
          lazyPortrait(canvas, entry.art, entry.title);
          const inTeam = team.includes(entry.fighterId) && team[slot] !== entry.fighterId;
          return el('div.fcard', {
            class: inTeam ? 'dim' : '',
            role: 'button',
            tabindex: '0',
            'aria-label': `${entry.title}, ${entry.rarity}, level ${entry.level}` +
              (inTeam ? ' (already on the team)' : ''),
            onClick: () => {
              if (inTeam) { toast('Already on the team.', 'err'); return; }
              team[slot] = entry.fighterId;
              dialog.close();
              draw();
            },
          }, [
            el('div.fcard-art', {}, [canvas, el(`div.fcard-rarity.r-${entry.rarity}`)]),
            el('div.fcard-body', {}, [
              el('div.fcard-name', { text: entry.title }),
              el('div.fcard-meta', {}, [
                el('span.fcard-stars', { text: '★'.repeat(entry.stars) || '☆' }),
                el('span.fcard-lvl', { text: `Lv${entry.level}` }),
              ]),
            ]),
          ]);
        })
      );
      const dialog = modalWrap(`Choose fighter for slot ${slot + 1}`, gridEl);
    }

    async function startBattle(stage) {
      const members = team.filter(Boolean);
      if (members.length === 0) { toast('Pick at least one fighter.', 'err'); return; }
      try {
        trackOnce(EVENTS.FIRST_BATTLE);
        const payload = await api.startBattle(stage.id, members);
        store.set({ activeBattleId: payload.battleId });
        openArena(payload.battleId, payload.stage, payload.state, payload.events, navigate);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'BATTLE_IN_PROGRESS') {
          store.set({ activeBattleId: err.details.battleId });
          renderBattle(host, navigate);
          return;
        }
        toast(err.message, 'err');
      }
    }

    const teamPower = team
      .filter(Boolean)
      .reduce((sum, id) => sum + (roster.find((r) => r.fighterId === id)?.power ?? 0), 0);

    mount(body,
      el('div.panel', { style: { marginBottom: '16px' } }, [
        el('div.section-head', {}, [
          el('h3.h3', { text: 'Your team' }),
          el('span.mono.tiny', { text: `Power ${compact(teamPower)}` }),
        ]),
        teamSlots,
        el('p.tiny', { text: 'Tap a slot to swap fighters. Element coverage wins fights.', style: { marginTop: '10px' } }),
      ]),
      chapterTabs,
      stageList
    );
  }

  draw();
  mount(host, el('div.view.view-enter', {}, [
    el('div.section-head', {}, [
      el('div', {}, [
        el('h1.h1', { text: 'Battle' }),
        el('p.muted', { text: 'Unlimited stamina — play as long as you like.' }),
      ]),
    ]),
    body,
  ]));
}

/** Minimal modal helper local to this module (avoids a circular import). */
function modalWrap(title, content) {
  const backdrop = el('div.modal-back');
  const panel = el('div.modal', { style: { width: 'min(860px, 100%)' } }, [
    el('div.modal-head', {}, [
      el('h2.h2', { text: title }),
      el('div.spacer'),
      el('button.icon-btn', { text: '✕', onClick: () => close() }),
    ]),
    el('div.modal-body', {}, [content]),
  ]);
  backdrop.append(panel);
  document.body.append(backdrop);
  function close() { backdrop.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  return { close };
}

/* ========================================================================== */
/*  LIVE ARENA                                                                */
/* ========================================================================== */

/**
 * Open the full-screen arena.
 *
 * @param {string} battleId
 * @param {object} stage
 * @param {object} initialState
 * @param {object[]} initialEvents
 * @param {Function} navigate
 */
export function openArena(battleId, stage, initialState, initialEvents, navigate) {
  const catalogue = store.get('catalogue');
  const settings = store.get('profile')?.settings ?? {};

  let state = initialState;
  let locked = false;   // true while an event timeline is playing
  let closed = false;

  // ------------------------------------------------------------- scaffold --
  const canvas = el('canvas.arena-canvas', { 'aria-hidden': 'true' });
  const flash = el('div.arena-flash');
  const speedlines = el('div.speedlines');
  const stageLayer = el('div.stage');
  const hud = el('div.hud');
  const dock = el('div.dock');

  // `.arena-mid` is an in-flow spacer that reserves vertical space between the
  // HUD and the dock; `.stage` is the absolutely-positioned effect layer that
  // sits on top of it inside the shake wrapper.
  const arenaMid = el('div.arena-mid', {}, [el('div.arena-floor')]);
  const shakeWrap = el('div.arena-shake', {}, [canvas, speedlines, stageLayer]);
  const root = el('div.arena', {}, [shakeWrap, flash, hud, arenaMid, dock]);
  document.body.append(root);

  /**
   * Large on-stage fighter sprites. These are the visual anchors that every
   * VFX plays against, positioned to match the engine's ANCHOR coordinates.
   */
  function makeSprite(side) {
    // Decorative duplicate of the HUD portrait — hidden from assistive tech so
    // screen-reader users do not hear the same fighter announced twice.
    const spriteCanvas = el('canvas', { 'aria-hidden': 'true' });
    const inner = el('div.sprite-inner', {}, [spriteCanvas]);
    const node = el(`div.sprite${side === 'enemy' ? '.enemy' : ''}`, {
      style: { left: `${ANCHOR[side].x * 100}%`, top: `${ANCHOR[side].y * 100}%` },
    }, [inner]);
    stageLayer.append(node);
    return { node, canvas: spriteCanvas, fighterId: null };
  }
  const sprites = { player: makeSprite('player'), enemy: makeSprite('enemy') };

  /** Replay a one-shot CSS animation class on a sprite. */
  function spriteAnim(side, className, duration = 420) {
    const sprite = sprites[side];
    if (!sprite) return;
    sprite.node.classList.remove(className);
    void sprite.node.offsetWidth; // force reflow so the animation restarts
    sprite.node.classList.add(className);
    setTimeout(() => sprite.node.classList.remove(className), duration);
  }

  const vfx = new VFXEngine(canvas);
  vfx.reducedMotion = Boolean(settings.reducedMotion);

  // Drive shake + flash from the VFX loop straight into CSS variables.
  vfx.onFrame = (shake, flashLevel) => {
    if (settings.screenShake === false) {
      shakeWrap.style.setProperty('--shake-x', '0px');
      shakeWrap.style.setProperty('--shake-y', '0px');
    } else {
      shakeWrap.style.setProperty('--shake-x', `${shake.x.toFixed(2)}px`);
      shakeWrap.style.setProperty('--shake-y', `${shake.y.toFixed(2)}px`);
    }
    // Cap the impact flash well below full white so sprites stay readable
    // through it — the flash should punctuate a hit, not erase the frame.
    flash.style.opacity = String(Math.min(0.38, flashLevel * 0.38));
  };

  /** Resolve a normalised anchor to canvas pixels. */
  const anchorPoint = (side) => vfx.point(ANCHOR[side].x, ANCHOR[side].y);

  // ------------------------------------------------------------ HUD build --

  const portraits = { player: null, enemy: null };

  function combatantBlock(side) {
    const canvasEl = el('canvas', {
      role: 'img',
      'aria-label': side === 'player' ? 'Your active fighter' : 'Enemy active fighter',
    });
    const portrait = el('div.portrait', {}, [canvasEl]);
    portraits[side] = { wrap: portrait, canvas: canvasEl, fighterId: null };

    const nameEl = el('div.gauge-name');
    const hpBar = el('div.bar-fill.bar-hp', { style: { width: '100%' } });
    const hpNum = el('span.hp-num');
    const kiBar = el('div.bar-fill.bar-ki', { style: { width: '50%' } });
    const pips = el('div.team-pips');

    const block = el(`div.combatant${side === 'enemy' ? '.enemy' : ''}`, {}, [
      portrait,
      el('div.gauges', {}, [
        el('div.row', { style: { gap: '6px' } }, [nameEl, el('div.spacer'), pips]),
        el('div.hp-row', {}, [el('div.bar', {}, [hpBar]), hpNum]),
        el('div.ki-row', {}, [el('div.bar', {}, [kiBar])]),
      ]),
    ]);

    return { block, nameEl, hpBar, hpNum, kiBar, pips, portrait, canvasEl };
  }

  const playerUI = combatantBlock('player');
  const enemyUI = combatantBlock('enemy');
  const orbRow = el('div.orbs');

  const exitBtn = el('button.icon-btn', {
    'aria-label': 'Forfeit and leave',
    text: '✕',
    onClick: async () => {
      const confirmed = await confirmDialog({
        title: 'Leave battle?',
        message: 'Forfeiting counts as a loss and you will lose this run.',
        confirmLabel: 'Forfeit',
        danger: true,
      });
      if (!confirmed) return;
      // Forfeit is best-effort: the player is leaving either way, but we
      // still record the failure so a broken endpoint is visible.
      track(EVENTS.BATTLE_FORFEIT, { stage: stage?.id ?? 'unknown' });
      try { await api.forfeit(battleId); }
      catch (err) { reportQuiet(err, 'forfeit battle', 'api'); }
      store.set({ activeBattleId: null });
      close();
    },
  });

  mount(hud,
    el('div.row', { style: { gap: '8px' } }, [
      el('span.tiny', { text: stage?.name ?? 'Battle', style: { fontWeight: '650' } }),
      el('div.spacer'),
      exitBtn,
    ]),
    el('div.hud-row.enemy', {}, [enemyUI.block]),
    orbRow,
    el('div.hud-row', {}, [playerUI.block])
  );

  // ----------------------------------------------------------- dock build --

  const handRow = el('div.hand');
  const actionRow = el('div.dock-actions');
  const benchRow = el('div.bench');
  mount(dock, actionRow, handRow, benchRow);

  // --------------------------------------------------------------- render --

  /** Repaint the whole HUD from the current authoritative state. */
  function paint() {
    const p = state.player;
    const e = state.enemy;
    const pa = p.members[p.active];
    const ea = e.members[e.active];

    const paintSide = (ui, side, active, team) => {
      const def = catalogue.byId.get(active.fighterId);
      const colour = catalogue.elements[active.element].hex;

      if (portraits[side].fighterId !== active.fighterId) {
        portraits[side].fighterId = active.fighterId;
        const art = renderPortrait(def.art, 130);
        const ctx = ui.canvasEl.getContext('2d');
        if (ctx) {
          ui.canvasEl.width = art.width;
          ui.canvasEl.height = art.height;
          ctx.drawImage(art, 0, 0);
        }
      }

      // Keep the large stage sprite in sync with the active fighter.
      const sprite = sprites[side];
      if (sprite && sprite.fighterId !== active.fighterId) {
        sprite.fighterId = active.fighterId;
        const big = renderPortrait(def.art, 320);
        const sctx = sprite.canvas.getContext('2d');
        if (sctx) {
          sprite.canvas.width = big.width;
          sprite.canvas.height = big.height;
          sctx.drawImage(big, 0, 0);
        }
        sprite.node.classList.remove('downed');
      }
      sprite?.node.classList.toggle('downed', !active.alive);

      mount(ui.nameEl,
        el('span.el-dot', {
          style: { background: colour, color: colour, width: '9px', height: '9px' },
          'aria-hidden': 'true',
        }),
        el('span.el-glyph', {
          text: ELEMENT_GLYPH[active.element] ?? '',
          style: { color: colour, fontSize: '10px' },
          'aria-label': `${catalogue.elements[active.element].label} element`,
        }),
        el('span', { text: active.name }),
        el('span.tiny.mono', { text: `Lv${active.level}`, style: { opacity: '.6' } })
      );

      const hpPct = (active.hp / active.maxHp) * 100;
      ui.hpBar.style.width = `${hpPct}%`;
      ui.hpBar.className = `bar-fill bar-hp${hpPct < 25 ? ' crit' : hpPct < 50 ? ' low' : ''}`;
      ui.hpNum.textContent = `${num(active.hp)}/${num(active.maxHp)}`;
      ui.kiBar.style.width = `${(active.ki / active.maxKi) * 100}%`;

      mount(ui.pips, ...team.members.map((m) =>
        el('span.pip', { class: m.alive ? '' : 'down' })
      ));
    };

    paintSide(playerUI, 'player', pa, p);
    paintSide(enemyUI, 'enemy', ea, e);

    // Rush Orbs.
    mount(orbRow, ...Array.from({ length: 7 }, (_, i) =>
      el('span.orb', { class: i < p.rushOrbs ? 'lit' : '' })
    ));

    // Actions.
    const canVanish = pa.vanish >= 50;
    const canRush = p.risingRushReady;
    const canMain = !pa.mainAbility.used && state.count >= pa.mainAbility.requires;

    mount(actionRow,
      el('button.act-btn.act-vanish', {
        class: canVanish ? 'ready' : '',
        disabled: locked || !canVanish,
        onClick: () => act({ action: 'vanish' }),
      }, [
        el('span', { text: 'Vanish' }),
        el('span.sub', { text: `${Math.round(pa.vanish)}%` }),
      ]),
      el('button.act-btn', {
        disabled: locked || !canMain,
        onClick: () => act({ action: 'main_ability' }),
      }, [
        el('span', { text: 'Ability' }),
        el('span.sub', { text: canMain ? 'Ready' : `${Math.max(0, pa.mainAbility.requires - state.count)}c` }),
      ]),
      el('button.act-btn', {
        disabled: locked,
        onClick: () => act({ action: 'charge' }),
      }, [
        el('span', { text: 'Charge' }),
        el('span.sub', { text: '+Ki' }),
      ]),
      el('button.act-btn.act-rush', {
        class: canRush ? 'ready' : '',
        disabled: locked || !canRush,
        onClick: () => act({ action: 'rising_rush' }),
      }, [
        el('span', { text: 'Rising Rush' }),
        el('span.sub', { text: `${p.rushOrbs}/7` }),
      ])
    );

    // Hand.
    mount(handRow, ...p.hand.map((card, index) => {
      const affordable = pa.ki >= card.cost;
      const node = el('div.acard', {
        dataset: { arts: card.arts },
        class: affordable && !locked ? '' : 'locked',
        style: { animationDelay: `${index * 0.04}s` },
        role: 'button',
        tabindex: affordable && !locked ? '0' : '-1',
        'aria-label': `${card.label}, cost ${card.cost} Ki`,
        onClick: () => {
          if (!affordable || locked) return;
          node.classList.add('playing');
          act({ action: 'card', cardUid: card.uid });
        },
      }, [
        el('span.acard-cost', { text: card.cost }),
        artsIcon(card.arts),
        el('span.acard-label', { text: card.label }),
        card.moveName ? el('span.acard-move', { text: card.moveName }) : null,
      ]);
      return node;
    }));

    // Bench.
    mount(benchRow, ...p.members.map((member, slot) => {
      const isActive = slot === p.active;
      const canSwitch = member.alive && !isActive && pa.substitution === 0 && !locked;
      const benchCanvas = el('canvas');
      lazyPortrait(benchCanvas, catalogue.byId.get(member.fighterId).art, member.name);
      return el('button.bench-slot', {
        class: isActive ? 'active' : '',
        disabled: !canSwitch,
        title: member.name,
        'aria-label': `${member.name}, ${Math.round((member.hp / member.maxHp) * 100)}% health` +
          (isActive ? ' (active)' : member.alive ? '. Activate to switch in.' : ' (defeated)'),
        onClick: () => act({ action: 'switch', slot }),
      }, [
        benchCanvas,
        el('div.bench-hp', {}, [
          el('i', { style: { width: `${(member.hp / member.maxHp) * 100}%` } }),
        ]),
      ]);
    }));
  }

  /** Inline SVG for an Arts card. */
  function artsIcon(arts) {
    const paths = {
      STRIKE: '<path d="M5 9a2 2 0 0 1 2-2h1V5.5a1.5 1.5 0 0 1 3 0V7h1V5a1.5 1.5 0 0 1 3 0v2h1V6.5a1.5 1.5 0 0 1 3 0V13a7 7 0 0 1-7 7h-1a7 7 0 0 1-7-7V9z"/>',
      BLAST: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="9.5" opacity=".35"/>',
      SPECIAL: '<path d="m12 2 2.4 7.4H22l-6.2 4.5 2.4 7.4-6.2-4.6L5.8 21l2.4-7.4L2 9.4h7.6z"/>',
      ULTIMATE: '<path d="M12 1l2 6 5-3-3 5 6 2-6 2 3 5-5-3-2 6-2-6-5 3 3-5-6-2 6-2-3-5 5 3z"/>',
      AWAKEN: '<path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="12" cy="12" r="3"/>',
    };
    const wrap = el('span.acard-ico');
    wrap.innerHTML = `<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor">${paths[arts] ?? paths.STRIKE}</svg>`;
    return wrap;
  }

  // ------------------------------------------------------ event playback --

  /** Spawn a floating damage number at a side's anchor. */
  function floatDamage(side, amount, critical, elementLabel) {
    if (settings.damageNumbers === false) return;
    const anchor = ANCHOR[side];
    const node = el('div.dmg-num', {
      text: num(amount),
      class: `${critical ? 'crit' : ''} ${elementLabel === 'resisted' ? 'weak' : ''}`.trim(),
      style: {
        left: `${anchor.x * 100}%`,
        top: `${anchor.y * 100}%`,
      },
    });
    stageLayer.append(node);
    setTimeout(() => node.remove(), 1150);
  }

  /** Show the sweeping move-name banner. */
  function moveBanner(name) {
    const node = el('div.move-banner', {}, [el('div.move-banner-inner', { text: name })]);
    stageLayer.append(node);
    setTimeout(() => node.remove(), 1550);
  }

  /**
   * Ability-proc ticker line.
   *
   * Several abilities can fire in the same beat, so each live proc on a side
   * is assigned an increasing row index and offset vertically by CSS. Without
   * this they render exactly on top of one another and become unreadable.
   */
  const procRows = { player: 0, enemy: 0 };
  function procLine(side, text) {
    const row = procRows[side];
    procRows[side] += 1;
    const node = el('div.proc', {
      text,
      style: { top: side === 'player' ? '68%' : '18%', '--proc-row': String(row) },
    });
    stageLayer.append(node);
    setTimeout(() => {
      node.remove();
      // Reset once this side's procs have all drained.
      procRows[side] = Math.max(0, procRows[side] - 1);
    }, 1650);
  }

  /** The Rising Rush cut-in. */
  async function rushCutin(members) {
    if (settings.reducedMotion) return;
    const faces = members.slice(0, 3).map((m) => {
      const art = renderPortrait(m.art, 200);
      art.style.width = '100%';
      art.style.height = '100%';
      return el('div.rush-face', {}, [art]);
    });
    const overlay = el('div.rush-cutin', {}, [
      el('div', { style: { textAlign: 'center' } }, [
        el('div.rush-team', {}, faces),
        el('div.rush-title', { text: 'RISING RUSH' }),
      ]),
    ]);
    document.body.append(overlay);
    speedlines.classList.add('on');
    setTimeout(() => speedlines.classList.remove('on'), 700);
    await sleep(1750);
    overlay.remove();
  }

  /**
   * Walk the event timeline, animating each beat.
   * Input stays locked for the duration.
   */
  /**
   * WCAG 2.2.1 Timing Adjustable.
   *
   * Combat normally advances on fixed timers. In untimed mode each beat waits
   * for an explicit confirmation instead, so players who need more time are
   * never rushed. Returns immediately when the mode is off.
   */
  function waitForAdvance(ms) {
    if (!settings.untimedMode) return sleep(ms);
    return new Promise((resolve) => {
      const done = () => {
        document.removeEventListener('keydown', onKey);
        root.removeEventListener('click', onClick);
        hint.remove();
        resolve();
      };
      const onKey = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); done(); }
      };
      const onClick = () => done();
      const hint = el('div.proc', {
        text: 'Press Enter or tap to continue',
        style: { top: '50%', zIndex: '60', animation: 'none', opacity: '1' },
      });
      stageLayer.append(hint);
      document.addEventListener('keydown', onKey);
      root.addEventListener('click', onClick);
    });
  }

  async function playEvents(events) {
    for (const event of events) {
      if (closed) return;
      switch (event.type) {
        case 'card_play': {
          const side = event.side;
          const from = anchorPoint(side);
          const to = anchorPoint(side === 'player' ? 'enemy' : 'player');
          if (event.moveName && (event.arts === 'SPECIAL' || event.arts === 'ULTIMATE')) {
            moveBanner(event.moveName);
            if (event.arts === 'ULTIMATE') {
              speedlines.classList.add('on');
              setTimeout(() => speedlines.classList.remove('on'), 640);
            }
            await sleep(420);
          }
          const def = catalogue.byId.get(event.fighterId);
          const hue = ELEMENT_HUE[def?.element] ?? 30;
          const kind = event.vfx
            ? (catalogue.vfx[event.vfx]?.kind ?? 'impact')
            : (event.arts === 'BLAST' ? 'beam' : 'barrage');
          const profileVfx = catalogue.vfx[event.vfx] ?? { particles: 140, shake: 8, flash: 0.3 };
          spriteAnim(side, 'attacking', 440);
          vfx.emit(kind, {
            from, to, hue,
            particles: profileVfx.particles * (event.arts === 'STRIKE' ? 0.55 : 1),
            shake: profileVfx.shake * (event.arts === 'ULTIMATE' ? 1.4 : 0.75),
            flash: event.arts === 'ULTIMATE' ? profileVfx.flash : profileVfx.flash * 0.4,
          });
          await waitForAdvance(event.arts === 'ULTIMATE' ? 250 : 120);
          break;
        }
        case 'damage': {
          const victimSide = event.side === 'player' ? 'enemy' : 'player';
          floatDamage(victimSide, event.amount, event.critical, event.element);
          const ui = victimSide === 'player' ? playerUI : enemyUI;
          ui.portrait.classList.add('hurt');
          setTimeout(() => ui.portrait.classList.remove('hurt'), 340);
          spriteAnim(victimSide, 'hit', 360);
          if (event.critical) vfx.addShake(16);
          // Tween the HP bar for the struck fighter if they are on screen.
          const team = state[victimSide];
          const active = team.members[team.active];
          if (active && active.fighterId === event.defenderId) {
            const pct = (event.hpAfter / event.maxHp) * 100;
            ui.hpBar.style.width = `${pct}%`;
            ui.hpBar.className = `bar-fill bar-hp${pct < 25 ? ' crit' : pct < 50 ? ' low' : ''}`;
            ui.hpNum.textContent = `${num(event.hpAfter)}/${num(event.maxHp)}`;
          }
          await waitForAdvance(140);
          break;
        }
        case 'ability': {
          const first = event.effects?.[0];
          if (first) procLine(event.side, `${event.triggerText}: ${first.text}`);
          await sleep(65);
          break;
        }
        case 'gauge_full': {
          procLine(event.side, `${event.gaugeName} Gauge FULL`);
          vfx.emit('aura', { from: anchorPoint(event.side), hue: 46, particles: 90 });
          await sleep(170);
          break;
        }
        case 'main_ability': {
          moveBanner(event.name);
          spriteAnim(event.side, 'charging', 1200);
          vfx.emit('spiral', { to: anchorPoint(event.side), hue: 150, particles: 180, flash: 0.4, shake: 10 });
          await waitForAdvance(430);
          break;
        }
        case 'vanish': {
          const ui = event.side === 'player' ? playerUI : enemyUI;
          ui.portrait.style.transition = 'opacity .12s';
          ui.portrait.style.opacity = '0.25';
          setTimeout(() => { ui.portrait.style.opacity = '1'; }, 220);
          spriteAnim(event.side, 'vanishing', 520);
          vfx.emit('impact', { to: anchorPoint(event.side), hue: 276, particles: 70 });
          procLine(event.side, 'Vanishing Step');
          await sleep(200);
          break;
        }
        case 'charge': {
          spriteAnim(event.side, 'charging', 1200);
          vfx.emit('aura', { from: anchorPoint(event.side), hue: 200, particles: 90 });
          procLine(event.side, 'Charging Ki');
          await sleep(210);
          break;
        }
        case 'rush_orb': {
          const balls = orbRow.children;
          const node = balls[event.total - 1];
          if (node) { node.classList.add('lit', 'just-lit'); setTimeout(() => node.classList.remove('just-lit'), 520); }
          await sleep(60);
          break;
        }
        case 'rising_rush_ready': {
          if (event.side === 'player') toast('Rising Rush ready!', 'gold', 2200);
          break;
        }
        case 'rising_rush': {
          await rushCutin(event.team ?? []);
          vfx.emit('nova', {
            to: anchorPoint(event.side === 'player' ? 'enemy' : 'player'),
            hue: 40, particles: 340, shake: 26, flash: 1,
          });
          await sleep(320);
          break;
        }
        case 'endurance': {
          procLine(event.side, 'ENDURANCE — survived!');
          vfx.emit('nova', { to: anchorPoint(event.side), hue: 145, particles: 150, flash: 0.5 });
          await sleep(330);
          break;
        }
        case 'ko': {
          const ui = event.side === 'player' ? playerUI : enemyUI;
          ui.portrait.style.filter = 'grayscale(1) brightness(.5)';
          vfx.emit('eruption', { to: anchorPoint(event.side), hue: 10, particles: 200, shake: 18, flash: 0.6 });
          setTimeout(() => { ui.portrait.style.filter = ''; }, 700);
          await waitForAdvance(400);
          break;
        }
        case 'switch': {
          vfx.emit('impact', { to: anchorPoint(event.side), hue: 200, particles: 90 });
          await sleep(180);
          break;
        }
        case 'battle_end':
          await sleep(320);
          break;
        default:
          break;
      }
    }
  }

  /** Send an action, then animate the response. */
  async function act(action) {
    if (locked || closed) return;
    locked = true;
    paint(); // disable controls immediately

    try {
      const result = await api.battleAction(battleId, action);
      state = result.state;
      await playEvents(result.events);
      if (closed) return;
      paint();

      if (result.state.status === 'complete') {
        await showResult(result.rewards, result.state.winner === 'player');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        toast(err.message, 'err', 2200);
        // Re-sync in case the client drifted from the server's view.
        try {
          const fresh = await api.getBattle(battleId);
          state = fresh.state;
        } catch (err) { reportQuiet(err, 're-sync battle state', 'api'); }
      } else {
        toast('Connection problem.', 'err');
      }
    } finally {
      locked = false;
      if (!closed) paint();
    }
  }

  /** Victory / defeat overlay with reward breakdown. */
  async function showResult(rewards, won) {
    track(EVENTS.BATTLE_COMPLETE, { won: Boolean(won), stage: stage?.id ?? 'unknown' });
    store.set({ activeBattleId: null });

    if (won) {
      vfx.emit('nova', { to: vfx.point(0.5, 0.45), hue: 45, particles: 300, flash: 0.7, shake: 12 });
    }

    const rows = [];
    if (rewards) {
      if (rewards.crystals) rows.push(['Chrono Crystals', `+${num(rewards.crystals)}`]);
      if (rewards.zeni) rows.push(['Zeni', `+${num(rewards.zeni)}`]);
      if (rewards.souls) rows.push(['Souls', `+${num(rewards.souls)}`]);
      if (rewards.xp) rows.push(['Account XP', `+${num(rewards.xp)}`]);
    }

    const overlay = el('div.result', {}, [
      el('div.result-card', {}, [
        el('div', {
          text: won ? 'VICTORY' : 'DEFEAT',
          class: `result-title ${won ? 'win' : 'lose'}`,
        }),
        rewards?.firstClear
          ? el('p.tiny', { text: 'FIRST CLEAR BONUS', style: { color: 'var(--jade)', marginTop: '8px', fontWeight: '700' } })
          : null,
        el('div', { style: { marginTop: '20px' } },
          rows.map(([label, value]) =>
            el('div.reward-row', {}, [
              el('span.tiny', { text: label }),
              el('span.reward-val', { text: value }),
            ])
          )
        ),
        el('div.row', { style: { gap: '10px', marginTop: '22px' } }, [
          el('button.btn.btn-ghost', {
            text: 'Back to stages', style: { flex: '1' },
            onClick: () => { overlay.remove(); close(); },
          }),
        ]),
      ]),
    ]);
    document.body.append(overlay);
  }

  /** Tear down the arena and return to the app shell. */
  async function close() {
    if (closed) return;
    closed = true;
    vfx.destroy();
    root.remove();
    document.removeEventListener('keydown', onKey);
    // Refresh the player so currencies and missions are current.
    try { applyPlayerState(await api.player()); }
    catch (err) { reportQuiet(err, 'refresh player after battle', 'api'); }
    navigate('battle');
  }

  /** Keyboard shortcuts: 1-4 play cards, V vanish, R rush, C charge. */
  function onKey(event) {
    if (locked || closed) return;
    const key = event.key.toLowerCase();
    if (key >= '1' && key <= '4') {
      const card = state.player.hand[Number(key) - 1];
      const active = state.player.members[state.player.active];
      if (card && active.ki >= card.cost) act({ action: 'card', cardUid: card.uid });
    } else if (key === 'v') {
      act({ action: 'vanish' });
    } else if (key === 'r' && state.player.risingRushReady) {
      act({ action: 'rising_rush' });
    } else if (key === 'c') {
      act({ action: 'charge' });
    }
  }
  document.addEventListener('keydown', onKey);

  // Initial paint + opening animation.
  paint();
  (async () => {
    if (initialEvents?.length) {
      locked = true;
      await playEvents(initialEvents);
      locked = false;
      paint();
    }
  })();
}
