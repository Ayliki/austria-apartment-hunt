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

test('formatCard renders each warning flag, and omits each when it does not apply', () => {
  assert.ok(formatCard(row({ isWg: true })).includes(DEFAULT_CARD_LABELS.wgWarning));
  assert.ok(!formatCard(row({ isWg: false })).includes(DEFAULT_CARD_LABELS.wgWarning));

  assert.ok(formatCard(row({ requiresWaitlistTicket: true })).includes(DEFAULT_CARD_LABELS.waitlistWarning));
  assert.ok(!formatCard(row({ requiresWaitlistTicket: false })).includes(DEFAULT_CARD_LABELS.waitlistWarning));

  assert.ok(formatCard(row({ isDelisted: true })).includes(DEFAULT_CARD_LABELS.delistedWarning));
  assert.ok(!formatCard(row({ isDelisted: false })).includes(DEFAULT_CARD_LABELS.delistedWarning));
});

test('formatCard renders the pet badge only when the listing mentions pets', () => {
  assert.ok(formatCard(row({ mentionsPets: true })).includes(DEFAULT_CARD_LABELS.petBadge));
  assert.ok(!formatCard(row({ mentionsPets: false })).includes(DEFAULT_CARD_LABELS.petBadge));
});

test('formatCard renders the size line: area, rooms, and floor, each with its label', () => {
  const out = formatCard(row({ area: 38, rooms: 1, floor: '3. Stock' }));
  assert.ok(out.includes('38 m²'));
  assert.ok(out.includes(`1 ${DEFAULT_CARD_LABELS.rooms}`));
  assert.ok(out.includes(`${DEFAULT_CARD_LABELS.floor} 3. Stock`));
});

test('formatCard omits the size line entirely when area, rooms, and floor are all unknown', () => {
  const out = formatCard(row({ area: null, rooms: null, floor: null }));
  assert.ok(!out.includes('📐'));
});

test('formatCard renders the amenity line: lift, parking count, energy class, and available-from, each with its label', () => {
  const out = formatCard(row({ lift: true, parkingSpaces: 2, energyClass: 'B', availableFrom: '01.09.2026' }));
  assert.ok(out.includes(DEFAULT_CARD_LABELS.lift));
  assert.ok(out.includes(`${DEFAULT_CARD_LABELS.parking} (2)`));
  assert.ok(out.includes(`${DEFAULT_CARD_LABELS.energy} B`));
  assert.ok(out.includes(`${DEFAULT_CARD_LABELS.availableFrom} 01.09.2026`));
});

test('formatCard omits amenity facts entirely when unknown, never fabricating "no" for a null field', () => {
  const out = formatCard(row({ lift: null, parkingSpaces: null, floor: null, energyClass: null, availableFrom: null }));
  assert.ok(!out.includes(DEFAULT_CARD_LABELS.lift));
  assert.ok(!out.includes(DEFAULT_CARD_LABELS.parking));
  assert.ok(!out.includes(DEFAULT_CARD_LABELS.energy));
  assert.ok(!out.includes(DEFAULT_CARD_LABELS.availableFrom));
});

test('formatCard never renders "Parking (0)" for a listing with zero parking spaces', () => {
  assert.ok(!formatCard(row({ parkingSpaces: 0 })).includes(DEFAULT_CARD_LABELS.parking));
});

test('formatCard renders the lift badge only when lift is exactly true, not merely truthy-ambiguous false', () => {
  assert.ok(!formatCard(row({ lift: false })).includes(DEFAULT_CARD_LABELS.lift));
});

test('formatCard renders the commute line when supplied, and omits it entirely otherwise', () => {
  const out = formatCard(row(), { commuteLine: '🚇 21 min to TU Wien' });
  assert.ok(out.includes('🚇 21 min to TU Wien'));

  assert.ok(!formatCard(row(), { commuteLine: null }).includes('🚇 21 min to TU Wien'));
  assert.ok(!formatCard(row()).includes('🚇 21 min to TU Wien'));
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

// prefix and commuteLine are the only two fields formatCard splices in verbatim from the caller —
// unlike title/description/addressLine/floor/energyClass/availableFrom, they used to bypass both
// escaping and the length budget entirely. A search-profile name (prefix, via the instant-alert
// header) and a commute destination (commuteLine) are both raw free-text a user typed, with no
// validation upstream, so both a "can't parse entities" send failure and a blown budget are real,
// reachable bugs — not hypothetical ones.

test('formatCard escapes a caller-supplied prefix, so a profile name containing markup characters cannot break the HTML send', () => {
  const out = formatCard(row(), { prefix: 'Suche <1000€\n\n' });
  assert.ok(!out.includes('<1000€'), 'a raw angle bracket from the prefix must never survive into the output');
  assert.ok(out.includes('Suche &lt;1000€'));
});

test('formatCard bounds a caller-supplied prefix, so a long profile name cannot blow the caption budget on its own', () => {
  const longProfileName = 'x'.repeat(2200);
  const out = formatCard(row(), { prefix: `🔥 Strong match · ${longProfileName}\n\n`, maxLength: CARD_CAPTION_LIMIT });
  assert.ok(out.length <= CARD_CAPTION_LIMIT, `got ${out.length}`);
});

test('formatCard does not truncate a normal, everyday prefix, even one close to the old fixed cap', () => {
  // "1 Zimmer Wohnung Wien" (21 chars) plus the header wrapper used to overflow PREFIX_MAX in every
  // locale under the first version of this fix — prefix/commuteLine now only shrink once
  // description and title have already given up everything they can, so a normal card (which fits
  // comfortably under budget on its own) never reaches that step.
  const prefix = '🔥 Strong match · 1 Zimmer Wohnung Wien\n\n';
  const out = formatCard(row(), { prefix, maxLength: CARD_CAPTION_LIMIT });
  assert.ok(out.startsWith(prefix), 'a realistic profile name must survive completely untouched');
});

test('formatCard preserves the prefix\'s trailing line break when it does have to truncate it, instead of gluing the ellipsis to the title', () => {
  const longProfileName = 'x'.repeat(2200);
  const out = formatCard(row(), { prefix: `🔥 Strong match · ${longProfileName}\n\n`, maxLength: CARD_CAPTION_LIMIT });
  assert.ok(!out.includes('…<b>'), 'a truncated prefix must never run directly into the title with no line break');
  assert.match(out, /\n<b>/, 'the title must still start on its own line after a truncated prefix');
});

test('formatCard escapes a caller-supplied commute line, so a destination containing markup characters cannot break the HTML send', () => {
  const out = formatCard(row(), { commuteLine: '📍 18 min walk to <script>evil</script>' });
  assert.ok(!out.includes('<script>'), 'raw markup from the commute destination must never survive into the output');
  assert.ok(out.includes('&lt;script&gt;'));
});

test('formatCard bounds a caller-supplied commute line, so a long commute destination cannot blow the caption budget on its own', () => {
  const longDestination = 'x'.repeat(2200);
  const out = formatCard(row(), { commuteLine: `📍 18 min walk to ${longDestination}`, maxLength: CARD_CAPTION_LIMIT });
  assert.ok(out.length <= CARD_CAPTION_LIMIT, `got ${out.length}`);
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
