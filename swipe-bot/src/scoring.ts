import type { ListingRow } from './db.js';

export const COLD_START_THRESHOLD = 15;

export type BucketFeature = 'district' | 'price' | 'rooms' | 'area' | 'isPrivate' | 'hasPhotos';

const priceBand = (price: number | null): string => (price == null ? 'unknown' : String(Math.floor(price / 100) * 100));
const areaBand = (area: number | null): string => (area == null ? 'unknown' : String(Math.floor(area / 10) * 10));
const roomBand = (rooms: number | null): string => (rooms == null ? 'unknown' : String(Math.round(rooms)));

export function bucketsFor(l: ListingRow): Record<BucketFeature, string> {
  return {
    district: l.district == null ? 'unknown' : String(l.district),
    price: priceBand(l.price),
    rooms: roomBand(l.rooms),
    area: areaBand(l.area),
    isPrivate: l.isPrivate == null ? 'unknown' : String(l.isPrivate),
    hasPhotos: l.images.length > 0 ? 'yes' : 'no',
  };
}

/** Laplace-smoothed like-rate: neutral (0.5) with no data, converges toward the true rate as swipes accumulate. */
export function bucketScore(likes: number, passes: number): number {
  return (likes + 1) / (likes + passes + 2);
}

export function valueScoreOf(l: ListingRow): number {
  if (l.valueFlag === 'good') return 1;
  if (l.valueFlag === 'premium') return 0;
  return 0.5; // 'fair' or null
}

export type BucketStats = Map<string, { likes: number; passes: number }>;

export function computeBucketStats(swiped: { listing: ListingRow; direction: 'like' | 'pass' }[]): BucketStats {
  const stats: BucketStats = new Map();
  for (const { listing, direction } of swiped) {
    const buckets = bucketsFor(listing);
    for (const [feature, value] of Object.entries(buckets)) {
      const key = `${feature}:${value}`;
      const entry = stats.get(key) ?? { likes: 0, passes: 0 };
      if (direction === 'like') entry.likes++; else entry.passes++;
      stats.set(key, entry);
    }
  }
  return stats;
}

export function learnedScoreOf(l: ListingRow, stats: BucketStats): number {
  const buckets = bucketsFor(l);
  const scores = Object.entries(buckets).map(([feature, value]) => {
    const entry = stats.get(`${feature}:${value}`);
    return entry ? bucketScore(entry.likes, entry.passes) : 0.5;
  });
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

export function rankListings(
  listings: ListingRow[],
  swiped: { listing: ListingRow; direction: 'like' | 'pass' }[],
): ListingRow[] {
  const coldStart = swiped.length < COLD_START_THRESHOLD;
  const stats = coldStart ? null : computeBucketStats(swiped);
  const scored = listings.map((l) => {
    const score = coldStart ? valueScoreOf(l) : 0.6 * learnedScoreOf(l, stats!) + 0.4 * valueScoreOf(l);
    return { listing: l, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.listing);
}
