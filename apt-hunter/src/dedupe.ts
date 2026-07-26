import type { NormalizedListing } from './normalize.js';

export const DEFAULT_DEDUP_THRESHOLD = 5;

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Cross-source duplicate score. Same-source pairs always score 0 — a source
 * is assumed internally consistent, matching only ever happens across sources.
 * Without coordinates on either side the max score is 4 (< threshold), so
 * coord-less listings can never be auto-merged.
 */
export function pairScore(a: NormalizedListing, b: NormalizedListing): number {
  if (a.source === b.source) return 0;
  let score = 0;

  if (a.lat != null && a.lon != null && b.lat != null && b.lon != null) {
    const d = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    if (d < 60) score += 3;
    else if (d < 150) score += 1;
  }
  if (a.price != null && b.price != null && Math.max(a.price, b.price) > 0) {
    const rel = Math.abs(a.price - b.price) / Math.max(a.price, b.price);
    if (rel < 0.03) score += 2;
    else if (rel < 0.08) score += 1;
  }
  if (a.area != null && b.area != null) {
    const da = Math.abs(a.area - b.area);
    if (da < 2) score += 2;
    else if (da < 5) score += 1;
  }
  return score;
}

/** Rough completeness: which listing carries more usable data. */
function completeness(l: NormalizedListing): number {
  let n = 0;
  for (const v of [l.price, l.pricePerSqm, l.area, l.rooms, l.district, l.zip, l.addressLine, l.lat, l.lon, l.dateCreated]) {
    if (v != null) n++;
  }
  if (l.images.length > 0) n++;
  return n;
}

function pickPrimary(group: NormalizedListing[]): NormalizedListing {
  return [...group].sort((x, y) => {
    const c = completeness(y) - completeness(x);
    if (c !== 0) return c;
    return (x.dateCreated ?? '9999').localeCompare(y.dateCreated ?? '9999');
  })[0];
}

export function dedupeListings(
  listings: NormalizedListing[],
  threshold: number = DEFAULT_DEDUP_THRESHOLD,
): { merged: NormalizedListing[]; duplicatePairs: number } {
  // Union-find over matched pairs.
  const parent = listings.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => { parent[find(i)] = find(j); };

  for (let i = 0; i < listings.length; i++) {
    for (let j = i + 1; j < listings.length; j++) {
      if (pairScore(listings[i], listings[j]) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, NormalizedListing[]>();
  listings.forEach((l, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), l]);
  });

  const merged: NormalizedListing[] = [];
  let duplicatePairs = 0;
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const primary = pickPrimary(group);
    primary.alsoListedOn = group
      .filter((l) => l !== primary)
      .map((l) => ({ source: l.source, url: l.url }));
    duplicatePairs += group.length - 1;
    merged.push(primary);
  }
  return { merged, duplicatePairs };
}
