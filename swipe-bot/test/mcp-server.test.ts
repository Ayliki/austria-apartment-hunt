import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCardPayload, mapPrefsArgs, MCP_CHAT_ID } from '../src/mcp-server.js';
import type { ListingRow } from '../src/db.js';

function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: ['https://img/1.jpg', 'https://img/2.jpg'],
    description: 'A lovely flat.', url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

test('MCP_CHAT_ID is a fixed sentinel that can never collide with a real Telegram chat id', () => {
  assert.equal(MCP_CHAT_ID, 0);
});

test('formatCardPayload exposes id, title, price, area, rooms, district, url, images, description, valueFlag', () => {
  const payload = formatCardPayload(row({}));
  assert.deepEqual(payload, {
    id: 'willhaben:1', title: 'Flat', price: 650, area: 43, rooms: 2, district: 6,
    url: 'https://x/1', images: ['https://img/1.jpg', 'https://img/2.jpg'],
    description: 'A lovely flat.', valueFlag: 'fair',
  });
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

test('mapPrefsArgs maps structured MCP args to UserPrefs, defaulting missing optional bounds to null', () => {
  const prefs = mapPrefsArgs({ price_to: 800, districts: [6, 7] });
  assert.deepEqual(prefs, {
    priceTo: 800, priceFrom: null, districts: [6, 7], roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null,
  });
});

test('mapPrefsArgs passes through all bounds when fully specified', () => {
  const prefs = mapPrefsArgs({
    price_to: 800, price_from: 400, districts: [1, 2], rooms_from: 1, rooms_to: 2, area_from: 30, area_to: 60,
  });
  assert.deepEqual(prefs, {
    priceTo: 800, priceFrom: 400, districts: [1, 2], roomsFrom: 1, roomsTo: 2, areaFrom: 30, areaTo: 60,
  });
});
