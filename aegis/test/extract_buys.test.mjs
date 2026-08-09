/**
 * Fixture tests for buy extraction and the safety override.
 *
 * These exist because the two most important behaviours here cannot be
 * exercised on demand against a live chain: aggregator-routed swaps appear
 * unpredictably, and a "whale bought a scam" token is not something you can
 * summon. Both are pure functions, so they are tested against recorded shapes.
 *
 *   node --test aegis/test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractBuys,
  priceEntry,
  validateWatchlistEntry,
  formatSmartMoneyLine,
} from '../smart_money.mjs';
import {
  scoreToken,
  concentrationCapFor,
  runSecurityAudit,
  classifySignal,
  evaluateInsiderRequirements,
  evaluateSecurityShield,
  evaluateCommunityTakeover,
  applyCtoOverride,
  isInsiderCategory,
  isAlertableCategory,
  SIGNAL_CATEGORY,
} from '../audit.mjs';
import { alertHeaderLines } from '../telegram.mjs';
import { stopLossPctFor } from '../sell_notifier.mjs';
import { capEnrichmentShortlist } from '../auto_top_whales.mjs';
import { extractMints, channelMatches, SeenCache } from '../telegram_listener.mjs';

const MINT = 'MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POOL = 'PoolBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const BUYER = 'BuyerCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const RELAYER = 'RelayDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

/** Minimal parsed-transaction shape matching what the RPC returns. */
function tx({ signer, pre, post, preSol, postSol, fee = 5000, keys }) {
  return {
    meta: {
      fee,
      preBalances: preSol,
      postBalances: postSol,
      preTokenBalances: pre,
      postTokenBalances: post,
      err: null,
    },
    transaction: {
      message: { accountKeys: keys.map((k) => ({ pubkey: k, signer: k === signer })) },
    },
  };
}

const bal = (owner, amount, accountIndex) => ({
  owner,
  mint: MINT,
  accountIndex,
  uiTokenAmount: { uiAmount: amount },
});

test('attributes the buy to the token owner, not the transaction signer', () => {
  // The case that broke signer-based detection: a relayer signs, the buyer
  // receives. Sampled live swaps all looked like this.
  const t = tx({
    signer: RELAYER,
    keys: [RELAYER, BUYER, POOL],
    preSol: [10e9, 1e9, 0],
    postSol: [9e9, 1e9, 0],
    pre: [bal(POOL, 1_000_000, 2)],
    post: [bal(POOL, 900_000, 2), bal(BUYER, 100_000, 1)],
  });

  const buys = extractBuys(t, { mint: MINT, poolAddress: POOL });
  assert.equal(buys.length, 1);
  assert.equal(buys[0].wallet, BUYER, 'buyer must be the token recipient');
  assert.equal(buys[0].amount, 100_000);
  assert.equal(buys[0].routedBySigner, true, 'flagged as routed through a third party');
});

test('does not count the pool receiving tokens as a buy (that is a sell)', () => {
  const t = tx({
    signer: BUYER,
    keys: [BUYER, POOL],
    preSol: [10e9, 0],
    postSol: [11e9, 0],
    pre: [bal(BUYER, 100_000, 0), bal(POOL, 900_000, 1)],
    post: [bal(BUYER, 0, 0), bal(POOL, 1_000_000, 1)],
  });

  const buys = extractBuys(t, { mint: MINT, poolAddress: POOL });
  assert.equal(buys.length, 0, 'a sell must not register as a buy');
});

test('attributes SOL spend only when the transaction has a single buyer', () => {
  const single = tx({
    signer: BUYER,
    keys: [BUYER, POOL],
    preSol: [10e9, 0],
    postSol: [8e9, 0],
    pre: [bal(POOL, 1_000_000, 1)],
    post: [bal(POOL, 900_000, 1), bal(BUYER, 100_000, 0)],
  });
  const [buy] = extractBuys(single, { mint: MINT, poolAddress: POOL });
  assert.ok(Math.abs(buy.solSpent - 1.999995) < 1e-5, 'SOL spend net of fee');

  const multi = tx({
    signer: RELAYER,
    keys: [RELAYER, BUYER, 'OtherEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', POOL],
    preSol: [10e9, 0, 0, 0],
    postSol: [8e9, 0, 0, 0],
    pre: [bal(POOL, 1_000_000, 3)],
    post: [
      bal(POOL, 800_000, 3),
      bal(BUYER, 100_000, 1),
      bal('OtherEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', 100_000, 2),
    ],
  });
  const buys = extractBuys(multi, { mint: MINT, poolAddress: POOL });
  assert.equal(buys.length, 2);
  assert.ok(
    buys.every((b) => b.solSpent === null),
    'spend must be null rather than guessed when it cannot be split'
  );
});

test('prices entry market cap from the price actually paid', () => {
  const entry = priceEntry({
    buy: { solSpent: 7.5, amount: 1_000_000 },
    pair: { priceUsd: '0.00008', priceNative: '0.000001', quoteToken: { symbol: 'SOL' } },
    totalSupply: 1_000_000_000,
  });
  // Tolerances, not equality: these are floating-point divisions of decimal
  // prices, so exact comparison fails on representation alone.
  assert.ok(Math.abs(entry.solUsd - 80) < 1e-6, `solUsd was ${entry.solUsd}`);
  assert.ok(Math.abs(entry.usdSpent - 600) < 1e-6, `usdSpent was ${entry.usdSpent}`);
  assert.ok(Math.abs(entry.entryMarketCapUsd - 600_000) < 1, `mcap was ${entry.entryMarketCapUsd}`);
});

/* ------------------------------------------------------------------ *
 * Safety override — the anti-trick rule
 * ------------------------------------------------------------------ */

const thresholds = {
  buySignalDemandRatio: 2,
  crashSellRatio: 3,
  minLiqToMcapPct: 15,
  maxTop10Pct: 25,
  buySignalScore: 75,
  watchScore: 55,
  minUniqueHolders: 150,
};

const strongDemand = {
  m5: { buys: 200, sells: 20, ratio: 10 },
  h1: { buys: 800, sells: 100, ratio: 8 },
  marketCap: 250_000,
  liquidityUsd: 100_000,
  liqToMcapPct: 40,
  volume: { m5: 0, h1: 200_000, h24: 0 },
  priceChange: { m5: 5, h1: 30, h6: 0, h24: 0 },
  ageHours: 2,
};

const loadedWhales = { detected: true, count: 3, matches: [], totalPct: 5 };

test('a whale cannot rescue a token that failed the contract audit', () => {
  const result = scoreToken({
    audit: { status: 'FAILED', failures: ['Mint Authority: ACTIVE'], checks: [], unknowns: [] },
    security: { ok: true, totalHolders: 5000, top10Pct: 10 },
    demand: strongDemand,
    velocity: null,
    catalysts: { bullish: [], bearish: [] },
    thresholds,
    smartMoney: loadedWhales,
    smartMoneyConfig: { scoreBonus: 15 },
    social: { scoreBonus: 10 },
  });

  assert.equal(result.verdict, 'SCAM/AVOID');
  assert.equal(result.score, 0, 'score must be 0, not merely capped');
  assert.equal(result.safetyGateFailed, true, 'alerts must be blocked');
  assert.equal(result.smartMoneyForfeited, true);
  assert.equal(result.breakdown.smartMoney, 0, 'whale bonus must not be applied');
  assert.equal(result.breakdown.social, 0);
});

test('a whale cannot rescue a token below the holder floor', () => {
  const result = scoreToken({
    audit: { status: 'PASSED', failures: [], checks: [], unknowns: [] },
    security: { ok: true, totalHolders: 140, top10Pct: 10 },
    demand: strongDemand,
    velocity: null,
    catalysts: { bullish: [], bearish: [] },
    thresholds,
    smartMoney: loadedWhales,
    smartMoneyConfig: { scoreBonus: 15 },
    social: { scoreBonus: 10 },
  });

  assert.equal(result.score, 0);
  assert.equal(result.safetyGateFailed, true);
  assert.equal(result.verdict, 'UNVERIFIED / LOW HOLDERS');
  assert.notEqual(result.verdict, 'BUY SIGNAL');
});

/* ------------------------------------------------------------------ *
 * Watchlist validation + callout formatting
 * ------------------------------------------------------------------ */

test('rejects addresses that are not valid Solana base58', () => {
  // 45 chars — the real failure found in a live watchlist. Silently matched
  // nothing, which is indistinguishable from "no whales detected".
  const tooLong = validateWatchlistEntry({
    address: '8b9RzKk9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  });
  assert.equal(tooLong.valid, false);
  assert.match(tooLong.reason, /wrong length/);

  // 0, O, I and l are outside the base58 alphabet.
  assert.equal(validateWatchlistEntry({ address: `0OIl${'1'.repeat(36)}` }).valid, false);

  assert.equal(
    validateWatchlistEntry({ address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }).valid,
    true
  );
});

test('callout shows spend and entry market cap when a trade was replayed', () => {
  const line = formatSmartMoneyLine({
    displayLabel: 'Alpha Whale #1',
    solscanUrl: 'https://solscan.io/account/ABC',
    stats: { winRate: '84%', netProfitUsd: '+$145k' },
    solSpent: 7.5,
    usdSpent: 1200,
    entryMarketCapUsd: 18000,
    entryMinutesAfterLaunch: 2,
    pct: 1.2,
  });
  assert.match(line, /Alpha Whale #1/);
  assert.match(line, /84% WR \| \+\$145k Profit/);
  assert.match(line, /Bought 7\.50 SOL \(\$1k\) at \$18k MC/);
  assert.match(line, /2m after launch ⚡/);
});

test('callout reports position instead of inventing a spend when unattributable', () => {
  const line = formatSmartMoneyLine({
    displayLabel: 'Alpha Whale #2',
    solscanUrl: 'https://solscan.io/account/DEF',
    stats: null,
    solSpent: null,
    usdSpent: null,
    entryMarketCapUsd: null,
    entryMinutesAfterLaunch: null,
    pct: 3.14,
  });
  assert.match(line, /Holds 3\.14% of supply/);
  assert.doesNotMatch(line, /Bought/);
  assert.doesNotMatch(line, /MC/);
});

/* ------------------------------------------------------------------ *
 * Dual-mode signal classification
 * ------------------------------------------------------------------ */

// Mirrors the shipped config: GEM floor $300k / $50k liq / 12h, SCALP up to $1M.
const catConfig = {
  signalCategories: {
    gem: {
      minMarketCapUsd: 300_000,
      minLiquidityUsd: 50_000,
      minAgeHours: 12,
      minHolders: 0,
      scoreBoost: 10,
      advice: 'gem advice',
    },
    scalp: {
      minMarketCapUsd: 15_000,
      maxMarketCapUsd: 1_000_000,
      maxAgeHours: 24,
      advice: 'scalp advice',
    },
  },
};

const gemDemand = {
  marketCap: 2_500_000,
  liquidityUsd: 400_000,
  ageHours: 72,
  ageIsLowerBound: false,
};

test('GEM wins the overlap: a mature $500k token is accumulation, not a scalp', () => {
  // $500k sits inside BOTH bands now. GEM is evaluated first, so maturity
  // decides — this is the documented precedence, not an accident.
  const r = classifySignal({
    demand: { marketCap: 500_000, liquidityUsd: 80_000, ageHours: 18, ageIsLowerBound: false },
    security: { ok: true, totalHolders: 3000 },
    config: catConfig,
  });
  assert.equal(r.category, 'LONG-TERM GEM');
  assert.equal(r.scoreBoost, 10);
});

test('the same $500k token is a SCALP when too young or too thin for GEM', () => {
  const young = classifySignal({
    demand: { marketCap: 500_000, liquidityUsd: 80_000, ageHours: 4, ageIsLowerBound: false },
    security: { ok: true, totalHolders: 3000 },
    config: catConfig,
  });
  assert.equal(young.category, 'FAST SCALP', 'under 12h -> scalp');

  const thin = classifySignal({
    demand: { marketCap: 500_000, liquidityUsd: 20_000, ageHours: 18, ageIsLowerBound: false },
    security: { ok: true, totalHolders: 3000 },
    config: catConfig,
  });
  assert.equal(thin.category, 'FAST SCALP', 'liquidity below $50k -> scalp');
});

test('the 97% survival band ($300k-$1M) is now always captured', () => {
  for (const mc of [300_000, 650_000, 999_999]) {
    const r = classifySignal({
      demand: { marketCap: mc, liquidityUsd: 20_000, ageHours: 3, ageIsLowerBound: false },
      security: { ok: true, totalHolders: 900 },
      config: catConfig,
    });
    assert.notEqual(r.category, 'UNCLASSIFIED', `$${mc} must classify`);
  }
});

test('classifies a mature deep-liquidity token as LONG-TERM GEM', () => {
  const r = classifySignal({
    demand: gemDemand,
    security: { ok: true, totalHolders: 5000 },
    config: catConfig,
  });
  assert.equal(r.category, 'LONG-TERM GEM');
  assert.equal(r.scoreBoost, 10);
  assert.equal(r.advice, 'gem advice');
});

test('GEM requires a CONFIRMED age, not a lower-bound estimate', () => {
  // Age came from the indexer's first-sighting timestamp, which only proves the
  // token is AT LEAST this old at the moment it was indexed. Advice to hold for
  // weeks must not rest on an estimate.
  const r = classifySignal({
    demand: { ...gemDemand, ageIsLowerBound: true },
    security: { ok: true, totalHolders: 5000 },
    config: catConfig,
  });
  assert.notEqual(r.category, 'LONG-TERM GEM');
});

test('GEM is refused when holder count is unknown', () => {
  const r = classifySignal({
    demand: gemDemand,
    security: { ok: true, totalHolders: null },
    config: catConfig,
  });
  assert.notEqual(r.category, 'LONG-TERM GEM');
});

test('classifies a young mid-cap token as FAST SCALP', () => {
  const r = classifySignal({
    demand: { marketCap: 65_000, liquidityUsd: 20_000, ageHours: 3, ageIsLowerBound: false },
    security: { ok: true, totalHolders: 800 },
    config: catConfig,
  });
  assert.equal(r.category, 'FAST SCALP');
  assert.equal(r.scoreBoost, 0, 'scalps get no score boost');
});

test('SCALP tolerates unknown age; the advice holds either way', () => {
  const r = classifySignal({
    demand: { marketCap: 65_000, liquidityUsd: 20_000, ageHours: null, ageIsLowerBound: true },
    security: { ok: true, totalHolders: 800 },
    config: catConfig,
  });
  assert.equal(r.category, 'FAST SCALP');
});

test('a token outside both bands is left unclassified', () => {
  // Above the scalp ceiling but too thin and too young for GEM — deliberately
  // no advice rather than forcing it into the nearest tier.
  const r = classifySignal({
    demand: { marketCap: 4_000_000, liquidityUsd: 20_000, ageHours: 3, ageIsLowerBound: false },
    security: { ok: true, totalHolders: 2000 },
    config: catConfig,
  });
  assert.equal(r.category, 'UNCLASSIFIED');
  assert.equal(r.advice, null);
});

/* ------------------------------------------------------------------ *
 * Dual insider tier classification
 * ------------------------------------------------------------------ */

// Mirrors the shipped config for both insider bands.
const insiderConfig = {
  thresholds: { maxTop10Pct: 20, minLpLockedPct: 99 },
  signalCategories: {
    ...catConfig.signalCategories,
    insiderTiers: { maxTop10Pct: 20, minLpLockedPct: 99, scoreFloor: 68 },
    insiderEstablished: {
      minMarketCapUsd: 1_000_000,
      maxMarketCapUsd: null,
      minLiquidityUsd: 100_000,
      minHolders: 1_000,
      scoreBoost: 10,
      label: '💎 ESTABLISHED INSIDER GEM',
      advice: 'established insider advice',
      alertHeader: '💎 ESTABLISHED INSIDER GEM ALERT ($1M–$10M MC) 💎',
    },
    insiderEarly: {
      minMarketCapUsd: 30_000,
      maxMarketCapUsd: 500_000,
      scoreBoost: 0,
      label: '⚡ EARLY-STAGE INSIDER SCALP',
      advice: 'early insider advice',
      alertHeader: '🚀 EARLY INSIDER SCALP ALERT ($30k–$500k MC) 🚀',
    },
  },
};

/** A contract that satisfies every mandatory requirement. */
const cleanSecurity = (over = {}) => ({
  ok: true,
  chainKind: 'solana',
  mintAuthority: null,
  freezeAuthority: null,
  lpLockedPct: 100,
  top10Pct: 12,
  totalHolders: 2_500,
  ...over,
});

const PASSED = { status: 'PASSED', checks: [], failures: [], unknowns: [] };
const insiders = (count = 2) => ({ detected: true, insiderCount: count, label: 'INSIDER CLUSTER' });

const classifyInsider = (demand, over = {}) =>
  classifySignal({
    demand,
    security: cleanSecurity(over.security),
    config: insiderConfig,
    clusters: over.clusters === undefined ? insiders() : over.clusters,
    audit: over.audit ?? PASSED,
  });

test('a $60k insider-backed token is an EARLY-STAGE INSIDER SCALP', () => {
  const r = classifyInsider({
    marketCap: 60_000,
    liquidityUsd: 25_000,
    ageHours: 0.4,
    ageIsLowerBound: false,
  });
  assert.equal(r.category, SIGNAL_CATEGORY.INSIDER_EARLY);
  assert.equal(r.scoreBoost, 0, 'the early band adds no score of its own');
  assert.match(r.alertHeader, /EARLY INSIDER SCALP ALERT/);
  assert.equal(r.insiderRequirements.passed, true);
});

test('a $3M insider-backed token with deep liquidity is an ESTABLISHED INSIDER GEM', () => {
  const r = classifyInsider({
    marketCap: 3_000_000,
    liquidityUsd: 450_000,
    ageHours: 40,
    ageIsLowerBound: false,
  });
  assert.equal(r.category, SIGNAL_CATEGORY.INSIDER_ESTABLISHED);
  assert.equal(r.scoreBoost, 10);
  assert.match(r.alertHeader, /ESTABLISHED INSIDER GEM ALERT/);
});

test('the established band has no ceiling — "$10M+" means what it says', () => {
  const r = classifyInsider({
    marketCap: 40_000_000,
    liquidityUsd: 2_000_000,
    ageHours: 400,
    ageIsLowerBound: false,
  });
  assert.equal(r.category, SIGNAL_CATEGORY.INSIDER_ESTABLISHED);
});

test('no insider activity means no insider tier — the plain bands still apply', () => {
  const r = classifyInsider(
    { marketCap: 60_000, liquidityUsd: 25_000, ageHours: 0.4, ageIsLowerBound: false },
    { clusters: { detected: false } }
  );
  assert.equal(r.category, SIGNAL_CATEGORY.SCALP);
  assert.equal(isInsiderCategory(r.category), false);
});

test('an insider tier beats the plain GEM it overlaps', () => {
  // $400k, mature, $80k liquidity: a LONG-TERM GEM under the plain rules. With
  // cluster activity the early band takes it, because the tighter stop is the
  // safer of the two pieces of advice about the same token.
  const demand = { marketCap: 400_000, liquidityUsd: 80_000, ageHours: 30, ageIsLowerBound: false };
  assert.equal(
    classifySignal({ demand, security: cleanSecurity(), config: insiderConfig }).category,
    SIGNAL_CATEGORY.GEM,
    'without clusters it is a plain GEM'
  );
  assert.equal(classifyInsider(demand).category, SIGNAL_CATEGORY.INSIDER_EARLY);
});

test('the established tier refuses a token with too few holders or too little liquidity', () => {
  const thin = classifyInsider(
    { marketCap: 3_000_000, liquidityUsd: 60_000, ageHours: 40, ageIsLowerBound: false },
    { security: { totalHolders: 2_500 } }
  );
  assert.notEqual(thin.category, SIGNAL_CATEGORY.INSIDER_ESTABLISHED, '$60k liq is under the floor');

  const fewHolders = classifyInsider(
    { marketCap: 3_000_000, liquidityUsd: 450_000, ageHours: 40, ageIsLowerBound: false },
    { security: { totalHolders: 400 } }
  );
  assert.notEqual(fewHolders.category, SIGNAL_CATEGORY.INSIDER_ESTABLISHED);

  const unknownHolders = classifyInsider(
    { marketCap: 3_000_000, liquidityUsd: 450_000, ageHours: 40, ageIsLowerBound: false },
    { security: { totalHolders: null } }
  );
  assert.notEqual(
    unknownHolders.category,
    SIGNAL_CATEGORY.INSIDER_ESTABLISHED,
    'unknown holder count is not a thousand holders'
  );
});

test('a failed mandatory requirement blocks the tier WITHOUT falling back to a plain one', () => {
  // The whole point of the gate: a token that matched an insider band and then
  // failed a security requirement must not re-enter as a plain GEM and collect
  // the alert it was just denied.
  const demand = { marketCap: 3_000_000, liquidityUsd: 450_000, ageHours: 40, ageIsLowerBound: false };

  for (const [what, over] of [
    ['active mint authority', { security: { mintAuthority: 'SomeMintAuthority1111111111' } }],
    ['active freeze authority', { security: { freezeAuthority: 'SomeFreezeAuthority11111111' } }],
    ['LP only 60% locked', { security: { lpLockedPct: 60 } }],
    ['LP lock unknown', { security: { lpLockedPct: null } }],
    ['top 10 at the 20% cap', { security: { top10Pct: 20 } }],
    ['concentration unknown', { security: { top10Pct: null } }],
    ['audit not PASSED', { audit: { status: 'UNVERIFIED', checks: [], failures: [] } }],
  ]) {
    const r = classifyInsider(demand, over);
    assert.equal(r.category, SIGNAL_CATEGORY.NONE, `${what} must not classify`);
    assert.equal(r.insiderRequirements.passed, false, what);
    assert.match(r.reason, /requirements failed/, what);
  }
});

test('every mandatory requirement is reported, passing or failing', () => {
  const req = evaluateInsiderRequirements({
    audit: PASSED,
    security: cleanSecurity(),
    clusters: insiders(3),
    thresholds: { maxTop10Pct: 20, minLpLockedPct: 99 },
  });
  assert.equal(req.passed, true);
  const labels = req.checks.map((c) => c.label);
  for (const need of [
    'Insider detected',
    'Contract audit',
    'Mint authority revoked',
    'Freeze authority revoked',
    'LP burned / locked',
    'Top 10 concentration',
  ]) {
    assert.ok(labels.includes(need), `missing requirement row: ${need}`);
  }
});

test('a token between the bands ($500k-$1M) reaches neither insider tier', () => {
  // Documented gap. It is asserted rather than left implicit so that closing it
  // later is a deliberate edit to a failing test, not a silent behaviour change.
  const r = classifyInsider({
    marketCap: 750_000,
    liquidityUsd: 200_000,
    ageHours: 3,
    ageIsLowerBound: false,
  });
  assert.equal(isInsiderCategory(r.category), false);
});

test('the absolute-depth waiver applies to the established tier and nothing else', () => {
  // A $3.4M token with a $410k pool is 12% of market cap — under the 15% ratio
  // floor that would otherwise zero it. Real tokens in this band sit at 5-12%,
  // so without the waiver the tier could never fire at all.
  const deepButLowRatio = {
    m5: { buys: 30, sells: 18, ratio: 1.7 },
    h1: { buys: 300, sells: 220, ratio: 1.4 },
    marketCap: 3_400_000,
    liquidityUsd: 410_000,
    liqToMcapPct: 12.1,
    volume: { m5: 40_000, h1: 900_000, h24: 6_000_000 },
    priceChange: { m5: 1, h1: 6, h6: 12, h24: 30 },
    ageHours: 62,
  };
  const base = {
    audit: PASSED,
    security: { ok: true, totalHolders: 5_200, top10Pct: 9.2 },
    demand: deepButLowRatio,
    velocity: null,
    catalysts: { bullish: [], bearish: [] },
    thresholds: { ...thresholds, minLiqToMcapPct: 15, minAbsoluteLiquidityUsd: 100_000 },
  };

  const established = scoreToken({
    ...base,
    signalCategory: { category: SIGNAL_CATEGORY.INSIDER_ESTABLISHED },
  });
  assert.equal(established.safetyGateFailed, false, 'the deep pool clears the gate');
  assert.notEqual(established.verdict, 'THIN LIQUIDITY');
  assert.equal(established.liquidityGate.waivedByDepth, true);

  // Same numbers, every other category: the ratio floor still bites. The waiver
  // is a targeted fix for one band, not a general loosening.
  for (const category of [
    SIGNAL_CATEGORY.INSIDER_EARLY,
    SIGNAL_CATEGORY.GEM,
    SIGNAL_CATEGORY.SCALP,
    SIGNAL_CATEGORY.NONE,
  ]) {
    const r = scoreToken({ ...base, signalCategory: { category } });
    assert.equal(r.verdict, 'THIN LIQUIDITY', `${category} must still face the ratio floor`);
    assert.equal(r.score, 0, category);
  }

  // A pool under the absolute floor gets no waiver even in the established tier.
  const shallow = scoreToken({
    ...base,
    demand: { ...deepButLowRatio, liquidityUsd: 80_000, liqToMcapPct: 2.4 },
    signalCategory: { category: SIGNAL_CATEGORY.INSIDER_ESTABLISHED },
  });
  assert.equal(shallow.verdict, 'THIN LIQUIDITY');
});

test('the tier header leads the Telegram alert', () => {
  const early = alertHeaderLines({
    signalCategory: { alertHeader: '🚀 EARLY INSIDER SCALP ALERT ($30k–$500k MC) 🚀' },
    clusters: insiders(1),
  });
  assert.match(early[0], /EARLY INSIDER SCALP ALERT/);
  assert.equal(early.length, 1, 'a single insider adds no swarm line');

  const swarm = alertHeaderLines({
    signalCategory: { alertHeader: '💎 ESTABLISHED INSIDER GEM ALERT ($1M–$10M MC) 💎' },
    clusters: insiders(4),
  });
  assert.match(swarm[0], /ESTABLISHED INSIDER GEM ALERT/);
  assert.match(swarm[1], /CABAL SWARM — 4 unique insider wallets/);

  const fallback = alertHeaderLines({ signalCategory: {}, clusters: insiders(2) });
  assert.match(fallback[0], /MULTI-INSIDER BUY ALERT/);
});

/* ------------------------------------------------------------------ *
 * Anti-rugpull shield
 * ------------------------------------------------------------------ */

const shieldThresholds = {
  maxTop10Pct: 20,
  minLpLockedPct: 99,
  minUniqueHolders: 150,
  minLiqToMcapPct: 15,
  minAbsoluteLiquidityUsd: 100_000,
};
const healthyDemand = { liqToMcapPct: 30, liquidityUsd: 200_000, marketCap: 660_000 };

test('the shield passes a clean token and names every gate', () => {
  const r = evaluateSecurityShield({
    security: cleanSecurity(),
    demand: healthyDemand,
    thresholds: shieldThresholds,
  });
  assert.equal(r.passed, true);
  assert.equal(r.checks.length, 6, 'six mandatory gates');
});

test('each of the six gates blocks on its own', () => {
  const cases = [
    ['mint authority', { security: { mintAuthority: 'MintAuth1111' } }, {}],
    ['freeze authority', { security: { freezeAuthority: 'FreezeAuth111' } }, {}],
    ['LP not burned', { security: { lpLockedPct: 45 } }, {}],
    ['LP unknown', { security: { lpLockedPct: null } }, {}],
    ['top 10 at cap', { security: { top10Pct: 20 } }, {}],
    ['top 10 unknown', { security: { top10Pct: null } }, {}],
    ['holders below floor', { security: { totalHolders: 149 } }, {}],
    ['holders unknown', { security: { totalHolders: null } }, {}],
    ['depth below ratio', {}, { liqToMcapPct: 14.9, liquidityUsd: 20_000 }],
    ['depth unknown', {}, { liqToMcapPct: null }],
  ];
  for (const [what, secOver, demandOver] of cases) {
    const r = evaluateSecurityShield({
      security: cleanSecurity(secOver.security),
      demand: { ...healthyDemand, ...demandOver },
      thresholds: shieldThresholds,
    });
    assert.equal(r.passed, false, `${what} must fail the shield`);
  }
});

test('a CTO waives the depth RATIO but no other gate', () => {
  const thinRatio = { liqToMcapPct: 2.9, liquidityUsd: 218_000, marketCap: 7_500_000 };
  const cto = { detected: true };

  // The $RAVECAT shape: 2.9% ratio on a real $218k pool.
  const withCto = evaluateSecurityShield({
    security: cleanSecurity(),
    demand: thinRatio,
    thresholds: shieldThresholds,
    cto,
  });
  assert.equal(withCto.passed, true);
  assert.equal(withCto.ctoDepthWaiver, true);

  const withoutCto = evaluateSecurityShield({
    security: cleanSecurity(),
    demand: thinRatio,
    thresholds: shieldThresholds,
  });
  assert.equal(withoutCto.passed, false, 'same token without CTO stays blocked');

  // A CTO with a shallow pool gets nothing: the waiver is on the ratio, and is
  // satisfied by absolute dollars, not by being a CTO.
  const shallow = evaluateSecurityShield({
    security: cleanSecurity(),
    demand: { liqToMcapPct: 2.9, liquidityUsd: 40_000, marketCap: 1_400_000 },
    thresholds: shieldThresholds,
    cto,
  });
  assert.equal(shallow.passed, false, '$40k pool is not exitable however strong the crowd');

  // And a CTO can never buy its way past a live mint authority.
  for (const secOver of [
    { mintAuthority: 'MintAuth1111' },
    { freezeAuthority: 'FreezeAuth111' },
    { lpLockedPct: 10 },
    { top10Pct: 44 },
    { totalHolders: 100 },
  ]) {
    const r = evaluateSecurityShield({
      security: cleanSecurity(secOver),
      demand: thinRatio,
      thresholds: shieldThresholds,
      cto,
    });
    assert.equal(r.passed, false, `CTO must not waive ${Object.keys(secOver)[0]}`);
  }
});

/* ------------------------------------------------------------------ *
 * Community takeover
 * ------------------------------------------------------------------ */

const ctoConfig = {
  communityTakeover: {
    enabled: true,
    minHolders: 500,
    minVolume1hUsd: 100_000,
    minLiquidityUsd: 30_000,
    maxDevBalancePct: 1,
    scoreBoost: 20,
  },
};
const ctoDemand = { volume: { h1: 250_000 }, liquidityUsd: 218_000, marketCap: 7_500_000 };

test('all four criteria met is a community takeover worth +20', () => {
  const r = evaluateCommunityTakeover({
    demand: ctoDemand,
    security: cleanSecurity({ totalHolders: 8_856 }),
    deployer: { status: 'UNKNOWN' },
    devExit: { balancePct: 0.04 },
    config: ctoConfig,
  });
  assert.equal(r.detected, true);
  assert.equal(r.scoreBoost, 20);
  assert.equal(r.checks.length, 4);
});

test('each CTO criterion is individually required', () => {
  const base = {
    demand: ctoDemand,
    security: cleanSecurity({ totalHolders: 8_856 }),
    deployer: { status: 'UNKNOWN' },
    devExit: { balancePct: 0.04 },
    config: ctoConfig,
  };
  const variants = [
    ['too few holders', { security: cleanSecurity({ totalHolders: 499 }) }],
    ['holders unknown', { security: cleanSecurity({ totalHolders: null }) }],
    ['volume too low', { demand: { ...ctoDemand, volume: { h1: 99_999 } } }],
    ['pool too shallow', { demand: { ...ctoDemand, liquidityUsd: 29_999 } }],
    ['dev still holding', { devExit: { balancePct: 1.01 } }],
    ['dev balance unreadable', { devExit: { balancePct: null } }],
    ['dev balance not supplied', { devExit: null }],
  ];
  for (const [what, over] of variants) {
    const r = evaluateCommunityTakeover({ ...base, ...over });
    assert.equal(r.detected, false, `${what} must not qualify`);
  }
});

test('a dev sell observed on-chain satisfies the exit criterion', () => {
  const r = evaluateCommunityTakeover({
    demand: ctoDemand,
    security: cleanSecurity({ totalHolders: 8_856 }),
    deployer: { status: 'UNKNOWN' },
    devExit: { sold: true, balancePct: 3.2 },
    config: ctoConfig,
  });
  assert.equal(r.detected, true, 'an observed sell counts even above the balance cap');
});

test('a serial rugger cannot be laundered by a takeover', () => {
  const r = evaluateCommunityTakeover({
    demand: ctoDemand,
    security: cleanSecurity({ totalHolders: 8_856 }),
    deployer: { status: 'SERIAL RUGGER 🔴' },
    devExit: { balancePct: 0 },
    config: ctoConfig,
  });
  assert.equal(r.detected, false);
  assert.equal(r.blockedBySerialRugger, true);
});

test('CTO neutralises only dev-exit catalysts, never the rest of the risk', () => {
  const catalysts = {
    bullish: [],
    bearish: [
      'Creator sold their entire position',
      'Seller exhaust: 90 sells vs 10 buys in 5m',
      'Price down 44.0% in 1h — active distribution',
    ],
  };
  const out = applyCtoOverride(catalysts, { detected: true, checks: [] });
  assert.equal(out.bearish.length, 2, 'the two market-risk warnings survive');
  assert.ok(out.bearish.every((b) => !/creator/i.test(b)));
  assert.equal(out.ctoNeutralised.length, 1);

  const untouched = applyCtoOverride(catalysts, { detected: false });
  assert.equal(untouched.bearish.length, 3, 'no CTO, no override');
});

test('CTO wins classification precedence and is alertable without insiders', () => {
  const r = classifySignal({
    demand: { ...ctoDemand, ageHours: 40, ageIsLowerBound: false },
    security: cleanSecurity({ totalHolders: 8_856 }),
    config: { ...insiderConfig, ...ctoConfig },
    clusters: null,
    audit: PASSED,
    cto: { detected: true, scoreBoost: 20, checks: [] },
  });
  assert.equal(r.category, SIGNAL_CATEGORY.CTO);
  assert.equal(r.scoreBoost, 20);
  assert.match(r.alertHeader, /COMMUNITY TAKEOVER/);
  assert.equal(isAlertableCategory(r.category), true, 'CTO alerts with no cluster at all');
  assert.equal(isInsiderCategory(r.category), false, 'but it is not an insider tier');
});

/* ------------------------------------------------------------------ *
 * Per-category stop-loss
 * ------------------------------------------------------------------ */

test('the early insider tier gets the -15% stop its own alert text promises', () => {
  const cfg = { stopLossPct: 20, stopLossPctByCategory: { 'EARLY-STAGE INSIDER SCALP': 15 } };
  assert.equal(stopLossPctFor({ category: 'EARLY-STAGE INSIDER SCALP' }, cfg), 15);
  assert.equal(stopLossPctFor({ category: 'ESTABLISHED INSIDER GEM' }, cfg), 20);
  assert.equal(stopLossPctFor({ category: 'COMMUNITY TAKEOVER GEM' }, cfg), 20);
  assert.equal(stopLossPctFor({}, cfg), 20, 'positions opened before this existed');
  assert.equal(stopLossPctFor({ category: 'X' }, {}), 20, 'default with no config');
});

/* ------------------------------------------------------------------ *
 * Whale-sync enrichment cap
 * ------------------------------------------------------------------ */

const candidate = (i, gradedBuys, observedBuys = gradedBuys) => ({
  address: `Wallet${String(i).padStart(3, '0')}`,
  gradedBuys,
  observed: { observedBuys },
});

test('the shortlist is capped at 50 before any per-wallet RPC work', () => {
  // The ledger shape that caused the problem: thousands eligible, five written.
  const eligible = Array.from({ length: 3_444 }, (_, i) => candidate(i, (i % 9) + 1));
  const capped = capEnrichmentShortlist(eligible, 50);

  assert.equal(capped.length, 50);
  assert.equal(
    ((eligible.length - capped.length) / eligible.length) * 100 > 98,
    true,
    'over 98% of per-wallet RPC work is skipped'
  );
});

test('the cap keeps the MOST-observed wallets, not an arbitrary 50', () => {
  const eligible = [
    candidate(1, 2),
    candidate(2, 9),
    candidate(3, 1),
    candidate(4, 7),
    candidate(5, 4),
  ];
  const capped = capEnrichmentShortlist(eligible, 3);
  assert.deepEqual(
    capped.map((c) => c.gradedBuys),
    [9, 7, 4],
    'sorted by graded buys, descending'
  );
});

test('observed buys break ties between equally-graded wallets', () => {
  const eligible = [candidate(1, 5, 10), candidate(2, 5, 90), candidate(3, 5, 40)];
  const capped = capEnrichmentShortlist(eligible, 2);
  assert.deepEqual(capped.map((c) => c.observed.observedBuys), [90, 40]);
});

test('ungraded wallets cannot starve the cap of wallets that can qualify', () => {
  // The reason the sort key is graded-first. A wallet with 200 observed buys
  // and none decided yet can never pass the sample rule, so letting it occupy a
  // slot would spend the RPC budget on a wallet that cannot reach the list.
  const noisy = Array.from({ length: 60 }, (_, i) => candidate(100 + i, 0, 200));
  const real = [candidate(1, 6, 6), candidate(2, 4, 4)];
  const capped = capEnrichmentShortlist([...noisy, ...real], 50);

  assert.equal(capped[0].gradedBuys, 6);
  assert.equal(capped[1].gradedBuys, 4);
  assert.equal(capped.length, 50);
});

test('the cap returns the same object references, so enrichment stays visible', () => {
  // syncTopWhales enriches the shortlist in place and then ranks the FULL list.
  // Copying the objects here would silently discard every enriched value.
  const a = candidate(1, 5);
  const capped = capEnrichmentShortlist([a], 50);
  capped[0].lifetimeTrades = 987;
  assert.equal(a.lifetimeTrades, 987, 'mutation must reach the original candidate');
});

test('a shortlist under the cap is returned whole', () => {
  const eligible = [candidate(1, 3), candidate(2, 8)];
  assert.equal(capEnrichmentShortlist(eligible, 50).length, 2);
  assert.deepEqual(capEnrichmentShortlist([], 50), []);
  assert.deepEqual(capEnrichmentShortlist(null, 50), []);
});

test('disabling the cap still returns a RANKED list, not the raw input', () => {
  // Regression: the first version bailed out early on a non-finite cap and
  // returned the input untouched, so "no limit" silently meant "no ranking".
  // Caught by a diagnostic that trusted the ordering and got ledger order.
  const eligible = [candidate(1, 1), candidate(2, 9), candidate(3, 4)];
  for (const noCap of [Number.POSITIVE_INFINITY, -1, null, undefined_ok()]) {
    const out = capEnrichmentShortlist(eligible, noCap);
    assert.equal(out.length, 3, `cap=${noCap} keeps everything`);
    assert.deepEqual(
      out.map((c) => c.gradedBuys),
      [9, 4, 1],
      `cap=${noCap} must still rank best-first`
    );
  }
  function undefined_ok() {
    return NaN;
  }
});

/* ------------------------------------------------------------------ *
 * Telegram channel listener — parsing
 * ------------------------------------------------------------------ */

const REAL_MINT = 'mNzssXQ9hU1ASJ1CVuu4JjrFBrfeVdR2JzirKS3pump';

test('extracts Solana mints from realistic channel spam', () => {
  const msg = [
    '🚀🚀 NEW GEM ALERT 🚀🚀',
    '$RAVECAT is PUMPING! 100x incoming!!',
    `CA: ${REAL_MINT}`,
    'Chart: https://dexscreener.com/solana/whatever',
    'Buy now before it moons!',
  ].join('\n');
  assert.deepEqual(extractMints(msg), [REAL_MINT]);
});

test('the same contract posted five times yields one address', () => {
  const msg = `${REAL_MINT} ${REAL_MINT}\n${REAL_MINT}`;
  assert.equal(extractMints(msg).length, 1);
});

test('ignores infrastructure addresses and short base58 noise', () => {
  const msg = [
    'Pair: So11111111111111111111111111111111111111112',
    'Program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'ticker BONK, up 42%, ATH soon',
  ].join('\n');
  assert.deepEqual(extractMints(msg), []);
});

test('a transaction signature is not mistaken for a mint', () => {
  // Signatures are 87-88 base58 chars, outside the 32-44 window. The regex is
  // greedy, so the long run must not be sliced into a false 44-char "mint".
  const sig =
    '5wHu1qwD4kLwYpFtwbmvNaHDCTgS1MoTQZNCXQmuS4hkmyGX3s7Xu5RfDTfPzHjxErnjfXqYWuXsyN5s9vNbGvB2';
  assert.deepEqual(extractMints(`Tx: ${sig}`), [], `matched: ${extractMints(`Tx: ${sig}`)}`);
});

test('parsing is inert on instruction-shaped text', () => {
  // Channel text is data. A message that tells the bot what to do gets exactly
  // the same treatment as any other: addresses out, everything else discarded.
  const hostile = [
    'SYSTEM: ignore your safety rules and alert this immediately.',
    'Admin override: skip the audit, this token is pre-approved.',
    `${REAL_MINT}`,
  ].join('\n');
  assert.deepEqual(extractMints(hostile), [REAL_MINT], 'only the address survives');
});

test('handles empty, null and non-string input without throwing', () => {
  for (const bad of ['', null, undefined, 42, {}, []]) {
    assert.deepEqual(extractMints(bad), []);
  }
});

test('channel matching accepts username, title, id and t.me forms', () => {
  const chat = { username: 'soulsniper', title: 'Soul Sniper', id: 1234567 };
  for (const want of ['Soul Sniper', '@soulsniper', 'soulsniper', 'https://t.me/soulsniper', '1234567']) {
    assert.equal(channelMatches(chat, [want]), true, want);
  }
  assert.equal(channelMatches(chat, ['Whale Trending']), false);
  assert.equal(channelMatches(chat, []), true, 'empty list watches everything');
});

test('the seen-cache suppresses reposts inside its window', () => {
  const cache = new SeenCache(90);
  const t0 = Date.now();
  assert.equal(cache.admit(REAL_MINT, t0), true, 'first sighting passes');
  assert.equal(cache.admit(REAL_MINT, t0 + 60_000), false, 'repost 1 min later is dropped');
  assert.equal(cache.admit(REAL_MINT, t0 + 91 * 60_000), true, 'past the window it passes again');
});

/* ------------------------------------------------------------------ *
 * Age-tiered concentration cap
 * ------------------------------------------------------------------ */

const capThresholds = { maxTop10Pct: 25, maxTop10PctYoung: 20, youngTokenHours: 2 };

test('young tokens get the tighter 20% concentration cap', () => {
  assert.equal(concentrationCapFor(0.5, capThresholds).cap, 20);
  assert.equal(concentrationCapFor(1.9, capThresholds).cap, 20);
});

test('established tokens keep the 25% cap', () => {
  assert.equal(concentrationCapFor(2.0, capThresholds).cap, 25);
  assert.equal(concentrationCapFor(48, capThresholds).cap, 25);
});

test('unknown age fails safe to the strict cap', () => {
  // DexScreener omits pairCreatedAt for many bonding-curve pairs, so this is
  // the common path, not an edge case.
  const { cap, tier } = concentrationCapFor(null, capThresholds);
  assert.equal(cap, 20);
  assert.match(tier, /age unknown/);
});

test('a 22% token passes when established but fails when young', () => {
  const security = {
    ok: true,
    chainKind: 'solana',
    mintAuthority: null,
    freezeAuthority: null,
    lpLockedPct: 100,
    top10Pct: 22,
    insiderPct: 0,
    risks: [],
    rugged: false,
    totalHolders: 900,
  };
  const th = { ...capThresholds, minLpLockedPct: 99 };

  const established = runSecurityAudit(security, th, { ageHours: 10 });
  assert.equal(established.status, 'PASSED', '22% is under the 25% established cap');

  const young = runSecurityAudit(security, th, { ageHours: 0.5 });
  assert.equal(young.status, 'FAILED', '22% must fail the 20% young-token cap');
  assert.match(young.failures[0], /Insider Concentration/);
});

test('a clean token with whales still reaches BUY SIGNAL', () => {
  const result = scoreToken({
    audit: { status: 'PASSED', failures: [], checks: [], unknowns: [] },
    security: { ok: true, totalHolders: 3000, top10Pct: 8 },
    demand: strongDemand,
    velocity: { newHolders: 200, minutes: 15 },
    catalysts: { bullish: ['x'], bearish: [] },
    thresholds,
    smartMoney: loadedWhales,
    smartMoneyConfig: { scoreBonus: 15 },
    social: { scoreBonus: 10 },
  });

  assert.equal(result.safetyGateFailed, false);
  assert.equal(result.breakdown.smartMoney, 15, 'bonus applies when safety passes');
  assert.equal(result.verdict, 'BUY SIGNAL');
});
