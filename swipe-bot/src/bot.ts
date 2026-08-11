import { Telegraf, Markup } from 'telegraf';
import {
  type DB, type UserPrefs, type ListingRow,
  getUserPrefs, setUserPrefs, getCandidateListings, getSwipedWithDirection, recordSwipe, getShortlist,
  getOnboardingState, setOnboardingState, deleteOnboardingState,
} from './db.js';
import { rankListings } from './scoring.js';

export const SAFETY_NOTICE =
  'Standing safety rule: never transfer money or pay a deposit before an in-person viewing. ' +
  'Avoid international transfers and escrow/Treuhand arrangements. ' +
  'Only use the listing\'s official contact channel.';

export const ONBOARDING_INTRO =
  'Quick 5-question setup. Reply with just the value in the format shown in each question ' +
  '(e.g. "800", not "my budget is 800 euros") — free text won\'t parse.';

const QUESTIONS = [
  'What\'s your max budget (cold, in EUR)?',
  'Min budget? (number, or "skip")',
  'Districts? e.g. "1-9" or "6,7,9", or "any"',
  'Rooms, min-max? e.g. "1-2", or "any"',
  'Size in m², min-max? e.g. "30-60", or "any"',
];

function parseRange(s: string): [number | null, number | null] {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = Number(s.trim());
  if (Number.isFinite(n)) return [n, n];
  throw new Error(`could not parse range "${s}" — use "min-max" or "any"`);
}

function parseDistrictsAnswer(s: string): number[] | null {
  const trimmed = s.trim().toLowerCase();
  if (trimmed === 'any' || trimmed === 'skip') return null;
  const out: number[] = [];
  for (const part of s.split(',')) {
    const range = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (range) {
      for (let d = parseInt(range[1], 10); d <= parseInt(range[2], 10); d++) out.push(d);
    } else if (/^\d{1,2}$/.test(part.trim())) {
      out.push(parseInt(part.trim(), 10));
    } else {
      throw new Error(`could not parse districts "${s}"`);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function parseBudgetMax(s: string): number {
  const n = Number(s.trim());
  if (!Number.isFinite(n)) throw new Error('that doesn\'t look like a budget — reply with a number, e.g. 800');
  return n;
}

function parseBudgetMin(s: string): number | null {
  const trimmed = s.trim().toLowerCase();
  if (trimmed === 'skip' || trimmed === 'any') return null;
  const n = Number(s.trim());
  if (!Number.isFinite(n)) throw new Error('that doesn\'t look like a minimum budget — reply with a number or "skip"');
  return n;
}

function parseRoomsOrSize(s: string): [number | null, number | null] {
  if (s.trim().toLowerCase() === 'any') return [null, null];
  return parseRange(s);
}

/** One parser per onboarding question, in order. Each throws Error with a user-facing message on invalid input. */
const STEP_PARSERS: ((raw: string) => unknown)[] = [
  parseBudgetMax, parseBudgetMin, parseDistrictsAnswer, parseRoomsOrSize, parseRoomsOrSize,
];

/** Validates a single onboarding answer against its question's parser. Throws on invalid input. */
export function parseOnboardingStep(index: number, raw: string): void {
  STEP_PARSERS[index](raw);
}

/** Pure parser for the 5-question onboarding wizard answers, in order. Throws Error with a user-facing message. */
export function parseOnboardingAnswers(answers: string[]): Omit<UserPrefs, 'chatId'> {
  const priceTo = parseBudgetMax(answers[0]);
  const priceFrom = parseBudgetMin(answers[1]);
  const districts = parseDistrictsAnswer(answers[2]);
  const [roomsFrom, roomsTo] = parseRoomsOrSize(answers[3]);
  const [areaFrom, areaTo] = parseRoomsOrSize(answers[4]);
  return { priceFrom, priceTo, districts, roomsFrom, roomsTo, areaFrom, areaTo };
}

/** Top-ranked, not-yet-swiped listing for this user, or null if the queue is empty. */
export function nextCardFor(db: DB, chatId: number): ListingRow | null {
  const prefs = getUserPrefs(db, chatId);
  if (!prefs) return null;
  const candidates = getCandidateListings(db, chatId, prefs);
  if (candidates.length === 0) return null;
  const swiped = getSwipedWithDirection(db, chatId);
  return rankListings(candidates, swiped)[0];
}

/** Telegram's hard cap on caption length for photos and media groups alike. */
const MAX_CAPTION_LENGTH = 1024;

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trimEnd() + '…';
}

/** Pure — builds the card caption (title, price/size/rooms/district, description, link). Exported for direct testing. */
export function formatCaption(l: ListingRow): string {
  const price = l.price != null ? `€${l.price}` : 'price n/a';
  const area = l.area != null ? `${l.area}m²` : '';
  const rooms = l.rooms != null ? `${l.rooms} rooms` : '';
  const district = l.district != null ? `district ${l.district}` : '';
  const details = [area, rooms, district].filter(Boolean).join(' · ');
  const base = `${l.title}\n${price} · ${details}\n${l.url}`;
  const full = l.description ? `${base}\n\n${l.description}` : base;
  return truncate(full, MAX_CAPTION_LENGTH);
}

/** Telegram's hard cap on items in a single sendMediaGroup call. */
export const MAX_MEDIA_GROUP_ITEMS = 10;

interface MediaGroupItem {
  type: 'photo';
  media: string;
  caption?: string;
}

/** Pure — builds a sendMediaGroup payload, capped to Telegram's limit, caption attached to the first item only (Telegram renders it as the album's caption). */
export function buildMediaGroup(images: string[], caption: string): MediaGroupItem[] {
  return images.slice(0, MAX_MEDIA_GROUP_ITEMS).map((url, i) => ({
    type: 'photo' as const,
    media: url,
    ...(i === 0 ? { caption } : {}),
  }));
}

async function sendNextCard(telegram: Telegraf['telegram'], chatId: number, db: DB): Promise<void> {
  if (!getUserPrefs(db, chatId)) {
    await telegram.sendMessage(chatId, 'You haven\'t set your preferences yet — send /start to get set up.');
    return;
  }
  const card = nextCardFor(db, chatId);
  if (!card) {
    await telegram.sendMessage(chatId, 'No new listings right now — check back after the next poll (every ~3h).');
    return;
  }
  const caption = formatCaption(card);
  const buttons = Markup.inlineKeyboard([
    Markup.button.callback('👎', `pass:${card.id}`),
    Markup.button.callback('👍', `like:${card.id}`),
  ]);

  if (card.images.length >= 2) {
    // sendMediaGroup can't carry an inline keyboard on any item — send the album, then the buttons separately.
    await telegram.sendMediaGroup(chatId, buildMediaGroup(card.images, caption));
    await telegram.sendMessage(chatId, '👍 or 👎?', buttons);
  } else if (card.images.length === 1) {
    await telegram.sendPhoto(chatId, card.images[0], { caption, ...buttons });
  } else {
    await telegram.sendMessage(chatId, `${caption}\n(no photo)`, buttons);
  }
}

export function createBot(db: DB, token: string): Telegraf {
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    setOnboardingState(db, ctx.chat.id, []);
    await ctx.reply(SAFETY_NOTICE);
    await ctx.reply(ONBOARDING_INTRO);
    await ctx.reply(QUESTIONS[0]);
  });

  bot.command('settings', async (ctx) => {
    setOnboardingState(db, ctx.chat.id, []);
    await ctx.reply(ONBOARDING_INTRO);
    await ctx.reply(QUESTIONS[0]);
  });

  bot.command('shortlist', async (ctx) => {
    const items = getShortlist(db, ctx.chat.id);
    if (items.length === 0) {
      await ctx.reply('Your shortlist is empty — 👍 a card to save it here.');
      return;
    }
    const lines = items.map((l) => `${l.title} — €${l.price ?? '?'} — ${l.url}`);
    await ctx.reply(lines.join('\n\n'));
  });

  bot.command('next', async (ctx) => {
    await sendNextCard(ctx.telegram, ctx.chat.id, db);
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const answers = getOnboardingState(db, chatId);
    if (!answers) return; // not mid-onboarding, ignore free text

    try {
      parseOnboardingStep(answers.length, ctx.message.text);
    } catch (err) {
      await ctx.reply((err as Error).message);
      return; // keep the same question, don't advance or lose prior answers
    }

    answers.push(ctx.message.text);
    if (answers.length < QUESTIONS.length) {
      setOnboardingState(db, chatId, answers);
      await ctx.reply(QUESTIONS[answers.length]);
      return;
    }

    deleteOnboardingState(db, chatId);
    const parsed = parseOnboardingAnswers(answers);
    setUserPrefs(db, { chatId, ...parsed });
    await ctx.reply('Preferences saved. Here\'s your first card:');
    await sendNextCard(ctx.telegram, chatId, db);
  });

  bot.action(/^(like|pass):(.+)$/, async (ctx) => {
    const [, direction, listingId] = ctx.match;
    const chatId = ctx.chat!.id;
    recordSwipe(db, chatId, listingId, direction as 'like' | 'pass');
    await ctx.answerCbQuery(direction === 'like' ? 'Saved to shortlist 👍' : 'Passed 👎');
    await sendNextCard(ctx.telegram, chatId, db);
  });

  return bot;
}
