# Legal & IP Notice

**Please read this before publishing or distributing this project.**

---

## 1. What this project is

Dragon Rush Heroes is an **original anime-styled action RPG**. It implements
the *systems* common to the collectible card-battler genre — an element wheel,
Arts-card combat, gacha summoning with pity, star-based limit breaking — using
an entirely original cast, original move names and artwork generated
procedurally at runtime.

**It contains no third-party intellectual property.** There are no licensed
characters, no copied artwork, no ripped audio, no trademarked logos, and no
copied text.

---

## 2. Why the cast is original

The original brief asked for a clone of a commercially published title,
including its characters. That is not something that can be responsibly built,
so the IP layer was replaced. The reasoning:

**Game mechanics are not protected expression.** Rules and systems — a
five-element advantage wheel, drawing cards to spend a resource, accumulating
duplicates into a star rating — are widely reimplemented across the genre and
are generally outside the scope of copyright. Reproducing *mechanics* is
legitimate, and this project does so faithfully and in depth.

**Characters, names, artwork and audio are protected, on multiple axes:**

| Asset | Protection | Consequence of copying |
|---|---|---|
| Character designs & names | Copyright + trademark | Takedown, statutory damages |
| Official artwork / 3D models | Copyright | Takedown, damages |
| Voice acting & music | Copyright + performers' rights | Takedown, damages |
| Series logos & wordmarks | Trademark | Injunction, dilution claim |
| Story and dialogue | Copyright | Takedown |

Rights holders in this genre actively enforce against fan clones. A project
distributing their characters would be removed regardless of technical quality,
which would make the work worthless. **Original IP is what makes this project
shippable.**

---

## 3. The original cast

| Element | Origin |
|---|---|
| 80 character lineages | Original, written for this project |
| 464 fighters | Generated from those lineages |
| Names (Kalen, Brakka, Glacius, Solvane…) | Original |
| Move names | Procedurally composed from an original word bank |
| Portraits | Drawn on `<canvas>` at runtime from a seed — no image files exist |
| Chapters & stages | Original |
| Currency names (Chrono Crystals, Zeni, Souls) | Generic genre terminology |

Because artwork is *generated*, the repository contains **zero image bytes**.
There is nothing to accidentally infringe.

---

## 4. Deliberately generic terminology

Some terms in this project are common genre vocabulary rather than protected
marks: "Sparking", "Extreme", "Hero", "Legends Limited", "Ultra", "Rising
Rush", "Vanishing Step", "Z-Power", "Zeni", "Chrono Crystals".

**Be aware:** several of these are associated with a specific commercial title
and some may be registered trademarks in some jurisdictions. They are used here
as descriptive mechanical labels, not as branding, and the game is not
presented as being connected to any commercial product.

> **If you intend to publish this commercially, rename them.** They are all
> defined as data in `server/domain/content.js` (`RARITIES`, `ARTS`) and
> `server/domain/economy.js`, so renaming is a single-file change.

---

## 5. The product name — resolved

The project was originally drafted under a working title that incorporated the
registered trademark "Dragon Ball". **That has been removed.** The product is
now **Dragon Rush Heroes**.

### What changed

| Was | Now | Why |
|---|---|---|
| "Dragon Ball Heroes" (product name) | **Dragon Rush Heroes** | Removes the registered mark |
| "Dragon Balls" (the seven collectible orbs) | **Rush Orbs** | The named orb-collection mechanic is strongly associated with the mark |
| `dbh_session` / `dbh_csrf` cookies | `drh_session` / `drh_csrf` | Consistency |
| `DRAGON_BALLS_TO_RUSH` constant | `RUSH_ORBS_REQUIRED` | Consistency |
| npm package `dragonball-heroes` | `dragon-rush-heroes` | Consistency |

"Dragon" is a generic English word in very wide use across game titles and is
not exclusive to any franchise; "Rush" is likewise generic. The combination
"Dragon Rush Heroes" does not reproduce a registered mark, and a search
returned no conflicting project under that name.

### Verification

A repository-wide scan confirms **zero** occurrences of the previous mark in
any source file, stylesheet, template, test, manifest or document. The only
remaining references are in this file, which exists to record the change.

> **Residual note.** No trademark position is ever absolute. If you intend to
> publish commercially at scale, have a solicitor run a formal clearance search
> in your target jurisdictions. This rename removes the obvious, high-risk
> conflict; it is not a substitute for professional clearance.

---

## 6. Third-party components

| Component | Licence | Use |
|---|---|---|
| Node.js runtime | MIT | Execution |
| Google Fonts (Inter, Rajdhani, JetBrains Mono) | SIL Open Font License 1.1 | Typography (self-host to remove the CDN dependency) |
| npm dependencies | — | **None. Zero runtime dependencies.** |

Puppeteer is used for browser testing only and is not part of the shipped
application.

---

## 7. Monetisation

The project has **no monetisation of any kind**: no payments, no store, no
advertising, no telemetry, no subscription. This is a product decision, and it
also removes an entire category of legal obligation — consumer-protection rules
on loot boxes, app-store billing terms, gambling-adjacent disclosure
requirements and refund handling simply do not apply.

Summon rates are published in-app and cryptographically verifiable, which
exceeds the disclosure standards required in the jurisdictions that regulate
loot boxes.

---

## 8. Data protection

| Obligation | Status |
|---|---|
| Data minimisation | Email + display name only |
| Portability (GDPR Art. 20) | One-click JSON export |
| Erasure (GDPR Art. 17) | One-click deletion, cascade-verified |
| Security (GDPR Art. 32) | scrypt hashing, digest-only sessions, strict CSP |
| Tracking / profiling | None. No analytics, no third-party scripts |

A published deployment still needs its own privacy policy and terms of service
naming the actual operator. None are bundled, because they would be false.

---

## 9. Summary for a publisher

✅ **Safe:** all code, all game systems, all 464 characters, all artwork, the
entire economy — **and the product name**, following the §5 rename.

⚠️ **Consider changing:** the genre-standard rarity labels listed in §4
("Sparking", "Extreme", "Legends Limited", "Ultra", "Z-Power", "Zeni",
"Chrono Crystals"), if commercial publication is intended. These are
descriptive mechanical labels defined as data in `server/domain/content.js`
and `server/domain/economy.js`, so renaming any of them is a single-file
change.

📋 **Add before launch:** your own privacy policy and terms of service; TLS
termination; off-host backups; and a formal trademark clearance search if
publishing commercially.


---

*This document is engineering guidance, not legal advice. Obtain a professional
IP review before commercial publication.*
