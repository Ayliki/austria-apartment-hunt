#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { huntSources, resolveSources, ALL_SOURCES, type HuntOptions, type SourceName } from './hunt.js';
import { dedupeListings } from './dedupe.js';
import { scoreValue } from './score.js';
import { renderReport } from './report.js';

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

interface CliOptions extends HuntOptions {
  noOpen: boolean;
}

function pickTop(listings: ReturnType<typeof dedupeListings>['merged']) {
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
      sources: { type: 'string' },
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
    location: values.location!,
    maxPages: Number(values['max-pages']),
    noOpen: values['no-open']!,
  };

  // Defaults to immoscout alone; --sources (or APT_SOURCES) is the conscious opt-in to willhaben.
  const sources = resolveSources(values.sources);
  const { listings: rawListings, warnings } = await huntSources(opts, sources);
  for (const w of warnings) console.error('WARNING:', w);
  if (warnings.length === sources.length) {
    console.error(`Every requested source failed (${sources.join(', ')}) — no report generated.`);
    process.exit(1);
  }

  const perSource = Object.fromEntries(
    ALL_SOURCES.map((s) => [s, rawListings.filter((l) => l.source === s).length]),
  ) as Record<SourceName, number>;

  const { merged, duplicatePairs } = dedupeListings(rawListings);
  scoreValue(merged);

  const reportsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
  writeFileSync(reportPath, renderReport({
    listings: merged,
    rawListings,
    generatedAt: new Date().toISOString(),
    query: { ...values, sources, districts: opts.districts },
    warnings,
    duplicatePairs,
  }));

  const top = pickTop(merged);
  const summary = {
    reportPath,
    sources,
    counts: {
      ...perSource,
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
