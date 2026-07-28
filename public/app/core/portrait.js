/**
 * ============================================================================
 * PROCEDURAL PORTRAIT RENDERER  ·  v2 "Art Team" edition
 * ============================================================================
 *
 * Draws every fighter's artwork on a <canvas> from its data descriptor. There
 * are no image files in this project: 464 distinct portraits are synthesised
 * from a seed, an archetype silhouette, a hue pair and an aura colour.
 *
 * WHY PROCEDURAL
 *   - Zero asset payload: unique art for 464 characters in ~0 bytes of images.
 *   - Perfectly consistent style across the whole roster.
 *   - 100% original — no third-party artwork, so no IP exposure.
 *
 * v2 UPGRADES (art direction pass)
 *   - Cel-shaded rendering: flat base + hard shadow terminator + rim light,
 *     the defining look of anime key art, instead of flat vector shapes.
 *   - Real anatomy: tapered torso, deltoids, forearms, gloves, boots, legs.
 *   - Costume system: 6 outfit archetypes (gi, armour, bodysuit, coat, robe,
 *     battlesuit) with belts, sashes, shoulder plates and chest emblems.
 *   - Hair system: 7 styles (spiked, flame, long, braided, crown, mane, bald)
 *     with per-strand highlights, driven by lineage seed.
 *   - Capes, scarves and shoulder pauldrons for silhouette variety.
 *   - Layered aura: inner core glow, outer bloom, upward energy wisps and
 *     ground-level embers, scaled by rarity.
 *   - Face: brow, eyes with iris + specular highlight, nose, mouth, jaw shading.
 *
 * PERFORMANCE
 *   Results are cached in an LRU keyed by `${seed}@${size}`, so a scrolling
 *   464-card roster grid re-paints from cache instead of re-drawing. Painting
 *   is further deferred by IntersectionObserver (see `lazyPortrait`).
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
  BRAWLER:   { shoulder: 1.34, waist: 0.88, height: 0.97, head: 0.94, spike: 1.15, muscle: 1.25 },
  CANNON:    { shoulder: 1.02, waist: 0.78, height: 1.03, head: 1.02, spike: 1.30, muscle: 0.85 },
  BULWARK:   { shoulder: 1.50, waist: 1.04, height: 0.93, head: 0.90, spike: 0.85, muscle: 1.40 },
  DUELIST:   { shoulder: 1.15, waist: 0.80, height: 1.01, head: 1.00, spike: 1.20, muscle: 1.05 },
  TRICKSTER: { shoulder: 0.95, waist: 0.76, height: 1.05, head: 1.06, spike: 1.42, muscle: 0.80 },
};

/** Costume archetypes. Chosen by seed; each reads clearly in silhouette. */
const OUTFITS = ['gi', 'armour', 'bodysuit', 'coat', 'robe', 'battlesuit'];

/** Hair archetypes. */
const HAIR = ['spiked', 'flame', 'long', 'braided', 'crown', 'mane', 'bald'];

/** Skin tone ramp — varied, and independent of the element palette. */
const SKINS = [
  ['#ffe0c4', '#e8b48c', '#c98e66'],
  ['#f6cfa8', '#d9a173', '#b57a4e'],
  ['#e8b98f', '#c9925f', '#a06f42'],
  ['#c98f63', '#a86f45', '#84522f'],
  ['#8d5a3b', '#6f4429', '#52301b'],
  ['#d8e4f0', '#adbfd6', '#8497b3'], // pale/ethereal
  ['#cfe8d8', '#a3c9b4', '#7ea690'], // otherworldly
];

/** LRU cache of rendered canvases. */
const CACHE = new Map();
const CACHE_LIMIT = 320;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (hit) { CACHE.delete(key); CACHE.set(key, hit); }
  return hit;
}

function cacheSet(key, value) {
  CACHE.set(key, value);
  if (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value);
}

/* -------------------------------------------------------------- helpers -- */

/** `hsl()` string builder. */
const hsl = (h, s, l, a = 1) =>
  a === 1 ? `hsl(${h} ${s}% ${l}%)` : `hsla(${h} ${s}% ${l}% / ${a})`;

/** Fill the current path with a vertical two-stop gradient. */
function fillVertical(ctx, x0, y0, y1, top, bottom) {
  const g = ctx.createLinearGradient(x0, y0, x0, y1);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fill();
}

/**
 * Cel-shading pass: clip to the current shape, then lay a hard-edged shadow
 * across one side. This single technique is what separates "flat vector" from
 * "anime cel art".
 */
function celShade(ctx, drawShape, cx, size, shadowColour, lightFromLeft = true) {
  ctx.save();
  drawShape();
  ctx.clip();
  ctx.beginPath();
  const edge = lightFromLeft ? cx + size * 0.02 : cx - size * 0.02;
  if (lightFromLeft) ctx.rect(edge, 0, size, size);
  else ctx.rect(0, 0, edge, size);
  ctx.fillStyle = shadowColour;
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------- renderer -- */

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
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const rng = seeded(art.seed);
  const build = BUILDS[art.build] ?? BUILDS.DUELIST;
  const h1 = art.hue;
  const h2 = art.hue2;
  const intensity = art.intensity ?? 0.5;
  const aura = art.aura;

  /*
   * Colour harmony.
   *
   * The raw hue1/hue2 pair from the catalogue is an arbitrary offset and can
   * land on clashing combinations (magenta + olive). We keep hue1 as the
   * costume identity and derive the secondary from a chosen harmony rule, so
   * every fighter reads as intentionally art-directed.
   */
  const HARMONIES = [
    (h) => (h + 180) % 360,  // complementary
    (h) => (h + 150) % 360,  // split-complementary
    (h) => (h + 30) % 360,   // analogous warm
    (h) => (h + 330) % 360,  // analogous cool
    (h) => (h + 120) % 360,  // triadic
  ];
  const accent = HARMONIES[Math.floor(rng() * HARMONIES.length)](h1);

  const outfit = OUTFITS[Math.floor(rng() * OUTFITS.length)];
  const hairStyle = HAIR[Math.floor(rng() * HAIR.length)];
  const skin = SKINS[Math.floor(rng() * SKINS.length)];
  const hasCape = rng() > 0.55;
  const hasPauldrons = outfit === 'armour' || outfit === 'battlesuit' || rng() > 0.7;
  const hasScarf = !hasCape && rng() > 0.6;

  const S = size;
  const cx = S / 2;

  /* ------------------------------------------------------- background -- */
  const bg = ctx.createRadialGradient(cx, S * 0.40, S * 0.04, cx, S * 0.52, S * 0.78);
  bg.addColorStop(0, hsl(h1, 64, 18 + intensity * 14));
  bg.addColorStop(0.5, hsl(accent, 50, 10));
  bg.addColorStop(1, '#04050b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);

  // Radiating energy shafts.
  ctx.save();
  ctx.translate(cx, S * 0.46);
  const shafts = 12 + Math.floor(rng() * 10);
  for (let i = 0; i < shafts; i += 1) {
    const a = (i / shafts) * Math.PI * 2 + rng() * 0.3;
    const len = S * (0.36 + rng() * 0.44);
    const spread = 0.03 + rng() * 0.05;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a - spread) * len, Math.sin(a - spread) * len);
    ctx.lineTo(Math.cos(a + spread) * len, Math.sin(a + spread) * len);
    ctx.closePath();
    ctx.fillStyle = hsl(h1 + rng() * 30 - 15, 92, 64, 0.035 + intensity * 0.05);
    ctx.fill();
  }
  ctx.restore();

  /* ------------------------------------------------ outer aura bloom --- */
  const auraR = S * (0.30 + intensity * 0.12);
  const bloom = ctx.createRadialGradient(cx, S * 0.5, auraR * 0.2, cx, S * 0.5, auraR);
  bloom.addColorStop(0, `${aura}00`);
  bloom.addColorStop(0.55, `${aura}${Math.round(intensity * 52).toString(16).padStart(2, '0')}`);
  bloom.addColorStop(1, `${aura}00`);
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, S, S);

  /* -------------------------------------------------------- geometry --- */
  // Proportions tuned to a heroic ~7.5-head figure: the torso occupies the
  // upper third and the legs a full 40% of height, which is what stops the
  // silhouette reading as squat/barrel-shaped.
  const headR = S * 0.062 * build.head;
  const neckY = S * 0.255;
  const shoulderY = neckY + headR * 0.55;
  const hipY = S * 0.560;
  const footY = S * 0.935 * build.height + S * 0.03;
  const shoulderW = S * 0.118 * build.shoulder;
  const waistW = S * 0.070 * build.waist;
  const headY = neckY - headR * 0.98;

  // Costume palette.
  const outfitBase = hsl(h1, 62, 44);
  const outfitDark = hsl(h1, 68, 26);
  const outfitShade = hsl(h1, 66, 20, 0.5);
  const trim = hsl(accent, 76, 56);
  const trimDark = hsl(accent, 78, 34);
  const capeHue = accent;

  /* ------------------------------------------------------------ cape --- */
  if (hasCape) {
    ctx.beginPath();
    ctx.moveTo(cx - shoulderW * 0.88, shoulderY);
    ctx.quadraticCurveTo(cx - shoulderW * 1.42, S * 0.62, cx - shoulderW * 0.92, footY * 0.86);
    ctx.quadraticCurveTo(cx, footY * 0.80, cx + shoulderW * 0.92, footY * 0.86);
    ctx.quadraticCurveTo(cx + shoulderW * 1.42, S * 0.62, cx + shoulderW * 0.88, shoulderY);
    ctx.closePath();
    fillVertical(ctx, cx, shoulderY, footY, hsl(capeHue, 62, 30), hsl(capeHue, 68, 13));
    // Inner fold shadow.
    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(cx, shoulderY);
    ctx.lineTo(cx + shoulderW * 2, footY);
    ctx.lineTo(cx + shoulderW * 2, shoulderY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    ctx.fill();
    ctx.restore();
  }

  /* ------------------------------------------------------------ legs --- */
  const legW = S * 0.042 * build.muscle;
  for (const side of [-1, 1]) {
    const hipX = cx + side * waistW * 0.60;
    const footX = cx + side * waistW * 0.92;
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.quadraticCurveTo(hipX + side * legW * 0.3, (hipY + footY) / 2, footX, footY - S * 0.045);
    ctx.lineWidth = legW;
    ctx.strokeStyle = outfit === 'robe' ? hsl(h1, 60, 34) : outfitDark;
    ctx.stroke();
    // Boot.
    ctx.beginPath();
    ctx.moveTo(footX, footY - S * 0.055);
    ctx.lineTo(footX, footY);
    ctx.lineWidth = legW * 1.24;
    ctx.strokeStyle = trimDark;
    ctx.stroke();
  }

  /* ----------------------------------------------------------- torso --- */
  const torsoPath = () => {
    ctx.beginPath();
    ctx.moveTo(cx - shoulderW, shoulderY + S * 0.012);
    // Lat flare then a pronounced inward taper to the waist.
    ctx.quadraticCurveTo(cx - shoulderW * 0.98, shoulderY + S * 0.070, cx - waistW, hipY - S * 0.02);
    ctx.lineTo(cx - waistW * 1.10, hipY);
    ctx.lineTo(cx + waistW * 1.10, hipY);
    ctx.lineTo(cx + waistW, hipY - S * 0.02);
    ctx.quadraticCurveTo(cx + shoulderW * 0.98, shoulderY + S * 0.070, cx + shoulderW, shoulderY + S * 0.012);
    ctx.quadraticCurveTo(cx, shoulderY - S * 0.020, cx - shoulderW, shoulderY + S * 0.012);
    ctx.closePath();
  };
  torsoPath();
  fillVertical(ctx, cx, shoulderY, hipY, outfitBase, outfitDark);
  celShade(ctx, torsoPath, cx, S, outfitShade, true);

  // Costume detailing.
  ctx.save();
  torsoPath();
  ctx.clip();
  if (outfit === 'gi') {
    // Crossed lapels.
    ctx.beginPath();
    ctx.moveTo(cx - shoulderW * 0.62, shoulderY);
    ctx.lineTo(cx + waistW * 0.30, hipY);
    ctx.lineTo(cx + shoulderW * 0.20, hipY);
    ctx.lineTo(cx - shoulderW * 0.20, shoulderY);
    ctx.closePath();
    ctx.fillStyle = hsl(accent, 68, 50, 0.92);
    ctx.fill();
  } else if (outfit === 'armour') {
    // Chest plate with a central ridge.
    ctx.beginPath();
    ctx.moveTo(cx - shoulderW * 0.74, shoulderY + S * 0.02);
    ctx.lineTo(cx, shoulderY + S * 0.10);
    ctx.lineTo(cx + shoulderW * 0.74, shoulderY + S * 0.02);
    ctx.lineTo(cx + shoulderW * 0.58, hipY - S * 0.03);
    ctx.lineTo(cx - shoulderW * 0.58, hipY - S * 0.03);
    ctx.closePath();
    ctx.fillStyle = hsl(accent, 36, 60, 0.88);
    ctx.fill();
    ctx.strokeStyle = hsl(accent, 56, 80, 0.7);
    ctx.lineWidth = S * 0.006;
    ctx.stroke();
  } else if (outfit === 'bodysuit' || outfit === 'battlesuit') {
    // Panel lines.
    ctx.strokeStyle = trim;
    ctx.lineWidth = S * 0.007;
    ctx.beginPath();
    ctx.moveTo(cx, shoulderY); ctx.lineTo(cx, hipY);
    ctx.moveTo(cx - shoulderW * 0.6, shoulderY + S * 0.06);
    ctx.lineTo(cx + shoulderW * 0.6, shoulderY + S * 0.06);
    ctx.stroke();
  } else if (outfit === 'coat') {
    // Open front revealing an undershirt.
    ctx.fillStyle = hsl(accent, 28, 18);
    ctx.fillRect(cx - waistW * 0.55, shoulderY, waistW * 1.1, hipY - shoulderY);
  }
  // Chest emblem.
  if (rng() > 0.45) {
    ctx.beginPath();
    ctx.arc(cx, shoulderY + S * 0.075, S * 0.026, 0, Math.PI * 2);
    ctx.fillStyle = aura;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // Belt / sash.
  ctx.fillStyle = trim;
  ctx.fillRect(cx - waistW * 1.16, hipY - S * 0.026, waistW * 2.32, S * 0.030);
  ctx.fillStyle = hsl(accent, 80, 38);
  ctx.fillRect(cx - waistW * 1.16, hipY - S * 0.004, waistW * 2.32, S * 0.008);

  /* ------------------------------------------------------------ arms --- */
  /*
   * Arms are drawn as filled tapered polygons anchored INSIDE the shoulder
   * line, not as stroked lines offset from it. Stroking from an offset origin
   * was leaving a visible gap so the arms read as detached floating blobs.
   */
  const drawArm = (side) => {
    const rootX = cx + side * shoulderW * 0.80;   // inside the torso edge
    const rootY = shoulderY + S * 0.010;
    const elbowX = cx + side * shoulderW * 1.12;
    const elbowY = shoulderY + S * 0.098;
    const wristX = cx + side * shoulderW * 1.02;
    const wristY = shoulderY + S * 0.186;
    const upperW = S * 0.030 * build.muscle;
    const foreW = S * 0.024 * build.muscle;

    ctx.beginPath();
    ctx.moveTo(rootX - side * upperW * 0.9, rootY);
    ctx.quadraticCurveTo(cx + side * shoulderW * 1.20, shoulderY + S * 0.048,
                         elbowX - side * foreW * 0.5, elbowY);
    ctx.quadraticCurveTo(cx + side * shoulderW * 1.14, shoulderY + S * 0.146,
                         wristX - side * foreW * 0.6, wristY);
    ctx.lineTo(wristX + side * foreW * 0.6, wristY);
    ctx.quadraticCurveTo(cx + side * shoulderW * 1.26, shoulderY + S * 0.140,
                         elbowX + side * foreW * 0.6, elbowY);
    ctx.quadraticCurveTo(cx + side * shoulderW * 1.32, shoulderY + S * 0.044,
                         rootX + side * upperW * 0.9, rootY);
    ctx.closePath();

    const sleeve = (outfit === 'bodysuit' || outfit === 'battlesuit' || outfit === 'armour');
    const g = ctx.createLinearGradient(rootX, rootY, wristX, wristY);
    g.addColorStop(0, sleeve ? outfitBase : skin[0]);
    g.addColorStop(1, sleeve ? outfitDark : skin[2]);
    ctx.fillStyle = g;
    ctx.fill();

    // Glove / wrist wrap.
    ctx.beginPath();
    ctx.ellipse(wristX, wristY + S * 0.006, foreW * 0.95, foreW * 1.15,
                side * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = trimDark;
    ctx.fill();

    // Shoulder pauldron: a shallow cap that follows the deltoid, not a balloon.
    if (hasPauldrons) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx + side * shoulderW * 0.92, shoulderY + S * 0.012,
                  shoulderW * 0.40, S * 0.026, side * 0.30, Math.PI, Math.PI * 2);
      ctx.closePath();
      const pg = ctx.createLinearGradient(0, shoulderY - S * 0.02, 0, shoulderY + S * 0.03);
      pg.addColorStop(0, hsl(accent, 44, 66));
      pg.addColorStop(1, hsl(accent, 54, 36));
      ctx.fillStyle = pg;
      ctx.fill();
      ctx.restore();
    }
  };
  drawArm(-1);
  drawArm(1);

  /* ------------------------------------------------------------ neck --- */
  ctx.beginPath();
  ctx.moveTo(cx - headR * 0.32, neckY - headR * 0.30);
  ctx.lineTo(cx - headR * 0.30, shoulderY);
  ctx.lineTo(cx + headR * 0.30, shoulderY);
  ctx.lineTo(cx + headR * 0.32, neckY - headR * 0.30);
  ctx.closePath();
  ctx.fillStyle = skin[2];
  ctx.fill();

  // Scarf.
  if (hasScarf) {
    ctx.beginPath();
    ctx.ellipse(cx, shoulderY - S * 0.004, headR * 0.86, headR * 0.32, 0, 0, Math.PI * 2);
    ctx.fillStyle = hsl(accent, 70, 48);
    ctx.fill();
  }

  /* ------------------------------------------------------------ head --- */
  const headPath = () => {
    ctx.beginPath();
    // Rounded skull tapering to a defined chin.
    ctx.moveTo(cx - headR, headY);
    ctx.quadraticCurveTo(cx - headR, headY - headR * 0.95, cx, headY - headR * 0.95);
    ctx.quadraticCurveTo(cx + headR, headY - headR * 0.95, cx + headR, headY);
    ctx.quadraticCurveTo(cx + headR * 0.96, headY + headR * 0.72, cx, headY + headR * 1.10);
    ctx.quadraticCurveTo(cx - headR * 0.96, headY + headR * 0.72, cx - headR, headY);
    ctx.closePath();
  };
  headPath();
  const skinGrad = ctx.createLinearGradient(cx - headR, headY - headR, cx + headR, headY + headR);
  skinGrad.addColorStop(0, skin[0]);
  skinGrad.addColorStop(0.55, skin[1]);
  skinGrad.addColorStop(1, skin[2]);
  ctx.fillStyle = skinGrad;
  ctx.fill();
  celShade(ctx, headPath, cx, S, 'rgba(90,50,30,.26)', true);

  /* ------------------------------------------------------------ hair --- */
  const hairBase = hsl(accent, 74, 42 + intensity * 14);
  const hairLight = hsl(accent, 84, 64 + intensity * 12);
  ctx.fillStyle = hairBase;

  if (hairStyle !== 'bald') {
    if (hairStyle === 'long' || hairStyle === 'mane') {
      // Volume falling behind the shoulders.
      ctx.beginPath();
      ctx.moveTo(cx - headR * 1.05, headY - headR * 0.2);
      ctx.quadraticCurveTo(cx - headR * 1.9, headY + headR * 2.4, cx - headR * 0.7, headY + headR * 3.2);
      ctx.lineTo(cx + headR * 0.7, headY + headR * 3.2);
      ctx.quadraticCurveTo(cx + headR * 1.9, headY + headR * 2.4, cx + headR * 1.05, headY - headR * 0.2);
      ctx.closePath();
      ctx.fillStyle = hsl(accent, 68, 28);
      ctx.fill();
    }

    // Cap covering the crown.
    ctx.beginPath();
    ctx.moveTo(cx - headR * 1.02, headY - headR * 0.05);
    ctx.quadraticCurveTo(cx, headY - headR * 1.35, cx + headR * 1.02, headY - headR * 0.05);
    ctx.quadraticCurveTo(cx + headR * 0.7, headY - headR * 0.55, cx, headY - headR * 0.48);
    ctx.quadraticCurveTo(cx - headR * 0.7, headY - headR * 0.55, cx - headR * 1.02, headY - headR * 0.05);
    ctx.closePath();
    ctx.fillStyle = hairBase;
    ctx.fill();

    if (hairStyle === 'spiked' || hairStyle === 'flame' || hairStyle === 'crown' || hairStyle === 'mane') {
      const spikes = hairStyle === 'crown' ? 3 + Math.floor(rng() * 2) : 5 + Math.floor(rng() * 5);
      for (let i = 0; i < spikes; i += 1) {
        const t = spikes === 1 ? 0.5 : i / (spikes - 1);
        const baseX = cx + (t - 0.5) * headR * 2.0;
        const lean = (t - 0.5) * (hairStyle === 'flame' ? 2.4 : 1.5);
        const len = headR * (1.1 + rng() * 1.6) * build.spike;
        const tipX = baseX + lean * headR * 0.75;
        const tipY = headY - headR * 0.52 - len;
        ctx.beginPath();
        ctx.moveTo(baseX - headR * 0.26, headY - headR * 0.42);
        if (hairStyle === 'flame') {
          ctx.quadraticCurveTo(baseX - headR * 0.1, tipY + len * 0.4, tipX, tipY);
          ctx.quadraticCurveTo(baseX + headR * 0.3, tipY + len * 0.45, baseX + headR * 0.26, headY - headR * 0.42);
        } else {
          ctx.lineTo(tipX, tipY);
          ctx.lineTo(baseX + headR * 0.26, headY - headR * 0.42);
        }
        ctx.closePath();
        const hg = ctx.createLinearGradient(baseX, headY, tipX, tipY);
        hg.addColorStop(0, hairBase);
        hg.addColorStop(1, hairLight);
        ctx.fillStyle = hg;
        ctx.fill();
      }
    } else if (hairStyle === 'braided') {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + side * headR * 0.9, headY - headR * 0.1);
        ctx.quadraticCurveTo(cx + side * headR * 1.6, headY + headR * 1.4,
                             cx + side * headR * 1.1, headY + headR * 2.4);
        ctx.lineWidth = headR * 0.42;
        ctx.strokeStyle = hairBase;
        ctx.stroke();
      }
    }

    // Specular highlight band.
    ctx.beginPath();
    ctx.ellipse(cx - headR * 0.32, headY - headR * 0.62, headR * 0.42, headR * 0.14, -0.4, 0, Math.PI * 2);
    ctx.fillStyle = hsl(accent, 86, 80, 0.5);
    ctx.fill();
  }

  /* ------------------------------------------------------------ face --- */
  const eyeY = headY + headR * 0.10;
  const eyeDx = headR * 0.40;

  // Brows — the main expression driver.
  ctx.strokeStyle = hsl(accent, 64, 24);
  ctx.lineWidth = headR * 0.11;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + side * (eyeDx - headR * 0.20), eyeY - headR * 0.30);
    ctx.lineTo(cx + side * (eyeDx + headR * 0.20), eyeY - headR * 0.20);
    ctx.stroke();
  }

  for (const side of [-1, 1]) {
    // Sclera.
    ctx.beginPath();
    ctx.ellipse(cx + side * eyeDx, eyeY, headR * 0.20, headR * 0.145, side * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = '#fdfdff';
    ctx.fill();
    // Iris tinted by the element aura.
    ctx.beginPath();
    ctx.ellipse(cx + side * eyeDx, eyeY, headR * 0.095, headR * 0.125, 0, 0, Math.PI * 2);
    ctx.fillStyle = aura;
    ctx.fill();
    // Pupil.
    ctx.beginPath();
    ctx.ellipse(cx + side * eyeDx, eyeY, headR * 0.042, headR * 0.075, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#14131c';
    ctx.fill();
    // Specular catchlight.
    ctx.beginPath();
    ctx.arc(cx + side * eyeDx - headR * 0.05, eyeY - headR * 0.05, headR * 0.032, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fill();
    // Upper lash line.
    ctx.beginPath();
    ctx.moveTo(cx + side * (eyeDx - headR * 0.21), eyeY - headR * 0.10);
    ctx.lineTo(cx + side * (eyeDx + headR * 0.21), eyeY - headR * 0.055);
    ctx.lineWidth = headR * 0.055;
    ctx.strokeStyle = '#1b1922';
    ctx.stroke();
  }

  // Nose and mouth.
  ctx.strokeStyle = 'rgba(120,70,45,.55)';
  ctx.lineWidth = headR * 0.05;
  ctx.beginPath();
  ctx.moveTo(cx + headR * 0.04, eyeY + headR * 0.26);
  ctx.lineTo(cx - headR * 0.03, eyeY + headR * 0.40);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - headR * 0.20, eyeY + headR * 0.62);
  ctx.quadraticCurveTo(cx, eyeY + headR * (rng() > 0.5 ? 0.70 : 0.56), cx + headR * 0.20, eyeY + headR * 0.62);
  ctx.lineWidth = headR * 0.055;
  ctx.strokeStyle = 'rgba(110,55,45,.75)';
  ctx.stroke();

  /* --------------------------------------------------- aura & effects -- */
  // Inner core glow hugging the silhouette.
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  // Kept deliberately weak: a strong screen-blend core desaturates the
  // character it is meant to frame.
  const core = ctx.createRadialGradient(cx, S * 0.52, S * 0.02, cx, S * 0.52, S * 0.24);
  core.addColorStop(0, `${aura}${Math.round(intensity * 34).toString(16).padStart(2, '0')}`);
  core.addColorStop(1, `${aura}00`);
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();

  // Upward energy wisps.
  const wisps = Math.round(6 + intensity * 12);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < wisps; i += 1) {
    const wx = cx + (rng() - 0.5) * S * 0.52;
    const wy = S * (0.55 + rng() * 0.35);
    const wh = S * (0.06 + rng() * 0.16);
    ctx.beginPath();
    ctx.moveTo(wx, wy);
    ctx.quadraticCurveTo(wx + (rng() - 0.5) * S * 0.06, wy - wh * 0.6, wx + (rng() - 0.5) * S * 0.03, wy - wh);
    ctx.lineWidth = S * (0.004 + rng() * 0.008);
    ctx.strokeStyle = hsl(h1 + rng() * 40 - 20, 96, 70, 0.25 + rng() * 0.45);
    ctx.stroke();
  }
  ctx.restore();

  // Floating embers.
  const embers = 14 + Math.floor(intensity * 18);
  for (let i = 0; i < embers; i += 1) {
    const ex = rng() * S;
    const ey = S * 0.18 + rng() * S * 0.78;
    const er = 0.6 + rng() * 2.0;
    ctx.beginPath();
    ctx.arc(ex, ey, er, 0, Math.PI * 2);
    ctx.fillStyle = hsl(h1 + rng() * 40 - 20, 96, 74, 0.25 + rng() * 0.5);
    ctx.fill();
  }

  // Rim light along the leading edge.
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const rim = ctx.createLinearGradient(cx - shoulderW, 0, cx + shoulderW, 0);
  rim.addColorStop(0, `${aura}00`);
  rim.addColorStop(0.07, `${aura}5c`);
  rim.addColorStop(0.20, `${aura}00`);
  ctx.fillStyle = rim;
  ctx.fillRect(0, headY - headR * 2, S, footY);
  ctx.restore();

  // Ground shadow.
  ctx.beginPath();
  ctx.ellipse(cx, footY + S * 0.008, shoulderW * 0.92, S * 0.020, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.42)';
  ctx.fill();

  // Vignette.
  const vig = ctx.createRadialGradient(cx, S * 0.5, S * 0.26, cx, S * 0.5, S * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,.64)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, S, S);

  cacheSet(key, canvas);
  return canvas;
}

/**
 * Paint a portrait into a live <canvas> element sized to its CSS box.
 * @param {HTMLCanvasElement} target
 * @param {object} art
 */
export function paintPortrait(target, art, label) {
  if (!target.hasAttribute('role')) target.setAttribute('role', 'img');
  if (!target.hasAttribute('aria-label')) {
    target.setAttribute('aria-label', label ? `Portrait of ${label}` : 'Fighter portrait');
  }
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
 * Lazily paint portraits as they scroll into view. Keeps a 464-card roster
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

/**
 * Register a canvas for lazy portrait painting.
 *
 * Also attaches the accessibility metadata. Canvas pixels are completely
 * opaque to assistive technology, so without `role="img"` + `aria-label` a
 * screen-reader user hears nothing at all for a portrait (WCAG 1.1.1
 * Non-text Content). Callers pass the fighter's display name.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} art   Fighter art descriptor.
 * @param {string} [label] Accessible name, e.g. "Ascendant Kalen".
 */
export function lazyPortrait(canvas, art, label) {
  canvas.__art = art;
  canvas.__painted = false;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label ? `Portrait of ${label}` : 'Fighter portrait');
  observer.observe(canvas);
}

/** Clear the cache (used when the roster changes wholesale). */
export function clearPortraitCache() {
  CACHE.clear();
}
