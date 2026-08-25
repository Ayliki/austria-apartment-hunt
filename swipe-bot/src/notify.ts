import { type Telegraf, Markup } from 'telegraf';
import {
  type DB, type ListingRow, type SearchProfile,
  getAllSearchProfiles, getSwipedWithDirection, matchesPrefs, MCP_CHAT_ID,
  getCandidateListings, getNotifySettings, updateNotifySettings,
  recordNotified, countInstantSince, getNotifiedListingIds,
} from './db.js';
import { scoreListings } from './scoring.js';
import { viennaHour, viennaDayStartIso, isQuietHour, instantThreshold, isDigestDue } from './notify-policy.js';
import { sendPhotoCached } from './photo.js';
import { cardLabels, HTML_SEND_EXTRA } from './bot.js';
import { formatCard, CARD_CAPTION_LIMIT, CARD_MESSAGE_LIMIT } from './card.js';
import { isPermanentChatError } from './telegram-errors.js';
import { t } from './locales.js';

/** Trailing window the instant threshold's percentile is computed over. */
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Most listings a single digest enumerates before collapsing the rest into a count. */
export const MAX_DIGEST_LINES = 5;

/**
 * One compact line per listing for a digest body.
 *
 * The labels are ours, not the listing's, so they follow the chat's language — a translated header
 * and button wrapped around an English body was the one place the digest leaked English into a ru/de
 * chat. The title and the url stay exactly as the source published them: translating scraped content
 * would misrepresent the ad. `m²` is a unit symbol, identical in all three catalogs.
 */
export function formatPushEntry(db: DB, chatId: number, l: ListingRow, commuteLine: string | null = null): string {
  const parts = [
    l.price != null ? `€${l.price}` : t(db, chatId, 'notify_entry_price_unknown'),
    l.area != null ? `${l.area}m²` : null,
    l.rooms != null ? t(db, chatId, 'notify_entry_rooms', { rooms: l.rooms }) : null,
    l.district != null ? t(db, chatId, 'notify_entry_district', { district: l.district }) : null,
  ].filter(Boolean).join(' · ');
  const commuteSuffix = commuteLine ? `\n${commuteLine}` : '';
  return `${l.title}\n${parts}${commuteSuffix}\n${l.url}`;
}

/** Every profile eligible to receive anything: real chat, not paused. */
function notifiableProfiles(db: DB): SearchProfile[] {
  return getAllSearchProfiles(db).filter(
    (p) => p.chatId !== MCP_CHAT_ID && !getNotifySettings(db, p.id).paused,
  );
}

/**
 * Scores of everything this profile matched in the trailing 30 days — the sample the instant
 * percentile is measured against. Uses the profile's own swipe history, so the threshold tracks
 * the same learned ranking the deck does.
 */
function recentScoresFor(db: DB, profile: SearchProfile, now: Date): number[] {
  const cutoff = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();
  const recent = getCandidateListings(db, profile.chatId, profile.prefs)
    .filter((l) => l.firstSeen >= cutoff);
  return scoreListings(recent, getSwipedWithDirection(db, profile.chatId)).map((s) => s.score);
}

/**
 * Proactively messages a profile about a genuinely strong new match, at most `dailyCap` times a
 * Vienna day and never during quiet hours.
 *
 * Deliberately different from the pre-2026-08-19 behaviour, which pushed up to 5 full photo-album
 * cards per profile per 3h poll with no cap, no pause, and no quiet hours. Here a listing must
 * clear both an absolute bar (valueFlag 'good') and a relative one (top `instantPercentile` of the
 * profile's trailing 30 days), and each notification is a single message.
 *
 * Quiet-hour and over-cap listings are not marked notified, so they roll into the next digest
 * rather than being lost.
 */
export async function dispatchInstant(
  telegram: Telegraf['telegram'], db: DB, newListings: ListingRow[], now: Date,
): Promise<void> {
  if (newListings.length === 0) return;

  for (const profile of notifiableProfiles(db)) {
    const settings = getNotifySettings(db, profile.id);
    if (!settings.instantEnabled) continue;
    if (isQuietHour(viennaHour(now), settings.quietStart, settings.quietEnd)) continue;

    // Checked before recentScoresFor: a capped-out profile would otherwise pay for a full candidate
    // scan and scoring pass on every poll only to send nothing.
    let budget = settings.dailyCap - countInstantSince(db, profile.id, viennaDayStartIso(now));
    if (budget <= 0) continue;

    const alreadySent = getNotifiedListingIds(db, profile.id);
    const matches = newListings.filter((l) => matchesPrefs(l, profile.prefs) && !alreadySent.has(l.id));
    if (matches.length === 0) continue;

    const threshold = instantThreshold(recentScoresFor(db, profile, now), settings.instantPercentile);
    const scored = scoreListings(matches, getSwipedWithDirection(db, profile.chatId));

    for (const { listing, score } of scored) {
      if (budget <= 0) break;
      // Absolute bar first: a listing that isn't good value never pings, however it ranks.
      if (listing.valueFlag !== 'good') continue;
      if (threshold != null && score < threshold) continue;

      // One profile's failure (blocked bot, deleted chat) must not stop the others.
      try {
        await sendInstantCard(telegram, db, profile, listing, now);
      } catch (err) {
        console.error(`notify: instant send failed for profile ${profile.id}:`, err);
        continue;
      }
      recordNotified(db, profile.id, listing.id, 'instant', now.toISOString());
      budget--;
    }
  }
}

/**
 * One message, never an album: sendMediaGroup cannot carry an inline keyboard, so every extra photo
 * used to cost a second, contentless message. The hero photo plus a full caption says the same thing
 * in one notification.
 */
async function sendInstantCard(
  telegram: Telegraf['telegram'], db: DB, profile: SearchProfile, listing: ListingRow, now: Date,
): Promise<void> {
  const header = t(db, profile.chatId, 'notify_instant_header', { name: profile.name });
  const hero = listing.images[0];
  // A caption and a message have different real limits (1024 vs. 4096) — render at whichever one
  // this card is actually about to be sent as.
  const text = formatCard(listing, {
    prefix: `${header}\n\n`, labels: cardLabels(db, profile.chatId),
    maxLength: hero != null ? CARD_CAPTION_LIMIT : CARD_MESSAGE_LIMIT,
  });
  const buttons = Markup.inlineKeyboard([[Markup.button.url(t(db, profile.chatId, 'btn_open_listing'), listing.url)]]);

  if (hero != null) {
    await sendPhotoCached(telegram, db, profile.chatId, hero, text, { ...buttons, parse_mode: 'HTML' }, now);
    return;
  }
  await telegram.sendMessage(profile.chatId, text, { ...buttons, ...HTML_SEND_EXTRA });
}

/**
 * One text-only summary per profile at each configured digest hour, covering everything matched
 * since that profile's last digest that wasn't already sent instantly. No photos: the digest exists
 * to be scannable, not to reproduce the deck.
 *
 * Two things make the header's count honest. Every pending listing is recorded as notified, not just
 * the `MAX_DIGEST_LINES` that are rendered — the digest is a pointer into the deck, not an
 * exhaustive list, so anything it counted has been announced. And a profile that pre-dates this
 * feature (`lastDigestAt` null) silently adopts whatever backlog already exists rather than calling
 * it "new": those listings have been sitting in the deck all along, so announcing 200 of them as
 * news would be false on the first run and, draining five at a time, false on every run after.
 *
 * Null means ONLY that: createSearchProfile stamps `lastDigestAt` at creation, so a profile made
 * today never takes the adopt path and its first day of matches reaches the user.
 */
export async function dispatchDigests(telegram: Telegraf['telegram'], db: DB, now: Date): Promise<void> {
  for (const profile of notifiableProfiles(db)) {
    const settings = getNotifySettings(db, profile.id);
    if (!isDigestDue(now, settings.digestHours, settings.lastDigestAt)) continue;

    const alreadySent = getNotifiedListingIds(db, profile.id);
    const pending = getCandidateListings(db, profile.chatId, profile.prefs).filter((l) => !alreadySent.has(l.id));

    // This profile pre-dates the quiet notifier (nothing stamped it at creation), so nothing in its
    // deck can honestly be called new. Adopt the backlog and stay silent; from the next digest on,
    // every count is true.
    if (settings.lastDigestAt == null) {
      markDigested(db, profile.id, pending, now);
      continue;
    }

    if (pending.length === 0) {
      // Still stamp the run, so an empty 09:00 doesn't make 09:05 look due all morning.
      updateNotifySettings(db, profile.id, { lastDigestAt: now.toISOString() });
      continue;
    }

    const scored = scoreListings(pending, getSwipedWithDirection(db, profile.chatId));
    const shown = scored.slice(0, MAX_DIGEST_LINES);

    const header = t(db, profile.chatId, 'notify_digest_header', { name: profile.name, count: pending.length });
    const best = t(db, profile.chatId, 'notify_digest_best');
    const body = shown.map((s) => formatPushEntry(db, profile.chatId, s.listing)).join('\n\n');
    const text = `${header}\n\n${best}\n\n${body}`;
    const buttons = Markup.inlineKeyboard([[Markup.button.url(t(db, profile.chatId, 'btn_open_listing'), shown[0].listing.url)]]);

    try {
      await telegram.sendMessage(profile.chatId, text, buttons);
    } catch (err) {
      if (isPermanentChatError(err)) {
        // The chat is gone (blocked, deleted, deactivated). Retrying can't work, and the caller ticks
        // every 5 minutes, so leaving lastDigestAt unstamped would mean 288 failed API calls a day for
        // as long as this profile exists. Stamp it: the profile keeps its schedule and tries again at
        // the next digest hour, which is enough to notice an unblock without hammering Telegram.
        // Nothing is marked notified, so an unblocked user still gets these listings.
        console.error(`notify: chat ${profile.chatId} is unreachable, skipping this digest for profile ${profile.id}:`, err);
        updateNotifySettings(db, profile.id, { lastDigestAt: now.toISOString() });
        continue;
      }
      console.error(`notify: digest send failed for profile ${profile.id}:`, err);
      continue; // transient — don't stamp lastDigestAt, retry on the next tick
    }

    markDigested(db, profile.id, pending, now);
  }
}

/**
 * Closes out one digest run: every listing the run accounted for is recorded, and the run is
 * stamped. `pending` rather than the shown lines, so the next digest's "{count} new" counts only
 * what has genuinely appeared since. recordNotified is INSERT OR IGNORE, so re-recording a listing
 * an instant ping already claimed is a no-op.
 */
function markDigested(db: DB, profileId: number, pending: ListingRow[], now: Date): void {
  for (const l of pending) recordNotified(db, profileId, l.id, 'digest', now.toISOString());
  updateNotifySettings(db, profileId, { lastDigestAt: now.toISOString() });
}
