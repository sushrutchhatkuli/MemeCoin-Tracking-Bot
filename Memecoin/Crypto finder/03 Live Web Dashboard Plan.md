---
title: Aegis Live Web Dashboard — Implementation Plan
status: all seven phases built
module: aegis/dashboard.mjs, aegis/public/index.html, aegis/public/chart.mjs
builds-on: aegis/paper_copytrade.mjs
created: 2026-08-19
updated: 2026-08-19
tags:
  - dashboard
  - paper-copytrade
---

# Aegis Live Web Dashboard — Implementation Plan

A local web view of the paper book at `http://127.0.0.1:3000` — position cards,
price history with our own entry and exit markers, a full-session activity log,
and clickable mints. Served by the **same process** that runs the book.

This note keeps the idea and rewrites the parts of the draft that were wrong.
It is written against the code as it stands today, and
`paper_copytrade.mjs` is 207,749 bytes of engine that already renders a
dashboard — just not in a browser.

> [!success] All five phases are built
> **Phase 1** — `buildDashboardState`, `buildUsdFraming`, the caps. Pure.
> **Phase 2** — `createDashboardServer`, `GET /` and `GET /api/state`,
> EADDRINUSE as an outcome, `aegis/public/index.html`.
> **Phase 3** — SSE on `/api/stream`, `publish()` wired into the tick, the
> price recorder, and the `--dashboard` flag.
> **Phase 4** — `aegis/public/chart.mjs`: the Tier A inline SVG chart, our own
> marks with entry / scale-in / TP / exit markers, and gaps left as gaps.
> **Phase 5** — Tier B DexScreener embed behind `--dashboard-embed`, off by
> default and gated again by a per-session click.
> **617 tests pass, up from 557.** Still zero dependencies.
> See [[#Phase 1 — what shipped]] … [[#Phase 5 — what shipped]].

> [!info] What changed from the first draft, and why it matters
> The draft's headline claims were that the web view is *"100% accurate,
> updating every millisecond"*, that it **removes** the `Pool impact … priced
> against the ASSUMED pool floor` line as *"confusing fallback text"*, and that
> `--no-liquidity-model` runs *"100% clean … without artificial penalties"*.
>
> Those three sit together, and together they point one way. The pool line is
> the engine telling you a fill was **priced against a pool nobody read**.
> `--no-liquidity-model` doesn't remove a penalty, it removes the **charge for
> crossing the spread at all** — which makes the book richer and less true.
> Delete the line, turn off the model, and the dashboard's number goes up
> without a single trade changing.
>
> A paper book has exactly one job: **be wrong for free**. Every edit that makes
> it look better makes it worse at that job. The version below keeps every
> disclosure and gives it a badge instead of a paragraph.

---

## What is genuinely better, and by what mechanism

Not "it looks nicer" — these are things the terminal structurally cannot do.

| Win | Why the terminal can't | Real? |
|---|---|---|
| **Price history at all** | The TTY renders one frame; there is no chart, only the current mark. A position that went +180% → −40% → +12% shows as `+12%`. | ✅ big |
| **Full-session activity log** | The terminal feed is hard-capped at **6 rows** (`while (recent.length > 6) recent.shift()`). A scrollable DOM keeps 500. *(Claimed from phase 3 but only true from phase 7 — the web view was handed the terminal's capped array; see [[#Phase 7 — what shipped]].)* | ✅ big |
| **Clickable mints** | A base58 string in a terminal is a copy-paste. `<a href="solscan.io/token/…">` is a click. | ✅ real |
| **Concurrent panels** | Scorecard + positions + activity + chart compete for 80×24. A grid does not. | ✅ real |
| **Second screen / phone** | The terminal is where you work. The dashboard wants to be somewhere you glance. | ✅ with caveats — see [[#Correction 5 — localhost is not on your phone]] |
| **No TTY dependency** | The redraw path needs `CLEAR_SCREEN` and a real terminal. In a pipe, a log file or a Windows Terminal split, it degrades. | ✅ minor |

> [!note] The 6-row cap is a feature, not a bug being fixed
> From `paper_copytrade.mjs:4302` — *"the dashboard is fixed-height by design —
> an unbounded activity log would push the numbers off the screen, which is the
> exact scrolling this mode exists to stop."* The web view wins because a DOM
> can scroll one panel without moving another. It is not repairing a mistake.

---

## What gets worse, stated up front

1. **A second consumer of the book.** `detectConcurrentWriter()` exists because
   two processes on `.state/paper_copytrade.json` produced **three separate
   false diagnoses**: a `--reset` that appeared not to work, a fresh book that
   appeared to replay history, and settings changes that appeared to have no
   effect. Every one looked like an engine bug. A standalone `node
   dashboard.mjs` walks straight back into that.
2. **A second implementation of PnL.** If the browser computes equity from
   positions, there are now two answers to "what am I up" and they will drift.
3. **Third parties learn your book.** Today the engine's only outbound call is a
   DexScreener price read. Embed their chart and your **browser** tells
   DexScreener, live, exactly which mints you hold and when you opened them.
4. **LAN exposure**, if you bind past loopback to reach a phone.
5. **More surface, same signal.** None of this makes a whale's buy arrive one
   millisecond sooner. Same socket, same feed, same latency floor.

---

## Correction 1 — "every millisecond with 100% accuracy" is not the shape of this system

Here is the real budget, from numbers already measured in this repo.

| Stage | Cost | Source |
|---|---|---|
| Whale's tx lands in a slot | **~400 ms** | Solana slot time; a follower cannot see it earlier |
| `logsSubscribe` notification (`processed`) → fetchable tx | **~570 ms** | `discovery_daemon.mjs`, running since 2026-08-10 |
| Read back at `confirmed` | **396–779 ms**, 2–3 attempts | why `lookupRetries` exists, not padding |
| Parse + mirror decision | ~0 | no queue, no deliberation |
| Mark price via `fetchPairsBatch` | **250 ms** pace, 30 mints/request | `sources.mjs:148` |
| SSE frame → browser on loopback | ~1 ms | the only "millisecond" in the chain |

**End to end: roughly 1–2 seconds** for a whale buy to become a card on screen.
That is *good* — it is the same order as GMGN — but it is 1,000× the claim, and
the last step, the only sub-millisecond one, is the step the draft named.

Accuracy is a separate claim and a weaker one. A paper fill is a **model**:

- priced at **DexScreener mid** ± a fixed slippage assumption
- pool depth from a pair snapshot, not the reserves at that exact slot
- **no MEV, no priority-fee auction, no failed-transaction cost**
- exits assumed to fill at the trigger price

The engine's own header says it: *"not a backtest, not a projection, and not
evidence that the same result is available live."* A dashboard that renders that
model at 60fps is a fast picture of a model. Speed is not fidelity, and putting
`100% ACCURATE` in a header on top of `poolFloorSol: 30` is how a tool starts
lying to the person who built it.

> [!tip] What to put in the header instead
> A **freshness stamp**: age of the newest whale event, socket connected/
> reconnecting, age of the last price mark. Three fields that go stale visibly.
> The old terminal was once observed 50 seconds behind while GMGN showed 3s —
> and the reason it was *caught* is that something on screen said `updated
> 20:11:40`. Keep that property. A dashboard that cannot look stale cannot be
> trusted when it looks fine.

---

## Correction 2 — keep the pool disclosure; badge it, don't delete it

The line the draft calls confusing:

```
Pool impact  -$223.62  (14 fills priced against ASSUMED pool floor)
```

It means: **14 of your fills were priced against a pool nobody read.**
`poolFloorSol: 30` is a constant, described in the config as *"Conservative, and
WRONG — see the section header."* Against the 117–260 SOL pools actually
measured for this population, the floor overcharges a 1 SOL buy by roughly
**2.5 percentage points**, every time.

That is a real bias and it is worth knowing about. The fix is not deletion — it
is a badge with the count on it:

```
⚠ 14 fills · ASSUMED POOL     (hover: no pool was read; charged 30 SOL floor)
✓ 31 fills · MEASURED POOL
```

`paperScorecard()` already separates these (`flooredFills`, `poolMeasured`), and
there is already a test named *"the scorecard totals what depth took and
separates measured from assumed."* The data is there. Render it.

> [!warning] `--no-liquidity-model` is the opposite of "clean"
> `cfg.liquidityModel === false` returns `{ reserveSol: null, measured: null,
> active: false }` — the book then trades against **infinite depth**. Every fill
> lands at mid, no matter the size, no matter the pool.
>
> Measured on tokens this book actually held: a **$3,000** buy costs
> **10.13% / 50.65% / 27.50%** price impact against pools of
> **$53,750 / $4,692 / $15,656**. Switching the model off doesn't remove an
> artificial penalty; it removes **half of what memecoin trading costs**.
>
> Default the dashboard docs to the model **ON**. If it is off, say so in the
> header in the same colour as a warning, because the equity number means
> something different.

---

## Correction 3 — the dashboard renders, it does not compute

**Rule: the browser never does arithmetic on money.**

The server sends the object `paperScorecard(book, cfg)` already returns —
`equitySol`, `balanceSol`, `openValueSol`, `realisedPnlSol`, `winRatePct`,
`wins`, `losses`, `flooredFills` — and the page formats it. No `reduce()` over
positions in JavaScript. No recomputing gain from entry and mark.

Two reasons, and the second is the real one:

1. One source of truth means the terminal and the browser cannot disagree.
2. **`winRatePct` is `null`, not `0`, before anything closes** — and the code
   says why: *"a 0% win rate and 'nothing has resolved yet' are different claims
   and only one of them is bad news."* A naive frontend writes `wins/total || 0`
   and prints `0.0%` on a fresh book, or worse, counts open winners and prints
   90%. That exact failure has its own comment in the engine at line 1201.

The page renders `n/a`. The card carries `3W / 1L` next to the percentage so the
denominator is never hidden.

---

## Correction 4 — the book is denominated in SOL, and the draft mixed units

`--starting-balance 4000` is **dollars**, converted once: `startSol = budgetUsd
/ solUsd` at reset. The book then holds **SOL**. The draft's phrase *"virtual
$4,000 paper SOL"* is two units in one noun.

Why it matters on a dashboard: with SOL at $86.50 a $4,000 book is ~46.2 SOL. If
SOL moves to $90 and **you make no trades at all**, a USD equity card reads
$4,161 — a 4% "gain" you did not earn.

The terminal already handles this and the web view must carry it verbatim:

```
Banked PnL     +0.354 SOL   (+$30.17 at spot)      ← what you traded
vs start USD   +$161.00     started $4,000 @ $86.50/SOL   ← includes SOL drift
```

`budgetUsdAtStart` and `solUsdAtStart` are both already persisted on the book
for exactly this. Both lines, always. Never the dollar figure alone.

---

## Correction 5 — `localhost` is not on your phone

`http://localhost:3000` on your phone resolves to **the phone**. Reaching the
dashboard from another device needs three things the draft skipped:

1. `server.listen(3000, '0.0.0.0')` — bind past loopback.
2. Your machine's LAN address: `http://192.168.x.x:3000`.
3. A **Windows Firewall inbound rule** for node on that port. This is the step
   that silently eats an afternoon.

Default to **`127.0.0.1`**, with `--dashboard-host 0.0.0.0` as an explicit
opt-in that prints the LAN URL and a one-line warning. Anything on that network
can read the page — it is a paper book with no keys, so the stake is low, but
"low" is a thing to decide rather than to inherit from a default.

---

## Correction 6 — you cannot draw your markers on someone else's iframe

The draft wants **one** widget that is both a real market chart and a canvas for
our entry and exit markers. Those are two different widgets.

A DexScreener embed is a cross-origin `<iframe>`. There is no API to inject a
line, a dot or a label into it, and no amount of CSS reaches inside it. So:

**Tier A — our chart, our markers (ships first).**
Every tick already produces a mark price per position. Keep a bounded ring
buffer of `{ t, priceUsd }` per mint and draw it as inline SVG.

- Entry, scale-in, each fired TP rung and the exit land **exactly** where the
  book recorded them, because it is the book's own data.
- Timeframe is **our tick cadence** (5s at `--watch 5`), labelled as such on the
  axis. Not "1-second candles" — we do not sample at 1s and should not imply it.
- Zero dependencies, zero third-party calls, works when DexScreener is down.
- Honest limitation: between two samples we know nothing. A wick we never saw is
  not drawn. Label the chart `our marks · 5s` so this reads as a property.

**Tier B — the real market chart (optional, second).**
A DexScreener iframe in a side panel for the true price action, with no markers
and a caption saying why. Off by default, because of the privacy note above.

The draft's mockup, with buy markers on an embedded DexScreener chart, cannot be
built as drawn. Tier A gets the markers; Tier B gets the wicks.

---

## Correction 7 — no Tailwind, no CDN

`package.json` is explicit: *"The scanner itself stays dependency-free and runs
on Node built-ins alone."* One production dependency exists (`telegram`, for
MTProto, lazily loaded) and it earns it — a custom binary protocol cannot be
spoken with `fetch`.

A CSS framework does not earn it. A CDN `<script>` is worse than a dependency:
it is a third party executing in a page that displays your positions, fetched
fresh on every load, and it breaks the dashboard when you are offline.

**~200 lines of hand-written CSS**, one `<style>` block, dark by default. Node
has `http`, `fs` and SSE support built in. Total new dependencies: **0**.

---

## Architecture — one process, one writer

```
┌─ node paper_copytrade.mjs --watch 5 --dashboard ──────────────────┐
│                                                                    │
│  createWhaleFeed (WebSocket, logsSubscribe)  ─┐                    │
│  fetchPairsBatch (DexScreener marks)         ─┤                    │
│                                               ▼                    │
│                                        runPaperTick()              │
│                                               │                    │
│                    ┌──────────────────────────┼──────────────┐    │
│                    ▼                          ▼              ▼    │
│         .state/paper_copytrade.json    renderScorecard   emit()   │
│              (the only writer)          (terminal)         │      │
│                                                            ▼      │
│                                          dashboard.mjs: HTTP + SSE │
└────────────────────────────────────────────────────────────────────┘
                                                            │
                                    http://127.0.0.1:3000 ──┘
```

**In-process, not a second program.** `--dashboard` starts an HTTP server inside
the running tick loop. The server holds a **reference to the same book object**
the engine already has in memory. It never opens the state file — not to write
it, not even to read it.

This kills three problems at once:

- No second writer, so `detectConcurrentWriter` never fires and the three
  historical false diagnoses cannot recur.
- No torn reads. `saveBook()` is `await writeFile(path, …)` with no
  temp-plus-rename, so a reader *can* catch a half-written file. In-process
  there is no read.
- No staleness. A file-reading viewer is always one write behind.

> [!danger] The tempting design that is wrong
> A standalone `node aegis/dashboard.mjs` that reads the JSON looks cleaner and
> decouples nicely. It is the exact shape that has already cost this repo three
> debugging sessions. If a detached viewer is ever wanted, it must open the file
> **read-only** and display the book's own `writerAt` timestamp so its lag is
> visible — but in-process is strictly better and no harder.

---

## Component: `aegis/dashboard.mjs`

Exports functions; `paper_copytrade.mjs` imports it **only** when `--dashboard`
is passed, so the engine's zero-dependency startup path is untouched.

### `createDashboardServer({ host, port, getState })`

- `node:http` server, no framework.
- **`EADDRINUSE` is handled, not thrown.** Port 3000 is the most contested port
  on a dev machine. Print `port 3000 in use — try --dashboard-port 3001` and
  keep the tick loop running. The book must never die because a UI could not
  bind.
- Routes:

| Route | Returns |
|---|---|
| `GET /` | the single HTML page, inlined CSS and JS |
| `GET /api/state` | `buildDashboardState()` as JSON — for a cold load and for tests |
| `GET /api/stream` | `text/event-stream`; one frame per tick |

### `buildDashboardState(book, cfg, { solUsd })` — pure

The whole contract of the UI, and the only function tests need to care about.

```js
{
  scorecard: paperScorecard(book, cfg),   // verbatim, not recomputed
  solUsd, solUsdAgeMs,
  mode: { pureMirror, liquidityModel, subWallets, pctWhale, autoCompound },
  freshness: { socket: 'connected', newestWhaleEventMs, lastMarkMs },
  positions: [{
    mint, symbol, entryPriceUsd, markPriceUsd, gainPct, valueSol, valueUsd,
    stakeSol, firedRungs, heldMs, originatingWhale,
    poolMeasured,          // false ⇒ the ASSUMED-POOL badge
    series: [{ t, priceUsd }],   // ring buffer, bounded
    marks: [{ t, priceUsd, kind: 'ENTRY'|'SCALE'|'TP'|'EXIT', label }],
  }],
  activity: [ … ],         // full session, bounded at ~500 for memory
  warnings: [ … ],         // liquidity model off, socket down, stale marks
}
```

Pure and synchronous, so it tests without a socket, a server or a network.

### SSE cadence — one frame per tick, not "sub-second"

The draft promises sub-second pushes. The engine produces new state **once per
tick**. Emitting more often re-sends identical bytes.

- One `emit()` at the end of `runPaperTick`.
- A 15s keepalive comment (`:ping\n\n`) so proxies and sleeping laptops don't
  silently drop the stream.
- Client reconnect with backoff; browsers retry EventSource automatically, but
  the **page must show that it dropped** rather than quietly freezing on the
  last good frame. A frozen dashboard showing plausible numbers is the worst
  failure mode this thing has.

### `aegis/public/index.html`

One file, inline `<style>` and `<script>`. Layout:

```
┌─ Ar2Y6o1Q  ·  ● socket 0.6s  ·  marks 2s  ·  pure mirror · liq model ON ─┐
│  Equity 46.63 SOL ($4,035)   Banked +0.354 SOL (+$30.17)                 │
│  vs start USD +$35.11  (started $4,000 @ $86.50/SOL)                     │
│  Win rate 75.0%  (3W / 1L, closed only)     ⚠ 14 fills · ASSUMED POOL    │
├────────────────────────────────┬─────────────────────────────────────────┤
│  [SVG · our marks · 5s]        │  $Thing   +13.1%   $62.52   ⚠ assumed   │
│   ▲entry  ●TP1  ▼exit          │  $Wilbur  +11.5%   $72.98   ✓ measured  │
├────────────────────────────────┴─────────────────────────────────────────┤
│  ACTIVITY  (full session, scrolls)                                       │
│  22:07:42  BUY  $Thing 0.582 SOL  impact 1.9% (assumed pool)   ↗solscan  │
└──────────────────────────────────────────────────────────────────────────┘
```

Click a position card → the SVG panel switches to that mint. Click the mint →
Solscan in a new tab.

### `paper_copytrade.mjs` — the diff is small

`--dashboard`, `--dashboard-port`, `--dashboard-host`; a dynamic `import()` of
`dashboard.mjs` behind the flag; one `emit(buildDashboardState(…))` at the end
of the tick; the per-mint price ring buffer. The terminal renderer is **not**
touched — both views run at once, from one state.

---

## Command line

```powershell
# Terminal + web view, one process, liquidity model ON. Built and working.
node aegis/paper_copytrade.mjs --starting-balance 4000 --pct-whale 100 `
  --pure-mirror --track-whales 1 --watch 5 --reset --catchup --dashboard

# Reachable from a phone on the same Wi-Fi. Needs a Windows Firewall rule.
node aegis/paper_copytrade.mjs --watch 5 --dashboard --dashboard-host 0.0.0.0

# Port 3000 taken.
node aegis/paper_copytrade.mjs --watch 5 --dashboard --dashboard-port 3100

# Tier B as well: adds a DexScreener panel. Nothing is requested from them
# until you click Load, once per browser session, per position.
node aegis/paper_copytrade.mjs --watch 5 --dashboard --dashboard-embed

# Slot-latency fills: price entries from real on-chain swaps at N+5 instead of
# at the whale's own fill. Costs 1 + up to 40 RPC calls per mirrored trade.
node aegis/paper_copytrade.mjs --watch 5 --dashboard --slot-fills
```

Note what is **not** in the first line: `--no-liquidity-model`. The draft's
command had it, and per [[#Correction 2 — keep the pool disclosure; badge it, don't delete it]] that is
the flag that inflates the number the dashboard exists to show.

`--dashboard` without `--watch` is a single tick and a server that immediately
has nothing to push. It refuses to start, with a message naming `--watch`.

### The flags

| Flag | Default | Does |
|---|---|---|
| `--dashboard` | off | starts the web view inside the tick process |
| `--dashboard-port <n>` | `3000` | `EADDRINUSE` prints the fix, the book keeps running |
| `--dashboard-host <addr>` | `127.0.0.1` | `0.0.0.0` puts it on the LAN — the banner then warns |
| `--dashboard-embed` | **off** | allows Tier B; still needs a click before anything loads |
| `--slot-fills` | **off** | prices fills from real on-chain swaps at N+5; costs RPC per trade |

### Reading the page

| Panel | Shows |
|---|---|
| Header pills | link age, socket, whale/mark ages, mode, SOL spot. Everything goes visibly stale when the stream drops — server-sent ages become `≥` lower bounds |
| Scorecard | equity, banked, unrealised, total, **win rate with its denominator** (`n/a` until something closes), paid-to-depth with the assumed-pool count |
| USD framing | `vs start USD` split into **from trading** and **from SOL price** — the second is the part you did not earn |
| Warnings | liquidity model off, assumed-pool fills, stale marks, demo trades, socket down |
| Price history | our marks, our markers, gaps left as gaps. `--watch` cadence, measured |
| Market chart | Tier B only. Real candles, no markers, because nothing can be drawn into a cross-origin frame |
| Open positions | click to chart; GMGN / Solscan / DEX links; measured vs assumed pool badge |
| Activity | full session, scrolling — unlike the terminal's 6 rows |

---

## Tests — `aegis/test/dashboard.test.mjs`

Current suite: **557 passing**. New tests must not depend on a free port, a
network or a browser.

1. **`buildDashboardState` is a passthrough for money.** Every field under
   `scorecard` is `deepStrictEqual` to `paperScorecard(book, cfg)`. This is the
   regression guard for [[#Correction 3 — the dashboard renders, it does not compute]] — it fails the
   moment someone "helpfully" recomputes equity in the serializer.
2. **`winRatePct` survives as `null`.** A fresh book serializes `null`, not `0`.
   Asserted on the JSON, after a `JSON.parse(JSON.stringify(…))` round trip,
   because that is where a `|| 0` would actually bite.
3. **The assumed-pool flag reaches the wire.** A book with `flooredFills > 0`
   produces a warning entry and `poolMeasured: false` on the right positions.
   The disclosure cannot be dropped by a refactor without a red test.
4. **Both USD framings are present.** `budgetUsdAtStart` and `solUsdAtStart`
   serialize whenever the book has them, so the "vs start USD" line can never
   quietly disappear and leave the bare equity figure alone.
5. **Server binds on port 0** (ephemeral, assigned by the OS), answers
   `/api/state` with valid JSON, and closes. Never asserts port 3000 — a test
   that fails because something else holds a port is a test that teaches people
   to ignore red.
6. **`EADDRINUSE` returns an error, does not throw.** Bind a socket, try to
   bind again, assert a structured `{ ok: false, code: 'EADDRINUSE' }`.
7. **SSE frame encoding.** `data: <json>\n\n`, and a payload containing a
   newline does not break framing. One `JSON.stringify` with an embedded `\n` in
   a token symbol is enough to corrupt a naive stream — memecoin tickers contain
   anything.
8. **No writes.** Stub `writeFile`; assert the dashboard path never calls it.
   This is the `detectConcurrentWriter` guarantee, asserted at the seam rather
   than promised in a comment.

---

## Build order

| Phase | Ships | Depends on |
|---|---|---|
| **1** ✅ | `buildDashboardState` + tests 1–4 | nothing — pure functions, no server |
| **2** ✅ | HTTP server, `/api/state`, static page, tests 5–6 | phase 1 |
| **3** ✅ | SSE + `emit()` in the tick, tests 7–8 | phase 2 |
| **4** ✅ | Tier A SVG chart with our own markers | phase 3 (needs the ring buffer) |
| **5** ✅ | Tier B DexScreener iframe, off by default | phase 4 |
| **6** ✅ | Slot-latency fills from real on-chain swaps | engine work — no dashboard dependency |
| **7** ✅ | GMGN-style skin: palette, token tabs, two chart panes | phase 5; phase 6 for the fill-slot ticker |

Phase 1 is worth building alone even if nothing else follows: it is the honest
serialization of the book, and `--scorecard --json` would fall out of it free.

---

## Phase 1 — what shipped

`aegis/dashboard.mjs`. One pure function and its helpers: no server, no socket,
no network, no clock of its own. **575 tests pass** (18 new).

| Export | Does |
|---|---|
| `buildDashboardState(book, cfg, opts)` | book → the object the browser renders |
| `buildUsdFraming(scorecard, solUsd)` | the exact equity ÷ SOL-drift split |
| `SERIES_POINT_LIMIT` = 300 | per-position sample cap |
| `ACTIVITY_LIMIT` = 500 | activity rows retained |
| `STALE_MARK_MS` = 60,000 | past this, a mark is called stale, not current |

Four properties are now enforced by tests rather than by intention:

1. **`scorecard` is `paperScorecard()` verbatim** — `deepStrictEqual`, not a
   subset. And the seam that could still drift is closed separately: summed
   `valueSol` across position rows must equal `scorecard.openValueSol`, which
   the engine computes with the identical reduce.
2. **`winRatePct` stays `null`** across a `JSON.parse(JSON.stringify())` round
   trip, with a companion test proving a *real* 0% still reports `0` — the two
   cases stay distinguishable.
3. **Three depth states, not two.** `poolMeasured` is `true` / `false` / `null`,
   and `assumedPool` is strict `=== false`, so "the model is off" can never
   light the floor badge. `null` means nobody looked; `false` means someone
   looked and found none.
4. **Both USD framings or neither.** `vsStartUsd === tradingPnlUsd +
   solDriftUsd` is asserted as an exact identity, where
   `solDriftUsd = budgetSol × (solUsd − solUsdAtStart)`. A book that never
   started in dollars gets `usdFraming: null` rather than an invented number.

> [!info] What the payload optimisation actually measures
> Ten open positions with 300 samples each, focused on one: **the frame stays
> under 50KB**, and the test asserts the counterfactual too — the same state
> with a series on every card is over 100KB. The optimisation cannot be quietly
> undone without a red test.
>
> The cap keeps the **newest** points (`slice(-300)`). The test names the bug it
> prevents: `slice(0, 300)` pins the chart to the moment the position opened and
> then never moves again, while still rendering as a working chart.

> [!note] One assertion was wrong, and the engine was right
> The first draft of the tests asserted a position marked 1.00 → 1.25 shows
> `gainPct === 25`. It shows **23.76%**, because `entryPriceUsd` is the *fill* —
> a 1 SOL trade into a 100 SOL pool paid ~0.99% impact. The row measures gain
> from what was actually paid, which is the whole point of the liquidity model.
> The assertion now checks that the gain is **below** the naive mid-to-mark
> figure, so an entry cost going missing between the book and the browser would
> fail rather than pass.

---

## Additional practical optimizations

Three refinements. Two of them do not survive contact with the code as written,
and both fixes are small.

### 1. Ring buffer bounding — the cap is right, the guarantee is not

**Cap the Tier A series at 300 points per position.** Accepted: bounded is
non-negotiable, and 300 is a sensible number.

The *memory* half of the claim is safe with room to spare — 300 points × 10
positions is a few hundred KB of small objects, which is nothing. **Memory was
never the constraint. Payload is**, and that is where the 50KB guarantee breaks:

```
{"t":1755630000000,"priceUsd":0.00004312}   ≈ 42 bytes per point
300 points                                   ≈ 12.3 KB per position series
```

| Open positions | Series payload | Under 50KB? |
|---|---|---|
| 1 | 12.3 KB | ✅ |
| 3 | 36.9 KB | ✅ (plus scorecard + activity — tight) |
| 4 | 49.2 KB | ⚠️ at the line |
| 10 | 123 KB | ❌ 2.5× over |

The engine holds as many positions as the target opens. Four is not a stress
case, it is a Tuesday. Capping points bounds one position; it does not bound the
frame.

> [!tip] The fix is free, because only one chart is ever on screen
> **Only the focused mint carries `series`.** Every other card needs
> `markPriceUsd`, `gainPct` and `valueUsd` — a few dozen bytes — because it
> renders a number, not a chart. One series, capped at 300, is **12.3 KB
> regardless of how many positions are open.**
>
> Then send **deltas**: the full series once, on connect and on mint switch;
> after that, one appended point per tick. Steady-state frame drops to ~50 bytes
> and the 50KB ceiling stops being something to defend.

One more thing the cap must not do: **300 points is not 25 minutes.** It is 25
minutes *at `--watch 5`* — 5 minutes at `--watch 1`, 2.5 hours at `--watch 30`.
Bound the buffer in **points**, label the axis in **time computed from the live
interval**. A chart captioned "25 min" while running at `--watch 1` is a lying
axis, which is the same failure as a lying equity number, just quieter.

### 2. One-click GMGN and Solscan links — accepted, with the repo's own conventions

Straightforwardly good, and it fixes the copy-paste the draft correctly
identified. Reuse what already exists rather than hand-rolling:

| Target | URL | Precedent in repo |
|---|---|---|
| Solscan token | `https://solscan.io/token/<mint>` | `note.mjs:369`, `telegram.mjs:982` |
| GMGN token | `https://gmgn.ai/sol/token/<mint>` | ⚠️ none — see below |
| DexScreener | `https://dexscreener.com/solana/<mint>` | worth adding: it is the venue we actually price against |

Three notes:

- **The GMGN token path has no precedent here.** The repo's established pattern
  is `https://gmgn.ai/sol/address/<addr>` for a **wallet**
  (`network_discovery.mjs:61`, `telegram.mjs:211`). `/sol/token/` is plausible
  and probably right, but it is unverified — load one before shipping it, and
  add a wallet link to `originatingWhale` using the path we *do* have.
- **gmgn.ai serves Cloudflare 403 to every programmatic request** — documented
  at length in `auto_top_whales.mjs:1377`. That is irrelevant here and worth
  writing down so nobody re-discovers it: this is a **link the user clicks in a
  real browser**, not a fetch. Never resolve, prefetch or validate these URLs
  server-side; they will 403 and that is not a broken link.
- **Escape the label, not just the URL.** The href takes a base58 mint and is
  safe; the visible text is `p.symbol`, which is attacker-controlled — a
  memecoin ticker can contain quotes, angle brackets and newlines. Same class of
  bug as SSE framing test 7. Set it via `textContent`, never `innerHTML`;
  `telegram.mjs:982` already wraps its address in `esc()` for the same reason.
  Add `rel="noopener noreferrer"` on every `target="_blank"`.

Privacy footnote: a click tells GMGN which mint you hold — but *you* chose to
click, which is categorically weaker than the Tier B iframe broadcasting your
whole position list on page load. Links are fine on by default; the iframe is
not.

### 3. Clickable startup link — correct idea, but the redraw erases it

The link is worth having. Printed once at startup, **it will not survive the
first tick.**

```js
export const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';   // paper_copytrade.mjs:3794
```

`\x1b[2J` clears the screen; **`\x1b[3J` clears the scrollback buffer.** And
`shouldWipeScreen({ intervalSec, isTTY })` is just `intervalSec && isTTY` — so
under `--watch 5` in any real terminal it fires **every tick**. A startup banner
is not scrolled away, it is deleted, about five seconds after it appears.

> [!warning] The fix: put the URL in the frame, not before it
> Render it in the persistent header that `renderScorecard` / `renderModeLine`
> already redraw every tick. It costs one line, it is always on screen, and it
> stays correct when `EADDRINUSE` pushes the server to a different port —
> whereas a startup banner would keep advertising 3000 forever.

For actual clickability, emit an **OSC 8 hyperlink**, which Windows Terminal
supports and which does not depend on URL auto-detection:

```js
const link = (url, text) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
```

Gate it behind the same `process.stdout.isTTY` check the wipe already uses —
legacy `conhost` (the old `powershell.exe` window, as opposed to Windows
Terminal) does not implement OSC 8, and the fallback must be the bare
`http://127.0.0.1:3000`, which Windows Terminal auto-links anyway and which is
selectable everywhere else. Ctrl+Click then opens it in the default browser.

When `--dashboard-host 0.0.0.0` is passed, print **both** the loopback URL and
the LAN URL, since the phone needs the second one and loopback will not help it.

---

## Phase 2 — what shipped

The server half of `aegis/dashboard.mjs`, plus `aegis/public/index.html`.
**586 tests pass** (29 in the dashboard suite). **Zero dependencies added** —
`node:http`, `node:fs/promises`, `node:os`, `node:url`, and one hand-written
`<style>` block.

| Export | Does |
|---|---|
| `createDashboardServer({ host, port, getState })` | binds; resolves an outcome, never rejects |
| `handleRequest(req, res, …)` | one request; never throws |
| `describeBinding(host, port)` | loopback always, LAN URLs only when actually exposed |
| `explainListenError(err, …)` | the failure, in words that name the fix |
| `terminalLink(url, text, { isTTY })` | OSC 8, degrading to a bare URL |
| `dashboardBanner(urls, { isTTY })` | the line the tick header prints every frame |

Routes: `GET /` (the page), `GET /api/state` (JSON, `?focus=<mint>`),
`GET /api/stream` → **501 with a message**, so phase 3's absence is stated
rather than 404'd.

Three properties the server has by construction:

- **Read-only.** No route mutates anything — no pause, no manual exit, no
  config change. That is what makes `--dashboard-host 0.0.0.0` a viewer rather
  than a remote control.
- **One file, no static directory walk.** The filename is a module constant and
  is never taken from the URL, so there is no path to traverse.
- **It cannot kill the book.** `getState` throwing returns a 500 and the server
  keeps standing; a late socket error is swallowed rather than raised as an
  unhandled `'error'` event. Both are tested.

The CSP does the no-dependency rule as a runtime property rather than a
convention: `default-src 'none'; connect-src 'self'` means the page cannot
reach a CDN, a font host or an analytics endpoint even if someone later pastes
a `<script src>` into it. Two tests assert the page contains no external
`<script src>` and no external stylesheet.

> [!success] Verified by running it, not only by assertion
> Booted against a synthetic book and driven in a real browser:
> - A planted `ghost<img src=x>` **symbol** rendered as literal text.
>   `document.querySelectorAll('#pos-body img').length === 0` — `textContent`
>   held, which is the hazard the plan flagged for attacker-controlled tickers.
> - Focus round-trip: 420 samples in, **300 delivered**, span **24m 55s**
>   (299 × 5s). Exactly one series on the wire, of five positions.
> - Payload on the live server: **22,166 bytes** focused, 5,858 unfocused,
>   against the 50,000 budget.
> - `EADDRINUSE`, 405 on POST/PUT/DELETE/PATCH, 404, and 501 on `/api/stream`
>   all behave as specified.

> [!danger] What running it caught, that the tests did not
> Killing the server mid-session showed `DISCONNECTED` — and, immediately
> beside it, **`socket connected · whale 2s ago`**, frozen at the last good
> frame while presenting as live. That is precisely the
> "frozen dashboard showing plausible numbers" failure this plan calls its
> worst, reproduced by the page meant to prevent it.
>
> Fixed, and the fix is arithmetic rather than a disclaimer: the elapsed time
> since the last good frame is **added** to every server-sent age and shown as
> a `≥` lower bound, so `whale 2s ago` becomes `whale ≥18s ago` and keeps
> climbing. Both quantities are known, so nothing is invented. States that
> cannot be recomputed (`socket`, SOL spot) are dashed and labelled
> `· last frame`, and the body dims to 0.55 — the numbers stay visible, because
> the last good frame is the most useful thing available while the link is
> down, but nothing on the page reads as current.

> [!warning] The page's JavaScript still has no unit tests
> Everything in `index.html` was verified by driving a real browser, not by
> assertion — in phase 3 too. A DOM test harness means a dev dependency
> (jsdom), which the repo's dependency rule does not obviously permit for this.
> The staleness arithmetic and the stream-drop path are exactly the logic that
> deserves one. **Still open after phase 3** — carried to the questions below.

The transport swap landed as designed: `accept()` / `fail()` / `render()` stayed
put, and only `refresh()` gained `connect()` beside it. Polling survives as the
**fallback**, which is not belt-and-braces — `EventSource` cannot be given a new
query string without being torn down, so a focus change reopens the stream, and
if the stream is unavailable for any reason the page still works.

---

## Phase 3 — what shipped

SSE, the tick wiring, and the price recorder. **596 tests pass** (39 in the
dashboard suite). Still **zero dependencies**.

| Export | Does |
|---|---|
| `encodeSseFrame(payload, { event, id, retry })` | one frame, spec-correct |
| `createSseHub({ keepaliveMs })` | the connected browsers |
| `createSeriesRecorder({ limit })` | bounded per-mint samples + chart markers |
| `startDashboard({ host, port, book, cfg, getContext })` | the one call the tick makes |
| `SSE_KEEPALIVE`, `KEEPALIVE_MS` (15s), `MAX_CLIENT_BUFFER_BYTES` | |

In `paper_copytrade.mjs`: `--dashboard`, `--dashboard-port`, `--dashboard-host`,
a dynamic `import()` behind the flag, freshness tracking, and one
`dash.publish(report)` at the very end of the tick — **after** `saveBook` and
after the spot refresh, so a frame never shows a book state the engine has not
finished writing or a price it is about to replace.

### The framing hazard, and why the encoder loops

A raw newline in a payload ends the `data:` line; a raw blank line ends the
**event**. So one token symbol containing `\n` corrupts not just its own frame
but the framing of every frame after it. `JSON.stringify` escapes newlines, so
in practice objects are safe — but framing must not depend on that being
remembered, and strings reach the encoder too. All three of `\r`, `\n` and
`\r\n` are SSE line terminators, so all three are split on and a multi-line
payload becomes multiple `data:` lines, which is the spec's own answer.

The test plants `{ symbol: 'ha\nha\n\ndata: {"equitySol":999999}' }` — a
payload that tries to inject a **second frame with a fake equity number** — and
asserts the frame contains exactly one terminator and one `data:` line. Same
class of bug as `innerHTML` on a symbol, and the same attacker controls both.

### Per-viewer focus

Focus is a per-viewer choice, so each client carries its own. A global focus
would yank the chart out from under a second tab. Frames are serialised **once
per distinct focus**, so three tabs on two mints cost two `JSON.stringify`
calls, and the common case — everyone unfocused — costs one no matter how many
tabs are open.

### Three ways a client can misbehave, all handled

- **Stops reading** (a suspended tab): dropped past 1 MB of queued bytes rather
  than buffered forever. EventSource reconnects and gets the *current* frame
  instead of replaying a queue of stale ones.
- **Disconnects**: the browser retries on its own at the `retry:` cadence the
  server sends. `onerror` only makes the drop visible — reconnecting by hand
  would race the browser's retry and open two streams.
- **A build throws**: an error frame goes out, the client stays connected, and
  the tick is untouched.

> [!success] Verified end to end, against a live stream
> Raw wire, read with a `ReadableStream` reader: `retry: 2000`, an immediate
> first frame, then **one frame per publish** (9 frames, series growing exactly
> one point per tick, 7.0 KB → 8.5 KB) and `:ping` keepalives on schedule.
>
> In the browser: `EventSource.readyState 1`, polling fallback **off**, frames
> landing every second. Clicking a card reopened the stream at
> `/api/stream?focus=<mint>` and still shipped **1 series of 3**.
>
> Killing the server mid-session: `readyState 0` (browser retrying), fallback
> polling engaged, `DISCONNECTED · frozen 11s · stream dropped, retrying`, and
> `whale ≥14s ago` climbing. Restarting it: **recovered with no page reload** —
> stream re-opened, fallback disengaged, focus preserved, stale markers cleared.

> [!info] `--dashboard` refuses to run without `--watch`
> A single tick would start a server, push one frame and exit; the page would
> load into a dead socket, which reads as broken rather than as finished.
> Verified: exits 1 with a message naming `--watch`.
>
> Running that check also produced a live demonstration of why this design is
> in-process — `detectConcurrentWriter` fired against the `--watch` instance
> already running on this machine, exactly as designed.

### Test 8 caught the module documenting itself

The single-writer test asserts `dashboard.mjs` never references `writeFile`,
`saveBook` and friends. It failed on first run — because the module's **prose**
names them, to explain what it does not do. A test that cannot tell an
explanation from a call site would either fail on documentation or force the
documentation to be deleted. It now strips comments first, and asserts the
stripper left real code behind so the loop cannot pass vacuously.

The behavioural half is stronger than the structural one: a stand-in book file
is written once, then served, streamed and published against — and asserted
**byte-identical, same mtime**, with the in-memory book unchanged and
`detectConcurrentWriter` still returning `null`.

---

## Phase 4 — what shipped

`aegis/public/chart.mjs` plus the SVG renderer in the page. **611 tests pass**
(53 in the dashboard suite). Still **zero dependencies**.

| Export | Does |
|---|---|
| `buildChartGeometry({ series, marks, width, height })` | the whole projection, pure |
| `describeChart(geo)` | the caption, built from what was measured |
| `samplingCadenceMs(diffs)` | the tick cadence, from the data |
| `MARK_KINDS` | `ENTRY`, `SCALE`, `TP`, `EXIT` — also the paint order |

### One implementation, not two

The projection has to run in Node (to be tested) and in the browser (to draw).
Rather than keep a copy in each, `chart.mjs` is dependency-free, `dashboard.mjs`
re-exports it, and the server serves the **same file** at `/chart.mjs` for the
page to `import`. What the tests assert is what draws.

Two things that cost:

- **CSP relaxes to `script-src 'self' 'unsafe-inline'`.** `'self'` is this
  server and nothing else; no directive reaches an external origin, which is
  the property that actually matters. A test asserts the page still has no
  `<script src>`, no external stylesheet, and no absolute URL beyond the
  explorer links and the SVG namespace.
- **A second served file.** Still an allowlist keyed by exact path, still
  module constants, still nothing taken from the URL — a test probes
  `/public/chart.mjs`, `/../dashboard.mjs`, `/.env` and friends and requires
  404 or 400 for each.

### What the chart claims, and what it refuses to

The markers are the whole point: entry, scale-ins, fired TP rungs and the exit
land **exactly** where the book recorded them, because it is the book's own
data. No DexScreener iframe can do that at any price.

What it gives up is stated on the page, under every chart:

> our marks · 240 marks · ~5s cadence · 1 gap — the line is broken where nothing
> was sampled · **not candles: no high/low, and nothing between two samples**

- **Gaps break the line.** A segment between two samples 5s apart is a fair
  reading of an unobserved interval. The same segment across a six-minute stall
  is a claim about six minutes nobody watched. Past `3 ×` the cadence the path
  breaks, the region is banded, and the tooltip says *"No samples for 6m 5s —
  nothing was observed here, so nothing is drawn."*
- **Markers outside the window are clamped and drawn hollow.** Positions are
  routinely older than the recorder, which starts when the dashboard does, so
  an `ENTRY` usually predates every sample. It pins to the left edge with a
  tooltip saying it *"happened before the sampled window — pinned to the edge,
  not to this time"*, and keeps its true timestamp.
- **The cadence is measured, never assumed.** A `--watch 1` chart cannot print
  "~5s".

> [!danger] The estimator was wrong, and a 3-point series caught it
> Gap detection first used the **median** interval as its baseline. With two
> gaps of 5s and 395s the median *is* their mean — 200s. The stall then
> inflates the very baseline meant to detect it: no gap is found, a straight
> line gets drawn through four unobserved minutes, and the caption reports a
> "~200s cadence" that never happened.
>
> The fix is the **minimum**, and it is principled rather than a fudge. The tick
> fires on a fixed interval, so the true cadence is a constant contaminated in
> one direction only — stalls make gaps longer and nothing makes them shorter.
> The distribution is right-skewed with a hard floor, and the floor is the thing
> being measured. The minimum is immune at every sample count; the median only
> works once there is enough data to drown the outlier.
>
> `samplingCadenceMs` is now tested directly against `[5_000, 395_000]` so the
> median cannot come back.

> [!success] Verified in a real browser, with a deliberate stall
> 240 samples at 5s with a six-minute hole at sample 160, an `ENTRY` an hour
> before the first sample, a scale-in and two TP rungs:
> - **2 line segments, 1 gap band** — the stroke stops and restarts.
> - `ENTRY` hollow at `x = 58` (the left edge), `clamped: true`.
> - Scale-in renders as a diamond, TP as circles — the kinds are
>   distinguishable without relying on colour.
> - Caption: `240 marks · ~5s cadence · 1 gap …`; facts row: span **25m 55s**,
>   low `$0.00003576`, high `$0.00007567`.
> - No console errors.

> [!info] A harness bug worth recording, because the real path is right
> The first demo broadcast with `hub.broadcast(() => buildDashboardState(…))` —
> dropping the `focusedMint` argument. Every push then reset focus to null and
> the chart cleared itself every 5 seconds. `startDashboard` passes `stateFor`,
> which takes the focus, and the per-viewer-focus test covers it; the bug lived
> only in the throwaway script. It is a good illustration of why that test
> exists.

---

## Phase 5 — what shipped

Tier B: DexScreener's own chart, in an iframe, behind `--dashboard-embed`.
**617 tests pass** (66 in the dashboard suite). Still **zero dependencies**.

| Export | Does |
|---|---|
| `cspFor({ embed })` | the policy — `frame-src` is the only thing embed changes |
| `dexScreenerEmbedUrl(mint, { theme, interval })` | the URL, from a mint |
| `EMBED_ORIGIN` | the single origin that may ever be framed |

### The open question is now answered

> [!success] `?embed=1` accepts a **token mint**, not only a pair address
> Loaded live: `dexscreener.com/solana/<BONK mint>?embed=1` resolves the mint to
> its deepest pair by itself and renders. This is the property the whole tier
> depended on — the book stores mints and has no pair address to offer — and it
> was the reason phase 5 was left unscoped until someone looked.
>
> Their timeframe control does offer **1s**, alongside 1m/5m/15m/1h/4h/D. Whether
> a *given* pair has 1s data is theirs to decide, so `interval` is only ever
> requested, never assumed.

### Off by default means three separate locks

1. **`--dashboard-embed` absent** → `mode.embed.enabled: false`, and every
   position's `embedUrl` is `null`. The page is given nothing to frame.
2. **CSP** → `frame-src 'none'`. Verified on a live default server: the header
   never even names dexscreener.com.
3. **A per-session click.** Even with the flag on, *nothing is requested* until
   the button is pressed — verified: `iframesBeforeConsent: 0`. The consent is
   never persisted; no `localStorage`, no cookie. One that survives a reload is
   one nobody remembers giving.

The consent copy says what the click actually does — that their server learns
your IP and which mint you are looking at, live, and can correlate it across a
session — and draws the distinction that matters: the engine's own price reads
are server-side and carry no browser session; this frame is not the same thing.

### The rebuild guard

`render()` runs once a second. Recreating the `<iframe>` each frame would
re-request dexscreener.com **once a second** — a load the page never intended
and they never agreed to serve. The desired state is reduced to a key
(`frame:<mint>` / `consent:<mint>` / `none`) and an unchanged key returns early.
Verified live: `iframeStillTheSameNode: true` after 12 seconds of streaming.

> [!danger] A conclusion I drew and had to withdraw
> Mid-verification I concluded that the iframe `sandbox` broke the embed:
> `allow-scripts` alone hung at "Loading chart settings…", `allow-scripts
> allow-same-origin` and `allow=""` both hung at "Loading pair…", and a plain
> iframe rendered live candles. I changed the code and the test to drop the
> sandbox on that basis.
>
> It was **confounded**. Reconstructing the order: the plain iframe succeeded on
> attempts 3 and 5 — then failed on attempts 6 and 7 with *the identical
> config*, on the same mint, minutes later. So "Loading pair…" is intermittent
> and happens with and without the sandbox. The obvious candidate is throttling
> after ~10 embed loads from one IP in a few minutes, but a cross-origin frame's
> internals are invisible to devtools and it cannot be pinned down from here.
>
> **What survives:** `allow-scripts` alone is genuinely wrong — it fails at a
> *different, earlier* stage with a mechanism that explains itself (an opaque
> origin has no storage for their settings). **What does not survive:** any
> claim about the sandbox beyond that.
>
> The code was reverted to `sandbox="allow-scripts allow-same-origin"`. Prefer
> the tighter setting when the evidence against it does not hold up. The pair is
> the classic warning only for a SAME-origin frame, which could then strip its
> own sandbox; cross-origin it returns DexScreener's origin to DexScreener and
> hands us nothing.

> [!warning] Embed reliability is genuinely unverified
> It rendered live candles twice and hung at "Loading pair…" several times, with
> no attribute change between the two outcomes. Treat Tier B as best-effort. The
> Tier A chart is unaffected — it needs no third party and cannot be throttled.

---

---

## Phase 6 — what shipped

Built in `paper_copytrade.mjs` (decode + band + fetch) and `dashboard.mjs`
(payload). **640 tests pass**, up from 617 — 23 new in
`aegis/test/slot_fills.test.mjs`. Still zero dependencies.

| Export | Does |
|---|---|
| `decodeSwapAtSlot(tx, { mint, solUsd })` | one transaction → the price that swap executed at |
| `reconstructPriceAtSlot(swaps, slot)` | last trade at or before a slot, with its staleness |
| `buildExecutionBand({ swaps, whaleSlot, side })` | the three rungs, the fill, and the spread |
| `fetchSlotWindowSwaps({ mint, whaleSlot, … })` | the window, from chain |
| `resolveExecutionBand({ … })` | window → band in one call; the seam the tick uses |
| `summariseBand(band)` *(dashboard)* | the card-facing subset, `null` when unreconstructed |
| `SLOT_MS`, `DEFAULT_SLOT_OFFSETS` | 400 ms; `{ earliest: 3, expected: 5, latest: 10 }` |

Run it with `--slot-fills`. **Off by default**, and the reason is cost, not
doubt: the existing implied-price path makes *zero* extra RPC calls because the
swap carries its own price. This one spends one `getSignaturesForAddress` plus
up to 40 `getTransaction` calls **per mirrored trade**. A test asserts the
window is never read when the flag is off, so a default run cannot start
quietly costing credits.

### The decoder is `parseWalletSwap`, pointed at the fee payer

No second decoder was written. Every swap in the window is decoded by treating
the **fee payer** as the swapper, which is true of essentially every retail and
bot swap — and it inherits `parseWalletSwap`'s refusal to read a transaction
whose balances moved for more than one mint. That is how routing and arbitrage
transactions decline themselves instead of producing a fabricated price.
`parseWalletSwap` gained one additive field, `slot`, because a window has to be
counted from something.

> [!danger] "Earliest" is not "best", and a falling token proves it
> The spec called N+3 the **best case**. It is the earliest *reachable* slot,
> which is only the best *price* if the token rose across the window. On a token
> that dumped, the earliest fill is the **worst** one.
>
> So the rungs are named for what they are — `earliest` / `expected` /
> `latest` — and `bestCaseUsd` / `worstCaseUsd` are derived separately and
> **direction-aware**: a buy wants the low price whenever it occurred, a sell
> wants the high. There is a test built on a falling token that fails if the two
> ideas are ever conflated again.

### Most slots contain no trade, and the carry-forward says so

"The price at slot N+5" is almost never an observation — for any one memecoin,
most slots hold no swap at all. So every rung reports `exact` (did a swap
actually land in that slot) and `staleSlots` (how far the last price was carried
forward). A price carried 40 slots is a much weaker claim than one carried 1,
and only the caller can judge that. When nothing traded at or before the slot,
the band returns `reconstructed: false` and the tick **falls back to the old
implied price** rather than inventing a fill — tested, along with the reason
being kept rather than swallowed.

A separate flag, `windowComplete: false`, marks a band priced before the chain
had produced the far end of the window. Its late rung is a carry-forward, so
**the spread shown is understated** — surfaced as its own dashboard warning
rather than folded into the band silently.

### Fee integrity

`feeSol: 0.0006` is untouched and remains the only per-trade charge. The draft
proposed adding a 0.001 SOL tip **plus** 0.000005 SOL gas on top, which would
have double-charged every round trip. A test walks `PAPER_DEFAULTS` and fails on
any key matching `/jito|tip|gasSol/`, so the second lever cannot reappear by
accident, and the balance arithmetic is asserted as `size + feeSol`, once.

### What it measurably changed

The end-to-end tick test is the whole point in one assertion: a whale buys 1000
tokens for 1 SOL (their fill: **$0.10**), the token runs to **$0.20** by N+5,
and the book now enters at **$0.20**. Previously it entered at the whale's
$0.10 — a moment it could not have traded in.

> [!warning] Two things this still does not model, unchanged from the spec
> - **Our own impact.** The reconstructed price is the price of a world in which
>   we did not trade. Had our order been in that slot it would have moved the
>   pool further and displaced someone who really filled.
> - **Fill probability.** The book still fills **100% of attempts**. Real ones
>   die on slippage bounds, expired blockhashes and lost tip auctions.
>
> Both are printed by `--slot-fills` on startup, next to which parts are
> measured and which are assumed, so the operator reads them before the numbers
> rather than after.

---

## Phase 6 (spec) — realistic slot-latency fills

Replaces the DexScreener mid-price fill with one reconstructed from **actual
on-chain swaps**, at a slot offset the follower could actually reach.

> [!danger] The draft said Slot N+1. That is physically unachievable, by this repo's own measurements.
> | Stage | Measured | Where |
> |---|---|---|
> | Solana slot | ~400 ms | — |
> | `logsSubscribe` (`processed`) → fetchable tx | **~570 ms** | `discovery_daemon.mjs`, live since 2026-08-10 |
> | Read back at `confirmed` | **396–779 ms**, 2–3 attempts | why `lookupRetries` exists |
> | **Observation total** | **~1.0–1.4 s** | before Node has even parsed the trade |
>
> Slot N+1 is ~400 ms after the whale. We are still *reading* at that point, and
> have not begun to build, sign, send or land anything. Pricing a fill there is
> not slightly optimistic — it is optimistic by exactly the amount that matters
> on a token that runs 2x in its first minute, which is the case the whole
> strategy exists for.

### The execution band, and which half of it is measured

| Rung | Offset | Status |
|---|---|---|
| **Best** | Slot **N+3** (~1.2 s) | floor derived from the measured observation lag — defensible |
| **Expected** | Slot **N+5** (~2.0 s) | **assumed** |
| **Worst** | Slot **N+10** (~4.0 s) | **assumed** |

Only the floor is arithmetic. The shape of the distribution and its upper bound
are guesses, because **nobody has measured where our transactions land — we have
never sent one.** Write the band down as a stated assumption, not a result, and
label it that way in the UI.

> [!tip] Which number the book actually trades on
> A band is not a fill; the book still has to pick one. Run the book at
> **N+5**, and report **N+3 → N+10** as an uncertainty spread on the P&L rather
> than as three separate books. One number to act on, with its error bars
> visible, is the honest shape — and it means the scorecard keeps a single
> equity figure instead of three that invite cherry-picking.

### On-chain swap reconstruction

This is the genuinely good idea in the draft and it stands on its own, separate
from any slot argument. The engine's own comment on the current approach:

> DexScreener is a lagging cross-pool aggregate, so on a thin memecoin the price
> it reports at an arbitrary tick moment can sit tens of percent from where the
> token actually traded a moment earlier. Sampling it made every exit a coin
> flip while entries were exact.

Measured spread of DexScreener-at-tick vs the target's own implied fill:
**+1.1%, −3.6%, −26.6%, +60.3%** — no systematic bias, enormous variance.
Replaying real Raydium / Pump.fun swap events and walking the pool forward is
strictly better than sampling that aggregate, at both entry and exit.

### Fees — replace, do not stack

> [!warning] `feeSol: 0.0006` already exists and is already charged per trade
> Adding a 0.001 SOL tip + 0.000005 SOL gas **on top** double-charges every
> round trip. Pick one representation: either widen `feeSol`, or zero it and
> itemise tip + gas separately. Do not add the second while the first is live.

A **fixed** 0.001 SOL tip is also an assumption, not a model of the auction:
Jito tips are competitive and clear highest first, and they spike precisely when
a trade is worth making. Assuming a fixed tip *and* assuming the trade lands is
assuming we won an auction that was never modelled.

### What Phase 6 still will not model

| Gap | Why it matters |
|---|---|
| **Fill probability** | The book fills **100% of attempts** — there is no failed-tx or fill-probability logic anywhere in `paper_copytrade.mjs`. Real attempts die on slippage bounds, expired blockhashes and lost tip auctions. No amount of price precision fixes a 100% fill rate; this is the largest single source of optimism in the model. |
| **Tip-auction outcome** | See above. Winning is assumed. |
| **Our own impact and displacement** | The reconstructed price is the price of a world in which we did not trade. Had we been in that slot we would have moved the pool further and displaced someone who really filled. Against a **$4,692** pool a $1,500 buy is **34.42%** impact — we are not a rounding error in these pools. |

**Fill probability is not in the spec above and is the highest-value addition to
it.** Recorded here so it is a decision rather than an oversight.

> [!caution] The boundary, stated once and plainly
> A simulator of this kind can show a strategy is hopeless. It cannot show one
> is profitable, because the deciding quantities — did we land, at what tip,
> against whom — only come into existence when a real transaction competes for a
> slot. Current book: **~4% round-trip drag, entries near parity, losses on
> exits.** Phase 6 improves the entry model; it does not touch the thing that is
> actually losing.

---

## Phase 7 — what shipped

Presentation only, in `aegis/public/index.html`, plus one engine fix it
uncovered. **641 tests pass**, up from 640. Still zero dependencies.

| Piece | Detail |
|---|---|
| Palette | `--bg #090c10`, `--panel #121824`, `--up #00e676`, `--down #ff3d57` — a token swap, verified in `getComputedStyle` |
| Metric strip | SOL spot · target · equity · net P&L · win rate · **fill-slot badge** |
| Token tabs | one per position with its gain, click to switch chart focus |
| Dual panes | Tier A and Tier B share the top row **only when Tier B is on** |
| Trade stream | SOL spend, modelled fill slot, drag %, impact, 1-click Solscan **tx** links |

### The fill-slot badge shows the model, not a number that looks like one

The spec asked for a fixed `N+4`. The badge reads `N+5 (N+3…N+10)` from
`mode.slotFills.offsets`, and when `--slot-fills` is off it reads **`off`** in
grey with a tooltip saying entries are priced at the target's own fill. Each
ticker row shows the offset modelled for *that trade*, absent when there was
none. A constant on screen is decoration; decoration that looks like a
measurement is the thing this note keeps refusing.

The stream also carries **drag %** — our fill against the price the target
actually got on the trade that caused ours. That is the cost of arriving late,
per trade, and it is `null` rather than `0` when either side is unknown, because
0 reads as "we matched them".

> [!danger] The web activity log had been capped at 6 rows this whole time
> `getContext()` passed `activity: recent` — and `recent` is the array the
> **terminal** caps at 6, because the terminal is fixed-height. Same array, one
> reference. So the web log was silently capped at 6 as well, while
> [[#What is genuinely better, and by what mechanism]] claimed a full-session
> scrolling log as one of the few things the terminal structurally cannot do.
> The claim was false in the shipped code from phase 3 onward, and no test
> caught it because both ends were internally consistent.
>
> Fixed with a separate `webActivity` array bounded at `WEB_ACTIVITY_LIMIT`
> (500, matching `dashboard.mjs`'s `ACTIVITY_LIMIT`). Its rows are also
> **structured** rather than pre-formatted — the ticker needs SOL, fill slot,
> drag and signature as separate fields, and a rendered string cannot be taken
> apart again.

> [!warning] The token tabs reintroduced a bug the position cards had already solved
> The first tab handler did `S.focus = …; refresh()`. Focus lives in the
> **stream's** query string, so a bare refresh updates one frame and is then
> overwritten by the next SSE push — the tab lit up and went dark a few seconds
> later. `setFocus()` already existed for exactly this and the cards already
> used it; the new control was written against the older pattern.
>
> There is now a test asserting **no** `S.focus = …; refresh()` pair exists in
> the page and that both focus controls route through `setFocus`. That is the
> only kind of test that would have caught it, since the bug is a missing call
> rather than a wrong value.

### Verified in the browser

- Palette resolves: body `rgb(9, 12, 16)`, gains `rgb(0, 230, 118)`.
- Tier B **on**: chart `x 14 w 662`, embed `x 688 w 662`, **same `y`**, positions
  full width (1337) beneath. A stale `margin-top: 12px` from when the embed was
  a standalone section was dropping it 12px below its neighbour; removed.
- Tier B **off**: no empty half-row — chart and positions share the row as
  before, and the embed panel is not built at all.
- Focus survives an SSE frame: active tab still lit after 8 seconds.
- No horizontal page scroll at 1380px.

---

## Phase 7 (spec) — GMGN-style skin

A re-skin and re-layout of the existing dashboard. No new data — every value
below already exists in `buildDashboardState`.

### Palette

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#090c10` | page ground |
| `--up` | `#00e676` | profit badges, gain text |
| `--down` | `#ff3d57` | loss badges, loss text |

Replaces the current `#0b0e13` / `#35d07f` / `#ff5d5d`. These are CSS custom
properties already, so this is a token swap, not a rewrite.

### Layout

```
┌ AEGIS  ● live  SOL $91.25  fill N+5 (±N+3…N+10)  Equity 47.3 SOL ────────┐
├ [$Sakadung +16.9%] [$Rowdy +0.1%] [GDAdCvji −3.2%] ──────────────────────┤
│  OUR MARKS (entry/scale/TP/exit)     │  OPEN POSITIONS (3)               │
│  [Tier A SVG — markers live here]    │  $Sakadung            +16.9%      │
│                                      │  entry $0.041  mark $0.048        │
│  MARKET CANDLES (DexScreener)        │  stake 1.35 SOL  ✓ measured pool  │
│  [1s|1m|5m|15m] — no markers, ever   │  [GMGN] [Solscan] [DEX]           │
├──────────────────────────────────────┴───────────────────────────────────┤
│  [03:04:02] BUY GDAdCvji 0.522 SOL  filled N+5 (2.0s)  drag 1.71%  [tx]  │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Token tab bar** — one tab per open position, gain in the label, click to
  switch chart focus. Drives the same `focusedMint` the cards already set, so
  the single-series payload rule is unchanged.
- **Two chart panes, and they are not interchangeable.** Established in
  [[#Correction 6 — you cannot draw your markers on someone else's iframe]] and
  confirmed in phases 4–5: the DexScreener frame is cross-origin and **nothing
  can be drawn into it**. Real candles with real wicks live there; our entry,
  scale-ins, TP rungs and exit live in the Tier A pane. Neither replaces the
  other, and the layout should not imply it does.
- **Quick-links** — GMGN / Solscan / DexScreener per card. Already shipped.
- **Trade stream** — SOL spent, the **modelled fill slot for that specific
  trade** (`N+5 (2.0s)`), drag %, Solscan link.

> [!warning] Three things the draft assumed that verification does not support
> 1. **The embed is DexScreener's, not GMGN's.** DexScreener framing is verified
>    working (`?embed=1` resolves a token mint and renders). **GMGN embedding is
>    unverified**, and `auto_top_whales.mjs` documents gmgn.ai serving Cloudflare
>    **403s** to programmatic requests. GMGN stays a link until someone frames it
>    and looks.
> 2. **Tier B is intermittent.** The same embed URL rendered live candles twice
>    and hung at "Loading pair…" several times with no config change. Do not
>    build a layout whose primary pane is assumed to be reliably populated.
> 3. **`280ms` is not a latency this system has.** The draft's ticker shows a
>    fixed 280 ms. Show the modelled offset for that trade instead — a constant
>    on screen is decoration, and decoration that looks like a measurement is the
>    thing this note keeps refusing.

Tier B stays behind `--dashboard-embed` and the per-session click. A prettier
skin is not a reason to start telling DexScreener which mints the book holds.

## Open questions

### Phase 6

- **Where our transactions would actually land is unmeasured.** N+3 is arithmetic
  from the measured observation lag; **N+5 and N+10 are guesses**. The only way
  to replace them with data is to observe real transactions competing for slots,
  which by definition a paper book cannot do. Until then the band is a stated
  assumption and must be labelled as one wherever it appears.
- **Fill probability is still unmodelled, now deliberately.** The book fills
  100% of attempts. Phase 6 shipped without changing that and says so on
  startup. It remains the largest single source of optimism in the model.
- ~~Does `feeSol` get widened or replaced?~~ — **neither: untouched.**
  `feeSol: 0.0006` stays the only per-trade charge, with a test that fails on
  any new `/jito|tip|gasSol/` key.
- ~~Do we have a swap decoder for both venues?~~ — **the question dissolved.**
  Decoding by *balance delta from the fee payer's perspective* is
  venue-agnostic: it never looks at which program ran, so Raydium, Pump.fun and
  anything else settle identically. `parseWalletSwap` was reused unchanged. The
  real limit is different and now explicit — a transaction whose balances moved
  for more than one mint declines itself, so routed and arbitrage swaps are
  skipped rather than mispriced.
- **How often does the window actually answer?** Unmeasured on live traffic. If
  most mirrored trades fall back to the implied price, `--slot-fills` costs RPC
  for little gain. `report.slotFills` counts `reconstructed` vs `failed` per
  tick — read it over a real session before leaving the flag on.

### Phase 7

- **GMGN embedding is unverified**, and `auto_top_whales.mjs` documents gmgn.ai
  returning Cloudflare 403s to programmatic requests. Until someone frames it,
  the market pane is DexScreener's chart and GMGN is a link.
- **The GMGN token URL path is unverified** — the repo only has the wallet path
  (`/sol/address/`). One browser load settles it.

### Dashboard

- ~~DexScreener embed parameters are unverified~~ — **answered by loading it**:
  `?embed=1` takes a token mint and resolves the pair itself, and a `1s`
  timeframe control exists. Still open: whether 1s data exists for a *fresh
  pump.fun* pair specifically, and what their embed terms permit.
- **Tier B reliability is unverified, and it matters more than it looked.** The
  same embed URL rendered live candles twice and hung at "Loading pair…"
  several times with no config change between them. Throttling is the obvious
  candidate but is not provable from outside a cross-origin frame. Tier A is
  unaffected — it needs no third party.
- **The chart is linear, not log.** Fine for the moves seen so far; a position
  that runs 20x will squash everything before it into the bottom pixel. Worth
  revisiting with a real 20x in the book rather than pre-emptively.
- ~~300 SVG points on a phone~~ — the path is **under 6,000 characters** at 300
  points, asserted, with coordinates rounded to a tenth of a pixel. Still not
  measured on actual phone hardware.
- ~~Ring buffer sizing is unmeasured~~ — **addressed**: 300 points, series only
  for the focused mint. Measured on a live stream at 3 positions: **7.0 KB
  growing to 8.5 KB** over 9 frames. What remains unmeasured is whether 300 SVG
  points render smoothly on a phone; desktop is not in question.
- **Frames are whole, not deltas.** The plan proposed sending the series once
  and appending a point per tick. Phase 3 re-sends the whole frame, because at
  the measured sizes it is not worth the state-sync bug surface — a client and
  server disagreeing about which points it already has is a worse failure than
  8 KB a second on loopback. Revisit only if a real session shows it mattering.
- **The page's JS is still untested by assertion.** Carried from phase 2 and
  now larger: the staleness arithmetic, the stream-drop path and the polling
  fallback are all verified only by driving a browser. Settling this means
  deciding whether a dev-only dependency is permissible, which is a question
  about the repo's rule rather than about this feature.
- **Nothing here improves the edge.** Clean-cohort round-trip drag is about
  **−4%**, entries near parity, losses on exits. A dashboard makes that visible
  faster; it does not move it. Same conclusion as
  [[02 Token Deployer Plan]] reached about the deployer.
- **Does a faster loop change behaviour?** A glanceable, phone-reachable, live
  P&L display is exactly the interface that turns a measurement tool into a
  slot machine. The book is fixed-height and deliberately boring right now.
  Worth noticing before the pretty version exists, not after.

---

## Related

- [[00 Aegis Dashboard]] — the Obsidian/Dataview view of `Signals/`
- [[01 Live Copytrade Plan]] — the phase gates and the signing boundary
- [[02 Token Deployer Plan]] — same house style: verify, then correct the draft
- [[04 Aegis Chrome Extension Plan]] — the overlay build on top of this server
- `aegis/paper_copytrade.mjs` — `paperScorecard`, `renderPositions`,
  `detectConcurrentWriter`, `createWhaleFeed`
- `aegis/sources.mjs` — `fetchPairsBatch`, the mark-price feed


