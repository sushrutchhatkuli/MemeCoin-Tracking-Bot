/**
 * Obsidian note renderer — emits the Aegis intelligence report format with
 * Dataview-queryable YAML frontmatter.
 */

import { describeInsiderAccumulation as describeInsider } from './smart_money.mjs';

const CHAIN_LABELS = {
  solana: 'Solana',
  base: 'Base',
  ethereum: 'Ethereum',
  bsc: 'BNB',
  arbitrum: 'Arbitrum',
  polygon: 'Polygon',
};

const usd = (n) =>
  n === null || n === undefined || Number.isNaN(n)
    ? 'Unknown'
    : `$${Math.round(n).toLocaleString('en-US')}`;

const pctStr = (n, digits = 1) =>
  n === null || n === undefined || Number.isNaN(n) ? 'Unknown' : `${n.toFixed(digits)}%`;

const yamlStr = (s) => `"${String(s ?? '').replace(/"/g, '\\"')}"`;

/**
 * Windows-safe, Obsidian-friendly filename.
 *
 * The address suffix is not decoration: ticker collisions are routine in
 * memecoins (a scam clone deliberately reusing a clean token's symbol), and
 * without it two tokens sharing a ticker in one scan silently overwrite each
 * other — potentially replacing a SCAM/AVOID note with a PASSED one.
 */
export function noteFilename(symbol, date, address) {
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
  const safe =
    String(symbol ?? 'UNKNOWN')
      .replace(/[<>:"/\\|?*$]/g, '')
      .trim()
      .slice(0, 24) || 'UNKNOWN';
  const tag = String(address ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6) || 'noaddr';
  return `${stamp}_${safe}_${tag}.md`;
}

/**
 * `fomo_app_data` — the supply-adjusted metrics block, as a nested YAML object
 * Dataview can read (e.g. `fomo_app_data.top10_pct_circulating`).
 *
 * Both denominators are emitted deliberately. "Top 10 hold X%" is ambiguous
 * between share-of-total and share-of-circulating, and on a bonding-curve token
 * those differ by an order of magnitude. Publishing both means the note can be
 * reconciled against any external tracker instead of silently disagreeing.
 */
function fomoDataBlock(security, demand, address, tradeUrl) {
  const dist = security?.distribution ?? null;
  const n = (v, digits = 2) =>
    v === null || v === undefined || Number.isNaN(v) ? 'null' : Number(v).toFixed(digits);

  return [
    'fomo_app_data:',
    `  trade_url: ${yamlStr(tradeUrl)}`,
    `  source: ${yamlStr('rugcheck+dexscreener (FOMO is mobile-only; no public API or web token page)')}`,
    `  total_supply: ${dist ? n(dist.totalSupply, 0) : 'null'}`,
    `  circulating_supply: ${dist ? n(dist.circulatingSupply, 0) : 'null'}`,
    `  lp_and_excluded_supply: ${dist ? n(dist.excludedAmount, 0) : 'null'}`,
    `  lp_and_excluded_pct: ${dist ? n(dist.excludedPct) : 'null'}`,
    `  top10_pct_total: ${dist ? n(dist.topNPct) : 'null'}`,
    `  top10_pct_circulating: ${dist ? n(dist.topNPctCirculating) : 'null'}`,
    `  ranked_wallets: ${dist ? dist.holderCountRanked : 'null'}`,
    `  market_cap_usd: ${n(demand.marketCap, 0)}`,
    `  liquidity_usd: ${n(demand.liquidityUsd, 0)}`,
    `  liq_to_mcap_pct: ${n(demand.liqToMcapPct)}`,
  ];
}

function tagFor(verdict, auditStatus) {
  if (verdict === 'SCAM/AVOID') return 'token/scam-flag';
  if (auditStatus === 'UNVERIFIED') return 'token/unverified';
  if (verdict === 'CRASH WARNING') return 'token/bearish';
  if (verdict === 'BUY SIGNAL') return 'token/bullish';
  return 'token/watch';
}

/** Extra tags so Dataview can filter on the two new modules directly. */
function extraTags(smartMoney, deployer, verdictInfo, social) {
  const tags = [];
  if (verdictInfo.categoryTag) tags.push(verdictInfo.categoryTag);
  if (verdictInfo.serialRugger) tags.push('dev/serial-rugger');
  else if (deployer?.status === 'GOOD DEV') tags.push('dev/good');
  else tags.push('dev/unknown');
  if (smartMoney?.detected) tags.push('smart-money/detected');
  if (social?.tag) tags.push(social.tag);
  if (verdictInfo.blacklisted) tags.push('token/blacklisted');
  if (verdictInfo.holderGate?.passed === false) tags.push('token/low-holders');
  tags.push('post-mortem/pending');
  return tags;
}

/**
 * One-line insider action for the dashboard table: spend, entry market cap and
 * timing for the lead wallet. Empty when nothing was attributable, rather than
 * emitting a half-filled string that reads as data.
 */
function insiderActionSummary(clusters) {
  const lead = clusters?.clusterBuying?.members?.[0] ?? clusters?.watchlisted?.[0];
  if (!lead) return '';

  const parts = [];
  if (lead.solSpent !== null && lead.solSpent !== undefined) {
    parts.push(
      `${lead.solSpent.toFixed(2)} SOL${lead.usdSpent ? ` ($${Math.round(lead.usdSpent).toLocaleString('en-US')})` : ''}`
    );
  }
  if (lead.entryMarketCapUsd) {
    parts.push(`at $${Math.round(lead.entryMarketCapUsd).toLocaleString('en-US')} MC`);
  }
  if (lead.secondsAfterLaunch !== null && lead.secondsAfterLaunch !== undefined) {
    parts.push(
      lead.secondsAfterLaunch < 60
        ? `${Math.round(lead.secondsAfterLaunch)}s after launch`
        : `${Math.round(lead.secondsAfterLaunch / 60)}m after launch`
    );
  }
  return parts.join(' · ');
}

/** Tri-state: true = passed, false = failed, null = provider had no data. */
function checkRow(check) {
  const box = check.passed === true ? '- [x]' : '- [ ]';
  const icon = check.passed === true ? '' : check.passed === false ? '' : '';
  return `${box} **${check.label}**: ${check.detail} ${icon}`;
}

const SECURITY_LABEL = {
  PASSED: 'PASSED ',
  FAILED: 'FAILED ',
  UNVERIFIED: 'UNVERIFIED ',
};

export function renderNote({
  pair,
  security,
  audit,
  demand,
  velocity,
  catalysts,
  verdictInfo,
  smartMoney,
  deployer,
  social,
  blacklistHit,
  signalCategory,
  migration,
  clusters,
  tradeLink,
  now,
}) {
  const chainId = pair.chainId;
  const chainLabel = CHAIN_LABELS[chainId] ?? chainId;
  const address = pair.baseToken.address;
  const symbol = pair.baseToken.symbol?.trim() || 'UNKNOWN';
  const ticker = `$${symbol}`;

  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const dexUrl = `https://dexscreener.com/${chainId}/${address}`;
  // Configurable because the original `fomo.app/trade/{address}` target does not
  // exist: `fomo.app` is the Android package id, not a domain, and FOMO ships no
  // web token page. Set `tradeLinkTemplate` in config.json to override.
  const tradeTemplate = tradeLink?.template ?? 'https://fomo.family/tokens/{chain}/{address}';
  const tradeLabel = tradeLink?.label ?? 'Trade on FOMO App';
  const fomoUrl = tradeTemplate.replace('{chain}', chainId).replace('{address}', address);

  const holders = security?.totalHolders ?? null;
  const velocityStr = velocity
    ? `(${velocity.newHolders >= 0 ? '+' : ''}${velocity.newHolders} in last ${velocity.minutes} mins)`
    : '(baseline snapshot — velocity available on next scan)';

  const demandTone =
    demand.m5.ratio >= 2 ? 'High Demand ' : demand.m5.ratio >= 1 ? 'Balanced' : 'Sell Pressure ';

  const frontmatter = [
    '---',
    `date: ${dateStr}`,
    `token_name: ${yamlStr(ticker)}`,
    `chain: ${yamlStr(chainLabel)}`,
    `contract_address: ${yamlStr(address)}`,
    `market_cap: ${yamlStr(usd(demand.marketCap))}`,
    `liquidity: ${yamlStr(usd(demand.liquidityUsd))}`,
    `confidence_score: ${verdictInfo.score}`,
    `signal_verdict: ${yamlStr(verdictInfo.verdict)}`,
    `impact_type: ${yamlStr(verdictInfo.impact)}`,
    `security_status: ${yamlStr(SECURITY_LABEL[audit.status])}`,
    `top_10_holder_pct: ${yamlStr(security?.ok ? pctStr(security.top10Pct) : 'Unknown')}`,
    `signal_category: ${yamlStr(signalCategory?.category ?? 'UNCLASSIFIED')}`,
    `insider_detected: ${clusters?.detected ? 'true' : 'false'}`,
    `insider_label: ${yamlStr(clusters?.label ?? '')}`,
    `insider_cluster_size: ${clusters?.clusterBuying?.size ?? 0}`,
    `insider_wallet: ${yamlStr(clusters?.clusterBuying?.members?.[0]?.wallet ?? clusters?.watchlisted?.[0]?.wallet ?? '')}`,
    `insider_action: ${yamlStr(insiderActionSummary(clusters))}`,
    `funder_network: ${yamlStr(
      clusters?.networks?.[0]
        ? `${clusters.networks[0].size} wallets via ${clusters.networks[0].funderShort}`
        : ''
    )}`,
    `solscan_wallet_link: ${yamlStr(clusters?.clusterBuying?.members?.[0]?.solscan ?? clusters?.watchlisted?.[0]?.solscan ?? '')}`,
    `unique_holders: ${security?.totalHolders ?? 0}`,
    `dexscreener_link: ${yamlStr(dexUrl)}`,
    `fomo_app_link: ${yamlStr(fomoUrl)}`,
    `migration_status: ${yamlStr(migration?.state ?? 'UNKNOWN')}`,
    `tradeable_now: ${migration?.tradeable === false ? 'false' : 'true'}`,
    `trade_advice: ${yamlStr(signalCategory?.advice ?? '')}`,
    `age_hours: ${demand.ageHours === null ? 'null' : demand.ageHours.toFixed(1)}`,
    `age_source: ${yamlStr(demand.ageSource ?? 'unknown')}`,
    `holder_density_status: ${yamlStr(verdictInfo.holderGate?.status ?? 'Unknown')}`,
    `holder_floor_passed: ${verdictInfo.holderGate?.passed === null || verdictInfo.holderGate?.passed === undefined ? 'null' : verdictInfo.holderGate.passed}`,
    `social_presence: ${yamlStr(social?.status ?? 'Unknown')}`,
    `social_twitter: ${social?.hasTwitter ? 'true' : 'false'}`,
    `social_telegram: ${social?.hasTelegram ? 'true' : 'false'}`,
    `post_mortem_verdict: ${yamlStr('PENDING')}`,
    `blacklisted: ${blacklistHit?.listed ? 'true' : 'false'}`,
    `buys_sells_5m: ${yamlStr(`${demand.m5.buys} / ${demand.m5.sells}`)}`,
    `smart_money_detected: ${smartMoney?.detected ? 'true' : 'false'}`,
    `smart_money_count: ${smartMoney?.count ?? 0}`,
    `smart_money_wallets: [${(smartMoney?.wallets ?? []).map(yamlStr).join(', ')}]`,
    `smart_money_early_buys: ${smartMoney?.earlyBuyers ?? 0}`,
    `dev_status: ${yamlStr(deployer?.status ?? 'UNKNOWN / NEW')}`,
    ...fomoDataBlock(security, demand, address, fomoUrl),
    `dev_wallet_address: ${yamlStr(deployer?.address ?? 'Unknown')}`,
    `dev_reputation: ${yamlStr(deployer?.status ?? 'UNKNOWN / NEW')}`,
    `past_successful_launches: ${deployer?.successfulLaunches ?? 0}`,
    `liq_to_mcap_pct: ${yamlStr(pctStr(demand.liqToMcapPct))}`,
    `holder_count: ${holders ?? 0}`,
    `pair_age_hours: ${demand.ageHours === null ? 'null' : demand.ageHours.toFixed(1)}`,
    `dex: ${yamlStr(pair.dexId ?? 'unknown')}`,
    `fomo_app_trade_link: ${yamlStr(fomoUrl)}`,
    'tags:',
    '  - token/analysis',
    `  - ${tagFor(verdictInfo.verdict, audit.status)}`,
    `  - chain/${chainId}`,
    ...extraTags(
      smartMoney,
      deployer,
      {
        ...verdictInfo,
        categoryTag:
          signalCategory?.category === 'COMMUNITY TAKEOVER GEM'
            ? 'signal/community-takeover'
            : signalCategory?.category === 'ESTABLISHED INSIDER GEM'
            ? 'signal/insider-established-gem'
            : signalCategory?.category === 'EARLY-STAGE INSIDER SCALP'
              ? 'signal/insider-early-scalp'
              : signalCategory?.category === 'LONG-TERM GEM'
                ? 'signal/long-term-gem'
                : signalCategory?.category === 'FAST SCALP'
                  ? 'signal/fast-scalp'
                  : null,
      },
      social
    ).map((t) => `  - ${t}`),
    '---',
  ].join('\n');

  const securityRows = audit.checks.map(checkRow).join('\n');

  const failureCallout = audit.failures.length
    ? `\n\n> [!danger] Failed checks\n${audit.failures.map((f) => `> - ${f}`).join('\n')}`
    : '';
  const unknownCallout = audit.unknowns?.length
    ? `\n\n> [!warning] Could not be verified (missing provider data, not evidence of a scam)\n${audit.unknowns.map((u) => `> - ${u}`).join('\n')}`
    : '';

  const directionLine =
    verdictInfo.impact === 'SKYROCKET'
      ? '`SKYROCKET `'
      : verdictInfo.impact === 'CRASH WARNING'
        ? '`CRASH 🔴`'
        : '`NEUTRAL `';

  const triggerEvents = catalysts.bullish.length
    ? catalysts.bullish.map((c) => `  - ${c}`).join('\n')
    : '  - _No bullish catalyst detected in on-chain data_';

  const riskEvents = catalysts.bearish.length
    ? catalysts.bearish.map((c) => `  - 🔴 ${c}`).join('\n')
    : '  - _No bearish catalyst detected in on-chain data_';

  const reasoning = buildReasoning({ audit, demand, verdictInfo, catalysts, security, deployer });
  const gateSection = renderGates(verdictInfo, social, blacklistHit);
  const smartMoneySection = renderSmartMoney(smartMoney, security);
  const deployerSection = renderDeployer(deployer, security);

  const b = verdictInfo.breakdown;

  return `${frontmatter}

# Intelligence Report: ${ticker}

> [!${verdictInfo.verdict === 'SCAM/AVOID' ? 'danger' : audit.status === 'UNVERIFIED' || verdictInfo.verdict === 'CRASH WARNING' || verdictInfo.verdict === 'UNVERIFIED / LOW HOLDERS' ? 'warning' : 'info'}] Verdict: ${verdictInfo.blacklisted ? 'BLACKLISTED DEPLOYER' : verdictInfo.serialRugger ? '🔴 AVOID / SERIAL RUGGER' : verdictInfo.verdict}
> Confidence \`${verdictInfo.score}/100\` · Security \`${audit.status}\` · Deployer \`${deployer?.status ?? 'UNKNOWN / NEW'}\` · Direction ${directionLine}
${migration?.label ? `\n> [!warning] ${migration.label}\n> ${migration.detail}` : ''}${signalCategory && signalCategory.category !== 'UNCLASSIFIED' ? `\n> [!tip] ${signalCategory.label}\n> ${signalCategory.advice}` : ''}

## Summary & Key Metrics
- **Chain**: \`${chainLabel}\` (\`${pair.dexId ?? 'unknown dex'}\`)
- **Contract**: \`${address}\`
- **Market Cap**: \`${usd(demand.marketCap)}\` | **Liquidity**: \`${usd(demand.liquidityUsd)}\` (\`${pctStr(demand.liqToMcapPct)}\` of MCap)
- **Net Demand (5m)**: \`${demand.m5.buys} Buys / ${demand.m5.sells} Sells\` (${demandTone})
- **Net Demand (1h)**: \`${demand.h1.buys} Buys / ${demand.h1.sells} Sells\`
- **Net Demand (24h)**: \`${demand.h24.buys} Buys / ${demand.h24.sells} Sells\`
- **Price Action**: 5m \`${demand.priceChange.m5.toFixed(1)}%\` · 1h \`${demand.priceChange.h1.toFixed(1)}%\` · 24h \`${demand.priceChange.h24.toFixed(1)}%\`
- **Volume**: 1h \`${usd(demand.volume.h1)}\` · 24h \`${usd(demand.volume.h24)}\`
- **Holder Count**: \`${holders ?? 'Unknown'} Wallets\` ${velocityStr}
- **Holder Density Gate**: \`${verdictInfo.holderGate?.status ?? 'Unknown'}\`
- **Social Presence**: \`${social?.status ?? 'Unknown'}\`
- **Pair Age**: \`${demand.ageHours === null ? 'Unknown' : `${demand.ageHours.toFixed(1)} hours`}\`
- **AI Confidence Score**: \`${verdictInfo.score} / 100\`

---

## Security Audit Checklist
${securityRows}

**Result: ${SECURITY_LABEL[audit.status]}**${failureCallout}${unknownCallout}

---

${gateSection}

---

${smartMoneySection}

---

${deployerSection}

---

## News & Catalyst Sentiment Analysis
- **Bullish Triggers**:
${triggerEvents}
- **Bearish Triggers**:
${riskEvents}
- **Market Direction**: ${directionLine}
- **Reasoning**: ${reasoning}

---

## Score Breakdown
| Component | Points | Max |
| --- | ---: | ---: |
| Net demand (5m + 1h) | ${b.demand} | 30 |
| Liquidity depth | ${b.liquidityDepth} | 20 |
| Holder distribution | ${b.distribution} | 20 |
| Momentum / turnover | ${b.momentum} | 15 |
| Traction (holders, socials) | ${b.traction} | 15 |
| Smart money bonus | +${b.smartMoney} | 15 |
| Social presence bonus | +${b.social} | 10 |
| Category bonus (long-term gem) | +${b.category} | 10 |
| Bearish catalyst penalty | -${b.bearishPenalty} | — |
| **Total** | **${verdictInfo.score}** | **100** |

---

## Direct Execution Links
- [${tradeLabel}](${fomoUrl})
- [View Chart on DexScreener](${dexUrl})
${chainId === 'solana' ? `- [RugCheck Report](https://rugcheck.xyz/tokens/${address})\n- [Solscan](https://solscan.io/token/${address})` : `- [GoPlus Security](https://gopluslabs.io/token-security/${chainId}/${address})`}
${(pair.info?.socials ?? []).map((s) => `- [${s.type}](${s.url})`).join('\n')}

---

> [!caution] Not financial advice
> Generated by automated on-chain analysis at ${dateStr}. Signals are mechanical
> classifications of public market data, not investment recommendations. Low-cap
> tokens routinely go to zero. Verify every contract address independently before
> interacting with it.
`;
}

function replayLine(scan) {
  if (!scan) return '`Not run (holder matching only)`';
  if (!scan.ok) return `\`Unavailable — ${scan.error}\``;
  const coverage = `${scan.inspected}/${scan.requested} pool transactions`;
  const flag = scan.throttled ? ' RPC throttled' : '';
  return `\`${scan.buyers.length} distinct buyer(s) from ${coverage}${flag}\``;
}

/**
 * A negative smart-money result is only meaningful if the replay actually
 * covered a decent share of recent trades. Say so rather than letting a
 * 5-of-25 sample read as "no whales here".
 */
function replayCaveat(scan) {
  if (!scan?.ok || !scan.throttled) return '';
  return `\n\n> [!warning] Low replay coverage\n> Only ${scan.inspected} of ${scan.requested} recent trades were replayed before the public RPC throttled.\n> Treat "no smart money detected" as inconclusive, not as evidence of absence.\n> Set \`SOLANA_RPC_URL\` in \`.env\` to a dedicated endpoint for full coverage.`;
}

/** Dual safety gate + social presence, the two pre-conditions above scoring. */
function renderGates(verdictInfo, social, blacklistHit) {
  const gate = verdictInfo.holderGate ?? {};
  const box = (ok) => (ok === true ? '- [x]' : '- [ ]');
  const icon = (ok) => (ok === true ? '' : ok === false ? '' : '');

  const concentrationOk =
    verdictInfo.breakdown?.distribution > 0 ? true : null;

  const links = social?.links ?? {};
  const linkRows = [
    links.twitter && `  - [X / Twitter](${links.twitter})`,
    links.telegram && `  - [Telegram](${links.telegram})`,
    links.website && `  - [Website](${links.website})`,
    links.discord && `  - [Discord](${links.discord})`,
  ]
    .filter(Boolean)
    .join('\n');

  const blacklistBanner = blacklistHit?.listed
    ? `\n\n> [!danger] BLACKLISTED ${blacklistHit.kind === 'mint' ? 'TOKEN' : 'DEPLOYER'}\n> ${blacklistHit.entry?.reason ?? 'Permanently blocked'}\n> Score forced to 0 regardless of current market data.`
    : '';

  return `## Safety Gates

**Dual gate — both must pass:**
${box(concentrationOk)} **Top 10 concentration** below limit ${icon(concentrationOk)}
${box(gate.passed)} **Holder floor** — ${gate.status ?? 'unknown'} ${icon(gate.passed)}

> [!note] Why holder count is a separate gate
> Concentration and holder count fail differently. Ten wallets can each hold a
> tidy 8% and still leave a token untradeable because there is nobody on the
> other side of your exit. A sub-${gate.floor ?? 150}-holder token is capped at
> ${verdictInfo.score <= 45 ? verdictInfo.score : 45}/100 no matter how clean its contract looks.

## Social Presence
- **Status**: \`${social?.status ?? 'Unknown'}\`
- **Declared links**: ${social?.totalLinks ?? 0}
${linkRows || '  - _none declared_'}

> [!warning] What this check can and cannot see
> This reads links declared in token metadata. It does not open X or Telegram,
> and cannot measure followers, engagement or KOL involvement — a link registered
> a minute ago pointing at an empty account looks identical to a live community.
> Its real value is the negative case: no socials at all is a genuine
> abandonment signal.${blacklistBanner}`;
}

function renderSmartMoney(sm, security) {
  const insider = describeInsider(security);

  if (!sm?.configured) {
    return `## Smart Money & Insider Wallet Tracking
- **Smart Money Buying**: \`Module inactive — no watchlist configured\`
- **Tracked Wallets**: \`—\`
- **Insider Accumulation**: \`${insider}\`

> [!note] How to activate
> Add wallet addresses to \`aegis/smart-money.json\` and re-scan. No keyless public
> API curates proven high-win-rate wallets, so this list is yours to supply —
> see the sourcing notes inside that file. Until then this section reports only
> the insider/bundle read above, which comes from the security provider.`;
  }

  if (!sm.detected) {
    return `## Smart Money & Insider Wallet Tracking
- **Smart Money Buying**: \`No tracked wallets detected\`
- **Tracked Wallets**: \`—\`
- **Buyer Replay**: ${replayLine(sm.buyerScan)}
- **Insider Accumulation**: \`${insider}\`
- **Coverage**: ${sm.note}${replayCaveat(sm.buyerScan)}`;
  }

  const shortUsd = (n) =>
    n === null || n === undefined || Number.isNaN(n)
      ? null
      : n >= 1e6
        ? `$${(n / 1e6).toFixed(1)}M`
        : n >= 1e3
          ? `$${Math.round(n / 1e3)}k`
          : `$${Math.round(n)}`;

  const rows = sm.matches
    .map((m) => {
      const parts = [`### ${m.displayLabel}`];
      parts.push(`- **Wallet**: \`${m.address}\``);
      parts.push(`- **Profile**: [Inspect on Solscan](${m.solscanUrl})`);

      if (m.usdSpent && m.solSpent) {
        const at = m.entryMarketCapUsd ? ` at \`${shortUsd(m.entryMarketCapUsd)}\` market cap` : '';
        parts.push(
          `- **Action**: Bought \`${shortUsd(m.usdSpent)}\` (\`${m.solSpent.toFixed(2)} SOL\`)${at}`
        );
      } else {
        parts.push(
          `- **Action**: Holds \`${m.pct.toFixed(2)}%\` of supply — _spend not attributable (${m.via === 'holder' ? 'matched from holder list, no trade replayed' : 'multi-buyer transaction'})_`
        );
      }

      if (m.entryMinutesAfterLaunch !== null && m.entryMinutesAfterLaunch !== undefined) {
        const mins = m.entryMinutesAfterLaunch;
        parts.push(
          `- **Timing**: Entered \`${mins < 1 ? '<1 min' : `${mins.toFixed(0)} mins`}\` after launch${mins <= 10 ? ' ' : ''}`
        );
      } else {
        parts.push('- **Timing**: _entry time not recovered_');
      }

      parts.push(`- **Current position**: \`${m.pct.toFixed(2)}%\` of supply${m.insider ? ' flagged insider' : ''}`);

      if (m.stats) {
        const bits = [
          m.stats.winRate && `\`${m.stats.winRate}\` win-rate`,
          m.stats.trades && `\`${m.stats.trades}\` trades`,
          m.stats.netProfitUsd && `\`${m.stats.netProfitUsd}\` net profit`,
        ].filter(Boolean);
        parts.push(`- **Historical stats**: ${bits.join(' · ')}`);
        parts.push(
          `  _Supplied by you in \`smart_wallets.json\`${m.stats.statsUpdated ? `, as of ${m.stats.statsUpdated}` : ''} — not computed on-chain._`
        );
      } else {
        parts.push(
          '- **Historical stats**: _none on file. Add `win_rate`, `trades`, `net_profit_usd` to this wallet in `smart_wallets.json`._'
        );
      }
      return parts.join('\n');
    })
    .join('\n\n');

  const scanLine = replayLine(sm.buyerScan);

  return `## Smart Money & Insider Wallet Tracking
- **Smart Money Buying**: \`${sm.count} Known Whale${sm.count === 1 ? '' : 's'} Detected \`
- **Combined Position**: \`${sm.totalPct.toFixed(2)}% of supply\`
- **Entry Timing**: \`${sm.earlyBuyers ? `${sm.earlyBuyers} confirmed early buy(s) ` : sm.provablyEarly ? 'Within early-accumulation window ' : 'Not established'}\`
- **Buyer Replay**: ${scanLine}
- **Insider Accumulation**: \`${insider}\`

${rows}

> [!note] ${sm.note}${replayCaveat(sm.buyerScan)}`;
}

function renderDeployer(dev, security) {
  const addr = dev?.address ?? security?.creator ?? null;

  if (!dev?.available) {
    return `## Serial Dev Reputation Audit
- **Deployer Address**: \`${addr ?? 'Unknown'}\`
- **Dev Status**: \`UNKNOWN / NEW\`
- **Dev History Check**: \`Not completed\`
- **Reason**: ${dev?.reasons?.[0] ?? 'Deployer audit unavailable for this chain'}`;
  }

  const notable = dev.notable?.length
    ? dev.notable
        .map((n) => `  - \`$${n.symbol}\` — $${Math.round(n.marketCap).toLocaleString('en-US')} market cap`)
        .join('\n')
    : null;

  const callout =
    dev.status === 'SERIAL RUGGER'
      ? `\n\n> [!danger] 🔴 AVOID / SERIAL RUGGER\n> ${dev.reasons.join('\n> ')}\n> This overrides the contract audit: a serial rugger's next token is always\n> freshly deployed with clean authorities, so the contract looking safe is\n> expected and proves nothing.`
      : dev.status === 'GOOD DEV'
        ? `\n\n> [!success] Established deployer\n> ${dev.reasons.join('\n> ')}`
        : `\n\n> [!note] ${dev.reasons.join(' ')}`;

  return `## Serial Dev Reputation Audit
- **Deployer Address**: \`${addr}\`
- **Dev Status**: \`${dev.status}\`
- **Dev History Check**: \`${dev.status === DEV_UNKNOWN ? 'Inconclusive' : dev.status === 'GOOD DEV' ? 'Passed' : 'FAILED'}\`
- **Mints Found in Window**: \`${dev.totalMintsFound}\` (${dev.deploys48h} in last 48h)
- **Matured Prior Launches**: \`${dev.maturePriorLaunches}\` → \`${dev.successfulLaunches}\` above $100k, \`${dev.deadLaunches}\` dead
${dev.rapidFire ? `- **Burst Deployment**: \`${dev.totalMintsFound} mints within ${dev.burstWindowSec}s\` 🔴\n` : ''}${notable ? `- **Notable Past Launches**:\n${notable}\n` : ''}${dev.fromCache ? '- **Source**: `cached deployer profile`\n' : ''}${callout}`;
}

const DEV_UNKNOWN = 'UNKNOWN / NEW';

function buildReasoning({ audit, demand, verdictInfo, catalysts, security, deployer }) {
  if (verdictInfo.serialRugger) {
    return `Deployer \`${deployer.address}\` is a serial rugger — ${deployer.reasons[0]}. The contract audit ${audit.status === 'PASSED' ? 'passed, which is meaningless here: every fresh mint from this wallet has clean authorities' : `also returned ${audit.status}`}. Classified SCAM/AVOID on deployer reputation alone, regardless of the ${demand.m5.buys}/${demand.m5.sells} 5m flow.`;
  }

  if (audit.status === 'FAILED') {
    return `Security gate failed on ${audit.failures.length} check(s) — ${audit.failures[0]}. No amount of price momentum offsets a contract-level failure, so this is classified SCAM/AVOID regardless of the ${demand.m5.buys}/${demand.m5.sells} 5m flow.`;
  }

  const flow =
    demand.m5.ratio === Infinity
      ? 'buy-only flow with zero sells'
      : `${demand.m5.ratio.toFixed(1)}x buy/sell ratio over 5m`;

  if (audit.status === 'UNVERIFIED') {
    return `No check failed, but ${audit.unknowns.length} could not be completed — ${audit.unknowns[0]}. This is missing provider data (typical for a token this new), not evidence of a scam, so it is not blacklisted. It also cannot be cleared: confidence is capped until the contract is fully indexed. Flow currently shows ${flow}.`;
  }

  if (verdictInfo.verdict === 'CRASH WARNING') {
    const driver = catalysts.bearish[0] ?? 'Sell-side dominance';
    return `Distribution is underway: ${flow}, 1h price change ${demand.priceChange.h1.toFixed(1)}%, and pool depth at ${demand.liqToMcapPct.toFixed(1)}% of market cap. Primary driver is ${driver.charAt(0).toLowerCase()}${driver.slice(1)}. Exiting into this book will incur heavy slippage.`;
  }

  if (verdictInfo.verdict === 'BUY SIGNAL') {
    return `Contract passed all zero-tolerance checks (top 10 hold ${security?.top10Pct?.toFixed(1) ?? '?'}%), demand shows ${flow}, and liquidity is ${demand.liqToMcapPct.toFixed(1)}% of market cap — above the 15% slippage floor. ${catalysts.bullish.length} bullish catalyst(s) detected against ${catalysts.bearish.length} bearish. Structure supports continuation while flow holds.`;
  }

  return `Contract is clean but conviction is incomplete: ${flow}, liquidity at ${demand.liqToMcapPct.toFixed(1)}% of market cap, composite score ${verdictInfo.score}/100 (below the ${verdictInfo.verdict === 'WATCH' ? 'buy-signal' : ''} threshold). ${catalysts.bearish.length ? `Blocking factor: ${catalysts.bearish[0]}.` : 'Awaiting a stronger demand impulse or holder-growth confirmation.'}`;
}
