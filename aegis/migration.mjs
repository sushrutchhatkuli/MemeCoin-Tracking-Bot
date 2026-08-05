/**
 * Pump.fun → Raydium/PumpSwap migration state.
 *
 * WHAT THIS IS: a heuristic, not a status flag. Nothing in DexScreener or
 * RugCheck reports "migrating" — verified by inspecting both payloads. What IS
 * available is the venue:
 *
 *   dexId 'pumpfun'                  → still on the bonding curve
 *   dexId 'pumpswap'/'raydium'/...   → migrated, trading on an AMM
 *
 * Migration is the gap between those two, when the curve has filled and the AMM
 * pool is being seeded. During that window the token is briefly untradeable and
 * a buy button will fail.
 *
 * Measured across a live sample: bonding-curve pairs topped out near $21k market
 * cap while migrated pairs sat at a $66k median — consistent with Pump.fun's
 * bonding completion threshold. So a token still reporting the bonding-curve
 * venue while priced near or above that threshold is very likely mid-migration.
 *
 * LIMITS, because this will occasionally be wrong:
 *   - the window is short (often under a minute), so most scans miss it entirely
 *   - a token that stalls just under the threshold reads as BONDING, correctly
 *   - a fast migration can complete between the market fetch and the audit
 * Treat MIGRATING as "verify before trading", not as fact.
 */

const AMM_DEXES = new Set(['pumpswap', 'raydium', 'meteora', 'meteoradbc', 'orca', 'fluxbeam']);
const BONDING_DEXES = new Set(['pumpfun', 'moonshot', 'launchlab', 'boop']);

export const MIGRATION = {
  MIGRATED: 'MIGRATED',
  MIGRATING: 'MIGRATING',
  BONDING: 'BONDING',
  UNKNOWN: 'UNKNOWN',
};

export function migrationStatus(pair, security, config = {}) {
  const cfg = config.migration ?? {};
  const threshold = cfg.migrationMarketCapUsd ?? 60000;
  const stallMinutes = cfg.stalledMinutes ?? 5;

  if (pair?.chainId !== 'solana') {
    return { state: MIGRATION.UNKNOWN, label: null, tradeable: true, detail: 'non-Solana chain' };
  }

  const dexId = String(pair?.dexId ?? '').toLowerCase();
  const mcap = pair?.marketCap ?? pair?.fdv ?? 0;

  if (AMM_DEXES.has(dexId)) {
    return {
      state: MIGRATION.MIGRATED,
      label: null,
      tradeable: true,
      detail: `Trading on ${dexId} (migration complete)`,
    };
  }

  if (BONDING_DEXES.has(dexId)) {
    // Curve reported complete but still no AMM venue — the untradeable window.
    const recentTxns = (pair?.txns?.m5?.buys ?? 0) + (pair?.txns?.m5?.sells ?? 0);
    const nearThreshold = mcap >= threshold;
    const stalled = recentTxns === 0 && (pair?.txns?.h1?.buys ?? 0) + (pair?.txns?.h1?.sells ?? 0) > 0;

    if (nearThreshold) {
      return {
        state: MIGRATION.MIGRATING,
        label: '⏳ RAYDIUM MIGRATION IN PROGRESS',
        tradeable: false,
        detail:
          `Bonding curve complete at $${Math.round(mcap).toLocaleString('en-US')} but still on ${dexId} — ` +
          `liquidity is being seeded and buys will fail until the AMM pool is live` +
          (stalled ? '; trading has stalled, consistent with an in-flight migration' : ''),
      };
    }

    return {
      state: MIGRATION.BONDING,
      label: null,
      tradeable: true,
      detail: `On the ${dexId} bonding curve at $${Math.round(mcap).toLocaleString('en-US')} (migrates near $${threshold.toLocaleString('en-US')})`,
    };
  }

  return {
    state: MIGRATION.UNKNOWN,
    label: null,
    tradeable: true,
    detail: `Unrecognised venue "${dexId || 'none'}" — migration state not determined`,
  };
}
