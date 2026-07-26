import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpose, getListing } from '../src/listing.js';
import { Fetcher } from '../src/fetcher.js';

// Trimmed real expose entity shape captured 2026-07-26 from /expose/6a54c34012034290294fa002.
const EXPOSE_FIXTURE = `<html><script>window.__APOLLO_STATE__ = {
  "Expose:abc123": {
    "__typename":"Expose","id":"abc123",
    "description":{"__typename":"Description","title":"RUHIGE SINGLE-WOHNUNG",
      "descriptionNote":"<p><b>Ruhige</b> Wohnung</p><ul><li>Küche</li></ul>"},
    "addressString":"Speisingerstraße, 1130 Wien",
    "localization":{"__typename":"Localization",
      "address":{"__typename":"Address","city":"Wien","countryCode":"AT","street":"Speisingerstraße","streetNumber":null,"zip":"1130"},
      "information":{"__typename":"LocalizationInformation","floor":0,"numberOfFloors":null},
      "transit":null},
    "priceInformation":{"__typename":"PriceInformation","primaryPrice":550,"hasCommission":false,
      "prices":{"__typename":"Prices","rentPerSquareMeter":15.28}},
    "costs":{"__typename":"Costs",
      "oneTime":[{"__typename":"CostsValue","text":"Kaution: 2.200,00 €","label":null,"price":null},
                 {"__typename":"CostsValue","text":"Provision: Gemäß Erstauftraggeberprinzip bezahlt der Abgeber die Provision.","label":null,"price":null}],
      "running":[{"__typename":"CostsValue","text":null,"label":"Monatliche Kosten","price":"550 €"}]},
    "contact":{"__typename":"Contact","fullName":"Herr Eduard Letz",
      "company":{"__typename":"ContactCompany","name":"Realbüro Sabine Steinecker"},
      "contactPhone":"+4367761470405"},
    "condition":{"__typename":"Condition","yearOfConstruction":"1960",
      "heatingTypes":[{"__typename":"AugmentedValue","label":"Zentralheizung","value":"CENTRAL"}],
      "energyCertification":{"__typename":"EnergyCertification",
        "heatingDemandClass":{"__typename":"AugmentedValue","label":"C","value":"C"}}},
    "fitting":{"__typename":"Fitting","lift":[{"__typename":"AugmentedValue","label":"Personenaufzug"}],
      "kitchen":["KITCHENETTE"],"numberOfParkingSpaces":0},
    "object":{"__typename":"ExposeObject","availableFrom":"ab 15.09.2026","rentalPeriod":"5","rentalPeriodType":"YEAR"},
    "area":{"__typename":"Area","primaryArea":36,"livingArea":36,"numberOfRooms":1},
    "keyfacts":{"__typename":"Keyfacts","floorLabel":"Erdgeschoss"},
    "pictures":[
      {"__typename":"Picture","url":"https://pictures.immobilienscout24.de/p1","title":"Wohnschlafzimmer","caption":"Helles Zimmer"},
      {"__typename":"Picture","url":"https://pictures.immobilienscout24.de/p2","title":null,"caption":null}]
  },
  "ROOT_QUERY": {"__typename":"Query"}
};</script></html>`;

test('parseExpose extracts the full detail shape', () => {
  const d = parseExpose(EXPOSE_FIXTURE, 'abc123');
  assert.equal(d.id, 'abc123');
  assert.equal(d.url, 'https://www.immobilienscout24.at/expose/abc123');
  assert.equal(d.title, 'RUHIGE SINGLE-WOHNUNG');
  assert.equal(d.description, 'Ruhige Wohnung Küche');
  assert.equal(d.address, 'Speisingerstraße, 1130 Wien');
  assert.equal(d.street, 'Speisingerstraße');
  assert.equal(d.zip, '1130');
  assert.equal(d.price, 550);
  assert.equal(d.pricePerSqm, 15.28);
  assert.equal(d.deposit, 'Kaution: 2.200,00 €');
  assert.match(d.commissionNote!, /Provision:/);
  assert.deepEqual(d.contact, {
    name: 'Herr Eduard Letz',
    company: 'Realbüro Sabine Steinecker',
    phone: '+4367761470405',
  });
  assert.equal(d.heating, 'Zentralheizung');
  assert.equal(d.energyClass, 'C');
  assert.equal(d.lift, true);
  assert.equal(d.kitchen, true);
  assert.equal(d.parkingSpaces, 0);
  assert.equal(d.availableFrom, 'ab 15.09.2026');
  assert.equal(d.rentalPeriod, '5 YEAR');
  assert.equal(d.floor, 'Erdgeschoss');
  assert.equal(d.rooms, 1);
  assert.equal(d.areaSqm, 36);
  assert.equal(d.transit, null);
  assert.deepEqual(d.images, [
    { url: 'https://pictures.immobilienscout24.de/p1', caption: 'Helles Zimmer' },
    { url: 'https://pictures.immobilienscout24.de/p2', caption: null },
  ]);
});

test('parseExpose maps a populated transit array defensively', () => {
  const html = EXPOSE_FIXTURE.replace(
    '"transit":null',
    '"transit":[{"__typename":"TransitStop","text":"U4 Pilgramgasse · 4 min"}]',
  );
  assert.deepEqual(parseExpose(html, 'abc123').transit, ['U4 Pilgramgasse · 4 min']);
});

test('parseExpose throws when no Expose entity exists', () => {
  assert.throws(
    () => parseExpose('<script>window.__APOLLO_STATE__ = {"ROOT_QUERY":{}};</script>', 'x'),
    /no Expose:/,
  );
});

test('getListing fetches the expose URL and parses it', async () => {
  const f = new Fetcher({ minIntervalMs: 0 });
  let seenUrl = '';
  f.fetchText = (url: string) => { seenUrl = url; return Promise.resolve(EXPOSE_FIXTURE); };
  const d = await getListing(f, 'abc123');
  assert.equal(seenUrl, 'https://www.immobilienscout24.at/expose/abc123');
  assert.equal(d.title, 'RUHIGE SINGLE-WOHNUNG');
});
