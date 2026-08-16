# Onboarding, Results & Multi-Search Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild swipe-bot's onboarding as a fast button-chip wizard, fix the two "dump" surfaces (`/shortlist`, push notifications) with aggregate-first + paginated delivery, add multiple named search profiles per chat, add elevator/parking filters plus a best-effort pet-mention badge, and add a per-chat RU/EN/DE UI language.

**Architecture:** `search_profiles` (one row per named search, replacing the single-row `user_prefs`) and `chats` (per-chat language) are new sqlite tables in `db.ts`. `bot.ts`'s onboarding moves from a linear free-text/regex wizard to an inline-keyboard state machine that edits one message in place. A new `locales.ts` string-catalog module backs every user-facing string. `apt-hunter`'s `NormalizedListing` gains amenity fields (`lift`, `parkingSpaces`, `floor`, `energyClass`, `availableFrom`, `mentionsPets`) so they can flow from immoscout's already-parsed detail data into the bot's `ListingRow` and become real filters (elevator, parking) or card badges (the rest, plus the pet-mention regex badge).

**Tech Stack:** TypeScript (Node `--import tsx`), Telegraf 4, better-sqlite3, zod, `node:test` + `node:assert/strict`. Monorepo npm workspace: `apt-hunter` (scraping/normalization) is a workspace dependency of `swipe-bot` — changes to `apt-hunter/src` require `npm run build` there before `swipe-bot` picks them up via `apt-hunter/dist/*.js`.

**Spec:** `docs/superpowers/specs/2026-08-16-onboarding-results-redesign-design.md`

## Global Constraints

- Pet-friendliness is **never** a hard filter — only a clearly-labeled unverified badge on the card (spec "Amenity filters & pet badge").
- Listing title/description text is **never** translated — only bot chrome (spec "i18n").
- Max **5 search profiles per chat** (spec "Data model").
- `swipes` stays keyed by `chat_id + listing_id`, not per-profile — a listing already swiped is swiped for the whole chat (spec "Data model").
- Existing single-profile users must be auto-migrated into one `search_profiles` row named `"My Search"` on upgrade — nobody loses their setup (spec "Migration").
- Push notifications: cap 5 per profile per poll, staggered ~1.5s apart, grouped by profile name (spec "Results delivery").
- Run `npm test` (from `swipe-bot/`) after every task's own tests are added, not just the new/changed file in isolation — `bot.ts` changes across nearly every task and regressions elsewhere are easy to miss otherwise.

---

## File Structure

| File | Responsibility |
|---|---|
| `apt-hunter/src/normalize.ts` | +amenity fields on `NormalizedListing`, `detectPetFriendly()` |
| `swipe-bot/src/db.ts` | +`search_profiles`/`chats` tables, migration, profile CRUD, `ListingRow`/`matchesPrefs`/`getCandidateListings` amenity support |
| `swipe-bot/src/locales.ts` *(new)* | string catalog + `t()` helper |
| `swipe-bot/src/locales/en.ts`, `ru.ts`, `de.ts` *(new)* | per-language string tables |
| `swipe-bot/src/wizard.ts` *(new)* | pure wizard state machine (steps, transitions, keyboards) — kept separate from `bot.ts` because it's the largest new surface and needs its own focused test file |
| `swipe-bot/src/bot.ts` | wizard wiring, `/settings`, `/searches`, `/language`, card amenity badges, list-mode rendering |
| `swipe-bot/src/notify.ts` | pacing/cap + list-mode grouped push |
| `swipe-bot/src/mcp-server.ts` | swap `UserPrefs`/`getUserPrefs`/`setUserPrefs` calls for the new profile helpers |
| `swipe-bot/src/poller.ts` | swap `getAllUserPrefs` for `getAllSearchProfiles` |

---

## Task 1: apt-hunter amenity fields + pet-mention detector

**Files:**
- Modify: `apt-hunter/src/normalize.ts`
- Test: `apt-hunter/test/normalize.test.ts`

**Interfaces:**
- Produces: `NormalizedListing` gains `lift: boolean | null`, `parkingSpaces: number | null`, `floor: string | null`, `energyClass: string | null`, `availableFrom: string | null`, `mentionsPets: boolean`. Produces `detectPetFriendly(text: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```typescript
// apt-hunter/test/normalize.test.ts (add near the other detect* tests)
test('detectPetFriendly catches German and English pet-allowed phrasing', () => {
  assert.equal(detectPetFriendly('Haustiere erlaubt nach Absprache'), true);
  assert.equal(detectPetFriendly('Tierhaltung erlaubt'), true);
  assert.equal(detectPetFriendly('Pets allowed, small dogs welcome'), true);
  assert.equal(detectPetFriendly('pet-friendly building'), true);
  assert.equal(detectPetFriendly('Ruhige 2-Zimmer Wohnung im 3. Stock'), false);
});

test('detectPetFriendly does not false-positive on "Haustiere nicht erlaubt"', () => {
  assert.equal(detectPetFriendly('Haustiere nicht erlaubt'), false);
  assert.equal(detectPetFriendly('No pets allowed'), false);
});

test('normalizeImmoscout maps lift/parkingSpaces/floor/energyClass/availableFrom from detail, and mentionsPets from title+description', () => {
  const raw = { exposeId: '1', title: 'Nice flat, pet-friendly', price: 700 };
  const detail = {
    lift: true, parkingSpaces: 2, floor: '3. Stock', energyClass: 'B',
    availableFrom: '2026-09-01', description: 'Sunny flat near the park.',
    images: [],
  };
  const n = normalizeImmoscout(raw, detail);
  assert.equal(n.lift, true);
  assert.equal(n.parkingSpaces, 2);
  assert.equal(n.floor, '3. Stock');
  assert.equal(n.energyClass, 'B');
  assert.equal(n.availableFrom, '2026-09-01');
  assert.equal(n.mentionsPets, true);
});

test('normalizeImmoscout amenity fields are null (not false/0) when no detail is supplied', () => {
  const n = normalizeImmoscout({ exposeId: '2', title: 'Flat', price: 600 });
  assert.equal(n.lift, null);
  assert.equal(n.parkingSpaces, null);
  assert.equal(n.floor, null);
  assert.equal(n.energyClass, null);
  assert.equal(n.availableFrom, null);
  assert.equal(n.mentionsPets, false);
});

test('normalizeWillhaben amenity structured fields are always null (willhaben has no such data), mentionsPets still detected from description', () => {
  const hit = listingHit({ title: 'Flat' }); // existing test helper in this file
  const n = normalizeWillhaben(hit, { lat: null, lon: null, address: null, images: [], description: 'Haustiere erlaubt!' });
  assert.equal(n.lift, null);
  assert.equal(n.parkingSpaces, null);
  assert.equal(n.mentionsPets, true);
});
```

Check the existing test file for its willhaben-hit test helper name (likely `hit(...)` or similar near the top) and reuse it rather than inventing a new one — `listingHit` above is illustrative, match whatever helper `normalize.test.ts` already defines.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apt-hunter && npm test`
Expected: FAIL — `detectPetFriendly` is not exported, and the amenity fields are `undefined` on the returned objects.

- [ ] **Step 3: Implement**

```typescript
// apt-hunter/src/normalize.ts

export interface NormalizedListing {
  // ...existing fields unchanged...
  /** Structured amenity data — only ever populated from immoscout's detail fetch; willhaben has no equivalent fields. */
  lift: boolean | null;
  parkingSpaces: number | null;
  floor: string | null;
  energyClass: string | null;
  availableFrom: string | null;
  /** Best-effort keyword match on title+description — never a reliable filter, only a badge. */
  mentionsPets: boolean;
}

const PETS_ALLOWED_RE = /haustiere erlaubt|tierhaltung erlaubt|haustierfreundlich|pet[- ]friendly|pets? (?:allowed|ok|welcome)/i;
const PETS_DISALLOWED_RE = /haustiere (?:nicht|verboten)|no pets/i;

/** Best-effort: matches common "pets allowed" phrasing in German or English, but backs off on an explicit "not allowed" nearby — never a reliable signal, callers must treat this as an unverified badge only. */
export function detectPetFriendly(text: string): boolean {
  if (PETS_DISALLOWED_RE.test(text)) return false;
  return PETS_ALLOWED_RE.test(text);
}
```

In `normalizeWillhaben`, add before the closing `};`:

```typescript
    lift: null,
    parkingSpaces: null,
    floor: null,
    energyClass: null,
    availableFrom: null,
    mentionsPets: detectPetFriendly(`${hit.title} ${detail?.description ?? ''}`),
```

In `normalizeImmoscout`, add before the closing `};`:

```typescript
    lift: detail?.lift ?? null,
    parkingSpaces: detail?.parkingSpaces ?? null,
    floor: detail?.floor ?? null,
    energyClass: detail?.energyClass ?? null,
    availableFrom: detail?.availableFrom ?? null,
    mentionsPets: detectPetFriendly(`${raw.title ?? ''} ${detail?.description ?? ''}`),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apt-hunter && npm test`
Expected: PASS

- [ ] **Step 5: Rebuild so the workspace dependency picks up the change**

Run: `cd apt-hunter && npm run build`
Expected: `apt-hunter/dist/normalize.js` is regenerated with the new fields/export. `swipe-bot/node_modules/apt-hunter` is an npm-workspace symlink to `../apt-hunter`, so no reinstall is needed — verify with `ls -la ../swipe-bot/node_modules/apt-hunter` if unsure.

- [ ] **Step 6: Commit**

```bash
git add apt-hunter/src/normalize.ts apt-hunter/test/normalize.test.ts apt-hunter/dist
git commit -m "apt-hunter: add amenity fields and pet-mention detector to NormalizedListing"
```

---

## Task 2: db.ts — search_profiles/chats tables, migration, ListingRow amenity columns

**Files:**
- Modify: `swipe-bot/src/db.ts`
- Test: `swipe-bot/test/db.test.ts`

**Interfaces:**
- Consumes: `NormalizedListing` from Task 1 (`lift`, `parkingSpaces`, `floor`, `energyClass`, `availableFrom`, `mentionsPets`).
- Produces:
  - `interface SearchProfilePrefs { priceFrom, priceTo, districts, roomsFrom, roomsTo, areaFrom, areaTo, includeWaitlistHousing, includeWg, requireElevator, requireParking, commuteDestination, commuteLat, commuteLon }` (same shape as today's `UserPrefs` minus `chatId`, plus `requireElevator`/`requireParking`).
  - `interface SearchProfile { id: number; chatId: number; name: string; active: boolean; createdAt: string; prefs: SearchProfilePrefs }`
  - `MAX_SEARCH_PROFILES_PER_CHAT = 5`
  - `createSearchProfile(db, chatId, name, prefs, makeActive = true): SearchProfile`
  - `getSearchProfiles(db, chatId): SearchProfile[]`
  - `getSearchProfile(db, profileId): SearchProfile | null`
  - `getActiveSearchProfile(db, chatId): SearchProfile | null`
  - `setActiveSearchProfile(db, chatId, profileId): void`
  - `updateSearchProfile(db, profileId, prefs): void`
  - `renameSearchProfile(db, profileId, name): void`
  - `deleteSearchProfile(db, profileId): void`
  - `countSearchProfiles(db, chatId): number`
  - `getAllSearchProfiles(db): SearchProfile[]` (replaces `getAllUserPrefs`)
  - `upsertActiveProfilePrefs(db, chatId, prefs, defaultName = 'My Search'): SearchProfile` (used by the MCP server, which has no wizard)
  - `getChatLanguage(db, chatId): 'en' | 'ru' | 'de'` (defaults to `'en'`)
  - `setChatLanguage(db, chatId, language): void`
  - `ListingRow` gains `lift: boolean | null; parkingSpaces: number | null; floor: string | null; energyClass: string | null; availableFrom: string | null; mentionsPets: boolean`.
  - `UserPrefs`, `getUserPrefs`, `setUserPrefs`, `getAllUserPrefs` are **removed** (Task 3 updates every remaining call site in the same PR-equivalent commit set, but this task's own tests must not reference them).

- [ ] **Step 1: Write the failing tests**

```typescript
// swipe-bot/test/db.test.ts (add)
import {
  createSearchProfile, getSearchProfiles, getActiveSearchProfile, setActiveSearchProfile,
  updateSearchProfile, deleteSearchProfile, countSearchProfiles, getAllSearchProfiles,
  upsertActiveProfilePrefs, getChatLanguage, setChatLanguage, MAX_SEARCH_PROFILES_PER_CHAT,
  type SearchProfilePrefs,
} from '../src/db.js';

function prefs(overrides: Partial<SearchProfilePrefs> = {}): SearchProfilePrefs {
  return {
    priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null,
    areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: false,
    requireElevator: false, requireParking: false,
    commuteDestination: null, commuteLat: null, commuteLon: null,
    ...overrides,
  };
}

test('createSearchProfile makes the first profile for a chat active by default', () => {
  const db = openDb(':memory:');
  const p = createSearchProfile(db, 1, 'Studio Center', prefs());
  assert.equal(p.active, true);
  assert.equal(getActiveSearchProfile(db, 1)!.id, p.id);
});

test('setActiveSearchProfile deactivates every other profile for that chat', () => {
  const db = openDb(':memory:');
  const a = createSearchProfile(db, 1, 'A', prefs());
  const b = createSearchProfile(db, 1, 'B', prefs());
  setActiveSearchProfile(db, 1, b.id);
  assert.equal(getActiveSearchProfile(db, 1)!.id, b.id);
  assert.equal(getSearchProfiles(db, 1).find((p) => p.id === a.id)!.active, false);
});

test('countSearchProfiles and the MAX_SEARCH_PROFILES_PER_CHAT cap', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < MAX_SEARCH_PROFILES_PER_CHAT; i++) createSearchProfile(db, 1, `S${i}`, prefs());
  assert.equal(countSearchProfiles(db, 1), MAX_SEARCH_PROFILES_PER_CHAT);
});

test('updateSearchProfile overwrites prefs without changing name/active/id', () => {
  const db = openDb(':memory:');
  const p = createSearchProfile(db, 1, 'Studio Center', prefs({ priceTo: 700 }));
  updateSearchProfile(db, p.id, prefs({ priceTo: 900 }));
  const updated = getSearchProfiles(db, 1)[0];
  assert.equal(updated.prefs.priceTo, 900);
  assert.equal(updated.name, 'Studio Center');
});

test('deleteSearchProfile removes it; if it was active, no profile is active afterward', () => {
  const db = openDb(':memory:');
  const p = createSearchProfile(db, 1, 'Studio Center', prefs());
  deleteSearchProfile(db, p.id);
  assert.equal(getSearchProfiles(db, 1).length, 0);
  assert.equal(getActiveSearchProfile(db, 1), null);
});

test('getAllSearchProfiles returns profiles across every chat', () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'A', prefs());
  createSearchProfile(db, 2, 'B', prefs());
  assert.equal(getAllSearchProfiles(db).length, 2);
});

test('upsertActiveProfilePrefs creates a profile on first call, updates the same one on the next', () => {
  const db = openDb(':memory:');
  const created = upsertActiveProfilePrefs(db, 0, prefs({ priceTo: 500 }));
  assert.equal(created.name, 'My Search');
  const updated = upsertActiveProfilePrefs(db, 0, prefs({ priceTo: 600 }));
  assert.equal(updated.id, created.id);
  assert.equal(getSearchProfiles(db, 0).length, 1);
  assert.equal(getSearchProfiles(db, 0)[0].prefs.priceTo, 600);
});

test('getChatLanguage defaults to "en", setChatLanguage persists a change', () => {
  const db = openDb(':memory:');
  assert.equal(getChatLanguage(db, 1), 'en');
  setChatLanguage(db, 1, 'ru');
  assert.equal(getChatLanguage(db, 1), 'ru');
});

test('upsertListing stores lift/parkingSpaces/floor/energyClass/availableFrom/mentionsPets from a NormalizedListing', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({
    id: 'a', lift: true, parkingSpaces: 1, floor: '2. Stock', energyClass: 'A', availableFrom: '2026-10-01', mentionsPets: true,
  }));
  const row = getListingsByIds(db, ['willhaben:a'])[0];
  assert.equal(row.lift, true);
  assert.equal(row.parkingSpaces, 1);
  assert.equal(row.floor, '2. Stock');
  assert.equal(row.energyClass, 'A');
  assert.equal(row.availableFrom, '2026-10-01');
  assert.equal(row.mentionsPets, true);
});

test('a pre-existing user_prefs row is migrated into one active "My Search" search_profiles row on openDb', () => {
  const path = ':memory:'; // exercised via a temp-file DB instead — see note below
});
```

The last test needs a real file-backed DB (`:memory:` starts empty every time, so there's nothing to migrate). Replace it with:

```typescript
test('a pre-existing user_prefs row is migrated into one active "My Search" search_profiles row on openDb', () => {
  const tmp = `/tmp/swipe-bot-migration-test-${Date.now()}.sqlite`;
  try {
    // Build a DB on the OLD schema by hand (openDb() now creates the new schema, so we can't use it to seed the old one).
    const seed = new (require('better-sqlite3'))(tmp);
    seed.exec(`
      CREATE TABLE user_prefs (
        chat_id INTEGER PRIMARY KEY, price_from REAL, price_to REAL, districts TEXT,
        rooms_from REAL, rooms_to REAL, area_from REAL, area_to REAL,
        include_waitlist_housing INTEGER NOT NULL DEFAULT 1, include_wg INTEGER NOT NULL DEFAULT 0,
        commute_destination TEXT, commute_lat REAL, commute_lon REAL, updated_at TEXT NOT NULL
      );
    `);
    seed.prepare(`INSERT INTO user_prefs (chat_id, price_to, include_waitlist_housing, include_wg, updated_at) VALUES (5, 700, 1, 0, ?)`)
      .run(new Date().toISOString());
    seed.close();

    const db = openDb(tmp); // triggers migrate()
    const profiles = getSearchProfiles(db, 5);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, 'My Search');
    assert.equal(profiles[0].active, true);
    assert.equal(profiles[0].prefs.priceTo, 700);

    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_prefs'`).get();
    assert.equal(tableExists, undefined); // dropped after migration
  } finally {
    require('node:fs').rmSync(tmp, { force: true });
    require('node:fs').rmSync(`${tmp}-wal`, { force: true });
    require('node:fs').rmSync(`${tmp}-shm`, { force: true });
  }
});
```

Use `import` equivalents (`import Database from 'better-sqlite3'`, `import { rmSync } from 'node:fs'`) at the top of the test file instead of inline `require` — this test file is ESM (`"type": "module"` in `package.json`), so `require` isn't available; the snippets above show intent, adjust to real imports when writing the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — none of the new exports exist yet, and `listing()`'s test helper (in `bot.test.ts`, reused conceptually here) doesn't yet carry the new `NormalizedListing` fields either. This task only needs `db.test.ts` to compile/run; if `bot.test.ts` fails to compile because its own `listing()` helper is missing the new fields, add them there too as part of this task (see Step 3) so the whole suite compiles.

- [ ] **Step 3: Implement**

Add to the `SCHEMA` constant in `db.ts`:

```sql
CREATE TABLE IF NOT EXISTS search_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  prefs_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_profiles_chat_id ON search_profiles(chat_id);

CREATE TABLE IF NOT EXISTS chats (
  chat_id INTEGER PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'en'
);
```

Add to `listings` in `SCHEMA` (new installs get these columns from the start; existing DBs get them via `migrate()`):

```sql
  lift INTEGER, parking_spaces INTEGER, floor TEXT, energy_class TEXT, available_from TEXT,
  mentions_pets INTEGER NOT NULL DEFAULT 0,
```

Add to `migrate(db)`, following the existing `ALTER TABLE ... ADD COLUMN` pattern:

```typescript
  if (!listingColumns.includes('lift')) {
    db.exec('ALTER TABLE listings ADD COLUMN lift INTEGER');
    db.exec('ALTER TABLE listings ADD COLUMN parking_spaces INTEGER');
    db.exec('ALTER TABLE listings ADD COLUMN floor TEXT');
    db.exec('ALTER TABLE listings ADD COLUMN energy_class TEXT');
    db.exec('ALTER TABLE listings ADD COLUMN available_from TEXT');
    db.exec('ALTER TABLE listings ADD COLUMN mentions_pets INTEGER NOT NULL DEFAULT 0');
  }

  const shortlistColumns = (db.prepare('PRAGMA table_info(shortlist)').all() as { name: string }[]).map((c) => c.name);
  if (!shortlistColumns.includes('profile_id')) {
    db.exec('ALTER TABLE shortlist ADD COLUMN profile_id INTEGER');
  }

  migrateUserPrefsToSearchProfiles(db);
```

```typescript
/**
 * One-time migration: every pre-upgrade user_prefs row becomes one active search_profiles row
 * named "My Search", carrying its exact prior filter values (new requireElevator/requireParking
 * fields default to false, since no prior data existed for them). user_prefs is dropped once every
 * row has been migrated so this function is a no-op (and the table absent) on every later startup.
 */
function migrateUserPrefsToSearchProfiles(db: DB): void {
  const hasUserPrefs = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_prefs'`).get();
  if (!hasUserPrefs) return;

  const rows = db.prepare('SELECT * FROM user_prefs').all() as Record<string, unknown>[];
  const migrate = db.transaction((rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const chatId = row.chat_id as number;
      if (getActiveSearchProfile(db, chatId)) continue; // already migrated in a prior partial run
      const prefsForChat = rowToPrefs(row);
      createSearchProfile(db, chatId, 'My Search', {
        priceFrom: prefsForChat.priceFrom, priceTo: prefsForChat.priceTo, districts: prefsForChat.districts,
        roomsFrom: prefsForChat.roomsFrom, roomsTo: prefsForChat.roomsTo, areaFrom: prefsForChat.areaFrom, areaTo: prefsForChat.areaTo,
        includeWaitlistHousing: prefsForChat.includeWaitlistHousing, includeWg: prefsForChat.includeWg,
        requireElevator: false, requireParking: false,
        commuteDestination: prefsForChat.commuteDestination, commuteLat: prefsForChat.commuteLat, commuteLon: prefsForChat.commuteLon,
      });
      db.prepare('INSERT OR IGNORE INTO chats (chat_id, language) VALUES (?, ?)').run(chatId, 'en');
    }
    db.exec('DROP TABLE user_prefs');
  });
  migrate(rows);
}
```

`rowToPrefs` (the existing `UserPrefs`-shaped row mapper) is reused as-is inside the migration for convenience — keep it in the file (it's only referenced from this one migration function now) but stop exporting it if it was exported before (it wasn't).

Add the new types and CRUD functions:

```typescript
export interface SearchProfilePrefs {
  priceFrom: number | null;
  priceTo: number | null;
  districts: number[] | null;
  roomsFrom: number | null;
  roomsTo: number | null;
  areaFrom: number | null;
  areaTo: number | null;
  includeWaitlistHousing: boolean;
  includeWg: boolean;
  requireElevator: boolean;
  requireParking: boolean;
  commuteDestination: string | null;
  commuteLat: number | null;
  commuteLon: number | null;
}

export interface SearchProfile {
  id: number;
  chatId: number;
  name: string;
  active: boolean;
  createdAt: string;
  prefs: SearchProfilePrefs;
}

export const MAX_SEARCH_PROFILES_PER_CHAT = 5;

function rowToSearchProfile(row: Record<string, unknown>): SearchProfile {
  return {
    id: row.id as number,
    chatId: row.chat_id as number,
    name: row.name as string,
    active: Boolean(row.active),
    createdAt: row.created_at as string,
    prefs: JSON.parse(row.prefs_json as string) as SearchProfilePrefs,
  };
}

export function createSearchProfile(db: DB, chatId: number, name: string, prefs: SearchProfilePrefs, makeActive = true): SearchProfile {
  if (makeActive) db.prepare('UPDATE search_profiles SET active = 0 WHERE chat_id = ?').run(chatId);
  const now = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO search_profiles (chat_id, name, prefs_json, active, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, name, JSON.stringify(prefs), makeActive ? 1 : 0, now);
  return { id: result.lastInsertRowid as number, chatId, name, active: makeActive, createdAt: now, prefs };
}

export function getSearchProfiles(db: DB, chatId: number): SearchProfile[] {
  const rows = db.prepare('SELECT * FROM search_profiles WHERE chat_id = ? ORDER BY created_at ASC').all(chatId) as Record<string, unknown>[];
  return rows.map(rowToSearchProfile);
}

export function getSearchProfile(db: DB, profileId: number): SearchProfile | null {
  const row = db.prepare('SELECT * FROM search_profiles WHERE id = ?').get(profileId) as Record<string, unknown> | undefined;
  return row ? rowToSearchProfile(row) : null;
}

export function getActiveSearchProfile(db: DB, chatId: number): SearchProfile | null {
  const row = db.prepare('SELECT * FROM search_profiles WHERE chat_id = ? AND active = 1').get(chatId) as Record<string, unknown> | undefined;
  return row ? rowToSearchProfile(row) : null;
}

export function setActiveSearchProfile(db: DB, chatId: number, profileId: number): void {
  const setActive = db.transaction(() => {
    db.prepare('UPDATE search_profiles SET active = 0 WHERE chat_id = ?').run(chatId);
    db.prepare('UPDATE search_profiles SET active = 1 WHERE id = ? AND chat_id = ?').run(profileId, chatId);
  });
  setActive();
}

export function updateSearchProfile(db: DB, profileId: number, prefs: SearchProfilePrefs): void {
  db.prepare('UPDATE search_profiles SET prefs_json = ? WHERE id = ?').run(JSON.stringify(prefs), profileId);
}

export function renameSearchProfile(db: DB, profileId: number, name: string): void {
  db.prepare('UPDATE search_profiles SET name = ? WHERE id = ?').run(name, profileId);
}

/** If the deleted profile was active, no profile is active afterward — the caller (bot.ts) prompts the user to pick a new one if any remain. */
export function deleteSearchProfile(db: DB, profileId: number): void {
  db.prepare('DELETE FROM search_profiles WHERE id = ?').run(profileId);
}

export function countSearchProfiles(db: DB, chatId: number): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM search_profiles WHERE chat_id = ?').get(chatId) as { n: number };
  return row.n;
}

export function getAllSearchProfiles(db: DB): SearchProfile[] {
  const rows = db.prepare('SELECT * FROM search_profiles').all() as Record<string, unknown>[];
  return rows.map(rowToSearchProfile);
}

/** Used only by the MCP server, which has no wizard/multi-profile UI: creates the chat's one profile on first call, updates it on every later call. */
export function upsertActiveProfilePrefs(db: DB, chatId: number, prefs: SearchProfilePrefs, defaultName = 'My Search'): SearchProfile {
  const active = getActiveSearchProfile(db, chatId);
  if (active) {
    updateSearchProfile(db, active.id, prefs);
    return { ...active, prefs };
  }
  return createSearchProfile(db, chatId, defaultName, prefs);
}

export type ChatLanguage = 'en' | 'ru' | 'de';

export function getChatLanguage(db: DB, chatId: number): ChatLanguage {
  const row = db.prepare('SELECT language FROM chats WHERE chat_id = ?').get(chatId) as { language: ChatLanguage } | undefined;
  return row?.language ?? 'en';
}

export function setChatLanguage(db: DB, chatId: number, language: ChatLanguage): void {
  db.prepare(`
    INSERT INTO chats (chat_id, language) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET language = excluded.language
  `).run(chatId, language);
}
```

Remove `UserPrefs`, `getUserPrefs`, `setUserPrefs`, `getAllUserPrefs` and the `user_prefs` block from `SCHEMA` (new installs never create it; `migrateUserPrefsToSearchProfiles` only matters for upgrades, guarded by the `sqlite_master` check).

Extend `ListingRow`, `rowToListing`, and `upsertListing`'s SQL/params with the six new columns (`lift`, `parkingSpaces`/`parking_spaces`, `floor`, `energyClass`/`energy_class`, `availableFrom`/`available_from`, `mentionsPets`/`mentions_pets`), following the exact pattern already used for `isWg`/`is_wg`. In `test/bot.test.ts`, add the same six fields (with neutral defaults: `lift: null, parkingSpaces: null, floor: null, energyClass: null, availableFrom: null, mentionsPets: false`) to its local `listing()` and `row()` helpers so the suite still compiles — this is required for Step 2/4 of *this* task, not deferred to a later task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS for every test in `db.test.ts`. `bot.test.ts`/`notify.test.ts`/`poller.test.ts`/`mcp-server.test.ts` will still fail to compile at this point (they reference `UserPrefs`/`getUserPrefs`/`setUserPrefs` which no longer exist) — that's expected and fixed in Task 3. Run `node --import tsx --test test/db.test.ts` specifically to confirm this task's own scope is green before moving on.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/db.ts swipe-bot/test/db.test.ts swipe-bot/test/bot.test.ts
git commit -m "db: add search_profiles/chats tables, profile CRUD, and listing amenity columns"
```

---

## Task 3: Wire matching/filtering to SearchProfilePrefs across poller/notify/mcp-server

**Files:**
- Modify: `swipe-bot/src/db.ts` (`matchesPrefs`, `getCandidateListings`)
- Modify: `swipe-bot/src/poller.ts`, `swipe-bot/src/notify.ts`, `swipe-bot/src/mcp-server.ts`
- Test: `swipe-bot/test/db.test.ts`, `swipe-bot/test/poller.test.ts`, `swipe-bot/test/notify.test.ts`, `swipe-bot/test/mcp-server.test.ts`

**Interfaces:**
- Consumes: `SearchProfile`, `SearchProfilePrefs`, `getAllSearchProfiles`, `upsertActiveProfilePrefs` from Task 2.
- Produces: `matchesPrefs(l: ListingRow, prefs: SearchProfilePrefs): boolean` and `getCandidateListings(db, chatId, prefs: SearchProfilePrefs): ListingRow[]` (same names, new param type — every caller updated in this task). `poller.widestFilter(allProfiles: SearchProfile[]): HuntOptions | null`. `notify.notifyNewMatches` iterates `getAllSearchProfiles(db)` instead of `getAllUserPrefs(db)`.

- [ ] **Step 1: Write the failing tests**

```typescript
// swipe-bot/test/db.test.ts (add)
test('matchesPrefs requires lift=true when requireElevator is set, excluding null/false', () => {
  const wantsElevator = prefs({ requireElevator: true });
  assert.equal(matchesPrefs(row({ lift: true }), wantsElevator), true);
  assert.equal(matchesPrefs(row({ lift: false }), wantsElevator), false);
  assert.equal(matchesPrefs(row({ lift: null }), wantsElevator), false);
});

test('matchesPrefs requires parkingSpaces > 0 when requireParking is set', () => {
  const wantsParking = prefs({ requireParking: true });
  assert.equal(matchesPrefs(row({ parkingSpaces: 1 }), wantsParking), true);
  assert.equal(matchesPrefs(row({ parkingSpaces: 0 }), wantsParking), false);
  assert.equal(matchesPrefs(row({ parkingSpaces: null }), wantsParking), false);
});

test('getCandidateListings applies the same elevator/parking filters via SQL', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'has-lift', lift: true }));
  upsertListing(db, listing({ id: 'no-lift', lift: false }));
  const results = getCandidateListings(db, 1, prefs({ requireElevator: true }));
  assert.deepEqual(results.map((r) => r.id), ['willhaben:has-lift']);
});
```

Add local `prefs()`/`row()`/`listing()` helpers to `db.test.ts` if it doesn't already have them (mirroring `bot.test.ts`'s), including the six new `ListingRow`/`NormalizedListing` amenity fields from Task 2.

```typescript
// swipe-bot/test/poller.test.ts — update existing widestFilter tests to build SearchProfile[]
// instead of UserPrefs[], e.g. wrap each prefs object as { id: 1, chatId: 1, name: 'x', active: true, createdAt: '', prefs }
```

```typescript
// swipe-bot/test/notify.test.ts — update to createSearchProfile(db, chatId, 'Test', prefs) instead of setUserPrefs
```

```typescript
// swipe-bot/test/mcp-server.test.ts — update swipe_set_prefs round-trip assertions to read back
// via getActiveSearchProfile(db, MCP_CHAT_ID) instead of getUserPrefs(db, MCP_CHAT_ID)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — compile errors in `poller.ts`/`notify.ts`/`mcp-server.ts` (missing `UserPrefs`/`getUserPrefs`/`setUserPrefs`/`getAllUserPrefs`) plus the new elevator/parking assertions failing.

- [ ] **Step 3: Implement**

In `db.ts`, change `matchesPrefs`'s and `getCandidateListings`'s parameter type from `UserPrefs` to `SearchProfilePrefs`, and add:

```typescript
// inside getCandidateListings, alongside the existing clauses.push(...) calls:
  if (prefs.requireElevator) { clauses.push('l.lift = 1'); }
  if (prefs.requireParking) { clauses.push('l.parking_spaces > 0'); }
```

```typescript
// inside matchesPrefs, alongside the existing checks:
  if (prefs.requireElevator && l.lift !== true) return false;
  if (prefs.requireParking && !(l.parkingSpaces != null && l.parkingSpaces > 0)) return false;
```

In `poller.ts`, change `widestFilter(allPrefs: UserPrefs[])` to `widestFilter(allProfiles: SearchProfile[])`, reading `p.prefs.priceFrom` etc. instead of `p.priceFrom`, and update `runPoll`'s `getAllUserPrefs(db)` call to `getAllSearchProfiles(db)`.

In `notify.ts`, change the loop:

```typescript
  for (const profile of getAllSearchProfiles(db)) {
    if (profile.chatId === MCP_CHAT_ID) continue;
    const matches = newListings.filter((l) => matchesPrefs(l, profile.prefs));
    // ...rest unchanged, using profile.chatId and profile.prefs in place of prefs.chatId/prefs
  }
```

(Full pacing/grouping rewrite of this loop happens in Task 10 — this task only needs it to compile against the new types and keep passing its existing assertions.)

In `mcp-server.ts`:
- Replace `getUserPrefs(db, MCP_CHAT_ID)` reads with `getActiveSearchProfile(db, MCP_CHAT_ID)`, using `.prefs` where the old code used the `UserPrefs` object directly.
- Replace the `setUserPrefs(db, { chatId: MCP_CHAT_ID, ...mapPrefsArgs(args), ...commute })` call in `swipe_set_prefs`'s handler with `upsertActiveProfilePrefs(db, MCP_CHAT_ID, { ...mapPrefsArgs(args), ...commute, requireElevator: args.require_elevator ?? false, requireParking: args.require_parking ?? false })`.
- Extend `PrefsArgs` and `mapPrefsArgs` with optional `require_elevator?: boolean` / `require_parking?: boolean` mapped the same way as `include_waitlist_housing`/`include_wg`, and add matching `z.boolean().optional()` entries with descriptions to the `swipe_set_prefs` tool's `inputSchema` (mirroring the existing `include_wg` entry's style).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS across the whole suite.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/db.ts swipe-bot/src/poller.ts swipe-bot/src/notify.ts swipe-bot/src/mcp-server.ts swipe-bot/test/db.test.ts swipe-bot/test/poller.test.ts swipe-bot/test/notify.test.ts swipe-bot/test/mcp-server.test.ts
git commit -m "wire elevator/parking filters and SearchProfile-based matching through poller/notify/mcp-server"
```

---

## Task 4: i18n string catalog + t() helper + /language

**Files:**
- Create: `swipe-bot/src/locales/en.ts`, `swipe-bot/src/locales/ru.ts`, `swipe-bot/src/locales/de.ts`
- Create: `swipe-bot/src/locales.ts`
- Create: `swipe-bot/test/locales.test.ts`
- Modify: `swipe-bot/src/bot.ts` (`/language` command only, in this task — the rest of `bot.ts`'s strings get converted to `t()` calls incrementally in Tasks 5-9 as those sections are rewritten anyway, rather than a single disruptive find-and-replace pass over code this task doesn't otherwise touch)

**Interfaces:**
- Produces: `type LocaleKey = keyof typeof en` (the `en` catalog is the source of truth for which keys exist). `t(db: DB, chatId: number, key: LocaleKey, params?: Record<string, string | number>): string`. `LOCALE_NAMES: Record<ChatLanguage, string>` (native-language labels for the `/language` picker: `{ en: 'English', ru: 'Русский', de: 'Deutsch' }`).
- Consumes: `getChatLanguage`, `setChatLanguage`, `ChatLanguage` from Task 2.

- [ ] **Step 1: Write the failing tests**

```typescript
// swipe-bot/test/locales.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, LOCALE_NAMES } from '../src/locales.js';
import { openDb, setChatLanguage } from '../src/db.js';

test('t() falls back to English for a chat with no language set', () => {
  const db = openDb(':memory:');
  assert.equal(t(db, 1, 'help_intro'), 'I find Vienna rental apartments matching your preferences and let you swipe through them, like a dating app.');
});

test('t() returns the Russian string once the chat language is set to ru', () => {
  const db = openDb(':memory:');
  setChatLanguage(db, 1, 'ru');
  assert.notEqual(t(db, 1, 'help_intro'), t(db, 1, 'help_intro') === undefined);
  assert.match(t(db, 1, 'help_intro'), /[а-яА-Я]/); // contains Cyrillic
});

test('t() substitutes named params into the template', () => {
  const db = openDb(':memory:');
  const s = t(db, 1, 'wizard_progress', { step: 2, total: 6 });
  assert.match(s, /2\/6|2 из 6|2 von 6/); // exact wording is locale-specific; the numbers must appear
});

test('every locale file has exactly the same key set as en.ts (no missing/extra translations)', () => {
  const en = require('../src/locales/en.js'); // adjust to real import if better as a static import at top
  const ru = require('../src/locales/ru.js');
  const de = require('../src/locales/de.js');
  assert.deepEqual(Object.keys(ru.default).sort(), Object.keys(en.default).sort());
  assert.deepEqual(Object.keys(de.default).sort(), Object.keys(en.default).sort());
});
```

Rewrite the last test's `require(...)` calls as top-of-file static `import en from '../src/locales/en.js'` etc. (this is an ESM project) when authoring the real file — the snippet above is illustrative of the assertion, not the import mechanics.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — `../src/locales.js` doesn't exist yet.

- [ ] **Step 3: Implement**

```typescript
// swipe-bot/src/locales/en.ts
export default {
  help_intro: 'I find Vienna rental apartments matching your preferences and let you swipe through them, like a dating app.',
  wizard_progress: 'Step {step}/{total}',
  wizard_name_prompt: 'Name this search (e.g. "Studio Center") — or tap Skip to call it "Search {n}".',
  wizard_budget_prompt: 'What\'s your budget?',
  wizard_districts_prompt: 'Which districts?',
  wizard_rooms_prompt: 'Rooms & size?',
  wizard_amenities_prompt: 'Any must-haves?',
  wizard_commute_prompt: 'Daily commute destination? Type an address, or tap Skip.',
  btn_skip: 'Skip',
  btn_back: '‹ Back',
  btn_continue: 'Continue',
  btn_custom_range: 'Custom range ▸',
  btn_start_searching: '✅ Start searching',
  btn_edit: '✏️ Edit',
  btn_add_another_search: '+ Add another search',
  amenity_elevator: 'Elevator',
  amenity_parking: 'Parking',
  amenity_include_waitlist: 'Include waitlist/municipal housing',
  amenity_include_wg: 'Include WG rooms',
  pet_badge: '🐾 mentions pets — check listing',
  language_prompt: 'Choose your language:',
  language_saved: 'Language set to {language}.',
  // Task 5-9 add further keys here as each screen is built; keep this file the single source of truth for the key set.
} as const;
```

```typescript
// swipe-bot/src/locales/ru.ts
export default {
  help_intro: 'Я ищу арендные квартиры в Вене под ваши критерии и показываю их как карточки — свайпайте, как в приложении знакомств.',
  wizard_progress: 'Шаг {step}/{total}',
  wizard_name_prompt: 'Название поиска (например, "Студия в центре") — или нажмите «Пропустить», и я назову его "Поиск {n}".',
  wizard_budget_prompt: 'Какой у вас бюджет?',
  wizard_districts_prompt: 'Какие районы?',
  wizard_rooms_prompt: 'Комнаты и площадь?',
  wizard_amenities_prompt: 'Что-то обязательное?',
  wizard_commute_prompt: 'Куда вы обычно добираетесь? Введите адрес или нажмите «Пропустить».',
  btn_skip: 'Пропустить',
  btn_back: '‹ Назад',
  btn_continue: 'Продолжить',
  btn_custom_range: 'Свой диапазон ▸',
  btn_start_searching: '✅ Начать поиск',
  btn_edit: '✏️ Изменить',
  btn_add_another_search: '+ Добавить ещё поиск',
  amenity_elevator: 'Лифт',
  amenity_parking: 'Парковка',
  amenity_include_waitlist: 'Показывать очередное/муниципальное жильё',
  amenity_include_wg: 'Показывать комнаты в WG',
  pet_badge: '🐾 упоминаются животные — уточните у объявления',
  language_prompt: 'Выберите язык:',
  language_saved: 'Язык установлен: {language}.',
} as const;
```

```typescript
// swipe-bot/src/locales/de.ts
export default {
  help_intro: 'Ich finde Mietwohnungen in Wien nach deinen Kriterien und zeige sie als Karten zum Durchwischen, wie bei einer Dating-App.',
  wizard_progress: 'Schritt {step}/{total}',
  wizard_name_prompt: 'Name für diese Suche (z. B. "Studio Zentrum") — oder tippe Überspringen für "Suche {n}".',
  wizard_budget_prompt: 'Wie hoch ist dein Budget?',
  wizard_districts_prompt: 'Welche Bezirke?',
  wizard_rooms_prompt: 'Zimmer & Größe?',
  wizard_amenities_prompt: 'Etwas Unverzichtbares?',
  wizard_commute_prompt: 'Tägliches Pendelziel? Adresse eingeben oder Überspringen tippen.',
  btn_skip: 'Überspringen',
  btn_back: '‹ Zurück',
  btn_continue: 'Weiter',
  btn_custom_range: 'Eigener Bereich ▸',
  btn_start_searching: '✅ Suche starten',
  btn_edit: '✏️ Bearbeiten',
  btn_add_another_search: '+ Weitere Suche hinzufügen',
  amenity_elevator: 'Lift',
  amenity_parking: 'Parkplatz',
  amenity_include_waitlist: 'Vormerk-/Gemeindewohnungen anzeigen',
  amenity_include_wg: 'WG-Zimmer anzeigen',
  pet_badge: '🐾 erwähnt Haustiere — bitte im Inserat prüfen',
  language_prompt: 'Sprache wählen:',
  language_saved: 'Sprache auf {language} gesetzt.',
} as const;
```

```typescript
// swipe-bot/src/locales.ts
import { type DB, type ChatLanguage, getChatLanguage } from './db.js';
import en from './locales/en.js';
import ru from './locales/ru.js';
import de from './locales/de.js';

const CATALOGS: Record<ChatLanguage, typeof en> = { en, ru, de: de as typeof en };

export type LocaleKey = keyof typeof en;

export const LOCALE_NAMES: Record<ChatLanguage, string> = { en: 'English', ru: 'Русский', de: 'Deutsch' };

/** Resolves the chat's language and formats the given key's template, substituting {param} placeholders. Falls back to English text if a key is ever missing from a non-English catalog (shouldn't happen — enforced by the key-parity test — but keeps a bot reply from throwing). */
export function t(db: DB, chatId: number, key: LocaleKey, params: Record<string, string | number> = {}): string {
  const language = getChatLanguage(db, chatId);
  const template = CATALOGS[language][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}
```

Wire `/language` in `bot.ts` (added now so the command exists even before later tasks convert more strings — later tasks only need to call the already-working `t()`):

```typescript
  bot.command('language', async (ctx) => {
    const buttons = Markup.inlineKeyboard(
      (Object.keys(LOCALE_NAMES) as ChatLanguage[]).map((lang) => Markup.button.callback(LOCALE_NAMES[lang], `setlang:${lang}`))
    );
    await ctx.reply(t(db, ctx.chat.id, 'language_prompt'), buttons);
  });

  bot.action(/^setlang:(en|ru|de)$/, async (ctx) => {
    const [, lang] = ctx.match as unknown as [string, ChatLanguage];
    setChatLanguage(db, ctx.chat!.id, lang);
    await ctx.answerCbQuery();
    await ctx.reply(t(db, ctx.chat!.id, 'language_saved', { language: LOCALE_NAMES[lang] }));
  });
```

Add `'language'` to `BOT_COMMANDS` (`{ command: 'language', description: 'Change the bot\'s language' }`) and update the `BOT_COMMANDS lists...` test in `bot.test.ts` to expect the new command in the list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/locales.ts swipe-bot/src/locales/ swipe-bot/src/bot.ts swipe-bot/test/locales.test.ts swipe-bot/test/bot.test.ts
git commit -m "add en/ru/de string catalog, t() helper, and /language command"
```

---

## Task 5: Wizard state machine (pure logic)

**Files:**
- Create: `swipe-bot/src/wizard.ts`
- Create: `swipe-bot/test/wizard.test.ts`

**Interfaces:**
- Consumes: `SearchProfilePrefs` from Task 2, `LocaleKey`/`t`-style param shape from Task 4 (this module returns locale *keys*, not rendered strings — `bot.ts` renders them via `t()` in Task 6, keeping `wizard.ts` free of any Telegraf/DB dependency so it's trivially unit-testable).
- Produces:
  - `type WizardStepId = 'name' | 'budget' | 'districts' | 'rooms_size' | 'amenities' | 'commute'`
  - `const WIZARD_STEPS: WizardStepId[]` (the fixed order)
  - `interface WizardState { stepIndex: number; profileName: string | null; partial: Partial<SearchProfilePrefs>; editingProfileId: number | null }` (`editingProfileId` non-null means `/settings` jumped straight to one step — see Task 6)
  - `initialWizardState(): WizardState`
  - `type WizardChoice = { kind: 'budget'; priceFrom: number | null; priceTo: number } | { kind: 'districts_toggle'; district: number } | { kind: 'districts_continue' } | { kind: 'rooms_size'; roomsFrom: number | null; roomsTo: number | null; areaFrom: number | null; areaTo: number | null } | { kind: 'amenity_toggle'; field: 'requireElevator' | 'requireParking' | 'includeWaitlistHousing' | 'includeWg' } | { kind: 'amenities_continue' } | { kind: 'commute_skip' } | { kind: 'commute_set'; destination: string; lat: number; lon: number } | { kind: 'name'; name: string } | { kind: 'back' }`
  - `applyWizardChoice(state: WizardState, choice: WizardChoice): WizardState` (pure — advances `stepIndex` on a forward choice, decrements on `back`, merges into `partial`; throws on a choice that doesn't belong to the current step)
  - `isWizardComplete(state: WizardState): boolean`
  - `finalizePrefs(state: WizardState): SearchProfilePrefs` (throws if incomplete; fills any never-visited optional step with its neutral default — e.g. `requireElevator: false` if the amenities step was somehow skipped)
  - `BUDGET_BANDS: { label: string; priceFrom: number | null; priceTo: number }[]` (the four chip options from the spec: `€500-700`, `€700-900`, `€900-1100`, `€1100+`)
  - `DISTRICT_GROUPS: { label: string; districts: number[] }[]` (the 1-9 / 10-23 grouping)

- [ ] **Step 1: Write the failing tests**

```typescript
// swipe-bot/test/wizard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialWizardState, applyWizardChoice, isWizardComplete, finalizePrefs, WIZARD_STEPS, BUDGET_BANDS, DISTRICT_GROUPS,
} from '../src/wizard.js';

test('a fresh wizard starts at step 0 (name) and is not complete', () => {
  const s = initialWizardState();
  assert.equal(s.stepIndex, 0);
  assert.equal(WIZARD_STEPS[s.stepIndex], 'name');
  assert.equal(isWizardComplete(s), false);
});

test('applying a full sequence of choices completes the wizard and produces valid prefs', () => {
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'Studio Center' });
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: 700, priceTo: 900 });
  s = applyWizardChoice(s, { kind: 'districts_toggle', district: 6 });
  s = applyWizardChoice(s, { kind: 'districts_toggle', district: 7 });
  s = applyWizardChoice(s, { kind: 'districts_continue' });
  s = applyWizardChoice(s, { kind: 'rooms_size', roomsFrom: 1, roomsTo: 2, areaFrom: null, areaTo: null });
  s = applyWizardChoice(s, { kind: 'amenity_toggle', field: 'requireElevator' });
  s = applyWizardChoice(s, { kind: 'amenities_continue' });
  s = applyWizardChoice(s, { kind: 'commute_skip' });
  assert.equal(isWizardComplete(s), true);
  const prefs = finalizePrefs(s);
  assert.deepEqual(prefs, {
    priceFrom: 700, priceTo: 900, districts: [6, 7], roomsFrom: 1, roomsTo: 2, areaFrom: null, areaTo: null,
    includeWaitlistHousing: false, includeWg: false, requireElevator: true, requireParking: false,
    commuteDestination: null, commuteLat: null, commuteLon: null,
  });
});

test('districts_toggle on an already-selected district removes it (tap to deselect)', () => {
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'X' });
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: null, priceTo: 700 });
  s = applyWizardChoice(s, { kind: 'districts_toggle', district: 6 });
  s = applyWizardChoide ? s : s; // no-op line removed below — see note
  s = applyWizardChoice(s, { kind: 'districts_toggle', district: 6 });
  assert.deepEqual(s.partial.districts, []);
});

test('back pops the previous step and its answer, without losing earlier answers', () => {
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'X' });
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: null, priceTo: 700 });
  s = applyWizardChoice(s, { kind: 'back' });
  assert.equal(WIZARD_STEPS[s.stepIndex], 'budget');
  assert.equal(s.partial.priceTo, undefined); // budget answer cleared by going back
  assert.equal(s.profileName, 'X'); // name answer preserved
});

test('back on the very first step is a no-op (nothing to go back to)', () => {
  let s = initialWizardState();
  const before = s;
  s = applyWizardChoice(s, { kind: 'back' });
  assert.deepEqual(s, before);
});

test('a choice that does not belong to the current step throws', () => {
  const s = initialWizardState(); // step 0 is 'name'
  assert.throws(() => applyWizardChoice(s, { kind: 'commute_skip' }));
});

test('BUDGET_BANDS has the four bands from the spec, in order', () => {
  assert.deepEqual(BUDGET_BANDS.map((b) => b.label), ['€500-700', '€700-900', '€900-1100', '€1100+']);
  assert.equal(BUDGET_BANDS[3].priceTo, Infinity); // "No limit" style top band
});

test('DISTRICT_GROUPS covers 1-23 with no gaps or overlaps', () => {
  const all = DISTRICT_GROUPS.flatMap((g) => g.districts);
  assert.deepEqual([...all].sort((a, b) => a - b), Array.from({ length: 23 }, (_, i) => i + 1));
});
```

Fix the stray `applyWizardChoide ? s : s;` typo line before running — it was left in accidentally while drafting; delete it, the two `districts_toggle` calls on district 6 are what the test exercises.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — `../src/wizard.js` doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// swipe-bot/src/wizard.ts
import type { SearchProfilePrefs } from './db.js';

export type WizardStepId = 'name' | 'budget' | 'districts' | 'rooms_size' | 'amenities' | 'commute';
export const WIZARD_STEPS: WizardStepId[] = ['name', 'budget', 'districts', 'rooms_size', 'amenities', 'commute'];

export interface WizardState {
  stepIndex: number;
  profileName: string | null;
  partial: Partial<SearchProfilePrefs>;
  editingProfileId: number | null;
}

export function initialWizardState(): WizardState {
  return { stepIndex: 0, profileName: null, partial: {}, editingProfileId: null };
}

export type WizardChoice =
  | { kind: 'name'; name: string }
  | { kind: 'budget'; priceFrom: number | null; priceTo: number }
  | { kind: 'districts_toggle'; district: number }
  | { kind: 'districts_continue' }
  | { kind: 'rooms_size'; roomsFrom: number | null; roomsTo: number | null; areaFrom: number | null; areaTo: number | null }
  | { kind: 'amenity_toggle'; field: 'requireElevator' | 'requireParking' | 'includeWaitlistHousing' | 'includeWg' }
  | { kind: 'amenities_continue' }
  | { kind: 'commute_skip' }
  | { kind: 'commute_set'; destination: string; lat: number; lon: number }
  | { kind: 'back' };

export const BUDGET_BANDS: { label: string; priceFrom: number | null; priceTo: number }[] = [
  { label: '€500-700', priceFrom: 500, priceTo: 700 },
  { label: '€700-900', priceFrom: 700, priceTo: 900 },
  { label: '€900-1100', priceFrom: 900, priceTo: 1100 },
  { label: '€1100+', priceFrom: 1100, priceTo: Infinity },
];

export const DISTRICT_GROUPS: { label: string; districts: number[] }[] = [
  { label: '1-9', districts: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  { label: '10-23', districts: Array.from({ length: 14 }, (_, i) => i + 10) },
];

function currentStep(state: WizardState): WizardStepId {
  return WIZARD_STEPS[state.stepIndex];
}

/** Pure state transition — throws if `choice` doesn't belong to the step the wizard is currently on (a stale/duplicate button tap after the message already advanced). */
export function applyWizardChoice(state: WizardState, choice: WizardChoice): WizardState {
  if (choice.kind === 'back') {
    if (state.stepIndex === 0) return state;
    const prevStep = WIZARD_STEPS[state.stepIndex - 1];
    const partial = { ...state.partial };
    const clearedByStep: Record<WizardStepId, (keyof SearchProfilePrefs)[]> = {
      name: [], budget: ['priceFrom', 'priceTo'], districts: ['districts'],
      rooms_size: ['roomsFrom', 'roomsTo', 'areaFrom', 'areaTo'],
      amenities: ['requireElevator', 'requireParking', 'includeWaitlistHousing', 'includeWg'],
      commute: ['commuteDestination', 'commuteLat', 'commuteLon'],
    };
    for (const field of clearedByStep[prevStep]) delete partial[field];
    return { ...state, stepIndex: state.stepIndex - 1, partial, profileName: prevStep === 'name' ? null : state.profileName };
  }

  const step = currentStep(state);
  switch (choice.kind) {
    case 'name':
      if (step !== 'name') throw new Error(`wizard is on step "${step}", not "name"`);
      return { ...state, stepIndex: state.stepIndex + 1, profileName: choice.name };
    case 'budget':
      if (step !== 'budget') throw new Error(`wizard is on step "${step}", not "budget"`);
      return { ...state, stepIndex: state.stepIndex + 1, partial: { ...state.partial, priceFrom: choice.priceFrom, priceTo: choice.priceTo } };
    case 'districts_toggle': {
      if (step !== 'districts') throw new Error(`wizard is on step "${step}", not "districts"`);
      const current = state.partial.districts ?? [];
      const districts = current.includes(choice.district) ? current.filter((d) => d !== choice.district) : [...current, choice.district].sort((a, b) => a - b);
      return { ...state, partial: { ...state.partial, districts } };
    }
    case 'districts_continue':
      if (step !== 'districts') throw new Error(`wizard is on step "${step}", not "districts"`);
      return { ...state, stepIndex: state.stepIndex + 1 };
    case 'rooms_size':
      if (step !== 'rooms_size') throw new Error(`wizard is on step "${step}", not "rooms_size"`);
      return { ...state, stepIndex: state.stepIndex + 1, partial: { ...state.partial, roomsFrom: choice.roomsFrom, roomsTo: choice.roomsTo, areaFrom: choice.areaFrom, areaTo: choice.areaTo } };
    case 'amenity_toggle': {
      if (step !== 'amenities') throw new Error(`wizard is on step "${step}", not "amenities"`);
      const currentValue = Boolean(state.partial[choice.field]);
      return { ...state, partial: { ...state.partial, [choice.field]: !currentValue } };
    }
    case 'amenities_continue':
      if (step !== 'amenities') throw new Error(`wizard is on step "${step}", not "amenities"`);
      return {
        ...state, stepIndex: state.stepIndex + 1,
        partial: {
          ...state.partial,
          requireElevator: state.partial.requireElevator ?? false,
          requireParking: state.partial.requireParking ?? false,
          includeWaitlistHousing: state.partial.includeWaitlistHousing ?? false,
          includeWg: state.partial.includeWg ?? false,
        },
      };
    case 'commute_skip':
      if (step !== 'commute') throw new Error(`wizard is on step "${step}", not "commute"`);
      return { ...state, stepIndex: state.stepIndex + 1, partial: { ...state.partial, commuteDestination: null, commuteLat: null, commuteLon: null } };
    case 'commute_set':
      if (step !== 'commute') throw new Error(`wizard is on step "${step}", not "commute"`);
      return { ...state, stepIndex: state.stepIndex + 1, partial: { ...state.partial, commuteDestination: choice.destination, commuteLat: choice.lat, commuteLon: choice.lon } };
  }
}

export function isWizardComplete(state: WizardState): boolean {
  return state.stepIndex >= WIZARD_STEPS.length;
}

/** Throws if the wizard hasn't reached the end — callers must check isWizardComplete first. */
export function finalizePrefs(state: WizardState): SearchProfilePrefs {
  if (!isWizardComplete(state)) throw new Error('wizard is not complete yet');
  const p = state.partial;
  return {
    priceFrom: p.priceFrom ?? null,
    priceTo: p.priceTo ?? Infinity,
    districts: p.districts && p.districts.length > 0 ? p.districts : null,
    roomsFrom: p.roomsFrom ?? null,
    roomsTo: p.roomsTo ?? null,
    areaFrom: p.areaFrom ?? null,
    areaTo: p.areaTo ?? null,
    includeWaitlistHousing: p.includeWaitlistHousing ?? false,
    includeWg: p.includeWg ?? false,
    requireElevator: p.requireElevator ?? false,
    requireParking: p.requireParking ?? false,
    commuteDestination: p.commuteDestination ?? null,
    commuteLat: p.commuteLat ?? null,
    commuteLon: p.commuteLon ?? null,
  };
}
```

`BUDGET_BANDS[3].priceTo` is `Infinity`, which doesn't survive `JSON.stringify`/`JSON.parse` as a finite number — `db.ts`'s `createSearchProfile`/`updateSearchProfile` `JSON.stringify` the whole `prefs` object into `prefs_json`. Handle this explicitly: in `db.ts`'s `rowToSearchProfile`, after `JSON.parse`, replace a `null` `priceTo` that resulted from a stored `null` (JSON has no `Infinity`, `JSON.stringify(Infinity)` produces `null`) — i.e. treat a parsed `prefs.priceTo === null` as "no upper bound" everywhere `priceTo` is consumed (`matchesPrefs`/`getCandidateListings` already treat `priceTo == null` as unbounded, so this is consistent, not a special case). Add a one-line comment in `wizard.ts` next to `Infinity` noting this, and add a `db.test.ts` case confirming a profile created with `priceTo: Infinity` round-trips through `createSearchProfile`/`getSearchProfiles` as `priceTo: null`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/wizard.ts swipe-bot/test/wizard.test.ts swipe-bot/src/db.ts swipe-bot/test/db.test.ts
git commit -m "add pure wizard state machine for the button-chip onboarding flow"
```

---

## Task 6: Wire the wizard into bot.ts (replace the linear text onboarding)

**Files:**
- Modify: `swipe-bot/src/bot.ts` (remove `QUESTIONS`/`STEP_PARSERS`/`parseOnboardingStep`/`parseOnboardingAnswers`/`parseRange`/`parseDistrictsAnswer`/`parseBudgetMax`/`parseBudgetMin`/`parseRoomsOrSize`/`parseYesNo`/`COMMUTE_STEP_INDEX`/`ONBOARDING_INTRO`/`finishOnboarding`'s old body; `bot.start`/`bot.command('settings')`/`bot.on('text')` handlers rewritten)
- Modify: `swipe-bot/src/db.ts` (`onboarding_state` gains a `WizardState`-shaped payload instead of `string[]`)
- Test: `swipe-bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `WizardState`, `WizardChoice`, `applyWizardChoice`, `isWizardComplete`, `finalizePrefs`, `WIZARD_STEPS`, `BUDGET_BANDS`, `DISTRICT_GROUPS` from Task 5. `t`, `LocaleKey` from Task 4. `createSearchProfile`, `countSearchProfiles`, `MAX_SEARCH_PROFILES_PER_CHAT`, `getActiveSearchProfile` from Task 2.
- Produces: `renderWizardStep(state: WizardState): { text: LocaleKey; keyboard: ReturnType<typeof Markup.inlineKeyboard> }` (pure-ish: takes params for `t()` substitution separately — see implementation) exported for direct testing. `getWizardState(db, chatId): WizardState | null`, `setWizardState(db, chatId, state): void` replace `getOnboardingState`/`setOnboardingState`'s old `string[]` contract (same function names, new payload shape, both still declared in `db.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// swipe-bot/test/bot.test.ts — replace every test that used QUESTIONS/parseOnboardingAnswers/parseOnboardingStep with these
test('/start with no existing profiles begins the wizard at the name step', async () => {
  // Using the existing FakeTelegram/context test harness already present in this file (see how
  // the current bot.start test drives ctx.reply assertions) — replace the assertion on
  // QUESTIONS[0] with an assertion that the sent message matches the "name" step's prompt text
  // and includes a Skip button, e.g.:
  // assert.match(sentMessages[0].text, /name this search/i);
  // assert.ok(sentMessages[0].extra.reply_markup.inline_keyboard.flat().some(b => b.text === 'Skip'));
});

test('/start when a profile already exists tells the user to use /searches or /settings instead of re-onboarding', async () => {
  // getActiveSearchProfile(db, chatId) truthy -> bot.start short-circuits, same shape as today's
  // "You're already set up..." branch but pointing at /searches now that multiple profiles exist.
});

test('completing the wizard end-to-end creates an active SearchProfile with the chosen answers', async () => {
  // Drive callback_query updates for name (as a text message, since name is free-text) -> budget
  // chip tap -> two district taps + continue -> rooms/size chip tap -> an amenity toggle + continue
  // -> commute skip, then assert getSearchProfiles(db, chatId) has one active profile whose prefs
  // match what was tapped, mirroring the wizard.test.ts "full sequence" test's expected shape.
});

test('a Back tap during the wizard re-renders the previous step without losing earlier answers', async () => {
  // budget chip tap, then a `back:` callback -> asserts the re-sent/edited message is the budget
  // step's prompt again.
});

test('/start refuses a 6th profile once MAX_SEARCH_PROFILES_PER_CHAT is reached, pointing at /searches to delete one first', async () => {
  // Seed 5 profiles via createSearchProfile, then invoke /start and assert the cap message.
});
```

Since this task modifies real Telegraf handler wiring, follow whatever test-harness pattern `bot.test.ts` already uses for driving `bot.start`/`bot.on('text')`/`bot.action(...)` in its existing tests (check the file for a fake `Telegraf`/context builder before writing these — it very likely already exists, given the file drives `createBot` end-to-end for the callback-based swipe/shortlist tests). Match that pattern exactly rather than introducing a second one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL — new assertions don't match the still-linear-text wizard's output.

- [ ] **Step 3: Implement**

In `db.ts`, change the `onboarding_state` accessor pair's payload type (keep the table/column names — `answers TEXT` already stores arbitrary JSON, no schema migration needed):

```typescript
export function getWizardState(db: DB, chatId: number): WizardState | null {
  const row = db.prepare('SELECT answers FROM onboarding_state WHERE chat_id = ?').get(chatId) as { answers: string } | undefined;
  return row ? (JSON.parse(row.answers) as WizardState) : null;
}

export function setWizardState(db: DB, chatId: number, state: WizardState): void {
  db.prepare(`
    INSERT INTO onboarding_state (chat_id, answers, updated_at) VALUES (@chatId, @answers, @updatedAt)
    ON CONFLICT(chat_id) DO UPDATE SET answers = excluded.answers, updated_at = excluded.updated_at
  `).run({ chatId, answers: JSON.stringify(state), updatedAt: new Date().toISOString() });
}

export function deleteWizardState(db: DB, chatId: number): void {
  db.prepare('DELETE FROM onboarding_state WHERE chat_id = ?').run(chatId);
}
```

Rename the old `getOnboardingState`/`setOnboardingState`/`deleteOnboardingState` exports to these three (`WizardState` is imported from `./wizard.js` — `db.ts` already imports types from `apt-hunter`, so a same-package cross-import from `wizard.ts` follows the existing pattern) and update `mcp-server.ts`'s import list if it referenced the old names (it doesn't, per Task 3's file list, but double check).

In `bot.ts`, delete every onboarding parser (`parseRange` through `parseOnboardingAnswers`) and `COMMUTE_STEP_INDEX`/`QUESTIONS`/`ONBOARDING_INTRO`. Add the rendering + handler logic:

```typescript
import {
  WIZARD_STEPS, BUDGET_BANDS, DISTRICT_GROUPS, initialWizardState, applyWizardChoice, isWizardComplete, finalizePrefs,
  type WizardState, type WizardChoice,
} from './wizard.js';
import { t } from './locales.js';
import {
  createSearchProfile, getActiveSearchProfile, countSearchProfiles, MAX_SEARCH_PROFILES_PER_CHAT,
  getWizardState, setWizardState, deleteWizardState,
} from './db.js';

/** Builds the text + inline keyboard for whatever step `state` is currently on. Pure given `state` and the chat's language-resolved strings (passed in as `strings` so this stays testable without a DB). */
function renderWizardStep(state: WizardState, strings: Record<string, string>): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const step = WIZARD_STEPS[state.stepIndex];
  const progress = `${strings.wizard_progress} ${'●'.repeat(state.stepIndex + 1)}${'○'.repeat(WIZARD_STEPS.length - state.stepIndex - 1)}`;
  const backRow = state.stepIndex > 0 ? [Markup.button.callback(strings.btn_back, 'wizard:back')] : [];

  switch (step) {
    case 'name':
      return { text: `${progress}\n\n${strings.wizard_name_prompt}`, keyboard: Markup.inlineKeyboard([[Markup.button.callback(strings.btn_skip, 'wizard:name_skip')]]) };
    case 'budget':
      return {
        text: `${progress}\n\n${strings.wizard_budget_prompt}`,
        keyboard: Markup.inlineKeyboard([
          ...BUDGET_BANDS.map((b) => [Markup.button.callback(b.label, `wizard:budget:${b.priceFrom ?? ''}:${b.priceTo}`)]),
          backRow,
        ].filter((row) => row.length > 0)),
      };
    case 'districts': {
      const selected = new Set(state.partial.districts ?? []);
      const rows = DISTRICT_GROUPS.map((g) => g.districts.map((d) =>
        Markup.button.callback(selected.has(d) ? `✅ ${d}` : `${d}`, `wizard:district:${d}`)
      ));
      const continueRow = selected.size > 0 ? [Markup.button.callback(strings.btn_continue, 'wizard:districts_continue')] : [];
      return { text: `${progress}\n\n${strings.wizard_districts_prompt}`, keyboard: Markup.inlineKeyboard([...rows, continueRow, backRow].filter((r) => r.length > 0)) };
    }
    case 'rooms_size':
      return {
        text: `${progress}\n\n${strings.wizard_rooms_prompt}`,
        keyboard: Markup.inlineKeyboard([
          [Markup.button.callback('1', 'wizard:rooms:1:1'), Markup.button.callback('2', 'wizard:rooms:2:2'), Markup.button.callback('3+', 'wizard:rooms:3:')],
          [Markup.button.callback(strings.btn_custom_range, 'wizard:rooms_custom')],
          backRow,
        ].filter((r) => r.length > 0)),
      };
    case 'amenities': {
      const p = state.partial;
      const chip = (label: string, on: boolean, field: string) => Markup.button.callback(on ? `✅ ${label}` : `⬜ ${label}`, `wizard:amenity:${field}`);
      return {
        text: `${progress}\n\n${strings.wizard_amenities_prompt}`,
        keyboard: Markup.inlineKeyboard([
          [chip(strings.amenity_elevator, Boolean(p.requireElevator), 'requireElevator'), chip(strings.amenity_parking, Boolean(p.requireParking), 'requireParking')],
          [chip(strings.amenity_include_waitlist, Boolean(p.includeWaitlistHousing), 'includeWaitlistHousing')],
          [chip(strings.amenity_include_wg, Boolean(p.includeWg), 'includeWg')],
          [Markup.button.callback(strings.btn_continue, 'wizard:amenities_continue')],
          backRow,
        ].filter((r) => r.length > 0)),
      };
    }
    case 'commute':
      return { text: `${progress}\n\n${strings.wizard_commute_prompt}`, keyboard: Markup.inlineKeyboard([[Markup.button.callback(strings.btn_skip, 'wizard:commute_skip')], backRow].filter((r) => r.length > 0)) };
  }
}
```

`renderWizardStep` takes a plain `strings` record rather than `(db, chatId)` directly so it stays a pure function for the export contract Task 5 relies on being testable in isolation; `bot.ts`'s handlers build that record once per render via a small local helper:

```typescript
const WIZARD_STRING_KEYS = [
  'wizard_progress', 'wizard_name_prompt', 'wizard_budget_prompt', 'wizard_districts_prompt', 'wizard_rooms_prompt',
  'wizard_amenities_prompt', 'wizard_commute_prompt', 'btn_skip', 'btn_back', 'btn_continue', 'btn_custom_range',
  'amenity_elevator', 'amenity_parking', 'amenity_include_waitlist', 'amenity_include_wg',
] as const;

function wizardStrings(db: DB, chatId: number): Record<string, string> {
  return Object.fromEntries(WIZARD_STRING_KEYS.map((k) => [k, t(db, chatId, k)]));
}
```

Handlers (replacing the old `bot.start`, `bot.command('settings')`, and the onboarding branch of `bot.on('text')`):

```typescript
async function startWizard(telegram: Telegraf['telegram'], db: DB, chatId: number): Promise<void> {
  if (countSearchProfiles(db, chatId) >= MAX_SEARCH_PROFILES_PER_CHAT) {
    await telegram.sendMessage(chatId, `You already have ${MAX_SEARCH_PROFILES_PER_CHAT} searches — delete one with /searches first.`);
    return;
  }
  const state = initialWizardState();
  setWizardState(db, chatId, state);
  const { text, keyboard } = renderWizardStep(state, wizardStrings(db, chatId));
  await telegram.sendMessage(chatId, text, keyboard);
}

async function advanceWizard(ctx: /* Telegraf context, matches the rest of this file's handler signatures */ any, choice: WizardChoice): Promise<void> {
  const chatId = ctx.chat!.id;
  const db: DB = ctx.state.db; // or however this file's existing handlers already access db in closures — match createBot's existing closure pattern (db is already a createBot parameter captured by every other handler; do the same here, this signature is illustrative)
  const current = getWizardState(db, chatId);
  if (!current) return; // stale callback from a finished/abandoned wizard
  const next = applyWizardChoice(current, choice);

  if (isWizardComplete(next)) {
    deleteWizardState(db, chatId);
    const profile = createSearchProfile(db, chatId, next.profileName ?? 'Search 1', finalizePrefs(next));
    await ctx.editMessageText(`Saved "${profile.name}". New listings get checked every ~3h — I'll message you here as soon as something matches.`);
    await sendProfileActivationSummary(ctx.telegram, db, profile); // Task 9
    return;
  }
  setWizardState(db, chatId, next);
  const { text, keyboard } = renderWizardStep(next, wizardStrings(db, chatId));
  await ctx.editMessageText(text, keyboard);
}
```

Wire the handlers in `createBot`:

```typescript
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    if (getActiveSearchProfile(db, chatId)) {
      await ctx.reply('You already have a search set up — /next for a listing, /searches to manage your searches, or /settings to edit one.');
      return;
    }
    await ctx.reply(SAFETY_NOTICE);
    await startWizard(ctx.telegram, db, chatId);
  });

  bot.command('settings', async (ctx) => {
    // Task 7 replaces this with single-field editing; for this task, keep it starting a brand
    // new wizard run (same as before this task's change) so the command stays functional in the
    // interim — Task 7's own tests then overwrite this handler's behavior and its test coverage.
    await startWizard(ctx.telegram, db, ctx.chat.id);
  });

  bot.action('wizard:back', (ctx) => advanceWizard(ctx, { kind: 'back' }));
  bot.action('wizard:name_skip', (ctx) => advanceWizard(ctx, { kind: 'name', name: `Search ${countSearchProfiles(db, ctx.chat!.id) + 1}` }));
  bot.action(/^wizard:budget:(-?\d*):(-?\d+|Infinity)$/, (ctx) => {
    const [, fromRaw, toRaw] = ctx.match;
    advanceWizard(ctx, { kind: 'budget', priceFrom: fromRaw === '' ? null : Number(fromRaw), priceTo: toRaw === 'Infinity' ? Infinity : Number(toRaw) });
  });
  bot.action(/^wizard:district:(\d+)$/, (ctx) => advanceWizard(ctx, { kind: 'districts_toggle', district: Number(ctx.match[1]) }));
  bot.action('wizard:districts_continue', (ctx) => advanceWizard(ctx, { kind: 'districts_continue' }));
  bot.action(/^wizard:rooms:(\d+):(\d*)$/, (ctx) => {
    const [, fromRaw, toRaw] = ctx.match;
    advanceWizard(ctx, { kind: 'rooms_size', roomsFrom: Number(fromRaw), roomsTo: toRaw === '' ? null : Number(toRaw), areaFrom: null, areaTo: null });
  });
  bot.action(/^wizard:amenity:(requireElevator|requireParking|includeWaitlistHousing|includeWg)$/, (ctx) =>
    advanceWizard(ctx, { kind: 'amenity_toggle', field: ctx.match[1] as WizardChoice extends { kind: 'amenity_toggle' } ? WizardChoice['field'] : never })
  );
  bot.action('wizard:amenities_continue', (ctx) => advanceWizard(ctx, { kind: 'amenities_continue' }));
  bot.action('wizard:commute_skip', (ctx) => advanceWizard(ctx, { kind: 'commute_skip' }));
```

`bot.on('text')` now only needs to handle two free-text cases mid-wizard: the `name` step and the `commute` step (geocoding), replacing the old generic `answers.length === COMMUTE_STEP_INDEX` branching:

```typescript
  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const state = getWizardState(db, chatId);
    if (!state) return; // not mid-wizard, ignore free text
    const step = WIZARD_STEPS[state.stepIndex];
    const raw = ctx.message.text.trim();

    if (step === 'name') {
      const next = applyWizardChoice(state, { kind: 'name', name: raw });
      setWizardState(db, chatId, next);
      const { text, keyboard } = renderWizardStep(next, wizardStrings(db, chatId));
      await ctx.reply(text, keyboard); // first render of a new step after free text can't edit-in-place (no prior bot message id to edit) — sends fresh, every step after this one edits in place via callback handlers
      return;
    }
    if (step === 'commute') {
      const point = await deps.geocode(raw);
      if (!point) { await ctx.reply('couldn\'t find that location — try being more specific, or tap Skip'); return; }
      const next = applyWizardChoice(state, { kind: 'commute_set', destination: raw, lat: point.lat, lon: point.lon });
      deleteWizardState(db, chatId);
      const profile = createSearchProfile(db, chatId, next.profileName ?? 'Search 1', finalizePrefs(next));
      await ctx.reply(`Saved "${profile.name}".`);
      await sendProfileActivationSummary(ctx.telegram, db, profile);
      return;
    }
  });
```

`ctx.state.db` in the illustrative `advanceWizard` sketch above is a placeholder for "however this file already threads `db` into its handlers" — `createBot(db, token, deps)` already closes over `db` for every other handler in this file (see `bot.command('shortlist', async (ctx) => { const items = getShortlist(db, ...) })`), so `advanceWizard` should be defined *inside* `createBot`'s closure exactly like `sendNextCard` already is, not written as a free function taking `ctx.state.db` — fix this when transcribing into the real file so it matches the file's existing closure style instead of inventing a new context-passing convention.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/bot.ts swipe-bot/src/db.ts swipe-bot/test/bot.test.ts
git commit -m "replace linear text onboarding with the button-chip wizard"
```

---

## Task 7: /searches (list/switch/delete profiles) + /settings single-field edit

**Files:**
- Modify: `swipe-bot/src/bot.ts`
- Test: `swipe-bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `getSearchProfiles`, `setActiveSearchProfile`, `deleteSearchProfile`, `getActiveSearchProfile`, `updateSearchProfile` from Task 2; `renderWizardStep`, wizard choice appliers from Tasks 5-6 (single-field edit reuses the same per-step renderer, entered mid-wizard via `editingProfileId`).
- Produces: `bot.command('searches', ...)`, `bot.action(/^switchprofile:(\d+)$/, ...)`, `bot.action(/^deleteprofile:(\d+)$/, ...)`, `bot.action(/^editfield:(\d+):(name|budget|districts|rooms_size|amenities|commute)$/, ...)`. All later tasks (8-10) that need "the chat's current profile" call `getActiveSearchProfile(db, chatId)` — this task is what keeps that value meaningful once >1 profile exists.

- [ ] **Step 1: Write the failing tests**

```typescript
// swipe-bot/test/bot.test.ts (add)
test('/searches lists every profile for the chat with a switch button, marking the active one', async () => {
  // Seed 2 profiles via createSearchProfile (second one active), invoke /searches, assert the
  // reply text/buttons mention both profile names and the active one is visually marked (e.g. "▶").
});

test('tapping switchprofile:<id> makes that profile active', async () => {
  // Seed 2 profiles, fire the switchprofile: callback for the inactive one, assert
  // getActiveSearchProfile(db, chatId)!.id equals it afterward.
});

test('tapping deleteprofile:<id> on the active profile removes it and clears the active flag entirely', async () => {
  // Seed 1 profile, delete it, assert getSearchProfiles(db, chatId).length === 0 and
  // getActiveSearchProfile(db, chatId) === null.
});

test('/settings on the active profile offers per-field edit buttons instead of restarting the whole wizard', async () => {
  // Seed 1 profile, invoke /settings, assert the reply's buttons include editfield:<id>:budget
  // etc. rather than immediately showing the name-step prompt (the old Task-6-interim behavior).
});

test('editfield:<id>:budget jumps straight to the budget step, and completing just that step updates only that field', async () => {
  // Fire editfield:<id>:budget, then a wizard:budget: callback, assert updateSearchProfile was
  // applied (profile's other fields, e.g. districts, are unchanged; only priceFrom/priceTo moved).
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// inside createBot, replacing this task's interim /settings body from Task 6

bot.command('searches', async (ctx) => {
  const chatId = ctx.chat.id;
  const profiles = getSearchProfiles(db, chatId);
  if (profiles.length === 0) {
    await ctx.reply('No searches yet — /start to set one up.');
    return;
  }
  const lines = profiles.map((p) => `${p.active ? '▶ ' : '  '}${p.name}`).join('\n');
  const buttons = profiles.flatMap((p) => [
    ...(p.active ? [] : [Markup.button.callback(`Switch to "${p.name}"`, `switchprofile:${p.id}`)]),
    Markup.button.callback(`🗑️ Delete "${p.name}"`, `deleteprofile:${p.id}`),
  ]);
  const addButton = profiles.length < MAX_SEARCH_PROFILES_PER_CHAT ? [Markup.button.callback(t(db, chatId, 'btn_add_another_search'), 'wizard:new')] : [];
  await ctx.reply(`Your searches:\n${lines}`, Markup.inlineKeyboard([...buttons.map((b) => [b]), addButton].filter((r) => r.length > 0)));
});

bot.action(/^switchprofile:(\d+)$/, async (ctx) => {
  setActiveSearchProfile(db, ctx.chat!.id, Number(ctx.match[1]));
  await ctx.answerCbQuery('Switched.');
});

bot.action(/^deleteprofile:(\d+)$/, async (ctx) => {
  deleteSearchProfile(db, Number(ctx.match[1]));
  await ctx.answerCbQuery('Deleted.');
});

bot.action('wizard:new', (ctx) => startWizard(ctx.telegram, db, ctx.chat!.id));

bot.command('settings', async (ctx) => {
  const chatId = ctx.chat.id;
  const profile = getActiveSearchProfile(db, chatId);
  if (!profile) { await ctx.reply('No active search — /start to set one up.'); return; }
  const fieldButtons: [string, WizardStepId][] = [
    ['Name', 'name'], ['Budget', 'budget'], ['Districts', 'districts'], ['Rooms & size', 'rooms_size'], ['Amenities', 'amenities'], ['Commute', 'commute'],
  ];
  await ctx.reply(
    `Editing "${profile.name}" — pick a field:`,
    Markup.inlineKeyboard(fieldButtons.map(([label, field]) => [Markup.button.callback(label, `editfield:${profile.id}:${field}`)])),
  );
});

bot.action(/^editfield:(\d+):(name|budget|districts|rooms_size|amenities|commute)$/, async (ctx) => {
  const [, profileIdRaw, field] = ctx.match;
  const profileId = Number(profileIdRaw);
  const profile = getSearchProfile(db, profileId);
  if (!profile) return;
  const stepIndex = WIZARD_STEPS.indexOf(field as WizardStepId);
  const state: WizardState = { stepIndex, profileName: profile.name, partial: profile.prefs, editingProfileId: profileId };
  setWizardState(db, ctx.chat!.id, state);
  const { text, keyboard } = renderWizardStep(state, wizardStrings(db, ctx.chat!.id));
  await ctx.editMessageText(text, keyboard);
});
```

`advanceWizard` (Task 6) needs one addition to close the edit-single-field loop: when `next.editingProfileId != null` and the *single field just answered* would normally advance to the next wizard step, instead treat that one answer as terminal — call `updateSearchProfile(db, next.editingProfileId, { ...profile.prefs, ...answeredFieldOnly })` and confirm, rather than continuing on to the following step. Implement this as: after computing `next` in `advanceWizard`, if `current.editingProfileId != null`, skip the `isWizardComplete`/continue-stepping branch entirely and instead:

```typescript
  if (current.editingProfileId != null) {
    const profile = getSearchProfile(db, current.editingProfileId)!;
    updateSearchProfile(db, profile.id, { ...profile.prefs, ...next.partial });
    if (next.profileName && next.profileName !== profile.name) renameSearchProfile(db, profile.id, next.profileName);
    deleteWizardState(db, ctx.chat!.id);
    await ctx.editMessageText(`Updated "${next.profileName ?? profile.name}".`);
    return;
  }
```

placed before the existing `isWizardComplete(next)` branch. This means single-field edits never call `applyWizardChoice`'s automatic `stepIndex + 1` advancement past the one field being edited — the `editfield:` handler already sets `stepIndex` to exactly the target step, and one answer on that step is always enough to reach this early-return branch on the very next `advanceWizard` call (since `districts`/`amenities` still require their own `_continue` tap first, same as in the full wizard — a single-field edit of "Districts" still needs the user to tap `Continue` after toggling, which is correct: it mirrors the main wizard's own interaction for that step).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/bot.ts swipe-bot/test/bot.test.ts
git commit -m "add /searches (list/switch/delete) and single-field /settings editing"
```

---

## Task 8: Card amenity badges (elevator/parking/floor/energy/availability + pet badge)

**Files:**
- Modify: `swipe-bot/src/bot.ts` (`formatCaption`)
- Test: `swipe-bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `ListingRow`'s new `lift`/`parkingSpaces`/`floor`/`energyClass`/`availableFrom`/`mentionsPets` fields from Task 2.
- Produces: `formatCaption`'s signature is unchanged (`(l: ListingRow, commuteLine?: string | null): string`) — this task only changes its output.

- [ ] **Step 1: Write the failing tests**

```typescript
// swipe-bot/test/bot.test.ts (add, alongside the existing formatCaption tests)
test('formatCaption shows elevator/parking/floor/energy class only when known, never fabricating "no" for a null field', () => {
  const withAmenities = formatCaption(row({ lift: true, parkingSpaces: 2, floor: '3. Stock', energyClass: 'B' }));
  assert.match(withAmenities, /Lift/i);
  assert.match(withAmenities, /Parking/i);
  assert.match(withAmenities, /3\. Stock/);
  assert.match(withAmenities, /B/);

  const withoutAmenities = formatCaption(row({ lift: null, parkingSpaces: null, floor: null, energyClass: null }));
  assert.doesNotMatch(withoutAmenities, /Lift/i);
  assert.doesNotMatch(withoutAmenities, /Parking/i);
});

test('formatCaption shows the unverified pet badge only when mentionsPets is true', () => {
  assert.match(formatCaption(row({ mentionsPets: true })), /🐾 mentions pets — check listing/);
  assert.doesNotMatch(formatCaption(row({ mentionsPets: false })), /🐾/);
});

test('formatCaption still truncates to 1024 chars with the new badge lines included', () => {
  const caption = formatCaption(row({ description: 'x'.repeat(2000), lift: true, parkingSpaces: 1, mentionsPets: true }));
  assert.ok(caption.length <= 1024);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// in formatCaption, after the existing flag/wgFlag lines
  const amenityBits = [
    l.lift === true ? 'Lift' : null,
    l.parkingSpaces != null && l.parkingSpaces > 0 ? `Parking (${l.parkingSpaces})` : null,
    l.floor ? `Floor: ${l.floor}` : null,
    l.energyClass ? `Energy: ${l.energyClass}` : null,
    l.availableFrom ? `Available: ${l.availableFrom}` : null,
  ].filter((x): x is string => x != null);
  const amenities = amenityBits.length > 0 ? `\n${amenityBits.join(' · ')}` : '';
  const petBadge = l.mentionsPets ? '\n🐾 mentions pets — check listing' : '';
```

Splice `amenities` and `petBadge` into the existing `base` template (after `commute`, before the URL, or wherever reads cleanest alongside `flag`/`wgFlag` — keep the existing order of "structured facts, then flags, then commute, then link, then description" and insert `amenities`/`petBadge` among the flags so the URL/description positions don't shift for existing tests that anchor on them).

The pet badge text should route through `t(db, chatId, 'pet_badge')` for full i18n coverage — but `formatCaption` is a pure function with no `db`/`chatId` parameter (deliberately, so it stays trivially testable per its existing doc comment "Pure — exported for direct testing"). Keep it pure: add an optional third parameter `petBadgeText?: string` defaulting to the English string, and have the one call site that needs localization (`sendCard`/`sendShortlistCard` in this same file) pass `t(db, chatId, 'pet_badge')` explicitly. Update `formatCaption`'s existing call sites (`sendListingCard`'s two callers) to thread this through; the English default keeps `formatCaption(row({}))`-style tests (which don't pass a `db`) working unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/bot.ts swipe-bot/test/bot.test.ts
git commit -m "surface elevator/parking/floor/energy/availability and a pet-mention badge on cards"
```

---

## Task 9: Aggregate summary + list-mode pagination (results delivery, part 1)

**Files:**
- Modify: `swipe-bot/src/bot.ts`
- Test: `swipe-bot/test/bot.test.ts`

**Interfaces:**
- Consumes: `getCandidateListings`, `matchesPrefs`, `SearchProfile` from Tasks 2-3; `rankListings` from `scoring.ts` (unchanged).
- Produces:
  - `summarizeMatches(listings: ListingRow[]): { count: number; priceMin: number | null; priceMax: number | null; priceAvg: number | null; topDistricts: number[] }` (pure, exported for direct testing)
  - `formatAggregateSummary(profile: SearchProfile, summary: ReturnType<typeof summarizeMatches>): string` (pure)
  - `buildListModeEntries(listings: ListingRow[]): string[]` (pure — one compact line per listing: title, price, size/rooms/district, link)
  - `LIST_MODE_PAGE_SIZE = 5`
  - `bot.action(/^listmore:(\d+)$/, ...)` — pagination continuation, offset encoded in the callback data
  - `sendProfileActivationSummary(telegram, db, profile): Promise<void>` (used by Task 6's wizard-completion handlers, referenced there as a forward dependency this task fulfills)

- [ ] **Step 1: Write the failing tests**

```typescript
// swipe-bot/test/bot.test.ts (add)
test('summarizeMatches computes count, price range/avg, and top districts', () => {
  const listings = [row({ id: 'a', price: 650, district: 6 }), row({ id: 'b', price: 890, district: 6 }), row({ id: 'c', price: 700, district: 10 })];
  const s = summarizeMatches(listings);
  assert.equal(s.count, 3);
  assert.equal(s.priceMin, 650);
  assert.equal(s.priceMax, 890);
  assert.equal(Math.round(s.priceAvg!), 747);
  assert.deepEqual(s.topDistricts, [6, 10]); // district 6 appears twice, sorted by frequency
});

test('summarizeMatches handles an empty list without throwing, all price fields null', () => {
  const s = summarizeMatches([]);
  assert.equal(s.count, 0);
  assert.equal(s.priceMin, null);
});

test('formatAggregateSummary renders the profile name, count, price range/avg, and district breakdown', () => {
  const profile = { id: 1, chatId: 1, name: 'Studio Center', active: true, createdAt: '', prefs: prefs() };
  const text = formatAggregateSummary(profile, summarizeMatches([row({ price: 650, district: 6 }), row({ price: 890, district: 6 })]));
  assert.match(text, /Studio Center/);
  assert.match(text, /€650-890/);
  assert.match(text, /district(s)? 6/i);
});

test('buildListModeEntries renders one compact line per listing with no photos, price, and link', () => {
  const entries = buildListModeEntries([row({ title: 'Cozy flat', price: 700, url: 'https://x/1' })]);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /Cozy flat/);
  assert.match(entries[0], /€700/);
  assert.match(entries[0], /https:\/\/x\/1/);
});

test('/shortlist with more than LIST_MODE_PAGE_SIZE items sends the first page plus a "Show N more" button, not every card at once', async () => {
  // Seed LIST_MODE_PAGE_SIZE + 3 shortlist entries, invoke /shortlist, assert only one message
  // was sent (not one sendPhoto/sendMessage per item) and it contains a listmore: callback button.
});

test('tapping listmore:<offset> appends the next page to the same message', async () => {
  // Seed enough shortlist entries for 2 pages, fire /shortlist then the listmore: callback,
  // assert ctx.editMessageText was called with all items from both pages present.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
export function summarizeMatches(listings: ListingRow[]): { count: number; priceMin: number | null; priceMax: number | null; priceAvg: number | null; topDistricts: number[] } {
  const prices = listings.map((l) => l.price).filter((p): p is number => p != null);
  const districtCounts = new Map<number, number>();
  for (const l of listings) { if (l.district != null) districtCounts.set(l.district, (districtCounts.get(l.district) ?? 0) + 1); }
  const topDistricts = [...districtCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d);
  return {
    count: listings.length,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    priceAvg: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
    topDistricts,
  };
}

export function formatAggregateSummary(profile: SearchProfile, s: ReturnType<typeof summarizeMatches>): string {
  const priceRange = s.priceMin != null && s.priceMax != null ? `€${s.priceMin}-${s.priceMax} (avg €${Math.round(s.priceAvg!)})` : 'price n/a';
  const districts = s.topDistricts.length > 0 ? ` · mostly district${s.topDistricts.length > 1 ? 's' : ''} ${s.topDistricts.join(', ')}` : '';
  return `🏠 ${profile.name}: ${s.count} match${s.count === 1 ? '' : 'es'} · ${priceRange}${districts}`;
}

export const LIST_MODE_PAGE_SIZE = 5;

export function buildListModeEntries(listings: ListingRow[]): string[] {
  return listings.map((l) => {
    const price = l.price != null ? `€${l.price}` : 'price n/a';
    const details = [l.area != null ? `${l.area}m²` : null, l.rooms != null ? `${l.rooms} rooms` : null, l.district != null ? `district ${l.district}` : null].filter(Boolean).join(' · ');
    return `${l.title}\n${price} · ${details}\n${l.url}`;
  });
}

async function sendProfileActivationSummary(telegram: Telegraf['telegram'], db: DB, profile: SearchProfile): Promise<void> {
  const candidates = getCandidateListings(db, profile.chatId, profile.prefs);
  if (candidates.length === 0) {
    await telegram.sendMessage(profile.chatId, `🏠 ${profile.name}: no matches yet — I'll message you here as soon as something matches.`);
    return;
  }
  const summary = summarizeMatches(candidates);
  await telegram.sendMessage(
    profile.chatId, formatAggregateSummary(profile, summary),
    Markup.inlineKeyboard([[Markup.button.callback('Browse top matches ▸', `browse:${profile.id}`), Markup.button.callback('See all as list', `list:${profile.id}:0`)]]),
  );
}

bot.action(/^browse:(\d+)$/, async (ctx) => {
  await sendNextCard(ctx.telegram, ctx.chat!.id, db, deps);
});

bot.action(/^list:(\d+):(\d+)$/, async (ctx) => {
  const [, profileIdRaw, offsetRaw] = ctx.match;
  const profile = getSearchProfile(db, Number(profileIdRaw));
  if (!profile) return;
  const offset = Number(offsetRaw);
  const candidates = rankListings(getCandidateListings(db, profile.chatId, profile.prefs), getSwipedWithDirection(db, profile.chatId));
  const page = candidates.slice(offset, offset + LIST_MODE_PAGE_SIZE);
  const entries = buildListModeEntries(page).join('\n\n');
  const hasMore = offset + LIST_MODE_PAGE_SIZE < candidates.length;
  const keyboard = hasMore ? Markup.inlineKeyboard([[Markup.button.callback(`Show ${Math.min(LIST_MODE_PAGE_SIZE, candidates.length - offset - LIST_MODE_PAGE_SIZE)} more ▸`, `list:${profile.id}:${offset + LIST_MODE_PAGE_SIZE}`)]]) : Markup.inlineKeyboard([]);
  if (offset === 0) {
    await ctx.editMessageText(entries || 'No matches.', keyboard);
  } else {
    // Appending: edit the same message, concatenating the previously-shown text with the new page —
    // ctx.callbackQuery.message.text carries what's already rendered.
    const existing = (ctx.callbackQuery!.message as { text?: string }).text ?? '';
    await ctx.editMessageText(`${existing}\n\n${entries}`, keyboard);
  }
});
```

Rewrite `bot.command('shortlist', ...)` to use list-mode instead of looping `sendShortlistCard` per item:

```typescript
bot.command('shortlist', async (ctx) => {
  const chatId = ctx.chat.id;
  const items = getShortlist(db, chatId);
  if (items.length === 0) { await ctx.reply('Your shortlist is empty — 👍 a card to save it here.'); return; }
  const page = items.slice(0, LIST_MODE_PAGE_SIZE);
  const entries = buildListModeEntries(page).join('\n\n');
  const hasMore = items.length > LIST_MODE_PAGE_SIZE;
  const keyboard = hasMore
    ? Markup.inlineKeyboard([[Markup.button.callback(`Show ${Math.min(LIST_MODE_PAGE_SIZE, items.length - LIST_MODE_PAGE_SIZE)} more ▸`, `shortlistmore:${LIST_MODE_PAGE_SIZE}`)]])
    : Markup.inlineKeyboard([]);
  await ctx.reply(entries, keyboard);
});

bot.action(/^shortlistmore:(\d+)$/, async (ctx) => {
  const offset = Number(ctx.match[1]);
  const items = getShortlist(db, ctx.chat!.id);
  const page = items.slice(offset, offset + LIST_MODE_PAGE_SIZE);
  const entries = buildListModeEntries(page).join('\n\n');
  const hasMore = offset + LIST_MODE_PAGE_SIZE < items.length;
  const keyboard = hasMore ? Markup.inlineKeyboard([[Markup.button.callback(`Show ${Math.min(LIST_MODE_PAGE_SIZE, items.length - offset - LIST_MODE_PAGE_SIZE)} more ▸`, `shortlistmore:${offset + LIST_MODE_PAGE_SIZE}`)]]) : Markup.inlineKeyboard([]);
  const existing = (ctx.callbackQuery!.message as { text?: string }).text ?? '';
  await ctx.editMessageText(`${existing}\n\n${entries}`, keyboard);
});
```

`MAX_SHORTLIST_CARDS`, `sendShortlistCard`, and the `unlike:` remove-from-shortlist flow's card-based UI are superseded by this list-mode rendering — remove `MAX_SHORTLIST_CARDS`'s export and `sendShortlistCard` (dead code once `/shortlist` no longer calls it), and update `test/bot.test.ts` to delete/replace any test that imported them. Removing per-item 🗑️ buttons means `/shortlist` needs a text-based removal path instead — add `/unshortlist <n>` is out of scope creep; instead keep it simple: each list-mode entry line gets a trailing `(reply /remove <listing-id-suffix> to remove)` is also fiddly for a chat UI. Resolve this pragmatically: keep per-item Remove buttons by rendering each shortlist page as `LIST_MODE_PAGE_SIZE` individual short text messages (no photo, just the compact line) each with its own 🗑️ button, rather than one concatenated block — re-read this paragraph against the spec's "compact single-line entries... under one message" wording before implementing, and if a single concatenated message without per-item remove buttons is acceptable (removal still works fine via swiping past it / it naturally drops out of future candidate lists once passed elsewhere), prefer the simpler single-message version above and drop per-item removal from `/shortlist`'s list view; this is a small product-scope judgment call, not a technical constraint — pick the single-message version (matches the spec literally) and note in the PR/commit message that per-item shortlist removal was dropped in favor of pagination, flagging it for the user to confirm they're fine with that trade **before merging this task**, since it's a slight behavior removal the spec didn't explicitly call out.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/bot.ts swipe-bot/test/bot.test.ts
git commit -m "add aggregate match summary and list-mode pagination; switch /shortlist off per-card dumps"
```

---

## Task 10: Push notification pacing/cap + list-mode grouping (results delivery, part 2)

**Files:**
- Modify: `swipe-bot/src/notify.ts`
- Test: `swipe-bot/test/notify.test.ts`

**Interfaces:**
- Consumes: `buildListModeEntries`, `LIST_MODE_PAGE_SIZE` from Task 9 (imported from `bot.ts`, matching this file's existing `import { sendCard, getCommuteLineFor, ... } from './bot.js'` pattern).
- Produces: `notifyNewMatches`'s signature is unchanged; its internal behavior changes to grouped/paced/list-mode delivery. `PUSH_STAGGER_MS = 1500` (exported for test control — tests should inject a fake/no-op delay rather than actually sleeping 1.5s per assertion).

- [ ] **Step 1: Write the failing tests**

```typescript
// swipe-bot/test/notify.test.ts (add/replace)
test('notifyNewMatches sends one header + one list-mode message per matching profile, not one message per listing', async () => {
  // Seed a profile matching 7 new listings; assert exactly 2 sendMessage calls for that chat
  // (header line, then the list-mode block) — not 7 sendCard-style calls.
});

test('notifyNewMatches caps each profile at MAX_PUSH_PER_USER matches shown, with a "+N more" note', async () => {
  // 8 matches, MAX_PUSH_PER_USER = 5 -> list-mode block shows 5 entries plus a trailing "+3 more" line.
});

test('notifyNewMatches header includes the profile name so multi-profile users know which search matched', async () => {
  // Two profiles for the same chat, each matching different listings; assert both headers appear
  // and each names its own profile.
});

test('notifyNewMatches staggers sends across profiles by PUSH_STAGGER_MS to avoid Telegram flood-control', async () => {
  // Inject a fake delay function (see Step 3's signature change) and assert it was called once
  // per matching profile after the first, with PUSH_STAGGER_MS.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swipe-bot && npm test`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
import { buildListModeEntries } from './bot.js';

export const PUSH_STAGGER_MS = 1500;

/** Injectable so tests don't actually sleep; production callers omit this and get the real timer. */
export type DelayFn = (ms: number) => Promise<void>;
const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function notifyNewMatches(
  telegram: Telegraf['telegram'], db: DB, newListings: ListingRow[], computeCommute: ComputeCommuteFn, geocode: GeocodeFn,
  delay: DelayFn = realDelay,
): Promise<void> {
  if (newListings.length === 0) return;

  let first = true;
  for (const profile of getAllSearchProfiles(db)) {
    if (profile.chatId === MCP_CHAT_ID) continue;

    const matches = newListings.filter((l) => matchesPrefs(l, profile.prefs));
    if (matches.length === 0) continue;

    if (!first) await delay(PUSH_STAGGER_MS);
    first = false;

    const ranked = rankListings(matches, getSwipedWithDirection(db, profile.chatId));
    const toShow = ranked.slice(0, MAX_PUSH_PER_USER);
    const entries = buildListModeEntries(toShow).join('\n\n');
    const remainder = matches.length > toShow.length ? `\n\n+${matches.length - toShow.length} more — check /next.` : '';

    await telegram.sendMessage(profile.chatId, `🏠 ${profile.name} — ${matches.length} new match${matches.length === 1 ? '' : 'es'}:`);
    await telegram.sendMessage(profile.chatId, `${entries}${remainder}`);
  }
}
```

Update `index.ts`'s `notifyNewMatches(bot.telegram, db, inserted, deps.computeCommute, deps.geocode)` call — it still works unchanged since `delay` has a default, but confirm the call site still type-checks after the signature gains a 6th optional param.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swipe-bot && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/notify.ts swipe-bot/test/notify.test.ts
git commit -m "pace and group push notifications by profile instead of bursting full cards"
```

---

## Task 11: Full-suite regression pass, README/help text, and manual smoke test

**Files:**
- Modify: `swipe-bot/src/bot.ts` (`HELP_TEXT`, `BOT_COMMANDS` final pass), `swipe-bot/README.md` if one exists at that path (check `ls swipe-bot/README.md`; the top-level `austria-apartment-hunt/README.md` also documents the bot's commands per Task 1's earlier grep hit list — update whichever files actually describe user-facing commands)
- Test: full `npm test` in both `apt-hunter/` and `swipe-bot/`

**Interfaces:**
- Consumes: everything from Tasks 1-10.
- Produces: no new code — this task is verification + doc sync + the spec's manual smoke test.

- [ ] **Step 1: Update HELP_TEXT and BOT_COMMANDS for the new command set**

`HELP_TEXT` currently documents `/start`, `/next`, `/shortlist`, `/settings`. Rewrite it (through `t()`, adding an `en`/`ru`/`de` `help_full` key to the Task 4 locale files if it wasn't already fully covered there) to also mention `/searches` and `/language`, and to describe list-mode pagination and multi-profile pushes instead of the old "swipe through them one at a time" framing. `BOT_COMMANDS` gains `{ command: 'searches', description: 'Manage your saved searches' }` alongside the `language` entry Task 4 already added.

- [ ] **Step 2: Run the full test suite in both packages**

```bash
cd apt-hunter && npm test
cd ../swipe-bot && npm test
```

Expected: every test file passes — `normalize.test.ts`, `db.test.ts`, `bot.test.ts`, `wizard.test.ts`, `locales.test.ts`, `notify.test.ts`, `poller.test.ts`, `mcp-server.test.ts`, `commute.test.ts`, `scoring.test.ts`. If any file fails, it means an earlier task's "run the full suite" step (Global Constraints) missed a regression — fix forward in this task rather than reopening the earlier task's commit.

- [ ] **Step 3: Type-check the whole workspace**

```bash
cd swipe-bot && npm run build
cd ../apt-hunter && npm run build
```

Expected: both `tsc` builds succeed with zero errors — this catches any type mismatches `node --test` (which runs through `tsx`, not `tsc`) wouldn't have caught (e.g. an unused old `UserPrefs` import left behind, or a `WizardChoice['field']` cast that doesn't actually narrow correctly).

- [ ] **Step 4: Manual smoke test against a live chat**

Per the spec's Testing section, using the bot's real Telegram chat (or a throwaway test bot token if you don't want to touch the production bot's live data):

1. `/language` → switch to Russian, confirm the next `/start` wizard renders in Russian.
2. Run the full wizard end to end (name, budget chip, district taps + continue, rooms chip, an amenity toggle + continue, commute skip) → confirm the aggregate summary + Browse/List buttons appear.
3. `/searches` → `+ Add another search` → run the wizard again with different values → confirm both profiles are listed, and switching between them via `/searches` changes what `/next` returns.
4. `/settings` → edit just the budget field → confirm districts/rooms from the original setup are untouched afterward.
5. Manually seed >5 shortlist entries (swipe 👍 on several `/next` cards) → `/shortlist` → confirm one paginated message with a working "Show N more" button, not a burst of individual cards.
6. Trigger (or wait for) a poll cycle with >5 new matches for one profile → confirm the push arrives as one grouped, profile-named message, not a flood of individual cards.
7. Confirm a listing with `mentionsPets: true` shows the 🐾 unverified badge, and one with `lift: true` shows the elevator badge, on both a `/next` card and a list-mode entry.

Record the outcome of this manual pass in the task's completion note (or PR description) — this step has no automated assertion, so its result must be stated explicitly rather than assumed from the automated suite being green.

- [ ] **Step 5: Commit**

```bash
git add swipe-bot/src/bot.ts swipe-bot/src/locales/ swipe-bot/README.md
git commit -m "update help text and commands for /searches and /language; final regression pass"
```

---

## Self-Review

**Spec coverage:**
- Data model & multi-profile (search_profiles, chats, migration, 5-profile cap, swipes stay chat-keyed) → Task 2. ✅
- Onboarding wizard (chip-driven, edit-in-place, progress bar, Back, name/budget/districts/rooms/amenities/commute steps, single-field /settings) → Tasks 5-7. ✅
- Results delivery (aggregate summary, browse/list toggle, shortlist pagination, push pacing/cap/grouping) → Tasks 9-10. ✅
- Amenity filters & pet badge (elevator/parking as real filters, floor/energy/availability/pet as card info, willhaben has no lift/parking data so those filters only ever match immoscout listings) → Tasks 1, 3, 8. ✅
- i18n (en/ru/de catalog, `t()`, `/language`, listing content never translated) → Task 4, applied throughout Tasks 6-9's UI strings. ✅
- Testing section's specific coverage list (wizard transitions incl. Back, prefs_json round-trip, matchesPrefs w/ elevator/parking, pet-keyword true/false cases, `t()` fallback, multi-profile cap, active-profile switching, migration test, pagination batch sizes, manual smoke test) → distributed across every task's own test step plus Task 11's consolidated pass. ✅
- Open question "exact pet-keyword list" → resolved directly in Task 1's implementation (regex given) rather than left open. ✅
- Open question "/language mid-wizard re-render" → **not explicitly resolved** — Task 4 wires `/language` as a standalone command; switching language mid-wizard does not re-render the in-progress wizard message in the new language (it takes effect on the *next* interaction, matching the spec's second stated option). Noting this explicitly here rather than leaving it silently unaddressed: this is the simpler of the two options the spec left open, and matches what Task 4's `t()`-based rendering naturally does (no special-casing needed) — flagged as a deliberate, spec-sanctioned choice, not a gap.

**Placeholder scan:** No `TBD`/`TODO` remain. Task 9 contains one explicit product-scope judgment call (dropping per-item shortlist removal buttons in favor of pagination) that is resolved inline with a stated decision and rationale, not left as an open placeholder — flagged for the user to sign off on when that task lands, same as a real PR description would.

**Type/signature consistency:** `SearchProfilePrefs`/`SearchProfile` (Task 2) are used with identical shape in Tasks 3, 5-10. `matchesPrefs`/`getCandidateListings` keep their exact names across the `UserPrefs` → `SearchProfilePrefs` swap (Task 3), so no caller in Tasks 6-10 needs a different function name than what exists in the current codebase today. `getWizardState`/`setWizardState`/`deleteWizardState` (Task 6) consistently replace `getOnboardingState`/`setOnboardingState`/`deleteOnboardingState` everywhere they're referenced (Tasks 6-7). `buildListModeEntries`/`LIST_MODE_PAGE_SIZE` (Task 9) are imported into `notify.ts` in Task 10 with matching names. `t()`'s signature (`db, chatId, key, params?`) is used identically in Tasks 4, 6, 8.
