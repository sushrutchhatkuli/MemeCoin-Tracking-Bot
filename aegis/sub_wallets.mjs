#!/usr/bin/env node
/**
 * Sub-wallet partitioning and staggered exit profiles.
 *
 * Shared by paper_copytrade.mjs and live_copytrade.mjs so the two cannot drift:
 * a paper result is only evidence about live behaviour if both sides split and
 * exit by identical rules.
 *
 * ── WHAT THIS CHANGES ABOUT THE STRATEGY ────────────────────────────────────
 * Every measurement in this repo so far describes PURE MIRRORING — buy when the
 * target buys, sell when it sells. The paper book's +31% was 1702 closed trades
 * with exit reason WHALE_SELL and nothing else, and round-trip drag is defined
 * as our return minus the target's on the same token, which only means anything
 * while both sides trade the same way.
 *
 * Staggered profiles deliberately break that. With the default three, two
 * thirds of capital now exits on OUR ladder rather than the target's, so those
 * sub-wallets no longer have a comparable benchmark — their drag against the
 * target measures a strategy difference, not a copying cost. Only the moonshot
 * sub-wallet stays a valid calibration sample. That is a real trade-off, not a
 * bug, but it does mean the n=20 calibration effort measures one third as fast
 * once this is switched on.
 *
 * ── AND THE FIXED COSTS DO NOT SPLIT ────────────────────────────────────────
 * Position size divides by N. Per-trade costs do not: each sub-wallet needs its
 * own associated token account (~0.00204 SOL of rent) and pays its own
 * signature and priority fee. At the shipped Phase 2 cap of 0.01 SOL a trade,
 * three ways is 0.0033 SOL each against 0.00204 of rent — the rent alone is
 * ~61% of the position. See subWalletEconomics(), which computes this rather
 * than asserting it, and warns when overhead crosses a share of the trade.
 */

const LAMPORTS = 1e9;

/** Rent-exempt minimum for an SPL associated token account, in SOL. */
export const ATA_RENT_SOL = 0.00203928;

/**
 * The exit ladders, indexed as sub-wallet 1..5.
 *
 * The first three are the specified design. Four and five extend the ladder
 * outward rather than repeating it — adding a second scalper would only
 * concentrate the behaviour that already exits earliest, which is the opposite
 * of what more sub-wallets are for.
 */
export const SUB_WALLET_PROFILES = [
  {
    id: 1,
    name: 'scalper',
    // Locks the principal early. At +50% on a third of the stake this returns
    // half that third; it does not make the whole position free, which is worth
    // being precise about because "locks principal" is often read as the latter.
    takeProfit: [{ gainPct: 50, sellFraction: 1 }],
    pureMirror: false,
    note: 'exits whole at +50%, or on a target sell if that comes first',
  },
  {
    id: 2,
    name: 'mid-runner',
    takeProfit: [
      { gainPct: 100, sellFraction: 0.5 },
      { gainPct: 200, sellFraction: 0.5 },
    ],
    pureMirror: false,
    note: 'half at +100%, the rest at +200%',
  },
  {
    id: 3,
    name: 'moonshot',
    takeProfit: [
      { gainPct: 300, sellFraction: 0.5 },
      { gainPct: 500, sellFraction: 0.5 },
    ],
    pureMirror: false,
    note: 'half at +300%, the rest at +500%',
  },
  {
    id: 4,
    name: 'runner',
    takeProfit: [
      { gainPct: 200, sellFraction: 0.5 },
      { gainPct: 400, sellFraction: 0.5 },
    ],
    pureMirror: false,
    note: 'half at +200%, the rest at +400%',
  },
  {
    id: 5,
    name: 'diamond',
    takeProfit: [],
    pureMirror: true,
    note: 'pure mirror; holds until target sells 100%',
  },
];

/** Clamp a requested count into the supported range. PURE. */
export function clampSubWalletCount(n, { min = 1, max = SUB_WALLET_PROFILES.length } = {}) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return { count: 1, clamped: true, reason: 'not a number' };
  if (v < min) return { count: min, clamped: true, reason: `below ${min}` };
  if (v > max) return { count: max, clamped: true, reason: `above ${max}` };
  return { count: v, clamped: false, reason: null };
}

/**
 * The profiles in play for a given count. PURE.
 *
 * Taken in order, so `--sub-wallets 1` is the SCALPER alone and not a mirror.
 * That follows the specified numbering, and it is worth stating plainly because
 * it means n=1 is not "sub-wallets off" — it is a strictly more aggressive
 * strategy than the current pure-mirror default, with no share left holding.
 */
export function resolveSubWallets(n) {
  const { count, clamped, reason } = clampSubWalletCount(n);
  return {
    count,
    clamped,
    reason,
    profiles: SUB_WALLET_PROFILES.slice(0, count).map((p) => ({ ...p })),
  };
}

/**
 * Split a size into N parts that sum EXACTLY to the original. PURE.
 *
 * Done in integer lamports. Dividing floats and multiplying back leaves a
 * residue — 0.01/3 recombines to 0.009999999999999998 — and a partition whose
 * parts do not re-sum is a slow leak in every downstream total, including the
 * exposure cap that is supposed to bound real money.
 *
 * The remainder goes to the earliest sub-wallets, at most one lamport each.
 */
export function partitionSizeSol(totalSol, n) {
  const count = Math.max(1, Math.trunc(n));
  const totalLamports = Math.round(Number(totalSol) * LAMPORTS);
  if (!Number.isFinite(totalLamports) || totalLamports <= 0) {
    return { ok: false, reason: 'non-positive total', parts: [] };
  }
  if (totalLamports < count) {
    return { ok: false, reason: `${totalSol} SOL cannot split ${count} ways above one lamport`, parts: [] };
  }
  const base = Math.floor(totalLamports / count);
  const remainder = totalLamports - base * count;
  const parts = Array.from({ length: count }, (_, i) => (base + (i < remainder ? 1 : 0)) / LAMPORTS);
  return { ok: true, parts, totalSol: totalLamports / LAMPORTS };
}

/**
 * What splitting actually costs. PURE.
 *
 * Position size divides by N; the account rent and per-signature fee do not.
 * Reported rather than assumed, because the ratio is easy to wave away in the
 * abstract and hard to ignore as a number: at 0.01 SOL split three ways it is
 * most of the trade.
 *
 * `recoverableSol` is the ATA rent, which comes back if the account is ever
 * closed. It is still capital locked per token per sub-wallet meanwhile, and
 * nothing in this codebase closes them.
 */
export function subWalletEconomics({ totalTradeSol, count, feeSol = 0.000005, priorityFeeSol = 0.001, jitoTipSol = 0 } = {}) {
  const n = Math.max(1, Math.trunc(count));
  const perWallet = totalTradeSol / n;
  const perWalletOverhead = ATA_RENT_SOL + feeSol + priorityFeeSol;
  const totalOverhead = perWalletOverhead * n + jitoTipSol;
  const overheadPct = totalTradeSol > 0 ? (totalOverhead / totalTradeSol) * 100 : Infinity;
  return {
    perWalletSol: perWallet,
    perWalletOverheadSol: perWalletOverhead,
    totalOverheadSol: totalOverhead,
    recoverableSol: ATA_RENT_SOL * n,
    overheadPct,
    // Overhead above a third of the trade means the split costs more than the
    // measured exit drag it is meant to work around.
    viable: overheadPct < 33,
    warning:
      overheadPct >= 100
        ? `overhead ${overheadPct.toFixed(0)}% EXCEEDS the trade itself`
        : overheadPct >= 33
          ? `overhead ${overheadPct.toFixed(0)}% of the trade — larger than the measured exit drag`
          : null,
  };
}

/**
 * Open one position per sub-wallet from a single target buy. PURE.
 *
 * Each carries its own stake, its own ladder, and its own fired-rung state, so
 * one sub-wallet taking profit cannot advance another's ladder.
 */
export function createSubPositions({ parts, profiles, entryPriceUsd, now = Date.now() }) {
  return parts.map((stakeSol, i) => {
    const profile = profiles[i] ?? profiles[profiles.length - 1];
    return {
      subId: profile.id,
      profile: profile.name,
      stakeSol,
      initialStakeSol: stakeSol,
      entryPriceUsd,
      peakPriceUsd: entryPriceUsd,
      realisedSol: 0,
      firedRungs: [],
      openedAt: now,
      closed: false,
    };
  });
}

/**
 * The cfg one sub-wallet exits under. PURE.
 *
 * Substitutes the profile's ladder into the engine's own config so the existing
 * evaluator does the work — a second implementation of rung and stop logic is a
 * second place for it to be subtly wrong.
 *
 * A pure-mirror profile gets its stops removed as well as its ladder. Leaving
 * the hard stop in would silently defeat the purpose: a 40% retrace is routine
 * on the way to a 5x, and the one sub-wallet meant to still be holding would be
 * the one stopped out first.
 */
export function subWalletCfg(cfg, profile) {
  if (profile.pureMirror) {
    // Sets the engine's own pureMirror flag rather than zeroing thresholds, so
    // the existing evaluator takes its documented early return. A +100% rung
    // that never fires and no rung at all are different configurations, and
    // only one of them is what a moonshot share means.
    return { ...cfg, pureMirror: true, takeProfit: [], staleExitHours: Infinity };
  }
  // Non-mirror profiles keep the engine's stops. The ladder is theirs; the
  // downside protection stays global, because a per-profile stop-loss is a
  // second risk policy to keep consistent for no benefit.
  return { ...cfg, pureMirror: false, takeProfit: profile.takeProfit };
}

/**
 * Aggregate view of a split position, for dashboards and equity. PURE.
 */
export function summariseSubPositions(subs = []) {
  const open = subs.filter((s) => !s.closed && s.stakeSol > 0);
  return {
    count: subs.length,
    openCount: open.length,
    stakeSol: open.reduce((a, s) => a + s.stakeSol, 0),
    initialStakeSol: subs.reduce((a, s) => a + (s.initialStakeSol ?? 0), 0),
    realisedSol: subs.reduce((a, s) => a + (s.realisedSol ?? 0), 0),
    // Which ladders have fired, for the dashboard's per-wallet column.
    byProfile: subs.map((s) => ({
      subId: s.subId,
      profile: s.profile,
      stakeSol: s.stakeSol,
      realisedSol: s.realisedSol ?? 0,
      rungs: (s.firedRungs ?? []).length,
      closed: Boolean(s.closed) || !(s.stakeSol > 0),
    })),
  };
}
