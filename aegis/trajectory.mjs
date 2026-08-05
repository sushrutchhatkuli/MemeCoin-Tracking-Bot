/**
 * Hourly trajectory sampler for the elite-whale ledger.
 *
 * Answers one question over time: is the observation ledger converging toward
 * a state where wallets can actually be ranked, or is it stuck?
 *
 * Three things have to become true together, and they move independently:
 *   1. the sample must resemble the market   (token failure rate vs base rate)
 *   2. enough tokens must reach a verdict    (decided tokens)
 *   3. the same wallets must recur           (max graded buys per wallet)
 *
 * (3) is the binding constraint and the one most likely to stall: if memecoin
 * buyers rarely trade twice through Aegis's field of view, max-graded-buys will
 * flatline near 1 no matter how long this runs, and observe mode can never
 * produce a top-50. That would be a real answer, not a failure — hence logging
 * it rather than assuming.
 *
 * Runs from index.mjs on the normal scan cadence, rate-limited to once an hour.
 */

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const HOUR_MS = 3600 * 1000;

export async function sampleTrajectory(here) {
  const markerPath = join(here, '.state', 'last_trajectory.json');
  const csvPath = join(here, 'trajectory.csv');

  let last = 0;
  try {
    last = JSON.parse(await readFile(markerPath, 'utf8')).at ?? 0;
  } catch {
    /* never sampled */
  }
  if (Date.now() - last < HOUR_MS) return null;

  // ---- ledger state ------------------------------------------------
  let obs = { wallets: {} };
  try {
    obs = JSON.parse(await readFile(join(here, '.state', 'wallet_observations.json'), 'utf8'));
  } catch {
    return null;
  }

  const entries = Object.values(obs.wallets ?? {});
  const buys = entries.flatMap((e) => e.buys ?? []);
  const gradedOf = (e) => (e.buys ?? []).filter((b) => b.outcome && b.outcome !== 'NEUTRAL').length;

  const decidedByToken = new Map();
  for (const b of buys) {
    if (b.outcome && b.outcome !== 'NEUTRAL' && !decidedByToken.has(b.token)) {
      decidedByToken.set(b.token, b.outcome);
    }
  }
  const decided = decidedByToken.size;
  const tokenFails = [...decidedByToken.values()].filter((v) => v === 'FAIL').length;
  const tokenFailRate = decided ? (tokenFails / decided) * 100 : 0;

  const gradedCounts = entries.map(gradedOf);
  const maxGraded = gradedCounts.length ? Math.max(...gradedCounts) : 0;
  const recurring = gradedCounts.filter((n) => n >= 2).length;

  // ---- market base rate --------------------------------------------
  let baseFailRate = 0;
  try {
    const h = JSON.parse(await readFile(join(here, 'learning_history.json'), 'utf8'));
    const c = (h.outcomes ?? []).reduce((a, x) => {
      a[x.verdict] = (a[x.verdict] ?? 0) + 1;
      return a;
    }, {});
    const d = (c.FAIL ?? 0) + (c.WIN ?? 0);
    if (d >= 50) baseFailRate = ((c.FAIL ?? 0) / d) * 100;
  } catch {
    /* leave at 0 */
  }

  const row = {
    ts: new Date().toISOString().replace('T', ' ').slice(0, 16),
    wallets: entries.length,
    tokens: new Set(buys.map((b) => b.token)).size,
    decided,
    tokenFailRate: tokenFailRate.toFixed(1),
    baseFailRate: baseFailRate.toFixed(1),
    maxGraded,
    recurring,
  };

  await mkdir(dirname(markerPath), { recursive: true });
  try {
    await readFile(csvPath, 'utf8');
  } catch {
    await writeFile(
      csvPath,
      'timestamp,wallets,tokens,decided_tokens,token_fail_pct,base_fail_pct,max_graded_per_wallet,wallets_with_2plus\n',
      'utf8'
    );
  }
  await appendFile(
    csvPath,
    `${row.ts},${row.wallets},${row.tokens},${row.decided},${row.tokenFailRate},${row.baseFailRate},${row.maxGraded},${row.recurring}\n`,
    'utf8'
  );
  await writeFile(markerPath, JSON.stringify({ at: Date.now() }, null, 2), 'utf8');

  return row;
}
