# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `main` | ✅ |
| Older tags | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting:
**Security → Advisories → Report a vulnerability** on this repository.

Include:
- affected component (server, client, demo build),
- reproduction steps,
- impact assessment,
- suggested fix if you have one.

I aim to acknowledge within 72 hours and to ship a fix or a mitigation plan
within 14 days for anything rated High or Critical.

## Scope

**In scope**
- Authentication and session handling (`server/services/authService.js`)
- CSRF, rate limiting and security headers (`server/middleware.js`)
- Input validation (`server/core/validate.js`)
- Economy integrity — anything that mints currency or fabricates results
- Data isolation between players

**Out of scope**
- The **static demo build** (`/demo`, GitHub Pages). It has no server, so all
  state lives in `localStorage` and is trivially editable *by design*. This is
  documented, expected, and not a vulnerability.
- Denial of service from self-hosting without a reverse proxy.
- Missing headers that are the deployment platform's responsibility (HSTS
  requires TLS termination you control).

## Security posture

- scrypt password hashing (N=2¹⁵, per-user salt)
- Session tokens stored **only** as SHA-256 digests
- Signed double-submit CSRF on every unsafe method
- Strict CSP with no `unsafe-inline` for scripts
- Schema validation on every input; mass assignment structurally impossible
- Append-only currency ledger with database-level invariants

Full detail: [`docs/SECURITY.md`](docs/SECURITY.md).
