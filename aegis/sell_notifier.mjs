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
};

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

  // --- Trigger 3 first: a delisted pair is the urgent case ----------
  if (!fired.has(TRIGGER.STOP_LOSS)) {
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
