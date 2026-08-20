import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Phase 1 of the live web dashboard: the pure state transformer.
 *
 * No server, no port, no network — `buildDashboardState` is synchronous and
 * takes a book, so every property below is checked against a book built by the
 * real engine rather than a hand-written fixture that could drift from it.
 */
const DASH = () => import('../dashboard.mjs');
const PC = () => import('../paper_copytrade.mjs');

/** A book with `count` open positions, all priced and marked. */
async function bookWith(count, { poolSolReserve = 100, cfg: cfgOverrides = {}, now = 1_000_000 } = {}) {
  const { createBook, openPaperPosition, markPosition, paperConfig } = await PC();
  const cfg = paperConfig({
    budgetSol: 1000,
    perTradeSol: 1,
    pctWhale: null,
    slippagePct: 0,
    feeSol: 0,
    maxOpenPositions: 50,
    ...cfgOverrides,
  });
  const book = createBook({ budgetSol: 1000 });
  for (let i = 0; i < count; i++) {
    const mint = `MINT${String(i).padStart(2, '0')}`;
    openPaperPosition(book, { mint, symbol: `TKN${i}`, priceUsd: 1, cfg, now, poolSolReserve });
    // Mark somewhere other than entry, so a row that silently reports cost
    // basis instead of value fails rather than coincidentally passing.
    markPosition(book.positions[mint], 1.25, now);
  }
  return { book, cfg };
}

/** `n` samples, 5s apart, ascending — the shape a `--watch 5` tick produces. */
function series(n, { start = 1_000_000, stepMs = 5_000, price = 0.00004312 } = {}) {
  return Array.from({ length: n }, (_, i) => ({ t: start + i * stepMs, priceUsd: price * (1 + i / 1000) }));
}

/**
 * Source with comments removed.
 *
 * Every "this file must not contain X" assertion has to run on CODE. These
 * modules EXPLAIN what they refuse to do — naming writeFile, localStorage and
 * saveBook in order to say they are not used — and a test that cannot tell an
 * explanation from a call site either fails on documentation or forces the
 * documentation to be deleted. Both have already happened here once.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

/* ------------------------------------------------------------------ *
 * 1. The scorecard is passed through, and position rows cannot drift from it
 * ------------------------------------------------------------------ */

test('the scorecard reaches the browser verbatim, field for field', async () => {
  const { buildDashboardState } = await DASH();
  const { paperScorecard } = await PC();
  const { book, cfg } = await bookWith(3);

  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000 });

  // The whole point of the module. Not a spread, not a subset, not rounded —
  // if this fails, the terminal and the web view can now disagree about money.
  assert.deepStrictEqual(state.scorecard, paperScorecard(book, cfg));
});

test('position values sum to the scorecard openValueSol, closing the duplicated formula', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(4);

  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000 });
  const summed = state.positions.reduce((a, p) => a + p.valueSol, 0);

  // renderPositions returns a STRING, so the per-position gain/value maths had
  // to be duplicated in dashboard.mjs. This is the seam: paperScorecard runs
  // the identical reduce, so a drift in either copy shows up here rather than
  // as two views quietly reporting different numbers.
  assert.ok(
    Math.abs(summed - state.scorecard.openValueSol) < 1e-9,
    `positions summed to ${summed}, scorecard says ${state.scorecard.openValueSol}`
  );

  // And the rows really are marked, not held at cost — otherwise the assertion
  // above would pass on a book where both sides were equally wrong.
  //
  // 25% would be the mid-to-mark move. The rows report LESS than that, because
  // entryPriceUsd is the fill: a 1 SOL trade into a 100 SOL pool paid ~0.99%
  // impact, so the gain is measured from what was actually paid. A row showing
  // exactly 25% would mean the entry cost had gone missing between the book and
  // the browser.
  assert.ok(state.positions.every((p) => p.entryPriceUsd > 1), 'entry is the fill, and the fill crossed a pool');
  assert.ok(
    state.positions.every((p) => p.gainPct > 23 && p.gainPct < 25),
    'gain is measured from the fill, not from mid'
  );
});

test('building state mutates nothing', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(3);

  // In the shipped design this runs INSIDE the tick process, holding the live
  // book. There is no defensive copy to be careless with.
  const before = JSON.stringify(book);
  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000, focusedMint: 'MINT00' });
  state.positions[0].firedRungs.push('TAMPERED');
  state.activity.push('TAMPERED');

  assert.equal(JSON.stringify(book), before, 'the book is untouched, including through returned arrays');
});

/* ------------------------------------------------------------------ *
 * 2. `winRatePct` stays null, and null survives the wire
 * ------------------------------------------------------------------ */

test('a book with nothing closed serialises win rate as null, not 0', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(2);

  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000 });
  assert.equal(state.scorecard.winRatePct, null);

  // Asserted AFTER a JSON round trip, because that is where a `|| 0` in a
  // serialiser would actually bite. "0% of trades won" and "nothing has
  // resolved yet" are different claims and only one of them is bad news.
  const overTheWire = JSON.parse(JSON.stringify(state));
  assert.equal(overTheWire.scorecard.winRatePct, null, 'null must not become 0 or vanish in transit');
  assert.ok('winRatePct' in overTheWire.scorecard, 'the key survives even when the value is null');
});

test('a real 0% win rate is reported as 0, so the two cases stay distinguishable', async () => {
  const { buildDashboardState } = await DASH();
  const { applyPaperExit } = await PC();
  const { book, cfg } = await bookWith(1);

  // One position, closed at a loss. Now 0% is a fact about the book rather
  // than a placeholder for "no data".
  applyPaperExit(book, 'MINT00', { priceUsd: 0.5, trigger: 'STOP', cfg, now: 2_000_000, poolSolReserve: 100 });

  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000 });
  const overTheWire = JSON.parse(JSON.stringify(state));

  assert.equal(overTheWire.scorecard.closedPositions, 1);
  assert.equal(overTheWire.scorecard.winRatePct, 0, 'a resolved loss is 0%, not null');
  assert.equal(overTheWire.scorecard.wins, 0);
  assert.equal(overTheWire.scorecard.losses, 1, 'the denominator travels with the percentage');
});

/* ------------------------------------------------------------------ *
 * 3. The assumed-pool disclosure reaches the wire, and never over-fires
 * ------------------------------------------------------------------ */

test('a fill priced against the floor is badged, and counted in a warning', async () => {
  const { buildDashboardState } = await DASH();
  // Explicit null: a lookup was made and came back empty, which is the case
  // poolFloorSol exists for.
  const { book, cfg } = await bookWith(2, { poolSolReserve: null });

  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000 });

  assert.ok(state.positions.every((p) => p.assumedPool === true));
  assert.ok(state.positions.every((p) => p.poolMeasured === false));
  assert.equal(state.scorecard.flooredFills, 2);

  const warn = state.warnings.find((w) => w.code === 'ASSUMED_POOL');
  assert.ok(warn, 'the disclosure cannot be dropped by a refactor without this going red');
  assert.equal(warn.count, 2);
  assert.match(warn.message, /ASSUMED pool floor/);
});

test('a measured pool raises no badge', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(2, { poolSolReserve: 120 });

  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000 });

  assert.ok(state.positions.every((p) => p.poolMeasured === true));
  assert.ok(state.positions.every((p) => p.assumedPool === false));
  assert.equal(state.scorecard.flooredFills, 0);
  assert.equal(state.warnings.find((w) => w.code === 'ASSUMED_POOL'), undefined);
});

test('"nobody looked" is not "looked and found none" — model off never lights the floor badge', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(2, { poolSolReserve: 100, cfg: { liquidityModel: false } });

  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000 });

  // Three states, and collapsing them is exactly the edit this plan refused.
  assert.ok(state.positions.every((p) => p.poolMeasured === null), 'depth was never spoken about');
  assert.ok(state.positions.every((p) => p.assumedPool === false), 'strict === false, so null cannot badge');
  assert.equal(state.warnings.find((w) => w.code === 'ASSUMED_POOL'), undefined);

  // But the header must say the equity figure now means something different:
  // no impact was charged at all.
  const off = state.warnings.find((w) => w.code === 'LIQUIDITY_MODEL_OFF');
  assert.ok(off, 'a book trading against infinite depth has to say so');
  assert.match(off.message, /infinite depth/);
});

/* ------------------------------------------------------------------ *
 * 4. Only the focused mint carries history
 * ------------------------------------------------------------------ */

test('history is attached to the focused mint alone', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(5);

  const seriesByMint = Object.fromEntries(
    Object.keys(book.positions).map((mint) => [mint, series(300)])
  );

  const state = buildDashboardState(book, cfg, {
    solUsd: 86.5,
    now: 2_000_000,
    focusedMint: 'MINT02',
    seriesByMint,
    marksByMint: { MINT02: [{ t: 1_000_000, priceUsd: 0.00004312, kind: 'ENTRY', label: 'entry' }] },
  });

  const focused = state.positions.find((p) => p.mint === 'MINT02');
  assert.equal(focused.series.length, 300);
  assert.equal(focused.marks.length, 1);

  // Null, not []. An empty array reads as "charted, no data"; null reads as
  // "not charted", which is what is true of a card showing only a number.
  for (const p of state.positions.filter((p) => p.mint !== 'MINT02')) {
    assert.equal(p.series, null, `${p.mint} must not carry history it will never draw`);
    assert.equal(p.marks, null);
  }
});

test('the cap keeps the NEWEST points, not the first ones', async () => {
  const { buildDashboardState, SERIES_POINT_LIMIT } = await DASH();
  const { book, cfg } = await bookWith(1);

  const long = series(1000);
  const state = buildDashboardState(book, cfg, {
    solUsd: 86.5,
    now: 2_000_000,
    focusedMint: 'MINT00',
    seriesByMint: { MINT00: long },
  });

  const s = state.positions[0].series;
  assert.equal(s.length, SERIES_POINT_LIMIT);
  // slice(0, 300) would pin the chart to the moment the position opened and
  // then never move again, while still rendering as a working chart.
  assert.deepStrictEqual(s[s.length - 1], long[long.length - 1], 'the last sample is the latest one');
  assert.deepStrictEqual(s[0], long[long.length - SERIES_POINT_LIMIT]);
  assert.equal(state.positions[0].seriesTruncated, true);
});

test('the span is measured from the samples, so the axis cannot claim a window the data lacks', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(1);

  // 300 points is 25 minutes at --watch 5 and 5 minutes at --watch 1. The span
  // is therefore read off the timestamps rather than assumed from a cadence.
  const fast = series(300, { stepMs: 1_000 });
  const state = buildDashboardState(book, cfg, {
    solUsd: 86.5,
    now: 2_000_000,
    focusedMint: 'MINT00',
    seriesByMint: { MINT00: fast },
  });

  assert.equal(state.positions[0].seriesSpanMs, 299 * 1_000, '299 gaps at 1s, not 25 minutes');
});

test('focusing a mint the book no longer holds resolves to null rather than an empty chart', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(2);

  const state = buildDashboardState(book, cfg, {
    solUsd: 86.5,
    now: 2_000_000,
    focusedMint: 'CLOSED_LAST_TICK',
    seriesByMint: { CLOSED_LAST_TICK: series(50) },
  });

  // The client is told what was actually focused, not what it asked for, so it
  // knows to pick again instead of rendering a blank it cannot tell from flat.
  assert.equal(state.focusedMint, null);
  assert.ok(state.positions.every((p) => p.series === null));
});

test('ten open positions stay under 50KB, and would not if every card carried history', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(10);

  const seriesByMint = Object.fromEntries(
    Object.keys(book.positions).map((mint) => [mint, series(300)])
  );

  const state = buildDashboardState(book, cfg, {
    solUsd: 86.5,
    now: 2_000_000,
    focusedMint: 'MINT00',
    seriesByMint,
  });

  const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  assert.ok(bytes < 50_000, `focused frame was ${bytes} bytes, budget is 50,000`);

  // The counterfactual, asserted so the optimisation cannot be quietly undone:
  // ten series at ~12.3KB each is the 123KB frame this design exists to avoid.
  const allSeries = state.positions.map((p) => ({ ...p, series: seriesByMint[p.mint] }));
  const naive = Buffer.byteLength(JSON.stringify({ ...state, positions: allSeries }), 'utf8');
  assert.ok(naive > 100_000, `a series on every card would be ${naive} bytes`);
});

/* ------------------------------------------------------------------ *
 * 5. Both USD framings travel together
 * ------------------------------------------------------------------ */

test('a USD-funded book carries the start rate alongside the equity figure', async () => {
  const { buildDashboardState } = await DASH();
  const { createBook, paperConfig } = await PC();

  const cfg = paperConfig({ budgetSol: 1000, perTradeSol: 1, pctWhale: null });
  const book = createBook({ budgetUsd: 4000, solUsd: 86.5 });

  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000 });

  assert.equal(state.scorecard.budgetUsdAtStart, 4000);
  assert.equal(state.scorecard.solUsdAtStart, 86.5);
  assert.ok(state.usdFraming, 'the framing must exist whenever the book was funded in dollars');
  assert.ok(Math.abs(state.usdFraming.equityUsd - 4000) < 1e-6);
  assert.ok(Math.abs(state.usdFraming.vsStartUsd) < 1e-6, 'no trades, no move, no gain');

  const overTheWire = JSON.parse(JSON.stringify(state));
  assert.equal(overTheWire.usdFraming.budgetUsdAtStart, 4000, 'the "vs start" line cannot quietly disappear');
  assert.equal(overTheWire.usdFraming.solUsdAtStart, 86.5);
});

test('a SOL price move alone is separated from anything trading did', async () => {
  const { buildDashboardState } = await DASH();
  const { createBook, paperConfig } = await PC();

  const cfg = paperConfig({ budgetSol: 1000, perTradeSol: 1, pctWhale: null });
  const book = createBook({ budgetUsd: 4000, solUsd: 86.5 });

  // Not one trade placed. SOL goes to $90.
  const state = buildDashboardState(book, cfg, { solUsd: 90, now: 2_000_000 });
  const f = state.usdFraming;

  // ~46.24 SOL x $90 = ~$4,161. The draft would have shown this as a 4% gain.
  assert.ok(Math.abs(f.equityUsd - (4000 / 86.5) * 90) < 1e-6);
  assert.ok(Math.abs(f.tradingPnlUsd) < 1e-9, 'trading did nothing, and says so');
  assert.ok(f.solDriftUsd > 160 && f.solDriftUsd < 162, `the entire move is SOL drift, got ${f.solDriftUsd}`);

  // The identity that makes the decomposition exact rather than an estimate.
  assert.ok(
    Math.abs(f.vsStartUsd - (f.tradingPnlUsd + f.solDriftUsd)) < 1e-9,
    'vsStartUsd must be exactly trading + drift'
  );
});

test('the identity holds when trading and SOL both move', async () => {
  const { buildDashboardState } = await DASH();
  const { createBook, openPaperPosition, markPosition, paperConfig } = await PC();

  const cfg = paperConfig({ budgetSol: 1000, perTradeSol: 5, pctWhale: null, slippagePct: 0, feeSol: 0 });
  const book = createBook({ budgetUsd: 4000, solUsd: 86.5 });
  openPaperPosition(book, { mint: 'M', priceUsd: 1, cfg, now: 1_000_000, poolSolReserve: 500 });
  markPosition(book.positions.M, 1.4, 1_000_000);

  const f = buildDashboardState(book, cfg, { solUsd: 91.25, now: 2_000_000 }).usdFraming;

  assert.ok(f.tradingPnlUsd > 0, 'the position is up');
  assert.ok(f.solDriftUsd > 0, 'SOL is up too');
  assert.ok(Math.abs(f.vsStartUsd - (f.tradingPnlUsd + f.solDriftUsd)) < 1e-9);
});

test('a SOL-funded book makes no USD claim at all', async () => {
  const { buildDashboardState } = await DASH();
  const { createBook, paperConfig } = await PC();

  const cfg = paperConfig({ budgetSol: 50, perTradeSol: 1, pctWhale: null });
  const book = createBook({ budgetSol: 50 });

  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000 });

  // There is no honest "vs start USD" for a book that never started in dollars,
  // so the page is given nothing to render rather than a number to invent.
  assert.equal(state.usdFraming, null);
  assert.equal(state.scorecard.budgetUsdAtStart, null);
});

/* ------------------------------------------------------------------ *
 * 5. The server binds, answers, and closes
 * ------------------------------------------------------------------ *
 *
 * Port 0 throughout: the OS assigns one. A test that asserts port 3000 fails
 * whenever anything else on the machine holds it, which teaches people to
 * ignore a red suite.
 */

/** Bind on an ephemeral port, run `fn`, always close. */
async function withServer(opts, fn) {
  const { createDashboardServer } = await DASH();
  const res = await createDashboardServer({ host: '127.0.0.1', port: 0, ...opts });
  assert.equal(res.ok, true, `server failed to bind: ${res.message ?? ''}`);
  try {
    return await fn(res);
  } finally {
    await res.close();
  }
}

test('the server binds on an ephemeral port and answers /api/state with the state object', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(2);

  await withServer(
    { getState: () => buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000 }) },
    async ({ port, urls }) => {
      assert.ok(port > 0, 'the OS assigned a port');
      // The REPORTED port is server.address().port, not the requested 0 — which
      // is also what keeps the banner honest after an EADDRINUSE fallback.
      assert.equal(urls.local, `http://127.0.0.1:${port}`);
      assert.equal(urls.exposed, false, 'loopback binding is not exposed');

      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.equal(res.headers.get('cache-control'), 'no-store');

      const state = await res.json();
      assert.equal(state.scorecard.activePositions, 2);
      assert.equal(state.positions.length, 2);
      assert.equal(state.scorecard.winRatePct, null, 'null survives the actual HTTP round trip');
    }
  );
});

test('GET / serves the page, with a CSP that forbids reaching a CDN', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(1);

  await withServer({ getState: () => buildDashboardState(book, cfg, { solUsd: 86.5 }) }, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);

    // The no-dependency rule, enforced by the browser rather than by review.
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);

    const html = await res.text();
    assert.match(html, /<title>Aegis Paper Book<\/title>/);
    assert.doesNotMatch(html, /<script[^>]+src=/i, 'no external script may be pulled in');
    assert.doesNotMatch(html, /<link[^>]+stylesheet/i, 'no external stylesheet either');
  });
});

test('the focus query reaches getState, so only one series is ever built', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(3);
  const seriesByMint = Object.fromEntries(Object.keys(book.positions).map((m) => [m, series(300)]));

  const seen = [];
  const getState = ({ focusedMint }) => {
    seen.push(focusedMint);
    return buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000, focusedMint, seriesByMint });
  };

  await withServer({ getState }, async ({ port }) => {
    const plain = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(seen[0], null, 'no focus asked for, none invented');
    assert.ok(plain.positions.every((p) => p.series === null));

    const focused = await (await fetch(`http://127.0.0.1:${port}/api/state?focus=MINT01`)).json();
    assert.equal(seen[1], 'MINT01');
    assert.equal(focused.focusedMint, 'MINT01');
    assert.equal(focused.positions.filter((p) => p.series !== null).length, 1, 'exactly one series on the wire');
  });
});

test('a getState that throws returns 500 and leaves the server standing', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(1);

  let explode = true;
  const getState = () => {
    if (explode) throw new Error('book is mid-write');
    return buildDashboardState(book, cfg, { solUsd: 86.5 });
  };

  await withServer({ getState }, async ({ port }) => {
    const bad = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(bad.status, 500);
    assert.match((await bad.json()).message, /mid-write/);

    // The UI must never be able to take down the thing it is looking at.
    explode = false;
    const good = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(good.status, 200, 'the server survived its own 500');
  });
});

test('the server is read-only: no method other than GET or HEAD is accepted', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(1);

  await withServer({ getState: () => buildDashboardState(book, cfg, { solUsd: 86.5 }) }, async ({ port }) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`, { method });
      assert.equal(res.status, 405, `${method} must be refused`);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
    }
    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(missing.status, 404);
    // Phase 3's route exists but is honest about not being built yet.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/stream`)).status, 501);
  });
});

/* ------------------------------------------------------------------ *
 * 6. A busy port is an outcome, not an exception
 * ------------------------------------------------------------------ */

test('EADDRINUSE resolves an error instead of throwing, and names the fix', async () => {
  const { createDashboardServer, buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(1);
  const getState = () => buildDashboardState(book, cfg, { solUsd: 86.5 });

  const first = await createDashboardServer({ host: '127.0.0.1', port: 0, getState });
  assert.equal(first.ok, true);

  try {
    // The correct response to "port 3000 is busy" is a printed line, not a dead
    // engine — the book must never die because a UI could not bind.
    const second = await createDashboardServer({ host: '127.0.0.1', port: first.port, getState });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'EADDRINUSE');
    assert.match(second.message, new RegExp(`port ${first.port} is already in use`));
    assert.match(second.message, /--dashboard-port/, 'the message has to name the way out');

    // And the original is untouched by the failed second bind.
    assert.equal((await fetch(`http://127.0.0.1:${first.port}/api/state`)).status, 200);
  } finally {
    await first.close();
  }
});

test('a bind failure is described in words that name the fix', async () => {
  const { explainListenError } = await DASH();

  assert.match(explainListenError({ code: 'EADDRINUSE' }, { host: '127.0.0.1', port: 3000 }), /--dashboard-port 3001/);
  assert.match(explainListenError({ code: 'EACCES' }, { host: '127.0.0.1', port: 80 }), /need elevation/);
  assert.match(explainListenError({ code: 'EADDRNOTAVAIL' }, { host: '10.1.2.3', port: 3000 }), /not an address on this machine/);
  assert.match(explainListenError({ code: 'ENOTFOUND' }, { host: 'x', port: 1 }), /ENOTFOUND/);
});

test('a server with no state source refuses to bind at all', async () => {
  const { createDashboardServer } = await DASH();
  const res = await createDashboardServer({ port: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_STATE_SOURCE');
});

/* ------------------------------------------------------------------ *
 * 7. SSE frame encoding
 * ------------------------------------------------------------------ */

test('a frame is data plus a blank line, and JSON survives it', async () => {
  const { encodeSseFrame } = await DASH();

  assert.equal(encodeSseFrame({ a: 1 }), 'data: {"a":1}\n\n');
  assert.equal(encodeSseFrame({ a: 1 }, { event: 'state', id: 7 }), 'event: state\nid: 7\ndata: {"a":1}\n\n');
  assert.equal(encodeSseFrame('', { retry: 2000 }), 'retry: 2000\ndata: \n\n');
});

test('a newline in the payload cannot break framing', async () => {
  const { encodeSseFrame } = await DASH();

  // The hazard: a raw newline ends the `data:` line, and a raw blank line ends
  // the EVENT — so one token symbol containing "\n" corrupts the framing of
  // everything after it, not just its own frame. Memecoin tickers contain
  // anything, and this is the same class of bug as innerHTML on a symbol.
  const nasty = { symbol: 'ha\nha\n\ndata: {"equitySol":999999}' };
  const frame = encodeSseFrame(nasty);

  // JSON.stringify escapes the newline, so the whole payload is one data line
  // and the only blank line in the frame is the terminator.
  assert.equal(frame.split('\n\n').length, 2, 'exactly one event terminator');
  assert.equal(frame.match(/^data: /gm).length, 1, 'one data line');

  const [head] = frame.split('\n\n');
  assert.deepStrictEqual(JSON.parse(head.slice('data: '.length)), nasty, 'round trips intact');
});

test('a multi-line STRING payload becomes multiple data lines, per the spec', async () => {
  const { encodeSseFrame } = await DASH();

  // Not everything reaching the encoder is an object. All three of \r, \n and
  // \r\n are line terminators to an SSE parser, so all three are split on and
  // the browser rejoins the data lines with "\n".
  const frame = encodeSseFrame('one\ntwo\r\nthree\rfour');
  assert.equal(frame, 'data: one\ndata: two\ndata: three\ndata: four\n\n');
  assert.equal(frame.split('\n\n').length, 2, 'still exactly one terminator');
});

test('the stream pushes a frame on connect and one per publish, and keeps alive', async () => {
  const { buildDashboardState, createSseHub, createDashboardServer, SSE_KEEPALIVE, KEEPALIVE_MS } = await DASH();
  const { book, cfg } = await bookWith(2);

  assert.equal(KEEPALIVE_MS, 15_000, 'the documented default');

  // The mechanism is tested at 40ms; 15s would make this a 15-second test.
  const hub = createSseHub({ keepaliveMs: 40 });
  const server = await createDashboardServer({
    host: '127.0.0.1',
    port: 0,
    hub,
    getState: ({ focusedMint }) => buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000, focusedMint }),
  });
  assert.equal(server.ok, true);

  try {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readUntil = async (predicate, budgetMs = 3000) => {
      const deadline = Date.now() + budgetMs;
      while (!predicate(buf)) {
        if (Date.now() > deadline) throw new Error(`timed out; buffer so far: ${JSON.stringify(buf.slice(0, 400))}`);
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      return buf;
    };

    // A freshly opened page must not sit blank until the next tick.
    await readUntil((b) => b.includes('retry:') && b.includes('data: '));
    const first = JSON.parse(buf.match(/^data: (.*)$/m)[1]);
    assert.equal(first.scorecard.activePositions, 2);
    assert.equal(first.scorecard.winRatePct, null, 'null survives the stream too');

    // One frame per publish.
    const before = (buf.match(/^data: /gm) || []).length;
    hub.broadcast((focus) => buildDashboardState(book, cfg, { solUsd: 91.25, now: 2_000_000, focusedMint: focus }));
    await readUntil((b) => (b.match(/^data: /gm) || []).length > before);

    // And a comment frame holds the socket open through a quiet stretch.
    await readUntil((b) => b.includes(SSE_KEEPALIVE.trim()));
    assert.ok(buf.includes(':ping'), 'keepalive comment reached the client');

    ac.abort();
  } finally {
    await server.close();
  }
});

test('each viewer keeps its own focus, and a frame is serialised once per distinct focus', async () => {
  const { buildDashboardState, createSseHub } = await DASH();
  const { book, cfg } = await bookWith(3);

  const hub = createSseHub({ keepaliveMs: 0 });
  const writes = [];
  const fakeRes = (focus) => {
    const res = {
      writableLength: 0,
      writeHead() {},
      flushHeaders() {},
      write(chunk) { writes.push({ focus, chunk }); return true; },
      end() {},
      on() {},
    };
    hub.add(res, { focusedMint: focus });
    return res;
  };

  fakeRes('MINT00');
  fakeRes('MINT01');
  fakeRes('MINT00');

  let built = 0;
  writes.length = 0;
  hub.broadcast((focus) => {
    built++;
    return buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000, focusedMint: focus });
  });

  assert.equal(writes.length, 3, 'every client got a frame');
  // A global focus would yank the chart out from under the second viewer; a
  // per-client build for identical focuses would stringify the same bytes twice.
  assert.equal(built, 2, 'two distinct focuses, two builds');
  assert.equal(hub.size, 3);

  const byFocus = {};
  for (const w of writes) byFocus[w.focus] = JSON.parse(w.chunk.slice('data: '.length));
  assert.equal(byFocus.MINT00.focusedMint, 'MINT00');
  assert.equal(byFocus.MINT01.focusedMint, 'MINT01');
});

test('a client that has stopped reading is dropped rather than buffered forever', async () => {
  const { createSseHub, MAX_CLIENT_BUFFER_BYTES } = await DASH();
  const hub = createSseHub({ keepaliveMs: 0 });

  // A suspended browser tab keeps the socket open and stops reading. Dropping
  // is correct — EventSource reconnects and gets the CURRENT frame instead of
  // replaying a queue of stale ones.
  let ended = false;
  hub.add(
    { writableLength: MAX_CLIENT_BUFFER_BYTES + 1, writeHead() {}, flushHeaders() {}, write() {}, end() { ended = true; }, on() {} },
    {}
  );
  assert.equal(hub.size, 1);

  hub.broadcast(() => ({ tick: 1 }));
  assert.equal(hub.size, 0, 'the stalled client is gone');
  assert.equal(ended, true, 'and its response was closed');
});

test('a build that throws produces an error frame instead of taking down the stream', async () => {
  const { createSseHub } = await DASH();
  const hub = createSseHub({ keepaliveMs: 0 });

  const chunks = [];
  hub.add({ writableLength: 0, writeHead() {}, flushHeaders() {}, write(c) { chunks.push(c); return true; }, end() {}, on() {} }, {});

  chunks.length = 0;
  assert.doesNotThrow(() => hub.broadcast(() => { throw new Error('book is mid-write'); }));
  assert.equal(hub.size, 1, 'the client is still connected');
  assert.match(JSON.parse(chunks[0].slice('data: '.length)).message, /mid-write/);
});

/* ------------------------------------------------------------------ *
 * 8. Single writer: the dashboard never touches the book file
 * ------------------------------------------------------------------ */

test('dashboard.mjs imports no writing primitive at all', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../dashboard.mjs', import.meta.url), 'utf8');

  // Structural, and deliberately blunt: the guarantee is that this module
  // CANNOT write, and the cheapest way to keep that true is for the capability
  // never to be imported. A future `writeFile` import fails here first.
  const fsImport = src.match(/import\s*\{([^}]*)\}\s*from\s*'node:fs\/promises'/);
  assert.ok(fsImport, 'the fs import is where it is expected');
  const named = fsImport[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepStrictEqual(named, ['readFile'], 'readFile and nothing else');

  const code = stripComments(src);

  for (const forbidden of ['writeFile', 'appendFile', 'createWriteStream', 'rename', 'unlink', 'mkdir', 'saveBook']) {
    assert.doesNotMatch(code, new RegExp(`\\b${forbidden}\\b`), `dashboard.mjs must not call ${forbidden}`);
  }
  // And the stripper really did leave code behind, or the loop above proves
  // nothing at all.
  assert.match(code, /export function buildDashboardState|export async function startDashboard/);
});

test('serving and streaming leave the book file byte-identical', async () => {
  const { buildDashboardState, createSseHub, createDashboardServer, startDashboard } = await DASH();
  const { detectConcurrentWriter } = await PC();
  const { writeFile, readFile, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const { book, cfg } = await bookWith(3);

  // A stand-in for .state/paper_copytrade.json, written once by "the tick" and
  // never again. saveBook stamps writerPid/writerAt, so this mimics it.
  book.writerPid = process.pid;
  book.writerAt = Date.now();
  const path = join(tmpdir(), `aegis-book-${process.pid}-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(book, null, 2), 'utf8');
  const before = { text: await readFile(path, 'utf8'), mtimeMs: (await stat(path)).mtimeMs };
  const bookBefore = JSON.stringify(book);

  const hub = createSseHub({ keepaliveMs: 0 });
  const server = await createDashboardServer({
    host: '127.0.0.1',
    port: 0,
    hub,
    getState: ({ focusedMint }) => buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000, focusedMint }),
  });
  assert.equal(server.ok, true);

  try {
    await (await fetch(`http://127.0.0.1:${server.port}/api/state`)).json();
    await (await fetch(`http://127.0.0.1:${server.port}/api/state?focus=MINT01`)).json();
    await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    for (let i = 0; i < 5; i++) hub.broadcast((f) => buildDashboardState(book, cfg, { solUsd: 86.5, focusedMint: f }));
  } finally {
    await server.close();
  }

  // The three false diagnoses this prevents — a --reset that appeared not to
  // work, a fresh book that appeared to replay history, settings that appeared
  // to have no effect — all came from a second process writing this file.
  assert.equal(await readFile(path, 'utf8'), before.text, 'the book file is untouched');
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs, 'not even rewritten with identical bytes');
  assert.equal(JSON.stringify(book), bookBefore, 'and the in-memory book is unchanged');

  // The tick remains the only writer on record, so a running engine would not
  // see a rival and refuse to start.
  assert.equal(detectConcurrentWriter(book, { pid: process.pid }), null);

  // And startDashboard — the wiring paper_copytrade actually calls — likewise
  // takes the book by reference and never learns a path.
  const dash = await startDashboard({ port: 0, book, cfg, keepaliveMs: 0, getContext: () => ({ solUsd: 86.5 }) });
  assert.equal(dash.ok, true);
  try {
    dash.publish({ opened: [], exits: [] });
    dash.publish({ opened: [], exits: [] });
    assert.equal(await readFile(path, 'utf8'), before.text, 'publishing writes nothing either');
  } finally {
    await dash.close();
  }

  await (await import('node:fs/promises')).unlink(path);
});

test('the recorder samples open positions, caps them, and forgets closed mints', async () => {
  const { createSeriesRecorder } = await DASH();
  const { applyPaperExit } = await PC();
  const { book, cfg } = await bookWith(2);

  const rec = createSeriesRecorder({ limit: 4 });
  for (let i = 0; i < 10; i++) rec.record(book, 1_000_000 + i * 5000);

  assert.equal(rec.trackedMints, 2);
  assert.equal(rec.seriesByMint.MINT00.length, 4, 'capped');
  assert.equal(rec.seriesByMint.MINT00[3].t, 1_000_000 + 9 * 5000, 'newest kept');

  // The entry marker is seeded at the FILL price, so it lands where the trade
  // happened rather than where the mid was.
  const entry = rec.marksByMint.MINT00.find((m) => m.kind === 'ENTRY');
  assert.ok(entry);
  assert.equal(entry.priceUsd, book.positions.MINT00.entryPriceUsd);

  applyPaperExit(book, 'MINT00', { priceUsd: 1.4, trigger: 'TP1', cfg, now: 2_000_000, poolSolReserve: 100 });
  rec.record(book, 2_000_000);

  // A long session's memory tracks what is OPEN, not everything ever held.
  assert.equal(rec.trackedMints, 1);
  assert.equal(rec.seriesByMint.MINT00, undefined);
  assert.equal(rec.marksByMint.MINT00, undefined);
});

/* ------------------------------------------------------------------ *
 * 9. Tier A chart geometry
 * ------------------------------------------------------------------ *
 *
 * Imported from dashboard.mjs, which re-exports the very file the browser
 * loads as /chart.mjs. What is asserted here is what draws.
 */

test('the projection puts the first sample at the left edge and the last at the right', async () => {
  const { buildChartGeometry } = await DASH();

  const geo = buildChartGeometry({
    series: [
      { t: 0, priceUsd: 1 },
      { t: 1000, priceUsd: 2 },
      { t: 2000, priceUsd: 3 },
    ],
    width: 640,
    height: 220,
  });

  assert.equal(geo.ok, true);
  assert.deepStrictEqual(geo.plot, { x: 58, y: 10, w: 572, h: 190 });
  assert.equal(geo.first.x, 58);
  assert.equal(geo.last.x, 630);
  assert.deepStrictEqual(geo.xDomain, [0, 2000]);

  // 8% headroom top and bottom, so the extremes are not welded to the frame.
  assert.ok(Math.abs(geo.yDomain[0] - 0.84) < 1e-9);
  assert.ok(Math.abs(geo.yDomain[1] - 3.16) < 1e-9);
  assert.equal(geo.first.y, 186.9, 'the cheapest sample sits low');
  assert.equal(geo.last.y, 23.1, 'the dearest sits high');
  assert.equal(geo.segments.length, 1);
  assert.match(geo.path, /^M 58 186\.9 L 344 /);
});

test('the y-axis stretches to hold a marker that sits outside the samples', async () => {
  const { buildChartGeometry } = await DASH();

  // The usual case: a position entered at 1.00, sampled only after it ran to
  // 5.00. Without marker prices in the domain the entry dot is clipped off the
  // bottom edge with no explanation.
  const geo = buildChartGeometry({
    series: [
      { t: 1000, priceUsd: 5 },
      { t: 2000, priceUsd: 6 },
    ],
    marks: [{ t: 1000, priceUsd: 1, kind: 'ENTRY', label: 'entry' }],
  });

  assert.ok(geo.yDomain[0] < 1, 'the entry price is inside the domain');
  const entry = geo.markers.find((m) => m.kind === 'ENTRY');
  assert.ok(entry.y <= geo.plot.y + geo.plot.h, 'and therefore on the canvas');
  assert.ok(entry.y > geo.points[0].y, 'below the first sample, as it should be');
});

test('a marker from before the sampled window is clamped to the edge and says so', async () => {
  const { buildChartGeometry } = await DASH();

  // Positions are routinely older than the recorder, which starts when the
  // dashboard does. Drawing that ENTRY at the left edge as though it happened
  // there would be a lie about when the trade was.
  const geo = buildChartGeometry({
    series: [
      { t: 10_000, priceUsd: 2 },
      { t: 20_000, priceUsd: 3 },
    ],
    marks: [
      { t: 500, priceUsd: 1.5, kind: 'ENTRY', label: 'entry' },
      { t: 15_000, priceUsd: 2.5, kind: 'TP', label: 'TP1' },
      { t: 99_000, priceUsd: 3.5, kind: 'EXIT', label: 'stop' },
    ],
  });

  const byKind = Object.fromEntries(geo.markers.map((m) => [m.kind, m]));
  assert.equal(byKind.ENTRY.clamped, true);
  assert.equal(byKind.ENTRY.clampedFrom, 'before');
  assert.equal(byKind.ENTRY.x, geo.plot.x, 'pinned to the left edge');
  assert.equal(byKind.ENTRY.t, 500, 'but the real timestamp is preserved for the tooltip');

  assert.equal(byKind.EXIT.clamped, true);
  assert.equal(byKind.EXIT.clampedFrom, 'after');
  assert.equal(byKind.EXIT.x, geo.plot.x + geo.plot.w);

  assert.equal(byKind.TP.clamped, false, 'a marker inside the window is not clamped');
});

test('markers paint in a fixed order so an exit is never hidden under an entry', async () => {
  const { buildChartGeometry, MARK_KINDS } = await DASH();
  assert.deepStrictEqual(MARK_KINDS, ['ENTRY', 'SCALE', 'TP', 'EXIT']);

  const geo = buildChartGeometry({
    series: [{ t: 0, priceUsd: 1 }, { t: 1000, priceUsd: 2 }],
    marks: [
      { t: 900, kind: 'EXIT', label: 'stop' },
      { t: 100, kind: 'ENTRY', label: 'entry' },
      { t: 500, kind: 'TP', label: 'TP1' },
      { t: 300, kind: 'SCALE', label: 'scale-in' },
    ],
  });

  assert.deepStrictEqual(geo.markers.map((m) => m.kind), ['ENTRY', 'SCALE', 'TP', 'EXIT']);
});

test('a marker with no price of its own rides the line', async () => {
  const { buildChartGeometry } = await DASH();

  // noteReport records a SCALE without a price when the report carries none.
  // Dropping the marker would lose the event; placing it at zero would drag the
  // whole y-axis down to nothing.
  const geo = buildChartGeometry({
    series: [{ t: 0, priceUsd: 1 }, { t: 1000, priceUsd: 2 }, { t: 2000, priceUsd: 3 }],
    marks: [{ t: 1000, kind: 'SCALE', label: 'scale-in' }],
  });

  const scale = geo.markers[0];
  assert.equal(scale.priceUsd, 2, 'takes the sampled price at its own timestamp');
  assert.equal(scale.y, geo.points[1].y, 'and lands exactly on the line');
});

/* ── gaps ─────────────────────────────────────────────────────────────── */

test('a stall breaks the line instead of drawing through it', async () => {
  const { buildChartGeometry } = await DASH();

  // Four 5s samples, a four-minute hole, then two more. A single path across
  // that hole is a claim about four minutes nobody watched.
  const series = [
    { t: 0, priceUsd: 1.0 },
    { t: 5_000, priceUsd: 1.1 },
    { t: 10_000, priceUsd: 1.2 },
    { t: 250_000, priceUsd: 3.0 },
    { t: 255_000, priceUsd: 3.1 },
  ];
  const geo = buildChartGeometry({ series });

  assert.equal(geo.segments.length, 2, 'two strokes, not one');
  assert.equal(geo.gaps.length, 1);
  assert.equal(geo.gaps[0].durationMs, 240_000);
  assert.equal(geo.sampleIntervalMs, 5_000, 'the median ignores the outlier');
  // Every sample is still plotted; only the connecting stroke is withheld.
  assert.equal(geo.points.length, 5);
  assert.equal(geo.segments[0].match(/L /g).length, 2);
});

test('an even cadence produces exactly one unbroken stroke', async () => {
  const { buildChartGeometry } = await DASH();
  const series = Array.from({ length: 40 }, (_, i) => ({ t: i * 5000, priceUsd: 1 + i / 100 }));
  const geo = buildChartGeometry({ series });

  assert.equal(geo.segments.length, 1);
  assert.deepStrictEqual(geo.gaps, []);
});

test('the cadence is measured, so a --watch 1 chart cannot claim 5 seconds', async () => {
  const { buildChartGeometry, describeChart } = await DASH();

  const fast = buildChartGeometry({ series: Array.from({ length: 30 }, (_, i) => ({ t: i * 1000, priceUsd: 1 })) });
  const slow = buildChartGeometry({ series: Array.from({ length: 30 }, (_, i) => ({ t: i * 5000, priceUsd: 1 })) });

  assert.equal(fast.sampleIntervalMs, 1000);
  assert.equal(slow.sampleIntervalMs, 5000);
  assert.match(describeChart(fast), /~1s cadence/);
  assert.match(describeChart(slow), /~5s cadence/);
});

test('the cadence baseline is the smallest gap, because a stall must not inflate it', async () => {
  const { samplingCadenceMs, buildChartGeometry, describeChart } = await DASH();

  // The median was the first choice and it is wrong here: with gaps of 5s and
  // 395s the median IS their mean, 200s — the stall inflates the very baseline
  // meant to detect it, so no gap is found and four unobserved minutes get a
  // straight line drawn through them. Caught on a 3-point series.
  assert.equal(samplingCadenceMs([5_000, 395_000]), 5_000);
  assert.equal(samplingCadenceMs([5_000, 5_000, 240_000, 5_000]), 5_000);
  assert.equal(samplingCadenceMs([]), null);
  assert.equal(samplingCadenceMs([0, 0]), null, 'a zero gap measures nothing');

  const short = buildChartGeometry({
    series: [{ t: 0, priceUsd: 1 }, { t: 5_000, priceUsd: 1 }, { t: 400_000, priceUsd: 2 }],
  });
  assert.equal(short.sampleIntervalMs, 5_000, 'not 200,000');
  assert.equal(short.gaps.length, 1, 'and the hole is found even with three points');
  assert.match(describeChart(short), /~5s cadence/);
});

test('the caption reports holes, and never calls these candles', async () => {
  const { buildChartGeometry, describeChart } = await DASH();

  const clean = describeChart(buildChartGeometry({ series: [{ t: 0, priceUsd: 1 }, { t: 5000, priceUsd: 2 }] }));
  assert.match(clean, /2 marks/);
  assert.doesNotMatch(clean, /gap/);

  const holed = describeChart(
    buildChartGeometry({
      series: [{ t: 0, priceUsd: 1 }, { t: 5_000, priceUsd: 1 }, { t: 400_000, priceUsd: 2 }],
    })
  );
  assert.match(holed, /1 gap — the line is broken where nothing was sampled/);
  assert.equal(describeChart({ ok: false }), 'no samples yet');
});

/* ── degenerate inputs ────────────────────────────────────────────────── */

test('a flat series draws instead of dividing by zero', async () => {
  const { buildChartGeometry } = await DASH();
  const geo = buildChartGeometry({ series: Array.from({ length: 5 }, (_, i) => ({ t: i * 5000, priceUsd: 0.0001 })) });

  assert.equal(geo.ok, true);
  assert.ok(geo.yDomain[0] < geo.yDomain[1], 'a nominal range was invented rather than NaN');
  assert.ok(geo.points.every((p) => Number.isFinite(p.y)));
  const mid = geo.plot.y + geo.plot.h / 2;
  assert.ok(geo.points.every((p) => Math.abs(p.y - mid) < 0.2), 'and it draws centred');
});

test('one sample, and no samples, are both handled', async () => {
  const { buildChartGeometry } = await DASH();

  const one = buildChartGeometry({ series: [{ t: 5000, priceUsd: 2 }] });
  assert.equal(one.ok, true);
  assert.equal(one.points.length, 1);
  assert.equal(one.sampleIntervalMs, null, 'no interval can be measured from one point');
  assert.ok(one.path.startsWith('M '), 'a degenerate path still renders a dot');
  assert.equal(one.first.x, one.plot.x + one.plot.w / 2, 'a single point is centred, not pinned left');

  for (const empty of [[], null, undefined, [{ t: 1, priceUsd: 0 }], [{ t: NaN, priceUsd: 1 }]]) {
    const geo = buildChartGeometry({ series: empty });
    assert.equal(geo.ok, false, `${JSON.stringify(empty)} must not produce a chart`);
    assert.equal(geo.reason, 'no samples');
    assert.deepStrictEqual(geo.markers, []);
  }
});

test('a 300-point series projects to a path small enough to re-send every tick', async () => {
  const { buildChartGeometry, SERIES_POINT_LIMIT } = await DASH();
  const series = Array.from({ length: SERIES_POINT_LIMIT }, (_, i) => ({
    t: i * 5000,
    priceUsd: 0.00004312 * (1 + Math.sin(i / 12) * 0.3),
  }));

  const geo = buildChartGeometry({ series, width: 640, height: 240 });
  assert.equal(geo.points.length, 300);
  // Coordinates are rounded to a tenth of a pixel — invisible on screen, and
  // it keeps the path string from being the largest thing on the page.
  assert.ok(geo.path.length < 6000, `path was ${geo.path.length} chars`);
  assert.doesNotMatch(geo.path, /\d\.\d\d/, 'no coordinate carries more than one decimal');
});

/* ── the module is served, and only it ────────────────────────────────── */

test('/chart.mjs is served as JavaScript, and the allowlist is still an allowlist', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(1);

  await withServer({ getState: () => buildDashboardState(book, cfg, { solUsd: 86.5 }) }, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/chart.mjs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/javascript/);
    const body = await res.text();
    assert.match(body, /export function buildChartGeometry/);
    assert.doesNotMatch(body, /require\(|from '(?!\.)/, 'the browser copy pulls in nothing');

    // Adding a second file did not turn this into a static file server.
    for (const probe of ['/public/chart.mjs', '/../dashboard.mjs', '/chart.mjs/../../.env', '/.env', '/package.json']) {
      const r = await fetch(`http://127.0.0.1:${port}${probe}`);
      assert.ok(r.status === 404 || r.status === 400, `${probe} must not resolve (got ${r.status})`);
    }
  });
});

test('the page imports the chart module rather than carrying a second copy', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(html, /<script type="module">/);
  assert.match(html, /import \{ buildChartGeometry, describeChart \} from '\.\/chart\.mjs'/);
  // Still nothing fetched from outside this server.
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  assert.doesNotMatch(html, /https?:\/\/(?!gmgn\.ai|solscan\.io|dexscreener\.com|www\.w3\.org)/,
    'the only absolute URLs are the explorer links and the SVG namespace');
});

/* ------------------------------------------------------------------ *
 * 10. Tier B — off by default, and off means off
 * ------------------------------------------------------------------ */

test('by default nothing can reach dexscreener.com: no URL, no frame-src, no capability', async () => {
  const { buildDashboardState, cspFor } = await DASH();
  const { book, cfg } = await bookWith(3);

  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000 });

  // The three independent locks, each of which alone would stop it.
  assert.equal(state.mode.embed.enabled, false);
  assert.equal(state.mode.embed.origin, null);
  assert.ok(state.positions.every((p) => p.embedUrl === null), 'the page is given no URL to frame');
  assert.match(cspFor({}), /frame-src 'none'/);
  assert.doesNotMatch(cspFor({}), /dexscreener/, 'the default policy never names them');
});

test('the default page really is served with frame-src none', async () => {
  const { buildDashboardState } = await DASH();
  const { book, cfg } = await bookWith(1);

  await withServer({ getState: () => buildDashboardState(book, cfg, { solUsd: 86.5 }) }, async ({ port }) => {
    const csp = (await fetch(`http://127.0.0.1:${port}/`)).headers.get('content-security-policy');
    assert.match(csp, /frame-src 'none'/);
    assert.match(csp, /default-src 'none'/);
  });
});

test('--dashboard-embed opens exactly one origin and nothing else', async () => {
  const { buildDashboardState, cspFor, EMBED_ORIGIN } = await DASH();
  const { book, cfg } = await bookWith(2);

  const csp = cspFor({ embed: true });
  assert.match(csp, /frame-src https:\/\/dexscreener\.com/);
  // Everything else stays shut. An embed must not become a general escape.
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /connect-src[^;]*dexscreener/);
  assert.doesNotMatch(csp, /script-src[^;]*dexscreener/);

  const state = buildDashboardState(book, cfg, { solUsd: 86.5, now: 2_000_000, embed: true });
  assert.equal(state.mode.embed.enabled, true);
  assert.equal(state.mode.embed.origin, EMBED_ORIGIN);
  assert.ok(state.positions.every((p) => p.embedUrl.startsWith(EMBED_ORIGIN + '/solana/')));
});

test('the embed URL is built from the mint, and the mint is encoded', async () => {
  const { dexScreenerEmbedUrl } = await DASH();

  // Verified against dexscreener.com: ?embed=1 accepts a TOKEN MINT and
  // resolves it to a pair itself. The book has no pair address to offer, so
  // this is the property the whole tier depends on.
  const url = dexScreenerEmbedUrl('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://dexscreener.com');
  assert.equal(parsed.pathname, '/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  assert.equal(parsed.searchParams.get('embed'), '1');
  assert.equal(parsed.searchParams.get('theme'), 'dark');
  assert.equal(parsed.searchParams.get('trades'), '0');
  assert.equal(parsed.searchParams.get('info'), '0');
  assert.equal(parsed.searchParams.get('interval'), null, 'no timeframe is requested unless asked for');

  assert.equal(new URL(dexScreenerEmbedUrl('X', { interval: '1S' })).searchParams.get('interval'), '1S');

  // Base58 needs no encoding, which is exactly why it is easy to forget that
  // this value arrives from chain data through a JSON payload.
  assert.ok(dexScreenerEmbedUrl('../../etc/passwd?x=1#y').startsWith('https://dexscreener.com/solana/..%2F..%2F'));
  for (const bad of [null, undefined, '', 42, {}]) assert.equal(dexScreenerEmbedUrl(bad), null);
});

test('the page frames only what the server handed it, in a locked-down iframe', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const code = stripComments(html);

  // The src comes from state, never from a literal in the page — so with Tier B
  // off there is nothing for the renderer to fall back to.
  assert.match(code, /frame\.src = p\.embedUrl/);
  assert.doesNotMatch(code, /dexscreener\.com\/solana\/[^"']*embed=/, 'no hardcoded embed URL');

  // allow-scripts allow-same-origin, and nothing more.
  //
  // allow-scripts ALONE is measurably wrong: an opaque origin has no storage,
  // so their settings load hangs at a distinct earlier stage. allow-same-origin
  // clears that, and because the frame is CROSS-origin it hands us nothing
  // away — the "framed document strips its own sandbox" warning is a
  // same-origin one.
  const sandbox = code.match(/setAttribute\('sandbox', '([^']*)'\)/);
  assert.ok(sandbox, 'the frame is sandboxed');
  assert.deepStrictEqual(sandbox[1].split(' ').sort(), ['allow-same-origin', 'allow-scripts']);

  // What the sandbox is actually for, and the reason it is kept.
  for (const never of ['allow-top-navigation', 'allow-popups', 'allow-forms', 'allow-modals', 'allow-downloads']) {
    assert.ok(!sandbox[1].includes(never), `a chart does not need ${never}`);
  }
  assert.match(code, /setAttribute\('referrerpolicy', 'no-referrer'\)/);

  // Consent is per session. One that survives a reload is one nobody remembers
  // giving.
  assert.doesNotMatch(code, /localStorage|sessionStorage|document\.cookie/);
});

test('every focus control reopens the stream, or the next frame undoes it', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const code = stripComments(html);

  // The focus lives in the STREAM's query string. A control that only calls
  // refresh() updates one frame and is then overwritten by the next SSE push —
  // which is exactly what the token tabs did when they were first written.
  assert.match(code, /function setFocus\(mint\)/);
  assert.match(code, /refresh\(\)\.then\(connect\)/);

  const handlers = code.match(/S\.focus = [^;]+;\s*\n\s*refresh\(\);/g) ?? [];
  assert.deepStrictEqual(handlers, [], 'a focus control must go through setFocus');

  // Both controls exist and both use it.
  assert.equal((code.match(/setFocus\(S\.focus === p\.mint \? null : p\.mint\)/g) ?? []).length, 2,
    'the position card and the token tab');
});

test('a rebuild is skipped when nothing changed, so the frame is not re-requested every second', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  // render() runs once a second. Without this guard the <iframe> would be
  // recreated on every frame, re-requesting dexscreener.com once a second.
  assert.match(html, /if \(S\.embedRendered === desired\) return;/);
  assert.match(html, /S\.embedRendered = desired;/);
});

/* ------------------------------------------------------------------ *
 * Binding description and the terminal line
 * ------------------------------------------------------------------ */

test('a LAN URL is only printed when the server is actually reachable on the LAN', async () => {
  const { describeBinding } = await DASH();
  const interfaces = () => ({
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'Wi-Fi': [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
  });

  // http://localhost:3000 on a phone resolves to THE PHONE. Printing a LAN URL
  // that does not work is worse than printing none.
  const loopback = describeBinding('127.0.0.1', 3000, { interfaces });
  assert.deepStrictEqual(loopback.lan, []);
  assert.equal(loopback.exposed, false);

  const wildcard = describeBinding('0.0.0.0', 3000, { interfaces });
  assert.equal(wildcard.exposed, true);
  assert.deepStrictEqual(wildcard.lan, ['http://192.168.1.42:3000'], 'internal interfaces are not LAN addresses');
});

test('the terminal link degrades to a bare URL where OSC 8 is not supported', async () => {
  const { terminalLink } = await DASH();

  // Legacy conhost does not implement OSC 8; Windows Terminal auto-links a bare
  // URL anyway, so the fallback loses nothing.
  assert.equal(terminalLink('http://127.0.0.1:3000', 'http://127.0.0.1:3000', { isTTY: false }), 'http://127.0.0.1:3000');

  const linked = terminalLink('http://127.0.0.1:3000', 'open', { isTTY: true });
  assert.ok(linked.includes('\x1b]8;;http://127.0.0.1:3000\x1b\\open'));
  assert.ok(linked.endsWith('\x1b]8;;\x1b\\'), 'the sequence has to be closed or the rest of the line becomes a link');
});

test('the banner warns when the page is readable by the whole network', async () => {
  const { dashboardBanner, describeBinding } = await DASH();
  const interfaces = () => ({ 'Wi-Fi': [{ address: '192.168.1.42', family: 'IPv4', internal: false }] });

  const quiet = dashboardBanner(describeBinding('127.0.0.1', 3000, { interfaces }));
  assert.match(quiet, /http:\/\/127\.0\.0\.1:3000/);
  assert.doesNotMatch(quiet, /Wi-Fi|network/i);

  const loud = dashboardBanner(describeBinding('0.0.0.0', 3000, { interfaces }));
  assert.match(loud, /192\.168\.1\.42:3000/);
  assert.match(loud, /anyone on this Wi-Fi can read this page/);
});

test('no spot price means no USD figures anywhere, rather than a fallback constant', async () => {
  const { buildDashboardState } = await DASH();
  const { createBook, paperConfig } = await PC();

  const cfg = paperConfig({ budgetSol: 1000, perTradeSol: 1, pctWhale: null });
  const book = createBook({ budgetUsd: 4000, solUsd: 86.5 });

  const state = buildDashboardState(book, cfg, { solUsd: null, now: 2_000_000 });

  assert.equal(state.solUsd, null);
  assert.equal(state.usdFraming, null, 'a wrong price is worse than a page that says it could not price itself');
});
