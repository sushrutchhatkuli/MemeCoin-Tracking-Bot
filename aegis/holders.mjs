#!/usr/bin/env node
/**
 * Holder-distribution calibration tool.
 *
 *   node holders.mjs <mint>
 *
 * Prints every plausible reading of "top 10 holder concentration" side by side
 * so a figure shown in another tracker (FOMO App, Solscan, Birdeye) can be
 * matched to a definition rather than guessed at.
 *
 * Use it like this: open the token in FOMO App, read its percentage, then find
 * the row below that matches. That tells us which convention to adopt — the
 * ambiguity is in the definition, not in the data.
 */

import { fetchSolanaSecurity, fetchSinglePair, computeHolderDistribution, NON_HOLDER_ADDRESSES } from './sources.mjs';

const mint = process.argv[2];
if (!mint) {
  console.error('Usage: node holders.mjs <mint-address>');
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const pct = (v) => (v === null || v === undefined ? '     n/a' : `${v.toFixed(2)}%`.padStart(8));
const num = (v) => (v === null || v === undefined ? 'n/a' : Math.round(v).toLocaleString('en-US'));

const [security, pair] = await Promise.all([fetchSolanaSecurity(mint), fetchSinglePair(mint)]);

if (!security.ok) {
  console.error(`Could not load holder data: ${security.error}`);
  process.exit(1);
}

const dist = security.distribution;
if (!dist) {
  console.error('No holder distribution available for this mint.');
  process.exit(1);
}

console.log(`\n═══ Holder distribution — ${pair?.baseToken?.symbol ?? mint.slice(0, 8)} ═══`);
console.log(`mint            ${mint}`);
console.log(`total supply    ${num(dist.totalSupply)}`);
console.log(`LP + excluded   ${num(dist.excludedAmount)}  (${pct(dist.excludedPct).trim()} of total)`);
console.log(`circulating     ${num(dist.circulatingSupply)}`);
console.log(`ranked wallets  ${dist.holderCountRanked}`);

console.log(`\n─── "Top 10 hold …" under each convention ───`);
console.log(`  ${pad('definition', 46)} value`);
console.log(`  ${pad('-'.repeat(46), 46)} --------`);
console.log(`  ${pad('top 10 wallets / TOTAL supply', 46)}${pct(dist.topNPct)}   <- Aegis headline`);
console.log(`  ${pad('top 10 wallets / CIRCULATING (total - LP)', 46)}${pct(dist.topNPctCirculating)}`);

// Un-aggregated, unfiltered: every token account ranked on its own, LP included.
// Some trackers report this; it inflates the figure when the pool is top-ranked.
const rawIncludingLp = computeHolderDistribution({
  holders: (security.rawHolders ?? []).map((h) => ({ ...h, owner: h.address })),
  totalSupply: dist.totalSupply,
  excludedAddresses: new Set(),
  topN: 10,
});
console.log(`  ${pad('top 10 token ACCOUNTS / total (LP included)', 46)}${pct(rawIncludingLp.topNPct)}`);

// Wallet-level but without removing the pool — isolates the effect of LP filtering.
const walletsIncludingLp = computeHolderDistribution({
  holders: security.rawHolders ?? [],
  totalSupply: dist.totalSupply,
  excludedAddresses: new Set(),
  topN: 10,
});
console.log(`  ${pad('top 10 wallets / total (LP included)', 46)}${pct(walletsIncludingLp.topNPct)}`);

console.log(`\n─── Top 10 wallets ───`);
for (const [i, h] of dist.topHolders.entries()) {
  console.log(
    `  ${String(i + 1).padStart(2)}. ${pad(h.owner, 44)} ${pct(h.pct)} of total  ${pct(h.pctCirculating)} of circ` +
      `${h.accounts > 1 ? `  (${h.accounts} accounts merged)` : ''}${h.insider ? '  insider' : ''}`
  );
}

console.log(`\n─── Reconciling with another tracker ───`);
console.log('  If the figure you see elsewhere matches one of the rows above, tell me');
console.log('  which one and I will make it the headline. If it matches none of them,');
console.log('  that tracker is using a different holder set (e.g. excluding the dev or');
console.log('  team wallet, or reading a snapshot from a different block).');
console.log(`  Excluded as non-holder addresses: ${[...NON_HOLDER_ADDRESSES].length} known burn/system addresses.\n`);
