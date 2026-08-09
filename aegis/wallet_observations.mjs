/**
 * Observed-buyer ledger.
 *
 * Every scan replays pool trades and sees real wallets buying real tokens. The
 * post-mortem then grades those tokens as WIN / FAIL / NEUTRAL. Joining the two
 * yields a wallet performance record that Aegis derives itself.
 *
 * This exists because the candidate-enumeration problem has no API answer: you
 * cannot ask any provider for "every Solana memecoin trader" in order to rank
 * them. But you can grade the traders you actually observe, and that set grows
 * every scan — the same way the deployer index grew to 600+ without a feed.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_BUYS_PER_WALLET = 400;
const MAX_AGE_MS = 90 * 24 * 3600 * 1000;

export async function loadObservations(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return { wallets: raw.wallets ?? {}, updatedAt: raw.updatedAt ?? null };
  } catch {
    return { wallets: {}, updatedAt: null };
  }
}

export async function saveObservations(path, store) {
  await mkdir(dirname(path), { recursive: true });
  store.updatedAt = new Date().toISOString();
  await writeFile(path, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Record that these wallets bought this token, with the economics of the buy
 * where they could be attributed. Outcome is filled in later by the post-mortem.
 */
export function recordBuys(store, { buyers, token, chain, symbol, marketCap, now, systemFilter }) {
  let added = 0;
  let blocked = 0;
  for (const b of buyers ?? []) {
    if (!b?.wallet) continue;

    // Second line of defence. fetchRecentBuyers already filters, but recordBuys
    // is also reachable from other paths, and a pool authority that slips into
    // the ledger poisons every downstream ranking it feeds.
    if (systemFilter?.(b.wallet)) {
      blocked++;
      continue;
    }
    const entry = (store.wallets[b.wallet] ??= { buys: [] });

    // One record per wallet per token — a wallet accumulating across several
    // transactions is still a single position, and counting each leg would
    // inflate both trade count and win rate.
    if (entry.buys.some((x) => x.token === token)) continue;

    entry.buys.push({
      token,
      chain,
      symbol: symbol ?? null,
      ts: b.blockTime ? b.blockTime * 1000 : now,
      mcapAtBuy: marketCap ?? null,
      solSpent: b.solSpent ?? null,
      outcome: null, // WIN | FAIL | NEUTRAL, set by the post-mortem join
      changePct: null,
    });
    added++;
  }
  return { added, blocked };
}

/** Attach post-mortem verdicts to any observed buy of the same token. */
export function applyOutcomes(store, results, { config = {} } = {}) {
  const byToken = new Map((results ?? []).map((r) => [r.address, r]));
  let graded = 0;
  let scored = 0;
  let promoted = 0;
  let demoted = 0;

  for (const entry of Object.values(store.wallets)) {
    for (const buy of entry.buys) {
      if (buy.outcome) continue;
      const r = byToken.get(buy.token);
      if (!r) continue;
      buy.outcome = r.verdict;
      buy.changePct = r.changePct;
      graded++;

      // Forward scoring. Applied ONLY to wallets already carrying an alpha
      // record — the point is to test wallets that a multiplier recap
      // surfaced, by watching what they do afterwards. Scoring every wallet in
      // a 30,000-entry ledger would just re-derive the win rate that
      // walletStats already computes.
      if (entry.alpha) {
        const moved = scoreForwardTrade(entry, {
          outcome: r.verdict,
          changePct: r.changePct,
          config,
        });
        if (moved) {
          scored++;
          if (moved.delta > 0) promoted++;
          else demoted++;
        }
      }
    }
  }
  return { graded, scored, promoted, demoted };
}

/** Drop stale records so the ledger stays bounded. */
export function pruneObservations(store, now = Date.now()) {
  const floor = now - MAX_AGE_MS;
  for (const [wallet, entry] of Object.entries(store.wallets)) {
    entry.buys = entry.buys.filter((b) => b.ts >= floor).slice(-MAX_BUYS_PER_WALLET);

    // mega_win_protected wallets survive pruning even with zero surviving buys.
    // They were identified as launch buyers of a large winner, which is the
    // scarcest evidence the ledger holds — and the whole point of tracking them
    // is what they do NEXT, which can be months away. Ageing them out would
    // discard the record precisely while waiting for the thing it exists for.
    //
    // Their buy history still ages normally; only the wallet row is kept, along
    // with its alpha score and provenance.
    if (!entry.buys.length && !entry.megaWinProtected) delete store.wallets[wallet];
  }
}

/* ------------------------------------------------------------------ *
 * Multiplier-weighted alpha points
 * ------------------------------------------------------------------ */

/**
 * Credit launch buyers of a large winner.
 *
 * ── THE STATISTICAL HEALTH WARNING THAT BELONGS HERE ────────────────────────
 * These wallets are selected BECAUSE they were in a token that won. That is
 * selection on the outcome, and on its own it establishes nothing about skill:
 * every buyer of a 42x looks brilliant in hindsight, including the ones who
 * bought a hundred rugs the same week and are never in a recap post. Recap
 * channels publish winners and omit losers, so the sample is doubly biased.
 *
 * So an alpha score here is a REASON TO WATCH a wallet, not evidence about it.
 * What converts it into evidence is the forward record — post_mortem grading
 * their subsequent buys, awarding on winners and deducting on rugs. Until a
 * wallet has forward history, treat a high alpha score as "was present at one
 * good outcome", which is exactly what it measures.
 *
 * `awarded` is keyed by token so a channel reposting the same recap cannot
 * compound the same win into an ever-growing score.
 */
export function awardAlphaPoints(store, { wallets, token, symbol, multiplier, config = {}, now = Date.now() }) {
  const cfg = config.multiplierEngine ?? {};
  const perX = cfg.pointsPerMultiplier ?? 2.5;
  const protectFrom = cfg.protectAboveMultiplier ?? 10;

  let credited = 0;
  let skipped = 0;

  for (const wallet of wallets ?? []) {
    if (!wallet) continue;
    const entry = (store.wallets[wallet] ??= { buys: [] });
    entry.alpha ??= { points: 0, awarded: {} };

    // One award per wallet per token, however many times the recap is posted.
    if (entry.alpha.awarded[token]) {
      skipped++;
      continue;
    }

    const points = multiplier * perX;
    entry.alpha.points = Number((entry.alpha.points + points).toFixed(2));
    entry.alpha.awarded[token] = { multiplier, points, symbol: symbol ?? null, at: now };

    if (multiplier >= protectFrom) {
      entry.megaWinProtected = true;
      entry.megaWinReason = `launch buyer of ${symbol ? `$${symbol}` : token.slice(0, 8)} (${multiplier}x)`;
    }
    credited++;
  }
  return { credited, skipped };
}

/**
 * Move a wallet's alpha score on a graded forward trade.
 *
 * Awards on a WIN and DEDUCTS on a FAIL, so a wallet that got lucky once and
 * then bought ten rugs decays back down instead of sitting on a permanent
 * credential earned in a single token. The floor stops a score going
 * arbitrarily negative — past zero the wallet is simply not interesting, and
 * further subtraction carries no extra information.
 */
export function scoreForwardTrade(entry, { outcome, changePct = null, config = {} }) {
  const cfg = config.multiplierEngine ?? {};
  const win = cfg.forwardWinPoints ?? 5;
  const loss = cfg.forwardLossPoints ?? 8;
  const floor = cfg.alphaFloor ?? -50;

  if (!entry || (outcome !== 'WIN' && outcome !== 'FAIL')) return null;
  entry.alpha ??= { points: 0, awarded: {} };

  // A rug costs more than a win pays. The base rate is ~77% rugged, so
  // symmetric scoring would drift upward on noise alone.
  const delta = outcome === 'WIN' ? win : -loss;
  const before = entry.alpha.points;
  entry.alpha.points = Number(Math.max(floor, before + delta).toFixed(2));
  entry.alpha.forward ??= { wins: 0, losses: 0 };
  if (outcome === 'WIN') entry.alpha.forward.wins++;
  else entry.alpha.forward.losses++;

  return { before, after: entry.alpha.points, delta, changePct };
}

/**
 * Performance for one wallet, computed only from GRADED buys.
 *
 * Deliberate limitation: this measures the wallet's hit rate on tokens Aegis
 * happened to scan, over the post-mortem's 1–6h window. It is NOT lifetime
 * realized P&L — Aegis never sees the wallet's exits, so profit is estimated
 * from the token's price move against the attributed spend, and only when that
 * spend was attributable at all.
 */
/**
 * Rolling-window scorecard for a single wallet.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
 * Every figure here comes from AEGIS'S OWN OBSERVATION LEDGER — the buys this
 * scanner happened to witness, on the tokens it happened to scan, graded by its
 * own post-mortem. It is not the wallet's market-wide record.
 *
 * Two consequences worth stating before anyone trades on this:
 *
 *   1. The sample is biased upward. Buyer replay only reads tokens with a live
 *      pool, so wallets are credited for surviving tokens far more often than
 *      they are debited for dead ones. config.json's eliteWhales notes record
 *      this measurement directly.
 *   2. Profit is ESTIMATED, not realized. It is derived from each buy's SOL
 *      spend multiplied by the token's later price change — it assumes the
 *      wallet still holds and has not taken anything off. Aegis never sees
 *      exits, so it cannot know otherwise.
 *
 * HOLDING DURATION IS NOT RETURNED, deliberately. The ledger records a buy
 * timestamp and nothing else; there is no exit timestamp anywhere in the
 * pipeline, so an average holding time cannot be computed from it. Emitting a
 * plausible-looking number there would be inventing a statistic.
 *
 * Real 30-day win rate, realized P&L and holding duration are what GMGN and
 * Birdeye sell, and both are gated (403/401) — verified repeatedly, see
 * config.json networkDiscovery notes. The alert links out to them instead.
 */
export function walletScorecard(entry, { solUsd = 0, windowDays = 30, now = Date.now() } = {}) {
  const buys = entry?.buys ?? [];
  const cutoff = now - windowDays * 86_400_000;
  const inWindow = buys.filter((b) => typeof b.ts === 'number' && b.ts >= cutoff);

  const graded = inWindow.filter((b) => b.outcome && b.outcome !== 'NEUTRAL');
  const wins = graded.filter((b) => b.outcome === 'WIN');

  let estProfitUsd = 0;
  let pricedBuys = 0;
  for (const b of graded) {
    if (!b.solSpent || !solUsd || b.changePct === null || b.changePct === undefined) continue;
    pricedBuys++;
    estProfitUsd += b.solSpent * solUsd * (b.changePct / 100);
  }

  // Time since first observed buy in the window. This is NOT holding duration —
  // it is how long this wallet has been on Aegis's radar, and it is labelled
  // that way wherever it is displayed.
  const firstSeen = inWindow.length ? Math.min(...inWindow.map((b) => b.ts)) : null;

  return {
    windowDays,
    observedBuys: inWindow.length,
    gradedBuys: graded.length,
    wins: wins.length,
    winRatePct: graded.length ? (wins.length / graded.length) * 100 : null,
    estimatedProfitUsd: pricedBuys ? estProfitUsd : null,
    pricedBuys,
    trackedForHours: firstSeen === null ? null : (now - firstSeen) / 3.6e6,
    // Explicit so no caller can mistake absence for zero.
    holdingDurationHours: null,
    holdingDurationAvailable: false,
  };
}

export function walletStats(entry, solUsd = 0) {
  const graded = entry.buys.filter((b) => b.outcome && b.outcome !== 'NEUTRAL');
  const wins = graded.filter((b) => b.outcome === 'WIN');

  let estProfitUsd = 0;
  let pricedBuys = 0;
  for (const b of graded) {
    if (!b.solSpent || !solUsd || b.changePct === null) continue;
    pricedBuys++;
    estProfitUsd += b.solSpent * solUsd * (b.changePct / 100);
  }

  return {
    observedBuys: entry.buys.length,
    gradedBuys: graded.length,
    wins: wins.length,
    winRatePct: graded.length ? (wins.length / graded.length) * 100 : null,
    estimatedProfitUsd: pricedBuys ? estProfitUsd : null,
    pricedBuys,
  };
}
