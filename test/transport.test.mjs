import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { install, main, pluginInstall } from '../src/command.mjs';
import { preparePlugin } from '../src/plugin.mjs';
import { backendAuth, backendStatus, connectionConfig, stopBackend } from '../src/backend-control.mjs';
import { TRANSPORT_FILE, readTransport, resolveTransport, saveTransport } from '../src/transport.mjs';
import { PANEL_URI } from '../src/panel.mjs';
import { OrderBook } from '../src/orders.mjs';

const fixtureCli = fileURLToPath(new URL('./fixtures/codex-cli.mjs', import.meta.url));
const MODEL_TOOLS = ['conversation_control', 'runtime_info', 'sdd_task', 'work_inspect', 'work_submit', 'work_update', 'work_wait', 'workspace_control'];
const BOARD_TOOLS = ['open_panel', 'panel_sdd', 'panel_settings', 'panel_snapshot', 'panel_update', 'panel_usage'];
const NEW_ENV = ['HOME', 'CODEX_HOME'];

const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function fixture(t, name = 'data') {
  const root = await mkdtemp('/tmp/cta-transport-');
  const home = join(root, name);
  await mkdir(home, { recursive: true });
  // Every test that reaches a backend keeps the production statistics
  // endpoint out of the loop; an absent preference would default to enabled.
  await writeFile(join(home, 'usage-settings.json'), '{"enabled":false}\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home };
}

async function fakeCodex(root) {
  const executable = join(root, 'codex');
  await writeFile(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixtureCli)} "$@"\n`, { mode: 0o755 });
  return executable;
}

async function isolateCodex(t, root) {
  const previous = Object.fromEntries(NEW_ENV.map(name => [name, process.env[name]]));
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), '');
  process.env.HOME = home;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    for (const name of NEW_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  return join(codexHome, 'config.toml');
}

function tomlFields(text) {
  const read = pattern => {
    const line = pattern.exec(text);
    return line ? JSON.parse(line[1]) : null;
  };
  return {
    command: read(/^command = (".*")$/m),
    args: read(/^args = (\[.*\])$/m),
    url: read(/^url = (".*")$/m),
    helper: read(/^http_headers_helper = (".*")$/m),
  };
}

function agentServer(manifest) {
  return manifest.mcpServers.agents_board;
}

async function closeClients(clients) {
  await Promise.all(clients.map(client => client.close().catch(() => {})));
}

test('transport preference defaults to stdio, remembers an explicit choice, and rejects damage', async t => {
  const { home } = await fixture(t);
  assert.equal(await resolveTransport(home), 'stdio');
  assert.equal(await readTransport(home), null);
  await assert.rejects(resolveTransport(home, 'socks'), /--transport must be stdio or http/);
  await assert.rejects(install({ home, executor: 'hermes', action: 'enable', transport: 'socks' }, { register: async () => {} }),
    /--transport must be stdio or http/);

  await saveTransport(home, 'http');
  assert.equal(await readTransport(home), 'http');
  assert.equal((await stat(join(home, TRANSPORT_FILE))).mode & 0o777, 0o600);
  assert.equal(await resolveTransport(home), 'http');
  // An explicit run-time choice wins without rewriting the saved preference.
  assert.equal(await resolveTransport(home, 'stdio'), 'stdio');
  assert.equal(await readTransport(home), 'http');

  const damaged = '{"transport":"socks"}\n';
  await writeFile(join(home, TRANSPORT_FILE), damaged);
  await assert.rejects(resolveTransport(home), /传输配置损坏/);
  assert.equal(await readFile(join(home, TRANSPORT_FILE), 'utf8'), damaged);
  await assert.rejects(preparePlugin(home, { root: join(home, 'marketplace') }), /传输配置损坏/);
  assert.equal(await readFile(join(home, TRANSPORT_FILE), 'utf8'), damaged, 'a damaged preference is never silently replaced');
});

test('enable registers the same persistent transport for the dispatch MCP and reports that the board needs plugin-install', async t => {
  const { root, home } = await fixture(t);
  const configPath = await isolateCodex(t, root);
  const codex = await fakeCodex(root);
  try {
    const enabled = await install({ home, executor: 'hermes', action: 'enable', codex }, {});
    assert.equal(enabled.transport, 'stdio');
    assert.equal(enabled.board_sync_required, true);
    assert.match(enabled.board_sync_hint, /plugin-install/);
    let fields = tomlFields(await readFile(configPath, 'utf8'));
    assert.ok(fields.command);
    assert.ok(fields.args.includes('serve'));
    assert.ok(fields.args.includes(home));
    assert.equal(fields.url, null);
    assert.equal(fields.helper, null);
    await assert.rejects(access(join(home, TRANSPORT_FILE)), { code: 'ENOENT' }, 'the implicit default is not persisted');

    const http = await install({ home, executor: 'hermes', action: 'enable', codex, transport: 'http' }, {});
    assert.equal(http.transport, 'http');
    fields = tomlFields(await readFile(configPath, 'utf8'));
    assert.match(fields.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.match(fields.helper, /backend-headers/);
    assert.equal(fields.command, null);
    assert.equal(fields.args, null);
    assert.equal(await resolveTransport(home), 'http');

    // A later reinstall without --transport keeps the saved protocol and does
    // not stack helpers or mix command/url fields.
    await install({ home, executor: 'hermes', action: 'enable', codex }, {});
    const text = await readFile(configPath, 'utf8');
    assert.equal((text.match(/^http_headers_helper = /gm) ?? []).length, 1);
    assert.equal(tomlFields(text).command, null);

    await install({ home, executor: 'hermes', action: 'enable', codex, transport: 'stdio' }, {});
    fields = tomlFields(await readFile(configPath, 'utf8'));
    assert.ok(fields.command);
    assert.deepEqual(fields.args.slice(0, 2), [fileURLToPath(new URL('../src/command.mjs', import.meta.url)), 'serve']);
    assert.equal(fields.url, null);
    assert.equal(fields.helper, null);
    assert.equal(await resolveTransport(home), 'stdio');

    const beforeConfig = await readFile(configPath, 'utf8');
    const beforeSettings = await readFile(join(home, 'settings.json'), 'utf8');
    await assert.rejects(install({ home, executor: 'hermes', action: 'enable', codex, transport: 'quic' }, {}),
      /--transport must be stdio or http/);
    assert.equal(await readFile(configPath, 'utf8'), beforeConfig);
    assert.equal(await readFile(join(home, 'settings.json'), 'utf8'), beforeSettings);
    assert.equal(await resolveTransport(home), 'stdio');
    await assert.rejects(main(['enable', '--home', home, '--transport', 'quic']), /--transport must be stdio or http/);

    await writeFile(join(home, TRANSPORT_FILE), '{broken');
    await assert.rejects(install({ home, executor: 'hermes', action: 'enable', codex }, {}), /传输配置损坏/);
    assert.equal(await readFile(configPath, 'utf8'), beforeConfig);
    assert.equal(await readFile(join(home, 'settings.json'), 'utf8'), beforeSettings);
  } finally {
    await stopBackend(home).catch(() => {});
  }
});

test('plugin-install writes both board and dispatch connections in one transport and keeps the saved choice', async t => {
  const { root, home } = await fixture(t);
  const configPath = await isolateCodex(t, root);
  const codex = await fakeCodex(root);
  const pluginRoot = join(root, 'marketplace');
  try {
    const stdio = await pluginInstall({ home, codex }, { root: pluginRoot });
    assert.equal(stdio.transport, 'stdio');
    let manifest = JSON.parse(await readFile(join(stdio.plugin, '.mcp.json'), 'utf8'));
    let board = agentServer(manifest);
    assert.ok(board.command);
    assert.ok(board.args.includes('serve'));
    assert.ok(board.args.includes('--panel-only'));
    assert.equal(board.url, undefined);
    assert.equal(board.http_headers_helper, undefined);
    let fields = tomlFields(await readFile(configPath, 'utf8'));
    assert.ok(fields.command);
    assert.equal(fields.url, null);
    await assert.rejects(access(join(home, TRANSPORT_FILE)), { code: 'ENOENT' });

    const http = await pluginInstall({ home, codex, transport: 'http' }, { root: pluginRoot });
    assert.equal(http.transport, 'http');
    manifest = JSON.parse(await readFile(join(http.plugin, '.mcp.json'), 'utf8'));
    board = agentServer(manifest);
    assert.match(board.url, /^http:\/\/127\.0\.0\.1:\d+\/board$/);
    assert.match(board.http_headers_helper, /backend-headers/);
    assert.equal(board.command, undefined);
    assert.equal(board.args, undefined);
    const token = (await backendAuth(home)).Authorization.slice(7);
    assert.ok(!JSON.stringify(manifest).includes(token), 'the private token never enters the plugin manifest');
    fields = tomlFields(await readFile(configPath, 'utf8'));
    assert.match(fields.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal(await resolveTransport(home), 'http');

    const reused = await pluginInstall({ home, codex }, { root: pluginRoot });
    assert.equal(reused.transport, 'http', 'an update/reinstall reuses the saved transport');
    manifest = JSON.parse(await readFile(join(reused.plugin, '.mcp.json'), 'utf8'));
    assert.match(agentServer(manifest).url, /\/board$/);

    const switched = await pluginInstall({ home, codex, transport: 'stdio' }, { root: pluginRoot });
    assert.equal(switched.transport, 'stdio');
    manifest = JSON.parse(await readFile(join(switched.plugin, '.mcp.json'), 'utf8'));
    board = agentServer(manifest);
    assert.ok(board.command);
    assert.equal(board.url, undefined);
    assert.equal(board.http_headers_helper, undefined);

    const beforeManifest = await readFile(join(switched.plugin, '.mcp.json'), 'utf8');
    const beforeConfig = await readFile(configPath, 'utf8');
    await assert.rejects(pluginInstall({ home, codex, transport: 'socks' }, { root: pluginRoot }),
      /--transport must be stdio or http/);
    assert.equal(await readFile(join(switched.plugin, '.mcp.json'), 'utf8'), beforeManifest);
    assert.equal(await readFile(configPath, 'utf8'), beforeConfig);

    await writeFile(join(home, TRANSPORT_FILE), '{broken');
    await assert.rejects(pluginInstall({ home, codex }, { root: pluginRoot }), /传输配置损坏/);
    assert.equal(await readFile(join(switched.plugin, '.mcp.json'), 'utf8'), beforeManifest);
    assert.equal(await readFile(configPath, 'utf8'), beforeConfig);
  } finally {
    await stopBackend(home).catch(() => {});
  }
});

test('a failed registration or plugin install never commits the new transport preference', async t => {
  const { root, home } = await fixture(t);
  await isolateCodex(t, root);
  const codex = await fakeCodex(root);
  const pluginRoot = join(root, 'marketplace');
  try {
    const installed = await pluginInstall({ home, codex, transport: 'http' }, { root: pluginRoot });
    assert.equal(await resolveTransport(home), 'http');
    const manifestPath = join(installed.plugin, '.mcp.json');
    const beforeManifest = await readFile(manifestPath, 'utf8');
    const configPath = join(process.env.CODEX_HOME, 'config.toml');
    const beforeConfig = await readFile(configPath, 'utf8');

    await assert.rejects(install({ home, executor: 'hermes', action: 'enable', codex, transport: 'stdio' }, {
      register: async () => { throw new Error('codex mcp add failed'); },
    }), /codex mcp add failed/);
    assert.equal(await resolveTransport(home), 'http', 'a failed enable keeps the previous choice');
    assert.equal(await readFile(configPath, 'utf8'), beforeConfig);

    await assert.rejects(pluginInstall({ home, codex, transport: 'stdio' }, {
      root: pluginRoot, register: async () => { throw new Error('registration failed'); },
    }), /registration failed/);
    assert.equal(await resolveTransport(home), 'http', 'a failed plugin registration keeps the previous choice');
    assert.equal(await readFile(manifestPath, 'utf8'), beforeManifest,
      'registration runs before the board manifest is rewritten');
    assert.equal(await readFile(configPath, 'utf8'), beforeConfig);

    await assert.rejects(pluginInstall({ home, codex, transport: 'stdio' }, {
      root: pluginRoot, register: async () => {},
      runCodex: async args => {
        if (args[0] === 'plugin') throw new Error('plugin add failed');
      },
    }), /plugin add failed/);
    assert.equal(await resolveTransport(home), 'http', 'a failed plugin install keeps the previous choice');
    assert.equal(await readFile(configPath, 'utf8'), beforeConfig);

    const { root: freshRoot, home: freshHome } = await fixture(t, 'fresh');
    await assert.rejects(pluginInstall({ home: freshHome, codex, transport: 'http' }, {
      root: join(freshRoot, 'marketplace'), register: async () => { throw new Error('registration failed'); },
    }), /registration failed/);
    assert.equal(await readTransport(freshHome), null, 'a failed first install does not persist the explicit default');
    assert.equal(await resolveTransport(freshHome), 'stdio');
  } finally {
    await stopBackend(home).catch(() => {});
  }
});

test('stdio bridge starts real model/board MCP servers through the shared backend, ignores host proxies and treats paths literally', { timeout: 60000 }, async t => {
  const { root, home } = await fixture(t, "a ' $(touch PWNED) 中文 dir");
  const pluginRoot = join(root, 'marketplace');
  const plugin = await preparePlugin(home, { root: pluginRoot });
  const boardConnection = agentServer(JSON.parse(await readFile(join(plugin.plugin, '.mcp.json'), 'utf8')));
  assert.ok(boardConnection.command);
  assert.ok(boardConnection.args.includes('--panel-only'));
  assert.equal(boardConnection.url, undefined);

  let proxyHits = 0;
  const proxy = createServer((request, response) => {
    proxyHits++;
    response.writeHead(502).end('proxy must not receive loopback traffic');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const port = proxy.address().port;
  const proxyEnv = {
    ALL_PROXY: `socks5://127.0.0.1:${port}`, all_proxy: `socks5://127.0.0.1:${port}`,
    HTTP_PROXY: `http://127.0.0.1:${port}`, http_proxy: `http://127.0.0.1:${port}`,
    HTTPS_PROXY: `http://127.0.0.1:${port}`, https_proxy: `http://127.0.0.1:${port}`,
    NO_PROXY: '', no_proxy: '',
  };
  const clients = [];
  try {
    const connectBoard = async () => {
      const client = new Client({ name: 'stdio-board-test', version: '1.0' });
      await client.connect(new StdioClientTransport({
        command: boardConnection.command, args: boardConnection.args, cwd: root,
        env: { ...process.env, ...proxyEnv }, stderr: 'pipe',
      }));
      clients.push(client);
      return client;
    };
    const board = await connectBoard();
    const tools = (await board.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(tools, BOARD_TOOLS);
    assert.equal((await board.listResources()).resources[0].uri, PANEL_URI);
    const resource = await board.readResource({ uri: PANEL_URI });
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    const first = (await board.callTool({ name: 'panel_snapshot', arguments: {} })).structuredContent;
    assert.ok(first.service.pid > 0);

    const model = await connectionConfig(home, 'stdio', '/mcp');
    const modelClient = new Client({ name: 'stdio-model-test', version: '1.0' });
    await modelClient.connect(new StdioClientTransport({
      command: model.command, args: model.args, cwd: root,
      env: { ...process.env, ...proxyEnv }, stderr: 'pipe',
    }));
    clients.push(modelClient);
    assert.deepEqual((await modelClient.listTools()).tools.map(tool => tool.name).sort(), MODEL_TOOLS);
    const payload = { order_id: randomUUID(), goal: 'stdio shared backend' };
    const submitted = await Promise.all([modelClient, modelClient].map(client => client.callTool({ name: 'work_submit', arguments: payload })));
    assert.deepEqual(submitted.map(value => value.structuredContent.reused).sort(), [false, true]);

    const second = await connectBoard();
    const shared = (await second.callTool({ name: 'panel_snapshot', arguments: {} })).structuredContent;
    assert.equal(shared.service.pid, first.service.pid);
    assert.equal((await backendStatus(home)).pid, first.service.pid, 'all stdio clients reuse one backend');
    await board.close();
    assert.equal((await backendStatus(home)).online, true, 'closing one bridge does not stop the shared backend');
    assert.equal((await second.callTool({ name: 'panel_snapshot', arguments: {} })).structuredContent.service.pid, first.service.pid);
    assert.equal(proxyHits, 0, 'the stdio path never depends on NO_PROXY or sends loopback traffic to the proxy');
    await assert.rejects(access(join(root, 'PWNED')), { code: 'ENOENT' }, 'command and args never pass through a shell');
  } finally {
    await closeClients(clients);
    await stopBackend(home).catch(() => {});
  }
});

test('HTTP board connection keeps loopback auth and rejects missing credentials and foreign origins', { timeout: 30000 }, async t => {
  const { root, home } = await fixture(t);
  const plugin = await preparePlugin(home, { root: join(root, 'marketplace'), transport: 'http' });
  const manifestText = await readFile(join(plugin.plugin, '.mcp.json'), 'utf8');
  const board = agentServer(JSON.parse(manifestText));
  assert.match(board.url, /^http:\/\/127\.0\.0\.1:\d+\/board$/);
  assert.match(board.http_headers_helper, /backend-headers/);
  assert.equal(board.command, undefined);
  assert.equal(board.args, undefined);
  const auth = await backendAuth(home);
  assert.ok(!manifestText.includes(auth.Authorization.slice(7)));

  const clients = [];
  try {
    assert.equal((await fetch(board.url)).status, 403);
    assert.equal((await fetch(board.url, { headers: { ...auth, Origin: 'https://example.org' } })).status, 403);
    const client = new Client({ name: 'http-board-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(board.url), { requestInit: { headers: auth } }));
    clients.push(client);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), BOARD_TOOLS);
    assert.equal((await client.readResource({ uri: PANEL_URI })).contents[0].uri, PANEL_URI);
    const panel = (await client.callTool({ name: 'panel_snapshot', arguments: {} })).structuredContent;
    assert.ok(panel.service.pid > 0);

    const model = await connectionConfig(home, 'http', '/mcp');
    assert.equal(new URL(model.url).origin, new URL(board.url).origin);
    const modelClient = new Client({ name: 'http-model-test', version: '1.0' });
    await modelClient.connect(new StreamableHTTPClientTransport(new URL(model.url), { requestInit: { headers: auth } }));
    clients.push(modelClient);
    assert.deepEqual((await modelClient.listTools()).tools.map(tool => tool.name).sort(), MODEL_TOOLS);
    assert.equal((await modelClient.callTool({ name: 'work_inspect', arguments: {} })).structuredContent.total, 0);
  } finally {
    await closeClients(clients);
    await stopBackend(home).catch(() => {});
  }
});

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    await delay(25);
  }
  return false;
}

test('stdio bridge cancels a pending work_wait, keeps serving later queries, and exits on EOF without stopping the backend', { timeout: 30000 }, async t => {
  const { home } = await fixture(t);
  const book = new OrderBook(home);await book.open();
  const order = await book.submit('work_submit', { goal: 'stdio bridge wait fixture' });
  const connection = await connectionConfig(home, 'stdio', '/mcp');
  const client = new Client({ name: 'stdio-bridge-cancel', version: '1.0' });
  let pid;
  try {
    const transport = new StdioClientTransport({ command: connection.command, args: connection.args, stderr: 'pipe' });
    await client.connect(transport);
    pid = transport.pid;
    const controller = new AbortController();
    const rejection = client.callTool({ name: 'work_wait', arguments: { order_id: order.order_id, timeout_ms: 10000 } }, undefined, { signal: controller.signal })
      .then(() => null, error => error);
    await delay(200);
    const abortedAt = Date.now();
    controller.abort();
    assert.ok(await rejection, 'the client abort rejects its own pending wait');
    // Regression: the bridge used to await the long HTTP observation in its
    // read loop, so this query sat behind it and hit the client timeout.
    const listed = await client.listTools({}, { timeout: 1500 });
    const queryMs = Date.now() - abortedAt;
    assert.ok(listed.tools.some(tool => tool.name === 'work_wait'));
    assert.ok(queryMs < 1200, `a query after abort must return promptly, took ${queryMs}ms`);
    assert.equal((await book.inspect(order.order_id)).status, 'queued', 'cancelling a wait never cancels, replays or mutates the order');

    // EOF while another observation is pending: release it, exit the bridge,
    // but keep the shared backend alive for other clients.
    const inFlight = client.callTool({ name: 'work_wait', arguments: { order_id: order.order_id, timeout_ms: 10000 } })
      .then(() => null, error => error);
    await delay(150);
    await client.close();
    await inFlight;
    assert.equal(await waitForProcessExit(pid, 3000), true, 'stdin EOF lets the bridge exit on its own');
    assert.equal((await backendStatus(home)).online, true, 'closing the bridge never stops the shared backend');
    const fresh = new Client({ name: 'stdio-bridge-after-eof', version: '1.0' });
    try {
      await fresh.connect(new StdioClientTransport({ command: connection.command, args: connection.args, stderr: 'pipe' }));
      assert.ok((await fresh.listTools({}, { timeout: 1500 })).tools.some(tool => tool.name === 'work_wait'));
      assert.equal((await book.inspect(order.order_id)).status, 'queued');
    } finally { await fresh.close().catch(() => {}); }
    // The aborted observation must not leave a watcher/timer in the backend:
    // once the backend is asked to stop, its process has to exit normally.
    const backendPid = (await backendStatus(home)).pid;
    await stopBackend(home).catch(() => {});
    assert.equal(await waitForProcessExit(backendPid, 3000), true, 'the backend exits after stop, so no aborted observation kept it alive');
  } finally {
    await client.close().catch(() => {});
    await stopBackend(home).catch(() => {});
  }
});

test('stdio bridge keeps stdout protocol-only on malformed input and exits cleanly on EOF', { timeout: 20000 }, async t => {
  const { home } = await fixture(t);
  const connection = await connectionConfig(home, 'stdio', '/mcp');
  const child = spawn(connection.command, connection.args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';let stderr = '';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('close', code => resolve(code)));
  try {
    child.stdin.write('this is not json\n');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await delay(400);
    assert.equal(stdout, '', 'invalid or notification frames never write noise to stdout');
    child.stdin.end();
    const code = await Promise.race([exited, delay(4000, 'timeout')]);
    assert.equal(code, 0, `the bridge exits on stdin EOF${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
    assert.equal(stdout, '', 'the EOF shutdown stays silent on stdout');
    assert.equal((await backendStatus(home)).online, true, 'an EOF shutdown leaves the shared backend running');
    const backendPid = (await backendStatus(home)).pid;
    await stopBackend(home).catch(() => {});
    assert.equal(await waitForProcessExit(backendPid, 3000), true, 'the backend exits cleanly after the bridge EOF');
  } finally {
    child.stdin.destroy();
    child.kill();
    await stopBackend(home).catch(() => {});
  }
});
