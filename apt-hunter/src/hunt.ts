import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpConnection, type McpServerSpec } from './mcp-client.js';
import {
  parseWillhabenSearchText,
  parseWillhabenDetailText,
  normalizeWillhaben,
  normalizeImmoscout,
  type NormalizedListing,
} from './normalize.js';

const WILLHABEN_ENRICH_CAP = 30;
const IMMOSCOUT_ENRICH_CAP = 30;

export interface HuntOptions {
  priceFrom?: number;
  priceTo?: number;
  areaFrom?: number;
  areaTo?: number;
  roomsFrom?: number;
  roomsTo?: number;
  districts?: number[];
  location: string;
  maxPages: number;
  /**
   * Lets the caller mark which hits are worth spending an enrichment call on (e.g. "not already in my DB").
   * Without it, enrichment just takes the first `cap` hits in search order — fine for a one-off CLI search,
   * but in a recurring poll that's almost always the same already-known cheapest listings, starving new ones.
   */
  isNewListing?: (source: 'willhaben' | 'immoscout', id: string) => boolean;
}

/**
 * Which ids to spend the enrichment cap on. With no `isNew` predicate, just the first `cap` ids in order
 * (the original one-shot-search behavior). With one, ids `isNew` accepts go first, so a recurring poll's
 * cap is spent on genuinely fresh listings instead of re-confirming ones it has already enriched before —
 * the remainder pads out any leftover cap so it's never wasted.
 */
export function selectEnrichIds(ids: string[], cap: number, isNew?: (id: string) => boolean): Set<string> {
  if (!isNew) return new Set(ids.slice(0, cap));
  const fresh = ids.filter((id) => isNew(id));
  const stale = ids.filter((id) => !isNew(id));
  return new Set([...fresh, ...stale].slice(0, cap));
}

export interface HuntResult {
  listings: NormalizedListing[];
  warnings: string[];
}

function immoscoutSpec(): McpServerSpec {
  const here = dirname(fileURLToPath(import.meta.url)); // apt-hunter/dist
  const entry = process.env.IMMOSCOUT_MCP_PATH ?? resolve(here, '../../immoscout-mcp/dist/index.js');
  return { command: 'node', args: [entry] };
}

/**
 * A vendored, patched copy of the third-party willhaben-mcp (MIT) — the published package
 * hardcodes get_listing's image list to the first 5, capping every card at 5 photos regardless
 * of how many the listing actually has. Patched to Telegram's own sendMediaGroup ceiling of 10
 * instead (see willhaben-mcp-patched/dist/index.js's PATCHED comment). No upstream fix exists as
 * of v1.0.2, the latest published version.
 */
function willhabenSpec(): McpServerSpec {
  const here = dirname(fileURLToPath(import.meta.url)); // apt-hunter/dist
  const entry = process.env.WILLHABEN_MCP_PATH ?? resolve(here, '../../willhaben-mcp-patched/dist/index.js');
  return { command: 'node', args: [entry] };
}

/** willhaben: search pages, district-filter, then enrich each hit with get_listing (coords + images). */
export async function huntWillhaben(opts: HuntOptions): Promise<NormalizedListing[]> {
  const conn = new McpConnection(willhabenSpec());
  await conn.connect();
  try {
    const baseArgs: Record<string, unknown> = {
      property_type: 'mietwohnung',
      action: 'rent',
      location: opts.location,
      sort: 'price_asc',
      rows: 100,
    };
    if (opts.priceFrom != null) baseArgs.price_from = opts.priceFrom;
    if (opts.priceTo != null) baseArgs.price_to = opts.priceTo;
    if (opts.areaFrom != null) baseArgs.area_from = opts.areaFrom;
    if (opts.areaTo != null) baseArgs.area_to = opts.areaTo;
    if (opts.roomsFrom != null) baseArgs.rooms = opts.roomsFrom;

    const hits = [];
    for (let page = 1; page <= opts.maxPages; page++) {
      const text = await conn.callToolText('willhaben_search_real_estate', { ...baseArgs, page });
      const parsed = parseWillhabenSearchText(text);
      hits.push(...parsed);
      if (parsed.length < 100) break; // last page
    }

    const kept = opts.districts?.length
      ? hits.filter((h) => h.district != null && opts.districts!.includes(h.district))
      : hits;

    const enrichIds = selectEnrichIds(
      kept.map((h) => h.id),
      WILLHABEN_ENRICH_CAP,
      opts.isNewListing ? (id) => opts.isNewListing!('willhaben', id) : undefined,
    );

    const out: NormalizedListing[] = [];
    for (const hit of kept) {
      if (!enrichIds.has(hit.id)) {
        out.push(normalizeWillhaben(hit));
        continue;
      }
      let detail;
      try {
        detail = parseWillhabenDetailText(await conn.callToolText('willhaben_get_listing', { id: hit.id }));
      } catch {
        detail = undefined; // enrichment is best-effort; the hit still flows through without coords/images
      }
      out.push(normalizeWillhaben(hit, detail));
    }
    return out;
  } finally {
    await conn.close();
  }
}

/** immoscout: search pages, then enrich each hit with get_listing (full images + description) — mirrors willhaben's enrichment shape. */
export async function huntImmoscout(opts: HuntOptions): Promise<NormalizedListing[]> {
  const conn = new McpConnection(immoscoutSpec());
  await conn.connect();
  try {
    const text = await conn.callToolText('immoscout_search_real_estate', {
      price_from: opts.priceFrom,
      price_to: opts.priceTo,
      area_from: opts.areaFrom,
      area_to: opts.areaTo,
      rooms_from: opts.roomsFrom,
      rooms_to: opts.roomsTo,
      districts: opts.districts,
      max_pages: opts.maxPages,
    });
    const result = JSON.parse(text);
    const hits = result.listings as { exposeId: string }[];

    const enrichIds = selectEnrichIds(
      hits.map((h) => h.exposeId),
      IMMOSCOUT_ENRICH_CAP,
      opts.isNewListing ? (id) => opts.isNewListing!('immoscout', id) : undefined,
    );

    const out: NormalizedListing[] = [];
    for (const hit of hits) {
      if (!enrichIds.has(hit.exposeId)) {
        out.push(normalizeImmoscout(hit));
        continue;
      }
      let detail;
      try {
        detail = JSON.parse(await conn.callToolText('immoscout_get_listing', { id: hit.exposeId }));
      } catch {
        detail = undefined; // enrichment is best-effort; the hit still flows through with its search-result photo only
      }
      out.push(normalizeImmoscout(hit, detail));
    }
    return out;
  } finally {
    await conn.close();
  }
}

/** Pure — combines settled results from both sources into one HuntResult. Unit-tested directly. */
export function combineHuntResults(
  wh: PromiseSettledResult<NormalizedListing[]>,
  is24: PromiseSettledResult<NormalizedListing[]>,
): HuntResult {
  const warnings: string[] = [];
  const willhabenListings = wh.status === 'fulfilled' ? wh.value : [];
  if (wh.status === 'rejected') warnings.push(`willhaben source failed: ${(wh.reason as Error).message}`);
  const immoscoutListings = is24.status === 'fulfilled' ? is24.value : [];
  if (is24.status === 'rejected') warnings.push(`immoscout source failed: ${(is24.reason as Error).message}`);
  return { listings: [...willhabenListings, ...immoscoutListings], warnings };
}

export async function huntBothSources(opts: HuntOptions): Promise<HuntResult> {
  const [wh, is24] = await Promise.allSettled([huntWillhaben(opts), huntImmoscout(opts)]);
  return combineHuntResults(wh, is24);
}
