import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createBot } from './bot.js';
import { runPoll } from './poller.js';

const POLL_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3h, matches apt-hunter's LaunchAgent cadence

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN env var is required');

  const here = dirname(fileURLToPath(import.meta.url)); // swipe-bot/dist
  const dbPath = process.env.SWIPE_BOT_DB_PATH ?? join(here, '..', 'data', 'bot.sqlite');
  const db = openDb(dbPath);

  const poll = async () => {
    try {
      const { inserted, warnings } = await runPoll(db);
      for (const w of warnings) console.error('WARNING:', w);
      console.log(`poll: ${inserted} new listings`);
    } catch (err) {
      console.error('poll failed:', err);
    }
  };

  await poll(); // seed the DB immediately on startup, then on the interval
  setInterval(poll, POLL_INTERVAL_MS);

  const bot = createBot(db, token);

  // Register signal handlers before launching: launch() in long-polling mode
  // never resolves while the bot is running, so handlers registered after
  // `await`ing it would only take effect once the bot has already stopped.
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  // Don't await: use the onLaunch callback for the startup log instead, and
  // an explicit .catch() so startup failures (e.g. bad token, network error
  // during the getMe() call launch() makes before polling starts) are still
  // caught and logged/exit non-zero, instead of becoming an unhandled
  // rejection that main().catch() would never see.
  bot
    .launch(() => console.log('swipe-bot: Telegram long-polling started'))
    .catch((err) => {
      console.error('bot.launch failed:', err);
      process.exit(1);
    });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
