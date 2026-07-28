# Product Requirements Document — Dragon Ball Heroes

**Version:** 1.0 · **Status:** Implemented · **Platform:** Responsive web app (mobile-first)

---

## 1. Product vision

An original anime action-RPG card battler that delivers the complete
collect-train-battle loop of the premium mobile gacha genre — **with the
monetisation removed entirely**.

The commercial games in this category are excellent products wrapped around a
hostile economy: energy meters that stop play, paid subscriptions for basic
quality-of-life, and premium currency at roughly **£40 per 2,000 units** where a
single ten-pull costs 1,000. Dragon Ball Heroes keeps everything that makes the
genre compelling and deletes everything that makes it exploitative.

### The one-sentence pitch
> Every fighter, every feature, zero cost — a 464-fighter action RPG with
> real-time Arts combat and provably-fair summons, where the £500 head start is
> free and the premium pass never expires.

---

## 2. Positioning against the category leader

| Dimension | Genre standard | Dragon Ball Heroes |
|---|---|---|
| Premium currency | ~£40 → 2,000 crystals | **25,000 free on signup** (~£500 equivalent) |
| Premium subscription | ~£8/month, auto-renews | **Free, permanent, never renews** |
| Stamina / energy | 60 cap, ~4 min per point | **Unlimited — no gate at all** |
| Session length | Capped by energy | **Unbounded** |
| Roster | 400+ fighters | **464 fighters** |
| Summon fairness | Published rates, unverifiable | **Cryptographically verifiable per pull** |
| Pity system | Often undocumented | **Documented and surfaced live in the UI** |
| Rate manipulation risk | Trust the operator | **HMAC-SHA512 commit-reveal chain** |
| Ads | Rewarded video | **None** |
| Data export / deletion | Support ticket | **One click, in-app** |
| Offline art payload | Hundreds of MB | **Zero image assets — procedural** |

### Why players would switch
1. **No wallet anxiety.** The single largest source of negative sentiment in the
   category is the price of crystals. Removing price removes the anxiety.
2. **No time gate.** Energy systems exist to convert impatience into revenue.
   With no revenue motive, the gate has no reason to exist.
3. **Verifiable luck.** "The rates are rigged" is the second-largest complaint.
   A commit-reveal RNG makes the claim falsifiable — players can check.
4. **Instant depth.** A 25,000-crystal grant means a new player builds a real
   team in their first session rather than their first month.

---

## 3. User personas

### P1 — "Returning genre veteran" (primary)
- **Profile:** 25-40, has played gacha RPGs for years, quit over spending.
- **Goal:** The combat depth and collection dopamine, without the wallet.
- **Frustration:** Sunk-cost guilt; power-crept units invalidating past spending.
- **Success:** Builds a competitive team in one evening. Never sees a store.

### P2 — "Curious newcomer"
- **Profile:** Enjoys anime and action games, never played a gacha.
- **Goal:** Try the genre without committing money or learning an economy.
- **Frustration:** Tutorials that gate content; opaque currencies.
- **Success:** Completes onboarding, wins a battle and pulls a Legends fighter
  within ten minutes.

### P3 — "Systems optimiser"
- **Profile:** Theorycrafter. Reads damage formulas, builds spreadsheets.
- **Goal:** Understand and exploit the mechanics; verify claims.
- **Frustration:** Hidden formulas and unverifiable RNG.
- **Success:** Audits the summon chain, min-maxes element coverage and
  Z-Ability tag stacking.

### P4 — "Accessibility-first player"
- **Profile:** Motion-sensitive, or uses assistive technology.
- **Goal:** Play without triggering discomfort.
- **Frustration:** Unskippable flashing cut-ins; no motion controls.
- **Success:** Enables reduced motion; combat remains fully playable and
  readable with all particles and shake disabled.

---

## 4. Core user journeys

### J1 — Onboarding (target: < 60 seconds to first battle)
```
Landing page (value proposition visible above the fold)
  → Register (name, email, password — three fields, no verification wall)
  → Founder's grant: 25,000 crystals + Legends Pass, granted atomically
  → Dashboard with mission list and a clear next action
```
**Requirements**
- Registration must not require email confirmation to start playing.
- The grant must be visible in the wallet within one frame of landing.
- The value proposition (free forever / £500 grant / no timers) must be
  legible before any interaction.

### J2 — Summon (the emotional core)
```
Pick a banner → review published rates and live pity counters
  → Summon ×1 (100) or ×10 (1,000, Sparking guaranteed)
  → Charge-up → burst graded to the best rarity pulled → staggered result grid
  → New fighters land in the roster; duplicates convert to Z-Power
```
**Requirements**
- The reveal must escalate visually with rarity — an Ultra cannot look like a Hero.
- Rates and both pity counters must be visible *before* committing crystals.
- Every pull must be recorded with its verification triple.
- A multi must guarantee Sparking-or-better.

### J3 — Team building & progression
```
Roster (search / filter / sort across 464 fighters)
  → Fighter detail: stats, star progress, signature moves, full ability list
  → Train with Zeni (level) · Soul Boost (permanent stats) · Limit break (Z-Power)
  → Assign three fighters to the battle team
```
**Requirements**
- The grid must stay fluid at 400+ owned fighters.
- Level caps must be gated by star rating to make limit-breaking meaningful.
- Element and tag data must be visible for synergy planning.

### J4 — Battle (the retention loop)
```
Choose chapter → choose stage → confirm team
  → Arena: draw 4 Arts cards, spend Ki, chain combos
  → Vanish to evade · cover-change to survive · charge to recover
  → Fill 7 Dragon Balls → Rising Rush cut-in
  → Victory: crystals, Zeni, Souls, XP, first-clear bonus
```
**Requirements**
- The server is authoritative for every calculation.
- A page refresh mid-battle must resume exactly where it left off.
- The player must never reach a state with no legal action.
- Animation must never block input for longer than the timeline it plays.

### J5 — Settings & data ownership
```
Settings → motion/accessibility toggles (immediate effect)
        → provably-fair panel (seed hash, client seed, nonce, rotate)
        → currency ledger (every transaction)
        → export JSON / delete account
```

---

## 5. Functional requirements

### FR-1 Authentication
| # | Requirement | Status |
|---|---|---|
| 1.1 | Register with email, password (10+ chars) and unique display name | ✅ |
| 1.2 | Passwords hashed with scrypt (N=32768, r=8, p=1) | ✅ |
| 1.3 | Session tokens opaque; only SHA-256 digests stored | ✅ |
| 1.4 | Account lockout after 8 failed attempts for 15 minutes | ✅ |
| 1.5 | Constant-work login path (no account enumeration by timing) | ✅ |
| 1.6 | Password change revokes all other sessions | ✅ |
| 1.7 | Session survives page reload; expires after 7 days | ✅ |

### FR-2 Economy
| # | Requirement | Status |
|---|---|---|
| 2.1 | 25,000 crystals granted atomically at registration | ✅ |
| 2.2 | 500,000 Zeni and 5,000 Souls granted at registration | ✅ |
| 2.3 | Legends Pass active with `expiresAt: null` | ✅ |
| 2.4 | Stamina flagged unlimited and never consumed | ✅ |
| 2.5 | No purchase, payment or advertising surface anywhere | ✅ |
| 2.6 | Every currency movement written to an append-only ledger | ✅ |
| 2.7 | Missions replenish crystals indefinitely | ✅ |

### FR-3 Summoning
| # | Requirement | Status |
|---|---|---|
| 3.1 | Four banners with distinct featured pools and rates | ✅ |
| 3.2 | Single (100) and multi (1,000 for ten) | ✅ |
| 3.3 | Multi guarantees Sparking-or-better | ✅ |
| 3.4 | Soft pity at 10 pulls, hard pity at 80 | ✅ |
| 3.5 | HMAC-SHA512 provably-fair derivation | ✅ |
| 3.6 | Server seed hash published in advance | ✅ |
| 3.7 | Player can rotate their client seed | ✅ |
| 3.8 | Duplicates convert to Z-Power toward 7 stars | ✅ |

### FR-4 Combat
| # | Requirement | Status |
|---|---|---|
| 4.1 | 3v3 teams, one active fighter per side | ✅ |
| 4.2 | Five Arts types with distinct Ki costs | ✅ |
| 4.3 | Seven-element wheel with 1.5× / 0.65× modifiers | ✅ |
| 4.4 | Combo chaining up to three cards | ✅ |
| 4.5 | Vanishing Step, cover change, substitution counters | ✅ |
| 4.6 | Unique Gauge charging and full-gauge effects | ✅ |
| 4.7 | Main Ability gated on elapsed timer counts | ✅ |
| 4.8 | Rising Rush at seven Dragon Balls | ✅ |
| 4.9 | Endurance ("survive lethal once") | ✅ |
| 4.10 | Data-driven abilities firing on nine trigger types | ✅ |
| 4.11 | Server-authoritative; client sends intents only | ✅ |
| 4.12 | Deterministic and replayable from seed | ✅ |
| 4.13 | Charge action guarantees a legal move always exists | ✅ |

### FR-5 Content
| # | Requirement | Status |
|---|---|---|
| 5.1 | 400+ unique fighters | ✅ 464 |
| 5.2 | Five rarities in a collection pyramid | ✅ |
| 5.3 | Every fighter has unique stats, moves and abilities | ✅ |
| 5.4 | Procedural artwork — no image assets | ✅ |
| 5.5 | 48 story stages across six chapters | ✅ |
| 5.6 | Deterministic generation across restarts and nodes | ✅ |

### FR-6 Accessibility
| # | Requirement | Status |
|---|---|---|
| 6.1 | Reduced-motion toggle disabling particles, shake, cut-ins | ✅ |
| 6.2 | Honour OS `prefers-reduced-motion` | ✅ |
| 6.3 | Full keyboard control in battle (1-4, V, R, C) | ✅ |
| 6.4 | Focus trapping and Escape dismissal in dialogs | ✅ |
| 6.5 | ARIA labelling on interactive controls | ✅ |
| 6.6 | Visible focus rings throughout | ✅ |
| 6.7 | No horizontal overflow at 390 px | ✅ verified |

---

## 6. Non-functional requirements

| Category | Target | Achieved |
|---|---|---|
| Runtime dependencies | Zero | 0 packages |
| Cold boot | < 1 s | ~250 ms |
| API p95 | < 100 ms | ~2-15 ms local |
| Battle action round trip | < 150 ms | ~10 ms local |
| Client bundle | < 500 KB | ~190 KB uncompressed |
| Image payload | Minimal | 0 bytes (procedural) |
| Frame rate in combat | 60 fps | Pooled particles, no per-frame allocation |
| Test coverage | Critical paths | 86 unit/integration + 25 E2E |

---

## 7. Out of scope for v1

- Real-time PvP (the engine is deterministic and ready; matchmaking is not built)
- Guilds and social features
- Audio (the settings toggle exists; no sound files ship)
- Push notifications
- Native mobile wrappers

---

## 8. Success metrics

| Metric | Target |
|---|---|
| Signup → first battle | < 60 s |
| Signup → first Legends-or-better pull | < 5 min (25 multis available) |
| Day-1 battles per player | ≥ 5 (no energy cap) |
| Session length | Unbounded by design |
| Crystal starvation events | 0 (missions + battles exceed spend) |
| Reported RNG disputes | 0 unresolvable (all verifiable) |
