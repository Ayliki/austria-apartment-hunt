import Database from 'better-sqlite3';
import type { NormalizedListing } from 'apt-hunter/dist/normalize.js';
import { detectWG, detectWaitlistTicket } from 'apt-hunter/dist/normalize.js';
import { WIZARD_STEPS, type WizardState } from './wizard.js';

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
  profile_id INTEGER NOT NULL,
  listing_id TEXT NOT NULL,
  walk_minutes INTEGER,
  transit_minutes INTEGER,
  transit_summary TEXT,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, listing_id)
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

CREATE TABLE IF NOT EXISTS notify_settings (
  profile_id         INTEGER PRIMARY KEY,
  paused             INTEGER NOT NULL DEFAULT 0,
  instant_enabled    INTEGER NOT NULL DEFAULT 1,
  instant_percentile REAL    NOT NULL DEFAULT 0.10,
  digest_hours       TEXT    NOT NULL DEFAULT '9,19',
  quiet_start        INTEGER NOT NULL DEFAULT 22,
  quiet_end          INTEGER NOT NULL DEFAULT 8,
  daily_cap          INTEGER NOT NULL DEFAULT 6,
  last_digest_at     TEXT
);

CREATE TABLE IF NOT EXISTS notify_log (
  profile_id INTEGER NOT NULL,
  listing_id TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  sent_at    TEXT    NOT NULL,
  PRIMARY KEY (profile_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_notify_log_profile_sent ON notify_log(profile_id, sent_at);

CREATE TABLE IF NOT EXISTS photo_cache (
  source_url  TEXT PRIMARY KEY,
  file_id     TEXT,
  cached_at   TEXT NOT NULL,
  failed      INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  -- ISO instant a failed url becomes eligible again. NULL means "no longer suppressed", so a row
  -- written before this column existed self-heals rather than staying blacklisted forever.
  retry_after TEXT
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

  const photoCacheColumns = (db.prepare('PRAGMA table_info(photo_cache)').all() as { name: string }[]).map((c) => c.name);
  if (!photoCacheColumns.includes('retry_after')) {
    // Left NULL on purpose: every url blacklisted by the old permanent-blacklist code gets one more
    // chance rather than being written off for good.
    db.exec('ALTER TABLE photo_cache ADD COLUMN retry_after TEXT');
  }

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
  migrateCommuteCacheToProfileId(db);
  migrateOnboardingState(db);
}

/**
 * Clears any `onboarding_state` row whose payload doesn't match the current `WizardState` shape —
 * a chat that was mid-onboarding when the button-wizard redesign shipped would otherwise get back a
 * malformed/old-shaped object (the old linear-text onboarding stored a `string[]` in this same
 * `answers` column) that doesn't satisfy `WIZARD_STEPS[state.stepIndex]` and friends, silently
 * bricking that chat's text input into "please tap a button" forever. Old in-progress onboarding
 * sessions aren't worth preserving across a schema change this size, so the row is just dropped
 * rather than migrated — the chat picks back up cleanly via /start. Runs on every startup (like
 * repairMissedWaitlistFlags above): a cheap no-op scan when every row is already valid, which is the
 * common case after the first run.
 */
function migrateOnboardingState(db: DB): void {
  const rows = db.prepare('SELECT chat_id, answers FROM onboarding_state').all() as { chat_id: number; answers: string }[];
  const invalidChatIds = rows.filter((r) => !isValidWizardStateJson(r.answers)).map((r) => r.chat_id);
  if (invalidChatIds.length === 0) return;
  const del = db.prepare('DELETE FROM onboarding_state WHERE chat_id = ?');
  const clear = db.transaction((chatIds: number[]) => {
    for (const chatId of chatIds) del.run(chatId);
  });
  clear(invalidChatIds);
}

/** Parses + shape-checks a raw `onboarding_state.answers` JSON string. Shared by migrateOnboardingState (bulk, at startup) and getWizardState (per-read, self-healing) so both use the exact same definition of "valid". */
function isValidWizardStateJson(json: string): boolean {
  try {
    return isValidWizardState(JSON.parse(json));
  } catch {
    return false; // not even valid JSON — definitely not a valid WizardState
  }
}

/** Structural guard for a parsed `onboarding_state.answers` payload — catches both genuinely malformed JSON and a value that parses fine but doesn't have WizardState's shape (e.g. the old linear-text onboarding's `string[]`, or a future/older version's shape mismatch). */
function isValidWizardState(x: unknown): x is WizardState {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.stepIndex === 'number' &&
    s.stepIndex >= 0 && s.stepIndex <= WIZARD_STEPS.length &&
    (s.profileName === null || typeof s.profileName === 'string') &&
    typeof s.partial === 'object' && s.partial !== null && !Array.isArray(s.partial) &&
    (s.editingProfileId === null || typeof s.editingProfileId === 'number') &&
    (s.awaitingCustomBudget === undefined || typeof s.awaitingCustomBudget === 'boolean')
  );
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
      const migrated = createSearchProfile(db, chatId, 'My Search', {
        priceFrom: prefsForChat.priceFrom, priceTo: prefsForChat.priceTo, districts: prefsForChat.districts,
        roomsFrom: prefsForChat.roomsFrom, roomsTo: prefsForChat.roomsTo, areaFrom: prefsForChat.areaFrom, areaTo: prefsForChat.areaTo,
        includeWaitlistHousing: prefsForChat.includeWaitlistHousing, includeWg: prefsForChat.includeWg,
        requireElevator: false, requireParking: false,
        commuteDestination: prefsForChat.commuteDestination, commuteLat: prefsForChat.commuteLat, commuteLon: prefsForChat.commuteLon,
      });
      // A migrated profile is NOT new: its user has been swiping this deck since before the quiet
      // notifier existed, so the backlog must stay old news. Null is exactly that signal, so undo
      // the creation stamp here and let the first digest run adopt the backlog silently.
      updateNotifySettings(db, migrated.id, { lastDigestAt: null });
      db.prepare('INSERT OR IGNORE INTO chats (chat_id, language) VALUES (?, ?)').run(chatId, 'en');
    }
    db.exec('DROP TABLE user_prefs');
  });
  migrateRows(rows);
}

/**
 * commute_cache used to be keyed by (chat_id, listing_id). Commute prefs now live per search
 * profile (see SearchProfilePrefs.commuteDestination), so a chat with more than one profile could
 * otherwise have profile B silently reuse profile A's cached ETA for the same listing. This must
 * run after migrateUserPrefsToSearchProfiles so every chat's active profile already exists.
 * SQLite can't ALTER a column into a new PRIMARY KEY, so the table is rebuilt: cached rows are
 * remapped onto each chat's current active profile (today there's exactly one profile per chat, so
 * this is lossless); a row whose chat has no profile is dropped — it's just a recomputable cache.
 */
function migrateCommuteCacheToProfileId(db: DB): void {
  const hasCommuteCache = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='commute_cache'`).get();
  if (!hasCommuteCache) return;
  const columns = (db.prepare('PRAGMA table_info(commute_cache)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('chat_id')) return; // already migrated (fresh installs get the new shape from SCHEMA directly)

  const rows = db.prepare('SELECT * FROM commute_cache').all() as Record<string, unknown>[];
  const migrateRows = db.transaction((rows: Record<string, unknown>[]) => {
    db.exec('ALTER TABLE commute_cache RENAME TO commute_cache_old');
    db.exec(`
      CREATE TABLE commute_cache (
        profile_id INTEGER NOT NULL,
        listing_id TEXT NOT NULL,
        walk_minutes INTEGER,
        transit_minutes INTEGER,
        transit_summary TEXT,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, listing_id)
      )
    `);
    const insert = db.prepare(`
      INSERT OR REPLACE INTO commute_cache (profile_id, listing_id, walk_minutes, transit_minutes, transit_summary, computed_at)
      VALUES (@profileId, @listingId, @walkMinutes, @transitMinutes, @transitSummary, @computedAt)
    `);
    for (const row of rows) {
      const profile = getActiveSearchProfile(db, row.chat_id as number);
      if (!profile) continue;
      insert.run({
        profileId: profile.id,
        listingId: row.listing_id,
        walkMinutes: row.walk_minutes,
        transitMinutes: row.transit_minutes,
        transitSummary: row.transit_summary,
        computedAt: row.computed_at,
      });
    }
    db.exec('DROP TABLE commute_cache_old');
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
/**
 * Returns true only when the flag actually changed. Callers need that to tell a NEW delisting from a
 * re-confirmation of one already known — the refresh sweep's blast-radius guard measures the former,
 * and counting the latter would let a standing backlog jam the guard on every sweep forever.
 */
export function setListingDelisted(db: DB, id: string, delisted: boolean): boolean {
  const info = db.prepare('UPDATE listings SET is_delisted = ? WHERE id = ? AND is_delisted != ?')
    .run(delisted ? 1 : 0, id, delisted ? 1 : 0);
  return info.changes > 0;
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
  // Note on prefs.priceTo: the wizard's top budget band (wizard.ts's BUDGET_BANDS) uses
  // priceTo: Infinity for "no upper bound". JSON.stringify(Infinity) serializes to `null`, so
  // JSON.parse here already hands back priceTo: null for that band with no extra handling needed
  // — and matchesPrefs/getCandidateListings already treat a null/undefined priceTo as unbounded,
  // so this round-trip is consistent with every other "no limit" prefs field, not a special case.
  return {
    id: row.id as number,
    chatId: row.chat_id as number,
    name: row.name as string,
    active: Boolean(row.active),
    createdAt: row.created_at as string,
    prefs: JSON.parse(row.prefs_json as string) as SearchProfilePrefs,
  };
}

/**
 * Inserts a new search profile. By default it becomes the chat's one active profile (every other
 * profile for that chat is deactivated first) — pass makeActive=false to add an inactive profile instead.
 *
 * The profile's notify_settings row is written straight away with `last_digest_at = created_at`.
 * The notifier reads a null `lastDigestAt` as "this profile pre-dates the quiet-notifier deploy, so
 * its whole deck is old news" and adopts that backlog silently; without this stamp a brand-new
 * profile would look identical, and everything matched on its first day would be swallowed by that
 * adopt run instead of appearing in the user's first digest. Stamping the creation time also makes
 * the first digest's "{count} new since your last update" true: it counts from when the search
 * actually existed. The one caller that deliberately wants the null (the pre-deploy migration)
 * clears it back afterwards.
 */
export function createSearchProfile(
  db: DB, chatId: number, name: string, prefs: SearchProfilePrefs, makeActive = true, at: Date = new Date(),
): SearchProfile {
  if (makeActive) db.prepare('UPDATE search_profiles SET active = 0 WHERE chat_id = ?').run(chatId);
  const now = at.toISOString();
  const result = db.prepare(
    'INSERT INTO search_profiles (chat_id, name, prefs_json, active, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, name, JSON.stringify(prefs), makeActive ? 1 : 0, now);
  const id = result.lastInsertRowid as number;
  updateNotifySettings(db, id, { lastDigestAt: now });
  return { id, chatId, name, active: makeActive, createdAt: now, prefs };
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

/** In-progress onboarding/edit wizard state for a chat, or null if not mid-wizard. Persisted so a process restart doesn't silently drop progress. Table/column names are unchanged from the old linear-text onboarding (`answers TEXT` already stores arbitrary JSON) — only the payload shape changed, from `string[]` to a `WizardState`. */
export function getWizardState(db: DB, chatId: number): WizardState | null {
  const row = db.prepare('SELECT answers FROM onboarding_state WHERE chat_id = ?').get(chatId) as { answers: string } | undefined;
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.answers);
  } catch {
    parsed = null; // genuinely corrupt (non-JSON) — falls through to the shape guard below, which rejects it
  }
  if (!isValidWizardState(parsed)) {
    // Malformed/old-shaped/corrupt row (see migrateOnboardingState's doc comment) that slipped past
    // the startup migration somehow — self-heal by clearing it and reporting "not mid-wizard" rather
    // than trusting the cast and letting a bad shape brick the chat's text input.
    deleteWizardState(db, chatId);
    return null;
  }
  return parsed;
}

export function setWizardState(db: DB, chatId: number, state: WizardState): void {
  db.prepare(`
    INSERT INTO onboarding_state (chat_id, answers, updated_at) VALUES (@chatId, @answers, @updatedAt)
    ON CONFLICT(chat_id) DO UPDATE SET answers = excluded.answers, updated_at = excluded.updated_at
  `).run({ chatId, answers: JSON.stringify(state), updatedAt: new Date().toISOString() });
}

export function deleteWizardState(db: DB, chatId: number): void {
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

/** One shortlist entry plus the moment it was saved — the extra column the CSV export needs and the browse UI does not. */
export interface ShortlistExportRow {
  listing: ListingRow;
  savedAt: string;
}

/**
 * Shortlist rows carrying saved_at, for CSV export. A sibling of getShortlist rather than a change
 * to it: every browse call site wants a bare ListingRow, and widening that return type would ripple
 * through all of them for one consumer's benefit. Ordering matches getShortlist exactly, including
 * the rowid tiebreak, so an export and the browse deck never disagree about what "first" means.
 */
export function getShortlistForExport(db: DB, chatId: number): ShortlistExportRow[] {
  const rows = db.prepare(`
    SELECT l.*, s.saved_at AS saved_at FROM shortlist s JOIN listings l ON l.id = s.listing_id
    WHERE s.chat_id = ? ORDER BY s.saved_at DESC, s.rowid DESC
  `).all(chatId) as Record<string, unknown>[];
  return rows.map((r) => ({ listing: rowToListing(r), savedAt: String(r.saved_at) }));
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

/** Single listing by id, or null if it doesn't exist. */
export function getListingById(db: DB, id: string): ListingRow | null {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToListing(row) : null;
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

/** Cached commute times for a (search profile, listing) pair — Routes API calls cost quota, so each pair is computed once and reused across /next, pushes, and repeat views. Keyed by profile, not chat, since commuteDestination lives in SearchProfilePrefs and a chat can hold multiple profiles with different destinations. */
export function getCommuteTimes(db: DB, profileId: number, listingId: string): CommuteTimes | null {
  const row = db.prepare('SELECT walk_minutes, transit_minutes, transit_summary FROM commute_cache WHERE profile_id = ? AND listing_id = ?')
    .get(profileId, listingId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    walkMinutes: row.walk_minutes as number | null,
    transitMinutes: row.transit_minutes as number | null,
    transitSummary: row.transit_summary as string | null,
  };
}

export function setCommuteTimes(db: DB, profileId: number, listingId: string, times: CommuteTimes): void {
  db.prepare(`
    INSERT INTO commute_cache (profile_id, listing_id, walk_minutes, transit_minutes, transit_summary, computed_at)
    VALUES (@profileId, @listingId, @walkMinutes, @transitMinutes, @transitSummary, @computedAt)
    ON CONFLICT(profile_id, listing_id) DO UPDATE SET
      walk_minutes = excluded.walk_minutes, transit_minutes = excluded.transit_minutes,
      transit_summary = excluded.transit_summary, computed_at = excluded.computed_at
  `).run({
    profileId, listingId,
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

export interface NotifySettings {
  profileId: number;
  paused: boolean;
  instantEnabled: boolean;
  instantPercentile: number;
  digestHours: number[];
  quietStart: number;
  quietEnd: number;
  dailyCap: number;
  lastDigestAt: string | null;
}

/** Spec defaults — mirrored in the notify_settings DDL so a row inserted by SQL alone matches a row this module synthesizes. */
export const DEFAULT_NOTIFY_SETTINGS: Omit<NotifySettings, 'profileId'> = {
  paused: false,
  instantEnabled: true,
  instantPercentile: 0.10,
  digestHours: [9, 19],
  quietStart: 22,
  quietEnd: 8,
  dailyCap: 6,
  lastDigestAt: null,
};

const parseDigestHours = (raw: string): number[] =>
  raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);

/** Never inserts — an unconfigured profile reads as the defaults, so existing users need no backfill. */
export function getNotifySettings(db: DB, profileId: number): NotifySettings {
  const row = db.prepare('SELECT * FROM notify_settings WHERE profile_id = ?').get(profileId) as
    | { paused: number; instant_enabled: number; instant_percentile: number; digest_hours: string; quiet_start: number; quiet_end: number; daily_cap: number; last_digest_at: string | null }
    | undefined;
  if (!row) return { profileId, ...DEFAULT_NOTIFY_SETTINGS };
  return {
    profileId,
    paused: row.paused === 1,
    instantEnabled: row.instant_enabled === 1,
    instantPercentile: row.instant_percentile,
    digestHours: parseDigestHours(row.digest_hours),
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    dailyCap: row.daily_cap,
    lastDigestAt: row.last_digest_at,
  };
}

export function updateNotifySettings(db: DB, profileId: number, patch: Partial<Omit<NotifySettings, 'profileId'>>): void {
  const current = getNotifySettings(db, profileId);
  const next = { ...current, ...patch };
  db.prepare(`
    INSERT INTO notify_settings (profile_id, paused, instant_enabled, instant_percentile, digest_hours, quiet_start, quiet_end, daily_cap, last_digest_at)
    VALUES (@profileId, @paused, @instantEnabled, @instantPercentile, @digestHours, @quietStart, @quietEnd, @dailyCap, @lastDigestAt)
    ON CONFLICT(profile_id) DO UPDATE SET
      paused = @paused, instant_enabled = @instantEnabled, instant_percentile = @instantPercentile,
      digest_hours = @digestHours, quiet_start = @quietStart, quiet_end = @quietEnd,
      daily_cap = @dailyCap, last_digest_at = @lastDigestAt
  `).run({
    profileId,
    paused: next.paused ? 1 : 0,
    instantEnabled: next.instantEnabled ? 1 : 0,
    instantPercentile: next.instantPercentile,
    digestHours: next.digestHours.join(','),
    quietStart: next.quietStart,
    quietEnd: next.quietEnd,
    dailyCap: next.dailyCap,
    lastDigestAt: next.lastDigestAt,
  });
}

/** INSERT OR IGNORE, so a listing announced instantly is never re-announced in a digest. */
export function recordNotified(db: DB, profileId: number, listingId: string, kind: 'instant' | 'digest', at: string): void {
  db.prepare('INSERT OR IGNORE INTO notify_log (profile_id, listing_id, kind, sent_at) VALUES (?, ?, ?, ?)')
    .run(profileId, listingId, kind, at);
}

export function countInstantSince(db: DB, profileId: number, sinceIso: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM notify_log WHERE profile_id = ? AND kind = 'instant' AND sent_at >= ?")
    .get(profileId, sinceIso) as { n: number };
  return row.n;
}

export function getNotifiedListingIds(db: DB, profileId: number): Set<string> {
  const rows = db.prepare('SELECT listing_id FROM notify_log WHERE profile_id = ?').all(profileId) as { listing_id: string }[];
  return new Set(rows.map((r) => r.listing_id));
}

/**
 * A failed url is suppressed for a while, not forever. photo_cache is keyed by url and shared by
 * every user, so a single Telegram 429 or origin hiccup used to downgrade one image to a text-only
 * card for everybody, permanently — the exact opposite of what this cache is for.
 */
export const PHOTO_TRANSIENT_COOLDOWN_MS = 60 * 60 * 1000;            // 1 hour  — 429s, timeouts, 5xx
export const PHOTO_PERMANENT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days — the url itself is bad

/** Telegram wordings that mean the URL is genuinely unusable rather than momentarily unreachable. */
const PERMANENT_PHOTO_ERRORS = ['wrong file identifier', 'failed to get http url content', 'webpage_curl_failed'];

export function isPermanentPhotoError(error: string): boolean {
  const message = error.toLowerCase();
  return PERMANENT_PHOTO_ERRORS.some((pattern) => message.includes(pattern));
}

/** True while a recorded failure is still within its cooldown. A NULL retry_after has already lapsed. */
function isSuppressed(row: { failed: number; retry_after: string | null } | undefined, now: Date): boolean {
  if (row == null || row.failed !== 1) return false;
  return row.retry_after != null && now.toISOString() < row.retry_after;
}

export function getCachedFileId(db: DB, sourceUrl: string, now: Date = new Date()): string | null {
  const row = db.prepare('SELECT file_id, failed, retry_after FROM photo_cache WHERE source_url = ?').get(sourceUrl) as
    { file_id: string | null; failed: number; retry_after: string | null } | undefined;
  // A transient failure must not throw away a file_id we already hold — reuse it once the cooldown lapses.
  if (isSuppressed(row, now)) return null;
  return row?.file_id ?? null;
}

export function recordFileId(db: DB, sourceUrl: string, fileId: string, at: string): void {
  db.prepare(`
    INSERT INTO photo_cache (source_url, file_id, cached_at, failed, last_error, retry_after) VALUES (?, ?, ?, 0, NULL, NULL)
    ON CONFLICT(source_url) DO UPDATE SET
      file_id = excluded.file_id, cached_at = excluded.cached_at, failed = 0, last_error = NULL, retry_after = NULL
  `).run(sourceUrl, fileId, at);
}

/** Suppresses the url for a cooldown chosen from what Telegram actually said — long only for a genuinely dead URL. */
export function recordPhotoFailure(db: DB, sourceUrl: string, error: string, at: string): void {
  const cooldownMs = isPermanentPhotoError(error) ? PHOTO_PERMANENT_COOLDOWN_MS : PHOTO_TRANSIENT_COOLDOWN_MS;
  const retryAfter = new Date(new Date(at).getTime() + cooldownMs).toISOString();
  db.prepare(`
    INSERT INTO photo_cache (source_url, file_id, cached_at, failed, last_error, retry_after) VALUES (?, NULL, ?, 1, ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET
      cached_at = excluded.cached_at, failed = 1, last_error = excluded.last_error, retry_after = excluded.retry_after
  `).run(sourceUrl, at, error.slice(0, 500), retryAfter);
}

export function isKnownBadPhoto(db: DB, sourceUrl: string, now: Date = new Date()): boolean {
  const row = db.prepare('SELECT failed, retry_after FROM photo_cache WHERE source_url = ?').get(sourceUrl) as
    { failed: number; retry_after: string | null } | undefined;
  return isSuppressed(row, now);
}
