/**
 * Telegram signal notifier.
 *
 * Fires only on high-conviction results (BUY SIGNAL at or above the configured
 * score floor) and de-duplicates per token, because the scanner is designed to
 * run every 10-15 minutes and would otherwise re-alert the same token on every
 * pass until it fell out of the window.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchLiveHolderDistribution } from './sources.mjs';
import {
  auditFailuresAreBypassable,
  concentrationCapFor,
  evaluateCandidateSwarm,
  isAlertableCategory,
  evaluateSecurityShield,
  resolveInsiderBypass,
  topInsiderScore,
  tractionFrom,
} from './audit.mjs';
import { formatSmartMoneyLine } from './smart_money.mjs';
import { recommendSize, formatSizeLine } from './position_sizer.mjs';

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
    // Both optional. CryptoPanic is 403 without a token and X search is 401
    // without a bearer, so the modules that use them stay inert rather than
    // failing, and report which sources were actually live.
    cryptoPanicToken: pick('CRYPTOPANIC_TOKEN'),
    coingeckoKey: pick('COINGECKO_API_KEY'),
    twitterBearer: pick('TWITTER_BEARER_TOKEN'),
    // Optional. Without it ai_narrative_scorer stays inert and the narrative
    // bonus is simply never awarded — never a penalty.
    geminiKey: pick('GEMINI_API_KEY'),
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
/**
 * Execution links, optionally pre-filled with the recommended size.
 *
 * ── UNVERIFIED, AND WORTH KNOWING ───────────────────────────────────────────
 * `?amount=` is appended as specified, but neither destination's handling of it
 * could be confirmed from here: both are client-side apps, so an HTTP fetch
 * returns the same shell whether the parameter is honoured or ignored. The
 * downside is mild — an unrecognised query parameter is dropped and the field
 * simply opens empty — but do check the first alert that arrives, because a
 * button that silently ignores the amount looks identical to one that fills it,
 * and the failure mode is trading a size you did not intend.
 *
 * The label states the amount too, so the size is legible even if the
 * pre-fill does not take.
 */
export function executionLinks(address, chain, tradeLink, size = null) {
  const sol = size?.sol ?? null;
  const q = sol ? `?amount=${sol.toFixed(2)}` : '';
  const suffix = sol ? ` ${sol.toFixed(2)} SOL` : '';

  const links = [
    `<a href="${esc(tradeUrl(address, tradeLink, chain))}${esc(q)}">[ Open in FOMO App${esc(suffix)} ]</a>`,
  ];
  if (chain === 'solana') {
    links.push(
      `<a href="https://jup.ag/swap/SOL-${esc(address)}${esc(q)}">[ Swap on Jupiter${esc(suffix)} ]</a>`
    );
  }
  return links;
}

/* ------------------------------------------------------------------ *
 * Wallet profile links
 * ------------------------------------------------------------------ *
 *
 * ONE definition, used by /whales, the insider roster, the whale block and the
 * candidate swarm. Before this there were four, and they had already drifted:
 * the insider block offered three destinations but only for the lead wallet,
 * while the whale and swarm blocks offered Solscan alone. A wallet you could
 * check the P&L of depended on which block it happened to render in.
 *
 * GMGN LEADS DELIBERATELY. It is the destination that answers the question
 * someone taps a wallet to ask — live P&L and holdings — and Aegis cannot fetch
 * those itself (403 Cloudflare, documented in the networkDiscovery notes). The
 * link is the whole mechanism for that data, so it goes first.
 *
 * ── ON MEME TERMINAL ────────────────────────────────────────────────────────
 * Requested as `https://memeterminal.com/solana/wallet/<wallet>` and NOT shipped
 * enabled, because the domain is not a product. Measured 2026-08-10: every path
 * on memeterminal.com returns an identical 114-byte document whose only content
 * is a redirect to /lander, and /lander is a GoDaddy "memeterminal.com is for
 * sale" page. The wallet route does not exist; a tap from a phone lands on a
 * domain listing.
 *
 * It is left in config as a DISABLED entry rather than deleted, so if the
 * intended product lives at another domain it is one edit away — change the url
 * and set enabled. A dead link in an alert is worse than a missing one: it
 * looks like a working feature until the moment you need it.
 */
export const DEFAULT_WALLET_PROFILES = [
  { label: 'GMGN', url: 'https://gmgn.ai/sol/address/{wallet}', enabled: true },
  { label: 'Solscan', url: 'https://solscan.io/account/{wallet}', enabled: true },
  { label: 'Birdeye', url: 'https://birdeye.so/profile/{wallet}', enabled: true },
];

/** Configured profile destinations for one wallet. Pure. */
export function walletProfileLinks(wallet, config = {}) {
  if (typeof wallet !== 'string' || !wallet) return [];
  const configured = config.telegram?.walletProfiles;
  const profiles = Array.isArray(configured) && configured.length ? configured : DEFAULT_WALLET_PROFILES;

  return profiles
    .filter((p) => p?.enabled !== false && typeof p?.url === 'string' && p.url.includes('{wallet}') && p?.label)
    .map((p) => ({ label: String(p.label), url: p.url.replaceAll('{wallet}', encodeURIComponent(wallet)) }));
}

/**
 * The tappable link row.
 *
 * Rendered as separate anchors rather than one combined link because each is a
 * distinct tap target — on a phone that is the difference between reaching GMGN
 * in one tap and reaching it after a page load and a menu.
 */
export function renderProfileLinks(wallet, config = {}, { separator = ' · ' } = {}) {
  const links = walletProfileLinks(wallet, config);
  if (!links.length) return '';
  return links.map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`).join(separator);
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
  lines.push('<b>RECOMMENDED ACTION:</b>');
  lines.push(esc(action));

  lines.push('');
  lines.push(
    `<a href="${esc(tradeUrl(position.address, tradeLink, position.chain))}">[ Open FOMO App to Sell ]</a>`
  );
  if (position.chain === 'solana') {
    lines.push(`<a href="https://jup.ag/swap/SOL-${esc(position.address)}">[ Swap out on Jupiter ]</a>`);
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
function renderClusters(clusters, config = {}) {
  if (!clusters?.detected) return [];

  const count = clusters.insiderCount ?? 0;
  const multi = count >= 2;

  // Header scales with the count, because "4 unique wallets bought this" is the
  // headline fact — more decision-relevant than any single wallet's detail.
  const lines = multi
    ? [
        '',
        `<b>MULTIPLE INSIDERS DETECTED (${count} Unique Wallets Bought Same Coin!)</b>`,
      ]
    : ['', '<b>CLUSTER &amp; INSIDER ACTIVITY:</b>'];

  const bits = [];
  if (clusters.clusterBuying) bits.push(`${clusters.clusterBuying.size} wallets in launch window`);
  if (clusters.networks.length) bits.push('same funder network');
  if (clusters.oversized.length) bits.push(`${clusters.oversized.length} oversized buy(s)`);
  if (clusters.jito?.detected) bits.push(`${clusters.jito.size} wallets in one slot`);
  if (bits.length) lines.push(`• Signals: ${esc(bits.join(' + '))} `);

  if (clusters.jito?.detected) {
    lines.push(`• <b>Bundle:</b> ${esc(clusters.jito.detail)}`);
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
    lines.push(`• <b>Insider #${i + 1}</b> (${esc(m.short)}): ${esc(spend + mc + timing)}`);
    // EVERY insider gets the full link row, not just the lead. Previously only
    // wallet #1 had a P&L destination and the rest offered Solscan alone, which
    // made "check the others" a manual copy-paste.
    const links = renderProfileLinks(m.wallet, config);
    if (links) lines.push(`   ${links}`);
    for (const row of scorecardLines(m.scorecard)) lines.push(row);
  });

  for (const n of clusters.networks.slice(0, 2)) {
    lines.push(
      `• Funder Link: ${n.size} wallets funded by <a href="${esc(n.funderSolscan)}">${esc(n.funderShort)}</a>`
    );
  }

  for (const o of clusters.oversized.slice(0, 2)) {
    lines.push(`• Non-routine size: ${esc(o.short)} — ${esc(o.reason)}`);
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

  // The lead wallet gets a labelled block as well as its inline row: it is the
  // largest position and the one most likely to be checked first, so it is
  // worth a target that does not require finding the right line.
  const lead = members[0];
  if (lead?.wallet) {
    const leadLinks = walletProfileLinks(lead.wallet, config);
    if (leadLinks.length) {
      lines.push('', `<b>LEAD INSIDER — ${esc(lead.short ?? '')} :</b>`);
      for (const l of leadLinks) lines.push(`• <a href="${esc(l.url)}">${esc(l.label)}</a>`);
    }
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
function renderWhales(smartMoney, config = {}) {
  if (!smartMoney?.detected) return [];

  const lines = [
    '',
    '<b>INSIDER / SMART MONEY ACTIVITY:</b>',
    `• Smart Money Detected: ${smartMoney.count} Elite Whale${smartMoney.count === 1 ? '' : 's'} `,
  ];

  for (const w of smartMoney.matches) {
    const shortAddr = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
    lines.push(`• Wallet: <code>${esc(shortAddr)}</code> (${esc(w.displayLabel)})`);
    // Was Solscan alone. A matched whale is exactly the wallet whose live P&L
    // you want before acting, and Solscan is the one destination that does not
    // show it.
    lines.push(`• Profile: ${renderProfileLinks(w.address, config)}`);

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
        `• Timing: Entered ${m < 1 ? '<1 min' : `${m.toFixed(0)} mins`} after launch${m <= 10 ? ' ' : ''}`
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
export function alertHeaderLines({ signalCategory, clusters, smartMoney, megaRunner, megaRunnerHeader, news, social, insiderBypass, jitoTip, momentum, narrative, candidateSwarm }) {
  const count = clusters?.insiderCount ?? 0;
  const tierHeader = signalCategory?.alertHeader ?? null;

  // The bypass notice leads EVERYTHING, above the bundle and news banners. Once
  // the shield has been overridden, the first thing a reader needs to know is
  // that the alert in front of them cleared fewer checks than an alert normally
  // does — every other line below is describing a token that failed a gate.
  const bypassBanner = insiderBypass?.applied === true ? renderInsiderBypassBanner(insiderBypass) : [];

  // The viral-volume banner leads when it fires, because it is the reason the
  // token is moving right now. The tier header stays below it rather than being
  // replaced — band and holding style are still what decide how to hold the
  // trade, and losing that would make the alert less actionable, not more.
  const viral = [
    // Momentum leads the viral banner: it is the more specific of the two and
    // it is the one with a number in it. The mega-runner header is a fixed
    // string, this states what actually changed in the last five minutes.
    ...(momentum?.qualifies && momentum.label ? [`<b>${esc(momentum.label)}</b>`] : []),
    ...(megaRunner?.detected && megaRunnerHeader ? [`<b>${esc(megaRunnerHeader)}</b>`] : []),
  ];

  // A slot-level bundle leads everything: it is the most specific structural
  // claim available about HOW the buys happened, and it is the one an operator
  // most wants to see before deciding whether this is a cabal entry.
  //
  // The tip line sits directly under it because the two answer one question
  // together: the bundle says the buys were co-executed, the tip says what that
  // ordering was worth to whoever bought it. A tip with no bundle still renders
  // — someone paid for priority either way — but it is the pair that means
  // something.
  const bundle = [
    ...(clusters?.jito?.detected
      ? [
          `<b>${esc(clusters.jito.confirmed ? 'JITO BLOCK #0 CABAL BUNDLE DETECTED' : 'SAME-SLOT CABAL BUNDLE DETECTED')} </b>`,
        ]
      : []),
    ...(jitoTip?.detected ? [`<b>${esc(jitoTip.label)}</b>`] : []),
  ];

  // News leads when it fires: a token named after a live headline needs that
  // context before anything else, in both directions — it explains the move,
  // and it is the signature of an opportunistic launch.
  const newsBanner = news?.matched
    ? [`<b>${esc(`BREAKING NEWS CATALYST ALERT (News Matched: ${news.keywords.join(' / ')}!)`)} </b>`]
    : [];
  const socialBanner = social?.detected
    ? [`<b>${esc(`SOCIAL HYPE SPIKE (${social.matchType === 'contract' ? 'trending, contract verified' : social.matchType === 'symbol' ? 'ticker match only — unverified' : 'mention velocity'})`)} </b>`]
    : [];

  // Only S-Tier reaches the header. A mid narrative score is context for the
  // body, not a banner — headers are for the facts that change a decision.
  const narrativeBanner = narrative?.qualifies ? [`<b>${esc(narrative.label)}</b>`] : [];

  // The swarm leads everything when it fires. Once the notification filter is
  // on it is the REASON this alert exists at all, so it goes above the tier
  // header and above the bundle banner.
  const swarmBanner = candidateSwarm?.qualifies ? [`<b>${esc(candidateSwarm.label)}</b>`] : [];

  if (tierHeader) {
    const lines = [...swarmBanner, ...bypassBanner, ...newsBanner, ...bundle, ...viral, ...socialBanner, ...narrativeBanner, `<b>${esc(tierHeader)}</b>`];
    if (count >= 4) lines.push(`<b>CABAL SWARM — ${count} unique insider wallets</b>`);
    else if (count >= 2) lines.push(`<b>MULTI-INSIDER — ${count} unique wallets</b>`);
    return lines;
  }

  // Fallback chain, unchanged. Reached when telegram.insiderTiersOnly is off
  // and a token alerts from outside both bands, or on a non-insider signal.
  return [
    ...swarmBanner,
    ...bypassBanner,
    ...newsBanner,
    ...bundle,
    ...viral,
    ...socialBanner,
    ...narrativeBanner,
    count >= 4
      ? '<b>CABAL SWARM BUY ALERT</b> '
      : count >= 2
        ? '<b>MULTI-INSIDER BUY ALERT</b> '
        : clusters?.detected
          ? '<b>REAL-TIME INSIDER BUY ALERT</b> '
          : signalCategory?.category === 'LONG-TERM GEM'
            ? '<b>LONG-TERM INVESTMENT GEM SIGNAL</b> '
            : signalCategory?.category === 'FAST SCALP'
              ? '<b>FAST MOMENTUM SCALP SIGNAL</b> '
              : smartMoney?.detected
                ? '<b>HIGH PROBABILITY SIGNAL</b> '
                : '<b>BUY SIGNAL</b> ',
  ];
}

/**
 * Community takeover block. Shows the four criteria as measured values rather
 * than ticks, because "512 holders" and "1,400 holders" are the same tick and
 * very different tokens.
 */
function renderCto(cto) {
  if (!cto?.detected) return [];
  const lines = ['', '<b>COMMUNITY TAKEOVER CONFIRMED:</b>'];
  for (const c of cto.checks) {
    lines.push(`• ${esc(c.label)}: ${esc(c.detail)} `);
  }
  lines.push(
    '<i>The developer is gone, so there is nobody to rug — and nobody to build. Community momentum is the whole thesis; if it fades there is no team to carry it.</i>'
  );
  return lines;
}

/**
 * The high-risk notice shown when the shield was overridden.
 *
 * Deliberately the loudest block in the message and deliberately specific: it
 * names the gates that were waived and the score that waived them, because
 * "shield bypassed" without the list reads as a formality. The token in this
 * alert failed a check that normally stops the alert being sent at all.
 */
function renderInsiderBypassBanner(bypass) {
  const gates = bypass?.gates?.length ? bypass.gates.join(', ') : 'standard anti-rug gates';
  const who = bypass?.label ? `${bypass.label} · ` : '';
  const wallet = bypass?.wallet ? `${bypass.wallet.slice(0, 6)}…${bypass.wallet.slice(-4)}` : 'unknown wallet';
  return [
    '🔴 <b>HIGH-RISK NOTICE: ANTI-RUG SHIELD BYPASSED BY HIGH-CONVICTION INSIDER</b>',
    `• Matched Insider Score: <b>${esc(String(bypass?.score ?? '?'))}</b> — ${esc(String(bypass?.floor ?? '?'))}+ required (High-Alpha Override)`,
    `• Insider: ${esc(who)}<code>${esc(wallet)}</code>`,
    `• Gates waived: <b>${esc(gates)}</b>`,
    '<i>These gates failed on measured data and were overridden by configuration, not cleared. An unburned LP is the developer keeping the ability to withdraw the pool; a concentrated top 10 is who will be selling into you; a thin holder base is the absence of anyone to sell to. A high-scoring buyer changes none of that, and a developer can buy their own token from a high-scoring wallet.</i>',
    '<i>Mint authority, freeze authority, rug flags, a serial-rugger deployer, the blacklist and liquidity depth were NOT bypassed and still passed.</i>',
  ];
}

/** The six mandatory gates, itemised. Only reached on a token that passed. */
function renderShield(shield) {
  if (!shield?.checks?.length) return [];
  const lines = ['', '<b>ANTI-RUGPULL SHIELD:</b>'];
  for (const c of shield.checks) {
    // No tag appended for a bypassed row — evaluateSecurityShield already wrote
    // [BYPASSED] into the detail, and adding a second one printed it twice.
    lines.push(`• ${esc(c.label)}: ${esc(c.detail)} `);
  }
  if (shield.ctoDepthWaiver) {
    lines.push(
      '<i>Depth cleared on the absolute-dollar floor rather than the 15% ratio — a CTO exemption. Size your exit to the pool, not the market cap.</i>'
    );
  }
  if (shield.insiderBypassApplied) {
    lines.push(
      '<i>The figures on the [BYPASSED] rows are the real measured values. Those gates failed and were overridden; they were not met.</i>'
    );
  }
  return lines;
}

/**
 * News-catalyst and social-hype detail.
 *
 * The caveat under a news match is not boilerplate. A token named after a live
 * headline is the signature of an opportunistic launch at least as often as a
 * genuine one, and the alert is the moment that needs saying.
 */
function renderNewsAndSocial(news, social) {
  const lines = [];

  if (news?.matched) {
    lines.push('', `<b>NEWS CATALYST:</b> ${esc(news.keywords.join(', '))}`);
    for (const h of news.headlines ?? []) {
      const age = h.ageMinutes === null ? '' : ` (${h.ageMinutes.toFixed(0)}m ago)`;
      lines.push(
        `• ${h.link ? `<a href="${esc(h.link)}">${esc(h.title.slice(0, 96))}</a>` : esc(h.title.slice(0, 96))} — <i>${esc(h.source)}${age}</i>`
      );
    }
    lines.push(
      '<i>A token named after a breaking story is the signature of an opportunistic launch as often as a real one. This adds no score; every safety gate still applied.</i>'
    );
  }

  if (social?.detected) {
    lines.push('', '<b>SOCIAL HYPE:</b>');
    for (const r of social.reasons ?? []) lines.push(`• ${esc(r)} `);
    if (social.matchType === 'symbol') {
      lines.push(
        '<i>Matched on TICKER only — the contract was not verified against the trending coin. Solana tickers are unrestricted, so this may be an impersonator.</i>'
      );
    }
    if (!social.mentionsAvailable) {
      lines.push('<i>Search trend only — X mention velocity needs a paid API key and is not part of this signal.</i>');
    }
  }

  return lines;
}

/**
 * Candidate swarm detail — who converged, and what that does and does not mean.
 *
 * Each wallet is shown WITH ITS GRADED-BUY COUNT, for the same reason /whales
 * prints denominators: Gate-0 membership is three graded buys, and a reader who
 * sees "5 candidate whales" without the sample sizes will assume five proven
 * traders agreed. They did not necessarily agree about anything — they may all
 * follow the same caller.
 */
function renderCandidateSwarm(swarm, config = {}) {
  if (!swarm?.qualifies) return [];

  const lines = [
    '',
    `<b>CANDIDATE SWARM: ${swarm.effectiveCount} of ${swarm.poolSize} tracked candidate wallets</b>`,
  ];
  for (const w of swarm.wallets.slice(0, 8)) {
    const timing =
      w.secondsAfterLaunch === null || w.secondsAfterLaunch === undefined
        ? 'entry time unknown'
        : w.secondsAfterLaunch < 60
          ? `${Math.round(w.secondsAfterLaunch)}s after launch`
          : `${Math.round(w.secondsAfterLaunch / 60)}m after launch`;
    const spend =
      w.solSpent !== null && w.solSpent !== undefined ? `${w.solSpent.toFixed(2)} SOL` : 'spend not attributable';
    lines.push(
      `• <code>${esc(w.short)}</code> — ${w.wins}/${w.gradedBuys} graded (${w.winRatePct.toFixed(0)}%), ${esc(spend)}, ${esc(timing)}`
    );
    lines.push(`   ${renderProfileLinks(w.address, config)}`);
  }
  if (swarm.wallets.length > 8) lines.push(`• <i>… and ${swarm.wallets.length - 8} more</i>`);

  if (!swarm.requireEarly) {
    lines.push(
      `<i>${swarm.earlyCount} of these bought within ${swarm.earlyWindowSec}s of launch; the rest are later entries. Set candidateSwarm.requireEarly to count only the early ones.</i>`
    );
  }
  lines.push(
    '<i>READ THE DENOMINATORS. A candidate wallet is one with 3+ graded buys, not a proven trader — at a ~77% base rug rate that is presence, not edge. The claim here is the COUNT: several wallets converging on one token is coordination or a shared signal, which may simply mean they all follow the same caller. It is a reason to look, not a prediction.</i>'
  );
  return lines;
}

/**
 * AI narrative detail.
 *
 * Rendered for ANY score, not only S-Tier, because "the AI looked at this and
 * called it a 30" is more useful than silence — silence is indistinguishable
 * from the scorer being switched off or the API being down.
 *
 * The caveat is mandatory. This grades a name. It has no view of the contract,
 * and it is scoring the one input the token's creator controls completely.
 */
function renderNarrative(narrative) {
  if (!narrative?.scored) return [];

  const lines = ['', `<b>${esc(narrative.label)}</b>`];
  if (narrative.aiReason) lines.push(`• Model's note: <i>${esc(narrative.aiReason)}</i>`);
  lines.push(
    narrative.qualifies
      ? `• Narrative bonus: <b>+${narrative.scoreBoost}</b> (${narrative.minScore}+ scores S-Tier)`
      : `• Under the ${narrative.minScore} S-Tier floor — no narrative points awarded`
  );
  lines.push(
    '<i>This grades the NAME, not the token. It is the only signal here the creator chooses outright — a rug and a real launch can carry identical branding, because branding is typed into a form. A strong meme on a fraudulent contract still scores high, by design. It adds score only on an affirmatively PASSED audit.</i>'
  );
  return lines;
}

/**
 * Viral momentum detail — the measured figures behind the banner.
 *
 * When the holder window was not really five minutes, the block says so in
 * plain terms rather than leaving the reader to infer it from a decimal. That
 * is the number someone uses to decide whether to chase a breakout, and the
 * pipeline samples holders every ~10 minutes, not every five.
 */
function renderMomentum(momentum) {
  if (!momentum?.qualifies) return [];

  const lines = ['', `<b>${esc(momentum.label)}</b>`];
  for (const r of momentum.reasons ?? []) lines.push(`• ${esc(r)} `);

  if (momentum.holderWindowNormalised) {
    lines.push(
      `<i>The holder figure is measured over ${momentum.holders.windowMinutes.toFixed(1)} minutes and expressed as a 5-minute rate. Holder counts come from the audit, which runs at most every ${Math.round((momentum.holders.windowMinutes || 10))}-ish minutes per token, so a literal 5-minute count is not something this pipeline can read.</i>`
    );
  }
  lines.push(
    '<i>Both inputs are cheap to fake — holders by dusting wallets, 5-minute volume by wash trading between wallets one person controls. They are exactly what a scanner looks at, which is exactly why they get manufactured. This adds score only on an affirmatively PASSED contract audit.</i>'
  );
  return lines;
}

/**
 * Jito tip detail — what was paid, over how many transactions, and what it does
 * and does not mean.
 *
 * The caveat is not boilerplate and is not optional. This is the only signal in
 * the alert that was BOUGHT rather than done: a tip is a payment to a public
 * address, so a well-funded rug pays exactly the same figure a real cabal does,
 * and has the same reason to. Printing "5.2 SOL" beside a conviction bonus with
 * nothing else said would invite the reading that money spent equals quality.
 */
function renderJitoTip(jitoTip) {
  if (!jitoTip?.detected) return [];

  const lines = [
    '',
    `<b>${esc(jitoTip.label)}</b>`,
    `• Paid across ${jitoTip.tippingTxs} of ${jitoTip.inspectedTxs} launch-window transaction(s)`,
  ];
  if (jitoTip.unknownTxs) {
    lines.push(
      `• <i>${jitoTip.unknownTxs} transaction(s) could not be read — the real total is at least this, never less.</i>`
    );
  }
  lines.push(
    jitoTip.qualifies
      ? `• Cabal Conviction: <b>+${jitoTip.scoreBoost}</b> (over the ${jitoTip.minTipSol} SOL floor)`
      : `• Under the ${jitoTip.minTipSol} SOL floor — no conviction points awarded`
  );
  lines.push(
    '<i>A tip buys ORDERING, not quality. It is the one signal here that is purchased outright rather than earned, and a developer rugging their own launch has the same reason to pay it — they want their buys sequenced ahead of yours. Read it as capital and intent, never as endorsement.</i>'
  );
  return lines;
}

/** Viral-volume detail. Shows the two measured figures, not just the banner. */
function renderMegaRunner(megaRunner) {
  if (!megaRunner?.detected) return [];
  return [
    '',
    '<b>MEGA-RUNNER VIRAL VOLUME:</b>',
    ...megaRunner.reasons.map((r) => `• ${esc(r)} `),
    '<i>Volume and buy/sell counts can both be manufactured — a wash trader cycling SOL between their own wallets produces this exact signature, deliberately, because it is what scanners look for.</i>',
  ];
}

export function buildMessage({ pair, demand, verdictInfo, smartMoney, deployer, security, tradeLink, reaudit, signalCategory, migration, clusters, cto, thresholds, megaRunner, megaRunnerHeader, news, social, sizerConfig, jitoTip, momentum, narrative, candidateSwarm }) {
  // Read off the verdict rather than re-derived: this is a rendering decision,
  // and the scorer is the only thing entitled to decide a gate was overridden.
  const insiderBypass = verdictInfo?.insiderBypass?.applied === true ? verdictInfo.insiderBypass : null;
  const symbol = pair.baseToken?.symbol ?? 'UNKNOWN';
  const address = pair.baseToken.address;
  const usd = (n) =>
    n === null || n === undefined || Number.isNaN(n)
      ? 'Unknown'
      : `$${Math.round(n).toLocaleString('en-US')}`;

  const smartLine = !smartMoney?.configured
    ? 'Watchlist not configured'
    : smartMoney.detected
      ? `${smartMoney.count} tracked wallet(s)${smartMoney.earlyBuyers ? ` — ${smartMoney.earlyBuyers} bought early` : ''}`
      : 'None detected';

  const devLine =
    deployer?.status === 'GOOD DEV'
      ? `Proven (${deployer.successfulLaunches} past $100k+ launches)`
      : deployer?.status === 'SERIAL RUGGER'
        ? '🔴 SERIAL RUGGER'
        : 'Unknown / new deployer';

  const ratio =
    demand.m5.sells > 0 ? (demand.m5.buys / demand.m5.sells).toFixed(1) : '∞';

  // Recommended size. Sits directly under the trade advice, because the two are
  // read together — "take profit at +50%" is not actionable without a size.
  const size = recommendSize({ score: verdictInfo.score, clusters, demand, config: sizerConfig ?? {} });
  const sizeLines = size
    ? [
        '',
        `<b>${esc(formatSizeLine(size))}</b>`,
        ...(size.thinPool
          ? [
              `<i>That is ${size.poolSharePct.toFixed(2)}% of the whole pool — expect slippage on entry AND on exit. The ladder keys on score only; it does not know pool depth, your bankroll or your open exposure.</i>`,
            ]
          : []),
      ]
    : [];

  return [
    ...alertHeaderLines({ signalCategory, clusters, smartMoney, megaRunner, megaRunnerHeader, news, social, insiderBypass, jitoTip, momentum, narrative, candidateSwarm }),
    `Token: <b>$${esc(symbol)}</b> (${esc(pair.chainId === 'solana' ? 'Solana' : pair.chainId)})`,
    `<i>Score ${verdictInfo.score}/100</i>${clusters?.label ? ` | <b>${esc(clusters.label)}</b>` : ''}`,
    // Placed above the advice: if the buy button is locked, the trading advice
    // is not actionable yet and the reader needs to know that first.
    ...(migration?.label
      ? ['', `<b>${esc(migration.label)}</b>`, `<i>${esc(migration.detail)}</i>`]
      : []),
    ...(signalCategory?.advice ? ['', `<b>${esc(signalCategory.advice)}</b>`] : []),
    ...sizeLines,
    ...renderNewsAndSocial(news, social),
    ...renderCandidateSwarm(candidateSwarm, sizerConfig ?? {}),
    ...renderMomentum(momentum),
    ...renderNarrative(narrative),
    ...renderJitoTip(jitoTip),
    ...renderMegaRunner(megaRunner),
    ...renderCto(cto),
    // sizerConfig is the whole config object, despite the name — it is what
    // buildMessage is already handed and what carries telegram.walletProfiles.
    ...renderClusters(clusters, sizerConfig ?? {}),
    ...renderWhales(smartMoney, sizerConfig ?? {}),
    ...renderShield(
      evaluateSecurityShield({
        security,
        demand,
        thresholds: thresholds ?? {},
        cto,
        holderFloorOverride: verdictInfo?.holderGate?.floor ?? null,
        // `allowed` because the shield re-tests the gates itself; `applied`
        // above is the scorer's record that a gate actually needed overriding.
        insiderBypass: insiderBypass ? { ...insiderBypass, allowed: true } : null,
      })
    ),
    '',
    '<b>SAFETY &amp; DENSITY AUDIT:</b>',
    ...(signalCategory?.insiderRequirements
      ? [
          `• Insider Tier Gate: ${signalCategory.insiderRequirements.checks.filter((c) => c.passed).length}/${signalCategory.insiderRequirements.checks.length} mandatory requirements met ${signalCategory.insiderRequirements.passed ? '' : ''}`,
        ]
      : []),
    `• Holders: ${security?.totalHolders ?? '?'} Wallets (${verdictInfo.holderGate?.passed ? `Passed ${verdictInfo.holderGate.floor}+ Floor ` : 'Floor NOT passed '})`,
    // Cap read from the live thresholds, not hardcoded. It used to say 25 while
    // the configured cap was 20, which put two different numbers for the same
    // limit in one message once the shield block began printing alongside it.
    `• Top 10 Concentration: ${security?.top10Pct === null || security?.top10Pct === undefined ? '?' : `${security.top10Pct.toFixed(1)}%`}${reaudit?.ran ? ` (re-checked live: ${reaudit.now?.toFixed(1)}%, cap ${reaudit.cap}% )` : ` (cap ${esc(String(concentrationCapFor(demand?.ageHours ?? null, thresholds ?? {}, tractionFrom(security, demand)).cap))}% )`}`,
    `• Holder Data: ${security?.distributionSource === 'rpc-live' ? 'live on-chain ' : 'cached indexer '}${reaudit?.ran ? '' : reaudit?.reason ? ` · re-audit skipped (${esc(String(reaudit.reason).slice(0, 60))})` : ''}`,
    `• Security Status: ${verdictInfo.securityStatus === 'PASSED' ? 'PASSED ALL AUDITS ' : esc(verdictInfo.securityStatus ?? '?')}`,
    `• Deployer: ${esc(devLine)}`,
    '',
    '<b>MARKET:</b>',
    `• Market Cap: ${usd(demand.marketCap)} | Liquidity: ${usd(demand.liquidityUsd)} (${demand.liqToMcapPct.toFixed(0)}%)`,
    `• 5m Buys/Sells: ${demand.m5.buys} / ${demand.m5.sells} (${ratio}x)`,
    `• Smart Money: ${esc(smartLine)}`,
    '',
    `<code>${esc(address)}</code>`,
    '',
    ...executionLinks(address, pair.chainId, tradeLink, size),
    `<a href="https://dexscreener.com/${esc(pair.chainId)}/${esc(address)}">DexScreener</a>`,
    // Token contract on Solscan — distinct from the wallet links above, which
    // point at /account/. This is /token/ and resolves the mint itself.
    ...(pair.chainId === 'solana'
      ? [`<a href="https://solscan.io/token/${esc(address)}">Solscan Token</a>`]
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
  'BUY SIGNAL': '',
  'CRASH WARNING': '🔴',
  'SCAM/AVOID': '',
  WATCH: '',
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
    `<b>Aegis Scan</b> — ${when} UTC`,
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
        if (r.smartMoney) extras.push(`x${r.smartMoney}`);
        if (r.category === 'COMMUNITY TAKEOVER GEM') extras.push('CTO');
        else if (r.category === 'ESTABLISHED INSIDER GEM') extras.push('INSIDER-GEM');
        else if (r.category === 'EARLY-STAGE INSIDER SCALP') extras.push('INSIDER-SCALP');
        else if (r.category === 'LONG-TERM GEM') extras.push('GEM');
        else if (r.category === 'FAST SCALP') extras.push('SCALP');
        if (r.devStatus === 'GOOD DEV') extras.push('dev');
        lines.push(`${head} — ${esc(extras.join(' · '))}`);

        // Dedicated smart-money callout beneath the token line. Only reached on
        // WATCH / BUY SIGNAL rows: a SCAM/AVOID token never shows whale detail,
        // because surfacing it there is precisely the trick the safety override
        // exists to defeat.
        for (const m of r.smartMoneyDetail ?? []) {
          lines.push(`  ↳ ${formatSmartMoneyLine(m, { html: true })}`);
        }

        if (verdict === 'BUY SIGNAL') {
          lines.push(`     <a href="${esc(tradeUrl(r.address, tradeLink, r.chain))}">Trade</a> · <code>${esc(r.address)}</code>`);
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
 * Interactive commands
 * ------------------------------------------------------------------ *
 *
 * A long-poll bot so Aegis can be queried on demand: /audit, /insiders,
 * /status, /help.
 *
 * ── AUTHORISATION ──────────────────────────────────────────────────────────
 * A Telegram bot answers ANYONE who finds it. Its username is discoverable and
 * the token appears in any config you paste somewhere. Without a check, a
 * stranger could make this run scans against your RPC quota and read back your
 * open positions.
 *
 * So every update is matched against the configured TELEGRAM_CHAT_ID and
 * silently ignored otherwise — silently on purpose, since replying "not
 * authorised" confirms the bot is live and worth probing.
 *
 * ── SIDE EFFECTS ───────────────────────────────────────────────────────────
 * /audit answers a QUESTION. It runs the analysis through auditOnce(), which
 * writes no note, opens no position and fires no alert. Asking about a token
 * must never be a way to accidentally enter one.
 */

const HELP_TEXT = [
  '<b>AEGIS COMMANDS</b>',
  '',
  '<code>/status</code> — scan speed, ledger size, blacklist, open trades, live floors',
  '<code>/audit &lt;contract&gt;</code> — security, holder distribution and insider score for one token',
  '<code>/insiders &lt;contract&gt;</code> — cluster, funder network and bundle detail',
  '<code>/whales</code> — the elite watchlist, with win rates and their sample sizes',
  '<code>/help</code> — this message',
  '',
  '<i>Every command is read-only. None of them writes a note, opens a position or sends a buy alert — asking about a token must never be a way to accidentally enter one.</i>',
].join('\n');

/** Split "/cmd@botname arg1 arg2" into a command and its arguments. */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...args] = trimmed.split(/\s+/);
  // Group chats append @botname to commands.
  const command = head.slice(1).split('@')[0].toLowerCase();
  return command ? { command, args } : null;
}

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Live scan cadence, read from the heartbeat loop.mjs writes each tick.
 *
 * A speed figure is only meaningful next to a liveness one: "42s per tick" from
 * a scanner that stopped six hours ago is a worse answer than no answer, since
 * it reads as confirmation that everything is running. So staleness is computed
 * against the configured interval and stated first when the loop looks dead.
 *
 * The heartbeat is a separate file rather than a field on an existing one
 * because the bot and the loop are different processes; the loop owns it and
 * the bot only ever reads it.
 */
function scanSpeedLines(heartbeat, config) {
  if (!heartbeat?.lastTickAt) {
    return ['• Scan speed: <i>no heartbeat on file — the scan loop has not run yet</i>'];
  }

  const sinceSec = (Date.now() - heartbeat.lastTickAt) / 1000;
  const interval = config?.realtime?.intervalSeconds ?? 30;
  // Four missed intervals, floored at two minutes. A single slow tick is normal
  // (a full pass measures 40-195s against a 30s target); four in a row is not.
  const staleAfter = Math.max(120, interval * 4);
  const live = sinceSec <= staleAfter;

  const ago =
    sinceSec < 90
      ? `${Math.round(sinceSec)}s ago`
      : sinceSec < 5400
        ? `${Math.round(sinceSec / 60)}m ago`
        : `${(sinceSec / 3600).toFixed(1)}h ago`;

  const avg = heartbeat.rollingAvgSec;
  const speed =
    typeof avg === 'number'
      ? `<b>${avg.toFixed(0)}s</b>/tick avg over ${heartbeat.samples ?? '?'} tick(s)` +
        (typeof heartbeat.lastDurationSec === 'number'
          ? `, last ${heartbeat.lastDurationSec.toFixed(0)}s`
          : '')
      : '<i>not yet measured</i>';

  return [
    `• Scanner: ${live ? `<b>LIVE</b> — last tick ${ago}` : `<b>STALE</b> — last tick ${ago}, expected every ~${interval}s`}`,
    `• Scan speed: ${speed} (target ${interval}s)`,
    ...(typeof heartbeat.tick === 'number'
      ? [
          `• Ticks this run: <b>${heartbeat.tick.toLocaleString('en-US')}</b>` +
            (heartbeat.skipped ? ` · ${heartbeat.skipped} skipped while busy` : ''),
        ]
      : []),
    ...(live
      ? []
      : ['<i>A stale heartbeat means loop.mjs is not running. Nothing below is being updated.</i>']),
  ];
}

function statusReport({ config, positions, watchlist, observations, alertLog, heartbeat = null, blacklist = null }) {
  const open = Object.values(positions?.positions ?? {}).filter((p) => p.status === 'OPEN');
  const wallets = Object.keys(observations?.wallets ?? {}).length;
  const alertCount = Object.keys(alertLog ?? {}).length;
  const recent = Object.values(alertLog ?? {})
    .sort((a, b) => b.sentAt - a.sentAt)
    .slice(0, 3);

  const lines = [
    '<b>AEGIS STATUS</b>',
    '',
    ...scanSpeedLines(heartbeat, config),
    '',
    `• Open positions: <b>${open.length}</b>`,
  ];
  for (const p of open.slice(0, 5)) {
    const age = ((Date.now() - p.alertedAt) / 3600000).toFixed(1);
    lines.push(
      `   ↳ $${esc(p.symbol)} — entry ${usdShort(p.entryMarketCap)}, peak ${usdShort(p.peakMarketCap)}, ${age}h, fired [${esc(p.firedTriggers.join(',') || 'none')}]`
    );
  }
  if (open.length > 5) lines.push(`   ↳ <i>… and ${open.length - 5} more</i>`);
  lines.push(
    `• Elite watchlist: <b>${watchlist?.entries?.length ?? watchlist?.index?.size ?? 0}</b> wallet(s)`,
    `• Observation ledger: <b>${wallets.toLocaleString('en-US')}</b> wallet(s)`,
    // Deployers and mints are counted separately because they are different
    // kinds of address — see blacklist.mjs on why merging them is worse than
    // having no blacklist at all.
    `• Blacklisted: <b>${(blacklist?.wallets?.size ?? 0).toLocaleString('en-US')}</b> deployer(s), <b>${blacklist?.mints?.size ?? 0}</b> mint(s)`,
    `• Alerts on record: <b>${alertCount}</b>`,
    '',
    '<b>Active floors</b>',
    `• Alert score floor: ${config.telegram?.insiderMinScore ?? '?'}`,
    `• Top-10 cap: ${config.thresholds?.maxTop10Pct ?? '?'}% (up to ${config.thresholds?.dynamicConcentration?.maxTop10Pct ?? '?'}% on proven traction)`,
    `• Liquidity depth: ${config.thresholds?.minLiqToMcapPct ?? '?'}% of MCap`,
    `• Holder floor: ${config.thresholds?.minUniqueHolders ?? '?'}`,
    `• Early-scalp cluster: ≥${config.signalCategories?.insiderEarly?.minInsiderWallets ?? 1} wallet(s)`,
  );
  if (recent.length) {
    lines.push('', '<b>Last alerts</b>');
    for (const r of recent) {
      lines.push(`• $${esc(r.symbol)} — ${r.score}/100, ${((Date.now() - r.sentAt) / 3600000).toFixed(1)}h ago`);
    }
  }
  return lines.join('\n');
}

/**
 * The elite watchlist, as it stands right now.
 *
 * ── WHY EVERY NUMBER HERE CARRIES A SAMPLE SIZE ─────────────────────────────
 * A win rate without its denominator is the single most misleading figure this
 * bot could print. smart_wallets.json is written by auto_top_whales.mjs at
 * minGradedBuys=3 against a 75% bar, which means the top of the list is
 * mathematically forced to read "100% WR" — a wallet with exactly 3 graded buys
 * must be 3/3, because 2/3 is 66.7% and fails the rule. Ten wallets all showing
 * 100% is a property of the threshold, not evidence that ten wallets are
 * flawless. So the graded-buy count is printed beside every rate, never behind
 * a tap, and the caveat below is not optional.
 *
 * The rates are also AEGIS-OBSERVED — the tokens this scanner happened to scan,
 * graded by its own post-mortem — not the wallets' market-wide records, and the
 * sample skews optimistic because buyer replay only reads tokens with a live
 * pool. Realized P&L is not derivable from observation at all. GMGN and Birdeye
 * sell the real figures and are gated (403/401), so each row links out rather
 * than inventing them.
 */
function whalesReport(whales, config = {}) {
  const entries = (whales?.wallets ?? []).filter(
    (w) => w?.address && w.enabled !== false && !String(w.address).startsWith('EXAMPLE_')
  );

  if (!entries.length) {
    return [
      '<b>TOP ELITE WHALES</b>',
      '',
      '<i>The watchlist is empty. auto_top_whales.mjs writes it from Aegis’s own graded observations once wallets clear the configured win-rate and sample-size rules, or you can seed it with</i> <code>node auto_top_whales.mjs --import &lt;leaderboard.csv&gt;</code><i>.</i>',
    ].join('\n');
  }

  const gen = whales.generated ?? {};
  const built = gen.at ? (Date.now() - Date.parse(gen.at)) / 3600000 : null;

  const lines = [
    '<b>TOP ELITE WHALES</b>',
    `<i>${entries.length} wallet(s)` +
      (built !== null && Number.isFinite(built) ? ` · list rebuilt ${built < 1 ? `${Math.round(built * 60)}m` : `${built.toFixed(1)}h`} ago` : '') +
      (gen.source ? ` · ${esc(gen.source)}` : '') +
      '</i>',
    '',
  ];

  const CAVEAT =
    '<i>READ THE SAMPLE SIZE. These rates are computed over Aegis-observed buys only — not the wallets’ market-wide records — and the list is selected at a 75% bar over as few as 3 graded buys, which forces the top entries to read 100%. That is the threshold, not proof of edge. Estimated P&amp;L assumes the wallet still holds; Aegis never observes exits. Tap GMGN or Birdeye for real lifetime figures.</i>';

  // Rows are fitted to a CHARACTER BUDGET rather than a fixed count, and the
  // caveat's cost is reserved before the first row is added.
  //
  // A fixed cap is the obvious implementation and it is wrong here: each row
  // carries three full 44-character addresses inside three URLs, so twelve rows
  // is already ~4.3k and lands in the generic truncation guard — which cuts
  // mid-anchor, leaving a dangling <a href= and stripping the sample-size
  // caveat, the one part of this report that must never be the thing that gets
  // dropped. Budgeting means the cap moves with the content instead of being a
  // number that happened to fit when it was written.
  const overheadLine = '\n<i>… and 999 more in smart_wallets.json</i>';
  let budget = TELEGRAM_MAX_CHARS - lines.join('\n').length - CAVEAT.length - overheadLine.length - 8;

  let shown = 0;
  for (const w of entries) {
    const short = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
    const graded = w.graded_buys ?? w.trades ?? null;
    const bits = [
      w.win_rate ? `<b>${esc(String(w.win_rate))}</b> win rate` : null,
      graded !== null ? `${esc(String(graded))} graded buy(s)` : null,
      w.net_profit_usd ? `${esc(String(w.net_profit_usd))} P&amp;L` : null,
      w.onchain_signatures ? `${esc(String(w.onchain_signatures))} sigs` : null,
    ].filter(Boolean);

    const row = [
      `${shown + 1}. <code>${esc(short)}</code> — ${bits.join(' · ') || '<i>no stats on file</i>'}`,
      // Indented so the links read as belonging to the wallet above them and
      // sit as their own tap targets rather than running into the stats line.
      `    ${renderProfileLinks(w.address, config)}`,
    ];

    const cost = row.join('\n').length + 1;
    // Always render at least one wallet: a report that lists nobody because the
    // first row was slightly over budget is worse than a slightly long message.
    if (cost > budget && shown > 0) break;
    budget -= cost;
    lines.push(...row);
    shown++;
  }

  if (entries.length > shown) {
    lines.push('', `<i>… and ${entries.length - shown} more in smart_wallets.json</i>`);
  }
  lines.push('', CAVEAT);

  return lines.join('\n');
}

function auditReport({ pair, result }) {
  const { verdictInfo, demand, security, audit, signalCategory, clusters, cto, megaRunner } = result;
  const usd = (n) => (n === null || n === undefined ? '?' : `$${Math.round(n).toLocaleString('en-US')}`);

  const lines = [
    `<b>AUDIT: $${esc(pair.baseToken?.symbol ?? '?')}</b>`,
    `<i>${esc(verdictInfo.verdict)} · ${verdictInfo.score}/100 · security ${esc(audit.status)}</i>`,
  ];
  if (signalCategory?.category && signalCategory.category !== 'UNCLASSIFIED') {
    lines.push(`<b>${esc(signalCategory.label ?? signalCategory.category)}</b>`);
  } else if (signalCategory?.reason) {
    lines.push(`<i>Unclassified — ${esc(signalCategory.reason)}</i>`);
  }

  lines.push(
    '',
    '<b>MARKET</b>',
    `• MCap ${usd(demand.marketCap)} · Liquidity ${usd(demand.liquidityUsd)} (${demand.liqToMcapPct.toFixed(0)}%)`,
    `• 5m ${demand.m5.buys}/${demand.m5.sells} · 1h vol ${usd(demand.volume.h1)}`,
    `• Holders ${security?.totalHolders ?? '?'} · Top10 ${security?.top10Pct === null || security?.top10Pct === undefined ? '?' : `${security.top10Pct.toFixed(1)}%`}`,
    ...(demand.ageHours === null ? [] : [`• Age ${demand.ageHours.toFixed(1)}h`])
  );

  if (verdictInfo.safetyGateFailed) {
    lines.push('', `<b>BLOCKED:</b> ${esc(verdictInfo.safetyGateReason ?? 'safety gate')}`);
  }
  if (audit.failures?.length) {
    lines.push('', '<b>Failed checks</b>');
    for (const f of audit.failures.slice(0, 4)) lines.push(`• ${esc(f)}`);
  }
  if (audit.unknowns?.length) {
    lines.push('', '<b>Unverified</b>');
    for (const u of audit.unknowns.slice(0, 3)) lines.push(`• ${esc(u)}`);
  }

  // Insider score, asked for by name. The top matched wallet's alpha points, or
  // an explicit "unscored" — a wallet Aegis has no ledger history for is not a
  // zero, and printing 0 would read as a judgement rather than as no data.
  if (clusters?.detected) {
    const top = topInsiderScore({ clusters, smartMoney: result.smartMoney });
    const floor = result.insiderBypassFloor ?? null;
    lines.push(
      '',
      '<b>INSIDERS</b>',
      `• ${esc(clusters.label ?? 'activity detected')} — ${clusters.insiderCount ?? 0} distinct wallet(s)`,
      top
        ? `• Top insider score: <b>${esc(String(top.score))}</b>` +
          (top.wallet ? ` (<code>${esc(`${top.wallet.slice(0, 6)}…${top.wallet.slice(-4)}`)}</code>)` : '') +
          (floor !== null ? ` · bypass floor ${esc(String(floor))}` : '')
        : '• Top insider score: <i>none of the matched wallets carries a score</i>',
      ...(verdictInfo.insiderBypass?.applied
        ? [`• 🔴 <b>Shield bypassed</b> — waived: ${esc(verdictInfo.insiderBypass.gates.join(', '))}`]
        : []),
    );
  }

  const flags = [
    cto?.detected ? 'community takeover' : null,
    megaRunner?.detected ? 'mega-runner volume' : null,
  ].filter(Boolean);
  if (flags.length) lines.push('', `${esc(flags.join(' · '))}`);

  lines.push(
    '',
    `<code>${esc(pair.baseToken.address)}</code>`,
    `<a href="https://dexscreener.com/${esc(pair.chainId)}/${esc(pair.baseToken.address)}">DexScreener</a>`
  );
  return lines.join('\n');
}

function insiderReport({ pair, result }) {
  const c = result.clusters;
  const head = `<b>INSIDERS: $${esc(pair.baseToken?.symbol ?? '?')}</b>`;
  if (!c?.detected) {
    return [head, '', '<i>No cluster, funder network, oversized buy or same-slot bundle found.</i>',
      c?.buyersSeen ? `<i>${c.buyersSeen} buyer(s) replayed.</i>` : '',
      c?.skippedFunderTrace ? `<i>Funder trace skipped — ${esc(c.skippedFunderTrace)}.</i>` : '',
    ].filter(Boolean).join('\n');
  }

  const lines = [head, `<b>${esc(c.label ?? 'INSIDER ACTIVITY')}</b> — ${c.insiderCount ?? 0} distinct wallet(s)`];
  if (c.clusterBuying) lines.push(`• ${c.clusterBuying.size} wallets bought within ${c.clusterBuying.windowSec}s of launch`);
  if (c.jito?.detected) lines.push(`• ${esc(c.jito.detail)}`);
  for (const n of (c.networks ?? []).slice(0, 2)) {
    lines.push(`• Funder: ${n.size} wallets from <a href="${esc(n.funderSolscan)}">${esc(n.funderShort)}</a>`);
  }
  for (const o of (c.oversized ?? []).slice(0, 2)) {
    lines.push(`• ${esc(o.short)} — ${esc(o.reason)}`);
  }

  const members = (c.uniqueInsiders ?? c.watchlisted ?? []).slice(0, 5);
  if (members.length) {
    lines.push('', '<b>Wallets</b>');
    members.forEach((m, i) => {
      const spend = m.solSpent !== null && m.solSpent !== undefined ? `${m.solSpent.toFixed(2)} SOL` : 'spend n/a';
      lines.push(`${i + 1}. <a href="${esc(m.solscan)}">${esc(m.short)}</a> — ${esc(spend)}`);
      for (const row of scorecardLines(m.scorecard)) lines.push(row);
    });
  }
  lines.push('', '<i>Coordination signal, not proof of insider knowledge.</i>');
  return lines.join('\n');
}

/**
 * Execute one command and return the HTML reply.
 *
 * Pure dispatch plus IO — separated from the polling loop so it can be tested
 * without a network, and so a thrown error inside a handler cannot kill the
 * poller.
 */
export async function handleCommand({ command, args, deps = {} }) {
  const loaders = deps;
  switch (command) {
    case 'help':
    case 'start':
      return HELP_TEXT;

    // Each handler checks its own loader is present. runCommandBot does catch a
    // throw, but "Command failed: loaders.loadStatus is not a function" is a
    // stack trace wearing a reply's clothes — it tells you nothing about which
    // part of the bot was started wrong.
    case 'status': {
      if (!loaders.loadStatus) return 'The status loader is not wired up on this bot.';
      return statusReport(await loaders.loadStatus());
    }

    // Deliberately NOT served from loadStatus: that loader reads the 16 MB
    // observation ledger, and answering "who is on the watchlist" should not
    // cost a full state load.
    case 'whales': {
      if (!loaders.loadWhales) return 'The watchlist loader is not wired up on this bot.';
      // The config is loaded so the profile roster is the configured one rather
      // than the built-in default. Optional: a bot wired without it still works.
      return whalesReport(await loaders.loadWhales(), (await loaders.loadConfig?.()) ?? {});
    }

    case 'audit':
    case 'insiders': {
      const address = args[0];
      if (!address) return `Usage: <code>/${command} &lt;contract address&gt;</code>`;
      if (!MINT_RE.test(address)) return 'That does not look like a Solana contract address.';
      if (!loaders.auditOnce) return 'The audit pipeline is not wired up on this bot.';
      const res = await loaders.auditOnce(address);
      if (!res.ok) return `${esc(res.error)}`;
      return command === 'audit' ? auditReport(res) : insiderReport(res);
    }

    default:
      return `Unknown command <code>/${esc(command)}</code>. Try /help`;
  }
}

/**
 * Long-poll loop. Runs until stopped; every iteration is individually guarded
 * so one bad update or a transient network failure cannot end the session.
 */
export async function runCommandBot({ credentials, deps, log = console.log, signal } = {}) {
  if (!credentials?.botToken || !credentials?.chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID must both be set');
  }
  const api = `https://api.telegram.org/bot${credentials.botToken}`;
  const authorised = String(credentials.chatId);
  let offset = 0;

  log(`Aegis command bot listening (authorised chat ${authorised}). /help for commands.`);

  while (!signal?.aborted) {
    try {
      const res = await fetch(`${api}/getUpdates?timeout=30&offset=${offset}`, {
        signal: AbortSignal.timeout(45000),
      });
      const body = await res.json().catch(() => ({}));
      for (const update of body.result ?? []) {
        offset = update.update_id + 1;
        const msg = update.message ?? update.channel_post;
        if (!msg?.text) continue;

        // Silently ignored rather than refused: a "not authorised" reply
        // confirms the bot is live to anyone probing it.
        if (String(msg.chat?.id) !== authorised) continue;

        const parsed = parseCommand(msg.text);
        if (!parsed) continue;

        let reply;
        try {
          reply = await handleCommand({ ...parsed, deps });
        } catch (err) {
          reply = `${esc(`Command failed: ${err.message}`.slice(0, 300))}`;
        }
        await sendTelegram({ ...credentials, text: reply });
        log(`   ↳ /${parsed.command} ${parsed.args.join(' ')}`.trim());
      }
    } catch (err) {
      // Long-poll timeouts are normal and expected; anything else gets a
      // short backoff rather than taking the bot down.
      if (!/abort|timeout|fetch failed/i.test(err.message)) {
        log(`   poll error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
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

  // ---- High-conviction insider bypass, re-checked at dispatch ------
  //
  // The scorer already decided this; the bypass is re-derived here from config
  // and the live cluster roster rather than trusted from the verdict, for the
  // same reason the safety block above is checked twice. THREE things must all
  // hold before a failed audit is allowed to send:
  //   1. the scorer recorded a bypass,
  //   2. config + the matched insiders still authorise one right now,
  //   3. every failing audit row is one of the two the override covers.
  // Any of the three missing and the alert is blocked exactly as before.
  //
  // UNVERIFIED never reaches this path: auditFailuresAreBypassable requires at
  // least one FAILED row, and an audit that only has unknowns has none. Missing
  // provider data is not something an insider score is allowed to vouch for.
  // ---- Ultra-high-conviction candidate swarm filter ----------------
  //
  // Placed with the hard blocks, above every tier and score gate, because it is
  // a NOTIFICATION policy rather than a safety one: it decides whether a token
  // is worth interrupting for, not whether it is safe. A token blocked here is
  // fully analysed and its buys are already in wallet_observations.json — the
  // ledger keeps growing on single and small-cluster buys, which is what makes
  // tomorrow's pool bigger. Only the notification is withheld.
  //
  // Re-derived here from the swarm object rather than trusted as a boolean, so
  // the threshold in config is the one thing that decides it.
  const swarmGate = evaluateCandidateSwarm({ swarm: result.candidateSwarm, config });
  if (swarmGate.enforced && !swarmGate.passed) {
    return { status: 'below-candidate-swarm', reason: swarmGate.detail };
  }

  if (audit.status !== 'PASSED') {
    const dispatchBypass = resolveInsiderBypass({
      clusters: result.clusters,
      smartMoney,
      config,
    });
    const bypassOk =
      verdictInfo.insiderBypass?.applied === true &&
      dispatchBypass.allowed === true &&
      auditFailuresAreBypassable(audit);
    if (!bypassOk) {
      return {
        status: 'blocked-audit-not-passed',
        reason: verdictInfo.insiderBypass?.applied ? dispatchBypass.reason : undefined,
      };
    }
  }

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
    news: result.news,
    social: result.social,
    sizerConfig: config,
    jitoTip: result.jitoTip,
    momentum: result.momentum,
    narrative: result.narrative,
    candidateSwarm: result.candidateSwarm,
  });

  const sent = await sendTelegram({ ...credentials, text });
  if (sent.ok) {
    alertLog[key] = { sentAt: now, symbol: pair.baseToken.symbol, score: verdictInfo.score };
    return { status: 'sent', reaudit };
  }
  return { status: 'failed', error: sent.error };
}

/* ------------------------------------------------------------------ *
 * CLI — node telegram.mjs --bot
 * ------------------------------------------------------------------ *
 *
 * Kept as an alias so the documented command still works, but the wiring now
 * lives in bot.mjs and there is exactly one copy of it. Two copies of the
 * loader set is how /whales ends up reading a different file from /status, and
 * two copies of the startup path is how one of them quietly loses the
 * authorisation check.
 *
 * Imported dynamically because bot.mjs imports THIS module; at CLI time the
 * cycle is already resolved, which is the same reason auditOnce is deferred.
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!process.argv.includes('--bot')) {
    console.log('Usage: node bot.mjs                 (starts the interactive command assistant)');
    console.log('       node bot.mjs --once /status  (run one command locally and exit)');
    process.exit(0);
  }

  const HERE = dirname(fileURLToPath(import.meta.url));
  const credentials = await loadEnv(join(HERE, '.env'));
  const { buildDeps } = await import('./bot.mjs');

  const controller = new AbortController();
  const shutdown = () => {
    console.log('\nCommand bot stopped.');
    controller.abort();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await runCommandBot({ credentials, deps: buildDeps(), signal: controller.signal });
}
