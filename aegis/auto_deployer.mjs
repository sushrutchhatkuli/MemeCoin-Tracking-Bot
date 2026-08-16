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
import { base58Decode, base58Encode } from './live_execute.mjs';

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
