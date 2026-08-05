/**
 * Permanent deployer / mint blacklist.
 *
 * Deliberately keeps deployer wallets and token mints in separate lists: they
 * are different kinds of address and matching one against the other silently
 * never fires, which is worse than having no blacklist because it reads as
 * protection.
 */

import { readFile, writeFile } from 'node:fs/promises';

export async function loadBlacklist(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const norm = (list) =>
      (list ?? [])
        .map((e) => (typeof e === 'string' ? { address: e } : e))
        .filter((e) => e?.address);

    const wallets = norm(raw.wallets);
    const mints = norm(raw.mints);
    return {
      path,
      raw,
      wallets: new Map(wallets.map((w) => [w.address, w])),
      mints: new Map(mints.map((m) => [m.address, m])),
      count: wallets.length + mints.length,
    };
  } catch {
    return { path, raw: { wallets: [], mints: [] }, wallets: new Map(), mints: new Map(), count: 0 };
  }
}

/** @returns {{listed: boolean, kind?: 'deployer'|'mint', entry?: object}} */
export function checkBlacklist(blacklist, { mint, deployer }) {
  if (mint && blacklist.mints.has(mint)) {
    return { listed: true, kind: 'mint', entry: blacklist.mints.get(mint) };
  }
  if (deployer && blacklist.wallets.has(deployer)) {
    return { listed: true, kind: 'deployer', entry: blacklist.wallets.get(deployer) };
  }
  return { listed: false };
}

/** Append a deployer wallet, skipping duplicates. Returns true if added. */
export async function blacklistDeployer(blacklist, { address, reason, source = 'post-mortem' }) {
  if (!address || blacklist.wallets.has(address)) return false;

  const entry = {
    address,
    reason,
    added: new Date().toISOString().slice(0, 10),
    source,
  };
  blacklist.wallets.set(address, entry);
  blacklist.raw.wallets = [...(blacklist.raw.wallets ?? []), entry];
  await writeFile(blacklist.path, JSON.stringify(blacklist.raw, null, 2), 'utf8');
  return true;
}
