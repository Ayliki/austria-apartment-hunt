# Listing photo/address refresh + delisting cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill photos/addresses for every listing already in the DB (once, automatically, on the first process start after this ships) and keep the DB clean forever after by detecting and removing listings that get taken off the site.

**Architecture:** A new `refreshAllListings(db, deps)` in `swipe-bot/src/refresh.ts` re-fetches every stored listing's detail from its source (willhaben/immoscout), updates `images`/`address_line`/`lat`/`lon` on success, flags `is_delisted` on a genuine "not found" response, and leaves the row untouched on any other (transient) error. After the sweep, rows flagged `is_delisted` that nobody has shortlisted are hard-deleted. Wired into `index.ts` as a second timer alongside the existing 3h poll — running immediately at startup (the backfill) and then every 24h (the standing cleanup).

**Tech Stack:** TypeScript, `better-sqlite3`, the existing `apt-hunter` MCP-client plumbing (`McpConnection`), `node:test`.

## Global Constraints

- Refresh only `images`, `address_line`, `lat`, `lon`, `is_delisted` — never `price`/`title`/`rooms`/`area` (out of scope per the spec's non-goals).
- Never call the Google Geocoding API from this feature — `address_line` backfill alone is enough; the existing lazy fallback in `bot.ts`'s `getCommuteLineFor` handles the rest.
- A row already correct (non-empty `images`, non-null `address_line`) must never be regressed to empty/null by a refresh that returns less data than what's already stored — always prefer existing data when the fresh fetch has nothing.
- Never delete a listing that appears in anyone's `shortlist`, even if delisted — flag it instead.
- Never classify a rate-limit/network/parse error as "delisted" — only an explicit "not found" response from the source may set `is_delisted = 1`.
- All new DB mutation helpers live in `swipe-bot/src/db.ts`, matching the existing convention (`upsertListing`, `setListingCoords`, etc. are all there, not scattered across callers).

---

### Task 1: Export `willhabenSpec`/`immoscoutSpec` from apt-hunter's `hunt.ts`

`refresh.ts` (Task 3) needs to open its own `McpConnection` to each source, the same way `huntWillhaben`/`huntImmoscout` already do — but those spec builders are currently private to `hunt.ts`. Exporting them avoids duplicating the env-var-driven path resolution logic.

**Files:**
- Modify: `apt-hunter/src/hunt.ts:51` (`immoscoutSpec`), `apt-hunter/src/hunt.ts:64` (`willhabenSpec`)
- Test: `apt-hunter/test/hunt.test.ts`

**Interfaces:**
- Produces: `willhabenSpec(): McpServerSpec`, `immoscoutSpec(): McpServerSpec`, both exported from `apt-hunter/dist/hunt.js` after build.

- [ ] **Step 1: Write the failing test**

Add to `apt-hunter/test/hunt.test.ts` (alongside the existing imports/tests):

```ts
import { combineHuntResults, selectEnrichIds, willhabenSpec, immoscoutSpec } from '../src/hunt.js';
```

```ts
test('willhabenSpec defaults to the vendored patched package, respects WILLHABEN_MCP_PATH override', () => {
  delete process.env.WILLHABEN_MCP_PATH;
  const spec = willhabenSpec();
  assert.equal(spec.command, 'node');
  assert.match(spec.args[0], /willhaben-mcp-patched\/dist\/index\.js$/);

  process.env.WILLHABEN_MCP_PATH = '/custom/willhaben.js';
  assert.deepEqual(willhabenSpec().args, ['/custom/willhaben.js']);
  delete process.env.WILLHABEN_MCP_PATH;
});

test('immoscoutSpec defaults to the local immoscout-mcp build, respects IMMOSCOUT_MCP_PATH override', () => {
  delete process.env.IMMOSCOUT_MCP_PATH;
  const spec = immoscoutSpec();
  assert.equal(spec.command, 'node');
  assert.match(spec.args[0], /immoscout-mcp\/dist\/index\.js$/);

  process.env.IMMOSCOUT_MCP_PATH = '/custom/immoscout.js';
  assert.deepEqual(immoscoutSpec().args, ['/custom/immoscout.js']);
  delete process.env.IMMOSCOUT_MCP_PATH;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apt-hunter && npm test -- --test-name-pattern="willhabenSpec|immoscoutSpec"`
Expected: FAIL — `willhabenSpec`/`immoscoutSpec` are not exported (TypeScript compile error via `tsx`: `Module '"../src/hunt.js"' has no exported member 'willhabenSpec'`).

- [ ] **Step 3: Add the `export` keyword**

In `apt-hunter/src/hunt.ts`, change:

```ts
function immoscoutSpec(): McpServerSpec {
```
to
```ts
export function immoscoutSpec(): McpServerSpec {
```

and change:

```ts
function willhabenSpec(): McpServerSpec {
```
to
```ts
export function willhabenSpec(): McpServerSpec {
```

No other lines change — both functions' bodies are already correct.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apt-hunter && npm test -- --test-name-pattern="willhabenSpec|immoscoutSpec"`
Expected: PASS (2 tests)

- [ ] **Step 5: Build apt-hunter so its `dist/` reflects the new exports**

Run: `cd apt-hunter && npm run build`
Expected: exits 0, `apt-hunter/dist/hunt.js` now exports `willhabenSpec`/`immoscoutSpec`.

- [ ] **Step 6: Run the full apt-hunter test suite**

Run: `cd apt-hunter && npm test`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
cd ~/austria-apartment-hunt
git add apt-hunter/src/hunt.ts apt-hunter/test/hunt.test.ts apt-hunter/dist
git commit -m "Export willhabenSpec/immoscoutSpec so swipe-bot can open its own MCP connections"
```

---

### Task 2: `is_delisted` schema, migration, and DB helpers

**Files:**
- Modify: `swipe-bot/src/db.ts`
- Test: `swipe-bot/test/db.test.ts`

**Interfaces:**
- Consumes: nothing new (only existing `DB`, `ListingRow`, `openDb`, `upsertListing`).
- Produces (used by Task 3 and Task 4):
  - `ListingRow.isDelisted: boolean` (new required field)
  - `getListingsBySource(db: DB, source: 'willhaben' | 'immoscout'): ListingRow[]` — ordered by `first_seen` ascending
  - `applyListingRefresh(db: DB, id: string, data: { images: string[]; addressLine: string | null; lat: number | null; lon: number | null }): void`
  - `setListingDelisted(db: DB, id: string, delisted: boolean): void`
  - `deleteDelistedUnshortlisted(db: DB): number` — returns count of rows deleted
  - `getCandidateListings` now excludes `is_delisted = 1` rows (existing signature unchanged)

- [ ] **Step 1: Write the failing tests**

Add to `swipe-bot/test/db.test.ts` (near the bottom, after the existing commute-cache tests). First, extend the two `row()`-adjacent fixtures aren't touched — `isDelisted` is a new `ListingRow` field but `db.test.ts`'s `row()` helper (line 279) already spreads `overrides` last, so add a default there too for clarity:

```ts
function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: [],
    description: null, url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
    requiresWaitlistTicket: false, isWg: false, addressLine: null, lat: null, lon: null, isDelisted: false,
    ...overrides,
  };
}
```

Then add these tests:

```ts
test('upsertListing defaults is_delisted to false', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  const [candidate] = getCandidateListings(db, 1, defaultPrefs(1));
  assert.equal(candidate.isDelisted, false);
});

test('getCandidateListings excludes delisted listings', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'live', district: 6 }));
  upsertListing(db, listing({ id: 'gone', district: 6 }));
  setListingDelisted(db, 'willhaben:gone', true);
  const candidates = getCandidateListings(db, 1, defaultPrefs(1));
  assert.deepEqual(candidates.map((c) => c.id), ['willhaben:live']);
});

test('setListingDelisted flips is_delisted both ways', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  setListingDelisted(db, 'willhaben:a', true);
  assert.equal(getListingsByIds(db, ['willhaben:a'])[0].isDelisted, true);
  setListingDelisted(db, 'willhaben:a', false);
  assert.equal(getListingsByIds(db, ['willhaben:a'])[0].isDelisted, false);
});

test('getListingsBySource returns only that source\'s rows, oldest first_seen first', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: '1', source: 'willhaben', district: 6 }));
  upsertListing(db, listing({ id: '2', source: 'immoscout', district: 6 }));
  upsertListing(db, listing({ id: '3', source: 'willhaben', district: 6 }));
  const wh = getListingsBySource(db, 'willhaben');
  assert.deepEqual(wh.map((r) => r.id), ['willhaben:1', 'willhaben:3']);
  const is24 = getListingsBySource(db, 'immoscout');
  assert.deepEqual(is24.map((r) => r.id), ['immoscout:2']);
});

test('applyListingRefresh overwrites images/addressLine/lat/lon and clears is_delisted', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6, images: ['https://img/old.jpg'], addressLine: null, lat: null, lon: null }));
  setListingDelisted(db, 'willhaben:a', true); // simulate a past transient misflag
  applyListingRefresh(db, 'willhaben:a', {
    images: ['https://img/1.jpg', 'https://img/2.jpg'],
    addressLine: '1060 Wien, Mariahilfer Straße 1',
    lat: 48.2, lon: 16.35,
  });
  const [row] = getListingsByIds(db, ['willhaben:a']);
  assert.deepEqual(row.images, ['https://img/1.jpg', 'https://img/2.jpg']);
  assert.equal(row.addressLine, '1060 Wien, Mariahilfer Straße 1');
  assert.equal(row.lat, 48.2);
  assert.equal(row.lon, 16.35);
  assert.equal(row.isDelisted, false); // a fresh successful fetch un-flags it
});

test('applyListingRefresh never regresses existing data when the fresh fetch has nothing', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({
    id: 'a', district: 6,
    images: ['https://img/keep.jpg'], addressLine: '1060 Wien', lat: 48.2, lon: 16.35,
  }));
  applyListingRefresh(db, 'willhaben:a', { images: [], addressLine: null, lat: null, lon: null });
  const [row] = getListingsByIds(db, ['willhaben:a']);
  assert.deepEqual(row.images, ['https://img/keep.jpg']); // empty fetch result never wipes known photos
  assert.equal(row.addressLine, '1060 Wien');
  assert.equal(row.lat, 48.2);
  assert.equal(row.lon, 16.35);
});

test('deleteDelistedUnshortlisted removes a delisted listing nobody shortlisted, along with its swipes/commute_cache', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'gone', district: 6 }));
  recordSwipe(db, 1, 'willhaben:gone', 'pass');
  setCommuteTimes(db, 1, 'willhaben:gone', { walkMinutes: 10, transitMinutes: null, transitSummary: null });
  setListingDelisted(db, 'willhaben:gone', true);

  const deleted = deleteDelistedUnshortlisted(db);

  assert.equal(deleted, 1);
  assert.deepEqual(getListingsByIds(db, ['willhaben:gone']), []);
  assert.deepEqual(getSwipedWithDirection(db, 1), []);
  assert.equal(getCommuteTimes(db, 1, 'willhaben:gone'), null);
});

test('deleteDelistedUnshortlisted keeps a delisted listing someone has shortlisted, flagged but present', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'gone', district: 6 }));
  recordSwipe(db, 1, 'willhaben:gone', 'like'); // shortlists it
  setListingDelisted(db, 'willhaben:gone', true);

  const deleted = deleteDelistedUnshortlisted(db);

  assert.equal(deleted, 0);
  assert.equal(getShortlist(db, 1).length, 1);
  assert.equal(getShortlist(db, 1)[0].isDelisted, true);
});

test('deleteDelistedUnshortlisted is a no-op when nothing is delisted', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'live', district: 6 }));
  assert.equal(deleteDelistedUnshortlisted(db), 0);
  assert.equal(getListingsByIds(db, ['willhaben:live']).length, 1);
});

test('openDb migrates an older database predating is_delisted, defaulting existing rows to false (not delisted)', () => {
  const path = `/tmp/swipe-bot-migration-test-delisted-${Date.now()}.sqlite`;
  const preMigration = openDb(path);
  upsertListing(preMigration, listing({ id: 'a', district: 6 }));
  preMigration.exec('ALTER TABLE listings DROP COLUMN is_delisted');
  preMigration.close();

  const migrated = openDb(path);
  const [row] = getListingsByIds(migrated, ['willhaben:a']);
  assert.equal(row.isDelisted, false);
  migrated.close();
});
```

Update the import line at the top of `swipe-bot/test/db.test.ts` to pull in the new helpers:

```ts
import {
  openDb, upsertListing, listingKey, getUserPrefs, setUserPrefs, getAllUserPrefs,
  recordSwipe, getShortlist, removeFromShortlist, getCandidateListings, getSwipedWithDirection,
  getListingsByIds, getAllListingIds, matchesPrefs, getCommuteTimes, setCommuteTimes, setListingCoords,
  getListingsBySource, applyListingRefresh, setListingDelisted, deleteDelistedUnshortlisted, type ListingRow,
} from '../src/db.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — compile error, `getListingsBySource`/`applyListingRefresh`/`setListingDelisted`/`deleteDelistedUnshortlisted` don't exist yet, and `ListingRow` has no `isDelisted`.

- [ ] **Step 3: Implement the schema + migration**

In `swipe-bot/src/db.ts`, add `is_delisted` to the `listings` table in `SCHEMA` (right after `address_line`):

```ts
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  price REAL, price_per_sqm REAL, area REAL, rooms REAL,
  district INTEGER, is_private INTEGER,
  images TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  value_flag TEXT,
  first_seen TEXT NOT NULL,
  requires_waitlist_ticket INTEGER NOT NULL DEFAULT 0,
  is_wg INTEGER NOT NULL DEFAULT 0,
  address_line TEXT,
  lat REAL, lon REAL,
  is_delisted INTEGER NOT NULL DEFAULT 0
);
```

In `migrate()`, add (after the `address_line` migration block):

```ts
  if (!listingColumns.includes('is_delisted')) {
    db.exec('ALTER TABLE listings ADD COLUMN is_delisted INTEGER NOT NULL DEFAULT 0');
  }
```

- [ ] **Step 4: Add `isDelisted` to `ListingRow` and `rowToListing`**

In the `ListingRow` interface:

```ts
export interface ListingRow {
  id: string;
  source: 'willhaben' | 'immoscout';
  title: string;
  price: number | null;
  pricePerSqm: number | null;
  area: number | null;
  rooms: number | null;
  district: number | null;
  isPrivate: boolean | null;
  images: string[];
  description: string | null;
  url: string;
  valueFlag: 'good' | 'fair' | 'premium' | null;
  firstSeen: string;
  requiresWaitlistTicket: boolean;
  isWg: boolean;
  addressLine: string | null;
  lat: number | null;
  lon: number | null;
  /** True once a refresh sweep gets a "not found" response for this listing — see refresh.ts. Rows shortlisted by someone are kept flagged rather than deleted. */
  isDelisted: boolean;
}
```

In `rowToListing`:

```ts
function rowToListing(row: Record<string, unknown>): ListingRow {
  return {
    id: row.id as string,
    source: row.source as 'willhaben' | 'immoscout',
    title: row.title as string,
    price: row.price as number | null,
    pricePerSqm: row.price_per_sqm as number | null,
    area: row.area as number | null,
    rooms: row.rooms as number | null,
    district: row.district as number | null,
    isPrivate: row.is_private == null ? null : Boolean(row.is_private),
    images: JSON.parse(row.images as string),
    description: row.description as string | null,
    url: row.url as string,
    valueFlag: row.value_flag as 'good' | 'fair' | 'premium' | null,
    firstSeen: row.first_seen as string,
    requiresWaitlistTicket: Boolean(row.requires_waitlist_ticket),
    isWg: Boolean(row.is_wg),
    addressLine: row.address_line as string | null,
    lat: row.lat as number | null,
    lon: row.lon as number | null,
    isDelisted: Boolean(row.is_delisted),
  };
}
```

- [ ] **Step 5: Add the new DB helper functions**

Add near `setListingCoords` (after it):

```ts
/** All stored rows for one source, oldest first_seen first — the order refreshAllListings sweeps them in. */
export function getListingsBySource(db: DB, source: 'willhaben' | 'immoscout'): ListingRow[] {
  const rows = db.prepare('SELECT * FROM listings WHERE source = ? ORDER BY first_seen ASC').all(source) as Record<string, unknown>[];
  return rows.map(rowToListing);
}

/**
 * Applies a successful refresh fetch's result onto a stored row. Never regresses already-known-good
 * data: an empty images array or a null addressLine/lat/lon from the fresh fetch keeps whatever was
 * already stored, since a partial or empty response is more likely a parsing gap than the truth.
 * Always clears is_delisted — a successful fetch means the listing is live again (or was never
 * actually gone, e.g. a past transient error had been misclassified).
 */
export function applyListingRefresh(
  db: DB, id: string, data: { images: string[]; addressLine: string | null; lat: number | null; lon: number | null },
): void {
  const current = db.prepare('SELECT images, address_line, lat, lon FROM listings WHERE id = ?').get(id) as
    { images: string; address_line: string | null; lat: number | null; lon: number | null } | undefined;
  if (!current) return;
  const images = data.images.length > 0 ? data.images : (JSON.parse(current.images) as string[]);
  const addressLine = data.addressLine ?? current.address_line;
  const lat = data.lat ?? current.lat;
  const lon = data.lon ?? current.lon;
  db.prepare('UPDATE listings SET images = ?, address_line = ?, lat = ?, lon = ?, is_delisted = 0 WHERE id = ?')
    .run(JSON.stringify(images), addressLine, lat, lon, id);
}

/** Flags (or un-flags) a listing as taken off its source site. See deleteDelistedUnshortlisted for what happens next. */
export function setListingDelisted(db: DB, id: string, delisted: boolean): void {
  db.prepare('UPDATE listings SET is_delisted = ? WHERE id = ?').run(delisted ? 1 : 0, id);
}

/**
 * Hard-deletes every listing flagged is_delisted that nobody has shortlisted, plus its swipes and
 * commute_cache rows (no FKs on this schema, so these are explicit). A delisted listing that IS in
 * someone's shortlist is left alone — deleting it would make the card vanish from /shortlist without
 * a trace, and the person may already be in contact with the landlord. Returns how many were deleted.
 */
export function deleteDelistedUnshortlisted(db: DB): number {
  const rows = db.prepare(`
    SELECT id FROM listings WHERE is_delisted = 1 AND id NOT IN (SELECT listing_id FROM shortlist)
  `).all() as { id: string }[];
  if (rows.length === 0) return 0;
  const del = db.transaction((ids: string[]) => {
    for (const id of ids) {
      db.prepare('DELETE FROM swipes WHERE listing_id = ?').run(id);
      db.prepare('DELETE FROM commute_cache WHERE listing_id = ?').run(id);
      db.prepare('DELETE FROM listings WHERE id = ?').run(id);
    }
  });
  del(rows.map((r) => r.id));
  return rows.length;
}
```

- [ ] **Step 6: Exclude delisted rows from `getCandidateListings`**

In `getCandidateListings`, change the `clauses` initializer:

```ts
export function getCandidateListings(db: DB, chatId: number, prefs: UserPrefs): ListingRow[] {
  const clauses: string[] = [
    'l.id NOT IN (SELECT listing_id FROM swipes WHERE chat_id = @chatId)',
    'l.is_delisted = 0',
  ];
  const params: Record<string, unknown> = { chatId };
  // ... rest unchanged
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS, all tests including the new ones.

- [ ] **Step 8: Commit**

```bash
cd ~/austria-apartment-hunt
git add swipe-bot/src/db.ts swipe-bot/test/db.test.ts
git commit -m "Add is_delisted tracking and refresh/cleanup helpers to the listings table"
```

---

### Task 3: `refresh.ts` — the sweep itself

**Files:**
- Create: `swipe-bot/src/refresh.ts`
- Test: `swipe-bot/test/refresh.test.ts`

**Interfaces:**
- Consumes: `DB`, `getListingsBySource`, `applyListingRefresh`, `setListingDelisted`, `deleteDelistedUnshortlisted` (Task 2); `parseWillhabenDetailText` from `apt-hunter/dist/normalize.js`.
- Produces (used by Task 5): `ListingFetcher` interface, `RefreshDeps` interface, `classifyGetListingError(source, error): 'not-found' | 'transient'`, `refreshAllListings(db, deps, opts?): Promise<RefreshSummary>`.

- [ ] **Step 1: Write the failing tests**

Create `swipe-bot/test/refresh.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGetListingError, refreshAllListings, type ListingFetcher,
} from '../src/refresh.js';
import {
  openDb, upsertListing, setListingDelisted, getListingsByIds, recordSwipe, getShortlist,
} from '../src/db.js';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
  return {
    source: 'willhaben', id: '1', url: 'https://x/1', title: 'Test flat',
    price: 650, pricePerSqm: 15, area: 43, rooms: 2, district: 6, zip: '1060',
    addressLine: null, lat: null, lon: null, isPrivate: true,
    requiresWaitlistTicket: false, isShortTerm: false, isWg: false, images: ['https://img/old.jpg'], description: null,
    dateCreated: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

const WH_DETAIL_TEXT = `# Sanierte Garconniere

💰 **Price:** € 650
🏠 **Address:** 1060, Wien, 06. Bezirk, Mariahilf, Österreich
📍 **Coordinates:** 48.2,16.35
📞 **Contact:** EMAIL

## Key Details
- **Living Area:** 43

## Images (2)
https://cache.willhaben.at/img/1.jpg
https://cache.willhaben.at/img/2.jpg`;

function fetcherReturning(text: string): ListingFetcher {
  return { callToolText: async () => text };
}

function fetcherThrowing(message: string): ListingFetcher {
  return { callToolText: async () => { throw new Error(message); } };
}

const noDelay = { delayMs: 0, sleep: async () => {} };

test('classifyGetListingError: willhaben "not found" is not-found, anything else is transient', () => {
  assert.equal(
    classifyGetListingError('willhaben', new Error('willhaben_get_listing failed: Listing 1370327604 not found. Make sure the ID is correct.')),
    'not-found',
  );
  assert.equal(
    classifyGetListingError('willhaben', new Error('willhaben_get_listing failed: Error getting listing detail: fetch failed')),
    'transient',
  );
});

test('classifyGetListingError: immoscout HTTP 404 and "no Expose" are not-found, other HTTP errors are transient', () => {
  assert.equal(
    classifyGetListingError('immoscout', new Error('immoscout_get_listing failed: Error: GET https://www.immobilienscout24.at/expose/123 failed with HTTP 404')),
    'not-found',
  );
  assert.equal(
    classifyGetListingError('immoscout', new Error('immoscout_get_listing failed: Error: ImmoScout24 expose structure changed: no Expose:* entity in window.__APOLLO_STATE__')),
    'not-found',
  );
  assert.equal(
    classifyGetListingError('immoscout', new Error('immoscout_get_listing failed: Error: GET https://www.immobilienscout24.at/expose/123 failed with HTTP 429')),
    'transient',
  );
});

test('refreshAllListings updates images/address/coords on a successful willhaben fetch', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));

  const summary = await refreshAllListings(db, {
    willhaben: fetcherReturning(WH_DETAIL_TEXT),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  const [row] = getListingsByIds(db, ['willhaben:a']);
  assert.deepEqual(row.images, ['https://cache.willhaben.at/img/1.jpg', 'https://cache.willhaben.at/img/2.jpg']);
  assert.equal(row.addressLine, '1060, Wien, 06. Bezirk, Mariahilf, Österreich');
  assert.equal(row.lat, 48.2);
  assert.equal(row.lon, 16.35);
  assert.deepEqual(summary.willhaben, { checked: 1, updated: 1, delisted: 0, errored: 0 });
});

test('refreshAllListings updates images/address on a successful immoscout fetch (no coords available from detail)', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', source: 'immoscout' }));

  const detail = JSON.stringify({ address: '1070 Wien, Neubaugasse 1', images: [{ url: 'https://img/1.jpg' }, { url: 'https://img/2.jpg' }] });
  const summary = await refreshAllListings(db, {
    willhaben: fetcherReturning(WH_DETAIL_TEXT),
    immoscout: fetcherReturning(detail),
  }, noDelay);

  const [row] = getListingsByIds(db, ['immoscout:a']);
  assert.deepEqual(row.images, ['https://img/1.jpg', 'https://img/2.jpg']);
  assert.equal(row.addressLine, '1070 Wien, Neubaugasse 1');
  assert.equal(row.lat, null); // immoscout detail never carries coords — the lazy geocode fallback handles this later
  assert.equal(summary.immoscout.updated, 1);
});

test('refreshAllListings flags a "not found" willhaben listing as delisted, without touching its stored data', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'gone', images: ['https://img/keep.jpg'] }));

  const summary = await refreshAllListings(db, {
    willhaben: fetcherThrowing('willhaben_get_listing failed: Listing gone not found. Make sure the ID is correct.'),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  const [row] = getListingsByIds(db, ['willhaben:gone']);
  assert.equal(row.isDelisted, true);
  assert.deepEqual(row.images, ['https://img/keep.jpg']); // data untouched, only the flag changed
  assert.equal(summary.willhaben.delisted, 1);
  assert.equal(summary.willhaben.updated, 0);
});

test('refreshAllListings leaves a listing untouched on a transient error (not flagged, not updated)', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'flaky' }));

  const summary = await refreshAllListings(db, {
    willhaben: fetcherThrowing('willhaben_get_listing failed: Error getting listing detail: network error'),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  const [row] = getListingsByIds(db, ['willhaben:flaky']);
  assert.equal(row.isDelisted, false);
  assert.equal(summary.willhaben.errored, 1);
  assert.equal(summary.willhaben.delisted, 0);
  assert.equal(summary.willhaben.updated, 0);
});

test('refreshAllListings deletes delisted-and-unshortlisted rows after the sweep, keeps shortlisted ones flagged', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'gone-unshortlisted' }));
  upsertListing(db, listing({ id: 'gone-shortlisted' }));
  recordSwipe(db, 1, 'willhaben:gone-shortlisted', 'like');

  const notFound = 'willhaben_get_listing failed: Listing x not found. Make sure the ID is correct.';
  const summary = await refreshAllListings(db, {
    willhaben: fetcherThrowing(notFound),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  assert.equal(summary.deleted, 1);
  assert.deepEqual(getListingsByIds(db, ['willhaben:gone-unshortlisted']), []);
  assert.equal(getShortlist(db, 1).length, 1);
  assert.equal(getShortlist(db, 1)[0].isDelisted, true);
});

test('refreshAllListings un-flags a previously misflagged listing on a fresh successful fetch', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));
  setListingDelisted(db, 'willhaben:a', true);

  await refreshAllListings(db, {
    willhaben: fetcherReturning(WH_DETAIL_TEXT),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  const [row] = getListingsByIds(db, ['willhaben:a']);
  assert.equal(row.isDelisted, false);
});

test('refreshAllListings sweeps both sources independently and sums checked counts correctly', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: '1', source: 'willhaben' }));
  upsertListing(db, listing({ id: '2', source: 'willhaben' }));
  upsertListing(db, listing({ id: '3', source: 'immoscout' }));

  const summary = await refreshAllListings(db, {
    willhaben: fetcherReturning(WH_DETAIL_TEXT),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  assert.equal(summary.willhaben.checked, 2);
  assert.equal(summary.immoscout.checked, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — `src/refresh.ts` doesn't exist yet (`Cannot find module '../src/refresh.js'`).

- [ ] **Step 3: Implement `src/refresh.ts`**

```ts
import { parseWillhabenDetailText } from 'apt-hunter/dist/normalize.js';
import {
  type DB, type ListingRow,
  getListingsBySource, applyListingRefresh, setListingDelisted, deleteDelistedUnshortlisted,
} from './db.js';

export type ListingSource = 'willhaben' | 'immoscout';

/** Minimal shape refreshAllListings needs from an MCP connection — matches apt-hunter's McpConnection.callToolText, so a real McpConnection satisfies this structurally with no adapter. */
export interface ListingFetcher {
  callToolText(tool: string, args: Record<string, unknown>): Promise<string>;
}

export interface RefreshDeps {
  willhaben: ListingFetcher;
  immoscout: ListingFetcher;
}

export interface SourceRefreshSummary {
  checked: number;
  updated: number;
  delisted: number;
  errored: number;
}

export interface RefreshSummary {
  willhaben: SourceRefreshSummary;
  immoscout: SourceRefreshSummary;
  /** Rows deleted after the sweep: is_delisted and not in anyone's shortlist. */
  deleted: number;
}

/** Gentle default pace between get_listing calls in a full sweep — 361 rows at this rate finishes in well under two minutes. */
const DEFAULT_DELAY_MS = 300;

interface ImmoscoutDetail {
  address?: string | null;
  images?: { url: string }[];
}

/**
 * Distinguishes "the listing is genuinely gone" from any other failure (rate limit, network blip,
 * upstream markup change). Only 'not-found' may ever set is_delisted — misclassifying a transient
 * failure here would silently delete a live listing out from under a user. Matches against the
 * exact strings each vendored MCP server emits (see willhaben-mcp-patched/dist/index.js's
 * willhaben_get_listing handler and immoscout-mcp/dist/{listing,fetcher}.js).
 */
export function classifyGetListingError(source: ListingSource, err: Error): 'not-found' | 'transient' {
  const msg = err.message;
  if (source === 'willhaben') return msg.includes('not found') ? 'not-found' : 'transient';
  return msg.includes('HTTP 404') || msg.includes('no Expose') ? 'not-found' : 'transient';
}

async function refreshSource(
  db: DB, source: ListingSource, fetcher: ListingFetcher, delayMs: number, sleep: (ms: number) => Promise<void>,
): Promise<SourceRefreshSummary> {
  const rows = getListingsBySource(db, source);
  const tool = source === 'willhaben' ? 'willhaben_get_listing' : 'immoscout_get_listing';
  const summary: SourceRefreshSummary = { checked: 0, updated: 0, delisted: 0, errored: 0 };

  for (const row of rows) {
    summary.checked++;
    const rawId = row.id.slice(source.length + 1); // "willhaben:123" -> "123"
    try {
      const text = await fetcher.callToolText(tool, { id: rawId });
      if (source === 'willhaben') {
        const detail = parseWillhabenDetailText(text);
        applyListingRefresh(db, row.id, { images: detail.images, addressLine: detail.address, lat: detail.lat, lon: detail.lon });
      } else {
        const detail = JSON.parse(text) as ImmoscoutDetail;
        applyListingRefresh(db, row.id, {
          images: (detail.images ?? []).map((i) => i.url),
          addressLine: detail.address ?? null,
          lat: null, // immoscout's detail payload never carries coordinates — the lazy geocode fallback in bot.ts handles this once addressLine is set
          lon: null,
        });
      }
      summary.updated++;
    } catch (err) {
      const kind = classifyGetListingError(source, err as Error);
      if (kind === 'not-found') {
        setListingDelisted(db, row.id, true);
        summary.delisted++;
      } else {
        summary.errored++;
      }
    }
    await sleep(delayMs);
  }
  return summary;
}

/**
 * Re-fetches every stored listing's detail from its source, refreshing images/address/coords and
 * flagging genuinely delisted ones, then hard-deletes delisted rows nobody has shortlisted. Runs
 * once per process start (see index.ts) and then on a standing 24h timer — the same function serves
 * as both the one-time backfill and the ongoing cleanup, there is no separate script.
 */
export async function refreshAllListings(
  db: DB, deps: RefreshDeps, opts: { delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RefreshSummary> {
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const willhaben = await refreshSource(db, 'willhaben', deps.willhaben, delayMs, sleep);
  const immoscout = await refreshSource(db, 'immoscout', deps.immoscout, delayMs, sleep);
  const deleted = deleteDelistedUnshortlisted(db);

  return { willhaben, immoscout, deleted };
}
```

Note: `ListingRow` is imported but unused if your editor flags it — actually it isn't referenced directly in this file's signatures (only via `db.js`'s functions), so drop that import from the `import type` line, keeping only `DB`:

```ts
import {
  type DB,
  getListingsBySource, applyListingRefresh, setListingDelisted, deleteDelistedUnshortlisted,
} from './db.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS, all `refresh.test.ts` tests green, no regressions elsewhere.

- [ ] **Step 5: Typecheck**

Run: `cd swipe-bot && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/austria-apartment-hunt
git add swipe-bot/src/refresh.ts swipe-bot/test/refresh.test.ts
git commit -m "Add refreshAllListings: re-fetch photos/address per listing, flag and clean up delisted ones"
```

---

### Task 4: Show a "no longer listed" badge on delisted shortlist cards

**Files:**
- Modify: `swipe-bot/src/bot.ts:159-174` (`formatCaption`)
- Test: `swipe-bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `ListingRow.isDelisted` (Task 2).
- Produces: `formatCaption` unchanged signature, new behavior only.

- [ ] **Step 1: Write the failing test**

Add to `swipe-bot/test/bot.test.ts`, after the existing `'formatCaption tags WG/shared-flat listings'` test (around line 107). First update the `row()` fixture (line 22) to include the new required field:

```ts
function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Sunny two-room flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: ['https://img/1.jpg'],
    description: null, url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
    requiresWaitlistTicket: false, isWg: false, lat: null, lon: null, isDelisted: false,
    ...overrides,
  };
}
```

Then the test:

```ts
test('formatCaption flags a delisted listing, and only when it actually is', () => {
  const flagged = formatCaption(row({ isDelisted: true }));
  assert.match(flagged, /⚠️ No longer listed/);

  const unflagged = formatCaption(row({ isDelisted: false }));
  assert.doesNotMatch(unflagged, /No longer listed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swipe-bot && npm test`
Expected: FAIL — `formatCaption(row({ isDelisted: true }))` doesn't produce the badge yet (and/or a compile error if `ListingRow`'s `isDelisted` isn't recognized — but Task 2 already added it, so this should just be an assertion failure: badge text absent).

- [ ] **Step 3: Add the flag to `formatCaption`**

In `swipe-bot/src/bot.ts`, update `formatCaption`:

```ts
/** Pure — builds the card caption (title, price/size/rooms/district, eligibility flag, commute line, description, link). Exported for direct testing. */
export function formatCaption(l: ListingRow, commuteLine?: string | null): string {
  const price = l.price != null ? `€${l.price}` : 'price n/a';
  const area = l.area != null ? `${l.area}m²` : '';
  const rooms = l.rooms != null ? `${l.rooms} rooms` : '';
  const district = l.district != null ? `district ${l.district}` : '';
  const details = [area, rooms, district].filter(Boolean).join(' · ');
  const flag = l.requiresWaitlistTicket
    ? '\n⚠️ Municipal/waitlist housing — needs a Vormerkschein, Wohnticket, or Wiener Wohnen registration.'
    : '';
  const wgFlag = l.isWg ? '\n🚪 WG — shared flat / co-living / student room, not a whole apartment.' : '';
  const delistedFlag = l.isDelisted ? '\n⚠️ No longer listed — likely taken down by the advertiser.' : '';
  const commute = commuteLine ? `\n${commuteLine}` : '';
  const base = `${l.title}\n${price} · ${details}${flag}${wgFlag}${delistedFlag}${commute}\n${l.url}`;
  const full = l.description ? `${base}\n\n${l.description}` : base;
  return truncate(full, MAX_CAPTION_LENGTH);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd swipe-bot && npm test`
Expected: PASS, all `bot.test.ts` tests green.

- [ ] **Step 5: Commit**

```bash
cd ~/austria-apartment-hunt
git add swipe-bot/src/bot.ts swipe-bot/test/bot.test.ts
git commit -m "Show a no-longer-listed badge on delisted shortlist cards"
```

---

### Task 5: Wire the refresh sweep into `index.ts`

**Files:**
- Modify: `swipe-bot/src/index.ts`

**Interfaces:**
- Consumes: `refreshAllListings`, `RefreshDeps` (Task 3); `McpConnection` from `apt-hunter/dist/mcp-client.js`; `willhabenSpec`/`immoscoutSpec` from `apt-hunter/dist/hunt.js` (Task 1).
- Produces: nothing new consumed elsewhere — this is the top-level wiring, matching how `poll`/`pollTimer` are wired with no direct test (consistent with the existing codebase: `index.ts` has no test file today).

- [ ] **Step 1: Implement the change**

Replace the full contents of `swipe-bot/src/index.ts` with:

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpConnection } from 'apt-hunter/dist/mcp-client.js';
import { willhabenSpec, immoscoutSpec } from 'apt-hunter/dist/hunt.js';
import { openDb } from './db.js';
import { createBot, BOT_COMMANDS, type BotDeps } from './bot.js';
import { runPoll } from './poller.js';
import { refreshAllListings } from './refresh.js';
import { notifyNewMatches } from './notify.js';
import { geocode, computeCommute } from './commute.js';

const POLL_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3h, matches apt-hunter's LaunchAgent cadence
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day is plenty at this DB's size (hundreds of rows, not thousands)

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN env var is required');
  // Commute times are best-effort: an unset key just means every card ships without them (see commute.ts's error handling).
  const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';

  const here = dirname(fileURLToPath(import.meta.url)); // swipe-bot/dist
  const dbPath = process.env.SWIPE_BOT_DB_PATH ?? join(here, '..', 'data', 'bot.sqlite');
  const db = openDb(dbPath);
  const deps: BotDeps = {
    geocode: (address) => geocode(address, mapsApiKey),
    computeCommute: (origin, destination) => computeCommute(origin, destination, mapsApiKey),
  };
  const bot = createBot(db, token, deps);
  await bot.telegram.setMyCommands(BOT_COMMANDS); // populates Telegram's persistent ☰ menu

  const poll = async () => {
    try {
      const { inserted, warnings } = await runPoll(db);
      for (const w of warnings) console.error('WARNING:', w);
      console.log(`poll: ${inserted.length} new listings`);
      await notifyNewMatches(bot.telegram, db, inserted, deps.computeCommute, deps.geocode);
    } catch (err) {
      console.error('poll failed:', err);
    }
  };

  // Refreshes photos/address for every stored listing and flags/cleans up ones taken off the site.
  // The first run after this ships (right here, at startup) doubles as the one-time backfill for
  // rows inserted before this feature existed — there's no separate backfill script.
  const refresh = async () => {
    const willhabenConn = new McpConnection(willhabenSpec());
    const immoscoutConn = new McpConnection(immoscoutSpec());
    try {
      await willhabenConn.connect();
      await immoscoutConn.connect();
      const summary = await refreshAllListings(db, { willhaben: willhabenConn, immoscout: immoscoutConn });
      console.log('refresh:', JSON.stringify(summary));
    } catch (err) {
      console.error('refresh failed:', err);
    } finally {
      await willhabenConn.close().catch((err) => console.error('willhaben conn close failed:', err));
      await immoscoutConn.close().catch((err) => console.error('immoscout conn close failed:', err));
    }
  };

  await poll(); // seed the DB immediately on startup, then on the interval
  const pollTimer = setInterval(poll, POLL_INTERVAL_MS);

  await refresh(); // backfill on first start; standing cleanup on the interval below
  const refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);

  // Register signal handlers before launching: launch() in long-polling mode
  // never resolves while the bot is running, so handlers registered after
  // `await`ing it would only take effect once the bot has already stopped.
  //
  // The interval above keeps the event loop alive forever, so bot.stop()
  // alone never lets the process exit — systemd's SIGTERM then times out
  // after 90s and SIGKILLs it, and the next deploy's fresh getUpdates call
  // collides with the still-dying old one (409 Conflict). Clear the timer
  // and exit explicitly so shutdown is immediate.
  const shutdown = (signal: string) => {
    clearInterval(pollTimer);
    clearInterval(refreshTimer);
    try {
      bot.stop(signal);
    } catch (err) {
      console.error('bot.stop failed during shutdown:', err);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Don't await: use the onLaunch callback for the startup log instead, and
  // an explicit .catch() so startup failures (e.g. bad token, network error
  // during the getMe() call launch() makes before polling starts) are still
  // caught and logged/exit non-zero, instead of becoming an unhandled
  // rejection that main().catch() would never see.
  bot
    .launch(() => console.log('swipe-bot: Telegram long-polling started'))
    .catch((err) => {
      console.error('bot.launch failed:', err);
      process.exit(1);
    });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `cd swipe-bot && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `cd swipe-bot && npm run build`
Expected: exits 0.

- [ ] **Step 4: Run the full swipe-bot test suite**

Run: `cd swipe-bot && npm test`
Expected: PASS, no regressions (index.ts itself has no direct test, matching the existing pattern for `poll`/`pollTimer`).

- [ ] **Step 5: Commit**

```bash
cd ~/austria-apartment-hunt
git add swipe-bot/src/index.ts swipe-bot/dist
git commit -m "Run the listing refresh/delisting sweep at startup and every 24h"
```

---

### Task 6: Full-repo verification and deploy

**Files:** none (verification only)

- [ ] **Step 1: Run every workspace's test suite**

```bash
cd ~/austria-apartment-hunt
(cd apt-hunter && npm test)
(cd swipe-bot && npm test)
```
Expected: all PASS.

- [ ] **Step 2: Typecheck every workspace**

```bash
(cd apt-hunter && npx tsc --noEmit -p .)
(cd swipe-bot && npx tsc --noEmit -p .)
```
Expected: no errors.

- [ ] **Step 3: Push**

Ask the user for explicit go-ahead before pushing (per standing project convention — commit freely, push only on request). Once confirmed:

```bash
git push
```

- [ ] **Step 4: Redeploy the VM**

```bash
gcloud compute ssh swipe-bot-vm --project austria-swipe-bot --zone us-central1-a --command \
  "cd ~/austria-apartment-hunt && git pull && (cd apt-hunter && npm install && npm run build) && (cd swipe-bot && npm install && npm run build) && sudo systemctl restart swipe-bot"
```

- [ ] **Step 5: Verify the sweep actually ran**

```bash
gcloud compute ssh swipe-bot-vm --project austria-swipe-bot --zone us-central1-a --command \
  "sudo journalctl -u swipe-bot --since '5 minutes ago' | grep -E 'refresh:|poll:'"
```
Expected: a `refresh: {...}` log line showing non-zero `checked` counts for both sources, and `deleted`/`delisted` values that make sense (small numbers, not e.g. all 361 rows deleted — that would indicate the classifier is misfiring and needs to be caught before it does real damage).

- [ ] **Step 6: Confirm the bot still responds**

Send `/next` to the bot from Telegram and confirm a card arrives with buttons working, then `/shortlist` and confirm any delisted item shows the new badge.
