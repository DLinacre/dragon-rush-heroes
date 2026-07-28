# Security, Auth & Quality Standards

**Threat model:** a public web game with a virtual economy. The realistic
adversaries are (1) players trying to mint currency or fake wins, (2)
credential-stuffing bots, (3) opportunistic XSS/CSRF, and (4) scrapers and
denial-of-service traffic. There is no payment data and no PII beyond an email
address, which deliberately keeps the blast radius of any breach small.

---

## 1. Authentication

### Password storage
`scrypt` with OWASP-recommended interactive parameters, tuned in `config.js`:

```
N = 32768 (2^15)   memory hardness — ~32 MB per hash
r = 8              block size
p = 1              parallelisation
keylen = 64        output length
salt = 16 random bytes, unique per user
```

Stored as `scrypt$N$r$p$saltB64$hashB64`. Encoding the parameters means they
can be raised later and existing hashes still verify, enabling transparent
rehash-on-login.

**Why scrypt over bcrypt:** memory hardness defeats GPU/ASIC cracking rigs far
more effectively than bcrypt's CPU cost alone, and it is in the Node standard
library — consistent with the zero-dependency constraint.

### Account enumeration resistance
An unknown email still runs a full KDF pass against a pre-computed dummy hash,
so login latency is indistinguishable between "no such account" and "wrong
password". Both return the identical `401` message.

```js
if (!user) { await verifyPassword(dto.password, DUMMY_HASH); throw unauthorized(...); }
```

### Brute-force protection
Two independent layers:
- **Per-account:** 8 consecutive failures → 15-minute lock (`403 ACCOUNT_LOCKED`).
  Counter resets on success.
- **Per-IP:** 12 credential requests per minute (`429 RATE_LIMITED`).

### Session management
| Property | Implementation |
|---|---|
| Token | 32 random bytes, base64url, opaque |
| Storage | **Only** the SHA-256 digest is persisted |
| Transport | `HttpOnly; SameSite=Lax; Secure` (Secure auto-set in production) |
| Lifetime | 7 days, absolute |
| Revocation | Individually, or all-but-current on password change |
| Cleanup | Background sweep every 15 minutes |

A database disclosure yields digests, not tokens — stolen rows cannot be
replayed as logins.

---

## 2. CSRF defence

Signed double-submit, layered with `SameSite`:

1. A CSRF value is derived as `HMAC-SHA256(sessionSecret, "csrf:" + sessionId)`
   and set in a **readable** cookie.
2. Unsafe methods must echo it in `X-CSRF-Token`.
3. The server re-derives and compares in constant time.

Because the token is an HMAC over the session id, it is stateless (no server
storage, works across nodes) and cannot be forged without the secret. For
unauthenticated `POST`s (login/register) there is no session yet, so the
`Origin` header is validated against the host instead.

---

## 3. Input validation

**Rule: no raw client JSON ever reaches domain logic.** Every endpoint declares
a schema; `validate()` both checks and coerces, and returns an object
containing *only* schema-declared keys, so mass-assignment is structurally
impossible.

```js
const dto = validate(req.body, {
  bannerId: rules.id(),
  count:    rules.int({ min: 1, max: 10, default: 1 }),
});
```

Defences built into the rule set:

| Vector | Mitigation |
|---|---|
| Mass assignment | Output object contains only declared keys |
| Oversized payloads | 64 KB ceiling enforced *during* streaming, connection destroyed |
| Control-character injection | Stripped by the sanitiser |
| Unicode homograph tricks | NFKC normalisation |
| Path traversal in ids | `rules.id()` restricts to `[A-Za-z0-9_-]` |
| Prototype pollution | Cookies parsed into `Object.create(null)`; no recursive merge of client data |
| Type confusion | Explicit coercion with `Number.isInteger` checks |
| Array bombs | Every array rule has a hard `max` |

---

## 4. XSS prevention

- **No `innerHTML` with user data anywhere.** All user-controlled text goes
  through `textContent` via the `el()` builder. `innerHTML` is used only for
  static, developer-authored SVG icon markup.
- **Strict CSP** with no `unsafe-inline` for scripts:

```
default-src 'self';
script-src  'self';
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com;
img-src     'self' data: blob:;
font-src    'self' data: https://fonts.gstatic.com;
connect-src 'self';
object-src  'none';
base-uri    'none';
frame-ancestors 'none';
upgrade-insecure-requests
```

`style-src` permits inline styles because the battle engine writes dynamic
transform values to `style` attributes for 60 fps animation. This is a
documented, bounded trade-off: style injection cannot execute script, and
`script-src 'self'` remains absolute.

> **Note:** the usual `<link media="print" onload="this.media='all'">` font trick
> is deliberately *not* used — an inline event handler would violate
> `script-src 'self'`. The stylesheet is linked normally with `display=swap`.

### Full header suite
| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Permissions-Policy` | geolocation, microphone, camera, payment, USB all denied |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` (production) |

---

## 5. Access control

Authorisation is **ownership-based** and checked in the service layer, never
inferred from the request:

```js
const battle = this.repos.getBattle(battleId);
if (!battle || battle.playerId !== playerId) throw notFound('Battle not found.');
```

Note it returns `404`, not `403` — a `403` would confirm the resource exists,
leaking information about other players' data.

Every game action re-validates ownership server-side:
- Battling with a fighter → must be in the caller's roster (`422 NOT_OWNED`)
- Training/boosting → roster entry must belong to the caller
- Battle actions → battle must belong to the caller and be `active`

---

## 6. Economy integrity

This is the highest-value attack surface, so it has four independent controls:

1. **Server-authoritative computation.** The client sends intents only. All
   damage, drops and rewards are computed server-side. A modified client can
   request an illegal action and be rejected; it cannot fabricate an outcome.

2. **Atomic transactions.** Debit, roster mutation, pity advance and ledger
   write happen in a single transaction. A crash mid-summon rolls back
   completely — crystals are never taken without fighters being granted.

3. **Append-only ledger.** Every currency movement is recorded with
   `balanceAfter`. Any balance is reconstructible, and a discrepancy between
   the ledger sum and the stored balance is a detectable exploit signature.
   In PostgreSQL this is enforced by a `BEFORE UPDATE OR DELETE` trigger.

   > **Implementation note:** a `CREATE RULE … DO INSTEAD NOTHING` was the
   > obvious way to enforce append-only and is *wrong* — it rewrites
   > PostgreSQL's referential-integrity probe and silently breaks
   > `ON DELETE CASCADE`, which would have made GDPR account erasure fail.
   > The trigger allows deletes only when `pg_trigger_depth() > 1` (i.e. from a
   > cascade). This was caught by running the schema against a live database.

4. **Database-level invariants.** `CHECK (crystals >= 0)` and friends are the
   last line of defence if a service-layer bug ever permits a negative balance.

### Provably-fair RNG
Summon outcomes derive from
`HMAC-SHA512(serverSeed, "${clientSeed}:${nonce}:${cursor}")`. The SHA-256 of
the server seed is published *before* any pull. After a seed rotation the raw
seed is revealed, letting any player recompute every historical summon and
verify the operator never re-rolled. Players can rotate their own client seed
at any time to start a fresh chain they control an input to.

---

## 7. Denial-of-service resistance

| Vector | Mitigation |
|---|---|
| Request flooding | Fixed-window limiter; per-account when authenticated |
| Large bodies | 64 KB cap enforced during streaming, socket destroyed |
| Slowloris | 15 s request timeout, 20 s headers timeout |
| Memory exhaustion | Bounded particle pool; limiter map swept every 60 s |
| Unbounded growth | Sessions and finished battles purged on a 15-minute sweep |
| Expensive KDF abuse | scrypt is behind the 12/min auth limiter |
| Zip bombs | No file uploads exist |

---

## 8. Secret management

Secrets come from the environment only. The process **refuses to boot** in
production without them:

```js
if (IS_PROD) throw new Error(`FATAL: ${key} is required in production and must be >= 32 characters.`);
```

This is deliberate fail-fast: a container that starts with an ephemeral secret
would invalidate every session on restart and break horizontal scaling — far
worse than a failed deploy.

| Secret | Purpose | Rotation |
|---|---|---|
| `SESSION_SECRET` | Session/CSRF HMAC | Invalidates all sessions |
| `GACHA_SECRET` | Provably-fair server seed | Publish the old seed on rotation |

Development derives a deterministic per-machine secret so contributors boot
with zero setup. Secrets are never logged: the logger redacts `password`,
`token`, `passwordHash`, `secret`, `authorization`, `cookie` and related keys
at any nesting depth.

---

## 9. Privacy & compliance

| Right | Implementation |
|---|---|
| Data minimisation | Email + display name only. No tracking, analytics or third-party scripts |
| Portability (GDPR Art. 20) | `GET /api/player/export` → complete JSON |
| Erasure (GDPR Art. 17) | `DELETE /api/player` → cascades across all 7 tables, verified |
| Transparency | Full currency ledger visible in-app |

---

## 10. Testing strategy

### Pyramid
```
        ╱ 25 E2E (Puppeteer, real Chrome) ╲      full journeys, zero console errors
      ╱  30 HTTP integration (real server) ╲     auth, CSRF, rate limits, economy
    ╱     56 unit (crypto, validation,      ╲    formulas, invariants, determinism
   ╱        store, combat, content, economy) ╲
```

**111 automated checks total.** `npm test` runs the 86 unit + integration tests
in ~2 seconds; `node tests/e2e.js` drives a real browser through the complete
journey.

### What is covered
| Area | Representative assertions |
|---|---|
| Crypto | Hash/verify round trip, unique salts, malformed input, timing-safe compare, CSRF binding, RNG determinism and range |
| Validation | Weak/common passwords, bad emails, control-char stripping, bounds, array caps, display-name rules |
| Store | WAL recovery after simulated crash, **full rollback on throw**, defensive copies, index maintenance, 50 concurrent transactions without lost updates |
| Content | 400+ fighters, unique ids, determinism across rebuilds, stat monotonicity by rarity, element wheel maths, all banner/stage references resolve, rate tables sum to 1.0 |
| Economy | Founder grant exactly 25,000, pass never expires, star ladder caps at 7, summon reproducibility, multi guarantee, hard pity, duplicate→Z-Power |
| Combat | Ki costs, illegal moves rejected, **charge prevents deadlock**, vanish/rush/switch gating, element damage, HP never negative, full-battle determinism, snapshot round trip, no engine internals leaked, AI always legal |
| HTTP | Security headers, weak-password rejection, duplicate email, **missing and forged CSRF**, crystal debit accuracy, concurrent-battle block, unowned-fighter rejection, ledger completeness, path traversal blocked, rate limiting, auth required |
| Browser | Landing copy, registration, dashboard, summon reveal, **portraits actually painting non-blank pixels**, roster grid, fighter detail, arena, full battle to result, settings, mobile overflow, zero console/page errors |

### Bugs this suite actually caught
1. **Combat deadlock** — a fighter with no Ki, empty vanish gauge and a spent
   Main Ability had no legal action. Fixed by adding `charge`.
2. **CSP blocking fonts** — the strict policy rejected `fonts.googleapis.com`.
3. **CSP blocking the font `onload` handler** — inline handlers violate
   `script-src 'self'`.
4. **Empty battle stage** — the arena rendered no fighters and the dock
   floated mid-screen; fixed with an in-flow spacer, ground plane and sprites.
5. **Blown-out impact flash** — white overlay at 0.75 opacity washed the scene
   out; capped at 0.38 with faster decay.
6. **Ledger rule breaking GDPR erasure** — the append-only `RULE` broke FK
   cascade; replaced with a depth-aware trigger.

### Running
```bash
npm test            # 86 unit + integration (~2 s)
node tests/e2e.js   # 25 browser tests (requires Chrome)
npm run smoke       # fast post-deploy health check
```

---

## 11. Pre-production checklist

- [x] Zero runtime dependencies (no supply-chain surface)
- [x] Secrets required in production; boot fails without them
- [x] All passwords scrypt-hashed; never logged or returned
- [x] Session tokens stored only as digests
- [x] CSRF enforced on every unsafe method
- [x] Strict CSP with no `unsafe-inline` for scripts
- [x] Full security header suite
- [x] Every input schema-validated
- [x] Ownership checked on every mutation
- [x] Rate limiting on all buckets
- [x] Append-only economy ledger
- [x] Graceful shutdown with data flush
- [x] Health endpoint for orchestrators
- [x] GDPR export and erasure, cascade-verified against live PostgreSQL
- [ ] TLS termination at the proxy (deployment responsibility)
- [ ] Off-host backups of `.data/` or the database (deployment responsibility)
