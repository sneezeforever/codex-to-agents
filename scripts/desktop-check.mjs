import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { extensionBlock } from '../src/command.mjs';
import { OrderBook } from '../src/orders.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = join(root, '.local', `check-${randomUUID()}`);
const home = join(run, 'orders');
const directory = join(run, 'project');
const profile = join(homedir(), '.dsh/profiles/desktop/cordis.patch.yml');
const baseline = await readFile(profile, 'utf8');
assert.ok(!baseline.includes('id: codex-to-agents-desktop'), 'An existing consumer is installed; refuse to change it.');
await mkdir(directory, { recursive: true });
await cp(join(root, 'src'), join(run, 'runtime'), { recursive: true });
await writeFile(join(run, 'profile.before.yml'), baseline, { mode: 0o600 });
const fragment = extensionBlock({ home, defaultDirectory: directory, providers: ['deepseek-account'] }, join(run, 'runtime/extension.mjs'));
const patched = baseline.trimEnd() + '\n\n' + fragment;
const book = new OrderBook(home);await book.open();
const client = new Client({ name: 'codex-to-agents-desktop-check', version: '1.0' });
const report = { checks: [], started: new Date().toISOString() };
let mounted = false;
let workspaceId;
let conversationId;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function tool(name, arguments_ = {}) {
  const response = await client.callTool({ name, arguments: arguments_ });
  if (response.isError) throw new Error(response.content.map(block => block.text ?? '').join('\n'));
  return response.structuredContent;
}
// Polling only needs the bounded summary; request the full record explicitly
// (view: "detail") only where the native result itself is asserted.
async function complete(id) {
  for (let n = 0; n < 70; n++) {
    const state = await tool('work_inspect', { order_id: id });
    if (state.status === 'completed') return state;
    if (['failed', 'uncertain', 'blocked', 'cancelled'].includes(state.status)) throw new Error(JSON.stringify(state));
    await pause(500);
  }
  throw new Error(`Work order did not complete: ${id}`);
}
const detail = id => tool('work_inspect', { order_id: id, view: 'detail' });
async function operation(name, payload) {
  const ack = await tool(name, payload);return complete(ack.order_id);
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'src/command.mjs'), 'serve', '--home', home], stderr: 'pipe' }));
  const initial = await tool('workspace_control', { action: 'list' });
  assert.equal(initial.status, 'queued');
  assert.equal((await tool('runtime_info')).online, false);
  report.checks.push('A real MCP client saved an offline desktop operation');
  await writeFile(profile, patched);mounted = true;
  await complete(initial.order_id);
  assert.equal((await tool('runtime_info')).online, true);
  report.checks.push('The desktop consumer picked up the already-saved operation');
  workspaceId = (await detail((await operation('workspace_control', { action: 'register', directory, title: '工作单实机验证' })).order_id)).output.id;
  await operation('workspace_control', { action: 'rename', workspace_id: workspaceId, title: '工作单项目已更名' });
  report.checks.push('Native desktop project registration and rename');
  const payload = { goal: '这是用户授权的工作单系统开发验收。请在当前目录实际创建 hello.txt，内容严格为 WORKORDER_OK 加换行。只写这个文件，不读取其他文件、不运行命令、不访问网络。完成后只回复 DONE。', workspace_id: workspaceId, provider: 'deepseek-account', model: 'deepseek-flash', effort: 'low', title: '工作单写文件' };
  const work = await tool('work_submit', payload);
  const done = await complete(work.order_id);
  conversationId = done.conversation_id;
  assert.ok((await tool('runtime_info')).snapshot.sessions.some(session => session.id === conversationId));
  assert.equal(await readFile(join(directory, 'hello.txt'), 'utf8'), 'WORKORDER_OK\n');
  report.checks.push('A queued work order caused Flash to write the expected file');
  const again = await tool('work_submit', { ...payload, order_id: work.order_id });
  assert.equal(again.reused, true);assert.equal(again.status, 'completed');
  report.checks.push('The same immutable order is reused without duplicate execution');
  await operation('conversation_control', { action: 'rename', conversation_id: conversationId, title: '已验收的工作单聊天' });
  await operation('conversation_control', { action: 'archive', conversation_id: conversationId });
  await operation('conversation_control', { action: 'restore', conversation_id: conversationId });
  const listed = await detail((await operation('conversation_control', { action: 'list', workspace_id: workspaceId })).order_id);
  assert.ok(listed.output.conversations.some(item => item.id === conversationId));
  report.checks.push('Native chat rename, archive, restore and project-filtered list');
  const followed = await detail((await operation('work_update', { target_order: work.order_id, action: 'append', message: '不要调用任何工具，只回复 FOLLOWUP_OK。' })).order_id);
  assert.ok(followed.output.text.includes('FOLLOWUP_OK'));
  report.checks.push('A follow-up order reaches the same desktop chat and has its own result');
  await operation('conversation_control', { action: 'archive', conversation_id: conversationId });
  await operation('workspace_control', { action: 'remove', workspace_id: workspaceId });workspaceId = null;
  assert.equal(await readFile(join(directory, 'hello.txt'), 'utf8'), 'WORKORDER_OK\n');
  report.checks.push('Removing project registration retains the delivered file');
  report.passed = true;
} catch (error) {
  report.passed = false;report.error = error.message;process.exitCode = 1;console.error(error.stack);
} finally {
  if (mounted) {
    if (conversationId) await operation('conversation_control', { action: 'archive', conversation_id: conversationId, stop_running: true }).catch(() => {});
    if (workspaceId) await operation('workspace_control', { action: 'remove', workspace_id: workspaceId }).catch(() => {});
    const current = await readFile(profile, 'utf8');
    assert.ok(current.includes(fragment), 'Profile changed during check; inspect the saved baseline before restoring.');
    await writeFile(profile, current === patched ? baseline : current.replace(fragment, ''));
    for (let n = 0; n < 30; n++) { if (!(await book.runtime()).online) { report.consumer_stopped = true;break; }await pause(300); }
  }
  await client.close();
  report.finished = new Date().toISOString();
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(root, '.local/latest-check.json'), JSON.stringify({ run, ...report }, null, 2));
  if (report.consumer_stopped) await rm(join(run, 'runtime'), { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
