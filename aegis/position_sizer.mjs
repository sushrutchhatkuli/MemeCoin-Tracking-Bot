#!/usr/bin/env node
/**
 * Dynamic position sizer — conviction score to recommended SOL size.
 *
 *   node position_sizer.mjs           print the ladder and worked examples
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON THE NAME. This is a fixed conviction ladder, not the Kelly criterion.
 * Kelly is f* = (bp - q) / b and needs a win probability and a payoff ratio;
 * Aegis has neither at the moment of alert. The nearest thing on file is the
 * post-mortem base rate, which currently sits around a 77% rug rate across
 * 2,500 graded tokens — plugged into Kelly honestly that returns a negative
 * fraction, i.e. "do not size this at all". The ladder below is a deliberate
 * override of that arithmetic with a human risk appetite, which is a
 * legitimate thing to do, but it should not be mistaken for a derived optimum.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE SIZE IS NOT AWARE OF. The ladder keys on score alone. It does not
 * know your bankroll, your open exposure, or — importantly — how deep the pool
 * is. 2 SOL into an 800 SOL pool is a rounding error; 2 SOL into a 12 SOL pool
 * is most of the float and will move the price against you on entry and again
 * on exit.
 *
 * So `poolSharePct` is computed and returned whenever pool depth is known, and
 * the alert prints it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE POOL IMPACT CAP. As of 2026-08-09 the sizer DOES reduce the size: no
 * recommendation may exceed maxPoolSharePct (5%) of the pool's SOL side,
 * whatever the score says. The ladder proposes; the pool disposes.
 *
 * This reverses the previous behaviour, where the configured number was always
 * the number you got and depth was a warning only. The warning was the wrong
 * instrument: it fires at 1% and is a line of text, while the thing it warns
 * about is quadratic in your share of the pool and is paid twice — once walking
 * the price up on entry, once walking it down on exit, on a book with no other
 * side.
 *
 * MEASURED against 76 live scanned tokens: median pool is 20.3 SOL, so the 2.0
 * SOL top rung exceeds 5% on 62% of them and the 0.75 rung on 47%. This cap is
 * not an edge case that fires occasionally — on this token population it is the
 * binding constraint about half the time, which is precisely the case for
 * having it.
 *
 * UNKNOWN DEPTH is the one gap and it is stated rather than hidden: 15.6% of
 * those pairs published no SOL-side figure, and a cap cannot be applied to a
 * number that does not exist. The size is returned uncapped with
 * `poolDepthUnknown`, and the alert says the cap could not be applied. Set
 * requireKnownPoolDepth to fail closed instead and suppress the recommendation
 * entirely on those tokens.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LADDER = [
  { minScore: 90, maxScore: 100, sol: 2.0, label: 'HEAVY CONVICTION' },
  { minScore: 75, maxScore: 89, sol: 0.75, label: 'Standard Entry' },
  { minScore: 68, maxScore: 74, sol: 0.25, label: 'Light Scalp' },
];

/**
 * Recommended size for a scored token.
 *
 * Returns null below the lowest rung rather than a token size: a score under
 * the alert floor has no recommendation, and emitting "0.1 SOL" there would
 * turn an absence of conviction into a small amount of it.
 *
 * The top rung is reached on score alone. The spec ties it to Cabal Swarm and
 * Jito Block #0 because those are what push a score into the 90s, but gating on
 * them as well would mean a 95 from clean fundamentals silently sized like a
 * 75 — so the cabal signal decorates the label instead of gating the rung.
 */
export function recommendSize({ score, clusters = null, demand = null, config = {} }) {
  const cfg = config.positionSizer ?? {};
  if (cfg.enabled === false) return null;

  const ladder = cfg.ladder ?? DEFAULT_LADDER;
  const rung = [...ladder]
    .sort((a, b) => b.minScore - a.minScore)
    .find((r) => typeof score === 'number' && score >= r.minScore);
  if (!rung) return null;

  const insiderCount = clusters?.insiderCount ?? 0;
  const bundle = clusters?.jito?.detected === true;
  const swarm = insiderCount >= 4;

  // Label suffix only — never a size change.
  const qualifier = bundle
    ? 'Jito Block #0'
    : swarm
      ? 'Cabal Swarm'
      : null;

  const poolSol = demand?.liquiditySol ?? null;
  const poolKnown = typeof poolSol === 'number' && Number.isFinite(poolSol) && poolSol > 0;

  const maxSharePct = cfg.maxPoolSharePct ?? 5;
  const minViableSol = cfg.minViableSol ?? 0.05;

  // A cap cannot be applied to a number that does not exist. Failing closed is
  // available but is not the default: suppressing the size outright removes the
  // most actionable line in the alert on 15.6% of tokens, and the operator can
  // still see that depth was unknown and decide for themselves.
  if (!poolKnown && cfg.requireKnownPoolDepth === true) return null;

  const capSol = poolKnown ? (poolSol * maxSharePct) / 100 : null;
  const sol = capSol !== null ? Math.min(rung.sol, capSol) : rung.sol;
  const capped = capSol !== null && capSol < rung.sol;

  const poolSharePct = poolKnown ? (sol / poolSol) * 100 : null;

  return {
    sol,
    // The ladder's number, kept so the alert can show what was proposed and what
    // the pool allowed. Reporting only the capped figure would hide that the
    // score earned a bigger size than the token can absorb, which is itself the
    // useful signal.
    uncappedSol: rung.sol,
    capped,
    capSol,
    maxPoolSharePct: maxSharePct,
    poolDepthUnknown: !poolKnown,
    // A capped size below this is not a position, it is a gesture. Surfaced so
    // the alert can say the pool is too thin to size into at all rather than
    // recommending 0.01 SOL with a straight face.
    poolTooThin: capped && sol < minViableSol,
    minViableSol,
    label: qualifier && rung.label === 'HEAVY CONVICTION' ? `${rung.label} — ${qualifier}` : rung.label,
    tier: rung.label,
    qualifier,
    score,
    poolSol,
    poolSharePct,
    // Retained for the existing warning. After the cap this can only be true
    // between thinPoolWarnPct and maxPoolSharePct, since anything above the cap
    // has been reduced to exactly the cap.
    thinPool: poolSharePct !== null && poolSharePct >= (cfg.thinPoolWarnPct ?? 1),
  };
}

/**
 * The alert line, plus pool context when it is known.
 *
 * A capped line names both numbers. "0.75 SOL" alone is not the same statement
 * as "the score earned 2.00 SOL and the pool only supports 0.75", and the
 * second is what tells you the token is too small for your conviction.
 */
export function formatSizeLine(size) {
  if (!size) return null;

  if (size.poolTooThin) {
    return (
      `RECOMMENDED BUY SIZE: none — the pool holds ${size.poolSol.toFixed(2)} SOL, ` +
      `so the ${size.maxPoolSharePct}% impact cap allows only ${size.sol.toFixed(3)} SOL (${size.label} wanted ${size.uncappedSol.toFixed(2)})`
    );
  }

  const base = `RECOMMENDED BUY SIZE: ${size.sol.toFixed(2)} SOL (${size.label})`;

  if (size.poolDepthUnknown) {
    return `${base} — pool depth unknown, the ${size.maxPoolSharePct}% impact cap could NOT be applied`;
  }
  if (size.capped) {
    return (
      `${base} — CAPPED at ${size.maxPoolSharePct}% of the ${size.poolSol.toFixed(1)} SOL pool ` +
      `(ladder wanted ${size.uncappedSol.toFixed(2)} SOL)`
    );
  }
  return `${base} — ${size.poolSharePct.toFixed(2)}% of the pool`;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  console.log('Conviction ladder (config.positionSizer.ladder):\n');
  for (const r of config.positionSizer?.ladder ?? DEFAULT_LADDER) {
    console.log(`  score ${String(r.minScore).padStart(3)}-${String(r.maxScore).padEnd(3)}  ->  ${r.sol.toFixed(2)} SOL  (${r.label})`);
  }

  console.log('\nWorked examples:\n');
  console.log(
    `  (impact cap: ${config.positionSizer?.maxPoolSharePct ?? 5}% of pool SOL — median scanned pool is ~20 SOL)\n`
  );
  const cases = [
    { score: 67, clusters: null, poolSol: 800 },
    { score: 68, clusters: null, poolSol: 800 },
    { score: 82, clusters: { insiderCount: 2 }, poolSol: 800 },
    { score: 94, clusters: { insiderCount: 5 }, poolSol: 800 },
    { score: 97, clusters: { insiderCount: 3, jito: { detected: true } }, poolSol: 800 },
    { score: 94, clusters: { insiderCount: 5 }, poolSol: 40 },
    { score: 94, clusters: { insiderCount: 5 }, poolSol: 20 },
    { score: 94, clusters: { insiderCount: 5 }, poolSol: 12 },
    { score: 94, clusters: { insiderCount: 5 }, poolSol: 0.6 },
    { score: 94, clusters: { insiderCount: 5 }, poolSol: null },
  ];
  for (const c of cases) {
    const s = recommendSize({
      score: c.score,
      clusters: c.clusters,
      demand: { liquiditySol: c.poolSol },
      config,
    });
    const pool = c.poolSol === null ? ' ?' : String(c.poolSol);
    console.log(
      `  score ${String(c.score).padStart(3)} · pool ${pool.padStart(5)} SOL  ->  ` +
        (s ? formatSizeLine(s) + (s.thinPool && !s.capped ? '   thin' : '') : 'no recommendation (below the ladder)')
    );
  }
}
