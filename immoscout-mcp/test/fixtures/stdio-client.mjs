#!/usr/bin/env node
// Usage: node test/fixtures/stdio-client.mjs <server-cmd...> -- <tool> <json-args>
// Spawns the MCP server, calls one tool, prints the text content to stdout.
import { spawn } from 'node:child_process';

const sep = process.argv.indexOf('--');
const serverCmd = process.argv.slice(2, sep);
const [tool, jsonArgs] = process.argv.slice(sep + 1);

const proc = spawn(serverCmd[0], serverCmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let id = 0;
function send(method, params) {
  const msg = { jsonrpc: '2.0', id: ++id, method, params };
  proc.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => rej(new Error('timeout waiting for response id ' + id)), 120000);
  });
}
proc.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } catch { /* not JSON — ignore */ }
  }
});

await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'stdio-smoke', version: '0.0.1' },
});
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const res = await send('tools/call', { name: tool, arguments: JSON.parse(jsonArgs) });
console.log(res.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(res));
if (res.result?.isError) process.exitCode = 1;
proc.kill();
