import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrderBook } from './orders.mjs';
import { EXECUTORS } from './executors.mjs';
import { resolveTransport } from './transport.mjs';
import { autoUpdateSetting } from './update-reminder.mjs';

// Board-only update backend. The board never lets a client supply a repository
// path, URL or command: the server updates its own Git checkout, resolves the
// remote from that checkout's origin, and only accepts the official project
// repository. A detached helper performs the long Git/dependency work so the
// MCP HTTP response can answer "updating" long before the caller's 10s limit.
export const UPDATE_STATE_FILE = 'plugin-update.json';
export const UPDATE_LOCK_FILE = 'plugin-update.lock';
export const UPDATE_STATUSES = Object.freeze([
  'idle', 'checking', 'up_to_date', 'available', 'blocked', 'updating', 'updated', 'failed',
]);

const STATE_VERSION = 1;
const OFFICIAL_REPOSITORY = 'heystarlink/codex-to-agents';
const ACTIVE_STATES = new Set(['checking', 'updating']);
const RUNNING_ORDERS = new Set(['queued', 'dispatching', 'executing']);
const LOCK_STALE_MS = 30 * 60 * 1000;
const GIT_TIMEOUT_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 120 * 1000;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_STATE_BYTES = 64 * 1024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const workerEntry = fileURLToPath(new URL('./plugin-update-worker.mjs', import.meta.url));
// Only fields that make sense outside an active operation are carried forward
// when a check/apply starts, so an interrupted helper still explains the last
// real result instead of losing the commit information the board showed.
const CARRIED = ['status', 'current', 'latest', 'branch', 'message', 'reason', 'stage', 'pending_install',
  'restart_required', 'codex_reload_required', 'dsh_reload_required', 'backend_restarted',
  'backend_reload_required', 'dependencies_installed', 'plugin_regenerated', 'running_tasks',
  'running_orders', 'running_sessions',
  'checked_at', 'updated_at', 'finished_at', 'recovery', 'install_error'];

const nowIso = () => new Date().toISOString();
const clean = (value, limit = 300) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
const short = sha => typeof sha === 'string' ? sha.slice(0, 8) : '?';
const statePath = home => join(home, UPDATE_STATE_FILE);
const lockPath = home => join(home, UPDATE_LOCK_FILE);

function dataHome(home) {
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('更新数据目录必须是绝对路径。');
  return resolve(home);
}

function snapshot(value) {
  const output = {};
  for (const key of CARRIED) if (value?.[key] !== undefined) output[key] = value[key];
  return output;
}

class UpdateBlocked extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = 'UpdateBlocked';
    this.reason = reason;
    this.detail = detail;
  }
}

function blocked(reason, message, detail = {}) {
  return new UpdateBlocked(reason, message, detail);
}

function blockedState(error) {
  return {
    version: STATE_VERSION, status: 'blocked', ...error.detail,
    reason: error.reason, message: error.message, checked_at: nowIso(),
  };
}

function failedState({ stage, message, recovery, detail = {} }) {
  return {
    version: STATE_VERSION, status: 'failed', stage, ...detail,
    message, ...(recovery ? { recovery } : {}), finished_at: nowIso(),
  };
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

async function readInstallation(home) {
  let value;
  try { value = JSON.parse(await readFile(join(home, 'plugin-installation.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.codex !== 'string' || !value.codex) return null;
  return value;
}

async function readStateFile(home) {
  const path = statePath(home);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_STATE_BYTES) return { corrupt: true };
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { corrupt: true };
    if (!UPDATE_STATUSES.includes(value.status)) return { corrupt: true };
    if (value.version !== undefined && value.version !== STATE_VERSION) return { corrupt: true };
    return { state: value };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: null };
    if (error instanceof SyntaxError) return { corrupt: true };
    throw error;
  }
}

async function readLock(home) {
  try {
    const info = await lstat(lockPath(home));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return null;
    const value = JSON.parse(await readFile(lockPath(home), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};

// A helper that died without writing a terminal state leaves the cached active
// state behind. Reporting it as interrupted is a local read only; nothing is
// rewritten, so a later check can simply start over.
async function interrupted(home, state) {
  const lock = await readLock(home).catch(() => null);
  if (!lock) return true;
  if (Number.isInteger(state.pid) && !alive(state.pid)) return true;
  if (!alive(lock.pid)) return true;
  const at = Date.parse(lock.at);
  return !Number.isFinite(at) || Date.now() - at > LOCK_STALE_MS;
}

function activeView(state, status, message) {
  return {
    ...snapshot(state.last_result), status,
    ...(message ? { message } : {}),
    ...(state.started_at ? { started_at: state.started_at } : {}),
  };
}

// Local-cache-only status. No Git command, network request or fetch of any kind
// runs here; the board can poll this while hidden and while an update is active.
export async function runPluginUpdate(home, { action, dependencies } = {}) {
  home = dataHome(home);
  if (action === 'status') {
    const { state, corrupt } = await readStateFile(home);
    if (corrupt) return { status: 'idle', message: '更新状态缓存无效，请重新检查更新。' };
    if (!state) return { status: 'idle' };
    if (!ACTIVE_STATES.has(state.status)) return snapshot(state);
    if (await interrupted(home, state)) {
      return {
        ...activeView(state, 'failed'), reason: 'interrupted',
        message: '上一次检查或更新进程已退出，没有完成。本地仓库可能已部分更新（已拉取的代码不会回滚），工作单不受影响。请重新检查更新；若有未完成的安装，应用更新会继续。',
      };
    }
    return activeView(state, state.status);
  }
  if (action === 'check' || action === 'apply') return beginUpdate(home, action, dependencies);
  throw new Error('更新操作只能是 status、check 或 apply。');
}

async function beginUpdate(home, action, dependencies) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const nonce = await claimLock(home, action);
  if (!nonce) {
    const cached = (await readStateFile(home)).state;
    return {
      status: 'blocked', reason: 'busy',
      message: '已有更新操作正在进行，请等待它结束后再试。',
      ...(cached?.current ? { current: cached.current } : {}),
      ...(cached?.latest ? { latest: cached.latest } : {}),
      ...(cached?.branch ? { branch: cached.branch } : {}),
    };
  }
  const active = action === 'check' ? 'checking' : 'updating';
  const carried = (await readStateFile(home)).state;
  const lastResult = carried?.last_result ?? snapshot(carried);
  // Internal tests may force the detached path with a fixture helper; the board
  // never passes dependencies at all.
  if (dependencies && dependencies.detached !== true) {
    // Tests inject fixture paths/installers. The board tool never passes this.
    const state = {
      version: STATE_VERSION, status: active, pid: process.pid, started_at: nowIso(),
      last_result: snapshot(lastResult),
    };
    await atomicJson(statePath(home), state);
    setImmediate(() => {
      void runUpdateJob(home, { action, nonce, dependencies })
        .catch(error => { console.error(`Codex to Agents update job failed: ${error.message}`); });
    });
    return activeView(state, active);
  }
  return spawnHelper(home, action, nonce, lastResult, dependencies?.workerEntry);
}

async function spawnHelper(home, action, nonce, lastResult, entry = workerEntry) {
  const active = action === 'check' ? 'checking' : 'updating';
  // The pending state must exist before the helper: a fast helper can finish a
  // local check in milliseconds, and a later parent write would erase the real
  // result. The helper replaces this state with its own pid when it starts.
  const pending = {
    version: STATE_VERSION, status: active, pid: process.pid, started_at: nowIso(),
    last_result: snapshot(lastResult),
  };
  try { await atomicJson(statePath(home), pending); }
  catch (error) {
    await releaseLock(home, nonce);
    return failedState({
      stage: 'state', message: `无法保存更新状态：${clean(error.message)}。`,
      recovery: '请检查数据目录的磁盘和权限后重试。',
    });
  }
  let child;
  try {
    child = spawn(process.execPath, [entry, home, action], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, CODEX_TO_AGENTS_UPDATE_LOCK: nonce },
    });
  } catch (error) {
    await releaseLock(home, nonce);
    return failedState({ stage: 'start', message: `无法启动更新检查助手：${clean(error.message)}。`, recovery: '请重试；若持续失败，请手动运行 node src/command.mjs plugin-install。' });
  }
  // Only the current lock owner may fail an abandoned helper. The lock nonce
  // check distinguishes a late close event from a newer update that has already
  // claimed the lock and written its own pending state.
  const unfinished = (stage, message) => {
    void finishAbandonedHelper(home, {
      nonce, pids: [child.pid, process.pid, pending.pid], stage, message,
    }).catch(() => {});
  };
  child.on('error', error => unfinished('start', `更新助手启动失败：${clean(error.message)}；没有修改代码。`));
  child.on('close', () => unfinished('interrupted', '更新助手意外退出，更新没有完成。代码可能已部分更新（已拉取的代码不会回滚），工作单不受影响。'));
  child.unref();
  return activeView(pending, active);
}

async function claimLock(home, action) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = randomUUID();
    const value = { version: STATE_VERSION, pid: process.pid, nonce, action, at: nowIso() };
    try {
      await writeFile(lockPath(home), JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      return nonce;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await readLock(home);
      const stale = !current || !alive(current.pid) || !Number.isFinite(Date.parse(current.at))
        || Date.now() - Date.parse(current.at) > LOCK_STALE_MS;
      if (!stale) return null;
      await rm(lockPath(home), { force: true });
    }
  }
  return null;
}

async function releaseLock(home, nonce) {
  const current = await readLock(home).catch(() => null);
  if (current?.nonce === nonce) await rm(lockPath(home), { force: true });
}

// The detached helper takes the lock over with its own pid while keeping the
// spawning parent's nonce. The parent can still release the lock later, and a
// backend restart can no longer make a live helper's lock look dead.
export async function claimHelperLock(home, nonce, action) {
  home = dataHome(home);
  const lock = await readLock(home).catch(() => null);
  if (!lock || lock.nonce !== nonce) return null;
  const value = { version: STATE_VERSION, pid: process.pid, nonce, action, at: lock.at ?? nowIso() };
  try { await atomicJson(lockPath(home), value); }
  catch { return null; }
  return value;
}

// A helper that exits without a terminal state may have been killed after the
// fast-forward (for example during npm ci), so the message never claims the
// checkout is untouched. Only the current lock owner may report it: a stale
// child close event must not rewrite a newer update's pending state.
export async function finishAbandonedHelper(home, { nonce, pids = [], stage, message, recovery }) {
  home = dataHome(home);
  const lock = await readLock(home).catch(() => null);
  if (!lock || lock.nonce !== nonce) return false;
  const current = (await readStateFile(home).catch(() => ({ state: null }))).state;
  const owns = Boolean(current && ACTIVE_STATES.has(current.status) && pids.includes(current.pid));
  if (owns) {
    const last = snapshot(current.last_result);
    await atomicJson(statePath(home), failedState({
      stage, message,
      recovery: recovery ?? '请重新检查更新；若代码已拉取但依赖或插件安装未完成，应用更新会继续安装。',
      detail: {
        current: last.current, latest: last.latest, branch: last.branch,
        ...(last.pending_install ? { pending_install: true } : {}),
      },
    }));
  }
  await releaseLock(home, nonce);
  return owns;
}

// The worker imports this and runs it in its own process. It owns the lock its
// parent claimed (the nonce arrives through the environment) and writes every
// transition to the state file, so the board only ever reads a cache.
export async function runUpdateJob(home, { action, nonce, dependencies } = {}) {
  home = dataHome(home);
  if (action !== 'check' && action !== 'apply') throw new Error('更新助手只处理 check 或 apply。');
  const lock = await claimHelperLock(home, nonce, action);
  if (!lock) return null;
  const active = action === 'check' ? 'checking' : 'updating';
  const cachedState = (await readStateFile(home).catch(() => ({ state: null }))).state;
  const lastResult = cachedState?.last_result ?? snapshot(cachedState);
  const deps = mergeDependencies(dependencies);
  try {
    await atomicJson(statePath(home), {
      version: STATE_VERSION, status: active, pid: process.pid, started_at: nowIso(),
      last_result: snapshot(lastResult),
    });
    const cached = snapshot(cachedState?.last_result ?? cachedState);
    let result = action === 'check'
      ? await checkUpdate(home, deps, cached)
      : await applyUpdate(home, deps, cached);
    // Continue in this helper under the same lock even if the board is hidden
    // or its finite status poll ends before the network check finishes.
    if (action === 'check' && result.status === 'available' && !result.pending_install
        && (await autoUpdateSetting(home)).auto_update) {
      await atomicJson(statePath(home), {
        version: STATE_VERSION, status: 'updating', pid: process.pid,
        started_at: nowIso(), last_result: snapshot(result),
      });
      result = await applyUpdate(home, deps, result);
    }
    await atomicJson(statePath(home), result);
    return result;
  } catch (error) {
    const failure = failedState({
      stage: error.stage ?? 'internal',
      message: `更新失败：${clean(error.message)}。`,
      recovery: '请重新检查更新；若问题持续，请手动运行 node src/command.mjs plugin-install 和 backend restart。',
      detail: { reason: error.reason, ...(error.detail ?? {}) },
    });
    await atomicJson(statePath(home), failure).catch(() => {});
    return failure;
  } finally {
    await releaseLock(home, nonce).catch(() => {});
  }
}

function mergeDependencies(dependencies) {
  return {
    repoRoot: fileURLToPath(new URL('..', import.meta.url)),
    remote: null, node: process.execPath, dshHome: null, find_npm: findNpmCli,
    gitTimeoutMs: GIT_TIMEOUT_MS, fetchTimeoutMs: FETCH_TIMEOUT_MS, installTimeoutMs: INSTALL_TIMEOUT_MS,
    install: installProjectUpdate, restart: restartSharedBackend,
    ...(dependencies ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Git verification. Every command is asynchronous with a hard timeout; a bare
// local fixture may be injected only through the internal dependencies object.
// ---------------------------------------------------------------------------

function git(deps, args, { timeout = deps.gitTimeoutMs, allowFailure = false } = {}) {
  const cwd = resolve(deps.repoRoot);
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      const result = {
        ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '').trim(),
        killed: Boolean(error?.killed), code: error?.code,
      };
      if (!error) return resolvePromise(result);
      if (allowFailure) return resolvePromise(result);
      reject(Object.assign(new Error(result.stderr || error.message), { stage: 'git', code: error.code }));
    });
  });
}

function remoteFailure(result) {
  const detail = clean(result.stderr, 400);
  const offline = result.killed || /could not resolve host|connection refused|failed to connect|network is unreachable|timed out|operation timed out|unable to access|no route to host|temporary failure in name resolution/i.test(detail);
  return offline
    ? blocked('offline', `无法连接远端仓库，请检查网络后重试。${detail ? `（${detail}）` : ''}`)
    : blocked('remote', `无法读取远端仓库：${detail || '未知错误'}。`);
}

export function isOfficialOrigin(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.startsWith('-')) return false;
  let host; let path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url;
    try { url = new URL(text); } catch { return false; }
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return false;
    host = url.hostname;
    path = url.pathname.replace(/^\/+/, '');
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(text);
    if (!scp) return false;
    host = scp[1];
    path = scp[2];
  }
  if (host.toLowerCase() !== 'github.com') return false;
  const normalized = path.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  return normalized === OFFICIAL_REPOSITORY;
}

async function repoRootOf(deps) {
  const requested = resolve(deps.repoRoot);
  let info;
  try { info = await lstat(requested); }
  catch (error) { throw blocked('repo', `找不到当前安装目录：${requested}。`); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw blocked('repo', `当前安装路径不是目录：${requested}。`);
  const top = await git(deps, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!top.ok) throw blocked('repo', '当前安装目录不是 Git 仓库，无法更新。');
  const [root, expected] = await Promise.all([realpath(top.stdout.trim()), realpath(requested)]);
  if (root !== expected) throw blocked('repo', '当前安装目录与 Git 仓库根目录不一致，已停止更新。');
  return root;
}

async function originOf(deps) {
  if (deps.remote !== null && deps.remote !== undefined) {
    if (typeof deps.remote !== 'string' || !deps.remote.trim() || deps.remote.trim().startsWith('-')) {
      throw blocked('origin', '内部远端配置无效，已停止更新。');
    }
    return deps.remote.trim();
  }
  const origin = await git(deps, ['config', '--get', 'remote.origin.url'], { allowFailure: true });
  const value = origin.ok ? origin.stdout.trim() : '';
  if (!isOfficialOrigin(value)) {
    throw blocked('origin', `origin 不是 ${OFFICIAL_REPOSITORY} 官方仓库，已停止更新。`);
  }
  return value;
}

async function packageFingerprints(repoRoot) {
  const digest = async name => {
    try { return createHash('sha256').update(await readFile(join(repoRoot, name))).digest('hex'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  return { package_json: await digest('package.json'), package_lock: await digest('package-lock.json') };
}

// The dependency step needs npm only when the update actually changes the
// dependency files (or node_modules is missing). Compare the pre-merge checkout
// with the tree of the commit that is about to be fast-forwarded so the
// preflight can run BEFORE the working tree moves at all.
async function remotePackageFingerprints(deps, commit) {
  const digest = async name => {
    const shown = await git(deps, ['show', `${commit}:${name}`], { allowFailure: true });
    return shown.ok ? createHash('sha256').update(Buffer.from(shown.stdout, 'utf8')).digest('hex') : null;
  };
  return { package_json: await digest('package.json'), package_lock: await digest('package-lock.json') };
}

async function dependenciesNeeded(deps, verified) {
  if (!await exists(join(verified.repoRoot, 'node_modules'))) return true;
  const remote = await remotePackageFingerprints(deps, verified.latest);
  return remote.package_json !== verified.package.package_json
    || remote.package_lock !== verified.package.package_lock;
}

async function npmPreflight(deps, repoRoot) {
  const detect = typeof deps.find_npm === 'function' ? deps.find_npm : findNpmCli;
  const npmCli = await detect({ node: process.execPath });
  if (!npmCli) {
    throw blocked('npm_missing', '预检失败：找不到可用的 npm（npm-cli.js），因此没有拉取任何代码。请安装 Node.js/npm，或在仓库目录手动运行 npm ci 后重试。');
  }
  const probe = await runCommand(process.execPath, [npmCli, '--version'], { cwd: repoRoot, timeout: 15_000, allowFailure: true });
  if (!probe.ok) {
    throw blocked('npm_unavailable', `预检失败：npm 无法通过当前 Node 运行（${clean(probe.detail, 300)}），因此没有拉取任何代码。请先手动运行 npm ci 后重试。`);
  }
  return npmCli;
}

async function resolveNpmCli(repoRoot) {
  const npmCli = await findNpmCli({ node: process.execPath });
  if (!npmCli) throw new Error('预检失败：找不到可用的 npm（npm-cli.js），无法安装依赖。请在仓库目录手动运行 npm ci 后重试。');
  const probe = await runCommand(process.execPath, [npmCli, '--version'], { cwd: repoRoot, timeout: 15_000, allowFailure: true });
  if (!probe.ok) throw new Error(`预检失败：npm 无法通过当前 Node 运行（${clean(probe.detail, 300)}）。请在仓库目录手动运行 npm ci 后重试。`);
  return npmCli;
}

function withPendingInstall(error, cached) {
  if (!cached?.pending_install) return error;
  return new UpdateBlocked(error.reason, error.message, { ...(error.detail ?? {}), pending_install: true });
}

// Compare the checked-out commit with the remote default branch, which is
// resolved from the remote HEAD symref (never a hard-coded main/master). Fetch
// writes only FETCH_HEAD, so a check cannot move the working tree or refs.
async function inspectRepository(deps) {
  const repoRoot = await repoRootOf(deps);
  const origin = await originOf({ ...deps, repoRoot });
  const symbolic = await git({ ...deps, repoRoot }, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
  const branch = symbolic.ok ? symbolic.stdout.trim() : '';
  if (!branch || !BRANCH.test(branch)) throw blocked('branch', '当前处于 detached HEAD，无法安全更新。请切换到远端默认分支后重试。');
  const head = await git({ ...deps, repoRoot }, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  const current = head.ok ? head.stdout.trim() : '';
  if (!SHA.test(current)) throw blocked('repo', '无法读取当前提交，已停止更新。');
  const status = await git({ ...deps, repoRoot }, ['status', '--porcelain=v1', '--untracked-files=no'], { allowFailure: true });
  if (!status.ok) throw blocked('repo', `无法读取本地修改：${clean(status.stderr) || '未知错误'}。`);
  const changed = status.stdout.split('\n').filter(line => line.trim());
  if (changed.length) {
    throw blocked('dirty', `有 ${changed.length} 个已跟踪文件存在未提交或已暂存修改，已停止更新。请先提交或还原这些修改；看板不会 stash、reset 或强制覆盖。`, { current, branch });
  }
  const listed = await git({ ...deps, repoRoot }, ['ls-remote', '--symref', origin, 'HEAD'], { timeout: deps.fetchTimeoutMs, allowFailure: true });
  if (!listed.ok) throw remoteFailure(listed);
  const symref = listed.stdout.split('\n').map(line => /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line.trim())).find(Boolean);
  const defaultBranch = symref?.[1] ?? '';
  if (!defaultBranch || !BRANCH.test(defaultBranch)) throw blocked('branch', '无法从远端 HEAD 解析默认分支，已停止更新。', { current, branch });
  if (branch !== defaultBranch) {
    throw blocked('branch', `当前分支 ${branch} 不是远端默认分支 ${defaultBranch}，已停止更新。请切回默认分支后重试。`, { current, branch });
  }
  const fetched = await git({ ...deps, repoRoot }, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', origin, `refs/heads/${defaultBranch}`], { timeout: deps.fetchTimeoutMs, allowFailure: true });
  if (!fetched.ok) throw remoteFailure(fetched);
  const headOfFetch = await git({ ...deps, repoRoot }, ['rev-parse', '--verify', 'FETCH_HEAD'], { allowFailure: true });
  const latest = headOfFetch.ok ? headOfFetch.stdout.trim() : '';
  if (!SHA.test(latest)) throw blocked('remote', '无法解析远端提交，已停止更新。', { current, branch });
  const detail = { current, latest, branch };
  if (current === latest) return { status: 'up_to_date', repoRoot, defaultBranch, package: await packageFingerprints(repoRoot), ...detail };
  const ancestor = await git({ ...deps, repoRoot }, ['merge-base', '--is-ancestor', current, latest], { allowFailure: true });
  if (!ancestor.ok) {
    if (ancestor.code === 1) throw blocked('diverged', `本地 ${branch} 与远端分叉（存在远端没有的本地提交），无法 fast-forward，已停止更新。`, detail);
    throw blocked('remote', `无法比较本地与远端提交：${clean(ancestor.stderr) || '未知错误'}。`, detail);
  }
  return { status: 'available', repoRoot, defaultBranch, package: await packageFingerprints(repoRoot), ...detail };
}

async function runningWork(home) {
  const book = new OrderBook(home);
  let orders;
  try { orders = await book.list(); }
  catch (error) {
    if (error.code === 'ENOENT') orders = [];
    else return { count: null, error: clean(error.message) };
  }
  const activeOrders = orders.filter(order => RUNNING_ORDERS.has(order.status));
  const sessions = [];
  // Idle checks must cover every execution end, including Qoder sessions, so an
  // update can never replace code under a running task.
  for (const executor of EXECUTORS) {
    let runtime;
    try { runtime = await book.runtime(null, executor); }
    catch (error) { return { count: null, error: clean(error.message) }; }
    if (!runtime?.online) continue;
    for (const session of runtime.snapshot?.sessions ?? []) {
      if (session?.status === 'running') sessions.push(session.id);
    }
  }
  return { count: activeOrders.length + sessions.length, orders: activeOrders.length, sessions: sessions.length };
}

function runningBlocked(running) {
  if (running.count === null) {
    return blocked('running_check', `无法确认是否仍有任务在运行（${running.error || '工作单读取失败'}），已停止更新。`, { running_unknown: true });
  }
  return blocked('running', `还有 ${running.count} 个任务正在运行，已停止更新。请等待任务结束后重试。`, {
    running_tasks: running.count, running_orders: running.orders, running_sessions: running.sessions,
  });
}

function runningNote(running) {
  if (!Number.isInteger(running.count) || running.count <= 0) return null;
  return `另有 ${running.count} 个任务正在运行，更新前需要先结束这些任务。`;
}

async function checkUpdate(home, deps, cached) {
  let verified;
  try { verified = await inspectRepository(deps); }
  catch (error) {
    if (error instanceof UpdateBlocked) return blockedState(error);
    throw error;
  }
  if (cached?.pending_install && verified.status === 'up_to_date') {
    // Report an actionable update instead of a dead end: the board only enables
    // its apply control for "available", and apply retries the failed install
    // without merging again.
    return {
      version: STATE_VERSION, status: 'available', ...verifiedFields(verified), pending_install: true,
      reason: 'pending_install', checked_at: nowIso(),
      message: '代码已是最新，但上次依赖或本地插件安装尚未完成。请点击「应用更新」重试安装；不会重复拉取代码。',
    };
  }
  const state = verified.status === 'up_to_date'
    ? {
        version: STATE_VERSION, status: 'up_to_date', ...verifiedFields(verified), checked_at: nowIso(),
        message: `已是最新版本：${verified.branch}@${short(verified.latest)}。`,
      }
    : {
        version: STATE_VERSION, status: 'available', ...verifiedFields(verified), checked_at: nowIso(),
        message: `可更新：${verified.branch} ${short(verified.current)} → ${short(verified.latest)}。`,
        ...(cached?.pending_install ? { pending_install: true } : {}),
      };
  const running = await runningWork(home);
  const note = runningNote(running);
  if (note) { state.message += note; state.running_tasks = running.count; }
  if (Number.isInteger(running.count)) state.running_tasks = running.count;
  return state;
}

function verifiedFields(verified) {
  return { current: verified.current, latest: verified.latest, branch: verified.branch };
}

async function applyUpdate(home, deps, cached) {
  const before = await runningWork(home);
  if (before.count !== 0) return blockedState(runningBlocked(before));
  let verified;
  try { verified = await inspectRepository(deps); }
  catch (error) {
    if (error instanceof UpdateBlocked) return blockedState(error);
    throw error;
  }
  // A check the user made earlier must still describe the same repository
  // state. Any movement of HEAD or of the remote branch asks for a new check.
  if (cached?.status === 'available' && cached.current && cached.latest && SHA.test(cached.current) && SHA.test(cached.latest)) {
    if (verified.current !== cached.current) {
      return blockedState(blocked('changed', `当前提交已从 ${short(cached.current)} 变为 ${short(verified.current)}，请重新检查更新。`, verifiedFields(verified)));
    }
    if (verified.latest !== cached.latest) {
      return blockedState(blocked('changed', `远端更新已从 ${short(cached.latest)} 变为 ${short(verified.latest)}，请重新检查更新。`, verifiedFields(verified)));
    }
  }
  if (verified.status === 'up_to_date') {
    if (!cached?.pending_install) {
      return {
        version: STATE_VERSION, status: 'up_to_date', ...verifiedFields(verified), finished_at: nowIso(),
        message: '已是最新版本，没有安装任何更新。',
      };
    }
    let npmCli;
    try { npmCli = await npmPreflight(deps, verified.repoRoot); }
    catch (error) {
      if (error instanceof UpdateBlocked) return blockedState(withPendingInstall(error, cached));
      throw error;
    }
    return finishInstall(home, deps, verified, { merged: false, npmCli });
  }
  // Tasks may have started while the remote was being inspected; a fast-forward
  // must never land under an in-flight native task.
  const during = await runningWork(home);
  if (during.count !== 0) return blockedState(runningBlocked(during));
  // Preflight the dependency step BEFORE the checkout moves: a missing npm must
  // never be discovered after the code was already pulled.
  let npmCli = null;
  try {
    if (await dependenciesNeeded(deps, verified)) npmCli = await npmPreflight(deps, verified.repoRoot);
  } catch (error) {
    if (error instanceof UpdateBlocked) return blockedState(withPendingInstall(error, cached));
    throw error;
  }
  const merge = await git({ ...deps, repoRoot: verified.repoRoot }, ['merge', '--ff-only', '--no-edit', verified.latest], { allowFailure: true, timeout: deps.gitTimeoutMs * 2 });
  if (!merge.ok) {
    const detail = clean(merge.stderr || merge.stdout, 500);
    return failedState({
      stage: 'merge',
      message: `无法 fast-forward 到 ${verified.branch}@${short(verified.latest)}：${detail || 'Git 拒绝了合并'}。没有使用 stash、reset 或强制覆盖。`,
      recovery: '请先处理未跟踪的冲突文件或本地修改，然后重新检查并应用更新。',
      detail: verifiedFields(verified),
    });
  }
  const head = await git({ ...deps, repoRoot: verified.repoRoot }, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  if (!head.ok || head.stdout.trim() !== verified.latest) {
    return failedState({
      stage: 'merge',
      message: 'Git 报告 fast-forward 成功，但当前提交与远端不一致，已停止安装。',
      recovery: '请重新检查更新；若仓库仍不一致，请手动核对本地 Git 状态。',
      detail: verifiedFields(verified),
    });
  }
  return finishInstall(home, deps, verified, { merged: true, npmCli });
}

async function writeProgress(home, fields) {
  const current = (await readStateFile(home).catch(() => ({ state: null }))).state;
  await atomicJson(statePath(home), {
    version: STATE_VERSION, status: 'updating', pid: process.pid,
    started_at: current?.started_at ?? nowIso(),
    last_result: { ...snapshot(current?.last_result), ...fields, status: 'updating' },
  });
}

async function finishInstall(home, deps, verified, { merged, npmCli = null }) {
  // Retrying a failed install must not skip npm ci just because the checkout
  // already points at the same dependency files as the failed attempt.
  const retry = !merged;
  const context = {
    home, repoRoot: verified.repoRoot, branch: verified.branch, dshHome: deps.dshHome,
    previous: verified.package, latest: verified.latest, current: verified.latest, merged, retry,
    force_dependencies: retry, npm_cli: npmCli,
  };
  // Persist "install pending" as soon as the checkout moved. A helper killed
  // during npm ci must leave a state that check turns into a retryable
  // available + pending_install instead of a false up_to_date. Current is the
  // just-merged commit; the pre-merge commit would misreport the checkout.
  const installedFields = { current: verified.latest, latest: verified.latest, branch: verified.branch };
  await writeProgress(home, {
    ...installedFields, pending_install: true,
    message: merged ? '代码已 fast-forward，正在安装依赖与本地插件资源…'
      : '正在重试安装依赖与本地插件资源…',
  }).catch(() => {});
  let installed;
  try {
    installed = await deps.install(context) ?? {};
  } catch (error) {
    return failedState({
      stage: 'install',
      message: `代码已更新到 ${verified.branch}@${short(verified.latest)}，但依赖或本地插件资源安装失败：${clean(error.message)}。代码更新尚未完成安装。`,
      recovery: '修复网络、磁盘或权限问题后再次应用更新以重试安装；不会重复拉取代码。必要时在仓库目录手动运行 npm ci 和 node src/command.mjs plugin-install。',
      detail: { current: verified.latest, latest: verified.latest, branch: verified.branch, pending_install: true, install_error: clean(error.message) },
    });
  }
  await writeProgress(home, {
    ...installedFields, pending_install: false,
    message: installed.dsh_configured
      ? '代码与依赖已更新，正在重启共享后台；DSH 桌面插件需要重启 DSH 后才会载入新代码。'
      : '代码与依赖已更新，正在重启共享后台以载入新代码。',
  }).catch(() => {});
  let restart = {};
  try { restart = await deps.restart(context) ?? {}; }
  catch (error) { restart = { error: clean(error.message) }; }
  return updatedState({ verified, installed, restart });
}

function updatedState({ verified, installed, restart }) {
  const dshReload = Boolean(installed.dsh_configured);
  const backendFailed = Boolean(restart?.error);
  const backendRestarted = Boolean(restart?.backend_restarted);
  const backendWasOnline = restart?.backend_was_online === undefined
    ? backendRestarted || backendFailed : Boolean(restart.backend_was_online);
  const restartRequired = dshReload || backendFailed;
  const message = [
    `已更新到 ${verified.branch}@${short(verified.latest)}。`,
    installed.dependencies_installed ? '依赖已重新安装。' : '依赖未变化，沿用已有安装。',
    installed.plugin_regenerated ? '本地 Codex 插件资源已重新生成。' : '',
    installed.dsh_configured
      ? (installed.dsh_profile_updated ? 'DSH 桌面插件快照已更新，需要重启 DSH 才会载入新代码。' : 'DSH 桌面插件快照未变化。')
      : '',
    backendRestarted ? '共享后台已重启并载入新代码。'
      : backendFailed ? `共享后台未能自动重启（${clean(restart.error)}），请运行 node src/command.mjs backend restart。`
      : backendWasOnline ? '共享后台未重启，新代码将在下次启动后生效。'
      : '共享后台当前未运行，下次启动会载入新代码。',
    dshReload ? 'Codex 看板重新打开即可使用新版本；DSH 需要单独重启。'
      : 'Codex 看板重新打开即可使用新版本；如果仍显示旧内容，请重启 Codex。',
  ].filter(Boolean).join('');
  return {
    version: STATE_VERSION, status: 'updated', current: verified.latest, latest: verified.latest,
    branch: verified.branch, message, restart_required: restartRequired,
    codex_reload_required: false, dsh_reload_required: dshReload,
    backend_restarted: backendRestarted, backend_reload_required: backendFailed,
    dependencies_installed: Boolean(installed.dependencies_installed),
    plugin_regenerated: Boolean(installed.plugin_regenerated),
    pending_install: false, finished_at: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Default install/reload steps. They reuse the existing installer helpers so
// update never grows a second copy of the plugin setup: npm dependencies,
// generated local Codex plugin resources, and the DSH extension snapshot.
// ---------------------------------------------------------------------------

function runCommand(command, args, { cwd, timeout, allowFailure = false }) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      cwd, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    }, (error, stdout, stderr) => {
      const detail = error ? clean(stderr || stdout || error.message, 1000) : '';
      if (error && !allowFailure) {
        reject(Object.assign(new Error(detail || `${command} 执行失败。`), { stage: 'install' }));
        return;
      }
      resolvePromise({ ok: !error, stdout, stderr, detail });
    });
  });
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function installProjectUpdate({ home, repoRoot, previous, latest, force_dependencies, dshHome, npm_cli }, {
  root, register, runCodex, prepareDshExtension: prepareExtension,
} = {}) {
  const current = await packageFingerprints(repoRoot);
  const changed = current.package_json !== previous?.package_json || current.package_lock !== previous?.package_lock;
  const dependenciesInstalled = Boolean(force_dependencies) || changed || !await exists(join(repoRoot, 'node_modules'));
  if (dependenciesInstalled) {
    // Run the npm CLI through this Node executable. The shared background may
    // not inherit a user shell PATH, so a bare "npm" (whose shebang also needs
    // node on PATH) is not dependable; apply already preflighted before merge.
    const npmCli = npm_cli ?? await resolveNpmCli(repoRoot);
    await runCommand(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], { cwd: repoRoot, timeout: INSTALL_TIMEOUT_MS });
  }
  const [{ preparePlugin }, { prepareDshExtension, registerMcp, codex: runCodexCommand }] = await Promise.all([
    import('./plugin.mjs'), import('./command.mjs'),
  ]);
  // An upgrade must not leave the board and the dispatch endpoint on different
  // transports: both use the saved/default choice, and the model entry is
  // re-registered through the Codex executable recorded by plugin-install.
  const transport = await resolveTransport(home);
  const installation = await readInstallation(home);
  const executable = installation?.codex ?? 'codex';
  const plugin = await preparePlugin(home, { transport, ...(root ? { root } : {}) });
  await (register ?? registerMcp)(home, executable, transport);
  // Regenerating the source marketplace alone does not refresh the copy Codex
  // already installed. Re-run the same CLI install steps so the cached plugin
  // manifest picks up the selected transport too.
  const invoke = runCodex ?? runCodexCommand;
  await invoke(['plugin', 'marketplace', 'add', plugin.root], executable);
  await invoke(['plugin', 'add', plugin.selector], executable);
  const module = prepareExtension ? await prepareExtension() : await prepareDshExtension();
  const dsh = await refreshDshProfile(home, module, {
    dshHome: dshHome ? resolve(dshHome) : join(homedir(), '.dsh'),
  });
  return {
    dependencies_installed: dependenciesInstalled, dependencies_reused: !dependenciesInstalled,
    plugin_regenerated: true, plugin_selector: plugin.selector,
    dsh_extension_snapshot: module, dsh_configured: dsh.configured, dsh_profile_updated: dsh.updated,
    latest,
  };
}

// Locate npm-cli.js without trusting the background process PATH. The CLI is
// always executed through the current Node executable, which also fixes the
// "#!/usr/bin/env node" lookup that fails when node is not on PATH.
export async function findNpmCli({ node = process.execPath, env = process.env } = {}) {
  const candidates = [];
  const push = value => { if (typeof value === 'string' && value) candidates.push(value); };
  if (typeof env.npm_execpath === 'string' && /npm-cli\.js$/i.test(env.npm_execpath)) push(env.npm_execpath);
  const bin = dirname(node);
  push(join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  push(join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  push(join(bin, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const entry of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!entry) continue;
    try {
      const resolved = await realpath(join(entry, process.platform === 'win32' ? 'npm.cmd' : 'npm'));
      if (/[\\/]npm[\\/]bin[\\/]npm-cli\.js$/i.test(resolved)) push(resolved);
    } catch { /* npm is not on this PATH entry */ }
  }
  for (const known of ['/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js']) push(known);
  // The desktop app may start the background without the shell's nvm PATH.
  try {
    const versions = await readdir(join(homedir(), '.nvm', 'versions', 'node'));
    versions.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of versions) push(join(homedir(), '.nvm', 'versions', 'node', version, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  } catch { /* no nvm installation */ }
  for (const candidate of candidates) {
    try { if ((await lstat(candidate)).isFile()) return resolve(candidate); }
    catch { /* keep looking */ }
  }
  return null;
}

// The desktop plugin is loaded from a content-addressed runtime directory, so a
// new snapshot takes effect only after the Cordis profile's own node points at
// it. Rewrite just that node's "name" scalar: each profile's home, providers,
// defaultDirectory, comments and every other YAML byte stay untouched, and a
// profile belonging to another data home is never read as a target. DSH may
// wrap a long module path in a double-quoted YAML scalar with a trailing
// backslash, so the whole multi-line scalar span is replaced at once.
export async function refreshDshProfile(home, module, { dshHome = join(homedir(), '.dsh') } = {}) {
  const profilesRoot = join(resolve(dshHome), 'profiles');
  let profiles;
  try { profiles = await readdir(profilesRoot); }
  catch (error) { if (error.code === 'ENOENT') return { configured: false, updated: false }; throw error; }
  const replacement = JSON.stringify(resolve(module));
  let configured = false;
  // Validate every target profile before writing any of them: an unrecognized
  // scalar must leave all files untouched instead of partially rewiring one.
  const pending = [];
  for (const name of profiles) {
    const file = join(profilesRoot, name, 'cordis.patch.yml');
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!text.includes('codex-to-agents-desktop')) continue;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    let matched = false; let changed = false;
    for (const block of ourNodeBlocks(lines).reverse()) {
      const homeField = fieldIn(lines, block, 'home');
      const homeValue = homeField ? yamlScalar(homeField.raw) : null;
      if (!homeValue || !await samePath(homeValue, home)) continue;
      matched = true;
      const nameField = fieldIn(lines, block, 'name');
      const rewrite = nameField ? rewriteNameScalar(lines, nameField.index, replacement) : null;
      if (!rewrite) {
        throw Object.assign(new Error(`无法安全识别 DSH profile ${file} 的 name 模块路径，已停止更新且未修改任何配置。`), { stage: 'dsh-profile' });
      }
      if (rewrite.changed) changed = true;
    }
    if (matched) configured = true;
    if (changed) pending.push({ file, text: lines.join(eol) });
  }
  await Promise.all(pending.map(({ file, text }) => writeFile(file, text)));
  return { configured, updated: pending.length > 0 };
}

// Rewrite the name scalar beginning at `index`. Returns null when the span
// cannot be identified safely; the caller then fails without writing anything.
function rewriteNameScalar(lines, index, replacement) {
  const match = /^([ \t]*name:[ \t]*)(.*)$/.exec(lines[index]);
  if (!match) return null;
  const prefix = match[1];
  const value = match[2];
  const write = (suffix, count = 1) => {
    const next = prefix + replacement + suffix;
    if (count === 1) {
      if (next === lines[index]) return { changed: false };
      lines[index] = next;
      return { changed: true };
    }
    lines.splice(index, count, next);
    return { changed: true };
  };
  if (value.startsWith('"')) {
    const quoted = /^"(?:[^"\\]|\\.)*"([ \t]*(?:#.*)?)$/.exec(value);
    if (quoted) return write(quoted[1]);
    const folded = foldedDoubleQuotedScalar(lines, index, prefix.length);
    return folded ? write(folded.suffix, folded.count) : null;
  }
  if (value.startsWith("'")) {
    const quoted = /^'(?:[^']|'')*'([ \t]*(?:#.*)?)$/.exec(value);
    return quoted ? write(quoted[1]) : null;
  }
  const plain = /^[^#\s]+([ \t]*(?:#.*)?)$/.exec(value);
  return plain ? write(plain[1]) : null;
}

// Scan DSH's folded double-quoted form: a backslash at the end of a line folds
// the break, and the continuation line's indentation is not part of the value.
// Only this exact form is treated as safely rewritable.
function foldedDoubleQuotedScalar(lines, index, valueAt) {
  let lineIndex = index;
  let line = lines[index].slice(valueAt);
  let position = 1;
  while (true) {
    while (position < line.length) {
      const char = line[position];
      if (char === '\\') {
        if (position === line.length - 1) {
          lineIndex++;
          if (lineIndex >= lines.length) return null;
          line = lines[lineIndex];
          position = 0;
          while (position < line.length && (line[position] === ' ' || line[position] === '\t')) position++;
          continue;
        }
        position += 2;
        continue;
      }
      if (char === '"') {
        const suffix = line.slice(position + 1);
        if (!/^[ \t]*(?:#.*)?$/.test(suffix)) return null;
        return { count: lineIndex - index + 1, suffix };
      }
      position++;
    }
    return null;
  }
}

const OWN_NODE_LINE = /^([ \t]*)-[ \t]+id:[ \t]*(?:"codex-to-agents-desktop"|'codex-to-agents-desktop'|codex-to-agents-desktop)[ \t]*(?:#.*)?$/;

function ourNodeBlocks(lines) {
  const blocks = [];
  for (let index = 0; index < lines.length; index++) {
    const match = OWN_NODE_LINE.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    let end = lines.length;
    for (let position = index + 1; position < lines.length; position++) {
      const line = lines[position];
      if (!line.trim()) continue;
      if (line.match(/^[ \t]*/)[0].length <= indent) { end = position; break; }
    }
    blocks.push({ start: index, end });
    index = end - 1;
  }
  return blocks;
}

function fieldIn(lines, { start, end }, field) {
  const pattern = new RegExp(`^([ \\t]*)${field}:[ \\t]*(.*)$`);
  for (let index = start + 1; index < end; index++) {
    const match = pattern.exec(lines[index]);
    if (match) return { index, indent: match[1].length, raw: match[2] };
  }
  return null;
}

function yamlScalar(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (value.startsWith('"')) {
    let escaped = false; let end = -1;
    for (let index = 1; index < value.length; index++) {
      const char = value[index];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') { end = index; break; }
    }
    if (end < 0) return null;
    try { return JSON.parse(value.slice(0, end + 1)); } catch { return null; }
  }
  if (value.startsWith("'")) {
    let end = -1;
    for (let index = 1; index < value.length; index++) {
      if (value[index] !== "'") continue;
      if (value[index + 1] === "'") { index++; continue; }
      end = index; break;
    }
    if (end < 0) return null;
    return value.slice(1, end).replaceAll("''", "'");
  }
  return value.replace(/[ \t]+#.*$/, '').trim() || null;
}

async function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalize = async value => {
    const resolved = resolve(value);
    try { return await realpath(resolved); } catch { return resolved; }
  };
  const [one, two] = await Promise.all([normalize(left), normalize(right)]);
  return one === two;
}

async function restartSharedBackend({ home }) {
  const { backendStatus, stopBackend, ensureBackend } = await import('./backend-control.mjs');
  const before = await backendStatus(home).catch(() => ({ online: false }));
  if (!before.online) return { backend_was_online: false, backend_restarted: false };
  await stopBackend(home);
  await ensureBackend(home);
  return { backend_was_online: true, backend_restarted: true };
}
