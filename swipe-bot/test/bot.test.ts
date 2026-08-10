import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOnboardingAnswers, nextCardFor } from '../src/bot.js';
import { openDb, upsertListing, setUserPrefs, recordSwipe } from '../src/db.js';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
  return {
    source: 'willhaben', id: '1', url: 'https://x/1', title: 'Flat',
    price: 650, pricePerSqm: 15, area: 43, rooms: 2, district: 6, zip: '1060',
    addressLine: null, lat: null, lon: null, isPrivate: true,
    requiresWaitlistTicket: false, images: [], description: null, dateCreated: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

test('parseOnboardingAnswers parses budget, districts, rooms, size answers', () => {
  const prefs = parseOnboardingAnswers(['800', '400', '1-9', '1-2', '30-60']);
  assert.deepEqual(prefs, {
    priceTo: 800, priceFrom: 400, districts: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    roomsFrom: 1, roomsTo: 2, areaFrom: 30, areaTo: 60,
  });
});

test('parseOnboardingAnswers treats "skip"/"any" as unbounded for optional answers', () => {
  const prefs = parseOnboardingAnswers(['800', 'skip', 'any', 'any', 'any']);
  assert.deepEqual(prefs, {
    priceTo: 800, priceFrom: null, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null,
  });
});

test('parseOnboardingAnswers rejects a non-numeric required budget', () => {
  assert.throws(() => parseOnboardingAnswers(['not a number', 'skip', 'any', 'any', 'any']), /budget/i);
});

test('nextCardFor returns null when the candidate queue is empty', () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null });
  assert.equal(nextCardFor(db, 1), null);
});

test('nextCardFor returns the top-ranked candidate, excluding already-swiped', () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null });
  upsertListing(db, listing({ id: 'a', price: 500 }));
  upsertListing(db, listing({ id: 'b', price: 700 }));
  recordSwipe(db, 1, 'willhaben:a', 'pass');
  const card = nextCardFor(db, 1);
  assert.equal(card!.id, 'willhaben:b');
});
