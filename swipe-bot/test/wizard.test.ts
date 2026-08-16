import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialWizardState, applyWizardChoice, isWizardComplete, finalizePrefs, WIZARD_STEPS, BUDGET_BANDS, DISTRICT_GROUPS,
} from '../src/wizard.js';

test('a fresh wizard starts at step 0 (name) and is not complete', () => {
  const s = initialWizardState();
  assert.equal(s.stepIndex, 0);
  assert.equal(WIZARD_STEPS[s.stepIndex], 'name');
  assert.equal(isWizardComplete(s), false);
});

test('applying a full sequence of choices completes the wizard and produces valid prefs', () => {
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'Studio Center' });
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: 700, priceTo: 900 });
  s = applyWizardChoice(s, { kind: 'districts_toggle', district: 6 });
  s = applyWizardChoice(s, { kind: 'districts_toggle', district: 7 });
  s = applyWizardChoice(s, { kind: 'districts_continue' });
  s = applyWizardChoice(s, { kind: 'rooms_size', roomsFrom: 1, roomsTo: 2, areaFrom: null, areaTo: null });
  s = applyWizardChoice(s, { kind: 'amenity_toggle', field: 'requireElevator' });
  s = applyWizardChoice(s, { kind: 'amenities_continue' });
  s = applyWizardChoice(s, { kind: 'commute_skip' });
  assert.equal(isWizardComplete(s), true);
  const prefs = finalizePrefs(s);
  assert.deepEqual(prefs, {
    priceFrom: 700, priceTo: 900, districts: [6, 7], roomsFrom: 1, roomsTo: 2, areaFrom: null, areaTo: null,
    includeWaitlistHousing: false, includeWg: false, requireElevator: true, requireParking: false,
    commuteDestination: null, commuteLat: null, commuteLon: null,
  });
});

test('districts_toggle on an already-selected district removes it (tap to deselect)', () => {
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'X' });
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: null, priceTo: 700 });
  s = applyWizardChoice(s, { kind: 'districts_toggle', district: 6 });
  s = applyWizardChoice(s, { kind: 'districts_toggle', district: 6 });
  assert.deepEqual(s.partial.districts, []);
});

test('back pops the previous step and its answer, without losing earlier answers', () => {
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'X' });
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: null, priceTo: 700 });
  s = applyWizardChoice(s, { kind: 'back' });
  assert.equal(WIZARD_STEPS[s.stepIndex], 'budget');
  assert.equal(s.partial.priceTo, undefined); // budget answer cleared by going back
  assert.equal(s.profileName, 'X'); // name answer preserved
});

test('back on the very first step is a no-op (nothing to go back to)', () => {
  let s = initialWizardState();
  const before = s;
  s = applyWizardChoice(s, { kind: 'back' });
  assert.deepEqual(s, before);
});

test('a choice that does not belong to the current step throws', () => {
  const s = initialWizardState(); // step 0 is 'name'
  assert.throws(() => applyWizardChoice(s, { kind: 'commute_skip' }));
});

test('BUDGET_BANDS has the four bands from the spec, in order', () => {
  assert.deepEqual(BUDGET_BANDS.map((b) => b.label), ['€500-700', '€700-900', '€900-1100', '€1100+']);
  assert.equal(BUDGET_BANDS[3].priceTo, Infinity); // "No limit" style top band
});

test('DISTRICT_GROUPS covers 1-23 with no gaps or overlaps', () => {
  const all = DISTRICT_GROUPS.flatMap((g) => g.districts);
  assert.deepEqual([...all].sort((a, b) => a - b), Array.from({ length: 23 }, (_, i) => i + 1));
});

test('back on the districts step clears any toggled districts', () => {
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'X' });
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: null, priceTo: 700 });
  s = applyWizardChoice(s, { kind: 'districts_toggle', district: 6 });
  s = applyWizardChoice(s, { kind: 'districts_continue' });
  s = applyWizardChoice(s, { kind: 'back' });
  assert.equal(WIZARD_STEPS[s.stepIndex], 'districts');
  assert.equal(s.partial.districts, undefined);
});

test('amenity_toggle flips a single field without touching the others', () => {
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'X' });
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: null, priceTo: 700 });
  s = applyWizardChoice(s, { kind: 'districts_continue' });
  s = applyWizardChoice(s, { kind: 'rooms_size', roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null });
  s = applyWizardChoice(s, { kind: 'amenity_toggle', field: 'requireParking' });
  assert.equal(s.partial.requireParking, true);
  assert.equal(s.partial.requireElevator, undefined);
  s = applyWizardChoice(s, { kind: 'amenity_toggle', field: 'requireParking' });
  assert.equal(s.partial.requireParking, false);
});

test('commute_set stores destination and coordinates and completes the wizard', () => {
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'X' });
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: null, priceTo: 700 });
  s = applyWizardChoice(s, { kind: 'districts_continue' });
  s = applyWizardChoice(s, { kind: 'rooms_size', roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null });
  s = applyWizardChoice(s, { kind: 'amenities_continue' });
  s = applyWizardChoice(s, { kind: 'commute_set', destination: 'TU Wien', lat: 48.1986, lon: 16.3695 });
  assert.equal(isWizardComplete(s), true);
  const prefs = finalizePrefs(s);
  assert.equal(prefs.commuteDestination, 'TU Wien');
  assert.equal(prefs.commuteLat, 48.1986);
  assert.equal(prefs.commuteLon, 16.3695);
});

test('finalizePrefs throws if the wizard is not yet complete', () => {
  const s = initialWizardState();
  assert.throws(() => finalizePrefs(s));
});

test('finalizePrefs fills neutral defaults for a step whose partial was never populated', () => {
  // Simulate reaching the end of the wizard without ever recording amenities/commute data
  // (e.g. a hand-built state, or a future editingProfileId jump that skips a step).
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'X' });
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: null, priceTo: 700 });
  s = applyWizardChoice(s, { kind: 'districts_continue' });
  s = applyWizardChoice(s, { kind: 'rooms_size', roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null });
  s = { ...s, stepIndex: s.stepIndex + 2 }; // skip past amenities and commute without visiting them
  assert.equal(isWizardComplete(s), true);
  const prefs = finalizePrefs(s);
  assert.equal(prefs.requireElevator, false);
  assert.equal(prefs.requireParking, false);
  assert.equal(prefs.includeWaitlistHousing, false);
  assert.equal(prefs.includeWg, false);
  assert.equal(prefs.commuteDestination, null);
});

test('finalizePrefs defaults an unvisited budget step to priceTo: null, not Infinity (matches every other unvisited field defaulting to null/false)', () => {
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'X' });
  s = { ...s, stepIndex: s.stepIndex + 1 }; // skip past budget without visiting it
  s = applyWizardChoice(s, { kind: 'districts_continue' });
  s = applyWizardChoice(s, { kind: 'rooms_size', roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null });
  s = applyWizardChoice(s, { kind: 'amenities_continue' });
  s = applyWizardChoice(s, { kind: 'commute_skip' });
  assert.equal(isWizardComplete(s), true);
  const prefs = finalizePrefs(s);
  assert.equal(prefs.priceTo, null);
});

test('finalizePrefs normalizes the top BUDGET_BANDS choice (priceTo: Infinity) to priceTo: null', () => {
  let s = initialWizardState();
  s = applyWizardChoice(s, { kind: 'name', name: 'X' });
  const topBand = BUDGET_BANDS[BUDGET_BANDS.length - 1];
  s = applyWizardChoice(s, { kind: 'budget', priceFrom: topBand.priceFrom, priceTo: topBand.priceTo });
  s = applyWizardChoice(s, { kind: 'districts_continue' });
  s = applyWizardChoice(s, { kind: 'rooms_size', roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null });
  s = applyWizardChoice(s, { kind: 'amenities_continue' });
  s = applyWizardChoice(s, { kind: 'commute_skip' });
  const prefs = finalizePrefs(s);
  assert.equal(prefs.priceTo, null);
});
