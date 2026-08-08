import { test } from 'node:test';
import assert from 'node:assert/strict';
import { widestFilter } from '../src/poller.js';
import type { UserPrefs } from '../src/db.js';

function prefs(overrides: Partial<UserPrefs>): UserPrefs {
  return { chatId: 1, priceFrom: null, priceTo: null, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, ...overrides };
}

test('widestFilter returns null when there are no users yet', () => {
  assert.equal(widestFilter([]), null);
});

test('widestFilter takes the loosest bound across all users (unbounded wins)', () => {
  const filter = widestFilter([
    prefs({ chatId: 1, priceTo: 700, priceFrom: 300 }),
    prefs({ chatId: 2, priceTo: 1200, priceFrom: null }),
  ]);
  assert.equal(filter!.priceTo, 1200); // widest upper bound
  assert.equal(filter!.priceFrom, undefined); // any user with no lower bound means no lower bound overall
});

test('widestFilter unions districts across users; any user with no district restriction means no restriction', () => {
  const filter = widestFilter([
    prefs({ chatId: 1, districts: [6, 7] }),
    prefs({ chatId: 2, districts: [9] }),
  ]);
  assert.deepEqual(filter!.districts, [6, 7, 9]);

  const unrestricted = widestFilter([
    prefs({ chatId: 1, districts: [6, 7] }),
    prefs({ chatId: 2, districts: null }),
  ]);
  assert.equal(unrestricted!.districts, undefined);
});

test('widestFilter takes min roomsFrom / max roomsTo, min areaFrom / max areaTo across users', () => {
  const filter = widestFilter([
    prefs({ chatId: 1, roomsFrom: 2, roomsTo: 3, areaFrom: 40, areaTo: 60 }),
    prefs({ chatId: 2, roomsFrom: 1, roomsTo: 4, areaFrom: 30, areaTo: 80 }),
  ]);
  assert.equal(filter!.roomsFrom, 1);
  assert.equal(filter!.roomsTo, 4);
  assert.equal(filter!.areaFrom, 30);
  assert.equal(filter!.areaTo, 80);
});

test('widestFilter always sets location=Wien and a generous maxPages', () => {
  const filter = widestFilter([prefs({})]);
  assert.equal(filter!.location, 'Wien');
  assert.ok(filter!.maxPages >= 6);
});
