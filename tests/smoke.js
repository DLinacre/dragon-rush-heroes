'use strict';
/**
 * Post-deploy smoke test.
 *
 * Fast, read-mostly verification that a running deployment is healthy. Point
 * it at any environment with SMOKE_URL; it exits non-zero on the first
 * failure so it can gate a release pipeline.
 *
 *   SMOKE_URL=https://play.example.com node tests/smoke.js
 *
 * With no SMOKE_URL it boots the app in-process and tests that.
 */

const http = require('node:http');
const https = require('node:https');

const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass });
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Minimal GET returning { status, headers, body }. */
function get(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 10_000 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function main() {
  let base = process.env.SMOKE_URL;
  let server = null;
  let stop = null;

  if (!base) {
    process.env.PORT = process.env.PORT ?? '3600';
    process.env.DATA_DIR = process.env.DATA_DIR ?? `${__dirname}/../.data-smoke`;
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'smoke-secret-smoke-secret-smoke-secret';
    process.env.GACHA_SECRET = process.env.GACHA_SECRET ?? 'smoke-gacha-smoke-gacha-smoke-gacha-x';
    process.env.LOG_LEVEL = 'silent';
    const { createApp } = require('../server/index.js');
    const built = await createApp();
    stop = built.stop;
    server = built.app.createServer();
    await new Promise((r) => server.listen(Number(process.env.PORT), '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    console.log(`\nSmoke testing in-process app at ${base}\n`);
  } else {
    console.log(`\nSmoke testing ${base}\n`);
  }

  try {
    // 1. Health
    const health = await get(`${base}/api/health`);
    check('health endpoint responds 200', health.status === 200);
    check('reports healthy', health.body?.data?.status === 'healthy');
    check('reports a version', Boolean(health.body?.data?.version), health.body?.data?.version);

    // 2. Security headers
    check('sets Content-Security-Policy', Boolean(health.headers['content-security-policy']));
    check('sets X-Content-Type-Options', health.headers['x-content-type-options'] === 'nosniff');
    check('sets X-Frame-Options', health.headers['x-frame-options'] === 'DENY');
    check('sets Referrer-Policy', Boolean(health.headers['referrer-policy']));

    // 3. Catalogue integrity
    const cat = await get(`${base}/api/catalogue`);
    const fighters = cat.body?.data?.fighters ?? [];
    check('catalogue responds 200', cat.status === 200);
    check('serves 400+ fighters', fighters.length >= 400, `${fighters.length}`);
    check('every fighter has stats', fighters.every((f) => f.stats?.hp > 0));
    check('every fighter has art data', fighters.every((f) => f.art?.seed));
    check('serves banners', (cat.body?.data?.banners ?? []).length > 0);
    check('serves stages', (cat.body?.data?.stages ?? []).length > 0);

    // 4. The free-forever charter
    const econ = cat.body?.data?.economy ?? {};
    check('founder grant is 25,000', econ.founderGrant === 25000, String(econ.founderGrant));
    check('monetisation is none', econ.monetisation === 'none');
    check('free forever flag set', econ.freeForever === true);
    check('pass included', econ.passIncluded === true);
    check('stamina unlimited', econ.staminaUnlimited === true);

    // 5. Provable fairness
    const fair = await get(`${base}/api/fairness`);
    check('publishes a server seed hash', /^[0-9a-f]{64}$/.test(fair.body?.data?.serverSeedHash ?? ''));

    // 6. Client shell
    const page = await get(`${base}/`);
    check('serves the SPA shell', page.status === 200 && page.text.includes('<div id="app">'));
    check('references the entry module', page.text.includes('/app/main.js'));

    const css = await get(`${base}/styles/main.css`);
    check('serves stylesheets', css.status === 200 && css.text.includes(':root'));

    const js = await get(`${base}/app/main.js`);
    check('serves client modules', js.status === 200 && js.text.includes('export'));

    // 7. Auth is required where it should be
    const guarded = await get(`${base}/api/player`);
    check('protects /api/player', guarded.status === 401);

    const missing = await get(`${base}/api/nope`);
    check('unknown API routes 404 as JSON', missing.status === 404 && missing.body?.error?.code === 'NOT_FOUND');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (stop) await stop();
  }

  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`Smoke: ${passed}/${checks.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('\nSmoke test crashed:', err.message);
  process.exit(1);
});
