import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OrderBook, definitions, inspectOrderId } from './orders.mjs';
import { EXECUTORS } from './executors.mjs';
import { readDelegation, assertPermissionDispatchable } from './delegation.mjs';
import { registerSddTask } from './sdd-tools.mjs';
import { createRecentOrderReader } from './recent-orders.mjs';
import {
  OrderObserver, compactRuntimes, summarizeOrder,
  WAIT_DEFAULT_TIMEOUT_MS, WAIT_MAX_TIMEOUT_MS,
} from './work-observation.mjs';

const response = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const WAIT_ORDER_ID_DESCRIPTION = 'UUID of a saved work order to wait for. Must be an order_id returned by work_submit or work_update; task titles and cw- conversation IDs are not valid.';

export async function createMcp(home, { panelOnly = false, onOrder, onRuntime, snapshot, onSettings, onPanel, onUsage, recentOrders } = {}) {
  const book = new OrderBook(home);
  await book.open();
  const server = new McpServer({ name: 'codex-to-agents', version: '0.1.0' });
  if (panelOnly) {
    const { registerPanel } = await import('./panel.mjs');
    registerPanel(server, home, { snapshot, onSettings, onRuntime, onPanel, onUsage });
    return server;
  }
  const listing = recentOrders ?? createRecentOrderReader(home);
  const observer = new OrderObserver(home);
  let closing = null;
  const cleanup = () => {
    // An in-flight work_wait holds file watchers, timers and listeners; a
    // disconnect, server.close or explicit close must release all of them.
    observer.close();
    if (recentOrders) return Promise.resolve();
    return listing.close().catch(error => console.error(error.message));
  };
  // The protocol callback covers peer/transport disconnects; explicit close also
  // awaits cleanup when no transport has ever been connected.
  const onclose = server.server.onclose;
  server.server.onclose = (...args) => {
    try { onclose?.(...args); } finally { void cleanup(); }
  };
  const close = server.close.bind(server);
  server.close = () => closing ??= (async () => {
    try { await close(); } finally { await cleanup(); }
  })();
  for (const [kind, definition] of Object.entries(definitions)) {
    server.registerTool(kind, {
      description: definition.text, inputSchema: definition.schema,
      annotations: { destructiveHint: definition.destructive ?? false, readOnlyHint: false, openWorldHint: true },
    }, async input => {
      try {
        // A saved new-session permission needs a running consumer that can apply it.
        // Enforce that only for genuinely new work: a retry reusing an existing
        // order_id must still reach OrderBook, which returns reused:true for the
        // same payload and rejects a changed one. Otherwise an idempotent
        // receipt would start failing after DSH goes offline or its capability
        // heartbeat changes.
        if (kind === 'work_submit') {
          const existing = input.order_id ? await book.request(input.order_id) : null;
          if (!existing) await assertPermissionDispatchable(home, input.executor ?? 'dsh');
        }
        const order = await book.submit(kind, input);onOrder?.();return response(order);
      }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  // Model-visible document tool. The board keeps its app-only panel_sdd tool;
  // this one reuses the same storage contract but cannot set the workspace.
  registerSddTask(server, home);
  server.registerTool('work_inspect', {
    description: 'Read a saved work order with executor, progress, conversation ID and result. The default view "summary" is a bounded overview (short progress/error/result and worker online state); pass view:"detail" for the complete events, output and model catalog. Without order_id list recent work orders. Works while execution agents are offline.',
    inputSchema: z.object({
      order_id: inspectOrderId,
      view: z.enum(['summary', 'detail']).default('summary')
        .describe('summary (default) returns a bounded overview; detail returns the complete saved record.'),
      limit: z.number().int().min(1).max(50).default(10),
    }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ order_id, view, limit }) => {
    try {
      if (order_id) {
        const state = await book.inspect(order_id);
        const worker = await book.runtime(null, state.executor);
        if (view === 'detail') return response({ ...state, worker });
        return response(summarizeOrder(state, worker));
      }
      const page = await listing.list(limit);
      // Liveness only: the full model catalog belongs to runtime_info.
      return response({ ...page, worker: compactRuntimes(page.worker) });
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  server.registerTool('work_wait', {
    description: `Wait read-only for one saved work order to reach a terminal state (completed, failed, cancelled or blocked). Returns the bounded summary with timed_out=false on a terminal state; an uncertain order returns immediately with needs_attention=true; otherwise returns timed_out=true with the current bounded summary after timeout_ms (0-${WAIT_MAX_TIMEOUT_MS}, default ${WAIT_DEFAULT_TIMEOUT_MS}). It never submits, replays or cancels work, and an offline executor is not completion. Waiting is bounded to this single call.`,
    inputSchema: z.object({
      order_id: z.uuid({ error: WAIT_ORDER_ID_DESCRIPTION }).describe(WAIT_ORDER_ID_DESCRIPTION),
      timeout_ms: z.number().int().min(0).max(WAIT_MAX_TIMEOUT_MS).default(WAIT_DEFAULT_TIMEOUT_MS)
        .describe(`Maximum wait in milliseconds. 0 returns the current bounded summary without waiting.`),
    }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ order_id, timeout_ms }, extra) => {
    try {
      return response(await observer.wait(order_id, { timeoutMs: timeout_ms, signal: extra?.signal }));
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  server.registerTool('runtime_info', {
    description: 'Read consumer heartbeat and cached model catalog. Select executor dsh, hermes or qoder for its snapshot; omit to see every executor under executors. online=false means its work remains saved until that consumer connects.',
    inputSchema: z.object({ executor: z.enum(EXECUTORS).optional() }).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ executor }) => {
    if (executor !== 'dsh') await onRuntime?.(executor);
    let delegation;
    try { delegation = await readDelegation(home); }
    catch { delegation = { enabled: false, error: 'Automatic delegation settings could not be read.' }; }
    return response({ ...await (executor ? book.runtime(null, executor) : book.runtimes()), delegation });
  });
  return server;
}

export async function openMcp(home, options) {
  const server = await createMcp(home, options);
  await server.connect(new StdioServerTransport());
  return server;
}
