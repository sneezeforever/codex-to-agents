import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Qoder } from '../src/qoder.mjs';
import { Consumer } from '../src/worker.mjs';
import { OrderBook } from '../src/orders.mjs';
import { monitorSnapshot } from '../src/monitor.mjs';
import { startBackend } from '../src/backend.mjs';
import { backendAuth } from '../src/backend-control.mjs';
import { createQoderFixture } from './fixtures/qoder-cli-fixture.mjs';
import { ReceiptStore } from '../src/receipt-store.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked', 'uncertain']);
const settled = status => TERMINAL.has(status);

async function waitFor(predicate, { timeoutMs = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function fixture(t, { control, settings } = {}) {
  const cli = await createQoderFixture(t, { control });
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cta-qoder-')));
  const directory = join(home, 'project');await mkdir(directory);
  const book = new OrderBook(home);await book.open();
  const config = {
    home, executable: cli.executable, defaultDirectory: directory,
    startupTimeoutMs: 8000, idleTimeoutMs: 8000, exitGraceMs: 4000, cancelGraceMs: 6000,
    catalogTimeoutMs: 3000, catalogErrorTtlMs: 0, ...settings,
  };
  const opened = [];
  const worker = async (overrides = {}) => {
    const adapter = new Qoder({ ...config, ...overrides });
    const consumer = new Consumer(home, adapter, { executor: 'qoder' });
    await consumer.open();opened.push(consumer);
    return { consumer, adapter };
  };
  t.after(async () => {
    for (const consumer of opened.reverse()) await consumer.close().catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });
  return { home, directory, book, cli, config, worker };
}

function submit(book, payload) {
  return book.submit('work_submit', { executor: 'qoder', ...payload });
}

// Only print-mode invocations are work deliveries; catalog/version probes are
// also recorded by the fixture but must never be counted as task runs.
async function prints(cli) {
  return (await cli.invocations()).filter(invocation => invocation.print === true);
}

async function settle(consumer, book, id, { timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    await consumer.tick();
    state = await book.inspect(id);
    if (settled(state.status)) return state;
    await delay(20);
  }
  throw new Error(`order ${id} did not settle: ${JSON.stringify(state)}`);
}

test('submission uses the verified CLI surface, streams progress and keeps the native session', async t => {
  const f = await fixture(t);
  const order = await submit(f.book, { goal: 'implement the feature', directory: f.directory, model: 'Auto' });
  const { consumer } = await f.worker();
  const state = await settle(consumer, f.book, order.order_id);
  assert.equal(state.status, 'completed');
  assert.equal(state.conversation_id, state.output.session_id);
  assert.match(state.conversation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(state.output.text, /ECHO:implement the feature/);
  assert.equal(state.output.native_status, 'success');
  assert.equal(state.output.exit_confirmed, true);
  assert.equal(state.output.permission_restricted, false);
  assert.ok(!state.output.text.includes('Considering the request'), 'thinking text is progress, not output');

  const [invocation] = await prints(f.cli);
  assert.deepEqual(invocation.argv.slice(0, 2), ['-p', '--output-format']);
  assert.equal(invocation.argv[2], 'stream-json');
  assert.deepEqual(invocation.argv.slice(3, 5), ['--cwd', await realpath(f.directory)]);
  assert.ok(invocation.argv.includes('--model') && invocation.argv.includes('Auto'));
  for (const forbidden of ['--max-turns', '--permission-mode', '--yolo', '--dangerously-skip-permissions', '--reasoning-effort', '--input-format']) {
    assert.ok(!invocation.argv.includes(forbidden), `must not pass ${forbidden}`);
  }
  // The shared delivery convention follows the original task message.
  assert.ok(invocation.stdin.startsWith('implement the feature\n\n交付要求'), 'the original message stays the prefix');
  assert.match(invocation.stdin, /验证命令与退出码|验证命令/);
  assert.equal(invocation.output_format, 'stream-json');
  assert.equal(invocation.cwd, await realpath(f.directory));

  const runtime = await f.book.runtime(null, 'qoder');
  assert.equal(runtime.online, true);
  assert.equal(runtime.snapshot.catalog.models.length, 15);
  assert.deepEqual(runtime.snapshot.catalog.models[0], { provider: 'qoder', model: 'Auto', name: 'Auto', efforts: [], default_effort: null });
});

test('follow-ups resume the same native session and keep the stored route', async t => {
  const f = await fixture(t);
  const order = await submit(f.book, { goal: 'first turn', directory: f.directory, model: 'DeepSeek-V4-Pro' });
  const { consumer } = await f.worker();
  const first = await settle(consumer, f.book, order.order_id);
  assert.equal(first.status, 'completed');

  const second = await f.book.submit('work_update', { target_order: order.order_id, action: 'append', message: 'continue with tests' });
  const state = await settle(consumer, f.book, second.order_id);
  assert.equal(state.status, 'completed');
  assert.equal(state.conversation_id, first.conversation_id);
  assert.match(state.output.text, /ECHO:continue with tests/);

  const invocations = await prints(f.cli);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].resume, first.conversation_id);
  assert.equal(invocations[1].requested_session_id, first.conversation_id);
  assert.equal(invocations[1].model, 'DeepSeek-V4-Pro');
  const session = await f.cli.readSession(first.conversation_id);
  assert.equal(session.calls.length, 2);
  assert.equal((await f.book.inspect(order.order_id)).status, 'completed');
});

test('a resumed session must keep its native identity; a mismatch stops the follow-up', async t => {
  const f = await fixture(t);
  const order = await submit(f.book, { goal: 'first', directory: f.directory });
  const { consumer } = await f.worker();
  const first = await settle(consumer, f.book, order.order_id);
  f.cli.setControl({ resume_mismatch: true });
  const follow = await f.book.submit('work_update', { target_order: order.order_id, action: 'append', message: 'must not fork' });
  const state = await settle(consumer, f.book, follow.order_id);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /不同的会话标识/);
  assert.equal((await f.book.inspect(order.order_id)).status, 'completed');
});

test('a valid success result only completes after a normal exit; crashes and missing terminals fail', async t => {
  const cases = [
    { name: 'exit without result', control: { mode: 'exit_without_result' }, expected: 'early_exit', pattern: /未返回合法终态/ },
    { name: 'protocol garbage', control: { mode: 'protocol_garbage' }, expected: 'protocol_error', pattern: /无法解析的 stream-json/ },
    { name: 'result before init', control: { result_without_init: true }, expected: 'protocol_error', pattern: /未返回 init 会话标识/ },
    { name: 'execution error', control: { mode: 'error_during_execution' }, expected: 'cli_error', pattern: /执行失败/ },
    { name: 'turn limit', control: { mode: 'error_max_turns' }, expected: 'turn_limit', pattern: /轮数限制/ },
    { name: 'success then non-zero exit', control: { exit_after_result: 1 }, expected: 'early_exit', pattern: /没有正常退出/ },
    { name: 'success then SIGTERM', control: { signal_after_result: 'SIGTERM' }, expected: 'early_exit', pattern: /没有正常退出/ },
  ];
  for (const item of cases) {
    const f = await fixture(t, { control: item.control });
    const order = await submit(f.book, { goal: `case ${item.name}`, directory: f.directory });
    const { consumer } = await f.worker();
    const state = await settle(consumer, f.book, order.order_id);
    assert.equal(state.status, 'failed', item.name);
    assert.match(state.error, item.pattern, item.name);
    assert.equal(state.output.failure_kind, item.expected, item.name);
    assert.notEqual(state.output.exit_confirmed, true, item.name);
  }
});

test('a fast burst result is never reported as a missing session or overwritten as executing', async t => {
  const f = await fixture(t, { control: { burst: true } });
  const order = await submit(f.book, { goal: 'fast burst', directory: f.directory });
  const { consumer } = await f.worker();
  const state = await settle(consumer, f.book, order.order_id);
  assert.equal(state.status, 'completed');
  assert.match(state.output.text, /ECHO:fast burst/);
  assert.equal((await prints(f.cli)).length, 1);
});

test('an unterminated oversized line is rejected by a byte cap instead of buffering without bound', async t => {
  const f = await fixture(t, { control: { long_line: true, longLineBytes: 3 * 1024 * 1024 + 1024, longLineSleepMs: 3000 } });
  const order = await submit(f.book, { goal: 'huge line', directory: f.directory });
  const { consumer } = await f.worker();
  const started = Date.now();
  const state = await settle(consumer, f.book, order.order_id, { timeoutMs: 9000 });
  assert.equal(state.status, 'failed');
  assert.match(state.error, /超过 .* 字节且没有换行/);
  assert.equal(state.output.failure_kind, 'protocol_error');
  assert.ok(Date.now() - started < 9000);
});

test('missing login, unreadable catalog output and a missing executable are explicit failures', async t => {
  const scenarios = [
    { name: 'not logged in', control: { models_mode: 'not_logged_in' }, pattern: /未登录/ },
    { name: 'diagnostics only', control: { models_mode: 'diagnostics' }, pattern: /MODEL 表头|无法识别/ },
    { name: 'header only', control: { models_mode: 'header_only' }, pattern: /没有可用的模型名称/ },
  ];
  for (const scenario of scenarios) {
    const f = await fixture(t, { control: scenario.control });
    const { consumer } = await f.worker();
    const order = await submit(f.book, { goal: 'blocked by catalog', directory: f.directory });
    await consumer.tick();
    await waitFor(async () => (await f.book.runtime(null, 'qoder')).snapshot?.catalog?.error, { label: `${scenario.name} catalog error` });
    const runtime = await f.book.runtime(null, 'qoder');
    assert.match(runtime.snapshot.catalog.error, scenario.pattern, scenario.name);
    assert.deepEqual(runtime.snapshot.catalog.models ?? [], [], scenario.name);
    const state = await settle(consumer, f.book, order.order_id);
    assert.equal(state.status, 'failed', scenario.name);
    assert.match(state.error, scenario.pattern, scenario.name);
    assert.equal((await prints(f.cli)).length, 0, `${scenario.name}: no print-mode CLI was started`);
    const snapshot = await monitorSnapshot(f.home);
    assert.match(snapshot.worker.executors.qoder.catalog_error, scenario.pattern, scenario.name);
    assert.deepEqual(snapshot.worker.executors.qoder.models, [], scenario.name);
  }

  const f = await fixture(t);
  const { consumer } = await f.worker({ executable: '/nonexistent/qodercli' });
  const order = await submit(f.book, { goal: 'no executable', directory: f.directory });
  await consumer.tick();
  await waitFor(async () => (await f.book.runtime(null, 'qoder')).snapshot?.catalog?.error, { label: 'missing executable error' });
  const state = await settle(consumer, f.book, order.order_id);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /不存在或不可执行/);
  assert.equal((await prints(f.cli)).length, 0);
});

test('cancellation signals only its own child and keeps same-session work blocked until that child exits', async t => {
  const f = await fixture(t, { control: { mode: 'slow', sigint_delay_ms: 1500 } });
  const first = await submit(f.book, { goal: 'long first', directory: f.directory });
  const { consumer, adapter } = await f.worker();
  await consumer.tick();
  let state = await f.book.inspect(first.order_id);
  assert.equal(state.status, 'executing');
  const session = state.conversation_id;
  assert.ok(session);

  f.cli.setControl({ sessionSeed: 'other-session' });
  const second = await submit(f.book, { goal: 'long second', directory: f.directory });
  await consumer.tick();
  const other = await f.book.inspect(second.order_id);
  assert.equal(other.status, 'executing');
  assert.notEqual(other.conversation_id, session);

  const cancel = await f.book.submit('work_update', { target_order: first.order_id, action: 'cancel' });
  await consumer.tick();
  assert.equal((await f.book.inspect(cancel.order_id)).status, 'completed');

  // The old child is still alive: the session must be busy and follow-up work
  // must stay queued instead of spawning a second process on the same session.
  assert.equal(adapter.ready(session), false);
  assert.deepEqual(adapter.observe([session]), [{ id: session, status: 'running' }]);
  assert.equal(adapter.ready(other.conversation_id), false, 'cancelling one order must not touch another session');
  const append = await f.book.submit('work_update', { target_order: first.order_id, action: 'append', message: 'after cancel' });
  await consumer.tick();
  assert.equal((await f.book.inspect(append.order_id)).status, 'queued');
  assert.equal((await prints(f.cli)).length, 2, 'no second same-session process while the old one runs');

  const cancelled = await settle(consumer, f.book, first.order_id);
  assert.equal(cancelled.status, 'cancelled');
  await waitFor(() => adapter.ready(session), { label: 'cancelled child exit' });
  const invocations = await prints(f.cli);
  assert.equal(invocations[0].exit_code, 130);
  assert.equal(invocations[0].signal, 'SIGINT');

  f.cli.setControl({ mode: 'success', sigint_delay_ms: 0 });
  const resumed = await settle(consumer, f.book, append.order_id, { timeoutMs: 15000 });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.conversation_id, session);
  assert.equal((await prints(f.cli))[2].resume, session);
  assert.equal((await f.book.inspect(second.order_id)).status, 'executing', 'other session is still running');
});

test('close, startup timeout and idle timeout terminate a SIGTERM-ignoring CLI with a bounded SIGKILL', async t => {
  const isGone = pid => {
    try { process.kill(pid, 0);return false; }
    catch (error) { return error.code === 'ESRCH'; }
  };

  // Close: a CLI that ignores SIGTERM must still be gone before close resolves.
  const closer = await fixture(t, { control: { mode: 'slow', ignore_sigterm: true }, settings: { terminateGraceMs: 250, killWaitMs: 1500 } });
  const closeOrder = await submit(closer.book, { goal: 'ignores SIGTERM', directory: closer.directory });
  const closing = await closer.worker();
  await closing.consumer.tick();
  assert.equal((await closer.book.inspect(closeOrder.order_id)).status, 'executing');
  const closePid = (await prints(closer.cli))[0].pid;
  const closeStarted = Date.now();
  await closing.adapter.close();
  assert.ok(Date.now() - closeStarted < 5000, 'close waits a bounded time');
  await waitFor(() => isGone(closePid), { label: 'SIGKILLed child exit' });
  await closing.consumer.close();

  // Startup timeout: no init is ever produced, so the bounded startup timer must
  // SIGKILL the stuck child.
  const starter = await fixture(t, {
    control: { hang_without_output: true, ignore_sigterm: true },
    settings: { startupTimeoutMs: 250, terminateGraceMs: 200, killWaitMs: 1500 },
  });
  const startOrder = await submit(starter.book, { goal: 'never initializes', directory: starter.directory });
  const starting = await starter.worker();
  const startedState = await settle(starting.consumer, starter.book, startOrder.order_id, { timeoutMs: 8000 });
  assert.equal(startedState.status, 'failed');
  assert.match(startedState.error, /协议超时/);
  const startPid = (await prints(starter.cli))[0].pid;
  await waitFor(() => isGone(startPid), { label: 'startup timeout child exit' });

  // Idle timeout: init arrives but the task goes silent; the task must fail and
  // the stuck child must be SIGKILLed.
  const idler = await fixture(t, {
    control: { mode: 'slow', ignore_sigterm: true },
    settings: { idleTimeoutMs: 300, terminateGraceMs: 200, killWaitMs: 1500 },
  });
  const idleOrder = await submit(idler.book, { goal: 'goes silent', directory: idler.directory });
  const idling = await idler.worker();
  const idleState = await settle(idling.consumer, idler.book, idleOrder.order_id, { timeoutMs: 8000 });
  assert.equal(idleState.status, 'failed');
  assert.match(idleState.error, /没有输出/);
  const idlePid = (await prints(idler.cli))[0].pid;
  await waitFor(() => isGone(idlePid), { label: 'idle timeout child exit' });
});

test('restart keeps a settled order and marks an interrupted receipt uncertain without replay', async t => {
  const f = await fixture(t);
  const order = await submit(f.book, { goal: 'persist across restart', directory: f.directory });
  const first = await f.worker();
  const done = await settle(first.consumer, f.book, order.order_id);
  assert.equal(done.status, 'completed');
  await first.consumer.close();
  const before = (await prints(f.cli)).length;
  const second = await f.worker();
  await second.consumer.tick();
  assert.equal((await f.book.inspect(order.order_id)).status, 'completed');
  assert.equal((await prints(f.cli)).length, before, 'a completed order is never replayed');

  const slow = await fixture(t, { control: { mode: 'slow' } });
  const running = await submit(slow.book, { goal: 'interrupted', directory: slow.directory });
  const crashed = await slow.worker();
  await crashed.consumer.tick();
  assert.equal((await slow.book.inspect(running.order_id)).status, 'executing');
  await crashed.adapter.close();
  await crashed.consumer.close();
  const restarted = await slow.worker();
  await restarted.consumer.tick();
  const state = await slow.book.inspect(running.order_id);
  assert.equal(state.status, 'uncertain');
  assert.match(state.progress, /不会自动重放/);
  assert.equal((await prints(slow.cli)).length, 1, 'an interrupted dispatch is inspected, not replayed');
});

test('completed receipts and exited processes are released; a warm restart keeps only the session locator', async t => {
  const f = await fixture(t, { settings: { receiptCacheSize: 2 } });
  await setBoard(f.home, { enabled: true, executor: 'qoder', qoder_permission: 'accept_edits' });
  const order = await submit(f.book, { goal: 'warm restart', directory: f.directory, model: 'DeepSeek-V4-Pro' });
  const first = await f.worker();
  const done = await settle(first.consumer, f.book, order.order_id);
  assert.equal(done.status, 'completed');
  await waitFor(() => first.adapter.processes.size === 0 && first.adapter.turns.size === 0, { label: 'terminal release' });
  assert.ok(first.adapter.store.cache.size <= 2, 'the on-demand body cache is bounded');
  const index = JSON.parse(await readFile(join(f.home, 'qoder-receipts', '.receipt-index.json'), 'utf8'));
  assert.equal(index.orders[order.order_id].active, false, 'the persisted index marks the receipt terminal');
  assert.equal(index.sessions[done.conversation_id].permission, 'accept_edits');
  await first.consumer.close();

  const second = await f.worker();
  assert.equal(second.adapter.store.stats.receiptReads, 0, 'completed bodies are not read on restart');
  assert.equal(second.adapter.turns.size, 0);
  assert.equal(second.adapter.processes.size, 0);
  const location = await second.adapter.checkpoint(done.conversation_id);
  assert.equal(location.directory, await realpath(f.directory));
  assert.equal(location.permission, 'accept_edits');
  assert.deepEqual(location.route, { provider: 'qoder', model: 'DeepSeek-V4-Pro', effort: null });
  assert.equal(second.adapter.store.stats.receiptReads, 0, 'checkpoint resolves from the locator index');

  // A later board change must still not alter an existing conversation, even
  // after the consumer restarted and the full receipt is no longer in memory.
  await setBoard(f.home, { enabled: true, executor: 'qoder', qoder_permission: 'dont_ask' });
  const follow = await f.book.submit('work_update', { target_order: order.order_id, action: 'append', message: 'after restart' });
  const state = await settle(second.consumer, f.book, follow.order_id);
  assert.equal(state.status, 'completed');
  const invocation = (await prints(f.cli))[1];
  assert.equal(invocation.resume, done.conversation_id);
  assert.equal(invocation.permission_mode, 'accept_edits');
  assert.equal(state.output.permission_mode, 'acceptEdits');
  await waitFor(() => second.adapter.processes.size === 0 && second.adapter.turns.size === 0, { label: 'follow-up release' });
});

test('Qoder rejects workspace and conversation management instead of deleting sessions', async t => {
  const f = await fixture(t);
  const order = await submit(f.book, { goal: 'manage me', directory: f.directory });
  const { consumer } = await f.worker();
  const state = await settle(consumer, f.book, order.order_id);
  await assert.rejects(f.book.submit('workspace_control', { executor: 'qoder', action: 'list' }), /not supported/);
  for (const [action, pattern] of [['archive', /不会删除会话冒充归档/], ['list', /暂不支持/], ['rename', /不会删除会话冒充重命名/]]) {
    const request = await f.book.submit('conversation_control', {
      executor: 'qoder', action, conversation_id: state.conversation_id, ...(action === 'rename' ? { title: 'x' } : {}),
    });
    const result = await settle(consumer, f.book, request.order_id);
    assert.equal(result.status, 'failed', action);
    assert.match(result.error, pattern, action);
  }
  assert.ok(await f.cli.readSession(state.conversation_id), 'the native session is retained');
});

test('denied permissions are preserved on a successful result instead of being discarded', async t => {
  const f = await fixture(t, { control: { permission_denials: [{ tool_name: 'Write', tool_input: { file_path: 'src/app.mjs' } }] } });
  const order = await submit(f.book, { goal: 'denied write', directory: f.directory });
  const { consumer } = await f.worker();
  const state = await settle(consumer, f.book, order.order_id);
  assert.equal(state.status, 'completed');
  assert.equal(state.output.permission_denials.length, 1);
  assert.equal(state.output.permission_restricted, true);
  assert.match(state.progress, /权限请求被拒绝/);
});

test('model and effort values come only from the live catalog and the default passes no effort flag', async t => {
  const f = await fixture(t, { control: { models_mode: 'json', models: [{ id: 'Auto', name: 'Auto', efforts: ['low', 'high'] }] } });
  const { consumer } = await f.worker();
  const invalidModel = await submit(f.book, { goal: 'bad model', directory: f.directory, model: 'Missing-Model' });
  await consumer.tick();
  assert.equal((await f.book.inspect(invalidModel.order_id)).status, 'failed');
  assert.match((await f.book.inspect(invalidModel.order_id)).error, /模型当前不可用/);
  const invalidEffort = await submit(f.book, { goal: 'bad effort', directory: f.directory, model: 'Auto', effort: 'xhigh' });
  await consumer.tick();
  assert.equal((await f.book.inspect(invalidEffort.order_id)).status, 'failed');
  assert.match((await f.book.inspect(invalidEffort.order_id)).error, /思考强度/);
  assert.equal((await prints(f.cli)).length, 0, 'invalid choices fail before the CLI starts');

  const explicit = await submit(f.book, { goal: 'high effort', directory: f.directory, model: 'Auto', effort: 'high' });
  const done = await settle(consumer, f.book, explicit.order_id);
  assert.equal(done.status, 'completed');
  let invocations = await prints(f.cli);
  assert.equal(invocations[0].reasoning_effort, 'high');

  const plain = await submit(f.book, { goal: 'default effort', directory: f.directory, model: 'Auto' });
  assert.equal((await settle(consumer, f.book, plain.order_id)).status, 'completed');
  invocations = await prints(f.cli);
  assert.equal(invocations[1].reasoning_effort, null);
  assert.ok(!invocations[1].argv.includes('--reasoning-effort'));
});

test('a hung catalog probe does not block backend health or board reads', async t => {
  const cli = await createQoderFixture(t, { control: { models_mode: 'hang', modelsHangMs: 30000 } });
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cta-qoder-backend-')));
  const directory = join(home, 'project');await mkdir(directory);
  await writeFile(join(home, 'usage-settings.json'), '{"enabled":false}\n');
  await writeFile(join(home, 'settings.json'), JSON.stringify({ qoder: { executable: cli.executable, defaultDirectory: directory, catalogTimeoutMs: 700, catalogErrorTtlMs: 100 } }));
  const book = new OrderBook(home);await book.open();
  await book.submit('work_submit', { executor: 'qoder', goal: 'pending qoder work' });
  const backend = await startBackend(home);
  t.after(async () => { await backend.close();await rm(home, { recursive: true, force: true }).catch(() => {}); });
  const headers = await backendAuth(home);

  await waitFor(async () => {
    const response = await fetch(backend.url + '/health', { headers, signal: AbortSignal.timeout(1000) });
    return (await response.json()).qoder_loaded === true;
  }, { label: 'qoder worker load', timeoutMs: 6000 });

  const client = new Client({ name: 'qoder-catalog-blocking-test', version: '1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(backend.url + '/board'), { requestInit: { headers } }));
  t.after(() => client.close());

  let sawCatalogError = false;
  for (let attempt = 0; attempt < 20 && !sawCatalogError; attempt += 1) {
    const started = Date.now();
    const health = await fetch(backend.url + '/health', { headers, signal: AbortSignal.timeout(1500) });
    assert.equal(health.status, 200);
    const snapshot = await Promise.race([
      client.callTool({ name: 'panel_snapshot', arguments: {} }),
      delay(1500).then(() => { throw new Error('panel_snapshot blocked behind the catalog probe'); }),
    ]);
    assert.ok(snapshot.structuredContent, 'board snapshot stays readable');
    assert.ok(Date.now() - started < 1500, 'health and board reads must not wait for the hung CLI');
    sawCatalogError = /超时|模型目录/.test(snapshot.structuredContent?.worker?.executors?.qoder?.catalog_error ?? '');
    if (!sawCatalogError) await delay(100);
  }
  assert.equal(sawCatalogError, true, 'the hung probe eventually surfaces a catalog error');
});

async function setBoard(home, setting) {
  await writeFile(join(home, 'delegation.json'), JSON.stringify(setting));
}

test('a stored Qoder permission reaches a new session through the verified flag and native alias', async t => {
  const f = await fixture(t);
  await setBoard(f.home, { enabled: true, executor: 'qoder', qoder_permission: 'accept_edits' });
  const order = await submit(f.book, { goal: 'edit files', directory: f.directory, model: 'Auto' });
  const { consumer } = await f.worker();
  const state = await settle(consumer, f.book, order.order_id);
  assert.equal(state.status, 'completed');
  // Real 1.1.78 reports acceptEdits (camelCase) for the snake_case flag.
  assert.equal(state.output.permission_mode, 'acceptEdits');
  assert.equal(state.output.exit_confirmed, true);
  const [invocation] = await prints(f.cli);
  const index = invocation.argv.indexOf('--permission-mode');
  assert.ok(index > 0, 'the flag is passed for an explicit choice');
  assert.equal(invocation.argv[index + 1], 'accept_edits');
  assert.equal(invocation.permission_mode, 'accept_edits');
  const runtime = await f.book.runtime(null, 'qoder');
  assert.equal(runtime.snapshot.catalog.permission_control.available, true);
  assert.deepEqual(runtime.snapshot.catalog.permission_control.presets,
    ['accept_edits', 'dont_ask', 'auto', 'bypass_permissions']);
});

test('no permission flag is passed when the board follows the Qoder default', async t => {
  const f = await fixture(t);
  const order = await submit(f.book, { goal: 'default mode', directory: f.directory, model: 'Auto' });
  const { consumer } = await f.worker();
  const state = await settle(consumer, f.book, order.order_id);
  assert.equal(state.status, 'completed');
  const [invocation] = await prints(f.cli);
  assert.ok(!invocation.argv.includes('--permission-mode'));
  assert.equal(state.output.permission_mode, 'default');
});

test('a permission mismatch stays terminal even when a success result and exit 0 follow in the same chunk', async t => {
  const f = await fixture(t, { control: { permission_mismatch_burst: true, reported_permission_mode: 'bypassPermissions' } });
  await setBoard(f.home, { enabled: true, executor: 'qoder', qoder_permission: 'accept_edits' });
  const order = await submit(f.book, { goal: 'must not be reported complete', directory: f.directory, model: 'Auto' });
  const { consumer } = await f.worker();
  const state = await settle(consumer, f.book, order.order_id);
  assert.equal(state.status, 'uncertain', 'the mismatch record cannot be overwritten by the later success result');
  assert.equal(state.output.failure_kind, 'permission_mismatch');
  assert.equal(state.output.requested_permission, 'accept_edits');
  assert.equal(state.output.reported_permission, 'bypassPermissions');
  assert.equal(state.output.delivery_uncertain, true);
  assert.equal(state.output.terminal_confirmed, false);
  // A follow-up must not reuse this uncertain conversation as a clean session.
  assert.equal(state.output.exit_confirmed, undefined);
});

test('follow-ups keep the recorded permission and do not re-read the board', async t => {
  const f = await fixture(t);
  await setBoard(f.home, { enabled: true, executor: 'qoder', qoder_permission: 'accept_edits' });
  const order = await submit(f.book, { goal: 'first turn', directory: f.directory, model: 'DeepSeek-V4-Pro' });
  const { consumer } = await f.worker();
  const first = await settle(consumer, f.book, order.order_id);
  assert.equal(first.status, 'completed');

  // A later board change must not alter the existing conversation.
  await setBoard(f.home, { enabled: true, executor: 'qoder', qoder_permission: 'dont_ask' });
  const second = await f.book.submit('work_update', { target_order: order.order_id, action: 'append', message: 'continue' });
  const state = await settle(consumer, f.book, second.order_id);
  assert.equal(state.status, 'completed');
  assert.equal(state.conversation_id, first.conversation_id);
  assert.equal(state.output.permission_mode, 'acceptEdits');
  const invocations = await prints(f.cli);
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    const index = invocation.argv.indexOf('--permission-mode');
    assert.ok(index > 0);
    assert.equal(invocation.argv[index + 1], 'accept_edits', 'the follow-up reuses the original recorded mode');
  }
});

test('a follow-up of a legacy task without a permission never picks up the board setting later', async t => {
  const f = await fixture(t);
  const order = await submit(f.book, { goal: 'legacy permissionless turn', directory: f.directory, model: 'Auto' });
  const { consumer } = await f.worker();
  const first = await settle(consumer, f.book, order.order_id);
  assert.equal(first.status, 'completed');

  await setBoard(f.home, { enabled: true, executor: 'qoder', qoder_permission: 'bypass_permissions' });
  const second = await f.book.submit('work_update', { target_order: order.order_id, action: 'append', message: 'continue legacy' });
  const state = await settle(consumer, f.book, second.order_id);
  assert.equal(state.status, 'completed');
  const invocations = await prints(f.cli);
  assert.equal(invocations.length, 2);
  assert.ok(!invocations[1].argv.includes('--permission-mode'));
  assert.equal(state.output.permission_mode, 'default');
});

test('a damaged stored permission fails before any Qoder task process is started', async t => {
  const f = await fixture(t);
  await setBoard(f.home, { enabled: true, executor: 'qoder', qoder_permission: 'plan' });
  const order = await submit(f.book, { goal: 'should never run', directory: f.directory, model: 'Auto' });
  const { consumer } = await f.worker();
  const state = await settle(consumer, f.book, order.order_id);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /新会话权限设置值不受支持/);
  assert.deepEqual(await prints(f.cli), [], 'the corrupt preference must block before spawning a task');
});

test('an old Qoder CLI without --permission-mode reports unsupported and blocks dispatch', async t => {
  const f = await fixture(t, { control: { help_text: 'Usage: qodercli [options]\n  -p, --print  Print response and exit\n' } });
  await setBoard(f.home, { enabled: true, executor: 'qoder', qoder_permission: 'accept_edits' });
  const order = await submit(f.book, { goal: 'blocked by old cli', directory: f.directory, model: 'Auto' });
  const { consumer } = await f.worker();
  const state = await settle(consumer, f.book, order.order_id);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /未提供新会话权限/);
  assert.deepEqual(await prints(f.cli), []);
  const runtime = await f.book.runtime(null, 'qoder');
  assert.equal(runtime.snapshot.catalog.permission_control.available, false);
  assert.deepEqual(runtime.snapshot.catalog.permission_control.presets, []);
  assert.match(runtime.snapshot.catalog.permission_control.limitations.join(' '), /未声明 --permission-mode/);
});

test('cancelling a resumed-from session alias after the follow-up moved to a new native session reports terminal', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cta-qoder-alias-')));
  t.after(() => rm(home, { recursive: true, force: true }).catch(() => {}));
  const terminal = status => ['completed', 'failed', 'cancelled', 'blocked'].includes(status);
  const store = new ReceiptStore(join(home, 'qoder-receipts'), { isTerminal: terminal });
  await store.open();
  const original = '00000000-0000-4000-8000-000000000101';
  const follow = '00000000-0000-4000-8000-000000000102';
  await store.commit({
    order_id: original, status: 'completed', conversation_id: 'session-a', native_session_id: 'session-a',
    directory: home, permission: 'accept_edits', started_at: '2026-01-01T00:00:00.000Z',
  });
  const base = {
    order_id: follow, conversation_id: 'session-a', native_session_id: 'session-a', resume_from: 'session-a',
    directory: home, permission: 'accept_edits', started_at: '2026-01-02T00:00:00.000Z',
  };
  await store.commit({ ...base, status: 'starting' });
  await store.commit({ ...base, status: 'executing', conversation_id: 'session-b', native_session_id: 'session-b' });
  await store.commit({ ...base, status: 'completed', conversation_id: 'session-b', native_session_id: 'session-b' });

  const adapter = new Qoder({ home, spawn() { throw new Error('must not spawn'); } });
  await adapter.open();
  assert.equal(adapter.store.session('session-a').status, 'completed',
    'the resumed-from alias follows the order when the follow-up changes native session');
  assert.equal(adapter.store.session('session-a').native_session_id, 'session-a',
    'the old alias still identifies the session it was created for');
  assert.deepEqual(await adapter.cancel('session-a'), {
    cancelled: false, already_terminal: true, conversation_id: 'session-a', native_queue_cleared: false,
  });
  await adapter.close();
});

test('send observes a terminal save that was queued after an older starting snapshot', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cta-qoder-save-order-')));
  t.after(() => rm(home, { recursive: true, force: true }).catch(() => {}));
  const adapter = new Qoder({ home, spawn() { throw new Error('must not spawn'); } });
  await adapter.open();
  const id = '00000000-0000-4000-8000-000000000103';
  const native = adapter.store.commit.bind(adapter.store);
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  adapter.store.commit = async receipt => {
    if (receipt.status === 'starting') { entered(); await gate; }
    return native(receipt);
  };
  const receipt = { order_id: id, status: 'starting', conversation_id: 'session', directory: home, text: '', progress: 'starting' };
  adapter.turns.set(id, receipt);
  const initialSave = adapter.save(receipt);
  await started;
  receipt.status = 'completed';
  receipt.progress = 'done';
  receipt.output = { text: 'native result', terminal_confirmed: true, exit_confirmed: true };
  const record = { receipt, exited: true, child: {}, timers: {} };
  adapter.processes.set(id, record);
  adapter.releaseProcess(record);
  adapter.persist(receipt);
  releaseGate();
  await initialSave;

  const result = await adapter.send({ id }, { conversation_id: 'session' }, 'unused', 'queue');
  assert.equal(result.status, 'completed');
  assert.equal(result.output.text, 'native result');
  await adapter.close();
});
