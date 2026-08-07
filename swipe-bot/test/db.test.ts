import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, upsertListing, listingKey, getUserPrefs, setUserPrefs, getAllUserPrefs,
  recordSwipe, getShortlist, getCandidateListings, getSwipedWithDirection,
} from '../src/db.js';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
  return {
    source: 'willhaben', id: '1', url: 'https://x/1', title: 'Test flat',
    price: 650, pricePerSqm: 15, area: 43, rooms: 2, district: 6, zip: '1060',
    addressLine: null, lat: null, lon: null, isPrivate: true,
    requiresWaitlistTicket: false, images: ['https://img/1.jpg'], dateCreated: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

const defaultPrefs = (chatId: number) => ({
  chatId, priceFrom: null, priceTo: 800, districts: null,
  roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null,
});

test('upsertListing inserts new, ignores duplicate id', () => {
  const db = openDb(':memory:');
  assert.equal(upsertListing(db, listing({ id: '1' })), true);
  assert.equal(upsertListing(db, listing({ id: '1', title: 'changed title' })), false);
  const rows = db.prepare('SELECT title FROM listings WHERE id = ?').all(listingKey(listing({ id: '1' })));
  assert.equal((rows[0] as { title: string }).title, 'Test flat'); // first insert wins, not overwritten
});

test('listingKey namespaces by source', () => {
  assert.equal(listingKey(listing({ source: 'willhaben', id: '1' })), 'willhaben:1');
  assert.equal(listingKey(listing({ source: 'immoscout', id: '1' })), 'immoscout:1');
});

test('setUserPrefs + getUserPrefs round-trip, getAllUserPrefs returns all', () => {
  const db = openDb(':memory:');
  assert.equal(getUserPrefs(db, 42), null);
  setUserPrefs(db, { chatId: 42, priceFrom: 400, priceTo: 800, districts: [6, 7], roomsFrom: 1, roomsTo: 2, areaFrom: 30, areaTo: null });
  const prefs = getUserPrefs(db, 42);
  assert.deepEqual(prefs, { chatId: 42, priceFrom: 400, priceTo: 800, districts: [6, 7], roomsFrom: 1, roomsTo: 2, areaFrom: 30, areaTo: null });
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

  const prefs = { chatId: 1, priceFrom: null, priceTo: 800, districts: [6, 7], roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null };
  const candidates = getCandidateListings(db, 1, prefs);
  assert.deepEqual(candidates.map((c) => c.id), []); // 'cheap' already swiped, 'expensive' over budget, 'wrong-district' filtered
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
