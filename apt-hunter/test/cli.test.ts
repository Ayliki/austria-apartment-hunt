import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDistrictsArg } from '../src/cli.js';

test('parseDistrictsArg parses ranges and lists', () => {
  assert.deepEqual(parseDistrictsArg('1-9'), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parseDistrictsArg('1,4,9'), [1, 4, 9]);
  assert.deepEqual(parseDistrictsArg('3'), [3]);
  assert.deepEqual(parseDistrictsArg(' 1 - 3 , 7 '), [1, 2, 3, 7]);
});

test('parseDistrictsArg rejects out-of-range districts', () => {
  assert.throws(() => parseDistrictsArg('0-3'), /district/);
  assert.throws(() => parseDistrictsArg('24'), /district/);
});
