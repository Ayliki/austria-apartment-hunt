import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, viennaPostalCode, districtLabel, VIENNA_DISTRICT_NAMES } from '../src/card.js';

test('escapeHtml escapes the four HTML-significant characters', () => {
  assert.equal(escapeHtml('Wohnung & Co <Neu> "toll"'), 'Wohnung &amp; Co &lt;Neu&gt; &quot;toll&quot;');
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

import { formatCard, CARD_CAPTION_LIMIT, CARD_MESSAGE_LIMIT, DEFAULT_CARD_LABELS } from '../src/card.js';
import type { ListingRow } from '../src/db.js';

function row(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    id: 'willhaben:1', source: 'willhaben', title: 'Helle Garconniere',
    price: 800, pricePerSqm: 21, area: 38, rooms: 1, district: 6,
    isPrivate: true, images: [], description: null, url: 'https://willhaben.at/x/1',
    valueFlag: 'good', firstSeen: '2026-08-01T00:00:00.000Z',
    requiresWaitlistTicket: false, isWg: false, addressLine: null,
    lat: null, lon: null, isDelisted: false,
    lift: null, parkingSpaces: null, floor: null, energyClass: null,
    availableFrom: null, mentionsPets: false,
    ...overrides,
  };
}

test('formatCard renders the title bold on the first line', () => {
  const out = formatCard(row());
  assert.match(out.split('\n')[0], /^<b>.*Helle Garconniere.*<\/b>$/);
});

test('formatCard escapes HTML-significant characters in the title', () => {
  const out = formatCard(row({ title: 'Wohnung <neu> & schön' }));
  assert.ok(out.includes('Wohnung &lt;neu&gt; &amp; schön'));
  assert.ok(!out.includes('<neu>'), 'raw angle brackets must never survive into the output');
});

test('formatCard escapes the url inside the href attribute', () => {
  const out = formatCard(row({ url: 'https://willhaben.at/x?a=1&b=2' }));
  assert.ok(out.includes('href="https://willhaben.at/x?a=1&amp;b=2"'));
});

test('formatCard renders the location line as postal code plus district name', () => {
  assert.ok(formatCard(row()).includes('1060 Mariahilf'));
});

test('formatCard appends the address line to the location when present', () => {
  const out = formatCard(row({ addressLine: 'Mariahilfer Straße 12' }));
  assert.ok(out.includes('1060 Mariahilf'));
  assert.ok(out.includes('Mariahilfer Straße 12'));
});

test('formatCard falls back to the address alone when the district is unknown', () => {
  const out = formatCard(row({ district: null, addressLine: 'Testgasse 1' }));
  assert.ok(out.includes('Testgasse 1'));
  assert.ok(!out.includes('undefined'));
});

test('formatCard omits the location line entirely when district and address are both missing', () => {
  const out = formatCard(row({ district: null, addressLine: null }));
  assert.ok(!out.includes('📍'));
  assert.ok(!/\n\n\n/.test(out), 'omitted lines must not leave blank gaps');
});

test('formatCard renders price with price-per-sqm and the value badge', () => {
  const out = formatCard(row());
  assert.ok(out.includes('€800'));
  assert.ok(out.includes('€21/m²'));
  assert.ok(out.includes(DEFAULT_CARD_LABELS.valueGood));
});

test('formatCard omits price-per-sqm when it is unknown', () => {
  const out = formatCard(row({ pricePerSqm: null }));
  assert.ok(out.includes('€800'));
  assert.ok(!out.includes('/m²'));
});

test('formatCard renders each warning flag', () => {
  assert.ok(formatCard(row({ isWg: true })).includes(DEFAULT_CARD_LABELS.wgWarning));
  assert.ok(formatCard(row({ requiresWaitlistTicket: true })).includes(DEFAULT_CARD_LABELS.waitlistWarning));
  assert.ok(formatCard(row({ isDelisted: true })).includes(DEFAULT_CARD_LABELS.delistedWarning));
});

test('formatCard renders the pet badge only when the listing mentions pets', () => {
  assert.ok(formatCard(row({ mentionsPets: true })).includes(DEFAULT_CARD_LABELS.petBadge));
  assert.ok(!formatCard(row({ mentionsPets: false })).includes(DEFAULT_CARD_LABELS.petBadge));
});

test('formatCard renders the commute line when supplied', () => {
  const out = formatCard(row(), { commuteLine: '🚇 21 min to TU Wien' });
  assert.ok(out.includes('🚇 21 min to TU Wien'));
});

test('formatCard renders the description italic, sliced to 200 characters', () => {
  const out = formatCard(row({ description: 'x'.repeat(500) }));
  const match = out.match(/<i>(.*?)<\/i>/s);
  assert.ok(match, 'description must be wrapped in <i>');
  assert.ok(match[1].length <= 201, 'sliced description plus ellipsis stays within budget');
  assert.ok(match[1].endsWith('…'));
});

test('formatCard escapes the description before italicising it', () => {
  const out = formatCard(row({ description: 'Nähe <U4> & Park' }));
  assert.ok(out.includes('Nähe &lt;U4&gt; &amp; Park'));
});

test('formatCard omits the description block when there is no description', () => {
  assert.ok(!formatCard(row()).includes('<i>'));
});

test('formatCard renders the link as an anchor, never a bare url', () => {
  const out = formatCard(row());
  assert.ok(out.includes('<a href="https://willhaben.at/x/1">'));
  assert.ok(!/\n https:\/\//.test(out), 'the raw url must not appear as its own line');
});

test('formatCard respects the caption budget', () => {
  const out = formatCard(row({ title: 'T'.repeat(400), description: 'd'.repeat(2000) }),
    { maxLength: CARD_CAPTION_LIMIT });
  assert.ok(out.length <= CARD_CAPTION_LIMIT, `got ${out.length}`);
});

test('formatCard respects the message budget', () => {
  const out = formatCard(row({ title: 'T'.repeat(3000), description: 'd'.repeat(3000) }),
    { maxLength: CARD_MESSAGE_LIMIT });
  assert.ok(out.length <= CARD_MESSAGE_LIMIT, `got ${out.length}`);
});

test('formatCard never truncates inside a tag or an entity', () => {
  const out = formatCard(row({ title: 'A&B '.repeat(300), description: 'd'.repeat(2000) }),
    { maxLength: CARD_CAPTION_LIMIT });
  const opens = (out.match(/</g) ?? []).length;
  const closes = (out.match(/>/g) ?? []).length;
  assert.equal(opens, closes, 'every tag delimiter must be balanced');
  assert.ok(!/&[a-z]*$/.test(out), 'output must not end mid-entity');
});

test('formatCard prepends the prefix when supplied', () => {
  const out = formatCard(row(), { prefix: '❤️ 1 of 3\n\n' });
  assert.ok(out.startsWith('❤️ 1 of 3'));
});

test('formatCard bounds every scraped field independently, so no single oversized field can blow the budget', () => {
  const overflowValue = 'x'.repeat(3000);
  const overrides: Partial<ListingRow>[] = [
    { title: overflowValue },
    { description: overflowValue },
    { addressLine: overflowValue },
    { floor: overflowValue },
    { energyClass: overflowValue },
    { availableFrom: overflowValue },
  ];
  for (const override of overrides) {
    const field = Object.keys(override)[0];
    for (const maxLength of [CARD_CAPTION_LIMIT, CARD_MESSAGE_LIMIT]) {
      const out = formatCard(row(override), { maxLength });
      assert.ok(out.length <= maxLength, `${field} at maxLength ${maxLength}: got ${out.length}`);
    }
  }
});

test('formatCard stays within the caption budget even when every capped field is adversarially escape-heavy at once', () => {
  // Worst-case stress: all four field-level caps filled with '"', the character escapeHtml expands
  // the most (6x, "->&quot;), plus every warning/badge line enabled — exercises the caps working
  // together, not just one field at a time.
  const quoteBomb = '"'.repeat(3000);
  const out = formatCard(row({
    addressLine: quoteBomb, floor: quoteBomb, energyClass: quoteBomb, availableFrom: quoteBomb,
    isWg: true, requiresWaitlistTicket: true, isDelisted: true, mentionsPets: true,
  }), { maxLength: CARD_CAPTION_LIMIT });
  assert.ok(out.length <= CARD_CAPTION_LIMIT, `got ${out.length}`);
});
