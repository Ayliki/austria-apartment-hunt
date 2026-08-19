import { type Telegraf } from 'telegraf';
import { type DB, getCachedFileId, recordFileId, recordPhotoFailure, isKnownBadPhoto } from './db.js';

/**
 * Sends one photo, preferring a previously cached Telegram file_id over the origin URL so a CDN is
 * hit once per image ever rather than once per view, and degrading to a plain text message rather
 * than throwing when Telegram rejects the image.
 *
 * Telegram rejects remote URLs for many reasons outside our control (expired links, hotlink
 * blocking, slow origins, redirects), and a rejected photo previously propagated out of sendCard
 * and aborted the rest of a push — see the un-caught `await sendCard(...)` this replaces. Returning
 * a boolean instead of throwing makes that impossible by construction.
 */
export async function sendPhotoCached(
  telegram: Telegraf['telegram'], db: DB, chatId: number,
  sourceUrl: string, caption: string, extra: Record<string, unknown>, now: Date,
): Promise<boolean> {
  const cached = getCachedFileId(db, sourceUrl, now);

  if (cached == null && isKnownBadPhoto(db, sourceUrl, now)) {
    await sendTextFallback(telegram, chatId, caption, extra);
    return false;
  }

  const media = cached ?? sourceUrl;

  try {
    const message = await telegram.sendPhoto(chatId, media, { caption, ...extra }) as { photo?: { file_id: string }[] };
    // Telegram returns every rendered size, largest last — cache that one so re-sends keep full quality.
    const largest = message.photo?.at(-1)?.file_id;
    if (largest != null && cached == null) recordFileId(db, sourceUrl, largest, now.toISOString());
    return true;
  } catch (err) {
    recordPhotoFailure(db, sourceUrl, err instanceof Error ? err.message : String(err), now.toISOString());
    await sendTextFallback(telegram, chatId, caption, extra);
    return false;
  }
}

/** Last resort — a failure here is logged and swallowed, since a dispatch must continue to the next listing regardless. */
async function sendTextFallback(
  telegram: Telegraf['telegram'], chatId: number, caption: string, extra: Record<string, unknown>,
): Promise<void> {
  try {
    await telegram.sendMessage(chatId, caption, extra);
  } catch (err) {
    console.error('photo: text fallback failed:', err);
  }
}

/**
 * Filters out images Telegram has rejected recently, so an album never fails wholesale on a URL we
 * currently believe is dead. Suppression expires (see PHOTO_TRANSIENT_COOLDOWN_MS), so a url dropped
 * after a 429 comes back on its own instead of being lost to every user for good.
 */
export function usablePhotoUrls(db: DB, urls: string[], now: Date = new Date()): string[] {
  return urls.filter((u) => !isKnownBadPhoto(db, u, now));
}
