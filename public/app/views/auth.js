/**
 * Authentication view — the onboarding surface.
 *
 * Doubles as the product's landing page: it has to sell the "free forever,
 * £500 head start" proposition in the few seconds before someone decides
 * whether to sign up.
 */

import { el, mount, toast, num } from '../core/ui.js';
import { api, ApiError } from '../core/api.js';
import { track, trackOnce, EVENTS } from '../core/analytics.js';

/**
 * @param {HTMLElement} host
 * @param {Function} onAuthenticated Called with the auth payload on success.
 */
export function renderAuth(host, onAuthenticated) {
  let mode = 'register'; // 'register' | 'login'
  let busy = false;

  const errorBox = el('div', { style: { minHeight: '18px' } });

  function setError(message) {
    mount(errorBox, message ? el('p.field-error', { text: message }) : null);
  }

  /** Show per-field validation errors returned by the server. */
  function applyFieldErrors(details) {
    if (!details?.fields) return false;
    const messages = Object.values(details.fields);
    setError(messages[0] ?? 'Please check the form.');
    for (const key of Object.keys(details.fields)) {
      form.querySelector(`[name="${key}"]`)?.classList.add('invalid');
    }
    return true;
  }

  const form = el('form', {
    onSubmit: async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      setError('');
      form.querySelectorAll('.invalid').forEach((n) => n.classList.remove('invalid'));
      submitBtn.disabled = true;
      submitBtn.textContent = mode === 'register' ? 'Creating account…' : 'Signing in…';

      const data = Object.fromEntries(new FormData(form));
      try {
        const payload = mode === 'register'
          ? await api.register({
              email: data.email,
              password: data.password,
              displayName: data.displayName,
            })
          : await api.login({ email: data.email, password: data.password });

        trackOnce(mode === 'register' ? EVENTS.REGISTER : EVENTS.LOGIN);
        track(mode === 'register' ? EVENTS.REGISTER : EVENTS.LOGIN);
        toast(
          mode === 'register'
            ? `Welcome, ${payload.player.displayName}! 25,000 Chrono Crystals deposited.`
            : `Welcome back, ${payload.player.displayName}.`,
          'gold',
          4200
        );
        onAuthenticated(payload);
      } catch (err) {
        if (err instanceof ApiError) {
          if (!applyFieldErrors(err.details)) setError(err.message);
        } else {
          setError('Something went wrong. Please try again.');
        }
        busy = false;
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'register' ? 'Create free account' : 'Sign in';
      }
    },
  });

  const submitBtn = el('button.btn.btn-primary.btn-block.btn-lg', {
    type: 'submit',
    text: 'Create free account',
  });

  const nameField = el('div.field', {}, [
    el('label.label', { for: 'displayName', text: 'Fighter name' }),
    el('input.input', {
      id: 'displayName', name: 'displayName', type: 'text',
      placeholder: 'Solvane', maxlength: '20', autocomplete: 'nickname', required: true,
    }),
  ]);

  const toggleLink = el('button.btn.btn-ghost.btn-block', {
    type: 'button',
    text: 'Already have an account? Sign in',
    onClick: () => {
      mode = mode === 'register' ? 'login' : 'register';
      setError('');
      nameField.style.display = mode === 'register' ? '' : 'none';
      nameField.querySelector('input').required = mode === 'register';
      submitBtn.textContent = mode === 'register' ? 'Create free account' : 'Sign in';
      headline.textContent = mode === 'register' ? 'Start your legend' : 'Welcome back';
      toggleLink.textContent = mode === 'register'
        ? 'Already have an account? Sign in'
        : 'New here? Create a free account';
      passwordInput.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    },
  });

  const passwordInput = el('input.input', {
    id: 'password', name: 'password', type: 'password',
    placeholder: 'At least 10 characters', minlength: '10',
    autocomplete: 'new-password', required: true,
  });

  const headline = el('h1.h1', { text: 'Start your legend' });

  form.append(
    nameField,
    el('div.field', {}, [
      el('label.label', { for: 'email', text: 'Email' }),
      el('input.input', {
        id: 'email', name: 'email', type: 'email',
        placeholder: 'you@example.com', autocomplete: 'email', required: true,
      }),
    ]),
    el('div.field', {}, [
      el('label.label', { for: 'password', text: 'Password' }),
      passwordInput,
    ]),
    errorBox,
    submitBtn
  );

  /** A selling-point row. */
  const perk = (emoji, title, detail) =>
    el('li', { style: { display: 'flex', gap: '12px', marginBottom: '14px' } }, [
      el('span', { text: emoji, style: { fontSize: '20px', lineHeight: '1.2' } }),
      el('div', {}, [
        el('div', { text: title, style: { fontWeight: '650', fontSize: '14px' } }),
        el('div.tiny', { text: detail }),
      ]),
    ]);

  const hero = el('div', { style: { flex: '1 1 380px', minWidth: '0' } }, [
    el('div.row', { style: { marginBottom: '18px' } }, [
      el('span', {
        text: '100% FREE — NO PURCHASES, EVER',
        style: {
          padding: '5px 12px', borderRadius: '99px',
          background: 'rgba(61,220,132,.14)', border: '1px solid rgba(61,220,132,.4)',
          color: '#6ee7a0', fontSize: '11px', fontWeight: '750', letterSpacing: '.06em',
        },
      }),
    ]),
    el('h2.h1', {
      html: 'Every fighter.<br>Every feature.<br><span style="background:linear-gradient(92deg,var(--gold),var(--orange),var(--crimson));-webkit-background-clip:text;background-clip:text;color:transparent">Zero cost.</span>',
      style: { marginBottom: '18px', lineHeight: '1.08' },
    }),
    el('p.muted', {
      text: 'A 464-fighter anime action RPG with real-time Arts-card combat, ' +
            'provably-fair summons and no paywall of any kind.',
      style: { marginBottom: '26px', maxWidth: '46ch' },
    }),
    el('ul', {}, [
      perk('💎', `${num(25000)} Chrono Crystals on signup`,
        'A ~£500-equivalent head start — 25 ten-pull multis before you fight once.'),
      perk('🎫', 'Legends Pass included free, forever',
        'The usual paid subscription, granted permanently to every account.'),
      perk('♾️', 'Unlimited stamina, no timers',
        'No energy meter, no "come back in 4 hours". Play as long as you want.'),
      perk('🔍', 'Provably-fair summon RNG',
        'Every pull is cryptographically verifiable. No hidden rate manipulation.'),
    ]),
  ]);

  /**
   * CRO-2 — "Play instantly".
   *
   * The demo previously demanded name + email + password before showing any
   * gameplay, despite storing everything locally, so the credentials served no
   * functional purpose. A signup wall in front of a *demo* is the highest
   * friction placement possible. Guests now play in one click and are offered
   * an account only after they have a reason to want one.
   */
  const guestBtn = el('button.btn.btn-primary.btn-block.btn-lg', {
    type: 'button',
    'aria-describedby': 'guest-note',
    onClick: async () => {
      if (busy) return;
      busy = true;
      guestBtn.disabled = true;
      guestBtn.textContent = 'Starting…';
      track(EVENTS.GUEST_START);
      try {
        // A guest is a normal account with a generated identity; nothing in
        // the game behaves differently, so there is no second code path.
        const suffix = Math.random().toString(36).slice(2, 8);
        const payload = await api.register({
          email: `guest_${suffix}@local.play`,
          password: `guest-${suffix}-${Date.now().toString(36)}`,
          displayName: `Fighter${suffix.slice(0, 4).toUpperCase()}`,
        });
        toast(`Welcome! 25,000 Chrono Crystals deposited.`, 'gold', 4200);
        onAuthenticated(payload);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not start. Please try again.');
        busy = false;
        guestBtn.disabled = false;
        guestBtn.textContent = '▶ Play instantly';
      }
    },
  }, ['▶ Play instantly']);

  const divider = el('div', {
    role: 'separator',
    'aria-label': 'or',
    style: {
      display: 'flex', alignItems: 'center', gap: '10px',
      margin: '18px 0 14px', color: 'var(--ink-dim)', fontSize: '11px',
      textTransform: 'uppercase', letterSpacing: '.08em',
    },
  }, [
    el('span', { style: { flex: '1', height: '1px', background: 'var(--line)' } }),
    el('span', { text: 'or' }),
    el('span', { style: { flex: '1', height: '1px', background: 'var(--line)' } }),
  ]);

  // The account form starts collapsed so the primary action stands alone.
  const formWrap = el('div', { style: { display: 'none' } }, [form, el('div', { style: { height: '10px' } }), toggleLink]);

  const showFormBtn = el('button.btn.btn-ghost.btn-block', {
    type: 'button',
    text: 'Create an account to sync progress',
    onClick: () => {
      formWrap.style.display = '';
      showFormBtn.style.display = 'none';
      formWrap.querySelector('input')?.focus();
    },
  });

  const card = el('div.panel', {
    style: { flex: '0 1 400px', minWidth: '0', alignSelf: 'flex-start' },
  }, [
    headline,
    el('p.muted', { text: 'No signup needed. No card. No ads.', style: { marginBottom: '20px' } }),
    guestBtn,
    el('p.tiny', {
      id: 'guest-note',
      text: 'Your progress saves to this browser.',
      style: { textAlign: 'center', marginTop: '8px' },
    }),
    divider,
    showFormBtn,
    formWrap,
  ]);

  const layout = el('div', {
    style: {
      display: 'flex', gap: '48px', flexWrap: 'wrap',
      alignItems: 'center', justifyContent: 'center',
      minHeight: '100%', padding: '32px 20px',
      maxWidth: '1150px', margin: '0 auto',
    },
  }, [hero, card]);

  mount(host, layout);
}
