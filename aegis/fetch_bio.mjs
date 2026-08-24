async function fetchBio() {
  const url = 'https://api.dexscreener.com/latest/dex/search?q=BIO';
  const res = await fetch(url);
  const data = await res.json();
  
  console.log('====================================================');
  console.log('BIO PROTOCOL ($BIO) ON-CHAIN METRICS');
  console.log('====================================================\n');

  const pairs = (data.pairs || []).filter(p => p.baseToken.symbol === 'BIO' || p.baseToken.name.toLowerCase().includes('bio'));
  
  pairs.slice(0, 5).forEach((p, i) => {
    console.log(`BIO Pair #${i+1}:`);
    console.log(`  Chain: ${p.chainId} | DEX: ${p.dexId}`);
    console.log(`  Symbol: ${p.baseToken.symbol} | Name: ${p.baseToken.name}`);
    console.log(`  Contract: ${p.baseToken.address}`);
    console.log(`  Price USD: $${p.priceUsd}`);
    console.log(`  FDV / MCap: $${(p.fdv || p.marketCap || 0).toLocaleString()}`);
    console.log(`  Liquidity USD: $${(p.liquidity?.usd || 0).toLocaleString()}`);
    console.log(`  Volume 24h: $${(p.volume?.h24 || 0).toLocaleString()}`);
    console.log(`  DexScreener URL: ${p.url}\n`);
  });
}

fetchBio();
