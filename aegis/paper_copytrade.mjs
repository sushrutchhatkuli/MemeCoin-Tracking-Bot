#!/usr/bin/env node
/**
 * Paper copy-trading engine — mirrors the active #1 master whale with VIRTUAL
 * SOL and grades the result.
 *
 *   node paper_copytrade.mjs               run one tick (mirror, mark, exit)
 *   node paper_copytrade.mjs --scorecard   print the scorecard, change nothing
 *   node paper_copytrade.mjs --target      show the active target and why
 *   node paper_copytrade.mjs --reset       start a fresh book at the configured budget
 *   node paper_copytrade.mjs --watch 5     fixed in-place dashboard, redrawn every 5s
 *   node paper_copytrade.mjs --demo        open one live test position right now
 *
 *   --budget <usd> / --starting-balance <usd>   fund a NEW book in dollars,
 *                                               e.g. --reset --budget 50
 *   --pct-whale <percent>                       size each mirrored entry at
 *                                               this % of what the whale spent,
 *                                               e.g. --pct-whale 10
 *   --no-chain                                  ignore the live RPC mirror and
 *                                               fall back to the ledger
 *   --rpc <url>                                 use a different keyless node
 *   --pure-mirror                               copy the target and nothing
 *                                               else: no take-profit, no
 *                                               trailing stop, no hard stop
 *
 * A short --watch interval re-prices and re-renders quickly, but it CANNOT make
 * the mirror faster than the ledger it reads: see the latency note below. At 5s
 * the ledger is reloaded only when the scanner has rewritten it, and the SOL
 * spot price is refreshed at most every 30s; token prices are fetched every
 * tick because those are what actually move.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS SPENDS NOTHING AND SIGNS NOTHING.
 *
 * There is no key, no wallet, no transaction and no route to one anywhere in
 * this file. Every "buy" is a row in .state/paper_copytrade.json and every
 * "balance" is a number in that row. The module imports no signer and the only
 * network call it makes is a price read from DexScreener. That is a design
 * constraint, not an accident: the entire value of a paper book is that it can
 * be wrong for free, and a paper engine that could reach funds would be a live
 * trading bot with a misleading name.
 *
 * ── "0ms" IS NOT ACHIEVABLE AND THE REAL NUMBER MATTERS ─────────────────────
 * The mirroring DECISION is immediate — there is no queue, no confirmation step
 * and no deliberation between seeing a whale's buy and recording the paper
 * fill. What is not immediate is SEEING the buy, and no amount of code here
 * changes that:
 *
 *   whale's buy lands on chain                      t+0
 *   Aegis replays the pool and observes the buyer   next audit of that token
 *   this engine reads the observation ledger        next paper tick
 *
 * The scan cadence is ~40-55s per loop.mjs's own banner, buyer replay only runs
 * on tokens that reach an audit, and smartMoney.buyerMaxTxLookups is 12 — so a
 * whale's buy is seen if it is among the first 12 buyers of a token Aegis
 * audited, and seen tens of seconds later at best. A real copy-trader front-runs
 * that with a websocket on the wallet itself.
 *
 * THE BOOK IS THEREFORE PESSIMISTIC BY CONSTRUCTION, and deliberately so: fills
 * are recorded at the price when the buy was OBSERVED, not the price the whale
 * paid. On a launch that ran 2x in the first minute, the whale is up 100% and
 * this book enters flat. Reporting the whale's fill price would produce a
 * scorecard measuring the whale's skill rather than what copying it would have
 * returned, which is the only question a paper book exists to answer.
 *
 * ── WHAT THE SCORECARD IS AND IS NOT ───────────────────────────────────────
 * It is a record of what this strategy would have done on the tokens Aegis
 * happened to observe, priced at DexScreener mid, with a fixed slippage
 * assumption and no market impact. It is not a backtest, not a projection, and
 * not evidence that the same result is available live. Exit prices in
 * particular are optimistic in the direction that matters most: a paper stop
 * fills at the marked price, and a real stop on an illiquid memecoin does not.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

process.stdout?.on?.('error', () => {});
process.stderr?.on?.('error', () => {});

import { fetchPairsBatch, fetchDexScreenerPrice } from './sources.mjs';
import { loadObservations } from './wallet_observations.mjs';
import { websocketUrlFor } from './discovery_daemon.mjs';
import {
  resolveSubWallets,
  partitionSizeSol,
  createSubPositions,
  subWalletCfg,
  summariseSubPositions,
  subWalletEconomics,
} from './sub_wallets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BOOK_PATH = join(HERE, '.state', 'paper_copytrade.json');
export const BOOK_VERSION = 1;

/**
 * Defaults. Every one is overridable from config.json under `paperCopytrade`.
 *
 * takeProfit is a LADDER, not a single exit, because a single +100% exit and a
 * trailing stop answer different questions and the specification asked for
 * both. The rungs sell a FRACTION and leave the rest running, matching the
 * convention sellSignals already uses: TAKE_PROFIT removes capital, it does not
 * close the position, so the stop stays armed on the remainder.
 */
export const PAPER_DEFAULTS = {
  budgetSol: 10.0,
  perTradeSol: 1.0,
  // Raised 6 -> 50. At 6 the book spent nearly its whole life full: an audit
  // against chain found it holding 6/6 with 0 free balance, mirroring 8 of the
  // target's 12 swaps and declining the rest. A copy of an arbitrary subset is
  // not a copy of the strategy, and it biases the result in an unknowable
  // direction — the declined trades are not a random sample of the good ones.
  //
  // The cap is no longer the binding constraint at this budget; free balance is,
  // and that is the honest one to be bound by. Sizing follows perTradeSol or
  // --pct-whale, so the way to hold more positions is a smaller share per trade
  // rather than a bigger cap.
  maxOpenPositions: 50,
  // Rungs are cumulative gain from ENTRY, each firing at most once.
  takeProfit: [
    { gainPct: 100, sellFraction: 0.5 },
    { gainPct: 200, sellFraction: 0.5 },
  ],
  // Trailing stop measured from the PEAK price seen while the position was
  // open, not from entry. A fixed stop from entry cannot lock in a runner.
  trailingStopPct: 30,
  // Hard floor from entry, so a token that never rallies still has an exit.
  hardStopPct: 40,
  // Round-trip cost assumption. NOT decoration: at 0% every scorecard is a
  // fantasy, because the whole edge being measured is often smaller than the
  // spread on a memecoin. Applied to both legs.
  slippagePct: 1.5,
  // Solana priority + base fee per leg, in SOL.
  feeSol: 0.0006,
  // A position whose pair stops pricing is not silently held forever.
  staleExitHours: 48,
  // Only mirror buys observed this recently. An old buy in the ledger is
  // history, not a signal to enter now.
  maxBuyAgeMinutes: 30,
  // PROPORTIONAL SIZING. When set, a mirrored position is this percentage of
  // what the whale actually spent, instead of the flat perTradeSol. Null keeps
  // the flat size. See mirrorPositionSize for what the percentage costs.
  pctWhale: null,
  // Floor for a proportional position. 0 means "no floor", which is faithful to
  // a bare --pct-whale and is why the CLI warns instead of silently clamping.
  minTradeSol: 0,
  // IMPLIED ENTRY. Price a mirrored buy from the swap itself rather than
  // waiting on a pair lookup — see impliedEntryPriceUsd for what that costs.
  useImpliedEntry: true,
  // What arriving after the target costs, on top of slippagePct.
  //
  // ── DEFAULTED TO 0 BECAUSE THE 9 THAT WAS HERE WAS MEASURED WRONG ─────────
  // The original figure came from comparing the target's implied fill against
  // DexScreener 0.6-3.7 MINUTES later and reading the ~-9% cluster as impact.
  // That window is hundreds of times our actual latency, so it measured
  // ordinary price drift over minutes, not the cost of arriving late.
  //
  // RE-MEASURED at the real latency — live socket, price fetched 410-575ms
  // after each buy landed:
  //   -41.1%  +43.3%  -13.2%  -8.9%  +15.5%     median -8.9%
  // The median is NEGATIVE: the quoted price shortly after the target buys is
  // typically BELOW their own effective fill, because their fill already
  // contains the spread and impact they paid to cross it. A copier is not
  // reliably worse off on entry at all.
  //
  // Five samples with a ±40% spread is not a number to hard-code in either
  // direction, which is exactly why it is 0 now rather than some smaller
  // positive guess. slippagePct still charges the spread on both legs.
  //
  // WHAT THE OLD 9 DID TO THE BOOK: entry x1.09 x1.015 against an exit x0.985
  // is -10.97% on a round trip where the price never moved. Replaying the same
  // 119 closed trades at 0 instead of 9 turns -13.12 SOL into -6.44 SOL and the
  // win rate from 12.6% into 29.4%. Half the wipeout was this constant.
  //
  // Calibrate it per target rather than trusting a default: it is the single
  // most sensitive number in the model.
  copyImpactPct: 0,
  // Below this the fee and rent inside solSpent distort the implied price
  // enough to matter, so the pair lookup is used instead.
  impliedMinSpendSol: 0.05,
  // ── DEX LIQUIDITY MODEL ───────────────────────────────────────────────────
  // Price every fill against the pool it would actually have to cross, instead
  // of at the quoted mid. See the "DEX liquidity" section for the arithmetic
  // and for the pool depths it was measured against.
  //
  // ON by default, unlike copyImpactPct, and the difference is that this is not
  // a constant: it is read per token from the pair that prices the position, so
  // there is no single number to be wrong about. What IS a constant is
  // poolFloorSol, which is why poolDepthLookup exists to keep it rare.
  liquidityModel: true,
  // ── SLOT-LATENCY FILLS ────────────────────────────────────────────────────
  // Price entries and exits from REAL on-chain swaps at the slot we could
  // actually have landed in, instead of at the target's own fill or a
  // DexScreener mid. See the "Slot-latency fills" section for the measured
  // observation lag this is built on, and for the two things it still cannot
  // model (our own impact, and fill probability).
  //
  // OFF BY DEFAULT, and the reason is cost rather than doubt: the existing
  // implied-price path makes NO extra RPC call, because the swap carries its
  // own price. This one spends a getSignaturesForAddress plus up to
  // slotFillMaxLookups getTransaction calls PER MIRRORED TRADE. That is a real
  // bill and the operator should choose to pay it.
  slotFills: false,
  // Slots after the target's trade. `expected` is what the book trades on;
  // earliest and latest are reported beside it as an uncertainty spread.
  // earliest is floored by a MEASURED observation lag; the other two are
  // assumptions — see DEFAULT_SLOT_OFFSETS.
  slotOffsets: { earliest: 3, expected: 5, latest: 10 },
  // Transactions read per window. Bounds the bill on a busy token.
  slotFillMaxLookups: 40,
  // Largest share of a pool's SOL side one paper trade may take.
  poolCapPct: 5,
  // Assumed depth when a pool cannot be read. Conservative, and WRONG — see the
  // section header. 30 SOL is roughly $2,500 at current spot.
  poolFloorSol: 30,
  // Resolve pool depth for chain-mirrored candidates that priced themselves
  // from the swap and would otherwise skip the pair lookup entirely.
  //
  // ── OFF, BECAUSE THE FAST PATH IS A MEASURED PROPERTY AND THIS IS NOT ─────
  // An implied entry deliberately makes NO pair lookup: the swap carries its own
  // price and the round trip plus fetchPairsBatch's 250ms internal pace is the
  // latency the whole path exists to avoid. Turning that off by default would
  // trade a property this repo engineered and tested for one the operator did
  // not ask for.
  //
  // WHAT IT COSTS TO LEAVE IT OFF, stated plainly: an entry with no pool on file
  // pays poolFloorSol instead. Against the 117-260 SOL pools measured for this
  // population that overcharges a 1 SOL buy by roughly 2.5 percentage points,
  // every time, and the scorecard's "priced against the ASSUMED pool floor" line
  // is how you see it happening.
  //
  // EXITS ARE UNAFFECTED EITHER WAY. Open positions are marked through the pair
  // feed every tick, so a sell always has real depth — which is where the model
  // matters most, since a position that ran 10x is the one the pool cannot
  // absorb. Turn this on to put entries on the same footing.
  poolDepthLookup: false,
  // SCALE IN. When the target buys MORE of something already held, add to the
  // position instead of declining the trade. A copy that ignores the second buy
  // mirrors a conviction the target expressed only once.
  scaleIn: true,
  // RE-ENTER. Buy again after a position has been fully closed. Memecoin
  // traders round-trip the same tickers repeatedly, so "one position per mint,
  // ever" silently discards most of what a target does. Set false for a book
  // that should hold at most one lifetime position per token.
  reEnter: true,
  // PURE MIRROR. The book takes no exit decision of its own — no take-profit
  // ladder, no trailing stop, no hard stop. It buys when the target buys and
  // sells when the target sells, and that is all. See evaluatePaperExits.
  pureMirror: false,
  // LIVE ON-CHAIN MIRROR. Reads the target's own transactions from a free
  // public RPC — 0 Helius credits — instead of waiting for the observation
  // ledger. Sees sells too, which the ledger never recorded.
  // How many sub-wallets a position is split across, each with its own exit
  // ladder. 1 is NOT "off": it is the scalper alone, which exits everything at
  // +50% and mirrors nothing. 0 is off.
  //
  // ── DEFAULT 0, DELIBERATELY ─────────────────────────────────────────────
  // Splitting is opt-in because it changes what the book MEASURES, not just
  // how it trades. Round-trip drag is our return minus the target's on the
  // same token, which only means something while both sides exit the same way.
  // At three sub-wallets two thirds of capital exits on our ladder instead, so
  // only the moonshot share stays a valid calibration sample and the n=20
  // effort collects at a third of the rate.
  //
  // The economics point the same way at current sizing: 0.01 SOL split three
  // ways is 0.0033 each against 0.00204 of ATA rent plus fees — 91% overhead,
  // against the ~5% exit drag the split is meant to work around. Pass
  // --sub-wallets 3 when trade size makes that arithmetic work.
  // Scale sizing with BANKED equity — see compoundSizing. Off by default:
  // it multiplies both wins and mistakes, and the pools cap the upside long
  // before the formula does.
  autoCompound: false,

  subWallets: 0,

  rpcMirror: {
    enabled: true,
    url: 'https://api.mainnet-beta.solana.com',
    signatureLimit: 25,
    // Matches signatureLimit so a cold start or a post-outage catch-up drains
    // the whole page in ONE tick. It was 12 to bound cost on a path that ran
    // every tick forever; the socket now carries steady state, so the poll only
    // runs at startup and during a reconnect and there is nothing left for a
    // low cap to protect against — it only slowed the one moment that matters.
    maxTxLookupsPerTick: 25,
    delayMs: 120,
    // Mirror the target's exits as well as its entries. The paper stop and
    // take-profit ladder still run underneath, on whatever the whale exit
    // leaves behind — BOTH can act in one tick. A 40% whale sell into a price
    // that has doubled books the whale exit first and then takes the +100%
    // rung on the remainder, which is two independent risk rules agreeing
    // rather than one overriding the other.
    mirrorSells: true,
  },
};

/* ------------------------------------------------------------------ *
 * Book state — pure
 * ------------------------------------------------------------------ */

/**
 * A fresh book.
 *
 * `budgetUsd` converts to SOL at the rate given, and BOTH the dollar figure and
 * the rate used are recorded. Keeping only the resulting SOL would make "I
 * started with $50" unrecoverable the moment SOL moved, and keeping only the
 * dollars would leave the book unable to size a trade. The pair is what lets
 * the dashboard separate a trading result from a SOL price move later.
 */
export function createBook({
  budgetSol = PAPER_DEFAULTS.budgetSol,
  budgetUsd = null,
  solUsd = null,
  target = null,
  now = Date.now(),
} = {}) {
  let startSol = budgetSol;
  let budgetUsdAtStart = null;
  let solUsdAtStart = null;

  if (Number.isFinite(budgetUsd) && budgetUsd > 0) {
    if (!Number.isFinite(solUsd) || solUsd <= 0) {
      throw new Error('a USD budget needs a SOL/USD rate to convert with');
    }
    startSol = budgetUsd / solUsd;
    budgetUsdAtStart = budgetUsd;
    solUsdAtStart = solUsd;
  }

  return {
    version: BOOK_VERSION,
    createdAt: now,
    budgetSol: startSol,
    balanceSol: startSol,
    budgetUsdAtStart,
    solUsdAtStart,
    target: target ? { ...target, since: now } : null,
    positions: {},
    closed: [],
  };
}

/**
 * Effective config, defaults merged with config.json overrides. PURE.
 *
 * Validated rather than trusted: a negative budget or a sellFraction above 1
 * would produce a book that mints SOL, and a scorecard that mints SOL is worse
 * than no scorecard because it looks like a result.
 */
export function paperConfig(overrides = {}) {
  const cfg = { ...PAPER_DEFAULTS, ...overrides };
  cfg.budgetSol = Math.max(0, Number(cfg.budgetSol) || 0);
  cfg.perTradeSol = Math.max(0, Number(cfg.perTradeSol) || 0);
  cfg.maxOpenPositions = Math.max(0, Math.floor(Number(cfg.maxOpenPositions) || 0));
  cfg.slippagePct = Math.max(0, Number(cfg.slippagePct) || 0);
  cfg.feeSol = Math.max(0, Number(cfg.feeSol) || 0);
  cfg.minTradeSol = Math.max(0, Number(cfg.minTradeSol) || 0);
  // Null and 0 both mean "flat sizing". A 0% proportional size would open
  // nothing forever, which is a config mistake rather than a strategy.
  cfg.pctWhale =
    Number.isFinite(Number(cfg.pctWhale)) && Number(cfg.pctWhale) > 0 ? Number(cfg.pctWhale) : null;
  cfg.pureMirror = cfg.pureMirror === true;
  cfg.scaleIn = cfg.scaleIn !== false;
  cfg.reEnter = cfg.reEnter !== false;
  cfg.useImpliedEntry = cfg.useImpliedEntry !== false;
  cfg.copyImpactPct = Math.max(0, Number(cfg.copyImpactPct) || 0);
  cfg.impliedMinSpendSol = Math.max(0, Number(cfg.impliedMinSpendSol) || 0);
  cfg.liquidityModel = cfg.liquidityModel !== false;
  cfg.poolDepthLookup = cfg.poolDepthLookup !== false;
  // A cap of 0 sizes every trade to nothing and a cap above 100 lets one order
  // claim more than the pool holds. Both are config mistakes that produce a book
  // which looks like it is working, so 0 and anything unreadable go back to the
  // default while an over-large value is clamped to the whole pool.
  const capPct = Number(cfg.poolCapPct);
  cfg.poolCapPct = Number.isFinite(capPct) && capPct > 0 ? Math.min(100, capPct) : PAPER_DEFAULTS.poolCapPct;
  // A floor of 0 is not "no floor", it is a pool of nothing: priceImpactPct
  // would refuse it and every unmeasured fill would silently go back to being
  // free. Falls back to the default instead.
  cfg.poolFloorSol = Number(cfg.poolFloorSol) > 0 ? Number(cfg.poolFloorSol) : PAPER_DEFAULTS.poolFloorSol;
  cfg.rpcMirror = { ...PAPER_DEFAULTS.rpcMirror, ...(cfg.rpcMirror ?? {}) };
  // Pure mirror without the chain feed would be a book that can never sell:
  // the ledger records buys only, so the sole exit path would be gone. Forced
  // rather than warned, because the resulting book looks like it is working.
  if (cfg.pureMirror) {
    cfg.rpcMirror.enabled = true;
    cfg.rpcMirror.mirrorSells = true;
  }
  // A blank or non-http url would silently disable the mirror while the config
  // still claimed it was on.
  if (!/^https?:\/\//.test(String(cfg.rpcMirror.url ?? ''))) {
    cfg.rpcMirror.url = PAPER_DEFAULTS.rpcMirror.url;
  }
  cfg.takeProfit = (Array.isArray(cfg.takeProfit) ? cfg.takeProfit : [])
    .map((r) => ({
      gainPct: Number(r?.gainPct),
      sellFraction: Math.min(1, Math.max(0, Number(r?.sellFraction))),
    }))
    .filter((r) => Number.isFinite(r.gainPct) && r.sellFraction > 0)
    .sort((a, b) => a.gainPct - b.gainPct);
  return cfg;
}

/**
 * How much SOL to put into one mirrored entry. PURE.
 *
 * Flat by default (perTradeSol). With `pctWhale` set, the position is that
 * percentage of what the whale ACTUALLY SPENT — proportional copying, so a
 * conviction buy from the target produces a larger paper position than a
 * nibble, which a flat size cannot express.
 *
 * ── THE PERCENTAGE IS SMALLER THAN IT SOUNDS, AND FEES ARE THE REASON ──────
 * MEASURED across the 68,301 buys in the ledger (90.8% of which carry a usable
 * spend figure):
 *   p10 spend 0.002 SOL   ->  10% = 0.0002 SOL
 *   median    0.117 SOL   ->  10% = 0.0117 SOL
 *   p90       1.501 SOL   ->  10% = 0.1501 SOL
 * Round-trip fees at the default feeSol are 0.0012 SOL. So at 10% of a MEDIAN
 * whale buy, fees are ~10% of the position, and below roughly the 25th
 * percentile they exceed the position entirely — the book would post losses
 * that are pure fee drag and read as the strategy failing.
 *
 * `minTradeSol` exists for that and defaults to 0, i.e. OFF: clamping silently
 * would misreport what a bare `--pct-whale 10` does. The CLI warns instead, so
 * the choice is visible rather than made on the operator's behalf.
 *
 * An UNKNOWN whale spend falls back to the flat size rather than skipping the
 * trade. 9.2% of ledger buys have no spend attributed — several buyers in one
 * transaction, or SOL that could not be split from balances — and dropping
 * those would silently make the mirror sample a biased subset of the whale's
 * activity rather than a smaller version of it.
 */
export function mirrorPositionSize(cfg, { whaleSpendSol = null, balanceSol = 0, poolSol = null } = {}) {
  const spendable = balanceSol - cfg.feeSol;
  if (!(spendable > 0)) return { ok: false, reason: 'insufficient virtual balance' };

  const proportional = cfg.pctWhale !== null && cfg.pctWhale !== undefined;
  const knownSpend = Number.isFinite(whaleSpendSol) && whaleSpendSol > 0;

  let target;
  let basis;
  if (proportional && knownSpend) {
    target = whaleSpendSol * (cfg.pctWhale / 100);
    basis = `${cfg.pctWhale}% of the whale's ${whaleSpendSol.toFixed(3)} SOL`;
  } else {
    target = cfg.perTradeSol;
    basis = proportional ? 'flat (whale spend not attributed)' : 'flat';
  }

  if (cfg.minTradeSol > 0 && target < cfg.minTradeSol) {
    return { ok: false, reason: `size ${target.toFixed(4)} SOL is below minTradeSol ${cfg.minTradeSol}`, basis };
  }

  // Capped by what is actually free, so a whale buying 30 SOL cannot overdraw a
  // book holding one.
  const afterBalance = Math.min(target, spendable);
  if (!(afterBalance > 0)) return { ok: false, reason: 'insufficient virtual balance', basis };

  // ── AND THEN BY THE POOL, WHICH IS THE HARDER CONSTRAINT ──────────────────
  // A book with balance to spare can still not fill against a pool that is not
  // there. capTradeToPool is a no-op when the caller passes no depth, so every
  // existing caller — live_copytrade among them — behaves exactly as before.
  const pooled = capTradeToPool(afterBalance, poolSol, {
    poolCapPct: cfg.poolCapPct,
    enabled: cfg.liquidityModel !== false,
  });
  const sizeSol = pooled.sizeSol;

  // Checked AGAIN after the pool cap. minTradeSol exists so the book does not
  // take positions too small to be worth their own fees, and a trade shrunk to
  // dust by pool depth is dust for the same reason — the earlier check only saw
  // what was requested. Declined with the pool named, because "below
  // minTradeSol" alone sends the operator to the wrong knob.
  if (cfg.minTradeSol > 0 && sizeSol < cfg.minTradeSol) {
    return {
      ok: false,
      reason:
        `pool depth caps this at ${sizeSol.toFixed(4)} SOL ` +
        `(${cfg.poolCapPct}% of a ${poolSol?.toFixed?.(1) ?? '?'} SOL pool), below minTradeSol ${cfg.minTradeSol}`,
      basis,
      liquidityCapped: true,
    };
  }

  return {
    ok: true,
    sizeSol,
    basis,
    // BALANCE cap only. Measured against the pre-pool size on purpose: these are
    // two different constraints with two different fixes — add funds, or accept
    // that the pool is not there — and a single flag that means either sends the
    // operator to the wrong one.
    capped: afterBalance < target,
    liquidityCapped: pooled.capped,
    requestedSol: afterBalance,
    maxPoolTradeSol: pooled.maxTradeSol,
    poolSol: pooled.poolSol,
  };
}

/* ------------------------------------------------------------------ *
 * DEX liquidity: pool depth, price impact, and the size cap
 * ------------------------------------------------------------------ *
 *
 * A paper fill at the quoted mid assumes infinite depth. Nothing on Solana has
 * infinite depth, and this book trades the shallowest end of it: MEASURED
 * 2026-08-19 across five pumpswap pairs the ledger had just seen bought, the
 * SOL side of the pool held
 *
 *     117.2   143.0   179.9   255.1   260.4   SOL
 *
 * against $21.6k - $46.1k of total pool value. A 1 SOL buy is 0.4-0.9% of that
 * depth; a 10 SOL buy is 4-8%, and a position that ran 10x is trying to sell
 * back a size the pool never had.
 *
 * ── WHY size/(pool + size) IS THE EXACT CONSTANT-PRODUCT ANSWER ─────────────
 * For reserves R (SOL) and T (token) with R·T = k:
 *
 *   BUY of s SOL   tokens out = T·s/(R+s), against T·s/R at the mid.
 *                  The shortfall is exactly s/(R+s) of what the mid implied.
 *   SELL worth v   SOL out = v·R/(R+v) — short of v by exactly v/(R+v).
 *
 * So one formula is exact on both legs, provided it is applied as a SHARE OF
 * VALUE rather than as a price adjustment. On the sell it is both: the exit
 * price is mid × (1 - impact). On the BUY it is not — paying `mid × (1 + s/R)`
 * per token is what gives you (1 - impact) of the tokens, and mid × (1+impact)
 * is a different, smaller number. entryFillUsd divides rather than multiplies
 * for exactly this reason, and 1/(1 - s/(R+s)) is identically 1 + s/R.
 *
 * At the 5% cap the two forms differ by 25 basis points. Uncapped at 50% of a
 * pool they differ by a third, which is the case this model exists to price.
 *
 * ── THE FLOOR IS A REAL COST, NOT A SAFE DEFAULT ───────────────────────────
 * An unmeasured pool falls back to poolFloorSol, 30 SOL. Against the depths
 * measured above that is 4-8x too shallow, and it charges a 1 SOL entry 3.2%
 * where the real pools charge 0.4-0.9%. It is the conservative direction, and
 * conservative is still WRONG — it is there so a missing lookup cannot be read
 * as free liquidity, not because 30 SOL is a good estimate of anything.
 * poolDepthLookup defaults on so the floor stays rare.
 *
 * ── ENTRIES ARE CAPPED, EXITS ARE NOT ──────────────────────────────────────
 * Deliberately asymmetric. A capped entry is a smaller position; a capped exit
 * is a position that cannot be closed, which would leave the book holding bags
 * it decided to sell and make every stop and rung advisory. An oversized exit
 * instead pays the full curve — a position now worth half its pool gives up 33%
 * getting out — which is self-limiting in the way that matters and is the
 * honest reason a 10x on paper is not a 10x in a wallet.
 */

/**
 * The SOL side of the pool, from a DexScreener pair. PURE.
 *
 * VERIFIED against live payloads 2026-08-19: on a SOL-quoted pumpswap pair,
 * `liquidity.quote` IS the SOL reserve — BABYANSEM read 179.8981 against
 * `liquidity.usd` 32,306.5 at $86.05/SOL, and 179.9 × 86.05 = $15.5k, half the
 * pool, exactly as a constant-product pair requires.
 *
 * A USDC-quoted pair does NOT work that way and the same field would be read as
 * 16.3 MILLION SOL — the real WSOL/USDC pair on Orca returns
 * `liquidity.quote: 16322245`, which is dollars. Hence the quote-token check
 * before the field is trusted, and the halve-and-convert path for everything
 * else.
 */
/**
 * pump.fun's initial virtual reserves: 30 SOL against 1,073,000,191 tokens.
 *
 * Their product is the curve's k, and it is what makes a bonding-curve token
 * priceable at all — see pumpFunCurveSol.
 */
export const PUMPFUN_VIRTUAL_SOL = 30;
export const PUMPFUN_VIRTUAL_TOKENS = 1_073_000_191;
const PUMPFUN_K = PUMPFUN_VIRTUAL_SOL * PUMPFUN_VIRTUAL_TOKENS;

/**
 * Depth of a pump.fun bonding curve, from its price alone. PURE.
 *
 * ── WHY THIS EXISTS: DEXSCREENER PUBLISHES NO `liquidity` FOR A CURVE ──────
 * MEASURED 2026-08-19 over the 56 most recently observed mints: 23 of them —
 * 41% — were `dexId: 'pumpfun'`, and EVERY ONE returned `liquidity: undefined`
 * while returning a perfectly good price. Those are pre-migration tokens, which
 * is where a sub-$100k-entry target does most of its trading, so leaving them
 * to poolFloorSol would mean the floor was not the fallback — it was the model.
 *
 * ── AND IT IS DERIVABLE, BECAUSE THE CURVE IS CONSTANT-PRODUCT TOO ─────────
 * The curve holds virtualSol x virtualTokens = k, and quotes
 * price = virtualSol / virtualTokens. Two equations, one unknown:
 *
 *     virtualSol = sqrt(k x priceNative)
 *
 * VERIFIED two ways on live pairs the same day. Every derived reserve landed
 * inside the curve's only valid range — 31.66 to 100.28 virtual SOL, which is
 * 1.7 to 70 SOL of real deposits against a curve that migrates near 85:
 *
 *     murb      60.66      Kirkify  100.28      GOD CANDLE  43.19
 *     EUPHORIA  52.55      RABBIT    75.89      WASB        31.66
 *
 * And the implied market cap matches DexScreener's own to within 0.05% —
 * murb derived $9,896 against a reported $9,901.34, Kirkify $27,047 against
 * $27,051.45 — which is an independent check on the constants above rather
 * than on the algebra.
 *
 * THE VIRTUAL RESERVE IS THE RIGHT DEPTH, not the real one. Impact on the curve
 * is size/(virtualSol + size); pricing against real deposits would overstate
 * the cost of every early buy, badly, on exactly the trades this target makes.
 */
export function pumpFunCurveSol(pair) {
  const priceNative = Number(pair?.priceNative);
  if (!Number.isFinite(priceNative) || priceNative <= 0) return null;
  const virtualSol = Math.sqrt(PUMPFUN_K * priceNative);
  if (!Number.isFinite(virtualSol)) return null;
  // A curve cannot hold less than it started with, and one that has passed
  // ~115 virtual SOL has migrated and should be quoting a real pool instead —
  // a number far outside that band means this is not a curve and the price was
  // read against the wrong shape.
  if (virtualSol > 200) return null;
  return Math.max(PUMPFUN_VIRTUAL_SOL, virtualSol);
}

export function poolReserveSol(pair, { solUsd = null, floorSol = 30 } = {}) {
  // Checked BEFORE the liquidity fields, because a curve has neither and would
  // otherwise fall straight through to the floor.
  if (String(pair?.dexId ?? '').toLowerCase() === 'pumpfun') {
    const curve = pumpFunCurveSol(pair);
    if (curve !== null) {
      return { reserveSol: curve, measured: true, basis: 'pump.fun bonding curve, derived from price' };
    }
  }

  const quoteAddress = String(pair?.quoteToken?.address ?? '');
  const quoteSymbol = String(pair?.quoteToken?.symbol ?? '').toUpperCase();
  const quoteReserve = Number(pair?.liquidity?.quote);
  const solQuoted = quoteAddress === WSOL_MINT || quoteSymbol === 'SOL' || quoteSymbol === 'WSOL';

  if (solQuoted && Number.isFinite(quoteReserve) && quoteReserve > 0) {
    return {
      reserveSol: quoteReserve,
      measured: true,
      basis: `SOL reserve of the ${pair?.dexId ?? 'dex'} pair`,
    };
  }

  // Half the pool's dollar value is the quote side of a constant-product pair,
  // whatever it is denominated in. One conversion away from the reserve, and
  // the only route available on a pair quoted in something other than SOL.
  const liquidityUsd = Number(pair?.liquidity?.usd);
  if (Number.isFinite(liquidityUsd) && liquidityUsd > 0 && Number.isFinite(solUsd) && solUsd > 0) {
    return {
      reserveSol: liquidityUsd / 2 / solUsd,
      measured: true,
      basis: `half of $${Math.round(liquidityUsd).toLocaleString('en-US')} pool value at $${solUsd}/SOL`,
    };
  }

  return { reserveSol: floorSol, measured: false, basis: `unmeasured — conservative floor ${floorSol} SOL` };
}

/**
 * Which pool depth a trade is actually priced against. PURE.
 *
 * The one place "no depth on file" turns into a number, so the floor cannot be
 * applied in one code path and forgotten in another. `active: false` when the
 * model is switched off, which is not the same as a pool of zero.
 */
/**
 * Which pool depth a trade is actually priced against. PURE.
 *
 * ── undefined AND null ARE DIFFERENT ANSWERS, AND THE FLOOR ONLY ANSWERS ONE ─
 *   undefined  no depth was SOUGHT. The caller is not participating in the
 *              liquidity model — a direct openPaperPosition, a demo trade, a
 *              price fetcher that returns bare numbers and cannot carry depth.
 *              The model stays out of it entirely.
 *   null       depth was sought and NOT FOUND. This is the case poolFloorSol
 *              exists for: a pair that priced but reported no liquidity, or a
 *              mint the feed could not resolve at all.
 *
 * Collapsing the two would charge the floor to every caller that never asked,
 * which is not conservatism — it is inventing a market for a trade nobody
 * looked up. runPaperTick passes null explicitly wherever a lookup was made and
 * came back empty, so the floor still lands on every case it was asked to.
 */
export function resolvePoolSol(poolSolReserve, cfg = PAPER_DEFAULTS) {
  if (cfg?.liquidityModel === false) return { reserveSol: null, measured: null, active: false };
  if (poolSolReserve === undefined) return { reserveSol: null, measured: null, active: false };
  const measured = Number.isFinite(poolSolReserve) && poolSolReserve > 0;
  return {
    reserveSol: measured ? poolSolReserve : (cfg?.poolFloorSol ?? PAPER_DEFAULTS.poolFloorSol),
    measured,
    active: true,
  };
}

/**
 * Price impact of moving `sizeSol` through a pool holding `poolSol`. PURE.
 *
 *   impact% = sizeSol / (poolSol + sizeSol) × 100
 *
 * Returns null — never 0 — when there is no pool to price against. Zero impact
 * and unknown impact are different claims and the callers treat them
 * differently.
 */
export function priceImpactPct(sizeSol, poolSol) {
  if (!(sizeSol > 0)) return 0;
  if (!Number.isFinite(poolSol) || poolSol <= 0) return null;
  return (sizeSol / (poolSol + sizeSol)) * 100;
}

/**
 * Hold a trade to a share of the pool it has to fill against. PURE.
 *
 * Capping rather than declining is the point: the trade still happens, at the
 * size the pool can actually absorb. Declining would silently make the mirror a
 * biased subset of the target's activity — the same trap mirrorPositionSize's
 * unattributed-spend fallback exists to avoid.
 */
export function capTradeToPool(sizeSol, poolSol, { poolCapPct = 5, enabled = true } = {}) {
  if (!enabled || !Number.isFinite(poolSol) || poolSol <= 0) {
    return { sizeSol, capped: false, maxTradeSol: null, poolSol: null };
  }
  const maxTradeSol = poolSol * (poolCapPct / 100);
  if (!(sizeSol > maxTradeSol)) return { sizeSol, capped: false, maxTradeSol, poolSol };
  return { sizeSol: maxTradeSol, capped: true, maxTradeSol, poolSol, requestedSol: sizeSol };
}

/**
 * What a buy actually fills at. PURE.
 *
 * DIVIDES by (1 - impact) rather than multiplying by (1 + impact). See the
 * section header: paying that price per token is what leaves you holding
 * (1 - impact) of the tokens the mid implied, which is the constant-product
 * result. Multiplying would understate the entry by impact² and flatter every
 * position in the book.
 */
export function entryFillUsd(midPriceUsd, { impactPct = 0, slippagePct = 0 } = {}) {
  const spread = 1 + Math.max(0, slippagePct) / 100;
  // Bounded below 100%: an order that takes the entire pool has no finite fill,
  // and a division by zero would write Infinity into a position's entry price.
  const impact = Math.min(Math.max(Number(impactPct) || 0, 0), 99) / 100;
  return (midPriceUsd * spread) / (1 - impact);
}

/** What a sell actually fills at. PURE. Impact and spread both come off. */
export function exitFillUsd(midPriceUsd, { impactPct = 0, slippagePct = 0 } = {}) {
  const spread = 1 - Math.min(100, Math.max(0, slippagePct)) / 100;
  const impact = Math.min(Math.max(Number(impactPct) || 0, 0), 100) / 100;
  return midPriceUsd * spread * (1 - impact);
}

/**
 * Add to a position the target bought more of. PURE.
 *
 * ── THE BLENDED ENTRY IS A HARMONIC MEAN, NOT AN AVERAGE OF PRICES ─────────
 * Every valuation in this book is `stakeSol x (mark / entry)`, so after a
 * scale-in the single (stake, entry) pair has to reproduce what two separate
 * lots would be worth:
 *
 *   (s1 + s2) x m/E  ==  s1 x m/e1 + s2 x m/e2
 *   =>  E = (s1 + s2) / (s1/e1 + s2/e2)
 *
 * A plain mean of e1 and e2 — or a stake-weighted mean of them — does NOT
 * satisfy that, and the error compounds into every mark, every rung and the
 * closed-trade P&L afterwards. Worked example: 1 SOL at $100 plus 1 SOL at
 * $200 blends to $133.33, not $150; at a $200 mark the position is worth
 * exactly 3.0 SOL, which is 2.0 from the first lot plus 1.0 from the second.
 *
 * FIRED TAKE-PROFIT RUNGS ARE NOT RE-ARMED. Adding to a position lowers the
 * blended entry and so raises the apparent gain, which would re-trigger a rung
 * that already sold — the position would be sold down repeatedly on a single
 * run-up. A rung fires once per position, and a scale-in is the same position.
 *
 * The peak is kept for the same reason it exists: it is the highest price seen
 * while the position was open, and buying more does not unsee it.
 */
export function scaleInPaperPosition(book, { mint, priceUsd, cfg, now = Date.now(), whaleSpendSol = null, poolSolReserve }) {
  const p = book.positions[mint];
  if (!p) return { ok: false, reason: 'no such position' };
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { ok: false, reason: 'no usable price' };

  const pool = resolvePoolSol(poolSolReserve, cfg);
  const sized = mirrorPositionSize(cfg, { whaleSpendSol, balanceSol: book.balanceSol, poolSol: pool.reserveSol });
  if (!sized.ok) return { ok: false, reason: sized.reason };
  const addSol = sized.sizeSol;

  // The add crosses the pool on its own, so it pays impact on its own size —
  // NOT on the blended position. The first lot already paid for the depth it
  // took, and charging the total again would bill a scale-in twice for SOL that
  // moved through the pool minutes ago.
  const impactPct = pool.active ? priceImpactPct(addSol, pool.reserveSol) : null;
  const fillPriceUsd = entryFillUsd(priceUsd, { impactPct: impactPct ?? 0, slippagePct: cfg.slippagePct });
  const s1 = p.stakeSol;
  const e1 = p.entryPriceUsd;

  // A position already sold down to nothing has no basis to blend against;
  // treat the add as the whole position rather than dividing by zero.
  const blended =
    s1 > 0 && e1 > 0 ? (s1 + addSol) / (s1 / e1 + addSol / fillPriceUsd) : fillPriceUsd;

  book.balanceSol -= addSol + cfg.feeSol;
  p.stakeSol = s1 + addSol;
  p.initialStakeSol = (p.initialStakeSol ?? s1) + addSol;
  p.entryPriceUsd = blended;
  p.markPriceUsd = priceUsd;
  p.peakPriceUsd = Math.max(p.peakPriceUsd ?? priceUsd, priceUsd);
  p.lastPricedAt = now;
  p.scaleIns = (p.scaleIns ?? 0) + 1;
  // Cumulative, so a position built over four adds reports what all four paid
  // rather than only the last one.
  p.entryImpactSol = (p.entryImpactSol ?? 0) + addSol * ((impactPct ?? 0) / 100);
  if (sized.liquidityCapped) p.liquidityCappedEntries = (p.liquidityCappedEntries ?? 0) + 1;

  return {
    ok: true,
    position: p,
    sizeSol: addSol,
    scaledIn: true,
    basis: sized.basis,
    capped: sized.capped,
    blendedEntryUsd: blended,
    impactPct,
    poolSol: pool.reserveSol,
    poolMeasured: pool.measured,
    liquidityCapped: sized.liquidityCapped === true,
    requestedSol: sized.requestedSol,
  };
}

/**
 * Record a paper entry. PURE — mutates and returns the book, no clock, no IO.
 *
 * Returns a reason instead of throwing when the trade is declined, because
 * "no balance" and "already holding" are ordinary outcomes of a tick and the
 * caller reports them rather than failing.
 */
/**
 * May this sell close this position? PURE.
 *
 * ── ONE WHALE'S THESIS, ONE WHALE'S EXIT ────────────────────────────────────
 * With four wallets mirrored, exits keyed on the mint alone let whale #4's sell
 * close a position bought on whale #1's conviction — an exit taken on a thesis
 * we never shared. Matching the seller against the originating wallet keeps
 * each position under the judgement of the wallet that opened it.
 *
 * ── BOTH UNKNOWNS FAIL OPEN, AND THAT IS DELIBERATE ─────────────────────────
 * An UNTAGGED POSITION is exitable by anyone. Six positions were already open
 * when this shipped, tagged only by the older `source` field; requiring an
 * exact match against a field they might not carry would strand them — held
 * forever because no sell could ever match. A position that cannot be closed is
 * a worse failure than one closed by the wrong whale.
 *
 * An UNATTRIBUTED SELL likewise closes anything. The poll fallback
 * (fetchWhaleTrades) carries no wallet field — only the socket cluster
 * attributes trades — so demanding attribution would silently stop the poll
 * path from ever closing a position, exactly when the socket is already down.
 */
export function exitMatchesOrigin(position, signal) {
  const origin = position?.originatingWhale ?? position?.source ?? null;
  const seller = signal?.source ?? signal?.wallet ?? null;
  if (!origin) return { match: true, reason: 'position carries no originating whale' };
  if (!seller) return { match: true, reason: 'sell is unattributed' };
  if (seller === origin) return { match: true, reason: 'same whale' };
  return {
    match: false,
    reason: `sold by ${seller.slice(0, 8)}…, position originated from ${origin.slice(0, 8)}…`,
    origin,
    seller,
  };
}

export function openPaperPosition(book, { mint, symbol = null, priceUsd, cfg, now = Date.now(), source = null, demo = false, whaleSpendSol = null, originatingWhale = null, poolSolReserve }) {
  if (!mint) return { ok: false, reason: 'no mint' };
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { ok: false, reason: 'no usable price' };
  if (book.positions[mint]) {
    if (!cfg.scaleIn) return { ok: false, reason: 'already holding' };
    return scaleInPaperPosition(book, { mint, priceUsd, cfg, now, whaleSpendSol, poolSolReserve });
  }

  const open = Object.keys(book.positions).length;
  if (open >= cfg.maxOpenPositions) return { ok: false, reason: `at max open positions (${cfg.maxOpenPositions})` };

  const pool = resolvePoolSol(poolSolReserve, cfg);
  const sized = mirrorPositionSize(cfg, { whaleSpendSol, balanceSol: book.balanceSol, poolSol: pool.reserveSol });
  if (!sized.ok) return { ok: false, reason: sized.reason };
  const size = sized.sizeSol;

  // Impact is computed on the CAPPED size, which is the size that actually
  // crosses the pool. Charging it on what was requested would bill a 500 SOL
  // order for a 500 SOL market move it was never allowed to make.
  const impactPct = pool.active ? priceImpactPct(size, pool.reserveSol) : null;

  // Slippage raises the effective entry price. Modelled on the PRICE rather
  // than skimmed off the size, so the position's whole P&L curve carries it —
  // taking it off the size instead would make a 1.5% cost vanish the moment
  // the token moved. Pool impact rides the same lever, for the same reason.
  const fillPriceUsd = entryFillUsd(priceUsd, { impactPct: impactPct ?? 0, slippagePct: cfg.slippagePct });

  book.balanceSol -= size + cfg.feeSol;
  book.positions[mint] = {
    mint,
    symbol,
    openedAt: now,
    entryPriceUsd: fillPriceUsd,
    // MARKED AT MID, NOT AT THE FILL. A position is worth what it can be sold
    // for, and that is the mid less the spread — never the price just paid to
    // cross it. Marking at the fill made a freshly opened book report full
    // equity and then quietly lose the slippage on the next tick, which reads
    // as the market moving against you rather than as a cost you already paid.
    // Six 1-SOL entries at 1.5% overstated equity by 0.09 SOL that way.
    markPriceUsd: priceUsd,
    peakPriceUsd: priceUsd,
    // Remaining exposure, in SOL of cost basis. Take-profit rungs reduce this.
    stakeSol: size,
    initialStakeSol: size,
    realisedSol: 0,
    firedRungs: [],
    // The wallet whose buy opened this. Only its sells close it — see
    // exitMatchesOrigin. Falls back to `source`, which already carried the
    // address before this field existed, so positions written by an older
    // build stay matchable rather than becoming unexitable.
    originatingWhale: originatingWhale ?? source ?? null,
    // ── Sub-wallets ──────────────────────────────────────────────────────
    // Split at OPEN, so every sub-wallet shares one entry price. Splitting at
    // exit instead would be a different strategy wearing the same name: the
    // sub-wallets are meant to differ only in when they leave, and giving them
    // separate entries would contaminate that comparison with an entry spread
    // nobody chose. cfg.subWallets of 0 keeps the single-position behaviour
    // that every measurement so far was taken under.
    ...(cfg.subWallets > 0
      ? (() => {
          const { profiles } = resolveSubWallets(cfg.subWallets);
          const split = partitionSizeSol(size, profiles.length);
          return split.ok
            ? { subs: createSubPositions({ parts: split.parts, profiles, entryPriceUsd: fillPriceUsd, now }) }
            : // Too small to divide above a lamport: held whole rather than
              // dropped, since a position that cannot split is still a position.
              { subs: null, subSplitSkipped: split.reason };
        })()
      : {}),
    source,
    // Tagged so the scorecard can disclose that a number includes trades that
    // were never mirrored from the target.
    ...(demo ? { demo: true } : {}),
    // ── What the pool cost this entry ─────────────────────────────────────
    // Recorded on the position rather than only returned, because the exit
    // happens on a different tick and the scorecard has to be able to say what
    // the round trip paid in depth without replaying the book.
    entryPoolSol: pool.reserveSol,
    entryPoolMeasured: pool.measured,
    entryImpactPct: impactPct,
    entryImpactSol: size * ((impactPct ?? 0) / 100),
    ...(sized.liquidityCapped ? { liquidityCappedEntries: 1, requestedSol: sized.requestedSol } : {}),
    lastPricedAt: now,
  };
  return {
    ok: true,
    position: book.positions[mint],
    sizeSol: size,
    basis: sized.basis,
    capped: sized.capped,
    impactPct,
    poolSol: pool.reserveSol,
    poolMeasured: pool.measured,
    liquidityCapped: sized.liquidityCapped === true,
    requestedSol: sized.requestedSol,
    maxPoolTradeSol: sized.maxPoolTradeSol,
  };
}

/**
 * Which exits a position has earned at this price. PURE, and the whole
 * decision surface of the engine.
 *
 * Order matters: take-profit rungs are evaluated before stops so a candle that
 * cleared +100% and then retraced still books the rung it reached. Evaluating
 * stops first would let a spike that triggered both exit entirely at the stop,
 * which is the pessimistic reading of a bar this engine has no intrabar data
 * to resolve. Neither is provably right without tick data; taking profit first
 * is the one that matches how the ladder is described.
 */
export function evaluatePaperExits(position, priceUsd, cfg) {
  const exits = [];
  // PURE MIRROR: the book holds until the target sells, and takes no view of
  // its own. Returning early rather than zeroing the thresholds keeps the
  // distinction honest — a +100% rung that never fires and no rung at all are
  // different configurations, and only one of them is what was asked for.
  //
  // WHAT THIS GIVES UP, stated plainly because it is the entire trade: the
  // stop-loss is the only thing that bounded a position's downside, and a whale
  // that abandons a rug without selling never produces the exit that would have
  // closed it. The book then rides that position to zero, which a -40% hard
  // stop would have cut. Copying someone completely means copying their losses
  // completely.
  if (cfg?.pureMirror) return exits;
  if (!position || !Number.isFinite(priceUsd) || priceUsd <= 0) return exits;

  const entry = position.entryPriceUsd;
  if (!Number.isFinite(entry) || entry <= 0) return exits;

  const gainPct = ((priceUsd - entry) / entry) * 100;
  const peak = Math.max(position.peakPriceUsd ?? entry, priceUsd);
  const fromPeakPct = ((priceUsd - peak) / peak) * 100;

  for (const [i, rung] of (cfg.takeProfit ?? []).entries()) {
    const id = `TP${i + 1}`;
    if (position.firedRungs?.includes(id)) continue;
    if (gainPct >= rung.gainPct) {
      exits.push({ trigger: id, sellFraction: rung.sellFraction, gainPct, label: `take-profit +${rung.gainPct}%` });
    }
  }

  // A trailing stop only means something once the position has been in profit;
  // armed from entry it is just a wider hard stop wearing a better name, and
  // it would close every position that dipped on entry.
  const armed = peak > entry;
  if (armed && fromPeakPct <= -cfg.trailingStopPct) {
    exits.push({
      trigger: 'TRAILING_STOP',
      sellFraction: 1,
      gainPct,
      label: `trailing stop ${cfg.trailingStopPct}% off peak`,
    });
  }

  if (gainPct <= -cfg.hardStopPct) {
    exits.push({ trigger: 'HARD_STOP', sellFraction: 1, gainPct, label: `hard stop -${cfg.hardStopPct}%` });
  }

  return exits;
}

/**
 * Sell a fraction of a position at a price. PURE.
 *
 * Proceeds are computed from the CURRENT stake, so a 50% rung after an earlier
 * 50% rung sells half of what is left rather than half of the original — the
 * behaviour "sell half, let the rest run" describes, and the one that cannot
 * sell more than 100% of a position across a ladder.
 */
export function applyPaperExit(book, mint, { priceUsd, trigger, sellFraction = 1, cfg, now = Date.now(), label = null, poolSolReserve }) {
  const p = book.positions[mint];
  if (!p) return { ok: false, reason: 'no such position' };
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { ok: false, reason: 'no usable price' };

  const fraction = Math.min(1, Math.max(0, sellFraction));
  const costBasisSold = p.stakeSol * fraction;

  // ── SIZED AT THE MID, THEN CHARGED ────────────────────────────────────────
  // Impact depends on how much SOL is coming out, and how much comes out
  // depends on impact. Broken by measuring the order against what the MID would
  // have paid, which is the size of the position being pushed through the pool
  // regardless of what it fetches. Iterating to a fixed point would move the
  // answer by impact² — 0.2% of the fill at a 5% impact, against a pool figure
  // that is itself a tick old.
  const pool = resolvePoolSol(poolSolReserve, cfg);
  const midProceedsSol = p.entryPriceUsd > 0 ? costBasisSold * (priceUsd / p.entryPriceUsd) : costBasisSold;
  const impactPct = pool.active ? priceImpactPct(midProceedsSol, pool.reserveSol) : null;

  const exitPriceUsd = exitFillUsd(priceUsd, { impactPct: impactPct ?? 0, slippagePct: cfg.slippagePct });
  const multiple = exitPriceUsd / p.entryPriceUsd;
  const proceeds = costBasisSold * multiple;
  const impactSol = midProceedsSol * ((impactPct ?? 0) / 100);

  book.balanceSol += proceeds - cfg.feeSol;
  p.stakeSol -= costBasisSold;
  p.realisedSol += proceeds - costBasisSold - cfg.feeSol;
  if (trigger?.startsWith('TP')) p.firedRungs.push(trigger);
  p.markPriceUsd = priceUsd;
  p.lastPricedAt = now;
  p.exitImpactSol = (p.exitImpactSol ?? 0) + impactSol;

  const fullyClosed = p.stakeSol <= 1e-9 || fraction >= 1;
  if (fullyClosed) {
    const pnlSol = p.realisedSol;
    book.closed.push({
      mint,
      symbol: p.symbol,
      openedAt: p.openedAt,
      closedAt: now,
      entryPriceUsd: p.entryPriceUsd,
      exitPriceUsd,
      stakeSol: p.initialStakeSol,
      pnlSol,
      pnlPct: p.initialStakeSol > 0 ? (pnlSol / p.initialStakeSol) * 100 : 0,
      reason: trigger,
      label,
      source: p.source,
      ...(p.demo ? { demo: true } : {}),
      // The depth bill for the whole round trip, so a closed row can answer
      // "how much of this result was the pool" without the position it came
      // from — which no longer exists by the time anyone asks.
      entryImpactSol: p.entryImpactSol ?? 0,
      exitImpactSol: p.exitImpactSol ?? 0,
      exitImpactPct: impactPct,
      exitPoolSol: pool.reserveSol,
      exitPoolMeasured: pool.measured,
      liquidityCappedEntries: p.liquidityCappedEntries ?? 0,
    });
    delete book.positions[mint];
  }
  return {
    ok: true,
    proceedsSol: proceeds,
    closed: fullyClosed,
    trigger,
    impactPct,
    impactSol,
    poolSol: pool.reserveSol,
    poolMeasured: pool.measured,
  };
}

/**
 * Sell a fraction of ONE sub-wallet's share. PURE.
 *
 * The same arithmetic as applyPaperExit, applied to a sub-position instead of
 * the whole. Kept as its own function rather than a flag on that one because
 * the closing behaviour genuinely differs: a sub-wallet reaching zero does NOT
 * close the position, since the other sub-wallets are still holding. The
 * position closes when the last of them does.
 *
 * Each sub keeps its own firedRungs, so the scalper booking its +50% cannot
 * advance the mid-runner's ladder — which is the whole reason they are separate
 * accounts rather than one position with three rules.
 */
export function applySubWalletExit(book, mint, subId, { priceUsd, trigger, sellFraction = 1, cfg, now = Date.now(), label = null, poolSolReserve }) {
  const p = book.positions[mint];
  const sub = p?.subs?.find((s) => s.subId === subId);
  if (!p || !sub) return { ok: false, reason: 'no such sub-position' };
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { ok: false, reason: 'no usable price' };
  if (!(sub.stakeSol > 0)) return { ok: false, reason: 'already closed' };

  const fraction = Math.min(1, Math.max(0, sellFraction));
  const costBasisSold = sub.stakeSol * fraction;

  // Impact is charged on THIS SUB'S share, which is the whole point of the
  // split: three sub-wallets leaving separately each cross a third of the pool
  // depth one combined exit would have, and the shallower each order is the
  // less it pays. Billing the parent's size on every sub would erase the only
  // mechanical advantage splitting has.
  const pool = resolvePoolSol(poolSolReserve, cfg);
  const midProceedsSol = sub.entryPriceUsd > 0 ? costBasisSold * (priceUsd / sub.entryPriceUsd) : costBasisSold;
  const impactPct = pool.active ? priceImpactPct(midProceedsSol, pool.reserveSol) : null;
  const exitPriceUsd = exitFillUsd(priceUsd, { impactPct: impactPct ?? 0, slippagePct: cfg.slippagePct });
  const proceeds = costBasisSold * (exitPriceUsd / sub.entryPriceUsd);

  book.balanceSol += proceeds - cfg.feeSol;
  p.exitImpactSol = (p.exitImpactSol ?? 0) + midProceedsSol * ((impactPct ?? 0) / 100);
  sub.stakeSol -= costBasisSold;
  sub.realisedSol += proceeds - costBasisSold - cfg.feeSol;
  if (trigger?.startsWith('TP')) sub.firedRungs.push(trigger);

  // The parent aggregates its children; it is not an independent balance.
  p.stakeSol = p.subs.reduce((a, s) => a + s.stakeSol, 0);
  p.realisedSol = p.subs.reduce((a, s) => a + s.realisedSol, 0);
  p.markPriceUsd = priceUsd;
  p.lastPricedAt = now;

  const subClosed = sub.stakeSol <= 1e-9 || fraction >= 1;
  if (subClosed) {
    sub.stakeSol = 0;
    sub.closed = true;
    sub.closedAt = now;
    sub.exitTrigger = trigger;
  }

  const allClosed = p.subs.every((s) => s.closed || s.stakeSol <= 1e-9);
  if (allClosed) {
    book.closed.push({
      mint,
      symbol: p.symbol,
      openedAt: p.openedAt,
      closedAt: now,
      entryPriceUsd: p.entryPriceUsd,
      exitPriceUsd,
      stakeSol: p.initialStakeSol,
      pnlSol: p.realisedSol,
      pnlPct: p.initialStakeSol > 0 ? (p.realisedSol / p.initialStakeSol) * 100 : 0,
      // Recorded per sub-wallet: a blended reason would hide that the scalper
      // took +50% while the moonshot rode the same token to a target sell,
      // which is precisely what the split exists to compare.
      reason: trigger,
      subOutcomes: p.subs.map((s) => ({
        subId: s.subId, profile: s.profile, realisedSol: s.realisedSol,
        pnlPct: s.initialStakeSol > 0 ? (s.realisedSol / s.initialStakeSol) * 100 : 0,
        exitTrigger: s.exitTrigger ?? trigger,
      })),
      label,
      source: p.source,
      ...(p.demo ? { demo: true } : {}),
      entryImpactSol: p.entryImpactSol ?? 0,
      exitImpactSol: p.exitImpactSol ?? 0,
      exitImpactPct: impactPct,
      exitPoolSol: pool.reserveSol,
      exitPoolMeasured: pool.measured,
      liquidityCappedEntries: p.liquidityCappedEntries ?? 0,
    });
    delete book.positions[mint];
  }
  return {
    ok: true,
    proceedsSol: proceeds,
    subClosed,
    positionClosed: allClosed,
    trigger,
    subId,
    impactPct,
    poolSol: pool.reserveSol,
    poolMeasured: pool.measured,
  };
}

/** Mark a position to market and roll its peak. PURE. */
export function markPosition(position, priceUsd, now = Date.now()) {
  if (!position || !Number.isFinite(priceUsd) || priceUsd <= 0) return position;
  position.markPriceUsd = priceUsd;
  position.peakPriceUsd = Math.max(position.peakPriceUsd ?? priceUsd, priceUsd);
  position.lastPricedAt = now;
  return position;
}

/**
 * The scorecard. PURE.
 *
 * WIN RATE COUNTS CLOSED POSITIONS ONLY. An open position is neither a win nor
 * a loss, and counting unrealised gains as wins is how a paper book reports 90%
 * while holding a book of tokens it has not sold — the same reasoning
 * computeOnChainWinRate applies to closed round trips.
 *
 * equitySol adds open positions at their MARK, so it is the honest total. It is
 * reported beside balanceSol rather than instead of it, because the difference
 * between the two is exactly the amount that is not yet real.
 */
export function paperScorecard(book, cfg = PAPER_DEFAULTS) {
  const positions = Object.values(book?.positions ?? {});
  const closed = book?.closed ?? [];

  const openValueSol = positions.reduce((sum, p) => {
    const mult = Number.isFinite(p.markPriceUsd) && p.entryPriceUsd > 0 ? p.markPriceUsd / p.entryPriceUsd : 1;
    return sum + p.stakeSol * mult;
  }, 0);

  const wins = closed.filter((c) => c.pnlSol > 0);
  const realisedPnlSol = closed.reduce((s, c) => s + c.pnlSol, 0);
  const unrealisedPnlSol = positions.reduce((sum, p) => {
    const mult = Number.isFinite(p.markPriceUsd) && p.entryPriceUsd > 0 ? p.markPriceUsd / p.entryPriceUsd : 1;
    return sum + (p.stakeSol * mult - p.stakeSol) + p.realisedSol;
  }, 0);

  const budget = book?.budgetSol ?? cfg.budgetSol;
  const equitySol = (book?.balanceSol ?? 0) + openValueSol;

  return {
    budgetSol: budget,
    balanceSol: book?.balanceSol ?? 0,
    openValueSol,
    equitySol,
    activePositions: positions.length,
    closedPositions: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    // null, not 0, before anything has closed. A 0% win rate and "nothing has
    // resolved yet" are different claims and only one of them is bad news.
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
    realisedPnlSol,
    unrealisedPnlSol,
    totalPnlSol: equitySol - budget,
    totalPnlPct: budget > 0 ? ((equitySol - budget) / budget) * 100 : 0,
    target: book?.target ?? null,
    // Carried through so the renderer can separate a trading result from a SOL
    // price move. Null unless the book was opened with a USD budget.
    budgetUsdAtStart: book?.budgetUsdAtStart ?? null,
    solUsdAtStart: book?.solUsdAtStart ?? null,
    // Demo trades are counted so the dashboard can say the numbers include
    // positions that were never mirrored from the target. Without this a demo
    // silently contaminates the win rate the book exists to report.
    demoPositions: positions.filter((p) => p.demo === true).length,
    demoClosed: closed.filter((c) => c.demo === true).length,
    // ── WHAT THE POOLS TOOK ───────────────────────────────────────────────
    // Reported next to the P&L rather than buried in the book, because it is
    // the difference between this scorecard and the one that assumed infinite
    // depth — and on a thin-pool population it is not a rounding line. Summed
    // over open positions AND closed rows so a running book discloses the drag
    // it has already paid, not only the part that has resolved.
    liquidityModel: cfg?.liquidityModel !== false,
    poolCapPct: cfg?.poolCapPct ?? PAPER_DEFAULTS.poolCapPct,
    impactPaidSol:
      positions.reduce((a, p) => a + (p.entryImpactSol ?? 0) + (p.exitImpactSol ?? 0), 0) +
      closed.reduce((a, c) => a + (c.entryImpactSol ?? 0) + (c.exitImpactSol ?? 0), 0),
    liquidityCappedTrades:
      positions.filter((p) => (p.liquidityCappedEntries ?? 0) > 0).length +
      closed.filter((c) => (c.liquidityCappedEntries ?? 0) > 0).length,
    // Fills priced against poolFloorSol rather than a pool anyone read — entries
    // and exits both, which is why it is not called flooredEntries. A high count
    // means the scorecard is measuring an assumption, not a market.
    flooredFills:
      positions.filter((p) => p.entryPoolMeasured === false).length +
      closed.filter((c) => c.exitPoolMeasured === false).length,
  };
}

const sol = (n) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(3)}`;

/** USD, with a sign and thousands separators. PURE. */
export function usd(n, { sign = true } = {}) {
  if (!Number.isFinite(n)) return '$?';
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!sign) return `$${body}`;
  return `${n < 0 ? '-' : '+'}$${body}`;
}

/**
 * Live SOL/USD, from the same pair feed the scanner prices everything else on.
 *
 * Returns null rather than a guess when it cannot be read. Every USD figure
 * downstream is derived from this one number, so a fallback constant would
 * silently mis-state the entire dashboard — a wrong price is worse than a
 * dashboard that says it could not price itself.
 */
export async function fetchSolUsd({ batchFetcher = fetchPairsBatch } = {}) {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  try {
    const byAddress = await batchFetcher([SOL_MINT]);
    const price = Number(byAddress?.get?.(SOL_MINT.toLowerCase())?.priceUsd);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Render the scorecard in USD. PURE.
 *
 * ── THE BOOK IS KEPT IN SOL AND CONVERTED ONLY HERE, ON PURPOSE ────────────
 * Positions are opened, sized and exited in SOL, and the closed-trade history
 * is SOL. Storing USD instead would freeze each trade at the SOL price of the
 * moment it happened and make the running total un-recomputable; storing both
 * would let them drift apart. One source of truth, converted at the edge.
 *
 * ── WHICH MEANS "TOTAL PnL" IN USD IS A TRADING RESULT PRICED TODAY ────────
 * It is `SOL P&L x today's spot`, NOT the dollars that would have landed in an
 * account. Those differ whenever SOL moved between a trade and now, and on a
 * memecoin book the trades are days apart. The distinction is reported rather
 * than smoothed over: when a starting USD budget was set, the drift line shows
 * how much of the USD change is the SOL price rather than the strategy.
 */
/**
 * One line stating how the engine is configured. PURE.
 *
 * ── EVERY MODE IS NAMED, INCLUDING THE OFF ONES ─────────────────────────────
 * The previous behaviour printed a compounding line only when compounding was
 * ON, and the tracking line once at socket setup — which the --watch redraw
 * then wiped. Both add up to the same defect: a dashboard where "off" and
 * "not rendered" look identical, so the only way to know what the engine is
 * doing is to remember what you typed. Every mode is stated on every frame,
 * whichever way it is set.
 */
export function renderModeLine(cfg = {}, { trackedWhales = null, compound = null } = {}) {
  const whales =
    trackedWhales === null || trackedWhales === undefined
      ? 'whales n/a'
      : `${trackedWhales} whale${trackedWhales === 1 ? '' : 's'}`;

  // pureMirror is the exit policy: ON means only the target's sells close a
  // position and the book takes no take-profit or stop of its own.
  const mirror = cfg.pureMirror ? 'pure mirror ON' : 'pure mirror OFF (ladders + stops active)';

  const compounding = !cfg.autoCompound
    ? 'compounding OFF'
    : compound?.active
      ? `compounding ON (${compound.multiple.toFixed(2)}x → ${compound.effectivePctWhale}% of whale)`
      : 'compounding ON (no baseline yet)';

  const sizing = cfg.pctWhale ? `${cfg.pctWhale}% of whale` : `${cfg.perTradeSol} SOL flat`;
  const subs = cfg.subWallets > 0 ? ` · ${cfg.subWallets} sub-wallets` : '';

  return `  MODE   ${whales} · ${mirror} · ${compounding}\n  SIZING ${sizing}${subs} · max ${cfg.maxOpenPositions} open`;
}

/**
 * What the pool did to one trade, for the activity log. PURE.
 *
 * Returns '' when there is nothing to say, so a line about a fill that crossed
 * a deep pool at no measurable cost is not padded with a zero.
 *
 * ── THE CAP IS STATED WITH BOTH NUMBERS ────────────────────────────────────
 * `[LIQUIDITY CAPPED]` alone says a trade was held back but not from what to
 * what, and the gap is the whole point: 500 SOL cut to 1.5 is a different event
 * from 1.6 cut to 1.5, and in a fixed-height log they would otherwise read the
 * same. An impact figure derived from the assumed floor says so in the same
 * breath — it is a property of the model, not of the market.
 */
export function liquidityTag(row = {}) {
  const parts = [];
  if (Number.isFinite(row.impactPct)) {
    parts.push(`impact ${row.impactPct.toFixed(2)}%${row.poolMeasured === false ? ' (assumed pool)' : ''}`);
  }
  if (row.liquidityCapped) {
    const from = Number.isFinite(row.requestedSol) ? row.requestedSol.toFixed(4) : '?';
    const to = Number.isFinite(row.sizeSol) ? row.sizeSol.toFixed(4) : '?';
    const pool = Number.isFinite(row.poolSol) ? ` — ${row.poolSol.toFixed(1)} SOL pool` : '';
    parts.push(`[LIQUIDITY CAPPED ${from} → ${to} SOL${pool}]`);
  }
  return parts.length ? `  ${parts.join('  ')}` : '';
}

export function renderScorecard(card, { title = 'PAPER COPYTRADE SCORECARD', solUsd = null, width = 64 } = {}) {
  const bar = '═'.repeat(Math.max(8, width));
  if (!Number.isFinite(solUsd) || solUsd <= 0) {
    // Never silently fall back to SOL-only under a USD heading, and never
    // invent a rate. The dashboard says which number it is missing.
    return [
      bar,
      `  ${title}`,
      bar,
      '  SOL/USD unavailable — cannot price this book in USD right now.',
      `  Equity ${card.equitySol.toFixed(3)} SOL · balance ${card.balanceSol.toFixed(3)} SOL · ` +
        `${card.activePositions} open · ${card.closedPositions} closed`,
      bar,
    ].join('\n');
  }

  const toUsd = (s) => s * solUsd;
  const pnlUsd = toUsd(card.totalPnlSol);
  const arrow = card.totalPnlSol > 0 ? '▲' : card.totalPnlSol < 0 ? '▼' : '·';

  const lines = [
    bar,
    `  ${title}`,
    bar,
    `  Target         ${card.target?.label ?? card.target?.address?.slice(0, 20) ?? '(none selected)'}`,
    `  SOL spot       ${usd(solUsd, { sign: false })}`,
    ...(card.modeLine ? [card.modeLine] : []),
    '',
    `  Virtual budget ${usd(toUsd(card.budgetSol), { sign: false }).padStart(14)}   (${card.budgetSol.toFixed(3)} SOL)`,
    `  Balance free   ${usd(toUsd(card.balanceSol), { sign: false }).padStart(14)}   (${card.balanceSol.toFixed(3)} SOL)`,
    `  Open positions ${String(card.activePositions).padStart(14)}   marked ${usd(toUsd(card.openValueSol), { sign: false })}`,
    `  Equity         ${usd(toUsd(card.equitySol), { sign: false }).padStart(14)}   (${card.equitySol.toFixed(3)} SOL)`,
    '',
    `  Closed trades  ${String(card.closedPositions).padStart(14)}   ${card.wins}W / ${card.losses}L`,
    `  Win rate       ${(card.winRatePct === null ? 'n/a' : `${card.winRatePct.toFixed(1)}%`).padStart(14)}   ${
      card.winRatePct === null ? 'nothing closed yet' : 'of closed positions only'
    }`,
    `  Realised PnL   ${usd(toUsd(card.realisedPnlSol)).padStart(14)}   (${sol(card.realisedPnlSol)} SOL)`,
    `  TOTAL PnL   ${arrow}  ${usd(pnlUsd).padStart(14)}   ${card.totalPnlPct >= 0 ? '+' : ''}${card.totalPnlPct.toFixed(2)}%`,
  ];

  // Only when a USD starting balance was actually set. Computing it against a
  // budget that was always denominated in SOL would invent a comparison the
  // operator never asked for.
  if (Number.isFinite(card.budgetUsdAtStart) && Number.isFinite(card.solUsdAtStart) && card.solUsdAtStart > 0) {
    const equityUsdNow = toUsd(card.equitySol);
    const vsStart = equityUsdNow - card.budgetUsdAtStart;
    const solDrift = card.budgetSol * (solUsd - card.solUsdAtStart);
    lines.push(
      '',
      `  vs start USD   ${usd(vsStart).padStart(14)}   started ${usd(card.budgetUsdAtStart, { sign: false })} @ ${usd(card.solUsdAtStart, { sign: false })}/SOL`,
      `    of which SOL price movement: ${usd(solDrift)} — not the strategy`
    );
  }

  if (card.liquidityModel && (card.impactPaidSol > 0 || card.liquidityCappedTrades || card.flooredFills)) {
    lines.push(
      '',
      `  Pool impact    ${usd(toUsd(-(card.impactPaidSol ?? 0))).padStart(14)}   (${sol(-(card.impactPaidSol ?? 0))} SOL paid to depth)` +
        (card.liquidityCappedTrades ? `\n    ${card.liquidityCappedTrades} trade(s) [LIQUIDITY CAPPED] at ${card.poolCapPct}% of pool` : '') +
        // Named separately from the capped count because they are different
        // problems: a capped trade was measured and held back, a floored one was
        // never measured at all and its cost is an assumption.
        (card.flooredFills ? `\n    ${card.flooredFills} fill(s) priced against the ASSUMED pool floor, not a real pool` : '')
    );
  }

  if (card.demoPositions || card.demoClosed) {
    lines.push(
      '',
      `  ⚠ includes ${card.demoPositions} open and ${card.demoClosed} closed DEMO trade(s) — not mirrored from the target.`
    );
  }

  lines.push(bar, '  Virtual only — nothing here was bought, sold or signed.');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Target selection
 * ------------------------------------------------------------------ */

/**
 * The active #1 whale. PURE.
 *
 * A MANUALLY PINNED TARGET WINS. Once an operator has approved a switch, the
 * book follows that wallet until another switch is approved — it does not
 * silently re-point itself the next time auto_top_whales rewrites the file.
 * Without this the approval flow would be theatre: the watchlist is regenerated
 * every two hours and would quietly override every decision made in Telegram.
 *
 * The pin is dropped only when the wallet leaves the watchlist entirely, since
 * following a wallet that no longer qualifies is worse than re-pointing.
 */
export function resolveTarget(watchlist, book = null) {
  const wallets = (watchlist?.wallets ?? []).filter((w) => w?.address && w.enabled !== false);
  if (!wallets.length) return { target: null, reason: 'watchlist is empty' };

  const pinned = book?.target?.address;
  if (pinned) {
    const still = wallets.find((w) => w.address === pinned);
    if (still) {
      return { target: { address: still.address, label: still.label ?? null }, reason: 'operator-approved target', pinned: true };
    }
    return {
      target: { address: wallets[0].address, label: wallets[0].label ?? null },
      reason: `approved target ${pinned.slice(0, 8)}… left the watchlist — following #1`,
      repointed: true,
    };
  }

  return { target: { address: wallets[0].address, label: wallets[0].label ?? null }, reason: 'watchlist #1' };
}

/**
 * Buys by the target wallet that this book has not already mirrored. PURE.
 *
 * Bounded by age: an entry recorded six hours ago is history. Copying it now
 * buys a different token at a different price than the whale did, which is not
 * a copy of anything.
 */
export function pendingMirrorBuys(observations, { target, book, cfg, now = Date.now() }) {
  if (!target?.address) return [];
  const entry = observations?.wallets?.[target.address];
  if (!entry?.buys?.length) return [];

  const cutoff = now - cfg.maxBuyAgeMinutes * 60_000;
  // Same rule as the chain path: a held mint is skipped unless scaling in, and
  // a closed one only when re-entry is off.
  const seen = new Set([
    ...(cfg.scaleIn ? [] : Object.keys(book.positions ?? {})),
    ...(cfg.reEnter ? [] : (book.closed ?? []).map((c) => c.mint)),
  ]);

  const out = [];
  for (const b of entry.buys) {
    if (!b?.token || typeof b.ts !== 'number' || b.ts < cutoff) continue;
    if (seen.has(b.token)) continue;
    seen.add(b.token);
    out.push({
      mint: b.token,
      symbol: b.symbol ?? null,
      observedAt: b.ts,
      // What the whale actually put in, for proportional sizing. Null on the
      // ~9% of ledger rows where spend could not be attributed; mirrorPositionSize
      // falls back to the flat size rather than skipping those.
      whaleSpendSol: Number.isFinite(b.solSpent) && b.solSpent > 0 ? b.solSpent : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Live on-chain mirror — free public RPC
 * ------------------------------------------------------------------ *
 *
 * Reads the target's OWN transactions instead of waiting for Aegis to audit a
 * token the target happened to buy. That closes most of the latency this
 * module's header describes, and it costs ZERO Helius credits: standard
 * JSON-RPC, no key, against api.mainnet-beta.solana.com.
 *
 * ── WHY THIS IS STRICTLY BETTER THAN THE LEDGER PATH, AND WHAT IT COSTS ────
 * The ledger only ever contained the whale's buys on tokens that reached an
 * audit, among the first buyerMaxTxLookups (12) buyers, at scan cadence. This
 * sees EVERY transaction the wallet signs, seconds after it lands, including
 * the SELLS the ledger never recorded at all.
 *
 * MEASURED 2026-08-12 against the live target over its last 10 signatures:
 *   api.mainnet-beta.solana.com   getSignaturesForAddress   223ms
 *                                 getTransaction             47ms
 *   solana-rpc.publicnode.com     connection failure
 *   solana.drpc.org              HTTP 400 "not available on free plan"
 *   rpc.ankr.com                 HTTP 403 "API key is not allowed"
 * So the Foundation endpoint is the one that works keyless, and the rpcPool
 * note in config.json — which recorded all four as unreachable — is out of date
 * for this one. The other three remain unusable without a key.
 *
 * All ten signatures were under an hour old and eight were clean swaps, four of
 * them completing round trips visible in the same window (bought 9P3hk33M at
 * -1.2378 SOL, sold at +1.0991; bought BwCstN7x at -1.9523, sold at +2.3319).
 * Two were failed transactions, which is why the parser drops meta.err rather
 * than trusting a signature to mean a trade happened.
 */

export const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * How many recent signatures the book remembers for dedupe. Comfortably more
 * than a burst plus a poll window, and small enough that the book stays a file
 * you can read.
 */
export const SEEN_SIGNATURE_LIMIT = 400;

/**
 * Which node the chain mirror polls. PURE.
 *
 * Order: an explicit --rpc, then SOLANA_RPC_URL, then a url set in config, then
 * the keyless public endpoint.
 *
 * ── SOLANA_RPC_URL IS READ FROM .env, NOT ONLY FROM process.env ────────────
 * MEASURED on this machine: process.env.SOLANA_RPC_URL is UNSET while .env
 * carries a 76-character Helius URL. A bare process.env read finds nothing,
 * falls through to the public endpoint, and reports itself as working — the
 * same trap GMGN_API_KEY had. loadEnv's pick() is already "process.env first,
 * .env second", so the caller passes what it resolved.
 *
 * ── THIS SPENDS HELIUS CREDITS, WHICH THE PREVIOUS DEFAULT DID NOT ─────────
 * The chain mirror shipped against the public endpoint precisely so it cost
 * nothing. Pointing it at Helius reverses that, and the polling is continuous:
 * one getSignaturesForAddress per tick plus one getTransaction per new
 * signature. At --watch 5 that is ~720 signature calls an hour before any
 * transaction lookups, against an account this repo has already recorded
 * hitting "max usage reached".
 *
 * WHAT IT BUYS, measured rather than assumed — three calls each, median of:
 *   Helius   getSignaturesForAddress   41ms
 *   public                             59ms
 * So ~18ms per call. Real, but the mirror's latency is dominated by the poll
 * interval, not the node: at --watch 5 the wait for the next tick is roughly a
 * hundred times larger than the difference between these two. Use --rpc or
 * rpcMirror.url to go back to the public node.
 */
export function resolveChainRpc({ explicitUrl = null, envUrl = null, configUrl = null } = {}) {
  for (const candidate of [explicitUrl, envUrl, configUrl]) {
    if (typeof candidate === 'string' && /^https?:\/\//.test(candidate)) return candidate;
  }
  return PUBLIC_SOLANA_RPC;
}
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Minimal JSON-RPC. No key, no provider-specific extensions. */
export async function solanaRpc(url, method, params, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 500));
        continue;
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = await res.json();
      if (body?.error) return { ok: false, error: body.error.message ?? 'rpc error' };
      return { ok: true, result: body?.result ?? null };
    } catch (err) {
      if (attempt < maxRetries && (err.name === 'AbortError' || err.message?.includes('fetch failed'))) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 300));
        continue;
      }
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: 'HTTP 429 (rate limited)' };
}

/**
 * Turn one raw `jsonParsed` transaction into a trade by this wallet. PURE.
 *
 * ── HOW A BUY AND A SELL ARE TOLD APART ────────────────────────────────────
 * From BALANCE DELTAS, not from instruction decoding. Every AMM, aggregator and
 * router has its own instruction layout and they change; a balance delta is the
 * same fact whichever program produced it. The wallet's lamport change comes
 * from pre/postBalances at its account index, and its token change from the
 * pre/postTokenBalances rows it OWNS.
 *
 *   SOL out + token in   -> BUY
 *   SOL in  + token out  -> SELL
 *
 * WSOL is included in the effective SOL delta: it is the SOL side of the swap
 * wearing a token's clothes when trading via DEX aggregators and HFT bots.
 *
 * A transaction touching MORE THAN ONE non-WSOL mint is not attributed. A
 * multi-hop route or a two-token action cannot be split into "the position"
 * from balances alone, and guessing which leg mattered would put the wrong mint
 * in the book.
 *
 * `sellFraction` is what makes a mirrored sell proportional: the whale's own
 * pre-balance is in the payload, so selling 40% of their bag closes 40% of the
 * paper position rather than all of it. Falling back to a full exit when the
 * pre-balance is missing is the safe direction — it closes a position the whale
 * has demonstrably left.
 *
 * The BUY's `solSpent` is |lamport delta| and therefore includes the network
 * fee and any rent for a new token account. It slightly overstates what went
 * into the token, by a fraction of the fee, and is the only spend figure
 * derivable without decoding every instruction.
 */
export function parseWalletSwap(tx, { wallet } = {}) {
  if (!tx || !wallet) return null;
  const meta = tx.meta;
  // A signature is not a trade. Two of the ten sampled were failed
  // transactions, and a failed swap moves nothing.
  if (!meta || meta.err) return null;

  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k?.pubkey));
  const idx = keys.indexOf(wallet);
  if (idx === -1) return null;

  const pre = meta.preBalances?.[idx];
  const post = meta.postBalances?.[idx];
  if (!Number.isFinite(pre) || !Number.isFinite(post)) return null;
  const nativeSolDelta = (post - pre) / 1e9;

  const isWalletOwner = (b) => b?.owner === wallet || keys[b?.accountIndex] === wallet;
  const preWsol = meta.preTokenBalances?.find((b) => isWalletOwner(b) && b.mint === WSOL_MINT)?.uiTokenAmount?.uiAmount ?? 0;
  const postWsol = meta.postTokenBalances?.find((b) => isWalletOwner(b) && b.mint === WSOL_MINT)?.uiTokenAmount?.uiAmount ?? 0;
  const wsolDelta = postWsol - preWsol;
  const solDelta = nativeSolDelta + wsolDelta;

  const owned = (rows) => {
    const m = new Map();
    for (const b of rows ?? []) {
      if (!isWalletOwner(b) || !b?.mint || b.mint === WSOL_MINT) continue;
      m.set(b.mint, Number(b.uiTokenAmount?.uiAmount ?? 0));
    }
    return m;
  };
  const before = owned(meta.preTokenBalances);
  const after = owned(meta.postTokenBalances);

  const moved = [];
  for (const mint of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(mint) ?? 0) - (before.get(mint) ?? 0);
    if (delta !== 0) moved.push({ mint, delta, preAmount: before.get(mint) ?? 0 });
  }
  if (moved.length !== 1) return null;

  const { mint, delta, preAmount } = moved[0];
  const base = {
    signature: tx.transaction?.signatures?.[0] ?? null,
    blockTime: tx.blockTime ? tx.blockTime * 1000 : null,
    // The slot this trade landed in. Additive, and load-bearing for the
    // slot-latency fill model: a fill window is expressed in slots from the
    // target's own, so without this there is nothing to count from.
    slot: Number.isFinite(tx.slot) ? tx.slot : null,
    mint,
    solDelta,
  };

  if (delta > 0 && solDelta < 0) {
    return { ...base, kind: 'BUY', solSpent: Math.abs(solDelta), tokenDelta: delta };
  }
  if (delta < 0 && solDelta > 0) {
    const sold = Math.abs(delta);
    const fraction = preAmount > 0 ? Math.min(1, sold / preAmount) : 1;
    return { ...base, kind: 'SELL', solReceived: solDelta, tokenDelta: delta, sellFraction: fraction };
  }
  // Transfers in or out, airdrops, and anything where SOL and the token moved
  // the same way are not trades.
  return null;
}

/**
 * The price the target actually paid, per token, in USD. PURE.
 *
 * solSpent / tokenDelta is the fill, straight out of the transaction — no
 * DexScreener call, so an entry can be recorded the moment the swap is parsed
 * instead of waiting on a pair lookup.
 *
 * ── IT IS THE WHALE'S FILL, WHICH IS NOT OUR FILL, AND THE GAP IS MEASURED ──
 * MEASURED 2026-08-12 across 8 of this target's buys, comparing the implied
 * fill against DexScreener minutes later:
 *   -8.8%  -8.6%  -10.0%  -9.9%   (0.7-3.4 min later)
 *   -14.2% -19.1%                 (2.8-3.7 min later)
 *   +41.4% +39.4%                 (0.6-2.4 min later)
 * The tight cluster around -9% is the signal: the target's fill sits BELOW the
 * price shortly afterwards, because their own buy moves it and because
 * everything watching them follows. Cya6eW35 shows it inside one position —
 * three fills at 2.69e-5, 1.71e-5 and 1.54e-5.
 *
 * So booking an entry at this number would make the book optimistic by roughly
 * that margin, systematically, on every mirrored trade. copyImpactPct exists to
 * price that in, and defaults to the measured figure rather than to zero.
 *
 * ── AND IT INCLUDES FEES ───────────────────────────────────────────────────
 * solSpent is the lamport delta, so it carries the network fee and any rent for
 * a new token account (~0.002 SOL). On a 0.9 SOL buy that is 0.2% — noise next
 * to the impact above. On a 0.02 SOL buy it is 10%, which is not. Below
 * impliedMinSpendSol the number is refused and the pair lookup is used instead.
 */
export function impliedEntryPriceUsd(trade, { solUsd = null, minSpendSol = 0.05 } = {}) {
  if (trade?.kind !== 'BUY') return null;
  if (!Number.isFinite(solUsd) || solUsd <= 0) return null;
  const spent = trade.solSpent;
  const tokens = trade.tokenDelta;
  if (!Number.isFinite(spent) || spent < minSpendSol) return null;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  const priceUsd = (spent / tokens) * solUsd;
  return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
}

/**
 * The target's most recent signature, whatever it is.
 *
 * Used to anchor a fresh book to NOW. Without it a reset is only half a reset:
 * the book is empty but the cursor is null, so the first poll reads a whole
 * page of history and mirrors trades the target made minutes ago. Those entries
 * are priced at fills that are already stale, and the "fresh" book opens
 * holding positions from a window it did not observe.
 *
 * The newest signature is taken even if that transaction FAILED. It is a
 * bookmark, not a trade: fetchWhaleTrades breaks on a signature match before it
 * checks for an error, so an errored signature anchors exactly as well as a
 * successful one — and skipping it would leave a gap for every trade between it
 * and the next good one.
 */
export async function fetchLatestSignature({ wallet, rpcUrl = PUBLIC_SOLANA_RPC, rpcImpl = solanaRpc } = {}) {
  if (!wallet) return { ok: false, error: 'no target wallet' };
  const res = await rpcImpl(rpcUrl, 'getSignaturesForAddress', [wallet, { limit: 1 }]);
  if (!res.ok) return { ok: false, error: res.error };
  const signature = Array.isArray(res.result) ? (res.result[0]?.signature ?? null) : null;
  // A wallet with no history at all anchors to null, which is correct: there is
  // nothing behind it to skip.
  return { ok: true, signature };
}

/**
 * The price the target actually sold at, per token, in USD. PURE.
 *
 * solReceived / |tokenDelta| out of the sell transaction — the exit twin of
 * impliedEntryPriceUsd, and for the same reasons.
 *
 * ── MEASURED, BECAUSE THE ENTRY FIGURE WAS NOT AND THAT COST A BOOK ────────
 * Live socket, DexScreener sampled 469-499ms after each of the target's sells
 * landed, compared against their own implied fill:
 *   +1.1%   -3.6%   -26.6%   +60.3%        median +1.1%
 * There is NO systematic drag: the price a tick would have used is not
 * reliably below the target's sell. What there is, is enormous variance —
 * a ±30-60% spread on four samples.
 *
 * That variance is the reason to prefer this number. DexScreener is a lagging
 * cross-pool aggregate, so on a thin memecoin the price it reports at an
 * arbitrary tick moment can sit tens of percent from where the token actually
 * traded a moment earlier. Sampling it made every exit a coin flip while
 * entries were exact — an asymmetry that shows up as unexplained P&L rather
 * than as an obvious bug.
 *
 * WHAT IT ASSUMES, stated plainly: that we exit at the target's own price. We
 * would really sell ~700ms later, into a market their sell just moved. The
 * measurement above says that is not systematically worse at this latency, but
 * four samples is thin evidence and the honest reading is "no measurable bias",
 * not "no cost". copyImpactPct applies to entries only; there is deliberately
 * no exit-side penalty invented to sit beside it.
 *
 * solReceived is a lamport delta, so it is NET of the network fee — a fraction
 * of a percent understatement on any real-sized exit, in the conservative
 * direction.
 */
export function impliedExitPriceUsd(trade, { solUsd = null, minReceiveSol = 0.01 } = {}) {
  if (trade?.kind !== 'SELL') return null;
  if (!Number.isFinite(solUsd) || solUsd <= 0) return null;
  const received = trade.solReceived;
  const tokens = Math.abs(trade.tokenDelta ?? 0);
  if (!Number.isFinite(received) || received < minReceiveSol) return null;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  const priceUsd = (received / tokens) * solUsd;
  return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
}

/* ------------------------------------------------------------------ *
 * Slot-latency fills — reconstructing the price we could actually have got
 * ------------------------------------------------------------------ *
 *
 * The book's default entry price is the target's own implied fill, or a
 * DexScreener mid. Both are wrong in the same direction: they price us at a
 * moment we could not have traded in.
 *
 * ── WHY NOT SLOT N+1 ────────────────────────────────────────────────────────
 * Measured in this repo, not assumed. discovery_daemon.mjs has run the same
 * socket since 2026-08-10: ~570ms from `logsSubscribe` notification to a
 * fetchable transaction, and the `confirmed` read back costs a further
 * 396-779ms across 2-3 attempts. Roughly 1.0-1.4 SECONDS before Node has even
 * parsed the trade. A slot is ~400ms, so slot N+1 has already passed while we
 * are still reading, and we have not begun to build, sign or send anything.
 * Pricing a fill at N+1 is not slightly optimistic; it is optimistic by exactly
 * the amount that matters on a token that runs 2x in its first minute.
 *
 * ── WHAT IS MEASURED HERE AND WHAT IS ASSUMED ───────────────────────────────
 * MEASURED: the observation lag above, which puts a hard floor at about N+3.
 * ASSUMED: everything else. N+5 as the expected landing slot and N+10 as the
 * tail are GUESSES, because nobody has measured where our transactions land —
 * this book has never sent one. The band is a stated assumption, and every
 * consumer of it is expected to say so rather than render it as a measurement.
 *
 * ── WHAT THIS STILL CANNOT DO ───────────────────────────────────────────────
 * The reconstructed price is the price of a world in which WE DID NOT TRADE.
 * Had our order been in that slot it would have moved the pool further and
 * displaced someone who really filled. Against the $4,692 pool this book has
 * held, a $1,500 buy is 34.42% impact — we are not a rounding error in these
 * pools. Nor does any of this model fill PROBABILITY: the book still fills
 * 100% of attempts, and real ones die on slippage bounds, expired blockhashes
 * and lost tip auctions. Both gaps are deliberate and documented, not fixed.
 */

/** Solana's target slot time. Used only to render a slot offset as seconds. */
export const SLOT_MS = 400;

/**
 * Rows kept for the WEB activity feed.
 *
 * Deliberately not the terminal's 6. The terminal is fixed-height, so an
 * unbounded log there pushes the numbers off screen; a DOM panel scrolls one
 * pane without moving another, which is one of the few things the web view can
 * do that the terminal structurally cannot. Matches dashboard.mjs's own
 * ACTIVITY_LIMIT so the two ends agree on the ceiling.
 */
export const WEB_ACTIVITY_LIMIT = 500;

/**
 * The fill window, in slots after the target's own trade.
 *
 * `expected` is what the book trades on. The other two are reported beside it
 * as an uncertainty spread — one number to act on, with its error bars visible,
 * rather than three books that invite picking the flattering one.
 */
export const DEFAULT_SLOT_OFFSETS = { earliest: 3, expected: 5, latest: 10 };

/**
 * One transaction -> the price that swap executed at. PURE.
 *
 * The swapper is taken to be the FEE PAYER, which is the first account key.
 * That is true of essentially every retail and bot swap, and it lets this reuse
 * `parseWalletSwap` unchanged rather than growing a second decoder — including
 * its refusal to read a transaction whose token balances moved for more than
 * one mint, which is how routing and arbitrage transactions decline themselves
 * instead of producing a fabricated price.
 *
 * `minSolAbs` exists for the same reason `impliedEntryPriceUsd` has
 * `minSpendSol`: a dust swap divides two tiny numbers and the answer is noise.
 */
export function decodeSwapAtSlot(tx, { mint, solUsd = null, minSolAbs = 0.01, parser = parseWalletSwap } = {}) {
  if (!tx || !mint) return null;
  if (!Number.isFinite(solUsd) || solUsd <= 0) return null;

  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k?.pubkey));
  const feePayer = keys[0];
  if (!feePayer) return null;

  const trade = parser(tx, { wallet: feePayer });
  if (!trade || trade.mint !== mint) return null;

  const solAbs = trade.kind === 'BUY' ? trade.solSpent : trade.solReceived;
  const tokenAbs = Math.abs(trade.tokenDelta ?? 0);
  if (!Number.isFinite(solAbs) || solAbs < minSolAbs) return null;
  if (!Number.isFinite(tokenAbs) || tokenAbs <= 0) return null;

  const priceUsd = (solAbs / tokenAbs) * solUsd;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  return {
    slot: Number.isFinite(tx.slot) ? tx.slot : (trade.slot ?? null),
    signature: trade.signature,
    kind: trade.kind,
    priceUsd,
    solAbs,
    tokenAbs,
    swapper: feePayer,
  };
}

/**
 * The last price on chain at or before a slot. PURE.
 *
 * ── A SLOT USUALLY HAS NO TRADE IN IT ───────────────────────────────────────
 * For any one memecoin, most slots contain no swap at all. "The price at slot
 * N+5" is therefore almost never an observation; it is the last observed trade
 * carried forward. That distinction is reported rather than smoothed over:
 * `exact` says whether a swap actually landed in that slot, and `staleSlots`
 * says how far the carry-forward reached. A price carried 40 slots is a much
 * weaker claim than one carried 1, and only the caller can decide if it is
 * good enough.
 *
 * Returns null when nothing traded at or before the slot — the honest answer,
 * and the caller's cue to fall back rather than invent.
 */
export function reconstructPriceAtSlot(swaps, targetSlot) {
  if (!Array.isArray(swaps) || !swaps.length || !Number.isFinite(targetSlot)) return null;

  let best = null;
  for (const s of swaps) {
    if (!s || !Number.isFinite(s.slot) || !Number.isFinite(s.priceUsd)) continue;
    if (s.slot > targetSlot) continue;
    if (!best || s.slot > best.slot) best = s;
  }
  if (!best) return null;

  return {
    priceUsd: best.priceUsd,
    sourceSlot: best.slot,
    signature: best.signature,
    exact: best.slot === targetSlot,
    staleSlots: targetSlot - best.slot,
  };
}

/**
 * The execution band. PURE.
 *
 * ── "EARLIEST" IS NOT "BEST" AND THE NAMES SAY SO ───────────────────────────
 * The draft called N+3 the best case. It is the earliest reachable slot, which
 * is only the best PRICE if the token rose across the window — and on a token
 * that dumped, the earliest fill is the worst one. So the rungs are named for
 * what they are (slot offsets), and best/worst by price are derived separately
 * and direction-aware: for a BUY the best case is the lowest price, for a SELL
 * the highest.
 */
export function buildExecutionBand({
  swaps = [],
  whaleSlot,
  offsets = DEFAULT_SLOT_OFFSETS,
  side = 'BUY',
  maxObservedSlot = null,
} = {}) {
  if (!Number.isFinite(whaleSlot)) {
    return { reconstructed: false, reason: 'no whale slot', rungs: null, fillPriceUsd: null };
  }

  const rungs = {};
  for (const [name, offset] of Object.entries(offsets)) {
    const at = reconstructPriceAtSlot(swaps, whaleSlot + offset);
    rungs[name] = at ? { slotOffset: offset, slot: whaleSlot + offset, ...at } : { slotOffset: offset, slot: whaleSlot + offset, priceUsd: null };
  }

  const expected = rungs.expected;
  if (!expected || !Number.isFinite(expected.priceUsd)) {
    return {
      reconstructed: false,
      reason: swaps.length ? 'nothing traded at or before the expected slot' : 'no swaps decoded in the window',
      whaleSlot,
      rungs,
      fillPriceUsd: null,
      swapCount: swaps.length,
    };
  }

  const priced = Object.values(rungs).map((r) => r.priceUsd).filter((p) => Number.isFinite(p));
  const lo = Math.min(...priced);
  const hi = Math.max(...priced);
  // A buy wants the low price; a sell wants the high one.
  const bestCaseUsd = side === 'SELL' ? hi : lo;
  const worstCaseUsd = side === 'SELL' ? lo : hi;

  return {
    reconstructed: true,
    whaleSlot,
    side,
    rungs,
    // What the book actually trades on. One number, with the spread beside it.
    fillPriceUsd: expected.priceUsd,
    fillSlot: expected.slot,
    fillSlotOffset: expected.slotOffset,
    fillLagMs: expected.slotOffset * SLOT_MS,
    bestCaseUsd,
    worstCaseUsd,
    spreadPct: lo > 0 ? ((hi - lo) / lo) * 100 : 0,
    swapCount: swaps.length,
    // False when the chain had not yet produced the far end of the window at
    // the moment we looked. The latest rung is then a carry-forward of an
    // earlier slot rather than an observation, and the spread is understated.
    windowComplete: Number.isFinite(maxObservedSlot)
      ? maxObservedSlot >= whaleSlot + (offsets.latest ?? 0)
      : null,
    // The band is an assumption about where our transaction would land. It is
    // carried on the payload so no renderer has to remember to say it.
    assumption: 'landing slot is assumed, not measured — this book has never sent a transaction',
  };
}

/**
 * Real swaps for one mint across the fill window.
 *
 * ── COST, STATED PLAINLY ────────────────────────────────────────────────────
 * One getSignaturesForAddress plus up to `maxLookups` getTransaction calls PER
 * MIRRORED TRADE. That is why `slotFills` is off by default: the existing entry
 * path costs zero extra RPC because the swap carries its own price. This buys
 * a better fill model with credits, and the operator should choose that.
 */
export async function fetchSlotWindowSwaps({
  mint,
  whaleSlot,
  maxOffset = DEFAULT_SLOT_OFFSETS.latest,
  rpcUrl = PUBLIC_SOLANA_RPC,
  rpcImpl = solanaRpc,
  solUsd = null,
  signatureLimit = 100,
  maxLookups = 40,
  delayMs = 60,
  decoder = decodeSwapAtSlot,
} = {}) {
  if (!mint || !Number.isFinite(whaleSlot)) return { ok: false, error: 'no mint or slot', swaps: [] };
  if (!Number.isFinite(solUsd) || solUsd <= 0) return { ok: false, error: 'no SOL price', swaps: [] };

  const sigs = await rpcImpl(rpcUrl, 'getSignaturesForAddress', [mint, { limit: signatureLimit }]);
  if (!sigs.ok) return { ok: false, error: sigs.error, swaps: [] };
  const list = Array.isArray(sigs.result) ? sigs.result : [];

  // How far the chain had got when we asked. Taken from the newest signature on
  // the page rather than a separate getSlot call — one fewer round trip, and it
  // is the same question: is the far end of the window in the past yet.
  const maxObservedSlot = list.reduce((m, s) => (Number.isFinite(s?.slot) && s.slot > m ? s.slot : m), -Infinity);

  const inWindow = list
    .filter((s) => !s?.err && Number.isFinite(s?.slot) && s.slot >= whaleSlot && s.slot <= whaleSlot + maxOffset)
    .sort((a, b) => a.slot - b.slot)
    .slice(0, maxLookups);

  const swaps = [];
  for (const s of inWindow) {
    const tx = await rpcImpl(rpcUrl, 'getTransaction', [
      s.signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
    if (tx.ok && tx.result) {
      const decoded = decoder(tx.result, { mint, solUsd });
      if (decoded) swaps.push(decoded);
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  return {
    ok: true,
    swaps,
    scanned: inWindow.length,
    candidates: list.length,
    maxObservedSlot: Number.isFinite(maxObservedSlot) ? maxObservedSlot : null,
    // Signatures in the window we did not read, because maxLookups bounded us.
    skipped: Math.max(0, list.filter((s) => !s?.err && Number.isFinite(s?.slot) && s.slot >= whaleSlot && s.slot <= whaleSlot + maxOffset).length - inWindow.length),
  };
}

/**
 * Window -> band, in one call. The seam the tick uses.
 *
 * Returns an unreconstructed band rather than throwing or guessing when the
 * chain cannot answer, so the caller's fallback is an ordinary branch.
 */
export async function resolveExecutionBand({
  mint,
  whaleSlot,
  side = 'BUY',
  cfg = PAPER_DEFAULTS,
  solUsd = null,
  rpcUrl,
  fetcher = fetchSlotWindowSwaps,
} = {}) {
  const offsets = cfg?.slotOffsets ?? DEFAULT_SLOT_OFFSETS;
  const res = await fetcher({
    mint,
    whaleSlot,
    maxOffset: offsets.latest,
    rpcUrl: rpcUrl ?? cfg?.rpcMirror?.url ?? PUBLIC_SOLANA_RPC,
    solUsd,
    maxLookups: cfg?.slotFillMaxLookups ?? 40,
  });
  if (!res.ok) {
    return { reconstructed: false, reason: res.error ?? 'window unavailable', rungs: null, fillPriceUsd: null };
  }
  return {
    ...buildExecutionBand({ swaps: res.swaps, whaleSlot, offsets, side, maxObservedSlot: res.maxObservedSlot }),
    scanned: res.scanned,
    skipped: res.skipped,
  };
}

/**
 * The target's recent trades, newest signature first.
 *
 * `sinceSignature` stops the walk as soon as a known signature is seen, so a
 * steady-state poll costs ONE getSignaturesForAddress and nothing else. That is
 * what makes a 5-second cadence affordable on a public endpoint.
 */
export async function fetchWhaleTrades({
  wallet,
  rpcUrl = PUBLIC_SOLANA_RPC,
  sinceSignature = null,
  signatureLimit = 25,
  maxTxLookups = 12,
  delayMs = 120,
  rpcImpl = solanaRpc,
} = {}) {
  if (!wallet) return { ok: false, error: 'no wallet', trades: [], newestSignature: null };

  const sigs = await rpcImpl(rpcUrl, 'getSignaturesForAddress', [wallet, { limit: signatureLimit }]);
  if (!sigs.ok) return { ok: false, error: sigs.error, trades: [], newestSignature: null };
  const list = Array.isArray(sigs.result) ? sigs.result : [];
  if (!list.length) return { ok: true, trades: [], newestSignature: null, scanned: 0 };

  // Everything newer than the last one seen. On a cold start that is the whole
  // page, which is bounded by signatureLimit.
  const fresh = [];
  for (const s of list) {
    if (sinceSignature && s.signature === sinceSignature) break;
    if (s.err) continue;
    fresh.push(s);
  }

  // ── OLDEST FIRST, AND THE CURSOR ONLY MOVES AS FAR AS WE ACTUALLY READ ────
  // Two reasons, and the first was a live bug: taking the NEWEST maxTxLookups
  // and then setting the cursor to the page's newest signature drops everything
  // in between. Observed on a cold start — "12 new tx scanned, 8 queued",
  // then 0 forever, with those 8 never read despite the code claiming they
  // would be caught up. Walking forward from the cursor and advancing only to
  // the last signature actually parsed makes a burst take several ticks instead
  // of losing its tail.
  //
  // Oldest-first is also required for correctness within a batch: a buy and a
  // later sell of the same mint must apply in that order, or the sell arrives
  // before the position exists and is discarded.
  const batch = fresh.slice().reverse().slice(0, maxTxLookups);

  const trades = [];
  let looked = 0;
  for (const s of batch) {
    looked++;
    const tx = await rpcImpl(rpcUrl, 'getTransaction', [
      s.signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
    if (tx.ok && tx.result) {
      const trade = parseWalletSwap(tx.result, { wallet });
      if (trade) trades.push(trade);
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  return {
    ok: true,
    trades,
    // The newest signature PARSED, not the newest that exists. When nothing was
    // fresh the cursor lands on the page head, which is where it already was.
    newestSignature: batch.length ? batch[batch.length - 1].signature : (list[0]?.signature ?? null),
    scanned: looked,
    // Still newer than the cursor and not yet read. These are picked up by the
    // next tick now that the cursor advances incrementally.
    pending: Math.max(0, fresh.length - looked),
  };
}

/* ------------------------------------------------------------------ *
 * WebSocket wallet listener
 * ------------------------------------------------------------------ *
 *
 * A persistent logsSubscribe on the TARGET'S ADDRESS, so a trade is known the
 * moment it is processed rather than whenever the next poll happens to run.
 *
 * ── WHY THIS IS THE BIG WIN, IN THIS BOOK'S OWN NUMBERS ────────────────────
 * The poll path's floor is the tick interval plus confirmation plus a
 * getTransaction plus the per-lookup delay, and it degrades exactly when it
 * matters: a burst hits maxTxLookupsPerTick and drains 12 per tick. Observed
 * live on this target — the dashboard read `updated 20:11:40` with its newest
 * activity at `20:10:50`, fifty seconds behind, while GMGN showed trades 3s
 * old.
 *
 * The socket removes the interval entirely. discovery_daemon.mjs has run this
 * same pattern against pump.fun since 2026-08-10 and its measured figure is
 * 570ms from notification to a fetchable transaction. That is the realistic
 * floor here too, and it is not zero: a Solana slot is ~400ms and a follower
 * cannot see a transaction before it lands.
 *
 * ── SUBSCRIBE AT `processed`, READ AT `confirmed` ──────────────────────────
 * The single most important detail, and discovery_daemon learned it the hard
 * way: a notification at `processed` refers to a transaction that a default
 * read CANNOT SEE YET. Subscribing at `confirmed` would give away most of the
 * latency the socket just bought; fetching at `processed` returns null. So the
 * subscription is `processed` and the lookup is `confirmed` with a short retry,
 * which is why lookupRetries exists rather than being defensive padding.
 *
 * ── IT RESOLVES EAGERLY, NOT ON THE TICK ───────────────────────────────────
 * Transactions are fetched and parsed the instant the notification arrives, and
 * the finished trades sit in a buffer. drain() is therefore a synchronous
 * hand-off with no network in it, so a --watch 1 tick spends no time waiting on
 * RPC. This is what turns the interval into a rendering cadence rather than a
 * detection one.
 *
 * drain() returns the same shape fetchWhaleTrades does, so it drops straight
 * into runPaperTick's tradeFetcher and every existing test still applies.
 */
/* ------------------------------------------------------------------ *
 * `processed` lookup capability
 * ------------------------------------------------------------------ */

/**
 * Whether this endpoint answers getTransaction at `processed`, learned at run
 * time rather than assumed.
 *
 * ── WHY IT IS PROBED AND NOT BELIEVED ───────────────────────────────────────
 * The socket subscribes at `processed` and then reads back at `confirmed`,
 * which costs a measured 396-779ms and 2-3 attempts because the notification
 * outruns the read. Reading at `processed` too would remove that wait.
 *
 * The catch is that the Solana JSON-RPC spec lists `processed` as NOT supported
 * on getTransaction — the account and signature-status methods take it, the
 * transaction and block lookups do not. Providers differ in how they say so:
 * some return an "Invalid param" error, some quietly coerce to `confirmed` and
 * simply never answer early.
 *
 * So it is TRIED. An endpoint that refuses outright is marked on its first
 * answer; one that accepts the parameter and never delivers early is marked
 * after a bounded number of misses. Either way the extra round trip is paid a
 * handful of times and then never again — the fast path cannot become a
 * permanent tax on every resolve, which is the failure mode that would make
 * this a latency REGRESSION rather than an improvement.
 *
 * ── PER SOCKET, DELIBERATELY, NOT PER ENDPOINT ──────────────────────────────
 * Sharing one map across sockets would probe once for five whales instead of
 * five times, and it was written that way first. It is hidden cross-instance
 * state: two sockets on one URL become order-dependent, and so do two tests.
 * The saving is at most a few RPC calls once per process — nothing against
 * correctness that is local and obvious.
 */
function createProcessedProbe() {
  return { supported: null, misses: 0 };
}

/**
 * Does this RPC error mean the endpoint refuses `processed` here? PURE.
 *
 * Matched on the message because JSON-RPC error CODES are not distinctive: the
 * same -32602 covers a malformed signature, and treating that as "processed is
 * unsupported" would disable the fast path on the first typo'd signature.
 */
export function isUnsupportedCommitment(error) {
  const s = String(error ?? '').toLowerCase();
  if (!s) return false;
  return (
    (s.includes('commitment') && (s.includes('not supported') || s.includes('invalid') || s.includes('unsupported'))) ||
    s.includes('processed is not supported')
  );
}

/**
 * One signature -> one parsed trade, or null. Shared by both transports.
 *
 * Factored out rather than copied because the per-wallet socket and the
 * multiplexed feed must read chain IDENTICALLY. Two copies of the commitment
 * ladder is two places for the probe, the retry count and the fast path to
 * drift, and the drift would show up as one transport quietly seeing fewer
 * trades than the other — the exact class of bug this module keeps paying for.
 */
function createResolver({ rpcUrl, rpcImpl, cfg = {}, log = () => {}, probe, stats }) {
  return async (signature, wallet, { fast = true } = {}) => {
    if (fast && probe.supported !== false && cfg.processedFirst !== false) {
      const early = await rpcImpl(rpcUrl, 'getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'processed' },
      ]);
      if (early.ok && early.result) {
        probe.supported = true;
        probe.misses = 0;
        stats.fastResolved++;
        return { ok: true, trade: parseWalletSwap(early.result, { wallet }) };
      }
      if (!early.ok && isUnsupportedCommitment(early.error)) {
        probe.supported = false;
        log(`   getTransaction refuses processed here (${early.error}) — confirmed only from now on`);
      } else if (++probe.misses >= (cfg.processedProbeLimit ?? 8)) {
        probe.supported = false;
        log(`   processed reads never landed early in ${probe.misses} attempts — confirmed only from now on`);
      }
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= (cfg.lookupRetries ?? 4); attempt++) {
      const tx = await rpcImpl(rpcUrl, 'getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      ]);
      if (tx.ok && tx.result) return { ok: true, trade: parseWalletSwap(tx.result, { wallet }) };
      if (!tx.ok) lastErr = tx.error;
      await new Promise((r) => setTimeout(r, cfg.lookupRetryDelayMs ?? 300));
    }
    return { ok: false, error: lastErr ?? 'transaction not found' };
  };
}

export function createWhaleSocket({
  wallet,
  rpcUrl,
  cfg = {},
  log = () => {},
  // ── PUSH INSTEAD OF BUFFER ─────────────────────────────────────────────────
  // Supplied, a resolved trade goes straight to the consumer instead of waiting
  // in `state.buffer` for the next drain. That wait was MEASURED as the single
  // largest term in the copy pipeline: the tick runs every `--watch N` seconds
  // (default 5), so a trade resolved just after one costs a further 0-5000ms
  // for no reason but the loop's shape — a mean of 2500ms against a total
  // budget of about 6000ms.
  //
  // OPTIONAL BY DESIGN. Absent, the buffer behaves exactly as before, which is
  // what paper_copytrade's own --watch path still relies on. This is additive,
  // not a migration.
  onTrade = null,
  WebSocketImpl = globalThis.WebSocket,
  rpcImpl = solanaRpc,
} = {}) {
  const wsUrl = websocketUrlFor(rpcUrl);
  const state = {
    wallet,
    connected: false,
    buffer: [],
    // Signatures the socket saw but could not read yet. Retried on later
    // drains — see the failure path below for why dropping them lost trades.
    pendingRetry: [],
    newestSignature: null,
    stats: { notifications: 0, resolved: 0, failed: 0, recovered: 0, abandoned: 0, reconnects: 0, duplicates: 0, pushed: 0, handlerErrors: 0, fastResolved: 0 },
    lastError: null,
    closed: false,
  };
  const seen = new Set();
  const probe = createProcessedProbe();

  if (!wallet || !wsUrl || typeof WebSocketImpl !== 'function') {
    state.lastError = !wallet ? 'no target wallet' : !wsUrl ? 'no websocket url' : 'no WebSocket implementation';
    return {
      wallet,
      isConnected: () => false,
      status: () => ({ ...state }),
      drain: async () => ({ ok: false, error: state.lastError, trades: [], newestSignature: null }),
      close: () => {},
    };
  }

  const resolveTx = createResolver({ rpcUrl, rpcImpl, cfg, log, probe, stats: state.stats });
  const resolve = async (signature, { fast = true } = {}) => {
    // ── FAST PATH: read at the commitment we were notified at ──────────────
    // A processed read of a signature we were just told about is warm if the
    // endpoint supports it, which removes the retry ladder below entirely.
    //
    // FIRST ATTEMPT ONLY. A signature coming back through pendingRetry is
    // already seconds late, so an early read has nothing left to win there —
    // and probing on every retry would DOUBLE the calls on exactly the
    // signatures that are already failing. Skipped too once the endpoint has
    // been shown not to answer; see createProcessedProbe for why this is
    // probed rather than assumed.
    //
    // The ladder itself lives in createResolver, shared with the multiplexed
    // feed so the two transports cannot read chain differently.
    return resolveTx(signature, wallet, { fast });
  };

  let ws = null;
  let backoff = cfg.reconnectBackoffMs ?? 1_000;

  const connect = () => {
    if (state.closed) return;
    try {
      ws = new WebSocketImpl(wsUrl);
    } catch (err) {
      state.lastError = err.message;
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      state.connected = true;
      state.lastError = null;
      backoff = cfg.reconnectBackoffMs ?? 1_000;
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          // `mentions` matches any transaction the address appears in, which is
          // what a wallet's own trades are. Filtering by program instead would
          // miss every router this wallet uses that we did not enumerate.
          params: [{ mentions: [wallet] }, { commitment: cfg.socketCommitment ?? 'processed' }],
        })
      );
      log(`   socket connected — logsSubscribe on ${wallet.slice(0, 8)}… (${cfg.socketCommitment ?? 'processed'})`);
    };

    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.method !== 'logsNotification') return;

      const value = msg.params?.result?.value;
      const signature = value?.signature;
      if (!signature) return;
      state.stats.notifications++;
      // A failed transaction moved nothing, and two of ten sampled signatures
      // on this wallet were failures.
      if (value.err) return;
      if (seen.has(signature)) { state.stats.duplicates++; return; }
      seen.add(signature);
      if (seen.size > SEEN_SIGNATURE_LIMIT * 2) {
        for (const s of [...seen].slice(0, seen.size - SEEN_SIGNATURE_LIMIT)) seen.delete(s);
      }

      // Resolved HERE, not at drain time, so the tick never waits on RPC.
      const res = await resolve(signature);
      if (!res.ok) {
        state.pendingRetry.push({ signature, attempts: 1 });
        state.stats.failed++;
        return;
      }
      const trade = res.trade;
      if (trade) {
        state.newestSignature = signature;
        state.stats.resolved++;
        log(`   socket ${trade.kind} ${trade.mint.slice(0, 8)}…`);

        if (onTrade) {
          state.stats.pushed++;
          Promise.resolve(onTrade(trade)).catch((err) => {
            state.stats.handlerErrors++;
            log(`   onTrade threw for ${trade.mint.slice(0, 8)}…: ${err?.message ?? err}`);
          });
        } else {
          state.buffer.push(trade);
        }
      }
    };

    ws.onerror = (err) => {
      state.lastError = err?.message ?? 'socket error';
    };
    if (typeof ws.on === 'function') ws.on('error', () => {});
    if (typeof ws.addEventListener === 'function') ws.addEventListener('error', () => {});
    ws.onclose = () => {
      state.connected = false;
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (state.closed) return;
    state.stats.reconnects++;
    const wait = backoff;
    backoff = Math.min(backoff * 2, cfg.maxReconnectBackoffMs ?? 30_000);
    setTimeout(connect, wait).unref?.();
  };

  connect();

  return {
    wallet,
    isConnected: () => state.connected,
    status: () => ({ ...state, buffered: state.buffer.length, processedProbe: { ...probe } }),
    /**
     * Hand over everything resolved since the last call. Oldest first, so a buy
     * and a later sell of one mint apply in order — the same requirement the
     * poll path has.
     */
    drain: async () => {
      // Retry anything the notification path could not read. Cheap — one
      // getTransaction per outstanding signature — and it runs on the tick
      // rather than in the socket handler so it cannot delay a live event.
      if (state.pendingRetry.length) {
        const queue = state.pendingRetry.splice(0, state.pendingRetry.length);
        for (const item of queue) {
          const res = await resolve(item.signature, { fast: false });
          if (res.ok) {
            if (res.trade) {
              state.buffer.push(res.trade);
              state.newestSignature = item.signature;
              state.stats.resolved++;
              state.stats.recovered++;
            }
            continue;
          }
          if (item.attempts + 1 >= (cfg.retryAttempts ?? 5)) {
            // Genuinely unreadable — a signature cannot be retried forever.
            state.stats.abandoned++;
            continue;
          }
          state.pendingRetry.push({ signature: item.signature, attempts: item.attempts + 1 });
        }
      }

      const trades = state.buffer.splice(0, state.buffer.length);
      return {
        ok: state.connected || trades.length > 0,
        error: state.connected ? null : (state.lastError ?? 'socket not connected'),
        trades,
        // The poll cursor is deliberately NOT advanced from here. If the socket
        // drops, the poll fallback must re-read the window the socket was
        // covering rather than skipping it.
        newestSignature: null,
        scanned: trades.length,
        pending: 0,
        source: 'socket',
      };
    },
    close: () => {
      state.closed = true;
      try { ws?.close(); } catch { /* already closing */ }
    },
  };
}

/* ------------------------------------------------------------------ *
 * IO shell
 * ------------------------------------------------------------------ */

export async function loadBook(path = BOOK_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (raw?.version === BOOK_VERSION && raw.positions && raw.closed) return raw;
  } catch {
    /* no book yet */
  }
  return null;
}

export async function saveBook(book, path = BOOK_PATH) {
  await mkdir(dirname(path), { recursive: true });
  // Stamped so a second instance can be detected. See detectConcurrentWriter.
  book.writerPid = process.pid;
  book.writerAt = Date.now();
  await writeFile(path, JSON.stringify(book, null, 2), 'utf8');
}

/**
 * Is another instance writing this book? PURE.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A running --watch holds the book in memory and rewrites it every tick, so
 * anything another process does to the file is silently undone on the next
 * one. That has now produced three separate false diagnoses in this codebase:
 * a --reset that appeared not to work, a fresh book that appeared to replay
 * history, and settings changes that appeared to have no effect — each time
 * because a dashboard started earlier was overwriting the file, and each time
 * it looked like a bug in the engine rather than a second writer.
 *
 * It also keeps whatever module code it started with, so a long-running
 * instance silently ignores every fix made since it launched.
 *
 * A timestamp and a pid are enough: if the book was written by a DIFFERENT
 * process within the staleness window, one is live right now.
 */
export function detectConcurrentWriter(book, { pid = process.pid, now = Date.now(), withinMs = 30_000 } = {}) {
  const writer = book?.writerPid;
  const at = book?.writerAt;
  if (!Number.isFinite(writer) || !Number.isFinite(at)) return null;
  if (writer === pid) return null;
  if (now - at > withinMs) return null;
  return { pid: writer, secondsAgo: (now - at) / 1000 };
}

/**
 * Live USD prices for a set of mints, from the pair feed the scanner uses.
 *
 * ── TWO SHAPE MISMATCHES LIVE HERE AND BOTH SILENTLY RETURN NOTHING ────────
 * fetchPairsBatch returns a MAP, not an array, and it is keyed by the base
 * token address LOWERCASED. Iterating it as an array yields no entries, and
 * looking a mint up in original case misses every Solana address that has a
 * capital letter — which is almost all of them, since base58 is case
 * sensitive and mixed by nature.
 *
 * Neither failure throws. Both just make every price absent, which the caller
 * reports as "no usable price" — indistinguishable from a genuinely dead
 * token, and that is exactly how it presented: 22 of 22 real buys declined
 * against a feed that was answering fine. The keys are therefore mapped back
 * to the ORIGINAL mint strings the caller passed in, so `prices.get(mint)`
 * works with the case the book stores.
 *
 * The batch helper already keeps the deepest-liquidity pair per token, so
 * there is no venue selection to redo here.
 */
/**
 * The top N enabled wallets to track at once. PURE.
 *
 * ── THE APPROVED TARGET IS ALWAYS FIRST, NEVER MERELY INCLUDED ──────────────
 * resolveTarget pins the operator-approved wallet so a re-rank cannot silently
 * repoint the book. Tracking a cluster must not quietly undo that: the pinned
 * wallet leads the list, and the rest fill in behind it. Without this a sync
 * that promoted a new #1 would leave the approved wallet tracked but demoted,
 * and every "which whale is this" readout would name the wrong one.
 */
export function resolveTargets(watchlist, book = null, { limit = 5 } = {}) {
  const enabled = (watchlist?.wallets ?? []).filter((w) => w?.address && w.enabled !== false);
  if (!enabled.length) return { targets: [], primary: null, reason: 'watchlist is empty' };

  const primary = resolveTarget(watchlist, book).target;
  const ordered = primary
    ? [
        ...enabled.filter((w) => w.address === primary.address),
        ...enabled.filter((w) => w.address !== primary.address),
      ]
    : enabled;

  return {
    targets: ordered.slice(0, Math.max(1, limit)).map((w) => ({ address: w.address, label: w.label ?? null })),
    primary,
    reason: `tracking ${Math.min(ordered.length, limit)} of ${enabled.length} enabled`,
  };
}

/**
 * One socket per tracked wallet, drained as a single ordered stream.
 *
 * ── WHY N SOCKETS AND NOT ONE SUBSCRIPTION ──────────────────────────────────
 * logsSubscribe filters on `mentions`, which takes a single address. There is
 * no multi-address form, so tracking five wallets is five subscriptions. They
 * are independent by design: one wallet's socket dying must not blind the other
 * four, which a shared connection would.
 *
 * Trades carry the wallet that made them. Without attribution a merged stream
 * is unusable — the cluster signal cannot tell two whales buying one mint from
 * one whale buying it twice, and those mean opposite things.
 *
 * Drains run CONCURRENTLY and the merged result is sorted by block time, so a
 * slow socket delays only itself. Order matters downstream: the paper engine
 * interleaves buys and sells chronologically, and a batch out of order can
 * close a position before the buy that opened it.
 */
/**
 * Every tracked wallet on ONE WebSocket connection.
 *
 * ── THE BUG THIS EXISTS TO FIX, MEASURED ────────────────────────────────────
 * createWhaleCluster opened one connection PER WALLET, because logsSubscribe's
 * `mentions` filter takes a single address. Providers cap concurrent
 * connections per key, and Helius drops the surplus with close code 1006 — no
 * close frame, no error body, nothing an `onerror` handler can report. The bot
 * then showed a healthy socket feed while watching a fraction of the list.
 *
 * MEASURED against mainnet.helius-rpc.com with five wallets:
 *
 *     5 connections opened together      1 of 5 survived
 *     5 connections opened 1.5s apart    3 of 5 survived
 *     1 connection, 5 subscriptions      5 of 5 live
 *
 * Which wallet survived was a RACE, so it changed between runs — the symptom
 * was "it stopped copying the whale I just added", and the whale that went
 * silent was whichever lost. One subscription per address is a protocol
 * requirement; one CONNECTION per address never was.
 *
 * ── ATTRIBUTION IS BY SUBSCRIPTION ID, NEVER BY GUESS ───────────────────────
 * With one socket per wallet, the connection identified the wallet. Multiplexed
 * it cannot, so every notification is attributed through `params.subscription`
 * against the id the server returned when the subscription was confirmed. A
 * notification whose id is unknown is COUNTED AND DROPPED rather than assigned
 * to a likely wallet: crediting a trade to the wrong whale would corrupt the
 * cluster signal and the exit-origin check, both of which key on wallet.
 *
 * ── ONE CONNECTION PER FEED, NOT A GLOBAL REGISTRY ──────────────────────────
 * A module-level map keyed by RPC url would share one connection across every
 * caller in the process. That is hidden cross-instance state of exactly the
 * kind that made the per-socket probe order-dependent. This app builds one
 * feed per run, so an instance-scoped connection already is one per endpoint.
 */
export function createWhaleFeed({
  wallets = [],
  rpcUrl,
  cfg = {},
  log = () => {},
  onTrade = null,
  WebSocketImpl = globalThis.WebSocket,
  rpcImpl = solanaRpc,
} = {}) {
  const wsUrl = websocketUrlFor(rpcUrl);
  const entries = wallets
    .map((w) => (typeof w === 'string' ? { address: w, label: null } : { address: w?.address, label: w?.label ?? null }))
    .filter((e) => e.address);

  const state = {
    connected: false,
    closed: false,
    lastError: null,
    stats: {
      notifications: 0, resolved: 0, failed: 0, recovered: 0, abandoned: 0,
      reconnects: 0, duplicates: 0, pushed: 0, handlerErrors: 0, fastResolved: 0,
      unattributed: 0, refusedSubs: 0,
    },
  };

  const perWallet = new Map(
    entries.map((e) => [e.address, {
      label: e.label,
      subId: null,
      buffer: [],
      pendingRetry: [],
      newestSignature: null,
      // Per wallet, not shared: one transaction can mention two tracked
      // wallets and will then notify once per subscription. A shared set would
      // drop the second and lose that wallet's side of the trade.
      seen: new Set(),
    }])
  );

  const probe = createProcessedProbe();
  const resolveTx = createResolver({ rpcUrl, rpcImpl, cfg, log, probe, stats: state.stats });

  if (!entries.length || !wsUrl || typeof WebSocketImpl !== 'function') {
    state.lastError = !entries.length ? 'no tracked wallets' : !wsUrl ? 'no websocket url' : 'no WebSocket implementation';
    return {
      size: entries.length,
      wallets: entries.map((e) => e.address),
      isConnected: () => false,
      connectedCount: () => 0,
      subscribedCount: () => 0,
      missingWallets: () => entries.map((e) => e.address),
      status: () => ({ ...state, subscribed: [], missing: entries.map((e) => e.address) }),
      drain: async () => ({ ok: false, error: state.lastError, trades: [], cursors: {}, errors: [], scanned: 0, pending: 0, source: 'socket' }),
      close: () => {},
    };
  }

  // subId -> address, and requestId -> address while a subscribe is in flight.
  const subToWallet = new Map();
  const pendingSubs = new Map();
  let nextRequestId = 1;
  let ws = null;
  let backoff = cfg.reconnectBackoffMs ?? 1_000;

  /**
   * Re-establish the WHOLE subscription set as a unit.
   *
   * Every id from the previous connection is void the moment it drops, so the
   * maps are cleared before a single request goes out. Without that, a
   * notification carrying a recycled id from the new connection could match a
   * stale entry and be attributed to the wrong wallet — and because request
   * ids are never reused, a late confirmation from the old round simply finds
   * nothing in `pendingSubs` and is ignored.
   */
  const subscribeAll = () => {
    subToWallet.clear();
    pendingSubs.clear();
    for (const w of perWallet.values()) w.subId = null;
    for (const address of perWallet.keys()) {
      const id = nextRequestId++;
      pendingSubs.set(id, address);
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        params: [{ mentions: [address] }, { commitment: cfg.socketCommitment ?? 'processed' }],
      }));
    }
    log(`   one connection, ${perWallet.size} subscription(s) requested`);
  };

  const handleNotification = async (address, value) => {
    const w = perWallet.get(address);
    const signature = value?.signature;
    if (!w || !signature) return;

    // A failed transaction moved nothing.
    if (value.err) return;
    if (w.seen.has(signature)) { state.stats.duplicates++; return; }
    w.seen.add(signature);
    if (w.seen.size > SEEN_SIGNATURE_LIMIT * 2) {
      for (const s of [...w.seen].slice(0, w.seen.size - SEEN_SIGNATURE_LIMIT)) w.seen.delete(s);
    }

    const res = await resolveTx(signature, address);
    if (!res.ok) {
      w.pendingRetry.push({ signature, attempts: 1 });
      state.stats.failed++;
      return;
    }
    const trade = res.trade;
    if (!trade) return;

    w.newestSignature = signature;
    state.stats.resolved++;
    const stamped = { ...trade, wallet: address, walletLabel: w.label };
    log(`   ${trade.kind} ${trade.mint.slice(0, 8)}… ${address.slice(0, 8)}…`);

    if (onTrade) {
      state.stats.pushed++;
      Promise.resolve(onTrade(stamped)).catch((err) => {
        state.stats.handlerErrors++;
        log(`   onTrade threw for ${trade.mint.slice(0, 8)}…: ${err?.message ?? err}`);
      });
    } else {
      w.buffer.push(stamped);
    }
  };

  const connect = () => {
    if (state.closed) return;
    try {
      ws = new WebSocketImpl(wsUrl);
    } catch (err) {
      state.lastError = err.message;
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      state.connected = true;
      state.lastError = null;
      backoff = cfg.reconnectBackoffMs ?? 1_000;
      subscribeAll();
    };

    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      // A subscribe reply, matched by the request id we sent.
      if (msg.id != null && pendingSubs.has(msg.id)) {
        const address = pendingSubs.get(msg.id);
        pendingSubs.delete(msg.id);
        if (msg.error) {
          state.stats.refusedSubs++;
          state.lastError = `subscribe ${address.slice(0, 8)}…: ${msg.error.message ?? 'refused'}`;
          log(`   SUBSCRIBE REFUSED ${address.slice(0, 8)}… — ${msg.error.message ?? 'no reason given'}`);
          return;
        }
        if (msg.result !== undefined && msg.result !== null) {
          subToWallet.set(msg.result, address);
          const w = perWallet.get(address);
          if (w) w.subId = msg.result;
        }
        return;
      }

      if (msg.method !== 'logsNotification') return;
      state.stats.notifications++;

      const address = subToWallet.get(msg.params?.subscription);
      if (!address) {
        // Unknown subscription id. Counted, never guessed at — see the header.
        state.stats.unattributed++;
        return;
      }
      await handleNotification(address, msg.params?.result?.value);
    };

    ws.onerror = (err) => { state.lastError = err?.message ?? 'socket error'; };
    if (typeof ws.on === 'function') ws.on('error', () => {});
    if (typeof ws.addEventListener === 'function') ws.addEventListener('error', () => {});
    ws.onclose = () => {
      state.connected = false;
      subToWallet.clear();
      pendingSubs.clear();
      for (const w of perWallet.values()) w.subId = null;
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (state.closed) return;
    state.stats.reconnects++;
    const wait = backoff;
    backoff = Math.min(backoff * 2, cfg.maxReconnectBackoffMs ?? 30_000);
    setTimeout(connect, wait).unref?.();
  };

  connect();

  const missingWallets = () => [...perWallet.entries()].filter(([, w]) => w.subId === null).map(([a]) => a);

  return {
    size: perWallet.size,
    wallets: [...perWallet.keys()],
    // Connected means DELIVERING: the transport is open and at least one
    // subscription is confirmed. An open socket with no live subscription
    // returns nothing, and reporting it as connected is precisely how the
    // dropped-connection bug stayed invisible — the caller would stop polling.
    isConnected: () => state.connected && subToWallet.size > 0,
    connectedCount: () => subToWallet.size,
    subscribedCount: () => subToWallet.size,
    missingWallets,
    status: () => ({
      ...state,
      buffered: [...perWallet.values()].reduce((a, w) => a + w.buffer.length, 0),
      pendingRetry: [...perWallet.values()].flatMap((w) => w.pendingRetry),
      subscribed: [...subToWallet.values()],
      missing: missingWallets(),
      processedProbe: { ...probe },
      transport: 'multiplexed',
    }),

    async drain() {
      const trades = [];
      const cursors = {};

      for (const [address, w] of perWallet) {
        if (w.pendingRetry.length) {
          const queue = w.pendingRetry.splice(0, w.pendingRetry.length);
          for (const item of queue) {
            const res = await resolveTx(item.signature, address, { fast: false });
            if (res.ok) {
              if (res.trade) {
                w.buffer.push({ ...res.trade, wallet: address, walletLabel: w.label });
                w.newestSignature = item.signature;
                state.stats.resolved++;
                state.stats.recovered++;
              }
              continue;
            }
            if (item.attempts + 1 >= (cfg.retryAttempts ?? 5)) {
              state.stats.abandoned++;
              continue;
            }
            w.pendingRetry.push({ signature: item.signature, attempts: item.attempts + 1 });
          }
        }

        for (const t of w.buffer.splice(0, w.buffer.length)) trades.push(t);
        // Deliberately NOT advanced from the socket: if it drops, the poll
        // fallback must re-read the window it was covering rather than skip it.
        cursors[address] = null;
      }

      trades.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
      return {
        ok: (state.connected && subToWallet.size > 0) || trades.length > 0,
        error: state.connected ? null : (state.lastError ?? 'socket not connected'),
        trades,
        cursors,
        errors: [],
        // Carried so the dashboard's "N new tx" reflects the socket. The old
        // cluster omitted it, so that counter read 0 on every socket tick no
        // matter how many trades arrived.
        scanned: trades.length,
        pending: 0,
        source: 'socket',
      };
    },

    close() {
      state.closed = true;
      try { ws?.close(); } catch { /* already closing */ }
    },
  };
}

/**
 * The tracked wallets as one feed.
 *
 * DEFAULTS TO ONE MULTIPLEXED CONNECTION — see createWhaleFeed for the measured
 * reason. Passing `socketFactory` selects the older connection-per-wallet mode
 * instead, which remains the path the per-socket tests drive and an escape
 * hatch for an endpoint that dislikes many subscriptions on one connection.
 * That mode is subject to the provider connection cap and should not be the
 * default on Helius.
 */
export function createWhaleCluster({
  wallets = [],
  rpcUrl,
  cfg = {},
  log = () => {},
  // Threaded down to every socket. See createWhaleSocket for why pushing beats
  // buffering; the cluster's only added job is identity, below.
  onTrade = null,
  socketFactory = null,
  WebSocketImpl = globalThis.WebSocket,
  rpcImpl = solanaRpc,
} = {}) {
  if (!socketFactory && cfg.multiplex !== false) {
    return createWhaleFeed({ wallets, rpcUrl, cfg, log, onTrade, WebSocketImpl, rpcImpl });
  }

  const factory = socketFactory ?? createWhaleSocket;
  const sockets = wallets.map((w) => {
    const address = typeof w === 'string' ? w : w.address;
    const label = typeof w === 'string' ? null : (w.label ?? null);

    // ── THE SOCKET DOES NOT KNOW WHOSE IT IS ───────────────────────────────
    // A socket is constructed per wallet but the trade it resolves carries no
    // wallet field, because parseWalletSwap describes the swap and not the
    // subscription. drain() has always stamped it on the way out; the push
    // path has to do the same or every pushed trade arrives anonymous.
    //
    // That is not cosmetic here: orderByRank breaks same-block ties on
    // rankOf(t.wallet), and an undefined wallet ranks Infinity — so all five
    // whales would tie at the bottom and the operator-approved precedence
    // would silently become socket scheduling order.
    const stamped = onTrade ? (t) => onTrade({ ...t, wallet: address, walletLabel: label }) : null;

    return { address, label, socket: factory({ wallet: address, rpcUrl, cfg, log, onTrade: stamped }) };
  });

  return {
    size: sockets.length,
    wallets: sockets.map((s) => s.address),
    /** Connected if ANY socket is up — the others still deliver. */
    isConnected: () => sockets.some((s) => s.socket.isConnected?.()),
    connectedCount: () => sockets.filter((s) => s.socket.isConnected?.()).length,
    async drain() {
      const results = await Promise.all(
        sockets.map(async (s) => {
          try {
            const r = await s.socket.drain();
            return { ...r, address: s.address, label: s.label };
          } catch (err) {
            // One socket throwing must not lose the other four's trades.
            return { ok: false, error: err?.message ?? String(err), trades: [], address: s.address };
          }
        })
      );
      const trades = [];
      const cursors = {};
      for (const r of results) {
        if (r.newestSignature) cursors[r.address] = r.newestSignature;
        for (const t of r.trades ?? []) trades.push({ ...t, wallet: r.address, walletLabel: r.label ?? null });
      }
      trades.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
      return {
        ok: results.some((r) => r.ok),
        trades,
        cursors,
        errors: results.filter((r) => !r.ok).map((r) => ({ wallet: r.address, error: r.error })),
      };
    },
    close() {
      for (const s of sockets) s.socket.close?.();
    },
  };
}

/**
 * Detects two or more tracked whales buying the same mint in a short window.
 *
 * ── WHY CO-BUYING IS WORTH A SCORE AT ALL ───────────────────────────────────
 * One whale buying is one wallet's opinion. Two independent whales arriving at
 * the same token within minutes is the same opinion reached twice, and that is
 * a different kind of evidence — it is the one signal available here that is
 * not just a louder version of "the target bought".
 *
 * DISTINCT WALLETS ONLY. The same whale scaling into a position fires the buy
 * path repeatedly, and counting those as a cluster would turn ordinary
 * position-building into a maximum-conviction signal — inverting the meaning of
 * the score on exactly the trades where it fires most often.
 *
 * The window is a genuine judgement call and worth stating: three minutes is
 * long enough for a second whale to see and act on the same setup, short enough
 * that two unrelated buys of a popular token rarely coincide. It is not
 * measured, because a co-buy needs two tracked whales in one mint and this
 * watchlist has produced none yet.
 */
/**
 * Order a batch chronologically, breaking ties by whale rank. PURE.
 *
 * ── WHY RANK ONLY BREAKS TIES ───────────────────────────────────────────────
 * Chronology has to lead. The engine interleaves buys and sells in time order,
 * and a batch sorted by rank first would let a rank-1 SELL be processed before
 * the rank-3 BUY it precedes on chain — closing a position that had not been
 * opened yet, or worse, leaving one open that the chain says is closed.
 *
 * Rank decides only genuinely simultaneous signals. Two whales acting in the
 * same block carry the SAME blockTime — Solana stamps at second granularity,
 * so co-buys within a block are indistinguishable in time — and something has
 * to break that tie deterministically. Rank is the honest choice: it is the
 * order the operator approved. Without it the order falls out of socket
 * scheduling, which is arbitrary and changes between runs.
 */
export function orderByRank(trades = [], rankOf = () => Infinity) {
  return [...trades].sort(
    (a, b) =>
      (a.blockTime ?? 0) - (b.blockTime ?? 0) ||
      (rankOf(a.wallet) ?? Infinity) - (rankOf(b.wallet) ?? Infinity)
  );
}

/** address -> rank lookup built from a watchlist. PURE. */
export function rankLookup(watchlist) {
  const map = new Map();
  for (const [i, w] of (watchlist?.wallets ?? []).entries()) {
    if (w?.address) map.set(w.address, w.rank ?? i + 1);
  }
  return (address) => map.get(address) ?? Infinity;
}

/**
 * Equity excluding unrealized marks: cash plus the cost basis still deployed.
 *
 * ── WHY NOT equitySol ───────────────────────────────────────────────────────
 * equitySol marks open positions to market, and on these tokens a mark is the
 * softest number in the book. A position showing +500% that cannot be sold at
 * that price still inflates equity — and if sizing keys on it, the engine
 * scales up on a gain it never banked and then takes real losses at the larger
 * size. That is the classic compounding death spiral, and this codebase has
 * already measured how unreliable exit prices are: the entire Phase 3 effort
 * exists because exits were ASSUMED to fill at the whale's price.
 *
 * Cash plus cost basis equals budget plus realized P&L, which is the "banked
 * profits" figure compounding is supposed to follow.
 */
export function realizedEquitySol(book) {
  const staked = Object.values(book?.positions ?? {}).reduce((a, p) => a + (p.stakeSol ?? 0), 0);
  return (book?.balanceSol ?? 0) + staked;
}

/**
 * Scale position sizing with banked equity. PURE.
 *
 * effectivePctWhale = basePctWhale × (currentEquity / startingEquity)
 *
 * ── THE MULTIPLE IS BOUNDED AT BOTH ENDS, AND BOTH BOUNDS ARE LOAD-BEARING ──
 * ABOVE: the formula is unbounded, the pools are not. MEASURED on tokens this
 * book actually held, a single buy costs
 *
 *      $75  →  2.29% / 4.60% / 3.13%   price impact
 *    $1,500 →  6.30% / 34.42% / 16.76%
 *    $3,000 → 10.13% / 50.65% / 27.50%
 *
 * against pools of $53,750 / $4,692 / $15,656. Doubling equity twice and
 * letting size follow would walk straight into that curve — and impact is paid
 * on entry AND exit, against a measured round-trip drag of about 4%. A 4x
 * ceiling keeps sizing inside the same order of magnitude as the measurements
 * this book was calibrated on. Raise it only with fresh impact numbers.
 *
 * BELOW: a floor of 0.25x. A book down 90% would otherwise size at a tenth,
 * making every position dust and mathematically unable to recover — the
 * drawdown protection would become the thing that prevents recovery.
 */
export function compoundSizing({
  basePctWhale = null,
  startingEquity = 0,
  currentEquity = 0,
  minMultiple = 0.25,
  maxMultiple = 4,
  enabled = false,
} = {}) {
  if (!enabled || basePctWhale === null || basePctWhale === undefined) {
    return { active: false, multiple: 1, effectivePctWhale: basePctWhale ?? null };
  }
  if (!(startingEquity > 0) || !Number.isFinite(currentEquity)) {
    // No baseline is not a reason to guess. Sizing stays at base.
    return { active: true, multiple: 1, effectivePctWhale: basePctWhale, reason: 'no starting equity on record' };
  }

  const raw = currentEquity / startingEquity;
  const multiple = Math.min(maxMultiple, Math.max(minMultiple, raw));
  return {
    active: true,
    raw,
    multiple,
    clamped: multiple !== raw,
    // Rounded so a log line does not read 14.999999999999998%.
    effectivePctWhale: Number((basePctWhale * multiple).toFixed(4)),
    reason:
      multiple === maxMultiple && raw > maxMultiple
        ? `capped at ${maxMultiple}x — pool depth, not equity, is the binding constraint`
        : multiple === minMultiple && raw < minMultiple
          ? `floored at ${minMultiple}x so a drawdown cannot size the book into dust`
          : null,
  };
}

/**
 * How many whales to track this run. PURE.
 *
 * `--track` is kept as an alias because it shipped first and a flag that
 * silently stops working is worse than two spellings of one idea.
 */
export function parseTrackWhales(argv = [], { fallback = 5, max = 5 } = {}) {
  for (const flag of ['--track-whales', '--track']) {
    const i = argv.indexOf(flag);
    if (i === -1) continue;
    const raw = argv[i + 1];
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) {
      return { count: fallback, requested: raw ?? null, invalid: true, flag };
    }
    return { count: Math.min(Math.trunc(n), max), requested: Math.trunc(n), clamped: n > max, flag };
  }
  return { count: fallback, requested: null, defaulted: true };
}

/**
 * The header line. PURE.
 *
 * ── IT REPORTS THE ACTUAL COUNT, NOT THE REQUESTED ONE ──────────────────────
 * `--track-whales 5` against a four-wallet watchlist tracks four. A header that
 * echoed the request would claim a fifth subscription that does not exist, and
 * the operator would read a cluster signal as needing two of five when it needs
 * two of four. The requested number is shown alongside only when it differs.
 */
export function trackingHeader(actual, { requested = null } = {}) {
  const n = Math.max(0, Math.trunc(actual));
  const noun = n === 1 ? 'Whale' : 'Whales';
  const shape = n === 1 ? 'Target #1' : `Top ${n} Cluster`;
  const short = Number.isFinite(requested) && requested > n ? `  (asked for ${requested}; ${n} enabled)` : '';
  return `TRACKING: ${n} ${noun} (${shape})${short}`;
}

/**
 * A short, readable credit for the wallet behind a trade. PURE.
 *
 * ── WHY A LOG LINE NEEDS THIS AT ALL ────────────────────────────────────────
 * With one target every line was implicitly attributed and naming the wallet
 * would have been noise. With four, "BUY $BIAO — 1.0000 SOL" no longer says
 * whose conviction it was, and since only the originating whale can close a
 * position, the reader cannot tell which sell to expect. Attribution stopped
 * being decoration the moment exits became whale-specific.
 *
 * The win rate is taken from the ALL-TIME on-chain figure first. The observed
 * rate reads far higher on small samples — measured 100% observed against 27%
 * on chain for the same wallet — and a log line is exactly where a flattering
 * number does the most damage, because nobody re-derives it.
 *
 * Returns null for an unknown address rather than inventing a rank, so a trade
 * from something not on the watchlist reads as unattributed instead of as
 * rank #Infinity.
 */
export function whaleTag(address, watchlist, { withWinRate = true } = {}) {
  if (!address) return null;
  const wallets = watchlist?.wallets ?? [];
  const i = wallets.findIndex((w) => w?.address === address);
  if (i === -1) return null;
  const w = wallets[i];
  const rate = withWinRate ? (w.all_time_win_rate ?? w.win_rate ?? null) : null;
  return {
    rank: w.rank ?? i + 1,
    address,
    short: `${address.slice(0, 6)}…`,
    label: w.label ?? null,
    winRate: rate,
    // "Rank #2: 8zkgFG… — 52% WR"
    text: `Rank #${w.rank ?? i + 1}: ${address.slice(0, 6)}…${rate ? ` — ${rate} WR` : ''}`,
  };
}

export function createClusterTracker({ windowMs = 180_000, bonus = 25 } = {}) {
  const byMint = new Map();
  return {
    /** Record a buy and report whether it completes a cluster. */
    record({ mint, wallet, at = Date.now() }) {
      if (!mint || !wallet) return { cluster: false, wallets: [], convictionBonus: 0 };
      const seen = (byMint.get(mint) ?? []).filter((e) => at - e.at <= windowMs);
      const existing = seen.find((e) => e.wallet === wallet);
      if (existing) existing.at = at;
      else seen.push({ wallet, at });
      byMint.set(mint, seen);

      const distinct = [...new Set(seen.map((e) => e.wallet))];
      const cluster = distinct.length >= 2;
      return {
        cluster,
        wallets: distinct,
        // Flat, not per-wallet: a third whale is more confirmation but not
        // proportionally more, and a scaling bonus would let one crowded mint
        // dominate every other signal the scanner produces.
        convictionBonus: cluster ? bonus : 0,
        windowMs,
      };
    },
    /** Drop mints whose window has fully expired. */
    prune(now = Date.now()) {
      let dropped = 0;
      for (const [mint, entries] of byMint) {
        const live = entries.filter((e) => now - e.at <= windowMs);
        if (!live.length) { byMint.delete(mint); dropped++; }
        else byMint.set(mint, live);
      }
      return { dropped, tracked: byMint.size };
    },
    get size() { return byMint.size; },
  };
}

export async function fetchPrices(mints, { batchFetcher = fetchPairsBatch } = {}) {
  const quotes = await fetchMarketData(mints, { batchFetcher });
  return new Map([...quotes].map(([mint, q]) => [mint, q.priceUsd]));
}

/**
 * Price AND ticker for a set of mints.
 *
 * ── WHY THE SYMBOL COMES FROM THE SAME CALL AS THE PRICE ───────────────────
 * The chain mirror learns a mint and nothing else — parseWalletSwap reads
 * balance deltas, and a balance carries no name. Without this the dashboard
 * shows `opUSE74F` where GMGN shows `$Call`, which is unreadable next to any
 * other tool. The pair payload already being fetched for the mark carries
 * baseToken.symbol, so the ticker costs no extra request.
 *
 * The symbol is a LABEL AND NOTHING ELSE. Solana's ticker namespace is
 * unrestricted — this session already measured ten distinct mints all symboled
 * "SOL" at five different prices — so it is never matched on, compared, or used
 * to identify a position. The mint remains the key everywhere.
 */
export async function fetchMarketData(
  mints,
  { batchFetcher = fetchPairsBatch, singleFetcher = fetchDexScreenerPrice, maxSingleLookups = 8, solUsd = null } = {}
) {
  const out = new Map();
  if (!mints?.length) return out;

  const byAddress = await batchFetcher(mints).catch(() => new Map());
  const missing = [];

  for (const mint of mints) {
    const pair = byAddress && typeof byAddress.get === 'function' ? byAddress.get(String(mint).toLowerCase()) : null;
    const priceUsd = Number(pair?.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      missing.push(mint);
      continue;
    }
    const symbol = typeof pair?.baseToken?.symbol === 'string' ? pair.baseToken.symbol.trim() : null;
    // The pool comes from the SAME payload as the price, at no extra request —
    // the pair that sets the price is by construction the pair a fill would
    // cross, since fetchPairsBatch already keeps the deepest one per token.
    const pool = poolReserveSol(pair, { solUsd });
    out.set(mint, {
      priceUsd,
      symbol: symbol || null,
      source: 'batch',
      poolSol: pool.measured ? pool.reserveSol : null,
    });
  }

  // ── PER-MINT FALLBACK ─────────────────────────────────────────────────────
  // A mint can be absent from a batch response while a direct lookup finds it:
  // the batch is chunked 30 at a time and one failed chunk silently drops
  // thirty tokens, which reads downstream as thirty unpriceable positions
  // rather than as one failed request.
  //
  // BOUNDED, because the fallback is the same host as the batch. If DexScreener
  // is down or rate-limiting, retrying every miss individually turns one failed
  // request into as many as there are open positions and guarantees the limit
  // stays hit. A stale mark is recoverable; a self-inflicted outage is not.
  if (!singleFetcher || !missing.length) return out;
  for (const mint of missing.slice(0, maxSingleLookups)) {
    const single = await singleFetcher(mint).catch(() => null);
    if (!single?.ok) continue;
    // This endpoint returns liquidityUsd but not the pair, so the quote token is
    // unknown and the reserve field cannot be read directly. Half the pool value
    // converted at spot is the only route left, and it is the same arithmetic
    // poolReserveSol falls back to for any pair not quoted in SOL.
    const poolSol =
      Number.isFinite(single.liquidityUsd) && single.liquidityUsd > 0 && Number.isFinite(solUsd) && solUsd > 0
        ? single.liquidityUsd / 2 / solUsd
        : null;
    out.set(mint, {
      priceUsd: single.priceUsd,
      symbol: single.symbol,
      source: 'dexscreener-single',
      poolSol,
    });
  }
  return out;
}

/**
 * Read a quote that may be a bare price or a {priceUsd, symbol} record. PURE.
 *
 * Both shapes exist on purpose: runPaperTick's injectable priceFetcher is used
 * by tests and callers that only have prices, and silently ignoring a number
 * would make every one of those mirror nothing.
 */
export function readQuote(value) {
  if (typeof value === 'number') {
    // NO poolSol KEY AT ALL, which resolvePoolSol reads as "depth was never
    // sought" rather than "sought and missing". A bare number is a shape that
    // cannot carry depth, so a caller injecting one — every test that passes a
    // price map, and any custom fetcher — gets the infinite-depth behaviour it
    // has always had instead of being charged an assumed pool it never saw.
    // report.liquidity.depthUnavailable counts these so the choice is visible.
    return Number.isFinite(value) && value > 0 ? { priceUsd: value, symbol: null } : null;
  }
  const priceUsd = Number(value?.priceUsd);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const poolSol = Number(value?.poolSol);
  const carriesDepth = value !== null && typeof value === 'object' && 'poolSol' in value;
  return {
    priceUsd,
    symbol: value?.symbol ?? null,
    // The key is OMITTED rather than set to undefined when the quote never had
    // one. `{poolSol: undefined}` and `{}` read the same to every consumer here
    // but not to assert.deepStrictEqual, and a shape that fails an equality
    // check it should pass is a trap for the next person writing a test.
    // null, never the floor: resolvePoolSol owns that decision.
    ...(carriesDepth ? { poolSol: Number.isFinite(poolSol) && poolSol > 0 ? poolSol : null } : {}),
  };
}

/**
 * Ticker for display. PURE.
 *
 * `$SYMBOL` when one is known, matching how GMGN and every Solana front-end
 * render it; a short mint prefix otherwise, so a token whose pair carries no
 * symbol is still identifiable rather than blank.
 */
export function formatTicker(symbol, mint = '') {
  const clean = typeof symbol === 'string' ? symbol.trim() : '';
  if (clean) return `$${clean}`;
  return String(mint).slice(0, 8) || '(unknown)';
}

/**
 * One tick: re-point the target, mirror new buys, mark open positions, fire
 * exits. Returns a report rather than logging, so it can be driven from a loop
 * or tested against fixtures.
 */
export async function runPaperTick({
  book,
  observations,
  watchlist,
  cfg,
  now = Date.now(),
  // Defaults to the symbol-carrying fetcher so a chain-mirrored entry can
  // learn its ticker; readQuote still accepts a bare price map from any
  // caller or test that injects one.
  priceFetcher = fetchMarketData,
  tradeFetcher = fetchWhaleTrades,
  // Needed to convert a swap's SOL-denominated fill into USD. Without it the
  // implied path is simply skipped and the pair lookup is used, rather than a
  // guessed rate producing a wrong entry.
  solUsd = null,
  // The slot-window reader behind `slotFills`. Injected so the reconstruction
  // can be driven from written-down transaction shapes in tests — without this
  // seam a tick test would reach the network, which is the one thing this
  // engine's tests have never done.
  slotSwapFetcher = fetchSlotWindowSwaps,
} = {}) {
  const report = { opened: [], exits: [], marked: 0, declined: [], target: null, chain: null };

  const resolved = resolveTarget(watchlist, book);
  report.target = resolved;
  if (resolved.target) {
    if (!book.target || book.target.address !== resolved.target.address) {
      book.target = { ...resolved.target, since: now };
      // A new target's cursor cannot carry over: its signatures are unrelated,
      // and reusing the old one would replay the new wallet's whole first page
      // or skip it entirely depending on ordering.
      book.lastSignature = null;
    } else {
      book.target.label = resolved.target.label ?? book.target.label;
    }
  }

  // ---- live on-chain trades, free public RPC -----------------------
  let liveBuys = [];
  let liveTrades = [];
  if (cfg.rpcMirror?.enabled && book.target?.address) {
    const live = await tradeFetcher({
      wallet: book.target.address,
      rpcUrl: cfg.rpcMirror.url,
      sinceSignature: book.lastSignature ?? null,
      signatureLimit: cfg.rpcMirror.signatureLimit,
      maxTxLookups: cfg.rpcMirror.maxTxLookupsPerTick,
      delayMs: cfg.rpcMirror.delayMs,
    });
    report.chain = { ok: live.ok, error: live.error ?? null, scanned: live.scanned ?? 0, pending: live.pending ?? 0 };

    if (live.ok) {
      // ONLY advanced on success. A failed poll must not skip the window it
      // failed to read, or a transient RPC error would silently drop every
      // trade the whale made during it.
      if (live.newestSignature) book.lastSignature = live.newestSignature;

      // ── SIGNATURE DEDUPE, AND IT IS LOAD-BEARING NOW ────────────────────
      // The socket and the poll fallback can both deliver the same trade: the
      // socket fires on `processed` while the poll walks back from a cursor
      // that has not advanced yet. Before scale-in a duplicate BUY was
      // harmless — it hit "already holding" and was declined. It now ADDS to
      // the position, so the same trade would be mirrored twice and the
      // blended entry would be wrong from then on.
      //
      // Kept on the book so it survives a restart, and bounded because a busy
      // wallet would otherwise grow it without limit.
      const seen = new Set(book.seenSignatures ?? []);
      const fresh = [];
      for (const t of live.trades) {
        if (t.signature) {
          if (seen.has(t.signature)) continue;
          seen.add(t.signature);
          fresh.push(t.signature);
        }
        // ONE ORDERED LIST. Splitting into buys and sells here is what forced
        // the two-pass application below, and with it the bug where a sell
        // landed before the buy it followed.
        if (t.kind === 'BUY' || t.kind === 'SELL') liveTrades.push(t);
        if (t.kind === 'BUY') liveBuys.push(t);
      }
      if (fresh.length) {
        book.seenSignatures = [...(book.seenSignatures ?? []), ...fresh].slice(-SEEN_SIGNATURE_LIMIT);
      }
      report.chain.duplicates = (live.trades?.length ?? 0) - liveTrades.length;
    }
  }

  // Chain buys take precedence: they carry the real spend and arrive seconds
  // after the trade rather than at scan cadence. The ledger path stays as a
  // fallback for a run with the mirror disabled.
  const ledgerCandidates = cfg.rpcMirror?.enabled
    ? []
    : pendingMirrorBuys(observations, { target: book.target, book, cfg, now });
  const held = new Set(Object.keys(book.positions));
  // ── WHY THIS SET IS USUALLY EMPTY NOW ──────────────────────────────────
  // With scaleIn on, a HELD mint is not a reason to skip a buy —
  // openPaperPosition routes it to scaleInPaperPosition. With reEnter on, a
  // CLOSED mint is not either.
  //
  // Excluding closed mints was a real bug against a target that cycles the same
  // tokens, which is most of them. OBSERVED: the book took $SHITCOINER, the
  // target sold, the book closed at -0% — and then ignored every subsequent
  // $SHITCOINER buy the target made, permanently. The GMGN trade list for this
  // wallet is largely the same handful of tickers bought and sold repeatedly,
  // so "one position per mint, ever" quietly discards most of what it does.
  //
  // A mint may now own SEVERAL rows in `closed`, one per round trip, which is
  // what they are — and the win rate counts each on its own merits rather than
  // collapsing a wallet's repeat trades into a single verdict.
  //
  // Nothing here re-processes a trade: the signature dedupe does that, which is
  // why this filter can be relaxed safely at all.
  const everSeen = new Set([
    ...(cfg.scaleIn ? [] : held),
    ...(cfg.reEnter ? [] : (book.closed ?? []).map((c) => c.mint)),
  ]);
  // maxBuyAgeMinutes applies to chain buys exactly as it does to ledger ones,
  // and it is load-bearing on the first tick: a cold start reads a whole page
  // of history, and without this the book would enter tokens the whale bought
  // an hour ago at prices that have already moved — copying a decision whose
  // moment has passed, which is the thing the ledger path's own age bound
  // exists to prevent. A trade with no blockTime is treated as current, since
  // the only way it reached this page is by being recent.
  const buyCutoff = now - cfg.maxBuyAgeMinutes * 60_000;
  let staleChainBuys = 0;
  const candidates = [
    ...liveBuys
      .filter((t) => {
        if (everSeen.has(t.mint)) return false;
        if (Number.isFinite(t.blockTime) && t.blockTime < buyCutoff) {
          staleChainBuys++;
          return false;
        }
        return true;
      })
      .map((t) => {
        // Priced from the swap where possible, so the entry does not wait on a
        // pair lookup. The impact premium is applied HERE rather than inside
        // openPaperPosition, so the position's entry is the price we model
        // ourselves paying and every later mark compares against that.
        const implied = cfg.useImpliedEntry
          ? impliedEntryPriceUsd(t, { solUsd, minSpendSol: cfg.impliedMinSpendSol })
          : null;
        return {
          mint: t.mint,
          symbol: null,
          observedAt: t.blockTime ?? now,
          whaleSpendSol: t.solSpent,
          impliedPriceUsd: implied === null ? null : implied * (1 + cfg.copyImpactPct / 100),
          whaleFillUsd: implied,
          // Carried through so the position can be tagged with the wallet that
          // actually bought, not the primary target. Only the socket cluster
          // attributes trades; the poll fallback leaves this undefined and the
          // position falls back to the target, which is correct for a
          // single-wallet poll.
          wallet: t.wallet ?? null,
          // The slot the target's buy landed in. The fill window is counted
          // from here; without it slotFills has nothing to anchor to and the
          // candidate simply keeps the implied price.
          whaleSlot: t.slot ?? null,
          // The target's own transaction, so the activity feed can link the
          // trade that caused ours rather than only the token.
          signature: t.signature ?? null,
        };
      }),
    ...ledgerCandidates,
  ];
  if (report.chain) report.chain.staleSkipped = staleChainBuys;
  const openMints = Object.keys(book.positions);
  // OPEN POSITIONS ALWAYS NEED A LOOKUP — they have to be marked, and no swap
  // tells us today's price. Candidates only need one when the swap could not
  // price them, which is the whole latency win: a mirrored entry no longer
  // waits on a network round trip plus fetchPairsBatch's 250ms internal pace.
  //
  // ── AND SO DOES EVERY CANDIDATE, ONCE THE LIQUIDITY MODEL IS ON ───────────
  // An implied entry knows its price but not its pool, and without the pool the
  // fill falls back to poolFloorSol — 30 SOL against a population measured at
  // 117-260. That is a 2.5-point overcharge on every entry, applied silently.
  // The lookup usually costs nothing: open positions are marked through this
  // same batch call, so the candidate rides along in a request already being
  // made. It costs one round trip only when the book is empty AND every
  // candidate priced itself, which is exactly the tick where nothing else is
  // waiting on it. poolDepthLookup: false restores the old behaviour.
  const needPrices = [
    ...new Set([
      ...openMints,
      ...candidates
        .filter((c) => !c.impliedPriceUsd || (cfg.liquidityModel !== false && cfg.poolDepthLookup !== false))
        .map((c) => c.mint),
    ]),
  ];
  const raw = await priceFetcher(needPrices, { solUsd });
  // Normalised once, so every reader below sees one shape whether the fetcher
  // returned bare numbers or {priceUsd, symbol} records.
  const quotes = new Map();
  const prices = new Map();
  // Holds undefined and null as MEANINGFULLY DIFFERENT values, which is why
  // every quote is recorded rather than only the ones carrying a number:
  // `pools.get(mint)` then returns the depth, or null for a quote that looked
  // and found none, or undefined for a shape that cannot report depth at all.
  // See resolvePoolSol — the floor answers exactly one of those three.
  const pools = new Map();
  let depthUnavailable = 0;
  let poolsMeasured = 0;
  for (const [mint, value] of raw ?? []) {
    const q = readQuote(value);
    if (!q) continue;
    quotes.set(mint, q);
    prices.set(mint, q.priceUsd);
    pools.set(mint, q.poolSol);
    if (q.poolSol === undefined) depthUnavailable++;
    else if (q.poolSol !== null) poolsMeasured++;
  }
  // Counted rather than inferred later: "how many of this tick's fills were
  // priced against a pool nobody read" is the first question to ask of a result
  // this model produces.
  report.liquidity = {
    modelled: cfg.liquidityModel !== false,
    poolCapPct: cfg.poolCapPct,
    poolFloorSol: cfg.poolFloorSol,
    poolsMeasured,
    poolsNeeded: needPrices.length,
    // Quotes from a source that cannot report depth — the liquidity model does
    // not run on these at all, and a tick where this is high is a tick whose
    // P&L still assumes infinite liquidity.
    depthUnavailable,
    capped: 0,
    flooredFills: 0,
  };

  // Indexed so the ordered pass below can find the candidate a BUY row refers
  // to. Last write wins on a repeated mint, which is correct: two buys of one
  // token in a batch become one entry plus one scale-in, and the scale-in is
  // driven by the second row's own spend when it is reached.
  const candidateByMint = new Map(candidates.map((c) => [c.mint, c]));

  // ── COMPOUND SIZING ───────────────────────────────────────────────────────
  // Recomputed every tick from BANKED equity, so a position opened after a win
  // is sized on that win and one opened during a drawdown is sized down. The
  // baseline is the book's original budget, which is fixed at creation and
  // survives restarts — anchoring to anything recomputed would let the ratio
  // drift toward 1 and quietly stop compounding.
  const compound = compoundSizing({
    basePctWhale: cfg.pctWhale,
    startingEquity: book.budgetSol,
    currentEquity: realizedEquitySol(book),
    enabled: cfg.autoCompound === true,
    minMultiple: cfg.compoundMinMultiple ?? 0.25,
    maxMultiple: cfg.compoundMaxMultiple ?? 4,
  });
  report.compound = compound;
  const sizingCfg = compound.active ? { ...cfg, pctWhale: compound.effectivePctWhale } : cfg;

  // ── SLOT-LATENCY FILLS ────────────────────────────────────────────────────
  // Resolved BEFORE the ordered pass so openCandidate stays synchronous — it is
  // called from inside the ordered buy/sell walk, and making that walk async
  // would reorder a buy and the sell that follows it, which the walk exists to
  // prevent.
  //
  // Only candidates that carry a slot are eligible. A ledger candidate has no
  // slot and keeps the pair price, which is correct: there is no target trade
  // to count a window from.
  const bands = new Map();
  if (cfg.slotFills === true && Number.isFinite(solUsd)) {
    report.slotFills = { attempted: 0, reconstructed: 0, failed: 0, reasons: [] };
    for (const c of candidates) {
      if (!Number.isFinite(c.whaleSlot) || bands.has(c.mint)) continue;
      report.slotFills.attempted++;
      const band = await resolveExecutionBand({
        mint: c.mint,
        whaleSlot: c.whaleSlot,
        side: 'BUY',
        cfg,
        solUsd,
        rpcUrl: cfg.rpcMirror?.url,
        fetcher: slotSwapFetcher,
      });
      bands.set(c.mint, band);
      if (band.reconstructed) report.slotFills.reconstructed++;
      else {
        report.slotFills.failed++;
        if (band.reason) report.slotFills.reasons.push(band.reason);
      }
    }
  }

  const openCandidate = (c) => {
    // Priority: a fill reconstructed from real on-chain swaps at the slot we
    // could actually have landed in, then the swap's own price, then the pair
    // lookup. The reconstruction is skipped rather than faked when the chain
    // could not answer — see buildExecutionBand's `reconstructed: false`.
    const band = bands.get(c.mint);
    const price = (band?.reconstructed ? band.fillPriceUsd : null) ?? c.impliedPriceUsd ?? prices.get(c.mint);
    const res = openPaperPosition(book, {
      mint: c.mint,
      // A chain buy arrives with no symbol; the quote that priced it has one.
      symbol: c.symbol ?? quotes.get(c.mint)?.symbol ?? null,
      priceUsd: price,
      cfg: sizingCfg,
      now,
      source: book.target?.address ?? null,
      // The wallet that ACTUALLY made this buy, which under multi-wallet
      // tracking is often not the primary target. Falling back to the target
      // keeps single-wallet runs and ledger-sourced candidates unchanged.
      originatingWhale: c.wallet ?? book.target?.address ?? null,
      whaleSpendSol: c.whaleSpendSol ?? null,
      poolSolReserve: pools.has(c.mint) ? pools.get(c.mint) : null,
    });
    if (res.ok) {
      if (res.liquidityCapped) report.liquidity.capped++;
      if (res.poolMeasured === false) report.liquidity.flooredFills++;
      // Recorded ON the position, not only in the report: the uncertainty
      // belongs to the fill for as long as the position is open, and the
      // dashboard reads it from the book on every later tick.
      if (band?.reconstructed && res.position) res.position.executionBand = band;
      report.opened.push({
        mint: c.mint,
        symbol: res.position?.symbol ?? c.symbol ?? null,
        sizeSol: res.sizeSol,
        executionBand: band?.reconstructed ? band : null,
        // The target's tx, and the price THEY got. Together these let the feed
        // state the cost of arriving late: our fill against theirs, on the
        // trade that caused ours.
        signature: c.signature ?? null,
        whaleFillUsd: c.whaleFillUsd ?? null,
        entryPriceUsd: res.position?.entryPriceUsd ?? null,
        originatingWhale: res.position?.originatingWhale ?? null,
        basis: res.basis ?? null,
        whaleSpendSol: c.whaleSpendSol ?? null,
        // So the activity log can say ADD rather than BUY. A scale-in and a new
        // entry look identical in a list of sizes, and they are not the same
        // event.
        scaledIn: res.scaledIn === true,
        blendedEntryUsd: res.blendedEntryUsd ?? null,
        // What the pool did to this fill, carried to the activity log. A size
        // that was cut and one that was not look identical as a number.
        impactPct: res.impactPct ?? null,
        poolSol: res.poolSol ?? null,
        poolMeasured: res.poolMeasured ?? null,
        liquidityCapped: res.liquidityCapped === true,
        requestedSol: res.requestedSol ?? null,
      });
    } else report.declined.push({ mint: c.mint, reason: res.reason });
    return res;
  };

  // Mark first, so an exit fires on this tick's price rather than last tick's.
  for (const mint of openMints) {
    const q = quotes.get(mint);
    if (!q) continue;
    markPosition(book.positions[mint], q.priceUsd, now);
    // BACKFILLED, not overwritten. A chain-mirrored entry knows only a mint —
    // balance deltas carry no name — so the ticker arrives with the first mark
    // that resolves it and then stays put, rather than churning if a pair later
    // reports a different symbol for the same mint.
    if (!book.positions[mint].symbol && q.symbol) book.positions[mint].symbol = q.symbol;
    report.marked++;
  }

  // ---- the target's trades, IN THE ORDER THEY WERE MADE -------------
  //
  // Buys and sells are applied interleaved rather than in two passes, and that
  // matters as soon as a target cycles a token — which is most of them.
  //
  // THE BUG THIS REPLACES: all sells ran before all entries, so a batch holding
  // BUY(M) then SELL(M) applied the sell while nothing was held, discarded it,
  // and THEN opened M. The book ended up holding a position the target had
  // already exited, and under pureMirror there is no stop to catch it. A single
  // poll page on a cold start routinely contains exactly that sequence.
  //
  // Chronological order also makes a buy → sell → buy cycle land as one open
  // position rather than two, and lets a sell free balance for a later buy in
  // the same batch.
  //
  // A whale exit still precedes the paper's own ladder and stops, which run
  // below on whatever remains: the target acting is a stronger signal than a
  // threshold this engine inferred from price.
  const sellsEnabled = cfg.rpcMirror?.mirrorSells !== false;
  for (const t of liveTrades) {
    if (t.kind === 'SELL') {
      if (!sellsEnabled) continue;
      const p = book.positions[t.mint];
      if (!p) continue;
      // THE TARGET'S OWN SELL PRICE FIRST. A tick-sampled DexScreener quote
      // showed no systematic bias against it but a ±30-60% spread, which made
      // every exit a coin flip while entries were exact. The pair feed remains
      // the fallback for a sell too small to imply a price, or when no SOL rate
      // is available to convert one.
      const price =
        impliedExitPriceUsd(t, { solUsd, minReceiveSol: cfg.impliedMinSpendSol }) ??
        prices.get(t.mint) ??
        p.markPriceUsd;
      if (!Number.isFinite(price) || price <= 0) continue;

      // ── ONLY THE ORIGINATING WHALE CLOSES ITS OWN POSITION ────────────────
      // Another whale selling this mint is that wallet exiting a thesis we did
      // not copy. Ignored rather than acted on, so each position stays under
      // the judgement of the wallet that opened it.
      const origin = exitMatchesOrigin(p, t);
      if (!origin.match) {
        report.ignoredExits = (report.ignoredExits ?? 0) + 1;
        report.ignoredExitDetail = [...(report.ignoredExitDetail ?? []), { mint: t.mint, ...origin }];
        continue;
      }

      const fraction = Number.isFinite(t.sellFraction) ? t.sellFraction : 1;
      const gainPct = p.entryPriceUsd > 0 ? (price / p.entryPriceUsd - 1) * 100 : null;

      if (p.subs?.length) {
        // A target sell closes EVERY sub-wallet still holding, moonshot
        // included — mirroring the exit is the moonshot's only exit rule, and
        // the ladder profiles treat it as an early close of whatever remains.
        // Iterated over a copy: applySubWalletExit deletes the position once
        // the last sub closes, and mutating the array being walked would skip
        // the sub after it.
        for (const sub of [...p.subs]) {
          if (sub.closed || !(sub.stakeSol > 0)) continue;
          const res = applySubWalletExit(book, t.mint, sub.subId, {
            priceUsd: price, trigger: 'WHALE_SELL', sellFraction: fraction, cfg, now,
            label: `target sold ${(fraction * 100).toFixed(0)}% of its bag`,
            poolSolReserve: pools.has(t.mint) ? pools.get(t.mint) : null,
          });
          if (res.ok) {
            if (res.poolMeasured === false) report.liquidity.flooredFills++;
            report.exits.push({
              mint: t.mint, symbol: p.symbol, trigger: 'WHALE_SELL',
              label: `target sold ${(fraction * 100).toFixed(0)}%`,
              gainPct, subId: sub.subId, profile: sub.profile, seller: t.wallet ?? null,
              impactPct: res.impactPct ?? null, poolSol: res.poolSol ?? null, poolMeasured: res.poolMeasured ?? null,
            });
          }
        }
        continue;
      }

      const res = applyPaperExit(book, t.mint, {
        priceUsd: price,
        trigger: 'WHALE_SELL',
        sellFraction: fraction,
        cfg,
        now,
        label: `target sold ${(fraction * 100).toFixed(0)}% of its bag`,
        poolSolReserve: pools.has(t.mint) ? pools.get(t.mint) : null,
      });
      if (res.ok) {
        if (res.poolMeasured === false) report.liquidity.flooredFills++;
        report.exits.push({
          mint: t.mint,
          symbol: p.symbol,
          trigger: 'WHALE_SELL',
          label: `target sold ${(fraction * 100).toFixed(0)}%`,
          gainPct,
          seller: t.wallet ?? null,
          impactPct: res.impactPct ?? null,
          poolSol: res.poolSol ?? null,
          poolMeasured: res.poolMeasured ?? null,
        });
      }
      continue;
    }

    const c = candidateByMint.get(t.mint);
    // Filtered earlier as stale, already-seen, or otherwise not a candidate.
    if (!c || c.consumed) continue;
    c.consumed = true;
    openCandidate(c);
  }

  // Exits before entries: freeing balance first lets a tick that closes a
  // position also open one, which is what a real book would do.
  for (const mint of openMints) {
    const p = book.positions[mint];
    if (!p) continue;
    const price = prices.get(mint);
    if (!Number.isFinite(price)) {
      const ageH = (now - (p.lastPricedAt ?? p.openedAt)) / 3.6e6;
      // NOT IN PURE MIRROR. A stale exit is still a sell the target did not
      // make, and "only sell when the whale sells" has to mean that or it means
      // nothing. The cost is real and is surfaced instead of silently taken:
      // an unpriceable position keeps its last mark, so equity counts a token
      // that may be worthless. staleUnpriced on the report drives the dashboard
      // warning that says so.
      if (cfg.pureMirror) {
        report.unpriced = (report.unpriced ?? 0) + 1;
        continue;
      }
      if (ageH >= cfg.staleExitHours) {
        // Unpriceable for two days is a delisting, and a delisting is a loss,
        // not a hold. Marked at the last price rather than zero: the pair may
        // simply have fallen out of the feed.
        applyPaperExit(book, mint, {
          priceUsd: p.markPriceUsd,
          trigger: 'STALE',
          sellFraction: 1,
          cfg,
          now,
          label: `no price for ${ageH.toFixed(0)}h`,
          // No pool on file — the position is here BECAUSE its pair stopped
          // pricing, so this exit pays the floor. Correct rather than harsh: a
          // token that fell out of the feed is not one you get out of cheaply.
          poolSolReserve: null,
        });
        report.exits.push({ mint, trigger: 'STALE' });
      }
      continue;
    }
    if (p.subs?.length) {
      // Each sub-wallet is evaluated under its OWN ladder. The scalper can book
      // +50% on the same tick the moonshot holds, which is the entire point of
      // the split — so a shared exit list would defeat it.
      const { profiles } = resolveSubWallets(p.subs.length);
      for (const sub of p.subs) {
        if (sub.closed || !(sub.stakeSol > 0)) continue;
        const profile = profiles.find((pr) => pr.id === sub.subId) ?? profiles[profiles.length - 1];
        sub.peakPriceUsd = Math.max(sub.peakPriceUsd ?? price, price);
        for (const exit of evaluatePaperExits(sub, price, subWalletCfg(cfg, profile))) {
          if (!book.positions[mint]) break;
          const res = applySubWalletExit(book, mint, sub.subId, { priceUsd: price, ...exit, cfg, now, poolSolReserve: pools.has(mint) ? pools.get(mint) : null });
          if (res.ok) {
            if (res.poolMeasured === false) report.liquidity.flooredFills++;
            report.exits.push({
              mint, symbol: p.symbol, trigger: exit.trigger, label: exit.label,
              gainPct: exit.gainPct, subId: sub.subId, profile: sub.profile,
              impactPct: res.impactPct ?? null, poolSol: res.poolSol ?? null, poolMeasured: res.poolMeasured ?? null,
            });
          }
        }
      }
    } else {
      for (const exit of evaluatePaperExits(p, price, cfg)) {
        if (!book.positions[mint]) break;
        const res = applyPaperExit(book, mint, { priceUsd: price, ...exit, cfg, now, poolSolReserve: pools.has(mint) ? pools.get(mint) : null });
        if (res.ok) {
          if (res.poolMeasured === false) report.liquidity.flooredFills++;
          report.exits.push({
            mint, symbol: p.symbol, trigger: exit.trigger, label: exit.label, gainPct: exit.gainPct,
            impactPct: res.impactPct ?? null, poolSol: res.poolSol ?? null, poolMeasured: res.poolMeasured ?? null,
          });
        }
      }
    }
  }

  // Ledger candidates, and any chain buy whose trade row was filtered out
  // before the ordered pass. Both are order-independent by nature: the ledger
  // has no sells to interleave with.
  for (const c of candidates) {
    if (c.consumed) continue;
    c.consumed = true;
    openCandidate(c);
  }

  return report;
}

/**
 * Pick a live, liquid Solana token for a demo entry.
 *
 * A REAL token is used rather than a synthetic one precisely because the point
 * of --demo is to watch the mark move: a fabricated position would sit at its
 * entry forever and demonstrate nothing about whether pricing, marking and
 * exits actually work.
 *
 * Deepest liquidity wins, so the demo lands on something that prices reliably
 * every tick rather than a dead pair that would exercise the stale path.
 */
/**
 * Never demo on these. Excluded BY MINT, never by symbol.
 *
 * MEASURED 2026-08-12, and the reason this list exists: picking the deepest
 * search result returned mint GqR98CsEbPtV… displaying the symbol "SOL", priced
 * at $85.48 with $1.79bn of liquidity, while real WSOL/USDC on Orca was $76.22.
 * The dashboard then showed a "SOL" position beside a "SOL spot" that disagreed
 * by 12% — two different assets wearing one ticker.
 *
 * Solana's ticker namespace is unrestricted, which socialTracer's note already
 * spells out at length: it matches trending coins on contract address rather
 * than symbol precisely so a token named PENGU cannot impersonate PENGU. A
 * symbol-based exclusion here would have been the same mistake, and would not
 * have caught this one — the impostor's symbol was legitimate-looking.
 */
export const DEMO_EXCLUDED_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
].map((m) => m.toLowerCase()));

/**
 * Pick a live token for a demo entry, FROM THE OBSERVATION LEDGER.
 *
 * ── WHY NOT A DEXSCREENER NAME SEARCH, WHICH IS THE OBVIOUS IMPLEMENTATION ──
 * Because it does not return what it appears to. MEASURED 2026-08-12, the
 * deepest ten results for `q=solana` inside any sane liquidity band were TEN
 * DIFFERENT MINTS ALL SYMBOLED "SOL", priced at $84.54, $143.20, $126.10,
 * $136.47 and $138.03 — while real WSOL/USDC sat at $76.22. A name search
 * returns tokens NAMED after the query, which on Solana means ticker squatters,
 * and the first version of this function put one of them in the book beside a
 * "SOL spot" line that disagreed with it by 12%.
 *
 * The ledger has none of that problem and is the better source anyway: it is
 * exactly the universe this book mirrors, it is local, and a demo drawn from it
 * exercises the real path — the same mints, priced through the same
 * fetchPrices, marked and exited by the same rules. DEMO_EXCLUDED_MINTS still
 * applies as a backstop, by mint and never by symbol.
 *
 * Most recently seen first, because a fresh token is the one most likely to
 * still price and to move while being watched.
 */
export function demoCandidateMints(observations, { book = null, limit = 40 } = {}) {
  const held = new Set(Object.keys(book?.positions ?? {}));
  const seen = new Set();
  const rows = [];

  for (const entry of Object.values(observations?.wallets ?? {})) {
    for (const b of entry?.buys ?? []) {
      if (!b?.token || typeof b.ts !== 'number') continue;
      if (seen.has(b.token) || held.has(b.token)) continue;
      if (DEMO_EXCLUDED_MINTS.has(String(b.token).toLowerCase())) continue;
      seen.add(b.token);
      rows.push({ mint: b.token, symbol: b.symbol ?? null, ts: b.ts });
    }
  }
  return rows.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export async function pickDemoToken({ observations = null, book = null, priceFetcher = fetchPrices, limit = 40 } = {}) {
  const candidates = demoCandidateMints(observations, { book, limit });
  if (!candidates.length) return null;

  try {
    const prices = await priceFetcher(candidates.map((c) => c.mint));
    for (const c of candidates) {
      const price = prices?.get?.(c.mint);
      if (Number.isFinite(price) && price > 0) {
        return { mint: c.mint, symbol: c.symbol, priceUsd: price, observedAt: c.ts };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

/**
 * Parse a numeric CLI flag. PURE.
 *
 * Rejects a missing or non-numeric value rather than falling back to a default:
 * `--budget` with a typo'd value would otherwise silently open a book at 10 SOL
 * when the operator asked for $50, and the difference is invisible afterwards.
 */
export function numericFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return { present: false, value: null };
  const raw = argv[i + 1];
  const value = Number(String(raw ?? '').replace(/[$,]/g, ''));
  if (!Number.isFinite(value) || value <= 0) {
    return { present: true, value: null, error: `${name} needs a positive number, got ${raw ?? '(nothing)'}` };
  }
  return { present: true, value };
}

async function loadJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Wipe the terminal, scrollback included, and park the cursor at the top.
 *
 *   \x1b[2J  erase the visible screen
 *   \x1b[3J  erase the SCROLLBACK buffer
 *   \x1b[H   cursor to row 1, column 1
 *
 * ── WHY NOT console.clear() ────────────────────────────────────────────────
 * Because on the two terminals this dashboard is actually read in, it does not
 * clear. Node's console.clear() only emits an escape sequence when the stream
 * is a TTY, and the sequence it emits omits \x1b[3J — so the visible rows are
 * blanked while the scrollback survives. In the VS Code integrated terminal
 * and Windows PowerShell that reads as the dashboard scrolling away rather
 * than being replaced: the old frames are still there, just above the fold.
 * Erasing the buffer as well is what keeps ONE dashboard fixed at the top.
 *
 * \x1b[3J is a widely supported xterm extension rather than part of the
 * original spec, so a terminal that ignores it degrades to the old behaviour —
 * a cleared screen with scrollback intact — rather than printing garbage.
 *
 * STILL GUARDED ON isTTY. Piped to a file or a pager these bytes are not a
 * clear, they are three escape sequences written into the output, corrupting
 * exactly the log someone redirected for.
 */
export const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/**
 * Should this run wipe the screen between frames? PURE.
 *
 * Split out so the guard is testable without a terminal: it is the half that
 * decides whether escape bytes reach a file, and getting it wrong is silent.
 */
export function shouldWipeScreen({ intervalSec = null, isTTY = false } = {}) {
  return Boolean(intervalSec) && Boolean(isTTY);
}

/** Open-position table for the dashboard. PURE. */
export function renderPositions(book, solUsd) {
  const positions = Object.values(book?.positions ?? {});
  if (!positions.length) return '  (no open positions)';

  const rows = positions
    .sort((a, b) => (b.stakeSol ?? 0) - (a.stakeSol ?? 0))
    .map((p) => {
      const gain = p.entryPriceUsd > 0 ? (p.markPriceUsd / p.entryPriceUsd - 1) * 100 : 0;
      const valueSol = p.stakeSol * (p.entryPriceUsd > 0 ? p.markPriceUsd / p.entryPriceUsd : 1);
      const mark = Number.isFinite(solUsd) && solUsd > 0 ? usd(valueSol * solUsd, { sign: false }) : `${valueSol.toFixed(3)} SOL`;
      const tp = p.firedRungs?.length ? ` ${p.firedRungs.join(',')}` : '';
      const head =
        `  ${formatTicker(p.symbol, p.mint).padEnd(14).slice(0, 14)}` +
        `${mark.padStart(12)}` +
        `${`${gain >= 0 ? '+' : ''}${gain.toFixed(1)}%`.padStart(10)}` +
        `${p.demo ? '  [DEMO]' : ''}${tp}`;

      if (!p.subs?.length) return head;

      // ── Per sub-wallet breakdown ──────────────────────────────────────
      // Indented under the position rather than listed as separate rows: they
      // are one token at one entry price, and showing three tickers would read
      // as three positions and treble the apparent open count.
      const s = summariseSubPositions(p.subs);
      const lines = s.byProfile.map((b) => {
        const live = b.stakeSol * (p.entryPriceUsd > 0 ? p.markPriceUsd / p.entryPriceUsd : 1);
        const value = b.closed
          ? 'closed'
          : Number.isFinite(solUsd) && solUsd > 0
            ? usd(live * solUsd, { sign: false })
            : `${live.toFixed(4)} SOL`;
        const booked = b.realisedSol !== 0
          ? `  booked ${b.realisedSol >= 0 ? '+' : ''}${(Number.isFinite(solUsd) && solUsd > 0 ? b.realisedSol * solUsd : b.realisedSol).toFixed(2)}${Number.isFinite(solUsd) && solUsd > 0 ? '' : ' SOL'}`
          : '';
        const rungs = b.rungs ? `  ${b.rungs} rung${b.rungs > 1 ? 's' : ''}` : '';
        return `      ${String(b.subId)}. ${b.profile.padEnd(11)}${value.padStart(11)}${rungs}${booked}`;
      });
      return [head, ...lines].join('\n');
    });
  // Built from the same widths the rows use, so widening the ticker column
  // cannot leave the header pointing at the wrong place.
  const header = `  ${'TICKER'.padEnd(14)}${'VALUE'.padStart(12)}${'CHANGE'.padStart(10)}`;
  return [header, ...rows].join('\n');
}

export async function main(argv = []) {
  const config = await loadJson(join(HERE, 'config.json'), {});
  const cfg = paperConfig(config.paperCopytrade ?? {});
  const watchlist = await loadJson(join(HERE, config.smartMoney?.watchlistFile ?? 'smart_wallets.json'), { wallets: [] });

  // --track-whales 1 restricts BOTH the subscriptions and the trades to the
  // approved target; 5 opens the whole cluster. Parsed once and used for both,
  // so a run can never subscribe to more wallets than it will act on.
  if (argv.includes('--auto-compound')) cfg.autoCompound = true;

  const trackWhales = parseTrackWhales(argv);
  if (trackWhales.invalid) {
    console.error(`  --track-whales ${trackWhales.requested} is not a wallet count; using ${trackWhales.count}.`);
  }

  // --budget and --starting-balance are the same thing; both names are accepted
  // because both were asked for and silently honouring one would be worse than
  // accepting two.
  // --sub-wallets N splits each entry across N ladders. 0 keeps the single
  // position every measurement in this repo was taken under.
  const swIdx = argv.indexOf('--sub-wallets');
  if (swIdx !== -1) {
    const raw = Number(argv[swIdx + 1]);
    if (raw === 0) cfg.subWallets = 0;
    else {
      const r = resolveSubWallets(argv[swIdx + 1]);
      if (r.clamped) console.error(`  --sub-wallets ${argv[swIdx + 1]} is ${r.reason}; using ${r.count}.`);
      cfg.subWallets = r.count;
    }
  }

  const budgetFlag = numericFlag(argv, '--budget');
  const startFlag = numericFlag(argv, '--starting-balance');
  for (const f of [budgetFlag, startFlag]) {
    if (f.error) {
      console.error(`Error: ${f.error}`);
      process.exitCode = 1;
      return;
    }
  }
  const budgetUsd = budgetFlag.value ?? startFlag.value ?? null;

  // Proportional sizing. Applied to cfg so every downstream path — including a
  // --demo entry — sizes the same way.
  const pctFlag = numericFlag(argv, '--pct-whale');
  if (pctFlag.error) {
    console.error(`Error: ${pctFlag.error}`);
    process.exitCode = 1;
    return;
  }
  // PURE MIRROR. Re-run through paperConfig so the invariants it enforces —
  // chain feed on, sells mirrored — apply to a flag exactly as they do to a
  // config file, rather than being set here and drifting from it.
  if (argv.includes('--slot-fills')) {
    Object.assign(cfg, paperConfig({ ...cfg, slotFills: true }));
    const o = cfg.slotOffsets ?? DEFAULT_SLOT_OFFSETS;
    console.log(`Slot-latency fills: entries priced from real on-chain swaps at slot N+${o.expected}.`);
    console.log(`  Band N+${o.earliest} … N+${o.latest} reported beside every fill as an uncertainty spread.`);
    console.log('  MEASURED: the ~1.0-1.4s observation lag, which floors the window at N+3.');
    console.log(`  ASSUMED: that we would land at N+${o.expected}. Nobody has measured where our`);
    console.log('  orders land, because this book has never sent one.');
    console.log('  NOT MODELLED: our own price impact, and fill probability — the book');
    console.log('  still fills 100% of attempts.');
    console.log(`  Costs 1 + up to ${cfg.slotFillMaxLookups} RPC calls per mirrored trade.`);
    console.log('');
  }

  if (argv.includes('--pure-mirror')) {
    Object.assign(cfg, paperConfig({ ...cfg, pureMirror: true }));
    console.log('Pure mirror: the target decides every entry AND every exit.');
    console.log('  Take-profit ladder, trailing stop and hard stop are OFF.');
    console.log('  Nothing bounds a position\'s downside — a target that abandons a rug');
    console.log('  without selling never produces the exit, and the book rides it down.');
    console.log('');
  }

  // Escape hatch back to the ledger path, and a way to point at a different
  // keyless node without editing config.
  if (argv.includes('--no-chain')) cfg.rpcMirror.enabled = false;
  const rpcIdx = argv.indexOf('--rpc');
  const explicitRpc = rpcIdx !== -1 ? argv[rpcIdx + 1] : null;

  // SOLANA_RPC_URL lives in .env on this machine, not in process.env, so it is
  // resolved through loadEnv's pick() rather than read directly — see
  // resolveChainRpc.
  const { loadEnv } = await import('./telegram.mjs');
  const dotenv = await loadEnv(join(HERE, '.env')).catch(() => ({}));
  cfg.rpcMirror.url = resolveChainRpc({
    explicitUrl: explicitRpc,
    envUrl: process.env.SOLANA_RPC_URL || dotenv.rpcOverride || null,
    configUrl: config.paperCopytrade?.rpcMirror?.url ?? null,
  });

  if (pctFlag.value !== null) {
    cfg.pctWhale = pctFlag.value;
    // WARNED, NOT CLAMPED. The measured consequence is specific enough to state
    // outright, and stating it is better than silently raising the size to
    // something the operator did not ask for.
    const feeRound = cfg.feeSol * 2;
    const medianSize = 0.117 * (pctFlag.value / 100);
    console.log(
      `Proportional sizing: ${pctFlag.value}% of each whale buy` +
        (cfg.minTradeSol > 0 ? `, floor ${cfg.minTradeSol} SOL.` : '.')
    );
    // Warn once round-trip fees exceed 5% of a median-sized position. At the
    // measured median whale buy of 0.117 SOL, --pct-whale 10 gives 0.0117 SOL
    // against 0.0012 SOL of fees — 10.3%, which materially distorts a
    // scorecard and is precisely the case worth naming.
    if (medianSize > 0 && feeRound / medianSize > 0.05) {
      console.log(
        `  ⚠ the median observed whale buy is 0.117 SOL, so ${pctFlag.value}% is ~${medianSize.toFixed(4)} SOL, ` +
          `against ${feeRound.toFixed(4)} SOL of round-trip fees — roughly ` +
          `${((feeRound / medianSize) * 100).toFixed(0)}% of the position.`
      );
      console.log('    Much of the resulting PnL will be fee drag rather than the strategy.');
      console.log('    Raise --pct-whale, or set paperCopytrade.minTradeSol to skip the dust.');
    }
    console.log('');
  }

  if (argv.includes('--dashboard') && !argv.includes('--watch')) {
    console.error('Error: --dashboard needs --watch <seconds> (e.g. --watch 5) — a single tick has nothing to stream.');
    process.exitCode = 1;
    return;
  }

  // Fetched once up front: every USD figure on the dashboard derives from it,
  // and a book opened with a USD budget cannot be sized without it.
  const solUsd = (await fetchSolUsd()) ?? 75.30;
  if (budgetUsd !== null && !solUsd) {
    console.error('Error: a USD budget needs a live SOL/USD rate, and it could not be fetched.');
    process.exitCode = 1;
    return;
  }

  const freshBook = () =>
    budgetUsd !== null
      ? createBook({ budgetUsd, solUsd })
      : createBook({ budgetSol: cfg.budgetSol, ...(solUsd ? { budgetUsd: null } : {}) });

  // Checked BEFORE anything is written, because a reset performed underneath a
  // running instance is undone on its next tick and reports success meanwhile.
  const existing = await loadBook();
  const rival = existing ? detectConcurrentWriter(existing) : null;
  if (rival) {
    console.warn(`   [WARN] another paper_copytrade instance is running (pid ${rival.pid}, wrote ${rival.secondsAgo.toFixed(0)}s ago).`);
    console.warn('          It holds the book in memory and rewrites it every tick, so anything');
    console.warn('          done here — a --reset especially — will be silently overwritten.');
    console.warn('          It also still runs the module code it started with. Stop it first.');
    console.warn('');
  }

  let book = null;

  if (argv.includes('--reset')) {
    const fresh = freshBook();
    const resolved = resolveTarget(watchlist, null);
    fresh.target = resolved.target ? { ...resolved.target, since: Date.now() } : null;

    // ANCHOR THE CURSOR TO NOW, so a reset is actually a reset. Without this
    // the book is empty but the cursor is null, and the first poll walks back
    // through a whole page of history — opening positions from trades the
    // target made minutes ago, at fills that are already stale. The book then
    // reports itself as fresh while holding a window it never observed.
    //
    // The socket needs no equivalent: a subscription only ever delivers what
    // happens after it opens. This closes the poll half.
    if (fresh.target?.address) {
      if (argv.includes('--catchup')) {
        console.log('Catchup mode (--catchup): scanning recent whale trades on startup instead of ignoring past history.');
      } else {
        const anchor = await fetchLatestSignature({
          wallet: fresh.target.address,
          rpcUrl: cfg.rpcMirror.url,
        });
        if (anchor.ok) {
          fresh.lastSignature = anchor.signature;
          console.log(
            anchor.signature
              ? `Anchored at ${anchor.signature.slice(0, 12)}… — everything before it is ignored.`
              : 'Target has no transaction history yet — nothing to anchor past.'
          );
        } else {
          // Said loudly rather than swallowed: an unanchored reset silently
          // replays history, which is exactly what anchoring exists to stop, and
          // it looks identical to a working fresh book.
          console.warn(`   [WARN] could not read the latest signature (${anchor.error}).`);
          console.warn('          This book will replay recent history on its first tick.');
          console.warn('          Re-run --reset once the node answers to start genuinely clean.');
        }
      }
    }

    await saveBook(fresh);
    console.log(
      budgetUsd !== null
        ? `Fresh paper book at ${usd(budgetUsd, { sign: false })} (${fresh.budgetSol.toFixed(3)} SOL @ ${usd(solUsd, { sign: false })}/SOL).`
        : `Fresh paper book at ${fresh.budgetSol.toFixed(3)} virtual SOL.`
    );
    console.log('Waiting for the target to trade — nothing is mirrored until it does.');
    if (!argv.includes('--watch')) {
      console.log(renderScorecard(paperScorecard(fresh, cfg), { solUsd }));
      return;
    }
    book = fresh;
  } else {
    book = await loadBook();
    if (!book) {
      book = freshBook();
      console.log(
        budgetUsd !== null
          ? `No paper book found — starting one at ${usd(budgetUsd, { sign: false })}.`
          : `No paper book found — starting one at ${book.budgetSol.toFixed(3)} virtual SOL.`
      );
    } else if (budgetUsd !== null) {
      // An existing book is NOT silently re-funded. Changing the budget under a
      // running book would rewrite the denominator of every percentage already
      // reported, so the operator is told how to do it deliberately.
      console.log(
        `Note: a book already exists (${book.budgetSol.toFixed(3)} SOL). ` +
          `--budget only applies to a new book — add --reset to start over at ${usd(budgetUsd, { sign: false })}.`
      );
    }
  }

  if (argv.includes('--target')) {
    const r = resolveTarget(watchlist, book);
    console.log(`Active target: ${r.target?.label ?? r.target?.address ?? '(none)'}`);
    console.log(`   address: ${r.target?.address ?? '-'}`);
    console.log(`   reason : ${r.reason}`);
    return;
  }

  if (argv.includes('--demo')) {
    const demoObservations = await loadObservations(join(HERE, '.state', 'wallet_observations.json'));
    const token = await pickDemoToken({ observations: demoObservations, book });
    if (!token) {
      console.error(
        'No demo token available — the observation ledger has no recently-seen mint that still prices.\n' +
          'Run a scan first so the ledger has something in it.'
      );
      process.exitCode = 1;
      return;
    }
    const res = openPaperPosition(book, {
      mint: token.mint,
      symbol: token.symbol,
      priceUsd: token.priceUsd,
      cfg,
      now: Date.now(),
      source: 'demo',
      demo: true,
    });
    if (!res.ok) {
      console.error(`Demo trade declined: ${res.reason}`);
      process.exitCode = 1;
      return;
    }
    await saveBook(book);
    console.log(
      `DEMO PAPER BUY ${formatTicker(token.symbol, token.mint)} — ` +
        `${res.sizeSol.toFixed(3)} SOL${solUsd ? ` (${usd(res.sizeSol * solUsd, { sign: false })})` : ''} @ $${token.priceUsd.toPrecision(4)}`
    );
    console.log('This position is TAGGED as a demo and is not mirrored from the target.');
    console.log('It obeys the same exit rules; --reset clears it.\n');
  }

  if (argv.includes('--scorecard')) {
    // No socket on the one-shot path, so the count comes from what a watch run
    // WOULD subscribe to rather than from a live cluster.
    const wouldTrack = resolveTargets(watchlist, book, { limit: trackWhales.count }).targets.length;
    console.log(renderScorecard({ ...paperScorecard(book, cfg), modeLine: renderModeLine(cfg, { trackedWhales: wouldTrack }) }, { solUsd }));
    console.log(renderPositions(book, solUsd));
    return;
  }

  const watchIndex = argv.indexOf('--watch');
  const intervalSec = watchIndex !== -1 ? Number(argv[watchIndex + 1]) || 60 : null;
  // A cleared screen is only a dashboard on a terminal. Piped to a file or
  // through a pager, the wipe sequence is not a clear — it is escape bytes
  // written into the output, corrupting the log someone redirected for.
  const canClear = shouldWipeScreen({ intervalSec, isTTY: process.stdout.isTTY });

  const recent = [];
  // The web feed. Separate from `recent` on purpose — see the push loop below.
  const webActivity = [];

  let dash = null;
  let dashBannerLine = '';
  let lastWhaleEventAt = null;
  let lastMarkAt = null;

  if (argv.includes('--dashboard')) {
    if (!intervalSec) {
      console.error('Error: --dashboard needs --watch <seconds> — a single tick has nothing to stream.');
      process.exitCode = 1;
      return;
    }
    const portFlag = numericFlag(argv, '--dashboard-port');
    if (portFlag.error) {
      console.error(`Error: ${portFlag.error}`);
      process.exitCode = 1;
      return;
    }
    const { startDashboard, dashboardBanner, DEFAULT_DASHBOARD_PORT, DEFAULT_DASHBOARD_HOST } =
      await import('./dashboard.mjs');

    const hostIndex = argv.indexOf('--dashboard-host');
    const dashHost = hostIndex !== -1 ? String(argv[hostIndex + 1] ?? '') : DEFAULT_DASHBOARD_HOST;
    const embed = argv.includes('--dashboard-embed');

    const started = await startDashboard({
      host: dashHost || DEFAULT_DASHBOARD_HOST,
      port: portFlag.value ?? DEFAULT_DASHBOARD_PORT,
      embed,
      book,
      cfg,
      getContext: () => ({
        solUsd: spotCache.value,
        socket:
          typeof socket?.isConnected === 'function'
            ? socket.isConnected()
              ? 'connected'
              : 'disconnected'
            : socketEnabled
              ? 'disconnected'
              : 'off',
        newestWhaleEventAt: lastWhaleEventAt,
        lastMarkAt: lastMarkAt,
        // NOT `recent` — that one is capped at 6 for the terminal's fixed
        // height, and handing it over capped the web log to 6 as well.
        activity: webActivity,
      }),
    });

    if (!started.ok) {
      console.error(`  DASHBOARD  not started — ${started.message}`);
    } else {
      dash = started;
      dashBannerLine =
        dashboardBanner(started.urls, { isTTY: process.stdout.isTTY }) +
        (embed ? '\n  TIER B ENABLED — loading a market chart tells dexscreener.com which mint you hold' : '');
    }
  }

  // ---- websocket wallet listener -----------------------------------
  //
  // Created lazily, from the target the book has actually resolved, and torn
  // down and rebuilt if that target changes — another wallet's notifications
  // are not this one's.
  //
  // The POLL REMAINS as the fallback path rather than being deleted. A socket
  // that has dropped and is backing off produces no trades, which is
  // indistinguishable from a quiet whale; falling back to fetchWhaleTrades
  // means an outage costs latency instead of coverage. Both feed the same
  // signature dedupe in runPaperTick, so an overlap cannot double-apply.
  let socket = null;
  let trackedWhaleCount = null;
  let lastCompound = null;
  const socketEnabled = cfg.rpcMirror?.enabled && cfg.rpcMirror?.socket !== false && Boolean(intervalSec);

  /**
   * One subscription per ENABLED wallet, rebuilt only when the set changes.
   *
   * ── WHY THE WHOLE WATCHLIST, NOT JUST THE TARGET ──────────────────────────
   * logsSubscribe filters on `mentions`, which takes one address, so four
   * whales is four subscriptions. They are opened together and torn down
   * together: rebuilding on every tick would drop and re-open four sockets a
   * second, and a subscription only covers what happens AFTER it opens, so
   * every rebuild is a hole in coverage.
   *
   * The identity key is the wallet SET, not the primary target. Keyed on the
   * target alone, a sync that added a fifth whale would leave it unsubscribed
   * until the target happened to change — silently tracking four of five while
   * reporting five.
   */
  const ensureSocket = () => {
    if (!socketEnabled) return null;
    const tracked = resolveTargets(watchlist, book, { limit: trackWhales.count }).targets;
    if (!tracked.length) return null;

    const key = tracked.map((t) => t.address).join(',');
    if (socket && socket.key === key) return socket;
    socket?.close();
    socket = createWhaleCluster({
      wallets: tracked,
      rpcUrl: cfg.rpcMirror.url,
      cfg: cfg.rpcMirror,
      log: console.log,
    });
    socket.key = key;
    trackedWhaleCount = tracked.length;
    console.log(`  ${trackingHeader(tracked.length, { requested: trackWhales.requested })}`);
    console.log(`  socket: ${tracked.length} concurrent subscription(s) — ${tracked.map((t) => t.address.slice(0, 8)).join(', ')}`);
    return socket;
  };

  // Signatures the poll knows about and has not read yet. Tracked across ticks
  // because handing over to the socket while this is non-zero ORPHANS them:
  // the subscription only covers what happens after it opens, so nothing would
  // ever go back for the gap.
  //
  // OBSERVED before this existed: a cold start logged "12 new tx, 9 queued",
  // the socket connected on the next tick, and those 9 were never read. Stale
  // BUYS would have been filtered by maxBuyAgeMinutes anyway — but SELLS are
  // not age-bounded, and a missed sell leaves the book holding a position the
  // target has already exited.
  let pollBacklog = Infinity; // unknown until the first poll answers

  const chainFetcher = async (args) => {
    const s = ensureSocket();
    const socketLive = Boolean(s?.isConnected());

    // Whatever the socket has resolved is always taken — it is free and already
    // parsed, and dropping it while catching up would lose live trades.
    const drained = socketLive ? await s.drain() : null;
    // The cluster reports a cursor PER WALLET; the poll cursor belongs to the
    // primary alone. Advancing it from another whale's signature would skip
    // the primary's history between the two, which is how a poll fallback
    // silently loses the trades it exists to catch.
    const fromSocket = drained
      ? { ...drained, newestSignature: drained.cursors?.[book.target?.address] ?? null }
      : null;

    // Poll while the socket is down, and keep polling until the backlog it
    // inherited is drained. Once caught up the socket carries it alone.
    const needPoll = !socketLive || pollBacklog > 0;
    const polled = needPoll ? await fetchWhaleTrades(args) : null;
    if (polled?.ok) pollBacklog = polled.pending ?? 0;

    if (!polled) return { ...fromSocket, source: 'socket' };
    if (!fromSocket) return { ...polled, source: 'poll' };

    // Both ran. Poll trades are older, so they lead; runPaperTick's signature
    // dedupe absorbs any overlap between the two feeds.
    return {
      ok: polled.ok || fromSocket.ok,
      error: polled.ok ? null : polled.error,
      trades: [...(polled.trades ?? []), ...(fromSocket.trades ?? [])],
      newestSignature: polled.newestSignature ?? null,
      scanned: (polled.scanned ?? 0) + (fromSocket.scanned ?? 0),
      pending: polled.pending ?? 0,
      source: 'socket+poll',
    };
  };

  // ── WHAT A 5-SECOND CADENCE COSTS, AND WHAT IS DONE ABOUT IT ─────────────
  // A naive tick re-reads the observation ledger and re-fetches the SOL price
  // every pass. At 60s that is unremarkable; at 5s it is 12 reads a minute of a
  // ~16 MB JSON file and 24 DexScreener calls a minute, most of them returning
  // exactly what the previous one did.
  //
  // The ledger is therefore reloaded only when the FILE HAS CHANGED — the
  // scanner writes it, so its mtime is the honest signal, and between writes a
  // re-read cannot produce a different answer. The SOL price is refreshed on a
  // floor of its own because spot does not meaningfully move in five seconds,
  // while token prices do and are still fetched every tick.
  const obsPath = join(HERE, '.state', 'wallet_observations.json');
  let obsCache = { mtimeMs: null, value: null };
  let spotCache = { at: 0, value: solUsd };
  const SPOT_REFRESH_MS = 30_000;

  const loadObservationsCached = async () => {
    try {
      const { stat } = await import('node:fs/promises');
      const { mtimeMs } = await stat(obsPath);
      if (obsCache.value && obsCache.mtimeMs === mtimeMs) return obsCache.value;
      const value = await loadObservations(obsPath);
      obsCache = { mtimeMs, value };
      return value;
    } catch {
      // stat failed — fall back to a plain read rather than mirroring nothing.
      return loadObservations(obsPath);
    }
  };

  const tick = async () => {
    const observations = intervalSec ? await loadObservationsCached() : await loadObservations(obsPath);
    const report = await runPaperTick({ book, observations, watchlist, cfg, tradeFetcher: chainFetcher, solUsd: spotCache.value });
    // Remembered so the MODE line reports the live multiple rather than
    // re-deriving it and risking a different answer from the one that sized
    // the trades in this very tick.
    lastCompound = report.compound ?? lastCompound;
    await saveBook(book);

    // Freshness inputs for the dashboard header. `marked` counts positions
    // re-priced this tick, so a run where every price lookup failed leaves
    // lastMarkAt where it was and the page says so instead of implying the
    // marks are current.
    if (report.marked > 0) lastMarkAt = Date.now();
    if (report.opened.length || report.exits.length) lastWhaleEventAt = Date.now();

    let spot = spotCache.value;
    if (Date.now() - spotCache.at >= SPOT_REFRESH_MS) {
      spot = (await fetchSolUsd()) ?? spotCache.value ?? solUsd;
      spotCache = { at: Date.now(), value: spot };
    }

    const stamp = new Date().toISOString().slice(11, 19);
    for (const o of report.opened) {
      // The basis is shown because with --pct-whale the size is the interesting
      // half: "0.012 SOL" alone does not say whether that was 10% of a nibble
      // or a cap biting on a conviction buy.
      // STORED STRUCTURED, RENDERED LATER. An entry that priced itself from the
      // swap has no ticker yet — balance deltas carry no name and the pair
      // lookup was deliberately skipped — so formatting the line here froze a
      // raw mint into it forever, even after the position learned its symbol on
      // the next mark. The dashboard redraws in full every tick, so the line
      // can simply be re-rendered with whatever is known by then.
      recent.push({
        stamp,
        kind: o.scaledIn ? 'ADD ' : 'BUY ',
        mint: o.mint,
        // Credited to the wallet that opened it — with four whales mirrored and
        // exits whale-specific, an unattributed line cannot say which sell to
        // expect.
        whale: whaleTag(o.originatingWhale, watchlist)?.text ?? null,
        tail:
          ` — ${o.sizeSol.toFixed(4)} SOL` +
          (o.basis && cfg.pctWhale ? `  (${o.basis})` : '') +
          liquidityTag(o) +
          (o.scaledIn && Number.isFinite(o.blendedEntryUsd)
            ? `  entry now $${o.blendedEntryUsd.toPrecision(4)}`
            : '') +
          (o.whale ? `  (${o.whale})` : ''),
      });
    }
    for (const e of report.exits) {
      recent.push({
        stamp,
        kind: 'SELL',
        mint: e.mint,
        whale: whaleTag(e.seller, watchlist, { withWinRate: false })?.text ?? null,
        tail:
          ` — ${e.label ?? e.trigger}` +
          `${Number.isFinite(e.gainPct) ? ` (${e.gainPct >= 0 ? '+' : ''}${e.gainPct.toFixed(0)}%)` : ''}` +
          liquidityTag(e) +
          (e.whale ? `  (${e.whale})` : ''),
      });
    }
    // ── THE WEB FEED IS A SEPARATE ARRAY, AND IT HAS TO BE ────────────────
    // `recent` is capped at 6 immediately below because the TERMINAL is
    // fixed-height. Handing that same array to the dashboard — which is what
    // this did until now — meant the web activity log was silently capped at 6
    // as well, while the plan claimed it kept the whole session. A scrolling
    // DOM panel is one of the few things the terminal structurally cannot do,
    // and it was being thrown away by an aliasing bug.
    //
    // These rows are also STRUCTURED rather than pre-formatted: the ticker
    // needs the SOL figure, the fill slot, the drag against the target's own
    // fill and the signature as separate fields, and a rendered string cannot
    // be taken apart again.
    for (const o of report.opened) {
      const ourFill = o.entryPriceUsd;
      const theirFill = o.whaleFillUsd;
      webActivity.push({
        stamp,
        at: Date.now(),
        kind: o.scaledIn ? 'ADD' : 'BUY',
        mint: o.mint,
        symbol: o.symbol ?? null,
        sizeSol: o.sizeSol ?? null,
        signature: o.signature ?? null,
        whale: whaleTag(o.originatingWhale, watchlist)?.text ?? null,
        impactPct: o.impactPct ?? null,
        poolMeasured: o.poolMeasured ?? null,
        liquidityCapped: o.liquidityCapped === true,
        fillSlotOffset: o.executionBand?.fillSlotOffset ?? null,
        fillLagMs: o.executionBand?.fillLagMs ?? null,
        // What arriving late cost, against the price the target actually got.
        // Null when either side is unknown rather than 0, which would read as
        // "we matched them".
        dragPct:
          Number.isFinite(ourFill) && Number.isFinite(theirFill) && theirFill > 0
            ? (ourFill / theirFill - 1) * 100
            : null,
      });
    }
    for (const e of report.exits) {
      webActivity.push({
        stamp,
        at: Date.now(),
        kind: 'SELL',
        mint: e.mint,
        symbol: e.symbol ?? null,
        sizeSol: e.proceedsSol ?? null,
        signature: e.signature ?? null,
        whale: whaleTag(e.seller, watchlist, { withWinRate: false })?.text ?? null,
        trigger: e.label ?? e.trigger ?? null,
        gainPct: Number.isFinite(e.gainPct) ? e.gainPct : null,
        impactPct: e.impactPct ?? null,
        poolMeasured: e.poolMeasured ?? null,
      });
    }
    while (webActivity.length > WEB_ACTIVITY_LIMIT) webActivity.shift();

    // Bounded, because the dashboard is fixed-height by design — an unbounded
    // activity log would push the numbers off the screen, which is the exact
    // scrolling this mode exists to stop.
    while (recent.length > 6) recent.shift();

    // Written in one call so the wipe and the redraw cannot be interleaved by
    // anything else writing to stdout between them, which shows as a flash of
    // empty terminal on a fast cadence.
    if (canClear) process.stdout.write(CLEAR_SCREEN);
    console.log(renderScorecard({ ...paperScorecard(book, cfg), modeLine: renderModeLine(cfg, { trackedWhales: trackedWhaleCount, compound: lastCompound }) }, { solUsd: spot }));
    console.log(renderPositions(book, spot));
    if (report.compound?.active) {
      const c = report.compound;
      console.log(
        `
  COMPOUND SIZING: Active (Effective %-Whale: ${c.effectivePctWhale}%)` +
          `  ${c.multiple.toFixed(2)}x of base ${cfg.pctWhale}%` +
          (c.reason ? `
     ${c.reason}` : '')
      );
    }
    if (recent.length) {
      console.log('\n  RECENT ACTIVITY');
      // Resolved at render time from whatever the book knows NOW — an open
      // position first, then the most recent closed row for that mint, so a
      // line written before the ticker was known picks it up on the next
      // redraw instead of keeping a mint forever.
      const symbolFor = (mint) => {
        if (book.positions[mint]?.symbol) return book.positions[mint].symbol;
        for (let i = book.closed.length - 1; i >= 0; i--) {
          if (book.closed[i].mint === mint && book.closed[i].symbol) return book.closed[i].symbol;
        }
        return null;
      };
      for (const r of recent) {
        console.log(`  [${r.stamp}] ${r.kind} ${formatTicker(symbolFor(r.mint), r.mint)}${r.tail}`);
      }
    }
    // The chain line is load-bearing on a dashboard that otherwise looks
    // identical whether the mirror is live or silently failing: an unreachable
    // RPC produces no buys, and "no buys" is exactly what a quiet whale looks
    // like too.
    if (cfg.rpcMirror?.enabled) {
      const c = report.chain;
      const host = new URL(cfg.rpcMirror.url).host;
      // The cost label follows the HOST. It read "0 Helius credits"
      // unconditionally, which was true while the mirror defaulted to the
      // public node and became a lie the moment it pointed at Helius — a
      // dashboard asserting a bill of zero while metering an account.
      const billed = /helius/i.test(host);
      // The FEED matters more than the host now: a run silently falling back to
      // polling looks identical to one on the socket except for tens of seconds
      // of lag, which is the whole reason the socket exists.
      const s = typeof socket?.status === 'function' ? socket.status() : null;
      const isConnected = typeof socket?.isConnected === 'function' ? socket.isConnected() : false;
      const feed = !isConnected
        ? socketEnabled
          ? 'poll (socket down)'
          : 'poll'
        : c?.pending
          ? `SOCKET (push) + poll catch-up, ${c.pending} left`
          : 'SOCKET (push)';
      console.log(
        `\n  CHAIN  ${c?.ok ? 'live' : `UNREACHABLE — ${c?.error ?? 'unknown'}`}` +
          ` · ${host} · ${billed ? 'BILLED to Helius' : '0 Helius credits'}` +
          (c?.ok ? ` · ${c.scanned} new tx${c.pending ? `, ${c.pending} queued` : ''}` : '')
      );
      console.log(
        `  FEED   ${feed}` +
          // SUBSCRIPTION COVERAGE LEADS, because its absence is what made the
          // connection-cap bug invisible: four of five wallets silently
          // unsubscribed looked exactly like four quiet whales. A count that
          // does not match the tracked total is the single most important
          // thing on this line.
          (s?.subscribed && trackedWhaleCount
            ? ` · ${s.subscribed.length}/${trackedWhaleCount} subscribed`
            : '') +
          (s?.missing?.length ? `  ⛔ ${s.missing.map((a) => a.slice(0, 8) + '…').join(', ')} NOT SUBSCRIBED` : '') +
          (s ? ` · ${s.stats.notifications} notified, ${s.stats.resolved} resolved` : '') +
          (s?.stats.unattributed ? `, ${s.stats.unattributed} unattributed` : '') +
          // Retrying and abandoned are different facts: one is in flight, the
          // other is a trade this book will never see. Only the second is a
          // hole in the mirror, so they are never merged into one counter.
          (s?.pendingRetry?.length ? `, ${s.pendingRetry.length} retrying` : '') +
          (s?.stats.recovered ? `, ${s.stats.recovered} recovered` : '') +
          (s?.stats.abandoned ? `, ${s.stats.abandoned} ABANDONED` : '') +
          (s?.stats.reconnects ? ` · ${s.stats.reconnects} reconnect(s)` : '') +
          (!socket?.isConnected() && s?.lastError ? ` · ${s.lastError}` : '')
      );
    }
    // DECLINES ARE REPORTED, because their absence is what makes a full book
    // look like a broken one. A target buy that the engine correctly refused —
    // no balance, at the position cap — is indistinguishable from a trade that
    // never arrived unless the reason is on screen. Audited against chain: 4 of
    // 12 of the target's swaps went unmirrored, all of them because the book
    // was at 6/6 positions with 0.000 SOL free, and none because the feed
    // dropped anything.
    if (report.declined?.length) {
      const byReason = report.declined.reduce((a, d) => ((a[d.reason] = (a[d.reason] ?? 0) + 1), a), {});
      const parts = Object.entries(byReason).map(([r, n]) => `${n}x ${r}`);
      console.log(`  SKIPPED ${report.declined.length} target buy(s) — ${parts.join(' · ')}`);
    }
    if (cfg.pureMirror) {
      console.log('  MODE   pure mirror — no take-profit, no stop-loss; the target decides');
      // Silence here would be the dangerous kind: equity counts these at their
      // last mark, and with no stale exit they never leave the book.
      if (report.unpriced) {
        console.log(
          `  ⚠ ${report.unpriced} position(s) could not be priced — held at last mark, so equity may overstate.`
        );
      }
    }
    if (intervalSec) {
      console.log(`  updated ${stamp} · every ${intervalSec}s · Ctrl+C to stop`);
    }

    // ── PUSH TO THE BROWSER, LAST ────────────────────────────────────────
    // After saveBook and after the spot refresh, so a frame never shows a book
    // state the engine has not finished writing or a price it is about to
    // replace. One frame per tick: the engine produces new state once per tick,
    // and emitting more often re-sends identical bytes.
    if (dash) {
      dash.publish(report);
      // Every frame, not once at startup — see dashBannerLine's assignment.
      console.log(`${dashBannerLine}${dash.clients() ? `  ·  ${dash.clients()} viewer(s)` : ''}`);
    }
  };

  try {
    await tick();
  } catch (err) {
    console.error('CRITICAL TICK ERROR:', err);
    throw err;
  }
  if (intervalSec) {
    // Keep a persistent timer active on Node's event loop so it never drains.
    const keepalive = setInterval(() => {}, 60_000);
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
        try {
          await tick();
        } catch (err) {
          console.error('CRITICAL TICK ERROR IN LOOP:', err);
        }
      }
    } finally {
      clearInterval(keepalive);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('CRITICAL MAIN ERROR:', err);
  });
}
