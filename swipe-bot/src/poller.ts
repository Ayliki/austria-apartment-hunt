import { huntBothSources, type HuntOptions } from 'apt-hunter/dist/hunt.js';
import { dedupeListings } from 'apt-hunter/dist/dedupe.js';
import { scoreValue } from 'apt-hunter/dist/score.js';
import { type DB, type UserPrefs, getAllUserPrefs, upsertListing } from './db.js';

/** Loosest bound across all users — never restricts a poll to less than any single user needs. */
export function widestFilter(allPrefs: UserPrefs[]): HuntOptions | null {
  if (allPrefs.length === 0) return null;

  const priceFrom = allPrefs.some((p) => p.priceFrom == null) ? undefined : Math.min(...allPrefs.map((p) => p.priceFrom!));
  const priceTo = allPrefs.some((p) => p.priceTo == null) ? undefined : Math.max(...allPrefs.map((p) => p.priceTo!));
  const areaFrom = allPrefs.some((p) => p.areaFrom == null) ? undefined : Math.min(...allPrefs.map((p) => p.areaFrom!));
  const areaTo = allPrefs.some((p) => p.areaTo == null) ? undefined : Math.max(...allPrefs.map((p) => p.areaTo!));
  const roomsFrom = allPrefs.some((p) => p.roomsFrom == null) ? undefined : Math.min(...allPrefs.map((p) => p.roomsFrom!));
  const roomsTo = allPrefs.some((p) => p.roomsTo == null) ? undefined : Math.max(...allPrefs.map((p) => p.roomsTo!));

  const districts = allPrefs.some((p) => p.districts == null)
    ? undefined
    : [...new Set(allPrefs.flatMap((p) => p.districts!))].sort((a, b) => a - b);

  return { priceFrom, priceTo, areaFrom, areaTo, roomsFrom, roomsTo, districts, location: 'Wien', maxPages: 6 };
}

export async function runPoll(db: DB, opts: { maxPages?: number } = {}): Promise<{ inserted: number; warnings: string[] }> {
  const allPrefs = getAllUserPrefs(db);
  const filter = widestFilter(allPrefs);
  if (!filter) return { inserted: 0, warnings: [] };
  if (opts.maxPages != null) filter.maxPages = opts.maxPages;

  const { listings, warnings } = await huntBothSources(filter);
  const { merged } = dedupeListings(listings);
  scoreValue(merged);

  let inserted = 0;
  for (const l of merged) {
    if (upsertListing(db, l)) inserted++;
  }
  return { inserted, warnings };
}
