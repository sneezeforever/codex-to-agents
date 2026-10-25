import { watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { OrderBook } from './orders.mjs';
import { TERMINAL, subscribeOrderChanges } from './order-cache.mjs';

// Model-facing observation helpers. Both stay deliberately small: the default
// inspection view must never hand a whole history body to the caller, and a
// wait must observe one order without acquiring or rebuilding the shared index.
export const WAIT_DEFAULT_TIMEOUT_MS = 45000;
export const WAIT_MAX_TIMEOUT_MS = 55000;
// A single-order fallback read is only insurance against a missed native file
// event (for example a network filesystem); it is not history polling.
const WAIT_POLL_INTERVAL_MS = 1000;
const PROGRESS_LIMIT = 300;
const ERROR_LIMIT = 500;
const RESULT_LIMIT = 600;
const TRUNCATION_MARK = '… [truncated; call work_inspect with view:"detail" for the full record]';
export const DETAIL_HINT = 'The default view is a bounded summary. Call work_inspect with view:"detail" for the complete events/output record.';

function clean(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

// progress lines grow by appending, so keep the most recent tail; an error and
// a final result are usually explained at their beginning.
function bounded(value, limit, { tail = false } = {}) {
  const text = clean(value);
  if (text.length <= limit) return { text, truncated: false };
  return { text: (tail ? text.slice(-limit) : text.slice(0, limit)) + TRUNCATION_MARK, truncated: true };
}

function resultText(output) {
  if (typeof output === 'string') return output;
  if (!output || typeof output !== 'object') return '';
  for (const key of ['text', 'summary', 'message']) {
    if (typeof output[key] === 'string') return output[key];
  }
  return '';
}

// A bounded projection for model-facing reads. Historical events, goal, native
// usage and the model catalog stay on disk / in runtime_info; only short status
// evidence is returned here so following a task does not repeat large context.
export function summarizeOrder(state, worker = null) {
  const progress = bounded(state?.progress, PROGRESS_LIMIT, { tail: true });
  const error = bounded(state?.error, ERROR_LIMIT);
  const result = bounded(resultText(state?.output), RESULT_LIMIT);
  return {
    order_id: state?.order_id,
    kind: state?.kind,
    executor: state?.executor,
    status: state?.status ?? 'queued',
    created_at: state?.created_at ?? null,
    updated_at: state?.updated_at ?? null,
    conversation_id: state?.conversation_id ?? null,
    ...(progress.text ? { progress: progress.text } : {}),
    ...(error.text ? { error: error.text } : {}),
    ...(result.text ? { result: result.text } : {}),
    truncated: progress.truncated || error.truncated || result.truncated,
    detail_hint: DETAIL_HINT,
    worker: { online: Boolean(worker?.online) },
  };
}

// Recent-order listing only needs liveness, not the cached model catalogs that
// runtime_info already serves on demand.
export function compactRuntimes(runtimes) {
  const executors = Object.fromEntries(Object.entries(runtimes?.executors ?? {})
    .map(([name, value]) => [name, { online: Boolean(value?.online) }]));
  return { online: Boolean(runtimes?.online), executors };
}

const aborted = () => Object.assign(new Error('work_wait was cancelled before the work order reached a result.'), { name: 'AbortError' });

// One long-lived observer belongs to one MCP connection. Each wait owns its own
// subscription, file watcher and timers, so several callers can wait on the
// same (or different) orders and one cancellation never affects the others.
export class OrderObserver {
  constructor(home, { pollInterval = WAIT_POLL_INTERVAL_MS } = {}) {
    this.home = resolve(home);
    this.book = new OrderBook(this.home);
    this.pollInterval = Math.max(50, pollInterval);
    this.waits = new Set();
    this.closed = false;
  }

  get pending() { return this.waits.size; }

  wait(orderId, { timeoutMs = WAIT_DEFAULT_TIMEOUT_MS, signal } = {}) {
    if (this.closed) return Promise.reject(aborted());
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > WAIT_MAX_TIMEOUT_MS) {
      return Promise.reject(new Error(`timeout_ms must be an integer between 0 and ${WAIT_MAX_TIMEOUT_MS}.`));
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const wait = new OrderWait(this, orderId, {
        timeoutMs, signal, resolve: resolvePromise, reject: rejectPromise,
      });
      this.waits.add(wait);
      try { wait.start(); }
      catch (error) { wait.fail(error); }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const wait of [...this.waits]) wait.abort();
    this.waits.clear();
  }
}

class OrderWait {
  constructor(observer, orderId, { timeoutMs, signal, resolve: resolvePromise, reject: rejectPromise }) {
    this.observer = observer;
    this.id = orderId;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.resolve = resolvePromise;
    this.reject = rejectPromise;
    this.done = false;
    this.reading = false;
    this.again = false;
    this.timedOut = timeoutMs === 0;
    // The request half of a work order is immutable once saved; cache it so a
    // wait that sees several progress rewrites re-reads only this order's state.
    this.request = null;
    this.currentStatus = null;
    this.unsubscribe = null;
    this.watcher = null;
    this.pollTimer = null;
    this.timeoutTimer = null;
    this.immediate = null;
    this.abortListener = null;
    this.deadline = Date.now() + timeoutMs;
  }

  start() {
    // Install every notification path BEFORE the first read: a transition
    // between the read and the watchers would otherwise be lost until the
    // fallback poll, and an already-terminal order would still be reported late.
    this.unsubscribe = subscribeOrderChanges(this.observer.home, event => {
      if (this.done) return;
      if (event?.id !== this.id && !event?.ids?.includes?.(this.id)) return;
      // Same-process notifications carry the new status. A progress-only
      // rewrite keeps the status, so it must not wake the waiter or add reads;
      // only a real transition (or a first observation) schedules a check.
      const next = event.state?.status;
      if (next && next === this.currentStatus && !TERMINAL.has(next) && next !== 'uncertain') return;
      this.schedule();
    });
    this.watchStates();
    if (this.signal) {
      if (this.signal.aborted) { this.abort(); return; }
      this.abortListener = () => this.abort();
      this.signal.addEventListener('abort', this.abortListener, { once: true });
    }
    // These timers are intentionally referenced: an in-flight wait must keep
    // its bounded process alive instead of having the host exit while a caller
    // still awaits the result. Every exit path clears them in cleanup().
    if (this.timeoutMs > 0) {
      this.timeoutTimer = setTimeout(() => { this.timedOut = true; this.schedule(); }, this.timeoutMs);
    }
    this.pollTimer = setInterval(() => this.schedule(), this.observer.pollInterval);
    void this.evaluate();
  }

  watchStates() {
    try {
      this.watcher = watch(join(this.observer.home, 'states'), { persistent: false }, (_type, filename) => {
        if (filename?.toString?.() === `${this.id}.json`) this.schedule();
      });
      this.watcher.on('error', () => this.closeWatcher());
    } catch (error) {
      // Missing directories are covered by the bounded fallback poll.
      if (error.code !== 'ENOENT') throw error;
    }
  }

  schedule() {
    if (this.done || this.immediate) return;
    this.immediate = setImmediate(() => {
      this.immediate = null;
      void this.evaluate();
    });
  }

  async evaluate() {
    if (this.done) return;
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    let state;
    try {
      // Single-order reads only: this id's request (once) and state file, never
      // the shared history index.
      state = await this.readOrder();
    } catch (error) {
      this.reading = false;
      this.fail(error);
      return;
    }
    this.reading = false;
    if (this.done) return;
    this.currentStatus = state.status;
    if (TERMINAL.has(state.status)) { void this.finish(state, false); return; }
    // An uncertain delivery needs a human decision; waiting longer cannot make
    // it terminal, so surface it immediately instead of blocking until timeout.
    if (state.status === 'uncertain') { void this.finish(state, false, true); return; }
    // A queued/executing order is not complete just because its executor is
    // offline, and a timeout never turns into success or cancellation.
    if (this.timedOut || Date.now() >= this.deadline) { void this.finish(state, true); return; }
    if (this.again) { this.again = false; this.schedule(); }
  }

  async readOrder() {
    if (!this.request) {
      const request = await this.observer.book.request(this.id);
      if (!request) throw new Error('Work order not found.');
      this.request = request;
    }
    const state = await this.observer.book.state(this.id);
    return {
      order_id: this.id,
      kind: this.request.kind,
      executor: this.request.payload.executor ?? 'dsh',
      created_at: this.request.created_at,
      ...(state ?? { status: 'queued', events: [] }),
    };
  }

  async finish(state, timedOut, needsAttention = false) {
    if (this.done) return;
    this.done = true;
    this.cleanup();
    // Liveness is advisory only and is read once, when the wait settles.
    const worker = await this.observer.book.runtime(null, state.executor).catch(() => null);
    this.resolve({
      ...summarizeOrder(state, worker),
      timed_out: timedOut,
      ...(needsAttention ? { needs_attention: true } : {}),
    });
  }

  fail(error) {
    if (this.done) return;
    this.done = true;
    this.cleanup();
    this.reject(error);
  }

  abort() {
    if (this.done) return;
    this.done = true;
    this.cleanup();
    this.reject(aborted());
  }

  closeWatcher() {
    if (!this.watcher) return;
    try { this.watcher.close(); } catch { /* already closed */ }
    this.watcher = null;
  }

  // Every exit path (terminal, timeout, uncertain, not-found, abort, server
  // close) funnels through here so no watcher, timer, listener or observer slot
  // outlives the request.
  cleanup() {
    this.observer.waits.delete(this);
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    this.closeWatcher();
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
    if (this.immediate) { clearImmediate(this.immediate); this.immediate = null; }
    if (this.abortListener && this.signal) {
      this.signal.removeEventListener('abort', this.abortListener);
      this.abortListener = null;
    }
  }
}
