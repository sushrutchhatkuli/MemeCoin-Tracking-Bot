/**
 * Tier A chart geometry — our samples, our markers. PURE, and dependency-free
 * on purpose: this module is imported by `dashboard.mjs` for its tests AND
 * served to the browser as `/chart.mjs`, so there is ONE implementation of the
 * projection rather than one in Node and a second one in a <script> block that
 * drifts from it.
 *
 * ── WHAT THIS CHART IS, AND WHAT IT IS NOT ──────────────────────────────────
 * It draws the marks the engine already took, one per position per tick. That
 * buys the thing a DexScreener embed cannot give at any price: the entry,
 * scale-ins, fired take-profit rungs and the exit land EXACTLY where the book
 * recorded them, because it is the book's own data.
 *
 * What it gives up, and what the caption has to say out loud: between two
 * samples we know nothing. At `--watch 5` a spike that began and ended inside
 * one interval never happened as far as this chart is concerned. These are not
 * candles and there are no wicks — a candle claims a high and a low within its
 * period, and we did not observe either.
 *
 * ── WHY GAPS BREAK THE LINE ─────────────────────────────────────────────────
 * A straight segment between two samples 5 seconds apart is a fair reading of
 * an unobserved interval. The same segment drawn across a four-minute stall —
 * a wedged tick, a position that could not be priced, a laptop that slept — is
 * a claim about four minutes of price action nobody watched. So a gap wider
 * than `gapFactor` x the median interval BREAKS the path, and the caller draws
 * the hole rather than a line through it.
 */

/** Marker kinds, in the order they should paint. Later kinds sit on top. */
export const MARK_KINDS = ['ENTRY', 'SCALE', 'TP', 'EXIT'];

const DEFAULT_PADDING = { top: 10, right: 10, bottom: 20, left: 58 };

/**
 * The sampling cadence, from the gaps between samples. PURE.
 *
 * ── THE SMALLEST GAP, NOT THE MEDIAN ────────────────────────────────────────
 * The tick fires on a fixed interval, so the true cadence is a constant and the
 * observed gaps are that constant contaminated in ONE direction only: a stall,
 * a sleeping laptop or a position that could not be priced makes a gap longer,
 * and nothing can make one meaningfully shorter than the interval itself. The
 * distribution is therefore right-skewed with a hard floor, and the floor is
 * what we are trying to measure.
 *
 * The median was the first choice here and it is wrong, in a way that only
 * showed up on a short series: with two gaps of 5s and 395s the median is their
 * MEAN, 200s. The stall then inflates the very baseline meant to detect it — no
 * gap is found, the line is drawn straight through four unobserved minutes, and
 * the caption calls it a "~200s cadence". The minimum is immune to that by
 * construction, at every sample count, which is what a 3-point series needs.
 *
 * Returns null when there is nothing to measure from.
 */
export function samplingCadenceMs(diffs) {
  const positive = diffs.filter((d) => Number.isFinite(d) && d > 0);
  return positive.length ? Math.min(...positive) : null;
}

/** Round to a tenth of a pixel. Keeps the path string small without visible cost. */
const px = (n) => Math.round(n * 10) / 10;

/**
 * Project a series and its markers into SVG coordinates.
 *
 * Everything returned is numeric. Formatting belongs to the renderer, which
 * already knows how this project writes a price, and duplicating that here
 * would be a second place for it to drift.
 */
export function buildChartGeometry({
  series = [],
  marks = [],
  width = 640,
  height = 220,
  padding = DEFAULT_PADDING,
  gapFactor = 3,
  yTickCount = 4,
  xTickCount = 3,
} = {}) {
  const pad = { ...DEFAULT_PADDING, ...padding };
  const plot = {
    x: pad.left,
    y: pad.top,
    w: Math.max(1, width - pad.left - pad.right),
    h: Math.max(1, height - pad.top - pad.bottom),
  };

  const pts = (Array.isArray(series) ? series : []).filter(
    (p) => p && Number.isFinite(p.t) && Number.isFinite(p.priceUsd) && p.priceUsd > 0
  );

  if (!pts.length) {
    return { ok: false, reason: 'no samples', width, height, plot, points: [], markers: [], segments: [], path: '' };
  }

  const usableMarks = (Array.isArray(marks) ? marks : []).filter((m) => m && Number.isFinite(m.t));

  // ── X DOMAIN ─────────────────────────────────────────────────────────────
  // The samples alone. Markers are clamped INTO this window rather than
  // widening it: an ENTRY recorded long before the recorder started would
  // otherwise stretch the axis across dead time and squash the part that has
  // data into a few pixels.
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const tSpan = t1 - t0;

  // ── Y DOMAIN ─────────────────────────────────────────────────────────────
  // Includes marker prices, so an entry below everything since is still on the
  // canvas instead of clipped off the bottom edge without explanation.
  const prices = pts.map((p) => p.priceUsd);
  for (const m of usableMarks) if (Number.isFinite(m.priceUsd) && m.priceUsd > 0) prices.push(m.priceUsd);

  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (!(hi > lo)) {
    // A perfectly flat series has no range to divide by. Give it a nominal one
    // and let it draw as the flat line it is, centred.
    const nudge = Math.abs(hi) * 0.01 || 1e-12;
    lo -= nudge;
    hi += nudge;
  } else {
    const headroom = (hi - lo) * 0.08;
    lo -= headroom;
    hi += headroom;
  }

  const scaleX = (t) => plot.x + (tSpan > 0 ? ((t - t0) / tSpan) * plot.w : plot.w / 2);
  const scaleY = (p) => plot.y + plot.h - ((p - lo) / (hi - lo)) * plot.h;

  const points = pts.map((p) => ({ t: p.t, priceUsd: p.priceUsd, x: px(scaleX(p.t)), y: px(scaleY(p.priceUsd)) }));

  // ── SAMPLE CADENCE, MEASURED ─────────────────────────────────────────────
  // Read off the data, never assumed to be 5s. The caption is built from this,
  // so a chart running at --watch 1 cannot claim a 5-second cadence.
  const diffs = [];
  for (let i = 1; i < pts.length; i++) diffs.push(pts[i].t - pts[i - 1].t);
  const sampleIntervalMs = samplingCadenceMs(diffs);

  // ── SEGMENTS, BROKEN AT GAPS ─────────────────────────────────────────────
  const gapThresholdMs = sampleIntervalMs ? sampleIntervalMs * gapFactor : Infinity;
  const segments = [];
  const gaps = [];
  let current = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && pts[i].t - pts[i - 1].t > gapThresholdMs) {
      if (current.length) segments.push(current);
      gaps.push({
        fromT: pts[i - 1].t,
        toT: pts[i].t,
        durationMs: pts[i].t - pts[i - 1].t,
        x1: points[i - 1].x,
        x2: points[i].x,
      });
      current = [];
    }
    current.push(points[i]);
  }
  if (current.length) segments.push(current);

  const toPath = (seg) =>
    seg.length === 1
      ? `M ${seg[0].x} ${seg[0].y} L ${seg[0].x} ${seg[0].y}`
      : `M ${seg[0].x} ${seg[0].y} ` + seg.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ');

  const segmentPaths = segments.map(toPath);

  // ── MARKERS ──────────────────────────────────────────────────────────────
  // A marker outside the sampled window is CLAMPED to the edge and flagged, so
  // the renderer can show it as "at or before this point" rather than draw it
  // at a time it did not happen. An ENTRY usually lands here: positions are
  // routinely older than the recorder, which starts when the dashboard does.
  const markers = usableMarks
    .map((m) => {
      const clampedT = Math.min(Math.max(m.t, t0), t1);
      const clamped = m.t < t0 || m.t > t1;
      // A marker with no price of its own rides the line at its own timestamp.
      const priceUsd =
        Number.isFinite(m.priceUsd) && m.priceUsd > 0 ? m.priceUsd : priceAt(pts, clampedT);
      return {
        kind: MARK_KINDS.includes(m.kind) ? m.kind : 'TP',
        label: m.label ?? m.kind ?? '',
        t: m.t,
        priceUsd,
        x: px(scaleX(clampedT)),
        y: px(scaleY(priceUsd)),
        clamped,
        clampedFrom: clamped ? (m.t < t0 ? 'before' : 'after') : null,
      };
    })
    .sort((a, b) => MARK_KINDS.indexOf(a.kind) - MARK_KINDS.indexOf(b.kind));

  // ── AXES ─────────────────────────────────────────────────────────────────
  const yTicks = [];
  for (let i = 0; i < yTickCount; i++) {
    const value = lo + ((hi - lo) * i) / (yTickCount - 1);
    yTicks.push({ priceUsd: value, y: px(scaleY(value)) });
  }
  const xTicks = [];
  for (let i = 0; i < xTickCount; i++) {
    const t = t0 + (tSpan * i) / (xTickCount - 1 || 1);
    xTicks.push({ t, x: px(scaleX(t)) });
  }

  return {
    ok: true,
    width,
    height,
    plot,
    xDomain: [t0, t1],
    yDomain: [lo, hi],
    points,
    segments: segmentPaths,
    path: segmentPaths.join(' '),
    gaps,
    markers,
    yTicks,
    xTicks,
    sampleIntervalMs,
    spanMs: tSpan,
    sampleCount: pts.length,
    // The first and last samples, so a renderer can label the line's ends
    // without re-deriving which point is which.
    first: points[0],
    last: points[points.length - 1],
  };
}

/** The sampled price at (or just before) a timestamp. PURE. */
function priceAt(pts, t) {
  let best = pts[0];
  for (const p of pts) {
    if (p.t <= t) best = p;
    else break;
  }
  return best.priceUsd;
}

/**
 * The caption under the chart, built from what was measured.
 *
 * Deliberately not "1-second candles". These are marks at whatever cadence the
 * tick actually ran, and the sentence says so — including, when it happened,
 * that the line has holes in it.
 */
export function describeChart(geo) {
  if (!geo?.ok) return 'no samples yet';
  const secs = geo.sampleIntervalMs ? Math.round(geo.sampleIntervalMs / 1000) : null;
  const cadence = secs ? `~${secs}s` : 'irregular';
  const parts = [`${geo.sampleCount} marks · ${cadence} cadence`];
  if (geo.gaps.length) {
    parts.push(`${geo.gaps.length} gap${geo.gaps.length > 1 ? 's' : ''} — the line is broken where nothing was sampled`);
  }
  return parts.join(' · ');
}
