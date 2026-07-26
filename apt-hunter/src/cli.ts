#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { McpConnection, type McpServerSpec } from './mcp-client.js';
import {
  parseWillhabenSearchText,
  parseWillhabenDetailText,
  normalizeWillhaben,
  normalizeImmoscout,
  type NormalizedListing,
} from './normalize.js';
import { dedupeListings } from './dedupe.js';
import { scoreValue } from './score.js';
import { renderReport } from './report.js';

const WILLHABEN_ENRICH_CAP = 30;

export function parseDistrictsArg(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const range = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (range) {
      for (let d = parseInt(range[1], 10); d <= parseInt(range[2], 10); d++) out.push(d);
    } else if (/^\d{1,2}$/.test(part.trim())) {
      out.push(parseInt(part.trim(), 10));
    } else {
      throw new Error(`invalid district spec: "${part}"`);
    }
  }
  if (out.some((d) => d < 1 || d > 23)) throw new Error(`district out of range 1-23 in "${s}"`);
  return [...new Set(out)];
}

function immoscoutSpec(): McpServerSpec {
  const here = dirname(fileURLToPath(import.meta.url)); // apt-hunter/dist
  const entry = process.env.IMMOSCOUT_MCP_PATH ?? resolve(here, '../../immoscout-mcp/dist/index.js');
  return { command: 'node', args: [entry] };
}

const WILLHABEN_SPEC: McpServerSpec = { command: 'npx', args: ['-y', 'willhaben-mcp'] };

interface CliOptions {
  priceFrom?: number; priceTo?: number;
  areaFrom?: number; areaTo?: number;
  roomsFrom?: number; roomsTo?: number;
  districts?: number[];
  location: string;
  maxPages: number;
  noOpen: boolean;
}

/** willhaben: search pages, district-filter, then enrich each hit with get_listing (coords + images). */
async function huntWillhaben(opts: CliOptions): Promise<NormalizedListing[]> {
  const conn = new McpConnection(WILLHABEN_SPEC);
  await conn.connect();
  try {
    const baseArgs: Record<string, unknown> = {
      property_type: 'mietwohnung',
      action: 'rent',
      location: opts.location,
      sort: 'price_asc',
      rows: 100,
    };
    if (opts.priceFrom != null) baseArgs.price_from = opts.priceFrom;
    if (opts.priceTo != null) baseArgs.price_to = opts.priceTo;
    if (opts.areaFrom != null) baseArgs.area_from = opts.areaFrom;
    if (opts.areaTo != null) baseArgs.area_to = opts.areaTo;
    if (opts.roomsFrom != null) baseArgs.rooms = opts.roomsFrom;

    const hits = [];
    for (let page = 1; page <= Math.min(opts.maxPages, 2); page++) {
      const text = await conn.callToolText('willhaben_search_real_estate', { ...baseArgs, page });
      const parsed = parseWillhabenSearchText(text);
      hits.push(...parsed);
      if (parsed.length < 100) break; // last page
    }

    const kept = opts.districts?.length
      ? hits.filter((h) => h.district != null && opts.districts!.includes(h.district))
      : hits;

    const out: NormalizedListing[] = [];
    for (const hit of kept.slice(0, WILLHABEN_ENRICH_CAP)) {
      let detail;
      try {
        detail = parseWillhabenDetailText(await conn.callToolText('willhaben_get_listing', { id: hit.id }));
      } catch {
        detail = undefined; // enrichment is best-effort; the hit still flows through without coords/images
      }
      out.push(normalizeWillhaben(hit, detail));
    }
    for (const hit of kept.slice(WILLHABEN_ENRICH_CAP)) out.push(normalizeWillhaben(hit));
    return out;
  } finally {
    await conn.close();
  }
}

async function huntImmoscout(opts: CliOptions): Promise<NormalizedListing[]> {
  const conn = new McpConnection(immoscoutSpec());
  await conn.connect();
  try {
    const text = await conn.callToolText('immoscout_search_real_estate', {
      price_from: opts.priceFrom,
      price_to: opts.priceTo,
      area_from: opts.areaFrom,
      area_to: opts.areaTo,
      rooms_from: opts.roomsFrom,
      rooms_to: opts.roomsTo,
      districts: opts.districts,
      max_pages: opts.maxPages,
    });
    const result = JSON.parse(text);
    return (result.listings as unknown[]).map(normalizeImmoscout);
  } finally {
    await conn.close();
  }
}

function pickTop(listings: NormalizedListing[]): NormalizedListing | null {
  const candidates = listings.filter((l) => !l.requiresWaitlistTicket);
  const sorted = (candidates.length ? candidates : listings)
    .slice()
    .sort((a, b) => (a.pricePerSqm ?? 1e9) - (b.pricePerSqm ?? 1e9));
  return sorted[0] ?? null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'price-from': { type: 'string' },
      'price-to': { type: 'string' },
      'area-from': { type: 'string' },
      'area-to': { type: 'string' },
      'rooms-from': { type: 'string' },
      'rooms-to': { type: 'string' },
      districts: { type: 'string' },
      location: { type: 'string', default: 'Wien' },
      'max-pages': { type: 'string', default: '6' },
      'no-open': { type: 'boolean', default: false },
    },
  });
  const num = (v: string | undefined) => (v == null ? undefined : Number(v));
  const opts: CliOptions = {
    priceFrom: num(values['price-from']),
    priceTo: num(values['price-to']),
    areaFrom: num(values['area-from']),
    areaTo: num(values['area-to']),
    roomsFrom: num(values['rooms-from']),
    roomsTo: num(values['rooms-to']),
    districts: values.districts ? parseDistrictsArg(values.districts) : undefined,
    location: values.location,
    maxPages: Number(values['max-pages']),
    noOpen: values['no-open'],
  };

  const [wh, is24] = await Promise.allSettled([huntWillhaben(opts), huntImmoscout(opts)]);
  const warnings: string[] = [];
  const willhabenListings = wh.status === 'fulfilled' ? wh.value : [];
  if (wh.status === 'rejected') {
    warnings.push(`willhaben source failed: ${(wh.reason as Error).message}`);
    console.error('WARNING: willhaben failed:', wh.reason);
  }
  const immoscoutListings = is24.status === 'fulfilled' ? is24.value : [];
  if (is24.status === 'rejected') {
    warnings.push(`immoscout source failed: ${(is24.reason as Error).message}`);
    console.error('WARNING: immoscout failed:', is24.reason);
  }
  if (warnings.length === 2) {
    console.error('Both sources failed — no report generated.');
    process.exit(1);
  }

  const rawListings = [...willhabenListings, ...immoscoutListings];
  const { merged, duplicatePairs } = dedupeListings(rawListings);
  scoreValue(merged);

  const reportsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
  writeFileSync(reportPath, renderReport({
    listings: merged,
    rawListings,
    generatedAt: new Date().toISOString(),
    query: { ...values, districts: opts.districts },
    warnings,
    duplicatePairs,
  }));

  const top = pickTop(merged);
  const summary = {
    reportPath,
    counts: {
      willhaben: willhabenListings.length,
      immoscout: immoscoutListings.length,
      merged: merged.length,
      duplicates: duplicatePairs,
    },
    topPick: top ? { title: top.title, price: top.price, url: top.url } : null,
    warnings,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  if (!opts.noOpen) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(opener, [reportPath], () => {});
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/\.ts$/, '.js'));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
