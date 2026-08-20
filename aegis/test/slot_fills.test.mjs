import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Phase 6 — slot-latency fills.
 *
 * Everything here is pure or driven through an injected RPC, so the
 * reconstruction can be checked against transaction shapes written down once
 * rather than fetched. The shapes match what `getTransaction` returns with
 * `encoding: 'jsonParsed'`, which is what the engine actually reads.
 */
const PC = () => import('../paper_copytrade.mjs');
const DASH = () => import('../dashboard.mjs');

const WSOL = 'So11111111111111111111111111111111111111112';
const MINT = 'MINTaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * A swap transaction, from the fee payer's point of view.
 * `sol` is signed: negative spends (a buy), positive receives (a sell).
 */
function swapTx({ slot, payer = 'TRADER', sol, tokens, mint = MINT, sig = `sig${slot}`, err = null } = {}) {
  const solBefore = 100e9;
  return {
    slot,
    blockTime: 1_700_000_000 + slot,
    transaction: {
      signatures: [sig],
      message: { accountKeys: [payer, 'OTHER', mint] },
    },
    meta: {
      err,
      preBalances: [solBefore, 0, 0],
      postBalances: [solBefore + sol * 1e9, 0, 0],
      preTokenBalances: tokens > 0 ? [] : [{ accountIndex: 0, owner: payer, mint, uiTokenAmount: { uiAmount: Math.abs(tokens) } }],
      postTokenBalances: tokens > 0 ? [{ accountIndex: 0, owner: payer, mint, uiTokenAmount: { uiAmount: tokens } }] : [],
    },
  };
}

/** A rising market: price per token climbs each slot. */
function risingWindow(whaleSlot, { solUsd = 100 } = {}) {
  // 1 SOL for N tokens; fewer tokens per SOL each slot = rising price.
  return [
    swapTx({ slot: whaleSlot + 0, sol: -1, tokens: 1000 }),   // $0.10
    swapTx({ slot: whaleSlot + 3, sol: -1, tokens: 800 }),    // $0.125
    swapTx({ slot: whaleSlot + 5, sol: -1, tokens: 500 }),    // $0.20
    swapTx({ slot: whaleSlot + 10, sol: -1, tokens: 400 }),   // $0.25
  ];
}

/* ------------------------------------------------------------------ *
 * 1. Decoding one swap
 * ------------------------------------------------------------------ */

test('a swap decodes to the price it actually executed at, from the fee payer', async () => {
  const { decodeSwapAtSlot } = await PC();

  // 2 SOL for 4,000 tokens at $100/SOL = $0.05 per token.
  const buy = decodeSwapAtSlot(swapTx({ slot: 500, sol: -2, tokens: 4000 }), { mint: MINT, solUsd: 100 });
  assert.equal(buy.kind, 'BUY');
  assert.equal(buy.slot, 500);
  assert.equal(buy.swapper, 'TRADER', 'the fee payer is taken as the swapper');
  assert.ok(Math.abs(buy.priceUsd - 0.05) < 1e-12);

  // A sell prices the same way — SOL received over tokens given up.
  const sell = decodeSwapAtSlot(swapTx({ slot: 501, sol: +3, tokens: -1000 }), { mint: MINT, solUsd: 100 });
  assert.equal(sell.kind, 'SELL');
  assert.ok(Math.abs(sell.priceUsd - 0.3) < 1e-12);
});

test('a swap that cannot be attributed is declined rather than guessed at', async () => {
  const { decodeSwapAtSlot } = await PC();
  const opts = { mint: MINT, solUsd: 100 };

  // Failed transactions moved nothing.
  assert.equal(decodeSwapAtSlot(swapTx({ slot: 1, sol: -1, tokens: 100, err: { InstructionError: [] } }), opts), null);
  // A different token's swap is not this token's price.
  assert.equal(decodeSwapAtSlot(swapTx({ slot: 1, sol: -1, tokens: 100, mint: 'OTHERMINT' }), opts), null);
  // Without a SOL price there is no USD to quote, and a guessed rate would
  // mis-state every fill downstream.
  assert.equal(decodeSwapAtSlot(swapTx({ slot: 1, sol: -1, tokens: 100 }), { mint: MINT, solUsd: null }), null);

  // DUST. Dividing two tiny numbers is noise, not a price — the same reason
  // impliedEntryPriceUsd carries minSpendSol.
  assert.equal(decodeSwapAtSlot(swapTx({ slot: 1, sol: -0.0001, tokens: 5 }), opts), null);
  // ...and the floor is a threshold, not a blanket refusal.
  assert.ok(decodeSwapAtSlot(swapTx({ slot: 1, sol: -0.5, tokens: 5 }), opts));

  for (const bad of [null, undefined, {}]) assert.equal(decodeSwapAtSlot(bad, opts), null);
});

test('parseWalletSwap now carries the slot, because a window is counted from it', async () => {
  const { parseWalletSwap } = await PC();
  const t = parseWalletSwap(swapTx({ slot: 4242, sol: -1, tokens: 1000, payer: 'W' }), { wallet: 'W' });
  assert.equal(t.slot, 4242);
  // Absent rather than invented when the RPC shape has no slot.
  const noSlot = swapTx({ slot: 1, sol: -1, tokens: 1000, payer: 'W' });
  delete noSlot.slot;
  assert.equal(parseWalletSwap(noSlot, { wallet: 'W' }).slot, null);
});

/* ------------------------------------------------------------------ *
 * 2. Price at a slot — the carry-forward is disclosed
 * ------------------------------------------------------------------ */

test('the price at a slot is the last trade at or before it, and says how stale that is', async () => {
  const { reconstructPriceAtSlot, decodeSwapAtSlot } = await PC();
  const swaps = risingWindow(1000).map((tx) => decodeSwapAtSlot(tx, { mint: MINT, solUsd: 100 }));

  // A slot with a trade in it.
  const exact = reconstructPriceAtSlot(swaps, 1005);
  assert.ok(Math.abs(exact.priceUsd - 0.2) < 1e-12);
  assert.equal(exact.exact, true);
  assert.equal(exact.staleSlots, 0);

  // MOST SLOTS HAVE NO TRADE. The price is carried forward, and the carry is
  // reported rather than smoothed over — 40 slots stale is a much weaker claim
  // than 1, and only the caller can decide whether that is good enough.
  const carried = reconstructPriceAtSlot(swaps, 1008);
  assert.ok(Math.abs(carried.priceUsd - 0.2) < 1e-12, 'still the slot-1005 price');
  assert.equal(carried.exact, false);
  assert.equal(carried.staleSlots, 3);
  assert.equal(carried.sourceSlot, 1005);

  // Nothing at or before the slot is null, not zero and not the next trade.
  assert.equal(reconstructPriceAtSlot(swaps, 999), null);
  assert.equal(reconstructPriceAtSlot([], 1005), null);
  assert.equal(reconstructPriceAtSlot(swaps, NaN), null);
});

test('a later slot never borrows a price from the future', async () => {
  const { reconstructPriceAtSlot, decodeSwapAtSlot } = await PC();
  const swaps = risingWindow(1000).map((tx) => decodeSwapAtSlot(tx, { mint: MINT, solUsd: 100 }));

  // The whole point: at N+3 we must not see the N+5 price. That would be
  // hindsight, and on a rising token it flatters the entry.
  assert.ok(Math.abs(reconstructPriceAtSlot(swaps, 1003).priceUsd - 0.125) < 1e-12);
  assert.ok(Math.abs(reconstructPriceAtSlot(swaps, 1004).priceUsd - 0.125) < 1e-12);
});

/* ------------------------------------------------------------------ *
 * 3. The band
 * ------------------------------------------------------------------ */

test('the band prices three rungs and trades on the expected one', async () => {
  const { buildExecutionBand, decodeSwapAtSlot, DEFAULT_SLOT_OFFSETS, SLOT_MS } = await PC();
  const swaps = risingWindow(1000).map((tx) => decodeSwapAtSlot(tx, { mint: MINT, solUsd: 100 }));

  const band = buildExecutionBand({ swaps, whaleSlot: 1000, side: 'BUY', maxObservedSlot: 1020 });

  assert.equal(band.reconstructed, true);
  assert.deepStrictEqual(DEFAULT_SLOT_OFFSETS, { earliest: 3, expected: 5, latest: 10 });

  assert.ok(Math.abs(band.rungs.earliest.priceUsd - 0.125) < 1e-12);
  assert.ok(Math.abs(band.rungs.expected.priceUsd - 0.2) < 1e-12);
  assert.ok(Math.abs(band.rungs.latest.priceUsd - 0.25) < 1e-12);

  // ONE number to act on. Three books would invite picking the flattering one.
  assert.ok(Math.abs(band.fillPriceUsd - 0.2) < 1e-12);
  assert.equal(band.fillSlot, 1005);
  assert.equal(band.fillSlotOffset, 5);
  assert.equal(band.fillLagMs, 5 * SLOT_MS);
  assert.equal(band.windowComplete, true);

  // 0.125 -> 0.25 is a 100% spread across the window.
  assert.ok(Math.abs(band.spreadPct - 100) < 1e-9);
});

test('"earliest" is not "best" — the draft conflated them and a dumping token proves it', async () => {
  const { buildExecutionBand, decodeSwapAtSlot } = await PC();

  // A FALLING token: more tokens per SOL each slot = price dropping.
  const falling = [
    swapTx({ slot: 200, sol: -1, tokens: 400 }),    // $0.25
    swapTx({ slot: 203, sol: -1, tokens: 500 }),    // $0.20
    swapTx({ slot: 205, sol: -1, tokens: 800 }),    // $0.125
    swapTx({ slot: 210, sol: -1, tokens: 1000 }),   // $0.10
  ].map((tx) => decodeSwapAtSlot(tx, { mint: MINT, solUsd: 100 }));

  const band = buildExecutionBand({ swaps: falling, whaleSlot: 200, side: 'BUY' });

  // The EARLIEST reachable slot is the most expensive entry here. Calling N+3
  // the "best case" would have been wrong on every token that dumped.
  assert.ok(Math.abs(band.rungs.earliest.priceUsd - 0.2) < 1e-12);
  assert.ok(Math.abs(band.bestCaseUsd - 0.1) < 1e-12, 'a buy wants the LOW price, whenever it occurred');
  assert.ok(Math.abs(band.worstCaseUsd - 0.2) < 1e-12);

  // And the direction matters: a seller wants the opposite end.
  const sell = buildExecutionBand({ swaps: falling, whaleSlot: 200, side: 'SELL' });
  assert.ok(Math.abs(sell.bestCaseUsd - 0.2) < 1e-12);
  assert.ok(Math.abs(sell.worstCaseUsd - 0.1) < 1e-12);
});

test('an unanswerable window reconstructs nothing instead of inventing a fill', async () => {
  const { buildExecutionBand } = await PC();

  const empty = buildExecutionBand({ swaps: [], whaleSlot: 1000 });
  assert.equal(empty.reconstructed, false);
  assert.equal(empty.fillPriceUsd, null, 'no price means no price');
  assert.match(empty.reason, /no swaps decoded/);

  // Swaps exist, but all of them AFTER the expected slot — so there is still
  // nothing we could have filled against at N+5.
  const { decodeSwapAtSlot } = await PC();
  const late = [swapTx({ slot: 1009, sol: -1, tokens: 500 })].map((t) => decodeSwapAtSlot(t, { mint: MINT, solUsd: 100 }));
  const band = buildExecutionBand({ swaps: late, whaleSlot: 1000 });
  assert.equal(band.reconstructed, false);
  assert.match(band.reason, /nothing traded at or before/);

  assert.equal(buildExecutionBand({ swaps: [], whaleSlot: null }).reconstructed, false);
});

test('an incomplete window is flagged, because its spread is understated', async () => {
  const { buildExecutionBand, decodeSwapAtSlot } = await PC();
  const swaps = risingWindow(1000).map((tx) => decodeSwapAtSlot(tx, { mint: MINT, solUsd: 100 }));

  // The chain has only reached slot 1007: N+10 has not happened yet, so the
  // late rung is a carry-forward and the band looks tighter than it is.
  const partial = buildExecutionBand({ swaps, whaleSlot: 1000, maxObservedSlot: 1007 });
  assert.equal(partial.windowComplete, false);

  assert.equal(buildExecutionBand({ swaps, whaleSlot: 1000, maxObservedSlot: 1010 }).windowComplete, true);
  assert.equal(buildExecutionBand({ swaps, whaleSlot: 1000 }).windowComplete, null, 'unknown is not false');
});

test('the band carries its own assumption, so no renderer has to remember it', async () => {
  const { buildExecutionBand, decodeSwapAtSlot } = await PC();
  const swaps = risingWindow(1000).map((tx) => decodeSwapAtSlot(tx, { mint: MINT, solUsd: 100 }));
  const band = buildExecutionBand({ swaps, whaleSlot: 1000 });
  assert.match(band.assumption, /never sent a transaction/);
});

/* ------------------------------------------------------------------ *
 * 4. Fetching the window
 * ------------------------------------------------------------------ */

/** An RPC stub: a signature page, then the transactions behind it. */
function stubRpc({ page, txs, failSignatures = false }) {
  const calls = { getSignaturesForAddress: 0, getTransaction: 0 };
  const impl = async (_url, method, params) => {
    if (method === 'getSignaturesForAddress') {
      calls.getSignaturesForAddress++;
      return failSignatures ? { ok: false, error: 'HTTP 429 (rate limited)' } : { ok: true, result: page };
    }
    calls.getTransaction++;
    return { ok: true, result: txs[params[0]] ?? null };
  };
  return { impl, calls };
}

test('only signatures inside the window are read, and only successful ones', async () => {
  const { fetchSlotWindowSwaps } = await PC();

  const page = [
    { signature: 'after', slot: 1050 },                 // past the window
    { signature: 'sig1010', slot: 1010 },
    { signature: 'sig1005', slot: 1005 },
    { signature: 'failed', slot: 1004, err: { X: 1 } }, // failed: moved nothing
    { signature: 'sig1003', slot: 1003 },
    { signature: 'before', slot: 999 },                 // before the whale
  ];
  const txs = {
    sig1003: swapTx({ slot: 1003, sol: -1, tokens: 800, sig: 'sig1003' }),
    sig1005: swapTx({ slot: 1005, sol: -1, tokens: 500, sig: 'sig1005' }),
    sig1010: swapTx({ slot: 1010, sol: -1, tokens: 400, sig: 'sig1010' }),
  };
  const { impl, calls } = stubRpc({ page, txs });

  const res = await fetchSlotWindowSwaps({
    mint: MINT, whaleSlot: 1000, rpcImpl: impl, solUsd: 100, delayMs: 0,
  });

  assert.equal(res.ok, true);
  assert.equal(res.scanned, 3, 'the failed, the early and the late signature are all skipped');
  assert.equal(calls.getTransaction, 3, 'and skipped signatures cost no lookup');
  assert.deepStrictEqual(res.swaps.map((s) => s.slot), [1003, 1005, 1010], 'ascending, so carry-forward works');

  // Read off the newest signature on the page rather than a second getSlot.
  assert.equal(res.maxObservedSlot, 1050);
  assert.equal(calls.getSignaturesForAddress, 1);
});

test('the lookup budget is enforced, and what it skipped is reported', async () => {
  const { fetchSlotWindowSwaps } = await PC();

  const page = Array.from({ length: 30 }, (_, i) => ({ signature: `s${i}`, slot: 1000 + (i % 10) }));
  const txs = Object.fromEntries(page.map((p) => [p.signature, swapTx({ slot: p.slot, sol: -1, tokens: 500, sig: p.signature })]));
  const { impl, calls } = stubRpc({ page, txs });

  const res = await fetchSlotWindowSwaps({
    mint: MINT, whaleSlot: 1000, rpcImpl: impl, solUsd: 100, delayMs: 0, maxLookups: 8,
  });

  // A busy token must not become an unbounded bill.
  assert.equal(calls.getTransaction, 8);
  assert.equal(res.scanned, 8);
  assert.equal(res.skipped, 22, 'the shortfall is stated, not hidden');
});

test('an RPC failure returns an outcome, and the tick falls back', async () => {
  const { fetchSlotWindowSwaps, resolveExecutionBand } = await PC();

  const { impl } = stubRpc({ page: [], txs: {}, failSignatures: true });
  const res = await fetchSlotWindowSwaps({ mint: MINT, whaleSlot: 1000, rpcImpl: impl, solUsd: 100, delayMs: 0 });
  assert.equal(res.ok, false);
  assert.match(res.error, /rate limited/);
  assert.deepStrictEqual(res.swaps, []);

  const band = await resolveExecutionBand({
    mint: MINT, whaleSlot: 1000, solUsd: 100,
    fetcher: async () => ({ ok: false, error: 'window unavailable', swaps: [] }),
  });
  assert.equal(band.reconstructed, false);
  assert.equal(band.fillPriceUsd, null);

  // Missing inputs are outcomes too, not throws.
  assert.equal((await fetchSlotWindowSwaps({ mint: MINT, whaleSlot: null, rpcImpl: impl })).ok, false);
  assert.equal((await fetchSlotWindowSwaps({ mint: MINT, whaleSlot: 1, rpcImpl: impl, solUsd: null })).ok, false);
});

/* ------------------------------------------------------------------ *
 * 5. Fee integrity — one source, not two
 * ------------------------------------------------------------------ */

test('slot fills add no second fee: feeSol stays the only per-trade charge', async () => {
  const { PAPER_DEFAULTS, createBook, openPaperPosition, paperConfig } = await PC();

  assert.equal(PAPER_DEFAULTS.feeSol, 0.0006, 'the existing per-trade fee is unchanged');
  // The draft proposed adding a 0.001 tip + 0.000005 gas ON TOP. That would
  // charge every round trip twice, so no such constant exists.
  for (const k of Object.keys(PAPER_DEFAULTS)) {
    assert.ok(!/jito|tip|gasSol/i.test(k), `${k} looks like a second fee lever`);
  }

  // And the balance arithmetic is untouched by the phase: size + feeSol, once.
  const cfg = paperConfig({ budgetSol: 100, perTradeSol: 2, pctWhale: null, slippagePct: 0 });
  const book = createBook({ budgetSol: 100 });
  openPaperPosition(book, { mint: 'M', priceUsd: 1, cfg, now: 0, poolSolReserve: 1000 });
  assert.ok(Math.abs(book.balanceSol - (100 - 2 - PAPER_DEFAULTS.feeSol)) < 1e-12);
});

test('slot fills are off by default, because the window costs RPC that the old path did not', async () => {
  const { PAPER_DEFAULTS } = await PC();
  assert.equal(PAPER_DEFAULTS.slotFills, false);
  assert.deepStrictEqual(PAPER_DEFAULTS.slotOffsets, { earliest: 3, expected: 5, latest: 10 });
  assert.equal(PAPER_DEFAULTS.slotFillMaxLookups, 40);
});

/* ------------------------------------------------------------------ *
 * 6. The dashboard payload
 * ------------------------------------------------------------------ */

test('an unreconstructed band reaches the page as null, not as a fill', async () => {
  const { summariseBand } = await DASH();

  // "We could not price this at the slot we would have landed in" and "we
  // filled here" are different claims. Only one belongs on a card.
  assert.equal(summariseBand(null), null);
  assert.equal(summariseBand(undefined), null);
  assert.equal(summariseBand({ reconstructed: false, fillPriceUsd: 0.2 }), null);
});

test('the band summary keeps every number a reader needs to judge the fill', async () => {
  const { summariseBand } = await DASH();
  const { buildExecutionBand, decodeSwapAtSlot } = await PC();

  const swaps = risingWindow(1000).map((tx) => decodeSwapAtSlot(tx, { mint: MINT, solUsd: 100 }));
  const s = summariseBand(buildExecutionBand({ swaps, whaleSlot: 1000, maxObservedSlot: 1020 }));

  assert.ok(Math.abs(s.fillPriceUsd - 0.2) < 1e-12);
  assert.equal(s.fillSlotOffset, 5);
  assert.equal(s.fillLagMs, 2000);
  assert.ok(Math.abs(s.spreadPct - 100) < 1e-9);
  assert.equal(s.windowComplete, true);
  assert.equal(s.rungs.earliest.slotOffset, 3);
  assert.equal(s.rungs.expected.exact, true);
  assert.equal(s.rungs.latest.slotOffset, 10);

  // The uncertainty travels WITH the number rather than relying on a renderer.
  assert.match(s.assumption, /never sent a transaction/);

  // Survives the wire.
  const wire = JSON.parse(JSON.stringify(s));
  assert.equal(wire.assumption, s.assumption);
  assert.ok(Math.abs(wire.fillPriceUsd - 0.2) < 1e-12);
});

test('a banded position warns that its landing slot was assumed', async () => {
  const { buildDashboardState } = await DASH();
  const { buildExecutionBand, decodeSwapAtSlot, createBook, openPaperPosition, paperConfig } = await PC();

  const cfg = paperConfig({ budgetSol: 100, perTradeSol: 1, pctWhale: null, slotFills: true });
  const book = createBook({ budgetSol: 100 });
  openPaperPosition(book, { mint: MINT, symbol: 'TKN', priceUsd: 0.2, cfg, now: 1000, poolSolReserve: 500 });

  const swaps = risingWindow(1000).map((tx) => decodeSwapAtSlot(tx, { mint: MINT, solUsd: 100 }));
  book.positions[MINT].executionBand = buildExecutionBand({ swaps, whaleSlot: 1000, maxObservedSlot: 1020 });

  const state = buildDashboardState(book, cfg, { solUsd: 100, now: 2000 });

  assert.ok(state.positions[0].executionBand, 'the band reaches the card');
  assert.equal(state.mode.slotFills.enabled, true);
  assert.deepStrictEqual(state.mode.slotFills.offsets, { earliest: 3, expected: 5, latest: 10 });

  const warn = state.warnings.find((w) => w.code === 'ASSUMED_LANDING_SLOT');
  assert.ok(warn, 'a price built on an assumed landing slot has to say so');
  assert.match(warn.message, /never been measured/);
  assert.match(warn.message, /100\.0%/, 'and the widest spread is quoted');
});

test('a partial window is warned about separately, because it understates the spread', async () => {
  const { buildDashboardState } = await DASH();
  const { buildExecutionBand, decodeSwapAtSlot, createBook, openPaperPosition, paperConfig } = await PC();

  const cfg = paperConfig({ budgetSol: 100, perTradeSol: 1, pctWhale: null, slotFills: true });
  const book = createBook({ budgetSol: 100 });
  openPaperPosition(book, { mint: MINT, priceUsd: 0.2, cfg, now: 1000, poolSolReserve: 500 });

  const swaps = risingWindow(1000).map((tx) => decodeSwapAtSlot(tx, { mint: MINT, solUsd: 100 }));
  book.positions[MINT].executionBand = buildExecutionBand({ swaps, whaleSlot: 1000, maxObservedSlot: 1006 });

  const state = buildDashboardState(book, cfg, { solUsd: 100, now: 2000 });
  assert.equal(state.positions[0].executionBand.windowComplete, false);
  const warn = state.warnings.find((w) => w.code === 'PARTIAL_FILL_WINDOW');
  assert.ok(warn);
  assert.match(warn.message, /understated/);
});

test('with slot fills off, no band and no offsets are advertised', async () => {
  const { buildDashboardState } = await DASH();
  const { createBook, openPaperPosition, paperConfig } = await PC();

  const cfg = paperConfig({ budgetSol: 100, perTradeSol: 1, pctWhale: null });
  const book = createBook({ budgetSol: 100 });
  openPaperPosition(book, { mint: MINT, priceUsd: 0.2, cfg, now: 1000, poolSolReserve: 500 });

  const state = buildDashboardState(book, cfg, { solUsd: 100, now: 2000 });
  assert.equal(state.mode.slotFills.enabled, false);
  assert.equal(state.mode.slotFills.offsets, null);
  assert.equal(state.positions[0].executionBand, null);
  assert.equal(state.warnings.find((w) => w.code === 'ASSUMED_LANDING_SLOT'), undefined);
});

/* ------------------------------------------------------------------ *
 * 7. The tick
 * ------------------------------------------------------------------ */

test('the tick prices an entry from the reconstructed slot, not from the whale fill', async () => {
  const { runPaperTick, createBook, paperConfig, decodeSwapAtSlot } = await PC();

  const cfg = paperConfig({
    budgetSol: 100, perTradeSol: 1, pctWhale: null, slippagePct: 0, feeSol: 0,
    slotFills: true, liquidityModel: false, useImpliedEntry: true, copyImpactPct: 0,
  });
  const book = createBook({ budgetSol: 100 });
  book.target = { address: 'WHALE', since: 0 };

  // The whale bought 1000 tokens for 1 SOL at $100 => their fill was $0.10.
  const whaleTrade = {
    kind: 'BUY', mint: MINT, solSpent: 1, tokenDelta: 1000,
    signature: 'whalesig', blockTime: Date.now(), slot: 1000, wallet: 'WHALE',
  };

  const report = await runPaperTick({
    book,
    observations: [],
    watchlist: [{ address: 'WHALE', rank: 1 }],
    cfg,
    now: Date.now(),
    solUsd: 100,
    // The real reconstruction runs; only the chain read is stubbed.
    slotSwapFetcher: async ({ whaleSlot }) => ({
      ok: true,
      swaps: risingWindow(whaleSlot).map((t) => decodeSwapAtSlot(t, { mint: MINT, solUsd: 100 })),
      maxObservedSlot: whaleSlot + 20,
      scanned: 4,
      skipped: 0,
    }),
    tradeFetcher: async () => ({ ok: true, trades: [whaleTrade], newestSignature: 'whalesig' }),
    priceFetcher: async () => new Map([[MINT, { priceUsd: 0.1, symbol: 'TKN' }]]),
  });

  assert.equal(report.opened.length, 1, 'the buy was mirrored');
  const pos = book.positions[MINT];

  // By N+5 the token had run to $0.20. We could not have filled at the whale's
  // $0.10 — that is the moment the whole model exists to stop pricing us at.
  assert.ok(Math.abs(pos.entryPriceUsd - 0.2) < 1e-9, `entered at ${pos.entryPriceUsd}, expected the N+5 price`);
  assert.ok(pos.executionBand, 'and the uncertainty is recorded on the position');
  assert.equal(pos.executionBand.fillSlotOffset, 5);
  assert.equal(report.slotFills.reconstructed, 1);
});

test('when the chain cannot answer, the tick falls back and says how often', async () => {
  const { runPaperTick, createBook, paperConfig } = await PC();

  const cfg = paperConfig({
    budgetSol: 100, perTradeSol: 1, pctWhale: null, slippagePct: 0, feeSol: 0,
    slotFills: true, liquidityModel: false, useImpliedEntry: true, copyImpactPct: 0,
  });
  const book = createBook({ budgetSol: 100 });
  book.target = { address: 'WHALE', since: 0 };

  const report = await runPaperTick({
    book,
    observations: [],
    watchlist: [{ address: 'WHALE', rank: 1 }],
    cfg,
    now: Date.now(),
    solUsd: 100,
    // The chain answered, but nothing traded in the window.
    slotSwapFetcher: async () => ({ ok: true, swaps: [], maxObservedSlot: 1020, scanned: 0, skipped: 0 }),
    tradeFetcher: async () => ({
      ok: true,
      trades: [{ kind: 'BUY', mint: MINT, solSpent: 1, tokenDelta: 1000, signature: 's', blockTime: Date.now(), slot: 1000, wallet: 'WHALE' }],
      newestSignature: 's',
    }),
    priceFetcher: async () => new Map([[MINT, { priceUsd: 0.1, symbol: 'TKN' }]]),
  });

  // The position still opens — at the old implied price, which is the
  // documented fallback rather than a refusal to trade.
  assert.equal(report.opened.length, 1);
  assert.ok(Math.abs(book.positions[MINT].entryPriceUsd - 0.1) < 1e-9);
  assert.equal(book.positions[MINT].executionBand, undefined, 'no band means no band');
  assert.equal(report.slotFills.failed, 1);
  assert.ok(report.slotFills.reasons.length, 'and the reason is kept, not swallowed');
});

test('with slot fills off the tick makes no extra RPC call at all', async () => {
  const { runPaperTick, createBook, paperConfig } = await PC();

  const cfg = paperConfig({
    budgetSol: 100, perTradeSol: 1, pctWhale: null, slippagePct: 0, feeSol: 0,
    slotFills: false, liquidityModel: false, useImpliedEntry: true, copyImpactPct: 0,
  });
  const book = createBook({ budgetSol: 100 });
  book.target = { address: 'WHALE', since: 0 };

  let windowReads = 0;
  const report = await runPaperTick({
    book,
    observations: [],
    watchlist: [{ address: 'WHALE', rank: 1 }],
    cfg,
    now: Date.now(),
    solUsd: 100,
    slotSwapFetcher: async () => {
      windowReads++;
      return { ok: true, swaps: [], maxObservedSlot: 1020 };
    },
    tradeFetcher: async () => ({
      ok: true,
      trades: [{ kind: 'BUY', mint: MINT, solSpent: 1, tokenDelta: 1000, signature: 's', blockTime: Date.now(), slot: 1000, wallet: 'WHALE' }],
      newestSignature: 's',
    }),
    priceFetcher: async () => new Map([[MINT, { priceUsd: 0.1, symbol: 'TKN' }]]),
  });

  // The zero-extra-RPC property of the implied path is what pays for slotFills
  // being opt-in. If this goes red, the default run started costing credits on
  // every mirrored trade.
  assert.equal(windowReads, 0, 'the window is never read when the feature is off');
  assert.equal(report.slotFills, undefined, 'and nothing is reported about it');
  assert.ok(Object.values(book.positions).every((p) => p.executionBand === undefined));
});
