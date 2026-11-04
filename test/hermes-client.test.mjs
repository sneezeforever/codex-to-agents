import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { HermesClient, hermesUrl } from '../src/hermes-client.mjs';

async function fixture(t, timeout = 2000) {
  const requests = [];
  const sockets = [];
  const state = { token: randomUUID(), reply: message => ({ jsonrpc: '2.0', id: message.id, result: { ok: true } }) };
  const server = createServer((req, res) => {
    requests.push({ path: req.url, token: req.headers['x-hermes-session-token'] });
    if (req.url === '/') res.end(`<html><script>window.__HERMES_SESSION_TOKEN__="${state.token}";</script></html>`);
    else if (req.url === '/redirect') res.writeHead(302, { Location: '/must-not-follow' }).end();
    else if (req.headers['x-hermes-session-token'] !== state.token) res.writeHead(401).end();
    else res.setHeader('Content-Type', 'application/json').end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  class Socket extends EventTarget {
    constructor(url) {
      super();this.url = url;this.readyState = 0;sockets.push(this);
      queueMicrotask(() => { this.readyState = 1;this.dispatchEvent(new Event('open')); });
    }
    send(data) {
      const request = JSON.parse(data);const response = state.reply(request, this);
      if (response) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(response) })));
    }
    close() { if (this.readyState === 3) return;this.readyState = 3;this.dispatchEvent(new Event('close')); }
  }
  const client = new HermesClient({ url: `http://127.0.0.1:${server.address().port}`, timeout, tokenEnv: 'CTA_TEST_UNUSED_TOKEN' }, { WebSocket: Socket });
  t.after(async () => { client.close();await new Promise(resolve => server.close(resolve)); });
  return { client, state, requests, sockets };
}

test('Hermes accepts only loopback origins and refuses credentials, paths and token-bearing URLs', () => {
  assert.equal(hermesUrl(), 'http://127.0.0.1:9120');
  assert.equal(hermesUrl('https://localhost:9120'), 'https://localhost:9120');
  for (const url of ['https://example.org', 'http://127.0.0.1.evil.org', 'http://user:pass@localhost:9120', 'http://localhost/api', 'http://localhost/?token=secret', 'file:///etc/passwd']) {
    assert.throws(() => hermesUrl(url));
  }
});

test('local Dashboard bootstrap authenticates HTTP and RPC; redirects never forward the session credential', async t => {
  const { client, state, requests, sockets } = await fixture(t);
  assert.deepEqual(await client.request('/api/models'), { ok: true });
  assert.equal(requests[0].token, undefined);assert.equal(requests[1].token, state.token);
  assert.deepEqual(await client.call('session.active_list'), { ok: true });
  assert.equal(new URL(sockets[0].url).pathname, '/api/ws');
  assert.equal(new URL(sockets[0].url).searchParams.get('token'), state.token);
  await assert.rejects(client.request('/redirect'), /HTTP connection failed/);
  assert.ok(!requests.some(request => request.path === '/must-not-follow'));
});

test('RPC rejection is definite while timeout or disconnect preserves unknown delivery without replay', async t => {
  const { client, state, sockets } = await fixture(t, 100);
  state.reply = message => ({ jsonrpc: '2.0', id: message.id, error: { code: 4007, message: 'session not found' } });
  await assert.rejects(client.call('session.resume'), error => error.definite === true && error.rpcCode === 4007);
  let count = 0;state.reply = () => { count++;return null; };
  await assert.rejects(client.call('prompt.submit'), error => error.deliveryUnknown === true);
  assert.equal(count, 1);
  const pending = client.call('prompt.submit');
  await new Promise(resolve => setImmediate(resolve));sockets[0].close();
  await assert.rejects(pending, error => error.deliveryUnknown === true);
  assert.equal(count, 2);
});

test('a reconnect refreshes the ephemeral token and forwards only native event frames', async t => {
  const { client, state, sockets } = await fixture(t);
  const events = [];client.onEvent = event => events.push(event);
  await client.call('session.active_list');
  const generation = client.generation;
  sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 'one', payload: { text: 'hi' } } }) }));
  assert.equal(events.length, 1);
  const previousToken = state.token;
  sockets[0].close();state.token = randomUUID();
  await client.call('session.active_list');
  assert.notEqual(client.generation, generation);
  assert.notEqual(state.token, previousToken);
  assert.equal(new URL(sockets[1].url).searchParams.get('token'), state.token);
  sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'event', params: { type: 'stale' } }) }));
  assert.equal(events.length, 1);
});
