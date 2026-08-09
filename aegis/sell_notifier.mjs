#!/usr/bin/env node
/**
 * Automated sell-signal notifier.
 *
 *   node sell_notifier.mjs           check open positions once
 *   node sell_notifier.mjs --list    show what is being monitored
 *   node sell_notifier.mjs --dry-run evaluate without sending or writing
 *
 * A position is opened whenever a BUY alert is delivered, capturing the market
 * cap at that moment and each matched insider's token balance. Those baselines
 * are what every trigger measures against — without them "up 100%" and "sold
 * 40%" have no meaning.
 *
 * ── THREE TRIGGERS ──────────────────────────────────────────────────────────
 *   1. INSIDER EXIT   insider's balance fell >= 40% from the alert-time baseline
 *   2. TAKE PROFIT    market cap reached 2x entry
 *   3. STOP LOSS      market cap fell 20% below entry, or the pair delisted
 *
 * ── DESIGN NOTES THAT MATTER ────────────────────────────────────────────────
 * Each trigger fires AT MOST ONCE per position. Without that, a token sitting
 * at -21% would re-send a stop-loss every 30 seconds.
 *
 * STOP LOSS and INSIDER EXIT close the position; TAKE PROFIT does not, because
 * its advice is to remove initial capital and let the rest run — closing there
 * would silence the stop-loss on the remainder.
 *
 * A delisted pair is treated as a stop-loss rather than "no data". Liquidity
 * being pulled is the single most important thing to be told about, and
 * silence would be the worst possible response to it.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * This tracks market cap against the moment Aegis alerted, NOT your fill. It
 * has no idea what you actually paid, whether you bought at all, or what size.
 * "+100%" means the token doubled from the alert, which is not the same as your
 * position being up 100%. Treat these as notifications about the token, not
 * about your money.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { fetchPairsBatch } from './sources.mjs';
import { loadEnv, sendTelegram, buildSellMessage } from './telegram.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POSITIONS_PATH = join(HERE, '.state', 'open_positions.json');

export const TRIGGER = {
  INSIDER_EXIT: 'INSIDER_EXIT',
  TAKE_PROFIT: 'TAKE_PROFIT',
  STOP_LOSS: 'STOP_LOSS',
  TRAILING_LOCK: 'TRAILING_LOCK',
  LIQUIDITY_DRAIN: 'LIQUIDITY_DRAIN',
};

/**
 * Pool-drain detector: a sharp fall in the pool's SOL reserve.
 *
 * Reserve comes from DexScreener's `liquidity.quote`, which is the SOL side of
 * the pair and is already fetched for pricing — so this costs no extra call.
 *
 * ── ON THE 10-SECOND WINDOW ─────────────────────────────────────────────────
 * The specification asks for ">15% within 10 seconds". This monitor runs on the
 * scan loop, whose tick is a 30s target but measures 40-195s in practice, so a
 * 10-second window cannot be observed — there is no sample inside it.
 *
 * What is implemented is ">15% between consecutive samples", and the alert
 * states the REAL elapsed time rather than the configured one. A drain caught
 * 90 seconds apart is still worth knowing about, but calling it "in 10s" would
 * be a fabricated precision, and the number an operator uses to judge urgency
 * is exactly the one that would be wrong.
 *
 * To genuinely reach 10-second resolution the reserve has to be polled on its
 * own timer, independent of the scan. `maxSampleAgeSeconds` bounds how stale a
 * comparison may be before it is discarded as uninformative.
 */
export function detectLiquidityDrain(position, currentLiquiditySol, cfg, now = Date.now()) {
  const drain = cfg.liquidityDrain ?? {};
  if (drain.enabled === false) return null;

  const prev = position?.lastLiquiditySol;
  const prevAt = position?.lastLiquidityAt;
  if (
    typeof prev !== 'number' ||
    typeof prevAt !== 'number' ||
    typeof currentLiquiditySol !== 'number' ||
    prev <= 0
  ) {
    return null;
  }

  const elapsedSec = (now - prevAt) / 1000;
  const maxAge = drain.maxSampleAgeSeconds ?? 600;
  // A comparison against a 20-minute-old sample says nothing about a sudden
  // pull — it is just the token being quieter than it was.
  if (elapsedSec <= 0 || elapsedSec > maxAge) return null;

  const dropPct = ((prev - currentLiquiditySol) / prev) * 100;
  if (dropPct < (drain.dropPct ?? 15)) return null;

  return {
    trigger: TRIGGER.LIQUIDITY_DRAIN,
    headline: '🚨 EMERGENCY EXIT: LIQUIDITY DRAIN DETECTED',
    reason:
      `Pool SOL reserves fell ${dropPct.toFixed(1)}% in ${elapsedSec.toFixed(0)}s ` +
      `(${prev.toFixed(1)} → ${currentLiquiditySol.toFixed(1)} SOL) — dev or whale pulling liquidity`,
    action: 'EXIT IMMEDIATELY to preserve capital.',
    closes: true,
    dropPct,
    elapsedSec,
    fromSol: prev,
    toSol: currentLiquiditySol,
  };
}

/**
 * The trailing stop currently armed for a position, as a percentage ABOVE entry.
 *
 * Derived from peakMarketCap rather than stored, which makes the ratchet free:
 * the peak only ever rises, so the armed level can only ever rise with it. There
 * is no state to migrate onto existing positions and no way for a restart or a
 * mid-trade config edit to walk a lock back down.
 *
 * Returns null before the first tier is reached, which is what keeps the plain
 * stop-loss in charge on a position that never ran.
 */
export function armedTrailingLock(position, cfg) {
  const trailing = cfg.trailingStop ?? {};
  if (trailing.enabled === false) return null;

  const entry = position?.entryMarketCap ?? 0;
  const peak = position?.peakMarketCap ?? 0;
  if (entry <= 0 || peak <= 0) return null;

  const peakGainPct = ((peak - entry) / entry) * 100;
  const tiers = trailing.tiers ?? [
    { peakGainPct: 50, lockGainPct: 20 },
    { peakGainPct: 100, lockGainPct: 60 },
  ];

  let armed = null;
  for (const t of tiers) {
    if (peakGainPct >= t.peakGainPct && (armed === null || t.lockGainPct > armed.lockGainPct)) {
      armed = t;
    }
  }
  if (!armed) return null;

  // tierPeakPct is the THRESHOLD that armed this lock; peakGainPct is how far
  // the position actually ran. Keeping both separate matters — an earlier cut
  // spread the tier and then overwrote peakGainPct with the live peak, losing
  // the threshold the alert needs to explain itself.
  return {
    lockGainPct: armed.lockGainPct,
    tierPeakPct: armed.peakGainPct,
    peakGainPct,
  };
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

export async function loadPositions(path = POSITIONS_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return { positions: raw.positions ?? {} };
  } catch {
    return { positions: {} };
  }
}

export async function savePositions(store, path = POSITIONS_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Record a position when a BUY alert goes out. Insider balances are captured
 * here because a baseline taken later would already include any selling.
 */
export function openPosition(store, { pair, demand, clusters, rpcBalances = {}, category = null }) {
  const key = `${pair.chainId}:${pair.baseToken.address}`;
  if (store.positions[key]?.status === 'OPEN') return false;

  const insiders = (
    clusters?.clusterBuying?.members ??
    clusters?.watchlisted ??
    []
  ).map((m) => ({
    wallet: m.wallet,
    label: m.label ?? 'Insider',
    solscan: m.solscan,
    baselineBalance: rpcBalances[m.wallet] ?? null,
  }));

  store.positions[key] = {
    chain: pair.chainId,
    address: pair.baseToken.address,
    symbol: pair.baseToken.symbol ?? '?',
    entryMarketCap: demand.marketCap ?? 0,
    peakMarketCap: demand.marketCap ?? 0,
    alertedAt: Date.now(),
    insiders,
    // The tier the alert was sent under. Stored on the position rather than
    // looked up later, so a position keeps the stop-loss it was OPENED with
    // even if the config is retuned underneath it mid-trade.
    category,
    // Drain baseline, captured at alert time so the very first monitor tick has
    // something to compare against. Without it the first tick is blind, and the
    // first tick after a buy alert is exactly when a rug is most likely.
    lastLiquiditySol: demand?.liquiditySol ?? null,
    lastLiquidityAt: Date.now(),
    firedTriggers: [],
    status: 'OPEN',
  };
  return true;
}

/**
 * Stop-loss for a position, tightened per category.
 *
 * Exists because the early-tier alert text promises a "-15% stop-loss" while
 * the global floor is 20% — the alert was asking for a tighter stop than the
 * notifier would actually send. The category is read off the position, so this
 * resolves the contradiction without changing the stop on any other tier.
 */
export function stopLossPctFor(position, cfg) {
  const byCategory = cfg.stopLossPctByCategory ?? {};
  const specific = position?.category ? byCategory[position.category] : undefined;
  return specific ?? cfg.stopLossPct ?? 20;
}

/* ------------------------------------------------------------------ *
 * Balance reads
 * ------------------------------------------------------------------ */

async function rpc(url, method, params) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    return body.error ? { error: body.error.message } : { result: body.result };
  } catch (err) {
    return { error: err.message };
  }
}

/** Current token balance for a wallet, summed across its accounts for the mint. */
export async function walletTokenBalance(rpcUrl, wallet, mint) {
  if (!rpcUrl) return null;
  const r = await rpc(rpcUrl, 'getTokenAccountsByOwner', [
    wallet,
    { mint },
    { encoding: 'jsonParsed' },
  ]);
  if (r.error) return null;
  return (r.result?.value ?? []).reduce(
    (sum, a) => sum + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0),
    0
  );
}

/* ------------------------------------------------------------------ *
 * Trigger evaluation
 * ------------------------------------------------------------------ */

export function evaluateTriggers(position, currentMcap, insiderStates, cfg) {
  const out = [];
  const entry = position.entryMarketCap;
  const fired = new Set(position.firedTriggers ?? []);

  const exitPct = cfg.insiderExitPct ?? 40;
  const tpMultiple = cfg.takeProfitMultiple ?? 2;
  const slPct = stopLossPctFor(position, cfg);

  // --- Trigger 1: insider exit -------------------------------------
  if (!fired.has(TRIGGER.INSIDER_EXIT)) {
    for (const s of insiderStates) {
      if (s.baseline === null || s.baseline <= 0 || s.current === null) continue;
      const soldPct = ((s.baseline - s.current) / s.baseline) * 100;
      if (soldPct >= exitPct) {
        out.push({
          trigger: TRIGGER.INSIDER_EXIT,
          headline: '🚨 INSIDER EXIT DETECTED!',
          reason: `${s.label} just sold ${soldPct.toFixed(0)}% of their tokens on-chain`,
          wallet: s.wallet,
          label: s.label,
          solscan: s.solscan,
          soldPct,
          action: 'Sell 50% to 100% of your position now to secure profit.',
          closes: true,
        });
        break;
      }
    }
  }

  // --- Trailing profit lock ----------------------------------------
  //
  // Evaluated BEFORE the fixed stop-loss and suppressing it when armed. Once a
  // position has run far enough to arm a lock, that lock sits above entry while
  // the fixed stop sits below it, so the trailing level is always the one that
  // should fire. Letting both run would send two exit alerts for one exit, and
  // the second would report a loss on a trade that closed in profit.
  const lock = armedTrailingLock(position, cfg);
  let trailingFired = false;

  if (lock && !fired.has(TRIGGER.TRAILING_LOCK) && currentMcap !== null && entry > 0) {
    const floor = entry * (1 + lock.lockGainPct / 100);
    if (currentMcap <= floor) {
      const nowPct = ((currentMcap - entry) / entry) * 100;
      // Signed explicitly. A position can gap straight through the floor to
      // below entry, and "+-30%" is not a number anyone should have to parse
      // while deciding whether to sell.
      const signed = `${nowPct >= 0 ? '+' : ''}${nowPct.toFixed(0)}%`;
      trailingFired = true;
      out.push({
        trigger: TRIGGER.TRAILING_LOCK,
        headline: '💰 TRAILING PROFIT LOCKED',
        reason:
          `Peaked at +${lock.peakGainPct.toFixed(0)}% and fell back to ${signed}, ` +
          `through the +${lock.lockGainPct}% floor armed at the +${lock.tierPeakPct}% tier`,
        action:
          nowPct > 0
            ? 'Exit now — the run has reversed and this closes the position above your entry rather than below it.'
            : 'Exit now. The move gapped through the trailing floor, so this is no longer a profitable exit — take what is left.',
        closes: true,
        lockGainPct: lock.lockGainPct,
        peakGainPct: lock.peakGainPct,
      });
    }
  }

  // --- Trigger 3 first: a delisted pair is the urgent case ----------
  // A delisted pair still reports through the stop-loss even when a trailing
  // lock is armed: liquidity being pulled is not a profitable exit, and it is
  // the one thing that must never be suppressed.
  if (!fired.has(TRIGGER.STOP_LOSS) && (!trailingFired || currentMcap === null)) {
    if (currentMcap === null) {
      out.push({
        trigger: TRIGGER.STOP_LOSS,
        headline: '⚠️ PAIR DELISTED — LIQUIDITY PULLED',
        reason: 'The trading pair has disappeared, which means liquidity was removed',
        action: 'Exit immediately if you still hold any position.',
        closes: true,
      });
    } else if (entry > 0 && currentMcap <= entry * (1 - slPct / 100)) {
      const dropPct = ((currentMcap - entry) / entry) * 100;
      out.push({
        trigger: TRIGGER.STOP_LOSS,
        headline: '⚠️ STOP-LOSS TRIGGERED',
        reason: `Token is ${dropPct.toFixed(1)}% below the alert market cap (floor -${slPct}%)`,
        action: 'Exit the trade now to protect capital.',
        closes: true,
      });
    }
  }

  // --- Trigger 2: take profit --------------------------------------
  if (!fired.has(TRIGGER.TAKE_PROFIT) && currentMcap !== null && entry > 0) {
    if (currentMcap >= entry * tpMultiple) {
      const gainPct = ((currentMcap - entry) / entry) * 100;
      const targetPct = Math.round((tpMultiple - 1) * 100);
      out.push({
        trigger: TRIGGER.TAKE_PROFIT,
        // Headline states the configured target and the actual move, so the
        // message stays correct if the multiple is retuned again.
        headline: `💰 TAKE PROFIT: Up +${gainPct.toFixed(0)}%! Lock in gains now!`,
        reason: `Token passed the +${targetPct}% target — now +${gainPct.toFixed(0)}% from the alert market cap`,
        action:
          'Consider taking out your initial capital so the remainder rides risk-free.',
        // Deliberately does not close: the stop-loss must keep protecting the
        // runner after initial capital is removed.
        closes: false,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Monitor
 * ------------------------------------------------------------------ */

export async function checkOpenPositions({ config, dryRun = false, quiet = false } = {}) {
  const cfg = config.sellSignals ?? {};
  if (cfg.enabled === false) return { checked: 0, fired: 0 };

  const store = await loadPositions();
  const open = Object.entries(store.positions).filter(([, p]) => p.status === 'OPEN');
  if (!open.length) return { checked: 0, fired: 0 };

  const env = await loadEnv(join(HERE, '.env'));
  const rpcUrl = env.rpcOverride ?? config.rpcUrl;
  const now = Date.now();

  // Read the poller's state file DIRECTLY rather than importing
  // liquidity_watch.mjs — that module imports this one, and a cycle between
  // them is not worth introducing for one JSON read.
  //
  // A live heartbeat means the 10s poller owns drain detection. Stale or
  // absent, and this process does the check itself at loop cadence, so
  // stopping the poller degrades resolution without ever losing coverage.
  let pollerLive = false;
  let pollerFired = {};
  try {
    const raw = JSON.parse(await readFile(join(HERE, '.state', 'liquidity_watch.json'), 'utf8'));
    const maxAge = (cfg.liquidityDrain?.pollerHeartbeatSeconds ?? 60) * 1000;
    pollerLive = typeof raw.heartbeatAt === 'number' && now - raw.heartbeatAt <= maxAge;
    pollerFired = raw.fired ?? {};
  } catch {
    /* no poller running — this process keeps the check */
  }
  const maxAgeMs = (cfg.maxMonitorHours ?? 48) * 3600 * 1000;

  // Batch the market data — one request covers up to 30 positions.
  const priced = await fetchPairsBatch(open.map(([, p]) => p.address));

  let firedCount = 0;
  const results = [];

  for (const [key, p] of open) {
    // Age out stale positions so the file cannot grow without bound.
    if (now - p.alertedAt > maxAgeMs) {
      p.status = 'EXPIRED';
      continue;
    }

    const pair = priced.get(p.address.toLowerCase());
    const currentMcap = pair ? (pair.marketCap ?? pair.fdv ?? 0) : null;
    if (currentMcap !== null && currentMcap > (p.peakMarketCap ?? 0)) {
      p.peakMarketCap = currentMcap;
    }

    // ---- Liquidity drain -------------------------------------------
    // Evaluated FIRST and short-circuiting: a pool being emptied outranks every
    // other trigger, including a trailing lock that would otherwise report a
    // tidy profitable exit on a token you are about to be unable to sell.
    //
    // When the dedicated 10s poller is alive it owns this check, and running it
    // here too would double-alert. This process stays the SINGLE WRITER of
    // open_positions.json, so it still closes what the poller reported.
    const liquiditySol = pair?.liquidity?.quote ?? null;
    const drain =
      pollerLive || typeof liquiditySol !== 'number'
        ? null
        : detectLiquidityDrain(p, liquiditySol, cfg, now);

    if (pollerLive && pollerFired[key] && !p.firedTriggers.includes(TRIGGER.LIQUIDITY_DRAIN)) {
      const f = pollerFired[key];
      if (!dryRun) {
        p.firedTriggers.push(TRIGGER.LIQUIDITY_DRAIN);
        p.status = 'CLOSED';
      }
      if (!quiet) {
        console.log(
          `   🚨 $${p.symbol} closed by the liquidity watcher (-${f.dropPct?.toFixed(1)}% in ${f.elapsedSec?.toFixed(0)}s)`
        );
      }
      continue;
    }

    if (typeof liquiditySol === 'number') {
      p.lastLiquiditySol = liquiditySol;
      p.lastLiquidityAt = now;
    }

    if (drain && !p.firedTriggers.includes(TRIGGER.LIQUIDITY_DRAIN)) {
      results.push({ key, position: p, currentMcap, ...drain });
      if (!dryRun) {
        p.firedTriggers.push(TRIGGER.LIQUIDITY_DRAIN);
        p.status = 'CLOSED';
      }
      firedCount++;
      continue;
    }

    // Insider balances — only read when the trigger has not already fired,
    // since each wallet costs an RPC call.
    const insiderStates = [];
    if (!p.firedTriggers.includes(TRIGGER.INSIDER_EXIT)) {
      for (const ins of p.insiders ?? []) {
        if (ins.baselineBalance === null) continue;
        const current = await walletTokenBalance(rpcUrl, ins.wallet, p.address);
        insiderStates.push({
          wallet: ins.wallet,
          label: ins.label,
          solscan: ins.solscan,
          baseline: ins.baselineBalance,
          current,
        });
        await new Promise((r) => setTimeout(r, 120));
      }
    }

    const triggers = evaluateTriggers(p, currentMcap, insiderStates, cfg);
    for (const t of triggers) {
      results.push({ key, position: p, currentMcap, ...t });
      if (!dryRun) {
        p.firedTriggers.push(t.trigger);
        if (t.closes) p.status = 'CLOSED';
      }
      firedCount++;
    }
  }

  // ---- dispatch ----------------------------------------------------
  if (!dryRun && results.length && env.botToken && env.chatId) {
    for (const r of results) {
      const text = buildSellMessage({
        position: r.position,
        currentMcap: r.currentMcap,
        headline: r.headline,
        reason: r.reason,
        action: r.action,
        wallet: r.wallet,
        label: r.label,
        solscan: r.solscan,
        soldPct: r.soldPct,
        tradeLink: { template: config.tradeLinkTemplate },
      });
      const sent = await sendTelegram({ botToken: env.botToken, chatId: env.chatId, text });
      if (!quiet) {
        console.log(
          sent.ok
            ? `🔴 SELL SIGNAL sent — $${r.position.symbol}: ${r.trigger}`
            : `⚠️  SELL SIGNAL failed for $${r.position.symbol}: ${sent.error}`
        );
      }
    }
  }

  if (!dryRun) await savePositions(store);
  return { checked: open.length, fired: firedCount, results };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));

  if (process.argv.includes('--list')) {
    const store = await loadPositions();
    const all = Object.values(store.positions);
    console.log(`Open positions: ${all.filter((p) => p.status === 'OPEN').length} / ${all.length} total`);
    for (const p of all) {
      const age = ((Date.now() - p.alertedAt) / 3600000).toFixed(1);
      console.log(
        `  ${p.status.padEnd(8)} $${String(p.symbol).padEnd(12)} entry $${Math.round(p.entryMarketCap).toLocaleString('en-US').padStart(10)} · peak $${Math.round(p.peakMarketCap).toLocaleString('en-US').padStart(10)} · ${age}h · insiders ${p.insiders?.length ?? 0} · fired [${p.firedTriggers.join(',')}]`
      );
    }
    process.exit(0);
  }

  const dryRun = process.argv.includes('--dry-run');
  const res = await checkOpenPositions({ config, dryRun });
  console.log(
    `Sell monitor: ${res.checked} open position(s) checked, ${res.fired} trigger(s) fired${dryRun ? ' [DRY RUN]' : ''}`
  );
}
