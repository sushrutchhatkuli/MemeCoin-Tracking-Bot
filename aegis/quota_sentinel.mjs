#!/usr/bin/env node
/**
 * API quota sentinel — notice when a provider key is throttled or exhausted.
 *
 *   node quota_sentinel.mjs            show recorded quota events
 *   node quota_sentinel.mjs --reset    clear the record
 *   node quota_sentinel.mjs --test     send a sample alert to Telegram
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * A throttled key does not announce itself. It degrades quietly: the whale sync
 * derived 48/48 PnL figures on one run and 22/48 an hour later purely from
 * request pacing, and the CoinGecko resolver silently recorded WIF, JUP and
 * BONK as "not a Solana token" when its lookups 429'd. In both cases the
 * pipeline kept running and produced a WORSE answer that looked exactly like a
 * normal one. That is the failure this watches for — not an outage, but a
 * quiet loss of fidelity.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN NOTES
 *
 * Recording is synchronous, cheap and never throws, because it sits inside hot
 * request paths that must not be slowed or destabilised by telemetry.
 *
 * Notification is rate-limited per provider and PERSISTED, so a throttled key
 * produces one message an hour rather than one per request — a quota alert that
 * arrives four hundred times is indistinguishable from spam and will be muted,
 * which defeats the point of sending it.
 *
 * telegram.mjs is imported LAZILY. sources.mjs records events and telegram.mjs
 * imports sources.mjs, so a module-level import here would close a cycle.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const QUOTA_STATE_PATH = join(HERE, '.state', 'quota_sentinel.json');

/** Bodies that mean "you are out of quota" rather than "slow down". */
const EXHAUSTED_PATTERNS = [
  /max usage reached/i,
  /credit limit/i,
  /quota (exceeded|reached)/i,
  /insufficient credits/i,
  /plan limit/i,
];

const RATE_LIMIT_PATTERNS = [/rate limit/i, /too many requests/i, /throttl/i];

/**
 * Classify a provider response.
 *
 * EXHAUSTED and THROTTLED are different problems with different fixes — a new
 * key versus slower pacing — so they are not collapsed into one label. A 429
 * with an exhaustion body is exhaustion; a bare 429 is throttling.
 */
export function classifyQuotaResponse({ status, body = '' }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  if (EXHAUSTED_PATTERNS.some((re) => re.test(text))) return 'EXHAUSTED';
  if (status === 429) return RATE_LIMIT_PATTERNS.some((re) => re.test(text)) ? 'EXHAUSTED' : 'THROTTLED';
  if (status === 402) return 'EXHAUSTED';
  return null;
}

// In-memory tally for the current process. Flushed to disk by maybeNotify.
const events = new Map();

/**
 * Record one throttle/exhaustion observation. Never throws, never awaits.
 */
export function recordQuotaEvent({ provider, status, body = '' }) {
  const kind = classifyQuotaResponse({ status, body });
  if (!kind) return null;

  const e = events.get(provider) ?? { provider, throttled: 0, exhausted: 0, lastStatus: null, firstAt: Date.now() };
  if (kind === 'EXHAUSTED') e.exhausted++;
  else e.throttled++;
  e.lastStatus = status ?? null;
  e.lastAt = Date.now();
  events.set(provider, e);
  return kind;
}

export function currentQuotaEvents() {
  return [...events.values()];
}

async function loadState(path = QUOTA_STATE_PATH) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { notified: {}, history: [] };
  }
}

async function saveState(state, path = QUOTA_STATE_PATH) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* telemetry must never break a scan */
  }
}

const LABEL = {
  helius: 'Helius RPC',
  coingecko: 'CoinGecko',
  rugcheck: 'RugCheck',
  dexscreener: 'DexScreener',
};

export function buildQuotaMessage(event) {
  const name = LABEL[event.provider] ?? event.provider;
  const exhausted = event.exhausted > 0;
  return [
    `⚠️ <b>AEGIS API QUOTA WARNING: ${name} Key Quota Reached!</b>`,
    '',
    `• Action: Please add a fresh free key to <code>aegis/.env</code>!`,
    '',
    `• Observed: ${event.exhausted} quota rejection(s), ${event.throttled} rate-limit(s)` +
      (event.lastStatus ? ` (last HTTP ${event.lastStatus})` : ''),
    '',
    exhausted
      ? '<i>The key is out of quota. Aegis keeps running, but the affected data degrades silently — throttled lookups are recorded as "not found", which reads the same as a real negative. Treat results from this provider as incomplete until the key is replaced.</i>'
      : '<i>The key is being rate-limited, not exhausted. This usually means pacing rather than quota; if it persists, lower the relevant concurrency or delay setting before replacing the key.</i>',
  ].join('\n');
}

/**
 * Send at most one alert per provider per cooldown window.
 *
 * The cooldown is persisted because every `node scan.mjs` is a fresh process —
 * an in-memory guard would let a throttled key alert on every single run.
 */
export async function maybeNotifyQuota({ config = {}, now = Date.now(), send = null } = {}) {
  const cfg = config.quotaSentinel ?? {};
  if (cfg.enabled === false || !events.size) return { sent: [], suppressed: [] };

  const cooldownMs = (cfg.cooldownMinutes ?? 60) * 60_000;
  const minEvents = cfg.minEventsToAlert ?? 3;
  const state = await loadState();
  const sent = [];
  const suppressed = [];

  for (const e of events.values()) {
    const total = e.exhausted + e.throttled;
    // A single 429 is normal backpressure and self-corrects; alerting on it
    // would train the alert to be ignored.
    if (total < minEvents && !e.exhausted) {
      suppressed.push({ provider: e.provider, reason: 'below event floor' });
      continue;
    }
    const last = state.notified?.[e.provider] ?? 0;
    if (now - last < cooldownMs) {
      suppressed.push({ provider: e.provider, reason: 'cooldown' });
      continue;
    }

    const text = buildQuotaMessage(e);
    let ok = false;
    if (send) {
      ok = (await send(text))?.ok ?? false;
    } else {
      // Lazy import: sources.mjs records events and telegram.mjs imports
      // sources.mjs, so importing it at module scope would close a cycle.
      const { loadEnv, sendTelegram } = await import('./telegram.mjs');
      const creds = await loadEnv(join(HERE, '.env'));
      if (creds.botToken && creds.chatId) ok = (await sendTelegram({ ...creds, text })).ok;
    }

    if (ok) {
      state.notified = { ...(state.notified ?? {}), [e.provider]: now };
      state.history = [...(state.history ?? []).slice(-40), { ...e, notifiedAt: now }];
      sent.push(e.provider);
    }
  }

  if (sent.length) await saveState(state);
  events.clear();
  return { sent, suppressed };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);

  if (argv.includes('--reset')) {
    await saveState({ notified: {}, history: [] });
    console.log('Quota sentinel state cleared.');
    process.exit(0);
  }

  if (argv.includes('--test')) {
    recordQuotaEvent({ provider: 'coingecko', status: 429, body: 'max usage reached' });
    const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
    // Force past the cooldown for a deliberate test.
    await saveState({ notified: {}, history: [] });
    const res = await maybeNotifyQuota({ config });
    console.log(res.sent.length ? `✅ Sent quota alert for: ${res.sent.join(', ')}` : '❌ Nothing sent (check Telegram credentials)');
    process.exit(0);
  }

  const state = await loadState();
  console.log('Last notification per provider:');
  const entries = Object.entries(state.notified ?? {});
  if (!entries.length) console.log('  (none recorded)');
  for (const [p, at] of entries) {
    console.log(`  ${String(LABEL[p] ?? p).padEnd(14)} ${((Date.now() - at) / 60000).toFixed(0)} min ago`);
  }
  console.log(`\nHistory entries: ${(state.history ?? []).length}`);
  process.exit(0);
}
