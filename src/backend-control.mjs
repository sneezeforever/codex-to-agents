import { readFile, mkdir, writeFile, link, unlink, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { namedNode } from './processes.mjs';

const entry = fileURLToPath(new URL('./command.mjs', import.meta.url));
export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null;throw error; }
}

export async function backendAuth(home) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'backend-auth.json');
  let value = await readJson(path);
  if (!value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ token: randomBytes(32).toString('hex') }), { mode: 0o600, flag: 'wx' });
      try { await link(temporary, path); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { await unlink(temporary); }
    value = await readJson(path);
  }
  if (!/^[a-f0-9]{64}$/.test(value?.token ?? '')) throw new Error('Invalid local backend credential.');
  return { Authorization: `Bearer ${value.token}` };
}

export async function backendStatus(home) {
  const saved = await readJson(join(home, 'backend.json'));
  if (!saved) return { online: false };
  // Never send the local credential to an address read from an unchecked file.
  const url = new URL(saved.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Invalid local backend address.');
  try {
    const response = await fetch(url.origin + '/health', { headers: await backendAuth(home), redirect: 'error', signal: AbortSignal.timeout(700) });
    if (!response.ok) return { online: false, ...saved };
    const health = await response.json();
    return { ...saved, ...health, online: health.instance === saved.instance && health.home === resolve(home) };
  } catch { return { ...saved, online: false }; }
}

export async function ensureBackend(home) {
  home = resolve(home);
  const status = await backendStatus(home);
  if (status.online) return status;
  await backendAuth(home);
  const node = await namedNode(home, 'agents-backend');
  const log = await open(join(home, 'backend.log'), 'a', 0o600);
  let child;
  try { child = spawn(node, [entry, 'backend-run', '--home', home], { detached: true, stdio: ['ignore', log.fd, log.fd] });child.unref(); }
  finally { await log.close(); }
  let failed;
  child.once('error', error => { failed = error; });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (failed) throw failed;
    const state = await backendStatus(home);
    if (state.online) return state;
    await delay(100);
  }
  throw new Error('Shared Agents backend did not start. See backend.log in the data directory.');
}

export async function stopBackend(home) {
  const status = await backendStatus(home);
  if (!status.online) return { stopped: false };
  const response = await fetch(status.url + '/control/stop', { method: 'POST', headers: await backendAuth(home), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Could not stop the shared backend.');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await backendStatus(home)).online && !await readJson(join(home, 'backend.lock'))) return { stopped: true, pid: status.pid };
    await delay(100);
  }
  throw new Error('Shared backend is still stopping; native work has not been cancelled.');
}

export async function backendConnection(home, path) {
  const backend = await ensureBackend(home);
  const node = await namedNode(home, 'agents-hook');
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return { url: backend.url + path, http_headers_helper: [node, entry, 'backend-headers', '--home', resolve(home)].map(quote).join(' ') };
}

// The stdio entry is a protocol bridge, not a second execution service: it
// forwards each MCP message to the same authenticated shared backend. Command
// and args stay separate so spaces, quotes and non-ASCII data-directory paths
// never pass through a shell.
export async function stdioConnection(home, path, { node = process.execPath } = {}) {
  const name = path === '/board' ? 'agents-board' : path === '/mcp' ? 'agents-mcp' : null;
  if (!name) throw new Error('Unknown MCP endpoint.');
  const command = await namedNode(home, name, { node });
  return {
    command,
    args: [entry, 'serve', '--home', resolve(home), ...(path === '/board' ? ['--panel-only'] : [])],
  };
}

export async function connectionConfig(home, transport, path, options) {
  if (transport === 'stdio') return stdioConnection(home, path, options);
  if (transport === 'http') return backendConnection(home, path);
  throw new Error('--transport must be stdio or http.');
}

export async function bridgeStdio(home, { panelOnly = false, input = process.stdin, output = process.stdout } = {}) {
  const { createInterface } = await import('node:readline');
  const backend = await ensureBackend(home);
  const headers = { ...await backendAuth(home), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let message;
    try { message = JSON.parse(line); }
    catch { continue; }
    try {
      const response = await fetch(backend.url + (panelOnly ? '/board' : '/mcp'), {
        method: 'POST', headers, body: line, redirect: 'error', signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error('Shared backend rejected the request.');
      if (response.status !== 202) output.write(await response.text() + '\n');
    } catch {
      if (message.id !== undefined) {
        const messageText = message.method === 'tools/call'
          ? 'Shared backend could not confirm this operation. Inspect the original work order before retrying.'
          : 'Shared backend is unavailable. Check backend status and backend.log; the transport was not changed automatically.';
        output.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          error: { code: -32603, message: messageText } }) + '\n');
      }
    }
  }
}
