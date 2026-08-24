#!/usr/bin/env node
/**
 * Telegram call-channel review — what did this channel's calls actually do?
 *
 *   node aegis/review_channel.mjs --channel TcalledPresence
 *   node aegis/review_channel.mjs --export "C:/path/ChatExport/result.json"
 *   node aegis/review_channel.mjs --export result.json --dry-run
 *   node aegis/review_channel.mjs --export result.json --limit 50
 *
 * Reads a channel's message history (live over MTProto, or from a Telegram
 * Desktop export), pulls every Solana mint it ever posted, runs each one
 * through the ordinary Aegis audit pipeline, and writes a Markdown review to
 * the vault.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS MEASURED AND WHAT IS MERELY CLAIMED
 *
 * This is the whole point of the module, so it goes first. A review that mixes
 * the two produces a win rate that reads as an audit and is actually a
 * repetition of the channel's own marketing.
 *
 *   MEASURED (Aegis fetched it):
 *     - current price, market cap and liquidity          [DexScreener]
 *     - mint / freeze authority, LP lock, insider concentration, rug flags
 *                                                        [RugCheck + RPC]
 *     - deployer history                                 [RPC replay]
 *     - peak price since the call                        [price-history source,
 *                                                         see AVAILABILITY below]
 *
 *   CLAIMED (the channel said so; nobody verified it):
 *     - the market cap printed in the call post ("MC: $45K")
 *     - any "42x" in a recap post
 *
 * Every claimed number is carried in a field whose name begins with `claimed`
 * and is rendered in the report under a heading that says so. The headline win
 * rate is computed from MEASURED baselines only. Calls whose baseline is a
 * channel claim are reported in a SEPARATE, explicitly-labelled table and are
 * excluded from the headline numbers — because a channel that overstates its
 * entry market cap by 3x manufactures a 3x for itself, and averaging that into
 * the same figure as a measured one is how a review becomes an advertisement.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PEAK-PRICE AVAILABILITY — MEASURED ON THIS MACHINE, 2026-08-24
 *
 * "Peak multiplier since the call" needs historical candles. Neither free
 * source is reachable from this network:
 *
 *   api.geckoterminal.com   ECONNRESET  (3/3 attempts, also outside the sandbox)
 *   public-api.birdeye.so   ECONNRESET  (3/3, key present in .env and unused)
 *   api.dexscreener.com     HTTP 200
 *   api.rugcheck.xyz        HTTP 200
 *
 * DexScreener carries no history beyond priceChange over m5/h1/h6/h24, which
 * cannot price a call made three weeks ago. So on this machine `peak` comes
 * back null with a recorded reason, and the report says "not measurable here"
 * rather than quietly substituting the current price and calling it the peak —
 * which would understate every winner that already round-tripped and turn a
 * channel's best call into a flat line.
 *
 * Both adapters are implemented and tried in order anyway. Run this from a
 * network that can reach either host and the peak column populates with no
 * code change. That is also why the failure reason is carried per-token
 * instead of being swallowed: it tells you whether the gap is the network or
 * the token.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY MODEL — INHERITED, NOT RELAXED
 *
 * Same rule as telegram_listener.mjs: channel text is DATA, never instruction.
 * This module runs regexes over it and nothing else. It does not follow links,
 * does not execute anything a post asks for, and does not treat "CONFIRMED
 * 100X" as evidence. An extracted address is a question for the audit
 * pipeline; the pipeline's answer is the only verdict that appears.
 *
 * Reviewing a channel is READ-ONLY by construction: no alerts are sent, no
 * positions are opened, no notes are written for individual tokens. It calls
 * auditOnce(), which exists precisely because asking a question must not fire
 * a BUY. The single write is the review file itself.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, isAbsolute } from 'node:path';

// From the leaf module, NOT from telegram_listener.mjs. The listener imports
// this file from inside a top-level await for its `--review` flag, so importing
// the listener back from here deadlocks that CLI path — measured, and the
// reason call_parsing.mjs exists. See its header.
import { extractMints, parseMultiplierRecap, parseTicker } from './call_parsing.mjs';

export { parseTicker };

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Export parsing — pure
 * ------------------------------------------------------------------ */

/**
 * Flatten a Telegram export's `text` field to a plain string. PURE.
 *
 * The field is polymorphic and the shape matters: a plain post is a string,
 * but the moment a post contains a link, a bold run, or — critically — a
 * `code` span, Telegram emits an ARRAY of alternating strings and
 * `{type, text}` objects. Call channels put the contract address in a code
 * span so it is tap-to-copy, so the naive `String(msg.text)` reading yields
 * "[object Object]" exactly where the mint was and finds zero calls in a file
 * full of them.
 */
export function normalizeExportText(text) {
  if (typeof text === 'string') return text;
  if (!Array.isArray(text)) return '';
  return text
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return String(part.text ?? '');
      return '';
    })
    .join('');
}

/**
 * Normalise a Telegram Desktop JSON export into {channel, messages}. PURE.
 *
 * `date_unixtime` is preferred over `date` because `date` is a LOCAL-time
 * string with no zone suffix ("2026-08-01T12:00:00"). Parsing that with
 * `new Date()` silently reinterprets it in the runner's timezone, which shifts
 * every call by the UTC offset — enough, on a token that ran and died inside an
 * hour, to price the call against the wrong candle entirely.
 */
export function parseExport(json) {
  const raw = Array.isArray(json?.messages) ? json.messages : [];
  const messages = [];

  for (const m of raw) {
    if (m?.type && m.type !== 'message') continue; // skip service/join events
    const text = normalizeExportText(m?.text);
    if (!text.trim()) continue;

    const unix = Number(m?.date_unixtime);
    const at = Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000) : parseLooseDate(m?.date);

    messages.push({
      id: m?.id ?? null,
      at,
      text,
    });
  }

  messages.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  return {
    channel: json?.name ?? null,
    messages,
    timestamped: messages.filter((m) => m.at instanceof Date && !Number.isNaN(m.at.getTime())).length,
  };
}

function parseLooseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse a Telegram Desktop PLAIN-TEXT export. PURE.
 *
 * Weaker than the JSON path and deliberately so. The .txt format has no
 * message ids, no timezone, and no stable delimiter — it is a rendering, not a
 * serialisation. This recognises the common
 * "Author, [DD.MM.YYYY HH:MM]" / "Author (DD.MM.YYYY HH:MM:SS)" headers and
 * treats everything up to the next header as one message.
 *
 * When no header is recognised at all the whole file becomes ONE untimed
 * message. That is not a silent fallback: `timestamped` comes back 0, and the
 * caller downgrades the review to "addresses only, no call timing" rather than
 * inventing dates. Prefer the JSON export whenever you have the choice.
 */
export function parseTextExport(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { channel: null, messages: [], timestamped: 0 };

  const HEADER =
    /^(.{1,64}?)[,]?\s*[[(](\d{1,2})[./](\d{1,2})[./](\d{4})[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?[\])]\s*$/;

  const lines = raw.split(/\r?\n/);
  const messages = [];
  let current = null;

  for (const line of lines) {
    const h = line.trim().match(HEADER);
    if (h) {
      if (current) messages.push(current);
      const [, , dd, mm, yyyy, hh, min, ss] = h;
      // Telegram writes DD.MM.YYYY in local time. Constructed as UTC so the
      // review is reproducible on any machine; absolute ordering is preserved
      // either way, and ordering is what the first-call logic depends on.
      const at = new Date(
        Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss ?? 0))
      );
      current = { id: null, at: Number.isNaN(at.getTime()) ? null : at, text: '' };
      continue;
    }
    if (current) current.text += `${line}\n`;
  }
  if (current) messages.push(current);

  if (!messages.length) {
    // No recognised headers. One untimed blob, honestly labelled.
    return { channel: null, messages: [{ id: null, at: null, text: raw }], timestamped: 0 };
  }

  const kept = messages.filter((m) => m.text.trim());
  return {
    channel: null,
    messages: kept,
    timestamped: kept.filter((m) => m.at instanceof Date).length,
  };
}

/* ------------------------------------------------------------------ *
 * Claim parsing — pure
 * ------------------------------------------------------------------ */

/**
 * The comma-grouped alternative comes FIRST and is not optional decoration.
 *
 * A plain `\d+(?:[.,]\d+)?` reads "$1,250,000" as `1,250` — it stops at the
 * second comma — and `replace(/,/g,'')` then yields 1250. That is a $1.25M
 * entry recorded as $1,250, which is a 1000x handed to the channel for free.
 * Measured: the first cut of this regex did exactly that.
 */
const MCAP_RE =
  /(?:market\s*cap|mkt\s*cap|mcap|fdv|\bmc\b)\s*[:=-]?\s*\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kmb])?\b/i;

const SUFFIX = { k: 1e3, m: 1e6, b: 1e9 };

/**
 * Pull the market cap a call post CLAIMS the token was at. PURE.
 *
 * Returns null rather than guessing, and the two rejections below are the
 * whole value of the function:
 *
 *   - a bare number under 1000 with no k/m/b suffix is refused. "MC: 45"
 *     is not a $45 market cap, it is a truncation, a rank, or a coincidence,
 *     and admitting it would produce a baseline that manufactures a 1000x.
 *   - the suffix must touch the number. "MC $45 K" is fine; "MC $45 in the
 *     Kitchen" is not, which is why \b and the bounded gap are there.
 *
 * This number is a CLAIM. It is the channel's own account of its entry, it is
 * unverifiable after the fact, and it is the most flattering number in the
 * post. Callers must keep it in a `claimed*` field and out of measured stats.
 */
export function parseClaimedMarketCap(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(MCAP_RE);
  if (!m) return null;

  const value = Number(String(m[1]).replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;

  const suffix = m[2] ? SUFFIX[m[2].toLowerCase()] : null;
  const scaled = suffix ? value * suffix : value;

  // Unsuffixed and small: not a dollar market cap. See above.
  if (!suffix && scaled < 1000) return null;
  // Absurd on either end — a parse artefact, not a memecoin.
  if (scaled < 500 || scaled > 1e12) return null;
  return scaled;
}

/* ------------------------------------------------------------------ *
 * Call extraction — pure, and the part worth testing
 * ------------------------------------------------------------------ */

/**
 * A message is a RECAP, not a call, when it pairs two or more multipliers with
 * two or more contracts. PURE.
 *
 * Why the threshold is two and not one: a channel's follow-up on a single live
 * call ("$FOO doing 4x, still holding") legitimately contains one multiplier
 * and one address, and is not a recap. A post pairing several is a scoreboard —
 * a list of tokens called at some earlier, unstated time.
 *
 * Getting this wrong in the permissive direction is what makes a review lie.
 * A recap's tokens are, by construction, the channel's winners; if the recap is
 * treated as the call, every one of them is dated to the day it was already up
 * 42x, the "call market cap" becomes the peak, and the resulting review shows a
 * channel that only ever calls winners. Recap-only addresses are therefore kept
 * and reported, but flagged `firstSeenInRecap` and excluded from timing stats.
 */
export function isRecapMessage(text, { minMultiplier = 2 } = {}) {
  const recap = parseMultiplierRecap(text, { minMultiplier });
  return { isRecap: recap.rows.length >= 2, recap };
}

/**
 * Reduce a channel's history to one row per token — the FIRST time it appeared.
 * PURE.
 *
 * First mention is the call. Everything after it is a follow-up, a recap or a
 * repost, and folding those in would count one call three times and weight the
 * review toward whatever the channel talks about most (which is its winners).
 *
 * Messages MUST arrive in chronological order; parseExport sorts, and the
 * MTProto path reverses GramJS's newest-first iteration for the same reason.
 */
export function extractCalls(messages, { minMultiplier = 2 } = {}) {
  const byAddress = new Map();
  const claimedMultipliers = new Map();
  let recapMessages = 0;
  let messagesWithMints = 0;

  for (const msg of messages) {
    const text = msg?.text ?? '';
    if (!text) continue;

    const { isRecap, recap } = isRecapMessage(text, { minMultiplier });
    if (isRecap) recapMessages++;

    // Keep the channel's own multiplier claims, whatever message they came in.
    // Best (highest) claim wins — a channel restating a win usually rounds up,
    // and taking the max makes the "claimed vs measured" gap in the report the
    // most generous possible reading of the channel. If it still looks bad
    // under its own best numbers, that is a finding.
    for (const row of recap.rows) {
      const prior = claimedMultipliers.get(row.address);
      if (prior === undefined || row.multiplier > prior) {
        claimedMultipliers.set(row.address, row.multiplier);
      }
    }

    const mints = extractMints(text);
    if (!mints.length) continue;
    messagesWithMints++;

    for (const address of mints) {
      if (byAddress.has(address)) {
        byAddress.get(address).mentions++;
        continue;
      }
      byAddress.set(address, {
        address,
        symbol: parseTicker(text),
        calledAt: msg.at ?? null,
        messageId: msg.id ?? null,
        claimedMcapAtCall: isRecap ? null : parseClaimedMarketCap(text),
        firstSeenInRecap: isRecap,
        mentions: 1,
        excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 160),
      });
    }
  }

  const calls = [...byAddress.values()];
  for (const call of calls) {
    call.claimedMultiplier = claimedMultipliers.get(call.address) ?? null;
  }
  calls.sort((a, b) => (a.calledAt?.getTime() ?? 0) - (b.calledAt?.getTime() ?? 0));

  return {
    calls,
    recapMessages,
    messagesWithMints,
    claimedMultipliers,
  };
}

/* ------------------------------------------------------------------ *
 * Outcome classification — pure
 * ------------------------------------------------------------------ */

export const OUTCOME = {
  RUG: 'RUG',
  DEAD: 'DEAD',
  LOSS: 'LOSS',
  FLAT: 'FLAT',
  WIN: 'WIN',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Grade one call. PURE.
 *
 * ── ORDER IS THE LOGIC ──────────────────────────────────────────────────────
 * Rug and dead are checked BEFORE any multiplier, because a token that ran 8x
 * and then had its liquidity pulled is not a win — the multiplier was
 * unrealisable for anyone who could not exit, and grading it on peak price
 * would credit the channel for a rug. `delisted` (no tradeable pair left) is
 * the strongest such signal and is treated as terminal.
 *
 * ── WHICH MULTIPLIER GRADES ─────────────────────────────────────────────────
 * `peakMultiplier` when it was measured, `currentMultiplier` otherwise. Never
 * the channel's claim: a review graded on claims measures the channel's
 * honesty about itself, which is not the question.
 *
 * When neither is available the answer is UNKNOWN, not FLAT. A missing
 * baseline is missing data, and burying it in the neutral bucket would let an
 * unmeasurable channel post a respectable-looking review.
 */
export function classifyOutcome({
  delisted = false,
  rugged = false,
  liquidityUsd = null,
  peakMultiplier = null,
  currentMultiplier = null,
  deadLiquidityUsd = 1000,
} = {}) {
  if (delisted) return OUTCOME.RUG;
  if (rugged) return OUTCOME.RUG;
  if (liquidityUsd !== null && liquidityUsd < deadLiquidityUsd) return OUTCOME.DEAD;

  const m = peakMultiplier ?? currentMultiplier;
  if (m === null || !Number.isFinite(m)) return OUTCOME.UNKNOWN;

  if (m >= 2) return OUTCOME.WIN;
  if (m >= 0.8) return OUTCOME.FLAT;
  return OUTCOME.LOSS;
}

/**
 * Which column a graded call belongs in. PURE.
 *
 * ── A RUG NEEDS NO PRICE BASELINE ───────────────────────────────────────────
 * This function exists because the obvious rule — "bucket by baselineSource" —
 * is wrong in the one direction that flatters the channel, and it shipped that
 * way for exactly one test run. A rugged or drained token frequently has no
 * usable entry price: the pool is gone, so there is no history to fetch and
 * often no claimed market cap either. Bucketing on baselineSource alone put
 * those rows in NEITHER column, and the fixture run printed
 *
 *     Rug + dead rate | — | 0.0%
 *
 * with two dead pools sitting in the table underneath. The worst outcome a
 * channel can produce was silently deleted from its own scorecard.
 *
 * The resolution is that a rug is not a price judgement at all. RUG and DEAD
 * come from on-chain liquidity and the rug flag — both fetched, both measured —
 * so they count as measured whatever the price history did. Only WIN, FLAT and
 * LOSS depend on a baseline, and only those inherit its provenance.
 */
export function gradeBasisFor(row) {
  if (row?.outcome === OUTCOME.UNKNOWN) return null;
  if (row?.outcome === OUTCOME.RUG || row?.outcome === OUTCOME.DEAD) return 'measured';
  return row?.baselineSource ?? null;
}

/**
 * Roll graded calls into the headline numbers. PURE.
 *
 * `measured` and `claimed` are summarised SEPARATELY and never averaged
 * together — see the module header. `unknown` is reported as its own count
 * rather than dropped, because "we could not price 40% of this channel's
 * calls" is itself the most important sentence a review can contain.
 */
export function summarize(rows) {
  const graded = rows.filter((r) => r.outcome !== OUTCOME.UNKNOWN);
  const measured = graded.filter((r) => gradeBasisFor(r) === 'measured');
  const claimed = graded.filter((r) => gradeBasisFor(r) === 'claimed');

  const bucket = (list) => {
    const count = (o) => list.filter((r) => r.outcome === o).length;
    const multipliers = list
      .map((r) => r.peakMultiplier ?? r.currentMultiplier)
      .filter((m) => Number.isFinite(m))
      .sort((a, b) => a - b);

    const wins = count(OUTCOME.WIN);
    const rugs = count(OUTCOME.RUG);
    const dead = count(OUTCOME.DEAD);

    return {
      total: list.length,
      wins,
      losses: count(OUTCOME.LOSS),
      flat: count(OUTCOME.FLAT),
      rugs,
      dead,
      // Percentages of the GRADED set only. Dividing by every call ever posted
      // would let a channel dilute its rug rate with tokens nobody could price.
      winRate: list.length ? (wins / list.length) * 100 : null,
      rugRate: list.length ? ((rugs + dead) / list.length) * 100 : null,
      avgMultiplier: multipliers.length
        ? multipliers.reduce((a, b) => a + b, 0) / multipliers.length
        : null,
      // Median is carried alongside the mean because one 200x drags an average
      // across the whole distribution. Where they disagree sharply, the median
      // is the number describing a typical call.
      medianMultiplier: multipliers.length
        ? multipliers.length % 2
          ? multipliers[(multipliers.length - 1) / 2]
          : (multipliers[multipliers.length / 2 - 1] + multipliers[multipliers.length / 2]) / 2
        : null,
      bestMultiplier: multipliers.length ? multipliers[multipliers.length - 1] : null,
    };
  };

  return {
    calls: rows.length,
    graded: graded.length,
    unknown: rows.length - graded.length,
    measured: bucket(measured),
    claimed: bucket(claimed),
  };
}

/**
 * Count the security findings across every audited call. PURE.
 *
 * This is the part a price-only review cannot produce, and it answers a
 * sharper question than the win rate: not "did this go up" but "was the
 * channel handing you tokens that could confiscate your funds". Mint and
 * freeze authority are absolutes — a live mint authority means the supply can
 * be diluted at will, regardless of what the chart did afterwards.
 */
export function summarizeSecurity(rows) {
  const audited = rows.filter((r) => r.audit);
  const hit = (fn) => audited.filter(fn).length;

  return {
    audited: audited.length,
    passed: hit((r) => r.audit.status === 'PASSED'),
    failed: hit((r) => r.audit.status === 'FAILED'),
    unverified: hit((r) => r.audit.status === 'UNVERIFIED'),
    liveMintAuthority: hit((r) => r.flags?.mintAuthorityActive),
    liveFreezeAuthority: hit((r) => r.flags?.freezeAuthorityActive),
    unlockedLp: hit((r) => r.flags?.lpUnlocked),
    concentrated: hit((r) => r.flags?.concentrated),
    serialRugDeployer: hit((r) => r.deployerStatus === 'SERIAL RUGGER'),
    // "Would Aegis have alerted?" is the only number here that grades the
    // channel against this repo's own bar rather than against a generic one.
    wouldAegisAlert: hit((r) => r.aegisWouldAlert === true),
  };
}

/* ------------------------------------------------------------------ *
 * Price history — impure, with the availability caveat from the header
 * ------------------------------------------------------------------ */

async function getJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    // A 200 carrying HTML is a documentation page, not data. sources.mjs
    // learned this from Birdeye the expensive way; the check is cheap.
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('json')) return { ok: false, error: `non-JSON response (${ctype})` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.cause?.code ?? err.message };
  }
}

/**
 * Highest close between `since` and now, from GeckoTerminal hourly candles.
 *
 * Hourly rather than minute candles: the free endpoint caps at 1000 candles,
 * which is 41 days of hours but only 16 HOURS of minutes. A minute resolution
 * would silently truncate the window for any call older than yesterday and
 * report the peak of the wrong period.
 *
 * `high` is used, not `close` — a wick is a price somebody actually got.
 */
export async function fetchPeakGeckoTerminal({ poolAddress, since, fetchImpl = getJson }) {
  if (!poolAddress) return { ok: false, reason: 'no pool address' };
  const url =
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}` +
    `/ohlcv/hour?aggregate=1&limit=1000&currency=usd`;

  const res = await fetchImpl(url);
  if (!res.ok) return { ok: false, reason: `geckoterminal: ${res.error}` };

  const list = res.data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list) || !list.length) return { ok: false, reason: 'geckoterminal: no candles' };

  const floor = since instanceof Date ? since.getTime() / 1000 : 0;
  let peak = null;
  let baseline = null;
  let baselineTs = Infinity;

  for (const candle of list) {
    const [ts, open, high] = candle.map(Number);
    if (!Number.isFinite(ts) || ts < floor) continue;
    if (Number.isFinite(high) && (peak === null || high > peak)) peak = high;
    // The open of the earliest candle at or after the call is the entry price.
    if (ts < baselineTs && Number.isFinite(open)) {
      baselineTs = ts;
      baseline = open;
    }
  }

  if (peak === null) return { ok: false, reason: 'geckoterminal: no candles after call' };
  return { ok: true, peakPriceUsd: peak, baselinePriceUsd: baseline, source: 'geckoterminal' };
}

/** Same answer from Birdeye, used when GeckoTerminal cannot be reached. */
export async function fetchPeakBirdeye({ mint, since, apiKey, fetchImpl = getJson }) {
  if (!apiKey) return { ok: false, reason: 'birdeye: no API key' };
  if (!mint) return { ok: false, reason: 'birdeye: no mint' };

  const to = Math.floor(Date.now() / 1000);
  const from = since instanceof Date ? Math.floor(since.getTime() / 1000) : to - 30 * 86400;
  const url =
    `https://public-api.birdeye.so/defi/history_price?address=${mint}` +
    `&address_type=token&type=1H&time_from=${from}&time_to=${to}`;

  const res = await fetchImpl(url, { headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' } });
  if (!res.ok) return { ok: false, reason: `birdeye: ${res.error}` };

  const items = res.data?.data?.items;
  if (!Array.isArray(items) || !items.length) return { ok: false, reason: 'birdeye: no history' };

  let peak = null;
  let baseline = null;
  let baselineTs = Infinity;
  for (const it of items) {
    const v = Number(it?.value);
    const ts = Number(it?.unixTime);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (peak === null || v > peak) peak = v;
    if (Number.isFinite(ts) && ts < baselineTs) {
      baselineTs = ts;
      baseline = v;
    }
  }

  if (peak === null) return { ok: false, reason: 'birdeye: no usable prices' };
  return { ok: true, peakPriceUsd: peak, baselinePriceUsd: baseline, source: 'birdeye' };
}

/** Try each history source in turn; carry the reason when all of them fail. */
export async function fetchPeakSinceCall({ poolAddress, mint, since, birdeyeKey = null }) {
  const reasons = [];

  const gt = await fetchPeakGeckoTerminal({ poolAddress, since });
  if (gt.ok) return gt;
  reasons.push(gt.reason);

  const be = await fetchPeakBirdeye({ mint, since, apiKey: birdeyeKey });
  if (be.ok) return be;
  reasons.push(be.reason);

  return { ok: false, reason: reasons.join('; ') };
}

/* ------------------------------------------------------------------ *
 * MTProto history — impure
 * ------------------------------------------------------------------ */

/**
 * Pull `limit` messages of history for one channel.
 *
 * Requires the same USER session as the listener, for the same reason: a bot
 * cannot read a channel it does not administer. The login flow is interactive
 * and must be run by the account owner — it asks for a phone number, an SMS
 * code and a 2FA password, and the session string it produces grants full
 * access to the account. Nobody should run it on your behalf, this module
 * included: it only ever READS a session that already exists.
 */
export async function fetchHistoryViaMtproto({ channel, limit = 3000 }) {
  const { loadEnv } = await import('./telegram.mjs');
  const env = await loadEnv(join(HERE, '.env'));

  const apiId = Number(env.tgApiId);
  if (!apiId || !env.tgApiHash) {
    throw new Error(
      'TELEGRAM_API_ID / TELEGRAM_API_HASH are not set in aegis/.env.\n' +
        '   Get them from https://my.telegram.org → API development tools,\n' +
        '   or review an exported history instead:  --export result.json'
    );
  }
  if (!env.tgSession) {
    throw new Error(
      'TELEGRAM_SESSION is not set in aegis/.env.\n' +
        '   Run it yourself:  node aegis/telegram_listener.mjs --login\n' +
        '   That flow asks for your phone, an SMS code and your 2FA password —\n' +
        '   run it in your own terminal, never through an assistant.\n' +
        '   Or review an exported history instead:  --export result.json'
    );
  }

  let TelegramClient;
  let StringSession;
  try {
    const mod = await import('telegram');
    const sessions = await import('telegram/sessions/index.js');
    TelegramClient = mod.TelegramClient;
    StringSession = sessions.StringSession;
  } catch (err) {
    throw new Error(`MTProto client not available (${err.message}). Install it with: npm install telegram`);
  }

  const client = new TelegramClient(new StringSession(env.tgSession), apiId, env.tgApiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  try {
    const entity = await client.getEntity(channel);
    const messages = [];
    // GramJS iterates newest-first. Collected then reversed, because
    // extractCalls defines "the call" as the FIRST appearance and would
    // otherwise date every token to its most recent repost.
    for await (const msg of client.iterMessages(entity, { limit })) {
      const text = msg?.message ?? msg?.text ?? '';
      if (!text) continue;
      messages.push({
        id: msg.id ?? null,
        at: msg.date ? new Date(msg.date * 1000) : null,
        text,
      });
    }
    messages.reverse();
    return {
      channel: entity?.title ?? entity?.username ?? String(channel),
      messages,
      timestamped: messages.filter((m) => m.at instanceof Date).length,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * Auditing one call — impure
 * ------------------------------------------------------------------ */

const ALERTABLE_VERDICTS = new Set(['STRONG BUY', 'BUY', 'SPECULATIVE BUY', 'WATCH']);

/**
 * Run one called token through the ordinary audit and grade what happened.
 *
 * `auditOnce` is used rather than `runScan` deliberately: reviewing history
 * must not alert, open a position or write a note. See its docstring in
 * scan.mjs — it exists for exactly this "asking a question" case.
 */
export async function reviewOneCall(call, { birdeyeKey = null, skipPeak = false } = {}) {
  const row = {
    ...call,
    audit: null,
    flags: {},
    currentMcap: null,
    currentPriceUsd: null,
    liquidityUsd: null,
    peakMultiplier: null,
    currentMultiplier: null,
    peakMcap: null,
    baselineSource: null,
    baselineMcap: null,
    peakUnavailableReason: null,
    deployerStatus: null,
    aegisWouldAlert: null,
    outcome: OUTCOME.UNKNOWN,
    delisted: false,
    error: null,
  };

  let audited;
  try {
    const { auditOnce } = await import('./scan.mjs');
    audited = await auditOnce(call.address);
  } catch (err) {
    row.error = err.message;
    return row;
  }

  if (!audited?.ok) {
    // No tradeable pair. For a token that was once called in a channel this is
    // overwhelmingly a dead or drained pool rather than a bad address — the
    // address parsed as base58 and the channel posted it as a contract. Graded
    // as a rug, and the reason is kept so a genuine parse artefact is
    // distinguishable in the report.
    row.error = audited?.error ?? 'audit failed';
    row.delisted = true;
    row.outcome = classifyOutcome({ delisted: true });
    return row;
  }

  const { pair, result } = audited;
  const security = result.security ?? {};

  row.symbol = pair.baseToken?.symbol ?? row.symbol;
  row.currentPriceUsd = Number(pair.priceUsd) || null;
  row.currentMcap = Number(pair.marketCap ?? pair.fdv) || null;
  row.liquidityUsd = Number(pair.liquidity?.usd) || null;
  row.pairAddress = pair.pairAddress ?? null;
  row.pairCreatedAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null;
  row.audit = result.audit ?? null;
  row.deployerStatus = result.deployer?.status ?? null;
  row.verdict = result.verdictInfo?.verdict ?? null;
  row.score = result.verdictInfo?.score ?? null;
  row.signalCategory = result.signalCategory ?? null;
  row.aegisWouldAlert = ALERTABLE_VERDICTS.has(String(row.verdict).toUpperCase());

  row.flags = {
    mintAuthorityActive: security.mintAuthority != null,
    freezeAuthorityActive: security.freezeAuthority != null,
    lpUnlocked: security.lpLockedPct != null && security.lpLockedPct < 50,
    concentrated: security.top10Pct != null && security.top10Pct >= 30,
    rugged: security.rugged === true,
    top10Pct: security.top10Pct ?? null,
    lpLockedPct: security.lpLockedPct ?? null,
  };

  // ---- peak, when a history source is reachable ----------------------
  if (!skipPeak && call.calledAt) {
    const peak = await fetchPeakSinceCall({
      poolAddress: row.pairAddress,
      mint: call.address,
      since: call.calledAt,
      birdeyeKey,
    });
    if (peak.ok) {
      // Market cap is derived from price with supply held constant. Stated
      // rather than hidden, because it is exactly wrong for a token whose mint
      // authority is still live — which this row also reports.
      if (row.currentPriceUsd && row.currentMcap) {
        row.peakMcap = (peak.peakPriceUsd / row.currentPriceUsd) * row.currentMcap;
      }
      if (peak.baselinePriceUsd > 0) {
        row.peakMultiplier = peak.peakPriceUsd / peak.baselinePriceUsd;
        row.currentMultiplier = row.currentPriceUsd
          ? row.currentPriceUsd / peak.baselinePriceUsd
          : null;
        row.baselineSource = 'measured';
        row.baselineMcap =
          row.currentMcap && row.currentPriceUsd
            ? (peak.baselinePriceUsd / row.currentPriceUsd) * row.currentMcap
            : null;
      }
      row.peakSource = peak.source;
    } else {
      row.peakUnavailableReason = peak.reason;
    }
  } else if (!call.calledAt) {
    row.peakUnavailableReason = 'no call timestamp in source history';
  }

  // ---- fall back to the CLAIMED entry, clearly labelled ---------------
  if (row.baselineSource === null && call.claimedMcapAtCall && row.currentMcap) {
    row.currentMultiplier = row.currentMcap / call.claimedMcapAtCall;
    row.baselineSource = 'claimed';
    row.baselineMcap = call.claimedMcapAtCall;
  }

  row.outcome = classifyOutcome({
    delisted: false,
    rugged: row.flags.rugged,
    liquidityUsd: row.liquidityUsd,
    peakMultiplier: row.peakMultiplier,
    currentMultiplier: row.currentMultiplier,
  });

  return row;
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const fmtUsd = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};
const fmtX = (n) => (Number.isFinite(n) ? `${n >= 10 ? n.toFixed(0) : n.toFixed(2)}x` : '—');
const fmtPct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');
const fmtDate = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 16).replace('T', ' ') : '—');
const short = (a) => `${String(a).slice(0, 4)}…${String(a).slice(-4)}`;

const OUTCOME_ICON = {
  WIN: '🟢 WIN',
  FLAT: '⚪ FLAT',
  LOSS: '🔴 LOSS',
  DEAD: '💀 DEAD',
  RUG: '☠️ RUG',
  UNKNOWN: '❔ UNKNOWN',
};

/**
 * Render the review. PURE — takes data, returns a string, touches no disk.
 *
 * Structured so the caveats cannot be skimmed past. The measured table and the
 * claimed table are separate sections with separate headline numbers, and the
 * unmeasurable calls are counted in the header rather than at the bottom.
 */
export function renderReport({
  channel,
  rows,
  stats,
  security,
  meta = {},
  generatedAt = new Date(),
}) {
  const L = [];
  const p = (s = '') => L.push(s);

  p(`# ${channel} — Call Review`);
  p();
  p('> [!info] What this is');
  p('> An independent audit of every Solana contract this channel posted, run through');
  p('> the Aegis security pipeline. Channel text was treated as data: no link was');
  p('> followed and no claim was taken at face value. Read the *Method* section before');
  p('> quoting any number here.');
  p();
  p(`- **Generated:** ${fmtDate(generatedAt)} UTC`);
  p(`- **Source:** ${meta.source ?? 'unknown'}`);
  p(`- **Messages read:** ${meta.messages ?? '—'}${meta.timestamped != null ? ` (${meta.timestamped} with timestamps)` : ''}`);
  if (meta.firstMessageAt || meta.lastMessageAt) {
    p(`- **History window:** ${fmtDate(meta.firstMessageAt)} → ${fmtDate(meta.lastMessageAt)}`);
  }
  p(`- **Unique contracts called:** ${stats.calls}`);
  p(`- **Gradeable:** ${stats.graded}  ·  **Not priceable:** ${stats.unknown}`);
  p();

  /* ---------------- headline ---------------- */
  p('## Verdict at a glance');
  p();
  const m = stats.measured;
  const c = stats.claimed;
  p('| | Measured baseline | Channel-claimed baseline |');
  p('|---|---:|---:|');
  p(`| Calls graded | ${m.total} | ${c.total} |`);
  p(`| Win rate (≥2x) | ${fmtPct(m.winRate)} | ${fmtPct(c.winRate)} |`);
  p(`| Rug + dead rate | ${fmtPct(m.rugRate)} | ${fmtPct(c.rugRate)} |`);
  p(`| Average multiple | ${fmtX(m.avgMultiplier)} | ${fmtX(c.avgMultiplier)} |`);
  p(`| Median multiple | ${fmtX(m.medianMultiplier)} | ${fmtX(c.medianMultiplier)} |`);
  p(`| Best call | ${fmtX(m.bestMultiplier)} | ${fmtX(c.bestMultiplier)} |`);
  p(`| Wins / Flat / Losses | ${m.wins} / ${m.flat} / ${m.losses} | ${c.wins} / ${c.flat} / ${c.losses} |`);
  p(`| Rugs / Dead pools | ${m.rugs} / ${m.dead} | ${c.rugs} / ${c.dead} |`);
  p();
  p('The two columns are **not** comparable and must never be averaged together.');
  p('The left column prices each call against a price Aegis fetched. The right prices');
  p('it against the market cap the channel *said* it was calling at — an unverifiable,');
  p('self-reported, and structurally flattering number.');
  p();
  p('Rugs and dead pools always count on the **left**, whichever baseline the call had.');
  p('That verdict comes from on-chain liquidity and the rug flag, not from a price');
  p('comparison, so it stands even where no entry price could be recovered — which is');
  p('the usual case for a token whose pool no longer exists.');
  p();
  if (m.avgMultiplier && m.medianMultiplier && m.avgMultiplier > m.medianMultiplier * 5) {
    p(`> [!tip] Mean ${fmtX(m.avgMultiplier)} vs median ${fmtX(m.medianMultiplier)}`);
    p('> The average is being carried by a small number of large winners. The median is');
    p('> the number describing a typical call from this channel.');
    p();
  }

  /* ---------------- security ---------------- */
  p('## Security audit — what was actually being handed out');
  p();
  p('This is the half of the review a price chart cannot show. Percentages are of the');
  p(`${security.audited} contracts that still resolve to a tradeable pair.`);
  p();
  p('| Finding | Count | Share |');
  p('|---|---:|---:|');
  const shareOf = (n) => (security.audited ? fmtPct((n / security.audited) * 100) : '—');
  p(`| Passed full security audit | ${security.passed} | ${shareOf(security.passed)} |`);
  p(`| FAILED security audit | ${security.failed} | ${shareOf(security.failed)} |`);
  p(`| Unverifiable (not indexed) | ${security.unverified} | ${shareOf(security.unverified)} |`);
  p(`| 🔴 Mint authority still live | ${security.liveMintAuthority} | ${shareOf(security.liveMintAuthority)} |`);
  p(`| 🔴 Freeze authority still live | ${security.liveFreezeAuthority} | ${shareOf(security.liveFreezeAuthority)} |`);
  p(`| ⚠️ LP under 50% burned/locked | ${security.unlockedLp} | ${shareOf(security.unlockedLp)} |`);
  p(`| ⚠️ Top-10 hold ≥30% | ${security.concentrated} | ${shareOf(security.concentrated)} |`);
  p(`| ☠️ Deployer is a serial rugger | ${security.serialRugDeployer} | ${shareOf(security.serialRugDeployer)} |`);
  p(`| ✅ Aegis would have alerted | ${security.wouldAegisAlert} | ${shareOf(security.wouldAegisAlert)} |`);
  p();
  p('> [!warning] Mint and freeze authority are not chart problems');
  p('> A live mint authority means the deployer can print unlimited supply at any');
  p('> moment; a live freeze authority means they can freeze your wallet so you cannot');
  p('> sell. Neither shows up in a multiplier until it is used. A call on a token with');
  p('> either is a call on the deployer\'s restraint.');
  p();
  p('> [!note] "Aegis would have alerted" is a strict bar, not a scorecard');
  p('> The thresholds are tuned for freshly-launched tokens. An established token can');
  p('> fail on concentration alone. Read the row as "how many of these calls would have');
  p('> cleared this repo\'s own gates", not as a claim that the rest were scams.');
  p();

  /* ---------------- top performers ---------------- */
  const performers = rows
    .filter((r) => Number.isFinite(r.peakMultiplier ?? r.currentMultiplier))
    .sort(
      (a, b) => (b.peakMultiplier ?? b.currentMultiplier) - (a.peakMultiplier ?? a.currentMultiplier)
    )
    .slice(0, 15);

  if (performers.length) {
    p('## Top performers');
    p();
    p('| # | Token | Called | Baseline | Peak | Now | Multiple | Basis | Outcome |');
    p('|---:|---|---|---:|---:|---:|---:|---|---|');
    performers.forEach((r, i) => {
      p(
        `| ${i + 1} | ${r.symbol ? `$${r.symbol}` : short(r.address)} | ${fmtDate(r.calledAt)} | ` +
          `${fmtUsd(r.baselineMcap)} | ${fmtUsd(r.peakMcap)} | ${fmtUsd(r.currentMcap)} | ` +
          `${fmtX(r.peakMultiplier ?? r.currentMultiplier)} | ${r.baselineSource ?? '—'} | ${OUTCOME_ICON[r.outcome]} |`
      );
    });
    p();
  }

  /* ---------------- worst ---------------- */
  const worst = rows.filter((r) => r.outcome === OUTCOME.RUG || r.outcome === OUTCOME.DEAD);
  if (worst.length) {
    p('## Rugs and dead pools');
    p();
    p('| Token | Called | Liquidity now | Why |');
    p('|---|---|---:|---|');
    for (const r of worst.slice(0, 40)) {
      const why = r.delisted
        ? 'no tradeable pair remains'
        : r.flags?.rugged
          ? 'flagged RUGGED on-chain'
          : 'liquidity below $1K — unexitable';
      p(
        `| ${r.symbol ? `$${r.symbol}` : short(r.address)} | ${fmtDate(r.calledAt)} | ` +
          `${fmtUsd(r.liquidityUsd)} | ${why} |`
      );
    }
    if (worst.length > 40) p(`| … | | | ${worst.length - 40} more |`);
    p();
  }

  /* ---------------- every call ---------------- */
  p('## Every call');
  p();
  p('| Called | Token | Contract | Baseline | Now | Multiple | Basis | Audit | Deployer | Outcome |');
  p('|---|---|---|---:|---:|---:|---|---|---|---|');
  for (const r of rows) {
    p(
      `| ${fmtDate(r.calledAt)} | ${r.symbol ? `$${r.symbol}` : '—'} | \`${short(r.address)}\` | ` +
        `${fmtUsd(r.baselineMcap)} | ${fmtUsd(r.currentMcap)} | ` +
        `${fmtX(r.peakMultiplier ?? r.currentMultiplier)} | ${r.baselineSource ?? '—'} | ` +
        `${r.audit?.status ?? '—'} | ${r.deployerStatus ?? '—'} | ${OUTCOME_ICON[r.outcome]} |`
    );
  }
  p();

  /* ---------------- unpriceable ---------------- */
  const unknown = rows.filter((r) => r.outcome === OUTCOME.UNKNOWN);
  if (unknown.length) {
    p('## Calls that could not be priced');
    p();
    p(`${unknown.length} contract(s) resolve to a live pair but have no usable entry price:`);
    p('no reachable price history for the call date, and no market cap stated in the post.');
    p('They are excluded from every percentage above rather than counted as neutral.');
    p();
    p('| Token | Contract | Called | Reason |');
    p('|---|---|---|---|');
    for (const r of unknown.slice(0, 40)) {
      p(
        `| ${r.symbol ? `$${r.symbol}` : '—'} | \`${short(r.address)}\` | ${fmtDate(r.calledAt)} | ` +
          `${r.peakUnavailableReason ?? r.error ?? 'no baseline'} |`
      );
    }
    if (unknown.length > 40) p(`| … | | | ${unknown.length - 40} more |`);
    p();
  }

  /* ---------------- method ---------------- */
  p('## Method, and what these numbers cannot tell you');
  p();
  p('**How a call was identified.** Every base58 run of Solana mint length in the');
  p('history was extracted; the FIRST message containing an address is treated as the');
  p('call and later mentions as follow-ups. Posts pairing two or more multipliers with');
  p('two or more contracts are classed as recaps, not calls — a recap lists tokens the');
  p('channel already called, and dating a token to its recap would record every one of');
  p('them as called at their peak.');
  p();
  if (meta.recapMessages) {
    p(`${meta.recapMessages} recap post(s) were found and excluded from call timing.`);
    p();
  }
  p('**How the baseline was chosen.** Preferably the opening price of the first hourly');
  p('candle at or after the call — measured. Failing that, the market cap the post');
  p('claimed — labelled `claimed` in every table and summarised separately.');
  p();
  if (meta.peakUnavailable) {
    p('> [!warning] Peak prices were not available for this run');
    p('> ' + meta.peakUnavailable);
    p('> Where no peak could be fetched, the multiple shown is **current, not peak**, so');
    p('> any call that ran up and round-tripped is understated here. The win rate is');
    p('> therefore a FLOOR, not an estimate.');
    p();
  }
  p('**What is still missing.**');
  p();
  p('- Deleted posts are invisible. A channel that removes its losers cannot be caught');
  p('  by reading what remains, and this review reads what remains.');
  p('- No slippage, priority fee or tax is modelled. A 3x on paper is less than 3x in a');
  p('  wallet, and on a thin pool it can be much less.');
  p('- Peak is a price that existed, not a price you would have got. Nobody exits an');
  p('  entire position on the wick.');
  p('- Market caps derived from a price move assume constant supply. For any token in');
  p('  the "mint authority still live" row above, that assumption is exactly the one the');
  p('  deployer can break.');
  p();
  p('---');
  p('*Generated by `aegis/review_channel.mjs`. Read-only: no alert was sent, no position');
  p('was opened, and no per-token note was written.*');

  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

export async function reviewChannel({
  channel = null,
  exportPath = null,
  limit = null,
  messageLimit = 3000,
  dryRun = false,
  skipPeak = false,
  outPath = null,
  delayMs = 400,
  log = console.log,
} = {}) {
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  const { loadEnv } = await import('./telegram.mjs');
  const env = await loadEnv(join(HERE, '.env'));

  /* ---- 1. history ---- */
  let history;
  let sourceLabel;
  if (exportPath) {
    const abs = isAbsolute(exportPath) ? exportPath : resolve(process.cwd(), exportPath);
    const raw = await readFile(abs, 'utf8');
    if (abs.toLowerCase().endsWith('.json')) {
      history = parseExport(JSON.parse(raw));
      sourceLabel = `Telegram Desktop JSON export (${abs})`;
    } else {
      history = parseTextExport(raw);
      sourceLabel = `Telegram Desktop text export (${abs})`;
    }
    if (!history.timestamped) {
      log('⚠  No message timestamps recovered from this export.');
      log('   Calls will be listed without dates and cannot be priced against a call-time');
      log('   baseline. Export as JSON ("Machine-readable JSON" in Telegram Desktop) to fix.');
    }
  } else if (channel) {
    history = await fetchHistoryViaMtproto({ channel, limit: messageLimit });
    sourceLabel = `live MTProto history of ${history.channel ?? channel}`;
  } else {
    throw new Error('Need either --channel <name> or --export <file>.');
  }

  const channelName = history.channel ?? channel ?? 'Unknown channel';
  log(`Read ${history.messages.length} message(s) from ${channelName}.`);

  /* ---- 2. calls ---- */
  const { calls, recapMessages, messagesWithMints } = extractCalls(history.messages, {
    minMultiplier: config.telegramListener?.minRecapMultiplier ?? 2,
  });
  log(
    `Found ${calls.length} unique contract(s) across ${messagesWithMints} message(s) ` +
      `with a mint (${recapMessages} recap post(s) excluded from call timing).`
  );

  const selected = limit ? calls.slice(0, limit) : calls;
  if (limit && calls.length > limit) log(`--limit ${limit}: auditing the first ${limit} by call date.`);

  if (dryRun) {
    log('');
    log('DRY RUN — parsing only, nothing audited and nothing written.');
    log('');
    for (const c of selected) {
      log(
        `  ${fmtDate(c.calledAt).padEnd(17)} ${(c.symbol ? `$${c.symbol}` : '—').padEnd(12)} ` +
          `${c.address}  ${c.claimedMcapAtCall ? `claimed ${fmtUsd(c.claimedMcapAtCall)}` : ''}` +
          `${c.claimedMultiplier ? `  claims ${c.claimedMultiplier}x` : ''}` +
          `${c.firstSeenInRecap ? '  [recap-only]' : ''}`
      );
    }
    return { calls: selected, rows: [], dryRun: true };
  }

  /* ---- 3. audit ---- */
  // Sequential on purpose. auditOnce hits DexScreener, RugCheck and the RPC per
  // token and re-reads the deployer cache each time; running these in parallel
  // races the shared state files for the same reason loop.mjs guards against
  // overlapping ticks, and pushes three providers into 429 at once.
  const rows = [];
  let i = 0;
  for (const call of selected) {
    i++;
    process.stdout.write(`\r  auditing ${i}/${selected.length} … ${short(call.address)}     `);
    const row = await reviewOneCall(call, { birdeyeKey: env.birdeyeKey, skipPeak });
    rows.push(row);
    if (i < selected.length) await new Promise((r) => setTimeout(r, delayMs));
  }
  process.stdout.write('\r'.padEnd(60) + '\r');

  /* ---- 4. summarise ---- */
  const stats = summarize(rows);
  const security = summarizeSecurity(rows);

  const peakReasons = rows.map((r) => r.peakUnavailableReason).filter(Boolean);
  const peakUnavailable = rows.some((r) => r.peakMultiplier !== null)
    ? null
    : peakReasons.length
      ? `No price-history source answered for any call. Last reason: ${peakReasons[peakReasons.length - 1]}`
      : null;

  const timestamps = history.messages.map((m) => m.at).filter((d) => d instanceof Date);
  const report = renderReport({
    channel: channelName,
    rows,
    stats,
    security,
    meta: {
      source: sourceLabel,
      messages: history.messages.length,
      timestamped: history.timestamped,
      firstMessageAt: timestamps[0] ?? null,
      lastMessageAt: timestamps[timestamps.length - 1] ?? null,
      recapMessages,
      peakUnavailable,
    },
  });

  /* ---- 5. write ---- */
  const safeName = channelName.replace(/[\\/:*?"<>|]/g, '').trim() || 'Channel';
  const target =
    outPath ??
    join(HERE, config.vaultPath ?? '..', config.notesFolder ?? 'Signals', `00 ${safeName} Calls Review.md`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, report, 'utf8');

  log('');
  log('═'.repeat(66));
  log(`  ${channelName.toUpperCase()} — CALL REVIEW`);
  log('═'.repeat(66));
  log(`  contracts called   : ${stats.calls}`);
  log(`  graded             : ${stats.graded}   (unpriceable: ${stats.unknown})`);
  log(`  measured win rate  : ${fmtPct(stats.measured.winRate)}  over ${stats.measured.total} call(s)`);
  log(`  claimed-baseline   : ${fmtPct(stats.claimed.winRate)}  over ${stats.claimed.total} call(s)`);
  log(`  rug + dead rate    : ${fmtPct(stats.measured.rugRate)} measured / ${fmtPct(stats.claimed.rugRate)} claimed`);
  log(`  mint authority live: ${security.liveMintAuthority}/${security.audited}`);
  log(`  would Aegis alert  : ${security.wouldAegisAlert}/${security.audited}`);
  log('═'.repeat(66));
  if (peakUnavailable) log(`  ⚠  ${peakUnavailable}`);
  log(`  report → ${target}`);

  return { calls: selected, rows, stats, security, report, target };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export function parseReviewArgs(argv) {
  const out = {
    channel: null,
    exportPath: null,
    limit: null,
    messageLimit: 3000,
    dryRun: false,
    skipPeak: false,
    outPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') out.channel = argv[++i] ?? null;
    else if (a === '--export') out.exportPath = argv[++i] ?? null;
    else if (a === '--limit') out.limit = Number(argv[++i]) || null;
    else if (a === '--messages') out.messageLimit = Number(argv[++i]) || 3000;
    else if (a === '--out') out.outPath = argv[++i] ?? null;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-peak') out.skipPeak = true;
    else if (!a.startsWith('--') && !out.channel && !out.exportPath) out.channel = a;
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = parseReviewArgs(process.argv.slice(2));
  if (!args.channel && !args.exportPath) {
    console.error('Usage:');
    console.error('  node aegis/review_channel.mjs --channel TcalledPresence');
    console.error('  node aegis/review_channel.mjs --export "…/ChatExport/result.json"');
    console.error('');
    console.error('Flags: --dry-run  --limit N  --messages N  --no-peak  --out FILE');
    process.exit(1);
  }
  reviewChannel(args).catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
