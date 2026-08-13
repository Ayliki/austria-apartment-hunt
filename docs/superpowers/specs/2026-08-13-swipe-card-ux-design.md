# Swipe-card UX: live buttons + shortlist browsing

## Problem

Two UX papercuts in the Telegram bot:

1. After tapping 👍/👎, the buttons on that card stay live forever — Telegram
   never removes an inline keyboard on its own. Old cards sitting in chat
   history are still tappable, and tapping one re-fires `recordSwipe` on an
   already-decided listing.
2. `/shortlist` dumps every liked listing as one text-only message
   (`lines.join('\n\n')`) — no photos, no way to browse one at a time, no way
   to remove an item.

## Design

### 1. Clear buttons on swipe

`bot.action` handlers run from a Telegram callback query, which carries a
reference to the exact message the button lives on
(`ctx.callbackQuery.message`). No new state needs to be stored — the handler
edits that message directly:

- Strips the inline keyboard (`Markup.inlineKeyboard([])`).
- Replaces the placeholder/caption text with a short status line: `✅ Added
  to shortlist`, `👎 Passed`, or `🗑️ Removed`.

A card ships as one of three message shapes depending on `card.images.length`
(mirrors `sendCard`'s existing branching):

- **≥2 images**: buttons live on a standalone message whose entire text is a
  placeholder (`👍 or 👎?` today, `🗑️ to remove` for shortlist cards) — that
  placeholder is replaced wholesale by the status.
- **1 image**: buttons live on the photo's caption, which holds the full card
  text — the status is appended (`\n\n✅ Added to shortlist`).
- **0 images**: buttons live on a text message with the full card text — same
  append behavior as the caption case.

A pure `appendSwipeStatus(originalText, status)` decides append-vs-replace by
comparing `originalText` against the two known placeholder strings — testable
without touching Telegram at all. The edit itself is wrapped in try/catch and
never blocks sending the next card: editing an old/deleted message can fail,
and that failure shouldn't break the swipe flow.

### 2. Refactor card-sending to share the 3-way branch

`sendCard` (swipe deck: 👍/👎 buttons) and the new `sendShortlistCard`
(shortlist: single 🗑️ Remove button) both need the same image-count
branching. Extracted into a shared `sendListingCard(telegram, chatId, card,
caption, buttons, groupPromptText)` so the branching logic isn't duplicated.
`sendCard`'s existing signature and behavior are unchanged — this is a pure
extraction.

### 3. `/shortlist` sends real cards

`getShortlist` already returns rows ordered newest-first — no change needed
there. `/shortlist` now loops over up to `MAX_SHORTLIST_CARDS = 20` items and
sends each via `sendShortlistCard` (photo/caption, no commute line — avoids
an extra Routes API call per item on every `/shortlist` invocation). Each
card gets one 🗑️ Remove button (`unlike:<id>`). If there are more than 20,
a trailing message says how many were left out and points at `/settings` to
narrow prefs. Empty-shortlist message is unchanged.

### 4. Remove action

New `removeFromShortlist(db, chatId, listingId)` deletes only the
`shortlist` row — the `swipes` row (and its `like` direction) stays intact,
so the listing remains excluded from future `/next` candidates. This matches
how a 👎 pass already behaves: once decided, a listing doesn't resurface.
New `bot.action(/^unlike:(.+)$/, ...)` handler calls it, then clears that
card's button via the same mechanism as #1.

## Testing

- `appendSwipeStatus`: replace-on-placeholder, append-otherwise, for both
  known placeholder strings.
- `sendListingCard` / `sendCard` / `sendShortlistCard`: existing `sendCard`
  tests continue to pass unchanged (pure refactor); new tests cover
  `sendShortlistCard`'s three image-count branches and its Remove button.
- `removeFromShortlist`: deletes the shortlist row, leaves the swipe row
  (direction `like`) intact, listing stays out of `getCandidateListings`.
- Handler-level (via the existing `createTestBot` harness): tapping 👍/👎
  edits the originating message (keyboard gone, status text present);
  `/shortlist` sends one card per liked item with a Remove button; tapping
  Remove deletes the shortlist entry and edits that card to `🗑️ Removed`.

## Out of scope

- Commute ETA on shortlist cards (adds a Routes API call per `/shortlist`
  call; not requested).
- Pagination beyond the 20-item cap (a "show more" flow) — flagged via the
  trailing message instead, matching the enrichment-cap pattern elsewhere in
  the codebase.
