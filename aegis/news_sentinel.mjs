#!/usr/bin/env node
/**
 * Breaking News Sentinel — headline monitoring and token/news correlation.
 *
 *   node news_sentinel.mjs             show the current headline window
 *   node news_sentinel.mjs --match SOL show what a symbol would match
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS ACTUALLY REACHABLE, measured rather than assumed:
 *
 *   CoinDesk RSS        200 ✅   open, no key
 *   Cointelegraph RSS   200 ✅   open, no key
 *   Decrypt RSS         200 ✅   open, no key
 *   The Block RSS       200 ✅   open, no key
 *   CryptoPanic API     403 ❌   Cloudflare without an auth token
 *
 * So RSS is the backbone and CryptoPanic is an optional upgrade: set
 * CRYPTOPANIC_TOKEN in .env and it joins the pool, otherwise the sentinel runs
 * on RSS alone and says so. Nothing here degrades silently.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE TRADING A NEWS MATCH.
 *
 * A token whose name matches a breaking headline is NOT thereby a good trade.
 * It is the single most reliable signature of an opportunistic launch: someone
 * sees "Robinhood lists X", mints ROBINHOOD, and sells into the people who
 * search for it. The correlation this module finds is real, but its base rate
 * is dominated by exactly that.
 *
 * This module therefore adds NO SCORE. It routes a token into the ordinary
 * audit and labels the alert. Every safety gate still applies, and the label
 * means "this is topical", never "this is good".
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Feed fetching
 * ------------------------------------------------------------------ */

export const DEFAULT_FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml' },
];

const stripTags = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Minimal RSS item parser.
 *
 * Deliberately not an XML dependency: the pipeline is dependency-free apart
 * from the MTProto client, and this needs three fields from a well-formed
 * feed. Handles both <item> (RSS) and <entry> (Atom) because Decrypt and The
 * Block have each shipped both over time.
 */
export function parseFeed(xml, source = 'unknown') {
  if (typeof xml !== 'string' || !xml) return [];
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];

  for (const block of blocks) {
    const title = stripTags((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1]);
    if (!title) continue;

    const dateRaw =
      (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ?? [])[1] ??
      (block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) ?? [])[1] ??
      (block.match(/<published[^>]*>([\s\S]*?)<\/published>/i) ?? [])[1] ??
      null;
    const publishedAt = dateRaw ? Date.parse(stripTags(dateRaw)) : NaN;

    // Atom puts the URL in href; RSS in the element body.
    const link =
      stripTags((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) ?? [])[1]) ||
      (block.match(/<link[^>]*href=["']([^"']+)["']/i) ?? [])[1] ||
      null;

    items.push({
      title,
      link,
      source,
      publishedAt: Number.isNaN(publishedAt) ? null : publishedAt,
    });
  }
  return items;
}

async function fetchFeed(feed, timeoutMs) {
  try {
    const res = await fetch(feed.url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'aegis-news-sentinel/1.0' },
    });
    if (!res.ok) return { ok: false, source: feed.name, error: `HTTP ${res.status}` };
    return { ok: true, source: feed.name, items: parseFeed(await res.text(), feed.name) };
  } catch (err) {
    return { ok: false, source: feed.name, error: err.message };
  }
}

/** CryptoPanic, when a token is configured. Returns [] rather than throwing. */
async function fetchCryptoPanic(token, timeoutMs) {
  if (!token) return { ok: false, source: 'CryptoPanic', error: 'no CRYPTOPANIC_TOKEN set' };
  try {
    const res = await fetch(
      `https://cryptopanic.com/api/v1/posts/?auth_token=${encodeURIComponent(token)}&public=true`,
      { signal: AbortSignal.timeout(timeoutMs) }
    );
    if (!res.ok) return { ok: false, source: 'CryptoPanic', error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    return {
      ok: true,
      source: 'CryptoPanic',
      items: (body.results ?? []).map((p) => ({
        title: stripTags(p.title),
        link: p.url ?? null,
        source: 'CryptoPanic',
        publishedAt: p.published_at ? Date.parse(p.published_at) : null,
      })),
    };
  } catch (err) {
    return { ok: false, source: 'CryptoPanic', error: err.message };
  }
}

/**
 * Pull the current headline window from every configured source.
 *
 * Sources are fetched in parallel and failures are REPORTED, not swallowed —
 * a sentinel that quietly runs on two of five feeds looks identical to one
 * running on all five, right up until it misses the story.
 */
export async function fetchBreakingNews({ config = {}, cryptoPanicToken = null, now = Date.now() } = {}) {
  const cfg = config.newsSentinel ?? {};
  const feeds = cfg.feeds ?? DEFAULT_FEEDS;
  const timeoutMs = cfg.timeoutMs ?? 12000;
  const windowMinutes = cfg.headlineWindowMinutes ?? 180;

  const results = await Promise.all([
    ...feeds.map((f) => fetchFeed(f, timeoutMs)),
    ...(cfg.useCryptoPanic !== false ? [fetchCryptoPanic(cryptoPanicToken, timeoutMs)] : []),
  ]);

  const cutoff = now - windowMinutes * 60_000;
  const items = [];
  const sources = [];
  for (const r of results) {
    sources.push({ source: r.source, ok: r.ok, count: r.items?.length ?? 0, error: r.error ?? null });
    for (const item of r.items ?? []) {
      // An item with no parseable date is kept: a feed that omits pubDate is a
      // formatting failure, not evidence the story is old.
      if (item.publishedAt !== null && item.publishedAt < cutoff) continue;
      items.push(item);
    }
  }

  items.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  return { items, sources, fetchedAt: now };
}

/* ------------------------------------------------------------------ *
 * Keyword matching
 * ------------------------------------------------------------------ */

/**
 * Which watched keywords appear in a headline.
 *
 * Word-boundary matched and case-insensitive. Boundaries matter more than they
 * look: a substring match for "PI" or "MON" hits half the English language,
 * and those are real trending tickers.
 */
export function extractKeywords(title, keywords) {
  const text = String(title ?? '').toLowerCase();
  const hits = [];
  for (const kw of keywords ?? []) {
    const needle = String(kw).toLowerCase().trim();
    if (!needle) continue;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)) hits.push(kw);
  }
  return hits;
}

const normalise = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Correlate one token with the headline window.
 *
 * A match requires BOTH:
 *   1. a watched keyword in the headline, and
 *   2. that keyword appearing in the token's own name or symbol.
 *
 * Requirement 2 is what makes this a correlation rather than a mood: without
 * it, every token scanned during a Binance story would be "news matched".
 *
 * `freshnessMinutes` bounds how recent the story must be. The point of the
 * feature is catching a launch that rides a headline, and a token minted three
 * hours after the story is not that.
 */
export function matchTokenToNews({ pair, news, config = {}, now = Date.now() }) {
  const cfg = config.newsSentinel ?? {};
  if (cfg.enabled === false) return { matched: false, keywords: [], headlines: [] };

  const keywords = cfg.keywords ?? [];
  const freshMs = (cfg.freshnessMinutes ?? 3) * 60_000;

  const symbol = normalise(pair?.baseToken?.symbol);
  const name = normalise(pair?.baseToken?.name);
  if (!symbol && !name) return { matched: false, keywords: [], headlines: [] };

  const hits = [];
  for (const item of news?.items ?? []) {
    if (item.publishedAt !== null && now - item.publishedAt > freshMs) continue;

    const found = extractKeywords(item.title, keywords);
    if (!found.length) continue;

    // The token itself must carry the keyword, not merely coexist with it.
    const tokenCarries = found.filter((kw) => {
      const k = normalise(kw);
      return k && (symbol.includes(k) || name.includes(k) || k.includes(symbol));
    });
    if (!tokenCarries.length) continue;

    hits.push({ ...item, keywords: tokenCarries, ageMinutes: item.publishedAt ? (now - item.publishedAt) / 60_000 : null });
  }

  const allKeywords = [...new Set(hits.flatMap((h) => h.keywords))];
  return {
    matched: hits.length > 0,
    keywords: allKeywords,
    headlines: hits.slice(0, 3),
    // Stated on every match, because the base rate here is bad.
    caveat:
      'A token named after a breaking story is the signature of an opportunistic launch as often as a real one. This routes it into the audit; it adds no score.',
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  const { loadEnv } = await import('./telegram.mjs');
  const env = await loadEnv(join(HERE, '.env'));

  const news = await fetchBreakingNews({ config, cryptoPanicToken: env.cryptoPanicToken });
  console.log('Sources:');
  for (const s of news.sources) {
    console.log(`  ${s.ok ? '✅' : '❌'} ${String(s.source).padEnd(14)} ${s.ok ? `${s.count} item(s)` : s.error}`);
  }

  const kws = config.newsSentinel?.keywords ?? [];
  console.log(`\nWatching ${kws.length} keyword(s): ${kws.join(', ')}`);
  console.log(`\n${news.items.length} headline(s) in the window:\n`);

  let hitCount = 0;
  for (const item of news.items.slice(0, 40)) {
    const hits = extractKeywords(item.title, kws);
    if (hits.length) hitCount++;
    const age = item.publishedAt ? `${((Date.now() - item.publishedAt) / 60000).toFixed(0)}m` : '  ?';
    console.log(`  ${hits.length ? '🔔' : '  '} [${age.padStart(4)}] ${item.title.slice(0, 92)}${hits.length ? `   << ${hits.join(', ')}` : ''}`);
  }
  console.log(`\n${hitCount} headline(s) carry a watched keyword.`);

  const i = process.argv.indexOf('--match');
  if (i !== -1 && process.argv[i + 1]) {
    const sym = process.argv[i + 1];
    const m = matchTokenToNews({
      pair: { baseToken: { symbol: sym, name: sym } },
      news,
      config,
    });
    console.log(`\n/match ${sym} -> ${m.matched ? `MATCHED (${m.keywords.join(', ')})` : 'no match'}`);
  }
}
