#!/usr/bin/env node
/**
 * Multiplier engine — turn a recap win into a watchlist of launch buyers.
 *
 *   node multiplier_engine.mjs --token <mint> --multiplier 42
 *
 * Given a token a channel reported as a large multiple, walk its pool back to
 * genesis, extract the wallets that bought in the launch market-cap window, and
 * credit them with multiplier-weighted alpha points.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE TRUSTING AN ALPHA SCORE.
 *
 * These wallets are selected BECAUSE they were in a token that won. That is
 * selection on the outcome and it establishes nothing on its own: every buyer
 * of a 42x looks brilliant afterwards, including the ones who bought a hundred
 * rugs the same week. Recap channels compound the problem by publishing their
 * winners and omitting their losers, so the input is a biased sample of a
 * biased sample.
 *
 * An alpha score is therefore a REASON TO WATCH a wallet, never evidence about
 * it. The forward record is what converts one into the other — post_mortem
 * grades their later buys, awards on winners and deducts on rugs, so a wallet
 * that got lucky once decays back down instead of keeping a credential it
 * earned in a single token. Until a wallet has forward history, its score means
 * "was present at one good outcome", which is all it measures.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { fetchSinglePair } from './sources.mjs';
import { fetchEarliestBuyers } from './smart_money.mjs';
import { loadEnv } from './telegram.mjs';
import {
  loadObservations,
  saveObservations,
  awardAlphaPoints,
} from './wallet_observations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_PATH = join(HERE, '.state', 'wallet_observations.json');

/**
 * Keep only buyers whose entry landed inside the launch market-cap window.
 *
 * Entry market cap comes from the price actually paid in the buyer's own
 * transaction, so it is the buyer's entry rather than the token's price at some
 * later moment. A buyer whose spend was not attributable has no entry price and
 * is EXCLUDED — crediting an unknown entry as a launch entry is how a wallet
 * that bought the top gets recorded as having bought the bottom.
 */
export function filterLaunchWindow(buyers, { minMcapUsd, maxMcapUsd }) {
  const inWindow = [];
  let noEntryPrice = 0;
  let outside = 0;

  for (const b of buyers ?? []) {
    const mc = b.entryMarketCapUsd;
    if (mc === null || mc === undefined) {
      noEntryPrice++;
      continue;
    }
    if (mc < minMcapUsd || mc > maxMcapUsd) {
      outside++;
      continue;
    }
    inWindow.push(b);
  }
  return { inWindow, noEntryPrice, outside };
}

export async function harvestLaunchBuyers({ address, recap, config = null, obsPath = OBS_PATH }) {
  const cfg =
    config ?? JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  const me = cfg.multiplierEngine ?? {};

  if (me.enabled === false) return { ok: false, summary: 'multiplier engine disabled' };
  const minMultiplier = me.minMultiplierToHarvest ?? 10;
  if (!recap || recap.multiplier < minMultiplier) {
    return {
      ok: false,
      summary: `${recap?.multiplier ?? '?'}x is below the ${minMultiplier}x harvest floor — no pool walk`,
    };
  }

  const env = await loadEnv(join(HERE, '.env'));
  const rpcUrl = env.rpcOverride ?? cfg.rpcUrl;

  const pair = await fetchSinglePair(address);
  if (!pair?.pairAddress) return { ok: false, summary: 'no tradeable pair — cannot locate the pool' };

  const solUsd =
    Number(pair.priceUsd) > 0 && Number(pair.priceNative) > 0
      ? Number(pair.priceUsd) / Number(pair.priceNative)
      : null;

  const replay = await fetchEarliestBuyers({
    rpcUrl,
    poolAddress: pair.pairAddress,
    mint: address,
    cfg: { ...(cfg.smartMoney ?? {}), ...me },
    solUsd,
  });
  if (!replay.ok) return { ok: false, summary: `pool walk failed: ${replay.error}` };

  // A truncated walk never reached the launch, so its buyers are early-ish, not
  // early. Crediting them as launch buyers would be the single easiest way to
  // fill the protected list with people who arrived after the move started.
  if (!replay.reachedGenesis && me.requireGenesis !== false) {
    return {
      ok: false,
      summary: `${replay.note} — refusing to credit launch-buyer alpha on a partial walk`,
      replay,
    };
  }

  const { inWindow, noEntryPrice, outside } = filterLaunchWindow(replay.buyers, {
    minMcapUsd: me.launchMinMcapUsd ?? 30_000,
    maxMcapUsd: me.launchMaxMcapUsd ?? 100_000,
  });

  if (!inWindow.length) {
    return {
      ok: true,
      credited: 0,
      summary:
        `walked ${replay.pages} page(s), ${replay.buyers.length} launch buyer(s), ` +
        `none inside the $${(me.launchMinMcapUsd ?? 30_000) / 1000}k-$${(me.launchMaxMcapUsd ?? 100_000) / 1000}k window ` +
        `(${outside} outside, ${noEntryPrice} without an attributable entry)`,
      replay,
    };
  }

  const store = await loadObservations(obsPath);
  const res = awardAlphaPoints(store, {
    wallets: inWindow.map((b) => b.wallet),
    token: address,
    symbol: recap.symbol,
    multiplier: recap.multiplier,
    config: cfg,
  });
  await saveObservations(obsPath, store);

  const protectAt = me.protectAboveMultiplier ?? 10;
  return {
    ok: true,
    credited: res.credited,
    summary:
      `${res.credited} launch buyer(s) credited ${(recap.multiplier * (me.pointsPerMultiplier ?? 2.5)).toFixed(1)} pts each` +
      (recap.multiplier >= protectAt ? ', marked mega_win_protected' : '') +
      (res.skipped ? `, ${res.skipped} already credited for this token` : '') +
      ` (${outside} outside the window, ${noEntryPrice} without an attributable entry)`,
    replay,
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const address = at('--token');
  const multiplier = Number(at('--multiplier'));

  if (!address || !Number.isFinite(multiplier)) {
    console.log('Usage: node multiplier_engine.mjs --token <mint> --multiplier <n> [--symbol TICKER]');
    process.exit(0);
  }

  const res = await harvestLaunchBuyers({
    address,
    recap: { multiplier, symbol: at('--symbol'), address },
  });
  console.log(res.ok ? `✅ ${res.summary}` : `⏭️  ${res.summary}`);
  if (res.replay) {
    console.log(
      `   pool walk: ${res.replay.pages} page(s), ${res.replay.inspected} tx replayed, ` +
        `genesis ${res.replay.reachedGenesis ? 'reached' : 'NOT reached'}`
    );
  }
}
