import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { sendPhotoCached, usablePhotoUrls } from '../src/photo.js';
import { openDb, getCachedFileId, isKnownBadPhoto, recordPhotoFailure } from '../src/db.js';

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
  assert.equal(getCachedFileId(db, 'https://cdn/a.jpg'), 'LARGEST');
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
  assert.equal(isKnownBadPhoto(db, 'https://cdn/dead.jpg'), true);
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
    usablePhotoUrls(db, ['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg']),
    ['https://cdn/a.jpg', 'https://cdn/c.jpg'],
  );
});
