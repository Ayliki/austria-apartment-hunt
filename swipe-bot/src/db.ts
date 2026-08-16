import Database from 'better-sqlite3';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';
import { detectWG, detectWaitlistTicket } from 'apt-hunter/dist/normalize.js';

export type DB = Database.Database;

/** Fixed chatId used by the MCP server's stateless tool calls — never a real Telegram chat, so pushes must skip it. */
export const MCP_CHAT_ID = 0;

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
  /** A room in a shared flat, co-living, or student housing (apt-hunter's detectWG) — not a whole apartment. */
  isWg: boolean;
  addressLine: string | null;
  lat: number | null;
  lon: number | null;
  /** True once a refresh sweep gets a "not found" response for this listing — see refresh.ts. Rows shortlisted by someone are kept flagged rather than deleted. */
  isDelisted: boolean;
  /** Structured amenity data — only ever populated from immoscout's detail fetch; willhaben has no equivalent fields. Mirrors apt-hunter's NormalizedListing. */
  lift: boolean | null;
  parkingSpaces: number | null;
  floor: string | null;
  energyClass: string | null;
  availableFrom: string | null;
  /** Best-effort keyword match on title+description — never a reliable filter, only a badge. */
  mentionsPets: boolean;
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
  is_wg INTEGER NOT NULL DEFAULT 0,
  address_line TEXT,
  lat REAL, lon REAL,
  is_delisted INTEGER NOT NULL DEFAULT 0,
  lift INTEGER, parking_spaces INTEGER, floor TEXT, energy_class TEXT, available_from TEXT,
  mentions_pets INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS search_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  prefs_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_profiles_chat_id ON search_profiles(chat_id);

CREATE TABLE IF NOT EXISTS chats (
  chat_id INTEGER PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'en'
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
  if (!listingColumns.includes('is_wg')) {
    db.exec('ALTER TABLE listings ADD COLUMN is_wg INTEGER NOT NULL DEFAULT 0');
    // Backfill from titles already in the DB — otherwise WG listings stored before this
    // migration would never get flagged (they're only re-checked on insert, not on read).
    const rows = db.prepare('SELECT id, title FROM listings').all() as { id: string; title: string }[];
    const update = db.prepare('UPDATE listings SET is_wg = ? WHERE id = ?');
    const backfill = db.transaction((rows: { id: string; title: string }[]) => {
      for (const r of rows) update.run(detectWG(r.title) ? 1 : 0, r.id);
    });
    backfill(rows);
  }
  if (!listingColumns.includes('address_line')) {
    db.exec('ALTER TABLE listings ADD COLUMN address_line TEXT');
  }
  if (!listingColumns.includes('is_delisted')) {
    db.exec('ALTER TABLE listings ADD COLUMN is_delisted INTEGER NOT NULL DEFAULT 0');
  }
  if (!listingColumns.includes('lift')) {
    db.exec('ALTER TABLE listings ADD COLUMN lift INTEGER');
    db.exec('ALTER TABLE listings ADD COLUMN parking_spaces INTEGER');
    db.exec('ALTER TABLE listings ADD COLUMN floor TEXT');
    db.exec('ALTER TABLE listings ADD COLUMN energy_class TEXT');
    db.exec('ALTER TABLE listings ADD COLUMN available_from TEXT');
    db.exec('ALTER TABLE listings ADD COLUMN mentions_pets INTEGER NOT NULL DEFAULT 0');
  }
  repairMissedWaitlistFlags(db);

  const shortlistColumns = (db.prepare('PRAGMA table_info(shortlist)').all() as { name: string }[]).map((c) => c.name);
  if (!shortlistColumns.includes('profile_id')) {
    db.exec('ALTER TABLE shortlist ADD COLUMN profile_id INTEGER');
  }

  // user_prefs no longer exists on fresh installs (SCHEMA never creates it) — these column-backfill
  // steps only matter for a genuinely old DB file still carrying the table, and only long enough for
  // migrateUserPrefsToSearchProfiles below to read every row with every field present before dropping it.
  const hasUserPrefs = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_prefs'`).get();
  if (hasUserPrefs) {
    const prefsColumns = (db.prepare('PRAGMA table_info(user_prefs)').all() as { name: string }[]).map((c) => c.name);
    if (!prefsColumns.includes('include_waitlist_housing')) {
      // Default existing users to true (include) — matches pre-migration behavior of showing everything.
      db.exec('ALTER TABLE user_prefs ADD COLUMN include_waitlist_housing INTEGER NOT NULL DEFAULT 1');
    }
    if (!prefsColumns.includes('include_wg')) {
      // Default existing users to false (hide) — unlike waitlist housing, hiding WGs is the point of this feature.
      db.exec('ALTER TABLE user_prefs ADD COLUMN include_wg INTEGER NOT NULL DEFAULT 0');
    }
    if (!prefsColumns.includes('commute_destination')) {
      db.exec('ALTER TABLE user_prefs ADD COLUMN commute_destination TEXT');
      db.exec('ALTER TABLE user_prefs ADD COLUMN commute_lat REAL');
      db.exec('ALTER TABLE user_prefs ADD COLUMN commute_lon REAL');
    }
  }

  migrateUserPrefsToSearchProfiles(db);
}

/**
 * One-time migration: every pre-upgrade user_prefs row becomes one active search_profiles row
 * named "My Search", carrying its exact prior filter values (new requireElevator/requireParking
 * fields default to false, since no prior data existed for them). user_prefs is dropped once every
 * row has been migrated so this function is a no-op (and the table absent) on every later startup.
 */
function migrateUserPrefsToSearchProfiles(db: DB): void {
  const hasUserPrefs = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_prefs'`).get();
  if (!hasUserPrefs) return;

  const rows = db.prepare('SELECT * FROM user_prefs').all() as Record<string, unknown>[];
  const migrateRows = db.transaction((rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const chatId = row.chat_id as number;
      if (getActiveSearchProfile(db, chatId)) continue; // already migrated in a prior partial run
      const prefsForChat = rowToPrefs(row);
      createSearchProfile(db, chatId, 'My Search', {
        priceFrom: prefsForChat.priceFrom, priceTo: prefsForChat.priceTo, districts: prefsForChat.districts,
        roomsFrom: prefsForChat.roomsFrom, roomsTo: prefsForChat.roomsTo, areaFrom: prefsForChat.areaFrom, areaTo: prefsForChat.areaTo,
        includeWaitlistHousing: prefsForChat.includeWaitlistHousing, includeWg: prefsForChat.includeWg,
        requireElevator: false, requireParking: false,
        commuteDestination: prefsForChat.commuteDestination, commuteLat: prefsForChat.commuteLat, commuteLon: prefsForChat.commuteLon,
      });
      db.prepare('INSERT OR IGNORE INTO chats (chat_id, language) VALUES (?, ?)').run(chatId, 'en');
    }
    db.exec('DROP TABLE user_prefs');
  });
  migrateRows(rows);
}

/**
 * Self-heals rows whose requires_waitlist_ticket was missed at insert time — upsertListing never
 * re-checks an already-stored row, so a title that clearly needs a waitlist ticket but was stored
 * as requires_waitlist_ticket=0 (e.g. a batch inserted before the detector was correctly wired up)
 * would otherwise stay wrong forever. Runs on every startup, not gated behind a schema check: it's
 * a cheap no-op UPDATE...WHERE when nothing is mismatched, and re-running it is exactly what makes
 * it self-healing against any future detector improvement too. Only ever flips 0 -> 1, never the
 * reverse, so it can't accidentally hide a listing someone already sees as fine.
 */
function repairMissedWaitlistFlags(db: DB): void {
  const rows = db.prepare('SELECT id, title FROM listings WHERE requires_waitlist_ticket = 0').all() as { id: string; title: string }[];
  const mismatched = rows.filter((r) => detectWaitlistTicket(r.title));
  if (mismatched.length === 0) return;
  const update = db.prepare('UPDATE listings SET requires_waitlist_ticket = 1 WHERE id = ?');
  const repair = db.transaction((rows: { id: string }[]) => {
    for (const r of rows) update.run(r.id);
  });
  repair(mismatched);
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
    isWg: Boolean(row.is_wg),
    addressLine: row.address_line as string | null,
    lat: row.lat as number | null,
    lon: row.lon as number | null,
    isDelisted: Boolean(row.is_delisted),
    lift: row.lift == null ? null : Boolean(row.lift),
    parkingSpaces: row.parking_spaces as number | null,
    floor: row.floor as string | null,
    energyClass: row.energy_class as string | null,
    availableFrom: row.available_from as string | null,
    mentionsPets: Boolean(row.mentions_pets),
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
    INSERT OR IGNORE INTO listings (id, source, title, price, price_per_sqm, area, rooms, district, is_private, images, description, url, value_flag, first_seen, requires_waitlist_ticket, is_wg, address_line, lat, lon, lift, parking_spaces, floor, energy_class, available_from, mentions_pets)
    VALUES (@id, @source, @title, @price, @pricePerSqm, @area, @rooms, @district, @isPrivate, @images, @description, @url, @valueFlag, @firstSeen, @requiresWaitlistTicket, @isWg, @addressLine, @lat, @lon, @lift, @parkingSpaces, @floor, @energyClass, @availableFrom, @mentionsPets)
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
    isWg: l.isWg ? 1 : 0,
    lift: l.lift == null ? null : (l.lift ? 1 : 0),
    parkingSpaces: l.parkingSpaces,
    floor: l.floor,
    energyClass: l.energyClass,
    availableFrom: l.availableFrom,
    mentionsPets: l.mentionsPets ? 1 : 0,
    addressLine: l.addressLine,
    lat: l.lat,
    lon: l.lon,
  });
  return result.changes > 0;
}

/** Persists coordinates resolved for a listing after the fact (e.g. by geocoding its address, since not every advertiser publishes lat/lon) — so the geocode call happens once per listing, ever, not once per view. */
export function setListingCoords(db: DB, listingId: string, lat: number, lon: number): void {
  db.prepare('UPDATE listings SET lat = ?, lon = ? WHERE id = ?').run(lat, lon, listingId);
}

/** All stored rows for one source, oldest first_seen first — the order refreshAllListings sweeps them in. */
export function getListingsBySource(db: DB, source: 'willhaben' | 'immoscout'): ListingRow[] {
  const rows = db.prepare('SELECT * FROM listings WHERE source = ? ORDER BY first_seen ASC').all(source) as Record<string, unknown>[];
  return rows.map(rowToListing);
}

/**
 * Applies a successful refresh fetch's result onto a stored row. Never regresses already-known-good
 * data: an empty images array or a null addressLine/lat/lon from the fresh fetch keeps whatever was
 * already stored, since a partial or empty response is more likely a parsing gap than the truth.
 * Always clears is_delisted — a successful fetch means the listing is live again (or was never
 * actually gone, e.g. a past transient error had been misclassified).
 */
export function applyListingRefresh(
  db: DB, id: string, data: { images: string[]; addressLine: string | null; lat: number | null; lon: number | null },
): void {
  const current = db.prepare('SELECT images, address_line, lat, lon FROM listings WHERE id = ?').get(id) as
    { images: string; address_line: string | null; lat: number | null; lon: number | null } | undefined;
  if (!current) return;
  const images = data.images.length > 0 ? data.images : (JSON.parse(current.images) as string[]);
  const addressLine = data.addressLine ?? current.address_line;
  const lat = data.lat ?? current.lat;
  const lon = data.lon ?? current.lon;
  db.prepare('UPDATE listings SET images = ?, address_line = ?, lat = ?, lon = ?, is_delisted = 0 WHERE id = ?')
    .run(JSON.stringify(images), addressLine, lat, lon, id);
}

/** Flags (or un-flags) a listing as taken off its source site. See deleteDelistedUnshortlisted for what happens next. */
export function setListingDelisted(db: DB, id: string, delisted: boolean): void {
  db.prepare('UPDATE listings SET is_delisted = ? WHERE id = ?').run(delisted ? 1 : 0, id);
}

/**
 * Hard-deletes every listing flagged is_delisted that nobody has shortlisted, plus its swipes and
 * commute_cache rows (no FKs on this schema, so these are explicit). A delisted listing that IS in
 * someone's shortlist is left alone — deleting it would make the card vanish from /shortlist without
 * a trace, and the person may already be in contact with the landlord. Returns how many were deleted.
 */
export function deleteDelistedUnshortlisted(db: DB): number {
  const rows = db.prepare(`
    SELECT id FROM listings WHERE is_delisted = 1 AND id NOT IN (SELECT listing_id FROM shortlist)
  `).all() as { id: string }[];
  if (rows.length === 0) return 0;
  const del = db.transaction((ids: string[]) => {
    for (const id of ids) {
      db.prepare('DELETE FROM swipes WHERE listing_id = ?').run(id);
      db.prepare('DELETE FROM commute_cache WHERE listing_id = ?').run(id);
      db.prepare('DELETE FROM listings WHERE id = ?').run(id);
    }
  });
  del(rows.map((r) => r.id));
  return rows.length;
}

/** Shape of a legacy user_prefs row (pre-search-profiles) — only used by migrateUserPrefsToSearchProfiles, which is the only remaining reader of that table. */
function rowToPrefs(row: Record<string, unknown>): {
  chatId: number;
  priceFrom: number | null;
  priceTo: number | null;
  districts: number[] | null;
  roomsFrom: number | null;
  roomsTo: number | null;
  areaFrom: number | null;
  areaTo: number | null;
  includeWaitlistHousing: boolean;
  includeWg: boolean;
  commuteDestination: string | null;
  commuteLat: number | null;
  commuteLon: number | null;
} {
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
    includeWg: Boolean(row.include_wg),
    commuteDestination: row.commute_destination as string | null,
    commuteLat: row.commute_lat as number | null,
    commuteLon: row.commute_lon as number | null,
  };
}

export interface SearchProfilePrefs {
  priceFrom: number | null;
  priceTo: number | null;
  districts: number[] | null;
  roomsFrom: number | null;
  roomsTo: number | null;
  areaFrom: number | null;
  areaTo: number | null;
  /** False excludes listings that require a waitlist/registration (Gemeindewohnung etc.) — not everyone is eligible for those. */
  includeWaitlistHousing: boolean;
  /** False (the default) excludes WG-Zimmer, co-living, and student-room listings (apt-hunter's detectWG). */
  includeWg: boolean;
  requireElevator: boolean;
  requireParking: boolean;
  /** Free-text label for the geocoded commute destination (e.g. "TU Wien"), or null if none set. */
  commuteDestination: string | null;
  commuteLat: number | null;
  commuteLon: number | null;
}

export interface SearchProfile {
  id: number;
  chatId: number;
  name: string;
  active: boolean;
  createdAt: string;
  prefs: SearchProfilePrefs;
}

/** A chat may keep this many saved searches at once — the wizard/menus enforce the cap by calling countSearchProfiles before offering "add another search". */
export const MAX_SEARCH_PROFILES_PER_CHAT = 5;

function rowToSearchProfile(row: Record<string, unknown>): SearchProfile {
  return {
    id: row.id as number,
    chatId: row.chat_id as number,
    name: row.name as string,
    active: Boolean(row.active),
    createdAt: row.created_at as string,
    prefs: JSON.parse(row.prefs_json as string) as SearchProfilePrefs,
  };
}

/** Inserts a new search profile. By default it becomes the chat's one active profile (every other profile for that chat is deactivated first) — pass makeActive=false to add an inactive profile instead. */
export function createSearchProfile(db: DB, chatId: number, name: string, prefs: SearchProfilePrefs, makeActive = true): SearchProfile {
  if (makeActive) db.prepare('UPDATE search_profiles SET active = 0 WHERE chat_id = ?').run(chatId);
  const now = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO search_profiles (chat_id, name, prefs_json, active, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, name, JSON.stringify(prefs), makeActive ? 1 : 0, now);
  return { id: result.lastInsertRowid as number, chatId, name, active: makeActive, createdAt: now, prefs };
}

export function getSearchProfiles(db: DB, chatId: number): SearchProfile[] {
  const rows = db.prepare('SELECT * FROM search_profiles WHERE chat_id = ? ORDER BY created_at ASC').all(chatId) as Record<string, unknown>[];
  return rows.map(rowToSearchProfile);
}

export function getSearchProfile(db: DB, profileId: number): SearchProfile | null {
  const row = db.prepare('SELECT * FROM search_profiles WHERE id = ?').get(profileId) as Record<string, unknown> | undefined;
  return row ? rowToSearchProfile(row) : null;
}

export function getActiveSearchProfile(db: DB, chatId: number): SearchProfile | null {
  const row = db.prepare('SELECT * FROM search_profiles WHERE chat_id = ? AND active = 1').get(chatId) as Record<string, unknown> | undefined;
  return row ? rowToSearchProfile(row) : null;
}

/** Deactivates every other profile for the chat before activating this one, so a chat never has more than one active profile at a time. */
export function setActiveSearchProfile(db: DB, chatId: number, profileId: number): void {
  const setActive = db.transaction(() => {
    db.prepare('UPDATE search_profiles SET active = 0 WHERE chat_id = ?').run(chatId);
    db.prepare('UPDATE search_profiles SET active = 1 WHERE id = ? AND chat_id = ?').run(profileId, chatId);
  });
  setActive();
}

export function updateSearchProfile(db: DB, profileId: number, prefs: SearchProfilePrefs): void {
  db.prepare('UPDATE search_profiles SET prefs_json = ? WHERE id = ?').run(JSON.stringify(prefs), profileId);
}

export function renameSearchProfile(db: DB, profileId: number, name: string): void {
  db.prepare('UPDATE search_profiles SET name = ? WHERE id = ?').run(name, profileId);
}

/** If the deleted profile was active, no profile is active afterward — the caller (bot.ts) prompts the user to pick a new one if any remain. */
export function deleteSearchProfile(db: DB, profileId: number): void {
  db.prepare('DELETE FROM search_profiles WHERE id = ?').run(profileId);
}

export function countSearchProfiles(db: DB, chatId: number): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM search_profiles WHERE chat_id = ?').get(chatId) as { n: number };
  return row.n;
}

/** Every search profile across every chat — used by the poller/notifier to sweep all active searches in one pass, replacing the old getAllUserPrefs. */
export function getAllSearchProfiles(db: DB): SearchProfile[] {
  const rows = db.prepare('SELECT * FROM search_profiles').all() as Record<string, unknown>[];
  return rows.map(rowToSearchProfile);
}

/** Used only by the MCP server, which has no wizard/multi-profile UI: creates the chat's one profile on first call, updates it on every later call. */
export function upsertActiveProfilePrefs(db: DB, chatId: number, prefs: SearchProfilePrefs, defaultName = 'My Search'): SearchProfile {
  const active = getActiveSearchProfile(db, chatId);
  if (active) {
    updateSearchProfile(db, active.id, prefs);
    return { ...active, prefs };
  }
  return createSearchProfile(db, chatId, defaultName, prefs);
}

export type ChatLanguage = 'en' | 'ru' | 'de';

export function getChatLanguage(db: DB, chatId: number): ChatLanguage {
  const row = db.prepare('SELECT language FROM chats WHERE chat_id = ?').get(chatId) as { language: ChatLanguage } | undefined;
  return row?.language ?? 'en';
}

export function setChatLanguage(db: DB, chatId: number, language: ChatLanguage): void {
  db.prepare(`
    INSERT INTO chats (chat_id, language) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET language = excluded.language
  `).run(chatId, language);
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

/**
 * Records a swipe. For a 'like', only adds it to the shortlist if the listing still exists in
 * `listings` — a listing can be deleted by the delisting-cleanup sweep between being sent to a user
 * and being swiped on, and getShortlist's INNER JOIN would otherwise make that shortlist row
 * permanently invisible with no error shown to the user. Returns false only for that one case (a
 * 'like' on a since-deleted listing, meaning nothing was saved); true otherwise, including every
 * 'pass'.
 */
export function recordSwipe(db: DB, chatId: number, listingId: string, direction: 'like' | 'pass'): boolean {
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO swipes (chat_id, listing_id, direction, swiped_at) VALUES (?, ?, ?, ?)')
    .run(chatId, listingId, direction, now);
  if (direction === 'pass') return true;
  const exists = db.prepare('SELECT 1 FROM listings WHERE id = ?').get(listingId);
  if (!exists) return false;
  db.prepare('INSERT OR IGNORE INTO shortlist (chat_id, listing_id, saved_at) VALUES (?, ?, ?)')
    .run(chatId, listingId, now);
  return true;
}

export interface LastSwipe {
  listingId: string;
  direction: 'like' | 'pass';
}

/** The most recent swipe recorded for a chat, or null if they haven't swiped yet. */
export function getLastSwipe(db: DB, chatId: number): LastSwipe | null {
  const row = db.prepare('SELECT listing_id, direction FROM swipes WHERE chat_id = ? ORDER BY swiped_at DESC, ROWID DESC LIMIT 1')
    .get(chatId) as { listing_id: string; direction: 'like' | 'pass' } | undefined;
  return row ? { listingId: row.listing_id, direction: row.direction } : null;
}

/**
 * Reverses a swipe — but ONLY if `listingId` is still that chat's most recent swipe (an Undo button
 * always targets one specific listing, but "undo" as a concept only ever means "undo the last one" —
 * this guards a stale button tap after several more swipes happened in between). Deletes the `swipes`
 * row (making the listing eligible for /next again) and, if it was a 'like', the `shortlist` row it
 * created. Returns false (no-op, nothing changed) if the check fails.
 */
export function undoSwipe(db: DB, chatId: number, listingId: string): boolean {
  const last = getLastSwipe(db, chatId);
  if (!last || last.listingId !== listingId) return false;
  db.prepare('DELETE FROM swipes WHERE chat_id = ? AND listing_id = ?').run(chatId, listingId);
  db.prepare('DELETE FROM shortlist WHERE chat_id = ? AND listing_id = ?').run(chatId, listingId);
  return true;
}

export function getShortlist(db: DB, chatId: number): ListingRow[] {
  // Tiebreak on s.rowid DESC (insertion order) since saved_at is millisecond-resolution ISO text —
  // two likes recorded within the same millisecond (routine when swiping fast, or under test) would
  // otherwise sort arbitrarily instead of consistently newest-liked-first.
  const rows = db.prepare(`
    SELECT l.* FROM shortlist s JOIN listings l ON l.id = s.listing_id
    WHERE s.chat_id = ? ORDER BY s.saved_at DESC, s.rowid DESC
  `).all(chatId) as Record<string, unknown>[];
  return rows.map(rowToListing);
}

/** Un-saves a listing from the shortlist only — the underlying swipe (direction 'like') is left intact, so the listing stays excluded from future /next candidates, matching how a pass already behaves. */
export function removeFromShortlist(db: DB, chatId: number, listingId: string): void {
  db.prepare('DELETE FROM shortlist WHERE chat_id = ? AND listing_id = ?').run(chatId, listingId);
}

export function getCandidateListings(db: DB, chatId: number, prefs: SearchProfilePrefs): ListingRow[] {
  const clauses: string[] = [
    'l.id NOT IN (SELECT listing_id FROM swipes WHERE chat_id = @chatId)',
    'l.is_delisted = 0',
  ];
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
  if (!prefs.includeWg) {
    clauses.push('l.is_wg = 0');
  }
  if (prefs.requireElevator) { clauses.push('l.lift = 1'); }
  if (prefs.requireParking) { clauses.push('l.parking_spaces > 0'); }

  const rows = db.prepare(`SELECT l.* FROM listings l WHERE ${clauses.join(' AND ')}`).all(params) as Record<string, unknown>[];
  return rows.map(rowToListing);
}

/** All known listing ids (e.g. 'willhaben:123'), for deciding what's genuinely new before an expensive enrichment call. */
export function getAllListingIds(db: DB): Set<string> {
  const rows = db.prepare('SELECT id FROM listings').all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
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
export function matchesPrefs(l: ListingRow, prefs: SearchProfilePrefs): boolean {
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
  if (!prefs.includeWg && l.isWg) return false;
  if (prefs.requireElevator && l.lift !== true) return false;
  if (prefs.requireParking && !(l.parkingSpaces != null && l.parkingSpaces > 0)) return false;
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
