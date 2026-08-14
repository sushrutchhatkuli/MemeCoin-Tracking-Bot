#!/usr/bin/env node
/**
 * Live copy-trade — PHASE 1 shadow, PHASE 2 live micro-testing.
 *
 *   node live_copytrade.mjs --dry-run --pct-whale 15 --watch 5      measures only
 *   node live_copytrade.mjs --dry-run --once                        one pass, exit
 *   node live_copytrade.mjs --live --keyfile <path> --watch 5       SPENDS MONEY
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * --dry-run CANNOT SPEND MONEY. --live CAN. THE DEFAULT IS NEITHER.
 *
 * Running with no mode flag refuses to start. That is deliberate: the failure
 * mode of defaulting to dry-run is a user who thinks they are trading and is
 * not, and the failure mode of defaulting to live is unthinkable, so neither is
 * a default. The mode is always stated.
 *
 * Under --dry-run the broadcast path is not merely skipped, it is unreachable:
 * no signer is constructed, so there is nothing that could sign even if a later
 * branch tried.
 *
 * ── THE KEY NEVER ENTERS THIS REPOSITORY ────────────────────────────────────
 * --live requires --keyfile pointing OUTSIDE the repo, and startup refuses a
 * path inside it (see assertKeyfileOutsideRepo). The bytes are read at the CLI
 * edge, handed straight to createSigner, and never stored, logged, or written.
 * This module has no default key location and no environment-variable fallback
 * on purpose: a convenient one is how a key ends up in a commit.
 *
 * Use a DEDICATED hot wallet holding only what you can afford to lose outright.
 * At the shipped caps that is about 0.1 SOL of exposure.
 *
 * ── WHAT PHASE 1 IS FOR ────────────────────────────────────────────────────
 * Measuring, not trading. Three numbers cannot be obtained any other way:
 *
 *   1. The NO-ROUTE RATE. How often is a token the target buys unroutable at
 *      the moment we would need to buy it?
 *   2. The QUOTE GAP. Jupiter's quoted outAmount against the target's own
 *      implied fill — the first honest estimate of real copy impact.
 *   3. The GATE REJECTION RATE. How many of the target's buys would the safety
 *      checks refuse, and for what reason?
 *
 * All three are logged per intent. None of them require spending anything.
 *
 * ── MEASURED BEFORE BUILDING, BECAUSE ONE ASSUMPTION ALREADY COST A BOOK ───
 * The concern that Jupiter cannot route freshly-created tokens is real in
 * general and DOES NOT MATCH THIS TARGET. Sampling its 12 most recent buys:
 *
 *   jupiter routable: 12/12    unroutable: 0/12
 *   every one routed "Pump.fun Amm", ages 2-9 minutes
 *
 * It buys tokens that have already MIGRATED to the Pump AMM, not 10-second-old
 * bonding curves. So a direct bonding-curve fallback is not built here on the
 * strength of a worry the data contradicts. What is built is DETECTION: every
 * no-route is recorded with the token's age and venue, so the measured rate
 * decides whether that fallback is ever worth writing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  paperConfig,
  loadBook,
  createBook,
  resolveTarget,
  createWhaleSocket,
  fetchWhaleTrades,
  fetchLatestSignature,
  fetchSolUsd,
  impliedEntryPriceUsd,
  impliedExitPriceUsd,
  mirrorPositionSize,
  formatTicker,
  usd,
  resolveChainRpc,
  PUBLIC_SOLANA_RPC,
} from './paper_copytrade.mjs';

import {
  createSigner,
  executeTransaction,
  confirmWithinSlots,
  unresolvedIntents,
  resolveIntentOutcome,
  fetchHoldings,
  diffHoldings,
  panicEscalation,
} from './live_execute.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const INTENT_LOG_PATH = join(HERE, '.state', 'live_intents.json');

/**
 * The live book is a SEPARATE FILE from the paper book, and must stay that way.
 *
 * They describe different wallets. Sharing one file means reconcile compares
 * the live wallet's chain balances against paper positions it never held —
 * which reads as "5 stale positions dropped" on the very first run — and one
 * save call away from overwriting a multi-day paper measurement with the state
 * of a wallet holding 0.01 SOL.
 */
export const LIVE_BOOK_PATH = join(HERE, '.state', 'live_book.json');

export async function loadLiveBook(path = LIVE_BOOK_PATH) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // A fresh live book has no positions ON PURPOSE. Whatever the wallet
    // actually holds is discovered by reconcile against the chain, not carried
    // over from a book describing some other wallet.
    return { positions: {}, closed: [], startedAt: Date.now(), mode: 'live' };
  }
}

export async function saveLiveBook(book, path = LIVE_BOOK_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(book, null, 2), 'utf8');
  return book;
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1e9;

/** Programs that identify where a token currently trades. */
export const PUMP_BONDING_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export const LIVE_DEFAULTS = {
  // Jupiter. NOT quote-api.jup.ag/v6 — that host no longer resolves. Verified
  // today: lite-api answers in ~241ms, api.jup.ag in ~149ms.
  jupiterBase: 'https://lite-api.jup.ag/swap/v1',
  slippageBps: 300,
  priorityFeeMaxLamports: 1_000_000,
  jitoTipLamports: 0,
  // Minimum spacing between Jupiter calls. See the throttle note in
  // fetchJupiterQuote for why this is not politeness but measurement hygiene.
  quotePaceMs: 400,

  // ── GAS RESERVE ──────────────────────────────────────────────────────────
  // Native SOL that is never spent on tokens. An ATA costs ~0.00204 SOL of
  // rent, and priority fees and tips come out of the same balance, so a wallet
  // that invests down to zero cannot transact at all — including the sells it
  // needs to get out. Held back rather than hoped for.
  gasReserveSol: 0.05,

  // ── EXPIRY ───────────────────────────────────────────────────────────────
  // A blockhash stays valid ~150 slots (~60s). Polling that long is wrong for
  // copy-trading: a buy that lands 15s late is a buy at the top of a move the
  // target has already left. An unconfirmed transaction is abandoned after this
  // many slots and the buy is NOT retried — a late fill is worse than a missed
  // one. Enforced in confirmWithinSlots.
  maxConfirmSlots: 3,

  // ── PANIC DUMP ───────────────────────────────────────────────────────────
  // Exits are not symmetric with entries. A missed buy costs an opportunity; a
  // failed sell leaves real money in a pool that may be draining. After this
  // many normal attempts the exit escalates rather than repeating.
  panicAfterFailedSells: 2,
  panicSlippageBps: 2500,
  panicPriorityFeeLamports: 5_000_000,
  panicMaxAttempts: 5,

  // Preflight simulation catches a doomed transaction before it costs a fee.
  // Skipping it saves ~100ms and pays for every failure in real lamports; not
  // a trade worth making on a first live run.
  skipPreflight: false,

  // Safety gating. See evaluateSafetyGate for why this is venue-aware.
  requireSafetyGate: true,
  maxTopHolderPct: 60,

  // Hard caps. Inert in Phase 1; present so Phase 2 cannot ship without them.
  maxTradeSol: 0.01,
  maxExposureSol: 0.1,
  dailyLossLimitSol: 0.05,
};

export function liveConfig(overrides = {}) {
  const cfg = { ...LIVE_DEFAULTS, ...overrides };
  cfg.slippageBps = Math.max(1, Math.floor(Number(cfg.slippageBps) || 0));
  cfg.gasReserveSol = Math.max(0, Number(cfg.gasReserveSol) || 0);
  cfg.maxConfirmSlots = Math.max(1, Math.floor(Number(cfg.maxConfirmSlots) || 1));
  cfg.maxTradeSol = Math.max(0, Number(cfg.maxTradeSol) || 0);
  cfg.maxExposureSol = Math.max(0, Number(cfg.maxExposureSol) || 0);
  if (!/^https?:\/\//.test(String(cfg.jupiterBase ?? ''))) cfg.jupiterBase = LIVE_DEFAULTS.jupiterBase;
  return cfg;
}

/* ------------------------------------------------------------------ *
 * Sizing under a gas reserve
 * ------------------------------------------------------------------ */

/**
 * How much SOL may actually be committed to a token. PURE.
 *
 * Sits on top of mirrorPositionSize: that decides what the copy WANTS, this
 * decides what the wallet can afford while staying able to transact.
 *
 * The reserve is subtracted BEFORE the trade is sized, not checked afterwards.
 * Checking afterwards is how a wallet ends up at 0.004 SOL — technically
 * positive, unable to pay for the ATA on its next buy or the fee on its next
 * sell, and stuck holding whatever it already has.
 */
export function sizeUnderGasReserve(cfg, { requestedSol = 0, nativeSolBalance = 0, exposureSol = 0 } = {}) {
  const spendable = nativeSolBalance - cfg.gasReserveSol;
  if (!(spendable > 0)) {
    return { ok: false, reason: `below gas reserve (${nativeSolBalance.toFixed(4)} SOL, reserve ${cfg.gasReserveSol})` };
  }
  const exposureRoom = cfg.maxExposureSol - exposureSol;
  if (!(exposureRoom > 0)) {
    return { ok: false, reason: `at max exposure (${cfg.maxExposureSol} SOL)` };
  }
  const sizeSol = Math.min(requestedSol, spendable, cfg.maxTradeSol, exposureRoom);
  if (!(sizeSol > 0)) return { ok: false, reason: 'nothing left to size with' };
  return {
    ok: true,
    sizeSol,
    cappedBy:
      sizeSol < requestedSol
        ? sizeSol === spendable
          ? 'gas reserve'
          : sizeSol === cfg.maxTradeSol
            ? 'maxTradeSol'
            : 'maxExposureSol'
        : null,
  };
}

/* ------------------------------------------------------------------ *
 * Per-mint mutex
 * ------------------------------------------------------------------ */

/**
 * One in-flight operation per mint.
 *
 * The socket delivers at sub-second speed and a target routinely sends a BUY
 * and an ADD of the same token within a couple of hundred milliseconds. Without
 * a lock both would build a transaction, and both would try to create the same
 * ATA — a duplicate-account failure at best, double size at worst, and a
 * position whose accounting no longer matches the chain either way.
 *
 * A promise chain rather than a boolean: the second caller WAITS instead of
 * being dropped, so an ADD that arrives mid-BUY is still honoured once the BUY
 * settles. Dropping it would silently under-copy.
 */
export function createMintLock() {
  const chains = new Map();
  return {
    async run(mint, fn) {
      const prior = chains.get(mint) ?? Promise.resolve();
      let release;
      const gate = new Promise((r) => (release = r));
      // The CHAIN is what gets stored, so the cleanup below must compare
      // against the chain — comparing against `gate` never matches, and the
      // map then retains a promise per mint for the life of the process. That
      // is a slow leak on a target trading dozens of distinct tokens an hour,
      // and it was invisible until depth() was asserted.
      const chain = prior.then(() => gate);
      chains.set(mint, chain);
      await prior;
      try {
        return await fn();
      } finally {
        release();
        // Only clear if nobody queued behind us.
        if (chains.get(mint) === chain) chains.delete(mint);
      }
    },
    depth: () => chains.size,
  };
}

/* ------------------------------------------------------------------ *
 * Venue and safety
 * ------------------------------------------------------------------ */

/**
 * Where does this token actually trade? PURE.
 *
 * Read from the route Jupiter returns rather than guessed from the mint, since
 * the same token migrates between venues over its life.
 */
export function classifyVenue(quote) {
  const labels = (quote?.routePlan ?? []).map((r) => String(r?.swapInfo?.label ?? '').toLowerCase());
  if (labels.some((l) => l.includes('pump') && l.includes('amm'))) return 'pump-amm';
  if (labels.some((l) => l.includes('pump'))) return 'pump-bonding';
  if (labels.some((l) => l.includes('raydium'))) return 'raydium';
  return labels.length ? labels.join('+') : 'unknown';
}

/**
 * Would the safety checks let this buy through? PURE.
 *
 * ── VENUE-AWARE, BECAUSE A FLAT RULE BLOCKS EVERYTHING ─────────────────────
 * An un-migrated Pump.fun token has NO liquidity pool, so "LP burned" is not
 * false for it — it is undefined, and testing it as a boolean rejects every
 * such token. Holder concentration is similarly useless there: on a bonding
 * curve the curve itself holds most of the supply.
 *
 * So the LP and concentration rules apply only where a pool exists. What does
 * NOT get relaxed is mint and freeze authority: those are the checks that
 * separate a token you can sell from one you cannot, and they are meaningful
 * at every venue. A copy bot that waives them is a bot that mirrors the target
 * into a honeypot and then cannot follow them out.
 */
export function evaluateSafetyGate(security, { venue = 'unknown', cfg = LIVE_DEFAULTS } = {}) {
  if (!cfg.requireSafetyGate) return { pass: true, waived: ['gate disabled'] };
  // Fails CLOSED. An unaudited token is not a safe one, and on the live path
  // this is the difference between mirroring the target and mirroring them
  // into something that cannot be sold.
  if (!security) return { pass: false, reasons: ['no security record'] };

  const reasons = [];
  const waived = [];

  // Always enforced, at every venue.
  if (security.mintAuthority) reasons.push('mint authority still set');
  if (security.freezeAuthority) reasons.push('freeze authority still set');

  const hasPool = venue !== 'pump-bonding';
  if (hasPool) {
    // sources.mjs names this top10Pct; accept either so a caller passing a
    // hand-built record is not silently unchecked.
    const top = Number(security.top10Pct ?? security.topHoldersPct);
    if (Number.isFinite(top) && top > cfg.maxTopHolderPct) {
      reasons.push(`top holders ${top.toFixed(0)}% > ${cfg.maxTopHolderPct}%`);
    }
  } else {
    // Not a pass — an inapplicable test, recorded so the waiver is visible
    // rather than silently assumed.
    waived.push('LP/concentration n/a on an un-migrated bonding curve');
  }

  return { pass: reasons.length === 0, reasons, waived, venue };
}

/* ------------------------------------------------------------------ *
 * Jupiter
 * ------------------------------------------------------------------ */

/**
 * Quote a swap. Never throws.
 *
 * A NO-ROUTE is a first-class outcome, not an error: it is one of the three
 * numbers Phase 1 exists to measure, and it must be distinguishable from a
 * network failure or a rate limit. Measured on this target it was 0/12, but
 * that is a fact about today rather than a guarantee.
 */
export async function fetchJupiterQuote(
  {
    inputMint,
    outputMint,
    amountLamports,
    slippageBps,
    base = LIVE_DEFAULTS.jupiterBase,
    fetchImpl = fetch,
    retries = 1,
    retryDelayMs = 1200,
  } = {}
) {
  const url =
    `${base}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${Math.floor(amountLamports)}&slippageBps=${slippageBps}`;

  const headers = {};
  const apiKey = process.env['JUPITER_API_KEY'];
  if (apiKey) headers['x-api-key'] = apiKey;

  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(12_000) });
      const text = await res.text();

      if (res.ok) {
        const quote = JSON.parse(text);
        if (quote?.outAmount) return { ok: true, quote, attempts: attempt + 1 };
        last = { ok: false, noRoute: true, error: 'quote returned no outAmount' };
        continue;
      }


      // ── A THROTTLE IS NOT A ROUTING FAILURE, AND IT LOOKED LIKE ONE ────────
      // The free tier answers HTTP 400 under load with a body that matches the
      // same wording a genuine no-route uses. Taken at face value it produced a
      // 50% "no-route rate" in a live run — and EVERY mint in it quoted HTTP
      // 200 when retried individually seconds later. That figure would have
      // justified building a direct Pump.fun fallback for a problem that does
      // not exist, which is the same shape of error as copyImpactPct 9.
      //
      // So a refusal is retried before it is believed. A 404 is taken at face
      // value — that one is unambiguous — but a 400/429 only becomes NO_ROUTE
      // if it survives a retry.
      // ── HTTP 400 IS A RATE LIMIT HERE, PROVEN, NOT INFERRED ───────────────
      // Jupiter uses 400 for BOTH a genuine no-route and a throttle, and the
      // bodies are worded the same, so the wording cannot separate them.
      // MEASURED with an 8-request burst on one mint that quotes fine alone:
      //   lite-api.jup.ag   8x HTTP 400
      //   api.jup.ag        5x HTTP 400 + 3x HTTP 429
      // The 429s settle it — identical behaviour, one host merely labels the
      // limit honestly. Across ~30 refusals in two runs, every single mint
      // quoted HTTP 200 when retried individually, and NOT ONE was confirmed
      // unroutable.
      //
      // So 400 is classified as THROTTLED. Only a 404, or a 200 carrying no
      // outAmount, is called NO_ROUTE. Getting this backwards produced a "50%
      // no-route rate" that would have justified building a direct Pump.fun
      // fallback for a problem with no confirmed instances.
      if (res.status === 404) return { ok: false, noRoute: true, error: 'no route (404)', attempts: attempt + 1 };
      const throttled = res.status === 429 || res.status === 400;
      last = {
        ok: false,
        noRoute: !throttled && /no route|not tradable|could not find any route/i.test(text),
        throttled,
        error: `HTTP ${res.status}${throttled ? ' (rate limited)' : ''}`,
      };
    } catch (err) {
      last = { ok: false, noRoute: false, error: err.message };
    }
  }
  return { ...last, attempts: retries + 1, retried: retries > 0 };
}

/**
 * Build the UNSIGNED transaction Jupiter would have us send.
 *
 * This is the end of the line in Phase 1. The base64 payload is logged and
 * discarded; nothing signs it.
 */
export async function buildSwapTransaction(
  { quote, userPublicKey, cfg = LIVE_DEFAULTS, fetchImpl = fetch } = {}
) {
  try {
    const headers = { 'content-type': 'application/json' };
    const apiKey = process.env['JUPITER_API_KEY'];
    if (apiKey) headers['x-api-key'] = apiKey;

    const res = await fetchImpl(`${cfg.jupiterBase}/swap`, {
      method: 'POST',
      headers,
      body: JSON.stringify({

        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: cfg.priorityFeeMaxLamports,
            priorityLevel: 'high',
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    if (!body?.swapTransaction) return { ok: false, error: 'no swapTransaction returned' };
    return {
      ok: true,
      transactionBase64: body.swapTransaction,
      bytes: Buffer.from(body.swapTransaction, 'base64').length,
      lastValidBlockHeight: body.lastValidBlockHeight ?? null,
      computeUnitLimit: body.computeUnitLimit ?? null,
      prioritizationFeeLamports: body.prioritizationFeeLamports ?? null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * The boundary
 * ------------------------------------------------------------------ */

/**
 * ITEM 1 — refuse a key stored inside the repository. PURE.
 *
 * The single most common way a hot wallet is lost is `git add -A` on a repo
 * that happens to contain the key. A .gitignore entry is not protection: it is
 * one `git add -f`, one stale ignore file, or one copy into a different folder
 * away from failing. Refusing the path outright is the only version of this
 * check that cannot be forgotten.
 *
 * Compares resolved, case-folded paths — Windows is case-insensitive, so a
 * naive comparison misses `C:\...\AEGIS\key.json`.
 */
export function assertKeyfileOutsideRepo(keyfilePath, repoRoot) {
  const key = resolve(keyfilePath);
  const root = resolve(repoRoot);
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (norm(key) === norm(root) || norm(key).startsWith(norm(root) + '/')) {
    throw new Error(
      `refusing to read a wallet key from inside the repository:\n  ${key}\n` +
        `Move it somewhere outside ${root} — a key in a git working tree is one 'git add -A' from being published.`
    );
  }
  return key;
}

/**
 * ITEM 1 — read a Solana CLI keypair file into raw bytes. EDGE ONLY.
 *
 * Called from main() and nowhere else. The bytes go straight into createSigner
 * and the array is not retained: the only surviving reference is the closure
 * inside the signer.
 */
export async function readKeyfileBytes(keyfilePath, { repoRoot, readFileImpl = readFile } = {}) {
  const safe = repoRoot ? assertKeyfileOutsideRepo(keyfilePath, repoRoot) : resolve(keyfilePath);
  let parsed;
  try {
    parsed = JSON.parse(await readFileImpl(safe, 'utf8'));
  } catch (err) {
    // Deliberately does not echo file contents into the error.
    throw new Error(`could not read keypair at ${safe}: ${err.message}`);
  }
  if (!Array.isArray(parsed) || (parsed.length !== 64 && parsed.length !== 32)) {
    throw new Error('keyfile must be a JSON array of 32 or 64 bytes (the format `solana-keygen` writes)');
  }
  return Uint8Array.from(parsed);
}

/**
 * ITEM 2 — broadcast one planned intent.
 *
 * A thin seam over live_execute so the decision layer never touches signing
 * directly, and so `signer` being absent is a hard stop rather than a branch
 * that could be mis-taken. In --dry-run no signer is ever constructed, so this
 * is unreachable by construction rather than by flag.
 */
export async function submitIntent({ intent, signer, rpcUrl, rpcImpl, cfg = {}, onSent = null } = {}) {
  if (!signer) throw new Error('submitIntent called without a signer — dry-run must never reach this path');
  if (!intent?.transactionBase64) return { status: 'NOTHING_TO_SEND', error: 'intent carries no transaction' };
  return executeTransaction({
    transactionBase64: intent.transactionBase64,
    signer,
    rpcUrl,
    rpcImpl,
    cfg,
    onSent,
  });
}

/* ------------------------------------------------------------------ *
 * Intent log
 * ------------------------------------------------------------------ */

export async function loadIntents(path = INTENT_LOG_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export async function appendIntent(intent, path = INTENT_LOG_PATH, limit = 2000) {
  const all = await loadIntents(path);
  all.push(intent);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(all.slice(-limit), null, 2), 'utf8');
  return intent;
}

/**
 * A stable id for one intended action. PURE.
 *
 * Derived from the target's own signature plus the side, so the same observed
 * trade always produces the same id no matter how many times it is seen. That
 * is what makes a crash mid-flight recoverable in Phase 2: on restart, an id
 * already present with a recorded outcome is never re-executed.
 */
export function intentId(signature, side) {
  return `${String(signature ?? 'unknown').slice(0, 24)}:${side}`;
}

/* ------------------------------------------------------------------ *
 * Planning one trade
 * ------------------------------------------------------------------ */

/**
 * Turn one observed target trade into an intent, or a reasoned decline.
 *
 * Everything except the two network calls is decided before either is made, so
 * a trade that would be refused never costs a quote.
 */
export async function planIntent(
  trade,
  {
    cfg,
    paperCfg,
    book,
    solUsd,
    userPublicKey,
    nativeSolBalance,
    exposureSol = 0,
    securityFor = async () => null,
    decimalsFor = async () => null,
    quoteFn = fetchJupiterQuote,
    buildFn = buildSwapTransaction,
    now = Date.now(),
  } = {}
) {
  const side = trade.kind;
  const base = {
    id: intentId(trade.signature, side),
    at: now,
    side,
    mint: trade.mint,
    targetSignature: trade.signature ?? null,
    targetSolAmount: side === 'BUY' ? trade.solSpent : trade.solReceived,
  };

  if (side === 'SELL') {
    // Phase 1 records the exit decision without pricing it: the size depends on
    // a real token balance this build has no wallet to read. What it does carry
    // is the target's own fill, which is the number Phase 3 compares against.
    return {
      ...base,
      decision: 'WOULD_SELL',
      sellFraction: trade.sellFraction ?? 1,
      targetFillUsd: impliedExitPriceUsd(trade, { solUsd, minReceiveSol: paperCfg.impliedMinSpendSol }),
    };
  }

  const wanted = mirrorPositionSize(paperCfg, {
    whaleSpendSol: trade.solSpent,
    balanceSol: nativeSolBalance,
  });
  if (!wanted.ok) return { ...base, decision: 'SKIP', reason: wanted.reason };

  const sized = sizeUnderGasReserve(cfg, {
    requestedSol: wanted.sizeSol,
    nativeSolBalance,
    exposureSol,
  });
  if (!sized.ok) return { ...base, decision: 'SKIP', reason: sized.reason };

  // ── FIRED CONCURRENTLY WITH THE QUOTE, NOT AFTER IT ───────────────────────
  // The security audit costs ~107ms measured, the quote ~28ms and decimals
  // ~31ms. Run serially that is the sum; run together it is the largest of
  // them. Nothing is traded any earlier by hurrying the decision, but ~130ms
  // of the ~180ms decision path is pure waiting, and on a copy trade whose
  // edge decays within a second that is worth removing.
  //
  // The audit does not depend on the quote. Only the GATE is venue-aware, and
  // the venue is applied at evaluation time below, so nothing is weakened by
  // starting the audit earlier. The catch is required because an early return
  // on a failed quote would otherwise leave this promise unhandled.
  const securityPromise = securityFor(trade.mint).catch(() => null);
  const decimalsPromise = decimalsFor(trade.mint).catch(() => null);

  const quoted = await quoteFn({
    inputMint: WSOL_MINT,
    outputMint: trade.mint,
    amountLamports: sized.sizeSol * LAMPORTS,
    slippageBps: cfg.slippageBps,
    base: cfg.jupiterBase,
  });
  if (!quoted.ok) {
    return {
      ...base,
      // A refusal that survived a retry AND is throttle-shaped is reported as
      // THROTTLED, not NO_ROUTE. Pooling them overstates unroutability, which
      // is the number that decides whether a direct-program fallback is worth
      // building at all.
      decision: quoted.noRoute ? 'NO_ROUTE' : quoted.throttled ? 'THROTTLED' : 'QUOTE_FAILED',
      reason: quoted.error,
      sizeSol: sized.sizeSol,
    };
  }

  const venue = classifyVenue(quoted.quote);

  // The comparison Phase 1 exists to produce: what Jupiter would fill at,
  // against what the target actually paid.
  //
  // COMPUTED BEFORE THE GATE, and attached even to a blocked intent. Phase 1 is
  // a measurement exercise: a buy the gate refuses still tells us what the copy
  // would have cost, and discarding that on the way to a "BLOCKED" throws away
  // the most valuable number in the run. The gate decides whether it WOULD
  // trade; it should not decide what gets measured.
  // ── UNITS. outAmount IS RAW, tokenDelta IS UI ─────────────────────────────
  // Jupiter returns base units (10^decimals); parseWalletSwap reads
  // uiTokenAmount, which is already decimal-adjusted. Dividing one by the other
  // is wrong by a factor of 10^decimals and produced a "quote gap" of exactly
  // -100% on every sample — a number so uniform it was obviously an artifact
  // rather than a measurement. Decimals are fetched once per mint and cached.
  const decimals = await decimalsPromise;
  const outRaw = Number(quoted.quote.outAmount);
  const outTokens =
    Number.isFinite(outRaw) && Number.isFinite(decimals) ? outRaw / 10 ** decimals : null;
  const ourFillUsd =
    Number.isFinite(outTokens) && outTokens > 0 && Number.isFinite(solUsd)
      ? (sized.sizeSol * solUsd) / outTokens
      : null;
  const targetFillUsd = impliedEntryPriceUsd(trade, { solUsd, minSpendSol: paperCfg.impliedMinSpendSol });
  const measured = {
    venue,
    sizeSol: sized.sizeSol,
    cappedBy: sized.cappedBy,
    priceImpactPct: Number(quoted.quote.priceImpactPct ?? 0),
    routeHops: (quoted.quote.routePlan ?? []).length,
    route: (quoted.quote.routePlan ?? []).map((r) => r?.swapInfo?.label).join(' -> '),
    ourFillUsd,
    targetFillUsd,
    // Positive means we would pay MORE than the target did.
    quoteGapPct: ourFillUsd && targetFillUsd ? (ourFillUsd / targetFillUsd - 1) * 100 : null,
    // Tokens the shadow entry would have received. Carried so the matching
    // shadow EXIT can be quoted at our own size rather than the target's —
    // ours is a fraction of theirs, and quoting their size would measure
    // impact at a depth we never trade.
    ourTokens: Number.isFinite(outTokens) && outTokens > 0 ? outTokens : null,
  };

  const gate = evaluateSafetyGate(await securityPromise, { venue, cfg });
  if (!gate.pass) {
    return { ...base, ...measured, decision: 'BLOCKED', reason: gate.reasons.join('; ') };
  }

  const built = await buildFn({ quote: quoted.quote, userPublicKey, cfg });

  return {
    ...base,
    ...measured,
    decision: built.ok ? 'WOULD_BUY' : 'BUILD_FAILED',
    reason: built.ok ? null : built.error,
    slippageBps: cfg.slippageBps,
    waived: gate.waived ?? [],
    transactionBytes: built.bytes ?? null,
    lastValidBlockHeight: built.lastValidBlockHeight ?? null,
    computeUnitLimit: built.computeUnitLimit ?? null,
    prioritizationFeeLamports: built.prioritizationFeeLamports ?? null,
    // Live mode signs this. Stripped by forLog() before the intent is written —
    // it is large, single-use, and there is no reason for a serialised swap to
    // sit in a file on disk.
    transactionBase64: built.transactionBase64 ?? null,
    transactionPreview: built.transactionBase64 ? `${built.transactionBase64.slice(0, 44)}…` : null,
  };
}

/** The persistable form of an intent. PURE. */
export function forLog(intent) {
  const { transactionBase64, ...rest } = intent ?? {};
  return rest;
}

/**
 * Build a real sell of a position we actually hold.
 *
 * Separate from planIntent because a sell is priced from a TOKEN BALANCE READ
 * FROM CHAIN, not from the target's size. Mirroring the target's sell amount
 * would be wrong in both directions: our position is a fraction of theirs, and
 * after a partial fill it is not even a predictable fraction.
 */
export async function planLiveSell(
  trade,
  { cfg, book, holdings, decimalsFor, quoteFn = fetchJupiterQuote, buildFn = buildSwapTransaction, userPublicKey, slippageBps, now = Date.now() } = {}
) {
  const base = { id: intentId(trade.signature, 'SELL'), at: now, side: 'SELL', mint: trade.mint, targetSignature: trade.signature ?? null };
  const heldTokens = holdings?.get?.(trade.mint) ?? book?.positions?.[trade.mint]?.tokens ?? 0;
  if (!(heldTokens > 0)) return { ...base, decision: 'SKIP', reason: 'no position held on chain' };

  const fraction = Math.min(1, Math.max(0, trade.sellFraction ?? 1));
  const sellTokens = heldTokens * fraction;
  const decimals = await decimalsFor(trade.mint);
  if (!Number.isFinite(decimals)) return { ...base, decision: 'SKIP', reason: 'decimals unknown' };

  const quoted = await quoteFn({
    inputMint: trade.mint,
    outputMint: WSOL_MINT,
    amountLamports: Math.floor(sellTokens * 10 ** decimals),
    slippageBps: slippageBps ?? cfg.slippageBps,
    base: cfg.jupiterBase,
  });
  if (!quoted.ok) {
    return { ...base, decision: quoted.noRoute ? 'NO_ROUTE' : quoted.throttled ? 'THROTTLED' : 'QUOTE_FAILED', reason: quoted.error, sellTokens };
  }

  const built = await buildFn({ quote: quoted.quote, userPublicKey, cfg });
  return {
    ...base,
    decision: built.ok ? 'WOULD_SELL' : 'BUILD_FAILED',
    reason: built.ok ? null : built.error,
    sellFraction: fraction,
    sellTokens,
    expectedSol: Number(quoted.quote.outAmount) / LAMPORTS,
    slippageBps: slippageBps ?? cfg.slippageBps,
    transactionBase64: built.transactionBase64 ?? null,
    transactionBytes: built.bytes ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * ITEM 4 — idempotency
 * ------------------------------------------------------------------ */

/** Rewrite one intent in place by id. Last write wins; the log is append-only otherwise. */
export async function updateIntent(id, patch, path = INTENT_LOG_PATH) {
  const all = await loadIntents(path);
  let found = null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]?.id === id) {
      all[i] = { ...all[i], ...patch };
      found = all[i];
      break;
    }
  }
  if (!found) return null;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(all, null, 2), 'utf8');
  return found;
}

/**
 * Has this trade already been acted on? PURE.
 *
 * The intent id is derived from the target's own signature, so the same
 * observed trade always maps to the same id however many times the socket and
 * the poller both deliver it. Anything with a recorded outcome is done.
 *
 * `null` outcome is NOT treated as done — that is a crash mid-send, and it goes
 * to resolveDanglingIntents rather than being silently re-executed.
 */
export function alreadyExecuted(intents, id) {
  for (let i = intents.length - 1; i >= 0; i--) {
    if (intents[i]?.id === id && intents[i]?.outcome) return intents[i];
  }
  return null;
}

/**
 * Settle every intent that was sent but never recorded, before trading resumes.
 *
 * ── WHY THIS RUNS FIRST, ALWAYS ─────────────────────────────────────────────
 * An intent with a signature and no outcome means the process died between
 * broadcast and record. The transaction may well have landed. Starting up and
 * treating it as un-executed would re-buy a position already held, with nothing
 * in the log to show it happened — the exact failure that turns a 0.01 SOL test
 * into an unbounded one after a few crashes.
 *
 * Anything the chain cannot resolve stays unresolved and is REPORTED, not
 * guessed. An unresolved intent is a reason to stop and look, not to proceed.
 */
export async function resolveDanglingIntents({ rpcUrl, rpcImpl, path = INTENT_LOG_PATH } = {}) {
  const all = await loadIntents(path);
  const dangling = unresolvedIntents(all);
  const resolved = [];
  for (const intent of dangling) {
    const settled = await resolveIntentOutcome({ intent, rpcUrl, rpcImpl });
    if (settled.outcome) {
      await updateIntent(intent.id, { outcome: settled.outcome, landedSlot: settled.landedSlot ?? null, resolvedOnStartup: true }, path);
    }
    resolved.push(settled);
  }
  return {
    checked: dangling.length,
    landed: resolved.filter((r) => r.outcome === 'LANDED').length,
    failed: resolved.filter((r) => r.outcome === 'FAILED').length,
    stillUnknown: resolved.filter((r) => !r.outcome).length,
    resolved,
  };
}

/* ------------------------------------------------------------------ *
 * ITEM 5 — reconciliation
 * ------------------------------------------------------------------ */

/**
 * Correct the book against what the wallet actually holds.
 *
 * The chain is truth. Untracked holdings are the dangerous half — a token the
 * book does not know about is a token nothing will ever try to sell — so they
 * are adopted into the book at unknown cost basis rather than left orphaned.
 * Cost basis is marked null instead of invented; a fabricated entry price would
 * corrupt P&L in a way that is very hard to notice later.
 */
export async function reconcile({ owner, rpcUrl, rpcImpl, book, adopt = true } = {}) {
  const holdings = await fetchHoldings({ owner, rpcUrl, rpcImpl });
  if (!holdings.ok) return { ok: false, error: holdings.error };
  const diff = diffHoldings({ book, holdings: holdings.holdings });

  if (adopt) {
    for (const { mint } of diff.missing) delete book.positions[mint];
    for (const { mint, actual } of diff.untracked) {
      book.positions[mint] = {
        mint,
        tokens: actual,
        entryPriceUsd: null,
        costSol: null,
        adoptedByReconcile: true,
        openedAt: Date.now(),
      };
    }
    for (const { mint, actual } of diff.held) {
      if (book.positions[mint]) book.positions[mint].tokens = actual;
    }
  }
  return { ok: true, ...diff, applied: adopt };
}

/* ------------------------------------------------------------------ *
 * ITEM 3 + 6 — execution policy
 * ------------------------------------------------------------------ */

/**
 * Read back what a landed transaction ACTUALLY did, from the chain.
 *
 * ── WHY THE QUOTE IS NOT AN ANSWER ──────────────────────────────────────────
 * The quote says what Jupiter expected; slippage, a different route, or a
 * partial fill mean the transaction may have done something else. Every number
 * that matters downstream — realised P&L, the daily loss limit, and the Phase 3
 * comparison against the target's own fill — has to come from the transaction
 * itself, not from what was requested.
 *
 * Retries because a just-confirmed signature is frequently not yet readable:
 * measured earlier on this target, every sample needed 2-3 attempts.
 */
export async function settleFill({ signature, wallet, rpcUrl, rpcImpl, attempts = 4, delayMs = 400, parseImpl } = {}) {
  const { parseWalletSwap } = parseImpl ? { parseWalletSwap: parseImpl } : await import('./paper_copytrade.mjs');
  for (let i = 0; i < attempts; i++) {
    const res = await rpcImpl(rpcUrl, 'getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
    if (res.ok && res.result) {
      const swap = parseWalletSwap(res.result, { wallet });
      if (swap) return { ok: true, ...swap };
      return { ok: false, error: 'transaction did not parse as a swap for this wallet' };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false, error: `could not read ${String(signature).slice(0, 12)}… after ${attempts} attempts` };
}

/**
 * Apply a settled fill to the live book, and return the realised P&L. PURE.
 *
 * ── WHAT COUNTS AS A LOSS ───────────────────────────────────────────────────
 * A BUY realises nothing — it converts SOL into a position. Recording the spend
 * as a loss would trip the daily limit after five ordinary buys no matter how
 * well they performed, which is a halt on activity rather than on losing money.
 *
 * A SELL realises proceeds minus the cost basis of the tokens actually sold. A
 * position adopted by reconcile has no known basis, so its P&L is recorded as
 * null rather than as a fictitious profit equal to the whole proceeds — which
 * is what treating a null basis as zero would do, and it would mask real losses
 * from the limit that is supposed to catch them.
 */
export function applyFill(book, { side, mint, solSpent, solReceived, tokenDelta }) {
  if (!book.positions) book.positions = {};
  const pos = book.positions[mint];

  if (side === 'BUY') {
    const tokens = Math.abs(tokenDelta ?? 0);
    if (pos) {
      pos.tokens = (pos.tokens ?? 0) + tokens;
      pos.costSol = (pos.costSol ?? 0) + (solSpent ?? 0);
    } else {
      book.positions[mint] = { mint, tokens, costSol: solSpent ?? 0, openedAt: Date.now() };
    }
    return { realisedSol: 0, opened: true };
  }

  const sold = Math.abs(tokenDelta ?? 0);
  const heldBefore = pos?.tokens ?? 0;
  const basis = pos?.costSol;
  const fraction = heldBefore > 0 ? Math.min(1, sold / heldBefore) : 1;
  const costOfSold = Number.isFinite(basis) ? basis * fraction : null;

  if (pos) {
    pos.tokens = Math.max(0, heldBefore - sold);
    if (Number.isFinite(basis)) pos.costSol = basis - (costOfSold ?? 0);
    if (pos.tokens <= 1e-9) delete book.positions[mint];
  }

  const realisedSol = costOfSold === null ? null : (solReceived ?? 0) - costOfSold;
  if (realisedSol !== null) {
    if (!book.closed) book.closed = [];
    book.closed.push({ mint, solReceived, costSol: costOfSold, realisedSol, at: Date.now() });
  }
  return { realisedSol, closed: true, basisUnknown: costOfSold === null };
}

/**
 * Realised loss since midnight UTC, against the daily limit. PURE.
 *
 * The limit exists because every other guard here is per-trade, and per-trade
 * caps do not bound a bad day: forty losing 0.01 SOL trades is a 0.4 SOL loss
 * with every individual cap respected.
 */
export function dailyLossState(intents = [], cfg = {}, now = Date.now()) {
  const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
  let realisedSol = 0;
  for (const i of intents) {
    if (!(i?.at >= dayStart) || i.outcome !== 'LANDED') continue;
    if (Number.isFinite(i.realisedSol)) realisedSol += i.realisedSol;
  }
  const limit = cfg.dailyLossLimitSol ?? 0.05;
  return { realisedSol, limit, tripped: realisedSol <= -Math.abs(limit) };
}

/**
 * ITEM 3 — a buy: one attempt, and only one.
 *
 * ── THERE IS NO RETRY HERE, AND THAT IS THE FEATURE ─────────────────────────
 * Every other failure in this codebase is worth retrying. A buy is not. By the
 * time an attempt has failed, the target's trade is seconds old, the price has
 * moved, and the entry that made copying worthwhile has passed — the measured
 * ~0% copy impact holds at roughly one second of lag and decays fast after it.
 * A retry converts a missed trade into a bad one, which is strictly worse.
 *
 * ABANDONED is not the same as failed: the transaction may still land. It is
 * recorded as its own outcome so reconcile can find the position rather than
 * the engine assuming there is none.
 */
export async function executeBuy({ intent, signer, rpcUrl, rpcImpl, cfg, onSent = null } = {}) {
  const result = await submitIntent({ intent, signer, rpcUrl, rpcImpl, cfg, onSent });
  return {
    ...result,
    retried: false,
    note:
      result.status === 'ABANDONED'
        ? 'abandoned after the slot budget — NOT retried, and it may still land; reconcile will find it'
        : null,
  };
}

/**
 * ITEM 6 — a sell: escalate until it goes through or it is genuinely stuck.
 *
 * Re-quotes on every attempt rather than resending the same transaction. A sell
 * usually fails because slippage was too tight for a price that has since moved
 * further, and resending a stale quote fails for the same reason it failed the
 * first time. Widening the tolerance without refreshing the route just fails
 * more expensively.
 *
 * `requote` is injected so the escalation is testable without a network.
 */
export async function executeSellWithPanic(
  { intent, signer, rpcUrl, rpcImpl, cfg, requote, onSent = null, onAttempt = null } = {}
) {
  const attempts = [];
  for (let attempt = 0; ; attempt++) {
    const step = panicEscalation(attempt, cfg);
    if (step.giveUp) {
      return { status: 'STUCK', attempts, error: step.reason, needsHuman: true };
    }

    const fresh = await requote({
      slippageBps: step.slippageBps,
      priorityFeeMaxLamports: step.priorityFeeMaxLamports,
      panic: step.panic,
      attempt,
    });
    if (!fresh?.ok) {
      attempts.push({ attempt, status: 'REQUOTE_FAILED', error: fresh?.error ?? 'no quote', panic: step.panic });
      continue;
    }

    const result = await executeTransaction({
      transactionBase64: fresh.transactionBase64,
      signer,
      rpcUrl,
      rpcImpl,
      cfg,
      onSent,
    });
    attempts.push({ attempt, status: result.status, signature: result.signature ?? null, panic: step.panic, slippageBps: step.slippageBps });
    await onAttempt?.({ attempt, step, result });

    if (result.status === 'LANDED') {
      return { status: 'LANDED', signature: result.signature, slot: result.slot, attempts, panicked: step.panic };
    }
    // Anything else is worth another, wider attempt — including ABANDONED.
    // Unlike a buy, a sell that may or may not have landed still has to be
    // chased: the downside of a duplicate sell attempt on an already-empty
    // position is a failed transaction, while the downside of giving up on a
    // position that is still open is the whole position.
  }
}

/* ------------------------------------------------------------------ *
 * PHASE 3 — burst queuing
 * ------------------------------------------------------------------ */

/**
 * Run work concurrently, but never more than `limit` at once. PURE-ish.
 *
 * ── WHY BOUNDED AND NOT Promise.all ─────────────────────────────────────────
 * MEASURED on this target: half of its trades arrive less than three seconds
 * apart, and the tenth percentile is 184ms. A serial loop makes every trade in
 * a burst wait for the previous one to confirm and settle, so lateness
 * compounds across the burst — the fourth trade of a flurry can be seconds
 * behind on a signal whose edge decays in about one.
 *
 * Unbounded is the opposite mistake and a worse one. Jupiter's free tier
 * throttles under burst, and that was already misdiagnosed once as a 50%
 * no-route rate: an 8-request burst returned 8x HTTP 400 from lite-api and
 * 5x400 + 3x429 from api.jup.ag. Firing an entire flurry at once would recreate
 * exactly that, and the failures would look like unroutable tokens rather than
 * like the rate limit they are.
 *
 * Results keep INPUT order regardless of completion order, so the caller's
 * bookkeeping does not depend on scheduling.
 */
export async function runBounded(items, { limit = 4, worker } = {}) {
  const list = [...items];
  const results = new Array(list.length);
  let next = 0;
  const runner = async () => {
    for (;;) {
      // `next++` is a single synchronous step, so two runners can never take
      // the same index. That is the whole locking story on one thread.
      const i = next++;
      if (i >= list.length) return;
      try {
        results[i] = await worker(list[i], i);
      } catch (err) {
        results[i] = { error: err?.message ?? String(err) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, runner));
  return results;
}

/**
 * Exposure accounting that survives concurrency.
 *
 * ── THE RACE THIS EXISTS TO CLOSE ───────────────────────────────────────────
 * Serially, `exposureSol += size` after a fill is fine. Concurrently it is not:
 * two buys that plan at the same time both read the OLD exposure, both decide
 * they fit under the cap, and both proceed — and the cap is breached by exactly
 * the amount that made it a cap. With five in flight the breach is fivefold.
 *
 * So room is RESERVED before the first await and released or committed after.
 * `reserve` performs its check and its increment with no await between them,
 * which on one thread is atomic. In-flight size counts against the cap, so the
 * cap bounds what CAN be spent rather than what has already been.
 */
export function createExposureLedger({ maxExposureSol = 0.1 } = {}) {
  let committed = 0;
  let reserved = 0;

  return {
    get committed() { return committed; },
    get reserved() { return reserved; },
    get inFlight() { return committed + reserved; },
    get available() { return maxExposureSol - committed - reserved; },

    reserve(sizeSol) {
      if (!(sizeSol > 0)) return { ok: false, reason: 'non-positive size' };
      // Float tolerance: 0.01 * 10 is 0.09999999999999999, and a cap that
      // rejects its own tenth trade for being 1e-17 over is just a bug.
      if (committed + reserved + sizeSol > maxExposureSol + 1e-9) {
        return {
          ok: false,
          reason: `exposure cap ${maxExposureSol} SOL (${(committed + reserved).toFixed(4)} in flight, wanted ${sizeSol.toFixed(4)})`,
        };
      }
      reserved += sizeSol;
      let settled = false;
      return {
        ok: true,
        sizeSol,
        /**
         * The trade landed. Commit the ACTUAL spend, which slippage makes differ.
         *
         * The actual can EXCEED the reservation and is recorded anyway, not
         * clamped: solSpent comes from the wallet's balance delta and so
         * includes the transaction fee, and that SOL really did leave. Clamping
         * to make a number fit under a cap would be lying about exposure to the
         * one component whose job is knowing it. The cap is enforced where it
         * can be — at reservation time — and an overspend correctly tightens
         * what the next trade may reserve. STRESS-TESTED: 200 trials x 40
         * concurrent grants zero reservations past the cap.
         */
        commit(actualSol) {
          if (settled) return;
          settled = true;
          reserved -= sizeSol;
          committed += Number.isFinite(actualSol) ? actualSol : sizeSol;
        },
        /** It did not land. Give the room back, or the cap ratchets shut on nothing. */
        release() {
          if (settled) return;
          settled = true;
          reserved -= sizeSol;
        },
      };
    },

    /** A position closed; its capital is free again. */
    releaseCommitted(sol) {
      committed = Math.max(0, committed - (Number.isFinite(sol) ? sol : 0));
    },
  };
}

/* ------------------------------------------------------------------ *
 * PHASE 3 — shadow calibration
 * ------------------------------------------------------------------ */

/**
 * Pairs shadow entries with shadow exits to measure ROUND-TRIP drag.
 *
 * ── THE NUMBER THIS EXISTS TO PRODUCE ───────────────────────────────────────
 * Entry impact is measured at n=18 (median +0.3%). The exit side is measured at
 * n=4, spanning -26.6% to +60.3% — a range so wide it is barely a measurement,
 * and the paper book's +31% rests entirely on it. That asymmetry is the single
 * biggest hole in the whole thesis.
 *
 * It exists because shadow mode quoted entries and merely NOTED exits. Quoting
 * the exit too closes it, and costs nothing but a Jupiter call. What comes out
 * is DRAG: our round trip minus the target's own round trip on the same token
 * over the same window. Drag is the honest figure, because it cancels the
 * token's move — if it doubled, both of us caught the double, and what remains
 * is purely what copying cost.
 */
export function createCalibrationLedger() {
  return { open: new Map(), pairs: [], entryGaps: [], exitGaps: [] };
}

/**
 * Calibration PERSISTS, because the thing it measures takes days to gather.
 *
 * Held only in memory, every restart would reset the sample to zero — and the
 * gate that matters (20+ live round trips before capital scales) would then be
 * unreachable by construction, since no single session lasts that long. A
 * measurement that cannot accumulate is not a measurement.
 */
export const CALIBRATION_PATH = join(HERE, '.state', 'calibration.json');

export async function loadCalibration(path = CALIBRATION_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return {
      // `open` is a Map at runtime and an object on disk.
      open: new Map(Object.entries(raw.open ?? {})),
      pairs: Array.isArray(raw.pairs) ? raw.pairs : [],
      entryGaps: Array.isArray(raw.entryGaps) ? raw.entryGaps : [],
      exitGaps: Array.isArray(raw.exitGaps) ? raw.exitGaps : [],
    };
  } catch {
    return createCalibrationLedger();
  }
}

export async function saveCalibration(ledger, path = CALIBRATION_PATH, limit = 5000) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(
      {
        open: Object.fromEntries(ledger.open),
        pairs: ledger.pairs.slice(-limit),
        entryGaps: ledger.entryGaps.slice(-limit),
        exitGaps: ledger.exitGaps.slice(-limit),
      },
      null,
      2
    ),
    'utf8'
  );
  return ledger;
}

/**
 * Drop entries that were never sold. PURE.
 *
 * The target does not exit everything, and an entry left open forever both
 * grows the file without bound and makes `openPositions` meaningless. Age is
 * measured from the entry, and the default is generous: a position genuinely
 * held for two days is real, one open for a week is abandoned.
 */
export function pruneCalibration(ledger, { maxAgeMs = 7 * 24 * 3600e3, now = Date.now() } = {}) {
  let dropped = 0;
  for (const [mint, open] of ledger.open) {
    if (now - (open.at ?? now) > maxAgeMs) {
      ledger.open.delete(mint);
      dropped++;
    }
  }
  return { dropped, remaining: ledger.open.size };
}

/** Remember a shadow entry so the matching exit can be paired to it. PURE. */
export function recordShadowEntry(ledger, intent) {
  const { mint, ourFillUsd, targetFillUsd, ourTokens, sizeSol } = intent ?? {};
  if (!mint || !(ourFillUsd > 0) || !(targetFillUsd > 0)) return null;
  if (Number.isFinite(intent.quoteGapPct) && !intent.seeded) ledger.entryGaps.push(intent.quoteGapPct);
  // Scale-ins overwrite rather than average: the pairing is a round-trip
  // measurement, not a position, and blending two entries with different
  // token counts would make the exit quote size meaningless.
  //
  // `seeded` rides along with the ENTRY and taints the whole round trip. A
  // seeded entry was quoted against a trade minutes old, so its gap is price
  // drift as much as copy cost — the precise error that produced
  // copyImpactPct 9 and cost a book. A drag built on one is not a measurement
  // of copying, whichever side the exit came from.
  ledger.open.set(mint, {
    ourEntryUsd: ourFillUsd, targetEntryUsd: targetFillUsd, ourTokens, sizeSol,
    seeded: intent.seeded === true, at: intent.at ?? Date.now(),
  });
  return ledger.open.get(mint);
}

/**
 * Close a shadow round trip and record the drag. PURE.
 *
 * Returns null for an exit with no matching entry — the target sells tokens it
 * bought before this process started, and inventing an entry for those would
 * fabricate the very number the ledger exists to measure.
 */
export function recordShadowExit(ledger, intent) {
  const { mint, ourFillUsd, targetFillUsd } = intent ?? {};
  const open = mint ? ledger.open.get(mint) : null;
  if (!open || !(ourFillUsd > 0) || !(targetFillUsd > 0)) return null;
  ledger.open.delete(mint);
  const seeded = open.seeded || intent.seeded === true;
  if (Number.isFinite(intent.exitGapPct) && !seeded) ledger.exitGaps.push(intent.exitGapPct);

  const ourReturnPct = (ourFillUsd / open.ourEntryUsd - 1) * 100;
  const targetReturnPct = (targetFillUsd / open.targetEntryUsd - 1) * 100;
  const pair = {
    mint,
    seeded,
    ourReturnPct,
    targetReturnPct,
    // Negative means copying cost us relative to the target on this token.
    dragPct: ourReturnPct - targetReturnPct,
    heldMs: (intent.at ?? Date.now()) - open.at,
    sizeSol: open.sizeSol ?? null,
  };
  ledger.pairs.push(pair);
  return pair;
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

/**
 * Round-trip calibration, as measured. PURE.
 *
 * SEEDED pairs are excluded from every headline figure and reported separately.
 * They are quoted against trades minutes old, so their gap is price drift as
 * much as copy cost — mixing them in is how copyImpactPct came to be 9 when the
 * true figure at ~500ms was -8.9%, the opposite sign.
 */
export function calibrationSummary(ledger) {
  const live = ledger.pairs.filter((p) => !p.seeded);
  const drags = live.map((p) => p.dragPct);
  const sorted = [...drags].sort((a, b) => a - b);
  const seededDrags = ledger.pairs.filter((p) => p.seeded).map((p) => p.dragPct);
  return {
    roundTrips: live.length,
    seededRoundTrips: seededDrags.length,
    seededMedianDragPct: median(seededDrags),
    entrySamples: ledger.entryGaps.length,
    exitSamples: ledger.exitGaps.length,
    medianEntryGapPct: median(ledger.entryGaps),
    medianExitGapPct: median(ledger.exitGaps),
    medianDragPct: median(drags),
    meanDragPct: drags.length ? drags.reduce((a, b) => a + b, 0) / drags.length : null,
    worstDragPct: sorted.length ? sorted[0] : null,
    bestDragPct: sorted.length ? sorted[sorted.length - 1] : null,
    // A round trip we beat the target on. Expected to be a minority; if it is
    // most of them, the measurement is wrong rather than the edge being real.
    aheadCount: drags.filter((d) => d > 0).length,
    openPositions: ledger.open.size,
  };
}

/** Would this calibration support scaling capital? PURE. */
export function calibrationVerdict(summary, { minRoundTrips = 20 } = {}) {
  if (!summary.roundTrips) {
    return { ok: false, reason: 'no LIVE round trips yet — seeded pairs do not count' };
  }
  if (summary.roundTrips < minRoundTrips) {
    return { ok: false, reason: `${summary.roundTrips} live round trips, want ${minRoundTrips}` };
  }
  // A drag worse than this compounds across every trade at the new size, which
  // is exactly how a book that looks profitable on paper loses money live.
  if (summary.medianDragPct !== null && summary.medianDragPct < -5) {
    return { ok: false, reason: `median drag ${summary.medianDragPct.toFixed(1)}% — copying costs more than the edge` };
  }
  return { ok: true, reason: `${summary.roundTrips} live round trips, median drag ${summary.medianDragPct?.toFixed(1)}%` };
}

/**
 * Quote the EXIT in shadow mode, so exits are measured rather than assumed.
 *
 * Sizes the sale from the tokens the shadow ENTRY would have received, not from
 * the target's own token count — ours is a fraction of theirs, and quoting
 * their size would measure price impact at a depth we would never trade.
 */
export async function shadowSellQuote(
  trade, { ledger, cfg, solUsd, decimalsFor, quoteFn = fetchJupiterQuote, paperCfg = {} } = {}
) {
  const open = ledger?.open?.get(trade.mint);
  const targetFillUsd = impliedExitPriceUsd(trade, { solUsd, minReceiveSol: paperCfg.impliedMinSpendSol });
  if (!open || !(open.ourTokens > 0)) return { ourFillUsd: null, targetFillUsd, exitGapPct: null, reason: 'no shadow entry to sell' };

  const fraction = Math.min(1, Math.max(0, trade.sellFraction ?? 1));
  const tokens = open.ourTokens * fraction;
  const decimals = await decimalsFor(trade.mint);
  if (!Number.isFinite(decimals)) return { ourFillUsd: null, targetFillUsd, exitGapPct: null, reason: 'decimals unknown' };

  const quoted = await quoteFn({
    inputMint: trade.mint,
    outputMint: WSOL_MINT,
    amountLamports: Math.floor(tokens * 10 ** decimals),
    slippageBps: cfg.slippageBps,
    base: cfg.jupiterBase,
  });
  if (!quoted.ok) return { ourFillUsd: null, targetFillUsd, exitGapPct: null, reason: quoted.error };

  const solOut = Number(quoted.quote.outAmount) / LAMPORTS;
  const ourFillUsd = tokens > 0 && Number.isFinite(solUsd) ? (solOut * solUsd) / tokens : null;
  return {
    ourFillUsd,
    targetFillUsd,
    // NEGATIVE means we would receive LESS per token than the target did —
    // the opposite sign convention to the entry gap, where positive means we
    // pay more. Both directions are a cost; keeping the raw signs avoids
    // silently flipping one and reporting a drag that is not there.
    exitGapPct: ourFillUsd && targetFillUsd ? (ourFillUsd / targetFillUsd - 1) * 100 : null,
    solOut,
    tokens,
  };
}

/* ------------------------------------------------------------------ *
 * PHASE 4 — capital tiers
 * ------------------------------------------------------------------ */

/**
 * Capital scales on EVIDENCE, not on elapsed time or on feeling ready.
 *
 * ── WHY minExitSamples IS A GATE AND NOT A NOTE ─────────────────────────────
 * The paper book showed +31% over 1702 trades, and the exits that produced it
 * were priced at the target's own sell price — an assumption measured on FOUR
 * samples ranging -26.6% to +60.3%. Scaling on that number would be scaling on
 * an assumption, and a wrong exit assumption does not fail gently: it is a
 * per-trade drag applied to every trade at the new size.
 *
 * So each tier demands round trips AND non-negative net AND a large enough
 * exit-side sample. All three, because volume without profit is just an
 * expensive habit, profit without samples is luck, and samples without either
 * is measurement rather than a track record.
 *
 * Tiers are recomputed from current stats every time, so this DEMOTES as
 * readily as it promotes: a drawdown that drops net below a floor drops the
 * caps with it, at the moment they matter most. Nothing latches.
 */
export const CAPITAL_TIERS = [
  {
    name: 'probe',
    minRoundTrips: 0, minNetSol: -Infinity, minExitSamples: 0,
    maxTradeSol: 0.01, maxExposureSol: 0.1, dailyLossLimitSol: 0.05,
    _note: 'Phase 2. ~$0.75 a trade. The goal is landed transactions to measure, not profit.',
  },
  {
    name: 'micro',
    minRoundTrips: 30, minNetSol: 0, minExitSamples: 20,
    maxTradeSol: 0.05, maxExposureSol: 0.5, dailyLossLimitSol: 0.15,
    _note: 'Exit drag now has a real sample. 5x the trade size, 5x the exposure.',
  },
  {
    name: 'small',
    minRoundTrips: 100, minNetSol: 0.25, minExitSamples: 60,
    maxTradeSol: 0.25, maxExposureSol: 2.5, dailyLossLimitSol: 0.5,
    _note: 'Net positive across 100 round trips, not merely across a good week.',
  },
  {
    name: 'scaled',
    minRoundTrips: 300, minNetSol: 2.0, minExitSamples: 150,
    maxTradeSol: 1.0, maxExposureSol: 10.0, dailyLossLimitSol: 2.0,
    _note: 'Phase 4 proper. Only from here does price impact at our own size start to matter.',
  },
];

/**
 * The highest tier whose every gate is met. PURE.
 *
 * Scans downward and takes the first that qualifies, so a stat that fails a
 * high gate cannot skip past a lower one it also fails.
 */
export function resolveTier(stats = {}, tiers = CAPITAL_TIERS) {
  const roundTrips = stats.roundTrips ?? 0;
  const netSol = stats.netSol ?? 0;
  const exitSamples = stats.exitSamples ?? 0;

  for (let i = tiers.length - 1; i >= 0; i--) {
    const t = tiers[i];
    if (roundTrips >= t.minRoundTrips && netSol >= t.minNetSol && exitSamples >= t.minExitSamples) {
      const next = tiers[i + 1] ?? null;
      return {
        tier: t.name,
        index: i,
        maxTradeSol: t.maxTradeSol,
        maxExposureSol: t.maxExposureSol,
        dailyLossLimitSol: t.dailyLossLimitSol,
        next: next
          ? {
              name: next.name,
              needs: [
                roundTrips < next.minRoundTrips ? `${next.minRoundTrips - roundTrips} more round trips` : null,
                netSol < next.minNetSol ? `net ${next.minNetSol} SOL (now ${netSol.toFixed(3)})` : null,
                exitSamples < next.minExitSamples ? `${next.minExitSamples - exitSamples} more exit samples` : null,
              ].filter(Boolean),
            }
          : null,
      };
    }
  }
  // Unreachable with the shipped table (probe has no floors), but a tier table
  // edited to have one must fail CLOSED rather than fall through to no caps.
  return { tier: 'blocked', index: -1, maxTradeSol: 0, maxExposureSol: 0, dailyLossLimitSol: 0, next: null };
}

/** Fold a tier's caps into a live config. PURE. */
export function applyTier(cfg, tier) {
  return { ...cfg, maxTradeSol: tier.maxTradeSol, maxExposureSol: tier.maxExposureSol, dailyLossLimitSol: tier.dailyLossLimitSol, tier: tier.tier };
}

/** Track-record stats drawn from the intent log and calibration. PURE. */
export function trackRecord(intents = [], calibration = null) {
  const landed = intents.filter((i) => i.outcome === 'LANDED');
  const netSol = landed.reduce((a, i) => a + (Number.isFinite(i.realisedSol) ? i.realisedSol : 0), 0);
  const closed = landed.filter((i) => i.side === 'SELL' && Number.isFinite(i.realisedSol));
  return {
    // A round trip is a CLOSED position, not a transaction. Fifty buys and no
    // sells is no evidence at all about exiting, which is the risky half.
    roundTrips: closed.length,
    netSol,
    exitSamples: calibration ? calibration.exitSamples : closed.length,
    landedCount: landed.length,
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function renderIntent(i) {
  const tag = {
    WOULD_BUY: '✓ WOULD BUY ',
    WOULD_SELL: '✓ WOULD SELL',
    SKIP: '· skip      ',
    BLOCKED: '⛔ BLOCKED   ',
    NO_ROUTE: '⚠ NO ROUTE  ',
    THROTTLED: '⏳ throttled  ',
    QUOTE_FAILED: '⚠ quote fail',
    BUILD_FAILED: '⚠ build fail',
    DUPLICATE: '↺ duplicate ',
  }[i.decision] ?? i.decision;

  const head = `  ${tag} ${formatTicker(null, i.mint).padEnd(12)}`;
  if (i.decision === 'WOULD_SELL' && Number.isFinite(i.expectedSol)) {
    return head + `${((i.sellFraction ?? 1) * 100).toFixed(0)}% → ${i.expectedSol.toFixed(4)} SOL`;
  }
  if (i.decision === 'WOULD_BUY') {
    return (
      head +
      `${i.sizeSol.toFixed(4)} SOL  ${i.venue.padEnd(12)} ` +
      `impact ${i.priceImpactPct.toFixed(2)}%  ` +
      (i.quoteGapPct === null ? 'gap n/a' : `gap ${i.quoteGapPct >= 0 ? '+' : ''}${i.quoteGapPct.toFixed(1)}%`) +
      `  tx ${i.transactionBytes}B` +
      (i.cappedBy ? `  [capped: ${i.cappedBy}]` : '')
    );
  }
  if (i.decision === 'WOULD_SELL') return head + `${((i.sellFraction ?? 1) * 100).toFixed(0)}% of position`;
  return head + (i.reason ?? '');
}

export async function main(argv = []) {
  const dryRun = argv.includes('--dry-run');
  const live = argv.includes('--live');

  // Neither flag is a default. See the header for why.
  if (dryRun === live) {
    console.error(
      dryRun
        ? 'Pass --dry-run OR --live, not both.'
        : 'Pass --dry-run (measures, spends nothing) or --live --keyfile <path> (SPENDS REAL MONEY).'
    );
    process.exitCode = 1;
    return;
  }

  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8')).paperCopytrade ?? {};
  const paperCfg = paperConfig(config);
  const cfg = liveConfig(config.live ?? {});

  const pctIdx = argv.indexOf('--pct-whale');
  if (pctIdx !== -1 && Number(argv[pctIdx + 1]) > 0) paperCfg.pctWhale = Number(argv[pctIdx + 1]);

  const { loadEnv } = await import('./telegram.mjs');
  const dotenv = await loadEnv(join(HERE, '.env')).catch(() => ({}));
  const rpcUrl = resolveChainRpc({
    envUrl: process.env.SOLANA_RPC_URL || dotenv.rpcOverride || null,
    configUrl: config.rpcMirror?.url ?? null,
  });

  const watchlist = JSON.parse(
    await readFile(join(HERE, config.watchlistFile ?? '../aegis/smart_wallets.json'), 'utf8').catch(() => '{"wallets":[]}')
  );
  // Live gets its own book. The paper book is opened READ-ONLY in dry-run only,
  // and is never written by this module in either mode.
  const paperBook = (await loadBook()) ?? createBook({ budgetSol: 0 });
  const book = live ? await loadLiveBook() : paperBook;
  const target = resolveTarget(watchlist, paperBook).target;
  if (!target?.address) {
    console.error('No target wallet in the watchlist.');
    process.exitCode = 1;
    return;
  }

  const solUsd = await fetchSolUsd();
  const { solanaRpc } = await import('./paper_copytrade.mjs');
  const rpcImpl = (url, method, params) => solanaRpc(url, method, params);

  // ── ITEM 1: the key is read HERE, at the edge, and nowhere else ──────────
  // repoRoot is the parent of aegis/, so a keyfile anywhere in the working
  // tree is refused.
  let signer = null;
  if (live) {
    const kfIdx = argv.indexOf('--keyfile');
    const keyfile = kfIdx !== -1 ? argv[kfIdx + 1] : null;
    if (!keyfile) {
      console.error('--live requires --keyfile <path-to-keypair.json>, outside this repository.');
      console.error('Use a DEDICATED hot wallet funded only with what you can afford to lose.');
      process.exitCode = 1;
      return;
    }
    try {
      const bytes = await readKeyfileBytes(keyfile, { repoRoot: resolve(HERE, '..') });
      signer = createSigner({ secretKey: bytes });
    } catch (err) {
      console.error(`\n  ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // In dry-run this is a stand-in: it only shapes the transaction Jupiter
  // builds, and no signer exists to sign it. Jupiter rejects the System Program
  // address with HTTP 422, so the target's own address is used as a
  // guaranteed-valid account to build against.
  const userPublicKey = signer
    ? signer.publicKey
    : argv.includes('--as')
      ? argv[argv.indexOf('--as') + 1]
      : target.address;

  // Live reads the real balance; dry-run takes one on the command line.
  let nativeSolBalance = Number(argv[argv.indexOf('--balance') + 1]) || 0.5;
  if (live) {
    const bal = await rpcImpl(rpcUrl, 'getBalance', [signer.publicKey, { commitment: 'confirmed' }]);
    if (!bal.ok) {
      console.error(`could not read the hot wallet balance: ${bal.error}`);
      process.exitCode = 1;
      return;
    }
    nativeSolBalance = Number(bal.result?.value ?? 0) / LAMPORTS;
  }

  console.log('═'.repeat(64));
  console.log(live ? '  LIVE COPYTRADE — PHASE 2, REAL MONEY' : '  LIVE COPYTRADE — PHASE 1 SHADOW MODE');
  console.log('═'.repeat(64));
  console.log(`  target        ${target.address.slice(0, 16)}…`);
  console.log(`  node          ${new URL(rpcUrl).host}`);
  console.log(`  jupiter       ${new URL(cfg.jupiterBase).host}`);
  console.log(`  sizing        ${paperCfg.pctWhale ? paperCfg.pctWhale + '% of target' : paperCfg.perTradeSol + ' SOL flat'}`);
  if (live) {
    console.log(`  hot wallet    ${signer.publicKey}`);
    console.log(`  balance       ${nativeSolBalance.toFixed(4)} SOL (${usd(nativeSolBalance * solUsd)})`);
    console.log(`  caps          max trade ${cfg.maxTradeSol} · max exposure ${cfg.maxExposureSol} · daily loss ${cfg.dailyLossLimitSol}`);
    console.log(`  reserve       ${cfg.gasReserveSol} SOL held back for fees and ATA rent`);
    console.log(`  confirm       ${cfg.maxConfirmSlots} slots, buys are NEVER retried`);
  } else {
    console.log(`  simulated bal ${nativeSolBalance} SOL · reserve ${cfg.gasReserveSol} · max trade ${cfg.maxTradeSol}`);
    console.log(`  NOTHING IS SIGNED OR SENT — no signer exists in this process.`);
  }
  console.log('═'.repeat(64));

  // ── ITEM 4: settle anything left dangling by a previous crash ───────────
  // Before a single new trade. A dangling intent may be a position already
  // held, and buying it again is the failure this exists to prevent.
  if (live) {
    const settled = await resolveDanglingIntents({ rpcUrl, rpcImpl });
    if (settled.checked) {
      console.log(`\n  resumed ${settled.checked} unrecorded intent(s): ${settled.landed} landed, ${settled.failed} failed, ${settled.stillUnknown} unknown`);
      if (settled.stillUnknown) {
        console.error('  ⛔ some intents could not be resolved against the chain. Stopping.');
        console.error('     Check .state/live_intents.json — trading on an unknown position is how a');
        console.error('     small test becomes a large one.');
        process.exitCode = 1;
        return;
      }
    }

    // ── ITEM 5: the chain is truth ────────────────────────────────────────
    if (!book.positions) book.positions = {};
    const rec = await reconcile({ owner: signer.publicKey, rpcUrl, rpcImpl, book });
    if (rec.ok && !rec.inSync) {
      console.log(`  reconciled: ${rec.missing.length} stale position(s) dropped, ${rec.untracked.length} untracked holding(s) adopted`);
      for (const u of rec.untracked) console.log(`    adopted ${formatTicker(null, u.mint)} ${u.actual} tokens — cost basis unknown`);
    } else if (rec.ok) {
      console.log('  reconciled: book matches chain');
    }
    await saveLiveBook(book);

    // ── The daily loss limit ──────────────────────────────────────────────
    const loss = dailyLossState(await loadIntents(), cfg);
    if (loss.tripped) {
      console.error(`\n  ⛔ daily loss limit hit (${loss.realisedSol.toFixed(4)} SOL vs ${loss.limit}). Not trading today.`);
      process.exitCode = 1;
      return;
    }

    console.log(`\n  ⚠  REAL MONEY. Ctrl+C now if that is not what you meant. Starting in 5s…`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  const lock = createMintLock();
  const stats = { WOULD_BUY: 0, WOULD_SELL: 0, SKIP: 0, BLOCKED: 0, NO_ROUTE: 0, THROTTLED: 0, QUOTE_FAILED: 0, BUILD_FAILED: 0 };
  const gaps = [];
  const seededGaps = [];

  // ── PHASE 4: caps come from the track record, not from the config ───────
  // Recomputed from the intent log, so a drawdown demotes as readily as a good
  // run promotes.
  // Loaded from disk so samples accumulate across sessions — the 20-round-trip
  // gate is unreachable otherwise, since no single run lasts that long.
  const calibration = await loadCalibration();
  const pruned = pruneCalibration(calibration);
  const record = trackRecord(await loadIntents(), calibrationSummary(calibration));
  const tier = resolveTier(record);
  Object.assign(cfg, applyTier(cfg, tier));

  // ── PHASE 3: exposure that survives concurrency ─────────────────────────
  const exposure = createExposureLedger({ maxExposureSol: cfg.maxExposureSol });

  // How many trades may be in flight at once. Bounded because Jupiter's free
  // tier throttles under burst — and that throttle was already misread once as
  // a 50% no-route rate.
  const burstIdx = argv.indexOf('--burst');
  const burstLimit = burstIdx !== -1 ? Math.max(1, Number(argv[burstIdx + 1]) || 4) : 4;

  // The real audit, cached per mint: the same token recurs constantly in a
  // seed pass and each audit costs several RPC calls.
  const { fetchSolanaSecurity } = await import('./sources.mjs');
  const securityCache = new Map();
  const securityFor = async (mint) => {
    if (securityCache.has(mint)) return securityCache.get(mint);
    const rec = await fetchSolanaSecurity(mint, { rpcUrl }).catch(() => null);
    securityCache.set(mint, rec?.ok === false ? null : rec);
    return securityCache.get(mint);
  };

  // Decimals, cached — needed to put Jupiter's raw outAmount into the same
  // units as the target's UI-denominated fill. Immutable per mint, so one
  // lookup each is enough.
  const decimalsCache = new Map();
  const decimalsFor = async (mint) => {
    if (decimalsCache.has(mint)) return decimalsCache.get(mint);
    const r = await rpcImpl(rpcUrl, 'getTokenSupply', [mint]).catch(() => ({ ok: false }));
    const d = r.ok ? Number(r.result?.value?.decimals) : null;
    decimalsCache.set(mint, Number.isFinite(d) ? d : null);
    return decimalsCache.get(mint);
  };

  const handleOne = async (t, { seeded = false } = {}) => {
    {
      // Serialised per mint: a BUY and an ADD arriving together must not both
      // build a transaction for the same token.
      const intent = await lock.run(t.mint, async () => {
        // ITEM 4: an id already carrying an outcome is a trade already acted
        // on. The socket and the poller both deliver the same signature, so
        // this fires routinely, not only after a crash.
        const done = live ? alreadyExecuted(await loadIntents(), intentId(t.signature, t.kind)) : null;
        if (done) return { id: done.id, at: Date.now(), side: t.kind, mint: t.mint, decision: 'DUPLICATE', reason: `already ${done.outcome}` };

        if (live && t.kind === 'SELL') {
          const holdings = await fetchHoldings({ owner: signer.publicKey, rpcUrl, rpcImpl });
          return planLiveSell(t, { cfg, book, holdings: holdings.holdings, decimalsFor, userPublicKey, now: Date.now() });
        }
        return planIntent(t, {
          cfg, paperCfg, book, solUsd, userPublicKey, nativeSolBalance,
          // In-flight size counts against the cap, so concurrent buys cannot
          // each read the same stale exposure and all decide they fit.
          exposureSol: exposure.inFlight, securityFor, decimalsFor, now: Date.now(),
        });
      });
      intent.seeded = seeded;
      intent.mode = live ? 'live' : 'dry-run';
      intent.tier = cfg.tier ?? null;

      // ── PHASE 3: shadow calibration ───────────────────────────────────────
      // Costs nothing but a Jupiter call and produces the number the whole
      // thesis is thinnest on. Runs in BOTH modes: in live it measures the same
      // thing alongside the real fills, which is what Phase 3 compares.
      if (intent.decision === 'WOULD_BUY' && Number.isFinite(intent.ourFillUsd)) {
        if (recordShadowEntry(calibration, intent)) await saveCalibration(calibration);
      } else if (t.kind === 'SELL' && calibration.open.has(t.mint)) {
        // The exit half, previously NOTED but never priced — which is why the
        // exit sample stood at 4 against 18 for entries.
        const ex = await shadowSellQuote(t, { ledger: calibration, cfg, solUsd, decimalsFor, paperCfg });
        intent.ourFillUsd = ex.ourFillUsd;
        intent.targetFillUsd = ex.targetFillUsd;
        intent.exitGapPct = ex.exitGapPct;
        intent.exitQuoteError = ex.reason ?? null;
        const pair = recordShadowExit(calibration, { ...intent, at: Date.now() });
        if (pair) {
          intent.dragPct = pair.dragPct;
          // Persisted as it closes: a round trip lost to a crash is a sample
          // that took hours of the target's activity to produce.
          await saveCalibration(calibration);
        }
      }

      // ── EXECUTION. Only past this line does anything cost money. ────────
      // Seeded trades are historical replay and are NEVER executed: they are
      // minutes old, and acting on them would buy into moves that have already
      // finished.
      if (live && !seeded && (intent.decision === 'WOULD_BUY' || intent.decision === 'WOULD_SELL')) {
        // Room is claimed BEFORE the first await of the execution path. Under
        // concurrency the alternative is two buys both reading the old
        // exposure, both fitting under the cap, and both going.
        const slot = intent.side === 'BUY' ? exposure.reserve(intent.sizeSol) : { ok: true, commit() {}, release() {} };
        if (!slot.ok) {
          stats.SKIP = (stats.SKIP ?? 0) + 1;
          console.log(`  · skip       ${formatTicker(null, intent.mint).padEnd(12)}${slot.reason}`);
          return;
        }

        await appendIntent(forLog({ ...intent, outcome: null }));

        const result =
          intent.side === 'BUY'
            ? // ITEM 3: one attempt, no retry.
              await executeBuy({
                intent, signer, rpcUrl, rpcImpl, cfg,
                onSent: ({ signature }) => updateIntent(intent.id, { sentSignature: signature }),
              })
            : // ITEM 6: escalate a stubborn exit rather than repeating it.
              await executeSellWithPanic({
                intent, signer, rpcUrl, rpcImpl, cfg,
                onSent: ({ signature }) => updateIntent(intent.id, { sentSignature: signature }),
                requote: async ({ slippageBps }) => {
                  const re = await planLiveSell(t, { cfg, book, holdings: null, decimalsFor, userPublicKey, slippageBps, now: Date.now() });
                  return { ok: Boolean(re.transactionBase64), transactionBase64: re.transactionBase64, error: re.reason };
                },
              });

        intent.outcome = result.status;
        intent.executionSignature = result.signature ?? null;

        // ── Settle from the chain, not from the quote ─────────────────────
        // realisedSol is what the daily loss limit reads. Until this ran, the
        // field was never written and the limit could not trip.
        let fill = null;
        let realisedSol = null;
        if (result.status === 'LANDED' && result.signature) {
          fill = await settleFill({ signature: result.signature, wallet: signer.publicKey, rpcUrl, rpcImpl });
          if (fill.ok) {
            const applied = applyFill(book, {
              side: intent.side, mint: intent.mint,
              solSpent: fill.solSpent, solReceived: fill.solReceived, tokenDelta: fill.tokenDelta,
            });
            realisedSol = applied.realisedSol;
            if (applied.basisUnknown) {
              console.log(`    ${formatTicker(null, intent.mint)} sold with unknown cost basis — P&L not counted`);
            }
            await saveLiveBook(book);
          } else {
            console.error(`    ⚠ could not settle ${result.signature.slice(0, 12)}… — ${fill.error}`);
          }
        }

        await updateIntent(intent.id, {
          outcome: result.status,
          executionSignature: result.signature ?? null,
          attempts: result.attempts ?? null,
          panicked: result.panicked ?? false,
          error: result.error ?? null,
          // The honest fill, for the daily limit and for Phase 3 calibration.
          realisedSol,
          actualSolSpent: fill?.solSpent ?? null,
          actualSolReceived: fill?.solReceived ?? null,
          actualTokenDelta: fill?.tokenDelta ?? null,
          settleError: fill && !fill.ok ? fill.error : null,
        });

        if (intent.side === 'BUY') {
          // Commit the ACTUAL spend, or give the room back. A reservation that
          // is never settled ratchets the cap shut on trades that never happened.
          if (result.status === 'LANDED') slot.commit(fill?.solSpent);
          else slot.release();
        } else if (result.status === 'LANDED' && Number.isFinite(fill?.solReceived)) {
          // A closed position frees its capital for the next one.
          exposure.releaseCommitted(fill.solReceived);
        }

        // ITEM 5 again, and this is the important one: re-read the chain after
        // every fill rather than assuming the transaction did what the quote
        // said. A partial fill, a different route, or an ABANDONED transaction
        // that landed anyway all show up here and nowhere else.
        const after = await reconcile({ owner: signer.publicKey, rpcUrl, rpcImpl, book });
        if (after.ok) await saveLiveBook(book);

        if (result.needsHuman) {
          console.error(`  ⛔ STUCK POSITION ${formatTicker(null, intent.mint)} — ${result.error}`);
        }
        stats[result.status] = (stats[result.status] ?? 0) + 1;
        console.log(`  ${renderIntent(intent)}  → ${result.status}${result.panicked ? ' (panic)' : ''}`);

        // ITEM 5 + the daily limit, re-checked after every fill rather than
        // only at startup — a limit that is only ever read once is not a limit.
        const loss = dailyLossState(await loadIntents(), cfg);
        if (loss.tripped) {
          console.error(`\n  ⛔ daily loss limit hit (${loss.realisedSol.toFixed(4)} SOL). Halting.`);
          process.exit(1);
        }
        await new Promise((r) => setTimeout(r, cfg.quotePaceMs ?? 400));
        return;
      }

      stats[intent.decision] = (stats[intent.decision] ?? 0) + 1;
      if (!live && intent.decision === 'WOULD_BUY') {
        // Shadow mode reserves and immediately commits: no transaction settles
        // it, so a reservation left open would exhaust the cap after a few
        // trades and make the rest of the run measure nothing.
        const slot = exposure.reserve(intent.sizeSol);
        if (slot.ok) slot.commit(intent.sizeSol);
      }
      if (Number.isFinite(intent.quoteGapPct)) (seeded ? seededGaps : gaps).push(intent.quoteGapPct);
      await appendIntent(forLog(intent));
      // Paced: the free tier throttles under burst, and a throttle masquerading
      // as a routing failure is exactly what this run has to avoid measuring.
      await new Promise((r) => setTimeout(r, cfg.quotePaceMs ?? 400));
      console.log(renderIntent(intent));
    }
  };

  /**
   * Handle a batch. Concurrent up to the burst limit, per-mint still serialised.
   *
   * The seed pass stays SERIAL: it is a cold replay of history with no latency
   * to save, and running it concurrently would open a burst of Jupiter calls at
   * the exact moment the free tier is most likely to throttle — poisoning the
   * measurement the seed exists to produce.
   */
  const handle = async (trades, { seeded = false } = {}) => {
    if (seeded || burstLimit === 1) {
      for (const t of trades) await handleOne(t, { seeded });
      return;
    }
    await runBounded(trades, { limit: burstLimit, worker: (t) => handleOne(t, { seeded }) });
  };

  // A cold pass over recent history, so the first run produces measurements
  // immediately rather than waiting for the target to act.
  const seed = await fetchWhaleTrades({
    wallet: target.address,
    rpcUrl,
    signatureLimit: Number(argv[argv.indexOf('--seed') + 1]) || 12,
    maxTxLookups: Number(argv[argv.indexOf('--seed') + 1]) || 12,
    delayMs: 60,
  });
  if (seed.ok && seed.trades.length) {
    console.log(`\n  seeding from ${seed.trades.length} recent target trade(s)\n`);
    await handle(seed.trades, { seeded: true });
  }

  const summary = () => {
    const total = Object.values(stats).reduce((a, n) => a + n, 0);
    console.log('\n' + '─'.repeat(64));
    console.log('  PHASE 1 MEASUREMENTS');
    for (const [k, n] of Object.entries(stats)) if (n) console.log(`    ${String(n).padStart(4)}  ${k}`);
    const buys = stats.WOULD_BUY + stats.NO_ROUTE + stats.BLOCKED + stats.QUOTE_FAILED;
    const fmt = (a) => { const g=[...a].sort((x,y)=>x-y); return 'median '+g[Math.floor(g.length/2)].toFixed(1)+'% (n='+g.length+', '+g[0].toFixed(1)+'% to '+g[g.length-1].toFixed(1)+'%)'; };
    if (seededGaps.length) {
      console.log('    seeded gap  : '+fmt(seededGaps));
      console.log('      ^ quoted against trades MINUTES old, so this is price drift as much as');
      console.log('        copy cost. It is the same flawed comparison that produced');
      console.log('        copyImpactPct 9. Do NOT calibrate from it.');
    }
    if (gaps.length) {
      console.log('    LIVE gap    : '+fmt(gaps)+'  <- the number worth trusting');
    } else if (seededGaps.length) {
      console.log('    LIVE gap    : none yet — run --watch and let the target trade');
    }
    if (false) {
      const g=[...gaps].sort((a,b)=>a-b);
      console.log('    quote gap vs target fill: median '+g[Math.floor(g.length/2)].toFixed(1)+'% (n='+g.length+', min '+g[0].toFixed(1)+'%, max '+g[g.length-1].toFixed(1)+'%)');
    }
    if (buys) {
      console.log(`    no-route rate ${((stats.NO_ROUTE / buys) * 100).toFixed(1)}% of buy attempts`);
      console.log(`    gate rejects  ${((stats.BLOCKED / buys) * 100).toFixed(1)}% of buy attempts`);
    }
    // ── PHASE 3: the round-trip calibration ────────────────────────────────
    const cal = calibrationSummary(calibration);
    const verdict = calibrationVerdict(cal);
    if (cal.roundTrips || cal.exitSamples || cal.seededRoundTrips) {
      const pct = (v) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
      console.log('\n  SHADOW CALIBRATION (Phase 3)');
      console.log(`    entry gap   : ${pct(cal.medianEntryGapPct)} median (n=${cal.entrySamples})   [+ = we pay more]`);
      console.log(`    exit gap    : ${pct(cal.medianExitGapPct)} median (n=${cal.exitSamples})   [- = we receive less]`);
      if (cal.roundTrips) {
        console.log(`    ROUND-TRIP DRAG: ${pct(cal.medianDragPct)} median, ${pct(cal.meanDragPct)} mean (n=${cal.roundTrips})`);
        console.log(`      our return minus the target's on the SAME token — the token's own move`);
        console.log(`      cancels, so what is left is purely what copying cost.`);
        console.log(`      worst ${pct(cal.worstDragPct)} · best ${pct(cal.bestDragPct)} · ahead on ${cal.aheadCount}/${cal.roundTrips}`);
      }
      if (cal.seededRoundTrips) {
        console.log(`    seeded drag : ${pct(cal.seededMedianDragPct)} (n=${cal.seededRoundTrips}) — EXCLUDED from the above`);
        console.log(`      quoted against trades minutes old, so this is price drift as much as`);
        console.log(`      copy cost. Mixing it in is how copyImpactPct came to be 9 when the`);
        console.log(`      true figure at ~500ms was -8.9%. Do NOT calibrate from it.`);
      }
      if (cal.openPositions) console.log(`    ${cal.openPositions} entr(ies) still open — their drag is not counted yet`);
      console.log(`    scaling verdict: ${verdict.ok ? 'OK' : 'NOT YET'} — ${verdict.reason}`);
    }

    // ── PHASE 4: where the track record puts the caps ──────────────────────
    console.log(`\n  CAPITAL TIER: ${tier.tier}  (max trade ${tier.maxTradeSol} SOL · exposure ${tier.maxExposureSol} · daily loss ${tier.dailyLossLimitSol})`);
    console.log(`    evidence    : ${record.roundTrips} round trips · net ${record.netSol.toFixed(3)} SOL · ${record.exitSamples} exit samples`);
    if (tier.next) {
      console.log(`    to reach '${tier.next.name}': ${tier.next.needs.length ? tier.next.needs.join(', ') : 'all gates met — rerun to promote'}`);
    }

    console.log(`  intents logged to .state/live_intents.json (${total} this run)`);
    if (live) {
      const landed = stats.LANDED ?? 0;
      console.log(`  ${landed} transaction(s) LANDED · ${stats.ABANDONED ?? 0} abandoned · ${stats.FAILED ?? 0} failed · ${stats.STUCK ?? 0} stuck`);
      if (stats.ABANDONED) console.log('    abandoned buys were NOT retried and may still have landed — reconcile confirms.');
      if (stats.STUCK) console.log('    ⛔ a stuck position needs manual exit.');
    } else {
      console.log('  Nothing was signed, sent, or spent.');
    }
  };

  if (argv.includes('--once')) {
    summary();
    return;
  }

  const watchIdx = argv.indexOf('--watch');
  const intervalSec = watchIdx !== -1 ? Number(argv[watchIdx + 1]) || 5 : null;
  if (!intervalSec) {
    summary();
    return;
  }

  const socket = createWhaleSocket({ wallet: target.address, rpcUrl, cfg: config.rpcMirror ?? {}, log: () => {} });
  book.lastSignature = (await fetchLatestSignature({ wallet: target.address, rpcUrl })).signature ?? null;
  console.log(`\n  watching every ${intervalSec}s — Ctrl+C to stop\n`);

  // SIGINT (Ctrl+C) works everywhere. SIGTERM is registered for Linux and
  // containers, where a task manager or `docker stop` sends TERM.
  //
  // VERIFIED: on Windows SIGTERM CANNOT be caught at all — a handler does not
  // run even for a self-sent process.kill(pid, 'SIGTERM'), and GNU `timeout`
  // terminates the process abruptly. So this handler is not a safety net on
  // this machine, and calibration is persisted as each pair CLOSES rather than
  // at shutdown. That per-pair write is the only thing that survives a hard
  // kill here, which is why it is not merely an optimisation.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await saveCalibration(calibration).catch(() => {});
    summary();
    socket.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
    const live = socket.isConnected()
      ? await socket.drain()
      : await fetchWhaleTrades({ wallet: target.address, rpcUrl, sinceSignature: book.lastSignature });
    if (live.ok && live.newestSignature) book.lastSignature = live.newestSignature;
    if (live.ok && live.trades.length) await handle(live.trades);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2));
}
