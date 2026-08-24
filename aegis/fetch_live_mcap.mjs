async function getLiveMcaps() {
  console.log('====================================================');
  console.log('LIVE REAL-TIME ON-CHAIN MARKET CAPS');
  console.log('====================================================\n');

  const tokens = [
    { name: '$GHOOK (Grok Hook)', query: '0x0093005884142Fb305A3991DCD24e55Bfebf1570' },
    { name: '$HOOKR (Hookr.fun)', query: '0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c' },
    { name: '$ARCANA ($ARCN)', query: '0xE3e3fb2f07CFE382D480197a3c8Ea0778cF51110' },
    { name: '$QUOTRONS ($QUOTRON)', query: '0x5a86828Efd322bfb16d93cFeD16EE9BC14940D7F' }
  ];

  for (const t of tokens) {
    const url = t.query.startsWith('0x')
      ? `https://api.dexscreener.com/latest/dex/tokens/${t.query}`
      : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(t.query)}`;
    
    try {
      const res = await fetch(url);
      const data = await res.json();
      const p = (data.pairs || [])[0];
      if (p) {
        console.log(`${t.name}:`);
        console.log(`  - Price USD        : $${p.priceUsd}`);
        console.log(`  - Real-Time MCap   : $${(p.fdv || p.marketCap || 0).toLocaleString()}`);
        console.log(`  - Liquidity Depth  : $${(p.liquidity?.usd || 0).toLocaleString()}`);
        console.log(`  - 24h Volume       : $${(p.volume?.h24 || 0).toLocaleString()}`);
        console.log(`  - 24h Price Change : ${p.priceChange?.h24 || 0}%\n`);
      } else {
        console.log(`${t.name}: No active pair on DexScreener API\n`);
      }
    } catch (e) {
      console.log(`Error fetching ${t.name}: ${e.message}\n`);
    }
  }
}

getLiveMcaps();
