import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpConnection } from 'apt-hunter/dist/mcp-client.js';
import { willhabenSpec, immoscoutSpec } from 'apt-hunter/dist/hunt.js';
import { openDb } from './db.js';
import { createBot, BOT_COMMANDS, type BotDeps } from './bot.js';
import { runPoll } from './poller.js';
import { refreshAllListings } from './refresh.js';
import { notifyNewMatches } from './notify.js';
import { geocode, computeCommute } from './commute.js';

const POLL_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3h, matches apt-hunter's LaunchAgent cadence
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h so listings taken down between polls get flagged faster than the previous daily sweep

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN env var is required');
  // Commute times are best-effort: an unset key just means every card ships without them (see commute.ts's error handling).
  const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';

  const here = dirname(fileURLToPath(import.meta.url)); // swipe-bot/dist
  const dbPath = process.env.SWIPE_BOT_DB_PATH ?? join(here, '..', 'data', 'bot.sqlite');
  const db = openDb(dbPath);
  const deps: BotDeps = {
    geocode: (address) => geocode(address, mapsApiKey),
    computeCommute: (origin, destination) => computeCommute(origin, destination, mapsApiKey),
  };
  const bot = createBot(db, token, deps);
  await bot.telegram.setMyCommands(BOT_COMMANDS); // populates Telegram's persistent ☰ menu

  const poll = async () => {
    try {
      const { inserted, warnings } = await runPoll(db);
      for (const w of warnings) console.error('WARNING:', w);
      console.log(`poll: ${inserted.length} new listings`);
      await notifyNewMatches(bot.telegram, db, inserted, deps.computeCommute, deps.geocode);
    } catch (err) {
      console.error('poll failed:', err);
    }
  };

  // Refreshes photos/address for every stored listing and flags/cleans up ones taken off the site.
  // The first run after this ships (right here, at startup) doubles as the one-time backfill for
  // rows inserted before this feature existed — there's no separate backfill script.
  const refresh = async () => {
    const willhabenConn = new McpConnection(willhabenSpec());
    const immoscoutConn = new McpConnection(immoscoutSpec());
    try {
      await willhabenConn.connect();
      await immoscoutConn.connect();
      const summary = await refreshAllListings(db, { willhaben: willhabenConn, immoscout: immoscoutConn });
      console.log('refresh:', JSON.stringify(summary));
      if (summary.deletionSkippedFor.length > 0) {
        console.error(`refresh: BLAST RADIUS GUARD TRIPPED for ${summary.deletionSkippedFor.join(', ')} — skipped this cycle's delete pass, investigate before the next sweep`);
      }
    } catch (err) {
      console.error('refresh failed:', err);
    } finally {
      await willhabenConn.close().catch((err) => console.error('willhaben conn close failed:', err));
      await immoscoutConn.close().catch((err) => console.error('immoscout conn close failed:', err));
    }
  };

  await poll(); // seed the DB immediately on startup, then on the interval
  const pollTimer = setInterval(poll, POLL_INTERVAL_MS);

  refresh(); // fire-and-forget: backfill on first start, but must never block bot.launch() — a full-DB sweep can take minutes and refresh() already has its own internal try/catch, never throws
  const refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);

  // Register signal handlers before launching: launch() in long-polling mode
  // never resolves while the bot is running, so handlers registered after
  // `await`ing it would only take effect once the bot has already stopped.
  //
  // The interval above keeps the event loop alive forever, so bot.stop()
  // alone never lets the process exit — systemd's SIGTERM then times out
  // after 90s and SIGKILLs it, and the next deploy's fresh getUpdates call
  // collides with the still-dying old one (409 Conflict). Clear the timer
  // and exit explicitly so shutdown is immediate.
  const shutdown = (signal: string) => {
    clearInterval(pollTimer);
    clearInterval(refreshTimer);
    try {
      bot.stop(signal);
    } catch (err) {
      console.error('bot.stop failed during shutdown:', err);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

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
