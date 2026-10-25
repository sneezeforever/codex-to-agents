import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OrderBook } from '../src/orders.mjs';
import { Consumer } from '../src/worker.mjs';
import { DELIVERY_GUIDANCE, withDeliveryGuidance } from '../src/worker-delivery.mjs';

const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function environment(t) {
  const home = await mkdtemp('/tmp/cta-delivery-');
  const book = new OrderBook(home);await book.open();
  const sent = [];
  const operations = [];
  const counters = { observe: 0, progress: 0 };
  const desktop = {
    async describe() { return { models: [] }; },
    observe(ids) { counters.observe++;return ids.map(id => ({ id, status: 'idle' })); },
    async start(order) { return { conversation_id: `cw-${order.id}`, checkpoint: 0 }; },
    async send(order, location, message, mode) {
      sent.push({ id: order.id, kind: order.kind, location, message, mode });
      // Completing the submission immediately keeps later follow-ups unblocked
      // while the conversation id from start() stays on the saved state.
      return order.kind === 'work_submit' ? { status: 'completed', progress: 'done' } : { status: 'executing', progress: 'follow-up' };
    },
    async checkpoint(id) { return { conversation_id: id, checkpoint: 1 }; },
    async progress() { counters.progress++;return { status: 'completed', progress: 'done' }; },
    async cancel(id) { operations.push({ cancelled: id }); },
    async ready() { return true; },
  };
  const consumers = [];
  const consumer = async (options = {}) => {
    const value = new Consumer(home, desktop, { executor: 'dsh', heartbeatInterval: 250, activeInterval: 60, idleInterval: 60, ...options });
    await value.open();
    consumers.push(value);
    return value;
  };
  t.after(async () => {
    for (const value of consumers.reverse()) await value.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, book, desktop, sent, operations, counters, consumer };
}

async function tickUntil(worker, predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await worker.tick();
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('the delivery guidance is a short, imperative self-report requirement', () => {
  assert.equal(typeof DELIVERY_GUIDANCE, 'string');
  const lines = DELIVERY_GUIDANCE.split('\n').filter(line => line.trim());
  assert.ok(lines.length >= 6 && lines.length <= 12, `guidance stays short, saw ${lines.length} lines`);
  assert.match(DELIVERY_GUIDANCE, /结果|完成|阻塞/);
  assert.match(DELIVERY_GUIDANCE, /哪些文件|文件/);
  assert.match(DELIVERY_GUIDANCE, /摘要/);
  assert.match(DELIVERY_GUIDANCE, /验证/);
  assert.match(DELIVERY_GUIDANCE, /未验证/);
  assert.match(DELIVERY_GUIDANCE, /scope/);
  assert.match(DELIVERY_GUIDANCE, /全仓/);
  assert.match(DELIVERY_GUIDANCE, /伪造|验收/);
  // A generic convention must never override an explicit output format.
  assert.match(DELIVERY_GUIDANCE, /原任务/);
  assert.match(DELIVERY_GUIDANCE, /格式/);
  assert.match(DELIVERY_GUIDANCE, /以原任务为准/);
  assert.match(DELIVERY_GUIDANCE, /JSON|补丁/);
  assert.ok(!/```/.test(DELIVERY_GUIDANCE), 'the convention never pastes code blocks');
});

test('an explicit output format in the original task keeps precedence over the convention', () => {
  const original = '只输出一个 JSON 对象：{"ok":true}，不要其他格式或解释。';
  const guided = withDeliveryGuidance('work_submit', undefined, original);
  assert.ok(guided.startsWith(original), 'the original instruction including its format stays first');
  assert.ok(guided.includes(DELIVERY_GUIDANCE));
  assert.match(guided, /以原任务为准/);
  assert.match(guided, /不要追加另一种格式或改写原格式/);
  // The convention text never asks the executor to replace a requested JSON or
  // patch with the delivery template; it only says to carry evidence inside it.
  assert.match(DELIVERY_GUIDANCE, /在指定格式内容纳这些信息/);
});

test('the guidance is appended to submissions and to append/interrupt follow-ups', () => {
  for (const [kind, action] of [['work_submit', undefined], ['work_update', 'append'], ['work_update', 'interrupt']]) {
    const original = 'ORIGINAL TASK TEXT';
    const result = withDeliveryGuidance(kind, action, original);
    assert.ok(result.startsWith(original), `${kind}/${action} keeps the original text at the start`);
    assert.ok(result.endsWith(DELIVERY_GUIDANCE), `${kind}/${action} appends the convention`);
    assert.equal(result, `${original}\n\n${DELIVERY_GUIDANCE}`);
  }
});

test('cancellations, management orders and unknown kinds never get the convention', () => {
  for (const [kind, action] of [
    ['work_update', 'cancel'], ['workspace_control', 'list'], ['conversation_control', 'rename'],
    ['work_update', undefined], ['work_update', 'unknown'], ['unknown_kind', 'append'],
  ]) {
    assert.equal(withDeliveryGuidance(kind, action, 'unchanged text'), 'unchanged text', `${kind}/${action} stays raw`);
  }
  assert.equal(withDeliveryGuidance(undefined, undefined, 'plain'), 'plain');
});

test('non-string messages pass through unchanged instead of throwing during dispatch', () => {
  assert.equal(withDeliveryGuidance('work_submit', undefined, undefined), undefined);
  assert.equal(withDeliveryGuidance('work_submit', undefined, null), null);
  const object = { goal: 'not a string' };
  assert.equal(withDeliveryGuidance('work_submit', undefined, object), object);
  assert.equal(withDeliveryGuidance('work_update', 'append', 42), 42);
});

test('the consumer delivers guided messages while the saved payload and fingerprint stay original', async t => {
  const f = await environment(t);
  const worker = await f.consumer();
  const goal = '实现一个可复现的小改动；最终只输出 JSON：{"summary":"..."}，不要 markdown。';
  const submit = await f.book.submit('work_submit', { goal });
  await tickUntil(worker, () => f.sent.some(item => item.id === submit.order_id), 'work_submit delivery');
  const appendMessage = '补充：只改这个文件';
  const append = await f.book.submit('work_update', { target_order: submit.order_id, action: 'append', message: appendMessage });
  await tickUntil(worker, () => f.sent.some(item => item.id === append.order_id), 'work_update append delivery');

  const submitSend = f.sent.find(item => item.id === submit.order_id);
  const appendSend = f.sent.find(item => item.id === append.order_id);
  assert.ok(submitSend.message.endsWith(DELIVERY_GUIDANCE), 'the submission ends with the convention');
  assert.ok(appendSend.message.endsWith(DELIVERY_GUIDANCE), 'the follow-up ends with the convention');
  assert.ok(submitSend.message.startsWith(goal), 'the original instruction and its format requirement stay first');
  assert.ok(appendSend.message.startsWith(appendMessage));
  assert.match(submitSend.message, /以原任务为准/, 'the convention states that the original format wins');
  assert.equal(submitSend.mode, 'queue');
  assert.equal(appendSend.mode, 'queue');

  for (const [id, field, original] of [[submit.order_id, 'goal', goal], [append.order_id, 'message', appendMessage]]) {
    const request = JSON.parse(await readFile(join(f.home, 'requests', `${id}.json`), 'utf8'));
    assert.equal(request.payload[field], original, 'the saved payload keeps the original text');
    assert.equal(request.fingerprint, sha256({ kind: request.kind, payload: request.payload }), 'the fingerprint still covers only kind and payload');
    assert.ok(!JSON.stringify(request).includes(DELIVERY_GUIDANCE), 'no guidance is persisted');
  }
});

test('a cancellation dispatches through cancel and never through send', async t => {
  const f = await environment(t);
  const worker = await f.consumer();
  const submit = await f.book.submit('work_submit', { goal: 'work that will be cancelled' });
  await tickUntil(worker, () => f.sent.some(item => item.id === submit.order_id), 'work_submit delivery');
  const state = await f.book.inspect(submit.order_id);
  assert.ok(state.conversation_id, 'the submission created a conversation');

  const cancel = await f.book.submit('work_update', { target_order: submit.order_id, action: 'cancel' });
  await tickUntil(worker, async () => (await f.book.inspect(cancel.order_id)).status === 'completed', 'cancel dispatch');
  assert.deepEqual(f.operations, [{ cancelled: state.conversation_id }]);
  assert.ok(!f.sent.some(item => item.id === cancel.order_id), 'a cancellation never sends a message');
  assert.equal(f.sent.filter(item => item.id === submit.order_id).length, 1);
});
