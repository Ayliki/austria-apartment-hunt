import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineHuntResults, selectEnrichIds, willhabenSpec, immoscoutSpec } from '../src/hunt.js';
import type { NormalizedListing } from '../src/normalize.js';

function listing(id: string): NormalizedListing {
  return {
    source: 'willhaben', id, url: `https://x/${id}`, title: id,
    price: null, pricePerSqm: null, area: null, rooms: null, district: null,
    zip: null, addressLine: null, lat: null, lon: null, isPrivate: null,
    requiresWaitlistTicket: false, images: [], dateCreated: null,
  };
}

test('combineHuntResults concatenates listings when both sources succeed', () => {
  const wh: PromiseSettledResult<NormalizedListing[]> = { status: 'fulfilled', value: [listing('a')] };
  const is24: PromiseSettledResult<NormalizedListing[]> = { status: 'fulfilled', value: [listing('b')] };
  const result = combineHuntResults(wh, is24);
  assert.deepEqual(result.listings.map((l) => l.id), ['a', 'b']);
  assert.deepEqual(result.warnings, []);
});

test('combineHuntResults keeps the successful source and warns about the failed one', () => {
  const wh: PromiseSettledResult<NormalizedListing[]> = { status: 'rejected', reason: new Error('blocked') };
  const is24: PromiseSettledResult<NormalizedListing[]> = { status: 'fulfilled', value: [listing('b')] };
  const result = combineHuntResults(wh, is24);
  assert.deepEqual(result.listings.map((l) => l.id), ['b']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /willhaben source failed: blocked/);
});

test('combineHuntResults returns empty listings with two warnings when both fail', () => {
  const wh: PromiseSettledResult<NormalizedListing[]> = { status: 'rejected', reason: new Error('a') };
  const is24: PromiseSettledResult<NormalizedListing[]> = { status: 'rejected', reason: new Error('b') };
  const result = combineHuntResults(wh, is24);
  assert.deepEqual(result.listings, []);
  assert.equal(result.warnings.length, 2);
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
