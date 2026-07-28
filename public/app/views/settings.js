/**
 * Settings view — preferences, account management and data controls.
 *
 * Also the home of the transparency surfaces: the provably-fair seed panel,
 * the currency audit ledger, and the GDPR export/erase controls.
 */

import { el, mount, num, toast, confirmDialog, modal } from '../core/ui.js';
import { store } from '../core/store.js';
import { api, ApiError } from '../core/api.js';

/** Labelled toggle switch. */
function toggle(label, description, checked, onChange) {
  const input = el('input', {
    type: 'checkbox', checked,
    onChange: (e) => onChange(e.target.checked),
    style: { width: '18px', height: '18px', accentColor: 'var(--gold)', cursor: 'pointer' },
  });
  return el('label', {
    style: {
      display: 'flex', gap: '12px', alignItems: 'flex-start',
      padding: '12px', background: 'var(--bg-deep)',
      borderRadius: 'var(--r-md)', cursor: 'pointer',
      border: '1px solid var(--line-soft)',
    },
  }, [
    input,
    el('div', { style: { flex: '1', minWidth: '0' } }, [
      el('div', { text: label, style: { fontSize: '13.5px', fontWeight: '600' } }),
      description ? el('div.tiny', { text: description }) : null,
    ]),
  ]);
}

export function renderSettings(host, navigate, onSignOut) {
  const profile = store.get('profile');
  const fairness = store.get('fairness');
  if (!profile) {
    mount(host, el('div.center-load', {}, [el('div.spinner')]));
    return;
  }

  /** Persist a settings patch, optimistically updating the UI. */
  const saveSettings = async (patch) => {
    const previous = profile.settings;
    store.set({ profile: { ...profile, settings: { ...previous, ...patch } } });
    applyBodyClasses();
    try {
      await api.updateSettings(patch);
    } catch (err) {
      store.set({ profile: { ...store.get('profile'), settings: previous } });
      applyBodyClasses();
      toast(err.message, 'err');
    }
  };

  /** Reflect motion preferences on <body> so CSS can react. */
  function applyBodyClasses() {
    const s = store.get('profile').settings;
    document.body.classList.toggle('reduced-motion', Boolean(s.reducedMotion));
  }

  // ------------------------------------------------------------- gameplay --
  const gameplayPanel = el('div.panel', {}, [
    el('h3.h3', { text: 'Gameplay & accessibility', style: { marginBottom: '12px' } }),
    el('div', { style: { display: 'grid', gap: '8px' } }, [
      toggle('Reduced motion', 'Disables particles, shake and cut-ins. Combat stays fully playable.',
        profile.settings.reducedMotion, (v) => saveSettings({ reducedMotion: v })),
      toggle('Screen shake', 'Camera impact on heavy hits.',
        profile.settings.screenShake, (v) => saveSettings({ screenShake: v })),
      toggle('Damage numbers', 'Floating damage values during battle.',
        profile.settings.damageNumbers, (v) => saveSettings({ damageNumbers: v })),
      toggle('Sound effects', 'Battle and UI audio.',
        profile.settings.soundEnabled, (v) => saveSettings({ soundEnabled: v })),
      toggle('Untimed mode',
        'Combat waits for you to confirm each step instead of advancing on a timer.',
        profile.settings.untimedMode, (v) => saveSettings({ untimedMode: v })),
    ]),
  ]);

  // -------------------------------------------------------------- profile --
  const nameInput = el('input.input', { value: profile.displayName, maxlength: '20' });
  const profilePanel = el('div.panel', {}, [
    el('h3.h3', { text: 'Profile', style: { marginBottom: '12px' } }),
    el('div.field', {}, [
      el('label.label', { text: 'Display name' }),
      el('div.row', { style: { gap: '8px' } }, [
        nameInput,
        el('button.btn.btn-ghost', {
          text: 'Save',
          onClick: async () => {
            try {
              const result = await api.updateProfile({ displayName: nameInput.value });
              store.set({ profile: { ...store.get('profile'), displayName: result.displayName } });
              toast('Display name updated.', 'ok');
            } catch (err) {
              toast(err.message, 'err');
            }
          },
        }),
      ]),
    ]),
    el('div.row', { style: { gap: '8px', flexWrap: 'wrap' } }, [
      el('button.btn.btn-ghost', {
        text: 'Change password',
        onClick: () => openPasswordDialog(),
      }),
      el('button.btn.btn-ghost', {
        text: 'Sign out',
        onClick: async () => {
          await api.logout();
          onSignOut();
        },
      }),
    ]),
  ]);

  function openPasswordDialog() {
    const current = el('input.input', { type: 'password', placeholder: 'Current password' });
    const next = el('input.input', { type: 'password', placeholder: 'New password (10+ characters)' });
    const errorEl = el('p.field-error');
    const dialog = modal({
      title: 'Change password',
      body: el('div', {}, [
        el('div.field', {}, [el('label.label', { text: 'Current password' }), current]),
        el('div.field', {}, [el('label.label', { text: 'New password' }), next]),
        errorEl,
      ]),
      actions: [
        el('button.btn.btn-ghost', { text: 'Cancel', onClick: () => dialog.close() }),
        el('button.btn.btn-primary', {
          text: 'Update',
          onClick: async (event) => {
            const btn = event.currentTarget;
            btn.disabled = true;
            errorEl.textContent = '';
            try {
              const result = await api.changePassword({
                currentPassword: current.value,
                newPassword: next.value,
              });
              toast(`Password updated. ${result.sessionsRevoked} other session(s) signed out.`, 'ok');
              dialog.close();
            } catch (err) {
              errorEl.textContent = err instanceof ApiError
                ? (Object.values(err.details?.fields ?? {})[0] ?? err.message)
                : 'Could not update password.';
              btn.disabled = false;
            }
          },
        }),
      ],
    });
  }

  // ------------------------------------------------------------- fairness --
  const fairnessPanel = el('div.panel', {}, [
    el('h3.h3', { text: 'Provably-fair summons', style: { marginBottom: '10px' } }),
    el('p.tiny', {
      text: 'Every summon is derived from HMAC-SHA512 over a server seed committed ' +
            'in advance, your client seed and an incrementing nonce. Rotate your ' +
            'client seed at any time to start a fresh, independently verifiable chain.',
      style: { marginBottom: '12px' },
    }),
    el('div', { style: { display: 'grid', gap: '6px' } }, [
      el('div', {}, [
        el('div.tiny', { text: 'Server seed hash (committed)' }),
        el('div.mono', {
          text: fairness?.serverSeedHash ?? '—',
          style: { fontSize: '10.5px', wordBreak: 'break-all', color: 'var(--ink-soft)' },
        }),
      ]),
      el('div', {}, [
        el('div.tiny', { text: 'Your client seed' }),
        el('div.mono', { text: fairness?.clientSeed ?? '—', style: { fontSize: '11px', color: 'var(--ink-soft)' } }),
      ]),
      el('div', {}, [
        el('div.tiny', { text: 'Nonce' }),
        el('div.mono', { text: String(fairness?.nonce ?? 0), style: { fontSize: '11px', color: 'var(--ink-soft)' } }),
      ]),
    ]),
    el('button.btn.btn-ghost.btn-sm', {
      text: 'Rotate client seed', style: { marginTop: '12px' },
      onClick: async () => {
        const confirmed = await confirmDialog({
          title: 'Rotate client seed?',
          message: 'This resets your nonce to zero and starts a new verifiable chain. Pity counters are unaffected.',
          confirmLabel: 'Rotate',
        });
        if (!confirmed) return;
        try {
          const result = await api.rotateSeed();
          store.set({ fairness: result });
          toast('Client seed rotated.', 'ok');
          renderSettings(host, navigate, onSignOut);
        } catch (err) {
          toast(err.message, 'err');
        }
      },
    }),
  ]);

  // --------------------------------------------------------------- ledger --
  const ledgerBody = el('div', {}, [el('p.tiny', { text: 'Loading…' })]);
  const ledgerPanel = el('div.panel', {}, [
    el('h3.h3', { text: 'Currency ledger', style: { marginBottom: '10px' } }),
    el('p.tiny', { text: 'Every crystal, zeni and soul movement on your account.', style: { marginBottom: '10px' } }),
    ledgerBody,
  ]);

  api.ledger(25).then((result) => {
    if (!result?.entries?.length) {
      mount(ledgerBody, el('p.tiny', { text: 'No transactions yet.' }));
      return;
    }
    mount(ledgerBody, el('div', { style: { display: 'grid', gap: '4px', maxHeight: '260px', overflowY: 'auto' } },
      result.entries.map((row) =>
        el('div.row', {
          style: {
            padding: '7px 10px', background: 'var(--bg-deep)',
            borderRadius: 'var(--r-sm)', fontSize: '12px',
          },
        }, [
          el('span', { text: row.reason.replace(/_/g, ' ') }),
          el('div.spacer'),
          el('span.mono', {
            text: `${row.delta > 0 ? '+' : ''}${num(row.delta)}`,
            style: { color: row.delta > 0 ? 'var(--jade)' : 'var(--crimson)', fontWeight: '650' },
          }),
          el('span.tiny.mono', { text: row.currency.slice(0, 3), style: { minWidth: '28px', textAlign: 'right' } }),
        ])
      )
    ));
  }).catch(() => mount(ledgerBody, el('p.tiny', { text: 'Could not load ledger.' })));

  // ----------------------------------------------------------------- data --
  const dataPanel = el('div.panel', {}, [
    el('h3.h3', { text: 'Your data', style: { marginBottom: '10px' } }),
    el('p.tiny', {
      text: 'You own your account. Export everything we store, or erase it permanently.',
      style: { marginBottom: '12px' },
    }),
    el('div.row', { style: { gap: '8px', flexWrap: 'wrap' } }, [
      el('button.btn.btn-ghost', {
        text: 'Export my data (JSON)',
        onClick: async () => {
          try {
            const data = await api.exportData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = el('a', { href: url, download: 'dragon-rush-heroes-export.json' });
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
            toast('Export downloaded.', 'ok');
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      }),
      el('button.btn.btn-danger', {
        text: 'Delete account',
        onClick: async () => {
          const confirmed = await confirmDialog({
            title: 'Delete your account?',
            message: 'This permanently erases your profile, roster, teams and history. It cannot be undone.',
            confirmLabel: 'Delete everything',
            danger: true,
          });
          if (!confirmed) return;
          try {
            await api.deleteAccount();
            toast('Account deleted.', 'ok');
            onSignOut();
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      }),
    ]),
  ]);

  // ----------------------------------------------------------------- about --
  // Audit finding C-3/S-3: the app stored player data with no disclosure.
  const privacyPanel = el('div.panel', {}, [
    el('h3.h3', { text: 'Privacy', style: { marginBottom: '10px' } }),
    el('p.tiny', {
      text: 'This game collects the minimum possible. There is no tracking, ' +
            'no advertising, no third-party scripts and nothing is sold or shared.',
      style: { marginBottom: '10px' },
    }),
    el('div', { style: { display: 'grid', gap: '5px' } }, [
      el('div.row', {}, [el('span.tiny', { text: 'What is stored' }), el('div.spacer'),
        el('span.tiny', { text: 'Email, display name, game progress', style: { color: 'var(--ink-soft)' } })]),
      el('div.row', {}, [el('span.tiny', { text: 'Cookies' }), el('div.spacer'),
        el('span.tiny', { text: 'Session only — no tracking cookies', style: { color: 'var(--jade)' } })]),
      el('div.row', {}, [el('span.tiny', { text: 'Third-party scripts' }), el('div.spacer'),
        el('span.tiny', { text: 'None', style: { color: 'var(--jade)' } })]),
      el('div.row', {}, [el('span.tiny', { text: 'Analytics' }), el('div.spacer'),
        el('span.tiny', { text: 'Anonymous counts only, no identifiers', style: { color: 'var(--jade)' } })]),
      el('div.row', {}, [el('span.tiny', { text: 'Your rights' }), el('div.spacer'),
        el('span.tiny', { text: 'Export or erase any time, below', style: { color: 'var(--ink-soft)' } })]),
    ]),
  ]);

  const aboutPanel = el('div.panel', {}, [
    el('h3.h3', { text: 'About', style: { marginBottom: '10px' } }),
    el('p.tiny', {
      text: 'Dragon Rush Heroes is an original anime action-RPG. All 464 fighters, ' +
            'their names, moves and artwork are original works created for this project ' +
            'and generated procedurally at runtime. It is not affiliated with, endorsed ' +
            'by, or derived from any commercial franchise.',
      style: { marginBottom: '10px' },
    }),
    el('div', { style: { display: 'grid', gap: '5px' } }, [
      el('div.row', {}, [el('span.tiny', { text: 'Monetisation' }), el('div.spacer'),
        el('span.tiny', { text: 'None — free forever', style: { color: 'var(--jade)' } })]),
      el('div.row', {}, [el('span.tiny', { text: 'Advertising' }), el('div.spacer'),
        el('span.tiny', { text: 'None', style: { color: 'var(--jade)' } })]),
      el('div.row', {}, [el('span.tiny', { text: 'Energy / stamina gates' }), el('div.spacer'),
        el('span.tiny', { text: 'None', style: { color: 'var(--jade)' } })]),
      el('div.row', {}, [el('span.tiny', { text: 'Legends Pass' }), el('div.spacer'),
        el('span.tiny', { text: 'Included free', style: { color: 'var(--jade)' } })]),
    ]),
  ]);

  applyBodyClasses();

  mount(host, el('div.view.view-enter', {}, [
    el('div.section-head', {}, [
      el('div', {}, [
        el('h1.h1', { text: 'Settings' }),
        el('p.muted', { text: 'Preferences, transparency and account controls.' }),
      ]),
    ]),
    el('div', {
      style: {
        display: 'grid', gap: '16px',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        alignItems: 'start',
      },
    }, [gameplayPanel, profilePanel, privacyPanel, fairnessPanel, ledgerPanel, dataPanel, aboutPanel]),
  ]));
}
