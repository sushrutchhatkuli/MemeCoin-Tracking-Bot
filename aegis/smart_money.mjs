/**
 * Smart Money & Insider Wallet Tracking.
 *
 * IMPORTANT — WHAT THIS DOES AND DOES NOT DO:
 *
 * There is no keyless public API that curates "proven high win-rate wallets".
 * That dataset is the product Nansen / Arkham / GMGN / Cielo sell. So this module
 * does not invent one: it matches a watchlist YOU supply against the token's
 * actual on-chain holders. The matching is real; the quality of the signal is
 * entirely determined by the quality of `smart-money.json`.
 *
 * Entry-time caveat: holder lists are a snapshot with no timestamps, so a match
 * proves a wallet HOLDS the token, not WHEN it bought. The "first 10 minutes"
 * criterion is therefore only asserted when the token itself is younger than the
 * configured window — in which case any holder is necessarily an early one.
 * Establishing entry time on an older token needs an indexer (Helius/Bitquery).
 */

import { readFile } from 'node:fs/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Accepts either shape:
 *   ["Wallet1...", "Wallet2..."]                         (bare array)
 *   { "wallets": [ { "address": "...", "label": "..." } ] } (annotated)
 */
/**
 * Solana addresses are base58 (no 0, O, I, l) and 32–44 characters.
 * An address that fails this can never match a real holder, so a typo in the
 * watchlist would otherwise present as "no smart money found" forever — a
 * silent failure that looks identical to a working module.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Known system, program and DEX-authority accounts that must never be treated
 * as traders.
 *
 * These are not hypothetical. Two of them arrived in a real watchlist as
 * "Alpha Whale #1" and "Alpha Whale #2":
 *   9WzDXw… holds 10,755,444 SOL          — exchange/system scale
 *   5Q544f… owns 1,416,453 token accounts — Raydium Authority V4
 *
 * A pool authority appears as a "holder" of essentially every token routed
 * through its AMM, so leaving one on a watchlist makes almost every scan report
 * smart-money activity. That is worse than having no watchlist at all: it
 * manufactures confidence rather than merely lacking it.
 */
export const SYSTEM_ACCOUNTS = new Map([
  ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'system/exchange vault (10.7M SOL)'],
  ['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 'Raydium Authority V4 (1.4M token accounts)'],
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium Liquidity Pool V4 program'],
  ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'Pump.fun program'],
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'PumpSwap AMM program'],
  ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'Orca Whirlpool program'],
  ['9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', 'Orca Token Swap V2'],
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'SPL Token program'],
  ['11111111111111111111111111111111', 'System program'],
  // Jito tip accounts — bundle payments land here, so they co-occur with every
  // bundled buy and would otherwise look like a wallet buying everything.
  ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'Jito tip account'],
  ['HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Jito tip account'],
  ['Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'Jito tip account'],
  ['ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', 'Jito tip account'],
  ['DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'Jito tip account'],
  ['ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt', 'Jito tip account'],
  ['DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', 'Jito tip account'],
  ['3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT', 'Jito tip account'],
]);

/**
 * Screen a wallet for system-account characteristics that a static list cannot
 * anticipate.
 *
 * Two independent tests, because they catch different things:
 *   - SOL balance:        exchange vaults hold enormous SOL (10.7M in the case
 *                         above) but few token accounts.
 *   - Token-account count: pool authorities hold trivial SOL (35) but own
 *                         millions of token accounts. A balance check alone
 *                         would have waved Raydium Authority straight through.
 *
 * The count query uses dataSlice length 0 so the response stays small — without
 * it, querying a pool authority returns hundreds of megabytes and crashes the
 * JSON parse outright.
 *
 * Verdicts are cached because this is slow (≈10s for a pool authority) and a
 * wallet's nature does not change.
 */
export async function screenSystemAccount(address, rpcUrl, cache = {}, cfg = {}) {
  const known = SYSTEM_ACCOUNTS.get(address);
  if (known) return { system: true, reason: known, source: 'known-list' };
  if (cache[address]) return cache[address];
  if (!rpcUrl) return { system: false, reason: 'no RPC configured — screening skipped' };

  const maxSol = cfg.maxWalletSol ?? 100000;
  const maxTokenAccounts = cfg.maxTokenAccounts ?? 1000;

  const call = async (method, params) => {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await res.json().catch(() => ({}));
      return body.error ? { error: body.error.message } : { result: body.result };
    } catch (err) {
      return { error: err.message };
    }
  };

  const info = await call('getAccountInfo', [address, { encoding: 'jsonParsed' }]);
  if (info.error) return { system: false, reason: `screening failed: ${info.error}` };

  const v = info.result?.value;
  if (v?.executable) {
    return (cache[address] = { system: true, reason: 'on-chain program, not a wallet', source: 'rpc' });
  }
  const sol = (v?.lamports ?? 0) / 1e9;
  if (sol > maxSol) {
    return (cache[address] = {
      system: true,
      reason: `holds ${Math.round(sol).toLocaleString('en-US')} SOL (limit ${maxSol.toLocaleString('en-US')})`,
      source: 'rpc',
    });
  }

  const accts = await call('getTokenAccountsByOwner', [
    address,
    { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    { encoding: 'base64', dataSlice: { offset: 0, length: 0 } },
  ]);
  if (!accts.error) {
    const n = (accts.result?.value ?? []).length;
    if (n > maxTokenAccounts) {
      return (cache[address] = {
        system: true,
        reason: `owns ${n.toLocaleString('en-US')} token accounts — DEX pool authority, not a trader`,
        source: 'rpc',
        tokenAccounts: n,
      });
    }
    return (cache[address] = { system: false, solBalance: sol, tokenAccounts: n, source: 'rpc' });
  }

  return (cache[address] = { system: false, solBalance: sol, source: 'rpc-partial' });
}

export function validateWatchlistEntry(entry) {
  const address = String(entry?.address ?? '');
  if (!BASE58_ADDRESS.test(address)) {
    return {
      valid: false,
      reason:
        address.length < 32 || address.length > 44
          ? `wrong length (${address.length}; Solana addresses are 32–44 chars)`
          : 'contains characters outside the base58 alphabet',
    };
  }
  return { valid: true };
}

/**
 * Load the watchlist, merging any auto-discovered wallets.
 *
 * `extraPaths` exists because auto_top_whales.mjs rewrites the primary file
 * wholesale every two hours. Anything appended there by network discovery would
 * be erased on the next sync, so discoveries live in their own file and are
 * merged at read time. Curated entries win on a duplicate address.
 */
export async function loadWatchlist(path, extraPaths = [], opts = {}) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const entries = Array.isArray(raw) ? raw : (raw.wallets ?? []);

    for (const extra of extraPaths) {
      try {
        const more = JSON.parse(await readFile(extra, 'utf8'));
        entries.push(...(more.wallets ?? []));
      } catch {
        /* discovered file may not exist yet */
      }
    }

    const candidates = entries
      .map((e) => (typeof e === 'string' ? { address: e } : e))
      // `enabled: false` keeps the shipped placeholder from registering as a real
      // watchlist entry, which would report the module as configured when it isn't.
      .filter(
        (w) => w?.address && w.enabled !== false && !String(w.address).startsWith('EXAMPLE_')
      );

    const invalid = [];
    const wellFormed = candidates.filter((w) => {
      const check = validateWatchlistEntry(w);
      if (!check.valid) {
        invalid.push({ address: w.address, label: w.label ?? null, reason: check.reason });
        return false;
      }
      return true;
    });

    // Drop system / DEX-authority accounts before any matching happens. A pool
    // authority left on the list would "hold" nearly every token and report
    // smart-money activity on almost every scan.
    const excluded = [];
    const normalised = [];
    for (const w of wellFormed) {
      const verdict = await screenSystemAccount(
        w.address,
        opts.rpcUrl ?? null,
        opts.screenCache ?? {},
        opts.screening ?? {}
      );
      if (verdict.system) {
        excluded.push({ address: w.address, label: w.label ?? null, reason: verdict.reason });
        continue;
      }
      normalised.push(w);
    }

    const index = new Map();
    for (const w of normalised) {
      // First writer wins: the primary file is read before extras, so a
      // curated entry is never replaced by an auto-discovered duplicate.
      if (index.has(w.address)) continue;
      index.set(w.address, {
        address: w.address,
        label: w.label ?? 'unlabelled',
        source: w.source ?? null,
        winRate: w.win_rate ?? null,
        // Historical P&L cannot be computed here — it needs every trade this
        // wallet ever made, priced at execution, across all tokens. That is the
        // product GMGN/Nansen/Cielo sell. These are passed through from the
        // watchlist file verbatim and are only as current as you keep them.
        stats:
          w.win_rate || w.trades || w.net_profit_usd
            ? {
                winRate: w.win_rate ?? null,
                trades: w.trades ?? null,
                netProfitUsd: w.net_profit_usd ?? null,
                statsUpdated: w.stats_updated ?? null,
                userSupplied: true,
              }
            : null,
      });
    }
    return { index, count: normalised.length, invalid, excluded };
  } catch {
    return { index: new Map(), count: 0, invalid: [], excluded: [] };
  }
}

/**
 * One-line smart money callout, shared by the digest and the alert card so the
 * two can never drift apart.
 *
 * Renders only what is actually known. Spend and entry market cap are derived
 * from the buy transaction, so they are absent when the wallet was matched from
 * the holder list rather than a replayed trade — in which case the position size
 * is shown instead of inventing a figure.
 */
export function formatSmartMoneyLine(match, { html = false } = {}) {
  // Telegram parses HTML, so any literal '<' in the body (notably the "<1m"
  // timing) is read as an unclosed tag and the whole message is rejected.
  const esc = (s) =>
    html
      ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      : String(s);
  const link = (url) => (html ? `<a href="${url}">${url}</a>` : url);

  const stats = [];
  if (match.stats?.winRate) stats.push(`${match.stats.winRate} WR`);
  if (match.stats?.netProfitUsd) stats.push(`${match.stats.netProfitUsd} Profit`);
  const statsPart = stats.length ? ` (${stats.join(' | ')})` : '';

  let action;
  if (match.solSpent && match.usdSpent) {
    const mc = match.entryMarketCapUsd ? ` at ${shortUsd(match.entryMarketCapUsd)} MC` : '';
    action = `Bought ${match.solSpent.toFixed(2)} SOL (${shortUsd(match.usdSpent)})${mc}`;
  } else {
    action = `Holds ${match.pct.toFixed(2)}% of supply`;
  }

  const timing =
    match.entryMinutesAfterLaunch !== null && match.entryMinutesAfterLaunch !== undefined
      ? ` · ${match.entryMinutesAfterLaunch < 1 ? '<1m' : `${Math.round(match.entryMinutesAfterLaunch)}m`} after launch${match.entryMinutesAfterLaunch <= 10 ? ' ⚡' : ''}`
      : '';

  const body = `🐋 SMART MONEY: ${match.displayLabel}${statsPart} ${action}${timing} | 🔗 `;
  return esc(body) + link(match.solscanUrl);
}

function shortUsd(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '?';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

/* ------------------------------------------------------------------ *
 * Recent buyer extraction (Solana RPC)
 * ------------------------------------------------------------------ */

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

/**
 * Extract buyers from one parsed transaction.
 *
 * Attributes by TOKEN-ACCOUNT OWNER rather than by transaction signer. This is
 * not a stylistic choice: on Solana the signer is frequently a relayer, bot or
 * aggregator rather than the person receiving the tokens. Sampling live swaps
 * showed the signer holding a zero token delta on every one of them, so
 * signer-based attribution silently finds nothing on exactly the aggregator-
 * routed trades that matter.
 *
 * Exported for testing — it is pure, so it can be verified against a recorded
 * transaction without touching an RPC.
 */
export function extractBuys(txResult, { mint, poolAddress }) {
  const meta = txResult?.meta;
  const message = txResult?.transaction?.message;
  if (!meta || !message) return [];

  const keys = (message.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const signer = (message.accountKeys ?? []).find((k) => k?.signer)?.pubkey ?? keys[0] ?? null;

  // Net token movement per owner across the whole transaction.
  const deltaByOwner = new Map();
  const bump = (owner, amount) => {
    if (!owner) return;
    deltaByOwner.set(owner, (deltaByOwner.get(owner) ?? 0) + amount);
  };
  for (const p of meta.preTokenBalances ?? []) {
    if (p.mint === mint) bump(p.owner, -(p.uiTokenAmount?.uiAmount ?? 0));
  }
  for (const p of meta.postTokenBalances ?? []) {
    if (p.mint === mint) bump(p.owner, p.uiTokenAmount?.uiAmount ?? 0);
  }

  // SOL leaving the transaction, used to price the entry. Fees are excluded so
  // a large buy is not inflated by them; dust-only movements are ignored.
  const signerIndex = keys.indexOf(signer);
  const feeSol = (meta.fee ?? 0) / 1e9;
  const signerSolDelta =
    signerIndex >= 0 && meta.preBalances && meta.postBalances
      ? (meta.postBalances[signerIndex] - meta.preBalances[signerIndex]) / 1e9
      : 0;
  const solSpent = Math.max(0, -signerSolDelta - feeSol);

  const buys = [];
  for (const [owner, delta] of deltaByOwner) {
    if (delta <= 0) continue;
    if (owner === poolAddress) continue; // the pool receiving tokens is a SELL
    buys.push({
      wallet: owner,
      amount: delta,
      // Only attributable when this transaction has a single buyer; with
      // several, the SOL cannot be split between them from balances alone.
      solSpent: null,
      routedBySigner: owner !== signer,
    });
  }

  if (buys.length === 1 && solSpent > 0) buys[0].solSpent = solSpent;
  return buys;
}

/**
 * Recover actual recent BUYERS of a pair by replaying the pool's transactions.
 *
 * DexScreener publishes buy/sell *counts* but never the wallets behind them, so
 * this is the only keyless way to get trader identity. For each pool transaction
 * we take the fee-payer (the trader) and their signed balance delta on the token
 * mint — a positive delta is a buy.
 *
 * This is the most RPC-expensive call in the pipeline (one getTransaction per
 * signature), so callers should only invoke it when a watchlist actually exists.
 */
export async function fetchRecentBuyers({ rpcUrl, poolAddress, mint, cfg, screenCache = {} }) {
  if (!poolAddress || !mint) return { ok: false, error: 'missing pool or mint', buyers: [] };

  const sigs = await rpc(rpcUrl, 'getSignaturesForAddress', [
    poolAddress,
    { limit: cfg.buyerScanSignatures },
  ]);
  if (sigs.error) return { ok: false, error: sigs.error, buyers: [] };

  const signatures = sigs.result ?? [];
  const target = signatures.slice(0, cfg.buyerMaxTxLookups);
  const buyers = new Map();
  let inspected = 0;
  let throttled = false;

  for (const sig of target) {
    // The public RPC throttles aggressively once the deployer audit has already
    // spent calls this pass. Back off and retry before giving up, otherwise the
    // walk dies after ~5 transactions and silently reports a useless sample.
    let tx = await rpc(rpcUrl, 'getTransaction', [
      sig.signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
    ]);
    for (let retry = 0; tx.error && retry < cfg.buyerRetries; retry++) {
      await sleep(cfg.rpcBackoffMs * (retry + 1));
      tx = await rpc(rpcUrl, 'getTransaction', [
        sig.signature,
        { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
      ]);
    }
    if (tx.error) {
      throttled = true;
      break;
    }
    inspected++;
    if (tx.result?.meta?.err) {
      await sleep(cfg.rpcDelayMs);
      continue;
    }

    for (const b of extractBuys(tx.result, { mint, poolAddress })) {
      const existing = buyers.get(b.wallet);
      const entry = { ...b, blockTime: sig.blockTime ?? 0, signature: sig.signature };
      // Keep the EARLIEST buy per wallet — entry timing is the interesting fact.
      if (!existing || entry.blockTime < existing.blockTime) buyers.set(b.wallet, entry);
    }
    await sleep(cfg.rpcDelayMs);
  }

  // Screen at the source, so system accounts never enter the observation ledger.
  //
  // Only the FREE checks run here — the static list and any cached verdict. The
  // RPC screen costs up to ~10s per novel wallet and the replay sees dozens per
  // scan, so running it inline would stall every pass. Novel wallets are instead
  // verified later by `node smart_money.mjs --purge-system`, which screens the
  // small set that has become suspicious.
  const filtered = [];
  const systemFiltered = [];
  for (const b of buyers.values()) {
    const known = SYSTEM_ACCOUNTS.get(b.wallet);
    const cached = screenCache[b.wallet];
    if (known || cached?.system) {
      systemFiltered.push({ wallet: b.wallet, reason: known ?? cached.reason });
      continue;
    }
    filtered.push(b);
  }

  return {
    ok: true,
    buyers: filtered,
    systemFiltered,
    inspected,
    requested: target.length,
    throttled,
    // Coverage is what actually matters for interpreting a negative result: a
    // "no smart money" finding from 5 of 400 transactions means almost nothing.
    truncated: inspected < target.length,
  };
}

/**
 * Cross-reference the token's holders against the watchlist.
 *
 * @param holders  full filtered holder list from the security provider
 * @param ageHours age of the pair, used to decide whether "early" is provable
 */
/**
 * Price a recovered buy.
 *
 * SOL/USD is derived from the pair itself (priceUsd / priceNative when the quote
 * token is SOL) rather than a separate feed, so it is consistent with every
 * other figure in the note. Entry market cap comes from the price actually paid
 * in that transaction, which is why it can differ from the market cap now.
 */
export function priceEntry({ buy, pair, totalSupply }) {
  const priceUsd = Number(pair?.priceUsd);
  const priceNative = Number(pair?.priceNative);
  const quoteIsSol = pair?.quoteToken?.symbol === 'SOL' || pair?.quoteToken?.symbol === 'WSOL';
  const solUsd = quoteIsSol && priceNative > 0 ? priceUsd / priceNative : null;

  const out = {
    solSpent: buy.solSpent ?? null,
    usdSpent: null,
    entryPriceSol: null,
    entryPriceUsd: null,
    entryMarketCapUsd: null,
    solUsd,
  };

  if (buy.solSpent && buy.amount > 0) {
    out.entryPriceSol = buy.solSpent / buy.amount;
    if (solUsd) {
      out.usdSpent = buy.solSpent * solUsd;
      out.entryPriceUsd = out.entryPriceSol * solUsd;
      if (totalSupply) out.entryMarketCapUsd = out.entryPriceUsd * totalSupply;
    }
  }
  return out;
}

export function matchSmartMoney({
  holders,
  buyers,
  watchlist,
  ageHours,
  pairCreatedAt,
  pair,
  totalSupply,
  config,
}) {
  if (!watchlist.count) {
    return {
      configured: false,
      detected: false,
      count: 0,
      wallets: [],
      matches: [],
      buyerScan: null,
      note: 'No watchlist configured — populate aegis/smart_wallets.json to enable this module',
    };
  }

  const matched = new Map();

  // Source A — current holders (always available, no entry timing)
  for (const h of holders ?? []) {
    // A holder record has a token account (`address`) owned by a wallet
    // (`owner`). The watchlist tracks wallets, so `owner` is the field to match,
    // but check both so an entry pasted from a block explorer still works.
    const hit = watchlist.index.get(h.owner) ?? watchlist.index.get(h.address);
    if (!hit) continue;
    matched.set(hit.address, {
      address: hit.address,
      label: hit.label,
      source: hit.source,
      winRate: hit.winRate,
      pct: h.pct ?? 0,
      insider: Boolean(h.insider),
      via: 'holder',
      entryMinutesAfterLaunch: null,
    });
  }

  // Source B — replayed pool trades (carries a timestamp, so entry is provable)
  const earlyWindowMin = config.smartMoney.earlyAccumulationMinutes;
  let earlyBuyers = 0;

  for (const b of buyers ?? []) {
    const hit = watchlist.index.get(b.wallet);
    if (!hit) continue;

    const minutesAfterLaunch =
      pairCreatedAt && b.blockTime ? (b.blockTime * 1000 - pairCreatedAt) / 60000 : null;
    const isEarly = minutesAfterLaunch !== null && minutesAfterLaunch <= earlyWindowMin;
    if (isEarly) earlyBuyers++;

    const existing = matched.get(hit.address);
    const entry = priceEntry({ buy: b, pair, totalSupply });

    matched.set(hit.address, {
      ...(existing ?? {
        address: hit.address,
        label: hit.label,
        source: hit.source,
        winRate: hit.winRate,
        pct: 0,
        insider: false,
      }),
      via: existing ? 'holder + buy' : 'buy',
      entryMinutesAfterLaunch: minutesAfterLaunch,
      boughtAt: b.blockTime,
      tokensBought: b.amount,
      routedBySigner: b.routedBySigner,
      signature: b.signature,
      ...entry,
    });
  }

  const matches = [...matched.values()].map((m, i) => ({
    ...m,
    // Stable display name when the watchlist entry has no label of its own.
    displayLabel: m.label && m.label !== 'unlabelled' ? m.label : `Elite Whale #${i + 1}`,
    solscanUrl: `https://solscan.io/account/${m.address}`,
    stats: watchlist.index.get(m.address)?.stats ?? null,
  }));

  // "Early" is asserted two ways: a timestamped buy inside the window (strong),
  // or the token itself being younger than the window, in which case every
  // holder is necessarily early (weaker, but still sound).
  const tokenYoungerThanWindow =
    ageHours !== null && ageHours * 60 <= earlyWindowMin;
  const provablyEarly = earlyBuyers > 0 || (matches.length > 0 && tokenYoungerThanWindow);

  let note;
  if (!matches.length) {
    note = `No watchlist wallet among ${(holders ?? []).length} holders${buyers?.length ? ` or ${buyers.length} recent buyers` : ''}`;
  } else if (earlyBuyers > 0) {
    note = `${earlyBuyers} tracked wallet(s) bought within ${earlyWindowMin} min of launch — confirmed from replayed pool trades`;
  } else if (tokenYoungerThanWindow) {
    note = `Token is ${(ageHours * 60).toFixed(0)} min old — any holder is necessarily an early accumulator`;
  } else {
    note = 'Holdings confirmed; no timestamped entry inside the early window was recovered';
  }

  return {
    configured: true,
    detected: matches.length > 0,
    count: matches.length,
    wallets: matches.map((m) => m.address),
    matches,
    totalPct: matches.reduce((sum, m) => sum + m.pct, 0),
    earlyBuyers,
    provablyEarly,
    note,
  };
}

/**
 * Same-block / bundle insider read, sourced from the security provider rather
 * than the watchlist. This covers the "Block #0 Jito bundle" requirement.
 */
export function describeInsiderAccumulation(security) {
  if (!security?.ok) return 'Insider data unavailable';

  const bundled = security.graphInsidersDetected ?? 0;
  const networks = security.insiderNetworks ?? 0;
  const insiderPct = security.insiderPct ?? 0;

  if (bundled > 0) {
    return `⚠️ ${bundled} bundled insider wallet(s) across ${networks} network(s), holding ${insiderPct.toFixed(1)}% — same-block accumulation detected`;
  }
  if (insiderPct > 0) {
    return `⚠️ Flagged insider wallets hold ${insiderPct.toFixed(1)}% of supply`;
  }
  return 'Clean organic buying (no same-block bundle networks detected)';
}
