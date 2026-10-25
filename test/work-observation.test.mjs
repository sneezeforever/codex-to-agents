import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OrderBook } from '../src/orders.mjs';
import { createMcp } from '../src/mcp.mjs';
import {
  OrderObserver, summarizeOrder, DETAIL_HINT, WAIT_DEFAULT_TIMEOUT_MS, WAIT_MAX_TIMEOUT_MS,
} from '../src/work-observation.mjs';

const ordersModule = pathToFileURL(fileURLToPath(new URL('../src/orders.mjs', import.meta.url))).href;
const root = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t) {
  const home = await mkdtemp('/tmp/cta-observe-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const book = new OrderBook(home);await book.open();
  return { home, book };
}

async function mcp(home) {
  const server = await createMcp(home);
  const client = new Client({ name: 'observation-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  return { server, client };
}

const call = async (client, name, args = {}) => {
  try { return await client.callTool({ name, arguments: args }); }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
};

test('the bounded summary keeps large output, events, goal and catalog on disk', async t => {
  const f = await fixture(t);
  const big = {
    goal: `GOAL-LEAK-${'g'.repeat(50000)}`,
    outputText: `${'o'.repeat(200000)}OUTPUT-TAIL-LEAK`,
    progress: `PROGRESS-HEAD-LEAK${'p'.repeat(5000)}`,
    error: `ERROR-${'e'.repeat(4000)}ERROR-TAIL-LEAK`,
  };
  const state = {
    order_id: randomUUID(), kind: 'work_submit', executor: 'dsh', status: 'completed',
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:01:00.000Z', conversation_id: 'cw-large',
    progress: big.progress, error: big.error,
    output: { text: big.outputText, native_reason: { kind: 'completed' } },
    events: Array.from({ length: 40 }, (_value, index) => ({ at: `2026-10-01T00:00:${String(index).padStart(2, '0')}.000Z`, status: 'executing' })),
  };
  const worker = {
    online: true,
    snapshot: { catalog: { models: Array.from({ length: 500 }, (_value, index) => ({ provider: 'p', model: `MODEL-LEAK-${index}` })) } },
  };
  const summary = summarizeOrder(state, worker);
  const summaryJson = JSON.stringify(summary);
  const detailJson = JSON.stringify({ ...state, worker });
  t.diagnostic(JSON.stringify({ summary_bytes: summaryJson.length, detail_bytes: detailJson.length, ratio: +(detailJson.length / summaryJson.length).toFixed(1) }));
  assert.ok(summaryJson.length < 2500, `summary stays bounded: ${summaryJson.length}`);
  for (const leak of ['GOAL-LEAK', 'OUTPUT-TAIL-LEAK', 'MODEL-LEAK', 'EVENT-LEAK', 'native_reason']) {
    assert.ok(!summaryJson.includes(leak), `summary must not leak ${leak}`);
  }
  assert.equal(summary.status, 'completed');
  assert.equal(summary.truncated, true);
  assert.equal(summary.detail_hint, DETAIL_HINT);
  assert.deepEqual(summary.worker, { online: true });
  assert.ok(summary.result.endsWith('… [truncated; call work_inspect with view:"detail" for the full record]'));
  assert.ok(summary.progress.endsWith('… [truncated; call work_inspect with view:"detail" for the full record]'), 'progress keeps its most recent tail');
  assert.ok(detailJson.includes('OUTPUT-TAIL-LEAK') && detailJson.includes('MODEL-LEAK'), 'the full record still exists for detail');
  assert.ok(detailJson.length > summaryJson.length * 50);
});

test('work_inspect defaults to the bounded summary and detail keeps the complete record', async t => {
  const f = await fixture(t);
  const order = await f.book.submit('work_submit', { goal: `GOAL-LEAK-${'g'.repeat(40000)}` });
  await f.book.runtime({ active: true, protocol: 2, at: new Date().toISOString(),
    catalog: { models: Array.from({ length: 300 }, (_value, index) => ({ provider: 'p', model: `MODEL-LEAK-${index}`, efforts: [] })) } });
  await f.book.transition(order.order_id, 'completed', {
    conversation_id: 'cw-summary',
    progress: `PROGRESS-HEAD-LEAK${'p'.repeat(4000)}`,
    output: { text: `${'o'.repeat(150000)}OUTPUT-TAIL-LEAK`, native_reason: { kind: 'completed' } },
  });
  const { server, client } = await mcp(f.home);
  t.after(async () => { await client.close();await server.close(); });
  // Background catalog observation is not part of a summary read.
  const summary = (await call(client, 'work_inspect', { order_id: order.order_id })).structuredContent;
  const detail = (await call(client, 'work_inspect', { order_id: order.order_id, view: 'detail' })).structuredContent;
  const summaryJson = JSON.stringify(summary);
  const detailJson = JSON.stringify(detail);
  t.diagnostic(JSON.stringify({ summary_bytes: summaryJson.length, detail_bytes: detailJson.length }));
  assert.ok(summaryJson.length < 2500);
  assert.equal(summary.output, undefined);
  assert.equal(summary.events, undefined);
  assert.equal(summary.truncated, true);
  assert.deepEqual(summary.worker, { online: true });
  for (const leak of ['GOAL-LEAK', 'OUTPUT-TAIL-LEAK', 'MODEL-LEAK', 'native_reason']) assert.ok(!summaryJson.includes(leak));
  assert.equal(detail.events.length, 1);
  assert.equal(detail.conversation_id, 'cw-summary');
  assert.ok(detail.output.text.includes('OUTPUT-TAIL-LEAK'));
  assert.ok(detail.worker.snapshot.catalog.models.some(model => model.model.startsWith('MODEL-LEAK')));
  assert.ok(detailJson.length > summaryJson.length * 20);
  // Without order_id the recent page stays paginated and carries liveness only.
  const page = (await call(client, 'work_inspect', {})).structuredContent;
  assert.equal(page.total, 1);
  assert.equal(page.orders[0].order_id, order.order_id);
  assert.equal(page.orders[0].output, undefined);
  assert.deepEqual(page.worker, { online: true, executors: { dsh: { online: true }, hermes: { online: false }, qoder: { online: false } } });
  assert.equal((await f.book.list()).length, 1, 'inspection never creates work');
});

test('a same-process transition resolves the wait and long progress text does not settle it', async t => {
  const f = await fixture(t);
  const observer = new OrderObserver(f.home, { pollInterval: 60 });
  t.after(() => observer.close());
  const order = await f.book.submit('work_submit', { goal: 'wait for me' });
  await f.book.transition(order.order_id, 'executing', { conversation_id: 'cw-wait', progress: 'first' });
  const started = Date.now();
  const waiting = observer.wait(order.order_id, { timeoutMs: 350 });
  assert.equal(observer.pending, 1, 'the waiter is tracked while in flight');
  await delay(80);
  await f.book.transition(order.order_id, 'executing', { progress: `${'p'.repeat(5000)}second` });
  const timedOut = await waiting;
  const elapsed = Date.now() - started;
  assert.equal(timedOut.timed_out, true);
  assert.equal(timedOut.status, 'executing');
  assert.equal(timedOut.needs_attention, undefined);
  assert.ok(elapsed >= 300, `a timeout is reported after the deadline, not on progress: ${elapsed}`);
  assert.match(timedOut.progress, /second… \[truncated/);
  assert.ok(timedOut.progress.length < 400);
  assert.equal(observer.pending, 0, 'resolution releases the waiter');
  await f.book.transition(order.order_id, 'completed', { output: { text: 'done later' } });
  assert.equal((await f.book.inspect(order.order_id)).status, 'completed');
});

test('progress-only rewrites never settle the wait; only a real transition does', async t => {
  const f = await fixture(t);
  const observer = new OrderObserver(f.home, { pollInterval: 5000 });
  t.after(() => observer.close());
  const order = await f.book.submit('work_submit', { goal: 'progress only' });
  await f.book.transition(order.order_id, 'executing', { conversation_id: 'cw-progress', progress: 'tick 0' });
  const waiting = observer.wait(order.order_id, { timeoutMs: 3000 });
  let settled = false;
  waiting.then(() => { settled = true; }, () => {});
  await delay(80);
  for (let tick = 1; tick <= 5; tick++) {
    await f.book.transition(order.order_id, 'executing', { progress: `tick ${tick}` });
  }
  await delay(150);
  assert.equal(settled, false, 'progress-only rewrites are not a terminal result');
  assert.equal(observer.pending, 1);
  await f.book.transition(order.order_id, 'completed', { output: { text: 'settled' } });
  const result = await waiting;
  assert.equal(result.status, 'completed');
  assert.equal(result.timed_out, false);
  assert.equal(result.needs_attention, undefined);
  assert.equal(observer.pending, 0);
});

test('a terminal state resolves immediately and an uncertain order returns needs_attention', async t => {
  const f = await fixture(t);
  const observer = new OrderObserver(f.home, { pollInterval: 60 });
  t.after(() => observer.close());
  const done = await f.book.submit('work_submit', { goal: 'already done' });
  await f.book.transition(done.order_id, 'completed', { output: { text: 'finished result' } });
  const result = await observer.wait(done.order_id, { timeoutMs: 5000 });
  assert.equal(result.timed_out, false);
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'finished result');

  const unsure = await f.book.submit('work_submit', { goal: 'maybe sent' });
  await f.book.transition(unsure.order_id, 'uncertain', { progress: 'delivery outcome unknown' });
  const started = Date.now();
  const attention = await observer.wait(unsure.order_id, { timeoutMs: 5000 });
  assert.ok(Date.now() - started < 1000, 'uncertain must not block until timeout');
  assert.equal(attention.needs_attention, true);
  assert.equal(attention.timed_out, false);
  assert.equal(attention.status, 'uncertain');
  assert.equal(observer.pending, 0);
});

test('timeout 0 returns the current summary without waiting; offline is never completion', async t => {
  const f = await fixture(t);
  const observer = new OrderObserver(f.home, { pollInterval: 60 });
  t.after(() => observer.close());
  const queued = await f.book.submit('work_submit', { goal: 'still queued' });
  const zeroStarted = Date.now();
  const immediate = await observer.wait(queued.order_id, { timeoutMs: 0 });
  assert.ok(Date.now() - zeroStarted < 250);
  assert.equal(immediate.timed_out, true);
  assert.equal(immediate.status, 'queued');
  assert.equal(immediate.worker.online, false);

  await f.book.transition(queued.order_id, 'executing', { conversation_id: 'cw-offline' });
  await f.book.runtime({ active: false, protocol: 2, at: new Date().toISOString(), catalog: { models: [] } });
  const offline = await observer.wait(queued.order_id, { timeoutMs: 250 });
  assert.equal(offline.timed_out, true);
  assert.equal(offline.status, 'executing');
  assert.equal(offline.worker.online, false, 'offline evidence does not pretend the order finished');

  await f.book.transition(queued.order_id, 'completed', { output: { text: 'after all' } });
  assert.equal((await observer.wait(queued.order_id, { timeoutMs: 0 })).timed_out, false);
  assert.equal((await observer.wait(queued.order_id, { timeoutMs: 0 })).status, 'completed');
});

test('a terminal transition racing the initial read is never lost', async t => {
  const f = await fixture(t);
  // A 5s fallback poll proves resolution comes from the notification paths, not
  // from a lucky later read.
  const observer = new OrderObserver(f.home, { pollInterval: 5000 });
  t.after(() => observer.close());
  const order = await f.book.submit('work_submit', { goal: 'race the first read' });
  const waiting = observer.wait(order.order_id, { timeoutMs: 3000 });
  const transition = f.book.transition(order.order_id, 'completed', { output: { text: 'raced result' } });
  const [result] = await Promise.all([waiting, transition]);
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'raced result');
  assert.equal(result.timed_out, false);
});

test('a completion published by another process wakes the file watcher', async t => {
  const f = await fixture(t);
  const observer = new OrderObserver(f.home, { pollInterval: 5000 });
  t.after(() => observer.close());
  const order = await f.book.submit('work_submit', { goal: 'finish elsewhere' });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { setTimeout as delay } from 'node:timers/promises';
    const { OrderBook } = await import(${JSON.stringify(ordersModule)});
    await delay(150);
    const book = new OrderBook(${JSON.stringify(f.home)});
    await book.transition(${JSON.stringify(order.order_id)}, 'completed', { output: { text: 'external completion' } });
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';child.stderr.setEncoding('utf8');child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const started = Date.now();
  const result = await observer.wait(order.order_id, { timeoutMs: 5000 });
  const elapsed = Date.now() - started;
  assert.equal(await closed, 0, stderr);
  assert.equal(result.timed_out, false);
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'external completion');
  assert.ok(elapsed < 3000, `fs.watch must observe the atomic rename well before the 5s fallback: ${elapsed}`);
});

test('multiple waiters settle independently and abort or close releases resources', async t => {
  const f = await fixture(t);
  const observer = new OrderObserver(f.home, { pollInterval: 60 });
  t.after(() => observer.close());
  const order = await f.book.submit('work_submit', { goal: 'shared wait' });
  const first = observer.wait(order.order_id, { timeoutMs: 5000 });
  const second = observer.wait(order.order_id, { timeoutMs: 5000 });
  assert.equal(observer.pending, 2);
  await f.book.transition(order.order_id, 'completed', { output: { text: 'both see this' } });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'completed');assert.equal(b.status, 'completed');
  assert.equal(observer.pending, 0);

  const controller = new AbortController();
  const aborted = observer.wait(order.order_id, { timeoutMs: 10000, signal: controller.signal });
  const other = observer.wait(order.order_id, { timeoutMs: 10000 });
  assert.equal(observer.pending, 2);
  controller.abort();
  await assert.rejects(aborted, error => error.name === 'AbortError');
  assert.equal(observer.pending, 1, 'one cancellation does not cancel another waiter');
  observer.close();
  await assert.rejects(other, error => error.name === 'AbortError');
  assert.equal(observer.pending, 0);
  await assert.rejects(observer.wait(order.order_id), error => error.name === 'AbortError');
});

test('work_wait rejects unknown orders and invalid parameters', async t => {
  const f = await fixture(t);
  const observer = new OrderObserver(f.home, { pollInterval: 60 });
  t.after(() => observer.close());
  await assert.rejects(observer.wait(randomUUID(), { timeoutMs: 0 }), /not found|无法/);
  assert.equal(observer.pending, 0);
  for (const timeoutMs of [-1, 1.5, WAIT_MAX_TIMEOUT_MS + 1]) {
    await assert.rejects(observer.wait(randomUUID(), { timeoutMs }), /timeout_ms/);
  }
  assert.equal(WAIT_DEFAULT_TIMEOUT_MS, 45000);
  assert.equal(WAIT_MAX_TIMEOUT_MS, 55000);
});

test('the MCP surface exposes summary/detail views and a bounded wait without saving work', async t => {
  const f = await fixture(t);
  const order = await f.book.submit('work_submit', { goal: 'mcp wait' });
  await f.book.transition(order.order_id, 'executing', { conversation_id: 'cw-mcp' });
  const { server, client } = await mcp(f.home);
  t.after(async () => { await client.close();await server.close(); });

  const tools = (await client.listTools()).tools;
  const wait = tools.find(tool => tool.name === 'work_wait');
  assert.ok(wait);
  assert.equal(wait.annotations.readOnlyHint, true);
  assert.deepEqual(wait.inputSchema.required, ['order_id']);
  assert.equal(wait.inputSchema.properties.timeout_ms.default, WAIT_DEFAULT_TIMEOUT_MS);
  assert.equal(wait.inputSchema.properties.timeout_ms.maximum, WAIT_MAX_TIMEOUT_MS);
  assert.match(wait.description, /never submits, replays or cancels/i);
  const inspect = tools.find(tool => tool.name === 'work_inspect');
  assert.equal(inspect.inputSchema.properties.view.default, 'summary');
  assert.deepEqual(inspect.inputSchema.properties.view.enum, ['summary', 'detail']);

  const zero = (await call(client, 'work_wait', { order_id: order.order_id, timeout_ms: 0 })).structuredContent;
  assert.equal(zero.timed_out, true);
  assert.equal(zero.status, 'executing');
  const timed = (await call(client, 'work_wait', { order_id: order.order_id, timeout_ms: 120 })).structuredContent;
  assert.equal(timed.timed_out, true);
  // A second call after the transition returns the terminal result.
  await f.book.transition(order.order_id, 'completed', { output: { text: 'mcp completed' } });
  const done = (await call(client, 'work_wait', { order_id: order.order_id, timeout_ms: 5000 })).structuredContent;
  assert.equal(done.timed_out, false);
  assert.equal(done.status, 'completed');
  assert.equal(done.result, 'mcp completed');
  assert.equal((await call(client, 'work_wait', { order_id: randomUUID(), timeout_ms: 0 })).isError, true);
  const invalidTimeout = await call(client, 'work_wait', { order_id: order.order_id, timeout_ms: 60000 });
  assert.equal(invalidTimeout.isError, true);
  const malformed = await call(client, 'work_wait', { order_id: 'my-task' });
  assert.equal(malformed.isError, true);
  assert.equal((await f.book.list()).length, 1, 'waiting never submits or replays work');
});

test('work_wait drops its watchers on MCP disconnect and server close, reading only the target order', async t => {
  const source = `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports, createRequire } from 'node:module';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import { setTimeout as delay } from 'node:timers/promises';
    import { randomUUID } from 'node:crypto';
    const root = ${JSON.stringify(root)};
    const require = createRequire(join(root, 'package.json'));
    const nativeWatch = fs.watch;
    const nativeRead = fsp.readFile;
    const handles = new Set();
    const reads = [];
    fs.watch = (...args) => {
      const handle = nativeWatch(...args);handles.add(handle);
      handle.once('close', () => handles.delete(handle));return handle;
    };
    fsp.readFile = async (file, ...args) => { reads.push(String(file));return nativeRead(file, ...args); };
    syncBuiltinESMExports();
    const { OrderBook } = await import(join(root, 'src/orders.mjs'));
    const { createMcp } = await import(join(root, 'src/mcp.mjs'));
    const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
    const { InMemoryTransport } = await import(require.resolve('@modelcontextprotocol/sdk/inMemory.js'));
    const home = await fsp.mkdtemp(join(tmpdir(), 'cta-wait-cleanup-'));
    await fsp.writeFile(join(home, 'usage-settings.json'), '{"enabled":false}\\n');
    const book = new OrderBook(home);await book.open();
    // Unfinished history with large bodies must never be read by a single-order wait.
    for (let index = 0; index < 30; index++) {
      const id = '00000000-0000-4000-8000-' + String(index).padStart(12, '0');
      await book.submit('work_submit', { order_id: id, goal: 'history ' + index });
      await book.transition(id, 'executing', { conversation_id: 'cw-' + index, progress: 'p'.repeat(4000) });
    }
    const target = await book.submit('work_submit', { goal: 'wait target' });
    await book.transition(target.order_id, 'executing', { conversation_id: 'cw-target', progress: 'working' });
    const connect = async () => {
      const server = await createMcp(home);
      const client = new Client({ name: 'cleanup-probe', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);await client.connect(b);
      return { server, client };
    };
    const setup = async ({ abort }) => {
      const { server, client } = await connect();
      reads.length = 0;
      let promise;
      let controller;
      if (abort) {
        controller = new AbortController();
        promise = client.callTool({ name: 'work_wait', arguments: { order_id: target.order_id, timeout_ms: 45000 } }, undefined, { signal: controller.signal }).catch(error => error.name);
      } else {
        promise = client.callTool({ name: 'work_wait', arguments: { order_id: target.order_id, timeout_ms: 45000 } }).catch(error => error.name);
      }
      for (let index = 0; index < 200 && handles.size === 0; index++) await delay(10);
      const watching = handles.size;
      const historyReads = reads.filter(path => path.startsWith(join(home, 'requests') + '/') || path.startsWith(join(home, 'states') + '/'));
      if (abort) controller.abort();
      else await server.close();
      for (let index = 0; index < 200 && handles.size > 0; index++) await delay(10);
      const after = handles.size;
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      const outcome = await Promise.race([promise, delay(1000, 'unsettled')]);
      return { watching, after, outcome, historyReads };
    };
    const disconnected = await setup({ abort: false });
    const aborted = await setup({ abort: true });
    await delay(50);
    const requests = (await fsp.readdir(join(home, 'requests'))).length;
    console.log(JSON.stringify({
      watching: disconnected.watching, afterDisconnect: disconnected.after,
      abortWatching: aborted.watching, afterAbort: aborted.after,
      abortedOutcome: aborted.outcome,
      historyReads: disconnected.historyReads.length,
      onlyTargetReads: disconnected.historyReads.every(path => path.includes(target.order_id)),
      requests, remainingHandles: handles.size,
    }));
    await fsp.rm(home, { recursive: true, force: true });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject);child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout.trim());
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.watching, 1, 'the wait installs its watcher while pending');
  assert.equal(result.afterDisconnect, 0, 'MCP disconnect closes the watcher');
  assert.equal(result.abortWatching, 1);
  assert.equal(result.afterAbort, 0, 'tool cancellation closes the watcher');
  assert.equal(result.remainingHandles, 0);
  assert.ok(result.historyReads <= 8, `single-order waiting reads only the target: ${result.historyReads}`);
  assert.equal(result.onlyTargetReads, true);
  assert.equal(result.requests, 31, 'work_wait never submits or replays work');
});
