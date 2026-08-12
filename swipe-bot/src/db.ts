import Database from 'better-sqlite3';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';

export type DB = Database.Database;

/** Fixed chatId used by the MCP server's stateless tool calls — never a real Telegram chat, so pushes must skip it. */
export const MCP_CHAT_ID = 0;

export interface UserPrefs {
  chatId: number;
  priceFrom: number | null;
  priceTo: number | null;
  districts: number[] | null;
  roomsFrom: number | null;
  roomsTo: number | null;
  areaFrom: number | null;
  areaTo: number | null;
  /** False excludes listings that require a waitlist/registration (Gemeindewohnung etc.) — not everyone is eligible for those. */
  includeWaitlistHousing: boolean;
  /** Free-text label for the geocoded commute destination (e.g. "TU Wien"), or null if none set. */
  commuteDestination: string | null;
  commuteLat: number | null;
  commuteLon: number | null;
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
  /** Municipal/non-profit housing requiring a Vormerkschein, Wohnticket, or Wiener Wohnen registration — not open to everyone. */
  requiresWaitlistTicket: boolean;
  lat: number | null;
  lon: number | null;
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
  first_seen TEXT NOT NULL,
  requires_waitlist_ticket INTEGER NOT NULL DEFAULT 0,
  lat REAL, lon REAL
);

CREATE TABLE IF NOT EXISTS user_prefs (
  chat_id INTEGER PRIMARY KEY,
  price_from REAL, price_to REAL,
  districts TEXT,
  rooms_from REAL, rooms_to REAL,
  area_from REAL, area_to REAL,
  include_waitlist_housing INTEGER NOT NULL DEFAULT 1,
  commute_destination TEXT, commute_lat REAL, commute_lon REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commute_cache (
  chat_id INTEGER NOT NULL,
  listing_id TEXT NOT NULL,
  walk_minutes INTEGER,
  transit_minutes INTEGER,
  transit_summary TEXT,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, listing_id)
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
  const listingColumns = (db.prepare('PRAGMA table_info(listings)').all() as { name: string }[]).map((c) => c.name);
  if (!listingColumns.includes('description')) {
    db.exec('ALTER TABLE listings ADD COLUMN description TEXT');
  }
  if (!listingColumns.includes('requires_waitlist_ticket')) {
    db.exec('ALTER TABLE listings ADD COLUMN requires_waitlist_ticket INTEGER NOT NULL DEFAULT 0');
  }
  if (!listingColumns.includes('lat')) {
    db.exec('ALTER TABLE listings ADD COLUMN lat REAL');
    db.exec('ALTER TABLE listings ADD COLUMN lon REAL');
  }

  const prefsColumns = (db.prepare('PRAGMA table_info(user_prefs)').all() as { name: string }[]).map((c) => c.name);
  if (!prefsColumns.includes('include_waitlist_housing')) {
    // Default existing users to true (include) — matches pre-migration behavior of showing everything.
    db.exec('ALTER TABLE user_prefs ADD COLUMN include_waitlist_housing INTEGER NOT NULL DEFAULT 1');
  }
  if (!prefsColumns.includes('commute_destination')) {
    db.exec('ALTER TABLE user_prefs ADD COLUMN commute_destination TEXT');
    db.exec('ALTER TABLE user_prefs ADD COLUMN commute_lat REAL');
    db.exec('ALTER TABLE user_prefs ADD COLUMN commute_lon REAL');
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
    requiresWaitlistTicket: Boolean(row.requires_waitlist_ticket),
    lat: row.lat as number | null,
    lon: row.lon as number | null,
  };
}

/**
 * Returns true if this listing was newly inserted, false if it already existed (never overwritten)
 * or was a short-term/nightly rental (apt-hunter's detectShortTerm) — this bot is for long-term
 * leases only, so those are dropped at the source instead of filtered downstream in three places.
 */
export function upsertListing(db: DB, l: NormalizedListing): boolean {
  if (l.isShortTerm) return false;
  const result = db.prepare(`
    INSERT OR IGNORE INTO listings (id, source, title, price, price_per_sqm, area, rooms, district, is_private, images, description, url, value_flag, first_seen, requires_waitlist_ticket, lat, lon)
    VALUES (@id, @source, @title, @price, @pricePerSqm, @area, @rooms, @district, @isPrivate, @images, @description, @url, @valueFlag, @firstSeen, @requiresWaitlistTicket, @lat, @lon)
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
    requiresWaitlistTicket: l.requiresWaitlistTicket ? 1 : 0,
    lat: l.lat,
    lon: l.lon,
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
    includeWaitlistHousing: Boolean(row.include_waitlist_housing),
    commuteDestination: row.commute_destination as string | null,
    commuteLat: row.commute_lat as number | null,
    commuteLon: row.commute_lon as number | null,
  };
}

export function getUserPrefs(db: DB, chatId: number): UserPrefs | null {
  const row = db.prepare('SELECT * FROM user_prefs WHERE chat_id = ?').get(chatId) as Record<string, unknown> | undefined;
  return row ? rowToPrefs(row) : null;
}

export function setUserPrefs(db: DB, prefs: UserPrefs): void {
  db.prepare(`
    INSERT INTO user_prefs (chat_id, price_from, price_to, districts, rooms_from, rooms_to, area_from, area_to, include_waitlist_housing, commute_destination, commute_lat, commute_lon, updated_at)
    VALUES (@chatId, @priceFrom, @priceTo, @districts, @roomsFrom, @roomsTo, @areaFrom, @areaTo, @includeWaitlistHousing, @commuteDestination, @commuteLat, @commuteLon, @updatedAt)
    ON CONFLICT(chat_id) DO UPDATE SET
      price_from = excluded.price_from, price_to = excluded.price_to, districts = excluded.districts,
      rooms_from = excluded.rooms_from, rooms_to = excluded.rooms_to,
      area_from = excluded.area_from, area_to = excluded.area_to,
      include_waitlist_housing = excluded.include_waitlist_housing,
      commute_destination = excluded.commute_destination, commute_lat = excluded.commute_lat, commute_lon = excluded.commute_lon,
      updated_at = excluded.updated_at
  `).run({
    chatId: prefs.chatId,
    priceFrom: prefs.priceFrom,
    priceTo: prefs.priceTo,
    districts: prefs.districts == null ? null : JSON.stringify(prefs.districts),
    roomsFrom: prefs.roomsFrom,
    roomsTo: prefs.roomsTo,
    areaFrom: prefs.areaFrom,
    areaTo: prefs.areaTo,
    includeWaitlistHousing: prefs.includeWaitlistHousing ? 1 : 0,
    commuteDestination: prefs.commuteDestination,
    commuteLat: prefs.commuteLat,
    commuteLon: prefs.commuteLon,
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
  if (!prefs.includeWaitlistHousing) {
    clauses.push('l.requires_waitlist_ticket = 0');
  }

  const rows = db.prepare(`SELECT l.* FROM listings l WHERE ${clauses.join(' AND ')}`).all(params) as Record<string, unknown>[];
  return rows.map(rowToListing);
}

export function getListingsByIds(db: DB, ids: string[]): ListingRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `@id${i}`).join(', ');
  const params: Record<string, unknown> = {};
  ids.forEach((id, i) => { params[`id${i}`] = id; });
  const rows = db.prepare(`SELECT * FROM listings WHERE id IN (${placeholders})`).all(params) as Record<string, unknown>[];
  return rows.map(rowToListing);
}

/** Pure equivalent of getCandidateListings's WHERE clause, for filtering an in-memory batch (e.g. a poll's fresh inserts) without a query per listing. Mirrors its null-handling exactly: a null listing field always passes price/area/rooms bounds, but a null district fails a district restriction. */
export function matchesPrefs(l: ListingRow, prefs: UserPrefs): boolean {
  if (prefs.priceFrom != null && l.price != null && l.price < prefs.priceFrom) return false;
  if (prefs.priceTo != null && l.price != null && l.price > prefs.priceTo) return false;
  if (prefs.areaFrom != null && l.area != null && l.area < prefs.areaFrom) return false;
  if (prefs.areaTo != null && l.area != null && l.area > prefs.areaTo) return false;
  if (prefs.roomsFrom != null && l.rooms != null && l.rooms < prefs.roomsFrom) return false;
  if (prefs.roomsTo != null && l.rooms != null && l.rooms > prefs.roomsTo) return false;
  if (prefs.districts != null && prefs.districts.length > 0) {
    if (l.district == null || !prefs.districts.includes(l.district)) return false;
  }
  if (!prefs.includeWaitlistHousing && l.requiresWaitlistTicket) return false;
  return true;
}

export interface CommuteTimes {
  walkMinutes: number | null;
  transitMinutes: number | null;
  transitSummary: string | null;
}

/** Cached commute times for a (chat, listing) pair — Routes API calls cost quota, so each pair is computed once and reused across /next, pushes, and repeat views. */
export function getCommuteTimes(db: DB, chatId: number, listingId: string): CommuteTimes | null {
  const row = db.prepare('SELECT walk_minutes, transit_minutes, transit_summary FROM commute_cache WHERE chat_id = ? AND listing_id = ?')
    .get(chatId, listingId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    walkMinutes: row.walk_minutes as number | null,
    transitMinutes: row.transit_minutes as number | null,
    transitSummary: row.transit_summary as string | null,
  };
}

export function setCommuteTimes(db: DB, chatId: number, listingId: string, times: CommuteTimes): void {
  db.prepare(`
    INSERT INTO commute_cache (chat_id, listing_id, walk_minutes, transit_minutes, transit_summary, computed_at)
    VALUES (@chatId, @listingId, @walkMinutes, @transitMinutes, @transitSummary, @computedAt)
    ON CONFLICT(chat_id, listing_id) DO UPDATE SET
      walk_minutes = excluded.walk_minutes, transit_minutes = excluded.transit_minutes,
      transit_summary = excluded.transit_summary, computed_at = excluded.computed_at
  `).run({
    chatId, listingId,
    walkMinutes: times.walkMinutes, transitMinutes: times.transitMinutes, transitSummary: times.transitSummary,
    computedAt: new Date().toISOString(),
  });
}

export function getSwipedWithDirection(db: DB, chatId: number): { listing: ListingRow; direction: 'like' | 'pass' }[] {
  const rows = db.prepare(`
    SELECT l.*, s.direction as swipe_direction FROM swipes s JOIN listings l ON l.id = s.listing_id
    WHERE s.chat_id = ?
  `).all(chatId) as Record<string, unknown>[];
  return rows.map((row) => ({ listing: rowToListing(row), direction: row.swipe_direction as 'like' | 'pass' }));
}
