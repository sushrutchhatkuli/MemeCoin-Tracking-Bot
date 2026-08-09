#!/usr/bin/env node
/**
 * Standalone candidate discovery.
 *
 *   node discovery_daemon.mjs               refresh every 60s
 *   node discovery_daemon.mjs --interval 45 custom cadence, seconds
 *   node discovery_daemon.mjs --once        one refresh, then exit
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE PROCESS
 *
 * Discovery is a FIXED cost that does not shrink with the audit limit: the same
 * launch feeds and search queries run whether a tick audits 4 tokens or 40. On
 * the scan loop it therefore sat in front of every tick, and lowering
 * `scanLimit` — the obvious lever for a faster loop — did nothing to it.
 *
 * Moving it here decouples the two. The daemon refreshes the candidate pool on
 * its own timer; the scanner reads the file and starts auditing immediately.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HANDOFF, and what happens when this is not running
 *
 * The file carries `generatedAt`. scan.mjs uses it only while it is FRESH and
 * falls back to discovering inline when it is stale or absent, so stopping this
 * daemon costs latency, never coverage — the same failure posture as the
 * liquidity poller.
 *
 * That fallback matters more than it looks: auditing a stale candidate list is
 * worse than a slow scan, because the tokens that matter here are minutes old
 * and a five-minute-old pool of "fresh launches" is largely the previous
 * window's. Staleness is bounded by discovery.maxCandidateAgeSeconds.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { discoverCandidates } from './sources.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SURFACED_PATH = join(HERE, '.state', 'surfaced_candidates.json');

export async function loadSurfaced(path = SURFACED_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return {
      generatedAt: raw.generatedAt ?? 0,
      candidates: Array.isArray(raw.candidates) ? raw.candidates : [],
      stats: raw.stats ?? null,
    };
  } catch {
    return { generatedAt: 0, candidates: [], stats: null };
  }
}

export async function saveSurfaced(payload, path = SURFACED_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * Is the surfaced pool fresh enough to audit from?
 *
 * Returns the age too, so the caller can say WHY it fell back rather than
 * silently doing something different from what the operator expects.
 */
export function surfacedFreshness(surfaced, maxAgeSeconds, now = Date.now()) {
  const generatedAt = surfaced?.generatedAt ?? 0;
  const ageSec = generatedAt ? (now - generatedAt) / 1000 : Infinity;
  return {
    fresh: generatedAt > 0 && ageSec <= maxAgeSeconds && (surfaced.candidates?.length ?? 0) > 0,
    ageSec,
    count: surfaced?.candidates?.length ?? 0,
  };
}

export async function refreshOnce({ config, path = SURFACED_PATH, now = Date.now() }) {
  const { candidates, stats } = await discoverCandidates(config.chains, config.discovery);
  const payload = { generatedAt: now, stats, candidates };
  await saveSurfaced(payload, path);
  return payload;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once');
  const i = argv.indexOf('--interval');
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  const intervalSec =
    (i !== -1 ? Number(argv[i + 1]) : null) || config.discovery?.daemonIntervalSeconds || 60;

  const stamp = () => new Date().toISOString().slice(11, 19);

  if (!once) {
    console.log('═'.repeat(64));
    console.log('  AEGIS — CANDIDATE DISCOVERY DAEMON');
    console.log('═'.repeat(64));
    console.log(`  cadence : every ${intervalSec}s`);
    console.log(`  writes  : .state/surfaced_candidates.json`);
    console.log(`  queries : ${(config.discovery?.searchQueries ?? []).join(', ')}`);
    console.log('  scan.mjs reads this pool while it is fresh and falls back to');
    console.log('  discovering inline when it is stale — stopping this daemon');
    console.log('  costs latency, never coverage.');
    console.log('  Ctrl+C to stop.');
    console.log('═'.repeat(64));
  }

  let runs = 0;
  const run = async () => {
    const t0 = Date.now();
    try {
      const p = await refreshOnce({ config });
      runs++;
      console.log(
        `[${stamp()}] refreshed ${p.candidates.length} candidate(s) ` +
          `(${p.stats?.fromFeeds ?? '?'} feeds, ${p.stats?.fromSearch ?? '?'} search) in ${((Date.now() - t0) / 1000).toFixed(1)}s`
      );
    } catch (err) {
      console.error(`[${stamp()}] discovery failed: ${err.message}`);
    }
  };

  await run();
  if (once) process.exit(0);

  const timer = setInterval(run, intervalSec * 1000);
  const shutdown = () => {
    clearInterval(timer);
    console.log(`\n  stopped after ${runs} refresh(es). scan.mjs will discover inline again.`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
