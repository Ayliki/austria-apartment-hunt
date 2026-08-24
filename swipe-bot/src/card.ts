/**
 * Pure listing-card rendering. Deliberately free of DB, Telegraf, and wall-clock access so every
 * branch is testable directly — localized strings arrive as parameters, never resolved in here.
 */

/**
 * Escapes the three characters Telegram's HTML parse_mode treats as markup. Listing titles and
 * addresses come from willhaben/ImmoScout verbatim and do contain `&` and `<`; an unescaped one
 * makes Telegram reject the whole message with "can't parse entities", which loses the card
 * silently rather than visibly.
 *
 * Ampersand is replaced first — reversing the order would double-escape the `&` in `&lt;`.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

const SOURCE_NAMES: Record<ListingRow['source'], string> = {
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
 * Builds the whole card as HTML.
 *
 * Length is enforced by shrinking the description *before* markup is assembled, never by slicing
 * the finished string: cutting assembled HTML can land inside a tag or an entity and make Telegram
 * reject the message. If the card is still over budget with no description at all, the title is
 * shortened instead — the only remaining unbounded field.
 */
export function formatCard(l: ListingRow, opts: CardOptions = {}): string {
  const labels = opts.labels ?? DEFAULT_CARD_LABELS;
  const maxLength = opts.maxLength ?? CARD_MESSAGE_LIMIT;
  const prefix = opts.prefix ?? '';

  const build = (title: string, description: string | null): string => {
    const lines: string[] = [];
    lines.push(`<b>${escapeHtml(title)}</b>`);

    const location = [districtLabel(l.district), l.addressLine].filter((x): x is string => x != null && x !== '');
    if (location.length > 0) lines.push(`📍 ${escapeHtml(location.join(' · '))}`);

    const priceBits = [
      l.price != null ? `€${l.price}` : null,
      l.pricePerSqm != null ? `€${Math.round(l.pricePerSqm)}/m²` : null,
      valueBadge(l.valueFlag, labels),
    ].filter((x): x is string => x != null);
    if (priceBits.length > 0) lines.push(`💶 ${priceBits.join(' · ')}`);

    const sizeBits = [
      l.area != null ? `${l.area} m²` : null,
      l.rooms != null ? `${l.rooms} ${labels.rooms}` : null,
      l.floor ? `${labels.floor} ${escapeHtml(l.floor)}` : null,
    ].filter((x): x is string => x != null);
    if (sizeBits.length > 0) lines.push(`📐 ${sizeBits.join(' · ')}`);

    const amenityBits = [
      l.lift === true ? labels.lift : null,
      l.parkingSpaces != null && l.parkingSpaces > 0 ? `${labels.parking} (${l.parkingSpaces})` : null,
      l.energyClass ? `${labels.energy} ${escapeHtml(l.energyClass)}` : null,
      l.availableFrom ? `${labels.availableFrom} ${escapeHtml(l.availableFrom)}` : null,
    ].filter((x): x is string => x != null);
    if (amenityBits.length > 0) lines.push(amenityBits.join(' · '));

    if (opts.commuteLine) lines.push(opts.commuteLine);

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

  let out = build(l.title, sliced);
  if (out.length <= maxLength) return out;

  out = build(l.title, null);
  if (out.length <= maxLength) return out;

  // Still over budget with no description: the title is the only unbounded field left. Shorten it
  // by exactly the overflow, then re-assemble so escaping and tags stay intact by construction.
  const overflow = out.length - maxLength;
  const shortTitle = `${l.title.slice(0, Math.max(1, l.title.length - overflow - 1)).trimEnd()}…`;
  return build(shortTitle, null);
}
