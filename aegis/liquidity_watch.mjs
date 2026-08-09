#!/usr/bin/env node
/**
 * Liquidity drain watcher — a dedicated 10-second poller.
 *
 *   node liquidity_watch.mjs              poll open positions every 10s
 *   node liquidity_watch.mjs --interval 5 custom cadence, seconds
 *   node liquidity_watch.mjs --dry-run    detect and print, send nothing
 *   node liquidity_watch.mjs --once       one pass, then exit
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE PROCESS
 *
 * sell_notifier's inline drain check runs on the scan loop, whose tick targets
 * 30s but measures 40-421s in practice. A liquidity pull empties a pool in one
 * block. Detecting it "within 10 seconds" is not a tuning problem, it is a
 * sampling problem: there is no sample inside the window, so no threshold can
 * recover one. This process exists solely to take that sample.
 *
 * Cost is small and bounded. DexScreener prices up to 30 tokens per call, so
 * every open position is covered by one request every 10 seconds — 6 requests a
 * minute regardless of how many positions are open.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW IT AVOIDS FIGHTING sell_notifier
 *
 * Two processes watching the same positions could double-alert, and both
 * writing open_positions.json would race — savePositions rewrites the whole
 * file, so the later writer silently discards the other's work.
 *
 * So the split is strict:
 *
 *   THIS PROCESS   reads open_positions.json and never writes it. It owns
 *                  .state/liquidity_watch.json: its own samples, its own
 *                  fired-alert record, and a heartbeat.
 *
 *   sell_notifier  keeps writing open_positions.json as the single writer. On
 *                  each tick it reads the heartbeat; if this poller is alive it
 *                  SKIPS its own drain check (no duplicate alert) and closes any
 *                  position this poller reported.
 *
 * The handoff is automatic in both directions. Stop this process and the
 * heartbeat goes stale within a minute, and sell_notifier silently resumes
 * doing the check itself at loop cadence. Coverage degrades; it never vanishes.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { fetchPairsBatch } from './sources.mjs';
import { loadEnv, sendTelegram, buildSellMessage } from './telegram.mjs';
import { loadPositions, detectLiquidityDrain, TRIGGER } from './sell_notifier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WATCH_STATE_PATH = join(HERE, '.state', 'liquidity_watch.json');

/* ------------------------------------------------------------------ *
 * Watcher state — owned exclusively by this process
 * ------------------------------------------------------------------ */

export async function loadWatchState(path = WATCH_STATE_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return { heartbeatAt: raw.heartbeatAt ?? 0, samples: raw.samples ?? {}, fired: raw.fired ?? {} };
  } catch {
    return { heartbeatAt: 0, samples: {}, fired: {} };
  }
}

export async function saveWatchState(state, path = WATCH_STATE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Is a dedicated poller alive right now?
 *
 * Read by sell_notifier to decide whether to run its own drain check. The
 * window is generous relative to a 10s cadence so a single slow poll does not
 * hand control back and forth.
 */
export function pollerIsLive(watchState, maxAgeSeconds = 60, now = Date.now()) {
  const hb = watchState?.heartbeatAt;
  return typeof hb === 'number' && hb > 0 && (now - hb) / 1000 <= maxAgeSeconds;
}

/**
 * Drop sample and fired records for positions that are no longer open, so the
 * file cannot grow without bound across a long session.
 */
export function pruneWatchState(state, openKeys) {
  const keep = new Set(openKeys);
  const samples = {};
  const fired = {};
  for (const [k, v] of Object.entries(state.samples ?? {})) if (keep.has(k)) samples[k] = v;
  for (const [k, v] of Object.entries(state.fired ?? {})) if (keep.has(k)) fired[k] = v;
  return { ...state, samples, fired };
}

/* ------------------------------------------------------------------ *
 * One polling pass
 * ------------------------------------------------------------------ */

/**
 * Sample every open position's pool and return any drains detected.
 *
 * Pure apart from the price fetch, which is injected — so a test can drive the
 * detection logic across a sequence of reserve readings without a network.
 */
export async function pollOnce({
  positions,
  watchState,
  config,
  now = Date.now(),
  fetchPairs = fetchPairsBatch,
}) {
  const cfg = config.sellSignals ?? {};
  const open = Object.entries(positions.positions ?? {}).filter(([, p]) => p.status === 'OPEN');
  if (!open.length) {
    return { checked: 0, drains: [], watchState: { ...watchState, heartbeatAt: now } };
  }

  const priced = await fetchPairs(open.map(([, p]) => p.address));
  const samples = { ...(watchState.samples ?? {}) };
  const fired = { ...(watchState.fired ?? {}) };
  const drains = [];

  for (const [key, p] of open) {
    const pair = priced.get(p.address.toLowerCase());
    const liquiditySol = pair?.liquidity?.quote ?? null;
    if (typeof liquiditySol !== 'number') continue;

    const prev = samples[key];
    // detectLiquidityDrain reads lastLiquiditySol/lastLiquidityAt off a
    // position-shaped object. Feeding it THIS process's own sample rather than
    // the position record is what keeps the two watchers independent — the
    // poller's 10s baseline is far tighter than the monitor's.
    const probe = {
      symbol: p.symbol,
      lastLiquiditySol: prev?.sol ?? p.lastLiquiditySol ?? null,
      lastLiquidityAt: prev?.at ?? p.lastLiquidityAt ?? null,
    };

    if (!fired[key]) {
      const drain = detectLiquidityDrain(probe, liquiditySol, cfg, now);
      if (drain) {
        drains.push({ key, position: p, currentMcap: pair.marketCap ?? pair.fdv ?? null, ...drain });
        fired[key] = { at: now, dropPct: drain.dropPct, elapsedSec: drain.elapsedSec };
      }
    }

    samples[key] = { sol: liquiditySol, at: now };
  }

  return {
    checked: open.length,
    drains,
    watchState: pruneWatchState({ heartbeatAt: now, samples, fired }, open.map(([k]) => k)),
  };
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

async function tick({ config, credentials, dryRun, quiet }) {
  const [positions, watchState] = await Promise.all([loadPositions(), loadWatchState()]);
  const res = await pollOnce({ positions, watchState, config, now: Date.now() });

  for (const d of res.drains) {
    const line =
      `DRAIN ${d.position.symbol}: -${d.dropPct.toFixed(1)}% in ${d.elapsedSec.toFixed(0)}s ` +
      `(${d.fromSol.toFixed(1)} → ${d.toSol.toFixed(1)} SOL)`;
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}${dryRun ? '  [dry run]' : ''}`);

    if (!dryRun && credentials.botToken && credentials.chatId) {
      const text = buildSellMessage({
        position: d.position,
        currentMcap: d.currentMcap,
        headline: d.headline,
        reason: d.reason,
        action: d.action,
        tradeLink: { template: config.tradeLinkTemplate },
      });
      const sent = await sendTelegram({ ...credentials, text });
      if (!sent.ok) console.error(`   Telegram failed: ${sent.error}`);
    }
  }

  // Written even when nothing fired — the heartbeat is what tells
  // sell_notifier to stand down, so it must not depend on a detection.
  if (!dryRun) await saveWatchState(res.watchState);
  return res;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const once = argv.includes('--once');
  const i = argv.indexOf('--interval');
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  const intervalSec =
    (i !== -1 ? Number(argv[i + 1]) : null) || config.sellSignals?.liquidityDrain?.pollSeconds || 10;
  const credentials = await loadEnv(join(HERE, '.env'));

  console.log('═'.repeat(64));
  console.log('  AEGIS — LIQUIDITY DRAIN WATCHER');
  console.log('═'.repeat(64));
  console.log(`  cadence   : every ${intervalSec}s`);
  console.log(`  threshold : -${config.sellSignals?.liquidityDrain?.dropPct ?? 15}% pool SOL between samples`);
  console.log(`  mode      : ${dryRun ? 'DRY RUN — detect only' : 'live, sends Telegram alerts'}`);
  console.log('  While this is running, sell_notifier stands down from its own');
  console.log('  drain check. Stop it and the loop resumes within 60s.');
  console.log('  Ctrl+C to stop.');
  console.log('═'.repeat(64));

  let polls = 0;
  let alerts = 0;
  const run = async () => {
    try {
      const r = await tick({ config, credentials, dryRun });
      polls++;
      alerts += r.drains.length;
    } catch (err) {
      console.error(`   poll failed: ${err.message}`);
    }
  };

  await run();
  if (once) process.exit(0);

  const timer = setInterval(run, intervalSec * 1000);
  const shutdown = () => {
    clearInterval(timer);
    console.log(`\n  stopped after ${polls} poll(s), ${alerts} drain alert(s).`);
    console.log('  sell_notifier resumes its own drain check within 60s.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
