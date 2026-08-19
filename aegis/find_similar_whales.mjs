#!/usr/bin/env node
/**
 * TWIN WHALE FINDER — statistical twins of one seed wallet.
 *
 *   node aegis/find_similar_whales.mjs                      screen the default pool
 *   node aegis/find_similar_whales.mjs --calibrate          measure the seed only
 *   node aegis/find_similar_whales.mjs --seed <addr>        twin a different wallet
 *   node aegis/find_similar_whales.mjs --update-watchlist   write smart_wallets.json
 *   node aegis/find_similar_whales.mjs --json               machine-readable dump
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SCREENS FOR
 *
 * Eight metrics, taken from the seed's GMGN profile, each re-derived here FROM
 * CHAIN rather than read back from GMGN:
 *
 *   1 entry market cap      share of buys entering under $100k MC
 *   2 wallet balance        current SOL balance
 *   3 win rate              closed round trips that came back positive
 *   4 gain distribution     share of closed trades exiting 1.2x - 3x
 *   5 loss cut behaviour    share of LOSSES that stayed above -50%
 *   6 rug avoidance         share of closed trades below -50%
 *   7 realized P&L          net SOL out of closed round trips, per 7 days
 *   8 trade frequency       transactions per 7 days
 *
 * Plus a diversification constraint: each pick must share less than
 * --max-overlap percent of its traded mints with every pick already chosen.
 * Five twins that all hold the same three tokens are one position wearing five
 * addresses, and the whole point of copying five is that they are not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEED DOES NOT PASS ITS OWN ADVERTISED WIN RATE, AND THAT IS THE POINT
 *
 * MEASURED 2026-08-19 on Ar2Y6o1Q, 200 transactions (a 144-minute window):
 *   53 closed round trips, 22 wins -> 41.5% on-chain win rate.
 * GMGN's profile for the same wallet says 65.76%.
 *
 * Both numbers can be honest and still disagree — GMGN grades every position it
 * has ever indexed, this grades round trips it can see netting SOL in a bounded
 * window, and a wallet that scales in and out of one mint reads as ONE trade
 * here and as several there. auto_top_whales.mjs carries the same warning from
 * the other direction: observed 100% over 3 graded buys vs 27% true on-chain.
 *
 * The consequence for this tool is concrete: a 60-75% win-rate gate, applied to
 * Aegis's own measurement, rejects the wallet the gate was derived from. So
 * --calibrate exists, it runs automatically before every screen, and the seed's
 * measured row is printed beside GMGN's claim. Tune the thresholds against the
 * MEASURED column, not against the screenshot.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT "7 DAYS" ACTUALLY MEANS HERE
 *
 * The seed moves ~200 transactions every 144 minutes — about 14,000 a week. At
 * 100 parsed transactions per Helius call, seven true days of that wallet is
 * ~140 calls, for ONE candidate. A 25-wallet pool would be 3,500 calls a run.
 *
 * So the window is bounded by --pages and then handled two ways, and which one
 * happened is printed rather than smoothed over:
 *
 *   window >= 7 days   metrics are computed over the last 7 days directly.
 *   window <  7 days   metrics are computed over what was fetched and SCALED
 *                      to 7 days. Marked `~` in every table and `extrapolated`
 *                      in the JSON. A 3-hour sample scaled 56x is a projection,
 *                      not a measurement, and a wallet having one good hour
 *                      will clear a $10k weekly floor on it.
 *
 * The span is measured from the OLDEST fetched transaction to NOW, not to the
 * newest one. A wallet that stopped trading three days ago has three dormant
 * days that belong in its weekly rate; anchoring to its last trade would hide
 * exactly the wallets that have gone quiet.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL NOT DO
 *
 * It will not write a number it did not measure. The previous cut of this file
 * filled the watchlist with `+$${Math.floor(250 + Math.random() * 200)}k` and a
 * flat 15,000 signature count for every wallet it selected — placeholder shaped
 * exactly like evidence. Every figure written to smart_wallets.json now comes
 * out of the screen that produced it, and anything unmeasured is written null
 * and FAILS its criterion, because unmeasured and passing are not the same
 * claim.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { solanaRpc, fetchSolUsd } from './paper_copytrade.mjs';
import { fetchWalletHistory } from './auto_top_whales.mjs';
import { loadEnv } from './telegram.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVATIONS_PATH = join(HERE, '.state', 'wallet_observations.json');
const WATCHLIST_PATH = join(HERE, 'smart_wallets.json');
const SUPPLY_CACHE_PATH = join(HERE, '.state', 'mint_supply_cache.json');
const REPORT_PATH = join(HERE, '.state', 'twin_whales.json');
const LEADERBOARD_PATH = join(HERE, '..', 'leaderboard.csv');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1e9;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export const SEED_WALLET = 'Ar2Y6o1QmrRAskjii1cRfijeKugHH13ycxW5cd7rro1x';

/**
 * The seed's GMGN profile, read off the provider on 2026-08-19.
 *
 * DOCUMENTATION AND A RANKING ANCHOR — never a threshold and never a fallback.
 * The thresholds live in DEFAULT_CRITERIA and are all overridable from the
 * command line; this is here so the calibration table can show what the
 * provider claims beside what this file measures, and so `twinDistance` has
 * something to rank near-misses against.
 */
export const GMGN_SEED_PROFILE = {
  sub100kMcPct: 94.5,
  balanceSol: 52.2,
  winRatePct: 65.76,
  quickGainPct: 69,
  minorLossShareOfLossesPct: 98.6, // 30% minor losses against 30.41% total losses
  deepRugPct: 0.41,
  weeklyRealizedUsd: 42_500,
  weeklyTxs: 10_000,
};

/** The plan's eight rules, as numbers. Every one has a flag. */
export const DEFAULT_CRITERIA = {
  sub100kMcPct: 90, // 1  >= 90% of buys enter under $100k MC
  minBalanceSol: 20, // 2  20 - 100 SOL
  maxBalanceSol: 100,
  minWinRatePct: 60, // 3  60% - 75% closed win rate
  maxWinRatePct: 75,
  minQuickGainPct: 60, // 4  >= 60% of closed trades exit 1.2x - 3x
  minMinorLossSharePct: 80, // 5  >= 80% of LOSSES stay above -50%
  maxDeepRugPct: 1.0, // 6  < 1% of closed trades below -50%
  minWeeklyRealizedUsd: 10_000, // 7  >= $10k realized per 7 days
  minWeeklyTxs: 500, // 8  > 500 transactions per 7 days
};

/** Bucket edges for criterion 4/5/6, expressed as exit multiples of SOL in. */
export const QUICK_GAIN_MIN = 1.2;
export const QUICK_GAIN_MAX = 3.0;
export const DEEP_RUG_MAX = 0.5;

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

export function parseArgs(argv = []) {
  const raw = (name, fallback) => {
    const idx = argv.indexOf(name);
    if (idx === -1) return fallback;
    const next = argv[idx + 1];
    // `--limit --json` must not read "--json" as the limit. A flag that swallows
    // the next flag silently changes two settings at once.
    return next !== undefined && !next.startsWith('--') ? next : fallback;
  };
  const num = (name, fallback) => {
    const v = Number(raw(name, fallback));
    return Number.isFinite(v) ? v : fallback;
  };

  return {
    seed: raw('--seed', SEED_WALLET),
    criteria: {
      sub100kMcPct: num('--sub100k-mc', DEFAULT_CRITERIA.sub100kMcPct),
      minBalanceSol: num('--min-balance-sol', DEFAULT_CRITERIA.minBalanceSol),
      maxBalanceSol: num('--max-balance-sol', DEFAULT_CRITERIA.maxBalanceSol),
      minWinRatePct: num('--min-wr', DEFAULT_CRITERIA.minWinRatePct),
      maxWinRatePct: num('--max-wr', DEFAULT_CRITERIA.maxWinRatePct),
      minQuickGainPct: num('--min-quick-gain', DEFAULT_CRITERIA.minQuickGainPct),
      minMinorLossSharePct: num('--min-loss-cut', DEFAULT_CRITERIA.minMinorLossSharePct),
      maxDeepRugPct: num('--max-rug', DEFAULT_CRITERIA.maxDeepRugPct),
      minWeeklyRealizedUsd: num('--min-weekly-usd', DEFAULT_CRITERIA.minWeeklyRealizedUsd),
      minWeeklyTxs: num('--min-weekly-txs', DEFAULT_CRITERIA.minWeeklyTxs),
    },
    maxOverlapPct: num('--max-overlap', 15),
    limit: num('--limit', 5),
    poolSize: num('--pool', 25),
    pages: num('--pages', 4),
    dustSol: num('--dust', 0.05),
    // How many of the eight must pass. 8 is the plan; lower it to see who is
    // close rather than who is exact.
    minCriteria: num('--min-criteria', 8),
    excludeSeed: argv.includes('--exclude-seed'),
    calibrateOnly: argv.includes('--calibrate'),
    updateWatchlist: argv.includes('--update-watchlist'),
    allowUnpriced: argv.includes('--allow-unpriced'),
    json: argv.includes('--json'),
  };
}

/**
 * SOL/USD, retried.
 *
 * NOT decoration. MEASURED while building this: two runs minutes apart, one
 * priced at $76.99 and the next returned null from the same feed — and a null
 * silently takes criteria 1 AND 7 out of the screen, because both are USD
 * figures. The first cut spent 65 RPC calls on a pass where nothing could
 * score better than 6/8, and reported it as a result.
 */
export async function resolveSolUsd({ attempts = 3, delayMs = 800, fetcher = fetchSolUsd } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const price = await fetcher();
    if (Number.isFinite(price) && price > 0) return price;
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The pure metric layer
 * ------------------------------------------------------------------ */

/**
 * Swap legs this wallet actually traded, out of parsed Helius transactions.
 * PURE.
 *
 * Same attribution as computeOnChainWinRate in auto_top_whales.mjs — one
 * non-WSOL mint per transaction, direction from `accountData.nativeBalanceChange`
 * rather than from nativeTransfers, dust dropped — and for the same measured
 * reasons, which are documented at length there. What this adds is the token
 * AMOUNT and the timestamp on each leg, because criterion 1 needs tokens-per-SOL
 * to price an entry and criteria 7 and 8 need to know what window they are
 * looking at.
 *
 * MEASURED on the seed: 197 of 197 swap legs in a 200-transaction page resolved
 * to exactly one non-WSOL mint. Zero ambiguous, zero dust. The counters are
 * returned anyway — a candidate where they are large is a router or a bundler,
 * not a trader, and the screen should be able to say so.
 */
export function extractSwapLegs(transactions, { address, dustSol = 0.05 } = {}) {
  const legs = [];
  const txTimes = [];
  let ambiguous = 0;
  let dustSkipped = 0;
  let nonSwap = 0;
  let failed = 0;

  for (const tx of transactions ?? []) {
    if (!tx) continue;
    const ts = Number.isFinite(tx.timestamp) ? tx.timestamp * 1000 : null;
    // Every transaction counts toward frequency, including transfers and
    // failures: criterion 8 is "how busy is this address", and a wallet whose
    // volume is failed sandwich attempts is busy in a way worth seeing.
    if (ts !== null) txTimes.push(ts);

    if (tx.transactionError) { failed++; continue; }
    if (tx.type !== 'SWAP') { nonSwap++; continue; }

    const moved = (tx.tokenTransfers ?? []).filter(
      (t) => (t.fromUserAccount === address || t.toUserAccount === address) && t.mint !== WSOL_MINT
    );
    if (!moved.length) continue;

    const mints = [...new Set(moved.map((t) => t.mint))];
    if (mints.length !== 1) { ambiguous++; continue; }

    const account = (tx.accountData ?? []).find((a) => a.account === address);
    const netSol = (account?.nativeBalanceChange ?? 0) / LAMPORTS_PER_SOL;
    if (Math.abs(netSol) < dustSol) { dustSkipped++; continue; }

    const tokensIn = moved
      .filter((t) => t.toUserAccount === address)
      .reduce((a, t) => a + Number(t.tokenAmount ?? 0), 0);
    const tokensOut = moved
      .filter((t) => t.fromUserAccount === address)
      .reduce((a, t) => a + Number(t.tokenAmount ?? 0), 0);

    legs.push({
      signature: tx.signature ?? null,
      ts,
      mint: mints[0],
      kind: netSol < 0 ? 'BUY' : 'SELL',
      solOut: netSol < 0 ? -netSol : 0,
      solIn: netSol > 0 ? netSol : 0,
      tokensIn,
      tokensOut,
    });
  }

  txTimes.sort((a, b) => b - a);
  return {
    legs,
    txTimes,
    txCount: txTimes.length,
    newestTs: txTimes[0] ?? null,
    oldestTs: txTimes[txTimes.length - 1] ?? null,
    ambiguous,
    dustSkipped,
    nonSwap,
    failed,
  };
}

/**
 * Which slice of history the weekly figures are computed over. PURE.
 *
 * Returns the cut-off and whether the result will be a measurement or a
 * projection. `spanMs` runs from the oldest fetched transaction to NOW so that
 * silence since the last trade counts as part of the rate — see the header.
 */
export function resolveWindow({ oldestTs, now = Date.now(), windowMs = WEEK_MS } = {}) {
  if (!Number.isFinite(oldestTs)) {
    return { since: null, spanMs: 0, scale: 1, extrapolated: false, covered: false };
  }
  const spanMs = Math.max(1, now - oldestTs);
  if (spanMs >= windowMs) {
    // Enough history to answer the question directly. Trim to the window so a
    // wallet that was busy a month ago cannot pass on last month's activity.
    return { since: now - windowMs, spanMs: windowMs, scale: 1, extrapolated: false, covered: true };
  }
  return { since: oldestTs, spanMs, scale: windowMs / spanMs, extrapolated: true, covered: false };
}

/**
 * Round trips per mint. PURE.
 *
 * CLOSED means SOL went out and SOL came back for that mint inside the window.
 * A position still open is neither a win nor a loss and stays out of both sides
 * of every ratio — counting open bags as losses punishes a wallet for holding,
 * counting them as wins is worse.
 *
 * `multiple` is solIn / solOut: 1.0 is break-even, 0.5 is -50%, 3.0 is +200%.
 * It is a per-MINT figure, so a wallet that scales into one token across six
 * buys and out across four sells is one trade here. GMGN counts those
 * differently, which is one of the reasons the two win rates diverge.
 */
export function buildPositions(legs = []) {
  const byMint = new Map();
  for (const leg of legs) {
    const p = byMint.get(leg.mint) ?? {
      mint: leg.mint,
      solOut: 0,
      solIn: 0,
      tokensBought: 0,
      buys: 0,
      sells: 0,
      firstTs: null,
      lastTs: null,
    };
    p.solOut += leg.solOut;
    p.solIn += leg.solIn;
    if (leg.kind === 'BUY') { p.buys++; p.tokensBought += leg.tokensIn; } else { p.sells++; }
    if (leg.ts !== null) {
      if (p.firstTs === null || leg.ts < p.firstTs) p.firstTs = leg.ts;
      if (p.lastTs === null || leg.ts > p.lastTs) p.lastTs = leg.ts;
    }
    byMint.set(leg.mint, p);
  }

  return [...byMint.values()].map((p) => ({
    ...p,
    netSol: p.solIn - p.solOut,
    closed: p.solOut > 0 && p.solIn > 0,
    multiple: p.solOut > 0 && p.solIn > 0 ? p.solIn / p.solOut : null,
  }));
}

/**
 * The gain/loss shape of a set of positions. PURE.
 *
 * Buckets follow the plan's rungs exactly, and the 1.0x - 1.2x band is reported
 * separately rather than folded into either neighbour: a wallet scalping +5%
 * over and over is a real strategy, it is NOT the 1.2x-3x behaviour criterion 4
 * asks for, and silently counting it as one or the other would hide the
 * difference the criterion exists to detect.
 */
export function bucketPositions(positions = []) {
  const closed = positions.filter((p) => p.closed);
  const n = closed.length;
  const pct = (k) => (n ? (k / n) * 100 : null);

  const wins = closed.filter((p) => p.multiple > 1);
  const losses = closed.filter((p) => p.multiple <= 1);
  const deepRugs = closed.filter((p) => p.multiple < DEEP_RUG_MAX);
  const minorLosses = closed.filter((p) => p.multiple >= DEEP_RUG_MAX && p.multiple <= 1);
  const quickGains = closed.filter((p) => p.multiple >= QUICK_GAIN_MIN && p.multiple <= QUICK_GAIN_MAX);
  const scalpGains = closed.filter((p) => p.multiple > 1 && p.multiple < QUICK_GAIN_MIN);
  const bigGains = closed.filter((p) => p.multiple > QUICK_GAIN_MAX);

  return {
    closedTrades: n,
    wins: wins.length,
    losses: losses.length,
    winRatePct: pct(wins.length),
    quickGainPct: pct(quickGains.length),
    scalpGainPct: pct(scalpGains.length),
    bigGainPct: pct(bigGains.length),
    // GMGN's winning bucket is labelled "0% - 200%", which is 1.0x - 3.0x — it
    // INCLUDES the scalp band that criterion 4's 1.2x rung cuts out. Carried
    // separately so the calibration panel can show both numbers: measured on the
    // seed they are 74.7% and 16.1%, and only one of them is comparable to the
    // 69% on the provider's page.
    gmgnGainBandPct: pct(scalpGains.length + quickGains.length),
    minorLossPct: pct(minorLosses.length),
    deepRugPct: pct(deepRugs.length),
    // Criterion 5 is about how a loser is handled, so it is scored against the
    // LOSSES, not against all trades. Against all trades it would rise and fall
    // with the win rate — a wallet with no losses at all would score 0% "loss
    // cutting" and fail for being too good.
    minorLossShareOfLossesPct: losses.length ? (minorLosses.length / losses.length) * 100 : null,
    closedNetSol: closed.reduce((a, p) => a + p.netSol, 0),
    openPositions: positions.length - n,
  };
}

/**
 * Market cap the wallet bought into, in USD. PURE.
 *
 * solOut / tokensIn is the fill straight out of the transaction, so no pair
 * lookup and no price history is needed — the same construction as
 * impliedEntryPriceUsd in paper_copytrade.mjs, scaled by supply.
 *
 * TWO KNOWN BIASES, both small and both upward:
 *   solOut is the lamport delta, so it carries the network fee and any rent for
 *   a new token account (~0.002 SOL). On a 1 SOL buy that is 0.2%.
 *   `supply` is the mint's supply NOW, not at the moment of the buy. For the
 *   pump.fun population this screen looks at, supply is fixed at ~1e9 and only
 *   moves by burns — MEASURED across 8 of the seed's mints: 925M - 977M against
 *   a 1,000M mint. On a token with a live mint authority the figure would be
 *   wrong by however much was minted since, which is unbounded, so a candidate
 *   trading those is priced pessimistically rather than excluded.
 */
export function entryMcapUsd({ solOut, tokensIn } = {}, supply, solUsd) {
  if (!(solOut > 0) || !(tokensIn > 0)) return null;
  if (!(supply > 0) || !(solUsd > 0)) return null;
  const mcap = (solOut / tokensIn) * supply * solUsd;
  return Number.isFinite(mcap) && mcap > 0 ? mcap : null;
}

/**
 * Share of buys that entered under the cap. PURE.
 *
 * Coverage is returned beside the share because they answer different
 * questions. "94% of buys were sub-$100k" over 4 of a wallet's 60 buys is not
 * the same claim as over 58 of them, and a caller that cannot tell them apart
 * will gate on the first one.
 */
export function entryMcapProfile(legs = [], supplies = new Map(), solUsd = null) {
  const buys = legs.filter((l) => l.kind === 'BUY');
  const priced = [];
  for (const leg of buys) {
    const mcap = entryMcapUsd(leg, supplies.get(leg.mint), solUsd);
    if (mcap !== null) priced.push(mcap);
  }
  if (!priced.length) {
    return { sub100kMcPct: null, buys: buys.length, priced: 0, coveragePct: null, medianMcapUsd: null };
  }
  const under = priced.filter((m) => m < 100_000).length;
  const sorted = [...priced].sort((a, b) => a - b);
  return {
    sub100kMcPct: (under / priced.length) * 100,
    buys: buys.length,
    priced: priced.length,
    coveragePct: buys.length ? (priced.length / buys.length) * 100 : null,
    medianMcapUsd: sorted[Math.floor(sorted.length / 2)],
  };
}

/**
 * All eight metrics for one wallet, from already-fetched inputs. PURE, so the
 * whole screen can be tested against recorded history with no network.
 */
export function profileWallet({
  address,
  transactions = [],
  balanceSol = null,
  solUsd = null,
  supplies = new Map(),
  dustSol = 0.05,
  now = Date.now(),
  windowMs = WEEK_MS,
  historyComplete = null,
  pages = null,
} = {}) {
  const extracted = extractSwapLegs(transactions, { address, dustSol });
  const window = resolveWindow({ oldestTs: extracted.oldestTs, now, windowMs });

  const inWindow = (ts) => window.since === null || ts === null || ts >= window.since;
  const legs = extracted.legs.filter((l) => inWindow(l.ts));
  const txInWindow = extracted.txTimes.filter((t) => inWindow(t)).length;

  const positions = buildPositions(legs);
  const buckets = bucketPositions(positions);
  const mcap = entryMcapProfile(legs, supplies, solUsd);

  const weeklyTxs = window.spanMs ? txInWindow * window.scale : null;
  const weeklyNetSol = window.spanMs ? buckets.closedNetSol * window.scale : null;
  const weeklyRealizedUsd = weeklyNetSol !== null && solUsd ? weeklyNetSol * solUsd : null;

  return {
    address,
    balanceSol,
    solUsd,

    // 1
    sub100kMcPct: mcap.sub100kMcPct,
    mcapPriced: mcap.priced,
    mcapBuys: mcap.buys,
    mcapCoveragePct: mcap.coveragePct,
    medianEntryMcapUsd: mcap.medianMcapUsd,

    // 3, 4, 5, 6
    ...buckets,

    // 7, 8
    weeklyTxs,
    weeklyNetSol,
    weeklyRealizedUsd,

    // What the above was computed over.
    windowHours: window.spanMs / HOUR_MS,
    extrapolated: window.extrapolated,
    windowScale: window.scale,
    txInWindow,
    swapLegs: legs.length,
    // Flow through swaps, INCLUDING open positions, on the same basis as
    // deriveRealizedPnl. Reported beside the closed-trip figure because the two
    // diverge by exactly the SOL currently sitting in unsold bags, and a
    // candidate whose gap is huge is holding, not scalping.
    swapFlowNetSol: legs.reduce((a, l) => a + l.solIn - l.solOut, 0),
    mints: new Set(legs.map((l) => l.mint)),
    // Kept so criterion 1 can be priced later without re-fetching the wallet's
    // history — the supply lookups are deferred for cost, and the near-miss
    // report needs them back. Stripped from the JSON dump, where they are noise.
    buyLegs: legs
      .filter((l) => l.kind === 'BUY')
      .map((l) => ({ kind: 'BUY', mint: l.mint, solOut: l.solOut, tokensIn: l.tokensIn })),
    ambiguous: extracted.ambiguous,
    dustSkipped: extracted.dustSkipped,
    nonSwap: extracted.nonSwap,
    failedTxs: extracted.failed,
    fetchedTxs: extracted.txCount,
    historyComplete,
    pages,
  };
}

/* ------------------------------------------------------------------ *
 * Grading
 * ------------------------------------------------------------------ */

const fmtPct = (v) => (v === null || v === undefined ? 'n/a' : `${v.toFixed(1)}%`);
const fmtSol = (v) => (v === null || v === undefined ? 'n/a' : `${v.toFixed(2)} SOL`);
const fmtUsd = (v) =>
  v === null || v === undefined ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
const fmtNum = (v) => (v === null || v === undefined ? 'n/a' : Math.round(v).toLocaleString('en-US'));

/**
 * The eight rules, applied. PURE.
 *
 * A metric that could not be measured scores `pass: null` and counts as a
 * FAILURE, never as a pass. It is the same rule auto_top_whales.mjs applies to
 * its realized-SOL floor, and for the same reason: a wallet admitted because a
 * lookup timed out is admitted on no evidence at all.
 */
export function gradeTwin(profile, criteria = DEFAULT_CRITERIA) {
  const c = { ...DEFAULT_CRITERIA, ...criteria };
  const between = (v, lo, hi) => v >= lo && v <= hi;

  const checks = [
    {
      n: 1,
      key: 'entryMcap',
      label: 'Entry MC <$100k share',
      value: profile.sub100kMcPct,
      shown: fmtPct(profile.sub100kMcPct),
      need: `>= ${c.sub100kMcPct}%`,
      bench: GMGN_SEED_PROFILE.sub100kMcPct,
      test: (v) => v >= c.sub100kMcPct,
    },
    {
      n: 2,
      key: 'balance',
      label: 'Wallet balance',
      value: profile.balanceSol,
      shown: fmtSol(profile.balanceSol),
      need: `${c.minBalanceSol}-${c.maxBalanceSol} SOL`,
      bench: GMGN_SEED_PROFILE.balanceSol,
      test: (v) => between(v, c.minBalanceSol, c.maxBalanceSol),
    },
    {
      n: 3,
      key: 'winRate',
      label: 'Closed win rate',
      value: profile.winRatePct,
      shown: fmtPct(profile.winRatePct),
      need: `${c.minWinRatePct}-${c.maxWinRatePct}%`,
      bench: GMGN_SEED_PROFILE.winRatePct,
      test: (v) => between(v, c.minWinRatePct, c.maxWinRatePct),
    },
    {
      n: 4,
      key: 'quickGain',
      label: `Exits ${QUICK_GAIN_MIN}x-${QUICK_GAIN_MAX}x`,
      value: profile.quickGainPct,
      shown: fmtPct(profile.quickGainPct),
      need: `>= ${c.minQuickGainPct}%`,
      bench: GMGN_SEED_PROFILE.quickGainPct,
      test: (v) => v >= c.minQuickGainPct,
    },
    {
      n: 5,
      key: 'lossCut',
      label: 'Losses held above -50%',
      value: profile.minorLossShareOfLossesPct,
      shown: fmtPct(profile.minorLossShareOfLossesPct),
      need: `>= ${c.minMinorLossSharePct}% of losses`,
      bench: GMGN_SEED_PROFILE.minorLossShareOfLossesPct,
      test: (v) => v >= c.minMinorLossSharePct,
    },
    {
      n: 6,
      key: 'rugAvoidance',
      label: 'Trades below -50%',
      value: profile.deepRugPct,
      shown: fmtPct(profile.deepRugPct),
      need: `< ${c.maxDeepRugPct}%`,
      bench: GMGN_SEED_PROFILE.deepRugPct,
      test: (v) => v < c.maxDeepRugPct,
    },
    {
      n: 7,
      key: 'weeklyPnl',
      label: 'Realized P&L / 7d',
      value: profile.weeklyRealizedUsd,
      shown: `${profile.extrapolated ? '~' : ''}${fmtUsd(profile.weeklyRealizedUsd)}`,
      need: `>= ${fmtUsd(c.minWeeklyRealizedUsd)}`,
      bench: GMGN_SEED_PROFILE.weeklyRealizedUsd,
      test: (v) => v >= c.minWeeklyRealizedUsd,
    },
    {
      n: 8,
      key: 'frequency',
      label: 'Transactions / 7d',
      value: profile.weeklyTxs,
      shown: `${profile.extrapolated ? '~' : ''}${fmtNum(profile.weeklyTxs)}`,
      need: `> ${fmtNum(c.minWeeklyTxs)}`,
      bench: GMGN_SEED_PROFILE.weeklyTxs,
      test: (v) => v > c.minWeeklyTxs,
    },
  ].map((k) => ({
    ...k,
    pass: k.value === null || k.value === undefined || !Number.isFinite(k.value) ? null : k.test(k.value),
  }));

  const passed = checks.filter((k) => k.pass === true);
  const failed = checks.filter((k) => k.pass !== true);

  return {
    checks,
    passedCount: passed.length,
    unmeasured: checks.filter((k) => k.pass === null).length,
    // Unmeasured is marked, not just counted as a failure. The screen prices
    // entry market caps only for wallets still in contention, so an unannotated
    // list reports "fails: Entry MC" for every near-miss — and a reader tunes
    // --sub100k-mc down to chase a criterion that was never measured.
    failedLabels: failed.map((k) => (k.pass === null ? `${k.label} (unmeasured)` : k.label)),
    distance: twinDistance(checks),
  };
}

/**
 * How far a candidate sits from the seed's own profile, averaged across the
 * criteria that could be measured. PURE. Lower is closer; null when nothing was
 * measurable.
 *
 * Relative rather than absolute, because the eight metrics are on wildly
 * different scales — a $5,000 miss on weekly P&L and a 5-point miss on win rate
 * are not comparable as raw numbers, and summing them would let the dollar
 * figure decide the ranking on its own.
 */
export function twinDistance(checks = []) {
  const usable = checks.filter((k) => Number.isFinite(k.value) && Number.isFinite(k.bench) && k.bench !== 0);
  if (!usable.length) return null;
  const total = usable.reduce((a, k) => a + Math.abs(k.value - k.bench) / Math.abs(k.bench), 0);
  return total / usable.length;
}

/** 0-1 similarity, for the watchlist's composite_score slot. PURE. */
export function twinScore(distance) {
  if (distance === null || !Number.isFinite(distance)) return null;
  return Number((1 / (1 + distance)).toFixed(4));
}

/**
 * Overlap between two mint sets, as a percentage of the SMALLER one. PURE.
 *
 * Against the smaller set on purpose: a wallet holding 8 mints, 6 of them also
 * held by a 200-mint wallet, has 75% of its book duplicated. Scored against the
 * union or the larger side that reads as 3% and the pair passes a diversity
 * gate while trading the same book.
 */
export function computeTokenOverlap(setA, setB) {
  if (!setA?.size || !setB?.size) return 0;
  let shared = 0;
  for (const item of setA) if (setB.has(item)) shared++;
  return (shared / Math.min(setA.size, setB.size)) * 100;
}

/**
 * Pick the roster, enforcing the diversification constraint. PURE.
 *
 * Greedy over a list already sorted best-first, which is the right shape here:
 * the constraint is pairwise and the ranking is the thing being preserved. An
 * optimal maximally-diverse subset could admit a worse-matching wallet to fit
 * one more in, and this file's job is to find twins, not to maximise a set.
 *
 * Rejections are RETURNED, not dropped. "Why is there no fifth wallet" is the
 * question this function will be asked, and the answer is usually a specific
 * candidate that failed the overlap test at 22%.
 */
export function selectDiverseTwins(ranked = [], { maxOverlapPct = 15, limit = 5, preselected = [] } = {}) {
  const picked = preselected.map((p) => ({ ...p }));
  const rejected = [];

  for (const cand of ranked) {
    if (picked.length >= limit) break;
    if (picked.some((p) => p.address === cand.address)) continue;

    let worst = 0;
    let worstAgainst = null;
    for (const p of picked) {
      const overlap = computeTokenOverlap(cand.mints, p.mints);
      if (overlap > worst) { worst = overlap; worstAgainst = p.address; }
    }
    if (worst > maxOverlapPct) {
      rejected.push({ address: cand.address, overlapPct: worst, against: worstAgainst });
      continue;
    }
    picked.push({ ...cand, overlapPct: worst });
  }

  return { picked, rejected };
}

/* ------------------------------------------------------------------ *
 * The chain layer
 * ------------------------------------------------------------------ */

export async function loadSupplyCache(path = SUPPLY_CACHE_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export async function saveSupplyCache(cache, path = SUPPLY_CACHE_PATH) {
  try {
    await writeFile(path, JSON.stringify(cache), 'utf8');
  } catch {
    /* the cache is an optimisation; losing it costs calls, not correctness */
  }
}

/**
 * Token supply per mint, cached on disk.
 *
 * One getTokenSupply per mint — MEASURED at 298ms for 8 mints against Helius,
 * so the cost is real but small next to the history pages. Cached forever
 * rather than on a TTL: for the fixed-supply pump.fun population this screen
 * looks at, the number does not move, and the entryMcapUsd note explains what
 * happens on the mints where it does.
 *
 * A null result is cached too. A mint that has been closed, or is not an SPL
 * mint at all, will fail identically on every future run, and re-asking about
 * it once per candidate is how a screen turns into a rate limit.
 */
export async function resolveSupplies(mints, { rpcUrl, cache = {}, rpc = solanaRpc, maxLookups = 400 } = {}) {
  const supplies = new Map();
  let lookups = 0;

  for (const mint of mints) {
    if (Object.prototype.hasOwnProperty.call(cache, mint)) {
      if (cache[mint] !== null) supplies.set(mint, cache[mint]);
      continue;
    }
    if (lookups >= maxLookups) continue;
    lookups++;
    const res = await rpc(rpcUrl, 'getTokenSupply', [mint]);
    const amount = res?.ok ? Number(res.result?.value?.uiAmount) : NaN;
    if (Number.isFinite(amount) && amount > 0) {
      cache[mint] = amount;
      supplies.set(mint, amount);
    } else {
      cache[mint] = null;
    }
  }

  return { supplies, lookups };
}

/**
 * One candidate, measured end to end.
 *
 * ── THE ORDER OF THE CALLS IS THE COST CONTROL ─────────────────────────────
 * Balance is ONE rpc call and rejects on criterion 2 alone; history is `pages`
 * Helius calls; supply lookups are one per unique mint and are only needed for
 * criterion 1. Screening balance first means a pool full of 2 SOL wallets costs
 * one call each instead of five, and the supply pass is skipped entirely for a
 * wallet that already failed on its win rate.
 */
export async function profileCandidate(
  address,
  {
    rpcUrl,
    heliusKey,
    solUsd,
    criteria = DEFAULT_CRITERIA,
    pages = 4,
    dustSol = 0.05,
    supplyCache = {},
    now = Date.now(),
    skipBalanceGate = false,
    forcePricing = false,
    rpc = solanaRpc,
    fetchHistory = fetchWalletHistory,
  } = {}
) {
  const balRes = await rpc(rpcUrl, 'getBalance', [address]);
  const balanceSol = balRes?.ok && Number.isFinite(balRes.result?.value) ? balRes.result.value / LAMPORTS_PER_SOL : null;

  if (!skipBalanceGate && balanceSol !== null) {
    if (balanceSol < criteria.minBalanceSol || balanceSol > criteria.maxBalanceSol) {
      return {
        ok: false,
        stage: 'balance',
        address,
        balanceSol,
        reason: `balance ${balanceSol.toFixed(2)} SOL outside ${criteria.minBalanceSol}-${criteria.maxBalanceSol}`,
        calls: 1,
      };
    }
  }

  const hist = await fetchHistory(address, { heliusKey, maxPages: pages });
  if (!hist.ok || !hist.transactions.length) {
    return {
      ok: false,
      stage: 'history',
      address,
      balanceSol,
      reason: hist.quotaExhausted ? `RPC quota exhausted: ${hist.error}` : `no parsed history (${hist.error ?? 'empty'})`,
      quotaExhausted: hist.quotaExhausted === true,
      calls: 1 + (hist.pages ?? 0),
    };
  }

  // Priced without supplies first. Criterion 1 is the only one that needs them,
  // and a candidate failing on 3, 4, 6, 7 or 8 never has to pay for the lookups.
  const dry = profileWallet({
    address,
    transactions: hist.transactions,
    balanceSol,
    solUsd,
    dustSol,
    now,
    historyComplete: hist.complete,
    pages: hist.pages,
  });
  const dryGrade = gradeTwin(dry, criteria);
  // Priced for anyone still in contention — no failures besides criterion 1, or
  // exactly one. The slack of one is what keeps the near-miss table honest: a
  // wallet reported as "6/8, fails win rate" when it was really 7/8 with an
  // unpriced criterion 1 sends the reader tuning the wrong threshold.
  const otherFailures = dryGrade.checks.filter((k) => k.pass !== true && k.key !== 'entryMcap').length;

  let supplies = new Map();
  let lookups = 0;
  if (forcePricing || otherFailures <= 1) {
    const resolved = await resolveSupplies([...dry.mints], { rpcUrl, cache: supplyCache, rpc });
    supplies = resolved.supplies;
    lookups = resolved.lookups;
  }

  const profile = supplies.size
    ? profileWallet({
        address,
        transactions: hist.transactions,
        balanceSol,
        solUsd,
        supplies,
        dustSol,
        now,
        historyComplete: hist.complete,
        pages: hist.pages,
      })
    : dry;

  return {
    ok: true,
    address,
    profile,
    grade: gradeTwin(profile, criteria),
    pricedMcaps: supplies.size > 0,
    calls: 1 + (hist.pages ?? 0) + lookups,
  };
}

/* ------------------------------------------------------------------ *
 * The candidate pool
 * ------------------------------------------------------------------ */

/**
 * Where twins are looked for.
 *
 * There is no endpoint that returns "wallets resembling this one" — GMGN is
 * 403 behind Cloudflare for exactly this kind of enumeration, and
 * auto_top_whales.mjs carries the measurements. So the pool is assembled from
 * what this repo already has on disk:
 *
 *   wallet_observations.json  wallets Aegis watched buying real tokens. Ranked
 *                             by observed buy count, because criterion 8 wants
 *                             high-frequency traders and buy count is the only
 *                             free proxy for that.
 *   leaderboard.csv           an imported provider export, if present.
 *   smart_wallets.json        whoever is already being copied.
 *
 * The seed itself is excluded from the pool — it is graded separately as the
 * calibration row, and finding it again would waste a slot on the wallet the
 * search started from.
 */
export async function loadCandidatePool({
  seed,
  observationsPath = OBSERVATIONS_PATH,
  leaderboardPath = LEADERBOARD_PATH,
  watchlistPath = WATCHLIST_PATH,
  minObservedBuys = 3,
} = {}) {
  const byAddress = new Map();
  const add = (address, source, buyCount = 0) => {
    if (!address || address === seed) return;
    const prior = byAddress.get(address);
    if (prior) {
      prior.sources.add(source);
      prior.buyCount = Math.max(prior.buyCount, buyCount);
      return;
    }
    byAddress.set(address, { address, sources: new Set([source]), buyCount });
  };

  let observedWallets = 0;
  try {
    const raw = JSON.parse(await readFile(observationsPath, 'utf8'));
    for (const [addr, entry] of Object.entries(raw?.wallets ?? {})) {
      const buys = entry?.buys?.length ?? 0;
      observedWallets++;
      if (buys >= minObservedBuys) add(addr, 'observations', buys);
    }
  } catch {
    /* no observations yet — the other two sources still work */
  }

  try {
    const text = await readFile(leaderboardPath, 'utf8');
    const [header, ...rows] = text.trim().split(/\r?\n/);
    const cols = header.split(',').map((h) => h.trim().toLowerCase());
    const addrCol = cols.indexOf('address');
    if (addrCol !== -1) {
      for (const row of rows) {
        const cells = row.split(',');
        add(cells[addrCol]?.trim(), 'leaderboard');
      }
    }
  } catch {
    /* optional */
  }

  try {
    const wl = JSON.parse(await readFile(watchlistPath, 'utf8'));
    for (const w of wl?.wallets ?? []) add(w?.address, 'watchlist');
  } catch {
    /* optional */
  }

  const pool = [...byAddress.values()].sort(
    (a, b) => b.buyCount - a.buyCount || a.address.localeCompare(b.address)
  );
  return { pool, observedWallets };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);
const short = (a) => `${a.slice(0, 6)}..${a.slice(-4)}`;

export function renderCalibration(grade, profile) {
  const lines = [];
  lines.push(' #  metric                     GMGN says       Aegis measures   verdict');
  lines.push(` ${THIN.slice(0, 76)}`);
  for (const k of grade.checks) {
    const bench =
      k.key === 'balance' ? `${GMGN_SEED_PROFILE.balanceSol} SOL`
      : k.key === 'weeklyPnl' ? fmtUsd(k.bench)
      : k.key === 'frequency' ? fmtNum(k.bench)
      : `${k.bench}%`;
    const verdict = k.pass === null ? 'unmeasured' : k.pass ? 'in range' : 'OUT of range';
    lines.push(
      ` ${String(k.n).padEnd(2)} ${k.label.padEnd(26)} ${bench.padEnd(15)} ${k.shown.padEnd(16)} ${verdict}`
    );
  }
  lines.push('');
  lines.push(
    ` window ${profile.windowHours.toFixed(1)}h over ${fmtNum(profile.fetchedTxs)} txs` +
      ` | ${profile.closedTrades} closed round trips, ${profile.openPositions} still open` +
      `${profile.extrapolated ? ` | weekly figures scaled ${profile.windowScale.toFixed(1)}x (~)` : ' | weekly figures measured'}`
  );
  if (profile.mcapPriced) {
    lines.push(
      ` entry MC priced on ${profile.mcapPriced}/${profile.mcapBuys} buys` +
        ` (median ${fmtUsd(profile.medianEntryMcapUsd)})`
    );
  }
  // ── THE ONE PLACE THE PLAN AND THE PROVIDER DISAGREE ON WHAT A NUMBER MEANS ──
  // GMGN's winning bucket reads "0% - 200%", which is 1.0x - 3.0x. Criterion 4
  // rewrites it as "quick 1.2x - 3x rungs", and that 0.2 of a multiple is not a
  // rounding detail: it is the entire scalp band, which is where most of this
  // population's exits land. Both are printed so a threshold is never tuned
  // against the wrong one.
  if (profile.gmgnGainBandPct !== null && profile.quickGainPct !== null) {
    lines.push(
      ` gain band: ${fmtPct(profile.gmgnGainBandPct)} exit 1.0x-3.0x (GMGN's "0%-200%" bucket)` +
        ` vs ${fmtPct(profile.quickGainPct)} at criterion 4's 1.2x-3.0x`
    );
  }
  return lines.join('\n');
}

export function renderRoster(picked, { seed = null } = {}) {
  const lines = [];
  lines.push(' #  wallet             score  bal      WR     1.2-3x  rug    P&L/7d      txs/7d');
  lines.push(` ${THIN.slice(0, 76)}`);
  picked.forEach((p, i) => {
    const pr = p.profile;
    // The seed is carried at #1 as the reference, and it is marked. Without the
    // mark a roster of "1 of 5 slots filled" looks like the screen found one
    // twin, when what it found was the wallet it started from.
    const isSeed = p.address === seed;
    lines.push(
      ` ${String(i + 1).padEnd(2)} ${short(p.address).padEnd(18)}` +
        ` ${String(twinScore(p.grade?.distance) ?? 'n/a').padStart(6)}` +
        ` ${(pr.balanceSol?.toFixed(1) ?? 'n/a').padStart(6)}` +
        ` ${fmtPct(pr.winRatePct).padStart(6)}` +
        ` ${fmtPct(pr.quickGainPct).padStart(7)}` +
        ` ${fmtPct(pr.deepRugPct).padStart(6)}` +
        ` ${(`${pr.extrapolated ? '~' : ''}${fmtUsd(pr.weeklyRealizedUsd)}`).padStart(11)}` +
        ` ${(`${pr.extrapolated ? '~' : ''}${fmtNum(pr.weeklyTxs)}`).padStart(8)}` +
        (isSeed ? '  <- seed' : '')
    );
  });
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Watchlist output
 * ------------------------------------------------------------------ */

/**
 * The watchlist rows. PURE.
 *
 * EVERY FIELD IS EITHER MEASURED OR NULL. `graded_buys` is null because this
 * screen does not grade buys — that is the post-mortem's job and the field
 * belongs to auto_top_whales.mjs's pipeline. `all_time_net_profit_usd` is null
 * because a bounded window is not all time. Writing a plausible number into
 * either would put a figure nobody derived in front of position sizing.
 */
export function buildTwinWatchlist(picked, { seed, criteria, maxOverlapPct, pages, solUsd, generatedAt = new Date() }) {
  const iso = generatedAt.toISOString();
  return {
    _comment: [
      'AUTO-GENERATED by find_similar_whales.mjs — manual edits are overwritten',
      'on the next run, and auto_top_whales.mjs overwrites this same file on ITS',
      'next sync. Whichever ran last owns the list.',
      '',
      `Seed: ${seed}`,
      `Generated: ${iso}`,
      `SOL/USD at generation: ${solUsd ? `$${solUsd}` : 'unpriced'}`,
      '',
      'Eight criteria, all re-derived from chain, all required:',
      `  1 entry MC under $100k on >= ${criteria.sub100kMcPct}% of priced buys`,
      `  2 balance ${criteria.minBalanceSol}-${criteria.maxBalanceSol} SOL`,
      `  3 closed win rate ${criteria.minWinRatePct}-${criteria.maxWinRatePct}%`,
      `  4 >= ${criteria.minQuickGainPct}% of closed trades exit ${QUICK_GAIN_MIN}x-${QUICK_GAIN_MAX}x`,
      `  5 >= ${criteria.minMinorLossSharePct}% of losses held above -50%`,
      `  6 < ${criteria.maxDeepRugPct}% of closed trades below -50%`,
      `  7 >= $${criteria.minWeeklyRealizedUsd.toLocaleString('en-US')} realized per 7 days`,
      `  8 > ${criteria.minWeeklyTxs.toLocaleString('en-US')} transactions per 7 days`,
      `Diversification: <= ${maxOverlapPct}% mint overlap against every earlier pick.`,
      '',
      `THE WINDOW IS ${pages} HELIUS PAGES, NOT SEVEN DAYS. Where a wallet's history`,
      'did not reach back a week, its weekly P&L and transaction count were SCALED',
      'from what was fetched — `window_hours` and `weekly_figures_extrapolated` on',
      'each entry say which. A 3-hour sample scaled to a week is a projection.',
      '',
      'WIN RATES HERE ARE AEGIS-MEASURED AND WILL NOT MATCH GMGN. Measured on the',
      'seed 2026-08-19: 41.5% on chain against 65.76% on the provider. Round trips',
      'are netted per mint, so scaling into one token across six buys is one trade.',
      '',
      '`graded_buys` and `all_time_net_profit_usd` are null on purpose: this screen',
      'does not grade individual buys and does not read all-time history.',
    ],
    generated: { at: iso, by: 'find_similar_whales.mjs', seed },
    wallets: picked.map((p, idx) => {
      const pr = p.profile;
      return {
        address: p.address,
        rank: idx + 1,
        composite_score: twinScore(p.grade.distance),
        composite_parts: {
          win_rate: pr.winRatePct === null ? null : Number((pr.winRatePct / 100).toFixed(4)),
          quick_gain: pr.quickGainPct === null ? null : Number((pr.quickGainPct / 100).toFixed(4)),
          rug_free: pr.deepRugPct === null ? null : Number(((100 - pr.deepRugPct) / 100).toFixed(4)),
        },
        label:
          idx === 0 && p.address === seed
            ? `Seed (${short(seed)})`
            : `Twin #${idx + 1} (WR ${fmtPct(pr.winRatePct)} | ${QUICK_GAIN_MIN}-${QUICK_GAIN_MAX}x ${fmtPct(pr.quickGainPct)} | rug ${fmtPct(pr.deepRugPct)})`,
        win_rate: pr.winRatePct === null ? null : `${pr.winRatePct.toFixed(1)}%`,
        graded_buys: null,
        all_time_net_profit_usd: null,
        onchain_signatures: pr.fetchedTxs,
        solscan: `https://solscan.io/account/${p.address}`,
        source: 'twin-whale-finder',
        stats_updated: iso.slice(0, 10),
        enabled: true,

        // The measurement, spelled out, so nothing downstream has to guess what
        // basis a figure is on.
        balance_sol: pr.balanceSol === null ? null : Number(pr.balanceSol.toFixed(3)),
        closed_trades: pr.closedTrades,
        quick_gain_pct: pr.quickGainPct === null ? null : Number(pr.quickGainPct.toFixed(2)),
        minor_loss_share_pct:
          pr.minorLossShareOfLossesPct === null ? null : Number(pr.minorLossShareOfLossesPct.toFixed(2)),
        deep_rug_pct: pr.deepRugPct === null ? null : Number(pr.deepRugPct.toFixed(2)),
        sub100k_entry_pct: pr.sub100kMcPct === null ? null : Number(pr.sub100kMcPct.toFixed(2)),
        sub100k_priced_buys: pr.mcapPriced,
        weekly_realized_usd: pr.weeklyRealizedUsd === null ? null : Math.round(pr.weeklyRealizedUsd),
        weekly_txs: pr.weeklyTxs === null ? null : Math.round(pr.weeklyTxs),
        weekly_figures_extrapolated: pr.extrapolated,
        window_hours: Number(pr.windowHours.toFixed(2)),
        history_complete: pr.historyComplete,
        token_overlap_pct: p.overlapPct === undefined ? null : Number(p.overlapPct.toFixed(2)),
        metrics_basis:
          `${pr.closedTrades} closed round trips over ${pr.windowHours.toFixed(1)}h ` +
          `(${pr.fetchedTxs} txs, ${pr.pages} pages)` +
          `${pr.extrapolated ? `; weekly figures scaled ${pr.windowScale.toFixed(1)}x` : '; weekly figures measured'}`,
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const env = await loadEnv(join(HERE, '.env')).catch(() => ({}));
  const rpcUrl = env.rpcOverride || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const heliusKey = (String(rpcUrl).match(/api-key=([\w-]+)/) ?? [])[1] ?? null;
  const now = Date.now();

  console.log(`\n${RULE}`);
  console.log(' TWIN WHALE FINDER — statistical twins of one seed wallet');
  console.log(RULE);
  console.log(` Seed        : ${args.seed}`);
  console.log(` History     : ${args.pages} Helius pages/wallet (<= ${args.pages * 100} txs)`);
  console.log(` Diversity   : <= ${args.maxOverlapPct}% mint overlap between picks`);
  console.log(` Gate        : ${args.minCriteria} of 8 criteria`);

  if (!heliusKey) {
    // Every metric except the balance comes from the parsed-history endpoint.
    // Without a key this screen has nothing to screen ON, and a run that
    // reported "0 twins found" would be indistinguishable from a real result.
    console.error(
      `\nNo Helius api-key in SOLANA_RPC_URL. This screen reads parsed transaction\n` +
        `history, which the public RPC does not serve. Set SOLANA_RPC_URL in aegis/.env\n` +
        `to a https://mainnet.helius-rpc.com/?api-key=... url and re-run.`
    );
    process.exitCode = 1;
    return;
  }

  const solUsd = await resolveSolUsd();
  console.log(` SOL/USD     : ${solUsd ? `$${solUsd}` : 'UNPRICED'}`);

  if (!solUsd && !args.allowUnpriced) {
    // Criterion 1 prices an entry market cap in dollars and criterion 7 is a
    // dollar figure, so an unpriced run cannot score better than 6 of 8 for any
    // wallet alive. Continuing would spend a few hundred RPC calls to produce a
    // roster of zero and a reason that looks like the market rather than the
    // feed. Refused here, before anything is spent.
    console.error(
      `\n SOL/USD could not be read after 3 attempts, and two of the eight criteria` +
        `\n are denominated in dollars (entry market cap, weekly realized P&L).` +
        `\n Nothing can clear 8/8 without it, so this run is refused rather than` +
        `\n reported as "no twins found". Retry in a minute, or pass --allow-unpriced` +
        `\n to screen on the six criteria that do not need a price.`
    );
    process.exitCode = 1;
    return;
  }

  const supplyCache = await loadSupplyCache();

  /* 1. Calibration — the seed, measured with this tool's own yardstick. */
  console.log(`\n${THIN}`);
  console.log(' 1. CALIBRATION — the seed, measured the way candidates will be');
  console.log(THIN);
  const seedRun = await profileCandidate(args.seed, {
    rpcUrl,
    heliusKey,
    solUsd,
    criteria: args.criteria,
    pages: args.pages,
    dustSol: args.dustSol,
    supplyCache,
    now,
    // The seed is the reference, not a candidate. Gating it out on its own
    // balance would leave the run with nothing to calibrate against, and the
    // entry-market-cap pass is paid for unconditionally here — a calibration
    // table with an "unmeasured" row is missing the criterion the reader most
    // needs to see before tuning it.
    skipBalanceGate: true,
    forcePricing: true,
  });

  if (!seedRun.ok) {
    console.error(` Could not profile the seed: ${seedRun.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(renderCalibration(seedRun.grade, seedRun.profile));
  if (seedRun.grade.passedCount < 8) {
    console.log(
      `\n NOTE: the seed itself clears ${seedRun.grade.passedCount}/8 of these thresholds.` +
        `\n Failing: ${seedRun.grade.failedLabels.join(', ')}.` +
        `\n Thresholds a wallet's own profile cannot meet will not find its twins —` +
        `\n tune them against the "Aegis measures" column above, not against GMGN's.`
    );
  }

  await saveSupplyCache(supplyCache);
  if (args.calibrateOnly) {
    if (args.json) {
      console.log(
        JSON.stringify(seedRun.profile, (k, v) => (k === 'buyLegs' ? undefined : v instanceof Set ? [...v] : v), 2)
      );
    }
    return;
  }

  /* 2. Pool. */
  const { pool, observedWallets } = await loadCandidatePool({ seed: args.seed });
  console.log(`\n${THIN}`);
  console.log(' 2. CANDIDATE POOL');
  console.log(THIN);
  console.log(
    ` ${pool.length} candidates from ${observedWallets} observed wallets + leaderboard + watchlist` +
      ` — screening the top ${Math.min(args.poolSize, pool.length)} by observed buy count.`
  );

  /* 3. Screen. */
  console.log(`\n${THIN}`);
  console.log(' 3. SCREENING (balance first, then history, then entry market caps)');
  console.log(THIN);

  const graded = [];
  const rejects = [];
  let calls = 0;
  const shortlist = pool.slice(0, args.poolSize);

  for (let i = 0; i < shortlist.length; i++) {
    const cand = shortlist[i];
    const run = await profileCandidate(cand.address, {
      rpcUrl,
      heliusKey,
      solUsd,
      criteria: args.criteria,
      pages: args.pages,
      dustSol: args.dustSol,
      supplyCache,
      now,
    });
    calls += run.calls ?? 0;
    const tag = `[${String(i + 1).padStart(3)}/${shortlist.length}] ${short(cand.address)}`;

    if (!run.ok) {
      rejects.push({ address: cand.address, reason: run.reason });
      console.log(` ${tag}  skipped — ${run.reason}`);
      if (run.quotaExhausted) {
        console.log(`\n Stopping: the RPC plan is out of credits. Results below are partial.`);
        break;
      }
      continue;
    }

    graded.push({ address: cand.address, profile: run.profile, grade: run.grade, sources: [...cand.sources] });
    const g = run.grade;
    console.log(
      ` ${tag}  ${g.passedCount}/8` +
        ` | bal ${fmtSol(run.profile.balanceSol)}` +
        ` | WR ${fmtPct(run.profile.winRatePct)}` +
        ` | ${run.profile.closedTrades} closed` +
        (g.passedCount === 8 ? '  <== TWIN' : `  (fails: ${g.failedLabels.slice(0, 3).join(', ')})`)
    );
  }

  await saveSupplyCache(supplyCache);

  /* 4. Rank and select. */
  const rank = (a, b) =>
    b.grade.passedCount - a.grade.passedCount ||
    (a.grade.distance ?? Infinity) - (b.grade.distance ?? Infinity);
  graded.sort(rank);

  // The screening pass defers entry-market-cap pricing for anyone already
  // failing two other criteria, which is right for cost and wrong for the
  // report: the near-miss table is where a reader decides which threshold to
  // move, and "unmeasured" in that table answers nothing. The wallets that
  // table will actually show get priced now — bounded to three, on a cache
  // shared with the pass above, so this is a few hundred milliseconds.
  const toPrice = graded.filter((g) => g.profile.sub100kMcPct === null && g.profile.buyLegs.length).slice(0, 3);
  if (toPrice.length && solUsd) {
    for (const g of toPrice) {
      const { supplies, lookups } = await resolveSupplies([...g.profile.mints], { rpcUrl, cache: supplyCache });
      calls += lookups;
      const mc = entryMcapProfile(g.profile.buyLegs, supplies, solUsd);
      Object.assign(g.profile, {
        sub100kMcPct: mc.sub100kMcPct,
        mcapPriced: mc.priced,
        mcapBuys: mc.buys,
        mcapCoveragePct: mc.coveragePct,
        medianEntryMcapUsd: mc.medianMcapUsd,
      });
      g.grade = gradeTwin(g.profile, args.criteria);
    }
    await saveSupplyCache(supplyCache);
    graded.sort(rank);
  }
  const qualified = graded.filter((g) => g.grade.passedCount >= args.minCriteria);

  const preselected = args.excludeSeed
    ? []
    : [{ address: args.seed, profile: seedRun.profile, grade: seedRun.grade, sources: ['seed'], overlapPct: 0 }];
  const { picked, rejected } = selectDiverseTwins(qualified, {
    maxOverlapPct: args.maxOverlapPct,
    limit: args.limit,
    preselected,
  });

  console.log(`\n${RULE}`);
  console.log(
    ` 4. ROSTER — ${picked.length} of ${args.limit} slots filled` +
      ` (${qualified.length} of ${graded.length} screened wallets cleared ${args.minCriteria}/8)`
  );
  console.log(RULE);
  if (picked.length) console.log(renderRoster(picked, { seed: args.seed }));
  else console.log(' No wallet in the pool cleared the gate. Nothing was written.');

  const seedInRoster = picked.some((p) => p.address === args.seed);
  const twinsFound = picked.length - (seedInRoster ? 1 : 0);
  if (seedInRoster) {
    console.log(
      `\n Row 1 is the SEED, carried as the reference (it clears ${seedRun.grade.passedCount}/8 of these` +
        `\n thresholds itself). Twins actually found by this screen: ${twinsFound}.` +
        ` Use --exclude-seed to search for ${args.limit} wallets besides it.`
    );
  }

  for (const p of picked) console.log(` ${short(p.address)}  ${p.address}`);

  if (rejected.length) {
    console.log(`\n Held back by the ${args.maxOverlapPct}% diversification limit:`);
    for (const r of rejected) {
      console.log(`   ${short(r.address)} — ${r.overlapPct.toFixed(1)}% mint overlap with ${short(r.against)}`);
    }
  }

  if (picked.length < args.limit) {
    // A short roster is a result, not an error, and the reason is the useful
    // part. Widening the pool and relaxing the gate are different fixes and the
    // near-miss table is what tells them apart.
    const nearMiss = graded.filter((g) => g.grade.passedCount < args.minCriteria).slice(0, 5);
    if (nearMiss.length) {
      console.log(`\n Closest wallets that did NOT clear the gate:`);
      for (const g of nearMiss) {
        console.log(`   ${short(g.address)}  ${g.grade.passedCount}/8 — fails: ${g.grade.failedLabels.join(', ')}`);
      }
    }
    console.log(
      `\n To fill the remaining ${args.limit - picked.length} slot(s): --pool ${args.poolSize * 2}` +
        ` (wider search), --pages ${args.pages + 2} (longer window per wallet),` +
        ` or --min-criteria ${Math.max(1, args.minCriteria - 1)} (looser gate).`
    );
  }

  console.log(
    `\n Cost: ~${calls} RPC calls across ${shortlist.length} candidates` +
      ` | ${rejects.length} skipped before scoring.`
  );

  /* 5. Write. */
  const report = {
    generated: new Date().toISOString(),
    seed: args.seed,
    criteria: args.criteria,
    maxOverlapPct: args.maxOverlapPct,
    pages: args.pages,
    solUsd,
    seedProfile: seedRun.profile,
    seedGrade: seedRun.grade,
    picked,
    graded,
    overlapRejected: rejected,
    skipped: rejects,
  };
  const asJson = JSON.stringify(
    report,
    (k, v) => (k === 'buyLegs' ? undefined : v instanceof Set ? [...v] : v),
    2
  );
  await writeFile(REPORT_PATH, asJson, 'utf8');
  console.log(` Full screen written to ${REPORT_PATH}`);
  if (args.json) console.log(asJson);

  if (args.updateWatchlist) {
    if (!picked.length) {
      console.log(`\n --update-watchlist ignored: nothing qualified, and an empty watchlist stops copytrading.`);
    } else {
      // The file being replaced is what live_copytrade and paper_copytrade read
      // to decide whose trades to mirror. Backed up first, because "the screen
      // found 2 twins" should not silently drop the 5 wallets already being
      // followed.
      const backupPath = join(HERE, '.state', `smart_wallets.pre-twin-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      try {
        const existing = await readFile(WATCHLIST_PATH, 'utf8');
        await writeFile(backupPath, existing, 'utf8');
        console.log(`\n Backed up the current watchlist to ${backupPath}`);
      } catch {
        console.log(`\n No existing watchlist to back up.`);
      }
      const watchlist = buildTwinWatchlist(picked, {
        seed: args.seed,
        criteria: args.criteria,
        maxOverlapPct: args.maxOverlapPct,
        pages: args.pages,
        solUsd,
      });
      await writeFile(WATCHLIST_PATH, JSON.stringify(watchlist, null, 2), 'utf8');
      console.log(` Wrote ${picked.length} wallet(s) to ${WATCHLIST_PATH}`);
    }
  } else if (picked.length) {
    console.log(` Re-run with --update-watchlist to write these into smart_wallets.json.`);
  }
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
