import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOnboardingAnswers, nextCardFor, formatCaption, buildMediaGroup, MAX_MEDIA_GROUP_ITEMS } from '../src/bot.js';
import { openDb, upsertListing, setUserPrefs, recordSwipe, type ListingRow } from '../src/db.js';
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

function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Sunny two-room flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: ['https://img/1.jpg'],
    description: null, url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
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

test('formatCaption includes title, price, size/rooms/district, and the link', () => {
  const caption = formatCaption(row({}));
  assert.match(caption, /Sunny two-room flat/);
  assert.match(caption, /€650/);
  assert.match(caption, /43m²/);
  assert.match(caption, /2 rooms/);
  assert.match(caption, /district 6/);
  assert.match(caption, /https:\/\/x\/1/);
});

test('formatCaption appends the description when present, omits the block when null', () => {
  const withDesc = formatCaption(row({ description: 'Bright and quiet, close to the U-Bahn.' }));
  assert.match(withDesc, /Bright and quiet, close to the U-Bahn\./);

  const withoutDesc = formatCaption(row({ description: null }));
  assert.doesNotMatch(withoutDesc, /\n\n/); // no description block appended at all
});

test('formatCaption truncates to Telegram\'s 1024-char caption limit instead of overflowing', () => {
  const longDescription = 'x'.repeat(2000);
  const caption = formatCaption(row({ description: longDescription }));
  assert.ok(caption.length <= 1024, `caption was ${caption.length} chars`);
  assert.ok(caption.endsWith('…'));
});

test('buildMediaGroup attaches the caption to only the first item', () => {
  const group = buildMediaGroup(['https://img/1.jpg', 'https://img/2.jpg', 'https://img/3.jpg'], 'my caption');
  assert.equal(group.length, 3);
  assert.equal(group[0].caption, 'my caption');
  assert.equal(group[1].caption, undefined);
  assert.equal(group[2].caption, undefined);
  assert.ok(group.every((item) => item.type === 'photo'));
  assert.deepEqual(group.map((item) => item.media), ['https://img/1.jpg', 'https://img/2.jpg', 'https://img/3.jpg']);
});

test('buildMediaGroup caps at Telegram\'s 10-item limit', () => {
  const images = Array.from({ length: 15 }, (_, i) => `https://img/${i}.jpg`);
  const group = buildMediaGroup(images, 'caption');
  assert.equal(group.length, MAX_MEDIA_GROUP_ITEMS);
  assert.deepEqual(group.map((item) => item.media), images.slice(0, MAX_MEDIA_GROUP_ITEMS));
});
