#!/usr/bin/env node
/**
 * Automated Top-50 Elite Whale Sync — Composite Elite Ranking.
 *
 *   node auto_top_whales.mjs                 rank from Aegis's own observations
 *   node auto_top_whales.mjs --import <file> rank from a leaderboard export
 *   node auto_top_whales.mjs --dry-run       report only, do not write
 *   node auto_top_whales.mjs --report        show current qualification progress
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE ARE TWO MODES
 *
 * The three ranking rules need win rate, realized P&L and lifetime trade count
 * per wallet. Getting those for *the whole of Solana* requires enumerating every
 * trader, and no provider exposes that: GMGN returns 403 behind Cloudflare,
 * Birdeye and Dune return 401 without a paid key, Cielo's public feed is empty,
 * Solscan refuses the connection. Verified, not assumed.
 *
 * So the top-50 list cannot be *fetched*. It can be:
 *
 *   OBSERVE mode (default) — earned. Aegis already replays pool trades and sees
 *   real buyers; the post-mortem already grades those tokens WIN/FAIL. Joining
 *   them produces a leaderboard derived from Aegis's own evidence, tuned to the
 *   exact token population it scans. It starts empty and compounds daily, the
 *   same way the deployer index reached 600+ entries without any feed.
 *
 *   IMPORT mode — seeded. Point --import at a CSV/JSON export from GMGN, Cielo,
 *   Birdeye or Dune. The three composite rules are applied strictly to that
 *   data, so the ranking logic is identical; only the source differs.
 *
 * What this module will NOT do is invent 50 plausible-looking addresses with
 * plausible-looking win rates. That would manufacture exactly the false signal
 * the scanner exists to filter out.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';

import { loadObservations, walletStats } from './wallet_observations.mjs';
import { validateWatchlistEntry, SYSTEM_ACCOUNTS, screenSystemAccount } from './smart_money.mjs';
import { loadEnv } from './telegram.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Composite Elite Ranking
 * ------------------------------------------------------------------ */

/**
 * eliteWhales keys that are real settings but are NOT rule thresholds, so they
 * legitimately have no entry in ELITE_RULES. Listed explicitly rather than
 * pattern-matched: the point of the check below is to catch a NAME that looks
 * like a rule and is read by nothing, and a loose pattern would wave those
 * through alongside these.
 */
const KNOWN_NON_RULE_KEYS = new Set([
  'enabled', 'observe', 'syncIntervalHours', 'enrichShortlistCap',
  'minRepresentativeness', 'profitRule', 'historyPageDelayMs',
  'pnlMaxPages', 'pnlSwapsOnly', 'pnlDelayMs', 'pnlTimeoutMs',
]);

/**
 * Report eliteWhales settings that no rule reads. PURE.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A threshold that is not read is worse than a missing one, because the config
 * file then states a rule the sync does not enforce and the operator has no way
 * to tell from the outside. It has happened twice here and both are on record:
 * `allTimeWinRateFloor: 0.50` was requested while the real floor stayed at 70
 * and the sync kept qualifying nobody, and `minOnChainTrades` / `minTrades`
 * were requested for a 50-closed-trade bar that actually lives in
 * `minAllTimeTrades`.
 *
 * Comment blocks are excluded — this file's configuration convention is that
 * anything starting with `_` is documentation.
 */
export function findUnreadRuleKeys(eliteWhalesConfig = {}, defaults = ELITE_RULES) {
  return Object.keys(eliteWhalesConfig ?? {}).filter(
    (k) => !k.startsWith('_') && !(k in defaults) && !KNOWN_NON_RULE_KEYS.has(k)
  );
}

export const ELITE_RULES = {
  minWinRatePct: 75,
  minNetProfitUsd: 50_000,
  minLifetimeTrades: 100,
  topN: 50,
  // A win rate over 2 graded trades is noise. Without a floor, the first wallet
  // to catch one pump would enter the list at 100%.
  minGradedBuys: 10,
  // Rule 4, OFF by default. Null means "do not enforce", so a config that has
  // not opted in keeps exactly the previous three-rule behaviour rather than
  // emptying the watchlist on upgrade.
  minAllTimeWinRatePct: null,
  minAllTimeTrades: 15,
  maxHistoryPages: 12,
  dustTradeSol: 0.05,
  // Rule 5 and the fast-track, both OFF by default so an un-opted config keeps
  // its previous behaviour rather than changing what qualifies on upgrade.
  minAllTimeNetSol: null,
  alphaHunterMegaWins: null,
  alphaHunterMinMultiplier: 50,
  alphaHunterMaxMultiplier: 500,
  // Bounds the on-chain replay, which is the expensive half of a sync.
  maxOnChainReplays: 40,
  historyCacheTtlHours: 24,
  maxCacheEntries: 500,
  maxCacheAgeDays: 30,
};

/**
 * Mega-runners a wallet was credited with catching early. PURE.
 *
 * Reads multiplier_engine's alpha ledger, where each harvested recap win writes
 * `alpha.awarded[token] = { multiplier, points, symbol, at }`. Counted inside
 * the configured band: the floor excludes ordinary winners, and the CEILING
 * excludes absurd multipliers, which on a memecoin are usually a mispriced
 * first trade rather than a 900x — the same reason detectCatalysts pairs every
 * ratio with a count floor.
 *
 * ── READ THIS BEFORE TRUSTING A megaWinCount ────────────────────────────────
 * These credits are awarded BECAUSE a wallet was present at a token that won —
 * selection on the outcome. multiplierEngine's own note spends a paragraph on
 * why that establishes nothing on its own: every buyer of a 42x looks brilliant
 * afterwards, including the ones who bought a hundred rugs the same week, and
 * recap channels publish winners while omitting losers. Two such credits is a
 * stronger signal than one, but it is still two draws from a biased urn.
 */
export function countMegaWins(entry, { minMultiplier = 50, maxMultiplier = 500 } = {}) {
  const awarded = Object.values(entry?.alpha?.awarded ?? {});
  const qualifying = awarded.filter(
    (a) =>
      typeof a?.multiplier === 'number' &&
      Number.isFinite(a.multiplier) &&
      a.multiplier >= minMultiplier &&
      a.multiplier <= maxMultiplier
  );
  return {
    megaWinCount: qualifying.length,
    megaWins: qualifying.map((a) => ({
      multiplier: a.multiplier,
      symbol: a.symbol ?? null,
      at: a.at ?? null,
    })),
  };
}

/**
 * ── GMGN FIELDS ARE READ FIRST AND NOTHING WRITES THEM YET ──────────────────
 *
 * Both helpers below check a `gmgn*` field ahead of everything else. That order
 * is correct — a provider's own lifetime P&L beats anything derivable here, and
 * beats it by a wide margin, because Aegis can only replay a bounded window
 * while GMGN reports a career.
 *
 * But NO CODE IN THIS REPO SETS EITHER FIELD, so today the check always falls
 * through and the ranking is byte-identical to what it was without it. This is
 * a seam, not a feature, and it is deliberately inert rather than pretending.
 *
 * WHY IT IS INERT, MEASURED 2026-08-12 rather than assumed:
 *   https://gmgn.ai/api/v1/wallet_stat/sol/<addr>/7d              HTTP 403
 *   https://gmgn.ai/defi/quotation/v1/smartmoney/sol/walletNew/…  HTTP 403
 * Both answer with a Cloudflare challenge page, not JSON. network_discovery.mjs
 * records the same finding and ships GMGN as a deep link for a human to click
 * precisely because the numbers cannot be fetched. Defeating that challenge is
 * not something this codebase should do.
 *
 * THE ROUTE THAT WORKS TODAY is the import path, which already parses GMGN's
 * own column names — `realized_profit` is in the PROFIT alias list and
 * normaliseWinRate handles GMGN's 0.62-style fractions:
 *   node auto_top_whales.mjs --import <gmgn-export.csv>
 * An imported row arrives with providerMetrics true, carrying the provider's
 * lifetime figures in netProfitUsd and winRatePct.
 *
 * To make these fields live, populate candidate.gmgnNetProfitUsd and
 * candidate.gmgnWinRatePct during enrichment. Anything writing them MUST use
 * the same units as everything else here: whole US dollars, and win rate as a
 * PERCENTAGE (62, not 0.62). A fraction written here would rank every GMGN
 * wallet below every observed one and look like a data problem rather than a
 * unit problem.
 */

/**
 * The USD profit figure the ranking sorts on. PURE.
 *
 * Prefers GMGN's lifetime P&L, then allTimeNetProfitUsd — the wallet's OWN
 * realized SOL from the on-chain replay, priced at the live rate — and falls
 * back to netProfitUsd. Below the GMGN step this is the same precedence Rule 2
 * applies, deliberately: ranking on a different number from the one that
 * decided qualification is the defect the watchlist header already warns about.
 *
 * NOTE that Rule 2 does NOT read the GMGN field. So once these are populated a
 * wallet could be RANKED on a career P&L while having been QUALIFIED on a
 * bounded replay. That is the right way round — the stricter, self-measured
 * figure decides admission and the richer one decides order — but it is a
 * divergence worth knowing about rather than discovering.
 *
 * ── THE TWO FIELDS ARE NOT INTERCHANGEABLE, AND THE GAP IS LARGE ────────────
 * On the OBSERVE path netProfitUsd is an ESTIMATE: observed spend x later price
 * change across the handful of buys Aegis witnessed, assuming the wallet still
 * holds. config.json's _profitRuleNote records that it "runs to single dollars".
 * MEASURED 2026-08-12 on the top-ranked wallet: netProfitUsd read +$1k while
 * the realized figure was 31.203 SOL = ~$2,380. Same wallet, one number more
 * than twice the other, and neither is a lifetime career total.
 *
 * The fallback is nonetheless correct, because it only bites where the estimate
 * is not an estimate: an IMPORTED row carries the provider's own lifetime P&L
 * in netProfitUsd and has no on-chain replay at all. Falling back there ranks
 * imports on the best figure they have.
 *
 * Returns null rather than 0 when neither exists. Unknown and break-even are
 * different claims, and a 0 would sort a wallet above every genuine loss.
 */
export function rankingProfitUsd(candidate) {
  // Finiteness-checked rather than a bare `??` chain. `??` only skips null and
  // undefined, so a NaN — which is what a failed parse of a provider's CSV cell
  // produces — would be taken as the answer and then poison every comparison it
  // touches, since NaN-x is NaN and a sort comparator reading NaN silently
  // leaves the order unspecified. Same reasoning in rankingWinRate.
  for (const v of [
    candidate?.gmgnNetProfitUsd,
    candidate?.allTimeNetProfitUsd,
    candidate?.netProfitUsd,
  ]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * The win rate the ranking sorts on, as a PERCENTAGE. PURE.
 *
 * GMGN's career figure first, then the true on-chain rate from the replay, then
 * the observed rate. The last is the weakest of the three and the file's own
 * header says so: it is computed over the handful of buys Aegis witnessed and
 * biased upward because buyer replay only reads tokens with a live pool.
 * MEASURED 2026-08-10: a wallet reading 100% observed over 3 graded buys was
 * 27% on chain over 11 closed trades.
 *
 * Extracted from the sort comparator, where this coalesce previously sat
 * inline. Pulling it out is what lets the GMGN step exist in one place instead
 * of being repeated at every call site, and lets the precedence be tested
 * without constructing a full candidate set.
 *
 * Returns null when nothing is known, so callers can distinguish "no rate" from
 * "0%" — a wallet that lost every closed trade and a wallet never measured are
 * not the same claim.
 */
export function rankingWinRate(candidate) {
  for (const v of [
    candidate?.gmgnWinRatePct,
    candidate?.onChain?.winRatePct,
    candidate?.winRatePct,
  ]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Apply all four rules. A candidate must pass every one — the rules are AND,
 * not a weighted blend, so a spectacular win rate cannot compensate for a thin
 * trade history (which is how small-sample flukes get mistaken for skill).
 *
 * ── THE ALPHA HUNTER FAST-TRACK ─────────────────────────────────────────────
 * A wallet credited with `alphaHunterMegaWins` mega-runners caught early skips
 * the rules that ask "has this wallet been right often enough to judge" — the
 * observed win rate, the on-chain win rate, the graded-sample floor and the
 * lifetime-trades floor. Catching two 50x+ launches early IS the judgment those
 * rules are proxies for, and a hunter who takes many small losses between them
 * would fail a win-rate floor while being exactly the wallet worth following.
 *
 * IT DOES NOT WAIVE THE MONEY RULE. minAllTimeNetSol still applies, and that is
 * deliberate: a wallet that caught two 50x runners and is STILL net negative in
 * SOL did not convert them, and the fast-track exists to find wallets that
 * catch runners, not wallets that are near them. Nor does it waive the
 * system-account screen, which runs before any of this.
 */
export function applyEliteRules(candidates, rules = ELITE_RULES) {
  // Rule 2 is a LIFETIME metric. Observation cannot produce it: Aegis sees a
  // wallet's buys only on the tokens it happened to scan, over a window of
  // hours, and never sees the exits — so an observed profit figure is a slice,
  // not a career total, and will never legitimately clear $50k.
  //
  // `profitRule: 'skip'` ranks on the two rules that ARE measurable from
  // observation rather than returning an empty list forever. It is opt-in and
  // never silently applied to imported data, which does carry real lifetime P&L.
  const skipProfit = rules.profitRule === 'skip';

  const fastTrackAt = rules.alphaHunterMegaWins ?? null;

  const evaluated = candidates.map((c) => {
    // The fast-track is decided BEFORE the checks so each waived rule can be
    // recorded as passing-by-override rather than silently skipped — the report
    // shows why a wallet qualified, and "waived" and "passed" are different
    // facts about a wallet.
    const fastTracked = Boolean(fastTrackAt) && (c.megaWinCount ?? 0) >= fastTrackAt;

    const checks = {
      sample:
        fastTracked ||
        c.gradedBuys === undefined ||
        c.gradedBuys === null ||
        c.gradedBuys >= (rules.minGradedBuys ?? 0),
      winRate: fastTracked || (c.winRatePct !== null && c.winRatePct >= rules.minWinRatePct),
      // Rule 2 — REALIZED DOLLARS.
      //
      // Reads allTimeNetProfitUsd, which is the wallet's own realized SOL priced
      // in dollars, and falls back to netProfitUsd only when that is absent.
      // The distinction is the whole rule: netProfitUsd is ESTIMATED from
      // observation — spend x later price change on the few buys Aegis saw,
      // assuming the wallet still holds — and runs to single dollars. A $30k
      // threshold against that figure rejects everyone for a reason that has
      // nothing to do with their trading.
      //
      // Now that a real figure exists, profitRule 'skip' is no longer the only
      // honest setting. It is still respected when set.
      netProfit: skipProfit
        ? true
        : typeof c.allTimeNetProfitUsd === 'number' && Number.isFinite(c.allTimeNetProfitUsd)
          ? c.allTimeNetProfitUsd >= rules.minNetProfitUsd
          : c.netProfitUsd !== null && c.netProfitUsd >= rules.minNetProfitUsd,
      trades:
        fastTracked || (c.lifetimeTrades !== null && c.lifetimeTrades >= rules.minLifetimeTrades),
      // Rule 5 — REALIZED SOL. Never waived by the fast-track.
      //
      // NOT APPLICABLE TO IMPORTED ROWS, and without this the import path is
      // dead: Rules 4 and 5 read `onChain`, which only exists after the
      // enrichment replay, and that replay never runs for imports. Unmeasured
      // is a failure, so EVERY imported wallet failed both rules however good
      // its leaderboard record — a $30k import would have qualified nobody and
      // the reason would have been invisible.
      //
      // Waiving them here is not a loosening. An imported row carries the
      // provider's own LIFETIME realized P&L, computed across the wallet's
      // whole history; Rules 4 and 5 exist to approximate exactly that from a
      // 12-page replay because observation could not supply it. Where the real
      // figure is present it is the better measurement, and it is judged by
      // Rule 2 at the same $30,000 bar.
      //
      // At a win-rate floor below the coin-flip line this is the rule that
      // actually decides whether a wallet made money: 45% admitted a wallet at
      // 47% that was 2.227 SOL DOWN, which is one that loses often and loses
      // big. A win rate says how often; this says whether it worked.
      //
      // Unmeasured is a failure, like every other unknown here. A wallet whose
      // history could not be replayed has not shown a profit.
      netSol:
        c.providerMetrics === true ||
        rules.minAllTimeNetSol === null ||
        rules.minAllTimeNetSol === undefined
          ? true
          : typeof c.onChain?.netSol === 'number' &&
            Number.isFinite(c.onChain.netSol) &&
            c.onChain.netSol > rules.minAllTimeNetSol,
      // Rule 4 — the true on-chain rate, over its own minimum sample.
      //
      // Enforced only when a floor is configured, so an operator who has not
      // opted in keeps the previous three-rule behaviour. UNMEASURED IS A
      // FAILURE when the rule is on: a wallet whose history could not be read
      // is not a wallet with a good record, and this rule exists precisely
      // because the observed rate it sits beside is too generous.
      onChainWinRate:
        // Same reasoning as netSol above: an imported row's win rate IS the
        // provider's lifetime figure, already judged by Rule 1.
        fastTracked || c.providerMetrics === true || !rules.minAllTimeWinRatePct
          ? true
          : c.onChain?.winRatePct !== null &&
            c.onChain?.winRatePct !== undefined &&
            c.onChain.winRatePct >= rules.minAllTimeWinRatePct &&
            (c.onChain.trades ?? 0) >= (rules.minAllTimeTrades ?? 0),
    };
    return { ...c, checks, fastTracked, qualified: Object.values(checks).every(Boolean) };
  });

  const qualified = evaluated
    .filter((c) => c.qualified)
    .sort(
      (a, b) =>
        // Alpha Hunters lead, then most mega-runners caught. They are on the
        // list for a different reason from everyone else and sorting them by a
        // win rate they were exempted from would rank them by the number the
        // fast-track exists to ignore.
        Number(b.fastTracked ?? false) - Number(a.fastTracked ?? false) ||
        (b.megaWinCount ?? 0) - (a.megaWinCount ?? 0) ||
        // LIFETIME USD PROFIT is the primary sort for everyone else.
        (rankingProfitUsd(b) ?? -Infinity) - (rankingProfitUsd(a) ?? -Infinity) ||
        // Then the true win rate: GMGN's career figure where one exists, the
        // on-chain replay next, the observed rate last.
        (rankingWinRate(b) ?? -Infinity) - (rankingWinRate(a) ?? -Infinity) ||
        // Realized SOL. NOTE THAT THIS CAN ALMOST NEVER FIRE, and it is kept
        // for the case where it can rather than as a working tie-break: on the
        // observe path allTimeNetProfitUsd IS onChain.netSol multiplied by one
        // per-sync SOL price, so ordering by it is arithmetically identical to
        // ordering by netSol and the primary key has already decided. It only
        // separates wallets whose USD figures came from DIFFERENT sources — an
        // imported row judged on a provider's P&L beside an observed one — and
        // there the imported row has no onChain at all.
        (b.onChain?.netSol ?? -Infinity) - (a.onChain?.netSol ?? -Infinity) ||
        (b.lifetimeTrades ?? 0) - (a.lifetimeTrades ?? 0)
    )
    .slice(0, rules.topN);

  return { evaluated, qualified };
}

const money = (n) =>
  n === null || n === undefined
    ? '?'
    : Math.abs(n) >= 1000
      ? `${n < 0 ? '-' : '+'}$${Math.round(Math.abs(n) / 1000)}k`
      : `${n < 0 ? '-' : '+'}$${Math.round(Math.abs(n))}`;

/** Render the watchlist file in the format smart_money.mjs consumes. */
export function buildWatchlist(qualified, { source, rules }) {
  const profitSkipped = rules.profitRule === 'skip';

  return {
    _comment: [
      'AUTO-GENERATED by auto_top_whales.mjs — manual edits are overwritten on',
      'the next sync. Add hand-picked wallets to a separate file instead.',
      '',
      `Source: ${source}`,
      `Generated: ${new Date().toISOString()}`,
      `Rules applied: win rate >= ${rules.minWinRatePct}% over >= ${rules.minGradedBuys} graded buys,`,
      profitSkipped
        ? 'net profit rule SKIPPED (lifetime realized P&L is not derivable from observation),'
        : `net profit >= $${rules.minNetProfitUsd.toLocaleString('en-US')},`,
      `on-chain activity >= ${rules.minLifetimeTrades} signatures.`,
      ...(rules.minAllTimeWinRatePct
        ? [
            `TRUE ON-CHAIN win rate >= ${rules.minAllTimeWinRatePct}% over >= ${rules.minAllTimeTrades ?? 0} closed round trips.`,
          ]
        : []),
      // Rule 5 was MISSING from this header, and it is the rule that decides
      // what the list means. A reader checking "which floors produced these
      // entries" — which the config notes explicitly send them here to do —
      // saw win rate, profit and signature count, and no sign that a realized
      // net-SOL floor had been applied at all.
      ...(rules.minAllTimeNetSol !== null && rules.minAllTimeNetSol !== undefined
        ? [
            `REALIZED net SOL > ${rules.minAllTimeNetSol} over the replayed window ` +
              `(strictly greater; unmeasured counts as a failure).`,
          ]
        : []),
      // Describes the ACTUAL sort. This line claimed "by win rate, then sample
      // size", which has not been true since realized SOL became the primary
      // key — the ordering below is fast-track, then mega-wins, then net SOL,
      // and win rate only breaks ties beneath all three. Ranking the file by
      // one number while announcing another is the same trap the two win-rate
      // fields further down exist to warn about.
      `Selected top ${rules.topN}: Alpha Hunters first, then most mega-runners caught,`,
      `then LIFETIME USD PROFIT, then true win rate, then realized net SOL.`,
      '',
      'THE RANKING PROFIT FIGURE IS `all_time_net_profit_usd`, not the',
      '`net_profit_usd` beside it. The first is the wallet’s own realized SOL',
      'from chain priced at the sync’s SOL rate; the second is ESTIMATED from',
      'the few buys Aegis witnessed and can differ by more than 2x on the same',
      'wallet. Both are written so the gap is inspectable rather than asserted,',
      'and neither is a lifetime career total — see `all_time_complete`.',
      '',
      'TWO WIN RATES LIVE IN THIS FILE AND THEY MEAN DIFFERENT THINGS.',
      '`win_rate` is OBSERVED: computed over the handful of buys Aegis happened',
      'to witness, graded by its own post-mortem, and biased upward because',
      'buyer replay only reads tokens with a live pool.',
      '`all_time_win_rate` is the wallet’s own realized record, netting every',
      'buy and sell of each token from chain. Measured on 2026-08-10, the top',
      'wallet here read 100% observed over 3 graded buys and 27% on-chain over',
      '11 closed trades. Trust the second one.',
      '',
      '`all_time_complete: false` means the history hit the page cap, so those',
      'figures describe the most recent swaps rather than the whole career.',
    ],
    generated: {
      at: new Date().toISOString(),
      source,
      profitRuleSkipped: profitSkipped,
      count: qualified.length,
    },
    wallets: qualified.map((w, i) => {
      const entry = {
        address: w.address,
        // Sample size in the label, not a profit figure. When profit is skipped
        // the number is an artifact of observed spend (often single dollars) and
        // putting it next to "Elite Whale" reads as a credential it has not
        // earned.
        // The label leads with the ON-CHAIN rate when there is one, because
        // that is the trustworthy number. The observed rate stays in the entry
        // but stops being the headline.
        label: w.fastTracked
          ? `Alpha Hunter (Spotted ${w.megaWinCount}+ 50X-500X Gems Early)`
          : w.onChain?.winRatePct !== null && w.onChain?.winRatePct !== undefined
            ? `Elite Whale #${i + 1} (${w.onChain.winRatePct.toFixed(0)}% all-time WR on ${w.onChain.trades} trades)`
            : profitSkipped
              ? `Elite Whale #${i + 1} (${w.winRatePct.toFixed(0)}% WR on ${w.gradedBuys ?? '?'} graded)`
              : `Elite Whale #${i + 1} (${w.winRatePct.toFixed(0)}% WR | ${money(w.netProfitUsd)})`,
        ...(w.fastTracked
          ? {
              alpha_hunter: true,
              mega_wins: w.megaWinCount,
              mega_win_detail: (w.megaWins ?? []).map(
                (m) => `${m.multiplier}x${m.symbol ? ` ${m.symbol}` : ''}`
              ),
            }
          : {}),
        win_rate: `${w.winRatePct.toFixed(0)}%`,
        graded_buys: w.gradedBuys ?? null,
        // Rule 4's figures, kept as separate fields so nothing can confuse the
        // observed rate with the on-chain one. `all_time_complete` is false
        // when the history hit maxHistoryPages, in which case these describe
        // the most recent N swaps rather than the wallet's career.
        ...(w.onChain?.winRatePct !== null && w.onChain?.winRatePct !== undefined
          ? {
              all_time_win_rate: `${w.onChain.winRatePct.toFixed(0)}%`,
              all_time_wins: w.onChain.wins,
              all_time_trades: w.onChain.trades,
              all_time_net_sol: Number(w.onChain.netSol.toFixed(3)),
              all_time_complete: w.onChain.complete === true,
            }
          : {}),
        // THE FIGURE THE LIST IS RANKED ON, written because it is now the
        // primary sort key and was previously invisible in the file. Without it
        // an entry showed only net_profit_usd — the observed ESTIMATE — so the
        // file would order itself by a number it never printed, which is the
        // same defect the sort-order line in the header above was fixed for.
        ...(rankingProfitUsd(w) !== null
          ? { all_time_net_profit_usd: money(rankingProfitUsd(w)) }
          : {}),
        // getSignaturesForAddress caps at 1000, so an exact 1000 means "at least
        // 1000" — and these are signatures, not trades. Naming it accurately
        // stops it being read as a verified trade count.
        onchain_signatures:
          w.lifetimeTrades === 1000 ? '1000+ (query cap)' : (w.lifetimeTrades ?? null),
        solscan: `https://solscan.io/account/${w.address}`,
        source: w.source ?? source,
        stats_updated: new Date().toISOString().slice(0, 10),
        metrics_basis: w.basis ?? 'unknown',
        enabled: true,
      };
      if (!profitSkipped) entry.net_profit_usd = money(w.netProfitUsd);
      return entry;
    }),
  };
}

/* ------------------------------------------------------------------ *
 * OBSERVE mode
 * ------------------------------------------------------------------ */

async function candidatesFromObservations(config) {
  const store = await loadObservations(join(HERE, '.state', 'wallet_observations.json'));
  const wallets = Object.entries(store.wallets);
  if (!wallets.length) return { candidates: [], totalSeen: 0 };

  // SOL/USD for profit estimation, taken from a live pair so it matches every
  // other dollar figure the scanner reports.
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  let solUsd = 0;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`);
    const d = await r.json();
    // priceUsd is always the BASE token's price. Pairs where SOL is the quote
    // report the other token's price, so filtering on base is required — taking
    // any pair yields nonsense like "SOL @ $0.01".
    const solPairs = (d.pairs ?? [])
      .filter((x) => x.baseToken?.address === SOL_MINT && Number(x.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    solUsd = solPairs.length ? Number(solPairs[0].priceUsd) : 0;
  } catch {
    /* profit estimation degrades to null without it */
  }

  // Ledger maturity. Failures take 1–6h to be graded while pumps register
  // almost immediately, so a young ledger contains WINs and NEUTRALs but no
  // FAILs — and every win rate computed from it is inflated toward 100%.
  // Ranking on that would fabricate an elite list out of survivorship bias.
  const allBuys = wallets.flatMap(([, e]) => e.buys);
  const graded = allBuys.filter((b) => b.outcome && b.outcome !== 'NEUTRAL');
  const fails = graded.filter((b) => b.outcome === 'FAIL').length;
  const observedFailRate = graded.length ? (fails / graded.length) * 100 : 0;

  // Distinct tokens decided, and their failure rate. This is the honest view:
  // the buy-weighted rate is dominated by whichever surviving token happened to
  // attract the most buyers, so a single popular winner can drag it to ~1%.
  const byToken = new Map();
  for (const b of allBuys) {
    if (b.outcome && b.outcome !== 'NEUTRAL' && !byToken.has(b.token)) {
      byToken.set(b.token, b.outcome);
    }
  }
  const tokenFails = [...byToken.values()].filter((v) => v === 'FAIL').length;
  const tokenFailRate = byToken.size ? (tokenFails / byToken.size) * 100 : 0;

  // Compare against the failure rate the post-mortem measures across ALL
  // scanned tokens. If the ledger's population is far cleaner than reality, it
  // is not a representative sample and any win rate drawn from it is inflated.
  let baseFailRate = null;
  try {
    const h = JSON.parse(await readFile(join(HERE, 'learning_history.json'), 'utf8'));
    const counts = (h.outcomes ?? []).reduce((a, x) => {
      a[x.verdict] = (a[x.verdict] ?? 0) + 1;
      return a;
    }, {});
    const decided = (counts.FAIL ?? 0) + (counts.WIN ?? 0);
    if (decided >= 50) baseFailRate = ((counts.FAIL ?? 0) / decided) * 100;
  } catch {
    /* no history yet — fall back to the weak check below */
  }

  const minShare = config.eliteWhales?.minRepresentativeness ?? 0.5;
  const required = baseFailRate === null ? null : baseFailRate * minShare;
  const representative = required === null ? fails > 0 : tokenFailRate >= required;

  const maturity = {
    tokens: new Set(allBuys.map((b) => b.token)).size,
    decidedTokens: byToken.size,
    gradedBuys: graded.length,
    fails,
    observedFailRate,
    tokenFailRate,
    baseFailRate,
    required,
    mature: fails > 0 && representative,
  };

  const candidates = [];
  for (const [address, entry] of wallets) {
    const s = walletStats(entry, solUsd);
    candidates.push({
      address,
      winRatePct: s.winRatePct,
      netProfitUsd: s.estimatedProfitUsd,
      gradedBuys: s.gradedBuys,
      // Observed positions, not lifetime trades. Enriched below for wallets
      // that clear the other two rules, because the enrichment costs an RPC
      // call each and most candidates never get that far.
      lifetimeTrades: s.gradedBuys,
      observed: s,
      // Mega-runners this wallet was credited with catching early, counted from
      // the alpha ledger multiplier_engine writes. Free — the record is already
      // in memory — and it is the input the Alpha Hunter fast-track reads.
      ...countMegaWins(entry),
      source: 'aegis-observed',
      basis: 'observed buys graded by post-mortem (not lifetime realized P&L)',
    });
  }
  return { candidates, totalSeen: wallets.length, solUsd, maturity };
}

/**
 * Rank eligible candidates by how much of their behaviour has actually been
 * observed, and keep only the top `cap` for per-wallet network work.
 *
 * Split out of syncTopWhales so the ordering can be tested without a network.
 * Returns a NEW array of the SAME object references — enrichment mutates
 * candidates in place, and the caller relies on those mutations being visible
 * through the full `wellFormed` list it later ranks.
 *
 * Graded buys lead the sort, observed buys break ties. See the call site for
 * why raw observation count alone would be the wrong key.
 */
export function capEnrichmentShortlist(eligible, cap = 50) {
  if (!Array.isArray(eligible)) return [];

  // Sort ALWAYS, slice conditionally. An earlier version returned the input
  // unsorted whenever the cap was not a finite number, which made "no cap"
  // silently mean "no ranking" — the ordering is the useful half of this
  // function, and a caller disabling the limit still wants best-first.
  const ranked = [...eligible].sort(
    (a, b) =>
      (b.gradedBuys ?? 0) - (a.gradedBuys ?? 0) ||
      (b.observed?.observedBuys ?? 0) - (a.observed?.observedBuys ?? 0)
  );
  if (!Number.isFinite(cap) || cap < 0) return ranked;
  return ranked.slice(0, cap);
}

/* ------------------------------------------------------------------ *
 * On-chain realized PnL
 * ------------------------------------------------------------------ */

/**
 * Net SOL realized through SWAPS, derived from Helius Enhanced Transactions.
 *
 * ── WHY SWAPS ONLY, AND NOT EVERY TRANSACTION ───────────────────────────────
 * Summing the native balance delta across ALL transactions does not measure
 * trading at all — it measures deposits minus withdrawals. A wallet that moves
 * 1,000 SOL in from an exchange reads as +$75k "profit" and would sail past a
 * $50k filter having never made a trade; a winner who cashes out reads as a
 * loss. Measured on three current elite wallets, the all-transaction figure
 * was +$302, $0 and -$174 — noise around zero, because deposits and
 * withdrawals dominate and roughly cancel.
 *
 * Restricting to `type === 'SWAP'` removes transfers, so what remains is SOL
 * out to buy and SOL in from selling. That is the standard construction of
 * realized PnL.
 *
 * ── WHAT IT STILL CANNOT SEE ────────────────────────────────────────────────
 * OPEN POSITIONS READ AS LOSSES. A wallet that spent 40 SOL on tokens it still
 * holds shows -40 SOL, and no amount of RPC fixes that: the SOL genuinely left
 * and the token's value is not a SOL balance. The same three wallets measured
 * -$2,236, -$229 and +$141 on swaps — all are active buyers still holding, so
 * the figure is biased negative by construction, and by an unknown amount.
 *
 * Read it as "SOL cycled back out through swaps", not "how much this wallet is
 * up". It is honest about closed positions and pessimistic about open ones.
 *
 * Helius pages 100 transactions per call, so a 600-transaction wallet costs six
 * calls and ~3.6s — affordable only because the shortlist is capped at 50.
 * Returns netUsd null (never 0) when it cannot be derived: unknown and
 * break-even are different claims, and Rule 2 must not confuse them.
 */
export async function deriveRealizedPnl(wallet, { heliusKey, solUsd, cfg = {} }) {
  if (!heliusKey) return { ok: false, reason: 'no Helius API key in rpcUrl', netUsd: null };

  const maxPages = cfg.pnlMaxPages ?? 6;
  const swapsOnly = cfg.pnlSwapsOnly !== false;
  let before = null;
  let swapLamports = 0;
  let allLamports = 0;
  let swaps = 0;
  let txs = 0;
  let pages = 0;
  let truncated = false;

  while (pages < maxPages) {
    const url =
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
      `?api-key=${encodeURIComponent(heliusKey)}&limit=100${before ? `&before=${before}` : ''}`;
    // Retried, because a 429 here does not just truncate a history — on the
    // FIRST page it leaves txs at 0, which makes netUsd null, which fails
    // Rule 2. Without a retry a wallet can be dropped from the elite list by a
    // rate limit rather than on merit. Observed directly: consecutive syncs
    // derived 48/48 and then 22/48 purely from request pacing.
    let batch = null;
    for (let attempt = 0; attempt < 3 && batch === null; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, (cfg.pnlDelayMs ?? 250) * 4 * attempt));
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(cfg.pnlTimeoutMs ?? 25000) });
        if (!res.ok) continue;
        batch = await res.json();
      } catch {
        /* retry, then give up */
      }
    }
    if (batch === null) {
      // A partial history is still usable, but it must be FLAGGED — a
      // truncated sum silently understates a wallet that traded earlier.
      truncated = true;
      break;
    }
    if (!Array.isArray(batch) || !batch.length) break;

    for (const tx of batch) {
      txs++;
      const delta = (tx.accountData ?? []).find((a) => a.account === wallet)?.nativeBalanceChange ?? 0;
      allLamports += delta;
      if (tx.type === 'SWAP') {
        swaps++;
        swapLamports += delta;
      }
    }
    before = batch[batch.length - 1].signature;
    pages++;
    if (batch.length < 100) break;
    await new Promise((r) => setTimeout(r, cfg.pnlDelayMs ?? 250));
  }

  if (pages >= maxPages) truncated = true;
  const lamports = swapsOnly ? swapLamports : allLamports;
  const netSol = lamports / 1e9;

  return {
    ok: txs > 0,
    netSol,
    netUsd: txs > 0 && solUsd ? netSol * solUsd : null,
    // Both retained so the divergence is inspectable rather than asserted.
    swapNetSol: swapLamports / 1e9,
    allTxNetSol: allLamports / 1e9,
    swaps,
    txs,
    truncated,
    basis: swapsOnly ? 'net SOL through SWAP transactions' : 'net SOL across all transactions',
  };
}

/* ------------------------------------------------------------------ *
 * True on-chain win rate
 * ------------------------------------------------------------------ *
 *
 * A win rate computed from the wallet's own realized SOL, not from Aegis's
 * observations. Every buy and sell of a token is netted; a token the wallet got
 * more SOL out of than it put in is a WIN.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The observed win rate in smart_wallets.json is computed over the handful of
 * buys Aegis happened to witness, graded by its own post-mortem, and the sample
 * skews optimistic because buyer replay only reads tokens with a live pool. The
 * file's own header says so. MEASURED on 2026-08-10 against the top watchlist
 * wallet: observed 100% over 3 graded buys, true on-chain 27% over 11 closed
 * positions. The two numbers are not close, and the optimistic one was the one
 * being used to rank.
 *
 * ── THE SOL DELTA MUST COME FROM accountData ────────────────────────────────
 * Not from nativeTransfers, which is the obvious place and is WRONG. Measured
 * on a real pump.fun sell: the wallet's nativeTransfers contained only fee
 * outflows (-0.0154, -0.0015) while the 1.5 SOL of sale proceeds appeared
 * nowhere in them. Computing the delta that way makes every sell look like
 * another buy, so no position ever closes — a first cut of this scored 62 mints
 * with ZERO closed positions and would have reported "no win rate available"
 * forever. `accountData[].nativeBalanceChange` is the wallet's true net lamport
 * change and shows +1.5034 on that same transaction.
 *
 * ── "ALL-TIME" IS BOUNDED, AND SAYS SO ──────────────────────────────────────
 * Full history is not affordable. Measured: four watchlist wallets held 51,979
 * signatures between them (one hit a 25-page cap with more beyond), which at
 * one getTransaction each is ~2.6 MILLION calls for a 200-wallet shortlist —
 * days of RPC per two-hour sync.
 *
 * Helius's parsed-history endpoint returns 100 fully-parsed transactions per
 * call instead of one, which is what makes this feasible at all: ~7s and 11
 * calls for 1,100 transactions. maxHistoryPages bounds it further. A wallet
 * whose history fits inside the cap is genuinely all-time and reports
 * `complete: true`; a busier one is its most recent N trades and reports false.
 * The distinction is carried into the watchlist file and the Telegram report,
 * because "70% all-time" and "70% over the last 1,100 swaps" are different
 * claims.
 */

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1e9;

/**
 * Realized win rate from parsed transactions. PURE — no network, so it can be
 * verified against recorded shapes.
 *
 * A "trade" is a CLOSED ROUND TRIP in one token: SOL went out and SOL came
 * back. A position still open is neither a win nor a loss and is excluded from
 * both sides of the ratio — counting open positions as losses would punish a
 * wallet for still holding, and as wins would be worse.
 */
/**
 * Per-mint SOL flow from a batch of parsed transactions. PURE.
 *
 * Split out of computeOnChainWinRate so the intermediate state can be CACHED
 * and merged incrementally. The summary alone is not enough to extend: a later
 * sell turns a previously-open position into a closed one, which changes both
 * the numerator and the denominator of the win rate. Caching only
 * "27% over 11 trades" makes that impossible to update without a full refetch,
 * which is the whole cost this cache exists to avoid.
 */
export function accumulateMintTotals(transactions, { address, dustSol = 0.05 } = {}) {
  const perMint = new Map();
  let swapLegs = 0;
  let dustSkipped = 0;
  let ambiguous = 0;
  let newestSignature = null;

  for (const tx of transactions ?? []) {
    if (!tx || tx.transactionError || tx.type !== 'SWAP') continue;
    if (!newestSignature && tx.signature) newestSignature = tx.signature;

    const moved = (tx.tokenTransfers ?? []).filter(
      (t) => (t.fromUserAccount === address || t.toUserAccount === address) && t.mint !== WSOL_MINT
    );
    if (!moved.length) continue;

    const mints = [...new Set(moved.map((t) => t.mint))];
    if (mints.length !== 1) { ambiguous++; continue; }

    const account = (tx.accountData ?? []).find((a) => a.account === address);
    const netSol = (account?.nativeBalanceChange ?? 0) / LAMPORTS_PER_SOL;
    if (Math.abs(netSol) < dustSol) { dustSkipped++; continue; }

    swapLegs++;
    const entry = perMint.get(mints[0]) ?? { solOut: 0, solIn: 0, legs: 0 };
    if (netSol < 0) entry.solOut += -netSol;
    else entry.solIn += netSol;
    entry.legs++;
    perMint.set(mints[0], entry);
  }

  return { perMint, swapLegs, dustSkipped, ambiguous, newestSignature };
}

/**
 * Fold two per-mint maps together. PURE.
 *
 * Addition is the right merge because every field is a running total of SOL
 * through one mint. Order does not matter, which is what makes an incremental
 * top-up equivalent to a full replay of the same transactions.
 */
export function mergeMintTotals(base = {}, incoming = {}) {
  const out = {};
  for (const [mint, e] of Object.entries(base)) {
    out[mint] = { solOut: e.solOut ?? 0, solIn: e.solIn ?? 0, legs: e.legs ?? 0 };
  }
  for (const [mint, e] of Object.entries(incoming)) {
    const prior = out[mint] ?? { solOut: 0, solIn: 0, legs: 0 };
    out[mint] = {
      solOut: prior.solOut + (e.solOut ?? 0),
      solIn: prior.solIn + (e.solIn ?? 0),
      legs: prior.legs + (e.legs ?? 0),
    };
  }
  return out;
}

/** Win rate and realized SOL from a per-mint map. PURE. */
export function summariseMintTotals(perMint = {}, extra = {}) {
  const entries = Object.entries(perMint);
  const closed = entries
    .filter(([, e]) => (e.solOut ?? 0) > 0 && (e.solIn ?? 0) > 0)
    .map(([mint, e]) => ({ mint, ...e, netSol: e.solIn - e.solOut }));
  const wins = closed.filter((c) => c.netSol > 0);

  return {
    trades: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
    netSol: closed.reduce((a, c) => a + c.netSol, 0),
    openPositions: entries.length - closed.length,
    swapLegs: extra.swapLegs ?? 0,
    dustSkipped: extra.dustSkipped ?? 0,
    ambiguous: extra.ambiguous ?? 0,
    dustSol: extra.dustSol ?? 0.05,
  };
}

export function computeOnChainWinRate(transactions, { address, dustSol = 0.05 } = {}) {
  const perMint = new Map();
  let swapLegs = 0;
  let dustSkipped = 0;
  let ambiguous = 0;

  for (const tx of transactions ?? []) {
    if (!tx || tx.transactionError || tx.type !== 'SWAP') continue;

    // Non-WSOL tokens this wallet actually moved. WSOL is excluded because it
    // is the SOL side of the swap wearing a token's clothes — counting it as a
    // position would make every trade look like a WSOL round trip.
    const moved = (tx.tokenTransfers ?? []).filter(
      (t) => (t.fromUserAccount === address || t.toUserAccount === address) && t.mint !== WSOL_MINT
    );
    if (!moved.length) continue;

    const mints = [...new Set(moved.map((t) => t.mint))];
    // A multi-token swap cannot be attributed to one position from balances
    // alone. Counted and reported rather than guessed at.
    if (mints.length !== 1) { ambiguous++; continue; }

    const account = (tx.accountData ?? []).find((a) => a.account === address);
    const netSol = (account?.nativeBalanceChange ?? 0) / LAMPORTS_PER_SOL;

    // Dust filter. Fee-only legs and micro-trades say nothing about skill and
    // would dominate the count on a wallet that farms airdrops.
    if (Math.abs(netSol) < dustSol) { dustSkipped++; continue; }

    swapLegs++;
    const entry = perMint.get(mints[0]) ?? { solOut: 0, solIn: 0, legs: 0 };
    if (netSol < 0) entry.solOut += -netSol;
    else entry.solIn += netSol;
    entry.legs++;
    perMint.set(mints[0], entry);
  }

  const closed = [...perMint.entries()]
    .filter(([, e]) => e.solOut > 0 && e.solIn > 0)
    .map(([mint, e]) => ({ mint, ...e, netSol: e.solIn - e.solOut }));

  const wins = closed.filter((c) => c.netSol > 0);

  return {
    trades: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
    netSol: closed.reduce((a, c) => a + c.netSol, 0),
    swapLegs,
    dustSkipped,
    ambiguous,
    openPositions: perMint.size - closed.length,
    dustSol,
  };
}

/**
 * Paginated parsed history for one wallet.
 *
 * The `type=SWAP` query parameter is deliberately NOT used: it truncates. An
 * unfiltered page of this wallet returned 707 swaps out of 800 transactions,
 * while the same request with type=SWAP stopped after 80 and reported itself
 * complete. Filtering happens client-side in computeOnChainWinRate.
 */
export async function fetchWalletHistory(
  address,
  {
    heliusKey,
    maxPages = 12,
    timeoutMs = 30_000,
    pageDelayMs = 120,
    retries = 3,
    retryDelayMs = 1_500,
    // Stop as soon as this signature is seen and return only what is NEWER.
    // The endpoint pages backwards from the most recent transaction, so the
    // first page already contains everything since the last sync — an
    // incremental top-up usually costs ONE call regardless of how much history
    // the wallet has.
    untilSignature = null,
  } = {}
) {
  if (!heliusKey) return { ok: false, error: 'no Helius key', transactions: [], complete: false, pages: 0 };

  const transactions = [];
  let before = null;
  let pages = 0;

  // RETRIES ARE LOAD-BEARING, not defensive. Measured while building this:
  // replaying 19 wallets back to back, 14 of them returned HTTP 200 with an
  // EMPTY array — and retried individually with a 2s pause, the same wallets
  // returned 100 transactions each. Without a retry the enrichment silently
  // reports "no closed history" for a wallet that has plenty, and under Rule 4
  // unmeasured is a failure, so a transient throttle would quietly delete
  // wallets from the watchlist. enrichLifetimeTrades carries a note about
  // exactly this failure mode; this is the same trap one endpoint over.
  while (pages < maxPages) {
    const url =
      `https://api.helius.xyz/v0/addresses/${encodeURIComponent(address)}/transactions` +
      `?api-key=${encodeURIComponent(heliusKey)}&limit=100${before ? `&before=${before}` : ''}`;

    let batch = null;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          // A plan limit is terminal. Retrying it burns wall-clock for a result
          // that cannot change, and the caller needs to stop rather than work
          // through the rest of the shortlist the same way.
          if (res.status === 429 && /max usage|quota|credit/i.test(text)) {
            return {
              ok: false,
              error: `RPC quota exhausted: ${text.trim().slice(0, 80)}`,
              quotaExhausted: true,
              transactions,
              complete: false,
              pages,
            };
          }
          lastError = `HTTP ${res.status}`;
          continue;
        }
        const body = await res.json();
        if (!Array.isArray(body)) { lastError = 'non-array response'; continue; }
        // An empty FIRST page is the ambiguous case: it is either a wallet with
        // no history or a throttle answering 200. Retried rather than believed,
        // and only accepted once the retries are spent.
        if (!body.length && pages === 0 && attempt < retries) { lastError = 'empty first page'; continue; }
        batch = body;
        break;
      } catch (err) {
        lastError = err.message;
      }
    }

    if (batch === null) {
      return { ok: pages > 0, error: lastError, transactions, complete: false, pages };
    }
    if (!batch.length) break;
    pages++;

    if (untilSignature) {
      const hit = batch.findIndex((t) => t?.signature === untilSignature);
      if (hit !== -1) {
        // Everything from `hit` onward was already folded into the cache.
        transactions.push(...batch.slice(0, hit));
        return { ok: true, transactions, complete: true, pages, caughtUp: true };
      }
    }

    transactions.push(...batch);
    before = batch[batch.length - 1]?.signature;
    // A short page is the end of the wallet's history — the only way to know
    // the window is genuinely all-time rather than merely capped.
    if (batch.length < 100) return { ok: true, transactions, complete: true, pages };
    if (pageDelayMs) await new Promise((r) => setTimeout(r, pageDelayMs));
  }

  // Reaching the page cap while looking for a known signature means the wallet
  // moved more than maxPages of transactions since the last sync. The top-up is
  // then incomplete, and merging it would double-count nothing but would leave
  // a hole — so the caller is told to treat it as a full refresh instead.
  return {
    ok: true,
    transactions,
    complete: pages < maxPages,
    pages,
    caughtUp: untilSignature ? false : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * On-chain history cache
 * ------------------------------------------------------------------ *
 *
 * The replay is the expensive half of a sync — measured at ~10-15 minutes for
 * 40 wallets — and almost all of it is re-reading history that has not changed.
 * This caches the per-mint SOL flow per wallet so a repeat sync costs nothing
 * for wallets inside the TTL, and only the NEW transactions for wallets past
 * it.
 *
 * WHY THE PER-MINT MAP AND NOT THE SUMMARY: a later sell turns an open position
 * into a closed one, changing both sides of the win-rate ratio. "27% over 11
 * trades" cannot be extended by new transactions; the flow it was derived from
 * can. Merging is addition, so an incremental top-up is arithmetically identical
 * to a full replay over the same transactions.
 *
 * `lifetimeTrades` is cached alongside it, because that is the OTHER per-wallet
 * RPC call in an observe sync and leaving it uncached would keep the pass
 * expensive no matter how good this cache is.
 */
export const ONCHAIN_CACHE_PATH = join(HERE, '.state', 'onchain_history_cache.json');
export const ONCHAIN_CACHE_VERSION = 1;

export async function loadOnChainCache(path = ONCHAIN_CACHE_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export async function saveOnChainCache(cache, path = ONCHAIN_CACHE_PATH) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* a cache that cannot be written is a cost problem, never a sync failure */
  }
}

/**
 * How this wallet's cache entry may be used.
 *
 *   'fresh'       inside the TTL — serve from disk, zero RPC.
 *   'incremental' past the TTL but usable — fetch only what is newer.
 *   'miss'        no entry, or one written by an older cache version.
 *
 * A version bump invalidates rather than migrates: the entry's meaning is the
 * accumulator's semantics, and reusing totals computed under different rules
 * (a changed dust floor, say) would silently blend two definitions.
 */
/**
 * Bound the cache file.
 *
 * Each entry holds a per-mint map that can run to hundreds of tokens for an
 * active wallet, and the shortlist churns — wallets enter and leave it every
 * sync. Without a bound this file grows monotonically with every wallet ever
 * shortlisted and eventually costs more to read than it saves.
 *
 * Oldest-first eviction, because a stale entry is the one whose next use would
 * need a refetch anyway.
 */
export function pruneOnChainCache(cache, { maxCacheEntries = 500, maxCacheAgeDays = 30 } = {}, now = Date.now()) {
  const floor = now - maxCacheAgeDays * 86_400_000;
  const live = Object.entries(cache).filter(([, e]) => (e?.at ?? e?.sigCountAt ?? 0) >= floor);
  live.sort((a, b) => (b[1]?.at ?? b[1]?.sigCountAt ?? 0) - (a[1]?.at ?? a[1]?.sigCountAt ?? 0));
  return Object.fromEntries(live.slice(0, maxCacheEntries));
}

export function classifyCacheEntry(entry, { ttlHours = 24, now = Date.now(), dustSol = 0.05 } = {}) {
  if (!entry || entry.version !== ONCHAIN_CACHE_VERSION || !entry.perMint) return 'miss';
  // The dust floor changes what counts as a leg, so totals from a different one
  // are a different measurement.
  if (typeof entry.dustSol === 'number' && entry.dustSol !== dustSol) return 'miss';
  const ageHours = (now - (entry.at ?? 0)) / 3_600_000;
  if (ageHours < 0) return 'miss';
  if (ageHours <= ttlHours) return 'fresh';
  return entry.newestSignature ? 'incremental' : 'miss';
}

/* ------------------------------------------------------------------ *
 * GMGN lifetime metrics
 * ------------------------------------------------------------------ *
 *
 * Populates candidate.gmgnNetProfitUsd and candidate.gmgnWinRatePct, which
 * rankingProfitUsd and rankingWinRate read FIRST. A provider's career figure
 * beats anything derivable here, because Aegis can only replay a bounded
 * window while GMGN reports a whole history.
 *
 * ── STATUS: WIRED, KEYED, AND BLOCKED UPSTREAM ──────────────────────────────
 * MEASURED 2026-08-12 with the configured GMGN_API_KEY (37 chars) against three
 * endpoints x three auth schemes — Authorization: Bearer, X-API-KEY, and an
 * api_key query parameter:
 *   gmgn.ai/api/v1/wallet_stat/sol/<addr>/7d          403, Cloudflare HTML
 *   gmgn.ai/defi/quotation/v1/smartmoney/sol/…        403, Cloudflare HTML
 *   api.gmgn.ai/…                                     DNS / connect failure
 * All nine combinations failed. The 403 is a Cloudflare bot challenge served
 * BEFORE the application sees a credential, so the key is never evaluated and
 * no auth scheme helps. Working around that challenge is out of scope.
 *
 * So this code is correct and currently yields nothing. That is why it is
 * built to fail QUIETLY AND CHEAPLY rather than loudly: a wallet with no GMGN
 * data simply keeps its Aegis-derived figures, and the ranking falls through
 * exactly as it did before.
 *
 * THE CIRCUIT BREAKER IS THE LOAD-BEARING PART. Without it, 165 shortlisted
 * wallets each pay a full round trip to a wall on every sync — minutes of
 * wall-clock, every two hours, for zero data, inside the maintenance loop the
 * enrichShortlistCap note already records starving the scanner. After
 * maxConsecutiveFailures the pass gives up and says so once.
 */

const GMGN_PROFIT_FIELDS = [
  'realized_profit_usd', 'realized_profit', 'total_profit_usd', 'total_profit',
  'pnl_usd', 'pnl', 'profit_usd', 'profit', 'net_profit_usd', 'net_profit',
];
const GMGN_WINRATE_FIELDS = ['winrate', 'win_rate', 'winrate_pct', 'win_rate_pct', 'success_rate'];

/**
 * Pull lifetime P&L and win rate out of a GMGN payload. PURE.
 *
 * Field names are a LIST rather than one key because the shape is not
 * contractual — it is a web app's internal endpoint, and the import path in
 * this same file already carries a comment about GMGN exporting
 * `realized_profit` where other providers use `pnl`. Reading one name and
 * getting null would be indistinguishable from a wallet with no record.
 *
 * The win rate goes through normaliseWinRate, which is not decoration: GMGN
 * exports fractions (0.62) where Birdeye exports "64%". Read literally, a 0.62
 * ranks below every observed wallet and looks like a bad wallet rather than a
 * unit mismatch. That exact bug is documented on normaliseWinRate.
 *
 * Returns null when neither figure is present, so "no data" and "zero profit"
 * stay distinguishable.
 */
export function parseGmgnMetrics(payload) {
  // Unwrapped defensively: the endpoints seen in the wild nest under `data`,
  // sometimes twice, and sometimes not at all.
  let node = payload;
  for (let depth = 0; depth < 3 && node && typeof node === 'object'; depth++) {
    if (Array.isArray(node)) node = node[0];
    else if (node.data !== undefined) node = node.data;
    else break;
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;

  const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
      const n = Number(v.replace(/[$,\s]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  let netProfitUsd = null;
  for (const f of GMGN_PROFIT_FIELDS) {
    const v = num(node[f]);
    if (v !== null) { netProfitUsd = v; break; }
  }

  let winRatePct = null;
  for (const f of GMGN_WINRATE_FIELDS) {
    if (node[f] === undefined || node[f] === null || node[f] === '') continue;
    const v = normaliseWinRate(node[f]);
    if (v !== null && Number.isFinite(v)) { winRatePct = v; break; }
  }

  if (netProfitUsd === null && winRatePct === null) return null;
  return { netProfitUsd, winRatePct };
}

/**
 * One wallet's lifetime metrics from GMGN.
 *
 * Never throws. Returns a discriminated result so the caller can tell a hard
 * block (403/401, which will repeat for every wallet and should trip the
 * breaker) from an ordinary miss.
 */
export async function fetchGmgnWalletStats(address, { apiKey, period = '7d', timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  if (!apiKey) return { ok: false, blocked: false, error: 'no GMGN_API_KEY' };

  const url = `https://gmgn.ai/api/v1/wallet_stat/sol/${encodeURIComponent(address)}/${encodeURIComponent(period)}`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        // Sent three ways because GMGN publishes no auth contract. Harmless
        // where unused; the alternative is guessing one and silently getting
        // nothing if the guess is wrong.
        Authorization: `Bearer ${apiKey}`,
        'X-API-KEY': apiKey,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // 403 here is Cloudflare, not "this wallet is unknown". Flagged as
      // blocked so one wall stops the whole pass rather than being retried
      // 165 times.
      return { ok: false, blocked: res.status === 403 || res.status === 401, status: res.status, error: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
      // A challenge page answers 200 sometimes. HTML is not a wallet record.
      return { ok: false, blocked: true, error: 'non-JSON response (challenge page?)' };
    }

    const metrics = parseGmgnMetrics(JSON.parse(text));
    return metrics ? { ok: true, metrics } : { ok: false, blocked: false, error: 'no recognised profit or win-rate field' };
  } catch (err) {
    return { ok: false, blocked: false, error: err.message };
  }
}

/**
 * Attach GMGN lifetime figures to candidates. Mutates in place, like the other
 * enrichers. Never throws, and never fails a sync: a wallet without GMGN data
 * keeps its Aegis-derived numbers.
 */
export async function enrichGmgnMetrics(candidates, { apiKey, cfg = {}, log = console } = {}) {
  if (!apiKey) return { attempted: 0, populated: 0, blocked: false, skipped: 'no GMGN_API_KEY' };
  if (cfg.enabled === false) return { attempted: 0, populated: 0, blocked: false, skipped: 'disabled in config' };

  const maxLookups = cfg.maxLookups ?? 60;
  const maxConsecutiveFailures = cfg.maxConsecutiveFailures ?? 3;
  const delayMs = cfg.delayMs ?? 200;
  const targets = candidates.slice(0, maxLookups);

  let attempted = 0;
  let populated = 0;
  let consecutiveFailures = 0;
  let blocked = false;
  let lastError = null;

  for (const c of targets) {
    attempted++;
    const r = await fetchGmgnWalletStats(c.address, {
      apiKey,
      period: cfg.period ?? '7d',
      timeoutMs: cfg.timeoutMs ?? 10_000,
    });

    if (r.ok) {
      consecutiveFailures = 0;
      if (typeof r.metrics.netProfitUsd === 'number') c.gmgnNetProfitUsd = r.metrics.netProfitUsd;
      if (typeof r.metrics.winRatePct === 'number') c.gmgnWinRatePct = r.metrics.winRatePct;
      c.basis += `; GMGN lifetime ${r.metrics.netProfitUsd !== null ? `$${Math.round(r.metrics.netProfitUsd)}` : 'n/a'}`;
      populated++;
    } else {
      consecutiveFailures++;
      lastError = r.error;
      if (r.blocked) blocked = true;
      // A wall answers identically for every address. Walking the rest of the
      // shortlist into it costs minutes and returns nothing.
      if (blocked || consecutiveFailures >= maxConsecutiveFailures) break;
    }
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
  }

  if (populated) {
    log.log(`   ↳ GMGN lifetime metrics for ${populated}/${attempted} wallet(s) — these outrank the Aegis replay in the sort`);
  } else {
    log.log(
      `   ↳ GMGN unavailable after ${attempted} attempt(s) — ${lastError ?? 'no data'}` +
        (blocked
          ? '. That is a Cloudflare block on gmgn.ai, not a verdict on these wallets; the key is never'
          : '') +
        (blocked ? ' evaluated. Ranking falls back to the on-chain replay.' : '. Ranking falls back to the on-chain replay.')
    );
  }
  return { attempted, populated, blocked, lastError };
}

/**
 * Split replay contenders into those the cache can serve for free and those
 * that need network. PURE — no clock, no IO, so the cap's behaviour can be
 * verified without a Helius key.
 *
 * ── WHY THE SPLIT EXISTS ────────────────────────────────────────────────────
 * maxOnChainReplays is a COST control: it exists so a sync running inside the
 * maintenance loop cannot starve the scanner (see enrichShortlistCap's note and
 * its 468 skipped ticks). A wallet served from the history cache costs zero RPC
 * and a map lookup, so counting it against that budget bounds the wrong thing —
 * it converts a cost limit into a coverage limit, and because unmeasured fails
 * Rules 4 and 5, a qualifying wallet gets dropped for want of a slot it did not
 * need. The visible symptom is a watchlist that churns between syncs while the
 * wallets themselves have not changed.
 *
 * 'incremental' is deliberately grouped with 'miss'. It has an entry, but the
 * entry is past TTL and topping it up still costs at least one call — usually
 * exactly one, since the endpoint pages backwards from the newest transaction,
 * but one is not zero and the cap is about calls.
 *
 * Order is preserved inside both groups: contenders arrive ranked by observed
 * activity, and the cap slices the cold group, so the wallets most likely to
 * qualify keep the scarce slots.
 */
export function partitionByCacheDisposition(
  contenders = [],
  cache = {},
  { ttlHours = 24, dustSol = 0.05, now = Date.now() } = {}
) {
  const cached = [];
  const cold = [];
  for (const c of contenders) {
    const disposition = classifyCacheEntry(cache[c.address], { ttlHours, now, dustSol });
    (disposition === 'fresh' ? cached : cold).push(c);
  }
  return { cached, cold };
}

/** Attach the true on-chain win rate to each candidate. Mutates in place. */
async function enrichOnChainWinRate(candidates, { heliusKey, cfg, solUsd = 0, cache = {}, now = Date.now() }) {
  if (!heliusKey) {
    console.log('   No Helius API key — true on-chain win rate cannot be derived');
    return { derived: 0, failed: candidates.length };
  }
  const maxPages = cfg?.maxHistoryPages ?? 12;
  const dustSol = cfg?.dustTradeSol ?? 0.05;
  const ttlHours = cfg?.historyCacheTtlHours ?? 24;
  let derived = 0;
  let failed = 0;
  let partial = 0;
  let fromCache = 0;
  let topUps = 0;
  let pagesFetched = 0;

  let quotaExhausted = null;
  for (const c of candidates) {
    const entry = cache[c.address];
    const disposition = classifyCacheEntry(entry, { ttlHours, now, dustSol });

    // Once the plan limit is hit, only cache hits can still be served. Walking
    // the rest of the shortlist against a hard quota costs minutes and returns
    // nothing.
    if (quotaExhausted && disposition !== 'fresh') {
      failed++;
      c.onChain = { winRatePct: null, trades: 0, unavailable: quotaExhausted };
      continue;
    }

    let perMint;
    let meta;
    let complete;
    let newestSignature;

    if (disposition === 'fresh') {
      // ZERO RPC. The whole point of the cache.
      perMint = entry.perMint;
      meta = { swapLegs: entry.swapLegs, dustSkipped: entry.dustSkipped, ambiguous: entry.ambiguous, dustSol };
      complete = entry.complete;
      newestSignature = entry.newestSignature;
      fromCache++;
    } else {
      const incremental = disposition === 'incremental';
      const history = await fetchWalletHistory(c.address, {
        heliusKey,
        maxPages,
        pageDelayMs: cfg?.historyPageDelayMs ?? 120,
        untilSignature: incremental ? entry.newestSignature : null,
      });
      pagesFetched += history.pages ?? 0;

      if (history.quotaExhausted) quotaExhausted = history.error;

      if (!history.ok) {
        // A failed refresh falls back to the STALE entry rather than dropping
        // the wallet. Under Rules 4 and 5 unmeasured is a failure, so treating
        // a transient error as "no history" would delete a wallet from the
        // watchlist for a network blip — the exact failure the retry inside
        // fetchWalletHistory exists to prevent, one level up.
        if (entry?.perMint) {
          perMint = entry.perMint;
          meta = { swapLegs: entry.swapLegs, dustSkipped: entry.dustSkipped, ambiguous: entry.ambiguous, dustSol };
          complete = entry.complete;
          newestSignature = entry.newestSignature;
          fromCache++;
        } else {
          failed++;
          c.onChain = { winRatePct: null, trades: 0, unavailable: history.error ?? 'no history returned' };
          continue;
        }
      } else {
        const batch = accumulateMintTotals(history.transactions, { address: c.address, dustSol });
        const usableTopUp = incremental && history.caughtUp === true;

        if (usableTopUp) {
          // Arithmetic merge — identical to having replayed both batches at once.
          perMint = mergeMintTotals(entry.perMint, Object.fromEntries(batch.perMint));
          meta = {
            swapLegs: (entry.swapLegs ?? 0) + batch.swapLegs,
            dustSkipped: (entry.dustSkipped ?? 0) + batch.dustSkipped,
            ambiguous: (entry.ambiguous ?? 0) + batch.ambiguous,
            dustSol,
          };
          complete = entry.complete;
          topUps++;
        } else {
          // Either a cold miss, or a top-up that ran past maxPages without
          // reaching the known signature — in which case the window has a hole
          // and the fresh read replaces the entry rather than extending it.
          perMint = Object.fromEntries(batch.perMint);
          meta = { swapLegs: batch.swapLegs, dustSkipped: batch.dustSkipped, ambiguous: batch.ambiguous, dustSol };
          complete = history.complete;
        }
        newestSignature = batch.newestSignature ?? entry?.newestSignature ?? null;
        if (!history.transactions.length && !entry?.perMint) {
          failed++;
          c.onChain = { winRatePct: null, trades: 0, unavailable: 'no history returned' };
          continue;
        }
      }
    }

    const wr = summariseMintTotals(perMint, meta);
    c.onChain = { ...wr, complete, pagesRead: 0, cached: disposition === 'fresh' };

    cache[c.address] = {
      version: ONCHAIN_CACHE_VERSION,
      perMint,
      newestSignature,
      swapLegs: meta.swapLegs,
      dustSkipped: meta.dustSkipped,
      ambiguous: meta.ambiguous,
      complete,
      dustSol,
      // Only advanced on a real read. A cache SERVED from disk keeps its
      // original timestamp, or a wallet inside the TTL would refresh its own
      // expiry on every sync and never be re-read again.
      at: disposition === 'fresh' ? entry.at : now,
    };

    // REAL realized profit, in dollars, from the wallet's own closed positions.
    //
    // This is what Rule 2 was always supposed to read. `netProfitUsd` beside it
    // is ESTIMATED from observation — spend x later price change on the handful
    // of buys Aegis witnessed, assuming the wallet still holds — and the config
    // note calls it single dollars. Ranking a $30k threshold against that
    // number would reject everyone for a reason unrelated to their trading.
    if (wr.winRatePct !== null && solUsd > 0) {
      c.allTimeNetProfitUsd = wr.netSol * solUsd;
    }
    if (wr.winRatePct !== null) {
      derived++;
      if (!complete) partial++;
      c.basis +=
        `; on-chain ${wr.winRatePct.toFixed(0)}% over ${wr.trades} closed trade(s)` +
        `${complete ? ' (all-time)' : ` (most recent ${wr.swapLegs} swap legs, history truncated)`}` +
        `${disposition === 'fresh' ? ' [cached]' : ''}`;
    } else {
      failed++;
    }
  }

  console.log(
    `   ↳ on-chain win rate derived for ${derived}/${candidates.length} wallet(s)` +
      ` — ${fromCache} from cache (0 RPC), ${topUps} incremental, ${pagesFetched} page(s) fetched` +
      (partial ? `, ${partial} from a truncated history` : '') +
      (failed ? `, ${failed} unmeasured` : '')
  );
  if (quotaExhausted) {
    console.error(`   🔴 [QUOTA] ${quotaExhausted}`);
    console.error('      Only cached wallets could be served. Rules 4 and 5 treat unmeasured as a');
    console.error('      failure, so the rest cannot qualify this pass — that is the account limit');
    console.error('      talking, not their records.');
  }
  return { derived, failed, partial, quotaExhausted };
}

/** Attach derived PnL to each candidate. Mutates in place, like enrichment. */
async function enrichRealizedPnl(candidates, { heliusKey, solUsd, cfg }) {
  if (!heliusKey) {
    console.log('   No Helius API key in rpcUrl — on-chain PnL cannot be derived, netProfitUsd stays null');
    return { derived: 0, failed: candidates.length };
  }
  let derived = 0;
  let failed = 0;
  let truncatedCount = 0;

  for (const c of candidates) {
    const pnl = await deriveRealizedPnl(c.address, { heliusKey, solUsd, cfg });
    if (pnl.ok && pnl.netUsd !== null) {
      c.netProfitUsd = pnl.netUsd;
      c.realizedPnl = pnl;
      c.basis += `; realized ${pnl.netSol >= 0 ? '+' : ''}${pnl.netSol.toFixed(2)} SOL over ${pnl.swaps} swap(s)${pnl.truncated ? ' (history truncated)' : ''}`;
      derived++;
      if (pnl.truncated) truncatedCount++;
    } else {
      // Left null, NOT zero. Rule 2 treats null as a failure, which is the
      // correct reading of "we could not measure this wallet".
      c.netProfitUsd = null;
      failed++;
    }
  }
  console.log(
    `   ↳ realized PnL derived for ${derived}/${candidates.length} wallet(s)` +
      (truncatedCount ? `, ${truncatedCount} with truncated history` : '') +
      (failed ? `, ${failed} unavailable` : '')
  );
  return { derived, failed };
}

/** Count on-chain signatures as a lifetime-activity proxy for finalists. */
async function enrichLifetimeTrades(candidates, rpcUrl, { cache = {}, ttlHours = 24, now = Date.now() } = {}) {
  if (!rpcUrl) return;

  // Cached alongside the replay, because this is the OTHER per-wallet RPC call
  // in an observe sync — 198 calls a pass. Leaving it uncached would keep a
  // warm-cache sync expensive no matter how good the history cache is.
  //
  // A signature COUNT is cheap to be slightly stale about: it feeds Rule 3's
  // >=100 floor, and a wallet near that boundary is not one whose qualification
  // should turn on a few hours of drift.
  let servedFromCache = 0;

  // A failed enrichment leaves lifetimeTrades at the observed buy count, which
  // then fails the >=100 trades rule — so a single transient RPC error silently
  // drops a wallet off the elite list. Observed directly: two consecutive syncs
  // over the same 50 wallets produced 43 and then 46 passes, and the run that
  // lost three enrichments also lost the highest-profit wallet from the top 5.
  //
  // One retry plus a visible count converts that from an invisible coin-flip
  // into something you can see in the log. It is affordable now only because
  // the shortlist is capped — retrying 3,444 wallets would not have been.
  let failed = 0;
  // QUOTA EXHAUSTION IS NOT A RETRYABLE ERROR, and treating it as one is
  // expensive and silent. Measured: with the Helius plan at its limit, a sync
  // ground through 198 wallets x 3 retries for 13.5 MINUTES, set no
  // lifetimeTrades at all, and reported only "N enrichment call(s) failed" —
  // so the run looked like a code fault rather than an account limit. The
  // giveaway was HTTP 429 with the body "max usage reached", which no amount
  // of backoff will clear.
  let quotaExhausted = null;
  for (const c of candidates) {
    if (quotaExhausted) { failed++; continue; }
    const cached = cache[c.address];
    const ageHours = cached?.sigCountAt ? (now - cached.sigCountAt) / 3_600_000 : Infinity;
    if (typeof cached?.sigCount === 'number' && ageHours <= ttlHours) {
      c.lifetimeTrades = cached.sigCount;
      c.basis += `; lifetime activity = ${cached.sigCount} signatures [cached]`;
      servedFromCache++;
      continue;
    }

    let got = null;
    for (let attempt = 0; attempt < 3 && got === null; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1200 * attempt));
      try {
        const r = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSignaturesForAddress',
            params: [c.address, { limit: 1000 }],
          }),
          signal: AbortSignal.timeout(20000),
        });
        const raw = await r.text();
        let j = null;
        try { j = JSON.parse(raw); } catch { /* a quota refusal is plain text */ }

        if (Array.isArray(j?.result)) {
          got = j.result.length;
        } else if (r.status === 429 && /max usage|quota|credit/i.test(raw)) {
          // A hard plan limit, not a rate limit. Stop the whole pass.
          quotaExhausted = raw.trim().slice(0, 120);
          break;
        } else if (r.status === 429 || j?.error?.code === -32429) {
          await new Promise((res) => setTimeout(res, 1500));
        }
      } catch {
        /* retry on network timeout */
      }
    }

    if (got === null) {
      failed++;
      // Fall back to a stale count rather than dropping the wallet — Rule 3
      // reads this, and an absent count fails it.
      if (typeof cached?.sigCount === 'number') {
        c.lifetimeTrades = cached.sigCount;
        c.basis += `; lifetime activity = ${cached.sigCount} signatures [stale cache, refresh failed]`;
      }
    } else {
      c.lifetimeTrades = got;
      c.basis += `; lifetime activity = ${got} signatures${got === 1000 ? ' (capped)' : ''}`;
      cache[c.address] = { ...(cache[c.address] ?? {}), sigCount: got, sigCountAt: now };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (servedFromCache) {
    console.log(`   ↳ ${servedFromCache}/${candidates.length} signature count(s) served from cache (0 RPC)`);
  }
  if (quotaExhausted) {
    console.error(`   🔴 [QUOTA] RPC plan limit reached — "${quotaExhausted}"`);
    console.error(`      ${failed} wallet(s) left unmeasured. Rule 3 reads this, so they cannot qualify this pass.`);
    console.error('      This is an account limit, not a fault: no retry clears it. Wait for the');
    console.error('      quota window to reset, or raise the plan. Cached wallets are unaffected.');
  }

  if (failed) {
    console.log(
      `   ${failed} of ${candidates.length} enrichment call(s) failed after a retry — ` +
        `those wallets keep their observed count and cannot pass the trades rule this sync`
    );
  }
}

/* ------------------------------------------------------------------ *
 * IMPORT mode
 * ------------------------------------------------------------------ */

const NUM = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,%+\s]/g, '').replace(/k$/i, 'e3').replace(/m$/i, 'e6'));
  return Number.isFinite(n) ? n : null;
};

/**
 * Pick a field by any of several plausible header names.
 *
 * Normalises to ALPHANUMERICS ONLY. It previously stripped just spaces,
 * underscores and hyphens, which meant Birdeye's `"PnL (USD)"` normalised to
 * `pnl(usd)` and matched nothing — the column parsed as null and the wallet
 * arrived with no profit figure at all, silently failing Rule 2 for want of a
 * value that was sitting in the file.
 */
export const normaliseHeader = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

const pick = (row, names) => {
  for (const n of names) {
    for (const key of Object.keys(row)) {
      if (normaliseHeader(key) === n) return row[key];
    }
  }
  return null;
};

/**
 * A leaderboard win rate, always as a PERCENTAGE.
 *
 * Providers disagree: GMGN and Cielo export 0.62, Birdeye exports "64%", Dune
 * exports 58.3. Read literally, a 0.62 is compared against a 40 floor and the
 * wallet is rejected for being too good — which is how a whole GMGN import
 * silently qualifies nobody.
 *
 * A bare value at or below 1 is treated as a fraction. That is ambiguous for a
 * genuine 1% win rate, and the ambiguity is resolved in favour of the fraction
 * deliberately: leaderboards rank by performance, so a 1% row is vanishingly
 * unlikely, while 0.x fractions are the house format of two of the four
 * providers. An explicit `%` in the cell always wins over the heuristic.
 */
export function normaliseWinRate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const text = String(raw);
  const n = NUM(text);
  if (n === null) return null;
  if (text.includes('%')) return n;
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map((line) => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)/g)?.filter((_, i) => i % 2 === 0) ?? line.split(',');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = String(cells[i] ?? '').trim().replace(/^"|"$/g, '');
    });
    return row;
  });
}

async function candidatesFromImport(path) {
  const text = await readFile(path, 'utf8');
  const rows =
    extname(path).toLowerCase() === '.csv'
      ? parseCsv(text)
      : (() => {
          const j = JSON.parse(text);
          return Array.isArray(j) ? j : (j.wallets ?? j.data ?? j.results ?? []);
        })();

  // Column aliases, widened against real export headers from all four
  // providers rather than guessed. Each entry below was a column that parsed to
  // null before: `trader` (Dune) produced ZERO candidates from a valid file,
  // `realized_profit` (GMGN) and `PnL (USD)` (Birdeye) dropped the profit
  // figure, and `txs_30d` dropped the trade count.
  const ADDRESS = ['address', 'wallet', 'walletaddress', 'account', 'owner', 'trader', 'signer', 'user', 'makeraddress'];
  const WIN_RATE = ['winrate', 'winratepct', 'winratepercent', 'wr', 'winrate%', 'winpct', 'successrate'];
  const PROFIT = [
    'netprofit', 'netprofitusd', 'realizedpnl', 'realizedpnlusd', 'realizedprofit',
    'realizedprofitusd', 'pnl', 'pnlusd', 'profit', 'profitusd', 'totalpnl',
    'totalpnlusd', 'netpnl', 'netpnlusd', 'totalprofit', 'totalprofitusd',
  ];
  const TRADES = [
    'trades', 'tradecount', 'totaltrades', 'txcount', 'swaps', 'swapcount',
    'totalswaps', 'txs', 'txs30d', 'trades30d', 'numtrades', 'totaltx',
  ];

  const parsed = rows
    .map((row) => ({
      address: String(pick(row, ADDRESS) ?? '').trim(),
      // Percent, always. See normaliseWinRate — two of the four providers
      // export fractions and reading 0.62 against a 40 floor rejects the
      // wallet for being too good.
      winRatePct: normaliseWinRate(pick(row, WIN_RATE)),
      netProfitUsd: NUM(pick(row, PROFIT)),
      lifetimeTrades: NUM(pick(row, TRADES)),
      // The provider's own LIFETIME figures. Flagged so the rules can tell them
      // apart from Aegis's bounded on-chain replay — see applyEliteRules.
      providerMetrics: true,
      source: 'imported-leaderboard',
      basis: `imported from ${path.split(/[\\/]/).pop()}`,
    }))
    .filter((c) => c.address);

  // A file that parsed rows but no addresses is a column-name mismatch, not an
  // empty leaderboard, and the difference matters: one is fixed by editing a
  // header, the other by exporting different data. Saying "0 candidates" for
  // both sent me looking in the wrong place.
  if (rows.length && !parsed.length) {
    console.error(
      `   No address column found. Saw headers: ${Object.keys(rows[0] ?? {}).join(', ')}\n` +
        `   Expected one of: ${ADDRESS.join(', ')} (case and punctuation are ignored).`
    );
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

export async function syncTopWhales({ importPath = null, dryRun = false, reportOnly = false } = {}) {
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));

  // Apply the same .env RPC override the scanner uses. Without this the
  // enrichment step silently ran against the public RPC and got throttled
  // mid-pass, so Rule 3 reported wildly different pass counts on identical
  // data depending on how much rate limit was left.
  const env = await loadEnv(join(HERE, '.env'));
  if (env.rpcOverride) config.rpcUrl = env.rpcOverride;

  const rules = { ...ELITE_RULES, ...(config.eliteWhales ?? {}) };

  // A threshold nothing reads is worse than a missing one: the config then
  // states a rule the sync does not enforce, and nothing about the run reveals
  // it. Warned rather than thrown — an unknown key is a typo or a stale
  // setting, neither of which should stop a sync that is otherwise fine.
  const unread = findUnreadRuleKeys(config.eliteWhales);
  if (unread.length) {
    console.warn(`   [CONFIG] ${unread.length} eliteWhales key(s) are read by NO rule: ${unread.join(', ')}`);
    console.warn('            These are inert. If one was meant to be a threshold, it is not being');
    console.warn('            enforced — check the name against the rules below:');
    console.warn('              minWinRatePct       observed win rate, %');
    console.warn('              minGradedBuys       observed graded buys, count');
    console.warn('              minNetProfitUsd     realized profit, USD');
    console.warn('              minLifetimeTrades   SIGNATURES (not trades), count');
    console.warn('              minAllTimeWinRatePct  on-chain win rate, %');
    console.warn('              minAllTimeTrades    CLOSED ROUND TRIPS, count');
    console.warn('              minAllTimeNetSol    realized profit, SOL');
  }

  // Loaded once per sync, written once at the end.
  //
  // NOT loaded on the import path: an import runs no per-candidate enrichment,
  // so there is nothing to cache and reading a file of per-mint maps to serve
  // zero lookups is pure cost.
  //
  // To be precise about "zero overhead": an import makes no enrichment calls at
  // all, so its cost does not scale with the size of the leaderboard. It is not
  // literally zero network — the system-account screen still runs on the FINAL
  // list (topN at most), and that stays. An imported leaderboard can contain a
  // Raydium pool authority just as easily as an observed one, and that screen
  // is the only thing standing between such an address and the watchlist.
  const onChainCache = importPath ? {} : await loadOnChainCache();
  const cachedBefore = Object.keys(onChainCache).length;

  let candidates = [];
  let source;
  let totalSeen = 0;
  let maturity = null;
  // SOL price, needed to convert derived lamport flow to USD. Bound at this
  // scope because the import path never sets it and PnL derivation is skipped
  // there anyway (imported leaderboards carry real P&L).
  let solUsd = 0;

  if (importPath) {
    candidates = await candidatesFromImport(resolve(importPath));
    source = `import:${importPath}`;
    totalSeen = candidates.length;
    console.log(`Imported ${candidates.length} candidate wallet(s) from ${importPath}`);
  } else {
    const obs = await candidatesFromObservations(config);
    candidates = obs.candidates;
    totalSeen = obs.totalSeen;
    maturity = obs.maturity;
    solUsd = obs.solUsd ?? 0;
    source = 'aegis-observed';
    console.log(
      `Observed ledger: ${totalSeen} wallet(s) seen buying scanned tokens` +
        (obs.solUsd ? ` (SOL @ $${obs.solUsd.toFixed(2)})` : '')
    );

    if (maturity && !maturity.mature) {
      console.log('');
      console.log('LEDGER NOT REPRESENTATIVE — refusing to rank.');
      console.log(
        `   ${maturity.gradedBuys} graded buy(s) across ${maturity.tokens} token(s); ` +
          `${maturity.decidedTokens} token(s) decided.`
      );
      console.log(
        `   Ledger failure rate : ${maturity.tokenFailRate.toFixed(1)}% by token, ` +
          `${maturity.observedFailRate.toFixed(1)}% by buy`
      );
      if (maturity.baseFailRate !== null) {
        console.log(
          `   Post-mortem reality : ${maturity.baseFailRate.toFixed(1)}% across all scanned tokens ` +
            `(need ≥ ${maturity.required.toFixed(1)}%)`
        );
        console.log('');
        console.log('   The ledger is far cleaner than the market it samples, so win rates');
        console.log('   drawn from it are inflated. Buyer replay only reads tokens with a live');
        console.log('   pool, and one popular survivor can supply most of the graded buys —');
        console.log('   a wallet that touched it once then reads as 100%.');
      } else {
        console.log('   No graded failures yet; losers take 1–6h while pumps register at once.');
      }
      console.log('   Ranking stays blocked until the sample looks like the market.');
      return { qualified: [], evaluated: [], written: false, maturity };
    }
  }

  // Reject malformed addresses before they can occupy a slot.
  // Filter at WRITE time as well as read time. Without this a system account
  // that qualified from observations would be written back every sync and only
  // suppressed on load — the file itself would keep lying.
  const wellFormed = [];
  let rejected = 0;
  let systemRejected = 0;
  for (const c of candidates) {
    if (!validateWatchlistEntry(c).valid) { rejected++; continue; }
    if (SYSTEM_ACCOUNTS.has(c.address)) { systemRejected++; continue; }
    wellFormed.push(c);
  }
  if (systemRejected) console.log(`   ${systemRejected} known system/DEX account(s) excluded from ranking`);
  if (rejected) console.log(`   ${rejected} candidate(s) rejected as invalid Solana addresses`);

  // Enrich everything clearing Rule 1, and only Rule 1.
  //
  // Gating on Rule 2 as well was a bug: lifetimeTrades starts as the observed
  // position count, so Rule 3 can only ever pass AFTER enrichment. Requiring
  // Rule 2 first meant no candidate was enriched, and Rule 3 reported 0 passes
  // regardless of the wallet's real history. Win rate is the cheap discriminator
  // and is computed without any network call, so it is the right gate.
  const eligible = wellFormed.filter(
    (c) => c.winRatePct !== null && c.winRatePct >= rules.minWinRatePct
  );

  // ---- Cap the shortlist before any per-wallet network work ---------
  //
  // Everything below this line costs RPC calls PER WALLET — screening, then
  // enrichment — and the ledger had grown to 3,444 eligible wallets. Measured
  // at 111 KB and 0.44s each, that is ~390 MB of JSON and ~25 minutes per sync,
  // against a `topN` of 5 wallets actually written. The overwhelming majority of
  // that work was discarded.
  //
  // Worse, it ran on a maintenance cadence of every 10 minutes, so the loop
  // spent most of its life syncing instead of scanning — the source of the
  // "468 tick(s) skipped while busy" in the logs.
  //
  // SORT KEY: graded buys first, observed buys second. Both are "how much have
  // we actually seen this wallet do", but graded count is the one that gates
  // qualification — the `sample` rule requires minGradedBuys decided outcomes,
  // so a wallet with 40 observed buys and 0 graded ones can never make the list.
  // Sorting on raw observed count alone would let those fill the cap and starve
  // the wallets that can actually qualify.
  //
  // WHAT THIS TRADES AWAY, stated plainly: a wallet outside the top 50 by
  // observation count can no longer be enriched, so it cannot pass the
  // lifetime-trades rule and cannot reach the watchlist. Since the ledger
  // collapses 3-4x per recurrence level (1466 wallets at >=1 graded buy, 9 at
  // >=3), a cap of 50 sits far above where real candidates live. Raise
  // eliteWhales.enrichShortlistCap if that stops being true.
  const cap = config.eliteWhales?.enrichShortlistCap ?? 50;
  const shortlist = capEnrichmentShortlist(eligible, cap);

  if (eligible.length > shortlist.length) {
    console.log(
      `   ↳ shortlist capped: ${eligible.length.toLocaleString()} eligible → top ${shortlist.length} by observed activity ` +
        `(${(100 - (shortlist.length / eligible.length) * 100).toFixed(1)}% of per-wallet RPC work skipped)`
    );
  }

  if (!importPath && shortlist.length) {
    const screenCache = {};
    const clean = [];
    let blocked = 0;
    for (const c of shortlist) {
      const v = await screenSystemAccount(c.address, config.rpcUrl, screenCache, config.smartMoney?.screening ?? {});
      if (v.system) { blocked++; c.systemAccount = v.reason; continue; }
      clean.push(c);
    }
    if (blocked) console.log();
    shortlist.length = 0;
    shortlist.push(...clean);
  }

  if (!importPath && shortlist.length) {
    console.log(`   ↳ enriching ${shortlist.length} shortlisted wallet(s) with on-chain activity…`);
    await enrichLifetimeTrades(shortlist, config.rpcUrl, {
      cache: onChainCache,
      ttlHours: rules.historyCacheTtlHours ?? 24,
      now: Date.now(),
    });

    // Only worth paying for when Rule 2 is actually going to read it. Under
    // profitRule 'skip' the figure is never consulted, and deriving it would
    // add ~4s per wallet for nothing.
    //
    // ALSO SKIPPED when the on-chain replay below is going to run, because that
    // produces allTimeNetProfitUsd and Rule 2 prefers it. Without this guard,
    // flipping profitRule to 'enforce' silently turned on TWO history walks
    // over the same wallets with two different implementations — 198 wallets at
    // ~4s here, plus the replay after it. Observed directly: the sync printed
    // "deriving on-chain realized PnL for 198 wallet(s)" before it had replayed
    // anything, and did not finish inside ten minutes.
    const replayWillRun = Boolean(rules.minAllTimeWinRatePct) || rules.minAllTimeNetSol !== null;
    if (rules.profitRule !== 'skip' && !replayWillRun) {
      const heliusKey = (String(config.rpcUrl ?? '').match(/api-key=([\w-]+)/) ?? [])[1] ?? null;
      console.log(`   ↳ deriving on-chain realized PnL for ${shortlist.length} wallet(s)…`);
      await enrichRealizedPnl(shortlist, {
        heliusKey,
        solUsd,
        cfg: config.eliteWhales ?? {},
      });
    }

    // Rule 4, LAST and on the SURVIVORS ONLY.
    //
    // The rules are AND, so a wallet already failing Rule 1 or 3 can never
    // qualify however good its on-chain record is — replaying its history buys
    // a number nothing will read. This ordering is not a micro-optimisation:
    // measured at ~10s per wallet, running it across the full 200-wallet
    // shortlist took the sync past 20 minutes, and eliteWhales.syncIntervalHours
    // is 2 with the sync running inside the maintenance loop. The
    // enrichShortlistCap note records what happened last time per-wallet work
    // was allowed to dominate that loop: 468 skipped ticks.
    //
    // Rules 1 and 3 are evaluated here rather than reused from applyEliteRules
    // because that function needs Rule 4's input to run at all — this is the
    // same pre-filter, applied early, to decide who is worth measuring.
    if (rules.minAllTimeWinRatePct || rules.minAllTimeNetSol !== null) {
      const heliusKey = (String(config.rpcUrl ?? '').match(/api-key=([\w-]+)/) ?? [])[1] ?? null;
      const fastTrackAt = rules.alphaHunterMegaWins ?? null;
      // REPLAY CAP. The pre-filter below is only as narrow as minWinRatePct,
      // and that number is a ranking choice rather than a cost control — moving
      // it from 45 to 40 took the contender set from 19 wallets to enough that
      // the sync ran past 30 minutes and had to be killed. eliteWhales
      // .syncIntervalHours is 2 and the sync runs inside the maintenance loop,
      // so an unbounded replay here starves the scanner exactly the way the
      // enrichShortlistCap note describes (468 skipped ticks).
      //
      // The shortlist arrives ranked by observed activity, so slicing keeps the
      // wallets most likely to qualify. A wallet cut here is not rejected — it
      // is unmeasured, and unmeasured fails Rules 4 and 5, so the cap is a
      // COVERAGE limit and worth raising if a sync has time to spare.
      //
      // ── THE CAP BOUNDS NETWORK WORK, NOT MEASUREMENT ───────────────────────
      // Wallets already in the history cache are served at ZERO RPC, so capping
      // them buys nothing and costs coverage. Applying the cap before consulting
      // the cache was a real defect and its signature was watchlist CHURN:
      // entries appearing and vanishing between syncs for reasons unrelated to
      // how the wallets traded.
      //
      // MEASURED on the 2026-08-12 sync that exposed it: 40 slots spent, only 10
      // of them cache hits, 360 pages fetched for the other 30 — while three
      // wallets holding FRESH entries 1.9 hours old (TTL 24h) sat outside the cap
      // and were dropped as "unmeasured": Ar2Y6o (+31.2 SOL over 155 closed
      // trades), BEvw9m (+13.5/132) and mpXCgP (+2.2/159). All three qualified on
      // merit and all three had been on the previous list. Ar2Y6o is the best
      // wallet in the measured population.
      //
      // So contenders are partitioned by cache disposition and the cap is applied
      // ONLY to the wallets that would need a fetch. 'incremental' counts as cold:
      // it is past TTL and still costs at least one call, even if usually only one.
      //
      // CACHED WALLETS GO FIRST in the replay list, which also hardens the quota
      // path — enrichOnChainWinRate stops serving anything but cache hits once it
      // sees a hard 429, so doing the free ones first means a mid-pass quota death
      // costs only cold wallets.
      const replayCap = rules.maxOnChainReplays ?? 40;
      const contenders = shortlist.filter((c) => {
        // An Alpha Hunter skips rules 1-3, so it would never appear in this
        // pre-filter — and it still NEEDS the replay, because the net-SOL rule
        // is not waived and reads c.onChain. Omitting them here would make the
        // fast-track unreachable: every hunter would fail Rule 5 for want of a
        // measurement nobody took.
        if (fastTrackAt && (c.megaWinCount ?? 0) >= fastTrackAt) return true;
        return (
          c.winRatePct !== null &&
          c.winRatePct >= rules.minWinRatePct &&
          (c.gradedBuys ?? 0) >= (rules.minGradedBuys ?? 0) &&
          c.lifetimeTrades !== null &&
          c.lifetimeTrades >= rules.minLifetimeTrades
        );
      });
      // ONE timestamp for both the partition and the enrichment. Two Date.now()
      // calls would let a wallet classify 'fresh' here and 'incremental' inside
      // enrichOnChainWinRate — it would then be admitted past the cap AND make a
      // network call, which is the one combination this split exists to prevent.
      const replayNow = Date.now();
      const { cached, cold } = partitionByCacheDisposition(contenders, onChainCache, {
        ttlHours: rules.historyCacheTtlHours ?? 24,
        dustSol: rules.dustTradeSol ?? 0.05,
        now: replayNow,
      });
      const coldReplaying = cold.slice(0, replayCap);
      const replaying = [...cached, ...coldReplaying];
      const skipped = cold.length - coldReplaying.length;

      console.log(
        `   ↳ replaying on-chain history for ${replaying.length} of ${shortlist.length} wallet(s) ` +
          `— only those already passing rules 1-3 can qualify` +
          ` (${cached.length} cached, 0 RPC and exempt from the cap` +
          `; ${coldReplaying.length} cold against the ${replayCap} cap)` +
          (skipped ? `, ${skipped} cold wallet(s) over the cap and left unmeasured` : '') +
          ` (floor ${rules.minAllTimeWinRatePct}% over ${rules.minAllTimeTrades ?? 0}+ trades)…`
      );
      await enrichOnChainWinRate(replaying, {
        heliusKey,
        cfg: config.eliteWhales ?? {},
        solUsd,
        cache: onChainCache,
        now: replayNow,
      });

      // GMGN LAST, and only over the wallets that were actually measured.
      //
      // Ordering matters for cost, not for correctness: a wallet that failed
      // the replay cannot qualify under Rules 4 and 5 whatever GMGN says about
      // it, so fetching a career P&L for it buys a number nothing will read —
      // the same argument that puts the replay itself after Rules 1-3.
      //
      // Runs on the OBSERVE path only. An imported row already carries the
      // provider's own lifetime figures in netProfitUsd/winRatePct with
      // providerMetrics set, so re-fetching them would pay for data the file
      // supplied.
      await enrichGmgnMetrics(replaying, {
        apiKey: env.gmgnKey,
        cfg: config.eliteWhales?.gmgn ?? {},
      });
    }
  }

  // Anything flagged during screening cannot qualify, regardless of its stats.
  const { evaluated, qualified: ranked } = applyEliteRules(wellFormed, rules);

  // Screen ONLY the wallets that would actually be written, then backfill from
  // the next-ranked candidates.
  //
  // Screening the whole shortlist was the obvious placement and it was wrong:
  // hundreds of wallets at up to ~10s each pushed a sync past ten minutes. The
  // qualified set is topN entries, so this bounds the cost to a handful of calls
  // while still guaranteeing nothing on the final list is a pool authority.
  const screenCache = {};
  const qualified = [];
  let systemBlocked = 0;
  for (const c of ranked.length ? ranked : []) {
    if (qualified.length >= rules.topN) break;
    const v = await screenSystemAccount(
      c.address,
      config.rpcUrl,
      screenCache,
      config.smartMoney?.screening ?? {}
    );
    if (v.system) {
      systemBlocked++;
      console.log(`   ${c.address.slice(0, 12)}… rejected — ${v.reason}`);
      continue;
    }
    qualified.push(c);
  }
  if (systemBlocked) {
    console.log(
      `   ${systemBlocked} pool authority/system account(s) kept off the elite list`
    );
  }

  // ---- reporting ---------------------------------------------------
  //
  // RULES 4 AND 5 ARE COUNTED HERE TOO, and they were not before. The report
  // walked checks.sample/winRate/netProfit/trades and stopped, so the two rules
  // that read the on-chain replay never appeared — a sync blocked entirely by
  // the net-SOL floor printed four healthy pass counts and then "passing all
  // three: 0", with nothing naming the rule that did it.
  //
  // That gap matters at the current floors: minAllTimeNetSol is 200 SOL against
  // a measured best of +37.5, so Rule 5 IS the binding constraint and the log
  // has to say so rather than leave a zero to be explained.
  const failing = { sample: 0, winRate: 0, netProfit: 0, trades: 0, netSol: 0, onChainWinRate: 0 };
  for (const c of evaluated) {
    if (!c.checks.sample) failing.sample++;
    if (!c.checks.winRate) failing.winRate++;
    if (!c.checks.netProfit) failing.netProfit++;
    if (!c.checks.trades) failing.trades++;
    if (!c.checks.netSol) failing.netSol++;
    if (!c.checks.onChainWinRate) failing.onChainWinRate++;
  }

  console.log('');
  console.log(`Composite Elite Ranking — ${evaluated.length} candidate(s) evaluated`);
  // Reported first because it is the gate that actually disqualifies most
  // candidates. Leaving it out made Rule 2 look like the sole blocker while a
  // 100%-win-rate-on-one-trade population sat behind it.
  console.log(
    `   Gate 0  graded sample ≥ ${rules.minGradedBuys ?? 0}  → ${evaluated.length - failing.sample} pass` +
      (failing.sample === evaluated.length ? '   ← blocking everything' : '')
  );
  console.log(`   Rule 1  win rate ≥ ${rules.minWinRatePct}%      → ${evaluated.length - failing.winRate} pass`);
  console.log(
    rules.profitRule === 'skip'
      ? `   Rule 2  net profit          → SKIPPED (lifetime P&L is not observable; see config)`
      : `   Rule 2  net profit ≥ $${rules.minNetProfitUsd.toLocaleString('en-US')} → ${evaluated.length - failing.netProfit} pass`
  );
  // The observed PnL spread, so a floor that admits nobody is visibly a floor
  // problem rather than a mystery. Without this, "0 pass" gives no indication
  // of whether the bar is slightly high or three orders of magnitude out.
  if (rules.profitRule !== 'skip') {
    // ONLY wallets with a real on-chain derivation. Every candidate carries a
    // netProfitUsd from walletStats (an estimate from observed spend), and
    // mixing the two would report a spread across 10,000 wallets when 48 were
    // actually measured.
    // Reads the SAME field Rule 2 judged on. It previously read netProfitUsd
    // unconditionally, which after Rule 2 moved to allTimeNetProfitUsd made the
    // diagnostic report "no Helius key, or every lookup failed" on a run where
    // the key was present and 26 replays had succeeded — a false explanation
    // for a real rejection, which is worse than no explanation.
    const derived = evaluated
      .map((c) =>
        typeof c.allTimeNetProfitUsd === 'number' && Number.isFinite(c.allTimeNetProfitUsd)
          ? c.allTimeNetProfitUsd
          : c.realizedPnl?.ok
            ? c.netProfitUsd
            : null
      )
      .filter((n) => typeof n === 'number' && Number.isFinite(n))
      .sort((a, b) => b - a);
    if (derived.length) {
      const median = derived[Math.floor(derived.length / 2)];
      const positive = derived.filter((n) => n > 0).length;
      console.log(
        `           derived PnL across ${derived.length} wallet(s): ` +
          `best ${money(derived[0])} · median ${money(median)} · worst ${money(derived[derived.length - 1])} · ` +
          `${positive} positive`
      );
      if (derived[0] < rules.minNetProfitUsd) {
        console.log(
          `           the best wallet is ${money(derived[0])} against a ${money(rules.minNetProfitUsd)} floor — ` +
            `no floor above ${money(derived[0])} can ever admit anyone`
        );
      }
    } else if (importPath) {
      // Imports carry the provider's own lifetime P&L; nothing is derived, and
      // saying "no Helius key" here blames the wrong thing entirely.
      const withProfit = evaluated.filter((c) => typeof c.netProfitUsd === 'number').length;
      console.log(
        `           judged on the leaderboard's own P&L column — ${withProfit}/${evaluated.length} row(s) carried one` +
          (withProfit < evaluated.length
            ? '; rows without a recognised profit column cannot pass this rule'
            : '')
      );
    } else {
      console.log('           derived PnL: none available (no Helius key, or every lookup failed)');
    }
  }
  console.log(`   Rule 3  trades ≥ ${rules.minLifetimeTrades}         → ${evaluated.length - failing.trades} pass`);

  if (rules.minAllTimeWinRatePct) {
    console.log(
      `   Rule 4  on-chain WR ≥ ${rules.minAllTimeWinRatePct}% over ${rules.minAllTimeTrades ?? 0}+ trades → ` +
        `${evaluated.length - failing.onChainWinRate} pass`
    );
  }

  if (rules.minAllTimeNetSol !== null && rules.minAllTimeNetSol !== undefined) {
    console.log(
      `   Rule 5  realized net SOL > ${rules.minAllTimeNetSol} → ${evaluated.length - failing.netSol} pass`
    );
    // The same diagnostic Rule 2 carries, for the same reason: a floor that
    // admits nobody should be visibly a FLOOR problem rather than a mystery.
    // Only wallets whose history was actually replayed are counted — every
    // other candidate has no onChain figure at all, and folding those in would
    // report a spread across thousands of wallets when a few dozen were
    // measured.
    const nets = evaluated
      .map((c) => c.onChain?.netSol)
      .filter((n) => typeof n === 'number' && Number.isFinite(n))
      .sort((a, b) => b - a);
    if (nets.length) {
      const median = nets[Math.floor(nets.length / 2)];
      console.log(
        `           realized SOL across ${nets.length} replayed wallet(s): ` +
          `best ${nets[0].toFixed(1)} · median ${median.toFixed(1)} · worst ${nets[nets.length - 1].toFixed(1)} · ` +
          `${nets.filter((n) => n > 0).length} positive`
      );
      if (nets[0] <= rules.minAllTimeNetSol) {
        console.log(
          `           the best wallet is ${nets[0].toFixed(1)} SOL against a ${rules.minAllTimeNetSol} SOL floor — ` +
            `no floor above ${nets[0].toFixed(1)} can admit anyone from this population`
        );
      }
    } else {
      console.log('           realized SOL: none derived (no Helius key, quota, or every replay failed)');
    }
  }

  console.log(`   passing every rule: ${qualified.length} (writing top ${Math.min(qualified.length, rules.topN)})`);

  for (const [i, w] of qualified.slice(0, 10).entries()) {
    console.log(
      `   ${String(i + 1).padStart(2)}. ${w.address}  ${w.winRatePct.toFixed(0)}% WR · ${money(w.netProfitUsd)} · ${w.lifetimeTrades} trades`
    );
  }

  // Persisted before any early return, so a sync that qualifies nobody still
  // banks the RPC work it just paid for. Discarding it there would make the
  // most common outcome — a strict rule set rejecting everyone — also the one
  // that never warms the cache.
  if (!importPath && Object.keys(onChainCache).length) {
    await saveOnChainCache(pruneOnChainCache(onChainCache, rules));
    const added = Object.keys(onChainCache).length - cachedBefore;
    if (added > 0) console.log(`   ↳ on-chain cache: +${added} wallet(s), ${Object.keys(onChainCache).length} total`);
  }

  if (reportOnly) return { qualified, evaluated, written: false };

  if (!qualified.length) {
    console.log('');
    console.log('No wallet cleared every rule — smart_wallets.json left untouched.');
    console.log('   The rules are strict by design; an empty elite list is correct when');
    console.log('   nothing has earned a place, and is safer than a padded one.');
    console.log('   NOTE: "left untouched" means the file keeps its PREVIOUS contents, which');
    console.log('   were admitted under whatever rules were in force then. Read the _comment');
    console.log('   header inside it for those, not the config as it stands now.');
    if (!importPath && failing.sample === evaluated.length) {
      const decided = maturity?.decidedTokens ?? 0;
      console.log(`   Every wallet failed the graded-sample floor of ${rules.minGradedBuys}.`);
      console.log(`   Only ${decided} token(s) in the ledger have a decided outcome, and a wallet`);
      console.log(`   cannot have more graded buys than there are decided tokens — so the floor`);
      console.log(`   is unreachable until many more tokens resolve AND the same wallets recur`);
      console.log(`   across them. Most wallets are seen exactly once.`);
      console.log('');
      console.log('   This is a long game: observe mode needs weeks of recurring traders.');
      console.log('   For a list today, import a leaderboard:');
      console.log('     node auto_top_whales.mjs --import <file.csv>');
    } else if (!importPath) {
      // The money rules are reported TOGETHER because at matching floors they
      // are one bar in two units — minAllTimeNetSol x the SOL price IS
      // allTimeNetProfitUsd — so blaming either alone describes half a cause.
      const moneyBlocked =
        (rules.minAllTimeNetSol !== null &&
          rules.minAllTimeNetSol !== undefined &&
          failing.netSol === evaluated.length) ||
        (rules.profitRule !== 'skip' && failing.netProfit === evaluated.length);

      if (moneyBlocked) {
        const nets = evaluated
          .map((c) => c.onChain?.netSol)
          .filter((n) => typeof n === 'number' && Number.isFinite(n))
          .sort((a, b) => b - a);
        console.log('   The REALIZED-PROFIT floor rejected every candidate.');
        if (nets.length) {
          // Distinguishes a floor that is merely high from one nothing can
          // reach. The earlier version of this branch blamed observation for
          // being unable to derive lifetime P&L, which stopped being true when
          // Rule 2 moved onto the on-chain replay — it now misdiagnoses a
          // deliberate threshold as a missing measurement.
          console.log(
            `   ${nets.length} wallet(s) WERE replayed successfully, so this is a threshold,`
          );
          console.log(
            `   not a measurement failure: best ${nets[0].toFixed(1)} SOL against a floor of ` +
              `${rules.minAllTimeNetSol} SOL`
          );
          console.log(
            `   ($${Math.round(rules.minNetProfitUsd).toLocaleString('en-US')} on Rule 2). Nothing observed is within ` +
              `${nets[0] > 0 ? (rules.minAllTimeNetSol / nets[0]).toFixed(1) : '∞'}x of it.`
          );
        } else {
          console.log('   No wallet history could be replayed at all — check the Helius key and quota');
          console.log('   before reading this as a verdict on the wallets.');
        }
        console.log('   Lower eliteWhales.minAllTimeNetSol / minNetProfitUsd, or import a');
        console.log('   leaderboard carrying real lifetime P&L (Rule 5 does not apply to imports):');
      } else {
        console.log('   OBSERVE mode needs more graded history. To seed it now,');
      }
      console.log('     node auto_top_whales.mjs --import <file.csv>');
    }
    return { qualified, evaluated, written: false };
  }

  // NOTE: an empty result never reaches here. The `!qualified.length` branch
  // above returns first, leaving smart_wallets.json untouched — which is the
  // behaviour that matters when a rule is tightened, since a watchlist
  // overwritten with zero wallets does not fail loudly. matchSmartMoney would
  // simply stop matching and the scanner would go quiet for a reason nothing
  // reports. A second guard was written here before that path was traced; it
  // was unreachable and is not worth the code.
  const watchlist = buildWatchlist(qualified, { source, rules });
  if (!dryRun) {
    await writeFile(
      join(HERE, config.smartMoney.watchlistFile),
      JSON.stringify(watchlist, null, 2),
      'utf8'
    );
    console.log(`\nWrote ${qualified.length} elite wallet(s) to ${config.smartMoney.watchlistFile}`);
  } else {
    console.log('\n[DRY RUN] nothing written');
  }

  return { qualified, evaluated, written: !dryRun };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--import');
  await syncTopWhales({
    importPath: i !== -1 ? argv[i + 1] : null,
    dryRun: argv.includes('--dry-run'),
    reportOnly: argv.includes('--report'),
  });
}
