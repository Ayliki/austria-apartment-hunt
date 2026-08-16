import { type DB, type ChatLanguage, getChatLanguage } from './db.js';
import en from './locales/en.js';
import ru from './locales/ru.js';
import de from './locales/de.js';

export type LocaleKey = keyof typeof en;
type Catalog = Record<LocaleKey, string>;

const CATALOGS: Record<ChatLanguage, Catalog> = { en, ru: ru as Catalog, de: de as Catalog };

export const LOCALE_NAMES: Record<ChatLanguage, string> = { en: 'English', ru: 'Русский', de: 'Deutsch' };

/** Resolves the chat's language and formats the given key's template, substituting {param} placeholders. Falls back to English text if a key is ever missing from a non-English catalog (shouldn't happen — enforced by the key-parity test — but keeps a bot reply from throwing). */
export function t(db: DB, chatId: number, key: LocaleKey, params: Record<string, string | number> = {}): string {
  const language = getChatLanguage(db, chatId);
  const template = CATALOGS[language][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}
