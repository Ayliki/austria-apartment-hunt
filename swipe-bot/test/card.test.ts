import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, viennaPostalCode, districtLabel, VIENNA_DISTRICT_NAMES } from '../src/card.js';

test('escapeHtml escapes the three HTML-significant characters', () => {
  assert.equal(escapeHtml('Wohnung & Co <Neu>'), 'Wohnung &amp; Co &lt;Neu&gt;');
});

test('escapeHtml escapes ampersands before angle brackets, never double-escaping', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml leaves ordinary Austrian listing text untouched', () => {
  assert.equal(escapeHtml('Mariahilfer Straße 12/3'), 'Mariahilfer Straße 12/3');
});

test('viennaPostalCode derives the 4-digit code from a district number', () => {
  assert.equal(viennaPostalCode(1), '1010');
  assert.equal(viennaPostalCode(6), '1060');
  assert.equal(viennaPostalCode(23), '1230');
});

test('viennaPostalCode rejects districts outside 1-23 and null', () => {
  assert.equal(viennaPostalCode(0), null);
  assert.equal(viennaPostalCode(24), null);
  assert.equal(viennaPostalCode(null), null);
});

test('VIENNA_DISTRICT_NAMES covers all 23 districts', () => {
  assert.equal(VIENNA_DISTRICT_NAMES.length, 23);
  assert.equal(VIENNA_DISTRICT_NAMES[0], 'Innere Stadt');
  assert.equal(VIENNA_DISTRICT_NAMES[22], 'Liesing');
});

test('districtLabel pairs the postal code with the German district name', () => {
  assert.equal(districtLabel(6), '1060 Mariahilf');
  assert.equal(districtLabel(null), null);
  assert.equal(districtLabel(99), null);
});
