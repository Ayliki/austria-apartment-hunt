import type { ShortlistExportRow } from './db.js';

/**
 * Semicolon, not comma. Excel under a German/Austrian locale reads `,` as the decimal separator and
 * drops a comma-delimited file into a single column — which is where this file is going to be opened.
 */
export const CSV_DELIMITER = ';';

/** Without this, the same Excel renders "Mariahilferstraße" as "MariahilferstraÃŸe". */
export const UTF8_BOM = '﻿';

/** Column order is part of the format: users build sheets on top of it. Headers stay English in every locale. */
export const CSV_COLUMNS: readonly string[] = [
  'title', 'price', 'area_sqm', 'rooms', 'price_per_sqm', 'district', 'address',
  'source', 'value_flag', 'is_private', 'lift', 'parking_spaces', 'floor', 'energy_class',
  'available_from', 'mentions_pets', 'is_wg', 'requires_waitlist_ticket', 'is_delisted',
  'first_seen', 'saved_at', 'url',
];

/** RFC 4180: quote when the field contains the delimiter, a quote, or a line break; double internal quotes. */
function csvField(value: string | number | boolean | null): string {
  if (value == null) return '';
  const s = String(value);
  if (s.includes(CSV_DELIMITER) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Renders shortlist rows as Excel-compatible CSV. Pure — the caller supplies the rows and stamps the filename. */
export function toCsv(rows: ShortlistExportRow[]): string {
  const lines = [CSV_COLUMNS.join(CSV_DELIMITER)];
  for (const { listing: l, savedAt } of rows) {
    lines.push([
      l.title, l.price, l.area, l.rooms, l.pricePerSqm, l.district, l.addressLine,
      l.source, l.valueFlag, l.isPrivate, l.lift, l.parkingSpaces, l.floor, l.energyClass,
      l.availableFrom, l.mentionsPets, l.isWg, l.requiresWaitlistTicket, l.isDelisted,
      l.firstSeen, savedAt, l.url,
    ].map(csvField).join(CSV_DELIMITER));
  }
  return `${UTF8_BOM}${lines.join('\n')}\n`;
}

/** `shortlist-2026-08-24.csv` — the clock is injected so the name is pinnable in a test. */
export function exportFilename(now: Date): string {
  return `shortlist-${now.toISOString().slice(0, 10)}.csv`;
}
