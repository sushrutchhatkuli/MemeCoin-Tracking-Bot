#!/usr/bin/env node
/**
 * Telegram channel listener — MTProto tap into signal / trending channels.
 *
 *   node telegram_listener.mjs --login     one-time: produce a session string
 *   node telegram_listener.mjs             listen and audit
 *   node telegram_listener.mjs --dry-run   listen and print, audit nothing
 *   node telegram_listener.mjs --channels  list chats the session can see
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A USER SESSION AND NOT A BOT TOKEN
 *
 * A bot cannot read a channel it does not administer. Telegram's Bot API simply
 * does not deliver those messages, so the bot token already in .env is useless
 * here. Reading channels you merely subscribe to requires MTProto with a USER
 * session — your account, not a bot.
 *
 * That session string grants full access to your Telegram account. It is a
 * credential in the strongest sense: anyone holding it can read your DMs and
 * send as you. Consequences of that:
 *
 *   - YOU run `--login`, nobody else. It asks for your phone number, an SMS
 *     code and your 2FA password. Never paste those into a chat, a script you
 *     did not read, or an assistant — including this one.
 *   - The session goes in .env (already gitignored), never in config.json.
 *   - Revoke it any time from Telegram → Settings → Devices.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY MODEL — CHANNEL TEXT IS DATA, NOT INSTRUCTION
 *
 * Everything arriving here is written by strangers with a financial interest in
 * what you do next. This module therefore does exactly one thing with a message:
 * it runs a base58 regex over the text and keeps the matches. It does not follow
 * links, does not parse commands, does not read "BUY NOW" as a reason to do
 * anything, and does not trust a single claim a channel makes about a token.
 *
 * An extracted address is a QUESTION for the audit pipeline, never an answer.
 * It goes through the same security shield, insider-cluster and scoring path as
 * an address Aegis discovered itself, so a channel that posts a rug gets the
 * rug verdict. The listener widens the funnel; it does not widen trust.
 *
 * The practical consequence worth knowing: these channels are frequently paid
 * promotion, and being posted in one is not evidence of anything. Expect most
 * of what arrives here to be filtered out, and treat a pass as the audit's
 * opinion rather than the channel's.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { loadEnv } from './telegram.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Address extraction — pure, and the part worth testing
 * ------------------------------------------------------------------ */

/**
 * A MAXIMAL base58 run of mint length. Solana's alphabet excludes 0, O, I and
 * l, which is what makes this narrower than it looks.
 *
 * The boundary assertions are load-bearing, not decoration. Without them the
 * bare `{32,44}` is greedy and will happily carve an 88-character transaction
 * signature into TWO false 44-character "mints" — and signature links are
 * exactly what trending channels post all day. Requiring the run to be
 * unbordered by further base58 characters means an over-long run matches
 * nothing at all, which is the correct answer for a signature.
 */
const BASE58_RUN =
  /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

/**
 * Addresses that match the shape but are never a tradeable mint. Without this
 * the listener re-audits wrapped SOL and the token program every time a channel
 * mentions them, which is constantly.
 */
export const NON_MINT_ADDRESSES = new Set([
  'So11111111111111111111111111111111111111112', // wrapped SOL
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL token program
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // token-2022
  '11111111111111111111111111111111', // system program
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // associated token program
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  '4ckmDgGdxQoPDLUkDT3vHgSAkzA3QRdNq5ywwY4sUSJn',
]);

/**
 * Pull candidate Solana mints out of arbitrary message text.
 *
 * Deliberately permissive on shape and strict on nothing else: this cannot tell
 * a mint from a wallet or a pool address, and it does not try. The DexScreener
 * lookup downstream is the real filter — if no tradeable pair exists for an
 * address, it is dropped there. Guessing here would only add a way to be wrong.
 *
 * Signatures are 87-88 base58 characters, so they fall outside the 32-44 window
 * naturally rather than by special-casing.
 */
export function extractMints(text) {
  if (!text || typeof text !== 'string') return [];
  const seen = new Set();
  for (const match of text.matchAll(BASE58_RUN)) {
    const addr = match[0];
    if (NON_MINT_ADDRESSES.has(addr)) continue;
    // pump.fun mints end in "pump" and are the common case; no filtering on
    // that, it is just the reason the length window matters more than a suffix.
    if (addr.length < 32 || addr.length > 44) continue;
    seen.add(addr);
  }
  return [...seen];
}

/**
 * Rolling de-duplicator.
 *
 * Trending channels repost the same contract for hours, and several channels
 * post the same one within seconds of each other. Without this the pipeline
 * would re-audit one token dozens of times per hour and burn the RPC budget on
 * an answer it already has.
 */
export class SeenCache {
  constructor(windowMinutes = 90) {
    this.windowMs = windowMinutes * 60 * 1000;
    this.seen = new Map();
  }

  /** True if this address is new (and records it). False if seen recently. */
  admit(address, now = Date.now()) {
    const last = this.seen.get(address);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.seen.set(address, now);
    if (this.seen.size > 5000) {
      for (const [k, t] of this.seen) {
        if (now - t >= this.windowMs) this.seen.delete(k);
      }
    }
    return true;
  }
}

/**
 * Match a message's chat against the configured channel list.
 *
 * Channels can be named by @username, t.me link, numeric id or plain title, so
 * all four are normalised and compared case-insensitively. An empty list means
 * "watch everything this session can see" — noisy, but a deliberate option.
 */
export function channelMatches(chat, configured) {
  if (!configured?.length) return true;
  const candidates = [
    chat?.username,
    chat?.title,
    chat?.id !== undefined && chat?.id !== null ? String(chat.id) : null,
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());

  return configured.some((raw) => {
    const want = String(raw)
      .toLowerCase()
      .replace(/^https?:\/\/t\.me\//, '')
      .replace(/^@/, '')
      .trim();
    return candidates.some((c) => c === want || c.includes(want));
  });
}

/* ------------------------------------------------------------------ *
 * Audit hand-off
 * ------------------------------------------------------------------ */

/**
 * Feed one address into the ordinary scan pipeline.
 *
 * Imported lazily so `--login` and the pure-function tests do not drag in the
 * whole scanner (and its state files) just to parse a string.
 */
async function auditAddress(address, { source, dryRun }) {
  const when = new Date().toISOString().slice(11, 19);
  console.log(`[${when}] 📡 ${source} → ${address}${dryRun ? '  [dry run, not audited]' : ''}`);
  if (dryRun) return;

  try {
    const { runScan } = await import('./scan.mjs');
    // realtime:true keeps it silent unless the token actually clears every
    // gate — the listener must not turn a noisy channel into a noisy phone.
    const result = await runScan({ token: address, realtime: true, fromListener: true });
    const alerts = result?.alerts?.length ?? 0;
    if (alerts) console.log(`[${when}]    🚀 ${alerts} alert(s) sent for ${address}`);
  } catch (err) {
    console.error(`[${when}]    audit failed for ${address}: ${err.message}`);
  }
}

/**
 * Serialised work queue.
 *
 * Two audits at once would race on the shared state files the scanner writes —
 * the same reason loop.mjs guards against overlapping ticks. A burst of
 * addresses is therefore drained one at a time, with a small gap so a channel
 * dumping twenty contracts cannot saturate the RPC.
 */
export class AuditQueue {
  constructor({ minGapSeconds = 4, maxLength = 40, dryRun = false } = {}) {
    this.minGapMs = minGapSeconds * 1000;
    this.maxLength = maxLength;
    this.dryRun = dryRun;
    this.items = [];
    this.draining = false;
    this.dropped = 0;
  }

  push(address, source) {
    if (this.items.length >= this.maxLength) {
      // Dropping the newest keeps the queue's head — the earliest sightings,
      // which are the ones with any timing edge left — rather than discarding
      // them to make room for a flood.
      this.dropped++;
      return false;
    }
    this.items.push({ address, source });
    this.drain();
    return true;
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.items.length) {
        const { address, source } = this.items.shift();
        await auditAddress(address, { source, dryRun: this.dryRun });
        if (this.items.length) await new Promise((r) => setTimeout(r, this.minGapMs));
      }
    } finally {
      this.draining = false;
    }
  }
}

/* ------------------------------------------------------------------ *
 * MTProto transport
 * ------------------------------------------------------------------ */

/**
 * GramJS is an optional dependency. Loading it lazily means the pure helpers
 * above — and the test suite — work whether or not it is installed, and the
 * failure message when it is missing says exactly what to run.
 *
 * NOTE: the `telegram` package (GramJS) is archived upstream. It still works,
 * and `teleproto` is a largely API-compatible maintained fork if you would
 * rather be on something that receives fixes:  npm i teleproto
 * The import below is the only line that would need to change.
 */
async function loadGramJs() {
  try {
    const mod = await import('telegram');
    const sessions = await import('telegram/sessions/index.js');
    const events = await import('telegram/events/index.js');
    return {
      TelegramClient: mod.TelegramClient,
      Api: mod.Api,
      StringSession: sessions.StringSession,
      NewMessage: events.NewMessage,
    };
  } catch (err) {
    throw new Error(
      `MTProto client not available (${err.message}).\n` +
        `   Install it with:  npm install telegram\n` +
        `   Or the maintained fork:  npm install teleproto  (then edit loadGramJs)`
    );
  }
}

function requireCredentials(env) {
  const apiId = Number(env.tgApiId);
  const apiHash = env.tgApiHash;
  if (!apiId || !apiHash) {
    console.error('❌ TELEGRAM_API_ID / TELEGRAM_API_HASH are not set in aegis/.env');
    console.error('   Get them from https://my.telegram.org → API development tools.');
    process.exit(1);
  }
  return { apiId, apiHash };
}

/**
 * Interactive login. Run by the account owner, once.
 *
 * Prompts are read from the terminal and never logged. The resulting session
 * string is printed once, for you to paste into .env yourself — it is not
 * written to disk here, so it cannot end up in a file you forgot about.
 */
async function login() {
  const { TelegramClient, StringSession } = await loadGramJs();
  const env = await loadEnv(join(HERE, '.env'));
  const { apiId, apiHash } = requireCredentials(env);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);

  console.log('\nThis signs in as YOUR Telegram account and prints a session string.');
  console.log('Anyone holding that string can read and send your messages. Keep it secret.\n');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: () => ask('Phone number (with country code): '),
    password: () => ask('2FA password (blank if you have none): '),
    phoneCode: () => ask('Code Telegram just sent you: '),
    onError: (err) => console.error(`   login error: ${err.message}`),
  });

  const session = client.session.save();
  await rl.close();

  console.log('\n✅ Signed in. Add this line to aegis/.env and do not share it:\n');
  console.log(`TELEGRAM_SESSION=${session}\n`);
  await client.disconnect();
  process.exit(0);
}

/** Print every dialog the session can see, so config channels can be named exactly. */
async function listChannels() {
  const { TelegramClient, StringSession } = await loadGramJs();
  const env = await loadEnv(join(HERE, '.env'));
  const { apiId, apiHash } = requireCredentials(env);
  if (!env.tgSession) {
    console.error('❌ TELEGRAM_SESSION not set. Run: node telegram_listener.mjs --login');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(env.tgSession), apiId, apiHash, {
    connectionRetries: 3,
  });
  await client.connect();

  console.log('Chats visible to this session:\n');
  for await (const dialog of client.iterDialogs({ limit: 200 })) {
    const e = dialog.entity ?? {};
    if (!dialog.isChannel && !dialog.isGroup) continue;
    console.log(
      `  ${String(dialog.title ?? '(untitled)').slice(0, 44).padEnd(46)} ` +
        `${e.username ? `@${e.username}`.padEnd(26) : ''.padEnd(26)} id:${e.id}`
    );
  }
  await client.disconnect();
  process.exit(0);
}

async function listen({ dryRun }) {
  const { TelegramClient, StringSession, NewMessage } = await loadGramJs();
  const config = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8'));
  const cfg = config.telegramListener ?? {};
  if (cfg.enabled === false) {
    console.log('telegramListener.enabled is false — nothing to do.');
    process.exit(0);
  }

  const env = await loadEnv(join(HERE, '.env'));
  const { apiId, apiHash } = requireCredentials(env);
  if (!env.tgSession) {
    console.error('❌ TELEGRAM_SESSION not set. Run: node telegram_listener.mjs --login');
    console.error('   That flow is interactive and must be run by you, not by an assistant.');
    process.exit(1);
  }

  const channels = cfg.channels ?? [];
  const seen = new SeenCache(cfg.dedupeWindowMinutes ?? 90);
  const queue = new AuditQueue({
    minGapSeconds: cfg.minSecondsBetweenScans ?? 4,
    maxLength: cfg.maxQueueLength ?? 40,
    dryRun,
  });

  const client = new TelegramClient(new StringSession(env.tgSession), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  const me = await client.getMe();

  console.log('═'.repeat(64));
  console.log('  AEGIS — TELEGRAM CHANNEL LISTENER');
  console.log('═'.repeat(64));
  console.log(`  signed in as  : ${me?.username ? `@${me.username}` : me?.firstName ?? 'unknown'}`);
  console.log(`  channels      : ${channels.length ? channels.join(', ') : 'ALL visible chats'}`);
  console.log(`  dedupe window : ${cfg.dedupeWindowMinutes ?? 90} min`);
  console.log(`  mode          : ${dryRun ? 'DRY RUN — parse only, no audit' : 'audit every new mint'}`);
  console.log('  Channel text is treated as data, never instruction.');
  console.log('  Ctrl+C to stop.');
  console.log('═'.repeat(64));

  let messages = 0;
  let extracted = 0;

  client.addEventHandler(async (update) => {
    const msg = update?.message;
    if (!msg) return;
    const text = msg.message ?? msg.text ?? '';
    if (!text) return;

    let chat = null;
    try {
      chat = await msg.getChat();
    } catch {
      /* a chat we cannot resolve is still worth parsing when unfiltered */
    }
    if (!channelMatches(chat, channels)) return;

    messages++;
    const source = chat?.title ?? chat?.username ?? 'unknown channel';

    for (const address of extractMints(text)) {
      if (!seen.admit(address)) continue;
      extracted++;
      queue.push(address, source);
    }
  }, new NewMessage({}));

  const shutdown = async () => {
    console.log('');
    console.log('═'.repeat(64));
    console.log(`  messages matched : ${messages}`);
    console.log(`  mints queued     : ${extracted}`);
    console.log(`  dropped (queue)  : ${queue.dropped}`);
    console.log('═'.repeat(64));
    try {
      await client.disconnect();
    } catch {
      /* already gone */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  if (argv.includes('--login')) await login();
  else if (argv.includes('--channels')) await listChannels();
  else await listen({ dryRun: argv.includes('--dry-run') });
}
