import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGetListingError, refreshAllListings, type ListingFetcher,
} from '../src/refresh.js';
import {
  openDb, upsertListing, setListingDelisted, getListingsByIds, recordSwipe, getShortlist,
} from '../src/db.js';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
  return {
    source: 'willhaben', id: '1', url: 'https://x/1', title: 'Test flat',
    price: 650, pricePerSqm: 15, area: 43, rooms: 2, district: 6, zip: '1060',
    addressLine: null, lat: null, lon: null, isPrivate: true,
    requiresWaitlistTicket: false, isShortTerm: false, isWg: false, images: ['https://img/old.jpg'], description: null,
    dateCreated: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

const WH_DETAIL_TEXT = `# Sanierte Garconniere

💰 **Price:** € 650
🏠 **Address:** 1060, Wien, 06. Bezirk, Mariahilf, Österreich
📍 **Coordinates:** 48.2,16.35
📞 **Contact:** EMAIL

## Key Details
- **Living Area:** 43

## Images (2)
https://cache.willhaben.at/img/1.jpg
https://cache.willhaben.at/img/2.jpg`;

function fetcherReturning(text: string): ListingFetcher {
  return { callToolText: async () => text };
}

function fetcherThrowing(message: string): ListingFetcher {
  return { callToolText: async () => { throw new Error(message); } };
}

const noDelay = { delayMs: 0, sleep: async () => {} };

test('classifyGetListingError: willhaben "not found" is not-found, anything else is transient', () => {
  assert.equal(
    classifyGetListingError('willhaben', new Error('willhaben_get_listing failed: Listing 1370327604 not found. Make sure the ID is correct.')),
    'not-found',
  );
  assert.equal(
    classifyGetListingError('willhaben', new Error('willhaben_get_listing failed: Error getting listing detail: fetch failed')),
    'transient',
  );
});

test('classifyGetListingError: immoscout HTTP 404 and "no Expose" are not-found, other HTTP errors are transient', () => {
  assert.equal(
    classifyGetListingError('immoscout', new Error('immoscout_get_listing failed: Error: GET https://www.immobilienscout24.at/expose/123 failed with HTTP 404')),
    'not-found',
  );
  assert.equal(
    classifyGetListingError('immoscout', new Error('immoscout_get_listing failed: Error: ImmoScout24 expose structure changed: no Expose:* entity in window.__APOLLO_STATE__')),
    'not-found',
  );
  assert.equal(
    classifyGetListingError('immoscout', new Error('immoscout_get_listing failed: Error: GET https://www.immobilienscout24.at/expose/123 failed with HTTP 429')),
    'transient',
  );
});

test('refreshAllListings updates images/address/coords on a successful willhaben fetch', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));

  const summary = await refreshAllListings(db, {
    willhaben: fetcherReturning(WH_DETAIL_TEXT),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  const [row] = getListingsByIds(db, ['willhaben:a']);
  assert.deepEqual(row.images, ['https://cache.willhaben.at/img/1.jpg', 'https://cache.willhaben.at/img/2.jpg']);
  assert.equal(row.addressLine, '1060, Wien, 06. Bezirk, Mariahilf, Österreich');
  assert.equal(row.lat, 48.2);
  assert.equal(row.lon, 16.35);
  assert.deepEqual(summary.willhaben, { checked: 1, updated: 1, delisted: 0, errored: 0 });
});

test('refreshAllListings updates images/address on a successful immoscout fetch (no coords available from detail)', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a', source: 'immoscout' }));

  const detail = JSON.stringify({ address: '1070 Wien, Neubaugasse 1', images: [{ url: 'https://img/1.jpg' }, { url: 'https://img/2.jpg' }] });
  const summary = await refreshAllListings(db, {
    willhaben: fetcherReturning(WH_DETAIL_TEXT),
    immoscout: fetcherReturning(detail),
  }, noDelay);

  const [row] = getListingsByIds(db, ['immoscout:a']);
  assert.deepEqual(row.images, ['https://img/1.jpg', 'https://img/2.jpg']);
  assert.equal(row.addressLine, '1070 Wien, Neubaugasse 1');
  assert.equal(row.lat, null); // immoscout detail never carries coords — the lazy geocode fallback handles this later
  assert.equal(summary.immoscout.updated, 1);
});

test('refreshAllListings flags a "not found" willhaben listing as delisted, without touching its stored data', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'gone', images: ['https://img/keep.jpg'] }));
  // Shortlisted so the end-of-sweep deleteDelistedUnshortlisted (exercised separately below) doesn't
  // remove the row — this test is about the flag+data-preservation behavior, not deletion.
  recordSwipe(db, 1, 'willhaben:gone', 'like');

  const summary = await refreshAllListings(db, {
    willhaben: fetcherThrowing('willhaben_get_listing failed: Listing gone not found. Make sure the ID is correct.'),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  const [row] = getListingsByIds(db, ['willhaben:gone']);
  assert.equal(row.isDelisted, true);
  assert.deepEqual(row.images, ['https://img/keep.jpg']); // data untouched, only the flag changed
  assert.equal(summary.willhaben.delisted, 1);
  assert.equal(summary.willhaben.updated, 0);
});

test('refreshAllListings leaves a listing untouched on a transient error (not flagged, not updated)', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'flaky' }));

  const summary = await refreshAllListings(db, {
    willhaben: fetcherThrowing('willhaben_get_listing failed: Error getting listing detail: network error'),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  const [row] = getListingsByIds(db, ['willhaben:flaky']);
  assert.equal(row.isDelisted, false);
  assert.equal(summary.willhaben.errored, 1);
  assert.equal(summary.willhaben.delisted, 0);
  assert.equal(summary.willhaben.updated, 0);
});

test('refreshAllListings deletes delisted-and-unshortlisted rows after the sweep, keeps shortlisted ones flagged', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'gone-unshortlisted' }));
  upsertListing(db, listing({ id: 'gone-shortlisted' }));
  recordSwipe(db, 1, 'willhaben:gone-shortlisted', 'like');

  const notFound = 'willhaben_get_listing failed: Listing x not found. Make sure the ID is correct.';
  const summary = await refreshAllListings(db, {
    willhaben: fetcherThrowing(notFound),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  assert.equal(summary.deleted, 1);
  assert.deepEqual(getListingsByIds(db, ['willhaben:gone-unshortlisted']), []);
  assert.equal(getShortlist(db, 1).length, 1);
  assert.equal(getShortlist(db, 1)[0].isDelisted, true);
});

test('refreshAllListings un-flags a previously misflagged listing on a fresh successful fetch', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));
  setListingDelisted(db, 'willhaben:a', true);

  await refreshAllListings(db, {
    willhaben: fetcherReturning(WH_DETAIL_TEXT),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  const [row] = getListingsByIds(db, ['willhaben:a']);
  assert.equal(row.isDelisted, false);
});

test('refreshAllListings sweeps both sources independently and sums checked counts correctly', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: '1', source: 'willhaben' }));
  upsertListing(db, listing({ id: '2', source: 'willhaben' }));
  upsertListing(db, listing({ id: '3', source: 'immoscout' }));

  const summary = await refreshAllListings(db, {
    willhaben: fetcherReturning(WH_DETAIL_TEXT),
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  assert.equal(summary.willhaben.checked, 2);
  assert.equal(summary.immoscout.checked, 1);
});
