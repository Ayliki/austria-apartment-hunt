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

test('notification keys exist and carry their placeholders in every catalog', () => {
  for (const catalog of [en, ru, de]) {
    assert.match(catalog.notify_instant_header, /\{name\}/);
    assert.match(catalog.notify_digest_header, /\{count\}/);
    assert.match(catalog.notify_digest_header, /\{name\}/);
    assert.match(catalog.notify_digest_line, /\{price\}/);
    assert.ok(catalog.btn_open_listing.length > 0);
    assert.ok(catalog.notify_paused.length > 0);
  }
});
