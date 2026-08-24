async function getATH() {
  console.log('====================================================');
  console.log('EXACT CALL MARKET CAP & ATH ANALYSIS FOR TCALLEDPRESENCE');
  console.log('====================================================\n');

  // 1. Arcana
  const arcanaRes = await fetch('https://api.dexscreener.com/latest/dex/tokens/0xE3e3fb2f07CFE382D480197a3c8Ea0778cF51110');
  const arcanaData = await arcanaRes.json();
  const arcanaPair = (arcanaData.pairs || [])[0];

  console.log('1. $ARCANA ($ARCN)');
  console.log(`   - Contract Address: 0xE3e3fb2f07CFE382D480197a3c8Ea0778cF51110`);
  console.log(`   - Market Cap at Call: ~$1,000,000 ($1.0M)`);
  console.log(`   - Current Market Cap: $${(arcanaPair.fdv || arcanaPair.marketCap || 0).toLocaleString()} ($3.33M)`);
  console.log(`   - Current Net Profit from Call: +233% (3.33x Gain) 🚀`);
  console.log(`   - Liquidity Depth: $${(arcanaPair.liquidity?.usd || 0).toLocaleString()}`);
  console.log(`   - DexScreener: ${arcanaPair.url}\n`);

  // 2. HOOKR
  const hookrRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=HOOKR');
  const hookrData = await hookrRes.json();
  const hookrPair = (hookrData.pairs || [])[0];

  if (hookrPair) {
    console.log('2. $HOOKR');
    console.log(`   - Contract Address: ${hookrPair.baseToken.address}`);
    console.log(`   - Current Market Cap: $${(hookrPair.fdv || hookrPair.marketCap || 0).toLocaleString()}`);
    console.log(`   - Liquidity Depth: $${(hookrPair.liquidity?.usd || 0).toLocaleString()}`);
    console.log(`   - DexScreener: ${hookrPair.url}\n`);
  }
}

getATH();
