import { Telegraf, Markup } from 'telegraf';
import {
  type DB, type SearchProfilePrefs, type SearchProfile, type ListingRow, type CommuteTimes, type ChatLanguage,
  getActiveSearchProfile, getCandidateListings, getSwipedWithDirection, recordSwipe, getShortlist, removeFromShortlist, undoSwipe,
  getWizardState, setWizardState, deleteWizardState, getCommuteTimes, setCommuteTimes, setListingCoords,
  setChatLanguage, createSearchProfile, countSearchProfiles, MAX_SEARCH_PROFILES_PER_CHAT,
  getSearchProfiles, getSearchProfile, setActiveSearchProfile, deleteSearchProfile, updateSearchProfile, renameSearchProfile,
  getListingById, getNotifySettings, updateNotifySettings, getShortlistForExport,
} from './db.js';
import { rankListings } from './scoring.js';
import { formatCommuteLine, type GeoPoint } from './commute.js';
import { formatCard, type CardLabels, CARD_CAPTION_LIMIT, CARD_MESSAGE_LIMIT } from './card.js';
import { t, LOCALE_NAMES } from './locales.js';
import { toCsv, exportFilename } from './export.js';
import { sendPhotoCached, usablePhotoUrls } from './photo.js';
import { renderNotifyMenu, nextDailyCap } from './notify-ui.js';
import {
  WIZARD_STEPS, BUDGET_BANDS, DISTRICT_GROUPS, initialWizardState, applyWizardChoice, isWizardComplete, finalizePrefs, parseCustomBudget,
  type WizardState, type WizardChoice, type WizardStepId,
} from './wizard.js';

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

/** Builds the localized /help body via t()'s `help_full` key, substituting the search-profile cap and the (untranslated, safety-critical) SAFETY_NOTICE. */
function buildHelpText(db: DB, chatId: number): string {
  return t(db, chatId, 'help_full', { maxProfiles: MAX_SEARCH_PROFILES_PER_CHAT, safetyNotice: SAFETY_NOTICE });
}

/** Registered via setMyCommands (in index.ts's startup, not here — createBot stays synchronous) so Telegram shows a persistent ☰ menu. */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'start', description: 'Set up (or redo) your search preferences' },
  { command: 'next', description: 'See another listing right now' },
  { command: 'shortlist', description: 'Browse everything you\'ve liked' },
  { command: 'export', description: 'Export your shortlist as a CSV file' },
  { command: 'searches', description: 'List, switch, or delete your searches' },
  { command: 'settings', description: 'Change your preferences' },
  { command: 'help', description: 'How this bot works' },
  { command: 'language', description: 'Change the bot\'s language' },
];

/** Always-visible bottom keyboard for one-tap navigation — sent once (onboarding completion, or /start on an already-configured chat) and Telegram keeps it visible under the input field from then on. */
export const MAIN_KEYBOARD = Markup.keyboard([['⏭ Next', '📋 Shortlist', '⚙️ Settings']]).resize();

/** Every locale key `renderWizardStep`/`wizardStrings` needs resolved for the chat's language, fetched once per render. */
const WIZARD_STRING_KEYS = [
  'wizard_progress', 'wizard_name_prompt', 'wizard_name_prompt_edit', 'wizard_budget_prompt', 'wizard_districts_prompt', 'wizard_rooms_prompt',
  'wizard_amenities_prompt', 'wizard_commute_prompt', 'wizard_budget_custom_prompt', 'wizard_budget_custom_error',
  'btn_skip', 'btn_back', 'btn_continue', 'btn_custom_range',
  'amenity_elevator', 'amenity_parking', 'amenity_include_waitlist', 'amenity_include_wg',
] as const;

/**
 * Resolves every wizard-screen locale key for the chat's language, substituting `params` into
 * whichever keys need them (`wizard_progress`'s `{step}`/`{total}`, `wizard_name_prompt`'s `{n}`).
 * Without `params`, `t()` leaves an unmatched `{placeholder}` in the output verbatim (see locales.ts)
 * — every call site below must pass `wizardParams` for the state actually being rendered so screens
 * never show a literal `Step {step}/{total}`.
 */
function wizardStrings(db: DB, chatId: number, params: Record<string, string | number> = {}): Record<string, string> {
  return Object.fromEntries(WIZARD_STRING_KEYS.map((k) => [k, t(db, chatId, k, params)]));
}

/** Builds the `{step}`/`{total}`/`{n}` params `wizardStrings` needs for rendering `state` — one place so every render call site stays in sync. */
function wizardParams(db: DB, chatId: number, state: WizardState): Record<string, string | number> {
  return { step: state.stepIndex + 1, total: WIZARD_STEPS.length, n: countSearchProfiles(db, chatId) + 1 };
}

/** Splits an array into chunks of at most `size` — used for inline-keyboard rows so Telegram never truncates a wide row of buttons. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Builds the text + inline keyboard for whatever step `state` is currently on. Pure given `state`
 * and the chat's language-resolved `strings` (built once per render by `wizardStrings`), so this
 * stays directly testable without a DB — exported for that purpose.
 */
export function renderWizardStep(state: WizardState, strings: Record<string, string>): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const step = WIZARD_STEPS[state.stepIndex];
  const progress = `${strings.wizard_progress} ${'●'.repeat(state.stepIndex + 1)}${'○'.repeat(WIZARD_STEPS.length - state.stepIndex - 1)}`;
  const backRow = state.stepIndex > 0 ? [Markup.button.callback(strings.btn_back, 'wizard:back')] : [];

  switch (step) {
    case 'name': {
      const namePrompt = state.editingProfileId != null ? strings.wizard_name_prompt_edit : strings.wizard_name_prompt;
      return { text: `${progress}\n\n${namePrompt}`, keyboard: Markup.inlineKeyboard([[Markup.button.callback(strings.btn_skip, 'wizard:name_skip')]]) };
    }
    case 'budget': {
      if (state.awaitingCustomBudget) {
        return {
          text: `${progress}\n\n${strings.wizard_budget_custom_prompt}`,
          keyboard: Markup.inlineKeyboard([backRow].filter((r) => r.length > 0)),
        };
      }
      return {
        text: `${progress}\n\n${strings.wizard_budget_prompt}`,
        keyboard: Markup.inlineKeyboard([
          ...BUDGET_BANDS.map((b) => [Markup.button.callback(b.label, `wizard:budget:${b.priceFrom ?? ''}:${b.priceTo}`)]),
          [Markup.button.callback(strings.btn_custom_range, 'wizard:budget_custom')],
          backRow,
        ].filter((row) => row.length > 0)),
      };
    }
    case 'districts': {
      const selected = new Set(state.partial.districts ?? []);
      // Telegram inline keyboards truncate past ~8 buttons per row; chunk each district group so
      // districts 10-23 (14 buttons) don't get cut off on narrow screens.
      const rows = DISTRICT_GROUPS.flatMap((g) =>
        chunk(
          g.districts.map((d) => Markup.button.callback(selected.has(d) ? `✅ ${d}` : `${d}`, `wizard:district:${d}`)),
          7,
        )
      );
      const continueRow = selected.size > 0 ? [Markup.button.callback(strings.btn_continue, 'wizard:districts_continue')] : [];
      return { text: `${progress}\n\n${strings.wizard_districts_prompt}`, keyboard: Markup.inlineKeyboard([...rows, continueRow, backRow].filter((r) => r.length > 0)) };
    }
    case 'rooms_size':
      return {
        text: `${progress}\n\n${strings.wizard_rooms_prompt}`,
        keyboard: Markup.inlineKeyboard([
          // All room-count choices are open-ended minimums (1+, 2+, 3+), not exact matches.
          [Markup.button.callback('1+', 'wizard:rooms:1:'), Markup.button.callback('2+', 'wizard:rooms:2:'), Markup.button.callback('3+', 'wizard:rooms:3:')],
          [Markup.button.callback('Any', 'wizard:rooms_any')],
          backRow,
        ].filter((r) => r.length > 0)),
      };
    case 'amenities': {
      const p = state.partial;
      const chip = (label: string, on: boolean, field: string) => Markup.button.callback(on ? `✅ ${label}` : `⬜ ${label}`, `wizard:amenity:${field}`);
      return {
        text: `${progress}\n\n${strings.wizard_amenities_prompt}`,
        keyboard: Markup.inlineKeyboard([
          [chip(strings.amenity_elevator, Boolean(p.requireElevator), 'requireElevator'), chip(strings.amenity_parking, Boolean(p.requireParking), 'requireParking')],
          [chip(strings.amenity_include_waitlist, Boolean(p.includeWaitlistHousing), 'includeWaitlistHousing')],
          [chip(strings.amenity_include_wg, Boolean(p.includeWg), 'includeWg')],
          [Markup.button.callback(strings.btn_continue, 'wizard:amenities_continue')],
          backRow,
        ].filter((r) => r.length > 0)),
      };
    }
    case 'commute':
      return { text: `${progress}\n\n${strings.wizard_commute_prompt}`, keyboard: Markup.inlineKeyboard([[Markup.button.callback(strings.btn_skip, 'wizard:commute_skip')], backRow].filter((r) => r.length > 0)) };
  }
}

/** Top-ranked, not-yet-swiped listing for this user, or null if the queue is empty. */
export function nextCardFor(db: DB, chatId: number): ListingRow | null {
  const profile = getActiveSearchProfile(db, chatId);
  if (!profile) return null;
  const candidates = getCandidateListings(db, chatId, profile.prefs);
  if (candidates.length === 0) return null;
  const swiped = getSwipedWithDirection(db, chatId);
  return rankListings(candidates, swiped)[0];
}

/** Resolves every card label for a chat's language in one place, so formatCard itself stays pure and DB-free. */
export function cardLabels(db: DB, chatId: number): CardLabels {
  return {
    petBadge: t(db, chatId, 'pet_badge'),
    linkText: t(db, chatId, 'card_link_text'),
    rooms: t(db, chatId, 'card_rooms'),
    floor: t(db, chatId, 'card_floor'),
    availableFrom: t(db, chatId, 'card_available_from'),
    valueGood: t(db, chatId, 'card_value_good'),
    valueFair: t(db, chatId, 'card_value_fair'),
    valuePremium: t(db, chatId, 'card_value_premium'),
    lift: t(db, chatId, 'card_lift'),
    parking: t(db, chatId, 'card_parking'),
    energy: t(db, chatId, 'card_energy'),
    waitlistWarning: t(db, chatId, 'card_warning_waitlist'),
    wgWarning: t(db, chatId, 'card_warning_wg'),
    delistedWarning: t(db, chatId, 'card_warning_delisted'),
  };
}

/**
 * Extra fields an HTML card send needs on a text-only message: markup mode, and no auto-preview
 * competing with the card's own content. Only `sendMessage`/`editMessageText` payloads carry a
 * `link_preview_options` field at all — a photo send never gets a separate Telegram-generated
 * preview in the first place, so those call sites add `parse_mode: 'HTML'` alone instead.
 */
export const HTML_SEND_EXTRA = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

/** Telegram's hard cap on items in a single sendMediaGroup call. */
export const MAX_MEDIA_GROUP_ITEMS = 10;

interface MediaGroupItem {
  type: 'photo';
  media: string;
  caption?: string;
}

/** Pure — builds a sendMediaGroup payload, capped to Telegram's limit. Carries no caption: an album's text now lives on the following message, which is the only one that can hold buttons. */
export function buildMediaGroup(images: string[]): MediaGroupItem[] {
  return images.slice(0, MAX_MEDIA_GROUP_ITEMS).map((url) => ({ type: 'photo' as const, media: url }));
}

/** Pure — builds the Prev/Remove/Next row for browsing the shortlist one card at a time, omitting Prev at the first position and Next at the last (Telegram has no disabled-button state, so an unreachable direction is simply not offered), plus a full-width export row. */
export function shortlistNavButtons(
  listingId: string, position: number, total: number, exportLabel: string,
): ReturnType<typeof Markup.inlineKeyboard> {
  const row: ReturnType<typeof Markup.button.callback>[] = [];
  if (position > 1) row.push(Markup.button.callback('◀️ Prev', `slnav:prev:${listingId}`));
  row.push(Markup.button.callback('🗑️ Remove', `unlike:${listingId}`));
  if (position < total) row.push(Markup.button.callback('▶️ Next', `slnav:next:${listingId}`));
  return Markup.inlineKeyboard([row, [Markup.button.callback(exportLabel, 'slexport')]]);
}

/** Placeholder text used for the standalone buttons message that accompanies a multi-photo album — swapped wholesale (not appended to) once swiped, since it carries no listing info of its own. */
export const SWIPE_PROMPT_TEXT = '👍 or 👎?';
const GROUP_PLACEHOLDER_TEXTS: string[] = [SWIPE_PROMPT_TEXT];

/** Pure — decides whether a swiped/removed card's status replaces its message text wholesale (the album-companion placeholder) or gets appended to real listing text (caption, or the no-photo full-text card). */
export function appendSwipeStatus(originalText: string, status: string): string {
  return GROUP_PLACEHOLDER_TEXTS.includes(originalText) ? status : `${originalText}\n\n${status}`;
}

/**
 * Low-level: sends a listing as photo album / single photo / text, with the given inline buttons.
 *
 * sendMediaGroup is atomic — one dead URL fails the whole album with "group send failed" — so
 * images Telegram has already rejected are filtered out first, and an album that still fails falls
 * back to a single photo (itself fail-soft) rather than losing the card entirely.
 *
 * Telegram forbids reply_markup on sendMediaGroup, so an album's buttons must live on a following
 * message. That message now carries the card text too, rather than a contentless "👍 or 👎?" — which
 * both attaches the controls to real content and lifts the text out of the 1024-char caption cap.
 *
 * `renderCardText` takes a budget rather than being a finished string, because which budget applies
 * depends on which branch actually ends up sending: an album that sends successfully hands its text
 * to a standalone message (CARD_MESSAGE_LIMIT), but an album that fails at runtime (a rejected URL —
 * see the atomicity note above) falls through to a photo caption (CARD_CAPTION_LIMIT) instead. That
 * outcome isn't known until this function is already running, so the caller can't pick the budget in
 * advance — the branch that does the send is the only one that can size its own text. Passing a
 * pre-rendered string sized for the album's budget into the fallback would silently overflow
 * Telegram's real caption cap, and a caption rejection reads to sendPhotoCached as an image problem,
 * blacklisting a perfectly good (shared, cross-user) photo URL for its cooldown window.
 *
 * `now` is injected rather than read from the wall clock because two separate decisions here depend
 * on it — which urls are still suppressed, and (inside sendPhotoCached) whether a cached file_id is
 * still good — and a test cannot pin either against a moving clock.
 */
async function sendListingCard(
  telegram: Telegraf['telegram'], chatId: number, card: ListingRow, renderCardText: (maxLength: number) => string,
  buttons: ReturnType<typeof Markup.inlineKeyboard>, db: DB, now: Date,
): Promise<void> {
  const images = usablePhotoUrls(db, card.images, now);

  if (images.length >= 2) {
    let albumSent = false;
    try {
      await telegram.sendMediaGroup(chatId, buildMediaGroup(images));
      albumSent = true;
    } catch (err) {
      // Can't tell which image Telegram rejected, so don't blacklist any — just fall through to one photo.
      console.error('bot: album send failed, falling back to a single photo:', err);
    }
    if (albumSent) {
      await sendCardTextWithButtons(telegram, chatId, renderCardText(CARD_MESSAGE_LIMIT), buttons);
      return;
    }
  }

  if (images.length >= 1) {
    await sendPhotoCached(telegram, db, chatId, images[0], renderCardText(CARD_CAPTION_LIMIT), { ...buttons, parse_mode: 'HTML' }, now);
    return;
  }

  await telegram.sendMessage(chatId, `${renderCardText(CARD_MESSAGE_LIMIT)}\n(no photo)`, { ...buttons, ...HTML_SEND_EXTRA });
}

/**
 * Sends card text with its keyboard, retrying once unformatted if Telegram rejects the markup.
 * Because this message now carries the listing's own facts (not just buttons), losing it loses the
 * card's content, not just its controls — a malformed entity is overwhelmingly the likeliest
 * rejection, and dropping parse_mode recovers it without resending the album that already reached
 * the user. If even the retry fails, the failure is logged, not escalated: the photos are already in
 * the chat and there is nothing further this function can do about the missing text, so throwing here
 * would only turn one lost caption into an unhandled rejection for whatever is driving the send.
 */
async function sendCardTextWithButtons(
  telegram: Telegraf['telegram'], chatId: number, cardText: string,
  buttons: ReturnType<typeof Markup.inlineKeyboard>,
): Promise<void> {
  try {
    await telegram.sendMessage(chatId, cardText, { ...buttons, ...HTML_SEND_EXTRA });
  } catch (err) {
    console.error('bot: formatted card send failed, retrying as plain text:', err);
    try {
      // No parse_mode here (the retry is deliberately plain text), but the preview suppression still
      // applies: stripHtml turns the card's <a> tag into a bare URL, and without this Telegram would
      // auto-generate exactly the link-preview image the design suppresses everywhere else.
      await telegram.sendMessage(chatId, stripHtml(cardText), { ...buttons, link_preview_options: HTML_SEND_EXTRA.link_preview_options });
    } catch (retryErr) {
      console.error('bot: plain-text card retry failed:', retryErr);
    }
  }
}

/** Strips tags and unescapes entities so a rejected HTML card is still readable as plain text. */
export function stripHtml(s: string): string {
  return s
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2: $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Sends one listing as a swipeable card (photo album / single photo / text, with 👍👎 buttons). Shared by the pull path (/next) and the push path (proactive new-match notifications). */
export async function sendCard(
  telegram: Telegraf['telegram'], chatId: number, card: ListingRow, commuteLine: string | null | undefined, db: DB,
  now: Date = new Date(),
): Promise<void> {
  // The budget depends on which send path actually runs (album-then-message vs. a photo caption),
  // which sendListingCard alone knows once it commits to a branch — see its doc comment.
  const renderCardText = (maxLength: number) => formatCard(card, { commuteLine, labels: cardLabels(db, chatId), maxLength });
  const buttons = Markup.inlineKeyboard([
    Markup.button.callback('👎', `pass:${card.id}`),
    Markup.button.callback('👍', `like:${card.id}`),
  ]);
  await sendListingCard(telegram, chatId, card, renderCardText, buttons, db, now);
}

/** Sends one shortlist entry as a NEW message — single photo only (never the full album, unlike the swipe deck), so a later Prev/Next/Remove tap can edit this exact message in place. No commute line, to avoid a Routes API call per browse. */
async function sendShortlistBrowseCard(
  telegram: Telegraf['telegram'], chatId: number, card: ListingRow, position: number, total: number, db: DB,
): Promise<void> {
  const hasPhoto = card.images.length > 0;
  // A caption and a message have different real limits (1024 vs. 4096) — render at whichever one
  // this card is actually about to be sent as, not always the tighter caption budget.
  const text = formatCard(card, {
    prefix: `❤️ ${position} of ${total}\n\n`, labels: cardLabels(db, chatId),
    maxLength: hasPhoto ? CARD_CAPTION_LIMIT : CARD_MESSAGE_LIMIT,
  });
  const buttons = shortlistNavButtons(card.id, position, total, t(db, chatId, 'btn_export_csv'));
  if (hasPhoto) {
    await telegram.sendPhoto(chatId, card.images[0], { caption: text, ...buttons, parse_mode: 'HTML' });
  } else {
    await telegram.sendMessage(chatId, `${text}\n(no photo)`, { ...buttons, ...HTML_SEND_EXTRA });
  }
}

/**
 * Cached-or-computed commute line for one (search profile, listing) pair — null if the user has no
 * commute destination set, or the listing has no coordinates and no address to geocode as a
 * fallback (or that geocode fails), or the Routes API call failed. Cached in the DB since Routes
 * API calls cost quota and the same listing gets re-shown across /next, pushes, and swipes. Keyed
 * by profileId (not chatId): commuteDestination lives in SearchProfilePrefs, so once a chat can
 * hold multiple profiles with different destinations, caching per chat would let one profile's
 * cached ETA leak into another profile's view of the same listing.
 *
 * Not every advertiser publishes coordinates (verified: willhaben listings from Rustler
 * Immobilientreuhand never do), but most still have a plain address — geocoding it once and
 * persisting the result onto the listing row means the geocode call happens once per listing,
 * ever, not once per view.
 */
export async function getCommuteLineFor(
  db: DB, profileId: number, listing: ListingRow, prefs: SearchProfilePrefs, computeCommute: ComputeCommuteFn, geocode: GeocodeFn,
): Promise<string | null> {
  if (prefs.commuteDestination == null || prefs.commuteLat == null || prefs.commuteLon == null) return null;

  let origin = listing.lat != null && listing.lon != null ? { lat: listing.lat, lon: listing.lon } : null;
  if (!origin) {
    if (listing.addressLine == null) return null;
    origin = await geocode(listing.addressLine);
    if (!origin) return null;
    setListingCoords(db, listing.id, origin.lat, origin.lon);
  }

  let times = getCommuteTimes(db, profileId, listing.id);
  if (!times) {
    times = await computeCommute(origin, { lat: prefs.commuteLat, lon: prefs.commuteLon });
    setCommuteTimes(db, profileId, listing.id, times);
  }
  return formatCommuteLine(times, prefs.commuteDestination);
}

async function sendNextCard(telegram: Telegraf['telegram'], chatId: number, db: DB, deps: BotDeps): Promise<void> {
  const profile = getActiveSearchProfile(db, chatId);
  if (!profile) {
    await telegram.sendMessage(chatId, t(db, chatId, 'next_no_profile'));
    return;
  }
  const card = nextCardFor(db, chatId);
  if (!card) {
    await telegram.sendMessage(chatId, t(db, chatId, 'next_no_listings'));
    return;
  }
  const commuteLine = await getCommuteLineFor(db, profile.id, card, profile.prefs, deps.computeCommute, deps.geocode);
  await sendCard(telegram, chatId, card, commuteLine, db);
}

/** "\n\n" — the separator formatCard's re-render is joined to the status line with, budgeted like any other card content. */
const STATUS_SEPARATOR = '\n\n';

/**
 * The commute line for a card being re-rendered from the database (e.g. after a swipe), read from
 * the commute_cache table rather than recomputed — clearSwipedCardButtons is a best-effort, no-API-
 * call re-render, and the cache entry is guaranteed present whenever the original card carried a
 * commute line, because getCommuteLineFor writes it at exactly that moment. Null (not an error)
 * whenever there is no active profile, no commute destination configured, or no cache entry yet.
 */
function cachedCommuteLineFor(db: DB, chatId: number, listing: ListingRow): string | null {
  const profile = getActiveSearchProfile(db, chatId);
  if (!profile || profile.prefs.commuteDestination == null) return null;
  const times = getCommuteTimes(db, profile.id, listing.id);
  if (!times) return null;
  return formatCommuteLine(times, profile.prefs.commuteDestination);
}

/**
 * Clears the buttons on the message a swipe/remove callback came from, replacing its text/caption with
 * the card plus a short status line — otherwise Telegram leaves the 👍👎/🗑️ buttons live forever, and an
 * old card in chat history stays tappable.
 *
 * The text is re-rendered from the database rather than read back from `message.text`/`.caption`,
 * because Telegram returns those fields with all markup stripped: echoing either back under
 * parse_mode would drop the formatting and would fail outright on a title containing a bare `&`.
 * Two shapes can't be re-rendered and fall back to the original append-to-plain-text behaviour, sent
 * WITHOUT parse_mode:
 *  - a pre-this-change album-companion message, recognizable because its text is exactly
 *    SWIPE_PROMPT_TEXT — it never carried listing info of its own even when `listingId`'s row is
 *    still in the DB, so there is nothing to append a re-rendered card to;
 *  - a listing since deleted from the database (whether or not the message predates this change).
 *
 * Best-effort throughout: editing can fail (message too old, deleted, already edited), which must
 * never block sending the next card.
 */
async function clearSwipedCardButtons(
  ctx: {
    callbackQuery?: { message?: unknown };
    editMessageCaption: (caption?: string, extra?: Record<string, unknown>) => Promise<unknown>;
    editMessageText: (text: string, extra?: Record<string, unknown>) => Promise<unknown>;
  },
  status: string,
  db: DB,
  chatId: number,
  listingId: string | null,
  undoButton?: ReturnType<typeof Markup.button.callback>,
): Promise<void> {
  const message = ctx.callbackQuery?.message as { text?: string; caption?: string; photo?: unknown } | undefined;
  if (!message) return;

  const keyboard = Markup.inlineKeyboard(undoButton ? [undoButton] : []);
  // The album-companion placeholder is always a plain-text message (Telegram forbids reply_markup on
  // sendMediaGroup, so its buttons live on a standalone text message, never a caption) — checking
  // message.text alone is enough to recognize it.
  const isPlaceholder = message.text != null && GROUP_PLACEHOLDER_TEXTS.includes(message.text);
  const listing = !isPlaceholder && listingId != null ? getListingById(db, listingId) : null;

  try {
    if (listing != null) {
      const limit = message.photo ? CARD_CAPTION_LIMIT : CARD_MESSAGE_LIMIT;
      // Never hand formatCard a negative budget: status is always one of t()'s short, fixed
      // status_* strings (well under 100 chars in every locale — see locales/*.ts), so this floor is
      // purely defensive and never actually bites in practice; formatCard still gets the near-entirety
      // of `limit` to work with.
      const budget = Math.max(0, limit - status.length - STATUS_SEPARATOR.length);
      const commuteLine = cachedCommuteLineFor(db, chatId, listing);
      const rendered = formatCard(listing, { commuteLine, labels: cardLabels(db, chatId), maxLength: budget });
      const text = `${rendered}${STATUS_SEPARATOR}${status}`;
      const extra = { ...keyboard, ...HTML_SEND_EXTRA };
      if (message.photo) await ctx.editMessageCaption(text, extra);
      else await ctx.editMessageText(text, extra);
      return;
    }
    // Pre-deploy placeholder, or a listing since deleted from the DB: keep the original plain-text behaviour.
    if (message.photo) await ctx.editMessageCaption(appendSwipeStatus(message.caption ?? '', status), { ...keyboard });
    else if (message.text) await ctx.editMessageText(appendSwipeStatus(message.text, status), { ...keyboard });
  } catch {
    // best-effort — see doc comment above
  }
}

/** Minimal shape replaceShortlistCard/replaceShortlistWithEmptyState need from a callback context. */
interface ShortlistCardCtx {
  callbackQuery?: { message?: unknown };
  chat?: { id: number };
  telegram: Telegraf['telegram'];
  editMessageMedia: (
    media: { type: 'photo'; media: string; caption?: string; parse_mode?: 'HTML' },
    extra?: ReturnType<typeof Markup.inlineKeyboard>,
  ) => Promise<unknown>;
  editMessageText: (
    text: string,
    extra?: { reply_markup?: ReturnType<typeof Markup.inlineKeyboard>['reply_markup'] } & {
      parse_mode?: 'HTML'; link_preview_options?: { is_disabled: boolean };
    },
  ) => Promise<unknown>;
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
  ctx: ShortlistCardCtx, chatId: number, listing: ListingRow, text: string, buttons: ReturnType<typeof Markup.inlineKeyboard>,
): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch {
    // best-effort — an old/already-gone message can't always be deleted
  }
  try {
    // `text` must already be budgeted for whichever of these two the caller is about to hit — see
    // replaceShortlistCard, its only caller, which renders at CARD_CAPTION_LIMIT or CARD_MESSAGE_LIMIT
    // based on this exact same listing.images.length check.
    if (listing.images.length > 0) {
      await ctx.telegram.sendPhoto(chatId, listing.images[0], { caption: text, ...buttons, parse_mode: 'HTML' });
    } else {
      await ctx.telegram.sendMessage(chatId, `${text}\n(no photo)`, { ...buttons, ...HTML_SEND_EXTRA });
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
async function replaceShortlistCard(ctx: ShortlistCardCtx, listing: ListingRow, position: number, total: number, db: DB): Promise<void> {
  const message = ctx.callbackQuery?.message as { photo?: unknown } | undefined;
  if (!message) return;
  const chatId = ctx.chat!.id;
  const targetHasPhoto = listing.images.length > 0;
  // What the listing itself will send as (photo caption vs. text message) is what sets the budget in
  // every branch below, including the delete+send fallback — not whether the CURRENT message has a
  // photo, which only decides in-place-edit-vs-fresh-send.
  const text = formatCard(listing, {
    prefix: `❤️ ${position} of ${total}\n\n`, labels: cardLabels(db, chatId),
    maxLength: targetHasPhoto ? CARD_CAPTION_LIMIT : CARD_MESSAGE_LIMIT,
  });
  const buttons = shortlistNavButtons(listing.id, position, total, t(db, chatId, 'btn_export_csv'));
  const currentHasPhoto = Boolean(message.photo);
  if (targetHasPhoto && currentHasPhoto) {
    try {
      await ctx.editMessageMedia({ type: 'photo', media: listing.images[0], caption: text, parse_mode: 'HTML' }, buttons);
      return;
    } catch {
      // in-place edit failed (e.g. expired image URL) — fall through to delete+send below
    }
  } else if (!targetHasPhoto && !currentHasPhoto) {
    try {
      await ctx.editMessageText(`${text}\n(no photo)`, { ...buttons, ...HTML_SEND_EXTRA });
      return;
    } catch {
      // in-place edit failed — fall through to delete+send below
    }
  }
  await deleteAndSendShortlistCard(ctx, chatId, listing, text, buttons);
}

/** Replaces the current callback message with the empty-shortlist message — always delete+send, since there's no in-place target type to match against once nothing is left to browse. */
async function replaceShortlistWithEmptyState(ctx: ShortlistCardCtx, db: DB): Promise<void> {
  const chatId = ctx.chat!.id;
  try {
    await ctx.deleteMessage();
  } catch {
    // best-effort — an old/already-gone message can't always be deleted
  }
  try {
    await ctx.telegram.sendMessage(chatId, t(db, chatId, 'shortlist_empty'));
  } catch {
    // best-effort
  }
}

/** Sends the first shortlist card (or the empty-state message). Shared by /shortlist and the "📋 Shortlist" keyboard button — from there, browsing the rest happens via Prev/Next/Remove on that one message, not further /shortlist calls. */
async function sendShortlistTo(telegram: Telegraf['telegram'], chatId: number, db: DB): Promise<void> {
  const items = getShortlist(db, chatId);
  if (items.length === 0) {
    await telegram.sendMessage(chatId, t(db, chatId, 'shortlist_empty'));
    return;
  }
  await sendShortlistBrowseCard(telegram, chatId, items[0], 1, items.length, db);
}

/**
 * Delivers the chat's shortlist as a CSV document. An empty shortlist gets the same reply /shortlist
 * gives rather than a header-only file, which would read as a bug.
 *
 * `now` is injected so the filename's date stamp is pinnable in a test, matching sendCard's convention.
 */
export async function sendShortlistCsv(
  telegram: Telegraf['telegram'], chatId: number, db: DB, now: Date = new Date(),
): Promise<void> {
  const rows = getShortlistForExport(db, chatId);
  if (rows.length === 0) {
    await telegram.sendMessage(chatId, t(db, chatId, 'shortlist_empty'));
    return;
  }
  try {
    await telegram.sendDocument(
      chatId,
      { source: Buffer.from(toCsv(rows), 'utf8'), filename: exportFilename(now) },
      { caption: t(db, chatId, 'export_caption', { count: rows.length }) },
    );
  } catch (err) {
    console.error('bot: shortlist export failed:', err);
    await telegram.sendMessage(chatId, t(db, chatId, 'export_failed'));
  }
}

/**
 * Aggregate stats over a profile's already-matching candidates — match count, price range/avg, and
 * the (up to 3) districts with the most matches, sorted by frequency. Pure and exported so
 * formatAggregateSummary's rendering can be tested independently of the price-math/district-tally.
 */
export function summarizeMatches(listings: ListingRow[]): { count: number; priceMin: number | null; priceMax: number | null; priceAvg: number | null; topDistricts: number[] } {
  const prices = listings.map((l) => l.price).filter((p): p is number => p != null);
  const districtCounts = new Map<number, number>();
  for (const l of listings) {
    if (l.district != null) districtCounts.set(l.district, (districtCounts.get(l.district) ?? 0) + 1);
  }
  const topDistricts = [...districtCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d);
  return {
    count: listings.length,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    priceAvg: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
    topDistricts,
  };
}

/** Renders summarizeMatches' output into the one-line aggregate summary shown on profile activation. Pure. */
export function formatAggregateSummary(profile: SearchProfile, s: ReturnType<typeof summarizeMatches>): string {
  const priceRange = s.priceMin != null && s.priceMax != null ? `€${s.priceMin}-${s.priceMax} (avg €${Math.round(s.priceAvg!)})` : 'price n/a';
  const districts = s.topDistricts.length > 0 ? ` · mostly district${s.topDistricts.length > 1 ? 's' : ''} ${s.topDistricts.join(', ')}` : '';
  return `🏠 ${profile.name}: ${s.count} match${s.count === 1 ? '' : 'es'} · ${priceRange}${districts}`;
}

/**
 * Sends the aggregate match summary + a single "Browse top matches ▸" button on profile activation
 * (both the button-driven and free-text-driven wizard completion paths). The button's
 * `browse:<profileId>` callback (registered in createBot, below) is what actually starts the swipe
 * deck via sendNextCard — this function itself never sends a card.
 *
 * *** CONTRACT FROM TASK 6'S REVIEW, STILL BINDING ***
 * The callback-driven wizard-completion path (advanceWizard, below) finishes with `ctx.editMessageText`,
 * which structurally CANNOT attach a reply keyboard, so this function is the ONLY place a
 * wizard-completing-via-buttons user gets `MAIN_KEYBOARD` (the persistent ⏭ Next / 📋 Shortlist /
 * ⚙️ Settings nav bar) re-attached to their chat. Telegram's `reply_markup` is a closed union — a
 * single message can carry an inline keyboard (the Browse button) OR a persistent reply keyboard
 * (MAIN_KEYBOARD), never both — so when there are matches, restoring the nav bar takes a short lead-in
 * message SENT FIRST, with the summary + Browse button sent LAST so the call-to-action is the most
 * recent/prominent thing in the chat (Telegram's reply keyboard is chat-global and doesn't need to be
 * attached to the final message to take effect). Both branches below MUST keep sending a
 * `MAIN_KEYBOARD`-carrying message — dropping it silently removes the nav bar for every button-wizard
 * user.
 */
export async function sendProfileActivationSummary(telegram: Telegraf['telegram'], db: DB, profile: SearchProfile): Promise<void> {
  const candidates = getCandidateListings(db, profile.chatId, profile.prefs);
  if (candidates.length === 0) {
    // lift/parkingSpaces are only ever populated from immoscout's detail fetch (never willhaben,
    // and only for a capped batch of newly-enriched listings per poll — see db.ts's ListingRow doc
    // comment), so requiring either can silently starve the deck to near-empty with no explanation.
    const elevatorParkingNote = (profile.prefs.requireElevator || profile.prefs.requireParking)
      ? t(db, profile.chatId, 'elevator_parking_note')
      : '';
    await telegram.sendMessage(
      profile.chatId,
      t(db, profile.chatId, 'no_matches_yet', { name: profile.name }) + elevatorParkingNote,
      MAIN_KEYBOARD,
    );
    return;
  }
  const summary = summarizeMatches(candidates);
  await telegram.sendMessage(profile.chatId, t(db, profile.chatId, 'aggregate_summary_lead'), MAIN_KEYBOARD);
  await telegram.sendMessage(
    profile.chatId,
    formatAggregateSummary(profile, summary),
    Markup.inlineKeyboard([[Markup.button.callback('Browse top matches ▸', `browse:${profile.id}`)]]),
  );
}

/** Starts a brand-new wizard run for `chatId`: refuses once the chat is at MAX_SEARCH_PROFILES_PER_CHAT, otherwise resets wizard state to step 0 and sends its prompt. Shared by /start (first-time setup) and the "+ Add another search" button from /searches. */
async function startWizard(telegram: Telegraf['telegram'], db: DB, chatId: number): Promise<void> {
  if (countSearchProfiles(db, chatId) >= MAX_SEARCH_PROFILES_PER_CHAT) {
    await telegram.sendMessage(chatId, t(db, chatId, 'max_searches_reached', { maxProfiles: MAX_SEARCH_PROFILES_PER_CHAT }));
    return;
  }
  const state = initialWizardState();
  setWizardState(db, chatId, state);
  const { text, keyboard } = renderWizardStep(state, wizardStrings(db, chatId, wizardParams(db, chatId, state)));
  await telegram.sendMessage(chatId, text, keyboard);
}

/** Minimal shape advanceWizard needs from a callback context — matches ShortlistCardCtx's pattern above. */
interface WizardCtx {
  chat?: { id: number };
  telegram: Telegraf['telegram'];
  editMessageText: (text: string, extra?: ReturnType<typeof Markup.inlineKeyboard>) => Promise<unknown>;
  answerCbQuery: (text?: string) => Promise<unknown>;
}

/** Field labels + step ids offered by /settings' per-field edit menu and validated by the editfield: callback regex — single source of truth for both. */
const SETTINGS_FIELD_BUTTONS: [string, WizardStepId][] = [
  ['Name', 'name'], ['Budget', 'budget'], ['Districts', 'districts'], ['Rooms & size', 'rooms_size'], ['Amenities', 'amenities'], ['Commute', 'commute'],
];

/**
 * Applies the answer(s) accumulated in `next.partial`/`next.profileName` onto the profile being
 * single-field-edited, and clears the wizard state — the terminal step of an editfield: flow,
 * reached either via a button tap (advanceWizard) or free text (the name/commute steps, handled
 * directly in the `text` listener since those two steps bypass advanceWizard entirely).
 */
function finalizeFieldEdit(db: DB, chatId: number, editingProfileId: number, next: WizardState): string {
  const profile = getSearchProfile(db, editingProfileId);
  // TOCTOU: the profile being edited can be deleted (via /searches) between opening the edit
  // session and tapping the wizard chip that finalizes it. Treat that as a graceful no-op rather
  // than crashing on a non-null assertion — the wizard state must still be cleared either way, or
  // the chat is left permanently stuck believing it's mid-edit for a profile that no longer exists.
  if (!profile) {
    deleteWizardState(db, chatId);
    return t(db, chatId, 'search_no_longer_exists');
  }
  updateSearchProfile(db, profile.id, { ...profile.prefs, ...next.partial });
  if (next.profileName && next.profileName !== profile.name) renameSearchProfile(db, profile.id, next.profileName);
  deleteWizardState(db, chatId);
  return t(db, chatId, 'updated_search', { name: next.profileName ?? profile.name });
}

export function createBot(db: DB, token: string, deps: BotDeps): Telegraf {
  const bot = new Telegraf(token);

  /**
   * Applies one wizard choice (a button tap) and re-renders: edits the triggering message in place
   * to the next step's prompt, or — once the wizard is complete — to a save confirmation followed
   * by the activation summary.
   *
   * `applyWizardChoice` throws when `choice` doesn't match the step the wizard is currently on. A
   * normal Telegram user double-tapping a stale/superseded inline keyboard button (the message
   * already advanced to the next step, but the old step's buttons are still visible/tappable until
   * Telegram re-renders) triggers exactly this. That's not an error worth surfacing — the tap is
   * simply too late — so it's caught here and treated as a no-op: answerCbQuery clears the tap's
   * loading spinner and the message is left exactly as it already is (the current, correct step).
   */
  async function advanceWizard(ctx: WizardCtx, choice: WizardChoice): Promise<void> {
    const chatId = ctx.chat!.id;
    const current = getWizardState(db, chatId);
    if (!current) { await ctx.answerCbQuery(); return; } // stale callback from a finished/abandoned wizard

    let next: WizardState;
    try {
      next = applyWizardChoice(current, choice);
    } catch {
      await ctx.answerCbQuery(); // stale/duplicate tap on a step the wizard already moved past — see doc comment above
      return;
    }

    // Single-field /settings edit (editfield: jumped stepIndex straight to the one field being
    // edited, see bot.command('settings') below) — never runs the full onboarding's step-by-step
    // advancement or profile creation. A tap that doesn't move stepIndex (e.g. toggling one of
    // several districts before Continue) just re-renders the same step so multi-select fields still
    // work; a tap that does advance the step (or a Back tap, which moves it backward) is treated as
    // the field's final answer — Back cancels the edit outright rather than "saving" a decremented,
    // now-inconsistent partial state.
    if (current.editingProfileId != null) {
      if (choice.kind === 'back') {
        deleteWizardState(db, chatId);
        await ctx.answerCbQuery();
        await ctx.editMessageText(t(db, chatId, 'edit_cancelled'));
        return;
      }
      if (next.stepIndex === current.stepIndex) {
        setWizardState(db, chatId, next);
        await ctx.answerCbQuery();
        const { text, keyboard } = renderWizardStep(next, wizardStrings(db, chatId, wizardParams(db, chatId, next)));
        await ctx.editMessageText(text, keyboard);
        return;
      }
      const message = finalizeFieldEdit(db, chatId, current.editingProfileId, next);
      await ctx.answerCbQuery();
      await ctx.editMessageText(message);
      return;
    }

    if (isWizardComplete(next)) {
      deleteWizardState(db, chatId);
      const profile = createSearchProfile(db, chatId, next.profileName ?? `Search ${countSearchProfiles(db, chatId) + 1}`, finalizePrefs(next));
      await ctx.answerCbQuery();
      await ctx.editMessageText(t(db, chatId, 'saved_search_ready', { name: profile.name }));
      await sendProfileActivationSummary(ctx.telegram, db, profile);
      return;
    }
    setWizardState(db, chatId, next);
    await ctx.answerCbQuery();
    const { text, keyboard } = renderWizardStep(next, wizardStrings(db, chatId, wizardParams(db, chatId, next)));
    await ctx.editMessageText(text, keyboard);
  }

  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    if (getActiveSearchProfile(db, chatId)) {
      await ctx.reply(
        t(db, chatId, 'already_has_search'),
        MAIN_KEYBOARD,
      );
      return;
    }
    await ctx.reply(SAFETY_NOTICE);
    await startWizard(ctx.telegram, db, chatId);
  });

  /** Sends the active profile's per-field edit menu, or a "no active search" nudge if none exists. Shared by /settings and the "⚙️ Settings" persistent-keyboard button. */
  async function sendSettingsMenu(chatId: number): Promise<void> {
    const profile = getActiveSearchProfile(db, chatId);
    if (!profile) {
      await bot.telegram.sendMessage(chatId, t(db, chatId, 'no_active_search'));
      return;
    }
    await bot.telegram.sendMessage(
      chatId,
      t(db, chatId, 'settings_menu_title', { name: profile.name }),
      Markup.inlineKeyboard([
        ...SETTINGS_FIELD_BUTTONS.map(([label, field]) => [Markup.button.callback(label, `editfield:${profile.id}:${field}`)]),
        [Markup.button.callback(t(db, chatId, 'settings_notifications'), `notify:menu:${profile.id}`)],
      ]),
    );
  }

  bot.command('settings', async (ctx) => {
    await sendSettingsMenu(ctx.chat.id);
  });

  bot.command('searches', async (ctx) => {
    const chatId = ctx.chat.id;
    const profiles = getSearchProfiles(db, chatId);
    if (profiles.length === 0) {
      await ctx.reply(t(db, chatId, 'no_searches_yet'));
      return;
    }
    const lines = profiles.map((p) => `${p.active ? '▶ ' : '  '}${p.name}`).join('\n');
    const buttons = profiles.flatMap((p) => [
      ...(p.active ? [] : [Markup.button.callback(`Switch to "${p.name}"`, `switchprofile:${p.id}`)]),
      Markup.button.callback(`🗑️ Delete "${p.name}"`, `deleteprofile:${p.id}`),
    ]);
    const addButton = profiles.length < MAX_SEARCH_PROFILES_PER_CHAT ? [Markup.button.callback(t(db, chatId, 'btn_add_another_search'), 'wizard:new')] : [];
    await ctx.reply(
      `${t(db, chatId, 'searches_header')}\n${lines}`,
      Markup.inlineKeyboard([...buttons.map((b) => [b]), addButton].filter((row) => row.length > 0)),
    );
  });

  bot.action(/^switchprofile:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const profileId = Number(ctx.match[1]);
    const profile = getSearchProfile(db, profileId);
    if (!profile || profile.chatId !== chatId) { await ctx.answerCbQuery(t(db, chatId, 'search_no_longer_exists')); return; }
    setActiveSearchProfile(db, chatId, profileId);
    await ctx.answerCbQuery(t(db, chatId, 'switched'));
    // /help promises switching to a search with matches waiting sends the activation summary — this
    // is that promise's only call site for the switch path (wizard completion is the other one).
    await sendProfileActivationSummary(ctx.telegram, db, profile);
  });

  bot.action(/^deleteprofile:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const profileId = Number(ctx.match[1]);
    const target = getSearchProfile(db, profileId);
    if (!target || target.chatId !== chatId) { await ctx.answerCbQuery(t(db, chatId, 'search_no_longer_exists')); return; }
    const wasActive = getActiveSearchProfile(db, chatId)?.id === profileId;
    deleteSearchProfile(db, profileId);
    await ctx.answerCbQuery(t(db, chatId, 'deleted'));
    if (!wasActive) return;
    // The deleted profile was active — db.ts's deleteSearchProfile leaves no profile active
    // afterward (see its doc comment), so prompt the user to pick a new one if any remain.
    const remaining = getSearchProfiles(db, chatId);
    if (remaining.length === 0) {
      await ctx.reply(t(db, chatId, 'last_search_deleted'));
      return;
    }
    await ctx.reply(
      t(db, chatId, 'no_active_search_after_delete'),
      Markup.inlineKeyboard(remaining.map((p) => [Markup.button.callback(`Switch to "${p.name}"`, `switchprofile:${p.id}`)])),
    );
  });

  /**
   * Re-renders the notify menu into the message the user tapped, instead of posting a new one —
   * the house pattern at bot.ts:659/editfield: above. Telegram rejects an edit whose text+markup
   * are byte-identical to what's already there (e.g. tapping "More alerts" again at the ceiling
   * rung), so that failure is swallowed as best-effort rather than surfaced to the user.
   */
  async function rerenderNotifyMenu(ctx: { editMessageText: (text: string, extra?: ReturnType<typeof Markup.inlineKeyboard>) => Promise<unknown> }, db: DB, chatId: number, profile: SearchProfile): Promise<void> {
    const { text, keyboard } = renderNotifyMenu(db, chatId, profile);
    try {
      await ctx.editMessageText(text, keyboard);
    } catch {
      // best-effort — see doc comment above
    }
  }

  bot.action(/^notify:menu:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const profile = getSearchProfile(db, Number(ctx.match[1]));
    if (!profile || profile.chatId !== chatId) { await ctx.answerCbQuery(t(db, chatId, 'search_no_longer_exists')); return; }
    await ctx.answerCbQuery();
    await rerenderNotifyMenu(ctx, db, chatId, profile);
  });

  bot.action(/^notify:(pause|resume):(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const paused = ctx.match[1] === 'pause';
    const profile = getSearchProfile(db, Number(ctx.match[2]));
    if (!profile || profile.chatId !== chatId) { await ctx.answerCbQuery(t(db, chatId, 'search_no_longer_exists')); return; }

    updateNotifySettings(db, profile.id, { paused });
    await ctx.answerCbQuery(t(db, chatId, paused ? 'notify_paused' : 'notify_resumed', { name: profile.name }));
    await rerenderNotifyMenu(ctx, db, chatId, profile);
  });

  bot.action(/^notify:cap:(less|more):(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const direction = ctx.match[1] as 'less' | 'more';
    const profile = getSearchProfile(db, Number(ctx.match[2]));
    if (!profile || profile.chatId !== chatId) { await ctx.answerCbQuery(t(db, chatId, 'search_no_longer_exists')); return; }

    updateNotifySettings(db, profile.id, { dailyCap: nextDailyCap(getNotifySettings(db, profile.id).dailyCap, direction) });
    await ctx.answerCbQuery();
    await rerenderNotifyMenu(ctx, db, chatId, profile);
  });

  bot.action('wizard:new', async (ctx) => {
    await ctx.answerCbQuery();
    await startWizard(ctx.telegram, db, ctx.chat!.id);
  });

  bot.action(/^editfield:(\d+):(name|budget|districts|rooms_size|amenities|commute)$/, async (ctx) => {
    const [, profileIdRaw, field] = ctx.match;
    const profileId = Number(profileIdRaw);
    const profile = getSearchProfile(db, profileId);
    if (!profile || profile.chatId !== ctx.chat!.id) { await ctx.answerCbQuery(t(db, ctx.chat!.id, 'search_no_longer_exists')); return; }
    const stepIndex = WIZARD_STEPS.indexOf(field as WizardStepId);
    const state: WizardState = { stepIndex, profileName: profile.name, partial: profile.prefs, editingProfileId: profileId, awaitingCustomBudget: false };
    setWizardState(db, ctx.chat!.id, state);
    await ctx.answerCbQuery();
    const { text, keyboard } = renderWizardStep(state, wizardStrings(db, ctx.chat!.id, wizardParams(db, ctx.chat!.id, state)));
    await ctx.editMessageText(text, keyboard);
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(buildHelpText(db, ctx.chat.id), MAIN_KEYBOARD);
  });

  bot.command('language', async (ctx) => {
    const buttons = Markup.inlineKeyboard(
      (Object.keys(LOCALE_NAMES) as ChatLanguage[]).map((lang) => Markup.button.callback(LOCALE_NAMES[lang], `setlang:${lang}`))
    );
    await ctx.reply(t(db, ctx.chat.id, 'language_prompt'), buttons);
  });

  bot.action(/^setlang:(en|ru|de)$/, async (ctx) => {
    const [, lang] = ctx.match as unknown as [string, ChatLanguage];
    setChatLanguage(db, ctx.chat!.id, lang);
    await ctx.answerCbQuery();
    await ctx.reply(t(db, ctx.chat!.id, 'language_saved', { language: LOCALE_NAMES[lang] }));
  });

  bot.command('shortlist', async (ctx) => {
    await sendShortlistTo(ctx.telegram, ctx.chat.id, db);
  });

  bot.command('export', async (ctx) => {
    await sendShortlistCsv(ctx.telegram, ctx.chat.id, db);
  });

  bot.command('next', async (ctx) => {
    await sendNextCard(ctx.telegram, ctx.chat.id, db, deps);
  });

  bot.action('wizard:back', (ctx) => advanceWizard(ctx, { kind: 'back' }));
  bot.action('wizard:name_skip', async (ctx) => {
    const chatId = ctx.chat!.id;
    const current = getWizardState(db, chatId);
    if (current?.editingProfileId != null) {
      // Single-field edit mode: Skip means "leave the name as it is", not "generate a new default
      // name" — the latter would silently overwrite the profile's real name via finalizeFieldEdit's
      // rename-on-mismatch logic. Treat it exactly like Back: cancel the edit, don't touch the name.
      deleteWizardState(db, chatId);
      await ctx.answerCbQuery();
      await ctx.editMessageText(t(db, chatId, 'edit_cancelled'));
      return;
    }
    await advanceWizard(ctx, { kind: 'name', name: `Search ${countSearchProfiles(db, chatId) + 1}` });
  });
  bot.action(/^wizard:budget:(-?\d*):(-?\d+|Infinity)$/, (ctx) => {
    const [, fromRaw, toRaw] = ctx.match;
    return advanceWizard(ctx, { kind: 'budget', priceFrom: fromRaw === '' ? null : Number(fromRaw), priceTo: toRaw === 'Infinity' ? Infinity : Number(toRaw) });
  });
  bot.action('wizard:budget_custom', (ctx) => advanceWizard(ctx, { kind: 'budget_custom' }));
  bot.action(/^wizard:district:(\d+)$/, (ctx) => advanceWizard(ctx, { kind: 'districts_toggle', district: Number(ctx.match[1]) }));
  bot.action('wizard:districts_continue', (ctx) => advanceWizard(ctx, { kind: 'districts_continue' }));
  bot.action(/^wizard:rooms:(\d+):(\d*)$/, (ctx) => {
    const [, fromRaw, toRaw] = ctx.match;
    return advanceWizard(ctx, { kind: 'rooms_size', roomsFrom: Number(fromRaw), roomsTo: toRaw === '' ? null : Number(toRaw) });
  });
  // "Any" — no room-count restriction at all, the escape hatch the fixed 1/2/3+ chips otherwise lack.
  bot.action('wizard:rooms_any', (ctx) => advanceWizard(ctx, { kind: 'rooms_size', roomsFrom: null, roomsTo: null }));
  bot.action(/^wizard:amenity:(requireElevator|requireParking|includeWaitlistHousing|includeWg)$/, (ctx) =>
    advanceWizard(ctx, { kind: 'amenity_toggle', field: ctx.match[1] as 'requireElevator' | 'requireParking' | 'includeWaitlistHousing' | 'includeWg' })
  );
  bot.action('wizard:amenities_continue', (ctx) => advanceWizard(ctx, { kind: 'amenities_continue' }));
  bot.action('wizard:commute_skip', (ctx) => advanceWizard(ctx, { kind: 'commute_skip' }));

  /** The activation summary's only button — starts the swipe deck the same way /next or "⏭ Next" would. */
  bot.action(/^browse:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await sendNextCard(ctx.telegram, ctx.chat!.id, db, deps);
  });

  /** Per-listing "View ▸" button from push notifications — sends the full card on demand. */
  bot.action(/^view:(.+)$/, async (ctx) => {
    const [, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    const listing = getListingById(db, listingId);
    if (!listing) {
      await ctx.answerCbQuery(t(db, chatId, 'listing_no_longer_available'));
      return;
    }
    await ctx.answerCbQuery();
    const profile = getActiveSearchProfile(db, chatId);
    const commuteLine = profile
      ? await getCommuteLineFor(db, profile.id, listing, profile.prefs, deps.computeCommute, deps.geocode)
      : null;
    await sendCard(ctx.telegram, chatId, listing, commuteLine, db);
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = getWizardState(db, chatId);
    if (!state) {
      // Not mid-wizard: route the three persistent-keyboard button labels to the same logic their
      // matching commands run. Anything else falls through unchanged (silently ignored).
      const text = ctx.message.text;
      if (text === '⏭ Next') { await sendNextCard(ctx.telegram, chatId, db, deps); return; }
      if (text === '📋 Shortlist') { await sendShortlistTo(ctx.telegram, chatId, db); return; }
      if (text === '⚙️ Settings') { await sendSettingsMenu(chatId); return; }
      return;
    }
    const step = WIZARD_STEPS[state.stepIndex];
    const raw = ctx.message.text.trim();

    if (step === 'name') {
      const next = applyWizardChoice(state, { kind: 'name', name: raw });
      if (state.editingProfileId != null) {
        const message = finalizeFieldEdit(db, chatId, state.editingProfileId, next);
        await ctx.reply(message);
        return;
      }
      setWizardState(db, chatId, next);
      // First render of a new step after free text can't edit-in-place (no prior bot message to
      // edit) — sends fresh. Every step after this one edits in place via the callback handlers above.
      const { text, keyboard } = renderWizardStep(next, wizardStrings(db, chatId, wizardParams(db, chatId, next)));
      await ctx.reply(text, keyboard);
      return;
    }
    if (step === 'budget' && state.awaitingCustomBudget) {
      const parsed = parseCustomBudget(raw);
      if (!parsed) {
        await ctx.reply(t(db, chatId, 'wizard_budget_custom_error'));
        return;
      }
      const next = applyWizardChoice(state, { kind: 'budget', priceFrom: parsed.priceFrom, priceTo: parsed.priceTo ?? Infinity });
      if (state.editingProfileId != null) {
        const message = finalizeFieldEdit(db, chatId, state.editingProfileId, next);
        await ctx.reply(message);
        return;
      }
      setWizardState(db, chatId, next);
      const { text, keyboard } = renderWizardStep(next, wizardStrings(db, chatId, wizardParams(db, chatId, next)));
      try {
        await ctx.editMessageText(text, keyboard);
      } catch {
        await ctx.reply(text, keyboard);
      }
      return;
    }
    if (step === 'commute') {
      const trimmed = raw;
      const point = await deps.geocode(trimmed);
      if (!point) {
        await ctx.reply(t(db, chatId, 'commute_not_found'));
        return; // keep the same step, don't advance or lose prior answers
      }
      const next = applyWizardChoice(state, { kind: 'commute_set', destination: trimmed, lat: point.lat, lon: point.lon });
      if (state.editingProfileId != null) {
        const message = finalizeFieldEdit(db, chatId, state.editingProfileId, next);
        await ctx.reply(message);
        return;
      }
      deleteWizardState(db, chatId);
      const profile = createSearchProfile(db, chatId, next.profileName ?? `Search ${countSearchProfiles(db, chatId) + 1}`, finalizePrefs(next));
      await ctx.reply(t(db, chatId, 'saved_search_ready', { name: profile.name }), MAIN_KEYBOARD);
      await sendProfileActivationSummary(ctx.telegram, db, profile);
      return;
    }
    // Free text on any other step (name/commute/budget custom are the free-text-capable steps)
    // doesn't advance the wizard — but staying totally silent is a bad failure mode if the inline
    // buttons scrolled off-screen, so nudge the user back to them instead of dropping the message.
    await ctx.reply(t(db, chatId, 'tap_buttons_to_continue'));
  });

  bot.action(/^(like|pass):(.+)$/, async (ctx) => {
    const [, direction, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    const saved = recordSwipe(db, chatId, listingId, direction as 'like' | 'pass');
    const undoButton = Markup.button.callback('↩️ Undo', `undo:${listingId}`);
    if (direction === 'like' && !saved) {
      await ctx.answerCbQuery(t(db, chatId, 'listing_no_longer_available'));
      await clearSwipedCardButtons(ctx, t(db, chatId, 'status_no_longer_available'), db, chatId, listingId, undoButton);
    } else {
      await ctx.answerCbQuery(direction === 'like' ? t(db, chatId, 'saved_to_shortlist') : t(db, chatId, 'passed'));
      await clearSwipedCardButtons(ctx, direction === 'like' ? t(db, chatId, 'status_added_to_shortlist') : t(db, chatId, 'status_passed'), db, chatId, listingId, undoButton);
    }
    await sendNextCard(ctx.telegram, chatId, db, deps);
  });

  bot.action(/^undo:(.+)$/, async (ctx) => {
    const [, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    const undone = undoSwipe(db, chatId, listingId);
    if (!undone) {
      await ctx.answerCbQuery(t(db, chatId, 'undo_only_last'));
      return;
    }
    await ctx.answerCbQuery(t(db, chatId, 'swipe_undone'));
    await clearSwipedCardButtons(ctx, t(db, chatId, 'status_undone'), db, chatId, listingId);
  });

  bot.action(/^slnav:(prev|next):(.+)$/, async (ctx) => {
    const [, direction, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    const items = getShortlist(db, chatId);
    const idx = items.findIndex((i) => i.id === listingId);
    if (idx === -1) {
      await ctx.answerCbQuery(t(db, chatId, 'not_in_shortlist'));
      return;
    }
    const targetIdx = direction === 'prev' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= items.length) {
      await ctx.answerCbQuery(direction === 'prev' ? t(db, chatId, 'first_shortlist_item') : t(db, chatId, 'last_shortlist_item'));
      return;
    }
    await ctx.answerCbQuery();
    await replaceShortlistCard(ctx, items[targetIdx], targetIdx + 1, items.length, db);
  });

  bot.action('slexport', async (ctx) => {
    const chatId = ctx.chat!.id;
    await ctx.answerCbQuery();
    await sendShortlistCsv(ctx.telegram, chatId, db);
  });

  bot.action(/^unlike:(.+)$/, async (ctx) => {
    const [, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    const before = getShortlist(db, chatId);
    const removedIndex = before.findIndex((i) => i.id === listingId);
    removeFromShortlist(db, chatId, listingId);
    await ctx.answerCbQuery(t(db, chatId, 'removed_from_shortlist'));
    const after = getShortlist(db, chatId);
    if (after.length === 0) {
      await replaceShortlistWithEmptyState(ctx, db);
      return;
    }
    const nextIndex = Math.min(Math.max(removedIndex, 0), after.length - 1);
    await replaceShortlistCard(ctx, after[nextIndex], nextIndex + 1, after.length, db);
  });

  return bot;
}
