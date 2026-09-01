#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/api/types.ts
var VerticalId;
var init_types = __esm({
  "src/api/types.ts"() {
    "use strict";
    VerticalId = {
      JOBS: 1,
      IMMOBILIEN: 2,
      AUTO_MOTOR: 3,
      MARKTPLATZ: 5
    };
  }
});

// src/utils/constants.ts
function buildQuery(params, exclude = ["category"]) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (exclude.includes(key)) continue;
    if (value === void 0 || value === null || value === "") continue;
    query.set(key, value);
  }
  const qs = query.toString();
  return qs ? "?" + qs : "";
}
function resolveAreaId(location) {
  const trimmed = location.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  return LOCATION_AREA_IDS[trimmed.toLowerCase()] ?? null;
}
var WILLHABEN_BASE_URL, WILLHABEN_PUBLIC_API, SEARCH_URL_PATTERNS, SORT_CODES, REAL_ESTATE_CATEGORIES, CAR_FILTER_PARAMS, FUEL_TYPE_IDS, TRANSMISSION_IDS, CONDITION_IDS, MARKETPLACE_CATEGORIES, VERTICAL_NAMES, LOCATION_AREA_IDS, DEFAULT_USER_AGENT, CACHE_TTL_MS, RATE_LIMIT_PER_SEC;
var init_constants = __esm({
  "src/utils/constants.ts"() {
    "use strict";
    init_types();
    WILLHABEN_BASE_URL = "https://www.willhaben.at";
    WILLHABEN_PUBLIC_API = "https://publicapi.willhaben.at";
    SEARCH_URL_PATTERNS = {
      [VerticalId.IMMOBILIEN]: (params) => {
        const category = params.category || "eigentumswohnung/eigentumswohnung-angebote";
        return `/iad/immobilien/${category}${buildQuery(params)}`;
      },
      [VerticalId.AUTO_MOTOR]: (params) => {
        return `/iad/gebrauchtwagen/auto/gebrauchtwagenboerse${buildQuery(params)}`;
      },
      [VerticalId.MARKTPLATZ]: (params) => {
        const category = params.category || "";
        const base = category ? `/iad/kaufen-und-verkaufen/marktplatz/${category}` : `/iad/kaufen-und-verkaufen/marktplatz`;
        return `${base}${buildQuery(params)}`;
      },
      [VerticalId.JOBS]: (_params) => {
        return "";
      }
    };
    SORT_CODES = {
      [VerticalId.IMMOBILIEN]: {
        newest: "1",
        // Aktualität (published descending)
        nearby: "2",
        // In der Nähe (distance ascending)
        price_asc: "3",
        // Preis aufsteigend
        price_desc: "4",
        // Preis absteigend
        area_asc: "5",
        // Wohnfläche aufsteigend
        area_desc: "6",
        // Wohnfläche absteigend
        relevance: "7"
        // Relevanz
      },
      [VerticalId.AUTO_MOTOR]: {
        newest: "1",
        // Aktualität
        nearby: "2",
        // In der Nähe
        price_asc: "3",
        // Preis aufsteigend
        price_desc: "4",
        // Preis absteigend
        mileage_asc: "5",
        // km aufsteigend
        mileage_desc: "6",
        // km absteigend
        relevance: "7",
        // Relevanz
        year_desc: "8",
        // EZ absteigend
        year_asc: "9",
        // EZ aufsteigend
        model_asc: "10"
        // Modell
      },
      [VerticalId.MARKTPLATZ]: {
        newest: "1",
        nearby: "2",
        price_asc: "3",
        price_desc: "4",
        relevance: "7"
      },
      [VerticalId.JOBS]: {
        newest: "1",
        nearby: "2",
        relevance: "7"
      }
    };
    REAL_ESTATE_CATEGORIES = {
      eigentumswohnung_kaufen: { path: "eigentumswohnung/eigentumswohnung-angebote", name: "Eigentumswohnung kaufen" },
      haus_kaufen: { path: "haus-kaufen/haus-angebote", name: "Haus kaufen" },
      grundstueck_kaufen: { path: "grundstuecke/grundstueck-angebote", name: "Grundst\xFCck kaufen" },
      gewerbe_kaufen: { path: "gewerbeimmobilien-kaufen/gewerbeimmobilien-angebote", name: "Gewerbeimmobilie kaufen" },
      ferienimmobilie_kaufen: { path: "ferienimmobilien-kaufen/ferienimmobilien-angebote", name: "Ferienimmobilie kaufen" },
      mietwohnung: { path: "mietwohnungen/mietwohnung-angebote", name: "Mietwohnung (Wohnung mieten)" },
      haus_mieten: { path: "haus-mieten/haus-angebote", name: "Haus mieten" },
      gewerbe_mieten: { path: "gewerbeimmobilien-mieten/gewerbeimmobilien-angebote", name: "Gewerbeimmobilie mieten" },
      ferienimmobilie_mieten: { path: "ferienimmobilien-mieten/ferienimmobilien-angebote", name: "Ferienimmobilie mieten" },
      neubauprojekt: { path: "neubauprojekte/angebote", name: "Neubauprojekt" }
    };
    CAR_FILTER_PARAMS = {
      make: "CAR_MODEL/MAKE",
      model: "CAR_MODEL/MODEL",
      fuel_type: "ENGINE/FUEL",
      transmission: "TRANSMISSION",
      condition: "MOTOR_CONDITION",
      price_from: "PRICE_FROM",
      price_to: "PRICE_TO",
      year_from: "YEAR_MODEL_FROM",
      year_to: "YEAR_MODEL_TO",
      mileage_from: "MILEAGE_FROM",
      mileage_to: "MILEAGE_TO",
      doors_from: "NO_OF_DOORS_FROM",
      doors_to: "NO_OF_DOORS_TO",
      seats_from: "NO_OF_SEATS_FROM",
      seats_to: "NO_OF_SEATS_TO",
      power_from: "ENGINEEFFECT_FROM",
      power_to: "ENGINEEFFECT_TO",
      wheel_drive: "WHEEL_DRIVE"
    };
    FUEL_TYPE_IDS = {
      petrol: "100001",
      diesel: "100003",
      electric: "100004",
      hybrid_petrol: "100002",
      hybrid_diesel: "100005",
      gas: "100006",
      other: "100007"
    };
    TRANSMISSION_IDS = {
      manual: "180001",
      automatic: "180004"
    };
    CONDITION_IDS = {
      used: "20",
      new: "10",
      year_old: "50"
    };
    MARKETPLACE_CATEGORIES = {
      antiquitaeten_kunst: { path: "antiquitaeten-kunst-6941", name: "Antiquit\xE4ten & Kunst" },
      baby_kind: { path: "baby-kind-3928", name: "Baby & Kind" },
      beauty_gesundheit: { path: "beauty-gesundheit-wellness-3076", name: "Beauty, Gesundheit & Wellness" },
      boote: { path: "boote-yachten-jetskis-5007823", name: "Boote, Yachten & Jetskis" },
      buecher_filme_musik: { path: "buecher-filme-musik-387", name: "B\xFCcher, Filme & Musik" },
      computer_software: { path: "computer-software-5824", name: "Computer & Software" },
      dienstleistungen: { path: "dienstleistungen-537", name: "Dienstleistungen" },
      fahrraeder: { path: "fahrraeder-radsport-4525", name: "Fahrr\xE4der & Radsport" },
      freizeit: { path: "freizeit-instrumente-kulinarik-6462", name: "Freizeit, Instrumente & Kulinarik" },
      games_konsolen: { path: "games-konsolen-2785", name: "Games & Konsolen" },
      haus_garten: { path: "haus-garten-werkstatt-3541", name: "Haus, Garten & Werkstatt" },
      kameras_tv: { path: "kameras-tv-multimedia-6808", name: "Kameras, TV & Multimedia" },
      kfz_zubehoer: { path: "kfz-zubehoer-motorradteile-6142", name: "KFZ-Zubeh\xF6r & Motorradteile" },
      mode_accessoires: { path: "mode-accessoires-3275", name: "Mode & Accessoires" },
      smartphones: { path: "smartphones-telefonie-2691", name: "Smartphones & Telefonie" },
      spielzeug: { path: "spielen-spielzeug-5136", name: "Spielen & Spielzeug" },
      sport: { path: "sport-sportgeraete-4390", name: "Sport & Sportger\xE4te" },
      tiere: { path: "tiere-tierbedarf-4915", name: "Tiere & Tierbedarf" },
      uhren_schmuck: { path: "uhren-schmuck-2409", name: "Uhren & Schmuck" },
      wohnen_haushalt: { path: "wohnen-haushalt-gastronomie-5387", name: "Wohnen, Haushalt & Gastronomie" }
    };
    VERTICAL_NAMES = {
      [VerticalId.JOBS]: "Jobs",
      [VerticalId.IMMOBILIEN]: "Immobilien",
      [VerticalId.AUTO_MOTOR]: "Auto & Motor",
      [VerticalId.MARKTPLATZ]: "Marktplatz"
    };
    LOCATION_AREA_IDS = {
      burgenland: "1",
      kaernten: "2",
      "k\xE4rnten": "2",
      carinthia: "2",
      niederoesterreich: "3",
      "nieder\xF6sterreich": "3",
      "lower austria": "3",
      oberoesterreich: "4",
      "ober\xF6sterreich": "4",
      "upper austria": "4",
      salzburg: "5",
      steiermark: "6",
      styria: "6",
      tirol: "7",
      tyrol: "7",
      vorarlberg: "8",
      wien: "900",
      vienna: "900"
    };
    // PATCHED: upstream hardcodes a spoofed Chrome User-Agent. Presenting a bot as a browser is
    // exactly the "circumvention of a technical protection measure" that BGH I ZR 159/10
    // (Automobil-Onlinebörse) singled out as the fact that turns otherwise-lawful scraping into an
    // unfairness claim — the one detail worth losing nothing to give up. This identifies itself
    // honestly instead, so willhaben can recognise and block it if they want to; override with
    // WILLHABEN_USER_AGENT to add your own contact URL. See DISCLAIMER.md.
    DEFAULT_USER_AGENT = process.env.WILLHABEN_USER_AGENT || "willhaben-mcp/1.0 (+https://github.com/aliildan/willhaben-mcp; unofficial, non-commercial)";
    CACHE_TTL_MS = 5 * 60 * 1e3;
    RATE_LIMIT_PER_SEC = 1;
  }
});

// src/api/scraper.ts
import * as cheerio from "cheerio";
function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== void 0) cache.delete(oldest);
  }
  cache.set(key, { data, timestamp: Date.now() });
}
function rateLimit() {
  const minInterval = 1e3 / RATE_LIMIT_PER_SEC;
  const result = rateLimitChain.then(async () => {
    const wait = lastScheduledTime + minInterval - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastScheduledTime = Date.now();
  });
  rateLimitChain = result.catch(() => {
  });
  return result;
}
async function scrapeNextData(urlPath) {
  const url = urlPath.startsWith("http") ? urlPath : `${WILLHABEN_BASE_URL}${urlPath}`;
  const cacheKey = url;
  const cached = cache.get(cacheKey);
  if (cached) {
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
    cache.delete(cacheKey);
  }
  await rateLimit();
  const response = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "de-AT,de;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();
  const data = extractNextData(html);
  if (data) {
    cacheSet(cacheKey, data);
  }
  return data;
}
function extractNextData(html) {
  const $ = cheerio.load(html);
  const scriptTag = $("script#__NEXT_DATA__").first();
  if (!scriptTag.length) {
    return null;
  }
  const jsonStr = scriptTag.html();
  if (!jsonStr) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed.props?.pageProps ?? null;
  } catch (e) {
    const startTag = '<script id="__NEXT_DATA__" type="application/json">';
    const startIdx = html.indexOf(startTag);
    if (startIdx === -1) return null;
    const jsonStart = startIdx + startTag.length;
    const jsonEnd = html.indexOf("</script>", jsonStart);
    if (jsonEnd === -1) return null;
    try {
      const manualParsed = JSON.parse(html.substring(jsonStart, jsonEnd));
      return manualParsed.props?.pageProps ?? null;
    } catch {
      return null;
    }
  }
}
async function scrapeSearchResults(urlPath) {
  const pageProps = await scrapeNextData(urlPath);
  if (!pageProps) {
    return { result: null, isInitial: false };
  }
  if (pageProps.is404) {
    return { result: null, isInitial: false };
  }
  if (pageProps.searchResult) {
    return { result: pageProps.searchResult, isInitial: false };
  }
  if (pageProps.initialSearchResult) {
    return { result: pageProps.initialSearchResult, isInitial: true };
  }
  return { result: null, isInitial: false };
}
async function scrapeAdDetail(urlPath) {
  const pageProps = await scrapeNextData(urlPath);
  return pageProps?.advertDetails ?? null;
}
async function fetchPublicApi(urlPath) {
  await rateLimit();
  const url = urlPath.startsWith("http") ? urlPath : `${WILLHABEN_PUBLIC_API}${urlPath}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      "Accept": "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`Public API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
var CACHE_MAX_ENTRIES, cache, rateLimitChain, lastScheduledTime;
var init_scraper = __esm({
  "src/api/scraper.ts"() {
    "use strict";
    init_constants();
    CACHE_MAX_ENTRIES = 100;
    cache = /* @__PURE__ */ new Map();
    rateLimitChain = Promise.resolve();
    lastScheduledTime = 0;
  }
});

// src/api/geo.ts
async function lookupAreaSuggestions(term) {
  await rateLimit();
  const url = `${WILLHABEN_BASE_URL}/webapi/autocomplete/area?term=${encodeURIComponent(term)}&source=desktop`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      "Accept": "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`Area autocomplete failed: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}
async function resolveLocationToAreaId(location) {
  const trimmed = location.trim();
  if (!trimmed) return null;
  const direct = resolveAreaId(trimmed);
  if (direct) return direct;
  const cacheKey = trimmed.toLowerCase();
  if (areaCache.has(cacheKey)) return areaCache.get(cacheKey);
  let groups;
  try {
    groups = await lookupAreaSuggestions(trimmed);
  } catch {
    areaCache.set(cacheKey, null);
    return null;
  }
  const groupOrder = ["Gemeinde", "PLZ", "Ort"];
  const orderedGroups = [
    ...groupOrder.map((n) => groups.find((g) => g.name === n)).filter((g) => !!g),
    ...groups.filter((g) => !groupOrder.includes(g.name))
  ];
  let resolved = null;
  for (const group of orderedGroups) {
    if (!group.entries?.length) continue;
    const exact = group.entries.find(
      (e) => e.label.toLowerCase() === trimmed.toLowerCase()
    );
    const chosen = exact ?? group.entries[0];
    resolved = String(chosen.areaId);
    break;
  }
  areaCache.set(cacheKey, resolved);
  return resolved;
}
var areaCache;
var init_geo = __esm({
  "src/api/geo.ts"() {
    "use strict";
    init_constants();
    init_scraper();
    areaCache = /* @__PURE__ */ new Map();
  }
});

// src/api/jobs.ts
var jobs_exports = {};
__export(jobs_exports, {
  searchJobs: () => searchJobs
});
function simplifyJobAd(ad) {
  const attrs = attributesToMap(ad.attributes);
  const url = `https://www.willhaben.at/iad/job/${ad.id}`;
  const title = ad.description ?? "";
  const location = attrs.LOCATION ?? null;
  const orgName = attrs.ORGNAME ?? null;
  const published = attrs.PUBLISHED_String ?? attrs.PUBLISHED ?? null;
  const imageUrl = ad.advertImageList?.mainImageUrl ?? ad.advertImageList?.referenceImageUrl ?? null;
  return {
    id: ad.id,
    title,
    price: null,
    price_number: null,
    location,
    url,
    image_url: imageUrl,
    published,
    attributes: attrs,
    vertical: "Jobs",
    is_private: false,
    advertiser_name: orgName
  };
}
async function searchJobs(input) {
  const { keyword, job_type, sort = "newest", rows = 30, page = 1 } = input;
  const params = new URLSearchParams();
  params.set("rows", String(rows));
  params.set("page", String(page));
  const sortMap = {
    newest: "1",
    nearby: "2"
  };
  const sortCode = sortMap[sort] ?? sortMap.newest;
  params.set("sort", sortCode);
  if (keyword) {
    params.set("keyword", keyword);
  }
  if (job_type) {
    params.set("JOB_TYPE", job_type);
  }
  const urlPath = `/jobs/v2/adverts?${params.toString()}`;
  try {
    const result = await fetchPublicApi(urlPath);
    const listings = (result.advertSummaryList ?? []).map(simplifyJobAd);
    return {
      total: result.rowsFound,
      page: result.pageRequested ?? page,
      rows_per_page: result.rowsRequested ?? rows,
      listings,
      vertical: "jobs",
      description: result.searchTitle
    };
  } catch (error) {
    return searchJobsViaScraping(keyword, rows, page, sort);
  }
}
async function searchJobsViaScraping(keyword, rows = 30, page = 1, sort) {
  const params = new URLSearchParams();
  params.set("rows", String(rows));
  params.set("page", String(page));
  if (keyword) params.set("keyword", keyword);
  const sortCode = sort ? SORT_CODES[VerticalId.JOBS]?.[sort] : void 0;
  if (sortCode) params.set("sort", sortCode);
  const urlPath = `/iad/stellenmarkt?${params.toString()}`;
  const { result } = await scrapeSearchResults(urlPath);
  if (!result) {
    return { total: 0, page, rows_per_page: rows, listings: [], vertical: "jobs" };
  }
  const listings = (result.advertSummaryList?.advertSummary ?? []).map(simplifyAdSummary);
  return {
    total: result.rowsFound,
    page: result.pageRequested,
    rows_per_page: result.rowsRequested,
    listings,
    vertical: "jobs",
    description: result.searchTitle
  };
}
var init_jobs = __esm({
  "src/api/jobs.ts"() {
    "use strict";
    init_types();
    init_scraper();
    init_search();
    init_constants();
  }
});

// src/api/search.ts
function attributesToMap(attributes) {
  const attrs = {};
  for (const attr of attributes ?? []) {
    attrs[attr.name] = attr.values.length === 1 ? attr.values[0] : attr.values;
  }
  return attrs;
}
function simplifyAdSummary(ad) {
  const attrs = attributesToMap(ad.attributes?.attribute);
  const seoUrl = attrs.SEO_URL;
  const url = seoUrl ? `https://www.willhaben.at/iad/${seoUrl}` : `https://www.willhaben.at/iad/object?adId=${ad.id}`;
  const mainImage = ad.advertImageList?.advertImage?.[0];
  const imageUrl = mainImage?.mainImageUrl ?? mainImage?.referenceImageUrl ?? null;
  const priceForDisplay = attrs.PRICE_FOR_DISPLAY;
  const priceNumber = attrs.PRICE;
  const location = attrs.LOCATION ?? attrs.ADDRESS ?? null;
  const heading = attrs.HEADING;
  const orgName = attrs.ORGNAME;
  const isPrivate = attrs.ISPRIVATE;
  const published = attrs.PUBLISHED_String;
  return {
    id: ad.id,
    title: heading ?? ad.description ?? "",
    price: priceForDisplay ?? null,
    price_number: priceNumber ? parseFloat(priceNumber) : null,
    location,
    url,
    image_url: imageUrl,
    published: published ?? null,
    attributes: attrs,
    vertical: VERTICAL_NAMES[ad.verticalId] ?? String(ad.verticalId),
    is_private: isPrivate === "1",
    advertiser_name: orgName ?? null
  };
}
async function searchListings(input) {
  const { vertical: verticalName, keyword, category, rows = 30, page = 1, sort, price_from, price_to, location } = input;
  const verticalMap = {
    marketplace: VerticalId.MARKTPLATZ,
    real_estate: VerticalId.IMMOBILIEN,
    cars: VerticalId.AUTO_MOTOR,
    jobs: VerticalId.JOBS
  };
  const verticalId = verticalMap[verticalName];
  if (!verticalId) {
    throw new Error(`Unknown vertical: ${verticalName}. Use: marketplace, real_estate, cars, or jobs`);
  }
  if (verticalId === VerticalId.JOBS) {
    const { searchJobs: searchJobs2 } = await Promise.resolve().then(() => (init_jobs(), jobs_exports));
    return searchJobs2({
      keyword,
      rows,
      page,
      sort: sort ?? "newest"
    });
  }
  const params = {
    rows: String(rows),
    page: String(page)
  };
  if (sort) {
    const sortCode = SORT_CODES[verticalId]?.[sort];
    if (sortCode) {
      params.sort = sortCode;
    }
  }
  if (keyword) {
    params.keyword = keyword;
  }
  if (price_from !== void 0) {
    params.PRICE_FROM = String(price_from);
  }
  if (price_to !== void 0) {
    params.PRICE_TO = String(price_to);
  }
  if (location) {
    const areaId = await resolveLocationToAreaId(location);
    if (areaId) params.areaId = areaId;
  }
  if (category && (verticalId === VerticalId.MARKTPLATZ || verticalId === VerticalId.IMMOBILIEN)) {
    params.category = category;
  }
  const urlPath = SEARCH_URL_PATTERNS[verticalId](params);
  const { result } = await scrapeSearchResults(urlPath);
  if (!result) {
    return {
      total: 0,
      page,
      rows_per_page: rows,
      listings: [],
      vertical: verticalName
    };
  }
  const listings = (result.advertSummaryList?.advertSummary ?? []).map(simplifyAdSummary);
  return {
    total: result.rowsFound,
    page: result.pageRequested,
    rows_per_page: result.rowsRequested,
    listings,
    vertical: verticalName,
    description: result.searchTitle
  };
}
function resolveRealEstateCategory(propertyType, action) {
  const t = (propertyType ?? "").trim().toLowerCase();
  const alias = {
    eigentumswohnung: "wohnung",
    wohnung: "wohnung",
    apartment: "wohnung",
    flat: "wohnung",
    mietwohnung: "wohnung",
    rental: "wohnung",
    haus: "haus",
    house: "haus",
    einfamilienhaus: "haus",
    grundstueck: "grundstueck",
    "grundst\xFCck": "grundstueck",
    land: "grundstueck",
    plot: "grundstueck",
    buero: "gewerbe",
    "b\xFCro": "gewerbe",
    gewerbe: "gewerbe",
    office: "gewerbe",
    commercial: "gewerbe",
    ferien: "ferien",
    ferienimmobilie: "ferien",
    holiday: "ferien",
    neubau: "neubauprojekt",
    neubauprojekt: "neubauprojekt",
    bauprojekt: "neubauprojekt",
    projekt: "neubauprojekt",
    project: "neubauprojekt"
  };
  const act = t === "mietwohnung" || t === "rental" ? "rent" : action;
  const key = alias[t] ?? "wohnung";
  return REAL_ESTATE_PATHS[key][act];
}
async function searchRealEstate(input) {
  const { property_type, action = "buy", location, price_from, price_to, rooms, area_from, area_to, sort, rows = 30, page = 1 } = input;
  const categoryPath = resolveRealEstateCategory(property_type, action === "rent" ? "rent" : "buy");
  const params = {
    rows: String(rows),
    page: String(page)
  };
  if (sort) {
    const sortCode = SORT_CODES[VerticalId.IMMOBILIEN]?.[sort];
    if (sortCode) params.sort = sortCode;
  }
  if (price_from !== void 0) params.PRICE_FROM = String(price_from);
  if (price_to !== void 0) params.PRICE_TO = String(price_to);
  if (rooms) params.NUMBER_OF_ROOMS = String(rooms);
  if (area_from !== void 0) params["ESTATE_SIZE/LIVING_AREA_FROM"] = String(area_from);
  if (area_to !== void 0) params["ESTATE_SIZE/LIVING_AREA_TO"] = String(area_to);
  if (location) {
    const areaId = await resolveLocationToAreaId(location);
    if (areaId) params.areaId = areaId;
  }
  const urlPath = SEARCH_URL_PATTERNS[VerticalId.IMMOBILIEN]({ ...params, category: categoryPath });
  const { result } = await scrapeSearchResults(urlPath);
  if (!result) {
    return { total: 0, page, rows_per_page: rows, listings: [], vertical: "real_estate" };
  }
  const listings = (result.advertSummaryList?.advertSummary ?? []).map(simplifyAdSummary);
  return {
    total: result.rowsFound,
    page: result.pageRequested,
    rows_per_page: result.rowsRequested,
    listings,
    vertical: "real_estate",
    description: result.searchTitle
  };
}
async function searchCars(input) {
  const { make, model, location, price_from, price_to, year_from, year_to, mileage_from, mileage_to, fuel_type, transmission, condition, sort, rows = 30, page = 1 } = input;
  const params = {
    rows: String(rows),
    page: String(page)
  };
  if (sort) {
    const sortCode = SORT_CODES[VerticalId.AUTO_MOTOR]?.[sort];
    if (sortCode) params.sort = sortCode;
  }
  const keywordParts = [];
  if (make) {
    if (/^\d+$/.test(make)) params[CAR_FILTER_PARAMS.make] = make;
    else keywordParts.push(make);
  }
  if (model) {
    if (/^\d+$/.test(model)) params[CAR_FILTER_PARAMS.model] = model;
    else keywordParts.push(model);
  }
  if (keywordParts.length > 0) params.keyword = keywordParts.join(" ");
  if (location) {
    const areaId = await resolveLocationToAreaId(location);
    if (areaId) params.areaId = areaId;
  }
  if (price_from !== void 0) params[CAR_FILTER_PARAMS.price_from] = String(price_from);
  if (price_to !== void 0) params[CAR_FILTER_PARAMS.price_to] = String(price_to);
  if (year_from) params[CAR_FILTER_PARAMS.year_from] = String(year_from);
  if (year_to) params[CAR_FILTER_PARAMS.year_to] = String(year_to);
  if (mileage_from) params[CAR_FILTER_PARAMS.mileage_from] = String(mileage_from);
  if (mileage_to) params[CAR_FILTER_PARAMS.mileage_to] = String(mileage_to);
  if (fuel_type) {
    const fuelId = FUEL_TYPE_IDS[fuel_type.toLowerCase()];
    if (fuelId) params[CAR_FILTER_PARAMS.fuel_type] = fuelId;
  }
  if (transmission) {
    const transId = TRANSMISSION_IDS[transmission.toLowerCase()];
    if (transId) params[CAR_FILTER_PARAMS.transmission] = transId;
  }
  if (condition) {
    const condId = CONDITION_IDS[condition.toLowerCase()];
    if (condId) params[CAR_FILTER_PARAMS.condition] = condId;
  }
  const urlPath = SEARCH_URL_PATTERNS[VerticalId.AUTO_MOTOR](params);
  const { result } = await scrapeSearchResults(urlPath);
  if (!result) {
    return { total: 0, page, rows_per_page: rows, listings: [], vertical: "cars" };
  }
  const listings = (result.advertSummaryList?.advertSummary ?? []).map(simplifyAdSummary);
  return {
    total: result.rowsFound,
    page: result.pageRequested,
    rows_per_page: result.rowsRequested,
    listings,
    vertical: "cars",
    description: result.searchTitle
  };
}
async function searchMarketplace(input = {}) {
  const { keyword, category, condition, location, price_from, price_to, sort, rows = 30, page = 1 } = input;
  const params = {
    rows: String(rows),
    page: String(page)
  };
  if (sort) {
    const sortCode = SORT_CODES[VerticalId.MARKTPLATZ]?.[sort];
    if (sortCode) params.sort = sortCode;
  }
  if (keyword) params.keyword = keyword;
  if (price_from !== void 0) params.PRICE_FROM = String(price_from);
  if (price_to !== void 0) params.PRICE_TO = String(price_to);
  if (location) {
    const areaId = await resolveLocationToAreaId(location);
    if (areaId) params.areaId = areaId;
  }
  if (condition) {
    const conditionMap = {
      neu: "22",
      new: "22",
      gebraucht: "23",
      used: "23",
      defekt: "24",
      defective: "24"
    };
    const condId = conditionMap[condition.toLowerCase()];
    if (condId) params.treeAttributes = condId;
  }
  const urlPath = SEARCH_URL_PATTERNS[VerticalId.MARKTPLATZ]({ ...params, category: category ?? "" });
  const { result } = await scrapeSearchResults(urlPath);
  if (!result) {
    return { total: 0, page, rows_per_page: rows, listings: [], vertical: "marketplace" };
  }
  const listings = (result.advertSummaryList?.advertSummary ?? []).map(simplifyAdSummary);
  return {
    total: result.rowsFound,
    page: result.pageRequested,
    rows_per_page: result.rowsRequested,
    listings,
    vertical: "marketplace",
    description: result.searchTitle
  };
}
var REAL_ESTATE_PATHS;
var init_search = __esm({
  "src/api/search.ts"() {
    "use strict";
    init_types();
    init_scraper();
    init_geo();
    init_constants();
    REAL_ESTATE_PATHS = {
      wohnung: {
        buy: "eigentumswohnung/eigentumswohnung-angebote",
        rent: "mietwohnungen/mietwohnung-angebote"
      },
      haus: {
        buy: "haus-kaufen/haus-angebote",
        rent: "haus-mieten/haus-angebote"
      },
      grundstueck: {
        // willhaben has no separate rental-land category; both resolve to the same landing.
        buy: "grundstuecke/grundstueck-angebote",
        rent: "grundstuecke/grundstueck-angebote"
      },
      gewerbe: {
        buy: "gewerbeimmobilien-kaufen/gewerbeimmobilien-angebote",
        rent: "gewerbeimmobilien-mieten/gewerbeimmobilien-angebote"
      },
      ferien: {
        buy: "ferienimmobilien-kaufen/ferienimmobilien-angebote",
        rent: "ferienimmobilien-mieten/ferienimmobilien-angebote"
      },
      neubauprojekt: {
        // Projects aren't split by buy/rent.
        buy: "neubauprojekte/angebote",
        rent: "neubauprojekte/angebote"
      }
    };
  }
});

// src/index.ts
init_search();
init_jobs();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// src/api/detail.ts
init_scraper();
init_search();
init_constants();
async function getListingDetail(id) {
  const adDetail = await scrapeAdDetail(`/iad/object?adId=${id}`);
  return adDetail ? simplifyAdDetail(adDetail) : null;
}
function simplifyAdDetail(ad) {
  const attrs = attributesToMap(ad.attributes?.attribute);
  const images = ad.advertImageList?.advertImage?.map((img) => img.referenceImageUrl ?? img.mainImageUrl) ?? [];
  const seoUrl = attrs.SEO_URL;
  const url = seoUrl ? `https://www.willhaben.at/iad/${seoUrl}` : `https://www.willhaben.at/iad/object?adId=${ad.id}`;
  const priceForDisplay = attrs.PRICE_FOR_DISPLAY;
  const priceNumber = attrs.PRICE;
  const location = attrs.LOCATION;
  const heading = attrs.HEADING;
  const bodyDyn = attrs.BODY_DYN;
  const description = bodyDyn ?? ad.description ?? "";
  return {
    id: ad.id,
    title: heading ?? description.substring(0, 100),
    description,
    price: priceForDisplay ?? null,
    price_number: priceNumber ? parseFloat(priceNumber) : null,
    location: location ?? null,
    url,
    images,
    attributes: attrs,
    vertical: VERTICAL_NAMES[ad.verticalId] ?? String(ad.verticalId),
    is_private: attrs.ISPRIVATE === "1",
    advertiser: {
      name: ad.organisationDetails?.orgName ?? null,
      phone: ad.organisationDetails?.orgPhone ?? null,
      email: ad.organisationDetails?.orgEmail ?? null,
      logo_url: ad.organisationDetails?.orgLogoUrl ?? null,
      active_ad_count: ad.sellerProfileUserData?.activeAdCount ?? null
    },
    address: {
      street: ad.advertAddressDetails?.addressLines?.[0] ?? null,
      postcode: ad.advertAddressDetails?.postCode ?? null,
      city: ad.advertAddressDetails?.postalName ?? ad.advertAddressDetails?.municipality ?? null,
      country: ad.advertAddressDetails?.country ?? null,
      coordinates: attrs.COORDINATES ?? null
    },
    contact_type: ad.contactOption?.contactType ?? null,
    chat_enabled: ad.chatEnabled ?? false,
    published_date: ad.publishedDate ?? null,
    category_id: ad.categoryTreeId ?? null
  };
}

// src/index.ts
init_constants();

// src/utils/formatters.ts
function formatListings(listings) {
  if (listings.length === 0) {
    return "No listings found.";
  }
  const lines = listings.map((listing, i) => {
    const parts = [`**${i + 1}. ${listing.title}**`];
    if (listing.price) {
      parts.push(`\u{1F4B0} ${listing.price}`);
    }
    if (listing.location) {
      parts.push(`\u{1F4CD} ${listing.location}`);
    }
    if (listing.published) {
      parts.push(`\u{1F4C5} ${listing.published}`);
    }
    if (listing.is_private !== void 0) {
      parts.push(listing.is_private ? "\u{1F464} Private" : "\u{1F3E2} Dealer");
    }
    if (listing.advertiser_name) {
      parts.push(`\u{1F3F7}\uFE0F ${listing.advertiser_name}`);
    }
    const attrMap = listing.attributes;
    if (attrMap) {
      if (attrMap["ESTATE_SIZE/LIVING_AREA"]) {
        parts.push(`\u{1F4D0} ${attrMap["ESTATE_SIZE/LIVING_AREA"]} m\xB2`);
      }
      if (attrMap["NUMBER_OF_ROOMS"]) {
        parts.push(`\u{1F6CF}\uFE0F ${attrMap["NUMBER_OF_ROOMS"]} rooms`);
      }
      if (attrMap["PRICE/SQUARE_METER_FOR_DISPLAY"]) {
        parts.push(`\u{1F4CA} ${attrMap["PRICE/SQUARE_METER_FOR_DISPLAY"]}`);
      }
      if (attrMap["YEAR_MODEL_FROM/TO"]) {
        parts.push(`\u{1F5D3}\uFE0F ${attrMap["YEAR_MODEL_FROM/TO"]}`);
      }
      if (attrMap["MILEAGE"]) {
        parts.push(`\u{1F6E3}\uFE0F ${attrMap["MILEAGE"]} km`);
      }
      if (attrMap["ENGINE/FUEL"]) {
        const fuel = attrMap["ENGINE/FUEL"];
        const fuelName = fuel === "100001" ? "Petrol" : fuel === "100003" ? "Diesel" : fuel === "100004" ? "Electric" : fuel;
        parts.push(`\u26FD ${fuelName}`);
      }
      if (attrMap["TRANSMISSION"]) {
        const trans = attrMap["TRANSMISSION"];
        const transName = trans === "180001" ? "Manual" : trans === "180004" ? "Automatic" : trans;
        parts.push(`\u2699\uFE0F ${transName}`);
      }
      if (attrMap["EMPLOYMENT_TYPE"]) {
        parts.push(`\u{1F4BC} ${attrMap["EMPLOYMENT_TYPE"]}`);
      }
    }
    parts.push(`\u{1F517} ${listing.url}`);
    return parts.join(" | ");
  });
  return lines.join("\n\n");
}
// PATCHED (austria-apartment-hunt): upstream hardcoded this at 5, which meant Telegram albums
// (Telegram's own sendMediaGroup hard cap is 10) never got more than 5 photos even when a
// listing had far more. Raised to Telegram's actual ceiling.
var IMAGE_DISPLAY_CAP = 10;
function formatDetail(detail) {
  const lines = [];
  lines.push(`# ${detail.title}`);
  lines.push("");
  if (detail.price) {
    lines.push(`\u{1F4B0} **Price:** ${detail.price}`);
  }
  if (detail.location) {
    lines.push(`\u{1F4CD} **Location:** ${detail.location}`);
  }
  if (detail.published_date) {
    lines.push(`\u{1F4C5} **Published:** ${detail.published_date}`);
  }
  lines.push(`\u{1F517} **URL:** ${detail.url}`);
  lines.push(`\u{1F3F7}\uFE0F **Type:** ${detail.is_private ? "Private" : "Dealer"}`);
  if (detail.advertiser.name) {
    lines.push(`\u{1F464} **Seller:** ${detail.advertiser.name}`);
  }
  if (detail.address.street || detail.address.city) {
    const addr = [detail.address.street, detail.address.postcode, detail.address.city, detail.address.country].filter(Boolean).join(", ");
    lines.push(`\u{1F3E0} **Address:** ${addr}`);
  }
  if (detail.address.coordinates) {
    lines.push(`\u{1F4CD} **Coordinates:** ${detail.address.coordinates}`);
  }
  if (detail.chat_enabled) {
    lines.push(`\u{1F4AC} **Chat:** Available`);
  }
  if (detail.contact_type) {
    lines.push(`\u{1F4DE} **Contact:** ${detail.contact_type}`);
  }
  if (detail.attributes) {
    lines.push("");
    lines.push("## Key Details");
    const attrMap = detail.attributes;
    const reAttrs = {
      "ESTATE_SIZE/LIVING_AREA": "Living Area",
      "NUMBER_OF_ROOMS": "Rooms",
      "PRICE/SQUARE_METER_FOR_DISPLAY": "Price/m\xB2",
      "PROPERTY_TYPE": "Property Type",
      "BUILDING_TYPE": "Building Type",
      "HEATING": "Heating",
      "OWNAGETYPE": "Ownership Type",
      "ENERGY_HWB_CLASS": "Energy Class (HWB)",
      "ENERGY_FGEE_CLASS": "Energy Class (FGEE)",
      "ESTATE_PRICE/PRICE_SUGGESTION_FOR_DISPLAY": "Price Suggestion",
      "ESTATE_PRICE/OTHERCOSTS_NET": "Additional Costs",
      "ESTATE_PRICE/MONTHCOSTS_GROSS": "Monthly Costs",
      "ADDITIONAL_COST/FEE": "Additional Fee"
    };
    for (const [key, label] of Object.entries(reAttrs)) {
      const val = attrMap[key];
      if (val) {
        lines.push(`- **${label}:** ${Array.isArray(val) ? val.join(", ") : val}`);
      }
    }
    const carAttrs = {
      "YEAR_MODEL_FROM/TO": "Year",
      "MILEAGE": "Mileage",
      "ENGINE/FUEL": "Fuel Type",
      "TRANSMISSION": "Transmission",
      "CAR_MODEL/MAKE": "Make",
      "CAR_MODEL/MODEL": "Model",
      "ENGINEEFFECT_FROM/TO": "Power (kW)",
      "NO_OF_DOORS_FROM/TO": "Doors",
      "WHEEL_DRIVE": "Drive Type"
    };
    for (const [key, label] of Object.entries(carAttrs)) {
      const val = attrMap[key];
      if (val) {
        lines.push(`- **${label}:** ${Array.isArray(val) ? val.join(", ") : val}`);
      }
    }
    if (attrMap["BODY_DYN"]) {
      lines.push("");
      lines.push("## Description");
      lines.push(String(attrMap["BODY_DYN"]));
    }
  }
  if (detail.images && detail.images.length > 0) {
    lines.push("");
    lines.push(`## Images (${detail.images.length})`);
    lines.push(detail.images.slice(0, IMAGE_DISPLAY_CAP).join("\n"));
    if (detail.images.length > IMAGE_DISPLAY_CAP) {
      lines.push(`... and ${detail.images.length - IMAGE_DISPLAY_CAP} more`);
    }
  }
  return lines.join("\n");
}
function formatSearchResults(total, page, rowsPerPage, listings, vertical, description) {
  const header = `## Search Results${description ? `: ${description}` : ""}`;
  const summary = `Found **${total.toLocaleString()}** listings (showing ${listings.length} of ${rowsPerPage} per page, page ${page})`;
  const verticalLabel = `Vertical: ${vertical}`;
  const formattedListings = formatListings(listings);
  return [header, "", summary, verticalLabel, "", formattedListings].join("\n");
}
function formatCategories(vertical, categories) {
  const lines = [`## ${vertical} Categories`, ""];
  for (const [key, cat] of Object.entries(categories)) {
    lines.push(`- **${cat.name}** (\`${key}\`): ${cat.path}`);
  }
  return lines.join("\n");
}

// src/index.ts
var server = new McpServer({
  name: "willhaben",
  version: "1.0.2",
  description: "Search willhaben.at - Austria's largest classifieds marketplace. Search real estate, cars, jobs, and marketplace listings."
});
server.tool(
  "willhaben_search",
  "Search willhaben.at across all verticals (marketplace, real estate, cars, jobs). Returns listing summaries with prices, locations, and key attributes.",
  {
    vertical: z.enum(["marketplace", "real_estate", "cars", "jobs"]).describe("Which vertical to search"),
    keyword: z.string().optional().describe("Search term/keyword"),
    category: z.string().optional().describe("Category path (e.g., 'eigentumswohnung/eigentumswohnung-angebote' for real estate)"),
    location: z.string().optional().describe("Location: Austrian state, city, place, or postal code (e.g. 'Wien', 'Graz', 'Innsbruck', '6020'). Resolved to an area automatically. Not supported for jobs."),
    price_from: z.number().optional().describe("Minimum price"),
    price_to: z.number().optional().describe("Maximum price"),
    sort: z.string().optional().describe("Sort order: 'newest', 'nearby', 'price_asc', 'price_desc', 'relevance'"),
    rows: z.number().optional().describe("Results per page (default: 30, max: 100)"),
    page: z.number().optional().describe("Page number (default: 1)")
  },
  async (params) => {
    try {
      const result = await searchListings({
        vertical: params.vertical,
        keyword: params.keyword,
        category: params.category,
        location: params.location,
        price_from: params.price_from,
        price_to: params.price_to,
        sort: params.sort,
        rows: Math.min(params.rows ?? 30, 100),
        page: params.page ?? 1
      });
      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(
              result.total,
              result.page,
              result.rows_per_page,
              result.listings,
              result.vertical,
              result.description
            )
          }
        ]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error searching willhaben: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "willhaben_search_real_estate",
  "Search willhaben.at real estate listings (apartments, houses for sale/rent). Filter by property type, price, rooms, area, and location.",
  {
    property_type: z.string().optional().describe("Property type: 'eigentumswohnung' (apartment), 'haus' (house), 'mietwohnung' (rental), 'grundstueck' (land)"),
    action: z.enum(["buy", "rent"]).optional().describe("Buy or rent (default: buy)"),
    location: z.string().optional().describe("Location: Austrian state, city, place, or postal code (e.g. 'Wien', 'Graz', '6020'). Resolved to an area automatically."),
    price_from: z.number().optional().describe("Minimum price"),
    price_to: z.number().optional().describe("Maximum price"),
    rooms: z.number().optional().describe("Number of rooms"),
    area_from: z.number().optional().describe("Minimum living area in m\xB2"),
    area_to: z.number().optional().describe("Maximum living area in m\xB2"),
    sort: z.string().optional().describe("Sort: 'newest', 'nearby', 'price_asc', 'price_desc', 'area_asc', 'area_desc', 'relevance'"),
    rows: z.number().optional().describe("Results per page (default: 30)"),
    page: z.number().optional().describe("Page number (default: 1)")
  },
  async (params) => {
    try {
      const result = await searchRealEstate({
        property_type: params.property_type,
        action: params.action,
        location: params.location,
        price_from: params.price_from,
        price_to: params.price_to,
        rooms: params.rooms,
        area_from: params.area_from,
        area_to: params.area_to,
        sort: params.sort,
        rows: Math.min(params.rows ?? 30, 100),
        page: params.page ?? 1
      });
      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(
              result.total,
              result.page,
              result.rows_per_page,
              result.listings,
              "real_estate",
              result.description
            )
          }
        ]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error searching real estate: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "willhaben_search_cars",
  "Search willhaben.at car listings (used cars, new cars). Filter by make, model, price, year, mileage, fuel type, and transmission.",
  {
    make: z.string().optional().describe("Car brand (e.g., 'BMW', 'Audi', 'Volkswagen'). Matched as a keyword unless a numeric willhaben make ID is given."),
    model: z.string().optional().describe("Car model (matched as a keyword)"),
    location: z.string().optional().describe("Location: Austrian state, city, place, or postal code (e.g. 'Wien', 'Graz', '6020'). Resolved to an area automatically."),
    price_from: z.number().optional().describe("Minimum price"),
    price_to: z.number().optional().describe("Maximum price"),
    year_from: z.number().optional().describe("Minimum year of construction"),
    year_to: z.number().optional().describe("Maximum year of construction"),
    mileage_from: z.number().optional().describe("Minimum mileage in km"),
    mileage_to: z.number().optional().describe("Maximum mileage in km"),
    fuel_type: z.string().optional().describe("Fuel type: 'petrol', 'diesel', 'electric', 'hybrid_petrol', 'hybrid_diesel'"),
    transmission: z.string().optional().describe("Transmission: 'manual' or 'automatic'"),
    condition: z.string().optional().describe("Condition: 'used', 'new', 'year_old'"),
    sort: z.string().optional().describe("Sort: 'newest', 'nearby', 'price_asc', 'price_desc', 'mileage_asc', 'mileage_desc', 'year_desc', 'year_asc', 'relevance'"),
    rows: z.number().optional().describe("Results per page (default: 30)"),
    page: z.number().optional().describe("Page number (default: 1)")
  },
  async (params) => {
    try {
      const result = await searchCars({
        make: params.make,
        model: params.model,
        location: params.location,
        price_from: params.price_from,
        price_to: params.price_to,
        year_from: params.year_from,
        year_to: params.year_to,
        mileage_from: params.mileage_from,
        mileage_to: params.mileage_to,
        fuel_type: params.fuel_type,
        transmission: params.transmission,
        condition: params.condition,
        sort: params.sort,
        rows: Math.min(params.rows ?? 30, 100),
        page: params.page ?? 1
      });
      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(
              result.total,
              result.page,
              result.rows_per_page,
              result.listings,
              "cars",
              result.description
            )
          }
        ]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error searching cars: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "willhaben_search_jobs",
  "Search willhaben.at job listings. Filter by keyword and job type.",
  {
    keyword: z.string().optional().describe("Job title or keyword (also matches location names, e.g. 'Software Wien')"),
    job_type: z.string().optional().describe("Job type: 'Vollzeit', 'Teilzeit', etc."),
    sort: z.string().optional().describe("Sort: 'newest' or 'nearby'"),
    rows: z.number().optional().describe("Results per page (default: 30)"),
    page: z.number().optional().describe("Page number (default: 1)")
  },
  async (params) => {
    try {
      const result = await searchJobs({
        keyword: params.keyword,
        job_type: params.job_type,
        sort: params.sort,
        rows: Math.min(params.rows ?? 30, 100),
        page: params.page ?? 1
      });
      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(
              result.total,
              result.page,
              result.rows_per_page,
              result.listings,
              "jobs",
              result.description
            )
          }
        ]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error searching jobs: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "willhaben_get_listing",
  "Get full details for a specific willhaben.at listing by ID. Returns all attributes, images, seller info, contact details, and description.",
  {
    id: z.string().describe("The willhaben listing/ad ID (e.g., '1370327604')")
  },
  async (params) => {
    try {
      const detail = await getListingDetail(params.id);
      if (!detail) {
        return {
          content: [{ type: "text", text: `Listing ${params.id} not found. Make sure the ID is correct.` }],
          isError: true
        };
      }
      return {
        content: [{ type: "text", text: formatDetail(detail) }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error getting listing detail: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "willhaben_search_marketplace",
  "Search willhaben.at marketplace (Marktplatz) for second-hand items. Filter by keyword, category, condition, price, and location.",
  {
    keyword: z.string().optional().describe("Search term/keyword"),
    category: z.string().optional().describe("Category slug including the numeric ID (e.g., 'computer-software-5824', 'smartphones-telefonie-2691'). Use willhaben_get_categories to list valid slugs."),
    condition: z.string().optional().describe("Item condition: 'neu'/'new', 'gebraucht'/'used', or 'defekt'/'defective'"),
    location: z.string().optional().describe("Location: Austrian state, city, place, or postal code (e.g. 'Wien', 'Graz', '6020')"),
    price_from: z.number().optional().describe("Minimum price"),
    price_to: z.number().optional().describe("Maximum price"),
    sort: z.string().optional().describe("Sort: 'newest', 'price_asc', 'price_desc', 'relevance'"),
    rows: z.number().optional().describe("Results per page (default: 30)"),
    page: z.number().optional().describe("Page number (default: 1)")
  },
  async (params) => {
    try {
      const result = await searchMarketplace({
        keyword: params.keyword,
        category: params.category,
        condition: params.condition,
        location: params.location,
        price_from: params.price_from,
        price_to: params.price_to,
        sort: params.sort,
        rows: Math.min(params.rows ?? 30, 100),
        page: params.page ?? 1
      });
      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(
              result.total,
              result.page,
              result.rows_per_page,
              result.listings,
              "marketplace",
              result.description
            )
          }
        ]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error searching marketplace: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "willhaben_get_categories",
  "Get available category paths for a willhaben.at vertical. Use these categories in search queries.",
  {
    vertical: z.enum(["marketplace", "real_estate", "cars", "jobs"]).describe("Which vertical to get categories for")
  },
  async (params) => {
    try {
      if (params.vertical === "real_estate") {
        return {
          content: [{ type: "text", text: formatCategories("Real Estate", REAL_ESTATE_CATEGORIES) }]
        };
      }
      if (params.vertical === "marketplace") {
        return {
          content: [{ type: "text", text: formatCategories("Marketplace", MARKETPLACE_CATEGORIES) }]
        };
      }
      if (params.vertical === "cars") {
        return {
          content: [
            {
              type: "text",
              text: `## Cars Categories

- **gebrauchtwagenboerse** (Used cars): Main car search category

Use "willhaben_search_cars" with make, model, and other filters for detailed car searches.`
            }
          ]
        };
      }
      if (params.vertical === "jobs") {
        return {
          content: [
            {
              type: "text",
              text: `## Jobs Categories

Jobs on willhaben.at can be searched with keyword and location filters.
Use "willhaben_search_jobs" with keyword and job_type parameters.

Job types: Vollzeit, Teilzeit, etc.`
            }
          ]
        };
      }
      return {
        content: [{ type: "text", text: `Unknown vertical: ${params.vertical}` }],
        isError: true
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error getting categories: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  }
);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Willhaben MCP server running on stdio");
}
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
//# sourceMappingURL=index.js.map