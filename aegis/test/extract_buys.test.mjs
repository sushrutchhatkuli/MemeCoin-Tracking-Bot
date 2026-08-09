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
  applyDeployerVerdict,
  classifySignal,
  evaluateInsiderRequirements,
  evaluateSecurityShield,
  evaluateCommunityTakeover,
  resolveInsiderBypass,
  auditFailuresAreBypassable,
  applyCtoOverride,
  detectMegaRunner,
  tractionFrom,
  isInsiderCategory,
  isAlertableCategory,
  resolveHolderFloor,
  SIGNAL_CATEGORY,
} from '../audit.mjs';
import { alertHeaderLines, buildMessage, maybeAlert, parseCommand, handleCommand } from '../telegram.mjs';
import { stopLossPctFor, armedTrailingLock, evaluateTriggers, detectLiquidityDrain, TRIGGER } from '../sell_notifier.mjs';
import { walletScorecard } from '../wallet_observations.mjs';
import { detectJitoBundles } from '../insider_cluster.mjs';
import { recommendSize, formatSizeLine } from '../position_sizer.mjs';
import { pollOnce, pollerIsLive, pruneWatchState } from '../liquidity_watch.mjs';
import { parseMultiplierRecap } from '../telegram_listener.mjs';
import { awardAlphaPoints, scoreForwardTrade, applyOutcomes, pruneObservations } from '../wallet_observations.mjs';
import { filterLaunchWindow } from '../multiplier_engine.mjs';
import { extractCurveBuy, PUMP_FUN_PROGRAM } from '../smart_money.mjs';
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
  assert.match(line, /2m after launch /);
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
      label: 'ESTABLISHED INSIDER GEM',
      advice: 'established insider advice',
      alertHeader: 'ESTABLISHED INSIDER GEM ALERT ($1M–$10M MC) ',
    },
    insiderEarly: {
      minMarketCapUsd: 30_000,
      maxMarketCapUsd: 500_000,
      scoreBoost: 0,
      label: 'EARLY-STAGE INSIDER SCALP',
      advice: 'early insider advice',
      alertHeader: 'EARLY INSIDER SCALP ALERT ($30k–$500k MC) ',
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
    signalCategory: { alertHeader: 'EARLY INSIDER SCALP ALERT ($30k–$500k MC) ' },
    clusters: insiders(1),
  });
  assert.match(early[0], /EARLY INSIDER SCALP ALERT/);
  assert.equal(early.length, 1, 'a single insider adds no swarm line');

  const swarm = alertHeaderLines({
    signalCategory: { alertHeader: 'ESTABLISHED INSIDER GEM ALERT ($1M–$10M MC) ' },
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
 * High-conviction insider anti-rug bypass
 *
 * This is the one feature in the engine that turns safety gates OFF, so the
 * tests are written from both directions: every assertion that the bypass WORKS
 * is paired with one that it stays contained. The containment half is the more
 * important of the two — a bug that lets the override reach mint authority, an
 * UNVERIFIED audit or the blacklist is a bug that walks a rug into an alert.
 * ------------------------------------------------------------------ */

const bypassConfig = (over = {}) => ({
  smartMoney: { allowInsiderSafetyBypass: true, insiderBypassScoreFloor: 85, ...over },
});

/** A cluster whose top insider carries `score` alpha points. */
const scoredInsiders = (score, count = 2) => ({
  detected: true,
  insiderCount: count,
  label: 'INSIDER CLUSTER',
  // Present and empty, matching what detectInsiderClusters always returns —
  // renderClusters reads both, and a thinner fixture fails inside the renderer
  // rather than at the assertion.
  networks: [],
  oversized: [],
  uniqueInsiders: [
    { wallet: 'InsiderWalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaa', label: 'Elite Whale #1', insiderScore: score },
    { wallet: 'InsiderWalletBbbbbbbbbbbbbbbbbbbbbbbbbbbbb', insiderScore: 10 },
  ],
});

const allowedBypass = (score = 105) =>
  resolveInsiderBypass({ clusters: scoredInsiders(score), config: bypassConfig() });

/** A real FAILED audit whose only failing row is one the bypass covers. */
const lpFailedAudit = (over = {}) =>
  runSecurityAudit(cleanSecurity({ lpLockedPct: 40, ...over }), {
    minLpLockedPct: 99,
    maxTop10Pct: 25,
    maxTotalTaxPct: 5,
  });

test('the bypass unlocks only when it is enabled AND an insider clears the floor', () => {
  const cfg = bypassConfig();

  assert.equal(resolveInsiderBypass({ clusters: scoredInsiders(105), config: cfg }).allowed, true);
  assert.equal(resolveInsiderBypass({ clusters: scoredInsiders(85), config: cfg }).allowed, true, 'the floor is inclusive');
  assert.equal(resolveInsiderBypass({ clusters: scoredInsiders(84.9), config: cfg }).allowed, false);

  // The switch itself.
  const off = resolveInsiderBypass({
    clusters: scoredInsiders(105),
    config: bypassConfig({ allowInsiderSafetyBypass: false }),
  });
  assert.equal(off.allowed, false);
  assert.equal(off.enabled, false);

  // Absent key is off, not on. A loosening must be opted into explicitly.
  assert.equal(resolveInsiderBypass({ clusters: scoredInsiders(105), config: {} }).allowed, false);

  // No insider activity at all — nothing to bypass on.
  assert.equal(resolveInsiderBypass({ clusters: { detected: false }, config: cfg }).allowed, false);
});

test('an insider with no score never clears the floor — unscored is not zero and not a pass', () => {
  const unscored = { detected: true, insiderCount: 3, uniqueInsiders: [{ wallet: 'W1' }, { wallet: 'W2' }] };
  const r = resolveInsiderBypass({ clusters: unscored, config: bypassConfig() });
  assert.equal(r.allowed, false);
  assert.equal(r.score, null);
  assert.match(r.reason, /unscored does not clear the floor/);

  // The HIGHEST scoring insider decides it, not the first or the last.
  const mixed = {
    detected: true,
    insiderCount: 3,
    uniqueInsiders: [{ wallet: 'W1', insiderScore: 4 }, { wallet: 'W2' }, { wallet: 'W3', insiderScore: 90 }],
  };
  const best = resolveInsiderBypass({ clusters: mixed, config: bypassConfig() });
  assert.equal(best.allowed, true);
  assert.equal(best.score, 90);
  assert.equal(best.wallet, 'W3');
});

test('the bypass clears LP, concentration and holders — and nothing else', () => {
  const broken = cleanSecurity({ lpLockedPct: 40, top10Pct: 55, totalHolders: 12 });

  const blocked = evaluateSecurityShield({
    security: broken,
    demand: healthyDemand,
    thresholds: shieldThresholds,
  });
  assert.equal(blocked.passed, false, 'three gates fail without the override');
  assert.equal(blocked.failures.length, 3);

  const bypassed = evaluateSecurityShield({
    security: broken,
    demand: healthyDemand,
    thresholds: shieldThresholds,
    insiderBypass: allowedBypass(),
  });
  assert.equal(bypassed.passed, true);
  assert.equal(bypassed.insiderBypassApplied, true);
  assert.deepEqual(bypassed.bypassedGates, [
    'LP burned / locked',
    'Top 10 non-LP concentration',
    'Minimum unique holders',
  ]);

  // The rows keep their REAL measured values. An alert that reported a clean
  // shield here would be lying about the token it is recommending.
  const lp = bypassed.checks.find((c) => c.gate === 'lp');
  assert.equal(lp.bypassed, true);
  assert.match(lp.detail, /40\.0% burned \/ locked/);
  assert.match(lp.detail, /\[BYPASSED\] did not pass, overridden by insider score 105 ≥ floor 85/);
  // Exactly once — the renderer used to append a second tag of its own.
  assert.equal(lp.detail.match(/\[BYPASSED\]/g).length, 1);

  // Gates outside the set stay absolute, at any score.
  for (const [what, secOver, demandOver] of [
    ['mint authority', { mintAuthority: 'MintAuth1111' }, {}],
    ['freeze authority', { freezeAuthority: 'FreezeAuth111' }, {}],
    ['liquidity depth', {}, { liqToMcapPct: 4, liquidityUsd: 20_000 }],
  ]) {
    const r = evaluateSecurityShield({
      security: cleanSecurity(secOver),
      demand: { ...healthyDemand, ...demandOver },
      thresholds: shieldThresholds,
      insiderBypass: allowedBypass(9_999),
    });
    assert.equal(r.passed, false, `${what} must not be bypassable`);
  }

  // A gate that already passed is never marked bypassed.
  const clean = evaluateSecurityShield({
    security: cleanSecurity(),
    demand: healthyDemand,
    thresholds: shieldThresholds,
    insiderBypass: allowedBypass(),
  });
  assert.equal(clean.insiderBypassApplied, false);
  assert.deepEqual(clean.bypassedGates, []);
});

test('only an audit whose every failure is bypassable can be overridden', () => {
  assert.equal(auditFailuresAreBypassable(lpFailedAudit()), true, 'LP burn alone');
  assert.equal(
    auditFailuresAreBypassable(lpFailedAudit({ top10Pct: 44 })),
    true,
    'LP burn + concentration'
  );

  // One non-bypassable failure poisons the whole audit — a bypassable failure
  // must never carry a live mint authority through alongside it.
  assert.equal(
    auditFailuresAreBypassable(lpFailedAudit({ mintAuthority: 'MintAuth1111' })),
    false
  );
  assert.equal(auditFailuresAreBypassable(lpFailedAudit({ rugged: true })), false);

  // A serial-rugger row is appended by applyDeployerVerdict and is not bypassable.
  const withRugger = applyDeployerVerdict(lpFailedAudit(), {
    status: 'SERIAL RUGGER',
    reasons: ['3 of 4 past deploys dead'],
  });
  assert.equal(auditFailuresAreBypassable(withRugger), false);

  // UNVERIFIED has no failing rows at all. Missing provider data is not a gate
  // an insider score is allowed to vouch for.
  const unverified = runSecurityAudit(cleanSecurity({ lpLockedPct: null }), {
    minLpLockedPct: 99,
    maxTop10Pct: 25,
  });
  assert.equal(unverified.status, 'UNVERIFIED');
  assert.equal(auditFailuresAreBypassable(unverified), false);
  assert.equal(auditFailuresAreBypassable(PASSED), false, 'nothing to bypass on a pass');
});

test('a high-point insider carries an unburned-LP token past the safety gate', () => {
  const base = {
    audit: lpFailedAudit(),
    security: cleanSecurity({ lpLockedPct: 40 }),
    demand: strongDemand,
    velocity: null,
    catalysts: { bullish: [], bearish: [] },
    thresholds,
    clusters: scoredInsiders(105),
    signalCategory: { category: SIGNAL_CATEGORY.INSIDER_EARLY },
  };

  assert.equal(base.audit.status, 'FAILED', 'fixture sanity — the LP gate really failed');

  const bypassed = scoreToken({
    ...base,
    insiderBypass: resolveInsiderBypass({ clusters: base.clusters, config: bypassConfig() }),
  });
  assert.equal(bypassed.safetyGateFailed, false);
  assert.equal(bypassed.safetyGateReason, null);
  assert.notEqual(bypassed.verdict, 'SCAM/AVOID');
  assert.ok(bypassed.score > 0, 'a bypassed token must be able to score, or the switch is inert');
  assert.equal(bypassed.insiderBypass.applied, true);
  assert.equal(bypassed.insiderBypass.score, 105);
  assert.deepEqual(bypassed.insiderBypass.gates, ['Liquidity Pool']);

  // Same token, same insiders, switch off.
  const blocked = scoreToken({
    ...base,
    insiderBypass: resolveInsiderBypass({
      clusters: base.clusters,
      config: bypassConfig({ allowInsiderSafetyBypass: false }),
    }),
  });
  assert.equal(blocked.safetyGateFailed, true, 'blocked when allowInsiderSafetyBypass is false');
  assert.equal(blocked.verdict, 'SCAM/AVOID');
  assert.equal(blocked.score, 0);
  assert.equal(blocked.insiderBypass, null);

  // And below the floor, with the switch on.
  const underFloor = scoreToken({
    ...base,
    clusters: scoredInsiders(60),
    insiderBypass: resolveInsiderBypass({ clusters: scoredInsiders(60), config: bypassConfig() }),
  });
  assert.equal(underFloor.safetyGateFailed, true, 'a 60-point insider is not a 85-point one');
  assert.equal(underFloor.verdict, 'SCAM/AVOID');

  // Omitting the argument entirely is the pre-existing behaviour, unchanged.
  assert.equal(scoreToken(base).safetyGateFailed, true);
});

test('the holder floor is bypassable and the liquidity floor is not', () => {
  const base = {
    audit: PASSED,
    security: cleanSecurity({ totalHolders: 12 }),
    demand: strongDemand,
    velocity: null,
    catalysts: { bullish: [], bearish: [] },
    thresholds,
    clusters: scoredInsiders(105),
  };

  assert.equal(scoreToken(base).verdict, 'UNVERIFIED / LOW HOLDERS');

  const bypassed = scoreToken({ ...base, insiderBypass: allowedBypass() });
  assert.equal(bypassed.safetyGateFailed, false);
  assert.notEqual(bypassed.verdict, 'UNVERIFIED / LOW HOLDERS');
  assert.deepEqual(bypassed.insiderBypass.gates, ['Minimum unique holders']);
  // The gate report still states the truth: 12 holders, floor not passed.
  assert.equal(bypassed.holderGate.passed, false);
  assert.equal(bypassed.holderGate.holders, 12);

  // Depth is outside the override, by specification and on purpose: a pool you
  // cannot exit is untradeable no matter who else is in it.
  const thin = scoreToken({
    ...base,
    security: cleanSecurity(),
    demand: { ...strongDemand, liquidityUsd: 8_000, liqToMcapPct: 3.2 },
    insiderBypass: allowedBypass(9_999),
  });
  assert.equal(thin.verdict, 'THIN LIQUIDITY');
  assert.equal(thin.safetyGateFailed, true);
  assert.equal(thin.score, 0);
});

test('a blacklist, a serial rugger and a mixed audit failure all survive the bypass', () => {
  const base = {
    security: cleanSecurity({ lpLockedPct: 40 }),
    demand: strongDemand,
    velocity: null,
    catalysts: { bullish: [], bearish: [] },
    thresholds,
    clusters: scoredInsiders(9_999),
    insiderBypass: allowedBypass(9_999),
  };

  const blacklisted = scoreToken({
    ...base,
    audit: lpFailedAudit(),
    blacklistHit: { listed: true, reason: 'known rug deployer' },
  });
  assert.equal(blacklisted.verdict, 'SCAM/AVOID');
  assert.equal(blacklisted.safetyGateFailed, true);

  const rugger = scoreToken({
    ...base,
    audit: lpFailedAudit(),
    deployer: { status: 'SERIAL RUGGER', reasons: ['3 of 4 past deploys dead'] },
  });
  assert.equal(rugger.verdict, 'SCAM/AVOID');
  assert.equal(rugger.score, 0);

  // LP burn is bypassable, a live mint authority is not, and the pair together
  // is not bypassable at all.
  const mixed = scoreToken({
    ...base,
    audit: lpFailedAudit({ mintAuthority: 'MintAuth1111' }),
    security: cleanSecurity({ lpLockedPct: 40, mintAuthority: 'MintAuth1111' }),
  });
  assert.equal(mixed.verdict, 'SCAM/AVOID');
  assert.equal(mixed.safetyGateFailed, true);
  assert.equal(mixed.insiderBypass, null);
});

test('the bypass reaches the insider tier gate, or it would unblock nothing', () => {
  // Without this, a bypassed token clears the shield and is then refused a tier,
  // and the notifier drops it at `outside-insider-tiers` — a switch that does
  // nothing at all. Asserted so that stays true.
  const demand = { marketCap: 60_000, liquidityUsd: 25_000, ageHours: 0.4, ageIsLowerBound: false };
  const security = cleanSecurity({ lpLockedPct: 40, top10Pct: 55, totalHolders: 20 });
  const audit = lpFailedAudit({ top10Pct: 55 });

  const blocked = classifySignal({ demand, security, config: insiderConfig, clusters: insiders(), audit });
  assert.equal(blocked.category, SIGNAL_CATEGORY.NONE);
  assert.equal(blocked.insiderRequirements.passed, false);

  const promoted = classifySignal({
    demand,
    security,
    config: { ...insiderConfig, ...bypassConfig() },
    clusters: scoredInsiders(105),
    audit,
    insiderBypass: allowedBypass(),
  });
  assert.equal(promoted.category, SIGNAL_CATEGORY.INSIDER_EARLY);
  assert.equal(promoted.insiderRequirements.passed, true);
  assert.equal(promoted.insiderRequirements.insiderBypassApplied, true);
  assert.deepEqual(promoted.insiderRequirements.bypassedGates, [
    'Contract audit',
    'LP burned / locked',
    'Top 10 concentration',
  ]);

  // Insider detection itself is never waived: with no cluster there is no
  // bypass, so an empty roster cannot promote a token on configuration alone.
  const noInsiders = classifySignal({
    demand,
    security,
    config: { ...insiderConfig, ...bypassConfig() },
    clusters: { detected: false },
    audit,
    insiderBypass: resolveInsiderBypass({ clusters: { detected: false }, config: bypassConfig() }),
  });
  assert.equal(isInsiderCategory(noInsiders.category), false);

  // Mint authority still refuses the tier at any score.
  const minted = classifySignal({
    demand,
    security: cleanSecurity({ lpLockedPct: 40, mintAuthority: 'MintAuth1111' }),
    config: { ...insiderConfig, ...bypassConfig() },
    clusters: scoredInsiders(9_999),
    audit: lpFailedAudit({ mintAuthority: 'MintAuth1111' }),
    insiderBypass: allowedBypass(9_999),
  });
  assert.equal(minted.category, SIGNAL_CATEGORY.NONE);
});

test('the bypassed alert leads with the high-risk notice', () => {
  const lines = alertHeaderLines({
    signalCategory: { alertHeader: 'EARLY INSIDER SCALP ALERT ($30k–$500k MC)' },
    clusters: insiders(2),
    insiderBypass: {
      applied: true,
      score: 105,
      floor: 85,
      wallet: 'InsiderWalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      label: 'Elite Whale #1',
      gates: ['Liquidity Pool', 'Minimum unique holders'],
    },
  });

  assert.match(lines[0], /HIGH-RISK NOTICE: ANTI-RUG SHIELD BYPASSED BY HIGH-CONVICTION INSIDER/);
  assert.match(lines[1], /Matched Insider Score/);
  assert.match(lines[1], /105/);
  assert.match(lines[1], /85\+ required \(High-Alpha Override\)/);
  assert.ok(
    lines.some((l) => /Liquidity Pool, Minimum unique holders/.test(l)),
    'the waived gates are named, not just the fact of a waiver'
  );
  assert.ok(
    lines.some((l) => /Mint authority, freeze authority.*NOT bypassed/.test(l)),
    'and what was still enforced is stated too'
  );
  assert.ok(
    lines.some((l) => /EARLY INSIDER SCALP ALERT/.test(l)),
    'the tier header survives below the notice'
  );

  // No notice on an ordinary alert.
  const plain = alertHeaderLines({
    signalCategory: { alertHeader: 'EARLY INSIDER SCALP ALERT ($30k–$500k MC)' },
    clusters: insiders(2),
  });
  assert.equal(plain.some((l) => /HIGH-RISK NOTICE/.test(l)), false);
});

/**
 * End to end through the dispatcher, which is where the switch either works or
 * does not. Built by running the real classify -> score chain rather than by
 * hand-writing a verdict, so a change that breaks the chain fails here.
 */
function bypassPipeline({ allow = true, insiderScore = 105, security, audit } = {}) {
  const config = {
    ...insiderConfig,
    ...bypassConfig({ allowInsiderSafetyBypass: allow }),
    telegram: {
      enabled: true,
      insiderOnly: true,
      insiderTiersOnly: true,
      insiderMinScore: 68,
      cooldownHours: 6,
    },
  };
  const clusters = scoredInsiders(insiderScore);
  const insiderBypass = resolveInsiderBypass({ clusters, config });
  const demand = { ...strongDemand, marketCap: 60_000 };
  const sec = security ?? cleanSecurity({ lpLockedPct: 40 });
  const aud = audit ?? lpFailedAudit();

  const signalCategory = classifySignal({ demand, security: sec, config, clusters, audit: aud, insiderBypass });
  const verdictInfo = scoreToken({
    audit: aud,
    security: sec,
    demand,
    velocity: null,
    catalysts: { bullish: [], bearish: [] },
    thresholds,
    clusters,
    signalCategory,
    config,
    insiderBypass,
  });

  return {
    config,
    result: { verdictInfo, demand, security: sec, audit: aud, clusters, signalCategory, smartMoney: null, deployer: null },
    pair: { chainId: 'solana', baseToken: { symbol: 'BYPASS', address: MINT } },
  };
}

test('the notifier sends a bypassed token and blocks it when the switch is off', async () => {
  const on = bypassPipeline({ allow: true });
  assert.equal(on.result.verdictInfo.insiderBypass.applied, true);
  assert.ok(on.result.verdictInfo.score >= 68, 'must clear the alert floor or the switch is inert');

  // Stops at 'no-credentials', which is AFTER the safety and audit blocks — so
  // reaching it proves the failed audit did not stop the dispatch.
  const sent = await maybeAlert({
    result: on.result,
    pair: on.pair,
    credentials: {},
    config: on.config,
    alertLog: {},
    now: Date.now(),
  });
  assert.equal(sent.status, 'no-credentials');

  const off = bypassPipeline({ allow: false });
  const blocked = await maybeAlert({
    result: off.result,
    pair: off.pair,
    credentials: {},
    config: off.config,
    alertLog: {},
    now: Date.now(),
  });
  assert.equal(blocked.status, 'blocked-safety');

  // The dispatcher re-derives the bypass from config rather than trusting the
  // verdict. A verdict claiming a bypass while config forbids one is blocked.
  const forged = {
    ...on.result,
    verdictInfo: { ...on.result.verdictInfo, safetyGateFailed: false },
  };
  const refused = await maybeAlert({
    result: forged,
    pair: on.pair,
    credentials: {},
    config: { ...on.config, smartMoney: { allowInsiderSafetyBypass: false } },
    alertLog: {},
    now: Date.now(),
  });
  assert.equal(refused.status, 'blocked-audit-not-passed');
});

test('the bypassed alert body states what was waived instead of showing a clean shield', () => {
  const { result, pair, config } = bypassPipeline({ allow: true });
  const text = buildMessage({
    pair,
    demand: result.demand,
    verdictInfo: { ...result.verdictInfo, securityStatus: result.audit.status },
    smartMoney: null,
    deployer: null,
    security: result.security,
    tradeLink: { template: 'https://example.test/{chain}/{address}', label: 'Trade' },
    reaudit: { ran: false },
    signalCategory: result.signalCategory,
    clusters: result.clusters,
    thresholds: config.thresholds,
    sizerConfig: config,
  });

  assert.match(text, /HIGH-RISK NOTICE: ANTI-RUG SHIELD BYPASSED BY HIGH-CONVICTION INSIDER/);
  assert.match(text, /Matched Insider Score/);
  assert.match(text, /\[BYPASSED\]/);
  // The real LP figure is still printed beside the waived row.
  assert.match(text, /40\.0% burned \/ locked/);
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
    deployer: { status: 'SERIAL RUGGER' },
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
 * Position sizer
 * ------------------------------------------------------------------ */

const sizerCfg = {};

test('the conviction ladder maps score bands to sizes', () => {
  const at = (score) => recommendSize({ score, config: sizerCfg })?.sol ?? null;
  assert.equal(at(67), null, 'below the ladder there is no recommendation');
  assert.equal(at(68), 0.25);
  assert.equal(at(74), 0.25);
  assert.equal(at(75), 0.75);
  assert.equal(at(89), 0.75);
  assert.equal(at(90), 2.0);
  assert.equal(at(100), 2.0);
});

test('a sub-floor score returns null, never a token size', () => {
  // "0.1 SOL" on a 40-score would turn an absence of conviction into a small
  // amount of it, which is the wrong reading for someone acting quickly.
  for (const s of [0, 40, 67, null, undefined, NaN]) {
    assert.equal(recommendSize({ score: s, config: sizerCfg }), null, String(s));
  }
});

test('cabal and bundle decorate the top rung without gating it', () => {
  const clean = recommendSize({ score: 95, clusters: { insiderCount: 1 }, config: sizerCfg });
  assert.equal(clean.sol, 2.0, 'a 95 on clean fundamentals still gets the top size');
  assert.equal(clean.qualifier, null);

  const swarm = recommendSize({ score: 95, clusters: { insiderCount: 5 }, config: sizerCfg });
  assert.match(swarm.label, /Cabal Swarm/);

  const jito = recommendSize({
    score: 95, clusters: { insiderCount: 3, jito: { detected: true } }, config: sizerCfg,
  });
  assert.match(jito.label, /Jito Block #0/);

  // The qualifier must not promote a lower rung.
  const mid = recommendSize({ score: 80, clusters: { insiderCount: 6, jito: { detected: true } }, config: sizerCfg });
  assert.equal(mid.sol, 0.75, 'a swarm at score 80 is still a standard entry');
});

test('pool share is computed and flags a thin pool', () => {
  const deep = recommendSize({ score: 95, demand: { liquiditySol: 800 }, config: sizerCfg });
  assert.equal(Number(deep.poolSharePct.toFixed(2)), 0.25);
  assert.equal(deep.thinPool, false);

  const thin = recommendSize({ score: 95, demand: { liquiditySol: 12 }, config: sizerCfg });
  assert.equal(Number(thin.poolSharePct.toFixed(2)), 16.67);
  assert.equal(thin.thinPool, true);
  assert.equal(thin.sol, 2.0, 'the warning must not shrink the configured size');

  const unknown = recommendSize({ score: 95, demand: {}, config: sizerCfg });
  assert.equal(unknown.poolSharePct, null);
  assert.equal(unknown.thinPool, false, 'unknown depth is not a thin pool');
});

test('the alert line matches the specified format', () => {
  const line = formatSizeLine(recommendSize({ score: 82, config: sizerCfg }));
  assert.equal(line, 'RECOMMENDED BUY SIZE: 0.75 SOL (Standard Entry)');
  const withPool = formatSizeLine(recommendSize({ score: 82, demand: { liquiditySol: 800 }, config: sizerCfg }));
  assert.match(withPool, /^RECOMMENDED BUY SIZE: 0\.75 SOL \(Standard Entry\) — 0\.09% of the pool$/);
  assert.equal(formatSizeLine(null), null);
});

test('the sizer can be disabled entirely', () => {
  assert.equal(recommendSize({ score: 95, config: { positionSizer: { enabled: false } } }), null);
});

/* ------------------------------------------------------------------ *
 * Liquidity drain early warning
 * ------------------------------------------------------------------ */

const drainCfg = { liquidityDrain: { enabled: true, dropPct: 15, maxSampleAgeSeconds: 600 } };
const NOW2 = Date.UTC(2026, 7, 9, 14, 0, 0);
const pos = (lastSol, agoSec) => ({
  symbol: 'TOAD',
  lastLiquiditySol: lastSol,
  lastLiquidityAt: NOW2 - agoSec * 1000,
  firedTriggers: [],
});

test('a >15% reserve drop fires the emergency exit', () => {
  const d = detectLiquidityDrain(pos(100, 45), 80, drainCfg, NOW2);
  assert.ok(d);
  assert.match(d.headline, /EMERGENCY EXIT: LIQUIDITY DRAIN DETECTED/);
  assert.equal(d.closes, true);
  assert.equal(Number(d.dropPct.toFixed(1)), 20.0);
});

test('the alert states the REAL elapsed time, not a configured window', () => {
  // The spec says "within 10 seconds", but this monitor samples on the scan
  // loop (40-195s measured). Reporting 10s would fabricate precision in the
  // exact number used to judge urgency.
  const d = detectLiquidityDrain(pos(100, 87), 70, drainCfg, NOW2);
  assert.match(d.reason, /in 87s/);
  assert.doesNotMatch(d.reason, /in 10s/);
  assert.match(d.reason, /100\.0 → 70\.0 SOL/);
});

test('a drop under the threshold does not fire', () => {
  assert.equal(detectLiquidityDrain(pos(100, 45), 86, drainCfg, NOW2), null, '14% is below 15%');
  assert.equal(detectLiquidityDrain(pos(100, 45), 120, drainCfg, NOW2), null, 'liquidity rising');
});

test('a stale baseline is discarded rather than read as a drain', () => {
  // Comparing against a 20-minute-old sample says the token got quieter, not
  // that someone pulled the pool.
  assert.equal(detectLiquidityDrain(pos(100, 1200), 50, drainCfg, NOW2), null);
  assert.ok(detectLiquidityDrain(pos(100, 599), 50, drainCfg, NOW2), 'inside the window it fires');
});

test('a missing or malformed baseline never fires', () => {
  assert.equal(detectLiquidityDrain(pos(null, 45), 50, drainCfg, NOW2), null);
  assert.equal(detectLiquidityDrain(pos(0, 45), 50, drainCfg, NOW2), null, 'zero baseline');
  assert.equal(detectLiquidityDrain(pos(100, 45), null, drainCfg, NOW2), null, 'unknown current');
  assert.equal(detectLiquidityDrain({}, 50, drainCfg, NOW2), null);
  assert.equal(
    detectLiquidityDrain(pos(100, 45), 50, { liquidityDrain: { enabled: false } }, NOW2),
    null
  );
});

/* ------------------------------------------------------------------ *
 * Pump.fun bonding-curve extraction
 * ------------------------------------------------------------------ */

const CURVE_MINT = 'mNzssXQ9hU1ASJ1CVuu4JjrFBrfeVdR2JzirKS3pump';
const CURVE_BUYER = 'GkjJYRAryyz7xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

/** Shape mirrors a real pump.fun Buy as returned by getTransaction. */
const curveTx = ({ instr = 'Buy', lamports = -8_614_000_000, tokens = 30_000_000, err = null } = {}) => ({
  meta: {
    err,
    fee: 5000,
    preBalances: [20_000_000_000],
    postBalances: [20_000_000_000 + lamports],
    preTokenBalances: [],
    postTokenBalances: tokens
      ? [{ mint: CURVE_MINT, owner: CURVE_BUYER, uiTokenAmount: { uiAmount: tokens } }]
      : [],
    logMessages: [`Program log: Instruction: ${instr}`],
  },
  transaction: { message: { accountKeys: [{ pubkey: CURVE_BUYER, signer: true }] } },
});

test('a bonding-curve Buy yields wallet, SOL spent and entry market cap', () => {
  // 8.614 SOL for 30M of a 1e9 supply -> price x supply x solUsd.
  const b = extractCurveBuy(curveTx(), { mint: CURVE_MINT, solUsd: 76 });
  assert.equal(b.wallet, CURVE_BUYER);
  assert.equal(Number(b.solSpent.toFixed(3)), 8.614);
  assert.equal(b.via, 'bonding-curve');
  // 8.614/30e6 * 1e9 * 76 ≈ $21,822 — inside the $5k-$30k curve window.
  assert.ok(b.entryMarketCapUsd > 20_000 && b.entryMarketCapUsd < 24_000, String(b.entryMarketCapUsd));
});

test('only Buy instructions count — not Create, Sell or the migration', () => {
  for (const instr of ['CreateV2', 'Sell', 'CreatePool', 'Withdraw']) {
    assert.equal(extractCurveBuy(curveTx({ instr }), { mint: CURVE_MINT, solUsd: 76 }), null, instr);
  }
});

test('failed transactions and non-buys are skipped', () => {
  assert.equal(extractCurveBuy(curveTx({ err: { InstructionError: [0, 'x'] } }), { mint: CURVE_MINT }), null);
  assert.equal(extractCurveBuy(curveTx({ tokens: 0 }), { mint: CURVE_MINT }), null, 'no tokens received');
  assert.equal(extractCurveBuy(curveTx({ lamports: 0 }), { mint: CURVE_MINT }), null, 'no SOL spent');
  assert.equal(extractCurveBuy(null, { mint: CURVE_MINT }), null);
});

test('entry market cap is null rather than zero when SOL price is unknown', () => {
  const b = extractCurveBuy(curveTx(), { mint: CURVE_MINT, solUsd: null });
  assert.equal(b.entryMarketCapUsd, null, 'unknown must not read as a $0 entry');
  assert.ok(b.solSpent > 0, 'the SOL figure is still usable');
});

test('a different mint in the same transaction is not credited', () => {
  const tx = curveTx();
  tx.meta.postTokenBalances = [
    { mint: 'SomeOtherMint1111111111111111111111111111111', owner: CURVE_BUYER, uiTokenAmount: { uiAmount: 999 } },
  ];
  assert.equal(extractCurveBuy(tx, { mint: CURVE_MINT, solUsd: 76 }), null);
});

/* ------------------------------------------------------------------ *
 * Multiplier recap parsing
 * ------------------------------------------------------------------ */

const MINT_A = 'mNzssXQ9hU1ASJ1CVuu4JjrFBrfeVdR2JzirKS3pump';
const MINT_B = '7jFpDComUfCZnFrG65CR9wyDesFtA5oJPvUMdfuopump';

test('a recap post yields one row per token with its own multiplier', () => {
  const post = [
    'TODAY\'S CALLS ',
    `$TOAD 42X — ${MINT_A}`,
    `$JEFF 31x | ${MINT_B}`,
    'Join the VIP for more!',
  ].join('\n');

  const { rows } = parseMultiplierRecap(post);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.symbol, r.multiplier, r.address]),
    [['TOAD', 42, MINT_A], ['JEFF', 31, MINT_B]]
  );
});

test('a multiplier on a line without a contract is NOT guessed at', () => {
  // The single most dangerous failure in this parser: pairing 42X with the
  // wrong contract awards alpha to the wrong wallets and marks them protected.
  const post = ['$TOAD did 42X today!', `contract: ${MINT_A}`].join('\n');
  const { rows, unpaired } = parseMultiplierRecap(post);
  assert.equal(rows.length, 0, 'address on the next line must not be paired');
  assert.equal(unpaired, 1, 'and the skip is counted, not silent');
});

test('a line with two contracts is ambiguous and skipped', () => {
  const { rows, unpaired } = parseMultiplierRecap(`30X ${MINT_A} ${MINT_B}`);
  assert.equal(rows.length, 0);
  assert.equal(unpaired, 1);
});

test('multipliers below the floor are ignored', () => {
  const post = `$TOAD 1.5X ${MINT_A}\n$JEFF 10X ${MINT_B}`;
  const { rows } = parseMultiplierRecap(post, { minMultiplier: 2 });
  assert.deepEqual(rows.map((r) => r.multiplier), [10]);
});

test('decimals parse and a repeated contract is credited once', () => {
  assert.equal(parseMultiplierRecap(`$T 12.5x ${MINT_A}`).rows[0].multiplier, 12.5);
  const dupe = parseMultiplierRecap(`$T 12x ${MINT_A}\n$T 40x ${MINT_A}`);
  assert.equal(dupe.rows.length, 1, 'first mention wins; no double credit');
});

test('bare prose and hex-ish noise produce nothing', () => {
  assert.deepEqual(parseMultiplierRecap('we are 100x bullish on solana today').rows, []);
  assert.deepEqual(parseMultiplierRecap('').rows, []);
  assert.deepEqual(parseMultiplierRecap(null).rows, []);
  // "0x..." style tokens must not read as a multiplier of 0.
  assert.deepEqual(parseMultiplierRecap(`0xAbCd 5xyz ${MINT_A}`).rows, []);
});

/* ------------------------------------------------------------------ *
 * Alpha points, protection and forward scoring
 * ------------------------------------------------------------------ */

const alphaCfg = {
  multiplierEngine: {
    pointsPerMultiplier: 2.5, protectAboveMultiplier: 10,
    forwardWinPoints: 5, forwardLossPoints: 8, alphaFloor: -50,
  },
};

test('launch buyers are credited multiplier-weighted points', () => {
  const store = { wallets: {} };
  const r = awardAlphaPoints(store, {
    wallets: ['W1', 'W2'], token: MINT_A, symbol: 'TOAD', multiplier: 42, config: alphaCfg,
  });
  assert.equal(r.credited, 2);
  assert.equal(store.wallets.W1.alpha.points, 105, '42 x 2.5');
  assert.equal(store.wallets.W1.megaWinProtected, true);
  assert.match(store.wallets.W1.megaWinReason, /\$TOAD \(42x\)/);
});

test('a reposted recap cannot compound the same win', () => {
  const store = { wallets: {} };
  const opts = { wallets: ['W1'], token: MINT_A, symbol: 'TOAD', multiplier: 42, config: alphaCfg };
  awardAlphaPoints(store, opts);
  const second = awardAlphaPoints(store, opts);
  assert.equal(second.credited, 0);
  assert.equal(second.skipped, 1);
  assert.equal(store.wallets.W1.alpha.points, 105, 'unchanged on the repost');
});

test('a win below the protection threshold credits but does not protect', () => {
  const store = { wallets: {} };
  awardAlphaPoints(store, { wallets: ['W1'], token: MINT_B, multiplier: 6, config: alphaCfg });
  assert.equal(store.wallets.W1.alpha.points, 15);
  assert.notEqual(store.wallets.W1.megaWinProtected, true);
});

test('protected wallets survive pruning; unprotected ones do not', () => {
  // Past MAX_AGE_MS (90 days) — checked against the constant, not guessed.
  const old = Date.now() - 100 * 86_400_000;
  const store = {
    wallets: {
      PROTECTED: { buys: [{ token: 't', ts: old }], megaWinProtected: true, alpha: { points: 105 } },
      ORDINARY: { buys: [{ token: 't', ts: old }] },
    },
  };
  pruneObservations(store, Date.now());
  assert.ok(store.wallets.PROTECTED, 'kept even with zero surviving buys');
  assert.equal(store.wallets.PROTECTED.alpha.points, 105, 'score survives too');
  assert.equal(store.wallets.PROTECTED.buys.length, 0, 'but its buy history still ages');
  assert.equal(store.wallets.ORDINARY, undefined);
});

test('forward trades award on wins and deduct more on losses', () => {
  const entry = { buys: [], alpha: { points: 100, awarded: {} } };
  assert.equal(scoreForwardTrade(entry, { outcome: 'WIN', config: alphaCfg }).after, 105);
  assert.equal(scoreForwardTrade(entry, { outcome: 'FAIL', config: alphaCfg }).after, 97);
  assert.deepEqual(entry.alpha.forward, { wins: 1, losses: 1 });
  // Asymmetric on purpose: the base rate is ~77% rugged, so symmetric scoring
  // would drift upward on noise alone.
  assert.equal(alphaCfg.multiplierEngine.forwardLossPoints > alphaCfg.multiplierEngine.forwardWinPoints, true);
});

test('a lucky wallet that keeps buying rugs decays back down', () => {
  const entry = { buys: [], alpha: { points: 105, awarded: {} } };
  for (let i = 0; i < 20; i++) scoreForwardTrade(entry, { outcome: 'FAIL', config: alphaCfg });
  assert.equal(entry.alpha.points, -50, 'clamped at the floor, not unbounded');
  assert.equal(entry.alpha.forward.losses, 20);
});

test('ungraded and NEUTRAL outcomes move nothing', () => {
  const entry = { buys: [], alpha: { points: 10, awarded: {} } };
  for (const outcome of ['NEUTRAL', null, undefined, 'PENDING']) {
    assert.equal(scoreForwardTrade(entry, { outcome, config: alphaCfg }), null, String(outcome));
  }
  assert.equal(entry.alpha.points, 10);
});

test('forward scoring only touches wallets that carry an alpha record', () => {
  // Scoring the whole 30,000-entry ledger would just re-derive the win rate
  // walletStats already computes.
  const store = {
    wallets: {
      TRACKED: { buys: [{ token: 'T1', ts: Date.now() }], alpha: { points: 50, awarded: {} } },
      PLAIN: { buys: [{ token: 'T1', ts: Date.now() }] },
    },
  };
  const res = applyOutcomes(store, [{ address: 'T1', verdict: 'FAIL', changePct: -90 }], { config: alphaCfg });
  assert.equal(res.graded, 2, 'both buys are graded');
  assert.equal(res.scored, 1, 'only the tracked wallet is scored');
  assert.equal(res.demoted, 1);
  assert.equal(store.wallets.TRACKED.alpha.points, 42);
  assert.equal(store.wallets.PLAIN.alpha, undefined);
});

/* ------------------------------------------------------------------ *
 * Launch-window filtering
 * ------------------------------------------------------------------ */

test('only buyers with a KNOWN entry inside the window are credited', () => {
  const buyers = [
    { wallet: 'IN1', entryMarketCapUsd: 45_000 },
    { wallet: 'IN2', entryMarketCapUsd: 99_000 },
    { wallet: 'LOW', entryMarketCapUsd: 12_000 },
    { wallet: 'HIGH', entryMarketCapUsd: 400_000 },
    { wallet: 'UNKNOWN', entryMarketCapUsd: null },
  ];
  const r = filterLaunchWindow(buyers, { minMcapUsd: 30_000, maxMcapUsd: 100_000 });
  assert.deepEqual(r.inWindow.map((b) => b.wallet), ['IN1', 'IN2']);
  assert.equal(r.outside, 2);
  // An unattributable entry must not be credited as a launch entry — that is
  // how a wallet that bought the top gets recorded as having bought the bottom.
  assert.equal(r.noEntryPrice, 1);
});

/* ------------------------------------------------------------------ *
 * Dedicated 10-second liquidity poller
 * ------------------------------------------------------------------ */

const pollCfg = {
  sellSignals: {
    liquidityDrain: { enabled: true, dropPct: 15, maxSampleAgeSeconds: 600, pollSeconds: 10 },
  },
};
const openStore = (over = {}) => ({
  positions: {
    'solana:MintA': {
      status: 'OPEN', chain: 'solana', address: 'MintA', symbol: 'TOAD',
      entryMarketCap: 100_000, peakMarketCap: 100_000, alertedAt: NOW2,
      firedTriggers: [], insiders: [], ...over,
    },
  },
});
/** Injected price feed: one pair with a settable SOL reserve. */
const feed = (sol) => async () =>
  new Map([['minta', { liquidity: { quote: sol }, marketCap: 90_000 }]]);

test('the poller detects a drain across two 10-second samples', async () => {
  let state = { heartbeatAt: 0, samples: {}, fired: {} };

  // First poll only establishes a baseline — nothing to compare against yet.
  const first = await pollOnce({
    positions: openStore(), watchState: state, config: pollCfg,
    now: NOW2, fetchPairs: feed(800),
  });
  assert.equal(first.drains.length, 0);
  assert.equal(first.watchState.samples['solana:MintA'].sol, 800);
  state = first.watchState;

  // Ten seconds later the pool is down 30%.
  const second = await pollOnce({
    positions: openStore(), watchState: state, config: pollCfg,
    now: NOW2 + 10_000, fetchPairs: feed(560),
  });
  assert.equal(second.drains.length, 1);
  const d = second.drains[0];
  assert.match(d.headline, /EMERGENCY EXIT/);
  assert.equal(Number(d.dropPct.toFixed(1)), 30.0);
  assert.equal(d.elapsedSec, 10, 'a real 10-second window, which the loop cannot sample');
});

test('the poller does not re-alert the same position', async () => {
  let state = (await pollOnce({
    positions: openStore(), watchState: { heartbeatAt: 0, samples: {}, fired: {} },
    config: pollCfg, now: NOW2, fetchPairs: feed(800),
  })).watchState;

  const fired = await pollOnce({
    positions: openStore(), watchState: state, config: pollCfg,
    now: NOW2 + 10_000, fetchPairs: feed(560),
  });
  assert.equal(fired.drains.length, 1);

  const again = await pollOnce({
    positions: openStore(), watchState: fired.watchState, config: pollCfg,
    now: NOW2 + 20_000, fetchPairs: feed(300),
  });
  assert.equal(again.drains.length, 0, 'already fired for this position');
});

test('a slow bleed under the threshold never fires', async () => {
  let state = { heartbeatAt: 0, samples: {}, fired: {} };
  let sol = 800;
  for (let i = 0; i < 8; i++) {
    sol *= 0.95; // -5% per poll: -34% overall, but never >15% between samples
    const r = await pollOnce({
      positions: openStore(), watchState: state, config: pollCfg,
      now: NOW2 + (i + 1) * 10_000, fetchPairs: feed(sol),
    });
    assert.equal(r.drains.length, 0, `poll ${i + 1}`);
    state = r.watchState;
  }
});

test('the heartbeat is written on every poll, including empty ones', async () => {
  // sell_notifier stands down on the heartbeat, so it must not depend on a
  // detection having happened — or on any position being open.
  const empty = await pollOnce({
    positions: { positions: {} }, watchState: { heartbeatAt: 0, samples: {}, fired: {} },
    config: pollCfg, now: NOW2, fetchPairs: feed(800),
  });
  assert.equal(empty.checked, 0);
  assert.equal(empty.watchState.heartbeatAt, NOW2);
});

test('poller liveness drives the handoff both ways', () => {
  const now = NOW2;
  assert.equal(pollerIsLive({ heartbeatAt: now - 5_000 }, 60, now), true);
  assert.equal(pollerIsLive({ heartbeatAt: now - 59_000 }, 60, now), true);
  assert.equal(pollerIsLive({ heartbeatAt: now - 61_000 }, 60, now), false, 'stale -> loop resumes');
  assert.equal(pollerIsLive({ heartbeatAt: 0 }, 60, now), false);
  assert.equal(pollerIsLive({}, 60, now), false, 'never started -> loop keeps the check');
  assert.equal(pollerIsLive(null, 60, now), false);
});

test('watch state is pruned to positions that are still open', () => {
  const state = {
    heartbeatAt: NOW2,
    samples: { 'solana:A': { sol: 1, at: NOW2 }, 'solana:GONE': { sol: 2, at: NOW2 } },
    fired: { 'solana:A': { at: NOW2 }, 'solana:GONE': { at: NOW2 } },
  };
  const pruned = pruneWatchState(state, ['solana:A']);
  assert.deepEqual(Object.keys(pruned.samples), ['solana:A']);
  assert.deepEqual(Object.keys(pruned.fired), ['solana:A']);
  assert.equal(pruned.heartbeatAt, NOW2, 'heartbeat survives pruning');
});

/* ------------------------------------------------------------------ *
 * Tier-aware holder floor
 * ------------------------------------------------------------------ */

const floorConfig = {
  thresholds: { minUniqueHolders: 150 },
  signalCategories: { insiderEarly: { minHolders: 75 }, insiderEstablished: { minHolders: 1000 } },
};

test('the early tier uses its own holder floor; everything else keeps 150', () => {
  const at = (category) => resolveHolderFloor({ signalCategory: { category }, config: floorConfig });
  assert.equal(at(SIGNAL_CATEGORY.INSIDER_EARLY), 75);
  assert.equal(at(SIGNAL_CATEGORY.INSIDER_ESTABLISHED), 1000);
  assert.equal(at(SIGNAL_CATEGORY.SCALP), 150, 'plain scalp is unchanged');
  assert.equal(at(SIGNAL_CATEGORY.GEM), 150);
  assert.equal(at(SIGNAL_CATEGORY.NONE), 150);
  assert.equal(resolveHolderFloor({ signalCategory: null, config: floorConfig }), 150);
});

test('a tier without its own minHolders falls back to the global floor', () => {
  const noOverride = { thresholds: { minUniqueHolders: 150 }, signalCategories: { insiderEarly: {} } };
  assert.equal(
    resolveHolderFloor({ signalCategory: { category: SIGNAL_CATEGORY.INSIDER_EARLY }, config: noOverride }),
    150
  );
  // No config at all — callers that pass thresholds alone must be unaffected.
  assert.equal(
    resolveHolderFloor({ signalCategory: { category: SIGNAL_CATEGORY.INSIDER_EARLY }, thresholds: { minUniqueHolders: 150 } }),
    150
  );
});

test('an 80-holder early scalp now clears the gate that 150 blocked', () => {
  const base = {
    audit: PASSED,
    security: { ok: true, totalHolders: 80, top10Pct: 10 },
    demand: strongDemand,
    velocity: null,
    catalysts: { bullish: [], bearish: [] },
    thresholds: { ...thresholds, minUniqueHolders: 150 },
  };

  const early = scoreToken({
    ...base,
    signalCategory: { category: SIGNAL_CATEGORY.INSIDER_EARLY },
    config: floorConfig,
  });
  assert.equal(early.safetyGateFailed, false);
  assert.notEqual(early.verdict, 'UNVERIFIED / LOW HOLDERS');
  assert.equal(early.holderGate.floor, 75);

  // The same 80-holder token in any other category is still blocked.
  const scalp = scoreToken({
    ...base,
    signalCategory: { category: SIGNAL_CATEGORY.SCALP },
    config: floorConfig,
  });
  assert.equal(scalp.verdict, 'UNVERIFIED / LOW HOLDERS');
  assert.equal(scalp.score, 0);
});

test('below the tier floor the early scalp is still blocked', () => {
  const r = scoreToken({
    audit: PASSED,
    security: { ok: true, totalHolders: 74, top10Pct: 10 },
    demand: strongDemand,
    velocity: null,
    catalysts: { bullish: [], bearish: [] },
    thresholds: { ...thresholds, minUniqueHolders: 150 },
    signalCategory: { category: SIGNAL_CATEGORY.INSIDER_EARLY },
    config: floorConfig,
  });
  assert.equal(r.verdict, 'UNVERIFIED / LOW HOLDERS');
  assert.equal(r.score, 0);
});

test('the tier itself refuses an unknown holder count', () => {
  // The tier floor is what relaxes the global gate, so it cannot rest on a
  // number that was never read.
  const cfg = {
    ...insiderConfig,
    signalCategories: {
      ...insiderConfig.signalCategories,
      insiderEarly: { ...insiderConfig.signalCategories.insiderEarly, minHolders: 75, minInsiderWallets: 1 },
    },
  };
  const demand = { marketCap: 60_000, liquidityUsd: 25_000, ageHours: 0.4, ageIsLowerBound: false };
  const clusters = clusterOf({ count: 2, clusterSize: 2 });

  const known = classifySignal({
    demand, security: cleanSecurity({ totalHolders: 80 }), config: cfg, clusters, audit: PASSED,
  });
  assert.equal(known.category, SIGNAL_CATEGORY.INSIDER_EARLY);

  const unknown = classifySignal({
    demand, security: cleanSecurity({ totalHolders: null }), config: cfg, clusters, audit: PASSED,
  });
  assert.notEqual(unknown.category, SIGNAL_CATEGORY.INSIDER_EARLY);

  const tooFew = classifySignal({
    demand, security: cleanSecurity({ totalHolders: 60 }), config: cfg, clusters, audit: PASSED,
  });
  assert.notEqual(tooFew.category, SIGNAL_CATEGORY.INSIDER_EARLY);
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
    signalCategory: { alertHeader: 'ESTABLISHED INSIDER GEM ALERT ($1M–$10M MC) ' },
    clusters: insiders(1),
    megaRunner: { detected: true },
    megaRunnerHeader: '380x MEGA-RUNNER VIRAL ALERT ($50k+ Vol & High Demand!) ',
  });
  assert.match(lines[0], /MEGA-RUNNER VIRAL ALERT/);
  assert.match(lines[1], /ESTABLISHED INSIDER GEM/, 'holding style must survive');

  const quiet = alertHeaderLines({
    signalCategory: { alertHeader: 'ESTABLISHED INSIDER GEM ALERT ($1M–$10M MC) ' },
    clusters: insiders(1),
    megaRunner: { detected: false },
    megaRunnerHeader: '380x MEGA-RUNNER VIRAL ALERT ',
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
    'NEW GEM ALERT ',
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
