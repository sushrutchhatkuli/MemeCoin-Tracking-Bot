# Deploying Aegis to Render

The repo is already initialised and committed locally. Two steps remain: push to
GitHub, then point Render at it.

---

## What actually changes in the cloud

Read this before deciding, because it affects what you get.

| | Local (Windows Task Scheduler) | Render Cron Job |
| --- | --- | --- |
| Telegram alerts + digest | ✅ | ✅ |
| Obsidian vault notes | ✅ writes to your vault | ❌ **discarded** — vault is on your PC |
| Holder growth velocity | ✅ real deltas | ❌ always "baseline" |
| Deployer index compounding | ✅ 284 wallets and growing | ❌ rebuilds from zero each run |
| Alert cooldown | ✅ | ❌ can re-alert every 12 min |
| Runs when PC is off | ❌ | ✅ |

All four ❌ rows have the same cause: **Render cron containers are ephemeral**.
Each run starts from a clean filesystem, so `aegis/.state/` is empty and anything
written is thrown away when the run exits.

**The practical recommendation: run both.** Keep the local scheduled task for the
vault and the compounding deployer index; use Render for 24/7 Telegram coverage
when your PC is off. They do not conflict — worst case you get a duplicate alert.

If you want state to persist in the cloud, use the **Background Worker + disk**
option that is commented out at the bottom of `render.yaml`. Cron Jobs cannot
mount disks on Render; Background Workers can.

> Note on cost: Render Cron Jobs and Background Workers are both paid services.
> There is no free tier for either. Check current pricing before deploying.

---

## Step 1 — Push to GitHub

Create an **empty** repo at https://github.com/new — name it `memecoin-tracker`,
and do **not** add a README, .gitignore or licence (the repo already has them).

Then, from `C:\Users\sushr\Documents\Memecoin Potential Finder`:

```bash
git branch -M main
```

```bash
git remote add origin https://github.com/YOUR_USERNAME/memecoin-tracker.git
```

```bash
git push -u origin main
```

If GitHub prompts for a password, it wants a **Personal Access Token**, not your
account password: GitHub → Settings → Developer settings → Personal access tokens
→ Tokens (classic) → Generate new token → tick `repo` scope.

### Verify the secret did not ship

```bash
git ls-files | grep -E "\.env$|\.state/"
```

That must print **nothing**. It was verified clean before the commit, but check
again after pushing — it costs two seconds and a leaked bot token lets anyone
post to your chat.

---

## Step 2 — Connect Render

1. https://dashboard.render.com → **New** → **Blueprint**
2. Connect your GitHub account, authorise access to `memecoin-tracker`
3. Render detects `render.yaml` and proposes the **aegis-scanner** cron job
4. It will prompt for the three `sync: false` secrets:

   | Key | Where to get it |
   | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | Copy from your local `aegis/.env` (never commit it) |
   | `TELEGRAM_CHAT_ID` | Copy from your local `aegis/.env` |
   | `SOLANA_RPC_URL` | Your Helius/QuickNode URL, or leave blank |

   > Values are intentionally not written down in this repo. `aegis/.env` is
   > gitignored and is the only place they should live.

5. **Apply** / **Create Blueprint**

Because your existing Render project is named "Memecoin Tracker", attach the new
service to it when prompted rather than creating a second project.

### Verify it works

Don't wait 12 minutes. In the Render dashboard open **aegis-scanner** → **Trigger
Run**, then watch **Logs**. A healthy run looks like:

```
📲 Telegram: configured (alerts at BUY SIGNAL, score ≥ 75)
👨‍💻 Deployer index: +7 new launch(es), 7 deployer(s) tracked
🔎 Discovering launches on: solana, base, ethereum, bsc
👀 $SENSE  61/100  WATCH  sec:PASSED  5m 332/404  liq 23%
📊 Scan digest sent to Telegram
```

A digest should hit your phone within a few seconds. `7 deployer(s) tracked`
instead of `284` is the ephemeral filesystem — expected, not a fault.

---

## Tuning without redeploying

Every setting below is a Render environment variable. Change it in the dashboard
and the next run picks it up — no code change, no redeploy.

| Variable | Default | Effect |
| --- | --- | --- |
| `TELEGRAM_SEND_DIGEST` | `true` | Push every verdict each scan |
| `TELEGRAM_MIN_SCORE` | `75` | Score floor for a BUY SIGNAL alert |
| `TELEGRAM_COOLDOWN_HOURS` | `6` | Per-token alert cooldown |
| `WRITE_NOTES` | `false` | Notes cannot reach your vault from Render |
| `SCAN_LIMIT` | `25` | Pairs audited per run |
| `SOLANA_RPC_URL` | — | Dedicated RPC; removes the buyer-replay throttle |

### On message volume

At 12-minute intervals the digest sends **120 messages a day**. That is a lot.
If it becomes noise, either set `TELEGRAM_SEND_DIGEST=false` (you keep BUY SIGNAL
alerts only) or move the cron to `*/30 * * * *` for 48/day.

---

## Rolling back

- Pause the cloud job: Render dashboard → aegis-scanner → **Suspend**
- Remove the local job: `.\schedule-task.ps1 -Remove` from `aegis/`
