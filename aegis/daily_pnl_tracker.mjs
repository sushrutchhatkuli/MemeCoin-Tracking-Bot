#!/usr/bin/env node
/**
 * Daily PnL tracker — a 24-hour window that resets when GMGN's does.
 *
 *   node aegis/daily_pnl_tracker.mjs             one report
 *   node aegis/daily_pnl_tracker.mjs --watch 1   live, redrawn every second
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ANCHOR IS 00:00 UTC, NOT 8 PM EST, AND THOSE ARE DIFFERENT INSTANTS.
 *
 * The two coincide only under Eastern DAYLIGHT time. MEASURED:
 *
 *   8:00 PM EDT (Mar-Nov)  =  00:00 UTC   ✅
 *   8:00 PM EST (Nov-Mar)  =  01:00 UTC   ❌ one hour later
 *   00:00 UTC in winter    =  7:00 PM EST
 *
 * So a tracker built literally on "8 PM Eastern" drifts an hour away from GMGN
 * twice a year, on 1 November and again in March. It would look perfect today —
 * this is written in August, when they agree — and quietly disagree from
 * November, which is the worst possible failure shape for a number people check
 * daily.
 *
 * GMGN's own calendar is labelled UTC+0, so UTC is the anchor that actually
 * matches it. The Eastern label is rendered from the timezone database instead
 * of assumed, so the dashboard says "8:00 PM EDT" in summer and "7:00 PM EST"
 * in winter — both of which are the same instant as 00:00 UTC.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 3600 * 1000;

export const RESET_TIMEZONE = 'America/New_York';
export const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/* ------------------------------------------------------------------ *
 * The window
 * ------------------------------------------------------------------ */

/**
 * How 00:00 UTC reads on an Eastern clock, from the tz database. PURE-ish.
 *
 * Computed rather than hardcoded because the answer changes with daylight
 * saving, and hardcoding "8:00 PM EST" is the bug this module exists to avoid.
 */
export function easternLabelFor(instant, timeZone = RESET_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).formatToParts(instant);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('hour')}:${get('minute')} ${get('dayPeriod')} ${get('timeZoneName')}`;
}

/**
 * The current 24-hour window. PURE.
 *
 * Boundaries are computed in UTC, where a day is always exactly 24 hours.
 * Deriving them in a zone that observes daylight saving would make two days a
 * year 23 or 25 hours long, and a "24h PnL" that silently covered 25 hours is
 * a number nobody could reconcile against an exchange.
 */
export function dailyWindow(now = Date.now(), { timeZone = RESET_TIMEZONE } = {}) {
  const t = now instanceof Date ? now.getTime() : now;
  const start = Date.UTC(
    new Date(t).getUTCFullYear(),
    new Date(t).getUTCMonth(),
    new Date(t).getUTCDate()
  );
  const end = start + DAY_MS;
  return {
    start,
    end,
    startIso: new Date(start).toISOString(),
    // Elapsed and remaining, so the dashboard can say how much of the day the
    // figures actually cover — a +40% at 00:10 UTC means something very
    // different from +40% at 23:50.
    elapsedMs: t - start,
    remainingMs: end - t,
    elapsedPct: ((t - start) / DAY_MS) * 100,
    resetLabelUtc: '00:00 UTC',
    resetLabelLocal: easternLabelFor(new Date(end), timeZone),
    timeZone,
  };
}

/** "3h 12m" — for a countdown that has to fit in a box. PURE. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

/**
 * PnL for trades that CLOSED inside the window. PURE.
 *
 * ── CLOSED-IN-WINDOW, NOT OPENED-IN-WINDOW ──────────────────────────────────
 * A position opened yesterday and closed today belongs to today: the money
 * moved today. Filtering on openedAt instead would credit a win to the day the
 * bet was placed, which is not what a daily leaderboard measures and would make
 * the figure impossible to reconcile against GMGN.
 *
 * ── ZERO TRADES IS NOT ZERO PERCENT ─────────────────────────────────────────
 * With nothing closed, the win rate is UNKNOWN and reported as null. Rendering
 * it as 0% says "you lost every trade" when the truth is "you made none" — the
 * same distinction this project already draws for an absent holder count and an
 * empty calibration ledger.
 */
export function aggregateDailyPnl({ book = {}, window: win, solUsd = null } = {}) {
  const w = win ?? dailyWindow();
  const closed = (book.closed ?? []).filter(
    (c) => Number.isFinite(c?.closedAt) && c.closedAt >= w.start && c.closedAt < w.end
  );

  const wins = closed.filter((c) => (c.pnlSol ?? 0) > 0);
  const losses = closed.filter((c) => (c.pnlSol ?? 0) < 0);
  const realisedSol = closed.reduce((a, c) => a + (c.pnlSol ?? 0), 0);

  // Unrealised across every OPEN position, whenever it was opened. A bag held
  // from last week is still part of what the account is worth right now, and
  // excluding it would make equity disagree with the scorecard.
  const positions = Object.values(book.positions ?? {});
  let unrealisedSol = 0;
  for (const p of positions) {
    const entry = p.entryPriceUsd;
    const mark = p.markPriceUsd;
    if (!(entry > 0) || !(mark > 0) || !Number.isFinite(p.stakeSol)) continue;
    unrealisedSol += p.stakeSol * (mark / entry) - p.stakeSol;
  }

  const anchorSol = Number.isFinite(book.budgetSol) && book.budgetSol > 0 ? book.budgetSol : null;
  const totalSol = realisedSol + unrealisedSol;

  return {
    window: w,
    closedCount: closed.length,
    wins: wins.length,
    losses: losses.length,
    // null, not 0 — see above.
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
    realisedSol,
    unrealisedSol,
    totalSol,
    openPositions: positions.length,
    // ROI against the book's original budget, which is fixed at creation. A
    // denominator that moved with equity would report a smaller percentage
    // exactly as the account grew.
    roiPct: anchorSol ? (totalSol / anchorSol) * 100 : null,
    anchorSol,
    solUsd,
    realisedUsd: Number.isFinite(solUsd) ? realisedSol * solUsd : null,
    unrealisedUsd: Number.isFinite(solUsd) ? unrealisedSol * solUsd : null,
    totalUsd: Number.isFinite(solUsd) ? totalSol * solUsd : null,
    best: closed.reduce((b, c) => (!b || (c.pnlSol ?? 0) > (b.pnlSol ?? 0) ? c : b), null),
    worst: closed.reduce((b, c) => (!b || (c.pnlSol ?? 0) < (b.pnlSol ?? 0) ? c : b), null),
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const W = 62;
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n).slice(-n);

function money(n, { sign = true } = {}) {
  if (!Number.isFinite(n)) return '—';
  const s = n < 0 ? '-' : sign ? '+' : '';
  return `${s}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}
function sol(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(4)} SOL`;
}

/** A proportional bar. PURE — split out so the arithmetic is testable. */
export function progressBar(fraction, width = 40) {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const filled = Math.round(f * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

/** The dashboard. PURE — takes an aggregate, returns a string. */
export function renderDailyReport(agg, { title = 'DAILY PnL — 24H WINDOW' } = {}) {
  const w = agg.window;
  const line = (l, r) => `║ ${pad(l, 20)}${padL(r, W - 24)} ║`;

  const rows = [
    '╔' + '═'.repeat(W - 2) + '╗',
    `║ ${pad(title, W - 4)} ║`,
    '╠' + '═'.repeat(W - 2) + '╣',
    line('window opened', new Date(w.start).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'),
    line('resets at', `${w.resetLabelUtc}  ·  ${w.resetLabelLocal}`),
    line('resets in', formatDuration(w.remainingMs)),
    `║ ${progressBar(w.elapsedMs / DAY_MS, W - 12)} ${padL(w.elapsedPct.toFixed(0) + '%', 7)} ║`,
    '╠' + '═'.repeat(W - 2) + '╣',
  ];

  if (agg.closedCount === 0) {
    // Said plainly rather than rendered as a row of zeroes, which reads as a
    // flat day instead of an empty one.
    rows.push(line('closed trades', '0 — no trades closed in this window yet'));
    rows.push(line('win rate', 'n/a until a trade closes'));
  } else {
    rows.push(line('closed trades', `${agg.closedCount}   ${agg.wins}W / ${agg.losses}L`));
    rows.push(line('win rate', `${agg.winRatePct.toFixed(1)}%`));
  }

  rows.push(
    line('realised', `${sol(agg.realisedSol)}${agg.realisedUsd !== null ? '   ' + money(agg.realisedUsd) : ''}`),
    line('unrealised', `${sol(agg.unrealisedSol)}${agg.unrealisedUsd !== null ? '   ' + money(agg.unrealisedUsd) : ''}`),
    '╟' + '─'.repeat(W - 2) + '╢',
    line('TOTAL 24H', `${sol(agg.totalSol)}${agg.totalUsd !== null ? '   ' + money(agg.totalUsd) : ''}`),
    line('ROI vs budget', agg.roiPct === null ? 'n/a — no budget on the book' : `${agg.roiPct >= 0 ? '+' : ''}${agg.roiPct.toFixed(2)}%`)
  );

  if (agg.best && (agg.best.pnlSol ?? 0) > 0) {
    rows.push(line('best', `${agg.best.symbol ?? agg.best.mint?.slice(0, 8)}  ${sol(agg.best.pnlSol)}`));
  }
  if (agg.worst && (agg.worst.pnlSol ?? 0) < 0) {
    rows.push(line('worst', `${agg.worst.symbol ?? agg.worst.mint?.slice(0, 8)}  ${sol(agg.worst.pnlSol)}`));
  }
  rows.push(line('open positions', String(agg.openPositions)));

  rows.push('╠' + '═'.repeat(W - 2) + '╣');
  rows.push(`║ ${pad('unrealised is a MARK — see the depth note in the plan', W - 4)} ║`);
  rows.push('╚' + '═'.repeat(W - 2) + '╝');
  return rows.join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export async function loadTrackerBook(path = join(HERE, '.state', 'paper_copytrade.json')) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    return { error: err.message, closed: [], positions: {} };
  }
}

export async function main(argv = []) {
  const bookIdx = argv.indexOf('--book');
  const bookPath = bookIdx !== -1 && argv[bookIdx + 1] ? resolve(argv[bookIdx + 1]) : join(HERE, '.state', 'paper_copytrade.json');

  const watchIdx = argv.indexOf('--watch');
  const intervalSec = watchIdx !== -1 ? Math.max(1, Number(argv[watchIdx + 1]) || 1) : null;

  let solUsd = null;
  try {
    ({ default: solUsd } = { default: await (await import('./paper_copytrade.mjs')).fetchSolUsd() });
  } catch {
    /* USD columns degrade to SOL-only rather than failing the report */
  }

  const draw = async () => {
    const book = await loadTrackerBook(bookPath);
    const agg = aggregateDailyPnl({ book, window: dailyWindow(Date.now()), solUsd });
    if (intervalSec && process.stdout.isTTY) process.stdout.write(CLEAR_SCREEN);
    console.log(renderDailyReport(agg));
    if (book.error) console.log(`\n  book unreadable: ${book.error}`);
  };

  await draw();
  if (!intervalSec) return;

  console.log(`\n  refreshing every ${intervalSec}s — Ctrl+C to stop`);
  process.on('SIGINT', () => process.exit(0));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
    await draw();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main(process.argv.slice(2));
}
