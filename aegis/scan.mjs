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
} from './audit.mjs';
import { renderNote, noteFilename } from './note.mjs';
import { loadState, saveState, computeVelocity, recordSnapshot } from './state.mjs';
import { loadWatchlist, matchSmartMoney, fetchRecentBuyers } from './smart_money.mjs';
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
import { loadBlacklist, checkBlacklist } from './blacklist.mjs';

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
    console.error('❌ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing.');
    console.error('   Copy aegis/.env.example to aegis/.env and fill both values.');
    process.exit(1);
  }

  const text = buildMessage({
    pair: {
      chainId: 'solana',
      baseToken: { symbol: 'TESTCOIN', address: 'So11111111111111111111111111111111111111112' },
    },
    demand: {
      marketCap: 65000,
      liquidityUsd: 15000,
      liqToMcapPct: 23.1,
      m5: { buys: 150, sells: 20 },
    },
    verdictInfo: { score: 88, securityStatus: 'PASSED' },
    smartMoney: { configured: true, detected: true, count: 2, earlyBuyers: 1 },
    deployer: { status: 'GOOD DEV ✅', successfulLaunches: 2 },
    security: { totalHolders: 250 },
  });

  const res = await sendTelegram({ ...credentials, text });
  console.log(res.ok ? '✅ Test alert delivered.' : `❌ Telegram rejected it: ${res.error}`);
  process.exit(res.ok ? 0 : 1);
}

const VERDICT_ICON = {
  'BUY SIGNAL': '🚀',
  'CRASH WARNING': '🔴',
  'SCAM/AVOID': '☠️',
  WATCH: '👀',
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

async function analyzeToken({ pair, config, state, watchlist, deployerCache, blacklist, now }) {
  const address = pair.baseToken.address;
  const key = `${pair.chainId}:${address.toLowerCase()}`;

  const security = await fetchSecurity(pair.chainId, address, { rpcUrl: config.rpcUrl });
  const demand = analyzeDemand(pair, security);
  // Age drives the concentration cap, so demand must be computed first.
  let audit = runSecurityAudit(security, config.thresholds, { ageHours: demand.ageHours });

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
  if (
    config.smartMoney.enabled &&
    config.smartMoney.scanRecentBuyers &&
    watchlist.count > 0 &&
    pair.chainId === 'solana'
  ) {
    buyerScan = await fetchRecentBuyers({
      rpcUrl: config.rpcUrl,
      poolAddress: pair.pairAddress,
      mint: address,
      cfg: config.smartMoney,
    });
    buyers = buyerScan.buyers ?? [];
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

  const catalysts = detectCatalysts(pair, security, demand, velocity, config.thresholds, {
    smartMoney,
    deployer,
    social,
    blacklistHit,
  });
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
  });

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
    tradeLink: { template: config.tradeLinkTemplate, label: config.tradeLinkLabel },
    now,
  });
  const filename = noteFilename(pair.baseToken.symbol, now, pair.baseToken.address);
  const path = join(notesDir, filename);
  await writeFile(path, markdown, 'utf8');
  return path;
}

export async function runScan(args = {}) {
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
  const watchlist = await loadWatchlist(join(HERE, config.smartMoney.watchlistFile));
  const blacklist = await loadBlacklist(join(HERE, 'dev_blacklist.json'));
  console.log(
    `⛔ Blacklist: ${blacklist.wallets.size} deployer(s), ${blacklist.mints.size} mint(s)`
  );
  const credentials = await loadEnv(join(HERE, '.env'));
  if (credentials.rpcOverride) config.rpcUrl = credentials.rpcOverride;
  const now = new Date();

  console.log(
    credentials.botToken && credentials.chatId
      ? `📲 Telegram: configured (alerts at BUY SIGNAL, score ≥ ${config.telegram.minScore})`
      : '📲 Telegram: no credentials (copy .env.example to .env — alerts disabled)'
  );

  console.log(
    watchlist.count
      ? `🐋 Smart money watchlist: ${watchlist.count} wallet(s) loaded`
      : '🐋 Smart money watchlist: empty (module inactive — see aegis/smart_wallets.json)'
  );

  if (config.deployer.enabled) {
    const harvest = await harvestLaunchFeed(deployerCache, now.getTime());
    console.log(
      harvest.ok
        ? `👨‍💻 Deployer index: +${harvest.added} new launch(es), ${harvest.tracked} deployer(s) tracked`
        : '👨‍💻 Deployer index: launch feed unavailable this run'
    );
  }

  const chains = args.chain ? [args.chain] : config.chains;

  // --- Gather pairs -------------------------------------------------
  let pairs = [];
  if (args.token) {
    console.log(`🔎 Deep-dive: ${args.token}`);
    const pair = await fetchSinglePair(args.token);
    if (!pair) {
      console.error('❌ No DexScreener pair found for that address.');
      process.exit(1);
    }
    pairs = [pair];
  } else {
    console.log(`🔎 Discovering launches on: ${chains.join(', ')}`);
    const candidates = await discoverCandidates(chains);
    console.log(`   ${candidates.length} candidates surfaced.`);

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
    const cap = args.limit ?? config.maxTokensPerScan;
    pairs = pairs.slice(0, cap);
    console.log(`   ${pairs.length} tradeable pairs to audit.\n`);
  }

  // --- Analyse ------------------------------------------------------
  const written = [];
  const skipped = [];
  const alerts = [];
  const digestRows = [];

  for (const pair of pairs) {
    const symbol = pair.baseToken?.symbol ?? '???';

    if (!args.token) {
      const reject = passesFilters(pair, config.filters);
      if (reject) {
        skipped.push(`${symbol} — ${reject}`);
        continue;
      }
    }

    const result = await analyzeToken({
      pair,
      config,
      state,
      watchlist,
      deployerCache,
      blacklist,
      now,
    });
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

    const icon = verdictInfo.blacklisted
      ? '⛔'
      : verdictInfo.serialRugger
        ? '🚨'
        : (VERDICT_ICON[verdictInfo.verdict] ?? '•');
    const devTag =
      deployer?.status === DEV_STATUS.RUGGER
        ? ' dev:RUGGER🔴'
        : deployer?.status === DEV_STATUS.GOOD
          ? ' dev:GOOD✅'
          : '';
    const smTag = smartMoney?.detected ? ` 🐋x${smartMoney.count}` : '';
    const holders = verdictInfo.holderGate?.holders;
    console.log(
      `${icon} $${symbol.padEnd(12)} ${String(verdictInfo.score).padStart(3)}/100  ${verdictInfo.verdict.padEnd(24)} ` +
        `sec:${audit.status.padEnd(11)} hodl:${String(holders ?? '?').padStart(5)} ` +
        `5m ${demand.m5.buys}/${demand.m5.sells}  liq ${demand.liqToMcapPct.toFixed(0)}%` +
        `${devTag}${smTag}${socialBadge(social)}`
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
      console.log(`   📲 Telegram alert sent for $${symbol}`);
      alerts.push(symbol);
    } else if (alert.status === 'failed') {
      console.log(`   ⚠️  Telegram alert FAILED for $${symbol}: ${alert.error}`);
    } else if (alert.status === 'no-credentials') {
      console.log(`   📲 $${symbol} qualified for an alert but Telegram is not configured`);
    } else if (alert.status === 'blocked-reaudit') {
      console.log(`   🛑 $${symbol} alert CANCELLED at dispatch — ${alert.reason}`);
    } else if (alert.status === 'blocked-safety') {
      console.log(`   🛑 $${symbol} alert blocked by safety gate — ${alert.reason}`);
    }

    await sleep(config.requestDelayMs);
  }

  await saveState(statePath, state);
  await saveDeployerCache(deployerCachePath, deployerCache);
  await saveAlertLog(alertLogPath, alertLog);

  // --- Report -------------------------------------------------------
  console.log(`\n📝 ${written.length} note(s) written to ${notesDir}`);
  for (const w of written) {
    console.log(`   ${VERDICT_ICON[w.verdict] ?? '•'} ${w.symbol} (${w.score}) → ${w.path.split(/[\\/]/).pop()}`);
  }
  // The digest is what makes a headless deploy usable: it delivers the console
  // view — every verdict, not just BUY SIGNAL — to wherever you actually are.
  if (config.telegram.sendScanDigest && credentials.botToken && credentials.chatId) {
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
    console.log(sent.ok ? '📊 Scan digest sent to Telegram' : `⚠️  Digest failed: ${sent.error}`);
  }

  if (alerts.length) console.log(`📲 ${alerts.length} Telegram alert(s) sent: ${alerts.join(', ')}`);
  if (skipped.length) {
    console.log(`\n⏭️  ${skipped.length} filtered out before audit:`);
    for (const s of skipped.slice(0, 12)) console.log(`   - ${s}`);
    if (skipped.length > 12) console.log(`   … and ${skipped.length - 12} more`);
  }

  return { written, alerts, skipped };
}

// Direct invocation (`node scan.mjs …`) still works; index.mjs is the entry
// point used by the scheduler.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runScan(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
