#!/usr/bin/env bash
# Watches the elite-whale ledger until its sample resembles the real market,
# then syncs.
#
# The open question is not "has any failure landed" — that was answered. It is
# whether the ledger's token-level failure rate CONVERGES toward the rate the
# post-mortem measures across all scanned tokens, or PLATEAUS well below it.
#
#   converges -> the replay channel is fine, it just needed volume
#   plateaus  -> buyer replay is structurally biased toward survivors, and the
#                fix is to change how buyers are captured, not to wait longer
#
# So this records a time series rather than a yes/no. Polls every 30 minutes for
# up to 8 hours. Exits 0 if the sync runs, 2 on timeout.

cd "$(dirname "$0")" || exit 1
LOG="maturity_watch.log"
MAX_CHECKS=16
SLEEP_SECONDS=1800

{
  echo ""
  echo "=== representativeness watch started $(date -u '+%Y-%m-%d %H:%M:%S') UTC ==="
  echo "    tracking token-level failure rate vs post-mortem base rate"
  printf "    %-9s %8s %8s %9s %9s %9s %9s\n" TIME WALLETS TOKENS DECIDED TOKFAIL% BASE% NEEDED%
} >>"$LOG"

for i in $(seq 1 "$MAX_CHECKS"); do
  STATS=$(node -e "
    const fs=require('fs');
    let o={wallets:{}}; try{o=JSON.parse(fs.readFileSync('.state/wallet_observations.json','utf8'));}catch{}
    const buys=Object.values(o.wallets).flatMap(e=>e.buys);
    const byTok=new Map();
    for(const b of buys){ if(b.outcome&&b.outcome!=='NEUTRAL'&&!byTok.has(b.token)) byTok.set(b.token,b.outcome); }
    const decided=byTok.size;
    const fails=[...byTok.values()].filter(v=>v==='FAIL').length;
    const tokFail = decided? (100*fails/decided) : 0;
    let base=0;
    try{
      const h=JSON.parse(fs.readFileSync('learning_history.json','utf8'));
      const c=(h.outcomes||[]).reduce((a,x)=>{a[x.verdict]=(a[x.verdict]||0)+1;return a;},{});
      const d=(c.FAIL||0)+(c.WIN||0);
      if(d>=50) base=100*(c.FAIL||0)/d;
    }catch{}
    console.log([Object.keys(o.wallets).length, new Set(buys.map(b=>b.token)).size, decided,
                 tokFail.toFixed(1), base.toFixed(1), (base*0.5).toFixed(1)].join(' '));
  " 2>/dev/null)

  read -r WALLETS TOKENS DECIDED TOKFAIL BASE NEEDED <<<"$STATS"
  printf "    %-9s %8s %8s %9s %9s %9s %9s\n" \
    "$(date -u '+%H:%M:%S')" "$WALLETS" "$TOKENS" "$DECIDED" "$TOKFAIL" "$BASE" "$NEEDED" >>"$LOG"

  # Only attempt a sync once there is a non-trivial decided sample; below that
  # the rate swings wildly on single tokens.
  if [ "${DECIDED:-0}" -ge 8 ] && awk "BEGIN{exit !($TOKFAIL >= $NEEDED)}"; then
    echo "    -> representative ($TOKFAIL% >= $NEEDED% over $DECIDED tokens), syncing" >>"$LOG"
    node auto_top_whales.mjs >>"$LOG" 2>&1
    echo "=== sync complete, watch exiting ===" >>"$LOG"
    exit 0
  fi

  [ "$i" -lt "$MAX_CHECKS" ] && sleep "$SLEEP_SECONDS"
done

echo "=== timed out after $MAX_CHECKS checks — see trajectory above ===" >>"$LOG"
exit 2
