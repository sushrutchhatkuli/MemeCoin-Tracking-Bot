# Aegis-Crypto Scanner

Generates Obsidian intelligence notes from live on-chain data. No API keys, no
dependencies — Node 18+ built-in `fetch` only.

## Usage

`index.mjs` is the entry point. Run from this directory:

```bash
node index.mjs
```

| Command | Effect |
| --- | --- |
| `node index.mjs` | One scan pass: discover, audit, write notes, alert, exit |
| `node index.mjs --watch 12` | Stay resident, rescan every 12 minutes |
| `node index.mjs --all` | Write a note for every candidate, including low-score WATCH |
| `node index.mjs --limit 40` | Cap how many pairs get audited this run |
| `node index.mjs --chain solana` | Restrict to one chain |
| `node index.mjs --token <address>` | Deep-dive one specific contract, bypassing filters |
| `node index.mjs --test-telegram` | Send a sample alert to verify credentials |

## Scheduling

`schedule-task.ps1` registers the scanner as a Windows Scheduled Task so holder
velocity, the deployer index and smart-money history keep accumulating.

```powershell
.\schedule-task.ps1 -Minutes 12   # register
.\schedule-task.ps1 -Status       # state, last result, next run
.\schedule-task.ps1 -Remove       # unregister
```

Runs only while you are logged on (no stored password). Overlapping runs are
suppressed, so a slow scan will not stack up behind the next interval.

Use `--watch` instead if you would rather keep it in a terminal you control.

## Telegram alerts

Copy `.env.example` to `.env` and fill in both values (the file explains how to
get them from @BotFather). Then:

```bash
node index.mjs --test-telegram
```

An alert fires when a token is `BUY SIGNAL` **and** scores at or above
`telegram.minScore` (default 75). Each token is alerted at most once per
`telegram.cooldownHours` (default 6) — without that, a 12-minute scheduler would
re-alert the same token roughly 30 times a day.

Alerts include ticker, market cap, liquidity depth, 5m buys/sells, holder count,
security status, smart-money status, deployer reputation, the contract address,
and a one-tap FOMO App trade link.

Notes land in `../Memecoin/Crypto finder/Signals/`. Open `00 Aegis Dashboard.md`
in Obsidian for the Dataview roll-ups (requires the Dataview plugin).

## Data sources

| Source | Provides |
| --- | --- |
| DexScreener | Discovery, market cap, liquidity, buys/sells per window, price change, socials |
| RugCheck | Solana: mint/freeze authority, LP lock %, holder distribution, insider bundles, deployer address, new-launch feed |
| GoPlus Labs | EVM: buy/sell tax, honeypot simulation, source verification, hidden functions |
| Solana RPC | Deployer mint-creation history (`config.rpcUrl`) |

## The three security states

This is the part that matters most, so it is worth being precise about:

- **PASSED** — every check completed and passed. It means the contract lacks
  specific known rug mechanisms. It does **not** mean the token is safe.
- **FAILED** — a check affirmatively failed. Forces `SCAM/AVOID` and caps the
  score at 20 no matter how strong the price action is.
- **UNVERIFIED** — no check failed, but at least one could not be completed
  because the provider has not indexed the token yet (normal for tokens minutes
  old). Capped at 40 and never promoted to `BUY SIGNAL`, but **not** blacklisted.

Collapsing UNVERIFIED into FAILED was the original behaviour and it was wrong: it
marked brand-new tokens as scams purely for being new, which makes the blacklist
untrustworthy exactly where it needs to be trusted.

## 👨‍💻 Serial Dev Reputation (`dev_audit.mjs`)

> **The Pump.fun API specified for this module is dead.**
> `frontend-api.pump.fun/coins/user-created-coins/{wallet}` returns `530`; the v2
> and v3 hosts return `503`/`404`, and Solscan's public API is now key-gated. The
> two sources below are the working keyless replacement.


Reconstructs a Solana deployer's launch history from two independent sources:

1. **RPC transaction walk** — `getSignaturesForAddress` on the creator wallet,
   parsing each transaction for `initializeMint` / `initializeMint2`.
2. **Launch feed index** — every scan polls RugCheck's new-token feed and persists
   creator→mint pairs to `.state/deployers.json`. This compounds: the longer you
   run the scanner, the better the history gets.

Past mints are then looked up on DexScreener to see how each launch ended.

| Status | Rule |
| --- | --- |
| `SERIAL RUGGER 🔴` | 4+ mints inside a 10-minute burst, **or** 3+ deploys in 48h with ≥70% of matured launches dead |
| `GOOD DEV ✅` | 2+ past launches above $100k market cap, under 50% dead |
| `UNKNOWN / NEW` | Insufficient history to classify |

`SERIAL RUGGER` **overrides a passing contract audit**: it forces the audit status
to `FAILED`, the verdict to `SCAM/AVOID`, and the score to `0`.
This is the whole point of the module: a serial rugger's next token always has
revoked authorities and a burned LP, because it was minted seconds ago. The
contract looking clean is expected and proves nothing.

Verified live: deployer `TSLvdd1p…` was caught minting **10 tokens in 18 seconds**.
Its token `$MEME` passed every contract check with 2.2% top-10 concentration and
scored 63/100 `WATCH` before this module existed; it now scores 0/100 `SCAM/AVOID`
with the audit forced to `FAILED`.

### Known limits (read these)

- **Asymmetric reliability.** The RPC walk reads a wallet's *newest* transactions,
  but a token's creation event is *older*. So the module reliably catches wallets
  that are **actively** spam-deploying, and often reports `UNKNOWN` for an
  established dev whose successful launches sit outside the window. It is much
  better at condemning than at certifying. Treat `GOOD DEV ✅` as weak evidence
  and `SERIAL RUGGER 🔴` as strong evidence.
- **Rug test is an outcome test, not a speed test.** The spec defines a rugger by
  tokens that "dumped to $0 within 5 minutes". Historical 5-minute candles for
  abandoned tokens are not retrievable from any keyless source — DexScreener stops
  reporting them entirely. A past launch is instead counted dead if it now has no
  live pair or under $1k liquidity. Same wallets, different evidence; it cannot
  distinguish a fast rug from a slow bleed.
- **Solana only.** History reconstruction depends on RPC mint parsing. EVM chains
  report `UNKNOWN / NEW`.
- **Public RPC is the bottleneck.** Set `rpcUrl` in `config.json` to a Helius or
  QuickNode endpoint to raise `deployerMaxTxLookups` and deepen the window.

## 🐋 Smart Money Tracking (`smart_money.mjs`)

**Ships inactive on purpose.** No keyless public API curates proven high-win-rate
wallets — that dataset is what Nansen, Arkham, GMGN and Cielo sell. Seeding this
with invented addresses would manufacture fake signal, so the watchlist is empty
until you fill it.

Add wallets to `smart_wallets.json` — either shape works:

```json
["Wallet1...", "Wallet2..."]
```
```json
{ "wallets": [ { "address": "Wallet1...", "label": "alpha", "win_rate": "78%" } ] }
```

`address` must be the **wallet (owner)** address, not a token account. Detection
applies a flat **+15** score bonus — additive only, it can lift a score but never
rescue a failed audit or a serial rugger.

Matching runs against two sources:

1. **Current holders** — always on, free, from the security provider. No entry
   timing.
2. **Replayed pool trades** — `getSignaturesForAddress` on the pair address, then
   each transaction's fee-payer and signed token delta. A positive delta is a buy,
   and it carries a block time, so entry timing becomes provable. Only runs when a
   watchlist exists (it is the most RPC-expensive call in the pipeline).

Both verified live: seeded with two real holder wallets it detected both, reported
their 4.54% combined position and lifted the score 33 → 48.

### Known limit — read this before trusting a negative

**The public RPC throttles the replay after ~10 of 25 transactions.** On a token
doing 190 buys per 5 minutes, that is a ~5% sample. A "no smart money detected"
result under those conditions is *inconclusive, not evidence of absence* — notes
carry an explicit warning callout when coverage was truncated.

Set `SOLANA_RPC_URL` in `.env` to a Helius/QuickNode endpoint for full coverage.
Without one, treat holder matching as the reliable path and the replay as a bonus.

The **insider/bundle** line is independent of the watchlist — it comes from the
security provider and works right now, covering the same-block Jito bundle check.

## Scoring

| Component | Max | Notes |
| --- | ---: | --- |
| Net demand (5m + 1h) | 30 | Buy/sell ratio across both windows |
| Liquidity depth | 20 | Pool as % of market cap; 15% is the slippage floor |
| Holder distribution | 20 | Top-10 non-DEX concentration; **unknown scores 0, never full marks** |
| Momentum / turnover | 15 | 1h volume vs market cap, penalised on a collapsing candle |
| Traction | 15 | Holder count, growth velocity, verified socials |
| Smart money | +15 | +6 per matched watchlist wallet, capped |
| Bearish catalysts | −4 each | |

Hard overrides, in precedence order: `SERIAL RUGGER` → cap 10, `FAILED` audit →
cap 20, `UNVERIFIED` audit → cap 40.

Verdict thresholds live in `config.json`.

## Holder growth velocity

Requires two observations. The first scan of a token records a baseline in
`.state/snapshots.json`; every scan after that reports a real delta. Run the
scanner on a schedule (e.g. Task Scheduler every 15 min) for this to be useful.

## Known gaps

- **No news / social sentiment feed.** Section 2 of the original spec (CEX listing
  announcements, KOL traction on X, partnership news, regulatory actions) is
  **not implemented** — it needs paid API access (X API, a news aggregator). What
  the "Catalyst" section reports is derived strictly from on-chain flow, holder
  velocity, liquidity depth and whether social links are present on the listing.
  It does not read the news and does not know about listings.
- **No 15-minute transaction window.** DexScreener exposes 5m, 1h, 6h and 24h
  only. The 15m requirement is approximated by the 1h window.
- **Dev/team wallet dump detection is partial.** Insider bundles, top-holder
  concentration and deployer launch history are covered; tracking a specific dev
  wallet moving supply to a CEX still needs a dedicated indexer (Helius/Bitquery).
- **Smart money and deployer modules have their own documented limits** — see the
  "Known limits" subsections above. Both are real but neither is complete.

## Not financial advice

Every note is a mechanical classification of public data, not a recommendation.
Most low-cap tokens go to zero.
