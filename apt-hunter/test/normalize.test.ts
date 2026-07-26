import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAustrianNumber,
  parseWillhabenSearchText,
  parseWillhabenDetailText,
  normalizeWillhaben,
  normalizeImmoscout,
  detectWaitlistTicket,
} from '../src/normalize.js';

test('parseAustrianNumber handles Austrian formats', () => {
  assert.equal(parseAustrianNumber('€ 669,90'), 669.9);
  assert.equal(parseAustrianNumber('€ 1.234,56'), 1234.56);
  assert.equal(parseAustrianNumber('€ 559'), 559);
  assert.equal(parseAustrianNumber('44 m²'), 44);
  assert.equal(parseAustrianNumber('€ 15,22'), 15.22);
  assert.equal(parseAustrianNumber('no digits'), null);
});

// Real willhaben_search_real_estate output captured 2026-07-26 (dealer + private hits).
const WH_SEARCH = `## Search Results: Mietwohnungen

Found **178** listings (showing 2 of 2 per page, page 1)
Vertical: real_estate

**1. Nächst Augarten! Sanierte Garconniere mit 2 Zimmer im 2. Liftstock** | 💰 € 669,90 | 📍 Wien, 02. Bezirk, Leopoldstadt | 📅 2026-07-26T10:05:00Z | 🏢 Dealer | 🏷️ Omerovic Immobilien GmbH | 📐 44 m² | 🛏️ 2 rooms | 📊 € 15,22 | 🔗 https://www.willhaben.at/iad/immobilien/d/mietwohnungen/wien/wien-1020-leopoldstadt/naechst-augarten-sanierte-garconniere-mit-2-zimmer-im-2-liftstock-1957301869/

**2. WG Zimmer ab sofort verfügbar, mit Dachterrassen Highlight** | 💰 € 559 | 📍 Wien, 10. Bezirk, Favoriten | 📅 2026-07-26T06:53:00Z | 👤 Private | 📐 82 m² | 🛏️ 3 rooms | 📊 € 6,82 | 🔗 https://www.willhaben.at/iad/immobilien/d/mietwohnungen/wien/wien-1100-favoriten/wg-zimmer-ab-sofort-verfuegbar-mit-dachterrassen-highlight-2104353006/`;

test('parseWillhabenSearchText parses dealer and private hit lines', () => {
  const hits = parseWillhabenSearchText(WH_SEARCH);
  assert.equal(hits.length, 2);

  const [dealer, priv] = hits;
  assert.equal(dealer.id, '1957301869');
  assert.equal(dealer.title, 'Nächst Augarten! Sanierte Garconniere mit 2 Zimmer im 2. Liftstock');
  assert.equal(dealer.price, 669.9);
  assert.equal(dealer.district, 2);
  assert.equal(dealer.zip, '1020');
  assert.equal(dealer.dateCreated, '2026-07-26T10:05:00Z');
  assert.equal(dealer.sellerType, 'dealer');
  assert.equal(dealer.sellerName, 'Omerovic Immobilien GmbH');
  assert.equal(dealer.area, 44);
  assert.equal(dealer.rooms, 2);
  assert.equal(dealer.pricePerSqm, 15.22);
  assert.match(dealer.url, /^https:\/\/www\.willhaben\.at\//);

  assert.equal(priv.id, '2104353006');
  assert.equal(priv.sellerType, 'private');
  assert.equal(priv.sellerName, null);
  assert.equal(priv.district, 10);
  assert.equal(priv.zip, '1100');
});

// Real willhaben_get_listing output shape captured 2026-07-26.
const WH_DETAIL = `# Nächst Augarten! Sanierte Garconniere mit 2 Zimmer im 2. Liftstock

💰 **Price:** € 669,90
📅 **Published:** 2026-07-26T10:05:00+0200
🔗 **URL:** https://www.willhaben.at/iad/object?adId=1957301869
🏷️ **Type:** Dealer
👤 **Seller:** Omerovic Immobilien GmbH
🏠 **Address:** 1020, Wien, 02. Bezirk, Leopoldstadt, Österreich
📍 **Coordinates:** 48.22413,16.37719
📞 **Contact:** EMAIL

## Key Details
- **Living Area:** 44
- **Price/m²:** € 15,23

## Images (11)
https://cache.willhaben.at/mmo/9/195/730/1869_105792956.jpg
https://cache.willhaben.at/mmo/9/195/730/1869_1686566767.jpg
... and 6 more`;

test('parseWillhabenDetailText extracts coordinates, address and images', () => {
  const d = parseWillhabenDetailText(WH_DETAIL);
  assert.equal(d.lat, 48.22413);
  assert.equal(d.lon, 16.37719);
  assert.equal(d.address, '1020, Wien, 02. Bezirk, Leopoldstadt, Österreich');
  assert.deepEqual(d.images, [
    'https://cache.willhaben.at/mmo/9/195/730/1869_105792956.jpg',
    'https://cache.willhaben.at/mmo/9/195/730/1869_1686566767.jpg',
  ]);
});

test('normalizeWillhaben merges search hit + detail into NormalizedListing', () => {
  const hit = parseWillhabenSearchText(WH_SEARCH)[0];
  const n = normalizeWillhaben(hit, parseWillhabenDetailText(WH_DETAIL));
  assert.equal(n.source, 'willhaben');
  assert.equal(n.id, '1957301869');
  assert.equal(n.lat, 48.22413);
  assert.equal(n.lon, 16.37719);
  assert.equal(n.images.length, 2);
  assert.equal(n.isPrivate, false);
  assert.equal(n.requiresWaitlistTicket, false);
  assert.equal(n.district, 2);
});

test('normalizeWillhaben works without detail (no coords/images)', () => {
  const n = normalizeWillhaben(parseWillhabenSearchText(WH_SEARCH)[1]);
  assert.equal(n.lat, null);
  assert.deepEqual(n.images, []);
  assert.equal(n.isPrivate, true);
});

test('detectWaitlistTicket catches municipal-housing keywords', () => {
  assert.equal(detectWaitlistTicket('Schöne Gemeindewohnung in zentraler Lage'), true);
  assert.equal(detectWaitlistTicket('Wohnung mit Vormerkschein abzugeben'), true);
  assert.equal(detectWaitlistTicket('nur mit Wiener Wohnticket!'), true);
  assert.equal(detectWaitlistTicket('Sanierte Garconniere im 2. Liftstock'), false);
});

// Real immoscout_search_real_estate JSON element shape (from immoscout-mcp Task 3 output).
const IS24_HIT = {
  exposeId: '6a648116abc',
  title: 'RUHIGE HOFSEITIGE SINGLE-ERDGESCHOSS-WOHNUNG',
  price: 550, pricePerSqm: 15.28, area: 36, rooms: 1,
  district: 12, zip: '1120', address: 'Oswaldgasse 28, 1120 Wien',
  lat: 48.1686136, lon: 16.3255059,
  badges: ['FREE_OF_COMMISSION'], isPrivate: false, isSocialHousing: false,
  url: 'https://www.immobilienscout24.at/expose/6a648116abc',
  imageUrl: 'https://pictures.immobilienscout24.de/thumb.webp',
  dateCreated: '2026-07-13T10:51:44.174Z',
};

test('normalizeImmoscout maps the immoscout-mcp JSON shape', () => {
  const n = normalizeImmoscout(IS24_HIT);
  assert.equal(n.source, 'immoscout');
  assert.equal(n.id, '6a648116abc');
  assert.equal(n.price, 550);
  assert.equal(n.district, 12);
  assert.equal(n.addressLine, 'Oswaldgasse 28, 1120 Wien');
  assert.equal(n.lat, 48.1686136);
  assert.deepEqual(n.images, ['https://pictures.immobilienscout24.de/thumb.webp']);
  assert.equal(n.requiresWaitlistTicket, false);
});

test('normalizeImmoscout flags social housing as waitlist-ticket, tolerates nulls', () => {
  const n = normalizeImmoscout({ ...IS24_HIT, isSocialHousing: true, lat: null, lon: null, imageUrl: null });
  assert.equal(n.requiresWaitlistTicket, true);
  assert.equal(n.lat, null);
  assert.deepEqual(n.images, []);
});
