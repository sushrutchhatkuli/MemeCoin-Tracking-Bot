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
export async function discoverCandidates(chains) {
  const endpoints = [
    'https://api.dexscreener.com/token-profiles/latest/v1',
    'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-boosts/top/v1',
  ];

  const seen = new Map();
  for (const url of endpoints) {
    const res = await getJson(url);
    if (!res.ok || !Array.isArray(res.data)) continue;
    for (const entry of res.data) {
      const chainId = entry?.chainId;
      const tokenAddress = entry?.tokenAddress;
      if (!chainId || !tokenAddress) continue;
      if (chains.length && !chains.includes(chainId)) continue;
      const key = `${chainId}:${tokenAddress.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.set(key, { chainId, tokenAddress, socialHints: entry?.links ?? [] });
    }
    await sleep(250);
  }
  return [...seen.values()];
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
 * Solana security (RugCheck)
 * ------------------------------------------------------------------ */

export async function fetchSolanaSecurity(mint) {
  const res = await getJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
    timeoutMs: 25000,
  });
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

  const holders = distribution?.allHolders ?? [];
  // null (unknown) rather than 0 when the provider returned no holder data —
  // an empty array must never be scored as perfect distribution.
  const top10Pct = distribution ? distribution.topNPct : null;
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
    launchpad: d.launchpad?.name ?? d.deployPlatform ?? null,
    creator: d.creator ?? null,
    creatorBalance: d.creatorBalance ?? null,
    // Full distribution detail — supply breakdown and both denominators.
    distribution,
    totalSupply,
    // Unfiltered provider records, kept so the calibration tool can reproduce
    // other trackers' conventions (e.g. per-token-account, no LP filter).
    rawHolders: d.topHolders ?? [],
    topHolders: distribution?.topHolders ?? [],
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
export async function fetchSecurity(chainId, address) {
  if (chainId === 'solana') return fetchSolanaSecurity(address);
  if (isEvmChain(chainId)) return fetchEvmSecurity(chainId, address);
  return { ok: false, error: `no security provider for chain: ${chainId}` };
}
