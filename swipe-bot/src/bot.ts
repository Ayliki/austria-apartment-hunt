import { Telegraf, Markup } from 'telegraf';
import {
  type DB, type UserPrefs, type ListingRow,
  getUserPrefs, setUserPrefs, getCandidateListings, getSwipedWithDirection, recordSwipe, getShortlist,
} from './db.js';
import { rankListings } from './scoring.js';

export const SAFETY_NOTICE =
  'Standing safety rule: never transfer money or pay a deposit before an in-person viewing. ' +
  'Avoid international transfers and escrow/Treuhand arrangements. ' +
  'Only use the listing\'s official contact channel.';

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

/** Pure parser for the 5-question onboarding wizard answers, in order. Throws Error with a user-facing message. */
export function parseOnboardingAnswers(answers: string[]): Omit<UserPrefs, 'chatId'> {
  const [budgetMaxRaw, budgetMinRaw, districtsRaw, roomsRaw, sizeRaw] = answers;

  const priceTo = Number(budgetMaxRaw.trim());
  if (!Number.isFinite(priceTo)) throw new Error('that doesn\'t look like a budget — reply with a number, e.g. 800');

  const minTrimmed = budgetMinRaw.trim().toLowerCase();
  const priceFrom = minTrimmed === 'skip' || minTrimmed === 'any' ? null : Number(budgetMinRaw.trim());
  if (priceFrom != null && !Number.isFinite(priceFrom)) throw new Error('that doesn\'t look like a minimum budget — reply with a number or "skip"');

  const districts = parseDistrictsAnswer(districtsRaw);

  const roomsTrimmed = roomsRaw.trim().toLowerCase();
  const [roomsFrom, roomsTo] = roomsTrimmed === 'any' ? [null, null] : parseRange(roomsRaw);

  const sizeTrimmed = sizeRaw.trim().toLowerCase();
  const [areaFrom, areaTo] = sizeTrimmed === 'any' ? [null, null] : parseRange(sizeRaw);

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

function formatCaption(l: ListingRow): string {
  const price = l.price != null ? `€${l.price}` : 'price n/a';
  const area = l.area != null ? `${l.area}m²` : '';
  const rooms = l.rooms != null ? `${l.rooms} rooms` : '';
  const district = l.district != null ? `district ${l.district}` : '';
  const details = [area, rooms, district].filter(Boolean).join(' · ');
  return `${l.title}\n${price} · ${details}\n${l.url}`;
}

const onboardingState = new Map<number, string[]>();

async function sendNextCard(telegram: Telegraf['telegram'], chatId: number, db: DB): Promise<void> {
  const card = nextCardFor(db, chatId);
  if (!card) {
    await telegram.sendMessage(chatId, 'No new listings right now — check back after the next poll (every ~3h).');
    return;
  }
  const buttons = Markup.inlineKeyboard([
    Markup.button.callback('👎', `pass:${card.id}`),
    Markup.button.callback('👍', `like:${card.id}`),
  ]);
  const caption = formatCaption(card);
  if (card.images.length > 0) {
    await telegram.sendPhoto(chatId, card.images[0], { caption, ...buttons });
  } else {
    await telegram.sendMessage(chatId, `${caption}\n(no photo)`, buttons);
  }
}

export function createBot(db: DB, token: string): Telegraf {
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    onboardingState.set(ctx.chat.id, []);
    await ctx.reply(SAFETY_NOTICE);
    await ctx.reply(QUESTIONS[0]);
  });

  bot.command('settings', async (ctx) => {
    onboardingState.set(ctx.chat.id, []);
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
    const answers = onboardingState.get(ctx.chat.id);
    if (!answers) return; // not mid-onboarding, ignore free text
    answers.push(ctx.message.text);
    if (answers.length < QUESTIONS.length) {
      await ctx.reply(QUESTIONS[answers.length]);
      return;
    }
    onboardingState.delete(ctx.chat.id);
    try {
      const parsed = parseOnboardingAnswers(answers);
      setUserPrefs(db, { chatId: ctx.chat.id, ...parsed });
      await ctx.reply('Preferences saved. Here\'s your first card:');
      await sendNextCard(ctx.telegram, ctx.chat.id, db);
    } catch (err) {
      await ctx.reply(`${(err as Error).message} — let's restart: ${QUESTIONS[0]}`);
      onboardingState.set(ctx.chat.id, []);
    }
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
