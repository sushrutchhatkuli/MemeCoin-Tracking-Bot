/**
 * Data source layer for Aegis-Crypto.
 *
 * All three upstreams are public and keyless:
 *   - DexScreener  : discovery + market micro-structure (buys/sells, liquidity, mcap)
 *   - RugCheck     : Solana contract security (mint/freeze authority, LP lock, insiders)
 *   - GoPlus Labs  : EVM contract security (taxes, honeypot sim, verified source)
 */

const JSON_HEADERS = { accept: 'application/json' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch JSON with timeout, 429 back-off and bounded retries. Never throws. */
async function getJson(url, { timeoutMs = 20000, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: JSON_HEADERS, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true, data: await res.json() };
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) return { ok: false, error: err.message };
      await sleep(600 * (attempt + 1));
    }
  }
  return { ok: false, error: 'retries exhausted' };
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

/**
 * Candidate tokens currently surfacing on DexScreener: freshly listed profiles
 * plus boosted tokens (paid promotion, which is where most launch traffic goes).
 * Returns de-duplicated { chainId, tokenAddress } records.
 */
export async function discoverCandidates(chains, discovery = {}) {
  const endpoints = [
    'https://api.dexscreener.com/token-profiles/latest/v1',
    'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-boosts/top/v1',
  ];

  const seen = new Map();
  const add = (chainId, tokenAddress, extra = {}) => {
    if (!chainId || !tokenAddress) return false;
    if (chains.length && !chains.includes(chainId)) return false;
    const key = `${chainId}:${tokenAddress.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.set(key, { chainId, tokenAddress, ...extra });
    return true;
  };

  for (const url of endpoints) {
    const res = await getJson(url);
    if (!res.ok || !Array.isArray(res.data)) continue;
    for (const entry of res.data) {
      add(entry?.chainId, entry?.tokenAddress, {
        socialHints: entry?.links ?? [],
        via: 'boost/profile',
      });
    }
    await sleep(250);
  }

  const fromFeeds = seen.size;

  // Second source, deliberately different in character. The boost and profile
  // feeds are launch-oriented and skew tiny — measured across a full sample they
  // returned nothing above $1M. The search endpoint surfaces established pairs,
  // so the union spans both ends instead of only the newest launches.
  // (DexScreener publishes no trending endpoint; every variant 403s or 404s.)
  const queries = discovery.searchQueries ?? [];
  const floor = discovery.searchMinMarketCapUsd ?? 300000;

  for (const q of queries) {
    const res = await getJson(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`
    );
    if (!res.ok || !Array.isArray(res.data?.pairs)) continue;
    for (const pair of res.data.pairs) {
      const mcap = pair?.marketCap ?? pair?.fdv ?? 0;
      // Only take the larger pairs from search — the small ones are already
      // covered by the launch feeds, and re-adding them wastes audit budget.
      if (mcap < floor) continue;
      add(pair?.chainId, pair?.baseToken?.address, { via: `search:${q}` });
    }
    await sleep(300);
  }

  return {
    candidates: [...seen.values()],
    stats: { fromFeeds, fromSearch: seen.size - fromFeeds, total: seen.size },
  };
}

/* ------------------------------------------------------------------ *
 * Market micro-structure (DexScreener)
 * ------------------------------------------------------------------ */

/**
 * Market data for up to 30 token addresses per call. Returns a Map keyed by
 * lowercased token address holding that token's deepest-liquidity pair.
 */
export async function fetchPairsBatch(addresses) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    const res = await getJson(
      `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`
    );
    if (res.ok && Array.isArray(res.data?.pairs)) {
      for (const pair of res.data.pairs) {
        const key = pair?.baseToken?.address?.toLowerCase();
        if (!key) continue;
        const incumbent = out.get(key);
        // Keep the pair with the deepest liquidity — that's the price-setting venue.
        if (!incumbent || (pair.liquidity?.usd ?? 0) > (incumbent.liquidity?.usd ?? 0)) {
          out.set(key, pair);
        }
      }
    }
    await sleep(250);
  }
  return out;
}

export async function fetchSinglePair(address) {
  const map = await fetchPairsBatch([address]);
  return map.get(address.toLowerCase()) ?? null;
}

/* ------------------------------------------------------------------ *
 * Holder distribution
 * ------------------------------------------------------------------ */

/**
 * Addresses that never represent a real holder.
 *
 * Worth knowing: on Solana an SPL burn DECREMENTS total supply rather than
 * moving tokens to a burn address, so these rarely appear in a holder list at
 * all — burned supply is already absent from the denominator. They are excluded
 * defensively (some tokens do park supply at the incinerator) but excluding them
 * is typically a no-op, and is not what makes a concentration figure differ
 * between two trackers.
 */
export const NON_HOLDER_ADDRESSES = new Set([
  '11111111111111111111111111111111', // System Program (commonly called the burn address)
  '1nc1nerator11111111111111111111111111111111', // SPL incinerator
  'So11111111111111111111111111111111111111112', // Wrapped SOL
  'deadeadeadeadeadeadeadeadeadeadeadeadeadead', // conventional dead address
]);

/**
 * Turn a raw token-account list into a wallet-level distribution.
 *
 * Two corrections matter here, and both move the number:
 *
 *   1. AGGREGATE BY OWNER. The provider returns token *accounts*, and one wallet
 *      can hold several. Summing accounts treats a single whale spread across
 *      three accounts as three smaller holders and understates concentration.
 *
 *   2. PICK THE DENOMINATOR DELIBERATELY. "Top 10 hold X%" is ambiguous: X can
 *      be a share of total supply or of circulating supply (total minus LP and
 *      other non-circulating reserves). On a bonding-curve token where the pool
 *      holds most of the supply these differ by an order of magnitude, and it is
 *      the usual reason two trackers disagree. Both are returned so the note can
 *      show either.
 */
export function computeHolderDistribution({ holders, totalSupply, excludedAddresses, topN = 10 }) {
  const excluded = new Set([...(excludedAddresses ?? []), ...NON_HOLDER_ADDRESSES]);

  let lpAndExcludedAmount = 0;
  const byOwner = new Map();

  for (const h of holders ?? []) {
    const owner = h.owner ?? h.address;
    const amount = h.uiAmount ?? 0;
    if (excluded.has(owner) || excluded.has(h.address)) {
      lpAndExcludedAmount += amount;
      continue;
    }
    const prev = byOwner.get(owner);
    if (prev) {
      prev.amount += amount;
      prev.accounts += 1;
      prev.insider = prev.insider || Boolean(h.insider);
    } else {
      byOwner.set(owner, {
        owner,
        amount,
        accounts: 1,
        insider: Boolean(h.insider),
      });
    }
  }

  const ranked = [...byOwner.values()].sort((a, b) => b.amount - a.amount);
  const circulatingSupply = Math.max(0, totalSupply - lpAndExcludedAmount);

  const topSlice = ranked.slice(0, topN);
  const topAmount = topSlice.reduce((sum, h) => sum + h.amount, 0);

  const pctOf = (amount, denom) => (denom > 0 ? (amount / denom) * 100 : null);

  const withPct = ranked.map((h) => ({
    ...h,
    pct: pctOf(h.amount, totalSupply),
    pctCirculating: pctOf(h.amount, circulatingSupply),
  }));

  return {
    totalSupply,
    circulatingSupply,
    excludedAmount: lpAndExcludedAmount,
    excludedPct: pctOf(lpAndExcludedAmount, totalSupply),
    holderCountRanked: ranked.length,
    // Headline figure — share of TOTAL supply held by the top N wallets.
    topNPct: pctOf(topAmount, totalSupply),
    // Same wallets measured against circulating supply (total minus LP).
    topNPctCirculating: pctOf(topAmount, circulatingSupply),
    topHolders: withPct.slice(0, topN),
    allHolders: withPct,
  };
}

/* ------------------------------------------------------------------ *
 * Live on-chain holder distribution (Solana RPC)
 * ------------------------------------------------------------------ */

async function solanaRpc(url, method, params, timeoutMs = 15000) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (body.error) return { error: `${body.error.code}: ${body.error.message}`.slice(0, 120) };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { result: body.result };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Read holder distribution straight from chain, bypassing the indexer cache.
 *
 * WHY THIS OFTEN RETURNS null:
 * `getTokenLargestAccounts` is expensive server-side and every keyless endpoint
 * refuses it — the public Solana RPC rate-limits it per-method, and dRPC/Ankr/
 * BlockEden all require a paid plan. It works as soon as `rpcUrl` points at a
 * dedicated endpoint (Helius, QuickNode, Triton). Until then the caller falls
 * back to the cached indexer and the note says so explicitly, because
 * presenting stale numbers as live is worse than admitting they are stale.
 *
 * ACCURACY CAVEAT even when it works: the RPC returns the top 20 token
 * ACCOUNTS, not wallets, and not the full holder set. Aggregating by owner (as
 * below) is correct for those 20, but a whale split across more accounts than
 * that is still understated. This buys freshness, not unlimited depth.
 */
/**
 * Raw holder data for a mint, with no exclusion logic applied.
 *
 * Split out of fetchLiveHolderDistribution so the FETCH can start before the
 * exclusion set exists. The exclusions come from RugCheck (pool and AMM
 * accounts), which used to mean the whole holder read waited on an HTTP call it
 * does not actually depend on — only the final computation does.
 *
 * getTokenSupply and getTokenLargestAccounts are independent of each other and
 * now run together; getMultipleAccounts genuinely depends on the account list,
 * so it stays sequential. Three round-trips become two.
 */
export async function fetchHolderSnapshot({ mint, rpcUrl }) {
  if (!rpcUrl) return { ok: false, error: 'no rpcUrl configured' };

  const [supply, largest] = await Promise.all([
    solanaRpc(rpcUrl, 'getTokenSupply', [mint]),
    solanaRpc(rpcUrl, 'getTokenLargestAccounts', [mint]),
  ]);

  if (supply.error) return { ok: false, error: `getTokenSupply: ${supply.error}` };
  const totalSupply = supply.result?.value?.uiAmount;
  if (!totalSupply) return { ok: false, error: 'supply unavailable' };

  if (largest.error) return { ok: false, error: `getTokenLargestAccounts: ${largest.error}` };
  const accounts = largest.result?.value ?? [];
  if (!accounts.length) return { ok: false, error: 'no token accounts returned' };

  const owners = await solanaRpc(rpcUrl, 'getMultipleAccounts', [
    accounts.map((a) => a.address),
    { encoding: 'jsonParsed' },
  ]);
  if (owners.error) return { ok: false, error: `getMultipleAccounts: ${owners.error}` };

  return { ok: true, totalSupply, accounts, owners };
}

export async function fetchLiveHolderDistribution({ mint, rpcUrl, excludedAddresses, topN = 10, snapshot = null }) {
  if (!rpcUrl && !snapshot) return { ok: false, error: 'no rpcUrl configured' };

  // A caller that already started the snapshot in parallel passes it in; the
  // pre-dispatch re-audit still calls this cold and fetches its own.
  const snap = snapshot ?? (await fetchHolderSnapshot({ mint, rpcUrl }));
  if (!snap.ok) return { ok: false, error: snap.error };

  const totalSupply = snap.totalSupply;
  const accounts = snap.accounts;
  const owners = snap.owners;

  const holders = accounts.map((a, i) => ({
    address: a.address,
    owner: owners.result?.value?.[i]?.data?.parsed?.info?.owner ?? a.address,
    uiAmount: a.uiAmount ?? 0,
  }));

  const distribution = computeHolderDistribution({
    holders,
    totalSupply,
    excludedAddresses,
    topN,
  });

  return {
    ok: true,
    source: 'rpc-live',
    fetchedAt: Date.now(),
    accountsSampled: accounts.length,
    ...distribution,
  };
}

/* ------------------------------------------------------------------ *
 * Solana security (RugCheck)
 * ------------------------------------------------------------------ */

export async function fetchSolanaSecurity(mint, { rpcUrl = null } = {}) {
  // RugCheck (mint/freeze authority, LP lock, risk flags) and the on-chain
  // holder snapshot are INDEPENDENT fetches and now run together. Only the
  // final distribution computation needs both — it applies RugCheck's pool and
  // AMM exclusions to the RPC holder list — so waiting for one before starting
  // the other was pure serialised latency on the hot path of every audit.
  const [res, snapshot] = await Promise.all([
    getJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeoutMs: 25000 }),
    rpcUrl ? fetchHolderSnapshot({ mint, rpcUrl }) : Promise.resolve(null),
  ]);
  if (!res.ok) return { ok: false, error: res.error };

  const d = res.data ?? {};

  // Pool / AMM accounts must be excluded before measuring insider concentration —
  // the bonding curve or LP vault legitimately holds most of the supply.
  const excluded = new Set();
  for (const m of d.markets ?? []) {
    for (const field of ['pubkey', 'mintLP', 'liquidityA', 'liquidityB']) {
      if (m?.[field]) excluded.add(m[field]);
    }
  }
  for (const [addr, meta] of Object.entries(d.knownAccounts ?? {})) {
    const type = String(meta?.type ?? '').toUpperCase();
    if (type === 'AMM' || type === 'LP' || type === 'MARKET') excluded.add(addr);
  }

  const totalSupply =
    d.token?.supply && d.token?.decimals !== undefined
      ? d.token.supply / 10 ** d.token.decimals
      : null;

  const distribution =
    totalSupply && (d.topHolders ?? []).length
      ? computeHolderDistribution({
          holders: d.topHolders ?? [],
          totalSupply,
          excludedAddresses: excluded,
          topN: 10,
        })
      : null;

  // Prefer a live on-chain read when an RPC is available. The cached indexer
  // can lag insider accumulation by minutes, which is exactly the window a
  // cabal uses to load up after the audit ran.
  let distributionSource = 'rugcheck-cached';
  let liveError = null;
  let finalDistribution = distribution;

  if (rpcUrl) {
    // Reuses the snapshot already fetched in parallel above; no second trip.
    const live = await fetchLiveHolderDistribution({
      mint,
      rpcUrl,
      excludedAddresses: excluded,
      topN: 10,
      snapshot,
    });
    if (live.ok) {
      finalDistribution = live;
      distributionSource = 'rpc-live';
    } else {
      liveError = live.error;
    }
  }

  const holders = finalDistribution?.allHolders ?? [];
  // null (unknown) rather than 0 when the provider returned no holder data —
  // an empty array must never be scored as perfect distribution.
  const top10Pct = finalDistribution ? finalDistribution.topNPct : null;
  const insiderPct = holders
    .filter((h) => h.insider)
    .reduce((sum, h) => sum + (h.pct ?? 0), 0);

  const lpLockedPct = Math.max(
    0,
    ...(d.markets ?? []).map((m) => m?.lp?.lpLockedPct ?? 0),
    d.lpLockedPct ?? 0
  );

  return {
    ok: true,
    chainKind: 'solana',
    mintAuthority: d.mintAuthority || null,
    freezeAuthority: d.freezeAuthority || null,
    lpLockedPct,
    top10Pct,
    insiderPct,
    insiderNetworks: (d.insiderNetworks ?? []).length,
    graphInsidersDetected: d.graphInsidersDetected ?? 0,
    totalHolders: d.totalHolders ?? null,
    totalMarketLiquidity: d.totalMarketLiquidity ?? null,
    rugged: Boolean(d.rugged),
    risks: (d.risks ?? []).map((r) => ({
      name: r.name,
      level: r.level,
      description: r.description,
    })),
    rugcheckScore: d.score_normalised ?? null,
    // Fallback age source. DexScreener omits pairCreatedAt for most
    // bonding-curve pairs, which would otherwise leave age unknown on exactly
    // the newest tokens — where age matters most.
    detectedAt: d.detectedAt ? Date.parse(d.detectedAt) : null,
    launchpad: d.launchpad?.name ?? d.deployPlatform ?? null,
    creator: d.creator ?? null,
    creatorBalance: d.creatorBalance ?? null,
    // Full distribution detail — supply breakdown and both denominators.
    distribution: finalDistribution,
    // Exported so the pre-dispatch re-audit can reuse the identical exclusion
    // set rather than recomputing a different one.
    excludedAddresses: excluded,
    // Which source the concentration figure actually came from, and how stale
    // it may be. Surfaced in the note so a cached number is never mistaken for
    // a live one.
    distributionSource,
    distributionFetchedAt: finalDistribution?.fetchedAt ?? null,
    liveHolderError: liveError,
    cachedDistribution: distribution,
    totalSupply,
    // Unfiltered provider records, kept so the calibration tool can reproduce
    // other trackers' conventions (e.g. per-token-account, no LP filter).
    rawHolders: d.topHolders ?? [],
    topHolders: finalDistribution?.topHolders ?? [],
    // Full filtered list — smart-money matching should search every tracked
    // holder, not just the ten that drive the concentration check.
    allHolders: holders,
  };
}

/* ------------------------------------------------------------------ *
 * EVM security (GoPlus Labs)
 * ------------------------------------------------------------------ */

const EVM_CHAIN_IDS = {
  ethereum: '1',
  bsc: '56',
  base: '8453',
  arbitrum: '42161',
  polygon: '137',
  avalanche: '43114',
  optimism: '10',
};

export const isEvmChain = (chainId) => Object.hasOwn(EVM_CHAIN_IDS, chainId);

export async function fetchEvmSecurity(chainId, contract) {
  const numericChain = EVM_CHAIN_IDS[chainId];
  if (!numericChain) return { ok: false, error: `unsupported EVM chain: ${chainId}` };

  const res = await getJson(
    `https://api.gopluslabs.io/api/v1/token_security/${numericChain}?contract_addresses=${contract.toLowerCase()}`,
    { timeoutMs: 25000 }
  );
  if (!res.ok) return { ok: false, error: res.error };

  const d = res.data?.result?.[contract.toLowerCase()];
  if (!d) return { ok: false, error: 'no GoPlus record for contract' };

  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  const flag = (v) => v === '1';

  // GoPlus taxes are expressed as fractions (0.05 === 5%).
  const buyTaxPct = num(d.buy_tax) === null ? null : num(d.buy_tax) * 100;
  const sellTaxPct = num(d.sell_tax) === null ? null : num(d.sell_tax) * 100;

  const lpHolders = d.lp_holders ?? [];
  const lpLockedPct = lpHolders.length
    ? lpHolders.reduce(
        (sum, h) => sum + (h.is_locked === 1 ? Number(h.percent ?? 0) * 100 : 0),
        0
      )
    : null;

  // Same rule as Solana: no holder data means unknown, not "0% concentration".
  const rankedHolders = (d.holders ?? []).filter((h) => !flag(h.is_contract) || h.tag);
  const top10Pct = rankedHolders.length
    ? rankedHolders.slice(0, 10).reduce((sum, h) => sum + Number(h.percent ?? 0) * 100, 0)
    : null;

  return {
    ok: true,
    chainKind: 'evm',
    buyTaxPct,
    sellTaxPct,
    totalTaxPct: buyTaxPct === null || sellTaxPct === null ? null : buyTaxPct + sellTaxPct,
    isHoneypot: flag(d.is_honeypot),
    cannotSellAll: flag(d.cannot_sell_all),
    isOpenSource: flag(d.is_open_source),
    isProxy: flag(d.is_proxy),
    isMintable: flag(d.is_mintable),
    canTakeBackOwnership: flag(d.can_take_back_ownership),
    hasBlacklist: flag(d.is_blacklisted),
    hasWhitelist: flag(d.is_whitelisted),
    transferPausable: flag(d.transfer_pausable),
    hiddenOwner: flag(d.hidden_owner),
    selfDestruct: flag(d.selfdestruct),
    lpLockedPct,
    top10Pct,
    totalHolders: num(d.holder_count),
    creator: d.creator_address ?? null,
    ownerAddress: d.owner_address ?? null,
    tokenName: d.token_name ?? null,
    tokenSymbol: d.token_symbol ?? null,
  };
}

/** Dispatch to the right security provider for the chain. */
export async function fetchSecurity(chainId, address, opts = {}) {
  if (chainId === 'solana') return fetchSolanaSecurity(address, opts);
  if (isEvmChain(chainId)) return fetchEvmSecurity(chainId, address);
  return { ok: false, error: `no security provider for chain: ${chainId}` };
}
