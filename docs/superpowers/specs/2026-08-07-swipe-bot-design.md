# Vienna Apartment Swipe Bot — Design

Status: approved for planning
Date: 2026-08-07

## Purpose

Turn `austria-apartment-hunt` from a one-shot "run a search, get a report" tool
into a continuously-fresh Telegram swipe experience: a background poller finds
new Vienna rental listings across willhaben + ImmoScout24, and each user
(you, and friends you share the bot with) swipes 👍/👎 on cards with photos and
key info. The bot learns per-user preferences from swipe history and uses that
to rank what it shows next — no LLM calls per swipe, so it stays cheap to run
for multiple people.

## Non-goals

- No auto-drafted inquiry messages on 👍 (that's Ilya's separate Python
  `apt-hunter` tool's job, not this one). 👍 only saves to a shortlist.
- No literal touch-swipe gesture — Telegram Bot API doesn't support that.
  Cards are a photo + inline 👍/👎 buttons, the standard TG "swipe bot" pattern.
- No auto-contacting landlords, no form automation.
- No hosting beyond your Mac for now (see Hosting below).
- No per-user LLM-based preference reasoning — scoring is a deterministic,
  auditable bucket-based formula (see Learning model).

## Repo structure change

`austria-apartment-hunt` becomes an npm workspace monorepo:

```
austria-apartment-hunt/
  package.json              # workspaces: ["apt-hunter", "immoscout-mcp", "swipe-bot"]
  immoscout-mcp/            # unchanged
  apt-hunter/                # unchanged CLI, but normalize/dedupe/score exported
                              #   as a library entrypoint (apt-hunter/src/index.ts)
                              #   for swipe-bot to import instead of duplicating
  swipe-bot/                 # new package
    src/
      db.ts                 # SQLite schema + queries (better-sqlite3)
      poller.ts             # scheduled fetch → normalize → dedupe → insert new listings
      scoring.ts             # per-user bucket scoring + rank formula
      bot.ts                 # Telegraf bot: /start onboarding, card serving, button handlers
      index.ts               # entrypoint: starts poller schedule + bot long-polling
    test/
      scoring.test.ts
      db.test.ts
      bot.test.ts            # Telegraf ctx mocked, no live Telegram connection
    data/
      bot.sqlite              # gitignored
    com.hq.swipe-bot.plist    # LaunchAgent, modeled on apt-hunter's existing plist
```

`apt-hunter`'s existing CLI/report-generation behavior is untouched — this is
additive (export the functions it already has, not a rewrite).

## Architecture

```
LaunchAgent (every 3h, matches existing apt-hunter cadence)
  → poller.ts: ONE broad Vienna-wide fetch per source (willhaben + immoscout),
    using a superset filter wide enough to cover all active users' criteria —
    not one query per user. Keeps request volume flat as users grow.
  → normalize + dedupe (imported from apt-hunter, unchanged logic)
  → INSERT OR IGNORE new listings into `listings` table (by source+id)

Telegram bot (long-polling via Telegraf, same LaunchAgent-managed process)
  → /start: onboarding conversation — budget (price_to, optional price_from),
    districts, rooms, size → upsert into `user_prefs` (keyed by Telegram chat id)
  → /settings: re-run onboarding to change prefs
  → next card: filter `listings` by that user's prefs, exclude anything already
    in their `swipes` table, rank remainder (see Learning model), send the
    top listing as photo + caption (price, district, size, rooms, link) +
    👍/👎 inline keyboard
  → button callback: INSERT into `swipes` (chat_id, listing_id, direction,
    swiped_at); 👍 also INSERT into `shortlist`; immediately send the next card
  → /shortlist: list saved 👍 listings (title, price, link) for that chat
  → /start safety notice: restate the standing rule — never pay/transfer money
    before an in-person viewing, avoid international transfers or escrow,
    only use the listing's official contact channel
```

## Data model (SQLite, `swipe-bot/data/bot.sqlite`)

```sql
CREATE TABLE listings (
  id TEXT PRIMARY KEY,          -- "willhaben:1234567890" / "immoscout:987654"
  source TEXT NOT NULL,
  title TEXT, price REAL, price_per_sqm REAL, area REAL, rooms REAL,
  district TEXT, floor TEXT, has_elevator INTEGER, landlord_type TEXT,
  images TEXT,                  -- JSON array of URLs
  url TEXT NOT NULL,
  value_flag TEXT,              -- 'good' | 'fair' | 'premium' from apt-hunter score.ts
  first_seen TEXT NOT NULL
);

CREATE TABLE user_prefs (
  chat_id INTEGER PRIMARY KEY,
  price_to REAL, price_from REAL,
  districts TEXT,                -- JSON array, e.g. ["1","6","7"]
  rooms_from REAL, rooms_to REAL,
  area_from REAL, area_to REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE swipes (
  chat_id INTEGER NOT NULL,
  listing_id TEXT NOT NULL,
  direction TEXT NOT NULL,       -- 'like' | 'pass'
  swiped_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, listing_id)
);

CREATE TABLE shortlist (
  chat_id INTEGER NOT NULL,
  listing_id TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (chat_id, listing_id)
);
```

## Learning model

No LLM calls, no external ML dependency — deterministic, explainable,
per-chat bucket scoring:

1. **Feature buckets** per listing: district, price band (€100-wide), room
   count (rounded), size band (10m²-wide), floor group (ground / mid / top),
   has_elevator, landlord_type, has_photos (bool).
2. **Per-user bucket stats**: for each (chat_id, feature, bucket_value) pair,
   maintain running like/pass counts, derived live from the `swipes` +
   `listings` join (no separate stats table — recomputed per query, cheap at
   this data scale).
3. **Bucket score** = Laplace-smoothed like-rate: `(likes + 1) / (likes + passes + 2)`.
   Untried buckets start neutral at 0.5; confidence grows with more swipes.
4. **Listing learned_score** = mean of its bucket scores.
5. **Final rank** = `0.6 * learned_score + 0.4 * value_score` (value_score from
   apt-hunter's existing €/m²-vs-median scoring, normalized to 0-1). This
   keeps genuinely good-value listings visible even before the model has
   enough swipe data on a user, and prevents a pure filter-bubble.
6. **Cold start**: below 15 total swipes for a user, rank by value_score alone
   — bucket data is too thin to trust yet.

## Error handling

- Per-source fetch failure (willhaben or immoscout blocked/down): poller logs
  a warning and continues with the other source, same as apt-hunter's
  existing `warnings` behavior. Never blocks card serving.
- Empty queue (user has swiped everything matching their prefs): bot replies
  "no new listings right now, check back after the next poll" rather than
  erroring.
- Telegram API errors (rate limit, network blip) on send: Telegraf's built-in
  retry; if it still fails, log and let the next `/start`-triggered card
  request retry naturally — no complex queue/retry infra needed.

## Legal / responsible-use posture

Unchanged from the existing README's stance, just reconfirmed for multi-user:

- One shared poll every 3h regardless of user count — never scales requests
  with the number of friends using the bot.
- Rate-limited enrichment (~1 req/sec), honest User-Agent — same as today.
- Framed as personal/friends-group use, not commercial or bulk harvesting.
- `/start` shows the safety notice every new user sees once.

## Testing

- `scoring.test.ts`: bucket score math (pure functions), cold-start
  threshold, rank formula — deterministic fixtures, no DB.
- `db.test.ts`: schema creation, insert/query against an in-memory SQLite DB
  (`:memory:`), "exclude already-swiped" query correctness.
- `bot.test.ts`: Telegraf `ctx` mocked (fake chat id, fake button callback
  payloads) — verifies onboarding flow writes correct `user_prefs`, button
  presses write `swipes`/`shortlist` and advance to the next card. No live
  Telegram connection, no network.
- Poller tested the same way apt-hunter's MCP calls are already tested today
  (mocked MCP client responses), verifying dedupe/insert-new-only behavior.

## Hosting

Runs on your Mac via a new LaunchAgent (`com.hq.swipe-bot.plist`), same
pattern as the existing `com.hq.apt-hunter.plist`. Telegram long-polling needs
no inbound port, so this works without exposing anything. Trade-off you
accepted: the bot is offline when your Mac is off/asleep. Revisit a small
always-on host later if that becomes annoying for friends using it.
