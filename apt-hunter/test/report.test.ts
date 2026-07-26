import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/report.js';
import type { NormalizedListing } from '../src/normalize.js';

function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: 'immoscout', id: 'i1', url: 'https://www.immobilienscout24.at/expose/i1',
    title: 'Nette Wohnung </script><script>alert(1)</script>',
    price: 650, pricePerSqm: 15.5, area: 42, rooms: 2,
    district: 4, zip: '1040', addressLine: 'Gußhausstraße 1, 1040 Wien',
    lat: 48.2, lon: 16.37, isPrivate: false, requiresWaitlistTicket: true,
    images: ['https://img.example/1.jpg'], dateCreated: '2026-07-20T00:00:00Z',
    valueFlag: 'good',
    alsoListedOn: [{ source: 'willhaben', url: 'https://www.willhaben.at/x' }],
    ...overrides,
  };
}

const INPUT = {
  listings: [listing()],
  rawListings: [listing(), listing({ source: 'willhaben', id: 'w1', url: 'https://www.willhaben.at/x', alsoListedOn: undefined })],
  generatedAt: '2026-07-26T12:00:00Z',
  query: { districts: [1, 2, 3, 4, 5, 6, 7, 8, 9], priceTo: 700, areaFrom: 30 },
  warnings: ['willhaben source failed: boom'],
  duplicatePairs: 1,
};

test('renderReport produces a self-contained HTML document', () => {
  const html = renderReport(INPUT);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<style>'), 'inline CSS');
  assert.ok(html.includes('application/json'), 'embedded JSON data');
  assert.ok(!html.includes('src="http'), 'no external scripts/styles');
});

test('renderReport escapes </script> inside embedded data', () => {
  const html = renderReport(INPUT);
  const dataTag = html.split('<script type="application/json" id="report-data">')[1].split('</script>')[0];
  assert.ok(!dataTag.includes('</script>'), 'data must not terminate the script tag');
  assert.ok(dataTag.includes('\\u003c/script>'), 'escaped angle brackets');
});

test('renderReport exposes the expected client-side controls and badges', () => {
  const html = renderReport(INPUT);
  for (const id of ['sort', 'district-filter', 'source-filter', 'private-only', 'hide-waitlist', 'dedup-toggle']) {
    assert.ok(html.includes(`id="${id}"`), `missing control #${id}`);
  }
  assert.ok(html.includes('both sites'), 'dedup badge text');
  assert.ok(html.includes('Wohnticket'), 'waitlist badge text');
  assert.ok(html.includes('willhaben source failed: boom'), 'warnings banner content');
});
