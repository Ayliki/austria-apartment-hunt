# Shortlist browsing: one card at a time, in place

## Problem

`/shortlist` (`sendShortlistTo` in `bot.ts`) currently sends every saved
listing as its own full card (up to `MAX_SHORTLIST_CARDS` = 20), each with
photos and a Remove button. A shortlist of even a handful of items floods
the chat with a burst of messages — exactly the complaint: "it just spams
you with all of the listings you liked."

## Goals

- Browsing the shortlist should read and feel like flipping through one
  deck, not receiving a mail dump.
- The whole browsing session should live in **one message** in the chat —
  paging with ◀️ Prev / ▶️ Next edits that message in place rather than
  sending a new one each tap. Sending a fresh message per tap would still
  flood the chat over the course of a browse, just spread out instead of
  instant — that defeats the purpose as much as the current behavior.
- Removing an item should feel continuous: the same message advances to
  show what's now in that position, no separate "Removed" screen to click
  past.
- A position indicator ("❤️ 3 of 12") so the user knows where they are and
  how much is left.

## Non-goals

- Full multi-photo albums while browsing. Deliberately scoped to the
  first photo only — the tradeoff that makes true in-place editing
  possible (see Design). The listing's full album and details remain one
  tap away via the URL already in the caption.
- Preserving browse position across separate `/shortlist` invocations —
  every fresh `/shortlist` (or 📋 Shortlist keyboard tap) starts at the
  newest item (position 1). Out of scope; adds state-tracking complexity
  for a marginal benefit.
- Changing how the swipe deck (`/next`) or its Undo button work — those
  keep sending full albums, untouched by this spec.

## Design

### Why single-photo, and why that enables in-place editing

Telegram's Bot API can only edit a message's media in place
(`editMessageMedia`) when the message already *is* a single-media message,
and can only edit its text in place (`editMessageText`) when it's a
plain-text message — there is no API to convert one message type into the
other via edit, and no API to edit a media-group (album) into a different
album at all. Scoping shortlist browsing to one photo per listing (instead
of the swipe deck's full album) makes every card a single-photo-or-text
message, which is exactly the shape Telegram *can* edit in place. This is
the deliberate trade this spec makes to solve the actual complaint.

### Caption: position prefix

`formatCaption` (`bot.ts:166-181`) gains an optional third parameter:

```ts
export function formatCaption(l: ListingRow, commuteLine?: string | null, prefix?: string): string {
  // ... unchanged body ...
  const full = l.description ? `${base}\n\n${l.description}` : base;
  const withPrefix = prefix ? `${prefix}${full}` : full;
  return truncate(withPrefix, MAX_CAPTION_LENGTH);
}
```

Backward compatible — every existing call site omits the third argument
and behaves identically. Shortlist browsing calls it as `formatCaption(l,
null, '❤️ 3 of 12\n\n')`, and the prefix is included in the existing
1024-char truncation budget rather than risking overflow by appending
after the fact.

### Buttons

A pure helper builds the row, omitting Prev/Next at the ends instead of
disabling them (Telegram has no disabled-button state) or wrapping around:

```ts
export function shortlistNavButtons(listingId: string, position: number, total: number) {
  const row = [];
  if (position > 1) row.push(Markup.button.callback('◀️ Prev', `slnav:prev:${listingId}`));
  row.push(Markup.button.callback('🗑️ Remove', `unlike:${listingId}`));
  if (position < total) row.push(Markup.button.callback('▶️ Next', `slnav:next:${listingId}`));
  return Markup.inlineKeyboard([row]);
}
```

### Sending the first card

`sendShortlistTo` (currently loops over up to 20 items) becomes:

```ts
async function sendShortlistTo(telegram: Telegraf['telegram'], chatId: number, db: DB): Promise<void> {
  const items = getShortlist(db, chatId);
  if (items.length === 0) {
    await telegram.sendMessage(chatId, 'Your shortlist is empty — 👍 a card to save it here.');
    return;
  }
  await sendShortlistBrowseCard(telegram, chatId, items[0], 1, items.length);
}
```

`sendShortlistBrowseCard` sends exactly one photo (`listing.images[0]`) or
falls back to text, mirroring the existing no-photo pattern used elsewhere
in the file. `MAX_SHORTLIST_CARDS` and the "...and N more" message are
removed entirely — there's no cap to speak of once only one item is ever
shown at a time.

### Navigating: edit in place

A new action handler, `bot.action(/^slnav:(prev|next):(.+)$/, ...)`:

- Re-fetches `getShortlist(db, chatId)` fresh on every tap (never trusts a
  stored index — the list can change between taps, e.g. another swipe
  happening elsewhere, or a background delisting sweep).
- Finds the tapped card's current index by `listingId`. If it's no longer
  in the list at all (removed via some other path since this card was
  shown), replies via `answerCbQuery` and does nothing further.
- Moves one position in the requested direction. If that would go past
  either end (shouldn't normally happen, since the button is omitted at
  the ends, but a stale render or a shrunk list makes it reachable),
  refuses with a distinct `answerCbQuery` message and changes nothing —
  same "refuse, don't silently misapply" pattern used by
  `undoSwipe`/the `undo:` handler.
- Otherwise edits the current message in place to the new position via a
  shared `replaceShortlistCard` helper (below).

### Removing: advance in place

The existing `unlike:...` handler is the only place Remove ever fires from
now (shortlist browsing is its sole caller). It's rewritten to advance the
same message to whatever now occupies the removed item's position, instead
of just clearing to a static "Removed" line:

```ts
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

`removedIndex` is computed from the list *before* removal (so it reflects
where the removed card actually was), then clamped into the *post-removal*
list — this lands on "the item that slid into the removed one's old slot,"
or the new last item if the removed card was last.

### The type-transition problem

A single card can be photo-backed or (rare, but real) text-only. Telegram
allows in-place editing only within the same type:

| Current message | Target listing | Operation |
|---|---|---|
| photo | has a photo | `editMessageMedia({ type: 'photo', media, caption }, buttons)` |
| text | no photo | `editMessageText(text, buttons)` |
| photo | no photo | **can't edit across types** — delete + send |
| text | has a photo | **can't edit across types** — delete + send |

`replaceShortlistCard(ctx, listing, position, total)` implements exactly
this table: reads `ctx.callbackQuery.message.photo` to know the current
type, compares against `listing.images.length > 0` for the target type,
edits when they match, and falls back to `ctx.deleteMessage()` followed by
a fresh `ctx.telegram.sendPhoto`/`sendMessage` when they don't — preserving
the "browsing lives in one message" property even across that edge case
(briefly two messages exist only for the instant between delete and send;
from the user's perspective the old card disappears and a new one appears
where the buttons were tapped).

`replaceShortlistWithEmptyState(ctx)` (the empty-shortlist-after-removing-
the-last-item case) always deletes and sends fresh, since there's no
"in-place" target type to match against — this is expected to be rare (the
user just removed their last save) and simplicity wins here.

Both helpers are best-effort like the existing `clearSwipedCardButtons`:
wrapped in try/catch, since editing/deleting a message that's too old,
already gone, or already edited must never throw and block the response.

### Dead code this removes

`sendShortlistCard` (the old per-item sender, `bot.ts:243-247`) has
exactly one call site — the loop inside `sendShortlistTo` — which this
spec removes. It becomes dead once that loop is gone, so it's deleted
outright, along with its doc comment's reference in `sendListingCard`'s
comment (`bot.ts:211`).

`REMOVE_PROMPT_TEXT` (`'🗑️ to remove'`, `bot.ts:203`) exists only to be
`sendListingCard`'s companion-message placeholder for a multi-photo
shortlist card — a shape that can no longer occur once shortlist browsing
only ever shows one photo. It's deleted, and `GROUP_PLACEHOLDER_TEXTS`
(`bot.ts:204`) shrinks to `[SWIPE_PROMPT_TEXT]` — still an array, since a
future feature could plausibly add another placeholder type, but with the
now-unreachable case gone. The existing test asserting `appendSwipeStatus`
treats `'🗑️ to remove'` as a placeholder (`bot.test.ts:132`) is removed
along with it — that input can no longer occur — while the sibling
assertion for `SWIPE_PROMPT_TEXT` (`bot.test.ts:131`) stays.

## Error handling

- Every mutation (`removeFromShortlist`, the position lookups) reads from
  `better-sqlite3` synchronously — no interleaving window between "read the
  list to find the removed index" and "remove" and "read the list again."
- A stale Prev/Next tap on a card that's since fallen out of the shortlist
  (found via the fresh re-fetch) is refused with a clear reply, never
  silently jumps to an unrelated position.
- `replaceShortlistCard`/`replaceShortlistWithEmptyState` swallow edit/
  delete failures exactly like `clearSwipedCardButtons` already does —
  best-effort, never blocks.

## Testing

- `formatCaption`'s new `prefix` parameter: a test confirming it's
  included in the output and respects the same 1024-char truncation
  budget (a long description plus a position prefix still truncates to
  exactly 1024, not 1024-plus-prefix-length).
- `shortlistNavButtons`: table-driven — first item (no Prev), last item (no
  Next), middle item (both), single-item shortlist (neither, Remove only).
- `sendShortlistTo`: sends exactly one card (position "1 of N") for a
  non-empty shortlist, the existing empty-state message for an empty one —
  extends/replaces the current "/shortlist sends one card per liked
  listing..." test, which no longer holds once only one is ever sent.
- `slnav:` handler: Next from position 1 of 3 moves to 2 of 3 (edited in
  place, not a new message); Prev at position 1 is refused; a target whose
  type differs from the current message's type goes through delete+send
  instead of edit (assert both a `deleteMessage` call and a fresh
  `sendPhoto`/`sendMessage` call happen, no `editMessageMedia`/
  `editMessageText` call).
- `unlike:` handler (rewritten): removing a middle item advances in place
  to the item that slid into its slot; removing the last item advances to
  the new last item (position count decreases); removing the only
  remaining item shows the empty-state message via delete+send.
