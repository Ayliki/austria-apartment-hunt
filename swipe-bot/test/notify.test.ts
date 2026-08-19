import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';
import { dispatchInstant, dispatchDigests, formatPushEntry } from '../src/notify.js';
import {
  openDb, createSearchProfile, upsertListing, updateNotifySettings, MCP_CHAT_ID, type ListingRow,
} from '../src/db.js';

const NOW_MIDDAY = new Date('2026-08-19T10:00:00Z'); // 12:00 Vienna, outside quiet hours
const NOW_NIGHT = new Date('2026-08-19T23:30:00Z'); // 01:30 Vienna, inside quiet hours

function commuteProfilePrefs(overrides: Partial<Parameters<typeof createSearchProfile>[3]> = {}) {
  return {
    priceFrom: null, priceTo: 2000, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null,
    includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false,
    commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695,
    ...overrides,
  };
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

/** Storable twin of `row` — upsertListing takes apt-hunter's NormalizedListing, not a ListingRow. */
function listing(overrides: Partial<NormalizedListing & { firstSeen: string }> = {}): NormalizedListing {
  return {
    source: 'willhaben', id: '1', url: 'https://x/1', title: 'Flat',
    price: 650, pricePerSqm: 15, area: 43, rooms: 2, district: 6, zip: '1060',
    addressLine: null, lat: null, lon: null, isPrivate: true,
    requiresWaitlistTicket: false, isShortTerm: false, isWg: false, images: [], description: null,
    dateCreated: '2026-08-01T00:00:00Z', valueFlag: 'fair',
    lift: null, parkingSpaces: null, floor: null, energyClass: null, availableFrom: null, mentionsPets: false,
    ...overrides,
  };
}

interface Call { method: string; payload: Record<string, unknown> }

// Same interception point as bot.test.ts: every Telegram instance shares this prototype method.
let activeCalls: Call[] | null = null;
let nextResult: ((method: string, payload: Record<string, unknown>) => unknown) | null = null;
(Telegram.prototype as unknown as { callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown> }).callApi =
  async function callApi(method, payload) {
    if (!activeCalls) throw new Error('callApi invoked outside a test context');
    activeCalls.push({ method, payload });
    const result = nextResult?.(method, payload);
    if (result instanceof Error) throw result;
    if (result !== undefined) return result;
    if (method === 'sendMediaGroup') return [];
    return { message_id: activeCalls.length, date: 0, chat: { id: (payload.chat_id as number) ?? 0, type: 'private' } };
  };

function testTelegram(
  result?: (method: string, payload: Record<string, unknown>) => unknown,
): { telegram: Telegram; calls: Call[] } {
  const telegram = new Telegram('test-token');
  const calls: Call[] = [];
  activeCalls = calls;
  nextResult = result ?? null;
  return { telegram, calls };
}

/** Seeds `count` scored listings into the profile's trailing window so instantThreshold has a sample. */
function seedHistory(db: ReturnType<typeof openDb>, count: number): void {
  for (let i = 0; i < count; i++) {
    upsertListing(db, listing({
      id: `willhaben:hist${i}`, price: 600, valueFlag: 'fair',
      firstSeen: '2026-08-15T00:00:00Z', url: `https://x/hist${i}`,
    }));
  }
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

test('dispatchInstant sends nothing for a paused profile', async () => {
  const db = openDb(':memory:');
  const profileId = createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null })).id;
  updateNotifySettings(db, profileId, { paused: true });
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'good' })], NOW_MIDDAY);

  assert.equal(calls.length, 0);
});

test('dispatchInstant sends nothing during quiet hours', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'good' })], NOW_NIGHT);

  assert.equal(calls.length, 0);
});

test('dispatchInstant sends exactly one photo message for a top match', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'good', images: ['https://cdn/a.jpg'] })], NOW_MIDDAY);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendPhoto');
});

test('dispatchInstant never sends an album, however many photos a listing has', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({
    id: 'willhaben:new', valueFlag: 'good',
    images: ['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg'],
  })], NOW_MIDDAY);

  assert.ok(!calls.some((c) => c.method === 'sendMediaGroup'));
});

test('dispatchInstant skips listings that are not flagged good value', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'premium' })], NOW_MIDDAY);

  assert.equal(calls.length, 0);
});

test('dispatchInstant stops at the daily cap', async () => {
  const db = openDb(':memory:');
  const profileId = createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null })).id;
  updateNotifySettings(db, profileId, { dailyCap: 2 });
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [
    row({ id: 'willhaben:n1', valueFlag: 'good', url: 'https://x/1' }),
    row({ id: 'willhaben:n2', valueFlag: 'good', url: 'https://x/2' }),
    row({ id: 'willhaben:n3', valueFlag: 'good', url: 'https://x/3' }),
  ], NOW_MIDDAY);

  assert.equal(calls.length, 2);
});

test('dispatchInstant never sends the same listing twice', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);
  const hot = row({ id: 'willhaben:new', valueFlag: 'good' });

  const first = testTelegram();
  await dispatchInstant(first.telegram, db, [hot], NOW_MIDDAY);
  const second = testTelegram();
  await dispatchInstant(second.telegram, db, [hot], NOW_MIDDAY);

  assert.equal(second.calls.length, 0);
});

test('dispatchInstant never touches the MCP sentinel chat', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, MCP_CHAT_ID, 'MCP', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'good' })], NOW_MIDDAY);

  assert.equal(calls.length, 0);
});

test('a failing send for one profile does not stop the next profile', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'A', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  createSearchProfile(db, 2, 'B', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);

  const { telegram, calls } = testTelegram((method, payload) =>
    method === 'sendPhoto' && payload.chat_id === 1 ? new Error('blocked by user') : undefined);

  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'good', images: ['https://cdn/a.jpg'] })], NOW_MIDDAY);

  assert.ok(calls.some((c) => c.payload.chat_id === 2), 'profile B must still be notified');
});

test('dispatchDigests sends one text message summarising unsent matches', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  upsertListing(db, listing({ id: 'd1', price: 700, url: 'https://x/d1' }));
  upsertListing(db, listing({ id: 'd2', price: 750, url: 'https://x/d2' }));

  const { telegram, calls } = testTelegram();
  await dispatchDigests(telegram, db, new Date('2026-08-19T07:05:00Z')); // 09:05 Vienna

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
  assert.match(String(calls[0].payload.text), /2/);
});

test('dispatchDigests sends nothing when no digest hour is due', async () => {
  const db = openDb(':memory:');
  const profileId = createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null })).id;
  updateNotifySettings(db, profileId, { lastDigestAt: '2026-08-19T07:01:00Z' });
  upsertListing(db, listing({ id: 'd1' }));

  const { telegram, calls } = testTelegram();
  await dispatchDigests(telegram, db, new Date('2026-08-19T12:05:00Z')); // 14:05 Vienna

  assert.equal(calls.length, 0);
});

test('dispatchDigests sends nothing when there is nothing new', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));

  const { telegram, calls } = testTelegram();
  await dispatchDigests(telegram, db, new Date('2026-08-19T07:05:00Z'));

  assert.equal(calls.length, 0);
});

test('a listing sent instantly is not repeated in the digest', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedHistory(db, 30);
  // Stored id is `${source}:${id}`, so this row is the same listing the instant ping records.
  upsertListing(db, listing({ id: 'hot', valueFlag: 'good', url: 'https://x/hot' }));
  const hot = row({ id: 'willhaben:hot', valueFlag: 'good', url: 'https://x/hot' });

  const first = testTelegram();
  await dispatchInstant(first.telegram, db, [hot], NOW_MIDDAY);

  const second = testTelegram();
  await dispatchDigests(second.telegram, db, new Date('2026-08-19T17:05:00Z')); // 19:05 Vienna

  const text = second.calls.map((c) => String(c.payload.text ?? '')).join('\n');
  assert.ok(!text.includes('https://x/hot'), 'an instantly-sent listing must not reappear in the digest');
});
