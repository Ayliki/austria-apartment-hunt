import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';
import { dispatchInstant, dispatchDigests, formatPushEntry, MAX_DIGEST_LINES } from '../src/notify.js';
import {
  openDb, createSearchProfile, upsertListing, updateNotifySettings, getNotifySettings,
  getNotifiedListingIds, recordSwipe, MCP_CHAT_ID, type DB, type ListingRow,
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

/**
 * The only way a test can control `first_seen`: upsertListing hardcodes wall-clock now, and
 * NormalizedListing has no such field, so any fixture value is silently discarded. Without this the
 * trailing-30-day window in recentScoresFor is untestable.
 */
function setFirstSeen(db: DB, listingId: string, iso: string): void {
  const result = db.prepare('UPDATE listings SET first_seen = ? WHERE id = ?').run(iso, listingId);
  assert.equal(result.changes, 1, `setFirstSeen matched no row for ${listingId}`);
}

/** Seeds `count` scored listings into the profile's trailing window so instantThreshold has a sample. */
function seedHistory(db: DB, count: number): void {
  for (let i = 0; i < count; i++) {
    // Bare id: upsertListing stores `${source}:${id}`, so a `willhaben:` prefix here would double up.
    upsertListing(db, listing({
      id: `hist${i}`, price: 600, valueFlag: 'fair', url: `https://x/hist${i}`,
    }));
    setFirstSeen(db, `willhaben:hist${i}`, '2026-08-15T00:00:00Z');
  }
}

/**
 * 15 swipes (the cold-start threshold) that split every bucket cleanly: `HISTORY_SHAPE` is liked
 * 10x, `CANDIDATE_SHAPE` passed 5x. Scoring therefore ranks a HISTORY_SHAPE 'fair' listing at 0.75
 * and a CANDIDATE_SHAPE 'good' one at ~0.486 — the only arrangement in which the relative threshold,
 * rather than the absolute valueFlag bar, decides the outcome.
 */
const HISTORY_SHAPE = { district: 1, price: 500, rooms: 1, area: 30, isPrivate: true, images: ['https://cdn/h.jpg'] };
const CANDIDATE_SHAPE = { district: 6, price: 900, rooms: 3, area: 70, isPrivate: false, images: [] };

function seedLearnedSwipes(db: DB, chatId: number): void {
  for (let i = 0; i < 10; i++) {
    upsertListing(db, listing({ ...HISTORY_SHAPE, id: `like${i}`, url: `https://x/like${i}` }));
    recordSwipe(db, chatId, `willhaben:like${i}`, 'like');
  }
  for (let i = 0; i < 5; i++) {
    upsertListing(db, listing({ ...CANDIDATE_SHAPE, id: `pass${i}`, url: `https://x/pass${i}` }));
    recordSwipe(db, chatId, `willhaben:pass${i}`, 'pass');
  }
}

/** Digits in the digest's first line — the header's count, isolated from listing details below it. */
function headerDigits(text: unknown): string[] {
  return String(text).split('\n')[0].match(/\d+/g) ?? [];
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

  // No images on purpose: sendPhotoCached swallows Telegram errors and degrades to text, so an error
  // injected there never reaches dispatchInstant's try/catch and this test could not fail. The
  // image-less path calls telegram.sendMessage directly, where a rejection really does propagate.
  const { telegram, calls } = testTelegram((method, payload) =>
    method === 'sendMessage' && payload.chat_id === 1 ? new Error('blocked by user') : undefined);

  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'good', images: [] })], NOW_MIDDAY);

  assert.ok(calls.some((c) => c.payload.chat_id === 1), 'profile A must have been attempted');
  assert.ok(calls.some((c) => c.payload.chat_id === 2), 'profile B must still be notified');
});

test('dispatchInstant still applies the absolute value bar when history is too thin for a threshold', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  // Below MIN_THRESHOLD_SAMPLE (20), so instantThreshold returns null and only the valueFlag bar is
  // left standing. Without that bar a 'premium' listing would ping.
  seedHistory(db, 5);

  const { telegram, calls } = testTelegram();
  await dispatchInstant(telegram, db, [row({ id: 'willhaben:new', valueFlag: 'premium' })], NOW_MIDDAY);

  assert.equal(calls.length, 0);
});

test('the instant threshold sample ignores listings first seen more than 30 days ago', async () => {
  const candidate = row({ ...CANDIDATE_SHAPE, id: 'willhaben:new', url: 'https://x/new', valueFlag: 'good' });

  // Control: the same 25 rows inside the window do form a sample, and it blocks the candidate.
  const inWindow = openDb(':memory:');
  createSearchProfile(inWindow, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedLearnedSwipes(inWindow, 1);
  for (let i = 0; i < 25; i++) {
    upsertListing(inWindow, listing({ ...HISTORY_SHAPE, id: `w${i}`, url: `https://x/w${i}` }));
    setFirstSeen(inWindow, `willhaben:w${i}`, '2026-08-15T00:00:00Z'); // 4 days before NOW_MIDDAY
  }

  const blocked = testTelegram();
  await dispatchInstant(blocked.telegram, inWindow, [candidate], NOW_MIDDAY);
  assert.equal(blocked.calls.length, 0, 'a recent sample must produce a threshold the candidate fails');

  // Same rows, first seen 60 days ago: they must fall outside the window, leaving fewer than
  // MIN_THRESHOLD_SAMPLE scores, so instantThreshold returns null and the candidate goes through.
  const outOfWindow = openDb(':memory:');
  createSearchProfile(outOfWindow, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }));
  seedLearnedSwipes(outOfWindow, 1);
  for (let i = 0; i < 25; i++) {
    upsertListing(outOfWindow, listing({ ...HISTORY_SHAPE, id: `w${i}`, url: `https://x/w${i}` }));
    setFirstSeen(outOfWindow, `willhaben:w${i}`, '2026-06-20T00:00:00Z'); // 60 days before NOW_MIDDAY
  }

  const sent = testTelegram();
  await dispatchInstant(sent.telegram, outOfWindow, [candidate], NOW_MIDDAY);
  assert.equal(sent.calls.length, 1, 'stale rows must not count toward the threshold sample');
});

test('dispatchDigests sends one text message summarising unsent matches', async () => {
  const db = openDb(':memory:');
  const profileId = createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null })).id;
  updateNotifySettings(db, profileId, { lastDigestAt: '2026-08-18T17:05:00Z' }); // not the first-ever run
  upsertListing(db, listing({ id: 'd1', price: 700, url: 'https://x/d1' }));
  upsertListing(db, listing({ id: 'd2', price: 750, url: 'https://x/d2' }));

  const { telegram, calls } = testTelegram();
  await dispatchDigests(telegram, db, new Date('2026-08-19T07:05:00Z')); // 09:05 Vienna

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
  // Header line only: a bare /2/ over the whole message also matches the rendered "2 rooms".
  assert.deepEqual(headerDigits(calls[0].payload.text), ['2']);
});

test('the first-ever digest adopts the existing backlog silently instead of calling it new', async () => {
  const db = openDb(':memory:');
  // Pre-deploy: only a profile that predates the quiet notifier reads as never-digested. A profile
  // created today is stamped at creation, and takes the ordinary path (see the item-1 tests below).
  const profileId = preDeployProfile(db, 1);
  assert.equal(getNotifySettings(db, profileId).lastDigestAt, null, 'a pre-deploy profile reads as never-digested');
  for (let i = 0; i < 3; i++) upsertListing(db, listing({ id: `b${i}`, url: `https://x/b${i}` }));

  const { telegram, calls } = testTelegram();
  await dispatchDigests(telegram, db, new Date('2026-08-19T07:05:00Z')); // 09:05 Vienna

  assert.equal(calls.length, 0, 'a pre-existing backlog is not news');
  assert.equal(getNotifySettings(db, profileId).lastDigestAt, '2026-08-19T07:05:00.000Z');
  assert.deepEqual(
    [...getNotifiedListingIds(db, profileId)].sort(),
    ['willhaben:b0', 'willhaben:b1', 'willhaben:b2'],
  );
});

test('the digest after the first reports only genuinely new listings', async () => {
  const db = openDb(':memory:');
  preDeployProfile(db, 1); // silent-adopt first, real digest second — the pre-deploy profile's two runs
  for (let i = 0; i < 3; i++) upsertListing(db, listing({ id: `b${i}`, url: `https://x/b${i}` }));

  const first = testTelegram();
  await dispatchDigests(first.telegram, db, new Date('2026-08-19T07:05:00Z')); // 09:05 Vienna
  assert.equal(first.calls.length, 0);

  upsertListing(db, listing({ id: 'fresh', url: 'https://x/fresh' }));
  const second = testTelegram();
  await dispatchDigests(second.telegram, db, new Date('2026-08-19T17:05:00Z')); // 19:05 Vienna

  assert.equal(second.calls.length, 1);
  assert.deepEqual(headerDigits(second.calls[0].payload.text), ['1']);
  assert.ok(String(second.calls[0].payload.text).includes('https://x/fresh'));
});

test('a digest lists five listings but records every pending one, so the next digest is silent', async () => {
  const db = openDb(':memory:');
  const profileId = createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null })).id;
  updateNotifySettings(db, profileId, { lastDigestAt: '2026-08-18T17:05:00Z' }); // not the first-ever run
  for (let i = 0; i < 7; i++) upsertListing(db, listing({ id: `p${i}`, url: `https://x/p${i}` }));

  const first = testTelegram();
  await dispatchDigests(first.telegram, db, new Date('2026-08-19T07:05:00Z')); // 09:05 Vienna

  assert.equal(first.calls.length, 1);
  const text = String(first.calls[0].payload.text);
  assert.deepEqual(headerDigits(text), ['7'], 'the header must count everything pending');
  assert.equal((text.match(/https:\/\/x\/p\d/g) ?? []).length, MAX_DIGEST_LINES, 'only five lines are rendered');
  assert.equal(getNotifiedListingIds(db, profileId).size, 7, 'all seven must be recorded, not just the shown five');

  const second = testTelegram();
  await dispatchDigests(second.telegram, db, new Date('2026-08-19T17:05:00Z')); // 19:05 Vienna
  assert.equal(second.calls.length, 0, 'nothing new means nothing sent');
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
  const profileId = createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null })).id;
  updateNotifySettings(db, profileId, { lastDigestAt: '2026-08-18T17:05:00Z' }); // not the first-ever run
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

// --- Final fix wave, item 3: a digest that fails must retry only when retrying can ever work. ---

/** A profile with one pending listing, already past its first digest, so every digest hour has something to send. */
function digestReadyProfile(db: DB, chatId: number): number {
  const profileId = createSearchProfile(db, chatId, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null })).id;
  updateNotifySettings(db, profileId, { lastDigestAt: '2026-08-18T17:05:00Z' });
  upsertListing(db, listing({ id: `pend${chatId}`, url: `https://x/pend${chatId}` }));
  return profileId;
}

test('a digest send blocked by the user stamps lastDigestAt instead of retrying every tick', async () => {
  const db = openDb(':memory:');
  const profileId = digestReadyProfile(db, 1);

  const blocked = testTelegram(() => new Error('403: Forbidden: bot was blocked by the user'));
  await dispatchDigests(blocked.telegram, db, new Date('2026-08-19T07:05:00Z')); // 09:05 Vienna
  assert.equal(blocked.calls.length, 1);
  assert.equal(getNotifySettings(db, profileId).lastDigestAt, '2026-08-19T07:05:00.000Z',
    'a permanently dead chat must be stamped, or the 5-minute tick retries it 288 times a day forever');

  // The very next tick, five minutes later: the 09:00 digest is now covered, so nothing is attempted.
  const nextTick = testTelegram(() => new Error('403: Forbidden: bot was blocked by the user'));
  await dispatchDigests(nextTick.telegram, db, new Date('2026-08-19T07:10:00Z'));
  assert.equal(nextTick.calls.length, 0, 'no retry on the next tick');
});

test('a transient digest failure still retries on the next tick', async () => {
  const db = openDb(':memory:');
  const profileId = digestReadyProfile(db, 2);

  const throttled = testTelegram(() => new Error('429: Too Many Requests: retry after 30'));
  await dispatchDigests(throttled.telegram, db, new Date('2026-08-19T07:05:00Z'));
  assert.equal(throttled.calls.length, 1);
  assert.equal(getNotifySettings(db, profileId).lastDigestAt, '2026-08-18T17:05:00Z', 'unchanged: this can still succeed');

  const nextTick = testTelegram();
  await dispatchDigests(nextTick.telegram, db, new Date('2026-08-19T07:10:00Z'));
  assert.equal(nextTick.calls.length, 1, 'a throttled digest must be retried');
  assert.ok(String(nextTick.calls[0].payload.text).includes('https://x/pend2'));
});

test('a permanently failed digest records nothing as notified, so the listings survive an unblock', async () => {
  const db = openDb(':memory:');
  const profileId = digestReadyProfile(db, 3);

  const blocked = testTelegram(() => new Error('403: Forbidden: bot was blocked by the user'));
  await dispatchDigests(blocked.telegram, db, new Date('2026-08-19T07:05:00Z'));

  assert.equal(getNotifiedListingIds(db, profileId).size, 0, 'nothing reached the user, so nothing is announced');

  // Next digest hour, user has unblocked: the same listing is still pending and now gets through.
  const later = testTelegram();
  await dispatchDigests(later.telegram, db, new Date('2026-08-19T17:05:00Z')); // 19:05 Vienna
  assert.equal(later.calls.length, 1);
  assert.ok(String(later.calls[0].payload.text).includes('https://x/pend3'));
});

test('one profile blocking the bot does not stop the next profile from getting its digest', async () => {
  const db = openDb(':memory:');
  digestReadyProfile(db, 4);
  digestReadyProfile(db, 5);

  const { telegram, calls } = testTelegram((_method, payload) =>
    payload.chat_id === 4 ? new Error('403: Forbidden: bot was blocked by the user') : undefined);
  await dispatchDigests(telegram, db, new Date('2026-08-19T07:05:00Z'));

  assert.deepEqual(calls.map((c) => c.payload.chat_id), [4, 5]);
});

// --- Final fix wave, item 1: `lastDigestAt == null` must mean ONLY "this profile pre-dates the ---
// --- deploy". A brand-new profile is stamped at creation, so its first day is never adopted ---
// --- silently. ---

/** A profile as it looks to the notifier if it was created before this branch shipped: no notify_settings row at all. */
function preDeployProfile(db: DB, chatId: number, name = 'Test'): number {
  const id = createSearchProfile(db, chatId, name, commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null })).id;
  db.prepare('DELETE FROM notify_settings WHERE profile_id = ?').run(id);
  return id;
}

test('creating a search profile stamps lastDigestAt with its creation time', () => {
  const db = openDb(':memory:');
  const created = new Date('2026-08-19T07:30:00Z'); // 09:30 Vienna
  const profile = createSearchProfile(db, 1, 'Test', commuteProfilePrefs(), true, created);

  assert.equal(profile.createdAt, created.toISOString());
  assert.equal(getNotifySettings(db, profile.id).lastDigestAt, created.toISOString());
});

test('a newly created profile does not take the silent-adopt path at its first digest hour', async () => {
  const db = openDb(':memory:');
  const created = new Date('2026-08-19T07:30:00Z'); // 09:30 Vienna, just after the 09:00 digest hour
  const profileId = createSearchProfile(
    db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }), true, created,
  ).id;
  upsertListing(db, listing({ id: 'new1', url: 'https://x/new1' }));

  const { telegram, calls } = testTelegram();
  await dispatchDigests(telegram, db, new Date('2026-08-19T17:05:00Z')); // 19:05 Vienna, same day

  assert.equal(calls.length, 1, "a new user's first day must not be swallowed by the silent adopt");
  const text = String(calls[0].payload.text);
  assert.deepEqual(headerDigits(text), ['1']);
  assert.ok(text.includes('https://x/new1'), 'the listing matched after creation must appear in that first digest');
  assert.equal(getNotifiedListingIds(db, profileId).size, 1);
});

test("the second digest hour after a new profile's first digest still works", async () => {
  const db = openDb(':memory:');
  const created = new Date('2026-08-19T07:30:00Z'); // 09:30 Vienna
  createSearchProfile(db, 1, 'Test', commuteProfilePrefs({ commuteDestination: null, commuteLat: null, commuteLon: null }), true, created);
  upsertListing(db, listing({ id: 'new1', url: 'https://x/new1' }));

  const first = testTelegram();
  await dispatchDigests(first.telegram, db, new Date('2026-08-19T17:05:00Z')); // 19:05 Vienna
  assert.equal(first.calls.length, 1);

  upsertListing(db, listing({ id: 'new2', url: 'https://x/new2' }));
  const second = testTelegram();
  await dispatchDigests(second.telegram, db, new Date('2026-08-20T07:05:00Z')); // 09:05 Vienna, next day

  assert.equal(second.calls.length, 1);
  assert.deepEqual(headerDigits(second.calls[0].payload.text), ['1'], 'only the listing added since the first digest');
  assert.ok(String(second.calls[0].payload.text).includes('https://x/new2'));
});
