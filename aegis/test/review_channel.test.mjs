/**
 * Fixture tests for the channel-review parser.
 *
 * These cover the decisions that determine whether a review is HONEST rather
 * than merely produced. Three of them are load-bearing:
 *
 *   - a recap post must not be mistaken for a call, or every token gets dated
 *     to the day it was already up 40x and the channel reviews as flawless;
 *   - a claimed market cap must never leak into the measured bucket;
 *   - "MC: 45" must not become a $45 baseline, which manufactures a 1000x.
 *
 * All of it is pure, so it runs with no network and no Telegram session.
 *
 *   node --test aegis/test/review_channel.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeExportText,
  parseExport,
  parseTextExport,
  parseClaimedMarketCap,
  parseTicker,
  isRecapMessage,
  extractCalls,
  classifyOutcome,
  gradeBasisFor,
  summarize,
  summarizeSecurity,
  renderReport,
  parseReviewArgs,
  fetchPeakGeckoTerminal,
  fetchPeakBirdeye,
  OUTCOME,
} from '../review_channel.mjs';
import { extractMints, parseMultiplierRecap } from '../telegram_listener.mjs';

/* Real-shaped Solana mints (44 and 43 chars, valid base58). */
const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_C = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

/* ------------------------------------------------------------------ *
 * Upstream extractors — the shapes a call channel actually posts
 * ------------------------------------------------------------------ */

test('extractMints pulls a mint out of a typical call post', () => {
  const post = `🚀 NEW CALL 🚀\n\n$PRESENCE\n\nCA: ${MINT_A}\n\nMC: $45K\nLP burned ✅`;
  assert.deepEqual(extractMints(post), [MINT_A]);
});

test('extractMints ignores an 88-char transaction signature', () => {
  // Two 44-char runs glued together. A greedy {32,44} would carve this into
  // two fake mints; the boundary assertions must reject it whole.
  const sig = MINT_A + MINT_B;
  assert.deepEqual(extractMints(`filled: ${sig}`), []);
});

test('extractMints drops wrapped SOL and the token program', () => {
  const post = `swap So11111111111111111111111111111111111111112 -> ${MINT_A}`;
  assert.deepEqual(extractMints(post), [MINT_A]);
});

test('parseMultiplierRecap pairs only within a line', () => {
  const recap =
    `🏆 THIS WEEK 🏆\n` +
    `$AAA 42x  ${MINT_A}\n` +
    `$BBB 7.5x ${MINT_B}\n` +
    `$CCC 12x\n` + // contract on the next line — deliberately unpaired
    `${MINT_C}\n`;
  const out = parseMultiplierRecap(recap);
  assert.equal(out.rows.length, 2);
  assert.deepEqual(
    out.rows.map((r) => [r.symbol, r.multiplier, r.address]),
    [
      ['AAA', 42, MINT_A],
      ['BBB', 7.5, MINT_B],
    ]
  );
  assert.equal(out.unpaired, 1, 'the split-line 12x must be reported, not guessed at');
});

/* ------------------------------------------------------------------ *
 * Export normalisation
 * ------------------------------------------------------------------ */

test('normalizeExportText flattens the entity array around a code span', () => {
  // This is the shape Telegram emits when the CA is tap-to-copy. String() on
  // it yields "[object Object]" exactly where the mint was.
  const text = [
    'CA: ',
    { type: 'code', text: MINT_A },
    '\nBuy on ',
    { type: 'link', text: 'Axiom' },
  ];
  const flat = normalizeExportText(text);
  assert.equal(flat, `CA: ${MINT_A}\nBuy on Axiom`);
  assert.deepEqual(extractMints(flat), [MINT_A], 'the mint must survive flattening');
});

test('normalizeExportText passes a plain string through and tolerates junk', () => {
  assert.equal(normalizeExportText('hello'), 'hello');
  assert.equal(normalizeExportText(null), '');
  assert.equal(normalizeExportText(undefined), '');
  assert.equal(normalizeExportText(42), '');
});

test('parseExport prefers date_unixtime over the zoneless local date string', () => {
  const parsed = parseExport({
    name: 'Tcalled Presence',
    messages: [
      {
        id: 2,
        type: 'message',
        date: '2026-08-02T12:00:00',
        date_unixtime: '1785758400',
        text: 'second',
      },
      {
        id: 1,
        type: 'message',
        date: '2026-08-01T12:00:00',
        date_unixtime: '1785672000',
        text: 'first',
      },
      { id: 3, type: 'service', text: 'pinned a message' },
      { id: 4, type: 'message', text: '   ' },
    ],
  });

  assert.equal(parsed.channel, 'Tcalled Presence');
  assert.equal(parsed.messages.length, 2, 'service events and empty posts are dropped');
  assert.deepEqual(parsed.messages.map((m) => m.text), ['first', 'second'], 'sorted oldest-first');
  assert.equal(parsed.messages[0].at.getTime(), 1785672000 * 1000);
  assert.equal(parsed.timestamped, 2);
});

test('parseTextExport recovers headers, and admits when it cannot', () => {
  const txt =
    `Tcalled Presence\n` +
    `Aegis, [01.08.2026 12:00]\n` +
    `first call ${MINT_A}\n` +
    `Aegis, [02.08.2026 15:30]\n` +
    `second call ${MINT_B}\n`;
  const parsed = parseTextExport(txt);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.timestamped, 2);
  assert.equal(parsed.messages[0].at.toISOString(), '2026-08-01T12:00:00.000Z');

  // No recognisable header: one untimed blob, and timestamped MUST be 0 so the
  // caller degrades the review instead of inventing dates.
  const blob = parseTextExport(`no headers here, just ${MINT_A} floating in text`);
  assert.equal(blob.messages.length, 1);
  assert.equal(blob.timestamped, 0);
  assert.equal(blob.messages[0].at, null);
});

/* ------------------------------------------------------------------ *
 * Claimed market cap
 * ------------------------------------------------------------------ */

test('parseClaimedMarketCap reads the formats call channels actually use', () => {
  const cases = [
    ['MC: $45K', 45_000],
    ['💰 Market Cap: $1.2M', 1_200_000],
    ['mcap 900k', 900_000],
    ['FDV: $2.5m', 2_500_000],
    ['Entry MC $67.5K 🚀', 67_500],
    ['market cap = $1,250,000', 1_250_000],
  ];
  for (const [text, want] of cases) {
    assert.equal(parseClaimedMarketCap(text), want, text);
  }
});

test('parseClaimedMarketCap refuses the readings that would manufacture a win', () => {
  // A bare small number is a truncation or a rank, not a $45 market cap.
  // Admitting it against a $45K token would invent a 1000x.
  assert.equal(parseClaimedMarketCap('MC: 45'), null);
  assert.equal(parseClaimedMarketCap('MC 12'), null);
  assert.equal(parseClaimedMarketCap('no market cap mentioned at all'), null);
  assert.equal(parseClaimedMarketCap(''), null);
  assert.equal(parseClaimedMarketCap(null), null);
});

test('parseTicker takes the first $TICKER only', () => {
  assert.equal(parseTicker('$PRESENCE is up, better than $BONK'), 'PRESENCE');
  assert.equal(parseTicker('no ticker here'), null);
});

/* ------------------------------------------------------------------ *
 * Recap detection — the decision that keeps the review honest
 * ------------------------------------------------------------------ */

test('a multi-token scoreboard is a recap, not a call', () => {
  const recap = `🏆 RECENT WINS\n$AAA 42x ${MINT_A}\n$BBB 7x ${MINT_B}\n`;
  assert.equal(isRecapMessage(recap).isRecap, true);
});

test('a follow-up on ONE live call is not a recap', () => {
  // One multiplier, one contract. Treating this as a recap would strip the
  // call's own timestamp and drop it out of the timing stats.
  const followUp = `$AAA already 4x from our call 🔥\n${MINT_A}`;
  assert.equal(isRecapMessage(followUp).isRecap, false);
});

test('a plain call post is not a recap', () => {
  assert.equal(isRecapMessage(`NEW CALL $AAA\nCA: ${MINT_A}\nMC: $45K`).isRecap, false);
});

/* ------------------------------------------------------------------ *
 * extractCalls
 * ------------------------------------------------------------------ */

const at = (iso) => new Date(iso);

test('extractCalls dates a token to its FIRST mention, not its reposts', () => {
  const { calls } = extractCalls([
    { id: 1, at: at('2026-08-01T10:00:00Z'), text: `NEW CALL $AAA\nCA: ${MINT_A}\nMC: $45K` },
    { id: 2, at: at('2026-08-01T14:00:00Z'), text: `$AAA running 3x ${MINT_A}` },
    { id: 3, at: at('2026-08-02T09:00:00Z'), text: `reminder: ${MINT_A}` },
  ]);

  assert.equal(calls.length, 1, 'three mentions of one token is one call');
  assert.equal(calls[0].calledAt.toISOString(), '2026-08-01T10:00:00.000Z');
  assert.equal(calls[0].mentions, 3);
  assert.equal(calls[0].claimedMcapAtCall, 45_000);
  assert.equal(calls[0].symbol, 'AAA');
});

test('extractCalls flags recap-only tokens instead of dating them to the recap', () => {
  const { calls, recapMessages } = extractCalls([
    { id: 1, at: at('2026-08-01T10:00:00Z'), text: `NEW CALL $AAA\nCA: ${MINT_A}\nMC: $45K` },
    {
      id: 2,
      at: at('2026-08-10T10:00:00Z'),
      text: `🏆 WINS\n$AAA 42x ${MINT_A}\n$ZZZ 88x ${MINT_C}\n`,
    },
  ]);

  assert.equal(recapMessages, 1);
  const a = calls.find((c) => c.address === MINT_A);
  const z = calls.find((c) => c.address === MINT_C);

  assert.equal(a.firstSeenInRecap, false, 'AAA had a real call before the recap');
  assert.equal(a.calledAt.toISOString(), '2026-08-01T10:00:00.000Z');

  assert.equal(z.firstSeenInRecap, true, 'ZZZ only ever appeared in the scoreboard');
  assert.equal(
    z.claimedMcapAtCall,
    null,
    'a recap must never supply an entry market cap — that would price the call at its peak'
  );
});

test('extractCalls keeps the channel claim separate from anything measured', () => {
  const { calls } = extractCalls([
    { id: 1, at: at('2026-08-01T10:00:00Z'), text: `$AAA\nCA: ${MINT_A}\nMC: $45K` },
    { id: 2, at: at('2026-08-05T10:00:00Z'), text: `🏆\n$AAA 12x ${MINT_A}\n$BBB 3x ${MINT_B}` },
    { id: 3, at: at('2026-08-09T10:00:00Z'), text: `🏆\n$AAA 40x ${MINT_A}\n$BBB 5x ${MINT_B}` },
  ]);

  const a = calls.find((c) => c.address === MINT_A);
  assert.equal(a.claimedMultiplier, 40, 'the channel’s most generous claim is the one carried');
  assert.equal(a.peakMultiplier, undefined, 'claims never populate a measured field');
});

test('extractCalls tolerates messages with no timestamp', () => {
  const { calls } = extractCalls([{ id: null, at: null, text: `CA: ${MINT_A}` }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].calledAt, null);
});

/* ------------------------------------------------------------------ *
 * Grading
 * ------------------------------------------------------------------ */

test('classifyOutcome checks rug and dead before any multiplier', () => {
  // Ran 8x on paper, then the pool was pulled. Grading this on peak would
  // credit the channel for a rug.
  assert.equal(
    classifyOutcome({ rugged: true, peakMultiplier: 8, liquidityUsd: 50_000 }),
    OUTCOME.RUG
  );
  assert.equal(classifyOutcome({ delisted: true, peakMultiplier: 8 }), OUTCOME.RUG);
  assert.equal(classifyOutcome({ liquidityUsd: 400, peakMultiplier: 8 }), OUTCOME.DEAD);
});

test('classifyOutcome grades on peak when measured, current otherwise', () => {
  assert.equal(classifyOutcome({ peakMultiplier: 2, liquidityUsd: 90_000 }), OUTCOME.WIN);
  assert.equal(classifyOutcome({ peakMultiplier: 1.9, liquidityUsd: 90_000 }), OUTCOME.FLAT);
  assert.equal(classifyOutcome({ peakMultiplier: 0.5, liquidityUsd: 90_000 }), OUTCOME.LOSS);
  assert.equal(classifyOutcome({ currentMultiplier: 5, liquidityUsd: 90_000 }), OUTCOME.WIN);
  // peak wins the tie-break when both exist
  assert.equal(
    classifyOutcome({ peakMultiplier: 6, currentMultiplier: 0.2, liquidityUsd: 90_000 }),
    OUTCOME.WIN
  );
});

test('an unpriceable call is UNKNOWN, never FLAT', () => {
  // FLAT would hide missing data inside a respectable-looking neutral bucket.
  assert.equal(classifyOutcome({ liquidityUsd: 90_000 }), OUTCOME.UNKNOWN);
  assert.equal(classifyOutcome({}), OUTCOME.UNKNOWN);
});

/* ------------------------------------------------------------------ *
 * Summary — the separation that stops a review becoming an advert
 * ------------------------------------------------------------------ */

const row = (o) => ({
  address: MINT_A,
  outcome: OUTCOME.FLAT,
  baselineSource: 'measured',
  peakMultiplier: null,
  currentMultiplier: null,
  audit: null,
  flags: {},
  ...o,
});

test('summarize never averages a claimed baseline into the measured one', () => {
  const stats = summarize([
    row({ outcome: OUTCOME.WIN, peakMultiplier: 4, baselineSource: 'measured' }),
    row({ outcome: OUTCOME.LOSS, peakMultiplier: 0.5, baselineSource: 'measured' }),
    row({ outcome: OUTCOME.WIN, currentMultiplier: 100, baselineSource: 'claimed' }),
  ]);

  assert.equal(stats.measured.total, 2);
  assert.equal(stats.claimed.total, 1);
  assert.equal(stats.measured.winRate, 50);
  assert.equal(stats.claimed.winRate, 100);
  assert.equal(stats.measured.bestMultiplier, 4, 'the claimed 100x must not reach the measured column');
  assert.equal(stats.measured.avgMultiplier, 2.25);
});

test('a rug with no recoverable entry price still counts as a rug', () => {
  // REGRESSION. Bucketing on baselineSource alone dropped these rows from both
  // columns, and the first fixture run printed a 0.0% rug rate with two dead
  // pools listed in the table below it.
  const rows = [
    row({ outcome: OUTCOME.RUG, baselineSource: null, peakMultiplier: null }),
    row({ outcome: OUTCOME.DEAD, baselineSource: null, peakMultiplier: null }),
    row({ outcome: OUTCOME.WIN, baselineSource: 'claimed', currentMultiplier: 3 }),
  ];

  assert.equal(gradeBasisFor(rows[0]), 'measured', 'a pulled pool is an on-chain fact');
  assert.equal(gradeBasisFor(rows[1]), 'measured');
  assert.equal(gradeBasisFor(rows[2]), 'claimed');

  const stats = summarize(rows);
  assert.equal(stats.measured.rugs, 1);
  assert.equal(stats.measured.dead, 1);
  assert.equal(stats.measured.rugRate, 100, 'both terminal calls land in the measured column');
  assert.equal(stats.claimed.rugRate, 0);
});

test('every graded call lands in exactly one column', () => {
  // The conservation invariant the regression above violated.
  const rows = [
    row({ outcome: OUTCOME.WIN, baselineSource: 'measured', peakMultiplier: 4 }),
    row({ outcome: OUTCOME.LOSS, baselineSource: 'claimed', currentMultiplier: 0.2 }),
    row({ outcome: OUTCOME.RUG, baselineSource: null }),
    row({ outcome: OUTCOME.DEAD, baselineSource: 'claimed' }),
    row({ outcome: OUTCOME.UNKNOWN, baselineSource: null }),
  ];
  const stats = summarize(rows);
  assert.equal(
    stats.measured.total + stats.claimed.total,
    stats.graded,
    'no graded call may fall between the two columns'
  );
  assert.equal(stats.graded + stats.unknown, stats.calls);
});

test('gradeBasisFor leaves an unpriceable, still-live call out of both columns', () => {
  assert.equal(gradeBasisFor(row({ outcome: OUTCOME.UNKNOWN, baselineSource: null })), null);
});

test('summarize reports unknowns rather than diluting the rates with them', () => {
  const stats = summarize([
    row({ outcome: OUTCOME.WIN, peakMultiplier: 3 }),
    row({ outcome: OUTCOME.RUG, baselineSource: 'measured' }),
    row({ outcome: OUTCOME.UNKNOWN, baselineSource: null }),
    row({ outcome: OUTCOME.UNKNOWN, baselineSource: null }),
  ]);

  assert.equal(stats.calls, 4);
  assert.equal(stats.graded, 2);
  assert.equal(stats.unknown, 2);
  assert.equal(stats.measured.total, 2);
  assert.equal(stats.measured.winRate, 50, 'graded set is the denominator, not every post');
  assert.equal(stats.measured.rugRate, 50);
});

test('summarize reports median alongside mean so one 200x cannot carry the set', () => {
  const stats = summarize([
    row({ outcome: OUTCOME.LOSS, peakMultiplier: 0.5 }),
    row({ outcome: OUTCOME.LOSS, peakMultiplier: 0.5 }),
    row({ outcome: OUTCOME.FLAT, peakMultiplier: 1 }),
    row({ outcome: OUTCOME.WIN, peakMultiplier: 200 }),
  ]);
  assert.equal(stats.measured.medianMultiplier, 0.75);
  assert.equal(stats.measured.avgMultiplier, 50.5);
});

test('summarize handles an empty review without dividing by zero', () => {
  const stats = summarize([]);
  assert.equal(stats.calls, 0);
  assert.equal(stats.measured.winRate, null);
  assert.equal(stats.measured.avgMultiplier, null);
  assert.equal(stats.measured.medianMultiplier, null);
});

test('summarizeSecurity counts authority findings across audited calls', () => {
  const sec = summarizeSecurity([
    row({
      audit: { status: 'FAILED' },
      flags: { mintAuthorityActive: true, freezeAuthorityActive: true, concentrated: true },
      deployerStatus: 'SERIAL RUGGER',
      aegisWouldAlert: false,
    }),
    row({ audit: { status: 'PASSED' }, flags: {}, aegisWouldAlert: true }),
    row({ audit: { status: 'UNVERIFIED' }, flags: { lpUnlocked: true }, aegisWouldAlert: false }),
    row({ audit: null, flags: {} }), // never resolved — excluded from the denominator
  ]);

  assert.equal(sec.audited, 3);
  assert.equal(sec.passed, 1);
  assert.equal(sec.failed, 1);
  assert.equal(sec.unverified, 1);
  assert.equal(sec.liveMintAuthority, 1);
  assert.equal(sec.liveFreezeAuthority, 1);
  assert.equal(sec.unlockedLp, 1);
  assert.equal(sec.serialRugDeployer, 1);
  assert.equal(sec.wouldAegisAlert, 1);
});

/* ------------------------------------------------------------------ *
 * Price history adapters — injected fetch, no network
 * ------------------------------------------------------------------ */

test('fetchPeakGeckoTerminal takes the highest wick after the call', () => {
  const call = new Date('2026-08-02T00:00:00Z');
  const fetchImpl = async () => ({
    ok: true,
    data: {
      data: {
        attributes: {
          // [ts, open, high, low, close, vol] — newest first, as the API sends
          ohlcv_list: [
            [Date.UTC(2026, 7, 3) / 1000, 3, 4, 2, 3, 0],
            [Date.UTC(2026, 7, 2) / 1000, 1, 9, 1, 3, 0],
            [Date.UTC(2026, 7, 1) / 1000, 1, 99, 1, 1, 0], // BEFORE the call
          ],
        },
      },
    },
  });

  return fetchPeakGeckoTerminal({ poolAddress: 'pool', since: call, fetchImpl }).then((r) => {
    assert.equal(r.ok, true);
    assert.equal(r.peakPriceUsd, 9, 'the 99 predates the call and must be ignored');
    assert.equal(r.baselinePriceUsd, 1, 'baseline is the open of the first candle at/after the call');
    assert.equal(r.source, 'geckoterminal');
  });
});

test('fetchPeakGeckoTerminal carries the failure reason instead of guessing', async () => {
  const dead = await fetchPeakGeckoTerminal({
    poolAddress: 'pool',
    since: new Date(),
    fetchImpl: async () => ({ ok: false, error: 'ECONNRESET' }),
  });
  assert.equal(dead.ok, false);
  assert.match(dead.reason, /ECONNRESET/);

  const empty = await fetchPeakGeckoTerminal({
    poolAddress: 'pool',
    since: new Date(),
    fetchImpl: async () => ({ ok: true, data: { data: { attributes: { ohlcv_list: [] } } } }),
  });
  assert.equal(empty.ok, false);

  assert.equal((await fetchPeakGeckoTerminal({ poolAddress: null })).ok, false);
});

test('fetchPeakBirdeye stays inert without a key, and reads items when given one', async () => {
  assert.equal((await fetchPeakBirdeye({ mint: MINT_A, apiKey: null })).ok, false);

  const r = await fetchPeakBirdeye({
    mint: MINT_A,
    since: new Date('2026-08-01T00:00:00Z'),
    apiKey: 'k',
    fetchImpl: async () => ({
      ok: true,
      data: {
        data: {
          items: [
            { unixTime: 1785672000, value: 2 },
            { unixTime: 1785758400, value: 11 },
            { unixTime: 1785844800, value: 5 },
          ],
        },
      },
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.peakPriceUsd, 11);
  assert.equal(r.baselinePriceUsd, 2, 'earliest sample is the baseline');
});

/* ------------------------------------------------------------------ *
 * CLI + rendering
 * ------------------------------------------------------------------ */

test('parseReviewArgs reads every documented flag', () => {
  assert.deepEqual(parseReviewArgs(['--channel', 'TcalledPresence', '--limit', '25', '--dry-run']), {
    channel: 'TcalledPresence',
    exportPath: null,
    limit: 25,
    messageLimit: 3000,
    dryRun: true,
    skipPeak: false,
    outPath: null,
  });

  const e = parseReviewArgs(['--export', 'result.json', '--no-peak', '--out', 'x.md', '--messages', '500']);
  assert.equal(e.exportPath, 'result.json');
  assert.equal(e.skipPeak, true);
  assert.equal(e.outPath, 'x.md');
  assert.equal(e.messageLimit, 500);

  // Bare positional is the channel, so `--review TcalledPresence` works.
  assert.equal(parseReviewArgs(['TcalledPresence']).channel, 'TcalledPresence');
});

test('renderReport keeps the measured and claimed columns visibly apart', () => {
  const rows = [
    row({
      symbol: 'AAA',
      outcome: OUTCOME.WIN,
      peakMultiplier: 4,
      baselineSource: 'measured',
      baselineMcap: 45_000,
      currentMcap: 180_000,
      calledAt: at('2026-08-01T10:00:00Z'),
      audit: { status: 'PASSED' },
      deployerStatus: 'CLEAN',
      flags: {},
    }),
    row({
      symbol: 'BBB',
      outcome: OUTCOME.RUG,
      baselineSource: 'measured',
      calledAt: at('2026-08-02T10:00:00Z'),
      liquidityUsd: 0,
      delisted: true,
      audit: { status: 'FAILED' },
      flags: { mintAuthorityActive: true },
    }),
  ];

  const md = renderReport({
    channel: 'TcalledPresence',
    rows,
    stats: summarize(rows),
    security: summarizeSecurity(rows),
    meta: { source: 'test fixture', messages: 2, timestamped: 2, recapMessages: 0 },
    generatedAt: at('2026-08-24T00:00:00Z'),
  });

  assert.match(md, /# TcalledPresence — Call Review/);
  assert.match(md, /Measured baseline \| Channel-claimed baseline/);
  assert.match(md, /must never be averaged together/);
  assert.match(md, /Mint authority still live/);
  assert.match(md, /Rugs and dead pools/);
  assert.match(md, /Deleted posts are invisible/);
  assert.match(md, /\$AAA/);
});

test('renderReport prints the peak-unavailable warning when it applies', () => {
  const md = renderReport({
    channel: 'X',
    rows: [],
    stats: summarize([]),
    security: summarizeSecurity([]),
    meta: { source: 'test', peakUnavailable: 'No price-history source answered.' },
  });
  assert.match(md, /Peak prices were not available/);
  assert.match(md, /win rate is/);
  assert.match(md, /FLOOR, not an estimate/);
});
