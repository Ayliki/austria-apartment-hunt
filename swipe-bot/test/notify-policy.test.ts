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

/** Reads the Vienna wall-clock fields of an instant, independently of the implementation under test. */
function viennaWallClock(iso: string): { date: string; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

test('viennaDayStartIso returns the UTC instant of Vienna local midnight', () => {
  assert.equal(viennaDayStartIso(new Date('2026-08-19T07:30:00Z')), '2026-08-18T22:00:00.000Z');
});

// The returned instant must BE Vienna midnight, whatever offset happens to apply that day. Asserting
// the property rather than a literal is what makes these meaningful on the transition days.
for (const [label, probe, expectedDay] of [
  ['spring-forward day', '2026-03-29T08:00:00Z', '2026-03-29'],
  ['fall-back day', '2026-10-25T09:00:00Z', '2026-10-25'],
  ['a normal summer day', '2026-08-19T07:30:00Z', '2026-08-19'],
  ['a normal winter day', '2026-01-19T07:30:00Z', '2026-01-19'],
] as const) {
  test(`viennaDayStartIso lands on Vienna 00:00 on ${label}`, () => {
    const wall = viennaWallClock(viennaDayStartIso(new Date(probe)));
    assert.equal(wall.hour, 0, `expected Vienna hour 0, got ${wall.hour}`);
    assert.equal(wall.minute, 0);
    assert.equal(wall.second, 0);
    assert.equal(wall.date, expectedDay);
  });
}

test('viennaDayStartIso is idempotent on an instant that already is Vienna midnight', () => {
  for (const probe of ['2026-03-29T08:00:00Z', '2026-10-25T09:00:00Z', '2026-08-19T07:30:00Z', '2026-01-19T07:30:00Z']) {
    const once = viennaDayStartIso(new Date(probe));
    assert.equal(viennaDayStartIso(new Date(once)), once);
  }
});

test('isDigestDue does not re-fire on the fall-back day for an hour-0 digest', () => {
  // 2026-10-25 01:30 Vienna (CEST, still the first pass through 02:00) — the day's 00:00 digest
  // already went out at 00:10 Vienna. A day-start that is off by an hour makes this fire twice.
  const now = new Date('2026-10-24T23:30:00Z');
  assert.equal(isDigestDue(now, [0], '2026-10-24T22:10:00Z'), false);
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
