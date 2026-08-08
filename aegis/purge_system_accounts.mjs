#!/usr/bin/env node
/**
 * Purge system accounts from the observation ledger.
 *
 *   node purge_system_accounts.mjs            report only
 *   node purge_system_accounts.mjs --apply    remove confirmed system accounts
 *   node purge_system_accounts.mjs --breadth 15
 *
 * ── WHY BREADTH IS A TRIGGER AND NOT A VERDICT ──────────────────────────────
 * A DEX pool authority receives tokens from nearly every trade routed through
 * it, so it appears on far more distinct tokens than a human trader. That makes
 * breadth a useful way to decide WHO to check.
 *
 * It is not a way to decide WHAT they are. Measured on a real ledger, of the six
 * highest-breadth wallets only ONE was a system account:
 *
 *   8psNvW… 171 tokens → 574,826 token accounts   → authority
 *   2tgUbS… 146 tokens →     755 token accounts   → real trader
 *   86ugEi… 108 tokens →       2 token accounts   → real trader
 *   GVVP8N…  72 tokens →      13 token accounts   → real trader
 *   ssssss…  57 tokens →       1 token account    → real trader
 *   7DyzpB…  51 tokens →     117 token accounts   → real trader
 *
 * Purging on breadth alone would have deleted five legitimate high-frequency
 * traders — exactly the wallets this system exists to find. So breadth only
 * selects candidates; the RPC screen decides, and every removal is logged with
 * the measurement that justified it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { loadObservations, saveObservations } from './wallet_observations.mjs';
import { screenSystemAccount, SYSTEM_ACCOUNTS } from './smart_money.mjs';
import { loadEnv } from './telegram.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const bi = argv.indexOf('--breadth');
const breadthTrigger = bi !== -1 ? Number(argv[bi + 1]) : 10;

const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
const env = await loadEnv(join(HERE, '.env'));
const rpcUrl = env.rpcOverride ?? config.rpcUrl;

const cachePath = join(HERE, '.state', 'system_account_cache.json');
let cache = {};
try {
  cache = JSON.parse(await readFile(cachePath, 'utf8'));
} catch {
  /* first run */
}

const obsPath = join(HERE, '.state', 'wallet_observations.json');
const store = await loadObservations(obsPath);

const wallets = Object.entries(store.wallets).map(([w, e]) => ({
  wallet: w,
  tokens: new Set((e.buys ?? []).map((b) => b.token)).size,
  buys: (e.buys ?? []).length,
}));

// Anything already KNOWN to be a system account goes regardless of breadth —
// both the static list and any cached verdict from a previous screen.
//
// The cached half matters: a pool authority can sit below the breadth trigger
// and still be a pool authority. One did exactly that (68,017 token accounts,
// under 20 distinct tokens) and survived the first purge because only breadth
// selected candidates. Cached verdicts are free to apply, so there is no reason
// to make them wait for a breadth threshold.
const alreadyKnown = (w) => SYSTEM_ACCOUNTS.has(w) || cache[w]?.system === true;

const knownSystem = wallets.filter((w) => alreadyKnown(w.wallet));
const candidates = wallets
  .filter((w) => !alreadyKnown(w.wallet) && w.tokens >= breadthTrigger)
  .sort((a, b) => b.tokens - a.tokens);

console.log(`Ledger: ${wallets.length} wallets`);
console.log(`Already known as system (static list + cache) : ${knownSystem.length}`);
console.log(`Breadth >= ${breadthTrigger} tokens (to verify) : ${candidates.length}`);
console.log('');

const confirmed = [
  ...knownSystem.map((w) => ({
    ...w,
    reason: SYSTEM_ACCOUNTS.get(w.wallet) ?? cache[w.wallet]?.reason ?? 'known system account',
  })),
];
let checked = 0;

for (const c of candidates) {
  const v = await screenSystemAccount(c.wallet, rpcUrl, cache, config.smartMoney?.screening ?? {});
  checked++;
  if (v.system) {
    confirmed.push({ ...c, reason: v.reason });
    console.log(`🛑 ${c.wallet.slice(0, 14)}… (${c.tokens} tokens) — ${v.reason}`);
  } else {
    console.log(
      `✅ ${c.wallet.slice(0, 14)}… (${c.tokens} tokens) — real trader, ${v.tokenAccounts ?? '?'} token accounts`
    );
  }
  await new Promise((r) => setTimeout(r, 150));
}

console.log('');
console.log(`Verified ${checked} candidate(s); ${confirmed.length} confirmed system account(s).`);

if (!apply) {
  console.log('Report only — re-run with --apply to remove them.');
  process.exit(0);
}

let removedBuys = 0;
for (const c of confirmed) {
  removedBuys += store.wallets[c.wallet]?.buys?.length ?? 0;
  delete store.wallets[c.wallet];
}
await saveObservations(obsPath, store);
await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');

console.log(
  `✅ Removed ${confirmed.length} wallet(s) and ${removedBuys} observation(s). ` +
    `Ledger now ${Object.keys(store.wallets).length} wallets.`
);
