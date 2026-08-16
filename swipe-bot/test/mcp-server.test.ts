import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCardPayload, mapPrefsArgs, handleSetPrefs, MCP_CHAT_ID, type McpDeps } from '../src/mcp-server.js';
import { openDb, getActiveSearchProfile, type ListingRow } from '../src/db.js';

const NEVER_GEOCODE_DEPS: McpDeps = {
  geocode: async () => { throw new Error('geocode should not have been called'); },
  computeCommute: async () => { throw new Error('computeCommute should not have been called'); },
};

function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: ['https://img/1.jpg', 'https://img/2.jpg'],
    description: 'A lovely flat.', url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
    requiresWaitlistTicket: false, isWg: false, lat: null, lon: null, addressLine: null, isDelisted: false,
    lift: null, parkingSpaces: null, floor: null, energyClass: null, availableFrom: null, mentionsPets: false,
    ...overrides,
  };
}

test('MCP_CHAT_ID is a fixed sentinel that can never collide with a real Telegram chat id', () => {
  assert.equal(MCP_CHAT_ID, 0);
});

test('formatCardPayload exposes id, title, price, area, rooms, district, url, images, description, valueFlag, requiresWaitlistTicket, isWg, commute', () => {
  const payload = formatCardPayload(row({}));
  assert.deepEqual(payload, {
    id: 'willhaben:1', title: 'Flat', price: 650, area: 43, rooms: 2, district: 6,
    url: 'https://x/1', images: ['https://img/1.jpg', 'https://img/2.jpg'],
    description: 'A lovely flat.', valueFlag: 'fair', requiresWaitlistTicket: false, isWg: false, commute: null,
  });
});

test('formatCardPayload includes the commute line when given one', () => {
  const payload = formatCardPayload(row({}), '📍 18 min walk · 7 min by tram D to TU Wien');
  assert.equal(payload.commute, '📍 18 min walk · 7 min by tram D to TU Wien');
});

test('formatCardPayload passes through nulls as-is (no fabricated defaults)', () => {
  const payload = formatCardPayload(row({ price: null, area: null, rooms: null, district: null, description: null, valueFlag: null }));
  assert.equal(payload.price, null);
  assert.equal(payload.area, null);
  assert.equal(payload.rooms, null);
  assert.equal(payload.district, null);
  assert.equal(payload.description, null);
  assert.equal(payload.valueFlag, null);
});

test('formatCardPayload surfaces requiresWaitlistTicket so Claude can flag municipal/waitlist housing', () => {
  assert.equal(formatCardPayload(row({ requiresWaitlistTicket: true })).requiresWaitlistTicket, true);
});

test('formatCardPayload surfaces isWg so Claude can flag shared-flat/co-living/student-room listings', () => {
  assert.equal(formatCardPayload(row({ isWg: true })).isWg, true);
});

test('mapPrefsArgs maps structured MCP args to SearchProfilePrefs, defaulting missing optional bounds to null, waitlist housing to included, WG listings to excluded, and elevator/parking to not required', () => {
  const prefs = mapPrefsArgs({ price_to: 800, districts: [6, 7] });
  assert.deepEqual(prefs, {
    priceTo: 800, priceFrom: null, districts: [6, 7], roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null,
    includeWaitlistHousing: true, includeWg: false, requireElevator: false, requireParking: false,
  });
});

test('mapPrefsArgs passes through all bounds when fully specified', () => {
  const prefs = mapPrefsArgs({
    price_to: 800, price_from: 400, districts: [1, 2], rooms_from: 1, rooms_to: 2, area_from: 30, area_to: 60,
    include_waitlist_housing: false, include_wg: true, require_elevator: true, require_parking: true,
  });
  assert.deepEqual(prefs, {
    priceTo: 800, priceFrom: 400, districts: [1, 2], roomsFrom: 1, roomsTo: 2, areaFrom: 30, areaTo: 60,
    includeWaitlistHousing: false, includeWg: true, requireElevator: true, requireParking: true,
  });
});

test('handleSetPrefs persists require_elevator (and require_parking, price_to) via upsertActiveProfilePrefs, readable back through getActiveSearchProfile', async () => {
  const db = openDb(':memory:');

  const result = await handleSetPrefs(db, NEVER_GEOCODE_DEPS, {
    price_to: 900,
    require_elevator: true,
    require_parking: true,
  });

  assert.equal(result.isError, undefined);
  const profile = getActiveSearchProfile(db, MCP_CHAT_ID);
  assert.ok(profile);
  assert.equal(profile!.prefs.requireElevator, true);
  assert.equal(profile!.prefs.requireParking, true);
  assert.equal(profile!.prefs.priceTo, 900);
});

test('handleSetPrefs defaults require_elevator/require_parking to false when omitted, and geocodes commute_destination', async () => {
  const db = openDb(':memory:');
  const deps: McpDeps = {
    geocode: async (address) => (address === 'TU Wien' ? { lat: 48.1986, lon: 16.3695 } : null),
    computeCommute: NEVER_GEOCODE_DEPS.computeCommute,
  };

  const result = await handleSetPrefs(db, deps, { price_to: 700, commute_destination: 'TU Wien' });

  assert.equal(result.isError, undefined);
  const profile = getActiveSearchProfile(db, MCP_CHAT_ID);
  assert.equal(profile!.prefs.requireElevator, false);
  assert.equal(profile!.prefs.requireParking, false);
  assert.equal(profile!.prefs.commuteDestination, 'TU Wien');
  assert.equal(profile!.prefs.commuteLat, 48.1986);
  assert.equal(profile!.prefs.commuteLon, 16.3695);
});

test('handleSetPrefs returns an error result and persists nothing when the commute destination fails to geocode', async () => {
  const db = openDb(':memory:');
  const deps: McpDeps = { geocode: async () => null, computeCommute: NEVER_GEOCODE_DEPS.computeCommute };

  const result = await handleSetPrefs(db, deps, { price_to: 700, commute_destination: 'nonsense place' });

  assert.equal(result.isError, true);
  assert.equal(getActiveSearchProfile(db, MCP_CHAT_ID), null);
});
