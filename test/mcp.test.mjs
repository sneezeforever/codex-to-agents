import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { join } from 'node:path';
import { OrderBook } from '../src/orders.mjs';
import { createMcp } from '../src/mcp.mjs';
import { stopBackend } from '../src/backend-control.mjs';

const NORMAL_TOOLS = ['conversation_control', 'runtime_info', 'sdd_task', 'work_inspect', 'work_submit', 'work_update', 'work_wait', 'workspace_control'];
const PLAN = '# 模型完整规划\n\n## 目标\n\n把规划保存到共享文档。\n\n## 范围\n\n只写 SDD 文档，不改代码。\n\n## 计划\n\n1. 读取工作区\n2. 创建任务文档\n\n## 验收条件\n\n- [ ] task.md 与规划一致\n';

test('real MCP stdio exposes exactly eight tools, saves a complete model plan, and supports offline orders', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-');
  // The shared backend must not send production usage statistics from tests.
  await writeFile(join(home, 'usage-settings.json'), '{"enabled":false}\n');
  const client = new Client({ name: 'codex-to-agents-test', version: '1.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/command.mjs', import.meta.url)), 'serve', '--home', home], stderr: 'pipe' }));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 8);
    assert.deepEqual(tools.map(tool => tool.name).sort(), NORMAL_TOOLS, 'the model catalog is exactly the seven dispatch/inspection tools plus sdd_task');
    assert.equal((await client.callTool({ name: 'runtime_info', arguments: {} })).structuredContent.online, false);
    const workspace = (await client.callTool({ name: 'sdd_task', arguments: { action: 'get_workspace' } })).structuredContent;
    const project = (await client.callTool({ name: 'sdd_task', arguments: {
      action: 'register_project', workspace_id: workspace.workspace_id, name: 'stdio 模型工程',
    } })).structuredContent.project;
    const created = (await client.callTool({ name: 'sdd_task', arguments: {
      action: 'create_task', workspace_id: workspace.workspace_id, project_id: project.id, content: PLAN,
    } })).structuredContent;
    assert.equal(created.content, PLAN);
    assert.equal(await readFile(created.path, 'utf8'), PLAN);
    const task = await client.callTool({ name: 'work_submit', arguments: { goal: 'offline hello' } });
    assert.equal(task.structuredContent.status, 'queued');
    const id = task.structuredContent.order_id;
    const book = new OrderBook(home);await book.transition(id, 'completed', { output: { text: 'verified result' } });
    const summary = (await client.callTool({ name: 'work_inspect', arguments: { order_id: id } })).structuredContent;
    assert.equal(summary.status, 'completed');
    assert.equal(summary.output, undefined, 'the default view never returns the full output body');
    assert.equal(summary.result, 'verified result');
    assert.match(summary.detail_hint, /view:"detail"/);
    const result = await client.callTool({ name: 'work_inspect', arguments: { order_id: id, view: 'detail' } });
    assert.equal(result.structuredContent.output.text, 'verified result');
  } finally { await client.close();await stopBackend(home);await rm(home, { recursive: true, force: true }); }
});

test('real MCP stdio documents order_id generation and rejects malformed IDs before any work is saved', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-id-');
  await writeFile(join(home, 'usage-settings.json'), '{"enabled":false}\n');
  const client = new Client({ name: 'codex-to-agents-id-test', version: '1.0' });
  const call = async (name, args) => {
    try { return await client.callTool({ name, arguments: args }); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/command.mjs', import.meta.url)), 'serve', '--home', home], stderr: 'pipe' }));

    const tools = (await client.listTools()).tools;
    const submit = tools.find(tool => tool.name === 'work_submit');
    const inspect = tools.find(tool => tool.name === 'work_inspect');
    assert.ok(!submit.inputSchema.required.includes('order_id'));
    assert.match(submit.inputSchema.properties.order_id.description, /Omit it and the server generates one/);
    assert.match(submit.inputSchema.properties.order_id.description, /real UUID with a UUID generator \(for example crypto\.randomUUID\(\)\) before the first call/);
    assert.match(submit.inputSchema.properties.order_id.description, /reuse that same UUID with identical arguments/);
    assert.match(submit.inputSchema.properties.order_id.description, /Never use a task title, cw- conversation ID, or example placeholder/);
    assert.match(submit.description, /Omit order_id and the server generates a UUID/);
    assert.match(inspect.inputSchema.properties.order_id.description, /Omit it to list recent work orders/);

    const automatic = (await call('work_submit', { goal: 'generated id' })).structuredContent;
    assert.equal(automatic.reused, false);
    assert.match(automatic.order_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const id = randomUUID();
    const first = (await call('work_submit', { order_id: id, goal: 'retry me' })).structuredContent;
    const retry = (await call('work_submit', { order_id: id, goal: 'retry me' })).structuredContent;
    assert.equal(first.order_id, id);assert.equal(first.reused, false);assert.equal(retry.reused, true);
    const conflict = await call('work_submit', { order_id: id, goal: 'different work' });
    assert.equal(conflict.isError, true);assert.match(conflict.content[0].text, /already bound to different work/);

    for (const invalid of ['my-task', `cw-${id}`, 'not-a-uuid']) {
      const rejected = await call('work_submit', { order_id: invalid, goal: 'must not save' });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /order_id/);
      assert.match(rejected.content[0].text, /must be a real UUID/);
      assert.match(rejected.content[0].text, /Omit order_id/);
      assert.match(rejected.content[0].text, /generate a real UUID/);
    }
    const files = await readdir(join(home, 'requests'));
    assert.equal(files.length, 2);
    assert.deepEqual(files.map(name => name.slice(0, -5)).sort(), [automatic.order_id, id].sort());
    assert.equal((await call('work_inspect', { order_id: 'my-task' })).isError, true);
  } finally { await client.close();await stopBackend(home);await rm(home, { recursive: true, force: true }); }
});

test('model sdd_task is object-schemed, cannot choose the workspace root, writes complete plans only, and submits no work', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-sdd-');
  const server = await createMcp(home);
  const client = new Client({ name: 'model-sdd-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);await client.connect(b);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), NORMAL_TOOLS);
    const sdd = tools.find(tool => tool.name === 'sdd_task');
    assert.ok(sdd);
    assert.equal(sdd.inputSchema.type, 'object', 'the SDK must publish an object root');
    assert.equal(sdd.inputSchema.additionalProperties, false);
    assert.deepEqual([...sdd.inputSchema.properties.action.enum].sort(),
      ['create_task', 'get_workspace', 'list_projects', 'list_tasks', 'read_task', 'register_project', 'save_task']);
    assert.equal(sdd.inputSchema.properties.directory, undefined, 'the model cannot select or change the document root');
    assert.equal(sdd.inputSchema.properties.root, undefined);
    assert.equal(sdd._meta?.ui, undefined, 'the model tool is not an app-only board tool');
    assert.equal(sdd.annotations.readOnlyHint, false);
    assert.match(sdd.description, /cannot choose or change the document root/);

    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const workspace = (await call('sdd_task', { action: 'get_workspace' })).structuredContent;
    assert.match(workspace.workspace_id, /^[a-f0-9]{16}$/);
    const registered = (await call('sdd_task', { action: 'register_project', workspace_id: workspace.workspace_id, name: '模型工程' })).structuredContent;
    const projectDirectory = registered.project.path;
    const taskDirectories = async () => (await readdir(projectDirectory)).filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name));
    const before = (await taskDirectories()).length;

    const created = (await call('sdd_task', { action: 'create_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, content: PLAN })).structuredContent;
    assert.equal(created.content, PLAN);
    assert.equal(created.task.title, '模型完整规划');
    assert.equal(created.path, created.task.path);
    assert.ok(created.path.startsWith('/'), 'the response carries an absolute document path for the work order');
    assert.equal(await readFile(created.path, 'utf8'), PLAN);
    assert.doesNotMatch(created.content, /待填写/);
    assert.deepEqual(await readdir(join(projectDirectory, created.task.id)), ['task.md']);
    assert.equal((await taskDirectories()).length, before + 1);

    const read = (await call('sdd_task', { action: 'read_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, task_id: created.task.id })).structuredContent;
    assert.equal(read.content, PLAN);
    assert.equal(read.revision, created.revision);
    const listed = (await call('sdd_task', { action: 'list_tasks', workspace_id: workspace.workspace_id, project_id: registered.project.id })).structuredContent;
    assert.equal(listed.tasks.length, before + 1);
    assert.ok(listed.tasks.some(task => task.id === created.task.id && task.path === created.path));

    const rejectedCreates = [
      { action: 'create_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, title: '只有模板标题' },
      { action: 'create_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, content: '  \n\t ' },
      { action: 'create_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, content: 'x'.repeat(256 * 1024 + 1) },
      { action: 'create_task', workspace_id: workspace.workspace_id, project_id: 'f'.repeat(16), content: PLAN },
    ];
    for (const args of rejectedCreates) {
      const rejected = await call('sdd_task', args);
      assert.equal(rejected.isError, true, JSON.stringify(args).slice(0, 120));
    }
    assert.equal((await taskDirectories()).length, before + 1, 'rejected create_task calls leave no task folder');

    for (const args of [
      { action: 'set_workspace', directory: join(home, 'elsewhere') },
      { action: 'list_projects', workspace_id: workspace.workspace_id, directory: join(home, 'elsewhere') },
      { action: 'register_project', workspace_id: workspace.workspace_id, name: '工程', root: join(home, 'elsewhere') },
      { action: 'save_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, task_id: created.task.id, content: '# x\n', revision: created.revision, directory: join(home, 'elsewhere') },
    ]) assert.equal((await call('sdd_task', args)).isError, true, JSON.stringify(args));

    const fenced = await call('sdd_task', { action: 'list_projects', workspace_id: '0'.repeat(16) });
    assert.equal(fenced.isError, true);
    assert.match(fenced.content[0].text, /工作区|重新读取/);

    const book = new OrderBook(home);await book.open();
    assert.deepEqual(await book.list(), [], 'document actions never create work orders');
  } finally {
    await client.close();await server.close();await rm(home, { recursive: true, force: true });
  }
});

test('cross-surface MCP: model save, panel read/edit, stale model revision rejection, and a real workspace switch fence', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-cross-');
  const connections = [];
  const connect = async options => {
    const server = await createMcp(home, options);
    const client = new Client({ name: 'cross-surface-test', version: '1.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);await client.connect(b);
    connections.push({ client, server });
    return client;
  };
  try {
    const model = await connect();
    const panel = await connect({ panelOnly: true });
    const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
    const modelCall = args => call(model, 'sdd_task', args);
    const panelCall = args => call(panel, 'panel_sdd', args);

    const workspace = (await modelCall({ action: 'get_workspace' })).structuredContent;
    const workspaceId = workspace.workspace_id;
    const project = (await modelCall({
      action: 'register_project', workspace_id: workspaceId, name: '交叉 MCP 工程',
    })).structuredContent.project;
    const plan = '# 交叉规划\n\n## 目标\n\n模型保存、看板读取。\n\n## 范围\n\n仅文档。\n\n## 计划\n\n1. 保存\n\n## 验收条件\n\n- [ ] 看板读取同一文件\n';
    const created = (await modelCall({
      action: 'create_task', workspace_id: workspaceId, project_id: project.id, content: plan,
    })).structuredContent;
    assert.equal(await readFile(created.path, 'utf8'), plan);

    // The board reads the exact task the model saved from the same workspace.
    const panelWorkspace = (await panelCall({ action: 'get_workspace' })).structuredContent;
    assert.equal(panelWorkspace.workspace_id, workspaceId);
    const panelTasks = (await panelCall({ action: 'list_tasks', workspace_id: workspaceId, project_id: project.id })).structuredContent.tasks;
    assert.equal(panelTasks.length, 1);
    assert.equal(panelTasks[0].id, created.task.id);
    const panelRead = (await panelCall({
      action: 'read_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
    })).structuredContent;
    assert.equal(panelRead.path, created.path);
    assert.equal(panelRead.content, plan);

    // The board edits the same file; the model's old revision must be rejected.
    const marker = 'cross-board-edit-9c2';
    const panelSaved = (await panelCall({
      action: 'save_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
      content: `# 看板交叉修改\n\n${marker}\n`, revision: panelRead.revision,
    })).structuredContent;
    assert.match(panelSaved.content, new RegExp(marker));
    const stale = await modelCall({
      action: 'save_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
      content: '# 模型旧版本\n', revision: created.revision,
    });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /重新读取|冲突/);
    assert.equal(await readFile(created.path, 'utf8'), panelSaved.content, 'a stale model save must not overwrite the board edit');

    // After re-reading, the model edits the same task and the board sees it.
    const reread = (await modelCall({
      action: 'read_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
    })).structuredContent;
    assert.equal(reread.revision, panelSaved.revision);
    const modelSaved = (await modelCall({
      action: 'save_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
      content: `# 模型再次更新\n\n${marker}-model\n`, revision: reread.revision,
    })).structuredContent;
    const panelReread = (await panelCall({
      action: 'read_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
    })).structuredContent;
    assert.equal(panelReread.revision, modelSaved.revision);
    assert.match(panelReread.content, new RegExp(`${marker}-model`));

    // Switch the real root through the board, then use the old identifier from
    // the model side. The rejection comes from the actual re-read root, not a
    // forged workspace_id.
    const nextRoot = join(home, 'cross-switch-docs');
    const switched = (await panelCall({ action: 'set_workspace', directory: nextRoot })).structuredContent;
    assert.equal(switched.changed, true);
    assert.notEqual(switched.workspace_id, workspaceId);
    assert.deepEqual((await panelCall({ action: 'list_projects', workspace_id: switched.workspace_id })).structuredContent.projects, []);
    const fenced = await modelCall({
      action: 'save_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
      content: '# 旧工作区覆盖\n', revision: modelSaved.revision,
    });
    assert.equal(fenced.isError, true);
    assert.match(fenced.content[0].text, /工作区已切换|重新读取工作区/);
    assert.equal(await readFile(created.path, 'utf8'), modelSaved.content, 'the old workspace file must stay untouched');
    const fencedList = await modelCall({ action: 'list_tasks', workspace_id: workspaceId, project_id: project.id });
    assert.equal(fencedList.isError, true);
    const fencedRead = await modelCall({ action: 'read_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id });
    assert.equal(fencedRead.isError, true);

    const book = new OrderBook(home);await book.open();
    assert.deepEqual(await book.list(), [], 'cross-surface document actions never create work orders');
  } finally {
    for (const { client, server } of connections.reverse()) {
      await client.close();await server.close();
    }
    await rm(home, { recursive: true, force: true });
  }
});

test('model sdd_task cannot flip the SDD switch and its writes are rejected while the board has it OFF', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-switch-');
  const connections = [];
  const connect = async options => {
    const server = await createMcp(home, options);
    const client = new Client({ name: 'model-switch-test', version: '1.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);await client.connect(b);
    connections.push({ client, server });
    return client;
  };
  try {
    const model = await connect();
    const panel = await connect({ panelOnly: true });
    const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
    const modelCall = args => call(model, 'sdd_task', args);
    const panelCall = args => call(panel, 'panel_sdd', args);

    const workspace = (await modelCall({ action: 'get_workspace' })).structuredContent;
    assert.equal(workspace.enabled, true, 'the legacy default is ON');
    await assert.rejects(access(join(home, 'sdd')), { code: 'ENOENT' }, 'reading the switch creates no document root');
    const project = (await modelCall({
      action: 'register_project', workspace_id: workspace.workspace_id, name: '开关模型工程',
    })).structuredContent.project;
    const plan = '# 开关规划\n\n## 目标\n\n关闭后拒绝写入。\n';
    const created = (await modelCall({
      action: 'create_task', workspace_id: workspace.workspace_id, project_id: project.id, content: plan,
    })).structuredContent;

    // The board turns SDD off. The model learns the new state through
    // get_workspace but cannot change it: the action and field do not exist.
    const off = (await panelCall({ action: 'set_enabled', enabled: false })).structuredContent;
    assert.equal(off.enabled, false);
    assert.equal((await modelCall({ action: 'get_workspace' })).structuredContent.enabled, false);
    assert.equal((await modelCall({ action: 'set_enabled', enabled: true })).isError, true);
    assert.equal((await modelCall({ action: 'get_workspace', enabled: true })).isError, true);
    const tools = (await model.listTools()).tools;
    const tool = tools.find(entry => entry.name === 'sdd_task');
    assert.ok(!tool.inputSchema.properties.action.enum.includes('set_enabled'), 'the model cannot set the switch');
    assert.equal(tool.inputSchema.properties.enabled, undefined);
    assert.match(tool.description, /cannot choose or change the document root or the SDD switch/);

    // Every write is rejected; the existing file is untouched and no task
    // folder is added.
    const taskDirectories = (await readdir(project.path))
      .filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name));
    const rejectedWrites = [
      { action: 'register_project', workspace_id: workspace.workspace_id, name: '关闭后工程' },
      { action: 'create_task', workspace_id: workspace.workspace_id, project_id: project.id, content: '# 关闭后\n' },
      {
        action: 'save_task', workspace_id: workspace.workspace_id, project_id: project.id, task_id: created.task.id,
        content: '# 关闭后覆盖\n', revision: created.revision,
      },
    ];
    for (const args of rejectedWrites) {
      const rejected = await modelCall(args);
      assert.equal(rejected.isError, true, JSON.stringify(args));
      assert.match(rejected.content[0].text, /SDD 任务文档已关闭|已关闭/);
    }
    assert.equal(await readFile(created.path, 'utf8'), plan, 'the disabled switch leaves the document untouched');
    assert.deepEqual((await readdir(project.path))
      .filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)), taskDirectories);
    assert.equal((await modelCall({
      action: 'read_task', workspace_id: workspace.workspace_id, project_id: project.id, task_id: created.task.id,
    })).structuredContent.content, plan, 'reads stay available while OFF');

    // Turning it back on from the board restores writes; the switch setting does
    // not change the root.
    const on = (await panelCall({ action: 'set_enabled', enabled: true })).structuredContent;
    assert.equal(on.enabled, true);
    assert.equal(on.workspace_id, workspace.workspace_id);
    const updated = (await modelCall({
      action: 'save_task', workspace_id: workspace.workspace_id, project_id: project.id, task_id: created.task.id,
      content: '# 重新开启\n', revision: created.revision,
    })).structuredContent;
    assert.equal(await readFile(created.path, 'utf8'), updated.content);

    const book = new OrderBook(home);await book.open();
    assert.deepEqual(await book.list(), [], 'switching SDD never creates work orders');
  } finally {
    for (const { client, server } of connections.reverse()) {
      await client.close();await server.close();
    }
    await rm(home, { recursive: true, force: true });
  }
});

test('work_submit blocks a saved DSH permission the running consumer cannot honor', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-permission-');
  const server = await createMcp(home);
  const client = new Client({ name: 'permission-guard-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);await client.connect(b);
    await writeFile(join(home, 'delegation.json'), JSON.stringify({ enabled: true, executor: 'dsh', dsh_permission: 'read-only' }));
    const book = new OrderBook(home);await book.open();
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const heartbeat = (extra = {}) => book.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog: { models: [] }, ...extra });
    // An old consumer heartbeat omits permission_control. work_submit must fail
    // instead of queuing work that the old end would execute with the default.
    await heartbeat();
    const blocked = await call('work_submit', { goal: 'must not queue' });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /未提供该权限.*更新并重新加载/);
    assert.deepEqual(await book.list(), [], 'a blocked work_submit saves no order');
    // The same submission is accepted when the running plugin advertises the
    // saved preset, so the guard does not block a correctly updated DSH.
    await heartbeat({ catalog: { models: [], permission_control: { available: true, presets: ['read-only', 'workspace-write', 'danger-full-access'] } } });
    const queued = await call('work_submit', { goal: 'queued with supported permission' });
    assert.equal(queued.isError, undefined);
    assert.equal(queued.structuredContent.status, 'queued');
    // Offline with an explicit saved permission also blocks: a queued order
    // could otherwise be picked up by an old consumer after reconnecting.
    await book.runtime({ active: false, protocol: 2, at: new Date().toISOString(), catalog: { models: [] } });
    const offline = await call('work_submit', { goal: 'must not queue offline' });
    assert.equal(offline.isError, true);
    assert.match(offline.content[0].text, /DSH 当前未连接/);
    // Another executor's stored preference never blocks Hermes or Qoder work.
    const hermes = await call('work_submit', { executor: 'hermes', goal: 'hermes work' });
    assert.equal(hermes.isError, undefined);
    const qoder = await call('work_submit', { executor: 'qoder', goal: 'qoder work' });
    assert.equal(qoder.isError, undefined);
  } finally {
    await client.close();await server.close();await rm(home, { recursive: true, force: true });
  }
});

test('an existing work order stays idempotent when DSH later loses permission capability', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-permission-reuse-');
  const server = await createMcp(home);
  const client = new Client({ name: 'permission-reuse-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);await client.connect(b);
    await writeFile(join(home, 'delegation.json'), JSON.stringify({ enabled: true, executor: 'dsh', dsh_permission: 'read-only' }));
    const book = new OrderBook(home);await book.open();
    const capability = { available: true, presets: ['read-only', 'workspace-write', 'danger-full-access'] };
    await book.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog: { models: [], permission_control: capability } });
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const orderId = randomUUID();
    const payload = { order_id: orderId, goal: 'retry-safe work' };
    const first = await call('work_submit', payload);
    assert.equal(first.isError, undefined);
    assert.equal(first.structuredContent.reused, false);
    assert.equal(first.structuredContent.status, 'queued');
    // The order is already saved, so a retry with the same id and payload must
    // still return the stored receipt (reused:true) after DSH goes offline
    // instead of failing permission admission a second time.
    await book.runtime({ active: false, protocol: 2, at: new Date().toISOString(), catalog: { models: [] } });
    const offlineRetry = await call('work_submit', payload);
    assert.equal(offlineRetry.isError, undefined);
    assert.equal(offlineRetry.structuredContent.reused, true);
    assert.equal(offlineRetry.structuredContent.order_id, orderId);
    // An old consumer heartbeat (online but without permission_control) behaves
    // the same: the stored order is reusable and nothing is executed again.
    await book.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog: { models: [] } });
    const oldConsumerRetry = await call('work_submit', payload);
    assert.equal(oldConsumerRetry.isError, undefined);
    assert.equal(oldConsumerRetry.structuredContent.reused, true);
    assert.equal((await book.list()).length, 1, 'a retry never stores a second order');
    // Reusing the id with different arguments still reaches OrderBook's
    // parameter-conflict check; permission admission never bypasses it.
    const conflict = await call('work_submit', { order_id: orderId, goal: 'different atomic work' });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /already bound to different work/);
    assert.equal((await book.request(orderId)).payload.goal, 'retry-safe work');
    assert.equal((await book.list()).length, 1);
  } finally {
    await client.close();await server.close();await rm(home, { recursive: true, force: true });
  }
});


test('work_submit blocks Hermes and Qoder saved permissions their running consumer cannot honor', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-permission-cross-');
  const server = await createMcp(home);
  const client = new Client({ name: 'permission-cross-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);await client.connect(b);
    const book = new OrderBook(home);await book.open();
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const heartbeat = (executor, catalog) => book.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog }, executor);
    await writeFile(join(home, 'delegation.json'), JSON.stringify({
      enabled: true, executor: 'hermes', hermes_permission: 'yolo', qoder_permission: 'accept_edits',
    }));
    // Old Hermes consumer: no capability advertised.
    await heartbeat('hermes', { models: [] });
    const hermesBlocked = await call('work_submit', { executor: 'hermes', goal: 'blocked hermes' });
    assert.equal(hermesBlocked.isError, true);
    assert.match(hermesBlocked.content[0].text, /Hermes.*未提供该权限/);
    // Old Qoder consumer: no capability advertised.
    await heartbeat('qoder', { models: [] });
    const qoderBlocked = await call('work_submit', { executor: 'qoder', goal: 'blocked qoder' });
    assert.equal(qoderBlocked.isError, true);
    assert.match(qoderBlocked.content[0].text, /Qoder.*未提供该权限/);
    assert.deepEqual(await book.list(), [], 'blocked submissions save no order');
    // Correctly updated consumers accept their own native values.
    await heartbeat('hermes', { models: [], permission_control: { available: true, presets: ['yolo'] } });
    await heartbeat('qoder', { models: [], permission_control: { available: true, presets: ['accept_edits', 'dont_ask', 'auto', 'bypass_permissions'] } });
    assert.equal((await call('work_submit', { executor: 'hermes', goal: 'hermes allowed' })).isError, undefined);
    assert.equal((await call('work_submit', { executor: 'qoder', goal: 'qoder allowed' })).isError, undefined);
    // A damaged stored value blocks instead of being ignored.
    await writeFile(join(home, 'delegation.json'), JSON.stringify({ enabled: true, executor: 'hermes', hermes_permission: 'manual' }));
    const damaged = await call('work_submit', { executor: 'hermes', goal: 'damaged' });
    assert.equal(damaged.isError, true);
    assert.match(damaged.content[0].text, /自动派工设置无法读取|无法解析|不受支持/);
  } finally {
    await client.close();await server.close();await rm(home, { recursive: true, force: true });
  }
});
