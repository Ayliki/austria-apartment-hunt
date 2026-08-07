import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketsFor, bucketScore, computeBucketStats, valueScoreOf, learnedScoreOf, rankListings, COLD_START_THRESHOLD,
} from '../src/scoring.js';
import type { ListingRow } from '../src/db.js';

function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: ['https://img/1.jpg'],
    url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

test('bucketsFor buckets price into €100 bands, area into 10m² bands, rooms rounded', () => {
  const b = bucketsFor(row({ price: 650, area: 43, rooms: 2 }));
  assert.equal(b.price, '600');
  assert.equal(b.area, '40');
  assert.equal(b.rooms, '2');
  assert.equal(b.district, '6');
  assert.equal(b.isPrivate, 'true');
  assert.equal(b.hasPhotos, 'yes');
});

test('bucketsFor falls back to "unknown" for null fields', () => {
  const b = bucketsFor(row({ price: null, area: null, rooms: null, district: null, isPrivate: null, images: [] }));
  assert.equal(b.price, 'unknown');
  assert.equal(b.area, 'unknown');
  assert.equal(b.rooms, 'unknown');
  assert.equal(b.district, 'unknown');
  assert.equal(b.isPrivate, 'unknown');
  assert.equal(b.hasPhotos, 'no');
});

test('bucketScore is Laplace-smoothed: neutral at 0/0, grows toward 1 with likes', () => {
  assert.equal(bucketScore(0, 0), 0.5);
  assert.equal(bucketScore(1, 0), 2 / 3);
  assert.equal(bucketScore(0, 1), 1 / 3);
  assert.equal(bucketScore(9, 1), 10 / 12);
});

test('valueScoreOf maps valueFlag to 0-1', () => {
  assert.equal(valueScoreOf(row({ valueFlag: 'good' })), 1);
  assert.equal(valueScoreOf(row({ valueFlag: 'fair' })), 0.5);
  assert.equal(valueScoreOf(row({ valueFlag: 'premium' })), 0);
  assert.equal(valueScoreOf(row({ valueFlag: null })), 0.5);
});

test('computeBucketStats tallies likes/passes per bucket value across swipe history', () => {
  const swiped = [
    { listing: row({ district: 6 }), direction: 'like' as const },
    { listing: row({ district: 6 }), direction: 'like' as const },
    { listing: row({ district: 9 }), direction: 'pass' as const },
  ];
  const stats = computeBucketStats(swiped);
  assert.deepEqual(stats.get('district:6'), { likes: 2, passes: 0 });
  assert.deepEqual(stats.get('district:9'), { likes: 0, passes: 1 });
});

test('learnedScoreOf averages bucket scores, defaulting unseen buckets to 0.5', () => {
  // Swiped listing deliberately differs from the queried row in every field but district,
  // so only the district:6 bucket has recorded stats — the other five buckets stay unseen (0.5).
  const swiped = row({ district: 6, price: 999, area: 999, rooms: 99, isPrivate: false, images: [] });
  const stats = computeBucketStats([{ listing: swiped, direction: 'like' as const }]);
  // district:6 has 1 like -> 2/3; every other bucket (price, rooms, area, isPrivate, hasPhotos) unseen -> 0.5
  const score = learnedScoreOf(row({ district: 6 }), stats);
  const expected = (2 / 3 + 0.5 * 5) / 6;
  assert.ok(Math.abs(score - expected) < 1e-9, `got ${score}, expected ${expected}`);
});

test('rankListings uses value score alone below the cold-start threshold', () => {
  const good = row({ id: 'a', valueFlag: 'good' });
  const premium = row({ id: 'b', valueFlag: 'premium' });
  const fewSwipes = Array.from({ length: COLD_START_THRESHOLD - 1 }, () => ({ listing: row({ district: 6 }), direction: 'pass' as const }));
  const ranked = rankListings([premium, good], fewSwipes);
  assert.deepEqual(ranked.map((l) => l.id), ['a', 'b']); // good (score 1) beats premium (score 0)
});

test('rankListings blends learned + value score once past cold-start threshold', () => {
  // Both listings have identical (neutral) value scores so the test isolates the learned-score effect —
  // with opposing value flags, the 0.4-weighted value term would swamp the 0.6-weighted learned signal.
  const likedDistrict = row({ id: 'liked', district: 6, valueFlag: 'fair' }); // user has liked district 6 every time
  const dislikedDistrict = row({ id: 'disliked', district: 9, valueFlag: 'fair' }); // user has passed district 9 every time
  const manySwipes = [
    ...Array.from({ length: 10 }, () => ({ listing: row({ district: 6 }), direction: 'like' as const })),
    ...Array.from({ length: 10 }, () => ({ listing: row({ district: 9 }), direction: 'pass' as const })),
  ];
  const ranked = rankListings([dislikedDistrict, likedDistrict], manySwipes);
  assert.deepEqual(ranked.map((l) => l.id), ['liked', 'disliked']);
});
