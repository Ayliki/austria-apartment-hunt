import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  viennaHour, viennaDayStartIso, isQuietHour, instantThreshold, isDigestDue, MIN_THRESHOLD_SAMPLE,
} from '../src/notify-policy.js';

test('viennaHour converts UTC to Vienna local hour across DST', () => {
  // Vienna is UTC+2 in August (CEST) and UTC+1 in January (CET).
  assert.equal(viennaHour(new Date('2026-08-19T07:30:00Z')), 9);
  assert.equal(viennaHour(new Date('2026-01-19T07:30:00Z')), 8);
});

test('viennaDayStartIso returns the UTC instant of Vienna local midnight', () => {
  assert.equal(viennaDayStartIso(new Date('2026-08-19T07:30:00Z')), '2026-08-18T22:00:00.000Z');
});

test('isQuietHour handles a window that wraps past midnight', () => {
  assert.equal(isQuietHour(23, 22, 8), true);
  assert.equal(isQuietHour(3, 22, 8), true);
  assert.equal(isQuietHour(22, 22, 8), true);
  assert.equal(isQuietHour(8, 22, 8), false);
  assert.equal(isQuietHour(12, 22, 8), false);
});

test('isQuietHour handles a same-day window', () => {
  assert.equal(isQuietHour(13, 12, 14), true);
  assert.equal(isQuietHour(15, 12, 14), false);
});

test('isQuietHour treats an empty window as never quiet', () => {
  assert.equal(isQuietHour(5, 8, 8), false);
});

test('instantThreshold returns the score at the requested top percentile', () => {
  const scores = Array.from({ length: 100 }, (_, i) => i / 100); // 0.00 … 0.99
  assert.equal(instantThreshold(scores, 0.10), 0.90);
});

test('instantThreshold returns null below the minimum sample size', () => {
  const scores = Array.from({ length: MIN_THRESHOLD_SAMPLE - 1 }, () => 0.5);
  assert.equal(instantThreshold(scores, 0.10), null);
});

test('instantThreshold never returns a threshold no listing can reach', () => {
  const scores = Array.from({ length: 50 }, () => 0.5); // every listing identical
  assert.equal(instantThreshold(scores, 0.10), 0.5);
});

test('isDigestDue fires once the hour is reached and not again the same hour', () => {
  const now = new Date('2026-08-19T07:05:00Z'); // 09:05 Vienna
  assert.equal(isDigestDue(now, [9, 19], null), true);
  assert.equal(isDigestDue(now, [9, 19], '2026-08-19T07:01:00Z'), false);
});

test('isDigestDue fires again at the next configured hour', () => {
  const now = new Date('2026-08-19T17:05:00Z'); // 19:05 Vienna
  assert.equal(isDigestDue(now, [9, 19], '2026-08-19T07:01:00Z'), true);
});

test('isDigestDue does not fire between configured hours', () => {
  const now = new Date('2026-08-19T12:05:00Z'); // 14:05 Vienna
  assert.equal(isDigestDue(now, [9, 19], '2026-08-19T07:01:00Z'), false);
});

test('isDigestDue fires the next day at the same hour', () => {
  const now = new Date('2026-08-20T07:05:00Z'); // 09:05 Vienna, next day
  assert.equal(isDigestDue(now, [9, 19], '2026-08-19T17:01:00Z'), true);
});

test('isDigestDue never fires with no configured hours', () => {
  assert.equal(isDigestDue(new Date('2026-08-19T07:05:00Z'), [], null), false);
});
