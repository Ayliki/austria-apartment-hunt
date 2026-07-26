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

The repo checkout is at `/Users/ayliki/austria-apartment-hunt` (the directory containing `immoscout-mcp/` and `apt-hunter/`).
Run via Bash:

```bash
node /Users/ayliki/austria-apartment-hunt/apt-hunter/dist/cli.js \
  --price-to <N> [--price-from <N>] [--area-from <N>] [--area-to <N>] \
  [--rooms-from <N>] [--rooms-to <N>] [--districts 1-9] --no-open
```

Always pass `--no-open` (the user opens the report when they're ready). Use a generous
Bash timeout (5 min) — willhaben enrichment is rate-limited to ~1 request/second.
If `dist/` is missing, build first: `cd /Users/ayliki/austria-apartment-hunt/immoscout-mcp && npm install && npm run build`
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
