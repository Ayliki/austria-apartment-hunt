import type { CommuteTimes } from './db.js';

export interface GeoPoint {
  lat: number;
  lon: number;
}

interface GeocodeResponse {
  status: string;
  results: { geometry: { location: { lat: number; lng: number } } }[];
}

/** Geocodes a free-text destination (e.g. "TU Wien") via the Google Geocoding API, biased to Vienna. Returns null if nothing was found. */
export async function geocode(address: string, apiKey: string): Promise<GeoPoint | null> {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', `${address}, Wien, Austria`);
  url.searchParams.set('key', apiKey);
  const res = await fetch(url);
  const data = (await res.json()) as GeocodeResponse;
  if (data.status !== 'OK' || !data.results?.length) return null;
  const { lat, lng } = data.results[0].geometry.location;
  return { lat, lon: lng };
}

const VEHICLE_LABELS: Record<string, string> = {
  BUS: 'bus', TRAM: 'tram', SUBWAY: 'subway', HEAVY_RAIL: 'train', COMMUTER_TRAIN: 'train',
  RAIL: 'train', LIGHT_RAIL: 'tram', FERRY: 'ferry',
};

interface Route {
  duration?: string;
  legs?: { steps?: { transitDetails?: { transitLine?: { nameShort?: string; name?: string; vehicle?: { type?: string } } } }[] }[];
}

interface RoutesResponse {
  routes?: Route[];
}

/** Parses a Routes API duration string like "1234s" into whole minutes, rounded up. */
export function parseDurationMinutes(duration: string | undefined): number | null {
  if (!duration) return null;
  const seconds = Number(duration.replace(/s$/, ''));
  if (!Number.isFinite(seconds)) return null;
  return Math.ceil(seconds / 60);
}

/** First transit line used on the route, formatted like "tram D" or "bus 13A", or null if the route has no transit leg (or none was requested). */
export function firstTransitLineLabel(route: Route | undefined): string | null {
  for (const leg of route?.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const line = step.transitDetails?.transitLine;
      if (!line) continue;
      const vehicleType = line.vehicle?.type;
      const label = (vehicleType && VEHICLE_LABELS[vehicleType]) ?? 'transit';
      const name = line.nameShort ?? line.name;
      return name ? `${label} ${name}` : label;
    }
  }
  return null;
}

async function computeRouteMinutes(
  origin: GeoPoint, destination: GeoPoint, travelMode: 'WALK' | 'TRANSIT', apiKey: string,
): Promise<{ minutes: number | null; transitLine: string | null }> {
  const fieldMask = travelMode === 'TRANSIT'
    ? 'routes.duration,routes.legs.steps.transitDetails.transitLine.nameShort,routes.legs.steps.transitDetails.transitLine.name,routes.legs.steps.transitDetails.transitLine.vehicle.type'
    : 'routes.duration';
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lon } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lon } } },
      travelMode,
      computeAlternativeRoutes: false,
    }),
  });
  if (!res.ok) return { minutes: null, transitLine: null };
  const data = (await res.json()) as RoutesResponse;
  const route = data.routes?.[0];
  if (!route) return { minutes: null, transitLine: null };
  return {
    minutes: parseDurationMinutes(route.duration),
    transitLine: travelMode === 'TRANSIT' ? firstTransitLineLabel(route) : null,
  };
}

/** Computes walk + transit commute times from a listing to a destination. Never throws — API failures degrade to nulls so a card still sends without commute info. */
export async function computeCommute(origin: GeoPoint, destination: GeoPoint, apiKey: string): Promise<CommuteTimes> {
  const [walk, transit] = await Promise.allSettled([
    computeRouteMinutes(origin, destination, 'WALK', apiKey),
    computeRouteMinutes(origin, destination, 'TRANSIT', apiKey),
  ]);
  return {
    walkMinutes: walk.status === 'fulfilled' ? walk.value.minutes : null,
    transitMinutes: transit.status === 'fulfilled' ? transit.value.minutes : null,
    transitSummary: transit.status === 'fulfilled' ? transit.value.transitLine : null,
  };
}

/**
 * Pure — formats a commute line like "🚏 18 min walk · 7 min by tram D to TU Wien" for the card
 * caption. Null if there's nothing to show.
 *
 * 🚏, not 📍: the card's own location line (card.ts) already uses 📍 for the listing's address, and
 * a card with a commute line used to show the pin twice — once for "where the flat is", once for
 * "how to get from it". A transit glyph reads as "how to get there" regardless of whether the line
 * ends up being walk-only, transit-only, or both.
 */
export function formatCommuteLine(times: CommuteTimes, destinationLabel: string): string | null {
  const parts: string[] = [];
  if (times.walkMinutes != null) parts.push(`${times.walkMinutes} min walk`);
  if (times.transitMinutes != null) {
    parts.push(`${times.transitMinutes} min by ${times.transitSummary ?? 'transit'}`);
  }
  if (parts.length === 0) return null;
  return `🚏 ${parts.join(' · ')} to ${destinationLabel}`;
}
