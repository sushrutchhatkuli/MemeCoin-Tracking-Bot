import test from 'node:test';
import assert from 'node:assert/strict';

const FSW = () => import('../find_similar_whales.mjs');

const ME = 'TwinSeed1111111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * One Helius parsed transaction, in the shape the endpoint actually returns.
 * Verified against a live call on 2026-08-19: `timestamp` is unix SECONDS,
 * `tokenTransfers[].tokenAmount` is a ui amount, and the wallet's own SOL move
 * lives in `accountData[].nativeBalanceChange` in lamports.
 */
function tx({ mint, sol, tokens, tsMs, type = 'SWAP', err = null, address = ME, extraTransfers = [] }) {
  const transfers = [];
  if (mint) {
    transfers.push({
      mint,
      tokenAmount: Math.abs(tokens),
      fromUserAccount: tokens > 0 ? 'PoolAccount1111' : address,
      toUserAccount: tokens > 0 ? address : 'PoolAccount1111',
    });
  }
  return {
    signature: `sig-${mint ?? 'none'}-${tsMs}-${sol}`,
    type,
    transactionError: err,
    timestamp: Math.floor(tsMs / 1000),
    tokenTransfers: [...transfers, ...extraTransfers],
    accountData: [{ account: address, nativeBalanceChange: Math.round(sol * 1e9) }],
  };
}

const buy = (mint, sol, tokens, tsMs) => tx({ mint, sol: -sol, tokens, tsMs });
const sell = (mint, sol, tokens, tsMs) => tx({ mint, sol, tokens: -tokens, tsMs });

/* ------------------------------------------------------------------ *
 * Leg extraction
 * ------------------------------------------------------------------ */

test('a buy and a sell are told apart by the wallet SOL delta, not the instruction', async () => {
  const { extractSwapLegs } = await FSW();
  const now = Date.UTC(2026, 7, 19, 12);

  const { legs } = extractSwapLegs(
    [buy('MintA', 1.5, 3_000_000, now - HOUR), sell('MintA', 2.4, 3_000_000, now)],
    { address: ME }
  );

  assert.equal(legs.length, 2);
  assert.equal(legs[0].kind, 'BUY');
  assert.equal(legs[0].solOut, 1.5);
  assert.equal(legs[0].tokensIn, 3_000_000);
  assert.equal(legs[1].kind, 'SELL');
  assert.equal(legs[1].solIn, 2.4);
});

test('WSOL is the SOL side of the swap and is never treated as a position', async () => {
  const { extractSwapLegs } = await FSW();
  const now = Date.UTC(2026, 7, 19, 12);

  // The real payload carries WSOL legs on every pump.fun AMM swap — this is the
  // exact shape measured on the seed, where the pool sends WSOL to the seller.
  const withWsol = tx({
    mint: 'MintA',
    sol: 2.4,
    tokens: -3_000_000,
    tsMs: now,
    extraTransfers: [{ mint: WSOL, tokenAmount: 2.4, fromUserAccount: 'PoolAccount1111', toUserAccount: ME }],
  });

  const { legs, ambiguous } = extractSwapLegs([withWsol], { address: ME });
  assert.equal(ambiguous, 0, 'WSOL beside a real mint must not read as a two-token swap');
  assert.equal(legs.length, 1);
  assert.equal(legs[0].mint, 'MintA');
});

test('what is thrown away is counted, because a router is not a trader', async () => {
  const { extractSwapLegs } = await FSW();
  const now = Date.UTC(2026, 7, 19, 12);

  const multiMint = tx({
    mint: 'MintA',
    sol: -1,
    tokens: 100,
    tsMs: now,
    extraTransfers: [{ mint: 'MintB', tokenAmount: 50, fromUserAccount: 'PoolAccount1111', toUserAccount: ME }],
  });

  const res = extractSwapLegs(
    [
      multiMint,
      buy('MintC', 0.001, 10, now), // dust
      tx({ mint: 'MintD', sol: -1, tokens: 5, tsMs: now, err: { InstructionError: [] } }),
      tx({ mint: null, sol: -0.5, tokens: 0, tsMs: now, type: 'TRANSFER' }),
    ],
    { address: ME }
  );

  assert.equal(res.legs.length, 0);
  assert.equal(res.ambiguous, 1);
  assert.equal(res.dustSkipped, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.nonSwap, 1);
  // Frequency counts EVERY transaction, including the transfer and the failure:
  // criterion 8 asks how busy the address is, and a wallet whose volume is
  // failed attempts is busy in a way the screen should be able to show.
  assert.equal(res.txCount, 4);
});

/* ------------------------------------------------------------------ *
 * The window — the difference between a measurement and a projection
 * ------------------------------------------------------------------ */

test('history reaching back a week is measured; anything shorter is scaled and says so', async () => {
  const { resolveWindow, WEEK_MS } = await FSW();
  const now = Date.UTC(2026, 7, 19, 12);

  const long = resolveWindow({ oldestTs: now - 30 * DAY, now });
  assert.equal(long.extrapolated, false);
  assert.equal(long.scale, 1);
  assert.equal(long.spanMs, WEEK_MS);
  assert.equal(long.since, now - WEEK_MS, 'a 30-day history is TRIMMED to the last week, not averaged over 30 days');

  // The seed moves ~200 transactions per 144 minutes. Four pages of it is a few
  // hours, and four hours scaled to a week is a 42x projection.
  const short = resolveWindow({ oldestTs: now - 4 * HOUR, now });
  assert.equal(short.extrapolated, true);
  assert.equal(short.scale, 42);
});

test('the span runs to NOW, so a wallet that went quiet three days ago rates as quiet', async () => {
  const { resolveWindow } = await FSW();
  const now = Date.UTC(2026, 7, 19, 12);

  // 100 transactions in one busy hour, then silence for three days. Anchoring
  // the span to the newest transaction would score this wallet at 16,800 txs a
  // week — measuring to now scores it at 230.
  const dormant = resolveWindow({ oldestTs: now - 3 * DAY - HOUR, now });
  assert.equal(Math.round(100 * dormant.scale), 230);
});

/* ------------------------------------------------------------------ *
 * Positions and the gain/loss shape
 * ------------------------------------------------------------------ */

test('a round trip is closed only when SOL went out AND came back', async () => {
  const { extractSwapLegs, buildPositions } = await FSW();
  const now = Date.UTC(2026, 7, 19, 12);

  const { legs } = extractSwapLegs(
    [
      buy('Closed', 1, 1000, now - 2 * HOUR),
      sell('Closed', 2, 1000, now - HOUR),
      buy('StillHeld', 1, 1000, now - HOUR),
      sell('BoughtEarlier', 3, 500, now), // the buy predates the window
    ],
    { address: ME }
  );

  const byMint = Object.fromEntries(buildPositions(legs).map((p) => [p.mint, p]));
  assert.equal(byMint.Closed.closed, true);
  assert.equal(byMint.Closed.multiple, 2);
  assert.equal(byMint.StillHeld.closed, false, 'an open bag is neither a win nor a loss');
  assert.equal(byMint.BoughtEarlier.closed, false, 'a sell with no buy in the window has no cost basis');
});

test('the buckets are the plan rungs, and 1.0x-1.2x is kept separate from both', async () => {
  const { bucketPositions } = await FSW();
  const p = (multiple, solOut = 1) => ({
    closed: true,
    multiple,
    solOut,
    solIn: solOut * multiple,
    netSol: solOut * multiple - solOut,
  });

  const b = bucketPositions([
    p(2.0), p(1.5), p(2.9), // quick gains
    p(1.05), p(1.15), // scalps, NOT 1.2-3x exits — 1.15 is just under the rung
    p(8.0), // a runner
    p(0.7), p(0.9), // minor losses
    p(0.2), // a rug
  ]);

  assert.equal(b.closedTrades, 9);
  assert.equal(b.wins, 6);
  assert.equal(b.losses, 3);
  assert.equal(Math.round(b.quickGainPct), 33, '3 of 9');
  assert.equal(Math.round(b.scalpGainPct), 22, 'the +5% and +15% scalps are counted on their own');
  assert.equal(Math.round(b.bigGainPct), 11);
  assert.equal(Math.round(b.deepRugPct), 11);
  assert.equal(Math.round(b.minorLossShareOfLossesPct), 67, '2 of the 3 losses stayed above -50%');
});

test('loss cutting is scored against losses, so a flawless wallet does not fail for having none', async () => {
  const { bucketPositions, gradeTwin } = await FSW();
  const winner = { closed: true, multiple: 2, solOut: 1, solIn: 2, netSol: 1 };

  const b = bucketPositions([winner, winner, winner]);
  assert.equal(b.losses, 0);
  // Scored against ALL trades this would be 0% and criterion 5 would fail a
  // wallet that never lost. Null instead — unmeasured, and unmeasured is a
  // failure with a reason attached rather than a wrong number.
  assert.equal(b.minorLossShareOfLossesPct, null);

  const grade = gradeTwin({ ...b, balanceSol: 50, sub100kMcPct: 95, weeklyRealizedUsd: 20000, weeklyTxs: 5000 });
  const lossCut = grade.checks.find((k) => k.key === 'lossCut');
  assert.equal(lossCut.pass, null);
  assert.equal(lossCut.shown, 'n/a');
});

/* ------------------------------------------------------------------ *
 * Entry market cap
 * ------------------------------------------------------------------ */

test('entry market cap is the fill times supply, and refuses to guess without both', async () => {
  const { entryMcapUsd } = await FSW();

  // MEASURED on the seed 2026-08-19: 0.826 SOL for 4,768,310 tokens of a
  // 964,562,843 supply at $76.95/SOL priced the entry at ~$12,855.
  const mcap = entryMcapUsd({ solOut: 0.826, tokensIn: 4_768_310 }, 964_562_843, 76.95);
  assert.ok(Math.abs(mcap - 12_855) < 50, `expected ~$12.8k, got ${mcap}`);

  assert.equal(entryMcapUsd({ solOut: 1, tokensIn: 1000 }, null, 76.95), null, 'no supply, no market cap');
  assert.equal(entryMcapUsd({ solOut: 1, tokensIn: 1000 }, 1e9, null), null, 'no SOL price, no market cap');
  assert.equal(entryMcapUsd({ solOut: 0, tokensIn: 1000 }, 1e9, 76.95), null);
});

test('the sub-$100k share reports how many buys it could actually price', async () => {
  const { entryMcapProfile } = await FSW();
  const legs = [
    { kind: 'BUY', mint: 'Cheap', solOut: 1, tokensIn: 1e6 },
    { kind: 'BUY', mint: 'Rich', solOut: 1, tokensIn: 1e3 },
    { kind: 'BUY', mint: 'Unknown', solOut: 1, tokensIn: 1e6 },
    { kind: 'SELL', mint: 'Cheap', solIn: 2, tokensOut: 1e6 },
  ];
  const supplies = new Map([['Cheap', 1e9], ['Rich', 1e9]]);

  const p = entryMcapProfile(legs, supplies, 76.95);
  assert.equal(p.buys, 3);
  assert.equal(p.priced, 2, 'the mint with no supply on file is not priced');
  assert.equal(Math.round(p.coveragePct), 67);
  // "94% sub-$100k over 2 of 3 buys" and the same figure over 60 of 63 are
  // different claims; the caller has to be able to tell them apart.
  assert.equal(p.sub100kMcPct, 50);
});

/* ------------------------------------------------------------------ *
 * Grading
 * ------------------------------------------------------------------ */

test('an unmeasured criterion fails — never passes, never counts as measured', async () => {
  const { gradeTwin } = await FSW();

  const grade = gradeTwin({
    sub100kMcPct: null, // never priced
    balanceSol: 52,
    winRatePct: 65,
    quickGainPct: 70,
    minorLossShareOfLossesPct: 95,
    deepRugPct: 0.4,
    weeklyRealizedUsd: 42_500,
    weeklyTxs: 10_000,
  });

  assert.equal(grade.passedCount, 7);
  assert.equal(grade.unmeasured, 1);
  assert.equal(grade.checks.find((k) => k.key === 'entryMcap').pass, null);
  assert.ok(grade.failedLabels.some((l) => /Entry MC/.test(l)));
});

test('the seed\'s own measured win rate does NOT clear the gate taken from its GMGN page', async () => {
  const { gradeTwin, GMGN_SEED_PROFILE } = await FSW();

  // MEASURED 2026-08-19 over 200 transactions of Ar2Y6o1Q: 53 closed round
  // trips, 22 wins, 41.5%. GMGN's profile for the same wallet says 65.76%.
  assert.equal(GMGN_SEED_PROFILE.winRatePct, 65.76);

  const measured = gradeTwin({
    sub100kMcPct: 93,
    balanceSol: 56.27,
    winRatePct: 41.5,
    quickGainPct: 40,
    minorLossShareOfLossesPct: 90,
    deepRugPct: 0.5,
    weeklyRealizedUsd: 76_000,
    weeklyTxs: 14_000,
  });

  const wr = measured.checks.find((k) => k.key === 'winRate');
  assert.equal(wr.pass, false, 'a 60-75% gate rejects the wallet it was derived from');
  // Which is exactly why the calibration panel runs before every screen: the
  // thresholds have to be tuned against this column, not against the provider's.
  assert.ok(measured.passedCount < 8);
});

test('the win rate gate is a band, not a floor — 90% is as disqualifying as 40%', async () => {
  const { gradeTwin } = await FSW();
  const base = {
    sub100kMcPct: 95, balanceSol: 50, quickGainPct: 70, minorLossShareOfLossesPct: 95,
    deepRugPct: 0.1, weeklyRealizedUsd: 20_000, weeklyTxs: 5_000,
  };
  const wrOf = (v) => gradeTwin({ ...base, winRatePct: v }).checks.find((k) => k.key === 'winRate').pass;

  assert.equal(wrOf(65), true);
  assert.equal(wrOf(59.9), false);
  // A 90% win rate on a memecoin scalper is not a better twin, it is a
  // different strategy — or a wallet whose losses have not closed yet.
  assert.equal(wrOf(90), false);
});

test('thresholds come off the command line, including the documented preview run', async () => {
  const { parseArgs } = await FSW();

  const args = parseArgs(
    '--seed Ar2Y6o1QmrRAskjii1cRfijeKugHH13ycxW5cd7rro1x --sub100k-mc 90 --min-wr 60 --max-rug 1.0 --min-balance-sol 20 --max-balance-sol 100 --limit 5'.split(
      ' '
    )
  );

  assert.equal(args.seed, 'Ar2Y6o1QmrRAskjii1cRfijeKugHH13ycxW5cd7rro1x');
  assert.equal(args.criteria.sub100kMcPct, 90);
  assert.equal(args.criteria.minWinRatePct, 60);
  assert.equal(args.criteria.maxDeepRugPct, 1);
  assert.equal(args.criteria.minBalanceSol, 20);
  assert.equal(args.criteria.maxBalanceSol, 100);
  assert.equal(args.limit, 5);
  assert.equal(args.maxOverlapPct, 15, 'the diversification default');
});

test('a flag followed by another flag keeps its default instead of eating it', async () => {
  const { parseArgs, DEFAULT_CRITERIA } = await FSW();

  // `--limit --json` used to set limit to NaN and silently drop --json's
  // meaning. Two settings changed by one typo is the worst kind of quiet bug.
  const args = parseArgs(['--limit', '--json']);
  assert.equal(args.limit, 5);
  assert.equal(args.json, true);
  assert.equal(args.criteria.minWinRatePct, DEFAULT_CRITERIA.minWinRatePct);
});

test('the SOL price is retried, because a null quietly deletes two criteria', async () => {
  const { resolveSolUsd } = await FSW();

  // MEASURED while building this: two runs minutes apart, the first priced at
  // $76.99 and the second returned null from the same feed. Criteria 1 and 7
  // are both USD figures, so that null caps every wallet in the pool at 6/8 —
  // a screen that reports "no twins" for a reason that has nothing to do with
  // the wallets.
  let calls = 0;
  const flaky = async () => (++calls < 3 ? null : 76.99);
  assert.equal(await resolveSolUsd({ fetcher: flaky, delayMs: 1 }), 76.99);
  assert.equal(calls, 3);

  assert.equal(await resolveSolUsd({ fetcher: async () => null, delayMs: 1 }), null);
  assert.equal(await resolveSolUsd({ fetcher: async () => 0, delayMs: 1 }), null, 'a zero price is not a price');
});

/* ------------------------------------------------------------------ *
 * Diversification
 * ------------------------------------------------------------------ */

test('overlap is measured against the smaller book, where the duplication actually is', async () => {
  const { computeTokenOverlap } = await FSW();

  const small = new Set(['a', 'b', 'c', 'd']);
  const big = new Set(['a', 'b', 'c', 'd', ...Array.from({ length: 196 }, (_, i) => `x${i}`)]);

  // Every mint the small wallet holds is also held by the big one. Scored
  // against the union that reads 2% and the pair passes a 15% diversity gate
  // while trading an identical book.
  assert.equal(computeTokenOverlap(small, big), 100);
  assert.equal(computeTokenOverlap(new Set(), big), 0);
});

test('a twin trading the same book as an earlier pick is held back, with the reason kept', async () => {
  const { selectDiverseTwins } = await FSW();

  const mk = (address, mints) => ({ address, mints: new Set(mints), profile: {}, grade: {} });
  const seed = { ...mk('SEED', ['m1', 'm2', 'm3', 'm4']), overlapPct: 0 };

  const { picked, rejected } = selectDiverseTwins(
    [
      mk('CLONE', ['m1', 'm2', 'm3', 'm9']), // 75% of the seed's book
      mk('FRESH', ['z1', 'z2', 'z3', 'z4']),
    ],
    { maxOverlapPct: 15, limit: 5, preselected: [seed] }
  );

  assert.deepEqual(picked.map((p) => p.address), ['SEED', 'FRESH']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].address, 'CLONE');
  assert.equal(Math.round(rejected[0].overlapPct), 75);
  assert.equal(rejected[0].against, 'SEED', 'the roster has to say WHICH pick it collided with');
});

test('the roster stops at the limit and never lists the same wallet twice', async () => {
  const { selectDiverseTwins } = await FSW();
  const mk = (address) => ({ address, mints: new Set([`only-${address}`]), profile: {}, grade: {} });

  const { picked } = selectDiverseTwins([mk('A'), mk('B'), mk('C'), mk('D')], {
    maxOverlapPct: 15,
    limit: 3,
    preselected: [{ ...mk('A'), overlapPct: 0 }],
  });

  assert.deepEqual(picked.map((p) => p.address), ['A', 'B', 'C']);
});

/* ------------------------------------------------------------------ *
 * What gets written
 * ------------------------------------------------------------------ */

test('nothing unmeasured is written as a number', async () => {
  const { buildTwinWatchlist, DEFAULT_CRITERIA } = await FSW();

  const entry = buildTwinWatchlist(
    [
      {
        address: 'Twin1111111111111111111111111111111111111111',
        overlapPct: 4.2,
        grade: { distance: 0.25 },
        profile: {
          balanceSol: 41.3, winRatePct: 63.2, closedTrades: 57, quickGainPct: 61.4,
          minorLossShareOfLossesPct: 90.1, deepRugPct: 0.4, sub100kMcPct: 92.6, mcapPriced: 40,
          weeklyRealizedUsd: 18_400, weeklyTxs: 6_100, extrapolated: true, windowScale: 12,
          windowHours: 14, fetchedTxs: 400, pages: 4, historyComplete: false,
        },
      },
    ],
    { seed: 'SEED', criteria: DEFAULT_CRITERIA, maxOverlapPct: 15, pages: 4, solUsd: 76.95 }
  ).wallets[0];

  // The previous cut of this module wrote `+$${250 + Math.random()*200}k` into
  // this field and a flat 15,000 into onchain_signatures — placeholder shaped
  // exactly like evidence, sitting in the file position sizing reads.
  assert.equal(entry.all_time_net_profit_usd, null);
  assert.equal(entry.graded_buys, null);
  assert.equal(entry.onchain_signatures, 400, 'the transactions actually fetched, not a round number');
  assert.equal(entry.win_rate, '63.2%');
  assert.equal(entry.weekly_realized_usd, 18_400);
  assert.equal(entry.weekly_figures_extrapolated, true);
  assert.equal(entry.token_overlap_pct, 4.2);
  assert.match(entry.metrics_basis, /57 closed round trips over 14.0h/);
  assert.match(entry.metrics_basis, /scaled 12.0x/);
});

test('the file header states the window and the win-rate divergence', async () => {
  const { buildTwinWatchlist, DEFAULT_CRITERIA } = await FSW();

  const wl = buildTwinWatchlist([], {
    seed: 'SEED', criteria: DEFAULT_CRITERIA, maxOverlapPct: 15, pages: 4, solUsd: 76.95,
  });
  const header = wl._comment.join('\n');

  assert.match(header, /NOT SEVEN DAYS/, 'a reader must not take the weekly columns as a measured week');
  assert.match(header, /WILL NOT MATCH GMGN/);
  assert.match(header, /overwrites this same file/, 'auto_top_whales owns this path too');
});

test('a twin score is a similarity, and an unmeasurable distance has no score', async () => {
  const { twinScore, twinDistance } = await FSW();

  assert.equal(twinScore(0), 1, 'an exact twin');
  assert.ok(twinScore(0.25) > twinScore(1.5));
  assert.equal(twinScore(null), null);

  assert.equal(twinDistance([]), null);
  assert.equal(twinDistance([{ value: null, bench: 60 }]), null, 'unmeasured cannot be scored as close');
  assert.equal(twinDistance([{ value: 30, bench: 60 }, { value: 60, bench: 60 }]), 0.25);
});

/* ------------------------------------------------------------------ *
 * End to end, no network
 * ------------------------------------------------------------------ */

test('a full profile from recorded history, weekly figures scaled from the window', async () => {
  const { profileWallet } = await FSW();
  const now = Date.UTC(2026, 7, 19, 12);

  const history = [
    buy('Win1', 1, 1_000_000, now - 3 * HOUR),
    sell('Win1', 2, 1_000_000, now - 2.5 * HOUR), // 2.0x
    buy('Win2', 1, 1_000_000, now - 3 * HOUR),
    sell('Win2', 1.5, 1_000_000, now - 2 * HOUR), // 1.5x
    buy('Rug', 1, 1_000_000, now - 2 * HOUR),
    sell('Rug', 0.2, 1_000_000, now - HOUR), // 0.2x
    buy('Open', 1, 1_000_000, now - HOUR),
  ];

  const p = profileWallet({
    address: ME,
    transactions: history,
    balanceSol: 44,
    solUsd: 100,
    supplies: new Map([['Win1', 1e9], ['Win2', 1e9], ['Rug', 1e9], ['Open', 1e9]]),
    now,
  });

  assert.equal(p.closedTrades, 3);
  assert.equal(p.openPositions, 1);
  assert.equal(Math.round(p.winRatePct), 67);
  assert.equal(Math.round(p.quickGainPct), 67, 'the 2.0x and the 1.5x');
  assert.equal(Math.round(p.deepRugPct), 33);
  assert.equal(Number(p.closedNetSol.toFixed(6)), 0.7, 'realized: +0.7 SOL out of the closed trips');

  // Every buy went in at 1 SOL for 1,000,000 of a 1e9 supply -> $100k... except
  // the arithmetic: (1/1e6) * 1e9 * 100 = $100,000, exactly ON the boundary and
  // therefore NOT under it.
  assert.equal(p.sub100kMcPct, 0);
  assert.equal(p.mcapPriced, 4);

  // Three hours of history, so everything weekly is a 56x projection and the
  // profile has to say so.
  assert.equal(p.extrapolated, true);
  assert.equal(Math.round(p.windowHours), 3);
  assert.equal(Math.round(p.weeklyRealizedUsd), Math.round(0.7 * 100 * (7 * 24) / 3));

  // swap flow includes the open bag and therefore reads WORSE than realized —
  // the gap is exactly the SOL sitting in the unsold position.
  assert.ok(p.swapFlowNetSol < p.closedNetSol);
  assert.equal(Number(p.swapFlowNetSol.toFixed(6)), -0.3);
});
