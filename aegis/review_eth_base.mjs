import fs from 'fs';

async function lookupToken(query) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    return data.pairs || [];
  } catch (e) {
    return [];
  }
}

async function analyzeCalls() {
  console.log('====================================================');
  console.log('TCALLEDPRESENCE CALLS REVIEW & ON-CHAIN AUDIT');
  console.log('====================================================\n');

  const targets = [
    { query: '0xE3e3fb2f07CFE382D480197a3c8Ea0778cF51110', name: '$GHOOK (Contract: 0xE3e3...1110)', callClaim: '10x ez', claimedMcap: 'Low cap < $50k' },
    { query: 'ARCANA', name: '$ARCANA / $ARCN', callClaim: '5x min', claimedMcap: '$1M' },
    { query: 'HOOKR', name: '$HOOKR', callClaim: 'Bridge / Ecosystem', claimedMcap: 'N/A' },
    { query: 'QUOTRONS', name: '$QUOTRONS', callClaim: 'Explode benchmark', claimedMcap: 'N/A' }
  ];

  for (const t of targets) {
    console.log(`----------------------------------------------------`);
    console.log(`🔍 Token Call: ${t.name}`);
    console.log(`   Claimed Target: ${t.callClaim} | Claimed MCap: ${t.claimedMcap}`);
    
    const pairs = await lookupToken(t.query);
    if (!pairs || pairs.length === 0) {
      console.log(`   Result: ❌ NO ACTIVE DEX PAIR FOUND (Likely Rugged, Dead, or Delisted)\n`);
      continue;
    }

    const topPair = pairs[0];
    const priceUsd = parseFloat(topPair.priceUsd || 0);
    const mcap = topPair.fdv || topPair.marketCap || 0;
    const liquidity = topPair.liquidity ? topPair.liquidity.usd : 0;
    const change24h = topPair.priceChange ? topPair.priceChange.h24 : 0;

    console.log(`   Chain: ${topPair.chainId} | DEX: ${topPair.dexId}`);
    console.log(`   Pair Address: ${topPair.pairAddress}`);
    console.log(`   Contract: ${topPair.baseToken.address}`);
    console.log(`   Current Price: $${priceUsd}`);
    console.log(`   Current Market Cap: $${mcap.toLocaleString()}`);
    console.log(`   Current Liquidity: $${liquidity.toLocaleString()}`);
    console.log(`   24h Change: ${change24h}%`);
    
    // Performance evaluation
    if (mcap < 10000 || liquidity < 2000) {
      console.log(`   VERDICT: 🔴 DEAD / RUGGED (FDV: $${mcap.toLocaleString()}, Liq: $${liquidity.toLocaleString()})\n`);
    } else if (mcap > 5000000) {
      console.log(`   VERDICT: 🚀 MASSIVE RUNNER / LEGIT WINNER (MCap: $${mcap.toLocaleString()})\n`);
    } else {
      console.log(`   VERDICT: 🟡 ACTIVE / MODERATE (MCap: $${mcap.toLocaleString()})\n`);
    }
  }
}

analyzeCalls();
