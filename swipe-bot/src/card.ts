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
