import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBot, parseOnboardingAnswers, nextCardFor, formatCaption, buildMediaGroup, getCommuteLineFor,
  appendSwipeStatus, BOT_COMMANDS, MAX_MEDIA_GROUP_ITEMS, MAX_SHORTLIST_CARDS, type BotDeps, type GeocodeFn,
} from '../src/bot.js';
import type { CommuteTimes } from '../src/db.js';
import { openDb, upsertListing, setUserPrefs, getUserPrefs, getOnboardingState, recordSwipe, getShortlist, getCandidateListings, type ListingRow, type DB } from '../src/db.js';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';
import { Telegram, type Telegraf } from 'telegraf';

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
  return {
    source: 'willhaben', id: '1', url: 'https://x/1', title: 'Flat',
    price: 650, pricePerSqm: 15, area: 43, rooms: 2, district: 6, zip: '1060',
    addressLine: null, lat: null, lon: null, isPrivate: true,
    requiresWaitlistTicket: false, isShortTerm: false, isWg: false, images: [], description: null, dateCreated: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Sunny two-room flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: ['https://img/1.jpg'],
    description: null, url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
    requiresWaitlistTicket: false, isWg: false, lat: null, lon: null,
    ...overrides,
  };
}

test('parseOnboardingAnswers parses budget, districts, rooms, size, waitlist-housing, WG answers', () => {
  const prefs = parseOnboardingAnswers(['800', '400', '1-9', '1-2', '30-60', 'no', 'yes']);
  assert.deepEqual(prefs, {
    priceTo: 800, priceFrom: 400, districts: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    roomsFrom: 1, roomsTo: 2, areaFrom: 30, areaTo: 60, includeWaitlistHousing: false, includeWg: true,
  });
});

test('parseOnboardingAnswers treats "skip"/"any" as unbounded for optional answers', () => {
  const prefs = parseOnboardingAnswers(['800', 'skip', 'any', 'any', 'any', 'yes', 'no']);
  assert.deepEqual(prefs, {
    priceTo: 800, priceFrom: null, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null,
    includeWaitlistHousing: true, includeWg: false,
  });
});

test('parseOnboardingAnswers rejects a non-numeric required budget', () => {
  assert.throws(() => parseOnboardingAnswers(['not a number', 'skip', 'any', 'any', 'any', 'yes', 'no']), /budget/i);
});

test('nextCardFor returns null when the candidate queue is empty', () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: null, commuteLat: null, commuteLon: null });
  assert.equal(nextCardFor(db, 1), null);
});

test('nextCardFor returns the top-ranked candidate, excluding already-swiped', () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: null, commuteLat: null, commuteLon: null });
  upsertListing(db, listing({ id: 'a', price: 500 }));
  upsertListing(db, listing({ id: 'b', price: 700 }));
  recordSwipe(db, 1, 'willhaben:a', 'pass');
  const card = nextCardFor(db, 1);
  assert.equal(card!.id, 'willhaben:b');
});

test('formatCaption includes title, price, size/rooms/district, and the link', () => {
  const caption = formatCaption(row({}));
  assert.match(caption, /Sunny two-room flat/);
  assert.match(caption, /€650/);
  assert.match(caption, /43m²/);
  assert.match(caption, /2 rooms/);
  assert.match(caption, /district 6/);
  assert.match(caption, /https:\/\/x\/1/);
});

test('formatCaption appends the description when present, omits the block when null', () => {
  const withDesc = formatCaption(row({ description: 'Bright and quiet, close to the U-Bahn.' }));
  assert.match(withDesc, /Bright and quiet, close to the U-Bahn\./);

  const withoutDesc = formatCaption(row({ description: null }));
  assert.doesNotMatch(withoutDesc, /\n\n/); // no description block appended at all
});

test('formatCaption truncates to Telegram\'s 1024-char caption limit instead of overflowing', () => {
  const longDescription = 'x'.repeat(2000);
  const caption = formatCaption(row({ description: longDescription }));
  assert.ok(caption.length <= 1024, `caption was ${caption.length} chars`);
  assert.ok(caption.endsWith('…'));
});

test('formatCaption flags municipal/waitlist housing, and only when it actually requires one', () => {
  const flagged = formatCaption(row({ requiresWaitlistTicket: true }));
  assert.match(flagged, /⚠️ Municipal\/waitlist housing/);

  const unflagged = formatCaption(row({ requiresWaitlistTicket: false }));
  assert.doesNotMatch(unflagged, /⚠️/);
});

test('formatCaption tags WG/shared-flat listings, and only those', () => {
  const flagged = formatCaption(row({ isWg: true }));
  assert.match(flagged, /🚪 WG/);

  const unflagged = formatCaption(row({ isWg: false }));
  assert.doesNotMatch(unflagged, /🚪/);
});

test('formatCaption appends the commute line when given one, omits it entirely otherwise', () => {
  const withCommute = formatCaption(row({}), '📍 18 min walk · 7 min by tram D to TU Wien');
  assert.match(withCommute, /📍 18 min walk · 7 min by tram D to TU Wien/);

  assert.doesNotMatch(formatCaption(row({}), null), /📍/);
  assert.doesNotMatch(formatCaption(row({})), /📍/);
});

test('BOT_COMMANDS lists start, next, shortlist, settings, help, each with a non-empty description', () => {
  assert.deepEqual(BOT_COMMANDS.map((c) => c.command), ['start', 'next', 'shortlist', 'settings', 'help']);
  assert.ok(BOT_COMMANDS.every((c) => c.description.length > 0 && c.description.length <= 256)); // Telegram's setMyCommands description limit
});

test('appendSwipeStatus replaces a group-companion placeholder wholesale, rather than appending to it', () => {
  assert.equal(appendSwipeStatus('👍 or 👎?', '✅ Added to shortlist'), '✅ Added to shortlist');
  assert.equal(appendSwipeStatus('🗑️ to remove', '🗑️ Removed'), '🗑️ Removed');
});

test('appendSwipeStatus appends to a real caption/text, rather than replacing it', () => {
  assert.equal(
    appendSwipeStatus('Sunny flat\n€650 · 43m² · 2 rooms\nhttps://x/1', '✅ Added to shortlist'),
    'Sunny flat\n€650 · 43m² · 2 rooms\nhttps://x/1\n\n✅ Added to shortlist',
  );
});

test('buildMediaGroup attaches the caption to only the first item', () => {
  const group = buildMediaGroup(['https://img/1.jpg', 'https://img/2.jpg', 'https://img/3.jpg'], 'my caption');
  assert.equal(group.length, 3);
  assert.equal(group[0].caption, 'my caption');
  assert.equal(group[1].caption, undefined);
  assert.equal(group[2].caption, undefined);
  assert.ok(group.every((item) => item.type === 'photo'));
  assert.deepEqual(group.map((item) => item.media), ['https://img/1.jpg', 'https://img/2.jpg', 'https://img/3.jpg']);
});

test('buildMediaGroup caps at Telegram\'s 10-item limit', () => {
  const images = Array.from({ length: 15 }, (_, i) => `https://img/${i}.jpg`);
  const group = buildMediaGroup(images, 'caption');
  assert.equal(group.length, MAX_MEDIA_GROUP_ITEMS);
  assert.deepEqual(group.map((item) => item.media), images.slice(0, MAX_MEDIA_GROUP_ITEMS));
});

// --- Handler-level tests: drive createBot() through real Telegraf update dispatch, ---
// --- stubbing only the outbound HTTP call. Covers the wiring the unit tests above skip. ---

interface Call { method: string; payload: Record<string, unknown> }

// Telegraf.handleUpdate constructs a brand-new Telegram instance per update (see telegraf.js:
// `const tg = new Telegram(this.token, ...)`), so stubbing an instance's callApi is a no-op —
// the prototype is the only stable interception point. `activeCalls` routes to whichever test
// bot is currently mid-await; tests in this file run sequentially, so this is safe.
let activeCalls: Call[] | null = null;
(Telegram.prototype as unknown as { callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown> }).callApi =
  async function callApi(method, payload) {
    if (!activeCalls) throw new Error('callApi invoked outside a test bot context');
    activeCalls.push({ method, payload });
    if (method === 'sendMediaGroup') return [];
    if (method === 'answerCallbackQuery') return true;
    return { message_id: activeCalls.length, date: 0, chat: { id: (payload.chat_id as number) ?? 0, type: 'private' } };
  };

const DEFAULT_TEST_DEPS: BotDeps = {
  geocode: async (address) => (address.trim().toLowerCase() === 'nowhere' ? null : { lat: 48.1986, lon: 16.3695 }),
  computeCommute: async () => ({ walkMinutes: null, transitMinutes: null, transitSummary: null }),
};

function createTestBot(db: DB, deps: Partial<BotDeps> = {}): { bot: Telegraf; calls: Call[] } {
  const bot = createBot(db, 'test-token', { ...DEFAULT_TEST_DEPS, ...deps });
  (bot as unknown as { botInfo: unknown }).botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'testbot' };
  const calls: Call[] = [];
  activeCalls = calls;
  return { bot, calls };
}

let nextUpdateId = 1;

function textUpdate(chatId: number, text: string) {
  const id = nextUpdateId++;
  return {
    update_id: id,
    message: { message_id: id, date: 0, chat: { id: chatId, type: 'private' as const }, from: { id: chatId, is_bot: false, first_name: 'U' }, text },
  };
}

function commandUpdate(chatId: number, command: string) {
  const id = nextUpdateId++;
  return {
    update_id: id,
    message: {
      message_id: id, date: 0, chat: { id: chatId, type: 'private' as const }, from: { id: chatId, is_bot: false, first_name: 'U' },
      text: command, entities: [{ offset: 0, length: command.length, type: 'bot_command' as const }],
    },
  };
}

function callbackUpdate(chatId: number, data: string, message: Record<string, unknown> = {}) {
  const id = nextUpdateId++;
  return {
    update_id: id,
    callback_query: {
      id: String(id), from: { id: chatId, is_bot: false, first_name: 'U' }, chat_instance: 'x', data,
      message: { message_id: id, date: 0, chat: { id: chatId, type: 'private' as const }, ...message },
    },
  };
}

test('/start begins onboarding and asks the first question', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
  assert.match(texts[0] as string, /never transfer money/);
  assert.match(texts[1] as string, /free text won't parse/);
  assert.equal(texts[2], 'What\'s your max budget (cold, in EUR)?');
  assert.deepEqual(getOnboardingState(db, 1), []);
});

test('/start on an already-configured chat points at /next, /shortlist, /settings instead of silently re-onboarding', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /\/next/);
  assert.match(texts[0], /\/shortlist/);
  assert.match(texts[0], /\/settings/);
  assert.equal(getOnboardingState(db, 1), null); // not put into onboarding
});

test('onboarding intro explains what happens after setup, not just how to answer', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts[1], /~3h/); // poll cadence
  assert.match(texts[1], /shortlist/i); // swiping builds a shortlist
});

test('/help explains the bot without requiring prefs to already be set', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/help'));
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /👍|👎/); // explains swiping
  assert.match(texts[0], /~3h/); // explains poll cadence
  assert.match(texts[0], /never transfer money/); // includes the safety notice
  assert.match(texts[0], /\/shortlist/);
  assert.match(texts[0], /\/settings/);
});

test('an invalid onboarding answer re-asks the same question without dropping prior progress', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  await bot.handleUpdate(textUpdate(1, 'not a number'));

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
  assert.match(texts.at(-1) as string, /doesn't look like a budget/);
  // still waiting on question 0 — the bad answer was never recorded
  assert.deepEqual(getOnboardingState(db, 1), []);
});

test('completing onboarding step by step saves prefs and reports no candidates yet', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'yes', 'no', 'skip']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }
  assert.equal(getOnboardingState(db, 1), null);
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
  assert.match(texts.at(-2) as string, /Preferences saved/);
  assert.match(texts.at(-1) as string, /No new listings right now/);
});

test('an invalid answer to the waitlist-housing question re-asks it without losing the first five answers', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }
  await bot.handleUpdate(textUpdate(1, 'maybe'));

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
  assert.match(texts.at(-1) as string, /reply with "yes" or "no"/);
  assert.deepEqual(getOnboardingState(db, 1), ['800', 'skip', 'any', 'any', 'any']);
});

test('opting out of waitlist housing during onboarding excludes it from the pushed queue', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'gemeindewohnung', price: 500, requiresWaitlistTicket: true }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'no', 'no', 'skip']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /No new listings right now/); // the only listing was waitlist housing, excluded
});

test('an invalid answer to the WG question re-asks it without losing the first six answers', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'yes']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }
  await bot.handleUpdate(textUpdate(1, 'maybe'));

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
  assert.match(texts.at(-1) as string, /reply with "yes" or "no"/);
  assert.deepEqual(getOnboardingState(db, 1), ['800', 'skip', 'any', 'any', 'any', 'yes']);
});

test('opting out of WG/shared-flat listings during onboarding excludes them from the pushed queue, opting in includes them', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'wg-room', price: 500, title: 'WG-Zimmer frei', isWg: true }));
  const { bot: optOutBot, calls: optOutCalls } = createTestBot(db);
  await optOutBot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'yes', 'no', 'skip']) {
    await optOutBot.handleUpdate(textUpdate(1, answer));
  }
  const optOutTexts = optOutCalls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(optOutTexts.at(-1) as string, /No new listings right now/); // the only listing was a WG room, excluded

  const { bot: optInBot, calls: optInCalls } = createTestBot(db);
  await optInBot.handleUpdate(commandUpdate(2, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'yes', 'yes', 'skip']) {
    await optInBot.handleUpdate(textUpdate(2, answer));
  }
  const optInTexts = optInCalls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(optInTexts.at(-1) as string, /🚪 WG/);
});

test('a successfully geocoded commute destination is saved and shown on the next card', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500, lat: 48.19, lon: 16.37 }));
  const { bot, calls } = createTestBot(db, {
    geocode: async () => ({ lat: 48.1986, lon: 16.3695 }),
    computeCommute: async () => ({ walkMinutes: 18, transitMinutes: 7, transitSummary: 'tram D' }),
  });
  await bot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'yes', 'no', 'TU Wien']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }

  assert.equal(getUserPrefs(db, 1)!.commuteDestination, 'TU Wien');
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /18 min walk · 7 min by tram D to TU Wien/);
});

test('an unresolvable commute destination re-asks the question instead of saving garbage', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'yes', 'no', 'nowhere']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }

  assert.equal(getOnboardingState(db, 1)?.length, 7); // still mid-onboarding, waiting on the commute question
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /couldn't find that location/);
});

test('"skip" on the commute question saves no destination and shows no commute line', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500, lat: 48.19, lon: 16.37 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'yes', 'no', 'skip']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }

  assert.equal(getUserPrefs(db, 1)!.commuteDestination, null);
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.doesNotMatch(texts.at(-1) as string, /📍/);
});

const NEVER_GEOCODE: GeocodeFn = async () => { throw new Error('geocode should not have been called'); };

test('getCommuteLineFor returns null when the user has no commute destination, or the listing has neither coordinates nor an address to fall back on', async () => {
  const db = openDb(':memory:');
  const noDestPrefs = { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(await getCommuteLineFor(db, 1, row({ lat: 48.19, lon: 16.37 }), noDestPrefs, async () => ({ walkMinutes: 10, transitMinutes: null, transitSummary: null }), NEVER_GEOCODE), null);

  const withDestPrefs = { ...noDestPrefs, commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 };
  assert.equal(await getCommuteLineFor(db, 1, row({ lat: null, lon: null, addressLine: null }), withDestPrefs, async () => ({ walkMinutes: 10, transitMinutes: null, transitSummary: null }), NEVER_GEOCODE), null);
});

test('getCommuteLineFor caches the computed result and does not recompute on a second call', async () => {
  const db = openDb(':memory:');
  const prefs = { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 };
  let calls = 0;
  const computeCommute = async (): Promise<CommuteTimes> => { calls++; return { walkMinutes: 12, transitMinutes: null, transitSummary: null }; };

  const listingRow = row({ id: 'willhaben:cached', lat: 48.19, lon: 16.37 });
  const first = await getCommuteLineFor(db, 1, listingRow, prefs, computeCommute, NEVER_GEOCODE);
  const second = await getCommuteLineFor(db, 1, listingRow, prefs, computeCommute, NEVER_GEOCODE);

  assert.equal(first, second);
  assert.equal(calls, 1);
});

test('getCommuteLineFor falls back to geocoding the listing\'s address when it has no coordinates, and persists the resolved coordinates onto the listing', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6, lat: null, lon: null, addressLine: '1110 Wien, Simmering' }));
  const prefs = { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 };
  const geocode: GeocodeFn = async () => ({ lat: 48.11, lon: 16.4 });
  const computeCommute = async (): Promise<CommuteTimes> => ({ walkMinutes: 20, transitMinutes: 10, transitSummary: 'U3' });

  const [listingRow] = getCandidateListings(db, 1, prefs);
  const line = await getCommuteLineFor(db, 1, listingRow, prefs, computeCommute, geocode);

  assert.match(line as string, /20 min walk/);
  const [persisted] = getCandidateListings(db, 1, prefs);
  assert.equal(persisted.lat, 48.11);
  assert.equal(persisted.lon, 16.4);
});

test('getCommuteLineFor returns null, and persists nothing, when the address fails to geocode', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', district: 6, lat: null, lon: null, addressLine: 'nonsense address' }));
  const prefs = { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 };
  const geocode: GeocodeFn = async () => null;
  const computeCommute = async (): Promise<CommuteTimes> => ({ walkMinutes: 20, transitMinutes: null, transitSummary: null });

  const [listingRow] = getCandidateListings(db, 1, prefs);
  const line = await getCommuteLineFor(db, 1, listingRow, prefs, computeCommute, geocode);

  assert.equal(line, null);
  const [persisted] = getCandidateListings(db, 1, prefs);
  assert.equal(persisted.lat, null);
});

test('a restart mid-onboarding does not drop progress — this is the bug that shipped', async () => {
  const db = openDb(':memory:');
  const first = createTestBot(db);
  await first.bot.handleUpdate(commandUpdate(42, '/start'));
  await first.bot.handleUpdate(textUpdate(42, '800')); // answers the budget question

  // simulate a process restart: a brand-new Telegraf instance, same on-disk db.
  const second = createTestBot(db);
  await second.bot.handleUpdate(textUpdate(42, 'skip')); // should continue onboarding, not be silently ignored

  const texts = second.calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
  assert.equal(texts.length, 1, 'the post-restart reply should continue the wizard, not stay silent');
  assert.equal(texts[0], 'Districts? e.g. "1-9" or "6,7,9", or "any"');
  assert.deepEqual(getOnboardingState(db, 42), ['800', 'skip']);
});

test('/next before onboarding is complete tells the user to /start instead of a misleading "no listings"', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/next'));
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
  assert.match(texts[0] as string, /haven't set your preferences/);
});

test('free text outside onboarding is ignored, not echoed or errored', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(textUpdate(1, 'You here?'));
  assert.equal(calls.length, 0);
});

test('a 👍 swipe records the shortlist entry and sends the next card', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: null, commuteLat: null, commuteLon: null });
  upsertListing(db, listing({ id: 'a', price: 500 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a'));
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery'));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('No new listings')));
});

test('a swipe on a no-photo text card clears its buttons and appends a status line, instead of leaving it swipeable forever', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { text: 'Sunny flat\n€650 · 43m²\nhttps://x/1\n(no photo)' }));

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'expected an editMessageText call clearing the swiped card');
  assert.match(edit!.payload.text as string, /✅ Added to shortlist/);
  assert.deepEqual((edit!.payload.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard, []);
});

test('a pass on a no-photo text card shows "Passed", not "Added to shortlist"', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'pass:willhaben:a', { text: 'Sunny flat\n€650 · 43m²\nhttps://x/1\n(no photo)' }));

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.match(edit!.payload.text as string, /👎 Passed/);
});

test('a swipe on the media-group companion placeholder replaces it wholesale with the status', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { text: '👍 or 👎?' }));

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.equal(edit!.payload.text, '✅ Added to shortlist');
});

test('a swipe on a photo card edits the caption (not the text), leaving the photo itself alone', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { photo: [{ file_id: 'x', file_unique_id: 'x', width: 1, height: 1 }], caption: 'Sunny flat\n€650 · 43m²\nhttps://x/1' }));

  const edit = calls.find((c) => c.method === 'editMessageCaption');
  assert.ok(edit, 'expected an editMessageCaption call for a photo card');
  assert.match(edit!.payload.caption as string, /✅ Added to shortlist/);
  assert.equal(calls.some((c) => c.method === 'editMessageText'), false);
});

test('/shortlist sends nothing but the empty-state message when there are no liked listings', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/shortlist'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.text as string, /shortlist is empty/);
});

test('/shortlist sends one card per liked listing, each with a Remove button, newest-liked first', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'old', price: 500 }));
  upsertListing(db, listing({ id: 'new', price: 600 }));
  recordSwipe(db, 1, 'willhaben:old', 'like');
  recordSwipe(db, 1, 'willhaben:new', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/shortlist'));

  const cards = calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€'));
  assert.equal(cards.length, 2);
  const buttons = cards.map((c) => (c.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0][0]);
  assert.ok(buttons.every((b) => b.text === '🗑️ Remove'));
  assert.deepEqual(buttons.map((b) => b.callback_data), ['unlike:willhaben:new', 'unlike:willhaben:old']);
});

test('/shortlist caps at MAX_SHORTLIST_CARDS and tells the user how many were left out', async () => {
  const db = openDb(':memory:');
  for (let i = 0; i < MAX_SHORTLIST_CARDS + 3; i++) {
    upsertListing(db, listing({ id: `x${i}`, price: 500 }));
    recordSwipe(db, 1, `willhaben:x${i}`, 'like');
  }
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/shortlist'));

  const cards = calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€'));
  assert.equal(cards.length, MAX_SHORTLIST_CARDS);
  const trailing = calls.at(-1)!;
  assert.match(trailing.payload.text as string, /3 more/);
});

test('tapping Remove on a shortlist card deletes the shortlist entry and edits the card to show it was removed', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'unlike:willhaben:a', { text: 'Sunny flat\n€500\nhttps://x/1' }));

  assert.equal(getShortlist(db, 1).length, 0);
  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'expected the shortlist card to be edited');
  assert.match(edit!.payload.text as string, /🗑️ Removed/);
  assert.deepEqual((edit!.payload.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard, []);
});

test('a swipe on a message that already has no reply markup is a no-op edit, not an error that blocks the next card', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  // No text/photo at all on the callback message — should not throw, still sends the next-card message.
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a'));
  assert.ok(calls.some((c) => c.method === 'sendMessage'));
});
