/**
 * Pure listing-card rendering. Deliberately free of DB, Telegraf, and wall-clock access so every
 * branch is testable directly — localized strings arrive as parameters, never resolved in here.
 */

/**
 * Escapes the four characters Telegram's HTML parse_mode treats as markup, including the quote —
 * required once escaped output can land inside an attribute value (`href="..."`), not just in text
 * content. Listing titles and addresses come from willhaben/ImmoScout verbatim and do contain `&`
 * and `<`; an unescaped one makes Telegram reject the whole message with "can't parse entities",
 * which loses the card silently rather than visibly.
 *
 * Ampersand is replaced first — reversing the order would double-escape the `&` in `&lt;`/`&quot;`.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Vienna's 23 districts, index 0 = district 1. German names in every locale: they are proper nouns
 * a user matches against listing sites and street signs, so translating them would make the card
 * harder to cross-reference, not easier.
 */
export const VIENNA_DISTRICT_NAMES: readonly string[] = Object.freeze([
  'Innere Stadt', 'Leopoldstadt', 'Landstraße', 'Wieden', 'Margareten',
  'Mariahilf', 'Neubau', 'Josefstadt', 'Alsergrund', 'Favoriten',
  'Simmering', 'Meidling', 'Hietzing', 'Penzing', 'Rudolfsheim-Fünfhaus',
  'Ottakring', 'Hernals', 'Währing', 'Döbling', 'Brigittenau',
  'Floridsdorf', 'Donaustadt', 'Liesing',
]);

const MIN_DISTRICT = 1;
const MAX_DISTRICT = 23;

/**
 * Vienna postal codes are fully derivable from the district number (6 -> 1060), which is why the
 * `listings` table stores no zip column. apt-hunter's NormalizedListing does carry `zip`, but
 * swipe-bot never persisted it — deriving avoids a migration and a backfill for data that is a
 * pure function of a column we already have.
 */
export function viennaPostalCode(district: number | null): string | null {
  if (district == null || !Number.isInteger(district)) return null;
  if (district < MIN_DISTRICT || district > MAX_DISTRICT) return null;
  return String(1000 + district * 10);
}

/** "1060 Mariahilf" — null when the district is missing or outside Vienna's 1-23 range. */
export function districtLabel(district: number | null): string | null {
  const postal = viennaPostalCode(district);
  if (postal == null || district == null) return null;
  return `${postal} ${VIENNA_DISTRICT_NAMES[district - 1]}`;
}

import type { ListingRow } from './db.js';

/** Telegram's hard caps: 4096 for a text message, 1024 for a photo/album caption. */
export const CARD_MESSAGE_LIMIT = 4096;
export const CARD_CAPTION_LIMIT = 1024;

/** How much of an advertiser's description the card shows before ellipsising. */
export const DESCRIPTION_SLICE = 200;

/**
 * Every localized string the renderer needs, resolved by the caller via t(). Passing them in keeps
 * this module pure and its tests free of a DB — the same reason formatCaption took petBadgeText.
 */
export interface CardLabels {
  petBadge: string;
  /** Template containing {source}, e.g. "Open on {source} ▸". */
  linkText: string;
  rooms: string;
  floor: string;
  availableFrom: string;
  valueGood: string;
  valueFair: string;
  valuePremium: string;
  lift: string;
  parking: string;
  energy: string;
  waitlistWarning: string;
  wgWarning: string;
  delistedWarning: string;
}

/** English defaults, kept in sync with src/locales/en.ts. Pure tests use these; the bot passes real ones. */
export const DEFAULT_CARD_LABELS: CardLabels = {
  petBadge: '🐾 mentions pets — check listing',
  linkText: 'Open on {source} ▸',
  rooms: 'rooms',
  floor: 'floor',
  availableFrom: 'from',
  valueGood: '✅ good value',
  valueFair: 'fair price',
  valuePremium: 'premium',
  lift: '🛗 Lift',
  parking: '🅿️ Parking',
  energy: '⚡ Energy',
  waitlistWarning: '⚠️ Municipal/waitlist housing — needs a Vormerkschein, Wohnticket, or Wiener Wohnen registration.',
  wgWarning: '🚪 WG — shared flat / co-living / student room, not a whole apartment.',
  delistedWarning: '⚠️ No longer listed — likely taken down by the advertiser.',
};

export interface CardOptions {
  commuteLine?: string | null;
  prefix?: string;
  labels?: CardLabels;
  maxLength?: number;
}

export const SOURCE_NAMES: Record<ListingRow['source'], string> = {
  willhaben: 'willhaben',
  immoscout: 'ImmoScout24',
};

function valueBadge(flag: ListingRow['valueFlag'], labels: CardLabels): string | null {
  if (flag === 'good') return labels.valueGood;
  if (flag === 'fair') return labels.valueFair;
  if (flag === 'premium') return labels.valuePremium;
  return null;
}

/**
 * Per-field ceilings on the four scraped strings that title/description's shrink cascade doesn't
 * cover: addressLine, floor, energyClass, availableFrom. Nothing upstream bounds these — willhaben
 * and ImmoScout hand them back verbatim — so without a cap here a single oversized field can blow
 * the card past its budget on its own. Generous enough that real Vienna listing data never gets
 * truncated (see the length numbers below); only pathological/scraper-garbage input hits the cap.
 */
const ADDRESS_LINE_MAX = 150;
const FLOOR_MAX = 60;
const ENERGY_CLASS_MAX = 60;
const AVAILABLE_FROM_MAX = 60;

/**
 * Last-resort ceilings on the two caller-supplied strings formatCard splices in: `prefix` (a
 * shortlist position line, or an instant-alert header built from a user's own search-profile name)
 * and `commuteLine` (built from a free-text commute destination the user typed during onboarding).
 * Both carry raw, unescaped, length-unbounded user text by the time they reach here — the
 * profile-name and commute-destination inputs have no validation upstream.
 *
 * Unlike the four scraped-field caps above, these are NOT applied upfront: `prefix`/`commuteLine`
 * take a place in the shrink cascade *after* description and title have already given up everything
 * they can (see formatCard below), so a normal shortlist position or profile name is never touched
 * — capping every prefix unconditionally, even a 16-char search name, was itself a real regression a
 * prior version of this fix shipped. These numbers only ever apply in a pathological combination
 * (every scraped-field cap maxed, every warning flag on, the longest of the three locales' label
 * text, the title already shrunk to nothing) — verified directly against all three locale catalogs
 * rather than assumed; see formatCard's tests.
 */
const PREFIX_MAX = 40;
const COMMUTE_LINE_MAX = 55;

/**
 * Escapes `raw` and truncates the *escaped* result to at most `maxLen` characters, appending an
 * ellipsis when it truncates. Capping the escaped length rather than the raw length is what makes
 * the bound exact: `&`, `<`, `>` and `"` each expand by up to 6x under escapeHtml, so a raw-length
 * cap alone doesn't bound the string this actually inserts into the card. Building character by
 * character (rather than escaping-then-slicing) guarantees the cut always falls between escaped
 * units, never mid-entity.
 */
function capEscapedField(raw: string | null, maxLen: number): string | null {
  if (raw == null) return null;
  let result = '';
  for (const ch of raw) {
    const esc = escapeHtml(ch);
    if (result.length + esc.length > maxLen - 1) return `${result}…`;
    result += esc;
  }
  return result;
}

/**
 * Like capEscapedField, but for `prefix`: keeps its trailing blank line intact when truncating,
 * rather than cutting it away along with everything else. `prefix` always ends in exactly `\n\n`
 * separating it from the card's own first line (the bold title); truncating that blank line away
 * let a shortened prefix's ellipsis land directly against `<b>`, merging what should read as two
 * lines into one.
 *
 * "Intact" does not mean "unbounded": an earlier version of this function re-appended the *whole*
 * trailing run of newlines after capping the body, uncounted against `maxLen` — so a prefix that was
 * mostly blank lines (a pasted or fat-fingered profile name, say) could make the return value far
 * longer than `maxLen`, defeating the budget guarantee this function exists to provide. A prefix
 * never needs more than its final blank line, so the trailing run is normalized down to at most two
 * newlines *first*, and that normalized run is what counts against `maxLen` — the same accounting
 * capEscapedField applies to every other character. The result is unconditional: this never returns
 * more than `maxLen` characters, for any input, including one that is nothing but newlines.
 */
function capPrefix(raw: string, maxLen: number): string {
  const trailingRun = raw.match(/\n+$/)?.[0] ?? '';
  const body = raw.slice(0, raw.length - trailingRun.length);
  const trailingNewlines = trailingRun.slice(0, Math.min(2, maxLen));
  const cappedBody = capEscapedField(body, Math.max(0, maxLen - trailingNewlines.length)) ?? '';
  return cappedBody + trailingNewlines;
}

/**
 * Builds the whole card as HTML.
 *
 * Length is enforced by shrinking fields *before* markup is assembled, never by slicing the
 * finished string: cutting assembled HTML can land inside a tag or an entity and make Telegram
 * reject the message. The shrink cascade goes, in order: drop the description, then shorten the
 * title, then — only if the card is still over budget with the title already at its floor — cap
 * `prefix` and `commuteLine` too. That order means a normal card (even with a full-length profile
 * name or commute line) is never touched by the last step; only a genuinely pathological
 * combination of oversized fields ever reaches it.
 */
export function formatCard(l: ListingRow, opts: CardOptions = {}): string {
  const labels = opts.labels ?? DEFAULT_CARD_LABELS;
  const maxLength = opts.maxLength ?? CARD_MESSAGE_LIMIT;

  // Escaped, but deliberately NOT length-capped here — see PREFIX_MAX/COMMUTE_LINE_MAX above for why.
  const rawPrefix = opts.prefix ?? '';
  const escapedPrefix = escapeHtml(rawPrefix);
  const escapedCommuteLine = opts.commuteLine ? escapeHtml(opts.commuteLine) : null;

  // Escaped-and-capped once per call, ahead of assembly: these four fields are unbounded coming out
  // of the scraper, and each is already in its final (escaped, budget-safe) form by the time it's
  // spliced into a line below — no further escapeHtml call on them.
  const addressLine = capEscapedField(l.addressLine, ADDRESS_LINE_MAX);
  const floor = capEscapedField(l.floor, FLOOR_MAX);
  const energyClass = capEscapedField(l.energyClass, ENERGY_CLASS_MAX);
  const availableFrom = capEscapedField(l.availableFrom, AVAILABLE_FROM_MAX);

  const build = (title: string, description: string | null, prefix: string, commuteLine: string | null): string => {
    const lines: string[] = [];
    lines.push(`<b>${escapeHtml(title)}</b>`);

    const district = districtLabel(l.district);
    const location = [district != null ? escapeHtml(district) : null, addressLine].filter((x): x is string => x != null && x !== '');
    if (location.length > 0) lines.push(`📍 ${location.join(' · ')}`);

    const priceBits = [
      l.price != null ? `€${l.price}` : null,
      l.pricePerSqm != null ? `€${Math.round(l.pricePerSqm)}/m²` : null,
      valueBadge(l.valueFlag, labels),
    ].filter((x): x is string => x != null);
    if (priceBits.length > 0) lines.push(`💶 ${priceBits.join(' · ')}`);

    const sizeBits = [
      l.area != null ? `${l.area} m²` : null,
      l.rooms != null ? `${l.rooms} ${labels.rooms}` : null,
      floor ? `${labels.floor} ${floor}` : null,
    ].filter((x): x is string => x != null);
    if (sizeBits.length > 0) lines.push(`📐 ${sizeBits.join(' · ')}`);

    const amenityBits = [
      l.lift === true ? labels.lift : null,
      l.parkingSpaces != null && l.parkingSpaces > 0 ? `${labels.parking} (${l.parkingSpaces})` : null,
      energyClass ? `${labels.energy} ${energyClass}` : null,
      availableFrom ? `${labels.availableFrom} ${availableFrom}` : null,
    ].filter((x): x is string => x != null);
    if (amenityBits.length > 0) lines.push(amenityBits.join(' · '));

    if (commuteLine) lines.push(commuteLine);

    if (l.requiresWaitlistTicket) lines.push(labels.waitlistWarning);
    if (l.isWg) lines.push(labels.wgWarning);
    if (l.isDelisted) lines.push(labels.delistedWarning);
    if (l.mentionsPets) lines.push(labels.petBadge);

    if (description) lines.push(`\n<i>${escapeHtml(description)}</i>`);

    const linkText = labels.linkText.replace('{source}', SOURCE_NAMES[l.source]);
    lines.push(`<a href="${escapeHtml(l.url)}">${escapeHtml(linkText)}</a>`);

    return `${prefix}${lines.join('\n')}`;
  };

  const sliced = l.description != null && l.description.length > DESCRIPTION_SLICE
    ? `${l.description.slice(0, DESCRIPTION_SLICE).trimEnd()}…`
    : l.description;

  let out = build(l.title, sliced, escapedPrefix, escapedCommuteLine);
  if (out.length <= maxLength) return out;

  out = build(l.title, null, escapedPrefix, escapedCommuteLine);
  if (out.length <= maxLength) return out;

  // Still over budget with no description: shorten the title next, by exactly the overflow, then
  // re-assemble so escaping and tags stay intact by construction.
  const titleOverflow = out.length - maxLength;
  const shortTitle = `${l.title.slice(0, Math.max(1, l.title.length - titleOverflow - 1)).trimEnd()}…`;
  out = build(shortTitle, null, escapedPrefix, escapedCommuteLine);
  if (out.length <= maxLength) return out;

  // Still over budget with the title at its floor: prefix and commuteLine are the only fields left
  // — cap them too, now, as the true last resort (see PREFIX_MAX/COMMUTE_LINE_MAX's doc comment for
  // why this never fires on a normal card).
  const shortPrefix = capPrefix(rawPrefix, PREFIX_MAX);
  const shortCommuteLine = opts.commuteLine ? capEscapedField(opts.commuteLine, COMMUTE_LINE_MAX) : null;
  return build(shortTitle, null, shortPrefix, shortCommuteLine);
}
