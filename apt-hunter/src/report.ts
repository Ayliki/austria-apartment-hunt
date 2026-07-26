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
  const value = l.valueFlag ? '<span class="badge ' + esc(l.valueFlag) + '">' + esc(l.valueFlag) + ' value</span>' : '';
  return '<article class="card">' + img +
    '<div class="body"><h3><a href="' + esc(l.url) + '">' + esc(l.title) + '</a></h3>' +
    '<p class="price">' + eur(l.price) + ' <span class="dim">· ' + esc(l.pricePerSqm ?? '–') + ' €/m²</span></p>' +
    '<p>' + esc(l.area ?? '–') + ' m² · ' + esc(l.rooms ?? '–') + ' Zi · ' +
      (l.district ? esc(l.district) + '. Bezirk' : 'Bezirk ?') + '</p>' +
    '<p class="dim">' + esc(l.addressLine ?? '') + '</p>' +
    '<p><span class="badge src-' + esc(l.source) + '">' + esc(l.source) + '</span> ' + both + waitlist + ' ' + value + '</p>' +
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
