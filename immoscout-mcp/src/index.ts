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
