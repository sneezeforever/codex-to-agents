import { readFile, unlink, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OrderBook, TERMINAL } from './orders.mjs';
import { isExecutor, leaseFile } from './executors.mjs';
import { acquireOrderIndex, releaseOrderIndex } from './order-cache.mjs';
import { withDeliveryGuidance } from './worker-delivery.mjs';

async function lease(home, executor) {
  const file = join(home, leaseFile(executor));
  const identity = { pid: process.pid, nonce: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
      return async () => {
        const current = JSON.parse(await readFile(file, 'utf8'));
        if (current.nonce === identity.nonce) await unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = JSON.parse(await readFile(file, 'utf8'));
      try {
        process.kill(current.pid, 0);
        throw Object.assign(new Error('Another work-order consumer owns this directory for this executor.'), { code: 'CONSUMER_BUSY' });
      }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      await unlink(file);
    }
  }
  throw new Error('Could not claim the work-order directory.');
}

export class Consumer {
  constructor(home, desktop, {
    executor = 'dsh', onError = () => {}, fallbackInterval = 2500,
    activeInterval = 750, idleInterval = 2500, heartbeatInterval = 2000,
  } = {}) {
    if (!isExecutor(executor)) throw new Error('Unknown executor.');
    this.executor = executor;
    this.book = new OrderBook(home);
    this.desktop = desktop;
    this.onError = onError;
    this.fallbackInterval = fallbackInterval;
    this.activeInterval = activeInterval;
    this.idleInterval = idleInterval;
    this.heartbeatInterval = heartbeatInterval;
    this.tail = Promise.resolve();
    this.runtimeWrites = Promise.resolve();
    this.closed = false;
    this.catalog = null;
    this.observeError = null;
    this.sessions = null;
    this.online = null;
    this.nextCatalog = 0;
    this.index = null;
    this.scheduler = null;
    this.lastSchedulerError = null;
  }

  async open() {
    await this.book.open();
    const stat = await lstat(this.book.home);
    if (stat.isSymbolicLink()) throw new Error('Work-order directory may not be a symlink.');
    this.release = await lease(this.book.home, this.executor);
    try {
      this.index = await acquireOrderIndex(this.book.home, { fallbackInterval: this.fallbackInterval });
      await this.desktop.open?.();
      await this.index.sync();
      // A process may have died after a side effect but before saving its reply.
      // Mark those orders uncertain; never automatically submit them again.
      for (const state of this.index.pending(this.executor)) {
        if (state.status !== 'dispatching') continue;
        await this.book.transition(state.order_id, 'uncertain', {
          conversation_id: state.conversation_id ?? (this.executor === 'dsh' && state.kind === 'work_submit' ? `cw-${state.order_id}` : undefined),
          progress: 'Consumer restarted during dispatch; inspecting native history instead of replaying.',
        });
      }
      this.online = true;
    } catch (error) {
      await releaseOrderIndex(this.index);
      this.index = null;
      await this.release();
      throw error;
    }
  }

  tick() {
    this.tail = this.tail.catch(() => {}).then(() => this.closed ? undefined : this.process());
    return this.tail;
  }

  // Immediate wake-ups are reserved for a changed status of THIS executor:
  // new or queued work, a terminal state that can release a blocked follow-up,
  // or a target conversation becoming available. Another executor's orders and
  // a running order whose native progress text merely changes (same status)
  // must not re-arm the scheduler: the active interval already follows work.
  relevantChange(event) {
    if (this.closed || !this.index) return false;
    return Boolean(event?.changes?.some(change =>
      change.executor === this.executor && change.status !== change.previous));
  }

  start({ activeInterval = this.activeInterval, idleInterval = this.idleInterval, heartbeatInterval = this.heartbeatInterval } = {}) {
    if (this.scheduler || this.closed) return this;
    this.activeInterval = activeInterval;
    this.idleInterval = idleInterval;
    this.scheduler = { timer: null, running: false, again: false };
    this.unsubscribe = this.index.onChange(event => {
      if (this.relevantChange(event)) this.wake();
    });
    // Liveness is published independently of delivery, catalog probing and
    // native observation, so a slow adapter can never look offline.
    this.heartbeat = setInterval(() => { void this.publishRuntime(); }, heartbeatInterval);
    this.heartbeat.unref?.();
    this.schedule(0);
    return this;
  }

  schedule(delay) {
    const scheduler = this.scheduler;
    if (!scheduler || this.closed) return;
    clearTimeout(scheduler.timer);
    scheduler.timer = setTimeout(() => { scheduler.timer = null; void this.run(); }, delay);
  }

  wake() {
    const scheduler = this.scheduler;
    if (!scheduler || this.closed) return;
    if (scheduler.running) { scheduler.again = true; return; }
    this.schedule(25);
  }

  async run() {
    const scheduler = this.scheduler;
    if (!scheduler || this.closed) return;
    if (scheduler.running) { scheduler.again = true; return; }
    scheduler.running = true;
    try {
      await this.tick();
      while (scheduler.again && !this.closed) {
        scheduler.again = false;
        await this.tick();
      }
      this.lastSchedulerError = null;
    } catch (error) {
      if (error.message !== this.lastSchedulerError) this.onError(error);
      this.lastSchedulerError = error.message;
    } finally {
      scheduler.running = false;
      if (!this.closed) this.schedule(this.index?.pending(this.executor).length ? this.activeInterval : this.idleInterval);
    }
  }

  async publishRuntime() {
    if (this.closed) return this.runtimeWrites;
    const value = { protocol: 2, executor: this.executor, active: Boolean(this.online), at: new Date().toISOString(), pid: process.pid };
    // A failed observation marks the executor offline but must not discard the
    // last known model catalog; the error clears with the next good observation.
    const catalog = this.catalog || this.observeError
      ? { ...(this.catalog ?? {}), ...(this.observeError ? { error: this.observeError } : {}) }
      : null;
    if (catalog) value.catalog = catalog;
    if (this.sessions) value.sessions = this.sessions;
    this.runtimeWrites = this.runtimeWrites.catch(() => {}).then(() => {
      if (this.closed) return;
      return this.book.runtime(value, this.executor);
    }).catch(() => {});
    return this.runtimeWrites;
  }

  async process() {
    if (Date.now() >= this.nextCatalog) {
      try { this.catalog = await this.desktop.describe(); }
      catch (error) { this.catalog = { error: error.message }; }
      this.nextCatalog = Date.now() + 15000;
    }
    await this.index.sync();
    const orders = this.index.pending(this.executor);
    let sessions;
    try { sessions = await this.desktop.observe(orders.map(order => order.conversation_id).filter(Boolean)); }
    catch (error) {
      this.online = false;
      this.sessions = [];
      this.observeError = error.message;
      await this.publishRuntime();
      return;
    }
    this.online = true;
    this.observeError = null;
    this.sessions = sessions;
    await this.publishRuntime();
    for (const state of orders) {
      if (TERMINAL.has(state.status)) continue;
      const order = await this.book.request(state.order_id);
      if (!order) continue;
      if (['executing', 'uncertain'].includes(state.status)) {
        if (state.conversation_id) {
          // The shared index stores no progress text, so compare against the
          // saved state; otherwise every tick would rewrite an unchanged order.
          const current = await this.book.state(state.order_id) ?? state;
          try {
            const change = await this.desktop.progress(order, current);
            if (change.status !== current.status || change.progress !== current.progress) {
              await this.book.transition(order.id, change.status, change);
            }
          } catch (error) {
            if (current.progress !== error.message) await this.book.transition(order.id, 'uncertain', { progress: error.message });
          }
        }
        continue;
      }
      if (state.status === 'queued') await this.dispatch(order);
    }
  }

  async dispatch(order) {
    let location;
    let startedDelivery = false;
    try {
      const input = order.payload;
      if (order.kind === 'work_update' && input.target_order) {
        const target = await this.book.inspect(input.target_order);
        if (!target.conversation_id) {
          if (TERMINAL.has(target.status)) throw new Error('The target work order did not create a conversation.');
          return; // Preserve dependency ordering without creating duplicate chats.
        }
        location = { conversation_id: target.conversation_id };
      }
      const sessionId = location?.conversation_id ?? input.conversation_id;
      if (order.kind === 'work_update' && input.action === 'append' && this.desktop.ready) {
        const siblings = this.index.pending(this.executor).filter(state => state.order_id !== order.id
          && state.conversation_id === sessionId);
        if (siblings.length || !await this.desktop.ready(sessionId)) return;
      }
      await this.book.transition(order.id, 'dispatching');
      if (order.kind === 'work_submit') {
        location = await this.desktop.start(order);
        await this.book.transition(order.id, 'dispatching', location);
        startedDelivery = true;
        const receipt = await this.desktop.send(order, location, withDeliveryGuidance('work_submit', undefined, input.goal), 'queue');
        await this.book.transition(order.id, receipt?.status ?? 'executing', receipt ?? { progress: `Message submitted to ${this.executor}.` });
      } else if (order.kind === 'work_update') {
        if (input.action === 'cancel') {
          const receipt = await this.desktop.cancel(sessionId);
          await this.book.transition(order.id, 'completed', { output: { cancellation_requested: true, conversation_id: sessionId, queued_messages_retained: true, ...receipt } });
        } else {
          location = await this.desktop.checkpoint(sessionId);
          await this.book.transition(order.id, 'dispatching', location);
          startedDelivery = true;
          const receipt = await this.desktop.send(order, location, withDeliveryGuidance('work_update', input.action, input.message), input.action === 'interrupt' ? 'steer' : 'queue');
          await this.book.transition(order.id, receipt?.status ?? 'executing', receipt ?? { progress: `Follow-up submitted to ${this.executor}.` });
        }
      } else {
        const output = order.kind === 'workspace_control' ? await this.desktop.workspaceAction(input)
          : await this.desktop.conversationAction(input);
        await this.book.transition(order.id, 'completed', { output });
      }
    } catch (error) {
      const uncertain = error.deliveryUnknown || startedDelivery && !error.definite;
      await this.book.transition(order.id, uncertain ? 'uncertain' : 'failed', {
        error: error.message, progress: uncertain ? 'Submission outcome is uncertain; automatic replay is disabled.' : error.message,
        // Adapters may already hold a richer failure record (stream text,
        // failure kind, permission denials). Keep it rather than losing detail
        // when delivery itself throws.
        ...(error.output ? { output: error.output } : {}),
      });
    }
  }

  async close() {
    if (!this.closing) {
      this.closed = true;
      this.schedulerStop();
      this.closing = (async () => {
        await this.tail.catch(() => {});
        await this.runtimeWrites;
        try {
          await this.desktop.close?.();
          await this.book.runtime({ protocol: 2, executor: this.executor, active: false, at: new Date().toISOString(), catalog: this.catalog }, this.executor);
        } finally {
          await releaseOrderIndex(this.index);
          this.index = null;
          await this.release?.();
        }
      })();
    }
    return this.closing;
  }

  schedulerStop() {
    if (this.scheduler) {
      clearTimeout(this.scheduler.timer);
      this.scheduler.timer = null;
      this.scheduler = null;
    }
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

// Shared consumer runner used by the lazily started adapters (Hermes, Qoder).
// DSH is hosted by its own desktop plugin instead. The caller only decides
// which adapter instance to create, so lease ownership, reconnect and shutdown
// behave identically for every spawned-CLI executor.
export function startConsumer({
  home, executor, create, activeInterval = 750, idleInterval = 2500,
  heartbeatInterval = 2000, onError = () => {},
}) {
  let consumer;
  let closed = false;
  let timer = null;
  let starting = null;
  let lastError;
  let readySettled = false;
  let settleReady;
  const ready = new Promise(resolve => { settleReady = resolve; });
  const settle = () => {
    if (readySettled) return;
    readySettled = true;
    settleReady(consumer);
  };
  const report = error => {
    if (error.message !== lastError) onError(error);
    lastError = error.message;
  };
  const retry = delay => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void start(); }, delay);
  };
  const start = () => {
    if (closed || consumer || starting) return starting ?? undefined;
    const attempt = (async () => {
      let candidate;
      let opened = false;
      try {
        candidate = new Consumer(home, create(), {
          executor, onError: report, activeInterval, idleInterval, heartbeatInterval,
        });
        await candidate.open();
        opened = true;
        if (closed) { await candidate.close(); settle(); return; }
        consumer = candidate;
        candidate.start({ activeInterval, idleInterval, heartbeatInterval });
        await candidate.tick();
        lastError = null;
        settle();
      } catch (error) {
        // A consumer whose first pass failed still owns the lease and index;
        // close it before retrying so the retry is not blocked by our own lock.
        if (consumer === candidate) consumer = null;
        if (opened) await candidate.close().catch(() => {});
        if (closed) return;
        if (error.code !== 'CONSUMER_BUSY') report(error);
        retry(idleInterval);
        settle();
      }
    })();
    // A factory can throw synchronously; clear the latch on the promise itself
    // so the retry timer is never blocked by a settled attempt.
    starting = attempt.finally(() => { starting = null; });
    return starting;
  };
  retry(0);
  return {
    ready,
    async close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      await starting;
      await consumer?.close();
      settle();
    },
  };
}
