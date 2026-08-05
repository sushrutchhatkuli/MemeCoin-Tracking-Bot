#!/usr/bin/env node
/**
 * Backfill trade links in existing vault notes.
 *
 *   node fix-trade-links.mjs            dry run — report only, changes nothing
 *   node fix-trade-links.mjs --apply    rewrite the notes
 *
 * Replaces the dead `https://fomo.app/trade/{address}` (fomo.app is the Android
 * package id, not a domain — it never resolved) with the working
 * `https://fomo.family/tokens/{chain}/{address}` route.
 *
 * Chain is read from each note's own YAML frontmatter rather than assumed, so
 * Base/BSC/Ethereum notes get the right path segment instead of being forced to
 * solana. A backup copy is written before the first edit unless --no-backup.
 */

import { readFile, writeFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes('--apply');
const noBackup = process.argv.includes('--no-backup');

const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
const notesDir = join(resolve(HERE, config.vaultPath), config.notesFolder);
const template = config.tradeLinkTemplate;
const label = config.tradeLinkLabel;

// Frontmatter `chain:` uses display names; the URL wants dexscreener chain ids.
const CHAIN_SLUG = {
  Solana: 'solana',
  Base: 'base',
  Ethereum: 'ethereum',
  BNB: 'bsc',
  BSC: 'bsc',
  Arbitrum: 'arbitrum',
  Polygon: 'polygon',
};

// Two legacy formats to normalise:
//   fomo.app/trade/{addr}  — never resolved (fomo.app is an Android package id)
//   jup.ag/swap/SOL-{addr} — the interim stand-in used before the real FOMO
//                            share route was known
const LEGACY_LINKS = [
  /https:\/\/fomo\.app\/trade\/([A-Za-z0-9]+)/g,
  /https:\/\/jup\.ag\/swap\/SOL-([A-Za-z0-9]+)/g,
];
const LEGACY_LABELS = /\[(?:Trade on FOMO App|Trade on Jupiter)\]/g;

const files = (await readdir(notesDir)).filter((f) => f.endsWith('.md'));
console.log(`${apply ? '✏️  APPLYING' : '🔍 DRY RUN'} — ${files.length} notes in ${notesDir}\n`);

let touched = 0;
let replacements = 0;
let skippedNoChain = 0;
const byChain = new Map();
let backupDir = null;

for (const file of files) {
  const path = join(notesDir, file);
  const original = await readFile(path, 'utf8');
  if (!original.includes('fomo.app/trade/') && !original.includes('jup.ag/swap/')) continue;

  const chainName = original.match(/^chain:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
  const slug = CHAIN_SLUG[chainName];
  if (!slug) {
    // Never guess the chain — a wrong slug produces a link that looks valid and
    // silently points at the wrong token.
    console.log(`  ⚠️  ${file}: unrecognised chain "${chainName ?? '(none)'}" — skipped`);
    skippedNoChain++;
    continue;
  }

  let count = 0;
  let updated = original;
  for (const pattern of LEGACY_LINKS) {
    updated = updated.replace(pattern, (_m, address) => {
      count++;
      return template.replace('{chain}', slug).replace('{address}', address);
    });
  }
  updated = updated.replace(LEGACY_LABELS, `[${label}]`);

  if (updated === original) continue;

  byChain.set(slug, (byChain.get(slug) ?? 0) + 1);
  touched++;
  replacements += count;

  if (apply) {
    if (!noBackup && !backupDir) {
      backupDir = join(HERE, '.state', `notes-backup-${Date.now()}`);
      await mkdir(backupDir, { recursive: true });
      console.log(`📦 Backing up originals to ${backupDir}\n`);
    }
    if (backupDir) await copyFile(path, join(backupDir, file));
    await writeFile(path, updated, 'utf8');
  }
}

console.log(`\n${'─'.repeat(58)}`);
console.log(`notes containing the dead link : ${touched}`);
console.log(`individual URLs replaced       : ${replacements}`);
for (const [slug, n] of [...byChain].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${slug.padEnd(10)} ${n} note(s)`);
}
if (skippedNoChain) console.log(`skipped (unknown chain)        : ${skippedNoChain}`);
console.log(`new link format                : ${template}`);
if (!apply) console.log(`\nNothing was modified. Re-run with --apply to write the changes.`);
else console.log(`\n✅ Done.${backupDir ? ` Originals preserved in ${backupDir}` : ''}`);
