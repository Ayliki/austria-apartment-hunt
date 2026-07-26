import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { McpConnection } from '../src/mcp-client.js';

const ECHO = fileURLToPath(new URL('./fixtures/echo-server.ts', import.meta.url));
// Run the fixture server through tsx (it is TypeScript).
const spec = { command: 'npx', args: ['tsx', ECHO] };

test('callToolText round-trips over stdio and reuses the connection', async () => {
  const conn = new McpConnection(spec);
  await conn.connect();
  try {
    assert.equal(await conn.callToolText('echo', { msg: 'one' }), 'echo:one');
    assert.equal(await conn.callToolText('echo', { msg: 'two' }), 'echo:two');
  } finally {
    await conn.close();
  }
});

test('callToolText throws on isError results', async () => {
  const conn = new McpConnection(spec);
  await conn.connect();
  try {
    await assert.rejects(() => conn.callToolText('fail', {}), /fail failed: boom/);
  } finally {
    await conn.close();
  }
});
