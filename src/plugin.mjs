import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrderBook } from './orders.mjs';
import { namedNode } from './processes.mjs';
import { connectionConfig } from './backend-control.mjs';
import { resolveTransport } from './transport.mjs';

const entry = fileURLToPath(new URL('./command.mjs', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

// A local plugin deliberately points to the installed checkout and Node
// executable. This avoids copying node_modules into Codex's plugin cache.
export async function preparePlugin(home, { transport, root = fileURLToPath(new URL('../.local/plugin-marketplace/', import.meta.url)), node = process.execPath } = {}) {
  home = resolve(home);root = resolve(root);
  const plugin = join(root, 'plugins', 'agents-board');
  const book = new OrderBook(home);
  const selected = await resolveTransport(home, transport);
  const [connection, hookNode] = await Promise.all([
    connectionConfig(home, selected, '/board', { node }), namedNode(home, 'agents-hook', { node }),
  ]);
  await Promise.all([mkdir(join(root, '.agents', 'plugins'), { recursive: true }),
    mkdir(join(plugin, '.codex-plugin'), { recursive: true }), mkdir(join(plugin, 'hooks'), { recursive: true })]);
  const hookCommand = [hookNode, entry, 'delegation-hook', '--home', home].map(quote).join(' ');
  await book.atomic(join(plugin, '.codex-plugin', 'plugin.json'), {
    name: 'agents-board', version: '0.1.0', description: 'Codex 左侧 Agents 看板：手动切换自动派工，选择 Hermes、DSH 或 Qoder 及其可用模型。',
    author: { name: 'sneezeforever' }, mcpServers: './.mcp.json', hooks: './hooks/hooks.json',
    interface: { displayName: 'Agents 看板', shortDescription: '开关自动派工，选择执行端与可用模型。',
      longDescription: 'Codex 内嵌 Agents 看板。自动派工默认关闭，由用户在看板中开启并选择执行端（Hermes、DSH 或 Qoder）、模型；Codex 负责拆解、跟进和验收。首次使用自动派工需要在 Codex 审核并信任插件 Hook。',
      developerName: 'sneezeforever', category: 'Developer Tools', capabilities: ['Read', 'Write'], brandColor: '#46734D' },
  });
  await book.atomic(join(plugin, '.mcp.json'), { mcpServers: { agents_board: {
    ...connection, startup_timeout_sec: 20,
  } } });
  await book.atomic(join(plugin, 'hooks', 'hooks.json'), { description: 'Each user message reads the user-owned automatic delegation switch. Never dispatches work or changes permissions itself.',
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] }] },
  });
  await book.atomic(join(root, '.agents', 'plugins', 'marketplace.json'), {
    name: 'codex-to-agents-local', interface: { displayName: 'Codex to Agents' }, plugins: [{
      name: 'agents-board', source: { source: 'local', path: './plugins/agents-board' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools',
    }],
  });
  return { root, plugin, selector: 'agents-board@codex-to-agents-local', transport: selected };
}
