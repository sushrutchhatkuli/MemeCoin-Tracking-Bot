/**
 * Multi-source insider network discovery.
 *
 * ── WHAT EACH "SOURCE" ACTUALLY CONTRIBUTES ─────────────────────────────────
 * The four named sources are not equally available, and it matters which is
 * which:
 *
 *   Solscan     — its API is key-gated (connection refused unauthenticated), so
 *                 origin tracing is done directly against Solana RPC instead.
 *                 That is strictly better: same data, no intermediary, no key.
 *                 Solscan is still used for human-clickable profile links.
 *
 *   Bubblemaps  — no public API. What Bubblemaps *shows* is a wallet graph, and
 *                 that graph is reproducible from chain: wallets sharing a
 *                 funding origin, plus direct wallet-to-wallet transfers. Both
 *                 are computed here. This is the cluster logic, not a fetch.
 *
 *   GMGN        — 403 behind Cloudflare. Win rate / PnL / trade count CANNOT be
 *   Birdeye     — 401 without a paid key.        fetched. Verified repeatedly.
 *
 * So win-rate and PnL tagging is NOT implemented as a fetch, because it cannot
 * be. Instead each discovered wallet carries a deep link to its GMGN and
 * Birdeye profiles so those numbers are one tap away, and any stats present in
 * the local watchlist are surfaced as user-supplied. Emitting invented win
 * rates would be worse than emitting none.
 *
 * ── DYNAMIC EXPANSION SAFETY ────────────────────────────────────────────────
 * Auto-adding wallets to a tracking net is the kind of feature that quietly
 * destroys itself: one CEX hot wallet funds thousands of unrelated users, so
 * naive expansion would enrol half of Solana within a day and every token would
 * "match smart money".
 *
 * Three guards:
 *   1. HIGH-DEGREE FUNDERS ARE REJECTED. A funder seen distributing to more
 *      than `maxFunderDegree` wallets is an exchange, not a cabal treasury.
 *   2. Expansion only proceeds from a wallet ALREADY tracked, so the net grows
 *      along evidence rather than from any random co-buyer.
 *   3. Hard caps per run and in total, with provenance recorded per entry.
 *
 * Discoveries are written to `discovered_wallets.json`, NOT `smart_wallets.json`
 * — the latter is regenerated wholesale by auto_top_whales.mjs every two hours
 * and would erase them. The watchlist loader merges both.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { traceFunder } from './insider_cluster.mjs';

/* ------------------------------------------------------------------ *
 * Profile links
 * ------------------------------------------------------------------ */

/**
 * Deep links for a wallet. All three block scripted requests (403), which is
 * anti-scraping, not a bad URL — they open normally from a phone.
 */
export function walletLinks(address) {
  return {
    solscan: `https://solscan.io/account/${address}`,
    gmgn: `https://gmgn.ai/sol/address/${address}`,
    birdeye: `https://birdeye.so/profile/${address}`,
  };
}

/* ------------------------------------------------------------------ *
 * Discovered-wallet store
 * ------------------------------------------------------------------ */

export async function loadDiscovered(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return { wallets: raw.wallets ?? [], updatedAt: raw.updatedAt ?? null };
  } catch {
    return { wallets: [], updatedAt: null };
  }
}

export async function saveDiscovered(path, store) {
  await mkdir(dirname(path), { recursive: true });
  store.updatedAt = new Date().toISOString();
  await writeFile(
    path,
    JSON.stringify(
      {
        _comment: [
          'AUTO-DISCOVERED wallets from on-chain network expansion.',
          '',
          'Kept SEPARATE from smart_wallets.json on purpose: that file is',
          'regenerated wholesale by auto_top_whales.mjs every 2 hours, which',
          'would erase anything appended to it. The watchlist loader merges both.',
          '',
          'Every entry records why it was added. Wallets reached through a',
          'high-degree funder (an exchange) are never enrolled — see',
          'network_discovery.mjs for the guards.',
        ],
        ...store,
      },
      null,
      2
    ),
    'utf8'
  );
}

/* ------------------------------------------------------------------ *
 * Cluster graph (the "Bubblemaps" logic, computed from chain)
 * ------------------------------------------------------------------ */

/**
 * Group wallets into clusters by shared funding origin.
 *
 * `funderDegree` counts how many distinct wallets each funder has been seen
 * distributing to across this run. That count is the exchange detector: a cabal
 * treasury funds a handful of wallets, a CEX hot wallet funds everyone.
 */
export function buildClusterGraph(traced, cfg = {}) {
  const maxDegree = cfg.maxFunderDegree ?? 6;

  const byFunder = new Map();
  for (const t of traced) {
    if (!t.funder) continue;
    if (!byFunder.has(t.funder)) byFunder.set(t.funder, []);
    byFunder.get(t.funder).push(t);
  }

  const clusters = [];
  const rejected = [];

  for (const [funder, members] of byFunder) {
    if (members.length < 2) continue;
    if (members.length > maxDegree) {
      // Almost certainly an exchange. Recorded so the rejection is visible
      // rather than looking like the detector simply found nothing.
      rejected.push({ funder, degree: members.length, reason: 'high-degree funder (exchange)' });
      continue;
    }
    clusters.push({
      funder,
      funderLinks: walletLinks(funder),
      members: members.map((m) => ({
        wallet: m.wallet,
        fundedSol: m.fundedSol,
        fundedAt: m.fundedAt,
        links: walletLinks(m.wallet),
      })),
      size: members.length,
      confidence: members.length >= 3 ? 'high' : 'moderate',
    });
  }

  clusters.sort((a, b) => b.size - a.size);
  return { clusters, rejectedFunders: rejected };
}

/* ------------------------------------------------------------------ *
 * Discovery + expansion
 * ------------------------------------------------------------------ */

/**
 * Trace a set of buyers, cluster them, and enrol newly-found cluster members
 * that are connected to an already-tracked wallet.
 */
export async function discoverNetwork({
  buyers,
  watchlist,
  rpcUrl,
  config,
  funderCache = {},
  discoveredStore,
  token = null,
}) {
  const cfg = config.networkDiscovery ?? {};
  if (cfg.enabled === false || !buyers?.length) {
    return { clusters: [], added: [], traced: 0 };
  }

  const traceLimit = cfg.traceTopBuyers ?? 10;
  const candidates = [...buyers]
    .sort((a, b) => (b.solSpent ?? 0) - (a.solSpent ?? 0))
    .slice(0, traceLimit);

  const traced = [];
  for (const b of candidates) {
    const f = await traceFunder(b.wallet, rpcUrl, funderCache, cfg);
    if (f.ok && f.fresh && f.funder) {
      traced.push({ wallet: b.wallet, funder: f.funder, fundedSol: f.fundedSol, fundedAt: f.fundedAt });
    }
    await new Promise((r) => setTimeout(r, cfg.rpcDelayMs ?? 150));
  }

  const { clusters, rejectedFunders } = buildClusterGraph(traced, cfg);

  // ---- expansion ---------------------------------------------------
  const known = new Set(watchlist?.index?.keys() ?? []);
  const alreadyDiscovered = new Set((discoveredStore?.wallets ?? []).map((w) => w.address));
  const maxPerRun = cfg.maxAddedPerRun ?? 5;
  const maxTotal = cfg.maxDiscoveredTotal ?? 200;

  const added = [];
  for (const cluster of clusters) {
    // Guard 2: only expand from clusters that already contain a tracked wallet.
    // Without this the net grows from any co-buying strangers.
    const anchor = cluster.members.find((m) => known.has(m.wallet));
    if (!anchor) continue;

    for (const m of cluster.members) {
      if (added.length >= maxPerRun) break;
      if ((discoveredStore?.wallets?.length ?? 0) + added.length >= maxTotal) break;
      if (known.has(m.wallet) || alreadyDiscovered.has(m.wallet)) continue;

      added.push({
        address: m.wallet,
        label: `Cabal Cluster (funder ${cluster.funder.slice(0, 6)}…)`,
        source: 'network-discovery',
        discovered_at: new Date().toISOString(),
        // Provenance: exactly why this wallet was enrolled.
        provenance: {
          sharedFunder: cluster.funder,
          clusterSize: cluster.size,
          confidence: cluster.confidence,
          anchorWallet: anchor.wallet,
          seenOnToken: token,
          fundedSol: m.fundedSol,
        },
        solscan: m.links.solscan,
        gmgn: m.links.gmgn,
        birdeye: m.links.birdeye,
        // No win_rate / trades / net_profit — those cannot be fetched (GMGN
        // 403, Birdeye 401). Left absent rather than invented; the profile
        // links above are how you check them.
        enabled: true,
      });
      alreadyDiscovered.add(m.wallet);
    }
  }

  if (added.length && discoveredStore) {
    discoveredStore.wallets.push(...added);
  }

  return { clusters, rejectedFunders, added, traced: traced.length };
}
