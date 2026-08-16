import { Telegraf, Markup } from 'telegraf';
import {
  type DB, type SearchProfilePrefs, type SearchProfile, type ListingRow, type CommuteTimes, type ChatLanguage,
  getActiveSearchProfile, getCandidateListings, getSwipedWithDirection, recordSwipe, getShortlist, removeFromShortlist, undoSwipe,
  getWizardState, setWizardState, deleteWizardState, getCommuteTimes, setCommuteTimes, setListingCoords,
  setChatLanguage, createSearchProfile, countSearchProfiles, MAX_SEARCH_PROFILES_PER_CHAT,
  getSearchProfiles, getSearchProfile, setActiveSearchProfile, deleteSearchProfile, updateSearchProfile, renameSearchProfile,
} from './db.js';
import { rankListings } from './scoring.js';
import { formatCommuteLine, type GeoPoint } from './commute.js';
import { t, LOCALE_NAMES } from './locales.js';
import {
  WIZARD_STEPS, BUDGET_BANDS, DISTRICT_GROUPS, initialWizardState, applyWizardChoice, isWizardComplete, finalizePrefs,
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
  { command: 'searches', description: 'List, switch, or delete your searches' },
  { command: 'settings', description: 'Change your preferences' },
  { command: 'help', description: 'How this bot works' },
  { command: 'language', description: 'Change the bot\'s language' },
];

/** Always-visible bottom keyboard for one-tap navigation — sent once (onboarding completion, or /start on an already-configured chat) and Telegram keeps it visible under the input field from then on. */
export const MAIN_KEYBOARD = Markup.keyboard([['⏭ Next', '📋 Shortlist', '⚙️ Settings']]).resize();

/** Every locale key `renderWizardStep`/`wizardStrings` needs resolved for the chat's language, fetched once per render. */
const WIZARD_STRING_KEYS = [
  'wizard_progress', 'wizard_name_prompt', 'wizard_budget_prompt', 'wizard_districts_prompt', 'wizard_rooms_prompt',
  'wizard_amenities_prompt', 'wizard_commute_prompt', 'btn_skip', 'btn_back', 'btn_continue', 'btn_custom_range',
  'amenity_elevator', 'amenity_parking', 'amenity_include_waitlist', 'amenity_include_wg',
] as const;

function wizardStrings(db: DB, chatId: number): Record<string, string> {
  return Object.fromEntries(WIZARD_STRING_KEYS.map((k) => [k, t(db, chatId, k)]));
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
    case 'name':
      return { text: `${progress}\n\n${strings.wizard_name_prompt}`, keyboard: Markup.inlineKeyboard([[Markup.button.callback(strings.btn_skip, 'wizard:name_skip')]]) };
    case 'budget':
      return {
        text: `${progress}\n\n${strings.wizard_budget_prompt}`,
        keyboard: Markup.inlineKeyboard([
          ...BUDGET_BANDS.map((b) => [Markup.button.callback(b.label, `wizard:budget:${b.priceFrom ?? ''}:${b.priceTo}`)]),
          backRow,
        ].filter((row) => row.length > 0)),
      };
    case 'districts': {
      const selected = new Set(state.partial.districts ?? []);
      const rows = DISTRICT_GROUPS.map((g) => g.districts.map((d) =>
        Markup.button.callback(selected.has(d) ? `✅ ${d}` : `${d}`, `wizard:district:${d}`)
      ));
      const continueRow = selected.size > 0 ? [Markup.button.callback(strings.btn_continue, 'wizard:districts_continue')] : [];
      return { text: `${progress}\n\n${strings.wizard_districts_prompt}`, keyboard: Markup.inlineKeyboard([...rows, continueRow, backRow].filter((r) => r.length > 0)) };
    }
    case 'rooms_size':
      return {
        text: `${progress}\n\n${strings.wizard_rooms_prompt}`,
        keyboard: Markup.inlineKeyboard([
          [Markup.button.callback('1', 'wizard:rooms:1:1'), Markup.button.callback('2', 'wizard:rooms:2:2'), Markup.button.callback('3+', 'wizard:rooms:3:')],
          [Markup.button.callback(strings.btn_custom_range, 'wizard:rooms_custom')],
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

/** Telegram's hard cap on caption length for photos and media groups alike. */
const MAX_CAPTION_LENGTH = 1024;

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trimEnd() + '…';
}

/** Default English text for the pet-mention badge — used when no localized string is supplied. Kept in sync with locales/en.ts's `pet_badge` key. */
const DEFAULT_PET_BADGE_TEXT = '🐾 mentions pets — check listing';

/**
 * Pure — builds the card caption (title, price/size/rooms/district, eligibility flag, amenity
 * facts, pet-mention badge, commute line, description, link). Exported for direct testing.
 *
 * `petBadgeText` defaults to English so pure tests (no `db`/`chatId`) keep working unchanged; the
 * one call site that needs localization passes `t(db, chatId, 'pet_badge')` explicitly. The badge
 * only ever means the listing text mentions pets somewhere — never a confirmed pet-friendly amenity
 * — so its wording must stay hedged ("check listing") in every locale.
 */
export function formatCaption(
  l: ListingRow, commuteLine?: string | null, prefix?: string, petBadgeText: string = DEFAULT_PET_BADGE_TEXT,
): string {
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
  // Info-only facts — only ever shown when known; a null field is omitted, never rendered as "no".
  const amenityBits = [
    l.lift === true ? 'Lift' : null,
    l.parkingSpaces != null && l.parkingSpaces > 0 ? `Parking (${l.parkingSpaces})` : null,
    l.floor ? `Floor: ${l.floor}` : null,
    l.energyClass ? `Energy: ${l.energyClass}` : null,
    l.availableFrom ? `Available: ${l.availableFrom}` : null,
  ].filter((x): x is string => x != null);
  const amenities = amenityBits.length > 0 ? `\n${amenityBits.join(' · ')}` : '';
  // Unverified — the listing text merely mentions pets; never presented as a confirmed amenity.
  const petBadge = l.mentionsPets ? `\n${petBadgeText}` : '';
  const commute = commuteLine ? `\n${commuteLine}` : '';
  const base = `${l.title}\n${price} · ${details}${flag}${wgFlag}${delistedFlag}${amenities}${petBadge}${commute}\n${l.url}`;
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
  telegram: Telegraf['telegram'], chatId: number, card: ListingRow, commuteLine: string | null | undefined, db: DB,
): Promise<void> {
  const caption = formatCaption(card, commuteLine, undefined, t(db, chatId, 'pet_badge'));
  const buttons = Markup.inlineKeyboard([
    Markup.button.callback('👎', `pass:${card.id}`),
    Markup.button.callback('👍', `like:${card.id}`),
  ]);
  await sendListingCard(telegram, chatId, card, caption, buttons, SWIPE_PROMPT_TEXT);
}

/** Sends one shortlist entry as a NEW message — single photo only (never the full album, unlike the swipe deck), so a later Prev/Next/Remove tap can edit this exact message in place. No commute line, to avoid a Routes API call per browse. */
async function sendShortlistBrowseCard(
  telegram: Telegraf['telegram'], chatId: number, card: ListingRow, position: number, total: number, db: DB,
): Promise<void> {
  const caption = formatCaption(card, null, `❤️ ${position} of ${total}\n\n`, t(db, chatId, 'pet_badge'));
  const buttons = shortlistNavButtons(card.id, position, total);
  if (card.images.length > 0) {
    await telegram.sendPhoto(chatId, card.images[0], { caption, ...buttons });
  } else {
    await telegram.sendMessage(chatId, `${caption}\n(no photo)`, buttons);
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
    await telegram.sendMessage(chatId, 'You haven\'t set your preferences yet — send /start to get set up.');
    return;
  }
  const card = nextCardFor(db, chatId);
  if (!card) {
    await telegram.sendMessage(chatId, 'No new listings right now — check back after the next poll (every ~3h).');
    return;
  }
  const commuteLine = await getCommuteLineFor(db, profile.id, card, profile.prefs, deps.computeCommute, deps.geocode);
  await sendCard(telegram, chatId, card, commuteLine, db);
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
async function replaceShortlistCard(ctx: ShortlistCardCtx, listing: ListingRow, position: number, total: number, db: DB): Promise<void> {
  const message = ctx.callbackQuery?.message as { photo?: unknown } | undefined;
  if (!message) return;
  const chatId = ctx.chat!.id;
  const caption = formatCaption(listing, null, `❤️ ${position} of ${total}\n\n`, t(db, chatId, 'pet_badge'));
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

/** Sends the first shortlist card (or the empty-state message). Shared by /shortlist and the "📋 Shortlist" keyboard button — from there, browsing the rest happens via Prev/Next/Remove on that one message, not further /shortlist calls. */
async function sendShortlistTo(telegram: Telegraf['telegram'], chatId: number, db: DB): Promise<void> {
  const items = getShortlist(db, chatId);
  if (items.length === 0) {
    await telegram.sendMessage(chatId, 'Your shortlist is empty — 👍 a card to save it here.');
    return;
  }
  await sendShortlistBrowseCard(telegram, chatId, items[0], 1, items.length, db);
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
    await telegram.sendMessage(
      profile.chatId,
      `🏠 ${profile.name}: no matches yet — I'll message you here as soon as something matches.`,
      MAIN_KEYBOARD,
    );
    return;
  }
  const summary = summarizeMatches(candidates);
  await telegram.sendMessage(profile.chatId, "Here's what's already out there for it:", MAIN_KEYBOARD);
  await telegram.sendMessage(
    profile.chatId,
    formatAggregateSummary(profile, summary),
    Markup.inlineKeyboard([[Markup.button.callback('Browse top matches ▸', `browse:${profile.id}`)]]),
  );
}

/** Starts a brand-new wizard run for `chatId`: refuses once the chat is at MAX_SEARCH_PROFILES_PER_CHAT, otherwise resets wizard state to step 0 and sends its prompt. Shared by /start (first-time setup) and the "+ Add another search" button from /searches. */
async function startWizard(telegram: Telegraf['telegram'], db: DB, chatId: number): Promise<void> {
  if (countSearchProfiles(db, chatId) >= MAX_SEARCH_PROFILES_PER_CHAT) {
    await telegram.sendMessage(chatId, `You already have ${MAX_SEARCH_PROFILES_PER_CHAT} searches — delete one with /searches first.`);
    return;
  }
  const state = initialWizardState();
  setWizardState(db, chatId, state);
  const { text, keyboard } = renderWizardStep(state, wizardStrings(db, chatId));
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
  const profile = getSearchProfile(db, editingProfileId)!;
  updateSearchProfile(db, profile.id, { ...profile.prefs, ...next.partial });
  if (next.profileName && next.profileName !== profile.name) renameSearchProfile(db, profile.id, next.profileName);
  deleteWizardState(db, chatId);
  return `Updated "${next.profileName ?? profile.name}".`;
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
        await ctx.editMessageText('Edit cancelled.');
        return;
      }
      if (next.stepIndex === current.stepIndex) {
        setWizardState(db, chatId, next);
        await ctx.answerCbQuery();
        const { text, keyboard } = renderWizardStep(next, wizardStrings(db, chatId));
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
      await ctx.editMessageText(`Saved "${profile.name}". New listings get checked every ~3h — I'll message you here as soon as something matches.`);
      await sendProfileActivationSummary(ctx.telegram, db, profile);
      return;
    }
    setWizardState(db, chatId, next);
    await ctx.answerCbQuery();
    const { text, keyboard } = renderWizardStep(next, wizardStrings(db, chatId));
    await ctx.editMessageText(text, keyboard);
  }

  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    if (getActiveSearchProfile(db, chatId)) {
      await ctx.reply(
        'You already have a search set up — /next for a listing, /searches to manage your searches, ' +
        'or /settings to edit one.',
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
      await bot.telegram.sendMessage(chatId, 'No active search — /start to set one up.');
      return;
    }
    await bot.telegram.sendMessage(
      chatId,
      `Editing "${profile.name}" — pick a field:`,
      Markup.inlineKeyboard(SETTINGS_FIELD_BUTTONS.map(([label, field]) => [Markup.button.callback(label, `editfield:${profile.id}:${field}`)])),
    );
  }

  bot.command('settings', async (ctx) => {
    await sendSettingsMenu(ctx.chat.id);
  });

  bot.command('searches', async (ctx) => {
    const chatId = ctx.chat.id;
    const profiles = getSearchProfiles(db, chatId);
    if (profiles.length === 0) {
      await ctx.reply('No searches yet — /start to set one up.');
      return;
    }
    const lines = profiles.map((p) => `${p.active ? '▶ ' : '  '}${p.name}`).join('\n');
    const buttons = profiles.flatMap((p) => [
      ...(p.active ? [] : [Markup.button.callback(`Switch to "${p.name}"`, `switchprofile:${p.id}`)]),
      Markup.button.callback(`🗑️ Delete "${p.name}"`, `deleteprofile:${p.id}`),
    ]);
    const addButton = profiles.length < MAX_SEARCH_PROFILES_PER_CHAT ? [Markup.button.callback(t(db, chatId, 'btn_add_another_search'), 'wizard:new')] : [];
    await ctx.reply(
      `Your searches:\n${lines}`,
      Markup.inlineKeyboard([...buttons.map((b) => [b]), addButton].filter((row) => row.length > 0)),
    );
  });

  bot.action(/^switchprofile:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const profileId = Number(ctx.match[1]);
    const profile = getSearchProfile(db, profileId);
    if (!profile || profile.chatId !== chatId) { await ctx.answerCbQuery('That search no longer exists.'); return; }
    setActiveSearchProfile(db, chatId, profileId);
    await ctx.answerCbQuery('Switched.');
  });

  bot.action(/^deleteprofile:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const profileId = Number(ctx.match[1]);
    const target = getSearchProfile(db, profileId);
    if (!target || target.chatId !== chatId) { await ctx.answerCbQuery('This search no longer exists.'); return; }
    const wasActive = getActiveSearchProfile(db, chatId)?.id === profileId;
    deleteSearchProfile(db, profileId);
    await ctx.answerCbQuery('Deleted.');
    if (!wasActive) return;
    // The deleted profile was active — db.ts's deleteSearchProfile leaves no profile active
    // afterward (see its doc comment), so prompt the user to pick a new one if any remain.
    const remaining = getSearchProfiles(db, chatId);
    if (remaining.length === 0) {
      await ctx.reply('Deleted your last search — /start to set up a new one.');
      return;
    }
    await ctx.reply(
      'Deleted. No search is active now — pick one to switch to:',
      Markup.inlineKeyboard(remaining.map((p) => [Markup.button.callback(`Switch to "${p.name}"`, `switchprofile:${p.id}`)])),
    );
  });

  bot.action('wizard:new', async (ctx) => {
    await ctx.answerCbQuery();
    await startWizard(ctx.telegram, db, ctx.chat!.id);
  });

  bot.action(/^editfield:(\d+):(name|budget|districts|rooms_size|amenities|commute)$/, async (ctx) => {
    const [, profileIdRaw, field] = ctx.match;
    const profileId = Number(profileIdRaw);
    const profile = getSearchProfile(db, profileId);
    if (!profile || profile.chatId !== ctx.chat!.id) { await ctx.answerCbQuery('This search no longer exists.'); return; }
    const stepIndex = WIZARD_STEPS.indexOf(field as WizardStepId);
    const state: WizardState = { stepIndex, profileName: profile.name, partial: profile.prefs, editingProfileId: profileId };
    setWizardState(db, ctx.chat!.id, state);
    await ctx.answerCbQuery();
    const { text, keyboard } = renderWizardStep(state, wizardStrings(db, ctx.chat!.id));
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
      await ctx.editMessageText('Edit cancelled.');
      return;
    }
    await advanceWizard(ctx, { kind: 'name', name: `Search ${countSearchProfiles(db, chatId) + 1}` });
  });
  bot.action(/^wizard:budget:(-?\d*):(-?\d+|Infinity)$/, (ctx) => {
    const [, fromRaw, toRaw] = ctx.match;
    return advanceWizard(ctx, { kind: 'budget', priceFrom: fromRaw === '' ? null : Number(fromRaw), priceTo: toRaw === 'Infinity' ? Infinity : Number(toRaw) });
  });
  bot.action(/^wizard:district:(\d+)$/, (ctx) => advanceWizard(ctx, { kind: 'districts_toggle', district: Number(ctx.match[1]) }));
  bot.action('wizard:districts_continue', (ctx) => advanceWizard(ctx, { kind: 'districts_continue' }));
  bot.action(/^wizard:rooms:(\d+):(\d*)$/, (ctx) => {
    const [, fromRaw, toRaw] = ctx.match;
    return advanceWizard(ctx, { kind: 'rooms_size', roomsFrom: Number(fromRaw), roomsTo: toRaw === '' ? null : Number(toRaw), areaFrom: null, areaTo: null });
  });
  // No wizard step currently prompts for a custom rooms/size range via free text — the button exists
  // (renderWizardStep's "Custom range ▸" chip) so the keyboard reads clearly, but tapping it today
  // just clears the tap's loading spinner rather than hanging forever unanswered. A future task can
  // wire it to an actual free-text prompt if the fixed 1/2/3+ chips prove too coarse in practice.
  bot.action('wizard:rooms_custom', (ctx) => ctx.answerCbQuery('Custom ranges aren\'t supported yet — pick 1, 2, or 3+.'));
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
      const { text, keyboard } = renderWizardStep(next, wizardStrings(db, chatId));
      await ctx.reply(text, keyboard);
      return;
    }
    if (step === 'commute') {
      const trimmed = raw;
      const point = await deps.geocode(trimmed);
      if (!point) {
        await ctx.reply('couldn\'t find that location — try being more specific, or tap Skip');
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
      await ctx.reply(`Saved "${profile.name}". New listings get checked every ~3h — I'll message you here as soon as something matches.`, MAIN_KEYBOARD);
      await sendProfileActivationSummary(ctx.telegram, db, profile);
      return;
    }
    // Free text on any other step (name/commute are the only free-text-capable steps) doesn't
    // advance the wizard — but staying totally silent is a bad failure mode if the inline buttons
    // scrolled off-screen, so nudge the user back to them instead of dropping the message.
    await ctx.reply('Please tap one of the buttons above to continue.');
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
    await replaceShortlistCard(ctx, items[targetIdx], targetIdx + 1, items.length, db);
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
    await replaceShortlistCard(ctx, after[nextIndex], nextIndex + 1, after.length, db);
  });

  return bot;
}
