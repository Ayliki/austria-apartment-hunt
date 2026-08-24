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

test('toCsv renders booleans as true/false at their correct columns', () => {
  const out = toCsv([row({ isWg: true, mentionsPets: false })]);
  const dataRow = out.slice(UTF8_BOM.length).split('\n')[1];
  const fields = dataRow.split(';');
  const isWgIndex = CSV_COLUMNS.indexOf('is_wg');
  const mentionsPetsIndex = CSV_COLUMNS.indexOf('mentions_pets');
  assert.equal(fields[isWgIndex], 'true', 'is_wg column has true');
  assert.equal(fields[mentionsPetsIndex], 'false', 'mentions_pets column has false');
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

test('toCsv defends against formula injection: equals sign', () => {
  const out = toCsv([row({ title: '=SUM(A1:A10)' })]);
  assert.ok(out.includes("'=SUM(A1:A10)"));
});

test('toCsv defends against formula injection: plus sign', () => {
  const out = toCsv([row({ title: '+1' })]);
  assert.ok(out.includes("'+1"));
});

test('toCsv defends against formula injection: minus sign', () => {
  const out = toCsv([row({ title: '-1' })]);
  assert.ok(out.includes("'-1"));
});

test('toCsv defends against formula injection: at sign', () => {
  const out = toCsv([row({ title: '@ROW' })]);
  assert.ok(out.includes("'@ROW"));
});

test('toCsv defends against formula injection: tab', () => {
  const out = toCsv([row({ title: '\tHidden' })]);
  assert.ok(out.includes("'\tHidden"));
});

test('toCsv defends against formula injection: carriage return', () => {
  const out = toCsv([row({ title: '\rHidden' })]);
  assert.ok(out.includes("'\rHidden"));
});

test('toCsv prefixes apostrophe before quoting when a dangerous char needs both protections', () => {
  const out = toCsv([row({ title: '=SUM(A1);"x"' })]);
  // The apostrophe is added first, then the field is quoted and internal quotes are doubled
  assert.ok(out.includes("\"'=SUM(A1);\"\"x\"\"\""));
});

test('toCsv column order and presence is correct by binding each header to its data value', () => {
  // Helper: extract a column by index from a CSV data row
  const extractColumn = (csvRow: string, colIndex: number): string => {
    // Split on unquoted semicolons only; this is a simple parser that handles quoted fields
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of csvRow) {
      if (char === '"') inQuotes = !inQuotes;
      else if (char === ';' && !inQuotes) {
        fields.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    fields.push(current);
    return fields[colIndex];
  };

  // Build a row with DISTINCT recognisable values for each field
  const testRow = row({
    title: 'T0',
    price: 100,
    area: 38,
    rooms: 1,
    pricePerSqm: 2,
    district: 3,
    addressLine: 'A6',
    source: 'S7',
    valueFlag: 'V8',
    isPrivate: true,
    lift: true,
    parkingSpaces: 11,
    floor: 12,
    energyClass: 'E13',
    availableFrom: '2026-08-14',
    mentionsPets: true,
    isWg: false,
    requiresWaitlistTicket: true,
    isDelisted: false,
    firstSeen: '2026-08-01T00:00:00.000Z',
    url: 'https://willhaben.at/x/21',
  }, '2026-08-02T10:00:00.000Z');

  const csv = toCsv([testRow]);
  const lines = csv.slice(UTF8_BOM.length).split('\n');
  const dataRow = lines[1];

  // Expected values aligned with CSV_COLUMNS
  const expectedValues = [
    'T0', '100', '38', '1', '2', '3', 'A6',
    'S7', 'V8', 'true', 'true', '11', '12', 'E13',
    '2026-08-14', 'true', 'false', 'true', 'false',
    '2026-08-01T00:00:00.000Z', '2026-08-02T10:00:00.000Z', 'https://willhaben.at/x/21',
  ];

  assert.equal(CSV_COLUMNS.length, 22, 'CSV_COLUMNS has 22 headers');
  assert.equal(expectedValues.length, 22, 'test has 22 expected values');

  for (let i = 0; i < CSV_COLUMNS.length; i++) {
    const extracted = extractColumn(dataRow, i);
    assert.equal(extracted, expectedValues[i], `column ${i} (${CSV_COLUMNS[i]}) has correct value`);
  }
});
