import type { NormalizedListing } from './normalize.js';

/** Band around the result-set median: ±15% separates good / fair / premium. */
export const VALUE_BAND = 0.15;

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function scoreValue(listings: NormalizedListing[]): void {
  const effective = (l: NormalizedListing): number | null =>
    l.pricePerSqm ?? (l.price != null && l.area != null && l.area > 0 ? l.price / l.area : null);

  const values = listings.map(effective).filter((v): v is number => v != null && v > 0);
  if (values.length === 0) return;
  const med = median(values);

  for (const l of listings) {
    const v = effective(l);
    if (v == null || v <= 0) {
      l.valueFlag = null;
      continue;
    }
    l.pricePerSqm = Math.round(v * 100) / 100;
    l.valueFlag = v < med * (1 - VALUE_BAND) ? 'good' : v > med * (1 + VALUE_BAND) ? 'premium' : 'fair';
  }
}
