/**
 * Home / dashboard view.
 *
 * The primary landing surface after sign-in: account status, the free-pass
 * banner, mission progress, best team preview and a jump-back-in shortcut.
 */

import { el, mount, num, compact, bar, toast } from '../core/ui.js';
import { store } from '../core/store.js';
import { lazyPortrait } from '../core/portrait.js';
import { api } from '../core/api.js';

/** Small stat tile. */
function statTile(label, value, accent) {
  return el('div', {
    style: {
      flex: '1 1 100px', minWidth: '0', padding: '14px',
      background: 'var(--bg-deep)', borderRadius: 'var(--r-md)',
      border: '1px solid var(--line-soft)',
    },
  }, [
    el('div.tiny', { text: label, style: { textTransform: 'uppercase', letterSpacing: '.06em' } }),
    el('div', {
      text: value,
      style: {
        fontFamily: 'var(--f-display)', fontSize: '24px', fontWeight: '700',
        color: accent ?? 'var(--ink)', marginTop: '2px',
      },
    }),
  ]);
}

/** Compact fighter chip used in the team preview. */
function fighterChip(entry) {
  const canvas = el('canvas', { width: 64, height: 64 });
  lazyPortrait(canvas, entry.art, entry.title);
  return el('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '8px', background: 'var(--bg-deep)',
      borderRadius: 'var(--r-md)', border: '1px solid var(--line-soft)',
    },
  }, [
    el('div', {
      style: {
        width: '44px', height: '44px', borderRadius: '8px',
        overflow: 'hidden', flex: '0 0 auto', border: '1px solid var(--line)',
      },
    }, [canvas]),
    el('div', { style: { minWidth: '0', flex: '1' } }, [
      el('div', {
        text: entry.title,
        style: {
          fontSize: '12.5px', fontWeight: '650',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
      }),
      el('div.row', { style: { gap: '6px', marginTop: '2px' } }, [
        el(`span.rarity-tag.tag-${entry.rarity}`, { text: entry.rarity.slice(0, 4) }),
        el('span.tiny.mono', { text: `Lv${entry.level}` }),
        el('span.fcard-stars', { text: '★'.repeat(entry.stars) }),
      ]),
    ]),
    el('div.mono', {
      text: compact(entry.power),
      style: { fontSize: '12px', color: 'var(--gold)', fontWeight: '700' },
    }),
  ]);
}

/**
 * @param {HTMLElement} host
 * @param {Function} navigate
 */
export function renderHome(host, navigate) {
  const profile = store.get('profile');
  const roster = store.get('roster') ?? [];
  const missions = store.get('missions') ?? [];
  const catalogue = store.get('catalogue');

  if (!profile) {
    mount(host, el('div.center-load', {}, [el('div.spinner')]));
    return;
  }

  const best = roster.slice().sort((a, b) => b.power - a.power).slice(0, 3);
  const claimable = missions.filter((m) => m.claimable);
  const totalFighters = catalogue?.fighters?.length ?? 0;
  const collectionPct = totalFighters ? Math.round((roster.length / totalFighters) * 100) : 0;
  const clearedCount = Object.keys(profile.clearedStages ?? {}).length;
  const totalStages = catalogue?.stages?.length ?? 48;

  // ---------------------------------------------------------------- header --
  const welcome = el('div.section-head', {}, [
    el('div', {}, [
      el('h1.h1', { text: `Welcome back, ${profile.displayName}` }),
      el('p.muted', { text: `Account level ${profile.level} · ${roster.length} fighters recruited` }),
    ]),
  ]);

  // XP progress.
  const xpPct = profile.xpForNext ? (profile.xp / profile.xpForNext) * 100 : 0;
  const xpPanel = el('div.panel', {}, [
    el('div.row', { style: { marginBottom: '10px' } }, [
      el('span.h3', { text: `Level ${profile.level}` }),
      el('div.spacer'),
      el('span.tiny.mono', { text: `${num(profile.xp)} / ${num(profile.xpForNext)} XP` }),
    ]),
    bar(xpPct, 'bar-xp'),
    el('div.row', { style: { marginTop: '16px', gap: '10px', flexWrap: 'wrap' } }, [
      statTile('Crystals', compact(profile.crystals), 'var(--azure)'),
      statTile('Zeni', compact(profile.zeni), 'var(--gold)'),
      statTile('Souls', compact(profile.souls), 'var(--violet)'),
      statTile('Battles won', num(profile.counters.battlesWon), 'var(--jade)'),
    ]),
  ]);

  // ------------------------------------------------------------ free pass --
  const passPanel = el('div.panel', {
    style: {
      background: 'linear-gradient(150deg, rgba(255,157,28,.14), rgba(168,85,247,.1) 60%, var(--bg-deep))',
      borderColor: 'rgba(255,197,49,.35)',
    },
  }, [
    el('div.row', {}, [
      el('span', { text: '🎫', style: { fontSize: '26px' } }),
      el('div', { style: { flex: '1', minWidth: '0' } }, [
        el('div', {
          text: 'Legends Pass — Active',
          style: { fontFamily: 'var(--f-display)', fontSize: '18px', fontWeight: '700', color: 'var(--gold)' },
        }),
        el('div.tiny', { text: 'Granted free to every account. Never expires, never charges.' }),
      ]),
      el('span', {
        text: 'FREE FOREVER',
        style: {
          padding: '4px 10px', borderRadius: '99px', background: 'rgba(61,220,132,.16)',
          border: '1px solid rgba(61,220,132,.45)', color: '#6ee7a0',
          fontSize: '10px', fontWeight: '750', letterSpacing: '.05em', whiteSpace: 'nowrap',
        },
      }),
    ]),
    el('ul', { style: { marginTop: '14px', display: 'grid', gap: '6px' } },
      (profile.pass.perks ?? []).map((p) =>
        el('li.tiny', { text: `✓ ${p}`, style: { color: 'var(--ink-soft)' } })
      )
    ),
  ]);

  // -------------------------------------------------------------- missions --
  const missionPanel = el('div.panel', {}, [
    el('div.section-head', {}, [
      el('h3.h3', { text: 'Missions' }),
      claimable.length
        ? el('span', {
            text: `${claimable.length} ready`,
            style: {
              padding: '3px 9px', borderRadius: '99px', background: 'var(--crimson)',
              fontSize: '10.5px', fontWeight: '700',
            },
          })
        : null,
    ]),
    el('div', { style: { display: 'grid', gap: '8px' } },
      missions.slice(0, 6).map((m) => {
        const pct = (m.progress / m.target) * 100;
        const claimBtn = el('button.btn.btn-sm', {
          text: m.claimed ? 'Claimed' : m.claimable ? 'Claim' : `${m.progress}/${m.target}`,
          disabled: !m.claimable,
          class: m.claimable ? 'btn-primary' : 'btn-ghost',
          onClick: async () => {
            claimBtn.disabled = true;
            claimBtn.textContent = '…';
            try {
              const result = await api.claimMission(m.id);
              store.set({
                profile: { ...store.get('profile'), crystals: result.crystals, zeni: result.zeni, souls: result.souls },
                missions: result.missions,
              });
              const parts = [];
              if (result.reward.crystals) parts.push(`${num(result.reward.crystals)} crystals`);
              if (result.reward.zeni) parts.push(`${num(result.reward.zeni)} zeni`);
              if (result.reward.souls) parts.push(`${num(result.reward.souls)} souls`);
              toast(`Claimed: ${parts.join(', ')}`, 'gold');
              renderHome(host, navigate);
            } catch (err) {
              toast(err.message, 'err');
              claimBtn.disabled = false;
            }
          },
        });
        return el('div', {
          style: {
            padding: '10px 12px', background: 'var(--bg-deep)',
            borderRadius: 'var(--r-md)', border: '1px solid var(--line-soft)',
          },
        }, [
          el('div.row', { style: { marginBottom: '6px' } }, [
            el('span', { text: m.name, style: { fontSize: '13px', fontWeight: '600' } }),
            el('div.spacer'),
            claimBtn,
          ]),
          bar(pct, m.complete ? 'bar-xp' : 'bar-ki'),
        ]);
      })
    ),
  ]);

  // ------------------------------------------------------------ best team --
  const teamPanel = el('div.panel', {}, [
    el('div.section-head', {}, [
      el('h3.h3', { text: 'Strongest fighters' }),
      el('button.btn.btn-sm.btn-ghost', { text: 'View roster', onClick: () => navigate('roster') }),
    ]),
    best.length
      ? el('div', { style: { display: 'grid', gap: '8px' } }, best.map(fighterChip))
      : el('div', { style: { textAlign: 'center', padding: '24px 0' } }, [
          el('p.muted', { text: 'No fighters yet — your first summon is free to make.' }),
          el('button.btn.btn-primary', {
            text: 'Go to Summon', style: { marginTop: '12px' },
            onClick: () => navigate('summon'),
          }),
        ]),
  ]);

  // --------------------------------------------------------------- progress --
  const progressPanel = el('div.panel', {}, [
    el('h3.h3', { text: 'Progress', style: { marginBottom: '14px' } }),
    el('div', { style: { display: 'grid', gap: '14px' } }, [
      el('div', {}, [
        el('div.row', { style: { marginBottom: '5px' } }, [
          el('span.tiny', { text: 'Collection' }),
          el('div.spacer'),
          el('span.tiny.mono', { text: `${roster.length} / ${totalFighters} (${collectionPct}%)` }),
        ]),
        bar(collectionPct, 'bar-vanish'),
      ]),
      el('div', {}, [
        el('div.row', { style: { marginBottom: '5px' } }, [
          el('span.tiny', { text: 'Story stages cleared' }),
          el('div.spacer'),
          el('span.tiny.mono', { text: `${clearedCount} / ${totalStages}` }),
        ]),
        bar((clearedCount / totalStages) * 100, 'bar-hp'),
      ]),
    ]),
    el('button.btn.btn-primary.btn-block', {
      text: 'Enter battle', style: { marginTop: '18px' },
      onClick: () => navigate('battle'),
    }),
  ]);

  const grid = el('div', {
    style: {
      display: 'grid', gap: '16px',
      gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
      alignItems: 'start',
    },
  }, [xpPanel, passPanel, missionPanel, teamPanel, progressPanel]);

  mount(host, el('div.view.view-enter', {}, [welcome, grid]));
}
