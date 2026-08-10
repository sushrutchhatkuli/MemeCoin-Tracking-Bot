/**
 * Security audit, supply/demand metrics and confidence scoring.
 *
 * Security is a hard gate: any failed check forces a SCAM/AVOID verdict and the
 * confidence score is capped, regardless of how strong the price action looks.
 */

const pct = (n) => (n === null || n === undefined ? null : Number(n));
const ratio = (a, b) => (b > 0 ? a / b : a > 0 ? Infinity : 0);

/* ------------------------------------------------------------------ *
 * 1. Zero-tolerance security checklist
 * ------------------------------------------------------------------ */

/**
 * Checks are tri-state: true (passed), false (affirmatively failed), or null
 * (the provider has no data yet — common for tokens minutes old).
 *
 * "Unknown" must never be collapsed into "failed". Marking an unindexed token
 * SCAM/AVOID poisons the blacklist with tokens that were merely too new, and it
 * teaches you to distrust the one label that has to stay trustworthy.
 */
/**
 * Concentration cap, tightened for young tokens.
 *
 * A token in its first couple of hours has no track record, and insider
 * accumulation is easiest to hide there — so it gets a buffer below the
 * standard cap.
 *
 * When age cannot be determined the STRICT cap applies. DexScreener omits
 * `pairCreatedAt` for many bonding-curve pairs, so unknown age is common rather
 * than exotic; defaulting to the loose cap would quietly hand the buffer back
 * to exactly the newest tokens it exists to protect against.
 */
/**
 * The traction context that can widen the concentration cap.
 *
 * Built in ONE place because four call sites derive the cap — the contract
 * audit, the shield, the insider-tier requirements and the pre-dispatch
 * re-audit — and if any of them computed it differently the alert would state
 * one limit while a different one was enforced. The re-audit is the dangerous
 * one: a stricter cap there would cancel alerts the audit had already cleared.
 */
export function tractionFrom(security, demand) {
  return {
    holders: security?.ok ? (security.totalHolders ?? null) : null,
    volume1h: demand?.volume?.h1 ?? null,
  };
}

export function concentrationCapFor(ageHours, thresholds, traction = null) {
  const strict = thresholds.maxTop10PctYoung ?? 20;
  const standard = thresholds.maxTop10Pct ?? 20;

  // A single flat cap by default. The age-tiered variant is retained only for
  // configs that still set a looser `maxTop10Pct`, and even then the strict cap
  // applies whenever age cannot be proven.
  const youngHours = thresholds.youngTokenHours ?? 2;
  const base =
    strict === standard
      ? { cap: strict, tier: 'all tokens' }
      : ageHours === null || ageHours === undefined
        ? { cap: strict, tier: 'age unknown — strict cap applied' }
        : ageHours < youngHours
          ? { cap: strict, tier: `young (<${youngHours}h)` }
          : { cap: standard, tier: `established (≥${youngHours}h)` };

  // ---- Dynamic widening for tokens with proven traction ------------
  //
  // A token with thousands of holders and real turnover is a different animal
  // from a fresh launch where ten wallets hold everything: the float is being
  // actively traded, so a higher top-10 share is less likely to be a bundle
  // sitting on the supply waiting to exit into you.
  //
  // "Less likely" is the honest strength of this. Both inputs are cheap to
  // fake — volume by wash trading between wallets you control, holder count by
  // dusting — and neither is evidence that the top ten will not sell. This
  // widens a SAFETY gate on the strength of two metrics a motivated scammer
  // can manufacture, which is why it is opt-out via
  // thresholds.dynamicConcentration.enabled and why both inputs must be
  // affirmatively known: unknown holders or unknown volume keep the base cap.
  const dyn = thresholds.dynamicConcentration ?? {};
  if (dyn.enabled === false || !traction) return base;

  const { holders, volume1h } = traction;
  const holderFloor = dyn.minHolders ?? 300;
  const volumeFloor = dyn.minVolume1hUsd ?? 50_000;
  const widened = dyn.maxTop10Pct ?? 30;

  const qualifies =
    holders !== null && holders !== undefined && holders >= holderFloor &&
    volume1h !== null && volume1h !== undefined && volume1h >= volumeFloor;

  // Never narrows. If the base cap is already looser, keep it.
  if (!qualifies || widened <= base.cap) return base;

  return {
    cap: widened,
    tier: `high-volume (${holders} holders, $${Math.round(volume1h).toLocaleString('en-US')} 1h vol)`,
    widened: true,
    baseCap: base.cap,
  };
}

export function runSecurityAudit(security, thresholds, { ageHours = null, traction = null } = {}) {
  const checks = [];
  const add = (label, passed, detail) => checks.push({ label, passed, detail });
  const { cap: top10Cap, tier: ageTier } = concentrationCapFor(ageHours, thresholds, traction);

  if (!security?.ok) {
    add('Security data', null, `Unavailable — ${security?.error ?? 'unknown error'}`);
    return {
      status: 'UNVERIFIED',
      checks,
      failures: [],
      unknowns: ['Security provider returned no report for this contract'],
    };
  }

  if (security.chainKind === 'solana') {
    add(
      'Mint Authority',
      security.mintAuthority === null,
      security.mintAuthority === null
        ? 'Revoked / Null'
        : `ACTIVE — dev can mint infinite supply (${security.mintAuthority})`
    );

    add(
      'Freeze Authority',
      security.freezeAuthority === null,
      security.freezeAuthority === null
        ? 'Revoked / Null'
        : `ACTIVE — dev can freeze your wallet (${security.freezeAuthority})`
    );

    add(
      'Liquidity Pool',
      security.lpLockedPct === null ? null : security.lpLockedPct >= thresholds.minLpLockedPct,
      security.lpLockedPct === null
        ? 'LP lock status not yet indexed'
        : `${security.lpLockedPct.toFixed(1)}% burned / locked (required ≥ ${thresholds.minLpLockedPct}%)`
    );

    const insiderNote = security.graphInsidersDetected
      ? ` — ${security.graphInsidersDetected} insider wallets in ${security.insiderNetworks} bundle network(s)`
      : '';
    const sourceNote =
      security.distributionSource === 'rpc-live'
        ? ' [live on-chain]'
        : ' [cached indexer — may lag]';
    add(
      'Insider Concentration',
      security.top10Pct === null
        ? null
        : security.top10Pct < top10Cap && security.insiderPct < 10,
      security.top10Pct === null
        ? 'Holder distribution not yet indexed'
        : `Top 10 non-DEX hold ${security.top10Pct.toFixed(1)}% (limit ${top10Cap}% — ${ageTier})${sourceNote}, flagged insiders ${security.insiderPct.toFixed(1)}%${insiderNote}`
    );

    add(
      'Rug / Danger Flags',
      !security.rugged && !security.risks.some((r) => r.level === 'danger'),
      security.rugged
        ? 'Token already marked RUGGED'
        : security.risks.filter((r) => r.level === 'danger').map((r) => r.name).join(', ') ||
          'No danger-level risks reported'
    );
  } else if (security.chainKind === 'evm') {
    const tax = security.totalTaxPct;
    add(
      'Buy/Sell Tax',
      tax === null ? null : tax < thresholds.maxTotalTaxPct,
      tax === null
        ? 'Tax not yet simulated by provider (token too new to index)'
        : `${security.buyTaxPct.toFixed(1)}% buy / ${security.sellTaxPct.toFixed(1)}% sell = ${tax.toFixed(1)}% total (limit ${thresholds.maxTotalTaxPct}%)`
    );

    add(
      'Honeypot Simulation',
      !security.isHoneypot && !security.cannotSellAll,
      security.isHoneypot
        ? 'HONEYPOT — simulated sell failed'
        : security.cannotSellAll
          ? 'Cannot sell full balance'
          : 'Simulated sell passed'
    );

    const hiddenFns = [
      security.hasBlacklist && 'blacklist',
      security.hasWhitelist && 'whitelist',
      security.transferPausable && 'pausable transfers',
      security.hiddenOwner && 'hidden owner',
      security.canTakeBackOwnership && 'ownership reclaim',
      security.selfDestruct && 'self-destruct',
    ].filter(Boolean);
    add(
      'Contract Code',
      security.isOpenSource && hiddenFns.length === 0,
      !security.isOpenSource
        ? 'Source NOT verified on-chain'
        : hiddenFns.length
          ? `Hidden functions present: ${hiddenFns.join(', ')}`
          : 'Verified, no hidden whitelist/blacklist functions'
    );

    add(
      'Mint / Supply Control',
      !security.isMintable,
      security.isMintable ? 'Contract is MINTABLE' : 'Supply fixed, not mintable'
    );

    add(
      'Insider Concentration',
      security.top10Pct === null ? null : security.top10Pct < top10Cap,
      security.top10Pct === null
        ? 'Holder distribution not yet indexed'
        : `Top 10 non-LP hold ${security.top10Pct.toFixed(1)}% (limit ${top10Cap}% — ${ageTier})`
    );
  }

  const failures = checks
    .filter((c) => c.passed === false)
    .map((c) => `${c.label}: ${c.detail}`);
  const unknowns = checks
    .filter((c) => c.passed === null)
    .map((c) => `${c.label}: ${c.detail}`);

  const status = failures.length ? 'FAILED' : unknowns.length ? 'UNVERIFIED' : 'PASSED';
  return { status, checks, failures, unknowns };
}

/**
 * Fold the deployer verdict into the security audit.
 *
 * A serial rugger forces the overall audit to FAILED even when every contract
 * check passed. The individual contract check rows are left untouched so the
 * note still shows exactly what the contract did and did not do — only the
 * aggregate status changes, and the added row makes the reason explicit.
 */
export function applyDeployerVerdict(audit, deployer) {
  if (deployer?.status !== 'SERIAL RUGGER') return audit;

  const detail = deployer.reasons?.[0] ?? 'Deployer flagged as a serial rugger';
  return {
    ...audit,
    status: 'FAILED',
    checks: [...audit.checks, { label: 'Deployer Reputation', passed: false, detail }],
    failures: [...audit.failures, `Deployer Reputation: ${detail}`],
  };
}

/* ------------------------------------------------------------------ *
 * 2. Supply / demand micro-structure
 * ------------------------------------------------------------------ */

export function analyzeDemand(pair, security) {
  const txns = pair?.txns ?? {};
  const window = (key) => ({
    buys: txns[key]?.buys ?? 0,
    sells: txns[key]?.sells ?? 0,
    ratio: ratio(txns[key]?.buys ?? 0, txns[key]?.sells ?? 0),
  });

  const marketCap = pct(pair?.marketCap ?? pair?.fdv) ?? 0;
  // Bonding-curve pairs sometimes omit liquidity; RugCheck's pool total is the fallback.
  const liquidityUsd = pct(pair?.liquidity?.usd) ?? pct(security?.totalMarketLiquidity) ?? 0;

  return {
    m5: window('m5'),
    h1: window('h1'),
    h6: window('h6'),
    h24: window('h24'),
    marketCap,
    liquidityUsd,
    // The SOL side of the pool. Used by the position sizer to express a
    // recommended size as a share of the pool, and captured as the baseline
    // the drain detector measures against.
    liquiditySol: pct(pair?.liquidity?.quote) ?? null,
    liqToMcapPct: marketCap > 0 ? (liquidityUsd / marketCap) * 100 : 0,
    volume: {
      m5: pct(pair?.volume?.m5) ?? 0,
      h1: pct(pair?.volume?.h1) ?? 0,
      h24: pct(pair?.volume?.h24) ?? 0,
    },
    priceChange: {
      m5: pct(pair?.priceChange?.m5) ?? 0,
      h1: pct(pair?.priceChange?.h1) ?? 0,
      h6: pct(pair?.priceChange?.h6) ?? 0,
      h24: pct(pair?.priceChange?.h24) ?? 0,
    },
    ...resolveAge(pair, security),
  };
}

/**
 * Age, with an explicit provenance flag.
 *
 * `pairCreatedAt` is authoritative but absent on most bonding-curve pairs, so
 * the indexer's first-sighting timestamp is used as a floor when it is missing.
 * That floor is a LOWER BOUND — the token existed at least that long — which is
 * safe for "is this young?" but must never be used to prove "this is ≥24h old".
 * `ageIsLowerBound` records which one it is so callers can require certainty.
 */
function resolveAge(pair, security) {
  if (pair?.pairCreatedAt) {
    return {
      ageHours: (Date.now() - pair.pairCreatedAt) / 3.6e6,
      ageSource: 'pairCreatedAt',
      ageIsLowerBound: false,
    };
  }
  if (security?.detectedAt) {
    return {
      ageHours: (Date.now() - security.detectedAt) / 3.6e6,
      ageSource: 'indexer-first-seen',
      ageIsLowerBound: true,
    };
  }
  return { ageHours: null, ageSource: null, ageIsLowerBound: true };
}

/* ------------------------------------------------------------------ *
 * Dual-mode signal classification
 * ------------------------------------------------------------------ */

export const SIGNAL_CATEGORY = {
  CTO: 'COMMUNITY TAKEOVER GEM',
  INSIDER_EARLY: 'EARLY-STAGE INSIDER SCALP',
  INSIDER_ESTABLISHED: 'ESTABLISHED INSIDER GEM',
  GEM: 'LONG-TERM GEM',
  SCALP: 'FAST SCALP',
  NONE: 'UNCLASSIFIED',
};

const INSIDER_CATEGORIES = new Set([
  SIGNAL_CATEGORY.INSIDER_EARLY,
  SIGNAL_CATEGORY.INSIDER_ESTABLISHED,
]);

/** Categories the notifier will dispatch on: the two insider tiers plus CTO. */
const ALERTABLE_CATEGORIES = new Set([...INSIDER_CATEGORIES, SIGNAL_CATEGORY.CTO]);

/** True for the two insider-backed tiers, which the notifier gates on. */
export const isInsiderCategory = (category) => INSIDER_CATEGORIES.has(category);

/** True for any category cleared to send a Telegram alert. */
export const isAlertableCategory = (category) => ALERTABLE_CATEGORIES.has(category);

/** signalCategories key for a classified category, or null for the plain tiers. */
const TIER_CONFIG_KEY = {
  [SIGNAL_CATEGORY.INSIDER_EARLY]: 'insiderEarly',
  [SIGNAL_CATEGORY.INSIDER_ESTABLISHED]: 'insiderEstablished',
  [SIGNAL_CATEGORY.CTO]: 'communityTakeover',
};

/**
 * The unique-holder floor that applies to a token, which is tier-aware.
 *
 * The global `thresholds.minUniqueHolders` (150) is the default and applies to
 * everything unclassified. A tier may set its own `minHolders` to override it —
 * the early insider band does, at 75, so fresh $30k-$75k launches can clear the
 * gate while their holder base is still small.
 *
 * That override is a LOOSENING of a safety gate and should be read as one.
 * Holder count is a separate axis from concentration: ten wallets can each hold
 * a clean 8% and still leave a token exit-trapped because there is nobody to
 * sell to. See the note beside insiderEarly.minHolders in config.json for the
 * measured record of the band below it.
 */
export function resolveHolderFloor({ signalCategory, config = {}, thresholds = null }) {
  const th = thresholds ?? config.thresholds ?? {};
  const globalFloor = th.minUniqueHolders ?? 150;

  const key = TIER_CONFIG_KEY[signalCategory?.category];
  if (!key) return globalFloor;

  const tierFloor = config.signalCategories?.[key]?.minHolders;
  return typeof tierFloor === 'number' ? tierFloor : globalFloor;
}

/* ------------------------------------------------------------------ *
 * High-conviction insider bypass
 * ------------------------------------------------------------------ */

/**
 * OPT-IN OVERRIDE OF THE ANTI-RUG SHIELD. Read this before enabling it.
 *
 * When `smartMoney.allowInsiderSafetyBypass` is true and a matched insider
 * carries a score at or above `smartMoney.insiderBypassScoreFloor`, three gates
 * stop blocking that token: LP burn/lock, top-10 concentration, and the unique
 * holder floor. Nothing else moves.
 *
 * ── WHAT THIS IS TRADING AWAY ───────────────────────────────────────────────
 * Those three gates are not bureaucracy. An unburned LP is the developer's
 * ability to withdraw the pool; a concentrated top 10 is the wallets who will
 * be selling into you; a thin holder base is the absence of anyone to sell to.
 * A wallet with a high alpha score buying the token does not alter any of the
 * three — it is a statement about the buyer, not about the contract.
 *
 * The comment on the security-first gate in scoreToken names the exact attack
 * this opens: "A malicious dev can trivially buy their own scam from a wallet
 * on someone's alpha list; if smart money could lift the score, that would be a
 * way to walk a rug straight past the audit." That path is now open by
 * configuration. The bar is the score floor and nothing else, and an alpha
 * score is earned by being present at one winning token — see the selection-bias
 * warning in multiplier_engine.mjs, which is a warning about this exact number.
 *
 * ── WHAT IS DELIBERATELY NOT BYPASSABLE ─────────────────────────────────────
 *   - MINT and FREEZE authority. No score makes a live mint authority safe;
 *     the dev can print supply or freeze your wallet regardless of who bought.
 *   - RUG / DANGER flags and a SERIAL RUGGER deployer. A rugger's token with a
 *     high-alpha buyer is a rugger's token with a high-alpha buyer.
 *   - The BLACKLIST.
 *   - LIQUIDITY DEPTH. Not in the specified set, and left alone: a pool you
 *     cannot exit is untradeable no matter who else is in it.
 *   - UNVERIFIED audits. A bypass overrides a gate that FAILED on known data.
 *     It never converts missing data into a pass — "we could not check" is not
 *     "an insider vouched for it", and every other unknown in this pipeline
 *     fails closed for the same reason.
 */

/**
 * Contract-audit rows a high-conviction insider may override, by label.
 *
 * Matched against `audit.checks[].label` from runSecurityAudit rather than
 * against the failure strings, because the labels are stable and the details
 * carry interpolated numbers.
 */
const BYPASSABLE_AUDIT_CHECKS = new Set(['Liquidity Pool', 'Insider Concentration']);

/** Shield gate keys the bypass may clear. */
export const BYPASSABLE_SHIELD_GATES = new Set(['lp', 'concentration', 'holders']);

/**
 * True only when the audit failed AND every failing row is one of the two the
 * bypass covers.
 *
 * The `every` is what keeps this narrow: a token failing LP burn *and* mint
 * authority returns false, so one bypassable failure can never carry a
 * non-bypassable one through with it. An audit with no failures at all (i.e.
 * UNVERIFIED, which fails on unknowns) returns false — there is nothing to
 * bypass, and unknown data is not a gate the override is allowed to touch.
 */
export function auditFailuresAreBypassable(audit) {
  const failed = (audit?.checks ?? []).filter((c) => c.passed === false);
  return failed.length > 0 && failed.every((c) => BYPASSABLE_AUDIT_CHECKS.has(c.label));
}

/**
 * The score attached to one matched insider, or null when it carries none.
 *
 * Two real sources, in priority order:
 *   `insiderScore` — attached by scan.mjs from the observation ledger's alpha
 *                    points (multiplier_engine's earned score, decayed forward
 *                    by every graded trade since).
 *   `score`        — a hand-set field on a smart_wallets.json entry, for a
 *                    wallet you rate yourself.
 *
 * ABSENCE IS NOT ZERO AND IS NOT A PASS. A wallet with no score returns null
 * and cannot clear the floor, so an insider Aegis knows nothing about never
 * unlocks a bypass.
 */
const insiderScoreOf = (m) => {
  for (const v of [m?.insiderScore, m?.alphaPoints, m?.alpha?.points, m?.score]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
};

/**
 * The highest-scoring matched insider, or null when none carries a score.
 *
 * Exported because /audit reports this number and the bypass gates on it, and
 * two implementations of "which insider counts" would eventually disagree about
 * which wallet the alert is naming.
 */
export function topInsiderScore({ clusters = null, smartMoney = null } = {}) {
  const roster = [
    ...(clusters?.uniqueInsiders ?? clusters?.watchlisted ?? []),
    ...(smartMoney?.matches ?? []),
  ];

  let best = null;
  for (const m of roster) {
    const score = insiderScoreOf(m);
    if (score === null) continue;
    if (!best || score > best.score) {
      best = {
        score,
        wallet: m.wallet ?? m.address ?? null,
        label: m.label ?? m.displayLabel ?? null,
      };
    }
  }
  return best;
}

/**
 * Resolve whether this token's insiders unlock the safety bypass.
 *
 * Pure and side-effect free, so both the scorer and the notifier can call it
 * independently — the notifier re-derives it at dispatch rather than trusting
 * the verdict, the same double-check the hard safety block already uses.
 */
export function resolveInsiderBypass({ clusters = null, smartMoney = null, config = {} } = {}) {
  const cfg = config.smartMoney ?? {};
  const floor = cfg.insiderBypassScoreFloor ?? 85;
  const enabled = cfg.allowInsiderSafetyBypass === true;
  const base = { enabled, allowed: false, floor, score: null, wallet: null, label: null };

  if (!enabled) return { ...base, reason: 'insider safety bypass is disabled' };
  if (!clusters?.detected) return { ...base, reason: 'no insider activity to bypass on' };

  // The deduplicated roster, plus any smart-money holder matches. Both are
  // "matched insiders" for this purpose; neither counts without a score.
  const best = topInsiderScore({ clusters, smartMoney });

  if (!best) {
    return { ...base, reason: 'no matched insider carries a score — unscored does not clear the floor' };
  }
  if (best.score < floor) {
    return { ...base, ...best, reason: `top insider scores ${best.score}, under the ${floor} floor` };
  }
  return { ...base, ...best, allowed: true, reason: null };
}

/* ------------------------------------------------------------------ *
 * Mandatory anti-rugpull shield
 * ------------------------------------------------------------------ */

/**
 * The six hard gates, in one place, as one testable function.
 *
 * These were already enforced — spread across runSecurityAudit (mint, freeze,
 * LP, top 10), scoreToken (holders, depth) and maybeAlert. Collecting them here
 * does not change what passes; it makes the rule set readable as a unit and
 * lets a test assert the whole shield rather than three modules interacting.
 * runSecurityAudit and scoreToken remain the enforcement path, so a bug here
 * cannot open a hole there.
 *
 * ── ON THE CTO EXEMPTION ────────────────────────────────────────────────────
 * A community takeover is allowed to bypass EXACTLY ONE gate: the liquidity
 * DEPTH RATIO, and only by satisfying an absolute-dollar floor instead.
 *
 * It is not allowed to bypass mint authority, freeze authority, LP burn, top-10
 * concentration or the holder floor. Those describe what the contract can still
 * do to you, and a community rallying around a token cannot revoke a mint
 * authority the developer kept. If anything, an abandoned token with a live
 * mint authority is MORE dangerous, not less — the crowd is the exit liquidity.
 *
 * The ratio carve-out exists because it is the one gate a genuine CTO fails for
 * a reason unrelated to safety: the pattern is a token whose market cap ran far
 * ahead of its original pool. $RAVECAT sat at 2.9% liquidity-to-market-cap with
 * a real $218k pool. Requiring 15% there would not have made anyone safer; it
 * would only have meant the CTO tier could never fire on the exact pattern it
 * is named after.
 *
 * ── ON THE HIGH-CONVICTION INSIDER BYPASS ───────────────────────────────────
 * An `insiderBypass` with `allowed: true` clears the LP, concentration and
 * holder rows — three of the six — when they failed. The rows are NOT hidden:
 * each keeps its real measured detail, is marked `bypassed`, and the reason is
 * appended, so the alert states what was overridden rather than reporting a
 * clean shield. See resolveInsiderBypass above for what that costs.
 */
export function evaluateSecurityShield({
  security,
  demand,
  thresholds = {},
  cto = null,
  holderFloorOverride = null,
  insiderBypass = null,
}) {
  const rows = [];
  const add = (gate, label, passed, detail) =>
    rows.push({ gate, label, passed: passed === true, detail });

  const evm = security?.chainKind === 'evm';
  // Same dynamic cap the contract audit applied, derived from the same helper.
  // Hardcoding maxTop10Pct here would print a 20% limit in the alert while the
  // audit had enforced 30%.
  const { cap: top10Cap, widened: capWidened } = concentrationCapFor(
    demand?.ageHours ?? null,
    thresholds,
    tractionFrom(security, demand)
  );
  const lpFloor = thresholds.minLpLockedPct ?? 99;
  // Caller-supplied so the shield prints the SAME floor scoreToken enforced.
  // A tier with its own minHolders relaxes the global one, and a hardcoded 150
  // here would state a limit in the alert that was never applied.
  const holderFloor = holderFloorOverride ?? thresholds.minUniqueHolders ?? 150;
  const depthFloorPct = thresholds.minLiqToMcapPct ?? 15;
  const absoluteFloor = thresholds.minAbsoluteLiquidityUsd ?? 100_000;

  if (evm) {
    add(
      'mint',
      'Mint / supply control',
      security?.isMintable === false,
      security?.isMintable === false ? 'Supply fixed, not mintable' : 'Mintable or unknown'
    );
    add('freeze', 'Freeze authority', true, 'Not applicable on EVM');
  } else {
    add(
      'mint',
      'Mint authority revoked',
      security?.ok === true && security.mintAuthority === null,
      security?.ok !== true
        ? 'Security report unavailable'
        : security.mintAuthority === null
          ? 'Revoked / Null'
          : `ACTIVE — dev can mint infinite supply (${security.mintAuthority})`
    );
    add(
      'freeze',
      'Freeze authority revoked',
      security?.ok === true && security.freezeAuthority === null,
      security?.ok !== true
        ? 'Security report unavailable'
        : security.freezeAuthority === null
          ? 'Revoked / Null'
          : `ACTIVE — dev can freeze your wallet (${security.freezeAuthority})`
    );
  }

  const lp = security?.lpLockedPct;
  add(
    'lp',
    'LP burned / locked',
    lp !== null && lp !== undefined && lp >= lpFloor,
    lp === null || lp === undefined
      ? 'LP lock status not indexed — unknown does not pass'
      : `${lp.toFixed(1)}% burned / locked (required ≥ ${lpFloor}%)`
  );

  const top10 = security?.top10Pct;
  add(
    'concentration',
    'Top 10 non-LP concentration',
    top10 !== null && top10 !== undefined && top10 < top10Cap,
    top10 === null || top10 === undefined
      ? 'Holder distribution not indexed — unknown does not pass'
      : `Top 10 hold ${top10.toFixed(1)}% (limit ${top10Cap}%${capWidened ? ', widened for proven traction' : ''})`
  );

  const holders = security?.ok ? security.totalHolders : null;
  add(
    'holders',
    'Minimum unique holders',
    holders !== null && holders !== undefined && holders >= holderFloor,
    holders === null || holders === undefined
      ? 'Holder count unknown — unknown does not pass'
      : `${holders} holders (floor ${holderFloor})`
  );

  // Depth: the ratio, or — for a confirmed CTO only — an absolute-dollar pool.
  const ratio = demand?.liqToMcapPct;
  const liqUsd = demand?.liquidityUsd ?? 0;
  const ratioOk = ratio !== null && ratio !== undefined && ratio >= depthFloorPct;
  const ctoDepthOk = cto?.detected === true && liqUsd >= absoluteFloor;
  add(
    'depth',
    'Liquidity depth',
    ratioOk || ctoDepthOk,
    ratio === null || ratio === undefined
      ? 'Liquidity depth unknown — unknown does not pass'
      : ratioOk
        ? `${ratio.toFixed(1)}% of market cap (floor ${depthFloorPct}%)`
        : ctoDepthOk
          ? `${ratio.toFixed(1)}% of market cap — under the ${depthFloorPct}% ratio, cleared on the $${absoluteFloor.toLocaleString('en-US')} absolute floor (CTO)`
          : `${ratio.toFixed(1)}% of market cap — below the ${depthFloorPct}% floor`
  );

  // High-conviction insider override, applied AFTER every row is measured so the
  // alert can print what the token actually is alongside what was waived. A row
  // that already passed is never touched, so `bypassedGates` lists only gates
  // that genuinely failed and were overridden.
  const bypass = insiderBypass?.allowed === true ? insiderBypass : null;
  const bypassedGates = [];
  if (bypass) {
    for (const r of rows) {
      if (r.passed || !BYPASSABLE_SHIELD_GATES.has(r.gate)) continue;
      r.passed = true;
      r.bypassed = true;
      // The marker lives in the detail rather than only on the flag, so a row
      // read on its own — a log line, a failures array — still says it did not
      // pass. The renderer prints the detail verbatim and adds no second tag.
      r.detail = `${r.detail} — [BYPASSED] did not pass, overridden by insider score ${bypass.score} ≥ floor ${bypass.floor}`;
      bypassedGates.push(r.label);
    }
  }

  const failures = rows.filter((r) => !r.passed).map((r) => `${r.label}: ${r.detail}`);
  return {
    passed: failures.length === 0,
    checks: rows,
    failures,
    ctoDepthWaiver: ctoDepthOk && !ratioOk,
    insiderBypassApplied: bypassedGates.length > 0,
    bypassedGates,
    insiderBypass: bypassedGates.length > 0 ? bypass : null,
  };
}

/* ------------------------------------------------------------------ *
 * Community Takeover (CTO) engine
 * ------------------------------------------------------------------ */

/**
 * Detect a token the community picked up after the developer walked away.
 *
 * The four criteria are a proxy for one question: is there a real crowd here,
 * trading real size, in a pool deep enough to matter, on a token the dev no
 * longer controls? None of the four is meaningful alone — holders can be
 * sybilled, volume can be washed, a dev can move funds to a second wallet and
 * look "exited". Together they are decent evidence, and they are treated as
 * decent evidence rather than proof.
 *
 * WHAT THIS OVERRIDES, precisely:
 *   - the dev-exit penalty: RugCheck creator-sold style risk flags stop
 *     counting against the score, because for a CTO the dev being gone is the
 *     PREMISE, not a warning.
 *   - the liquidity depth RATIO, replaced by an absolute-dollar floor in
 *     evaluateSecurityShield.
 *
 * WHAT IT DOES NOT OVERRIDE, and must never:
 *   - mint authority, freeze authority, LP burn, top-10 concentration, the
 *     holder floor. A crowd cannot revoke an authority the developer kept.
 *   - a SERIAL RUGGER deployer. A rugger's abandoned token is still a rugger's
 *     token, and "the community took it over" is the exact story that would be
 *     told to launder one.
 *
 * `devExit` must be supplied by the caller — audit.mjs makes no network calls.
 * scan.mjs resolves it from chain, and only after the three free criteria pass,
 * so the RPC read costs nothing on the tokens that were never candidates.
 */
export function evaluateCommunityTakeover({ demand, security, deployer, devExit = null, config = {} }) {
  const cfg = config.communityTakeover ?? {};
  if (cfg.enabled === false) return { detected: false, checks: [], failures: ['CTO detection disabled'] };

  const rows = [];
  const add = (label, passed, detail) => rows.push({ label, passed: passed === true, detail });

  const minHolders = cfg.minHolders ?? 500;
  const minVol1h = cfg.minVolume1hUsd ?? 100_000;
  const minLiq = cfg.minLiquidityUsd ?? 30_000;
  const maxDevPct = cfg.maxDevBalancePct ?? 1;

  const holders = security?.ok ? security.totalHolders : null;
  add(
    'Community floor',
    holders !== null && holders !== undefined && holders >= minHolders,
    holders === null || holders === undefined
      ? 'Holder count unknown'
      : `${holders} holders (need ≥ ${minHolders})`
  );

  const vol1h = demand?.volume?.h1 ?? null;
  add(
    '1-hour volume',
    vol1h !== null && vol1h >= minVol1h,
    vol1h === null
      ? 'Volume unavailable'
      : `$${Math.round(vol1h).toLocaleString('en-US')} in 1h (need ≥ $${minVol1h.toLocaleString('en-US')})`
  );

  const liq = demand?.liquidityUsd ?? null;
  add(
    'Pool depth',
    liq !== null && liq >= minLiq,
    liq === null
      ? 'Liquidity unavailable'
      : `$${Math.round(liq).toLocaleString('en-US')} pool (need ≥ $${minLiq.toLocaleString('en-US')})`
  );

  // Dev exit. Unknown is a failure: "we could not find the developer's balance"
  // is not the same claim as "the developer has gone", and the whole tier rests
  // on that distinction.
  const soldFlag = devExit?.sold === true;
  const pct = devExit?.balancePct;
  const pctOk = pct !== null && pct !== undefined && pct <= maxDevPct;
  add(
    'Developer exited',
    soldFlag || pctOk,
    soldFlag
      ? `Dev sell observed on-chain${pct !== null && pct !== undefined ? ` — holds ${pct.toFixed(2)}%` : ''}`
      : pct === null || pct === undefined
        ? 'Developer balance could not be read — unknown does not pass'
        : `Developer holds ${pct.toFixed(2)}% (need ≤ ${maxDevPct}%)`
  );

  const failures = rows.filter((r) => !r.passed).map((r) => `${r.label}: ${r.detail}`);
  const allPassed = failures.length === 0;

  // A serial rugger is disqualifying regardless of how strong the takeover
  // looks. Checked after the criteria so the report still shows what the token
  // did and did not meet.
  const serialRugger = deployer?.status === 'SERIAL RUGGER';
  if (allPassed && serialRugger) {
    return {
      detected: false,
      checks: rows,
      failures: ['Deployer is a serial rugger — a takeover does not launder that'],
      blockedBySerialRugger: true,
    };
  }

  return {
    detected: allPassed,
    checks: rows,
    failures,
    scoreBoost: allPassed ? (cfg.scoreBoost ?? 20) : 0,
    devExit: devExit ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Mega-runner viral volume
 * ------------------------------------------------------------------ */

/**
 * Detect the viral-volume signature: real money moving through the pool while
 * buyers heavily outnumber sellers in the last five minutes.
 *
 * The 5-minute window is the point — it catches the token WHILE the imbalance
 * is happening rather than after, which is also why it is the noisiest signal
 * in the engine. Two guards keep it from firing on nothing:
 *
 *   - a minimum buy count, because a 3:1 ratio off 3 buys and 1 sell is not
 *     demand, it is rounding. This mirrors detectCatalysts, which has required
 *     `m5.buys >= 10` alongside every ratio test since the beginning.
 *   - an infinite ratio (zero sells) still needs that buy count, so a single
 *     buy into a dead pool cannot score.
 *
 * WHAT THIS CANNOT TELL YOU: volume and buy/sell counts are both cheap to
 * manufacture. A wash trader cycling SOL between their own wallets produces
 * exactly this signature, and produces it deliberately because it is what
 * scanners like this one look for. Treat it as "something is happening here",
 * not as "the something is organic".
 */
export function detectMegaRunner({ demand, config = {} }) {
  const cfg = config.megaRunner ?? {};
  if (cfg.enabled === false) return { detected: false, scoreBoost: 0, reasons: [] };

  const minVol = cfg.minVolume1hUsd ?? 50_000;
  const minRatio = cfg.minBuySellRatio ?? 3;
  const minBuys = cfg.minBuys ?? 10;

  const vol1h = demand?.volume?.h1 ?? null;
  const buys = demand?.m5?.buys ?? 0;
  const sells = demand?.m5?.sells ?? 0;
  // Recompute rather than trusting demand.m5.ratio, which is Infinity when
  // sells are zero and would otherwise clear any threshold on its own.
  const ratio = sells > 0 ? buys / sells : buys > 0 ? Infinity : 0;

  const volumeOk = vol1h !== null && vol1h >= minVol;
  const demandOk = buys >= minBuys && ratio >= minRatio;
  const detected = volumeOk && demandOk;

  return {
    detected,
    scoreBoost: detected ? (cfg.scoreBoost ?? 25) : 0,
    ratio,
    volume1h: vol1h,
    buys,
    sells,
    reasons: detected
      ? [
          `$${Math.round(vol1h).toLocaleString('en-US')} traded in 1h (floor $${minVol.toLocaleString('en-US')})`,
          `${buys} buys vs ${sells} sells in 5m (${ratio === Infinity ? '∞' : ratio.toFixed(1)}x, floor ${minRatio}x)`,
        ]
      : [],
    checks: { volume: volumeOk, demand: demandOk, minBuys: buys >= minBuys },
  };
}

/**
 * Bearish catalysts that a confirmed CTO should stop being punished for.
 *
 * Only dev-exit wording is neutralised. Every other bearish signal — sell
 * pressure, price collapse, thin liquidity, danger flags — still counts, so a
 * CTO label cannot quietly erase the rest of the risk picture.
 */
const DEV_EXIT_CATALYST = /creator|deployer|dev\b|dev sold|team sold/i;

export function applyCtoOverride(catalysts, cto) {
  if (!cto?.detected) return { ...catalysts, ctoNeutralised: [] };
  const neutralised = catalysts.bearish.filter((b) => DEV_EXIT_CATALYST.test(b));
  return {
    bullish: [
      ...catalysts.bullish,
      `Community takeover: ${cto.checks.find((c) => c.label === 'Community floor')?.detail ?? 'community floor passed'}, developer exited`,
    ],
    bearish: catalysts.bearish.filter((b) => !DEV_EXIT_CATALYST.test(b)),
    ctoNeutralised: neutralised,
  };
}

/**
 * Mandatory security + insider requirements, shared by BOTH insider tiers.
 *
 * Every row must be AFFIRMATIVELY TRUE. Unknown counts as a failure here, which
 * is deliberately stricter than the contract audit — that reports unknown as
 * UNVERIFIED and leaves the token watchable. An insider tier is a promotion: it
 * puts a louder header on the alert and, for the established tier, adds score.
 * A promotion must never rest on data the provider simply never returned.
 *
 * These duplicate gates that runSecurityAudit and scoreToken already enforce.
 * That repetition is the point — the tiers are the loudest alerts Aegis sends,
 * so their preconditions are stated once more where they can be read and tested
 * on their own, rather than inferred from the interaction of three modules.
 *
 * The high-conviction insider bypass reaches THIS gate as well as the shield,
 * and it has to: classification is what awards the tier, and the notifier only
 * dispatches on a tier. Overriding the shield alone would unblock a token and
 * then drop it at `outside-insider-tiers`, i.e. a switch that does nothing. The
 * three overridable rows are the same three — contract audit (only when every
 * failing row is LP or concentration), LP burn, top-10 concentration. Insider
 * detection, the multi-wallet requirement, mint and freeze are never waived.
 */
export function evaluateInsiderRequirements({
  audit,
  security,
  clusters,
  thresholds = {},
  demand = null,
  minInsiderWallets = 1,
  insiderBypass = null,
}) {
  const rows = [];
  const add = (label, passed, detail, gate = null) =>
    rows.push({ gate, label, passed: passed === true, detail });

  // The dynamic cap, same as everywhere else. Hardcoding 20 here meant the
  // contract audit could pass a high-volume token at 30% while this gate
  // rejected it at 20% — so the widened cap silently did nothing for insider
  // tiers, which is where most alerts come from.
  const { cap: top10Cap, widened: capWidened } = concentrationCapFor(
    demand?.ageHours ?? null,
    thresholds,
    tractionFrom(security, demand)
  );
  const lpFloor = thresholds.minLpLockedPct ?? 99;
  const evm = security?.chainKind === 'evm';

  const count = clusters?.insiderCount ?? 0;
  add(
    'Insider detected',
    clusters?.detected === true,
    clusters?.detected
      ? `${clusters.label ?? 'insider activity'}${count ? ` — ${count} unique wallet(s)` : ''}`
      : 'No cluster, non-routine buy size or funder network matched'
  );

  // ---- Multi-wallet requirement ------------------------------------
  //
  // A tier can demand that the evidence be COORDINATION rather than one wallet
  // doing something unusual. Two conditions, both required:
  //
  //   1. enough distinct insider wallets, and
  //   2. STRUCTURAL evidence tying them together — co-buying inside the launch
  //      window, a shared funding origin, or same-slot execution.
  //
  // The second condition is the one that does the work. Without it, two
  // unrelated watchlisted wallets that happened to buy the same token hours
  // apart would satisfy a bare count, and that is not a cabal — it is two
  // people liking the same coin.
  //
  // Measured against 301 insider-detected notes on file: 243 of them (81%)
  // were NON-ROUTINE BUY SIZE with cluster size 0 and no funder network — one
  // wallet making one large buy. Those are exactly what this blocks.
  if (minInsiderWallets > 1) {
    const clusterSize = clusters?.clusterBuying?.size ?? 0;
    const networkSize = Math.max(0, ...(clusters?.networks ?? []).map((n) => n.size ?? 0));
    const bundleSize = clusters?.jito?.detected ? (clusters.jito.size ?? 0) : 0;

    const structural = Math.max(clusterSize, networkSize, bundleSize);
    const evidence =
      structural === bundleSize && bundleSize >= minInsiderWallets
        ? `${bundleSize} wallets in one slot`
        : structural === clusterSize && clusterSize >= minInsiderWallets
          ? `${clusterSize} wallets co-buying in the launch window`
          : structural === networkSize && networkSize >= minInsiderWallets
            ? `${networkSize} wallets sharing a funder`
            : null;

    add(
      `Multi-wallet cluster (≥${minInsiderWallets})`,
      count >= minInsiderWallets && structural >= minInsiderWallets,
      evidence
        ? `${evidence} — ${count} distinct insider wallet(s)`
        : count < minInsiderWallets
          ? `Only ${count} distinct insider wallet(s) — a single buyer is not a cluster`
          : `${count} wallets, but none co-buying within the launch window, sharing a funder, or in one slot`
    );
  }

  add(
    'Contract audit',
    audit?.status === 'PASSED',
    audit?.status === 'PASSED'
      ? 'All contract checks passed'
      : `Audit status is ${audit?.status ?? 'unknown'} — only PASSED qualifies`,
    // Overridable only when every failing row is one the bypass covers, which
    // auditFailuresAreBypassable decides below. UNVERIFIED has no failing rows
    // at all and therefore stays blocked.
    auditFailuresAreBypassable(audit) ? 'audit' : null
  );

  if (evm) {
    // EVM has no freeze authority; mintability is the equivalent supply control.
    add(
      'Mint authority revoked',
      security?.isMintable === false,
      security?.isMintable === false ? 'Supply fixed, not mintable' : 'Contract is mintable or unknown'
    );
    add('Freeze authority revoked', true, 'Not applicable on EVM — no freeze authority');
  } else {
    add(
      'Mint authority revoked',
      security?.ok === true && security.mintAuthority === null,
      security?.ok !== true
        ? 'Security report unavailable'
        : security.mintAuthority === null
          ? 'Revoked / Null'
          : `ACTIVE (${security.mintAuthority})`
    );
    add(
      'Freeze authority revoked',
      security?.ok === true && security.freezeAuthority === null,
      security?.ok !== true
        ? 'Security report unavailable'
        : security.freezeAuthority === null
          ? 'Revoked / Null'
          : `ACTIVE (${security.freezeAuthority})`
    );
  }

  const lp = security?.lpLockedPct;
  add(
    'LP burned / locked',
    lp !== null && lp !== undefined && lp >= lpFloor,
    lp === null || lp === undefined
      ? 'LP lock status not indexed — unknown does not qualify'
      : `${lp.toFixed(1)}% burned / locked (required ≥ ${lpFloor}%)`,
    'lp'
  );

  const top10 = security?.top10Pct;
  add(
    'Top 10 concentration',
    top10 !== null && top10 !== undefined && top10 < top10Cap,
    top10 === null || top10 === undefined
      ? 'Holder distribution not indexed — unknown does not qualify'
      : `Top 10 hold ${top10.toFixed(1)}% (limit ${top10Cap}%${capWidened ? ', widened for proven traction' : ''})`,
    'concentration'
  );

  // Same shape as the shield: measured first, overridden second, and the row
  // keeps its real detail so the alert never claims a gate passed when it did
  // not. `audit` joins lp/concentration here because a tier cannot be awarded
  // while the aggregate audit status is still FAILED.
  const bypass = insiderBypass?.allowed === true ? insiderBypass : null;
  const bypassedGates = [];
  if (bypass) {
    for (const r of rows) {
      if (r.passed || !(r.gate === 'audit' || BYPASSABLE_SHIELD_GATES.has(r.gate))) continue;
      r.passed = true;
      r.bypassed = true;
      // The marker lives in the detail rather than only on the flag, so a row
      // read on its own — a log line, a failures array — still says it did not
      // pass. The renderer prints the detail verbatim and adds no second tag.
      r.detail = `${r.detail} — [BYPASSED] did not pass, overridden by insider score ${bypass.score} ≥ floor ${bypass.floor}`;
      bypassedGates.push(r.label);
    }
  }

  const failures = rows.filter((r) => !r.passed).map((r) => `${r.label}: ${r.detail}`);
  return {
    passed: failures.length === 0,
    checks: rows,
    failures,
    insiderBypassApplied: bypassedGates.length > 0,
    bypassedGates,
  };
}

/**
 * Sort a qualifying token into a holding style.
 *
 * Precedence, highest first:
 *   1. COMMUNITY TAKEOVER GEM     all four CTO criteria met
 *   2. ESTABLISHED INSIDER GEM   insider + $1M-$10M+ + deep liquidity + 1k holders
 *   3. EARLY-STAGE INSIDER SCALP  insider + $30k-$500k
 *   4. ESTABLISHED GEM            mature and deep, no insider requirement
 *   5. FAST MOMENTUM SCALP        young and mid-cap
 *
 * CTO leads because it is the most specific and the rarest of the patterns, and
 * because it changes the risk profile rather than just the size band: there is
 * no developer left to build OR to rug. A CTO that ALSO carries insider buying
 * keeps its CTO label — the insider roster still renders inside the alert, so
 * nothing is hidden by the ordering, and unlike the insider tiers CTO does not
 * require cluster activity at all.
 *
 * The insider tiers are tested FIRST and legitimately overlap the plain ones: a
 * mature $400k token with cluster activity becomes an EARLY-STAGE INSIDER SCALP
 * rather than a GEM, because the insider entry is the more decision-relevant
 * fact and the tighter stop-loss is the safer advice of the two.
 *
 * Both insider tiers require `evaluateInsiderRequirements` to pass in full.
 * Without a `clusters` argument the insider tiers cannot fire at all, so older
 * callers keep exactly their previous two-tier behaviour.
 *
 * The plain tiers stay asymmetric about missing data. GEM advice says hold for
 * days or weeks, so every one of its conditions must be positively proven — an
 * unknown age or unknown holder count disqualifies. SCALP advice says take
 * profit quickly, which stays sound even if the token turns out older than
 * assumed, so it tolerates an unproven age.
 */
export function classifySignal({ demand, security, config, clusters = null, audit = null, cto = null, insiderBypass = null }) {
  const g = config.signalCategories?.gem ?? {};
  const s = config.signalCategories?.scalp ?? {};
  const holders = security?.ok ? security.totalHolders : null;

  const mcap = demand.marketCap ?? 0;
  const liq = demand.liquidityUsd ?? 0;
  const age = demand.ageHours;

  if (cto?.detected) {
    const c = config.signalCategories?.communityTakeover ?? {};
    return {
      category: SIGNAL_CATEGORY.CTO,
      label: c.label ?? 'COMMUNITY TAKEOVER GEM',
      advice:
        c.advice ??
        'Community takeover — the developer has exited and the crowd is driving. No dev to rug, and no dev to build.',
      alertHeader: c.alertHeader ?? 'COMMUNITY TAKEOVER (CTO) ALERT ',
      scoreBoost: cto.scoreBoost ?? c.scoreBoost ?? 20,
      cto: true,
      insiderCount: clusters?.insiderCount ?? 0,
      checks: Object.fromEntries(cto.checks.map((r) => [r.label, r.passed])),
      ctoChecks: cto.checks,
    };
  }

  const insiderTier = classifyInsiderTier({
    demand,
    security,
    config,
    clusters,
    audit,
    holders,
    insiderBypass,
  });
  if (insiderTier) return insiderTier;

  const gemChecks = {
    marketCap: mcap >= (g.minMarketCapUsd ?? 1_000_000),
    liquidity: liq >= (g.minLiquidityUsd ?? 100_000),
    // Requires a confirmed age: a lower-bound estimate cannot establish maturity.
    age: age !== null && age >= (g.minAgeHours ?? 24) && demand.ageIsLowerBound === false,
    // Holder count must be KNOWN even when the minimum is 0. Advice to hold for
    // weeks should not rest on missing distribution data; the global 150-holder
    // safety floor still applies separately.
    holders: holders !== null && holders !== undefined && holders >= (g.minHolders ?? 0),
  };
  // GEM is tested first, so an overlapping token (>=$300k, mature) is treated as
  // an accumulation setup rather than a scalp. Maturity decides holding style.
  if (Object.values(gemChecks).every(Boolean)) {
    return {
      category: SIGNAL_CATEGORY.GEM,
      label: g.label ?? 'LONG-TERM INVESTMENT GEM',
      advice: g.advice ?? 'Long-term accumulation setup — suitable for holding over days/weeks.',
      scoreBoost: g.scoreBoost ?? 10,
      checks: gemChecks,
    };
  }

  const inScalpBand =
    mcap >= (s.minMarketCapUsd ?? 15_000) && mcap <= (s.maxMarketCapUsd ?? 300_000);
  const youngEnough = age === null || age < (s.maxAgeHours ?? 24);
  if (inScalpBand && youngEnough) {
    return {
      category: SIGNAL_CATEGORY.SCALP,
      label: s.label ?? 'FAST MOMENTUM SCALP',
      advice: s.advice ?? 'Fast momentum trade — take initial profit at +50% to +100%!',
      scoreBoost: 0,
      checks: { marketCap: inScalpBand, age: youngEnough },
    };
  }

  return {
    category: SIGNAL_CATEGORY.NONE,
    label: 'UNCLASSIFIED',
    advice: null,
    scoreBoost: 0,
    checks: gemChecks,
    reason: `MC $${Math.round(mcap).toLocaleString('en-US')} / age ${age === null ? 'unknown' : `${age.toFixed(1)}h`} fits neither tier`,
  };
}

/**
 * Insider tier selection. Returns null when neither tier applies, so the caller
 * falls through to the plain GEM / SCALP bands.
 *
 * Band membership is checked BEFORE the shared requirement gate so that a token
 * outside both market-cap windows costs nothing to reject, and so the recorded
 * `reason` distinguishes "wrong size" from "failed a security requirement" —
 * two very different things when you are reading back why an alert never fired.
 *
 * ESTABLISHED is tested first: the bands cannot overlap at their configured
 * values ($500k ceiling vs $1M floor), but ordering them explicitly means a
 * future widening of the early band cannot silently demote a deep-liquidity,
 * thousand-holder token into the tight-stop scalp tier.
 */
function classifyInsiderTier({ demand, security, config, clusters, audit, holders, insiderBypass = null }) {
  if (!clusters?.detected) return null;

  const cats = config.signalCategories ?? {};
  const shared = cats.insiderTiers ?? {};
  const mcap = demand.marketCap ?? 0;
  const liq = demand.liquidityUsd ?? 0;

  const inBand = (cfg, floor, ceiling) => {
    const min = cfg.minMarketCapUsd ?? floor;
    // null / absent ceiling means open-ended, which is what "$10M+" asks for.
    const max = cfg.maxMarketCapUsd ?? ceiling;
    return mcap >= min && (max === null || mcap <= max);
  };

  const est = cats.insiderEstablished ?? {};
  const early = cats.insiderEarly ?? {};

  // The per-tier holder floor is a holder floor, so the bypass covers it too.
  // Leaving it out would make the override self-cancelling: scoreToken would
  // clear the global floor, classification would then refuse the tier, and the
  // notifier would drop the token at `outside-insider-tiers` having bypassed a
  // gate for nothing. Note this is the one bypassed check that can also change
  // WHICH tier is awarded, not just whether one is.
  const holdersBypassed = insiderBypass?.allowed === true;
  const holderFloorMet = (required) =>
    holdersBypassed ||
    (holders !== null && holders !== undefined && holders >= required);

  const estChecks = {
    marketCap: inBand(est, 1_000_000, null),
    liquidity: liq >= (est.minLiquidityUsd ?? 100_000),
    // Holder count must be KNOWN, not merely "not below the floor". Missing
    // distribution data cannot be read as a thousand holders.
    holders: holderFloorMet(est.minHolders ?? 1_000),
  };
  // Holder count must be KNOWN and at or above the tier's own floor. Same
  // asymmetry as the established tier: missing distribution data is not a
  // holder base, and this tier's floor is what later relaxes the global gate,
  // so it cannot rest on an unread number.
  const earlyChecks = {
    marketCap: inBand(early, 30_000, 500_000),
    holders: early.minHolders === undefined || holderFloorMet(early.minHolders),
  };

  const tier = Object.values(estChecks).every(Boolean)
    ? {
        cfg: est,
        category: SIGNAL_CATEGORY.INSIDER_ESTABLISHED,
        checks: estChecks,
        label: est.label ?? 'ESTABLISHED INSIDER GEM',
        advice:
          est.advice ??
          'Established insider accumulation — high 90%+ survival rate & deep liquidity.',
        alertHeader: est.alertHeader ?? 'ESTABLISHED INSIDER GEM ALERT ($1M–$10M MC) ',
        scoreBoost: est.scoreBoost ?? 10,
      }
    : Object.values(earlyChecks).every(Boolean)
      ? {
          cfg: early,
          category: SIGNAL_CATEGORY.INSIDER_EARLY,
          checks: earlyChecks,
          label: early.label ?? 'EARLY-STAGE INSIDER SCALP',
          advice:
            early.advice ??
            'Early insider entry — massive upside potential. Enforce tight -15% stop-loss!',
          alertHeader: early.alertHeader ?? 'EARLY INSIDER SCALP ALERT ($30k–$500k MC) ',
          scoreBoost: early.scoreBoost ?? 0,
        }
      : null;

  if (!tier) return null;

  const requirements = evaluateInsiderRequirements({
    audit,
    security,
    clusters,
    thresholds: { ...(config.thresholds ?? {}), ...shared },
    demand,
    // Per-tier. The early band demands coordination because it is the noisiest
    // and least-verified end of the market; the established band does not, as
    // its own floors (>=$1M cap, >=$100k liquidity, >=1000 holders) already
    // exclude the launch-sniping noise this is aimed at.
    minInsiderWallets: tier.cfg.minInsiderWallets ?? shared.minInsiderWallets ?? 1,
    insiderBypass,
  });
  if (!requirements.passed) {
    // Deliberately NOT a downgrade to the plain tiers. A token that matched an
    // insider band but failed a mandatory requirement is exactly the case the
    // gate exists for; letting it re-enter as a plain GEM would hand it back
    // the alert it was just denied.
    return {
      category: SIGNAL_CATEGORY.NONE,
      label: 'UNCLASSIFIED',
      advice: null,
      scoreBoost: 0,
      checks: tier.checks,
      insiderRequirements: requirements,
      reason: `Insider band matched but requirements failed — ${requirements.failures[0]}`,
    };
  }

  return {
    category: tier.category,
    label: tier.label,
    advice: tier.advice,
    alertHeader: tier.alertHeader,
    scoreBoost: tier.scoreBoost,
    insider: true,
    insiderCount: clusters.insiderCount ?? 0,
    checks: tier.checks,
    insiderRequirements: requirements,
  };
}

/* ------------------------------------------------------------------ *
 * 3. Catalyst detection (from observable on-chain + listing signals)
 * ------------------------------------------------------------------ */

export function detectCatalysts(pair, security, demand, velocity, thresholds, extras = {}) {
  const bullish = [];
  const bearish = [];

  const { smartMoney, deployer, social, blacklistHit } = extras;

  if (blacklistHit?.listed) {
    bearish.push(
      `Blacklisted ${blacklistHit.kind}: ${blacklistHit.entry?.reason ?? 'permanently blocked'}`
    );
  }
  if (social?.noSocials) {
    bearish.push('No socials declared — high abandonment risk');
  } else if (social?.hasTwitter && social?.hasTelegram) {
    bullish.push(`Social presence: X + Telegram${social.hasWebsite ? ' + website' : ''}`);
  }

  if (smartMoney?.detected) {
    bullish.push(
      `Smart money accumulation: ${smartMoney.count} tracked wallet(s) holding ${smartMoney.totalPct.toFixed(1)}%${smartMoney.provablyEarly ? ' within the early-entry window' : ''}`
    );
  }
  if (deployer?.status === 'GOOD DEV') {
    bullish.push(
      `Proven deployer: ${deployer.successfulLaunches} past launch(es) above $100k market cap`
    );
  }
  if (deployer?.status === 'SERIAL RUGGER') {
    bearish.push(`Serial rugger deployer: ${deployer.reasons[0]}`);
  }

  if (demand.m5.ratio >= thresholds.buySignalDemandRatio && demand.m5.buys >= 10) {
    bullish.push(
      `Organic buyer surge: ${demand.m5.buys} buys vs ${demand.m5.sells} sells in 5m (${demand.m5.ratio.toFixed(1)}x)`
    );
  }
  if (demand.h1.ratio >= 1.5 && demand.h1.buys >= 30) {
    bullish.push(
      `Sustained 1h demand: ${demand.h1.buys} buys vs ${demand.h1.sells} sells (${demand.h1.ratio.toFixed(1)}x)`
    );
  }
  if (velocity?.newHolders > 0) {
    bullish.push(
      `Holder growth: +${velocity.newHolders} wallets in ${velocity.minutes} min`
    );
  }
  const socials = pair?.info?.socials ?? [];
  if (socials.length) {
    bullish.push(
      `Social presence live: ${socials.map((s) => s.type).join(', ')}${(pair?.info?.websites ?? []).length ? ' + website' : ''}`
    );
  }
  if (demand.volume.h1 > 0 && demand.marketCap > 0 && demand.volume.h1 / demand.marketCap > 0.5) {
    bullish.push(
      `Volume/MCap turnover ${(100 * demand.volume.h1 / demand.marketCap).toFixed(0)}% in 1h — high rotation`
    );
  }

  if (demand.m5.sells > demand.m5.buys * thresholds.crashSellRatio && demand.m5.sells >= 10) {
    bearish.push(
      `Seller exhaust: ${demand.m5.sells} sells vs ${demand.m5.buys} buys in 5m (>${thresholds.crashSellRatio}x)`
    );
  }
  if (demand.h1.sells > demand.h1.buys * thresholds.crashSellRatio && demand.h1.sells >= 25) {
    bearish.push(`1h sell pressure: ${demand.h1.sells} sells vs ${demand.h1.buys} buys`);
  }
  if (demand.priceChange.h1 < -30) {
    bearish.push(`Price down ${demand.priceChange.h1.toFixed(1)}% in 1h — active distribution`);
  }
  if (demand.liqToMcapPct < thresholds.minLiqToMcapPct) {
    bearish.push(
      `Thin liquidity: pool is ${demand.liqToMcapPct.toFixed(1)}% of MCap (need >${thresholds.minLiqToMcapPct}%) — heavy slippage on exit`
    );
  }
  if (velocity?.newHolders < 0) {
    bearish.push(`Holder count falling: ${velocity.newHolders} wallets in ${velocity.minutes} min`);
  }
  if (security?.ok && security.chainKind === 'solana') {
    for (const risk of security.risks ?? []) {
      if (risk.level === 'warn' || risk.level === 'danger') {
        bearish.push(`RugCheck flag (${risk.level}): ${risk.name}`);
      }
    }
  }

  return { bullish, bearish };
}

/* ------------------------------------------------------------------ *
 * 4. Composite confidence score + verdict
 * ------------------------------------------------------------------ */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function scoreToken({
  audit,
  security,
  demand,
  velocity,
  catalysts,
  thresholds,
  smartMoney,
  deployer,
  smartMoneyConfig,
  social,
  blacklistHit,
  signalCategory,
  clusters,
  megaRunner,
  socialHype,
  config,
  insiderBypass = null,
  jitoTip = null,
  momentum = null,
}) {
  // Demand — 30 pts
  const demandScore =
    clamp((demand.m5.ratio === Infinity ? 4 : demand.m5.ratio) / 3, 0, 1) * 18 +
    clamp((demand.h1.ratio === Infinity ? 4 : demand.h1.ratio) / 2.5, 0, 1) * 12;

  // Liquidity depth — 20 pts, saturating at 2x the minimum requirement
  const depthScore = clamp(demand.liqToMcapPct / (thresholds.minLiqToMcapPct * 2), 0, 1) * 20;

  // Holder distribution — 20 pts. Unknown concentration scores zero, never full
  // marks: an empty holder array is missing data, not clean distribution.
  const top10 = security?.ok ? security.top10Pct : null;
  const distScore =
    top10 === null
      ? 0
      : clamp((thresholds.maxTop10Pct - top10) / thresholds.maxTop10Pct, 0, 1) * 20;

  // Momentum — 15 pts from turnover, penalised for a collapsing 1h candle
  const turnover = demand.marketCap > 0 ? demand.volume.h1 / demand.marketCap : 0;
  const momentumScore =
    clamp(turnover / 0.6, 0, 1) * 15 * (demand.priceChange.h1 < -25 ? 0.3 : 1);

  // Traction — 15 pts from holder base, growth velocity and verified socials
  const holders = security?.totalHolders ?? 0;
  const tractionScore =
    clamp(holders / 500, 0, 1) * 7 +
    clamp((velocity?.newHolders ?? 0) / 100, 0, 1) * 5 +
    (catalysts.bullish.some((c) => c.startsWith('Social presence')) ? 3 : 0);

  // --- Security-first gate ----------------------------------------
  // Evaluated BEFORE any bonus is applied, because the whole point is that a
  // whale buying a token cannot launder it. A malicious dev can trivially buy
  // their own scam from a wallet on someone's alpha list; if smart money could
  // lift the score, that would be a way to walk a rug straight past the audit.
  const securityFailed = audit.status === 'FAILED';

  // Tier-aware, defaulting to thresholds.minUniqueHolders. `config` is only
  // supplied by scan.mjs; every other caller (and every existing test) passes
  // thresholds alone and keeps the global floor unchanged.
  const effectiveHolderFloor = resolveHolderFloor({ signalCategory, config, thresholds });

  const holderFloorFailed =
    security?.ok &&
    security.totalHolders !== null &&
    security.totalHolders !== undefined &&
    security.totalHolders < effectiveHolderFloor;
  const depthFloorPct = thresholds.minLiqToMcapPct ?? 15;

  // Absolute-depth alternative to the ratio floor, for the established insider
  // tier only.
  //
  // The 15%-of-market-cap floor is the right test for a small token, where a
  // thin pool means you cannot get out. It is the WRONG test at the top of the
  // range: real $1M-$10M tokens routinely sit at 5-12%, so the ratio floor
  // rejected the entire established band — a $3.4M token with a $410k pool
  // scored 0 and never alerted. A tier that cannot fire is not a safety
  // feature, it is a dead one.
  //
  // Stated plainly, because it IS a loosening: a $100k pool absorbs a retail
  // exit at single-digit slippage, but it does not make a $10M token as
  // exitable as 15% would. Size your exit to the pool, not the market cap.
  // Scoped to INSIDER_ESTABLISHED deliberately — every other token, including
  // the early insider tier, still faces the full ratio floor.
  //
  // COMMUNITY TAKEOVER shares this path for the same structural reason: a CTO
  // is by definition a token whose market cap ran away from its original pool
  // ($RAVECAT: 2.9% ratio on a real $218k pool). The absolute floor is the SAME
  // $100k, deliberately NOT the $30k CTO liquidity criterion — meeting the
  // criteria makes a token a CTO, it does not make a $30k pool exitable.
  const absoluteDepthFloor = thresholds.minAbsoluteLiquidityUsd ?? 100_000;
  const depthWaiverCategories = new Set([
    SIGNAL_CATEGORY.INSIDER_ESTABLISHED,
    SIGNAL_CATEGORY.CTO,
  ]);
  const deepPoolWaiver =
    depthWaiverCategories.has(signalCategory?.category) &&
    (demand.liquidityUsd ?? 0) >= absoluteDepthFloor;

  const liquidityGateFailed =
    !deepPoolWaiver &&
    demand.liqToMcapPct !== null &&
    demand.liqToMcapPct !== undefined &&
    demand.marketCap > 0 &&
    demand.liqToMcapPct < depthFloorPct;

  // --- High-conviction insider bypass ------------------------------
  //
  // Config-gated override of exactly three gates. See resolveInsiderBypass for
  // what it costs and what it deliberately cannot reach.
  //
  // `securityBypassed` requires auditFailuresAreBypassable, so a token that
  // failed LP burn AND mint authority is not bypassed at all — one bypassable
  // failure never carries a non-bypassable one through with it. Liquidity depth
  // and the blacklist stay outside the override entirely and keep their place
  // in this expression.
  const bypass = insiderBypass?.allowed === true ? insiderBypass : null;
  const securityBypassed = Boolean(bypass) && securityFailed && auditFailuresAreBypassable(audit);
  const holderBypassed = Boolean(bypass) && holderFloorFailed;
  const bypassedGates = [
    ...(securityBypassed
      ? (audit.checks ?? []).filter((c) => c.passed === false).map((c) => c.label)
      : []),
    ...(holderBypassed ? ['Minimum unique holders'] : []),
  ];
  const bypassApplied = bypassedGates.length > 0;

  const safetyGateFailed =
    (securityFailed && !securityBypassed) ||
    (holderFloorFailed && !holderBypassed) ||
    liquidityGateFailed ||
    Boolean(blacklistHit?.listed);

  // Smart money — additive bonus, and explicitly forfeited when safety fails.
  const smartBonus =
    smartMoney?.detected && !safetyGateFailed ? (smartMoneyConfig?.scoreBonus ?? 15) : 0;

  // Social presence — declared links only (see social_scanner.mjs on what this
  // can and cannot tell you). Forfeited on a safety failure for the same reason.
  const socialBonus = safetyGateFailed ? 0 : (social?.scoreBonus ?? 0);

  // Category boost — rewards the deep-liquidity, multi-day tier. Forfeited on a
  // safety failure like every other bonus.
  const categoryBonus = safetyGateFailed ? 0 : (signalCategory?.scoreBoost ?? 0);

  // Insider-cluster multiplier. Requires the audit to have AFFIRMATIVELY
  // PASSED — not merely "not failed".
  //
  // UNVERIFIED means the gates could not be checked (provider had no data), and
  // "could not verify" is not "passed". Gating this on `safetyGateFailed` alone
  // let a 4-wallet swarm add +50 to a token whose contract was never verified.
  // The score cap on UNVERIFIED hid the effect, which is exactly why it needed
  // fixing: a later change to that cap would have silently reopened it.
  //
  // A bypassed audit counts as passed HERE, and that is a real widening rather
  // than an oversight. Without it the bypass would be decorative: a token whose
  // concentration gate was overridden loses most of its distribution score, and
  // stripping the cluster, mega-runner and hype bonuses on top leaves it far
  // under telegram.insiderMinScore, so the alert it was unblocked for would
  // never be sent. The bypass either lets the token score or it does nothing.
  const gatesFullyPassed = (audit.status === 'PASSED' || securityBypassed) && !safetyGateFailed;
  const clusterBonus = gatesFullyPassed ? (clusters?.scoreBonus ?? 0) : 0;

  // Mega-runner viral volume. Held to the SAME standard as the cluster bonus —
  // an affirmatively PASSED audit, not merely "not failed" — because it is the
  // easiest bonus in the engine to manufacture. Wash trading produces this
  // signature on purpose; without the gate it would be a way to buy 25 points
  // on a token whose contract was never verified.
  const megaRunnerBonus = gatesFullyPassed ? (megaRunner?.scoreBoost ?? 0) : 0;

  // Social hype. Same bar again: viral attention is the easiest thing in this
  // engine to buy, and a trending ticker on an unaudited contract is the exact
  // shape of a pump. Requires an affirmatively PASSED audit.
  //
  // Named socialHypeBonus, NOT socialBonus — `socialBonus` above is the
  // declared-links bonus from social_scanner.mjs and reusing the name is a
  // redeclaration, not a shadow.
  const socialHypeBonus = gatesFullyPassed ? (socialHype?.scoreBoost ?? 0) : 0;

  // Jito Cabal Conviction. Awarded when the launch-window bundles paid more than
  // jitoTips.minTipSolForBonus in validator tips.
  //
  // Held to the SAME affirmative-PASS bar as the cluster, mega-runner and hype
  // bonuses, and it is the one that needs the bar most: a tip is not merely
  // manufacturable, it is a PAYMENT. Anyone with the SOL can buy this signal
  // outright, to a public address, in one transaction. A developer rugging
  // their own launch has the same reason to tip as a cabal does — they want
  // their buys sequenced first, and the tip is a rounding error against what
  // they plan to extract. Without this gate, "well-funded operation" would read
  // as "good token", which is precisely backwards on an unaudited contract.
  const jitoTipBonus = gatesFullyPassed ? (jitoTip?.scoreBoost ?? 0) : 0;

  // Viral momentum — 5-minute holder velocity or volume surge.
  //
  // Same affirmative-PASS bar, and it needs it: both inputs are the two metrics
  // config.json's dynamicConcentration note names as "precisely what someone
  // gaming a scanner would fake, because they are what scanners look at" —
  // holders by dusting, 5-minute volume by wash trading. Rapid growth on a clean
  // contract is a crowd arriving; the identical numbers on an unaudited one are
  // the shape of a token being pumped into an exit.
  const momentumBonus = gatesFullyPassed ? (momentum?.scoreBoost ?? 0) : 0;

  let score = Math.round(
    demandScore +
      depthScore +
      distScore +
      momentumScore +
      tractionScore +
      smartBonus +
      socialBonus +
      categoryBonus +
      clusterBonus +
      megaRunnerBonus +
      socialHypeBonus +
      jitoTipBonus +
      momentumBonus
  );
  score -= catalysts.bearish.length * 4;
  score = clamp(score, 0, 100);

  // --- Dual safety gate -------------------------------------------
  // Holder count is a separate axis from concentration: 10 wallets can hold a
  // clean 8% each and still leave the token trivially exit-trapped because
  // there is nobody to sell to. Both must pass.
  const holderFloor = effectiveHolderFloor;
  const uniqueHolders = security?.ok ? security.totalHolders : null;
  const holdersKnown = uniqueHolders !== null && uniqueHolders !== undefined;
  const lowHolders = holdersKnown && uniqueHolders < holderFloor;

  // Liquidity depth as a hard gate, not just a scoring input.
  //
  // A pool worth under 15% of market cap cannot absorb an exit: the price you
  // see is not the price you get, and on a thin book a modest sell walks the
  // pool down before it fills. Being right about the token does not help if
  // leaving the position costs more than the move earned.
  const depthFloor = thresholds.minLiqToMcapPct ?? 15;
  const depthKnown = demand.liqToMcapPct !== null && demand.liqToMcapPct !== undefined;
  const thinLiquidity =
    !deepPoolWaiver && depthKnown && demand.marketCap > 0 && demand.liqToMcapPct < depthFloor;

  // --- Verdict -----------------------------------------------------
  let verdict;
  let impact;

  const serialRugger = deployer?.status === 'SERIAL RUGGER';

  const crashing =
    (demand.m5.sells > demand.m5.buys * thresholds.crashSellRatio && demand.m5.sells >= 10) ||
    (demand.h1.sells > demand.h1.buys * thresholds.crashSellRatio && demand.h1.sells >= 25) ||
    demand.priceChange.h1 < -35 ||
    (security?.ok && security.rugged);

  if (blacklistHit?.listed) {
    // Permanent blacklist outranks everything, including a clean live snapshot.
    verdict = 'SCAM/AVOID';
    impact = 'NEUTRAL';
    score = 0;
  } else if (serialRugger) {
    // Deployer reputation overrides a clean contract. A serial rugger's next
    // token always has revoked authorities and a burned LP — that is exactly
    // what makes the contract-level audit insufficient on its own.
    verdict = 'SCAM/AVOID';
    impact = 'NEUTRAL';
    score = 0;
  } else if (audit.status === 'FAILED' && !securityBypassed) {
    // Score 0, not a cap: a failed contract audit is disqualifying outright.
    verdict = 'SCAM/AVOID';
    impact = 'NEUTRAL';
    score = 0;
  } else if (thinLiquidity) {
    // Ranked above the contract audit for the same reason as the holder floor:
    // a token you cannot exit is untradeable regardless of how clean its
    // contract is.
    verdict = 'THIN LIQUIDITY';
    impact = 'NEUTRAL';
    score = 0;
  } else if (lowHolders && !holderBypassed) {
    // Score 0 and alerts blocked, same as a security failure — but kept under a
    // DISTINCT verdict label. A 140-holder token is early and illiquid, which is
    // not the same claim as "this is a scam". Merging them would put every fresh
    // legitimate launch into the scam-flag tag and make that tag useless for the
    // thing it exists to catch. Set thresholds.treatLowHoldersAsScam to merge.
    const asScam = thresholds.treatLowHoldersAsScam === true;
    verdict = asScam ? 'SCAM/AVOID' : 'UNVERIFIED / LOW HOLDERS';
    impact = 'NEUTRAL';
    score = 0;
  } else if (audit.status === 'UNVERIFIED') {
    // Not provably malicious, but not clearable either — never promote to a
    // BUY SIGNAL on a contract whose safety checks could not be completed.
    verdict = crashing ? 'CRASH WARNING' : 'WATCH';
    impact = crashing ? 'CRASH WARNING' : 'NEUTRAL';
    score = Math.min(score, 40);
  } else if (crashing) {
    verdict = 'CRASH WARNING';
    impact = 'CRASH WARNING';
    score = Math.min(score, 45);
  } else if (
    score >= thresholds.buySignalScore &&
    demand.m5.ratio >= thresholds.buySignalDemandRatio &&
    demand.liqToMcapPct >= thresholds.minLiqToMcapPct
  ) {
    verdict = 'BUY SIGNAL';
    impact = 'SKYROCKET';
  } else {
    verdict = 'WATCH';
    impact = 'NEUTRAL';
  }

  return {
    score,
    verdict,
    impact,
    serialRugger,
    blacklisted: Boolean(blacklistHit?.listed),
    // Consumed by the notifier: a true value blocks every alert, including
    // smart-money ones, regardless of what the score ended up as.
    safetyGateFailed,
    safetyGateReason: blacklistHit?.listed
      ? 'Blacklisted deployer or mint'
      : securityFailed && !securityBypassed
        ? audit.failures?.[0] ?? 'Contract audit failed'
        : holderFloorFailed && !holderBypassed
          ? `Only ${security?.totalHolders} holders — below the ${effectiveHolderFloor} floor`
          : liquidityGateFailed
            ? `Liquidity is ${demand.liqToMcapPct.toFixed(1)}% of market cap — below the ${depthFloorPct}% slippage floor`
            : null,
    // Null unless a gate genuinely failed AND was overridden, so the notifier
    // and the note can state the override rather than reporting a clean pass.
    insiderBypass: bypassApplied
      ? {
          applied: true,
          floor: bypass.floor,
          score: bypass.score,
          wallet: bypass.wallet,
          label: bypass.label,
          gates: bypassedGates,
        }
      : null,
    smartMoneyForfeited: Boolean(smartMoney?.detected && safetyGateFailed),
    liquidityGate: {
      floorPct: depthFloorPct,
      actualPct: demand.liqToMcapPct ?? null,
      passed: liquidityGateFailed ? false : true,
      waivedByDepth: deepPoolWaiver,
      status:
        demand.liqToMcapPct === null || demand.liqToMcapPct === undefined
          ? 'Liquidity depth unknown'
          : deepPoolWaiver
            ? `$${Math.round(demand.liquidityUsd).toLocaleString('en-US')} pool (${demand.liqToMcapPct.toFixed(1)}% of MCap) — absolute depth floor passed `
            : liquidityGateFailed
              ? `${demand.liqToMcapPct.toFixed(1)}% of MCap — below ${depthFloorPct}% floor `
              : `${demand.liqToMcapPct.toFixed(1)}% of MCap — ${depthFloorPct}%+ floor passed `,
    },
    holderGate: {
      floor: holderFloor,
      holders: holdersKnown ? uniqueHolders : null,
      passed: holdersKnown ? !lowHolders : null,
      status: !holdersKnown
        ? 'Holder count unknown '
        : lowHolders
          ? `Only ${uniqueHolders} holders — below ${holderFloor} floor `
          : `${uniqueHolders} holders — ${holderFloor}+ floor passed `,
    },
    breakdown: {
      demand: Math.round(demandScore),
      liquidityDepth: Math.round(depthScore),
      distribution: Math.round(distScore),
      momentum: Math.round(momentumScore),
      traction: Math.round(tractionScore),
      smartMoney: smartBonus,
      social: socialBonus,
      category: categoryBonus,
      insiderCluster: clusterBonus,
      megaRunner: megaRunnerBonus,
      socialHype: socialHypeBonus,
      jitoTip: jitoTipBonus,
      momentum: momentumBonus,
      bearishPenalty: catalysts.bearish.length * 4,
    },
  };
}
