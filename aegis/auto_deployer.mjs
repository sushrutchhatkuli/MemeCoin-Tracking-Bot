#!/usr/bin/env node
/**
 * Transparent Pump.fun token deployer — PHASE 1: pure building blocks.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE TOUCHES THE NETWORK OR A KEY. Phase 1 is metadata shaping,
 * allocation arithmetic and address derivation — all pure, all testable without
 * a wallet. Signing, IPFS upload and Jito dispatch belong to later phases and
 * are deliberately absent rather than stubbed behind a flag.
 *
 * ── ONE DISCLOSED CREATOR WALLET ────────────────────────────────────────────
 * The allocation here goes to a single wallet that is visibly the deployer on
 * chain. An earlier draft split it across five wallets buying in the same block;
 * those wallets do no execution work, they only make one buyer look like five.
 * Aegis itself flags that pattern — smart_money.mjs reports "N bundled insider
 * wallet(s) … same-block accumulation detected" — and the Insider Shield blocks
 * tokens carrying it. See `02 Token Deployer Plan` in the vault.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';
import { base58Decode, base58Encode, buildJitoBundle, JITO_MAX_BUNDLE_SIZE } from './live_execute.mjs';

const LAMPORTS = 1e9;

/** Pump.fun bonding curve program. VERIFIED executable on mainnet, BPF loader. */
export const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/**
 * ── PUMP.FUN MINTS ARE TOKEN-2022, AND THAT CHANGES THE ATA ────────────────
 * The token program id is a SEED of the associated token account, so using the
 * classic one for a Token-2022 mint derives a real, valid, off-curve address
 * that is simply the wrong account. MEASURED against three live pump mints: the
 * classic seed produced 9xCa3ZwS… while the account the curve actually owns is
 * EaEWpMQc…, and all three mints are owned by TokenzQdB… (Token-2022).
 *
 * This is the failure that would not have surfaced in review — both addresses
 * look equally plausible, and the wrong one only reveals itself as a
 * transaction that fails on chain after paying a fee.
 */
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** Pump.fun mints 1,000,000,000 tokens at 6 decimals. */
export const PUMP_TOTAL_SUPPLY = 1_000_000_000;
export const PUMP_DECIMALS = 6;

/* ------------------------------------------------------------------ *
 * 1. Metadata
 * ------------------------------------------------------------------ */

/**
 * The JSON that gets uploaded and pointed at by the mint. PURE.
 *
 * ── A MINT'S URI IS PERMANENT ───────────────────────────────────────────────
 * The metadata pointer is written into the token at creation and cannot be
 * repaired afterwards. So this validates rather than coerces: an empty symbol or
 * a missing image is refused here, where the cost is an error message, instead
 * of at mint time where the cost is a broken token that exists forever.
 *
 * Fields follow what Pump.fun's own uploader produces. `showName` and
 * `createdOn` look like decoration and are not — clients read them, and a
 * payload missing them renders differently from every other token on the site.
 */
export function buildTokenMetadata({
  name,
  symbol,
  description = '',
  imageUri,
  twitter = null,
  telegram = null,
  website = null,
} = {}) {
  const errors = [];

  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  const n = clean(name);
  const s = clean(symbol);
  const img = clean(imageUri);

  if (!n) errors.push('name is required');
  if (n.length > 32) errors.push(`name is ${n.length} chars, max 32`);
  if (!s) errors.push('symbol is required');
  if (s.length > 10) errors.push(`symbol is ${s.length} chars, max 10`);
  if (!img) errors.push('imageUri is required');
  else if (!/^(https?:\/\/|ipfs:\/\/|ar:\/\/)/i.test(img)) {
    // A bare CID or a local path is the mistake that produces a token whose
    // image never resolves anywhere.
    errors.push(`imageUri must be an absolute http(s)://, ipfs:// or ar:// URI, got "${img.slice(0, 40)}"`);
  }
  if (clean(description).length > 1000) errors.push('description exceeds 1000 chars');

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    metadata: {
      name: n,
      symbol: s,
      description: clean(description),
      image: img,
      showName: true,
      createdOn: 'https://pump.fun',
      // Omitted entirely rather than sent as null — a null social renders as a
      // dead link on some clients, an absent one renders as nothing.
      ...(clean(twitter) ? { twitter: clean(twitter) } : {}),
      ...(clean(telegram) ? { telegram: clean(telegram) } : {}),
      ...(clean(website) ? { website: clean(website) } : {}),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 2. Creator allocation
 * ------------------------------------------------------------------ */

/**
 * The disclosed creator share, in whole base units. PURE.
 *
 * ── INTEGER BASE UNITS, FOR THE SAME REASON partitionSizeSol USES LAMPORTS ───
 * 5% of 1e15 base units in floats is exact, but 3.33% is not, and a token amount
 * that does not divide cleanly leaves dust that no later arithmetic can
 * reconcile. The remainder is reported rather than silently truncated, so a
 * percentage that cannot be expressed exactly says so.
 *
 * There is deliberately NO DEFAULT percentage. A silent default here is a silent
 * claim about how much of a supply someone holds.
 */
export function calculateTxInAllocation({
  totalSupply = PUMP_TOTAL_SUPPLY,
  txInPct,
  decimals = PUMP_DECIMALS,
} = {}) {
  if (!Number.isFinite(txInPct)) return { ok: false, error: 'txInPct is required' };
  if (txInPct < 0 || txInPct > 100) return { ok: false, error: `txInPct ${txInPct} is outside 0-100` };
  if (!Number.isFinite(totalSupply) || totalSupply <= 0) return { ok: false, error: 'totalSupply must be positive' };

  const scale = 10 ** decimals;
  const totalBase = Math.round(totalSupply * scale);
  // Basis points keep the multiply in integers: 5% is 500 bps, and
  // totalBase * 500 / 10000 avoids the float path entirely for the common cases.
  const bps = Math.round(txInPct * 100);
  const exact = (totalBase * bps) % 10_000 === 0;
  const allocationBase = Math.floor((totalBase * bps) / 10_000);

  return {
    ok: true,
    allocationBase,
    allocationTokens: allocationBase / scale,
    remainderBase: (totalBase * bps) % 10_000 === 0 ? 0 : (totalBase * bps) / 10_000 - allocationBase,
    exact,
    // What stays on the curve for everyone else. Reported because it is the
    // number a buyer cares about and the one a launch post should state.
    publicBase: totalBase - allocationBase,
    publicTokens: (totalBase - allocationBase) / scale,
    pct: txInPct,
    // The allocation costs the creator nothing in SOL — it is minted supply, not
    // a purchase. Named so no caller mistakes it for a buy.
    costSol: 0,
  };
}

/* ------------------------------------------------------------------ *
 * 3. Program-derived addresses
 * ------------------------------------------------------------------ */

const ED25519_P = 2n ** 255n - 19n;
// d = -121665 / 121666 (mod p), precomputed.
const ED25519_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const PDA_MARKER = Buffer.from('ProgramDerivedAddress');

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * Is this 32-byte value a point on the ed25519 curve? PURE.
 *
 * ── THIS IS THE WHOLE POINT OF A PDA ────────────────────────────────────────
 * A program-derived address must have NO corresponding private key, which is
 * exactly what "off the curve" means. Skip this test and findProgramAddress
 * happily returns a normal public key someone could hold the key to — an
 * account the program believes only it can sign for.
 *
 * Decompress y, solve for x² = (y²−1)/(dy²+1), and ask whether that has a square
 * root mod p. Euler's criterion answers it: a non-zero residue is a square iff
 * a^((p−1)/2) ≡ 1.
 */
export function isOnCurve(bytes) {
  if (!bytes || bytes.length !== 32) return false;
  // Little-endian, with the top bit being x's sign rather than part of y.
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y &= (1n << 255n) - 1n;
  if (y >= ED25519_P) return false;

  const y2 = (y * y) % ED25519_P;
  const u = (y2 - 1n + ED25519_P) % ED25519_P;
  const v = (ED25519_D * y2 + 1n) % ED25519_P;
  if (v === 0n) return false;

  // x² = u / v
  const x2 = (u * modPow(v, ED25519_P - 2n, ED25519_P)) % ED25519_P;
  if (x2 === 0n) return true;
  return modPow(x2, (ED25519_P - 1n) / 2n, ED25519_P) === 1n;
}

/**
 * Solana's findProgramAddress. PURE.
 *
 * Walks the bump seed DOWN from 255 and takes the first result that is off the
 * curve — "canonical bump" means the largest one that works, and every program
 * on chain assumes that convention. Starting from 0 would find a valid PDA that
 * no program would ever accept.
 */
export function findProgramAddress(seeds, programId) {
  const programBytes = Buffer.from(base58Decode(programId));
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(Buffer.from(s));
    h.update(Buffer.from([bump]));
    h.update(programBytes);
    h.update(PDA_MARKER);
    const candidate = h.digest();
    if (!isOnCurve(candidate)) {
      return { address: base58Encode(candidate), bump, bytes: candidate };
    }
  }
  return null; // 1 in 2^256; Solana treats it as unreachable too.
}

/**
 * The two accounts a Pump.fun launch needs alongside the mint. PURE.
 *
 * `bondingCurve` is the program's own PDA holding the curve state, seeded
 * ["bonding-curve", mint]. `associatedBondingCurve` is that PDA's associated
 * token account for the mint — the vault the curve actually sells from — and is
 * derived through the associated-token program like any other ATA.
 *
 * Both are derived, not looked up, so this works for a mint that does not exist
 * yet. That is what makes a `--paper` deploy checkable before anything is spent.
 */
export function derivePumpFunPDAs(
  mintPublicKey,
  { programId = PUMP_FUN_PROGRAM, tokenProgram = TOKEN_2022_PROGRAM } = {}
) {
  if (typeof mintPublicKey !== 'string' || !mintPublicKey) {
    return { ok: false, error: 'mintPublicKey is required' };
  }
  let mintBytes;
  try {
    mintBytes = Buffer.from(base58Decode(mintPublicKey));
  } catch (err) {
    return { ok: false, error: `mint is not base58: ${err.message}` };
  }
  if (mintBytes.length !== 32) {
    return { ok: false, error: `mint decodes to ${mintBytes.length} bytes, expected 32` };
  }

  const bondingCurve = findProgramAddress([Buffer.from('bonding-curve'), mintBytes], programId);
  if (!bondingCurve) return { ok: false, error: 'no off-curve bonding curve address' };

  const associated = findProgramAddress(
    [
      Buffer.from(base58Decode(bondingCurve.address)),
      Buffer.from(base58Decode(tokenProgram)),
      mintBytes,
    ],
    ASSOCIATED_TOKEN_PROGRAM
  );
  if (!associated) return { ok: false, error: 'no off-curve associated bonding curve address' };

  return {
    ok: true,
    mint: mintPublicKey,
    bondingCurve: bondingCurve.address,
    bondingCurveBump: bondingCurve.bump,
    associatedBondingCurve: associated.address,
    associatedBondingCurveBump: associated.bump,
    programId,
    tokenProgram,
  };
}

/* ------------------------------------------------------------------ *
 * PHASE 2 — metadata upload and bundle assembly
 * ------------------------------------------------------------------ */

export const PUMP_IPFS_ENDPOINT = 'https://pump.fun/api/ipfs';

/**
 * Normalise whatever an IPFS service hands back into a usable URI. PURE.
 *
 * ── A BARE CID IS THE COMMON FAILURE, AND IT LOOKS FINE ─────────────────────
 * Services variously return `Qm…`, `ipfs://Qm…`, or a full gateway URL. A bare
 * CID written into a mint resolves nowhere, and in a log line it is
 * indistinguishable from a working value — which is why buildTokenMetadata
 * refuses one and why this normalises rather than passing it through.
 *
 * `ipfs://` is preferred over a gateway URL: a gateway is one company's uptime,
 * and the pointer is permanent.
 */
export function normaliseIpfsUri(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'no URI returned' };
  const v = raw.trim();

  if (/^ipfs:\/\/.+/i.test(v)) return { ok: true, uri: v, cid: v.replace(/^ipfs:\/\//i, ''), form: 'ipfs' };
  if (/^ar:\/\/.+/i.test(v)) return { ok: true, uri: v, cid: v.replace(/^ar:\/\//i, ''), form: 'arweave' };

  const gateway = v.match(/^https?:\/\/[^/]+\/ipfs\/([A-Za-z0-9]+)/i);
  if (gateway) return { ok: true, uri: `ipfs://${gateway[1]}`, cid: gateway[1], form: 'gateway', original: v };

  // A plain https URL that is not a gateway is legitimate — Arweave and some
  // hosts serve metadata directly — so it is kept rather than rewritten.
  if (/^https?:\/\/.+/i.test(v)) return { ok: true, uri: v, cid: null, form: 'http' };

  // CIDv0 starts Qm and is 46 chars; CIDv1 starts b and is longer. Anything
  // else is not an identifier that can be turned into a pointer.
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/.test(v)) {
    return { ok: true, uri: `ipfs://${v}`, cid: v, form: 'bare-cid' };
  }
  return { ok: false, error: `unrecognised URI or CID: "${v.slice(0, 48)}"` };
}

/**
 * Upload metadata JSON and return a validated URI.
 *
 * ── UNVERIFIED RESPONSE SHAPE, AND SAID SO ──────────────────────────────────
 * The endpoint is live — it answers HTTP 500 to an empty body rather than 404 —
 * but its SUCCESS shape has not been confirmed here, because confirming it means
 * publishing content to IPFS, which is permanent and not a thing to do while
 * testing. The parser therefore accepts several plausible field names, and any
 * failure returns ok:false rather than a guessed URI.
 *
 * Re-check against a real response before this is load-bearing. The cost of
 * being wrong is a mint pointing at nothing, forever.
 */
export async function uploadMetadataToIPFS({
  metadata,
  endpoint = PUMP_IPFS_ENDPOINT,
  fetchImpl = fetch,
  timeoutMs = 20_000,
} = {}) {
  if (!metadata || typeof metadata !== 'object') return { ok: false, error: 'no metadata' };
  for (const field of ['name', 'symbol', 'image']) {
    if (!metadata[field]) return { ok: false, error: `metadata.${field} is required — run buildTokenMetadata first` };
  }

  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };

  // Guards the HTML case: a docs or error page arrives as a 200, and JSON.parse
  // would throw where the caller expects a result object.
  const ctype = res.headers?.get?.('content-type') ?? '';
  if (ctype && !ctype.includes('json')) return { ok: false, error: `expected JSON, got ${ctype.split(';')[0]}` };

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: 'response was not JSON' };
  }

  const raw =
    body?.metadataUri ?? body?.metadata_uri ?? body?.uri ?? body?.url ?? body?.IpfsHash ?? body?.cid ?? null;
  const norm = normaliseIpfsUri(raw);
  if (!norm.ok) return { ok: false, error: `could not read a URI from the response: ${norm.error}` };

  return { ok: true, uri: norm.uri, cid: norm.cid, form: norm.form, raw: body };
}

/**
 * Assemble the ordered legs of a Block-0 deployment. PURE apart from PDA work.
 *
 * ── ORDER IS SEMANTIC, NOT COSMETIC ─────────────────────────────────────────
 * Jito executes a bundle in the order given and reverts the whole thing if any
 * leg fails. `create` must therefore come first: a buy against a bonding curve
 * that does not exist yet fails, and takes the create down with it.
 *
 * ── WHAT A BUNDLE DOES AND DOES NOT BUY ─────────────────────────────────────
 * Atomicity across N transactions in one slot. With a SINGLE transaction that
 * property already exists — atomicity is what a transaction IS — so a one-leg
 * bundle buys auction priority and nothing else. Reported as `atomicityUseful`
 * so a caller can see whether the tip is doing any work.
 *
 * Transactions are not built here. Phase 2 has no signer by design, so this
 * returns the PLAN; pass `transactions` once they exist and the Jito payload is
 * assembled from them.
 */
export function assembleDeployBundle({
  name,
  symbol,
  description = '',
  imageUri,
  txInPct,
  buySol = 0,
  jitoTip = 0,
  mint = null,
  creatorWallet = null,
  transactions = null,
} = {}) {
  const meta = buildTokenMetadata({ name, symbol, description, imageUri });
  if (!meta.ok) return { ok: false, error: 'metadata invalid', errors: meta.errors };

  const alloc = calculateTxInAllocation({ txInPct });
  if (!alloc.ok) return { ok: false, error: alloc.error };

  if (!Number.isFinite(buySol) || buySol < 0) return { ok: false, error: `buySol ${buySol} is not a SOL amount` };
  if (!Number.isFinite(jitoTip) || jitoTip < 0) return { ok: false, error: `jitoTip ${jitoTip} is not a SOL amount` };

  const pdas = mint ? derivePumpFunPDAs(mint) : null;
  if (mint && !pdas.ok) return { ok: false, error: pdas.error };

  // Order is the contract: create, then allocation, then buy.
  const legs = [{ index: 0, kind: 'create', description: `mint ${symbol} and open the bonding curve` }];
  if (alloc.allocationBase > 0) {
    legs.push({
      index: legs.length,
      kind: 'creator-allocation',
      description: `${alloc.pct}% (${alloc.allocationTokens.toLocaleString('en-US')} tokens) to the disclosed creator wallet`,
      costSol: 0,
      wallet: creatorWallet,
    });
  }
  if (buySol > 0) {
    legs.push({ index: legs.length, kind: 'creator-buy', description: `${buySol} SOL initial buy`, costSol: buySol });
  }

  if (legs.length > JITO_MAX_BUNDLE_SIZE) {
    return { ok: false, error: `${legs.length} legs exceeds the ${JITO_MAX_BUNDLE_SIZE}-transaction bundle limit` };
  }

  const warnings = [];
  if (jitoTip > 0 && legs.length === 1) {
    warnings.push('a one-leg bundle buys auction priority, not atomicity — a single transaction is already atomic');
  }
  const spend = buySol + jitoTip;
  if (jitoTip > 0 && spend > 0 && jitoTip / spend > 0.2) {
    warnings.push(`the tip is ${((jitoTip / spend) * 100).toFixed(0)}% of what this deploy spends`);
  }

  const plan = {
    ok: true,
    legs,
    legCount: legs.length,
    // False for a single leg: there is nothing to be atomic ACROSS.
    atomicityUseful: legs.length > 1,
    metadata: meta.metadata,
    allocation: alloc,
    mint,
    pdas: pdas?.ok ? pdas : null,
    creatorWallet,
    buySol,
    jitoTipSol: jitoTip,
    jitoTipLamports: Math.round(jitoTip * LAMPORTS),
    // The creator's own outlay. The allocation is minted supply and costs zero,
    // so it is deliberately not part of this sum.
    totalSpendSol: spend,
    warnings,
  };

  if (!transactions) {
    return { ...plan, bundle: null, note: 'no transactions supplied — plan only, nothing to submit' };
  }
  if (transactions.length !== legs.length) {
    return { ...plan, ok: false, error: `${transactions.length} transactions for ${legs.length} legs — they pair by index` };
  }
  const bundle = buildJitoBundle(transactions);
  if (!bundle.ok) return { ...plan, ok: false, error: bundle.error };
  return { ...plan, bundle };
}
