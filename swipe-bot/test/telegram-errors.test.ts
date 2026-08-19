import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPermanentChatError } from '../src/telegram-errors.js';

test('every 403-class rejection reads as a permanently unreachable chat', () => {
  const permanent = [
    new Error('403: Forbidden: bot was blocked by the user'),
    new Error('403: Forbidden: user is deactivated'),
    new Error('400: Bad Request: chat not found'),
    new Error('403: Forbidden: bot was kicked from the group chat'),
    Object.assign(new Error('some wording we have never seen'), { code: 403 }),
    Object.assign(new Error('some wording we have never seen'), { error_code: 403 }),
  ];
  for (const err of permanent) {
    assert.equal(isPermanentChatError(err), true, `expected permanent: ${String(err)}`);
  }
});

test('rate limits, server errors and image problems read as transient', () => {
  const transient = [
    new Error('429: Too Many Requests: retry after 30'),
    new Error('500: Internal Server Error'),
    new Error('400: Bad Request: wrong file identifier/HTTP URL specified'),
    new Error('400: Bad Request: failed to get HTTP URL content'),
    new Error('network timeout'),
    Object.assign(new Error('429: Too Many Requests'), { code: 429 }),
  ];
  for (const err of transient) {
    assert.equal(isPermanentChatError(err), false, `expected transient: ${String(err)}`);
  }
});

test('a non-Error rejection never throws and never reads as permanent', () => {
  assert.equal(isPermanentChatError(undefined), false);
  assert.equal(isPermanentChatError(null), false);
  assert.equal(isPermanentChatError({ nothing: true }), false);
  assert.equal(isPermanentChatError('403: Forbidden: bot was blocked by the user'), true);
});
