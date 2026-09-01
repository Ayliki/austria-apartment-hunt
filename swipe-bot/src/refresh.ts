import { parseWillhabenDetailText } from 'apt-hunter/dist/normalize.js';
import { ALL_SOURCES, resolveSources, type SourceName } from 'apt-hunter/dist/hunt.js';
import {
  type DB,
  getListingsBySource, applyListingRefresh, setListingDelisted, deleteDelistedUnshortlisted,
} from './db.js';

export type ListingSource = 'willhaben' | 'immoscout';

/** Minimal shape refreshAllListings needs from an MCP connection — matches apt-hunter's McpConnection.callToolText, so a real McpConnection satisfies this structurally with no adapter. */
export interface ListingFetcher {
  callToolText(tool: string, args: Record<string, unknown>): Promise<string>;
}

/**
 * Optional per source: a disabled source (see apt-hunter's DEFAULT_SOURCES) gets no connection at
 * all, so there is nothing to pass. A source with no fetcher is skipped exactly like a disabled one.
 */
export interface RefreshDeps {
  willhaben?: ListingFetcher;
  immoscout?: ListingFetcher;
}

export interface SourceRefreshSummary {
  checked: number;
  updated: number;
  delisted: number;
  errored: number;
  /** True when this source was not swept at all (disabled, or no fetcher supplied) — distinct from a sweep that checked 0 rows because there were none. */
  skipped: boolean;
}

/** A source that was never contacted this sweep. Deliberately not "zero rows found": nothing was asked. */
export function skippedSummary(): SourceRefreshSummary {
  return { checked: 0, updated: 0, delisted: 0, errored: 0, skipped: true };
}

export interface RefreshSummary {
  willhaben: SourceRefreshSummary;
  immoscout: SourceRefreshSummary;
  /** Rows deleted after the sweep: is_delisted and not in anyone's shortlist. Always 0 when deletionSkippedFor is non-empty. */
  deleted: number;
  /**
   * Sources whose delisted count this sweep tripped the blast-radius guard (more than a quarter of
   * that source's rows, or more than 10, flagged "not found" in one sweep) — a signal of a block
   * page or upstream markup change, not real mass delisting. When non-empty, the end-of-sweep delete
   * pass is skipped entirely this cycle; a self-heal via the next successful sweep is expected.
   */
  deletionSkippedFor: ListingSource[];
}

/** Gentle default pace between get_listing calls in a full sweep — 361 rows at this rate finishes in well under two minutes. */
const DEFAULT_DELAY_MS = 300;

const BLAST_RADIUS_MIN_DELISTED = 10;
const BLAST_RADIUS_FRACTION = 0.25;

/** True if a source's delisted count this sweep is implausibly high for real listings being taken down — almost certainly a block page or a markup change misfiring as "not found" instead. */
export function exceedsBlastRadius(summary: SourceRefreshSummary): boolean {
  if (summary.skipped) return false; // nothing was fetched, so nothing can look like a block page
  return summary.delisted > Math.max(BLAST_RADIUS_MIN_DELISTED, summary.checked * BLAST_RADIUS_FRACTION);
}

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
  // 410 Gone is source-independent and stronger than 404: the resource existed and was deliberately
  // removed. ImmoScout24 answers a taken-down expose with 410, never 404 — measured on 60 random
  // stored listings (32x 200, 28x 410, nothing else), so before this branch existed every removed
  // listing was misfiled as a transient failure and stayed in the deck as a live apartment forever.
  if (msg.includes('HTTP 410')) return 'not-found';
  if (source === 'willhaben') return msg.includes('not found') ? 'not-found' : 'transient';
  return msg.includes('HTTP 404') || msg.includes('no Expose') ? 'not-found' : 'transient';
}

async function refreshSource(
  db: DB, source: ListingSource, fetcher: ListingFetcher, delayMs: number, sleep: (ms: number) => Promise<void>,
): Promise<SourceRefreshSummary> {
  const rows = getListingsBySource(db, source);
  const tool = source === 'willhaben' ? 'willhaben_get_listing' : 'immoscout_get_listing';
  const summary: SourceRefreshSummary = { checked: 0, updated: 0, delisted: 0, errored: 0, skipped: false };

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
        // Only a genuine transition counts: re-confirming an already-flagged row is not new
        // information, and letting it count would keep the blast-radius guard tripped permanently.
        if (setListingDelisted(db, row.id, true)) summary.delisted++;
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
  db: DB, deps: RefreshDeps, opts: { delayMs?: number; sleep?: (ms: number) => Promise<void>; sources?: SourceName[] } = {},
): Promise<RefreshSummary> {
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // A sweep re-fetches every stored row from its origin, so it is a second, standing source of
  // outbound requests entirely separate from the poller — gate it on the same source set, or
  // disabling a source in the poller would silently leave this hitting it every 6h forever.
  const enabled = new Set(opts.sources ?? resolveSources());

  const summaries = {} as Record<SourceName, SourceRefreshSummary>;
  for (const source of ALL_SOURCES) {
    const fetcher = deps[source];
    summaries[source] = enabled.has(source) && fetcher
      ? await refreshSource(db, source, fetcher, delayMs, sleep)
      : skippedSummary();
  }

  const deletionSkippedFor: ListingSource[] = ALL_SOURCES.filter((s) => exceedsBlastRadius(summaries[s]));
  const deleted = deletionSkippedFor.length > 0 ? 0 : deleteDelistedUnshortlisted(db);

  return { willhaben: summaries.willhaben, immoscout: summaries.immoscout, deleted, deletionSkippedFor };
}
