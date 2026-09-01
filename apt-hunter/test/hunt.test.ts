import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_SOURCES,
  DEFAULT_SOURCES,
  combineHuntResults,
  immoscoutSpec,
  parseSources,
  resolveSources,
  selectEnrichIds,
  willhabenSpec,
} from '../src/hunt.js';
import type { NormalizedListing } from '../src/normalize.js';

function listing(id: string, source: NormalizedListing['source'] = 'willhaben'): NormalizedListing {
  return {
    source, id, url: `https://x/${id}`, title: id,
    price: null, pricePerSqm: null, area: null, rooms: null, district: null,
    zip: null, addressLine: null, lat: null, lon: null, isPrivate: null,
    requiresWaitlistTicket: false, images: [], dateCreated: null,
  };
}

test('combineHuntResults flattens the outcomes in the order given, so source priority survives', () => {
  const result = combineHuntResults([
    { source: 'immoscout', result: { status: 'fulfilled', value: [listing('b', 'immoscout')] } },
    { source: 'willhaben', result: { status: 'fulfilled', value: [listing('a')] } },
  ]);
  assert.deepEqual(result.listings.map((l) => l.id), ['b', 'a']);
  assert.deepEqual(result.warnings, []);
});

test('combineHuntResults keeps the successful source and names the failed one in the warning', () => {
  const result = combineHuntResults([
    { source: 'immoscout', result: { status: 'fulfilled', value: [listing('b', 'immoscout')] } },
    { source: 'willhaben', result: { status: 'rejected', reason: new Error('blocked') } },
  ]);
  assert.deepEqual(result.listings.map((l) => l.id), ['b']);
  assert.deepEqual(result.warnings, ['willhaben source failed: blocked']);
});

test('combineHuntResults returns empty listings with one warning per failed source', () => {
  const result = combineHuntResults([
    { source: 'immoscout', result: { status: 'rejected', reason: new Error('a') } },
    { source: 'willhaben', result: { status: 'rejected', reason: new Error('b') } },
  ]);
  assert.deepEqual(result.listings, []);
  assert.equal(result.warnings.length, 2);
});

test('combineHuntResults handles a single-source hunt (the default set)', () => {
  const result = combineHuntResults([
    { source: 'immoscout', result: { status: 'fulfilled', value: [listing('b', 'immoscout')] } },
  ]);
  assert.deepEqual(result.listings.map((l) => l.id), ['b']);
  assert.deepEqual(result.warnings, []);
});

test('DEFAULT_SOURCES is immoscout alone — willhaben must never turn itself on', () => {
  // Guards the legal posture, not a preference: willhaben's robots.txt expressly forbids automated
  // access, immobilienscout24.at's allows it. Flipping this default has to be a deliberate edit
  // that breaks this test, never a quiet one-word change somewhere else.
  assert.deepEqual([...DEFAULT_SOURCES], ['immoscout']);
  assert.ok(!DEFAULT_SOURCES.includes('willhaben'));
});

test('ALL_SOURCES lists immoscout first, so the primary source wins dedupe ties', () => {
  assert.deepEqual([...ALL_SOURCES], ['immoscout', 'willhaben']);
});

test('parseSources falls back to the default set for undefined, empty and whitespace-only input', () => {
  for (const raw of [undefined, '', '   ', ',', ' , , ']) {
    assert.deepEqual(parseSources(raw), ['immoscout'], `input: ${JSON.stringify(raw)}`);
  }
});

test('parseSources accepts an explicit opt-in to willhaben, case- and whitespace-insensitively', () => {
  assert.deepEqual(parseSources('willhaben'), ['willhaben']);
  assert.deepEqual(parseSources(' Willhaben , IMMOSCOUT '), ['immoscout', 'willhaben']);
});

test('parseSources normalizes order to ALL_SOURCES, so priority cannot be reordered by input', () => {
  assert.deepEqual(parseSources('willhaben,immoscout'), ['immoscout', 'willhaben']);
});

test('parseSources dedupes repeated names', () => {
  assert.deepEqual(parseSources('immoscout,immoscout'), ['immoscout']);
});

test('parseSources throws on an unknown source rather than silently running the default', () => {
  // A typo like APT_SOURCES=immoscout24 must not read as "no sources given, use the default".
  assert.throws(() => parseSources('immoscout24'), /Unknown source\(s\): immoscout24/);
  assert.throws(() => parseSources('immoscout,willhaben,zillow'), /zillow/);
});

test('resolveSources prefers the explicit argument, then APT_SOURCES, then the default', () => {
  assert.deepEqual(resolveSources('willhaben', 'immoscout'), ['willhaben']);
  assert.deepEqual(resolveSources(undefined, 'immoscout,willhaben'), ['immoscout', 'willhaben']);
  assert.deepEqual(resolveSources(undefined, undefined), ['immoscout']);
});

test('resolveSources reads APT_SOURCES from the real environment when no env argument is passed', () => {
  const prev = process.env.APT_SOURCES;
  try {
    delete process.env.APT_SOURCES;
    assert.deepEqual(resolveSources(), ['immoscout']);
    process.env.APT_SOURCES = 'immoscout,willhaben';
    assert.deepEqual(resolveSources(), ['immoscout', 'willhaben']);
  } finally {
    if (prev == null) delete process.env.APT_SOURCES;
    else process.env.APT_SOURCES = prev;
  }
});

test('selectEnrichIds takes the first `cap` ids in order when there is no isNew predicate', () => {
  const result = selectEnrichIds(['a', 'b', 'c', 'd'], 2);
  assert.deepEqual([...result].sort(), ['a', 'b']);
});

test('selectEnrichIds prioritizes ids the predicate marks as new over already-known ones', () => {
  // 'c' and 'd' are new but sort last in search order; a cap-2 slice-in-order would starve them entirely.
  const isNew = (id: string) => id === 'c' || id === 'd';
  const result = selectEnrichIds(['a', 'b', 'c', 'd'], 2, isNew);
  assert.deepEqual([...result].sort(), ['c', 'd']);
});

test('selectEnrichIds pads out leftover cap with already-known ids once all new ones are included', () => {
  const isNew = (id: string) => id === 'c';
  const result = selectEnrichIds(['a', 'b', 'c', 'd'], 2, isNew);
  assert.equal(result.size, 2);
  assert.ok(result.has('c')); // the one genuinely new id is never dropped
});

test('selectEnrichIds enriches everything when there are fewer ids than the cap', () => {
  const result = selectEnrichIds(['a', 'b'], 30, () => true);
  assert.deepEqual([...result].sort(), ['a', 'b']);
});

test('willhabenSpec defaults to the vendored patched package, respects WILLHABEN_MCP_PATH override', () => {
  delete process.env.WILLHABEN_MCP_PATH;
  const spec = willhabenSpec();
  assert.equal(spec.command, 'node');
  assert.match(spec.args[0], /willhaben-mcp-patched\/dist\/index\.js$/);

  process.env.WILLHABEN_MCP_PATH = '/custom/willhaben.js';
  assert.deepEqual(willhabenSpec().args, ['/custom/willhaben.js']);
  delete process.env.WILLHABEN_MCP_PATH;
});

test('immoscoutSpec defaults to the local immoscout-mcp build, respects IMMOSCOUT_MCP_PATH override', () => {
  delete process.env.IMMOSCOUT_MCP_PATH;
  const spec = immoscoutSpec();
  assert.equal(spec.command, 'node');
  assert.match(spec.args[0], /immoscout-mcp\/dist\/index\.js$/);

  process.env.IMMOSCOUT_MCP_PATH = '/custom/immoscout.js';
  assert.deepEqual(immoscoutSpec().args, ['/custom/immoscout.js']);
  delete process.env.IMMOSCOUT_MCP_PATH;
});
