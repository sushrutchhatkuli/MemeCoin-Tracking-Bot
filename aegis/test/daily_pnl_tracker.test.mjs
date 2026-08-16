import test from 'node:test';
import assert from 'node:assert/strict';

const DT = () => import('../daily_pnl_tracker.mjs');
const DAY_MS = 24 * 3600 * 1000;

/* ------------------------------------------------------------------ *
 * The reset anchor
 * ------------------------------------------------------------------ */

test('the anchor is 00:00 UTC, and "8 PM EST" is only true half the year', async () => {
  const { dailyWindow, easternLabelFor } = await DT();

  // ── THE BUG THIS MODULE EXISTS TO AVOID ─────────────────────────────────
  // "8:00 PM EST (00:00 UTC)" treats those as one instant. They coincide only
  // under Eastern DAYLIGHT time. A tracker built literally on 8 PM Eastern
  // drifts an hour from GMGN on 1 November and again in March — and looks
  // perfect in August, when this was written.
  assert.equal(easternLabelFor(new Date('2026-08-17T00:00:00Z')), '8:00 PM EDT');
  assert.equal(easternLabelFor(new Date('2026-01-15T00:00:00Z')), '7:00 PM EST');
  assert.equal(easternLabelFor(new Date('2026-11-02T00:00:00Z')), '7:00 PM EST');

  // The label is rendered from the tz database, so the dashboard tells the
  // truth in both halves of the year without a code change.
  const summer = dailyWindow(Date.UTC(2026, 7, 16, 12, 0, 0));
  assert.equal(summer.resetLabelUtc, '00:00 UTC');
  assert.equal(summer.resetLabelLocal, '8:00 PM EDT');

  const winter = dailyWindow(Date.UTC(2026, 0, 15, 12, 0, 0));
  assert.equal(winter.resetLabelLocal, '7:00 PM EST');
  assert.notEqual(summer.resetLabelLocal, winter.resetLabelLocal, 'the local label MUST move with DST');
});

test('every window is exactly 24 hours, including across DST changes', async () => {
  const { dailyWindow } = await DT();

  // ── WHY THE BOUNDARIES ARE COMPUTED IN UTC ──────────────────────────────
  // A day in a DST-observing zone is 23 or 25 hours twice a year. A "24h PnL"
  // that silently covered 25 hours is a number nobody can reconcile against an
  // exchange, so the arithmetic stays in UTC where a day is always a day.
  const dstDays = [
    Date.UTC(2026, 2, 8, 12),   // US spring forward
    Date.UTC(2026, 10, 1, 12),  // US fall back
    Date.UTC(2024, 1, 29, 12),  // leap day
    Date.UTC(2026, 11, 31, 23), // year boundary
  ];
  for (const t of dstDays) {
    const w = dailyWindow(t);
    assert.equal(w.end - w.start, DAY_MS, `window at ${new Date(t).toISOString()} must be 24h`);
    assert.equal(new Date(w.start).getUTCHours(), 0, 'starts at midnight UTC');
    assert.ok(t >= w.start && t < w.end, 'now falls inside its own window');
  }

  // Consecutive windows abut exactly — no gap where a trade could vanish, no
  // overlap where one could be counted twice.
  const a = dailyWindow(Date.UTC(2026, 10, 1, 23, 59, 59));
  const b = dailyWindow(Date.UTC(2026, 10, 2, 0, 0, 1));
  assert.equal(a.end, b.start);

  // Elapsed/remaining, so a +40% at 00:10 UTC is distinguishable from +40% at
  // 23:50 — the same figure meaning very different things.
  const early = dailyWindow(Date.UTC(2026, 7, 16, 0, 30));
  assert.ok(early.elapsedPct > 2 && early.elapsedPct < 3);
  assert.equal(early.elapsedMs + early.remainingMs, DAY_MS);
});

test('a countdown fits in a box', async () => {
  const { formatDuration } = await DT();
  assert.equal(formatDuration(3 * 3600e3 + 12 * 60e3), '3h 12m');
  assert.equal(formatDuration(12 * 60e3 + 5000), '12m 5s');
  assert.equal(formatDuration(9000), '9s');
  assert.equal(formatDuration(-1), '—');
  assert.equal(formatDuration(NaN), '—');
});

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

test('trades count on the day they CLOSED, not the day they opened', async () => {
  const { aggregateDailyPnl, dailyWindow } = await DT();
  const now = Date.UTC(2026, 7, 16, 12, 0, 0);
  const w = dailyWindow(now);

  const book = {
    budgetSol: 100,
    positions: {},
    closed: [
      // Opened yesterday, closed today — the money moved TODAY.
      { mint: 'A', symbol: 'AAA', openedAt: w.start - 5 * 3600e3, closedAt: w.start + 3600e3, pnlSol: 2 },
      { mint: 'B', symbol: 'BBB', openedAt: w.start + 60e3, closedAt: w.start + 2 * 3600e3, pnlSol: -0.5 },
      { mint: 'C', symbol: 'CCC', openedAt: w.start + 60e3, closedAt: w.start + 3 * 3600e3, pnlSol: 1.5 },
      // Closed BEFORE the window — belongs to yesterday.
      { mint: 'D', symbol: 'DDD', openedAt: w.start - DAY_MS, closedAt: w.start - 1000, pnlSol: 999 },
      // Closes after the window — belongs to tomorrow.
      { mint: 'E', symbol: 'EEE', openedAt: w.start, closedAt: w.end + 1000, pnlSol: -999 },
      // No timestamp at all: excluded rather than guessed into the window.
      { mint: 'F', pnlSol: 500 },
    ],
  };

  const agg = aggregateDailyPnl({ book, window: w, solUsd: 75 });
  assert.equal(agg.closedCount, 3, 'only the three that closed inside the window');
  assert.equal(agg.wins, 2);
  assert.equal(agg.losses, 1);
  assert.ok(Math.abs(agg.realisedSol - 3) < 1e-9, '2 - 0.5 + 1.5');
  assert.ok(Math.abs(agg.winRatePct - 66.6667) < 0.01);
  assert.equal(agg.realisedUsd, 225);

  // Filtering on openedAt would credit a win to the day the bet was placed,
  // which is not what a daily leaderboard measures.
  assert.equal(agg.best.symbol, 'AAA', 'the position opened yesterday still counts today');
  assert.equal(agg.worst.symbol, 'BBB');
});

test('unrealised covers every open position, whenever it was opened', async () => {
  const { aggregateDailyPnl, dailyWindow } = await DT();
  const w = dailyWindow(Date.UTC(2026, 7, 16, 12));

  const book = {
    budgetSol: 10,
    closed: [],
    positions: {
      // A bag held from last week is still part of what the account is worth
      // now; excluding it would make this disagree with the scorecard.
      OLD: { stakeSol: 1, entryPriceUsd: 1, markPriceUsd: 3, openedAt: w.start - 7 * DAY_MS },
      NEW: { stakeSol: 2, entryPriceUsd: 1, markPriceUsd: 0.5, openedAt: w.start + 3600e3 },
      // Unpriceable positions contribute nothing rather than a guess.
      DARK: { stakeSol: 5, entryPriceUsd: 1, markPriceUsd: null },
      BROKEN: { stakeSol: 5, entryPriceUsd: 0, markPriceUsd: 2 },
    },
  };

  const agg = aggregateDailyPnl({ book, window: w });
  // OLD: 1 * 3 - 1 = +2.   NEW: 2 * 0.5 - 2 = -1.   Net +1.
  assert.ok(Math.abs(agg.unrealisedSol - 1) < 1e-9);
  assert.equal(agg.openPositions, 4);
  assert.ok(Math.abs(agg.totalSol - 1) < 1e-9, 'total is realised + unrealised');
  assert.ok(Math.abs(agg.roiPct - 10) < 1e-9, '1 SOL on a 10 SOL budget');
});

test('zero trades is unknown, not zero percent', async () => {
  const { aggregateDailyPnl, dailyWindow, renderDailyReport } = await DT();
  const w = dailyWindow(Date.UTC(2026, 7, 16, 1));

  // ── THE DISTINCTION THIS PROJECT KEEPS RE-LEARNING ──────────────────────
  // Rendering an absent win rate as 0% says "you lost every trade" when the
  // truth is "you made none" — the same error as an absent holder count read
  // as zero holders.
  const quiet = aggregateDailyPnl({ book: { budgetSol: 10, closed: [], positions: {} }, window: w });
  assert.equal(quiet.closedCount, 0);
  assert.equal(quiet.winRatePct, null, 'null, never 0');
  assert.equal(quiet.realisedSol, 0, 'but realised PnL genuinely IS zero');

  const out = renderDailyReport(quiet);
  assert.match(out, /no trades closed in this window yet/);
  assert.match(out, /n\/a until a trade closes/);
  assert.doesNotMatch(out, /0\.0%/, 'a win rate of 0% must not appear');

  // A book with no budget cannot express ROI, and says so rather than dividing.
  const noBudget = aggregateDailyPnl({ book: { closed: [], positions: {} }, window: w });
  assert.equal(noBudget.roiPct, null);
  assert.match(renderDailyReport(noBudget), /n\/a — no budget on the book/);

  // Degenerate books do not throw mid-render.
  assert.equal(aggregateDailyPnl({}).closedCount, 0);
  assert.equal(aggregateDailyPnl({ book: { closed: null, positions: null } }).openPositions, 0);
});

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

test('the box renders at a fixed width and states what is a mark', async () => {
  const { renderDailyReport, aggregateDailyPnl, dailyWindow, progressBar } = await DT();
  const w = dailyWindow(Date.UTC(2026, 7, 16, 12));
  const agg = aggregateDailyPnl({
    book: {
      budgetSol: 100,
      positions: { X: { stakeSol: 1, entryPriceUsd: 1, markPriceUsd: 2 } },
      closed: [{ mint: 'A', symbol: 'AAA', closedAt: w.start + 60e3, pnlSol: 5 }],
    },
    window: w,
    solUsd: 75,
  });

  const out = renderDailyReport(agg);
  const lines = out.split('\n');
  // Every line the same width, or the box does not close.
  const widths = new Set(lines.map((l) => [...l].length));
  assert.equal(widths.size, 1, `ragged box: widths ${[...widths].join(',')}`);
  assert.match(lines[0], /^╔═+╗$/);
  assert.match(lines.at(-1), /^╚═+╝$/);

  assert.match(out, /00:00 UTC/);
  assert.match(out, /8:00 PM EDT/);
  assert.match(out, /1447|1   1W \/ 0L/);
  assert.match(out, /TOTAL 24H/);
  // Unrealised is a MARK, and the box says so — this project has measured that
  // a mark on a thin pool is not a price anyone can exit at.
  assert.match(out, /unrealised is a MARK/);

  // The bar is proportional and bounded.
  assert.equal(progressBar(0, 10), '░'.repeat(10));
  assert.equal(progressBar(1, 10), '█'.repeat(10));
  assert.equal(progressBar(0.5, 10), '█████░░░░░');
  assert.equal(progressBar(2, 10), '█'.repeat(10), 'clamped');
  assert.equal(progressBar(-1, 10), '░'.repeat(10));
  assert.equal(progressBar(NaN, 10), '░'.repeat(10));
});
