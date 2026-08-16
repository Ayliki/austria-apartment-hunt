import { Markup, type Telegraf } from 'telegraf';
import {
  type DB, type ListingRow,
  getAllSearchProfiles, getSwipedWithDirection, matchesPrefs, MCP_CHAT_ID,
} from './db.js';
import { rankListings } from './scoring.js';
import { getCommuteLineFor, type ComputeCommuteFn, type GeocodeFn } from './bot.js';
import { t } from './locales.js';

/** Caps a single push burst per user — protects against a preference change (or a big poll) flooding a chat. */
export const MAX_PUSH_PER_USER = 5;

/**
 * Milliseconds to wait between one matching profile's push and the next. Telegram applies flood
 * control per chat-pair-of-seconds; staggering multi-profile bursts (Tasks 7-9 let one chat hold
 * several saved searches) keeps a single poll cycle from firing every profile's messages back to
 * back. Exported so tests can assert on it and inject a no-op delay instead of actually sleeping.
 */
export const PUSH_STAGGER_MS = 1500;

/** Injectable so tests don't actually sleep; production callers omit this and get the real timer. */
export type DelayFn = (ms: number) => Promise<void>;
const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pure — one compact line per listing for a push notification's body: title, price, size/rooms/district,
 * an optional appended commute line, and the link. Local to this file: pushes are the only remaining
 * surface needing a compact multi-listing format, so nothing is shared with or imported from bot.ts
 * here — `commuteLine` is a plain string computed by the caller via bot.ts's getCommuteLineFor helper.
 */
export function formatPushEntry(l: ListingRow, commuteLine: string | null = null): string {
  const parts = [
    l.price != null ? `€${l.price}` : 'price n/a',
    l.area != null ? `${l.area}m²` : null,
    l.rooms != null ? `${l.rooms} rooms` : null,
    l.district != null ? `district ${l.district}` : null,
  ].filter(Boolean).join(' · ');
  const commuteSuffix = commuteLine ? `\n${commuteLine}` : '';
  return `${l.title}\n${parts}${commuteSuffix}\n${l.url}`;
}

/**
 * Proactively messages every user whose preferences match a freshly-polled listing, so they see it
 * as soon as it's found instead of only on their next /next. Best-ranked matches are sent first;
 * the MCP sentinel chat is skipped since it has no real Telegram chat to push to.
 *
 * Delivery is grouped and paced per profile rather than bursting one message per listing: each
 * matching profile gets a header (naming the profile, since Tasks 7-9 let one chat hold several
 * saved searches) followed by one compact message per shown listing, each with a [View ▸] button
 * that opens the full card on demand. A stagger between profiles avoids Telegram flood-control on
 * chats with multiple active searches.
 *
 * Product decision (flagged by Task 3's review, resolved here): getAllSearchProfiles returns every
 * saved profile for a chat regardless of its `active` flag, and this function deliberately does not
 * filter by `active` — every saved search stays "live" for polling/pushing, not just the one the
 * user currently has selected in /searches. `active` only controls which profile /next, /shortlist,
 * and other single-profile UI act on; it is not a pause switch for a saved search.
 */
export async function notifyNewMatches(
  telegram: Telegraf['telegram'], db: DB, newListings: ListingRow[], computeCommute: ComputeCommuteFn, geocode: GeocodeFn,
  delay: DelayFn = realDelay,
): Promise<void> {
  if (newListings.length === 0) return;

  let first = true;
  for (const profile of getAllSearchProfiles(db)) {
    if (profile.chatId === MCP_CHAT_ID) continue;

    const matches = newListings.filter((l) => matchesPrefs(l, profile.prefs));
    if (matches.length === 0) continue;

    if (!first) await delay(PUSH_STAGGER_MS);
    first = false;

    const ranked = rankListings(matches, getSwipedWithDirection(db, profile.chatId));
    const toShow = ranked.slice(0, MAX_PUSH_PER_USER);

    const headerKey = matches.length === 1 ? 'push_header_one' : 'push_header_many';
    await telegram.sendMessage(profile.chatId, t(db, profile.chatId, headerKey, { name: profile.name, count: matches.length }));

    for (const l of toShow) {
      // A single Routes API failure must degrade this one listing to no commute line, not abort the
      // whole profile's push (the old pre-Task-10 caller effectively could, since it awaited commute
      // inline with no isolation between listings) — genuinely more resilient than prior behavior.
      let commuteLine: string | null = null;
      try {
        commuteLine = await getCommuteLineFor(db, profile.id, l, profile.prefs, computeCommute, geocode);
      } catch {
        commuteLine = null;
      }
      const viewButton = Markup.inlineKeyboard([
        [Markup.button.callback(t(db, profile.chatId, 'push_view'), `view:${l.id}`)],
      ]);
      await telegram.sendMessage(profile.chatId, formatPushEntry(l, commuteLine), viewButton);
    }

    if (matches.length > toShow.length) {
      await telegram.sendMessage(
        profile.chatId,
        t(db, profile.chatId, 'push_more', { count: matches.length - toShow.length }),
      );
    }
  }
}
