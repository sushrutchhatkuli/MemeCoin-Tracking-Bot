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
import { concentrationCapFor } from './audit.mjs';
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

  const url = tradeUrl(position.address, tradeLink, position.chain);
  lines.push('');
  lines.push(`📲 <a href="${esc(url)}">[ Open FOMO App to Sell ]</a>`);
  lines.push('');
  lines.push(
    '<i>Percentages are movement from the alert market cap, not your P&amp;L — Aegis does not know your entry or size. Not financial advice.</i>'
  );

  return lines.join('\n');
}

/**
 * Insider cluster block. Only ever reached on a token that cleared every safety
 * gate — coordinated buying of a rug is still a rug, so this never appears on a
 * blocked token.
 */
function renderClusters(clusters) {
  if (!clusters?.detected) return [];

  const lines = ['', '🕵️ <b>CLUSTER &amp; INSIDER ACTIVITY:</b>'];

  const bits = [];
  if (clusters.clusterBuying) bits.push(`${clusters.clusterBuying.size} wallets in launch window`);
  if (clusters.networks.length) bits.push('same funder network');
  if (clusters.oversized.length) bits.push(`${clusters.oversized.length} oversized buy(s)`);
  lines.push(`• Cluster Detected: ${esc(bits.join(' + '))} ✅`);

  // Individual wallets, largest first.
  const members = (
    clusters.clusterBuying?.members ?? clusters.watchlisted ?? []
  ).slice(0, 5);
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
      `• Wallet ${i + 1}: <a href="${esc(m.solscan)}">${esc(m.short)}</a>` +
        `${m.label ? ` (${esc(m.label)})` : ''} — ${esc(spend + mc + timing)}`
    );
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

export function buildMessage({ pair, demand, verdictInfo, smartMoney, deployer, security, tradeLink, reaudit, signalCategory, migration, clusters }) {
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
    // Signal type leads, because it determines how the trade should be held —
    // that decision matters more than the score.
    clusters?.detected
      ? '🚀 <b>REAL-TIME INSIDER BUY ALERT</b> 🚀'
      : signalCategory?.category === 'LONG-TERM GEM'
      ? '💎 <b>LONG-TERM INVESTMENT GEM SIGNAL</b> 💎'
      : signalCategory?.category === 'FAST SCALP'
        ? '⚡ <b>FAST MOMENTUM SCALP SIGNAL</b> ⚡'
        : smartMoney?.detected
          ? '🚀 <b>HIGH PROBABILITY SIGNAL</b> 🚀'
          : '🚀 <b>BUY SIGNAL</b> 🚀',
    `Token: <b>$${esc(symbol)}</b> (${esc(pair.chainId === 'solana' ? 'Solana' : pair.chainId)})`,
    `<i>Score ${verdictInfo.score}/100</i>${clusters?.label ? ` | <b>${esc(clusters.label)}</b>` : ''}`,
    // Placed above the advice: if the buy button is locked, the trading advice
    // is not actionable yet and the reader needs to know that first.
    ...(migration?.label
      ? ['', `<b>${esc(migration.label)}</b>`, `<i>${esc(migration.detail)}</i>`]
      : []),
    ...(signalCategory?.advice ? ['', `<b>${esc(signalCategory.advice)}</b>`] : []),
    ...renderClusters(clusters),
    ...renderWhales(smartMoney),
    '',
    '🔒 <b>SAFETY &amp; DENSITY AUDIT:</b>',
    `• Holders: ${security?.totalHolders ?? '?'} Wallets (${verdictInfo.holderGate?.passed ? `Passed ${verdictInfo.holderGate.floor}+ Floor ✅` : 'Floor NOT passed ❌'})`,
    `• Top 10 Concentration: ${security?.top10Pct === null || security?.top10Pct === undefined ? '?' : `${security.top10Pct.toFixed(1)}%`}${reaudit?.ran ? ` (re-checked live: ${reaudit.now?.toFixed(1)}%, cap ${reaudit.cap}% ✅)` : ` (cap ${esc(String(concentrationCapFor(demand?.ageHours ?? null, { maxTop10Pct: 25, maxTop10PctYoung: 20 }).cap))}% ✅)`}`,
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
    `📲 <a href="${esc(tradeUrl(address, tradeLink, pair.chainId))}">[ Open in FOMO App ]</a>`,
    `📈 <a href="https://dexscreener.com/${esc(pair.chainId)}/${esc(address)}">DexScreener</a>`,
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
        if (r.category === 'LONG-TERM GEM') extras.push('💎GEM');
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

  const { cap, tier } = concentrationCapFor(result.demand?.ageHours ?? null, config.thresholds);
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
    if (!result.clusters?.detected) return { status: 'no-insider-activity' };
    // Kept as an explicit floor, defaulting to 0 so the rule above stands
    // alone. Raise `telegram.insiderMinScore` to require conviction as well.
    const floor = config.telegram.insiderMinScore ?? 0;
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
  });

  const sent = await sendTelegram({ ...credentials, text });
  if (sent.ok) {
    alertLog[key] = { sentAt: now, symbol: pair.baseToken.symbol, score: verdictInfo.score };
    return { status: 'sent', reaudit };
  }
  return { status: 'failed', error: sent.error };
}
