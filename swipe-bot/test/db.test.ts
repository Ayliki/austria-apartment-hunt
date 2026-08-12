import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, upsertListing, listingKey, getUserPrefs, setUserPrefs, getAllUserPrefs,
  recordSwipe, getShortlist, getCandidateListings, getSwipedWithDirection,
  getListingsByIds, matchesPrefs, getCommuteTimes, setCommuteTimes, type ListingRow,
} from '../src/db.js';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
  return {
    source: 'willhaben', id: '1', url: 'https://x/1', title: 'Test flat',
    price: 650, pricePerSqm: 15, area: 43, rooms: 2, district: 6, zip: '1060',
    addressLine: null, lat: null, lon: null, isPrivate: true,
    requiresWaitlistTicket: false, isShortTerm: false, images: ['https://img/1.jpg'], description: 'A lovely flat.',
    dateCreated: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

const defaultPrefs = (chatId: number) => ({
  chatId, priceFrom: null, priceTo: 800, districts: null,
  roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true,
  commuteDestination: null, commuteLat: null, commuteLon: null,
});

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

test('upsertListing persists description, getCandidateListings round-trips it', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6, description: 'Sunny two-room flat near the park.' }));
  const prefs = { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, commuteDestination: null, commuteLat: null, commuteLon: null };
  const [row] = getCandidateListings(db, 1, prefs);
  assert.equal(row.description, 'Sunny two-room flat near the park.');
});

test('upsertListing stores null description as null, not the string "null"', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6, description: null }));
  const prefs = { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, commuteDestination: null, commuteLat: null, commuteLon: null };
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
  const prefs = { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, commuteDestination: null, commuteLat: null, commuteLon: null };
  const [row] = getCandidateListings(migrated, 1, prefs);
  assert.equal(row.description, 'Migrated fine.');
  migrated.close();
});

test('openDb migrates an older database predating requires_waitlist_ticket / include_waitlist_housing, defaulting existing rows to the pre-migration behavior (everything shown)', () => {
  const path = `/tmp/swipe-bot-migration-test-waitlist-${Date.now()}.sqlite`;
  const preMigration = openDb(path);
  upsertListing(preMigration, listing({ id: 'a', district: 6 }));
  setUserPrefs(preMigration, defaultPrefs(1));
  preMigration.exec('ALTER TABLE listings DROP COLUMN requires_waitlist_ticket');
  preMigration.exec('ALTER TABLE user_prefs DROP COLUMN include_waitlist_housing');
  preMigration.close();

  const migrated = openDb(path);
  assert.equal(getUserPrefs(migrated, 1)!.includeWaitlistHousing, true); // pre-migration behavior: nothing was ever filtered out
  const [row] = getCandidateListings(migrated, 1, defaultPrefs(1));
  assert.equal(row.requiresWaitlistTicket, false);
  migrated.close();
});

test('openDb migrates an older database predating listings.lat/lon and user_prefs.commute_destination', () => {
  const path = `/tmp/swipe-bot-migration-test-commute-${Date.now()}.sqlite`;
  const preMigration = openDb(path);
  upsertListing(preMigration, listing({ id: 'a', district: 6, lat: 48.19, lon: 16.37 }));
  setUserPrefs(preMigration, { ...defaultPrefs(1), commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 });
  preMigration.exec('ALTER TABLE listings DROP COLUMN lat');
  preMigration.exec('ALTER TABLE listings DROP COLUMN lon');
  preMigration.exec('ALTER TABLE user_prefs DROP COLUMN commute_destination');
  preMigration.exec('ALTER TABLE user_prefs DROP COLUMN commute_lat');
  preMigration.exec('ALTER TABLE user_prefs DROP COLUMN commute_lon');
  preMigration.close();

  const migrated = openDb(path);
  const prefs = getUserPrefs(migrated, 1)!;
  assert.equal(prefs.commuteDestination, null); // the old value is gone — the column itself was dropped — but reopening must not throw
  upsertListing(migrated, listing({ id: 'b', district: 6, lat: 48.2, lon: 16.4 }));
  const candidates = getCandidateListings(migrated, 1, defaultPrefs(1));
  assert.equal(candidates.find((c) => c.id === 'willhaben:b')!.lat, 48.2);
  migrated.close();
});

test('listingKey namespaces by source', () => {
  assert.equal(listingKey(listing({ source: 'willhaben', id: '1' })), 'willhaben:1');
  assert.equal(listingKey(listing({ source: 'immoscout', id: '1' })), 'immoscout:1');
});

test('setUserPrefs + getUserPrefs round-trip, getAllUserPrefs returns all', () => {
  const db = openDb(':memory:');
  assert.equal(getUserPrefs(db, 42), null);
  setUserPrefs(db, { chatId: 42, priceFrom: 400, priceTo: 800, districts: [6, 7], roomsFrom: 1, roomsTo: 2, areaFrom: 30, areaTo: null, includeWaitlistHousing: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const prefs = getUserPrefs(db, 42);
  assert.deepEqual(prefs, { chatId: 42, priceFrom: 400, priceTo: 800, districts: [6, 7], roomsFrom: 1, roomsTo: 2, areaFrom: 30, areaTo: null, includeWaitlistHousing: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  setUserPrefs(db, defaultPrefs(99));
  assert.equal(getAllUserPrefs(db).length, 2);
});

test('setUserPrefs overwrites on re-call (same chatId)', () => {
  const db = openDb(':memory:');
  setUserPrefs(db, defaultPrefs(1));
  setUserPrefs(db, { ...defaultPrefs(1), priceTo: 900 });
  assert.equal(getUserPrefs(db, 1)!.priceTo, 900);
  assert.equal(getAllUserPrefs(db).length, 1);
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

test('getCandidateListings excludes already-swiped and filters by prefs', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'cheap', price: 500, district: 6 }));
  upsertListing(db, listing({ id: 'expensive', price: 2000, district: 6 }));
  upsertListing(db, listing({ id: 'wrong-district', price: 500, district: 20 }));
  recordSwipe(db, 1, 'willhaben:cheap', 'pass');

  const prefs = { chatId: 1, priceFrom: null, priceTo: 800, districts: [6, 7], roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, commuteDestination: null, commuteLat: null, commuteLon: null };
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
    requiresWaitlistTicket: false, lat: null, lon: null,
    ...overrides,
  };
}

test('matchesPrefs: a null listing field always passes price/area/rooms bounds', () => {
  const prefs = { chatId: 1, priceFrom: 500, priceTo: 800, districts: null, roomsFrom: 1, roomsTo: 3, areaFrom: 30, areaTo: 60 , includeWaitlistHousing: true, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(matchesPrefs(row({ price: null, area: null, rooms: null }), prefs), true);
});

test('matchesPrefs: an out-of-range price/area/rooms fails', () => {
  const prefs = { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(matchesPrefs(row({ price: 900 }), prefs), false);
  assert.equal(matchesPrefs(row({ price: 700 }), prefs), true);
});

test('matchesPrefs: a null district FAILS a district restriction (mirrors the SQL IN clause, no OR-NULL escape hatch)', () => {
  const prefs = { chatId: 1, priceFrom: null, priceTo: null, districts: [6, 7], roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(matchesPrefs(row({ district: null }), prefs), false);
  assert.equal(matchesPrefs(row({ district: 6 }), prefs), true);
  assert.equal(matchesPrefs(row({ district: 9 }), prefs), false);
});

test('matchesPrefs: unrestricted prefs (all null) match anything', () => {
  const prefs = { chatId: 1, priceFrom: null, priceTo: null, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null , includeWaitlistHousing: true, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(matchesPrefs(row({ price: 5000, area: 5, rooms: 10, district: 23 }), prefs), true);
});

test('matchesPrefs: includeWaitlistHousing false excludes municipal/waitlist housing, true includes it', () => {
  const prefs = { chatId: 1, priceFrom: null, priceTo: null, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: false, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(matchesPrefs(row({ requiresWaitlistTicket: true }), prefs), false);
  assert.equal(matchesPrefs(row({ requiresWaitlistTicket: false }), prefs), true);
  assert.equal(matchesPrefs(row({ requiresWaitlistTicket: true }), { ...prefs, includeWaitlistHousing: true }), true);
});

test('setUserPrefs + getUserPrefs round-trips a commute destination', () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { ...defaultPrefs(1), commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 });
  const prefs = getUserPrefs(db, 1);
  assert.equal(prefs!.commuteDestination, 'TU Wien');
  assert.equal(prefs!.commuteLat, 48.1986);
  assert.equal(prefs!.commuteLon, 16.3695);
});

test('upsertListing persists lat/lon, getCandidateListings round-trips them', () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6, lat: 48.19, lon: 16.37 }));
  const [candidate] = getCandidateListings(db, 1, defaultPrefs(1));
  assert.equal(candidate.lat, 48.19);
  assert.equal(candidate.lon, 16.37);
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

test('commute cache is per (chat, listing) — independent across both users and listings', () => {
  const db = openDb(':memory:');
  setCommuteTimes(db, 1, 'willhaben:a', { walkMinutes: 10, transitMinutes: null, transitSummary: null });
  setCommuteTimes(db, 2, 'willhaben:a', { walkMinutes: 30, transitMinutes: null, transitSummary: null });
  assert.equal(getCommuteTimes(db, 1, 'willhaben:a')!.walkMinutes, 10);
  assert.equal(getCommuteTimes(db, 2, 'willhaben:a')!.walkMinutes, 30);
});
