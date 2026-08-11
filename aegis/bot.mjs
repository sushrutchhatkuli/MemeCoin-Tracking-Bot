#!/usr/bin/env node
/**
 * Interactive Telegram command assistant.
 *
 *   node bot.mjs                    start the long-poll listener
 *   node bot.mjs --once /status     run one command locally, print, exit
 *   node bot.mjs --once "/audit <mint>"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS, AND WHAT IT IS NOT
 *
 * It is the ENTRY POINT and the dependency wiring. It is NOT a second Telegram
 * client: the getUpdates long-poll loop, the chat-id authorisation check, the
 * command parser and every report renderer already live in telegram.mjs, which
 * is also what the scanner imports to send alerts.
 *
 * Reimplementing the poller here would mean two authorisation checks that can
 * drift apart, and the one that drifts is the one that decides whether a
 * stranger can run scans against your RPC quota and read back your open
 * positions. There is one of those checks in this codebase, in runCommandBot,
 * and this file calls it.
 *
 * So what is actually here is the part that genuinely differs between "the
 * scanner sending an alert" and "you asking a question": which loaders the
 * command handlers get, and how the process starts and stops.
 *
 * ── ON THE LOADERS ─────────────────────────────────────────────────────────
 * They are lazy and per-command, not loaded once at boot, because this process
 * is long-lived and the files underneath it are rewritten by the scanner while
 * it runs. A watchlist cached at startup would answer /whales with whatever was
 * true when you launched the bot — auto_top_whales.mjs rewrites that file every
 * two hours, so the cached answer would be stale by design.
 *
 * They are also SPLIT rather than pooled. loadStatus reads the observation
 * ledger, which is ~16 MB of JSON; /whales does not need it and does not pay
 * for it. One combined loader would make every command as expensive as the most
 * expensive one.
 *
 * ── SIDE EFFECTS ───────────────────────────────────────────────────────────
 * There are none. Every command reads. /audit runs the full analysis through
 * auditOnce(), which writes no note, opens no position and fires no alert —
 * asking about a token must never be a way to accidentally enter one.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  handleCommand,
  loadAlertLog,
  loadEnv,
  parseCommand,
  runCommandBot,
} from './telegram.mjs';
import { loadBlacklist } from './blacklist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const readJson = async (path, fallback = null) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
};

const loadConfig = () => readJson(join(HERE, 'config.json'), {});

/**
 * The loaders the command handlers call.
 *
 * Built as a factory rather than a module-level constant so a test can supply
 * its own `HERE`-equivalent, and so nothing touches the filesystem at import
 * time — importing this module must be free.
 */
export function buildDeps({ here = HERE } = {}) {
  return {
    /**
     * One-token analysis for /audit and /insiders.
     *
     * scan.mjs is imported lazily: it pulls in the entire pipeline (sources,
     * audit, smart money, deployer history) and telegram.mjs is imported BY
     * scan.mjs, so loading it at module scope here would be circular. The same
     * reason telegram.mjs's own CLI defers it.
     */
    auditOnce: async (address) => {
      const { auditOnce } = await import('./scan.mjs');
      return auditOnce(address);
    },

    /** Everything /status reports on. Re-read per call — see the note above. */
    loadStatus: async () => {
      const config = await loadConfig();
      const { loadPositions } = await import('./sell_notifier.mjs');
      const { loadWatchlist } = await import('./smart_money.mjs');
      const { loadObservations } = await import('./wallet_observations.mjs');

      const [positions, watchlist, observations, alertLog, blacklist, heartbeat] =
        await Promise.all([
          loadPositions(),
          loadWatchlist(join(here, config.smartMoney?.watchlistFile ?? 'smart_wallets.json')),
          loadObservations(join(here, '.state', 'wallet_observations.json')),
          loadAlertLog(join(here, '.state', 'alerts.json')),
          loadBlacklist(join(here, 'dev_blacklist.json')),
          // Written by loop.mjs each tick. Absent until the loop has run once,
          // and /status says so rather than implying a stopped scanner is live.
          readJson(join(here, '.state', 'scan_heartbeat.json'), null),
        ]);

      return { config, positions, watchlist, observations, alertLog, blacklist, heartbeat };
    },

    /**
     * The raw watchlist file for /whales.
     *
     * Deliberately NOT loadWatchlist(): that returns a validated, system-account
     * screened index keyed for matching, and in doing so drops win_rate,
     * graded_buys and the generated-at block — which is the entire content of
     * this command. It also makes an RPC call per wallet to screen them, which
     * is the wrong price for answering a question about a local file.
     */
    loadWhales: async () => {
      const config = await loadConfig();
      return readJson(join(here, config.smartMoney?.watchlistFile ?? 'smart_wallets.json'), {
        wallets: [],
      });
    },

    /**
     * The config, for renderers that need it — currently the wallet profile
     * roster behind the 1-tap links. Separate from loadWhales so a caller that
     * only wants the watchlist does not pay for a second file read, and re-read
     * per call for the same reason every other loader here is.
     */
    loadConfig,
  };
}

/**
 * Telegram HTML to terminal text.
 *
 * Entities are decoded AFTER tags are stripped, and `&amp;` last of all — decode
 * it first and `&amp;lt;` becomes `&lt;` becomes `<`, which would resurrect
 * markup out of text that was escaped precisely to stop that.
 */
export function toPlainText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    // Anchors keep their URL. In Telegram the label IS the tap target, but a
    // terminal cannot tap anything — stripping the href left "/whales" printing
    // a list of bare words where the links used to be, which is precisely the
    // information --once exists to show.
    .replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, (_, url, label) => `${label}: ${url}`)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Render one command locally and print it. No Telegram, no credentials. */
async function runOnce(input) {
  const parsed = parseCommand(input.startsWith('/') ? input : `/${input}`);
  if (!parsed) {
    console.error(`Not a command: ${input}`);
    process.exit(1);
  }
  const reply = await handleCommand({ ...parsed, deps: buildDeps() });
  // Tags stripped and entities decoded so the output is readable in a terminal.
  // The real reply is HTML because that is what Telegram renders — decoding
  // here rather than sending plain text keeps this a VIEW of the real message
  // instead of a second format that could drift from it.
  console.log(toPlainText(reply));
}

const USAGE = [
  'Usage:',
  '  node bot.mjs                  start the long-poll command listener',
  '  node bot.mjs --once "/status" run one command locally and exit',
  '  node bot.mjs --once "/audit <mint>"',
].join('\n');

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const onceAt = argv.indexOf('--once');

  if (onceAt !== -1) {
    const command = argv.slice(onceAt + 1).join(' ').trim();
    if (!command) {
      console.error(USAGE);
      process.exit(1);
    }
    await runOnce(command);
    process.exit(0);
  }

  // An UNRECOGNISED FLAG MUST NOT START THE DAEMON.
  //
  // This previously fell through: `node bot.mjs --cmd /whales` found no --once,
  // ignored the arguments entirely and silently started the long-poll listener.
  // Three of those were observed running at once against one bot token, where
  // Telegram's getUpdates gives 409s and each update reaches whichever poller
  // asks first — so commands appear to be answered intermittently for reasons
  // nothing explains. Someone typing a command flag wants a command, and the
  // failure mode of guessing wrong is a background daemon they did not ask for.
  const stray = argv.filter((a) => a.startsWith('-'));
  if (stray.length) {
    console.error(`Unknown option: ${stray.join(' ')}\n`);
    console.error(USAGE);
    process.exit(1);
  }
  // A bare command with no flag is what someone means, so run it rather than
  // making them re-type it: `node bot.mjs /whales`.
  if (argv.length) {
    await runOnce(argv.join(' ').trim());
    process.exit(0);
  }

  const credentials = await loadEnv(join(HERE, '.env'));
  if (!credentials.botToken || !credentials.chatId) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing.');
    console.error('   Copy aegis/.env.example to aegis/.env and fill both values.');
    console.error('   Or run one command without them:  node bot.mjs --once "/status"');
    process.exit(1);
  }

  const controller = new AbortController();
  const shutdown = () => {
    console.log('\nAegis command assistant stopped.');
    controller.abort();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await runCommandBot({ credentials, deps: buildDeps(), signal: controller.signal });
}
