#!/usr/bin/env node
/**
 * Aegis-Crypto entry point — this is what the scheduler runs.
 *
 *   node index.mjs                     one scan pass, then exit
 *   node index.mjs --watch             stay resident, scan on an interval
 *   node index.mjs --token <address>   deep-dive a single contract
 *   node index.mjs --test-telegram     verify Telegram credentials
 *
 * For Windows Task Scheduler use the default (single pass) form: the scheduler
 * owns the timing, so a resident process would double up. `--watch` exists for
 * running it in a terminal you keep open.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runScan, parseArgs } from './scan.mjs';
import { runPostMortem, annotateNotes } from './post_mortem.mjs';
import { syncTopWhales } from './auto_top_whales.mjs';
import { sampleTrajectory } from './trajectory.mjs';
import { checkOpenPositions } from './sell_notifier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const WATCH_DEFAULT_MINUTES = 12;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const WHALE_SYNC_MARKER = join(HERE, '.state', 'last_whale_sync.json');

/** Run the elite-whale sync at most once per configured interval. */
async function maybeSyncWhales() {
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  if (config.eliteWhales?.enabled === false) return;

  // `syncEveryHours` is the previous key name, still honoured so an older
  // config keeps working after an update.
  const intervalHours =
    config.eliteWhales?.syncIntervalHours ?? config.eliteWhales?.syncEveryHours ?? 2;
  const everyMs = intervalHours * 3600 * 1000;
  let last = 0;
  try {
    last = JSON.parse(await readFile(WHALE_SYNC_MARKER, 'utf8')).lastSyncAt ?? 0;
  } catch {
    /* never synced */
  }

  if (Date.now() - last < everyMs) return;

  console.log(`\nElite whale sync (every ${intervalHours}h)…`);
  await syncTopWhales({});
  const { writeFile: wf, mkdir: mk } = await import('node:fs/promises');
  await mk(dirname(WHALE_SYNC_MARKER), { recursive: true });
  await wf(WHALE_SYNC_MARKER, JSON.stringify({ lastSyncAt: Date.now() }, null, 2), 'utf8');
}

async function once(args) {
  const started = Date.now();
  console.log(`\n═══ Aegis scan @ ${stamp()} ═══`);
  try {
    const result = await runScan(args);

    // Post-mortem runs after the scan so this pass's observations are already
    // recorded, and is isolated in its own try: a failure here must not lose
    // the scan results that already succeeded.
    if (!args.token && !args.testTelegram) {
      try {
        const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
        if (config.postMortem?.enabled !== false) {
          const pm = await runPostMortem({ config });
          if (pm.results?.length && config.writeNotes !== false) {
            const n = await annotateNotes({ config, results: pm.results });
            if (n) console.log(`Post-mortem verdict stamped onto ${n} note(s).`);
          }
        }
      } catch (err) {
        console.error(`Post-mortem failed (scan results kept): ${err.message}`);
      }

      // Elite whale sync, rate-limited to once every 24h. Runs inside the
      // ordinary 12-minute pass rather than as a separate scheduled task, so
      // there is only one thing to schedule and it cannot drift out of sync.
      try {
        await maybeSyncWhales();
      } catch (err) {
        console.error(`Whale sync failed (scan results kept): ${err.message}`);
      }

      // Sell monitor runs every pass: an insider exit or a rug is time-critical
      // and must not wait for a maintenance cycle.
      try {
        const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
        const sell = await checkOpenPositions({ config });
        if (sell.fired) console.log(`🔴 ${sell.fired} sell signal(s) fired across ${sell.checked} open position(s)`);
      } catch (err) {
        console.error(`Sell monitor failed: ${err.message}`);
      }

      // Hourly trajectory sample. Cheap, append-only, and survives reboots
      // because it rides the existing scheduled task rather than a session.
      try {
        const row = await sampleTrajectory(HERE);
        if (row) {
          console.log(
            `Trajectory: ${row.wallets} wallets · ${row.decided} decided token(s) · ` +
              `fail ${row.tokenFailRate}% vs base ${row.baseFailRate}% · ` +
              `max graded/wallet ${row.maxGraded} · ${row.recurring} recurring`
          );
        }
      } catch (err) {
        console.error(`Trajectory sample failed: ${err.message}`);
      }
    }

    console.log(
      `═══ Done in ${((Date.now() - started) / 1000).toFixed(0)}s — ` +
        `${result?.written?.length ?? 0} note(s), ${result?.alerts?.length ?? 0} alert(s) ═══`
    );
    return true;
  } catch (err) {
    // In watch mode a single failed pass must not kill the loop — a transient
    // upstream outage should cost one cycle, not the whole session.
    console.error(`═══ Scan failed: ${err.message} ═══`);
    return false;
  }
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const watchIndex = argv.indexOf('--watch');
const watch = watchIndex !== -1;

if (!watch) {
  const ok = await once(args);
  process.exit(ok ? 0 : 1);
} else {
  const minutes = Number(argv[watchIndex + 1]) || WATCH_DEFAULT_MINUTES;
  console.log(`Watch mode: scanning every ${minutes} minute(s). Ctrl+C to stop.`);
  await once(args);
  setInterval(() => once(args), minutes * 60 * 1000);
}
