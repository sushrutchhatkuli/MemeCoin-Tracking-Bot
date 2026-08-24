async function checkArcana() {
  const url = 'https://api.dexscreener.com/latest/dex/tokens/0xE3e3fb2f07CFE382D480197a3c8Ea0778cF51110';
  const res = await fetch(url);
  const data = await res.json();
  
  console.log('====================================================');
  console.log('EXACT ON-CHAIN DATA FOR $ARCANA / $ARCN (0xE3e3...1110)');
  console.log('====================================================\n');

  if (!data.pairs || data.pairs.length === 0) {
    console.log('No pairs found on DexScreener for 0xE3e3fb2f07CFE382D480197a3c8Ea0778cF51110');
    return;
  }

  data.pairs.forEach((p, i) => {
    console.log(`Pair #${i+1}:`);
    console.log(`  Token Name: ${p.baseToken.name} ($${p.baseToken.symbol})`);
    console.log(`  Chain: ${p.chainId} | DEX: ${p.dexId}`);
    console.log(`  Contract: ${p.baseToken.address}`);
    console.log(`  Pair Address: ${p.pairAddress}`);
    console.log(`  Current Price: $${p.priceUsd}`);
    console.log(`  Market Cap / FDV: $${(p.fdv || p.marketCap || 0).toLocaleString()}`);
    console.log(`  Liquidity USD: $${(p.liquidity?.usd || 0).toLocaleString()}`);
    console.log(`  Volume 24h: $${(p.volume?.h24 || 0).toLocaleString()}`);
    console.log(`  Price Change 24h: ${p.priceChange?.h24 || 0}%`);
    console.log(`  DexScreener URL: ${p.url}\n`);
  });
}

checkArcana();
