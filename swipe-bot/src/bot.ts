import { Telegraf, Markup } from 'telegraf';
import {
  type DB, type UserPrefs, type ListingRow, type CommuteTimes,
  getUserPrefs, setUserPrefs, getCandidateListings, getSwipedWithDirection, recordSwipe, getShortlist, removeFromShortlist, undoSwipe,
  getOnboardingState, setOnboardingState, deleteOnboardingState, getCommuteTimes, setCommuteTimes, setListingCoords,
} from './db.js';
import { rankListings } from './scoring.js';
import { formatCommuteLine, type GeoPoint } from './commute.js';

export type GeocodeFn = (address: string) => Promise<GeoPoint | null>;
export type ComputeCommuteFn = (origin: GeoPoint, destination: GeoPoint) => Promise<CommuteTimes>;

export interface BotDeps {
  geocode: GeocodeFn;
  computeCommute: ComputeCommuteFn;
}

export const SAFETY_NOTICE =
  'Standing safety rule: never transfer money or pay a deposit before an in-person viewing. ' +
  'Avoid international transfers and escrow/Treuhand arrangements. ' +
  'Only use the listing\'s official contact channel.';

export const ONBOARDING_INTRO =
  'I\'ll ask 8 quick questions to learn your budget, districts, size, and a few other preferences. ' +
  'After that, I check willhaben and immobilienscout24 every ~3h and message you here as soon as ' +
  'something matches — swipe 👍/👎 on each card to build your shortlist, and I\'ll learn what you ' +
  'like over time. Preferences and shortlist are always editable later via /settings and /shortlist.\n\n' +
  'Reply with just the value in the format shown in each question ' +
  '(e.g. "800", not "my budget is 800 euros") — free text won\'t parse.';

export const HELP_TEXT =
  'I find Vienna rental apartments matching your preferences and let you swipe through them, ' +
  'like a dating app.\n\n' +
  'How it works: every ~3h I check willhaben and immobilienscout24 for new matches and send them ' +
  'here as cards — reply 👍 to save one to your shortlist, or 👎 to pass. Swiped the wrong way? Each ' +
  'card keeps an ↩️ Undo button until you swipe the next one. The more you swipe, the ' +
  'better matches get: I learn which price/size/district combos you tend to like.\n\n' +
  'Commands:\n' +
  '/next — see another listing right now, without waiting for the next poll\n' +
  '/shortlist — browse everything you\'ve liked, with a 🗑️ Remove button on each\n' +
  '/settings — change your budget, districts, or other preferences\n' +
  '/start — redo the setup questions from scratch\n\n' +
  'The ⏭ Next / 📋 Shortlist / ⚙️ Settings buttons below the message box do the same as the ' +
  'matching commands, one tap instead of typing.\n\n' +
  SAFETY_NOTICE;

/** Registered via setMyCommands (in index.ts's startup, not here — createBot stays synchronous) so Telegram shows a persistent ☰ menu. */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'start', description: 'Set up (or redo) your search preferences' },
  { command: 'next', description: 'See another listing right now' },
  { command: 'shortlist', description: 'Browse everything you\'ve liked' },
  { command: 'settings', description: 'Change your preferences' },
  { command: 'help', description: 'How this bot works' },
];

/** Always-visible bottom keyboard for one-tap navigation — sent once (onboarding completion, or /start on an already-configured chat) and Telegram keeps it visible under the input field from then on. */
export const MAIN_KEYBOARD = Markup.keyboard([['⏭ Next', '📋 Shortlist', '⚙️ Settings']]).resize();

/** Index of the commute-destination question — handled separately in bot.on('text') since it needs an async geocoding call, unlike every other step's synchronous parser. */
const COMMUTE_STEP_INDEX = 7;

const QUESTIONS = [
  'What\'s your max budget (cold, in EUR)?',
  'Min budget? (number, or "skip")',
  'Districts? e.g. "1-9" or "6,7,9", or "any"',
  'Rooms, min-max? e.g. "1-2", or "any"',
  'Size in m², min-max? e.g. "30-60", or "any"',
  'Include municipal/waitlist housing (Gemeindewohnung, Genossenschaft, Direktvergabe)? ' +
  'These usually need a Vormerkschein, Wohnticket, or Wiener Wohnen registration — not everyone qualifies. Reply "yes" or "no".',
  'Include WG/shared-flat rooms, co-living, and student rooms? Reply "yes" or "no".',
  'Daily commute destination? e.g. "TU Wien" or an address — I\'ll show walk/transit times to it on every card. Reply "skip" for none.',
];

function parseRange(s: string): [number | null, number | null] {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = Number(s.trim());
  if (Number.isFinite(n)) return [n, n];
  throw new Error(`could not parse range "${s}" — use "min-max" or "any"`);
}

function parseDistrictsAnswer(s: string): number[] | null {
  const trimmed = s.trim().toLowerCase();
  if (trimmed === 'any' || trimmed === 'skip') return null;
  const out: number[] = [];
  for (const part of s.split(',')) {
    const range = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (range) {
      for (let d = parseInt(range[1], 10); d <= parseInt(range[2], 10); d++) out.push(d);
    } else if (/^\d{1,2}$/.test(part.trim())) {
      out.push(parseInt(part.trim(), 10));
    } else {
      throw new Error(`could not parse districts "${s}"`);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function parseBudgetMax(s: string): number {
  const n = Number(s.trim());
  if (!Number.isFinite(n)) throw new Error('that doesn\'t look like a budget — reply with a number, e.g. 800');
  return n;
}

function parseBudgetMin(s: string): number | null {
  const trimmed = s.trim().toLowerCase();
  if (trimmed === 'skip' || trimmed === 'any') return null;
  const n = Number(s.trim());
  if (!Number.isFinite(n)) throw new Error('that doesn\'t look like a minimum budget — reply with a number or "skip"');
  return n;
}

function parseRoomsOrSize(s: string): [number | null, number | null] {
  if (s.trim().toLowerCase() === 'any') return [null, null];
  return parseRange(s);
}

function parseYesNo(s: string): boolean {
  const trimmed = s.trim().toLowerCase();
  if (['yes', 'y', 'ja', 'j'].includes(trimmed)) return true;
  if (['no', 'n', 'nein'].includes(trimmed)) return false;
  throw new Error('reply with "yes" or "no"');
}

/** One parser per onboarding question, in order. Each throws Error with a user-facing message on invalid input. */
const STEP_PARSERS: ((raw: string) => unknown)[] = [
  parseBudgetMax, parseBudgetMin, parseDistrictsAnswer, parseRoomsOrSize, parseRoomsOrSize, parseYesNo, parseYesNo,
];

/** Validates a single onboarding answer against its question's parser. Throws on invalid input. */
export function parseOnboardingStep(index: number, raw: string): void {
  STEP_PARSERS[index](raw);
}

/** Pure parser for the first 6 (of 7) onboarding answers. The 7th (commute destination) needs an async geocode call and is resolved separately in finishOnboarding. Throws Error with a user-facing message. */
export function parseOnboardingAnswers(answers: string[]): Omit<UserPrefs, 'chatId' | 'commuteDestination' | 'commuteLat' | 'commuteLon'> {
  const priceTo = parseBudgetMax(answers[0]);
  const priceFrom = parseBudgetMin(answers[1]);
  const districts = parseDistrictsAnswer(answers[2]);
  const [roomsFrom, roomsTo] = parseRoomsOrSize(answers[3]);
  const [areaFrom, areaTo] = parseRoomsOrSize(answers[4]);
  const includeWaitlistHousing = parseYesNo(answers[5]);
  const includeWg = parseYesNo(answers[6]);
  return { priceFrom, priceTo, districts, roomsFrom, roomsTo, areaFrom, areaTo, includeWaitlistHousing, includeWg };
}

/** Top-ranked, not-yet-swiped listing for this user, or null if the queue is empty. */
export function nextCardFor(db: DB, chatId: number): ListingRow | null {
  const prefs = getUserPrefs(db, chatId);
  if (!prefs) return null;
  const candidates = getCandidateListings(db, chatId, prefs);
  if (candidates.length === 0) return null;
  const swiped = getSwipedWithDirection(db, chatId);
  return rankListings(candidates, swiped)[0];
}

/** Telegram's hard cap on caption length for photos and media groups alike. */
const MAX_CAPTION_LENGTH = 1024;

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trimEnd() + '…';
}

/** Pure — builds the card caption (title, price/size/rooms/district, eligibility flag, commute line, description, link). Exported for direct testing. */
export function formatCaption(l: ListingRow, commuteLine?: string | null, prefix?: string): string {
  const price = l.price != null ? `€${l.price}` : 'price n/a';
  const area = l.area != null ? `${l.area}m²` : '';
  const rooms = l.rooms != null ? `${l.rooms} rooms` : '';
  const district = l.district != null ? `district ${l.district}` : '';
  const details = [area, rooms, district].filter(Boolean).join(' · ');
  const flag = l.requiresWaitlistTicket
    ? '\n⚠️ Municipal/waitlist housing — needs a Vormerkschein, Wohnticket, or Wiener Wohnen registration.'
    : '';
  const wgFlag = l.isWg ? '\n🚪 WG — shared flat / co-living / student room, not a whole apartment.' : '';
  const delistedFlag = l.isDelisted ? '\n⚠️ No longer listed — likely taken down by the advertiser.' : '';
  const commute = commuteLine ? `\n${commuteLine}` : '';
  const base = `${l.title}\n${price} · ${details}${flag}${wgFlag}${delistedFlag}${commute}\n${l.url}`;
  const full = l.description ? `${base}\n\n${l.description}` : base;
  const withPrefix = prefix ? `${prefix}${full}` : full;
  return truncate(withPrefix, MAX_CAPTION_LENGTH);
}

/** Telegram's hard cap on items in a single sendMediaGroup call. */
export const MAX_MEDIA_GROUP_ITEMS = 10;

interface MediaGroupItem {
  type: 'photo';
  media: string;
  caption?: string;
}

/** Pure — builds a sendMediaGroup payload, capped to Telegram's limit, caption attached to the first item only (Telegram renders it as the album's caption). */
export function buildMediaGroup(images: string[], caption: string): MediaGroupItem[] {
  return images.slice(0, MAX_MEDIA_GROUP_ITEMS).map((url, i) => ({
    type: 'photo' as const,
    media: url,
    ...(i === 0 ? { caption } : {}),
  }));
}

/** Pure — builds the Prev/Remove/Next row for browsing the shortlist one card at a time, omitting Prev at the first position and Next at the last (Telegram has no disabled-button state, so an unreachable direction is simply not offered). */
export function shortlistNavButtons(listingId: string, position: number, total: number): ReturnType<typeof Markup.inlineKeyboard> {
  const row: ReturnType<typeof Markup.button.callback>[] = [];
  if (position > 1) row.push(Markup.button.callback('◀️ Prev', `slnav:prev:${listingId}`));
  row.push(Markup.button.callback('🗑️ Remove', `unlike:${listingId}`));
  if (position < total) row.push(Markup.button.callback('▶️ Next', `slnav:next:${listingId}`));
  return Markup.inlineKeyboard([row]);
}

/** Placeholder text used for the standalone buttons message that accompanies a multi-photo album — swapped wholesale (not appended to) once swiped, since it carries no listing info of its own. */
export const SWIPE_PROMPT_TEXT = '👍 or 👎?';
const GROUP_PLACEHOLDER_TEXTS: string[] = [SWIPE_PROMPT_TEXT];

/** Pure — decides whether a swiped/removed card's status replaces its message text wholesale (the album-companion placeholder) or gets appended to real listing text (caption, or the no-photo full-text card). */
export function appendSwipeStatus(originalText: string, status: string): string {
  return GROUP_PLACEHOLDER_TEXTS.includes(originalText) ? status : `${originalText}\n\n${status}`;
}

/** Low-level: sends a listing as photo album / single photo / text, with the given inline buttons. Used by sendCard (swipe deck: 👍👎) — shortlist browsing (bot.ts) has its own single-photo-only sender, since a message it will later edit in place can never be a multi-photo album. */
async function sendListingCard(
  telegram: Telegraf['telegram'], chatId: number, card: ListingRow, caption: string,
  buttons: ReturnType<typeof Markup.inlineKeyboard>, groupPromptText: string,
): Promise<void> {
  if (card.images.length >= 2) {
    // sendMediaGroup can't carry an inline keyboard on any item — send the album, then the buttons separately.
    await telegram.sendMediaGroup(chatId, buildMediaGroup(card.images, caption));
    await telegram.sendMessage(chatId, groupPromptText, buttons);
  } else if (card.images.length === 1) {
    await telegram.sendPhoto(chatId, card.images[0], { caption, ...buttons });
  } else {
    await telegram.sendMessage(chatId, `${caption}\n(no photo)`, buttons);
  }
}

/** Sends one listing as a swipeable card (photo album / single photo / text, with 👍👎 buttons). Shared by the pull path (/next) and the push path (proactive new-match notifications). */
export async function sendCard(
  telegram: Telegraf['telegram'], chatId: number, card: ListingRow, commuteLine?: string | null,
): Promise<void> {
  const caption = formatCaption(card, commuteLine);
  const buttons = Markup.inlineKeyboard([
    Markup.button.callback('👎', `pass:${card.id}`),
    Markup.button.callback('👍', `like:${card.id}`),
  ]);
  await sendListingCard(telegram, chatId, card, caption, buttons, SWIPE_PROMPT_TEXT);
}

/** Sends one shortlist entry as a NEW message — single photo only (never the full album, unlike the swipe deck), so a later Prev/Next/Remove tap can edit this exact message in place. No commute line, to avoid a Routes API call per browse. */
async function sendShortlistBrowseCard(
  telegram: Telegraf['telegram'], chatId: number, card: ListingRow, position: number, total: number,
): Promise<void> {
  const caption = formatCaption(card, null, `❤️ ${position} of ${total}\n\n`);
  const buttons = shortlistNavButtons(card.id, position, total);
  if (card.images.length > 0) {
    await telegram.sendPhoto(chatId, card.images[0], { caption, ...buttons });
  } else {
    await telegram.sendMessage(chatId, `${caption}\n(no photo)`, buttons);
  }
}

/**
 * Cached-or-computed commute line for one (chat, listing) pair — null if the user has no commute
 * destination set, or the listing has no coordinates and no address to geocode as a fallback (or
 * that geocode fails), or the Routes API call failed. Cached in the DB since Routes API calls cost
 * quota and the same listing gets re-shown across /next, pushes, and swipes.
 *
 * Not every advertiser publishes coordinates (verified: willhaben listings from Rustler
 * Immobilientreuhand never do), but most still have a plain address — geocoding it once and
 * persisting the result onto the listing row means the geocode call happens once per listing,
 * ever, not once per view.
 */
export async function getCommuteLineFor(
  db: DB, chatId: number, listing: ListingRow, prefs: UserPrefs, computeCommute: ComputeCommuteFn, geocode: GeocodeFn,
): Promise<string | null> {
  if (prefs.commuteDestination == null || prefs.commuteLat == null || prefs.commuteLon == null) return null;

  let origin = listing.lat != null && listing.lon != null ? { lat: listing.lat, lon: listing.lon } : null;
  if (!origin) {
    if (listing.addressLine == null) return null;
    origin = await geocode(listing.addressLine);
    if (!origin) return null;
    setListingCoords(db, listing.id, origin.lat, origin.lon);
  }

  let times = getCommuteTimes(db, chatId, listing.id);
  if (!times) {
    times = await computeCommute(origin, { lat: prefs.commuteLat, lon: prefs.commuteLon });
    setCommuteTimes(db, chatId, listing.id, times);
  }
  return formatCommuteLine(times, prefs.commuteDestination);
}

async function sendNextCard(telegram: Telegraf['telegram'], chatId: number, db: DB, deps: BotDeps): Promise<void> {
  const prefs = getUserPrefs(db, chatId);
  if (!prefs) {
    await telegram.sendMessage(chatId, 'You haven\'t set your preferences yet — send /start to get set up.');
    return;
  }
  const card = nextCardFor(db, chatId);
  if (!card) {
    await telegram.sendMessage(chatId, 'No new listings right now — check back after the next poll (every ~3h).');
    return;
  }
  const commuteLine = await getCommuteLineFor(db, chatId, card, prefs, deps.computeCommute, deps.geocode);
  await sendCard(telegram, chatId, card, commuteLine);
}

/**
 * Clears the buttons on the message a swipe/remove callback came from, replacing its text/caption with
 * a short status line — otherwise Telegram leaves the 👍👎/🗑️ buttons live forever, and an old card in
 * chat history stays tappable. Best-effort: editing can fail (message too old, deleted, already edited),
 * which must never block sending the next card.
 */
async function clearSwipedCardButtons(
  ctx: {
    callbackQuery?: { message?: unknown };
    editMessageCaption: (caption?: string, extra?: ReturnType<typeof Markup.inlineKeyboard>) => Promise<unknown>;
    editMessageText: (text: string, extra?: ReturnType<typeof Markup.inlineKeyboard>) => Promise<unknown>;
  },
  status: string,
  undoButton?: ReturnType<typeof Markup.button.callback>,
): Promise<void> {
  const message = ctx.callbackQuery?.message as { text?: string; caption?: string; photo?: unknown } | undefined;
  if (!message) return;
  try {
    const markup = Markup.inlineKeyboard(undoButton ? [undoButton] : []);
    if (message.photo) {
      await ctx.editMessageCaption(appendSwipeStatus(message.caption ?? '', status), markup);
    } else if (message.text) {
      await ctx.editMessageText(appendSwipeStatus(message.text, status), markup);
    }
  } catch {
    // best-effort — see doc comment above
  }
}

/** Minimal shape replaceShortlistCard/replaceShortlistWithEmptyState need from a callback context. */
interface ShortlistCardCtx {
  callbackQuery?: { message?: unknown };
  chat?: { id: number };
  telegram: Telegraf['telegram'];
  editMessageMedia: (media: { type: 'photo'; media: string; caption?: string }, extra?: ReturnType<typeof Markup.inlineKeyboard>) => Promise<unknown>;
  editMessageText: (text: string, extra?: ReturnType<typeof Markup.inlineKeyboard>) => Promise<unknown>;
  deleteMessage: () => Promise<unknown>;
}

/**
 * Deletes the current callback message and sends a fresh photo/text message in its place — the
 * fallback path for both the cross-type case (Telegram can't convert a message's type via edit)
 * and for when an in-place edit itself fails. Delete and send are each best-effort on their own:
 * a delete failure (message too old, already gone) must never suppress the send that was supposed
 * to follow it, and a send failure must never throw and block the response.
 */
async function deleteAndSendShortlistCard(
  ctx: ShortlistCardCtx, chatId: number, listing: ListingRow, caption: string, buttons: ReturnType<typeof Markup.inlineKeyboard>,
): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch {
    // best-effort — an old/already-gone message can't always be deleted
  }
  try {
    if (listing.images.length > 0) {
      await ctx.telegram.sendPhoto(chatId, listing.images[0], { caption, ...buttons });
    } else {
      await ctx.telegram.sendMessage(chatId, `${caption}\n(no photo)`, buttons);
    }
  } catch {
    // best-effort — see doc comment above
  }
}

/**
 * Replaces the current callback message in place with a different shortlist position — editing the
 * photo/text if the target's type (photo vs no-photo) matches the current message's type, since
 * Telegram has no API to convert a message from one type to the other via edit. When the types
 * differ, or when the in-place edit itself fails (e.g. an expired CDN image URL), falls back to
 * deleting the old message and sending a fresh one instead — so the user always ends up seeing the
 * target card, just via a fresh message rather than a true in-place edit in that edge case.
 */
async function replaceShortlistCard(ctx: ShortlistCardCtx, listing: ListingRow, position: number, total: number): Promise<void> {
  const message = ctx.callbackQuery?.message as { photo?: unknown } | undefined;
  if (!message) return;
  const chatId = ctx.chat!.id;
  const caption = formatCaption(listing, null, `❤️ ${position} of ${total}\n\n`);
  const buttons = shortlistNavButtons(listing.id, position, total);
  const targetHasPhoto = listing.images.length > 0;
  const currentHasPhoto = Boolean(message.photo);
  if (targetHasPhoto && currentHasPhoto) {
    try {
      await ctx.editMessageMedia({ type: 'photo', media: listing.images[0], caption }, buttons);
      return;
    } catch {
      // in-place edit failed (e.g. expired image URL) — fall through to delete+send below
    }
  } else if (!targetHasPhoto && !currentHasPhoto) {
    try {
      await ctx.editMessageText(`${caption}\n(no photo)`, buttons);
      return;
    } catch {
      // in-place edit failed — fall through to delete+send below
    }
  }
  await deleteAndSendShortlistCard(ctx, chatId, listing, caption, buttons);
}

/** Replaces the current callback message with the empty-shortlist message — always delete+send, since there's no in-place target type to match against once nothing is left to browse. */
async function replaceShortlistWithEmptyState(ctx: ShortlistCardCtx): Promise<void> {
  const chatId = ctx.chat!.id;
  try {
    await ctx.deleteMessage();
  } catch {
    // best-effort — an old/already-gone message can't always be deleted
  }
  try {
    await ctx.telegram.sendMessage(chatId, 'Your shortlist is empty — 👍 a card to save it here.');
  } catch {
    // best-effort
  }
}

/** Finishes onboarding: saves prefs (base fields + resolved commute destination), confirms, and shows what's already queued up. */
async function finishOnboarding(
  telegram: Telegraf['telegram'], db: DB, chatId: number, answers: string[],
  commute: { destination: string | null; lat: number | null; lon: number | null }, deps: BotDeps,
): Promise<void> {
  deleteOnboardingState(db, chatId);
  const parsed = parseOnboardingAnswers(answers);
  setUserPrefs(db, {
    chatId, ...parsed,
    commuteDestination: commute.destination, commuteLat: commute.lat, commuteLon: commute.lon,
  });
  await telegram.sendMessage(
    chatId,
    'Preferences saved. New listings get checked every ~3h, not instantly — ' +
    'I\'ll message you here as soon as something matches. Anything I already have queued up:',
    MAIN_KEYBOARD,
  );
  await sendNextCard(telegram, chatId, db, deps);
}

/** Sends the first shortlist card (or the empty-state message). Shared by /shortlist and the "📋 Shortlist" keyboard button — from there, browsing the rest happens via Prev/Next/Remove on that one message, not further /shortlist calls. */
async function sendShortlistTo(telegram: Telegraf['telegram'], chatId: number, db: DB): Promise<void> {
  const items = getShortlist(db, chatId);
  if (items.length === 0) {
    await telegram.sendMessage(chatId, 'Your shortlist is empty — 👍 a card to save it here.');
    return;
  }
  await sendShortlistBrowseCard(telegram, chatId, items[0], 1, items.length);
}

/** Restarts the onboarding wizard from question 0. Shared by /settings and the "⚙️ Settings" keyboard button. */
async function startSettingsFor(telegram: Telegraf['telegram'], chatId: number, db: DB): Promise<void> {
  setOnboardingState(db, chatId, []);
  await telegram.sendMessage(chatId, ONBOARDING_INTRO);
  await telegram.sendMessage(chatId, QUESTIONS[0]);
}

export function createBot(db: DB, token: string, deps: BotDeps): Telegraf {
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    if (getUserPrefs(db, chatId)) {
      await ctx.reply(
        'You\'re already set up. /next for a listing, /shortlist to browse what you\'ve liked, ' +
        'or /settings to redo your preferences from scratch.',
        MAIN_KEYBOARD,
      );
      return;
    }
    setOnboardingState(db, chatId, []);
    await ctx.reply(SAFETY_NOTICE);
    await ctx.reply(ONBOARDING_INTRO);
    await ctx.reply(QUESTIONS[0]);
  });

  bot.command('settings', async (ctx) => {
    await startSettingsFor(ctx.telegram, ctx.chat.id, db);
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT, MAIN_KEYBOARD);
  });

  bot.command('shortlist', async (ctx) => {
    await sendShortlistTo(ctx.telegram, ctx.chat.id, db);
  });

  bot.command('next', async (ctx) => {
    await sendNextCard(ctx.telegram, ctx.chat.id, db, deps);
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const answers = getOnboardingState(db, chatId);
    if (!answers) {
      // Not mid-onboarding: route the three persistent-keyboard button labels to the same logic
      // their matching commands run. Anything else falls through unchanged (silently ignored).
      const text = ctx.message.text;
      if (text === '⏭ Next') { await sendNextCard(ctx.telegram, chatId, db, deps); return; }
      if (text === '📋 Shortlist') { await sendShortlistTo(ctx.telegram, chatId, db); return; }
      if (text === '⚙️ Settings') { await startSettingsFor(ctx.telegram, chatId, db); return; }
      return;
    }
    const raw = ctx.message.text;

    if (answers.length === COMMUTE_STEP_INDEX) {
      const trimmed = raw.trim();
      if (trimmed.toLowerCase() === 'skip') {
        await finishOnboarding(ctx.telegram, db, chatId, answers, { destination: null, lat: null, lon: null }, deps);
        return;
      }
      const point = await deps.geocode(trimmed);
      if (!point) {
        await ctx.reply('couldn\'t find that location — try being more specific, or reply "skip"');
        return; // keep the same question, don't advance or lose prior answers
      }
      await finishOnboarding(ctx.telegram, db, chatId, answers, { destination: trimmed, lat: point.lat, lon: point.lon }, deps);
      return;
    }

    try {
      parseOnboardingStep(answers.length, raw);
    } catch (err) {
      await ctx.reply((err as Error).message);
      return; // keep the same question, don't advance or lose prior answers
    }

    answers.push(raw);
    setOnboardingState(db, chatId, answers);
    await ctx.reply(QUESTIONS[answers.length]);
  });

  bot.action(/^(like|pass):(.+)$/, async (ctx) => {
    const [, direction, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    const saved = recordSwipe(db, chatId, listingId, direction as 'like' | 'pass');
    const undoButton = Markup.button.callback('↩️ Undo', `undo:${listingId}`);
    if (direction === 'like' && !saved) {
      await ctx.answerCbQuery('This listing is no longer available.');
      await clearSwipedCardButtons(ctx, '⚠️ No longer available', undoButton);
    } else {
      await ctx.answerCbQuery(direction === 'like' ? 'Saved to shortlist 👍' : 'Passed 👎');
      await clearSwipedCardButtons(ctx, direction === 'like' ? '✅ Added to shortlist' : '👎 Passed', undoButton);
    }
    await sendNextCard(ctx.telegram, chatId, db, deps);
  });

  bot.action(/^undo:(.+)$/, async (ctx) => {
    const [, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    const undone = undoSwipe(db, chatId, listingId);
    if (!undone) {
      await ctx.answerCbQuery('You can only undo your most recent swipe.');
      return;
    }
    await ctx.answerCbQuery('Swipe undone ↩️');
    await clearSwipedCardButtons(ctx, '↩️ Undone');
  });

  bot.action(/^slnav:(prev|next):(.+)$/, async (ctx) => {
    const [, direction, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    const items = getShortlist(db, chatId);
    const idx = items.findIndex((i) => i.id === listingId);
    if (idx === -1) {
      await ctx.answerCbQuery('This listing is no longer in your shortlist.');
      return;
    }
    const targetIdx = direction === 'prev' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= items.length) {
      await ctx.answerCbQuery(direction === 'prev' ? 'This is the first one.' : 'This is the last one.');
      return;
    }
    await ctx.answerCbQuery();
    await replaceShortlistCard(ctx, items[targetIdx], targetIdx + 1, items.length);
  });

  bot.action(/^unlike:(.+)$/, async (ctx) => {
    const [, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    const before = getShortlist(db, chatId);
    const removedIndex = before.findIndex((i) => i.id === listingId);
    removeFromShortlist(db, chatId, listingId);
    await ctx.answerCbQuery('Removed from shortlist 🗑️');
    const after = getShortlist(db, chatId);
    if (after.length === 0) {
      await replaceShortlistWithEmptyState(ctx);
      return;
    }
    const nextIndex = Math.min(Math.max(removedIndex, 0), after.length - 1);
    await replaceShortlistCard(ctx, after[nextIndex], nextIndex + 1, after.length);
  });

  return bot;
}
