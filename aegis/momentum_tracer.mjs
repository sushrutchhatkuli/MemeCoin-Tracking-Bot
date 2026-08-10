/**
 * 5-minute holder velocity & volume surge tracker.
 *
 * Answers one question: is this token accelerating RIGHT NOW, or has it merely
 * been busy for an hour?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON THE FIVE-MINUTE WINDOW. The two halves of this are not equally achievable,
 * and the difference is measured, not assumed.
 *
 * VOLUME is genuinely 5-minute resolution. DexScreener publishes `volume.m5` in
 * the same payload the scanner already fetches for pricing, so the surge is
 * computed from a real 5-minute figure at zero extra cost and with no state at
 * all.
 *
 * HOLDERS ARE NOT, and cannot be made so by configuration. A holder count comes
 * from the security provider, which is only called when a token is AUDITED, and
 * `auditCooldownMinutes` (10) deliberately stops a token being re-audited more
 * often than that. Measured across the last 24h of snapshots.json: 1,454 holder
 * samples, median gap between consecutive samples 10.0 minutes, and only 10 of
 * 301 recent gaps under 5 minutes. There is no 5-minute holder sample in this
 * pipeline to read.
 *
 * So what is implemented is the achievable thing, and it is labelled honestly:
 * the delta is taken against the baseline CLOSEST to five minutes old, NORMALISED
 * to a per-5-minute rate, and the alert states the REAL elapsed window whenever
 * it was not actually five minutes. "+94 in 10.2m (≈46/5m)" is a true statement;
 * "+94 in 5m" would not be.
 *
 * This follows the precedent already set for sellSignals.liquidityDrain, whose
 * config note records the same problem with the specified 10-second window and
 * the same resolution: implement what the data supports, and never fabricate
 * precision in the number a reader uses to judge urgency.
 *
 * To get true 5-minute holder resolution the count must be polled on its own
 * timer, independent of the audit cooldown — a separate process like
 * liquidity_watch.mjs, not a config change.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── WHAT THE SIGNAL IS WORTH ────────────────────────────────────────────────
 * Both inputs are manufacturable, and cheaply. Holder count is inflated by
 * dusting a thousand wallets; 5-minute volume is inflated by wash trading
 * between wallets you control. config.json's dynamicConcentration note already
 * records that these two specific metrics are "precisely what someone gaming a
 * scanner would fake, because they are what scanners look at."
 *
 * That is why the bonus is forfeited unless the contract audit affirmatively
 * PASSED, the same bar the mega-runner and Jito tip bonuses are held to. Rapid
 * holder growth on a clean contract is a crowd arriving. The identical numbers
 * on an unaudited one are the shape of a token being pumped into an exit.
 */

const MS_PER_MIN = 60_000;

/**
 * Volume surge: the last 5 minutes against the pace of the hour before it.
 *
 * The baseline is (h1 - m5) / 11 — the mean of the ELEVEN PRECEDING five-minute
 * blocks, not h1/12. Including the current block in its own baseline damps the
 * exact spike this is meant to detect: a token doing nothing for an hour and
 * then $50k in five minutes scores 11x against the preceding blocks and only
 * 5.5x against a baseline that contains the spike.
 *
 * `surgePct` is the percentage INCREASE over that baseline, so +200% means the
 * current block is 3x the prior pace.
 *
 * Returns ok:false when there is no usable baseline — a token with no volume in
 * the preceding hour has an undefined surge, not an infinite one. Measured on
 * live scanned tokens, 14 of 90 had no usable baseline, so this is the common
 * case for fresh launches rather than an edge case.
 */
export function volumeVelocity({ demand, config = {} } = {}) {
  const cfg = config.momentum ?? {};
  const minSurgePct = cfg.minVolumeSurgePct ?? 200;
  const minAbsUsd = cfg.minVolume5mUsd ?? 2_000;

  const vol5m = demand?.volume?.m5;
  const volH1 = demand?.volume?.h1;

  if (vol5m === null || vol5m === undefined || volH1 === null || volH1 === undefined) {
    return { ok: false, reason: 'volume data unavailable', qualifies: false };
  }

  const baseline = (volH1 - vol5m) / 11;
  if (!(baseline > 0)) {
    return {
      ok: false,
      reason: 'no volume in the preceding hour — surge is undefined, not infinite',
      vol5m,
      qualifies: false,
    };
  }

  const surgePct = (vol5m / baseline - 1) * 100;

  // The absolute floor is not decoration. A token doing $12 in the prior hour
  // and $200 now is a 1,733% surge and is still nothing; without a floor the
  // loudest momentum readings in the engine would come from the deadest pools.
  const qualifies = surgePct >= minSurgePct && vol5m >= minAbsUsd;

  return {
    ok: true,
    vol5m,
    baseline5m: baseline,
    surgePct,
    minSurgePct,
    minAbsUsd,
    qualifies,
    belowAbsoluteFloor: surgePct >= minSurgePct && vol5m < minAbsUsd,
  };
}

/**
 * Holder velocity from the snapshot history, normalised to a per-5-minute rate.
 *
 * Baseline selection is deliberately "closest to the target window" rather than
 * "most recent". The most recent sample can be 40 seconds old when a token is
 * audited twice in quick succession, and a 40-second delta multiplied up to a
 * 5-minute rate turns three arrivals into "+22/5m" — noise amplified by the
 * normalisation itself. Bounding by minBaselineAgeSeconds is what stops that.
 *
 * maxBaselineAgeSeconds bounds the other end: an hour-old baseline describes
 * what the token did over an hour, and calling that "momentum right now" is the
 * error this whole module exists to avoid.
 */
export function holderVelocity({ history = [], currentHolders = null, now = Date.now(), config = {} } = {}) {
  const cfg = config.momentum ?? {};
  const targetSec = cfg.holderWindowSeconds ?? 300;
  const minAgeSec = cfg.minBaselineAgeSeconds ?? 60;
  const maxAgeSec = cfg.maxBaselineAgeSeconds ?? 900;
  const minDelta = cfg.minHolderDelta5m ?? 30;
  // How far from 300s the window may sit before the label must state the real
  // elapsed time instead of saying "5m".
  const exactToleranceSec = cfg.exactWindowToleranceSeconds ?? 60;

  if (currentHolders === null || currentHolders === undefined) {
    return { ok: false, reason: 'holder count unknown', qualifies: false };
  }

  const usable = history.filter((h) => {
    if (h?.holders === null || h?.holders === undefined || !h.t) return false;
    const ageSec = (now - h.t) / 1000;
    return ageSec >= minAgeSec && ageSec <= maxAgeSec;
  });

  if (!usable.length) {
    return {
      ok: false,
      reason: `no holder baseline between ${minAgeSec}s and ${maxAgeSec}s old`,
      qualifies: false,
    };
  }

  // Closest to the target window, not the newest and not the oldest.
  const baseline = usable.reduce((best, h) =>
    Math.abs((now - h.t) / 1000 - targetSec) < Math.abs((now - best.t) / 1000 - targetSec) ? h : best
  );

  const windowMinutes = (now - baseline.t) / MS_PER_MIN;
  const delta = currentHolders - baseline.holders;
  const perFiveMin = (delta / windowMinutes) * 5;
  const exact = Math.abs((now - baseline.t) / 1000 - targetSec) <= exactToleranceSec;

  return {
    ok: true,
    delta,
    baselineHolders: baseline.holders,
    currentHolders,
    windowMinutes,
    perFiveMin,
    exact,
    minDelta,
    qualifies: perFiveMin >= minDelta,
  };
}

/**
 * `VIRAL MOMENTUM: +47 new holders in 5m` — one renderer, so the header, the
 * detail block and the console log can never disagree.
 *
 * The requested wording is used verbatim when the window really was five
 * minutes. When it was not, the line carries the true window and the normalised
 * rate instead, because a reader deciding whether to chase a breakout is acting
 * on exactly that number.
 */
export function formatMomentumLine({ holders, volume } = {}) {
  const parts = [];

  if (holders?.qualifies) {
    parts.push(
      holders.exact
        ? `+${Math.round(holders.delta)} new holders in 5m`
        : `+${Math.round(holders.delta)} new holders in ${holders.windowMinutes.toFixed(1)}m (~${Math.round(holders.perFiveMin)}/5m)`
    );
  }
  if (volume?.qualifies) {
    parts.push(`volume +${Math.round(volume.surgePct)}% vs the prior hour's pace`);
  }

  return parts.length ? `VIRAL MOMENTUM: ${parts.join(' | ')}` : null;
}

/**
 * Combine both halves into one verdict.
 *
 * EITHER trigger is sufficient, as specified. They measure different things —
 * holders is people arriving, volume is money moving, and a token can do one
 * without the other — so requiring both would mostly detect neither.
 *
 * `snapshot` is the token's PRIOR state entry, read before recordSnapshot
 * overwrites it. Passing the post-write entry would compare the current
 * observation against itself and report zero growth on every token forever.
 */
export function traceMomentum({ demand, snapshot = null, security = null, config = {}, now = Date.now() } = {}) {
  const cfg = config.momentum ?? {};
  if (cfg.enabled === false) {
    return { detected: false, qualifies: false, scoreBoost: 0, label: null, skipped: 'momentum disabled' };
  }

  const volume = volumeVelocity({ demand, config });
  const holders = holderVelocity({
    history: snapshot?.history ?? [],
    currentHolders: security?.ok ? security.totalHolders : null,
    now,
    config,
  });

  const qualifies = Boolean(holders.qualifies || volume.qualifies);
  const label = formatMomentumLine({ holders, volume });

  const reasons = [];
  if (holders.qualifies) {
    reasons.push(
      holders.exact
        ? `${holders.baselineHolders} -> ${holders.currentHolders} holders in 5m (floor +${holders.minDelta}/5m)`
        : `${holders.baselineHolders} -> ${holders.currentHolders} holders over ${holders.windowMinutes.toFixed(1)}m, a rate of ~${Math.round(holders.perFiveMin)}/5m (floor +${holders.minDelta}/5m)`
    );
  }
  if (volume.qualifies) {
    reasons.push(
      `$${Math.round(volume.vol5m).toLocaleString('en-US')} in 5m against a $${Math.round(volume.baseline5m).toLocaleString('en-US')} prior-hour pace (+${Math.round(volume.surgePct)}%, floor +${volume.minSurgePct}%)`
    );
  }
  if (volume.belowAbsoluteFloor) {
    reasons.push(
      `Volume surged +${Math.round(volume.surgePct)}% but only $${Math.round(volume.vol5m).toLocaleString('en-US')} moved — under the $${volume.minAbsUsd.toLocaleString('en-US')} floor, so it counts for nothing`
    );
  }

  return {
    detected: qualifies,
    qualifies,
    holders,
    volume,
    label,
    reasons,
    // Awarded by scoreToken only when the contract audit affirmatively PASSED.
    scoreBoost: qualifies ? (cfg.scoreBoost ?? 10) : 0,
    // True when the holder half rested on a normalised window rather than a real
    // 5-minute one. Surfaced so the alert can say so rather than implying
    // precision the pipeline cannot deliver.
    holderWindowNormalised: Boolean(holders.qualifies && !holders.exact),
  };
}
