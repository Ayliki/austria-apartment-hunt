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
  isShortTerm: boolean;
  isWg: boolean;
  images: string[];
  description: string | null;
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

// Deliberately excludes bare "kurzfristig" — "kurzfristig beziehbar/verfügbar" commonly means
// "available soon", describing move-in timing on an ordinary long-term listing, not lease length.
// Only phrases that unambiguously describe the tenancy itself as short-stay are matched.
const SHORT_TERM_RE =
  /notfallwohnung|kurzzeitmiete|kurzzeitvermietung|zwischenmiete|ferienwohnung|feriendomizil|boardinghouse|serviced apartment|tageweise|wochenweise|pro nacht|pro tag|zur kurzfristigen nutzung|auf zeit vermietet/i;

/** Below this €/m² floor, a "monthly" price is almost certainly a mismarked nightly/weekly rate — genuine Vienna long-term rents don't go this low. */
const IMPLAUSIBLE_MONTHLY_PRICE_PER_SQM = 3;

/**
 * Detects nightly/weekly/vacation-style rentals mixed in among long-term listings — by title
 * phrasing, or by an implausibly low price for the size (a strong independent signal that the
 * price is a per-night rate mislabeled as monthly rent).
 */
export function detectShortTerm(title: string, price: number | null, area: number | null): boolean {
  if (SHORT_TERM_RE.test(title)) return true;
  if (price != null && area != null && area > 0 && price / area < IMPLAUSIBLE_MONTHLY_PRICE_PER_SQM) return true;
  return false;
}

// Phrases that describe a whole apartment as merely *suitable* for a WG, not a room being let
// within one — stripped before matching so they can't trigger a false positive below.
const WG_SUITABLE_RE = /wg-geeignet|wg-tauglich|wg-fähig|statt\s+wg/gi;

// Only matches after WG_SUITABLE_RE has stripped the "suitable for" phrasing above.
const WG_RE = /\bwg\b|wg-zimmer|\d+er-wg|wohngemeinschaft|co-living|studenten(zimmer|-wg)|studentinnen(zimmer|-wg)/i;

/**
 * Detects a room in a shared flat (WG-Zimmer), a co-living room, or a student room — title only,
 * since descriptions routinely mention "ideal für eine Studenten-WG" about ordinary whole flats.
 */
export function detectWG(title: string): boolean {
  return WG_RE.test(title.replace(WG_SUITABLE_RE, ''));
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
  // willhaben-mcp only emits "## Description" when the advertiser filled in
  // the BODY_DYN attribute — absent on many listings, that's a data gap on
  // willhaben's side, not something this parser can fabricate around.
  const descSection = text.split(/^## Description\s*$/m)[1];
  const description = descSection
    ? descSection.split(/^## /m)[0].trim() || null
    : null;
  return {
    lat: coords ? parseFloat(coords[1]) : null,
    lon: coords ? parseFloat(coords[2]) : null,
    address: address?.[1]?.trim() ?? null,
    images,
    description,
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
    isShortTerm: detectShortTerm(hit.title, hit.price, hit.area),
    isWg: detectWG(hit.title),
    images: detail?.images ?? [],
    description: detail?.description ?? null,
    dateCreated: hit.dateCreated,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `raw` is one hit from immoscout_search_real_estate (one photo, no description).
 * `detail`, if supplied, is the immoscout_get_listing JSON for the same id
 * (full images + description) — mirrors willhaben's search-then-enrich shape.
 */
export function normalizeImmoscout(raw: any, detail?: any): NormalizedListing {
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
    isShortTerm: detectShortTerm(raw.title ?? '', raw.price ?? null, raw.area ?? null),
    isWg: detectWG(raw.title ?? ''),
    images: detail?.images
      ? detail.images.map((i: { url: string }) => i.url)
      : raw.imageUrl ? [raw.imageUrl] : [],
    description: detail?.description ?? null,
    dateCreated: raw.dateCreated ?? null,
  };
}
