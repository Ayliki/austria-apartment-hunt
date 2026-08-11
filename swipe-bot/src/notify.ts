import type { Telegraf } from 'telegraf';
import {
  type DB, type ListingRow,
  getAllUserPrefs, getSwipedWithDirection, matchesPrefs, MCP_CHAT_ID,
} from './db.js';
import { rankListings } from './scoring.js';
import { sendCard } from './bot.js';

/** Caps a single push burst per user — protects against a preference change (or a big poll) flooding a chat. */
export const MAX_PUSH_PER_USER = 5;

/**
 * Proactively messages every user whose preferences match a freshly-polled listing, so they see it
 * as soon as it's found instead of only on their next /next. Best-ranked matches are sent first;
 * the MCP sentinel chat is skipped since it has no real Telegram chat to push to.
 */
export async function notifyNewMatches(telegram: Telegraf['telegram'], db: DB, newListings: ListingRow[]): Promise<void> {
  if (newListings.length === 0) return;

  for (const prefs of getAllUserPrefs(db)) {
    if (prefs.chatId === MCP_CHAT_ID) continue;

    const matches = newListings.filter((l) => matchesPrefs(l, prefs));
    if (matches.length === 0) continue;

    const ranked = rankListings(matches, getSwipedWithDirection(db, prefs.chatId));
    const toSend = ranked.slice(0, MAX_PUSH_PER_USER);

    await telegram.sendMessage(
      prefs.chatId,
      `${matches.length} new listing${matches.length === 1 ? '' : 's'} just matched your search:`
    );
    for (const listing of toSend) {
      await sendCard(telegram, prefs.chatId, listing);
    }
    if (matches.length > toSend.length) {
      await telegram.sendMessage(prefs.chatId, `+${matches.length - toSend.length} more — check /next.`);
    }
  }
}
