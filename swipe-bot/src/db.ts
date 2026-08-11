import Database from 'better-sqlite3';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';

export type DB = Database.Database;

export interface UserPrefs {
  chatId: number;
  priceFrom: number | null;
  priceTo: number | null;
  districts: number[] | null;
  roomsFrom: number | null;
  roomsTo: number | null;
  areaFrom: number | null;
  areaTo: number | null;
}

export interface ListingRow {
  id: string;
  source: 'willhaben' | 'immoscout';
  title: string;
  price: number | null;
  pricePerSqm: number | null;
  area: number | null;
  rooms: number | null;
  district: number | null;
  isPrivate: boolean | null;
  images: string[];
  description: string | null;
  url: string;
  valueFlag: 'good' | 'fair' | 'premium' | null;
  firstSeen: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  price REAL, price_per_sqm REAL, area REAL, rooms REAL,
  district INTEGER, is_private INTEGER,
  images TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  value_flag TEXT,
  first_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_prefs (
  chat_id INTEGER PRIMARY KEY,
  price_from REAL, price_to REAL,
  districts TEXT,
  rooms_from REAL, rooms_to REAL,
  area_from REAL, area_to REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS swipes (
  chat_id INTEGER NOT NULL,
  listing_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  swiped_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, listing_id)
);

CREATE TABLE IF NOT EXISTS shortlist (
  chat_id INTEGER NOT NULL,
  listing_id TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, listing_id)
);

CREATE TABLE IF NOT EXISTS onboarding_state (
  chat_id INTEGER PRIMARY KEY,
  answers TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** CREATE TABLE IF NOT EXISTS never alters an existing table — new columns need an explicit migration. */
function migrate(db: DB): void {
  const columns = (db.prepare('PRAGMA table_info(listings)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('description')) {
    db.exec('ALTER TABLE listings ADD COLUMN description TEXT');
  }
}

export function listingKey(l: NormalizedListing): string {
  return `${l.source}:${l.id}`;
}

function rowToListing(row: Record<string, unknown>): ListingRow {
  return {
    id: row.id as string,
    source: row.source as 'willhaben' | 'immoscout',
    title: row.title as string,
    price: row.price as number | null,
    pricePerSqm: row.price_per_sqm as number | null,
    area: row.area as number | null,
    rooms: row.rooms as number | null,
    district: row.district as number | null,
    isPrivate: row.is_private == null ? null : Boolean(row.is_private),
    images: JSON.parse(row.images as string),
    description: row.description as string | null,
    url: row.url as string,
    valueFlag: row.value_flag as 'good' | 'fair' | 'premium' | null,
    firstSeen: row.first_seen as string,
  };
}

/** Returns true if this listing was newly inserted, false if it already existed (never overwritten). */
export function upsertListing(db: DB, l: NormalizedListing): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO listings (id, source, title, price, price_per_sqm, area, rooms, district, is_private, images, description, url, value_flag, first_seen)
    VALUES (@id, @source, @title, @price, @pricePerSqm, @area, @rooms, @district, @isPrivate, @images, @description, @url, @valueFlag, @firstSeen)
  `).run({
    id: listingKey(l),
    source: l.source,
    title: l.title,
    price: l.price,
    pricePerSqm: l.pricePerSqm,
    area: l.area,
    rooms: l.rooms,
    district: l.district,
    isPrivate: l.isPrivate == null ? null : (l.isPrivate ? 1 : 0),
    images: JSON.stringify(l.images),
    description: l.description,
    url: l.url,
    valueFlag: l.valueFlag ?? null,
    firstSeen: new Date().toISOString(),
  });
  return result.changes > 0;
}

export function getAllUserPrefs(db: DB): UserPrefs[] {
  const rows = db.prepare('SELECT * FROM user_prefs').all() as Record<string, unknown>[];
  return rows.map(rowToPrefs);
}

function rowToPrefs(row: Record<string, unknown>): UserPrefs {
  return {
    chatId: row.chat_id as number,
    priceFrom: row.price_from as number | null,
    priceTo: row.price_to as number | null,
    districts: row.districts == null ? null : JSON.parse(row.districts as string),
    roomsFrom: row.rooms_from as number | null,
    roomsTo: row.rooms_to as number | null,
    areaFrom: row.area_from as number | null,
    areaTo: row.area_to as number | null,
  };
}

export function getUserPrefs(db: DB, chatId: number): UserPrefs | null {
  const row = db.prepare('SELECT * FROM user_prefs WHERE chat_id = ?').get(chatId) as Record<string, unknown> | undefined;
  return row ? rowToPrefs(row) : null;
}

export function setUserPrefs(db: DB, prefs: UserPrefs): void {
  db.prepare(`
    INSERT INTO user_prefs (chat_id, price_from, price_to, districts, rooms_from, rooms_to, area_from, area_to, updated_at)
    VALUES (@chatId, @priceFrom, @priceTo, @districts, @roomsFrom, @roomsTo, @areaFrom, @areaTo, @updatedAt)
    ON CONFLICT(chat_id) DO UPDATE SET
      price_from = excluded.price_from, price_to = excluded.price_to, districts = excluded.districts,
      rooms_from = excluded.rooms_from, rooms_to = excluded.rooms_to,
      area_from = excluded.area_from, area_to = excluded.area_to, updated_at = excluded.updated_at
  `).run({
    chatId: prefs.chatId,
    priceFrom: prefs.priceFrom,
    priceTo: prefs.priceTo,
    districts: prefs.districts == null ? null : JSON.stringify(prefs.districts),
    roomsFrom: prefs.roomsFrom,
    roomsTo: prefs.roomsTo,
    areaFrom: prefs.areaFrom,
    areaTo: prefs.areaTo,
    updatedAt: new Date().toISOString(),
  });
}

/** In-progress onboarding wizard answers for a chat, or null if not mid-onboarding. Persisted so a process restart doesn't silently drop progress. */
export function getOnboardingState(db: DB, chatId: number): string[] | null {
  const row = db.prepare('SELECT answers FROM onboarding_state WHERE chat_id = ?').get(chatId) as { answers: string } | undefined;
  return row ? JSON.parse(row.answers) : null;
}

export function setOnboardingState(db: DB, chatId: number, answers: string[]): void {
  db.prepare(`
    INSERT INTO onboarding_state (chat_id, answers, updated_at) VALUES (@chatId, @answers, @updatedAt)
    ON CONFLICT(chat_id) DO UPDATE SET answers = excluded.answers, updated_at = excluded.updated_at
  `).run({ chatId, answers: JSON.stringify(answers), updatedAt: new Date().toISOString() });
}

export function deleteOnboardingState(db: DB, chatId: number): void {
  db.prepare('DELETE FROM onboarding_state WHERE chat_id = ?').run(chatId);
}

export function recordSwipe(db: DB, chatId: number, listingId: string, direction: 'like' | 'pass'): void {
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO swipes (chat_id, listing_id, direction, swiped_at) VALUES (?, ?, ?, ?)')
    .run(chatId, listingId, direction, now);
  if (direction === 'like') {
    db.prepare('INSERT OR IGNORE INTO shortlist (chat_id, listing_id, saved_at) VALUES (?, ?, ?)')
      .run(chatId, listingId, now);
  }
}

export function getShortlist(db: DB, chatId: number): ListingRow[] {
  const rows = db.prepare(`
    SELECT l.* FROM shortlist s JOIN listings l ON l.id = s.listing_id
    WHERE s.chat_id = ? ORDER BY s.saved_at DESC
  `).all(chatId) as Record<string, unknown>[];
  return rows.map(rowToListing);
}

export function getCandidateListings(db: DB, chatId: number, prefs: UserPrefs): ListingRow[] {
  const clauses: string[] = ['l.id NOT IN (SELECT listing_id FROM swipes WHERE chat_id = @chatId)'];
  const params: Record<string, unknown> = { chatId };

  if (prefs.priceFrom != null) { clauses.push('(l.price IS NULL OR l.price >= @priceFrom)'); params.priceFrom = prefs.priceFrom; }
  if (prefs.priceTo != null) { clauses.push('(l.price IS NULL OR l.price <= @priceTo)'); params.priceTo = prefs.priceTo; }
  if (prefs.areaFrom != null) { clauses.push('(l.area IS NULL OR l.area >= @areaFrom)'); params.areaFrom = prefs.areaFrom; }
  if (prefs.areaTo != null) { clauses.push('(l.area IS NULL OR l.area <= @areaTo)'); params.areaTo = prefs.areaTo; }
  if (prefs.roomsFrom != null) { clauses.push('(l.rooms IS NULL OR l.rooms >= @roomsFrom)'); params.roomsFrom = prefs.roomsFrom; }
  if (prefs.roomsTo != null) { clauses.push('(l.rooms IS NULL OR l.rooms <= @roomsTo)'); params.roomsTo = prefs.roomsTo; }
  if (prefs.districts != null && prefs.districts.length > 0) {
    const placeholders = prefs.districts.map((_, i) => `@district${i}`).join(', ');
    clauses.push(`l.district IN (${placeholders})`);
    prefs.districts.forEach((d, i) => { params[`district${i}`] = d; });
  }

  const rows = db.prepare(`SELECT l.* FROM listings l WHERE ${clauses.join(' AND ')}`).all(params) as Record<string, unknown>[];
  return rows.map(rowToListing);
}

export function getSwipedWithDirection(db: DB, chatId: number): { listing: ListingRow; direction: 'like' | 'pass' }[] {
  const rows = db.prepare(`
    SELECT l.*, s.direction as swipe_direction FROM swipes s JOIN listings l ON l.id = s.listing_id
    WHERE s.chat_id = ?
  `).all(chatId) as Record<string, unknown>[];
  return rows.map((row) => ({ listing: rowToListing(row), direction: row.swipe_direction as 'like' | 'pass' }));
}
