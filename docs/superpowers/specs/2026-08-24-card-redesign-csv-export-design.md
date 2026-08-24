# Card redesign, inline swipe buttons, and shortlist CSV export

Date: 2026-08-24

## Problem

Three complaints about the swipe deck, all visible in one screenshot of a live card:

1. **The 👍/👎 buttons hang off a separate message.** A multi-photo listing goes
   out as `sendMediaGroup` with the caption attached to the first item, then a
   second message carrying only the placeholder text `👍 or 👎?` and the inline
   keyboard. The buttons are visually detached from the listing they act on.
   This is not an oversight — Telegram rejects `reply_markup` on
   `sendMediaGroup` — but the current workaround puts the controls on a message
   that says nothing about the apartment.

2. **The card is an undifferentiated block of text.** `formatCaption` emits
   plain text with no markup, so the title, the price line, and the raw URL all
   render at the same weight. The unshortened willhaben URL alone wraps to four
   lines, dominating the card.

3. **There is no way to get the shortlist out of Telegram.** `/shortlist`
   browses one card at a time; nothing exports the set for comparison in a
   spreadsheet or for sending to someone else.

## Constraints that shape the solution

- **No inline keyboard on an album.** Telegram's Bot API permits `reply_markup`
  on `sendPhoto` and `sendMessage`, never on `sendMediaGroup`.
- **Caption length is 1024; message length is 4096.** `MAX_CAPTION_LENGTH` in
  `bot.ts` already encodes the former. Moving the card text out of the caption
  and into its own message raises the ceiling fourfold.
- **Listing text is attacker-adjacent input.** `title`, `addressLine`,
  `description`, and `floor` come from willhaben and ImmoScout verbatim and do
  contain `&` and `<`. Any markup mode makes escaping mandatory: an unescaped
  entity means `400: can't parse entities` and the card silently never arrives.
- **Telegram strips markup from `message.text`.** A callback handler reading
  `ctx.callbackQuery.message.text` gets the *rendered* text, without entities.
  Re-sending that string with `parse_mode` set loses all formatting and can
  fail outright on a bare `&`.
- **Three locales, enforced by a parity test.** `test/locales.test.ts` asserts
  key parity across `en`/`ru`/`de`, so every new user-facing string lands in all
  three catalogs.

## Decisions

### 1. Card rendering moves to `src/card.ts`

A new module owns card text; `formatCaption` is deleted and its two call sites
(`bot.ts`'s `sendCard`, `notify.ts:121`'s instant alert) move to the new
function. Keeping one renderer matters: the alternative is a bot whose push
notifications and pull cards drift into two different formats.

```ts
export interface CardOptions {
  commuteLine?: string | null;
  prefix?: string;
  petBadgeText?: string;
  maxLength?: number;   // 4096 for a standalone message, 1024 for a caption
}

export function formatCard(l: ListingRow, opts?: CardOptions): string
export function escapeHtml(s: string): string
```

`parse_mode: 'HTML'`, not `MarkdownV2`. MarkdownV2 requires escaping 18
characters, several of which (`-`, `.`, `(`, `!`) are routine in Austrian
listing titles and addresses; HTML needs exactly three (`&`, `<`, `>`) and is
far harder to get subtly wrong.

Rendered structure, each line omitted when its data is null:

| Line | Content | Markup |
|---|---|---|
| Title | `l.title` | `<b>`, escaped |
| Location | postal code + district name, then `l.addressLine` when present (see *District naming*) | escaped |
| Price | `€800 · €21/m²` + value flag badge | plain |
| Size | `38 m² · 1 room · floor 3` | plain |
| Amenities | lift, parking, energy class, available-from | escaped |
| Commute | existing `commuteLine`, unchanged | plain |
| Warnings | waitlist / WG / delisted, as today | plain |
| Pets | existing hedged badge | plain |
| Description | first 200 chars, ellipsised | `<i>`, escaped |
| Link | `Open on willhaben ▸` | `<a href>`, URL attribute-escaped |

**District naming.** `ListingRow` carries `district: number | null` and nothing
else — there is no postal code field and no district-name table anywhere in the
repo (`normalize.ts:121` only parses the number *out* of willhaben's string).
The location line therefore needs both derived in `card.ts`:

- Postal code by formula: `1000 + district * 10`, valid for districts 1–23
  (district 6 → `1060`). Rendered only when `district` is in that range.
- Name from a `VIENNA_DISTRICT_NAMES` constant — a frozen 23-entry array
  (`Innere Stadt`, `Leopoldstadt`, … `Liesing`). Names stay German in every
  locale: they are proper nouns that users will match against listing sites and
  street signs.

When `district` is null the line falls back to `addressLine` alone, and is
omitted entirely when both are missing.

The description slice is a fixed 200 characters, ellipsised, measured before
markup is applied.

The link becomes anchor text, which removes the four-line raw URL. Sends set
`link_preview_options: { is_disabled: true }` so Telegram does not append its
own preview image below an album that already carries ten photos.

Truncation stays a whole-string operation as today, but must never cut inside a
tag or an entity. Simplest correct approach: build the description slice to fit
the budget *before* assembling markup, so the assembled string is short by
construction; assert the final length in tests rather than post-hoc slicing
HTML.

### 2. Buttons move onto the listing message

`sendListingCard` (`bot.ts:264`) changes only its album branch:

| Photos | Today | After |
|---|---|---|
| ≥2 | album **with** caption, then `👍 or 👎?` + buttons | album **without** caption, then the full card text + buttons |
| 1 | `sendPhotoCached` with caption + buttons | unchanged; `parse_mode` added to `extra` |
| 0 | text + buttons | unchanged; `parse_mode` added |

The album branch's existing failure handling is kept and extended. Today a
failed buttons-message is logged and swallowed, on the reasoning that the album
already reached the user. That reasoning weakens once the second message
carries the listing facts as well as the controls — losing it now loses the
card's content. So the send gets one retry as **plain text with no
`parse_mode`**, which recovers the overwhelmingly likely failure cause (a
malformed entity) without a second album.

`appendSwipeStatus`, `SWIPE_PROMPT_TEXT`, and `GROUP_PLACEHOLDER_TEXTS` stay in
place untouched. Cards already sitting in users' chat histories still carry the
placeholder companion message, and their buttons must keep working after
deploy.

### 3. Swipe status is rebuilt from the database, not from the message

`clearSwipedCardButtons` (`bot.ts:380`) currently appends a status line to
`message.text` / `message.caption`. Under HTML that is wrong twice over: the
formatting is already gone from the string Telegram returns, and an unescaped
`&` in the title makes the edit fail.

The callback data already carries the id (`like:<id>`, `pass:<id>`,
`unlike:<id>`). The handler re-reads the listing, re-renders it via
`formatCard`, appends the status line, and edits with `parse_mode: 'HTML'`.
If the listing is missing from the database, it falls back to today's
plain-string behaviour — best-effort, exactly as the existing doc comment
promises.

### 4. CSV export in `src/export.ts`

```ts
export function toCsv(rows: ShortlistExportRow[]): string
```

Pure function, tested directly. Columns, in order:

```
title, price, area_sqm, rooms, price_per_sqm, district, address,
source, value_flag, is_private, lift, parking_spaces, floor, energy_class,
available_from, mentions_pets, is_wg, requires_waitlist_ticket, is_delisted,
first_seen, saved_at, url
```

Column headers stay English in every locale — this is a machine-readable
interchange format, and a German header row would break any downstream sheet a
user has already built.

Two Austria-specific format decisions:

- **Delimiter `;`, not `,`.** Excel under a German/Austrian locale parses `,`
  as the decimal separator and drops a comma-delimited file into a single
  column.
- **UTF-8 BOM prefix.** Without it the same Excel renders `Mariahilferstraße`
  as `MariahilferstraÃŸe`.

Escaping follows RFC 4180: a field containing `;`, `"`, `\n`, or `\r` is
wrapped in double quotes and its internal quotes doubled. Nulls render as an
empty field, never as the string `null`. Booleans render `true`/`false`.

`saved_at` requires a small change in `db.ts:771`: `getShortlist` currently
returns bare `ListingRow`s and discards `s.saved_at`. A sibling
`getShortlistForExport(db, chatId): ShortlistExportRow[]` selects
`l.*, s.saved_at` and preserves the existing newest-first ordering, leaving
`getShortlist` and its callers untouched.

Delivery is `telegram.sendDocument(chatId, { source: Buffer.from(csv, 'utf8'),
filename: 'shortlist-YYYY-MM-DD.csv' })`. The date comes from an injected
`now: Date`, matching the clock-injection convention `sendListingCard` and
`sendCard` already follow.

Entry points, both leading to the same function:

- A `📤 Export CSV` inline button on the `/shortlist` browse card.
- An `/export` command, registered in `BOT_COMMANDS`.

An empty shortlist replies with the existing `shortlist_empty` string rather
than sending a zero-row file.

### New locale keys

Added to `en`, `ru`, and `de`, and to no other key:

- `btn_export_csv` — the shortlist button label
- `export_caption` — the document's caption, e.g. "12 saved listings"
- `export_failed` — the send-failure reply
- `card_link_text` — anchor text, parameterised by source (`Open on {source} \u25b8`)
- `card_rooms`, `card_floor`, `card_available_from` — labels currently hardcoded
  English inside `formatCaption`
- `card_value_good`, `card_value_fair`, `card_value_premium` — the value-flag badge

District names and CSV headers are deliberately excluded, per the decisions
above. The existing `pet_badge` convention — hedged wording in every locale —
carries over.

## Testing

Pure functions carry the load, on the existing harness
(`node --import tsx --test test/*.test.ts`):

**`test/card.test.ts`**
- escapes `&`, `<`, `>` in title, address, description, and floor
- escapes the URL inside the `href` attribute
- omits every line whose data is null, without leaving blank lines
- respects both length budgets (1024 caption, 4096 message)
- never truncates inside a tag or entity
- renders each warning flag (WG, waitlist, delisted) and the pet badge

**`test/export.test.ts`**
- quotes and doubles quotes in a title containing `;` and `"`
- emits the BOM exactly once, at the start
- renders nulls as empty fields and booleans as `true`/`false`
- header row matches the documented column order
- newest-first row ordering is preserved

**`test/bot.test.ts`** (existing, extended)
- album path sends the media group with no caption and a following message that
  carries both text and `reply_markup`
- a failed formatted send retries once as plain text
- swipe status re-renders from the database rather than from `message.text`

**`test/locales.test.ts`** already enforces key parity; new keys are covered for
free.

Live verification after deploy: send `/next` on the VM's bot and confirm a card
renders with bold title, working link, and buttons attached; swipe it and
confirm the status edit keeps its formatting; run `/export` and open the file
in Excel.

## Files

**New:** `src/card.ts`, `src/export.ts`, `test/card.test.ts`,
`test/export.test.ts`

**Changed:** `src/bot.ts` (`sendListingCard`, `sendCard`,
`sendShortlistBrowseCard`, `clearSwipedCardButtons`, `sendShortlistTo`,
`BOT_COMMANDS`, remove `formatCaption`), `src/notify.ts` (call `formatCard`),
`src/db.ts` (`getShortlistForExport`), `src/locales/{en,ru,de}.ts`,
`test/bot.test.ts`, `test/notify.test.ts`

## Risks

| Risk | Mitigation |
|---|---|
| An unescaped entity makes cards vanish silently | Escaping tests on every listing-sourced field; plain-text retry on send failure |
| Old cards in chat history break after deploy | Placeholder handling and `appendSwipeStatus` left intact |
| Album and text arrive as two notifications | Accepted — the album is already one message today, and the second message now carries real content |
| Excel mangles the CSV | `;` delimiter and BOM, both covered by tests |

## Out of scope

- The Mini App redesign (`2026-08-19-mini-app-redesign-design.md`) — unbuilt,
  and this work must not presuppose it.
- Exporting anything other than the shortlist (e.g. all matches, swipe history).
- PDF or HTML export. `apt-hunter`'s `renderReport` remains available for a
  later HTML export, but CSV is what was asked for.
- Translating listing content. As with the rest of the bot, listing text is
  shown in its original language.
