import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { notifyNewMatches, MAX_PUSH_PER_USER, PUSH_STAGGER_MS, formatPushEntry, type DelayFn } from '../src/notify.js';
import { openDb, createSearchProfile, MCP_CHAT_ID, type ListingRow } from '../src/db.js';
import type { ComputeCommuteFn, GeocodeFn } from '../src/bot.js';

const FAKE_COMPUTE_COMMUTE: ComputeCommuteFn = async () => ({ walkMinutes: null, transitMinutes: null, transitSummary: null });
const WORKING_COMPUTE_COMMUTE: ComputeCommuteFn = async () => ({ walkMinutes: 18, transitMinutes: 7, transitSummary: 'tram D' });
const NEVER_GEOCODE: GeocodeFn = async () => { throw new Error('geocode should not have been called'); };

function commuteProfilePrefs(overrides: Partial<Parameters<typeof createSearchProfile>[2]> = {}) {
  return {
    priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null,
    includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false,
    commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695,
    ...overrides,
  };
}

/** Injectable no-op delay so tests don't actually sleep PUSH_STAGGER_MS per assertion. */
function noSleepDelay(): { delay: DelayFn; calls: number[] } {
  const calls: number[] = [];
  const delay: DelayFn = async (ms) => { calls.push(ms); };
  return { delay, calls };
}

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

test('formatPushEntry formats title, price, size/rooms/district, and link on separate lines', () => {
  const text = formatPushEntry(row({ title: 'Nice flat', price: 700, area: 50, rooms: 2, district: 6, url: 'https://x/a' }));
  assert.equal(text, 'Nice flat\n€700 · 50m² · 2 rooms · district 6\nhttps://x/a');
});

test('formatPushEntry falls back gracefully when price/area/rooms/district are missing, without a dangling separator', () => {
  const text = formatPushEntry(row({ title: 'Mystery flat', price: null, area: null, rooms: null, district: null, url: 'https://x/b' }));
  assert.equal(text, 'Mystery flat\nprice n/a\nhttps://x/b');
});

test('formatPushEntry appends a commute line when one is supplied', () => {
  const text = formatPushEntry(
    row({ title: 'Nice flat', price: 700, area: 50, rooms: 2, district: 6, url: 'https://x/a' }),
    '18 min walk · 7 min by tram D to TU Wien',
  );
  assert.equal(text, 'Nice flat\n€700 · 50m² · 2 rooms · district 6\n18 min walk · 7 min by tram D to TU Wien\nhttps://x/a');
});

test('notifyNewMatches does nothing when there are no new listings', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();
  await notifyNewMatches(telegram, db, [], FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE);
  assert.equal(calls.length, 0);
});

test('notifyNewMatches sends one header plus a full swipe card per shown listing', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();

  const matches = Array.from({ length: 3 }, (_, i) => row({ id: `willhaben:${i}`, price: 700, images: ['https://img/1.jpg'] }));
  const { delay } = noSleepDelay();
  await notifyNewMatches(telegram, db, matches, FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE, delay);

  const sendMessageCalls = calls.filter((c) => c.method === 'sendMessage');
  const sendPhotoCalls = calls.filter((c) => c.method === 'sendPhoto');
  assert.equal(sendMessageCalls.length, 1); // header only
  assert.equal(sendPhotoCalls.length, 3); // one full card per listing
  assert.match(sendMessageCalls[0].payload.text as string, /🏠 Test — 3 new matches:/);
  for (const c of sendPhotoCalls) {
    assert.match(c.payload.caption as string, /€700/);
    const keyboard = (c.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] });
    assert.ok(keyboard.inline_keyboard.some((r) => r.some((b) => b.callback_data.startsWith('like:') || b.callback_data.startsWith('pass:'))), 'each card has 👍/👎 buttons');
  }
});

test('notifyNewMatches caps each profile at MAX_PUSH_PER_USER matches shown, with a "+N more" note', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();

  const matches = Array.from({ length: MAX_PUSH_PER_USER + 3 }, (_, i) => row({ id: `willhaben:${i}`, price: 700, images: ['https://img/1.jpg'] }));
  const { delay } = noSleepDelay();
  await notifyNewMatches(telegram, db, matches, FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE, delay);

  const sendMessageCalls = calls.filter((c) => c.method === 'sendMessage');
  const sendPhotoCalls = calls.filter((c) => c.method === 'sendPhoto');
  assert.equal(sendPhotoCalls.length, MAX_PUSH_PER_USER); // capped number of full cards
  assert.equal(sendMessageCalls.length, 2); // header + "+N more"
  assert.match(sendMessageCalls[0].payload.text as string, new RegExp(`${matches.length} new matches`));
  assert.match(sendMessageCalls.at(-1)!.payload.text as string, /\+3 more — check \/next\./);
});

test('notifyNewMatches header includes the profile name so multi-profile users know which search matched', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Cheap flats', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null }, false);
  createSearchProfile(db, 1, 'District 6 only', { priceFrom: null, priceTo: 2000, districts: [6], roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null }, false);
  const { telegram, calls } = testTelegram();

  const matches = [row({ id: 'willhaben:a', price: 700, district: 6 })];
  const { delay } = noSleepDelay();
  await notifyNewMatches(telegram, db, matches, FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE, delay);

  const headers = calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).startsWith('🏠')).map((c) => c.payload.text as string);
  assert.equal(headers.length, 2);
  assert.ok(headers.some((h) => h.includes('Cheap flats')));
  assert.ok(headers.some((h) => h.includes('District 6 only')));
});

test('notifyNewMatches staggers sends across profiles by PUSH_STAGGER_MS to avoid Telegram flood-control', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'First', { priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null }, false);
  createSearchProfile(db, 1, 'Second', { priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null }, false);
  createSearchProfile(db, 1, 'Third', { priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null }, false);
  const { telegram } = testTelegram();

  const matches = [row({ id: 'willhaben:a', price: 700 })];
  const { delay, calls: delayCalls } = noSleepDelay();
  await notifyNewMatches(telegram, db, matches, FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE, delay);

  // 3 matching profiles -> delay called once per profile after the first (2 times), each PUSH_STAGGER_MS
  assert.deepEqual(delayCalls, [PUSH_STAGGER_MS, PUSH_STAGGER_MS]);
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

test('notifyNewMatches never pushes municipal/waitlist housing to a user who opted out', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: false, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 700, requiresWaitlistTicket: true })], FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE);

  assert.equal(calls.length, 0);
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

test('notifyNewMatches keeps polling and pushing for inactive (non-current) saved searches, not just the active one', async () => {
  const db = openDb(':memory:');
  // Two profiles for the same chat; the second one deactivates the first (only one profile can be
  // active at a time per createSearchProfile's default makeActive=true), mirroring a user who has
  // switched their "current" search in /searches without deleting the old one.
  createSearchProfile(db, 1, 'Old search', { priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  createSearchProfile(db, 1, 'New search', { priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { telegram, calls } = testTelegram();

  const { delay } = noSleepDelay();
  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 700 })], FAKE_COMPUTE_COMMUTE, NEVER_GEOCODE, delay);

  const headers = calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).startsWith('🏠')).map((c) => c.payload.text as string);
  assert.ok(headers.some((h) => h.includes('Old search')), 'inactive/non-current profile should still be pushed to');
  assert.ok(headers.some((h) => h.includes('New search')));
});

test('notifyNewMatches includes each listing\'s commute line when the profile has a commute destination configured', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Commuter', commuteProfilePrefs());
  const { telegram, calls } = testTelegram();

  const matches = [row({ id: 'willhaben:a', price: 700, lat: 48.2, lon: 16.37, images: ['https://img/1.jpg'] })];
  await notifyNewMatches(telegram, db, matches, WORKING_COMPUTE_COMMUTE, NEVER_GEOCODE);

  const listingMessages = calls.filter((c) => c.method === 'sendPhoto');
  assert.equal(listingMessages.length, 1);
  assert.match(listingMessages[0].payload.caption as string, /📍 18 min walk · 7 min by tram D to TU Wien/);
});

test('notifyNewMatches degrades a single listing to no commute line on a Routes failure, without aborting the rest of the push', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Commuter', commuteProfilePrefs());
  const { telegram, calls } = testTelegram();

  const failingComputeCommute: ComputeCommuteFn = async () => { throw new Error('Routes API down'); };
  const matches = [
    row({ id: 'willhaben:a', price: 700, lat: 48.2, lon: 16.37, images: ['https://img/1.jpg'] }),
    row({ id: 'willhaben:b', price: 750, lat: 48.21, lon: 16.38, images: ['https://img/2.jpg'] }),
  ];
  await notifyNewMatches(telegram, db, matches, failingComputeCommute, NEVER_GEOCODE);

  const sendPhotoCalls = calls.filter((c) => c.method === 'sendPhoto');
  assert.equal(sendPhotoCalls.length, 2, 'the push loop must complete despite the Routes failure');
  for (const c of sendPhotoCalls) {
    const caption = c.payload.caption as string;
    assert.ok(/€700|€750/.test(caption));
    assert.doesNotMatch(caption, /📍/, 'no commute line should appear when the Routes call fails');
  }
});
