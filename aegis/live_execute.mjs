#!/usr/bin/env node
/**
 * Phase 2 execution primitives — signing, sending, confirming, reconciling.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS MODULE CAN SPEND REAL MONEY. Everything here exists to make that
 * survivable rather than to make it easy.
 *
 * ── THE KEY BOUNDARY, WHICH IS THE WHOLE DESIGN ─────────────────────────────
 * No function here reads a key from anywhere. `createSigner` takes raw bytes
 * the CALLER obtained, at call time, and returns an opaque object exposing a
 * public key and a sign function. The bytes are captured in a closure and
 * never assigned to module scope, never serialised, never logged, and never
 * returned. There is no `loadKeyFromEnv` in this file on purpose: a module that
 * knows how to find a key can be made to use one by a caller that did not
 * intend to.
 *
 * Consequences worth stating: anything that logs an intent must log the public
 * key only, and a crash dump of this module cannot leak a secret because the
 * secret is not reachable from any exported value.
 *
 * ── WHY SIGNING IS HAND-ROLLED ──────────────────────────────────────────────
 * Solana signs the MESSAGE portion of a transaction with ed25519, which
 * node:crypto does natively. Pulling in @solana/web3.js for that one operation
 * would add a large dependency tree to a repo whose package note says the
 * scanner "stays dependency-free and runs on Node built-ins alone".
 *
 * The failure mode is also benign in the direction that matters: a
 * mis-constructed signature produces a transaction the network REJECTS. It
 * cannot produce a transaction that does something other than intended — the
 * message bytes are Jupiter's and are signed as-is, not rebuilt. verifySigned()
 * checks the signature against the message locally before anything is sent, so
 * a layout mistake surfaces here rather than on chain.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * base58
 * ------------------------------------------------------------------ */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte === 0) out += '1';
    else break;
  }
  return out + digits.reverse().map((d) => B58[d]).join('');
}

export function base58Decode(str) {
  const bytes = [0];
  for (const ch of String(str)) {
    const value = B58.indexOf(ch);
    if (value === -1) throw new Error(`invalid base58 character: ${ch}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leading = 0;
  for (const ch of String(str)) {
    if (ch === '1') leading++;
    else break;
  }
  return Uint8Array.from([...new Array(leading).fill(0), ...bytes.reverse()]);
}

/* ------------------------------------------------------------------ *
 * ITEM 1 — the signer
 * ------------------------------------------------------------------ */

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * An opaque signer built from raw key bytes supplied by the caller.
 *
 * Accepts either a 64-byte Solana secret key (32-byte seed followed by the
 * 32-byte public key) or a bare 32-byte seed. When the public half is present
 * it is CHECKED against the key derived from the seed rather than trusted — a
 * mismatch means the bytes are not a coherent keypair, and finding that out
 * here is much cheaper than finding out by signing for the wrong wallet.
 *
 * `expectPublicKey` is the second guard: pass the address you believe you are
 * trading from and a mix-up fails before a single lamport moves.
 */
export function createSigner({ secretKey, expectPublicKey = null } = {}) {
  if (!secretKey) throw new Error('createSigner needs secretKey bytes');
  const raw = secretKey instanceof Uint8Array ? secretKey : Uint8Array.from(secretKey);
  if (raw.length !== 64 && raw.length !== 32) {
    throw new Error(`secretKey must be 32 or 64 bytes, got ${raw.length}`);
  }

  const seed = raw.slice(0, 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  const derived = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);

  if (raw.length === 64) {
    const embedded = Buffer.from(raw.slice(32));
    if (!embedded.equals(derived)) {
      throw new Error('secretKey is not a coherent keypair: embedded public key does not match the seed');
    }
  }

  const publicKey = base58Encode(derived);
  if (expectPublicKey && expectPublicKey !== publicKey) {
    throw new Error(`signer is ${publicKey}, expected ${expectPublicKey} — refusing to sign for the wrong wallet`);
  }

  // `privateKey` lives only in this closure. Nothing returned exposes it, and
  // toJSON is stubbed so an accidental JSON.stringify of an intent cannot
  // serialise a signer into a log.
  return {
    publicKey,
    publicKeyBytes: derived,
    sign: (message) => edSign(null, Buffer.from(message), privateKey),
    toJSON: () => ({ publicKey, secret: '[redacted]' }),
  };
}

/* ------------------------------------------------------------------ *
 * ITEM 2 — sign and send
 * ------------------------------------------------------------------ */

/** Read a compact-u16 (shortvec) length prefix. PURE. */
export function readCompactU16(bytes, offset = 0) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    const byte = bytes[cursor++];
    if (byte === undefined) throw new Error('truncated compact-u16');
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 21) throw new Error('compact-u16 too long');
  }
  return { value, bytes: cursor - offset };
}

/**
 * Split a serialised transaction into its signature array and message. PURE.
 *
 * The wire format is: compact-u16 signature count, that many 64-byte
 * signatures, then the message. The message is what gets signed, and it is
 * passed through untouched — this function never rebuilds it, so a signature
 * produced here can only authorise exactly what Jupiter constructed.
 */
export function splitTransaction(txBytes) {
  const { value: sigCount, bytes: prefixLen } = readCompactU16(txBytes, 0);
  const sigStart = prefixLen;
  const messageStart = sigStart + sigCount * 64;
  if (messageStart > txBytes.length) throw new Error('transaction truncated before message');
  return {
    sigCount,
    prefixLen,
    signatures: txBytes.subarray(sigStart, messageStart),
    message: txBytes.subarray(messageStart),
  };
}

/**
 * Sign a Jupiter transaction. PURE apart from the signer's crypto.
 *
 * Verifies its own output before returning. A layout mistake would otherwise
 * only surface as a network rejection, and at that point the priority fee has
 * already been committed for nothing.
 */
export function signTransaction({ transactionBase64, signer } = {}) {
  if (!transactionBase64) throw new Error('nothing to sign');
  if (!signer?.sign) throw new Error('no signer');

  const txBytes = Buffer.from(transactionBase64, 'base64');
  const { sigCount, prefixLen, message } = splitTransaction(txBytes);
  if (sigCount < 1) throw new Error('transaction expects no signatures — refusing to sign it');

  const signature = signer.sign(message);
  if (signature.length !== 64) throw new Error(`bad signature length ${signature.length}`);

  const signed = Buffer.from(txBytes);
  // Slot 0 is the fee payer, which is the wallet Jupiter built for.
  Buffer.from(signature).copy(signed, prefixLen);

  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(signer.publicKeyBytes)]),
    format: 'der',
    type: 'spki',
  });
  if (!edVerify(null, Buffer.from(message), publicKey, Buffer.from(signature))) {
    throw new Error('signature failed local verification — refusing to send');
  }

  return {
    signedBase64: signed.toString('base64'),
    signature: base58Encode(signature),
    messageBytes: message.length,
  };
}

/**
 * Broadcast. `skipPreflight` is FALSE by default.
 *
 * Preflight simulates the transaction and rejects it before it costs anything,
 * which catches a slippage failure or a missing account for free. Skipping it
 * buys perhaps 100ms of latency and pays for every failure in real fees. Speed
 * is not worth that on a first live run; make it a deliberate choice later.
 */
export async function sendSignedTransaction(
  { signedBase64, rpcUrl, rpcImpl, skipPreflight = false, maxRetries = 0 } = {}
) {
  if (!signedBase64) return { ok: false, error: 'nothing to send' };
  const res = await rpcImpl(rpcUrl, 'sendTransaction', [
    signedBase64,
    { encoding: 'base64', skipPreflight, maxRetries, preflightCommitment: 'processed' },
  ]);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, signature: res.result };
}

/* ------------------------------------------------------------------ *
 * ITEM 3 — confirmation bounded in SLOTS, and no buy retry
 * ------------------------------------------------------------------ */

/**
 * Wait for confirmation, but only for a few slots.
 *
 * ── WHY SLOTS AND NOT SECONDS, AND WHY SO FEW ───────────────────────────────
 * A blockhash stays valid ~150 slots (~60s), and the obvious implementation
 * polls until it expires. For copy-trading that is actively harmful: a buy that
 * lands 15 seconds after the target's is a buy into a move they may already have
 * exited, and the measured live copy impact of ~0% only holds at roughly one
 * second of lag.
 *
 * So the transaction is abandoned after `maxSlots` (~1.2s at three slots).
 * Abandoned means STOP — the caller must not resubmit a buy. A late fill is
 * worse than a missed one, and this is the only place that judgement can be
 * enforced.
 *
 * `abandoned` does NOT mean "did not land". The transaction may confirm later,
 * which is exactly why the caller reconciles against chain instead of assuming.
 */
export async function confirmWithinSlots(
  { signature, rpcUrl, rpcImpl, maxSlots = 3, pollMs = 300, maxPolls = 12 } = {}
) {
  const start = await rpcImpl(rpcUrl, 'getSlot', [{ commitment: 'processed' }]);
  const startSlot = start.ok ? Number(start.result) : null;

  for (let poll = 0; poll < maxPolls; poll++) {
    const status = await rpcImpl(rpcUrl, 'getSignatureStatuses', [[signature], { searchTransactionHistory: false }]);
    const entry = status.ok ? status.result?.value?.[0] : null;
    if (entry) {
      if (entry.err) return { confirmed: false, failed: true, error: JSON.stringify(entry.err).slice(0, 120), slot: entry.slot };
      return { confirmed: true, slot: entry.slot, confirmations: entry.confirmations ?? null };
    }

    const now = await rpcImpl(rpcUrl, 'getSlot', [{ commitment: 'processed' }]);
    const nowSlot = now.ok ? Number(now.result) : null;
    if (startSlot !== null && nowSlot !== null && nowSlot - startSlot > maxSlots) {
      return {
        confirmed: false,
        abandoned: true,
        slotsWaited: nowSlot - startSlot,
        error: `not confirmed within ${maxSlots} slots — abandoned, MUST NOT be retried as a buy`,
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { confirmed: false, abandoned: true, error: `no status after ${maxPolls} polls` };
}

/* ------------------------------------------------------------------ *
 * ITEM 4 — idempotency
 * ------------------------------------------------------------------ */

/**
 * Which intents need resolving against chain before trading resumes? PURE.
 *
 * An intent written but left without an outcome is the signature of a crash
 * between send and record. It must never be replayed blind: the transaction may
 * have landed, and re-sending a buy on restart doubles the position with no
 * record that it happened.
 */
export function unresolvedIntents(intents = []) {
  return intents.filter(
    (i) => i?.sentSignature && !i.outcome && (i.decision === 'BUY' || i.decision === 'SELL' || i.decision === 'WOULD_BUY' || i.decision === 'WOULD_SELL')
  );
}

/**
 * Resolve one dangling intent by asking the chain what happened.
 *
 * The answer is authoritative and the local guess is discarded. Anything that
 * cannot be determined is left UNRESOLVED rather than assumed failed — assuming
 * failure is what causes a double-buy.
 */
export async function resolveIntentOutcome({ intent, rpcUrl, rpcImpl } = {}) {
  if (!intent?.sentSignature) return { ...intent, outcome: 'NOT_SENT' };
  const status = await rpcImpl(rpcUrl, 'getSignatureStatuses', [
    [intent.sentSignature],
    { searchTransactionHistory: true },
  ]);
  if (!status.ok) return { ...intent, outcome: null, resolveError: status.error };
  const entry = status.result?.value?.[0];
  if (!entry) return { ...intent, outcome: 'NOT_FOUND' };
  return { ...intent, outcome: entry.err ? 'FAILED' : 'LANDED', landedSlot: entry.slot ?? null };
}

/* ------------------------------------------------------------------ *
 * ITEM 5 — reconciliation
 * ------------------------------------------------------------------ */

/**
 * What the wallet ACTUALLY holds, from chain.
 *
 * Returns UI amounts keyed by mint, zero balances dropped.
 */
export async function fetchHoldings({ owner, rpcUrl, rpcImpl } = {}) {
  const res = await rpcImpl(rpcUrl, 'getTokenAccountsByOwner', [
    owner,
    { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    { encoding: 'jsonParsed' },
  ]);
  if (!res.ok) return { ok: false, error: res.error, holdings: new Map() };
  const holdings = new Map();
  for (const acc of res.result?.value ?? []) {
    const info = acc?.account?.data?.parsed?.info;
    const mint = info?.mint;
    const amount = Number(info?.tokenAmount?.uiAmount ?? 0);
    if (!mint || !(amount > 0)) continue;
    holdings.set(mint, (holdings.get(mint) ?? 0) + amount);
  }
  return { ok: true, holdings };
}

/**
 * Compare the book against reality. PURE.
 *
 * ── THE CHAIN IS TRUTH, THE BOOK IS A BELIEF ────────────────────────────────
 * In paper trading the book IS the outcome. Live, it is a record that drifts:
 * a sell that failed leaves a position the book thinks is closed, a partial
 * fill leaves less than it thinks, and an ATA left behind leaves dust it does
 * not know about. Unreconciled, P&L becomes fiction within a day and — worse —
 * the engine tries to sell tokens it does not have.
 *
 * Reports rather than mutates, so the caller decides what to trust and the
 * comparison itself is testable.
 */
export function diffHoldings({ book, holdings, dustThreshold = 1e-9 } = {}) {
  const positions = book?.positions ?? {};
  const missing = [];
  const untracked = [];
  const held = [];

  for (const mint of Object.keys(positions)) {
    const actual = holdings.get(mint) ?? 0;
    if (actual <= dustThreshold) missing.push({ mint, expected: true, actual });
    else held.push({ mint, actual });
  }
  for (const [mint, amount] of holdings) {
    if (!positions[mint] && amount > dustThreshold) untracked.push({ mint, actual: amount });
  }

  return {
    // The book holds a position the wallet does not — a sell that landed
    // without being recorded, or a buy that never did.
    missing,
    // The wallet holds something the book does not — a failed sell, or a buy
    // recorded as failed that actually landed. Dangerous: nothing will ever
    // try to exit it.
    untracked,
    held,
    inSync: missing.length === 0 && untracked.length === 0,
  };
}

/* ------------------------------------------------------------------ *
 * ITEM 6 — panic exit
 * ------------------------------------------------------------------ */

/**
 * Escalation for a sell that will not go through. PURE.
 *
 * ── EXITS AND ENTRIES ARE NOT SYMMETRIC ─────────────────────────────────────
 * A missed buy costs an opportunity. A failed sell leaves real money in a pool
 * that may be draining, and on a memecoin exit liquidity can thin out in
 * seconds. Repeating the same request is the one thing guaranteed not to work,
 * so each attempt widens slippage and raises the fee.
 *
 * The ceiling is deliberate rather than unbounded: past `panicSlippageBps` the
 * fill is so bad that a sale is barely a sale, and an unbounded escalation on a
 * token that is genuinely unsellable just burns fees. It gives up and says so,
 * which is a stuck position a human should see rather than a loop.
 */
export function panicEscalation(attempt, cfg = {}) {
  const base = cfg.slippageBps ?? 300;
  const panic = cfg.panicSlippageBps ?? 2500;
  const basePriority = cfg.priorityFeeMaxLamports ?? 1_000_000;
  const panicPriority = cfg.panicPriorityFeeLamports ?? 5_000_000;
  const threshold = cfg.panicAfterFailedSells ?? 2;
  const maxAttempts = cfg.panicMaxAttempts ?? 5;

  if (attempt >= maxAttempts) {
    return { giveUp: true, reason: `sell failed ${attempt} times — position is stuck and needs a human` };
  }
  if (attempt < threshold) {
    return { giveUp: false, panic: false, slippageBps: base, priorityFeeMaxLamports: basePriority, attempt };
  }
  // Ramp from the normal bar to the panic bar across the remaining attempts.
  const span = Math.max(1, maxAttempts - threshold);
  const t = Math.min(1, (attempt - threshold + 1) / span);
  return {
    giveUp: false,
    panic: true,
    slippageBps: Math.round(base + (panic - base) * t),
    priorityFeeMaxLamports: Math.round(basePriority + (panicPriority - basePriority) * t),
    attempt,
  };
}

/* ------------------------------------------------------------------ *
 * Multi-signer support
 * ------------------------------------------------------------------ */

/**
 * Build one signer per sub-wallet, from bytes the CALLER already read.
 *
 * Same boundary as createSigner and for the same reason: this takes raw bytes,
 * never a path and never an environment name. The array shape does not relax
 * that — each entry is bytes the CLI edge obtained and is responsible for.
 *
 * ── DISTINCTNESS IS CHECKED, NOT ASSUMED ────────────────────────────────────
 * The same keyfile passed twice would produce two signers for ONE wallet. The
 * partition would still divide by N, the bundle would still contain N
 * transactions, and every log line would look correct — while that wallet
 * silently took a double share and the sub-wallet exit profiles collided on a
 * single token balance. Nothing downstream can detect it, so it is rejected
 * here.
 */
export function createSigners(secretKeys = [], { expectPublicKeys = null } = {}) {
  if (!Array.isArray(secretKeys) || secretKeys.length === 0) {
    throw new Error('createSigners needs at least one secret key');
  }
  const signers = secretKeys.map((secretKey, i) =>
    createSigner({ secretKey, expectPublicKey: expectPublicKeys?.[i] ?? null })
  );

  const seen = new Map();
  for (const [i, s] of signers.entries()) {
    if (seen.has(s.publicKey)) {
      throw new Error(
        `sub-wallets ${seen.get(s.publicKey) + 1} and ${i + 1} are the same wallet (${s.publicKey.slice(0, 8)}…) — ` +
          'a duplicate would take a double share while every log line looked correct'
      );
    }
    seen.set(s.publicKey, i);
  }
  return signers;
}

/* ------------------------------------------------------------------ *
 * Jito bundles
 * ------------------------------------------------------------------ */

export const JITO_BUNDLE_ENDPOINT = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

/**
 * Jito accepts at most five transactions in one bundle.
 *
 * This is why --sub-wallets is capped at 5: a sixth sub-wallet could not land
 * atomically with the others, which would defeat the only reason to bundle.
 */
export const JITO_MAX_BUNDLE_SIZE = 5;

/**
 * Assemble a bundle from already-signed transactions. PURE.
 *
 * ── WHAT A BUNDLE DOES AND DOES NOT DO ──────────────────────────────────────
 * A Jito bundle is executed atomically, in order, within a single slot: either
 * every transaction lands or none does. For sub-wallet entries that is exactly
 * the property wanted — N wallets buying the same token in the same block at
 * the same price, rather than in sequence at N different prices, which would
 * make the sub-wallets' entries incomparable before their exits ever diverge.
 *
 * It is worth being accurate about the threat model, since it changes what to
 * expect. Solana has no public pending-transaction mempool of the Ethereum
 * kind, so this is not protection from someone reading an unconfirmed
 * transaction. What it does provide is that the bundle's transactions cannot be
 * interleaved with a third party's inside the block, which is what stops a
 * sandwich forming between our own buys. Leader-level ordering is still an
 * auction: a bundle competes on tip, and losing the auction means the bundle
 * simply does not land that slot.
 *
 * The tip itself is not added here. Jupiter builds it into the swap when the
 * swap request carries prioritizationFeeLamports.jitoTipLamports — VERIFIED
 * against the live API, which returns a 735-byte transaction with the tip
 * against 698 without. Constructing a transfer by hand would mean building a
 * transaction from scratch rather than signing one, and every extra byte we
 * author is a byte that can authorise something unintended.
 */
export function buildJitoBundle(signedTransactions = [], { encoding = 'base64' } = {}) {
  const txs = signedTransactions.filter(Boolean);
  if (txs.length === 0) return { ok: false, error: 'bundle is empty' };
  if (txs.length > JITO_MAX_BUNDLE_SIZE) {
    return { ok: false, error: `bundle holds ${txs.length}, Jito accepts at most ${JITO_MAX_BUNDLE_SIZE}` };
  }
  for (const [i, t] of txs.entries()) {
    if (typeof t !== 'string' || !t.length) return { ok: false, error: `transaction ${i} is not an encoded string` };
  }
  return {
    ok: true,
    // Order is preserved and is meaningful: Jito executes the bundle in the
    // order given, so the tip-bearing transaction must not be last if an
    // earlier one can fail the whole bundle.
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [txs, { encoding }],
    },
    size: txs.length,
    encoding,
  };
}

/**
 * Submit a bundle to the Jito block engine.
 *
 * `allowSend` defaults to FALSE. Every other send path in this codebase is
 * reachable only with an explicit --live and a signer; a bundle submitter that
 * broadcast by default would be the one way real money could move without that
 * chain of consent. It has to be opted into at the call site.
 */
export async function submitJitoBundle(
  { bundle, endpoint = JITO_BUNDLE_ENDPOINT, fetchImpl = fetch, allowSend = false, timeoutMs = 10_000 } = {}
) {
  if (!bundle?.ok) return { ok: false, error: bundle?.error ?? 'no bundle' };
  if (!allowSend) {
    return { ok: false, blocked: true, error: 'submitJitoBundle requires allowSend:true — refusing to broadcast by default' };
  }
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle.payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    if (body?.error) return { ok: false, error: body.error?.message ?? JSON.stringify(body.error).slice(0, 120) };
    // The bundle id is not a signature and cannot be looked up with
    // getSignatureStatuses; the transactions inside carry their own.
    return { ok: true, bundleId: body?.result ?? null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Sign every sub-wallet's transaction for one atomic entry. PURE-ish.
 *
 * Each transaction is signed by ITS OWN wallet — signer i signs transaction i.
 * They are paired by index, and a mismatch is rejected rather than signed:
 * signing wallet A's transaction with wallet B's key produces a transaction the
 * network rejects, which at bundle scale means all N entries silently fail to
 * land together.
 */
export function signBundleTransactions({ transactions = [], signers = [] } = {}) {
  if (transactions.length !== signers.length) {
    return { ok: false, error: `${transactions.length} transactions against ${signers.length} signers — they pair by index` };
  }
  const signed = [];
  for (const [i, tx] of transactions.entries()) {
    try {
      signed.push(signTransaction({ transactionBase64: tx, signer: signers[i] }));
    } catch (err) {
      return { ok: false, error: `sub-wallet ${i + 1} (${signers[i]?.publicKey?.slice(0, 8)}…): ${err.message}` };
    }
  }
  return { ok: true, signed, encoded: signed.map((s) => s.signedBase64), signatures: signed.map((s) => s.signature) };
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

/**
 * Sign, send, and confirm one prepared transaction.
 *
 * Returns a verdict rather than throwing, because every branch here needs
 * recording: `landed`, `failed`, and `abandoned` lead to different next steps
 * and only one of them is safe to retry.
 *
 * NO RETRY LIVES IN HERE. A buy is never resubmitted — see confirmWithinSlots.
 * A sell escalates via panicEscalation, which is the caller's loop because only
 * the caller knows how many times this position has already refused to close.
 */
export async function executeTransaction(
  { transactionBase64, signer, rpcUrl, rpcImpl, cfg = {}, onSent = null } = {}
) {
  let signed;
  try {
    signed = signTransaction({ transactionBase64, signer });
  } catch (err) {
    return { status: 'UNSIGNABLE', error: err.message };
  }

  // Recorded BEFORE the send, so a crash between the two leaves a signature to
  // resolve against chain rather than a silent gap. This is what makes
  // unresolvedIntents able to find anything at all.
  await onSent?.({ signature: signed.signature });

  const sent = await sendSignedTransaction({
    signedBase64: signed.signedBase64,
    rpcUrl,
    rpcImpl,
    skipPreflight: cfg.skipPreflight === true,
  });
  if (!sent.ok) return { status: 'SEND_FAILED', error: sent.error, signature: signed.signature };

  const confirm = await confirmWithinSlots({
    signature: sent.signature,
    rpcUrl,
    rpcImpl,
    maxSlots: cfg.maxConfirmSlots ?? 3,
  });

  if (confirm.confirmed) return { status: 'LANDED', signature: sent.signature, slot: confirm.slot };
  if (confirm.failed) return { status: 'FAILED', signature: sent.signature, error: confirm.error };
  return { status: 'ABANDONED', signature: sent.signature, error: confirm.error, retryable: false };
}
