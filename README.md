# austria-apartment-hunt

A ready-to-use Claude Code setup for hunting apartments in Vienna across both
[willhaben.at](https://www.willhaben.at) and
[immobilienscout24.at](https://www.immobilienscout24.at). Search, deduplicate,
score, and shortlist rentals straight from a Claude Code conversation.

The repo is now **`austria-apartment-hunt`** (renamed from `willhaben-apartment-hunt`).
GitHub auto-redirects the old URL, but new clones should use the new name.

This is **not** a scraper itself. It's a thin, personal setup on top of:

- The excellent [`willhaben-mcp`](https://github.com/aliildan/willhaben-mcp)
  package by [Ali Ildan](https://github.com/aliildan).
- `immoscout-mcp`, a home-built, **unofficial** MCP server for ImmoScout24. It
  is not affiliated with, authorized by, or endorsed by ImmoScout24 / Scout24
  (see [`immoscout-mcp/DISCLAIMER.md`](immoscout-mcp/DISCLAIMER.md)).
- `apt-hunter`, a local CLI that queries both MCP servers, deduplicates
  cross-source hits by coordinate + price + area scoring, and renders a static
  HTML report into `apt-hunter/reports/`.
- The `apartment-hunt` skill (in `.claude/skills/apartment-hunt/SKILL.md`), which
  shells out to `apt-hunter` and turns a brief like *"flat in Vienna under €700
  in districts 1–9"* into a ranked shortlist with a browsable report.

## What's in here

- **`install.sh`** — builds `immoscout-mcp` and `apt-hunter`, then registers
  both the `willhaben` and `immoscout` MCP servers with Claude Code (user scope)
  and installs the `apartment-hunt` skill globally.
- **`immoscout-mcp/`** — unofficial ImmoScout24 MCP server (`immoscout_search_real_estate`,
  `immoscout_get_listing`).
- **`apt-hunter/`** — multi-source search, scoring, deduplication, and HTML
  report generation.
- **`.claude/skills/apartment-hunt/SKILL.md`** — the conversational skill that
  drives `apt-hunter`.
- **`THIRD_PARTY_LICENSES/`** — license for the bundled `willhaben-mcp` skill.

## Setup

```bash
git clone https://github.com/Ayliki/austria-apartment-hunt.git
cd austria-apartment-hunt
./install.sh
```

Then restart Claude Code (or start a new session) so the `willhaben` and
`immoscout` MCP tools load.

### Manual setup (if you'd rather not run the script)

```bash
# build both packages
cd immoscout-mcp && npm install && npm run build && cd ..
cd apt-hunter && npm install && npm run build && cd ..

# register the MCP servers
claude mcp add -s user willhaben -- npx -y willhaben-mcp
claude mcp add -s user immoscout -- node ./immoscout-mcp/dist/index.js

# install the skill
mkdir -p ~/.claude/skills
cp -r .claude/skills/apartment-hunt ~/.claude/skills/
```

### Manual repo rename (only if you have the old clone)

If you already have a `willhaben-apartment-hunt` checkout, update it by hand
(these steps are not scripted because they touch GitHub and your local directory
name):

1. On GitHub: rename `Ayliki/willhaben-apartment-hunt` → `austria-apartment-hunt`
   (Settings → Rename). GitHub auto-redirects the old URL.
2. Locally:
   ```bash
   cd ~
   git -C willhaben-apartment-hunt remote set-url origin git@github.com:Ayliki/austria-apartment-hunt.git
   mv willhaben-apartment-hunt austria-apartment-hunt
   ```
3. Re-run `./install.sh` from the new path so the registered `immoscout` MCP
   server and the skill's `<REPO_ROOT>` point at the moved directory.

## Usage

Just ask, in any Claude Code session:

> help me find a rental flat in Vienna under €700 in districts 1-9

> search apartments near Karlsplatz under €900

The skill will ask only for what's missing (budget, districts, rooms, size), run
`apt-hunter`, search both sources, score results by €/m² value, deduplicate
cross-source reposts, pull full details on the top matches, and present a ranked
comparison plus the path to a static HTML report. Open the report with:

```bash
open apt-hunter/reports/report-....html
```

You can also call the underlying MCP tools directly without the skill:
`willhaben_search_real_estate`, `willhaben_get_listing`,
`immoscout_search_real_estate`, `immoscout_get_listing`.

Or run the CLI directly:

```bash
node ./apt-hunter/dist/cli.js --price-to 700 --area-from 30 --districts 1-9 --no-open
```

## Swipe bot (Telegram)

`swipe-bot/` turns the same willhaben + immoscout sources into a Telegram
swipe-card experience: a background poller keeps a shared listing pool fresh
(one poll every ~3h regardless of how many people use the bot — never scales
requests with user count), and each person swipes 👍/👎 on cards with photos.
The bot learns per-person preferences from swipe history using a deterministic
Laplace-smoothed bucket score (district, price band, room count, size band,
private/agency, has-photos) — no LLM calls, so it's cheap to share with friends.

### Setup

```bash
cd swipe-bot
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN (from @BotFather)
npm run build
npm start               # or install the LaunchAgent for always-on:
cp com.hq.swipe-bot.plist ~/Library/LaunchAgents/
# edit the copied plist's TELEGRAM_BOT_TOKEN before loading
launchctl load ~/Library/LaunchAgents/com.hq.swipe-bot.plist
```

### Usage

DM the bot on Telegram: `/start` asks for budget, districts, rooms, and size,
then starts sending cards. 👍 saves to `/shortlist`; 👍/👎 both advance to the
next card. `/settings` re-runs the preference wizard. `/next` re-checks the
queue on demand (useful right after a poll lands new listings).

Runs entirely on your Mac — no inbound port needed (Telegram long-polling).
The bot is offline while your Mac is off or asleep.

## Verified behavior

Before publishing this, both MCP servers were driven directly over their stdio
JSON-RPC protocols (not just read about) against live data:

- `willhaben_search_real_estate` returned real, current Vienna rental listings
  with price, district, size, rooms, price/m², publish date, and link.
- `willhaben_get_listing` returned full detail: price, district + postal code +
  GPS coordinates, seller info, living area, energy class, heating, 10–30 photo
  URLs, and contact type.
- `immoscout_search_real_estate` returned real Vienna rental listings with
  price, living area, rooms, district, address line, and coordinates where the
  advertiser exposed them.
- `immoscout_get_listing` returned full listing detail including address,
  coordinates, contact information, images, and key attributes.
- An end-to-end report run for districts 1–9, ≤ €700, ≥ 30 m² produced a
  browsable HTML report under `apt-hunter/reports/` combining both sources.

Caveats: the free-text description field on willhaben is only populated when the
individual advertiser filled one in (willhaben's own `BODY_DYN` attribute) — this
is a data-availability gap on willhaben's side, not a tool bug. Exact street
address is never returned by willhaben publicly (only district/postal code +
coordinates) until you contact the seller — this is a willhaben privacy
practice, not something any MCP server can bypass. ImmoScout hits without exact
coordinates cannot be cross-source deduplicated.

## Legal & responsible use — read this

**willhaben's own Terms of Use and `robots.txt` explicitly forbid automated
access** ("It is expressively forbidden to use spiders, search robots or other
automatic methods to access willhaben.at"). `willhaben-mcp` is an unofficial,
independent project, not affiliated with, authorized by, or endorsed by
willhaben internet service GmbH & Co KG. Use of this setup is:

- **Personal, non-commercial, occasional use only** — e.g. one person searching
  for their own apartment.
- **Not** for bulk harvesting, mirroring, building a derivative dataset,
  commercial resale of willhaben data, or contacting advertisers at scale.
- Your responsibility to comply with willhaben's Terms of Use, `robots.txt`,
  and applicable law (Austrian/EU unfair-competition, copyright, database
  rights, GDPR — listings can contain personal data).

**ImmoScout24:** `immoscout-mcp` is also unofficial and not affiliated with
ImmoScout24 / Scout24. The observed `robots.txt` posture on
immobilienscout24.at is more permissive than willhaben's (it only blocks two
SEO bots from `/expose`), but the same conservative personal-use posture
applies: rate limits, modest page caps, honest User-Agent, no bulk harvesting or
commercial use. See [`immoscout-mcp/DISCLAIMER.md`](immoscout-mcp/DISCLAIMER.md)
for details.

See the full [`willhaben-mcp` DISCLAIMER.md](https://github.com/aliildan/willhaben-mcp/blob/main/DISCLAIMER.md)
for details. This is not legal advice — if in doubt, consult a lawyer or
contact the site operator directly.

## Credits

All willhaben data, scraping logic, MCP tool implementation, and the original
`apartment-hunt` skill design are the work of
[Ali Ildan](https://github.com/aliildan) —
[`willhaben-mcp`](https://github.com/aliildan/willhaben-mcp) (MIT license).
`immoscout-mcp` and `apt-hunter` are additions in this repo. The bundled skill
file retains its original license — see
`THIRD_PARTY_LICENSES/willhaben-mcp-LICENSE.md`.

## License

The setup script and this README are MIT licensed (see `LICENSE`). The bundled
skill file and `willhaben-mcp` retain their original licenses — see
`THIRD_PARTY_LICENSES/`.
