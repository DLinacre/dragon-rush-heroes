# Contributing to Dragon Rush Heroes

Thanks for taking an interest. This project has **zero runtime dependencies**,
so getting started takes one command.

## Getting started

```bash
git clone https://github.com/DLinacre/dragon-rush-heroes.git
cd dragon-rush-heroes
node server/index.js        # → http://localhost:3000
```

There is no `npm install`. If a change would introduce a runtime dependency,
please open an issue first — the zero-dependency property is a deliberate
architectural constraint, not an accident.

## Before you open a pull request

```bash
node tests/run.js      # 86 unit + integration tests  (~2 s)
node tests/smoke.js    # 25 deployment health checks  (~1 s)
node tests/e2e.js      # 26 browser tests (needs Chrome)
```

All three must pass. CI runs the same suites on Node 18, 20 and 22.

## Architecture rules

Dependencies point **downward only**:

```
routes → services → domain → (nothing)
                 ↘ data
```

- `server/domain/` must stay pure: no I/O, no framework imports. This is what
  makes the combat engine testable without a server.
- `server/data/repositories.js` is the only module that knows how storage
  works. Swapping to PostgreSQL should touch that file and nothing else.
- The client never computes game outcomes. It sends intents; the server
  decides. Any PR that moves damage/currency logic client-side will be
  declined.

## Code style

- CommonJS on the server, ES modules in `public/app/`.
- Comment the *why*, not the *what*. Explain non-obvious trade-offs.
- Prefer clarity over cleverness.
- Two-space indentation, single quotes, semicolons.

## Adding fighters

Fighters are generated, not hand-authored. Add a lineage to `LINEAGES` in
`server/domain/content.js` and roughly six fighters appear across its
transformation ladder. Generation is deterministic — run `node tests/run.js`
to confirm the roster stays stable and the rarity pyramid holds.

## Reporting bugs

Open an issue with reproduction steps, expected vs actual behaviour, and your
browser/Node version. For anything security-related, follow
[SECURITY.md](SECURITY.md) instead of filing a public issue.
