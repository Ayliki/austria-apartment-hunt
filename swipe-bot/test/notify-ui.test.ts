import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNotifyMenu, nextDailyCap, CAP_LADDER } from '../src/notify-ui.js';
import { openDb, createSearchProfile, getSearchProfile, updateNotifySettings } from '../src/db.js';

function prefs() {
  return {
    priceFrom: null, priceTo: 900, districts: null, roomsFrom: null, roomsTo: null, areaFrom: null, areaTo: null,
    includeWaitlistHousing: true, includeWg: true, requireElevator: false, requireParking: false,
    commuteDestination: null, commuteLat: null, commuteLon: null,
  };
}

test('nextDailyCap steps down the ladder and stops at the floor', () => {
  assert.equal(nextDailyCap(6, 'less'), 3);
  assert.equal(nextDailyCap(3, 'less'), 1);
  assert.equal(nextDailyCap(1, 'less'), 0);
  assert.equal(nextDailyCap(0, 'less'), 0);
});

test('nextDailyCap steps up the ladder and stops at the ceiling', () => {
  assert.equal(nextDailyCap(6, 'more'), 12);
  assert.equal(nextDailyCap(12, 'more'), 12);
});

test('nextDailyCap snaps an off-ladder value onto the ladder', () => {
  assert.ok(CAP_LADDER.includes(nextDailyCap(7, 'less')));
  assert.ok(CAP_LADDER.includes(nextDailyCap(7, 'more')));
});

test('renderNotifyMenu offers Pause for an active profile and Resume for a paused one', () => {
  const db = openDb(':memory:');
  const id = createSearchProfile(db, 1, 'Test', prefs()).id;
  const profile = getSearchProfile(db, id)!;

  const active = renderNotifyMenu(db, 1, profile);
  assert.match(JSON.stringify(active.keyboard), /notify:pause/);

  updateNotifySettings(db, id, { paused: true });
  const paused = renderNotifyMenu(db, 1, profile);
  assert.match(JSON.stringify(paused.keyboard), /notify:resume/);
});

test('renderNotifyMenu states the current cap and digest hours', () => {
  const db = openDb(':memory:');
  const id = createSearchProfile(db, 1, 'Test', prefs()).id;
  updateNotifySettings(db, id, { dailyCap: 3, digestHours: [9, 19] });
  const { text } = renderNotifyMenu(db, 1, getSearchProfile(db, id)!);

  assert.match(text, /3/);
  assert.match(text, /09:00/);
  assert.match(text, /19:00/);
  assert.ok(!text.includes('{'), 'no unsubstituted placeholders');
});
