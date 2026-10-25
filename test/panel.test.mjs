import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, access, mkdir, chmod, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcp } from '../src/mcp.mjs';
import { OrderBook } from '../src/orders.mjs';
import { readDelegation, saveDelegation, delegationContext, runDelegationHook } from '../src/delegation.mjs';
import { preparePlugin } from '../src/plugin.mjs';
import { PANEL_URI, registerPanel } from '../src/panel.mjs';
import { monitorWeb } from '../src/monitor-web.mjs';
import { namedNode } from '../src/processes.mjs';
import { stopBackend } from '../src/backend-control.mjs';
import { readSddState, runSddAction } from '../src/sdd-workspace.mjs';

const run = (command, args, { input = '', ...options } = {}) => new Promise((resolve, reject) => {
  const child = execFile(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  child.stdin.end(input);
});
const entry = fileURLToPath(new URL('../src/command.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp('/tmp/cta-panel-');
  t.after(async () => { await stopBackend(root);await rm(root, { recursive: true, force: true }); });
  return root;
}

test('delegation defaults OFF without creating files; ON/OFF only changes preference and hook context', async t => {
  const root = await fixture(t);const home = join(root, 'absent');
  assert.deepEqual(await readDelegation(home), { enabled: false, executor: 'hermes' });
  await assert.rejects(access(home), { code: 'ENOENT' });
  await saveDelegation(home, { enabled: true, executor: 'hermes' });
  const book = new OrderBook(home);
  const task = await book.submit('work_submit', { executor: 'hermes', goal: 'existing task' });
  await book.transition(task.order_id, 'executing', { conversation_id: 'native' });
  const context = await delegationContext(home);
  assert.match(context, /executor: "hermes"/);
  assert.match(context, /work_submit 的 order_id 可省略并由系统生成/);
  assert.match(context, /crypto\.randomUUID\(\)/);
  assert.match(context, /首次提交与不确定重试沿用同一个 order_id 和完全相同的参数/);
  assert.match(context, /不得把任务名、cw- 会话 ID 或示例占位符当作 order_id/);
  // ON guidance is phased and executable: read the board-selected workspace,
  // classify by project name, create the full plan in one write, hand over the
  // absolute task.md path after a real receipt, stop after planning-only work,
  // and reuse only IDs previously returned for that same task.
  assert.match(context, /sdd_task/);
  assert.match(context, /get_workspace/);
  assert.match(context, /按项目名称/);
  assert.match(context, /不能把代码路径当作文档根/);
  assert.match(context, /目标、范围、计划和验收条件/);
  assert.match(context, /一次完整非空正文/);
  assert.match(context, /task\.md 绝对路径/);
  assert.match(context, /work_submit 的 goal/);
  assert.match(context, /执行工作目录仍由 work_submit 的 directory 或 workspace_id 指向实际代码项目/);
  assert.match(context, /3\. 仅规划：用户只要求规划时，完成第 2 步并交付规划后即结束，不继续以下派工步骤，不调用 work_submit/);
  assert.match(context, /普通问答、讨论不创建任务文档/);
  assert.match(context, /先 read_task 获取最新 revision，再 save_task 更新原文档/);
  assert.match(context, /只复用当前任务已经返回的 workspace_id、project_id、task_id/);
  assert.match(context, /不能因为名称或标题相同就自行认定为同一任务/);
  assert.match(context, /同一任务不要重复 create_task/);
  assert.match(context, /不同任务即使同名也分别创建/);
  assert.match(context, /真实回执/);
  assert.match(context, /路径交接/);
  assert.match(context, /不扫描或改写项目里的其他文档/);
  assert.match(context, /只保存文档不会自动派工/);
  assert.match(context, /不得假称已保存/);
  assert.match(context, /跳过或不需要文档时遵从/);
  assert.match(context, /sdd_task 缺失或保存失败/);
  const phases = ['1. 分析', '2. 保存', '3. 仅规划', '4. 路径交接与派工', '5. 同一任务更新', '6. 边界']
    .map(phase => context.indexOf(phase));
  assert.ok(phases.every(index => index >= 0), 'the hook is split into explicit phases');
  assert.ok(phases.every((index, position) => position === 0 || phases[position - 1] < index), 'the phases stay in order');
  const planningOnly = context.slice(phases[2], phases[3]);
  assert.match(planningOnly, /即结束/);
  assert.match(planningOnly, /不继续以下派工步骤/);
  assert.ok(!planningOnly.includes('work_inspect'), 'planning-only guidance stops before the dispatch step');
  assert.ok(!context.includes('set_workspace'), 'the hook must not invite the model to switch the document root');
  // With SDD explicitly OFF, an OFF delegation context gives no document steps.
  await runSddAction(home, { action: 'set_enabled', enabled: false });
  await saveDelegation(home, { enabled: false, executor: 'dsh' });
  const offContext = await delegationContext(home);
  assert.match(offContext, /取代本会话之前/);
  assert.ok(!offContext.includes('sdd_task'), 'OFF delegation + OFF SDD gives no automatic document instructions');
  assert.equal((await book.inspect(task.order_id)).status, 'executing');
  assert.equal((await book.list()).length, 1);
  await assert.rejects(saveDelegation(home, { enabled: 'true', executor: 'hermes' }));
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'other' }));
  assert.equal((await readDelegation(home)).enabled, false);
  await writeFile(join(home, 'delegation.json'), '{corrupt');
  assert.match(await delegationContext(home), /本轮按关闭处理/);
  let output = '';
  await runDelegationHook(home, Readable.from(['{"prompt":"do not leak this"}']), new Writable({ write(chunk, _, done) { output += chunk;done(); } }));
  const hook = JSON.parse(output);
  assert.equal(hook.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(!output.includes('do not leak this'));
});

test('the SDD and delegation switches drive four independent hook combinations', async t => {
  const home = await fixture(t);
  const sdd = enabled => runSddAction(home, { action: 'set_enabled', enabled });
  const delegate = enabled => saveDelegation(home, { enabled, executor: 'hermes' });

  // 1. SDD ON + delegation ON: save the plan, then hand over the real path and
  // dispatch (the phased guidance from the first test).
  await delegate(true);
  let context = await delegationContext(home);
  assert.match(context, /2\. 保存/);
  assert.match(context, /task\.md 绝对路径/);
  assert.match(context, /work_submit（executor: "hermes"）/);

  // 2. SDD OFF + delegation ON: the old document context is overridden; the
  // dispatch path stays intact with no document/path requirement.
  await sdd(false);
  context = await delegationContext(home);
  assert.match(context, /SDD 任务文档开关当前为关闭/);
  assert.match(context, /跳过任务文档保存与 task\.md 路径交接/);
  assert.match(context, /直接按以下要求派工/);
  assert.match(context, /work_submit（executor: "hermes"）/);
  assert.match(context, /crypto\.randomUUID\(\)/, 'order-id safety still applies without documents');
  assert.ok(!context.includes('sdd_task'), 'OFF SDD must not invite the model to write documents');
  assert.doesNotMatch(context, /task\.md 绝对路径|路径交接与派工|2\. 保存/);

  // 3. SDD ON + delegation OFF: a plan may be saved, but nothing is dispatched.
  await sdd(true);
  await delegate(false);
  context = await delegationContext(home);
  assert.match(context, /自动派工开关当前为关闭/);
  assert.match(context, /sdd_task/);
  assert.match(context, /保存后直接交付规划/);
  assert.match(context, /只保存文档不会自动派工/);
  assert.ok(!/使用 work_submit/.test(context), 'planning-only OFF must not instruct a dispatch');

  // 4. SDD OFF + delegation OFF: neither document nor dispatch guidance.
  await sdd(false);
  context = await delegationContext(home);
  assert.match(context, /自动派工开关当前为关闭/);
  assert.match(context, /本轮不要创建或更新任务文档/);
  assert.ok(!context.includes('sdd_task'));
  assert.ok(!context.includes('work_submit'));

  // A damaged SDD file is treated as OFF and never as the legacy ON default;
  // delegation still works and writes stay blocked.
  await writeFile(join(home, 'sdd-workspace.json'), '{corrupt');
  await delegate(true);
  context = await delegationContext(home);
  assert.match(context, /SDD 任务文档配置无法读取，本轮按关闭处理/);
  assert.match(context, /work_submit（executor: "hermes"）/);
  assert.ok(!context.includes('sdd_task'));
  const broken = await readSddState(home);
  assert.equal(broken.enabled, false);
  assert.match(broken.error, /配置损坏/);

  // The two switches never overwrite each other's files.
  await runSddAction(home, { action: 'set_workspace', directory: join(home, 'recovered-docs') });
  assert.equal((await readSddState(home)).enabled, false, 'repairing the root keeps SDD OFF');
  const delegation = JSON.parse(await readFile(join(home, 'delegation.json'), 'utf8'));
  assert.equal(delegation.enabled, true);
  await sdd(true);
  assert.equal((await readDelegation(home)).enabled, true, 'the SDD switch does not change delegation');
  await delegate(false);
  assert.equal((await readSddState(home)).enabled, true, 'the delegation switch does not change SDD');
});

test('fixed model preferences validate catalog efforts, clear stale strengths, and can turn OFF while offline', async t => {
  const home = await fixture(t);const book = new OrderBook(home);await book.open();
  const route = { provider: 'account', model: 'shared-id' };
  const plain = { provider: 'account', model: 'plain-id' };
  const catalog = { models: [
    { ...route, efforts: ['low', 'high'], default_effort: 'low' },
    { ...plain, efforts: [] },
  ] };
  const online = async (value = catalog) => book.runtime({ active: true, at: new Date().toISOString(), catalog: value }, 'dsh');
  await online();
  await saveDelegation(home, { enabled: true, executor: 'dsh', route, effort: 'high' });
  assert.deepEqual((await readDelegation(home)).route, route);
  assert.equal((await readDelegation(home)).effort, 'high');
  assert.match(await delegationContext(home), /executor: "dsh", provider: "account", model: "shared-id", effort: "high"/);
  assert.match(await delegationContext(home), /不可用时说明原因，不静默替换或降级强度/);
  // "default" means no pinned strength: persist no effort and omit it from the hook.
  await saveDelegation(home, { enabled: true, executor: 'dsh', route, effort: 'default' });
  assert.equal((await readDelegation(home)).effort, undefined);
  let context = await delegationContext(home);
  assert.doesNotMatch(context, /effort: /);
  assert.match(context, /思考强度跟随模型默认/);
  assert.match(context, /不显式传 effort/);
  // Only catalog efforts are valid, and only alongside a fixed route.
  const before = await readFile(join(home, 'delegation.json'), 'utf8');
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', route, effort: 'invented' }), /思考强度/);
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', route: plain, effort: 'low' }), /思考强度/);
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', effort: 'high' }), /思考强度需要与固定模型/);
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', route: { ...route, provider: 'other' }, effort: 'high' }), /不可用/);
  assert.equal(await readFile(join(home, 'delegation.json'), 'utf8'), before);
  // Re-pin, then an offline save may still close the switch and keep the pin.
  await saveDelegation(home, { enabled: true, executor: 'dsh', route, effort: 'high' });
  await book.runtime({ active: false, at: new Date().toISOString(), catalog }, 'dsh');
  await saveDelegation(home, { enabled: false, executor: 'dsh', route, effort: 'high' });
  assert.deepEqual((await readDelegation(home)).route, route);
  assert.equal((await readDelegation(home)).effort, 'high');
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', route, effort: 'high' }), /未连接/);
  assert.equal((await readDelegation(home)).enabled, false);
  // Catalog errors still block a new selection instead of silently dropping effort.
  await online({ models: [{ ...route, efforts: ['low', 'high'] }], error: 'catalog failed' });
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', route, effort: 'high' }), /目录暂时不可用/);
  await online();
  // Switching models clears the strength; switching executor clears both.
  await saveDelegation(home, { enabled: true, executor: 'dsh', route: plain });
  assert.equal((await readDelegation(home)).effort, undefined);
  assert.deepEqual((await readDelegation(home)).route, plain);
  await saveDelegation(home, { enabled: true, executor: 'hermes' });
  assert.equal((await readDelegation(home)).route, undefined);
  assert.equal((await readDelegation(home)).effort, undefined);
  context = await delegationContext(home);
  assert.match(context, /跟随执行端默认模型和思考强度/);
  assert.match(context, /不沿用本会话之前的固定模型偏好或固定强度/);
  assert.equal((await book.list()).length, 0);
});

test('Dsh permission preference is optional, strictly validated and cleared with "default"', async t => {
  const home = await fixture(t);
  const file = join(home, 'delegation.json');
  const book = new OrderBook(home);await book.open();
  const ALL_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'];
  const advertise = () => book.runtime({ active: true, protocol: 2, at: new Date().toISOString(),
    catalog: { models: [], permission_control: { available: true, presets: ALL_PRESETS } } });
  // Old preferences without the field keep their exact meaning: follow DSH default.
  await saveDelegation(home, { enabled: true, executor: 'dsh' });
  let stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal('dsh_permission' in stored, false);
  assert.equal((await readDelegation(home)).dsh_permission, undefined);
  // Each native preset name is stored verbatim; it is not a sandbox/approval pair.
  for (const preset of ALL_PRESETS) {
    await advertise();
    await saveDelegation(home, { enabled: true, executor: 'dsh', dsh_permission: preset });
    assert.equal((await readDelegation(home)).dsh_permission, preset);
    stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.dsh_permission, preset);
    assert.equal(typeof stored.dsh_permission, 'string');
  }
  // A changed explicit permission is rejected unless the RUNNING consumer
  // advertises native control; an old heartbeat or offline DSH must not let the
  // board persist a value the old end would silently ignore.
  const pinned = await readFile(file, 'utf8');
  await book.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog: { models: [] } });
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', dsh_permission: 'read-only' }), /未提供新会话权限/);
  assert.equal(await readFile(file, 'utf8'), pinned);
  await book.runtime({ active: false, protocol: 2, at: new Date().toISOString(), catalog: { models: [] } });
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', dsh_permission: 'read-only' }), /DSH 未连接/);
  // Unchanged values stay saveable offline, like the pinned model route.
  await saveDelegation(home, { enabled: false, executor: 'dsh', dsh_permission: 'danger-full-access' });
  assert.equal((await readDelegation(home)).enabled, false);
  assert.equal((await readDelegation(home)).dsh_permission, 'danger-full-access');
  // An explicit "default" clears the field without needing a live DSH.
  await saveDelegation(home, { enabled: false, executor: 'dsh', dsh_permission: 'default' });
  stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal('dsh_permission' in stored, false);
  // Unknown values, free-form bundles and abandoned sessions cannot be persisted.
  const before = await readFile(file, 'utf8');
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', dsh_permission: 'everything' }));
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', dsh_permission: { sandbox: 'danger-full-access', approval: 'never' } }));
  assert.equal(await readFile(file, 'utf8'), before);
  // Hermes may coexist with a stored DSH preference, but the model-facing
  // dispatch prompt never claims it as a permission setting.
  await advertise();
  await saveDelegation(home, { enabled: true, executor: 'hermes', dsh_permission: 'read-only' });
  assert.equal((await readDelegation(home)).dsh_permission, 'read-only');
  assert.equal((await readDelegation(home)).executor, 'hermes');
  const context = await delegationContext(home);
  assert.match(context, /executor: "hermes"/);
  assert.doesNotMatch(context, /dsh_permission|read-only/);
});

test('saving one executor keeps the other executors permissions, and default clears only that executor', async t => {
  const home = await fixture(t);
  const book = new OrderBook(home);await book.open();
  const advertise = (executor, presets) => book.runtime({ active: true, protocol: 2, at: new Date().toISOString(),
    catalog: { models: [], permission_control: { available: true, presets } } }, executor);
  await advertise('dsh', ['read-only', 'workspace-write', 'danger-full-access']);
  await advertise('hermes', ['yolo']);
  await advertise('qoder', ['accept_edits', 'dont_ask', 'auto', 'bypass_permissions']);

  await saveDelegation(home, { enabled: true, executor: 'dsh', dsh_permission: 'read-only' });
  await saveDelegation(home, { enabled: true, executor: 'hermes', hermes_permission: 'yolo' });
  await saveDelegation(home, { enabled: true, executor: 'qoder', qoder_permission: 'accept_edits' });
  let stored = await readDelegation(home);
  assert.equal(stored.dsh_permission, 'read-only');
  assert.equal(stored.hermes_permission, 'yolo');
  assert.equal(stored.qoder_permission, 'accept_edits');
  // The same executor's later choice replaces only that field.
  await saveDelegation(home, { enabled: true, executor: 'qoder', qoder_permission: 'dont_ask' });
  stored = await readDelegation(home);
  assert.equal(stored.dsh_permission, 'read-only');
  assert.equal(stored.hermes_permission, 'yolo');
  assert.equal(stored.qoder_permission, 'dont_ask');
  // Explicit default clears exactly one executor's fixed value, even offline.
  await book.runtime({ active: false, protocol: 2, at: new Date().toISOString(), catalog: { models: [] } }, 'hermes');
  await saveDelegation(home, { enabled: true, executor: 'hermes', hermes_permission: 'default' });
  stored = await readDelegation(home);
  assert.equal(stored.hermes_permission, undefined);
  assert.equal(stored.dsh_permission, 'read-only');
  assert.equal(stored.qoder_permission, 'dont_ask');
  const raw = JSON.parse(await readFile(join(home, 'delegation.json'), 'utf8'));
  assert.equal('hermes_permission' in raw, false);

  // Unknown native values for any executor are rejected without touching the file.
  const before = await readFile(join(home, 'delegation.json'), 'utf8');
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'hermes', hermes_permission: 'auto' }));
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'qoder', qoder_permission: 'plan' }));
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', dsh_permission: 'acceptAll' }));
  assert.equal(await readFile(join(home, 'delegation.json'), 'utf8'), before);
  // A changed value without the running executor's capability cannot be saved.
  await book.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog: { models: [] } }, 'qoder');
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'qoder', qoder_permission: 'bypass_permissions' }), /未提供新会话权限/);
  stored = await readDelegation(home);
  assert.equal(stored.qoder_permission, 'dont_ask');
  // A damaged stored value is rejected on read instead of silently used.
  await writeFile(join(home, 'delegation.json'), JSON.stringify({ enabled: true, executor: 'qoder', qoder_permission: 'plan' }));
  await assert.rejects(readDelegation(home));
});

test('Qoder delegation uses only the live catalog and keeps DSH permissions separate', async t => {
  const home = await fixture(t);
  const book = new OrderBook(home);await book.open();
  const advertise = catalog => book.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog }, 'qoder');
  await advertise({ models: [{ provider: 'qoder', model: 'Auto', name: 'Auto', efforts: [] }] });
  const saved = await saveDelegation(home, { enabled: true, executor: 'qoder', route: { provider: 'qoder', model: 'Auto' } });
  assert.equal(saved.executor, 'qoder');
  assert.deepEqual(saved.route, { provider: 'qoder', model: 'Auto' });
  assert.equal(saved.dsh_permission, undefined);
  const context = await delegationContext(home);
  assert.match(context, /executor: "qoder"/);
  assert.match(context, /provider: "qoder", model: "Auto"/);
  assert.doesNotMatch(context, /dsh_permission|read-only/);
  // Unknown models and unadvertised efforts are rejected instead of guessed.
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'qoder', route: { provider: 'qoder', model: 'Missing' } }), /所选模型当前不可用/);
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'qoder', route: { provider: 'qoder', model: 'Auto' }, effort: 'high' }), /思考强度当前不可用/);
  // An unchanged pinned route stays saveable offline; selecting a different
  // model still requires the executor to be connected.
  await saveDelegation(home, { enabled: false, executor: 'qoder', route: { provider: 'qoder', model: 'Auto' } });
  await book.runtime({ active: false, protocol: 2, at: new Date().toISOString(), catalog: { models: [] } }, 'qoder');
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'qoder', route: { provider: 'qoder', model: 'Missing' } }), /执行端未连接/);
});

test('panel_settings persists the DSH permission through the in-memory app-only MCP surface', async t => {
  // The native-backend panel test cannot spawn on this host (EPERM on the
  // launcher hardlink), so this exercises the same tool wiring without it.
  const home = await fixture(t);
  const server = new McpServer({ name: 'panel-permission-test', version: '1.0' });
  registerPanel(server, home, { snapshot: () => ({ delegation: { enabled: false, executor: 'hermes' } }) });
  const client = new Client({ name: 'panel-permission-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close();await server.close(); });
  await server.connect(a);await client.connect(b);
  // The permission field is user-owned: this tool is app-only and the model
  // never sees it in its tool catalog.
  const { tools } = await client.listTools();
  assert.deepEqual(tools.find(tool => tool.name === 'panel_settings')._meta.ui.visibility, ['app']);
  const book = new OrderBook(home);await book.open();
  const advertise = () => book.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog: {
    models: [], permission_control: { available: true, presets: ['read-only', 'workspace-write', 'danger-full-access'] },
  } });
  await advertise();
  const settings = input => client.callTool({ name: 'panel_settings', arguments: input });
  const accepted = await settings({ enabled: true, executor: 'dsh', dsh_permission: 'read-only' });
  assert.equal(accepted.isError, undefined);
  assert.equal(accepted.structuredContent.dsh_permission, 'read-only');
  assert.equal((await readDelegation(home)).dsh_permission, 'read-only');
  // An unsupported value is rejected at the MCP boundary and changes nothing.
  const rejected = await settings({ enabled: true, executor: 'dsh', dsh_permission: 'full' });
  assert.equal(rejected.isError, true);
  assert.equal((await readDelegation(home)).dsh_permission, 'read-only');
  // A running old consumer cannot advertise native control, so a changed value
  // is refused at save time instead of being stored for an end that ignores it.
  await book.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog: { models: [] } });
  const stale = await settings({ enabled: true, executor: 'dsh', dsh_permission: 'workspace-write' });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /未提供新会话权限/);
  assert.equal((await readDelegation(home)).dsh_permission, 'read-only');
  await advertise();
  assert.equal((await settings({ enabled: true, executor: 'dsh', dsh_permission: 'workspace-write' })).isError, undefined);
  // "default" clears the saved field through the same tool.
  const cleared = await settings({ enabled: true, executor: 'dsh', dsh_permission: 'default' });
  assert.equal(cleared.structuredContent.dsh_permission, undefined);
  assert.equal((await readDelegation(home)).dsh_permission, undefined);
});

test('panel refresh targets the stored or selected executor and returns without waiting for initialization', { timeout: 3000 }, async t => {
  const home = await fixture(t);await saveDelegation(home, { enabled: false, executor: 'dsh' });
  const refreshed = [];
  let healthChecks = 0;
  const server = await createMcp(home, { panelOnly: true, onPanel: () => { healthChecks++;return new Promise(() => {}); }, onRuntime: executor => {
    refreshed.push(executor);return new Promise(() => {});
  } });
  const client = new Client({ name: 'panel-refresh-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close();await server.close(); });
  await server.connect(a);await client.connect(b);
  const call = args => client.callTool({ name: 'panel_snapshot', arguments: args });
  await call({});assert.deepEqual(refreshed, []);
  assert.equal((await call({ refresh_models: true })).structuredContent.delegation.executor, 'dsh');
  await call({ refresh_models: true, executor: 'hermes' });
  await call({ refresh_models: true, executor: 'qoder' });
  assert.deepEqual(refreshed, ['dsh', 'hermes', 'qoder']);
  assert.equal(healthChecks, 4);
  assert.equal((await new OrderBook(home).list()).length, 0);
});

test('the panel default snapshot exposes settings only and never reads work-order history', async t => {
  const home = await fixture(t);
  const book = new OrderBook(home);await book.open();
  const marker = 'ORDER-BODY-MARKER';
  const order = await book.submit('work_submit', { goal: `${marker} goal`, title: `${marker} title` });
  await book.transition(order.order_id, 'executing', {
    conversation_id: 'cw-marker', progress: marker, output: { text: marker },
  });
  const damaged = await book.submit('work_submit', { goal: 'damaged history' });
  await writeFile(join(home, 'states', `${damaged.order_id}.json`), '{broken');
  await writeFile(join(home, 'requests', `${damaged.order_id}.json`), '{broken');
  await saveDelegation(home, { enabled: true, executor: 'dsh' });
  const catalog = { models: [{ provider: 'account', model: 'flash', name: 'Flash' }] };
  await book.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog });

  // No snapshot override: this is exactly the default entry the board uses.
  const server = new McpServer({ name: 'panel-settings-contract', version: '1.0' });
  registerPanel(server, home);
  const client = new Client({ name: 'panel-settings-contract', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close();await server.close(); });
  await server.connect(a);await client.connect(b);
  const snapshot = async () => client.callTool({ name: 'panel_snapshot', arguments: {} });
  const allowed = ['delegation', 'generated_at', 'service', 'usage', 'warnings', 'worker'];

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await snapshot();
    assert.equal(response.isError, undefined);
    const value = response.structuredContent;
    assert.deepEqual(Object.keys(value).sort(), allowed, 'settings carry no work orders, agents or summaries');
    assert.ok(!JSON.stringify(value).includes(marker), 'the settings snapshot never contains a work-order body');
    assert.deepEqual(value.warnings, [], 'a damaged history must not even produce settings warnings');
    assert.equal(value.delegation.executor, 'dsh');
    assert.deepEqual(value.worker.executors.dsh.models, catalog.models, 'the live model catalog stays available');
  }
  // Everything the shared settings page writes still works.
  const saved = await client.callTool({ name: 'panel_settings', arguments: { enabled: false, executor: 'qoder' } });
  assert.equal(saved.isError, undefined);
  assert.equal((await snapshot()).structuredContent.delegation.executor, 'qoder');

  // Unreadable work-order directories prove the snapshot takes no history
  // dependency at all: a reader would now fail or report a work-order warning.
  await chmod(join(home, 'requests'), 0o000);
  await chmod(join(home, 'states'), 0o000);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const value = (await snapshot()).structuredContent;
      assert.deepEqual(Object.keys(value).sort(), allowed);
      assert.deepEqual(value.warnings, []);
      assert.equal(value.delegation.executor, 'qoder');
      assert.ok(!JSON.stringify(value).includes(marker));
    }
  } finally {
    await chmod(join(home, 'requests'), 0o700);
    await chmod(join(home, 'states'), 0o700);
  }
  assert.equal((await book.inspect(order.order_id)).status, 'executing', 'the snapshot never mutates or discards saved work');
});

test('real panel MCP exposes sidebar/resource and app-only settings, persists across connections, and never publishes orders', async t => {
  const home = await fixture(t);
  // This test reaches the shared backend over stdio; keep it off the production
  // statistics endpoint.
  await writeFile(join(home, 'usage-settings.json'), '{"enabled":false}\n');
  const connect = async () => {
    const client = new Client({ name: 'panel-test', version: '1.0' });
    await client.connect(new StdioClientTransport({ command: await namedNode(home, 'agents-board'), args: [entry, 'serve', '--panel-only', '--home', home], stderr: 'pipe' }));
    t.after(() => client.close());return client;
  };
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['open_panel', 'panel_sdd', 'panel_settings', 'panel_snapshot', 'panel_update', 'panel_usage'],
    'the board catalog includes the user-owned usage switch');
  const opener = tools.find(tool => tool.name === 'open_panel');
  assert.equal(opener._meta.ui.resourceUri, PANEL_URI);
  assert.deepEqual(opener._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.deepEqual(tools.find(tool => tool.name === 'panel_settings')._meta.ui.visibility, ['app']);
  assert.deepEqual(tools.find(tool => tool.name === 'panel_sdd')._meta.ui.visibility, ['app']);
  assert.deepEqual(tools.find(tool => tool.name === 'panel_update')._meta.ui.visibility, ['app']);
  assert.equal((await client.listResources()).resources[0].uri, PANEL_URI);
  const { contents } = await client.readResource({ uri: PANEL_URI });
  assert.equal(contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.equal(contents[0]._meta['openai/ui'].preferredDisplayMode, 'fullscreen');
  assert.match(contents[0].text, /ui\/initialize/);assert.match(contents[0].text, /自动派工/);
  assert.match(contents[0].text, /未保存过选择时默认开启，可随时关闭/);
  assert.doesNotMatch(contents[0].text, /默认关闭，由你决定是否开启/);
  assert.match(contents[0].text, /id="usage-message"[^>]*>正在读取统计设置/);
  assert.match(contents[0].text, /id="delegation-model"/);
  assert.match(contents[0].text, /id="delegation-effort"/);
  assert.match(contents[0].text, /id="delegation-permission"/);
  // The default option and the native list are rendered from the running
  // executor's capability, so the static shell only carries a neutral
  // placeholder. Real option rendering is covered by monitor-client tests.
  assert.match(contents[0].text, /<option value="">跟随执行端默认<\/option>/);
  assert.ok(!contents[0].text.includes('<option value="read-only">'), 'no executor-specific option is hardcoded in the shell');
  assert.match(contents[0].text, /hermes_permission/);
  assert.match(contents[0].text, /qoder_permission/);
  assert.match(contents[0].text, /permission_control/);
  // The always-present fourth field uses the shared responsive grid; no
  // executor-specific track count remains.
  assert.match(contents[0].text, /@media\(max-width:820px\)/);
  assert.ok(!contents[0].text.includes('settings-fields.no-dsh'), 'the old DSH-only grid class is gone');
  assert.match(contents[0].text, /@media\(max-width:560px\)[\s\S]*?settings-fields/);
  assert.match(contents[0].text, /id="update"/);
  assert.match(contents[0].text, /id="update-refresh"/);
  assert.match(contents[0].text, /author: /);
  assert.match(contents[0].text, /id="activation-message"/);
  assert.match(contents[0].text, /id="sdd"/);
  assert.match(contents[0].text, /SDD 共享工作区/);
  assert.match(contents[0].text, /SDD文档保存在此工作区。项目用于分类，任务各存一份task.md。/);
  assert.match(contents[0].text, /id="sdd-workspace-path"/);
  assert.match(contents[0].text, /请在 Codex 看板中管理共享任务文档/);
  assert.ok(!contents[0].text.includes('id="sdd-project-path"'), 'the project form must not ask for a code directory');
  for (const id of ['agents', 'orders', 'summary', 'service-info']) assert.ok(!contents[0].text.includes(`id="${id}"`));
  assert.ok(!contents[0].text.includes('src="/monitor-client.js"'));
  assert.ok(!contents[0].text.includes('src="/sdd-client.js"'));
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args }));
  const initial = (await call('panel_snapshot')).structuredContent;
  assert.equal(initial.delegation.enabled, false);
  assert.equal(initial.service.name, 'agents-backend');
  assert.ok(initial.service.pid > 0);assert.ok(initial.service.rss_mib > 0);
  if (process.platform === 'darwin') {
    const { stdout } = await run('/bin/ps', ['-p', String(initial.service.pid), '-o', 'ucomm=']);
    assert.equal(stdout.trim(), 'agents-backend');
  }
  const changed = await call('panel_settings', { enabled: true, executor: 'dsh' });
  assert.equal(changed.structuredContent.executor, 'dsh');
  // The app-only settings tool persists the DSH permission and returns it for
  // the board to re-read; invalid values are rejected instead of coerced.
  // A changed explicit value requires the RUNNING consumer to advertise native
  // permission control, so this temporary home needs a fresh heartbeat first.
  const heartbeatBook = new OrderBook(home);await heartbeatBook.open();
  await heartbeatBook.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog: {
    models: [], permission_control: { available: true, presets: ['read-only'] },
  } });
  const permission = await call('panel_settings', { enabled: true, executor: 'dsh', dsh_permission: 'read-only' });
  assert.equal(permission.isError, undefined);
  assert.equal(permission.structuredContent.dsh_permission, 'read-only');
  assert.equal((await call('panel_snapshot', {})).structuredContent.delegation.dsh_permission, 'read-only');
  assert.equal((await call('panel_settings', { enabled: true, executor: 'dsh', dsh_permission: 'full' })).isError, true);
  const second = await connect();
  assert.equal((await second.callTool({ name: 'panel_snapshot', arguments: {} })).structuredContent.delegation.enabled, true);
  assert.equal((await call('panel_settings', { enabled: true, executor: 'bad' })).isError, true);
  await call('panel_settings', { enabled: false, executor: 'hermes' });
  assert.equal((await new OrderBook(home).list()).length, 0);
  const { stdout } = await run(process.execPath, [entry, 'delegation-hook', '--home', home], { input: '' });
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /开关当前为关闭/);
});

test('panel_update is app-only, action-only, lazy, and returns the update contract without touching work orders', async t => {
  const home = await fixture(t);
  const calls = [];
  const contract = { status: 'available', current: '1111111', latest: '2222222', branch: 'main', message: '发现 2 个新提交。', restart_required: true };
  const server = new McpServer({ name: 'panel-update-test', version: '1.0' });
  registerPanel(server, home, { runUpdate: async (root, input) => { calls.push({ root, input });return contract; } });
  const client = new Client({ name: 'panel-update-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close();await server.close(); });
  await server.connect(a);await client.connect(b);
  const tools = (await client.listTools()).tools;
  const update = tools.find(tool => tool.name === 'panel_update');
  assert.ok(update);
  assert.deepEqual(update._meta.ui, { resourceUri: PANEL_URI, visibility: ['app'] });
  assert.deepEqual([...update.inputSchema.properties.action.enum], ['status', 'check', 'apply', 'check_daily', 'set_auto']);
  for (const key of ['path', 'directory', 'url', 'command']) assert.equal(update.inputSchema.properties[key], undefined, key);
  const call = args => client.callTool({ name: 'panel_update', arguments: args });
  for (const action of ['status', 'check', 'apply']) {
    const response = await call({ action });
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.structuredContent, { ...contract, auto_update: false });
  }
  assert.deepEqual(calls, ['status', 'check', 'apply'].map(action => ({ root: home, input: { action } })));
  for (const args of [{ action: 'pull' }, { action: 'set_auto' }, { action: 'status', enabled: true }, { action: 'status', path: '/tmp/repo' }, { action: 'check', url: 'https://example.org' }, { action: 'apply', command: 'git pull' }]) {
    assert.equal((await call(args)).isError, true, JSON.stringify(args));
  }
  assert.equal(calls.length, 3, 'invalid actions and client-supplied locations never reach the updater');
  const beforeDaily = calls.length;
  assert.deepEqual((await call({ action: 'check_daily' })).structuredContent, { ...contract, auto_update: false });
  assert.deepEqual((await call({ action: 'check_daily' })).structuredContent, { ...contract, auto_update: false });
  assert.deepEqual(calls.slice(beforeDaily).map(call => call.input.action), ['status', 'check', 'status'],
    'the app-only daily action shares a persistent throttle instead of forwarding an unknown backend action');
  assert.equal((await call({ action: 'set_auto', enabled: true })).structuredContent.auto_update, true);
  assert.equal((await call({ action: 'status' })).structuredContent.auto_update, true);
  assert.equal((await call({ action: 'set_auto', enabled: false })).structuredContent.auto_update, false);
  // The update backend is imported only when an action runs, and the model
  // catalog never exposes the update tool.
  const source = await readFile(new URL('../src/panel.mjs', import.meta.url), 'utf8');
  assert.match(source, /await import\('\.\/plugin-update\.mjs'\)/);
  assert.ok(!/^import[^\n]*plugin-update/m.test(source), 'the update backend stays lazy');
  // A status call through the real lazy backend stays local and returns the
  // agreed contract shape; tests never run check or apply against the network.
  const real = await createMcp(home, { panelOnly: true });
  const realClient = new Client({ name: 'update-status-test', version: '1.0' });
  const [e, f] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await realClient.close();await real.close(); });
  await real.connect(e);await realClient.connect(f);
  const live = await realClient.callTool({ name: 'panel_update', arguments: { action: 'status' } });
  assert.equal(live.isError, undefined);
  assert.ok(['idle', 'up_to_date', 'available', 'blocked', 'updated', 'failed'].includes(live.structuredContent.status));
  const normal = await createMcp(home);
  const normalClient = new Client({ name: 'model-catalog', version: '1.0' });
  const [c, d] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await normalClient.close();await normal.close(); });
  await normal.connect(c);await normalClient.connect(d);
  const names = (await normalClient.listTools()).tools.map(tool => tool.name);
  assert.ok(!names.includes('panel_update'), 'updates stay app-only');
  assert.equal((await new OrderBook(home).list()).length, 0);
});

test('plugin package points at working runtime and hook quotes task paths safely', async t => {
  const root = await fixture(t);const home = join(root, "a ' $(ignored) dir");
  const plugin = await preparePlugin(home, { root: join(root, 'marketplace') });
  const manifest = JSON.parse(await readFile(join(plugin.plugin, '.codex-plugin/plugin.json')));
  assert.equal(manifest.hooks, './hooks/hooks.json');
  const mcp = JSON.parse(await readFile(join(plugin.plugin, '.mcp.json')));
  const board = mcp.mcpServers.agents_board;
  assert.ok(board.command);
  assert.deepEqual(board.args.slice(1, 3), ['serve', '--home']);
  assert.ok(board.args.includes('--panel-only'));
  assert.equal(board.url, undefined);
  assert.equal(board.http_headers_helper, undefined);
  const hook = JSON.parse(await readFile(join(plugin.plugin, 'hooks/hooks.json'))).hooks.UserPromptSubmit[0].hooks[0];
  const { stdout } = await run('/bin/sh', ['-c', hook.command], { input: '' });
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /当前为关闭/);
  const catalog = JSON.parse(await readFile(join(plugin.root, '.agents/plugins/marketplace.json')));
  assert.equal(catalog.plugins[0].source.path, './plugins/agents-board');
  await assert.rejects(access(join(home, 'delegation.json')), { code: 'ENOENT' });
  await stopBackend(home);
});

test('panel bridge negotiates the official protocol and ignores messages from other frames', async () => {
  const source = await readFile(new URL('../src/panel-bridge.js', import.meta.url), 'utf8');
  const sent = [];let receive;
  const parent = { postMessage(message) { sent.push(message); } };
  const window = { parent, addEventListener(name, callback) { if (name === 'message') receive = callback; } };
  vm.runInNewContext(source, { window, document: { documentElement: { style: {} } }, setTimeout, clearTimeout });
  const init = sent.shift();
  assert.equal(init.method, 'ui/initialize');assert.equal(init.params.appInfo.name, 'codex-to-agents-board');
  receive({ source: parent, data: { jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26' } } });
  const request = window.agentsHost.call('panel_snapshot');
  await new Promise(resolve => setImmediate(resolve));
  const tool = sent.find(message => message.method === 'tools/call');
  let resolved = false;request.then(() => { resolved = true; });
  receive({ source: {}, data: { jsonrpc: '2.0', id: tool.id, result: { structuredContent: { injected: true } } } });
  await new Promise(resolve => setImmediate(resolve));assert.equal(resolved, false);
  receive({ source: parent, data: { jsonrpc: '2.0', id: tool.id, result: { structuredContent: { correct: true } } } });
  assert.deepEqual(await request, { correct: true });
  const waiting = window.agentsHost.call('panel_snapshot');
  await new Promise(resolve => setImmediate(resolve));
  receive({ source: parent, data: { jsonrpc: '2.0', id: 90, method: 'ui/resource-teardown' } });
  await assert.rejects(waiting, /已关闭/);
});

test('panel_sdd is app-only, object-schemed, workspace-fenced, revisioned, lazy, and never leaks document bodies into snapshots', async t => {
  const home = await fixture(t);
  const connect = async () => {
    // In-memory MCP keeps this contract test independent of platform process
    // naming; the stdio panel path is covered by the real-panel test above.
    const server = await createMcp(home, { panelOnly: true });
    const client = new Client({ name: 'panel-sdd-test', version: '1.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close();await server.close(); });
    await server.connect(a);await client.connect(b);
    return client;
  };
  const client = await connect();
  const tools = (await client.listTools()).tools;
  const sdd = tools.find(tool => tool.name === 'panel_sdd');
  assert.ok(sdd);
  assert.deepEqual(sdd._meta.ui.visibility, ['app']);
  assert.equal(sdd.annotations.readOnlyHint, false);
  assert.equal(sdd.inputSchema.type, 'object', 'the SDK must publish an object schema');
  assert.ok(sdd.inputSchema.properties.action, 'the action discriminator is visible to clients');
  assert.ok(sdd.inputSchema.properties.workspace_id, 'the workspace fence is part of the discoverable schema');
  assert.deepEqual([...sdd.inputSchema.properties.action.enum].sort(),
    ['create_task', 'get_workspace', 'list_projects', 'list_tasks', 'read_task', 'register_project', 'save_task', 'set_enabled', 'set_workspace']);
  assert.equal(sdd.inputSchema.properties.enabled.type, 'boolean', 'the board-only switch is part of the app schema');
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });

  await call('panel_snapshot');
  await assert.rejects(access(join(home, 'sdd')), { code: 'ENOENT' }, 'snapshots never touch document storage');
  const initial = (await call('panel_sdd', { action: 'get_workspace' })).structuredContent;
  assert.equal(initial.default, true);
  assert.equal(initial.enabled, true, 'legacy default is ON');
  assert.equal(initial.directory, join(await realpath(home), 'sdd'));
  await assert.rejects(access(join(home, 'sdd')), { code: 'ENOENT' }, 'reading the switch creates no default root');
  const initialId = initial.workspace_id;
  assert.match(initialId, /^[a-f0-9]{16}$/);
  const listed = (await call('panel_sdd', { action: 'list_projects', workspace_id: initialId })).structuredContent;
  assert.deepEqual(listed.projects, []);
  const registered = (await call('panel_sdd', { action: 'register_project', workspace_id: initialId, name: '共享工程' })).structuredContent;
  const projectId = registered.project.id;
  assert.match(projectId, /^[a-f0-9]{16}$/);
  assert.equal((await call('panel_sdd', { action: 'register_project', workspace_id: initialId, name: '共享工程' })).structuredContent.created, false,
    'the same trimmed name reuses the project classification');
  const tasks = (await call('panel_sdd', { action: 'list_tasks', workspace_id: initialId, project_id: projectId })).structuredContent;
  assert.deepEqual(tasks.tasks, []);
  const created = (await call('panel_sdd', { action: 'create_task', workspace_id: initialId, project_id: projectId, title: '共享文档' })).structuredContent;
  assert.match(created.content, /## 目标/);
  assert.match(created.content, /## 验收条件/);
  const read = (await call('panel_sdd', { action: 'read_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id })).structuredContent;
  const marker = '唯一标记-shared-doc-7f3a';
  const saved = (await call('panel_sdd', {
    action: 'save_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id,
    content: `# 更新\n\n${marker}\n`, revision: read.revision,
  })).structuredContent;
  assert.match(saved.content, new RegExp(marker));
  assert.notEqual(saved.revision, read.revision);

  const snapshot = (await call('panel_snapshot')).structuredContent;
  assert.ok(!JSON.stringify(snapshot).includes(marker), 'snapshot must not include document bodies');
  assert.ok(!('sdd' in snapshot));

  // Reconnecting keeps the persisted workspace identifier and its documents.
  const second = await connect();
  const reopened = (await second.callTool({ name: 'panel_sdd', arguments: { action: 'get_workspace' } })).structuredContent;
  assert.equal(reopened.workspace_id, initialId);
  const reread = (await second.callTool({ name: 'panel_sdd', arguments: {
    action: 'read_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id,
  } })).structuredContent;
  assert.match(reread.content, new RegExp(marker));

  const stale = await call('panel_sdd', {
    action: 'save_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id,
    content: '# 覆盖\n', revision: read.revision,
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /重新读取|冲突/);

  // Switching the shared workspace moves the document set; a board still
  // holding the previous identifier is rejected instead of writing there.
  const nextRoot = join(home, 'workspace-docs');
  const switched = (await call('panel_sdd', { action: 'set_workspace', directory: nextRoot })).structuredContent;
  assert.equal(switched.directory, await realpath(nextRoot));
  assert.equal(switched.changed, true);
  assert.notEqual(switched.workspace_id, initialId);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'sdd-workspace.json'), 'utf8')),
    { directory: await realpath(nextRoot), enabled: true });
  assert.deepEqual((await call('panel_sdd', { action: 'list_projects', workspace_id: switched.workspace_id })).structuredContent.projects, []);
  const fenced = await call('panel_sdd', {
    action: 'save_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id,
    content: '# 旧看板草稿\n', revision: saved.revision,
  });
  assert.equal(fenced.isError, true);
  assert.match(fenced.content[0].text, /工作区已切换|重新读取工作区/);
  // Switching back restores the old identifier and its untouched documents.
  const restored = (await call('panel_sdd', { action: 'set_workspace', directory: join(home, 'sdd') })).structuredContent;
  assert.equal(restored.workspace_id, initialId);
  assert.match((await call('panel_sdd', {
    action: 'read_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id,
  })).structuredContent.content, new RegExp(marker));

  for (const args of [
    { action: 'read_task', workspace_id: initialId, project_id: projectId },
    { action: 'list_tasks', workspace_id: initialId, project_id: '../escape' },
    { action: 'register_project', workspace_id: initialId, name: '工程', directory: '/code/path' },
    { action: 'register_project', workspace_id: initialId, name: '' },
    { action: 'set_workspace', workspace_id: initialId, directory: join(home, 'elsewhere') },
    { action: 'set_workspace', directory: 'relative/path' },
    { action: 'save_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id, content: 'x', revision: 'bad' },
    { action: 'delete_everything' },
  ]) assert.equal((await call('panel_sdd', args)).isError, true, JSON.stringify(args));

  const normal = await createMcp(home);
  const normalClient = new Client({ name: 'normal-tools', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await normalClient.close();await normal.close(); });
  await normal.connect(a);await normalClient.connect(b);
  const names = (await normalClient.listTools()).tools.map(tool => tool.name);
  assert.deepEqual(names.sort(), ['conversation_control', 'runtime_info', 'sdd_task', 'work_inspect', 'work_submit', 'work_update', 'workspace_control'],
    'the model sees exactly the dispatch/inspection tools plus sdd_task');
  assert.ok(!names.includes('panel_sdd'), 'documents are app-only, not a model-visible tool');
  assert.ok(!names.includes('open_panel'));

  const source = await readFile(new URL('../src/panel.mjs', import.meta.url), 'utf8');
  assert.match(source, /await import\('\.\/sdd-workspace\.mjs'\)/);
  assert.ok(!/^import[^\n]*sdd-workspace/m.test(source), 'storage stays lazy');
  const toolsSource = await readFile(new URL('../src/sdd-tools.mjs', import.meta.url), 'utf8');
  assert.match(toolsSource, /await import\('\.\/sdd-workspace\.mjs'\)/);
  assert.ok(!/^import[^\n]*sdd-workspace/m.test(toolsSource), 'the model tool keeps storage lazy too');
  assert.ok(!/sdd-workspace/.test(await readFile(new URL('../src/mcp.mjs', import.meta.url), 'utf8')),
    'mcp.mjs only loads the lightweight schema module');
  assert.equal((await new OrderBook(home).list()).length, 0, 'document actions never create work orders');
});

test('model sdd_task and panel_sdd share documents; panel edits fence stale model revisions and old workspace ids', async t => {
  const home = await fixture(t);
  const connect = async options => {
    const server = await createMcp(home, options);
    const client = new Client({ name: 'shared-document-test', version: '1.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close();await server.close(); });
    await server.connect(a);await client.connect(b);
    return client;
  };
  const model = await connect();
  const panel = await connect({ panelOnly: true });
  const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
  const modelCall = args => call(model, 'sdd_task', args);
  const panelCall = args => call(panel, 'panel_sdd', args);

  const modelWorkspace = (await modelCall({ action: 'get_workspace' })).structuredContent;
  const panelWorkspace = (await panelCall({ action: 'get_workspace' })).structuredContent;
  assert.equal(panelWorkspace.workspace_id, modelWorkspace.workspace_id, 'both surfaces use the one board-selected document root');
  const workspaceId = modelWorkspace.workspace_id;

  const registered = (await modelCall({ action: 'register_project', workspace_id: workspaceId, name: '共享规划工程' })).structuredContent;
  const projectId = registered.project.id;
  const taskDirectories = async () => (await readdir(registered.project.path))
    .filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name));
  const plan = '# 共享规划\n\n## 目标\n\n模型保存的实际规划。\n\n## 范围\n\n仅文档。\n\n## 计划\n\n1. 写入\n\n## 验收条件\n\n- [ ] 看板可读\n';
  const created = (await modelCall({ action: 'create_task', workspace_id: workspaceId, project_id: projectId, content: plan })).structuredContent;
  assert.equal(await readFile(created.path, 'utf8'), plan);
  assert.doesNotMatch(plan, /待填写/);

  const panelProjects = (await panelCall({ action: 'list_projects', workspace_id: workspaceId })).structuredContent.projects;
  assert.ok(panelProjects.some(project => project.id === projectId && project.name === '共享规划工程'));
  const panelTasks = (await panelCall({ action: 'list_tasks', workspace_id: workspaceId, project_id: projectId })).structuredContent.tasks;
  assert.equal(panelTasks.length, 1);
  assert.equal(panelTasks[0].id, created.task.id);
  assert.equal(panelTasks[0].title, '共享规划');
  const panelRead = (await panelCall({ action: 'read_task', workspace_id: workspaceId, project_id: projectId, task_id: created.task.id })).structuredContent;
  assert.equal(panelRead.content, plan);
  assert.equal(panelRead.path, created.path);
  assert.equal(panelRead.revision, created.revision);

  // The board edits the same task; the model must re-read before saving.
  const marker = '看板修改-marker-42';
  const panelSaved = (await panelCall({
    action: 'save_task', workspace_id: workspaceId, project_id: projectId, task_id: created.task.id,
    content: `# 看板更新\n\n${marker}\n`, revision: panelRead.revision,
  })).structuredContent;
  assert.match(panelSaved.content, new RegExp(marker));
  const modelReread = (await modelCall({ action: 'read_task', workspace_id: workspaceId, project_id: projectId, task_id: created.task.id })).structuredContent;
  assert.equal(modelReread.revision, panelSaved.revision);
  assert.match(modelReread.content, new RegExp(marker));

  const stale = await modelCall({
    action: 'save_task', workspace_id: workspaceId, project_id: projectId, task_id: created.task.id,
    content: '# 模型旧稿\n', revision: created.revision,
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /重新读取|冲突/);
  assert.equal(await readFile(created.path, 'utf8'), panelSaved.content, 'a stale model save must not overwrite the panel edit');

  // After re-reading, the model updates the same task ID and the board reads it.
  const modelUpdated = (await modelCall({
    action: 'save_task', workspace_id: workspaceId, project_id: projectId, task_id: created.task.id,
    content: `# 模型更新\n\n${marker}-model\n`, revision: modelReread.revision,
  })).structuredContent;
  assert.equal(await readFile(created.path, 'utf8'), modelUpdated.content);
  const panelReread = (await panelCall({ action: 'read_task', workspace_id: workspaceId, project_id: projectId, task_id: created.task.id })).structuredContent;
  assert.equal(panelReread.revision, modelUpdated.revision);
  assert.match(panelReread.content, new RegExp(`${marker}-model`));

  // The board's legacy template create_task still works untouched.
  const template = (await panelCall({ action: 'create_task', workspace_id: workspaceId, project_id: projectId, title: '看板模板任务' })).structuredContent;
  assert.match(template.content, /^# 看板模板任务/);
  assert.match(template.content, /待填写/);
  assert.equal(await readFile(template.path, 'utf8'), template.content);

  // The model's create_task cannot fall back to a placeholder.
  const beforeRejected = (await taskDirectories()).length;
  const titleOnly = await modelCall({ action: 'create_task', workspace_id: workspaceId, project_id: projectId, title: '模型模板' });
  assert.equal(titleOnly.isError, true);
  assert.match(titleOnly.content[0].text, /完整非空|content/);
  assert.equal((await taskDirectories()).length, beforeRejected, 'a rejected model create leaves no task folder');

  // A board workspace switch fences the model's old identifier; the old file is untouched.
  const nextRoot = join(home, 'switched-docs');
  const switched = (await panelCall({ action: 'set_workspace', directory: nextRoot })).structuredContent;
  assert.notEqual(switched.workspace_id, workspaceId);
  const fenced = await modelCall({
    action: 'save_task', workspace_id: workspaceId, project_id: projectId, task_id: created.task.id,
    content: '# 旧工作区覆盖\n', revision: modelUpdated.revision,
  });
  assert.equal(fenced.isError, true);
  assert.match(fenced.content[0].text, /工作区已切换|重新读取工作区/);
  assert.equal(await readFile(created.path, 'utf8'), modelUpdated.content);
  const fencedList = await modelCall({ action: 'list_tasks', workspace_id: workspaceId, project_id: projectId });
  assert.equal(fencedList.isError, true);
  const modelSwitch = await modelCall({ action: 'set_workspace', directory: nextRoot });
  assert.equal(modelSwitch.isError, true, 'the model can never switch the document root');
  assert.deepEqual((await panelCall({ action: 'list_projects', workspace_id: switched.workspace_id })).structuredContent.projects, []);

  const book = new OrderBook(home);await book.open();
  assert.deepEqual(await book.list(), [], 'saving planning documents never creates work orders');
});

test('panel_sdd owns the SDD switch; the model tool cannot change it or write while OFF', async t => {
  const home = await fixture(t);
  const connect = async options => {
    const server = await createMcp(home, options);
    const client = new Client({ name: 'sdd-switch-test', version: '1.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close();await server.close(); });
    await server.connect(a);await client.connect(b);
    return client;
  };
  const model = await connect();
  const panel = await connect({ panelOnly: true });
  const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
  const modelCall = args => call(model, 'sdd_task', args);
  const panelCall = args => call(panel, 'panel_sdd', args);

  // Defaults: ON, but reading the state creates no document root.
  const workspace = (await panelCall({ action: 'get_workspace' })).structuredContent;
  assert.equal(workspace.enabled, true, 'legacy default stays ON');
  await assert.rejects(access(join(home, 'sdd')), { code: 'ENOENT' });

  // The board is the only switch writer; the saved state is reported to both
  // surfaces and survives without a document directory.
  const off = (await panelCall({ action: 'set_enabled', enabled: false })).structuredContent;
  assert.equal(off.enabled, false);
  assert.equal(off.directory, workspace.directory);
  assert.equal((await modelCall({ action: 'get_workspace' })).structuredContent.enabled, false);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'sdd-workspace.json'), 'utf8')), { enabled: false });
  await assert.rejects(access(join(home, 'sdd')), { code: 'ENOENT' }, 'saving the switch writes no document root');

  // Every model write is refused while OFF, and the model schema exposes neither
  // the switch nor the root.
  for (const args of [
    { action: 'register_project', workspace_id: workspace.workspace_id, name: '关闭后' },
    { action: 'create_task', workspace_id: workspace.workspace_id, project_id: 'a'.repeat(16), content: '# 关闭后\n' },
  ]) {
    const rejected = await modelCall(args);
    assert.equal(rejected.isError, true, JSON.stringify(args));
    assert.match(rejected.content[0].text, /SDD 任务文档已关闭|已关闭/);
  }
  assert.equal((await modelCall({ action: 'set_enabled', enabled: true })).isError, true);
  assert.equal((await modelCall({ action: 'set_workspace', directory: join(home, 'x') })).isError, true);
  assert.equal((await modelCall({ action: 'get_workspace', enabled: true })).isError, true);
  assert.deepEqual((await modelCall({ action: 'list_projects', workspace_id: workspace.workspace_id })).structuredContent.projects, [],
    'reads stay available so existing files can be inspected');

  // Switching the root while OFF preserves the switch; only an explicit ON
  // restores writes.
  const root = join(home, 'board-root');
  const switched = (await panelCall({ action: 'set_workspace', directory: root })).structuredContent;
  assert.equal(switched.enabled, false, 'set_workspace must not turn SDD on');
  const on = (await panelCall({ action: 'set_enabled', enabled: true })).structuredContent;
  assert.equal(on.enabled, true);
  assert.equal(on.directory, switched.directory);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'sdd-workspace.json'), 'utf8')),
    { directory: switched.directory, enabled: true });
  const project = (await modelCall({ action: 'register_project', workspace_id: on.workspace_id, name: '重新开启' })).structuredContent.project;
  const plan = '# 重新开启\n\n## 目标\n\n恢复写入。\n';
  const created = (await modelCall({
    action: 'create_task', workspace_id: on.workspace_id, project_id: project.id, content: plan,
  })).structuredContent;
  assert.equal(await readFile(created.path, 'utf8'), plan);

  // A stale writer that still believes SDD is ON is rejected by storage, and
  // the existing file stays byte-for-byte unchanged.
  const secondPanel = await connect({ panelOnly: true });
  assert.equal((await modelCall({ action: 'get_workspace' })).structuredContent.enabled, true);
  await call(secondPanel, 'panel_sdd', { action: 'set_enabled', enabled: false });
  const blocked = await modelCall({
    action: 'save_task', workspace_id: on.workspace_id, project_id: project.id, task_id: created.task.id,
    content: '# 旧看板覆盖\n', revision: created.revision,
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /已关闭/);
  assert.equal(await readFile(created.path, 'utf8'), plan);
  const panelBlocked = await call(secondPanel, 'panel_sdd', {
    action: 'save_task', workspace_id: on.workspace_id, project_id: project.id, task_id: created.task.id,
    content: '# 旧看板覆盖\n', revision: created.revision,
  });
  assert.equal(panelBlocked.isError, true, 'a stale board is also refused, not just the model');
  assert.match(panelBlocked.content[0].text, /已关闭/);

  // A damaged settings file is reported and cannot silently enable writes.
  await writeFile(join(home, 'sdd-workspace.json'), '{corrupt');
  const corrupt = await modelCall({ action: 'register_project', workspace_id: on.workspace_id, name: '损坏工程' });
  assert.equal(corrupt.isError, true);
  assert.match(corrupt.content[0].text, /配置损坏/);
  const corruptPanel = await call(secondPanel, 'panel_sdd', { action: 'get_workspace' });
  assert.equal(corruptPanel.isError, true);
  assert.match(corruptPanel.content[0].text, /配置损坏/);

  const book = new OrderBook(home);await book.open();
  assert.deepEqual(await book.list(), [], 'switching SDD never creates work orders');
});

// Old board pages send document actions with a code directory and no
// workspace_id. The server must answer with one readable Chinese hint instead
// of raw Zod issues, and must not touch storage or create work orders.
const LEGACY_MESSAGE = '看板页面版本过旧，缺少工作区标识，无法执行文档操作。请关闭看板页面并重新打开以载入新版本。';
async function openPanelClient(t, home) {
  const server = await createMcp(home, { panelOnly: true });
  const client = new Client({ name: 'panel-inmemory-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close();await server.close(); });
  await server.connect(a);await client.connect(b);
  return client;
}

test('legacy board document actions without workspace_id are rejected with Chinese version guidance and write nothing', async t => {
  const home = await fixture(t);
  const client = await openPanelClient(t, home);
  const call = (args = {}) => client.callTool({ name: 'panel_sdd', arguments: args });
  const legacy = await call({ action: 'register_project', name: '旧看板项目', directory: '/code/path' });
  assert.equal(legacy.isError, true);
  assert.equal(legacy.content[0].text, LEGACY_MESSAGE);
  assert.match(legacy.content[0].text, /版本过旧/);
  assert.match(legacy.content[0].text, /关闭/);
  assert.match(legacy.content[0].text, /重新打开/);
  assert.ok(!/invalid_type|unrecognized_keys|expected/i.test(legacy.content[0].text), 'no raw schema details');
  for (const args of [
    { action: 'list_projects' },
    { action: 'list_tasks', project_id: '0'.repeat(16) },
    { action: 'create_task', project_id: '0'.repeat(16), title: '旧任务' },
    { action: 'read_task', project_id: '0'.repeat(16), task_id: '00000000-0000-4000-8000-000000000000' },
    {
      action: 'save_task', project_id: '0'.repeat(16), task_id: '00000000-0000-4000-8000-000000000000',
      content: '# 旧草稿\n', revision: 'a'.repeat(64),
    },
  ]) {
    const rejected = await call(args);
    assert.equal(rejected.isError, true, JSON.stringify(args));
    assert.equal(rejected.content[0].text, LEGACY_MESSAGE, JSON.stringify(args));
  }
  await assert.rejects(access(join(home, 'sdd')), { code: 'ENOENT' }, 'a rejected legacy request must not create the document workspace');
  assert.equal((await new OrderBook(home).list()).length, 0, 'document actions never create work orders');
});

test('legacy board read/save cannot touch an existing task.md created through the new panel_sdd contract', async t => {
  const home = await fixture(t);
  const client = await openPanelClient(t, home);
  const call = (args = {}) => client.callTool({ name: 'panel_sdd', arguments: args });
  const workspace = (await call({ action: 'get_workspace' })).structuredContent;
  const project = (await call({ action: 'register_project', workspace_id: workspace.workspace_id, name: '合作工程' })).structuredContent.project;
  const created = (await call({ action: 'create_task', workspace_id: workspace.workspace_id, project_id: project.id, title: '共享任务' })).structuredContent;
  const read = (await call({
    action: 'read_task', workspace_id: workspace.workspace_id, project_id: project.id, task_id: created.task.id,
  })).structuredContent;
  const bytesBefore = await readFile(read.path);
  const legacyRead = await call({ action: 'read_task', project_id: project.id, task_id: created.task.id });
  assert.equal(legacyRead.isError, true);
  assert.equal(legacyRead.content[0].text, LEGACY_MESSAGE);
  const legacySave = await call({
    action: 'save_task', project_id: project.id, task_id: created.task.id,
    content: '# 旧看板覆盖\n', revision: read.revision,
  });
  assert.equal(legacySave.isError, true);
  assert.equal(legacySave.content[0].text, LEGACY_MESSAGE);
  assert.deepEqual(await readFile(read.path), bytesBefore, 'a rejected legacy save must not rewrite task.md');
  const reread = (await call({
    action: 'read_task', workspace_id: workspace.workspace_id, project_id: project.id, task_id: created.task.id,
  })).structuredContent;
  assert.equal(reread.content, read.content);
  assert.equal(reread.revision, read.revision);
  assert.equal((await new OrderBook(home).list()).length, 0);
});

test('panel_sdd new workspace contract still works end to end', async t => {
  const home = await fixture(t);
  const client = await openPanelClient(t, home);
  const call = (args = {}) => client.callTool({ name: 'panel_sdd', arguments: args });
  const workspace = (await call({ action: 'get_workspace' })).structuredContent;
  assert.match(workspace.workspace_id, /^[a-f0-9]{16}$/);
  assert.deepEqual((await call({ action: 'list_projects', workspace_id: workspace.workspace_id })).structuredContent.projects, []);
  const registered = (await call({ action: 'register_project', workspace_id: workspace.workspace_id, name: '新契约工程' })).structuredContent;
  assert.equal(registered.created, true);
  assert.deepEqual((await call({ action: 'list_tasks', workspace_id: workspace.workspace_id, project_id: registered.project.id })).structuredContent.tasks, []);
  const created = (await call({ action: 'create_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, title: '新契约任务' })).structuredContent;
  assert.match(created.content, /## 目标/);
  const read = (await call({
    action: 'read_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, task_id: created.task.id,
  })).structuredContent;
  assert.equal(read.content, created.content);
  const saved = (await call({
    action: 'save_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, task_id: created.task.id,
    content: '# 新契约任务\n\n已更新。\n', revision: read.revision,
  })).structuredContent;
  assert.match(saved.content, /已更新/);
  assert.notEqual(saved.revision, read.revision);
  assert.equal((await new OrderBook(home).list()).length, 0);
});

test('board/v3 is the only panel resource and every board metadata reference points at it', async t => {
  const home = await fixture(t);
  const client = await openPanelClient(t, home);
  const legacyUri = ['ui://codex-to-agents/board', 'v1'].join('/');
  const resources = (await client.listResources()).resources;
  assert.equal(resources.length, 1, 'exactly one canonical board resource');
  assert.equal(resources[0].uri, PANEL_URI);
  assert.ok(PANEL_URI.endsWith('/v3'));
  assert.ok(!resources.some(resource => resource.uri === legacyUri), 'no v1 compatibility alias is listed');
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(tool => tool.name === 'open_panel')._meta.ui.resourceUri, PANEL_URI);
  for (const name of ['panel_snapshot', 'panel_settings', 'panel_sdd', 'panel_update', 'panel_usage']) {
    assert.equal(tools.find(tool => tool.name === name)._meta.ui.resourceUri, PANEL_URI, name);
  }
  const { contents } = await client.readResource({ uri: PANEL_URI });
  assert.equal(contents.length, 1);
  assert.equal(contents[0].uri, PANEL_URI);
  const html = contents[0].text;
  assert.match(html, /id="sdd"/);
  assert.match(html, /id="update"/);
  assert.match(html, /id="update-check"/);
  assert.match(html, /id="update-refresh"/);
  assert.match(html, /id="update-apply"/);
  assert.match(html, /SDD 共享工作区/);
  assert.match(html, /id="sdd-workspace-path"/);
  assert.ok(!html.includes('id="sdd-project-path"'), 'the board form must not ask for a code directory');
  assert.ok(!html.includes(legacyUri), 'the served board page must not mention the old resource URI');
  const source = await readFile(new URL('../src/panel.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes(legacyUri), 'no old board URI literal remains in src/panel.mjs');
  assert.match(source, /board\/v3/);
});

test('read-only HTTP monitor serves the shared-doc shell but still rejects writes', async t => {
  const home = await fixture(t);
  const dashboard = await monitorWeb(home, { port: 0 });
  t.after(() => dashboard.close());
  const page = await fetch(dashboard.url + '/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="sdd"/);
  assert.match(html, /id="update"/);
  assert.match(html, /id="update-refresh"/);
  assert.match(html, /id="delegation-effort"/);
  assert.match(html, /id="delegation-permission"/);
  assert.match(html, /跟随执行端默认/);
  assert.match(html, /author: /);
  assert.match(html, /SDD 共享工作区/);
  assert.match(html, /SDD文档保存在此工作区。项目用于分类，任务各存一份task.md。/);
  assert.match(html, /id="sdd-workspace-path"/);
  assert.ok(!html.includes('sdd-project-path'), 'the read-only shell asks for no code directory either');
  assert.match(html, /src="\/sdd-client\.js"/);
  const script = await fetch(dashboard.url + '/sdd-client.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /text\/javascript/);
  const source = await script.text();
  assert.match(source, /panel_sdd/);
  assert.match(source, /请在 Codex 看板中管理共享任务文档/);
  const monitorScript = await fetch(dashboard.url + '/monitor-client.js');
  assert.equal(monitorScript.status, 200);
  const monitorSource = await monitorScript.text();
  assert.match(monitorSource, /panel_update/);
  assert.match(monitorSource, /请在 Codex 的 Agents 看板中检查更新/);
  const write = await fetch(dashboard.url + '/api/snapshot', { method: 'POST' });
  assert.equal(write.status, 405);
  assert.equal(await write.text(), 'Read-only monitor.');
});

test('the board shell exposes one shared new-session permission field for every executor', async () => {
  // Read the source directly: this stays verifiable even where spawning the
  // native MCP backend is blocked by the host environment.
  const html = await readFile(new URL('../src/monitor.html', import.meta.url), 'utf8');
  const client = await readFile(new URL('../src/monitor-client.js', import.meta.url), 'utf8');
  assert.match(html, /id="delegation-permission"/);
  // The list is rendered from the running executor's heartbeat, so the static
  // shell only carries a neutral default and claims no native option.
  assert.match(html, /<option value="">跟随执行端默认<\/option>/);
  assert.doesNotMatch(html, /<option value="read-only">/);
  assert.doesNotMatch(html, /\.settings-fields\.no-dsh/);
  assert.match(html, /\.settings-fields\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(html, /@media\(max-width:820px\)\{[\s\S]*?\.settings-fields\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(html, /@media\(max-width:560px\)\{[\s\S]*?\.settings-fields,/);
  // Each executor keeps its own stored field; the board saves only the current
  // executor's field and renders capability-driven options.
  assert.match(client, /dsh_permission/);
  assert.match(client, /hermes_permission/);
  assert.match(client, /qoder_permission/);
  assert.match(client, /permission_control/);
  assert.match(client, /仅新会话生效/);
});
