import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGetListingError, refreshAllListings, exceedsBlastRadius, type ListingFetcher, type SourceRefreshSummary,
} from '../src/refresh.js';
import {
  openDb, upsertListing, setListingDelisted, getListingsByIds, recordSwipe, getShortlist,
} from '../src/db.js';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';
import type { SourceName } from 'apt-hunter/dist/hunt.js';

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

/**
 * These tests exercise sweep mechanics, not deployment policy, so they opt both sources in
 * explicitly. The default set is immoscout-only (apt-hunter's DEFAULT_SOURCES); the tests that
 * cover *that* pass their own `sources` or omit it deliberately.
 */
const noDelay = { delayMs: 0, sleep: async () => {}, sources: ['immoscout', 'willhaben'] as SourceName[] };

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
  assert.deepEqual(summary.willhaben, { checked: 1, updated: 1, delisted: 0, errored: 0, skipped: false });
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

test('exceedsBlastRadius: false for a normal small delisted count, true once it crosses max(10, checked*0.25)', () => {
  const small: SourceRefreshSummary = { checked: 100, updated: 90, delisted: 5, errored: 5 };
  assert.equal(exceedsBlastRadius(small), false);

  // checked*0.25 = 25, so 25 is still within bounds (not > threshold) but 26 trips it.
  const atThreshold: SourceRefreshSummary = { checked: 100, updated: 75, delisted: 25, errored: 0 };
  assert.equal(exceedsBlastRadius(atThreshold), false);
  const overThreshold: SourceRefreshSummary = { checked: 100, updated: 74, delisted: 26, errored: 0 };
  assert.equal(exceedsBlastRadius(overThreshold), true);

  // Below the floor of 10, even 100% delisted doesn't trip it.
  const tinySource: SourceRefreshSummary = { checked: 5, updated: 0, delisted: 5, errored: 0 };
  assert.equal(exceedsBlastRadius(tinySource), false);
  // Once checked is small, the floor of 10 (not the fraction) governs.
  const overFloor: SourceRefreshSummary = { checked: 5, updated: 0, delisted: 11, errored: 0 };
  assert.equal(exceedsBlastRadius(overFloor), true);
});

test('refreshAllListings skips the delete pass entirely (both sources) when one source trips the blast-radius guard', async () => {
  const db = openDb(':memory:');
  // 16 willhaben rows, all of which will come back "not found" — clears the max(10, checked*0.25) floor (16*0.25=4, so floor=10 governs; 16 > 10 trips it).
  for (let i = 0; i < 16; i++) {
    upsertListing(db, listing({ id: `wh-${i}` }));
  }
  // One genuinely-gone immoscout row too, to confirm its deletion is also skipped by the global guard.
  upsertListing(db, listing({ id: 'im-gone', source: 'immoscout' }));

  const notFoundWillhaben = 'willhaben_get_listing failed: Listing x not found. Make sure the ID is correct.';
  const notFoundImmoscout = 'immoscout_get_listing failed: Error: GET https://www.immobilienscout24.at/expose/123 failed with HTTP 404';
  const summary = await refreshAllListings(db, {
    willhaben: fetcherThrowing(notFoundWillhaben),
    immoscout: fetcherThrowing(notFoundImmoscout),
  }, noDelay);

  assert.equal(summary.deleted, 0);
  assert.deepEqual(summary.deletionSkippedFor, ['willhaben']);
  // Rows are still flagged delisted, not deleted.
  const rows = getListingsByIds(db, Array.from({ length: 16 }, (_, i) => `willhaben:wh-${i}`));
  assert.equal(rows.length, 16);
  assert.ok(rows.every((r) => r.isDelisted === true));
  const [immoscoutRow] = getListingsByIds(db, ['immoscout:im-gone']);
  assert.ok(immoscoutRow, 'immoscout row should still exist — the global guard skips deletion for both sources');
  assert.equal(immoscoutRow.isDelisted, true);
});

test('refreshAllListings still deletes normally when only a small, plausible number of rows are genuinely not-found', async () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 20; i++) {
    upsertListing(db, listing({ id: `wh-${i}` }));
  }

  let calls = 0;
  const mostlyOk: ListingFetcher = {
    callToolText: async () => {
      calls++;
      if (calls <= 2) throw new Error('willhaben_get_listing failed: Listing x not found. Make sure the ID is correct.');
      return WH_DETAIL_TEXT;
    },
  };

  const summary = await refreshAllListings(db, {
    willhaben: mostlyOk,
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, noDelay);

  assert.equal(summary.willhaben.delisted, 2); // 2 out of 20 = 10% < max(10, 5) threshold — not tripped
  assert.deepEqual(summary.deletionSkippedFor, []);
  assert.equal(summary.deleted, 2);
});

test('refreshAllListings does NOT sweep willhaben by default — a disabled source must not be re-fetched every 6h', async () => {
  // The regression this guards: gating only the poller leaves the refresh sweep hitting the
  // disabled source once per stored row, every REFRESH_INTERVAL_MS, forever. Turning a source off
  // has to turn off *every* outbound path to it, not just the search one.
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));                        // willhaben row
  upsertListing(db, listing({ id: 'b', source: 'immoscout' }));   // immoscout row

  let willhabenCalls = 0;
  const countingWillhaben: ListingFetcher = {
    callToolText: async () => { willhabenCalls++; return WH_DETAIL_TEXT; },
  };

  const summary = await refreshAllListings(db, {
    willhaben: countingWillhaben,
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, { delayMs: 0, sleep: async () => {} }); // no `sources` — the real default applies

  assert.equal(willhabenCalls, 0, 'willhaben must not be contacted at all under the default source set');
  assert.deepEqual(summary.willhaben, { checked: 0, updated: 0, delisted: 0, errored: 0, skipped: true });
  assert.equal(summary.immoscout.skipped, false);
  assert.equal(summary.immoscout.checked, 1);
});

test('refreshAllListings never flags a skipped source\'s rows as delisted', async () => {
  // A skipped source is "not asked", not "asked and got nothing" — its rows must survive untouched,
  // or disabling willhaben would quietly delete every willhaben listing anyone shortlisted.
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));

  await refreshAllListings(db, {
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, { delayMs: 0, sleep: async () => {} });

  const [row] = getListingsByIds(db, ['willhaben:a']);
  assert.ok(row, 'the willhaben row must still exist');
  assert.equal(row.isDelisted, false);
});

test('refreshAllListings skips a source that is enabled but has no fetcher supplied', async () => {
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));

  const summary = await refreshAllListings(db, {}, {
    delayMs: 0, sleep: async () => {}, sources: ['immoscout', 'willhaben'] as SourceName[],
  });

  assert.equal(summary.willhaben.skipped, true);
  assert.equal(summary.immoscout.skipped, true);
});

test('refreshAllListings sweeps willhaben when it is explicitly opted in', async () => {
  // The opt-in must genuinely still work — this is a policy default, not a removal of the feature.
  const db = openDb(':memory:');
  upsertListing(db, listing({ id: 'a' }));

  let willhabenCalls = 0;
  const summary = await refreshAllListings(db, {
    willhaben: { callToolText: async () => { willhabenCalls++; return WH_DETAIL_TEXT; } },
    immoscout: fetcherReturning('{"images":[],"address":null}'),
  }, { delayMs: 0, sleep: async () => {}, sources: ['immoscout', 'willhaben'] as SourceName[] });

  assert.equal(willhabenCalls, 1);
  assert.equal(summary.willhaben.skipped, false);
  assert.equal(summary.willhaben.checked, 1);
});

test('exceedsBlastRadius never trips on a skipped source', () => {
  const skipped: SourceRefreshSummary = { checked: 0, updated: 0, delisted: 0, errored: 0, skipped: true };
  assert.equal(exceedsBlastRadius(skipped), false);
});
