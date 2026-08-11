import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { notifyNewMatches, MAX_PUSH_PER_USER } from '../src/notify.js';
import { openDb, setUserPrefs, MCP_CHAT_ID, type ListingRow } from '../src/db.js';

function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: [],
    description: null, url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
    requiresWaitlistTicket: false,
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
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true });
  const { telegram, calls } = testTelegram();
  await notifyNewMatches(telegram, db, []);
  assert.equal(calls.length, 0);
});

test('notifyNewMatches pushes a matching listing to a user whose prefs it satisfies', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true });
  const { telegram, calls } = testTelegram();

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 700 })]);

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
  assert.match(texts[0] as string, /1 new listing just matched/);
});

test('notifyNewMatches skips a user whose prefs the listing does not satisfy', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 500, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true });
  const { telegram, calls } = testTelegram();

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 900 })]);

  assert.equal(calls.length, 0);
});

test('notifyNewMatches never pushes to the MCP sentinel chat', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: MCP_CHAT_ID, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true });
  const { telegram, calls } = testTelegram();

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 700 })]);

  assert.equal(calls.length, 0);
});

test('notifyNewMatches caps the burst per user and mentions the remainder', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true });
  const { telegram, calls } = testTelegram();

  const matches = Array.from({ length: MAX_PUSH_PER_USER + 3 }, (_, i) => row({ id: `willhaben:${i}`, price: 700 }));
  await notifyNewMatches(telegram, db, matches);

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts[0], new RegExp(`${matches.length} new listings just matched`));
  assert.match(texts.at(-1) as string, /\+3 more — check \/next\./);
  // one card = at least one sendMessage (text-only, no images) per sent listing, capped at MAX_PUSH_PER_USER
  const cardMessages = calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('(no photo)'));
  assert.equal(cardMessages.length, MAX_PUSH_PER_USER);
});

test('notifyNewMatches never pushes municipal/waitlist housing to a user who opted out', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: false });
  const { telegram, calls } = testTelegram();

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 700, requiresWaitlistTicket: true })]);

  assert.equal(calls.length, 0);
});

test('notifyNewMatches sends separate, independent pushes to different matching users', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true });
  setUserPrefs(db, { chatId: 2, priceFrom: null, priceTo: 500, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true });
  const { telegram, calls } = testTelegram();

  await notifyNewMatches(telegram, db, [row({ id: 'willhaben:a', price: 700 })]);

  const chatIds = new Set(calls.map((c) => c.payload.chat_id));
  assert.deepEqual(chatIds, new Set([1])); // only chat 1's budget covers 700
});
