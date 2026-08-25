import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import {
  openDb,
  upsertListing, listingKey,
  recordSwipe, getShortlist, getShortlistForExport, removeFromShortlist, getCandidateListings, getSwipedWithDirection,
  getListingsByIds, getAllListingIds, matchesPrefs, getCommuteTimes, setCommuteTimes, setListingCoords,
  getListingsBySource, applyListingRefresh, setListingDelisted, deleteDelistedUnshortlisted,
  getLastSwipe, undoSwipe,
  createSearchProfile, getSearchProfiles, getSearchProfile, getActiveSearchProfile, setActiveSearchProfile,
  updateSearchProfile, renameSearchProfile, deleteSearchProfile, countSearchProfiles, getAllSearchProfiles,
  upsertActiveProfilePrefs, getChatLanguage, setChatLanguage, MAX_SEARCH_PROFILES_PER_CHAT,
  getWizardState, setWizardState, deleteWizardState,
  getNotifySettings, updateNotifySettings, recordNotified, countInstantSince, getNotifiedListingIds, DEFAULT_NOTIFY_SETTINGS,
  getCachedFileId, recordFileId, recordPhotoFailure, isKnownBadPhoto, isPermanentPhotoError,
  PHOTO_TRANSIENT_COOLDOWN_MS, PHOTO_PERMANENT_COOLDOWN_MS,
  type ListingRow, type SearchProfilePrefs, type ShortlistExportRow,
} from '../src/db.js';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';
import { initialWizardState, applyWizardChoice, finalizePrefs, BUDGET_BANDS } from '../src/wizard.js';

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
  return {
    source: 'willhaben', id: '1', url: 'https://x/1', title: 'Test flat',
    price: 650, pricePerSqm: 15, area: 43, rooms: 2, district: 6, zip: '1060',
    addressLine: null, lat: null, lon: null, isPrivate: true,
    requiresWaitlistTicket: false, isShortTerm: false, isWg: false, images: ['https://img/1.jpg'], description: 'A lovely flat.',
    dateCreated: '2026-08-01T00:00:00Z',
    lift: null, parkingSpaces: null, floor: null, energyClass: null, availableFrom: null, mentionsPets: false,
    ...overrides,
  };
}

const defaultPrefs = (_chatId: number): SearchProfilePrefs => ({
  priceFrom: null, priceTo: 800, districts: null,
  roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true,
  includeWg: true, requireElevator: false, requireParking: false,
  commuteDestination: null, commuteLat: null, commuteLon: null,
});

function prefs(overrides: Partial<SearchProfilePrefs> = {}): SearchProfilePrefs {
  return {
    priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null,
    areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: false,
    requireElevator: false, requireParking: false,
    commuteDestination: null, commuteLat: null, commuteLon: null,
    ...overrides,
  };
}

test('upsertListing inserts new, ignores duplicate id', () => {
  const db = openDb(':memory:');
  assert.equal(upsertListing(db, listing({ id: '1' })), true);
  assert.equal(upsertListing(db, listing({ id: '1', title: 'changed title' })), false);
  const rows = db.prepare('SELECT title FROM listings WHERE id = ?').all(listingKey(listing({ id: '1' })));
  assert.equal((rows[0] as { title: string }).title, 'Test flat'); // first insert wins, not overwritten
});

test('upsertListing drops short-term/nightly listings at the source — this bot is long-term-lease only', () => {
  const db = openDb(':memory:');
  assert.equal(upsertListing(db, listing({ id: 'daily', isShortTerm: true })), false);
  const rows = db.prepare('SELECT * FROM listings WHERE id = ?').all(listingKey(listing({ id: 'daily' })));
  assert.equal(rows.length, 0); // never stored, not even flagged — no downstream filter can leak it back in
});

test('getAllListingIds returns every stored id, prefixed by source', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: '1', source: 'willhaben' }));
  upsertListing(db, listing({ id: '1', source: 'immoscout' }));
  assert.deepEqual([...getAllListingIds(db)].sort(), ['immoscout:1', 'willhaben:1']);
});

test('getAllListingIds returns an empty set for a fresh db', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getAllListingIds(db), new Set());
});

test('upsertListing persists description, getCandidateListings round-trips it', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6, description: 'Sunny two-room flat near the park.' }));
  const prefs = { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null };
  const [row] = getCandidateListings(db, 1, prefs);
  assert.equal(row.description, 'Sunny two-room flat near the park.');
});

test('upsertListing stores null description as null, not the string "null"', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6, description: null }));
  const prefs = { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null };
  const [row] = getCandidateListings(db, 1, prefs);
  assert.equal(row.description, null);
});

test('openDb migrates an older database file that predates the description column', () => {
  const path = `/tmp/swipe-bot-migration-test-${Date.now()}.sqlite`;
  // Simulate a pre-migration DB: create the listings table without `description`.
  const preMigration = openDb(path);
  preMigration.exec('ALTER TABLE listings DROP COLUMN description'); // requires SQLite 3.35+, matches better-sqlite3's bundled version
  preMigration.close();

  // Reopening through openDb must not throw, and must add the column back.
  const migrated = openDb(path);
  upsertListing(migrated, listing({ id: 'a', district: 6, description: 'Migrated fine.' }));
  const prefs = { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null };
  const [row] = getCandidateListings(migrated, 1, prefs);
  assert.equal(row.description, 'Migrated fine.');
  migrated.close();
});

test('openDb migrates an older database predating requires_waitlist_ticket, defaulting existing rows to the pre-migration behavior (everything shown)', () => {
  const path = `/tmp/swipe-bot-migration-test-waitlist-${Date.now()}.sqlite`;
  const preMigration = openDb(path);
  upsertListing(preMigration, listing({ id: 'a', district: 6 }));
  preMigration.exec('ALTER TABLE listings DROP COLUMN requires_waitlist_ticket');
  preMigration.close();

  const migrated = openDb(path);
  const [row] = getCandidateListings(migrated, 1, defaultPrefs(1));
  assert.equal(row.requiresWaitlistTicket, false);
  migrated.close();
});

test('openDb repairs a listing whose requires_waitlist_ticket was missed at insert time, self-healing on every startup rather than being stuck wrong forever', () => {
  const path = `/tmp/swipe-bot-waitlist-repair-test-${Date.now()}.sqlite`;
  const preMigration = openDb(path);
  // Simulates the real bug found in prod: a title that clearly needs a waitlist ticket, stored with
  // requires_waitlist_ticket=0 (upsertListing never re-checks an already-stored row, so without a
  // repair pass this stays wrong forever).
  upsertListing(preMigration, listing({ id: 'a', district: 6, title: 'Gemeindewohnung zur Direktvergabe, Vormerkschein nötig', requiresWaitlistTicket: false }));
  preMigration.close();

  const migrated = openDb(path);
  const [row] = getListingsByIds(migrated, ['willhaben:a']);
  assert.equal(row.requiresWaitlistTicket, true); // repaired from the title alone, on reopen
  migrated.close();
});

test('openDb\'s waitlist-ticket repair never flips an already-correctly-unflagged listing', () => {
  const path = `/tmp/swipe-bot-waitlist-repair-test2-${Date.now()}.sqlite`;
  const preMigration = openDb(path);
  upsertListing(preMigration, listing({ id: 'a', district: 6, title: 'Sanierte Garconniere im 2. Liftstock', requiresWaitlistTicket: false }));
  preMigration.close();

  const migrated = openDb(path);
  const [row] = getListingsByIds(migrated, ['willhaben:a']);
  assert.equal(row.requiresWaitlistTicket, false);
  migrated.close();
});

test('openDb migrates an older database predating listings.lat/lon', () => {
  const path = `/tmp/swipe-bot-migration-test-commute-${Date.now()}.sqlite`;
  const preMigration = openDb(path);
  upsertListing(preMigration, listing({ id: 'a', district: 6, lat: 48.19, lon: 16.37 }));
  preMigration.exec('ALTER TABLE listings DROP COLUMN lat');
  preMigration.exec('ALTER TABLE listings DROP COLUMN lon');
  preMigration.close();

  const migrated = openDb(path);
  upsertListing(migrated, listing({ id: 'b', district: 6, lat: 48.2, lon: 16.4 }));
  const candidates = getCandidateListings(migrated, 1, defaultPrefs(1));
  assert.equal(candidates.find((c) => c.id === 'willhaben:b')!.lat, 48.2);
  migrated.close();
});

/**
 * A genuinely ancient user_prefs table — missing the include_waitlist_housing/include_wg/
 * commute_destination columns added in earlier migrations — must still migrate cleanly into
 * search_profiles: the guarded ALTER TABLE steps in migrate() backfill those columns (with the
 * same historical defaults as before) so migrateUserPrefsToSearchProfiles can read every row.
 */
test('openDb migrates a pre-waitlist/pre-WG/pre-commute user_prefs row into search_profiles, applying the historical column defaults first', () => {
  const path = `/tmp/swipe-bot-migration-test-ancient-userprefs-${Date.now()}.sqlite`;
  try {
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE user_prefs (
        chat_id INTEGER PRIMARY KEY, price_from REAL, price_to REAL, districts TEXT,
        rooms_from REAL, rooms_to REAL, area_from REAL, area_to REAL, updated_at TEXT NOT NULL
      );
    `);
    seed.prepare('INSERT INTO user_prefs (chat_id, price_to, updated_at) VALUES (7, 750, ?)').run(new Date().toISOString());
    seed.close();

    const db = openDb(path);
    const profiles = getSearchProfiles(db, 7);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].prefs.priceTo, 750);
    assert.equal(profiles[0].prefs.includeWaitlistHousing, true); // historical default: show everything
    assert.equal(profiles[0].prefs.includeWg, false); // historical default: hide WGs
    assert.equal(profiles[0].prefs.commuteDestination, null);
    db.close();
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test('listingKey namespaces by source', () => {
  assert.equal(listingKey(listing({ source: 'willhaben', id: '1' })), 'willhaben:1');
  assert.equal(listingKey(listing({ source: 'immoscout', id: '1' })), 'immoscout:1');
});

test('recordSwipe(like) adds to shortlist, recordSwipe(pass) does not', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));
  upsertListing(db, listing({ id: 'b' }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'pass');
  const shortlist = getShortlist(db, 1);
  assert.equal(shortlist.length, 1);
  assert.equal(shortlist[0].id, 'willhaben:a');
});

test('recordSwipe returns true and saves to shortlist for a like on an existing listing', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));
  const saved = recordSwipe(db, 1, 'willhaben:a', 'like');
  assert.equal(saved, true);
  assert.equal(getShortlist(db, 1).length, 1);
});

test('recordSwipe returns true for a pass regardless of whether the listing exists', () => {
  const db = openDb(':memory:');
  const saved = recordSwipe(db, 1, 'willhaben:never-existed', 'pass');
  assert.equal(saved, true);
  assert.equal(getShortlist(db, 1).length, 0);
});

test('recordSwipe returns false and does not save to shortlist for a like on a listing that no longer exists (e.g. deleted by the refresh sweep between card send and swipe)', () => {
  const db = openDb(':memory:');
  const saved = recordSwipe(db, 1, 'willhaben:deleted-mid-flight', 'like');
  assert.equal(saved, false);
  assert.equal(getShortlist(db, 1).length, 0);
});

test('removeFromShortlist deletes the shortlist entry but leaves the swipe (like) intact, so the listing never resurfaces in /next', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  assert.equal(getShortlist(db, 1).length, 1);

  removeFromShortlist(db, 1, 'willhaben:a');

  assert.equal(getShortlist(db, 1).length, 0);
  const [swiped] = getSwipedWithDirection(db, 1);
  assert.equal(swiped.direction, 'like'); // still recorded as liked, not un-swiped
  assert.deepEqual(getCandidateListings(db, 1, defaultPrefs(1)), []); // stays excluded from the deck
});

test('removeFromShortlist is per-user — removing for one chat does not affect another chat\'s shortlist entry for the same listing', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 2, 'willhaben:a', 'like');

  removeFromShortlist(db, 1, 'willhaben:a');

  assert.equal(getShortlist(db, 1).length, 0);
  assert.equal(getShortlist(db, 2).length, 1);
});

test('getLastSwipe returns null when nothing has been swiped', () => {
  const db = openDb(':memory:');
  assert.equal(getLastSwipe(db, 1), null);
});

test('getLastSwipe returns the most recently swiped listing', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  upsertListing(db, listing({ id: 'b', district: 6 }));
  recordSwipe(db, 1, 'willhaben:a', 'pass');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  assert.deepEqual(getLastSwipe(db, 1), { listingId: 'willhaben:b', direction: 'like' });
});

test('undoSwipe reverses a like: deletes the swipe and the shortlist entry, making the listing eligible for /next again', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  assert.equal(undoSwipe(db, 1, 'willhaben:a'), true);
  assert.equal(getShortlist(db, 1).length, 0);
  const candidates = getCandidateListings(db, 1, defaultPrefs(1));
  assert.deepEqual(candidates.map((c) => c.id), ['willhaben:a']);
});

test('undoSwipe reverses a pass: deletes the swipe, no shortlist entry to touch', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  recordSwipe(db, 1, 'willhaben:a', 'pass');
  assert.equal(undoSwipe(db, 1, 'willhaben:a'), true);
  const candidates = getCandidateListings(db, 1, defaultPrefs(1));
  assert.deepEqual(candidates.map((c) => c.id), ['willhaben:a']);
});

test('undoSwipe refuses to undo anything but the chat\'s most recent swipe', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  upsertListing(db, listing({ id: 'b', district: 6 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'pass');
  assert.equal(undoSwipe(db, 1, 'willhaben:a'), false); // 'a' is no longer the last swipe
  assert.equal(getShortlist(db, 1).length, 1); // untouched
  const candidates = getCandidateListings(db, 1, defaultPrefs(1));
  assert.deepEqual(candidates.map((c) => c.id), []); // both still excluded
});

test('undoSwipe on a chat with no swipes at all is a no-op', () => {
  const db = openDb(':memory:');
  assert.equal(undoSwipe(db, 1, 'willhaben:a'), false);
});

test('getShortlistForExport returns each saved listing with its saved_at timestamp', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: '70' }));
  upsertListing(db, listing({ id: '71' }));
  // recordSwipe stamps saved_at from the wall clock (src/db.ts:733), so two likes in the same
  // millisecond would make the ordering assertion below flaky. Inserting directly pins both.
  db.prepare('INSERT INTO shortlist (chat_id, listing_id, saved_at) VALUES (?, ?, ?)')
    .run(1, 'willhaben:70', '2026-08-01T10:00:00.000Z');
  db.prepare('INSERT INTO shortlist (chat_id, listing_id, saved_at) VALUES (?, ?, ?)')
    .run(1, 'willhaben:71', '2026-08-02T10:00:00.000Z');

  const rows = getShortlistForExport(db, 1);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].listing.id, 'willhaben:71', 'newest-liked first, matching getShortlist');
  assert.equal(rows[0].savedAt, '2026-08-02T10:00:00.000Z');
  assert.equal(rows[1].savedAt, '2026-08-01T10:00:00.000Z');
});

test('getShortlistForExport agrees with getShortlist on ordering', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: '72' }));
  upsertListing(db, listing({ id: '73' }));
  recordSwipe(db, 1, 'willhaben:72', 'like');
  recordSwipe(db, 1, 'willhaben:73', 'like');

  const exported = getShortlistForExport(db, 1).map((r) => r.listing.id);
  assert.deepEqual(exported, getShortlist(db, 1).map((l) => l.id));
});

test('getShortlistForExport returns an empty array for a chat with no likes', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getShortlistForExport(db, 99), []);
});

test('getCandidateListings excludes already-swiped and filters by prefs', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'cheap', price: 500, district: 6 }));
  upsertListing(db, listing({ id: 'expensive', price: 2000, district: 6 }));
  upsertListing(db, listing({ id: 'wrong-district', price: 500, district: 20 }));
  recordSwipe(db, 1, 'willhaben:cheap', 'pass');

  const prefs = { priceFrom: null, priceTo: 800, districts: [6, 7], roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null };
  const candidates = getCandidateListings(db, 1, prefs);
  assert.deepEqual(candidates.map((c) => c.id), []); // 'cheap' already swiped, 'expensive' over budget, 'wrong-district' filtered
});

test('getCandidateListings excludes waitlist housing when includeWaitlistHousing is false', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'open', district: 6, requiresWaitlistTicket: false }));
  upsertListing(db, listing({ id: 'gemeindewohnung', district: 6, requiresWaitlistTicket: true }));

  const withWaitlist = getCandidateListings(db, 1, { ...defaultPrefs(1), includeWaitlistHousing: true, commuteDestination: null, commuteLat: null, commuteLon: null });
  assert.deepEqual(withWaitlist.map((c) => c.id).sort(), ['willhaben:gemeindewohnung', 'willhaben:open']);

  const withoutWaitlist = getCandidateListings(db, 1, { ...defaultPrefs(1), includeWaitlistHousing: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  assert.deepEqual(withoutWaitlist.map((c) => c.id), ['willhaben:open']);
});

test('getCandidateListings excludes WG/shared-flat listings when includeWg is false', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'flat', district: 6, isWg: false }));
  upsertListing(db, listing({ id: 'wg-room', district: 6, isWg: true }));

  const withoutWg = getCandidateListings(db, 1, { ...defaultPrefs(1), includeWg: false });
  assert.deepEqual(withoutWg.map((c) => c.id), ['willhaben:flat']);

  const withWg = getCandidateListings(db, 1, { ...defaultPrefs(1), includeWg: true });
  assert.deepEqual(withWg.map((c) => c.id).sort(), ['willhaben:flat', 'willhaben:wg-room']);
});

test('getCandidateListings is per-user — different chats see independent exclusions', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'x', price: 500, district: 6 }));
  recordSwipe(db, 1, 'willhaben:x', 'pass');
  const prefs = defaultPrefs(2);
  const candidatesForChat2 = getCandidateListings(db, 2, { ...prefs, districts: [6] });
  assert.deepEqual(candidatesForChat2.map((c) => c.id), ['willhaben:x']);
});

test('getSwipedWithDirection returns listing + direction pairs', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  const swiped = getSwipedWithDirection(db, 1);
  assert.equal(swiped.length, 1);
  assert.equal(swiped[0].direction, 'like');
  assert.equal(swiped[0].listing.district, 6);
});

test('getListingsByIds returns only the requested rows, in no particular guaranteed order', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));
  upsertListing(db, listing({ id: 'b' }));
  upsertListing(db, listing({ id: 'c' }));
  const rows = getListingsByIds(db, ['willhaben:a', 'willhaben:c']);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['willhaben:a', 'willhaben:c']);
});

test('getListingsByIds returns an empty array for an empty id list, without querying', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getListingsByIds(db, []), []);
});

function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: [],
    description: null, url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
    requiresWaitlistTicket: false, isWg: false, addressLine: null, lat: null, lon: null, isDelisted: false,
    lift: null, parkingSpaces: null, floor: null, energyClass: null, availableFrom: null, mentionsPets: false,
    ...overrides,
  };
}

test('matchesPrefs: a null listing field always passes price/area/rooms bounds', () => {
  const prefs = { priceFrom: 500, priceTo: 800, districts: null, roomsFrom: 1, roomsTo: 3, areaFrom: 30, areaTo: 60 , includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(matchesPrefs(row({ price: null, area: null, rooms: null }), prefs), true);
});

test('matchesPrefs: an out-of-range price/area/rooms fails', () => {
  const prefs = { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(matchesPrefs(row({ price: 900 }), prefs), false);
  assert.equal(matchesPrefs(row({ price: 700 }), prefs), true);
});

test('matchesPrefs: a null district FAILS a district restriction (mirrors the SQL IN clause, no OR-NULL escape hatch)', () => {
  const prefs = { priceFrom: null, priceTo: null, districts: [6, 7], roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(matchesPrefs(row({ district: null }), prefs), false);
  assert.equal(matchesPrefs(row({ district: 6 }), prefs), true);
  assert.equal(matchesPrefs(row({ district: 9 }), prefs), false);
});

test('matchesPrefs: unrestricted prefs (all null) match anything', () => {
  const prefs = { priceFrom: null, priceTo: null, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(matchesPrefs(row({ price: 5000, area: 5, rooms: 10, district: 23 }), prefs), true);
});

test('matchesPrefs: includeWaitlistHousing false excludes municipal/waitlist housing, true includes it', () => {
  const prefs = { priceFrom: null, priceTo: null, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: false, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(matchesPrefs(row({ requiresWaitlistTicket: true }), prefs), false);
  assert.equal(matchesPrefs(row({ requiresWaitlistTicket: false }), prefs), true);
  assert.equal(matchesPrefs(row({ requiresWaitlistTicket: true }), { ...prefs, includeWaitlistHousing: true }), true);
});

test('matchesPrefs: includeWg false excludes WG/shared-flat listings, true includes them', () => {
  const prefs = { ...defaultPrefs(1), includeWg: false };
  assert.equal(matchesPrefs(row({ isWg: true }), prefs), false);
  assert.equal(matchesPrefs(row({ isWg: false }), prefs), true);
  assert.equal(matchesPrefs(row({ isWg: true }), { ...prefs, includeWg: true }), true);
});

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

test('openDb migrates an older database predating is_wg, backfilling is_wg from stored titles', () => {
  const path = `/tmp/swipe-bot-migration-test-wg-${Date.now()}.sqlite`;
  const preMigration = openDb(path);
  upsertListing(preMigration, listing({ id: 'room', district: 6, title: 'WG-Zimmer frei', isWg: false })); // pre-migration: no is_wg column existed, so this couldn't have been flagged
  upsertListing(preMigration, listing({ id: 'flat', district: 6, title: 'Gemütliche 2-Zimmer-Wohnung', isWg: false }));
  preMigration.exec('ALTER TABLE listings DROP COLUMN is_wg');
  preMigration.close();

  const migrated = openDb(path);
  const [room] = getListingsByIds(migrated, ['willhaben:room']);
  const [flat] = getListingsByIds(migrated, ['willhaben:flat']);
  assert.equal(room.isWg, true); // backfilled from title on migration, not left stuck at false
  assert.equal(flat.isWg, false);
  migrated.close();
});

test('upsertListing persists lat/lon, getCandidateListings round-trips them', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6, lat: 48.19, lon: 16.37 }));
  const [candidate] = getCandidateListings(db, 1, defaultPrefs(1));
  assert.equal(candidate.lat, 48.19);
  assert.equal(candidate.lon, 16.37);
});

test('upsertListing persists addressLine, getCandidateListings round-trips it, null stored as null', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6, addressLine: '1060 Wien, Mariahilfer Straße 1' }));
  upsertListing(db, listing({ id: 'b', district: 6, addressLine: null }));
  const candidates = getCandidateListings(db, 1, defaultPrefs(1));
  assert.equal(candidates.find((c) => c.id === 'willhaben:a')!.addressLine, '1060 Wien, Mariahilfer Straße 1');
  assert.equal(candidates.find((c) => c.id === 'willhaben:b')!.addressLine, null);
});

test('setListingCoords updates a listing\'s lat/lon in place, getListingsByIds reflects it', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6, lat: null, lon: null }));
  setListingCoords(db, 'willhaben:a', 48.2, 16.4);
  const [row] = getListingsByIds(db, ['willhaben:a']);
  assert.equal(row.lat, 48.2);
  assert.equal(row.lon, 16.4);
});

test('openDb migrates an older database predating listings.address_line', () => {
  const path = `/tmp/swipe-bot-migration-test-address-${Date.now()}.sqlite`;
  const preMigration = openDb(path);
  upsertListing(preMigration, listing({ id: 'a', district: 6, addressLine: '1060 Wien' }));
  preMigration.exec('ALTER TABLE listings DROP COLUMN address_line');
  preMigration.close();

  const migrated = openDb(path);
  const [row] = getListingsByIds(migrated, ['willhaben:a']);
  assert.equal(row.addressLine, null); // old value gone with the dropped column, but reopening must not throw
  migrated.close();
});

test('getCommuteTimes returns null before anything is cached, then round-trips what was set', () => {
  const db = openDb(':memory:');
  assert.equal(getCommuteTimes(db, 1, 'willhaben:a'), null);

  setCommuteTimes(db, 1, 'willhaben:a', { walkMinutes: 18, transitMinutes: 7, transitSummary: 'tram D' });
  assert.deepEqual(getCommuteTimes(db, 1, 'willhaben:a'), { walkMinutes: 18, transitMinutes: 7, transitSummary: 'tram D' });
});

test('setCommuteTimes overwrites on re-call (same chat + listing)', () => {
  const db = openDb(':memory:');
  setCommuteTimes(db, 1, 'willhaben:a', { walkMinutes: 18, transitMinutes: 7, transitSummary: 'tram D' });
  setCommuteTimes(db, 1, 'willhaben:a', { walkMinutes: 20, transitMinutes: null, transitSummary: null });
  assert.deepEqual(getCommuteTimes(db, 1, 'willhaben:a'), { walkMinutes: 20, transitMinutes: null, transitSummary: null });
});

test('commute cache is per (profile, listing) — independent across both profiles and listings', () => {
  const db = openDb(':memory:');
  setCommuteTimes(db, 1, 'willhaben:a', { walkMinutes: 10, transitMinutes: null, transitSummary: null });
  setCommuteTimes(db, 2, 'willhaben:a', { walkMinutes: 30, transitMinutes: null, transitSummary: null });
  assert.equal(getCommuteTimes(db, 1, 'willhaben:a')!.walkMinutes, 10);
  assert.equal(getCommuteTimes(db, 2, 'willhaben:a')!.walkMinutes, 30);
});

test('commute cache does not leak between two profiles in the same chat with different commute destinations, for the same listing', () => {
  const db = openDb(':memory:');
  const chatId = 42;
  // Two profiles for the same chat — only reachable via direct DB calls today (the wizard is
  // single-profile-per-chat until the multi-profile UI lands), but the cache must already be safe.
  const profileA = createSearchProfile(db, chatId, 'Near TU Wien', prefs({ commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 }), true);
  const profileB = createSearchProfile(db, chatId, 'Near Uni Wien', prefs({ commuteDestination: 'Uni Wien', commuteLat: 48.2131, commuteLon: 16.3593 }), false);

  setCommuteTimes(db, profileA.id, 'willhaben:shared', { walkMinutes: 12, transitMinutes: 8, transitSummary: 'U2' });
  setCommuteTimes(db, profileB.id, 'willhaben:shared', { walkMinutes: 40, transitMinutes: 25, transitSummary: 'U4 + tram' });

  assert.deepEqual(getCommuteTimes(db, profileA.id, 'willhaben:shared'), { walkMinutes: 12, transitMinutes: 8, transitSummary: 'U2' });
  assert.deepEqual(getCommuteTimes(db, profileB.id, 'willhaben:shared'), { walkMinutes: 40, transitMinutes: 25, transitSummary: 'U4 + tram' });
});

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

// --- search_profiles / chats -----------------------------------------------------------------

test('createSearchProfile makes the first profile for a chat active by default', () => {
  const db = openDb(':memory:');
  const p = createSearchProfile(db, 1, 'Studio Center', prefs());
  assert.equal(p.active, true);
  assert.equal(getActiveSearchProfile(db, 1)!.id, p.id);
});

test('createSearchProfile with makeActive=false does not activate the new profile or deactivate an existing one', () => {
  const db = openDb(':memory:');
  const a = createSearchProfile(db, 1, 'A', prefs());
  const b = createSearchProfile(db, 1, 'B', prefs(), false);
  assert.equal(b.active, false);
  assert.equal(getActiveSearchProfile(db, 1)!.id, a.id);
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
  assert.equal(updated.id, p.id);
  assert.equal(updated.active, true);
});

test('a profile created with priceTo: Infinity round-trips as priceTo: null (JSON has no Infinity, and null already means "no upper bound")', () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'No limit', prefs({ priceTo: Infinity }));
  const [loaded] = getSearchProfiles(db, 1);
  assert.equal(loaded.prefs.priceTo, null);
});

test('createSearchProfile itself returns priceTo: null (not Infinity) for prefs produced by the wizard\'s top "no limit" budget band — the caller-facing object must already be normalized, not just a later re-read of the row (createSearchProfile hands back the caller\'s in-memory prefs verbatim, without re-reading the inserted row)', () => {
  const db = openDb(':memory:');
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'No limit' });
  const topBand = BUDGET_BANDS[BUDGET_BANDS.length - 1];
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: topBand.priceFrom, priceTo: topBand.priceTo });
  s = applyWizardChoice(s, { kind: 'districts_continue' });
  s = applyWizardChoice(s, { kind: 'rooms_size', roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null });
  s = applyWizardChoice(s, { kind: 'amenities_continue' });
  s = applyWizardChoice(s, { kind: 'commute_skip' });
  const wizardPrefs = finalizePrefs(s);
  const created = createSearchProfile(db, 1, 'No limit', wizardPrefs);
  assert.equal(created.prefs.priceTo, null);
});

test('renameSearchProfile changes only the name', () => {
  const db = openDb(':memory:');
  const p = createSearchProfile(db, 1, 'Studio Center', prefs());
  renameSearchProfile(db, p.id, 'Near TU');
  const renamed = getSearchProfile(db, p.id)!;
  assert.equal(renamed.name, 'Near TU');
  assert.deepEqual(renamed.prefs, p.prefs);
});

test('getSearchProfile returns null for an unknown id', () => {
  const db = openDb(':memory:');
  assert.equal(getSearchProfile(db, 999), null);
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

test('upsertActiveProfilePrefs honors a custom defaultName on first call', () => {
  const db = openDb(':memory:');
  const created = upsertActiveProfilePrefs(db, 0, prefs(), 'Custom Name');
  assert.equal(created.name, 'Custom Name');
});

test('getChatLanguage defaults to "en", setChatLanguage persists a change', () => {
  const db = openDb(':memory:');
  assert.equal(getChatLanguage(db, 1), 'en');
  setChatLanguage(db, 1, 'ru');
  assert.equal(getChatLanguage(db, 1), 'ru');
});

test('setChatLanguage overwrites on re-call (same chatId)', () => {
  const db = openDb(':memory:');
  setChatLanguage(db, 1, 'de');
  setChatLanguage(db, 1, 'ru');
  assert.equal(getChatLanguage(db, 1), 'ru');
});

test('search profiles and chat languages are independent per chat', () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'A', prefs());
  setChatLanguage(db, 1, 'de');
  assert.equal(getSearchProfiles(db, 2).length, 0);
  assert.equal(getChatLanguage(db, 2), 'en');
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

test('upsertListing stores a null lift (unknown, distinct from false) and defaults mentionsPets to false', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'b', lift: null, parkingSpaces: null, floor: null, energyClass: null, availableFrom: null, mentionsPets: false }));
  const row = getListingsByIds(db, ['willhaben:b'])[0];
  assert.equal(row.lift, null);
  assert.equal(row.parkingSpaces, null);
  assert.equal(row.mentionsPets, false);
});

test('openDb migrates an older database predating the amenity columns, defaulting lift/parkingSpaces/floor/energyClass/availableFrom to null and mentionsPets to false', () => {
  const path = `/tmp/swipe-bot-migration-test-amenities-${Date.now()}.sqlite`;
  const preMigration = openDb(path);
  upsertListing(preMigration, listing({ id: 'a', district: 6, lift: true, parkingSpaces: 2, floor: '1. Stock', energyClass: 'B', availableFrom: '2026-09-01', mentionsPets: true }));
  preMigration.exec('ALTER TABLE listings DROP COLUMN lift');
  preMigration.exec('ALTER TABLE listings DROP COLUMN parking_spaces');
  preMigration.exec('ALTER TABLE listings DROP COLUMN floor');
  preMigration.exec('ALTER TABLE listings DROP COLUMN energy_class');
  preMigration.exec('ALTER TABLE listings DROP COLUMN available_from');
  preMigration.exec('ALTER TABLE listings DROP COLUMN mentions_pets');
  preMigration.close();

  const migrated = openDb(path);
  const [row] = getListingsByIds(migrated, ['willhaben:a']);
  assert.equal(row.lift, null); // old value gone with the dropped columns, but reopening must not throw
  assert.equal(row.parkingSpaces, null);
  assert.equal(row.floor, null);
  assert.equal(row.energyClass, null);
  assert.equal(row.availableFrom, null);
  assert.equal(row.mentionsPets, false);
  migrated.close();
});

test('a pre-existing user_prefs row is migrated into one active "My Search" search_profiles row on openDb, and the user_prefs table is dropped afterward', () => {
  const path = `/tmp/swipe-bot-migration-test-${Date.now()}.sqlite`;
  try {
    // Build a DB on the OLD schema by hand — openDb() now creates the new schema (no user_prefs
    // table at all), so it can't be used to seed the old one.
    const seed = new Database(path);
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

    const db = openDb(path); // triggers migrate()
    const profiles = getSearchProfiles(db, 5);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, 'My Search');
    assert.equal(profiles[0].active, true);
    assert.equal(profiles[0].prefs.priceTo, 700);
    assert.equal(profiles[0].prefs.requireElevator, false);
    assert.equal(profiles[0].prefs.requireParking, false);
    assert.equal(getChatLanguage(db, 5), 'en'); // a chats row is created alongside the migrated profile
    // A migrated user has been swiping this deck since before the quiet notifier existed, so their
    // backlog must stay old news: null lastDigestAt is the signal dispatchDigests adopts silently on.
    // createSearchProfile stamps every other new profile, so the migration has to clear it back.
    assert.equal(getNotifySettings(db, profiles[0].id).lastDigestAt, null);

    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_prefs'`).get();
    assert.equal(tableExists, undefined); // dropped after migration
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test('re-opening a database that has already been migrated is a no-op (user_prefs stays absent, search_profiles untouched)', () => {
  const path = `/tmp/swipe-bot-migration-test-idempotent-${Date.now()}.sqlite`;
  try {
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE user_prefs (chat_id INTEGER PRIMARY KEY, price_to REAL, updated_at TEXT NOT NULL);
    `);
    seed.prepare('INSERT INTO user_prefs (chat_id, price_to, updated_at) VALUES (5, 700, ?)').run(new Date().toISOString());
    seed.close();

    const firstOpen = openDb(path);
    firstOpen.close();

    const secondOpen = openDb(path);
    const profiles = getSearchProfiles(secondOpen, 5);
    assert.equal(profiles.length, 1); // still exactly one — not duplicated by re-running migrate()
    secondOpen.close();
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test('openDb migrates a pre-existing (chat_id, listing_id)-keyed commute_cache onto the chat\'s active profile_id, and re-opening is a no-op', () => {
  const path = `/tmp/swipe-bot-migration-test-commute-cache-${Date.now()}.sqlite`;
  try {
    // Build a DB on the OLD commute_cache shape (chat_id-keyed) by hand, plus a search_profiles row
    // for that chat — openDb() itself always creates the new profile_id-keyed shape, so it can't be
    // used to seed the old one.
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE search_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, name TEXT NOT NULL,
        prefs_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE commute_cache (
        chat_id INTEGER NOT NULL, listing_id TEXT NOT NULL,
        walk_minutes INTEGER, transit_minutes INTEGER, transit_summary TEXT, computed_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, listing_id)
      );
    `);
    const now = new Date().toISOString();
    seed.prepare('INSERT INTO search_profiles (chat_id, name, prefs_json, active, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(9, 'My Search', JSON.stringify(prefs()), now);
    seed.prepare('INSERT INTO commute_cache (chat_id, listing_id, walk_minutes, transit_minutes, transit_summary, computed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(9, 'willhaben:old', 15, 5, 'U1', now);
    // A row whose chat has no search_profiles row at all — must be dropped, not crash the migration.
    seed.prepare('INSERT INTO commute_cache (chat_id, listing_id, walk_minutes, transit_minutes, transit_summary, computed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(404, 'willhaben:orphan', 99, 99, 'nowhere', now);
    seed.close();

    const db = openDb(path); // triggers migrate()
    const profile = getActiveSearchProfile(db, 9)!;
    assert.deepEqual(getCommuteTimes(db, profile.id, 'willhaben:old'), { walkMinutes: 15, transitMinutes: 5, transitSummary: 'U1' });

    const columns = (db.prepare('PRAGMA table_info(commute_cache)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(columns.sort(), ['computed_at', 'listing_id', 'profile_id', 'transit_minutes', 'transit_summary', 'walk_minutes'].sort());

    const rowCount = (db.prepare('SELECT COUNT(*) as n FROM commute_cache').get() as { n: number }).n;
    assert.equal(rowCount, 1); // the orphaned chat_id=404 row was dropped, not carried forward

    db.close();
    const reopened = openDb(path); // migration must be a no-op the second time
    const reopenedProfile = getActiveSearchProfile(reopened, 9)!;
    assert.deepEqual(getCommuteTimes(reopened, reopenedProfile.id, 'willhaben:old'), { walkMinutes: 15, transitMinutes: 5, transitSummary: 'U1' });
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

// --- Final-review fix wave: a legacy/malformed onboarding_state row must never brick a chat ---

test('getWizardState returns null (not a malformed cast) and self-heals an old-shaped onboarding_state row', () => {
  const db = openDb(':memory:');
  // Simulates the pre-redesign linear-text onboarding's payload shape (a plain string[] of answers),
  // which doesn't have stepIndex/partial/editingProfileId at all.
  db.prepare('INSERT INTO onboarding_state (chat_id, answers, updated_at) VALUES (?, ?, ?)')
    .run(1, JSON.stringify(['Studio Center', '700-900']), new Date().toISOString());

  assert.equal(getWizardState(db, 1), null);
  const row = db.prepare('SELECT * FROM onboarding_state WHERE chat_id = ?').get(1);
  assert.equal(row, undefined); // self-healed: the malformed row is cleared, not left to keep failing
});

test('getWizardState returns null for genuinely corrupt (non-JSON) answers, without throwing', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO onboarding_state (chat_id, answers, updated_at) VALUES (?, ?, ?)')
    .run(1, 'not even json', new Date().toISOString());

  assert.equal(getWizardState(db, 1), null);
});

test('getWizardState round-trips a valid WizardState untouched', () => {
  const db = openDb(':memory:');
  const state = { stepIndex: 2, profileName: 'My Search', partial: { priceFrom: 700, priceTo: 900 }, editingProfileId: null };
  setWizardState(db, 1, state);
  assert.deepEqual(getWizardState(db, 1), state);
});

test('a Back tap on the very first step correctly stays null-cleared: deleteWizardState is idempotent on an already-empty chat', () => {
  const db = openDb(':memory:');
  assert.doesNotThrow(() => deleteWizardState(db, 1)); // no row to begin with
});

test('openDb clears a legacy/malformed onboarding_state row left over from before the button-wizard redesign, on startup', () => {
  const path = `/tmp/swipe-bot-migration-test-onboarding-state-${Date.now()}.sqlite`;
  try {
    const preMigration = openDb(path);
    // Overwrite with the pre-redesign shape (string[] of free-text answers) — simulates a chat that
    // was mid-onboarding when this upgrade landed.
    preMigration.prepare('INSERT INTO onboarding_state (chat_id, answers, updated_at) VALUES (?, ?, ?)')
      .run(42, JSON.stringify(['Studio Center']), new Date().toISOString());
    // A second, already-valid row (as if some chat was already mid-wizard on the NEW shape) must survive.
    const validState = { stepIndex: 1, profileName: 'Kept', partial: {}, editingProfileId: null };
    setWizardState(preMigration, 43, validState);
    preMigration.close();

    const migrated = openDb(path); // triggers migrate() -> migrateOnboardingState
    assert.equal(getWizardState(migrated, 42), null); // legacy row cleared
    assert.deepEqual(getWizardState(migrated, 43), validState); // valid row untouched
    migrated.close();
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

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

test('getNotifySettings reads defaults without inserting a row for an unconfigured profile', () => {
  const db = openDb(':memory:');
  const settings = getNotifySettings(db, 1);

  assert.deepEqual(settings, { profileId: 1, ...DEFAULT_NOTIFY_SETTINGS });
  // Reading must never write — a backfill on read would make "unconfigured" indistinguishable from
  // "explicitly set to the defaults", and would strand rows for profiles that never opted in.
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM notify_settings').get() as { n: number };
  assert.equal(n, 0);

  // Still zero after several reads, including for a profile that does not exist at all.
  getNotifySettings(db, 1);
  getNotifySettings(db, 999);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM notify_settings').get() as { n: number }).n, 0);
});

test('the notify_settings DDL defaults match DEFAULT_NOTIFY_SETTINGS exactly', () => {
  const db = openDb(':memory:');
  // A row inserted by SQL alone must read back as the same defaults this module synthesizes.
  db.prepare('INSERT INTO notify_settings (profile_id) VALUES (?)').run(7);
  assert.deepEqual(getNotifySettings(db, 7), { profileId: 7, ...DEFAULT_NOTIFY_SETTINGS });
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

test('isPermanentPhotoError only matches wordings that mean the url itself is unusable', () => {
  assert.equal(isPermanentPhotoError('400: Bad Request: wrong file identifier/HTTP URL specified'), true);
  assert.equal(isPermanentPhotoError('400: Bad Request: failed to get HTTP URL content'), true);
  assert.equal(isPermanentPhotoError('400: Bad Request: WEBPAGE_CURL_FAILED'), true);
  assert.equal(isPermanentPhotoError('429: Too Many Requests: retry after 30'), false);
  assert.equal(isPermanentPhotoError('socket hang up'), false);
  assert.equal(isPermanentPhotoError('502 Bad Gateway'), false);
});

test('a transient photo failure suppresses the url only for the transient cooldown', () => {
  const db = openDb(':memory:');
  const at = new Date('2026-08-19T06:00:00Z');
  recordPhotoFailure(db, 'https://cdn/blip.jpg', 'socket hang up', at.toISOString());

  const before = new Date(at.getTime() + PHOTO_TRANSIENT_COOLDOWN_MS - 1000);
  const after = new Date(at.getTime() + PHOTO_TRANSIENT_COOLDOWN_MS + 1000);
  assert.equal(isKnownBadPhoto(db, 'https://cdn/blip.jpg', before), true);
  assert.equal(isKnownBadPhoto(db, 'https://cdn/blip.jpg', after), false);
});

test('a permanent photo failure outlives the transient cooldown by a wide margin', () => {
  const db = openDb(':memory:');
  const at = new Date('2026-08-19T06:00:00Z');
  recordPhotoFailure(db, 'https://cdn/dead.jpg', 'WEBPAGE_CURL_FAILED', at.toISOString());

  assert.equal(isKnownBadPhoto(db, 'https://cdn/dead.jpg', new Date(at.getTime() + PHOTO_TRANSIENT_COOLDOWN_MS * 100)), true);
  assert.equal(isKnownBadPhoto(db, 'https://cdn/dead.jpg', new Date(at.getTime() + PHOTO_PERMANENT_COOLDOWN_MS + 1000)), false);
});

test('a row blacklisted before retry_after existed self-heals rather than staying suppressed', () => {
  const db = openDb(':memory:');
  // Exactly what the pre-migration code wrote: failed = 1 with no expiry at all.
  db.prepare("INSERT INTO photo_cache (source_url, file_id, cached_at, failed, last_error) VALUES (?, NULL, ?, 1, 'legacy')")
    .run('https://cdn/legacy.jpg', '2026-08-19T06:00:00Z');
  assert.equal(isKnownBadPhoto(db, 'https://cdn/legacy.jpg', new Date('2026-08-19T06:00:01Z')), false);
});

test('a successful send clears a prior failure permanently', () => {
  const db = openDb(':memory:');
  recordPhotoFailure(db, 'https://cdn/x.jpg', 'WEBPAGE_CURL_FAILED', '2026-08-19T06:00:00Z');
  recordFileId(db, 'https://cdn/x.jpg', 'FILEID123', '2026-08-19T07:00:00Z');

  const later = new Date('2026-08-19T08:00:00Z');
  assert.equal(isKnownBadPhoto(db, 'https://cdn/x.jpg', later), false);
  assert.equal(getCachedFileId(db, 'https://cdn/x.jpg', later), 'FILEID123');
});
