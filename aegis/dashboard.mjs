/**
 * Live web dashboard — state transformer.
 *
 * Phase 1 of "03 Live Web Dashboard Plan": one pure function that turns a paper
 * book into the exact object the browser renders. No server, no socket, no
 * network, no clock of its own. Everything here is synchronous and testable
 * without binding a port.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS MODULE EXISTS TO ENFORCE: THE DASHBOARD RENDERS, IT DOES NOT
 * COMPUTE.
 *
 * `scorecard` is whatever `paperScorecard()` returned, passed through
 * untouched — not re-derived, not reformatted, not "cleaned up". The terminal
 * and the browser therefore cannot disagree about money, because there is only
 * one place money is calculated and it is not this file.
 *
 * That is a stronger guarantee than it looks. `winRatePct` is `null` before
 * anything closes, and the engine says why: "a 0% win rate and 'nothing has
 * resolved yet' are different claims and only one of them is bad news." A
 * frontend that recomputes it writes `wins / total || 0` and prints 0.0% on a
 * fresh book — or counts open winners and prints 90%. Passing the object
 * through verbatim is what makes that unrepresentable rather than merely
 * discouraged.
 *
 * ── WHY POSITION ROWS STILL DO ARITHMETIC ───────────────────────────────────
 * `renderPositions()` returns a formatted STRING, so there is no per-position
 * data structure to pass through the way the scorecard is. The gain and value
 * formulas below are therefore duplicated from it — deliberately, and with a
 * test that closes the seam: summing `valueSol` across positions must equal
 * `scorecard.openValueSol`, which `paperScorecard` computes with the identical
 * reduce. If either formula drifts, that test goes red rather than the two
 * views quietly disagreeing.
 *
 * ── ON `symbol` ─────────────────────────────────────────────────────────────
 * Token symbols are attacker-controlled. They are passed through raw here
 * because this is a data layer, and the renderer MUST set them with
 * `textContent`, never `innerHTML`. Same class of hazard as SSE frame
 * encoding: a memecoin ticker can contain quotes, angle brackets and newlines.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

import { paperScorecard, PAPER_DEFAULTS } from './paper_copytrade.mjs';

// Re-exported rather than reimplemented. The same file is served to the browser
// as `/chart.mjs`, so the projection the tests check IS the projection the page
// draws with — there is no second copy in a <script> block to drift from it.
export { buildChartGeometry, describeChart, samplingCadenceMs, MARK_KINDS } from './public/chart.mjs';

/**
 * Most recent price samples kept per position.
 *
 * 300 points bounds the SSE frame, which is the real constraint — memory never
 * was. At ~42 bytes of JSON per `{ t, priceUsd }` point a full series is about
 * 12.3 KB, and that is the ONLY series in a frame because just one chart is
 * ever on screen (see `focusedMint` below). Ten open positions therefore cost
 * 12.3 KB, not 123 KB.
 *
 * Note what this is NOT: a duration. 300 points is 25 minutes at `--watch 5`,
 * 5 minutes at `--watch 1` and 2.5 hours at `--watch 30`. The span is reported
 * as `seriesSpanMs`, measured from the samples themselves, so the chart's axis
 * cannot claim a window the data does not cover.
 */
export const SERIES_POINT_LIMIT = 300;

/** Activity rows retained. The web log scrolls, unlike the terminal's 6. */
export const ACTIVITY_LIMIT = 500;

/** A mark older than this is called stale rather than shown as current. */
export const STALE_MARK_MS = 60_000;

/**
 * The newest N entries of an array, without mutating it. PURE.
 *
 * `slice(-limit)` and not `slice(0, limit)`, which is the bug this helper
 * exists to make impossible: taking the FIRST 300 samples pins a chart to the
 * moment the position opened and then never moves again, while still looking
 * like a working chart. A frozen line that renders is worse than no line.
 */
function newest(list, limit) {
  if (!Array.isArray(list) || !list.length) return [];
  return list.length > limit ? list.slice(-limit) : list.slice();
}

/**
 * The execution band, reduced to what a card needs. PURE.
 *
 * Drops the per-rung signature and source-slot detail — useful in the engine,
 * noise on a card — but keeps every number a reader needs to judge the fill,
 * and keeps `assumption` so the uncertainty travels with the figure instead of
 * relying on a renderer to remember it.
 *
 * Returns null for an unreconstructed band. "We could not price this at the
 * slot we would have landed in" and "we landed at this price" are different
 * claims, and only one of them belongs on a card.
 */
export function summariseBand(band) {
  if (!band || band.reconstructed !== true) return null;
  const rung = (r) =>
    r && Number.isFinite(r.priceUsd)
      ? { slotOffset: r.slotOffset, priceUsd: r.priceUsd, exact: r.exact === true, staleSlots: r.staleSlots ?? null }
      : null;
  return {
    fillPriceUsd: band.fillPriceUsd,
    fillSlotOffset: band.fillSlotOffset,
    fillLagMs: band.fillLagMs,
    bestCaseUsd: band.bestCaseUsd,
    worstCaseUsd: band.worstCaseUsd,
    spreadPct: band.spreadPct,
    swapCount: band.swapCount,
    windowComplete: band.windowComplete,
    rungs: {
      earliest: rung(band.rungs?.earliest),
      expected: rung(band.rungs?.expected),
      latest: rung(band.rungs?.latest),
    },
    assumption: band.assumption ?? null,
  };
}

/**
 * One position row.
 *
 * `series` is attached only to the focused mint. Every other card renders a
 * number, not a chart, and numbers do not need history.
 */
function buildPositionRow(p, { solUsd, now, withSeries, series, marks, embed }) {
  const entry = Number.isFinite(p?.entryPriceUsd) && p.entryPriceUsd > 0 ? p.entryPriceUsd : null;
  const mark = Number.isFinite(p?.markPriceUsd) ? p.markPriceUsd : null;

  // Identical to renderPositions and to paperScorecard's openValueSol reduce.
  // The multiple falls back to 1 — an unpriced position is held at cost, never
  // at zero, because "we could not read a price" is not "it went to nothing".
  const mult = mark !== null && entry !== null ? mark / entry : 1;
  const valueSol = (p?.stakeSol ?? 0) * mult;

  const lastPricedAt = Number.isFinite(p?.lastPricedAt) ? p.lastPricedAt : null;
  const markAgeMs = lastPricedAt === null ? null : Math.max(0, now - lastPricedAt);

  const points = withSeries ? newest(series, SERIES_POINT_LIMIT) : null;

  return {
    mint: p?.mint ?? null,
    symbol: p?.symbol ?? null,
    entryPriceUsd: entry,
    markPriceUsd: mark,
    peakPriceUsd: Number.isFinite(p?.peakPriceUsd) ? p.peakPriceUsd : null,
    gainPct: entry !== null && mark !== null ? (mark / entry - 1) * 100 : null,
    stakeSol: p?.stakeSol ?? 0,
    initialStakeSol: p?.initialStakeSol ?? null,
    realisedSol: p?.realisedSol ?? 0,
    valueSol,
    valueUsd: Number.isFinite(solUsd) && solUsd > 0 ? valueSol * solUsd : null,
    firedRungs: Array.isArray(p?.firedRungs) ? p.firedRungs.slice() : [],
    openedAt: p?.openedAt ?? null,
    heldMs: Number.isFinite(p?.openedAt) ? Math.max(0, now - p.openedAt) : null,
    originatingWhale: p?.originatingWhale ?? p?.source ?? null,
    demo: p?.demo === true,

    // ── DEPTH DISCLOSURE ────────────────────────────────────────────────────
    // Three states, and collapsing them is the exact edit this plan refused:
    //   true  — a real pool was read
    //   false — nobody read one; the fill was priced against poolFloorSol
    //   null  — the liquidity model is off, so depth was never spoken about
    // `assumedPool` is strict `=== false` so the "model off" case can never
    // light the badge. The engine draws the same distinction in its own words:
    // the floor answers "looked and found none", never "nobody looked".
    poolMeasured: p?.entryPoolMeasured ?? null,
    assumedPool: p?.entryPoolMeasured === false,
    entryPoolSol: p?.entryPoolSol ?? null,
    entryImpactPct: p?.entryImpactPct ?? null,
    entryImpactSol: p?.entryImpactSol ?? 0,
    liquidityCapped: (p?.liquidityCappedEntries ?? 0) > 0,
    requestedSol: p?.requestedSol ?? null,

    lastPricedAt,
    markAgeMs,
    markStale: markAgeMs !== null && markAgeMs > STALE_MARK_MS,

    embedUrl: embed ? dexScreenerEmbedUrl(p?.mint) : null,

    // ── SLOT-LATENCY FILL, AND ITS UNCERTAINTY ──────────────────────────────
    // Null unless `slotFills` was on AND the chain could answer. It carries its
    // own `assumption` string, because the landing slot is a guess — only the
    // earliest rung is floored by a measured observation lag. A renderer that
    // shows the fill without the spread is showing a point estimate of
    // something nobody has measured.
    executionBand: summariseBand(p?.executionBand),

    // Null, not [], when this is not the focused mint. An empty array reads as
    // "charted, no data"; null reads as "not charted", which is the truth.
    series: points,
    seriesSpanMs: points && points.length > 1 ? points[points.length - 1].t - points[0].t : null,
    seriesTruncated: withSeries ? (series?.length ?? 0) > SERIES_POINT_LIMIT : false,
    marks: withSeries ? (Array.isArray(marks) ? marks.slice() : []) : null,
  };
}

/**
 * The USD/SOL decomposition. PURE.
 *
 * The book holds SOL. A dollar equity figure therefore moves for two unrelated
 * reasons, and showing only the total is how a dashboard reports a gain nobody
 * earned: at $86.50/SOL a $4,000 book is ~46.2 SOL, and if SOL alone goes to
 * $90 the USD card reads $4,161 with not one trade placed.
 *
 * The split is exact, not an estimate:
 *
 *   vsStartUsd = tradingPnlUsd + solDriftUsd
 *   solDriftUsd = budgetSol x (solUsd - solUsdAtStart)
 *
 * Returns null when the book was not funded in dollars — in which case there is
 * no honest "vs start USD" claim to make, and the page must not invent one.
 */
export function buildUsdFraming(scorecard, solUsd) {
  const start = scorecard?.budgetUsdAtStart;
  const startRate = scorecard?.solUsdAtStart;
  if (!Number.isFinite(solUsd) || solUsd <= 0) return null;
  if (!Number.isFinite(start) || !Number.isFinite(startRate) || startRate <= 0) return null;

  const equityUsd = scorecard.equitySol * solUsd;
  const tradingPnlUsd = scorecard.totalPnlSol * solUsd;
  const solDriftUsd = scorecard.budgetSol * (solUsd - startRate);

  return {
    equityUsd,
    budgetUsdAtStart: start,
    solUsdAtStart: startRate,
    solUsdNow: solUsd,
    // What trading did, valued at today's rate.
    tradingPnlUsd,
    // What SOL moving did to the original stack, all by itself.
    solDriftUsd,
    // The headline the draft wanted to show alone. It is the sum of the two
    // above, and it is only meaningful next to them.
    vsStartUsd: tradingPnlUsd + solDriftUsd,
  };
}

/**
 * Everything the page needs to say how fresh it is.
 *
 * A dashboard that cannot look stale cannot be trusted when it looks fine. The
 * terminal was once caught running 50 seconds behind while GMGN showed trades
 * 3s old, and the only reason anyone noticed is that it printed the time of its
 * last update. Keep that property.
 */
function buildFreshness({ now, socket, newestWhaleEventAt, lastMarkAt, bookWriterAt }) {
  const age = (t) => (Number.isFinite(t) ? Math.max(0, now - t) : null);
  return {
    now,
    socket: socket ?? 'unknown',
    newestWhaleEventAt: newestWhaleEventAt ?? null,
    newestWhaleEventAgeMs: age(newestWhaleEventAt),
    lastMarkAt: lastMarkAt ?? null,
    lastMarkAgeMs: age(lastMarkAt),
    bookWriterAt: bookWriterAt ?? null,
    bookWriterAgeMs: age(bookWriterAt),
  };
}

/**
 * Conditions the header must surface rather than let the numbers imply.
 *
 * These are not errors. Each one changes what the equity figure MEANS, which is
 * why they travel with the state instead of being left to the reader to infer.
 */
function buildWarnings(scorecard, positions, freshness) {
  const out = [];

  if (scorecard.liquidityModel === false) {
    out.push({
      code: 'LIQUIDITY_MODEL_OFF',
      severity: 'warning',
      message:
        'Liquidity model OFF — fills are priced at mid against infinite depth. ' +
        'This book pays no price impact, so its equity is optimistic by roughly ' +
        'what crossing the pool would have cost.',
    });
  }

  if ((scorecard.flooredFills ?? 0) > 0) {
    out.push({
      code: 'ASSUMED_POOL',
      severity: 'warning',
      count: scorecard.flooredFills,
      message:
        `${scorecard.flooredFills} fill(s) priced against the ASSUMED pool floor, not a pool anyone read. ` +
        'The floor is a constant and it is conservative — against measured pools it overcharges a 1 SOL buy by about 2.5 points.',
    });
  }

  if ((scorecard.demoPositions ?? 0) + (scorecard.demoClosed ?? 0) > 0) {
    out.push({
      code: 'DEMO_TRADES',
      severity: 'info',
      count: scorecard.demoPositions + scorecard.demoClosed,
      message: 'Book includes demo trades that were never mirrored from the target; they count toward the win rate.',
    });
  }

  const banded = positions.filter((p) => p.executionBand);
  if (banded.length) {
    const worst = Math.max(...banded.map((p) => p.executionBand.spreadPct ?? 0));
    out.push({
      code: 'ASSUMED_LANDING_SLOT',
      severity: 'info',
      count: banded.length,
      message:
        `${banded.length} position(s) priced at an ASSUMED landing slot. Only the earliest rung is floored by a measured ` +
        `observation lag; where the order would really land has never been measured, because this book has never sent a ` +
        `transaction. Widest fill spread across the band: ${worst.toFixed(1)}%.`,
    });
  }

  const partialWindow = positions.filter((p) => p.executionBand && p.executionBand.windowComplete === false).length;
  if (partialWindow > 0) {
    out.push({
      code: 'PARTIAL_FILL_WINDOW',
      severity: 'warning',
      count: partialWindow,
      message:
        `${partialWindow} fill(s) were priced before the chain had produced the far end of the window. The late rung is a ` +
        'carry-forward of an earlier slot rather than an observation, so the spread shown is understated.',
    });
  }

  const stale = positions.filter((p) => p.markStale).length;
  if (stale > 0) {
    out.push({
      code: 'STALE_MARKS',
      severity: 'warning',
      count: stale,
      message: `${stale} position(s) have not been re-priced in over ${Math.round(STALE_MARK_MS / 1000)}s. Their gain figures are last-known, not current.`,
    });
  }

  if (freshness.socket === 'disconnected') {
    out.push({
      code: 'SOCKET_DOWN',
      severity: 'error',
      message: 'Whale socket disconnected — new trades are not arriving. Everything below is the last good frame.',
    });
  }

  return out;
}

/**
 * Book -> the object the browser renders. PURE, and the whole UI contract.
 *
 * Mutates nothing: the book, its positions and the caller's series arrays are
 * all read-only here. That matters more than it usually would, because in the
 * shipped design this runs INSIDE the tick process holding the live book —
 * there is no copy to be careless with.
 *
 * @param {object}  book
 * @param {object}  cfg
 * @param {object}  opts
 * @param {?number} opts.solUsd     spot, or null when it could not be read
 * @param {?string} opts.focusedMint the ONE mint whose history is sent
 * @param {object}  opts.seriesByMint  { [mint]: [{ t, priceUsd }] }
 * @param {object}  opts.marksByMint   { [mint]: [{ t, priceUsd, kind, label }] }
 */
export function buildDashboardState(
  book,
  cfg = PAPER_DEFAULTS,
  {
    solUsd = null,
    focusedMint = null,
    now = Date.now(),
    seriesByMint = {},
    marksByMint = {},
    activity = [],
    socket = 'unknown',
    newestWhaleEventAt = null,
    lastMarkAt = null,
    embed = false,
  } = {}
) {
  // Verbatim. Not spread, not re-keyed, not rounded. See the header.
  const scorecard = paperScorecard(book, cfg);

  const held = Object.values(book?.positions ?? {});

  // Resolve the focus against what is ACTUALLY held, and report the resolved
  // value rather than the requested one. A client asking for a mint that has
  // since closed gets `focusedMint: null` and knows to pick again — as opposed
  // to a silent empty chart it cannot distinguish from a flat one.
  const resolvedFocus =
    focusedMint && held.some((p) => p?.mint === focusedMint) ? focusedMint : null;

  const positions = held
    .slice()
    .sort((a, b) => (b?.stakeSol ?? 0) - (a?.stakeSol ?? 0))
    .map((p) =>
      buildPositionRow(p, {
        solUsd,
        now,
        withSeries: p?.mint === resolvedFocus,
        series: seriesByMint?.[p?.mint],
        marks: marksByMint?.[p?.mint],
        embed,
      })
    );

  const freshness = buildFreshness({
    now,
    socket,
    newestWhaleEventAt,
    lastMarkAt,
    bookWriterAt: book?.writerAt ?? null,
  });

  return {
    scorecard,
    // Null when spot could not be read. Every USD figure downstream derives
    // from this one number, so a fallback constant would silently mis-state the
    // whole page — the engine takes the same line in fetchSolUsd.
    solUsd: Number.isFinite(solUsd) && solUsd > 0 ? solUsd : null,
    usdFraming: buildUsdFraming(scorecard, solUsd),
    mode: {
      pureMirror: cfg?.pureMirror === true,
      liquidityModel: cfg?.liquidityModel !== false,
      poolCapPct: cfg?.poolCapPct ?? PAPER_DEFAULTS.poolCapPct,
      subWallets: cfg?.subWallets ?? 0,
      pctWhale: cfg?.pctWhale ?? null,
      autoCompound: cfg?.autoCompound === true,
      scaleIn: cfg?.scaleIn !== false,
      reEnter: cfg?.reEnter !== false,
      // Slot-latency fills. `enabled` says entries are priced from real
      // on-chain swaps at an assumed landing slot; off means the older
      // implied-price path, which prices us at the target's own fill — a moment
      // we could not have traded in.
      slotFills: {
        enabled: cfg?.slotFills === true,
        offsets: cfg?.slotFills === true ? (cfg?.slotOffsets ?? null) : null,
      },
      // Tier B. `enabled` says the operator allowed it; it does NOT say a frame
      // has been loaded. Nothing reaches dexscreener.com until a deliberate
      // click in the page.
      embed: { enabled: embed === true, provider: embed ? 'dexscreener' : null, origin: embed ? EMBED_ORIGIN : null },
    },
    freshness,
    focusedMint: resolvedFocus,
    seriesPointLimit: SERIES_POINT_LIMIT,
    positions,
    activity: newest(activity, ACTIVITY_LIMIT),
    warnings: buildWarnings(scorecard, positions, freshness),
  };
}

/* ------------------------------------------------------------------ *
 * HTTP server
 * ------------------------------------------------------------------ *
 *
 * Phase 2. `node:http` and nothing else — no framework, no dependency, in a
 * repo whose package.json says the scanner "stays dependency-free and runs on
 * Node built-ins alone."
 *
 * ── THE SERVER IS READ-ONLY, STRUCTURALLY ───────────────────────────────────
 * There is no route that mutates anything. Not a paused flag, not a manual
 * exit, not a config change. The process on the other side of `getState` is
 * holding a live book, and the difference between a viewer and a remote control
 * is the difference between something that can be bound to 0.0.0.0 and
 * something that cannot.
 *
 * ── AND IT SERVES EXACTLY ONE FILE ──────────────────────────────────────────
 * `/` returns `public/index.html`; there is no static directory walk, because
 * everything the page needs is inlined into it. A general static handler is
 * where path-traversal bugs live, and the cheapest way to not have one is to
 * have no paths — the filename is a module constant, never taken from the URL.
 */

const DEFAULT_PAGE_PATH = fileURLToPath(new URL('./public/index.html', import.meta.url));
const CHART_MODULE_PATH = fileURLToPath(new URL('./public/chart.mjs', import.meta.url));

/**
 * The complete set of files this server will serve, by exact URL path.
 *
 * Still an allowlist and still not a directory walk: the paths are module
 * constants and nothing is ever taken from the URL, so there remains no path to
 * traverse. `/chart.mjs` earns its place because the projection it holds has to
 * run in BOTH Node (for the tests) and the browser (to draw), and the
 * alternative is two copies of the same maths.
 */
const STATIC_FILES = new Map([
  ['/', { path: () => DEFAULT_PAGE_PATH, type: 'text/html; charset=utf-8' }],
  ['/index.html', { path: () => DEFAULT_PAGE_PATH, type: 'text/html; charset=utf-8' }],
  ['/chart.mjs', { path: () => CHART_MODULE_PATH, type: 'text/javascript; charset=utf-8' }],
]);

export const DEFAULT_DASHBOARD_PORT = 3000;
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';

/**
 * Locks the page to what it already contains.
 *
 * `default-src 'none'` plus `connect-src 'self'` means the page cannot reach a
 * CDN, a font host or an analytics endpoint even if someone later pastes a
 * `<script src>` into it. That is the no-dependency rule enforced by the
 * browser rather than by a code review.
 *
 * `'unsafe-inline'` is required because the CSS and JS are inlined on purpose;
 * a nonce would be stricter but needs the page templated per request, and the
 * threat it defends against — injected inline script — has no route in here
 * while every value is written with textContent.
 */
/** The one external origin Tier B may frame, when Tier B is switched on. */
export const EMBED_ORIGIN = 'https://dexscreener.com';

/**
 * The page's Content-Security-Policy.
 *
 * A function rather than a constant because Tier B changes it: framing
 * dexscreener.com requires `frame-src`, and with `default-src 'none'` there is
 * no inherited permission to lean on. That directive is added ONLY when the
 * operator passed --dashboard-embed, so a default run cannot reach any external
 * origin from any directive — which is the property the whole design rests on.
 */
export function cspFor({ embed = false } = {}) {
  return (
    "default-src 'none'; " +
    "style-src 'unsafe-inline'; " +
    // 'self' is this server and nothing else — it admits /chart.mjs, which the
    // page imports so the chart projection is not duplicated.
    "script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; " +
    "img-src 'self' data:; " +
    `frame-src ${embed ? EMBED_ORIGIN : "'none'"}; ` +
    "base-uri 'none'; " +
    "form-action 'none'"
  );
}

/**
 * The Tier B embed URL for a mint. PURE.
 *
 * Verified against dexscreener.com: `?embed=1` accepts a **token mint**, not
 * only a pair address — it resolves the mint to its deepest pair itself, which
 * matters because the book stores mints and has no pair address to give.
 *
 * `trades=0&info=0` strip the trade list and the info panel, leaving the chart.
 * The mint is percent-encoded even though base58 needs none: the value comes
 * from chain data via a JSON payload, and "it should not contain that" is not a
 * reason to let it through unencoded.
 */
export function dexScreenerEmbedUrl(mint, { theme = 'dark', interval = null } = {}) {
  if (!mint || typeof mint !== 'string') return null;
  const q = new URLSearchParams({ embed: '1', theme, trades: '0', info: '0' });
  // DexScreener's own control offers 1s/1m/5m/15m/1h/4h/D. Whether a given pair
  // has 1s data is DexScreener's business, not ours, so this is only ever a
  // request and the chart falls back to its own default when it cannot serve.
  if (interval) q.set('interval', interval);
  return `${EMBED_ORIGIN}/solana/${encodeURIComponent(mint)}?${q.toString()}`;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

/**
 * Why a bind failed, in words that name the fix.
 *
 * Port 3000 is the most contested port on a development machine, and "Error:
 * listen EADDRINUSE" with a stack trace is not what someone needs to read at
 * that moment.
 */
export function explainListenError(err, { host, port } = {}) {
  switch (err?.code) {
    case 'EADDRINUSE':
      return `port ${port} is already in use — try --dashboard-port ${port + 1}`;
    case 'EACCES':
      return `not allowed to bind port ${port}${port < 1024 ? ' (ports below 1024 need elevation)' : ''}`;
    case 'EADDRNOTAVAIL':
      return `${host} is not an address on this machine`;
    default:
      return `could not listen on ${host}:${port} — ${err?.code ?? err?.message ?? 'unknown error'}`;
  }
}

/**
 * The URLs this binding is actually reachable at. PURE apart from reading the
 * interface list.
 *
 * Loopback always. LAN addresses only when bound past loopback, because
 * `http://localhost:3000` on a phone resolves to THE PHONE — printing a LAN URL
 * that does not work is worse than printing none.
 */
export function describeBinding(host, port, { interfaces = networkInterfaces } = {}) {
  const local = `http://127.0.0.1:${port}`;
  const wildcard = host === '0.0.0.0' || host === '::' || host === '';
  if (!wildcard) {
    return { local, lan: [], exposed: false, primary: `http://${host}:${port}` };
  }

  const lan = [];
  for (const addrs of Object.values(interfaces() ?? {})) {
    for (const a of addrs ?? []) {
      const family = a.family === 'IPv4' || a.family === 4;
      if (family && !a.internal) lan.push(`http://${a.address}:${port}`);
    }
  }
  return { local, lan, exposed: true, primary: local };
}

/**
 * A terminal hyperlink, when the terminal can render one.
 *
 * OSC 8 is what makes the URL Ctrl+Clickable in Windows Terminal without
 * relying on its URL auto-detection. Legacy conhost — the old powershell.exe
 * window — does not implement it, so the fallback is the bare URL, which
 * Windows Terminal auto-links anyway and which is selectable everywhere else.
 * Gated on the same `isTTY` signal the screen wipe already uses.
 */
export function terminalLink(url, text = url, { isTTY = false } = {}) {
  if (!isTTY) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * The line the tick header prints every frame.
 *
 * Every frame, and not once at startup: CLEAR_SCREEN is `\x1b[2J\x1b[3J\x1b[H`,
 * and `\x1b[3J` clears the SCROLLBACK. A banner printed before the first redraw
 * is not scrolled away, it is deleted — about five seconds later at --watch 5.
 * Rendering it into the frame also keeps it honest when EADDRINUSE pushed the
 * server to a port other than the one that was asked for.
 */
export function dashboardBanner(urls, { isTTY = false } = {}) {
  if (!urls) return '';
  const head = `  DASHBOARD  ${terminalLink(urls.local, urls.local, { isTTY })}`;
  if (!urls.exposed) return head;
  const lan = urls.lan.length
    ? urls.lan.map((u) => terminalLink(u, u, { isTTY })).join('  ')
    : '(no LAN address found)';
  return `${head}\n  ON THIS NETWORK  ${lan}   — anyone on this Wi-Fi can read this page`;
}

/* ------------------------------------------------------------------ *
 * Server-Sent Events
 * ------------------------------------------------------------------ */

/** Default keepalive. Long enough to be invisible, short enough to hold. */
export const KEEPALIVE_MS = 15_000;

/**
 * Bytes we will let queue for one client before dropping it.
 *
 * A backgrounded or suspended browser tab stops reading while the socket stays
 * open, and every tick then appends another frame to a buffer nobody drains.
 * Dropping is correct: EventSource reconnects on its own, and a client that
 * reconnects gets the CURRENT frame rather than replaying a queue of stale
 * ones it no longer cares about.
 */
export const MAX_CLIENT_BUFFER_BYTES = 1_000_000;

/**
 * One SSE frame. PURE.
 *
 * ── WHY THE SPLIT LOOP, WHEN JSON.stringify NEVER EMITS A RAW NEWLINE ───────
 * Because framing must not depend on that being remembered. A newline inside
 * the payload terminates the `data:` line, and everything after it is parsed as
 * a new field or, worse, as the blank line that ends the event — so one token
 * symbol containing "\n" would corrupt not just its own frame but the framing
 * of the stream from that point on. Memecoin tickers contain anything.
 *
 * The SSE spec treats \r, \n and \r\n all as line terminators, so all three are
 * split on, and a multi-line payload becomes multiple `data:` lines that the
 * browser rejoins with "\n". That is the spec's own answer, not a workaround.
 */
export function encodeSseFrame(payload, { event = null, id = null, retry = null } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let out = '';
  if (event !== null) out += `event: ${event}\n`;
  if (id !== null) out += `id: ${id}\n`;
  if (retry !== null) out += `retry: ${retry}\n`;
  for (const line of String(text ?? '').split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** A comment frame. Keeps proxies and sleeping laptops from dropping the socket. */
export const SSE_KEEPALIVE = ':ping\n\n';

/**
 * The set of connected browsers.
 *
 * Each client carries its OWN focused mint, because focus is a per-viewer
 * choice and a broadcast that used one global focus would yank the chart out
 * from under a second viewer. Frames are serialised once per DISTINCT focus
 * within a broadcast, so the common case — nobody focused, or everyone on the
 * same mint — costs one stringify no matter how many tabs are open.
 */
export function createSseHub({ keepaliveMs = KEEPALIVE_MS, maxBufferBytes = MAX_CLIENT_BUFFER_BYTES } = {}) {
  const clients = new Set();
  let timer = null;

  const drop = (client) => {
    if (!clients.delete(client)) return;
    try {
      client.res.end();
    } catch {
      /* already gone */
    }
    if (!clients.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const write = (client, chunk) => {
    try {
      // A client that has stopped reading is dropped rather than buffered
      // forever. It will reconnect and get the current frame.
      if ((client.res.writableLength ?? 0) > maxBufferBytes) {
        drop(client);
        return false;
      }
      client.res.write(chunk);
      return true;
    } catch {
      drop(client);
      return false;
    }
  };

  return {
    get size() {
      return clients.size;
    },

    add(res, { focusedMint = null, retryMs = 2000 } = {}) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx and friends buffer streamed responses by default, which turns a
        // live feed into a slideshow. Harmless locally, correct anywhere else.
        'x-accel-buffering': 'no',
      });
      res.flushHeaders?.();

      const client = { res, focusedMint };
      clients.add(client);
      // Tells the browser how fast to come back. EventSource reconnects on its
      // own; this only sets the pace.
      res.write(`retry: ${retryMs}\n\n`);

      const remove = () => drop(client);
      res.on('close', remove);
      res.on('error', remove);

      if (keepaliveMs > 0 && !timer) {
        timer = setInterval(() => {
          for (const c of [...clients]) write(c, SSE_KEEPALIVE);
        }, keepaliveMs);
        // Never hold the process open for a heartbeat. The tick loop is what
        // keeps this program alive; the dashboard is a passenger.
        timer.unref?.();
      }

      return client;
    },

    /**
     * Push one frame to everyone.
     *
     * `build` is called once per distinct focus, not once per client.
     */
    broadcast(build) {
      if (!clients.size) return 0;
      const byFocus = new Map();
      let sent = 0;
      for (const client of [...clients]) {
        const key = client.focusedMint ?? '';
        if (!byFocus.has(key)) {
          try {
            byFocus.set(key, encodeSseFrame(build(client.focusedMint)));
          } catch (err) {
            // One bad frame must not take down the stream or the tick.
            byFocus.set(key, encodeSseFrame({ error: 'state unavailable', message: err?.message ?? String(err) }));
          }
        }
        if (write(client, byFocus.get(key))) sent++;
      }
      return sent;
    },

    close() {
      for (const client of [...clients]) drop(client);
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** Route table. Async, and it never throws — see handleRequest's contract. */
async function route({ pathname, searchParams, method, getState, pagePath, hub, res }) {
  const asset = STATIC_FILES.get(pathname);
  if (asset) {
    // pagePath stays overridable for tests; the rest resolve from the module.
    const file = pathname === '/chart.mjs' ? asset.path() : pagePath;
    try {
      return { status: 200, type: asset.type, body: await readFile(file, 'utf8') };
    } catch (err) {
      // A missing file is a deployment problem, not a book problem. Say which
      // one, because the path is resolved from the module and not from cwd.
      return {
        status: 500,
        type: 'text/plain; charset=utf-8',
        body: `dashboard asset not found at ${file}\n${err?.message ?? ''}`,
      };
    }
  }

  if (pathname === '/api/state') {
    // getState reaches into the live tick process. If it throws, the dashboard
    // reports it and the BOOK KEEPS RUNNING — a UI must never be able to take
    // down the thing it is looking at.
    try {
      const state = await getState({ focusedMint: searchParams.get('focus') ?? null });
      return { status: 200, json: state };
    } catch (err) {
      return { status: 500, json: { error: 'state unavailable', message: err?.message ?? String(err) } };
    }
  }

  if (pathname === '/api/stream') {
    if (!hub) {
      return { status: 501, json: { error: 'not implemented', message: 'this server was built without a stream hub' } };
    }
    if (method === 'HEAD') {
      return { status: 200, type: 'text/event-stream; charset=utf-8', body: '' };
    }
    const focusedMint = searchParams.get('focus') ?? null;
    hub.add(res, { focusedMint });
    // The first frame goes out immediately. Waiting for the next tick would
    // leave a freshly opened page blank for up to the whole interval, which
    // reads as broken rather than as waiting.
    try {
      res.write(encodeSseFrame(await getState({ focusedMint })));
    } catch (err) {
      res.write(encodeSseFrame({ error: 'state unavailable', message: err?.message ?? String(err) }));
    }
    return { streaming: true };
  }

  return { status: 404, json: { error: 'not found', routes: ['/', '/api/state', '/api/stream'] } };
}

/**
 * One request. Never throws, never rejects: an unhandled error here would take
 * out the process that is holding the book.
 */
export async function handleRequest(req, res, { getState, pagePath = DEFAULT_PAGE_PATH, hub = null, embed = false } = {}) {
  try {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return sendJson(res, 405, { error: 'method not allowed', message: 'the dashboard is read-only' });
    }

    // The base is a throwaway — only pathname and query are used. Parsing with
    // URL rather than by hand is what makes `/api/state?focus=x#y` and a
    // percent-encoded path behave.
    const url = new URL(req.url ?? '/', 'http://dashboard.invalid');
    const result = await route({
      pathname: url.pathname,
      searchParams: url.searchParams,
      method,
      getState,
      pagePath,
      hub,
      res,
    });

    // An SSE response is owned by the hub now; it stays open until the client
    // leaves, so there is nothing here to end.
    if (result.streaming) return;
    if (result.json !== undefined) return sendJson(res, result.status, result.json);

    const body = result.body ?? '';
    res.writeHead(result.status, {
      'content-type': result.type,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': cspFor({ embed }),
      'referrer-policy': 'no-referrer',
    });
    res.end(method === 'HEAD' ? undefined : body);
  } catch (err) {
    try {
      sendJson(res, 500, { error: 'handler failed', message: err?.message ?? String(err) });
    } catch {
      // The socket is already gone. Nothing to do, and nothing worth crashing
      // the tick loop over.
    }
  }
}

/**
 * Bind the dashboard server.
 *
 * ── RESOLVES AN OUTCOME, NEVER REJECTS ──────────────────────────────────────
 * `{ ok: false, code: 'EADDRINUSE' }` instead of a thrown error, because the
 * caller is a running paper book and the correct response to "port 3000 is
 * busy" is a printed line, not a dead engine. The book must never die because a
 * UI could not bind.
 *
 * The reported port is `server.address().port`, not the requested one — with
 * port 0 the OS assigns it, and that is also what keeps the banner honest after
 * a fallback.
 */
export async function createDashboardServer({
  host = DEFAULT_DASHBOARD_HOST,
  port = DEFAULT_DASHBOARD_PORT,
  getState,
  pagePath = DEFAULT_PAGE_PATH,
  httpImpl = http,
  hub = null,
  embed = false,
} = {}) {
  if (typeof getState !== 'function') {
    return { ok: false, code: 'NO_STATE_SOURCE', message: 'createDashboardServer needs a getState function' };
  }

  const server = httpImpl.createServer((req, res) => handleRequest(req, res, { getState, pagePath, hub, embed }));

  return new Promise((resolve) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      resolve({
        ok: false,
        code: err?.code ?? 'LISTEN_FAILED',
        message: explainListenError(err, { host, port }),
        error: err,
      });
    };

    const onListening = () => {
      server.removeListener('error', onError);
      // A LATER error — a client resetting a connection, say — would be an
      // unhandled 'error' event and would throw. Swallowing it here is what
      // keeps a dropped socket from killing the book.
      server.on('error', () => {});

      const actualPort = server.address()?.port ?? port;
      resolve({
        ok: true,
        server,
        host,
        port: actualPort,
        urls: describeBinding(host, actualPort),
        hub,
        close: () =>
          new Promise((done) => {
            hub?.close();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/* ------------------------------------------------------------------ *
 * Price history recorder
 * ------------------------------------------------------------------ *
 *
 * The samples phase 4's chart draws. One point per open position per tick,
 * taken from the mark the engine already computed — this makes no network call
 * and asks no question the tick did not already answer.
 */

/**
 * Bounded per-mint sample buffers, plus the markers that go on the chart.
 *
 * Buffers for closed mints are dropped, so a long session's memory tracks what
 * is OPEN rather than everything ever held. A re-entered mint starts a fresh
 * series, which is correct: the old line belonged to a different position.
 */
export function createSeriesRecorder({ limit = SERIES_POINT_LIMIT } = {}) {
  const series = new Map();
  const marks = new Map();

  const push = (map, mint, entry) => {
    const list = map.get(mint) ?? [];
    list.push(entry);
    // Trim in place at the cap rather than on read: read happens every tick,
    // and slicing a 300-item array on every one of them is work for nothing.
    if (list.length > limit) list.splice(0, list.length - limit);
    map.set(mint, list);
  };

  return {
    /** Sample every open position. Call once per tick, after marks are set. */
    record(book, now = Date.now()) {
      const open = new Set();
      for (const p of Object.values(book?.positions ?? {})) {
        if (!p?.mint) continue;
        open.add(p.mint);
        if (!Number.isFinite(p.markPriceUsd) || p.markPriceUsd <= 0) continue;

        // First sight of a position: seed the chart with its ENTRY, at the
        // price actually paid, so the marker sits where the fill was and not
        // where the mid happened to be.
        if (!series.has(p.mint)) {
          push(marks, p.mint, {
            t: p.openedAt ?? now,
            priceUsd: p.entryPriceUsd,
            kind: 'ENTRY',
            label: `entry ${Number(p.entryPriceUsd).toPrecision(4)}`,
          });
        }
        push(series, p.mint, { t: now, priceUsd: p.markPriceUsd });
      }

      for (const mint of [...series.keys()]) {
        if (!open.has(mint)) {
          series.delete(mint);
          marks.delete(mint);
        }
      }
    },

    /** Markers from a tick report: scale-ins and exits. */
    noteReport(report, now = Date.now()) {
      for (const o of report?.opened ?? []) {
        if (o?.scaledIn && o.mint) {
          push(marks, o.mint, { t: now, priceUsd: o.priceUsd ?? null, kind: 'SCALE', label: 'scale-in' });
        }
      }
      for (const e of report?.exits ?? []) {
        if (!e?.mint) continue;
        push(marks, e.mint, {
          t: now,
          priceUsd: e.priceUsd ?? null,
          kind: e.sellFraction && e.sellFraction < 1 ? 'TP' : 'EXIT',
          label: e.label ?? e.trigger ?? 'exit',
        });
      }
    },

    get seriesByMint() {
      return Object.fromEntries(series);
    },
    get marksByMint() {
      return Object.fromEntries(marks);
    },
    get trackedMints() {
      return series.size;
    },
  };
}

/* ------------------------------------------------------------------ *
 * The one call paper_copytrade makes
 * ------------------------------------------------------------------ */

/**
 * Start the dashboard alongside a running book.
 *
 * ── IN-PROCESS, AND THAT IS THE WHOLE DESIGN ────────────────────────────────
 * This holds a REFERENCE to the same book object the tick loop is mutating. It
 * never opens `.state/paper_copytrade.json` — not to write it, and not to read
 * it either.
 *
 * `detectConcurrentWriter` exists because two processes on that file produced
 * three separate false diagnoses in this repo: a --reset that appeared not to
 * work, a fresh book that appeared to replay history, and settings changes that
 * appeared to have no effect. Each looked like an engine bug. A standalone
 * dashboard process reading the JSON would walk straight back into it — and
 * would additionally be exposed to torn reads, since saveBook is a plain
 * writeFile with no temp-and-rename.
 *
 * There is exactly one writer, and it is the tick.
 */
export async function startDashboard({
  host = DEFAULT_DASHBOARD_HOST,
  port = DEFAULT_DASHBOARD_PORT,
  book,
  cfg,
  getContext = () => ({}),
  keepaliveMs = KEEPALIVE_MS,
  seriesLimit = SERIES_POINT_LIMIT,
  // Tier B. OFF unless asked for: turning it on relaxes the page's CSP and
  // makes it possible for the browser to tell dexscreener.com which mints this
  // book holds. See the note's Tier B section.
  embed = false,
} = {}) {
  const recorder = createSeriesRecorder({ limit: seriesLimit });
  const hub = createSseHub({ keepaliveMs });

  const stateFor = (focusedMint) =>
    buildDashboardState(book, cfg, {
      ...getContext(),
      focusedMint,
      seriesByMint: recorder.seriesByMint,
      marksByMint: recorder.marksByMint,
      embed,
    });

  const server = await createDashboardServer({
    host,
    port,
    hub,
    embed,
    getState: ({ focusedMint }) => stateFor(focusedMint),
  });

  if (!server.ok) return server;

  return {
    ok: true,
    urls: server.urls,
    port: server.port,
    embed,
    clients: () => hub.size,
    /** Call once per tick, after saveBook and after the spot refresh. */
    publish(report = null, now = Date.now()) {
      recorder.record(book, now);
      if (report) recorder.noteReport(report, now);
      return hub.broadcast(stateFor);
    },
    close: () => server.close(),
  };
}
