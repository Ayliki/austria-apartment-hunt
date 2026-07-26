import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, scoreValue } from '../src/score.js';
import type { NormalizedListing } from '../src/normalize.js';

function listing(pricePerSqm: number | null, price: number | null = null, area: number | null = null): NormalizedListing {
  return {
    source: 'willhaben', id: Math.random().toString(36).slice(2), url: 'https://x', title: 'X',
    price, pricePerSqm, area, rooms: null, district: null, zip: null, addressLine: null,
    lat: null, lon: null, isPrivate: null, requiresWaitlistTicket: false, images: [], dateCreated: null,
  };
}

test('median of odd and even sets', () => {
  assert.equal(median([1, 5, 3]), 3);
  assert.equal(median([1, 3, 5, 7]), 4);
});

test('scoreValue flags good/fair/premium against the result-set median', () => {
  // median of [10, 12, 14, 20, 8] is 12 -> good < 10.2, premium > 13.8
  const listings = [listing(10), listing(12), listing(14), listing(20), listing(8)];
  scoreValue(listings);
  assert.deepEqual(listings.map((l) => l.valueFlag), ['good', 'fair', 'premium', 'premium', 'good']);
});

test('scoreValue computes €/m² from price/area when missing, nulls otherwise', () => {
  const listings = [listing(null, 600, 40), listing(null)];
  scoreValue(listings);
  assert.equal(listings[0].pricePerSqm, 15);
  assert.equal(listings[0].valueFlag, 'fair'); // single value == its own median
  assert.equal(listings[1].valueFlag, null);
});
