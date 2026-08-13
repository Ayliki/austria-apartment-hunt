import { parseWillhabenDetailText } from 'apt-hunter/dist/normalize.js';
import {
  type DB,
  getListingsBySource, applyListingRefresh, setListingDelisted, deleteDelistedUnshortlisted,
} from './db.js';

export type ListingSource = 'willhaben' | 'immoscout';

/** Minimal shape refreshAllListings needs from an MCP connection — matches apt-hunter's McpConnection.callToolText, so a real McpConnection satisfies this structurally with no adapter. */
export interface ListingFetcher {
  callToolText(tool: string, args: Record<string, unknown>): Promise<string>;
}

export interface RefreshDeps {
  willhaben: ListingFetcher;
  immoscout: ListingFetcher;
}

export interface SourceRefreshSummary {
  checked: number;
  updated: number;
  delisted: number;
  errored: number;
}

export interface RefreshSummary {
  willhaben: SourceRefreshSummary;
  immoscout: SourceRefreshSummary;
  /** Rows deleted after the sweep: is_delisted and not in anyone's shortlist. */
  deleted: number;
}

/** Gentle default pace between get_listing calls in a full sweep — 361 rows at this rate finishes in well under two minutes. */
const DEFAULT_DELAY_MS = 300;

interface ImmoscoutDetail {
  address?: string | null;
  images?: { url: string }[];
}

/**
 * Distinguishes "the listing is genuinely gone" from any other failure (rate limit, network blip,
 * upstream markup change). Only 'not-found' may ever set is_delisted — misclassifying a transient
 * failure here would silently delete a live listing out from under a user. Matches against the
 * exact strings each vendored MCP server emits (see willhaben-mcp-patched/dist/index.js's
 * willhaben_get_listing handler and immoscout-mcp/dist/{listing,fetcher}.js).
 */
export function classifyGetListingError(source: ListingSource, err: Error): 'not-found' | 'transient' {
  const msg = err.message;
  if (source === 'willhaben') return msg.includes('not found') ? 'not-found' : 'transient';
  return msg.includes('HTTP 404') || msg.includes('no Expose') ? 'not-found' : 'transient';
}

async function refreshSource(
  db: DB, source: ListingSource, fetcher: ListingFetcher, delayMs: number, sleep: (ms: number) => Promise<void>,
): Promise<SourceRefreshSummary> {
  const rows = getListingsBySource(db, source);
  const tool = source === 'willhaben' ? 'willhaben_get_listing' : 'immoscout_get_listing';
  const summary: SourceRefreshSummary = { checked: 0, updated: 0, delisted: 0, errored: 0 };

  for (const row of rows) {
    summary.checked++;
    const rawId = row.id.slice(source.length + 1); // "willhaben:123" -> "123"
    try {
      const text = await fetcher.callToolText(tool, { id: rawId });
      if (source === 'willhaben') {
        const detail = parseWillhabenDetailText(text);
        applyListingRefresh(db, row.id, { images: detail.images, addressLine: detail.address, lat: detail.lat, lon: detail.lon });
      } else {
        const detail = JSON.parse(text) as ImmoscoutDetail;
        applyListingRefresh(db, row.id, {
          images: (detail.images ?? []).map((i) => i.url),
          addressLine: detail.address ?? null,
          lat: null, // immoscout's detail payload never carries coordinates — the lazy geocode fallback in bot.ts handles this once addressLine is set
          lon: null,
        });
      }
      summary.updated++;
    } catch (err) {
      const kind = classifyGetListingError(source, err as Error);
      if (kind === 'not-found') {
        setListingDelisted(db, row.id, true);
        summary.delisted++;
      } else {
        summary.errored++;
      }
    }
    await sleep(delayMs);
  }
  return summary;
}

/**
 * Re-fetches every stored listing's detail from its source, refreshing images/address/coords and
 * flagging genuinely delisted ones, then hard-deletes delisted rows nobody has shortlisted. Runs
 * once per process start (see index.ts) and then on a standing 24h timer — the same function serves
 * as both the one-time backfill and the ongoing cleanup, there is no separate script.
 */
export async function refreshAllListings(
  db: DB, deps: RefreshDeps, opts: { delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RefreshSummary> {
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const willhaben = await refreshSource(db, 'willhaben', deps.willhaben, delayMs, sleep);
  const immoscout = await refreshSource(db, 'immoscout', deps.immoscout, delayMs, sleep);
  const deleted = deleteDelistedUnshortlisted(db);

  return { willhaben, immoscout, deleted };
}
