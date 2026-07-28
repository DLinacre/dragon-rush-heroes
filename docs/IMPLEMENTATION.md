# Implementation Execution Plan

This is the plan the build actually followed, with the verification gate that
closed each phase. Every phase ends in a runnable, tested state.

---

## Phase 1 — Core foundation ✅

**Goal:** a secure, durable, testable server skeleton with no game logic in it.

| # | Task | Deliverable | Gate |
|---|---|---|---|
| 1.1 | Validated configuration + secret policy | `server/config.js` | Boot fails in prod without secrets |
| 1.2 | Error taxonomy | `core/errors.js` | Typed codes, no internal leakage |
| 1.3 | Structured logging with redaction | `core/logger.js` | Secrets never reach a sink |
| 1.4 | Crypto primitives | `core/crypto.js` | scrypt round trip, RNG determinism |
| 1.5 | Schema validation | `core/validate.js` | Mass assignment impossible |
| 1.6 | HTTP kernel | `core/http.js` | Routing, static, gzip, traversal blocked |
| 1.7 | WAL document store | `data/store.js` | Crash recovery + rollback proven |
| 1.8 | Repository seam | `data/repositories.js` | Domain never touches storage |
| 1.9 | Security middleware | `middleware.js` | CSP, CORS, rate limit, CSRF |

**Gate:** server boots, `/api/health` responds, store survives a simulated
crash, 50 concurrent transactions lose no updates.

**Decisions made here**
- Zero dependencies — accept ~600 lines of HTTP kernel to eliminate the
  supply-chain surface entirely.
- WAL + snapshot over SQLite — `node:sqlite` is unavailable on Node 20 and a
  native module would break the "runs anywhere" property.
- Express-shaped kernel API so the trade-off is reversible.

---

## Phase 2 — Feature implementation ✅

**Goal:** the complete game.

### 2A Content system
| # | Task | Result |
|---|---|---|
| 2.1 | Element wheel (5 + Dark/Light) | 1.5× / 0.65× verified |
| 2.2 | Rarity ladder + Z-Power star curve | 7-star limit break |
| 2.3 | 80 curated lineages with form ladders | — |
| 2.4 | Deterministic fighter generation | **464 fighters** |
| 2.5 | Data-driven ability vocabulary | 16 effects × 9 triggers |
| 2.6 | Banners, stages, missions | 4 / 48 / 11 |

*Tuning iterations that mattered:* the first generation produced 221 fighters
with an inverted pyramid (more Legends than Sparking) and only 2 Light
fighters. Reworking `rarityForForm` and the element assignment produced the
final 464 with a correct pyramid (30/39/26/4.5/1.1 %) and 12 Light / 26 Dark.

### 2B Combat engine
| # | Task | Result |
|---|---|---|
| 2.7 | Stat computation (level, stars, boosts, Z-Abilities) | — |
| 2.8 | Arts cards, Ki, hand management | 4-card hand |
| 2.9 | Damage formula (soft-opposed + element + buffs + combo + crit) | — |
| 2.10 | Vanishing Step, cover change, substitution | — |
| 2.11 | Unique Gauge, Main Ability, Endurance | — |
| 2.12 | Dragon Balls → Rising Rush | 7 slots |
| 2.13 | Skill-scaled AI | Decision quality scales with level |
| 2.14 | Event-sourced timeline output | 16 event types |
| 2.15 | Snapshot/restore | Survives process restart |

> **Bug caught at this gate:** a fighter with no Ki, an empty vanish gauge and
> a spent Main Ability had **no legal action** — a hard deadlock. Real-time
> games avoid this because the clock always advances; the turn-based
> translation needed an explicit `charge` action. Added, exported, wired into
> the AI and the API enum, and covered by a regression test.

### 2C Economy
| # | Task | Result |
|---|---|---|
| 2.16 | Founder's grant | **25,000 crystals** (~£500 equivalent) |
| 2.17 | Free permanent Legends Pass | `expiresAt: null` |
| 2.18 | Unlimited stamina | Never consumed |
| 2.19 | Provably-fair summons | HMAC-SHA512 commit-reveal |
| 2.20 | Pity (soft 10 / hard 80) + multi guarantee | — |
| 2.21 | Progression curves | Training, soul boost, class-up |
| 2.22 | Append-only ledger | Every movement recorded |

*Simulated the full grant:* 250 pulls → 167 unique fighters, 1 Ultra,
6 Legends, 25 Sparking. A genuinely elite starting roster.

### 2D Services & API
Auth service (register/login/logout/password/erasure) and game service
(summon, train, boost, teams, battles, missions, settings, export) behind 26
endpoints.

### 2E Client
| # | Task | Result |
|---|---|---|
| 2.23 | Design system | Tokens, GPU-only animation rules |
| 2.24 | Procedural portrait renderer | 464 unique portraits, 0 image bytes |
| 2.25 | Particle VFX engine | 1,400-object pool, 12 emitter profiles |
| 2.26 | Observable store + router | Key-level subscriptions |
| 2.27 | Six views | Auth, home, summon, roster, battle, settings |
| 2.28 | Battle arena | Sprites, event playback, cut-ins |

**Gate:** full loop works end to end in a real browser.

---

## Phase 3 — Polish, hardening & verification ✅

| # | Task | Outcome |
|---|---|---|
| 3.1 | Unit + integration suite | **86/86 passing in ~2 s** |
| 3.2 | Browser E2E suite | **25/25 passing, zero console errors** |
| 3.3 | Visual QA from real screenshots | 3 layout bugs found and fixed |
| 3.4 | PostgreSQL schema validated on a live server | 1 critical bug found |
| 3.5 | Accessibility pass | Reduced motion, keyboard, ARIA, focus traps |
| 3.6 | Responsive pass | 0 px overflow at 390 px |
| 3.7 | Documentation | PRD, architecture, API, security, legal |

### Issues found and fixed in Phase 3

1. **CSP blocked Google Fonts** — `style-src 'self'` rejected the stylesheet.
   Allow-listed `fonts.googleapis.com` / `fonts.gstatic.com` explicitly rather
   than loosening the policy.

2. **CSP blocked the font `onload` handler** — the standard non-blocking font
   trick uses an inline event handler, which violates `script-src 'self'`.
   Replaced with a normal `<link>` + `display=swap`.

3. **Empty battle stage** — the first arena screenshot showed no fighters and a
   dock floating mid-screen. `.stage` was absolutely positioned inside the
   shake wrapper with nothing reserving flex space. Added `.arena-mid`, a
   ground plane with a perspective grid, and full character sprites with idle
   float, attack lunge, hit recoil, vanish blink and KO animations.

4. **Blown-out impact flash** — the white overlay peaked at 0.75 opacity and
   washed the scene out. Capped at 0.38 with faster decay.

5. **Ledger rule broke GDPR erasure** — running the schema against a live
   PostgreSQL 17 revealed that `CREATE RULE … DO INSTEAD NOTHING` rewrites the
   FK integrity probe, so `DELETE FROM users` failed outright. Replaced with a
   `pg_trigger_depth()`-aware trigger; re-verified that direct tampering is
   still blocked *and* cascade erasure now clears all 7 tables.

6. **Test-harness defects** (not product bugs) — `innerText` returns
   CSS-uppercased text, so several assertions never matched; the rate-limit
   test starved the auth budget for tests that followed it and was moved last.

---

## Phase 4 — Roadmap (not built)

| Feature | Notes |
|---|---|
| Real-time PvP | Engine is already deterministic and snapshot-safe; needs matchmaking + WebSocket transport |
| Guilds / co-op raids | Shared boss HP pool across players |
| Audio | Settings toggle already exists; needs a sound bank |
| Equipment system | Third progression axis alongside level and stars |
| Replay viewer | Snapshots + seeds already make battles fully replayable |
| PostgreSQL migration | Reimplement `repositories.js`; DDL is written and validated |
| Redis rate limiting | Swap the in-memory map for multi-node deployment |

---

## Verification summary

```
npm test            →  86/86 passing  (~2 s)
node tests/e2e.js   →  25/25 passing  (~33 s, real Chrome)
                       zero console errors, zero page errors,
                       zero failed requests, 0 px mobile overflow
psql -f db/schema.sql → applies clean; 8 tables, 3 views, 23 indexes,
                       7 triggers; constraints and cascade erasure verified
```

| Metric | Value |
|---|---|
| Source files | 34 |
| Lines of code | ~11,000 |
| Runtime dependencies | **0** |
| Fighters | **464** |
| Image assets | **0** (procedural) |
| Automated checks | **111** |
