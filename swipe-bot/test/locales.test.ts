import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, LOCALE_NAMES } from '../src/locales.js';
import { openDb, setChatLanguage } from '../src/db.js';
import en from '../src/locales/en.js';
import ru from '../src/locales/ru.js';
import de from '../src/locales/de.js';

test('t() falls back to English for a chat with no language set', () => {
  const db = openDb(':memory:');
  assert.equal(t(db, 1, 'help_intro'), 'I find Vienna rental apartments matching your preferences and let you swipe through them, like a dating app.');
});

test('t() returns the Russian string once the chat language is set to ru', () => {
  const db = openDb(':memory:');
  setChatLanguage(db, 1, 'ru');
  assert.match(t(db, 1, 'help_intro'), /[а-яА-Я]/); // contains Cyrillic
});

test('t() returns the German string once the chat language is set to de', () => {
  const db = openDb(':memory:');
  setChatLanguage(db, 1, 'de');
  assert.equal(t(db, 1, 'help_intro'), de.help_intro);
});

test('t() substitutes named params into the template', () => {
  const db = openDb(':memory:');
  const s = t(db, 1, 'wizard_progress', { step: 2, total: 6 });
  assert.match(s, /2\/6|2 из 6|2 von 6/); // exact wording is locale-specific; the numbers must appear
});

test('t() leaves an unrecognized placeholder untouched when no param is passed for it', () => {
  const db = openDb(':memory:');
  const s = t(db, 1, 'wizard_progress');
  assert.equal(s, 'Step {step}/{total}');
});

test('LOCALE_NAMES has native-language labels for en, ru, de', () => {
  assert.deepEqual(LOCALE_NAMES, { en: 'English', ru: 'Русский', de: 'Deutsch' });
});

test('the dead notify_digest_line key is gone from every catalog', () => {
  // Added by an earlier task, never wired up: the digest renders through formatPushEntry. Its
  // continued presence made the catalogs look like they described the digest format, which they did not.
  for (const [locale, catalog] of Object.entries({ en, ru, de } as Record<string, Record<string, string>>)) {
    assert.equal(catalog.notify_digest_line, undefined, `${locale} still carries the unused notify_digest_line`);
  }
});

test('every locale file has exactly the same key set as en.ts (no missing/extra translations)', () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
});

test('t() falls back per-chat: two different chats can have different languages simultaneously', () => {
  const db = openDb(':memory:');
  setChatLanguage(db, 1, 'ru');
  setChatLanguage(db, 2, 'de');
  assert.equal(t(db, 1, 'btn_skip'), ru.btn_skip);
  assert.equal(t(db, 2, 'btn_skip'), de.btn_skip);
});

// --- Final-review fix wave: ru/de help text must quote the *actual* (English) button labels, ---
// --- not a translated version of a button that never actually appears in that wording. ---

// The literal labels as they actually render in the chat — bot.ts's MAIN_KEYBOARD and the
// "Browse top matches ▸" button are hardcoded English, never localized.
const LITERAL_UI_LABELS = ['Browse top matches ▸', '⏭ Next', '📋 Shortlist', '⚙️ Settings'];

test('ru help_full quotes the literal English button labels rather than a translated version of them', () => {
  for (const label of LITERAL_UI_LABELS) {
    assert.ok(ru.help_full.includes(label), `expected ru help_full to include the literal label "${label}"`);
  }
  assert.doesNotMatch(ru.help_full, /Смотреть подборку/); // old, inaccurate translated mention
  assert.doesNotMatch(ru.help_full, /Далее \/ 📋 Избранное \/ ⚙️ Настройки/); // old, inaccurate translated mention
});

test('de help_full quotes the literal English button labels rather than a translated version of them', () => {
  for (const label of LITERAL_UI_LABELS) {
    assert.ok(de.help_full.includes(label), `expected de help_full to include the literal label "${label}"`);
  }
  assert.doesNotMatch(de.help_full, /Top-Treffer ansehen/); // old, inaccurate translated mention
  assert.doesNotMatch(de.help_full, /Weiter \/ 📋 Merkliste \/ ⚙️ Einstellungen/); // old, inaccurate translated mention
});

/**
 * Every notification key added for the quiet notifier, with the exact placeholders bot.ts feeds it.
 * A placeholder missing from one catalog renders as a literal `{cap}` to that user, and the
 * key-parity test above cannot catch it — only the placeholder set can.
 */
const NOTIFY_PLACEHOLDERS: Record<string, string[]> = {
  notify_instant_header: ['name'],
  notify_digest_header: ['name', 'count'],
  notify_entry_rooms: ['rooms'],
  notify_entry_district: ['district'],
  notify_paused: ['name'],
  notify_resumed: ['name'],
  notify_menu_header: ['name', 'status', 'cap', 'hours', 'quietStart', 'quietEnd'],
};

/** Keys with no placeholders that still must not be blank in any catalog. */
const NOTIFY_PLAIN_KEYS = [
  'notify_digest_best', 'notify_entry_price_unknown', 'btn_open_listing', 'settings_notifications',
  'btn_pause_search', 'btn_resume_search', 'btn_notify_less', 'btn_notify_more',
  'notify_status_active', 'notify_status_paused',
];

const CATALOGS = { en, ru, de } as Record<string, Record<string, string>>;

test('every notification key carries all of its placeholders in every catalog', () => {
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    for (const [key, placeholders] of Object.entries(NOTIFY_PLACEHOLDERS)) {
      const value = catalog[key];
      assert.ok(typeof value === 'string' && value.length > 0, `${locale}.${key} is missing or empty`);
      for (const placeholder of placeholders) {
        assert.ok(value.includes(`{${placeholder}}`), `${locale}.${key} is missing {${placeholder}}`);
      }
    }
  }
});

test('no notification string carries a placeholder the caller never supplies', () => {
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    for (const [key, placeholders] of Object.entries(NOTIFY_PLACEHOLDERS)) {
      const used = [...catalog[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const name of used) {
        assert.ok(placeholders.includes(name), `${locale}.${key} uses an unsupplied placeholder {${name}}`);
      }
    }
  }
});

test('placeholder-free notification keys are present and non-empty in every catalog', () => {
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    for (const key of NOTIFY_PLAIN_KEYS) {
      assert.ok(typeof catalog[key] === 'string' && catalog[key].length > 0, `${locale}.${key} is missing or empty`);
    }
  }
});

test('German copy closes every „ with a matching “ rather than a straight quote', () => {
  for (const [key, value] of Object.entries(de as Record<string, string>)) {
    const opens = (value.match(/„/g) ?? []).length;
    const closes = (value.match(/“/g) ?? []).length;
    assert.equal(closes, opens, `de.${key} opens ${opens} German quote(s) but closes ${closes}`);
    assert.ok(!/„[^“]*"/.test(value), `de.${key} closes a „ with a straight double quote`);
  }
});

test('user-facing notification copy carries no decorative em dash', () => {
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    for (const key of [...Object.keys(NOTIFY_PLACEHOLDERS), ...NOTIFY_PLAIN_KEYS]) {
      assert.ok(!catalog[key].includes('—'), `${locale}.${key} contains an em dash`);
    }
  }
});

// --- help_full must describe the quiet notifier (instant alerts + digest + quiet hours + pause), ---
// --- not the old "every poll pushes every new listing" behaviour. Per-language substrings, since ---
// --- a translated catalog earns nothing by matching English words. ---

test('help_full mentions pausing a search, in each catalog\'s own language', () => {
  assert.match(en.help_full, /pause/i);
  assert.match(ru.help_full, /паузу|паузе|паузы/i);
  assert.match(de.help_full, /pausier/i);
});

// These check wording specific to the NEW quiet-hours behaviour, not just "digest" in general —
// "digest/summary" alone already matched the old "I send a summary of what's already out there"
// sentence describing profile-activation summaries, so it couldn't fail against the pre-rewrite
// copy. "quiet hours" (and its ru/de equivalents) only exists in the new copy.
test('help_full mentions the digest/summary concept, in each catalog\'s own language', () => {
  assert.match(en.help_full, /digest|summary/i);
  assert.match(ru.help_full, /сводк/i);
  assert.match(de.help_full, /übersicht|zusammenfassung/i);
});

test('help_full describes quiet hours, in each catalog\'s own language', () => {
  assert.match(en.help_full, /quiet hours/i);
  assert.match(ru.help_full, /тихие часы/i);
  assert.match(de.help_full, /ruhezeiten/i);
});

test('help_full still carries the {maxProfiles} and {safetyNotice} placeholders after the notifications rewrite', () => {
  for (const catalog of [en, ru, de]) {
    assert.ok(catalog.help_full.includes('{maxProfiles}'), 'help_full is missing {maxProfiles}');
    assert.ok(catalog.help_full.includes('{safetyNotice}'), 'help_full is missing {safetyNotice}');
  }
});
