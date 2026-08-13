# Persistent navigation keyboard + single-level swipe undo

## Problem

Two navigational gaps in the swipe bot's chat UX, both reported directly and
confirmed against how comparable Telegram bots and Tinder itself behave:

1. **Getting back to swiping after `/shortlist` is a dead end.** `/shortlist`
   (`bot.ts:365-379`) dumps up to 20 static cards with only a 🗑️ Remove
   button each. There's no button back to the swipe deck — the user has to
   remember to type `/next`, or dig it out of the ☰ command menu.
2. **No undo.** A mistap on 👎 is permanent. Every serious swipe UI (Tinder
   included) treats "undo the last swipe" as a baseline expectation, not a
   nice-to-have.

## Goals

- A persistent, always-visible way to jump to `/next`, `/shortlist`, or
  `/settings` without typing a command or opening the ☰ menu.
- A one-tap way to undo the single most recent swipe, scoped tightly enough
  that it can never undo the wrong thing after several more swipes happen.

## Non-goals

- Multi-level undo / swipe history browsing — out of scope per explicit
  decision; single-level only, matching Tinder's own behavior.
- A Telegram Mini App (true drag-swipe gestures). Flagged during research as
  the natural next tier up, but explicitly deferred — this spec stays within
  the existing chat-bot architecture.
- An explicit "back to swiping" button inside `/shortlist` — redundant once
  the persistent keyboard exists.

## Design

### 1. Persistent reply keyboard

A `Markup.keyboard([['⏭ Next', '📋 Shortlist', '⚙️ Settings']]).resize()`,
exported as `MAIN_KEYBOARD` from `bot.ts`. Reply keyboards (unlike inline
keyboards) render under the input field and persist across every future
message until explicitly replaced — sending it once is enough.

**Where it gets attached:**
- `finishOnboarding` (`bot.ts:319-335`): the "Preferences saved..."
  `sendMessage` call gets `...MAIN_KEYBOARD` added to its extra args — this
  is the first message a newly-onboarded user sees after setup, so the
  keyboard appears from that point on.
- `bot.start`'s already-set-up branch (`bot.ts:342-347`): the "You're
  already set up..." reply also gets `...MAIN_KEYBOARD`, covering a user who
  ran `/start` again, or who set up before this feature shipped and never
  got the keyboard attached (Telegram doesn't retroactively add reply
  keyboards; the first post-deploy message that carries the markup is what
  seeds it into their client).

**Handling taps:** a reply-keyboard button press arrives as an ordinary text
message whose body equals the button's label. `bot.on('text')` currently
opens with `if (!answers) return;` (`bot.ts:388`) — silently dropping
anything sent outside onboarding, including these taps today. Add a branch
*before* that early-return: if `answers` is null/empty AND `ctx.message.text`
exactly matches one of the three keyboard labels, dispatch to the same logic
the matching command already runs, then return. To avoid duplicating that
logic, the bodies of `bot.command('next')`, `bot.command('shortlist')`, and
`bot.command('settings')` get extracted into three shared async functions
(`sendNextCard` already exists and is reused as-is; new `sendShortlistTo(ctx,
db)` and `startSettingsFor(ctx, db)` wrap the other two), called from both
the `bot.command(...)` handler and the new text-branch.

### 2. Single-level undo

**Data layer** (`db.ts`):

```ts
export interface LastSwipe {
  listingId: string;
  direction: 'like' | 'pass';
}

/** The most recent swipe recorded for a chat, or null if they haven't swiped yet. */
export function getLastSwipe(db: DB, chatId: number): LastSwipe | null { ... }

/**
 * Reverses a swipe — but ONLY if `listingId` is still that chat's most recent
 * swipe (guards a stale Undo button after several more swipes happened in
 * between: the button always targets one specific listing, but "undo" as a
 * concept only ever means "undo the last one"). Deletes the `swipes` row
 * (making the listing eligible for /next again) and, if it was a 'like',
 * the `shortlist` row it created. Returns false (no-op) if the check fails.
 */
export function undoSwipe(db: DB, chatId: number, listingId: string): boolean { ... }
```

Ordering uses `swipes.swiped_at` (already populated via
`new Date().toISOString()` on every `recordSwipe` call) — `ORDER BY
swiped_at DESC LIMIT 1`.

**Bot layer** (`bot.ts`):

- `clearSwipedCardButtons` (`bot.ts:296-316`) gains an optional 4th
  parameter, `undoButton?: ReturnType<typeof Markup.button.callback>`. When
  given, the message is edited to `Markup.inlineKeyboard([undoButton])`
  instead of the current empty markup — the status text (`✅ Added to
  shortlist` / `👎 Passed`) is unchanged, the card just keeps exactly one
  live button instead of zero.
- The `like`/`pass` action handler (`bot.ts:418-430`) builds
  `Markup.button.callback('↩️ Undo', \`undo:${listingId}\`)` and passes it to
  `clearSwipedCardButtons` on both branches (the normal save/pass path and
  the "no longer available" path from the prior feature — undoing still
  makes sense there, it just removes the `swipes` row with nothing to
  unwind in `shortlist`).
- The `unlike` (shortlist Remove) handler (`bot.ts:432-437`) is untouched —
  Remove isn't part of "last swipe" semantics, no undo button there.
- New handler:

```ts
bot.action(/^undo:(.+)$/, async (ctx) => {
  const [, listingId] = ctx.match;
  const chatId = ctx.chat!.id;
  const undone = undoSwipe(db, chatId, listingId);
  if (!undone) {
    await ctx.answerCbQuery('You can only undo your most recent swipe.');
    return; // leave the button and status text as they are
  }
  await ctx.answerCbQuery('Swipe undone ↩️');
  await clearSwipedCardButtons(ctx, '↩️ Undone'); // no undoButton arg — final state, nothing left to undo
});
```

`appendSwipeStatus` (already exported, unchanged) still governs whether the
edit lands on `caption` vs `text` vs replaces the album-companion
placeholder wholesale — undo reuses it exactly like every other status
update.

## Error handling

- Undo's staleness check is a pure DB read-then-conditional-delete inside
  one `better-sqlite3` call path (synchronous, no interleaving window) — no
  race between the check and the delete.
- `clearSwipedCardButtons` stays best-effort or the edit can still fail
  silently (message too old/deleted) exactly as it does today; an undo tap
  on such a message just gets Telegram's own stale-callback error, nothing
  new to handle.
- The reply-keyboard text-branch only ever matches the three exact button
  labels — any other free text outside onboarding still falls through
  unchanged (silently ignored, matching current behavior).

## Testing

- `getLastSwipe`/`undoSwipe`: unit tests against an in-memory DB — ordering
  by `swiped_at`, the shortlist-row cleanup on undoing a 'like', the no-op
  behavior on undoing a 'pass', and the staleness guard (swipe again, then
  attempt to undo the earlier one — must return false and change nothing).
- `clearSwipedCardButtons`'s new optional-button behavior: extend existing
  tests (or add new ones) asserting the edited message's markup contains
  exactly the one button when `undoButton` is passed, and is empty when it
  isn't (unchanged default).
- The reply-keyboard text-branch: a table-driven test per label confirming
  it dispatches to the right shared function, plus a control case (onboarding
  in progress, text happens to match a label) confirming onboarding still
  takes priority and the label is treated as a regular onboarding answer —
  this only applies to the WG/waitlist yes/no steps where a stray match is
  implausible, but the precedence must still be explicit and tested.
- `bot.action(/^undo:(.+)$/...)`: tests for both branches — undo succeeds on
  the true last swipe, and undo silently no-ops (with the "only your most
  recent" reply) on a stale target.
