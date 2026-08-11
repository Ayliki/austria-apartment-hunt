import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot, parseOnboardingAnswers, nextCardFor, formatCaption, buildMediaGroup, MAX_MEDIA_GROUP_ITEMS } from '../src/bot.js';
import { openDb, upsertListing, setUserPrefs, getOnboardingState, recordSwipe, type ListingRow, type DB } from '../src/db.js';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';
import { Telegram, type Telegraf } from 'telegraf';

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
  return {
    source: 'willhaben', id: '1', url: 'https://x/1', title: 'Flat',
    price: 650, pricePerSqm: 15, area: 43, rooms: 2, district: 6, zip: '1060',
    addressLine: null, lat: null, lon: null, isPrivate: true,
    requiresWaitlistTicket: false, images: [], description: null, dateCreated: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Sunny two-room flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: ['https://img/1.jpg'],
    description: null, url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
    requiresWaitlistTicket: false,
    ...overrides,
  };
}

test('parseOnboardingAnswers parses budget, districts, rooms, size, waitlist-housing answers', () => {
  const prefs = parseOnboardingAnswers(['800', '400', '1-9', '1-2', '30-60', 'no']);
  assert.deepEqual(prefs, {
    priceTo: 800, priceFrom: 400, districts: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    roomsFrom: 1, roomsTo: 2, areaFrom: 30, areaTo: 60, includeWaitlistHousing: false,
  });
});

test('parseOnboardingAnswers treats "skip"/"any" as unbounded for optional answers', () => {
  const prefs = parseOnboardingAnswers(['800', 'skip', 'any', 'any', 'any', 'yes']);
  assert.deepEqual(prefs, {
    priceTo: 800, priceFrom: null, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null,
    includeWaitlistHousing: true,
  });
});

test('parseOnboardingAnswers rejects a non-numeric required budget', () => {
  assert.throws(() => parseOnboardingAnswers(['not a number', 'skip', 'any', 'any', 'any', 'yes']), /budget/i);
});

test('nextCardFor returns null when the candidate queue is empty', () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true });
  assert.equal(nextCardFor(db, 1), null);
});

test('nextCardFor returns the top-ranked candidate, excluding already-swiped', () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true });
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

function createTestBot(db: DB): { bot: Telegraf; calls: Call[] } {
  const bot = createBot(db, 'test-token');
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

function callbackUpdate(chatId: number, data: string) {
  const id = nextUpdateId++;
  return {
    update_id: id,
    callback_query: {
      id: String(id), from: { id: chatId, is_bot: false, first_name: 'U' }, chat_instance: 'x', data,
      message: { message_id: id, date: 0, chat: { id: chatId, type: 'private' as const } },
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
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'yes']) {
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
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'no']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /No new listings right now/); // the only listing was waitlist housing, excluded
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
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true });
  upsertListing(db, listing({ id: 'a', price: 500 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a'));
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery'));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('No new listings')));
});
