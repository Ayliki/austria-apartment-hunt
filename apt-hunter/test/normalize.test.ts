import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WillhabenSearchHit } from '../src/normalize.js';
import {
  parseAustrianNumber,
  parseWillhabenSearchText,
  parseWillhabenDetailText,
  normalizeWillhaben,
  normalizeImmoscout,
  detectWaitlistTicket,
  detectShortTerm,
  detectWG,
  detectPetFriendly,
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

## Description
Schöne, sanierte Garconniere mit Blick auf den Augarten. Ruhige Lage, gute Anbindung an die U-Bahn.

## Images (11)
https://cache.willhaben.at/mmo/9/195/730/1869_105792956.jpg
https://cache.willhaben.at/mmo/9/195/730/1869_1686566767.jpg
... and 6 more`;

// Real listings often have no BODY_DYN attribute filled in — description section absent entirely.
const WH_DETAIL_NO_DESCRIPTION = WH_DETAIL.replace(
  /## Description\nSchöne.*Anbindung an die U-Bahn\.\n\n/,
  '',
);

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

test('parseWillhabenDetailText extracts the description when BODY_DYN is present', () => {
  const d = parseWillhabenDetailText(WH_DETAIL);
  assert.equal(
    d.description,
    'Schöne, sanierte Garconniere mit Blick auf den Augarten. Ruhige Lage, gute Anbindung an die U-Bahn.',
  );
});

test('parseWillhabenDetailText returns null description when no Description section exists', () => {
  const d = parseWillhabenDetailText(WH_DETAIL_NO_DESCRIPTION);
  assert.equal(d.description, null);
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
  assert.equal(n.isShortTerm, false); // €15.22/m², a normal long-term rent
  assert.equal(n.district, 2);
  assert.equal(
    n.description,
    'Schöne, sanierte Garconniere mit Blick auf den Augarten. Ruhige Lage, gute Anbindung an die U-Bahn.',
  );
});

test('normalizeWillhaben works without detail (no coords/images)', () => {
  const n = normalizeWillhaben(parseWillhabenSearchText(WH_SEARCH)[1]);
  assert.equal(n.lat, null);
  assert.deepEqual(n.images, []);
  assert.equal(n.isPrivate, true);
  assert.equal(n.description, null);
});

test('detectWaitlistTicket catches municipal-housing keywords', () => {
  assert.equal(detectWaitlistTicket('Schöne Gemeindewohnung in zentraler Lage'), true);
  assert.equal(detectWaitlistTicket('Wohnung mit Vormerkschein abzugeben'), true);
  assert.equal(detectWaitlistTicket('nur mit Wiener Wohnticket!'), true);
  assert.equal(detectWaitlistTicket('Sanierte Garconniere im 2. Liftstock'), false);
});

// The onboarding question already promises this category ("Gemeindewohnung, Genossenschaft,
// Direktvergabe") — these titles were verified leaking into a real user's candidate queue in prod.
test('detectWaitlistTicket also catches Genossenschaftswohnung (cooperative housing), matching what onboarding already promises', () => {
  assert.equal(detectWaitlistTicket('Genossenschaftswohnung zu vergeben'), true);
  assert.equal(detectWaitlistTicket('2 Zimmer Genossenschaftswohnung'), true);
  assert.equal(detectWaitlistTicket('3 Zimmer - Genossenschaftswohnung, nur Sozialbau-Mieter'), true);
});

test('detectShortTerm catches nightly/vacation-style title phrasing', () => {
  assert.equal(detectShortTerm('NOTFALLWOHNUNG zur kurzfristigen Nutzung! - PROVISIONSFREI', 600, 45), true);
  assert.equal(detectShortTerm('Gemütliche Ferienwohnung am Stadtrand', 900, 40), true);
  assert.equal(detectShortTerm('Modernes Boardinghouse-Zimmer, tageweise buchbar', 700, 30), true);
  assert.equal(detectShortTerm('Kurzzeitmiete möglich, voll möbliert', 1200, 50), true);
  assert.equal(detectShortTerm('Sanierte Garconniere im 2. Liftstock', 650, 44), false);
});

test('detectShortTerm does not flag ordinary listings merely available soon ("kurzfristig beziehbar")', () => {
  assert.equal(detectShortTerm('Helle 2-Zimmer-Wohnung, kurzfristig beziehbar', 800, 60), false);
  assert.equal(detectShortTerm('WG Zimmer ab sofort verfügbar, kurzfristig frei', 559, 82), false);
});

test('detectShortTerm catches an implausibly low monthly price for the size, even without a title match', () => {
  assert.equal(detectShortTerm('Voll ausgestattetes Appartement in guter Lage', 59.99, 45), true); // €1.33/m²
  assert.equal(detectShortTerm('Sanierte Garconniere im 2. Liftstock', 650, 44), false); // €14.77/m², normal
});

test('detectShortTerm tolerates missing price/area (never flags on nulls alone)', () => {
  assert.equal(detectShortTerm('Sanierte Garconniere im 2. Liftstock', null, null), false);
  assert.equal(detectShortTerm('Sanierte Garconniere im 2. Liftstock', 650, null), false);
});

test('detectWG catches explicit WG-room, co-living, and student-room titles', () => {
  assert.equal(detectWG('WG-Zimmer frei'), true);
  assert.equal(detectWG('Zimmer in 3er-WG nur für 1 Dame, möbliert, ab sofort'), true);
  assert.equal(detectWG('Ladies Frauen WG - Zimmer'), true);
  assert.equal(detectWG('CO-LIVING 1070 - die neue Art der Wohngemeinschaft!'), true);
  assert.equal(detectWG('Studenten-Zimmer in WG! 649EUR inklusive Strom'), true);
  assert.equal(detectWG('20qm WG-Studentenzimmer, Uni-Nähe, 1090 Wien für Studentinnen'), true);
});

test('detectWG does not flag whole apartments merely described as WG-suitable', () => {
  assert.equal(detectWG('2-Zimmer-Wohnung, sehr schön und ruhig, WG-geeignet. U-Bahn'), false);
  assert.equal(detectWG('TAUSCHWOHNUNG Wohnung in Wien Meidling: Top-Anbindung & WG-tauglich'), false);
  assert.equal(detectWG('Privat wohnen statt WG-Chaos: Apartments ab € 750,-'), false);
  assert.equal(detectWG('RUHIGE 1 ZIMMER INNENHOF-WOHNUNG IM 1.OG IN U-BAHN NÄHE'), false);
  assert.equal(detectWG('Sanierte Garconniere im 2. Liftstock'), false);
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
  assert.equal(n.description, null);
});

test('normalizeImmoscout uses the full image set and description when a detail object is supplied', () => {
  const detail = {
    description: 'Helle 2-Zimmer-Wohnung mit Balkon und Einbauküche.',
    images: [
      { url: 'https://pictures.immobilienscout24.de/full1.webp', caption: null },
      { url: 'https://pictures.immobilienscout24.de/full2.webp', caption: 'Grundriss' },
    ],
  };
  const n = normalizeImmoscout(IS24_HIT, detail);
  assert.equal(n.description, 'Helle 2-Zimmer-Wohnung mit Balkon und Einbauküche.');
  assert.deepEqual(n.images, [
    'https://pictures.immobilienscout24.de/full1.webp',
    'https://pictures.immobilienscout24.de/full2.webp',
  ]);
});

test('normalizeImmoscout flags social housing as waitlist-ticket, tolerates nulls', () => {
  const n = normalizeImmoscout({ ...IS24_HIT, isSocialHousing: true, lat: null, lon: null, imageUrl: null });
  assert.equal(n.requiresWaitlistTicket, true);
  assert.equal(n.lat, null);
  assert.deepEqual(n.images, []);
});

test('normalizeImmoscout flags short-term listings by title and by implausible price/m²', () => {
  assert.equal(normalizeImmoscout({ ...IS24_HIT, title: 'Charmante Ferienwohnung im Zentrum' }).isShortTerm, true);
  assert.equal(normalizeImmoscout({ ...IS24_HIT, price: 59.99, area: 45 }).isShortTerm, true);
  assert.equal(normalizeImmoscout(IS24_HIT).isShortTerm, false); // €15.28/m², a normal long-term rent
});

test('detectPetFriendly catches German and English pet-allowed phrasing', () => {
  assert.equal(detectPetFriendly('Haustiere erlaubt nach Absprache'), true);
  assert.equal(detectPetFriendly('Tierhaltung erlaubt'), true);
  assert.equal(detectPetFriendly('Pets allowed, small dogs welcome'), true);
  assert.equal(detectPetFriendly('pet-friendly building'), true);
  assert.equal(detectPetFriendly('Ruhige 2-Zimmer Wohnung im 3. Stock'), false);
});

test('detectPetFriendly does not false-positive on "Haustiere nicht erlaubt"', () => {
  assert.equal(detectPetFriendly('Haustiere nicht erlaubt'), false);
  assert.equal(detectPetFriendly('No pets allowed'), false);
});

test('normalizeImmoscout maps lift/parkingSpaces/floor/energyClass/availableFrom from detail, and mentionsPets from title+description', () => {
  const raw = { exposeId: '1', title: 'Nice flat, pet-friendly', price: 700 };
  const detail = {
    lift: true, parkingSpaces: 2, floor: '3. Stock', energyClass: 'B',
    availableFrom: '2026-09-01', description: 'Sunny flat near the park.',
    images: [],
  };
  const n = normalizeImmoscout(raw, detail);
  assert.equal(n.lift, true);
  assert.equal(n.parkingSpaces, 2);
  assert.equal(n.floor, '3. Stock');
  assert.equal(n.energyClass, 'B');
  assert.equal(n.availableFrom, '2026-09-01');
  assert.equal(n.mentionsPets, true);
});

test('normalizeImmoscout amenity fields are null (not false/0) when no detail is supplied', () => {
  const n = normalizeImmoscout({ exposeId: '2', title: 'Flat', price: 600 });
  assert.equal(n.lift, null);
  assert.equal(n.parkingSpaces, null);
  assert.equal(n.floor, null);
  assert.equal(n.energyClass, null);
  assert.equal(n.availableFrom, null);
  assert.equal(n.mentionsPets, false);
});

test('normalizeWillhaben amenity structured fields are always null (willhaben has no such data), mentionsPets still detected from description', () => {
  const hit: WillhabenSearchHit = {
    id: '3', title: 'Flat', price: 600, location: null, dateCreated: null,
    sellerType: null, sellerName: null, area: null, rooms: null, pricePerSqm: null,
    url: 'https://www.willhaben.at/iad/object?adId=3', zip: null, district: null,
  };
  const n = normalizeWillhaben(hit, { lat: null, lon: null, address: null, images: [], description: 'Haustiere erlaubt!' });
  assert.equal(n.lift, null);
  assert.equal(n.parkingSpaces, null);
  assert.equal(n.mentionsPets, true);
});
