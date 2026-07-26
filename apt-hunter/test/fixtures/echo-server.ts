#!/usr/bin/env node
// Minimal MCP server for testing apt-hunter's client: echoes tool args back as text,
// and returns isError for the tool name "fail".
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '0.0.1' });
server.registerTool('echo', { inputSchema: { msg: z.string() } }, async ({ msg }) => ({
  content: [{ type: 'text' as const, text: `echo:${msg}` }],
}));
server.registerTool('fail', { inputSchema: {} }, async () => ({
  content: [{ type: 'text' as const, text: 'boom' }],
  isError: true,
}));
await server.connect(new StdioServerTransport());
