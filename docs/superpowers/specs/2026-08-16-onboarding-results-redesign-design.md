# swipe-bot: Onboarding, Results & Multi-Search Redesign

**Status:** Approved for planning
**Date:** 2026-08-16
**Scope:** `austria-apartment-hunt/swipe-bot/`

## Problem

The bot's current UX has three pain points:

1. **Onboarding** is a rigid 8-question linear free-text wizard (regex-parsed, no
   buttons despite Telegraf already supporting them for swipe cards). No
   progress indicator, no back button, and `/settings` resets and re-asks
   everything instead of editing one field.
2. **Results delivery** dumps too much at once in two places: `/shortlist`
   sends up to 20 full photo cards in a tight loop, and push notifications
   send up to 5 full cards back-to-back with no pacing, both landing in the
   chat within seconds.
3. **No support for** multiple concurrent searches, richer amenity filters
   (elevator/parking exist in immoscout's parsed data but aren't piped into
   the bot), a pet-friendliness signal, or a non-German/English UI language.

## Goals

- Redesign onboarding as a fast, repeatable, button-driven wizard.
- Fix the two "dump" surfaces (`/shortlist`, push notifications) with
  aggregate-first + paginated list delivery.
- Support multiple independent named search profiles per chat.
- Add elevator + parking as real filters; surface floor, energy class,
  availability date, and a best-effort pet-friendly badge as card info only.
- Add a per-chat UI language setting (RU/EN/DE), translating bot chrome only
  — not scraped listing titles/descriptions.

## Non-goals

- Translating listing titles/descriptions (source content stays as scraped).
- Reliable/structured pet-friendly filtering — no source provides this field;
  it remains a best-effort, clearly-labeled keyword badge, never a hard filter.
- Changing the willhaben/immoscout scraping or matching logic itself.
- A "unified feed across all profiles" or "no active profile" mode — explicit
  active-profile switching was chosen over these alternatives.

## Data model

### `search_profiles` (new, replaces the single-row semantics of `user_prefs`)

| column | type | notes |
|---|---|---|
| `id` | integer PK | |
| `chat_id` | integer | |
| `name` | text | user-chosen, defaults to `"Search N"` |
| `prefs_json` | text (JSON) | budget range, districts[], rooms range, size range, includeWaitlistHousing, includeWg, elevator, parking, commute dest+coords |
| `active` | boolean | exactly one active profile per `chat_id` at a time |
| `created_at` | timestamp | |

Cap: **5 profiles per chat** (soft limit, bump later if needed).

### `chats` (new, small table for chat-level settings not tied to a profile)

| column | type | notes |
|---|---|---|
| `chat_id` | integer PK | |
| `language` | text | `en` \| `ru` \| `de`, set on first `/start`, changeable via `/language` |

### Existing tables — changes

- `swipes` — **unchanged**, stays keyed by `chat_id + listing_id`. A listing
  already swiped on is swiped for the chat, not per-profile, since it's the
  same physical apartment regardless of which profile matched it.
- `shortlist` — add `profile_id` column so entries can be grouped/labeled by
  which profile found them.
- `onboarding_state` — repurposed to track wizard progress per
  `(chat_id, profile_id-in-progress)` instead of per-chat only, since a chat
  can run the wizard again to add a second profile.
- `listings`, `commute_cache` — unchanged.

### Migration

On first run after upgrade, any chat with an existing `user_prefs` row gets
one `search_profiles` row auto-created (`name = "My Search"`, `active = true`,
`prefs_json` built from the old columns), and a `chats` row with
`language = "en"` (current implicit default). `user_prefs` table is dropped
once migration confirms no chats reference it.

## Onboarding wizard

Single Telegram message that morphs step-to-step via `editMessageText` +
`editMessageReplyMarkup` — the whole setup lives in one bubble, no chat
clutter. Header renders a progress dot bar (`●●●○○○ Step 3/6`) plus the
profile name being built. All steps are button-driven except the two that
can't be enumerated (profile name, commute address).

1. **Name this search** — free text, `Skip` defaults to `"Search N"`.
2. **Budget** — chip rows (`€500-700` `€700-900` `€900-1100` `€1100+`), tap
   advances immediately.
3. **Districts** — multi-select toggle grid (grouped 1-9 / 10-23), ✅/⬜ per
   tap, `Continue` enabled once ≥1 selected.
4. **Rooms & size** — chip rows for common bands, `Custom range ▸` falls back
   to free text for edge cases.
5. **Amenities** — multi-select grid: Elevator, Parking, Include
   waitlist/municipal housing, Include WG rooms.
6. **Commute (optional)** — free-text address, prominent `Skip` button
   (only step requiring geocoding).

Every step has `‹ Back` (answers stored as an ordered list; back pops the
last entry and re-renders that step). End state is a **summary card**
(*"Studio Center: €700-900 · Districts 1-9 · 1BR+ · Elevator"*) with
`[✅ Start searching]` `[✏️ Edit]` `[+ Add another search]`.

`/settings` on the active profile jumps straight to a field's chip screen,
applies the single change, and returns to the summary card — it no longer
resets and re-asks all steps.

Language is chosen once, before the very first profile wizard runs (part of
`/start`), and changeable anytime via `/language`.

## Results delivery

- **On profile activation**: send an aggregate summary before any cards —
  *"🏠 Studio Center: 14 matches · €650-890 (avg €740) · mostly districts
  2, 10, 15"* — with `[Browse top matches ▸]` and `[See all as list]`.
- **Browse mode** (existing swipe UX, unchanged): one full photo card at a
  time, 👍/👎 inline buttons, `/next`.
- **List mode** (new): top 5 matches as compact single-line entries (no
  photos) under one message, `[Show 5 more ▸]` edits the message to append
  the next batch instead of resending everything.
- **`/shortlist`** switches to list-mode pagination instead of looping up to
  20 full photo cards.
- **Push notifications**: capped at 5 per profile per poll cycle, staggered
  ~1.5s apart to avoid Telegram flood-control, grouped under one header per
  profile — *"🏠 Studio Center — 3 new matches:"* — as compact list-mode
  entries, each with a `[View ▸]` button for the full card on demand.

## Amenity filters & pet badge

- **Elevator** and **parking** (`lift`, `parkingSpaces` from immoscout's
  parsed data) become real wizard filters (step 5 above), stored on
  `prefs_json`, applied in `matchesPrefs`/`getCandidateListings`.
- **Floor, energy class, availability date** — surfaced as info lines on the
  result card, not filterable (avoids wizard bloat; revisit if requested).
- **Pet-friendly badge** — regex/keyword scan over the listing description
  (`Haustiere erlaubt`, `pets allowed`, etc.), shown as an unverified badge
  on the card (*"🐾 mentions pets — check listing"*), never used to include
  or exclude a listing from matching. willhaben data has no lift/parking
  fields at all today — those filters apply to immoscout listings only,
  and willhaben cards simply omit the badges rather than showing "unknown."

## i18n

- `locales/{en,ru,de}.json` string catalogs; a `t(chatId, key, ...params)`
  helper resolves the chat's `language` from the `chats` table.
- Every hardcoded string in `bot.ts` (wizard prompts, buttons, summary card,
  amenity labels, help text, error messages) is replaced with a `t()` call.
- Scraped listing title/description text is never translated.

## Testing

- Unit tests for: wizard step transitions (including Back), `prefs_json`
  round-trip, `matchesPrefs` with elevator/parking filters, pet-keyword
  regex against sample descriptions (true/false positive cases), `t()`
  fallback behavior for missing keys.
- Integration-style tests (existing `mcp-client.test.ts`/`bot.test.ts`
  patterns) for: multi-profile creation up to the 5-profile cap and the
  cap-reached error path, active-profile switching via `/searches`,
  migration of a pre-upgrade `user_prefs` row into a `search_profiles` row,
  shortlist/push pagination producing the expected batch sizes and no more
  than one Telegram API call burst above the flood-control-safe rate.
- Manual smoke test against a live chat: full wizard in each of the 3
  languages, add a 2nd profile, switch active profile, trigger `/shortlist`
  with >5 matches, trigger a push cycle with >5 matches.

## Open questions for implementation planning

- Exact wording/keyword list for the pet-friendly regex (needs a short
  German + English keyword pass).
- Whether `/language` mid-conversation should also offer to re-render the
  currently-displayed wizard step in the new language, or just apply from
  the next interaction onward.
