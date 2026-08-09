#!/usr/bin/env node
/**
 * Social Media & Search Spike Tracker.
 *
 *   node social_tracer.mjs           show what is trending and which are Solana
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS REACHABLE, measured:
 *
 *   CoinGecko /search/trending      200 ✅  open, no key, 15 coins
 *   CoinGecko /coins/{id}           200 ✅  open, gives per-chain contracts
 *   Twitter/X API v2                401 ❌  paid bearer token required
 *
 * So SEARCH SPIKE is real and MENTION VELOCITY is not. Twitter support is
 * written and stays inert until TWITTER_BEARER_TOKEN is set; without it the
 * tracker reports search trend only and says so rather than implying it has
 * social data it does not have.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY MATCHING IS ON CONTRACT ADDRESS, NOT TICKER.
 *
 * CoinGecko's trending payload carries name and symbol but no contract. The
 * obvious implementation — match the scanned token's symbol against a trending
 * symbol — creates the exact attack it is supposed to reward: mint a token
 * called PENGU while PENGU is trending, collect +20 points, sell into whoever
 * the alert reaches. Ticker namespace on Solana is unrestricted and
 * impersonation is the default behaviour, not an edge case.
 *
 * So each trending id is resolved through /coins/{id} to its platforms map,
 * and the match is against `platforms.solana` — the real mint. A token that is
 * genuinely trending matches; a copy wearing its name does not. Symbol
 * matching exists behind `allowSymbolMatch` for anyone who wants it, off by
 * default, and the alert says which kind of match it was.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { recordQuotaEvent } from './quota_sentinel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CG = 'https://api.coingecko.com/api/v3';
export const SOCIAL_CACHE_PATH = join(HERE, '.state', 'social_cache.json');

/* ------------------------------------------------------------------ *
 * Trending, with address resolution
 * ------------------------------------------------------------------ */

const cache = { trending: null, fetchedAt: 0 };

/**
 * Disk-backed cache.
 *
 * The in-memory cache alone only ever helped loop.mjs, which is long-lived.
 * Every `node scan.mjs` and `node index.mjs` run is a FRESH PROCESS and started
 * cold, paying the full trending resolution — measured at ~90s, the majority of
 * a 138s one-shot scan. Persisting it means the cost is paid once per TTL
 * across every entry point rather than once per process.
 *
 * solanaMints is a Map, which JSON cannot represent, so it is stored as entries
 * and rehydrated on load. A cache that silently deserialised to `{}` would look
 * exactly like "nothing is trending" — which is a different and wrong claim.
 */
async function loadDiskCache(path = SOCIAL_CACHE_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (!raw?.fetchedAt || !Array.isArray(raw.coins)) return null;
    return {
      ok: true,
      coins: raw.coins,
      solanaMints: new Map(raw.solanaMints ?? []),
      resolved: raw.resolved ?? 0,
      failed: raw.failed ?? 0,
      fetchedAt: raw.fetchedAt,
    };
  } catch {
    return null;
  }
}

async function saveDiskCache(payload, path = SOCIAL_CACHE_PATH) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify(
        {
          fetchedAt: payload.fetchedAt,
          coins: payload.coins,
          solanaMints: [...payload.solanaMints.entries()],
          resolved: payload.resolved,
          failed: payload.failed,
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {
    /* a cache that cannot be written is a slow scan, not a broken one */
  }
}

/**
 * CoinGecko GET, with optional demo-key auth.
 *
 * The keyless public tier is tight enough to matter: measured at a 6s gap with
 * one retry, 6 of 15 contract lookups still came back 429, and WIF and JUP —
 * both genuinely Solana — were among the casualties. A partial trending set is
 * a silent failure, because a missed match is indistinguishable from no match.
 *
 * A free demo key from coingecko.com/en/developers/dashboard raises the limit
 * substantially. Set COINGECKO_API_KEY in .env; without it this still works,
 * just with gaps that the CLI reports honestly.
 */
async function getJson(url, timeoutMs, apiKey = null) {
  const headers = { accept: 'application/json', 'user-agent': 'aegis-social-tracer/1.0' };
  if (apiKey) headers['x-cg-demo-api-key'] = apiKey;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
  if (!res.ok) {
    // The body is read only on failure. A CoinGecko 429 sometimes carries a
    // quota message, which is what distinguishes "slow down" from "this key is
    // finished" — two problems with different fixes.
    const body = await res.text().catch(() => '');
    recordQuotaEvent({ provider: 'coingecko', status: res.status, body });
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch trending searches and resolve each to its Solana mint where one exists.
 *
 * Cached, because trending moves on the order of hours while the scanner runs
 * every 30 seconds — and because resolution costs one call per coin against a
 * free tier that rate-limits aggressively. A stale-but-present cache is served
 * on failure rather than reporting "nothing is trending", which would be a
 * different and wrong claim.
 */
/**
 * COINGECKO_API_KEY, read directly rather than via telegram.mjs's loadEnv.
 *
 * Kept self-contained so the key is picked up however this module is reached —
 * scan.mjs passes it explicitly, but the CLI, a test, or any future caller
 * should not have to know to thread it through for the rate limit to lift.
 * process.env wins, matching loadEnv's precedence.
 */
async function resolveApiKey(explicit) {
  if (explicit) return explicit;
  if (process.env.COINGECKO_API_KEY) return process.env.COINGECKO_API_KEY;
  try {
    const raw = await readFile(join(HERE, '.env'), 'utf8');
    const m = raw.match(/^\s*COINGECKO_API_KEY\s*=\s*(.+)\s*$/m);
    const v = m?.[1]?.trim().replace(/^["']|["']$/g, '');
    return v || null;
  } catch {
    return null;
  }
}

export async function fetchTrending({ config = {}, now = Date.now(), force = false, apiKey: rawKey = null } = {}) {
  const cfg = config.socialTracer ?? {};
  const apiKey = await resolveApiKey(rawKey);
  const ttlMs = (cfg.cacheMinutes ?? 15) * 60_000;
  const timeoutMs = cfg.timeoutMs ?? 12000;

  if (!force && cache.trending && now - cache.fetchedAt < ttlMs) {
    return { ...cache.trending, cached: true, cacheSource: 'memory' };
  }

  // Disk before network. This is the whole point of persisting: a one-shot
  // `node scan.mjs` has an empty in-memory cache but the file on disk may be
  // seconds old, and re-resolving 15 contracts to rediscover that costs ~90s.
  if (!force) {
    const disk = await loadDiskCache();
    if (disk && now - disk.fetchedAt < ttlMs) {
      cache.trending = disk;
      cache.fetchedAt = disk.fetchedAt;
      return { ...disk, cached: true, cacheSource: 'disk' };
    }
  }

  let coins;
  try {
    const body = await getJson(`${CG}/search/trending`, timeoutMs, apiKey);
    coins = (body.coins ?? []).map((c) => c.item).filter(Boolean);
  } catch (err) {
    if (cache.trending) return { ...cache.trending, cached: true, staleError: err.message };
    return { ok: false, error: err.message, coins: [], solanaMints: new Map(), fetchedAt: now };
  }

  // Resolve contracts. Sequential with a delay — CoinGecko's free tier rejects
  // bursts, and a 429 here would poison the whole trending set.
  const solanaMints = new Map();
  const resolveLimit = cfg.resolveLimit ?? 15;

  // The 6s gap exists purely to survive the KEYLESS tier, where a 2.2s gap lost
  // 10 of 15 lookups to 429s. A demo key raises the limit enough that the wait
  // is no longer buying anything, so pacing follows whether a key is present:
  // 15 lookups at 6s is ~90s, at 1s it is ~15s.
  const delayMs = apiKey
    ? (cfg.resolveDelayMsWithKey ?? 1000)
    : (cfg.resolveDelayMs ?? 6000);
  let resolved = 0;
  let failed = 0;

  // Retry once on failure. Measured: at a 2.2s gap, 10 of 15 lookups came back
  // 429 and WIF, JUP and BONK — all genuinely Solana — were recorded as "not a
  // Solana token". A partial trending set is worse than a slow one, because a
  // real match silently reads as no match.
  for (const coin of coins.slice(0, resolveLimit)) {
    let got = null;
    for (let attempt = 0; attempt < 2 && got === null; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, delayMs * 2));
      try {
        got = await getJson(
          `${CG}/coins/${encodeURIComponent(coin.id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`,
          timeoutMs,
          apiKey
        );
      } catch {
        /* retry once, then count it as a failure */
      }
    }

    if (got === null) {
      failed++;
    } else {
      const mint = got.platforms?.solana;
      if (mint) solanaMints.set(String(mint).toLowerCase(), { id: coin.id, name: coin.name, symbol: coin.symbol });
      resolved++;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }

  const out = { ok: true, coins, solanaMints, resolved, failed, fetchedAt: now, cached: false };
  cache.trending = out;
  cache.fetchedAt = now;
  await saveDiskCache(out);
  return out;
}

/* ------------------------------------------------------------------ *
 * Twitter / X — inert without a paid bearer token
 * ------------------------------------------------------------------ */

/**
 * Recent-mention count for a symbol.
 *
 * Returns available:false when no bearer token is configured, which is the
 * normal case: the v2 recent-search endpoint answers 401 without one, and the
 * tier that grants it is paid. Never fabricates a count — an absent number and
 * a zero mean opposite things here.
 */
export async function fetchMentionVelocity({ symbol, bearerToken = null, timeoutMs = 12000 }) {
  if (!bearerToken) {
    return { available: false, reason: 'TWITTER_BEARER_TOKEN not set (v2 search is 401 without one)' };
  }
  try {
    const q = encodeURIComponent(`${symbol} -is:retweet`);
    const res = await fetch(
      `https://api.twitter.com/2/tweets/counts/recent?query=${q}&granularity=hour`,
      { headers: { authorization: `Bearer ${bearerToken}` }, signal: AbortSignal.timeout(timeoutMs) }
    );
    if (!res.ok) return { available: false, reason: `HTTP ${res.status}` };
    const body = await res.json();
    const buckets = body.data ?? [];
    const total = buckets.reduce((s, b) => s + (b.tweet_count ?? 0), 0);
    const lastHour = buckets.length ? buckets[buckets.length - 1].tweet_count ?? 0 : 0;
    const mean = buckets.length ? total / buckets.length : 0;
    return {
      available: true,
      total,
      lastHour,
      // Velocity as a multiple of this symbol's own recent baseline, so a
      // quiet ticker spiking counts and a permanently loud one does not.
      velocity: mean > 0 ? lastHour / mean : null,
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

/**
 * Social hype boost for a scanned token.
 *
 * Address match by default (see the header note on ticker impersonation).
 * The boost is additive and — like every other bonus in this engine — is
 * forfeited by the caller on any safety-gate failure, so viral attention can
 * never launder a token that failed its audit.
 */
export function scoreSocialHype({ pair, trending, mentions = null, config = {} }) {
  const cfg = config.socialTracer ?? {};
  if (cfg.enabled === false) return { detected: false, scoreBoost: 0, reasons: [] };

  const mint = String(pair?.baseToken?.address ?? '').toLowerCase();
  const symbol = String(pair?.baseToken?.symbol ?? '').toLowerCase();
  if (!mint) return { detected: false, scoreBoost: 0, reasons: [] };

  const byAddress = trending?.solanaMints?.get(mint) ?? null;

  let bySymbol = null;
  if (!byAddress && cfg.allowSymbolMatch === true && symbol) {
    const hit = (trending?.coins ?? []).find((c) => String(c.symbol ?? '').toLowerCase() === symbol);
    if (hit) bySymbol = hit;
  }

  const velocityHit =
    mentions?.available === true &&
    mentions.velocity !== null &&
    mentions.velocity >= (cfg.minMentionVelocity ?? 3);

  const detected = Boolean(byAddress || bySymbol || velocityHit);
  const reasons = [];
  if (byAddress) reasons.push(`Trending on CoinGecko search as ${byAddress.name} (contract verified)`);
  if (bySymbol) reasons.push(`Ticker matches trending ${bySymbol.name} — SYMBOL ONLY, contract not verified`);
  if (velocityHit) reasons.push(`X mentions ${mentions.velocity.toFixed(1)}x their recent hourly baseline`);

  return {
    detected,
    scoreBoost: detected ? (cfg.scoreBoost ?? 20) : 0,
    matchType: byAddress ? 'contract' : bySymbol ? 'symbol' : velocityHit ? 'mentions' : null,
    reasons,
    mentionsAvailable: mentions?.available ?? false,
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  const { loadEnv } = await import('./telegram.mjs');
  const env = await loadEnv(join(HERE, '.env'));

  console.log('Fetching CoinGecko trending and resolving contracts…\n');
  const t = await fetchTrending({ config, force: true, apiKey: env.coingeckoKey });
  if (!t.ok) {
    console.error(`❌ trending unavailable: ${t.error}`);
    process.exit(1);
  }

  for (const c of t.coins) {
    const mint = [...t.solanaMints.entries()].find(([, v]) => v.id === c.id)?.[0];
    console.log(
      `  ${String(c.symbol).toUpperCase().padEnd(12)} ${String(c.name).slice(0, 26).padEnd(28)} ` +
        (mint ? `solana: ${mint}` : 'not a Solana token')
    );
  }
  console.log(`\n${t.solanaMints.size} of ${t.coins.length} trending coin(s) have a Solana contract (${t.failed} lookup failure(s)).`);

  const m = await fetchMentionVelocity({ symbol: 'SOL', bearerToken: env.twitterBearer });
  console.log(`\nX mention velocity: ${m.available ? `${m.velocity?.toFixed(2)}x` : `unavailable — ${m.reason}`}`);
}
