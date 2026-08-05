#!/usr/bin/env bash
# Watches the elite-whale ledger until it is mature enough to rank, then syncs.
#
# "Mature" = at least one FAIL has been graded. Until then every observed win
# rate reads ~100% and ranking would fabricate an elite list from survivorship
# bias, so the sync refuses to write.
#
# Polls every 20 minutes for up to 5 hours. Exits 0 on a successful sync,
# 2 if it timed out still immature. Progress is appended to maturity_watch.log.

cd "$(dirname "$0")" || exit 1
LOG="maturity_watch.log"
MAX_CHECKS=15
SLEEP_SECONDS=1200

echo "=== maturity watch started $(date -u '+%Y-%m-%d %H:%M:%S') UTC ===" >>"$LOG"

for i in $(seq 1 "$MAX_CHECKS"); do
  STATS=$(node -e "
    const fs=require('fs');
    let o={wallets:{}};
    try{o=JSON.parse(fs.readFileSync('.state/wallet_observations.json','utf8'));}catch{}
    const buys=Object.values(o.wallets).flatMap(e=>e.buys);
    const g=buys.filter(b=>b.outcome);
    const c={}; for(const b of g) c[b.outcome]=(c[b.outcome]||0)+1;
    console.log([Object.keys(o.wallets).length, buys.length, g.length, c.WIN||0, c.FAIL||0, c.NEUTRAL||0].join(' '));
  " 2>/dev/null)

  read -r WALLETS BUYS GRADED WINS FAILS NEUTRAL <<<"$STATS"
  TS=$(date -u '+%H:%M:%S')
  echo "[$TS] check $i/$MAX_CHECKS — wallets:$WALLETS buys:$BUYS graded:$GRADED win:$WINS fail:$FAILS neutral:$NEUTRAL" >>"$LOG"

  if [ "${FAILS:-0}" -gt 0 ]; then
    echo "[$TS] ledger MATURE ($FAILS failure(s) graded) — running sync" >>"$LOG"
    node auto_top_whales.mjs >>"$LOG" 2>&1
    echo "=== sync complete, watch exiting ===" >>"$LOG"
    exit 0
  fi

  [ "$i" -lt "$MAX_CHECKS" ] && sleep "$SLEEP_SECONDS"
done

echo "=== timed out after $MAX_CHECKS checks, still no graded failures ===" >>"$LOG"
exit 2
