# willhaben-apartment-hunt

A ready-to-use Claude Code setup for hunting apartments on
[willhaben.at](https://www.willhaben.at) (Austria's largest classifieds site) —
search, compare, and shortlist rentals or purchases straight from a Claude
Code conversation.

This is **not** a scraper or MCP server itself. It's a thin, personal setup on
top of the excellent [`willhaben-mcp`](https://github.com/aliildan/willhaben-mcp)
package by [Ali Ildan](https://github.com/aliildan), plus a multi-step
`apartment-hunt` skill (bundled from that same project) that turns a loose
brief like *"2-bedroom flat in Vienna under €1200"* into a ranked, scored
shortlist with links.

## What's in here

- **`install.sh`** — registers the `willhaben-mcp` MCP server with Claude Code
  (user scope, via `npx`, no install/build step) and installs the
  `apartment-hunt` skill globally.
- **`.claude/skills/apartment-hunt/SKILL.md`** — the search → score → dedupe →
  shortlist workflow, copied unmodified from the upstream project (MIT
  licensed, see `THIRD_PARTY_LICENSES/`).

## Setup

```bash
git clone https://github.com/Ayliki/willhaben-apartment-hunt.git
cd willhaben-apartment-hunt
./install.sh
```

Then restart Claude Code (or start a new session) so the `willhaben` MCP
tools load.

### Manual setup (if you'd rather not run the script)

```bash
claude mcp add -s user willhaben -- npx -y willhaben-mcp
mkdir -p ~/.claude/skills
cp -r .claude/skills/apartment-hunt ~/.claude/skills/
```

## Usage

Just ask, in any Claude Code session:

> help me find a 2-bedroom flat in Vienna under €1200/month

> compare houses to rent near Graz, garden a must-have

The skill will ask only for what's missing (action, location, budget), search
willhaben's real-estate listings, score results by €/m² value, dedupe
reposts, pull full details on the top 3–5 matches, and present a ranked
comparison table with a recommendation and next-step options.

You can also call the underlying MCP tools directly without the skill:
`willhaben_search_real_estate`, `willhaben_get_listing`,
`willhaben_get_categories` (see the
[willhaben-mcp README](https://github.com/aliildan/willhaben-mcp) for the
full tool/parameter reference).

## Verified behavior

Before publishing this, the MCP server was driven directly over its stdio
JSON-RPC protocol (not just read about) against live willhaben.at data:

- `willhaben_search_real_estate` returned real, current Vienna rental listings
  with price, district, size, rooms, price/m², publish date, and link.
- `willhaben_get_listing` returned full detail: price, district + postal code
  + GPS coordinates, seller info, living area, energy class, heating,
  10–30 photo URLs, and contact type.
- The free-text description field is only populated when the individual
  advertiser filled one in (willhaben's own `BODY_DYN` attribute) — this is a
  data-availability gap on willhaben's side, not a tool bug.
- Exact street address is never returned by willhaben publicly (only
  district/postal code + coordinates) until you contact the seller — this
  is a willhaben privacy practice, not something any MCP server can bypass.

## Legal & responsible use — read this

**willhaben's own Terms of Use and `robots.txt` explicitly forbid automated
access** ("It is expressively forbidden to use spiders, search robots or
other automatic methods to access willhaben.at"). `willhaben-mcp` is an
unofficial, independent project, not affiliated with, authorized by, or
endorsed by willhaben internet service GmbH & Co KG. Use of this setup is:

- **Personal, non-commercial, occasional use only** — e.g. one person
  searching for their own apartment.
- **Not** for bulk harvesting, mirroring, building a derivative dataset,
  commercial resale of willhaben data, or contacting advertisers at scale.
- Your responsibility to comply with willhaben's Terms of Use, `robots.txt`,
  and applicable law (Austrian/EU unfair-competition, copyright, database
  rights, GDPR — listings can contain personal data).

See the full [`willhaben-mcp` DISCLAIMER.md](https://github.com/aliildan/willhaben-mcp/blob/main/DISCLAIMER.md)
for details. This is not legal advice — if in doubt, consult a lawyer or
contact willhaben directly.

## Credits

All real-estate data, scraping logic, MCP tool implementation, and the
`apartment-hunt` skill design are the work of
[Ali Ildan](https://github.com/aliildan) —
[`willhaben-mcp`](https://github.com/aliildan/willhaben-mcp) (MIT license).
This repository only adds an install script and usage notes on top.

## License

The setup script and this README are MIT licensed (see `LICENSE`). The
bundled skill file retains its original license — see
`THIRD_PARTY_LICENSES/willhaben-mcp-LICENSE.md`.
