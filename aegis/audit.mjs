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
export function concentrationCapFor(ageHours, thresholds) {
  const strict = thresholds.maxTop10PctYoung ?? 20;
  const standard = thresholds.maxTop10Pct ?? 25;
  const youngHours = thresholds.youngTokenHours ?? 2;

  if (ageHours === null || ageHours === undefined) {
    return { cap: strict, tier: 'young (age unknown — strict cap applied)' };
  }
  return ageHours < youngHours
    ? { cap: strict, tier: `young (<${youngHours}h)` }
    : { cap: standard, tier: `established (≥${youngHours}h)` };
}

export function runSecurityAudit(security, thresholds, { ageHours = null } = {}) {
  const checks = [];
  const add = (label, passed, detail) => checks.push({ label, passed, detail });
  const { cap: top10Cap, tier: ageTier } = concentrationCapFor(ageHours, thresholds);

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
  if (deployer?.status !== 'SERIAL RUGGER 🔴') return audit;

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
    ageHours: pair?.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3.6e6 : null,
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
  if (deployer?.status === 'GOOD DEV ✅') {
    bullish.push(
      `Proven deployer: ${deployer.successfulLaunches} past launch(es) above $100k market cap`
    );
  }
  if (deployer?.status === 'SERIAL RUGGER 🔴') {
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
  const holderFloorFailed =
    security?.ok &&
    security.totalHolders !== null &&
    security.totalHolders !== undefined &&
    security.totalHolders < (thresholds.minUniqueHolders ?? 150);
  const safetyGateFailed = securityFailed || holderFloorFailed || Boolean(blacklistHit?.listed);

  // Smart money — additive bonus, and explicitly forfeited when safety fails.
  const smartBonus =
    smartMoney?.detected && !safetyGateFailed ? (smartMoneyConfig?.scoreBonus ?? 15) : 0;

  // Social presence — declared links only (see social_scanner.mjs on what this
  // can and cannot tell you). Forfeited on a safety failure for the same reason.
  const socialBonus = safetyGateFailed ? 0 : (social?.scoreBonus ?? 0);

  let score = Math.round(
    demandScore + depthScore + distScore + momentumScore + tractionScore + smartBonus + socialBonus
  );
  score -= catalysts.bearish.length * 4;
  score = clamp(score, 0, 100);

  // --- Dual safety gate -------------------------------------------
  // Holder count is a separate axis from concentration: 10 wallets can hold a
  // clean 8% each and still leave the token trivially exit-trapped because
  // there is nobody to sell to. Both must pass.
  const holderFloor = thresholds.minUniqueHolders ?? 150;
  const uniqueHolders = security?.ok ? security.totalHolders : null;
  const holdersKnown = uniqueHolders !== null && uniqueHolders !== undefined;
  const lowHolders = holdersKnown && uniqueHolders < holderFloor;

  // --- Verdict -----------------------------------------------------
  let verdict;
  let impact;

  const serialRugger = deployer?.status === 'SERIAL RUGGER 🔴';

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
  } else if (audit.status === 'FAILED') {
    // Score 0, not a cap: a failed contract audit is disqualifying outright.
    verdict = 'SCAM/AVOID';
    impact = 'NEUTRAL';
    score = 0;
  } else if (lowHolders) {
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
      : securityFailed
        ? audit.failures?.[0] ?? 'Contract audit failed'
        : holderFloorFailed
          ? `Only ${security?.totalHolders} holders — below the ${thresholds.minUniqueHolders ?? 150} floor`
          : null,
    smartMoneyForfeited: Boolean(smartMoney?.detected && safetyGateFailed),
    holderGate: {
      floor: holderFloor,
      holders: holdersKnown ? uniqueHolders : null,
      passed: holdersKnown ? !lowHolders : null,
      status: !holdersKnown
        ? 'Holder count unknown ⚠️'
        : lowHolders
          ? `Only ${uniqueHolders} holders — below ${holderFloor} floor ❌`
          : `${uniqueHolders} holders — ${holderFloor}+ floor passed ✅`,
    },
    breakdown: {
      demand: Math.round(demandScore),
      liquidityDepth: Math.round(depthScore),
      distribution: Math.round(distScore),
      momentum: Math.round(momentumScore),
      traction: Math.round(tractionScore),
      smartMoney: smartBonus,
      social: socialBonus,
      bearishPenalty: catalysts.bearish.length * 4,
    },
  };
}
