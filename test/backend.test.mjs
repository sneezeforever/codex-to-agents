import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ensureBackend, stopBackend, backendAuth, backendStatus } from '../src/backend-control.mjs';
import { lazyHermes } from '../src/hermes-loader.mjs';
import { lazyQoder } from '../src/qoder-loader.mjs';
import { OrderBook } from '../src/orders.mjs';

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    await delay(25);
  }
  return false;
}

async function fixture(t) {
  const home = await mkdtemp('/tmp/cta-backend-');
  // Backend tests must never reach the production statistics endpoint now that
  // an absent preference defaults to enabled.
  await writeFile(join(home, 'usage-settings.json'), '{"enabled":false}\n');
  t.after(async () => { await stopBackend(home);await rm(home, { recursive: true, force: true }); });
  return home;
}

test('concurrent startup and HTTP clients share one backend; connection close and restart retain idempotent orders', async t => {
  const home = await fixture(t);
  const started = await Promise.all(Array.from({ length: 6 }, () => ensureBackend(home)));
  assert.equal(new Set(started.map(value => value.pid)).size, 1);
  const address = started[0].url;
  const headers = await backendAuth(home);
  const clients = [];
  const connect = async path => {
    const client = new Client({ name: 'shared-http-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(address + path), { requestInit: { headers } }));
    clients.push(client);return client;
  };
  try {
    const [a, b, panel] = await Promise.all([connect('/mcp'), connect('/mcp'), connect('/board')]);
    assert.deepEqual((await a.listTools()).tools.map(tool => tool.name).sort(),
      ['conversation_control', 'runtime_info', 'sdd_task', 'work_inspect', 'work_submit', 'work_update', 'work_wait', 'workspace_control']);
    assert.deepEqual((await panel.listTools()).tools.map(tool => tool.name).sort(), ['open_panel', 'panel_sdd', 'panel_settings', 'panel_snapshot', 'panel_update', 'panel_usage']);
    const payload = { order_id: randomUUID(), goal: 'offline shared work' };
    const submitted = await Promise.all([a, b].map(client => client.callTool({ name: 'work_submit', arguments: payload })));
    assert.deepEqual(submitted.map(value => value.structuredContent.reused).sort(), [false, true]);
    const snapshot = () => panel.callTool({ name: 'panel_snapshot', arguments: {} }).then(value => value.structuredContent);
    // The board snapshot must be settings-only: no work-order rows, groups or
    // bodies cross this app-only surface even while the saved order exists.
    const board = await snapshot();
    assert.equal(board.service.pid, started[0].pid);
    assert.equal(board.service.hermes_loaded, false);
    assert.equal(board.service.qoder_loaded, false);
    assert.deepEqual(Object.keys(board).sort(), ['activation', 'delegation', 'generated_at', 'service', 'usage', 'warnings', 'worker']);
    assert.ok(!JSON.stringify(board).includes(payload.goal), 'the board snapshot never returns work-order text');
    assert.deepEqual(board.warnings, []);
    await panel.callTool({ name: 'panel_snapshot', arguments: { executor: 'dsh', refresh_models: true } });
    assert.equal((await backendStatus(home)).hermes_loaded, false);
    assert.equal((await backendStatus(home)).qoder_loaded, false);
    await panel.callTool({ name: 'panel_settings', arguments: { enabled: false, executor: 'dsh' } });
    assert.equal((await snapshot()).delegation.executor, 'dsh');
    await a.close();
    assert.equal((await backendStatus(home)).pid, started[0].pid);
    assert.equal((await b.callTool({ name: 'work_inspect', arguments: { order_id: payload.order_id } })).structuredContent.status, 'queued');
    await stopBackend(home);const restarted = await ensureBackend(home);
    assert.notEqual(restarted.pid, started[0].pid);assert.equal(restarted.url, address);
    const same = await b.callTool({ name: 'work_submit', arguments: payload });
    assert.equal(same.structuredContent.reused, true);
    assert.equal((await b.callTool({ name: 'work_inspect', arguments: {} })).structuredContent.total, 1,
      'the model-facing inspection path still lists saved work');
  } finally { await Promise.all(clients.map(client => client.close())); }
});

test('shared backend rejects foreign origins and missing credentials; private token is absent from endpoint metadata', async t => {
  const home = await fixture(t);const backend = await ensureBackend(home);
  const headers = await backendAuth(home);
  assert.equal((await fetch(backend.url + '/health')).status, 403);
  assert.equal((await fetch(backend.url + '/health', { headers: { ...headers, Origin: 'https://example.org' } })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    const req = request(backend.url + '/health', { headers: { ...headers, Host: 'example.org' } }, res => { res.resume();resolve(res.statusCode); });
    req.on('error', reject);req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(backend.url + '/mcp', { headers })).status, 405);
  assert.equal((await stat(join(home, 'backend-auth.json'))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(join(home, 'backend.json'), 'utf8')).includes(headers.Authorization.slice(7)));
});

test('Hermes loads only for unfinished Hermes work, while completed and DSH work leave it unloaded', async t => {
  const home = await fixture(t);const book = new OrderBook(home);await book.open();
  await writeFile(join(home, 'settings.json'), JSON.stringify({ hermes: { url: 'http://127.0.0.1:9120' } }));
  await book.submit('work_submit', { goal: 'DSH work' });
  const finished = await book.submit('work_submit', { executor: 'hermes', goal: 'finished Hermes work' });
  await book.transition(finished.order_id, 'completed');
  let started = 0;let closed = 0;
  const loader = lazyHermes(home, { load: async () => ({ startHermesWorker: () => { started++;return { async close() { closed++; } }; } }) });
  try {
    await loader.check();assert.equal(loader.state.loaded, false);assert.equal(started, 0);
    await book.submit('work_submit', { executor: 'hermes', goal: 'new Hermes work' });
    await loader.check();await loader.check();
    assert.equal(loader.state.loaded, true);assert.equal(started, 1);
  } finally { await loader.close(); }
  assert.equal(closed, 1);
});

test('Qoder loads only for configured, unfinished Qoder work and stays unloaded otherwise', async t => {
  const home = await fixture(t);const book = new OrderBook(home);await book.open();
  let started = 0;let closed = 0;
  const loader = lazyQoder(home, { load: async () => ({ startExecutorWorker: () => { started++;return { async close() { closed++; } }; } }) });
  try {
    await loader.check();assert.equal(loader.state.loaded, false);assert.equal(started, 0);
    const unconfigured = await book.submit('work_submit', { executor: 'qoder', goal: 'no configuration' });
    await loader.check();assert.equal(started, 0, 'no settings means no worker');
    await book.transition(unconfigured.order_id, 'completed');
    await writeFile(join(home, 'settings.json'), JSON.stringify({ qoder: { executable: '/opt/qodercli' } }));
    // Only a completed order must not wake the worker.
    const finished = await book.submit('work_submit', { executor: 'qoder', goal: 'finished qoder work' });
    await book.transition(finished.order_id, 'completed');
    await loader.check();assert.equal(started, 0);
    await book.submit('work_submit', { executor: 'qoder', goal: 'new qoder work' });
    await loader.check();await loader.check();
    assert.equal(loader.state.loaded, true);assert.equal(started, 1);
    // A reconnect request starts it even before the first order exists.
    await writeFile(join(home, 'settings.json'), JSON.stringify({ qoder: { executable: '/opt/other' } }));
    await loader.check({ force: true });
    assert.equal(started, 2);assert.equal(closed, 1, 'a settings change replaces the worker');
  } finally { await loader.close(); }
  assert.equal(closed, started);
});

test('a runtime query can initialize Hermes before the first order; settings changes replace or stop the consumer', async t => {
  const home = await fixture(t);
  const path = join(home, 'settings.json');
  await writeFile(path, JSON.stringify({ hermes: { url: 'http://127.0.0.1:9120' } }));
  const started = [];const closed = [];
  const loader = lazyHermes(home, { load: async () => ({ startHermesWorker: (_home, settings) => {
    started.push(settings.url);return { async close() { closed.push(settings.url); } };
  } }) });
  try {
    await loader.check();assert.equal(started.length, 0);
    await loader.check({ force: true });
    assert.deepEqual(started, ['http://127.0.0.1:9120']);
    await writeFile(path, JSON.stringify({ hermes: { url: 'http://127.0.0.1:9121' } }));
    await loader.check({ force: true });
    assert.deepEqual(started, ['http://127.0.0.1:9120', 'http://127.0.0.1:9121']);
    assert.deepEqual(closed, ['http://127.0.0.1:9120']);
    await writeFile(path, '{}');await loader.check();
    assert.deepEqual(closed, started);
  } finally { await loader.close(); }
  assert.deepEqual(closed, started);
});

test('HTTP work_wait abort and client disconnect release the observation and keep the backend serving', { timeout: 30000 }, async t => {
  const home = await fixture(t);
  const backend = await ensureBackend(home);
  const headers = await backendAuth(home);
  const book = new OrderBook(home);await book.open();
  const order = await book.submit('work_submit', { goal: 'http wait abort fixture' });
  const clients = [];
  const connect = async name => {
    const client = new Client({ name, version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(backend.url + '/mcp'), { requestInit: { headers } }));
    clients.push(client);return client;
  };
  try {
    const client = await connect('http-wait-abort');
    const controller = new AbortController();
    const rejection = client.callTool({ name: 'work_wait', arguments: { order_id: order.order_id, timeout_ms: 10000 } }, undefined, { signal: controller.signal })
      .then(() => null, error => error);
    await delay(200);
    const abortedAt = Date.now();
    controller.abort();
    assert.ok(await rejection, 'the HTTP caller abort rejects its pending wait');
    const inspect = await client.callTool({ name: 'work_inspect', arguments: { order_id: order.order_id } }, undefined, { timeout: 1500 });
    const queryMs = Date.now() - abortedAt;
    assert.equal(inspect.structuredContent.status, 'queued');
    assert.ok(queryMs < 1200, `an HTTP query after abort must return promptly, took ${queryMs}ms`);
    // Disconnect while another observation is in flight; a fresh HTTP client
    // must still be served promptly and the order must stay untouched.
    const inFlight = client.callTool({ name: 'work_wait', arguments: { order_id: order.order_id, timeout_ms: 10000 } })
      .then(() => null, error => error);
    await delay(150);
    await client.close();
    await inFlight;
    const fresh = await connect('http-wait-abort-after-disconnect');
    const freshAt = Date.now();
    const listed = await fresh.listTools({}, { timeout: 1500 });
    assert.ok(listed.tools.some(tool => tool.name === 'work_wait'));
    assert.ok(Date.now() - freshAt < 1200, 'a fresh client is served after the previous one disconnects');
    assert.equal((await backendStatus(home)).online, true);
    const zero = await fresh.callTool({ name: 'work_wait', arguments: { order_id: order.order_id, timeout_ms: 0 } }, undefined, { timeout: 1500 });
    assert.equal(zero.structuredContent.timed_out, true);
    assert.equal((await book.inspect(order.order_id)).status, 'queued', 'abort/disconnect never cancels or mutates the work order');
    // Aborted observations must not keep the backend process alive after stop.
    const backendPid = (await backendStatus(home)).pid;
    await stopBackend(home).catch(() => {});
    assert.equal(await waitForProcessExit(backendPid, 3000), true, 'the backend exits after stop, so no aborted observation kept it alive');
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await stopBackend(home).catch(() => {});
  }
});
