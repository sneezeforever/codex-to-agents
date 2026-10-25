import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export const TRANSPORTS = Object.freeze(['stdio', 'http']);
export const TRANSPORT_FILE = 'transport.json';
const DEFAULT_TRANSPORT = 'stdio';

export function transportPath(home) {
  return join(resolve(home), TRANSPORT_FILE);
}

export function parseTransport(value) {
  if (value === undefined || value === null) return null;
  if (!TRANSPORTS.includes(value)) throw new Error('--transport must be stdio or http.');
  return value;
}

export async function readTransport(home) {
  let text;
  try { text = await readFile(transportPath(home), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let value;
  try { value = JSON.parse(text); }
  catch {
    throw new Error(`传输配置损坏（${TRANSPORT_FILE} 不是有效 JSON）。请修复或删除该文件后重试；现有安装未被修改。`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !TRANSPORTS.includes(value.transport)) {
    throw new Error(`传输配置损坏（${TRANSPORT_FILE} 需要 {"transport":"stdio|http"}）。请修复或删除该文件后重试；现有安装未被修改。`);
  }
  return value.transport;
}

// An explicit CLI choice is validated before any install side effect. Without
// one, the data directory's saved choice wins; a fresh directory uses stdio.
export async function resolveTransport(home, explicit) {
  const chosen = parseTransport(explicit);
  return chosen ?? await readTransport(home) ?? DEFAULT_TRANSPORT;
}

export async function saveTransport(home, value) {
  const transport = parseTransport(value);
  if (!transport) throw new Error('A transport value is required to save the preference.');
  const directory = resolve(home);
  const path = transportPath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ transport }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return transport;
}
