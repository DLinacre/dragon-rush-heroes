/**
 * UI primitives: DOM building, toasts, modals, formatting and small helpers.
 *
 * The app renders with direct DOM construction rather than a virtual DOM. For
 * a surface this size that means no framework payload, no reconciliation cost,
 * and complete control over the animation timing that the battle screen needs.
 */

/**
 * Create an element.
 * @param {string} tag      Tag name, optionally with `.class` suffixes.
 * @param {object} [attrs]  Attributes; `class`, `text`, `html`, `on*` handled specially.
 * @param {Array|Node|string} [children]
 */
export function el(tag, attrs = {}, children = []) {
  // Support "div.card.active" shorthand.
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') {
      node.className = node.className ? `${node.className} ${value}` : value;
    } else if (key === 'text') {
      node.textContent = value;
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Replace all children of a node. */
export function mount(parent, ...children) {
  parent.replaceChildren(...children.filter(Boolean));
  return parent;
}

/** Format a number with thousands separators. */
export function num(value) {
  return Number(value ?? 0).toLocaleString('en-GB');
}

/** Compact large numbers: 1.2M, 45.3K. */
export function compact(value) {
  const n = Number(value ?? 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-GB');
}

/** Render a 0-7 star string. */
export function stars(count) {
  return '★'.repeat(Math.max(0, count)) + '☆'.repeat(Math.max(0, 7 - count));
}

/** Clamp helper. */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------ toasts --

let toastHost = null;

function ensureToastHost() {
  if (!toastHost) {
    toastHost = el('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  return toastHost;
}

/**
 * Show a transient message.
 * @param {string} message
 * @param {'info'|'ok'|'err'|'gold'} kind
 * @param {number} ms
 */
export function toast(message, kind = 'info', ms = 3200) {
  const host = ensureToastHost();
  const node = el(`div.toast.${kind}`, { text: message });
  host.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  }, ms);
  // Cap the stack so a burst of errors cannot fill the screen.
  while (host.children.length > 4) host.firstElementChild.remove();
  return node;
}

// ------------------------------------------------------------------- modal --

/**
 * Open a modal dialog.
 * @param {object} options `{ title, body, actions, onClose, wide }`
 * @returns {{close: Function, element: HTMLElement}}
 */
export function modal({ title, body, actions = [], onClose, dismissible = true }) {
  const backdrop = el('div.modal-back', { role: 'dialog', 'aria-modal': 'true' });
  const panel = el('div.modal');

  if (title) {
    panel.append(el('div.modal-head', {}, [
      el('h2.h2', { text: title }),
      el('div.spacer'),
      dismissible && el('button.icon-btn', {
        'aria-label': 'Close',
        onClick: () => close(),
        html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>',
      }),
    ]));
  }

  panel.append(el('div.modal-body', {}, body instanceof Node ? [body] : [el('p', { text: String(body ?? '') })]));

  if (actions.length) {
    panel.append(el('div.modal-foot', {}, actions));
  }

  backdrop.append(panel);
  document.body.append(backdrop);

  const previousFocus = document.activeElement;

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
    onClose?.();
  }

  function onKey(event) {
    if (event.key === 'Escape' && dismissible) close();
    // Focus trap.
    if (event.key === 'Tab') {
      const focusables = panel.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
  }

  if (dismissible) {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
  }
  document.addEventListener('keydown', onKey);

  // Move focus into the dialog for screen-reader and keyboard users.
  requestAnimationFrame(() => {
    panel.querySelector('button, input, [tabindex]')?.focus();
  });

  return { close, element: panel };
}

/** Confirmation dialog returning a promise. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const dialog = modal({
      title,
      body: el('p', { text: message, style: { color: 'var(--ink-soft)' } }),
      actions: [
        el('button.btn.btn-ghost', { text: 'Cancel', onClick: () => { finish(false); dialog.close(); } }),
        el(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, {
          text: confirmLabel,
          onClick: () => { finish(true); dialog.close(); },
        }),
      ],
      onClose: () => finish(false),
    });
  });
}

// ------------------------------------------------------------------ icons --

/** Inline SVG icon set (stroke-based, inherits `currentColor`). */
export const icons = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>',
  summon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 2.4 7.4H22l-6.2 4.5 2.4 7.4-6.2-4.6L5.8 21l2.4-7.4L2 9.4h7.6z"/></svg>',
  roster: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  battle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6M16 16l4 4M19 21l2-2"/><path d="M9.5 6.5 21 18v3h-3L6.5 9.5"/><path d="m5 19 6-6M8 16l-4 4M5 21l-2-2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1"/></svg>',
  fist: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 9a2 2 0 0 1 2-2h1V5.5a1.5 1.5 0 0 1 3 0V7h1V5a1.5 1.5 0 0 1 3 0v2h1V6.5a1.5 1.5 0 0 1 3 0V13a7 7 0 0 1-7 7h-1a7 7 0 0 1-7-7V9z"/></svg>',
  orb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10" opacity=".4"/><circle cx="10" cy="10" r="2" fill="currentColor" stroke="none" opacity=".8"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 2.4 7.4H22l-6.2 4.5 2.4 7.4-6.2-4.6L5.8 21l2.4-7.4L2 9.4h7.6z"/></svg>',
  burst: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1l2 6 5-3-3 5 6 2-6 2 3 5-5-3-2 6-2-6-5 3 3-5-6-2 6-2-3-5 5 3z"/></svg>',
  spiral: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 12a3 3 0 1 1 3 3c-3 0-5-2-5-5s2.5-5.5 5.5-5.5S21 7 21 11c0 5-4 9-9 9s-9-4-9-9"/></svg>',
};

/** Build an inline SVG icon node. */
export function icon(name, size = 20) {
  const wrapper = el('span', { style: { display: 'inline-flex', width: `${size}px`, height: `${size}px` } });
  wrapper.innerHTML = icons[name] ?? '';
  const svg = wrapper.firstElementChild;
  if (svg) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
  return wrapper;
}

/** Progress bar component. */
export function bar(percent, className = '') {
  return el('div.bar', {}, [
    el(`div.bar-fill${className ? `.${className}` : ''}`, {
      style: { width: `${clamp(percent, 0, 100)}%` },
    }),
  ]);
}

/** Debounce a function. */
export function debounce(fn, ms = 180) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Promise-based delay. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
