# System Architecture — Dragon Ball Heroes

**Style:** Modular monolith · **Runtime:** Node.js ≥ 18 · **Dependencies:** zero

---

## 1. Architectural decisions

### ADR-1 — Modular monolith over microservices
A single deployable with strictly enforced internal module boundaries. The
domain is small and highly cohesive (one player's data is touched by one
request); distributing it would add network partitions, eventual consistency
and deployment complexity in exchange for nothing. The boundaries below are
drawn so that `services/` could be split out later without touching `domain/`.

### ADR-2 — Zero runtime dependencies
No Express, no ORM, no bundler. Rationale:
- **Supply chain.** The average Express app pulls 50+ transitive packages. Zero
  dependencies means zero third-party code executing on the server.
- **Longevity.** Nothing to upgrade, nothing to deprecate. The app will boot
  unchanged in five years.
- **Deployability.** The container is `node:20-alpine` plus source. No install
  step, no lockfile drift, sub-second cold starts.

The cost is ~600 lines of HTTP kernel in `core/http.js`. Its API is deliberately
Express-shaped so the trade can be reversed by replacing one file.

### ADR-3 — Server-authoritative combat
The client sends *intents* ("play card X"); the server owns all state and
computes all outcomes. A tampered client can request an illegal move and be
rejected, but cannot fabricate damage, currency or drops. This is the only
correct design for a game with an economy.

### ADR-4 — Deterministic content generation
464 fighters are *generated* from 80 curated lineages via a seeded PRNG rather
than stored as data. Fighter ids and stats are therefore identical on every
node and across restarts — a requirement, since roster rows reference fighter
ids. Adding a lineage adds ~6 fighters without touching a database.

### ADR-5 — Procedural artwork
Every portrait is drawn on a canvas from a seed. This eliminates the largest
asset cost in the genre (hundreds of MB of character art), guarantees stylistic
consistency across 464 characters, and removes all third-party artwork from the
project.

### ADR-6 — Embedded WAL store, PostgreSQL-ready
The default persistence engine is an in-process document store with a
write-ahead log and atomic snapshots. It gives durability and transactions with
no native modules. `data/repositories.js` is the only module that knows it
exists; `db/schema.sql` contains the equivalent PostgreSQL DDL for the scale-out
path.

---

## 2. Module boundaries

```
┌──────────────────────────────────────────────────────────────────┐
│                          BROWSER (SPA)                           │
│  views/ ── render only, no business rules                        │
│  core/store.js ── observable state    core/api.js ── transport   │
│  core/vfx.js ── particle engine       core/portrait.js ── art    │
└───────────────────────────┬──────────────────────────────────────┘
                            │ JSON over HTTPS, cookie session + CSRF
┌───────────────────────────▼──────────────────────────────────────┐
│                       HTTP LAYER (server)                        │
│  core/http.js ── router, body parsing, static, compression       │
│  middleware.js ── CSP, CORS, rate limit, session, CSRF           │
│  routes/index.js ── endpoint table, thin handlers                │
├──────────────────────────────────────────────────────────────────┤
│                       SERVICE LAYER                              │
│  services/authService.js ── credentials, sessions, erasure       │
│  services/gameService.js ── transactional game operations        │
│      ↑ owns transaction boundaries; never touches HTTP           │
├──────────────────────────────────────────────────────────────────┤
│                        DOMAIN LAYER                              │
│  domain/content.js ── roster, elements, banners, stages          │
│  domain/combat.js  ── battle engine (pure, deterministic)        │
│  domain/economy.js ── gacha, pity, progression curves            │
│      ↑ zero I/O, zero framework knowledge, trivially testable    │
├──────────────────────────────────────────────────────────────────┤
│                         DATA LAYER                               │
│  data/repositories.js ── the storage seam                        │
│  data/store.js ── WAL + snapshot engine                          │
└──────────────────────────────────────────────────────────────────┘
```

**Dependency rule:** dependencies point downward only. `domain/` imports
nothing from `services/`, `routes/` or `data/`. This is what makes the combat
engine testable without a server and portable to a future PvP worker.

---

## 3. Canonical folder tree

```
dragonball-heroes/
├── package.json                  # zero deps; start/test/verify scripts
├── README.md
│
├── server/
│   ├── index.js                  # boot, DI wiring, graceful shutdown
│   ├── config.js                 # validated env config, secret policy
│   ├── middleware.js             # security headers, CORS, rate limit, CSRF
│   │
│   ├── core/                     # framework-level primitives
│   │   ├── http.js               # HTTP kernel: router, static, gzip
│   │   ├── crypto.js             # scrypt, tokens, HMAC, FairRandom
│   │   ├── errors.js             # AppError taxonomy
│   │   ├── logger.js             # structured JSON logging with redaction
│   │   └── validate.js           # declarative schema validation
│   │
│   ├── domain/                   # pure business logic (no I/O)
│   │   ├── content.js            # 464 fighters, elements, banners, stages
│   │   ├── combat.js             # deterministic battle engine
│   │   └── economy.js            # gacha, pity, curves, free-forever charter
│   │
│   ├── data/
│   │   ├── store.js              # WAL + snapshot document store
│   │   └── repositories.js       # storage seam (swap here for Postgres)
│   │
│   ├── services/
│   │   ├── authService.js
│   │   └── gameService.js
│   │
│   └── routes/
│       └── index.js
│
├── public/                       # static SPA, served directly
│   ├── index.html
│   ├── styles/
│   │   ├── main.css              # design system, shell, components
│   │   └── battle.css            # arena, sprites, VFX choreography
│   └── app/
│       ├── main.js               # bootstrap, router, shell chrome
│       ├── core/
│       │   ├── api.js            # typed API client with CSRF
│       │   ├── store.js          # observable state container
│       │   ├── ui.js             # DOM builder, toasts, modals
│       │   ├── portrait.js       # procedural character art + LRU cache
│       │   └── vfx.js            # pooled canvas particle engine
│       └── views/
│           ├── auth.js  home.js  summon.js
│           ├── roster.js  battle.js  settings.js
│
├── db/
│   └── schema.sql                # PostgreSQL DDL for the scale-out path
│
├── docs/
│   ├── PRD.md  ARCHITECTURE.md  API.md
│   ├── SECURITY.md  IMPLEMENTATION.md  LEGAL.md
│
└── tests/
    ├── run.js                    # 86 unit + integration tests
    ├── e2e.js                    # 25 browser tests (Puppeteer)
    └── smoke.js                  # fast post-deploy health check
```

---

## 4. Request lifecycle

```
1. Node http server receives the request
2. core/http.js builds req (path, query, cookies, ip, requestId) and res helpers
3. Middleware pipeline, in order:
      securityHeaders  → CSP, HSTS, nosniff, frame-deny
      cors             → allow-list; terminates OPTIONS
      rateLimit        → per-IP or per-account fixed window
      sessionLoader    → cookie → session → user → player
      csrfProtection   → double-submit check on unsafe methods
4. Route match → params extracted → body parsed (size-capped)
5. Route guards (requireAuth, per-bucket rateLimit)
6. Handler validates input with a schema, delegates to a service
7. Service opens a store transaction, calls domain logic, writes the ledger
8. Response serialised as { data } and gzipped when worthwhile
9. finish → structured access log with duration
```

Any thrown `AppError` is mapped to its status and safe envelope; anything else
is logged with a stack and returned as a generic 500.

---

## 5. Persistence model

### Write path
```
service.transaction(fn)
  → serialised on a promise queue (one writer at a time)
  → fn() mutates in-memory collections, buffering ops in a journal
  → on success: journal appended to WAL as NDJSON, then fsync
  → on throw:   in-memory state rolled back from captured undo records
  → WAL > 2 MiB: compact to snapshot.json via write-temp-then-rename
```

### Recovery path
```
open() → load snapshot.json → replay wal.log line by line
       → a torn final line (crash mid-write) is discarded
       → reopen WAL for append
```

### Guarantees
- **Atomicity** — a transaction fully applies or fully rolls back.
- **Durability** — fsync before a write is acknowledged.
- **Isolation** — single-writer serialisation; no dirty reads.
- **Consistency** — reads return deep copies, so committed state is immutable
  to callers.

### Scaling to PostgreSQL
Reimplement `data/repositories.js` against `pg` using `db/schema.sql`. Domain
and service code is untouched because they only ever call repository methods.

---

## 6. Client architecture

**Rendering:** direct DOM construction via an `el()` builder. No virtual DOM,
no framework. At this surface area a VDOM buys reconciliation the app does not
need and costs bundle size plus a layer of indirection between the code and the
frame timing the battle screen depends on.

**State:** a ~90-line observable store. Views subscribe to specific keys and
re-render only on changes to those keys, so a currency tick does not repaint a
464-card grid.

**Animation:** two independent systems.
- CSS handles discrete, declarative motion (card deals, banners, cut-ins) —
  transforms and opacity only, so it composites off the main thread.
- Canvas handles continuous particle effects through one `requestAnimationFrame`
  loop over a pre-allocated pool of 1,400 particles. Nothing is allocated per
  frame, so the GC never stutters mid-combo. The loop suspends itself when
  nothing is on screen.

**Battle presentation:** the server returns an ordered event timeline; the
client walks it with per-event delays, firing VFX and gauge tweens. The engine
therefore drives the visuals without knowing anything about the renderer, and
the renderer can be replaced wholesale without touching game logic.

---

## 7. Performance strategy

| Concern | Mitigation |
|---|---|
| 464-card grid scroll | IntersectionObserver lazy painting + `contain: layout paint` |
| Repeated portrait draws | LRU cache keyed by `seed@size` (320 entries) |
| Particle GC pressure | Fixed 1,400-object pool, mutated in place |
| Idle CPU | RAF loop self-suspends when no particles or overlays are live |
| Layout thrash | Only `transform`/`opacity` animate; shake via CSS variable |
| Payload | gzip on text responses > 1 KB; immutable caching for hashed assets |
| Reflow on resize | Canvas backing store resized on a passive listener |

---

## 8. Deployment

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000
VOLUME /app/.data
HEALTHCHECK --interval=30s CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "server/index.js"]
```

**Required in production:** `SESSION_SECRET` and `GACHA_SECRET`, each ≥ 32
characters, injected by the orchestrator. The process refuses to boot without
them — a deliberate fail-fast so a misconfigured deploy never serves traffic
with ephemeral secrets.

**Horizontal scaling:** replace the in-memory rate-limiter map with Redis and
the embedded store with PostgreSQL. Sessions are already stateless at the
cookie layer (opaque token → hashed lookup), so no sticky sessions are needed.
