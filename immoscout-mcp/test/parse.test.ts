import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEmbeddedJson, normalizeJsObjectLiteral } from '../src/parse.js';

test('normalizeJsObjectLiteral replaces bare undefined tokens with null', () => {
  assert.equal(
    normalizeJsObjectLiteral('{"a": undefined, "b": [undefined, 1], "c": "undefined"}'),
    '{"a": null, "b": [null, 1], "c": "undefined"}',
  );
});

test('normalizeJsObjectLiteral does not replace undefined inside strings', () => {
  assert.equal(
    normalizeJsObjectLiteral('{"a": "Note: undefined, please ignore", "b": undefined}'),
    '{"a": "Note: undefined, please ignore", "b": null}',
  );
});

test('extractEmbeddedJson extracts a balanced object after a marker', () => {
  const html = `<html><script>window.__INITIAL_STATE__ = {"a": 1, "b": {"c": "x{y}"}};</script></html>`;
  assert.deepEqual(extractEmbeddedJson(html, 'window.__INITIAL_STATE__'), { a: 1, b: { c: 'x{y}' } });
});

test('extractEmbeddedJson ignores braces inside strings and escaped quotes', () => {
  const html = `window.__APOLLO_STATE__ = {"t": "a \\"quoted\\" } brace", "n": undefined};`;
  assert.deepEqual(extractEmbeddedJson(html, 'window.__APOLLO_STATE__'), {
    t: 'a "quoted" } brace',
    n: null,
  });
});

test('extractEmbeddedJson throws a specific error when the marker is absent', () => {
  assert.throws(() => extractEmbeddedJson('<html></html>', 'window.__INITIAL_STATE__'), /marker not found/);
});

test('extractEmbeddedJson throws on an unbalanced literal', () => {
  assert.throws(() => extractEmbeddedJson('window.X = {"a": 1', 'window.X'), /unbalanced/);
});
