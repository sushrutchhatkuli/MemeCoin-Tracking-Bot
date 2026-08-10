/**
 * Jito tip & bundle analyser.
 *
 * Sums the SOL paid to Jito validator tip accounts by the transactions in a
 * token's launch window — the literal price a cabal paid for guaranteed,
 * ordered inclusion at launch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE TRUSTING A TIP FIGURE.
 *
 * A large Jito tip is the single most PURCHASABLE signal in this engine. Every
 * other multiplier at least requires doing something — acquiring wallets,
 * moving size, generating volume. This one requires a payment, to a public
 * address, that anybody can make. Five SOL buys a "5 SOL tip" and nothing else.
 *
 * So what it measures is CAPITAL AND INTENT, not edge:
 *   - Intent, because nobody tips 5 SOL to buy a token casually. Whoever paid
 *     it needed to be first, in a specific slot, badly enough to burn real
 *     money on the ordering alone.
 *   - Capital, because they had 5 SOL to burn before the position was open.
 *
 * Neither of those is a claim that the token is good, and one specific misread
 * is worth naming: a developer rugging their own launch has exactly the same
 * incentive to tip. They want their own buys sequenced ahead of the crowd's,
 * and the tip is a rounding error against what they intend to extract. A high
 * tip on a token whose LP is not burned is evidence of a well-funded operation,
 * which is a reason for MORE suspicion, not less.
 *
 * This is why the score bonus is forfeited unless the contract audit
 * AFFIRMATIVELY passed — the same bar detectMegaRunner is held to, for the same
 * reason. See scoreToken.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── ON THE TIP ACCOUNT LIST ─────────────────────────────────────────────────
 * These eight addresses are the whole mechanism. A single wrong character means
 * the tracer reports "no tip paid" on every token forever, and reads as a
 * measurement rather than as a broken lookup — the same failure blacklist.mjs
 * warns about, where matching the wrong thing is worse than not matching at all.
 *
 * So they are NOT transcribed from documentation. They were read from Jito's
 * own block engine (`getTipAccounts` on mainnet.block-engine.jito.wtf) on
 * 2026-08-09 and verified against chain: each has live signature history, and a
 * sampled tip transaction credited the account by the expected delta.
 *
 * `refreshTipAccounts` re-reads that endpoint at runtime so the list cannot rot
 * silently if Jito adds accounts. It is best-effort and additive — a failed
 * refresh keeps the pinned set rather than emptying it, because an empty set is
 * indistinguishable from "nobody tipped".
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Jito mainnet tip payment accounts.
 *
 * Source: getTipAccounts, https://mainnet.block-engine.jito.wtf/api/v1/bundles
 * Read and verified 2026-08-09.
 */
export const JITO_TIP_ACCOUNTS = Object.freeze([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

const TIP_ACCOUNT_API = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

const LAMPORTS_PER_SOL = 1e9;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Re-read the tip account list from Jito's block engine.
 *
 * ADDITIVE, never subtractive. The response is unioned with the pinned set
 * rather than replacing it, so a partial or malformed answer cannot shrink the
 * list — losing an account silently converts real tips into zeroes, and zero is
 * the answer that looks normal.
 */
export async function fetchJitoTipAccounts({ timeoutMs = 10_000, pinned = JITO_TIP_ACCOUNTS } = {}) {
  try {
    const res = await fetch(TIP_ACCOUNT_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, accounts: new Set(pinned) };

    const body = await res.json().catch(() => null);
    const listed = (body?.result ?? []).filter((a) => typeof a === 'string' && BASE58_RE.test(a));
    if (!listed.length) {
      return { ok: false, error: 'no usable addresses in response', accounts: new Set(pinned) };
    }

    const accounts = new Set([...pinned, ...listed]);
    return {
      ok: true,
      accounts,
      added: listed.filter((a) => !pinned.includes(a)),
      source: 'jito-block-engine',
    };
  } catch (err) {
    return { ok: false, error: err.message, accounts: new Set(pinned) };
  }
}

/**
 * The full account list for a transaction, in balance-index order.
 *
 * `meta.preBalances` / `postBalances` are indexed over EVERY account the
 * transaction touched, but on a versioned transaction `message.accountKeys` may
 * hold only the static keys — the rest arrive in `meta.loadedAddresses`,
 * writable first, then readonly. Reading a balance at an index derived from the
 * short list is not a small error: it silently attributes one account's balance
 * change to a different account.
 *
 * Measured against Helius on 2026-08-09: it returns the merged list in
 * accountKeys and an empty loadedAddresses, so the concatenation is usually a
 * no-op. It is done anyway because "usually" is doing a lot of work in that
 * sentence, and a different provider is a config change away.
 *
 * `aligned` is false when the assembled list still does not match the balance
 * arrays. Callers must treat that as UNKNOWN rather than as no tip.
 */
export function accountKeysInBalanceOrder(txResult) {
  const message = txResult?.transaction?.message;
  const meta = txResult?.meta;
  const staticKeys = (message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k?.pubkey));

  const balanceCount = meta?.preBalances?.length ?? 0;
  if (staticKeys.length >= balanceCount) {
    return { keys: staticKeys, aligned: staticKeys.length === balanceCount };
  }

  const loaded = [
    ...(meta?.loadedAddresses?.writable ?? []),
    ...(meta?.loadedAddresses?.readonly ?? []),
  ];
  const keys = [...staticKeys, ...loaded];
  return { keys, aligned: keys.length === balanceCount };
}

/**
 * The Jito tip paid by ONE transaction, in lamports.
 *
 * Read from the tip account's balance delta rather than by parsing a
 * SystemProgram transfer instruction. Both would work for the common case, but
 * the delta is what actually happened: it survives the tip being paid from a
 * CPI, from an inner instruction, or bundled into a program's own logic, none
 * of which appear as a top-level transfer. A credit to a tip account is a tip;
 * those accounts exist for nothing else.
 *
 * Pure, so it can be verified against a recorded transaction without an RPC.
 *
 * Returns ok:false when the account list could not be aligned with the balance
 * arrays — the caller must not read that as a zero tip.
 */
export function extractJitoTip(txResult, tipAccounts = JITO_TIP_ACCOUNTS) {
  const meta = txResult?.meta;
  const empty = { ok: true, lamports: 0, sol: 0, accounts: [] };

  if (!meta?.preBalances || !meta?.postBalances) {
    return { ok: false, reason: 'transaction has no balance data', lamports: 0, sol: 0, accounts: [] };
  }
  // A failed transaction paid no tip that counts: the bundle did not land.
  if (meta.err) return empty;

  const tips = tipAccounts instanceof Set ? tipAccounts : new Set(tipAccounts);
  const { keys, aligned } = accountKeysInBalanceOrder(txResult);
  if (!aligned) {
    return {
      ok: false,
      reason: `account list (${keys.length}) does not match balances (${meta.preBalances.length})`,
      lamports: 0,
      sol: 0,
      accounts: [],
    };
  }

  let lamports = 0;
  const accounts = [];
  for (let i = 0; i < keys.length; i++) {
    if (!tips.has(keys[i])) continue;
    const delta = (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
    // Only credits count. A tip account cannot be a source in a tip payment,
    // and a negative delta would otherwise net real tips away to nothing.
    if (delta > 0) {
      lamports += delta;
      accounts.push({ account: keys[i], lamports: delta, sol: delta / LAMPORTS_PER_SOL });
    }
  }

  return { ok: true, lamports, sol: lamports / LAMPORTS_PER_SOL, accounts };
}

/**
 * Roll per-transaction tips up into one figure for a token.
 *
 * DEDUPLICATED BY SIGNATURE, which is the whole reason this is a function
 * rather than a sum. One transaction routinely produces several buyer rows —
 * an aggregator filling multiple wallets, a bundle leg with two owners — and
 * the tip belongs to the TRANSACTION. Summing per buyer would multiply a single
 * 0.5 SOL tip by however many wallets happened to be in it, which inflates
 * exactly the tokens that look most like a cabal.
 *
 * `unknown` counts entries whose tip could not be read. They are reported, not
 * folded into the total as zeroes: "we could not read three transactions" and
 * "three transactions paid nothing" are different claims, and only one of them
 * should ever lower a tip figure.
 */
export function summariseTips({ entries = [], solUsd = null, config = {} } = {}) {
  const cfg = config.jitoTips ?? {};
  const minSol = cfg.minTipSolForBonus ?? 1.0;
  const boost = cfg.scoreBoost ?? 15;

  const bySignature = new Map();
  let unknown = 0;

  for (const e of entries) {
    if (!e?.signature) continue;
    if (bySignature.has(e.signature)) continue;
    if (e.jitoTipLamports === null || e.jitoTipLamports === undefined) {
      unknown++;
      continue;
    }
    bySignature.set(e.signature, e.jitoTipLamports);
  }

  const lamports = [...bySignature.values()].reduce((a, b) => a + b, 0);
  const totalSol = lamports / LAMPORTS_PER_SOL;
  const tippingTxs = [...bySignature.values()].filter((v) => v > 0).length;
  const totalUsd = solUsd ? totalSol * solUsd : null;

  // Strictly greater than the floor, matching the specified ">1.0 SOL". A token
  // tipping exactly the floor does not clear it.
  const qualifies = cfg.enabled !== false && totalSol > minSol;

  return {
    detected: lamports > 0,
    totalLamports: lamports,
    totalSol,
    totalUsd,
    solUsd,
    tippingTxs,
    inspectedTxs: bySignature.size,
    unknownTxs: unknown,
    minTipSol: minSol,
    qualifies,
    scoreBoost: qualifies ? boost : 0,
    label: lamports > 0 ? formatTipLine({ totalSol, totalUsd }) : null,
  };
}

/** `JITO BUNDLE TIP: 5.20 SOL ($401)` — one renderer, so every surface agrees. */
export function formatTipLine({ totalSol, totalUsd }) {
  const usd =
    totalUsd === null || totalUsd === undefined
      ? ''
      : ` ($${Math.round(totalUsd).toLocaleString('en-US')})`;
  return `JITO BUNDLE TIP: ${totalSol.toFixed(2)} SOL${usd}`;
}

/* ------------------------------------------------------------------ *
 * RPC fallback
 * ------------------------------------------------------------------ */

async function rpc(url, method, params, timeoutMs = 20_000) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await res.json();
    return body.error ? { error: JSON.stringify(body.error).slice(0, 160) } : { result: body.result };
  } catch (err) {
    return { error: err.message };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read tips for signatures whose transactions are not already in hand.
 *
 * The normal path costs NOTHING: buyer replay in smart_money.mjs already fetches
 * every launch transaction, so the tip is extracted there and rides along on the
 * buyer row. This exists for the paths that skipped replay — an explicit /audit
 * on a token with no watchlist hit, or a re-run over cached buyers — and it is
 * bounded by maxSignatureLookups because it is one getTransaction per signature
 * against the same RPC budget everything else competes for.
 */
export async function fetchTipsForSignatures({
  signatures = [],
  rpcUrl,
  tipAccounts = JITO_TIP_ACCOUNTS,
  config = {},
  delayMs = 220,
}) {
  const cfg = config.jitoTips ?? {};
  const cap = cfg.maxSignatureLookups ?? 12;
  const unique = [...new Set(signatures.filter(Boolean))].slice(0, cap);
  const entries = [];

  if (!rpcUrl || !unique.length) return entries;

  for (const signature of unique) {
    const tx = await rpc(rpcUrl, 'getTransaction', [
      signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
    ]);
    if (tx.error) {
      // Unreadable, not untipped. summariseTips counts this as unknown.
      entries.push({ signature, jitoTipLamports: null });
      continue;
    }
    const tip = extractJitoTip(tx.result, tipAccounts);
    entries.push({ signature, jitoTipLamports: tip.ok ? tip.lamports : null });
    await sleep(delayMs);
  }

  return entries;
}

/**
 * End-to-end: tips paid inside a token's launch window.
 *
 * Scoped to the launch window rather than to all replayed buyers, because the
 * question is what the CABAL paid to get in at launch. A tip attached to an
 * ordinary trade an hour later is somebody paying for priority in a busy
 * market, which is not the same fact and should not inflate the same number.
 *
 * An entry with no `secondsAfterLaunch` is EXCLUDED rather than assumed to be
 * in the window: pair creation time is frequently unavailable on bonding-curve
 * pairs, and letting unknown timing count would quietly turn "all buyers" into
 * "launch buyers" on exactly the tokens where the distinction matters most.
 */
export async function traceBundleTips({
  buyers = [],
  rpcUrl = null,
  solUsd = null,
  config = {},
  tipAccounts = JITO_TIP_ACCOUNTS,
} = {}) {
  const cfg = config.jitoTips ?? {};
  if (cfg.enabled === false) {
    return { ...summariseTips({ entries: [], solUsd, config }), skipped: 'jitoTips disabled' };
  }

  const windowSec = cfg.launchWindowSeconds ?? config.insiderCluster?.bundleLaunchWindowSeconds ?? 300;
  const inWindow = buyers.filter(
    (b) =>
      b?.secondsAfterLaunch !== null &&
      b?.secondsAfterLaunch !== undefined &&
      b.secondsAfterLaunch >= 0 &&
      b.secondsAfterLaunch <= windowSec
  );

  if (!inWindow.length) {
    return {
      ...summariseTips({ entries: [], solUsd, config }),
      windowSec,
      skipped: 'no buyers with a known launch-window timestamp',
    };
  }

  // Anything already carrying a tip from buyer replay is free. Only the rest
  // costs an RPC call, and only when a url was supplied.
  const captured = inWindow.filter(
    (b) => b.jitoTipLamports !== null && b.jitoTipLamports !== undefined
  );
  const missing = inWindow.filter(
    (b) => (b.jitoTipLamports === null || b.jitoTipLamports === undefined) && b.signature
  );

  const fetched = rpcUrl && missing.length
    ? await fetchTipsForSignatures({
        signatures: missing.map((b) => b.signature),
        rpcUrl,
        tipAccounts,
        config,
        delayMs: config.smartMoney?.rpcDelayMs ?? 220,
      })
    : missing.map((b) => ({ signature: b.signature, jitoTipLamports: null }));

  return { ...summariseTips({ entries: [...captured, ...fetched], solUsd, config }), windowSec };
}

/* ------------------------------------------------------------------ *
 * CLI — node bundle_tracer.mjs --tips <signature> [...]
 * ------------------------------------------------------------------ */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);

  if (argv.includes('--accounts')) {
    const res = await fetchJitoTipAccounts({});
    console.log(res.ok ? 'Tip accounts (live from Jito block engine):' : `Refresh failed (${res.error}) — pinned list:`);
    for (const a of res.accounts) console.log(`  ${a}`);
    if (res.added?.length) console.log(`\n${res.added.length} account(s) not in the pinned list — update JITO_TIP_ACCOUNTS.`);
    process.exit(0);
  }

  const sigs = argv.filter((a) => !a.startsWith('--'));
  if (!sigs.length) {
    console.log('Usage: node bundle_tracer.mjs --tips <signature> [<signature> …]');
    console.log('       node bundle_tracer.mjs --accounts');
    process.exit(0);
  }

  const HERE = dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));

  // The RPC url is read here rather than through telegram.mjs's loadEnv, and
  // that is not a style preference — importing telegram.mjs from this CLI
  // deadlocks. smart_money.mjs imports THIS module for extractJitoTip, and
  // telegram.mjs imports smart_money.mjs, so the dynamic import closes a cycle
  // back into a module that is still executing its own top-level await. Node
  // reports it as "unsettled top-level await" and exits 13.
  const rpcUrl =
    process.env.SOLANA_RPC_URL ||
    (await readFile(join(HERE, '.env'), 'utf8').catch(() => '')).match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim() ||
    config.rpcUrl;

  const entries = await fetchTipsForSignatures({ signatures: sigs, rpcUrl, config });
  for (const e of entries) {
    console.log(
      `${e.signature.slice(0, 24)}… ${
        e.jitoTipLamports === null ? 'unreadable' : `${(e.jitoTipLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL`
      }`
    );
  }
  const summary = summariseTips({ entries, config });
  console.log(`\nTotal: ${summary.totalSol.toFixed(9)} SOL across ${summary.tippingTxs}/${summary.inspectedTxs} tx`);
}
