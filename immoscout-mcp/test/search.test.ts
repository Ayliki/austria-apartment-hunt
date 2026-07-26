import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, parseZipDistrict, parseSearchPage, searchRealEstate } from '../src/search.js';
import { Fetcher } from '../src/fetcher.js';

test('buildSearchUrl: page 1 without /seite- suffix, filters as query params', () => {
  const url = buildSearchUrl({ priceTo: 700, areaFrom: 30, roomsFrom: 1, roomsTo: 3 }, 1);
  assert.equal(
    url,
    'https://www.immobilienscout24.at/regional/wien/wien/wohnung-mieten'
      + '?primaryPriceTo=700&primaryAreaFrom=30&numberOfRoomsFrom=1&numberOfRoomsTo=3',
  );
});

test('buildSearchUrl: page 2+ uses /seite-N path suffix', () => {
  const url = buildSearchUrl({ priceFrom: 400 }, 3);
  assert.equal(
    url,
    'https://www.immobilienscout24.at/regional/wien/wien/wohnung-mieten/seite-3?primaryPriceFrom=400',
  );
});

test('buildSearchUrl: never emits a zipCode param (verified non-functional server-side)', () => {
  assert.ok(!buildSearchUrl({ districts: [1, 2, 3] }, 1).includes('zipCode'));
});

test('parseZipDistrict extracts Vienna zip and district from addressString', () => {
  assert.deepEqual(parseZipDistrict('Speisingerstraße, 1130 Wien'), { zip: '1130', district: 13 });
  assert.deepEqual(parseZipDistrict('Marktgasse 56, 1090 Wien'), { zip: '1090', district: 9 });
  assert.deepEqual(parseZipDistrict('1020 Wien'), { zip: '1020', district: 2 });
  assert.deepEqual(parseZipDistrict(null), { zip: null, district: null });
  assert.deepEqual(parseZipDistrict('Some Street'), { zip: null, district: null });
});

// Trimmed real page structure captured 2026-07-26 (two hits: one POINT, one SHAPE_ID location).
const FIXTURE_PAGE = `<html><script>window.__INITIAL_STATE__ = {"reduxAsyncConnect":{"pageData":{"results":{
  "totalHits":64,"pagination":{"totalPages":3},
  "hits":[
    {"exposeId":"6a648116abc","headline":"POINT HIT","addressString":"Oswaldgasse 28, 1120 Wien",
     "primaryPrice":550,"primaryArea":36,"numberOfRooms":1,"isPrivate":false,"isSocialHousing":false,
     "badges":[{"label":"Provisionsfrei","value":"FREE_OF_COMMISSION"}],
     "location":{"type":"POINT","lat":48.1686136,"lon":16.3255059},
     "dateCreated":"2026-07-13T10:51:44.174Z",
     "links":{"absoluteURL":"https://www.immobilienscout24.at/expose/6a648116abc"},
     "primaryPictureImageProps":{"src":"https://pictures.immobilienscout24.de/thumb.webp"},
     "pricePerSqmKeyFact":{"value":"15,28 €/m²"}},
    {"exposeId":"6a6192dfxyz","headline":"SHAPE HIT","addressString":"1090 Wien",
     "primaryPrice":620,"primaryArea":41,"numberOfRooms":2,"isPrivate":true,"isSocialHousing":true,
     "badges":[],"location":{"type":"SHAPE_ID","shapeId":"1040009001009"},
     "dateCreated":null,"links":{},"primaryPictureImageProps":null,"pricePerSqmKeyFact":null}
  ]}}}};</script></html>`;

test('parseSearchPage maps hits incl. POINT/SHAPE_ID location variants', () => {
  const page = parseSearchPage(FIXTURE_PAGE);
  assert.equal(page.totalHits, 64);
  assert.equal(page.totalPages, 3);
  assert.equal(page.hits.length, 2);

  const [point, shape] = page.hits;
  assert.equal(point.exposeId, '6a648116abc');
  assert.equal(point.price, 550);
  assert.equal(point.area, 36);
  assert.equal(point.rooms, 1);
  assert.equal(point.district, 12);
  assert.equal(point.zip, '1120');
  assert.equal(point.lat, 48.1686136);
  assert.equal(point.lon, 16.3255059);
  assert.deepEqual(point.badges, ['FREE_OF_COMMISSION']);
  assert.equal(point.isPrivate, false);
  assert.equal(point.url, 'https://www.immobilienscout24.at/expose/6a648116abc');
  assert.equal(point.imageUrl, 'https://pictures.immobilienscout24.de/thumb.webp');
  assert.equal(point.pricePerSqm, 15.28);

  assert.equal(shape.lat, null);
  assert.equal(shape.lon, null);
  assert.equal(shape.district, 9);
  assert.equal(shape.isPrivate, true);
  assert.equal(shape.isSocialHousing, true);
  assert.equal(shape.url, 'https://www.immobilienscout24.at/expose/6a6192dfxyz');
  assert.equal(shape.imageUrl, null);
  assert.equal(shape.pricePerSqm, null);
});

test('parseSearchPage throws (not empty) when the page structure changed', () => {
  assert.throws(() => parseSearchPage('<html>no state here</html>'), /marker not found/);
  assert.throws(
    () => parseSearchPage('<script>window.__INITIAL_STATE__ = {"reduxAsyncConnect":{"pageData":{}}};</script>'),
    /structure changed/,
  );
});

function fakeFetcher(pages: string[]): Fetcher {
  const f = new Fetcher({ minIntervalMs: 0 });
  let i = 0;
  f.fetchText = () => Promise.resolve(pages[Math.min(i++, pages.length - 1)]);
  return f;
}

test('searchRealEstate filters districts client-side and reports page-cap state', async () => {
  const res = await searchRealEstate(fakeFetcher([FIXTURE_PAGE]), { districts: [9], maxPages: 1 });
  assert.equal(res.listings.length, 1);
  assert.equal(res.listings[0].exposeId, '6a6192dfxyz');
  assert.equal(res.totalHitsCitywide, 64);
  assert.equal(res.pagesScanned, 1);
  assert.equal(res.totalPagesAvailable, 3);
  assert.equal(res.hitPageCap, true); // more pages existed but maxPages=1 stopped the scan
});

test('searchRealEstate without districts keeps every hit', async () => {
  const res = await searchRealEstate(fakeFetcher([FIXTURE_PAGE]), { maxPages: 1 });
  assert.equal(res.listings.length, 2);
  assert.equal(res.hitPageCap, true);
});

test('searchRealEstate caps maxPages at 10', async () => {
  const singlePage = `<script>window.__INITIAL_STATE__ = {"reduxAsyncConnect":{"pageData":{"results":{"totalHits":0,"pagination":{"totalPages":99},"hits":[]}}}};</script>`;
  const res = await searchRealEstate(fakeFetcher([singlePage]), { maxPages: 50 });
  assert.equal(res.pagesScanned, 10);
});
