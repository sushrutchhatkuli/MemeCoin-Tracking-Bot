---
title: Live Copytrade Bot — Execution Plan
status: design
target: Ar2Y6o1QmrRAskjii1cRfijeKugHH13ycxW5cd7rro1x
builds-on: aegis/paper_copytrade.mjs
created: 2026-08-13
---

# Live Copytrade Bot — Execution Plan

Turning `paper_copytrade.mjs` into `live_copytrade.mjs`. The four-phase shape is
right. This note fills in the detail, corrects two things in the draft, and
records what was verified rather than assumed.

> [!warning] Read this before Phase 4
> Every clean measurement so far shows the copy **losing**. Against the target's
> own on-chain P&L over 14 tokens both closed: **target won 7/14, the book won
> 0/14**; mean per-token **target +0.2%, book −18.1%**. Removing the bad
> `copyImpactPct: 9` fixed about half of it — the book still lost **−6.44 SOL**
> on the same 119 trades at zero impact.
>
> Paper is the **optimistic** case: it has no failed transactions, no priority
> fees, no ATA rent, no sandwiching. Phases 1–3 are worth building because they
> are how you *measure*. Phase 4 is a separate decision that the data does not
> currently support.

---

## Corrections to the draft

**1. The Jupiter URL is dead.** `https://quote-api.jup.ag/v6` fails to connect.
Verified working today:

| Endpoint | Result |
|---|---|
| `quote-api.jup.ag/v6` | ❌ fetch failed |
| `lite-api.jup.ag/swap/v1` | ✅ HTTP 200, 241 ms (free tier) |
| `api.jup.ag/swap/v1` | ✅ HTTP 200, 149 ms |

**2. "Reliable *and profitable*" is the wrong gate for Phase 2.** At 0.01 SOL a
handful of trades proves **mechanics** — ATAs create, Jito lands, sells exit.
It cannot prove edge; the sample is far too small and the fixed costs dominate
at that size. Profitability has to come from Phase 3 calibration fed back into a
long paper run. Keep the phases, split the claim.

**3. Three things the draft omits** and Phase 1 should include from the start:
safety gating, state reconciliation, and idempotency. Detailed below.

---

## What carries over unchanged (~40%)

Reuse directly from `paper_copytrade.mjs` — do not fork these:

- `createWhaleSocket` — detection, retry queue, reconnect
- `parseWalletSwap` — BUY/SELL from balance deltas
- `mirrorPositionSize` — `--pct-whale` sizing and balance capping
- `fetchLatestSignature` — cursor anchoring on start
- Signature dedupe, re-entry, scale-in, chronological ordering
- `impliedEntryPriceUsd` / `impliedExitPriceUsd` — now the **expected** fill, to
  be compared against the real one in Phase 3

The decision layer answers *"what did the target do, and how much would I do?"*
That question is already solved and tested.

---

## What is new — the execution layer

### Quote → build → sign → send → confirm

```
GET  {BASE}/quote?inputMint=&outputMint=&amount=&slippageBps=
POST {BASE}/swap   { quoteResponse, userPublicKey, wrapAndUnwrapSol,
                     dynamicComputeUnitLimit, prioritizationFeeLamports }
  -> { swapTransaction (base64 VersionedTransaction),
       lastValidBlockHeight, prioritizationFeeLamports, computeUnitLimit }
```

Verified live: a 0.01 SOL → USDC quote returned a 2-hop route
(`HumidiFi → Manifest`), and `/swap` returned a **749-byte versioned
transaction** with `lastValidBlockHeight`, `prioritizationFeeLamports=999999`,
`computeUnitLimit=1400000`.

Then: deserialize → `sign` → `sendRawTransaction` → poll until confirmed or
`lastValidBlockHeight` passes.

### Failure cases paper never has

- [ ] **Slippage exceeded** → reverts, fee still paid
- [ ] **Quote staleness** → pool moved between quote and land
- [ ] **Confirmation timeout** → *did it land?* Must check before retrying or
      you double-buy
- [ ] **Sell fails** → you are **stuck holding** what the target already exited.
      Retry with escalating `slippageBps`, and alert if it keeps failing
- [ ] **Blockhash expiry** → rebuild, do not resend

### Idempotency

Every intent gets a client-side ID written to disk **before** the send. On
restart, any intent without a recorded outcome is resolved by querying the chain
first. A crash mid-send must never re-buy.

### State reconciliation

In paper the book **is** the truth. Live, **the chain is the truth**.

A `reconcile()` pass reads actual token balances and corrects the book —
otherwise a failed sell or partial fill makes the P&L fiction within a day. Run
it on startup and every N ticks.

### Token accounts

Each new mint needs an ATA (~0.002 SOL rent), created before the first buy and
closed after exit to reclaim it. At 50 positions that is ~0.1 SOL in float plus
extra transactions.

---

## Safety gates — reuse what Aegis already has

This is the strongest reason to build inside this repo.

- [ ] `fetchSecurity` (`sources.mjs`) — mint authority, freeze authority, LP
      burn, top-10 concentration
- [ ] `dev_blacklist.json` — 19,000+ deployers tracked, serial ruggers flagged
- [ ] Honeypot / sellability check **before** committing real SOL

> [!important] Pure mirroring with real money means mirroring into rugs
> The target can afford an unsellable token — on their size and frequency it is
> noise. On yours it is a total loss of that position. **Gate every live buy on
> the audit**, even though the paper book does not.

### Hard limits

- `--max-trade-sol` — per position
- `--max-exposure-sol` — total at risk
- `--daily-loss-limit-sol` — halt for the day
- **Kill switch** — halt and optionally liquidate
- Dedicated hot wallet, funded only with what you would accept losing. Key never
  in the repo, never in `.env` beside anything shared.

---

## Phase 1 — Shadow Mode

**Risk: $0.00.** Build the entire path; `--dry-run` stops the final broadcast.

- [ ] `aegis/live_copytrade.mjs` importing the decision layer from
      `paper_copytrade.mjs`
- [ ] Jupiter quote + swap wiring against `lite-api.jup.ag/swap/v1`
- [ ] Versioned transaction construction, priority fee, optional Jito tip
- [ ] Intent log with client IDs
- [ ] Safety gates wired in
- [ ] `--dry-run` logs the exact base64 payload that *would* have been sent

**Exit criteria:** for every target trade, a fully-formed transaction is
produced, gated, logged, and **not sent**. Compare its quoted `outAmount`
against `impliedEntryPriceUsd` — divergence here is measurable before a cent
is spent.

## Phase 2 — Tiny Live

**Fund 0.1 SOL (~$7.60). Trade 0.01 SOL (~$0.76).**

Proves **mechanics only**:

- [ ] ATA creation succeeds and costs what was expected
- [ ] Transactions land; measure time-to-confirmation
- [ ] Jito tip actually improves landing (A/B it)
- [ ] **Sells exit** — the one that matters most
- [ ] Failed-transaction handling behaves under a real revert

**Exit criteria:** 20+ round trips with zero stuck positions and zero
double-executions. Not a P&L judgement.

## Phase 3 — Calibration

Compare real fills against paper predictions.

- [ ] Real entry vs `impliedEntryPriceUsd` → the true copy impact
- [ ] Real exit vs `impliedExitPriceUsd` → the true exit drag
- [ ] Actual fees, rent, and failure rate per round trip

**Then feed those numbers back into `slippagePct` / `copyImpactPct` and re-run
the paper book.** This is the step that finally answers whether the strategy has
an edge — the paper book becomes trustworthy only once it is calibrated against
real execution.

> [!note] Why this phase exists
> `copyImpactPct` was originally set to **9%** from a badly-measured proxy
> (target fill vs DexScreener *minutes* later — price drift, not copy cost).
> Re-measured at real latency the median was **−8.9%**, the opposite sign. A
> single unvalidated constant caused half a 100% wipeout. Phase 3 is how that
> class of error stops happening.

## Phase 4 — Scale

Only if a **calibrated** paper book shows an edge over a meaningful sample.

- [ ] `--max-trade-sol 1.0` and the full limit set
- [ ] Scale in steps, re-measuring at each

---

## Open questions

- **Latency ceiling.** Currently ~400–800 ms via WebSocket. Geyser/gRPC would
  cut it further but LaserStream returned `7 PERMISSION_DENIED: Unsupported
  plan type` on the current Helius plan — see [[Geyser notes]].
- **Which whale.** The target's edge measured **+0.2% mean per token**; they
  profit on size and frequency. A thinner-but-slower target may copy better than
  a fast one.
- **Exit policy.** `--pure-mirror` maximises fidelity but removes every stop.
  With real money a hybrid (mirror entries, own stops) may survive latency
  better — testable in paper first.

## Commands

```bash
# Phase 1
node aegis/live_copytrade.mjs --dry-run --pct-whale 15 --watch 5

# Phase 2
node aegis/live_copytrade.mjs --live --max-trade-sol 0.01 --pct-whale 15

# Paper reference, still the control
node aegis/paper_copytrade.mjs --reset --budget 1000
node aegis/paper_copytrade.mjs --watch 5 --pct-whale 15 --pure-mirror
```

Related: [[00 Aegis Dashboard]]
