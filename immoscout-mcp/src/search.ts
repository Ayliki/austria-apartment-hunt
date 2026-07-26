import { extractEmbeddedJson } from './parse.js';
import type { Fetcher } from './fetcher.js';
import type { ImmoscoutSearchHit, ImmoscoutSearchResult } from './types.js';

export interface SearchParams {
  priceFrom?: number;
  priceTo?: number;
  areaFrom?: number;
  areaTo?: number;
  roomsFrom?: number;
  roomsTo?: number;
  /** Vienna districts 1–23; filtered client-side (the site's zipCode param does not work). */
  districts?: number[];
  /** Default 6, hard cap 10. */
  maxPages?: number;
}

const BASE_URL = 'https://www.immobilienscout24.at/regional/wien/wien/wohnung-mieten';
const HARD_PAGE_CAP = 10;

export function buildSearchUrl(params: SearchParams, page: number): string {
  const base = page > 1 ? `${BASE_URL}/seite-${page}` : BASE_URL;
  const q = new URLSearchParams();
  if (params.priceFrom != null) q.set('primaryPriceFrom', String(params.priceFrom));
  if (params.priceTo != null) q.set('primaryPriceTo', String(params.priceTo));
  if (params.areaFrom != null) q.set('primaryAreaFrom', String(params.areaFrom));
  if (params.areaTo != null) q.set('primaryAreaTo', String(params.areaTo));
  if (params.roomsFrom != null) q.set('numberOfRoomsFrom', String(params.roomsFrom));
  if (params.roomsTo != null) q.set('numberOfRoomsTo', String(params.roomsTo));
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Vienna zips are 1XX0 where XX is the district number (1130 -> district 13). */
export function parseZipDistrict(addressString: string | null): { zip: string | null; district: number | null } {
  if (!addressString) return { zip: null, district: null };
  const m = addressString.match(/\b(1\d{3})\b/);
  if (!m) return { zip: null, district: null };
  return { zip: m[1], district: parseInt(m[1].slice(1, 3), 10) };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** "15,28 €/m²" -> 15.28 */
function parsePerSqm(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const n = parseFloat(v.replace(/[^\d,]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapHit(h: any): ImmoscoutSearchHit {
  const { zip, district } = parseZipDistrict(h.addressString ?? null);
  const loc = h.location ?? {};
  const hasCoords = (loc.type === 'POINT' || loc.type === 'CIRCLE') && typeof loc.lat === 'number';
  return {
    exposeId: String(h.exposeId),
    title: typeof h.headline === 'string' ? h.headline : '',
    price: numOrNull(h.primaryPrice),
    pricePerSqm: parsePerSqm(h.pricePerSqmKeyFact?.value),
    area: numOrNull(h.primaryArea),
    rooms: numOrNull(h.numberOfRooms),
    district,
    zip,
    address: typeof h.addressString === 'string' ? h.addressString : null,
    lat: hasCoords ? loc.lat : null,
    lon: hasCoords ? loc.lon : null,
    badges: Array.isArray(h.badges) ? h.badges.map((b: any) => b?.value).filter(Boolean) : [],
    isPrivate: h.isPrivate === true,
    isSocialHousing: h.isSocialHousing === true,
    url: h.links?.absoluteURL ?? `https://www.immobilienscout24.at/expose/${h.exposeId}`,
    imageUrl: h.primaryPictureImageProps?.src ?? null,
    dateCreated: typeof h.dateCreated === 'string' ? h.dateCreated : null,
  };
}

export function parseSearchPage(html: string): { hits: ImmoscoutSearchHit[]; totalHits: number; totalPages: number } {
  const state = extractEmbeddedJson(html, 'window.__INITIAL_STATE__') as any;
  const results = state?.reduxAsyncConnect?.pageData?.results;
  if (!results || !Array.isArray(results.hits)) {
    throw new Error(
      'ImmoScout24 search page structure changed: reduxAsyncConnect.pageData.results.hits not found',
    );
  }
  return {
    hits: results.hits.map(mapHit),
    totalHits: numOrNull(results.totalHits) ?? results.hits.length,
    totalPages: numOrNull(results.pagination?.totalPages) ?? 1,
  };
}

export async function searchRealEstate(fetcher: Fetcher, params: SearchParams): Promise<ImmoscoutSearchResult> {
  const maxPages = Math.min(params.maxPages ?? 6, HARD_PAGE_CAP);
  const matched: ImmoscoutSearchHit[] = [];
  let totalHitsCitywide = 0;
  let totalPagesAvailable = 1;
  let pagesScanned = 0;

  while (pagesScanned < maxPages && pagesScanned < totalPagesAvailable) {
    const html = await fetcher.fetchText(buildSearchUrl(params, pagesScanned + 1));
    const page = parseSearchPage(html);
    totalHitsCitywide = page.totalHits;
    totalPagesAvailable = page.totalPages;
    pagesScanned++;
    for (const hit of page.hits) {
      const districtOk =
        !params.districts || params.districts.length === 0 ||
        (hit.district != null && params.districts.includes(hit.district));
      if (districtOk) matched.push(hit);
    }
  }

  return {
    listings: matched,
    totalHitsCitywide,
    pagesScanned,
    totalPagesAvailable,
    hitPageCap: pagesScanned >= maxPages && pagesScanned < totalPagesAvailable,
  };
}
