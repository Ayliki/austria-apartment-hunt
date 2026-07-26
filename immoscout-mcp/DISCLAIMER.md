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
