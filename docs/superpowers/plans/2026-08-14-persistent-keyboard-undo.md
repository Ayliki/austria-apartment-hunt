# Persistent nav keyboard + swipe undo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent bottom reply-keyboard (⏭ Next / 📋 Shortlist / ⚙️ Settings) for one-tap navigation, and a single-level "↩️ Undo" for the most recent swipe.

**Architecture:** All changes are confined to `swipe-bot/src/db.ts` (two new pure DB functions) and `swipe-bot/src/bot.ts` (a new keyboard constant, two extracted shared send-functions, one modified helper, one modified handler, one new handler). No schema changes, no new files.

**Tech Stack:** TypeScript, Telegraf (`Markup.keyboard` / `Markup.inlineKeyboard` / `Markup.button.callback`), `better-sqlite3`, `node:test`.

## Global Constraints

- Undo is single-level only: it must refuse (return `false`, no-op) unless the targeted listing is still the chat's most recent swipe — never undo an arbitrary past swipe.
- Mid-onboarding text handling always takes precedence over the three reply-keyboard button labels — a stray text match during onboarding must still be treated as an onboarding answer, never routed to Next/Shortlist/Settings.
- The 🗑️ Remove (`unlike:...`) action keeps clearing to an empty keyboard — Undo is scoped to `like`/`pass` swipes only, never to a shortlist removal.
- No new files; extracted shared functions take `(telegram, chatId, db, ...)` primitives (matching `sendNextCard`'s existing style), not a Telegraf `Context`, to keep them trivially callable from both a command handler and the new text-branch.

---

### Task 1: `getLastSwipe` / `undoSwipe` in `db.ts`

**Files:**
- Modify: `swipe-bot/src/db.ts` (insert after `recordSwipe`, i.e. after line 410, before `getShortlist`)
- Test: `swipe-bot/test/db.test.ts`

**Interfaces:**
- Produces (consumed by Task 3): `export interface LastSwipe { listingId: string; direction: 'like' | 'pass'; }`, `getLastSwipe(db: DB, chatId: number): LastSwipe | null`, `undoSwipe(db: DB, chatId: number, listingId: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Add to `swipe-bot/test/db.test.ts`. First extend the import line to pull in the new functions:

```ts
import {
  openDb, upsertListing, listingKey, getUserPrefs, setUserPrefs, getAllUserPrefs,
  recordSwipe, getShortlist, removeFromShortlist, getCandidateListings, getSwipedWithDirection,
  getListingsByIds, getAllListingIds, matchesPrefs, getCommuteTimes, setCommuteTimes, setListingCoords,
  getListingsBySource, applyListingRefresh, setListingDelisted, deleteDelistedUnshortlisted,
  getLastSwipe, undoSwipe, type ListingRow,
} from '../src/db.js';
```

Then add these tests (place near the existing `recordSwipe`/`removeFromShortlist` tests):

```ts
test('getLastSwipe returns null when nothing has been swiped', () => {
  const db = openDb(':memory:');
  assert.equal(getLastSwipe(db, 1), null);
});

test('getLastSwipe returns the most recently swiped listing', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  upsertListing(db, listing({ id: 'b', district: 6 }));
  recordSwipe(db, 1, 'willhaben:a', 'pass');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  assert.deepEqual(getLastSwipe(db, 1), { listingId: 'willhaben:b', direction: 'like' });
});

test('undoSwipe reverses a like: deletes the swipe and the shortlist entry, making the listing eligible for /next again', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  assert.equal(undoSwipe(db, 1, 'willhaben:a'), true);
  assert.equal(getShortlist(db, 1).length, 0);
  const candidates = getCandidateListings(db, 1, defaultPrefs(1));
  assert.deepEqual(candidates.map((c) => c.id), ['willhaben:a']);
});

test('undoSwipe reverses a pass: deletes the swipe, no shortlist entry to touch', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  recordSwipe(db, 1, 'willhaben:a', 'pass');
  assert.equal(undoSwipe(db, 1, 'willhaben:a'), true);
  const candidates = getCandidateListings(db, 1, defaultPrefs(1));
  assert.deepEqual(candidates.map((c) => c.id), ['willhaben:a']);
});

test('undoSwipe refuses to undo anything but the chat\'s most recent swipe', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  upsertListing(db, listing({ id: 'b', district: 6 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'pass');
  assert.equal(undoSwipe(db, 1, 'willhaben:a'), false); // 'a' is no longer the last swipe
  assert.equal(getShortlist(db, 1).length, 1); // untouched
  const candidates = getCandidateListings(db, 1, defaultPrefs(1));
  assert.deepEqual(candidates.map((c) => c.id), []); // both still excluded
});

test('undoSwipe on a chat with no swipes at all is a no-op', () => {
  const db = openDb(':memory:');
  assert.equal(undoSwipe(db, 1, 'willhaben:a'), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — compile error, `getLastSwipe`/`undoSwipe` don't exist in `db.js` yet.

- [ ] **Step 3: Implement in `db.ts`**

Insert immediately after `recordSwipe`'s closing brace (currently line 410, right before `export function getShortlist`):

```ts
export interface LastSwipe {
  listingId: string;
  direction: 'like' | 'pass';
}

/** The most recent swipe recorded for a chat, or null if they haven't swiped yet. */
export function getLastSwipe(db: DB, chatId: number): LastSwipe | null {
  const row = db.prepare('SELECT listing_id, direction FROM swipes WHERE chat_id = ? ORDER BY swiped_at DESC LIMIT 1')
    .get(chatId) as { listing_id: string; direction: 'like' | 'pass' } | undefined;
  return row ? { listingId: row.listing_id, direction: row.direction } : null;
}

/**
 * Reverses a swipe — but ONLY if `listingId` is still that chat's most recent swipe (an Undo button
 * always targets one specific listing, but "undo" as a concept only ever means "undo the last one" —
 * this guards a stale button tap after several more swipes happened in between). Deletes the `swipes`
 * row (making the listing eligible for /next again) and, if it was a 'like', the `shortlist` row it
 * created. Returns false (no-op, nothing changed) if the check fails.
 */
export function undoSwipe(db: DB, chatId: number, listingId: string): boolean {
  const last = getLastSwipe(db, chatId);
  if (!last || last.listingId !== listingId) return false;
  db.prepare('DELETE FROM swipes WHERE chat_id = ? AND listing_id = ?').run(chatId, listingId);
  db.prepare('DELETE FROM shortlist WHERE chat_id = ? AND listing_id = ?').run(chatId, listingId);
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS, all tests including the new ones (should be 157 + 6 = 163 total, but don't hardcode this number in an assertion — just confirm 0 failures).

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/db.ts swipe-bot/test/db.test.ts
git commit -m "Add getLastSwipe/undoSwipe for single-level swipe undo"
```

---

### Task 2: Persistent nav keyboard in `bot.ts`

**Files:**
- Modify: `swipe-bot/src/bot.ts`
- Test: `swipe-bot/test/bot.test.ts`

**Interfaces:**
- Produces: `export const MAIN_KEYBOARD` (a Telegraf reply-markup extra object), two new module-private async functions `sendShortlistTo(telegram, chatId, db)` and `startSettingsFor(telegram, chatId, db)` (both reused by their existing `bot.command(...)` handlers and the new text-branch).
- Consumes: nothing new from other tasks — independent of Task 1 and Task 3, can be built in either order, but this plan does it second for narrative flow.

- [ ] **Step 1: Write the failing tests**

Add to `swipe-bot/test/bot.test.ts` (near the other `/start`/onboarding-completion tests):

```ts
test('finishing onboarding attaches the persistent nav keyboard to the confirmation message', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'yes', 'no', 'skip']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }
  const confirmation = calls.find((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Preferences saved'));
  assert.ok(confirmation, 'expected the confirmation message');
  const keyboard = (confirmation!.payload.reply_markup as { keyboard: string[][] }).keyboard;
  assert.deepEqual(keyboard, [['⏭ Next', '📋 Shortlist', '⚙️ Settings']]);
});

test('/start on an already-configured chat also attaches the persistent nav keyboard', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  const reply = calls.find((c) => c.method === 'sendMessage');
  const keyboard = (reply!.payload.reply_markup as { keyboard: string[][] }).keyboard;
  assert.deepEqual(keyboard, [['⏭ Next', '📋 Shortlist', '⚙️ Settings']]);
});

test('tapping "⏭ Next" on the persistent keyboard sends the next card, same as /next', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: null, commuteLat: null, commuteLon: null });
  upsertListing(db, listing({ id: 'a', price: 500 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(textUpdate(1, '⏭ Next'));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€500')));
});

test('tapping "📋 Shortlist" on the persistent keyboard sends the shortlist, same as /shortlist', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(textUpdate(1, '📋 Shortlist'));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€500')));
});

test('tapping "⚙️ Settings" on the persistent keyboard restarts onboarding, same as /settings', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(textUpdate(1, '⚙️ Settings'));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes(ONBOARDING_INTRO)));
  assert.deepEqual(getOnboardingState(db, 1), []);
});

test('mid-onboarding text always wins over a coincidentally-matching keyboard label', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }
  // Onboarding is now waiting on the waitlist-housing yes/no question — send a keyboard-label-shaped
  // string instead of "yes"/"no" and confirm it's rejected as an invalid onboarding answer, not routed
  // to Settings (which would silently reset onboarding progress).
  await bot.handleUpdate(textUpdate(1, '⚙️ Settings'));
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /reply with "yes" or "no"/);
  assert.deepEqual(getOnboardingState(db, 1), ['800', 'skip', 'any', 'any', 'any']); // unchanged, not reset
});
```

`ONBOARDING_INTRO` is already imported/exported and used elsewhere in this test file — if not already imported at the top of `bot.test.ts`, add it to the existing `from '../src/bot.js'` import line.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — `MAIN_KEYBOARD` doesn't exist, keyboard-label taps are currently silently ignored (the "no candidates" / shortlist / settings assertions won't find matching calls).

- [ ] **Step 3: Implement in `bot.ts`**

Add the keyboard constant right after `BOT_COMMANDS` (currently ending at line 51):

```ts
/** Always-visible bottom keyboard for one-tap navigation — sent once (onboarding completion, or /start on an already-configured chat) and Telegram keeps it visible under the input field from then on. */
export const MAIN_KEYBOARD = Markup.keyboard([['⏭ Next', '📋 Shortlist', '⚙️ Settings']]).resize();
```

Extract the `/shortlist` command body into a shared function. Add this new function right before `createBot` (after `finishOnboarding`, currently ending at line 335):

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

/** Restarts the onboarding wizard from question 0. Shared by /settings and the "⚙️ Settings" keyboard button. */
async function startSettingsFor(telegram: Telegraf['telegram'], chatId: number, db: DB): Promise<void> {
  setOnboardingState(db, chatId, []);
  await telegram.sendMessage(chatId, ONBOARDING_INTRO);
  await telegram.sendMessage(chatId, QUESTIONS[0]);
}
```

Replace the `bot.start` already-set-up branch (currently):

```ts
    if (getUserPrefs(db, chatId)) {
      await ctx.reply(
        'You\'re already set up. /next for a listing, /shortlist to browse what you\'ve liked, ' +
        'or /settings to redo your preferences from scratch.'
      );
      return;
    }
```

with:

```ts
    if (getUserPrefs(db, chatId)) {
      await ctx.reply(
        'You\'re already set up. /next for a listing, /shortlist to browse what you\'ve liked, ' +
        'or /settings to redo your preferences from scratch.',
        MAIN_KEYBOARD,
      );
      return;
    }
```

Replace the `bot.command('settings', ...)` and `bot.command('shortlist', ...)` handlers with calls to the shared functions:

```ts
  bot.command('settings', async (ctx) => {
    await startSettingsFor(ctx.telegram, ctx.chat.id, db);
  });
```

```ts
  bot.command('shortlist', async (ctx) => {
    await sendShortlistTo(ctx.telegram, ctx.chat.id, db);
  });
```

In `finishOnboarding`, add `MAIN_KEYBOARD` as the third argument to the "Preferences saved" call:

```ts
  await telegram.sendMessage(
    chatId,
    'Preferences saved. New listings get checked every ~3h, not instantly — ' +
    'I\'ll message you here as soon as something matches. Anything I already have queued up:',
    MAIN_KEYBOARD,
  );
```

Finally, add the keyboard-label routing branch at the top of `bot.on('text', ...)`, replacing:

```ts
  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const answers = getOnboardingState(db, chatId);
    if (!answers) return; // not mid-onboarding, ignore free text
    const raw = ctx.message.text;
```

with:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS, all tests including the new ones.

- [ ] **Step 5: Typecheck**

Run: `cd swipe-bot && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add swipe-bot/src/bot.ts swipe-bot/test/bot.test.ts
git commit -m "Add a persistent nav keyboard for one-tap Next/Shortlist/Settings"
```

---

### Task 3: Swipe undo button and handler in `bot.ts`

**Files:**
- Modify: `swipe-bot/src/bot.ts`
- Test: `swipe-bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `getLastSwipe`, `undoSwipe` from Task 1's `db.ts`.
- Produces: `clearSwipedCardButtons` gains an optional 3rd parameter; a new `bot.action(/^undo:(.+)$/, ...)` handler.

- [ ] **Step 1: Write the failing tests**

First, this task **fixes an existing test that the code change below will break**. Find this test in `swipe-bot/test/bot.test.ts` (currently around line 515-525):

```ts
test('a swipe on a no-photo text card clears its buttons and appends a status line, instead of leaving it swipeable forever', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { text: 'Sunny flat\n€650 · 43m²\nhttps://x/1\n(no photo)' }));

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'expected an editMessageText call clearing the swiped card');
  assert.match(edit!.payload.text as string, /✅ Added to shortlist/);
  assert.deepEqual((edit!.payload.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard, []);
});
```

Replace it with (same setup, updated expectation — the swiped card now keeps exactly one button, an Undo, instead of clearing to none):

```ts
test('a swipe on a no-photo text card clears its swipe buttons down to a single Undo button', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { text: 'Sunny flat\n€650 · 43m²\nhttps://x/1\n(no photo)' }));

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'expected an editMessageText call clearing the swiped card');
  assert.match(edit!.payload.text as string, /✅ Added to shortlist/);
  const markup = edit!.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.deepEqual(markup.inline_keyboard, [[{ text: '↩️ Undo', callback_data: 'undo:willhaben:a' }]]);
});
```

(The `unlike:...` Remove test at ~line 597-609, `'tapping Remove on a shortlist card...'`, is unaffected — it asserts an empty `inline_keyboard` and stays that way; Undo is only for `like`/`pass`, never Remove. Do not change that test.)

Then add these new tests, near the other `like`/`pass` callback tests:

```ts
test('tapping Undo right after a like reverses it: swipe and shortlist entry both gone', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { text: 'Sunny flat\n€500\nhttps://x/1\n(no photo)' }));
  await bot.handleUpdate(callbackUpdate(1, 'undo:willhaben:a', { text: 'Sunny flat\n€500\nhttps://x/1\n(no photo)\n\n✅ Added to shortlist' }));

  assert.equal(getShortlist(db, 1).length, 0);
  const undoAnswer = calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
  assert.equal(undoAnswer!.payload.text, 'Swipe undone ↩️');
  const undoEdit = calls.filter((c) => c.method === 'editMessageText').at(-1);
  assert.match(undoEdit!.payload.text as string, /↩️ Undone/);
  assert.deepEqual((undoEdit!.payload.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard, []);
});

test('tapping Undo on a swipe that is no longer the most recent one is refused, nothing changes', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  upsertListing(db, listing({ id: 'b', price: 600 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { text: 'Flat A\n€500\nhttps://x/a\n(no photo)' }));
  await bot.handleUpdate(callbackUpdate(1, 'pass:willhaben:b', { text: 'Flat B\n€600\nhttps://x/b\n(no photo)' }));

  await bot.handleUpdate(callbackUpdate(1, 'undo:willhaben:a', { text: 'Flat A\n€500\nhttps://x/a\n(no photo)\n\n✅ Added to shortlist' }));

  assert.equal(getShortlist(db, 1).length, 1); // 'a' is still shortlisted — the undo was refused
  const undoAnswer = calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
  assert.equal(undoAnswer!.payload.text, 'You can only undo your most recent swipe.');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — the replaced test fails its new assertion (no Undo button exists yet); the two new tests fail (`undo:...` isn't a registered action, so those `handleUpdate` calls are no-ops and the assertions after them find nothing).

- [ ] **Step 3: Implement in `bot.ts`**

Add `undoSwipe` to the `db.js` import line (currently line 4):

```ts
  getUserPrefs, setUserPrefs, getCandidateListings, getSwipedWithDirection, recordSwipe, getShortlist, removeFromShortlist, undoSwipe,
```

Change `clearSwipedCardButtons`'s signature and body (currently lines 296-316) from:

```ts
async function clearSwipedCardButtons(
  ctx: {
    callbackQuery?: { message?: unknown };
    editMessageCaption: (caption?: string, extra?: ReturnType<typeof Markup.inlineKeyboard>) => Promise<unknown>;
    editMessageText: (text: string, extra?: ReturnType<typeof Markup.inlineKeyboard>) => Promise<unknown>;
  },
  status: string,
): Promise<void> {
  const message = ctx.callbackQuery?.message as { text?: string; caption?: string; photo?: unknown } | undefined;
  if (!message) return;
  try {
    const emptyMarkup = Markup.inlineKeyboard([]);
    if (message.photo) {
      await ctx.editMessageCaption(appendSwipeStatus(message.caption ?? '', status), emptyMarkup);
    } else if (message.text) {
      await ctx.editMessageText(appendSwipeStatus(message.text, status), emptyMarkup);
    }
  } catch {
    // best-effort — see doc comment above
  }
}
```

to (adds an optional 3rd parameter; when given, the cleared card keeps that one button instead of none):

```ts
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
```

Change the `like`/`pass` action handler (currently lines 418-430) from:

```ts
  bot.action(/^(like|pass):(.+)$/, async (ctx) => {
    const [, direction, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    const saved = recordSwipe(db, chatId, listingId, direction as 'like' | 'pass');
    if (direction === 'like' && !saved) {
      await ctx.answerCbQuery('This listing is no longer available.');
      await clearSwipedCardButtons(ctx, '⚠️ No longer available');
    } else {
      await ctx.answerCbQuery(direction === 'like' ? 'Saved to shortlist 👍' : 'Passed 👎');
      await clearSwipedCardButtons(ctx, direction === 'like' ? '✅ Added to shortlist' : '👎 Passed');
    }
    await sendNextCard(ctx.telegram, chatId, db, deps);
  });
```

to:

```ts
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
```

Add a new action handler immediately after it, before the `unlike` handler:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS, all tests including the updated and new ones.

- [ ] **Step 5: Typecheck**

Run: `cd swipe-bot && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add swipe-bot/src/bot.ts swipe-bot/test/bot.test.ts
git commit -m "Add single-level swipe undo via an inline Undo button on each swiped card"
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
Expected: PASS (unchanged from before this plan — apt-hunter isn't touched by any task here).

- [ ] **Step 3: Push**

Already pre-approved — push without asking again:

```bash
git push origin HEAD:main
```

- [ ] **Step 4: Confirm the VM isn't mid-sweep before restarting**

```bash
gcloud compute ssh swipe-bot-vm --project austria-swipe-bot --zone us-central1-a --command \
  "tail -3 ~/swipe-bot.log"
```
If the last lines show a `refresh:` sweep summary already completed (or nothing sweep-related in progress), it's safe to restart — the sweep is a background loop that resumes cleanly on its own schedule regardless of when the process restarts, so this is a courtesy check, not a hard blocker. If genuinely mid-sweep (rare — a full sweep is a few minutes at most), wait for it to finish before restarting to avoid discarding partial progress mid-row.

- [ ] **Step 5: Redeploy**

```bash
gcloud compute ssh swipe-bot-vm --project austria-swipe-bot --zone us-central1-a --command \
  "cd ~/austria-apartment-hunt && git pull && (cd swipe-bot && npm install && npm run build) && sudo systemctl restart swipe-bot"
```
(No `apt-hunter` rebuild needed this time — this plan doesn't touch it.)

- [ ] **Step 6: Verify the service restarted cleanly**

```bash
gcloud compute ssh swipe-bot-vm --project austria-swipe-bot --zone us-central1-a --command \
  "sudo systemctl status swipe-bot --no-pager | head -8 && tail -5 ~/swipe-bot.log"
```
Expected: `Active: active (running)`, and the log tail shows `swipe-bot: Telegram long-polling started` (and a fresh `poll:` line once that cycle completes).
