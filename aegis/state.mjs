/**
 * Snapshot store.
 *
 * Holder growth velocity cannot be derived from a single API call — it needs a
 * prior observation. Each scan records holder count / market cap per token so
 * the next scan can compute a real delta instead of guessing.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function loadState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Compare the current observation against the last one for this token.
 * Returns null on first sighting (no baseline to measure against).
 */
export function computeVelocity(state, key, current) {
  const prev = state[key];
  if (!prev || prev.holders === null || current.holders === null) return null;

  const minutes = Math.round((current.timestamp - prev.timestamp) / 60000);
  if (minutes < 1) return null;

  return {
    minutes,
    newHolders: current.holders - prev.holders,
    holdersPerHour: Math.round(((current.holders - prev.holders) / minutes) * 60),
    mcapChangePct:
      prev.marketCap > 0
        ? ((current.marketCap - prev.marketCap) / prev.marketCap) * 100
        : null,
  };
}

const HISTORY_MAX_ENTRIES = 40;
const HISTORY_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * Record the current observation, keeping a bounded history alongside it.
 *
 * The history exists for post-mortem analysis: judging whether a token rugged
 * needs the market cap AS IT WAS when the token was scanned, and a single
 * overwritten snapshot cannot provide that. Entries are capped by both count
 * and age so the state file does not grow without limit.
 */
export function recordSnapshot(state, key, current) {
  const prior = state[key];
  const history = [...(prior?.history ?? [])];

  history.push({
    t: current.timestamp,
    mc: current.marketCap,
    holders: current.holders,
    price: current.price ?? null,
  });

  const floor = current.timestamp - HISTORY_MAX_AGE_MS;
  const trimmed = history.filter((h) => h.t >= floor).slice(-HISTORY_MAX_ENTRIES);

  state[key] = {
    holders: current.holders,
    marketCap: current.marketCap,
    timestamp: current.timestamp,
    symbol: current.symbol,
    price: current.price ?? null,
    chain: current.chain ?? prior?.chain ?? null,
    address: current.address ?? prior?.address ?? null,
    deployer: current.deployer ?? prior?.deployer ?? null,
    firstSeen: prior?.firstSeen ?? current.timestamp,
    history: trimmed,
  };
}

/**
 * Oldest observation inside [minAgeMs, maxAgeMs] — the baseline a post-mortem
 * measures against. Returns null when the token has not been tracked long
 * enough, which must be treated as "too early to judge", not as a pass.
 */
export function baselineWithin(entry, now, minAgeMs, maxAgeMs) {
  const candidates = (entry?.history ?? []).filter((h) => {
    const age = now - h.t;
    return age >= minAgeMs && age <= maxAgeMs;
  });
  if (!candidates.length) return null;
  return candidates.reduce((oldest, h) => (h.t < oldest.t ? h : oldest));
}
