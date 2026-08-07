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

const WILLHABEN_SPEC: McpServerSpec = { command: 'npx', args: ['-y', 'willhaben-mcp'] };

/** willhaben: search pages, district-filter, then enrich each hit with get_listing (coords + images). */
export async function huntWillhaben(opts: HuntOptions): Promise<NormalizedListing[]> {
  const conn = new McpConnection(WILLHABEN_SPEC);
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

    const out: NormalizedListing[] = [];
    for (const hit of kept.slice(0, WILLHABEN_ENRICH_CAP)) {
      let detail;
      try {
        detail = parseWillhabenDetailText(await conn.callToolText('willhaben_get_listing', { id: hit.id }));
      } catch {
        detail = undefined; // enrichment is best-effort; the hit still flows through without coords/images
      }
      out.push(normalizeWillhaben(hit, detail));
    }
    for (const hit of kept.slice(WILLHABEN_ENRICH_CAP)) out.push(normalizeWillhaben(hit));
    return out;
  } finally {
    await conn.close();
  }
}

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
    return (result.listings as unknown[]).map(normalizeImmoscout);
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
