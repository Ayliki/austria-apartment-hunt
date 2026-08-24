import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, exportFilename, CSV_COLUMNS, UTF8_BOM } from '../src/export.js';
import type { ListingRow, ShortlistExportRow } from '../src/db.js';

function row(overrides: Partial<ListingRow> = {}, savedAt = '2026-08-02T10:00:00.000Z'): ShortlistExportRow {
  return {
    savedAt,
    listing: {
      id: 'willhaben:1', source: 'willhaben', title: 'Helle Garconniere',
      price: 800, pricePerSqm: 21, area: 38, rooms: 1, district: 6,
      isPrivate: true, images: [], description: null, url: 'https://willhaben.at/x/1',
      valueFlag: 'good', firstSeen: '2026-08-01T00:00:00.000Z',
      requiresWaitlistTicket: false, isWg: false, addressLine: 'Testgasse 1',
      lat: null, lon: null, isDelisted: false,
      lift: null, parkingSpaces: null, floor: null, energyClass: null,
      availableFrom: null, mentionsPets: false,
      ...overrides,
    },
  };
}

test('toCsv starts with a single UTF-8 BOM', () => {
  const out = toCsv([row()]);
  assert.ok(out.startsWith(UTF8_BOM));
  assert.equal(out.split(UTF8_BOM).length - 1, 1, 'exactly one BOM, at the start');
});

test('toCsv writes the documented header row, semicolon-delimited', () => {
  const header = toCsv([]).slice(UTF8_BOM.length).split('\n')[0];
  assert.equal(header, CSV_COLUMNS.join(';'));
});

test('toCsv quotes fields containing the delimiter and doubles internal quotes', () => {
  const out = toCsv([row({ title: 'Flat; "quiet" yard' })]);
  assert.ok(out.includes('"Flat; ""quiet"" yard"'));
});

test('toCsv quotes fields containing newlines', () => {
  const out = toCsv([row({ addressLine: 'Line1\nLine2' })]);
  assert.ok(out.includes('"Line1\nLine2"'));
});

test('toCsv renders nulls as empty fields, never the string null', () => {
  const out = toCsv([row({ price: null, floor: null })]);
  assert.ok(!out.includes('null'));
  assert.ok(out.includes(';;'), 'a null field is empty between two delimiters');
});

test('toCsv renders booleans as true/false', () => {
  const out = toCsv([row({ isWg: true, mentionsPets: false })]);
  const dataRow = out.slice(UTF8_BOM.length).split('\n')[1];
  assert.ok(dataRow.includes('true'));
  assert.ok(dataRow.includes('false'));
});

test('toCsv emits one data row per shortlist entry, in the order given', () => {
  const out = toCsv([row({ id: 'a', title: 'First' }), row({ id: 'b', title: 'Second' })]);
  const lines = out.slice(UTF8_BOM.length).trimEnd().split('\n');
  assert.equal(lines.length, 3, 'header plus two data rows');
  assert.ok(lines[1].includes('First'));
  assert.ok(lines[2].includes('Second'));
});

test('toCsv includes saved_at from the export row, not from the listing', () => {
  const out = toCsv([row({}, '2026-08-24T09:30:00.000Z')]);
  assert.ok(out.includes('2026-08-24T09:30:00.000Z'));
});

test('exportFilename is date-stamped from the injected clock', () => {
  assert.equal(exportFilename(new Date('2026-08-24T22:15:00.000Z')), 'shortlist-2026-08-24.csv');
});
