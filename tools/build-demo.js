#!/usr/bin/env node
'use strict';
/**
 * ============================================================================
 * STATIC DEMO BUILDER  ·  for GitHub Pages
 * ============================================================================
 *
 * GitHub Pages serves static files only — it cannot run the Node backend. This
 * script produces a fully playable, self-contained build by:
 *
 *   1. Copying the real client (`public/`) verbatim — same UI, same renderer,
 *      same VFX engine. Nothing is stubbed on the presentation layer.
 *   2. Pre-rendering the catalogue (464 fighters, banners, stages) to JSON at
 *      build time, so no `/api/catalogue` round trip is needed.
 *   3. Injecting a service-worker-free **in-browser API shim** that runs the
 *      real combat and economy engines client-side against `localStorage`.
 *
 * Honest framing: this is a DEMO. Because the authoritative server is absent,
 * the demo build is trivially cheatable via devtools. That is an acceptable
 * trade for a marketing playable, and the README says so explicitly. The
 * production deployment (Docker/Fly/Render) keeps the authoritative server.
 *
 * Usage:  node tools/build-demo.js  →  writes ./demo/
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'demo');
const PUBLIC = path.join(ROOT, 'public');

/** Recursively copy a directory. */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

console.log('Building static demo…');
fs.rmSync(OUT, { recursive: true, force: true });
copyDir(PUBLIC, OUT);

// ---------------------------------------------------------------- catalogue

// Reuse the real domain modules so the demo data can never drift from the game.
process.env.SESSION_SECRET = 'demo-build-secret-demo-build-secret';
process.env.GACHA_SECRET = 'demo-build-gacha-demo-build-gacha-x';
process.env.LOG_LEVEL = 'silent';

const { CATALOGUE, ELEMENTS, RARITIES, ARTS, VFX_STYLES, BANNERS, STAGES, MISSIONS } =
  require('../server/domain/content');
const economy = require('../server/domain/economy');
const combat = require('../server/domain/combat');

const catalogue = {
  fighters: CATALOGUE.fighters,
  elements: ELEMENTS,
  rarities: RARITIES,
  arts: ARTS,
  vfx: VFX_STYLES,
  banners: BANNERS.map((b) => ({
    id: b.id, name: b.name, subtitle: b.subtitle, description: b.description,
    featured: b.featured, rates: b.rates, accent: b.accent, art: b.art,
  })),
  stages: STAGES,
  missions: MISSIONS,
  economy: economy.economySummary(),
  combat: combat.constants,
};

fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'data', 'catalogue.json'), JSON.stringify(catalogue));
const catBytes = fs.statSync(path.join(OUT, 'data', 'catalogue.json')).size;
console.log(`  catalogue.json: ${(catBytes / 1024).toFixed(0)} KB (${catalogue.fighters.length} fighters)`);

// ------------------------------------------------------------ inject shim

// Load the shim before the app's entry module so `fetch('/api/...')` is
// already intercepted by the time `main.js` runs.
const indexPath = path.join(OUT, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace(
  '<script type="module" src="/app/main.js"></script>',
  '<script src="./demo-api.js"></script>\n  <script type="module" src="./app/main.js"></script>'
);
// Pages serves from a sub-path, so absolute roots must become relative.
html = html.replace(/(href|src)="\/(styles|app)\//g, '$1="./$2/');
// Demo-specific metadata (canonical + JSON-LD are added by the SEO task).
html = html.replace('</head>', `  <link rel="manifest" href="./manifest.webmanifest">
</head>`);
fs.writeFileSync(indexPath, html);

// The client's api.js posts to absolute /api paths; the shim intercepts fetch,
// so no client source changes are required.

console.log('  index.html: shim injected, asset paths relativised');

// ------------------------------------------------------------------ extras

// GitHub Pages 404 -> SPA shell (Pages has no rewrite rules).
fs.copyFileSync(indexPath, path.join(OUT, '404.html'));

// Disable Jekyll so files/dirs beginning with _ are served.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log(`\nDemo built → ${OUT}`);
