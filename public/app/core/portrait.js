/**
 * ============================================================================
 * PROCEDURAL PORTRAIT RENDERER
 * ============================================================================
 *
 * Draws every fighter's artwork on a <canvas> from its data descriptor. There
 * are no image files in this project: 464 distinct portraits are synthesised
 * from a seed, an archetype silhouette, a hue pair and an aura colour.
 *
 * Why procedural?
 *   - Zero asset payload: the app ships as ~200 KB of text and still has
 *     unique art for every character.
 *   - Perfectly consistent style across the whole roster.
 *   - No third-party artwork, so there is no IP exposure.
 *
 * Performance: results are cached in an LRU keyed by `${seed}@${size}`, so a
 * scrolling roster grid re-paints from cache instead of re-drawing.
 */

/** Deterministic xorshift PRNG (mirrors the server's `seededRandom`). */
function seeded(seedText) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedText.length; i += 1) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = h || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;  state >>>= 0;
    return state / 4294967296;
  };
}

/** Silhouette proportions per archetype. */
const BUILDS = {
  BRAWLER:   { shoulder: 1.32, waist: 0.86, height: 0.96, head: 0.95, spike: 1.15 },
  CANNON:    { shoulder: 1.02, waist: 0.80, height: 1.02, head: 1.02, spike: 1.30 },
  BULWARK:   { shoulder: 1.45, waist: 1.02, height: 0.92, head: 0.90, spike: 0.85 },
  DUELIST:   { shoulder: 1.14, waist: 0.82, height: 1.00, head: 1.00, spike: 1.20 },
  TRICKSTER: { shoulder: 0.96, waist: 0.78, height: 1.04, head: 1.05, spike: 1.40 },
};

/** LRU cache of rendered canvases. */
const CACHE = new Map();
const CACHE_LIMIT = 320;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (hit) {
    // Refresh recency.
    CACHE.delete(key);
    CACHE.set(key, hit);
  }
  return hit;
}

function cacheSet(key, value) {
  CACHE.set(key, value);
  if (CACHE.size > CACHE_LIMIT) {
    CACHE.delete(CACHE.keys().next().value);
  }
}

/**
 * Render a fighter portrait into an offscreen canvas.
 *
 * @param {object} art  The fighter's `art` descriptor from the catalogue.
 * @param {number} size Pixel dimension (square).
 * @returns {HTMLCanvasElement}
 */
export function renderPortrait(art, size = 220) {
  const key = `${art.seed}@${size}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const rng = seeded(art.seed);
  const build = BUILDS[art.build] ?? BUILDS.DUELIST;
  const h1 = art.hue;
  const h2 = art.hue2;
  const intensity = art.intensity ?? 0.5;

  const cx = size / 2;
  const w = size;

  // ---------------------------------------------------------- background --
  const bg = ctx.createRadialGradient(cx, size * 0.42, size * 0.05, cx, size * 0.5, size * 0.72);
  bg.addColorStop(0, `hsl(${h1} 62% ${16 + intensity * 12}%)`);
  bg.addColorStop(0.55, `hsl(${h2} 54% 10%)`);
  bg.addColorStop(1, '#05060d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, size);

  // Radiating energy shafts behind the figure.
  ctx.save();
  ctx.translate(cx, size * 0.46);
  const shafts = 10 + Math.floor(rng() * 8);
  for (let i = 0; i < shafts; i += 1) {
    const angle = (i / shafts) * Math.PI * 2 + rng() * 0.3;
    const len = size * (0.34 + rng() * 0.4);
    const spread = 0.035 + rng() * 0.05;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(angle - spread) * len, Math.sin(angle - spread) * len);
    ctx.lineTo(Math.cos(angle + spread) * len, Math.sin(angle + spread) * len);
    ctx.closePath();
    ctx.fillStyle = `hsla(${h1 + rng() * 30 - 15} 90% 62% / ${0.05 + intensity * 0.09})`;
    ctx.fill();
  }
  ctx.restore();

  // ---------------------------------------------------------------- aura --
  const auraR = size * (0.3 + intensity * 0.1);
  const aura = ctx.createRadialGradient(cx, size * 0.5, auraR * 0.25, cx, size * 0.5, auraR);
  aura.addColorStop(0, `${art.aura}00`);
  aura.addColorStop(0.62, `${art.aura}${Math.round(intensity * 90).toString(16).padStart(2, '0')}`);
  aura.addColorStop(1, `${art.aura}00`);
  ctx.fillStyle = aura;
  ctx.fillRect(0, 0, w, size);

  // -------------------------------------------------------------- figure --
  const bodyTop = size * 0.30;
  const bodyBottom = size * 0.90 * build.height + size * 0.06;
  const shoulderW = size * 0.17 * build.shoulder;
  const waistW = size * 0.11 * build.waist;

  // Torso.
  const torso = ctx.createLinearGradient(cx - shoulderW, bodyTop, cx + shoulderW, bodyBottom);
  torso.addColorStop(0, `hsl(${h1} 68% 52%)`);
  torso.addColorStop(0.5, `hsl(${h1} 74% 38%)`);
  torso.addColorStop(1, `hsl(${h2} 66% 26%)`);

  ctx.beginPath();
  ctx.moveTo(cx - shoulderW, bodyTop + size * 0.045);
  ctx.quadraticCurveTo(cx - shoulderW * 1.06, bodyTop + size * 0.2, cx - waistW, bodyBottom * 0.78);
  ctx.lineTo(cx - waistW * 1.15, bodyBottom);
  ctx.lineTo(cx + waistW * 1.15, bodyBottom);
  ctx.lineTo(cx + waistW, bodyBottom * 0.78);
  ctx.quadraticCurveTo(cx + shoulderW * 1.06, bodyTop + size * 0.2, cx + shoulderW, bodyTop + size * 0.045);
  ctx.quadraticCurveTo(cx, bodyTop - size * 0.012, cx - shoulderW, bodyTop + size * 0.045);
  ctx.closePath();
  ctx.fillStyle = torso;
  ctx.fill();

  // Chest highlight — reads as a gi / armour plate.
  ctx.beginPath();
  ctx.moveTo(cx - shoulderW * 0.56, bodyTop + size * 0.06);
  ctx.lineTo(cx, bodyTop + size * 0.26);
  ctx.lineTo(cx + shoulderW * 0.56, bodyTop + size * 0.06);
  ctx.closePath();
  ctx.fillStyle = `hsla(${h2} 88% 72% / .3)`;
  ctx.fill();

  // Belt.
  ctx.fillStyle = `hsl(${h2} 78% 46%)`;
  ctx.fillRect(cx - waistW * 1.2, bodyBottom * 0.775, waistW * 2.4, size * 0.028);

  // Arms.
  const armW = size * 0.045 * build.shoulder;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + side * shoulderW * 0.94, bodyTop + size * 0.06);
    ctx.quadraticCurveTo(
      cx + side * shoulderW * 1.34, bodyTop + size * 0.2,
      cx + side * shoulderW * 1.1, bodyTop + size * 0.34
    );
    ctx.lineWidth = armW;
    ctx.lineCap = 'round';
    ctx.strokeStyle = `hsl(${h1} 60% 44%)`;
    ctx.stroke();
  }

  // Head.
  const headR = size * 0.072 * build.head;
  const headY = bodyTop - headR * 0.72;
  ctx.beginPath();
  ctx.arc(cx, headY, headR, 0, Math.PI * 2);
  const skin = ctx.createRadialGradient(cx - headR * 0.3, headY - headR * 0.3, 1, cx, headY, headR);
  skin.addColorStop(0, '#ffe6cf');
  skin.addColorStop(1, '#d9a982');
  ctx.fillStyle = skin;
  ctx.fill();

  // Hair — spiked crown, count and length driven by the seed.
  const spikes = 5 + Math.floor(rng() * 5);
  ctx.fillStyle = `hsl(${h2} 80% ${44 + intensity * 18}%)`;
  for (let i = 0; i < spikes; i += 1) {
    const t = i / (spikes - 1);
    const baseX = cx + (t - 0.5) * headR * 2.05;
    const lean = (t - 0.5) * 1.5;
    const len = headR * (1.15 + rng() * 1.5) * build.spike;
    ctx.beginPath();
    ctx.moveTo(baseX - headR * 0.24, headY - headR * 0.42);
    ctx.lineTo(baseX + lean * headR * 0.7, headY - headR * 0.42 - len);
    ctx.lineTo(baseX + headR * 0.24, headY - headR * 0.42);
    ctx.closePath();
    ctx.fill();
  }

  // Eyes — a determined glare.
  ctx.fillStyle = '#12131c';
  const eyeY = headY + headR * 0.06;
  const eyeDx = headR * 0.36;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * eyeDx, eyeY, headR * 0.14, headR * 0.1, side * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
  // Glowing iris matching the element.
  ctx.fillStyle = art.aura;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(cx + side * eyeDx, eyeY, headR * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }

  // ------------------------------------------------------ floating embers --
  const embers = 12 + Math.floor(intensity * 16);
  for (let i = 0; i < embers; i += 1) {
    const ex = rng() * w;
    const ey = size * 0.2 + rng() * size * 0.75;
    const er = 0.7 + rng() * 2.1;
    ctx.beginPath();
    ctx.arc(ex, ey, er, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${h1 + rng() * 40 - 20} 96% 72% / ${0.25 + rng() * 0.5})`;
    ctx.fill();
  }

  // Rim light along the figure's leading edge.
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const rim = ctx.createLinearGradient(cx - shoulderW, 0, cx + shoulderW, 0);
  rim.addColorStop(0, `${art.aura}00`);
  rim.addColorStop(0.06, `${art.aura}70`);
  rim.addColorStop(0.16, `${art.aura}00`);
  ctx.fillStyle = rim;
  ctx.fillRect(0, bodyTop - headR * 2, w, bodyBottom);
  ctx.restore();

  // Vignette to sink the edges.
  const vig = ctx.createRadialGradient(cx, size * 0.5, size * 0.28, cx, size * 0.5, size * 0.76);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,.62)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, size);

  cacheSet(key, canvas);
  return canvas;
}

/**
 * Paint a portrait into a live <canvas> element sized to its CSS box.
 * @param {HTMLCanvasElement} target
 * @param {object} art
 */
export function paintPortrait(target, art) {
  const rect = target.getBoundingClientRect();
  const size = Math.max(48, Math.round(Math.max(rect.width, rect.height) || 120));
  const source = renderPortrait(art, size);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  target.width = size * dpr;
  target.height = size * dpr;
  const ctx = target.getContext('2d');
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(source, 0, 0, target.width, target.height);
}

/**
 * Lazily paint portraits as they scroll into view. Keeps a 400-card roster
 * grid at 60fps by never drawing offscreen art.
 */
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const canvas = entry.target;
      const art = canvas.__art;
      if (art && !canvas.__painted) {
        paintPortrait(canvas, art);
        canvas.__painted = true;
      }
      observer.unobserve(canvas);
    }
  },
  { rootMargin: '180px' }
);

/** Register a canvas for lazy portrait painting. */
export function lazyPortrait(canvas, art) {
  canvas.__art = art;
  canvas.__painted = false;
  observer.observe(canvas);
}

/** Clear the cache (used when the roster changes wholesale). */
export function clearPortraitCache() {
  CACHE.clear();
}
