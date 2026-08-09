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
  detectMegaRunner,
  tractionFrom,
  isInsiderCategory,
  isAlertableCategory,
  SIGNAL_CATEGORY,
} from '../audit.mjs';
import { alertHeaderLines, parseCommand, handleCommand } from '../telegram.mjs';
import { stopLossPctFor, armedTrailingLock, evaluateTriggers, TRIGGER } from '../sell_notifier.mjs';
import { walletScorecard } from '../wallet_observations.mjs';
import { detectJitoBundles } from '../insider_cluster.mjs';
import { pruneCooldown, isOnCooldown, cooldownKey } from '../scan.mjs';
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

/**
 * A contract that satisfies every mandatory requirement.
 *
 * Carries insiderPct, risks and distributionSource even though the shield does
 * not read them: runSecurityAudit does, and a fixture thinner than what
 * fetchSolanaSecurity actually returns fails inside the audit rather than at
 * the assertion, which is a confusing way to learn the fixture was wrong.
 */
const cleanSecurity = (over = {}) => ({
  ok: true,
  chainKind: 'solana',
  mintAuthority: null,
  freezeAuthority: null,
  lpLockedPct: 100,
  top10Pct: 12,
  totalHolders: 2_500,
  insiderPct: 0,
  risks: [],
  rugged: false,
  distributionSource: 'rpc-live',
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
 * Audit cooldown shield
 * ------------------------------------------------------------------ */

const TEN_MIN = 10 * 60_000;
const T0 = Date.UTC(2026, 7, 9, 12, 0, 0);

test('a token is on cooldown for exactly the configured window', () => {
  const store = { [REAL_MINT.toLowerCase()]: T0 };
  assert.equal(isOnCooldown(store, REAL_MINT, TEN_MIN, T0), true, 'immediately after');
  assert.equal(isOnCooldown(store, REAL_MINT, TEN_MIN, T0 + 9 * 60_000), true, '9 minutes later');
  assert.equal(isOnCooldown(store, REAL_MINT, TEN_MIN, T0 + TEN_MIN), false, 'at the boundary');
  assert.equal(isOnCooldown(store, REAL_MINT, TEN_MIN, T0 + 11 * 60_000), false, 'after');
});

test('cooldown lookups are case-insensitive', () => {
  // DexScreener and the RPC disagree on mint casing; a case-sensitive key
  // would silently never match and the shield would do nothing at all.
  const store = { [REAL_MINT.toLowerCase()]: T0 };
  assert.equal(isOnCooldown(store, REAL_MINT.toUpperCase(), TEN_MIN, T0), true);
  assert.equal(cooldownKey('ABC'), 'abc');
});

test('an unseen token is never on cooldown', () => {
  assert.equal(isOnCooldown({}, REAL_MINT, TEN_MIN, T0), false);
  assert.equal(isOnCooldown(null, REAL_MINT, TEN_MIN, T0), false);
  assert.equal(isOnCooldown({ [REAL_MINT.toLowerCase()]: 'not-a-number' }, REAL_MINT, TEN_MIN, T0), false);
});

test('pruning drops expired entries and keeps live ones', () => {
  const store = {
    fresh: T0 - 60_000,
    borderline: T0 - TEN_MIN + 1,
    stale: T0 - 11 * 60_000,
    ancient: T0 - 86_400_000,
    corrupt: null,
  };
  const pruned = pruneCooldown(store, TEN_MIN, T0);
  assert.deepEqual(Object.keys(pruned).sort(), ['borderline', 'fresh']);
});

test('pruning survives a missing or malformed store', () => {
  assert.deepEqual(pruneCooldown(undefined, TEN_MIN, T0), {});
  assert.deepEqual(pruneCooldown({}, TEN_MIN, T0), {});
});

test('the shield rotates the audit window instead of shrinking it', () => {
  // The property that matters: filtering happens BEFORE the cap, so a tick
  // still fills all its slots — with different tokens. Filtering after the
  // slice would have produced 1 audit instead of 3.
  const candidates = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff'].map((a) => ({
    baseToken: { address: a },
  }));
  const cap = 3;
  const store = {};

  const tick = (now) => {
    const fresh = candidates.filter((p) => !isOnCooldown(store, p.baseToken.address, TEN_MIN, now));
    const chosen = fresh.slice(0, cap);
    for (const p of chosen) store[cooldownKey(p.baseToken.address)] = now;
    return chosen.map((p) => p.baseToken.address);
  };

  assert.deepEqual(tick(T0), ['aaa', 'bbb', 'ccc']);
  assert.deepEqual(tick(T0 + 50_000), ['ddd', 'eee', 'fff'], 'second tick is 100% fresh');
  assert.deepEqual(tick(T0 + 100_000), [], 'nothing left uncooled');
  assert.deepEqual(tick(T0 + TEN_MIN + 1000), ['aaa', 'bbb', 'ccc'], 'window reopens');
});

/* ------------------------------------------------------------------ *
 * Multi-wallet cluster requirement for the early scalp tier
 * ------------------------------------------------------------------ */

const clusterOf = ({ count = 0, clusterSize = 0, networkSize = 0, bundle = 0, label = 'X' }) => ({
  detected: true,
  insiderCount: count,
  label,
  clusterBuying: clusterSize ? { size: clusterSize, members: [], windowSec: 60 } : null,
  networks: networkSize ? [{ size: networkSize, funderShort: 'f…x', funderSolscan: '#', members: [] }] : [],
  oversized: [],
  watchlisted: [],
  jito: bundle ? { detected: true, size: bundle, confirmed: false } : { detected: false },
});

const earlyReq = (clusters) =>
  evaluateInsiderRequirements({
    audit: PASSED,
    security: cleanSecurity(),
    clusters,
    thresholds: { maxTop10Pct: 20, minLpLockedPct: 99 },
    minInsiderWallets: 2,
  });

test('a lone NON-ROUTINE BUY SIZE detection is blocked from the early tier', () => {
  // 243 of 301 insider-detected notes on file are exactly this shape: one
  // wallet, one large buy, cluster size 0, no funder network.
  const solo = clusterOf({ count: 0, label: 'NON-ROUTINE BUY SIZE' });
  solo.oversized = [{ short: 'aaa…bbb', reason: '9 SOL buy' }];
  const r = earlyReq(solo);
  assert.equal(r.passed, false);
  assert.match(r.failures.join(' '), /single buyer is not a cluster/);
});

test('one tracked wallet is not a cluster either', () => {
  const r = earlyReq(clusterOf({ count: 1, label: 'INSIDER TRACKED' }));
  assert.equal(r.passed, false);
});

test('two wallets without structural evidence are still blocked', () => {
  // Two watchlisted wallets that bought hours apart is not a cabal — it is two
  // people liking the same coin. The count alone must not satisfy the gate.
  const r = earlyReq(clusterOf({ count: 2, label: 'INSIDER TRACKED' }));
  assert.equal(r.passed, false);
  assert.match(r.failures.join(' '), /none co-buying within the launch window/);
});

test('2 wallets co-buying in the launch window pass', () => {
  const r = earlyReq(clusterOf({ count: 2, clusterSize: 2, label: 'INSIDER CLUSTER' }));
  assert.equal(r.passed, true);
  const row = r.checks.find((c) => c.label.startsWith('Multi-wallet'));
  assert.match(row.detail, /co-buying in the launch window/);
});

test('2 wallets sharing a master funder pass', () => {
  const r = earlyReq(clusterOf({ count: 2, networkSize: 2, label: 'SHARED FUNDER NETWORK' }));
  assert.equal(r.passed, true);
  assert.match(r.checks.find((c) => c.label.startsWith('Multi-wallet')).detail, /sharing a funder/);
});

test('a same-slot bundle satisfies the cluster requirement', () => {
  const r = earlyReq(clusterOf({ count: 3, bundle: 3, label: 'SAME-SLOT CABAL BUNDLE' }));
  assert.equal(r.passed, true);
  assert.match(r.checks.find((c) => c.label.startsWith('Multi-wallet')).detail, /one slot/);
});

test('the established tier is unaffected — no multi-wallet row at all', () => {
  const r = evaluateInsiderRequirements({
    audit: PASSED,
    security: cleanSecurity(),
    clusters: clusterOf({ count: 1, label: 'INSIDER TRACKED' }),
    thresholds: { maxTop10Pct: 20, minLpLockedPct: 99 },
    // default minInsiderWallets = 1
  });
  assert.equal(r.passed, true);
  assert.equal(r.checks.some((c) => c.label.startsWith('Multi-wallet')), false);
});

test('end to end: a single-buy token cannot reach EARLY-STAGE INSIDER SCALP', () => {
  const cfg = {
    ...insiderConfig,
    signalCategories: {
      ...insiderConfig.signalCategories,
      insiderEarly: { ...insiderConfig.signalCategories.insiderEarly, minInsiderWallets: 2 },
    },
  };
  const demand = { marketCap: 60_000, liquidityUsd: 25_000, ageHours: 0.4, ageIsLowerBound: false };
  const solo = clusterOf({ count: 0, label: 'NON-ROUTINE BUY SIZE' });

  const blocked = classifySignal({
    demand, security: cleanSecurity(), config: cfg, clusters: solo, audit: PASSED,
  });
  assert.equal(blocked.category, SIGNAL_CATEGORY.NONE);
  assert.equal(isAlertableCategory(blocked.category), false);

  const allowed = classifySignal({
    demand, security: cleanSecurity(), config: cfg,
    clusters: clusterOf({ count: 2, clusterSize: 2 }), audit: PASSED,
  });
  assert.equal(allowed.category, SIGNAL_CATEGORY.INSIDER_EARLY);
});

/* ------------------------------------------------------------------ *
 * Interactive Telegram commands
 * ------------------------------------------------------------------ */

test('command parsing handles arguments, @botname and non-commands', () => {
  assert.deepEqual(parseCommand('/help'), { command: 'help', args: [] });
  assert.deepEqual(parseCommand('/audit ABC123'), { command: 'audit', args: ['ABC123'] });
  assert.deepEqual(parseCommand('/status@AegisBot'), { command: 'status', args: [] });
  assert.deepEqual(parseCommand('  /AUDIT   xyz  '), { command: 'audit', args: ['xyz'] });
  for (const bad of ['hello', '', null, undefined, 42, 'not /a command']) {
    assert.equal(parseCommand(bad), null, String(bad));
  }
});

test('/help and an unknown command both answer without touching the pipeline', async () => {
  let called = false;
  const deps = { auditOnce: async () => { called = true; return { ok: false, error: 'x' }; } };
  assert.match(await handleCommand({ command: 'help', args: [], deps }), /AEGIS COMMANDS/);
  assert.match(await handleCommand({ command: 'nonsense', args: [], deps }), /Unknown command/);
  assert.equal(called, false);
});

test('/audit validates the address before spending an RPC call', async () => {
  let called = false;
  const deps = { auditOnce: async () => { called = true; return { ok: true }; } };

  assert.match(await handleCommand({ command: 'audit', args: [], deps }), /Usage/);
  assert.match(await handleCommand({ command: 'audit', args: ['not-an-address'], deps }), /does not look like/);
  assert.equal(called, false, 'a malformed address must never reach the pipeline');
});

test('/audit reports the verdict and surfaces a blocked reason', async () => {
  const deps = {
    auditOnce: async () => ({
      ok: true,
      pair: { chainId: 'solana', baseToken: { symbol: 'TOAD', address: REAL_MINT } },
      result: {
        verdictInfo: {
          verdict: 'SCAM/AVOID', score: 0, safetyGateFailed: true,
          safetyGateReason: 'Blacklisted deployer or mint',
        },
        demand: {
          marketCap: 50_000, liquidityUsd: 10_000, liqToMcapPct: 20, ageHours: 3,
          m5: { buys: 4, sells: 9 }, volume: { h1: 12_000 },
        },
        security: { totalHolders: 900, top10Pct: 44.2 },
        audit: { status: 'FAILED', failures: ['Mint Authority: ACTIVE'], unknowns: [] },
        signalCategory: { category: 'UNCLASSIFIED' },
        clusters: { detected: false },
      },
    }),
  };
  const out = await handleCommand({ command: 'audit', args: [REAL_MINT], deps });
  assert.match(out, /AUDIT: \$TOAD/);
  assert.match(out, /SCAM\/AVOID/);
  assert.match(out, /BLOCKED:/);
  assert.match(out, /Mint Authority: ACTIVE/);
});

test('/insiders says so plainly when there is nothing to report', async () => {
  const deps = {
    auditOnce: async () => ({
      ok: true,
      pair: { chainId: 'solana', baseToken: { symbol: 'QUIET', address: REAL_MINT } },
      result: { clusters: { detected: false, buyersSeen: 22 } },
    }),
  };
  const out = await handleCommand({ command: 'insiders', args: [REAL_MINT], deps });
  assert.match(out, /No cluster, funder network/);
  assert.match(out, /22 buyer\(s\) replayed/);
});

test('/status reports positions and the live floors', async () => {
  const deps = {
    loadStatus: async () => ({
      config: {
        telegram: { insiderMinScore: 68 },
        thresholds: {
          maxTop10Pct: 20, minLiqToMcapPct: 15, minUniqueHolders: 150,
          dynamicConcentration: { maxTop10Pct: 30 },
        },
        signalCategories: { insiderEarly: { minInsiderWallets: 2 } },
      },
      positions: {
        positions: {
          a: { status: 'OPEN', symbol: 'TOAD', entryMarketCap: 100_000, peakMarketCap: 250_000,
               alertedAt: Date.now() - 3600_000, firedTriggers: ['TAKE_PROFIT'] },
          b: { status: 'CLOSED', symbol: 'OLD', entryMarketCap: 1, peakMarketCap: 1,
               alertedAt: Date.now(), firedTriggers: [] },
        },
      },
      watchlist: { entries: [1, 2, 3, 4, 5] },
      observations: { wallets: { w1: {}, w2: {} } },
      alertLog: { x: { symbol: 'TOAD', score: 92, sentAt: Date.now() - 7200_000 } },
    }),
  };
  const out = await handleCommand({ command: 'status', args: [], deps });
  assert.match(out, /Open positions: <b>1<\/b>/, 'closed positions excluded');
  assert.match(out, /TOAD/);
  assert.match(out, /Alert score floor: 68/);
  assert.match(out, /Early-scalp cluster: ≥2/);
});

/* ------------------------------------------------------------------ *
 * Dynamic trailing profit lock
 * ------------------------------------------------------------------ */

const trailCfg = {
  stopLossPct: 20,
  takeProfitMultiple: 1.5,
  insiderExitPct: 40,
  trailingStop: {
    enabled: true,
    tiers: [
      { peakGainPct: 50, lockGainPct: 20 },
      { peakGainPct: 100, lockGainPct: 60 },
    ],
  },
};
const position = (peakMult, over = {}) => ({
  entryMarketCap: 100_000,
  peakMarketCap: 100_000 * peakMult,
  firedTriggers: [],
  insiders: [],
  ...over,
});

test('the trailing lock arms at +50% and ratchets at +100%', () => {
  assert.equal(armedTrailingLock(position(1.4), trailCfg), null, 'below the first tier');
  assert.equal(armedTrailingLock(position(1.5), trailCfg).lockGainPct, 20);
  assert.equal(armedTrailingLock(position(1.99), trailCfg).lockGainPct, 20);
  assert.equal(armedTrailingLock(position(2.0), trailCfg).lockGainPct, 60);
  assert.equal(armedTrailingLock(position(5.0), trailCfg).lockGainPct, 60, 'highest tier holds');
});

test('the armed level is derived from the peak, so it can never walk back down', () => {
  // The ratchet is structural: peakMarketCap only rises, so the lock only
  // rises. No stored state to migrate, and a restart cannot lose it.
  const p = position(2.5);
  assert.equal(armedTrailingLock(p, trailCfg).lockGainPct, 60);
  p.peakMarketCap = 300_000; // peak never falls in practice, but assert anyway
  assert.equal(armedTrailingLock(p, trailCfg).lockGainPct, 60);
});

test('falling through the armed floor fires TRAILING_PROFIT_LOCKED and closes', () => {
  const p = position(1.8); // peaked +80% -> +20% floor armed
  const above = evaluateTriggers(p, 130_000, [], trailCfg);
  assert.equal(above.find((t) => t.trigger === TRIGGER.TRAILING_LOCK), undefined, '+30% is above the floor');

  const through = evaluateTriggers(p, 118_000, [], trailCfg);
  const fired = through.find((t) => t.trigger === TRIGGER.TRAILING_LOCK);
  assert.ok(fired, 'fires at +18%, below the +20% floor');
  assert.match(fired.headline, /TRAILING PROFIT LOCKED/);
  assert.equal(fired.closes, true);
  assert.match(fired.reason, /Peaked at \+80%/);
});

test('an armed trailing lock suppresses the fixed stop-loss', () => {
  // Both would otherwise fire on a hard reversal, sending two alerts for one
  // exit — the second reporting a loss on a trade that closed in profit.
  const p = position(2.2); // +60% floor armed
  const out = evaluateTriggers(p, 70_000, [], trailCfg); // -30%, through both
  assert.equal(out.filter((t) => t.trigger === TRIGGER.STOP_LOSS).length, 0);
  assert.equal(out.filter((t) => t.trigger === TRIGGER.TRAILING_LOCK).length, 1);
});

test('a position that never ran keeps the ordinary stop-loss', () => {
  const p = position(1.1);
  const out = evaluateTriggers(p, 75_000, [], trailCfg);
  assert.ok(out.find((t) => t.trigger === TRIGGER.STOP_LOSS), 'no lock armed, stop-loss applies');
  assert.equal(out.find((t) => t.trigger === TRIGGER.TRAILING_LOCK), undefined);
});

test('a delisted pair still reports even with a lock armed', () => {
  // Liquidity being pulled is not a profitable exit and must never be
  // suppressed by the trailing logic.
  const p = position(2.5);
  const out = evaluateTriggers(p, null, [], trailCfg);
  const sl = out.find((t) => t.trigger === TRIGGER.STOP_LOSS);
  assert.ok(sl);
  assert.match(sl.headline, /DELISTED/);
});

test('a gap straight through the floor reads as a signed loss, not "+-30%"', () => {
  const p = position(2.2);
  const fired = evaluateTriggers(p, 70_000, [], trailCfg).find((t) => t.trigger === TRIGGER.TRAILING_LOCK);
  assert.match(fired.reason, /fell back to -30%/);
  assert.doesNotMatch(fired.reason, /\+-/);
  assert.match(fired.action, /no longer a profitable exit/);
});

test('the trailing lock fires at most once per position', () => {
  const p = position(1.8, { firedTriggers: [TRIGGER.TRAILING_LOCK] });
  const out = evaluateTriggers(p, 110_000, [], trailCfg);
  assert.equal(out.find((t) => t.trigger === TRIGGER.TRAILING_LOCK), undefined);
});

test('trailing can be disabled entirely', () => {
  const off = { ...trailCfg, trailingStop: { enabled: false } };
  assert.equal(armedTrailingLock(position(3), off), null);
  const out = evaluateTriggers(position(3), 70_000, [], off);
  assert.ok(out.find((t) => t.trigger === TRIGGER.STOP_LOSS), 'falls back to the fixed stop');
});

/* ------------------------------------------------------------------ *
 * Insider scorecard
 * ------------------------------------------------------------------ */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 9);
const buy = (daysAgo, outcome, changePct = null, solSpent = 1) => ({
  token: `T${daysAgo}${outcome}`, ts: NOW - daysAgo * DAY, outcome, changePct, solSpent,
});

test('the scorecard counts only buys inside the rolling window', () => {
  const entry = {
    buys: [
      buy(2, 'WIN', 100), buy(10, 'WIN', 50), buy(20, 'FAIL', -80),
      buy(45, 'WIN', 900), // outside 30d — must not inflate the win rate
    ],
  };
  const sc = walletScorecard(entry, { solUsd: 100, windowDays: 30, now: NOW });
  assert.equal(sc.gradedBuys, 3);
  assert.equal(sc.wins, 2);
  assert.equal(Math.round(sc.winRatePct), 67);
});

test('NEUTRAL and ungraded buys are excluded from the win rate', () => {
  const entry = { buys: [buy(1, 'WIN', 10), buy(2, 'NEUTRAL', 0), buy(3, null, null)] };
  const sc = walletScorecard(entry, { solUsd: 100, now: NOW });
  assert.equal(sc.gradedBuys, 1);
  assert.equal(sc.winRatePct, 100);
  assert.equal(sc.observedBuys, 3, 'still reported as observed');
});

test('profit is estimated from priced buys and is null when none are priced', () => {
  const priced = walletScorecard({ buys: [buy(1, 'WIN', 100, 2)] }, { solUsd: 50, now: NOW });
  assert.equal(Math.round(priced.estimatedProfitUsd), 100, '2 SOL x $50 x +100%');

  const unpriced = walletScorecard({ buys: [buy(1, 'WIN', null, null)] }, { solUsd: 50, now: NOW });
  assert.equal(unpriced.estimatedProfitUsd, null, 'never zero — unknown is not break-even');
});

test('holding duration is reported as unavailable, never guessed', () => {
  // Nothing in the pipeline records an exit, so this cannot be computed. The
  // flag exists so no caller can mistake a missing field for zero hours.
  const sc = walletScorecard({ buys: [buy(1, 'WIN', 10)] }, { solUsd: 50, now: NOW });
  assert.equal(sc.holdingDurationHours, null);
  assert.equal(sc.holdingDurationAvailable, false);
  assert.ok(sc.trackedForHours > 0, 'time on radar is measurable and is a different thing');
});

test('a wallet with no history yields a null win rate rather than 0%', () => {
  const sc = walletScorecard({ buys: [] }, { solUsd: 50, now: NOW });
  assert.equal(sc.winRatePct, null, '0% would read as "always loses"');
  assert.equal(sc.gradedBuys, 0);
});

/* ------------------------------------------------------------------ *
 * Jito / same-slot bundle tracer
 * ------------------------------------------------------------------ */

const slotBuyer = (i, slot, secondsAfterLaunch = 5) => ({
  wallet: `Buyer${String(i).padStart(3, '0')}xxxxxxxxxxxxxxxxxxxxxxxxxxx`,
  slot, secondsAfterLaunch, signature: `sig${i}`, solSpent: 1,
});

test('3+ wallets in one slot is a bundle; 2 is not', () => {
  const three = [slotBuyer(1, 500), slotBuyer(2, 500), slotBuyer(3, 500), slotBuyer(4, 900)];
  const r = detectJitoBundles(three, { minBundleWallets: 3 }, { confirm: false });
  return r.then((res) => {
    assert.equal(res.detected, true);
    assert.equal(res.size, 3);
    assert.equal(res.slot, 500);
    assert.equal(res.confirmed, false, 'unconfirmed without the API');
    assert.match(res.label, /SAME-SLOT/);
  });
});

test('two wallets in a slot do not qualify', async () => {
  const r = await detectJitoBundles(
    [slotBuyer(1, 500), slotBuyer(2, 500), slotBuyer(3, 900)],
    { minBundleWallets: 3 },
    { confirm: false }
  );
  assert.equal(r.detected, false);
});

test('one wallet with several legs in a slot is one participant, not three', async () => {
  // Otherwise a single busy trader manufactures a "three-wallet cabal".
  const same = slotBuyer(1, 500);
  const r = await detectJitoBundles(
    [same, { ...same }, { ...same }, slotBuyer(2, 500)],
    { minBundleWallets: 3 },
    { confirm: false }
  );
  assert.equal(r.detected, false, 'two distinct wallets after de-duplication');
});

test('buyers without a slot are ignored rather than grouped together', async () => {
  const r = await detectJitoBundles(
    [slotBuyer(1, null), slotBuyer(2, null), slotBuyer(3, null)],
    { minBundleWallets: 3 },
    { confirm: false }
  );
  assert.equal(r.detected, false, 'null slots must not collide into one group');
});

test('the launch window excludes late same-slot buyers', async () => {
  const late = [slotBuyer(1, 500, 4000), slotBuyer(2, 500, 4000), slotBuyer(3, 500, 4000)];
  assert.equal(
    (await detectJitoBundles(late, { minBundleWallets: 3, bundleLaunchWindowSeconds: 300 }, { confirm: false })).detected,
    false
  );
  const early = late.map((b) => ({ ...b, secondsAfterLaunch: 12 }));
  assert.equal(
    (await detectJitoBundles(early, { minBundleWallets: 3, bundleLaunchWindowSeconds: 300 }, { confirm: false })).detected,
    true
  );
});

/* ------------------------------------------------------------------ *
 * Dynamic concentration cap + mega-runner boost
 * ------------------------------------------------------------------ */

const dynThresholds = {
  maxTop10Pct: 20,
  maxTop10PctYoung: 20,
  minLpLockedPct: 99,
  minUniqueHolders: 150,
  minLiqToMcapPct: 15,
  minAbsoluteLiquidityUsd: 100_000,
  dynamicConcentration: { enabled: true, minHolders: 300, minVolume1hUsd: 50_000, maxTop10Pct: 30 },
};
const viral = { holders: 3_500, volume1h: 250_000 };

test('the cap widens to 30% only when BOTH traction inputs clear their floors', () => {
  assert.equal(concentrationCapFor(10, dynThresholds, viral).cap, 30);
  assert.equal(concentrationCapFor(10, dynThresholds, viral).widened, true);

  for (const [what, t] of [
    ['too few holders', { holders: 299, volume1h: 250_000 }],
    ['too little volume', { holders: 3_500, volume1h: 49_999 }],
    ['holders unknown', { holders: null, volume1h: 250_000 }],
    ['volume unknown', { holders: 3_500, volume1h: null }],
    ['no traction supplied', null],
  ]) {
    assert.equal(concentrationCapFor(10, dynThresholds, t).cap, 20, `${what} keeps the base cap`);
  }
});

test('the widened cap can be disabled and never narrows an already-looser cap', () => {
  const off = { ...dynThresholds, dynamicConcentration: { ...dynThresholds.dynamicConcentration, enabled: false } };
  assert.equal(concentrationCapFor(10, off, viral).cap, 20);

  // A config whose base cap already exceeds the widened value must not be cut.
  const loose = { ...dynThresholds, maxTop10Pct: 40, maxTop10PctYoung: 40 };
  assert.equal(concentrationCapFor(10, loose, viral).cap, 40);
});

test('a 25% token passes the audit on traction and fails without it', () => {
  const sec = cleanSecurity({ top10Pct: 25, totalHolders: 3_500 });
  const viralDemand = { ageHours: 10, volume: { h1: 250_000 } };
  const quietDemand = { ageHours: 10, volume: { h1: 4_000 } };

  const hot = runSecurityAudit(sec, dynThresholds, {
    ageHours: 10,
    traction: tractionFrom(sec, viralDemand),
  });
  assert.equal(hot.status, 'PASSED');

  const cold = runSecurityAudit(sec, dynThresholds, {
    ageHours: 10,
    traction: tractionFrom(sec, quietDemand),
  });
  assert.equal(cold.status, 'FAILED');
});

test('all four cap derivations agree — audit, shield, insider gate, re-audit', () => {
  // The cap is computed in four places. When they drift, the alert states one
  // limit while a different one is enforced. This escaped review once already:
  // the audit passed a 25% token at the widened cap while the insider-tier
  // gate still hardcoded 20 and rejected it, so the widening silently did
  // nothing for the tier that produces most alerts.
  const sec = cleanSecurity({ top10Pct: 25, totalHolders: 3_500 });
  const demand = {
    ageHours: 10, volume: { h1: 250_000 },
    liqToMcapPct: 30, liquidityUsd: 200_000, marketCap: 660_000,
  };

  const audit = runSecurityAudit(sec, dynThresholds, {
    ageHours: 10, traction: tractionFrom(sec, demand),
  });
  assert.equal(audit.status, 'PASSED', 'contract audit');

  const shield = evaluateSecurityShield({ security: sec, demand, thresholds: dynThresholds });
  assert.equal(shield.passed, true, 'shield');
  assert.match(
    shield.checks.find((c) => c.label === 'Top 10 non-LP concentration').detail,
    /limit 30%/
  );

  const req = evaluateInsiderRequirements({
    audit, security: sec, clusters: insiders(2), thresholds: dynThresholds, demand,
  });
  assert.equal(req.passed, true, 'insider-tier requirements must use the same cap');
  assert.match(req.checks.find((c) => c.label === 'Top 10 concentration').detail, /limit 30%/);

  // The re-audit derives its cap the same way (telegram.mjs passes the same
  // traction); assert the shared helper agrees rather than re-deriving here.
  assert.equal(concentrationCapFor(10, dynThresholds, tractionFrom(sec, demand)).cap, 30);
});

test('a viral token reaches an insider tier instead of being blocked at 20%', () => {
  const sec = cleanSecurity({ top10Pct: 25, totalHolders: 3_500 });
  const demand = {
    marketCap: 420_000, liquidityUsd: 95_000, ageHours: 6, ageIsLowerBound: false,
    volume: { h1: 640_000 }, m5: { buys: 210, sells: 45 },
  };
  const audit = runSecurityAudit(sec, dynThresholds, {
    ageHours: 6, traction: tractionFrom(sec, demand),
  });
  const r = classifySignal({
    demand, security: sec,
    config: { ...insiderConfig, thresholds: dynThresholds },
    clusters: insiders(2), audit,
  });
  assert.equal(r.category, SIGNAL_CATEGORY.INSIDER_EARLY);
  assert.equal(isAlertableCategory(r.category), true);
});

test('the mega-runner boost needs volume AND a 3x ratio AND real buy count', () => {
  const cfg = { megaRunner: { minVolume1hUsd: 50_000, minBuySellRatio: 3, minBuys: 10, scoreBoost: 25 } };
  const hit = detectMegaRunner({
    demand: { volume: { h1: 120_000 }, m5: { buys: 90, sells: 20 } },
    config: cfg,
  });
  assert.equal(hit.detected, true);
  assert.equal(hit.scoreBoost, 25);

  for (const [what, demand] of [
    ['volume short', { volume: { h1: 49_999 }, m5: { buys: 90, sells: 20 } }],
    ['ratio short', { volume: { h1: 120_000 }, m5: { buys: 50, sells: 20 } }],
    ['too few buys', { volume: { h1: 120_000 }, m5: { buys: 6, sells: 1 } }],
    ['no volume data', { volume: {}, m5: { buys: 90, sells: 20 } }],
  ]) {
    assert.equal(detectMegaRunner({ demand, config: cfg }).detected, false, what);
  }
});

test('zero sells does not hand out a boost on a single buy', () => {
  // demand.m5.ratio is Infinity when sells are zero, which clears any threshold
  // on its own — so the ratio is recomputed here behind the buy-count floor.
  const cfg = { megaRunner: { minVolume1hUsd: 50_000, minBuySellRatio: 3, minBuys: 10, scoreBoost: 25 } };
  const one = detectMegaRunner({
    demand: { volume: { h1: 80_000 }, m5: { buys: 1, sells: 0 } },
    config: cfg,
  });
  assert.equal(one.detected, false, '1 buy / 0 sells is not viral demand');

  const many = detectMegaRunner({
    demand: { volume: { h1: 80_000 }, m5: { buys: 40, sells: 0 } },
    config: cfg,
  });
  assert.equal(many.detected, true, '40 buys / 0 sells is');
});

test('the mega-runner boost is forfeited unless the audit affirmatively PASSED', () => {
  const base = {
    security: { ok: true, totalHolders: 5_000, top10Pct: 10 },
    demand: strongDemand,
    velocity: null,
    catalysts: { bullish: [], bearish: [] },
    thresholds,
    megaRunner: { detected: true, scoreBoost: 25 },
  };
  const passed = scoreToken({ ...base, audit: PASSED });
  assert.equal(passed.breakdown.megaRunner, 25);

  // UNVERIFIED means the gates could not be checked, which is not "passed".
  const unverified = scoreToken({
    ...base,
    audit: { status: 'UNVERIFIED', checks: [], failures: [], unknowns: ['x'] },
  });
  assert.equal(unverified.breakdown.megaRunner, 0, 'wash volume cannot buy 25 points on an unverified contract');

  const failed = scoreToken({
    ...base,
    audit: { status: 'FAILED', checks: [], failures: ['Mint Authority: ACTIVE'], unknowns: [] },
  });
  assert.equal(failed.breakdown.megaRunner, 0);
});

test('the viral banner leads the alert but does not replace the tier header', () => {
  const lines = alertHeaderLines({
    signalCategory: { alertHeader: '💎 ESTABLISHED INSIDER GEM ALERT ($1M–$10M MC) 💎' },
    clusters: insiders(1),
    megaRunner: { detected: true },
    megaRunnerHeader: '🔥 380x MEGA-RUNNER VIRAL ALERT ($50k+ Vol & High Demand!) 🔥',
  });
  assert.match(lines[0], /MEGA-RUNNER VIRAL ALERT/);
  assert.match(lines[1], /ESTABLISHED INSIDER GEM/, 'holding style must survive');

  const quiet = alertHeaderLines({
    signalCategory: { alertHeader: '💎 ESTABLISHED INSIDER GEM ALERT ($1M–$10M MC) 💎' },
    clusters: insiders(1),
    megaRunner: { detected: false },
    megaRunnerHeader: '🔥 380x MEGA-RUNNER VIRAL ALERT 🔥',
  });
  assert.match(quiet[0], /ESTABLISHED INSIDER GEM/, 'no banner when it did not fire');
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
