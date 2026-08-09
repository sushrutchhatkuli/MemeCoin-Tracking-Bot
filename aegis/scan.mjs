#!/usr/bin/env node
/**
 * Aegis-Crypto scanner.
 *
 *   node scan.mjs                          discover + analyse live launches
 *   node scan.mjs --token <address>        deep-dive a single token
 *   node scan.mjs --chain solana --limit 15
 *   node scan.mjs --all                    write notes for every candidate,
 *                                          not just actionable ones
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import {
  discoverCandidates,
  fetchPairsBatch,
  fetchSinglePair,
  fetchSecurity,
  sleep,
} from './sources.mjs';
import {
  runSecurityAudit,
  applyDeployerVerdict,
  analyzeDemand,
  detectCatalysts,
  scoreToken,
  classifySignal,
  evaluateCommunityTakeover,
  applyCtoOverride,
  detectMegaRunner,
  resolveInsiderBypass,
  tractionFrom,
} from './audit.mjs';
import { renderNote, noteFilename } from './note.mjs';
import { loadState, saveState, computeVelocity, recordSnapshot } from './state.mjs';
import {
  loadWatchlist,
  matchSmartMoney,
  fetchRecentBuyers,
  SYSTEM_ACCOUNTS,
} from './smart_money.mjs';
import {
  auditDeployer,
  loadDeployerCache,
  saveDeployerCache,
  harvestLaunchFeed,
  DEV_STATUS,
} from './dev_audit.mjs';
import {
  loadEnv,
  loadAlertLog,
  saveAlertLog,
  maybeAlert,
  sendTelegram,
  buildMessage,
  buildDigest,
} from './telegram.mjs';
import { analyzeSocials, socialBadge } from './social_scanner.mjs';
import { migrationStatus, MIGRATION } from './migration.mjs';
import { detectInsiderClusters, clusterScoreBonus } from './insider_cluster.mjs';
import { discoverNetwork, loadDiscovered, saveDiscovered, walletLinks } from './network_discovery.mjs';
import { fetchBreakingNews, matchTokenToNews } from './news_sentinel.mjs';
import { fetchTrending, scoreSocialHype } from './social_tracer.mjs';
import { loadSurfaced, surfacedFreshness } from './discovery_daemon.mjs';
import { maybeNotifyQuota, currentQuotaEvents } from './quota_sentinel.mjs';
import {
  loadObservations,
  saveObservations,
  recordBuys,
  pruneObservations,
  walletScorecard,
} from './wallet_observations.mjs';
import { loadBlacklist, checkBlacklist } from './blacklist.mjs';
import {
  loadPositions,
  savePositions,
  openPosition,
  walletTokenBalance,
} from './sell_notifier.mjs';

/**
 * Environment overrides, so a cloud deploy can be reconfigured from the Render
 * dashboard without editing config.json and redeploying.
 */
function applyEnvOverrides(config) {
  const num = (v) => (v === undefined || v === '' ? null : Number(v));
  const bool = (v) =>
    v === undefined || v === '' ? null : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

  if (process.env.VAULT_PATH) config.vaultPath = process.env.VAULT_PATH;
  if (process.env.SOLANA_RPC_URL) config.rpcUrl = process.env.SOLANA_RPC_URL;

  const minScore = num(process.env.TELEGRAM_MIN_SCORE);
  if (minScore !== null && !Number.isNaN(minScore)) config.telegram.minScore = minScore;

  const cooldown = num(process.env.TELEGRAM_COOLDOWN_HOURS);
  if (cooldown !== null && !Number.isNaN(cooldown)) config.telegram.cooldownHours = cooldown;

  const digest = bool(process.env.TELEGRAM_SEND_DIGEST);
  if (digest !== null) config.telegram.sendScanDigest = digest;

  const limit = num(process.env.SCAN_LIMIT);
  if (limit !== null && !Number.isNaN(limit)) config.maxTokensPerScan = limit;

  const writeNotes = bool(process.env.WRITE_NOTES);
  if (writeNotes !== null) config.writeNotes = writeNotes;

  return config;
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const args = { all: false, limit: null, token: null, chain: null, testTelegram: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--token') args.token = argv[++i];
    else if (a === '--chain') args.chain = argv[++i];
    else if (a === '--test-telegram') args.testTelegram = true;
  }
  return args;
}

/** Send a sample alert so credentials can be verified without waiting for a signal. */
async function testTelegram(config) {
  const credentials = await loadEnv(join(HERE, '.env'));
  if (!credentials.botToken || !credentials.chatId) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing.');
    console.error('   Copy aegis/.env.example to aegis/.env and fill both values.');
    process.exit(1);
  }

  // The ONLY placeholder token in the codebase, and it is unreachable from a
  // real scan — this function runs solely under `--test-telegram`. Labelled
  // explicitly so a delivered sample can never be mistaken for a live signal.
  // Every other alert builds its links from the scanned pair's own mint.
  const text = buildMessage({
    pair: {
      chainId: 'solana',
      baseToken: {
        symbol: 'SAMPLE-NOT-A-REAL-SIGNAL',
        // Wrapped SOL, used purely so the links resolve to something valid.
        address: 'So11111111111111111111111111111111111111112',
      },
    },
    demand: {
      marketCap: 65000,
      liquidityUsd: 15000,
      liqToMcapPct: 23.1,
      m5: { buys: 150, sells: 20 },
    },
    verdictInfo: { score: 88, securityStatus: 'PASSED' },
    smartMoney: { configured: true, detected: true, count: 2, earlyBuyers: 1 },
    deployer: { status: 'GOOD DEV', successfulLaunches: 2 },
    security: { totalHolders: 250 },
  });

  const res = await sendTelegram({ ...credentials, text });
  console.log(res.ok ? 'Test alert delivered.' : `Telegram rejected it: ${res.error}`);
  process.exit(res.ok ? 0 : 1);
}

/**
 * ASCII status tags. Fixed width so the verdict column stays aligned when the
 * output is piped to a file or read in a terminal without emoji support —
 * which was half the reason for removing them.
 *
 * 🔴 is retained on the two states that mean "money is at risk right now":
 * a crashing token and a blocked alert. It is the only glyph left, so it
 * carries signal instead of decoration.
 */
const VERDICT_ICON = {
  'BUY SIGNAL': '[BUY]  ',
  'CRASH WARNING': '🔴[CRASH]',
  'SCAM/AVOID': '[SCAM] ',
  WATCH: '[WATCH]',
};

/**
 * Cheap pre-filter run before any security call. Deliberately does NOT test
 * liquidity: bonding-curve pairs omit DexScreener's `liquidity` field entirely,
 * and rejecting on it here would discard the newest launches. Liquidity is
 * checked in `passesDepthFilter` once the security provider has supplied the
 * real pool total.
 */
function passesFilters(pair, filters) {
  const mcap = pair.marketCap ?? pair.fdv ?? 0;
  const txns24 = (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0);
  const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3.6e6 : 0;

  if (mcap < filters.minMarketCapUsd || mcap > filters.maxMarketCapUsd) return 'market cap out of range';
  if (txns24 < filters.minTxns24h) return 'too few 24h transactions';
  if (ageHours > filters.maxAgeHours) return 'pair older than scan window';
  return null;
}

function passesDepthFilter(demand, filters) {
  if (demand.liquidityUsd < filters.minLiquidityUsd) {
    return `liquidity $${Math.round(demand.liquidityUsd).toLocaleString('en-US')} below floor`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Audit cooldown shield
 * ------------------------------------------------------------------ *
 *
 * Discovery surfaces ~130 candidates a tick and the scan audits 6-10 of them,
 * sorted by 1h volume. That sort is stable across ticks, so without a cooldown
 * the same handful of high-volume tokens is re-audited every ~50 seconds while
 * the other ~120 are never looked at once. The cooldown rotates the window.
 *
 * ── WHAT THIS COSTS, stated plainly ─────────────────────────────────────────
 * A token audited at 60/100 that turns into a 90 two minutes later will not be
 * re-scored for up to 10 minutes, so its alert is delayed by that much. That is
 * the trade: responsiveness on tokens already seen, in exchange for coverage of
 * tokens never seen. It is worth taking here only because the never-seen pile
 * is roughly twelve times larger than the seen one.
 *
 * Two things deliberately DO NOT go through this shield:
 *   - an explicit --token / listener / bot audit, which must always run;
 *   - open positions, which sell_notifier prices every tick independently of
 *     the scan. A cooldown on the audit side cannot blind the sell side.
 */

const COOLDOWN_PATH = ['.state', 'audit_cooldown.json'];

export function pruneCooldown(store, ttlMs, now = Date.now()) {
  const fresh = {};
  for (const [mint, ts] of Object.entries(store ?? {})) {
    if (typeof ts === 'number' && now - ts < ttlMs) fresh[mint] = ts;
  }
  return fresh;
}

/** Case-insensitive: DexScreener and the RPC disagree on mint casing. */
export const cooldownKey = (address) => String(address ?? '').toLowerCase();

export function isOnCooldown(store, address, ttlMs, now = Date.now()) {
  const ts = store?.[cooldownKey(address)];
  return typeof ts === 'number' && now - ts < ttlMs;
}

async function loadCooldown(path, ttlMs, now) {
  try {
    return pruneCooldown(JSON.parse(await readFile(path, 'utf8')), ttlMs, now);
  } catch {
    return {};
  }
}

async function saveCooldown(path, store) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), 'utf8');
}

async function analyzeToken({
  pair,
  config,
  state,
  watchlist,
  deployerCache,
  blacklist,
  observations,
  funderCache,
  discoveredStore,
  screenCache,
  newsWindow,
  trending,
  now,
}) {
  const address = pair.baseToken.address;
  const key = `${pair.chainId}:${address.toLowerCase()}`;

  const security = await fetchSecurity(pair.chainId, address, { rpcUrl: config.rpcUrl });
  const demand = analyzeDemand(pair, security);
  // Age drives the concentration cap, so demand must be computed first.
  let audit = runSecurityAudit(security, config.thresholds, {
    ageHours: demand.ageHours,
    traction: tractionFrom(security, demand),
  });

  const observation = {
    holders: security?.totalHolders ?? null,
    marketCap: demand.marketCap,
    timestamp: now.getTime(),
    symbol: pair.baseToken.symbol,
    price: Number(pair.priceUsd) || null,
    chain: pair.chainId,
    address,
    // Stored so the post-mortem can blacklist the deployer without re-querying.
    deployer: security?.ok ? security.creator : null,
  };
  const velocity = computeVelocity(state, key, observation);
  recordSnapshot(state, key, observation);

  const social = analyzeSocials(pair, config);

  // Replaying pool trades is the most expensive call in the pipeline, so only do
  // it when there is actually a watchlist to match against — otherwise it burns
  // 25 RPC calls per token to answer a question nobody asked.
  let buyers = [];
  let buyerScan = null;
  // Replay runs when there is a watchlist to match against, OR when the elite
  // tracker is building its own leaderboard — that ledger only grows if buyers
  // are observed, so it must not depend on the watchlist already existing.
  const wantBuyerReplay =
    config.smartMoney.enabled &&
    config.smartMoney.scanRecentBuyers &&
    pair.chainId === 'solana' &&
    (watchlist.count > 0 || config.eliteWhales?.observe !== false);

  if (wantBuyerReplay) {
    buyerScan = await fetchRecentBuyers({
      rpcUrl: config.rpcUrl,
      poolAddress: pair.pairAddress,
      mint: address,
      cfg: config.smartMoney,
      screenCache,
    });
    buyers = buyerScan.buyers ?? [];

    // Feed the elite-whale ledger. These are real wallets that bought a token
    // Aegis scanned; the post-mortem grades the outcome later.
    if (observations && buyers.length) {
      recordBuys(observations, {
        buyers,
        token: address,
        chain: pair.chainId,
        symbol: pair.baseToken.symbol,
        marketCap: demand.marketCap,
        now: now.getTime(),
        systemFilter: (w) => SYSTEM_ACCOUNTS.has(w) || screenCache[w]?.system === true,
      });
    }
  }

  const smartMoney = config.smartMoney.enabled
    ? matchSmartMoney({
        holders: security?.allHolders ?? [],
        buyers,
        watchlist,
        ageHours: demand.ageHours,
        pairCreatedAt: pair.pairCreatedAt ?? null,
        pair,
        totalSupply: security?.totalSupply ?? null,
        config,
      })
    : { configured: false, detected: false, count: 0, wallets: [], matches: [] };
  if (smartMoney) smartMoney.buyerScan = buyerScan;

  // Deployer history is reconstructed from Solana RPC, so it is Solana-only.
  const deployer =
    config.deployer.enabled && pair.chainId === 'solana' && security?.ok
      ? await auditDeployer({
          creator: security.creator,
          subjectMint: address,
          config,
          cache: deployerCache,
          now: now.getTime(),
        })
      : {
          available: false,
          status: DEV_STATUS.UNKNOWN,
          address: security?.creator ?? null,
          reasons: [
            pair.chainId === 'solana'
              ? 'Deployer audit skipped'
              : 'Deployer history reconstruction is Solana-only (requires RPC mint parsing)',
          ],
        };

  // A serial-rugger deployer fails the whole audit, even with a clean contract.
  audit = applyDeployerVerdict(audit, deployer);

  const blacklistHit = checkBlacklist(blacklist, {
    mint: address,
    deployer: security?.ok ? security.creator : null,
  });

  const migration = migrationStatus(pair, security, config);

  // Cluster analysis needs the replayed buyers and a SOL price consistent with
  // every other dollar figure in the report.
  const solUsd =
    Number(pair.priceUsd) > 0 && Number(pair.priceNative) > 0 &&
    (pair.quoteToken?.symbol === 'SOL' || pair.quoteToken?.symbol === 'WSOL')
      ? Number(pair.priceUsd) / Number(pair.priceNative)
      : null;

  const clusters =
    config.insiderCluster?.enabled !== false && pair.chainId === 'solana' && buyers.length
      ? await detectInsiderClusters({
          buyers,
          watchlist,
          pairCreatedAt: pair.pairCreatedAt ?? null,
          liquidityUsd: demand.liquidityUsd,
          solUsd,
          config,
          rpcUrl: config.rpcUrl,
          funderCache,
        })
      : { detected: false, label: null, clusterBuying: null, oversized: [], networks: [], watchlisted: [] };

  if (clusters?.detected) clusters.scoreBonus = clusterScoreBonus(clusters, config);

  // Attach each insider's rolling scorecard from Aegis's own ledger. Free —
  // the observations are already in memory — and it is the only performance
  // data that exists: GMGN and Birdeye, which sell the real thing, are gated.
  if (clusters?.detected && observations) {
    const windowDays = config.telegram?.scorecardWindowDays ?? 30;
    for (const m of clusters.uniqueInsiders ?? clusters.watchlisted ?? []) {
      const entry = observations.wallets?.[m.wallet];
      m.scorecard = entry
        ? walletScorecard(entry, { solUsd, windowDays, now: now.getTime() })
        : null;
      // Earned alpha points from the multiplier engine, decayed forward by every
      // graded trade since. This is the number the safety bypass is keyed on, so
      // it is attached here rather than looked up twice; a wallet with no ledger
      // entry stays null, and null never clears the floor.
      m.insiderScore = entry?.alpha?.points ?? null;
    }
  }

  // --- High-conviction insider bypass -------------------------------
  //
  // Resolved once, then handed to BOTH classification and scoring so the two
  // cannot disagree about whether a gate was overridden. Off entirely unless
  // config.smartMoney.allowInsiderSafetyBypass is true.
  const insiderBypass = resolveInsiderBypass({ clusters, smartMoney, config });

  // --- Community takeover -------------------------------------------
  //
  // Two-phase on purpose. The three cheap criteria (holders, 1h volume, pool
  // depth) are evaluated from data already in hand; only if all three pass do
  // we spend an RPC call reading the creator's live balance. On a normal scan
  // almost nothing reaches phase two, so the CTO engine is close to free.
  let cto = evaluateCommunityTakeover({ demand, security, deployer, devExit: null, config });
  const cheapCriteriaPassed = cto.checks
    .filter((c) => c.label !== 'Developer exited')
    .every((c) => c.passed);

  if (cheapCriteriaPassed && pair.chainId === 'solana' && security?.ok && security.creator) {
    const devExit = await readDevExit({
      rpcUrl: config.rpcUrl,
      creator: security.creator,
      mint: address,
      totalSupply: security.totalSupply,
    });
    cto = evaluateCommunityTakeover({ demand, security, deployer, devExit, config });
    if (cto.detected) {
      console.log(
        `   Community takeover confirmed for ${pair.baseToken.symbol} — dev holds ${devExit.balancePct?.toFixed(2) ?? '?'}%`
      );
    }
  }

  // Classification runs AFTER cluster and CTO detection, because the tiers are
  // defined by them — the plain GEM / SCALP bands never needed that input, so
  // this used to sit further up.
  const signalCategory = classifySignal({ demand, security, config, clusters, audit, cto, insiderBypass });

  // Network discovery reuses the funder cache the cluster pass just warmed, so
  // it costs little extra. Gated on a cluster having fired: expanding the net
  // from tokens with no signal is how a watchlist fills with noise.
  if (clusters?.detected && discoveredStore && pair.chainId === 'solana') {
    try {
      const net = await discoverNetwork({
        buyers,
        watchlist,
        rpcUrl: config.rpcUrl,
        config,
        funderCache,
        discoveredStore,
        token: pair.baseToken.symbol,
      });
      clusters.network = net;
      if (net.added.length) {
        console.log(
          `   Network expanded: +${net.added.length} wallet(s) from ${net.clusters.length} cluster(s)` +
            (net.rejectedFunders?.length
              ? ` (${net.rejectedFunders.length} exchange-scale funder(s) rejected)`
              : '')
        );
      }
    } catch (err) {
      console.error(`   network discovery failed: ${err.message}`);
    }
  }

  // News and trending are fetched ONCE per scan by the caller and passed in —
  // they are market-wide facts, not per-token ones, and re-fetching them for
  // every audited token would hammer two rate-limited free APIs.
  const news = newsWindow
    ? matchTokenToNews({ pair, news: newsWindow, config, now: now.getTime() })
    : { matched: false, keywords: [], headlines: [] };
  const socialHype = trending
    ? scoreSocialHype({ pair, trending, mentions: null, config })
    : { detected: false, scoreBoost: 0, reasons: [] };

  const rawCatalysts = detectCatalysts(pair, security, demand, velocity, config.thresholds, {
    smartMoney,
    deployer,
    social,
    blacklistHit,
  });
  // A confirmed takeover stops being punished for the developer having left —
  // that is the premise of the pattern, not a warning about it. Every other
  // bearish signal survives, so the label cannot erase the rest of the risk.
  const catalysts = applyCtoOverride(rawCatalysts, cto);
  const megaRunner = detectMegaRunner({ demand, config });
  const verdictInfo = scoreToken({
    audit,
    security,
    demand,
    velocity,
    catalysts,
    thresholds: config.thresholds,
    smartMoney,
    deployer,
    smartMoneyConfig: config.smartMoney,
    social,
    blacklistHit,
    signalCategory,
    clusters,
    megaRunner,
    socialHype,
    config,
    insiderBypass,
  });

  if (verdictInfo.insiderBypass?.applied) {
    console.log(
      `   🔴 [WARN] ${pair.baseToken.symbol} anti-rug shield BYPASSED by insider score ` +
        `${verdictInfo.insiderBypass.score} (floor ${verdictInfo.insiderBypass.floor}) — ` +
        `waived: ${verdictInfo.insiderBypass.gates.join(', ')}`
    );
  }

  return {
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
    cto,
    megaRunner,
    news,
    social: socialHype,
  };
}

/**
 * Read the creator's live token balance as a share of supply.
 *
 * Deliberately from chain rather than from the provider's cached
 * `creatorBalance`: this decides whether a token qualifies as a takeover, and a
 * stale balance would let a dev who is still holding pass as departed. Returns
 * balancePct null on any failure — the caller treats unknown as NOT exited.
 */
async function readDevExit({ rpcUrl, creator, mint, totalSupply }) {
  if (!rpcUrl || !creator || !totalSupply) {
    return { sold: null, balancePct: null, source: 'unavailable' };
  }
  const balance = await walletTokenBalance(rpcUrl, creator, mint);
  if (balance === null) return { sold: null, balancePct: null, source: 'rpc-failed' };

  const balancePct = totalSupply > 0 ? (balance / totalSupply) * 100 : null;
  return {
    sold: null, // no sell event is claimed; the balance is the evidence
    balancePct,
    balance,
    creator,
    source: 'rpc-live',
  };
}

async function writeNote({ pair, result, notesDir, config, now }) {
  const markdown = renderNote({
    pair,
    security: result.security?.ok ? result.security : null,
    audit: result.audit,
    demand: result.demand,
    velocity: result.velocity,
    catalysts: result.catalysts,
    verdictInfo: result.verdictInfo,
    smartMoney: result.smartMoney,
    deployer: result.deployer,
    social: result.social,
    blacklistHit: result.blacklistHit,
    signalCategory: result.signalCategory,
    migration: result.migration,
    clusters: result.clusters,
    tradeLink: { template: config.tradeLinkTemplate, label: config.tradeLinkLabel },
    now,
  });
  const filename = noteFilename(pair.baseToken.symbol, now, pair.baseToken.address);
  const path = join(notesDir, filename);
  await writeFile(path, markdown, 'utf8');
  return path;
}

export async function runScan(args = {}) {
  // Real-time mode is silent by construction: no digest, ever.
  const realtime = args.realtime === true;
  const config = applyEnvOverrides(
    JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'))
  );

  if (args.testTelegram) return testTelegram(config);

  const vaultRoot = resolve(HERE, config.vaultPath);
  const notesDir = join(vaultRoot, config.notesFolder);
  await mkdir(notesDir, { recursive: true });

  const statePath = join(HERE, '.state', 'snapshots.json');
  const deployerCachePath = join(HERE, '.state', 'deployers.json');
  const alertLogPath = join(HERE, '.state', 'alerts.json');
  const state = await loadState(statePath);
  const deployerCache = await loadDeployerCache(deployerCachePath);
  const alertLog = await loadAlertLog(alertLogPath);
  const observationsPath = join(HERE, '.state', 'wallet_observations.json');
  const observations = await loadObservations(observationsPath);
  const positions = await loadPositions();
  const funderCachePath = join(HERE, '.state', 'funder_cache.json');
  let funderCache = {};
  try { funderCache = JSON.parse(await readFile(funderCachePath, 'utf8')); } catch { /* first run */ }
  const discoveredPath = join(HERE, 'discovered_wallets.json');
  const discoveredStore = await loadDiscovered(discoveredPath);
  const screenCachePath = join(HERE, '.state', 'system_account_cache.json');
  let screenCache = {};
  try { screenCache = JSON.parse(await readFile(screenCachePath, 'utf8')); } catch { /* first run */ }
  const watchlist = await loadWatchlist(join(HERE, config.smartMoney.watchlistFile), [discoveredPath], {
    rpcUrl: config.rpcUrl,
    screenCache,
    screening: config.smartMoney?.screening ?? {},
  });
  for (const ex of watchlist.excluded ?? []) {
    console.log(`   EXCLUDED ${ex.label ? '"' + ex.label + '" ' : ''}${ex.address.slice(0, 12)}… — ${ex.reason}`);
  }
  const blacklist = await loadBlacklist(join(HERE, 'dev_blacklist.json'));
  console.log(
    `Blacklist: ${blacklist.wallets.size} deployer(s), ${blacklist.mints.size} mint(s)`
  );

  const credentials = await loadEnv(join(HERE, '.env'));
  if (credentials.rpcOverride) config.rpcUrl = credentials.rpcOverride;
  const now = new Date();

  // Audit cooldown. Persisted rather than held in memory: index.mjs starts a
  // fresh process per scheduled run, so an in-memory set would reset on every
  // one of those and only ever work for loop.mjs.
  const cooldownPath = join(HERE, ...COOLDOWN_PATH);
  const cooldownMs = (config.auditCooldownMinutes ?? 10) * 60_000;
  const seenAuditTokens = await loadCooldown(cooldownPath, cooldownMs, now.getTime());

  // Market-wide context, fetched ONCE per scan. Both are free-tier APIs with
  // real rate limits, and neither varies per token — pulling them inside the
  // audit loop would multiply the cost by the scan limit for identical data.
  // Failures are non-fatal: the scan is about on-chain facts, and a news feed
  // being down is not a reason to stop auditing.
  let newsWindow = null;
  let trending = null;
  if (config.newsSentinel?.enabled !== false) {
    try {
      newsWindow = await fetchBreakingNews({
        config,
        cryptoPanicToken: credentials.cryptoPanicToken,
        now: now.getTime(),
      });
      const live = newsWindow.sources.filter((s) => s.ok);
      const dead = newsWindow.sources.filter((s) => !s.ok);
      console.log(
        `News: ${newsWindow.items.length} headline(s) from ${live.length}/${newsWindow.sources.length} source(s)` +
          (dead.length ? ` — unavailable: ${dead.map((d) => d.source).join(', ')}` : '')
      );
    } catch (err) {
      console.error(`News sentinel failed (scan continues): ${err.message}`);
    }
  }
  if (config.socialTracer?.enabled !== false) {
    try {
      trending = await fetchTrending({ config, now: now.getTime(), apiKey: credentials.coingeckoKey });
      if (trending.ok) {
        console.log(
          `Trending: ${trending.solanaMints.size} Solana contract(s) among ${trending.coins.length} trending search(es)${trending.cached ? ' [cached]' : ''}`
        );
      }
    } catch (err) {
      console.error(`Social tracer failed (scan continues): ${err.message}`);
    }
  }

  console.log(
    credentials.botToken && credentials.chatId
      ? `Telegram: configured — ${
          config.telegram.insiderOnly !== false
            ? 'SILENT unless insider activity AND all safety gates pass'
            : `alerts at BUY SIGNAL, score ≥ ${config.telegram.minScore}`
        }`
      : 'Telegram: no credentials (copy .env.example to .env — alerts disabled)'
  );

  console.log(
    watchlist.count
      ? `Smart money watchlist: ${watchlist.count} wallet(s) loaded`
      : 'Smart money watchlist: empty (module inactive — see aegis/smart_wallets.json)'
  );
  // A malformed address matches nothing, which is indistinguishable from
  // "no whales found". Say so loudly rather than let it look like it works.
  for (const bad of watchlist.invalid ?? []) {
    console.log(
      `   REJECTED ${bad.label ? `"${bad.label}" ` : ''}${bad.address} — ${bad.reason}`
    );
  }

  if (config.deployer.enabled) {
    const harvest = await harvestLaunchFeed(deployerCache, now.getTime());
    console.log(
      harvest.ok
        ? `Deployer index: +${harvest.added} new launch(es), ${harvest.tracked} deployer(s) tracked`
        : 'Deployer index: launch feed unavailable this run'
    );
  }

  const chains = args.chain ? [args.chain] : config.chains;

  // --- Gather pairs -------------------------------------------------
  let pairs = [];
  if (args.token) {
    console.log(`Deep-dive: ${args.token}`);
    const pair = await fetchSinglePair(args.token);
    if (!pair) {
      // The listener feeds in addresses scraped from channel text, most of
      // which are wallets, pools or plain noise. That is the normal case, not
      // an error, and it must never take the process down — so a programmatic
      // caller gets an empty result and only the CLI exits non-zero.
      if (args.fromListener) {
        return { scanned: 0, written: [], alerts: [], skipped: ['no tradeable pair'] };
      }
      console.error('No DexScreener pair found for that address.');
      process.exit(1);
    }
    pairs = [pair];
  } else {
    // Prefer the daemon's pre-surfaced pool. Discovery is a FIXED cost that
    // does not shrink with the audit limit, so on the loop it sat in front of
    // every tick and `scanLimit` could not touch it. Reading a fresh file is
    // effectively free.
    //
    // Falls back to discovering inline when the pool is stale or absent, and
    // SAYS which path it took. A stale pool is worse than a slow scan here:
    // these tokens are minutes old, so a five-minute-old list of "fresh
    // launches" is mostly the previous window's.
    const maxAgeSec = config.discovery?.maxCandidateAgeSeconds ?? 180;
    const surfaced = await loadSurfaced(join(HERE, '.state', 'surfaced_candidates.json'));
    const fresh = surfacedFreshness(surfaced, maxAgeSec, now.getTime());

    let candidates;
    let stats;
    if (fresh.fresh) {
      candidates = surfaced.candidates;
      stats = surfaced.stats ?? { total: candidates.length, fromFeeds: '?', fromSearch: '?' };
      console.log(
        `Candidates from discovery daemon: ${candidates.length} (${fresh.ageSec.toFixed(0)}s old, 0s discovery latency)`
      );
    } else {
      console.log(
        `Discovering launches on: ${chains.join(', ')}` +
          (surfaced.generatedAt
            ? ` — daemon pool ${fresh.ageSec.toFixed(0)}s old, past the ${maxAgeSec}s limit`
            : ' — no daemon pool on file')
      );
      ({ candidates, stats } = await discoverCandidates(chains, config.discovery));
      console.log(
        `   ${stats.total} candidates surfaced (${stats.fromFeeds} from launch feeds, ${stats.fromSearch} from search).`
      );
    }

    const byChain = new Map();
    for (const c of candidates) {
      if (!byChain.has(c.chainId)) byChain.set(c.chainId, []);
      byChain.get(c.chainId).push(c.tokenAddress);
    }
    for (const [, addresses] of byChain) {
      const map = await fetchPairsBatch(addresses);
      pairs.push(...map.values());
    }
    pairs.sort((a, b) => (b.volume?.h1 ?? 0) - (a.volume?.h1 ?? 0));

    // Cooldown BEFORE the cap, which is the whole point. Filtering after the
    // slice would let recently-audited tokens occupy the audit budget and then
    // be discarded, so a tick with 8 slots might do 2 real audits. Filtering
    // first means all 8 slots go to tokens that have not been seen.
    const beforeCooldown = pairs.length;
    pairs = pairs.filter((p) => !isOnCooldown(seenAuditTokens, p.baseToken?.address, cooldownMs, now.getTime()));
    const suppressed = beforeCooldown - pairs.length;

    const cap = args.limit ?? config.maxTokensPerScan;
    pairs = pairs.slice(0, cap);
    console.log(
      `   ${pairs.length} tradeable pairs to audit` +
        (suppressed
          ? ` (${suppressed} skipped — audited within the last ${(cooldownMs / 60000).toFixed(0)}m)`
          : '') +
        '.\n'
    );
  }

  // --- Analyse ------------------------------------------------------
  const written = [];
  const skipped = [];
  const alerts = [];
  const digestRows = [];

  /**
   * Bounded-concurrency map. Workers pull from a shared cursor, so a slow token
   * cannot stall the others behind it the way a fixed chunk split would.
   */
  const mapConcurrent = async (items, limit, fn) => {
    const out = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  };

  // ---- PHASE 1: analyse concurrently ------------------------------
  //
  // Only the ANALYSIS runs in parallel. It is network-bound — security fetch,
  // buyer replay, deployer audit, funder tracing — and that is where the ~27s
  // per token goes.
  //
  // Side effects are deliberately NOT run here. Notes, alerts, positions, the
  // digest and the console log all happen in phase 2, sequentially and in the
  // original order, because parallelising them buys nothing and breaks things
  // that matter: interleaved log lines, nondeterministic digest ordering, and
  // check-then-act races across awaits in the alert cooldown and position
  // opener. Concurrency belongs where the waiting is, not where the writing is.
  const auditCandidates = args.token
    ? pairs.map((pair) => ({ pair, reject: null }))
    : pairs.map((pair) => ({ pair, reject: passesFilters(pair, config.filters) }));

  for (const c of auditCandidates) {
    if (c.reject) skipped.push(`${c.pair.baseToken?.symbol ?? '???'} — ${c.reject}`);
    // Stamped here rather than inside the worker so the cooldown reflects what
    // was SELECTED, identically to the serial version.
    else if (!args.token) seenAuditTokens[cooldownKey(c.pair.baseToken.address)] = now.getTime();
  }

  const toAudit = auditCandidates.filter((c) => !c.reject).map((c) => c.pair);
  const concurrency = Math.max(1, config.auditConcurrency ?? 4);

  const analysed = await mapConcurrent(toAudit, concurrency, async (pair) => {
    try {
      const result = await analyzeToken({
        pair,
        config,
        state,
        watchlist,
        deployerCache,
        blacklist,
        observations,
        funderCache,
        discoveredStore,
        screenCache,
        newsWindow,
        trending,
        now,
      });
      return { pair, result, error: null };
    } catch (err) {
      // One token failing must not take the pass down — the others already
      // spent their RPC budget.
      return { pair, result: null, error: err.message };
    }
  });

  if (!realtime && toAudit.length) {
    console.log(`   audited ${toAudit.length} token(s) at concurrency ${concurrency}\n`);
  }

  // ---- PHASE 2: side effects, sequential and ordered ---------------
  for (const entry of analysed) {
    const { pair, result: preAnalysed, error: analysisError } = entry;
    const symbol = pair.baseToken?.symbol ?? '???';

    if (analysisError) {
      skipped.push(`${symbol} — audit failed: ${analysisError}`);
      continue;
    }


    // Analysis already ran in phase 1; this loop only applies side effects.
    const result = preAnalysed;
    const { verdictInfo, audit, demand, deployer, smartMoney, social } = result;

    if (!args.token) {
      const shallow = passesDepthFilter(demand, config.filters);
      if (shallow) {
        skipped.push(`${symbol} — ${shallow}`);
        await sleep(config.requestDelayMs);
        continue;
      }
    }

    const actionable =
      args.all || args.token || verdictInfo.verdict !== 'WATCH' || verdictInfo.score >= config.thresholds.watchScore;

    const quiet = realtime;
    const icon = verdictInfo.blacklisted
      ? ''
      : verdictInfo.serialRugger
        ? ''
        : (VERDICT_ICON[verdictInfo.verdict] ?? '•');
    const devTag =
      deployer?.status === DEV_STATUS.RUGGER
        ? ' dev:RUGGER🔴'
        : deployer?.status === DEV_STATUS.GOOD
          ? ' dev:GOOD'
          : '';
    const smTag = smartMoney?.detected ? ` x${smartMoney.count}` : '';
    const catTag =
      result.signalCategory?.category === 'COMMUNITY TAKEOVER GEM'
        ? ' CTO'
        : result.signalCategory?.category === 'ESTABLISHED INSIDER GEM'
        ? ' INSIDER-GEM'
        : result.signalCategory?.category === 'EARLY-STAGE INSIDER SCALP'
          ? ' INSIDER-SCALP'
          : result.signalCategory?.category === 'LONG-TERM GEM'
            ? ' GEM'
            : result.signalCategory?.category === 'FAST SCALP'
              ? ' SCALP'
              : '';
    const holders = verdictInfo.holderGate?.holders;
    if (!quiet) console.log(
      `${icon} ${symbol.padEnd(12)} ${String(verdictInfo.score).padStart(3)}/100  ${verdictInfo.verdict.padEnd(24)} ` +
        `sec:${audit.status.padEnd(11)} hodl:${String(holders ?? '?').padStart(5)} ` +
        `5m ${demand.m5.buys}/${demand.m5.sells}  liq ${demand.liqToMcapPct.toFixed(0)}%` +
        `${devTag}${smTag}${catTag}${socialBadge(social)}`
    );

    digestRows.push({
      symbol,
      verdict: verdictInfo.verdict,
      score: verdictInfo.score,
      address: pair.baseToken.address,
      chain: pair.chainId,
      marketCap: demand.marketCap,
      buys: demand.m5.buys,
      sells: demand.m5.sells,
      liqPct: demand.liqToMcapPct,
      smartMoney: smartMoney?.detected ? smartMoney.count : 0,
      category: result.signalCategory?.category ?? 'UNCLASSIFIED',
      categoryLabel: result.signalCategory?.label ?? null,
      advice: result.signalCategory?.advice ?? null,
      // Whale detail is attached only when the token passed every safety gate;
      // a blocked token must never carry a smart-money endorsement.
      smartMoneyDetail:
        smartMoney?.detected && !verdictInfo.safetyGateFailed ? smartMoney.matches : [],
      devStatus: deployer?.status ?? null,
      failReason: audit.failures?.[0] ?? null,
    });

    if (actionable && config.writeNotes !== false) {
      const path = await writeNote({ pair, result, notesDir, config, now });
      written.push({ symbol, verdict: verdictInfo.verdict, score: verdictInfo.score, path });
    }

    const alert = await maybeAlert({
      result,
      pair,
      credentials,
      config,
      alertLog,
      now: now.getTime(),
    });
    if (alert.status === 'sent') {
      console.log(`   [ALERT] sent for ${symbol}`);
      alerts.push(symbol);
      // Capture entry market cap and each insider's CURRENT balance. Taken
      // later, the baseline would already include any selling.
      const balances = {};
      for (const m of result.clusters?.clusterBuying?.members ?? result.clusters?.watchlisted ?? []) {
        balances[m.wallet] = await walletTokenBalance(config.rpcUrl, m.wallet, pair.baseToken.address);
      }
      if (openPosition(positions, {
        pair,
        demand,
        clusters: result.clusters,
        rpcBalances: balances,
        category: result.signalCategory?.category ?? null,
      })) {
        console.log(`   [OPEN]  position for ${symbol} at ${Math.round(demand.marketCap).toLocaleString('en-US')} — sell triggers armed`);
      }
    } else if (alert.status === 'failed') {
      console.log(`   Telegram alert FAILED for $${symbol}: ${alert.error}`);
    } else if (alert.status === 'no-credentials') {
      console.log(`   $${symbol} qualified for an alert but Telegram is not configured`);
    } else if (alert.status === 'blocked-reaudit') {
      console.log(`   $${symbol} alert CANCELLED at dispatch — ${alert.reason}`);
    } else if (alert.status === 'blocked-safety') {
      console.log(`   🔴 [BLOCK] ${symbol} alert blocked by safety gate — ${alert.reason}`);
    } else if (alert.status === 'blocked-insider-requirements') {
      console.log(`   $${symbol} matched an insider band but failed a mandatory requirement — ${alert.reason}`);
    } else if (alert.status === 'outside-insider-tiers') {
      // Logged rather than dropped: this is real insider activity going silent,
      // and silence with no stated reason is indistinguishable from a bug.
      console.log(`   $${symbol} has insider activity but sits outside both tiers — ${alert.reason}`);
    }

    await sleep(config.requestDelayMs);
  }

  await saveState(statePath, state);
  await saveDeployerCache(deployerCachePath, deployerCache);
  await saveAlertLog(alertLogPath, alertLog);
  // Pruned on write as well as on read, so the file cannot grow without bound
  // if the process is killed before its next load.
  await saveCooldown(cooldownPath, pruneCooldown(seenAuditTokens, cooldownMs, now.getTime()));
  pruneObservations(observations, now.getTime());
  await saveObservations(observationsPath, observations);
  await savePositions(positions);
  await writeFile(screenCachePath, JSON.stringify(screenCache, null, 2), 'utf8');
  if (discoveredStore.wallets.length) await saveDiscovered(discoveredPath, discoveredStore);
  await writeFile(funderCachePath, JSON.stringify(funderCache, null, 2), 'utf8');
  const observedWallets = Object.keys(observations.wallets).length;
  if (observedWallets) console.log(`Elite ledger: ${observedWallets} wallet(s) under observation`);

  // --- Report -------------------------------------------------------
  console.log(`\n${written.length} note(s) written to ${notesDir}`);
  for (const w of written) {
    console.log(`   ${VERDICT_ICON[w.verdict] ?? '•'} ${w.symbol} (${w.score}) → ${w.path.split(/[\\/]/).pop()}`);
  }
  // The digest is what makes a headless deploy usable: it delivers the console
  // view — every verdict, not just BUY SIGNAL — to wherever you actually are.
  if (!realtime && config.telegram.sendScanDigest && credentials.botToken && credentials.chatId) {
    const sent = await sendTelegram({
      ...credentials,
      text: buildDigest({
        rows: digestRows,
        scanned: digestRows.length,
        noteCount: written.length,
        startedAt: now.getTime(),
        tradeLink: { template: config.tradeLinkTemplate, label: config.tradeLinkLabel },
      }),
    });
    console.log(sent.ok ? 'Scan digest sent to Telegram' : `Digest failed: ${sent.error}`);
  }

  if (alerts.length) console.log(`${alerts.length} Telegram alert(s) sent: ${alerts.join(', ')}`);
  if (skipped.length) {
    console.log(`\n${skipped.length} filtered out before audit:`);
    for (const s of skipped.slice(0, 12)) console.log(`   - ${s}`);
    if (skipped.length > 12) console.log(`   … and ${skipped.length - 12} more`);
  }

  // Flushed once per pass, after the scan's own work. A throttled key degrades
  // results silently, so this is the only thing that surfaces it.
  try {
    const q = await maybeNotifyQuota({ config });
    if (q.sent.length) console.log(`API quota alert sent for: ${q.sent.join(', ')}`);
  } catch { /* telemetry must never fail a scan */ }

  return { written, alerts, skipped, scanned: digestRows.length, rows: digestRows };
}

/**
 * Audit one token and return the full result WITHOUT alerting or writing.
 *
 * Exists for the Telegram command bot: `/audit <mint>` is a question, and
 * answering it must not fire a BUY alert, open a position or write a note.
 * Everything stateful in runScan is deliberately skipped here — the caller
 * gets the analysis and decides what to do with it.
 *
 * The observation ledger is loaded read-only so insider scorecards still
 * populate; nothing is saved back.
 */
export async function auditOnce(address, { chain = null } = {}) {
  const config = applyEnvOverrides(
    JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'))
  );

  const pair = await fetchSinglePair(address);
  if (!pair) return { ok: false, error: 'No tradeable DexScreener pair for that address' };
  if (chain && pair.chainId !== chain) {
    return { ok: false, error: `Pair is on ${pair.chainId}, not ${chain}` };
  }

  // Loaded through the real loaders, not hand-rolled empties. An earlier cut
  // passed `deployerCache: {}` and auditDeployer threw on `cache.profiles`,
  // taking the whole command down — these structures have shapes, and the
  // loaders are where those shapes are defined.
  const [watchlist, blacklist, observations, deployerCache, state] = await Promise.all([
    loadWatchlist(join(HERE, config.smartMoney.watchlistFile)),
    loadBlacklist(join(HERE, 'dev_blacklist.json')),
    loadObservations(join(HERE, '.state', 'wallet_observations.json')),
    loadDeployerCache(join(HERE, '.state', 'deployers.json')),
    loadState(join(HERE, '.state', 'snapshots.json')),
  ]);

  const result = await analyzeToken({
    pair,
    config,
    state,
    watchlist,
    deployerCache,
    blacklist,
    observations,
    funderCache: {},
    discoveredStore: null,
    screenCache: {},
    now: new Date(),
  });

  return { ok: true, pair, result, config };
}

// Direct invocation (`node scan.mjs …`) still works; index.mjs is the entry
// point used by the scheduler.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runScan(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
