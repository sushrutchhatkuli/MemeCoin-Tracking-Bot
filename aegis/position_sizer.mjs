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
 * the alert prints it. It does not reduce the size — that stays exactly as
 * configured — but it puts the number that determines your slippage next to
 * the number that determines your risk.
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
  const poolSharePct = poolSol && poolSol > 0 ? (rung.sol / poolSol) * 100 : null;

  return {
    sol: rung.sol,
    label: qualifier && rung.label === 'HEAVY CONVICTION' ? `${rung.label} — ${qualifier}` : rung.label,
    tier: rung.label,
    qualifier,
    score,
    poolSol,
    poolSharePct,
    // Surfaced so the alert can warn without the sizer silently shrinking the
    // recommendation the operator configured.
    thinPool:
      poolSharePct !== null && poolSharePct >= (cfg.thinPoolWarnPct ?? 1),
  };
}

/** The alert line, exactly as specified, plus pool context when it is known. */
export function formatSizeLine(size) {
  if (!size) return null;
  const base = `⚖️ RECOMMENDED BUY SIZE: ${size.sol.toFixed(2)} SOL (${size.label})`;
  if (size.poolSharePct === null) return base;
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
  const cases = [
    { score: 67, clusters: null, poolSol: 800 },
    { score: 68, clusters: null, poolSol: 800 },
    { score: 82, clusters: { insiderCount: 2 }, poolSol: 800 },
    { score: 94, clusters: { insiderCount: 5 }, poolSol: 800 },
    { score: 97, clusters: { insiderCount: 3, jito: { detected: true } }, poolSol: 800 },
    { score: 94, clusters: { insiderCount: 5 }, poolSol: 12 },
  ];
  for (const c of cases) {
    const s = recommendSize({
      score: c.score,
      clusters: c.clusters,
      demand: { liquiditySol: c.poolSol },
      config,
    });
    console.log(
      `  score ${String(c.score).padStart(3)} · pool ${String(c.poolSol).padStart(4)} SOL  ->  ` +
        (s ? formatSizeLine(s) + (s.thinPool ? '   ⚠️ thin' : '') : 'no recommendation (below the ladder)')
    );
  }
}
