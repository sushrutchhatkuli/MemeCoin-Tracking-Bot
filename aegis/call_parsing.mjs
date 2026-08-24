/**
 * Pure parsers for channel-posted token calls.
 *
 * Shared by telegram_listener.mjs (forward: audit what a channel posts from now
 * on) and review_channel.mjs (backward: grade what it already posted).
 *
 * ── WHY THIS FILE EXISTS AS ITS OWN MODULE ──────────────────────────────────
 * These functions lived in telegram_listener.mjs, and review_channel.mjs
 * imported them from there. That produced a genuine deadlock rather than a
 * style complaint: the listener's `--review` flag dynamically imports
 * review_channel from inside a TOP-LEVEL await, review_channel imports the
 * listener, and the listener cannot finish evaluating until the await settles —
 * which it never does, because the await is waiting on a module that is waiting
 * on the listener. Node reports it as:
 *
 *     Warning: Detected unsettled top-level await
 *
 * and the process exits silently having done nothing. Two entry points sharing
 * a leaf module cannot form that cycle, which is the whole reason for the split.
 *
 * Everything here is pure and dependency-free, so it is also the part that can
 * be tested without a network, a Telegram session, or GramJS installed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * A MAXIMAL base58 run of mint length. Solana's alphabet excludes 0, O, I and
 * l, which is what makes this narrower than it looks.
 *
 * The boundary assertions are load-bearing, not decoration. Without them the
 * bare `{32,44}` is greedy and will happily carve an 88-character transaction
 * signature into TWO false 44-character "mints" — and signature links are
 * exactly what trending channels post all day. Requiring the run to be
 * unbordered by further base58 characters means an over-long run matches
 * nothing at all, which is the correct answer for a signature.
 */
const BASE58_RUN =
  /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

/**
 * Addresses that match the shape but are never a tradeable mint. Without this
 * the listener re-audits wrapped SOL and the token program every time a channel
 * mentions them, which is constantly.
 */
export const NON_MINT_ADDRESSES = new Set([
  'So11111111111111111111111111111111111111112', // wrapped SOL
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL token program
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // token-2022
  '11111111111111111111111111111111', // system program
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // associated token program
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  '4ckmDgGdxQoPDLUkDT3vHgSAkzA3QRdNq5ywwY4sUSJn',
]);

/**
 * Pull candidate Solana mints out of arbitrary message text.
 *
 * Deliberately permissive on shape and strict on nothing else: this cannot tell
 * a mint from a wallet or a pool address, and it does not try. The DexScreener
 * lookup downstream is the real filter — if no tradeable pair exists for an
 * address, it is dropped there. Guessing here would only add a way to be wrong.
 *
 * Signatures are 87-88 base58 characters, so they fall outside the 32-44 window
 * naturally rather than by special-casing.
 */
export function extractMints(text) {
  if (!text || typeof text !== 'string') return [];
  const seen = new Set();
  for (const match of text.matchAll(BASE58_RUN)) {
    const addr = match[0];
    if (NON_MINT_ADDRESSES.has(addr)) continue;
    // pump.fun mints end in "pump" and are the common case; no filtering on
    // that, it is just the reason the length window matters more than a suffix.
    if (addr.length < 32 || addr.length > 44) continue;
    seen.add(addr);
  }
  return [...seen];
}

const MULTIPLIER_RE = /(\d+(?:\.\d+)?)\s*[xX](?![a-zA-Z0-9])/;
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9_]{1,14})\b/;

/**
 * Pull {multiplier, address, symbol} rows out of a channel recap post.
 *
 * ── WHY ASSOCIATION IS LINE-SCOPED ──────────────────────────────────────────
 * A recap lists several tokens with several multipliers. The only thing that
 * ties a given "42X" to a given contract is layout, so a multiplier and an
 * address are paired ONLY when they appear in the same line.
 *
 * That is deliberately strict, and it is the single most important decision in
 * this parser. A greedy pairing — nearest address, or first address after the
 * number — silently mis-attributes when a channel puts the address on the line
 * below, and a mis-attribution here is not cosmetic: it awards alpha points
 * worth `multiplier * 2.5` to the early buyers of the WRONG token, and marks
 * them permanently protected. A missed row costs nothing by comparison, so
 * unpaired multipliers are counted and reported rather than guessed at.
 *
 * ── AND WHY THE NUMBERS DESERVE SUSPICION ───────────────────────────────────
 * Recap posts are marketing. Channels publish their winners and quietly omit
 * their losers, so a multiplier scraped from one is a claim by an interested
 * party, not a measurement. Nothing downstream should treat it as verified —
 * the multiplier is applied to WEIGHTING, never to a safety gate, and the
 * forward-scoring in post_mortem is what eventually tests whether the wallets
 * it surfaced are actually any good.
 */
export function parseMultiplierRecap(text, { minMultiplier = 2 } = {}) {
  if (!text || typeof text !== 'string') return { rows: [], unpaired: 0, lines: 0 };

  const rows = [];
  const seen = new Set();
  let unpaired = 0;
  let lines = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    lines++;

    const m = line.match(MULTIPLIER_RE);
    if (!m) continue;
    const multiplier = Number(m[1]);
    if (!Number.isFinite(multiplier) || multiplier < minMultiplier) continue;

    const addresses = extractMints(line);
    if (addresses.length !== 1) {
      // Zero addresses: the contract is elsewhere and pairing would be a guess.
      // Several: which one earned the 42X is genuinely unknowable from layout.
      unpaired++;
      continue;
    }

    const address = addresses[0];
    if (seen.has(address)) continue;
    seen.add(address);

    rows.push({
      multiplier,
      address,
      symbol: (line.match(TICKER_RE) ?? [])[1] ?? null,
      line: line.slice(0, 120),
    });
  }

  return { rows, unpaired, lines };
}

/** First $TICKER in a post, or null. PURE. */
export function parseTicker(text) {
  return (String(text ?? '').match(TICKER_RE) ?? [])[1] ?? null;
}
