# Card Redesign, Inline Swipe Buttons, and Shortlist CSV Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Telegram swipe deck a structured, HTML-formatted card with its 👍/👎 buttons attached to the listing message itself, and let a user export their shortlist as a CSV file.

**Architecture:** A new pure module `src/card.ts` becomes the single renderer for listing text, replacing `formatCaption` in `bot.ts`. Multi-photo listings send the album without a caption, followed by one message carrying both the card text and the inline keyboard — which is the only way Telegram permits buttons alongside an album. A second pure module `src/export.ts` renders shortlist rows to Excel-compatible CSV, delivered via `sendDocument`.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Telegraf 4, better-sqlite3, `node --import tsx --test` for tests.

**Spec:** `docs/superpowers/specs/2026-08-24-card-redesign-csv-export-design.md`

## Global Constraints

- **Working directory is `swipe-bot/`** for every command in this plan unless stated otherwise.
- **`parse_mode: 'HTML'`** everywhere card text is sent or edited. Never MarkdownV2.
- **Every listing-sourced string is escaped** before it enters HTML: `title`, `addressLine`, `description`, `floor`, `energyClass`, `availableFrom`, `url`.
- **Length budgets:** 4096 characters for a standalone message, 1024 for a photo caption. The existing constant is `MAX_CAPTION_LENGTH` in `src/bot.ts`.
- **CSV format:** `;` delimiter, UTF-8 BOM prefix, RFC 4180 quoting. CSV column headers are English in every locale.
- **Vienna district names stay German in all three locales** — they are proper nouns.
- **Every new user-facing string lands in all three catalogs** (`src/locales/en.ts`, `ru.ts`, `de.ts`). `test/locales.test.ts` enforces key parity and will fail otherwise.
- **`card.ts` and `export.ts` must stay pure** — no `DB`, no `Telegraf`, no wall-clock reads. Localized strings arrive as parameters; clocks are injected.
- **Commit after each task. Do not push** — this project's standing convention is commit freely, push only on explicit request.
- **Do not run `git rebase -i`, `git add -i`,** or any interactive git command.

---

### Task 1: HTML escaping and Vienna district helpers

The smallest pure foundation the card renderer needs. No card assembly yet.

**Files:**
- Create: `src/card.ts`
- Test: `test/card.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `escapeHtml(s: string): string`
  - `VIENNA_DISTRICT_NAMES: readonly string[]` (23 entries, index 0 = district 1)
  - `viennaPostalCode(district: number | null): string | null`
  - `districtLabel(district: number | null): string | null` — e.g. `"1060 Mariahilf"`

- [ ] **Step 1: Write the failing test**

Create `test/card.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, viennaPostalCode, districtLabel, VIENNA_DISTRICT_NAMES } from '../src/card.js';

test('escapeHtml escapes the three HTML-significant characters', () => {
  assert.equal(escapeHtml('Wohnung & Co <Neu>'), 'Wohnung &amp; Co &lt;Neu&gt;');
});

test('escapeHtml escapes ampersands before angle brackets, never double-escaping', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml leaves ordinary Austrian listing text untouched', () => {
  assert.equal(escapeHtml('Mariahilfer Straße 12/3'), 'Mariahilfer Straße 12/3');
});

test('viennaPostalCode derives the 4-digit code from a district number', () => {
  assert.equal(viennaPostalCode(1), '1010');
  assert.equal(viennaPostalCode(6), '1060');
  assert.equal(viennaPostalCode(23), '1230');
});

test('viennaPostalCode rejects districts outside 1-23 and null', () => {
  assert.equal(viennaPostalCode(0), null);
  assert.equal(viennaPostalCode(24), null);
  assert.equal(viennaPostalCode(null), null);
});

test('VIENNA_DISTRICT_NAMES covers all 23 districts', () => {
  assert.equal(VIENNA_DISTRICT_NAMES.length, 23);
  assert.equal(VIENNA_DISTRICT_NAMES[0], 'Innere Stadt');
  assert.equal(VIENNA_DISTRICT_NAMES[22], 'Liesing');
});

test('districtLabel pairs the postal code with the German district name', () => {
  assert.equal(districtLabel(6), '1060 Mariahilf');
  assert.equal(districtLabel(null), null);
  assert.equal(districtLabel(99), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern='escapeHtml'`

If that flag form is unsupported by the installed Node, run the whole suite: `npm test`

Expected: FAIL — `Cannot find module '../src/card.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/card.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`

Expected: the seven new tests PASS, and every pre-existing test still passes.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p .`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/card.ts test/card.test.ts
git commit -m "card: add HTML escaping and Vienna district helpers"
```

---

### Task 2: `formatCard` — the full card renderer

**Files:**
- Modify: `src/card.ts`
- Test: `test/card.test.ts`

**Interfaces:**
- Consumes: `escapeHtml`, `districtLabel` (Task 1); `ListingRow` from `../src/db.js`.
- Produces:
  - `CARD_MESSAGE_LIMIT = 4096`, `CARD_CAPTION_LIMIT = 1024`
  - `DESCRIPTION_SLICE = 200`
  - `interface CardLabels { petBadge, linkText, rooms, floor, availableFrom, valueGood, valueFair, valuePremium, lift, parking, energy, waitlistWarning, wgWarning, delistedWarning }` — all `string`
  - `DEFAULT_CARD_LABELS: CardLabels` (English, for pure tests)
  - `interface CardOptions { commuteLine?, prefix?, labels?, maxLength? }`
  - `formatCard(l: ListingRow, opts?: CardOptions): string`

`linkText` is a template containing `{source}`, substituted with the listing's source name.

- [ ] **Step 1: Write the failing tests**

Append to `test/card.test.ts`:

```ts
import { formatCard, CARD_CAPTION_LIMIT, CARD_MESSAGE_LIMIT, DEFAULT_CARD_LABELS } from '../src/card.js';
import type { ListingRow } from '../src/db.js';

function row(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Helle Garconniere',
    price: 800, pricePerSqm: 21, area: 38, rooms: 1, district: 6,
    isPrivate: true, images: [], description: null, url: 'https://willhaben.at/x/1',
    valueFlag: 'good', firstSeen: '2026-08-01T00:00:00.000Z',
    requiresWaitlistTicket: false, isWg: false, addressLine: null,
    lat: null, lon: null, isDelisted: false,
    lift: null, parkingSpaces: null, floor: null, energyClass: null,
    availableFrom: null, mentionsPets: false,
    ...overrides,
  };
}

test('formatCard renders the title bold on the first line', () => {
  const out = formatCard(row());
  assert.match(out.split('\n')[0], /^<b>.*Helle Garconniere.*<\/b>$/);
});

test('formatCard escapes HTML-significant characters in the title', () => {
  const out = formatCard(row({ title: 'Wohnung <neu> & schön' }));
  assert.ok(out.includes('Wohnung &lt;neu&gt; &amp; schön'));
  assert.ok(!out.includes('<neu>'), 'raw angle brackets must never survive into the output');
});

test('formatCard escapes the url inside the href attribute', () => {
  const out = formatCard(row({ url: 'https://willhaben.at/x?a=1&b=2' }));
  assert.ok(out.includes('href="https://willhaben.at/x?a=1&amp;b=2"'));
});

test('formatCard renders the location line as postal code plus district name', () => {
  assert.ok(formatCard(row()).includes('1060 Mariahilf'));
});

test('formatCard appends the address line to the location when present', () => {
  const out = formatCard(row({ addressLine: 'Mariahilfer Straße 12' }));
  assert.ok(out.includes('1060 Mariahilf'));
  assert.ok(out.includes('Mariahilfer Straße 12'));
});

test('formatCard falls back to the address alone when the district is unknown', () => {
  const out = formatCard(row({ district: null, addressLine: 'Testgasse 1' }));
  assert.ok(out.includes('Testgasse 1'));
  assert.ok(!out.includes('undefined'));
});

test('formatCard omits the location line entirely when district and address are both missing', () => {
  const out = formatCard(row({ district: null, addressLine: null }));
  assert.ok(!out.includes('📍'));
  assert.ok(!/\n\n\n/.test(out), 'omitted lines must not leave blank gaps');
});

test('formatCard renders price with price-per-sqm and the value badge', () => {
  const out = formatCard(row());
  assert.ok(out.includes('€800'));
  assert.ok(out.includes('€21/m²'));
  assert.ok(out.includes(DEFAULT_CARD_LABELS.valueGood));
});

test('formatCard omits price-per-sqm when it is unknown', () => {
  const out = formatCard(row({ pricePerSqm: null }));
  assert.ok(out.includes('€800'));
  assert.ok(!out.includes('/m²'));
});

test('formatCard renders each warning flag', () => {
  assert.ok(formatCard(row({ isWg: true })).includes(DEFAULT_CARD_LABELS.wgWarning));
  assert.ok(formatCard(row({ requiresWaitlistTicket: true })).includes(DEFAULT_CARD_LABELS.waitlistWarning));
  assert.ok(formatCard(row({ isDelisted: true })).includes(DEFAULT_CARD_LABELS.delistedWarning));
});

test('formatCard renders the pet badge only when the listing mentions pets', () => {
  assert.ok(formatCard(row({ mentionsPets: true })).includes(DEFAULT_CARD_LABELS.petBadge));
  assert.ok(!formatCard(row({ mentionsPets: false })).includes(DEFAULT_CARD_LABELS.petBadge));
});

test('formatCard renders the commute line when supplied', () => {
  const out = formatCard(row(), { commuteLine: '🚇 21 min to TU Wien' });
  assert.ok(out.includes('🚇 21 min to TU Wien'));
});

test('formatCard renders the description italic, sliced to 200 characters', () => {
  const out = formatCard(row({ description: 'x'.repeat(500) }));
  const match = out.match(/<i>(.*?)<\/i>/s);
  assert.ok(match, 'description must be wrapped in <i>');
  assert.ok(match[1].length <= 201, 'sliced description plus ellipsis stays within budget');
  assert.ok(match[1].endsWith('…'));
});

test('formatCard escapes the description before italicising it', () => {
  const out = formatCard(row({ description: 'Nähe <U4> & Park' }));
  assert.ok(out.includes('Nähe &lt;U4&gt; &amp; Park'));
});

test('formatCard omits the description block when there is no description', () => {
  assert.ok(!formatCard(row()).includes('<i>'));
});

test('formatCard renders the link as an anchor, never a bare url', () => {
  const out = formatCard(row());
  assert.ok(out.includes('<a href="https://willhaben.at/x/1">'));
  assert.ok(!/\n https:\/\//.test(out), 'the raw url must not appear as its own line');
});

test('formatCard respects the caption budget', () => {
  const out = formatCard(row({ title: 'T'.repeat(400), description: 'd'.repeat(2000) }),
    { maxLength: CARD_CAPTION_LIMIT });
  assert.ok(out.length <= CARD_CAPTION_LIMIT, `got ${out.length}`);
});

test('formatCard respects the message budget', () => {
  const out = formatCard(row({ title: 'T'.repeat(3000), description: 'd'.repeat(3000) }),
    { maxLength: CARD_MESSAGE_LIMIT });
  assert.ok(out.length <= CARD_MESSAGE_LIMIT, `got ${out.length}`);
});

test('formatCard never truncates inside a tag or an entity', () => {
  const out = formatCard(row({ title: 'A&B '.repeat(300), description: 'd'.repeat(2000) }),
    { maxLength: CARD_CAPTION_LIMIT });
  const opens = (out.match(/</g) ?? []).length;
  const closes = (out.match(/>/g) ?? []).length;
  assert.equal(opens, closes, 'every tag delimiter must be balanced');
  assert.ok(!/&[a-z]*$/.test(out), 'output must not end mid-entity');
});

test('formatCard prepends the prefix when supplied', () => {
  const out = formatCard(row(), { prefix: '❤️ 1 of 3\n\n' });
  assert.ok(out.startsWith('❤️ 1 of 3'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL — `formatCard` is not exported from `src/card.ts`.

- [ ] **Step 3: Write the implementation**

Append to `src/card.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: all `test/card.test.ts` tests PASS.

If the two budget tests fail by a handful of characters, the cause is that escaping expands the
shortened title (`&` becomes `&amp;`). Fix by shrinking against the *escaped* length: recompute
`overflow` from `build(shortTitle, null).length` in a loop of at most 5 iterations, not by
loosening the assertion.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p .`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/card.ts test/card.test.ts
git commit -m "card: add formatCard HTML renderer with length budgets"
```

---

### Task 3: Locale keys for the card and the export

**Files:**
- Modify: `src/locales/en.ts`, `src/locales/ru.ts`, `src/locales/de.ts`
- Test: `test/locales.test.ts` (already enforces parity — no new test needed beyond running it)

**Interfaces:**
- Consumes: nothing.
- Produces: the locale keys `card_link_text`, `card_rooms`, `card_floor`, `card_available_from`, `card_value_good`, `card_value_fair`, `card_value_premium`, `card_lift`, `card_parking`, `card_energy`, `btn_export_csv`, `export_caption`, `export_failed`.

The existing keys `pet_badge`, and the three warning strings currently hardcoded in `formatCaption`, are reused where they already exist; the warnings move into locale keys here as `card_warning_waitlist`, `card_warning_wg`, `card_warning_delisted`.

- [ ] **Step 1: Add the keys to English**

Append inside the default-exported object in `src/locales/en.ts`, before the closing `};`:

```ts
  card_link_text: 'Open on {source} ▸',
  card_rooms: 'rooms',
  card_floor: 'floor',
  card_available_from: 'from',
  card_value_good: '✅ good value',
  card_value_fair: 'fair price',
  card_value_premium: 'premium',
  card_lift: '🛗 Lift',
  card_parking: '🅿️ Parking',
  card_energy: '⚡ Energy',
  card_warning_waitlist: '⚠️ Municipal/waitlist housing — needs a Vormerkschein, Wohnticket, or Wiener Wohnen registration.',
  card_warning_wg: '🚪 WG — shared flat / co-living / student room, not a whole apartment.',
  card_warning_delisted: '⚠️ No longer listed — likely taken down by the advertiser.',
  btn_export_csv: '📤 Export CSV',
  export_caption: '{count} saved listings',
  export_failed: 'Could not build the export just now. Try again in a moment.',
```

- [ ] **Step 2: Add the same keys to Russian**

Append inside the default-exported object in `src/locales/ru.ts`:

```ts
  card_link_text: 'Смотреть на {source} ▸',
  card_rooms: 'комн.',
  card_floor: 'этаж',
  card_available_from: 'с',
  card_value_good: '✅ хорошая цена',
  card_value_fair: 'обычная цена',
  card_value_premium: 'дорого',
  card_lift: '🛗 Лифт',
  card_parking: '🅿️ Парковка',
  card_energy: '⚡ Энергокласс',
  card_warning_waitlist: '⚠️ Муниципальное жильё — нужен Vormerkschein, Wohnticket или регистрация в Wiener Wohnen.',
  card_warning_wg: '🚪 WG — комната в общей квартире или студенческом жилье, не отдельная квартира.',
  card_warning_delisted: '⚠️ Объявление снято — скорее всего, снял сам арендодатель.',
  btn_export_csv: '📤 Экспорт CSV',
  export_caption: 'Сохранённых объявлений: {count}',
  export_failed: 'Не удалось собрать файл. Попробуйте ещё раз через минуту.',
```

- [ ] **Step 3: Add the same keys to German**

Append inside the default-exported object in `src/locales/de.ts`:

```ts
  card_link_text: 'Auf {source} ansehen ▸',
  card_rooms: 'Zimmer',
  card_floor: 'Stock',
  card_available_from: 'ab',
  card_value_good: '✅ guter Preis',
  card_value_fair: 'fairer Preis',
  card_value_premium: 'gehoben',
  card_lift: '🛗 Lift',
  card_parking: '🅿️ Parkplatz',
  card_energy: '⚡ Energieklasse',
  card_warning_waitlist: '⚠️ Gemeindebau/Vormerkschein nötig — Wohnticket oder Wiener-Wohnen-Registrierung erforderlich.',
  card_warning_wg: '🚪 WG — Zimmer in einer Wohngemeinschaft, keine eigene Wohnung.',
  card_warning_delisted: '⚠️ Nicht mehr online — vermutlich vom Anbieter zurückgezogen.',
  btn_export_csv: '📤 CSV exportieren',
  export_caption: '{count} gespeicherte Inserate',
  export_failed: 'Der Export konnte nicht erstellt werden. Bitte gleich noch einmal versuchen.',
```

- [ ] **Step 4: Run the parity test**

Run: `npm test`

Expected: `test/locales.test.ts` PASSES. A failure here names the catalog missing a key — add it there rather than removing it from English.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p .`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/locales/
git commit -m "locales: add card and CSV-export strings in en/ru/de"
```

---

### Task 4: Migrate every caller to `formatCard`, delete `formatCaption`

Behaviour-preserving except that all card text now carries HTML markup. Buttons still ride on their own message for albums — that moves in Task 5. Splitting it this way keeps the risky layout change reviewable on its own.

**Files:**
- Modify: `src/bot.ts` (`formatCaption` at 178-215 removed; `sendCard` ~300; `sendShortlistBrowseCard` ~313; `deleteAndSendShortlistCard` ~421; `replaceShortlistCard` ~448)
- Modify: `src/notify.ts:121` (`sendInstantCard`)
- Test: `test/bot.test.ts`, `test/notify.test.ts`

**Interfaces:**
- Consumes: `formatCard`, `CardLabels`, `CARD_CAPTION_LIMIT`, `CARD_MESSAGE_LIMIT` (Task 2); locale keys (Task 3).
- Produces: `cardLabels(db: DB, chatId: number): CardLabels` exported from `src/bot.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `test/bot.test.ts`:

```ts
test('sendCard sends card text as HTML', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  upsertListing(db, listing({ id: '40', images: [] }));

  const { telegram, calls } = testTelegram();
  await sendCard(telegram, 1, getListingById(db, 'willhaben:40')!, null, db);

  const sent = calls.find((c) => c.method === 'sendMessage');
  assert.ok(sent, 'a no-photo listing sends as a message');
  assert.equal(sent.payload.parse_mode, 'HTML');
  assert.match(String(sent.payload.text), /<b>/);
});

test('sendCard disables the link preview so Telegram adds no extra image', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  upsertListing(db, listing({ id: '41', images: [] }));

  const { telegram, calls } = testTelegram();
  await sendCard(telegram, 1, getListingById(db, 'willhaben:41')!, null, db);

  const sent = calls.find((c) => c.method === 'sendMessage')!;
  assert.ok(
    sent.payload.link_preview_options !== undefined || sent.payload.disable_web_page_preview === true,
    'link preview must be suppressed',
  );
});

test('cardLabels resolves every label for the chat language', () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  const labels = cardLabels(db, 1);
  for (const [key, value] of Object.entries(labels)) {
    assert.equal(typeof value, 'string', `${key} must resolve to a string`);
    assert.ok(value.length > 0, `${key} must not be empty`);
  }
});
```

Add to `test/notify.test.ts`. This mirrors the existing passing test at `test/notify.test.ts:172`, so the fixture is known-good:

```ts
test('an instant alert sends its caption as HTML', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db,
    [row({ id: 'willhaben:new', valueFlag: 'good', images: ['https://cdn/a.jpg'] })], NOW_MIDDAY);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendPhoto');
  assert.equal(calls[0].payload.parse_mode, 'HTML');
  assert.match(String(calls[0].payload.caption), /<b>/);
});
```

`row`, `seedHistory`, `commuteProfilePrefs`, `testTelegram`, and `NOW_MIDDAY` are all already defined in that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL — `cardLabels` is not exported, and `parse_mode` is absent from the payloads.

- [ ] **Step 3: Add `cardLabels` to `src/bot.ts`**

Add near the other helpers, and add `formatCard`, `type CardLabels`, `CARD_CAPTION_LIMIT`, `CARD_MESSAGE_LIMIT` to the imports from `./card.js`:

```ts
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

/** Extra fields every HTML card send needs: markup mode, and no auto-preview competing with the photos. */
export const HTML_SEND_EXTRA = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
```

- [ ] **Step 4: Delete `formatCaption` and update its call sites**

Remove the whole `formatCaption` function (`src/bot.ts:178-215`) along with `MAX_CAPTION_LENGTH`, `truncate`, and `DEFAULT_PET_BADGE_TEXT` if nothing else uses them (check with `grep -n 'truncate\|MAX_CAPTION_LENGTH\|DEFAULT_PET_BADGE_TEXT' src/*.ts`).

In `sendCard`, replace the caption line:

```ts
  const caption = formatCard(card, {
    commuteLine, labels: cardLabels(db, chatId), maxLength: CARD_CAPTION_LIMIT,
  });
```

In `sendShortlistBrowseCard`, `deleteAndSendShortlistCard`'s caller, and `replaceShortlistCard`, replace each `formatCaption(card, null, prefix, ...)` with:

```ts
  const caption = formatCard(card, {
    prefix, labels: cardLabels(db, chatId), maxLength: CARD_CAPTION_LIMIT,
  });
```

Add `...HTML_SEND_EXTRA` to every `sendPhoto`, `sendMessage`, `editMessageCaption`, `editMessageText`, and `editMessageMedia` call that carries card text. For `editMessageMedia` the mode goes inside the media object: `{ type: 'photo', media, caption, parse_mode: 'HTML' }`.

- [ ] **Step 5: Update `src/notify.ts:121`**

Replace the `formatCaption` import with `formatCard`, import `cardLabels` from `./bot.js`, and rewrite the caption line:

```ts
  const caption = formatCard(listing, {
    prefix: `${header}\n\n`, labels: cardLabels(db, profile.chatId), maxLength: CARD_CAPTION_LIMIT,
  });
```

Add `...HTML_SEND_EXTRA` to both the `sendPhotoCached` extra and the `sendMessage` call in that function.

- [ ] **Step 6: Update existing tests that referenced `formatCaption`**

Run: `grep -rn 'formatCaption' test/ src/`

Every hit must go. Tests asserting on plain-text card output need their expectations updated to the HTML form — assert on the escaped/marked-up substring, not on the old bare text.

- [ ] **Step 7: Run the full suite**

Run: `npm test`

Expected: PASS, including the three new tests from Step 1.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit -p .`

Expected: no errors. A `formatCaption` reference surviving anywhere fails here.

- [ ] **Step 9: Commit**

```bash
git add src/ test/
git commit -m "card: route every card through formatCard and send as HTML"
```

---

### Task 5: Move the swipe buttons onto the listing message

**Files:**
- Modify: `src/bot.ts` — `sendListingCard` (~264-297), `sendCard` (~300)
- Test: `test/bot.test.ts`

**Interfaces:**
- Consumes: `formatCard`, `HTML_SEND_EXTRA`, `cardLabels` (Task 4).
- Produces: no new exports. `sendListingCard`'s `groupPromptText` parameter is removed.

- [ ] **Step 1: Write the failing tests**

Add to `test/bot.test.ts`:

```ts
test('a multi-photo card sends the album without a caption', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  upsertListing(db, listing({ id: '50', images: ['https://cdn/a.jpg', 'https://cdn/b.jpg'] }));

  const { telegram, calls } = testTelegram();
  await sendCard(telegram, 1, getListingById(db, 'willhaben:50')!, null, db);

  const album = calls.find((c) => c.method === 'sendMediaGroup')!;
  const media = album.payload.media as { caption?: string }[];
  assert.ok(media.every((m) => m.caption === undefined), 'album items must carry no caption');
});

test('a multi-photo card puts the listing text and the buttons on one message', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  upsertListing(db, listing({ id: '51', title: 'Helle Garconniere', images: ['https://cdn/a.jpg', 'https://cdn/b.jpg'] }));

  const { telegram, calls } = testTelegram();
  await sendCard(telegram, 1, getListingById(db, 'willhaben:51')!, null, db);

  const follow = calls.find((c) => c.method === 'sendMessage')!;
  assert.match(String(follow.payload.text), /Helle Garconniere/);
  assert.equal(follow.payload.parse_mode, 'HTML');
  const markup = follow.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  const data = markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.some((d) => d.startsWith('like:')), 'the like button rides the listing message');
  assert.ok(data.some((d) => d.startsWith('pass:')), 'the pass button rides the listing message');
});

test('the old placeholder prompt is no longer sent for an album', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  upsertListing(db, listing({ id: '52', images: ['https://cdn/a.jpg', 'https://cdn/b.jpg'] }));

  const { telegram, calls } = testTelegram();
  await sendCard(telegram, 1, getListingById(db, 'willhaben:52')!, null, db);

  assert.ok(!calls.some((c) => c.payload.text === SWIPE_PROMPT_TEXT),
    'the contentless "👍 or 👎?" message is gone');
});

test('a formatted send that Telegram rejects retries once as plain text', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  upsertListing(db, listing({ id: '53', images: ['https://cdn/a.jpg', 'https://cdn/b.jpg'] }));

  let firstMessage = true;
  const { telegram, calls } = testTelegram((method) => {
    if (method === 'sendMessage' && firstMessage) {
      firstMessage = false;
      return new Error("400: Bad Request: can't parse entities");
    }
    return undefined;
  });

  await sendCard(telegram, 1, getListingById(db, 'willhaben:53')!, null, db);

  const messages = calls.filter((c) => c.method === 'sendMessage');
  assert.equal(messages.length, 2, 'the rejected send is retried exactly once');
  assert.equal(messages[1].payload.parse_mode, undefined, 'the retry carries no parse_mode');
  assert.ok(messages[1].payload.reply_markup, 'the retry keeps the buttons');
});
```

Also add a test for the retry's text conversion, which Task 5 exports:

```ts
test('stripHtml turns a card back into readable plain text', () => {
  const html = '<b>Wohnung &amp; Co</b>\n📍 1060 Mariahilf\n<a href="https://x/1">Open on willhaben ▸</a>';
  const out = stripHtml(html);
  assert.equal(out, 'Wohnung & Co\n📍 1060 Mariahilf\nOpen on willhaben ▸: https://x/1');
  assert.ok(!out.includes('<'), 'no tags survive');
});
```

Import `SWIPE_PROMPT_TEXT` and `stripHtml` in the test file if they are not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL — the album still carries a caption and the placeholder message is still sent.

- [ ] **Step 3: Rewrite `sendListingCard`**

Replace the body of `sendListingCard` in `src/bot.ts`. Drop the `groupPromptText` parameter and update `sendCard`'s call accordingly:

```ts
/**
 * Low-level: sends a listing as photo album / single photo / text, with the given inline buttons.
 *
 * Telegram forbids reply_markup on sendMediaGroup, so an album's buttons must live on a following
 * message. That message now carries the card text too, rather than a contentless "👍 or 👎?" — which
 * both attaches the controls to real content and lifts the text out of the 1024-char caption cap.
 *
 * Because that second message now holds the listing facts, losing it loses the card. It therefore
 * gets one plain-text retry: a malformed entity is overwhelmingly the likeliest rejection, and
 * dropping parse_mode recovers it without resending the album.
 *
 * `now` is injected rather than read from the wall clock because two separate decisions here depend
 * on it — which urls are still suppressed, and (inside sendPhotoCached) whether a cached file_id is
 * still good — and a test cannot pin either against a moving clock.
 */
async function sendListingCard(
  telegram: Telegraf['telegram'], chatId: number, card: ListingRow, cardText: string,
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
      await sendCardTextWithButtons(telegram, chatId, cardText, buttons);
      return;
    }
  }

  if (images.length >= 1) {
    await sendPhotoCached(telegram, db, chatId, images[0], cardText, { ...buttons, ...HTML_SEND_EXTRA }, now);
    return;
  }

  await sendCardTextWithButtons(telegram, chatId, cardText, buttons);
}

/** Sends card text with its keyboard, retrying once unformatted if Telegram rejects the markup. */
async function sendCardTextWithButtons(
  telegram: Telegraf['telegram'], chatId: number, cardText: string,
  buttons: ReturnType<typeof Markup.inlineKeyboard>,
): Promise<void> {
  try {
    await telegram.sendMessage(chatId, cardText, { ...buttons, ...HTML_SEND_EXTRA });
  } catch (err) {
    console.error('bot: formatted card send failed, retrying as plain text:', err);
    try {
      await telegram.sendMessage(chatId, stripHtml(cardText), { ...buttons });
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
```

- [ ] **Step 4: Update `buildMediaGroup` to take no caption**

```ts
/** Pure — builds a sendMediaGroup payload, capped to Telegram's limit. Carries no caption: an album's text now lives on the following message, which is the only one that can hold buttons. */
export function buildMediaGroup(images: string[]): MediaGroupItem[] {
  return images.slice(0, MAX_MEDIA_GROUP_ITEMS).map((url) => ({ type: 'photo' as const, media: url }));
}
```

Update `sendCard` to build its text with `maxLength: CARD_MESSAGE_LIMIT` when the listing has 2+ usable photos and `CARD_CAPTION_LIMIT` otherwise — the album path is the only one whose text becomes a standalone message:

```ts
  const images = usablePhotoUrls(db, card.images, now);
  const maxLength = images.length >= 2 ? CARD_MESSAGE_LIMIT : CARD_CAPTION_LIMIT;
  const cardText = formatCard(card, { commuteLine, labels: cardLabels(db, chatId), maxLength });
```

Fix `buildMediaGroup`'s existing tests in `test/bot.test.ts` — the two-argument calls no longer typecheck, and any assertion on `media[0].caption` now asserts `undefined`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: PASS. `SWIPE_PROMPT_TEXT` and `appendSwipeStatus` remain exported and tested — they still serve cards sent before this deploy.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p .`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/bot.ts test/bot.test.ts
git commit -m "bot: attach swipe buttons to the listing message, not a placeholder"
```

---

### Task 6: Rebuild swipe status from the database

**Files:**
- Modify: `src/bot.ts` — `clearSwipedCardButtons` (~380-401) and its call sites
- Test: `test/bot.test.ts`

**Interfaces:**
- Consumes: `formatCard`, `cardLabels`, `HTML_SEND_EXTRA` (Task 4); `getListingById` (already imported in `bot.ts`).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Add to `test/bot.test.ts`:

```ts
test('swiping a card re-renders its text from the database, keeping the markup', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  upsertListing(db, listing({ id: '60', title: 'Wohnung & Co', images: [] }));
  const { bot, calls } = createTestBot(db);

  await bot.handleUpdate({
    update_id: 1,
    callback_query: {
      id: 'cb1', from: { id: 1, is_bot: false, first_name: 'T' },
      message: { message_id: 7, date: 0, chat: { id: 1, type: 'private' }, text: 'stale plain text' },
      chat_instance: 'x', data: 'like:willhaben:60',
    },
  } as never);

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'the swiped card is edited in place');
  assert.equal(edit.payload.parse_mode, 'HTML');
  assert.match(String(edit.payload.text), /Wohnung &amp; Co/,
    'text is re-rendered from the DB and escaped, not echoed back from message.text');
  assert.ok(!String(edit.payload.text).includes('stale plain text'));
});
```

`createTestBot(db)` is defined at `test/bot.test.ts:311` and returns `{ bot, calls }` — it takes the db and does not return one. Match the callback-query update shape already used by that file's other callback tests.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`

Expected: FAIL — the edit echoes `message.text` and carries no `parse_mode`.

- [ ] **Step 3: Rewrite `clearSwipedCardButtons`**

```ts
/**
 * Clears the buttons on the message a swipe/remove callback came from, replacing its text/caption with
 * the card plus a short status line — otherwise Telegram leaves the 👍👎/🗑️ buttons live forever, and an
 * old card in chat history stays tappable.
 *
 * The text is re-rendered from the database rather than read back from `message.text`, because
 * Telegram returns that field with all markup stripped: echoing it back under parse_mode would drop
 * the formatting and would fail outright on a title containing a bare `&`. Cards sent before this
 * change (and any listing since deleted) have no DB row to re-render, so those fall back to the
 * original append-to-plain-text behaviour.
 *
 * Best-effort throughout: editing can fail (message too old, deleted, already edited), which must
 * never block sending the next card.
 */
async function clearSwipedCardButtons(
  ctx: {
    callbackQuery?: { message?: unknown; data?: string };
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

  const listing = listingId != null ? getListingById(db, listingId) : null;
  const keyboard = Markup.inlineKeyboard(undoButton ? [undoButton] : []);

  try {
    if (listing != null) {
      const limit = message.photo ? CARD_CAPTION_LIMIT : CARD_MESSAGE_LIMIT;
      const rendered = formatCard(listing, { labels: cardLabels(db, chatId), maxLength: limit - status.length - 2 });
      const text = `${rendered}\n\n${status}`;
      const extra = { ...keyboard, ...HTML_SEND_EXTRA };
      if (message.photo) await ctx.editMessageCaption(text, extra);
      else await ctx.editMessageText(text, extra);
      return;
    }
    // Pre-deploy card, or a listing no longer in the DB: keep the original plain-text behaviour.
    if (message.photo) await ctx.editMessageCaption(appendSwipeStatus(message.caption ?? '', status), { ...keyboard });
    else if (message.text) await ctx.editMessageText(appendSwipeStatus(message.text, status), { ...keyboard });
  } catch {
    // best-effort — see doc comment above
  }
}
```

- [ ] **Step 4: Update every call site**

Run: `grep -n 'clearSwipedCardButtons' src/bot.ts`

Each caller already has the listing id in scope (it parsed the callback data to route the action). Pass `db`, `chatId`, and that id through. Where a caller genuinely has no id, pass `null`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: PASS, including the tests covering the pre-deploy fallback path (`appendSwipeStatus` behaviour must remain green).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p .`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/bot.ts test/bot.test.ts
git commit -m "bot: re-render swiped cards from the database instead of message text"
```

---

### Task 7: `getShortlistForExport`

**Files:**
- Modify: `src/db.ts` (beside `getShortlist` at ~771)
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: `ListingRow`, `rowToListing` (both already in `db.ts`).
- Produces:
  - `interface ShortlistExportRow { listing: ListingRow; savedAt: string }`
  - `getShortlistForExport(db: DB, chatId: number): ShortlistExportRow[]`

- [ ] **Step 1: Write the failing test**

Add to `test/db.test.ts`:

```ts
test('getShortlistForExport returns each saved listing with its saved_at timestamp', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: '70' }));
  upsertListing(db, listing({ id: '71' }));
  // recordSwipe stamps saved_at from the wall clock (src/db.ts:733), so two likes in the same
  // millisecond would make the ordering assertion below flaky. Inserting directly pins both.
  db.prepare('INSERT INTO shortlist (chat_id, listing_id, saved_at) VALUES (?, ?, ?)')
    .run(1, 'willhaben:70', '2026-08-01T10:00:00.000Z');
  db.prepare('INSERT INTO shortlist (chat_id, listing_id, saved_at) VALUES (?, ?, ?)')
    .run(1, 'willhaben:71', '2026-08-02T10:00:00.000Z');

  const rows = getShortlistForExport(db, 1);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].listing.id, 'willhaben:71', 'newest-liked first, matching getShortlist');
  assert.equal(rows[0].savedAt, '2026-08-02T10:00:00.000Z');
  assert.equal(rows[1].savedAt, '2026-08-01T10:00:00.000Z');
});

test('getShortlistForExport agrees with getShortlist on ordering', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: '72' }));
  upsertListing(db, listing({ id: '73' }));
  recordSwipe(db, 1, 'willhaben:72', 'like');
  recordSwipe(db, 1, 'willhaben:73', 'like');

  const exported = getShortlistForExport(db, 1).map((r) => r.listing.id);
  assert.deepEqual(exported, getShortlist(db, 1).map((l) => l.id));
});

test('getShortlistForExport returns an empty array for a chat with no likes', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getShortlistForExport(db, 99), []);
});
```

`recordSwipe(db, chatId, listingId, direction)` takes four arguments and stamps its own timestamp
(`src/db.ts:732`) — it has no clock parameter. `listing()` in `test/db.test.ts:24` builds a
`NormalizedListing` whose `id: '70'` becomes `'willhaben:70'` once stored.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`

Expected: FAIL — `getShortlistForExport` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/db.ts` directly below `getShortlist`:

```ts
/** One shortlist entry plus the moment it was saved — the extra column the CSV export needs and the browse UI does not. */
export interface ShortlistExportRow {
  listing: ListingRow;
  savedAt: string;
}

/**
 * Shortlist rows carrying saved_at, for CSV export. A sibling of getShortlist rather than a change
 * to it: every browse call site wants a bare ListingRow, and widening that return type would ripple
 * through all of them for one consumer's benefit. Ordering matches getShortlist exactly, including
 * the rowid tiebreak, so an export and the browse deck never disagree about what "first" means.
 */
export function getShortlistForExport(db: DB, chatId: number): ShortlistExportRow[] {
  const rows = db.prepare(`
    SELECT l.*, s.saved_at AS saved_at FROM shortlist s JOIN listings l ON l.id = s.listing_id
    WHERE s.chat_id = ? ORDER BY s.saved_at DESC, s.rowid DESC
  `).all(chatId) as Record<string, unknown>[];
  return rows.map((r) => ({ listing: rowToListing(r), savedAt: String(r.saved_at) }));
}
```

If the `listings` table ever gains its own `saved_at` column the alias above would collide; it does not today (see the schema at `src/db.ts:46`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p .`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "db: add getShortlistForExport carrying saved_at"
```

---

### Task 8: `toCsv`

**Files:**
- Create: `src/export.ts`
- Test: `test/export.test.ts`

**Interfaces:**
- Consumes: `ShortlistExportRow` (Task 7).
- Produces:
  - `CSV_DELIMITER = ';'`, `UTF8_BOM = '﻿'`
  - `CSV_COLUMNS: readonly string[]`
  - `toCsv(rows: ShortlistExportRow[]): string`
  - `exportFilename(now: Date): string`

- [ ] **Step 1: Write the failing tests**

Create `test/export.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, exportFilename, CSV_COLUMNS, UTF8_BOM } from '../src/export.js';
import type { ListingRow, ShortlistExportRow } from '../src/db.js';

function row(overrides: Partial<ListingRow> = {}, savedAt = '2026-08-02T10:00:00.000Z'): ShortlistExportRow {
  return {
    savedAt,
    listing: {
      id: 'willhaben:1', source: 'willhaben', title: 'Helle Garconniere',
      price: 800, pricePerSqm: 21, area: 38, rooms: 1, district: 6,
      isPrivate: true, images: [], description: null, url: 'https://willhaben.at/x/1',
      valueFlag: 'good', firstSeen: '2026-08-01T00:00:00.000Z',
      requiresWaitlistTicket: false, isWg: false, addressLine: 'Testgasse 1',
      lat: null, lon: null, isDelisted: false,
      lift: null, parkingSpaces: null, floor: null, energyClass: null,
      availableFrom: null, mentionsPets: false,
      ...overrides,
    },
  };
}

test('toCsv starts with a single UTF-8 BOM', () => {
  const out = toCsv([row()]);
  assert.ok(out.startsWith(UTF8_BOM));
  assert.equal(out.split(UTF8_BOM).length - 1, 1, 'exactly one BOM, at the start');
});

test('toCsv writes the documented header row, semicolon-delimited', () => {
  const header = toCsv([]).slice(UTF8_BOM.length).split('\n')[0];
  assert.equal(header, CSV_COLUMNS.join(';'));
});

test('toCsv quotes fields containing the delimiter and doubles internal quotes', () => {
  const out = toCsv([row({ title: 'Flat; "quiet" yard' })]);
  assert.ok(out.includes('"Flat; ""quiet"" yard"'));
});

test('toCsv quotes fields containing newlines', () => {
  const out = toCsv([row({ addressLine: 'Line1\nLine2' })]);
  assert.ok(out.includes('"Line1\nLine2"'));
});

test('toCsv renders nulls as empty fields, never the string null', () => {
  const out = toCsv([row({ price: null, floor: null })]);
  assert.ok(!out.includes('null'));
  assert.ok(out.includes(';;'), 'a null field is empty between two delimiters');
});

test('toCsv renders booleans as true/false', () => {
  const out = toCsv([row({ isWg: true, mentionsPets: false })]);
  const dataRow = out.slice(UTF8_BOM.length).split('\n')[1];
  assert.ok(dataRow.includes('true'));
  assert.ok(dataRow.includes('false'));
});

test('toCsv emits one data row per shortlist entry, in the order given', () => {
  const out = toCsv([row({ id: 'a', title: 'First' }), row({ id: 'b', title: 'Second' })]);
  const lines = out.slice(UTF8_BOM.length).trimEnd().split('\n');
  assert.equal(lines.length, 3, 'header plus two data rows');
  assert.ok(lines[1].includes('First'));
  assert.ok(lines[2].includes('Second'));
});

test('toCsv includes saved_at from the export row, not from the listing', () => {
  const out = toCsv([row({}, '2026-08-24T09:30:00.000Z')]);
  assert.ok(out.includes('2026-08-24T09:30:00.000Z'));
});

test('exportFilename is date-stamped from the injected clock', () => {
  assert.equal(exportFilename(new Date('2026-08-24T22:15:00.000Z')), 'shortlist-2026-08-24.csv');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL — `Cannot find module '../src/export.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/export.ts`:

```ts
import type { ShortlistExportRow } from './db.js';

/**
 * Semicolon, not comma. Excel under a German/Austrian locale reads `,` as the decimal separator and
 * drops a comma-delimited file into a single column — which is where this file is going to be opened.
 */
export const CSV_DELIMITER = ';';

/** Without this, the same Excel renders "Mariahilferstraße" as "MariahilferstraÃŸe". */
export const UTF8_BOM = '﻿';

/** Column order is part of the format: users build sheets on top of it. Headers stay English in every locale. */
export const CSV_COLUMNS: readonly string[] = [
  'title', 'price', 'area_sqm', 'rooms', 'price_per_sqm', 'district', 'address',
  'source', 'value_flag', 'is_private', 'lift', 'parking_spaces', 'floor', 'energy_class',
  'available_from', 'mentions_pets', 'is_wg', 'requires_waitlist_ticket', 'is_delisted',
  'first_seen', 'saved_at', 'url',
];

/** RFC 4180: quote when the field contains the delimiter, a quote, or a line break; double internal quotes. */
function csvField(value: string | number | boolean | null): string {
  if (value == null) return '';
  const s = String(value);
  if (s.includes(CSV_DELIMITER) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Renders shortlist rows as Excel-compatible CSV. Pure — the caller supplies the rows and stamps the filename. */
export function toCsv(rows: ShortlistExportRow[]): string {
  const lines = [CSV_COLUMNS.join(CSV_DELIMITER)];
  for (const { listing: l, savedAt } of rows) {
    lines.push([
      l.title, l.price, l.area, l.rooms, l.pricePerSqm, l.district, l.addressLine,
      l.source, l.valueFlag, l.isPrivate, l.lift, l.parkingSpaces, l.floor, l.energyClass,
      l.availableFrom, l.mentionsPets, l.isWg, l.requiresWaitlistTicket, l.isDelisted,
      l.firstSeen, savedAt, l.url,
    ].map(csvField).join(CSV_DELIMITER));
  }
  return `${UTF8_BOM}${lines.join('\n')}\n`;
}

/** `shortlist-2026-08-24.csv` — the clock is injected so the name is pinnable in a test. */
export function exportFilename(now: Date): string {
  return `shortlist-${now.toISOString().slice(0, 10)}.csv`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS. The `CSV_COLUMNS.length` must equal the number of fields pushed per row — a mismatch shows up as a shifted header in the "one data row per entry" test.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p .`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/export.ts test/export.test.ts
git commit -m "export: render the shortlist as Excel-compatible CSV"
```

---

### Task 9: Wire the export into `/export` and the shortlist card

**Files:**
- Modify: `src/bot.ts` — `BOT_COMMANDS` (~39-47), `sendShortlistTo` (~490), `shortlistNavButtons` (~236), the callback router
- Test: `test/bot.test.ts`

**Interfaces:**
- Consumes: `toCsv`, `exportFilename` (Task 8); `getShortlistForExport` (Task 7); locale keys (Task 3).
- Produces: `sendShortlistCsv(telegram, chatId, db, now): Promise<void>`, exported for testing.

- [ ] **Step 1: Write the failing tests**

Add to `test/bot.test.ts`:

```ts
test('sendShortlistCsv sends a date-stamped document with a caption', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  upsertListing(db, listing({ id: '80' }));
  recordSwipe(db, 1, 'willhaben:80', 'like');

  const { telegram, calls } = testTelegram();
  await sendShortlistCsv(telegram, 1, db, new Date('2026-08-24T22:15:00.000Z'));

  const doc = calls.find((c) => c.method === 'sendDocument');
  assert.ok(doc, 'the export is delivered as a document');
  const payload = doc.payload.document as { filename: string; source: Buffer };
  assert.equal(payload.filename, 'shortlist-2026-08-24.csv');
  assert.match(payload.source.toString('utf8'), /^﻿title;/);
  assert.ok(String(doc.payload.caption).includes('1'), 'caption reports the row count');
});

test('sendShortlistCsv replies with the empty-state text instead of an empty file', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());

  const { telegram, calls } = testTelegram();
  await sendShortlistCsv(telegram, 1, db, new Date('2026-08-24T22:15:00.000Z'));

  assert.ok(!calls.some((c) => c.method === 'sendDocument'), 'no file for an empty shortlist');
  assert.ok(calls.some((c) => c.method === 'sendMessage'));
});

test('the shortlist browse card offers an export button', () => {
  const buttons = shortlistNavButtons('willhaben:80', 1, 1, '📤 Export CSV');
  const data = (buttons.reply_markup.inline_keyboard as { callback_data?: string }[][])
    .flat().map((b) => b.callback_data);
  assert.ok(data.includes('slexport'), 'an export button is present on the browse card');
});

test('/export is registered as a bot command', () => {
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'export'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL — `sendShortlistCsv` is not exported and `shortlistNavButtons` takes three arguments.

- [ ] **Step 3: Implement `sendShortlistCsv`**

Add to `src/bot.ts`, importing `toCsv`/`exportFilename` from `./export.js` and `getShortlistForExport` from `./db.js`:

```ts
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
```

- [ ] **Step 4: Add the export button to the browse card**

Give `shortlistNavButtons` a fourth parameter and a second row, so the nav row keeps its shape:

```ts
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
```

Update every caller (`grep -n 'shortlistNavButtons' src/ test/`) to pass `t(db, chatId, 'btn_export_csv')`.

- [ ] **Step 5: Register the command and the callback**

Add to `BOT_COMMANDS`, after the `shortlist` entry:

```ts
  { command: 'export', description: 'Export your shortlist as a CSV file' },
```

Register the handler beside `bot.command('shortlist', ...)` (~855):

```ts
  bot.command('export', async (ctx) => {
    const chatId = ctx.chat.id;
    await sendShortlistCsv(ctx.telegram, chatId, db);
  });
```

In the callback-query router, handle `slexport` alongside the existing `slnav:` handling — answer the callback query first (Telegram shows a spinner until you do), then send the file:

```ts
    if (data === 'slexport') {
      await ctx.answerCbQuery();
      await sendShortlistCsv(ctx.telegram, chatId, db);
      return;
    }
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p .`

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/bot.ts test/bot.test.ts
git commit -m "bot: export the shortlist as CSV via /export and a browse-card button"
```

---

### Task 10: Full verification

No new code. This task exists because the previous nine each verified only their own slice.

**Files:** none modified unless a failure is found.

- [ ] **Step 1: Run swipe-bot's suite**

Run: `npm test`

Expected: all PASS.

- [ ] **Step 2: Run apt-hunter's suite**

Run: `cd ../apt-hunter && npm test && cd ../swipe-bot`

Expected: PASS, unchanged by this work — `apt-hunter` is untouched, and this confirms no cross-workspace regression via the shared workspace install.

- [ ] **Step 3: Typecheck both workspaces**

```bash
npx tsc --noEmit -p .
(cd ../apt-hunter && npx tsc --noEmit -p .)
```

Expected: no errors.

- [ ] **Step 4: Confirm the build produces a runnable bundle**

Run: `npm run build`

Expected: `tsc` exits cleanly and `dist/index.js`, `dist/card.js`, `dist/export.js` exist.

- [ ] **Step 5: Confirm no dead references survive**

```bash
grep -rn 'formatCaption\|MAX_CAPTION_LENGTH' src/ test/ || echo "clean"
```

Expected: `clean`. `SWIPE_PROMPT_TEXT` and `appendSwipeStatus` SHOULD still appear — they serve cards sent before this deploy.

- [ ] **Step 6: Report status**

Summarise for the human partner: tests passing, what changed, and that deployment to `swipe-bot-vm` has not been done. Do not push and do not deploy — both need explicit go-ahead.

---

## Deployment (only on explicit go-ahead)

Not part of the implementation tasks. When the human partner approves, the sequence used by every prior plan in this repo is:

```bash
git push origin HEAD

gcloud compute ssh swipe-bot-vm --project austria-swipe-bot --zone us-central1-a --command \
  "cd ~/austria-apartment-hunt && git pull && (cd swipe-bot && npm install && npm run build) && sudo systemctl restart swipe-bot"

gcloud compute ssh swipe-bot-vm --project austria-swipe-bot --zone us-central1-a --command \
  "sudo systemctl status swipe-bot --no-pager | head -8 && tail -5 ~/swipe-bot.log"
```

Then verify by hand in Telegram: `/next` renders a bold title with a working link and buttons on the listing message; swiping keeps the formatting; `/export` delivers a CSV that opens correctly in Excel with umlauts intact.
