async function searchAllPairs(query) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.pairs || [];
}

async function deepSearch() {
  console.log('====================================================');
  console.log('DEEP DEXSCREENER SEARCH FOR $ARCANA / $ARCN / $GHOOK / $HOOKR');
  console.log('====================================================\n');

  const queries = ['ARCANA', 'ARCN', 'GHOOK', 'HOOKR', 'QUOTRONS', '0xE3e3fb2f07CFE382D480197a3c8Ea0778cF51110'];

  for (const q of queries) {
    console.log(`\n=== QUERY: "${q}" ===`);
    const pairs = await searchAllPairs(q);
    console.log(`Found ${pairs.length} pair(s).`);
    
    pairs.sort((a,b) => (b.fdv || b.marketCap || 0) - (a.fdv || a.marketCap || 0));

    pairs.slice(0, 5).forEach((p, idx) => {
      console.log(`\n  Pair #${idx+1}: ${p.baseToken.name} ($${p.baseToken.symbol})`);
      console.log(`  Chain: ${p.chainId} | DEX: ${p.dexId}`);
      console.log(`  Contract: ${p.baseToken.address}`);
      console.log(`  Pair Address: ${p.pairAddress}`);
      console.log(`  Current Price: $${p.priceUsd}`);
      console.log(`  FDV / MCap: $${(p.fdv || p.marketCap || 0).toLocaleString()}`);
      console.log(`  Liquidity: $${(p.liquidity?.usd || 0).toLocaleString()}`);
      console.log(`  Volume 24h: $${(p.volume?.h24 || 0).toLocaleString()}`);
      console.log(`  Url: ${p.url}`);
    });
  }
}

deepSearch();
