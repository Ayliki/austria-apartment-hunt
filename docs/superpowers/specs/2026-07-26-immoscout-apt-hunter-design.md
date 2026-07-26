# ImmoScout24.at MCP server + apt-hunter dedup/report tool

Date: 2026-07-26

## Purpose

Extend Vienna apartment hunting beyond willhaben to also cover
immobilienscout24.at, and give the results a real interface instead of
chat-only markdown tables. Two new pieces:

1. **`immoscout-mcp`** — a home-built MCP server for immobilienscout24.at
   (no official/third-party MCP server exists for it; only DE/CH scrapers
   were found via Apify, not AT).
2. **`apt-hunter`** — a CLI that queries both MCP servers, cross-source
   dedupes results, scores value, and renders one self-contained HTML report.

The repo `willhaben-apartment-hunt` is renamed **`austria-apartment-hunt`**
to reflect covering both sources.

## Site research findings (verified against live data)

- `immobilienscout24.at` server-renders a `window.__INITIAL_STATE__` JSON
  blob on search-result pages (e.g.
  `/regional/wien/wien/wohnung-mieten`) containing the full result set:
  price, area, rooms, **exact street address**, lat/lon, badges
  (private/social-housing/free-of-commission/etc.), listing ID, publish date.
- Listing detail pages (`/expose/{id}`) embed a `window.__APOLLO_STATE__`
  GraphQL cache with the complete expose: description, contact name +
  company, cost breakdown (deposit, commission note, price/m²), condition
  (heating, energy class), fitting (lift, kitchen, parking), transit stops
  with walking distances, floor, availability, and full-resolution image URLs
  with captions. This is richer than willhaben (which never exposes street
  address).
- Query-string filters work directly against the server-rendered page:
  `primaryPriceFrom/To`, `primaryAreaFrom/To`, `numberOfRoomsFrom/To`,
  `estateType`, `transferType=RENT`. Pagination via `/seite-N` path suffix,
  fixed at 15 results/page.
- **`zipCode` query param does not actually filter** — verified empirically
  (identical result set with/without it, single or multi-value). District
  filtering must happen client-side by parsing the postal code out of each
  hit's `addressString`.
- `robots.txt` only disallows two SEO bots (`MJ12bot`, `AhrefsBot`) from
  `/expose` — it does not forbid general automated access the way
  willhaben's does. No general Terms-of-Use page prohibiting scraping was
  found (only provider AGB, accessibility, privacy, and AI-info pages exist
  in the footer). Despite the more permissive posture, treat this with the
  same conservative use policy as the willhaben setup (see Legal section).
- Requests occasionally 401'd transiently without a persisted session
  cookie; a cookie jar reused across requests within a run resolved it.

## Scope (this iteration)

- **Rent only.** Apartments (`wohnung-mieten`); house-rentals and buy-side
  can be added later without architecture changes.
- **Vienna only.** URL pattern confirmed for `/regional/wien/wien/...`.
  Nationwide fallback (`/regional/oesterreich/...`) exists in the site but is
  out of scope for now — no per-city slug-mapping table is being built yet.

## Architecture

```
austria-apartment-hunt/
├── README.md                        # rewritten for both sources
├── install.sh                       # registers both MCP servers + skill
├── immoscout-mcp/                   # new MCP server (Node/TypeScript)
│   ├── package.json
│   ├── src/
│   │   ├── index.ts                 # MCP server entrypoint, tool registration
│   │   ├── fetcher.ts               # HTTP + cookie jar + rate limiting + retry
│   │   ├── parse.ts                 # brace-matching JS-object extractor
│   │   │                             #   (handles bare `undefined` tokens)
│   │   ├── search.ts                # immoscout_search_real_estate logic
│   │   ├── listing.ts               # immoscout_get_listing logic
│   │   └── types.ts
│   ├── test/                        # unit tests (parse.ts, search.ts URL building)
│   └── DISCLAIMER.md                # legal/use posture, mirrors willhaben's
├── apt-hunter/                      # new CLI + static HTML report generator
│   ├── package.json
│   ├── src/
│   │   ├── cli.ts                   # arg parsing + orchestration
│   │   ├── mcp-client.ts            # generic: spawn + call any MCP server's tool
│   │   ├── normalize.ts             # willhaben + immoscout raw → NormalizedListing
│   │   ├── dedupe.ts                # cross-source duplicate scoring/grouping
│   │   ├── score.ts                 # €/m² value scoring, waitlist-ticket detector
│   │   └── report.ts                # renders self-contained HTML report
│   ├── test/                        # dedupe.test.ts, normalize.test.ts, score.test.ts
│   └── reports/                     # gitignored, timestamped HTML output
└── .claude/skills/apartment-hunt/SKILL.md   # rewritten to shell out to apt-hunter
```

### Why MCP-client-for-both, not a shared scraping library

`apt-hunter` talks to **both** `willhaben-mcp` (third-party, via `npx`) and
`immoscout-mcp` (ours) as MCP clients over stdio — the same way Claude Code
does. This keeps one source of truth for each site's scraping logic inside
its own MCP server (testable, independently versioned) rather than
duplicating willhaben-scraping code outside the already-vetted
`willhaben-mcp` package. The subprocess/JSON-RPC overhead is negligible for
a personal tool making a few dozen requests per run.

## `immoscout-mcp` tools

### `immoscout_search_real_estate`

Params: `price_from?`, `price_to?`, `area_from?`, `area_to?`,
`rooms_from?`, `rooms_to?`, `districts?: number[]` (1–23), `max_pages?`
(default 6, hard cap 10).

Behavior:
- Builds `/regional/wien/wien/wohnung-mieten` URL with query params.
- If `districts` is given, auto-paginates internally (bounded by
  `max_pages`), parsing each page's postal code from `addressString` and
  keeping only matching hits — solving the exact pain point from today's
  manual willhaben session (7 pages paged and filtered by eye in chat).
- Returns: matched listings (title, price, price/m², area, rooms, district,
  full address, lat/lon, badges, isPrivate, isSocialHousing, exposeId, url,
  dateCreated) + `totalHitsCitywide` + `pagesScanned` so the caller knows if
  it hit the page cap without finding everything.

### `immoscout_get_listing`

Params: `id` (exposeId).

Returns full expose detail: title + description body, exact address +
coordinates, price breakdown (rent, €/m², deposit, commission note), contact
(name, company, phone if present), condition (heating, energy class),
fitting (lift, kitchen, parking spaces), transit stops with walking
distances, floor, availability/rental period, image URLs + captions.

### Error handling

Non-200 responses or a failed JSON extraction (site markup changed) throw a
clear, specific error — never silently return an empty list, matching how
`willhaben-mcp` behaves.

## Cross-source duplicate detection (`apt-hunter/dedupe.ts`)

Willhaben hides street addresses but exposes lat/lon; ImmoScout24 exposes
both — so matching uses coordinates + price + area instead of unreliable
text similarity:

```
score = 0
if distance(a.coords, b.coords) < 60m:   score += 3
elif distance < 150m:                     score += 1
if |priceA - priceB| / max(price) < 3%:   score += 2
elif < 8%:                                 score += 1
if |areaA - areaB| < 2m²:                  score += 2
elif < 5m²:                                 score += 1
duplicate if score >= 5   // only ever compares across sources
```

Threshold (5) is a starting point, tuned against real duplicate pairs found
during manual verification. Matched pairs are merged: the listing with more
complete data (or earlier `dateCreated`) becomes primary, the other is
attached as `alsoListedOn: [{source, url}]`. The report's dedup toggle can
still reveal the raw, unmerged view.

## `apt-hunter` pipeline

1. Parse CLI args (`--price-to`, `--price-from`, `--area-from`, `--area-to`,
   `--rooms-from`, `--rooms-to`, `--districts` e.g. `1-9`, `--location`
   default `Wien`).
2. Call `willhaben_search_real_estate` (rent, mietwohnung) — paginate up to
   a bounded cap, same as today's manual session — and
   `immoscout_search_real_estate` (with `districts` passed straight through)
   in parallel.
3. Normalize both result sets into a common `NormalizedListing` shape
   (source, id, url, title, price, pricePerSqm, area, rooms, district, zip,
   addressLine, lat, lon, isPrivate, requiresWaitlistTicket, images,
   dateCreated). `requiresWaitlistTicket` is set by keyword-matching willhaben
   titles for "Vormerkschein"/"Wohnticket"/"Gemeindewohnung" (same heuristic
   used manually today).
4. Run dedup scoring, merge matched pairs.
5. Score value: €/m² vs citywide median, flag below/above.
6. Render one self-contained HTML file: inline CSS/JS, embedded JSON, photo
   card grid, client-side sort (price/€/m²/date) and filter (district,
   source, private-only, hide-waitlist-required), a "listed on both sites"
   badge with both outbound links on merged cards.
7. Auto-open the file in the default browser; also print a compact JSON
   summary to stdout (counts, top pick, report path) for the calling skill
   to read back.
8. If one MCP server fails, log it, continue with the other source's
   results, and flag the partial-coverage in both the summary and the
   report header — never abort the whole run over one source failing.

## Skill integration

`.claude/skills/apartment-hunt/SKILL.md` is rewritten to: gather
preferences as today (action/location/budget/must-haves), map them to
`apt-hunter` CLI args, run it via Bash, read its stdout JSON summary, and
present a short chat recap (top pick, counts, dedup count) plus the report
file path — instead of calling both MCP tools directly and dedup'ing via
written instructions. Dedup logic lives in one tested place.

## Legal / rate-limiting posture

- `immoscout-mcp/DISCLAIMER.md` mirrors willhaben's: personal,
  non-commercial, occasional use only; not for bulk harvesting or
  contacting advertisers at scale; notes the more permissive robots.txt but
  recommends the same conservative posture pending clarity on a general ToS.
- Minimum ~700ms between requests; hard page-scan cap (10) per search call;
  realistic but honest User-Agent (not impersonating a specific browser
  version falsely, not spoofing another bot's identity).

## Testing / verification

- Unit tests: `parse.ts` brace-matcher + `undefined→null` normalization
  against fixture strings; `dedupe.ts` scoring against constructed
  clear-duplicate / clear-non-duplicate / borderline fixtures;
  `normalize.ts` district/zip extraction and waitlist-ticket detection.
- Manual live verification (required before calling this done, per this
  project's existing "Verified behavior" convention in the willhaben
  README): drive `immoscout-mcp` directly over stdio against live
  immobilienscout24.at data, confirming real current Vienna listings with
  price/area/address/coordinates come back for both tools.
- End-to-end run of `apt-hunter` against today's actual query (districts
  1–9, rent, <€700, ≥30m²) confirming the report opens, contains sane
  merged/deduped results, and at least attempts a dedup pass (a real
  duplicate pair may or may not exist in live data on any given run).

## Out of scope (this iteration)

- Buy-side listings, houses, non-Vienna locations.
- A persistent local web server / live search form (static report chosen
  instead — see design discussion).
- Publishing `immoscout-mcp` to npm (registered locally via `node
  dist/index.js`, same personal-use posture as the rest of this repo).
