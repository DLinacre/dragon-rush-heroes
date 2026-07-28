# API & Interface Specification

**Base URL:** `/api` · **Content type:** `application/json; charset=utf-8`

---

## 1. Conventions

### Response envelope
Success and failure are always distinguishable by shape:

```jsonc
// 2xx
{ "data": { /* payload */ } }

// 4xx / 5xx
{ "error": { "code": "MACHINE_CODE", "message": "Human readable.", "details": { } } }
```

Clients switch on `error.code`, never on `error.message` (which is display text
and may be reworded).

### Authentication
A successful `register` or `login` sets two cookies:

| Cookie | Flags | Purpose |
|---|---|---|
| `drh_session` | `HttpOnly; SameSite=Lax; Secure*` | Opaque bearer token |
| `drh_csrf` | `SameSite=Lax; Secure*` (readable) | Double-submit CSRF value |

<sub>*`Secure` is set automatically in production.</sub>

Every unsafe method (`POST`, `PUT`, `PATCH`, `DELETE`) must echo the CSRF
cookie in an `X-CSRF-Token` header. Omitting or forging it returns
`403 CSRF_REJECTED`.

### Error codes

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Schema violation. `details.fields` maps field → message |
| `BAD_REQUEST` | 400 | Malformed syntax |
| `UNAUTHORIZED` | 401 | Missing or invalid session |
| `CSRF_REJECTED` | 403 | Missing/invalid CSRF token or cross-origin request |
| `ACCOUNT_LOCKED` | 403 | Too many failed logins |
| `NOT_FOUND` | 404 | Resource absent or not visible to the caller |
| `METHOD_NOT_ALLOWED` | 405 | Wrong verb; `Allow` header lists valid ones |
| `EMAIL_TAKEN` / `NAME_TAKEN` | 409 | Uniqueness conflict |
| `BATTLE_IN_PROGRESS` | 409 | One battle at a time; `details.battleId` |
| `INSUFFICIENT_CRYSTALS` | 422 | `details: { required, balance }` |
| `INSUFFICIENT_KI` | 422 | Not enough Ki for that card |
| `NOT_OWNED` | 422 | Fighter not in the caller's roster |
| `RATE_LIMITED` | 429 | `details.retryAfter` in seconds; `Retry-After` header set |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeded 64 KB |
| `INTERNAL_ERROR` | 500 | Unexpected fault (never leaks internals) |

### Rate limits (per minute)

| Bucket | Limit | Applies to |
|---|---|---|
| `global` | 300 | Every request |
| `auth` | 12 | `register`, `login`, `password` |
| `action` | 120 | `summon`, `battles`, `train`, `soul-boost` |

Authenticated callers are bucketed by account, not IP, so shared NATs do not
throttle each other.

---

## 2. System endpoints

### `GET /api/health`
Liveness/readiness probe. Unauthenticated.
```jsonc
{ "data": { "status": "healthy", "env": "production", "uptime": 3812,
            "version": "1.0.0",
            "collections": { "users": 41, "players": 41, "roster": 3120, "battles": 6 } } }
```

### `GET /api/catalogue`
All static game data. Cache for 10 minutes; changes only on deploy.
```jsonc
{ "data": {
    "fighters": [ { "id": "kale-3-0", "title": "Ultra Instinct-Class Kalen",
                    "rarity": "ULTRA", "element": "LIGHT", "tags": ["Saiyan Blood","Hero"],
                    "archetype": "BRAWLER",
                    "stats": { "hp": 28070, "strike": 3722, "blast": 2623,
                               "strDef": 2808, "blsDef": 2444, "crit": 8.1, "kiRegen": 1.19 },
                    "moves": { "special": { "name": "Storm Requiem Infinite", "vfx": "CRUSH", "power": 2.7 },
                               "ultimate": { "name": "Glacial Meteor Prime", "vfx": "CRUSH", "power": 4.9 } },
                    "abilities": [ { "trigger": "onEntry", "triggerText": "On battlefield entry",
                                     "effects": [ { "key": "dmgUp", "value": 45,
                                                    "text": "+45% to damage inflicted" } ],
                                     "duration": 15 } ],
                    "mainAbility": { "name": "...", "requires": 18, "effects": [] },
                    "uniqueGauge": { "name": "Overdrive", "chargePerArts": 18, "fullEffects": [] },
                    "zAbility": { "stat": "strike", "tag": "Saiyan Blood", "tiers": [14,17,21,25,28,31,35,39] },
                    "art": { "hue": 22, "hue2": 74, "aura": "#fff8e1", "seed": "kale-3-0",
                             "build": "BRAWLER", "intensity": 1 } } ],
    "elements": { "RED": { "id":"RED","label":"Crimson","beats":"YELLOW","hex":"#ff4d4d" } },
    "rarities": { "ULTRA": { "tier": 5, "power": 2.25, "zPowerPerPull": 2000 } },
    "arts":     { "STRIKE": { "cost": 15 }, "ULTIMATE": { "cost": 50 } },
    "vfx":      { "NOVA": { "kind":"nova","particles":320,"shake":22,"flash":1,"duration":1800 } },
    "banners":  [ { "id":"legendary-rising","name":"LEGENDARY RISING","featured":["..."],
                    "rates": { "ULTRA":0.005,"LEGENDS":0.015,"SPARKING":0.05,
                               "EXTREME":0.22,"HERO":0.71 } } ],
    "stages":   [ { "id":"ch1-1","chapterName":"The Fractured Sky","level":4,
                    "enemyTeam":["..."],"rewards":{"crystals":35,"zeni":780,"xp":340,"souls":12},
                    "firstClear":{"crystals":75,"souls":20} } ],
    "missions": [ { "id":"daily-login","name":"Report for Duty","target":1,
                    "metric":"logins","reward":{"crystals":150,"zeni":3000} } ],
    "economy":  { "founderGrant": 25000, "founderGrantGBPEquivalent": 500,
                  "summonCostSingle": 100, "summonCostMulti": 1000,
                  "pitySparking": 10, "pityLegends": 80,
                  "freeForever": true, "monetisation": "none",
                  "passIncluded": true, "staminaUnlimited": true },
    "combat":   { "HAND_SIZE": 4, "MAX_KI": 100, "RUSH_ORBS_REQUIRED": 7 } } }
```

### `GET /api/fairness`
The public RNG commitment.
```jsonc
{ "data": { "serverSeedHash": "f3b249…",
            "algorithm": "HMAC-SHA512(serverSeed, `${clientSeed}:${nonce}:${cursor}`)",
            "note": "The hash is published in advance…" } }
```

---

## 3. Authentication

### `POST /api/auth/register` → `201`
```jsonc
// request
{ "email": "hero@example.com", "password": "verySecurePass123", "displayName": "Solvane" }
// response
{ "data": { "user": { "id": "usr_…", "email": "hero@example.com" },
            "player": { "crystals": 25000, "zeni": 500000, "souls": 5000,
                        "pass": { "active": true, "expiresAt": null } },
            "csrfToken": "…" } }
```
Password policy: ≥ 10 characters, not a known-common password, not a single
repeated character. Display name: 2-20 chars, alphanumeric start.

### `POST /api/auth/login` → `200`
`{ "email", "password" }`. Returns the same shape as register.
Failure is always `401 UNAUTHORIZED` with an identical message whether the
email exists or not, and always performs a full KDF pass so response timing
cannot enumerate accounts.

### `POST /api/auth/logout` → `200`
Revokes the current session and clears both cookies.

### `GET /api/auth/session` → `200`
`{ "data": { "authenticated": true, "user": {...} } }` — used to restore state on load.

### `POST /api/auth/password` → `200` 🔒
`{ "currentPassword", "newPassword" }` → `{ "sessionsRevoked": 3 }`.
Revokes every *other* session on success.

---

## 4. Player

### `GET /api/player` → `200` 🔒
The complete authenticated state: profile, decorated roster, teams, missions,
active battle id and the fairness triple.
```jsonc
{ "data": {
    "profile": { "displayName":"Solvane","level":4,"xp":820,"xpForNext":2140,
                 "crystals":22110,"zeni":501560,"souls":5064,
                 "pass":{"active":true,"expiresAt":null,"perks":["…"]},
                 "stamina":{"unlimited":true},
                 "pity":{"sinceSparking":3,"sinceLegends":41},
                 "counters":{"battlesWon":7,"summons":30,"rosterSize":26},
                 "clearedStages":{"ch1-1":"2026-07-28T19:08:51Z"},
                 "settings":{"reducedMotion":false,"screenShake":true,"theme":"nebula"} },
    "roster": [ { "fighterId":"tiro-2-1","title":"Immovable Tiron","rarity":"SPARKING",
                  "level":12,"stars":1,"zPower":1400,
                  "stats":{ }, "power":41230,
                  "starProgress":{"stars":1,"next":2,"current":900,"required":1000,"percent":90},
                  "maxLevel":50,"nextTrainingCost":2035 } ],
    "teams": [ { "slotIndex":0,"name":"Squad","members":["…"] } ],
    "missions": [ { "id":"daily-login","progress":1,"target":1,
                    "complete":true,"claimed":false,"claimable":true } ],
    "activeBattleId": null,
    "fairness": { "serverSeedHash":"…","clientSeed":"seed_…","nonce":30 } } }
```

| Endpoint | Method | Body | Notes |
|---|---|---|---|
| `/api/player/profile` | PATCH 🔒 | `{ displayName }` | 409 `NAME_TAKEN` on clash |
| `/api/player/settings` | PATCH 🔒 | any of `reducedMotion, screenShake, damageNumbers, autoAdvance, soundEnabled, theme` | All optional |
| `/api/player/ledger?limit=50` | GET 🔒 | — | Newest first, max 200 |
| `/api/player/export` | GET 🔒 | — | GDPR portability, full JSON |
| `/api/player` | DELETE 🔒 | — | GDPR erasure, irreversible |

---

## 5. Summoning

### `POST /api/summon` → `200` 🔒
```jsonc
// request — count must be exactly 1 or 10
{ "bannerId": "legendary-rising", "count": 10 }
// response
{ "data": {
    "results": [ { "fighterId":"tiro-2-1","title":"Immovable Tiron","rarity":"SPARKING",
                   "element":"YELLOW","featured":false,"isNew":true,
                   "zPower":1200,"zPowerTotal":1200,"stars":1,"starsGained":1,
                   "pityApplied":"multi_guarantee","art":{ } } ],
    "crystals": 24000,
    "pity": { "sinceSparking":0, "sinceLegends":10 },
    "verification": { "serverSeedHash":"f3b2…","clientSeed":"seed_…","nonce":0,
                      "algorithm":"HMAC-SHA512(serverSeed, `${clientSeed}:${nonce}:${cursor}`)" },
    "roster": [ /* full decorated roster after the pull */ ] } }
```
`pityApplied` is `null`, `"sparking"`, `"legends"` or `"multi_guarantee"`.

| Endpoint | Method | Notes |
|---|---|---|
| `/api/summon/history` | GET 🔒 | Last 30 sessions with verification data |
| `/api/summon/rotate-seed` | POST 🔒 | New client seed, nonce reset to 0 |

**Verifying a pull.** After a server-seed rotation the raw seed is published.
Recompute `HMAC-SHA512(serverSeed, clientSeed:nonce:cursor)`, read 6-byte
big-endian chunks as floats in `[0,1)`, and replay the weighted selection in
the documented rate table. Any divergence is proof of manipulation.

---

## 6. Roster & teams

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/api/roster/train` | POST 🔒 | `{ fighterId, levels }` | `{ entry, levelsGained, zeni }` |
| `/api/roster/soul-boost` | POST 🔒 | `{ fighterId, stat, points }` | `{ entry, pointsGained, souls }` |
| `/api/teams` | PUT 🔒 | `{ slotIndex, name, members[] }` | `{ team, teams }` |

`stat` ∈ `hp, strike, blast, strDef, blsDef, crit`.
Training stops at the star-gated level cap; partial application is normal and
`levelsGained` reports what actually happened.

---

## 7. Battles

### `POST /api/battles` → `201` 🔒
```jsonc
{ "stageId": "ch1-1", "members": ["tiro-2-1","verd-1-1","kalb-1-0"] }
```
Returns `{ battleId, stage, state, events }`. `409 BATTLE_IN_PROGRESS` if one
is already active.

### `POST /api/battles/:id/action` → `200` 🔒
```jsonc
{ "action": "card", "cardUid": "c7" }   // card | vanish | switch | rising_rush | main_ability | charge
```
`switch` requires `slot` (0-2); `card` requires `cardUid`.

Response:
```jsonc
{ "data": { "state": { /* full authoritative view */ },
            "events": [ { "type":"card_play","side":"player","arts":"SPECIAL",
                          "moveName":"Blazing Vortex Zero","vfx":"VORTEX","comboIndex":0 },
                        { "type":"damage","amount":4247,"critical":true,"element":"advantage",
                          "hpBefore":11575,"hpAfter":7328,"maxHp":11575 },
                        { "type":"rush_orb","side":"player","total":3 },
                        { "type":"ko","side":"enemy","fighterId":"…" },
                        { "type":"battle_end","winner":"player","counts":18 } ],
            "rewards": { "won":true,"crystals":110,"zeni":1560,"souls":64,
                         "xp":340,"firstClear":true,"level":2 } } }
```

**Event types:** `battle_start`, `card_play`, `damage`, `ability`, `gauge_full`,
`main_ability`, `vanish`, `charge`, `switch`, `rush_orb`,
`rising_rush_ready`, `rising_rush`, `endurance`, `ko`, `tick`, `battle_end`.

The client treats `events` as an animation script and `state` as the truth to
settle on afterwards.

| Endpoint | Method | Notes |
|---|---|---|
| `/api/battles/:id` | GET 🔒 | Resume after refresh |
| `/api/battles/:id/forfeit` | POST 🔒 | Counts as a loss, frees the slot |

### `POST /api/missions/claim` → `200` 🔒
`{ missionId }` → `{ mission, reward, crystals, zeni, souls, missions }`.
`409 ALREADY_CLAIMED`, `422 MISSION_INCOMPLETE`.

---

## 8. Client state management

```
store (observable, ~90 lines)
├── phase          'boot' | 'auth' | 'ready'
├── user           identity
├── profile        currencies, level, pass, settings, pity
├── roster         decorated entries (stats, power, star progress)
├── teams
├── missions
├── catalogue      static data + O(1) byId index
├── fairness       seed hash, client seed, nonce
└── activeBattleId

store.on(key, fn)  → re-render only subscribers of that key
store.set(patch)   → diffed by reference; unchanged keys notify nobody
```

Currency pills tween between values with `requestAnimationFrame`, so rewards
visibly land rather than snapping.

---

## 9. UI component hierarchy

```
#app
├── .backdrop                     animated starfield (CSS only)
├── nav.desktop-rail              ≥1024px
└── .app-col
    ├── header.hdr                brand + animated wallet pills
    ├── main.main                 ← view mount point
    │   ├── auth        landing + register/login
    │   ├── home        XP, free-pass banner, missions, top fighters, progress
    │   ├── summon      banner tabs, featured strip, rates, pity, reveal overlay
    │   ├── roster      filter bar + lazy 464-card grid → detail modal
    │   ├── battle      chapter tabs → stage grid → team picker
    │   └── settings    accessibility, profile, fairness, ledger, data, about
    └── nav.nav                   <1024px bottom bar

.arena (fixed overlay, mounted outside the shell)
├── .arena-shake                  transform driven by --shake-x/y
│   ├── canvas.arena-canvas       particle engine
│   ├── .speedlines
│   └── .stage                    sprites, damage numbers, banners, procs
├── .arena-flash                  impact flash (capped at 0.38 opacity)
├── .hud                          portraits, HP/Ki gauges, team pips, rush orbs
├── .arena-mid                    in-flow spacer + ground plane
└── .dock                         actions, 4-card hand, bench
```

### Keyboard controls (battle)
| Key | Action |
|---|---|
| `1`-`4` | Play hand card 1-4 |
| `V` | Vanishing Step |
| `R` | Rising Rush (when ready) |
| `C` | Charge Ki |
| `Esc` | Close dialogs |
