---
title: Aegis Chrome Extension — Implementation Plan
status: planned, nothing built
module: aegis/extension/ (new)
builds-on: aegis/paper_copytrade.mjs, aegis/dashboard.mjs
created: 2026-08-20
updated: 2026-08-20
tags:
  - dashboard
  - paper-copytrade
  - extension
---

# Aegis Chrome Extension — Implementation Plan

A floating overlay on gmgn.ai and dexscreener.com that shows the Aegis paper
book where you are already looking, and lets you place **paper** orders without
leaving the page.

**100% of the simulation stays in Aegis.** `paper_copytrade.mjs` owns whale
tracking, the Slot N+3…N+10 fill window, pool depth, and fee accounting.
`dashboard.mjs` owns the state and the server. DryFlip's repository
(`dryflip/memecoin-paper-trading-extension`) is used for the **extension codebase
foundation & visual layout styling**, expanded to connect to Aegis.

> [!info] The extension renders; it does not compute
> The same rule that governs the web dashboard, and for the same reason. The
> overlay displays `/api/state` verbatim — `equitySol`, `winRatePct`,
> `executionBand` — and never re-derives money in JavaScript. Three surfaces now
> show a P&L figure (terminal, dashboard, overlay) and there must remain exactly
> one place it is calculated. See
> [[03 Live Web Dashboard Plan#Correction 3 — the dashboard renders, it does not compute]].

---

## What this is worth building for

| Win | Why |
|---|---|
| **The book where your eyes already are** | You research on GMGN. Alt-tabbing to a dashboard is where a signal gets lost. |
| **Markers on the chart you are actually reading** | The Tier A chart draws our entries on *our* samples. This would put them on the venue's real candles — if it is possible at all, see [[#Correction 4 — markers on someone else's chart is the iframe problem again]]. |
| **Manual paper orders** | The book currently only mirrors a whale. Clicking a paper buy is how you test a discretionary idea for free. |
| **One portfolio drawer across venues** | GMGN, DexScreener, same overlay, same book. |

---

## Correction 1 — you do not need CORS, and adding it is the dangerous option

The spec asks for **CORS endpoints** reachable from `https://gmgn.ai`. That is
both unnecessary and the worst version of this design.

**Unnecessary**, because MV3 grants the service worker cross-origin `fetch`
through `host_permissions`. With `"http://127.0.0.1:3000/*"` declared, the
worker reaches the server with no CORS headers on the server at all. Content
scripts have been subject to CORS since Chrome 85, which is exactly why the
content script must not fetch directly:

```
content.js  ──chrome.runtime.sendMessage──▶  background worker  ──fetch──▶  127.0.0.1:3000
   (no network of its own)                    (host_permissions)             (no CORS headers)
```

**Dangerous**, because `Access-Control-Allow-Origin: https://gmgn.ai` grants
that power to *every script running on gmgn.ai* — their code, their ad slots,
their CDN, anything injected into that origin. The extension is a known
principal; an origin is not.

> [!danger] Ship no `Access-Control-Allow-*` header to a web origin. Ever.
> The absence of CORS headers is what stops a random page's `fetch()` from
> reaching your book. It is load-bearing, not an omission.
>
> One gap it does **not** close: a plain `<form method="POST">` is a *simple
> request* — no preflight, not blocked by CORS. So a mutating endpoint must
> require both `content-type: application/json` **and** a custom header
> (`X-Aegis-Token`). A custom header forces a preflight, the preflight fails
> without CORS headers, and the form route is closed too.

---

## Correction 2 — the server is read-only by design, and a test says so

From [[03 Live Web Dashboard Plan#Phase 2 — what shipped]]:

> **Read-only.** No route mutates anything — no pause, no manual exit, no config
> change. That is what makes `--dashboard-host 0.0.0.0` a viewer rather than a
> remote control.

`aegis/test/dashboard.test.mjs` asserts **405** for POST, PUT, DELETE and PATCH.
`POST /api/paper/buy` breaks that invariant and turns that test red. That is not
a reason to refuse the feature — manual paper orders are worth having — but the
invariant should be *replaced deliberately*, not deleted quietly.

**Keep read-only as the default. Gate mutation behind `--dashboard-control`:**

| Rule | Why |
|---|---|
| Control off unless `--dashboard-control` | A viewer stays a viewer. |
| **Refuse `--dashboard-control` with `--dashboard-host 0.0.0.0`** | Never a remote control on the LAN. Exit with a message, do not silently pick one. |
| `X-Aegis-Token`, random per run, printed at startup | Forces a preflight; a token in the extension's storage, never in a page. |
| Rewrite the 405 test as a **two-mode** test | Default run: POST still 405. Control run: POST accepted, and the token is required. |

> [!danger] The extension must have no path to `live_execute.mjs`
> `paper_copytrade.mjs` has no signer, no key and no route to one — that is a
> design constraint the file states in its header. The control endpoints extend
> the *paper* book only. If a live-trading endpoint is ever wanted it is a
> different server, a different flag and a different note.

---

## Correction 3 — an MV3 service worker cannot hold an SSE connection

The spec puts the SSE stream in `background.js`. **MV3 service workers are
terminated after roughly 30 seconds idle.** An `EventSource` there dies
repeatedly, and each revival re-subscribes and re-fetches a frame — the exact
churn phase 3 avoided by making the stream long-lived.

Three options, in the order I would try them:

1. **Content script owns the stream.** It lives as long as the tab, which is
   also exactly as long as the overlay is visible. Simplest, and the overlay is
   useless without a tab anyway.
2. **Offscreen document** (`chrome.offscreen`) for a page-independent
   connection, if the drawer should keep accumulating while no GMGN tab is open.
3. `chrome.alarms` to revive the worker — **not recommended**: the minimum
   period is 30 s, so it reconnects forever and still misses events.

Start with (1). Reach for (2) only when a real need appears.

---

## Correction 4 — markers on someone else's chart is the iframe problem again

[[03 Live Web Dashboard Plan#Correction 6 — you cannot draw your markers on someone else's iframe]]
settled this for the DexScreener embed: a cross-origin frame cannot be drawn
into, and phases 4–5 shipped a separate Tier A SVG chart precisely because of
it.

Injecting `B` / `S` markers onto **GMGN's native chart** is the same problem
with an extra unknown, and it is the highest-risk item in this plan:

| If GMGN's chart is… | Then |
|---|---|
| a TradingView widget in a **cross-origin iframe** | **Impossible.** Nothing reaches inside. Content scripts do not cross an origin boundary. |
| a **same-origin `<canvas>`** | Possible, but you need the price↔pixel transform, and it is not yours. It must be recovered by scraping axis labels or by hooking a library object on `window` — both undocumented, both break on any redesign. |
| same-origin **DOM/SVG** elements | Straightforward. Least likely for a trading chart. |

> [!warning] Prototype this FIRST, not last
> Everything else in this plan works regardless of the answer. This one item may
> be impossible, and finding out after the overlay is built is the expensive
> ordering. One afternoon with devtools on a GMGN token page settles it.
>
> **The fallback already exists and already works:** the Tier A SVG chart draws
> entry, scale-in, TP rungs and exit on our own samples, with no third-party
> cooperation, and it can be rendered inside the overlay's shadow root. Markers
> on GMGN's candles are an upgrade, not a requirement.

Two lesser notes: GMGN is defensive about automation — `auto_top_whales.mjs`
documents Cloudflare **403s** to programmatic requests — which does not block a
real browser but does suggest checking their terms before injecting into their
DOM. And the token URL path `gmgn.ai/sol/token/<mint>` is **still unverified**;
the repo only has `/sol/address/` for wallets.

---

## Correction 5 — a manual order has no whale slot, so the Phase 6 band does not apply

The Slot N+3…N+10 window measures **being late to someone else's trade**. It is
anchored to the target's slot, and the ~1.0–1.4 s floor is our observation lag —
the time to *see* a whale act.

A manual click has no whale to be late relative to. There is nothing to
reconstruct a window from, and reusing the copytrade band would be inventing a
latency that this trade does not have.

**Manual fills are a different pricing regime and must say so:**

- Priced at the **current mark**, with slippage and pool impact as usual.
- `executionBand: null` and `fillRegime: 'manual'` on the position.
- Their own unmodelled latency — your click, build, sign, land — is real but
  **unmeasured**, exactly like the copytrade landing slot. Say so on the card
  rather than implying a manual fill is more precise than a mirrored one.

---

## Correction 6 — manual trades contaminate the measurement unless they are segregated

This is the one that matters most for the project, and the engine already argues
it about demo trades. From `paper_copytrade.mjs`:

> Demo trades are counted so the dashboard can say the numbers include positions
> that were never mirrored from the target. Without this a demo silently
> contaminates the win rate the book exists to report.

`paperScorecard` already carries `demoPositions` and `demoClosed`, and the
scorecard prints a warning line when either is non-zero.

The paper book exists to answer **one** question: what would copying this whale
have returned. The live figure — about **−4% round-trip drag, entries near
parity, losses on exits** — is the measurement the whole project is trying to
move. Mixing discretionary clicks into the same book makes that number a blend
of two strategies and it stops meaning anything.

> [!tip] Tag manual orders the way demo orders are already tagged
> `source: 'manual'` on the position, `manualPositions` / `manualClosed` on the
> scorecard, and a header line when either is non-zero. Then add a
> **`--manual-book`** option writing to a separate `.state/` file, so the
> copytrade measurement can stay clean while manual ideas are still testable.
>
> Segregated, this is a genuinely useful feature. Merged, it destroys the one
> number the book is for.

---

## Correction 7 — an overlay on a real trading site must never look like a real order ticket

The dashboard lives at `127.0.0.1:3000`, where nothing else is. This overlay
sits **on top of GMGN**, inches from controls that spend real money, wearing a
dark trading-terminal skin.

- A **`PAPER`** badge in the overlay chrome that cannot be dismissed, hidden or
  styled away, next to the virtual balance.
- Buy and sell buttons visually distinct from GMGN's own — not the same shape
  and colour as the thing that actually spends SOL.
- The order summary states **`VIRTUAL SOL`**, never a bare number.

The whole value of a paper book is that it can be wrong for free. A UI that gets
someone to think they traded gives that away in the one direction that costs
money.

---

## Architecture

```
┌ gmgn.ai tab ───────────────────────────────────────────────┐
│  content.js                                                │
│    ├── shadow root  ──▶ overlay.js / overlay.css           │
│    ├── chart marker layer   (see Correction 4)             │
│    └── EventSource ──────────┐                             │
└──────────────────────────────┼─────────────────────────────┘
        chrome.runtime.sendMessage (writes only)
                               │                             ▼
┌ background.js (MV3 worker) ──┴──▶ POST /api/paper/buy ──▶ 127.0.0.1:3000
│   holds the token, owns every write, no long-lived socket │      │
└───────────────────────────────────────────────────────────┘      ▼
                                              paper_copytrade.mjs — the ONLY
                                              place money is calculated
```

### `aegis/extension/manifest.json`

MV3. `host_permissions` for `https://gmgn.ai/*`, `https://dexscreener.com/*`,
`http://127.0.0.1:3000/*`. Content scripts on the two venues only.

**No `activeTab`, no `tabs`, no `storage.sync`.** The token lives in
`storage.local` — `sync` would push it to every machine on the Google account,
which is not where a local control credential belongs.

### `content.js`

Injects a **closed** shadow root, so GMGN's CSS cannot reach the overlay and the
overlay cannot leak into GMGN. Owns the `EventSource` (Correction 3) and the
marker layer. Sends writes to the worker; makes no network call of its own.

### `overlay.js` / `overlay.css`

Obsidian `#0e1118`, matching the phase 7 palette (`--up #00e676`,
`--down #ff3d57`).

- Preset buys: **0.1 / 0.5 / 1 / 5 SOL**
- Sells: **10% / 25% / 50% / 100%**
- Summary card: BOUGHT · SOLD · REMAINING · PNL CHANGE $ · PNL %
- TP/SL accordions — writing `cfg` rungs, which the engine already owns
- Non-dismissable **`PAPER`** badge (Correction 7)

Every value is set with `textContent`. Token symbols are attacker-controlled and
now arrive from *two* untrusted sources — the book and the host page.

### `background.js`

Holds the token, performs every write, and enforces **idempotency**: each order
carries a client-generated `orderId`, and the server ignores a repeat. A
double-click on a laggy frame must not open two positions.

Also a **handshake**: `GET /api/version` on connect, refusing to drive a server
whose state shape it does not match. Silent field drift between an extension and
an engine is the failure that presents as wrong numbers rather than as an error.

---

## Server additions — `aegis/dashboard.mjs`

| Route | Method | Notes |
|---|---|---|
| `/api/version` | GET | handshake; always available |
| `/api/paper/buy` | POST | `--dashboard-control` only; token; `{ mint, sizeSol, orderId }` |
| `/api/paper/sell` | POST | `--dashboard-control` only; token; `{ mint, fraction, orderId }` |

Both call straight into the existing `openPaperPosition` / `applyPaperExit` —
**no new fill math**, and `feeSol: 0.0006` remains the single fee source, as
established in [[03 Live Web Dashboard Plan#Phase 6 — what shipped]]. A second
fee lever is what the phase 6 test forbids.

The book is held in memory by the tick process, so control endpoints mutate the
same object the tick does. Single writer, unchanged — see
[[03 Live Web Dashboard Plan#Architecture — one process, one writer]].

---

## Build order

| Phase | Ships | Depends on |
|---|---|---|
| **0** | **Spike: can anything be drawn on GMGN's chart?** | nothing — do this first |
| **1** | `--dashboard-control`, token, `/api/version`, buy/sell + tests | nothing |
| **2** | Manifest, content script, shadow overlay, read-only display | phase 1 |
| **3** | Order buttons + summary card, wired through the worker | phases 1–2 |
| **4** | Portfolio drawer, `[VIEW CHART ↗]` | phase 2 |
| **5** | Chart markers — **only if phase 0 said yes**; else Tier A SVG in the overlay | phase 0 |
| **6** | TP/SL accordions | phase 3 |

Phase 1 is worth building alone: manual paper orders are useful from `curl`
before any extension exists.

---

## Tests

Server side, in the existing suite:

1. **Read-only stays the default.** POST returns 405 without
   `--dashboard-control`. The current test is kept, not replaced.
2. **Control mode requires the token.** POST without `X-Aegis-Token` → 401; with
   it → 200.
3. **`--dashboard-control` + `0.0.0.0` refuses to start**, with a message naming
   both flags.
4. **No `Access-Control-Allow-*` header is ever emitted**, in either mode. This
   is the one that stops a future "quick fix" from opening the book to the web.
5. **Idempotency.** The same `orderId` twice opens one position.
6. **Manual orders are segregated.** A manual buy sets `source: 'manual'`, and
   `paperScorecard` counts it separately from mirrored trades.
7. **No band on a manual fill.** `executionBand` is null and
   `fillRegime: 'manual'`.
8. **Fee integrity holds.** Balance moves by `size + feeSol`, once — the phase 6
   assertion, extended to the manual path.

Extension side has no test harness in this repo and adding one means a dev
dependency, which the dependency rule does not obviously permit. Same position
as the dashboard's page JS: verified by driving it. Worth deciding rather than
drifting into.

---

## Open questions

- **Is GMGN's chart reachable at all?** Phase 0. Everything about markers hangs
  on it, and it is one afternoon in devtools.
- **`gmgn.ai/sol/token/<mint>` is unverified** — the repo only has the wallet
  path. Carried over from [[03 Live Web Dashboard Plan]].
- **Does GMGN's ToS permit DOM injection?** Worth reading before shipping
  something that modifies their page. Their Cloudflare posture suggests they
  care about automation.
- **Does a one-click paper buy change how you trade?** [[03 Live Web Dashboard Plan]]
  already flags that a glanceable live P&L is the interface that turns a
  measurement tool into a slot machine. A buy button on the venue page is a
  larger step in that direction, and the honest time to notice is now.
- **Does the manual book earn its own file?** `--manual-book` is proposed above.
  Cheap to add, awkward to retrofit once one book holds both kinds of trade.
- **MV3 keeps changing.** Offscreen documents and service-worker lifetimes have
  moved more than once. Pin the behaviour with a comment naming the Chrome
  version it was verified against, the way the repo pins RPC quirks.

---

## Related

- [[03 Live Web Dashboard Plan]] — the state shape, the single-writer rule, the
  render-don't-compute rule, and the iframe lesson this repeats
- [[02 Token Deployer Plan]] — same house style: verify, then correct the draft
- [[01 Live Copytrade Plan]] — the signing boundary the extension must not cross
- `aegis/dashboard.mjs` — `buildDashboardState`, `createDashboardServer`, `cspFor`
- `aegis/paper_copytrade.mjs` — `openPaperPosition`, `applyPaperExit`,
  `paperScorecard`, `buildExecutionBand`
