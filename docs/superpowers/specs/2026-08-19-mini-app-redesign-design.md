# swipe-bot: Telegram Mini App + Quiet Notifier Redesign

**Status:** Approved for planning
**Date:** 2026-08-19
**Scope:** `austria-apartment-hunt/swipe-bot/`, new `austria-apartment-hunt/mini-app/`

## Problem

Three complaints, all confirmed against the code rather than inferred.

### 1. The bot spams

`index.ts` polls every 3h (8x/day). Every poll calls `notifyNewMatches`, which
iterates **every** saved profile. `notify.ts` deliberately ignores the `active`
flag, documented in its own comment: *"every saved search stays live for
polling/pushing... `active` is not a pause switch."* There is consequently **no
way to pause a saved search** short of deleting it.

Per profile, per poll, the ceiling is 1 header + 5 full cards
(`MAX_PUSH_PER_USER`) + 1 "and N more". Any card with >=2 photos costs *two*
messages, because `sendMediaGroup` cannot carry an inline keyboard, so
`sendListingCard` sends the album and then a second message whose entire
content is the string `👍 or 👎?`.

Worst case: ~12 messages and up to 50 photos per profile per poll. Three saved
searches, eight polls a day, is ~36 messages and ~150 photos daily. There are
no quiet hours, no digest, no quality threshold, and no daily cap.

Note that the 2026-08-16 onboarding/results spec set out to fix a "dump"
problem in this same code path. Its resolution — pacing bursts and sending
*full* cards in pushes rather than compact lines (commits `b3971bd`, `2e163ba`)
— improved fidelity but increased volume. This spec reverses that trade
deliberately: fidelity moves to the Mini App, and chat goes quiet.

### 2. Browsing is a flat dump

Pushes are a header followed by N cards in the scrollback, with no ranking
context, no map, no comparison, and no persistence once scrolled past.
`/shortlist` is strictly one-at-a-time: `sendShortlistBrowseCard` sends a
**single** photo and Prev/Next edits that message in place — necessarily, since
Telegram cannot edit an album. Liked flats can therefore never be viewed as a
set. There is no grid, sort, filter, or map anywhere in the product.

### 3. Cards carry too much, and photos fail

`formatCaption` concatenates title, price, size/rooms/district, waitlist
warning, WG warning, delisted warning, amenities, pet badge, commute line, URL,
and the advertiser's **full raw description**, then hard-truncates the whole
thing to Telegram's 1024-character caption cap, mid-word, with an ellipsis. It
emits plain text with no formatting, so critical fields and marketing copy have
identical visual weight.

Photos fail for three independent reasons:

- **No `file_id` caching.** Images are stored as remote URLs (`db.ts:52`) and
  handed to Telegram on every send, so Telegram re-fetches from the willhaben /
  ImmoScout CDN every single time. A slow host, an expired URL, or a redirect
  silently drops the image.
- **`sendMediaGroup` is atomic.** One dead URL fails the entire album with
  `400 Bad Request: group send failed`. This is documented upstream Telegram
  behaviour (telegraf#1481, python-telegram-bot#2917). This is the direct cause
  of "sometimes it doesn't load all the photos".
- **That failure is not caught.** In `notify.ts` the commute call is wrapped in
  `try/catch` but `await sendCard(...)` is not, so a single failing album throws
  and silently kills the remainder of that profile's push. Listings the user
  never sees are a symptom of this.

## Goals

- Chat becomes a **notifier only**: bounded, pausable, quiet-hours-aware,
  daily-capped.
- Browsing moves into a **Telegram Mini App** with a swipe deck, grid, map, and
  a shortlist that is a set rather than a slideshow.
- Photos become reliable: no albums in chat, `file_id` caching, fail-soft
  sends, and browser-side image loading with an allowlisted proxy.
- Card information gains hierarchy and progressive disclosure instead of being
  concatenated and truncated.
- Net deletion from `bot.ts` (currently 976 lines) as the chat rendering paths
  lose their callers.

## Non-goals

- Rewriting willhaben/ImmoScout scraping, matching, dedup, or `apt-hunter`.
- Changing the learned ranking model in `scoring.ts` beyond exposing its score.
- A full monorepo `core` package extraction (approach C, considered and
  rejected as competing with user-facing fixes).
- Splitting bot and web into separate processes (approach B, rejected; revisit
  only if SQLite write contention becomes measurable).
- Translating scraped listing content. Locale work stays bot chrome + Mini App
  chrome only, consistent with the 2026-08-16 spec.

## Approach

**Approach A: one process, three faces.** The existing `swipe-bot` process
gains an HTTP server serving the built Mini App plus a JSON API, reading the
same `better-sqlite3` handle the bot and poller already hold. One systemd unit,
one deploy, unchanged deploy story. `mcp-server.ts` is untouched and remains a
fourth face onto the same DB.

Rejected: **B** (two processes sharing `bot.sqlite` over WAL) buys failure
isolation not needed at this scale, at the cost of two deploy targets. **C**
(extract shared `core` package) is architecturally correct but is a large
refactor competing with the fixes that actually make the bot pleasant. A
targeted slice of C is folded in below, since the work touches those files
anyway.

Hosting is a **Cloudflare Tunnel** to `localhost:PORT` on `swipe-bot-vm`. No
nginx, no certbot, no firewall changes, no static IP requirement.

## Design

### Notifications

New tables, added via the existing additive `migrate()` pattern in `db.ts`.
Defaults are chosen so current users land on sane settings without configuring
anything. All times are Europe/Vienna.

```sql
CREATE TABLE notify_settings (
  profile_id         INTEGER PRIMARY KEY,
  paused             INTEGER NOT NULL DEFAULT 0,
  instant_enabled    INTEGER NOT NULL DEFAULT 1,
  instant_percentile REAL    NOT NULL DEFAULT 0.10,
  digest_hours       TEXT    NOT NULL DEFAULT '9,19',
  quiet_start        INTEGER NOT NULL DEFAULT 22,
  quiet_end          INTEGER NOT NULL DEFAULT 8,
  daily_cap          INTEGER NOT NULL DEFAULT 6
);

CREATE TABLE notify_log (
  profile_id INTEGER NOT NULL,
  listing_id TEXT    NOT NULL,
  kind       TEXT    NOT NULL,  -- 'instant' | 'digest'
  sent_at    TEXT    NOT NULL,
  PRIMARY KEY (profile_id, listing_id)
);
```

`paused` closes the gap `notify.ts` documents today. A paused profile still
polls and still accumulates matches in the Mini App; it simply never messages.

**Defining "top match".** `rankListings` computes a score and discards it.
Export `scoreListings(): {listing, score}[]` and reduce `rankListings` to a
one-line wrapper over it.

An absolute score cutoff would be meaningless: cold-start scores take only the
values 0, 0.5, and 1 (`valueScoreOf`), and warm scores cluster tightly around
0.5 because `learnedScoreOf` averages six Laplace-smoothed bucket rates.
Instant-worthy is therefore defined **relatively**: a listing is instant-worthy
if its score falls in the top `instant_percentile` of that profile's matched
listings over the trailing 30 days, **and** `valueFlag === 'good'`. Below
`COLD_START_THRESHOLD` (15) swipes this degrades honestly to "flagged good
value", which is exactly what the cold-start branch already computes.

**Delivery.** `notifyNewMatches` becomes `dispatchNotifications`, run on the
poll tick:

- **Instant** — fires when the listing is instant-worthy, the profile is not
  paused, the current time is outside quiet hours, and `notify_log` shows fewer
  than `daily_cap` instant sends for that profile today. One message: a single
  hero photo, four lines of text, one **Open** button deep-linking into the
  Mini App. Never an album. Never a `👍 or 👎?` companion message.
- **Digest** — at each `digest_hours` boundary, one message per unpaused
  profile summarising everything matched since that profile's last digest and
  not already sent instantly. Text only, no photos, one **Open** button.
- **Quiet hours** — an instant send falling inside the window is not dropped;
  it rolls into the next digest.

Ceiling per profile per day drops from unbounded to `daily_cap + |digest_hours|`.

### Photos

Moving browsing into the Mini App dissolves most of the problem, because the
browser fetches images directly and Telegram's media pipeline leaves the loop.
What remains:

1. **No albums in chat, ever.** Only the instant ping carries an image, as a
   single `sendPhoto`. This structurally removes the atomic-album failure.
2. **`file_id` cache:**
   ```sql
   CREATE TABLE photo_cache (
     source_url TEXT PRIMARY KEY,
     file_id    TEXT,
     cached_at  TEXT NOT NULL,
     failed     INTEGER NOT NULL DEFAULT 0,
     last_error TEXT
   );
   ```
   The first successful send stores Telegram's returned `file_id`; later sends
   reuse it, so an origin is hit once per image ever rather than once per view.
3. **Fail soft.** `sendPhoto` is wrapped in `try/catch`, falling back to a
   text-only card, recording `failed = 1` and the error. A failed photo must
   never abort the rest of a dispatch.
4. **Image proxy.** `GET /api/img?u=…` on the VM, with a strict host allowlist
   covering only the willhaben and ImmoScout CDN hosts, so a hotlink-blocking
   or referer-checking origin cannot blank the carousel, and the endpoint
   cannot be used as an SSRF vector. Whether either CDN actually blocks
   hotlinking is **unverified**; implementation must check against real URLs.
   The proxy is the safe default regardless, and the client falls back to the
   direct URL if the proxy errors.

### Mini App

A fourth npm workspace, `mini-app/`, alongside `apt-hunter`, `immoscout-mcp`,
`swipe-bot`, `willhaben-mcp-patched`. Vite + React + TypeScript, built to
`mini-app/dist` and served as static files by the bot process.

Telegram integration uses the raw `telegram-web-app.js` script behind a thin
typed wrapper rather than an SDK dependency; the needed surface is only
`initData`, `themeParams`, `BackButton`, `HapticFeedback`, and `expand()`.

The HTTP layer uses `express` (one new dependency) rather than hand-rolling
static serving, MIME types, and range requests over `node:http`.

**Deck** (primary view) inherits the existing ranking. Real swipe gestures,
with the 👍/👎 buttons retained for reachability, a photo carousel, and haptics.
Information hierarchy replaces truncation: price, size, rooms, district, and
commute always visible; amenities, waitlist/WG warnings, and value badge below
the fold; the advertiser's full description behind a `▾ more` tap. Nothing is
cut at 1024 characters because nothing must fit a Telegram caption.

**Grid** is 2-column, score-ordered, infinite scroll, with filter chips.

**Map** uses Leaflet with OpenStreetMap tiles, deliberately not Google Maps:
Routes API quota is already a cost and adding Maps JS billing for a pin layer
is not justified. Listings without coordinates cannot be pinned, so the map
shows a persistent "N without location" chip that opens the grid filtered to
exactly those. This matters because some willhaben advertisers publish no
coordinates and `getCommuteLineFor`'s geocode fallback can also fail.

**Shortlist** becomes a set: grid, sort by price / EUR-per-m2 / commute, and a
two-up compare.

Theming reads Telegram's `themeParams` CSS variables so the app follows the
user's own Telegram light/dark theme.

### What this removes from `bot.ts`

`sendShortlistBrowseCard`, `shortlistNavButtons`, `buildMediaGroup`,
`sendListingCard`'s album branch, `SWIPE_PROMPT_TEXT`, and `appendSwipeStatus`
all lose their callers. `/next` and `/shortlist` survive as one-line redirects
that open the Mini App. `MAIN_KEYBOARD` becomes a single `web_app` button, and
`setChatMenuButton` points the persistent ☰ menu at the Mini App.

The remainder of `bot.ts` is wizard, settings, and notification chrome, which
splits cleanly into `wizard-ui.ts` and `notify-ui.ts`. This is the targeted
slice of approach C referred to above.

### State and failure

SQLite on the VM remains the single source of truth. Like/pass is optimistic in
the UI with rollback on error. The deck prefetches the next several cards and
preloads the following card's first image.

**Known risk:** the Mini App and the bot now write to the same SQLite file from
the same process, so the poller's insert burst and a user's swipe are no longer
separated in time, and `better-sqlite3` is synchronous. At current row counts
this is milliseconds. Mitigation: wrap the poller's insert loop in a single
transaction. If contention becomes measurable, revisit approach B.

### Auth

Every API request carries `Authorization: tma <initData>`. The server validates
per Telegram's specification: build the data-check string from sorted
`key=value` pairs excluding `hash`, derive
`secret_key = HMAC_SHA256("WebAppData", bot_token)`, compare
`HMAC_SHA256(secret_key, data_check_string)` against `hash` in **constant
time**, and reject any `auth_date` older than 24h.

Stateless: no session store, no cookies, no CSRF surface. The validated user id
is the only identity the API trusts. No client-supplied profile id selects data
without an ownership check against that user id.

### Identity defect found during design

`bot.ts` keys all state on `ctx.chat.id` and **never checks `chat.type`** (all
20 call sites verified). In a private chat this equals the user id, so the Mini
App resolves correctly. In a group, `chat.id` is the group's negative id, while
`initData` only ever supplies `user.id` — such profiles would be unreachable
from the Mini App, and are today shared by every group member.

Required handling:

1. Add an explicit private-chat guard to the bot; non-private chats get a
   "direct message only" reply and create no profiles.
2. **Pre-flight, before shipping:** query the production `bot.sqlite` for
   `SELECT COUNT(*) FROM search_profiles WHERE chat_id < 0`. Do not assume this
   is zero. If rows exist, decide migration or abandonment explicitly.

`MCP_CHAT_ID = 0` is already a carved-out sentinel and remains excluded.

### API surface

```
GET    /api/me                        profiles, active, language, notify settings
GET    /api/deck?profileId&limit      ranked unswiped cards, with score
POST   /api/swipe                     {listingId, direction}
DELETE /api/swipe/:listingId          undo (undoSwipe already exists)
GET    /api/listings?profileId&sort&… grid, filtered + paged
GET    /api/listings/geo?profileId    map pins: id, lat, lon, price only
GET    /api/listings/:id              detail, full untruncated description
GET    /api/shortlist?profileId
DELETE /api/shortlist/:listingId
GET    /api/notify-settings?profileId
PATCH  /api/notify-settings/:profileId
POST   /api/profiles
PATCH  /api/profiles/:id
DELETE /api/profiles/:id
GET    /api/img?u=…                   allowlisted CDN proxy
```

Bodies and query parameters are validated with `zod`, already a dependency.

### Commute quota rule

Routes API calls cost money. `getCommuteLineFor` computes on demand and caches
into `commute_cache`.

**Rule:** `GET /api/listings` and `GET /api/listings/geo` **must read cached
commute values only and must never trigger a Routes call.** Only the deck's
currently-visible card and `GET /api/listings/:id` may compute a missing value.

Without this rule, opening the map once could fire hundreds of billable calls.
This is the single most likely way for this redesign to cost real money.

A small in-memory per-user token bucket also applies, since the API is now
reachable over the public internet rather than only via Telegram's own limits.

## Testing

Existing harness is `node --import tsx --test test/*.test.ts`. Continue it.

- Percentile selection, quiet-hours rollover, daily-cap enforcement, and
  digest-boundary logic are written as **pure functions over an injected
  clock**, testable without Telegram or real timers — mirroring how
  `PUSH_STAGGER_MS` already injects a `DelayFn`.
- `initData` validation gets unit tests against a fixture generated from a
  known token, covering valid, tampered, expired, and missing-`hash` cases.
- Endpoints are tested by booting the express app on an ephemeral port and
  driving it with `fetch` under `node --test`.
- A dedicated test asserts the grid and geo handlers **never** call the
  injected `computeCommute`.
- `photo_cache` behaviour: `file_id` reuse on second send, and fail-soft
  fallback to text when `sendPhoto` rejects.
- Private-chat guard: a group-chat update creates no profile.

## Sequencing

Phase 1 ships independently of the Mini App and is the priority, since it is
what makes the bot unpleasant today:

1. **Notifications + photos** — `notify_settings`, `notify_log`, `photo_cache`,
   `scoreListings`, `dispatchNotifications`, no-albums-in-chat, fail-soft
   sends, pause switch.
2. **Server foundation** — express, `initData` auth, private-chat guard,
   pre-flight negative-`chat_id` check, image proxy, Cloudflare Tunnel unit.
3. **Mini App: deck** — plus the `bot.ts` deletions and the `web_app` button.
4. **Mini App: grid, map, shortlist, settings.**

## Open questions

None blocking. One item requires verification during implementation rather
than design: whether the willhaben and ImmoScout CDNs block hotlinking, which
determines whether the image proxy is load-bearing or belt-and-braces.
