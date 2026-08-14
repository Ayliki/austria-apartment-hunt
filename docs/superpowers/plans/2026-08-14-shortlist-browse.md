# In-place shortlist browsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/shortlist`'s "dump every liked listing as its own message" with browsing one card at a time, edited in place with ◀️ Prev / 🗑️ Remove / ▶️ Next — the whole session lives in one chat message.

**Architecture:** All changes are confined to `swipe-bot/src/bot.ts` (and its test file). No schema or `db.ts` changes. The key constraint driving the design: Telegram can only edit a message's photo or text in place when the target keeps the same type (photo↔photo, text↔text) — cross-type transitions require deleting the old message and sending a new one, which this plan implements explicitly rather than papering over.

**Tech Stack:** TypeScript, Telegraf (`editMessageMedia`, `editMessageText`, `deleteMessage`, `Markup.inlineKeyboard`), `node:test`.

## Global Constraints

- Shortlist browsing shows only the first photo of each listing (never a multi-photo album) — this is what makes in-place editing possible at all. The swipe deck (`/next`) is untouched and keeps sending full albums.
- Every Prev/Next/Remove tap re-fetches the shortlist fresh from the DB — never trusts a stored index, since the list can change between taps.
- A Prev/Next tap that would go past either end refuses (distinct `answerCbQuery` message, no mutation) rather than wrapping or silently clamping.
- `editMessageMedia`/`editMessageText` are used only when the current message's type (photo vs no-photo) matches the target's type; otherwise `deleteMessage` + a fresh `sendPhoto`/`sendMessage` — never attempt an edit across types (Telegram's API doesn't support it and will error).
- All new/changed code stays best-effort on Telegram edit/delete failures (wrapped in try/catch, matching `clearSwipedCardButtons`'s existing philosophy) — never let a stale-message edit failure throw and block the response.
- Dead code this feature makes obsolete gets deleted outright, not left orphaned: `sendShortlistCard`, `MAX_SHORTLIST_CARDS`, `REMOVE_PROMPT_TEXT`, and the now-unreachable branch of `GROUP_PLACEHOLDER_TEXTS`/its test coverage.

---

### Task 1: `formatCaption` position prefix + `shortlistNavButtons`

Two small, pure, independently-testable additions that Tasks 2 and 3 both consume.

**Files:**
- Modify: `swipe-bot/src/bot.ts` (`formatCaption` at lines 166-181; new `shortlistNavButtons` added after `buildMediaGroup`, currently ending at line 199)
- Test: `swipe-bot/test/bot.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2 and 3): `formatCaption(l: ListingRow, commuteLine?: string | null, prefix?: string): string` (new optional 3rd param, backward compatible), `shortlistNavButtons(listingId: string, position: number, total: number): ReturnType<typeof Markup.inlineKeyboard>`.

- [ ] **Step 1: Write the failing tests**

Add to `swipe-bot/test/bot.test.ts`, near the existing `formatCaption` tests:

```ts
test('formatCaption includes an optional prefix ahead of the title, within the truncation budget', () => {
  const withPrefix = formatCaption(row({}), null, '❤️ 3 of 12\n\n');
  assert.match(withPrefix, /^❤️ 3 of 12\n\nSunny two-room flat/);
});

test('formatCaption without a prefix behaves exactly as before (no leading position line)', () => {
  assert.doesNotMatch(formatCaption(row({})), /❤️/);
});

test('formatCaption truncates to 1024 chars even with a prefix present', () => {
  const longDescription = 'x'.repeat(2000);
  const caption = formatCaption(row({ description: longDescription }), null, '❤️ 3 of 12\n\n');
  assert.ok(caption.length <= 1024, `caption was ${caption.length} chars`);
  assert.ok(caption.startsWith('❤️ 3 of 12\n\n'));
  assert.ok(caption.endsWith('…'));
});

test('shortlistNavButtons: a middle position shows Prev, Remove, and Next in that order', () => {
  const markup = shortlistNavButtons('willhaben:a', 2, 3) as unknown as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  const row = markup.reply_markup.inline_keyboard[0];
  assert.deepEqual(row.map((b) => b.text), ['◀️ Prev', '🗑️ Remove', '▶️ Next']);
  assert.deepEqual(row.map((b) => b.callback_data), ['slnav:prev:willhaben:a', 'unlike:willhaben:a', 'slnav:next:willhaben:a']);
});

test('shortlistNavButtons: the first position omits Prev', () => {
  const markup = shortlistNavButtons('willhaben:a', 1, 3) as unknown as { reply_markup: { inline_keyboard: { text: string }[][] } };
  assert.deepEqual(markup.reply_markup.inline_keyboard[0].map((b) => b.text), ['🗑️ Remove', '▶️ Next']);
});

test('shortlistNavButtons: the last position omits Next', () => {
  const markup = shortlistNavButtons('willhaben:a', 3, 3) as unknown as { reply_markup: { inline_keyboard: { text: string }[][] } };
  assert.deepEqual(markup.reply_markup.inline_keyboard[0].map((b) => b.text), ['◀️ Prev', '🗑️ Remove']);
});

test('shortlistNavButtons: a single-item shortlist omits both Prev and Next', () => {
  const markup = shortlistNavButtons('willhaben:a', 1, 1) as unknown as { reply_markup: { inline_keyboard: { text: string }[][] } };
  assert.deepEqual(markup.reply_markup.inline_keyboard[0].map((b) => b.text), ['🗑️ Remove']);
});
```

Add `shortlistNavButtons` to the existing `from '../src/bot.js'` import line at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — `shortlistNavButtons` doesn't exist yet; the prefix tests fail because `formatCaption` ignores a 3rd argument today.

- [ ] **Step 3: Implement in `bot.ts`**

Change `formatCaption` (currently lines 166-181) from:

```ts
export function formatCaption(l: ListingRow, commuteLine?: string | null): string {
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
  return truncate(full, MAX_CAPTION_LENGTH);
}
```

to (adds the optional `prefix` parameter, included in the same truncation budget):

```ts
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
```

Add `shortlistNavButtons` right after `buildMediaGroup` (currently ending at line 199, right before the `SWIPE_PROMPT_TEXT`/`REMOVE_PROMPT_TEXT` constants):

```ts
/** Pure — builds the Prev/Remove/Next row for browsing the shortlist one card at a time, omitting Prev at the first position and Next at the last (Telegram has no disabled-button state, so an unreachable direction is simply not offered). */
export function shortlistNavButtons(listingId: string, position: number, total: number): ReturnType<typeof Markup.inlineKeyboard> {
  const row: ReturnType<typeof Markup.button.callback>[] = [];
  if (position > 1) row.push(Markup.button.callback('◀️ Prev', `slnav:prev:${listingId}`));
  row.push(Markup.button.callback('🗑️ Remove', `unlike:${listingId}`));
  if (position < total) row.push(Markup.button.callback('▶️ Next', `slnav:next:${listingId}`));
  return Markup.inlineKeyboard([row]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS, all tests including the new ones.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/bot.ts swipe-bot/test/bot.test.ts
git commit -m "Add formatCaption position prefix and shortlistNavButtons for one-at-a-time browsing"
```

---

### Task 2: Single-card send path, remove the old multi-card dump

**Files:**
- Modify: `swipe-bot/src/bot.ts`
- Test: `swipe-bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `formatCaption` (with prefix), `shortlistNavButtons` (Task 1).
- Produces (consumed by Task 3, which sends and edits the same card shape): new `sendShortlistBrowseCard(telegram, chatId, card, position, total)`; `sendShortlistTo` now sends exactly one card.
- Removes: `sendShortlistCard`, `MAX_SHORTLIST_CARDS`, `REMOVE_PROMPT_TEXT`.

- [ ] **Step 1: Write the failing tests**

In `swipe-bot/test/bot.test.ts`, first update the `appendSwipeStatus` placeholder test (find it — currently):

```ts
test('appendSwipeStatus replaces a group-companion placeholder wholesale, rather than appending to it', () => {
  assert.equal(appendSwipeStatus('👍 or 👎?', '✅ Added to shortlist'), '✅ Added to shortlist');
  assert.equal(appendSwipeStatus('🗑️ to remove', '🗑️ Removed'), '🗑️ Removed');
});
```

Change it to drop the now-unreachable `REMOVE_PROMPT_TEXT` case (that exact string can no longer be produced by any code path once this task lands):

```ts
test('appendSwipeStatus replaces a group-companion placeholder wholesale, rather than appending to it', () => {
  assert.equal(appendSwipeStatus('👍 or 👎?', '✅ Added to shortlist'), '✅ Added to shortlist');
});
```

Next, find and **delete entirely** this test (it exercises a cap that no longer exists):

```ts
test('/shortlist caps at MAX_SHORTLIST_CARDS and tells the user how many were left out', async () => {
  const db = openDb(':memory:');
  for (let i = 0; i < MAX_SHORTLIST_CARDS + 3; i++) {
    upsertListing(db, listing({ id: `x${i}`, price: 500 }));
    recordSwipe(db, 1, `willhaben:x${i}`, 'like');
  }
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/shortlist'));

  const cards = calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€'));
  assert.equal(cards.length, MAX_SHORTLIST_CARDS);
  const trailing = calls.at(-1)!;
  assert.match(trailing.payload.text as string, /3 more/);
});
```

Remove `MAX_SHORTLIST_CARDS` from the test file's `from '../src/bot.js'` import line (it's the only remaining reference in this file once the test above is deleted).

Then find and **replace** this test:

```ts
test('/shortlist sends one card per liked listing, each with a Remove button, newest-liked first', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'old', price: 500 }));
  upsertListing(db, listing({ id: 'new', price: 600 }));
  recordSwipe(db, 1, 'willhaben:old', 'like');
  recordSwipe(db, 1, 'willhaben:new', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/shortlist'));

  const cards = calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€'));
  assert.equal(cards.length, 2);
  const buttons = cards.map((c) => (c.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0][0]);
  assert.ok(buttons.every((b) => b.text === '🗑️ Remove'));
  assert.deepEqual(buttons.map((b) => b.callback_data), ['unlike:willhaben:new', 'unlike:willhaben:old']);
});
```

with:

```ts
test('/shortlist sends only the newest-liked item, as a single card with a position count and nav buttons', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'old', price: 500 }));
  upsertListing(db, listing({ id: 'new', price: 600 }));
  recordSwipe(db, 1, 'willhaben:old', 'like');
  recordSwipe(db, 1, 'willhaben:new', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/shortlist'));

  const cards = calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€'));
  assert.equal(cards.length, 1); // only the first card, not the whole shortlist
  assert.match(cards[0].payload.text as string, /❤️ 1 of 2/);
  assert.match(cards[0].payload.text as string, /€600/); // newest-liked ('new') shown first

  const row = (cards[0].payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0];
  assert.deepEqual(row.map((b) => b.text), ['🗑️ Remove', '▶️ Next']); // position 1 of 2 — no Prev, has Next
  assert.deepEqual(row.map((b) => b.callback_data), ['unlike:willhaben:new', 'slnav:next:willhaben:new']);
});
```

(Leave the `'/shortlist sends nothing but the empty-state message when there are no liked listings'` test untouched — it still holds exactly as written. Leave `'tapping Remove on a shortlist card deletes the shortlist entry and edits the card to show it was removed'` untouched too — Task 3 rewrites both the handler and that test together, don't touch it here.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — the replaced test's assertions don't hold against current behavior (still sends 2 cards); the file still imports `MAX_SHORTLIST_CARDS` from a spot you've now removed from the source... actually at this point `MAX_SHORTLIST_CARDS` still exists in `bot.ts` (Step 3 hasn't run yet) — the failure here is purely the behavioral assertions in the replaced test not matching (still 2 cards sent, no `❤️` prefix). This is expected.

- [ ] **Step 3: Implement in `bot.ts`**

Delete the `REMOVE_PROMPT_TEXT` export and shrink `GROUP_PLACEHOLDER_TEXTS`. Change (currently lines 201-204):

```ts
/** Placeholder text used for the standalone buttons message that accompanies a multi-photo album — swapped wholesale (not appended to) once swiped, since it carries no listing info of its own. */
export const SWIPE_PROMPT_TEXT = '👍 or 👎?';
export const REMOVE_PROMPT_TEXT = '🗑️ to remove';
const GROUP_PLACEHOLDER_TEXTS: string[] = [SWIPE_PROMPT_TEXT, REMOVE_PROMPT_TEXT];
```

to:

```ts
/** Placeholder text used for the standalone buttons message that accompanies a multi-photo album — swapped wholesale (not appended to) once swiped, since it carries no listing info of its own. */
export const SWIPE_PROMPT_TEXT = '👍 or 👎?';
const GROUP_PLACEHOLDER_TEXTS: string[] = [SWIPE_PROMPT_TEXT];
```

Update `sendListingCard`'s doc comment (currently line 211) — it references the function you're about to delete:

```ts
/** Low-level: sends a listing as photo album / single photo / text, with the given inline buttons. Shared by sendCard (swipe deck: 👍👎) and sendShortlistCard (🗑️ Remove). */
```

to:

```ts
/** Low-level: sends a listing as photo album / single photo / text, with the given inline buttons. Used by sendCard (swipe deck: 👍👎) — shortlist browsing (bot.ts) has its own single-photo-only sender, since a message it will later edit in place can never be a multi-photo album. */
```

Delete `MAX_SHORTLIST_CARDS` and `sendShortlistCard` entirely (currently lines 239-247):

```ts
/** Telegram send calls per /shortlist invocation, above which the rest are summarized instead of sent — keeps a long shortlist from spamming dozens of messages at once. */
export const MAX_SHORTLIST_CARDS = 20;

/** Sends one shortlist entry as a browsable card with a single 🗑️ Remove button — no commute line, to avoid a Routes API call per item on every /shortlist call. */
export async function sendShortlistCard(telegram: Telegraf['telegram'], chatId: number, card: ListingRow): Promise<void> {
  const caption = formatCaption(card);
  const buttons = Markup.inlineKeyboard([Markup.button.callback('🗑️ Remove', `unlike:${card.id}`)]);
  await sendListingCard(telegram, chatId, card, caption, buttons, REMOVE_PROMPT_TEXT);
}
```

Replace that whole block with `sendShortlistBrowseCard`:

```ts
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
```

Finally, rewrite `sendShortlistTo` (find it — currently):

```ts
/** Sends the shortlist (or its empty-state message). Shared by /shortlist and the "📋 Shortlist" keyboard button. */
async function sendShortlistTo(telegram: Telegraf['telegram'], chatId: number, db: DB): Promise<void> {
  const items = getShortlist(db, chatId);
  if (items.length === 0) {
    await telegram.sendMessage(chatId, 'Your shortlist is empty — 👍 a card to save it here.');
    return;
  }
  const shown = items.slice(0, MAX_SHORTLIST_CARDS);
  for (const item of shown) {
    await sendShortlistCard(telegram, chatId, item);
  }
  if (items.length > MAX_SHORTLIST_CARDS) {
    await telegram.sendMessage(chatId, `...and ${items.length - MAX_SHORTLIST_CARDS} more — narrow your prefs with /settings to see fewer at a time.`);
  }
}
```

to:

```ts
/** Sends the first shortlist card (or the empty-state message). Shared by /shortlist and the "📋 Shortlist" keyboard button — from there, browsing the rest happens via Prev/Next/Remove on that one message, not further /shortlist calls. */
async function sendShortlistTo(telegram: Telegraf['telegram'], chatId: number, db: DB): Promise<void> {
  const items = getShortlist(db, chatId);
  if (items.length === 0) {
    await telegram.sendMessage(chatId, 'Your shortlist is empty — 👍 a card to save it here.');
    return;
  }
  await sendShortlistBrowseCard(telegram, chatId, items[0], 1, items.length);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS, all tests including the updated ones. (The `'tapping Remove on a shortlist card...'` test still passes unmodified — Task 2 doesn't touch the `unlike` handler.)

- [ ] **Step 5: Typecheck**

Run: `cd swipe-bot && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add swipe-bot/src/bot.ts swipe-bot/test/bot.test.ts
git commit -m "Send shortlist as one card at a time instead of dumping every liked listing"
```

---

### Task 3: Prev/Next navigation and in-place Remove

**Files:**
- Modify: `swipe-bot/src/bot.ts`
- Test: `swipe-bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `formatCaption`, `shortlistNavButtons` (Task 1); `getShortlist`, `removeFromShortlist` (existing, from `db.ts`).
- Produces: new `bot.action(/^slnav:(prev|next):(.+)$/, ...)` handler; rewritten `bot.action(/^unlike:(.+)$/, ...)` handler; new `replaceShortlistCard`/`replaceShortlistWithEmptyState` helpers.

- [ ] **Step 1: Write the failing tests**

First, **delete** this now-superseded test in `swipe-bot/test/bot.test.ts` (its assertions — a static "Removed" text, an emptied keyboard — describe the old behavior; the two new tests below replace its coverage with the new advance-in-place behavior):

```ts
test('tapping Remove on a shortlist card deletes the shortlist entry and edits the card to show it was removed', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'unlike:willhaben:a', { text: 'Sunny flat\n€500\nhttps://x/1' }));

  assert.equal(getShortlist(db, 1).length, 0);
  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'expected the shortlist card to be edited');
  assert.match(edit!.payload.text as string, /🗑️ Removed/);
  assert.deepEqual((edit!.payload.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard, []);
});
```

Then add these new tests, near it:

```ts
test('tapping Next from position 1 of 3 edits the same message in place to position 2 of 3', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  upsertListing(db, listing({ id: 'b', price: 600 }));
  upsertListing(db, listing({ id: 'c', price: 700 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  recordSwipe(db, 1, 'willhaben:c', 'like');
  // newest-liked first: c (pos 1), b (pos 2), a (pos 3)
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'slnav:next:willhaben:c', { text: '❤️ 1 of 3\n\nFlat\n€700\nhttps://x/1\n(no photo)' }));

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'expected an in-place edit, not a new message');
  assert.match(edit!.payload.text as string, /❤️ 2 of 3/);
  assert.match(edit!.payload.text as string, /€600/);
  assert.equal(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€')), false); // no new card message
});

test('tapping Prev at position 1 is refused with a distinct reply, nothing changes', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'slnav:prev:willhaben:a', { text: '❤️ 1 of 1\n\nFlat\n€500\nhttps://x/1\n(no photo)' }));

  const answer = calls.find((c) => c.method === 'answerCallbackQuery');
  assert.equal(answer!.payload.text, 'This is the first one.');
  assert.equal(calls.some((c) => c.method === 'editMessageText'), false);
});

test('navigating to a listing whose photo-presence differs from the current message deletes and sends fresh, instead of an unsupported cross-type edit', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500, images: [] })); // no photo — current message is text
  upsertListing(db, listing({ id: 'b', price: 600, images: ['https://img/1.jpg'] })); // has a photo — target
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  // newest-first: b (pos 1, has photo), a (pos 2, no photo) — Prev from 'a' goes to 'b'
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'slnav:prev:willhaben:a', { text: '❤️ 2 of 2\n\nFlat\n€500\nhttps://x/1\n(no photo)' }));

  assert.ok(calls.some((c) => c.method === 'deleteMessage'), 'expected the old text card to be deleted');
  assert.ok(calls.some((c) => c.method === 'sendPhoto'), 'expected a fresh photo message for the target');
  assert.equal(calls.some((c) => c.method === 'editMessageText'), false);
  assert.equal(calls.some((c) => c.method === 'editMessageMedia'), false);
});

test('tapping Remove on a middle item advances in place to the item that slid into its slot', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  upsertListing(db, listing({ id: 'b', price: 600 }));
  upsertListing(db, listing({ id: 'c', price: 700 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  recordSwipe(db, 1, 'willhaben:c', 'like');
  // newest-first: c (pos 1), b (pos 2), a (pos 3) — remove 'b' at position 2
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'unlike:willhaben:b', { text: '❤️ 2 of 3\n\nFlat\n€600\nhttps://x/1\n(no photo)' }));

  const remaining = getShortlist(db, 1);
  assert.deepEqual(remaining.map((l) => l.id).sort(), ['willhaben:a', 'willhaben:c'].sort());

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'expected an in-place edit to the item that slid into position 2');
  assert.match(edit!.payload.text as string, /❤️ 2 of 2/);
  assert.match(edit!.payload.text as string, /€500/); // 'a' is now at position 2
});

test('tapping Remove on the last item advances to the new last item, position count decreases', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  upsertListing(db, listing({ id: 'b', price: 600 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  // newest-first: b (pos 1), a (pos 2) — remove 'a', the last one
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'unlike:willhaben:a', { text: '❤️ 2 of 2\n\nFlat\n€500\nhttps://x/1\n(no photo)' }));

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit);
  assert.match(edit!.payload.text as string, /❤️ 1 of 1/);
  assert.match(edit!.payload.text as string, /€600/);
});

test('tapping Remove on the only remaining item shows the empty-shortlist message via delete+send', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'unlike:willhaben:a', { text: '❤️ 1 of 1\n\nFlat\n€500\nhttps://x/1\n(no photo)' }));

  assert.equal(getShortlist(db, 1).length, 0);
  assert.ok(calls.some((c) => c.method === 'deleteMessage'));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('shortlist is empty')));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — `slnav:` isn't a registered action yet (those `handleUpdate` calls are no-ops); the `unlike:` tests fail because the handler still does the old clear-to-"Removed" behavior, not advance-in-place.

- [ ] **Step 3: Implement in `bot.ts`**

Add a narrowed context type and the two replace-helpers. Insert this right after `clearSwipedCardButtons`'s closing brace (find that function — it ends with the comment `// best-effort — see doc comment above` followed by `}`):

```ts
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
 * Replaces the current callback message in place with a different shortlist position — editing the
 * photo/text if the target's type (photo vs no-photo) matches the current message's type, since
 * Telegram has no API to convert a message from one type to the other via edit. When the types
 * differ, deletes the old message and sends a fresh one instead, so shortlist browsing never
 * accumulates more than one message in the chat even across that edge case. Best-effort: an
 * edit/delete failure (message too old, already gone) must never throw and block the response.
 */
async function replaceShortlistCard(ctx: ShortlistCardCtx, listing: ListingRow, position: number, total: number): Promise<void> {
  const message = ctx.callbackQuery?.message as { photo?: unknown } | undefined;
  if (!message) return;
  const chatId = ctx.chat!.id;
  const caption = formatCaption(listing, null, `❤️ ${position} of ${total}\n\n`);
  const buttons = shortlistNavButtons(listing.id, position, total);
  const targetHasPhoto = listing.images.length > 0;
  const currentHasPhoto = Boolean(message.photo);
  try {
    if (targetHasPhoto && currentHasPhoto) {
      await ctx.editMessageMedia({ type: 'photo', media: listing.images[0], caption }, buttons);
    } else if (!targetHasPhoto && !currentHasPhoto) {
      await ctx.editMessageText(`${caption}\n(no photo)`, buttons);
    } else {
      await ctx.deleteMessage();
      if (targetHasPhoto) {
        await ctx.telegram.sendPhoto(chatId, listing.images[0], { caption, ...buttons });
      } else {
        await ctx.telegram.sendMessage(chatId, `${caption}\n(no photo)`, buttons);
      }
    }
  } catch {
    // best-effort — see doc comment above
  }
}

/** Replaces the current callback message with the empty-shortlist message — always delete+send, since there's no in-place target type to match against once nothing is left to browse. */
async function replaceShortlistWithEmptyState(ctx: ShortlistCardCtx): Promise<void> {
  const chatId = ctx.chat!.id;
  try {
    await ctx.deleteMessage();
    await ctx.telegram.sendMessage(chatId, 'Your shortlist is empty — 👍 a card to save it here.');
  } catch {
    // best-effort
  }
}
```

Add the new navigation handler. Find `bot.action(/^unlike:(.+)$/, ...)` (currently):

```ts
  bot.action(/^unlike:(.+)$/, async (ctx) => {
    const [, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    removeFromShortlist(db, chatId, listingId);
    await ctx.answerCbQuery('Removed from shortlist 🗑️');
    await clearSwipedCardButtons(ctx, '🗑️ Removed');
  });
```

Replace it with the new `slnav:` handler followed by the rewritten `unlike:` handler:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS, all tests including the new and updated ones.

- [ ] **Step 5: Typecheck**

Run: `cd swipe-bot && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add swipe-bot/src/bot.ts swipe-bot/test/bot.test.ts
git commit -m "Add Prev/Next navigation and in-place Remove for shortlist browsing"
```

---

### Task 4: Full-repo verification, push, and deploy

**Files:** none (verification and deploy only)

- [ ] **Step 1: Run the full swipe-bot suite and typecheck**

```bash
cd swipe-bot && npm test
cd swipe-bot && npx tsc --noEmit -p .
```
Expected: all PASS, no errors.

- [ ] **Step 2: Run apt-hunter's suite too (untouched by this plan, but confirm no cross-workspace regression)**

```bash
cd apt-hunter && npm test
```
Expected: PASS.

- [ ] **Step 3: Push**

Already pre-approved by the user — push without asking again. First fetch to confirm no one else moved `origin/main` since this branch was cut:

```bash
git fetch origin main --quiet
git log --oneline origin/main -1
```

Then:

```bash
git push origin HEAD:main
```

- [ ] **Step 4: Confirm the VM isn't mid-sweep before restarting**

```bash
gcloud compute ssh swipe-bot-vm --project austria-swipe-bot --zone us-central1-a --command \
  "tail -3 ~/swipe-bot.log"
```
The listing-refresh sweep is a background loop unrelated to this feature — if it's mid-sweep, restarting just resumes cleanly next cycle. This is a courtesy check, not a hard blocker; proceed either way after a quick look.

- [ ] **Step 5: Redeploy**

```bash
gcloud compute ssh swipe-bot-vm --project austria-swipe-bot --zone us-central1-a --command \
  "cd ~/austria-apartment-hunt && git pull && (cd swipe-bot && npm install && npm run build) && sudo systemctl restart swipe-bot"
```

- [ ] **Step 6: Verify the service restarted cleanly**

```bash
gcloud compute ssh swipe-bot-vm --project austria-swipe-bot --zone us-central1-a --command \
  "sudo systemctl status swipe-bot --no-pager | head -8 && tail -5 ~/swipe-bot.log"
```
Expected: `Active: active (running)`, and the log tail shows `swipe-bot: Telegram long-polling started` promptly (not blocked — the refresh sweep is fire-and-forget from an earlier feature, unrelated to this one but worth reconfirming nothing regressed).
