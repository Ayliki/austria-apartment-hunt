import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { notifyNewMatches, MAX_PUSH_PER_USER } from '../src/notify.js';
import { openDb, createSearchProfile, MCP_CHAT_ID, type ListingRow, type CommuteTimes } from '../src/db.js';
import type { ComputeCommuteFn, GeocodeFn } from '../src/bot.js';

const FAKE_COMPUTE_COMMUTE: ComputeCommuteFn = async () => ({ walkMinutes: null, transitMinutes: null, transitSummary: null });
const NEVER_GEOCODE: GeocodeFn = async () => { throw new Error('geocode should not have been called'); };

function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: [],
    description: null, url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
    requiresWaitlistTicket: false, isWg: false, addressLine: null, lat: null, lon: null, isDelisted: false,
    lift: null, parkingSpaces: null, floor: null, energyClass: null, availableFrom: null, mentionsPets: false,
    ...overrides,
  };
}

interface Call { method: string; payload: Record<string, unknown> }

// Same interception point as bot.test.ts: every Telegram instance shares this prototype method.
let activeCalls: Call[] | null = null;
(Telegram.prototype as unknown as { callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown> }).callApi =
  async function callApi(method, payload) {
    if (!activeCalls) throw new Error('callApi invoked outside a test context');
    activeCalls.push({ method, payload });
    if (method === 'sendMediaGroup') return [];
    return { message_id: activeCalls.length, date: 0, chat: { id: (payload.chat_id as number) ?? 0, type: 'private' } };
  };

function testTelegram(): { telegram: Telegram; calls: Call[] } {
  const telegram = new Telegram('test-token');
  const calls: Call[] = [];
  activeCalls = calls;
  return { telegram, calls };
}

test('notifyNewMatches does nothing when there are no new listings', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();
  await notifyNewMatches(telegram, db, [], FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE);
  assert.equal(calls.length, 0);
});

test('notifyNewMatches pushes a matching listing to a user whose prefs it satisfies', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 700 })], FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE);

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
  assert.match(texts[0] as string, /1 new listing just matched/);
});

test('notifyNewMatches skips a user whose prefs the listing does not satisfy', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 500, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 900 })], FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE);

  assert.equal(calls.length, 0);
});

test('notifyNewMatches never pushes to the MCP sentinel chat', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, MCP_CHAT_ID, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 700 })], FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE);

  assert.equal(calls.length, 0);
});

test('notifyNewMatches caps the burst per user and mentions the remainder', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();

  const matches = Array.from({ length: MAX_PUSH_PER_USER + 3 }, (_, i) => row({ id: `willhaben:${i}`, price: 700 }));
  await notifyNewMatches(telegram, db, matches, FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE);

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts[0], new RegExp(`${matches.length} new listings just matched`));
  assert.match(texts.at(-1) as string, /\+3 more — check \/next\./);
  // one card = at least one sendMessage (text-only, no images) per sent listing, capped at MAX_PUSH_PER_USER
  const cardMessages = calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('(no photo)'));
  assert.equal(cardMessages.length, MAX_PUSH_PER_USER);
});

test('notifyNewMatches never pushes municipal/waitlist housing to a user who opted out', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: false, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 700, requiresWaitlistTicket: true })], FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE);

  assert.equal(calls.length, 0);
});

test('notifyNewMatches includes the commute line on a pushed card when the user has a commute destination set', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 });
  const { telegram, calls } = testTelegram();
  const computeCommute: ComputeCommuteFn = async () => ({ walkMinutes: 18, transitMinutes: 7, transitSummary: 'tram D' });

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 700, lat: 48.19, lon: 16.37 })], computeCommute, NEVER_GEOCODE);

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.ok(texts.some((t) => t.includes('18 min walk · 7 min by tram D to TU Wien')));
});

test('notifyNewMatches caches the commute computation across the same (chat, listing) pair', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 });
  const { telegram } = testTelegram();
  let calls = 0;
  const computeCommute: ComputeCommuteFn = async (): Promise<CommuteTimes> => { calls++; return { walkMinutes: 10, transitMinutes: null, transitSummary: null }; };
  const listing = row({ id: 'willhaben:a', price: 700, lat: 48.19, lon: 16.37 });

  await notifyNewMatches(telegram, db, [listing], computeCommute, NEVER_GEOCODE);
  await notifyNewMatches(telegram, db, [listing], computeCommute, NEVER_GEOCODE); // same listing "found new" again — shouldn't recompute

  assert.equal(calls, 1);
});

test('notifyNewMatches sends separate, independent pushes to different matching users', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  createSearchProfile(db, 2, 'Test', { priceFrom: null, priceTo: 500, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 700 })], FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE);

  const chatIds = new Set(calls.map((c) => c.payload.chat_id));
  assert.deepEqual(chatIds, new Set([1])); // only chat 1's budget covers 700
});
