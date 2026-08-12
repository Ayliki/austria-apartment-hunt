# WG (shared-flat) filtering design

## Problem

The swipe bot surfaces WG-Zimmer (rooms in shared flats), co-living rooms, and
similar shared-housing listings mixed in with whole-apartment listings. The
user wants these identified and, by default, never recommended.

## Detection

`detectWG(title: string): boolean` in `apt-hunter/src/normalize.ts`, next to
the existing `detectShortTerm`, with the same discipline: only unambiguous
phrasing counts, title only (not description — descriptions routinely say
"ideal für eine Studenten-WG" about ordinary whole flats).

Two-step to avoid false positives found in the live DB (`WG-geeignet`,
`WG-tauglich`, `TAUSCHWOHNUNG ... WG-tauglich`, `Privat wohnen statt
WG-Chaos` — all whole apartments, not rooms):

1. Strip phrases that describe a whole flat as merely *suitable* for a WG:
   `WG-geeignet`, `WG-tauglich`, `WG-fähig`, `statt WG`.
2. On the remaining text, match: `\bWG\b`, `WG-Zimmer`, `\d+er-WG`,
   `Wohngemeinschaft`, `co-living`, `Studenten(zimmer|-WG)`,
   `Studentinnen(zimmer|-WG)`.

Covers all three categories the user confirmed in scope: explicit WG rooms,
co-living products, and student rooms without the literal word "WG".

Known gap: a WG room titled only "Schönes Zimmer" with no WG/student/co-living
wording won't be caught. Acceptable false-negative given title-only matching
was chosen specifically to avoid the worse false-positive problem.

## Data model

- `NormalizedListing.isWg: boolean`, set via `detectWG(title)` in both
  `normalizeWillhaben` and `normalizeImmoscout` (mirrors `isShortTerm`).
- `listings.is_wg INTEGER NOT NULL DEFAULT 0`, added via the same
  `if (!listingColumns.includes('is_wg'))` migration pattern used for
  `requires_waitlist_ticket`.
- **Backfill**: the same migration step re-derives `is_wg` for all existing
  rows from their stored `title` via `detectWG`, in one transaction, so
  already-stored WG listings (~30 in the live DB today) stop appearing
  immediately on deploy — no need to wait for them to be re-polled.
- `user_prefs.include_wg INTEGER NOT NULL DEFAULT 0` (default OFF — opposite
  default from `include_waitlist_housing`, since the user wants WGs hidden by
  default, not shown by default).
- `UserPrefs.includeWg: boolean`.

## Preference surface

Added as a 7th onboarding question (`answers[6]`), following the exact
pattern of `includeWaitlistHousing` (`answers[5]`). Changing it means
re-running `/settings`, which is the existing behavior for every other
preference — not a new limitation introduced here.

## Filtering

Both existing filter sites get the same treatment as
`requires_waitlist_ticket`:

- `getCandidateListings` (SQL): `AND l.is_wg = 0` clause added only when
  `!prefs.includeWg`.
- `matchesPrefs` (in-memory, used for poll notifications): `if (!prefs.includeWg
  && l.isWg) return false`.

## Card display

When `includeWg` is true (so WGs are visible), the card gets a `🚪 WG` badge
line so the user can knowingly swipe past them. No badge needed when
`includeWg` is false, since WG cards never appear.

## Testing

- `detectWG` unit tests: positive cases (WG-Zimmer frei, Zimmer in 3er-WG,
  Ladies Frauen WG - Zimmer, CO-LIVING ... Wohngemeinschaft, Studenten-Zimmer
  in WG, 20qm WG-Studentenzimnner) and negative cases — specifically the three
  false positives found in the live DB (WG-geeignet, WG-tauglich,
  "statt WG-Chaos").
- Migration test: seed rows with WG titles pre-migration, run migration,
  assert `is_wg` backfilled correctly and non-WG rows untouched.
- `getCandidateListings` / `matchesPrefs`: WG listing excluded when
  `includeWg` is false, included when true — same shape as existing waitlist
  tests.
- Prefs round-trip: `includeWg` persists through onboarding save/load.

## Out of scope

- Detecting WG-adjacent listings from description text (rejected — too noisy).
- A dedicated `/wg` toggle command outside onboarding (not requested).
