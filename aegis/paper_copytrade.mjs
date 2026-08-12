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

import { fetchPairsBatch } from './sources.mjs';
import { loadObservations } from './wallet_observations.mjs';

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
  maxOpenPositions: 6,
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
  // LIVE ON-CHAIN MIRROR. Reads the target's own transactions from a free
  // public RPC — 0 Helius credits — instead of waiting for the observation
  // ledger. Sees sells too, which the ledger never recorded.
  rpcMirror: {
    enabled: true,
    url: 'https://api.mainnet-beta.solana.com',
    signatureLimit: 25,
    maxTxLookupsPerTick: 12,
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
  cfg.rpcMirror = { ...PAPER_DEFAULTS.rpcMirror, ...(cfg.rpcMirror ?? {}) };
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
export function mirrorPositionSize(cfg, { whaleSpendSol = null, balanceSol = 0 } = {}) {
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
  const sizeSol = Math.min(target, spendable);
  if (!(sizeSol > 0)) return { ok: false, reason: 'insufficient virtual balance', basis };

  return { ok: true, sizeSol, basis, capped: sizeSol < target };
}

/**
 * Record a paper entry. PURE — mutates and returns the book, no clock, no IO.
 *
 * Returns a reason instead of throwing when the trade is declined, because
 * "no balance" and "already holding" are ordinary outcomes of a tick and the
 * caller reports them rather than failing.
 */
export function openPaperPosition(book, { mint, symbol = null, priceUsd, cfg, now = Date.now(), source = null, demo = false, whaleSpendSol = null }) {
  if (!mint) return { ok: false, reason: 'no mint' };
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { ok: false, reason: 'no usable price' };
  if (book.positions[mint]) return { ok: false, reason: 'already holding' };

  const open = Object.keys(book.positions).length;
  if (open >= cfg.maxOpenPositions) return { ok: false, reason: `at max open positions (${cfg.maxOpenPositions})` };

  const sized = mirrorPositionSize(cfg, { whaleSpendSol, balanceSol: book.balanceSol });
  if (!sized.ok) return { ok: false, reason: sized.reason };
  const size = sized.sizeSol;

  // Slippage raises the effective entry price. Modelled on the PRICE rather
  // than skimmed off the size, so the position's whole P&L curve carries it —
  // taking it off the size instead would make a 1.5% cost vanish the moment
  // the token moved.
  const fillPriceUsd = priceUsd * (1 + cfg.slippagePct / 100);

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
    source,
    // Tagged so the scorecard can disclose that a number includes trades that
    // were never mirrored from the target.
    ...(demo ? { demo: true } : {}),
    lastPricedAt: now,
  };
  return { ok: true, position: book.positions[mint], sizeSol: size, basis: sized.basis, capped: sized.capped };
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
export function applyPaperExit(book, mint, { priceUsd, trigger, sellFraction = 1, cfg, now = Date.now(), label = null }) {
  const p = book.positions[mint];
  if (!p) return { ok: false, reason: 'no such position' };
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { ok: false, reason: 'no usable price' };

  const exitPriceUsd = priceUsd * (1 - cfg.slippagePct / 100);
  const fraction = Math.min(1, Math.max(0, sellFraction));
  const costBasisSold = p.stakeSol * fraction;
  const multiple = exitPriceUsd / p.entryPriceUsd;
  const proceeds = costBasisSold * multiple;

  book.balanceSol += proceeds - cfg.feeSol;
  p.stakeSol -= costBasisSold;
  p.realisedSol += proceeds - costBasisSold - cfg.feeSol;
  if (trigger?.startsWith('TP')) p.firedRungs.push(trigger);
  p.markPriceUsd = priceUsd;
  p.lastPricedAt = now;

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
    });
    delete book.positions[mint];
  }
  return { ok: true, proceedsSol: proceeds, closed: fullyClosed, trigger };
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
  const seen = new Set([
    ...Object.keys(book.positions ?? {}),
    ...(book.closed ?? []).map((c) => c.mint),
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
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Minimal JSON-RPC. No key, no provider-specific extensions. */
export async function solanaRpc(url, method, params, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    if (body?.error) return { ok: false, error: body.error.message ?? 'rpc error' };
    return { ok: true, result: body?.result ?? null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
 * WSOL is skipped for the same reason computeOnChainWinRate skips it: it is the
 * SOL side of the swap wearing a token's clothes, and counting it would make
 * every trade look like a WSOL round trip.
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
  const solDelta = (post - pre) / 1e9;

  const owned = (rows) => {
    const m = new Map();
    for (const b of rows ?? []) {
      if (b?.owner !== wallet || !b?.mint || b.mint === WSOL_MINT) continue;
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
  await writeFile(path, JSON.stringify(book, null, 2), 'utf8');
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
export async function fetchPrices(mints, { batchFetcher = fetchPairsBatch } = {}) {
  const prices = new Map();
  if (!mints?.length) return prices;

  const byAddress = await batchFetcher(mints).catch(() => new Map());
  if (!byAddress || typeof byAddress.get !== 'function') return prices;

  for (const mint of mints) {
    const pair = byAddress.get(String(mint).toLowerCase());
    const price = Number(pair?.priceUsd);
    if (Number.isFinite(price) && price > 0) prices.set(mint, price);
  }
  return prices;
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
  priceFetcher = fetchPrices,
  tradeFetcher = fetchWhaleTrades,
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
  let liveSells = [];
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
      for (const t of live.trades) {
        if (t.kind === 'BUY') liveBuys.push(t);
        else if (t.kind === 'SELL') liveSells.push(t);
      }
    }
  }

  // Chain buys take precedence: they carry the real spend and arrive seconds
  // after the trade rather than at scan cadence. The ledger path stays as a
  // fallback for a run with the mirror disabled.
  const ledgerCandidates = cfg.rpcMirror?.enabled
    ? []
    : pendingMirrorBuys(observations, { target: book.target, book, cfg, now });
  const held = new Set(Object.keys(book.positions));
  const everSeen = new Set([...held, ...(book.closed ?? []).map((c) => c.mint)]);
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
      .map((t) => ({ mint: t.mint, symbol: null, observedAt: t.blockTime ?? now, whaleSpendSol: t.solSpent })),
    ...ledgerCandidates,
  ];
  if (report.chain) report.chain.staleSkipped = staleChainBuys;
  const openMints = Object.keys(book.positions);
  const needPrices = [...new Set([...openMints, ...candidates.map((c) => c.mint)])];
  const prices = await priceFetcher(needPrices);

  // Mark first, so an exit fires on this tick's price rather than last tick's.
  for (const mint of openMints) {
    const price = prices.get(mint);
    if (Number.isFinite(price)) {
      markPosition(book.positions[mint], price, now);
      report.marked++;
    }
  }

  // ---- mirrored sells, BEFORE the paper's own exit rules -----------
  //
  // The target leaving a position is a stronger signal than any threshold this
  // engine computes: it is the person being copied acting on the trade, while
  // a trailing stop is an inference from price. So a whale exit is applied
  // first, and the ladder and stops below then run on whatever remains.
  //
  // PROPORTIONAL, using the fraction of THEIR bag they actually sold — the
  // pre-balance is in the same payload. Selling 40% closes 40% of the paper
  // position, so a partial de-risk is mirrored as a partial de-risk rather
  // than being rounded up into a full exit.
  if (cfg.rpcMirror?.mirrorSells !== false) {
    for (const sell of liveSells) {
      const p = book.positions[sell.mint];
      if (!p) continue;
      const price = prices.get(sell.mint) ?? p.markPriceUsd;
      if (!Number.isFinite(price) || price <= 0) continue;
      const fraction = Number.isFinite(sell.sellFraction) ? sell.sellFraction : 1;
      const res = applyPaperExit(book, sell.mint, {
        priceUsd: price,
        trigger: 'WHALE_SELL',
        sellFraction: fraction,
        cfg,
        now,
        label: `target sold ${(fraction * 100).toFixed(0)}% of its bag`,
      });
      if (res.ok) {
        report.exits.push({
          mint: sell.mint,
          symbol: p.symbol,
          trigger: 'WHALE_SELL',
          label: `target sold ${(fraction * 100).toFixed(0)}%`,
          gainPct: p.entryPriceUsd > 0 ? (price / p.entryPriceUsd - 1) * 100 : null,
        });
      }
    }
  }

  // Exits before entries: freeing balance first lets a tick that closes a
  // position also open one, which is what a real book would do.
  for (const mint of openMints) {
    const p = book.positions[mint];
    if (!p) continue;
    const price = prices.get(mint);
    if (!Number.isFinite(price)) {
      const ageH = (now - (p.lastPricedAt ?? p.openedAt)) / 3.6e6;
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
        });
        report.exits.push({ mint, trigger: 'STALE' });
      }
      continue;
    }
    for (const exit of evaluatePaperExits(p, price, cfg)) {
      if (!book.positions[mint]) break;
      const res = applyPaperExit(book, mint, { priceUsd: price, ...exit, cfg, now });
      if (res.ok) report.exits.push({ mint, symbol: p.symbol, trigger: exit.trigger, label: exit.label, gainPct: exit.gainPct });
    }
  }

  for (const c of candidates) {
    const price = prices.get(c.mint);
    const res = openPaperPosition(book, {
      mint: c.mint,
      symbol: c.symbol,
      priceUsd: price,
      cfg,
      now,
      source: book.target?.address ?? null,
      whaleSpendSol: c.whaleSpendSol ?? null,
    });
    if (res.ok) {
      report.opened.push({
        mint: c.mint,
        symbol: c.symbol,
        sizeSol: res.sizeSol,
        basis: res.basis ?? null,
        whaleSpendSol: c.whaleSpendSol ?? null,
      });
    } else report.declined.push({ mint: c.mint, reason: res.reason });
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
      return (
        `  ${(p.symbol ?? p.mint.slice(0, 8)).padEnd(12).slice(0, 12)}` +
        `${mark.padStart(12)}` +
        `${`${gain >= 0 ? '+' : ''}${gain.toFixed(1)}%`.padStart(10)}` +
        `${p.demo ? '  [DEMO]' : ''}${tp}`
      );
    });
  return ['  POSITION         VALUE     CHANGE', ...rows].join('\n');
}

export async function main(argv = []) {
  const config = await loadJson(join(HERE, 'config.json'), {});
  const cfg = paperConfig(config.paperCopytrade ?? {});
  const watchlist = await loadJson(join(HERE, config.smartMoney?.watchlistFile ?? 'smart_wallets.json'), { wallets: [] });

  // --budget and --starting-balance are the same thing; both names are accepted
  // because both were asked for and silently honouring one would be worse than
  // accepting two.
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
  // Escape hatch back to the ledger path, and a way to point at a different
  // keyless node without editing config.
  if (argv.includes('--no-chain')) cfg.rpcMirror.enabled = false;
  const rpcIdx = argv.indexOf('--rpc');
  if (rpcIdx !== -1 && /^https?:\/\//.test(String(argv[rpcIdx + 1] ?? ''))) {
    cfg.rpcMirror.url = argv[rpcIdx + 1];
  }

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

  // Fetched once up front: every USD figure on the dashboard derives from it,
  // and a book opened with a USD budget cannot be sized without it.
  const solUsd = await fetchSolUsd();
  if (budgetUsd !== null && !solUsd) {
    console.error('Error: a USD budget needs a live SOL/USD rate, and it could not be fetched.');
    process.exitCode = 1;
    return;
  }

  const freshBook = () =>
    budgetUsd !== null
      ? createBook({ budgetUsd, solUsd })
      : createBook({ budgetSol: cfg.budgetSol, ...(solUsd ? { budgetUsd: null } : {}) });

  if (argv.includes('--reset')) {
    const fresh = freshBook();
    const resolved = resolveTarget(watchlist, null);
    fresh.target = resolved.target ? { ...resolved.target, since: Date.now() } : null;
    await saveBook(fresh);
    console.log(
      budgetUsd !== null
        ? `Fresh paper book at ${usd(budgetUsd, { sign: false })} (${fresh.budgetSol.toFixed(3)} SOL @ ${usd(solUsd, { sign: false })}/SOL).`
        : `Fresh paper book at ${fresh.budgetSol.toFixed(3)} virtual SOL.`
    );
    if (!argv.includes('--watch')) {
      console.log(renderScorecard(paperScorecard(fresh, cfg), { solUsd }));
      return;
    }
  }

  let book = await loadBook();
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
      `DEMO PAPER BUY ${token.symbol ?? token.mint.slice(0, 8)} — ` +
        `${res.sizeSol.toFixed(3)} SOL${solUsd ? ` (${usd(res.sizeSol * solUsd, { sign: false })})` : ''} @ $${token.priceUsd.toPrecision(4)}`
    );
    console.log('This position is TAGGED as a demo and is not mirrored from the target.');
    console.log('It obeys the same exit rules; --reset clears it.\n');
  }

  if (argv.includes('--scorecard')) {
    console.log(renderScorecard(paperScorecard(book, cfg), { solUsd }));
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
    const report = await runPaperTick({ book, observations, watchlist, cfg });
    await saveBook(book);

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
      recent.push(
        `[${stamp}] BUY  ${o.symbol ?? o.mint.slice(0, 8)} — ${o.sizeSol.toFixed(4)} SOL` +
          (o.basis && cfg.pctWhale ? `  (${o.basis})` : '')
      );
    }
    for (const e of report.exits) {
      recent.push(
        `[${stamp}] SELL ${e.symbol ?? e.mint.slice(0, 8)} — ${e.label ?? e.trigger}` +
          `${Number.isFinite(e.gainPct) ? ` (${e.gainPct >= 0 ? '+' : ''}${e.gainPct.toFixed(0)}%)` : ''}`
      );
    }
    // Bounded, because the dashboard is fixed-height by design — an unbounded
    // activity log would push the numbers off the screen, which is the exact
    // scrolling this mode exists to stop.
    while (recent.length > 6) recent.shift();

    // Written in one call so the wipe and the redraw cannot be interleaved by
    // anything else writing to stdout between them, which shows as a flash of
    // empty terminal on a fast cadence.
    if (canClear) process.stdout.write(CLEAR_SCREEN);
    console.log(renderScorecard(paperScorecard(book, cfg), { solUsd: spot }));
    console.log(renderPositions(book, spot));
    if (recent.length) {
      console.log('\n  RECENT ACTIVITY');
      for (const line of recent) console.log(`  ${line}`);
    }
    // The chain line is load-bearing on a dashboard that otherwise looks
    // identical whether the mirror is live or silently failing: an unreachable
    // RPC produces no buys, and "no buys" is exactly what a quiet whale looks
    // like too.
    if (cfg.rpcMirror?.enabled) {
      const c = report.chain;
      console.log(
        `\n  CHAIN  ${c?.ok ? 'live' : `UNREACHABLE — ${c?.error ?? 'unknown'}`}` +
          ` · ${new URL(cfg.rpcMirror.url).host} · 0 Helius credits` +
          (c?.ok ? ` · ${c.scanned} new tx scanned${c.pending ? `, ${c.pending} queued` : ''}` : '')
      );
    }
    if (intervalSec) {
      console.log(`  updated ${stamp} · every ${intervalSec}s · Ctrl+C to stop`);
    }
  };

  await tick();
  if (intervalSec) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
      await tick();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2));
}
