#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DB, type ListingRow, type UserPrefs,
  openDb, recordSwipe, getShortlist, getUserPrefs, setUserPrefs, MCP_CHAT_ID,
} from './db.js';
import { nextCardFor, getCommuteLineFor, type GeocodeFn, type ComputeCommuteFn } from './bot.js';
import { geocode as realGeocode, computeCommute as realComputeCommute } from './commute.js';

export { MCP_CHAT_ID };

export interface McpDeps {
  geocode: GeocodeFn;
  computeCommute: ComputeCommuteFn;
}

export function formatCardPayload(l: ListingRow, commuteLine?: string | null) {
  return {
    id: l.id,
    title: l.title,
    price: l.price,
    area: l.area,
    rooms: l.rooms,
    district: l.district,
    url: l.url,
    images: l.images,
    description: l.description,
    valueFlag: l.valueFlag,
    requiresWaitlistTicket: l.requiresWaitlistTicket,
    isWg: l.isWg,
    commute: commuteLine ?? null,
  };
}

interface PrefsArgs {
  price_to: number;
  price_from?: number;
  districts?: number[];
  rooms_from?: number;
  rooms_to?: number;
  area_from?: number;
  area_to?: number;
  include_waitlist_housing?: boolean;
  include_wg?: boolean;
}

/** Maps the non-commute fields; commute_destination needs an async geocode call, handled separately in the swipe_set_prefs handler. */
export function mapPrefsArgs(args: PrefsArgs): Omit<UserPrefs, 'chatId' | 'commuteDestination' | 'commuteLat' | 'commuteLon'> {
  return {
    priceTo: args.price_to,
    priceFrom: args.price_from ?? null,
    districts: args.districts ?? null,
    roomsFrom: args.rooms_from ?? null,
    roomsTo: args.rooms_to ?? null,
    areaFrom: args.area_from ?? null,
    areaTo: args.area_to ?? null,
    includeWaitlistHousing: args.include_waitlist_housing ?? true,
    includeWg: args.include_wg ?? false,
  };
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
}

async function cardWithCommute(db: DB, deps: McpDeps, card: ListingRow) {
  const prefs = getUserPrefs(db, MCP_CHAT_ID);
  const commuteLine = prefs ? await getCommuteLineFor(db, MCP_CHAT_ID, card, prefs, deps.computeCommute, deps.geocode) : null;
  return formatCardPayload(card, commuteLine);
}

function buildServer(db: DB, deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'swipe-bot', version: '0.1.0' });

  server.registerTool(
    'swipe_next_card',
    {
      description:
        'Get the next ranked, not-yet-swiped Vienna apartment listing (with photo URLs) for your ' +
        'swipe-bot preferences. Call swipe_set_prefs first if you have not set preferences yet.',
      inputSchema: {},
    },
    async () => {
      try {
        if (!getUserPrefs(db, MCP_CHAT_ID)) {
          return jsonResult({ message: 'No preferences set yet — call swipe_set_prefs first.' });
        }
        const card = nextCardFor(db, MCP_CHAT_ID);
        if (!card) return jsonResult({ message: 'No new listings right now — check back after the next poll (every ~3h).' });
        return jsonResult(await cardWithCommute(db, deps, card));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'swipe_record',
    {
      description: 'Record a like or pass on a listing by id, then return the next card.',
      inputSchema: {
        listing_id: z.string().describe('The listing id from swipe_next_card, e.g. "willhaben:1234567890"'),
        direction: z.enum(['like', 'pass']),
      },
    },
    async ({ listing_id, direction }) => {
      try {
        recordSwipe(db, MCP_CHAT_ID, listing_id, direction);
        const next = nextCardFor(db, MCP_CHAT_ID);
        return jsonResult({
          recorded: { listing_id, direction },
          next: next ? await cardWithCommute(db, deps, next) : { message: 'No more listings right now.' },
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'swipe_shortlist',
    { description: 'List all listings you have liked (👍) via swipe-bot.', inputSchema: {} },
    async () => {
      try {
        return jsonResult(getShortlist(db, MCP_CHAT_ID).map((l) => formatCardPayload(l)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'swipe_set_prefs',
    {
      description: 'Set or update your Vienna apartment search preferences for swipe-bot. Overwrites all fields each call — omitted optional fields reset to unset, so include everything you want to keep, not just what changed.',
      inputSchema: {
        price_to: z.number().describe('Max monthly rent (cold) in EUR'),
        price_from: z.number().optional().describe('Min monthly rent in EUR'),
        districts: z.array(z.number().int().min(1).max(23)).optional().describe('Vienna districts to keep, e.g. [1,2,3,4,5,6,7,8,9]'),
        rooms_from: z.number().optional(),
        rooms_to: z.number().optional(),
        area_from: z.number().optional().describe('Min size in m²'),
        area_to: z.number().optional().describe('Max size in m²'),
        include_waitlist_housing: z.boolean().optional().describe(
          'Include municipal/non-profit housing that requires a Vormerkschein, Wohnticket, or Wiener ' +
          'Wohnen registration (Gemeindewohnung, Genossenschaft, Direktvergabe)? Not everyone is eligible ' +
          'for these. Defaults to true.'
        ),
        include_wg: z.boolean().optional().describe(
          'Include WG-Zimmer (shared-flat rooms), co-living, and student rooms — not whole apartments? ' +
          'Defaults to false.'
        ),
        commute_destination: z.string().optional().describe(
          'Daily commute destination, e.g. "TU Wien" or an address. Geocoded server-side; every future ' +
          'card will show walk/transit ETAs to it. Omit to clear any previously set destination.'
        ),
      },
    },
    async (args) => {
      try {
        let commute: { commuteDestination: string | null; commuteLat: number | null; commuteLon: number | null } =
          { commuteDestination: null, commuteLat: null, commuteLon: null };
        if (args.commute_destination) {
          const point = await deps.geocode(args.commute_destination);
          if (!point) return errorResult(new Error(`couldn't find location "${args.commute_destination}"`));
          commute = { commuteDestination: args.commute_destination, commuteLat: point.lat, commuteLon: point.lon };
        }
        setUserPrefs(db, { chatId: MCP_CHAT_ID, ...mapPrefsArgs(args), ...commute });
        return jsonResult({ saved: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/\.ts$/, '.js'));
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url)); // swipe-bot/dist
  try {
    process.loadEnvFile(join(here, '..', '.env')); // Claude Code launches this MCP server without an env file of its own
  } catch {
    // .env is optional — GOOGLE_MAPS_API_KEY just won't be set, and commute calls degrade to nulls
  }
  const dbPath = process.env.SWIPE_BOT_DB_PATH ?? join(here, '..', 'data', 'bot.sqlite');
  const db = openDb(dbPath);
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
  const deps: McpDeps = {
    geocode: (address) => realGeocode(address, apiKey),
    computeCommute: (origin, destination) => realComputeCommute(origin, destination, apiKey),
  };
  await buildServer(db, deps).connect(new StdioServerTransport());
}
