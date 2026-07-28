'use strict';
/**
 * End-to-end browser test.
 *
 * Drives a real Chrome instance through the complete player journey:
 * register → dashboard → summon (with reveal) → roster → battle → settings.
 * Fails on any console error, page error or failed network request, so a
 * runtime regression in the client cannot pass silently.
 *
 * Requires puppeteer + a Chrome binary; skipped automatically when absent.
 */

const path = require('node:path');
const fs = require('node:fs');

const PORT = Number(process.env.E2E_PORT ?? 3399);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, '..', '.shots');

let puppeteer;
try {
  puppeteer = require('/tmp/node_modules/puppeteer-core');
} catch {
  try { puppeteer = require('puppeteer'); } catch { /* unavailable */ }
}

function chromePath() {
  const fromFile = '/tmp/chrome-path.txt';
  if (fs.existsSync(fromFile)) return fs.readFileSync(fromFile, 'utf8').trim();
  return process.env.CHROME_PATH ?? null;
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
  const mark = condition ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  if (!puppeteer || !chromePath()) {
    console.log('E2E skipped: puppeteer or Chrome unavailable.');
    return 0;
  }

  fs.mkdirSync(SHOTS, { recursive: true });

  // --- boot an isolated server -------------------------------------------
  process.env.PORT = String(PORT);
  process.env.DATA_DIR = path.join(__dirname, '..', '.data-e2e');
  process.env.SESSION_SECRET = 'e2e-session-secret-e2e-session-secret';
  process.env.GACHA_SECRET = 'e2e-gacha-secret-e2e-gacha-secret-xx';
  process.env.LOG_LEVEL = 'warn';
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

  const { createApp } = require('../server/index.js');
  const { app, stop } = await createApp();
  const server = app.createServer();
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`\nE2E server listening on ${BASE}\n`);

  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--window-size=1280,900', '--use-gl=swiftshader', '--enable-webgl'],
  });

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('requestfailed', (req) => {
      // Google Fonts is optional and may be blocked in a sandbox.
      if (!req.url().includes('fonts.g')) failedRequests.push(`${req.url()} ${req.failure()?.errorText}`);
    });

    // ---------------------------------------------------------- 1. landing --
    console.log('1. Landing / auth');
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('form', { timeout: 10000 });
    const heroText = await page.$eval('body', (b) => b.innerText);
    check('landing renders', /zero cost|start your legend/i.test(heroText));
    check('founder grant advertised', heroText.includes('25,000'));
    check('free pass advertised', /Legends Pass/i.test(heroText));
    await page.screenshot({ path: path.join(SHOTS, '01-landing.png') });

    // --------------------------------------------------------- 2. register --
    console.log('\n2. Registration');
    const email = `e2e${Date.now()}@test.dev`;
    await page.type('input[name="displayName"]', 'Solvane');
    await page.type('input[name="email"]', email);
    await page.type('input[name="password"]', 'verySecurePass123');
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForFunction(
        () => document.querySelector('.nav-btn') && /legends pass/i.test(document.body.innerText),
        { timeout: 20000 }
      ),
    ]);
    const dash = await page.$eval('body', (b) => b.innerText);
    check('dashboard loaded', dash.includes('Solvane') && /account level/i.test(dash));
    check('pass active on dashboard', /legends pass/i.test(dash));
    check('wallet shows crystals', /25(\.0)?K|25,000/.test(dash));
    await page.screenshot({ path: path.join(SHOTS, '02-dashboard.png') });

    // ----------------------------------------------------------- 3. summon --
    console.log('\n3. Summon + reveal');
    await page.evaluate(() => {
      [...document.querySelectorAll('.nav-btn')].find((b) => b.dataset.route === 'summon')?.click();
    });
    await page.waitForFunction(() => /published rates/i.test(document.body.innerText), { timeout: 10000 });
    check('summon view renders', true);
    await page.screenshot({ path: path.join(SHOTS, '03-summon.png') });

    // Fire a multi-summon and wait for the reveal grid.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Summon ×10'));
      btn?.click();
    });
    await page.waitForFunction(
      () => /limit breaks/i.test(document.body.innerText),
      { timeout: 30000 }
    );
    check('summon reveal played', true);
    // Let the staggered card entrance finish before capturing.
    await new Promise((r) => setTimeout(r, 1200));
    const revealed = await page.evaluate(() =>
      [...document.querySelectorAll('canvas')].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 40 && r.height > 40 && getComputedStyle(c).opacity !== '0';
      }).length
    );
    check('reveal shows fighter art', revealed >= 5, `${revealed} portraits`);
    await page.screenshot({ path: path.join(SHOTS, '04-summon-reveal.png') });
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Continue')?.click();
    });
    await new Promise((r) => setTimeout(r, 700));

    // ----------------------------------------------------------- 4. roster --
    console.log('\n4. Roster');
    await page.evaluate(() => {
      [...document.querySelectorAll('.nav-btn')].find((b) => b.dataset.route === 'roster')?.click();
    });
    await page.waitForSelector('.fcard', { timeout: 10000 });
    const cardCount = await page.$$eval('.fcard', (n) => n.length);
    // A 10-pull can contain duplicates, which correctly merge into Z-Power
    // rather than creating additional roster rows — so the unique-fighter
    // count after one multi is <= 10, not exactly 10.
    check('roster grid populated', cardCount >= 5 && cardCount <= 10, `${cardCount} unique fighters`);
    // Portraits must actually paint (non-blank canvas).
    await new Promise((r) => setTimeout(r, 900));
    const painted = await page.evaluate(() => {
      const c = document.querySelector('.fcard-art canvas');
      if (!c || !c.width) return false;
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonBlank = 0;
      for (let i = 3; i < d.length; i += 4000) if (d[i] > 0) nonBlank += 1;
      return nonBlank > 5;
    });
    check('procedural portraits painted', painted);
    await page.screenshot({ path: path.join(SHOTS, '05-roster.png') });

    // Open a fighter detail sheet.
    await page.click('.fcard');
    await page.waitForSelector('.modal', { timeout: 6000 });
    const detail = await page.$eval('.modal', (m) => m.innerText);
    check('fighter detail opens', /signature moves/i.test(detail));
    check('abilities listed', /abilities/i.test(detail));
    await page.screenshot({ path: path.join(SHOTS, '06-fighter-detail.png') });
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 400));

    // ----------------------------------------------------------- 5. battle --
    console.log('\n5. Battle');
    await page.evaluate(() => {
      [...document.querySelectorAll('.nav-btn')].find((b) => b.dataset.route === 'battle')?.click();
    });
    await page.waitForFunction(() => /your team/i.test(document.body.innerText), { timeout: 10000 });
    check('stage select renders', true);
    await page.screenshot({ path: path.join(SHOTS, '07-stage-select.png') });

    // Start the first stage.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /Fractured Sky 1/.test(b.innerText));
      btn?.click();
    });
    await page.waitForSelector('.arena', { timeout: 15000 });
    await page.waitForSelector('.acard', { timeout: 15000 });
    check('arena opened', true);
    const handSize = await page.$$eval('.acard', (n) => n.length);
    check('arts hand dealt', handSize === 4, `${handSize} cards`);
    const hudText = await page.$eval('.hud', (h) => h.innerText);
    check('HUD shows both fighters', hudText.split('\n').length > 3);
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(SHOTS, '08-arena.png') });

    // Play cards until the battle resolves.
    let turns = 0;
    let ended = false;
    while (turns < 110 && !ended) {
      const acted = await page.evaluate(() => {
        const playable = [...document.querySelectorAll('.acard')].find((c) => !c.classList.contains('locked'));
        if (playable) { playable.click(); return 'card'; }
        // NOTE: CSS `text-transform: uppercase` means innerText is uppercased,
        // so these matches must be case-insensitive.
        const rush = [...document.querySelectorAll('.act-btn')]
          .find((b) => !b.disabled && /rising/i.test(b.innerText));
        if (rush) { rush.click(); return 'rush'; }
        const charge = [...document.querySelectorAll('.act-btn')]
          .find((b) => !b.disabled && /charge/i.test(b.innerText));
        if (charge) { charge.click(); return 'charge'; }
        return null;
      });
      if (!acted) await new Promise((r) => setTimeout(r, 400));
      await new Promise((r) => setTimeout(r, 620));
      ended = await page.evaluate(() => Boolean(document.querySelector('.result')));
      if (turns === 3) await page.screenshot({ path: path.join(SHOTS, '09-combat.png') });
      turns += 1;
    }
    check('battle reached a result', ended, `${turns} actions`);
    if (ended) {
      const resultText = await page.$eval('.result', (r) => r.innerText);
      check('result screen shows outcome', /VICTORY|DEFEAT/.test(resultText));
      await page.screenshot({ path: path.join(SHOTS, '10-result.png') });
      await page.evaluate(() => {
        [...document.querySelectorAll('.result button')].find((b) => /Back to stages/.test(b.innerText))?.click();
      });
      await new Promise((r) => setTimeout(r, 1500));
    }

    // --------------------------------------------------------- 6. settings --
    console.log('\n6. Settings');
    await page.evaluate(() => {
      [...document.querySelectorAll('.nav-btn')].find((b) => b.dataset.route === 'settings')?.click();
    });
    await page.waitForFunction(() => /provably-fair/i.test(document.body.innerText), { timeout: 10000 });
    const settingsText = await page.$eval('body', (b) => b.innerText);
    check('settings renders', /provably-fair summons/i.test(settingsText));
    check('ledger present', /currency ledger/i.test(settingsText));
    check('free-forever stated', /free forever/i.test(settingsText));
    await page.screenshot({ path: path.join(SHOTS, '11-settings.png') });

    // --------------------------------------------------------- 7. mobile ---
    console.log('\n7. Mobile viewport');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
    await page.evaluate(() => {
      [...document.querySelectorAll('.nav-btn')].find((b) => b.dataset.route === 'home')?.click();
    });
    await new Promise((r) => setTimeout(r, 800));
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    check('no horizontal overflow on mobile', overflow <= 1, `${overflow}px`);
    await page.screenshot({ path: path.join(SHOTS, '12-mobile.png') });

    // ------------------------------------------------------- 8. diagnostics --
    console.log('\n8. Runtime diagnostics');
    check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    check('no failed requests', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));
  } catch (err) {
    console.error('\nE2E crashed:', err.message);
    check('e2e completed without throwing', false, err.message);
    exitCode = 1;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await stop();
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`E2E: ${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  console.log(`Screenshots: ${SHOTS}`);
  return failed > 0 ? 1 : exitCode;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
