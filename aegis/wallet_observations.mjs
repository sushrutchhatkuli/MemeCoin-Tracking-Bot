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
export function recordBuys(store, { buyers, token, chain, symbol, marketCap, now }) {
  let added = 0;
  for (const b of buyers ?? []) {
    if (!b?.wallet) continue;
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
  return added;
}

/** Attach post-mortem verdicts to any observed buy of the same token. */
export function applyOutcomes(store, results) {
  const byToken = new Map((results ?? []).map((r) => [r.address, r]));
  let graded = 0;

  for (const entry of Object.values(store.wallets)) {
    for (const buy of entry.buys) {
      if (buy.outcome) continue;
      const r = byToken.get(buy.token);
      if (!r) continue;
      buy.outcome = r.verdict;
      buy.changePct = r.changePct;
      graded++;
    }
  }
  return graded;
}

/** Drop stale records so the ledger stays bounded. */
export function pruneObservations(store, now = Date.now()) {
  const floor = now - MAX_AGE_MS;
  for (const [wallet, entry] of Object.entries(store.wallets)) {
    entry.buys = entry.buys.filter((b) => b.ts >= floor).slice(-MAX_BUYS_PER_WALLET);
    if (!entry.buys.length) delete store.wallets[wallet];
  }
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
