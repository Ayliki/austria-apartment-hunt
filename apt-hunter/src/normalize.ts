export interface NormalizedListing {
  source: 'willhaben' | 'immoscout';
  id: string;
  url: string;
  title: string;
  price: number | null;
  pricePerSqm: number | null;
  area: number | null;
  rooms: number | null;
  district: number | null;
  zip: string | null;
  addressLine: string | null;
  lat: number | null;
  lon: number | null;
  isPrivate: boolean | null;
  requiresWaitlistTicket: boolean;
  images: string[];
  dateCreated: string | null;
  /** Set by score.ts. */
  valueFlag?: 'good' | 'fair' | 'premium' | null;
  /** Set by dedupe.ts on merged primaries. */
  alsoListedOn?: { source: string; url: string }[];
}

export interface WillhabenSearchHit {
  id: string;
  title: string;
  price: number | null;
  location: string | null;
  dateCreated: string | null;
  sellerType: 'private' | 'dealer' | null;
  sellerName: string | null;
  area: number | null;
  rooms: number | null;
  pricePerSqm: number | null;
  url: string;
  zip: string | null;
  district: number | null;
}

export interface WillhabenDetail {
  lat: number | null;
  lon: number | null;
  address: string | null;
  images: string[];
  description: string | null;
}

/**
 * "€ 1.234,56" -> 1234.56 ; "44 m²" -> 44 ; "€ 15,22" -> 15.22.
 * Only pass price/area-style fields (dots = thousands, comma = decimal).
 */
export function parseAustrianNumber(s: string): number | null {
  const cleaned = s.replace(/[^\d.,]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const WAITLIST_RE = /vormerkschein|wohnticket|gemeindewohnung/i;

export function detectWaitlistTicket(title: string): boolean {
  return WAITLIST_RE.test(title);
}

/** "📍 Wien, 02. Bezirk, Leopoldstadt" -> 2 */
function parseBezirk(location: string | null): number | null {
  const m = location?.match(/(\d{1,2})\.\s*Bezirk/);
  return m ? parseInt(m[1], 10) : null;
}

export function parseWillhabenSearchText(text: string): WillhabenSearchHit[] {
  const hits: WillhabenSearchHit[] = [];
  // Hit lines: "**N. TITLE** | 💰 ... | 📍 ... | 📅 ... | 🏢/👤 ... | [🏷️ ...] | 📐 ... | 🛏️ ... | 📊 ... | 🔗 URL"
  const re = /^\*\*\d+\.\s*(.+?)\*\*\s*\|\s*(.+)$/gm;
  for (const m of text.matchAll(re)) {
    const title = m[1].trim();
    const parts = m[2].split('|').map((p) => p.trim());
    let price: number | null = null;
    let location: string | null = null;
    let dateCreated: string | null = null;
    let sellerType: 'private' | 'dealer' | null = null;
    let sellerName: string | null = null;
    let area: number | null = null;
    let rooms: number | null = null;
    let pricePerSqm: number | null = null;
    let url = '';
    for (const p of parts) {
      if (p.startsWith('💰')) price = parseAustrianNumber(p);
      else if (p.startsWith('📍')) location = p.slice('📍'.length).trim();
      else if (p.startsWith('📅')) dateCreated = p.slice('📅'.length).trim();
      else if (p.startsWith('🏢')) sellerType = 'dealer';
      else if (p.startsWith('👤')) sellerType = 'private';
      else if (p.startsWith('🏷️')) sellerName = p.slice('🏷️'.length).trim();
      else if (p.startsWith('📐')) area = parseAustrianNumber(p);
      else if (p.startsWith('🛏️')) rooms = parseAustrianNumber(p);
      else if (p.startsWith('📊')) pricePerSqm = parseAustrianNumber(p);
      else if (p.startsWith('🔗')) url = p.slice('🔗'.length).trim();
    }
    const zip = url.match(/wien-(\d{4})-/)?.[1] ?? null;
    const id = url.match(/-(\d+)\/?$/)?.[1] ?? '';
    if (!id || !url) continue; // not a real hit line
    hits.push({
      id, title, price, location, dateCreated, sellerType, sellerName,
      area, rooms, pricePerSqm, url, zip,
      district: parseBezirk(location),
    });
  }
  return hits;
}

export function parseWillhabenDetailText(text: string): WillhabenDetail {
  const coords = text.match(/📍 \*\*Coordinates:\*\*\s*([-\d.]+)\s*,\s*([-\d.]+)/);
  const address = text.match(/🏠 \*\*Address:\*\*\s*(.+)/);
  const images: string[] = [];
  const imgSection = text.split(/^## Images/m)[1];
  if (imgSection) {
    for (const line of imgSection.split('\n')) {
      const t = line.trim();
      if (t.startsWith('http')) images.push(t);
      else if (t.startsWith('... and') || t.startsWith('## ')) break;
    }
  }
  return {
    lat: coords ? parseFloat(coords[1]) : null,
    lon: coords ? parseFloat(coords[2]) : null,
    address: address?.[1]?.trim() ?? null,
    images,
    description: null, // free-text body is often absent on willhaben; not needed for the report
  };
}

export function normalizeWillhaben(hit: WillhabenSearchHit, detail?: WillhabenDetail): NormalizedListing {
  return {
    source: 'willhaben',
    id: hit.id,
    url: hit.url,
    title: hit.title,
    price: hit.price,
    pricePerSqm: hit.pricePerSqm,
    area: hit.area,
    rooms: hit.rooms,
    district: hit.district,
    zip: hit.zip,
    addressLine: detail?.address ?? hit.location,
    lat: detail?.lat ?? null,
    lon: detail?.lon ?? null,
    isPrivate: hit.sellerType == null ? null : hit.sellerType === 'private',
    requiresWaitlistTicket: detectWaitlistTicket(hit.title),
    images: detail?.images ?? [],
    dateCreated: hit.dateCreated,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizeImmoscout(raw: any): NormalizedListing {
  return {
    source: 'immoscout',
    id: String(raw.exposeId),
    url: raw.url ?? `https://www.immobilienscout24.at/expose/${raw.exposeId}`,
    title: raw.title ?? '',
    price: raw.price ?? null,
    pricePerSqm: raw.pricePerSqm ?? null,
    area: raw.area ?? null,
    rooms: raw.rooms ?? null,
    district: raw.district ?? null,
    zip: raw.zip ?? null,
    addressLine: raw.address ?? null,
    lat: raw.lat ?? null,
    lon: raw.lon ?? null,
    isPrivate: typeof raw.isPrivate === 'boolean' ? raw.isPrivate : null,
    requiresWaitlistTicket: raw.isSocialHousing === true,
    images: raw.imageUrl ? [raw.imageUrl] : [],
    dateCreated: raw.dateCreated ?? null,
  };
}
