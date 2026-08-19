import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The DEX liquidity model: pool depth, price impact, and the size cap.
 *
 * Everything here is pure or driven through an injected fetcher — no network,
 * so the arithmetic can be checked against payload shapes that were measured
 * once and written down rather than re-fetched.
 */
const PC = () => import('../paper_copytrade.mjs');

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/* ------------------------------------------------------------------ *
 * The headline case: a whale-sized order into a pool that cannot take it
 * ------------------------------------------------------------------ */

test('a 500 SOL order into a 30 SOL pool is capped at 1.5 SOL and pays the drag', async () => {
  const { createBook, openPaperPosition, paperConfig } = await PC();

  // Slippage and fees off so the only cost left is depth. The spread is a
  // separate lever and mixing them here would make a failure ambiguous.
  const cfg = paperConfig({ budgetSol: 1000, perTradeSol: 500, slippagePct: 0, feeSol: 0 });
  const book = createBook({ budgetSol: 1000 });

  const res = openPaperPosition(book, { mint: 'THIN', priceUsd: 1, cfg, now: 0, poolSolReserve: 30 });

  // 5% of 30 SOL. Not 500, and not declined either — the trade still happens at
  // the size the pool can absorb.
  assert.equal(res.ok, true);
  assert.equal(res.sizeSol, 1.5);
  assert.equal(res.liquidityCapped, true);
  assert.equal(res.requestedSol, 500, 'what was asked for is kept, so the log can show both');
  assert.equal(res.maxPoolTradeSol, 1.5);

  // 1.5 / (30 + 1.5) = 4.7619%, charged on the CAPPED size: the 500 SOL order
  // never crossed the pool, so it cannot be billed for having moved it.
  assert.ok(Math.abs(res.impactPct - (1.5 / 31.5) * 100) < 1e-12);
  assert.ok(Math.abs(res.impactPct - 4.7619047619) < 1e-9);

  // The fill is mid / (1 - impact), which is identically mid x (1 + size/pool).
  assert.ok(Math.abs(res.position.entryPriceUsd - 1.05) < 1e-12, '$1.00 mid fills at $1.05');
  assert.equal(book.balanceSol, 998.5, 'only the capped size left the balance');

  // Written onto the position, because the exit happens on another tick and the
  // scorecard has to be able to total the round trip without replaying anything.
  assert.equal(book.positions.THIN.entryPoolSol, 30);
  assert.equal(book.positions.THIN.entryPoolMeasured, true);
  assert.ok(Math.abs(book.positions.THIN.entryImpactSol - 1.5 * 0.047619047619) < 1e-9);
});

test('the round trip through a thin pool costs both legs, at a flat price', async () => {
  const { createBook, openPaperPosition, applyPaperExit, paperConfig } = await PC();
  const cfg = paperConfig({ budgetSol: 1000, perTradeSol: 500, slippagePct: 0, feeSol: 0 });
  const book = createBook({ budgetSol: 1000 });

  openPaperPosition(book, { mint: 'THIN', priceUsd: 1, cfg, now: 0, poolSolReserve: 30 });
  const exit = applyPaperExit(book, 'THIN', {
    priceUsd: 1, trigger: 'HARD_STOP', sellFraction: 1, cfg, now: 1, poolSolReserve: 30,
  });

  // The position cost 1.5 SOL but is worth 1.5/1.05 = 1.42857 at the mid it was
  // marked to, and THAT is what crosses the pool on the way out.
  assert.ok(Math.abs(exit.impactPct - (1.42857142857 / 31.42857142857) * 100) < 1e-9);
  assert.ok(Math.abs(exit.proceedsSol - 1.3636363636) < 1e-9);

  // -9.09% on a token that never moved. That is the whole thesis of this model:
  // a paper book without it reports 0.00% here and calls it break-even.
  const pnl = book.balanceSol - 1000;
  assert.ok(Math.abs(pnl + 0.1363636364) < 1e-9, `expected -0.1364 SOL, got ${pnl}`);
  assert.ok(Math.abs(book.closed[0].pnlPct + 9.0909) < 1e-3);
});

test('exits are NOT capped — a position that outgrew its pool pays the full curve', async () => {
  const { createBook, openPaperPosition, applyPaperExit, paperConfig } = await PC();
  const cfg = paperConfig({ budgetSol: 100, perTradeSol: 1.5, slippagePct: 0, feeSol: 0 });
  const book = createBook({ budgetSol: 100 });

  // Entered at 5% of the pool, then the token 20x'd. The stake is now worth far
  // more than the pool held when it was bought.
  openPaperPosition(book, { mint: 'RUNNER', priceUsd: 1, cfg, now: 0, poolSolReserve: 30 });
  const exit = applyPaperExit(book, 'RUNNER', {
    priceUsd: 20, trigger: 'TP_100', sellFraction: 1, cfg, now: 1, poolSolReserve: 30,
  });

  assert.equal(exit.closed, true, 'a capped exit would leave a bag the book decided to sell');

  // 1.5 SOL of cost basis at 1.05 entry, marked at 20x: 28.57 SOL trying to
  // leave a 30 SOL pool. Just under half of it is lost to depth.
  assert.ok(exit.impactPct > 48 && exit.impactPct < 49, `expected ~48.8%, got ${exit.impactPct}`);

  // The reported multiple is 20x. The realised one is not, and the gap is the
  // reason a paper 20x has never survived contact with a wallet.
  const realisedMultiple = exit.proceedsSol / 1.5;
  assert.ok(realisedMultiple > 9.7 && realisedMultiple < 9.8, `expected ~9.75x, got ${realisedMultiple}`);
});

/* ------------------------------------------------------------------ *
 * The arithmetic
 * ------------------------------------------------------------------ */

test('size/(pool+size) is the exact constant-product answer on both legs', async () => {
  const { priceImpactPct, entryFillUsd, exitFillUsd } = await PC();

  // BUY: paying mid/(1-impact) per token is identically mid x (1 + size/pool),
  // which is what x*y=k gives. Multiplying by (1+impact) instead would be a
  // different, smaller number and would flatter every entry in the book.
  for (const [size, pool] of [[1, 30], [1.5, 30], [5, 200], [0.25, 117.2], [50, 260.4]]) {
    const impact = priceImpactPct(size, pool);
    assert.ok(
      Math.abs(entryFillUsd(100, { impactPct: impact }) - 100 * (1 + size / pool)) < 1e-9,
      `entry mismatch at ${size} SOL into ${pool}`
    );
    // SELL: the proceeds are v*R/(R+v), so the price is mid x (1 - impact) —
    // multiplied, not divided. The asymmetry is real, not a typo.
    assert.ok(
      Math.abs(exitFillUsd(100, { impactPct: impact }) - 100 * (pool / (pool + size))) < 1e-9,
      `exit mismatch at ${size} SOL into ${pool}`
    );
  }
});

test('impact is null when there is no pool, and zero only when there is no order', async () => {
  const { priceImpactPct } = await PC();

  assert.equal(priceImpactPct(0, 30), 0);
  // Unknown and free are different claims. A caller that treats null as 0 has
  // made a choice; one that receives 0 has had the choice made for it.
  assert.equal(priceImpactPct(1, 0), null);
  assert.equal(priceImpactPct(1, null), null);
  assert.equal(priceImpactPct(1, NaN), null);

  // Monotone in size and inversely in depth, which is the only shape claim the
  // rest of the model relies on.
  assert.ok(priceImpactPct(2, 30) > priceImpactPct(1, 30));
  assert.ok(priceImpactPct(1, 300) < priceImpactPct(1, 30));
});

test('the cap holds at exactly 5% and lets anything smaller through untouched', async () => {
  const { capTradeToPool } = await PC();

  assert.deepEqual(capTradeToPool(1, 30), { sizeSol: 1, capped: false, maxTradeSol: 1.5, poolSol: 30 });
  assert.equal(capTradeToPool(1.5, 30).capped, false, 'exactly at the cap is not over it');
  assert.equal(capTradeToPool(1.5000001, 30).capped, true);
  assert.equal(capTradeToPool(500, 30).sizeSol, 1.5);
  assert.equal(capTradeToPool(500, 30, { poolCapPct: 1 }).sizeSol, 0.3);

  // No pool and model-off both mean "do not cap", and neither invents a depth.
  assert.deepEqual(capTradeToPool(500, null), { sizeSol: 500, capped: false, maxTradeSol: null, poolSol: null });
  assert.equal(capTradeToPool(500, 30, { enabled: false }).sizeSol, 500);
});

/* ------------------------------------------------------------------ *
 * Reading the pool out of a pair
 * ------------------------------------------------------------------ */

test('a SOL-quoted pair reports its SOL reserve directly', async () => {
  const { poolReserveSol } = await PC();

  // MEASURED 2026-08-19, DexScreener, pumpswap $BABYANSEM. The cross-check that
  // makes `liquidity.quote` trustworthy here: 179.8981 x $86.05 = $15.5k, half
  // of the $32,306 total, exactly as a constant-product pair requires.
  const pair = {
    dexId: 'pumpswap',
    baseToken: { symbol: 'BABYANSEM' },
    quoteToken: { symbol: 'SOL', address: WSOL },
    liquidity: { usd: 32306.5, base: 98024912, quote: 179.8981 },
  };

  const pool = poolReserveSol(pair, { solUsd: 86.05 });
  assert.equal(pool.reserveSol, 179.8981);
  assert.equal(pool.measured, true);
  assert.match(pool.basis, /pumpswap/);
});

test('a USDC-quoted pair does NOT hand its quote reserve over as SOL', async () => {
  const { poolReserveSol } = await PC();

  // MEASURED the same day: real WSOL/USDC on Orca. `liquidity.quote` is
  // 16,322,245 — DOLLARS. Read as SOL that is a pool sixteen million deep, and
  // every impact figure against it would round to zero.
  const pair = {
    dexId: 'orca',
    baseToken: { symbol: 'SOL' },
    quoteToken: { symbol: 'USDC', address: USDC },
    liquidity: { usd: 25678895.24, base: 108732, quote: 16322245 },
  };

  const pool = poolReserveSol(pair, { solUsd: 86.052 });
  assert.ok(pool.reserveSol < 200_000, 'the quote reserve must not be mistaken for SOL');
  assert.ok(Math.abs(pool.reserveSol - 25678895.24 / 2 / 86.052) < 1e-6);
  assert.equal(pool.measured, true);
});

test('a pump.fun curve is priced from its own price, not left to the floor', async () => {
  const { poolReserveSol, pumpFunCurveSol, PUMPFUN_VIRTUAL_SOL } = await PC();

  // MEASURED 2026-08-19: 23 of the 56 most recently observed mints were
  // `dexId: pumpfun`, and every one returned `liquidity: undefined` alongside a
  // good price. Falling through to the floor on 41% of candidates would make the
  // floor the model rather than the fallback.
  const murb = { dexId: 'pumpfun', quoteToken: { symbol: 'SOL' }, priceNative: 1.143e-7, liquidity: undefined };
  const pool = poolReserveSol(murb, { solUsd: 86.58 });

  assert.equal(pool.measured, true, 'a derived curve reserve is a measurement, not a guess');
  assert.ok(Math.abs(pool.reserveSol - 60.66) < 0.01, `expected ~60.66 virtual SOL, got ${pool.reserveSol}`);
  assert.match(pool.basis, /bonding curve/);

  // The independent check: this reserve implies a market cap, and DexScreener
  // reported $9,901.34 for the same pair from its own data.
  const impliedMcapUsd = 1.143e-7 * 1e9 * 86.58;
  assert.ok(Math.abs(impliedMcapUsd - 9901.34) / 9901.34 < 0.001, 'the constants reproduce the provider figure');

  // Every curve is at least its own starting depth, and one reading far past
  // migration is not a curve at all.
  assert.equal(pumpFunCurveSol({ priceNative: 1e-12 }), PUMPFUN_VIRTUAL_SOL);
  assert.equal(pumpFunCurveSol({ priceNative: 1 }), null, 'a price that implies 179k SOL is the wrong shape');
  assert.equal(pumpFunCurveSol({ priceNative: 0 }), null);
  assert.equal(pumpFunCurveSol({}), null);

  // A pumpfun pair with no price still floors rather than inventing a curve.
  assert.equal(poolReserveSol({ dexId: 'pumpfun' }, { solUsd: 86 }).measured, false);
});

test('an unreadable pair falls back to the floor, and says it is a floor', async () => {
  const { poolReserveSol } = await PC();

  for (const pair of [null, {}, { liquidity: {} }, { liquidity: { usd: 0 } }]) {
    const pool = poolReserveSol(pair, { solUsd: 86 });
    assert.equal(pool.reserveSol, 30);
    assert.equal(pool.measured, false, 'the floor must never be reported as a measurement');
    assert.match(pool.basis, /floor/);
  }

  // A pool value with no SOL rate cannot be converted, so it floors too rather
  // than guessing a rate.
  assert.equal(poolReserveSol({ liquidity: { usd: 40000 } }, { solUsd: null }).measured, false);
});

/* ------------------------------------------------------------------ *
 * Sought-and-missing vs never-sought
 * ------------------------------------------------------------------ */

test('the floor answers "looked and found none", never "nobody looked"', async () => {
  const { resolvePoolSol, paperConfig } = await PC();
  const cfg = paperConfig({});

  // Sought, missing: this is what poolFloorSol is for.
  const missing = resolvePoolSol(null, cfg);
  assert.equal(missing.active, true);
  assert.equal(missing.reserveSol, 30);
  assert.equal(missing.measured, false);

  // Never sought. Charging a floor here would invent a market for a trade
  // nobody looked up — and would silently re-price every direct caller of
  // openPaperPosition, including the demo path and every test in this repo.
  const absent = resolvePoolSol(undefined, cfg);
  assert.equal(absent.active, false);
  assert.equal(absent.reserveSol, null);

  const off = resolvePoolSol(500, paperConfig({ liquidityModel: false }));
  assert.equal(off.active, false);
});

test('omitting the pool argument leaves a fill exactly where it was before', async () => {
  const { createBook, openPaperPosition, paperConfig } = await PC();
  const cfg = paperConfig({ budgetSol: 10, perTradeSol: 1, slippagePct: 2, feeSol: 0 });

  const book = createBook({ budgetSol: 10 });
  const res = openPaperPosition(book, { mint: 'M', priceUsd: 100, cfg, now: 0 });

  assert.equal(res.position.entryPriceUsd, 102, 'slippage only — no depth was ever sought');
  assert.equal(res.impactPct, null);
  assert.equal(res.liquidityCapped, false);
});

test('a bare price map cannot speak about depth, so the model stays out of it', async () => {
  const { readQuote } = await PC();

  // A number carries no pool. The key is OMITTED rather than nulled, which is
  // what keeps an injected price map on the never-sought path.
  assert.equal('poolSol' in readQuote(5), false);
  assert.deepEqual(readQuote(5), { priceUsd: 5, symbol: null });

  // An object that reported on depth and had none keeps the null.
  assert.equal(readQuote({ priceUsd: 5, poolSol: null }).poolSol, null);
  assert.equal(readQuote({ priceUsd: 5, poolSol: 180 }).poolSol, 180);
  // A quote with no depth field at all is a source that does not carry it.
  assert.equal('poolSol' in readQuote({ priceUsd: 5, symbol: 'X' }), false);
  // Zero and negative depth are not depth.
  assert.equal(readQuote({ priceUsd: 5, poolSol: 0 }).poolSol, null);
});

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

test('the pool knobs are validated, because a bad one produces a working-looking book', async () => {
  const { paperConfig, PAPER_DEFAULTS } = await PC();

  assert.equal(PAPER_DEFAULTS.poolCapPct, 5);
  assert.equal(PAPER_DEFAULTS.poolFloorSol, 30);
  assert.equal(PAPER_DEFAULTS.liquidityModel, true);

  // A 0% cap sizes every trade to nothing; a 500% cap lets one order claim five
  // times what the pool holds. Both are config mistakes that would otherwise
  // run silently for a whole session.
  assert.equal(paperConfig({ poolCapPct: 0 }).poolCapPct, 5, 'zero is a mistake, not a setting');
  assert.equal(paperConfig({ poolCapPct: 500 }).poolCapPct, 100, 'clamped to the whole pool');
  assert.equal(paperConfig({ poolCapPct: 'x' }).poolCapPct, 5);
  assert.equal(paperConfig({ poolCapPct: 0.5 }).poolCapPct, 0.5, 'a deliberately tight cap is honoured');

  // A floor of zero is not "no floor", it is a pool of nothing — which would
  // make priceImpactPct refuse it and quietly restore free liquidity.
  assert.equal(paperConfig({ poolFloorSol: 0 }).poolFloorSol, 30);
  assert.equal(paperConfig({ poolFloorSol: -5 }).poolFloorSol, 30);
  assert.equal(paperConfig({ poolFloorSol: 120 }).poolFloorSol, 120);

  assert.equal(paperConfig({ liquidityModel: false }).liquidityModel, false);
  assert.equal(paperConfig({}).poolDepthLookup, false, 'the implied-entry fast path stays fast by default');
});

test('a trade the pool shrinks below minTradeSol is declined, and says which knob did it', async () => {
  const { createBook, openPaperPosition, paperConfig } = await PC();
  const cfg = paperConfig({ budgetSol: 100, perTradeSol: 5, minTradeSol: 1, slippagePct: 0, feeSol: 0 });
  const book = createBook({ budgetSol: 100 });

  // 5% of a 10 SOL pool is 0.5 — below the floor the operator set for trades
  // worth taking. Declining is the existing policy for dust; the reason has to
  // name the pool or it sends them to minTradeSol, which is not what changed.
  const res = openPaperPosition(book, { mint: 'DUST', priceUsd: 1, cfg, now: 0, poolSolReserve: 10 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /pool depth caps this at 0\.5000 SOL/);
  assert.match(res.reason, /below minTradeSol 1/);
  assert.equal(book.balanceSol, 100, 'a declined trade costs nothing');
});

/* ------------------------------------------------------------------ *
 * Scale-ins
 * ------------------------------------------------------------------ */

test('a scale-in pays impact on its own size, not on the whole position again', async () => {
  const { createBook, openPaperPosition, paperConfig } = await PC();
  const cfg = paperConfig({ budgetSol: 100, perTradeSol: 1, slippagePct: 0, feeSol: 0, scaleIn: true });
  const book = createBook({ budgetSol: 100 });

  openPaperPosition(book, { mint: 'M', priceUsd: 100, cfg, now: 0, poolSolReserve: 200 });
  const add = openPaperPosition(book, { mint: 'M', priceUsd: 100, cfg, now: 1, poolSolReserve: 200 });

  assert.equal(add.scaledIn, true);
  // 1 SOL through 200, not 2 SOL through 200: the first lot already paid for the
  // depth it took, minutes ago.
  assert.ok(Math.abs(add.impactPct - (1 / 201) * 100) < 1e-12);

  // Both lots filled at the same price, so the blended entry is that price —
  // the harmonic mean of two equal numbers, carrying the impact once each.
  assert.ok(Math.abs(book.positions.M.entryPriceUsd - 100 * (1 + 1 / 200)) < 1e-9);
  assert.ok(Math.abs(book.positions.M.entryImpactSol - 2 * (1 / 201)) < 1e-9, 'cumulative across both adds');
});

/* ------------------------------------------------------------------ *
 * Disclosure
 * ------------------------------------------------------------------ */

test('the activity log states the impact and badges a capped trade', async () => {
  const { liquidityTag } = await PC();

  const capped = liquidityTag({ impactPct: 4.7619, liquidityCapped: true, requestedSol: 500, sizeSol: 1.5, poolSol: 30, poolMeasured: true });
  assert.match(capped, /\[LIQUIDITY CAPPED/);
  // BOTH numbers: 500 cut to 1.5 and 1.6 cut to 1.5 are different events and in
  // a fixed-height log they would otherwise read identically.
  assert.match(capped, /500\.0000 → 1\.5000 SOL/);
  assert.match(capped, /30\.0 SOL pool/);
  assert.match(capped, /impact 4\.76%/);

  // An ordinary fill states its impact and nothing else.
  const plain = liquidityTag({ impactPct: 0.85, poolMeasured: true });
  assert.equal(plain, '  impact 0.85%');
  assert.equal(plain.includes('LIQUIDITY CAPPED'), false);

  // A figure derived from the floor is labelled, because it is a property of
  // the model rather than of the market.
  assert.match(liquidityTag({ impactPct: 3.23, poolMeasured: false }), /assumed pool/);

  // Nothing to say stays silent rather than padding the line with a zero.
  assert.equal(liquidityTag({}), '');
  assert.equal(liquidityTag({ impactPct: null }), '');
});

test('the scorecard totals what depth took and separates measured from assumed', async () => {
  const { createBook, openPaperPosition, applyPaperExit, paperScorecard, renderScorecard, paperConfig } = await PC();
  const cfg = paperConfig({ budgetSol: 100, perTradeSol: 500, slippagePct: 0, feeSol: 0 });
  const book = createBook({ budgetSol: 100 });

  openPaperPosition(book, { mint: 'A', priceUsd: 1, cfg, now: 0, poolSolReserve: 30 });
  applyPaperExit(book, 'A', { priceUsd: 1, trigger: 'HARD_STOP', sellFraction: 1, cfg, now: 1, poolSolReserve: 30 });
  openPaperPosition(book, { mint: 'B', priceUsd: 1, cfg, now: 2, poolSolReserve: null });

  const card = paperScorecard(book, cfg);
  assert.equal(card.liquidityCappedTrades, 2, 'both entries were held to 5% of their pool');
  assert.ok(card.impactPaidSol > 0);
  // The whole depth bill: 1.5 SOL in and 1.4286 out of A, plus B's entry.
  assert.ok(Math.abs(card.impactPaidSol - (1.5 * (1.5 / 31.5) + 1.42857142857 * (1.42857142857 / 31.42857142857) + 1.5 * (1.5 / 31.5))) < 1e-6);
  assert.equal(card.flooredFills, 1, 'B was priced against a pool nobody read');

  const out = renderScorecard(card, { solUsd: 100 });
  assert.match(out, /Pool impact/);
  assert.match(out, /\[LIQUIDITY CAPPED\] at 5% of pool/);
  assert.match(out, /ASSUMED pool floor/);
});

test('switching the model off restores the infinite-depth book exactly', async () => {
  const { createBook, openPaperPosition, applyPaperExit, paperScorecard, paperConfig } = await PC();
  const cfg = paperConfig({ budgetSol: 1000, perTradeSol: 500, slippagePct: 0, feeSol: 0, liquidityModel: false });
  const book = createBook({ budgetSol: 1000 });

  // 500 SOL into a 30 SOL pool, with the model off: filled whole, at the mid.
  const res = openPaperPosition(book, { mint: 'THIN', priceUsd: 1, cfg, now: 0, poolSolReserve: 30 });
  assert.equal(res.sizeSol, 500);
  assert.equal(res.liquidityCapped, false);
  assert.equal(res.position.entryPriceUsd, 1);

  applyPaperExit(book, 'THIN', { priceUsd: 1, trigger: 'X', sellFraction: 1, cfg, now: 1, poolSolReserve: 30 });
  assert.equal(book.balanceSol, 1000, 'a flat round trip costs exactly nothing');
  assert.equal(paperScorecard(book, cfg).impactPaidSol, 0);
});

/* ------------------------------------------------------------------ *
 * Through a whole tick
 * ------------------------------------------------------------------ */

test('a tick prices its fills against the pool the quote came with', async () => {
  const { createBook, runPaperTick, paperConfig } = await PC();
  const now = 1_000_000_000;
  const cfg = paperConfig({
    budgetSol: 100, perTradeSol: 500, slippagePct: 0, feeSol: 0,
    useImpliedEntry: false, maxBuyAgeMinutes: 60,
  });
  const book = createBook({ budgetSol: 100, target: { address: 'W' } });

  const report = await runPaperTick({
    book, observations: { wallets: {} }, watchlist: { wallets: [{ address: 'W' }] }, cfg, now, solUsd: 100,
    // A full quote carrying depth, as fetchMarketData returns.
    priceFetcher: async () => new Map([['M', { priceUsd: 1, symbol: 'M', poolSol: 40 }]]),
    tradeFetcher: async () => ({
      ok: true, newestSignature: 'S1',
      trades: [{ kind: 'BUY', mint: 'M', solSpent: 500, tokenDelta: 1000, blockTime: now, signature: 'S1' }],
    }),
  });

  assert.equal(report.opened.length, 1);
  const opened = report.opened[0];
  assert.equal(opened.sizeSol, 2, '5% of the 40 SOL pool the quote reported');
  assert.equal(opened.liquidityCapped, true);
  assert.equal(opened.poolMeasured, true);
  assert.ok(Math.abs(opened.impactPct - (2 / 42) * 100) < 1e-12);

  assert.equal(report.liquidity.capped, 1);
  assert.equal(report.liquidity.flooredFills, 0);
  assert.equal(report.liquidity.poolsMeasured, 1);
  assert.equal(report.liquidity.depthUnavailable, 0);
});

test('a tick whose quotes carry no depth field says so instead of assuming a pool', async () => {
  const { createBook, runPaperTick, paperConfig } = await PC();
  const now = 1_000_000_000;
  const cfg = paperConfig({ budgetSol: 100, perTradeSol: 500, slippagePct: 0, feeSol: 0, useImpliedEntry: false });
  const book = createBook({ budgetSol: 100, target: { address: 'W' } });

  const report = await runPaperTick({
    book, observations: { wallets: {} }, watchlist: { wallets: [{ address: 'W' }] }, cfg, now, solUsd: 100,
    // A bare price map — the shape every injected fetcher in this repo uses.
    priceFetcher: async () => new Map([['M', 1]]),
    tradeFetcher: async () => ({
      ok: true, newestSignature: 'S1',
      trades: [{ kind: 'BUY', mint: 'M', solSpent: 500, tokenDelta: 1000, blockTime: now, signature: 'S1' }],
    }),
  });

  // Uncapped and unpriced for depth: the source cannot report it, so the model
  // does not run. The count is what makes that visible rather than silent — a
  // tick with a high depthUnavailable is a tick still assuming infinite
  // liquidity, whatever the config says.
  assert.equal(report.opened[0].liquidityCapped, false);
  assert.equal(report.opened[0].impactPct, null);
  assert.equal(report.liquidity.depthUnavailable, 1);
  assert.equal(report.liquidity.poolsMeasured, 0);
});
