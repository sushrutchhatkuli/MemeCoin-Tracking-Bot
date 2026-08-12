#!/usr/bin/env node
/**
 * Paper copy-trading engine — mirrors the active #1 master whale with VIRTUAL
 * SOL and grades the result.
 *
 *   node paper_copytrade.mjs               run one tick (mirror, mark, exit)
 *   node paper_copytrade.mjs --scorecard   print the scorecard, change nothing
 *   node paper_copytrade.mjs --target      show the active target and why
 *   node paper_copytrade.mjs --reset       start a fresh book at the configured budget
 *   node paper_copytrade.mjs --watch 30    fixed in-place dashboard, redrawn every 30s
 *   node paper_copytrade.mjs --demo        open one live test position right now
 *
 *   --budget <usd> / --starting-balance <usd>   fund a NEW book in dollars,
 *                                               e.g. --reset --budget 50
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
 * Record a paper entry. PURE — mutates and returns the book, no clock, no IO.
 *
 * Returns a reason instead of throwing when the trade is declined, because
 * "no balance" and "already holding" are ordinary outcomes of a tick and the
 * caller reports them rather than failing.
 */
export function openPaperPosition(book, { mint, symbol = null, priceUsd, cfg, now = Date.now(), source = null, demo = false }) {
  if (!mint) return { ok: false, reason: 'no mint' };
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { ok: false, reason: 'no usable price' };
  if (book.positions[mint]) return { ok: false, reason: 'already holding' };

  const open = Object.keys(book.positions).length;
  if (open >= cfg.maxOpenPositions) return { ok: false, reason: `at max open positions (${cfg.maxOpenPositions})` };

  const size = Math.min(cfg.perTradeSol, book.balanceSol - cfg.feeSol);
  if (!(size > 0)) return { ok: false, reason: 'insufficient virtual balance' };

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
  return { ok: true, position: book.positions[mint], sizeSol: size };
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
    out.push({ mint: b.token, symbol: b.symbol ?? null, observedAt: b.ts });
  }
  return out;
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
} = {}) {
  const report = { opened: [], exits: [], marked: 0, declined: [], target: null };

  const resolved = resolveTarget(watchlist, book);
  report.target = resolved;
  if (resolved.target) {
    if (!book.target || book.target.address !== resolved.target.address) {
      book.target = { ...resolved.target, since: now };
    } else {
      book.target.label = resolved.target.label ?? book.target.label;
    }
  }

  const candidates = pendingMirrorBuys(observations, { target: book.target, book, cfg, now });
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
    });
    if (res.ok) report.opened.push({ mint: c.mint, symbol: c.symbol, sizeSol: res.sizeSol });
    else report.declined.push({ mint: c.mint, reason: res.reason });
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
    console.log(renderScorecard(paperScorecard(fresh, cfg), { solUsd }));
    return;
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
  // through a pager, console.clear() emits escape codes into the output and
  // destroys exactly the scrollback someone redirecting to a log wanted.
  const canClear = Boolean(intervalSec) && process.stdout.isTTY;

  const recent = [];

  const tick = async () => {
    const observations = await loadObservations(join(HERE, '.state', 'wallet_observations.json'));
    const report = await runPaperTick({ book, observations, watchlist, cfg });
    await saveBook(book);

    // Re-priced every tick so the dashboard tracks SOL, not just the tokens.
    const spot = (await fetchSolUsd()) ?? solUsd;

    const stamp = new Date().toISOString().slice(11, 19);
    for (const o of report.opened) {
      recent.push(`[${stamp}] BUY  ${o.symbol ?? o.mint.slice(0, 8)} — ${o.sizeSol.toFixed(3)} SOL`);
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

    if (canClear) console.clear();
    console.log(renderScorecard(paperScorecard(book, cfg), { solUsd: spot }));
    console.log(renderPositions(book, spot));
    if (recent.length) {
      console.log('\n  RECENT ACTIVITY');
      for (const line of recent) console.log(`  ${line}`);
    }
    if (intervalSec) {
      console.log(`\n  updated ${stamp} · every ${intervalSec}s · Ctrl+C to stop`);
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
