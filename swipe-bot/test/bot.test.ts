import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBot, parseOnboardingAnswers, nextCardFor, formatCaption, buildMediaGroup, getCommuteLineFor,
  appendSwipeStatus, shortlistNavButtons, BOT_COMMANDS, MAX_MEDIA_GROUP_ITEMS, ONBOARDING_INTRO, type BotDeps, type GeocodeFn,
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
    requiresWaitlistTicket: false, isWg: false, lat: null, lon: null, isDelisted: false,
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

test('formatCaption flags a delisted listing, and only when it actually is', () => {
  const flagged = formatCaption(row({ isDelisted: true }));
  assert.match(flagged, /⚠️ No longer listed/);

  const unflagged = formatCaption(row({ isDelisted: false }));
  assert.doesNotMatch(unflagged, /No longer listed/);
});

test('formatCaption appends the commute line when given one, omits it entirely otherwise', () => {
  const withCommute = formatCaption(row({}), '📍 18 min walk · 7 min by tram D to TU Wien');
  assert.match(withCommute, /📍 18 min walk · 7 min by tram D to TU Wien/);

  assert.doesNotMatch(formatCaption(row({}), null), /📍/);
  assert.doesNotMatch(formatCaption(row({})), /📍/);
});

test('formatCaption includes an optional prefix ahead of the title, within the truncation budget', () => {
  const withPrefix = formatCaption(row({}), null, '❤️ 3 of 12\n\n');
  assert.match(withPrefix, /^❤️ 3 of 12\n\nSunny two-room flat/);
});

test('formatCaption without a prefix behaves exactly as before (no leading position line)', () => {
  assert.doesNotMatch(formatCaption(row({})), /❤️/);
});

test('formatCaption truncates to 1024 chars even with a prefix present', () => {
  const longDescription = 'x'.repeat(2000);
  const caption = formatCaption(row({ description: longDescription }), null, '❤️ 3 of 12\n\n');
  assert.ok(caption.length <= 1024, `caption was ${caption.length} chars`);
  assert.ok(caption.startsWith('❤️ 3 of 12\n\n'));
  assert.ok(caption.endsWith('…'));
});

test('shortlistNavButtons: a middle position shows Prev, Remove, and Next in that order', () => {
  const markup = shortlistNavButtons('willhaben:a', 2, 3) as unknown as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  const row = markup.reply_markup.inline_keyboard[0];
  assert.deepEqual(row.map((b) => b.text), ['◀️ Prev', '🗑️ Remove', '▶️ Next']);
  assert.deepEqual(row.map((b) => b.callback_data), ['slnav:prev:willhaben:a', 'unlike:willhaben:a', 'slnav:next:willhaben:a']);
});

test('shortlistNavButtons: the first position omits Prev', () => {
  const markup = shortlistNavButtons('willhaben:a', 1, 3) as unknown as { reply_markup: { inline_keyboard: { text: string }[][] } };
  assert.deepEqual(markup.reply_markup.inline_keyboard[0].map((b) => b.text), ['🗑️ Remove', '▶️ Next']);
});

test('shortlistNavButtons: the last position omits Next', () => {
  const markup = shortlistNavButtons('willhaben:a', 3, 3) as unknown as { reply_markup: { inline_keyboard: { text: string }[][] } };
  assert.deepEqual(markup.reply_markup.inline_keyboard[0].map((b) => b.text), ['◀️ Prev', '🗑️ Remove']);
});

test('shortlistNavButtons: a single-item shortlist omits both Prev and Next', () => {
  const markup = shortlistNavButtons('willhaben:a', 1, 1) as unknown as { reply_markup: { inline_keyboard: { text: string }[][] } };
  assert.deepEqual(markup.reply_markup.inline_keyboard[0].map((b) => b.text), ['🗑️ Remove']);
});

test('BOT_COMMANDS lists start, next, shortlist, settings, help, each with a non-empty description', () => {
  assert.deepEqual(BOT_COMMANDS.map((c) => c.command), ['start', 'next', 'shortlist', 'settings', 'help']);
  assert.ok(BOT_COMMANDS.every((c) => c.description.length > 0 && c.description.length <= 256)); // Telegram's setMyCommands description limit
});

test('appendSwipeStatus replaces a group-companion placeholder wholesale, rather than appending to it', () => {
  assert.equal(appendSwipeStatus('👍 or 👎?', '✅ Added to shortlist'), '✅ Added to shortlist');
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
// When set, callApi throws for this one method on its next invocation, then clears itself —
// used to simulate a Telegram API failure (e.g. editMessageMedia rejecting an expired CDN URL)
// without needing a full mock-framework dependency.
let forceFailureOnce: string | null = null;
(Telegram.prototype as unknown as { callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown> }).callApi =
  async function callApi(method, payload) {
    if (!activeCalls) throw new Error('callApi invoked outside a test bot context');
    if (forceFailureOnce === method) {
      forceFailureOnce = null;
      throw new Error(`simulated ${method} failure`);
    }
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

test('/help attaches the persistent nav keyboard', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/help'));
  const reply = calls.find((c) => c.method === 'sendMessage');
  const keyboard = (reply!.payload.reply_markup as { keyboard: string[][] }).keyboard;
  assert.deepEqual(keyboard, [['⏭ Next', '📋 Shortlist', '⚙️ Settings']]);
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

test('finishing onboarding attaches the persistent nav keyboard to the confirmation message', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any', 'yes', 'no', 'skip']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }
  const confirmation = calls.find((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Preferences saved'));
  assert.ok(confirmation, 'expected the confirmation message');
  const keyboard = (confirmation!.payload.reply_markup as { keyboard: string[][] }).keyboard;
  assert.deepEqual(keyboard, [['⏭ Next', '📋 Shortlist', '⚙️ Settings']]);
});

test('/start on an already-configured chat also attaches the persistent nav keyboard', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: null, commuteLat: null, commuteLon: null });
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  const reply = calls.find((c) => c.method === 'sendMessage');
  const keyboard = (reply!.payload.reply_markup as { keyboard: string[][] }).keyboard;
  assert.deepEqual(keyboard, [['⏭ Next', '📋 Shortlist', '⚙️ Settings']]);
});

test('tapping "⏭ Next" on the persistent keyboard sends the next card, same as /next', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: null, commuteLat: null, commuteLon: null });
  upsertListing(db, listing({ id: 'a', price: 500 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(textUpdate(1, '⏭ Next'));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€500')));
});

test('tapping "📋 Shortlist" on the persistent keyboard sends the shortlist, same as /shortlist', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(textUpdate(1, '📋 Shortlist'));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€500')));
});

test('tapping "⚙️ Settings" on the persistent keyboard restarts onboarding, same as /settings', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(textUpdate(1, '⚙️ Settings'));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes(ONBOARDING_INTRO)));
  assert.deepEqual(getOnboardingState(db, 1), []);
});

test('mid-onboarding text always wins over a coincidentally-matching keyboard label', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  for (const answer of ['800', 'skip', 'any', 'any', 'any']) {
    await bot.handleUpdate(textUpdate(1, answer));
  }
  // Onboarding is now waiting on the waitlist-housing yes/no question — send a keyboard-label-shaped
  // string instead of "yes"/"no" and confirm it's rejected as an invalid onboarding answer, not routed
  // to Settings (which would silently reset onboarding progress).
  await bot.handleUpdate(textUpdate(1, '⚙️ Settings'));
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /reply with "yes" or "no"/);
  assert.deepEqual(getOnboardingState(db, 1), ['800', 'skip', 'any', 'any', 'any']); // unchanged, not reset
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

test('a 👍 swipe on a listing deleted mid-flight (e.g. by the refresh sweep) tells the user instead of silently losing the like', async () => {
  const db = openDb(':memory:');
  setUserPrefs(db, { chatId: 1, priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, commuteDestination: null, commuteLat: null, commuteLon: null });
  // Note: no upsertListing — 'willhaben:a' doesn't exist, simulating one hard-deleted between card send and swipe.
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { text: 'Sunny flat\n€650 · 43m²\nhttps://x/1\n(no photo)' }));

  const answer = calls.find((c) => c.method === 'answerCallbackQuery');
  assert.ok(answer, 'expected an answerCallbackQuery call');
  assert.equal(answer!.payload.text, 'This listing is no longer available.');
  assert.notEqual(answer!.payload.text, 'Saved to shortlist 👍');

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.match(edit!.payload.text as string, /⚠️ No longer available/);

  assert.equal(getShortlist(db, 1).length, 0);
});

test('a swipe on a no-photo text card clears its swipe buttons down to a single Undo button', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { text: 'Sunny flat\n€650 · 43m²\nhttps://x/1\n(no photo)' }));

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'expected an editMessageText call clearing the swiped card');
  assert.match(edit!.payload.text as string, /✅ Added to shortlist/);
  const markup = edit!.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.deepEqual(markup.inline_keyboard, [[{ text: '↩️ Undo', callback_data: 'undo:willhaben:a', hide: false }]]);
});

test('tapping Undo right after a like reverses it: swipe and shortlist entry both gone', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { text: 'Sunny flat\n€500\nhttps://x/1\n(no photo)' }));
  await bot.handleUpdate(callbackUpdate(1, 'undo:willhaben:a', { text: 'Sunny flat\n€500\nhttps://x/1\n(no photo)\n\n✅ Added to shortlist' }));

  assert.equal(getShortlist(db, 1).length, 0);
  const undoAnswer = calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
  assert.equal(undoAnswer!.payload.text, 'Swipe undone ↩️');
  const undoEdit = calls.filter((c) => c.method === 'editMessageText').at(-1);
  assert.match(undoEdit!.payload.text as string, /↩️ Undone/);
  assert.deepEqual((undoEdit!.payload.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard, []);
});

test('tapping Undo on a swipe that is no longer the most recent one is refused, nothing changes', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  upsertListing(db, listing({ id: 'b', price: 600 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { text: 'Flat A\n€500\nhttps://x/a\n(no photo)' }));
  await bot.handleUpdate(callbackUpdate(1, 'pass:willhaben:b', { text: 'Flat B\n€600\nhttps://x/b\n(no photo)' }));

  await bot.handleUpdate(callbackUpdate(1, 'undo:willhaben:a', { text: 'Flat A\n€500\nhttps://x/a\n(no photo)\n\n✅ Added to shortlist' }));

  assert.equal(getShortlist(db, 1).length, 1); // 'a' is still shortlisted — the undo was refused
  const undoAnswer = calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
  assert.equal(undoAnswer!.payload.text, 'You can only undo your most recent swipe.');
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
  upsertListing(db, listing({ id: 'a' }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a', { text: '👍 or 👎?' }));

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.equal(edit!.payload.text, '✅ Added to shortlist');
});

test('a swipe on a photo card edits the caption (not the text), leaving the photo itself alone', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));
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

test('/shortlist sends only the newest-liked item, as a single card with a position count and nav buttons', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'old', price: 500 }));
  upsertListing(db, listing({ id: 'new', price: 600 }));
  recordSwipe(db, 1, 'willhaben:old', 'like');
  recordSwipe(db, 1, 'willhaben:new', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/shortlist'));

  const cards = calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€'));
  assert.equal(cards.length, 1); // only the first card, not the whole shortlist
  assert.match(cards[0].payload.text as string, /❤️ 1 of 2/);
  assert.match(cards[0].payload.text as string, /€600/); // newest-liked ('new') shown first

  const row = (cards[0].payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0];
  assert.deepEqual(row.map((b) => b.text), ['🗑️ Remove', '▶️ Next']); // position 1 of 2 — no Prev, has Next
  assert.deepEqual(row.map((b) => b.callback_data), ['unlike:willhaben:new', 'slnav:next:willhaben:new']);
});

test('/shortlist on a listing with a photo sends a sendPhoto card, not a text message', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'new', price: 600, images: ['https://img/1.jpg'] }));
  recordSwipe(db, 1, 'willhaben:new', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/shortlist'));

  const photoCall = calls.find((c) => c.method === 'sendPhoto');
  assert.ok(photoCall, 'expected a sendPhoto call for a listing with an image');
  assert.equal(photoCall!.payload.photo, 'https://img/1.jpg');
  assert.match(photoCall!.payload.caption as string, /❤️ 1 of 1/);
  assert.match(photoCall!.payload.caption as string, /€600/);
  assert.equal(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€')), false); // no text card
});

test('tapping Next from position 1 of 3 edits the same message in place to position 2 of 3', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  upsertListing(db, listing({ id: 'b', price: 600 }));
  upsertListing(db, listing({ id: 'c', price: 700 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  recordSwipe(db, 1, 'willhaben:c', 'like');
  // newest-liked first: c (pos 1), b (pos 2), a (pos 3)
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'slnav:next:willhaben:c', { text: '❤️ 1 of 3\n\nFlat\n€700\nhttps://x/1\n(no photo)' }));

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'expected an in-place edit, not a new message');
  assert.match(edit!.payload.text as string, /❤️ 2 of 3/);
  assert.match(edit!.payload.text as string, /€600/);
  assert.equal(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('€')), false); // no new card message
});

test('tapping Next from a photo card to another photo card edits the media in place, not delete+resend', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500, images: ['https://img/a.jpg'] }));
  upsertListing(db, listing({ id: 'b', price: 600, images: ['https://img/b.jpg'] }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  // newest-first: b (pos 1, photo), a (pos 2, photo) — Next from 'b' goes to 'a'
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'slnav:next:willhaben:b', { photo: [{ file_id: 'x' }], caption: '❤️ 1 of 2\n\nFlat\n€600\nhttps://x/1' }));

  const edit = calls.find((c) => c.method === 'editMessageMedia');
  assert.ok(edit, 'expected an in-place media edit, not delete+resend');
  const media = edit!.payload.media as { type: string; media: string; caption?: string };
  assert.equal(media.type, 'photo');
  assert.equal(media.media, 'https://img/a.jpg');
  assert.match(media.caption ?? '', /❤️ 2 of 2/);
  assert.match(media.caption ?? '', /€500/);
  assert.equal(calls.some((c) => c.method === 'deleteMessage'), false);
  assert.equal(calls.some((c) => c.method === 'sendPhoto'), false);
});

test('when editMessageMedia fails (e.g. an expired image URL), falls back to delete+send so the target card still shows', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500, images: ['https://img/a.jpg'] }));
  upsertListing(db, listing({ id: 'b', price: 600, images: ['https://img/b.jpg'] }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  // newest-first: b (pos 1, photo), a (pos 2, photo) — Next from 'b' goes to 'a'
  const { bot, calls } = createTestBot(db);
  forceFailureOnce = 'editMessageMedia';
  await bot.handleUpdate(callbackUpdate(1, 'slnav:next:willhaben:b', { photo: [{ file_id: 'x' }], caption: '❤️ 1 of 2\n\nFlat\n€600\nhttps://x/1' }));

  assert.equal(calls.some((c) => c.method === 'editMessageMedia'), false); // the failed attempt itself isn't recorded
  const deleteIdx = calls.findIndex((c) => c.method === 'deleteMessage');
  const sendIdx = calls.findIndex((c) => c.method === 'sendPhoto');
  assert.ok(deleteIdx !== -1, 'expected a deleteMessage fallback after the failed edit');
  assert.ok(sendIdx !== -1, 'expected a sendPhoto fallback after the failed edit');
  assert.ok(deleteIdx < sendIdx, 'expected delete to precede the fresh send');
  const sendPayload = calls[sendIdx].payload;
  assert.equal(sendPayload.photo, 'https://img/a.jpg');
  assert.match(sendPayload.caption as string, /❤️ 2 of 2/);
});

test('tapping Prev at position 1 is refused with a distinct reply, nothing changes', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'slnav:prev:willhaben:a', { text: '❤️ 1 of 1\n\nFlat\n€500\nhttps://x/1\n(no photo)' }));

  const answer = calls.find((c) => c.method === 'answerCallbackQuery');
  assert.equal(answer!.payload.text, 'This is the first one.');
  assert.equal(calls.some((c) => c.method === 'editMessageText'), false);
});

test('navigating to a listing whose photo-presence differs from the current message deletes and sends fresh, instead of an unsupported cross-type edit', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500, images: [] })); // no photo — current message is text
  upsertListing(db, listing({ id: 'b', price: 600, images: ['https://img/1.jpg'] })); // has a photo — target
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  // newest-first: b (pos 1, has photo), a (pos 2, no photo) — Prev from 'a' goes to 'b'
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'slnav:prev:willhaben:a', { text: '❤️ 2 of 2\n\nFlat\n€500\nhttps://x/1\n(no photo)' }));

  assert.ok(calls.some((c) => c.method === 'deleteMessage'), 'expected the old text card to be deleted');
  assert.ok(calls.some((c) => c.method === 'sendPhoto'), 'expected a fresh photo message for the target');
  assert.equal(calls.some((c) => c.method === 'editMessageText'), false);
  assert.equal(calls.some((c) => c.method === 'editMessageMedia'), false);
});

test('tapping Remove on a middle item advances in place to the item that slid into its slot', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  upsertListing(db, listing({ id: 'b', price: 600 }));
  upsertListing(db, listing({ id: 'c', price: 700 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  recordSwipe(db, 1, 'willhaben:c', 'like');
  // newest-first: c (pos 1), b (pos 2), a (pos 3) — remove 'b' at position 2
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'unlike:willhaben:b', { text: '❤️ 2 of 3\n\nFlat\n€600\nhttps://x/1\n(no photo)' }));

  const remaining = getShortlist(db, 1);
  assert.deepEqual(remaining.map((l) => l.id).sort(), ['willhaben:a', 'willhaben:c'].sort());

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'expected an in-place edit to the item that slid into position 2');
  assert.match(edit!.payload.text as string, /❤️ 2 of 2/);
  assert.match(edit!.payload.text as string, /€500/); // 'a' is now at position 2
});

test('tapping Remove on the last item advances to the new last item, position count decreases', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  upsertListing(db, listing({ id: 'b', price: 600 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  recordSwipe(db, 1, 'willhaben:b', 'like');
  // newest-first: b (pos 1), a (pos 2) — remove 'a', the last one
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'unlike:willhaben:a', { text: '❤️ 2 of 2\n\nFlat\n€500\nhttps://x/1\n(no photo)' }));

  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'expected an in-place edit to the new last item');
  assert.match(edit!.payload.text as string, /❤️ 1 of 1/);
  assert.match(edit!.payload.text as string, /€600/);
});

test('tapping Remove on the only remaining item shows the empty-shortlist message via delete+send', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', price: 500 }));
  recordSwipe(db, 1, 'willhaben:a', 'like');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'unlike:willhaben:a', { text: '❤️ 1 of 1\n\nFlat\n€500\nhttps://x/1\n(no photo)' }));

  assert.equal(getShortlist(db, 1).length, 0);
  assert.ok(calls.some((c) => c.method === 'deleteMessage'), 'expected a deleteMessage call');
  assert.ok(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('shortlist is empty')), 'expected the empty-shortlist message');
});

test('a swipe on a message that already has no reply markup is a no-op edit, not an error that blocks the next card', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  // No text/photo at all on the callback message — should not throw, still sends the next-card message.
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a'));
  assert.ok(calls.some((c) => c.method === 'sendMessage'));
});
