# ImmoScout24.at MCP server + apt-hunter dedup/report tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a home-built `immoscout-mcp` MCP server for immobilienscout24.at and an `apt-hunter` CLI that queries both `willhaben-mcp` and `immoscout-mcp`, cross-source dedupes listings, and renders a self-contained static HTML report; rewrite the `apartment-hunt` skill to shell out to `apt-hunter`.

**Architecture:** Two new npm packages in the repo (renamed `austria-apartment-hunt`): `immoscout-mcp/` (Node/TypeScript MCP server over stdio, extracts `window.__INITIAL_STATE__` / `window.__APOLLO_STATE__` JSON blobs from server-rendered pages) and `apt-hunter/` (MCP *client* CLI that spawns both servers over stdio, normalizes both result sets into one `NormalizedListing` shape, dedupes via coordinate+price+area scoring, and renders one static HTML file). The `apartment-hunt` skill becomes a thin wrapper that runs the CLI via Bash and summarizes its stdout JSON.

**Tech Stack:** Node.js ≥ 18 (built-in global `fetch`, `node:test`), TypeScript (strict, ESM `NodeNext`), `@modelcontextprotocol/sdk` + `zod`, `tsx` (dev, test runner loader), `tsc` (build). No other runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-26-immoscout-apt-hunter-design.md` (same directory as this plan's `../specs/`).

## Global Constraints

- Rent-only, apartments-only (`wohnung-mieten`), Vienna-only (`/regional/wien/wien/...`) for this iteration.
- The ImmoScout24 `zipCode` query param **does not filter** (verified) — never use it; district filtering is always client-side by parsing the postal code out of `addressString`.
- Minimum ~700 ms between HTTP requests to immobilienscout24.at; hard page-scan cap of 10 per search call; reuse one cookie jar across requests within a run (transient 401s occur without it).
- Honest User-Agent: `Mozilla/5.0 (Macintosh; personal apartment search tool)` — do not impersonate a specific browser version, do not spoof a bot identity.
- Non-200 responses (after retry) or failed JSON extraction must throw a clear, specific error — never silently return an empty list.
- TypeScript `strict: true`, ESM (`"type": "module"`, `module: "NodeNext"`); relative imports in TS use `.js` extensions.
- Tests: `node:test` + `assert/strict`, run via `node --import tsx --test test/*.test.ts`. Build: `tsc` to `dist/`.
- `apt-hunter/reports/` is gitignored.
- Personal, non-commercial, occasional use only; both packages carry/mirror the DISCLAIMER posture.

## Grounded wire-format reference (verified by live probes 2026-07-26)

These facts were captured by driving the real servers/sites. The code in this plan is written against them; the test fixtures below use the real captured shapes.

**willhaben-mcp** (`npx -y willhaben-mcp`, MCP over stdio, newline-delimited JSON-RPC):
- `willhaben_search_real_estate` returns `content[0].text` as formatted text. Header: `Found **178** listings (showing 2 of 2 per page, page 1)`. Each hit is one line:
  `**1. TITLE** | 💰 € 669,90 | 📍 Wien, 02. Bezirk, Leopoldstadt | 📅 2026-07-26T10:05:00Z | 🏢 Dealer | 🏷️ Omerovic Immobilien GmbH | 📐 44 m² | 🛏️ 2 rooms | 📊 € 15,22 | 🔗 https://www.willhaben.at/iad/immobilien/d/mietwohnungen/wien/wien-1020-leopoldstadt/slug-1957301869/`
  - Private sellers show `👤 Private` and **no** `🏷️` segment. Dealers show `🏢 Dealer` + `🏷️ Name`.
  - The listing **ID is the trailing number** in the URL (`...-1957301869/`); the **zip is in the URL slug** (`wien-1020-...`); the **district** is parseable from `📍 Wien, 02. Bezirk, ...`.
  - Search output has **no coordinates and no images**.
- `willhaben_get_listing({ id })` returns text containing `📍 **Coordinates:** 48.22413,16.37719`, `🏠 **Address:** 1020, Wien, 02. Bezirk, Leopoldstadt, Österreich`, `💰 **Price:** € 669,90`, `- **Living Area:** 44`, `- **Price/m²:** € 15,23`, and an `## Images (11)` section followed by image URLs (only ~5 shown, then `... and 6 more`).
- Tool params: `property_type: "mietwohnung"`, `action: "rent"`, `location: "Wien"`, `price_from`, `price_to`, `area_from`, `area_to`, `rooms`, `sort` (`price_asc`, `newest`), `rows` (cap 100), `page`.

**immobilienscout24.at** (server-rendered HTML):
- Search page `window.__INITIAL_STATE__` parses as JSON after replacing bare `undefined` tokens with `null`. Result data at `reduxAsyncConnect.pageData.results`: `totalHits` (number), `pagination.totalPages`, `hits[15]`.
- Hit fields (all verified): `exposeId` (string, e.g. `"6a54c34012034290294fa002"`), `headline`, `addressString` (e.g. `"Speisingerstraße, 1130 Wien"`, or just `"1090 Wien"`), `primaryPrice` (number), `primaryArea` (number), `numberOfRooms`, `isPrivate` (bool), `isSocialHousing` (bool), `badges: [{label, value}]`, `dateCreated` (ISO), `links.absoluteURL`, `primaryPictureImageProps.src` (thumbnail URL), `pricePerSqmKeyFact.value` (e.g. `"15,28 €/m²"`).
- `location` has **three variants**: `{"type":"POINT","lat":…,"lon":…}`, `{"type":"CIRCLE","lat":…,"lon":…,"radius":…}`, and `{"type":"SHAPE_ID","shapeId":…}` (**no coordinates**). Normalize POINT/CIRCLE to lat/lon; SHAPE_ID → null.
- Pagination: page 2+ at `/regional/wien/wien/wohnung-mieten/seite-N?<query>`; 15 results/page. Working filter params (verified): `primaryPriceFrom/To`, `primaryAreaFrom/To`, `numberOfRoomsFrom/To`.
- Expose page `/expose/{id}`: `window.__APOLLO_STATE__` → entity `Expose:{id}` with `description.title`, `description.descriptionNote` (HTML), `addressString`, `localization.address` (`{city, countryCode, street, streetNumber, zip}`), `localization.information.floor`, `localization.transit` (**null in the verified listing** — extract defensively), `priceInformation.primaryPrice`, `priceInformation.prices.rentPerSquareMeter`, `costs.oneTime[]`/`costs.running[]` (`{text, label, price}` — e.g. text `"Kaution: 2.200,00 €"`), `contact.fullName`/`contact.company.name`/`contact.contactPhone`, `condition.heatingTypes[].label`, `condition.energyCertification.heatingDemandClass.label`, `fitting.lift[]`, `fitting.kitchen[]`, `fitting.numberOfParkingSpaces`, `object.availableFrom`/`object.rentalPeriod`/`object.rentalPeriodType`, `area.numberOfRooms`/`area.livingArea`, `keyfacts.floorLabel`, `pictures[]` (`{url, title, caption}`). **No lat/lon on the expose page** — coordinates come only from search hits.

**Plan-level refinement over the spec (necessary, grounded in the probes):** willhaben *search* output carries neither coordinates nor images, but `apt-hunter`'s dedupe needs coordinates and the report needs photos. So `apt-hunter` adds an **enrichment step**: after district-filtering, call `willhaben_get_listing` for each remaining willhaben hit (bounded, sequential) to fill `lat`/`lon`/`images`. This is the only deviation from the spec's pipeline; everything else follows it.

---

### Task 1: Scaffold `immoscout-mcp` + `parse.ts` (embedded-JSON extractor)

**Files:**
- Create: `immoscout-mcp/package.json`
- Create: `immoscout-mcp/tsconfig.json`
- Create: `immoscout-mcp/src/parse.ts`
- Test: `immoscout-mcp/test/parse.test.ts`
- Modify: `.gitignore` (add `node_modules/`, `dist/`, `apt-hunter/reports/`)

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeJsObjectLiteral(raw: string): string`; `extractEmbeddedJson(source: string, marker: string): unknown` (throws `Error` with a specific message when the marker is missing, no `{` follows, the literal is unbalanced, or JSON parsing fails).

- [ ] **Step 1: Scaffold the package**

`immoscout-mcp/package.json`:
```json
{
  "name": "immoscout-mcp",
  "version": "0.1.0",
  "description": "Unofficial MCP server for immobilienscout24.at (personal, non-commercial use)",
  "type": "module",
  "main": "dist/index.js",
  "bin": { "immoscout-mcp": "dist/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "node --import tsx --test test/*.test.ts",
    "dev": "tsx src/index.ts"
  },
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0"
  }
}
```

`immoscout-mcp/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src"]
}
```

`.gitignore` at repo root — replace/create with:
```
node_modules/
dist/
apt-hunter/reports/
```

Run `npm install` in `immoscout-mcp/`.

- [ ] **Step 2: Write the failing test**

`immoscout-mcp/test/parse.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEmbeddedJson, normalizeJsObjectLiteral } from '../src/parse.js';

test('normalizeJsObjectLiteral replaces bare undefined tokens with null', () => {
  assert.equal(
    normalizeJsObjectLiteral('{"a": undefined, "b": [undefined, 1], "c": "undefined"}'),
    '{"a": null, "b": [null, 1], "c": "undefined"}',
  );
});

test('extractEmbeddedJson extracts a balanced object after a marker', () => {
  const html = `<html><script>window.__INITIAL_STATE__ = {"a": 1, "b": {"c": "x{y}"}};</script></html>`;
  assert.deepEqual(extractEmbeddedJson(html, 'window.__INITIAL_STATE__'), { a: 1, b: { c: 'x{y}' } });
});

test('extractEmbeddedJson ignores braces inside strings and escaped quotes', () => {
  const html = `window.__APOLLO_STATE__ = {"t": "a \\"quoted\\" } brace", "n": undefined};`;
  assert.deepEqual(extractEmbeddedJson(html, 'window.__APOLLO_STATE__'), {
    t: 'a "quoted" } brace',
    n: null,
  });
});

test('extractEmbeddedJson throws a specific error when the marker is absent', () => {
  assert.throws(() => extractEmbeddedJson('<html></html>', 'window.__INITIAL_STATE__'), /marker not found/);
});

test('extractEmbeddedJson throws on an unbalanced literal', () => {
  assert.throws(() => extractEmbeddedJson('window.X = {"a": 1', 'window.X'), /unbalanced/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd immoscout-mcp && npm test`
Expected: FAIL — `Cannot find module '../src/parse.js'`.

- [ ] **Step 4: Implement `parse.ts`**

`immoscout-mcp/src/parse.ts`:
```ts
/**
 * ImmoScout24 embeds page data as JavaScript object literals assigned to
 * window.__INITIAL_STATE__ / window.__APOLLO_STATE__. These are *almost* JSON
 * but contain bare `undefined` tokens, which JSON.parse rejects.
 */

/** Replace bare `undefined` tokens (valid JS, invalid JSON) with `null`. */
export function normalizeJsObjectLiteral(raw: string): string {
  return raw.replace(/([:,\[])\s*undefined\s*(?=[,}\]])/g, '$1null');
}

/**
 * Extract the object literal assigned to `marker` (e.g. "window.__INITIAL_STATE__")
 * from an HTML source string and parse it as JSON after normalization.
 * Brace-matching is string-aware: braces inside "…" strings and escaped quotes
 * do not affect the depth count. Throws a specific Error on any failure —
 * callers must never silently treat a changed page structure as "no results".
 */
export function extractEmbeddedJson(source: string, marker: string): unknown {
  const markerIdx = source.indexOf(marker);
  if (markerIdx < 0) throw new Error(`marker not found in page: ${marker}`);
  const eq = source.indexOf('=', markerIdx + marker.length);
  const start = eq < 0 ? -1 : source.indexOf('{', eq);
  if (start < 0) throw new Error(`no object literal after marker: ${marker}`);

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) throw new Error(`unbalanced object literal after marker: ${marker}`);

  const raw = source.slice(start, end);
  try {
    return JSON.parse(normalizeJsObjectLiteral(raw));
  } catch (err) {
    throw new Error(`failed to parse JSON after marker ${marker}: ${(err as Error).message}`);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd immoscout-mcp && npm test`
Expected: PASS, 5/5.

- [ ] **Step 6: Commit**

```bash
git add immoscout-mcp .gitignore
git commit -m "feat(immoscout-mcp): scaffold package, add embedded-JSON extractor"
```

---

### Task 2: `fetcher.ts` (HTTP + cookie jar + rate limiting + retry)

**Files:**
- Create: `immoscout-mcp/src/fetcher.ts`
- Test: `immoscout-mcp/test/fetcher.test.ts`

**Interfaces:**
- Consumes: nothing (uses global `fetch`, Node ≥ 18).
- Produces: `FetcherOptions { minIntervalMs?: number; maxRetries?: number; userAgent?: string; sleep?: (ms: number) => Promise<void> }`; `class Fetcher { constructor(opts?: FetcherOptions); fetchText(url: string): Promise<string> }`. `fetchText` returns the body on HTTP 2xx; stores `Set-Cookie` values in a jar and sends them on later requests; enforces ≥ `minIntervalMs` (default 700) between requests; retries 401/429/5xx up to `maxRetries` (default 3) with linear backoff (`500ms * attempt`); throws `Error("GET <url> failed with HTTP <status>")` otherwise.

- [ ] **Step 1: Write the failing test**

Uses a real local `node:http` server — no mocking of `fetch`.

`immoscout-mcp/test/fetcher.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Fetcher } from '../src/fetcher.js';

function startServer(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('fetchText returns body on 200', async () => {
  const { server, url } = await startServer((_req, res) => { res.writeHead(200); res.end('hello'); });
  try {
    const f = new Fetcher({ minIntervalMs: 0 });
    assert.equal(await f.fetchText(url), 'hello');
  } finally { server.close(); }
});

test('cookie jar: retries a 401 with the session cookie and succeeds', async () => {
  let calls = 0;
  const { server, url } = await startServer((req, res) => {
    calls++;
    if (req.headers.cookie?.includes('session=abc')) {
      res.writeHead(200); res.end('ok');
    } else {
      res.writeHead(401, { 'Set-Cookie': 'session=abc; Path=/' }); res.end('unauthorized');
    }
  });
  try {
    const f = new Fetcher({ minIntervalMs: 0, sleep: () => Promise.resolve() });
    assert.equal(await f.fetchText(url), 'ok');
    assert.equal(calls, 2);
  } finally { server.close(); }
});

test('throws a specific error on persistent non-200', async () => {
  const { server, url } = await startServer((_req, res) => { res.writeHead(404); res.end('nope'); });
  try {
    const f = new Fetcher({ minIntervalMs: 0, sleep: () => Promise.resolve() });
    await assert.rejects(() => f.fetchText(url), /404/);
  } finally { server.close(); }
});

test('enforces the minimum interval between requests', async () => {
  const { server, url } = await startServer((_req, res) => { res.writeHead(200); res.end('x'); });
  try {
    const f = new Fetcher({ minIntervalMs: 120 });
    const t0 = Date.now();
    await f.fetchText(url);
    await f.fetchText(url);
    assert.ok(Date.now() - t0 >= 110, `second request came too fast (${Date.now() - t0}ms)`);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd immoscout-mcp && npm test`
Expected: FAIL — `Cannot find module '../src/fetcher.js'`.

- [ ] **Step 3: Implement `fetcher.ts`**

`immoscout-mcp/src/fetcher.ts`:
```ts
export interface FetcherOptions {
  /** Minimum ms between requests (politeness). Default 700. */
  minIntervalMs?: number;
  /** Retries for transient 401/429/5xx. Default 3. */
  maxRetries?: number;
  userAgent?: string;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; personal apartment search tool)';

/**
 * Minimal HTTP fetcher for immobilienscout24.at with:
 * - a cookie jar (the site occasionally answers 401 without a persisted
 *   session cookie; reusing the jar across a run resolves this),
 * - one-request-at-a-time rate limiting (~700ms by default),
 * - bounded retry with linear backoff on transient 401/429/5xx.
 * Never swallows non-200 responses: throws a specific error instead.
 */
export class Fetcher {
  private readonly cookies = new Map<string, string>();
  private lastRequestAt = 0;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: FetcherOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 700;
    this.maxRetries = opts.maxRetries ?? 3;
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async fetchText(url: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await fetch(url, {
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml',
          ...(this.cookieHeader() ? { cookie: this.cookieHeader()! } : {}),
        },
        redirect: 'follow',
      });
      this.storeCookies(res.headers.getSetCookie?.() ?? []);
      if (res.ok) return res.text();

      const transient = res.status === 401 || res.status === 429 || res.status >= 500;
      if (!transient || attempt >= this.maxRetries) {
        throw new Error(`GET ${url} failed with HTTP ${res.status}`);
      }
      await this.sleep(500 * (attempt + 1));
    }
  }

  private async throttle(): Promise<void> {
    const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private cookieHeader(): string | null {
    if (this.cookies.size === 0) return null;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private storeCookies(setCookies: string[]): void {
    for (const sc of setCookies) {
      const pair = sc.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd immoscout-mcp && npm test`
Expected: PASS, all tests (parse 5/5 + fetcher 4/4).

- [ ] **Step 5: Commit**

```bash
git add immoscout-mcp/src/fetcher.ts immoscout-mcp/test/fetcher.test.ts
git commit -m "feat(immoscout-mcp): HTTP fetcher with cookie jar, rate limiting, retry"
```

---

### Task 3: `types.ts` + `search.ts` (URL building, page parsing, district filtering)

**Files:**
- Create: `immoscout-mcp/src/types.ts`
- Create: `immoscout-mcp/src/search.ts`
- Test: `immoscout-mcp/test/search.test.ts`

**Interfaces:**
- Consumes: `extractEmbeddedJson` from `./parse.js`; `Fetcher` from `./fetcher.js`.
- Produces (used by `index.ts` in Task 5 and mirrored by apt-hunter's normalize step):
  - `ImmoscoutSearchHit` — `{ exposeId: string; title: string; price: number | null; pricePerSqm: number | null; area: number | null; rooms: number | null; district: number | null; zip: string | null; address: string | null; lat: number | null; lon: number | null; badges: string[]; isPrivate: boolean; isSocialHousing: boolean; url: string; imageUrl: string | null; dateCreated: string | null }`
  - `ImmoscoutSearchResult` — `{ listings: ImmoscoutSearchHit[]; totalHitsCitywide: number; pagesScanned: number; totalPagesAvailable: number; hitPageCap: boolean }`
  - `SearchParams` — `{ priceFrom?: number; priceTo?: number; areaFrom?: number; areaTo?: number; roomsFrom?: number; roomsTo?: number; districts?: number[]; maxPages?: number }`
  - `buildSearchUrl(params: SearchParams, page: number): string`
  - `parseZipDistrict(addressString: string | null): { zip: string | null; district: number | null }`
  - `parseSearchPage(html: string): { hits: ImmoscoutSearchHit[]; totalHits: number; totalPages: number }`
  - `searchRealEstate(fetcher: Fetcher, params: SearchParams): Promise<ImmoscoutSearchResult>`

- [ ] **Step 1: Write the failing test**

`immoscout-mcp/test/search.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, parseZipDistrict, parseSearchPage, searchRealEstate } from '../src/search.js';
import { Fetcher } from '../src/fetcher.js';

test('buildSearchUrl: page 1 without /seite- suffix, filters as query params', () => {
  const url = buildSearchUrl({ priceTo: 700, areaFrom: 30, roomsFrom: 1, roomsTo: 3 }, 1);
  assert.equal(
    url,
    'https://www.immobilienscout24.at/regional/wien/wien/wohnung-mieten'
      + '?primaryPriceTo=700&primaryAreaFrom=30&numberOfRoomsFrom=1&numberOfRoomsTo=3',
  );
});

test('buildSearchUrl: page 2+ uses /seite-N path suffix', () => {
  const url = buildSearchUrl({ priceFrom: 400 }, 3);
  assert.equal(
    url,
    'https://www.immobilienscout24.at/regional/wien/wien/wohnung-mieten/seite-3?primaryPriceFrom=400',
  );
});

test('buildSearchUrl: never emits a zipCode param (verified non-functional server-side)', () => {
  assert.ok(!buildSearchUrl({ districts: [1, 2, 3] }, 1).includes('zipCode'));
});

test('parseZipDistrict extracts Vienna zip and district from addressString', () => {
  assert.deepEqual(parseZipDistrict('Speisingerstraße, 1130 Wien'), { zip: '1130', district: 13 });
  assert.deepEqual(parseZipDistrict('Marktgasse 56, 1090 Wien'), { zip: '1090', district: 9 });
  assert.deepEqual(parseZipDistrict('1020 Wien'), { zip: '1020', district: 2 });
  assert.deepEqual(parseZipDistrict(null), { zip: null, district: null });
  assert.deepEqual(parseZipDistrict('Some Street'), { zip: null, district: null });
});

// Trimmed real page structure captured 2026-07-26 (two hits: one POINT, one SHAPE_ID location).
const FIXTURE_PAGE = `<html><script>window.__INITIAL_STATE__ = {"reduxAsyncConnect":{"pageData":{"results":{
  "totalHits":64,"pagination":{"totalPages":3},
  "hits":[
    {"exposeId":"6a648116abc","headline":"POINT HIT","addressString":"Oswaldgasse 28, 1120 Wien",
     "primaryPrice":550,"primaryArea":36,"numberOfRooms":1,"isPrivate":false,"isSocialHousing":false,
     "badges":[{"label":"Provisionsfrei","value":"FREE_OF_COMMISSION"}],
     "location":{"type":"POINT","lat":48.1686136,"lon":16.3255059},
     "dateCreated":"2026-07-13T10:51:44.174Z",
     "links":{"absoluteURL":"https://www.immobilienscout24.at/expose/6a648116abc"},
     "primaryPictureImageProps":{"src":"https://pictures.immobilienscout24.de/thumb.webp"},
     "pricePerSqmKeyFact":{"value":"15,28 €/m²"}},
    {"exposeId":"6a6192dfxyz","headline":"SHAPE HIT","addressString":"1090 Wien",
     "primaryPrice":620,"primaryArea":41,"numberOfRooms":2,"isPrivate":true,"isSocialHousing":true,
     "badges":[],"location":{"type":"SHAPE_ID","shapeId":"1040009001009"},
     "dateCreated":null,"links":{},"primaryPictureImageProps":null,"pricePerSqmKeyFact":null}
  ]}}}};</script></html>`;

test('parseSearchPage maps hits incl. POINT/SHAPE_ID location variants', () => {
  const page = parseSearchPage(FIXTURE_PAGE);
  assert.equal(page.totalHits, 64);
  assert.equal(page.totalPages, 3);
  assert.equal(page.hits.length, 2);

  const [point, shape] = page.hits;
  assert.equal(point.exposeId, '6a648116abc');
  assert.equal(point.price, 550);
  assert.equal(point.area, 36);
  assert.equal(point.rooms, 1);
  assert.equal(point.district, 12);
  assert.equal(point.zip, '1120');
  assert.equal(point.lat, 48.1686136);
  assert.equal(point.lon, 16.3255059);
  assert.deepEqual(point.badges, ['FREE_OF_COMMISSION']);
  assert.equal(point.isPrivate, false);
  assert.equal(point.url, 'https://www.immobilienscout24.at/expose/6a648116abc');
  assert.equal(point.imageUrl, 'https://pictures.immobilienscout24.de/thumb.webp');
  assert.equal(point.pricePerSqm, 15.28);

  assert.equal(shape.lat, null);
  assert.equal(shape.lon, null);
  assert.equal(shape.district, 9);
  assert.equal(shape.isPrivate, true);
  assert.equal(shape.isSocialHousing, true);
  assert.equal(shape.url, 'https://www.immobilienscout24.at/expose/6a6192dfxyz');
  assert.equal(shape.imageUrl, null);
  assert.equal(shape.pricePerSqm, null);
});

test('parseSearchPage throws (not empty) when the page structure changed', () => {
  assert.throws(() => parseSearchPage('<html>no state here</html>'), /marker not found/);
  assert.throws(
    () => parseSearchPage('<script>window.__INITIAL_STATE__ = {"reduxAsyncConnect":{"pageData":{}}};</script>'),
    /structure changed/,
  );
});

function fakeFetcher(pages: string[]): Fetcher {
  const f = new Fetcher({ minIntervalMs: 0 });
  let i = 0;
  f.fetchText = () => Promise.resolve(pages[Math.min(i++, pages.length - 1)]);
  return f;
}

test('searchRealEstate filters districts client-side and reports page-cap state', async () => {
  const res = await searchRealEstate(fakeFetcher([FIXTURE_PAGE]), { districts: [9], maxPages: 1 });
  assert.equal(res.listings.length, 1);
  assert.equal(res.listings[0].exposeId, '6a6192dfxyz');
  assert.equal(res.totalHitsCitywide, 64);
  assert.equal(res.pagesScanned, 1);
  assert.equal(res.totalPagesAvailable, 3);
  assert.equal(res.hitPageCap, true); // more pages existed but maxPages=1 stopped the scan
});

test('searchRealEstate without districts keeps every hit', async () => {
  const res = await searchRealEstate(fakeFetcher([FIXTURE_PAGE]), { maxPages: 1 });
  assert.equal(res.listings.length, 2);
  assert.equal(res.hitPageCap, true);
});

test('searchRealEstate caps maxPages at 10', async () => {
  const singlePage = `<script>window.__INITIAL_STATE__ = {"reduxAsyncConnect":{"pageData":{"results":{"totalHits":0,"pagination":{"totalPages":99},"hits":[]}}}};</script>`;
  const res = await searchRealEstate(fakeFetcher([singlePage]), { maxPages: 50 });
  assert.equal(res.pagesScanned, 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd immoscout-mcp && npm test`
Expected: FAIL — `Cannot find module '../src/search.js'`.

- [ ] **Step 3: Implement `types.ts` and `search.ts`**

`immoscout-mcp/src/types.ts`:
```ts
export interface ImmoscoutSearchHit {
  exposeId: string;
  title: string;
  price: number | null;
  pricePerSqm: number | null;
  area: number | null;
  rooms: number | null;
  district: number | null;
  zip: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  badges: string[];
  isPrivate: boolean;
  isSocialHousing: boolean;
  url: string;
  imageUrl: string | null;
  dateCreated: string | null;
}

export interface ImmoscoutSearchResult {
  listings: ImmoscoutSearchHit[];
  totalHitsCitywide: number;
  pagesScanned: number;
  totalPagesAvailable: number;
  /** true when the scan stopped at maxPages while more result pages existed. */
  hitPageCap: boolean;
}
```

`immoscout-mcp/src/search.ts`:
```ts
import { extractEmbeddedJson } from './parse.js';
import type { Fetcher } from './fetcher.js';
import type { ImmoscoutSearchHit, ImmoscoutSearchResult } from './types.js';

export interface SearchParams {
  priceFrom?: number;
  priceTo?: number;
  areaFrom?: number;
  areaTo?: number;
  roomsFrom?: number;
  roomsTo?: number;
  /** Vienna districts 1–23; filtered client-side (the site's zipCode param does not work). */
  districts?: number[];
  /** Default 6, hard cap 10. */
  maxPages?: number;
}

const BASE_URL = 'https://www.immobilienscout24.at/regional/wien/wien/wohnung-mieten';
const HARD_PAGE_CAP = 10;

export function buildSearchUrl(params: SearchParams, page: number): string {
  const base = page > 1 ? `${BASE_URL}/seite-${page}` : BASE_URL;
  const q = new URLSearchParams();
  if (params.priceFrom != null) q.set('primaryPriceFrom', String(params.priceFrom));
  if (params.priceTo != null) q.set('primaryPriceTo', String(params.priceTo));
  if (params.areaFrom != null) q.set('primaryAreaFrom', String(params.areaFrom));
  if (params.areaTo != null) q.set('primaryAreaTo', String(params.areaTo));
  if (params.roomsFrom != null) q.set('numberOfRoomsFrom', String(params.roomsFrom));
  if (params.roomsTo != null) q.set('numberOfRoomsTo', String(params.roomsTo));
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Vienna zips are 1XX0 where XX is the district number (1130 -> district 13). */
export function parseZipDistrict(addressString: string | null): { zip: string | null; district: number | null } {
  if (!addressString) return { zip: null, district: null };
  const m = addressString.match(/\b(1\d{3})\b/);
  if (!m) return { zip: null, district: null };
  return { zip: m[1], district: parseInt(m[1].slice(1, 3), 10) };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** "15,28 €/m²" -> 15.28 */
function parsePerSqm(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const n = parseFloat(v.replace(/[^\d,]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapHit(h: any): ImmoscoutSearchHit {
  const { zip, district } = parseZipDistrict(h.addressString ?? null);
  const loc = h.location ?? {};
  const hasCoords = (loc.type === 'POINT' || loc.type === 'CIRCLE') && typeof loc.lat === 'number';
  return {
    exposeId: String(h.exposeId),
    title: typeof h.headline === 'string' ? h.headline : '',
    price: numOrNull(h.primaryPrice),
    pricePerSqm: parsePerSqm(h.pricePerSqmKeyFact?.value),
    area: numOrNull(h.primaryArea),
    rooms: numOrNull(h.numberOfRooms),
    district,
    zip,
    address: typeof h.addressString === 'string' ? h.addressString : null,
    lat: hasCoords ? loc.lat : null,
    lon: hasCoords ? loc.lon : null,
    badges: Array.isArray(h.badges) ? h.badges.map((b: any) => b?.value).filter(Boolean) : [],
    isPrivate: h.isPrivate === true,
    isSocialHousing: h.isSocialHousing === true,
    url: h.links?.absoluteURL ?? `https://www.immobilienscout24.at/expose/${h.exposeId}`,
    imageUrl: h.primaryPictureImageProps?.src ?? null,
    dateCreated: typeof h.dateCreated === 'string' ? h.dateCreated : null,
  };
}

export function parseSearchPage(html: string): { hits: ImmoscoutSearchHit[]; totalHits: number; totalPages: number } {
  const state = extractEmbeddedJson(html, 'window.__INITIAL_STATE__') as any;
  const results = state?.reduxAsyncConnect?.pageData?.results;
  if (!results || !Array.isArray(results.hits)) {
    throw new Error(
      'ImmoScout24 search page structure changed: reduxAsyncConnect.pageData.results.hits not found',
    );
  }
  return {
    hits: results.hits.map(mapHit),
    totalHits: numOrNull(results.totalHits) ?? results.hits.length,
    totalPages: numOrNull(results.pagination?.totalPages) ?? 1,
  };
}

export async function searchRealEstate(fetcher: Fetcher, params: SearchParams): Promise<ImmoscoutSearchResult> {
  const maxPages = Math.min(params.maxPages ?? 6, HARD_PAGE_CAP);
  const matched: ImmoscoutSearchHit[] = [];
  let totalHitsCitywide = 0;
  let totalPagesAvailable = 1;
  let pagesScanned = 0;

  while (pagesScanned < maxPages && pagesScanned < totalPagesAvailable) {
    const html = await fetcher.fetchText(buildSearchUrl(params, pagesScanned + 1));
    const page = parseSearchPage(html);
    totalHitsCitywide = page.totalHits;
    totalPagesAvailable = page.totalPages;
    pagesScanned++;
    for (const hit of page.hits) {
      const districtOk =
        !params.districts || params.districts.length === 0 ||
        (hit.district != null && params.districts.includes(hit.district));
      if (districtOk) matched.push(hit);
    }
  }

  return {
    listings: matched,
    totalHitsCitywide,
    pagesScanned,
    totalPagesAvailable,
    hitPageCap: pagesScanned >= maxPages && pagesScanned < totalPagesAvailable,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd immoscout-mcp && npm test`
Expected: PASS, 11/11 in search.test.ts (and all earlier suites still green).

- [ ] **Step 5: Commit**

```bash
git add immoscout-mcp/src/types.ts immoscout-mcp/src/search.ts immoscout-mcp/test/search.test.ts
git commit -m "feat(immoscout-mcp): search URL building, page parsing, client-side district filter"
```

---

### Task 4: `listing.ts` (expose detail extraction from `__APOLLO_STATE__`)

**Files:**
- Create: `immoscout-mcp/src/listing.ts`
- Test: `immoscout-mcp/test/listing.test.ts`

**Interfaces:**
- Consumes: `extractEmbeddedJson` from `./parse.js`; `Fetcher` from `./fetcher.js`.
- Produces:
  - `ImmoscoutListingDetail` — `{ id: string; url: string; title: string | null; description: string | null; address: string | null; street: string | null; zip: string | null; price: number | null; pricePerSqm: number | null; deposit: string | null; commissionNote: string | null; contact: { name: string | null; company: string | null; phone: string | null }; heating: string | null; energyClass: string | null; lift: boolean; kitchen: boolean; parkingSpaces: number; availableFrom: string | null; rentalPeriod: string | null; floor: string | null; rooms: number | null; areaSqm: number | null; transit: string[] | null; images: { url: string; caption: string | null }[] }`
  - `parseExpose(html: string, id: string): ImmoscoutListingDetail`
  - `getListing(fetcher: Fetcher, id: string): Promise<ImmoscoutListingDetail>`

Note on `transit`: in the verified live expose, `localization.transit` was `null` (no populated example was available during planning). The extractor maps a populated array defensively (`item.text ?? item.label ?? String(item)`), covered by a synthetic fixture; the null case is covered by the real-shape fixture.

- [ ] **Step 1: Write the failing test**

`immoscout-mcp/test/listing.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpose, getListing } from '../src/listing.js';
import { Fetcher } from '../src/fetcher.js';

// Trimmed real expose entity shape captured 2026-07-26 from /expose/6a54c34012034290294fa002.
const EXPOSE_FIXTURE = `<html><script>window.__APOLLO_STATE__ = {
  "Expose:abc123": {
    "__typename":"Expose","id":"abc123",
    "description":{"__typename":"Description","title":"RUHIGE SINGLE-WOHNUNG",
      "descriptionNote":"<p><b>Ruhige</b> Wohnung</p><ul><li>Küche</li></ul>"},
    "addressString":"Speisingerstraße, 1130 Wien",
    "localization":{"__typename":"Localization",
      "address":{"__typename":"Address","city":"Wien","countryCode":"AT","street":"Speisingerstraße","streetNumber":null,"zip":"1130"},
      "information":{"__typename":"LocalizationInformation","floor":0,"numberOfFloors":null},
      "transit":null},
    "priceInformation":{"__typename":"PriceInformation","primaryPrice":550,"hasCommission":false,
      "prices":{"__typename":"Prices","rentPerSquareMeter":15.28}},
    "costs":{"__typename":"Costs",
      "oneTime":[{"__typename":"CostsValue","text":"Kaution: 2.200,00 €","label":null,"price":null},
                 {"__typename":"CostsValue","text":"Provision: Gemäß Erstauftraggeberprinzip bezahlt der Abgeber die Provision.","label":null,"price":null}],
      "running":[{"__typename":"CostsValue","text":null,"label":"Monatliche Kosten","price":"550 €"}]},
    "contact":{"__typename":"Contact","fullName":"Herr Eduard Letz",
      "company":{"__typename":"ContactCompany","name":"Realbüro Sabine Steinecker"},
      "contactPhone":"+4367761470405"},
    "condition":{"__typename":"Condition","yearOfConstruction":"1960",
      "heatingTypes":[{"__typename":"AugmentedValue","label":"Zentralheizung","value":"CENTRAL"}],
      "energyCertification":{"__typename":"EnergyCertification",
        "heatingDemandClass":{"__typename":"AugmentedValue","label":"C","value":"C"}}},
    "fitting":{"__typename":"Fitting","lift":[{"__typename":"AugmentedValue","label":"Personenaufzug"}],
      "kitchen":["KITCHENETTE"],"numberOfParkingSpaces":0},
    "object":{"__typename":"ExposeObject","availableFrom":"ab 15.09.2026","rentalPeriod":"5","rentalPeriodType":"YEAR"},
    "area":{"__typename":"Area","primaryArea":36,"livingArea":36,"numberOfRooms":1},
    "keyfacts":{"__typename":"Keyfacts","floorLabel":"Erdgeschoss"},
    "pictures":[
      {"__typename":"Picture","url":"https://pictures.immobilienscout24.de/p1","title":"Wohnschlafzimmer","caption":"Helles Zimmer"},
      {"__typename":"Picture","url":"https://pictures.immobilienscout24.de/p2","title":null,"caption":null}]
  },
  "ROOT_QUERY": {"__typename":"Query"}
};</script></html>`;

test('parseExpose extracts the full detail shape', () => {
  const d = parseExpose(EXPOSE_FIXTURE, 'abc123');
  assert.equal(d.id, 'abc123');
  assert.equal(d.url, 'https://www.immobilienscout24.at/expose/abc123');
  assert.equal(d.title, 'RUHIGE SINGLE-WOHNUNG');
  assert.equal(d.description, 'Ruhige Wohnung Küche');
  assert.equal(d.address, 'Speisingerstraße, 1130 Wien');
  assert.equal(d.street, 'Speisingerstraße');
  assert.equal(d.zip, '1130');
  assert.equal(d.price, 550);
  assert.equal(d.pricePerSqm, 15.28);
  assert.equal(d.deposit, 'Kaution: 2.200,00 €');
  assert.match(d.commissionNote!, /Provision:/);
  assert.deepEqual(d.contact, {
    name: 'Herr Eduard Letz',
    company: 'Realbüro Sabine Steinecker',
    phone: '+4367761470405',
  });
  assert.equal(d.heating, 'Zentralheizung');
  assert.equal(d.energyClass, 'C');
  assert.equal(d.lift, true);
  assert.equal(d.kitchen, true);
  assert.equal(d.parkingSpaces, 0);
  assert.equal(d.availableFrom, 'ab 15.09.2026');
  assert.equal(d.rentalPeriod, '5 YEAR');
  assert.equal(d.floor, 'Erdgeschoss');
  assert.equal(d.rooms, 1);
  assert.equal(d.areaSqm, 36);
  assert.equal(d.transit, null);
  assert.deepEqual(d.images, [
    { url: 'https://pictures.immobilienscout24.de/p1', caption: 'Helles Zimmer' },
    { url: 'https://pictures.immobilienscout24.de/p2', caption: null },
  ]);
});

test('parseExpose maps a populated transit array defensively', () => {
  const html = EXPOSE_FIXTURE.replace(
    '"transit":null',
    '"transit":[{"__typename":"TransitStop","text":"U4 Pilgramgasse · 4 min"}]',
  );
  assert.deepEqual(parseExpose(html, 'abc123').transit, ['U4 Pilgramgasse · 4 min']);
});

test('parseExpose throws when no Expose entity exists', () => {
  assert.throws(
    () => parseExpose('<script>window.__APOLLO_STATE__ = {"ROOT_QUERY":{}};</script>', 'x'),
    /no Expose:/,
  );
});

test('getListing fetches the expose URL and parses it', async () => {
  const f = new Fetcher({ minIntervalMs: 0 });
  let seenUrl = '';
  f.fetchText = (url: string) => { seenUrl = url; return Promise.resolve(EXPOSE_FIXTURE); };
  const d = await getListing(f, 'abc123');
  assert.equal(seenUrl, 'https://www.immobilienscout24.at/expose/abc123');
  assert.equal(d.title, 'RUHIGE SINGLE-WOHNUNG');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd immoscout-mcp && npm test`
Expected: FAIL — `Cannot find module '../src/listing.js'`.

- [ ] **Step 3: Implement `listing.ts`**

`immoscout-mcp/src/listing.ts`:
```ts
import { extractEmbeddedJson } from './parse.js';
import type { Fetcher } from './fetcher.js';

export interface ImmoscoutListingDetail {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
  address: string | null;
  street: string | null;
  zip: string | null;
  price: number | null;
  pricePerSqm: number | null;
  deposit: string | null;
  commissionNote: string | null;
  contact: { name: string | null; company: string | null; phone: string | null };
  heating: string | null;
  energyClass: string | null;
  lift: boolean;
  kitchen: boolean;
  parkingSpaces: number;
  availableFrom: string | null;
  rentalPeriod: string | null;
  floor: string | null;
  rooms: number | null;
  areaSqm: number | null;
  transit: string[] | null;
  images: { url: string; caption: string | null }[];
}

/** Strip tags + collapse whitespace: "<p><b>Ruhige</b> Wohnung</p><ul><li>Küche</li></ul>" -> "Ruhige Wohnung Küche" */
function stripHtml(html: string | null): string | null {
  if (!html) return null;
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function findCost(costs: any, keyword: string): string | null {
  const entries = [...(costs?.oneTime ?? []), ...(costs?.running ?? [])];
  for (const c of entries) {
    if (typeof c?.text === 'string' && c.text.includes(keyword)) return c.text;
  }
  return null;
}

function mapTransit(transit: unknown): string[] | null {
  if (!Array.isArray(transit) || transit.length === 0) return null;
  return transit.map((t: any) => t?.text ?? t?.label ?? String(t));
}

export function parseExpose(html: string, id: string): ImmoscoutListingDetail {
  const state = extractEmbeddedJson(html, 'window.__APOLLO_STATE__') as any;
  const key = Object.keys(state).find((k) => k.startsWith('Expose:'));
  if (!key) {
    throw new Error('ImmoScout24 expose structure changed: no Expose:* entity in window.__APOLLO_STATE__');
  }
  const e = state[key];
  return {
    id,
    url: `https://www.immobilienscout24.at/expose/${id}`,
    title: e.description?.title ?? null,
    description: stripHtml(e.description?.descriptionNote ?? null),
    address: e.addressString ?? null,
    street: e.localization?.address?.street ?? null,
    zip: e.localization?.address?.zip ?? null,
    price: e.priceInformation?.primaryPrice ?? null,
    pricePerSqm: e.priceInformation?.prices?.rentPerSquareMeter ?? null,
    deposit: findCost(e.costs, 'Kaution'),
    commissionNote: findCost(e.costs, 'Provision'),
    contact: {
      name: e.contact?.fullName ?? null,
      company: e.contact?.company?.name ?? null,
      phone: e.contact?.contactPhone ?? null,
    },
    heating: (e.condition?.heatingTypes ?? []).map((t: any) => t?.label).filter(Boolean).join(', ') || null,
    energyClass: e.condition?.energyCertification?.heatingDemandClass?.label ?? null,
    lift: (e.fitting?.lift ?? []).length > 0,
    kitchen: (e.fitting?.kitchen ?? []).length > 0,
    parkingSpaces: e.fitting?.numberOfParkingSpaces ?? 0,
    availableFrom: e.object?.availableFrom ?? null,
    rentalPeriod: e.object?.rentalPeriod ? `${e.object.rentalPeriod} ${e.object.rentalPeriodType}` : null,
    floor: e.keyfacts?.floorLabel ?? null,
    rooms: e.area?.numberOfRooms ?? null,
    areaSqm: e.area?.livingArea ?? e.area?.primaryArea ?? null,
    transit: mapTransit(e.localization?.transit),
    images: (e.pictures ?? [])
      .filter((p: any) => typeof p?.url === 'string')
      .map((p: any) => ({ url: p.url, caption: p.caption ?? p.title ?? null })),
  };
}

export async function getListing(fetcher: Fetcher, id: string): Promise<ImmoscoutListingDetail> {
  const html = await fetcher.fetchText(`https://www.immobilienscout24.at/expose/${id}`);
  return parseExpose(html, id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd immoscout-mcp && npm test`
Expected: PASS, 4/4 in listing.test.ts, all earlier suites green.

- [ ] **Step 5: Commit**

```bash
git add immoscout-mcp/src/listing.ts immoscout-mcp/test/listing.test.ts
git commit -m "feat(immoscout-mcp): expose detail extraction from __APOLLO_STATE__"
```

---

### Task 5: `index.ts` MCP server wiring + `DISCLAIMER.md` + stdio smoke test

**Files:**
- Create: `immoscout-mcp/src/index.ts`
- Create: `immoscout-mcp/DISCLAIMER.md`
- Create: `immoscout-mcp/test/fixtures/stdio-client.mjs` (smoke harness, also reused in Task 6)

**Interfaces:**
- Consumes: `searchRealEstate` (Task 3), `getListing` (Task 4), `Fetcher` (Task 2).
- Produces: MCP server `immoscout-mcp` over stdio with tools `immoscout_search_real_estate` (params: `price_from?`, `price_to?`, `area_from?`, `area_to?`, `rooms_from?`, `rooms_to?`, `districts?: number[]`, `max_pages?` ≤ 10) returning JSON text of `ImmoscoutSearchResult`, and `immoscout_get_listing` (param: `id`) returning JSON text of `ImmoscoutListingDetail`. Tool errors are returned as MCP `isError: true` content, never as empty results.

- [ ] **Step 1: Implement `index.ts`**

(MCP wiring has no meaningful unit test; it is verified by the stdio smoke in Step 3 and the live verification in Task 6.)

`immoscout-mcp/src/index.ts`:
```ts
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Fetcher } from './fetcher.js';
import { searchRealEstate } from './search.js';
import { getListing } from './listing.js';

const server = new McpServer({ name: 'immoscout-mcp', version: '0.1.0' });
const fetcher = new Fetcher();

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
}

server.registerTool(
  'immoscout_search_real_estate',
  {
    description:
      'Search rental apartments in Vienna on immobilienscout24.at. ' +
      'District filtering (1-23) is done client-side by postal code and auto-paginates. ' +
      'Personal, non-commercial use only.',
    inputSchema: {
      price_from: z.number().optional().describe('Minimum monthly rent in EUR'),
      price_to: z.number().optional().describe('Maximum monthly rent in EUR'),
      area_from: z.number().optional().describe('Minimum living area in m²'),
      area_to: z.number().optional().describe('Maximum living area in m²'),
      rooms_from: z.number().optional(),
      rooms_to: z.number().optional(),
      districts: z.array(z.number().int().min(1).max(23)).optional()
        .describe('Vienna districts to keep, e.g. [1,2,3,4,5,6,7,8,9]'),
      max_pages: z.number().int().min(1).max(10).optional()
        .describe('Max result pages to scan (15/page, default 6, hard cap 10)'),
    },
  },
  async (args) => {
    try {
      return jsonResult(await searchRealEstate(fetcher, {
        priceFrom: args.price_from,
        priceTo: args.price_to,
        areaFrom: args.area_from,
        areaTo: args.area_to,
        roomsFrom: args.rooms_from,
        roomsTo: args.rooms_to,
        districts: args.districts,
        maxPages: args.max_pages,
      }));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  'immoscout_get_listing',
  {
    description: 'Get full detail for one immobilienscout24.at listing by exposeId.',
    inputSchema: {
      id: z.string().describe('The exposeId from immoscout_search_real_estate results'),
    },
  },
  async ({ id }) => {
    try {
      return jsonResult(await getListing(fetcher, id));
    } catch (err) {
      return errorResult(err);
    }
  },
);

await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: Write `DISCLAIMER.md`**

`immoscout-mcp/DISCLAIMER.md`:
```markdown
# Disclaimer — immoscout-mcp

`immoscout-mcp` is an unofficial, independent project. It is **not affiliated
with, authorized by, or endorsed by** ImmoScout24 / Scout24. "ImmoScout24" and
related marks belong to their owners and are used only for identification.

## Use posture

- **Personal, non-commercial, occasional use only** — e.g. one person searching
  for their own apartment.
- **Not** for bulk harvesting, mirroring, building a derivative dataset,
  commercial resale of listing data, or contacting advertisers at scale.
- You are solely responsible for complying with immobilienscout24.at's terms,
  `robots.txt`, and applicable law (Austrian/EU unfair competition, copyright,
  database rights, GDPR — listings can contain personal data such as advertiser
  names and phone numbers).

## Site posture (as observed 2026-07-26)

`robots.txt` on immobilienscout24.at only disallows two SEO bots (`MJ12bot`,
`AhrefsBot`) from `/expose` and does not forbid general automated access the
way willhaben's does; no general Terms-of-Use page prohibiting scraping was
found (only provider AGB, accessibility, privacy, and AI-info pages). Despite
this more permissive posture, this tool deliberately keeps the same
conservative behavior as the willhaben setup: ~700ms minimum between requests,
a hard page-scan cap of 10 per search, and an honest User-Agent.

All listing data, content, and trademarks belong to ImmoScout24 and its users.
If the site operator would prefer this project change or stop, please open an
issue and we will cooperate. This is not legal advice — if in doubt, consult a
qualified lawyer and/or contact ImmoScout24.

Provided "AS IS", no warranty, no liability. See `LICENSE` (MIT) at the repo
root; the MIT license covers this software only and grants no rights to
ImmoScout24's content, data, trademarks, or services.
```

- [ ] **Step 3: Stdio smoke test (offline, real protocol)**

Write `immoscout-mcp/test/fixtures/stdio-client.mjs` — a reusable MCP stdio client used here and in Task 6:
```js
#!/usr/bin/env node
// Usage: node test/fixtures/stdio-client.mjs <server-cmd...> -- <tool> <json-args>
// Spawns the MCP server, calls one tool, prints the text content to stdout.
import { spawn } from 'node:child_process';

const sep = process.argv.indexOf('--');
const serverCmd = process.argv.slice(2, sep);
const [tool, jsonArgs] = process.argv.slice(sep + 1);

const proc = spawn(serverCmd[0], serverCmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let id = 0;
function send(method, params) {
  const msg = { jsonrpc: '2.0', id: ++id, method, params };
  proc.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => rej(new Error('timeout waiting for response id ' + id)), 120000);
  });
}
proc.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } catch { /* not JSON — ignore */ }
  }
});

await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'stdio-smoke', version: '0.0.1' },
});
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const res = await send('tools/call', { name: tool, arguments: JSON.parse(jsonArgs) });
console.log(res.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(res));
if (res.result?.isError) process.exitCode = 1;
proc.kill();
```

Build, then list tools implicitly by calling with a bad name and expecting a clean MCP-level error (proves the server boots and speaks the protocol):
```bash
cd immoscout-mcp && npm run build
node test/fixtures/stdio-client.mjs node dist/index.js -- immoscout_search_real_estate '{"max_pages":1,"price_to":1}'
```
Expected: the server responds over stdio. With `price_to: 1` the call either returns `{"listings": [], ...}` shaped JSON (a valid empty filter result from the site) or an `isError` with a specific message — both prove protocol + tool wiring. A hang, a crash, or a non-JSON-RPC response is a FAIL.

- [ ] **Step 4: Commit**

```bash
git add immoscout-mcp/src/index.ts immoscout-mcp/DISCLAIMER.md immoscout-mcp/test/fixtures/stdio-client.mjs
git commit -m "feat(immoscout-mcp): MCP server entrypoint with both tools, disclaimer, stdio smoke harness"
```

---

### Task 6: Live verification of `immoscout-mcp` against immobilienscout24.at

**Files:**
- Modify: none (uses `immoscout-mcp/test/fixtures/stdio-client.mjs` from Task 5)

**Interfaces:**
- Consumes: the built `immoscout-mcp/dist/index.js` (Task 5).
- Produces: confirmation recorded in the repo README's "Verified behavior" section (updated in Task 15).

This is a required gate per the project's existing "Verified behavior" convention: drive the server over real stdio JSON-RPC against the live site, don't just trust the unit fixtures.

- [ ] **Step 1: Live search**

```bash
cd immoscout-mcp
node test/fixtures/stdio-client.mjs node dist/index.js -- immoscout_search_real_estate \
  '{"price_to":700,"area_from":30,"districts":[1,2,3,4,5,6,7,8,9],"max_pages":3}'
```
Expected: JSON with `listings` whose every entry has `district` ∈ 1–9 (or `null` district hits excluded), real current titles, numeric `price` ≤ 700, `area` ≥ 30, a full `address`, `url` starting `https://www.immobilienscout24.at/expose/`, plus `totalHitsCitywide`, `pagesScanned`, `totalPagesAvailable`, `hitPageCap`. Note: `lat`/`lon` are `null` on `SHAPE_ID`-location hits — that is expected, not a bug.

- [ ] **Step 2: Live listing detail**

Pick the first `exposeId` from Step 1 and run:
```bash
node test/fixtures/stdio-client.mjs node dist/index.js -- immoscout_get_listing '{"id":"<exposeId>"}'
```
Expected: JSON with `title`, `price`, `address`, `zip`, `contact.name`/`company`, `images` (non-empty array of `{url, caption}`), and no crash on `transit: null`.

- [ ] **Step 3: Record the outcome**

Keep the two raw outputs (paste into the commit message or a scratch note) — Task 15 folds the confirmation into the README's "Verified behavior" section. If the site structure changed since planning (extraction errors), STOP and fix `parse.ts`/`search.ts`/`listing.ts` against the new live markup before continuing — later tasks depend on these shapes.

```bash
git commit --allow-empty -m "test(immoscout-mcp): live stdio verification against immobilienscout24.at"
```

---

### Task 7: Scaffold `apt-hunter` + `mcp-client.ts` (generic stdio MCP client)

**Files:**
- Create: `apt-hunter/package.json`
- Create: `apt-hunter/tsconfig.json`
- Create: `apt-hunter/src/mcp-client.ts`
- Test: `apt-hunter/test/mcp-client.test.ts`
- Create: `apt-hunter/test/fixtures/echo-server.ts` (minimal MCP server used by the test)

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk` client side.
- Produces: `McpServerSpec { command: string; args: string[] }`; `class McpConnection { constructor(spec: McpServerSpec); connect(): Promise<void>; callToolText(tool: string, args: Record<string, unknown>): Promise<string>; close(): Promise<void> }`. `callToolText` joins all `text` content parts with `\n` and throws `Error("<tool> failed: <text>")` when the result has `isError`. One connection is kept open for many calls (apt-hunter makes ~dozens of `willhaben_get_listing` calls per run; a process per call would be far too slow).

- [ ] **Step 1: Scaffold the package**

`apt-hunter/package.json`:
```json
{
  "name": "apt-hunter",
  "version": "0.1.0",
  "description": "Multi-source Vienna apartment hunt: willhaben + immobilienscout24, dedup, static HTML report",
  "type": "module",
  "main": "dist/cli.js",
  "bin": { "apt-hunter": "dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "test": "node --import tsx --test test/*.test.ts",
    "dev": "tsx src/cli.ts"
  },
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0"
  }
}
```

`apt-hunter/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src"]
}
```

Run `npm install` in `apt-hunter/`.

- [ ] **Step 2: Write the failing test + echo server fixture**

`apt-hunter/test/fixtures/echo-server.ts`:
```ts
#!/usr/bin/env node
// Minimal MCP server for testing apt-hunter's client: echoes tool args back as text,
// and returns isError for the tool name "fail".
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '0.0.1' });
server.registerTool('echo', { inputSchema: { msg: z.string() } }, async ({ msg }) => ({
  content: [{ type: 'text' as const, text: `echo:${msg}` }],
}));
server.registerTool('fail', { inputSchema: {} }, async () => ({
  content: [{ type: 'text' as const, text: 'boom' }],
  isError: true,
}));
await server.connect(new StdioServerTransport());
```

`apt-hunter/test/mcp-client.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { McpConnection } from '../src/mcp-client.js';

const ECHO = fileURLToPath(new URL('./fixtures/echo-server.ts', import.meta.url));
// Run the fixture server through tsx (it is TypeScript).
const spec = { command: 'npx', args: ['tsx', ECHO] };

test('callToolText round-trips over stdio and reuses the connection', async () => {
  const conn = new McpConnection(spec);
  await conn.connect();
  try {
    assert.equal(await conn.callToolText('echo', { msg: 'one' }), 'echo:one');
    assert.equal(await conn.callToolText('echo', { msg: 'two' }), 'echo:two');
  } finally {
    await conn.close();
  }
});

test('callToolText throws on isError results', async () => {
  const conn = new McpConnection(spec);
  await conn.connect();
  try {
    await assert.rejects(() => conn.callToolText('fail', {}), /fail failed: boom/);
  } finally {
    await conn.close();
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apt-hunter && npm test`
Expected: FAIL — `Cannot find module '../src/mcp-client.js'`.

- [ ] **Step 4: Implement `mcp-client.ts`**

`apt-hunter/src/mcp-client.ts`:
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpServerSpec {
  command: string;
  args: string[];
}

/**
 * A single persistent stdio connection to an MCP server.
 * apt-hunter keeps one connection per source open for the whole run —
 * enrichment makes dozens of willhaben_get_listing calls and spawning one
 * `npx` process per call would dominate runtime.
 */
export class McpConnection {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;

  constructor(spec: McpServerSpec) {
    this.transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      stderr: 'inherit',
    });
    this.client = new Client({ name: 'apt-hunter', version: '0.1.0' });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  /** Call a tool and return its joined text content; throws when isError is set. */
  async callToolText(tool: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.client.callTool({ name: tool, arguments: args });
    const parts = (res.content ?? []) as { type: string; text?: string }[];
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
    if (res.isError) throw new Error(`${tool} failed: ${text}`);
    return text;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apt-hunter && npm test`
Expected: PASS, 2/2.

- [ ] **Step 6: Commit**

```bash
git add apt-hunter
git commit -m "feat(apt-hunter): scaffold package, generic stdio MCP client"
```

---

### Task 8: `normalize.ts` (both sources → `NormalizedListing`)

**Files:**
- Create: `apt-hunter/src/normalize.ts`
- Test: `apt-hunter/test/normalize.test.ts`

**Interfaces:**
- Consumes: nothing (pure text/JSON parsing).
- Produces (consumed by `dedupe.ts`, `score.ts`, `report.ts`, `cli.ts`):
  - `interface NormalizedListing { source: 'willhaben' | 'immoscout'; id: string; url: string; title: string; price: number | null; pricePerSqm: number | null; area: number | null; rooms: number | null; district: number | null; zip: string | null; addressLine: string | null; lat: number | null; lon: number | null; isPrivate: boolean | null; requiresWaitlistTicket: boolean; images: string[]; dateCreated: string | null; valueFlag?: 'good' | 'fair' | 'premium' | null; alsoListedOn?: { source: string; url: string }[] }`
  - `interface WillhabenSearchHit { id: string; title: string; price: number | null; location: string | null; dateCreated: string | null; sellerType: 'private' | 'dealer' | null; sellerName: string | null; area: number | null; rooms: number | null; pricePerSqm: number | null; url: string; zip: string | null; district: number | null }`
  - `interface WillhabenDetail { lat: number | null; lon: number | null; address: string | null; images: string[]; description: string | null }`
  - `parseAustrianNumber(s: string): number | null`
  - `parseWillhabenSearchText(text: string): WillhabenSearchHit[]`
  - `parseWillhabenDetailText(text: string): WillhabenDetail`
  - `normalizeWillhaben(hit: WillhabenSearchHit, detail?: WillhabenDetail): NormalizedListing`
  - `normalizeImmoscout(raw: unknown): NormalizedListing` (takes one element of the `listings` array from `immoscout_search_real_estate`'s JSON output)
  - `detectWaitlistTicket(title: string): boolean`

Design notes grounded in the probes:
- willhaben waitlist detection is keyword-based on the title (`Vormerkschein`/`Wohnticket`/`Gemeindewohnung`, case-insensitive) — the same heuristic used manually before.
- ImmoScout has a structured `isSocialHousing` flag instead of keywords; `normalizeImmoscout` maps it to `requiresWaitlistTicket` (Genossenschaft/municipal listings on ImmoScout carry the same waitlist semantics).
- ImmoScout `SHAPE_ID` hits arrive with `lat: null` — they flow through with null coords and simply cannot dedupe-match (max possible score 4 < threshold 5).

- [ ] **Step 1: Write the failing test**

`apt-hunter/test/normalize.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAustrianNumber,
  parseWillhabenSearchText,
  parseWillhabenDetailText,
  normalizeWillhaben,
  normalizeImmoscout,
  detectWaitlistTicket,
} from '../src/normalize.js';

test('parseAustrianNumber handles Austrian formats', () => {
  assert.equal(parseAustrianNumber('€ 669,90'), 669.9);
  assert.equal(parseAustrianNumber('€ 1.234,56'), 1234.56);
  assert.equal(parseAustrianNumber('€ 559'), 559);
  assert.equal(parseAustrianNumber('44 m²'), 44);
  assert.equal(parseAustrianNumber('€ 15,22'), 15.22);
  assert.equal(parseAustrianNumber('no digits'), null);
});

// Real willhaben_search_real_estate output captured 2026-07-26 (dealer + private hits).
const WH_SEARCH = `## Search Results: Mietwohnungen

Found **178** listings (showing 2 of 2 per page, page 1)
Vertical: real_estate

**1. Nächst Augarten! Sanierte Garconniere mit 2 Zimmer im 2. Liftstock** | 💰 € 669,90 | 📍 Wien, 02. Bezirk, Leopoldstadt | 📅 2026-07-26T10:05:00Z | 🏢 Dealer | 🏷️ Omerovic Immobilien GmbH | 📐 44 m² | 🛏️ 2 rooms | 📊 € 15,22 | 🔗 https://www.willhaben.at/iad/immobilien/d/mietwohnungen/wien/wien-1020-leopoldstadt/naechst-augarten-sanierte-garconniere-mit-2-zimmer-im-2-liftstock-1957301869/

**2. WG Zimmer ab sofort verfügbar, mit Dachterrassen Highlight** | 💰 € 559 | 📍 Wien, 10. Bezirk, Favoriten | 📅 2026-07-26T06:53:00Z | 👤 Private | 📐 82 m² | 🛏️ 3 rooms | 📊 € 6,82 | 🔗 https://www.willhaben.at/iad/immobilien/d/mietwohnungen/wien/wien-1100-favoriten/wg-zimmer-ab-sofort-verfuegbar-mit-dachterrassen-highlight-2104353006/`;

test('parseWillhabenSearchText parses dealer and private hit lines', () => {
  const hits = parseWillhabenSearchText(WH_SEARCH);
  assert.equal(hits.length, 2);

  const [dealer, priv] = hits;
  assert.equal(dealer.id, '1957301869');
  assert.equal(dealer.title, 'Nächst Augarten! Sanierte Garconniere mit 2 Zimmer im 2. Liftstock');
  assert.equal(dealer.price, 669.9);
  assert.equal(dealer.district, 2);
  assert.equal(dealer.zip, '1020');
  assert.equal(dealer.dateCreated, '2026-07-26T10:05:00Z');
  assert.equal(dealer.sellerType, 'dealer');
  assert.equal(dealer.sellerName, 'Omerovic Immobilien GmbH');
  assert.equal(dealer.area, 44);
  assert.equal(dealer.rooms, 2);
  assert.equal(dealer.pricePerSqm, 15.22);
  assert.match(dealer.url, /^https:\/\/www\.willhaben\.at\//);

  assert.equal(priv.id, '2104353006');
  assert.equal(priv.sellerType, 'private');
  assert.equal(priv.sellerName, null);
  assert.equal(priv.district, 10);
  assert.equal(priv.zip, '1100');
});

// Real willhaben_get_listing output shape captured 2026-07-26.
const WH_DETAIL = `# Nächst Augarten! Sanierte Garconniere mit 2 Zimmer im 2. Liftstock

💰 **Price:** € 669,90
📅 **Published:** 2026-07-26T10:05:00+0200
🔗 **URL:** https://www.willhaben.at/iad/object?adId=1957301869
🏷️ **Type:** Dealer
👤 **Seller:** Omerovic Immobilien GmbH
🏠 **Address:** 1020, Wien, 02. Bezirk, Leopoldstadt, Österreich
📍 **Coordinates:** 48.22413,16.37719
📞 **Contact:** EMAIL

## Key Details
- **Living Area:** 44
- **Price/m²:** € 15,23

## Images (11)
https://cache.willhaben.at/mmo/9/195/730/1869_105792956.jpg
https://cache.willhaben.at/mmo/9/195/730/1869_1686566767.jpg
... and 6 more`;

test('parseWillhabenDetailText extracts coordinates, address and images', () => {
  const d = parseWillhabenDetailText(WH_DETAIL);
  assert.equal(d.lat, 48.22413);
  assert.equal(d.lon, 16.37719);
  assert.equal(d.address, '1020, Wien, 02. Bezirk, Leopoldstadt, Österreich');
  assert.deepEqual(d.images, [
    'https://cache.willhaben.at/mmo/9/195/730/1869_105792956.jpg',
    'https://cache.willhaben.at/mmo/9/195/730/1869_1686566767.jpg',
  ]);
});

test('normalizeWillhaben merges search hit + detail into NormalizedListing', () => {
  const hit = parseWillhabenSearchText(WH_SEARCH)[0];
  const n = normalizeWillhaben(hit, parseWillhabenDetailText(WH_DETAIL));
  assert.equal(n.source, 'willhaben');
  assert.equal(n.id, '1957301869');
  assert.equal(n.lat, 48.22413);
  assert.equal(n.lon, 16.37719);
  assert.equal(n.images.length, 2);
  assert.equal(n.isPrivate, false);
  assert.equal(n.requiresWaitlistTicket, false);
  assert.equal(n.district, 2);
});

test('normalizeWillhaben works without detail (no coords/images)', () => {
  const n = normalizeWillhaben(parseWillhabenSearchText(WH_SEARCH)[1]);
  assert.equal(n.lat, null);
  assert.deepEqual(n.images, []);
  assert.equal(n.isPrivate, true);
});

test('detectWaitlistTicket catches municipal-housing keywords', () => {
  assert.equal(detectWaitlistTicket('Schöne Gemeindewohnung in zentraler Lage'), true);
  assert.equal(detectWaitlistTicket('Wohnung mit Vormerkschein abzugeben'), true);
  assert.equal(detectWaitlistTicket('nur mit Wiener Wohnticket!'), true);
  assert.equal(detectWaitlistTicket('Sanierte Garconniere im 2. Liftstock'), false);
});

// Real immoscout_search_real_estate JSON element shape (from immoscout-mcp Task 3 output).
const IS24_HIT = {
  exposeId: '6a648116abc',
  title: 'RUHIGE HOFSEITIGE SINGLE-ERDGESCHOSS-WOHNUNG',
  price: 550, pricePerSqm: 15.28, area: 36, rooms: 1,
  district: 12, zip: '1120', address: 'Oswaldgasse 28, 1120 Wien',
  lat: 48.1686136, lon: 16.3255059,
  badges: ['FREE_OF_COMMISSION'], isPrivate: false, isSocialHousing: false,
  url: 'https://www.immobilienscout24.at/expose/6a648116abc',
  imageUrl: 'https://pictures.immobilienscout24.de/thumb.webp',
  dateCreated: '2026-07-13T10:51:44.174Z',
};

test('normalizeImmoscout maps the immoscout-mcp JSON shape', () => {
  const n = normalizeImmoscout(IS24_HIT);
  assert.equal(n.source, 'immoscout');
  assert.equal(n.id, '6a648116abc');
  assert.equal(n.price, 550);
  assert.equal(n.district, 12);
  assert.equal(n.addressLine, 'Oswaldgasse 28, 1120 Wien');
  assert.equal(n.lat, 48.1686136);
  assert.deepEqual(n.images, ['https://pictures.immobilienscout24.de/thumb.webp']);
  assert.equal(n.requiresWaitlistTicket, false);
});

test('normalizeImmoscout flags social housing as waitlist-ticket, tolerates nulls', () => {
  const n = normalizeImmoscout({ ...IS24_HIT, isSocialHousing: true, lat: null, lon: null, imageUrl: null });
  assert.equal(n.requiresWaitlistTicket, true);
  assert.equal(n.lat, null);
  assert.deepEqual(n.images, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apt-hunter && npm test`
Expected: FAIL — `Cannot find module '../src/normalize.js'`.

- [ ] **Step 3: Implement `normalize.ts`**

`apt-hunter/src/normalize.ts`:
```ts
export interface NormalizedListing {
  source: 'willhaben' | 'immoscout';
  id: string;
  url: string;
  title: string;
  price: number | null;
  pricePerSqm: number | null;
  area: number | null;
  rooms: number | null;
  district: number | null;
  zip: string | null;
  addressLine: string | null;
  lat: number | null;
  lon: number | null;
  isPrivate: boolean | null;
  requiresWaitlistTicket: boolean;
  images: string[];
  dateCreated: string | null;
  /** Set by score.ts. */
  valueFlag?: 'good' | 'fair' | 'premium' | null;
  /** Set by dedupe.ts on merged primaries. */
  alsoListedOn?: { source: string; url: string }[];
}

export interface WillhabenSearchHit {
  id: string;
  title: string;
  price: number | null;
  location: string | null;
  dateCreated: string | null;
  sellerType: 'private' | 'dealer' | null;
  sellerName: string | null;
  area: number | null;
  rooms: number | null;
  pricePerSqm: number | null;
  url: string;
  zip: string | null;
  district: number | null;
}

export interface WillhabenDetail {
  lat: number | null;
  lon: number | null;
  address: string | null;
  images: string[];
  description: string | null;
}

/**
 * "€ 1.234,56" -> 1234.56 ; "44 m²" -> 44 ; "€ 15,22" -> 15.22.
 * Only pass price/area-style fields (dots = thousands, comma = decimal).
 */
export function parseAustrianNumber(s: string): number | null {
  const cleaned = s.replace(/[^\d.,]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const WAITLIST_RE = /vormerkschein|wohnticket|gemeindewohnung/i;

export function detectWaitlistTicket(title: string): boolean {
  return WAITLIST_RE.test(title);
}

/** "📍 Wien, 02. Bezirk, Leopoldstadt" -> 2 */
function parseBezirk(location: string | null): number | null {
  const m = location?.match(/(\d{1,2})\.\s*Bezirk/);
  return m ? parseInt(m[1], 10) : null;
}

export function parseWillhabenSearchText(text: string): WillhabenSearchHit[] {
  const hits: WillhabenSearchHit[] = [];
  // Hit lines: "**N. TITLE** | 💰 ... | 📍 ... | 📅 ... | 🏢/👤 ... | [🏷️ ...] | 📐 ... | 🛏️ ... | 📊 ... | 🔗 URL"
  const re = /^\*\*\d+\.\s*(.+?)\*\*\s*\|\s*(.+)$/gm;
  for (const m of text.matchAll(re)) {
    const title = m[1].trim();
    const parts = m[2].split('|').map((p) => p.trim());
    let price: number | null = null;
    let location: string | null = null;
    let dateCreated: string | null = null;
    let sellerType: 'private' | 'dealer' | null = null;
    let sellerName: string | null = null;
    let area: number | null = null;
    let rooms: number | null = null;
    let pricePerSqm: number | null = null;
    let url = '';
    for (const p of parts) {
      if (p.startsWith('💰')) price = parseAustrianNumber(p);
      else if (p.startsWith('📍')) location = p.slice('📍'.length).trim();
      else if (p.startsWith('📅')) dateCreated = p.slice('📅'.length).trim();
      else if (p.startsWith('🏢')) sellerType = 'dealer';
      else if (p.startsWith('👤')) sellerType = 'private';
      else if (p.startsWith('🏷️')) sellerName = p.slice('🏷️'.length).trim();
      else if (p.startsWith('📐')) area = parseAustrianNumber(p);
      else if (p.startsWith('🛏️')) rooms = parseAustrianNumber(p);
      else if (p.startsWith('📊')) pricePerSqm = parseAustrianNumber(p);
      else if (p.startsWith('🔗')) url = p.slice('🔗'.length).trim();
    }
    const zip = url.match(/wien-(\d{4})-/)?.[1] ?? null;
    const id = url.match(/-(\d+)\/?$/)?.[1] ?? '';
    if (!id || !url) continue; // not a real hit line
    hits.push({
      id, title, price, location, dateCreated, sellerType, sellerName,
      area, rooms, pricePerSqm, url, zip,
      district: parseBezirk(location),
    });
  }
  return hits;
}

export function parseWillhabenDetailText(text: string): WillhabenDetail {
  const coords = text.match(/📍 \*\*Coordinates:\*\*\s*([-\d.]+)\s*,\s*([-\d.]+)/);
  const address = text.match(/🏠 \*\*Address:\*\*\s*(.+)/);
  const images: string[] = [];
  const imgSection = text.split(/^## Images/m)[1];
  if (imgSection) {
    for (const line of imgSection.split('\n')) {
      const t = line.trim();
      if (t.startsWith('http')) images.push(t);
      else if (t.startsWith('... and') || t.startsWith('## ')) break;
    }
  }
  return {
    lat: coords ? parseFloat(coords[1]) : null,
    lon: coords ? parseFloat(coords[2]) : null,
    address: address?.[1]?.trim() ?? null,
    images,
    description: null, // free-text body is often absent on willhaben; not needed for the report
  };
}

export function normalizeWillhaben(hit: WillhabenSearchHit, detail?: WillhabenDetail): NormalizedListing {
  return {
    source: 'willhaben',
    id: hit.id,
    url: hit.url,
    title: hit.title,
    price: hit.price,
    pricePerSqm: hit.pricePerSqm,
    area: hit.area,
    rooms: hit.rooms,
    district: hit.district,
    zip: hit.zip,
    addressLine: detail?.address ?? hit.location,
    lat: detail?.lat ?? null,
    lon: detail?.lon ?? null,
    isPrivate: hit.sellerType == null ? null : hit.sellerType === 'private',
    requiresWaitlistTicket: detectWaitlistTicket(hit.title),
    images: detail?.images ?? [],
    dateCreated: hit.dateCreated,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizeImmoscout(raw: any): NormalizedListing {
  return {
    source: 'immoscout',
    id: String(raw.exposeId),
    url: raw.url ?? `https://www.immobilienscout24.at/expose/${raw.exposeId}`,
    title: raw.title ?? '',
    price: raw.price ?? null,
    pricePerSqm: raw.pricePerSqm ?? null,
    area: raw.area ?? null,
    rooms: raw.rooms ?? null,
    district: raw.district ?? null,
    zip: raw.zip ?? null,
    addressLine: raw.address ?? null,
    lat: raw.lat ?? null,
    lon: raw.lon ?? null,
    isPrivate: typeof raw.isPrivate === 'boolean' ? raw.isPrivate : null,
    requiresWaitlistTicket: raw.isSocialHousing === true,
    images: raw.imageUrl ? [raw.imageUrl] : [],
    dateCreated: raw.dateCreated ?? null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apt-hunter && npm test`
Expected: PASS, 8/8 in normalize.test.ts (mcp-client suite still green).

- [ ] **Step 5: Commit**

```bash
git add apt-hunter/src/normalize.ts apt-hunter/test/normalize.test.ts
git commit -m "feat(apt-hunter): normalize willhaben + immoscout results into NormalizedListing"
```

---

### Task 9: `dedupe.ts` (cross-source duplicate scoring/merging)

**Files:**
- Create: `apt-hunter/src/dedupe.ts`
- Test: `apt-hunter/test/dedupe.test.ts`

**Interfaces:**
- Consumes: `NormalizedListing` from `./normalize.js`.
- Produces:
  - `haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number`
  - `pairScore(a: NormalizedListing, b: NormalizedListing): number` — 0 for same-source pairs; otherwise the spec's scoring (distance <60m +3 / <150m +1; price within 3% +2 / 8% +1; area within 2m² +2 / 5m² +1)
  - `dedupeListings(listings: NormalizedListing[], threshold?: number): { merged: NormalizedListing[]; duplicatePairs: number }` — threshold default 5; union-find grouping; primary = most non-null data fields, tie → earlier `dateCreated`; absorbed listings land in the primary's `alsoListedOn`.

- [ ] **Step 1: Write the failing test**

`apt-hunter/test/dedupe.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, pairScore, dedupeListings } from '../src/dedupe.js';
import type { NormalizedListing } from '../src/normalize.js';

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
  return {
    source: 'willhaben', id: 'x', url: 'https://example.com/x', title: 'X',
    price: 600, pricePerSqm: 15, area: 40, rooms: 2,
    district: 4, zip: '1040', addressLine: null,
    lat: 48.2, lon: 16.37, isPrivate: false, requiresWaitlistTicket: false,
    images: [], dateCreated: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

test('haversineMeters: same point ~0, known distance sane', () => {
  assert.equal(haversineMeters(48.2, 16.37, 48.2, 16.37), 0);
  // ~111m per 0.001 deg latitude
  const d = haversineMeters(48.2, 16.37, 48.201, 16.37);
  assert.ok(d > 100 && d < 120, `got ${d}`);
});

test('pairScore: same source is never compared', () => {
  const a = listing({ source: 'willhaben' });
  const b = listing({ source: 'willhaben', id: 'y' });
  assert.equal(pairScore(a, b), 0);
});

test('pairScore: clear duplicate scores >= 5', () => {
  // Same flat on both sites: 10m apart, same price, same area -> 3 + 2 + 2 = 7
  const a = listing({ source: 'willhaben' });
  const b = listing({ source: 'immoscout', id: 'y', lat: 48.20005, lon: 16.37005, price: 605, area: 40.5 });
  assert.ok(pairScore(a, b) >= 5, `got ${pairScore(a, b)}`);
});

test('pairScore: clear non-duplicate scores < 5', () => {
  // 2km away, different price and area -> 0
  const a = listing({ source: 'willhaben' });
  const b = listing({ source: 'immoscout', id: 'y', lat: 48.22, lon: 16.37, price: 900, area: 60 });
  assert.ok(pairScore(a, b) < 5, `got ${pairScore(a, b)}`);
});

test('pairScore: missing coordinates caps below threshold', () => {
  // Same price + same area but one side lacks coords -> max 4, no match
  const a = listing({ source: 'willhaben', lat: null, lon: null });
  const b = listing({ source: 'immoscout', id: 'y', price: 600, area: 40 });
  assert.equal(pairScore(a, b), 4);
});

test('dedupeListings merges a matched pair, primary absorbs the other', () => {
  const willhaben = listing({
    source: 'willhaben', id: 'w1', url: 'https://willhaben.at/x',
    dateCreated: '2026-07-25T00:00:00Z', images: ['https://img/1.jpg'],
  });
  const immoscout = listing({
    source: 'immoscout', id: 'i1', url: 'https://immoscout24.at/y',
    lat: 48.20005, lon: 16.37005, price: 605, area: 40.5,
    addressLine: 'Gußhausstraße 1, 1040 Wien', // more complete: has street address
    dateCreated: '2026-07-20T00:00:00Z',
  });
  const unrelated = listing({ source: 'immoscout', id: 'i2', lat: 48.3, lon: 16.4, price: 999, area: 80 });

  const { merged, duplicatePairs } = dedupeListings([willhaben, immoscout, unrelated]);
  assert.equal(duplicatePairs, 1);
  assert.equal(merged.length, 2);
  const primary = merged.find((l) => l.alsoListedOn);
  assert.ok(primary, 'expected one merged listing with alsoListedOn');
  assert.equal(primary!.alsoListedOn!.length, 1);
  assert.deepEqual(
    [primary!.source, primary!.alsoListedOn![0].source].sort(),
    ['immoscout', 'willhaben'],
  );
  // primary is the more complete listing (immoscout: has addressLine)
  assert.equal(primary!.source, 'immoscout');
});

test('dedupeListings leaves distinct listings untouched', () => {
  const a = listing({ source: 'willhaben', id: 'w1' });
  const b = listing({ source: 'immoscout', id: 'i1', lat: 48.3, lon: 16.4, price: 999, area: 80 });
  const { merged, duplicatePairs } = dedupeListings([a, b]);
  assert.equal(duplicatePairs, 0);
  assert.equal(merged.length, 2);
  assert.ok(merged.every((l) => !l.alsoListedOn));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apt-hunter && npm test`
Expected: FAIL — `Cannot find module '../src/dedupe.js'`.

- [ ] **Step 3: Implement `dedupe.ts`**

`apt-hunter/src/dedupe.ts`:
```ts
import type { NormalizedListing } from './normalize.js';

export const DEFAULT_DEDUP_THRESHOLD = 5;

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Cross-source duplicate score. Same-source pairs always score 0 — a source
 * is assumed internally consistent, matching only ever happens across sources.
 * Without coordinates on either side the max score is 4 (< threshold), so
 * coord-less listings can never be auto-merged.
 */
export function pairScore(a: NormalizedListing, b: NormalizedListing): number {
  if (a.source === b.source) return 0;
  let score = 0;

  if (a.lat != null && a.lon != null && b.lat != null && b.lon != null) {
    const d = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    if (d < 60) score += 3;
    else if (d < 150) score += 1;
  }
  if (a.price != null && b.price != null && Math.max(a.price, b.price) > 0) {
    const rel = Math.abs(a.price - b.price) / Math.max(a.price, b.price);
    if (rel < 0.03) score += 2;
    else if (rel < 0.08) score += 1;
  }
  if (a.area != null && b.area != null) {
    const da = Math.abs(a.area - b.area);
    if (da < 2) score += 2;
    else if (da < 5) score += 1;
  }
  return score;
}

/** Rough completeness: which listing carries more usable data. */
function completeness(l: NormalizedListing): number {
  let n = 0;
  for (const v of [l.price, l.pricePerSqm, l.area, l.rooms, l.district, l.zip, l.addressLine, l.lat, l.lon, l.dateCreated]) {
    if (v != null) n++;
  }
  if (l.images.length > 0) n++;
  return n;
}

function pickPrimary(group: NormalizedListing[]): NormalizedListing {
  return [...group].sort((x, y) => {
    const c = completeness(y) - completeness(x);
    if (c !== 0) return c;
    return (x.dateCreated ?? '9999').localeCompare(y.dateCreated ?? '9999');
  })[0];
}

export function dedupeListings(
  listings: NormalizedListing[],
  threshold: number = DEFAULT_DEDUP_THRESHOLD,
): { merged: NormalizedListing[]; duplicatePairs: number } {
  // Union-find over matched pairs.
  const parent = listings.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => { parent[find(i)] = find(j); };

  for (let i = 0; i < listings.length; i++) {
    for (let j = i + 1; j < listings.length; j++) {
      if (pairScore(listings[i], listings[j]) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, NormalizedListing[]>();
  listings.forEach((l, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), l]);
  });

  const merged: NormalizedListing[] = [];
  let duplicatePairs = 0;
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const primary = pickPrimary(group);
    primary.alsoListedOn = group
      .filter((l) => l !== primary)
      .map((l) => ({ source: l.source, url: l.url }));
    duplicatePairs += group.length - 1;
    merged.push(primary);
  }
  return { merged, duplicatePairs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apt-hunter && npm test`
Expected: PASS, 7/7 in dedupe.test.ts.

- [ ] **Step 5: Commit**

```bash
git add apt-hunter/src/dedupe.ts apt-hunter/test/dedupe.test.ts
git commit -m "feat(apt-hunter): cross-source duplicate scoring and merging"
```

---

### Task 10: `score.ts` (€/m² value scoring)

**Files:**
- Create: `apt-hunter/src/score.ts`
- Test: `apt-hunter/test/score.test.ts`

**Interfaces:**
- Consumes: `NormalizedListing` from `./normalize.js`.
- Produces: `median(values: number[]): number`; `scoreValue(listings: NormalizedListing[]): void` — fills each listing's `pricePerSqm` (from price÷area when missing) and sets `valueFlag`: `'good'` when €/m² < 0.85 × median of the result set, `'premium'` when > 1.15 × median, `'fair'` otherwise, `null` when no €/m² is computable. Thresholds are a named constant `VALUE_BAND = 0.15`.

- [ ] **Step 1: Write the failing test**

`apt-hunter/test/score.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, scoreValue } from '../src/score.js';
import type { NormalizedListing } from '../src/normalize.js';

function listing(pricePerSqm: number | null, price: number | null = null, area: number | null = null): NormalizedListing {
  return {
    source: 'willhaben', id: Math.random().toString(36).slice(2), url: 'https://x', title: 'X',
    price, pricePerSqm, area, rooms: null, district: null, zip: null, addressLine: null,
    lat: null, lon: null, isPrivate: null, requiresWaitlistTicket: false, images: [], dateCreated: null,
  };
}

test('median of odd and even sets', () => {
  assert.equal(median([1, 5, 3]), 3);
  assert.equal(median([1, 3, 5, 7]), 4);
});

test('scoreValue flags good/fair/premium against the result-set median', () => {
  // median of [10, 12, 14, 20, 8] is 12 -> good < 10.2, premium > 13.8
  const listings = [listing(10), listing(12), listing(14), listing(20), listing(8)];
  scoreValue(listings);
  assert.deepEqual(listings.map((l) => l.valueFlag), ['good', 'fair', 'premium', 'premium', 'good']);
});

test('scoreValue computes €/m² from price/area when missing, nulls otherwise', () => {
  const listings = [listing(null, 600, 40), listing(null)];
  scoreValue(listings);
  assert.equal(listings[0].pricePerSqm, 15);
  assert.equal(listings[0].valueFlag, 'fair'); // single value == its own median
  assert.equal(listings[1].valueFlag, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apt-hunter && npm test`
Expected: FAIL — `Cannot find module '../src/score.js'`.

- [ ] **Step 3: Implement `score.ts`**

`apt-hunter/src/score.ts`:
```ts
import type { NormalizedListing } from './normalize.js';

/** Band around the result-set median: ±15% separates good / fair / premium. */
export const VALUE_BAND = 0.15;

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function scoreValue(listings: NormalizedListing[]): void {
  const effective = (l: NormalizedListing): number | null =>
    l.pricePerSqm ?? (l.price != null && l.area != null && l.area > 0 ? l.price / l.area : null);

  const values = listings.map(effective).filter((v): v is number => v != null && v > 0);
  if (values.length === 0) return;
  const med = median(values);

  for (const l of listings) {
    const v = effective(l);
    if (v == null || v <= 0) {
      l.valueFlag = null;
      continue;
    }
    l.pricePerSqm = Math.round(v * 100) / 100;
    l.valueFlag = v < med * (1 - VALUE_BAND) ? 'good' : v > med * (1 + VALUE_BAND) ? 'premium' : 'fair';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apt-hunter && npm test`
Expected: PASS, 3/3 in score.test.ts.

- [ ] **Step 5: Commit**

```bash
git add apt-hunter/src/score.ts apt-hunter/test/score.test.ts
git commit -m "feat(apt-hunter): €/m² value scoring against result-set median"
```

---

### Task 11: `report.ts` (self-contained static HTML report)

**Files:**
- Create: `apt-hunter/src/report.ts`
- Test: `apt-hunter/test/report.test.ts`

**Interfaces:**
- Consumes: `NormalizedListing` from `./normalize.js`.
- Produces:
  - `interface ReportInput { listings: NormalizedListing[]; rawListings: NormalizedListing[]; generatedAt: string; query: Record<string, unknown>; warnings: string[]; duplicatePairs: number }` (`listings` = post-dedupe merged view, `rawListings` = pre-dedupe view for the report's dedup toggle)
  - `renderReport(input: ReportInput): string` — one self-contained HTML file: inline CSS + JS, data embedded as JSON in a `<script type="application/json">` tag with `<` escaped as `\u003c` (never `</script>` inside data), photo card grid, client-side sort (price asc/desc, €/m², newest), filters (district, source, private-only, hide-waitlist), dedup toggle (merged vs raw view), "both sites" badge with both outbound links on merged cards, waitlist-ticket badge, value badge, warnings banner.

- [ ] **Step 1: Write the failing test**

`apt-hunter/test/report.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/report.js';
import type { NormalizedListing } from '../src/normalize.js';

function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: 'immoscout', id: 'i1', url: 'https://www.immobilienscout24.at/expose/i1',
    title: 'Nette Wohnung </script><script>alert(1)</script>',
    price: 650, pricePerSqm: 15.5, area: 42, rooms: 2,
    district: 4, zip: '1040', addressLine: 'Gußhausstraße 1, 1040 Wien',
    lat: 48.2, lon: 16.37, isPrivate: false, requiresWaitlistTicket: true,
    images: ['https://img.example/1.jpg'], dateCreated: '2026-07-20T00:00:00Z',
    valueFlag: 'good',
    alsoListedOn: [{ source: 'willhaben', url: 'https://www.willhaben.at/x' }],
    ...overrides,
  };
}

const INPUT = {
  listings: [listing()],
  rawListings: [listing(), listing({ source: 'willhaben', id: 'w1', url: 'https://www.willhaben.at/x', alsoListedOn: undefined })],
  generatedAt: '2026-07-26T12:00:00Z',
  query: { districts: [1, 2, 3, 4, 5, 6, 7, 8, 9], priceTo: 700, areaFrom: 30 },
  warnings: ['willhaben source failed: boom'],
  duplicatePairs: 1,
};

test('renderReport produces a self-contained HTML document', () => {
  const html = renderReport(INPUT);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<style>'), 'inline CSS');
  assert.ok(html.includes('application/json'), 'embedded JSON data');
  assert.ok(!html.includes('src="http'), 'no external scripts/styles');
});

test('renderReport escapes </script> inside embedded data', () => {
  const html = renderReport(INPUT);
  const dataTag = html.split('<script type="application/json" id="report-data">')[1].split('</script>')[0];
  assert.ok(!dataTag.includes('</script>'), 'data must not terminate the script tag');
  assert.ok(dataTag.includes('\\u003c/script>'), 'escaped angle brackets');
});

test('renderReport exposes the expected client-side controls and badges', () => {
  const html = renderReport(INPUT);
  for (const id of ['sort', 'district-filter', 'source-filter', 'private-only', 'hide-waitlist', 'dedup-toggle']) {
    assert.ok(html.includes(`id="${id}"`), `missing control #${id}`);
  }
  assert.ok(html.includes('both sites'), 'dedup badge text');
  assert.ok(html.includes('Wohnticket'), 'waitlist badge text');
  assert.ok(html.includes('willhaben source failed: boom'), 'warnings banner content');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apt-hunter && npm test`
Expected: FAIL — `Cannot find module '../src/report.js'`.

- [ ] **Step 3: Implement `report.ts`**

`apt-hunter/src/report.ts`:
```ts
import type { NormalizedListing } from './normalize.js';

export interface ReportInput {
  /** Post-dedupe merged view. */
  listings: NormalizedListing[];
  /** Pre-dedupe raw view (for the dedup toggle). */
  rawListings: NormalizedListing[];
  generatedAt: string;
  query: Record<string, unknown>;
  warnings: string[];
  duplicatePairs: number;
}

const CLIENT_JS = String.raw`
const DATA = JSON.parse(document.getElementById('report-data').textContent);
const grid = document.getElementById('grid');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eur = (n) => n == null ? '–' : '€ ' + Number(n).toLocaleString('de-AT');

function currentListings() {
  return document.getElementById('dedup-toggle').checked ? DATA.rawListings : DATA.listings;
}

function visible() {
  const district = document.getElementById('district-filter').value;
  const source = document.getElementById('source-filter').value;
  const privateOnly = document.getElementById('private-only').checked;
  const hideWaitlist = document.getElementById('hide-waitlist').checked;
  let list = currentListings().filter((l) =>
    (district === 'all' || String(l.district) === district) &&
    (source === 'all' || l.source === source || (l.alsoListedOn || []).some((a) => a.source === source)) &&
    (!privateOnly || l.isPrivate === true) &&
    (!hideWaitlist || !l.requiresWaitlistTicket));
  const sort = document.getElementById('sort').value;
  const by = {
    'price-asc': (a, b) => (a.price ?? 1e9) - (b.price ?? 1e9),
    'price-desc': (a, b) => (b.price ?? -1) - (a.price ?? -1),
    'ppsqm': (a, b) => (a.pricePerSqm ?? 1e9) - (b.pricePerSqm ?? 1e9),
    'newest': (a, b) => String(b.dateCreated ?? '').localeCompare(String(a.dateCreated ?? '')),
  }[sort];
  return list.sort(by);
}

function card(l) {
  const img = l.images[0]
    ? '<img loading="lazy" src="' + esc(l.images[0]) + '" alt="">'
    : '<div class="noimg">no photo</div>';
  const both = (l.alsoListedOn && l.alsoListedOn.length)
    ? '<span class="badge both">both sites</span> ' +
      l.alsoListedOn.map((a) => '<a class="srclink" href="' + esc(a.url) + '">↗ ' + esc(a.source) + '</a>').join(' ')
    : '';
  const waitlist = l.requiresWaitlistTicket ? '<span class="badge waitlist">Wohnticket / Gemeinde</span>' : '';
  const value = l.valueFlag ? '<span class="badge ' + l.valueFlag + '">' + l.valueFlag + ' value</span>' : '';
  return '<article class="card">' + img +
    '<div class="body"><h3><a href="' + esc(l.url) + '">' + esc(l.title) + '</a></h3>' +
    '<p class="price">' + eur(l.price) + ' <span class="dim">· ' + esc(l.pricePerSqm ?? '–') + ' €/m²</span></p>' +
    '<p>' + esc(l.area ?? '–') + ' m² · ' + esc(l.rooms ?? '–') + ' Zi · ' +
      (l.district ? esc(l.district) + '. Bezirk' : 'Bezirk ?') + '</p>' +
    '<p class="dim">' + esc(l.addressLine ?? '') + '</p>' +
    '<p><span class="badge src-' + l.source + '">' + l.source + '</span> ' + both + waitlist + ' ' + value + '</p>' +
    '</div></article>';
}

function render() {
  const list = visible();
  document.getElementById('count').textContent = list.length + ' listings';
  grid.innerHTML = list.map(card).join('') || '<p>No listings match the filters.</p>';
}

function init() {
  const districts = [...new Set(DATA.listings.concat(DATA.rawListings).map((l) => l.district).filter((d) => d != null))].sort((a, b) => a - b);
  document.getElementById('district-filter').innerHTML =
    '<option value="all">All districts</option>' +
    districts.map((d) => '<option value="' + d + '">' + d + '. Bezirk</option>').join('');
  document.querySelectorAll('#controls select, #controls input').forEach((el) => el.addEventListener('change', render));
  render();
}
init();
`;

const CLIENT_CSS = `
:root { color-scheme: light; }
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f5f5f4; color: #1c1917; }
header { background: #fff; border-bottom: 1px solid #e7e5e4; padding: 16px 24px; }
header h1 { margin: 0 0 4px; font-size: 20px; }
header .meta { color: #78716c; font-size: 13px; }
.warnings { background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; margin: 12px 24px 0; padding: 8px 12px; font-size: 13px; }
#controls { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; padding: 12px 24px; background: #fff; border-bottom: 1px solid #e7e5e4; font-size: 14px; position: sticky; top: 0; }
#count { margin-left: auto; color: #78716c; }
#grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; padding: 20px 24px; }
.card { background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgb(0 0 0 / 0.08); }
.card img { width: 100%; height: 180px; object-fit: cover; display: block; }
.noimg { width: 100%; height: 180px; display: flex; align-items: center; justify-content: center; background: #e7e5e4; color: #a8a29e; }
.card .body { padding: 12px 14px; }
.card h3 { margin: 0 0 6px; font-size: 15px; line-height: 1.3; }
.card h3 a { color: inherit; text-decoration: none; }
.card h3 a:hover { text-decoration: underline; }
.card p { margin: 3px 0; font-size: 13px; }
.price { font-weight: 600; font-size: 15px; }
.dim { color: #78716c; font-weight: 400; }
.badge { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
.src-willhaben { background: #ede9fe; color: #6d28d9; }
.src-immoscout { background: #fee2e2; color: #b91c1c; }
.both { background: #d1fae5; color: #047857; }
.waitlist { background: #fef9c3; color: #a16207; }
.good { background: #dcfce7; color: #15803d; }
.fair { background: #e7e5e4; color: #57534e; }
.premium { background: #ffedd5; color: #c2410c; }
.srclink { font-size: 11px; }
`;

export function renderReport(input: ReportInput): string {
  const dataJson = JSON.stringify(input).replace(/</g, '\\u003c');
  const queryLine = Object.entries(input.query)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
    .join(' · ');
  const warnings = input.warnings.length
    ? `<div class="warnings">⚠ Partial coverage: ${input.warnings.map((w) => w.replace(/</g, '&lt;')).join(' — ')}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apartment hunt — ${input.generatedAt.slice(0, 10)}</title>
<style>${CLIENT_CSS}</style>
</head>
<body>
<header>
  <h1>Vienna apartment hunt</h1>
  <div class="meta">${queryLine} · generated ${input.generatedAt} · ${input.listings.length} listings (${input.duplicatePairs} cross-source duplicates merged)</div>
</header>
${warnings}
<div id="controls">
  <label>Sort <select id="sort">
    <option value="price-asc">Price ↑</option>
    <option value="price-desc">Price ↓</option>
    <option value="ppsqm">€/m² ↑</option>
    <option value="newest">Newest</option>
  </select></label>
  <label>District <select id="district-filter"></select></label>
  <label>Source <select id="source-filter">
    <option value="all">Both sources</option>
    <option value="willhaben">willhaben</option>
    <option value="immoscout">immoscout</option>
  </select></label>
  <label><input type="checkbox" id="private-only"> private only</label>
  <label><input type="checkbox" id="hide-waitlist"> hide Wohnticket</label>
  <label><input type="checkbox" id="dedup-toggle"> show unmerged (raw)</label>
  <span id="count"></span>
</div>
<main id="grid"></main>
<script type="application/json" id="report-data">${dataJson}</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apt-hunter && npm test`
Expected: PASS, 3/3 in report.test.ts.

- [ ] **Step 5: Eyeball the report**

```bash
cd apt-hunter && node --import tsx -e "
import { renderReport } from './src/report.js';
import { writeFileSync } from 'node:fs';
const l = { source: 'immoscout', id: 'i1', url: 'https://example.com', title: 'Test', price: 650, pricePerSqm: 15.5, area: 42, rooms: 2, district: 4, zip: '1040', addressLine: 'Gußhausstraße 1', lat: 48.2, lon: 16.37, isPrivate: false, requiresWaitlistTicket: false, images: [], dateCreated: '2026-07-20T00:00:00Z', valueFlag: 'good' };
writeFileSync('/tmp/apt-hunter-report-check.html', renderReport({ listings: [l], rawListings: [l], generatedAt: new Date().toISOString(), query: {}, warnings: [], duplicatePairs: 0 }));
" && open /tmp/apt-hunter-report-check.html
```
Expected: the report opens in the browser, shows one card, and the sort/filter controls work (no JS console errors).

- [ ] **Step 6: Commit**

```bash
git add apt-hunter/src/report.ts apt-hunter/test/report.test.ts
git commit -m "feat(apt-hunter): self-contained static HTML report renderer"
```

---

### Task 12: `cli.ts` (arg parsing + orchestration pipeline)

**Files:**
- Create: `apt-hunter/src/cli.ts`
- Test: `apt-hunter/test/cli.test.ts`

**Interfaces:**
- Consumes: `McpConnection`/`McpServerSpec` (`./mcp-client.js`), `parseWillhabenSearchText`, `parseWillhabenDetailText`, `normalizeWillhaben`, `normalizeImmoscout`, `NormalizedListing` (`./normalize.js`), `dedupeListings` (`./dedupe.js`), `scoreValue` (`./score.js`), `renderReport` (`./report.js`).
- Produces:
  - `parseDistrictsArg(s: string): number[]` — `"1-9"` → `[1..9]`, `"1,2,5"` → `[1,2,5]` (exported for tests)
  - CLI flags: `--price-from`, `--price-to`, `--area-from`, `--area-to`, `--rooms-from`, `--rooms-to`, `--districts` (e.g. `1-9`), `--location` (default `Wien`), `--max-pages` (default 6), `--no-open`. Env override `IMMOSCOUT_MCP_PATH` for the immoscout-mcp entrypoint (default: sibling `../immoscout-mcp/dist/index.js` relative to `apt-hunter/dist/cli.js`).
  - Pipeline (per the spec, plus the willhaben enrichment refinement noted in the header): search both sources in parallel → normalize → enrich willhaben hits with `willhaben_get_listing` (coordinates + images, sequential, capped at 30) → dedupe → score → render report to `reports/report-<ISO-timestamp>.html` → print a compact JSON summary to stdout → open the report unless `--no-open`.
  - Partial-failure rule: if one source's connection/search throws, record a warning, continue with the other source, and flag it in both the stdout summary (`warnings`) and the report banner. Never abort the whole run over one source.
  - Stdout summary shape (the skill parses this): `{ "reportPath": string, "counts": { "willhaben": number, "immoscout": number, "merged": number, "duplicates": number }, "topPick": { "title": string, "price": number|null, "url": string } | null, "warnings": string[] }`. This must be the **only** thing on stdout (log lines go to stderr).

- [ ] **Step 1: Write the failing test**

`apt-hunter/test/cli.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDistrictsArg } from '../src/cli.js';

test('parseDistrictsArg parses ranges and lists', () => {
  assert.deepEqual(parseDistrictsArg('1-9'), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parseDistrictsArg('1,4,9'), [1, 4, 9]);
  assert.deepEqual(parseDistrictsArg('3'), [3]);
  assert.deepEqual(parseDistrictsArg(' 1 - 3 , 7 '), [1, 2, 3, 7]);
});

test('parseDistrictsArg rejects out-of-range districts', () => {
  assert.throws(() => parseDistrictsArg('0-3'), /district/);
  assert.throws(() => parseDistrictsArg('24'), /district/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apt-hunter && npm test`
Expected: FAIL — `Cannot find module '../src/cli.js'`.

- [ ] **Step 3: Implement `cli.ts`**

`apt-hunter/src/cli.ts`:
```ts
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { McpConnection, type McpServerSpec } from './mcp-client.js';
import {
  parseWillhabenSearchText,
  parseWillhabenDetailText,
  normalizeWillhaben,
  normalizeImmoscout,
  type NormalizedListing,
} from './normalize.js';
import { dedupeListings } from './dedupe.js';
import { scoreValue } from './score.js';
import { renderReport } from './report.js';

const WILLHABEN_ENRICH_CAP = 30;

export function parseDistrictsArg(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const range = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (range) {
      for (let d = parseInt(range[1], 10); d <= parseInt(range[2], 10); d++) out.push(d);
    } else if (/^\d{1,2}$/.test(part.trim())) {
      out.push(parseInt(part.trim(), 10));
    } else {
      throw new Error(`invalid district spec: "${part}"`);
    }
  }
  if (out.some((d) => d < 1 || d > 23)) throw new Error(`district out of range 1-23 in "${s}"`);
  return [...new Set(out)];
}

function immoscoutSpec(): McpServerSpec {
  const here = dirname(fileURLToPath(import.meta.url)); // apt-hunter/dist
  const entry = process.env.IMMOSCOUT_MCP_PATH ?? resolve(here, '../../immoscout-mcp/dist/index.js');
  return { command: 'node', args: [entry] };
}

const WILLHABEN_SPEC: McpServerSpec = { command: 'npx', args: ['-y', 'willhaben-mcp'] };

interface CliOptions {
  priceFrom?: number; priceTo?: number;
  areaFrom?: number; areaTo?: number;
  roomsFrom?: number; roomsTo?: number;
  districts?: number[];
  location: string;
  maxPages: number;
  noOpen: boolean;
}

/** willhaben: search pages, district-filter, then enrich each hit with get_listing (coords + images). */
async function huntWillhaben(opts: CliOptions): Promise<NormalizedListing[]> {
  const conn = new McpConnection(WILLHABEN_SPEC);
  await conn.connect();
  try {
    const baseArgs: Record<string, unknown> = {
      property_type: 'mietwohnung',
      action: 'rent',
      location: opts.location,
      sort: 'price_asc',
      rows: 100,
    };
    if (opts.priceFrom != null) baseArgs.price_from = opts.priceFrom;
    if (opts.priceTo != null) baseArgs.price_to = opts.priceTo;
    if (opts.areaFrom != null) baseArgs.area_from = opts.areaFrom;
    if (opts.areaTo != null) baseArgs.area_to = opts.areaTo;
    if (opts.roomsFrom != null) baseArgs.rooms = opts.roomsFrom;

    const hits = [];
    for (let page = 1; page <= Math.min(opts.maxPages, 2); page++) {
      const text = await conn.callToolText('willhaben_search_real_estate', { ...baseArgs, page });
      const parsed = parseWillhabenSearchText(text);
      hits.push(...parsed);
      if (parsed.length < 100) break; // last page
    }

    const kept = opts.districts?.length
      ? hits.filter((h) => h.district != null && opts.districts!.includes(h.district))
      : hits;

    const out: NormalizedListing[] = [];
    for (const hit of kept.slice(0, WILLHABEN_ENRICH_CAP)) {
      let detail;
      try {
        detail = parseWillhabenDetailText(await conn.callToolText('willhaben_get_listing', { id: hit.id }));
      } catch {
        detail = undefined; // enrichment is best-effort; the hit still flows through without coords/images
      }
      out.push(normalizeWillhaben(hit, detail));
    }
    for (const hit of kept.slice(WILLHABEN_ENRICH_CAP)) out.push(normalizeWillhaben(hit));
    return out;
  } finally {
    await conn.close();
  }
}

async function huntImmoscout(opts: CliOptions): Promise<NormalizedListing[]> {
  const conn = new McpConnection(immoscoutSpec());
  await conn.connect();
  try {
    const text = await conn.callToolText('immoscout_search_real_estate', {
      price_from: opts.priceFrom,
      price_to: opts.priceTo,
      area_from: opts.areaFrom,
      area_to: opts.areaTo,
      rooms_from: opts.roomsFrom,
      rooms_to: opts.roomsTo,
      districts: opts.districts,
      max_pages: opts.maxPages,
    });
    const result = JSON.parse(text);
    return (result.listings as unknown[]).map(normalizeImmoscout);
  } finally {
    await conn.close();
  }
}

function pickTop(listings: NormalizedListing[]): NormalizedListing | null {
  const candidates = listings.filter((l) => !l.requiresWaitlistTicket);
  const sorted = (candidates.length ? candidates : listings)
    .slice()
    .sort((a, b) => (a.pricePerSqm ?? 1e9) - (b.pricePerSqm ?? 1e9));
  return sorted[0] ?? null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'price-from': { type: 'string' },
      'price-to': { type: 'string' },
      'area-from': { type: 'string' },
      'area-to': { type: 'string' },
      'rooms-from': { type: 'string' },
      'rooms-to': { type: 'string' },
      districts: { type: 'string' },
      location: { type: 'string', default: 'Wien' },
      'max-pages': { type: 'string', default: '6' },
      'no-open': { type: 'boolean', default: false },
    },
  });
  const num = (v: string | undefined) => (v == null ? undefined : Number(v));
  const opts: CliOptions = {
    priceFrom: num(values['price-from']),
    priceTo: num(values['price-to']),
    areaFrom: num(values['area-from']),
    areaTo: num(values['area-to']),
    roomsFrom: num(values['rooms-from']),
    roomsTo: num(values['rooms-to']),
    districts: values.districts ? parseDistrictsArg(values.districts) : undefined,
    location: values.location,
    maxPages: Number(values['max-pages']),
    noOpen: values['no-open'],
  };

  const [wh, is24] = await Promise.allSettled([huntWillhaben(opts), huntImmoscout(opts)]);
  const warnings: string[] = [];
  const willhabenListings = wh.status === 'fulfilled' ? wh.value : [];
  if (wh.status === 'rejected') {
    warnings.push(`willhaben source failed: ${(wh.reason as Error).message}`);
    console.error('WARNING: willhaben failed:', wh.reason);
  }
  const immoscoutListings = is24.status === 'fulfilled' ? is24.value : [];
  if (is24.status === 'rejected') {
    warnings.push(`immoscout source failed: ${(is24.reason as Error).message}`);
    console.error('WARNING: immoscout failed:', is24.reason);
  }
  if (warnings.length === 2) {
    console.error('Both sources failed — no report generated.');
    process.exit(1);
  }

  const rawListings = [...willhabenListings, ...immoscoutListings];
  const { merged, duplicatePairs } = dedupeListings(rawListings);
  scoreValue(merged);

  const reportsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
  writeFileSync(reportPath, renderReport({
    listings: merged,
    rawListings,
    generatedAt: new Date().toISOString(),
    query: { ...values, districts: opts.districts },
    warnings,
    duplicatePairs,
  }));

  const top = pickTop(merged);
  const summary = {
    reportPath,
    counts: {
      willhaben: willhabenListings.length,
      immoscout: immoscoutListings.length,
      merged: merged.length,
      duplicates: duplicatePairs,
    },
    topPick: top ? { title: top.title, price: top.price, url: top.url } : null,
    warnings,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  if (!opts.noOpen) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(opener, [reportPath], () => {});
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/\.ts$/, '.js'));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

Note: the `isMain` guard keeps `parseDistrictsArg` importable by tests without running the pipeline. If it proves brittle under `tsx` (argv path is `.ts` while `import.meta.url` compiles differently), the accepted fix is moving `parseDistrictsArg` into `normalize.ts` or a small `args.ts` — keep the exported name `parseDistrictsArg` and update the test import accordingly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apt-hunter && npm test`
Expected: PASS, 2/2 in cli.test.ts, all suites green. Then `npm run build` in both packages must compile cleanly.

- [ ] **Step 5: Commit**

```bash
git add apt-hunter/src/cli.ts apt-hunter/test/cli.test.ts
git commit -m "feat(apt-hunter): CLI orchestration across both MCP sources with report output"
```

---

### Task 13: End-to-end live run

**Files:**
- Modify: none (runs the built CLI)

**Interfaces:**
- Consumes: built `apt-hunter/dist/cli.js` + `immoscout-mcp/dist/index.js` + `npx willhaben-mcp`.
- Produces: a verified real report in `apt-hunter/reports/`.

- [ ] **Step 1: Run the real query**

```bash
cd apt-hunter && npm run build && (cd ../immoscout-mcp && npm run build)
node dist/cli.js --price-to 700 --area-from 30 --districts 1-9 --no-open
```
Expected: stdout is a single JSON summary with `counts.willhaben` + `counts.immoscout` ≥ 1 combined, `reportPath` pointing at a new file in `apt-hunter/reports/`, and (most runs) `counts.duplicates` ≥ 0 — a real duplicate pair may or may not exist on a given day; the requirement is that a dedup pass ran, not that it found one. Runtime is dominated by willhaben enrichment (its MCP server rate-limits to ~1 req/s; in this thin market expect ~1–3 minutes).

- [ ] **Step 2: Inspect the report**

`open` the `reportPath`. Expected: photo card grid renders; sorting by price/€-per-m²/newest works; district + source filters work; "hide Wohnticket" removes Gemeindewohnung hits; any merged card shows a "both sites" badge with both outbound links; toggle "show unmerged (raw)" reveals the pre-dedupe view.

- [ ] **Step 3: Cross-check a sample**

Pick 2–3 listings from the report and open their source URLs: price/area/district in the report must match the live listing. If a dedup pair was found, verify it really is the same flat (same address/coords).

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "test(apt-hunter): end-to-end live run (districts 1-9, <=700 EUR, >=30m2)"
```

---

### Task 14: Rewrite the `apartment-hunt` skill to shell out to `apt-hunter`

**Files:**
- Modify: `.claude/skills/apartment-hunt/SKILL.md` (full rewrite)

**Interfaces:**
- Consumes: the `apt-hunter` CLI (Task 12) and its stdout JSON summary.
- Produces: the skill users invoke; `install.sh` (Task 15) copies it to `~/.claude/skills/`.

- [ ] **Step 1: Write the new SKILL.md**

Replace `.claude/skills/apartment-hunt/SKILL.md` entirely:

````markdown
---
name: apartment-hunt
description: Multi-source Vienna rental-apartment search (willhaben + immobilienscout24) with cross-source dedup and a static HTML report. Use when the user wants to find, compare, or shortlist rental apartments in Vienna with preferences like budget, districts, rooms, and size — e.g. "help me find a flat in Vienna under €700 in districts 1-9", "search apartments near Karlsplatz". Runs the apt-hunter CLI and summarizes its results. For buy-side, houses, or non-Vienna searches, falls back to direct willhaben MCP calls.
---

# Apartment Hunt (willhaben + ImmoScout24, Vienna rentals)

Guide the user from a loose brief to a ranked shortlist with a browsable HTML report.
All scraping, dedup, and scoring lives in the `apt-hunter` CLI — do NOT re-implement
that logic in chat; your job is to map preferences to CLI args, run it, and recap.

## Step 1 — Capture preferences (ask only what's missing)

Required: **budget** (`price_to`, optionally `price_from`). Nice to have: **districts**
(e.g. "1-9", default: all of Vienna), **rooms**, **size** (`area_from`/`area_to` m²),
and must-haves (balcony, lift — these aren't filter params; treat as notes for the recap).
Convert "700€" → 700. If the user gave enough, skip questions.

Scope guard: this skill covers **rentals in Vienna only**. For buy-side, houses, or other
cities, say so and fall back to calling `willhaben_search_real_estate` directly (the old
manual flow: search → score €/m² vs median → dedupe reposts → details on top 3–5).

## Step 2 — Run apt-hunter

The repo checkout is at `<REPO_ROOT>` (the directory containing `immoscout-mcp/` and
`apt-hunter/`; currently `~/willhaben-apartment-hunt`, renamed `austria-apartment-hunt`).
Run via Bash:

```bash
node <REPO_ROOT>/apt-hunter/dist/cli.js \
  --price-to <N> [--price-from <N>] [--area-from <N>] [--area-to <N>] \
  [--rooms-from <N>] [--rooms-to <N>] [--districts 1-9] --no-open
```

Always pass `--no-open` (the user opens the report when they're ready). Use a generous
Bash timeout (5 min) — willhaben enrichment is rate-limited to ~1 request/second.
If `dist/` is missing, build first: `cd <REPO_ROOT>/immoscout-mcp && npm install && npm run build`
and the same in `apt-hunter/`.

## Step 3 — Read the stdout JSON summary

The CLI prints one JSON object to stdout:

```json
{ "reportPath": "...", "counts": { "willhaben": 12, "immoscout": 8, "merged": 17, "duplicates": 3 },
  "topPick": { "title": "...", "price": 650, "url": "..." }, "warnings": [] }
```

If `warnings` is non-empty, one source failed — tell the user which and that coverage
is partial (the report still has the other source's listings).

## Step 4 — Present

1. A short recap: total per-source counts, merged count, how many cross-source
   duplicates were merged, and the top pick (title, price, link) with a one-line why.
2. The report path — tell the user to `open <reportPath>` (or offer to).
3. Notable caveats: listings flagged `Wohnticket / Gemeinde` need a municipal
   waitlist ticket a newcomer usually can't get; ImmoScout hits without exact
   coordinates can't be cross-source deduped.
4. Next steps the user can ask for: "open the report", "raise budget to X",
   "different districts", "details on the top pick" (use `immoscout_get_listing` /
   `willhaben_get_listing`).

## Guardrails

- Personal, non-commercial use only: defaults are already conservative (rate limits,
  page caps) — do not work around them, never harvest in bulk.
- Dedup/scoring logic lives in `apt-hunter/src/` with unit tests. If the user wants
  the dedup threshold or value bands changed, edit those files and rerun — don't
  approximate it in chat.
````

- [ ] **Step 2: Install locally and smoke-test the trigger**

```bash
mkdir -p ~/.claude/skills && cp -r .claude/skills/apartment-hunt ~/.claude/skills/
```
In a fresh Claude Code session, ask: "find me a rental flat in Vienna under €700 in districts 1-9, ≥30m²". Expected: the skill triggers, runs the CLI via Bash, and recaps from the stdout JSON.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/apartment-hunt/SKILL.md
git commit -m "feat(skill): apartment-hunt shells out to apt-hunter CLI"
```

---

### Task 15: `install.sh`, README, repo rename

**Files:**
- Modify: `install.sh` (full rewrite)
- Modify: `README.md` (full rewrite)

**Interfaces:**
- Consumes: both built packages, the rewritten skill.
- Produces: a one-command setup registering both MCP servers and the skill; docs matching reality.

- [ ] **Step 1: Rewrite `install.sh`**

```bash
#!/usr/bin/env bash
# Sets up the austria-apartment-hunt kit for Claude Code:
#   1. builds immoscout-mcp and apt-hunter
#   2. registers the willhaben + immoscout MCP servers (user scope)
#   3. installs the apartment-hunt skill into ~/.claude/skills

set -euo pipefail

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' CLI not found on PATH. Install Claude Code first: https://claude.com/claude-code" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' not found on PATH. Install Node.js >= 18 first." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Building immoscout-mcp..."
(cd "$SCRIPT_DIR/immoscout-mcp" && npm install && npm run build)

echo "==> Building apt-hunter..."
(cd "$SCRIPT_DIR/apt-hunter" && npm install && npm run build)

echo "==> Registering MCP servers (user scope)..."
claude mcp add -s user willhaben -- npx -y willhaben-mcp
claude mcp add -s user immoscout -- node "$SCRIPT_DIR/immoscout-mcp/dist/index.js"

SKILL_SRC="$SCRIPT_DIR/.claude/skills/apartment-hunt"
SKILL_DEST="$HOME/.claude/skills/apartment-hunt"
echo "==> Installing apartment-hunt skill to $SKILL_DEST..."
mkdir -p "$HOME/.claude/skills"
cp -r "$SKILL_SRC" "$SKILL_DEST"

cat <<EOF

Done. Restart Claude Code (or start a new session) so the MCP tools load, then try:

  "help me find a rental flat in Vienna under €700 in districts 1-9"

Or run the CLI directly:
  node "$SCRIPT_DIR/apt-hunter/dist/cli.js" --price-to 700 --districts 1-9

EOF
```

- [ ] **Step 2: Rewrite `README.md`**

Keep the existing structure (what it is / what's in here / setup / usage / verified behavior / legal / credits / license) and update it to cover both sources: repo is now `austria-apartment-hunt`; `immoscout-mcp` is home-built (unofficial, not affiliated with ImmoScout24, see `immoscout-mcp/DISCLAIMER.md`); `apt-hunter` queries both MCP servers, dedupes cross-source via coordinate+price+area scoring, and renders a static HTML report into `apt-hunter/reports/`; the skill shells out to `apt-hunter`. In "Verified behavior", add the Task 6/Task 13 confirmations (real Vienna listings with price/area/address/coordinates from both tools; end-to-end report run for districts 1–9 ≤ €700 ≥ 30 m²). Keep the willhaben legal section as-is and add a parallel ImmoScout24 note: more permissive robots.txt observed, but the same conservative personal-use posture applies. Keep credits for `willhaben-mcp` (Ali Ildan, MIT) and `THIRD_PARTY_LICENSES/`.

- [ ] **Step 3: Verify `install.sh`**

```bash
./install.sh
claude mcp list   # expect both willhaben and immoscout registered
```
Expected: clean build, both servers listed, skill copied.

- [ ] **Step 4: Commit**

```bash
git add install.sh README.md
git commit -m "feat: install script + README for both sources (austria-apartment-hunt)"
```

- [ ] **Step 5: Rename the repo (manual, outward-facing — user action)**

These steps touch GitHub and the local directory name; they are deliberately **not** scripted:

1. On GitHub: rename `Ayliki/willhaben-apartment-hunt` → `austria-apartment-hunt` (Settings → Rename). GitHub auto-redirects the old URL.
2. Locally:
   ```bash
   cd ~
   git -C willhaben-apartment-hunt remote set-url origin git@github.com:Ayliki/austria-apartment-hunt.git
   mv willhaben-apartment-hunt austria-apartment-hunt
   ```
3. Re-run `./install.sh` from the new path so the registered `immoscout` MCP server and the skill's `<REPO_ROOT>` point at the moved directory.

---

## Self-review notes (plan author)

- **Spec coverage:** every spec section maps to a task — site research findings → Tasks 1–4 fixtures; `immoscout_search_real_estate`/`immoscout_get_listing` + error posture → Tasks 3–5; dedupe heuristic → Task 9; pipeline incl. partial-failure → Task 12; HTML report → Task 11; skill rewrite → Task 14; legal/rate-limit posture → Tasks 2, 5, 12, 15; testing/verification (unit + live stdio + e2e) → Tasks 1–13; out-of-scope items are not implemented anywhere.
- **Deviations from spec, deliberate:** (1) willhaben enrichment via `willhaben_get_listing` added to the apt-hunter pipeline — the probed willhaben *search* output carries no coordinates or images, which dedupe and the photo grid require. (2) ImmoScout `isSocialHousing` → `requiresWaitlistTicket` mapping (spec only specified the willhaben keyword heuristic). (3) `localization.transit` was `null` in the only verifiable live expose — extracted defensively, tested with a synthetic populated fixture.
- **Type consistency:** `ImmoscoutSearchHit`/`ImmoscoutSearchResult` (Task 3) are the JSON contract consumed by `normalizeImmoscout` (Task 8); `NormalizedListing` (Task 8) is consumed unchanged by Tasks 9–12; `ReportInput` (Task 11) matches the object assembled in `cli.ts` (Task 12); stdout summary shape (Task 12) matches what the skill parses (Task 14).
