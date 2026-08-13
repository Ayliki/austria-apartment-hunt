# Listing photo/address refresh + delisting cleanup

## Problem

Existing rows in `listings` were inserted once (`INSERT OR IGNORE`) and never
touched again. Two consequences:

1. Photos: rows inserted while the vendored `willhaben-mcp` still hardcapped
   images at 5 (fixed in 091ff55, now capped at 10 — Telegram's own album
   ceiling) are stuck showing only their original (possibly truncated) photo
   set. Same for `address_line` on the 338 rows inserted before that column
   existed (added in c53d13f) — they never got a chance to pick up an address
   for the commute-ETA geocode fallback.
2. Delisting: nothing ever notices when a listing is taken down by its
   advertiser. Swiped-away rows linger in the DB forever, and — worse — a
   listing can still surface via `/next` or a push notification for a user
   who hasn't swiped it yet, even though it's already gone from the site.

## Goals

- Refresh `images` and `address_line` (and `lat`/`lon` where the source
  provides them directly) for every row already in the DB, once, and then
  keep them fresh as a standing habit — not required, since sources rarely
  change these after listing, but doing it as part of the same sweep is free.
- Detect listings that have been taken off the site and stop showing them
  for swiping, while not silently erasing a listing a user has shortlisted.
- Never confuse "the site rate-limited us" or "the network hiccuped" with
  "the listing is actually gone."

## Non-goals

- Refreshing `price`, `title`, `rooms`, `area`, or other fields that could
  legitimately change — out of scope, and re-scoring on price drift is a
  separate feature if ever wanted.
- Eagerly calling the Google Geocoding API from this sweep. The bot already
  lazily geocodes `address_line` → `lat`/`lon` on first card view
  (`getCommuteLineFor` → `updateListingCoords` in `bot.ts`) and caches the
  result on the row. Backfilling `address_line` is enough to make that
  existing path kick in for old rows too.

## Design

### New module: `swipe-bot/src/refresh.ts`

`refreshAllListings(db, deps): Promise<RefreshSummary>` — the single function
used both for the initial backfill and every later sweep (there is no
separate one-off script; the first process start after this ships *is* the
backfill, the same way `poller.ts`'s `poll()` seeds the DB on first launch).

For each source (`willhaben`, `immoscout`), it opens one persistent MCP
connection (mirroring `hunt.ts`'s pattern — one connection reused across many
calls, not one process per call) and iterates every row of that source in
`listings`, oldest `first_seen` first. Between calls it waits ~300ms — 361
rows at that pace is under two minutes, comfortably inside the 24h window and
gentle on the source.

**Per row:**

1. Call `willhaben_get_listing` / `immoscout_get_listing` for the row's id.
2. **Not found** (willhaben: `isError: true` with body containing
   "not found"; immoscout: thrown message containing "404" or "no Expose"
   — see Classifying failures below) → set `is_delisted = 1`. Leave
   `images`/`address_line` untouched (nothing to update from a dead page).
3. **Success** → update `images` from the fresh detail payload; update
   `address_line` (willhaben: parsed `address` field; immoscout: `address`
   field from `getListing`); for willhaben only, also update `lat`/`lon`
   from the parsed coordinates (immoscout's detail payload never carries
   them — that's what the existing geocode fallback is for). Set
   `is_delisted = 0` (covers a listing that was flagged delisted by a past
   transient misfire, or came back).
4. **Any other error** (network, parse failure, rate limit) → leave the row
   entirely untouched. It gets tried again on the next sweep.

**After the per-row pass**, delete every row where `is_delisted = 1` and the
row's id does not appear in `shortlist` for any `chat_id` — along with its
`swipes` and `commute_cache` rows (no FKs in this schema, so these are
explicit `DELETE ... WHERE listing_id = ?` calls). Rows that *are* shortlisted
by someone stay in the DB, flagged, so `/shortlist` can still render them.

Returns a summary (`{checked, updated, delisted, deleted, errored}` per
source) that gets logged the same way `runPoll`'s warnings are today.

### Classifying failures

A small pure helper, `classifyGetListingError(source, error): 'not-found' |
'transient'`, string-matches the thrown `Error.message` (which — per
`McpConnection.callToolText` — is always `` `${tool} failed: ${text}` `` on
`isError`, or the raw thrown error otherwise):

- `willhaben`: `'not-found'` iff the message contains `"not found"`.
- `immoscout`: `'not-found'` iff the message contains `"404"` or
  `"no Expose"`.
- Anything else → `'transient'`.

This is the one piece of genuinely new judgment logic in the feature, so it's
unit-tested directly against real captured error strings from both vendored
MCP servers rather than only the happy path.

### Schema change

```sql
ALTER TABLE listings ADD COLUMN is_delisted INTEGER NOT NULL DEFAULT 0;
```

Migrated the same way `address_line`/`lat`/`lon` were (`migrate()` in
`db.ts`, checked via `PRAGMA table_info`).

### Visibility changes

- `getAllListingIds` / whatever powers `/next`'s deck and `notify.ts`'s push
  path: add `WHERE is_delisted = 0`. A delisted listing never surfaces for
  swiping or as a push, whether or not it's still parked in the DB for
  someone's shortlist.
- `/shortlist` (`sendShortlistCard` in `bot.ts`): when rendering a row with
  `is_delisted = 1`, append `⚠️ No longer listed` to the caption/text (same
  place the WG/waitlist badges already get composed). The 🗑️ Remove button
  is untouched — removing a delisted listing from your shortlist still just
  deletes the `shortlist` row; if no one else has it shortlisted either, the
  *next* sweep's cleanup pass will delete the underlying `listings` row too.

### Wiring: `index.ts`

Same shape as the existing `poll`/`pollTimer` pair:

```ts
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const refresh = async () => {
  try {
    const summary = await refreshAllListings(db, deps);
    console.log('refresh:', summary);
  } catch (err) {
    console.error('refresh failed:', err);
  }
};
await refresh(); // first process start after this ships doubles as the backfill
const refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
```

`refreshTimer` gets cleared in the existing `shutdown()` alongside
`pollTimer`.

## Error handling

- A single row's fetch failure never aborts the sweep — caught per-row,
  logged, next row proceeds (mirrors `hunt.ts`'s per-hit try/catch).
- A whole-sweep failure (e.g. MCP process fails to spawn) is caught in
  `index.ts`'s `refresh()` wrapper exactly like `poll()`'s — logged, next
  scheduled run tries again. The bot keeps serving `/next` and `/shortlist`
  from whatever state the DB was already in.
- The delisted-vs-transient distinction is the load-bearing correctness
  property here: misclassifying a rate limit as "not found" would silently
  delete live listings out from under users. That's why it's the one part
  covered by dedicated unit tests against real error strings rather than
  inferred from the happy-path integration flow.

## Testing

- `classifyGetListingError`: table-driven unit test against real captured
  "not found" / 404 / generic-error strings from both vendored MCP servers.
- Cleanup-after-sweep logic (delete iff `is_delisted` and not in anyone's
  `shortlist`): unit test against an in-memory DB fixture, covering both the
  deleted and the retained-because-shortlisted cases.
- `sendShortlistCard` rendering: existing test pattern extended to assert the
  "no longer listed" badge appears iff `is_delisted = 1`.
- `/next` deck and `notify.ts` push path: existing tests extended to assert a
  delisted row is excluded.
