#!/usr/bin/env node
/**
 * Paper copy-trading engine — mirrors the active #1 master whale with VIRTUAL
 * SOL and grades the result.
 *
 *   node paper_copytrade.mjs               run one tick (mirror, mark, exit)
 *   node paper_copytrade.mjs --scorecard   print the scorecard, change nothing
 *   node paper_copytrade.mjs --target      show the active target and why
 *   node paper_copytrade.mjs --reset       start a fresh book at the configured budget
 *   node paper_copytrade.mjs --watch 60    tick every 60s
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

export function createBook({ budgetSol = PAPER_DEFAULTS.budgetSol, target = null, now = Date.now() } = {}) {
  return {
    version: BOOK_VERSION,
    createdAt: now,
    budgetSol,
    balanceSol: budgetSol,
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
export function openPaperPosition(book, { mint, symbol = null, priceUsd, cfg, now = Date.now(), source = null }) {
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
  };
}

const sol = (n) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(3)}`;

/** Render the scorecard as plain text. PURE. */
export function renderScorecard(card, { title = 'PAPER COPYTRADE SCORECARD' } = {}) {
  const lines = [
    `═══ ${title} ═══`,
    `  Target        : ${card.target?.label ?? card.target?.address ?? '(none selected)'}`,
    `  Virtual budget: ${card.budgetSol.toFixed(3)} SOL`,
    `  Balance (free): ${card.balanceSol.toFixed(3)} SOL`,
    `  Open positions: ${card.activePositions}  (marked at ${card.openValueSol.toFixed(3)} SOL)`,
    `  Equity        : ${card.equitySol.toFixed(3)} SOL`,
    `  Closed trades : ${card.closedPositions}  (${card.wins}W / ${card.losses}L)`,
    `  Win rate      : ${card.winRatePct === null ? 'n/a — nothing closed yet' : `${card.winRatePct.toFixed(1)}%`}`,
    `  Realised PnL  : ${sol(card.realisedPnlSol)} SOL`,
    `  TOTAL PnL     : ${sol(card.totalPnlSol)} SOL  (${card.totalPnlPct >= 0 ? '+' : ''}${card.totalPnlPct.toFixed(1)}%)`,
    '  Virtual SOL only — nothing here was bought, sold or signed.',
  ];
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

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

async function loadJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function main(argv = []) {
  const config = await loadJson(join(HERE, 'config.json'), {});
  const cfg = paperConfig(config.paperCopytrade ?? {});
  const watchlist = await loadJson(join(HERE, config.smartMoney?.watchlistFile ?? 'smart_wallets.json'), { wallets: [] });

  if (argv.includes('--reset')) {
    const fresh = createBook({ budgetSol: cfg.budgetSol });
    const resolved = resolveTarget(watchlist, null);
    fresh.target = resolved.target ? { ...resolved.target, since: Date.now() } : null;
    await saveBook(fresh);
    console.log(`Fresh paper book at ${cfg.budgetSol.toFixed(3)} virtual SOL.`);
    console.log(renderScorecard(paperScorecard(fresh, cfg)));
    return;
  }

  let book = await loadBook();
  if (!book) {
    book = createBook({ budgetSol: cfg.budgetSol });
    console.log(`No paper book found — starting one at ${cfg.budgetSol.toFixed(3)} virtual SOL.`);
  }

  if (argv.includes('--target')) {
    const r = resolveTarget(watchlist, book);
    console.log(`Active target: ${r.target?.label ?? r.target?.address ?? '(none)'}`);
    console.log(`   address: ${r.target?.address ?? '-'}`);
    console.log(`   reason : ${r.reason}`);
    return;
  }

  if (argv.includes('--scorecard')) {
    console.log(renderScorecard(paperScorecard(book, cfg)));
    return;
  }

  const watchIndex = argv.indexOf('--watch');
  const intervalSec = watchIndex !== -1 ? Number(argv[watchIndex + 1]) || 60 : null;

  const tick = async () => {
    const observations = await loadObservations(join(HERE, '.state', 'wallet_observations.json'));
    const report = await runPaperTick({ book, observations, watchlist, cfg });
    await saveBook(book);

    const stamp = new Date().toISOString().slice(11, 19);
    for (const o of report.opened) console.log(`[${stamp}] PAPER BUY  ${o.symbol ?? o.mint.slice(0, 8)} — ${o.sizeSol.toFixed(3)} SOL`);
    for (const e of report.exits) {
      console.log(`[${stamp}] PAPER SELL ${e.symbol ?? e.mint.slice(0, 8)} — ${e.label ?? e.trigger}${Number.isFinite(e.gainPct) ? ` (${e.gainPct >= 0 ? '+' : ''}${e.gainPct.toFixed(0)}%)` : ''}`);
    }
    if (!report.opened.length && !report.exits.length) {
      console.log(`[${stamp}] no paper action — ${report.marked} position(s) marked, target ${book.target?.address?.slice(0, 8) ?? 'none'}…`);
    }
    console.log(renderScorecard(paperScorecard(book, cfg)));
  };

  await tick();
  if (intervalSec) {
    console.log(`\nWatching every ${intervalSec}s. Ctrl+C to stop.`);
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
