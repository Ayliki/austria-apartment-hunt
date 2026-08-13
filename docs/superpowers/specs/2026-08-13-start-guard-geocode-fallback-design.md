# /start guard + geocode fallback for commute ETAs

## Problem

Two deferred items from earlier today:

1. `/start` always wipes into onboarding from scratch, even for an
   already-configured chat — no warning, no confirmation.
2. Commute ETAs only ever show for listings with `lat`/`lon`, which requires
   enrichment. Some advertisers (verified: Rustler Immobilientreuhand) never
   publish coordinates at all, so their listings can never get an ETA even
   though they usually do have a plain-text address.

## Design

### 1. `/start` guard

No new state needed — `/settings` already exists as the unguarded "redo
everything" command. `/start`'s behavior splits on whether prefs already
exist for this chat:

- **No prefs yet** (first time): unchanged — starts onboarding immediately.
- **Prefs already exist**: instead of resetting onboarding, replies with a
  short message pointing at `/next`, `/shortlist`, and `/settings` (the
  actual "redo" command). `/start` stops double-functioning as "restart";
  that's `/settings`'s job now.

### 2. Geocode fallback for commute ETAs

apt-hunter's `NormalizedListing.addressLine` (willhaben: detail address or
search-hit location; immoscout: raw address) is parsed today but never
stored — swipe-bot's `listings` table has no address column at all. Adding
one closes that gap:

- New `address_line` column (migration, existing pattern), stored on insert.
- `getCommuteLineFor` gains a `geocode: GeocodeFn` parameter. When
  `listing.lat`/`lon` are null but `listing.addressLine` is present, it
  geocodes the address, and on success **persists the resolved coordinates
  onto the listing row** (`setListingCoords`) before computing the commute —
  so the geocode call happens once per listing, ever, not once per
  view/user, the same caching discipline `commute_cache` already applies to
  Routes API calls.
- All three call sites (`sendNextCard` in bot.ts, `notify.ts`,
  `mcp-server.ts`) pass `deps.geocode` through.
- Failure mode unchanged: no address, or geocode fails → no commute line,
  same as today.

## Testing

- `/start` guard: handler-level test for both branches (no prefs → normal
  onboarding start; prefs exist → informational reply, onboarding state
  untouched).
- `address_line` migration: backward-compat test in the existing style
  (drop the column, reopen, must not throw).
- `getCommuteLineFor`: geocode-fallback success (persists coords, returns a
  line), geocode failure (returns null, doesn't persist garbage), no
  address at all (returns null without calling geocode), and — already
  covered — the existing has-coords path is unaffected.

## Out of scope

- Re-geocoding a listing whose address was wrong the first time (no retry
  logic) — same one-shot-cache philosophy as the Routes API cache.
