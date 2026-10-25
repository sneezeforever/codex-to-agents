import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hermes } from '../src/hermes.mjs';
import { Consumer } from '../src/worker.mjs';
import { OrderBook } from '../src/orders.mjs';

// Native protocol fixture: it deliberately interrupts an active prompt if a
// second prompt is submitted, just like Hermes' default busy-input policy.
class NativeHermes {
  constructor() {
    this.socket = { readyState: 1 };this.generation = randomUUID();
    this.sessions = new Map();this.prompts = [];this.interrupted = [];
    this.calls = [];this.yolo = new Map();this.globalYoloWrites = 0;
    this.permissionSetMode = null;this.permissionInfo = 'full';
    this.options = { provider: 'deepseek', model: 'flash', providers: [
      { slug: 'deepseek', authenticated: true, models: ['flash'], capabilities: { flash: { reasoning: true } } },
      { slug: 'unconfigured', authenticated: false, models: ['unavailable'] },
      { slug: 'other', authenticated: true, models: ['expensive'] },
    ] };
  }
  byLive(id) { return [...this.sessions.values()].find(session => session.id === id); }
  async request(path, options = {}) {
    if (path === '/api/model/options') return this.options;
    if (path.startsWith('/api/sessions?')) return { total: this.sessions.size, sessions: [...this.sessions.values()].map(session => ({ ...session, id: session.session_key })) };
    const match = path.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/);
    const session = this.sessions.get(decodeURIComponent(match?.[1] ?? ''));
    if (!session) throw new Error('session missing');
    if (match[2]) return { messages: session.messages };
    if (options.method === 'PATCH') Object.assign(session, options.body);
    return session;
  }
  async call(method, params = {}) {
    if (this.offline) throw new Error('Hermes is offline');
    this.calls.push({ method, params: { ...params } });
    if (method === 'session.active_list') return { sessions: [...this.sessions.values()] };
    if (method === 'session.create') {
      const key = `stored-${this.sessions.size + 1}`;
      const session = { id: `live-${this.sessions.size + 1}`, session_key: key, status: 'idle', messages: [], ...params };
      this.sessions.set(key, session);
      return { session_id: session.id, stored_session_id: key };
    }
    if (method === 'session.resume' || method === 'session.activate') {
      const session = this.sessions.get(params.session_id) ?? this.byLive(params.session_id);
      const info = { provider: this.reportedProvider ?? session.provider, model: session.model };
      if (this.permissionInfo === 'full') info.yolo = this.yolo.get(session.session_key) ?? false;
      return { session_id: session.id, session_key: session.session_key, resumed: session.session_key, info };
    }
    if (method === 'config.set') {
      if (params.key !== 'yolo') throw Object.assign(new Error(`unexpected config key ${params.key}`), { definite: true });
      const session = this.byLive(params.session_id) ?? this.sessions.get(params.session_id);
      if (!session) throw new Error('session missing');
      if (params.scope === 'global') {
        this.globalYoloWrites++;
        throw new Error('a fixture global write must never happen');
      }
      if (this.permissionSetMode === 'reject') throw new Error('native setter rejected the session flag');
      if (this.permissionSetMode === 'missing-scope') return { key: 'yolo', value: '1' };
      if (this.permissionSetMode === 'global-scope') return { key: 'yolo', value: '1', scope: 'global' };
      const enable = String(params.value) === '1';
      if (enable) this.yolo.set(session.session_key, true); else this.yolo.delete(session.session_key);
      return { key: 'yolo', value: enable ? '1' : '0', scope: 'session' };
    }
    const session = this.byLive(params.session_id);
    if (method === 'prompt.submit') {
      if (this.rejection) throw Object.assign(new Error('native rejection'), { definite: true });
      if (session.status === 'working') this.interrupted.push(session.session_key);
      session.status = 'working';session.messages.push({ role: 'user', content: params.text });
      this.prompts.push({ session: session.session_key, text: params.text });
      if (this.loseReply) throw Object.assign(new Error('reply lost'), { deliveryUnknown: true });
      return { status: 'streaming' };
    }
    if (method === 'session.steer') return { status: session.status === 'working' ? 'queued' : 'rejected' };
    if (method === 'session.interrupt') { this.complete(session.session_key, 'stopped', 'interrupted');return { status: 'interrupted' }; }
    throw new Error(`unexpected native method ${method}`);
  }
  event(id, type, payload) { this.onEvent?.({ session_id: this.sessions.get(id).id, type, payload }); }
  complete(id, text, status = 'complete') {
    const session = this.sessions.get(id);session.status = 'idle';
    session.messages.push({ role: 'assistant', content: text });
    this.event(id, 'message.complete', { text, status });
  }
  close() { this.socket.readyState = 3; }
}

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cta-hermes-')));
  const directory = join(home, 'project');await mkdir(directory);
  const book = new OrderBook(home);await book.open();
  const native = new NativeHermes();
  const settings = { home, defaultDirectory: directory, providers: ['deepseek'], permissionReadbackTimeoutMs: 250 };
  const opened = [];
  const worker = async () => {
    native.socket.readyState = 1;native.generation = randomUUID();
    const adapter = new Hermes(settings, native);
    const consumer = new Consumer(home, adapter, { executor: 'hermes' });
    await consumer.open();opened.push(consumer);
    return { consumer, adapter };
  };
  t.after(async () => { for (const consumer of opened.reverse()) await consumer.close();await rm(home, { recursive: true, force: true }); });
  return { home, directory, book, native, settings, worker };
}

test('Hermes inherits the executor, rejects cross-agent updates and unsupported workspaces, and preserves legacy defaults', async t => {
  const f = await fixture(t);
  const parent = await f.book.submit('work_submit', { executor: 'hermes', goal: 'first' });
  const update = await f.book.submit('work_update', { target_order: parent.order_id, action: 'append', message: 'next' });
  assert.equal(update.executor, 'hermes');
  assert.equal((await f.book.request(update.order_id)).payload.executor, 'hermes');
  await assert.rejects(f.book.submit('work_update', { executor: 'dsh', target_order: parent.order_id, action: 'cancel' }), /must match/);
  await assert.rejects(f.book.submit('work_submit', { executor: 'hermes', goal: 'x', workspace_id: 'dsh-project' }), /not supported/);
  await assert.rejects(f.book.submit('workspace_control', { executor: 'hermes', action: 'list' }), /not supported/);
  const legacy = await f.book.submit('work_submit', { goal: 'legacy' });
  assert.equal(legacy.executor, 'dsh');
  assert.equal((await f.book.request(legacy.order_id)).payload.executor, undefined);
});

test('Hermes publication is blocked while a legacy DSH consumer could steal its orders', async t => {
  const f = await fixture(t);
  const snapshot = { active: true, pid: process.pid, at: new Date().toISOString() };
  await f.book.runtime(snapshot);
  await assert.rejects(f.book.submit('work_submit', { executor: 'hermes', goal: 'do not misroute' }), /legacy consumer/);
  assert.equal((await f.book.list()).length, 0);
  await f.book.runtime({ ...snapshot, protocol: 2 });
  const order = await f.book.submit('work_submit', { executor: 'hermes', goal: 'safe after reload' });
  assert.equal(order.executor, 'hermes');
});

test('DSH and Hermes lease the same directory independently and dispatch only their own orders', async t => {
  const f = await fixture(t);
  const dsh = await f.book.submit('work_submit', { goal: 'DSH only' });
  const hermes = await f.book.submit('work_submit', { executor: 'hermes', goal: 'Hermes only' });
  const sent = [];
  const dshWorker = new Consumer(f.home, {
    describe: async () => ({ models: [] }), observe: () => [],
    start: async order => ({ conversation_id: `cw-${order.id}` }), send: async order => { sent.push(order.id); },
    progress: async () => ({ status: 'executing', progress: 'DSH running' }),
  });
  await dshWorker.open();t.after(() => dshWorker.close());
  const { consumer } = await f.worker();
  await Promise.all([dshWorker.tick(), consumer.tick()]);
  assert.deepEqual(sent, [dsh.order_id]);
  assert.equal(f.native.prompts.length, 1);assert.ok(f.native.prompts[0].text.includes(hermes.order_id));
  const runtime = await f.book.runtimes();
  assert.equal(runtime.executors.dsh.online, true);assert.equal(runtime.executors.hermes.online, true);
  await assert.rejects(new Consumer(f.home, {}, { executor: 'hermes' }).open(), error => error.code === 'CONSUMER_BUSY');
  await consumer.close();assert.equal((await f.book.runtime()).online, true);
  await dshWorker.close();
});

test('same-session Hermes follow-ups remain queued until prior work finishes without triggering native interruption', async t => {
  const f = await fixture(t);
  const parent = await f.book.submit('work_submit', { executor: 'hermes', goal: 'first', provider: 'deepseek', model: 'flash', effort: 'low' });
  const second = await f.book.submit('work_update', { target_order: parent.order_id, action: 'append', message: 'second' });
  const third = await f.book.submit('work_update', { target_order: parent.order_id, action: 'append', message: 'third' });
  const { consumer } = await f.worker();await consumer.tick();await consumer.tick();
  assert.equal(f.native.prompts.length, 1);assert.equal((await f.book.inspect(second.order_id)).status, 'queued');
  const session = (await f.book.inspect(parent.order_id)).conversation_id;
  assert.equal(f.native.sessions.get(session).cwd, f.directory);
  assert.equal(f.native.sessions.get(session).reasoning_effort, 'low');
  f.native.event(session, 'message.delta', { text: 'first partial' });
  f.native.complete(session, 'FIRST');await consumer.tick();
  assert.equal((await f.book.inspect(parent.order_id)).output.text, 'FIRST');
  assert.equal(f.native.prompts.length, 2);assert.ok(f.native.prompts[1].text.includes('\nsecond'));
  assert.match(f.native.prompts[1].text, /验证|未验证/, 'the delivery convention follows the follow-up message');
  assert.equal((await f.book.inspect(third.order_id)).status, 'queued');
  f.native.complete(session, 'SECOND');await consumer.tick();
  assert.equal((await f.book.inspect(second.order_id)).output.text, 'SECOND');
  assert.equal(f.native.prompts.length, 3);assert.ok(f.native.prompts[2].text.includes('\nthird'));
  assert.match(f.native.prompts[2].text, /验证|未验证/, 'the delivery convention follows the follow-up message');
  f.native.complete(session, 'THIRD');await consumer.tick();
  assert.equal((await f.book.inspect(third.order_id)).output.text, 'THIRD');
  assert.deepEqual(f.native.interrupted, []);
});

test('terminal receipts survive consumer restart and cannot absorb later replies or reasoning', async t => {
  const f = await fixture(t);
  const order = await f.book.submit('work_submit', { executor: 'hermes', goal: 'persist me' });
  const first = await f.worker();await first.consumer.tick();
  const state = await f.book.inspect(order.order_id);
  f.native.event(state.conversation_id, 'reasoning.delta', { text: 'private reasoning' });
  f.native.complete(state.conversation_id, 'PERSISTED');
  await first.adapter.writes;
  f.native.event(state.conversation_id, 'message.complete', { text: 'a later reply', status: 'complete' });
  await first.consumer.close();
  const second = await f.worker();await second.consumer.tick();
  const result = await f.book.inspect(order.order_id);
  assert.equal(result.status, 'completed');assert.equal(result.output.text, 'PERSISTED');assert.equal(f.native.prompts.length, 1);
  const receipt = await readFile(join(f.home, 'hermes-receipts', `${order.order_id}.json`), 'utf8');
  assert.ok(!receipt.includes('private reasoning'));assert.ok(!receipt.includes('a later reply'));
});

test('lost native acknowledgement stays uncertain, recovers only this order transcript, and is never replayed', async t => {
  const f = await fixture(t);f.native.loseReply = true;
  const order = await f.book.submit('work_submit', { executor: 'hermes', goal: 'maybe sent' });
  const first = await f.worker();await first.consumer.tick();
  assert.equal((await f.book.inspect(order.order_id)).status, 'uncertain');
  const session = f.native.sessions.get('stored-1');session.status = 'idle';
  session.messages.push({ role: 'assistant', content: 'own result' }, { role: 'user', content: 'later request' }, { role: 'assistant', content: 'later result' });
  await first.consumer.close();
  const second = await f.worker();await second.consumer.tick();await second.consumer.tick();
  const result = await f.book.inspect(order.order_id);
  assert.equal(result.status, 'uncertain');assert.equal(result.output.text, 'own result');
  assert.equal(result.output.terminal_confirmed, false);assert.equal(f.native.prompts.length, 1);
});

test('steer acknowledges delivery separately and cancel reports the Hermes queue semantics', async t => {
  const f = await fixture(t);
  const parent = await f.book.submit('work_submit', { executor: 'hermes', goal: 'working' });
  const { consumer } = await f.worker();await consumer.tick();
  const steer = await f.book.submit('work_update', { target_order: parent.order_id, action: 'interrupt', message: 'extra detail' });
  await consumer.tick();
  assert.equal((await f.book.inspect(steer.order_id)).output.steer_accepted, true);
  assert.equal((await f.book.inspect(parent.order_id)).status, 'executing');
  const cancel = await f.book.submit('work_update', { target_order: parent.order_id, action: 'cancel' });
  await consumer.tick();await consumer.tick();
  assert.equal((await f.book.inspect(parent.order_id)).status, 'cancelled');
  assert.equal((await f.book.inspect(cancel.order_id)).output.native_queue_cleared, true);
  assert.equal((await f.book.inspect(cancel.order_id)).output.local_queued_orders_retained, true);
});

test('Hermes rejects unavailable models and invalid effort before creating native sessions, and respects provider restrictions', async t => {
  const f = await fixture(t);const { consumer } = await f.worker();
  for (const options of [{ provider: 'other', model: 'expensive' }, { model: 'missing' }, { effort: 'invented' }]) {
    const order = await f.book.submit('work_submit', { executor: 'hermes', goal: 'reject', ...options });
    await consumer.tick();assert.equal((await f.book.inspect(order.order_id)).status, 'failed');
  }
  assert.equal(f.native.sessions.size, 0);
  const { models } = await consumer.desktop.describe();assert.deepEqual(models.map(model => model.provider), ['deepseek']);
  f.native.rejection = true;
  const rejected = await f.book.submit('work_submit', { executor: 'hermes', goal: 'rejected natively' });
  await consumer.tick();assert.equal((await f.book.inspect(rejected.order_id)).status, 'failed');
});

test('offline Hermes leaves orders queued and native conversation management preserves archive protections', async t => {
  const f = await fixture(t);f.native.offline = true;
  const task = await f.book.submit('work_submit', { executor: 'hermes', goal: 'later' });
  const { consumer } = await f.worker();await consumer.tick();
  assert.equal((await f.book.inspect(task.order_id)).status, 'queued');
  assert.equal((await f.book.runtime(null, 'hermes')).online, false);
  f.native.offline = false;await consumer.tick();
  const state = await f.book.inspect(task.order_id);
  const archive = await f.book.submit('conversation_control', { executor: 'hermes', action: 'archive', conversation_id: state.conversation_id });
  await consumer.tick();assert.equal((await f.book.inspect(archive.order_id)).status, 'failed');
  f.native.complete(state.conversation_id, 'DONE');await consumer.tick();
  for (const input of [{ action: 'rename', title: 'New title' }, { action: 'archive' }, { action: 'restore' }]) {
    const order = await f.book.submit('conversation_control', { executor: 'hermes', conversation_id: state.conversation_id, ...input });
    await consumer.tick();assert.equal((await f.book.inspect(order.order_id)).status, 'completed');
  }
  assert.equal(f.native.sessions.get(state.conversation_id).title, 'New title');
  assert.equal(f.native.sessions.get(state.conversation_id).archived, false);
  const files = await readdir(f.home);assert.ok(files.includes('runtime-hermes.json'));
});

test('completed receipts are released and a warm restart keeps only the permission locator', async t => {
  const f = await fixture(t);
  await setHermesBoard(f.home, { hermes_permission: 'yolo' });
  const parent = await f.book.submit('work_submit', { executor: 'hermes', goal: 'restart permission' });
  const first = await f.worker();await first.consumer.tick();
  const started = await f.book.inspect(parent.order_id);
  f.native.complete(started.conversation_id, 'FIRST');await first.consumer.tick();
  await first.adapter.writes;
  assert.equal((await f.book.inspect(parent.order_id)).status, 'completed');
  assert.equal(first.adapter.turns.size, 0, 'a completed result is not retained in turns');
  assert.equal(first.adapter.byLive.size, 0);
  await first.consumer.close();

  const sets = f.native.calls.filter(call => call.method === 'config.set').length;
  await setHermesBoard(f.home, {});
  const second = await f.worker();
  assert.equal(second.adapter.store.stats.receiptReads, 0, 'completed bodies are not read on restart');
  assert.equal(second.adapter.turns.size, 0);
  const location = await second.adapter.checkpoint(started.conversation_id);
  assert.equal(location.conversation_id, started.conversation_id);
  assert.deepEqual(location.permission, { preset: 'yolo', scope: 'session', readback: 'session.info', effective_yolo: true });
  assert.equal(second.adapter.store.stats.receiptReads, 0, 'the stored permission comes from the locator index');

  const follow = await f.book.submit('work_update', { target_order: parent.order_id, action: 'append', message: 'again' });
  await second.consumer.tick();
  f.native.complete(started.conversation_id, 'SECOND');await second.consumer.tick();
  const done = await f.book.inspect(follow.order_id);
  assert.equal(done.status, 'completed');
  assert.equal(f.native.calls.filter(call => call.method === 'config.set').length, sets,
    'a follow-up after restart must not rewrite the native permission');
  assert.deepEqual(done.output.permission, { preset: 'yolo', scope: 'session', readback: 'session.info', effective_yolo: true });
  assert.equal(second.adapter.turns.size, 0);
});

test('follow-ups resolve the canonical custom provider from native metadata instead of rejecting the runtime alias', async t => {
  const f = await fixture(t);
  f.settings.providers = ['custom:example'];
  f.native.options.providers.push({ slug: 'custom:example', authenticated: true, models: ['flash'] });
  const parent = await f.book.submit('work_submit', { executor: 'hermes', provider: 'custom:example', model: 'flash', goal: 'custom model' });
  const { consumer } = await f.worker();await consumer.tick();
  const session = f.native.sessions.get('stored-1');
  session.model_config = JSON.stringify({ provider: 'custom:example', model: 'flash' });
  f.native.reportedProvider = 'custom';
  f.native.complete('stored-1', 'done');await consumer.tick();
  const follow = await f.book.submit('work_update', { target_order: parent.order_id, action: 'append', message: 'continue' });
  await consumer.tick();
  assert.equal((await f.book.inspect(follow.order_id)).status, 'executing');
  assert.equal((await f.book.inspect(follow.order_id)).route.provider, 'custom:example');
  session.model_config = JSON.stringify({ provider: 'custom:forbidden' });
  await assert.rejects(consumer.desktop.checkpoint('stored-1'), /outside the worker allowlist/);
});

async function setHermesBoard(home, extra = {}) {
  await writeFile(join(home, 'delegation.json'), JSON.stringify({ enabled: true, executor: 'hermes', ...extra }));
}

test('a saved Hermes yolo permission is applied with config.set session scope before the prompt and read back', async t => {
  const f = await fixture(t);
  await setHermesBoard(f.home, { hermes_permission: 'yolo' });
  const order = await f.book.submit('work_submit', { executor: 'hermes', goal: 'approved turn' });
  const { consumer } = await f.worker();await consumer.tick();
  const state = await f.book.inspect(order.order_id);
  assert.equal(state.status, 'executing');
  const session = f.native.sessions.get(state.conversation_id);
  const setIndex = f.native.calls.findIndex(call => call.method === 'config.set');
  const promptIndex = f.native.calls.findIndex(call => call.method === 'prompt.submit');
  assert.ok(setIndex >= 0, 'the session flag must be written');
  assert.ok(promptIndex > setIndex, 'the permission is applied before the first prompt');
  // Never a global write: only the new session id and the native value.
  assert.deepEqual(f.native.calls[setIndex].params, { key: 'yolo', session_id: session.id, value: '1' });
  assert.equal(f.native.globalYoloWrites, 0);
  assert.equal(f.native.yolo.get(session.session_key), true);

  f.native.complete(state.conversation_id, 'DONE');await consumer.tick();
  const done = await f.book.inspect(order.order_id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.output.permission, {
    preset: 'yolo', scope: 'session', readback: 'session.info', effective_yolo: true,
  });
  assert.equal(done.output.native_yolo, null);

  const catalog = await consumer.desktop.describe();
  assert.equal(catalog.permission_control.available, true);
  assert.deepEqual(catalog.permission_control.presets, ['yolo']);
  assert.equal(catalog.permission_control.default.label, '跟随 Hermes 默认');
  assert.doesNotMatch(catalog.permission_control.default.label, /人工确认|manual/, 'the default must not claim which global approval mode is active');
  assert.match(catalog.permission_control.limitations.join(' '), /不修改全局审批设置|不提供文件系统沙箱/);
});

test('following the Hermes default sends no permission RPC', async t => {
  const f = await fixture(t);
  const order = await f.book.submit('work_submit', { executor: 'hermes', goal: 'native default turn' });
  const { consumer } = await f.worker();await consumer.tick();
  const state = await f.book.inspect(order.order_id);
  assert.equal(state.status, 'executing');
  assert.equal(f.native.calls.filter(call => call.method === 'config.set').length, 0);
  f.native.complete(state.conversation_id, 'DONE');await consumer.tick();
  const done = await f.book.inspect(order.order_id);
  assert.equal(done.status, 'completed');
  assert.equal(done.output.permission, null);
  assert.equal(done.output.native_yolo, null);
});

test('a rejected or non-session-scoped setter response blocks Hermes dispatch before any prompt', async t => {
  const f = await fixture(t);
  await setHermesBoard(f.home, { hermes_permission: 'yolo' });
  const { consumer } = await f.worker();
  for (const mode of ['reject', 'missing-scope', 'global-scope']) {
    f.native.permissionSetMode = mode;
    const order = await f.book.submit('work_submit', { executor: 'hermes', goal: `setter mode ${mode}` });
    await consumer.tick();
    const state = await f.book.inspect(order.order_id);
    assert.equal(state.status, 'failed', `${mode} must not silently start the session`);
    assert.match(state.error, /未应用新会话权限|按会话范围确认/);
  }
  assert.equal(f.native.prompts.length, 0, 'no prompt may reach the native session');
  assert.equal(f.native.globalYoloWrites, 0);
});

test('an unreadable yolo field stays honest: setter confirmation is recorded as setter-only', async t => {
  const f = await fixture(t);
  f.native.permissionInfo = 'omit';
  await setHermesBoard(f.home, { hermes_permission: 'yolo' });
  const order = await f.book.submit('work_submit', { executor: 'hermes', goal: 'setter only readback' });
  const { consumer } = await f.worker();await consumer.tick();
  const state = await f.book.inspect(order.order_id);
  assert.equal(state.status, 'executing');
  f.native.complete(state.conversation_id, 'DONE');await consumer.tick();
  const done = await f.book.inspect(order.order_id);
  assert.deepEqual(done.output.permission, {
    preset: 'yolo', scope: 'session', readback: 'setter-only', effective_yolo: null,
  });
});

test('a damaged Hermes permission value fails before a native session is created', async t => {
  const f = await fixture(t);
  await setHermesBoard(f.home, { hermes_permission: 'smart' });
  const order = await f.book.submit('work_submit', { executor: 'hermes', goal: 'never created' });
  const { consumer } = await f.worker();await consumer.tick();
  const state = await f.book.inspect(order.order_id);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /新会话权限设置值不受支持/);
  assert.equal(f.native.sessions.size, 0);
});

test('Hermes follow-ups neither re-read the board nor rewrite the native session permission', async t => {
  const f = await fixture(t);
  await setHermesBoard(f.home, { hermes_permission: 'yolo' });
  const parent = await f.book.submit('work_submit', { executor: 'hermes', goal: 'first' });
  const { consumer } = await f.worker();await consumer.tick();
  const first = await f.book.inspect(parent.order_id);
  f.native.complete(first.conversation_id, 'FIRST');await consumer.tick();
  const sets = f.native.calls.filter(call => call.method === 'config.set').length;

  // The board no longer pins a permission; the existing conversation must keep
  // the recorded one, and the adapter must not write it again.
  await setHermesBoard(f.home, {});
  const second = await f.book.submit('work_update', { target_order: parent.order_id, action: 'append', message: 'second' });
  await consumer.tick();await consumer.tick();
  const secondState = await f.book.inspect(second.order_id);
  assert.equal(secondState.status, 'executing');
  f.native.complete(first.conversation_id, 'SECOND');await consumer.tick();
  const done = await f.book.inspect(second.order_id);
  assert.equal(done.status, 'completed');
  assert.equal(f.native.calls.filter(call => call.method === 'config.set').length, sets, 'a follow-up must not reset permissions');
  assert.equal(done.output.native_yolo, true, 'the native session kept the original permission');
  assert.deepEqual(done.output.permission, { preset: 'yolo', scope: 'session', readback: 'session.info', effective_yolo: true });
});

test('a follow-up of a legacy Hermes task never picks up a permission saved later', async t => {
  const f = await fixture(t);
  const parent = await f.book.submit('work_submit', { executor: 'hermes', goal: 'legacy' });
  const { consumer } = await f.worker();await consumer.tick();
  const first = await f.book.inspect(parent.order_id);
  f.native.complete(first.conversation_id, 'FIRST');await consumer.tick();

  await setHermesBoard(f.home, { hermes_permission: 'yolo' });
  const second = await f.book.submit('work_update', { target_order: parent.order_id, action: 'append', message: 'later' });
  await consumer.tick();await consumer.tick();
  f.native.complete(first.conversation_id, 'SECOND');await consumer.tick();
  const done = await f.book.inspect(second.order_id);
  assert.equal(done.status, 'completed');
  assert.equal(f.native.calls.filter(call => call.method === 'config.set').length, 0);
  assert.equal(done.output.permission, null);
});
