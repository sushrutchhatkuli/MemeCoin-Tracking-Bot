#!/usr/bin/env node
/**
 * Why is a tracked whale's trade not reaching the book?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY. Subscribes, reads, prints. Nothing is quoted, signed, sent or
 * written — not even the paper book. It can be run alongside a live session.
 *
 * ── WHAT IT SEPARATES ───────────────────────────────────────────────────────
 * "The bot stopped copying wallet X" has four distinct causes and the dashboard
 * cannot tell them apart, because it reports `scanned` — trades handed over on
 * ONE tick — and not the counters that matter:
 *
 *   1. NOT SUBSCRIBED   the socket never opened for that wallet
 *   2. NOT NOTIFIED     subscribed, but logsSubscribe delivered nothing
 *   3. NOT ATTRIBUTED   notified, but parseWalletSwap declined the transaction
 *                       (multi-mint routes, transfers, non-swaps)
 *   4. NOT ACTED ON     attributed, then declined by a gate downstream
 *
 * This probe covers 1-3 directly and makes 4 the remaining explanation by
 * elimination. Each is a different fix, and guessing between them is how an
 * afternoon disappears.
 *
 *   node aegis/whale_feed_probe.mjs                  # all enabled wallets
 *   node aegis/whale_feed_probe.mjs --minutes 10     # stop after 10 minutes
 *   node aegis/whale_feed_probe.mjs --wallet <addr>  # just one
 *   node aegis/whale_feed_probe.mjs --verbose        # dump declined transactions
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { parseWalletSwap, solanaRpc, resolveTargets, resolveChainRpc } from './paper_copytrade.mjs';
// The same http->wss derivation the socket uses, from the same module, so the
// probe cannot connect somewhere the bot would not.
import { websocketUrlFor } from './discovery_daemon.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const flag = (argv, name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};

const loadJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
};

const hhmmss = (d = new Date()) => d.toISOString().slice(11, 19);

async function main(argv = []) {
  const verbose = argv.includes('--verbose');
  const minutes = Number(flag(argv, '--minutes', '0')) || 0;
  const onlyWallet = flag(argv, '--wallet', null);

  const config = await loadJson(join(HERE, 'config.json'), {});
  const watchlist = await loadJson(join(HERE, config.smartMoney?.watchlistFile ?? 'smart_wallets.json'), { wallets: [] });

  // Resolved through the SAME chain the bot uses, in the same order. On this
  // machine SOLANA_RPC_URL lives in .env rather than process.env, so reading
  // process.env directly finds nothing and the probe would silently test the
  // public node instead of the endpoint the bot is actually on — proving
  // nothing about the failure being investigated.
  const { loadEnv } = await import('./telegram.mjs');
  const dotenv = await loadEnv(join(HERE, '.env')).catch(() => ({}));
  const rpcUrl = resolveChainRpc({
    explicitUrl: flag(argv, '--rpc', null),
    envUrl: process.env.SOLANA_RPC_URL || dotenv.rpcOverride || null,
    configUrl: config.paperCopytrade?.rpcMirror?.url ?? null,
  });
  const wsUrl = websocketUrlFor(rpcUrl);

  const resolved = resolveTargets(watchlist, null, { limit: 5 });
  const targets = onlyWallet
    ? resolved.targets.filter((t) => t.address === onlyWallet)
    : resolved.targets;

  if (!targets.length) {
    console.error(onlyWallet ? `${onlyWallet} is not an enabled wallet in the watchlist.` : 'No enabled wallets.');
    process.exit(1);
  }

  const host = (() => { try { return new URL(rpcUrl).host; } catch { return 'unknown host'; } })();
  console.log(`\n  WHALE FEED PROBE — read-only`);
  console.log(`  endpoint ${host}   (${resolved.reason})`);
  console.log(`  ${targets.length} wallet(s), Ctrl+C to stop${minutes ? `, auto-stop in ${minutes}m` : ''}\n`);

  const stats = new Map(
    targets.map((t) => [t.address, {
      label: t.label, subscribed: false, closed: false,
      notified: 0, failedTx: 0, duplicates: 0,
      attributed: 0, declined: 0, unreadable: 0, lastAt: null, kinds: { BUY: 0, SELL: 0 },
    }])
  );
  const seen = new Set();

  // ── WHY THE TRANSACTION IS RE-READ HERE ────────────────────────────────────
  // A logsNotification carries a signature and logs, and nothing else — no
  // account keys, no balances. parseWalletSwap works from BALANCE DELTAS, so
  // the transaction has to be fetched before anything can be said about it.
  // That read is also the step the bot measures at 396-779ms.
  const readTx = async (signature) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const tx = await solanaRpc(rpcUrl, 'getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      ]);
      if (tx.ok && tx.result) return { ok: true, result: tx.result, attempts: attempt + 1 };
      await new Promise((r) => setTimeout(r, 300));
    }
    return { ok: false, attempts: 5 };
  };

  /** Why did parseWalletSwap decline? Reconstructed from the same fields it reads. */
  const explainDecline = (tx, wallet) => {
    const keys = (tx?.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k?.pubkey));
    const idx = keys.indexOf(wallet);
    if (idx === -1) return 'wallet is not an account key (mentioned via CPI or an inner instruction only)';

    const WSOL = 'So11111111111111111111111111111111111111112';
    const owned = (rows = []) => rows.filter((r) => r?.owner === wallet && r?.mint !== WSOL);
    const mints = new Set([
      ...owned(tx?.meta?.preTokenBalances).map((r) => r.mint),
      ...owned(tx?.meta?.postTokenBalances).map((r) => r.mint),
    ]);
    const solDelta = ((tx?.meta?.postBalances?.[idx] ?? 0) - (tx?.meta?.preBalances?.[idx] ?? 0)) / 1e9;

    if (mints.size === 0) return `no non-WSOL token balance owned by this wallet (SOL delta ${solDelta.toFixed(6)})`;
    if (mints.size > 1) return `touches ${mints.size} non-WSOL mints — not attributable to one position [${[...mints].map((m) => m.slice(0, 6)).join(', ')}]`;
    if (Math.abs(solDelta) < 1e-9) return `single mint ${[...mints][0].slice(0, 8)}… but SOL delta is zero — not a SOL-denominated swap`;
    return `single mint, SOL delta ${solDelta.toFixed(6)} — declined for another reason`;
  };

  const open = (address, label) => {
    const s = stats.get(address);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: [address] }, { commitment: 'processed' }],
      }));
      console.log(`  [${hhmmss()}] SUBSCRIBED  ${address.slice(0, 12)}…  ${label ?? ''}`);
    };

    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.method !== 'logsNotification') {
        if (msg.result !== undefined && msg.id === 1) {
          s.subscribed = true;
          console.log(`  [${hhmmss()}] sub id ${msg.result} confirmed for ${address.slice(0, 8)}…`);
        } else if (msg.error) {
          console.log(`  [${hhmmss()}] ${address.slice(0, 8)}…  SUBSCRIBE REFUSED  ${JSON.stringify(msg.error)}`);
        }
        return;
      }

      const value = msg.params?.result?.value;
      const signature = value?.signature;
      if (!signature) return;

      s.notified++;
      s.lastAt = Date.now();

      // Counted and skipped exactly as the bot does, so the numbers line up.
      if (value.err) {
        s.failedTx++;
        console.log(`  [${hhmmss()}] ${address.slice(0, 8)}…  FAILED TX     ${signature.slice(0, 16)}…`);
        return;
      }
      if (seen.has(signature)) { s.duplicates++; return; }
      seen.add(signature);

      const tx = await readTx(signature);
      if (!tx.ok) {
        s.unreadable++;
        console.log(`  [${hhmmss()}] ${address.slice(0, 8)}…  UNREADABLE    ${signature.slice(0, 16)}…  (5 attempts)`);
        return;
      }

      const trade = parseWalletSwap(tx.result, { wallet: address });
      if (!trade) {
        s.declined++;
        console.log(`  [${hhmmss()}] ${address.slice(0, 8)}…  NOT A TRADE   ${signature.slice(0, 16)}…`);
        console.log(`             ↳ ${explainDecline(tx.result, address)}`);
        if (verbose) {
          console.log(`             ↳ logs: ${(value.logs ?? []).slice(0, 4).join(' | ').slice(0, 300)}`);
        }
        return;
      }

      s.attributed++;
      s.kinds[trade.kind] = (s.kinds[trade.kind] ?? 0) + 1;
      const blockAt = trade.blockTime ? new Date(trade.blockTime * 1000).toISOString().slice(11, 19) : '--:--:--';
      console.log(
        `  [${hhmmss()}] ${address.slice(0, 8)}…  ${trade.kind.padEnd(4)} ${trade.mint.slice(0, 12)}…` +
        `  block ${blockAt}  read in ${tx.attempts} attempt(s)`
      );
    };

    ws.onerror = (e) => console.log(`  [${hhmmss()}] ${address.slice(0, 8)}…  SOCKET ERROR  ${e?.message ?? 'unknown'}`);
    ws.onclose = (ev) => {
      s.closed = true;
      console.log(`  [${hhmmss()}] ${address.slice(0, 8)}…  SOCKET CLOSED  code=${ev?.code ?? '?'}${ev?.reason ? ` reason=${ev.reason}` : ''}`);
    };
    return ws;
  };

  const sockets = targets.map((t) => open(t.address, t.label));

  const report = () => {
    console.log(`\n${'─'.repeat(78)}`);
    console.log('  WHERE EACH WALLET STANDS\n');
    console.log(`  ${'wallet'.padEnd(14)}${'notif'.padStart(7)}${'trades'.padStart(8)}${'declined'.padStart(10)}${'failed'.padStart(8)}${'unread'.padStart(8)}${'dupes'.padStart(7)}`);
    for (const [addr, s] of stats) {
      console.log(
        `  ${(addr.slice(0, 12) + '…').padEnd(14)}${String(s.notified).padStart(7)}${String(s.attributed).padStart(8)}` +
        `${String(s.declined).padStart(10)}${String(s.failedTx).padStart(8)}${String(s.unreadable).padStart(8)}${String(s.duplicates).padStart(7)}`
      );
    }

    // ── CHECKED FIRST, BECAUSE IT INVALIDATES EVERYTHING BELOW ─────────────
    // One connection per wallet is one connection per wallet, and providers cap
    // CONCURRENT connections per key. Helius drops the surplus with close code
    // 1006 — no close frame, no error body — so the bot reports a healthy
    // socket feed while silently watching a fraction of the watchlist.
    // MEASURED on this endpoint: 1 of 5 survived opened together, 3 of 5 opened
    // 1.5s apart, and 5 of 5 when multiplexed onto a single connection.
    const never = [...stats.entries()].filter(([, s]) => !s.subscribed);
    if (never.length) {
      console.log(`\n  ⛔ ${never.length} of ${stats.size} WALLET(S) NEVER SUBSCRIBED\n`);
      for (const [addr, s] of never) {
        console.log(`     ${addr.slice(0, 12)}…  ${s.closed ? 'connection closed before the subscription confirmed' : 'no confirmation'}`);
      }
      console.log(`\n     This is a CONNECTION-COUNT limit, not a whale being quiet, and it`);
      console.log(`     is upstream of everything else in this report: an unsubscribed wallet`);
      console.log(`     cannot notify, so its zero below means nothing. Fix this first.`);
      console.log(`     Workaround now : --track-whales ${Math.max(1, stats.size - never.length)}`);
      console.log(`     Real fix       : multiplex every logsSubscribe onto ONE connection.`);
    }

    console.log('\n  READ THE ROW:');
    for (const [addr, s] of stats) {
      const short = addr.slice(0, 8) + '…';
      if (!s.subscribed) {
        console.log(`    ${short}  NOT SUBSCRIBED — never got a feed. See above; counts are meaningless.`);
      } else if (s.notified === 0) {
        console.log(`    ${short}  NOT NOTIFIED — subscribed, zero notifications. Either the wallet`);
        console.log(`               is genuinely idle, or logsSubscribe is not delivering for it.`);
        console.log(`               Cross-check the wallet on a block explorer for this window.`);
      } else if (s.attributed === 0 && s.declined > 0) {
        console.log(`    ${short}  NOT ATTRIBUTED — ${s.declined} transaction(s) arrived and every one was`);
        console.log(`               declined by parseWalletSwap. The feed is fine; the parser cannot`);
        console.log(`               read this wallet's trade shape. See the ↳ reasons above.`);
      } else if (s.attributed > 0) {
        console.log(`    ${short}  DELIVERING — ${s.attributed} trade(s) (${s.kinds.BUY ?? 0} buy, ${s.kinds.SELL ?? 0} sell).`);
        console.log(`               Detection is NOT the problem. Anything missing from the book was`);
        console.log(`               declined downstream by a gate, cap or filter.`);
      } else {
        console.log(`    ${short}  ${s.notified} notification(s), none usable — ${s.failedTx} failed on chain, ${s.unreadable} unreadable.`);
      }
    }
    console.log(`${'─'.repeat(78)}\n`);
  };

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const ws of sockets) { try { ws.close(); } catch { /* already closing */ } }
    report();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  if (minutes) setTimeout(stop, minutes * 60_000);

  // A heartbeat, so a silent feed is distinguishable from a hung probe.
  setInterval(() => {
    const total = [...stats.values()].reduce((a, s) => a + s.notified, 0);
    const trades = [...stats.values()].reduce((a, s) => a + s.attributed, 0);
    console.log(`  [${hhmmss()}] … ${total} notification(s), ${trades} attributed trade(s) so far`);
  }, 30_000).unref?.();
}

await main(process.argv.slice(2));
