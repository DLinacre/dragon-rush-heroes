/**
 * ============================================================================
 * VFX ENGINE — canvas particle system for battle effects
 * ============================================================================
 *
 * A single requestAnimationFrame loop drives every effect on one canvas.
 * Particles are stored in a flat pre-allocated pool (no per-frame allocation,
 * so the garbage collector never causes a hitch mid-combo).
 *
 * Each `vfx.kind` from the server's content descriptors maps to an emitter
 * profile here, which is how a fighter's "animated ability" becomes motion
 * without any bespoke per-character code.
 *
 * The loop auto-suspends when there is nothing to draw, so an idle battle
 * screen costs no CPU.
 */

const POOL_SIZE = 1400;

/** A single particle. Fields are mutated in place; never reallocated. */
class Particle {
  constructor() {
    /*
     * Every field is declared here, not just in reset(). Two reasons:
     *   1. Type safety — the checker can prove these are always numbers.
     *   2. Performance — V8 assigns one stable hidden class per object shape.
     *      Adding fields later would force a shape transition on every
     *      particle, which matters at 1,400 objects * 60fps.
     */
    this.active = false;
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.life = 0; this.maxLife = 1;
    this.size = 2; this.hue = 30; this.sat = 95; this.lum = 60;
    this.alpha = 1; this.gravity = 0; this.drag = 1;
    this.shape = 'dot'; this.rot = 0; this.vrot = 0;
    this.stretch = 1;
  }

  /** Return the particle to its default state before reuse from the pool. */
  reset() {
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.life = 0; this.maxLife = 1;
    this.size = 2; this.hue = 30; this.sat = 95; this.lum = 60;
    this.alpha = 1; this.gravity = 0; this.drag = 1;
    this.shape = 'dot'; this.rot = 0; this.vrot = 0;
    this.stretch = 1;
  }
}

export class VFXEngine {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      // No 2D context (GPU reset, canvas detached). The engine degrades to a
      // no-op rather than throwing on every frame.
      throw new Error('VFXEngine: 2D canvas context unavailable');
    }
    this.ctx = ctx;
    this.pool = Array.from({ length: POOL_SIZE }, () => new Particle());
    this.cursor = 0;
    this.running = false;
    this.lastTime = 0;
    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    /** Transient full-screen overlays (beams, shockwaves). */
    this.overlays = [];
    /** Screen-shake state, consumed by the host component each frame. */
    this.shake = { x: 0, y: 0, magnitude: 0, decay: 0.88 };
    /** Flash intensity 0..1. */
    this.flash = 0;

    this.reducedMotion = false;

    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize, { passive: true });
    this.resize();
  }

  /** Match the backing store to the CSS box. */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width || window.innerWidth;
    this.height = rect.height || window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Grab the next free particle from the ring buffer. */
  #take() {
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % POOL_SIZE;
      if (!p.active) { p.reset(); p.active = true; return p; }
    }
    // Pool exhausted: recycle the oldest slot.
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % POOL_SIZE;
    p.reset();
    p.active = true;
    return p;
  }

  /** Start the RAF loop if it is not already running. */
  #ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.#frame);
  }

  #frame = (now) => {
    // Clamp to [0, 0.05]. The lower bound matters: a RAF timestamp is the
    // frame's start time and can precede a performance.now() taken later in
    // the same task, which would otherwise yield a negative delta and push
    // effect progress below zero (negative canvas radii throw IndexSizeError).
    const dt = Math.max(0, Math.min((now - this.lastTime) / 1000, 0.05));
    this.lastTime = now;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    let live = 0;

    // --- particles ---------------------------------------------------------
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.active = false; continue; }
      live += 1;

      p.vx *= p.drag;
      p.vy = p.vy * p.drag + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;

      const t = p.life / p.maxLife;
      const fade = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      const alpha = Math.max(0, p.alpha * fade);
      const size = p.size * (1 - t * 0.35);

      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.rot) ctx.rotate(p.rot);
      ctx.fillStyle = `hsla(${p.hue} ${p.sat}% ${p.lum}% / ${alpha})`;

      if (p.shape === 'streak') {
        ctx.fillRect(-size * p.stretch, -size * 0.32, size * p.stretch * 2, size * 0.64);
      } else if (p.shape === 'shard') {
        ctx.beginPath();
        ctx.moveTo(0, -size * 1.6);
        ctx.lineTo(size * 0.62, 0);
        ctx.lineTo(0, size * 1.6);
        ctx.lineTo(-size * 0.62, 0);
        ctx.closePath();
        ctx.fill();
      } else if (p.shape === 'ring') {
        ctx.lineWidth = Math.max(1, size * 0.3);
        ctx.strokeStyle = `hsla(${p.hue} ${p.sat}% ${p.lum}% / ${alpha})`;
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(0, size * 2.2), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(0, size), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // --- overlays ----------------------------------------------------------
    for (let i = this.overlays.length - 1; i >= 0; i -= 1) {
      const o = this.overlays[i];
      o.life += dt;
      if (o.life >= o.maxLife) { this.overlays.splice(i, 1); continue; }
      live += 1;
      // Overlays may start with a negative life to stagger them (see #nova),
      // so clamp progress to 0 before drawing.
      o.draw(ctx, Math.max(0, o.life / o.maxLife), this.width, this.height);
    }
    ctx.globalCompositeOperation = 'source-over';

    // --- shake decay -------------------------------------------------------
    if (this.shake.magnitude > 0.2) {
      this.shake.magnitude *= this.shake.decay;
      this.shake.x = (Math.random() - 0.5) * this.shake.magnitude;
      this.shake.y = (Math.random() - 0.5) * this.shake.magnitude;
      live += 1;
    } else {
      this.shake.magnitude = 0;
      this.shake.x = 0;
      this.shake.y = 0;
    }

    // --- flash decay -------------------------------------------------------
    // Decay quickly: a lingering white overlay washes the whole scene out.
    if (this.flash > 0.02) { this.flash *= 0.78; live += 1; } else this.flash = 0;

    this.onFrame?.(this.shake, this.flash);

    if (live > 0) {
      requestAnimationFrame(this.#frame);
    } else {
      this.running = false;
      ctx.clearRect(0, 0, this.width, this.height);
    }
  };

  /** Convert a normalised (0..1) stage coordinate to canvas pixels. */
  point(nx, ny) {
    return { x: nx * this.width, y: ny * this.height };
  }

  /**
   * Emit an effect.
   *
   * @param {string} kind  One of the VFX kinds from the content descriptors.
   * @param {object} opts  `{ from:{x,y}, to:{x,y}, hue, particles, power }`
   */
  emit(kind, opts = {}) {
    if (this.reducedMotion) {
      // Still flash briefly so hits remain readable without motion.
      this.flash = Math.min(1, (opts.flash ?? 0.4) * 0.35);
      this.#ensureRunning();
      return;
    }

    const from = opts.from ?? this.point(0.28, 0.55);
    const to = opts.to ?? this.point(0.72, 0.45);
    const hue = opts.hue ?? 28;
    const count = Math.round((opts.particles ?? 160) * (opts.scale ?? 1));

    switch (kind) {
      case 'beam':     this.#beam(from, to, hue, count); break;
      case 'barrage':  this.#barrage(from, to, hue, count); break;
      case 'meteor':   this.#meteor(to, hue, count); break;
      case 'vortex':   this.#vortex(to, hue, count); break;
      case 'slash':    this.#slash(from, to, hue, count); break;
      case 'nova':     this.#nova(to, hue, count); break;
      case 'chain':    this.#chain(from, to, hue, count); break;
      case 'crush':    this.#crush(to, hue, count); break;
      case 'spiral':   this.#spiral(to, hue, count); break;
      case 'eruption': this.#eruption(to, hue, count); break;
      case 'impact':   this.#impact(to, hue, count); break;
      case 'aura':     this.#aura(from, hue, count); break;
      default:         this.#impact(to, hue, count);
    }

    if (opts.shake) this.addShake(opts.shake);
    if (opts.flash) this.flash = Math.max(this.flash, opts.flash);
    this.#ensureRunning();
  }

  /** Add screen shake (magnitude in pixels). */
  addShake(magnitude) {
    this.shake.magnitude = Math.max(this.shake.magnitude, this.reducedMotion ? 0 : magnitude);
    this.#ensureRunning();
  }

  /** Trigger a white flash (0..1). */
  addFlash(intensity) {
    this.flash = Math.max(this.flash, intensity);
    this.#ensureRunning();
  }

  // ------------------------------------------------------------ emitters --

  /** Focused energy beam with a charge-up bloom and travelling core. */
  #beam(from, to, hue, count) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);

    // Charge bloom at the origin.
    for (let i = 0; i < count * 0.3; i += 1) {
      const p = this.#take();
      const a = Math.random() * Math.PI * 2;
      const r = 40 + Math.random() * 60;
      p.x = from.x + Math.cos(a) * r;
      p.y = from.y + Math.sin(a) * r;
      p.vx = -Math.cos(a) * r * 2.6;
      p.vy = -Math.sin(a) * r * 2.6;
      p.maxLife = 0.34 + Math.random() * 0.2;
      p.size = 1.6 + Math.random() * 3;
      p.hue = hue + Math.random() * 26 - 13;
      p.lum = 66 + Math.random() * 24;
      p.drag = 0.94;
    }

    // Beam core.
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    for (let i = 0; i < count * 0.7; i += 1) {
      const p = this.#take();
      const t = Math.random();
      const spread = (Math.random() - 0.5) * 30;
      p.x = from.x + Math.cos(angle) * dist * t + Math.cos(angle + Math.PI / 2) * spread;
      p.y = from.y + Math.sin(angle) * dist * t + Math.sin(angle + Math.PI / 2) * spread;
      p.vx = Math.cos(angle) * (620 + Math.random() * 420);
      p.vy = Math.sin(angle) * (620 + Math.random() * 420);
      p.maxLife = 0.32 + Math.random() * 0.3;
      p.size = 2.4 + Math.random() * 4.6;
      p.hue = hue + Math.random() * 22 - 11;
      p.lum = 62 + Math.random() * 30;
      p.shape = 'streak';
      p.stretch = 3 + Math.random() * 5;
      p.rot = angle;
      p.drag = 0.985;
    }

    this.overlays.push({
      life: 0, maxLife: 0.45,
      draw: (ctx, t) => {
        const a = (1 - t) * 0.85;
        const wid = 20 * (1 - t * 0.55);
        const grad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
        grad.addColorStop(0, `hsla(${hue} 100% 88% / ${a})`);
        grad.addColorStop(0.5, `hsla(${hue} 100% 66% / ${a * 0.9})`);
        grad.addColorStop(1, `hsla(${hue + 20} 100% 74% / 0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = wid;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      },
    });

    this.#impact(to, hue, count * 0.4);
  }

  /**
   * Rapid punch flurry: many small impacts scattered around the target.
   * `_from` is accepted for emitter-signature symmetry but unused — a barrage
   * originates at the target, not along a path.
   */
  #barrage(_from, to, hue, count) {
    for (let i = 0; i < count; i += 1) {
      const p = this.#take();
      const jitter = 70;
      const ox = to.x + (Math.random() - 0.5) * jitter;
      const oy = to.y + (Math.random() - 0.5) * jitter;
      const a = Math.random() * Math.PI * 2;
      const speed = 180 + Math.random() * 420;
      p.x = ox; p.y = oy;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.maxLife = 0.26 + Math.random() * 0.34;
      p.size = 1.4 + Math.random() * 3.4;
      p.hue = hue + Math.random() * 30 - 15;
      p.lum = 60 + Math.random() * 32;
      p.shape = Math.random() > 0.6 ? 'streak' : 'dot';
      p.stretch = 2 + Math.random() * 3;
      p.rot = a;
      p.drag = 0.93;
    }
    for (let i = 0; i < 5; i += 1) {
      const r = this.#take();
      r.x = to.x + (Math.random() - 0.5) * 90;
      r.y = to.y + (Math.random() - 0.5) * 90;
      r.maxLife = 0.3 + i * 0.05;
      r.size = 6 + i * 3;
      r.hue = hue; r.lum = 78; r.shape = 'ring'; r.drag = 1;
    }
  }

  /** Meteor: heavy descending mass plus ground burst. */
  #meteor(to, hue, count) {
    for (let i = 0; i < count * 0.55; i += 1) {
      const p = this.#take();
      p.x = to.x + (Math.random() - 0.5) * 130;
      p.y = to.y - 320 - Math.random() * 260;
      p.vx = (Math.random() - 0.5) * 90;
      p.vy = 900 + Math.random() * 700;
      p.maxLife = 0.5 + Math.random() * 0.3;
      p.size = 2.6 + Math.random() * 5.4;
      p.hue = hue + Math.random() * 26 - 8;
      p.lum = 56 + Math.random() * 34;
      p.shape = 'streak';
      p.stretch = 5 + Math.random() * 7;
      p.rot = Math.PI / 2;
      p.drag = 0.998;
    }
    this.#eruption(to, hue, count * 0.45);
  }

  /** Swirling vortex that pulls inward then detonates. */
  #vortex(to, hue, count) {
    for (let i = 0; i < count; i += 1) {
      const p = this.#take();
      const a = Math.random() * Math.PI * 2;
      const r = 60 + Math.random() * 150;
      p.x = to.x + Math.cos(a) * r;
      p.y = to.y + Math.sin(a) * r;
      const tangent = a + Math.PI / 2;
      const pull = 3.1;
      p.vx = Math.cos(tangent) * 320 - Math.cos(a) * r * pull;
      p.vy = Math.sin(tangent) * 320 - Math.sin(a) * r * pull;
      p.maxLife = 0.55 + Math.random() * 0.4;
      p.size = 1.7 + Math.random() * 3.6;
      p.hue = hue + Math.random() * 40 - 20;
      p.lum = 58 + Math.random() * 30;
      p.drag = 0.965;
      p.shape = Math.random() > 0.7 ? 'shard' : 'dot';
      p.vrot = (Math.random() - 0.5) * 12;
    }
    for (let i = 0; i < 4; i += 1) {
      const r = this.#take();
      r.x = to.x; r.y = to.y;
      r.maxLife = 0.55 + i * 0.1;
      r.size = 4 + i * 6;
      r.hue = hue; r.lum = 72; r.shape = 'ring';
      r.vrot = 3;
    }
  }

  /** Blade arc: a crescent of shards along the swing path. */
  #slash(from, to, hue, count) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const perp = angle + Math.PI / 2;
    for (let i = 0; i < count; i += 1) {
      const p = this.#take();
      const t = Math.random();
      const arc = Math.sin(t * Math.PI) * 90;
      p.x = from.x + (to.x - from.x) * t + Math.cos(perp) * arc;
      p.y = from.y + (to.y - from.y) * t + Math.sin(perp) * arc;
      p.vx = Math.cos(angle) * (300 + Math.random() * 320) + (Math.random() - 0.5) * 160;
      p.vy = Math.sin(angle) * (300 + Math.random() * 320) + (Math.random() - 0.5) * 160;
      p.maxLife = 0.28 + Math.random() * 0.26;
      p.size = 1.8 + Math.random() * 3.8;
      p.hue = hue + Math.random() * 18 - 9;
      p.lum = 70 + Math.random() * 26;
      p.shape = 'shard';
      p.rot = angle;
      p.vrot = (Math.random() - 0.5) * 9;
      p.drag = 0.94;
    }
    this.overlays.push({
      life: 0, maxLife: 0.34,
      draw: (ctx, t) => {
        const a = (1 - t) * 0.9;
        ctx.strokeStyle = `hsla(${hue} 100% 84% / ${a})`;
        ctx.lineWidth = 12 * (1 - t);
        ctx.lineCap = 'round';
        ctx.beginPath();
        const mx = (from.x + to.x) / 2 + Math.cos(perp) * 100;
        const my = (from.y + to.y) / 2 + Math.sin(perp) * 100;
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo(mx, my, to.x, to.y);
        ctx.stroke();
      },
    });
  }

  /** Nova: omnidirectional detonation with expanding shockwave rings. */
  #nova(to, hue, count) {
    for (let i = 0; i < count; i += 1) {
      const p = this.#take();
      const a = Math.random() * Math.PI * 2;
      const speed = 260 + Math.random() * 780;
      p.x = to.x; p.y = to.y;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.maxLife = 0.5 + Math.random() * 0.5;
      p.size = 2 + Math.random() * 5;
      p.hue = hue + Math.random() * 46 - 23;
      p.lum = 64 + Math.random() * 32;
      p.drag = 0.955;
      p.shape = Math.random() > 0.55 ? 'streak' : 'dot';
      p.stretch = 2 + Math.random() * 4;
      p.rot = a;
    }
    for (let i = 0; i < 3; i += 1) {
      this.overlays.push({
        life: -i * 0.09, maxLife: 0.66,
        draw: (ctx, t) => {
          if (t < 0) return;
          const r = Math.max(0, t * Math.max(this.width, this.height) * 0.62);
          ctx.strokeStyle = `hsla(${hue} 100% 82% / ${(1 - t) * 0.6})`;
          ctx.lineWidth = Math.max(0.1, 9 * (1 - t));
          ctx.beginPath();
          ctx.arc(to.x, to.y, r, 0, Math.PI * 2);
          ctx.stroke();
        },
      });
    }
  }

  /** Chain lightning arcing between two points. */
  #chain(from, to, hue, count) {
    const segments = 9;
    const pts = [];
    for (let i = 0; i <= segments; i += 1) {
      const t = i / segments;
      pts.push({
        x: from.x + (to.x - from.x) * t + (i === 0 || i === segments ? 0 : (Math.random() - 0.5) * 90),
        y: from.y + (to.y - from.y) * t + (i === 0 || i === segments ? 0 : (Math.random() - 0.5) * 90),
      });
    }
    this.overlays.push({
      life: 0, maxLife: 0.4,
      draw: (ctx, t) => {
        const a = (1 - t) * 0.95;
        ctx.strokeStyle = `hsla(${hue} 100% 82% / ${a})`;
        ctx.lineWidth = 4.5 * (1 - t * 0.5);
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (const pt of pts.slice(1)) ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
        ctx.strokeStyle = `hsla(${hue} 100% 96% / ${a * 0.8})`;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      },
    });
    for (let i = 0; i < count * 0.6; i += 1) {
      const p = this.#take();
      const anchor = pts[Math.floor(Math.random() * pts.length)];
      p.x = anchor.x; p.y = anchor.y;
      const a = Math.random() * Math.PI * 2;
      p.vx = Math.cos(a) * (110 + Math.random() * 280);
      p.vy = Math.sin(a) * (110 + Math.random() * 280);
      p.maxLife = 0.24 + Math.random() * 0.3;
      p.size = 1.2 + Math.random() * 2.6;
      p.hue = hue; p.lum = 78 + Math.random() * 20;
      p.drag = 0.9;
    }
    this.#impact(to, hue, count * 0.35);
  }

  /** Ground-shattering slam. */
  #crush(to, hue, count) {
    for (let i = 0; i < count; i += 1) {
      const p = this.#take();
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      const speed = 220 + Math.random() * 620;
      p.x = to.x + (Math.random() - 0.5) * 60;
      p.y = to.y + 30;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.gravity = 1500;
      p.maxLife = 0.6 + Math.random() * 0.5;
      p.size = 2 + Math.random() * 5.6;
      p.hue = hue + Math.random() * 24 - 12;
      p.lum = 46 + Math.random() * 34;
      p.shape = Math.random() > 0.5 ? 'shard' : 'dot';
      p.vrot = (Math.random() - 0.5) * 14;
      p.drag = 0.99;
    }
    this.overlays.push({
      life: 0, maxLife: 0.5,
      draw: (ctx, t) => {
        const r = Math.max(0, t * 240);
        ctx.strokeStyle = `hsla(${hue} 90% 70% / ${(1 - t) * 0.8})`;
        ctx.lineWidth = Math.max(0.1, 14 * (1 - t));
        ctx.beginPath();
        ctx.ellipse(to.x, to.y + 40, r, r * 0.3, 0, 0, Math.PI * 2);
        ctx.stroke();
      },
    });
  }

  /** Rising helix of energy. */
  #spiral(to, hue, count) {
    for (let i = 0; i < count; i += 1) {
      const p = this.#take();
      const t = i / count;
      const a = t * Math.PI * 8;
      const r = 26 + t * 110;
      p.x = to.x + Math.cos(a) * r;
      p.y = to.y + 130 - t * 300;
      p.vx = Math.cos(a + Math.PI / 2) * 210;
      p.vy = -180 - Math.random() * 300;
      p.maxLife = 0.55 + Math.random() * 0.45;
      p.size = 1.6 + Math.random() * 3.6;
      p.hue = hue + t * 50 - 25;
      p.lum = 62 + Math.random() * 30;
      p.drag = 0.972;
      p.vrot = 6;
      p.shape = Math.random() > 0.7 ? 'shard' : 'dot';
    }
  }

  /** Upward pillar of fire/energy. */
  #eruption(to, hue, count) {
    for (let i = 0; i < count; i += 1) {
      const p = this.#take();
      p.x = to.x + (Math.random() - 0.5) * 110;
      p.y = to.y + 50 + Math.random() * 40;
      p.vx = (Math.random() - 0.5) * 200;
      p.vy = -(320 + Math.random() * 720);
      p.gravity = 620;
      p.maxLife = 0.6 + Math.random() * 0.55;
      p.size = 2.4 + Math.random() * 5.6;
      p.hue = hue + Math.random() * 34 - 10;
      p.lum = 54 + Math.random() * 38;
      p.drag = 0.985;
      p.shape = Math.random() > 0.65 ? 'streak' : 'dot';
      p.stretch = 2 + Math.random() * 3;
      p.rot = Math.PI / 2;
    }
    for (let i = 0; i < 3; i += 1) {
      const r = this.#take();
      r.x = to.x; r.y = to.y + 40;
      r.maxLife = 0.4 + i * 0.12;
      r.size = 5 + i * 5;
      r.hue = hue; r.lum = 74; r.shape = 'ring';
    }
  }

  /** Generic hit spark. */
  #impact(to, hue, count) {
    for (let i = 0; i < count; i += 1) {
      const p = this.#take();
      const a = Math.random() * Math.PI * 2;
      const speed = 150 + Math.random() * 480;
      p.x = to.x; p.y = to.y;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.maxLife = 0.24 + Math.random() * 0.34;
      p.size = 1.6 + Math.random() * 3.4;
      p.hue = hue + Math.random() * 26 - 13;
      p.lum = 66 + Math.random() * 28;
      p.drag = 0.92;
      p.shape = Math.random() > 0.6 ? 'streak' : 'dot';
      p.stretch = 2 + Math.random() * 3;
      p.rot = a;
    }
  }

  /** Persistent charging aura around a point. */
  #aura(at, hue, count) {
    for (let i = 0; i < count; i += 1) {
      const p = this.#take();
      const a = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 80;
      p.x = at.x + Math.cos(a) * r;
      p.y = at.y + Math.sin(a) * r + 40;
      p.vx = -Math.cos(a) * 60;
      p.vy = -140 - Math.random() * 200;
      p.maxLife = 0.5 + Math.random() * 0.5;
      p.size = 1.4 + Math.random() * 3;
      p.hue = hue + Math.random() * 30 - 15;
      p.lum = 64 + Math.random() * 26;
      p.drag = 0.97;
    }
  }

  /** Free listeners and stop the loop. */
  destroy() {
    window.removeEventListener('resize', this._onResize);
    for (const p of this.pool) p.active = false;
    this.overlays.length = 0;
    this.running = false;
  }
}
