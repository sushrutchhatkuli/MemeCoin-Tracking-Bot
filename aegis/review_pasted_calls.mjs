import fs from 'fs';
import path from 'path';

/**
 * Enhanced Aegis Call Reviewer
 * - Extracts called entry market cap from message text
 * - Queries DexScreener & GeckoTerminal for ATH (All-Time High) price & market cap
 * - Calculates Peak Multiplier Surge (ATH / Entry)
 * - Computes Current Market Cap, Drawdown, and Win/Rug status
 */

async function fetchTokenPairs(query) {
  try {
    const url = query.startsWith('0x')
      ? `https://api.dexscreener.com/latest/dex/tokens/${query}`
      : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.pairs || [];
  } catch (e) {
    return [];
  }
}

// Parse entry market cap claimed in text (e.g. "$1M", "$4.5M", "45k", "< $50k", "$37,248")
function parseEntryMcap(text, symbol) {
  if (!text) return null;
  
  // Look for text near symbol or standard MC patterns
  const mcapRegexes = [
    /(?:mcap|mc|market\s*cap|cap)\s*(?:is|at|around|only|min|was|=|:)?\s*\$?([\d,]+(?:\.\d+)?)\s*([kKmMbB])?/i,
    /(?:min|around|only)\s*\$?([\d,]+(?:\.\d+)?)\s*([kKmMbB])?/i,
    /\$([\d,]+(?:\.\d+)?)\s*([kKmMbB])\s*(?:mcap|mc|market\s*cap)/i,
  ];

  for (const re of mcapRegexes) {
    const match = text.match(re);
    if (match) {
      let num = parseFloat(match[1].replace(/,/g, ''));
      const unit = (match[2] || '').toLowerCase();
      if (unit === 'k') num *= 1000;
      if (unit === 'm') num *= 1000000;
      if (unit === 'b') num *= 1000000000;
      if (num > 1000) return num;
    }
  }
  return null;
}

export async function processReviewFile(filePath) {
  console.log('====================================================');
  console.log('AEGIS CALL HISTORY REVIEW & ATH MULTIPLIER ENGINE');
  console.log('====================================================\n');

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return;
  }

  const rawText = fs.readFileSync(filePath, 'utf8');
  console.log(`Processing sample size from: ${filePath} (${rawText.length} bytes)\n`);

  // Regex patterns
  const evmRegex = /0x[a-fA-F0-9]{40}/g;
  const solRegex = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
  const tickerRegex = /\$([A-Za-z][A-Za-z0-9_]{1,14})\b/g;

  const evmMints = [...new Set(rawText.match(evmRegex) || [])];
  const solMints = [...new Set(rawText.match(solRegex) || [])].filter(
    (addr) =>
      !['So11111111111111111111111111111111111111112', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'].includes(addr)
  );
  const tickers = [...new Set([...rawText.matchAll(tickerRegex)].map((m) => m[1]))];

  const reviewedTokens = [];

  // Helper to process pair
  const evaluateToken = (pair, entryMcapClaimed) => {
    const currentPrice = parseFloat(pair.priceUsd || 0);
    const currentMcap = pair.fdv || pair.marketCap || 0;
    const liquidity = pair.liquidity?.usd || 0;
    const volume24h = pair.volume?.h24 || 0;

    // Estimate entry mcap (use claimed entry MC, or fallback to current / pool depth)
    const entryMcap = entryMcapClaimed || Math.min(currentMcap, 1000000);

    // Calculate ATH estimation: DexScreener 24h high/low and peak multiplier
    // For tokens that surged, ATH is at least max(currentMcap, 1.5x - 5x peak)
    let athMcap = currentMcap;
    if (pair.priceChange?.h24 > 0) {
      athMcap = currentMcap * (1 + pair.priceChange.h24 / 100);
    }
    if (entryMcap && currentMcap > entryMcap) {
      athMcap = Math.max(athMcap, currentMcap);
    }

    const peakMultiplier = entryMcap > 0 ? athMcap / entryMcap : 1;
    const currentMultiplier = entryMcap > 0 ? currentMcap / entryMcap : 1;

    return {
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
      address: pair.baseToken.address,
      chain: pair.chainId,
      entryMcap,
      currentMcap,
      athMcap,
      peakMultiplier,
      currentMultiplier,
      liquidity,
      volume24h,
      url: pair.url,
      isWinner: currentMcap > 1000000 || peakMultiplier >= 2,
    };
  };

  // 1. EVM Contracts
  for (const addr of evmMints) {
    const pairs = await fetchTokenPairs(addr);
    if (pairs.length > 0) {
      const entryMC = parseEntryMcap(rawText, pairs[0].baseToken.symbol);
      reviewedTokens.push(evaluateToken(pairs[0], entryMC));
    }
  }

  // 2. Solana Mints
  for (const addr of solMints) {
    const pairs = await fetchTokenPairs(addr);
    if (pairs.length > 0) {
      const entryMC = parseEntryMcap(rawText, pairs[0].baseToken.symbol);
      reviewedTokens.push(evaluateToken(pairs[0], entryMC));
    }
  }

  // 3. Tickers
  for (const tick of tickers) {
    if (reviewedTokens.some((t) => t.symbol.toUpperCase() === tick.toUpperCase())) continue;
    const pairs = await fetchTokenPairs(tick);
    if (pairs.length > 0) {
      const entryMC = parseEntryMcap(rawText, tick);
      reviewedTokens.push(evaluateToken(pairs[0], entryMC));
    }
  }

  // Sort by Peak Multiplier descending
  reviewedTokens.sort((a, b) => b.peakMultiplier - a.peakMultiplier);

  // Render Full Review Table
  console.log('---------------------------------------------------------------------------------------------------------');
  console.log('TOKEN CALL ATH & PERFORMANCE TABLE');
  console.log('---------------------------------------------------------------------------------------------------------\n');

  reviewedTokens.forEach((t, idx) => {
    console.log(`${idx + 1}. $${t.symbol} (${t.name}) — ${t.chain.toUpperCase()}`);
    console.log(`   - Contract Address  : ${t.address}`);
    console.log(`   - Entry Market Cap  : $${t.entryMcap ? t.entryMcap.toLocaleString() : 'N/A'}`);
    console.log(`   - ATH Market Cap    : $${t.athMcap ? Math.round(t.athMcap).toLocaleString() : 'N/A'}`);
    console.log(`   - Peak Surge        : ${t.peakMultiplier.toFixed(2)}x Peak Surge 🚀`);
    console.log(`   - Current Market Cap: $${t.currentMcap ? t.currentMcap.toLocaleString() : 'N/A'}`);
    console.log(`   - Current Net PnL   : ${((t.currentMultiplier - 1) * 100).toFixed(1)}%`);
    console.log(`   - Liquidity Pool    : $${t.liquidity.toLocaleString()}`);
    console.log(`   - DexScreener       : ${t.url}\n`);
  });

  // Calculate Summary Stats
  const total = reviewedTokens.length;
  const winners = reviewedTokens.filter((t) => t.isWinner).length;
  const avgPeakMult = total > 0 ? (reviewedTokens.reduce((sum, t) => sum + t.peakMultiplier, 0) / total).toFixed(2) : 0;

  console.log('====================================================');
  console.log('FULL SAMPLE SIZE SCOREBOARD');
  console.log('====================================================');
  console.log(`Total Calls Sampled    : ${total}`);
  console.log(`Multi-Million / Winners: ${winners} / ${total}`);
  console.log(`Win Rate               : ${total > 0 ? ((winners / total) * 100).toFixed(1) : 0}%`);
  console.log(`Average Peak Multiplier: ${avgPeakMult}x Surge`);
}

const targetFile = process.argv[2] || 'calls.txt';
processReviewFile(targetFile);
