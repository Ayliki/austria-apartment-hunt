import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Fetcher } from '../src/fetcher.js';

function startServer(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('fetchText returns body on 200', async () => {
  const { server, url } = await startServer((_req, res) => { res.writeHead(200); res.end('hello'); });
  try {
    const f = new Fetcher({ minIntervalMs: 0 });
    assert.equal(await f.fetchText(url), 'hello');
  } finally { server.close(); }
});

test('cookie jar: retries a 401 with the session cookie and succeeds', async () => {
  let calls = 0;
  const { server, url } = await startServer((req, res) => {
    calls++;
    if (req.headers.cookie?.includes('session=abc')) {
      res.writeHead(200); res.end('ok');
    } else {
      res.writeHead(401, { 'Set-Cookie': 'session=abc; Path=/' }); res.end('unauthorized');
    }
  });
  try {
    const f = new Fetcher({ minIntervalMs: 0, sleep: () => Promise.resolve() });
    assert.equal(await f.fetchText(url), 'ok');
    assert.equal(calls, 2);
  } finally { server.close(); }
});

test('throws a specific error on persistent non-200', async () => {
  const { server, url } = await startServer((_req, res) => { res.writeHead(404); res.end('nope'); });
  try {
    const f = new Fetcher({ minIntervalMs: 0, sleep: () => Promise.resolve() });
    await assert.rejects(() => f.fetchText(url), /404/);
  } finally { server.close(); }
});

test('enforces the minimum interval between requests', async () => {
  const { server, url } = await startServer((_req, res) => { res.writeHead(200); res.end('x'); });
  try {
    const f = new Fetcher({ minIntervalMs: 120 });
    const t0 = Date.now();
    await f.fetchText(url);
    await f.fetchText(url);
    assert.ok(Date.now() - t0 >= 110, `second request came too fast (${Date.now() - t0}ms)`);
  } finally { server.close(); }
});
