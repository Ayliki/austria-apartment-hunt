import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { sendPhotoCached, usablePhotoUrls } from '../src/photo.js';
import {
  openDb, getCachedFileId, isKnownBadPhoto, recordPhotoFailure,
  PHOTO_TRANSIENT_COOLDOWN_MS, PHOTO_PERMANENT_COOLDOWN_MS,
} from '../src/db.js';

interface Call { method: string; payload: Record<string, unknown> }

let activeCalls: Call[] | null = null;
let nextResult: ((method: string) => unknown) | null = null;

(Telegram.prototype as unknown as { callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown> }).callApi =
  async function callApi(method, payload) {
    if (!activeCalls) throw new Error('callApi invoked outside a test context');
    activeCalls.push({ method, payload });
    const result = nextResult?.(method);
    if (result instanceof Error) throw result;
    if (result !== undefined) return result;
    return { message_id: activeCalls.length, date: 0, chat: { id: 0, type: 'private' } };
  };

function testTelegram(result?: (method: string) => unknown): { telegram: Telegram; calls: Call[] } {
  const telegram = new Telegram('test-token');
  const calls: Call[] = [];
  activeCalls = calls;
  nextResult = result ?? null;
  return { telegram, calls };
}

const NOW = new Date('2026-08-19T06:00:00Z');

test('sendPhotoCached sends the source url first time and stores the returned file_id', async () => {
  const db = openDb(':memory:');
  const { telegram, calls } = testTelegram(() => ({
    message_id: 1, date: 0, chat: { id: 1, type: 'private' },
    photo: [{ file_id: 'SMALL' }, { file_id: 'LARGEST' }],
  }));

  const sent = await sendPhotoCached(telegram, db, 1, 'https://cdn/a.jpg', 'caption', {}, NOW);

  assert.equal(sent, true);
  assert.equal(calls[0].method, 'sendPhoto');
  assert.equal(calls[0].payload.photo, 'https://cdn/a.jpg');
  assert.equal(getCachedFileId(db, 'https://cdn/a.jpg', NOW), 'LARGEST');
});

test('sendPhotoCached reuses the cached file_id on the second send', async () => {
  const db = openDb(':memory:');
  const first = testTelegram(() => ({
    message_id: 1, date: 0, chat: { id: 1, type: 'private' }, photo: [{ file_id: 'LARGEST' }],
  }));
  await sendPhotoCached(first.telegram, db, 1, 'https://cdn/a.jpg', 'c', {}, NOW);

  const second = testTelegram(() => ({
    message_id: 2, date: 0, chat: { id: 1, type: 'private' }, photo: [{ file_id: 'LARGEST' }],
  }));
  await sendPhotoCached(second.telegram, db, 2, 'https://cdn/a.jpg', 'c', {}, NOW);

  assert.equal(second.calls[0].payload.photo, 'LARGEST');
});

test('sendPhotoCached falls back to a text message and records the failure', async () => {
  const db = openDb(':memory:');
  const { telegram, calls } = testTelegram((method) =>
    method === 'sendPhoto' ? new Error('400: Bad Request: wrong file identifier/HTTP URL specified') : undefined);

  const sent = await sendPhotoCached(telegram, db, 1, 'https://cdn/dead.jpg', 'caption', {}, NOW);

  assert.equal(sent, false);
  assert.equal(calls[0].method, 'sendPhoto');
  assert.equal(calls[1].method, 'sendMessage');
  assert.equal(calls[1].payload.text, 'caption');
  assert.equal(isKnownBadPhoto(db, 'https://cdn/dead.jpg', NOW), true);
});

test('a blocked chat does not blacklist the photo for everyone else', async () => {
  const db = openDb(':memory:');
  const { telegram, calls } = testTelegram((method) =>
    method === 'sendPhoto' ? new Error('403: Forbidden: bot was blocked by the user') : undefined);

  // photo_cache is keyed by url and shared by every user, so recording a chat-level rejection here
  // would suppress a perfectly good image for every other user for an hour.
  const sent = await sendPhotoCached(telegram, db, 1, 'https://cdn/fine.jpg', 'caption', {}, NOW);

  assert.equal(sent, false);
  assert.equal(isKnownBadPhoto(db, 'https://cdn/fine.jpg', NOW), false, 'the photo is fine, the chat is not');
  assert.equal(calls[0].method, 'sendPhoto');
  assert.equal(calls[1].method, 'sendMessage', 'the text fallback still runs');
});

test('a chat-not-found rejection also leaves the url usable', async () => {
  const db = openDb(':memory:');
  const { telegram } = testTelegram((method) =>
    method === 'sendPhoto' ? new Error('400: Bad Request: chat not found') : undefined);

  await sendPhotoCached(telegram, db, 1, 'https://cdn/fine2.jpg', 'caption', {}, NOW);

  assert.equal(isKnownBadPhoto(db, 'https://cdn/fine2.jpg', NOW), false);
});

test('a transient network rejection still suppresses the url, so the split is not a blanket opt-out', async () => {
  const db = openDb(':memory:');
  const { telegram } = testTelegram((method) =>
    method === 'sendPhoto' ? new Error('429: Too Many Requests: retry after 5') : undefined);

  await sendPhotoCached(telegram, db, 1, 'https://cdn/flaky2.jpg', 'caption', {}, NOW);

  assert.equal(isKnownBadPhoto(db, 'https://cdn/flaky2.jpg', NOW), true);
});

test('sendPhotoCached never throws even when the text fallback also fails', async () => {
  const db = openDb(':memory:');
  const { telegram } = testTelegram(() => new Error('network down'));
  const sent = await sendPhotoCached(telegram, db, 1, 'https://cdn/dead.jpg', 'caption', {}, NOW);
  assert.equal(sent, false);
});

test('sendPhotoCached skips the photo attempt entirely for a known-bad url', async () => {
  const db = openDb(':memory:');
  recordPhotoFailure(db, 'https://cdn/dead.jpg', 'previously failed', NOW.toISOString());
  const { telegram, calls } = testTelegram();

  await sendPhotoCached(telegram, db, 1, 'https://cdn/dead.jpg', 'caption', {}, NOW);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
});

test('usablePhotoUrls drops known-bad urls and preserves order', () => {
  const db = openDb(':memory:');
  recordPhotoFailure(db, 'https://cdn/b.jpg', 'dead', NOW.toISOString());
  assert.deepEqual(
    usablePhotoUrls(db, ['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg'], NOW),
    ['https://cdn/a.jpg', 'https://cdn/c.jpg'],
  );
});

const TRANSIENT_ERROR = '429: Too Many Requests: retry after 30';
const PERMANENT_ERROR = '400: Bad Request: failed to get HTTP URL content';
const later = (ms: number) => new Date(NOW.getTime() + ms);

test('a transient failure is retried once the cooldown has elapsed', async () => {
  const db = openDb(':memory:');
  recordPhotoFailure(db, 'https://cdn/blip.jpg', TRANSIENT_ERROR, NOW.toISOString());

  const after = later(PHOTO_TRANSIENT_COOLDOWN_MS + 1000);
  assert.equal(isKnownBadPhoto(db, 'https://cdn/blip.jpg', after), false);

  const { telegram, calls } = testTelegram(() => ({
    message_id: 1, date: 0, chat: { id: 1, type: 'private' }, photo: [{ file_id: 'LARGEST' }],
  }));
  const sent = await sendPhotoCached(telegram, db, 1, 'https://cdn/blip.jpg', 'caption', {}, after);

  assert.equal(sent, true);
  assert.equal(calls[0].method, 'sendPhoto');
  assert.equal(calls[0].payload.photo, 'https://cdn/blip.jpg');
});

test('a transient failure is NOT retried before the cooldown has elapsed', async () => {
  const db = openDb(':memory:');
  recordPhotoFailure(db, 'https://cdn/blip.jpg', TRANSIENT_ERROR, NOW.toISOString());

  const during = later(PHOTO_TRANSIENT_COOLDOWN_MS - 1000);
  assert.equal(isKnownBadPhoto(db, 'https://cdn/blip.jpg', during), true);

  const { telegram, calls } = testTelegram();
  await sendPhotoCached(telegram, db, 1, 'https://cdn/blip.jpg', 'caption', {}, during);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
});

test('a permanent-looking failure stays suppressed long after the transient cooldown would lapse', () => {
  const db = openDb(':memory:');
  recordPhotoFailure(db, 'https://cdn/dead.jpg', PERMANENT_ERROR, NOW.toISOString());

  assert.equal(isKnownBadPhoto(db, 'https://cdn/dead.jpg', later(PHOTO_TRANSIENT_COOLDOWN_MS * 24)), true);
  assert.equal(isKnownBadPhoto(db, 'https://cdn/dead.jpg', later(PHOTO_PERMANENT_COOLDOWN_MS - 1000)), true);
  // Even a permanent-looking failure eventually lapses — origins do come back.
  assert.equal(isKnownBadPhoto(db, 'https://cdn/dead.jpg', later(PHOTO_PERMANENT_COOLDOWN_MS + 1000)), false);
});

test('usablePhotoUrls re-admits a url whose transient cooldown has lapsed', () => {
  const db = openDb(':memory:');
  recordPhotoFailure(db, 'https://cdn/b.jpg', TRANSIENT_ERROR, NOW.toISOString());
  recordPhotoFailure(db, 'https://cdn/c.jpg', PERMANENT_ERROR, NOW.toISOString());

  const after = later(PHOTO_TRANSIENT_COOLDOWN_MS + 1000);
  assert.deepEqual(
    usablePhotoUrls(db, ['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg'], after),
    ['https://cdn/a.jpg', 'https://cdn/b.jpg'],
  );
});

test('a successful send after a prior failure clears the failed state', async () => {
  const db = openDb(':memory:');
  recordPhotoFailure(db, 'https://cdn/blip.jpg', TRANSIENT_ERROR, NOW.toISOString());

  const after = later(PHOTO_TRANSIENT_COOLDOWN_MS + 1000);
  const { telegram } = testTelegram(() => ({
    message_id: 1, date: 0, chat: { id: 1, type: 'private' }, photo: [{ file_id: 'LARGEST' }],
  }));
  await sendPhotoCached(telegram, db, 1, 'https://cdn/blip.jpg', 'caption', {}, after);

  assert.equal(isKnownBadPhoto(db, 'https://cdn/blip.jpg', after), false);
  assert.equal(getCachedFileId(db, 'https://cdn/blip.jpg', after), 'LARGEST');
  // And it stays cleared far beyond any cooldown, rather than resurfacing as bad.
  assert.equal(isKnownBadPhoto(db, 'https://cdn/blip.jpg', later(PHOTO_PERMANENT_COOLDOWN_MS * 2)), false);
});

test('a cached file_id survives a transient failure and is reused once the cooldown lapses', async () => {
  const db = openDb(':memory:');
  const first = testTelegram(() => ({
    message_id: 1, date: 0, chat: { id: 1, type: 'private' }, photo: [{ file_id: 'LARGEST' }],
  }));
  await sendPhotoCached(first.telegram, db, 1, 'https://cdn/a.jpg', 'c', {}, NOW);
  recordPhotoFailure(db, 'https://cdn/a.jpg', TRANSIENT_ERROR, NOW.toISOString());

  const after = later(PHOTO_TRANSIENT_COOLDOWN_MS + 1000);
  const second = testTelegram(() => ({
    message_id: 2, date: 0, chat: { id: 1, type: 'private' }, photo: [{ file_id: 'LARGEST' }],
  }));
  await sendPhotoCached(second.telegram, db, 2, 'https://cdn/a.jpg', 'c', {}, after);

  assert.equal(second.calls[0].payload.photo, 'LARGEST');
});
