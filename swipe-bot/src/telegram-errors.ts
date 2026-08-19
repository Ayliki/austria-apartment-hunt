/**
 * Tells apart the two kinds of Telegram send failure that must be handled in opposite ways:
 * something wrong with the CHAT (the user blocked the bot, deleted their account, the chat is gone)
 * versus something wrong with the request or the network (429, 5xx, a bad image url, a timeout).
 *
 * Both arrive as a rejected promise from the same `telegram.sendX` call, so without this split:
 *   - a dead chat retries a digest on every 5-minute tick, forever, with no backoff; and
 *   - a dead chat gets recorded as a PHOTO failure, and photo_cache is global by url, so one blocked
 *     user suppresses a perfectly good image for everybody else.
 *
 * Deliberately conservative: anything unrecognised counts as transient, so an unfamiliar wording
 * costs a retry rather than silently writing a user off.
 */

/** Telegram's own wordings for "this chat can no longer receive messages from the bot". */
const PERMANENT_CHAT_PATTERNS = [
  'bot was blocked by the user',
  'user is deactivated',
  'chat not found',
  'bot was kicked',
  'bot is not a member',
  'peer_id_invalid',
  "bot can't initiate conversation",
  'user_is_blocked',
];

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/** telegraf's TelegramError carries the numeric error_code; a plain Error only carries the text. */
function errorCode(err: unknown): number | null {
  const code = (err as { code?: unknown; error_code?: unknown } | null)?.code
    ?? (err as { error_code?: unknown } | null)?.error_code;
  return typeof code === 'number' ? code : null;
}

/**
 * True when the failure means this chat is permanently unreachable rather than momentarily
 * unavailable. Every 403 qualifies (Telegram only returns it for blocked/kicked/deactivated), plus
 * the handful of 400s that describe a chat that no longer exists.
 */
export function isPermanentChatError(err: unknown): boolean {
  if (errorCode(err) === 403) return true;
  const message = errorText(err).toLowerCase();
  if (message.startsWith('403:') || message.includes('forbidden:')) return true;
  return PERMANENT_CHAT_PATTERNS.some((pattern) => message.includes(pattern));
}
