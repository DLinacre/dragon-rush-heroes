/**
 * Summon view — banner selection and the full gacha reveal sequence.
 *
 * The reveal is the emotional peak of the genre, so it gets a real
 * presentation: charge-up, colour-graded burst keyed to the best rarity in the
 * pull, then a staggered card flip with an "all results" grid.
 */

import { el, mount, num, toast, sleep, bar } from '../core/ui.js';
import { store, applyPlayerState } from '../core/store.js';
import { api, ApiError } from '../core/api.js';
import { reportQuiet } from '../core/errors.js';
import { track, trackOnce, EVENTS } from '../core/analytics.js';
import { renderPortrait } from '../core/portrait.js';
import { VFXEngine } from '../core/vfx.js';

const RARITY_ORDER = { HERO: 1, EXTREME: 2, SPARKING: 3, LEGENDS: 4, ULTRA: 5 };
const RARITY_HUE = { HERO: 210, EXTREME: 196, SPARKING: 38, LEGENDS: 344, ULTRA: 280 };

/**
 * Play the full-screen reveal for a set of summon results.
 * @param {object[]} results
 * @returns {Promise<void>} resolves when the player dismisses the results
 */
function playReveal(results) {
  return new Promise((resolve) => {
    const reducedMotion = store.get('profile')?.settings?.reducedMotion;

    const best = results.reduce(
      (top, r) => (RARITY_ORDER[r.rarity] > RARITY_ORDER[top] ? r.rarity : top),
      'HERO'
    );
    const hue = RARITY_HUE[best];

    const canvas = el('canvas', {
      style: { position: 'absolute', inset: '0', width: '100%', height: '100%' },
    });

    const stage = el('div', {
      style: {
        position: 'relative', zIndex: '2', display: 'grid', placeItems: 'center',
        width: '100%', height: '100%', padding: '20px',
      },
    });

    const overlay = el('div', {
      style: {
        position: 'fixed', inset: '0', zIndex: '400',
        background: 'radial-gradient(circle at 50% 50%, rgba(20,10,40,.96), rgba(3,5,12,.99))',
        overflow: 'hidden',
      },
    }, [canvas, stage]);

    document.body.append(overlay);

    const vfx = new VFXEngine(canvas);
    vfx.reducedMotion = Boolean(reducedMotion);

    /** Show the grid of every pull with a staggered entrance. */
    const showGrid = () => {
      const cards = results.map((result, index) => {
        const portrait = renderPortrait(result.art, 190);
        portrait.setAttribute('role', 'img');
        portrait.setAttribute('aria-label', `${result.title}, ${result.rarity} rarity${result.isNew ? ', new' : ''}`);
        const holder = el('div', {
          style: {
            width: '100%', aspectRatio: '3/4', borderRadius: '10px',
            overflow: 'hidden', border: `2px solid hsl(${RARITY_HUE[result.rarity]} 80% 58%)`,
            boxShadow: `0 0 18px hsla(${RARITY_HUE[result.rarity]} 90% 55% / .45)`,
            position: 'relative',
            animation: `revealCard .34s var(--e-spring) ${index * 0.045}s both`,
          },
        });
        portrait.style.width = '100%';
        portrait.style.height = '100%';
        holder.append(portrait);
        if (result.isNew) {
          holder.append(el('span', {
            text: 'NEW',
            style: {
              position: 'absolute', top: '5px', left: '5px', padding: '2px 6px',
              borderRadius: '4px', background: 'var(--jade)', color: '#04240f',
              fontSize: '9px', fontWeight: '800', letterSpacing: '.05em',
            },
          }));
        }
        if (result.starsGained > 0 && !result.isNew) {
          holder.append(el('span', {
            text: `★+${result.starsGained}`,
            style: {
              position: 'absolute', top: '5px', left: '5px', padding: '2px 6px',
              borderRadius: '4px', background: 'var(--gold)', color: '#2a1a00',
              fontSize: '9px', fontWeight: '800',
            },
          }));
        }
        return el('div', {}, [
          holder,
          el('div', {
            text: result.title,
            style: {
              fontSize: '10.5px', marginTop: '5px', textAlign: 'center',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            },
          }),
          el('div', {
            text: result.rarity,
            style: {
              fontSize: '8.5px', textAlign: 'center', fontWeight: '800',
              letterSpacing: '.06em', color: `hsl(${RARITY_HUE[result.rarity]} 85% 68%)`,
            },
          }),
        ]);
      });

      const newCount = results.filter((r) => r.isNew).length;
      mount(stage, el('div', {
        style: { width: 'min(760px, 100%)', textAlign: 'center' },
      }, [
        el('h2', {
          text: results.length === 1 ? 'Summon Result' : `${results.length} Summons`,
          style: {
            fontFamily: 'var(--f-display)', fontSize: 'clamp(22px,5vw,34px)',
            fontWeight: '800', letterSpacing: '.05em', marginBottom: '4px',
          },
        }),
        el('p.tiny', {
          text: `${newCount} new · ${results.length - newCount} limit breaks`,
          style: { marginBottom: '18px' },
        }),
        el('div', {
          style: {
            display: 'grid', gap: '10px',
            gridTemplateColumns: results.length === 1
              ? '1fr'
              : 'repeat(5, minmax(0, 1fr))',
            maxWidth: results.length === 1 ? '190px' : 'none',
            margin: '0 auto 22px',
          },
        }, cards),
        el('button.btn.btn-primary.btn-lg', {
          text: 'Continue',
          onClick: () => { vfx.destroy(); overlay.remove(); resolve(); },
        }),
      ]));
    };

    if (reducedMotion) { showGrid(); return; }

    // --- charge-up -----------------------------------------------------------
    const orb = el('div', {
      style: {
        width: '120px', height: '120px', borderRadius: '50%',
        background: `radial-gradient(circle at 36% 32%, #fff, hsl(${hue} 95% 62%) 45%, hsl(${hue} 90% 34%))`,
        boxShadow: `0 0 70px hsl(${hue} 95% 55%)`,
        animation: 'ballPop .5s var(--e-spring), rushGlow 1s ease-in-out infinite',
      },
    });
    mount(stage, orb);

    const centre = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    vfx.emit('aura', { from: centre, hue, particles: 120 });

    (async () => {
      await sleep(520);
      vfx.emit('vortex', { to: centre, hue, particles: 220, shake: 8 });
      await sleep(480);
      // Burst scaled to the best rarity pulled.
      const tier = RARITY_ORDER[best];
      vfx.emit(tier >= 4 ? 'nova' : 'spiral', {
        to: centre, hue, particles: 140 + tier * 80,
        shake: 8 + tier * 4, flash: 0.35 + tier * 0.12,
      });
      if (tier >= 4) {
        await sleep(180);
        vfx.emit('nova', { to: centre, hue: hue + 30, particles: 260, shake: 22, flash: 0.9 });
        // Rarity call-out for the big pulls.
        mount(stage, el('div', {
          text: best === 'ULTRA' ? 'ULTRA' : 'LEGENDS LIMITED',
          style: {
            fontFamily: 'var(--f-display)', fontSize: 'clamp(40px,11vw,96px)',
            fontWeight: '800', letterSpacing: '.1em',
            background: `linear-gradient(94deg,#fff,hsl(${hue} 95% 65%),#fff)`,
            WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
            filter: `drop-shadow(0 0 40px hsl(${hue} 95% 55%))`,
            animation: 'rushTitle .7s var(--e-spring)',
          },
        }));
        await sleep(1150);
      } else {
        await sleep(620);
      }
      showGrid();
    })();
  });
}

/**
 * @param {HTMLElement} host
 * @param {Function} navigate
 */
export function renderSummon(host, navigate) {
  const catalogue = store.get('catalogue');
  const profile = store.get('profile');
  if (!catalogue || !profile) {
    mount(host, el('div.center-load', {}, [el('div.spinner')]));
    return;
  }

  const banners = catalogue.banners;
  let selected = banners[0];
  let busy = false;

  const body = el('div');

  /** Percentage string for a rate. */
  const pct = (v) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;

  function draw() {
    const cost1 = catalogue.economy.summonCostSingle;
    const cost10 = catalogue.economy.summonCostMulti;
    const crystals = store.get('profile').crystals;

    // Banner selector.
    const tabs = el('div', {
      style: { display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '6px', marginBottom: '18px' },
    }, banners.map((b) =>
      el('button.btn.btn-sm', {
        text: b.name,
        class: b.id === selected.id ? 'btn-primary' : 'btn-ghost',
        style: { whiteSpace: 'nowrap', flex: '0 0 auto' },
        onClick: () => { selected = b; draw(); },
      })
    ));

    // Featured fighters strip.
    const featured = selected.featured
      .map((id) => catalogue.byId.get(id))
      .filter(Boolean);

    const featuredStrip = el('div', {
      style: {
        display: 'grid', gap: '10px',
        gridTemplateColumns: `repeat(auto-fit, minmax(96px, 1fr))`,
        marginBottom: '18px',
      },
    }, featured.map((f) => {
      const portrait = renderPortrait(f.art, 150);
      portrait.setAttribute('role', 'img');
      portrait.setAttribute('aria-label', `Featured fighter: ${f.title}`);
      portrait.style.width = '100%';
      portrait.style.height = '100%';
      return el('div', {}, [
        el('div', {
          style: {
            aspectRatio: '3/4', borderRadius: '8px', overflow: 'hidden',
            border: `2px solid ${selected.accent}`,
            boxShadow: `0 0 16px ${selected.accent}55`,
          },
        }, [portrait]),
        el('div', {
          text: f.title,
          style: {
            fontSize: '10px', textAlign: 'center', marginTop: '4px',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          },
        }),
      ]);
    }));

    const doSummon = async (count) => {
      if (busy) return;
      const cost = count === 1 ? cost1 : cost10;
      if (store.get('profile').crystals < cost) {
        toast('Not enough Chrono Crystals. Win battles and claim missions to earn more.', 'err');
        return;
      }
      busy = true;
      single.disabled = true;
      multi.disabled = true;
      try {
        trackOnce(EVENTS.FIRST_SUMMON);
        track(count === 1 ? EVENTS.SUMMON_SINGLE : EVENTS.SUMMON_MULTI, { banner: selected.id });
        const result = await api.summon(selected.id, count);
        // Rarity distribution is the single most useful economy signal.
        const best = result.results.reduce(
          (top, r) => (RARITY_ORDER[r.rarity] > RARITY_ORDER[top] ? r.rarity : top), 'HERO');
        if (RARITY_ORDER[best] >= 4) track(EVENTS.RARE_PULL, { rarity: best });
        store.set({
          profile: { ...store.get('profile'), crystals: result.crystals, pity: result.pity },
          roster: result.roster,
        });
        await playReveal(result.results);
        // Refresh derived data (missions may have advanced).
        try { applyPlayerState(await api.player()); }
        catch (err) { reportQuiet(err, 'refresh player after summon', 'api'); }
        draw();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Summon failed.', 'err');
      } finally {
        busy = false;
        single.disabled = false;
        multi.disabled = false;
      }
    };

    const single = el('button.btn.btn-ghost.btn-lg', {
      style: { flex: '1' },
      onClick: () => doSummon(1),
    }, [
      el('div', {}, [
        el('div', { text: 'Summon ×1', style: { fontWeight: '700' } }),
        el('div.tiny.mono', { text: `${num(cost1)} 💎` }),
      ]),
    ]);

    const multi = el('button.btn.btn-primary.btn-lg', {
      style: { flex: '1.4' },
      onClick: () => doSummon(10),
    }, [
      el('div', {}, [
        el('div', { text: 'Summon ×10', style: { fontWeight: '750' } }),
        el('div.tiny.mono', { text: `${num(cost10)} 💎 · Sparking guaranteed` }),
      ]),
    ]);

    const pity = store.get('profile').pity;
    const pityPanel = el('div.panel', { style: { marginTop: '16px' } }, [
      el('h3.h3', { text: 'Pity counters', style: { marginBottom: '10px' } }),
      el('div', { style: { display: 'grid', gap: '10px' } }, [
        el('div', {}, [
          el('div.row', { style: { marginBottom: '4px' } }, [
            el('span.tiny', { text: 'Sparking guarantee' }),
            el('div.spacer'),
            el('span.tiny.mono', {
              text: `${pity.sinceSparking} / ${catalogue.economy.pitySparking}`,
            }),
          ]),
          bar((pity.sinceSparking / catalogue.economy.pitySparking) * 100, 'bar-xp'),
        ]),
        el('div', {}, [
          el('div.row', { style: { marginBottom: '4px' } }, [
            el('span.tiny', { text: 'Legends guarantee' }),
            el('div.spacer'),
            el('span.tiny.mono', {
              text: `${pity.sinceLegends} / ${catalogue.economy.pityLegends}`,
            }),
          ]),
          bar((pity.sinceLegends / catalogue.economy.pityLegends) * 100, 'bar-vanish'),
        ]),
      ]),
    ]);

    const ratesPanel = el('div.panel', { style: { marginTop: '16px' } }, [
      el('div.section-head', {}, [
        el('h3.h3', { text: 'Published rates' }),
        el('span.tiny', { text: 'Provably fair' }),
      ]),
      el('div', { style: { display: 'grid', gap: '6px' } },
        Object.entries(selected.rates)
          .sort((a, b) => RARITY_ORDER[b[0]] - RARITY_ORDER[a[0]])
          .map(([rarity, rate]) =>
            el('div.row', {}, [
              el(`span.rarity-tag.tag-${rarity}`, { text: rarity }),
              el('div.spacer'),
              el('span.mono.tiny', { text: pct(rate) }),
            ])
          )
      ),
      el('p.tiny', {
        text: 'Every roll is HMAC-SHA512 derived from a pre-committed server seed. ' +
              'Rotate your client seed in Settings to verify independently.',
        style: { marginTop: '10px' },
      }),
    ]);

    mount(body,
      tabs,
      el('div.panel', {
        style: {
          background: `linear-gradient(150deg, ${selected.accent}22, var(--bg-deep) 65%)`,
          borderColor: `${selected.accent}66`,
        },
      }, [
        el('h2.h2', { text: selected.name, style: { color: selected.accent } }),
        el('p.tiny', { text: selected.subtitle, style: { marginBottom: '4px' } }),
        el('p.muted', { text: selected.description, style: { marginBottom: '16px' } }),
        featuredStrip,
        el('div.row', { style: { gap: '10px' } }, [single, multi]),
        el('p.tiny', {
          text: `Balance: ${num(crystals)} Chrono Crystals`,
          style: { textAlign: 'center', marginTop: '10px' },
        }),
      ]),
      el('div', {
        style: { display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' },
      }, [pityPanel, ratesPanel])
    );
  }

  draw();
  mount(host, el('div.view.view-enter', {}, [
    el('div.section-head', {}, [
      el('div', {}, [
        el('h1.h1', { text: 'Summon' }),
        el('p.muted', { text: 'Free crystals, published rates, verifiable rolls.' }),
      ]),
    ]),
    body,
  ]));
}
