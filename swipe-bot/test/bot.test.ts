import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBot, nextCardFor, formatCaption, buildMediaGroup, getCommuteLineFor,
  appendSwipeStatus, shortlistNavButtons, BOT_COMMANDS, MAX_MEDIA_GROUP_ITEMS, renderWizardStep, type BotDeps, type GeocodeFn,
} from '../src/bot.js';
import type { CommuteTimes } from '../src/db.js';
import {
  openDb, upsertListing, createSearchProfile, getActiveSearchProfile, getSearchProfile, getSearchProfiles, getWizardState, recordSwipe, getShortlist,
  getCandidateListings, MAX_SEARCH_PROFILES_PER_CHAT, type ListingRow, type DB, type SearchProfilePrefs,
} from '../src/db.js';
import { initialWizardState, WIZARD_STEPS } from '../src/wizard.js';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';
import { Telegram, type Telegraf } from 'telegraf';

function defaultPrefs(overrides: Partial<SearchProfilePrefs> = {}): SearchProfilePrefs {
  return {
    priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null,
    includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false,
    commuteDestination: null, commuteLat: null, commuteLon: null,
    ...overrides,
  };
}

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
  return {
    source: 'willhaben', id: '1', url: 'https://x/1', title: 'Flat',
    price: 650, pricePerSqm: 15, area: 43, rooms: 2, district: 6, zip: '1060',
    addressLine: null, lat: null, lon: null, isPrivate: true,
    requiresWaitlistTicket: false, isShortTerm: false, isWg: false, images: [], description: null, dateCreated: '2026-08-01T00:00:00Z',
    lift: null, parkingSpaces: null, floor: null, energyClass: null, availableFrom: null, mentionsPets: false,
    ...overrides,
  };
}

function row(overrides: Partial<ListingRow>): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Sunny two-room flat', price: 650, pricePerSqm: 15,
    area: 43, rooms: 2, district: 6, isPrivate: true, images: ['https://img/1.jpg'],
    description: null, url: 'https://x/1', valueFlag: 'fair', firstSeen: '2026-08-01T00:00:00Z',
    requiresWaitlistTicket: false, isWg: false, lat: null, lon: null, isDelisted: false,
    lift: null, parkingSpaces: null, floor: null, energyClass: null, availableFrom: null, mentionsPets: false,
    ...overrides,
  };
}

test('nextCardFor returns null when the candidate queue is empty', () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  assert.equal(nextCardFor(db, 1), null);
});

test('nextCardFor returns the top-ranked candidate, excluding already-swiped', () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
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

test('formatCaption shows elevator/parking/floor/energy class only when known, never fabricating "no" for a null field', () => {
  const withAmenities = formatCaption(row({ lift: true, parkingSpaces: 2, floor: '3. Stock', energyClass: 'B' }));
  assert.match(withAmenities, /Lift/i);
  assert.match(withAmenities, /Parking/i);
  assert.match(withAmenities, /3\. Stock/);
  assert.match(withAmenities, /B/);

  const withoutAmenities = formatCaption(row({ lift: null, parkingSpaces: null, floor: null, energyClass: null }));
  assert.doesNotMatch(withoutAmenities, /Lift/i);
  assert.doesNotMatch(withoutAmenities, /Parking/i);
});

test('formatCaption shows the unverified pet badge only when mentionsPets is true', () => {
  assert.match(formatCaption(row({ mentionsPets: true })), /🐾 mentions pets — check listing/);
  assert.doesNotMatch(formatCaption(row({ mentionsPets: false })), /🐾/);
});

test('formatCaption still truncates to 1024 chars with the new badge lines included', () => {
  const caption = formatCaption(row({ description: 'x'.repeat(2000), lift: true, parkingSpaces: 1, mentionsPets: true }));
  assert.ok(caption.length <= 1024);
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

test('BOT_COMMANDS lists start, next, shortlist, searches, settings, help, language, each with a non-empty description', () => {
  assert.deepEqual(BOT_COMMANDS.map((c) => c.command), ['start', 'next', 'shortlist', 'searches', 'settings', 'help', 'language']);
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

test('/start with no existing profiles begins the wizard at the name step', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts[0], /never transfer money/); // safety notice first
  assert.match(texts[1], /name this search/i);
  const keyboard = (calls[1].payload.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard;
  assert.ok(keyboard.flat().some((b) => b.text === 'Skip'));
  assert.deepEqual(getWizardState(db, 1), initialWizardState());
});

test('/start when a profile already exists tells the user to use /searches or /settings instead of re-onboarding', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /\/next/);
  assert.match(texts[0], /\/searches/);
  assert.match(texts[0], /\/settings/);
  assert.equal(getWizardState(db, 1), null); // not put into the wizard
});

test('/start refuses a 6th profile once MAX_SEARCH_PROFILES_PER_CHAT is reached, pointing at /searches to delete one first', async () => {
  const db = openDb(':memory:');
  for (let i = 0; i < MAX_SEARCH_PROFILES_PER_CHAT; i++) {
    createSearchProfile(db, 1, `Search ${i + 1}`, defaultPrefs(), false);
  }
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));

  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.equal(texts.length, 2); // safety notice, then the cap refusal
  assert.match(texts[1], new RegExp(String(MAX_SEARCH_PROFILES_PER_CHAT)));
  assert.match(texts[1], /\/searches/);
  assert.equal(getWizardState(db, 1), null); // never entered the wizard
  assert.equal(getSearchProfiles(db, 1).length, MAX_SEARCH_PROFILES_PER_CHAT);
});

test('completing the wizard end-to-end creates an active SearchProfile with the chosen answers', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start')); // name step

  await bot.handleUpdate(textUpdate(1, 'Studio Center')); // free-text name -> budget step
  await bot.handleUpdate(callbackUpdate(1, 'wizard:budget:700:900')); // budget chip -> districts step
  await bot.handleUpdate(callbackUpdate(1, 'wizard:district:6')); // toggle district 6
  await bot.handleUpdate(callbackUpdate(1, 'wizard:district:7')); // toggle district 7
  await bot.handleUpdate(callbackUpdate(1, 'wizard:districts_continue')); // -> rooms/size step
  await bot.handleUpdate(callbackUpdate(1, 'wizard:rooms:1:1')); // rooms chip -> amenities step
  await bot.handleUpdate(callbackUpdate(1, 'wizard:amenity:requireElevator')); // toggle elevator on
  await bot.handleUpdate(callbackUpdate(1, 'wizard:amenities_continue')); // -> commute step
  await bot.handleUpdate(callbackUpdate(1, 'wizard:commute_skip')); // completes the wizard

  assert.equal(getWizardState(db, 1), null); // wizard state cleared on completion

  const profiles = getSearchProfiles(db, 1);
  assert.equal(profiles.length, 1);
  const profile = profiles[0];
  assert.equal(profile.active, true);
  assert.equal(profile.name, 'Studio Center');
  assert.deepEqual(profile.prefs, {
    priceFrom: 700, priceTo: 900, districts: [6, 7], roomsFrom: 1, roomsTo: 1, areaFrom: null, areaTo: null,
    includeWaitlistHousing: false, includeWg: false, requireElevator: true, requireParking: false,
    commuteDestination: null, commuteLat: null, commuteLon: null,
  });

  const texts = calls.filter((c) => c.method === 'editMessageText').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /Saved "Studio Center"/);
});

test('a Back tap during the wizard re-renders the previous step without losing earlier answers', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start')); // name step
  await bot.handleUpdate(textUpdate(1, 'My Search')); // -> budget step
  await bot.handleUpdate(callbackUpdate(1, 'wizard:budget:700:900')); // -> districts step

  await bot.handleUpdate(callbackUpdate(1, 'wizard:back')); // back to budget

  const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.payload.text as string);
  assert.match(edits.at(-1) as string, /budget/i);
  const state = getWizardState(db, 1)!;
  assert.equal(state.stepIndex, 1); // back at the budget step
  assert.equal(state.profileName, 'My Search'); // name answer preserved across the back-tap
});

test('a stale wizard button tap (from a step the wizard already moved past) is handled gracefully, not thrown as an unhandled error', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start')); // name step
  await bot.handleUpdate(textUpdate(1, 'My Search')); // -> budget step
  await bot.handleUpdate(callbackUpdate(1, 'wizard:budget:700:900')); // -> districts step

  // Simulate a double-tap: the user's second tap on the (now-stale) budget chip arrives after the
  // wizard already advanced to districts. applyWizardChoice would throw for this — the handler must
  // not let that become an unhandled promise rejection.
  await assert.doesNotReject(bot.handleUpdate(callbackUpdate(1, 'wizard:budget:700:900')));

  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery')); // the tap's loading spinner is cleared
  const state = getWizardState(db, 1)!;
  assert.equal(state.stepIndex, 2); // still on districts — the stale tap did not move it backward or crash it
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

test('/start on an already-configured chat also attaches the persistent nav keyboard', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  const reply = calls.find((c) => c.method === 'sendMessage');
  const keyboard = (reply!.payload.reply_markup as { keyboard: string[][] }).keyboard;
  assert.deepEqual(keyboard, [['⏭ Next', '📋 Shortlist', '⚙️ Settings']]);
});

test('tapping "⏭ Next" on the persistent keyboard sends the next card, same as /next', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', defaultPrefs());
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

test('tapping "⚙️ Settings" on the persistent keyboard opens the per-field edit menu, same as /settings', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'My Search', defaultPrefs());
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(textUpdate(1, '⚙️ Settings'));
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /pick a field/i);
  assert.equal(getWizardState(db, 1), null); // no wizard run started
});

test('tapping "⚙️ Settings" with no active search nudges the user to /start instead of erroring', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(textUpdate(1, '⚙️ Settings'));
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /No active search/);
});

test('free text mid-wizard on the name step is always taken as the profile name, even if it happens to match a keyboard label', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start')); // waiting on the name step

  // A keyboard-label-shaped string must be recorded as the (odd but valid) profile name, not
  // silently rerouted to the "⚙️ Settings" shortcut — that shortcut only applies when the chat is
  // not mid-wizard, and this one is.
  await bot.handleUpdate(textUpdate(1, '⚙️ Settings'));

  const state = getWizardState(db, 1)!;
  assert.equal(state.profileName, '⚙️ Settings');
  assert.equal(state.stepIndex, 1); // advanced to budget, wizard was not reset
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /budget/i);
});

test('free text mid-wizard on a button-only step (e.g. budget) nudges the user back to the buttons instead of staying silent', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start')); // name step
  await bot.handleUpdate(textUpdate(1, 'My Search')); // -> budget step, a button-only step

  await bot.handleUpdate(textUpdate(1, 'somewhere around 800 euros'));

  const state = getWizardState(db, 1)!;
  assert.equal(state.stepIndex, 1); // still on budget, wizard did not advance
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /tap one of the buttons/i);
});

test('opting out of waitlist housing and WG rooms via the amenity chips excludes both from the pushed candidate queue', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'gemeindewohnung', price: 500, requiresWaitlistTicket: true }));
  upsertListing(db, listing({ id: 'wg-room', price: 500, title: 'WG-Zimmer frei', isWg: true }));
  const { bot } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  await bot.handleUpdate(textUpdate(1, 'My Search'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:budget:700:900'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:districts_continue'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:rooms:1:1'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:amenities_continue')); // neither amenity chip tapped -> both default false
  await bot.handleUpdate(callbackUpdate(1, 'wizard:commute_skip'));

  const profile = getActiveSearchProfile(db, 1)!;
  assert.equal(profile.prefs.includeWaitlistHousing, false);
  assert.equal(profile.prefs.includeWg, false);
});

test('opting in to waitlist housing and WG rooms via the amenity chips includes both in the pushed candidate queue', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'gemeindewohnung', price: 500, requiresWaitlistTicket: true }));
  upsertListing(db, listing({ id: 'wg-room', price: 500, title: 'WG-Zimmer frei', isWg: true }));
  const { bot } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  await bot.handleUpdate(textUpdate(1, 'My Search'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:budget:700:900'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:districts_continue'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:rooms:1:1'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:amenity:includeWaitlistHousing'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:amenity:includeWg'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:amenities_continue'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:commute_skip'));

  const profile = getActiveSearchProfile(db, 1)!;
  assert.equal(profile.prefs.includeWaitlistHousing, true);
  assert.equal(profile.prefs.includeWg, true);
});

test('a successfully geocoded commute destination is saved on wizard completion', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db, {
    geocode: async () => ({ lat: 48.1986, lon: 16.3695 }),
    computeCommute: async () => ({ walkMinutes: 18, transitMinutes: 7, transitSummary: 'tram D' }),
  });
  await bot.handleUpdate(commandUpdate(1, '/start'));
  await bot.handleUpdate(textUpdate(1, 'My Search'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:budget:700:900'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:districts_continue'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:rooms:1:1'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:amenities_continue'));
  await bot.handleUpdate(textUpdate(1, 'TU Wien')); // commute step is free-text

  assert.equal(getActiveSearchProfile(db, 1)!.prefs.commuteDestination, 'TU Wien');
  assert.equal(getWizardState(db, 1), null); // wizard completed and its state cleared
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.ok(texts.some((t) => /Saved "My Search"/.test(t)));
});

test('an unresolvable commute destination re-asks instead of saving garbage or advancing the wizard', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  await bot.handleUpdate(textUpdate(1, 'My Search'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:budget:700:900'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:districts_continue'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:rooms:1:1'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:amenities_continue'));
  await bot.handleUpdate(textUpdate(1, 'nowhere'));

  const state = getWizardState(db, 1);
  assert.ok(state, 'still mid-wizard, waiting on the commute step');
  assert.equal(WIZARD_STEPS[state!.stepIndex], 'commute');
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /couldn't find that location/);
});

test('tapping Skip on the commute step saves no destination and completes the wizard', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  await bot.handleUpdate(textUpdate(1, 'My Search'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:budget:700:900'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:districts_continue'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:rooms:1:1'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:amenities_continue'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:commute_skip'));

  assert.equal(getActiveSearchProfile(db, 1)!.prefs.commuteDestination, null);
  assert.equal(getWizardState(db, 1), null);
  const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.payload.text as string);
  assert.match(edits.at(-1) as string, /Saved "My Search"/);
});

// --- Task 7: /searches (list/switch/delete) + /settings single-field editing ---

test('/searches lists every profile for the chat with a switch button, marking the active one', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Studio Center', defaultPrefs(), false);
  createSearchProfile(db, 1, 'Family Flat', defaultPrefs(), true); // second one active
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/searches'));

  const reply = calls.find((c) => c.method === 'sendMessage')!;
  const text = reply.payload.text as string;
  assert.match(text, /Studio Center/);
  assert.match(text, /Family Flat/);
  assert.match(text, /▶ Family Flat/); // active one visually marked

  const keyboard = (reply.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  const flat = keyboard.flat();
  assert.ok(flat.some((b) => b.text.includes('Studio Center') && b.callback_data.startsWith('switchprofile:')));
  assert.ok(flat.some((b) => b.text.includes('Family Flat') && b.callback_data.startsWith('deleteprofile:')));
  // the active profile gets no switch button (nothing to switch to from itself)
  assert.ok(!flat.some((b) => b.callback_data.startsWith('switchprofile:') && b.text.includes('Family Flat')));
});

test('/searches with no profiles points at /start instead of showing an empty list', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/searches'));
  const reply = calls.find((c) => c.method === 'sendMessage')!;
  assert.match(reply.payload.text as string, /\/start/);
});

test('tapping switchprofile:<id> makes that profile active', async () => {
  const db = openDb(':memory:');
  const first = createSearchProfile(db, 1, 'Studio Center', defaultPrefs(), false);
  createSearchProfile(db, 1, 'Family Flat', defaultPrefs(), true);
  const { bot } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, `switchprofile:${first.id}`));

  assert.equal(getActiveSearchProfile(db, 1)!.id, first.id);
});

test('tapping deleteprofile:<id> on the active profile removes it and clears the active flag entirely', async () => {
  const db = openDb(':memory:');
  const profile = createSearchProfile(db, 1, 'Only Search', defaultPrefs());
  const { bot } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, `deleteprofile:${profile.id}`));

  assert.equal(getSearchProfiles(db, 1).length, 0);
  assert.equal(getActiveSearchProfile(db, 1), null);
});

test('deleting the active profile while another remains prompts the user to pick a new active one', async () => {
  const db = openDb(':memory:');
  const active = createSearchProfile(db, 1, 'Active One', defaultPrefs(), true);
  createSearchProfile(db, 1, 'Other', defaultPrefs(), false);
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, `deleteprofile:${active.id}`));

  assert.equal(getActiveSearchProfile(db, 1), null);
  const reply = calls.find((c) => c.method === 'sendMessage');
  assert.ok(reply, 'expected a reply prompting the user to pick a new active profile');
  const keyboard = (reply!.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  assert.ok(keyboard.flat().some((b) => b.text.includes('Other') && b.callback_data.includes('switchprofile:')));
});

test('deleting an inactive profile leaves the active one untouched and does not prompt', async () => {
  const db = openDb(':memory:');
  const active = createSearchProfile(db, 1, 'Active One', defaultPrefs(), true);
  const other = createSearchProfile(db, 1, 'Other', defaultPrefs(), false);
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, `deleteprofile:${other.id}`));

  assert.equal(getActiveSearchProfile(db, 1)!.id, active.id);
  assert.equal(calls.some((c) => c.method === 'sendMessage'), false); // just the answerCallbackQuery, no extra prompt
});

test('/searches refuses to create a 6th profile via "+ Add another search" once the chat is at the cap, with a clear message', async () => {
  const db = openDb(':memory:');
  for (let i = 0; i < MAX_SEARCH_PROFILES_PER_CHAT; i++) {
    createSearchProfile(db, 1, `Search ${i + 1}`, defaultPrefs(), false);
  }
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/searches'));

  const listReply = calls.find((c) => c.method === 'sendMessage')!;
  const listKeyboard = (listReply.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  assert.ok(!listKeyboard.flat().some((b) => b.callback_data === 'wizard:new'), 'no "add another" button once at the cap');

  // Even if the button were tapped directly (e.g. a stale keyboard from before the cap was hit),
  // the underlying action must still refuse — this is the actual cap-enforcement call site.
  await bot.handleUpdate(callbackUpdate(1, 'wizard:new'));
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, new RegExp(String(MAX_SEARCH_PROFILES_PER_CHAT)));
  assert.match(texts.at(-1) as string, /\/searches/);
  assert.equal(getSearchProfiles(db, 1).length, MAX_SEARCH_PROFILES_PER_CHAT); // no 6th profile created
});

test('/searches offers "+ Add another search" while under the cap', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Only Search', defaultPrefs());
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/searches'));

  const reply = calls.find((c) => c.method === 'sendMessage')!;
  const keyboard = (reply.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  assert.ok(keyboard.flat().some((b) => b.callback_data === 'wizard:new'));
});

test('/settings on the active profile offers per-field edit buttons instead of restarting the whole wizard', async () => {
  const db = openDb(':memory:');
  const profile = createSearchProfile(db, 1, 'My Search', defaultPrefs());
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/settings'));

  const reply = calls.find((c) => c.method === 'sendMessage')!;
  assert.doesNotMatch(reply.payload.text as string, /name this search/i); // not the wizard's name-step prompt
  const keyboard = (reply.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  const flat = keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === `editfield:${profile.id}:budget`));
  assert.ok(flat.some((b) => b.callback_data === `editfield:${profile.id}:districts`));
  assert.ok(flat.some((b) => b.callback_data === `editfield:${profile.id}:rooms_size`));
  assert.ok(flat.some((b) => b.callback_data === `editfield:${profile.id}:amenities`));
  assert.ok(flat.some((b) => b.callback_data === `editfield:${profile.id}:commute`));
  assert.ok(flat.some((b) => b.callback_data === `editfield:${profile.id}:name`));
  assert.equal(getWizardState(db, 1), null); // no wizard run started yet
});

test('/settings with no active search nudges the user to /start instead of erroring', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/settings'));
  const reply = calls.find((c) => c.method === 'sendMessage')!;
  assert.match(reply.payload.text as string, /No active search/);
});

test('editfield:<id>:budget jumps straight to the budget step, and completing just that step updates only that field', async () => {
  const db = openDb(':memory:');
  const profile = createSearchProfile(db, 1, 'My Search', defaultPrefs({ districts: [6, 7], priceFrom: null, priceTo: 800 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, `editfield:${profile.id}:budget`));

  const edit = calls.find((c) => c.method === 'editMessageText')!;
  assert.match(edit.payload.text as string, /budget/i);

  await bot.handleUpdate(callbackUpdate(1, 'wizard:budget:700:900'));

  const updated = getActiveSearchProfile(db, 1)!;
  assert.equal(updated.prefs.priceFrom, 700);
  assert.equal(updated.prefs.priceTo, 900);
  assert.deepEqual(updated.prefs.districts, [6, 7]); // untouched by the budget-only edit
  assert.equal(getWizardState(db, 1), null); // edit session closed, no lingering wizard state

  const confirmations = calls.filter((c) => c.method === 'editMessageText').map((c) => c.payload.text as string);
  assert.match(confirmations.at(-1) as string, /Updated "My Search"/);
});

test('editing the districts field requires its own Continue tap before saving, just like the main wizard', async () => {
  const db = openDb(':memory:');
  const profile = createSearchProfile(db, 1, 'My Search', defaultPrefs({ districts: [6] }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, `editfield:${profile.id}:districts`));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:district:9')); // toggle a district on

  // Toggling alone must not finalize the edit yet.
  assert.ok(getWizardState(db, 1), 'still mid single-field edit after a toggle, not finalized yet');
  assert.deepEqual(getActiveSearchProfile(db, 1)!.prefs.districts, [6]); // unchanged so far

  await bot.handleUpdate(callbackUpdate(1, 'wizard:districts_continue'));

  assert.equal(getWizardState(db, 1), null);
  assert.deepEqual(getActiveSearchProfile(db, 1)!.prefs.districts, [6, 9]);
  const confirmations = calls.filter((c) => c.method === 'editMessageText').map((c) => c.payload.text as string);
  assert.match(confirmations.at(-1) as string, /Updated "My Search"/);
});

test('editing the name field via free text updates only the name, not the rest of the profile', async () => {
  const db = openDb(':memory:');
  const profile = createSearchProfile(db, 1, 'Old Name', defaultPrefs({ priceTo: 900 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, `editfield:${profile.id}:name`));
  await bot.handleUpdate(textUpdate(1, 'New Name'));

  const updated = getActiveSearchProfile(db, 1)!;
  assert.equal(updated.name, 'New Name');
  assert.equal(updated.prefs.priceTo, 900); // untouched
  assert.equal(getWizardState(db, 1), null);
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /Updated "New Name"/);
});

test('editing the commute field via free text updates only the commute fields, without creating a duplicate profile', async () => {
  const db = openDb(':memory:');
  const profile = createSearchProfile(db, 1, 'My Search', defaultPrefs({ priceTo: 900 }));
  const { bot, calls } = createTestBot(db, {
    geocode: async () => ({ lat: 48.1986, lon: 16.3695 }),
  });
  await bot.handleUpdate(callbackUpdate(1, `editfield:${profile.id}:commute`));
  await bot.handleUpdate(textUpdate(1, 'TU Wien'));

  const profiles = getSearchProfiles(db, 1);
  assert.equal(profiles.length, 1); // no duplicate profile created
  const updated = profiles[0];
  assert.equal(updated.prefs.commuteDestination, 'TU Wien');
  assert.equal(updated.prefs.priceTo, 900); // untouched
  assert.equal(getWizardState(db, 1), null);
  const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  assert.match(texts.at(-1) as string, /Updated "My Search"/);
});

test('a Back tap during a single-field edit cancels the edit rather than saving a decremented/broken state', async () => {
  const db = openDb(':memory:');
  const profile = createSearchProfile(db, 1, 'My Search', defaultPrefs({ priceTo: 800 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, `editfield:${profile.id}:budget`));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:back'));

  assert.equal(getWizardState(db, 1), null); // edit session closed
  assert.equal(getActiveSearchProfile(db, 1)!.prefs.priceTo, 800); // unchanged
  const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.payload.text as string);
  assert.match(edits.at(-1) as string, /cancel/i);
});

// --- Task 7 review fixes ---

test('tapping Skip during a single-field name edit cancels the edit instead of renaming the profile to a generic default', async () => {
  const db = openDb(':memory:');
  const profile = createSearchProfile(db, 1, 'My Real Name', defaultPrefs());
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, `editfield:${profile.id}:name`));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:name_skip'));

  assert.equal(getWizardState(db, 1), null); // edit session closed
  assert.equal(getActiveSearchProfile(db, 1)!.name, 'My Real Name'); // not renamed to "Search N"
  const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.payload.text as string);
  assert.match(edits.at(-1) as string, /cancel/i);
});

test('tapping Skip on the name step during the full onboarding wizard still applies a generated default name', async () => {
  const db = openDb(':memory:');
  const { bot } = createTestBot(db);
  await bot.handleUpdate(commandUpdate(1, '/start'));
  await bot.handleUpdate(callbackUpdate(1, 'wizard:name_skip'));

  const state = getWizardState(db, 1);
  assert.ok(state, 'still mid full wizard, not finalized yet');
  assert.equal(state!.profileName, 'Search 1');
});

test('a stale switchprofile: tap for an already-deleted profile does not touch the active profile', async () => {
  const db = openDb(':memory:');
  const active = createSearchProfile(db, 1, 'Active One', defaultPrefs(), true);
  const doomed = createSearchProfile(db, 1, 'Doomed', defaultPrefs(), false);
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, `deleteprofile:${doomed.id}`));
  await bot.handleUpdate(callbackUpdate(1, `switchprofile:${doomed.id}`)); // stale tap on the deleted profile's old button

  assert.equal(getActiveSearchProfile(db, 1)!.id, active.id); // still active, not left with none
  const answers = calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text as string);
  assert.match(answers.at(-1) as string, /no longer exists/i);
});

test('deleteprofile: and editfield: refuse to act on a profile belonging to a different chat (cross-chat IDOR)', async () => {
  const db = openDb(':memory:');
  const victim = createSearchProfile(db, 42, 'Chat A Search', defaultPrefs({ priceTo: 900 }));
  const { bot: deleteBot, calls: deleteCalls } = createTestBot(db);
  await deleteBot.handleUpdate(callbackUpdate(999, `deleteprofile:${victim.id}`)); // acting as a different chat

  assert.equal(getSearchProfiles(db, 42).length, 1, "victim chat's profile must survive"); // not deleted
  const deleteAnswers = deleteCalls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text as string);
  assert.match(deleteAnswers.at(-1) as string, /no longer exists/i);

  const { bot: editBot, calls: editCalls } = createTestBot(db);
  await editBot.handleUpdate(callbackUpdate(999, `editfield:${victim.id}:budget`)); // acting as a different chat
  await editBot.handleUpdate(callbackUpdate(999, 'wizard:budget:700:900'));

  assert.equal(getSearchProfile(db, victim.id)!.prefs.priceTo, 900); // untouched by the attempted edit
  assert.equal(getWizardState(db, 999), null); // no edit session was ever established for the attacking chat
  const editAnswers = editCalls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text as string);
  assert.match(editAnswers[0], /no longer exists/i);
});

const NEVER_GEOCODE: GeocodeFn = async () => { throw new Error('geocode should not have been called'); };

test('getCommuteLineFor returns null when the user has no commute destination, or the listing has neither coordinates nor an address to fall back on', async () => {
  const db = openDb(':memory:');
  const noDestPrefs = { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null };
  assert.equal(await getCommuteLineFor(db, 1, row({ lat: 48.19, lon: 16.37 }), noDestPrefs, async () => ({ walkMinutes: 10, transitMinutes: null, transitSummary: null }), NEVER_GEOCODE), null);

  const withDestPrefs = { ...noDestPrefs, commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 };
  assert.equal(await getCommuteLineFor(db, 1, row({ lat: null, lon: null, addressLine: null }), withDestPrefs, async () => ({ walkMinutes: 10, transitMinutes: null, transitSummary: null }), NEVER_GEOCODE), null);
});

test('getCommuteLineFor caches the computed result and does not recompute on a second call', async () => {
  const db = openDb(':memory:');
  const prefs = { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 };
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
  const prefs = { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 };
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
  const prefs = { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: 'TU Wien', commuteLat: 48.1986, commuteLon: 16.3695 };
  const geocode: GeocodeFn = async () => null;
  const computeCommute = async (): Promise<CommuteTimes> => ({ walkMinutes: 20, transitMinutes: null, transitSummary: null });

  const [listingRow] = getCandidateListings(db, 1, prefs);
  const line = await getCommuteLineFor(db, 1, listingRow, prefs, computeCommute, geocode);

  assert.equal(line, null);
  const [persisted] = getCandidateListings(db, 1, prefs);
  assert.equal(persisted.lat, null);
});

test('a restart mid-wizard does not drop progress — this is the bug that shipped', async () => {
  const db = openDb(':memory:');
  const first = createTestBot(db);
  await first.bot.handleUpdate(commandUpdate(42, '/start'));
  await first.bot.handleUpdate(textUpdate(42, 'My Search')); // name step -> budget step

  // simulate a process restart: a brand-new Telegraf instance, same on-disk db.
  const second = createTestBot(db);
  await second.bot.handleUpdate(callbackUpdate(42, 'wizard:budget:700:900')); // should continue the wizard, not be silently ignored

  const state = getWizardState(db, 42)!;
  assert.equal(WIZARD_STEPS[state.stepIndex], 'districts', 'the post-restart tap should have advanced the wizard, not stayed silent');
  assert.equal(state.profileName, 'My Search'); // pre-restart progress preserved
  assert.equal(state.partial.priceFrom, 700);
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
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
  upsertListing(db, listing({ id: 'a', price: 500 }));
  const { bot, calls } = createTestBot(db);
  await bot.handleUpdate(callbackUpdate(1, 'like:willhaben:a'));
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery'));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('No new listings')));
});

test('a 👍 swipe on a listing deleted mid-flight (e.g. by the refresh sweep) tells the user instead of silently losing the like', async () => {
  const db = openDb(':memory:');
  createSearchProfile(db, 1, 'Test', { priceFrom: null, priceTo: 800, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null, includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false, commuteDestination: null, commuteLat: null, commuteLon: null });
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
