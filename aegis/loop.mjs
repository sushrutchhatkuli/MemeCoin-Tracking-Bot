#!/usr/bin/env node
/**
 * Real-time insider trigger loop.
 *
 *   node loop.mjs                 30s target cadence
 *   node loop.mjs --interval 45   custom cadence, seconds
 *   node loop.mjs --limit 10      tokens audited per tick
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ABOUT THE 30-SECOND TARGET — measured, not assumed:
 *
 * A full pass takes ~40-55s. Discovery is the fixed cost (three launch feeds
 * plus seven search queries, ~120 candidates), and it does not shrink with the
 * audit limit. So a 30s timer CANNOT complete a full cycle.
 *
 * Rather than silently stacking overlapping scans — which would multiply RPC
 * load, corrupt shared state files written by two passes at once, and burn
 * Helius credits for nothing — the timer fires every 30s but SKIPS the tick if
 * the previous scan is still running. Effective cadence lands near the true
 * scan duration, and skipped ticks are counted and reported so the real number
 * is visible instead of implied.
 *
 * To genuinely approach 30s, lower `--limit` and trim
 * `discovery.searchQueries` in config.json; both cut wall time directly.
 *
 * RPC BUDGET WARNING: at this cadence the scanner runs ~2000 times a day
 * against ~120 on the 12-minute schedule — roughly 17x the RPC volume. Watch
 * your Helius credits before leaving this running unattended.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runScan } from './scan.mjs';
import { runPostMortem, annotateNotes } from './post_mortem.mjs';
import { syncTopWhales } from './auto_top_whales.mjs';
import { sampleTrajectory } from './trajectory.mjs';
import { checkOpenPositions } from './sell_notifier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseLoopArgs(argv) {
  const args = { intervalSec: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--interval') args.intervalSec = Number(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(11, 19);

let running = false;
let tick = 0;
let skipped = 0;
let alertsSent = 0;
const durations = [];

async function onTick(bootConfig, limit, heavyEveryTicks) {
  // Re-read config every tick rather than using the startup snapshot.
  //
  // A long-running loop that caches config silently ignores every change until
  // it is restarted — so retuning takeProfitMultiple or insiderMinScore would
  // appear to do nothing while the process kept using the old values. Falls
  // back to the boot snapshot if the file is mid-write.
  let config = bootConfig;
  try {
    config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  } catch {
    /* keep the last good config */
  }

  // Non-overlap guard. Two concurrent scans would race on snapshots.json,
  // wallet_observations.json and the alert log — the last writer would silently
  // discard the other's work.
  if (running) {
    skipped++;
    return;
  }
  running = true;
  tick++;
  const started = Date.now();

  try {
    const result = await runScan({ limit, realtime: true });
    const secs = (Date.now() - started) / 1000;
    durations.push(secs);
    if (durations.length > 20) durations.shift();

    // Time-critical: checked every tick, not on the maintenance cadence.
    let sellFired = 0;
    try {
      const sell = await checkOpenPositions({ config, quiet: true });
      sellFired = sell.fired;
    } catch { /* non-fatal */ }

    const sent = result?.alerts?.length ?? 0;
    alertsSent += sent;

    // Silent by design: a tick that finds nothing prints one short line here
    // and sends nothing at all to Telegram.
    console.log(
      `[${stamp()}] tick ${tick} · ${secs.toFixed(0)}s · ` +
        `${result?.scanned ?? 0} audited · ${sent ? `🚀 ${sent} BUY ALERT(S)` : 'no clean insider buys'}${sellFired ? ` · 🔴 ${sellFired} SELL SIGNAL(S)` : ''}` +
        (skipped ? ` · ${skipped} tick(s) skipped while busy` : '')
    );

    // Maintenance work runs on a slower cadence — it does not need to happen
    // every 30 seconds and would otherwise dominate the loop's runtime.
    if (tick % heavyEveryTicks === 0) {
      console.log(`[${stamp()}] maintenance pass (every ${heavyEveryTicks} ticks)…`);
      try {
        const pm = await runPostMortem({ config });
        if (pm.results?.length && config.writeNotes !== false) {
          await annotateNotes({ config, results: pm.results });
        }
      } catch (err) {
        console.error(`   post-mortem failed: ${err.message}`);
      }
      try {
        await syncTopWhales({});
      } catch (err) {
        console.error(`   whale sync failed: ${err.message}`);
      }
      try {
        await sampleTrajectory(HERE);
      } catch {
        /* non-critical */
      }
    }
  } catch (err) {
    console.error(`[${stamp()}] tick ${tick} FAILED: ${err.message}`);
  } finally {
    running = false;
  }
}

const args = parseLoopArgs(process.argv.slice(2));
const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
const rt = config.realtime ?? {};

const intervalSec = args.intervalSec ?? rt.intervalSeconds ?? 30;
const limit = args.limit ?? rt.scanLimit ?? 8;
const heavyEveryTicks = rt.maintenanceEveryTicks ?? 20;

console.log('═'.repeat(64));
console.log('  AEGIS — REAL-TIME INSIDER TRIGGER MODE');
console.log('═'.repeat(64));
console.log(`  cadence       : every ${intervalSec}s (skips a tick if the previous scan is still running)`);
console.log(`  audit limit   : ${limit} tokens per tick`);
console.log(`  maintenance   : post-mortem + whale sync every ${heavyEveryTicks} ticks`);
console.log(`  telegram      : SILENT unless a token has insider activity AND passes every safety gate`);
console.log(`  measured scan : ~40-55s, so expect the real cadence to track that, not ${intervalSec}s`);
console.log('  Ctrl+C to stop.');
console.log('═'.repeat(64));

const timer = setInterval(() => onTick(config, limit, heavyEveryTicks), intervalSec * 1000);
await onTick(config, limit, heavyEveryTicks);

const shutdown = () => {
  clearInterval(timer);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  console.log('');
  console.log('═'.repeat(64));
  console.log(`  stopped after ${tick} tick(s)`);
  console.log(`  average scan  : ${avg.toFixed(1)}s`);
  console.log(`  skipped ticks : ${skipped} (previous scan still running)`);
  console.log(`  alerts sent   : ${alertsSent}`);
  console.log('═'.repeat(64));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
