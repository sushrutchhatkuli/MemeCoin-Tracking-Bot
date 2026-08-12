#!/usr/bin/env node
/**
 * Standalone candidate discovery.
 *
 *   node discovery_daemon.mjs               refresh every 60s
 *   node discovery_daemon.mjs --interval 45 custom cadence, seconds
 *   node discovery_daemon.mjs --once        one refresh, then exit
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE PROCESS
 *
 * Discovery is a FIXED cost that does not shrink with the audit limit: the same
 * launch feeds and search queries run whether a tick audits 4 tokens or 40. On
 * the scan loop it therefore sat in front of every tick, and lowering
 * `scanLimit` — the obvious lever for a faster loop — did nothing to it.
 *
 * Moving it here decouples the two. The daemon refreshes the candidate pool on
 * its own timer; the scanner reads the file and starts auditing immediately.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HANDOFF, and what happens when this is not running
 *
 * The file carries `generatedAt`. scan.mjs uses it only while it is FRESH and
 * falls back to discovering inline when it is stale or absent, so stopping this
 * daemon costs latency, never coverage — the same failure posture as the
 * liquidity poller.
 *
 * That fallback matters more than it looks: auditing a stale candidate list is
 * worse than a slow scan, because the tokens that matter here are minutes old
 * and a five-minute-old pool of "fresh launches" is largely the previous
 * window's. Staleness is bounded by discovery.maxCandidateAgeSeconds.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { discoverCandidates } from './sources.mjs';
import { PUMP_FUN_PROGRAM } from './smart_money.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SURFACED_PATH = join(HERE, '.state', 'surfaced_candidates.json');

/* ------------------------------------------------------------------ *
 * Multi-node RPC failover pool
 * ------------------------------------------------------------------ *
 *
 * Tries the primary endpoint, and on a QUOTA or availability failure moves to
 * the next node and stays there. Built after a live sync died on Helius
 * returning HTTP 429 "max usage reached", which no amount of retrying clears.
 *
 * ── WHAT CAN AND CANNOT FAIL OVER ───────────────────────────────────────────
 * Standard JSON-RPC only: getSignaturesForAddress, getTransaction,
 * getAccountInfo, getBalance and friends. Those are the same on every node.
 *
 * It does NOT cover Helius's enhanced endpoints. The whale enrichment reads
 * api.helius.xyz/v0/addresses/{a}/transactions, which returns pre-parsed
 * transactions no generic node offers — there is nothing to fail over TO, and
 * pretending otherwise would swap a clear quota error for a confusing parse
 * failure. getTokenLargestAccounts is similar in practice: sources.mjs already
 * records that every keyless endpoint refuses it.
 *
 * ── "0 MILLISECOND" FAILOVER ────────────────────────────────────────────────
 * The DECISION is immediate — no backoff, no sleep, no retry of the dead node.
 * The elapsed time is not zero: it is the failed request plus the successful
 * one on the next node, and a connection-refused failure can take longer than a
 * clean 429. What is genuinely zero is the delay this code adds.
 *
 * Once a node fails it is put in cooldown and SKIPPED, so the cost is paid once
 * rather than on every subsequent call. Without that stickiness a pass of 200
 * wallets against a dead primary pays 200 failures to learn the same fact.
 *
 * ── ON THE ENDPOINT LIST ────────────────────────────────────────────────────
 * NONE OF THE PUBLIC ENDPOINTS COULD BE VERIFIED FROM THE MACHINE THIS WAS
 * WRITTEN ON. rpc.ankr.com, api.mainnet-beta.solana.com, solana.drpc.org and
 * solana-rpc.publicnode.com all failed at the connection layer (ECONNRESET, or
 * a 10s connect timeout) while a control request to DexScreener succeeded — an
 * environment-level block on those hosts, not evidence about the endpoints.
 *
 * They are therefore shipped DISABLED, with a checker so they can be verified
 * from a network that can reach them:
 *
 *   node discovery_daemon.mjs --check-rpc
 *
 * Enabling an unverified endpoint is worse than having none: failover would
 * "succeed" onto a node that answers nothing, converting a loud quota error
 * into silent, wrong results.
 */

/** A failure that should move to the next node rather than be retried here. */
export function isFailoverWorthy(status, body = '') {
  if (status === 429) return true; // rate limit or hard plan cap
  if (status === 402 || status === 403) return true; // credits exhausted / forbidden
  if (status >= 500) return true; // node-side fault
  return /max usage|quota|credit|payment required/i.test(String(body));
}

/**
 * An RPC caller that walks a pool of endpoints.
 *
 * `call(method, params)` resolves `{ ok, result, endpoint }` or
 * `{ ok:false, error, exhausted }` when every node has failed.
 */
export function createRpcPool({
  primary = null,
  endpoints = [],
  cooldownSeconds = 300,
  timeoutMs = 20_000,
  now = () => Date.now(),
  fetchImpl = null,
} = {}) {
  // Primary first, then the configured pool. Disabled entries never enter.
  const nodes = [
    ...(primary ? [{ url: primary, label: 'primary' }] : []),
    ...endpoints.filter((e) => e?.enabled !== false && e?.url).map((e) => ({ url: e.url, label: e.label ?? e.url })),
  ].map((n) => ({ ...n, cooldownUntil: 0, failures: 0, calls: 0 }));

  let cursor = 0;

  const available = () => nodes.filter((n) => n.cooldownUntil <= now());

  const call = async (method, params) => {
    if (!nodes.length) return { ok: false, error: 'no RPC endpoint configured', exhausted: true };

    const doFetch = fetchImpl ?? fetch;
    const tried = [];

    // The starting point is captured BEFORE the loop. Reading the live `cursor`
    // in the index expression while also assigning to it inside the loop made
    // the walk revisit the node it had just retired — with two nodes it went
    // primary, then primary again, and never reached the backup at all.
    const start = cursor;

    for (let i = 0; i < nodes.length; i++) {
      // Sticky: start from the node that last worked, so a dead primary is
      // paid for once rather than at the head of every call.
      const index = (start + i) % nodes.length;
      const node = nodes[index];
      if (node.cooldownUntil > now()) continue;

      tried.push(node.label);
      node.calls++;
      try {
        const res = await doFetch(node.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* quota refusals are plain text */ }

        if (!res.ok || json?.error) {
          if (isFailoverWorthy(res.status, text)) {
            node.failures++;
            node.cooldownUntil = now() + cooldownSeconds * 1000;
            cursor = (index + 1) % nodes.length;
            continue;
          }
          // A method-level error (bad params, unsupported method) is the same
          // on every node. Failing over would just repeat it N times.
          return { ok: false, error: json?.error?.message ?? `HTTP ${res.status}`, endpoint: node.label };
        }

        cursor = index;
        return { ok: true, result: json?.result, endpoint: node.label };
      } catch (err) {
        // A connection error is exactly the case the pool exists for.
        node.failures++;
        node.cooldownUntil = now() + cooldownSeconds * 1000;
        cursor = (index + 1) % nodes.length;
      }
    }

    return {
      ok: false,
      exhausted: true,
      error: `every RPC endpoint failed or is cooling down (tried: ${tried.join(', ') || 'none available'})`,
    };
  };

  return {
    call,
    nodes,
    available,
    stats: () => nodes.map((n) => ({ label: n.label, calls: n.calls, failures: n.failures, cooling: n.cooldownUntil > now() })),
  };
}

/* ------------------------------------------------------------------ *
 * WebSocket mint stream
 * ------------------------------------------------------------------ *
 *
 * A persistent logsSubscribe on the pump.fun program, so a new mint is known
 * the moment it lands rather than whenever a DexScreener feed happens to pick
 * it up.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MEASURED LATENCY, because "0ms" is not a thing and the real numbers change
 * what this feature is for. Sampled against Helius on 2026-08-10:
 *
 *   CreateV2 seen on the socket -> transaction fetchable   570ms (2 attempts)
 *   mint address extracted                                 same call
 *   DexScreener publishes a tradeable pair                 ~30s later, at $0
 *                                                          liquidity
 *
 * The socket half is genuinely sub-second. The pipeline downstream is not, and
 * cannot be: DexScreener has no pair to price for roughly half a minute, and
 * filters.minLiquidityUsd (4,000) and minTxns24h (40) will reject the token for
 * a good while after that.
 *
 * SO WHAT THIS ACTUALLY BUYS, stated honestly, is not a 0ms entry:
 *   1. COVERAGE. The daemon's feeds are boost/profile/search listings, which
 *      are selective — many pump.fun launches never appear in them at all.
 *      Every CreateV2 does. This is the larger win by far.
 *   2. A TRUSTWORTHY BIRTH TIMESTAMP. `pairCreatedAt` is absent on 3.3% of
 *      pairs and is pool creation, not mint creation. This is the mint, to the
 *      slot, and it is what the insider and momentum "early" windows key on.
 *   3. POSITION IN THE QUEUE. A streamed mint is flagged so the scanner can
 *      audit it ahead of the volume-sorted pool, where a zero-volume newborn
 *      would otherwise sort last and never be reached.
 *
 * ── ON THE INSTRUCTION NAME ─────────────────────────────────────────────────
 * It is `CreateV2`, NOT `Create`. Measured: a 20-second subscription filtering
 * on /Instruction: Create\b/ matched 0 of 17,384 notifications, because the
 * program moved on. A 30-second sample filtering on anything creation-shaped
 * found 12 CreateV2 (~24/min) and zero bare Create from this program. `Create`
 * is kept in the pattern list as a legacy fallback and because the associated
 * token account program logs a bare "Program log: Create" that must NOT match —
 * hence the `Instruction: ` prefix being part of the pattern.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * pump.fun. Verified on-chain: exists, executable, owned by the BPF loader.
 *
 * Imported from smart_money.mjs rather than redeclared — it was already there
 * for bonding-curve replay, and two copies of a program id is how one of them
 * ends up stale while both look authoritative. Re-exported so callers of this
 * module do not need to know which file owns it.
 */
export { PUMP_FUN_PROGRAM };

/**
 * Creation instructions, most current first.
 *
 * Anchored on "Instruction: " deliberately. The associated-token-account
 * program emits a bare `Program log: Create` inside almost every one of these
 * transactions, and matching that would tag every buy as a launch.
 */
export const CREATE_LOG_PATTERNS = [/Program log: Instruction: CreateV2\b/, /Program log: Instruction: Create\b/];

/** True when this log array is a token creation. Pure. */
export function isMintCreation(logs) {
  if (!Array.isArray(logs)) return false;
  return logs.some((l) => typeof l === 'string' && CREATE_LOG_PATTERNS.some((re) => re.test(l)));
}

/**
 * The new mint from a creation transaction. Pure.
 *
 * pump.fun vanity-suffixes its mints with "pump", which is the cheap and
 * reliable signal. The fallback reads the account the Token-2022 program
 * initialised, so a change to the vanity convention degrades to a slower path
 * rather than to silence.
 */
export function extractMintFromTransaction(tx) {
  const message = tx?.transaction?.message;
  const keys = (message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k?.pubkey)).filter(Boolean);
  if (!keys.length) return null;

  const vanity = keys.find((k) => k.endsWith('pump'));
  if (vanity) return vanity;

  // Fallback: the mint is the account InitializeMint2 was invoked on. Read from
  // the parsed instruction rather than guessed from position.
  const all = [
    ...(message?.instructions ?? []),
    ...((tx?.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? [])),
  ];
  for (const ix of all) {
    const type = ix?.parsed?.type;
    if (type === 'initializeMint2' || type === 'initializeMint') {
      const mint = ix?.parsed?.info?.mint;
      if (mint) return mint;
    }
  }
  return null;
}

/**
 * Merge streamed mints into the polled candidate pool.
 *
 * Pure, and the reason it exists is a clobbering bug rather than tidiness:
 * refreshOnce rewrites the whole file every 60 seconds, so a mint written by
 * the socket at t+0.6s would be erased by the next poll long before
 * DexScreener had a pair for it — the feature would appear to work and deliver
 * nothing.
 *
 * Streamed entries therefore SURVIVE a refresh until they either age out or are
 * superseded by a richer polled entry for the same token. Polled entries win on
 * a collision because they carry socialHints the socket cannot know.
 */
export function mergeCandidates({
  existing = [],
  incoming = [],
  now = Date.now(),
  ttlSeconds = 900,
  maxTracked = 400,
} = {}) {
  const byAddress = new Map();

  // Surviving streamed entries first, so a later polled entry for the same mint
  // overwrites them and keeps its social hints.
  for (const c of existing) {
    if (!c?.tokenAddress) continue;
    if (c.via !== 'ws-mint') continue;
    const ageSec = c.firstSeenAt ? (now - c.firstSeenAt) / 1000 : Infinity;
    if (ageSec > ttlSeconds) continue;
    byAddress.set(c.tokenAddress, c);
  }

  for (const c of incoming) {
    if (!c?.tokenAddress) continue;
    const prior = byAddress.get(c.tokenAddress);
    byAddress.set(c.tokenAddress, {
      ...c,
      // A token the socket saw first keeps that provenance and its timestamp
      // even once the feeds catch up — it is the earliest thing known about it.
      ...(prior?.via === 'ws-mint'
        ? { firstSeenAt: prior.firstSeenAt, streamed: true }
        : {}),
    });
  }

  const merged = [...byAddress.values()];
  // Newest streamed first, then everything else. The cap trims the tail.
  merged.sort((a, b) => (b.streamed || b.via === 'ws-mint' ? 1 : 0) - (a.streamed || a.via === 'ws-mint' ? 1 : 0) || (b.firstSeenAt ?? 0) - (a.firstSeenAt ?? 0));
  return merged.slice(0, maxTracked);
}

export async function loadSurfaced(path = SURFACED_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return {
      generatedAt: raw.generatedAt ?? 0,
      candidates: Array.isArray(raw.candidates) ? raw.candidates : [],
      stats: raw.stats ?? null,
    };
  } catch {
    return { generatedAt: 0, candidates: [], stats: null };
  }
}

export async function saveSurfaced(payload, path = SURFACED_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * Is the surfaced pool fresh enough to audit from?
 *
 * Returns the age too, so the caller can say WHY it fell back rather than
 * silently doing something different from what the operator expects.
 */
export function surfacedFreshness(surfaced, maxAgeSeconds, now = Date.now()) {
  const generatedAt = surfaced?.generatedAt ?? 0;
  const ageSec = generatedAt ? (now - generatedAt) / 1000 : Infinity;
  return {
    fresh: generatedAt > 0 && ageSec <= maxAgeSeconds && (surfaced.candidates?.length ?? 0) > 0,
    ageSec,
    count: surfaced?.candidates?.length ?? 0,
  };
}

export async function refreshOnce({ config, path = SURFACED_PATH, now = Date.now() }) {
  const { candidates, stats } = await discoverCandidates(config.chains, config.discovery);
  const cfg = config.discovery?.mintStream ?? {};

  // MERGE, never overwrite. See mergeCandidates: a wholesale rewrite here would
  // erase every streamed mint within 60 seconds of it arriving, which is well
  // before DexScreener has a pair for it.
  const prior = await loadSurfaced(path);
  const merged = mergeCandidates({
    existing: prior.candidates,
    incoming: candidates,
    now,
    ttlSeconds: cfg.ttlSeconds ?? 900,
    maxTracked: cfg.maxTracked ?? 400,
  });

  const streamed = merged.filter((c) => c.via === 'ws-mint' || c.streamed).length;
  const payload = {
    generatedAt: now,
    stats: { ...stats, streamedRetained: streamed, total: merged.length },
    candidates: merged,
  };
  await saveSurfaced(payload, path);
  return payload;
}

/**
 * Append streamed mints to the surfaced pool.
 *
 * Read-modify-write against a file the daemon's own poll also writes. That race
 * is real but benign at these rates: a poll every 60s against a mint every ~2.5s
 * means a collision costs at most one streamed entry, which the next mint or
 * poll re-establishes. Locking a file for this would be more machinery than the
 * failure justifies — but it IS a race, and it is written down rather than
 * pretended away.
 */
export async function pushStreamedMints(mints, { path = SURFACED_PATH, config = {}, now = Date.now() } = {}) {
  if (!mints?.length) return { added: 0, total: 0 };
  const cfg = config.discovery?.mintStream ?? {};
  const prior = await loadSurfaced(path);

  const incoming = mints.map((m) => ({
    chainId: 'solana',
    tokenAddress: m.mint,
    socialHints: [],
    via: 'ws-mint',
    streamed: true,
    firstSeenAt: m.seenAt ?? now,
    createdSlot: m.slot ?? null,
    createSignature: m.signature ?? null,
  }));

  const known = new Set(prior.candidates.map((c) => c.tokenAddress));
  const added = incoming.filter((c) => !known.has(c.tokenAddress)).length;

  const merged = mergeCandidates({
    existing: [...prior.candidates, ...incoming],
    incoming: prior.candidates.filter((c) => c.via !== 'ws-mint'),
    now,
    ttlSeconds: cfg.ttlSeconds ?? 900,
    maxTracked: cfg.maxTracked ?? 400,
  });

  await saveSurfaced(
    {
      // The poll's freshness stamp is NOT advanced here. surfacedFreshness gates
      // whether scan.mjs trusts the pool at all, and a socket that keeps the
      // timestamp warm while discovery is dead would make a stale pool look
      // fresh — the exact failure the daemon's fallback exists to prevent.
      generatedAt: prior.generatedAt,
      streamedAt: now,
      stats: { ...(prior.stats ?? {}), streamedRetained: merged.filter((c) => c.via === 'ws-mint').length, total: merged.length },
      candidates: merged,
    },
    path
  );
  return { added, total: merged.length };
}

/**
 * Persistent logsSubscribe on the creation program.
 *
 * Resolves the mint with one getTransaction per creation — the notification
 * carries logs and a signature but no account keys, so there is no way to learn
 * the address from the socket alone. At the measured ~24 creations/minute that
 * is ~1,440 lookups/hour, which is real budget and is why maxLookupsPerMinute
 * exists.
 *
 * getTransaction is called at `confirmed`, NOT the default `finalized`: a
 * notification at `processed` commitment refers to a transaction that finalized
 * lookups cannot see yet. Measured, it becomes fetchable ~570ms and 2 attempts
 * after the notification, so the retry loop is load-bearing rather than
 * defensive.
 */
export async function startMintStream({
  wsUrl,
  rpcUrl,
  config = {},
  onMints,
  log = console.log,
  signal,
  rpcPool = null,
} = {}) {
  const cfg = config.discovery?.mintStream ?? {};
  const program = cfg.program ?? PUMP_FUN_PROGRAM;
  const commitment = cfg.commitment ?? 'processed';
  const maxPerMin = cfg.maxLookupsPerMinute ?? 120;
  const maxBackoff = cfg.maxReconnectBackoffMs ?? 30_000;

  let backoff = cfg.reconnectBackoffMs ?? 1_000;
  const stats = { notifications: 0, creations: 0, resolved: 0, dropped: 0, reconnects: 0 };
  let windowStart = Date.now();
  let windowCount = 0;

  // The mint stream is the heaviest RPC consumer in this file — one
  // getTransaction per creation, ~1,440/hour at the measured rate — so it is
  // the first thing to lose when a plan hits its cap. Routed through the pool.
  const pool =
    rpcPool ??
    createRpcPool({
      primary: rpcUrl,
      endpoints: config.rpcPool?.enabled === true ? (config.rpcPool.endpoints ?? []) : [],
      cooldownSeconds: config.rpcPool?.cooldownSeconds ?? 300,
    });

  let quotaWarned = false;
  const rpc = async (method, params) => {
    const r = await pool.call(method, params);
    if (r.ok) return r.result ?? null;
    if (r.exhausted && !quotaWarned) {
      quotaWarned = true;
      log(`   🔴 [QUOTA] mint stream RPC unavailable — ${r.error}`);
      log('      Creations are still detected on the socket; their mint addresses cannot be');
      log('      resolved until a node recovers, so they are skipped rather than queued wrong.');
    }
    return null;
  };

  const resolveMint = async (signature, slot) => {
    for (let attempt = 0; attempt < (cfg.lookupRetries ?? 4); attempt++) {
      const tx = await rpc('getTransaction', [
        signature,
        { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' },
      ]);
      if (tx) {
        const mint = extractMintFromTransaction(tx);
        return mint ? { mint, signature, slot, seenAt: Date.now() } : null;
      }
      await new Promise((r) => setTimeout(r, cfg.lookupRetryDelayMs ?? 300));
    }
    return null;
  };

  while (!signal?.aborted) {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
      const pending = [];

      await new Promise((settle) => {
        let done = false;
        const finish = (why) => {
          if (done) return;
          done = true;
          try { ws.close(); } catch { /* already closing */ }
          settle(why);
        };

        ws.onopen = () => {
          backoff = cfg.reconnectBackoffMs ?? 1_000;
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'logsSubscribe',
              params: [{ mentions: [program] }, { commitment }],
            })
          );
          log(`   mint stream connected — logsSubscribe on ${program.slice(0, 8)}… (${commitment})`);
        };

        ws.onmessage = async (event) => {
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }
          if (msg.method !== 'logsNotification') return;

          stats.notifications++;
          const value = msg.params?.result?.value;
          if (value?.err) return; // a failed creation created nothing
          if (!isMintCreation(value?.logs)) return;
          stats.creations++;

          // Rate limit the RPC half, not the socket half. Dropping a lookup
          // loses one mint; letting it run unbounded competes with the scanner
          // for the same Helius budget.
          const nowMs = Date.now();
          if (nowMs - windowStart >= 60_000) { windowStart = nowMs; windowCount = 0; }
          if (windowCount >= maxPerMin) { stats.dropped++; return; }
          windowCount++;

          const resolved = await resolveMint(value.signature, msg.params?.result?.context?.slot ?? null);
          if (!resolved) return;
          stats.resolved++;
          pending.push(resolved);
        };

        ws.onerror = () => finish('error');
        ws.onclose = () => finish('closed');

        const drain = setInterval(async () => {
          if (signal?.aborted) { clearInterval(drain); finish('aborted'); return; }
          if (!pending.length) return;
          const batch = pending.splice(0, pending.length);
          try { await onMints?.(batch, stats); } catch (err) { log(`   mint stream write failed: ${err.message}`); }
        }, cfg.flushMs ?? 1_000);

        signal?.addEventListener?.('abort', () => { clearInterval(drain); finish('aborted'); }, { once: true });
      });
    } catch (err) {
      log(`   mint stream error: ${err.message}`);
    }

    if (signal?.aborted) break;
    stats.reconnects++;
    log(`   mint stream disconnected — reconnecting in ${(backoff / 1000).toFixed(1)}s`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  return stats;
}

/** https://host/?x -> wss://host/?x, which is how both Helius and stock RPC expose it. */
export function websocketUrlFor(rpcUrl) {
  if (typeof rpcUrl !== 'string' || !rpcUrl) return null;
  if (rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')) return rpcUrl;
  return rpcUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once');

  // --check-rpc: verify the pool from THIS network before trusting it.
  //
  // Exists because none of the shipped endpoints could be reached from the
  // machine this was written on, and a pool of unreachable nodes is worse than
  // no pool. Each node is asked for a real result, not just a 200.
  if (argv.includes('--check-rpc')) {
    const cfg = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
    const { loadEnv } = await import('./telegram.mjs');
    const env = await loadEnv(join(HERE, '.env'));
    const primary = env.rpcOverride || cfg.rpcUrl;

    const candidates = [
      { label: 'primary (configured)', url: primary },
      ...(cfg.rpcPool?.endpoints ?? []).filter((e) => e.url && !e.url.startsWith('PASTE_')),
    ];

    console.log(`Checking ${candidates.length} endpoint(s). A node must return a real result, not just a 200.\n`);
    const MINT = 'So11111111111111111111111111111111111111112';
    let usable = 0;

    for (const c of candidates) {
      // One single-node pool per candidate, labelled as itself. Passing the url
      // as `primary` made every failure read "tried: primary", which is the
      // label of the node being tested rather than a useful fact.
      const pool = createRpcPool({
        primary: null,
        endpoints: [{ url: c.url, label: c.label ?? c.url, enabled: true }],
        cooldownSeconds: 0,
      });
      const t0 = Date.now();
      const health = await pool.call('getAccountInfo', [MINT, { encoding: 'base64' }]);
      const ms = Date.now() - t0;
      const shown = c.url.replace(/api-key=[\w-]+/, 'api-key=***');

      if (health.ok && health.result) {
        // getSignaturesForAddress is the call the enrichment actually leans on.
        const sigs = await pool.call('getSignaturesForAddress', [MINT, { limit: 2 }]);
        const sigOk = sigs.ok && Array.isArray(sigs.result);
        usable += sigOk ? 1 : 0;
        console.log(`  [${sigOk ? 'OK  ' : 'PART'}] ${(c.label ?? '').padEnd(20)} ${ms}ms  ${shown}`);
        if (!sigOk) console.log(`         getAccountInfo works but getSignaturesForAddress does not: ${sigs.error ?? 'no result'}`);
      } else {
        console.log(`  [FAIL] ${(c.label ?? '').padEnd(20)} ${ms}ms  ${shown}`);
        console.log(`         ${health.error ?? 'no result'}`);
      }
    }

    console.log(`\n${usable}/${candidates.length} endpoint(s) usable from this network.`);
    console.log('Set rpcPool.enabled true and enabled:true on the nodes that passed.');
    console.log('Do NOT enable a node that failed — failover onto a silent node is worse');
    console.log('than a loud quota error.');
    process.exit(0);
  }
  const i = argv.indexOf('--interval');
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  const intervalSec =
    (i !== -1 ? Number(argv[i + 1]) : null) || config.discovery?.daemonIntervalSeconds || 60;

  const stamp = () => new Date().toISOString().slice(11, 19);

  if (!once) {
    console.log('═'.repeat(64));
    console.log('  AEGIS — CANDIDATE DISCOVERY DAEMON');
    console.log('═'.repeat(64));
    console.log(`  cadence : every ${intervalSec}s`);
    console.log(`  writes  : .state/surfaced_candidates.json`);
    console.log(`  queries : ${(config.discovery?.searchQueries ?? []).join(', ')}`);
    console.log('  scan.mjs reads this pool while it is fresh and falls back to');
    console.log('  discovering inline when it is stale — stopping this daemon');
    console.log('  costs latency, never coverage.');
    console.log('  Ctrl+C to stop.');
    console.log('═'.repeat(64));
  }

  let runs = 0;
  const run = async () => {
    const t0 = Date.now();
    try {
      const p = await refreshOnce({ config });
      runs++;
      console.log(
        `[${stamp()}] refreshed ${p.candidates.length} candidate(s) ` +
          `(${p.stats?.fromFeeds ?? '?'} feeds, ${p.stats?.fromSearch ?? '?'} search) in ${((Date.now() - t0) / 1000).toFixed(1)}s`
      );
    } catch (err) {
      console.error(`[${stamp()}] discovery failed: ${err.message}`);
    }
  };

  await run();
  if (once) process.exit(0);

  const timer = setInterval(run, intervalSec * 1000);
  const controller = new AbortController();

  // The socket runs ALONGSIDE the poll, not instead of it. They cover different
  // things: the stream sees every pump.fun creation and nothing else, the poll
  // sees every chain and every already-trading token. Dropping either loses
  // real coverage.
  const streamCfg = config.discovery?.mintStream ?? {};
  let streamStats = null;
  if (streamCfg.enabled === true) {
    const { loadEnv } = await import('./telegram.mjs');
    const env = await loadEnv(join(HERE, '.env'));
    const rpcUrl = env.rpcOverride || config.rpcUrl;
    const wsUrl = websocketUrlFor(rpcUrl);

    console.log(`  stream  : ${new URL(wsUrl).host} — pump.fun CreateV2`);
    console.log('  NOTE: sub-second to the mint, but DexScreener needs ~30s to');
    console.log('  publish a pair, so this buys COVERAGE and queue position,');
    console.log('  not a 0ms entry. See the module header for the measurements.');

    startMintStream({
      wsUrl,
      rpcUrl,
      config,
      signal: controller.signal,
      onMints: async (batch, stats) => {
        streamStats = stats;
        const { added, total } = await pushStreamedMints(batch, { config });
        if (added) {
          console.log(
            `[${stamp()}] +${added} streamed mint(s) — ${batch.map((b) => b.mint.slice(0, 6)).join(', ')} ` +
              `(pool ${total}, ${stats.creations} creation(s) seen)`
          );
        }
      },
    }).catch((err) => console.error(`mint stream stopped: ${err.message}`));
  }

  const shutdown = () => {
    clearInterval(timer);
    controller.abort();
    console.log(`\n  stopped after ${runs} refresh(es).`);
    if (streamStats) {
      console.log(
        `  stream saw ${streamStats.notifications} notification(s), ${streamStats.creations} creation(s), ` +
          `resolved ${streamStats.resolved}, dropped ${streamStats.dropped} to the rate cap, ` +
          `${streamStats.reconnects} reconnect(s).`
      );
    }
    console.log('  scan.mjs will discover inline again.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
