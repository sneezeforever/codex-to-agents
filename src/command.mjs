#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { namedNode, processName } from './processes.mjs';
import { parseTransport, resolveTransport, saveTransport } from './transport.mjs';

const begin = '# BEGIN CODEX TO AGENTS';
const end = '# END CODEX TO AGENTS';
const entry = fileURLToPath(import.meta.url);
const extension = fileURLToPath(new URL('./extension.mjs', import.meta.url));

export function stripExtension(text) {
  const first = text.indexOf(begin);
  if (first === -1) return text;
  const last = text.indexOf(end, first);
  if (last === -1 || text.indexOf(begin, first + begin.length) !== -1 || text.indexOf(end, last + end.length) !== -1) throw new Error('Malformed codex-to-agents markers.');
  // Cordis may append other patch operations before the closing comment when
  // it saves desktop settings. Remove our node, not the entire marked region.
  const ownedId = '(?:"codex-to-agents-desktop"|\'codex-to-agents-desktop\'|codex-to-agents-desktop)';
  const item = new RegExp(`^( +)-\\s+id:\\s*${ownedId}\\s*(?:#.*)?$`);
  const ownPatch = new RegExp(`^-\\s+id:\\s*${ownedId}\\s*(?:#.*)?$`);
  const body = text.slice(first + begin.length, last).split(/(?=^- )/m).map(operation => {
    const lines = operation.split(/(?<=\n)/);
    if (ownPatch.test(lines[0]?.trimEnd() ?? '')) return '';
    if (!/^- insert:\s*(?:#.*)?$/.test(lines[0]?.trimEnd() ?? '')) return operation;
    for (let index = lines.length - 1; index > 0; index--) {
      const match = lines[index].trimEnd().match(item);
      if (!match) continue;
      let stop = index + 1;
      while (stop < lines.length) {
        const line = lines[stop];
        if (line.trim() && !line.trimStart().startsWith('#') && line.match(/^ */)[0].length <= match[1].length) break;
        stop++;
      }
      lines.splice(index, stop - index);
    }
    if (!lines.slice(1).some(line => line.trim() && !line.trimStart().startsWith('#'))) return lines.slice(1).join('');
    return lines.join('');
  }).join('');
  return text.slice(0, first) + body + text.slice(last + end.length).replace(/^\r?\n/, '');
}

export function extensionBlock(settings, module = extension) {
  return `${begin}\n- insert:\n    - id: codex-to-agents-desktop\n      name: ${JSON.stringify(module)}\n      config:\n        home: ${JSON.stringify(settings.home)}\n        defaultDirectory: ${JSON.stringify(settings.defaultDirectory)}\n        providers: ${JSON.stringify(settings.providers)}\n${end}\n`;
}

async function backup(home, files) {
  const target = join(home, 'backups', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const [name, path] of Object.entries(files)) {
    try { await copyFile(path, join(target, name));await chmod(join(target, name), 0o600); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

export function codex(args, executable) {
  const result = spawnSync(executable ?? 'codex', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status) throw new Error((result.stderr || result.stdout).trim());
}

export async function registerMcp(home, executable, transport) {
  const selected = await resolveTransport(home, transport);
  const { connectionConfig } = await import('./backend-control.mjs');
  const connection = await connectionConfig(home, selected, '/mcp');
  if (selected === 'stdio') {
    codex(['mcp', 'add', 'codex-to-agents', '--', connection.command, ...connection.args], executable);
  } else {
    codex(['mcp', 'add', 'codex-to-agents', '--url', connection.url], executable);
  }
  const path = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
  const text = await readFile(path, 'utf8');
  const header = /^\[mcp_servers\.(?:codex-to-agents|"codex-to-agents")\]\r?$/m;
  if (!header.test(text)) throw new Error('Codex did not save the shared MCP configuration.');
  if (selected === 'http') {
    await writeFile(path, text.replace(header, match => `${match}\nhttp_headers_helper = ${JSON.stringify(connection.http_headers_helper)}`), { mode: 0o600 });
  }
  return { transport: selected };
}

const boardSync = transport => ({
  transport,
  board_sync_required: true,
  board_sync_hint: `运行 node src/command.mjs plugin-install 让现有 Agents 看板同步为 ${transport} 传输。`,
});

async function readSettings(home) {
  try { return JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {};throw error; }
}

async function hermesSettings(options) {
  const { hermesUrl } = await import('./hermes-client.mjs');
  const providers = options.provider?.split(',').map(value => value.trim());
  if (providers?.some(value => !value)) throw new Error('Hermes provider IDs must not be empty.');
  return { url: hermesUrl(options['hermes-url']), defaultDirectory: resolve(options.directory ?? join(options.home, 'workspace')),
    ...(providers ? { providers } : {}), ...(options['hermes-token-env'] ? { tokenEnv: options['hermes-token-env'] } : {}) };
}

// The Qoder executable is verified before anything is saved. An explicitly
// configured path is never replaced by a discovered one; without a path the
// official local locations and PATH are searched in order.
export async function qoderSettings(options) {
  const { resolveExecutable } = await import('./qoder-cli.mjs');
  const resolved = await resolveExecutable({ executable: options['qoder-executable'] });
  return {
    executable: resolved.executable, version: resolved.version,
    defaultDirectory: resolve(options.directory ?? join(options.home, 'workspace')),
  };
}

export async function prepareDshExtension() {
  // A self-contained copy: every relative import of these modules must resolve
  // inside this directory (executors.mjs is imported by worker/orders, and
  // worker-delivery.mjs is imported by worker for the delivery convention).
  const names = ['extension.mjs', 'desktop.mjs', 'worker.mjs', 'orders.mjs', 'executors.mjs', 'order-cache.mjs', 'worker-delivery.mjs'];
  const sources = await Promise.all(names.map(name => readFile(new URL(name, import.meta.url))));
  const hash = createHash('sha256');
  sources.forEach((source, index) => { hash.update(names[index]);hash.update(source); });
  const directory = fileURLToPath(new URL(`../.local/dsh-runtime-${hash.digest('hex').slice(0, 16)}/`, import.meta.url));
  await mkdir(directory, { recursive: true });
  await Promise.all(names.map((name, index) => writeFile(join(directory, name), sources[index])));
  return join(directory, 'extension.mjs');
}

export async function install(options, { register = registerMcp } = {}) {
  const { OrderBook } = await import('./orders.mjs');
  const { isExecutor, EXECUTORS } = await import('./executors.mjs');
  const home = resolve(options.home);
  // Resolve before creating any directories so a bad or damaged transport
  // preference cannot leave a half-changed install behind.
  const transport = options.action === 'disable' ? null : await resolveTransport(home, options.transport);
  const book = new OrderBook(home);await book.open();
  const previous = await readSettings(home);
  if (options.executor && !isExecutor(options.executor)) throw new Error(`executor must be one of ${EXECUTORS.join(', ')}.`);
  if (options.executor === 'qoder') {
    const saved = await backup(home, { 'codex.toml': join(homedir(), '.codex/config.toml'), 'settings.json': join(home, 'settings.json') });
    const settings = { ...previous };
    if (options.action === 'disable') delete settings.qoder;
    else {
      settings.qoder = await qoderSettings({ ...options, home });
      await mkdir(settings.qoder.defaultDirectory, { recursive: true });
      await register(home, options.codex, transport);
    }
    await book.atomic(join(home, 'settings.json'), settings);
    // Commit the preference only after every installer step succeeded. The
    // register call above already used the explicit value, so a failed CLI
    // registration leaves the previous saved choice untouched.
    if (options.action !== 'disable' && options.transport !== undefined) await saveTransport(home, transport);
    const dsh = await book.runtime();
    return { executor: 'qoder', configured: options.action !== 'disable', backup: saved,
      ...(settings.qoder ? { executable: settings.qoder.executable, version: settings.qoder.version } : {}),
      ...(options.action === 'disable' ? {} : boardSync(transport)),
      mcp: 'codex-to-agents', restart_mcp_required: true, login_required: options.action !== 'disable',
      dsh_reload_required: Boolean(dsh.snapshot?.active && dsh.snapshot.protocol !== 2), order_history_retained: true };
  }
  if (options.executor === 'hermes') {
    const saved = await backup(home, { 'codex.toml': join(homedir(), '.codex/config.toml'), 'settings.json': join(home, 'settings.json') });
    const settings = { ...previous };
    if (options.action === 'disable') delete settings.hermes;
    else {
      settings.hermes = await hermesSettings({ ...options, home });
      await mkdir(settings.hermes.defaultDirectory, { recursive: true });
      await register(home, options.codex, transport);
    }
    await book.atomic(join(home, 'settings.json'), settings);
    if (options.action !== 'disable' && options.transport !== undefined) await saveTransport(home, transport);
    const dsh = await book.runtime();
    return { executor: 'hermes', configured: options.action !== 'disable', backup: saved,
      ...(options.action === 'disable' ? {} : boardSync(transport)),
      mcp: 'codex-to-agents', restart_mcp_required: true, dsh_reload_required: Boolean(dsh.snapshot?.active && dsh.snapshot.protocol !== 2),
      order_history_retained: true };
  }
  const profileName = options.profile ?? 'desktop';
  if (!/^[a-z0-9_-]+$/i.test(profileName)) throw new Error('Invalid profile name.');
  const profile = join(options.dshHome ?? join(homedir(), '.dsh'), 'profiles', profileName, 'cordis.patch.yml');
  const original = await readFile(profile, 'utf8');
  const codexConfig = join(homedir(), '.codex/config.toml');
  const saved = await backup(home, { 'profile.yml': profile, 'codex.toml': codexConfig, 'settings.json': join(home, 'settings.json') });
  if (options.action === 'disable') {
    await writeFile(profile, stripExtension(original));
    if (!previous.hermes) codex(['mcp', 'remove', 'codex-to-agents'], options.codex);
    return { disabled: true, backup: saved, order_history_retained: true };
  }
  const providers = options.provider?.split(',').map(item => item.trim());
  if (!providers?.length || providers.some(item => !item)) throw new Error("Specify --provider with an existing DSH provider ID or '*'.");
  if (providers.includes('*') && providers.length !== 1) throw new Error("Use --provider '*' alone; do not mix it with provider IDs.");
  const settings = { ...previous, home, providers, defaultDirectory: resolve(options.directory ?? join(home, 'workspace')) };
  await mkdir(settings.defaultDirectory, { recursive: true });
  // A fresh content-addressed module directory also refreshes nested ESM
  // imports when Cordis reloads the plugin in an already-running desktop.
  const module = await prepareDshExtension();
  const next = stripExtension(original).trimEnd() + '\n\n' + extensionBlock(settings, module);
  await register(home, options.codex, transport);
  await writeFile(join(home, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 });
  await writeFile(profile, next);
  if (options.transport !== undefined) await saveTransport(home, transport);
  return { configured: true, profile, home, mcp: 'codex-to-agents', backup: saved, ...boardSync(transport) };
}

export async function pluginInstall(options, { root, register = registerMcp, runCodex = codex } = {}) {
  const [{ OrderBook }, { preparePlugin }] = await Promise.all([import('./orders.mjs'), import('./plugin.mjs')]);
  const home = resolve(options.home);
  const transport = await resolveTransport(home, options.transport);
  const book = new OrderBook(home);await book.open();
  const saved = await backup(home, { 'codex.toml': join(homedir(), '.codex/config.toml') });
  // Refresh the dispatch entry before touching the board manifest, so a failed
  // registration does not leave the installed board pointing at a new
  // transport while the saved preference (and model entry) stay old.
  await register(home, options.codex, transport);
  const plugin = await preparePlugin(home, { transport, ...(root ? { root } : {}) });
  await runCodex(['plugin', 'marketplace', 'add', plugin.root], options.codex);
  await runCodex(['plugin', 'add', plugin.selector], options.codex);
  await book.atomic(join(home, 'plugin-installation.json'), { codex: options.codex ?? 'codex' });
  // Persist the explicit choice last: a failed MCP registration or plugin
  // install must not silently switch the transport used by later reinstall and
  // update commands. preparePlugin/register already received the selected value.
  if (options.transport !== undefined) await saveTransport(home, transport);
  return { installed: true, ...plugin, backup: saved, restart_codex_required: true,
    hook_trust_required: true, automatic_delegation: 'unchanged; off when not configured' };
}

export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    home: { type: 'string', default: join(homedir(), '.codex-to-agents') }, provider: { type: 'string' },
    directory: { type: 'string' }, profile: { type: 'string' }, 'dsh-home': { type: 'string' }, codex: { type: 'string' },
    executor: { type: 'string' }, 'hermes-url': { type: 'string' }, 'hermes-token-env': { type: 'string' },
    'qoder-executable': { type: 'string' },
    transport: { type: 'string' },
    web: { type: 'boolean' }, once: { type: 'boolean' }, json: { type: 'boolean' }, 'panel-only': { type: 'boolean' },
    interval: { type: 'string', default: '1000' }, limit: { type: 'string', default: '30' }, port: { type: 'string', default: '18862' },
  } });
  parseTransport(values.transport);
  const [command] = positionals;
  process.title = processName(command, values);
  if (command === 'serve') {
    const home = resolve(values.home);
    if (values['hermes-url']) {
      const { OrderBook } = await import('./orders.mjs');const book = new OrderBook(home);await book.open();
      await book.atomic(join(home, 'settings.json'), { ...await readSettings(home), hermes: await hermesSettings({ ...values, home }) });
    }
    const { bridgeStdio } = await import('./backend-control.mjs');
    await bridgeStdio(home, { panelOnly: values['panel-only'] });
  } else if (command === 'backend-run') {
    const { startBackend } = await import('./backend.mjs');
    let backend;
    try { backend = await startBackend(resolve(values.home)); }
    catch (error) { if (error.code === 'BACKEND_BUSY') return;throw error; }
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await backend.close();process.exit(0); });
  } else if (command === 'backend-headers') {
    const { ensureBackend, backendAuth } = await import('./backend-control.mjs');
    const home = resolve(values.home);await ensureBackend(home);console.log(JSON.stringify(await backendAuth(home)));
  } else if (command === 'backend') {
    const { ensureBackend, stopBackend, backendStatus } = await import('./backend-control.mjs');
    const home = resolve(values.home);const action = positionals[1] ?? 'status';
    if (!['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('backend expects start, stop, restart or status.');
    if (['stop', 'restart'].includes(action)) await stopBackend(home);
    console.log(JSON.stringify(['start', 'restart'].includes(action) ? await ensureBackend(home) : await backendStatus(home), null, 2));
  } else if (command === 'delegation-hook') {
    const { runDelegationHook } = await import('./delegation.mjs');
    await runDelegationHook(resolve(values.home));
  } else if (command === 'plugin-install') {
    console.log(JSON.stringify(await pluginInstall(values), null, 2));
  } else if (command === 'worker') {
    if (values.executor === 'qoder') {
      const { startQoderWorker } = await import('./qoder-worker.mjs');
      const home = resolve(values.home);
      const settings = (await readSettings(home)).qoder;
      if (!settings) throw new Error('Qoder is not configured. Run enable --executor qoder first.');
      const worker = startQoderWorker(home, settings, { onError: error => console.error(error.message) });
      console.log('Qoder worker started. Ctrl+C to stop; native sessions are retained.');
      for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await worker.close();process.exit(0); });
    } else {
      const { startHermesWorker } = await import('./hermes-worker.mjs');
      if (values.executor && values.executor !== 'hermes') throw new Error('Standalone worker supports --executor hermes or qoder; DSH uses its desktop plugin.');
      const home = resolve(values.home);
      const settings = await readSettings(home);
      const worker = startHermesWorker(home, values['hermes-url'] ? await hermesSettings({ ...values, home })
        : settings.hermes ?? await hermesSettings({ ...values, home }), { onError: error => console.error(error.message) });
      console.log('Hermes worker started. Ctrl+C to stop; native tasks are retained.');
      for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await worker.close();process.exit(0); });
    }
  } else if (['enable', 'disable'].includes(command)) {
    console.log(JSON.stringify(await install({ ...values, dshHome: values['dsh-home'], action: command }), null, 2));
  } else if (command === 'monitor') {
    const interval = Number(values.interval);const limit = Number(values.limit);const port = Number(values.port);
    if (!Number.isInteger(interval) || interval < 250 || interval > 60000) throw new Error('--interval must be 250–60000 milliseconds.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be 1–100.');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0–65535.');
    if (values.web) {
      if (values.once || values.json) throw new Error('--web cannot be combined with --once or --json.');
      const { monitorWeb } = await import('./monitor-web.mjs');
      const dashboard = await monitorWeb(resolve(values.home), { port, limit });
      console.log(`codex-to-agents monitor: ${dashboard.url}\nRead-only · Ctrl+C to stop`);
      let closing = false;
      const stop = async () => { if (closing) return;closing = true;await dashboard.close(); };
      process.once('SIGINT', stop);process.once('SIGTERM', stop);
    } else { const { monitorTerminal } = await import('./monitor.mjs');await monitorTerminal(resolve(values.home), { once: values.once, json: values.json, interval, limit }); }
  } else if (command === 'status') {
    const { OrderBook } = await import('./orders.mjs');
    const book = new OrderBook(resolve(values.home));await book.open();
    console.log(JSON.stringify({ ...await book.runtimes(), orders: (await book.list()).length }, null, 2));
  } else console.log('Commands: serve | plugin-install | backend start|stop|restart|status | enable --provider PROVIDER | enable --executor hermes | enable --executor qoder | disable [--executor hermes|qoder] | worker --executor hermes|qoder | status | monitor\nTransport: --transport stdio|http (default stdio; an explicit choice is saved and reused by plugin-install and updates)\nHermes: --hermes-url http://127.0.0.1:9120 --hermes-token-env VARIABLE\nQoder: enable --executor qoder [--qoder-executable /absolute/path/to/qodercli] [--directory DIR]\nMonitor: --web --port 18862 | --once | --json | --interval 1000 --limit 30\nOptions: --home DIR --directory DIR --profile desktop --dsh-home DIR --codex EXECUTABLE');
}

if (process.argv[1] && resolve(process.argv[1]) === entry) {
  await main().catch(error => { console.error(error.message);process.exitCode = 1; });
}
