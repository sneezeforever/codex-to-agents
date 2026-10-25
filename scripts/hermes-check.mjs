import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OrderBook } from '../src/orders.mjs';
import { HermesClient } from '../src/hermes-client.mjs';
import { ensureBackend, stopBackend } from '../src/backend-control.mjs';

const { values } = parseArgs({ options: { 'hermes-url': { type: 'string', default: 'http://127.0.0.1:9120' },
  provider: { type: 'string' }, model: { type: 'string' } } });
const root = fileURLToPath(new URL('../', import.meta.url));
const run = join(root, '.local', `hermes-check-${randomUUID()}`);
const home = join(run, 'orders');
const directory = join(run, 'project');
await mkdir(directory, { recursive: true });
const book = new OrderBook(home);await book.open();
const report = { started: new Date().toISOString(), checks: [], run };
let client = new Client({ name: 'codex-to-agents-hermes-check', version: '1.0' });
const clients = [client];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let conversation;
async function tool(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content.map(block => block.text ?? '').join('\n'));
  return response.structuredContent;
}
// Polling only needs the bounded summary; the native final result is fetched
// with an explicit detail view only where it is asserted.
async function complete(id) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const state = await tool('work_inspect', { order_id: id });
    if (state.kind === 'work_submit' && state.conversation_id) conversation ??= state.conversation_id;
    if (state.status === 'completed') return state;
    if (['failed', 'uncertain', 'cancelled', 'blocked'].includes(state.status)) throw new Error(`Hermes order ${id} ${state.status}: ${state.error ?? state.progress ?? 'no details'}`);
    await pause(500);
  }
  throw new Error(`Hermes work order did not finish: ${id}`);
}
const detail = id => tool('work_inspect', { order_id: id, view: 'detail' });
async function operation(name, args) { return complete((await tool(name, args)).order_id); }
try {
  const probe = new HermesClient({ url: values['hermes-url'] });
  const catalog = await probe.request('/api/model/options');probe.close();
  const provider = values.provider ?? catalog.provider;
  const model = values.model ?? (provider === catalog.provider ? catalog.model : null);
  assert.ok(model, 'Specify --model when using a non-default provider.');
  report.provider = provider;report.model = model;
  const transport = () => new StdioClientTransport({ command: process.execPath,
    args: [join(root, 'src/command.mjs'), 'serve', '--home', home, '--hermes-url', values['hermes-url'], '--provider', provider, '--directory', directory], stderr: 'pipe' });
  const payload = { order_id: randomUUID(), executor: 'hermes', directory, provider, model, effort: 'low', title: 'Hermes 接入实机验证',
    goal: '这是用户授权的 Hermes 执行端接入验收。请只在当前任务目录创建 hello.txt，文件内容严格为 HERMES_OK 加一个换行。不读取任务目录外文件、不访问网络、不委派子代理。完成后只回复 HERMES_DONE。' };
  const queued = await book.submit('work_submit', payload);
  assert.equal(queued.status, 'queued');
  report.checks.push('A Hermes work order is durable before the consumer starts');
  await client.connect(transport());
  const done = await complete(queued.order_id);conversation = done.conversation_id;
  assert.equal(await readFile(join(directory, 'hello.txt'), 'utf8'), 'HERMES_OK\n');
  const doneDetail = await detail(queued.order_id);
  assert.equal(done.executor, 'hermes');assert.ok(doneDetail.output.text.includes('HERMES_DONE'));
  assert.equal((await tool('runtime_info', { executor: 'hermes' })).online, true);
  report.checks.push('A real MCP client caused Hermes to create the expected file and received the native final result');
  const again = await tool('work_submit', payload);
  assert.equal(again.reused, true);assert.equal(again.status, 'completed');
  report.checks.push('Retrying the same work order reuses its result');
  const first = await tool('work_update', { target_order: queued.order_id, action: 'append', message: '不要调用工具，只回复 HERMES_FIRST。' });
  const second = await tool('work_update', { target_order: queued.order_id, action: 'append', message: '不要调用工具，只回复 HERMES_SECOND。' });
  const one = await complete(first.order_id);const two = await complete(second.order_id);
  const oneDetail = await detail(first.order_id);const twoDetail = await detail(second.order_id);
  assert.equal(one.executor, 'hermes');assert.equal(two.conversation_id, conversation);
  assert.ok(oneDetail.output.text.includes('HERMES_FIRST'));assert.ok(!oneDetail.output.text.includes('HERMES_SECOND'));
  assert.ok(twoDetail.output.text.includes('HERMES_SECOND'));
  report.checks.push('Two same-session follow-ups inherit Hermes and return independent results in order');
  const previousPid = (await tool('runtime_info', { executor: 'hermes' })).snapshot.pid;
  const standby = new Client({ name: 'codex-to-agents-hermes-standby-check', version: '1.0' });
  clients.push(standby);await standby.connect(transport());
  await client.close();client = standby;
  assert.equal((await tool('runtime_info', { executor: 'hermes' })).snapshot.pid, previousPid);
  report.checks.push('A second MCP connection shares the same Hermes backend after the first connection closes');
  await stopBackend(home);await ensureBackend(home);
  let tookOver = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const runtime = await tool('runtime_info', { executor: 'hermes' });
    if (runtime.online && runtime.snapshot.pid !== previousPid) { tookOver = true;break; }
    await pause(250);
  }
  assert.equal(tookOver, true);report.checks.push('The shared backend restarts with the same stored orders and native conversation');
  await operation('conversation_control', { executor: 'hermes', action: 'rename', conversation_id: conversation, title: `Hermes 已验收 ${queued.order_id.slice(0, 8)}` });
  await operation('conversation_control', { executor: 'hermes', action: 'archive', conversation_id: conversation });
  await operation('conversation_control', { executor: 'hermes', action: 'restore', conversation_id: conversation });
  const list = await detail((await operation('conversation_control', { executor: 'hermes', action: 'list' })).order_id);
  assert.ok(list.output.conversations.some(item => item.id === conversation));
  report.checks.push('Native conversation rename, archive, restore and list succeed');
  report.passed = true;report.conversation_id = conversation;
} catch (error) {
  report.passed = false;report.error = error.message;process.exitCode = 1;
} finally {
  if (conversation) {
    try { await operation('conversation_control', { executor: 'hermes', action: 'archive', conversation_id: conversation, stop_running: true }); }
    catch (error) { report.cleanup_error = error.message;report.passed = false;process.exitCode = 1; }
    // A timed-out native turn can remain detached after interruption. Close
    // only this test's live session, retaining its archived native history.
    const cleanup = new HermesClient({ url: values['hermes-url'] });
    try {
      const { sessions } = await cleanup.call('session.active_list');
      for (const session of sessions.filter(item => item.session_key === conversation)) {
        await cleanup.call('session.close', { session_id: session.id });
      }
      report.native_session_closed = true;
    } catch (error) { report.cleanup_error = error.message;report.passed = false;process.exitCode = 1; }
    finally { cleanup.close(); }
  }
  for (const current of clients) await current.close();
  await stopBackend(home);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await book.runtime(null, 'hermes')).online) { report.consumer_stopped = true;break; }
    await pause(250);
  }
  report.finished = new Date().toISOString();
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(root, '.local/latest-hermes-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
