import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Isolated registration fixture. It writes the same table shape Codex writes
// for `codex mcp add`, mirrors the plugin cache layout for marketplace/plugin
// installs, and never touches a real Codex home or plugin cache.
const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const configPath = join(codexHome, 'config.toml');
const marketplacesPath = join(codexHome, '.fake-codex', 'marketplaces.json');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readMarketplaces() {
  try { return await readJson(marketplacesPath); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

async function writeMarketplaces(value) {
  await mkdir(dirname(marketplacesPath), { recursive: true });
  await writeFile(marketplacesPath, JSON.stringify(value, null, 2));
}

async function readConfig() {
  try { return await readFile(configPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function writeConfig(text) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, text, { mode: 0o600 });
}

function tableName(line) {
  return /^\[mcp_servers\.(?:"([^"]+)"|([^\]]+))\]\r?$/.exec(line)?.slice(1).find(Boolean) ?? null;
}

function removeSection(text, name) {
  const kept = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\[/.test(line)) skipping = tableName(line) === name;
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function appendSection(text, body) {
  const base = text.trimEnd();
  return (base ? base + '\n\n' : '') + body + '\n';
}

if (args[0] === 'mcp' && args[1] === 'add') {
  const name = args[2];
  const text = removeSection(await readConfig(), name);
  if (!name) process.exit(2);
  if (args[3] === '--url' && args[4]) {
    await writeConfig(appendSection(text, `[mcp_servers.${name}]\nurl = ${JSON.stringify(args[4])}`));
  } else if (args[3] === '--' && args[4]) {
    const [command, ...commandArgs] = args.slice(4);
    await writeConfig(appendSection(text, `[mcp_servers.${name}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(commandArgs)}`));
  } else process.exit(2);
} else if (args[0] === 'mcp' && args[1] === 'remove') {
  if (!args[2]) process.exit(2);
  await writeConfig(appendSection(removeSection(await readConfig(), args[2]), ''));
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  const root = args[3];
  if (!root) process.exit(2);
  const manifest = await readJson(join(root, '.agents', 'plugins', 'marketplace.json'));
  if (typeof manifest.name !== 'string' || !manifest.name) process.exit(2);
  const marketplaces = await readMarketplaces();
  marketplaces[manifest.name] = resolve(root);
  await writeMarketplaces(marketplaces);
} else if (args[0] === 'plugin' && args[1] === 'add') {
  const selector = args[2] ?? '';
  const separator = selector.lastIndexOf('@');
  if (separator <= 0) process.exit(2);
  const pluginName = selector.slice(0, separator);
  const marketplaceName = selector.slice(separator + 1);
  const root = (await readMarketplaces())[marketplaceName];
  if (!root) process.exit(2);
  const manifest = await readJson(join(root, '.agents', 'plugins', 'marketplace.json'));
  const source = manifest.plugins?.find(plugin => plugin?.name === pluginName)?.source;
  if (source?.source !== 'local' || typeof source.path !== 'string') process.exit(2);
  const directory = resolve(root, source.path);
  const plugin = await readJson(join(directory, '.codex-plugin', 'plugin.json'));
  if (typeof plugin.name !== 'string' || typeof plugin.version !== 'string') process.exit(2);
  await cp(directory, join(codexHome, 'plugins', 'cache', marketplaceName, plugin.name, plugin.version), { recursive: true });
} else {
  process.stderr.write(`fake codex does not support: ${args.join(' ')}\n`);
  process.exit(2);
}
