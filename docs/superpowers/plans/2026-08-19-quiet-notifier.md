# Quiet Notifier + Photo Reliability Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the swipe-bot from an unbounded push firehose into a pausable, quiet-hours-aware, daily-capped notifier, and stop photos from silently failing.

**Architecture:** Three new SQLite tables (`notify_settings`, `notify_log`, `photo_cache`) added through the existing additive `migrate()` pattern. All scheduling and threshold decisions live in a new pure module `notify-policy.ts` over an injected clock, so they are testable without Telegram or real timers. `notify.ts`'s `notifyNewMatches` is replaced by `dispatchNotifications` (instant pings) and `dispatchDigests` (scheduled summaries), driven by two independent timers in `index.ts`. Photo sending moves behind `photo.ts`, which caches Telegram `file_id`s and never lets a failed image abort a dispatch.

**Tech Stack:** TypeScript (ESM, NodeNext), `better-sqlite3`, `telegraf`, `node --test` via `tsx`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-mini-app-redesign-design.md`

## Global Constraints

- Node ESM with `NodeNext` resolution: **every** relative import must carry a `.js` extension, even in `.ts` source. Follow the existing files exactly.
- Tests run with `npm test` from `swipe-bot/`, which is `node --import tsx --test test/*.test.ts`. Use `node:test` + `node:assert/strict`, matching the existing suite.
- All wall-clock decisions use the **Europe/Vienna** timezone, resolved via `Intl.DateTimeFormat`. No timezone dependency is to be added.
- Every user-visible string goes through `t()` and must be added to **all three** catalogs (`src/locales/en.ts`, `ru.ts`, `de.ts`). `test/locales.test.ts` enforces key parity; a missing key fails the suite.
- `MCP_CHAT_ID = 0` is a sentinel with no real Telegram chat. Every dispatch path must skip it, exactly as `notifyNewMatches` does today.
- Never let a Telegram API failure for one listing abort the remaining listings for that profile, or the remaining profiles.
- **Two distinct test fixtures exist and are not interchangeable.** `test/db.test.ts` has `listing()`, which builds a `NormalizedListing` — the only shape `upsertListing(db, l: NormalizedListing)` accepts. `test/notify.test.ts` has `row()`, which builds a `ListingRow` — the shape read back out of the DB and passed directly to dispatch functions. Copy whichever helper a test file needs; never pass a `row()` to `upsertListing`.
- `createSearchProfile(db, chatId, name, prefs, makeActive?)` returns a **`SearchProfile`**, not an id. Use `.id` when a `profileId` is wanted.
- Commit after each task. Do not push; the user pushes explicitly.

## Deviations from the spec, and why

Two, both discovered while planning. Neither changes the design's intent.

1. **`/next` keeps its photo album in Phase 1.** The spec's "no albums in chat, ever" assumes the Mini App exists to browse in. It does not yet, so `/next` remains the only browsing surface and cannot lose its photos. Phase 1 instead makes the album *fail-soft* (Task 6). Deleting `sendListingCard`'s album branch moves to Plan 2.
2. **Digests get their own timer.** The spec implies dispatch happens on the poll tick, but polling is every 3h at an arbitrary offset from process start, so a 09:00 digest would fire anywhere up to 11:59. Task 8 adds an independent 5-minute digest tick.

---

### Task 1: Expose ranking scores

`rankListings` computes a score per listing and discards it. The instant-notification threshold needs those numbers.

**Files:**
- Modify: `swipe-bot/src/scoring.ts:60-74`
- Test: `swipe-bot/test/scoring.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `scoreListings(listings: ListingRow[], swiped: {listing: ListingRow; direction: 'like'|'pass'}[]): {listing: ListingRow; score: number}[]`, sorted by descending score. `rankListings` keeps its exact current signature and behaviour.

- [ ] **Step 1: Write the failing test**

Append to `swipe-bot/test/scoring.test.ts`:

```typescript
test('scoreListings returns scores alongside listings, sorted descending', () => {
  const good = row({ id: 'willhaben:good', valueFlag: 'good' });
  const premium = row({ id: 'willhaben:premium', valueFlag: 'premium' });
  const fair = row({ id: 'willhaben:fair', valueFlag: 'fair' });

  const scored = scoreListings([premium, fair, good], []);

  assert.deepEqual(scored.map((s) => s.listing.id), ['willhaben:good', 'willhaben:fair', 'willhaben:premium']);
  assert.deepEqual(scored.map((s) => s.score), [1, 0.5, 0]);
});

test('rankListings returns the same order scoreListings does', () => {
  const listings = [row({ id: 'a', valueFlag: 'premium' }), row({ id: 'b', valueFlag: 'good' })];
  assert.deepEqual(
    rankListings(listings, []).map((l) => l.id),
    scoreListings(listings, []).map((s) => s.listing.id),
  );
});
```

Add `scoreListings` to the existing import from `../src/scoring.js` at the top of the file. If `scoring.test.ts` has no `row()` helper, copy the one from `test/notify.test.ts` verbatim.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swipe-bot && npx tsx --test test/scoring.test.ts`
Expected: FAIL — `scoreListings is not a function` / TypeScript reports no exported member `scoreListings`.

- [ ] **Step 3: Write minimal implementation**

Replace `rankListings` in `swipe-bot/src/scoring.ts` with:

```typescript
export function scoreListings(
  listings: ListingRow[],
  swiped: { listing: ListingRow; direction: 'like' | 'pass' }[],
): { listing: ListingRow; score: number }[] {
  const coldStart = swiped.length < COLD_START_THRESHOLD;
  const stats = coldStart ? null : computeBucketStats(swiped);
  const scored = listings.map((l) => {
    const score = coldStart ? valueScoreOf(l) : 0.6 * learnedScoreOf(l, stats!) + 0.4 * valueScoreOf(l);
    return { listing: l, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Order-only view of scoreListings — the scores themselves are only needed by the notification threshold. */
export function rankListings(
  listings: ListingRow[],
  swiped: { listing: ListingRow; direction: 'like' | 'pass' }[],
): ListingRow[] {
  return scoreListings(listings, swiped).map((s) => s.listing);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS, including the pre-existing `scoring.test.ts`, `bot.test.ts`, and `notify.test.ts` cases that depend on `rankListings` ordering.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/scoring.ts swipe-bot/test/scoring.test.ts
git commit -m "scoring: expose per-listing scores via scoreListings"
```

---

### Task 2: Notification and photo tables

**Files:**
- Modify: `swipe-bot/src/db.ts` (the `SCHEMA` constant, `migrate()`, and new accessors at the end)
- Test: `swipe-bot/test/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface NotifySettings { profileId: number; paused: boolean; instantEnabled: boolean; instantPercentile: number; digestHours: number[]; quietStart: number; quietEnd: number; dailyCap: number; lastDigestAt: string | null }`
  - `getNotifySettings(db: DB, profileId: number): NotifySettings` — returns spec defaults for a profile with no row, without inserting one.
  - `updateNotifySettings(db: DB, profileId: number, patch: Partial<Omit<NotifySettings, 'profileId'>>): void` — upserts.
  - `recordNotified(db: DB, profileId: number, listingId: string, kind: 'instant' | 'digest', at: string): void`
  - `countInstantSince(db: DB, profileId: number, sinceIso: string): number`
  - `getNotifiedListingIds(db: DB, profileId: number): Set<string>`
  - `getCachedFileId(db: DB, sourceUrl: string): string | null`
  - `recordFileId(db: DB, sourceUrl: string, fileId: string, at: string): void`
  - `recordPhotoFailure(db: DB, sourceUrl: string, error: string, at: string): void`
  - `isKnownBadPhoto(db: DB, sourceUrl: string): boolean`

- [ ] **Step 1: Write the failing test**

Append to `swipe-bot/test/db.test.ts`:

```typescript
test('getNotifySettings returns spec defaults for an unconfigured profile', () => {
  const db = openDb(':memory:');
  const s = getNotifySettings(db, 42);
  assert.equal(s.paused, false);
  assert.equal(s.instantEnabled, true);
  assert.equal(s.instantPercentile, 0.10);
  assert.deepEqual(s.digestHours, [9, 19]);
  assert.equal(s.quietStart, 22);
  assert.equal(s.quietEnd, 8);
  assert.equal(s.dailyCap, 6);
  assert.equal(s.lastDigestAt, null);
});

test('updateNotifySettings upserts and round-trips a partial patch', () => {
  const db = openDb(':memory:');
  updateNotifySettings(db, 42, { paused: true, dailyCap: 3, digestHours: [8] });
  const s = getNotifySettings(db, 42);
  assert.equal(s.paused, true);
  assert.equal(s.dailyCap, 3);
  assert.deepEqual(s.digestHours, [8]);
  assert.equal(s.quietStart, 22); // untouched field keeps its default
});

test('countInstantSince counts only instant sends at or after the cutoff', () => {
  const db = openDb(':memory:');
  recordNotified(db, 1, 'willhaben:a', 'instant', '2026-08-19T06:00:00Z');
  recordNotified(db, 1, 'willhaben:b', 'instant', '2026-08-19T10:00:00Z');
  recordNotified(db, 1, 'willhaben:c', 'digest', '2026-08-19T10:00:00Z');
  assert.equal(countInstantSince(db, 1, '2026-08-19T08:00:00Z'), 1);
});

test('getNotifiedListingIds returns every listing already announced by any kind', () => {
  const db = openDb(':memory:');
  recordNotified(db, 1, 'willhaben:a', 'instant', '2026-08-19T06:00:00Z');
  recordNotified(db, 1, 'willhaben:b', 'digest', '2026-08-19T06:00:00Z');
  recordNotified(db, 2, 'willhaben:c', 'instant', '2026-08-19T06:00:00Z');
  assert.deepEqual([...getNotifiedListingIds(db, 1)].sort(), ['willhaben:a', 'willhaben:b']);
});

test('recordNotified is idempotent for the same profile and listing', () => {
  const db = openDb(':memory:');
  recordNotified(db, 1, 'willhaben:a', 'instant', '2026-08-19T06:00:00Z');
  recordNotified(db, 1, 'willhaben:a', 'digest', '2026-08-19T07:00:00Z');
  assert.equal(getNotifiedListingIds(db, 1).size, 1);
});

test('photo cache stores and returns a file_id, and flags known-bad urls', () => {
  const db = openDb(':memory:');
  assert.equal(getCachedFileId(db, 'https://cdn/x.jpg'), null);
  assert.equal(isKnownBadPhoto(db, 'https://cdn/x.jpg'), false);

  recordFileId(db, 'https://cdn/x.jpg', 'FILEID123', '2026-08-19T06:00:00Z');
  assert.equal(getCachedFileId(db, 'https://cdn/x.jpg'), 'FILEID123');
  assert.equal(isKnownBadPhoto(db, 'https://cdn/x.jpg'), false);

  recordPhotoFailure(db, 'https://cdn/dead.jpg', 'wrong file identifier', '2026-08-19T06:00:00Z');
  assert.equal(getCachedFileId(db, 'https://cdn/dead.jpg'), null);
  assert.equal(isKnownBadPhoto(db, 'https://cdn/dead.jpg'), true);
});
```

Add the new names to the existing `../src/db.js` import at the top of `db.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swipe-bot && npx tsx --test test/db.test.ts`
Expected: FAIL — no exported member `getNotifySettings`.

- [ ] **Step 3: Write minimal implementation**

Append these three tables to the `SCHEMA` template literal in `swipe-bot/src/db.ts`, before its closing backtick:

```sql
CREATE TABLE IF NOT EXISTS notify_settings (
  profile_id         INTEGER PRIMARY KEY,
  paused             INTEGER NOT NULL DEFAULT 0,
  instant_enabled    INTEGER NOT NULL DEFAULT 1,
  instant_percentile REAL    NOT NULL DEFAULT 0.10,
  digest_hours       TEXT    NOT NULL DEFAULT '9,19',
  quiet_start        INTEGER NOT NULL DEFAULT 22,
  quiet_end          INTEGER NOT NULL DEFAULT 8,
  daily_cap          INTEGER NOT NULL DEFAULT 6,
  last_digest_at     TEXT
);

CREATE TABLE IF NOT EXISTS notify_log (
  profile_id INTEGER NOT NULL,
  listing_id TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  sent_at    TEXT    NOT NULL,
  PRIMARY KEY (profile_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_notify_log_profile_sent ON notify_log(profile_id, sent_at);

CREATE TABLE IF NOT EXISTS photo_cache (
  source_url TEXT PRIMARY KEY,
  file_id    TEXT,
  cached_at  TEXT NOT NULL,
  failed     INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
```

`CREATE TABLE IF NOT EXISTS` covers both fresh and existing databases here because all three tables are new, so no `migrate()` change is required for this task. Leave `migrate()` untouched.

Append the accessors to the end of `swipe-bot/src/db.ts`:

```typescript
export interface NotifySettings {
  profileId: number;
  paused: boolean;
  instantEnabled: boolean;
  instantPercentile: number;
  digestHours: number[];
  quietStart: number;
  quietEnd: number;
  dailyCap: number;
  lastDigestAt: string | null;
}

/** Spec defaults — mirrored in the notify_settings DDL so a row inserted by SQL alone matches a row this module synthesizes. */
export const DEFAULT_NOTIFY_SETTINGS: Omit<NotifySettings, 'profileId'> = {
  paused: false,
  instantEnabled: true,
  instantPercentile: 0.10,
  digestHours: [9, 19],
  quietStart: 22,
  quietEnd: 8,
  dailyCap: 6,
  lastDigestAt: null,
};

const parseDigestHours = (raw: string): number[] =>
  raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);

/** Never inserts — an unconfigured profile reads as the defaults, so existing users need no backfill. */
export function getNotifySettings(db: DB, profileId: number): NotifySettings {
  const row = db.prepare('SELECT * FROM notify_settings WHERE profile_id = ?').get(profileId) as
    | { paused: number; instant_enabled: number; instant_percentile: number; digest_hours: string; quiet_start: number; quiet_end: number; daily_cap: number; last_digest_at: string | null }
    | undefined;
  if (!row) return { profileId, ...DEFAULT_NOTIFY_SETTINGS };
  return {
    profileId,
    paused: row.paused === 1,
    instantEnabled: row.instant_enabled === 1,
    instantPercentile: row.instant_percentile,
    digestHours: parseDigestHours(row.digest_hours),
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    dailyCap: row.daily_cap,
    lastDigestAt: row.last_digest_at,
  };
}

export function updateNotifySettings(db: DB, profileId: number, patch: Partial<Omit<NotifySettings, 'profileId'>>): void {
  const current = getNotifySettings(db, profileId);
  const next = { ...current, ...patch };
  db.prepare(`
    INSERT INTO notify_settings (profile_id, paused, instant_enabled, instant_percentile, digest_hours, quiet_start, quiet_end, daily_cap, last_digest_at)
    VALUES (@profileId, @paused, @instantEnabled, @instantPercentile, @digestHours, @quietStart, @quietEnd, @dailyCap, @lastDigestAt)
    ON CONFLICT(profile_id) DO UPDATE SET
      paused = @paused, instant_enabled = @instantEnabled, instant_percentile = @instantPercentile,
      digest_hours = @digestHours, quiet_start = @quietStart, quiet_end = @quietEnd,
      daily_cap = @dailyCap, last_digest_at = @lastDigestAt
  `).run({
    profileId,
    paused: next.paused ? 1 : 0,
    instantEnabled: next.instantEnabled ? 1 : 0,
    instantPercentile: next.instantPercentile,
    digestHours: next.digestHours.join(','),
    quietStart: next.quietStart,
    quietEnd: next.quietEnd,
    dailyCap: next.dailyCap,
    lastDigestAt: next.lastDigestAt,
  });
}

/** INSERT OR IGNORE, so a listing announced instantly is never re-announced in a digest. */
export function recordNotified(db: DB, profileId: number, listingId: string, kind: 'instant' | 'digest', at: string): void {
  db.prepare('INSERT OR IGNORE INTO notify_log (profile_id, listing_id, kind, sent_at) VALUES (?, ?, ?, ?)')
    .run(profileId, listingId, kind, at);
}

export function countInstantSince(db: DB, profileId: number, sinceIso: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM notify_log WHERE profile_id = ? AND kind = 'instant' AND sent_at >= ?")
    .get(profileId, sinceIso) as { n: number };
  return row.n;
}

export function getNotifiedListingIds(db: DB, profileId: number): Set<string> {
  const rows = db.prepare('SELECT listing_id FROM notify_log WHERE profile_id = ?').all(profileId) as { listing_id: string }[];
  return new Set(rows.map((r) => r.listing_id));
}

export function getCachedFileId(db: DB, sourceUrl: string): string | null {
  const row = db.prepare('SELECT file_id FROM photo_cache WHERE source_url = ? AND failed = 0').get(sourceUrl) as
    { file_id: string | null } | undefined;
  return row?.file_id ?? null;
}

export function recordFileId(db: DB, sourceUrl: string, fileId: string, at: string): void {
  db.prepare(`
    INSERT INTO photo_cache (source_url, file_id, cached_at, failed, last_error) VALUES (?, ?, ?, 0, NULL)
    ON CONFLICT(source_url) DO UPDATE SET file_id = excluded.file_id, cached_at = excluded.cached_at, failed = 0, last_error = NULL
  `).run(sourceUrl, fileId, at);
}

export function recordPhotoFailure(db: DB, sourceUrl: string, error: string, at: string): void {
  db.prepare(`
    INSERT INTO photo_cache (source_url, file_id, cached_at, failed, last_error) VALUES (?, NULL, ?, 1, ?)
    ON CONFLICT(source_url) DO UPDATE SET cached_at = excluded.cached_at, failed = 1, last_error = excluded.last_error
  `).run(sourceUrl, at, error.slice(0, 500));
}

export function isKnownBadPhoto(db: DB, sourceUrl: string): boolean {
  const row = db.prepare('SELECT failed FROM photo_cache WHERE source_url = ?').get(sourceUrl) as { failed: number } | undefined;
  return row?.failed === 1;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/db.ts swipe-bot/test/db.test.ts
git commit -m "db: add notify_settings, notify_log, and photo_cache tables"
```

---

### Task 3: Pure notification policy

Every scheduling and threshold decision, with no DB, no Telegram, and no real clock.

**Files:**
- Create: `swipe-bot/src/notify-policy.ts`
- Test: `swipe-bot/test/notify-policy.test.ts`

**Interfaces:**
- Consumes: `NotifySettings` from Task 2.
- Produces:
  - `viennaHour(now: Date): number`
  - `viennaDayStartIso(now: Date): string`
  - `isQuietHour(hour: number, quietStart: number, quietEnd: number): boolean`
  - `MIN_THRESHOLD_SAMPLE = 20`
  - `instantThreshold(recentScores: number[], percentile: number): number | null`
  - `isDigestDue(now: Date, digestHours: number[], lastDigestAt: string | null): boolean`

- [ ] **Step 1: Write the failing test**

Create `swipe-bot/test/notify-policy.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  viennaHour, viennaDayStartIso, isQuietHour, instantThreshold, isDigestDue, MIN_THRESHOLD_SAMPLE,
} from '../src/notify-policy.js';

test('viennaHour converts UTC to Vienna local hour across DST', () => {
  // Vienna is UTC+2 in August (CEST) and UTC+1 in January (CET).
  assert.equal(viennaHour(new Date('2026-08-19T07:30:00Z')), 9);
  assert.equal(viennaHour(new Date('2026-01-19T07:30:00Z')), 8);
});

test('viennaDayStartIso returns the UTC instant of Vienna local midnight', () => {
  assert.equal(viennaDayStartIso(new Date('2026-08-19T07:30:00Z')), '2026-08-18T22:00:00.000Z');
});

test('isQuietHour handles a window that wraps past midnight', () => {
  assert.equal(isQuietHour(23, 22, 8), true);
  assert.equal(isQuietHour(3, 22, 8), true);
  assert.equal(isQuietHour(22, 22, 8), true);
  assert.equal(isQuietHour(8, 22, 8), false);
  assert.equal(isQuietHour(12, 22, 8), false);
});

test('isQuietHour handles a same-day window', () => {
  assert.equal(isQuietHour(13, 12, 14), true);
  assert.equal(isQuietHour(15, 12, 14), false);
});

test('isQuietHour treats an empty window as never quiet', () => {
  assert.equal(isQuietHour(5, 8, 8), false);
});

test('instantThreshold returns the score at the requested top percentile', () => {
  const scores = Array.from({ length: 100 }, (_, i) => i / 100); // 0.00 … 0.99
  assert.equal(instantThreshold(scores, 0.10), 0.90);
});

test('instantThreshold returns null below the minimum sample size', () => {
  const scores = Array.from({ length: MIN_THRESHOLD_SAMPLE - 1 }, () => 0.5);
  assert.equal(instantThreshold(scores, 0.10), null);
});

test('instantThreshold never returns a threshold no listing can reach', () => {
  const scores = Array.from({ length: 50 }, () => 0.5); // every listing identical
  assert.equal(instantThreshold(scores, 0.10), 0.5);
});

test('isDigestDue fires once the hour is reached and not again the same hour', () => {
  const now = new Date('2026-08-19T07:05:00Z'); // 09:05 Vienna
  assert.equal(isDigestDue(now, [9, 19], null), true);
  assert.equal(isDigestDue(now, [9, 19], '2026-08-19T07:01:00Z'), false);
});

test('isDigestDue fires again at the next configured hour', () => {
  const now = new Date('2026-08-19T17:05:00Z'); // 19:05 Vienna
  assert.equal(isDigestDue(now, [9, 19], '2026-08-19T07:01:00Z'), true);
});

test('isDigestDue does not fire between configured hours', () => {
  const now = new Date('2026-08-19T12:05:00Z'); // 14:05 Vienna
  assert.equal(isDigestDue(now, [9, 19], '2026-08-19T07:01:00Z'), false);
});

test('isDigestDue fires the next day at the same hour', () => {
  const now = new Date('2026-08-20T07:05:00Z'); // 09:05 Vienna, next day
  assert.equal(isDigestDue(now, [9, 19], '2026-08-19T17:01:00Z'), true);
});

test('isDigestDue never fires with no configured hours', () => {
  assert.equal(isDigestDue(new Date('2026-08-19T07:05:00Z'), [], null), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swipe-bot && npx tsx --test test/notify-policy.test.ts`
Expected: FAIL — cannot find module `../src/notify-policy.js`.

- [ ] **Step 3: Write minimal implementation**

Create `swipe-bot/src/notify-policy.ts`:

```typescript
/**
 * Every scheduling and threshold decision for notifications, as pure functions over an explicit
 * `now`. Kept free of DB and Telegram imports so the whole policy is testable without fakes, in the
 * same spirit as notify.ts's injectable DelayFn.
 */

const VIENNA = 'Europe/Vienna';

/** Local clock hour (0-23) in Vienna for the given instant, DST included. */
export function viennaHour(now: Date): number {
  const formatted = new Intl.DateTimeFormat('en-GB', { timeZone: VIENNA, hour: '2-digit', hour12: false }).format(now);
  return Number(formatted);
}

/** UTC instant of the most recent Vienna local midnight — the cutoff a per-day cap counts from. */
export function viennaDayStartIso(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VIENNA, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const elapsedMs = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000;
  return new Date(now.getTime() - elapsedMs - now.getMilliseconds()).toISOString();
}

/**
 * Inclusive of `quietStart`, exclusive of `quietEnd`, and correct for a window that wraps past
 * midnight (the default 22->8 does). A zero-length window means quiet hours are off.
 */
export function isQuietHour(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  return hour >= quietStart || hour < quietEnd;
}

/**
 * Below this many recent scored matches, a percentile is noise rather than a signal, so instant
 * notification falls back to the caller's valueFlag check alone.
 */
export const MIN_THRESHOLD_SAMPLE = 20;

/**
 * Score a listing must meet or exceed to sit in the top `percentile` of `recentScores`. Returns
 * null when there is too little history to say. Callers compare with `>=`, so a run of identical
 * scores yields that score rather than an unreachable bound.
 */
export function instantThreshold(recentScores: number[], percentile: number): number | null {
  if (recentScores.length < MIN_THRESHOLD_SAMPLE) return null;
  const sorted = [...recentScores].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - percentile)));
  return sorted[index];
}

/**
 * True when `now` has reached a configured digest hour that `lastDigestAt` has not already covered.
 * Comparing Vienna calendar-day + hour (rather than elapsed time) keeps one digest per configured
 * hour per day even though the caller ticks every few minutes.
 */
export function isDigestDue(now: Date, digestHours: number[], lastDigestAt: string | null): boolean {
  if (digestHours.length === 0) return false;
  const hour = viennaHour(now);
  const dueHours = digestHours.filter((h) => h <= hour);
  if (dueHours.length === 0) return false;

  if (lastDigestAt == null) return true;
  const last = new Date(lastDigestAt);
  const dayStart = viennaDayStartIso(now);
  if (last.toISOString() < dayStart) return true; // last digest was on an earlier Vienna day

  return viennaHour(last) < Math.max(...dueHours);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/notify-policy.ts swipe-bot/test/notify-policy.test.ts
git commit -m "notify: add pure scheduling and threshold policy over an injected clock"
```

---

### Task 4: Fail-soft photo sending with a file_id cache

**Files:**
- Create: `swipe-bot/src/photo.ts`
- Test: `swipe-bot/test/photo.test.ts`

**Interfaces:**
- Consumes: `getCachedFileId`, `recordFileId`, `recordPhotoFailure`, `isKnownBadPhoto` from Task 2.
- Produces:
  - `sendPhotoCached(telegram, db, chatId: number, sourceUrl: string, caption: string, extra: Record<string, unknown>, now: Date): Promise<boolean>` — resolves `true` when a photo was sent, `false` when it fell back. Never throws.
  - `usablePhotoUrls(db: DB, urls: string[]): string[]` — drops URLs already known bad.

- [ ] **Step 1: Write the failing test**

Create `swipe-bot/test/photo.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { sendPhotoCached, usablePhotoUrls } from '../src/photo.js';
import { openDb, getCachedFileId, isKnownBadPhoto, recordPhotoFailure } from '../src/db.js';

interface Call { method: string; payload: Record<string, unknown> }

let activeCalls: Call[] | null = null;
let nextResult: ((method: string) => unknown) | null = null;

(Telegram.prototype as unknown as { callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown> }).callApi =
  async function callApi(method, payload) {
    if (!activeCalls) throw new Error('callApi invoked outside a test context');
    activeCalls.push({ method, payload });
    const result = nextResult?.(method);
    if (result instanceof Error) throw result;
    if (result !== undefined) return result;
    return { message_id: activeCalls.length, date: 0, chat: { id: 0, type: 'private' } };
  };

function testTelegram(result?: (method: string) => unknown): { telegram: Telegram; calls: Call[] } {
  const telegram = new Telegram('test-token');
  const calls: Call[] = [];
  activeCalls = calls;
  nextResult = result ?? null;
  return { telegram, calls };
}

const NOW = new Date('2026-08-19T06:00:00Z');

test('sendPhotoCached sends the source url first time and stores the returned file_id', async () => {
  const db = openDb(':memory:');
  const { telegram, calls } = testTelegram(() => ({
    message_id: 1, date: 0, chat: { id: 1, type: 'private' },
    photo: [{ file_id: 'SMALL' }, { file_id: 'LARGEST' }],
  }));

  const sent = await sendPhotoCached(telegram, db, 1, 'https://cdn/a.jpg', 'caption', {}, NOW);

  assert.equal(sent, true);
  assert.equal(calls[0].method, 'sendPhoto');
  assert.equal(calls[0].payload.photo, 'https://cdn/a.jpg');
  assert.equal(getCachedFileId(db, 'https://cdn/a.jpg'), 'LARGEST');
});

test('sendPhotoCached reuses the cached file_id on the second send', async () => {
  const db = openDb(':memory:');
  const first = testTelegram(() => ({
    message_id: 1, date: 0, chat: { id: 1, type: 'private' }, photo: [{ file_id: 'LARGEST' }],
  }));
  await sendPhotoCached(first.telegram, db, 1, 'https://cdn/a.jpg', 'c', {}, NOW);

  const second = testTelegram(() => ({
    message_id: 2, date: 0, chat: { id: 1, type: 'private' }, photo: [{ file_id: 'LARGEST' }],
  }));
  await sendPhotoCached(second.telegram, db, 2, 'https://cdn/a.jpg', 'c', {}, NOW);

  assert.equal(second.calls[0].payload.photo, 'LARGEST');
});

test('sendPhotoCached falls back to a text message and records the failure', async () => {
  const db = openDb(':memory:');
  const { telegram, calls } = testTelegram((method) =>
    method === 'sendPhoto' ? new Error('400: Bad Request: wrong file identifier/HTTP URL specified') : undefined);

  const sent = await sendPhotoCached(telegram, db, 1, 'https://cdn/dead.jpg', 'caption', {}, NOW);

  assert.equal(sent, false);
  assert.equal(calls[0].method, 'sendPhoto');
  assert.equal(calls[1].method, 'sendMessage');
  assert.equal(calls[1].payload.text, 'caption');
  assert.equal(isKnownBadPhoto(db, 'https://cdn/dead.jpg'), true);
});

test('sendPhotoCached never throws even when the text fallback also fails', async () => {
  const db = openDb(':memory:');
  const { telegram } = testTelegram(() => new Error('network down'));
  const sent = await sendPhotoCached(telegram, db, 1, 'https://cdn/dead.jpg', 'caption', {}, NOW);
  assert.equal(sent, false);
});

test('sendPhotoCached skips the photo attempt entirely for a known-bad url', async () => {
  const db = openDb(':memory:');
  recordPhotoFailure(db, 'https://cdn/dead.jpg', 'previously failed', NOW.toISOString());
  const { telegram, calls } = testTelegram();

  await sendPhotoCached(telegram, db, 1, 'https://cdn/dead.jpg', 'caption', {}, NOW);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
});

test('usablePhotoUrls drops known-bad urls and preserves order', () => {
  const db = openDb(':memory:');
  recordPhotoFailure(db, 'https://cdn/b.jpg', 'dead', NOW.toISOString());
  assert.deepEqual(
    usablePhotoUrls(db, ['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg']),
    ['https://cdn/a.jpg', 'https://cdn/c.jpg'],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swipe-bot && npx tsx --test test/photo.test.ts`
Expected: FAIL — cannot find module `../src/photo.js`.

- [ ] **Step 3: Write minimal implementation**

Create `swipe-bot/src/photo.ts`:

```typescript
import { type Telegraf } from 'telegraf';
import { type DB, getCachedFileId, recordFileId, recordPhotoFailure, isKnownBadPhoto } from './db.js';

/**
 * Sends one photo, preferring a previously cached Telegram file_id over the origin URL so a CDN is
 * hit once per image ever rather than once per view, and degrading to a plain text message rather
 * than throwing when Telegram rejects the image.
 *
 * Telegram rejects remote URLs for many reasons outside our control (expired links, hotlink
 * blocking, slow origins, redirects), and a rejected photo previously propagated out of sendCard
 * and aborted the rest of a push — see the un-caught `await sendCard(...)` this replaces. Returning
 * a boolean instead of throwing makes that impossible by construction.
 */
export async function sendPhotoCached(
  telegram: Telegraf['telegram'], db: DB, chatId: number,
  sourceUrl: string, caption: string, extra: Record<string, unknown>, now: Date,
): Promise<boolean> {
  const cached = getCachedFileId(db, sourceUrl);
  const media = cached ?? sourceUrl;

  if (cached == null && isKnownBadPhoto(db, sourceUrl)) {
    await sendTextFallback(telegram, chatId, caption, extra);
    return false;
  }

  try {
    const message = await telegram.sendPhoto(chatId, media, { caption, ...extra }) as { photo?: { file_id: string }[] };
    // Telegram returns every rendered size, largest last — cache that one so re-sends keep full quality.
    const largest = message.photo?.at(-1)?.file_id;
    if (largest != null && cached == null) recordFileId(db, sourceUrl, largest, now.toISOString());
    return true;
  } catch (err) {
    recordPhotoFailure(db, sourceUrl, err instanceof Error ? err.message : String(err), now.toISOString());
    await sendTextFallback(telegram, chatId, caption, extra);
    return false;
  }
}

/** Last resort — a failure here is logged and swallowed, since a dispatch must continue to the next listing regardless. */
async function sendTextFallback(
  telegram: Telegraf['telegram'], chatId: number, caption: string, extra: Record<string, unknown>,
): Promise<void> {
  try {
    await telegram.sendMessage(chatId, caption, extra);
  } catch (err) {
    console.error('photo: text fallback failed:', err);
  }
}

/** Filters out images Telegram has already rejected, so an album never fails wholesale on a URL we know is dead. */
export function usablePhotoUrls(db: DB, urls: string[]): string[] {
  return urls.filter((u) => !isKnownBadPhoto(db, u));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/photo.ts swipe-bot/test/photo.test.ts
git commit -m "photo: cache file_ids and degrade to text instead of throwing"
```

---

### Task 5: Notification copy

New locale keys in all three catalogs, before the dispatcher needs them.

**Files:**
- Modify: `swipe-bot/src/locales/en.ts`, `swipe-bot/src/locales/ru.ts`, `swipe-bot/src/locales/de.ts`
- Test: `swipe-bot/test/locales.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: locale keys `notify_instant_header`, `notify_digest_header`, `notify_digest_line`, `notify_digest_best`, `btn_open_listing`, `notify_paused`, `notify_resumed`, `settings_notifications`, `notify_menu_header`, `btn_pause_search`, `btn_resume_search`, `btn_notify_less`, `btn_notify_more`.

- [ ] **Step 1: Write the failing test**

Append to `swipe-bot/test/locales.test.ts`:

```typescript
test('every catalog has the same keys', () => {
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(Object.keys(ru).sort(), enKeys);
  assert.deepEqual(Object.keys(de).sort(), enKeys);
});

test('notification keys exist and carry their placeholders in every catalog', () => {
  for (const catalog of [en, ru, de]) {
    assert.match(catalog.notify_instant_header, /\{name\}/);
    assert.match(catalog.notify_digest_header, /\{count\}/);
    assert.match(catalog.notify_digest_header, /\{name\}/);
    assert.match(catalog.notify_digest_line, /\{price\}/);
    assert.ok(catalog.btn_open_listing.length > 0);
    assert.ok(catalog.notify_paused.length > 0);
  }
});
```

If a `every catalog has the same keys` test already exists in the file, do not add a second one; keep the existing one and add only the second test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swipe-bot && npx tsx --test test/locales.test.ts`
Expected: FAIL — TypeScript reports `notify_instant_header` does not exist on the catalog type.

- [ ] **Step 3: Write minimal implementation**

Add to `swipe-bot/src/locales/en.ts`:

```typescript
  notify_instant_header: '🔥 Strong match · {name}',
  notify_digest_header: '🏠 {name} — {count} new since your last update',
  notify_digest_best: 'Best of these:',
  notify_digest_line: '{price} · {details}',
  btn_open_listing: 'Open ▸',
  notify_paused: 'Paused. "{name}" keeps collecting matches, but won\'t message you until you resume.',
  notify_resumed: 'Resumed. You\'ll hear about new matches for "{name}" again.',
  settings_notifications: '🔔 Notifications',
  notify_menu_header: 'Notifications for "{name}": {status}\nUp to {cap} instant alerts a day, plus a summary at {hours}. Quiet {quietStart}:00–{quietEnd}:00.',
  btn_pause_search: '⏸ Pause this search',
  btn_resume_search: '▶️ Resume this search',
  btn_notify_less: '🔉 Fewer alerts',
  btn_notify_more: '🔊 More alerts',
```

Add to `swipe-bot/src/locales/ru.ts`:

```typescript
  notify_instant_header: '🔥 Отличный вариант · {name}',
  notify_digest_header: '🏠 {name} — {count} новых с прошлого раза',
  notify_digest_best: 'Лучшее из них:',
  notify_digest_line: '{price} · {details}',
  btn_open_listing: 'Открыть ▸',
  notify_paused: 'Пауза. «{name}» продолжает собирать варианты, но писать не будет, пока не возобновите.',
  notify_resumed: 'Возобновлено. Снова буду сообщать о новых вариантах по «{name}».',
  settings_notifications: '🔔 Уведомления',
  notify_menu_header: 'Уведомления для «{name}»: {status}\nДо {cap} срочных в день плюс сводка в {hours}. Тишина с {quietStart}:00 до {quietEnd}:00.',
  btn_pause_search: '⏸ Поставить на паузу',
  btn_resume_search: '▶️ Возобновить',
  btn_notify_less: '🔉 Реже',
  btn_notify_more: '🔊 Чаще',
```

Add to `swipe-bot/src/locales/de.ts`:

```typescript
  notify_instant_header: '🔥 Starker Treffer · {name}',
  notify_digest_header: '🏠 {name} — {count} neue seit deinem letzten Update',
  notify_digest_best: 'Die besten davon:',
  notify_digest_line: '{price} · {details}',
  btn_open_listing: 'Öffnen ▸',
  notify_paused: 'Pausiert. „{name}" sammelt weiter Treffer, meldet sich aber erst wieder, wenn du fortsetzt.',
  notify_resumed: 'Fortgesetzt. Du hörst wieder von neuen Treffern für „{name}".',
  settings_notifications: '🔔 Benachrichtigungen',
  notify_menu_header: 'Benachrichtigungen für „{name}": {status}\nBis zu {cap} Sofortmeldungen pro Tag, dazu eine Übersicht um {hours}. Ruhe von {quietStart}:00 bis {quietEnd}:00.',
  btn_pause_search: '⏸ Suche pausieren',
  btn_resume_search: '▶️ Suche fortsetzen',
  btn_notify_less: '🔉 Weniger',
  btn_notify_more: '🔊 Mehr',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/locales/
git commit -m "locales: add notification, pause, and digest copy in en/ru/de"
```

---

### Task 6: Make /next's album fail-soft

`/next` remains the only browsing surface until the Mini App exists, so its album stays — but one dead URL must no longer fail the whole card.

**Files:**
- Modify: `swipe-bot/src/bot.ts:252-266` (`sendListingCard`)
- Test: `swipe-bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `usablePhotoUrls`, `sendPhotoCached` from Task 4.
- Produces: no signature changes. `sendListingCard` keeps its parameters and stays private to `bot.ts`.

- [ ] **Step 1: Write the failing test**

Append to `swipe-bot/test/bot.test.ts`, reusing that file's existing `testTelegram()` and `row()` helpers:

```typescript
test('a failing album degrades to a single photo instead of losing the card', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  upsertListing(db, listing({ id: 'willhaben:1', images: ['https://cdn/a.jpg', 'https://cdn/b.jpg'] }));

  const { telegram, calls } = testTelegram((method) =>
    method === 'sendMediaGroup' ? new Error('400: Bad Request: group send failed') : undefined);

  await sendCard(telegram, 1, getListingById(db, 'willhaben:1')!, null, db);

  assert.equal(calls[0].method, 'sendMediaGroup');
  assert.ok(calls.some((c) => c.method === 'sendPhoto' || c.method === 'sendMessage'),
    'card must still reach the user after the album fails');
});

test('a card whose images are all known-bad sends as text without attempting an album', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  upsertListing(db, listing({ id: 'willhaben:2', images: ['https://cdn/dead1.jpg', 'https://cdn/dead2.jpg'] }));
  recordPhotoFailure(db, 'https://cdn/dead1.jpg', 'dead', '2026-08-19T06:00:00Z');
  recordPhotoFailure(db, 'https://cdn/dead2.jpg', 'dead', '2026-08-19T06:00:00Z');

  const { telegram, calls } = testTelegram();
  await sendCard(telegram, 1, getListingById(db, 'willhaben:2')!, null, db);

  assert.ok(!calls.some((c) => c.method === 'sendMediaGroup'));
  assert.equal(calls[0].method, 'sendMessage');
});
```

`testTelegram()` in `bot.test.ts` currently takes no arguments. Extend it to accept the same optional `(method: string) => unknown` result function used in `test/photo.test.ts`, defaulting to today's behaviour so existing tests are unaffected.

Add `recordPhotoFailure`, `upsertListing`, and `getListingById` to the file's `../src/db.js` import. If `defaultPrefs()` does not exist in `bot.test.ts`, define it from the literal already used in that file's `createSearchProfile` calls.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swipe-bot && npx tsx --test test/bot.test.ts`
Expected: FAIL — the rejected `sendMediaGroup` propagates and the test throws rather than asserting.

- [ ] **Step 3: Write minimal implementation**

Add to the imports at the top of `swipe-bot/src/bot.ts`:

```typescript
import { sendPhotoCached, usablePhotoUrls } from './photo.js';
```

Replace `sendListingCard` in `swipe-bot/src/bot.ts` with:

```typescript
/**
 * Low-level: sends a listing as photo album / single photo / text, with the given inline buttons.
 *
 * sendMediaGroup is atomic — one dead URL fails the whole album with "group send failed" — so
 * images Telegram has already rejected are filtered out first, and an album that still fails falls
 * back to a single photo (itself fail-soft) rather than losing the card entirely.
 */
async function sendListingCard(
  telegram: Telegraf['telegram'], chatId: number, card: ListingRow, caption: string,
  buttons: ReturnType<typeof Markup.inlineKeyboard>, groupPromptText: string, db: DB,
): Promise<void> {
  const images = usablePhotoUrls(db, card.images);

  if (images.length >= 2) {
    try {
      await telegram.sendMediaGroup(chatId, buildMediaGroup(images, caption));
      await telegram.sendMessage(chatId, groupPromptText, buttons);
      return;
    } catch (err) {
      // Can't tell which image Telegram rejected, so don't blacklist any — just fall through to one photo.
      console.error('bot: album send failed, falling back to a single photo:', err);
    }
  }

  if (images.length >= 1) {
    await sendPhotoCached(telegram, db, chatId, images[0], caption, buttons, new Date());
    return;
  }

  await telegram.sendMessage(chatId, `${caption}\n(no photo)`, buttons);
}
```

Update `sendCard` and any other caller to pass `db` as the new final argument. `sendCard` already receives `db`, so this is a one-token change at each call site.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/bot.ts swipe-bot/test/bot.test.ts
git commit -m "bot: degrade a failed album to a single photo instead of dropping the card"
```

---

### Task 7: Replace notifyNewMatches with instant + digest dispatch

The core of the redesign.

**Files:**
- Modify: `swipe-bot/src/notify.ts` (full rewrite)
- Test: `swipe-bot/test/notify.test.ts` (replace the `notifyNewMatches` cases; keep the `formatPushEntry` cases, which still apply to digest lines)

**Interfaces:**
- Consumes: `scoreListings` (Task 1); `getNotifySettings`, `updateNotifySettings`, `recordNotified`, `countInstantSince`, `getNotifiedListingIds` (Task 2); `viennaHour`, `viennaDayStartIso`, `isQuietHour`, `instantThreshold`, `isDigestDue` (Task 3); `sendPhotoCached` (Task 4); locale keys (Task 5).
- Produces:
  - `dispatchInstant(telegram, db, newListings: ListingRow[], now: Date): Promise<void>`
  - `dispatchDigests(telegram, db, now: Date): Promise<void>`
  - `THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000`
  - `formatPushEntry` stays exported and unchanged; digest bodies use it.

- [ ] **Step 1: Write the failing test**

Replace the `notifyNewMatches` tests in `swipe-bot/test/notify.test.ts` with:

```typescript
const NOW_MIDDAY = new Date('2026-08-19T10:00:00Z'); // 12:00 Vienna, outside quiet hours
const NOW_NIGHT = new Date('2026-08-19T23:30:00Z'); // 01:30 Vienna, inside quiet hours

/** Seeds `count` scored listings into the profile's trailing window so instantThreshold has a sample. */
function seedHistory(db: ReturnType<typeof openDb>, count: number): void {
  for (let i = 0; i < count; i++) {
    upsertListing(db, listing({
      id: `willhaben:hist${i}`, price: 600, valueFlag: 'fair',
      firstSeen: '2026-08-15T00:00:00Z', url: `https://x/hist${i}`,
    }));
  }
}

test('dispatchInstant sends nothing for a paused profile', async () => {
  const db = openDb(':memory:');
  const profileId = createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null })).id;
  updateNotifySettings(db, profileId, { paused: true });
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'good' })], NOW_MIDDAY);

  assert.equal(calls.length, 0);
});

test('dispatchInstant sends nothing during quiet hours', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'good' })], NOW_NIGHT);

  assert.equal(calls.length, 0);
});

test('dispatchInstant sends exactly one photo message for a top match', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'good', images: ['https://cdn/a.jpg'] })], NOW_MIDDAY);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendPhoto');
});

test('dispatchInstant never sends an album, however many photos a listing has', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({
    id: 'willhaben:new', valueFlag: 'good',
    images: ['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg'],
  })], NOW_MIDDAY);

  assert.ok(!calls.some((c) => c.method === 'sendMediaGroup'));
});

test('dispatchInstant skips listings that are not flagged good value', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'premium' })], NOW_MIDDAY);

  assert.equal(calls.length, 0);
});

test('dispatchInstant stops at the daily cap', async () => {
  const db = openDb(':memory:');
  const profileId = createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null })).id;
  updateNotifySettings(db, profileId, { dailyCap: 2 });
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [
    row({ id: 'willhaben:n1', valueFlag: 'good', url: 'https://x/1' }),
    row({ id: 'willhaben:n2', valueFlag: 'good', url: 'https://x/2' }),
    row({ id: 'willhaben:n3', valueFlag: 'good', url: 'https://x/3' }),
  ], NOW_MIDDAY);

  assert.equal(calls.length, 2);
});

test('dispatchInstant never sends the same listing twice', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);
  const listing = row({ id: 'willhaben:new', valueFlag: 'good' });

  const first = testTelegram();
  await dispatchInstant(first.telegram, db, [listing], NOW_MIDDAY);
  const second = testTelegram();
  await dispatchInstant(second.telegram, db, [listing], NOW_MIDDAY);

  assert.equal(second.calls.length, 0);
});

test('dispatchInstant never touches the MCP sentinel chat', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, MCP_CHAT_ID, 'MCP', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'good' })], NOW_MIDDAY);

  assert.equal(calls.length, 0);
});

test('a failing send for one profile does not stop the next profile', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'A', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  createSearchProfile(db, 2, 'B', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram((method, payload) =>
    method === 'sendPhoto' && payload.chat_id === 1 ? new Error('blocked by user') : undefined);

  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'good', images: ['https://cdn/a.jpg'] })], NOW_MIDDAY);

  assert.ok(calls.some((c) => c.payload.chat_id === 2), 'profile B must still be notified');
});

test('dispatchDigests sends one text message summarising unsent matches', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  upsertListing(db, listing({ id: 'willhaben:d1', price: 700, url: 'https://x/d1' }));
  upsertListing(db, listing({ id: 'willhaben:d2', price: 750, url: 'https://x/d2' }));

  const { telegram, calls } = testTelegram();
  await dispatchDigests(telegram, db, new Date('2026-08-19T07:05:00Z')); // 09:05 Vienna

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
  assert.match(String(calls[0].payload.text), /2/);
});

test('dispatchDigests sends nothing when no digest hour is due', async () => {
  const db = openDb(':memory:');
  const profileId = createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null })).id;
  updateNotifySettings(db, profileId, { lastDigestAt: '2026-08-19T07:01:00Z' });
  upsertListing(db, listing({ id: 'willhaben:d1' }));

  const { telegram, calls } = testTelegram();
  await dispatchDigests(telegram, db, new Date('2026-08-19T12:05:00Z')); // 14:05 Vienna

  assert.equal(calls.length, 0);
});

test('dispatchDigests sends nothing when there is nothing new', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));

  const { telegram, calls } = testTelegram();
  await dispatchDigests(telegram, db, new Date('2026-08-19T07:05:00Z'));

  assert.equal(calls.length, 0);
});

test('a listing sent instantly is not repeated in the digest', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);
  const hot = row({ id: 'willhaben:hot', valueFlag: 'good' });
  upsertListing(db, hot);

  const first = testTelegram();
  await dispatchInstant(first.telegram, db, [hot], NOW_MIDDAY);

  const second = testTelegram();
  await dispatchDigests(second.telegram, db, new Date('2026-08-19T17:05:00Z')); // 19:05 Vienna

  const text = second.calls.map((c) => String(c.payload.text ?? '')).join('\n');
  assert.ok(!text.includes('willhaben:hot'));
});
```

Extend this file's `testTelegram()` to accept an optional `(method: string, payload: Record<string, unknown>) => unknown` result function, as in `test/photo.test.ts`. Add the new imports: `dispatchInstant`, `dispatchDigests` from `../src/notify.js`, and `updateNotifySettings`, `upsertListing` from `../src/db.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swipe-bot && npx tsx --test test/notify.test.ts`
Expected: FAIL — no exported member `dispatchInstant`.

- [ ] **Step 3: Write minimal implementation**

Rewrite `swipe-bot/src/notify.ts`, keeping `formatPushEntry` exactly as it is today and replacing `notifyNewMatches`:

```typescript
import { type Telegraf, Markup } from 'telegraf';
import {
  type DB, type ListingRow, type SearchProfile,
  getAllSearchProfiles, getSwipedWithDirection, matchesPrefs, MCP_CHAT_ID,
  getCandidateListings, getNotifySettings, updateNotifySettings,
  recordNotified, countInstantSince, getNotifiedListingIds,
} from './db.js';
import { scoreListings } from './scoring.js';
import { viennaHour, viennaDayStartIso, isQuietHour, instantThreshold, isDigestDue } from './notify-policy.js';
import { sendPhotoCached } from './photo.js';
import { formatCaption } from './bot.js';
import { t } from './locales.js';

/** Trailing window the instant threshold's percentile is computed over. */
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Most listings a single digest enumerates before collapsing the rest into a count. */
export const MAX_DIGEST_LINES = 5;

/** Pure — one compact line per listing for a digest body. Unchanged from the previous push format. */
export function formatPushEntry(l: ListingRow, commuteLine: string | null = null): string {
  const parts = [
    l.price != null ? `€${l.price}` : 'price n/a',
    l.area != null ? `${l.area}m²` : null,
    l.rooms != null ? `${l.rooms} rooms` : null,
    l.district != null ? `district ${l.district}` : null,
  ].filter(Boolean).join(' · ');
  const commuteSuffix = commuteLine ? `\n${commuteLine}` : '';
  return `${l.title}\n${parts}${commuteSuffix}\n${l.url}`;
}

/** Every profile eligible to receive anything: real chat, not paused. */
function notifiableProfiles(db: DB): SearchProfile[] {
  return getAllSearchProfiles(db).filter(
    (p) => p.chatId !== MCP_CHAT_ID && !getNotifySettings(db, p.id).paused,
  );
}

/**
 * Scores of everything this profile matched in the trailing 30 days — the sample the instant
 * percentile is measured against. Uses the profile's own swipe history, so the threshold tracks
 * the same learned ranking the deck does.
 */
function recentScoresFor(db: DB, profile: SearchProfile, now: Date): number[] {
  const cutoff = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();
  const recent = getCandidateListings(db, profile.chatId, profile.prefs)
    .filter((l) => l.firstSeen >= cutoff);
  return scoreListings(recent, getSwipedWithDirection(db, profile.chatId)).map((s) => s.score);
}

/**
 * Proactively messages a profile about a genuinely strong new match, at most `dailyCap` times a
 * Vienna day and never during quiet hours.
 *
 * Deliberately different from the pre-2026-08-19 behaviour, which pushed up to 5 full photo-album
 * cards per profile per 3h poll with no cap, no pause, and no quiet hours. Here a listing must
 * clear both an absolute bar (valueFlag 'good') and a relative one (top `instantPercentile` of the
 * profile's trailing 30 days), and each notification is a single message.
 *
 * Quiet-hour and over-cap listings are not marked notified, so they roll into the next digest
 * rather than being lost.
 */
export async function dispatchInstant(
  telegram: Telegraf['telegram'], db: DB, newListings: ListingRow[], now: Date,
): Promise<void> {
  if (newListings.length === 0) return;

  for (const profile of notifiableProfiles(db)) {
    const settings = getNotifySettings(db, profile.id);
    if (!settings.instantEnabled) continue;
    if (isQuietHour(viennaHour(now), settings.quietStart, settings.quietEnd)) continue;

    const alreadySent = getNotifiedListingIds(db, profile.id);
    const matches = newListings.filter((l) => matchesPrefs(l, profile.prefs) && !alreadySent.has(l.id));
    if (matches.length === 0) continue;

    const threshold = instantThreshold(recentScoresFor(db, profile, now), settings.instantPercentile);
    const scored = scoreListings(matches, getSwipedWithDirection(db, profile.chatId));

    let budget = settings.dailyCap - countInstantSince(db, profile.id, viennaDayStartIso(now));

    for (const { listing, score } of scored) {
      if (budget <= 0) break;
      // Absolute bar first: a listing that isn't good value never pings, however it ranks.
      if (listing.valueFlag !== 'good') continue;
      if (threshold != null && score < threshold) continue;

      // One profile's failure (blocked bot, deleted chat) must not stop the others.
      try {
        await sendInstantCard(telegram, db, profile, listing, now);
      } catch (err) {
        console.error(`notify: instant send failed for profile ${profile.id}:`, err);
        continue;
      }
      recordNotified(db, profile.id, listing.id, 'instant', now.toISOString());
      budget--;
    }
  }
}

async function sendInstantCard(
  telegram: Telegraf['telegram'], db: DB, profile: SearchProfile, listing: ListingRow, now: Date,
): Promise<void> {
  const header = t(db, profile.chatId, 'notify_instant_header', { name: profile.name });
  const caption = formatCaption(listing, null, `${header}\n\n`, t(db, profile.chatId, 'pet_badge'));
  const buttons = Markup.inlineKeyboard([[Markup.button.url(t(db, profile.chatId, 'btn_open_listing'), listing.url)]]);

  const hero = listing.images[0];
  if (hero != null) {
    await sendPhotoCached(telegram, db, profile.chatId, hero, caption, buttons, now);
    return;
  }
  await telegram.sendMessage(profile.chatId, caption, buttons);
}

/**
 * One text-only summary per profile at each configured digest hour, covering everything matched
 * since that profile's last digest that wasn't already sent instantly. No photos: the digest exists
 * to be scannable, not to reproduce the deck.
 */
export async function dispatchDigests(telegram: Telegraf['telegram'], db: DB, now: Date): Promise<void> {
  for (const profile of notifiableProfiles(db)) {
    const settings = getNotifySettings(db, profile.id);
    if (!isDigestDue(now, settings.digestHours, settings.lastDigestAt)) continue;

    const alreadySent = getNotifiedListingIds(db, profile.id);
    const pending = getCandidateListings(db, profile.chatId, profile.prefs).filter((l) => !alreadySent.has(l.id));
    if (pending.length === 0) {
      // Still stamp the run, so an empty 09:00 doesn't make 09:05 look due all morning.
      updateNotifySettings(db, profile.id, { lastDigestAt: now.toISOString() });
      continue;
    }

    const scored = scoreListings(pending, getSwipedWithDirection(db, profile.chatId));
    const shown = scored.slice(0, MAX_DIGEST_LINES);

    const header = t(db, profile.chatId, 'notify_digest_header', { name: profile.name, count: pending.length });
    const best = t(db, profile.chatId, 'notify_digest_best');
    const body = shown.map((s) => formatPushEntry(s.listing)).join('\n\n');
    const text = `${header}\n\n${best}\n\n${body}`;
    const buttons = Markup.inlineKeyboard([[Markup.button.url(t(db, profile.chatId, 'btn_open_listing'), shown[0].listing.url)]]);

    try {
      await telegram.sendMessage(profile.chatId, text, buttons);
    } catch (err) {
      console.error(`notify: digest send failed for profile ${profile.id}:`, err);
      continue; // don't stamp lastDigestAt — retry on the next tick
    }

    for (const s of shown) recordNotified(db, profile.id, s.listing.id, 'digest', now.toISOString());
    updateNotifySettings(db, profile.id, { lastDigestAt: now.toISOString() });
  }
}
```

Also remove the now-unused `MAX_PUSH_PER_USER`, `PUSH_STAGGER_MS`, `DelayFn`, and `realDelay` exports, and drop their assertions from `test/notify.test.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/notify.ts swipe-bot/test/notify.test.ts
git commit -m "notify: replace unbounded pushes with capped instant pings and scheduled digests"
```

---

### Task 8: Wire the two timers

**Files:**
- Modify: `swipe-bot/src/index.ts:11-12, 27-40, 78-88`
- Test: none (composition root; behaviour is covered by Task 7's unit tests)

**Interfaces:**
- Consumes: `dispatchInstant`, `dispatchDigests` from Task 7.
- Produces: `DIGEST_TICK_MS`.

- [ ] **Step 1: Replace the notify import and add the digest interval**

In `swipe-bot/src/index.ts`, change the import:

```typescript
import { dispatchInstant, dispatchDigests } from './notify.js';
```

Add below the existing interval constants:

```typescript
/**
 * Digests fire at wall-clock hours (09:00/19:00 by default), but polling runs every 3h from an
 * arbitrary process-start offset — so digests need their own short tick. isDigestDue() is idempotent
 * within a configured hour, so ticking often is cheap and only the first tick past the hour sends.
 */
const DIGEST_TICK_MS = 5 * 60 * 1000;
```

- [ ] **Step 2: Swap the poll body over to dispatchInstant**

Replace the `notifyNewMatches` call inside `poll`:

```typescript
      await dispatchInstant(bot.telegram, db, inserted, new Date());
```

`deps.computeCommute` and `deps.geocode` are no longer passed to notification code — instant cards carry no commute line, since computing one per ping costs Routes quota for a message the user may not open. Leave `deps` itself in place; `createBot` still needs it.

- [ ] **Step 3: Add the digest timer alongside the poll and refresh timers**

After `const pollTimer = setInterval(poll, POLL_INTERVAL_MS);` add:

```typescript
  const digest = async () => {
    try {
      await dispatchDigests(bot.telegram, db, new Date());
    } catch (err) {
      console.error('digest failed:', err);
    }
  };
  const digestTimer = setInterval(digest, DIGEST_TICK_MS);
```

- [ ] **Step 4: Clear the new timer on shutdown**

In `shutdown`, add alongside the existing `clearInterval` calls:

```typescript
    clearInterval(digestTimer);
```

This matters: the file's own comment explains that a surviving interval keeps the event loop alive, systemd's SIGTERM then times out after 90s, and the next deploy's `getUpdates` collides with the dying process (409 Conflict).

- [ ] **Step 5: Verify the build and full suite**

Run: `cd swipe-bot && npm run build && npm test`
Expected: `tsc` clean, all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add swipe-bot/src/index.ts
git commit -m "index: drive instant pings from the poll and digests from their own tick"
```

---

### Task 9: Pause and notification controls in /settings

Nothing above is reachable by a user yet.

**Files:**
- Create: `swipe-bot/src/notify-ui.ts`
- Modify: `swipe-bot/src/bot.ts` (register the new actions; add the entry to the settings menu)
- Test: `swipe-bot/test/notify-ui.test.ts`

**Interfaces:**
- Consumes: `getNotifySettings`, `updateNotifySettings` (Task 2); locale keys (Task 5).
- Produces:
  - `renderNotifyMenu(db: DB, chatId: number, profile: SearchProfile): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> }`
  - `nextDailyCap(current: number, direction: 'less' | 'more'): number`
  - `CAP_LADDER = [0, 1, 3, 6, 12]`

- [ ] **Step 1: Write the failing test**

Create `swipe-bot/test/notify-ui.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNotifyMenu, nextDailyCap, CAP_LADDER } from '../src/notify-ui.js';
import { openDb, createSearchProfile, getSearchProfile, updateNotifySettings } from '../src/db.js';

function prefs() {
  return {
    priceFrom: null, priceTo: 900, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null,
    includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false,
    commuteDestination: null, commuteLat: null, commuteLon: null,
  };
}

test('nextDailyCap steps down the ladder and stops at the floor', () => {
  assert.equal(nextDailyCap(6, 'less'), 3);
  assert.equal(nextDailyCap(3, 'less'), 1);
  assert.equal(nextDailyCap(1, 'less'), 0);
  assert.equal(nextDailyCap(0, 'less'), 0);
});

test('nextDailyCap steps up the ladder and stops at the ceiling', () => {
  assert.equal(nextDailyCap(6, 'more'), 12);
  assert.equal(nextDailyCap(12, 'more'), 12);
});

test('nextDailyCap snaps an off-ladder value onto the ladder', () => {
  assert.ok(CAP_LADDER.includes(nextDailyCap(7, 'less')));
  assert.ok(CAP_LADDER.includes(nextDailyCap(7, 'more')));
});

test('renderNotifyMenu offers Pause for an active profile and Resume for a paused one', () => {
  const db = openDb(':memory:');
  const id = createSearchProfile(db, 1, 'Test', prefs()).id;
  const profile = getSearchProfile(db, id)!;

  const active = renderNotifyMenu(db, 1, profile);
  assert.match(JSON.stringify(active.keyboard), /notify:pause/);

  updateNotifySettings(db, id, { paused: true });
  const paused = renderNotifyMenu(db, 1, profile);
  assert.match(JSON.stringify(paused.keyboard), /notify:resume/);
});

test('renderNotifyMenu states the current cap and digest hours', () => {
  const db = openDb(':memory:');
  const id = createSearchProfile(db, 1, 'Test', prefs()).id;
  updateNotifySettings(db, id, { dailyCap: 3, digestHours: [9, 19] });
  const { text } = renderNotifyMenu(db, 1, getSearchProfile(db, id)!);

  assert.match(text, /3/);
  assert.match(text, /09:00/);
  assert.match(text, /19:00/);
  assert.ok(!text.includes('{'), 'no unsubstituted placeholders');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swipe-bot && npx tsx --test test/notify-ui.test.ts`
Expected: FAIL — cannot find module `../src/notify-ui.js`.

- [ ] **Step 3: Write minimal implementation**

Create `swipe-bot/src/notify-ui.ts`:

```typescript
import { Markup } from 'telegraf';
import { type DB, type SearchProfile, getNotifySettings } from './db.js';
import { t } from './locales.js';

/** Discrete choices for instant alerts per day. 0 means digest-only; the user never types a number. */
export const CAP_LADDER = [0, 1, 3, 6, 12];

/** Next rung in the requested direction, snapping an off-ladder value onto the nearest rung first. */
export function nextDailyCap(current: number, direction: 'less' | 'more'): number {
  const nearest = CAP_LADDER.reduce((best, v) =>
    Math.abs(v - current) < Math.abs(best - current) ? v : best, CAP_LADDER[0]);
  const index = CAP_LADDER.indexOf(nearest);
  const next = direction === 'less' ? index - 1 : index + 1;
  return CAP_LADDER[Math.max(0, Math.min(CAP_LADDER.length - 1, next))];
}

const pad = (h: number): string => `${String(h).padStart(2, '0')}:00`;

export function renderNotifyMenu(
  db: DB, chatId: number, profile: SearchProfile,
): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const s = getNotifySettings(db, profile.id);
  const status = t(db, chatId, s.paused ? 'btn_resume_search' : 'btn_pause_search');

  const text = t(db, chatId, 'notify_menu_header', {
    name: profile.name,
    status,
    cap: s.dailyCap,
    hours: s.digestHours.map(pad).join(' & '),
    quietStart: s.quietStart,
    quietEnd: s.quietEnd,
  });

  const toggle = s.paused
    ? Markup.button.callback(t(db, chatId, 'btn_resume_search'), `notify:resume:${profile.id}`)
    : Markup.button.callback(t(db, chatId, 'btn_pause_search'), `notify:pause:${profile.id}`);

  return {
    text,
    keyboard: Markup.inlineKeyboard([
      [toggle],
      [
        Markup.button.callback(t(db, chatId, 'btn_notify_less'), `notify:cap:less:${profile.id}`),
        Markup.button.callback(t(db, chatId, 'btn_notify_more'), `notify:cap:more:${profile.id}`),
      ],
    ]),
  };
}
```

In `swipe-bot/src/bot.ts`, import the module:

```typescript
import { renderNotifyMenu, nextDailyCap } from './notify-ui.js';
```

Add a `🔔 Notifications` row to the existing settings menu keyboard, using the `settings_notifications` locale key and callback data `notify:menu`, following the exact pattern the neighbouring settings buttons already use. Then register three actions alongside the existing `bot.action(...)` handlers, matching their established shape (ownership check, `answerCbQuery`, re-render):

```typescript
  bot.action(/^notify:menu$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const profile = getActiveSearchProfile(db, chatId);
    if (!profile) { await ctx.answerCbQuery(t(db, chatId, 'no_active_search')); return; }
    const { text, keyboard } = renderNotifyMenu(db, chatId, profile);
    await ctx.answerCbQuery();
    await ctx.reply(text, keyboard);
  });

  bot.action(/^notify:(pause|resume):(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const paused = ctx.match[1] === 'pause';
    const profile = getSearchProfile(db, Number(ctx.match[2]));
    if (!profile || profile.chatId !== chatId) { await ctx.answerCbQuery(t(db, chatId, 'search_no_longer_exists')); return; }

    updateNotifySettings(db, profile.id, { paused });
    await ctx.answerCbQuery();
    await ctx.reply(t(db, chatId, paused ? 'notify_paused' : 'notify_resumed', { name: profile.name }));
  });

  bot.action(/^notify:cap:(less|more):(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const direction = ctx.match[1] as 'less' | 'more';
    const profile = getSearchProfile(db, Number(ctx.match[2]));
    if (!profile || profile.chatId !== chatId) { await ctx.answerCbQuery(t(db, chatId, 'search_no_longer_exists')); return; }

    updateNotifySettings(db, profile.id, { dailyCap: nextDailyCap(getNotifySettings(db, profile.id).dailyCap, direction) });
    const { text, keyboard } = renderNotifyMenu(db, chatId, profile);
    await ctx.answerCbQuery();
    await ctx.reply(text, keyboard);
  });
```

Add `getNotifySettings` and `updateNotifySettings` to `bot.ts`'s existing `./db.js` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm run build && npm test`
Expected: `tsc` clean, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/notify-ui.ts swipe-bot/src/bot.ts swipe-bot/test/notify-ui.test.ts
git commit -m "settings: add pause and alert-frequency controls per search"
```

---

### Task 10: Update /help and the feature docs

**Files:**
- Modify: `swipe-bot/src/locales/en.ts`, `ru.ts`, `de.ts` (the `help_full` key)
- Modify: `README.md` (the swipe-bot section)
- Test: `swipe-bot/test/locales.test.ts`

**Interfaces:**
- Consumes: locale keys from Task 5.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `swipe-bot/test/locales.test.ts`:

```typescript
test('help text documents pausing and no longer promises a card per new listing', () => {
  for (const catalog of [en, ru, de]) {
    assert.ok(catalog.help_full.length > 0);
    assert.ok(!/\/next\b.*\bevery new\b/i.test(catalog.help_full));
  }
  assert.match(en.help_full, /pause/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swipe-bot && npx tsx --test test/locales.test.ts`
Expected: FAIL — `en.help_full` does not mention pausing.

- [ ] **Step 3: Update help copy in all three catalogs**

Rewrite the notifications paragraph of `help_full` in each catalog to state the new behaviour: a small number of instant alerts a day for standout matches, a summary at the configured hours, quiet hours overnight, and that any search can be paused from `/settings` without losing it. Keep the existing `{maxProfiles}` and `{safetyNotice}` placeholders intact — `buildHelpText` substitutes both, and dropping either would print a literal `{safetyNotice}` in place of the money-transfer warning.

- [ ] **Step 4: Update the README**

In `README.md`, update the swipe-bot description to describe the notifier behaviour rather than per-listing pushes, and document `notify_settings` defaults (6 instant alerts/day, digests at 09:00 and 19:00, quiet 22:00–08:00, Europe/Vienna).

- [ ] **Step 5: Run the full suite and build**

Run: `cd swipe-bot && npm run build && npm test`
Expected: `tsc` clean, all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add swipe-bot/src/locales/ README.md
git commit -m "docs: describe the quiet notifier in /help and the README"
```

---

### Task 11: Production pre-flight and deploy

Not code. Do not skip — two checks here can only be done against the live box.

**Files:**
- Modify: none.

**Interfaces:**
- Consumes: everything above.
- Produces: a deployed, verified bot.

- [ ] **Step 1: Check for group-chat profiles**

The spec's identity defect requires this before Plan 2, and it is cheap to answer now. On `swipe-bot-vm`:

```bash
sqlite3 /path/to/bot.sqlite \
  "SELECT COUNT(*) FROM search_profiles WHERE chat_id < 0;"
```

Expected: `0`. If non-zero, **stop** and report the count — those profiles are shared by every member of a group chat and will be unreachable from the Mini App, and the migration decision is the user's.

- [ ] **Step 2: Back up the production database**

```bash
sqlite3 /path/to/bot.sqlite ".backup '/path/to/bot.sqlite.bak-2026-08-19'"
```

Three new tables are additive and `CREATE TABLE IF NOT EXISTS` is safe on an existing DB, but a backup costs seconds and this is the user's live search history.

- [ ] **Step 3: Deploy**

```bash
git pull && npm install && npm run build && sudo systemctl restart swipe-bot
```

- [ ] **Step 4: Verify the tables exist and defaults resolve**

```bash
sqlite3 /path/to/bot.sqlite ".tables" | grep -E 'notify_settings|notify_log|photo_cache'
journalctl -u swipe-bot -n 50 --no-pager
```

Expected: all three tables listed; logs show `swipe-bot: Telegram long-polling started` and a `poll: N new listings` line with no `dispatch` errors.

- [ ] **Step 5: Verify behaviour in Telegram**

- `/settings` shows the 🔔 Notifications entry.
- Opening it shows the current cap and digest hours with no `{placeholder}` text.
- Pause, then confirm the menu re-renders offering Resume.
- Confirm no card-per-listing burst arrives on the next poll.

- [ ] **Step 6: Watch one digest boundary**

At the next configured digest hour (09:00 or 19:00 Vienna), confirm exactly one text message per active profile arrives, and that a second does not arrive on the following 5-minute tick. This is the single most likely regression in the plan, because `isDigestDue` idempotence is the only thing preventing a message every 5 minutes for an hour.

- [ ] **Step 7: Report, and let the user push**

Do not `git push`. Report what shipped, the group-profile count from Step 1, and the observed digest behaviour.

---

## Self-Review

**Spec coverage.** `notify_settings`/`notify_log`/`photo_cache` → Task 2. `scoreListings` → Task 1. Relative percentile threshold with `valueFlag === 'good'` floor and cold-start degradation → Tasks 3 and 7. Instant/digest/quiet-hours rollover → Tasks 3, 7, 8. Pause switch → Tasks 2, 7, 9. `file_id` cache and fail-soft sends → Tasks 4, 6. Pure-functions-over-injected-clock testing → Task 3. Private-chat guard, image proxy, express, `initData`, and all Mini App work → **deliberately deferred to Plan 2**, per the spec's own Sequencing section; the negative-`chat_id` pre-flight is pulled forward into Task 11 because it can block Plan 2 and costs one query.

**Placeholders.** None. Every code step carries real code. Task 10 Step 3 describes copy rather than quoting it, which is intentional: the three `help_full` strings are long existing prose being edited in place, and quoting them in full would be a worse instruction than naming exactly what must change and what must not be dropped.

**Type consistency.** `NotifySettings` field names are identical across Tasks 2, 3, 7, and 9. `sendPhotoCached`'s signature is identical in Tasks 4, 6, and 7. `scoreListings`'s return shape `{listing, score}` is consistent in Tasks 1 and 7. `getNotifiedListingIds` returns `Set<string>` everywhere. `dispatchInstant`/`dispatchDigests` names match between Tasks 7 and 8.
