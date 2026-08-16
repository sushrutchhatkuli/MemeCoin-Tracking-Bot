---
title: Transparent Pump.fun Token Deployer — Implementation Plan
status: phase 1 built
module: aegis/auto_deployer.mjs
builds-on: aegis/live_execute.mjs
created: 2026-08-16
updated: 2026-08-16
---

# Transparent Pump.fun Token Deployer — Implementation Plan

A standalone launcher: viral-narrative naming, metadata upload, mint creation,
one **disclosed** creator allocation, atomic Jito deployment, and a `--paper`
mode that costs nothing.

This note records what was **verified against the live chain and the live APIs**,
and corrects the things in the draft that would have cost real SOL to discover.

> [!success] Phase 1 is built and on `main` — commit `99001bb`
> `buildTokenMetadata`, `calculateTxInAllocation`, `derivePumpFunPDAs`.
> 476 tests pass. PDAs verified **3 of 3** against mainnet.
> See [[#Phase 1 — what shipped]].

> [!info] What changed from the first draft, and why it matters
> The original plan bundled a 5% free allocation with **five sub-wallets sniping
> the token at block 0**. Those five wallets do no execution work — in the
> copytrade engine sub-wallets split *our own* risk across exit ladders, which is
> why they exist there. At launch their only function is to make one buyer look
> like five, and the profit then comes from people reading that as organic demand.
>
> Aegis already names that pattern. From `smart_money.mjs:1193`:
> `"N bundled insider wallet(s) across M network(s), holding X% — same-block
> accumulation detected"`. The Insider Shield built on 2026-08-15 blocks tokens on
> exactly this signature. **The first draft would have produced tokens this bot is
> designed to refuse.**
>
> This version keeps one disclosed creator wallet. Everything downstream — the
> metadata pipeline, PDA work, bundle assembly, `--paper` — is unchanged.

---

## Verified today

| Claim | Result |
|---|---|
| Program `6EF8rrec…F6P` is the Pump.fun bonding curve | `executable=true`, owner `BPFLoaderUpgradeab1e` ✅ |
| Program `pAMMBay6…fXEA` is Pump AMM (post-migration) | `executable=true` ✅ |
| `pump.fun/api/ipfs` reachable | HTTP 500 on an empty body — endpoint live, rejects junk ✅ |
| `pumpportal.fun/api/trade-local` reachable | HTTP 400 `Bad Request` — live, validates input ✅ |
| Jito block engine reachable | HTTP 400 `missing field 'jsonrpc'` ✅ |

That last one is worth reading twice. Jito rejected the probe for a **missing
`jsonrpc` field** — which is precisely the key `buildJitoBundle()` already emits.
The bundle payload shape in `live_execute.mjs` is what the block engine wants.

Both program IDs are already constants in `live_copytrade.mjs`
(`PUMP_BONDING_PROGRAM`, `PUMP_AMM_PROGRAM`), so nothing new is being introduced.

---

## Correction 1 — do not hand-author the `create` instruction

The draft says *"Constructs `create` instruction (Mint Keypair + Bonding Curve PDA
+ Associated Token Accounts)"*. That means authoring raw instruction data:
the Anchor discriminator, the exact account ordering, the PDA seeds, the
borsh-encoded args.

**Everything this repo signs today was built by someone else.** `signTransaction`
takes a base64 transaction from Jupiter, splits off the message, signs it
byte-for-byte and never rebuilds it — deliberately, so a signature can only ever
authorise what the API constructed. From `live_execute.mjs`:

> *"The message is passed through untouched — this function never rebuilds it, so
> a signature produced here can only authorise exactly what Jupiter constructed."*

Authoring a `create` instruction throws that property away. Get the account order
wrong and the transaction fails after paying a fee; get the PDA seeds wrong and
you create a mint with an unreachable bonding curve.

**`pumpportal.fun/api/trade-local` is the Jupiter-equivalent here** — it returns a
serialised transaction to sign locally, with no custodial key handover. Verified
live today. That keeps the existing signing boundary exactly as it is.

> [!tip] Recommended path
> `trade-local` builds → `signTransaction()` signs → `buildJitoBundle()` bundles →
> `submitJitoBundle({ allowSend: true })` ships. Every one of those four already
> exists and is unit-tested. The new module is mostly **glue plus a metadata
> uploader**.
>
> Hand-rolled instructions stay a fallback, behind its own flag, only if
> `trade-local` proves unreliable — and then measured, not assumed.

---

## Correction 2 — a one-transaction "bundle" is not what a bundle is for

The draft ships *"pool creation + dev allocation in 1 atomic Jito bundle"*.

A Jito bundle guarantees that N transactions land **in one slot, in order, or not
at all**. With a single transaction that guarantee is already provided by the
transaction itself — atomicity is what a Solana transaction *is*. Paying a tip for
a one-transaction bundle buys auction priority, nothing more.

It becomes genuinely useful at **two or more** legs, e.g. `create` + creator buy,
where landing one without the other is a real failure mode.

- Jito caps a bundle at **5 transactions** (`JITO_MAX_BUNDLE_SIZE`).
- The tip is charged **per bundle**, whether or not it wins the auction.
- `swapFeeConfig()` already refuses to attach a tip outside a bundle, because a
  tip on a normally-broadcast transaction is a real transfer that buys nothing.

> [!warning] Tip sizing
> At the shipped `maxTradeSol: 0.01`, a `--jito-tip 0.005` is **50% of the trade**.
> On a launch the relevant denominator is the deploy cost rather than a trade size,
> but the number still deserves stating out loud rather than defaulting.

---

## Correction 3 — the AI modules score tokens, they do not name them

The draft says the deployer *"integrates with `news_sentinel.mjs` and
`ai_narrative_scorer.mjs` to generate trending token names, symbols and
metadata."* Both files exist and the model id is right (`DEFAULT_MODEL =
'gemini-flash-lite-latest'`), but **neither generates anything.** They run in the
opposite direction:

| Function | Signature | Direction |
|---|---|---|
| `matchTokenToNews` | `({ pair, news, … })` | takes a token that **already exists** |
| `extractNarrativeMetadata` | `(pair)` | reads an existing pair's name/socials |
| `buildPrompt` | `(metadata)` | prompts the model to **score** that pair |
| `parseNarrativeScore` | `(text)` | reads a score back out |

They are an **analysis** pipeline: given a token, how well does it ride a story.
Naming is the reverse — given a story, what token should exist. That is new code,
not an integration.

What genuinely is reusable:

- `fetchBreakingNews({ config, cryptoPanicToken })` — the headline feed
- `DEFAULT_FEEDS` — the sources already curated
- `extractKeywords(title, keywords)` — headline → candidate terms

The naming step itself (`headline → { name, symbol, description }`) has to be
written, and its output then flows into the **existing** `buildTokenMetadata()`,
which already enforces the 32/10-character caps and the URI rules.

> [!warning] `--auto-news` needs a content gate before it is ever unattended
> A feed of *breaking* headlines is disproportionately disasters, deaths and
> attacks. An unattended `--auto-news` deploys a token named after whichever one
> broke first, and that is not a hypothetical edge case — it is the median
> breaking story.
>
> Minimum bar before this runs without a human: a refusal list on the naming step
> (death, casualties, disaster, attack, victim, missing, obituary…), and a
> `--confirm` gate that prints the proposed name and waits. `--paper` is not that
> gate; it stops SOL leaving, not a name being chosen.

> [!info] Worth noticing: Aegis discounts exactly what this would produce
> From `telegram.mjs:719` — *"A token named after a breaking story is the
> signature of an opportunistic launch as often as a real one. This adds no
> score; every safety gate still applied."*
>
> The scanner declines to reward news-named tokens. That is not a reason the
> deployer cannot make them — but the two halves of the project now hold opposite
> views, and the scanner's view is the one backed by measurement.

---

## Component: `aegis/auto_deployer.mjs`

### 0. Viral narrative naming (`--auto-news`)

- `fetchBreakingNews()` for headlines; `extractKeywords()` for candidate terms.
- A **new** naming function turns a headline into `{ name, symbol, description }`
  via Gemini, then hands off to `buildTokenMetadata()` for validation.
- Refusal list applied to the headline **before** the model sees it — cheaper and
  more reliable than asking a model to decline.
- `--confirm` prints the proposal and waits. Unattended naming is the mode that
  gets someone in trouble, and it is the one worth making opt-in.

### 1. Metadata & IPFS

- POST `name`, `symbol`, `description`, `image` to `pump.fun/api/ipfs`.
- Validate the returned URI **before** minting. A mint pointing at a dead URI is
  permanent and unfixable.
- `image` is read from disk; reject anything that is not a real file rather than
  uploading an empty body — the endpoint answers 500 to junk, and a 500 mid-deploy
  is ambiguous in a way an early file check is not.

### 2. Mint & bonding curve

- Mint keypair generated locally, **never persisted to the repo**. The same rule
  as the hot wallet: `assertKeyfileOutsideRepo()` exists for exactly this, and a
  key in a working tree is one `git add -A` from being published.
- Transaction requested from `trade-local`, signed with `signTransaction()`.
- The mint keypair signs alongside the payer — a create needs both.

### 3. Disclosed creator allocation

- One wallet. Written into the note, the log line, and the deploy receipt.
- Percentage is a CLI argument with no default: a silent default here is a
  silent claim about someone's supply.
- On-chain this is visibly the deployer's own address. That visibility **is** the
  disclosure — nothing is hidden behind a second wallet.

### 4. Jito dispatch

- `buildJitoBundle()` → `submitJitoBundle({ allowSend: true })`.
- `allowSend` defaults to **false** and must be passed explicitly. It is the only
  send path in the repo not gated behind `--live` plus a signer, so it is gated
  behind an argument instead.
- A bundle id is **not** a signature and cannot be looked up with
  `getSignatureStatuses` — the transactions inside carry their own.

### 5. `--paper` mode

- Runs steps 1–4 with the broadcast removed, not merely skipped: **no signer is
  constructed**, so nothing could sign even if a later branch tried. Same shape as
  `--dry-run` in `live_copytrade.mjs`.
- Reports the instruction encoding, the derived PDA, the assembled bundle payload,
  and the simulated market-cap rungs.
- Real cost: **0 SOL**.

### 6. Handover to the exit engine

- On confirmation, write the mint into the book with
  `originatingWhale: <creator wallet>` so the existing rule applies unchanged —
  only that wallet's sells close the position.
- 2x / 5x / 10x map onto the sub-wallet ladders already in `sub_wallets.mjs`.

> [!danger] Liquidity is the binding constraint, not the ladder
> Measured on tokens this book actually held: a **$3,000** buy costs
> **10.13% / 50.65% / 27.50%** price impact against pools of
> **$53,750 / $4,692 / $15,656**. A 10x rung on a thin pool is a number on a
> screen, not an exit. Size the rungs against pool depth, not against the multiple.

---

## Command line

```powershell
# Simulation. Nothing signed, nothing sent, 0 SOL.
node aegis/auto_deployer.mjs --paper --name "Aegis AI" --symbol "AEGIS" `
  --image ./assets/logo.png --creator-pct 5 --buy-sol 1.0

# Same, with the narrative pipeline choosing the name. --confirm shows the
# proposal and waits; without it nothing is unattended.
node aegis/auto_deployer.mjs --paper --auto-news --confirm --buy-sol 1.0

# Mainnet. Requires --keyfile OUTSIDE the repo, as live_copytrade.mjs does.
node aegis/auto_deployer.mjs --live --keyfile C:/Users/sushr/.solana/deployer.json `
  --name "Aegis AI" --symbol "AEGIS" --image ./assets/logo.png `
  --creator-pct 5 --buy-sol 1.0 --jito-tip 0.005
```

Neither `--paper` nor `--live` is a default. Running with no mode flag refuses to
start — the same rule `live_copytrade.mjs` uses, because defaulting to paper means
someone thinks they deployed and did not, and defaulting to live is unthinkable.

---

## Phase 1 — what shipped

Commit `99001bb`. Three pure functions, no network, no keys. **476 tests pass.**

| Export | Does |
|---|---|
| `buildTokenMetadata()` | validates and shapes the JSON, refuses a bare CID or local path |
| `calculateTxInAllocation()` | integer base units via basis points; no default percentage |
| `derivePumpFunPDAs()` | bonding curve + associated bonding curve |
| `findProgramAddress()` / `isOnCurve()` | the ed25519 machinery underneath |

> [!danger] The bug only chain verification caught
> **Pump.fun mints are Token-2022, not classic SPL**, and the token program id is
> a *seed* of the associated token account. The classic seed derives a real,
> valid, off-curve address that is simply the wrong account:
>
> | | |
> |---|---|
> | classic seed derives | `9xCa3ZwS…` |
> | the curve actually holds | `EaEWpMQc…` |
> | all three mints owned by | `TokenzQdB…` (Token-2022) |
>
> Both look equally plausible in review. The wrong one surfaces as a transaction
> that fails on chain **after** paying a fee. First verification run scored 0/3;
> after the fix, **3/3**.

A second near-miss worth keeping: one mint's ATA looked mis-derived because
`getAccountInfo` returned null — but `getTokenAccountsByOwner` showed the account
exists with reclaimed rent. **Null is not absent.** Chasing that would have meant
"fixing" correct code.

`isOnCurve` is the load-bearing half: a PDA must have no private key, which is
what off-curve *means*. Without the check, `findProgramAddress` returns an
ordinary public key someone could hold the key to — for an account the program
believes only it can sign for.

---

## Tests — `aegis/test/auto_deployer.test.mjs`

Phase 1 (built, 4 tests):

1. **Metadata** — required fields, URI scheme enforced, all failures collected
   rather than just the first.
2. **Allocation** — integer base units, parts re-sum to supply, no default pct.
3. **PDA off-curve** — a real wallet tests on-curve, every derived address off;
   canonical bump walks 255 down; seed- and program-sensitive so the test fails
   when derivation *drifts*, not only when it throws.
4. **PDAs vs mainnet** — pinned against two live mints, plus an assertion that
   the classic-token-program seed produces the **wrong** address, so the
   Token-2022 lesson cannot be silently undone.

Later phases:

5. **Naming** — refusal list applied to the headline before the model call;
   generated name/symbol survive `buildTokenMetadata()`'s caps.
6. **Bundle** — order preserved, 5-transaction cap, tip only when bundled,
   `submitJitoBundle` refuses without `allowSend`.
7. **Mode gate** — no signer constructed under `--paper`, asserted at the seam
   rather than by reading a flag.

---

## Open questions

- **`trade-local` reliability is unmeasured.** It answered today; it has no SLA
  here. Before it is load-bearing, probe it the way Jupiter was probed — the
  Jupiter free tier looked fine until a sustained run showed **10 requests per
  ~5 seconds**, and reading the rate headers literally was wrong by 5x.
- **Deploy cost is not yet measured.** Mint rent, ATA rent (~0.00204 SOL each),
  metadata, priority fee and tip. Worth measuring on devnet before mainnet.
- **Nothing here improves the copytrade edge.** Current clean-cohort round-trip
  drag is about **−4%** and entries are near parity — the losses are on exits.
  A deployer is a different business, not a fix for that one.
- **Who is meant to buy these?** Worth answering before the naming pipeline is
  automated. The disclosed-creator design is honest about supply, but a token
  minted from a headline minutes after it broke has no product behind it, and the
  exit ladders assume someone arrives to sell into. That assumption is the whole
  business model and it is currently unexamined.

---

## Related

- [[01 Live Copytrade Plan]] — the signing boundary and phase gates this reuses
- `aegis/live_execute.mjs` — `buildJitoBundle`, `submitJitoBundle`, `signTransaction`
- `aegis/sub_wallets.mjs` — the exit ladders the handover targets
