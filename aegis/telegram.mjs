/**
 * Telegram signal notifier.
 *
 * Fires only on high-conviction results (BUY SIGNAL at or above the configured
 * score floor) and de-duplicates per token, because the scanner is designed to
 * run every 10-15 minutes and would otherwise re-alert the same token on every
 * pass until it fell out of the window.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { fetchLiveHolderDistribution } from './sources.mjs';
import {
  concentrationCapFor,
  isAlertableCategory,
  evaluateSecurityShield,
  tractionFrom,
} from './audit.mjs';
import { formatSmartMoneyLine } from './smart_money.mjs';

/* ------------------------------------------------------------------ *
 * .env
 * ------------------------------------------------------------------ */

/**
 * Minimal .env reader. Deliberately not a dependency: the whole pipeline is
 * dependency-free, and this only needs KEY=VALUE. Values already present in the
 * real environment win, so the scheduled task can inject secrets instead.
 */
export async function loadEnv(path) {
  const env = {};
  try {
    const raw = await readFile(path, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  } catch {
    /* no .env file — fall through to process.env */
  }
  const pick = (key) => process.env[key] || env[key] || null;
  return {
    botToken: pick('TELEGRAM_BOT_TOKEN'),
    chatId: pick('TELEGRAM_CHAT_ID'),
    rpcOverride: pick('SOLANA_RPC_URL'),
    // MTProto credentials for telegram_listener.mjs. Separate from the bot
    // token because a bot cannot read channels it does not administer — the
    // listener needs a USER session, which is a far more sensitive credential.
    tgApiId: pick('TELEGRAM_API_ID'),
    tgApiHash: pick('TELEGRAM_API_HASH'),
    tgSession: pick('TELEGRAM_SESSION'),
  };
}

/* ------------------------------------------------------------------ *
 * Alert de-duplication
 * ------------------------------------------------------------------ */

export async function loadAlertLog(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveAlertLog(path, log) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(log, null, 2), 'utf8');
}

function shouldAlert(log, key, cooldownHours, now) {
  const last = log[key];
  if (!last) return true;
  return now - last.sentAt >= cooldownHours * 3600 * 1000;
}

/* ------------------------------------------------------------------ *
 * Message
 * ------------------------------------------------------------------ */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Build a trade URL from the configured template. Not hardcoded, because the
 * original `fomo.app/trade/{address}` host does not exist — `fomo.app` is the
 * Android package id and FOMO ships no web token page.
 */
export function tradeUrl(address, tradeLink, chain = 'solana') {
  const template = tradeLink?.template ?? 'https://fomo.family/tokens/{chain}/{address}';
  return template.replace('{chain}', chain).replace('{address}', address);
}

/**
 * Dual one-tap execution links.
 *
 * Two destinations because they fail differently: FOMO is the mobile app you
 * actually trade in, Jupiter is a web router that works even if a token is not
 * listed in FOMO yet — which is common for a launch minutes old, exactly when
 * these alerts fire.
 *
 * Jupiter is Solana-only, so EVM alerts carry the FOMO link alone rather than a
 * link that would 404.
 */
export function executionLinks(address, chain, tradeLink) {
  const links = [
    `📲 <a href="${esc(tradeUrl(address, tradeLink, chain))}">[ Open in FOMO App ]</a>`,
  ];
  if (chain === 'solana') {
    links.push(`⚡ <a href="https://jup.ag/swap/SOL-${esc(address)}">[ Swap on Jupiter ]</a>`);
  }
  return links;
}

const usdShort = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '?';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
};

/**
 * SELL signal message.
 *
 * Percentages are stated as movement "from the alert market cap", never as your
 * P&L — Aegis does not know your fill, your size, or whether you took the trade
 * at all. Saying "you are up 100%" would be inventing a fact about someone
 * else's money.
 */
export function buildSellMessage({
  position,
  currentMcap,
  headline,
  reason,
  action,
  wallet,
  label,
  solscan,
  soldPct,
  tradeLink,
}) {
  const usd = (n) =>
    n === null || n === undefined ? 'unavailable' : `$${Math.round(n).toLocaleString('en-US')}`;

  const entry = position.entryMarketCap;
  const movePct =
    currentMcap !== null && entry > 0 ? ((currentMcap - entry) / entry) * 100 : null;
  const peakPct =
    position.peakMarketCap && entry > 0
      ? ((position.peakMarketCap - entry) / entry) * 100
      : null;

  const lines = [
    `🔴 <b>SELL SIGNAL: $${esc(position.symbol)}</b> 🔴`,
    `<i>Status: EXIT RECOMMENDED</i>`,
    '',
    `<b>Reason: ${esc(headline)}</b>`,
    `• ${esc(reason)}`,
  ];

  if (wallet) {
    const short = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
    lines.push(`• Insider Wallet: <a href="${esc(solscan)}">${esc(short)}</a> (${esc(label)})`);
    if (soldPct !== undefined && soldPct !== null) {
      lines.push(`• Action: sold ${soldPct.toFixed(0)}% of their holdings on-chain`);
    }
  }

  lines.push('');
  lines.push(`• Alert Market Cap: ${usd(entry)}`);
  lines.push(
    `• Current Market Cap: ${usd(currentMcap)}` +
      (movePct !== null ? ` (${movePct >= 0 ? '+' : ''}${movePct.toFixed(0)}% from alert)` : '')
  );
  if (peakPct !== null && peakPct > 0) {
    lines.push(`• Peak since alert: ${usd(position.peakMarketCap)} (+${peakPct.toFixed(0)}%)`);
  }

  lines.push('');
  lines.push('💡 <b>RECOMMENDED ACTION:</b>');
  lines.push(esc(action));

  lines.push('');
  lines.push(
    `📲 <a href="${esc(tradeUrl(position.address, tradeLink, position.chain))}">[ Open FOMO App to Sell ]</a>`
  );
  if (position.chain === 'solana') {
    lines.push(`⚡ <a href="https://jup.ag/swap/SOL-${esc(position.address)}">[ Swap out on Jupiter ]</a>`);
  }
  lines.push('');
  lines.push(
    '<i>Percentages are movement from the alert market cap, not your P&amp;L — Aegis does not know your entry or size. Not financial advice.</i>'
  );

  return lines.join('\n');
}

/**
 * Rolling scorecard for one insider wallet.
 *
 * Every number is labelled with where it came from, because the honest version
 * of this block is much weaker than the one that was asked for and the gap
 * matters when money is on it:
 *
 *   WIN RATE   real, but over AEGIS-OBSERVED buys only — the tokens this
 *              scanner happened to scan, not the wallet's market-wide record.
 *              The sample skews optimistic: buyer replay reads tokens with a
 *              live pool, so survivors are over-represented.
 *   PROFIT     ESTIMATED, not realized. Spend x later price change, which
 *              assumes the wallet still holds. Aegis never sees exits.
 *   DURATION   omitted. There is no exit timestamp anywhere in the pipeline,
 *              so an average holding time cannot be computed — and a
 *              plausible-looking number in its place would be fabricated.
 *
 * The GMGN and Birdeye links below the roster are where the real figures live;
 * both are gated (403/401), which is why they are links and not numbers.
 */
function scorecardLines(sc) {
  if (!sc) return ['   ↳ <i>no observation history for this wallet yet</i>'];
  if (!sc.gradedBuys) {
    return [
      `   ↳ <i>${sc.observedBuys} buy(s) seen in ${sc.windowDays}d, none graded yet — no win rate available</i>`,
    ];
  }

  const bits = [
    `${sc.winRatePct.toFixed(0)}% win rate (${sc.wins}/${sc.gradedBuys} graded)`,
    sc.estimatedProfitUsd !== null
      ? `~${sc.estimatedProfitUsd >= 0 ? '+' : '-'}$${Math.abs(Math.round(sc.estimatedProfitUsd)).toLocaleString('en-US')} est.`
      : 'P&amp;L not estimable',
  ];
  if (sc.trackedForHours !== null) {
    bits.push(
      sc.trackedForHours >= 48
        ? `tracked ${Math.round(sc.trackedForHours / 24)}d`
        : `tracked ${Math.round(sc.trackedForHours)}h`
    );
  }

  return [
    `   ↳ <b>${sc.windowDays}d scorecard:</b> ${esc(bits.join(' · '))}`,
    '   ↳ <i>Aegis-observed only, profit estimated (exits are never seen), holding time not measurable — tap GMGN/Birdeye for the real record.</i>',
  ];
}

/**
 * Insider cluster block. Only ever reached on a token that cleared every safety
 * gate — coordinated buying of a rug is still a rug, so this never appears on a
 * blocked token.
 */
function renderClusters(clusters) {
  if (!clusters?.detected) return [];

  const count = clusters.insiderCount ?? 0;
  const multi = count >= 2;

  // Header scales with the count, because "4 unique wallets bought this" is the
  // headline fact — more decision-relevant than any single wallet's detail.
  const lines = multi
    ? [
        '',
        `🔥 <b>MULTIPLE INSIDERS DETECTED (${count} Unique Wallets Bought Same Coin!)</b>`,
      ]
    : ['', '🕵️ <b>CLUSTER &amp; INSIDER ACTIVITY:</b>'];

  const bits = [];
  if (clusters.clusterBuying) bits.push(`${clusters.clusterBuying.size} wallets in launch window`);
  if (clusters.networks.length) bits.push('same funder network');
  if (clusters.oversized.length) bits.push(`${clusters.oversized.length} oversized buy(s)`);
  if (clusters.jito?.detected) bits.push(`${clusters.jito.size} wallets in one slot`);
  if (bits.length) lines.push(`• Signals: ${esc(bits.join(' + '))} ✅`);

  if (clusters.jito?.detected) {
    lines.push(`• 📦 <b>Bundle:</b> ${esc(clusters.jito.detail)}`);
    lines.push(
      clusters.jito.confirmed
        ? '<i>Confirmed against Jito’s bundle API — these buys were submitted for atomic execution together.</i>'
        : '<i>Same-slot execution (~400ms window). Jito could not confirm a bundle id, so this is a strong structural tell rather than proof of one bundle.</i>'
    );
  }

  // The deduplicated roster, largest spend first. Falls back to the older lists
  // if an upstream caller has not populated it.
  const members = (
    clusters.uniqueInsiders ??
    clusters.clusterBuying?.members ??
    clusters.watchlisted ??
    []
  ).slice(0, 6);

  members.forEach((m, i) => {
    const spend =
      m.solSpent !== null && m.solSpent !== undefined
        ? `Spent ${m.solSpent.toFixed(2)} SOL${m.usdSpent ? ` (${usdShort(m.usdSpent)})` : ''}`
        : 'Spend not attributable';
    const mc = m.entryMarketCapUsd ? ` at ${usdShort(m.entryMarketCapUsd)} MC` : '';
    const timing =
      m.secondsAfterLaunch !== null && m.secondsAfterLaunch !== undefined
        ? ` (${m.secondsAfterLaunch < 60 ? `${Math.round(m.secondsAfterLaunch)}s` : `${Math.round(m.secondsAfterLaunch / 60)}m`} after launch)`
        : '';
    lines.push(
      `• <b>Insider #${i + 1}</b> (${esc(m.short)}): ${esc(spend + mc + timing)} | ` +
        `🔗 <a href="${esc(m.solscan)}">Solscan</a>`
    );
    for (const row of scorecardLines(m.scorecard)) lines.push(row);
  });

  for (const n of clusters.networks.slice(0, 2)) {
    lines.push(
      `• Funder Link: ${n.size} wallets funded by <a href="${esc(n.funderSolscan)}">${esc(n.funderShort)}</a>`
    );
  }

  for (const o of clusters.oversized.slice(0, 2)) {
    lines.push(`• ⚠️ Non-routine size: ${esc(o.short)} — ${esc(o.reason)}`);
  }

  // Named cluster, when network discovery corroborated the funder graph.
  const net = clusters.network;
  if (net?.clusters?.length) {
    const c = net.clusters[0];
    lines.push(
      `• Network: Cabal Cluster of ${c.size} wallets (${esc(c.confidence)} confidence, funder-graph verified)`
    );
    if (net.added?.length) {
      lines.push(`• Net expanded: +${net.added.length} connected wallet(s) now tracked`);
    }
  }

  // Direct profile links for the lead wallet. Three destinations because each
  // shows something different: Solscan for raw transactions, GMGN for trader
  // stats, Birdeye for portfolio analytics. Aegis cannot read the latter two
  // (403/401), so these are how you check win rate and PnL yourself.
  const lead = members[0];
  if (lead?.wallet) {
    lines.push('');
    lines.push('🔗 <b>DIRECT INSIDER WALLET LINKS:</b>');
    lines.push(`• 🔍 <a href="https://solscan.io/account/${esc(lead.wallet)}">Solscan Wallet</a>`);
    lines.push(`• 🤖 <a href="https://gmgn.ai/sol/address/${esc(lead.wallet)}">GMGN Trader Profile</a>`);
    lines.push(`• 🦅 <a href="https://birdeye.so/profile/${esc(lead.wallet)}">Birdeye Analytics</a>`);
  }

  // Stated every time. A shared funder is frequently just a CEX hot wallet, and
  // coordination is not proof of inside knowledge.
  lines.push('');
  lines.push(
    '<i>Coordination signal, not proof of insider knowledge — shared funders are often exchange hot wallets. Win rate and PnL are not fetched (GMGN/Birdeye are gated); tap the links above to check them.</i>'
  );

  return lines;
}

/** Whale detail block — only ever reached on a token that passed every gate. */
function renderWhales(smartMoney) {
  if (!smartMoney?.detected) return [];

  const lines = [
    '',
    '🐋 <b>INSIDER / SMART MONEY ACTIVITY:</b>',
    `• Smart Money Detected: ${smartMoney.count} Elite Whale${smartMoney.count === 1 ? '' : 's'} ✅`,
  ];

  for (const w of smartMoney.matches) {
    const shortAddr = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
    lines.push(`• Wallet: <code>${esc(shortAddr)}</code> (${esc(w.displayLabel)})`);
    lines.push(`• Whale Profile: 🔗 <a href="${esc(w.solscanUrl)}">solscan.io/account/${esc(shortAddr)}</a>`);

    if (w.usdSpent && w.solSpent) {
      const atMcap = w.entryMarketCapUsd ? ` at ${usdShort(w.entryMarketCapUsd)} Market Cap` : '';
      lines.push(`• Action: Bought ${usdShort(w.usdSpent)} (${w.solSpent.toFixed(2)} SOL)${esc(atMcap)}`);
    } else {
      lines.push(
        `• Action: Holds ${w.pct.toFixed(2)}% of supply <i>(spend not attributable${w.via === 'holder' ? ' — matched on holder list' : ' — multi-buyer transaction'})</i>`
      );
    }

    if (w.entryMinutesAfterLaunch !== null && w.entryMinutesAfterLaunch !== undefined) {
      const m = w.entryMinutesAfterLaunch;
      lines.push(
        `• Timing: Entered ${m < 1 ? '<1 min' : `${m.toFixed(0)} mins`} after launch${m <= 10 ? ' ⚡' : ''}`
      );
    } else {
      lines.push('• Timing: <i>entry time not recovered</i>');
    }

    if (w.stats) {
      const bits = [
        w.stats.winRate && `${esc(w.stats.winRate)} Win-Rate`,
        w.stats.trades && `${esc(w.stats.trades)} Trades`,
        w.stats.netProfitUsd && `${esc(w.stats.netProfitUsd)} Profit`,
      ].filter(Boolean);
      lines.push(`• Whale Stats: ${bits.join(' | ')} <i>(from your watchlist)</i>`);
    } else {
      lines.push('• Whale Stats: <i>none on file — add win_rate/trades/net_profit_usd to smart_wallets.json</i>');
    }
  }
  return lines;
}

/**
 * The first line(s) of the alert — the label a reader sees before anything else.
 *
 * When the token landed in one of the two insider tiers, that tier's header
 * leads and states the market-cap band outright, because band is what decides
 * how the position should be held: a $60k early entry and a $3M accumulation
 * are not the same trade even when the insider evidence is identical.
 *
 * The cabal-size line follows only at 2+ unique wallets, where it adds a fact
 * the tier header does not carry. At a single wallet it would just restate the
 * header, and the full roster appears in the cluster block below regardless.
 */
export function alertHeaderLines({ signalCategory, clusters, smartMoney, megaRunner, megaRunnerHeader }) {
  const count = clusters?.insiderCount ?? 0;
  const tierHeader = signalCategory?.alertHeader ?? null;

  // The viral-volume banner leads when it fires, because it is the reason the
  // token is moving right now. The tier header stays below it rather than being
  // replaced — band and holding style are still what decide how to hold the
  // trade, and losing that would make the alert less actionable, not more.
  const viral =
    megaRunner?.detected && megaRunnerHeader ? [`<b>${esc(megaRunnerHeader)}</b>`] : [];

  // A slot-level bundle leads everything: it is the most specific structural
  // claim available about HOW the buys happened, and it is the one an operator
  // most wants to see before deciding whether this is a cabal entry.
  const bundle = clusters?.jito?.detected
    ? [
        `<b>📦 ${esc(clusters.jito.confirmed ? 'JITO BLOCK #0 CABAL BUNDLE DETECTED' : 'SAME-SLOT CABAL BUNDLE DETECTED')} 📦</b>`,
      ]
    : [];

  if (tierHeader) {
    const lines = [...bundle, ...viral, `<b>${esc(tierHeader)}</b>`];
    if (count >= 4) lines.push(`🔥 <b>CABAL SWARM — ${count} unique insider wallets</b>`);
    else if (count >= 2) lines.push(`🔥 <b>MULTI-INSIDER — ${count} unique wallets</b>`);
    return lines;
  }

  // Fallback chain, unchanged. Reached when telegram.insiderTiersOnly is off
  // and a token alerts from outside both bands, or on a non-insider signal.
  return [
    ...bundle,
    ...viral,
    count >= 4
      ? '🚀 <b>CABAL SWARM BUY ALERT</b> 🚀'
      : count >= 2
        ? '🚀 <b>MULTI-INSIDER BUY ALERT</b> 🚀'
        : clusters?.detected
          ? '🚀 <b>REAL-TIME INSIDER BUY ALERT</b> 🚀'
          : signalCategory?.category === 'LONG-TERM GEM'
            ? '💎 <b>LONG-TERM INVESTMENT GEM SIGNAL</b> 💎'
            : signalCategory?.category === 'FAST SCALP'
              ? '⚡ <b>FAST MOMENTUM SCALP SIGNAL</b> ⚡'
              : smartMoney?.detected
                ? '🚀 <b>HIGH PROBABILITY SIGNAL</b> 🚀'
                : '🚀 <b>BUY SIGNAL</b> 🚀',
  ];
}

/**
 * Community takeover block. Shows the four criteria as measured values rather
 * than ticks, because "512 holders" and "1,400 holders" are the same tick and
 * very different tokens.
 */
function renderCto(cto) {
  if (!cto?.detected) return [];
  const lines = ['', '🚀 <b>COMMUNITY TAKEOVER CONFIRMED:</b>'];
  for (const c of cto.checks) {
    lines.push(`• ${esc(c.label)}: ${esc(c.detail)} ✅`);
  }
  lines.push(
    '<i>The developer is gone, so there is nobody to rug — and nobody to build. Community momentum is the whole thesis; if it fades there is no team to carry it.</i>'
  );
  return lines;
}

/** The six mandatory gates, itemised. Only reached on a token that passed. */
function renderShield(shield) {
  if (!shield?.checks?.length) return [];
  const lines = ['', '🛡️ <b>ANTI-RUGPULL SHIELD:</b>'];
  for (const c of shield.checks) {
    lines.push(`• ${esc(c.label)}: ${esc(c.detail)} ${c.passed ? '✅' : '❌'}`);
  }
  if (shield.ctoDepthWaiver) {
    lines.push(
      '<i>Depth cleared on the absolute-dollar floor rather than the 15% ratio — a CTO exemption. Size your exit to the pool, not the market cap.</i>'
    );
  }
  return lines;
}

/** Viral-volume detail. Shows the two measured figures, not just the banner. */
function renderMegaRunner(megaRunner) {
  if (!megaRunner?.detected) return [];
  return [
    '',
    '🔥 <b>MEGA-RUNNER VIRAL VOLUME:</b>',
    ...megaRunner.reasons.map((r) => `• ${esc(r)} ✅`),
    '<i>Volume and buy/sell counts can both be manufactured — a wash trader cycling SOL between their own wallets produces this exact signature, deliberately, because it is what scanners look for.</i>',
  ];
}

export function buildMessage({ pair, demand, verdictInfo, smartMoney, deployer, security, tradeLink, reaudit, signalCategory, migration, clusters, cto, thresholds, megaRunner, megaRunnerHeader }) {
  const symbol = pair.baseToken?.symbol ?? 'UNKNOWN';
  const address = pair.baseToken.address;
  const usd = (n) =>
    n === null || n === undefined || Number.isNaN(n)
      ? 'Unknown'
      : `$${Math.round(n).toLocaleString('en-US')}`;

  const smartLine = !smartMoney?.configured
    ? '⚪ Watchlist not configured'
    : smartMoney.detected
      ? `✅ ${smartMoney.count} tracked wallet(s)${smartMoney.earlyBuyers ? ` — ${smartMoney.earlyBuyers} bought early` : ''}`
      : '⚪ None detected';

  const devLine =
    deployer?.status === 'GOOD DEV ✅'
      ? `✅ Proven (${deployer.successfulLaunches} past $100k+ launches)`
      : deployer?.status === 'SERIAL RUGGER 🔴'
        ? '🔴 SERIAL RUGGER'
        : '⚪ Unknown / new deployer';

  const ratio =
    demand.m5.sells > 0 ? (demand.m5.buys / demand.m5.sells).toFixed(1) : '∞';

  return [
    ...alertHeaderLines({ signalCategory, clusters, smartMoney, megaRunner, megaRunnerHeader }),
    `Token: <b>$${esc(symbol)}</b> (${esc(pair.chainId === 'solana' ? 'Solana' : pair.chainId)})`,
    `<i>Score ${verdictInfo.score}/100</i>${clusters?.label ? ` | <b>${esc(clusters.label)}</b>` : ''}`,
    // Placed above the advice: if the buy button is locked, the trading advice
    // is not actionable yet and the reader needs to know that first.
    ...(migration?.label
      ? ['', `<b>${esc(migration.label)}</b>`, `<i>${esc(migration.detail)}</i>`]
      : []),
    ...(signalCategory?.advice ? ['', `<b>${esc(signalCategory.advice)}</b>`] : []),
    ...renderMegaRunner(megaRunner),
    ...renderCto(cto),
    ...renderClusters(clusters),
    ...renderWhales(smartMoney),
    ...renderShield(
      evaluateSecurityShield({ security, demand, thresholds: thresholds ?? {}, cto })
    ),
    '',
    '🔒 <b>SAFETY &amp; DENSITY AUDIT:</b>',
    ...(signalCategory?.insiderRequirements
      ? [
          `• Insider Tier Gate: ${signalCategory.insiderRequirements.checks.filter((c) => c.passed).length}/${signalCategory.insiderRequirements.checks.length} mandatory requirements met ${signalCategory.insiderRequirements.passed ? '✅' : '❌'}`,
        ]
      : []),
    `• Holders: ${security?.totalHolders ?? '?'} Wallets (${verdictInfo.holderGate?.passed ? `Passed ${verdictInfo.holderGate.floor}+ Floor ✅` : 'Floor NOT passed ❌'})`,
    // Cap read from the live thresholds, not hardcoded. It used to say 25 while
    // the configured cap was 20, which put two different numbers for the same
    // limit in one message once the shield block began printing alongside it.
    `• Top 10 Concentration: ${security?.top10Pct === null || security?.top10Pct === undefined ? '?' : `${security.top10Pct.toFixed(1)}%`}${reaudit?.ran ? ` (re-checked live: ${reaudit.now?.toFixed(1)}%, cap ${reaudit.cap}% ✅)` : ` (cap ${esc(String(concentrationCapFor(demand?.ageHours ?? null, thresholds ?? {}, tractionFrom(security, demand)).cap))}% ✅)`}`,
    `• Holder Data: ${security?.distributionSource === 'rpc-live' ? 'live on-chain ✅' : 'cached indexer ⚠️'}${reaudit?.ran ? '' : reaudit?.reason ? ` · re-audit skipped (${esc(String(reaudit.reason).slice(0, 60))})` : ''}`,
    `• Security Status: ${verdictInfo.securityStatus === 'PASSED' ? 'PASSED ALL AUDITS ✅' : esc(verdictInfo.securityStatus ?? '?')}`,
    `• Deployer: ${esc(devLine)}`,
    '',
    '📊 <b>MARKET:</b>',
    `• Market Cap: ${usd(demand.marketCap)} | Liquidity: ${usd(demand.liquidityUsd)} (${demand.liqToMcapPct.toFixed(0)}%)`,
    `• 5m Buys/Sells: ${demand.m5.buys} / ${demand.m5.sells} (${ratio}x)`,
    `• Smart Money: ${esc(smartLine)}`,
    '',
    `<code>${esc(address)}</code>`,
    '',
    ...executionLinks(address, pair.chainId, tradeLink),
    `📈 <a href="https://dexscreener.com/${esc(pair.chainId)}/${esc(address)}">DexScreener</a>`,
    // Token contract on Solscan — distinct from the wallet links above, which
    // point at /account/. This is /token/ and resolves the mint itself.
    ...(pair.chainId === 'solana'
      ? [`🔍 <a href="https://solscan.io/token/${esc(address)}">Solscan Token</a>`]
      : []),
    '',
    '<i>Automated on-chain analysis, not financial advice.</i>',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Scan digest — the terminal output, delivered
 * ------------------------------------------------------------------ */

const TELEGRAM_MAX_CHARS = 4096;

const VERDICT_ORDER = ['BUY SIGNAL', 'CRASH WARNING', 'SCAM/AVOID', 'WATCH'];
const VERDICT_ICON = {
  'BUY SIGNAL': '🚀',
  'CRASH WARNING': '🔴',
  'SCAM/AVOID': '☠️',
  WATCH: '👀',
};

const short = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '?';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
};

/**
 * Every audited token, grouped by verdict — the console view, for when the
 * scanner runs somewhere you cannot watch it (Render, Task Scheduler).
 */
export function buildDigest({ rows, scanned, noteCount, startedAt, tradeLink }) {
  const when = new Date(startedAt).toISOString().replace('T', ' ').slice(0, 16);
  const grouped = new Map(VERDICT_ORDER.map((v) => [v, []]));
  for (const r of rows) {
    if (!grouped.has(r.verdict)) grouped.set(r.verdict, []);
    grouped.get(r.verdict).push(r);
  }

  const lines = [
    `📊 <b>Aegis Scan</b> — ${when} UTC`,
    `<i>${scanned} audited · ${noteCount} note(s) written</i>`,
  ];

  for (const verdict of VERDICT_ORDER) {
    const items = (grouped.get(verdict) ?? []).sort((a, b) => b.score - a.score);
    if (!items.length) continue;

    lines.push('', `${VERDICT_ICON[verdict]} <b>${esc(verdict)}</b> (${items.length})`);

    for (const r of items) {
      const head = `  • <b>$${esc(r.symbol)}</b> <code>${r.score}/100</code>`;
      if (verdict === 'SCAM/AVOID') {
        lines.push(`${head} — ${esc(r.failReason ?? 'audit failed')}`);
      } else {
        const extras = [
          `MC ${short(r.marketCap)}`,
          `5m ${r.buys}/${r.sells}`,
          `liq ${r.liqPct.toFixed(0)}%`,
        ];
        if (r.smartMoney) extras.push(`🐋x${r.smartMoney}`);
        if (r.category === 'COMMUNITY TAKEOVER GEM') extras.push('🚀CTO');
        else if (r.category === 'ESTABLISHED INSIDER GEM') extras.push('💎INSIDER-GEM');
        else if (r.category === 'EARLY-STAGE INSIDER SCALP') extras.push('⚡INSIDER-SCALP');
        else if (r.category === 'LONG-TERM GEM') extras.push('💎GEM');
        else if (r.category === 'FAST SCALP') extras.push('⚡SCALP');
        if (r.devStatus === 'GOOD DEV ✅') extras.push('dev✅');
        lines.push(`${head} — ${esc(extras.join(' · '))}`);

        // Dedicated smart-money callout beneath the token line. Only reached on
        // WATCH / BUY SIGNAL rows: a SCAM/AVOID token never shows whale detail,
        // because surfacing it there is precisely the trick the safety override
        // exists to defeat.
        for (const m of r.smartMoneyDetail ?? []) {
          lines.push(`  ↳ ${formatSmartMoneyLine(m, { html: true })}`);
        }

        if (verdict === 'BUY SIGNAL') {
          lines.push(`     📲 <a href="${esc(tradeUrl(r.address, tradeLink, r.chain))}">Trade</a> · <code>${esc(r.address)}</code>`);
        }
      }
    }
  }

  if (!rows.length) lines.push('', '<i>No tokens passed the pre-audit filters this pass.</i>');

  let text = lines.join('\n');
  if (text.length > TELEGRAM_MAX_CHARS) {
    text = `${text.slice(0, TELEGRAM_MAX_CHARS - 40).trimEnd()}\n<i>… truncated</i>`;
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Send
 * ------------------------------------------------------------------ */

export async function sendTelegram({ botToken, chatId, text }) {
  if (!botToken || !chatId) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, messageId: body.result?.message_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Gate + send. Returns a result describing what happened so the scanner can log
 * it honestly rather than implying an alert went out when it did not.
 */
/**
 * Re-read concentration from chain immediately before dispatch.
 *
 * The audit that produced this signal ran earlier in the scan — seconds to
 * minutes ago, and against a possibly-cached holder list. That is enough time
 * for a cabal to accumulate. This is the last check before the alert reaches a
 * phone, so it re-reads live and cancels if concentration has crossed the cap.
 *
 * When no dedicated RPC is configured the re-audit cannot run. The behaviour
 * then is governed by `telegram.requireLiveReaudit`:
 *   false (default) — dispatch, and mark the alert as un-reverified
 *   true            — cancel, failing closed
 * Default is false only because keyless RPCs refuse the call entirely, so
 * failing closed would silence every alert rather than filter risky ones.
 */
export async function preDispatchReaudit({ result, pair, config }) {
  if (pair.chainId !== 'solana') {
    return { ran: false, reason: 'non-Solana chain', pass: true };
  }
  const security = result.security;
  if (!security?.ok) return { ran: false, reason: 'no security record', pass: true };

  // Reuse the exact exclusion set from the original audit. Recomputing it, or
  // omitting it, would compare a pool-excluded figure against a pool-inclusive
  // one and produce a bogus "concentration spiked" cancellation.
  const live = await fetchLiveHolderDistribution({
    mint: pair.baseToken.address,
    rpcUrl: config.rpcUrl,
    excludedAddresses: security.excludedAddresses ?? new Set(),
    topN: 10,
  });

  if (!live.ok) {
    return { ran: false, reason: live.error, pass: !config.telegram.requireLiveReaudit };
  }

  // MUST use the same traction context the original audit used. A re-audit on
  // the base cap would cancel exactly the high-volume alerts the widened cap
  // was added to let through — the token would pass the audit at 30% and then
  // be killed at dispatch by a 20% recheck.
  const { cap, tier } = concentrationCapFor(
    result.demand?.ageHours ?? null,
    config.thresholds,
    tractionFrom(security, result.demand)
  );
  const before = security.top10Pct;
  const nowPct = live.topNPct;
  const pass = nowPct !== null && nowPct < cap;

  return {
    ran: true,
    pass,
    cap,
    tier,
    before,
    now: nowPct,
    drift: before !== null && nowPct !== null ? nowPct - before : null,
    reason: pass
      ? null
      : `top 10 concentration is ${nowPct?.toFixed(1)}% at dispatch, above the ${cap}% cap (${tier})`,
  };
}

export async function maybeAlert({ result, pair, credentials, config, alertLog, now }) {
  const { verdictInfo, demand, smartMoney, deployer, security, audit } = result;

  if (!config.telegram.enabled) return { status: 'disabled' };

  // Hard safety block, checked independently of the verdict rather than relying
  // on it. The scoring path already forces these to SCAM/AVOID, but this is the
  // rule that must not fail: a whale buying their own scam must never produce a
  // notification. Two independent checks, so a future scoring change cannot
  // silently reopen the hole.
  if (verdictInfo.safetyGateFailed) {
    return { status: 'blocked-safety', reason: verdictInfo.safetyGateReason };
  }
  if (audit.status !== 'PASSED') return { status: 'blocked-audit-not-passed' };

  // ---- Strict insider-only filter ---------------------------------
  //
  // Alert IF AND ONLY IF insider activity was detected AND every safety gate
  // passed. Both conditions, no exceptions — the audit check above already
  // guarantees the second, so this adds the first.
  //
  // Note this REPLACES the old BUY SIGNAL + score-floor rule rather than
  // stacking on top of it: a token can carry genuine cluster activity while
  // sitting at WATCH (demand ratio under 2x), and requiring both would filter
  // out most real insider entries — which is the opposite of the intent.
  if (config.telegram.insiderOnly !== false) {
    // A community takeover is an independent reason to alert. It has no insider
    // requirement by design — the pattern is a crowd, not a cabal — so it is
    // the one thing allowed past the insider-activity gate.
    const isCto = result.cto?.detected === true;
    if (!result.clusters?.detected && !isCto) return { status: 'no-insider-activity' };

    // ---- Dual insider tier gate -----------------------------------
    //
    // Alerts are restricted to the two named market-cap tiers, so every
    // notification carries a band-specific header and a holding style that was
    // chosen for that band. classifySignal only awards a tier after
    // evaluateInsiderRequirements passes in full, so this single check also
    // enforces mint/freeze revoked, LP burned, and top-10 under the cap.
    //
    // The requirement object is re-checked directly as well. Same reasoning as
    // the double safety-gate check above: the loudest alerts Aegis sends should
    // not depend on one call site staying correct.
    if (config.telegram.insiderTiersOnly !== false) {
      const category = result.signalCategory?.category;
      if (!isAlertableCategory(category)) {
        return {
          status: 'outside-insider-tiers',
          reason:
            result.signalCategory?.reason ??
            `MC $${Math.round(demand.marketCap ?? 0).toLocaleString('en-US')} is outside both insider bands`,
        };
      }
      const req = result.signalCategory?.insiderRequirements;
      if (req && !req.passed) {
        return { status: 'blocked-insider-requirements', reason: req.failures?.[0] ?? 'unknown' };
      }
    }

    // Score floor. Cannot be applied during classification — a tier's own
    // scoreBoost feeds the score — so it is enforced here at dispatch.
    const floor =
      config.telegram.insiderMinScore ??
      config.signalCategories?.insiderTiers?.scoreFloor ??
      0;
    if (verdictInfo.score < floor) return { status: 'below-insider-score-floor' };
  } else {
    if (verdictInfo.verdict !== 'BUY SIGNAL') return { status: 'not-a-signal' };
    if (verdictInfo.score < config.telegram.minScore) return { status: 'below-score-floor' };
  }

  const key = `${pair.chainId}:${pair.baseToken.address}`;
  if (!shouldAlert(alertLog, key, config.telegram.cooldownHours, now)) {
    return { status: 'cooldown' };
  }

  if (!credentials.botToken || !credentials.chatId) {
    return { status: 'no-credentials' };
  }

  // Last gate before the alert leaves the machine.
  const reaudit = await preDispatchReaudit({ result, pair, config });
  if (!reaudit.pass) {
    return { status: 'blocked-reaudit', reason: reaudit.reason, reaudit };
  }

  const text = buildMessage({
    pair,
    demand,
    verdictInfo: { ...verdictInfo, securityStatus: audit.status },
    smartMoney,
    deployer,
    security,
    tradeLink: { template: config.tradeLinkTemplate, label: config.tradeLinkLabel },
    reaudit,
    signalCategory: result.signalCategory,
    migration: result.migration,
    clusters: result.clusters,
    cto: result.cto,
    thresholds: config.thresholds,
    megaRunner: result.megaRunner,
    megaRunnerHeader: config.megaRunner?.alertHeader ?? null,
  });

  const sent = await sendTelegram({ ...credentials, text });
  if (sent.ok) {
    alertLog[key] = { sentAt: now, symbol: pair.baseToken.symbol, score: verdictInfo.score };
    return { status: 'sent', reaudit };
  }
  return { status: 'failed', error: sent.error };
}
