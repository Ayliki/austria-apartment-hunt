import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, pairScore, dedupeListings } from '../src/dedupe.js';
import type { NormalizedListing } from '../src/normalize.js';

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
  return {
    source: 'willhaben', id: 'x', url: 'https://example.com/x', title: 'X',
    price: 600, pricePerSqm: 15, area: 40, rooms: 2,
    district: 4, zip: '1040', addressLine: null,
    lat: 48.2, lon: 16.37, isPrivate: false, requiresWaitlistTicket: false,
    images: [], dateCreated: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

test('haversineMeters: same point ~0, known distance sane', () => {
  assert.equal(haversineMeters(48.2, 16.37, 48.2, 16.37), 0);
  // ~111m per 0.001 deg latitude
  const d = haversineMeters(48.2, 16.37, 48.201, 16.37);
  assert.ok(d > 100 && d < 120, `got ${d}`);
});

test('pairScore: same source is never compared', () => {
  const a = listing({ source: 'willhaben' });
  const b = listing({ source: 'willhaben', id: 'y' });
  assert.equal(pairScore(a, b), 0);
});

test('pairScore: clear duplicate scores >= 5', () => {
  // Same flat on both sites: 10m apart, same price, same area -> 3 + 2 + 2 = 7
  const a = listing({ source: 'willhaben' });
  const b = listing({ source: 'immoscout', id: 'y', lat: 48.20005, lon: 16.37005, price: 605, area: 40.5 });
  assert.ok(pairScore(a, b) >= 5, `got ${pairScore(a, b)}`);
});

test('pairScore: clear non-duplicate scores < 5', () => {
  // 2km away, different price and area -> 0
  const a = listing({ source: 'willhaben' });
  const b = listing({ source: 'immoscout', id: 'y', lat: 48.22, lon: 16.37, price: 900, area: 60 });
  assert.ok(pairScore(a, b) < 5, `got ${pairScore(a, b)}`);
});

test('pairScore: missing coordinates caps below threshold', () => {
  // Same price + same area but one side lacks coords -> max 4, no match
  const a = listing({ source: 'willhaben', lat: null, lon: null });
  const b = listing({ source: 'immoscout', id: 'y', price: 600, area: 40 });
  assert.equal(pairScore(a, b), 4);
});

test('dedupeListings merges a matched pair, primary absorbs the other', () => {
  const willhaben = listing({
    source: 'willhaben', id: 'w1', url: 'https://willhaben.at/x',
    dateCreated: '2026-07-25T00:00:00Z', images: ['https://img/1.jpg'],
  });
  const immoscout = listing({
    source: 'immoscout', id: 'i1', url: 'https://immoscout24.at/y',
    lat: 48.20005, lon: 16.37005, price: 605, area: 40.5,
    addressLine: 'Gußhausstraße 1, 1040 Wien', // more complete: has street address
    dateCreated: '2026-07-20T00:00:00Z',
  });
  const unrelated = listing({ source: 'immoscout', id: 'i2', lat: 48.3, lon: 16.4, price: 999, area: 80 });

  const { merged, duplicatePairs } = dedupeListings([willhaben, immoscout, unrelated]);
  assert.equal(duplicatePairs, 1);
  assert.equal(merged.length, 2);
  const primary = merged.find((l) => l.alsoListedOn);
  assert.ok(primary, 'expected one merged listing with alsoListedOn');
  assert.equal(primary!.alsoListedOn!.length, 1);
  assert.deepEqual(
    [primary!.source, primary!.alsoListedOn![0].source].sort(),
    ['immoscout', 'willhaben'],
  );
  // primary is the more complete listing (immoscout: has addressLine)
  assert.equal(primary!.source, 'immoscout');
});

test('dedupeListings leaves distinct listings untouched', () => {
  const a = listing({ source: 'willhaben', id: 'w1' });
  const b = listing({ source: 'immoscout', id: 'i1', lat: 48.3, lon: 16.4, price: 999, area: 80 });
  const { merged, duplicatePairs } = dedupeListings([a, b]);
  assert.equal(duplicatePairs, 0);
  assert.equal(merged.length, 2);
  assert.ok(merged.every((l) => !l.alsoListedOn));
});
