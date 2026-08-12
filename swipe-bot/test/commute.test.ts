import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  geocode, computeCommute, formatCommuteLine, parseDurationMinutes, firstTransitLineLabel,
} from '../src/commute.js';

test('parseDurationMinutes rounds up to whole minutes, tolerates missing/malformed input', () => {
  assert.equal(parseDurationMinutes('120s'), 2);
  assert.equal(parseDurationMinutes('121s'), 3); // rounds up, never underestimates a commute
  assert.equal(parseDurationMinutes(undefined), null);
  assert.equal(parseDurationMinutes('not-a-duration'), null);
});

test('firstTransitLineLabel formats vehicle + line name, falls back sensibly', () => {
  assert.equal(
    firstTransitLineLabel({ legs: [{ steps: [{ transitDetails: { transitLine: { nameShort: 'D', vehicle: { type: 'TRAM' } } } }] }] }),
    'tram D',
  );
  assert.equal(
    firstTransitLineLabel({ legs: [{ steps: [{ transitDetails: { transitLine: { name: 'Bus 13A', vehicle: { type: 'BUS' } } } }] }] }),
    'bus Bus 13A', // no nameShort — falls back to the full name
  );
  assert.equal(
    firstTransitLineLabel({ legs: [{ steps: [{ transitDetails: { transitLine: { nameShort: 'X', vehicle: { type: 'UNKNOWN_TYPE' } } } }] }] }),
    'transit X', // unmapped vehicle type still produces something, not a crash
  );
  assert.equal(firstTransitLineLabel({ legs: [{ steps: [{}] }] }), null); // no transitDetails on the step
  assert.equal(firstTransitLineLabel(undefined), null);
});

test('formatCommuteLine combines walk + transit, omits whichever is missing, null when both are', () => {
  assert.equal(
    formatCommuteLine({ walkMinutes: 18, transitMinutes: 7, transitSummary: 'tram D' }, 'TU Wien'),
    '📍 18 min walk · 7 min by tram D to TU Wien',
  );
  assert.equal(
    formatCommuteLine({ walkMinutes: 18, transitMinutes: null, transitSummary: null }, 'TU Wien'),
    '📍 18 min walk to TU Wien',
  );
  assert.equal(
    formatCommuteLine({ walkMinutes: null, transitMinutes: 7, transitSummary: null }, 'TU Wien'),
    '📍 7 min by transit to TU Wien', // no line name known — falls back to the generic word
  );
  assert.equal(formatCommuteLine({ walkMinutes: null, transitMinutes: null, transitSummary: null }, 'TU Wien'), null);
});

// --- Integration tests: stub global fetch, restore it after each test to avoid leaking into other files. ---

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = original; });
}

test('geocode returns the first result\'s coordinates on an OK response', async () => {
  const point = await withFetch(
    (async () => new Response(JSON.stringify({
      status: 'OK',
      results: [{ geometry: { location: { lat: 48.1986, lng: 16.3695 } } }],
    }))) as typeof fetch,
    () => geocode('TU Wien', 'fake-key'),
  );
  assert.deepEqual(point, { lat: 48.1986, lon: 16.3695 });
});

test('geocode returns null on ZERO_RESULTS or an empty results array', async () => {
  const point = await withFetch(
    (async () => new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }))) as typeof fetch,
    () => geocode('somewhere that does not exist', 'fake-key'),
  );
  assert.equal(point, null);
});

test('geocode biases the query to Vienna and passes the API key', async () => {
  let capturedUrl: URL | undefined;
  await withFetch(
    (async (url: URL) => { capturedUrl = url; return new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] })); }) as typeof fetch,
    () => geocode('TU Wien', 'my-api-key'),
  );
  assert.match(capturedUrl!.searchParams.get('address')!, /TU Wien.*Wien.*Austria/);
  assert.equal(capturedUrl!.searchParams.get('key'), 'my-api-key');
});

function routesResponseFor(travelMode: string): Response {
  if (travelMode === 'WALK') {
    return new Response(JSON.stringify({ routes: [{ duration: '1080s' }] })); // 18 min
  }
  return new Response(JSON.stringify({
    routes: [{ duration: '420s', legs: [{ steps: [{ transitDetails: { transitLine: { nameShort: 'D', vehicle: { type: 'TRAM' } } } }] }] }],
  })); // 7 min
}

test('computeCommute fetches both WALK and TRANSIT and combines them into one result', async () => {
  const times = await withFetch(
    (async (_url: unknown, init: RequestInit) => {
      const { travelMode } = JSON.parse(init.body as string);
      return routesResponseFor(travelMode);
    }) as typeof fetch,
    () => computeCommute({ lat: 48.19, lon: 16.37 }, { lat: 48.1986, lon: 16.3695 }, 'fake-key'),
  );
  assert.deepEqual(times, { walkMinutes: 18, transitMinutes: 7, transitSummary: 'tram D' });
});

test('computeCommute degrades to nulls (never throws) when the Routes API call fails', async () => {
  const times = await withFetch(
    (async () => new Response('server error', { status: 500 })) as typeof fetch,
    () => computeCommute({ lat: 48.19, lon: 16.37 }, { lat: 48.1986, lon: 16.3695 }, 'fake-key'),
  );
  assert.deepEqual(times, { walkMinutes: null, transitMinutes: null, transitSummary: null });
});

test('computeCommute degrades to nulls when fetch itself rejects (network error)', async () => {
  const times = await withFetch(
    (async () => { throw new Error('network down'); }) as typeof fetch,
    () => computeCommute({ lat: 48.19, lon: 16.37 }, { lat: 48.1986, lon: 16.3695 }, 'fake-key'),
  );
  assert.deepEqual(times, { walkMinutes: null, transitMinutes: null, transitSummary: null });
});

test('computeCommute keeps whichever leg succeeded when only one of WALK/TRANSIT fails', async () => {
  const times = await withFetch(
    (async (_url: unknown, init: RequestInit) => {
      const { travelMode } = JSON.parse(init.body as string);
      if (travelMode === 'TRANSIT') throw new Error('transit lookup failed');
      return routesResponseFor(travelMode);
    }) as typeof fetch,
    () => computeCommute({ lat: 48.19, lon: 16.37 }, { lat: 48.1986, lon: 16.3695 }, 'fake-key'),
  );
  assert.equal(times.walkMinutes, 18);
  assert.equal(times.transitMinutes, null);
});
