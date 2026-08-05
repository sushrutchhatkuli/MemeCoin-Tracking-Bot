/**
 * Social presence scanner.
 *
 * SCOPE — worth being precise about, because the name oversells it:
 * this checks whether a token DECLARES social links in its DexScreener /
 * launchpad metadata. It does not read X or Telegram, does not measure
 * engagement, follower counts, or KOL involvement, and cannot tell a live
 * community from a link registered thirty seconds ago pointing at an empty
 * account. Reading actual social activity needs the X API (paid).
 *
 * What it IS good for: absence. A token with no socials at all is a genuine
 * abandonment signal, and that is the strongest inference available here.
 */

const KNOWN_TYPES = ['twitter', 'telegram', 'discord'];

export function analyzeSocials(pair, config) {
  const info = pair?.info ?? {};
  const socials = info.socials ?? [];
  const websites = info.websites ?? [];

  const found = new Map();
  for (const s of socials) {
    const type = String(s?.type ?? '').toLowerCase();
    if (!type || !s?.url) continue;
    if (!found.has(type)) found.set(type, s.url);
  }

  const hasTwitter = found.has('twitter');
  const hasTelegram = found.has('telegram');
  const hasWebsite = websites.length > 0;
  const totalLinks = found.size + websites.length;

  const cfg = config.social ?? {};
  const bonusFull = cfg.bonusBothSocials ?? 10;
  const bonusPartial = cfg.bonusOneSocial ?? 5;

  let scoreBonus = 0;
  let status;
  let tag;

  if (hasTwitter && hasTelegram) {
    scoreBonus = bonusFull;
    status = `X + Telegram present ✅${hasWebsite ? ' (+ website)' : ''}`;
    tag = 'social/full';
  } else if (hasTwitter || hasTelegram) {
    scoreBonus = bonusPartial;
    status = `${hasTwitter ? 'X only' : 'Telegram only'} ⚠️${hasWebsite ? ' (+ website)' : ''}`;
    tag = 'social/partial';
  } else if (hasWebsite) {
    scoreBonus = 0;
    status = 'Website only, no X or Telegram ⚠️';
    tag = 'social/partial';
  } else {
    scoreBonus = 0;
    status = '⚠️ NO SOCIALS (High Abandonment Risk)';
    tag = 'social/none';
  }

  return {
    hasTwitter,
    hasTelegram,
    hasWebsite,
    totalLinks,
    noSocials: totalLinks === 0,
    scoreBonus,
    status,
    tag,
    links: {
      twitter: found.get('twitter') ?? null,
      telegram: found.get('telegram') ?? null,
      discord: found.get('discord') ?? null,
      website: websites[0]?.url ?? null,
    },
    other: [...found.keys()].filter((t) => !KNOWN_TYPES.includes(t)),
  };
}

/** One-line summary for the console and the Telegram digest. */
export function socialBadge(social) {
  if (!social) return '';
  if (social.noSocials) return ' ⚠️nosocial';
  if (social.hasTwitter && social.hasTelegram) return ' 🐦tg';
  if (social.hasTwitter) return ' 🐦';
  if (social.hasTelegram) return ' tg';
  return '';
}
