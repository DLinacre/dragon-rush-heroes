/**
 * Roster view — collection browsing, filtering, and fighter detail.
 *
 * Must stay fluid with 400+ owned fighters, so the grid uses lazily painted
 * canvases (IntersectionObserver) and CSS `contain` on each card to keep
 * layout work local.
 */

import { el, mount, num, compact, stars, bar, toast, modal, debounce } from '../core/ui.js';
import { store, applyPlayerState } from '../core/store.js';
import { lazyPortrait, renderPortrait } from '../core/portrait.js';
import { api } from '../core/api.js';

const RARITY_ORDER = { HERO: 1, EXTREME: 2, SPARKING: 3, LEGENDS: 4, ULTRA: 5 };

/** A single card in the collection grid. */
function fighterCard(entry, onClick, { selected = false, dim = false } = {}) {
  const canvas = el('canvas');
  lazyPortrait(canvas, entry.art, entry.title);

  const elementColour = store.get('catalogue')?.elements?.[entry.element]?.hex ?? '#fff';

  return el('div.fcard', {
    class: `${selected ? 'selected' : ''} ${dim ? 'dim' : ''}`.trim(),
    tabindex: '0',
    role: 'button',
    'aria-label': `${entry.title}, ${entry.rarity}, level ${entry.level}`,
    onClick: () => onClick(entry),
    onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(entry); } },
  }, [
    el('div.fcard-art', {}, [
      canvas,
      el(`div.fcard-rarity.r-${entry.rarity}`),
      el('div.fcard-el', { style: { background: elementColour, color: elementColour } }),
    ]),
    el('div.fcard-body', {}, [
      el('div.fcard-name', { text: entry.title, title: entry.title }),
      el('div.fcard-meta', {}, [
        el('span.fcard-stars', { text: '★'.repeat(entry.stars) || '☆' }),
        el('span.fcard-lvl', { text: `Lv${entry.level}` }),
      ]),
    ]),
  ]);
}

/** Detail sheet with training and soul-boost controls. */
function openDetail(entry, refresh) {
  const catalogue = store.get('catalogue');
  const def = catalogue.byId.get(entry.fighterId);
  const portrait = renderPortrait(entry.art, 300);
  portrait.setAttribute('role', 'img');
  portrait.setAttribute('aria-label', `Full portrait of ${entry.title}`);
  portrait.style.width = '100%';
  portrait.style.height = 'auto';
  portrait.style.borderRadius = 'var(--r-md)';

  const statRow = (label, value) =>
    el('div.row', { style: { padding: '6px 0', borderBottom: '1px solid var(--line-soft)' } }, [
      el('span.tiny', { text: label }),
      el('div.spacer'),
      el('span.mono', { text: num(value), style: { fontSize: '13px' } }),
    ]);

  const body = el('div');

  function draw() {
    const current = store.get('roster').find((r) => r.fighterId === entry.fighterId) ?? entry;
    const progress = current.starProgress;

    const trainBtn = el('button.btn.btn-primary', {
      text: current.nextTrainingCost
        ? `Train · ${num(current.nextTrainingCost)} Zeni`
        : 'Level capped',
      disabled: !current.nextTrainingCost,
      onClick: async () => {
        trainBtn.disabled = true;
        trainBtn.textContent = 'Training…';
        try {
          const result = await api.train(current.fighterId, 1);
          const roster = store.get('roster').map((r) =>
            r.fighterId === result.entry.fighterId ? result.entry : r
          );
          store.set({ roster, profile: { ...store.get('profile'), zeni: result.zeni } });
          toast(`${result.entry.title} reached level ${result.entry.level}`, 'ok');
          draw();
          refresh?.();
        } catch (err) {
          toast(err.message, 'err');
          trainBtn.disabled = false;
        }
      },
    });

    const boostRow = (stat, label) => {
      const points = current.soulBoosts?.[stat] ?? 0;
      const btn = el('button.btn.btn-sm.btn-ghost', {
        text: `+1 (${points})`,
        onClick: async () => {
          btn.disabled = true;
          try {
            const result = await api.soulBoost(current.fighterId, stat, 1);
            const roster = store.get('roster').map((r) =>
              r.fighterId === result.entry.fighterId ? result.entry : r
            );
            store.set({ roster, profile: { ...store.get('profile'), souls: result.souls } });
            toast(`${label} boosted`, 'ok');
            draw();
            refresh?.();
          } catch (err) {
            toast(err.message, 'err');
            btn.disabled = false;
          }
        },
      });
      return el('div.row', { style: { padding: '4px 0' } }, [
        el('span.tiny', { text: label }),
        el('div.spacer'),
        btn,
      ]);
    };

    mount(body,
      el('div', {
        style: { display: 'grid', gap: '16px', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.25fr)' },
      }, [
        el('div', {}, [
          portrait,
          el('div.row', { style: { marginTop: '10px', gap: '6px', flexWrap: 'wrap' } }, [
            el(`span.rarity-tag.tag-${current.rarity}`, { text: current.rarity }),
            el('span.tiny', {
              text: catalogue.elements[current.element].label,
              style: { color: catalogue.elements[current.element].hex },
            }),
          ]),
          el('div', { style: { marginTop: '8px' } },
            (current.tags ?? []).map((t) =>
              el('span.tiny', {
                text: t,
                style: {
                  display: 'inline-block', padding: '2px 7px', margin: '2px 3px 0 0',
                  background: 'var(--bg-float)', borderRadius: '99px', fontSize: '10px',
                },
              })
            )
          ),
        ]),
        el('div', {}, [
          el('div.row', { style: { marginBottom: '8px' } }, [
            el('span.fcard-stars', { text: stars(current.stars), style: { fontSize: '14px' } }),
            el('div.spacer'),
            el('span.mono.tiny', { text: `Lv ${current.level} / ${current.maxLevel}` }),
          ]),
          progress.next !== null
            ? el('div', { style: { marginBottom: '12px' } }, [
                el('div.tiny', {
                  text: `Z-Power to ★${progress.next}: ${num(progress.current)} / ${num(progress.required)}`,
                  style: { marginBottom: '4px' },
                }),
                bar(progress.percent, 'bar-xp'),
              ])
            : el('p.tiny', { text: 'Maximum limit break reached.', style: { marginBottom: '12px' } }),
          statRow('Health', current.stats.hp),
          statRow('Strike Attack', current.stats.strike),
          statRow('Blast Attack', current.stats.blast),
          statRow('Strike Defence', current.stats.strDef),
          statRow('Blast Defence', current.stats.blsDef),
          el('div.row', { style: { padding: '6px 0' } }, [
            el('span.tiny', { text: 'Critical' }),
            el('div.spacer'),
            el('span.mono', { text: `${current.stats.crit.toFixed(1)}%`, style: { fontSize: '13px' } }),
          ]),
          el('div', { style: { marginTop: '12px' } }, [trainBtn]),
          el('h3.h3', { text: 'Soul boost', style: { marginTop: '16px', marginBottom: '4px' } }),
          boostRow('hp', 'Health'),
          boostRow('strike', 'Strike'),
          boostRow('blast', 'Blast'),
        ]),
      ]),
      el('div', { style: { marginTop: '16px' } }, [
        el('h3.h3', { text: 'Signature moves', style: { marginBottom: '8px' } }),
        el('div', { style: { display: 'grid', gap: '6px' } }, [
          el('div', {
            style: { padding: '8px 10px', background: 'var(--bg-deep)', borderRadius: 'var(--r-sm)' },
          }, [
            el('div', { text: def.moves.special.name, style: { fontSize: '13px', fontWeight: '650', color: '#ffe082' } }),
            el('div.tiny', { text: `Special Arts · ${def.moves.special.vfx.toLowerCase()} effect` }),
          ]),
          el('div', {
            style: { padding: '8px 10px', background: 'var(--bg-deep)', borderRadius: 'var(--r-sm)' },
          }, [
            el('div', { text: def.moves.ultimate.name, style: { fontSize: '13px', fontWeight: '650', color: '#d8b4fe' } }),
            el('div.tiny', { text: `Ultimate Arts · ${def.moves.ultimate.vfx.toLowerCase()} effect` }),
          ]),
          el('div', {
            style: { padding: '8px 10px', background: 'var(--bg-deep)', borderRadius: 'var(--r-sm)' },
          }, [
            el('div', { text: def.mainAbility.name, style: { fontSize: '13px', fontWeight: '650', color: '#6ee7b7' } }),
            el('div.tiny', { text: `Main Ability · available after ${def.mainAbility.requires} counts` }),
          ]),
        ]),
        el('h3.h3', { text: 'Abilities', style: { marginTop: '14px', marginBottom: '8px' } }),
        el('div', { style: { display: 'grid', gap: '6px' } },
          def.abilities.map((ability) =>
            el('div', {
              style: { padding: '8px 10px', background: 'var(--bg-deep)', borderRadius: 'var(--r-sm)' },
            }, [
              el('div.tiny', {
                text: ability.triggerText,
                style: { color: 'var(--gold)', fontWeight: '650', marginBottom: '3px' },
              }),
              ...ability.effects.map((e) =>
                el('div.tiny', { text: `· ${e.text}`, style: { color: 'var(--ink-soft)' } })
              ),
            ])
          )
        ),
      ])
    );
  }

  draw();
  modal({ title: entry.title, body });
}

/**
 * @param {HTMLElement} host
 * @param {Function} navigate
 */
export function renderRoster(host, navigate) {
  const catalogue = store.get('catalogue');
  if (!catalogue) {
    mount(host, el('div.center-load', {}, [el('div.spinner')]));
    return;
  }

  let search = '';
  let rarityFilter = 'ALL';
  let elementFilter = 'ALL';
  let sortBy = 'power';

  const grid = el('div.grid.grid-auto');
  const countLabel = el('span.tiny');

  function draw() {
    const roster = store.get('roster') ?? [];
    let list = roster.slice();

    if (search) {
      const q = search.toLowerCase();
      list = list.filter((e) => e.title.toLowerCase().includes(q));
    }
    if (rarityFilter !== 'ALL') list = list.filter((e) => e.rarity === rarityFilter);
    if (elementFilter !== 'ALL') list = list.filter((e) => e.element === elementFilter);

    list.sort((a, b) => {
      if (sortBy === 'power') return b.power - a.power;
      if (sortBy === 'rarity') return (RARITY_ORDER[b.rarity] - RARITY_ORDER[a.rarity]) || b.power - a.power;
      if (sortBy === 'level') return b.level - a.level;
      if (sortBy === 'stars') return b.stars - a.stars;
      return a.title.localeCompare(b.title);
    });

    countLabel.textContent = `${list.length} of ${roster.length} fighters`;

    if (list.length === 0) {
      mount(grid, el('div', {
        style: { gridColumn: '1/-1', textAlign: 'center', padding: '40px 0' },
      }, [
        el('p.muted', { text: roster.length === 0 ? 'Your roster is empty.' : 'No fighters match those filters.' }),
        roster.length === 0
          ? el('button.btn.btn-primary', {
              text: 'Summon your first fighters', style: { marginTop: '12px' },
              onClick: () => navigate('summon'),
            })
          : null,
      ]));
      return;
    }

    mount(grid, ...list.map((entry) => fighterCard(entry, (e) => openDetail(e, draw))));
  }

  // A placeholder is NOT an accessible name — screen readers may ignore it and
  // it disappears on input. An explicit aria-label is required (WCAG 4.1.2).
  const searchInput = el('input.input', {
    type: 'search',
    placeholder: 'Search fighters…',
    'aria-label': 'Search your fighters by name',
    style: { maxWidth: '240px' },
    onInput: debounce((e) => { search = e.target.value; draw(); }, 160),
  });

  const select = (options, onChange, label) =>
    el('select.input', {
      'aria-label': label,
      style: { maxWidth: '150px' },
      onChange: (e) => { onChange(e.target.value); draw(); },
    }, options.map(([value, text]) => el('option', { value, text })));

  const controls = el('div.row.wrap', { style: { gap: '8px', marginBottom: '16px' } }, [
    searchInput,
    select(
      [['ALL', 'All rarities'], ...Object.keys(RARITY_ORDER).reverse().map((r) => [r, r])],
      (v) => { rarityFilter = v; },
      'Filter fighters by rarity'
    ),
    select(
      [['ALL', 'All elements'], ...Object.keys(catalogue.elements).map((e) => [e, catalogue.elements[e].label])],
      (v) => { elementFilter = v; },
      'Filter fighters by element'
    ),
    select(
      [['power', 'Sort: Power'], ['rarity', 'Sort: Rarity'], ['level', 'Sort: Level'],
       ['stars', 'Sort: Stars'], ['name', 'Sort: Name']],
      (v) => { sortBy = v; },
      'Sort fighters'
    ),
    el('div.spacer'),
    countLabel,
  ]);

  draw();

  mount(host, el('div.view.view-enter', {}, [
    el('div.section-head', {}, [
      el('div', {}, [
        el('h1.h1', { text: 'Roster' }),
        el('p.muted', { text: 'Train, limit break and inspect every fighter you own.' }),
      ]),
    ]),
    controls,
    grid,
  ]));
}
