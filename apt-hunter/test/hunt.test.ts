import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineHuntResults } from '../src/hunt.js';
import type { NormalizedListing } from '../src/normalize.js';

function listing(id: string): NormalizedListing {
  return {
    source: 'willhaben', id, url: `https://x/${id}`, title: id,
    price: null, pricePerSqm: null, area: null, rooms: null, district: null,
    zip: null, addressLine: null, lat: null, lon: null, isPrivate: null,
    requiresWaitlistTicket: false, images: [], dateCreated: null,
  };
}

test('combineHuntResults concatenates listings when both sources succeed', () => {
  const wh: PromiseSettledResult<NormalizedListing[]> = { status: 'fulfilled', value: [listing('a')] };
  const is24: PromiseSettledResult<NormalizedListing[]> = { status: 'fulfilled', value: [listing('b')] };
  const result = combineHuntResults(wh, is24);
  assert.deepEqual(result.listings.map((l) => l.id), ['a', 'b']);
  assert.deepEqual(result.warnings, []);
});

test('combineHuntResults keeps the successful source and warns about the failed one', () => {
  const wh: PromiseSettledResult<NormalizedListing[]> = { status: 'rejected', reason: new Error('blocked') };
  const is24: PromiseSettledResult<NormalizedListing[]> = { status: 'fulfilled', value: [listing('b')] };
  const result = combineHuntResults(wh, is24);
  assert.deepEqual(result.listings.map((l) => l.id), ['b']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /willhaben source failed: blocked/);
});

test('combineHuntResults returns empty listings with two warnings when both fail', () => {
  const wh: PromiseSettledResult<NormalizedListing[]> = { status: 'rejected', reason: new Error('a') };
  const is24: PromiseSettledResult<NormalizedListing[]> = { status: 'rejected', reason: new Error('b') };
  const result = combineHuntResults(wh, is24);
  assert.deepEqual(result.listings, []);
  assert.equal(result.warnings.length, 2);
});
