#!/usr/bin/env node
/**
 * Automated Top-50 Elite Whale Sync — Composite Elite Ranking.
 *
 *   node auto_top_whales.mjs                 rank from Aegis's own observations
 *   node auto_top_whales.mjs --import <file> rank from a leaderboard export
 *   node auto_top_whales.mjs --dry-run       report only, do not write
 *   node auto_top_whales.mjs --report        show current qualification progress
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE ARE TWO MODES
 *
 * The three ranking rules need win rate, realized P&L and lifetime trade count
 * per wallet. Getting those for *the whole of Solana* requires enumerating every
 * trader, and no provider exposes that: GMGN returns 403 behind Cloudflare,
 * Birdeye and Dune return 401 without a paid key, Cielo's public feed is empty,
 * Solscan refuses the connection. Verified, not assumed.
 *
 * So the top-50 list cannot be *fetched*. It can be:
 *
 *   OBSERVE mode (default) — earned. Aegis already replays pool trades and sees
 *   real buyers; the post-mortem already grades those tokens WIN/FAIL. Joining
 *   them produces a leaderboard derived from Aegis's own evidence, tuned to the
 *   exact token population it scans. It starts empty and compounds daily, the
 *   same way the deployer index reached 600+ entries without any feed.
 *
 *   IMPORT mode — seeded. Point --import at a CSV/JSON export from GMGN, Cielo,
 *   Birdeye or Dune. The three composite rules are applied strictly to that
 *   data, so the ranking logic is identical; only the source differs.
 *
 * What this module will NOT do is invent 50 plausible-looking addresses with
 * plausible-looking win rates. That would manufacture exactly the false signal
 * the scanner exists to filter out.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';

import { loadObservations, walletStats } from './wallet_observations.mjs';
import { validateWatchlistEntry, SYSTEM_ACCOUNTS, screenSystemAccount } from './smart_money.mjs';
import { loadEnv } from './telegram.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Composite Elite Ranking
 * ------------------------------------------------------------------ */

export const ELITE_RULES = {
  minWinRatePct: 75,
  minNetProfitUsd: 50_000,
  minLifetimeTrades: 100,
  topN: 50,
  // A win rate over 2 graded trades is noise. Without a floor, the first wallet
  // to catch one pump would enter the list at 100%.
  minGradedBuys: 10,
};

/**
 * Apply all three rules. A candidate must pass every one — the rules are AND,
 * not a weighted blend, so a spectacular win rate cannot compensate for a thin
 * trade history (which is how small-sample flukes get mistaken for skill).
 */
export function applyEliteRules(candidates, rules = ELITE_RULES) {
  // Rule 2 is a LIFETIME metric. Observation cannot produce it: Aegis sees a
  // wallet's buys only on the tokens it happened to scan, over a window of
  // hours, and never sees the exits — so an observed profit figure is a slice,
  // not a career total, and will never legitimately clear $50k.
  //
  // `profitRule: 'skip'` ranks on the two rules that ARE measurable from
  // observation rather than returning an empty list forever. It is opt-in and
  // never silently applied to imported data, which does carry real lifetime P&L.
  const skipProfit = rules.profitRule === 'skip';

  const evaluated = candidates.map((c) => {
    const checks = {
      sample:
        c.gradedBuys === undefined ||
        c.gradedBuys === null ||
        c.gradedBuys >= (rules.minGradedBuys ?? 0),
      winRate: c.winRatePct !== null && c.winRatePct >= rules.minWinRatePct,
      netProfit: skipProfit
        ? true
        : c.netProfitUsd !== null && c.netProfitUsd >= rules.minNetProfitUsd,
      trades: c.lifetimeTrades !== null && c.lifetimeTrades >= rules.minLifetimeTrades,
    };
    return { ...c, checks, qualified: Object.values(checks).every(Boolean) };
  });

  const qualified = evaluated
    .filter((c) => c.qualified)
    // Rule 1 is the primary sort; profit and trade count break ties.
    .sort(
      (a, b) =>
        b.winRatePct - a.winRatePct ||
        (b.netProfitUsd ?? 0) - (a.netProfitUsd ?? 0) ||
        b.lifetimeTrades - a.lifetimeTrades
    )
    .slice(0, rules.topN);

  return { evaluated, qualified };
}

const money = (n) =>
  n === null || n === undefined
    ? '?'
    : Math.abs(n) >= 1000
      ? `${n < 0 ? '-' : '+'}$${Math.round(Math.abs(n) / 1000)}k`
      : `${n < 0 ? '-' : '+'}$${Math.round(Math.abs(n))}`;

/** Render the watchlist file in the format smart_money.mjs consumes. */
export function buildWatchlist(qualified, { source, rules }) {
  const profitSkipped = rules.profitRule === 'skip';

  return {
    _comment: [
      'AUTO-GENERATED by auto_top_whales.mjs — manual edits are overwritten on',
      'the next sync. Add hand-picked wallets to a separate file instead.',
      '',
      `Source: ${source}`,
      `Generated: ${new Date().toISOString()}`,
      `Rules applied: win rate >= ${rules.minWinRatePct}% over >= ${rules.minGradedBuys} graded buys,`,
      profitSkipped
        ? 'net profit rule SKIPPED (lifetime realized P&L is not derivable from observation),'
        : `net profit >= $${rules.minNetProfitUsd.toLocaleString('en-US')},`,
      `on-chain activity >= ${rules.minLifetimeTrades} signatures.`,
      `Selected top ${rules.topN} by win rate, then sample size.`,
      '',
      'READ THE SAMPLE SIZE. A 100% win rate over 3 graded buys is not evidence',
      'of edge — it is three trades. `graded_buys` is the number that matters',
      'and it should grow over time; the win rate will fall as it does.',
    ],
    generated: {
      at: new Date().toISOString(),
      source,
      profitRuleSkipped: profitSkipped,
      count: qualified.length,
    },
    wallets: qualified.map((w, i) => {
      const entry = {
        address: w.address,
        // Sample size in the label, not a profit figure. When profit is skipped
        // the number is an artifact of observed spend (often single dollars) and
        // putting it next to "Elite Whale" reads as a credential it has not
        // earned.
        label: profitSkipped
          ? `Elite Whale #${i + 1} (${w.winRatePct.toFixed(0)}% WR on ${w.gradedBuys ?? '?'} graded)`
          : `Elite Whale #${i + 1} (${w.winRatePct.toFixed(0)}% WR | ${money(w.netProfitUsd)})`,
        win_rate: `${w.winRatePct.toFixed(0)}%`,
        graded_buys: w.gradedBuys ?? null,
        // getSignaturesForAddress caps at 1000, so an exact 1000 means "at least
        // 1000" — and these are signatures, not trades. Naming it accurately
        // stops it being read as a verified trade count.
        onchain_signatures:
          w.lifetimeTrades === 1000 ? '1000+ (query cap)' : (w.lifetimeTrades ?? null),
        solscan: `https://solscan.io/account/${w.address}`,
        source: w.source ?? source,
        stats_updated: new Date().toISOString().slice(0, 10),
        metrics_basis: w.basis ?? 'unknown',
        enabled: true,
      };
      if (!profitSkipped) entry.net_profit_usd = money(w.netProfitUsd);
      return entry;
    }),
  };
}

/* ------------------------------------------------------------------ *
 * OBSERVE mode
 * ------------------------------------------------------------------ */

async function candidatesFromObservations(config) {
  const store = await loadObservations(join(HERE, '.state', 'wallet_observations.json'));
  const wallets = Object.entries(store.wallets);
  if (!wallets.length) return { candidates: [], totalSeen: 0 };

  // SOL/USD for profit estimation, taken from a live pair so it matches every
  // other dollar figure the scanner reports.
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  let solUsd = 0;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`);
    const d = await r.json();
    // priceUsd is always the BASE token's price. Pairs where SOL is the quote
    // report the other token's price, so filtering on base is required — taking
    // any pair yields nonsense like "SOL @ $0.01".
    const solPairs = (d.pairs ?? [])
      .filter((x) => x.baseToken?.address === SOL_MINT && Number(x.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    solUsd = solPairs.length ? Number(solPairs[0].priceUsd) : 0;
  } catch {
    /* profit estimation degrades to null without it */
  }

  // Ledger maturity. Failures take 1–6h to be graded while pumps register
  // almost immediately, so a young ledger contains WINs and NEUTRALs but no
  // FAILs — and every win rate computed from it is inflated toward 100%.
  // Ranking on that would fabricate an elite list out of survivorship bias.
  const allBuys = wallets.flatMap(([, e]) => e.buys);
  const graded = allBuys.filter((b) => b.outcome && b.outcome !== 'NEUTRAL');
  const fails = graded.filter((b) => b.outcome === 'FAIL').length;
  const observedFailRate = graded.length ? (fails / graded.length) * 100 : 0;

  // Distinct tokens decided, and their failure rate. This is the honest view:
  // the buy-weighted rate is dominated by whichever surviving token happened to
  // attract the most buyers, so a single popular winner can drag it to ~1%.
  const byToken = new Map();
  for (const b of allBuys) {
    if (b.outcome && b.outcome !== 'NEUTRAL' && !byToken.has(b.token)) {
      byToken.set(b.token, b.outcome);
    }
  }
  const tokenFails = [...byToken.values()].filter((v) => v === 'FAIL').length;
  const tokenFailRate = byToken.size ? (tokenFails / byToken.size) * 100 : 0;

  // Compare against the failure rate the post-mortem measures across ALL
  // scanned tokens. If the ledger's population is far cleaner than reality, it
  // is not a representative sample and any win rate drawn from it is inflated.
  let baseFailRate = null;
  try {
    const h = JSON.parse(await readFile(join(HERE, 'learning_history.json'), 'utf8'));
    const counts = (h.outcomes ?? []).reduce((a, x) => {
      a[x.verdict] = (a[x.verdict] ?? 0) + 1;
      return a;
    }, {});
    const decided = (counts.FAIL ?? 0) + (counts.WIN ?? 0);
    if (decided >= 50) baseFailRate = ((counts.FAIL ?? 0) / decided) * 100;
  } catch {
    /* no history yet — fall back to the weak check below */
  }

  const minShare = config.eliteWhales?.minRepresentativeness ?? 0.5;
  const required = baseFailRate === null ? null : baseFailRate * minShare;
  const representative = required === null ? fails > 0 : tokenFailRate >= required;

  const maturity = {
    tokens: new Set(allBuys.map((b) => b.token)).size,
    decidedTokens: byToken.size,
    gradedBuys: graded.length,
    fails,
    observedFailRate,
    tokenFailRate,
    baseFailRate,
    required,
    mature: fails > 0 && representative,
  };

  const candidates = [];
  for (const [address, entry] of wallets) {
    const s = walletStats(entry, solUsd);
    candidates.push({
      address,
      winRatePct: s.winRatePct,
      netProfitUsd: s.estimatedProfitUsd,
      gradedBuys: s.gradedBuys,
      // Observed positions, not lifetime trades. Enriched below for wallets
      // that clear the other two rules, because the enrichment costs an RPC
      // call each and most candidates never get that far.
      lifetimeTrades: s.gradedBuys,
      observed: s,
      source: 'aegis-observed',
      basis: 'observed buys graded by post-mortem (not lifetime realized P&L)',
    });
  }
  return { candidates, totalSeen: wallets.length, solUsd, maturity };
}

/**
 * Rank eligible candidates by how much of their behaviour has actually been
 * observed, and keep only the top `cap` for per-wallet network work.
 *
 * Split out of syncTopWhales so the ordering can be tested without a network.
 * Returns a NEW array of the SAME object references — enrichment mutates
 * candidates in place, and the caller relies on those mutations being visible
 * through the full `wellFormed` list it later ranks.
 *
 * Graded buys lead the sort, observed buys break ties. See the call site for
 * why raw observation count alone would be the wrong key.
 */
export function capEnrichmentShortlist(eligible, cap = 50) {
  if (!Array.isArray(eligible)) return [];

  // Sort ALWAYS, slice conditionally. An earlier version returned the input
  // unsorted whenever the cap was not a finite number, which made "no cap"
  // silently mean "no ranking" — the ordering is the useful half of this
  // function, and a caller disabling the limit still wants best-first.
  const ranked = [...eligible].sort(
    (a, b) =>
      (b.gradedBuys ?? 0) - (a.gradedBuys ?? 0) ||
      (b.observed?.observedBuys ?? 0) - (a.observed?.observedBuys ?? 0)
  );
  if (!Number.isFinite(cap) || cap < 0) return ranked;
  return ranked.slice(0, cap);
}

/* ------------------------------------------------------------------ *
 * On-chain realized PnL
 * ------------------------------------------------------------------ */

/**
 * Net SOL realized through SWAPS, derived from Helius Enhanced Transactions.
 *
 * ── WHY SWAPS ONLY, AND NOT EVERY TRANSACTION ───────────────────────────────
 * Summing the native balance delta across ALL transactions does not measure
 * trading at all — it measures deposits minus withdrawals. A wallet that moves
 * 1,000 SOL in from an exchange reads as +$75k "profit" and would sail past a
 * $50k filter having never made a trade; a winner who cashes out reads as a
 * loss. Measured on three current elite wallets, the all-transaction figure
 * was +$302, $0 and -$174 — noise around zero, because deposits and
 * withdrawals dominate and roughly cancel.
 *
 * Restricting to `type === 'SWAP'` removes transfers, so what remains is SOL
 * out to buy and SOL in from selling. That is the standard construction of
 * realized PnL.
 *
 * ── WHAT IT STILL CANNOT SEE ────────────────────────────────────────────────
 * OPEN POSITIONS READ AS LOSSES. A wallet that spent 40 SOL on tokens it still
 * holds shows -40 SOL, and no amount of RPC fixes that: the SOL genuinely left
 * and the token's value is not a SOL balance. The same three wallets measured
 * -$2,236, -$229 and +$141 on swaps — all are active buyers still holding, so
 * the figure is biased negative by construction, and by an unknown amount.
 *
 * Read it as "SOL cycled back out through swaps", not "how much this wallet is
 * up". It is honest about closed positions and pessimistic about open ones.
 *
 * Helius pages 100 transactions per call, so a 600-transaction wallet costs six
 * calls and ~3.6s — affordable only because the shortlist is capped at 50.
 * Returns netUsd null (never 0) when it cannot be derived: unknown and
 * break-even are different claims, and Rule 2 must not confuse them.
 */
export async function deriveRealizedPnl(wallet, { heliusKey, solUsd, cfg = {} }) {
  if (!heliusKey) return { ok: false, reason: 'no Helius API key in rpcUrl', netUsd: null };

  const maxPages = cfg.pnlMaxPages ?? 6;
  const swapsOnly = cfg.pnlSwapsOnly !== false;
  let before = null;
  let swapLamports = 0;
  let allLamports = 0;
  let swaps = 0;
  let txs = 0;
  let pages = 0;
  let truncated = false;

  while (pages < maxPages) {
    const url =
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
      `?api-key=${encodeURIComponent(heliusKey)}&limit=100${before ? `&before=${before}` : ''}`;
    // Retried, because a 429 here does not just truncate a history — on the
    // FIRST page it leaves txs at 0, which makes netUsd null, which fails
    // Rule 2. Without a retry a wallet can be dropped from the elite list by a
    // rate limit rather than on merit. Observed directly: consecutive syncs
    // derived 48/48 and then 22/48 purely from request pacing.
    let batch = null;
    for (let attempt = 0; attempt < 3 && batch === null; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, (cfg.pnlDelayMs ?? 250) * 4 * attempt));
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(cfg.pnlTimeoutMs ?? 25000) });
        if (!res.ok) continue;
        batch = await res.json();
      } catch {
        /* retry, then give up */
      }
    }
    if (batch === null) {
      // A partial history is still usable, but it must be FLAGGED — a
      // truncated sum silently understates a wallet that traded earlier.
      truncated = true;
      break;
    }
    if (!Array.isArray(batch) || !batch.length) break;

    for (const tx of batch) {
      txs++;
      const delta = (tx.accountData ?? []).find((a) => a.account === wallet)?.nativeBalanceChange ?? 0;
      allLamports += delta;
      if (tx.type === 'SWAP') {
        swaps++;
        swapLamports += delta;
      }
    }
    before = batch[batch.length - 1].signature;
    pages++;
    if (batch.length < 100) break;
    await new Promise((r) => setTimeout(r, cfg.pnlDelayMs ?? 250));
  }

  if (pages >= maxPages) truncated = true;
  const lamports = swapsOnly ? swapLamports : allLamports;
  const netSol = lamports / 1e9;

  return {
    ok: txs > 0,
    netSol,
    netUsd: txs > 0 && solUsd ? netSol * solUsd : null,
    // Both retained so the divergence is inspectable rather than asserted.
    swapNetSol: swapLamports / 1e9,
    allTxNetSol: allLamports / 1e9,
    swaps,
    txs,
    truncated,
    basis: swapsOnly ? 'net SOL through SWAP transactions' : 'net SOL across all transactions',
  };
}

/** Attach derived PnL to each candidate. Mutates in place, like enrichment. */
async function enrichRealizedPnl(candidates, { heliusKey, solUsd, cfg }) {
  if (!heliusKey) {
    console.log('   ⚠️  No Helius API key in rpcUrl — on-chain PnL cannot be derived, netProfitUsd stays null');
    return { derived: 0, failed: candidates.length };
  }
  let derived = 0;
  let failed = 0;
  let truncatedCount = 0;

  for (const c of candidates) {
    const pnl = await deriveRealizedPnl(c.address, { heliusKey, solUsd, cfg });
    if (pnl.ok && pnl.netUsd !== null) {
      c.netProfitUsd = pnl.netUsd;
      c.realizedPnl = pnl;
      c.basis += `; realized ${pnl.netSol >= 0 ? '+' : ''}${pnl.netSol.toFixed(2)} SOL over ${pnl.swaps} swap(s)${pnl.truncated ? ' (history truncated)' : ''}`;
      derived++;
      if (pnl.truncated) truncatedCount++;
    } else {
      // Left null, NOT zero. Rule 2 treats null as a failure, which is the
      // correct reading of "we could not measure this wallet".
      c.netProfitUsd = null;
      failed++;
    }
  }
  console.log(
    `   ↳ realized PnL derived for ${derived}/${candidates.length} wallet(s)` +
      (truncatedCount ? `, ${truncatedCount} with truncated history` : '') +
      (failed ? `, ${failed} unavailable` : '')
  );
  return { derived, failed };
}

/** Count on-chain signatures as a lifetime-activity proxy for finalists. */
async function enrichLifetimeTrades(candidates, rpcUrl) {
  if (!rpcUrl) return;

  // A failed enrichment leaves lifetimeTrades at the observed buy count, which
  // then fails the >=100 trades rule — so a single transient RPC error silently
  // drops a wallet off the elite list. Observed directly: two consecutive syncs
  // over the same 50 wallets produced 43 and then 46 passes, and the run that
  // lost three enrichments also lost the highest-profit wallet from the top 5.
  //
  // One retry plus a visible count converts that from an invisible coin-flip
  // into something you can see in the log. It is affordable now only because
  // the shortlist is capped — retrying 3,444 wallets would not have been.
  let failed = 0;
  for (const c of candidates) {
    let got = null;
    for (let attempt = 0; attempt < 3 && got === null; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1200 * attempt));
      try {
        const r = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSignaturesForAddress',
            params: [c.address, { limit: 1000 }],
          }),
          signal: AbortSignal.timeout(20000),
        });
        const j = await r.json();
        if (Array.isArray(j.result)) {
          got = j.result.length;
        } else if (r.status === 429 || j?.error?.code === -32429) {
          await new Promise((res) => setTimeout(res, 1500));
        }
      } catch {
        /* retry on network timeout */
      }
    }

    if (got === null) {
      failed++;
    } else {
      c.lifetimeTrades = got;
      c.basis += `; lifetime activity = ${got} signatures${got === 1000 ? ' (capped)' : ''}`;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  if (failed) {
    console.log(
      `   ⚠️  ${failed} of ${candidates.length} enrichment call(s) failed after a retry — ` +
        `those wallets keep their observed count and cannot pass the trades rule this sync`
    );
  }
}

/* ------------------------------------------------------------------ *
 * IMPORT mode
 * ------------------------------------------------------------------ */

const NUM = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,%+\s]/g, '').replace(/k$/i, 'e3').replace(/m$/i, 'e6'));
  return Number.isFinite(n) ? n : null;
};

/** Pick a field by any of several plausible header names. */
const pick = (row, names) => {
  for (const n of names) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase().replace(/[\s_-]/g, '') === n) return row[key];
    }
  }
  return null;
};

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map((line) => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)/g)?.filter((_, i) => i % 2 === 0) ?? line.split(',');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = String(cells[i] ?? '').trim().replace(/^"|"$/g, '');
    });
    return row;
  });
}

async function candidatesFromImport(path) {
  const text = await readFile(path, 'utf8');
  const rows =
    extname(path).toLowerCase() === '.csv'
      ? parseCsv(text)
      : (() => {
          const j = JSON.parse(text);
          return Array.isArray(j) ? j : (j.wallets ?? j.data ?? j.results ?? []);
        })();

  return rows
    .map((row) => ({
      address: String(
        pick(row, ['address', 'wallet', 'walletaddress', 'account', 'owner']) ?? ''
      ).trim(),
      winRatePct: NUM(pick(row, ['winrate', 'winratepct', 'wr', 'winrate%'])),
      netProfitUsd: NUM(
        pick(row, ['netprofit', 'netprofitusd', 'realizedpnl', 'pnl', 'profit', 'totalpnl'])
      ),
      lifetimeTrades: NUM(pick(row, ['trades', 'tradecount', 'totaltrades', 'txcount', 'swaps'])),
      source: 'imported-leaderboard',
      basis: `imported from ${path.split(/[\\/]/).pop()}`,
    }))
    .filter((c) => c.address);
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

export async function syncTopWhales({ importPath = null, dryRun = false, reportOnly = false } = {}) {
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));

  // Apply the same .env RPC override the scanner uses. Without this the
  // enrichment step silently ran against the public RPC and got throttled
  // mid-pass, so Rule 3 reported wildly different pass counts on identical
  // data depending on how much rate limit was left.
  const env = await loadEnv(join(HERE, '.env'));
  if (env.rpcOverride) config.rpcUrl = env.rpcOverride;

  const rules = { ...ELITE_RULES, ...(config.eliteWhales ?? {}) };

  let candidates = [];
  let source;
  let totalSeen = 0;
  let maturity = null;
  // SOL price, needed to convert derived lamport flow to USD. Bound at this
  // scope because the import path never sets it and PnL derivation is skipped
  // there anyway (imported leaderboards carry real P&L).
  let solUsd = 0;

  if (importPath) {
    candidates = await candidatesFromImport(resolve(importPath));
    source = `import:${importPath}`;
    totalSeen = candidates.length;
    console.log(`📥 Imported ${candidates.length} candidate wallet(s) from ${importPath}`);
  } else {
    const obs = await candidatesFromObservations(config);
    candidates = obs.candidates;
    totalSeen = obs.totalSeen;
    maturity = obs.maturity;
    solUsd = obs.solUsd ?? 0;
    source = 'aegis-observed';
    console.log(
      `🔍 Observed ledger: ${totalSeen} wallet(s) seen buying scanned tokens` +
        (obs.solUsd ? ` (SOL @ $${obs.solUsd.toFixed(2)})` : '')
    );

    if (maturity && !maturity.mature) {
      console.log('');
      console.log('🛑 LEDGER NOT REPRESENTATIVE — refusing to rank.');
      console.log(
        `   ${maturity.gradedBuys} graded buy(s) across ${maturity.tokens} token(s); ` +
          `${maturity.decidedTokens} token(s) decided.`
      );
      console.log(
        `   Ledger failure rate : ${maturity.tokenFailRate.toFixed(1)}% by token, ` +
          `${maturity.observedFailRate.toFixed(1)}% by buy`
      );
      if (maturity.baseFailRate !== null) {
        console.log(
          `   Post-mortem reality : ${maturity.baseFailRate.toFixed(1)}% across all scanned tokens ` +
            `(need ≥ ${maturity.required.toFixed(1)}%)`
        );
        console.log('');
        console.log('   The ledger is far cleaner than the market it samples, so win rates');
        console.log('   drawn from it are inflated. Buyer replay only reads tokens with a live');
        console.log('   pool, and one popular survivor can supply most of the graded buys —');
        console.log('   a wallet that touched it once then reads as 100%.');
      } else {
        console.log('   No graded failures yet; losers take 1–6h while pumps register at once.');
      }
      console.log('   Ranking stays blocked until the sample looks like the market.');
      return { qualified: [], evaluated: [], written: false, maturity };
    }
  }

  // Reject malformed addresses before they can occupy a slot.
  // Filter at WRITE time as well as read time. Without this a system account
  // that qualified from observations would be written back every sync and only
  // suppressed on load — the file itself would keep lying.
  const wellFormed = [];
  let rejected = 0;
  let systemRejected = 0;
  for (const c of candidates) {
    if (!validateWatchlistEntry(c).valid) { rejected++; continue; }
    if (SYSTEM_ACCOUNTS.has(c.address)) { systemRejected++; continue; }
    wellFormed.push(c);
  }
  if (systemRejected) console.log(`   🛑 ${systemRejected} known system/DEX account(s) excluded from ranking`);
  if (rejected) console.log(`   ⚠️  ${rejected} candidate(s) rejected as invalid Solana addresses`);

  // Enrich everything clearing Rule 1, and only Rule 1.
  //
  // Gating on Rule 2 as well was a bug: lifetimeTrades starts as the observed
  // position count, so Rule 3 can only ever pass AFTER enrichment. Requiring
  // Rule 2 first meant no candidate was enriched, and Rule 3 reported 0 passes
  // regardless of the wallet's real history. Win rate is the cheap discriminator
  // and is computed without any network call, so it is the right gate.
  const eligible = wellFormed.filter(
    (c) => c.winRatePct !== null && c.winRatePct >= rules.minWinRatePct
  );

  // ---- Cap the shortlist before any per-wallet network work ---------
  //
  // Everything below this line costs RPC calls PER WALLET — screening, then
  // enrichment — and the ledger had grown to 3,444 eligible wallets. Measured
  // at 111 KB and 0.44s each, that is ~390 MB of JSON and ~25 minutes per sync,
  // against a `topN` of 5 wallets actually written. The overwhelming majority of
  // that work was discarded.
  //
  // Worse, it ran on a maintenance cadence of every 10 minutes, so the loop
  // spent most of its life syncing instead of scanning — the source of the
  // "468 tick(s) skipped while busy" in the logs.
  //
  // SORT KEY: graded buys first, observed buys second. Both are "how much have
  // we actually seen this wallet do", but graded count is the one that gates
  // qualification — the `sample` rule requires minGradedBuys decided outcomes,
  // so a wallet with 40 observed buys and 0 graded ones can never make the list.
  // Sorting on raw observed count alone would let those fill the cap and starve
  // the wallets that can actually qualify.
  //
  // WHAT THIS TRADES AWAY, stated plainly: a wallet outside the top 50 by
  // observation count can no longer be enriched, so it cannot pass the
  // lifetime-trades rule and cannot reach the watchlist. Since the ledger
  // collapses 3-4x per recurrence level (1466 wallets at >=1 graded buy, 9 at
  // >=3), a cap of 50 sits far above where real candidates live. Raise
  // eliteWhales.enrichShortlistCap if that stops being true.
  const cap = config.eliteWhales?.enrichShortlistCap ?? 50;
  const shortlist = capEnrichmentShortlist(eligible, cap);

  if (eligible.length > shortlist.length) {
    console.log(
      `   ↳ shortlist capped: ${eligible.length.toLocaleString()} eligible → top ${shortlist.length} by observed activity ` +
        `(${(100 - (shortlist.length / eligible.length) * 100).toFixed(1)}% of per-wallet RPC work skipped)`
    );
  }

  if (!importPath && shortlist.length) {
    const screenCache = {};
    const clean = [];
    let blocked = 0;
    for (const c of shortlist) {
      const v = await screenSystemAccount(c.address, config.rpcUrl, screenCache, config.smartMoney?.screening ?? {});
      if (v.system) { blocked++; c.systemAccount = v.reason; continue; }
      clean.push(c);
    }
    if (blocked) console.log();
    shortlist.length = 0;
    shortlist.push(...clean);
  }

  if (!importPath && shortlist.length) {
    console.log(`   ↳ enriching ${shortlist.length} shortlisted wallet(s) with on-chain activity…`);
    await enrichLifetimeTrades(shortlist, config.rpcUrl);

    // Only worth paying for when Rule 2 is actually going to read it. Under
    // profitRule 'skip' the figure is never consulted, and deriving it would
    // add ~4s per wallet for nothing.
    if (rules.profitRule !== 'skip') {
      const heliusKey = (String(config.rpcUrl ?? '').match(/api-key=([\w-]+)/) ?? [])[1] ?? null;
      console.log(`   ↳ deriving on-chain realized PnL for ${shortlist.length} wallet(s)…`);
      await enrichRealizedPnl(shortlist, {
        heliusKey,
        solUsd,
        cfg: config.eliteWhales ?? {},
      });
    }
  }

  // Anything flagged during screening cannot qualify, regardless of its stats.
  const { evaluated, qualified: ranked } = applyEliteRules(wellFormed, rules);

  // Screen ONLY the wallets that would actually be written, then backfill from
  // the next-ranked candidates.
  //
  // Screening the whole shortlist was the obvious placement and it was wrong:
  // hundreds of wallets at up to ~10s each pushed a sync past ten minutes. The
  // qualified set is topN entries, so this bounds the cost to a handful of calls
  // while still guaranteeing nothing on the final list is a pool authority.
  const screenCache = {};
  const qualified = [];
  let systemBlocked = 0;
  for (const c of ranked.length ? ranked : []) {
    if (qualified.length >= rules.topN) break;
    const v = await screenSystemAccount(
      c.address,
      config.rpcUrl,
      screenCache,
      config.smartMoney?.screening ?? {}
    );
    if (v.system) {
      systemBlocked++;
      console.log(`   🛑 ${c.address.slice(0, 12)}… rejected — ${v.reason}`);
      continue;
    }
    qualified.push(c);
  }
  if (systemBlocked) {
    console.log(
      `   ${systemBlocked} pool authority/system account(s) kept off the elite list`
    );
  }

  // ---- reporting ---------------------------------------------------
  const failing = { sample: 0, winRate: 0, netProfit: 0, trades: 0 };
  for (const c of evaluated) {
    if (!c.checks.sample) failing.sample++;
    if (!c.checks.winRate) failing.winRate++;
    if (!c.checks.netProfit) failing.netProfit++;
    if (!c.checks.trades) failing.trades++;
  }

  console.log('');
  console.log(`📊 Composite Elite Ranking — ${evaluated.length} candidate(s) evaluated`);
  // Reported first because it is the gate that actually disqualifies most
  // candidates. Leaving it out made Rule 2 look like the sole blocker while a
  // 100%-win-rate-on-one-trade population sat behind it.
  console.log(
    `   Gate 0  graded sample ≥ ${rules.minGradedBuys ?? 0}  → ${evaluated.length - failing.sample} pass` +
      (failing.sample === evaluated.length ? '   ← blocking everything' : '')
  );
  console.log(`   Rule 1  win rate ≥ ${rules.minWinRatePct}%      → ${evaluated.length - failing.winRate} pass`);
  console.log(
    rules.profitRule === 'skip'
      ? `   Rule 2  net profit          → SKIPPED (lifetime P&L is not observable; see config)`
      : `   Rule 2  net profit ≥ $${rules.minNetProfitUsd.toLocaleString('en-US')} → ${evaluated.length - failing.netProfit} pass`
  );
  // The observed PnL spread, so a floor that admits nobody is visibly a floor
  // problem rather than a mystery. Without this, "0 pass" gives no indication
  // of whether the bar is slightly high or three orders of magnitude out.
  if (rules.profitRule !== 'skip') {
    // ONLY wallets with a real on-chain derivation. Every candidate carries a
    // netProfitUsd from walletStats (an estimate from observed spend), and
    // mixing the two would report a spread across 10,000 wallets when 48 were
    // actually measured.
    const derived = evaluated
      .filter((c) => c.realizedPnl?.ok)
      .map((c) => c.netProfitUsd)
      .filter((n) => typeof n === 'number')
      .sort((a, b) => b - a);
    if (derived.length) {
      const median = derived[Math.floor(derived.length / 2)];
      const positive = derived.filter((n) => n > 0).length;
      console.log(
        `           derived PnL across ${derived.length} wallet(s): ` +
          `best ${money(derived[0])} · median ${money(median)} · worst ${money(derived[derived.length - 1])} · ` +
          `${positive} positive`
      );
      if (derived[0] < rules.minNetProfitUsd) {
        console.log(
          `           ⚠️  the best wallet is ${money(derived[0])} against a ${money(rules.minNetProfitUsd)} floor — ` +
            `no floor above ${money(derived[0])} can ever admit anyone`
        );
      }
    } else {
      console.log('           derived PnL: none available (no Helius key, or every lookup failed)');
    }
  }
  console.log(`   Rule 3  trades ≥ ${rules.minLifetimeTrades}         → ${evaluated.length - failing.trades} pass`);
  console.log(`   ✅ passing all three: ${qualified.length} (writing top ${Math.min(qualified.length, rules.topN)})`);

  for (const [i, w] of qualified.slice(0, 10).entries()) {
    console.log(
      `   ${String(i + 1).padStart(2)}. ${w.address}  ${w.winRatePct.toFixed(0)}% WR · ${money(w.netProfitUsd)} · ${w.lifetimeTrades} trades`
    );
  }

  if (reportOnly) return { qualified, evaluated, written: false };

  if (!qualified.length) {
    console.log('');
    console.log('⏭️  No wallet cleared all three rules — smart_wallets.json left untouched.');
    console.log('   The rules are strict by design; an empty elite list is correct when');
    console.log('   nothing has earned a place, and is safer than a padded one.');
    if (!importPath && failing.sample === evaluated.length) {
      const decided = maturity?.decidedTokens ?? 0;
      console.log(`   Every wallet failed the graded-sample floor of ${rules.minGradedBuys}.`);
      console.log(`   Only ${decided} token(s) in the ledger have a decided outcome, and a wallet`);
      console.log(`   cannot have more graded buys than there are decided tokens — so the floor`);
      console.log(`   is unreachable until many more tokens resolve AND the same wallets recur`);
      console.log(`   across them. Most wallets are seen exactly once.`);
      console.log('');
      console.log('   This is a long game: observe mode needs weeks of recurring traders.');
      console.log('   For a list today, import a leaderboard:');
      console.log('     node auto_top_whales.mjs --import <file.csv>');
    } else if (!importPath) {
      if (rules.profitRule !== 'skip' && failing.netProfit === evaluated.length) {
        console.log('   Rule 2 rejected every candidate. That is expected in OBSERVE mode:');
        console.log('   lifetime realized P&L cannot be derived from observation — Aegis sees');
        console.log('   a wallet\'s buys only on tokens it scanned, and never its exits.');
        console.log('   Either set eliteWhales.profitRule = "skip" to rank on win rate +');
        console.log('   lifetime activity, or import a leaderboard that carries real P&L:');
      } else {
        console.log('   OBSERVE mode needs more graded history. To seed it now,');
      }
      console.log('     node auto_top_whales.mjs --import <file.csv>');
    }
    return { qualified, evaluated, written: false };
  }

  const watchlist = buildWatchlist(qualified, { source, rules });
  if (!dryRun) {
    await writeFile(
      join(HERE, config.smartMoney.watchlistFile),
      JSON.stringify(watchlist, null, 2),
      'utf8'
    );
    console.log(`\n💾 Wrote ${qualified.length} elite wallet(s) to ${config.smartMoney.watchlistFile}`);
  } else {
    console.log('\n[DRY RUN] nothing written');
  }

  return { qualified, evaluated, written: !dryRun };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--import');
  await syncTopWhales({
    importPath: i !== -1 ? argv[i + 1] : null,
    dryRun: argv.includes('--dry-run'),
    reportOnly: argv.includes('--report'),
  });
}
