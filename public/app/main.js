/**
 * Application bootstrap and router.
 *
 * Responsibilities:
 *   - restore the session and load static catalogue data,
 *   - own the shell chrome (header wallet, nav rail/bar),
 *   - route between views and keep the URL hash in sync,
 *   - animate currency changes so rewards feel tangible.
 */

import { el, mount, num, compact, icon, toast } from './core/ui.js';
import { store, indexCatalogue, applyPlayerState } from './core/store.js';
import { api } from './core/api.js';
import { renderAuth } from './views/auth.js';
import { renderHome } from './views/home.js';
import { renderSummon } from './views/summon.js';
import { renderRoster } from './views/roster.js';
import { renderBattle } from './views/battle.js';
import { renderSettings } from './views/settings.js';

const ROUTES = [
  { id: 'home', label: 'Home', icon: 'home', render: renderHome },
  { id: 'summon', label: 'Summon', icon: 'summon', render: renderSummon },
  { id: 'roster', label: 'Roster', icon: 'roster', render: renderRoster },
  { id: 'battle', label: 'Battle', icon: 'battle', render: renderBattle },
  { id: 'settings', label: 'Settings', icon: 'settings', render: renderSettings },
];

const root = document.getElementById('app');

/* ------------------------------------------------------------------ chrome */

const coinCrystal = el('span.mono', { text: '0' });
const coinZeni = el('span.mono', { text: '0' });
const coinSoul = el('span.mono', { text: '0' });

const crystalPill = el('div.coin', { title: 'Chrono Crystals' }, [
  el('span.coin-ico.coin-crystal'), coinCrystal,
]);
const zeniPill = el('div.coin', { title: 'Zeni' }, [
  el('span.coin-ico.coin-zeni'), coinZeni,
]);
const soulPill = el('div.coin', { title: 'Souls' }, [
  el('span.coin-ico.coin-soul'), coinSoul,
]);

const header = el('header.hdr', {}, [
  el('div.brand', {}, [
    el('span.brand-orb'),
    el('span.brand-text', { text: 'DR Heroes' }),
  ]),
  el('div.wallet', {}, [crystalPill, zeniPill, soulPill]),
]);

const main = el('main.main');
const navBar = el('nav.nav', { 'aria-label': 'Primary' });
const desktopRail = el('nav.desktop-rail', { 'aria-label': 'Primary' });

/** Build the nav buttons for a container. */
function buildNav(container) {
  mount(container, ...ROUTES.map((route) =>
    el('button.nav-btn', {
      dataset: { route: route.id },
      'aria-label': route.label,
      onClick: () => navigate(route.id),
    }, [icon(route.icon, 21), el('span', { text: route.label })])
  ));
}

/** Highlight the active nav item and mark it for assistive tech. */
function syncNav() {
  const current = store.get('route');
  for (const container of [navBar, desktopRail]) {
    for (const button of container.children) {
      const active = button.dataset.route === current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    }
  }
}

/* ------------------------------------------------- animated currency pills */

const displayed = { crystals: 0, zeni: 0, souls: 0 };

/** Count a pill up/down so rewards visibly land. */
function tweenCurrency(key, target, node, pill) {
  const from = displayed[key];
  if (from === target) return;
  if (target > from) {
    pill.classList.remove('flash');
    void pill.offsetWidth; // restart the animation
    pill.classList.add('flash');
  }
  const start = performance.now();
  const duration = Math.min(900, 260 + Math.abs(target - from) / 40);
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    // easeOutCubic
    const eased = 1 - Math.pow(1 - t, 3);
    const value = Math.round(from + (target - from) * eased);
    node.textContent = compact(value);
    if (t < 1) requestAnimationFrame(step);
    else { displayed[key] = target; node.textContent = compact(target); }
  };
  requestAnimationFrame(step);
}

/** Push profile currencies into the header. */
function syncWallet() {
  const profile = store.get('profile');
  if (!profile) return;
  tweenCurrency('crystals', profile.crystals, coinCrystal, crystalPill);
  tweenCurrency('zeni', profile.zeni, coinZeni, zeniPill);
  tweenCurrency('souls', profile.souls, coinSoul, soulPill);
}

store.on('profile', syncWallet);

/* ------------------------------------------------------------------ router */

/** Navigate to a route id. */
export function navigate(routeId, params = {}) {
  const route = ROUTES.find((r) => r.id === routeId) ?? ROUTES[0];
  store.set({ route: route.id, routeParams: params });
  if (location.hash.slice(1) !== route.id) {
    history.replaceState(null, '', `#${route.id}`);
  }
  syncNav();
  route.render(main, navigate, signOut);
  main.scrollTop = 0;
}

window.addEventListener('hashchange', () => {
  const target = location.hash.slice(1);
  if (store.get('phase') !== 'ready') return;
  if (target && target !== store.get('route')) navigate(target);
});

/* -------------------------------------------------------------- auth flow */

/** Tear down the session and return to the auth screen. */
function signOut() {
  store.set({
    phase: 'auth', user: null, profile: null, roster: [],
    teams: [], missions: [], activeBattleId: null,
  });
  displayed.crystals = 0; displayed.zeni = 0; displayed.souls = 0;
  showAuth();
}

/** Render the unauthenticated shell. */
function showAuth() {
  mount(root, el('div.backdrop'), main);
  renderAuth(main, async (payload) => {
    store.set({ user: payload.user });
    await enterApp();
  });
}

/** Load player data and render the authenticated shell. */
async function enterApp() {
  mount(root, el('div.backdrop'), desktopRail, el('div.app-col', {}, [header, main, navBar]));
  buildNav(navBar);
  buildNav(desktopRail);

  mount(main, el('div.center-load', {}, [
    el('div.spinner'),
    el('p.muted', { text: 'Loading your account…' }),
  ]));

  try {
    const [catalogue, player] = await Promise.all([
      store.get('catalogue') ? Promise.resolve(store.get('catalogue')) : api.catalogue(),
      api.player(),
    ]);
    store.set({ catalogue: catalogue.byId ? catalogue : indexCatalogue(catalogue), phase: 'ready' });
    applyPlayerState(player);

    // Apply persisted accessibility preferences immediately.
    document.body.classList.toggle('reduced-motion', Boolean(player.profile.settings.reducedMotion));

    // Seed the wallet without animating from zero on first paint.
    displayed.crystals = player.profile.crystals;
    displayed.zeni = player.profile.zeni;
    displayed.souls = player.profile.souls;
    coinCrystal.textContent = compact(player.profile.crystals);
    coinZeni.textContent = compact(player.profile.zeni);
    coinSoul.textContent = compact(player.profile.souls);

    const initial = location.hash.slice(1);
    navigate(ROUTES.some((r) => r.id === initial) ? initial : 'home');
  } catch (err) {
    mount(main, el('div.center-load', {}, [
      el('p', { text: 'Could not load your account.' }),
      el('p.tiny', { text: err.message }),
      el('button.btn.btn-primary', { text: 'Retry', onClick: () => enterApp() }),
    ]));
  }
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  mount(root, el('div.backdrop'), el('div.center-load', {}, [
    el('div.spinner'),
    el('p.muted', { text: 'Powering up…' }),
  ]));

  try {
    const session = await api.session();
    if (session.authenticated) {
      store.set({ user: session.user });
      await enterApp();
    } else {
      store.set({ phase: 'auth' });
      showAuth();
    }
  } catch (err) {
    store.set({ phase: 'auth' });
    showAuth();
    toast('Could not reach the server. Some features may not work.', 'err', 5000);
  }
}

boot();
