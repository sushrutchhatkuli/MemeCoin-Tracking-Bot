#!/usr/bin/env node
/**
 * Live copy-trade — PHASE 1, SHADOW MODE.
 *
 *   node live_copytrade.mjs --dry-run --pct-whale 15 --watch 5
 *   node live_copytrade.mjs --dry-run --once        one pass, then exit
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE CANNOT SPEND MONEY, AND THAT IS ENFORCED RATHER THAN INTENDED.
 *
 * There is no keypair, no signer, no sendTransaction, and no code path that
 * reaches one. `submitIntent` throws unconditionally. The module builds a real,
 * fully-formed, UNSIGNED transaction and stops there — that is the entire point
 * of Phase 1: every decision the live bot would make, made and logged, with the
 * broadcast removed rather than guarded by a flag that could be flipped by
 * accident.
 *
 * Signing belongs to Phase 2 and to a dedicated hot wallet whose key never
 * enters this repository.
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

const HERE = dirname(fileURLToPath(import.meta.url));
export const INTENT_LOG_PATH = join(HERE, '.state', 'live_intents.json');

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
  // target has already left. Phase 2 abandons an unconfirmed transaction after
  // this many slots and does NOT retry the buy — a late fill is worse than a
  // missed one. Recorded here so the policy is visible in shadow mode.
  maxConfirmSlots: 3,

  // ── PANIC DUMP (Phase 2) ─────────────────────────────────────────────────
  // Exits are not symmetric with entries. A missed buy costs an opportunity; a
  // failed sell leaves real money in a pool that may be draining. After this
  // many normal attempts the exit escalates rather than repeating.
  panicAfterFailedSells: 2,
  panicSlippageBps: 2500,
  panicPriorityFeeLamports: 5_000_000,

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

  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(12_000) });
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
    const res = await fetchImpl(`${cfg.jupiterBase}/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
 * Broadcast. NOT IMPLEMENTED, ON PURPOSE.
 *
 * Phase 1 is defined by the absence of this, and a thrown error is a stronger
 * guarantee than a `--dry-run` flag that a stray argument could clear. When
 * Phase 2 arrives, signing belongs to a dedicated hot wallet whose key is
 * loaded at the edge and never imported into this module.
 */
export async function submitIntent() {
  throw new Error(
    'submitIntent is not implemented — this build is shadow-mode only and cannot broadcast. ' +
      'Signing and sending belong to Phase 2 with a dedicated hot wallet.'
  );
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
  const decimals = await decimalsFor(trade.mint);
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
  };

  const gate = evaluateSafetyGate(await securityFor(trade.mint, venue), { venue, cfg });
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
    // Never persisted in full — it is large, single-use, and not needed once
    // its shape and size are known.
    transactionPreview: built.transactionBase64 ? `${built.transactionBase64.slice(0, 44)}…` : null,
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
  }[i.decision] ?? i.decision;

  const head = `  ${tag} ${formatTicker(null, i.mint).padEnd(12)}`;
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
  if (!argv.includes('--dry-run')) {
    console.error('live_copytrade.mjs is shadow-mode only. Pass --dry-run to acknowledge that');
    console.error('nothing is signed or sent. There is no live path in this build.');
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
  const book = (await loadBook()) ?? createBook({ budgetSol: 0 });
  const target = resolveTarget(watchlist, book).target;
  if (!target?.address) {
    console.error('No target wallet in the watchlist.');
    process.exitCode = 1;
    return;
  }

  const solUsd = await fetchSolUsd();
  // A pretend wallet. Phase 1 has no keypair, and the address only shapes the
  // transaction Jupiter builds — nothing derived from it is ever signed.
  // Jupiter rejects the System Program address with HTTP 422 — it is not a
  // wallet. The target's own address is a guaranteed-valid account to build
  // against, and nothing built here is ever signed.
  const userPublicKey = argv.includes('--as') ? argv[argv.indexOf('--as') + 1] : target.address;
  const nativeSolBalance = Number(argv[argv.indexOf('--balance') + 1]) || 0.5;

  console.log('═'.repeat(64));
  console.log('  LIVE COPYTRADE — PHASE 1 SHADOW MODE');
  console.log('═'.repeat(64));
  console.log(`  target        ${target.address.slice(0, 16)}…`);
  console.log(`  node          ${new URL(rpcUrl).host}`);
  console.log(`  jupiter       ${new URL(cfg.jupiterBase).host}`);
  console.log(`  sizing        ${paperCfg.pctWhale ? paperCfg.pctWhale + '% of target' : paperCfg.perTradeSol + ' SOL flat'}`);
  console.log(`  simulated bal ${nativeSolBalance} SOL · reserve ${cfg.gasReserveSol} · max trade ${cfg.maxTradeSol}`);
  console.log(`  NOTHING IS SIGNED OR SENT — submitIntent() throws by design.`);
  console.log('═'.repeat(64));

  const lock = createMintLock();
  const stats = { WOULD_BUY: 0, WOULD_SELL: 0, SKIP: 0, BLOCKED: 0, NO_ROUTE: 0, THROTTLED: 0, QUOTE_FAILED: 0, BUILD_FAILED: 0 };
  const gaps = [];
  const seededGaps = [];
  let exposureSol = 0;

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
  const { solanaRpc } = await import('./paper_copytrade.mjs');
  const decimalsCache = new Map();
  const decimalsFor = async (mint) => {
    if (decimalsCache.has(mint)) return decimalsCache.get(mint);
    const r = await solanaRpc(rpcUrl, 'getTokenSupply', [mint]).catch(() => ({ ok: false }));
    const d = r.ok ? Number(r.result?.value?.decimals) : null;
    decimalsCache.set(mint, Number.isFinite(d) ? d : null);
    return decimalsCache.get(mint);
  };

  const handle = async (trades, { seeded = false } = {}) => {
    for (const t of trades) {
      // Serialised per mint: a BUY and an ADD arriving together must not both
      // build a transaction for the same token.
      const intent = await lock.run(t.mint, () =>
        planIntent(t, {
          cfg,
          paperCfg,
          book,
          solUsd,
          userPublicKey,
          nativeSolBalance,
          exposureSol,
          securityFor,
          decimalsFor,
          now: Date.now(),
        })
      );
      intent.seeded = seeded;
      stats[intent.decision] = (stats[intent.decision] ?? 0) + 1;
      if (intent.decision === 'WOULD_BUY') exposureSol += intent.sizeSol;
      if (Number.isFinite(intent.quoteGapPct)) (seeded ? seededGaps : gaps).push(intent.quoteGapPct);
      await appendIntent(intent);
      // Paced: the free tier throttles under burst, and a throttle masquerading
      // as a routing failure is exactly what this run has to avoid measuring.
      await new Promise((r) => setTimeout(r, cfg.quotePaceMs ?? 400));
      console.log(renderIntent(intent));
    }
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
    console.log(`  intents logged to .state/live_intents.json (${total} this run)`);
    console.log('  Nothing was signed, sent, or spent.');
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

  process.on('SIGINT', () => {
    summary();
    socket.close();
    process.exit(0);
  });

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
