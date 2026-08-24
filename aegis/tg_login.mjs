#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const envPath = join(HERE, '.env');

async function main() {
  console.log('====================================================');
  console.log('AEGIS TELEGRAM AUTHENTICATION SETUP');
  console.log('====================================================\n');

  let envText = '';
  try {
    envText = await readFile(envPath, 'utf8');
  } catch (e) {}

  const getEnv = (key) => {
    const match = envText.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1].trim() : '';
  };

  const apiId = Number(getEnv('TELEGRAM_API_ID')) || 36690868;
  const apiHash = getEnv('TELEGRAM_API_HASH') || 'ae4cbefde3d065851c2d338c98a32807';

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);

  const phoneRaw = await ask('Enter your Telegram Phone Number (e.g. +17745351476): ');
  const phoneNumber = phoneRaw.replace(/[^0-9+]/g, '');

  console.log(`\nConnecting to Telegram DC1 for ${phoneNumber}...`);
  
  const session = new StringSession('');
  session.setDC(1, '149.154.175.56', 80);

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();

  let res;
  try {
    res = await client.sendCode(
      {
        apiId,
        apiHash,
      },
      phoneNumber
    );
    console.log('\n----------------------------------------------------');
    console.log('✅ LOGIN CODE SENT!');
    if (res.isCodeViaApp) {
      console.log('👉 Code was delivered to your MOBILE PHONE Telegram App!');
      console.log('   (Check your mobile phone Telegram chat named "Telegram").');
    } else {
      console.log('👉 Code was sent via SMS text message.');
    }
    console.log('----------------------------------------------------\n');
  } catch (err) {
    console.error(`❌ Error sending code: ${err.message}`);
    process.exit(1);
  }

  let codeInput = await ask('Enter the 5-digit code (or type "sms" to request SMS text): ');

  if (codeInput.trim().toLowerCase() === 'sms') {
    console.log('Requesting SMS resend...');
    try {
      await client.invoke(
        new Api.auth.ResendCode({
          phoneNumber,
          phoneCodeHash: res.phoneCodeHash,
        })
      );
      console.log('✅ SMS Code requested! Check your SMS text messages.');
    } catch (e) {
      console.log('Resend note:', e.message);
    }
    codeInput = await ask('Enter the 5-digit code received via SMS: ');
  }

  try {
    await client.signIn({
      phoneNumber,
      phoneCodeHash: res.phoneCodeHash,
      phoneCode: codeInput.trim(),
    });
  } catch (err) {
    if (err.message.includes('SESSION_PASSWORD_NEEDED')) {
      const password = await ask('Enter your 2FA password: ');
      await client.signInWithPassword({
        apiId,
        apiHash,
        password,
      });
    } else {
      console.error(`❌ Login failed: ${err.message}`);
      process.exit(1);
    }
  }

  const sessionString = client.session.save();
  console.log('\n====================================================');
  console.log('🎉 AUTHENTICATION SUCCESSFUL!');
  console.log('====================================================\n');

  if (envText.includes('TELEGRAM_SESSION=')) {
    envText = envText.replace(/^TELEGRAM_SESSION=.*$/m, `TELEGRAM_SESSION=${sessionString}`);
  } else {
    envText += `\nTELEGRAM_SESSION=${sessionString}\n`;
  }
  await writeFile(envPath, envText, 'utf8');
  console.log('Saved TELEGRAM_SESSION to aegis/.env.\n');

  await client.disconnect();
  rl.close();

  console.log('You can now run:');
  console.log('  node aegis/review_channel.mjs --channel Tcalledpresence\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
