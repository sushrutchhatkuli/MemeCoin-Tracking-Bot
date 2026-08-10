/**
 * Insider Cluster & Non-Routine Buying Detector.
 *
 * Three independent signals, adapted from the equities "cluster buying" idea.
 * The adaptation matters: in equities the insiders are known by name from
 * mandatory filings. On-chain there is no registry, so identity has to be
 * inferred from behaviour — which is weaker evidence and is treated as such.
 *
 *   PILLAR 1  Cluster buying   — 2+ tracked (or co-funded) wallets buying the
 *                                same token within a short window of launch.
 *                                One buyer is a coincidence; several arriving
 *                                together within seconds is coordination.
 *   PILLAR 2  Non-routine size — a single buy far larger than the pool can
 *                                absorb. Size is the one thing that cannot be
 *                                faked: moving 5+ SOL into a minute-old token
 *                                is a conviction bet or a bundle leg.
 *   PILLAR 3  Funder graph     — wallets whose FIRST funding came from the same
 *                                source. This is the strongest structural tell,
 *                                because a cabal spins up fresh wallets from one
 *                                treasury before a launch.
 *
 * WHAT THIS CANNOT DO, stated plainly:
 *   - It cannot prove insider knowledge. It shows coordination, and coordination
 *     is consistent with both a cabal and a copy-trading bot following the same
 *     public signal.
 *   - Funder tracing only works on wallets with fewer than 1000 lifetime
 *     signatures. Beyond that the RPC cannot reach the first transaction, so
 *     established wallets are excluded — which is fine, since a cabal's
 *     purpose-made wallets are always fresh.
 *   - A shared funder is often just a CEX hot wallet. Thousands of unrelated
 *     users withdraw from the same Binance address. That is why a shared funder
 *     alone is reported, not scored, unless it coincides with cluster timing.
 */

// The cabal spend floor lives in audit.mjs with the other gates, so the bundle
// TAG here and the insider tier gate there apply one definition rather than two
// that can drift. audit.mjs imports nothing, so this cannot cycle.
import { evaluateBundleSpendFloor } from './audit.mjs';

const SIG_PAGE = 1000;

async function rpc(url, method, params, timeoutMs = 20000) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (body.error) return { error: `${body.error.code}: ${body.error.message}`.slice(0, 120) };
    return { result: body.result };
  } catch (err) {
    return { error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * PILLAR 3 — funder tracing
 * ------------------------------------------------------------------ */

/**
 * Find who funded a wallet, by reading its earliest transaction.
 *
 * Returns fresh:false when the wallet has 1000+ signatures — the RPC page limit
 * means we cannot see its origin, and an established trader is not a cabal
 * wallet anyway.
 */
export async function traceFunder(wallet, rpcUrl, cache = {}, cfg = {}) {
  if (cache[wallet]) return cache[wallet];

  const sigs = await rpc(rpcUrl, 'getSignaturesForAddress', [wallet, { limit: SIG_PAGE }]);
  if (sigs.error) return (cache[wallet] = { ok: false, error: sigs.error });

  const list = sigs.result ?? [];
  if (!list.length) return (cache[wallet] = { ok: false, error: 'no history' });
  if (list.length >= SIG_PAGE) {
    return (cache[wallet] = {
      ok: true,
      fresh: false,
      funder: null,
      lifetimeSignatures: `${SIG_PAGE}+`,
      note: 'established wallet — origin beyond RPC page limit, excluded from cabal analysis',
    });
  }

  const first = list[list.length - 1];
  const tx = await rpc(rpcUrl, 'getTransaction', [
    first.signature,
    { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
  ]);
  if (tx.error) return (cache[wallet] = { ok: false, error: tx.error });

  const msg = tx.result?.transaction?.message;
  const meta = tx.result?.meta;
  if (!msg || !meta) return (cache[wallet] = { ok: false, error: 'unparseable first tx' });

  const keys = (msg.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const idx = keys.indexOf(wallet);
  const received = idx >= 0 ? (meta.postBalances[idx] - meta.preBalances[idx]) / 1e9 : 0;

  // The funder is whoever lost the most SOL in the wallet's first transaction.
  const senders = keys
    .map((k, j) => ({ address: k, delta: (meta.postBalances[j] - meta.preBalances[j]) / 1e9 }))
    .filter((x) => x.delta < -0.0001 && x.address !== wallet)
    .sort((a, b) => a.delta - b.delta);

  return (cache[wallet] = {
    ok: true,
    fresh: true,
    funder: senders[0]?.address ?? null,
    fundedSol: Number(received.toFixed(4)),
    fundedAt: first.blockTime ? first.blockTime * 1000 : null,
    lifetimeSignatures: list.length,
  });
}

/* ------------------------------------------------------------------ *
 * Jito bundle / same-slot co-execution
 * ------------------------------------------------------------------ */

/**
 * Detect wallets that bought in the SAME SLOT — the on-chain fingerprint of a
 * Jito bundle.
 *
 * ── WHAT A SLOT MATCH DOES AND DOES NOT PROVE ───────────────────────────────
 * A Jito bundle is a set of transactions submitted for atomic, ordered
 * execution, and they land together in one slot. Standard RPC exposes the slot
 * but NOT a bundle id, so same-slot co-buying is the strongest thing derivable
 * without a second provider — and it is genuinely strong: a Solana slot is
 * ~400ms, and several fresh wallets independently choosing to buy a
 * minutes-old token inside the same 400ms is not plausible coincidence.
 *
 * It is not conclusive on its own. A busy slot on a hot launch can contain
 * unrelated buyers who happened to land together, which is exactly why the
 * threshold is 3+ wallets and not 2, and why the boost is gated on the audit
 * passing like every other multiplier.
 *
 * `confirmBundles` upgrades a slot match to a CONFIRMED bundle by asking Jito's
 * public bundle API which bundle a signature belongs to. That endpoint is live
 * (it answers with structured JSON, 404 + {"error":"Bundle not found"} for an
 * unbundled signature), but it is a third-party service outside this pipeline's
 * control, so it is best-effort: a failure or a timeout downgrades the result
 * to "same slot, unconfirmed" rather than discarding it.
 */
const JITO_BUNDLE_API = 'https://bundles.jito.wtf/api/v1/bundles/transaction';

async function fetchBundleId(signature, timeoutMs = 8000) {
  try {
    const res = await fetch(`${JITO_BUNDLE_API}/${signature}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    // The shape has moved around between Jito revisions; accept the documented
    // variants rather than pinning to one and silently reading undefined.
    const row = Array.isArray(body) ? body[0] : body;
    return row?.bundle_id ?? row?.bundleId ?? row?.bundle?.bundle_id ?? null;
  } catch {
    return null;
  }
}

export async function detectJitoBundles(annotated, cfg = {}, { confirm = true, solUsd = null } = {}) {
  const minWallets = cfg.minBundleWallets ?? 3;
  const launchWindowSec = cfg.bundleLaunchWindowSeconds ?? null;

  const eligible = annotated.filter(
    (a) =>
      a.slot !== null &&
      a.slot !== undefined &&
      (launchWindowSec === null ||
        a.secondsAfterLaunch === null ||
        a.secondsAfterLaunch === undefined ||
        a.secondsAfterLaunch <= launchWindowSec)
  );
  if (eligible.length < minWallets) return { detected: false, groups: [] };

  const bySlot = new Map();
  for (const a of eligible) {
    if (!bySlot.has(a.slot)) bySlot.set(a.slot, []);
    bySlot.get(a.slot).push(a);
  }

  // De-duplicate by wallet inside a slot: one wallet with two legs in the same
  // slot is one participant, not two, and counting legs would manufacture a
  // three-wallet "cabal" out of a single busy trader.
  const sameSlot = [...bySlot.entries()]
    .map(([slot, members]) => {
      const unique = [...new Map(members.map((m) => [m.wallet, m])).values()];
      return { slot, members: unique, size: unique.length };
    })
    .filter((g) => g.size >= minWallets)
    .sort((a, b) => b.size - a.size || a.slot - b.slot);

  if (!sameSlot.length) return { detected: false, groups: [] };

  // ---- Micro-bundle blocking ---------------------------------------
  //
  // Timing alone is not a cabal. Three wallets spending 0.01 SOL each inside
  // one slot satisfies every structural test above and represents nothing —
  // and manufacturing exactly that is the cheapest way to buy a bundle tag,
  // which leads the alert header and carries +25. Groups are re-formed from
  // only the members that cleared the per-wallet floor, so a genuine bundle
  // with a dust wallet riding along survives; a bundle that IS dust does not.
  const graded = sameSlot
    .map((g) => {
      const spend = evaluateBundleSpendFloor({ members: g.members, config: { insiderCluster: cfg }, solUsd });
      return { ...g, spend, members: spend.qualifying, size: spend.qualifying.length };
    })
    .sort((a, b) => b.size - a.size || a.slot - b.slot);

  const groups = graded.filter((g) => g.spend.passed);

  if (!groups.length) {
    // Reported rather than silently dropped: "three wallets co-executed but the
    // whole bundle was 0.04 SOL" is a fact worth having in the audit output,
    // and it is not the same as "no same-slot activity at all".
    const best = graded[0];
    return {
      detected: false,
      groups: [],
      blockedByCabalSpendFloor: true,
      sameSlotGroups: sameSlot.length,
      spend: best?.spend ?? null,
      detail: best ? `Same-slot group rejected — ${best.spend.detail}` : null,
    };
  }

  // Best-effort Jito confirmation on the largest group only — one API call per
  // wallet, and the marginal value of confirming a second group is low.
  let bundleId = null;
  let confirmed = false;
  if (confirm && cfg.confirmViaJitoApi !== false) {
    const ids = new Map();
    for (const m of groups[0].members.slice(0, cfg.maxBundleLookups ?? 4)) {
      if (!m.signature) continue;
      const id = await fetchBundleId(m.signature);
      if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    for (const [id, count] of ids) {
      if (count >= minWallets) {
        bundleId = id;
        confirmed = true;
        break;
      }
    }
  }

  const lead = groups[0];
  const spendNote = `, ${lead.spend.totalSol.toFixed(2)} SOL${lead.spend.totalUsd ? ` ($${Math.round(lead.spend.totalUsd).toLocaleString('en-US')})` : ''} combined`;
  return {
    detected: true,
    confirmed,
    bundleId,
    slot: lead.slot,
    size: lead.size,
    groups,
    spend: lead.spend,
    scoreBonus: cfg.bundleScoreBonus ?? 25,
    label: confirmed ? 'JITO BUNDLE CONFIRMED' : 'SAME-SLOT CO-EXECUTION',
    detail: confirmed
      ? `${lead.size} wallets in Jito bundle ${String(bundleId).slice(0, 12)}… (slot ${lead.slot})${spendNote}`
      : `${lead.size} wallets executed in the same slot (${lead.slot}) — bundle id not confirmed${spendNote}`,
  };
}

/* ------------------------------------------------------------------ *
 * Detector
 * ------------------------------------------------------------------ */

const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function detectInsiderClusters({
  buyers,
  watchlist,
  pairCreatedAt,
  liquidityUsd,
  solUsd,
  config,
  rpcUrl,
  funderCache = {},
}) {
  const cfg = config.insiderCluster ?? {};
  const windowSec = cfg.clusterWindowSeconds ?? 60;
  const minSol = cfg.unusualBuySol ?? 5;
  const lpPct = cfg.unusualBuyLpPct ?? 5;
  const minCluster = cfg.minClusterWallets ?? 2;
  const traceTop = cfg.traceTopBuyers ?? 8;

  const empty = {
    detected: false,
    clusterBuying: null,
    oversized: [],
    networks: [],
    tracedWallets: 0,
    label: null,
  };
  if (!buyers?.length) return empty;

  // ---- annotate each buyer -----------------------------------------
  const annotated = buyers.map((b) => {
    const hit = watchlist?.index?.get(b.wallet) ?? null;
    const secondsAfterLaunch =
      pairCreatedAt && b.blockTime ? (b.blockTime * 1000 - pairCreatedAt) / 1000 : null;
    const usdSpent = b.solSpent && solUsd ? b.solSpent * solUsd : null;
    return {
      wallet: b.wallet,
      short: shortAddr(b.wallet),
      solscan: `https://solscan.io/account/${b.wallet}`,
      label: hit?.label ?? null,
      watchlisted: Boolean(hit),
      solSpent: b.solSpent ?? null,
      usdSpent,
      tokensBought: b.amount,
      blockTime: b.blockTime,
      slot: b.slot ?? null,
      signature: b.signature ?? null,
      secondsAfterLaunch,
      entryMarketCapUsd: b.entryMarketCapUsd ?? null,
    };
  });

  // Slot analysis runs on EVERY buyer, before the watchlist/oversize gate that
  // guards funder tracing. It needs no extra RPC — the slot arrived with the
  // signature listing — and a bundle of three fresh wallets is exactly the case
  // where none of them is watchlisted yet, so gating it would blind the tracer
  // to the cabals it exists to catch.
  const jito = await detectJitoBundles(annotated, cfg, {
    confirm: cfg.confirmViaJitoApi !== false,
    solUsd,
  });

  // ---- PILLAR 2: non-routine sizing --------------------------------
  // Evaluated first because it needs no RPC and often stands alone.
  const lpThresholdSol = liquidityUsd && solUsd ? (liquidityUsd * (lpPct / 100)) / solUsd : null;
  const oversized = annotated
    .filter((a) => a.solSpent !== null)
    .filter((a) => a.solSpent > minSol || (lpThresholdSol && a.solSpent > lpThresholdSol))
    .map((a) => ({
      ...a,
      reason:
        a.solSpent > minSol
          ? `${a.solSpent.toFixed(2)} SOL exceeds the ${minSol} SOL single-buy threshold`
          : `${a.solSpent.toFixed(2)} SOL exceeds ${lpPct}% of the pool`,
    }))
    .sort((a, b) => b.solSpent - a.solSpent);

  // ---- PILLAR 3: funder graph --------------------------------------
  //
  // Gated behind the two free pillars. Tracing costs two RPC calls per wallet,
  // and running it on every token pushed a full scan past ten minutes — longer
  // than the 12-minute schedule interval, which would have caused runs to
  // overlap or be skipped. Pillars 1 and 2 need no network calls, so if neither
  // found anything there is nothing for a funder graph to corroborate.
  const watchlistedBuyers = annotated.filter((a) => a.watchlisted);
  const worthTracing = watchlistedBuyers.length > 0 || oversized.length > 0;

  if (!worthTracing && !jito.detected) {
    return {
      ...empty,
      buyersSeen: annotated.length,
      oversized,
      watchlisted: [],
      jito,
      skippedFunderTrace: 'no watchlist match or oversized buy to corroborate',
    };
  }

  // Only the largest buyers are traced; the tail of dust buyers is not where
  // coordination shows up.
  const toTrace = [...annotated]
    .sort((a, b) => (b.solSpent ?? 0) - (a.solSpent ?? 0))
    .slice(0, traceTop);

  const byFunder = new Map();
  let traced = 0;
  for (const a of toTrace) {
    const f = await traceFunder(a.wallet, rpcUrl, funderCache, cfg);
    if (!f.ok || !f.fresh || !f.funder) continue;
    traced++;
    a.funder = f.funder;
    a.fundedSol = f.fundedSol;
    a.fundedAt = f.fundedAt;
    if (!byFunder.has(f.funder)) byFunder.set(f.funder, []);
    byFunder.get(f.funder).push(a);
  }

  const networks = [...byFunder.entries()]
    .filter(([, members]) => members.length >= minCluster)
    .map(([funder, members]) => ({
      funder,
      funderShort: shortAddr(funder),
      funderSolscan: `https://solscan.io/account/${funder}`,
      members,
      size: members.length,
      totalSol: members.reduce((s, m) => s + (m.solSpent ?? 0), 0),
    }))
    .sort((a, b) => b.size - a.size);

  // ---- PILLAR 1: cluster buying ------------------------------------
  // Either several watchlisted wallets, or several co-funded ones, arriving
  // inside the launch window together.
  const inWindow = (a) =>
    a.secondsAfterLaunch !== null && a.secondsAfterLaunch >= 0 && a.secondsAfterLaunch <= windowSec;

  const watchlistedEarly = annotated.filter((a) => a.watchlisted && inWindow(a));
  const coFundedEarly = networks.flatMap((n) => n.members.filter(inWindow));

  const clusterMembers = [
    ...new Map([...watchlistedEarly, ...coFundedEarly].map((a) => [a.wallet, a])).values(),
  ].sort((a, b) => (a.secondsAfterLaunch ?? 0) - (b.secondsAfterLaunch ?? 0));

  const clusterBuying =
    clusterMembers.length >= minCluster
      ? {
          size: clusterMembers.length,
          members: clusterMembers,
          windowSec,
          fromWatchlist: watchlistedEarly.length,
          fromFunderNetwork: coFundedEarly.length,
        }
      : null;

  // Watchlisted buyers outside the launch window still matter, just not as a
  // "cluster" — reported separately rather than silently dropped.
  const watchlistedAny = annotated.filter((a) => a.watchlisted);

  // Pillar 2 counts on its own: a buy far larger than the pool can absorb is a
  // signal in itself, with or without a cluster around it.
  // A confirmed same-slot bundle counts on its own, like non-routine size does.
  // Several fresh wallets executing inside one ~400ms slot is coordination by
  // construction, whether or not any of them is already on a watchlist.
  const detected =
    Boolean(clusterBuying) ||
    networks.length > 0 ||
    watchlistedAny.length > 0 ||
    oversized.length > 0 ||
    jito.detected;

  // Single authoritative roster of DISTINCT insider wallets. The three sources
  // overlap heavily — a watchlisted wallet that also bought early and shares a
  // funder appears in all of them — so the scaling multiplier must count unique
  // addresses, not list lengths, or one wallet would score as three.
  const insiderRoster = new Map();
  for (const a of watchlistedAny) insiderRoster.set(a.wallet, a);
  for (const a of clusterMembers) if (!insiderRoster.has(a.wallet)) insiderRoster.set(a.wallet, a);
  for (const n of networks) {
    for (const a of n.members) if (!insiderRoster.has(a.wallet)) insiderRoster.set(a.wallet, a);
  }
  for (const g of jito.groups ?? []) {
    for (const a of g.members) if (!insiderRoster.has(a.wallet)) insiderRoster.set(a.wallet, a);
  }
  const uniqueInsiders = [...insiderRoster.values()].sort(
    (a, b) => (b.solSpent ?? 0) - (a.solSpent ?? 0)
  );

  let label = null;
  // A slot-level bundle outranks the count-based labels: it is the most
  // specific structural claim the tracer can make about how the buys happened.
  if (jito.detected) label = jito.confirmed ? 'JITO BLOCK #0 CABAL BUNDLE' : 'SAME-SLOT CABAL BUNDLE';
  else if (uniqueInsiders.length >= 4) label = 'CABAL SWARM';
  else if (clusterBuying && networks.length) label = 'CABAL BUNDLE NETWORK';
  else if (clusterBuying) label = 'INSIDER CLUSTER';
  else if (networks.length) label = 'SHARED FUNDER NETWORK';
  else if (watchlistedAny.length) label = 'INSIDER TRACKED';
  else if (oversized.length) label = 'NON-ROUTINE BUY SIZE';

  return {
    detected,
    label,
    clusterBuying,
    oversized,
    networks,
    watchlisted: watchlistedAny,
    uniqueInsiders,
    insiderCount: uniqueInsiders.length,
    tracedWallets: traced,
    buyersSeen: annotated.length,
    jito,
  };
}

/**
 * Multi-insider scaling multiplier.
 *
 * Scales with the count of DISTINCT insider wallets, because several
 * independent wallets converging on one token in the launch window is far
 * stronger evidence than one wallet doing something unusual:
 *
 *   1 wallet   +15   Insider Tracked
 *   2 wallets  +25   Dual Insider Cluster
 *   3 wallets  +35   Strong Cabal Cluster
 *   4+ wallets +50   Cabal Swarm
 *
 * Applied ONLY when every safety gate passed — enforced by the caller in
 * audit.mjs, which zeroes this on any gate failure. That ordering is the whole
 * point: without it, a cabal buying its own rug would score higher than a clean
 * token, which is precisely the manipulation the shield exists to defeat.
 *
 * A note on the score that results: this is ADDITIVE to the fundamentals, so a
 * swarm lands at (base + 50) clamped to 100. A token with weak demand and thin
 * liquidity will NOT reach 90 on insider count alone, and that is deliberate —
 * four wallets buying an illiquid token is a reason to look, not a reason to
 * override what the market data says.
 */
export function clusterScoreBonus(clusters, config) {
  if (!clusters?.detected) return 0;
  const cfg = config.insiderCluster ?? {};
  const tiers = cfg.insiderScaleTiers ?? { 1: 15, 2: 25, 3: 35, 4: 50 };

  // Same-slot execution is additive to the wallet-count multiplier: "how many
  // insiders" and "did they execute atomically" are different facts, and a
  // bundle is the stronger of the two. Clamped by the caller along with every
  // other bonus.
  const bundleBonus = clusters.jito?.detected ? (cfg.bundleScoreBonus ?? 25) : 0;

  const count = clusters.insiderCount ?? 0;
  if (count >= 1) {
    const keys = Object.keys(tiers)
      .map(Number)
      .sort((a, b) => a - b);
    let bonus = 0;
    for (const k of keys) if (count >= k) bonus = tiers[k];
    return bonus + bundleBonus;
  }

  // No identified insider wallets, but a non-routine buy size still counts —
  // it is Pillar 2 standing alone.
  if (clusters.oversized?.length) return (cfg.bonusOversized ?? 5) + bundleBonus;
  return bundleBonus;
}

/** Human-readable tier name for the alert header. */
export function insiderTierLabel(count) {
  if (count >= 4) return 'CABAL SWARM';
  if (count === 3) return 'STRONG CABAL CLUSTER';
  if (count === 2) return 'DUAL INSIDER CLUSTER';
  if (count === 1) return 'INSIDER TRACKED';
  return null;
}
