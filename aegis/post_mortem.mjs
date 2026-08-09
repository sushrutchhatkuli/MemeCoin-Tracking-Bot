#!/usr/bin/env node
/**
 * Post-mortem & self-learning engine.
 *
 *   node post_mortem.mjs            evaluate outcomes, write results
 *   node post_mortem.mjs --dry-run  report only, change nothing
 *
 * Re-checks every token scanned 1–6 hours ago, compares its market cap now
 * against what it was at scan time, and records the outcome.
 *
 * ON "SELF-LEARNING" — being precise about what this does:
 * it accumulates labelled outcomes and reports which signals preceded wins and
 * failures. It does NOT automatically mutate scoring weights. Auto-tuning
 * weights from a handful of samples would overfit hard and silently corrupt the
 * scorer; the sample sizes involved here are far too small for that to be safe.
 * The aggregates are surfaced so weight changes can be made deliberately once
 * the data justifies them. `learning_history.json` is the evidence, not a model.
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { fetchPairsBatch } from './sources.mjs';
import { loadState, saveState, baselineWithin } from './state.mjs';
import { loadBlacklist, blacklistDeployer } from './blacklist.mjs';
import { loadObservations, saveObservations, applyOutcomes } from './wallet_observations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const HOUR = 3600 * 1000;

export async function runPostMortem({ dryRun = false, config } = {}) {
  const cfg =
    config ?? JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  const pm = cfg.postMortem ?? {};

  const minAge = (pm.minAgeHours ?? 1) * HOUR;
  const maxAge = (pm.maxAgeHours ?? 6) * HOUR;
  const rugDropPct = pm.rugDropPct ?? 80;
  const rugMcapFloor = pm.rugMcapFloorUsd ?? 5000;
  const winGainPct = pm.winGainPct ?? 100;

  const statePath = join(HERE, '.state', 'snapshots.json');
  const historyPath = join(HERE, 'learning_history.json');
  const state = await loadState(statePath);
  const blacklist = await loadBlacklist(join(HERE, 'dev_blacklist.json'));

  const now = Date.now();

  // Candidates: tracked tokens with a baseline inside the review window.
  const candidates = [];
  for (const [key, entry] of Object.entries(state)) {
    const baseline = baselineWithin(entry, now, minAge, maxAge);
    if (!baseline || !baseline.mc) continue;
    const [chain, address] = key.split(':');
    candidates.push({ key, chain, address: entry.address ?? address, entry, baseline });
  }

  if (!candidates.length) {
    console.log('Post-mortem: no tokens have a baseline in the 1–6h window yet.');
    return { evaluated: 0, rugs: 0, wins: 0, blacklisted: 0 };
  }

  console.log(`Post-mortem: re-checking ${candidates.length} token(s) scanned 1–6h ago…`);

  // Current market state, batched.
  const priced = await fetchPairsBatch(candidates.map((c) => c.address));

  const results = [];
  let rugs = 0;
  let wins = 0;
  let blacklisted = 0;

  for (const c of candidates) {
    const pair = priced.get(c.address.toLowerCase());
    const nowMcap = pair ? (pair.marketCap ?? pair.fdv ?? 0) : 0;
    const wasMcap = c.baseline.mc;
    const changePct = wasMcap > 0 ? ((nowMcap - wasMcap) / wasMcap) * 100 : 0;
    const ageHours = (now - c.baseline.t) / HOUR;

    // A vanished pair means liquidity was pulled — that is a rug, not missing data.
    const delisted = !pair;
    const isRug = changePct <= -rugDropPct || nowMcap < rugMcapFloor || delisted;
    const isWin = changePct >= winGainPct;

    const verdict = isRug ? 'FAIL' : isWin ? 'WIN' : 'NEUTRAL';
    if (isRug) rugs++;
    if (isWin) wins++;

    const record = {
      timestamp: new Date(now).toISOString(),
      chain: c.chain,
      address: c.address,
      symbol: c.entry.symbol ?? pair?.baseToken?.symbol ?? '?',
      deployer: c.entry.deployer ?? null,
      ageHours: Number(ageHours.toFixed(2)),
      mcapAtScan: Math.round(wasMcap),
      mcapNow: Math.round(nowMcap),
      changePct: Number(changePct.toFixed(1)),
      holdersAtScan: c.baseline.holders ?? null,
      delisted,
      verdict,
    };
    results.push(record);

    const arrow = verdict === 'FAIL' ? '🔴' : verdict === 'WIN' ? '' : '·';
    console.log(
      `  ${arrow} $${String(record.symbol).padEnd(12)} ${String(record.changePct).padStart(7)}%  ` +
        `$${record.mcapAtScan.toLocaleString('en-US')} → $${record.mcapNow.toLocaleString('en-US')}` +
        `${delisted ? '  (pair delisted)' : ''}`
    );

    if (isRug && c.entry.deployer && !dryRun) {
      const added = await blacklistDeployer(blacklist, {
        address: c.entry.deployer,
        reason: `Post-mortem: $${record.symbol} fell ${record.changePct}% within ${record.ageHours}h${delisted ? ' (pair delisted)' : ''}`,
      });
      if (added) {
        blacklisted++;
        console.log(`     deployer ${c.entry.deployer.slice(0, 10)}… added to dev_blacklist.json`);
      }
    }
  }

  // ---- persist learning history ------------------------------------
  let history = { runs: [], outcomes: [] };
  try {
    history = JSON.parse(await readFile(historyPath, 'utf8'));
    history.outcomes ??= [];
    history.runs ??= [];
  } catch {
    /* first run */
  }

  const summary = {
    timestamp: new Date(now).toISOString(),
    evaluated: results.length,
    rugs,
    wins,
    neutral: results.length - rugs - wins,
    rugRatePct: results.length ? Number(((rugs / results.length) * 100).toFixed(1)) : 0,
    blacklisted,
  };

  if (!dryRun) {
    history.runs.push(summary);
    history.outcomes.push(...results);
    // Bound the file — keep the most recent window of evidence.
    history.outcomes = history.outcomes.slice(-2000);
    history.runs = history.runs.slice(-500);
    history.aggregates = computeAggregates(history.outcomes);
    await mkdir(dirname(historyPath), { recursive: true });
    await writeFile(historyPath, JSON.stringify(history, null, 2), 'utf8');
    await saveState(statePath, state);

    // Grade every observed buy of these tokens. This is what turns raw buyer
    // sightings into a wallet track record.
    const obsPath = join(HERE, '.state', 'wallet_observations.json');
    const observations = await loadObservations(obsPath);
    const { graded, scored, promoted, demoted } = applyOutcomes(observations, results, { config });
    if (graded) {
      await saveObservations(obsPath, observations);
      console.log(`Elite ledger: graded ${graded} observed buy(s) against these outcomes`);
      if (scored) {
        console.log(
          `   Alpha scoring: ${scored} forward trade(s) by tracked wallets — ` +
            `${promoted} awarded, ${demoted} penalised`
        );
      }
    }
  }

  console.log(
    `Post-mortem: ${results.length} evaluated · ${rugs} rug(s) · ${wins} win(s) · ` +
      `${blacklisted} deployer(s) blacklisted${dryRun ? '  [DRY RUN — nothing written]' : ''}`
  );

  return { ...summary, results };
}

/**
 * Descriptive aggregates only. These are for a human to read before deciding to
 * change a weight — nothing here feeds back into scoring automatically.
 */
function computeAggregates(outcomes) {
  const n = outcomes.length;
  if (!n) return null;

  const rugs = outcomes.filter((o) => o.verdict === 'FAIL');
  const wins = outcomes.filter((o) => o.verdict === 'WIN');
  const mean = (arr, f) => (arr.length ? arr.reduce((s, o) => s + (f(o) ?? 0), 0) / arr.length : null);

  const bucket = (o) => {
    const h = o.holdersAtScan;
    if (h === null || h === undefined) return 'unknown';
    if (h < 150) return 'under150';
    if (h < 500) return '150-499';
    return '500plus';
  };

  const byHolders = {};
  for (const o of outcomes) {
    const b = bucket(o);
    byHolders[b] ??= { total: 0, rugs: 0, wins: 0 };
    byHolders[b].total++;
    if (o.verdict === 'FAIL') byHolders[b].rugs++;
    if (o.verdict === 'WIN') byHolders[b].wins++;
  }
  for (const b of Object.values(byHolders)) {
    b.rugRatePct = Number(((b.rugs / b.total) * 100).toFixed(1));
  }

  return {
    sampleSize: n,
    rugRatePct: Number(((rugs.length / n) * 100).toFixed(1)),
    winRatePct: Number(((wins.length / n) * 100).toFixed(1)),
    meanHoldersAtScan_rugs: mean(rugs, (o) => o.holdersAtScan),
    meanHoldersAtScan_wins: mean(wins, (o) => o.holdersAtScan),
    meanMcapAtScan_rugs: mean(rugs, (o) => o.mcapAtScan),
    meanMcapAtScan_wins: mean(wins, (o) => o.mcapAtScan),
    byHolderBucket: byHolders,
    caveat:
      'Descriptive only. Sample sizes here are far too small to justify automatic weight changes; treat as evidence for a deliberate decision.',
  };
}

/** Stamp a post-mortem verdict onto the token's existing Obsidian notes. */
export async function annotateNotes({ config, results }) {
  const notesDir = join(resolve(HERE, config.vaultPath), config.notesFolder);
  let files;
  try {
    files = (await readdir(notesDir)).filter((f) => f.endsWith('.md'));
  } catch {
    return 0;
  }

  const byAddress = new Map(results.filter((r) => r.verdict !== 'NEUTRAL').map((r) => [r.address, r]));
  if (!byAddress.size) return 0;

  let updated = 0;
  for (const file of files) {
    const path = join(notesDir, file);
    const text = await readFile(path, 'utf8');
    const address = text.match(/^contract_address:\s*"([^"]+)"/m)?.[1];
    if (!address || !byAddress.has(address)) continue;

    const r = byAddress.get(address);
    const banner =
      r.verdict === 'FAIL'
        ? `🔴 POST-MORTEM: RUGPULL DETECTED (${r.changePct}% in ${r.ageHours}h)`
        : `POST-MORTEM: WINNER (+${r.changePct}% in ${r.ageHours}h)`;

    let out = text;
    out = out.includes('post_mortem_verdict:')
      ? out
          .replace(/^post_mortem_verdict:.*$/m, `post_mortem_verdict: "${r.verdict}"`)
          .replace(/^post_mortem_detail:.*$/m, `post_mortem_detail: ${JSON.stringify(banner)}`)
      : out.replace(
          /^tags:/m,
          `post_mortem_verdict: "${r.verdict}"\npost_mortem_detail: ${JSON.stringify(banner)}\ntags:`
        );

    if (!out.includes('## Post-Mortem')) {
      out += `\n\n---\n\n## Post-Mortem\n> [!${r.verdict === 'FAIL' ? 'danger' : 'success'}] ${banner}\n> Market cap at scan: $${r.mcapAtScan.toLocaleString('en-US')} → now $${r.mcapNow.toLocaleString('en-US')}${r.delisted ? '\n> Pair has been delisted — liquidity pulled.' : ''}\n`;
    }

    if (out !== text) {
      await writeFile(path, out, 'utf8');
      updated++;
    }
  }
  return updated;
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dryRun = process.argv.includes('--dry-run');
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  const res = await runPostMortem({ dryRun, config });
  if (!dryRun && res.results?.length && config.writeNotes !== false) {
    const n = await annotateNotes({ config, results: res.results });
    if (n) console.log(`Stamped post-mortem verdict onto ${n} note(s).`);
  }
}
