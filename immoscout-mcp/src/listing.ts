import { extractEmbeddedJson } from './parse.js';
import type { Fetcher } from './fetcher.js';

export interface ImmoscoutListingDetail {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
  address: string | null;
  street: string | null;
  zip: string | null;
  price: number | null;
  pricePerSqm: number | null;
  deposit: string | null;
  commissionNote: string | null;
  contact: { name: string | null; company: string | null; phone: string | null };
  heating: string | null;
  energyClass: string | null;
  lift: boolean;
  kitchen: boolean;
  parkingSpaces: number;
  availableFrom: string | null;
  rentalPeriod: string | null;
  floor: string | null;
  rooms: number | null;
  areaSqm: number | null;
  transit: string[] | null;
  images: { url: string; caption: string | null }[];
}

/** Strip tags + collapse whitespace: "<p><b>Ruhige</b> Wohnung</p><ul><li>Küche</li></ul>" -> "Ruhige Wohnung Küche" */
function stripHtml(html: string | null): string | null {
  if (!html) return null;
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function findCost(costs: any, keyword: string): string | null {
  const entries = [...(costs?.oneTime ?? []), ...(costs?.running ?? [])];
  for (const c of entries) {
    if (typeof c?.text === 'string' && c.text.includes(keyword)) return c.text;
  }
  return null;
}

function mapTransit(transit: unknown): string[] | null {
  if (!Array.isArray(transit) || transit.length === 0) return null;
  return transit.map((t: any) => t?.text ?? t?.label ?? String(t));
}

export function parseExpose(html: string, id: string): ImmoscoutListingDetail {
  const state = extractEmbeddedJson(html, 'window.__APOLLO_STATE__') as any;
  const key = Object.keys(state).find((k) => k.startsWith('Expose:'));
  if (!key) {
    throw new Error('ImmoScout24 expose structure changed: no Expose:* entity in window.__APOLLO_STATE__');
  }
  const e = state[key];
  return {
    id,
    url: `https://www.immobilienscout24.at/expose/${id}`,
    title: e.description?.title ?? null,
    description: stripHtml(e.description?.descriptionNote ?? null),
    address: e.addressString ?? null,
    street: e.localization?.address?.street ?? null,
    zip: e.localization?.address?.zip ?? null,
    price: e.priceInformation?.primaryPrice ?? null,
    pricePerSqm: e.priceInformation?.prices?.rentPerSquareMeter ?? null,
    deposit: findCost(e.costs, 'Kaution'),
    commissionNote: findCost(e.costs, 'Provision'),
    contact: {
      name: e.contact?.fullName ?? null,
      company: e.contact?.company?.name ?? null,
      phone: e.contact?.contactPhone ?? null,
    },
    heating: (e.condition?.heatingTypes ?? []).map((t: any) => t?.label).filter(Boolean).join(', ') || null,
    energyClass: e.condition?.energyCertification?.heatingDemandClass?.label ?? null,
    lift: (e.fitting?.lift ?? []).length > 0,
    kitchen: (e.fitting?.kitchen ?? []).length > 0,
    parkingSpaces: e.fitting?.numberOfParkingSpaces ?? 0,
    availableFrom: e.object?.availableFrom ?? null,
    rentalPeriod: e.object?.rentalPeriod ? `${e.object.rentalPeriod} ${e.object.rentalPeriodType}` : null,
    floor: e.keyfacts?.floorLabel ?? null,
    rooms: e.area?.numberOfRooms ?? null,
    areaSqm: e.area?.livingArea ?? e.area?.primaryArea ?? null,
    transit: mapTransit(e.localization?.transit),
    images: (e.pictures ?? [])
      .filter((p: any) => typeof p?.url === 'string')
      .map((p: any) => ({ url: p.url, caption: p.caption ?? p.title ?? null })),
  };
}

export async function getListing(fetcher: Fetcher, id: string): Promise<ImmoscoutListingDetail> {
  const html = await fetcher.fetchText(`https://www.immobilienscout24.at/expose/${id}`);
  return parseExpose(html, id);
}
