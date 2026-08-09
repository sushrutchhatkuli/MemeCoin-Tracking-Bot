/**
 * Serial Dev Reputation Monitoring.
 *
 * Reconstructs a Solana deployer's launch history directly from chain state:
 *   1. getSignaturesForAddress on the creator wallet
 *   2. parse those transactions for initializeMint / initializeMint2
 *   3. look the resulting mints up on DexScreener to see how each one ended
 *
 * This catches what a contract-level audit structurally cannot. A token can have
 * revoked authorities, a burned LP and clean holder distribution while its
 * deployer is minting a fresh one every six seconds.
 *
 * Results are cached per-wallet because the same deployer recurs across scans
 * and the RPC work is the most expensive step in the pipeline.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(url, method, params, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await res.json();
    return body.error ? { error: JSON.stringify(body.error).slice(0, 160) } : { result: body.result };
  } catch (err) {
    clearTimeout(timer);
    return { error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

export async function loadDeployerCache(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return { profiles: raw.profiles ?? {}, observed: raw.observed ?? {} };
  } catch {
    return { profiles: {}, observed: {} };
  }
}

export async function saveDeployerCache(path, cache) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2), 'utf8');
}

/**
 * Poll RugCheck's new-token feed and persist every creator→mint pair it reports.
 *
 * This exists because the RPC walk reads a wallet's NEWEST transactions, while a
 * token's creation event is older — so an active deployer's own launches often
 * fall outside the window. The feed is a rolling window of ~10 tokens, but
 * accumulating it across scans builds launch history that does not depend on the
 * transaction window at all. It is one HTTP call and it compounds over time.
 */
export async function harvestLaunchFeed(cache, now) {
  try {
    const res = await fetch('https://api.rugcheck.xyz/v1/stats/new_tokens', {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, added: 0 };
    const feed = await res.json();

    let added = 0;
    for (const t of feed ?? []) {
      if (!t?.creator || !t?.mint) continue;
      const list = (cache.observed[t.creator] ??= []);
      if (list.some((e) => e.mint === t.mint)) continue;
      list.push({
        mint: t.mint,
        ts: t.createAt ? Date.parse(t.createAt) : now,
        symbol: t.symbol ?? null,
      });
      added++;
    }

    // Bound the store: drop observations older than 30 days.
    const floor = now - 30 * 24 * 3600 * 1000;
    for (const [creator, list] of Object.entries(cache.observed)) {
      const kept = list.filter((e) => e.ts >= floor);
      if (kept.length) cache.observed[creator] = kept;
      else delete cache.observed[creator];
    }

    return { ok: true, added, tracked: Object.keys(cache.observed).length };
  } catch {
    return { ok: false, added: 0 };
  }
}

/* ------------------------------------------------------------------ *
 * History reconstruction
 * ------------------------------------------------------------------ */

/** Every mint this wallet has created within the scanned signature window. */
async function fetchCreatedMints(rpcUrl, creator, cfg) {
  const sigs = await rpc(rpcUrl, 'getSignaturesForAddress', [
    creator,
    { limit: cfg.deployerScanSignatures },
  ]);
  if (sigs.error) return { ok: false, error: sigs.error };

  const signatures = sigs.result ?? [];
  const mints = [];
  let inspected = 0;

  for (const sig of signatures.slice(0, cfg.deployerMaxTxLookups)) {
    const tx = await rpc(rpcUrl, 'getTransaction', [
      sig.signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
    ]);
    inspected++;
    // A rate-limited public RPC will start erroring mid-walk. Keep whatever we
    // already gathered rather than discarding a partial history.
    if (tx.error) break;

    const message = tx.result?.transaction?.message;
    const instructions = [
      ...(message?.instructions ?? []),
      ...(tx.result?.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
    ];

    for (const ix of instructions) {
      const type = ix?.parsed?.type;
      if (type === 'initializeMint' || type === 'initializeMint2') {
        const mint = ix.parsed.info?.mint;
        if (mint && !mints.some((m) => m.mint === mint)) {
          mints.push({ mint, blockTime: sig.blockTime ?? null });
        }
      }
    }
    await sleep(cfg.rpcDelayMs);
  }

  return {
    ok: true,
    mints,
    inspected,
    signatureCount: signatures.length,
    truncated: inspected < signatures.length,
  };
}

/** Current market state of each past mint, used to judge how the launch ended. */
async function fetchOutcomes(mints, subjectMint) {
  const addresses = mints.map((m) => m.mint).filter((m) => m !== subjectMint);
  if (!addresses.length) return new Map();

  const out = new Map();
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
        { headers: { accept: 'application/json' } }
      );
      if (res.ok) {
        const data = await res.json();
        for (const pair of data?.pairs ?? []) {
          const key = pair?.baseToken?.address;
          if (!key) continue;
          const prev = out.get(key);
          const liq = pair.liquidity?.usd ?? 0;
          if (!prev || liq > prev.liquidityUsd) {
            out.set(key, {
              liquidityUsd: liq,
              marketCap: pair.marketCap ?? pair.fdv ?? 0,
              symbol: pair.baseToken?.symbol ?? '?',
            });
          }
        }
      }
    } catch {
      /* outcome lookup is best-effort; a miss reads as "no pair" below */
    }
    await sleep(250);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

export const DEV_STATUS = {
  GOOD: 'GOOD DEV',
  RUGGER: 'SERIAL RUGGER',
  UNKNOWN: 'UNKNOWN / NEW',
};

/**
 * NOTE ON A DELIBERATE DEVIATION FROM SPEC:
 * The spec defines a serial rugger as one whose tokens "dumped to $0 within 5
 * minutes". Historical 5-minute candles for dead tokens are not retrievable from
 * any keyless source — once a token is abandoned, DexScreener stops reporting it
 * entirely. So the rug test is evaluated on observable end-state instead: a past
 * launch counts as dead if it has no live pair or under $1k liquidity. Combined
 * with deploy frequency this identifies the same wallets, but it is an outcome
 * test rather than a speed test, and it cannot distinguish a 5-minute rug from a
 * slow bleed to zero.
 */
function classify(history, cfg, now) {
  const cutoff48h = now - 48 * 3600 * 1000;

  const past = history.outcomes;
  const deploys48h = history.mints.filter(
    (m) => m.blockTime && m.blockTime * 1000 >= cutoff48h
  ).length;

  // Only judge launches old enough to have found a market. A mint from four
  // minutes ago has no pair yet, and that is not evidence of a rug.
  const matureCutoff = now - cfg.deployerMatureMinutes * 60 * 1000;
  const mature = history.mints.filter(
    (m) => m.mint !== history.subjectMint && m.blockTime && m.blockTime * 1000 <= matureCutoff
  );

  let dead = 0;
  let successful = 0;
  const notable = [];

  for (const m of mature) {
    const o = past.get(m.mint);
    const liq = o?.liquidityUsd ?? 0;
    const mcap = o?.marketCap ?? 0;
    if (!o || liq < cfg.deployerDeadLiquidityUsd) dead++;
    if (mcap >= cfg.deployerSuccessMcapUsd) {
      successful++;
      notable.push({ mint: m.mint, symbol: o?.symbol ?? '?', marketCap: mcap });
    }
  }

  const deadRatio = mature.length ? dead / mature.length : 0;

  // Burst rate is the loudest signal: legitimate projects do not mint tokens
  // seconds apart. Measured across the observed window, not just 48h.
  const times = history.mints.map((m) => m.blockTime).filter(Boolean).sort((a, b) => a - b);
  const burstWindowSec =
    times.length >= 2 ? times[times.length - 1] - times[0] : null;
  const rapidFire =
    times.length >= cfg.deployerBurstMinMints &&
    burstWindowSec !== null &&
    burstWindowSec <= cfg.deployerBurstWindowSec;

  let status = DEV_STATUS.UNKNOWN;
  const reasons = [];

  if (rapidFire) {
    status = DEV_STATUS.RUGGER;
    reasons.push(
      `${times.length} mints created within ${burstWindowSec}s of each other — automated spam deployment`
    );
  } else if (deploys48h >= cfg.deployerSerialMinDeploys && deadRatio >= cfg.deployerDeadRatio) {
    status = DEV_STATUS.RUGGER;
    reasons.push(
      `${deploys48h} tokens deployed in 48h, ${dead}/${mature.length} of the matured ones are dead (<$${cfg.deployerDeadLiquidityUsd} liquidity)`
    );
  } else if (successful >= cfg.deployerGoodMinSuccesses && deadRatio < 0.5) {
    status = DEV_STATUS.GOOD;
    reasons.push(
      `${successful} past launch(es) above $${cfg.deployerSuccessMcapUsd.toLocaleString('en-US')} market cap, ${dead}/${mature.length} dead`
    );
  } else if (!mature.length) {
    reasons.push('No matured prior launches found in the scanned window');
  } else {
    reasons.push(
      `${mature.length} prior launch(es) found: ${successful} above $${cfg.deployerSuccessMcapUsd.toLocaleString('en-US')}, ${dead} dead — insufficient to classify`
    );
  }

  if (history.truncated) {
    reasons.push('History window truncated (RPC limit) — older launches not scanned');
  }

  return {
    status,
    reasons,
    deploys48h,
    totalMintsFound: history.mints.length,
    maturePriorLaunches: mature.length,
    deadLaunches: dead,
    successfulLaunches: successful,
    deadRatio,
    rapidFire,
    burstWindowSec,
    notable: notable.slice(0, 5),
    truncated: history.truncated,
  };
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

export async function auditDeployer({ creator, subjectMint, config, cache, now }) {
  if (!creator) {
    return {
      available: false,
      status: DEV_STATUS.UNKNOWN,
      reasons: ['Deployer address not reported by the security provider'],
      address: null,
    };
  }

  const cfg = config.deployer;
  const cached = cache.profiles[creator];
  if (cached && now - cached.cachedAt < cfg.deployerCacheHours * 3600 * 1000) {
    return { ...cached.result, address: creator, fromCache: true };
  }

  const history = await fetchCreatedMints(config.rpcUrl, creator, cfg);
  if (!history.ok) {
    return {
      available: false,
      status: DEV_STATUS.UNKNOWN,
      reasons: [`Deployer history unavailable — RPC error: ${history.error}`],
      address: creator,
    };
  }

  // Union the RPC-derived mints with anything the launch feed has recorded for
  // this wallet. The two sources cover different blind spots.
  const observed = cache.observed[creator] ?? [];
  const mints = [...history.mints];
  let fromFeed = 0;
  for (const o of observed) {
    if (mints.some((m) => m.mint === o.mint)) continue;
    mints.push({ mint: o.mint, blockTime: Math.floor(o.ts / 1000) });
    fromFeed++;
  }

  const merged = { ...history, mints };
  const outcomes = await fetchOutcomes(mints, subjectMint);
  const verdict = classify({ ...merged, outcomes, subjectMint }, cfg, now);

  if (fromFeed) {
    verdict.reasons.push(`${fromFeed} additional launch(es) recovered from the observed launch feed`);
  }
  verdict.fromFeed = fromFeed;

  const result = { available: true, address: creator, ...verdict };
  cache.profiles[creator] = { cachedAt: now, result };
  return result;
}
