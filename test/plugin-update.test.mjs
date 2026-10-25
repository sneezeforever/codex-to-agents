import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OrderBook } from '../src/orders.mjs';
import { stopBackend } from '../src/backend-control.mjs';
import { preparePlugin } from '../src/plugin.mjs';
import { saveTransport } from '../src/transport.mjs';
import { runBoardUpdate } from '../src/update-reminder.mjs';
import { claimHelperLock, findNpmCli, finishAbandonedHelper, installProjectUpdate, isOfficialOrigin, refreshDshProfile, runPluginUpdate, UPDATE_LOCK_FILE, UPDATE_STATE_FILE } from '../src/plugin-update.mjs';

// Every fixture is a temporary bare repository plus a clone. Nothing here can
// touch the real checkout: the updater only ever receives injected fixture
// paths, and install/reload are replaced by recorders so no npm ci, installer or
// application restart runs during the test.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
};
const git = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, env: GIT_ENV }, (error, stdout, stderr) => {
    if (error) reject(new Error(`git ${args.join(' ')}: ${(stderr || error.message).trim()}`));
    else resolve(String(stdout).trim());
  });
});

const start = (home, action, dependencies) => runPluginUpdate(home, { action, dependencies });
const status = home => runPluginUpdate(home, { action: 'status' });

const fixtureCli = fileURLToPath(new URL('./fixtures/codex-cli.mjs', import.meta.url));
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

// The updater invokes the Codex executable recorded by plugin-install. Point
// that record at an isolated fixture so the real CLI, user config and plugin
// cache are never touched.
async function fakeCodex(root) {
  const executable = join(root, 'recorded-codex');
  await writeFile(executable,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixtureCli)} "$@"\n`, { mode: 0o755 });
  return executable;
}

function runFixture(executable, args) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { env: process.env, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(stdout);
    });
  });
}

async function isolateCodex(t, root) {
  const previous = Object.fromEntries(['HOME', 'CODEX_HOME'].map(name => [name, process.env[name]]));
  const home = join(root, 'isolated-home');
  const codexHome = join(home, '.codex');
  await mkdir(codexHome, { recursive: true });
  process.env.HOME = home;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return codexHome;
}

async function boardMode(path) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  return manifest.mcpServers.agents_board.command ? 'stdio' : 'http';
}

async function check(home, dependencies) {
  const started = await start(home, 'check', dependencies);
  assert.equal(started.status, 'checking');
  return settle(home);
}

async function settle(home, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await status(home);
    if (!['checking', 'updating'].includes(state.status)) {
      // A terminal state is written just before the helper releases its lock.
      // Wait for that release before the fixture starts its next operation.
      try { await access(join(home, UPDATE_LOCK_FILE)); }
      catch (error) { if (error.code === 'ENOENT') return state;throw error; }
    }
    if (Date.now() >= deadline) throw new Error(`update did not settle: ${JSON.stringify(state)}`);
    await delay(15);
  }
}

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'cta-plugin-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = join(root, 'origin.git');
  const source = join(root, 'source');
  const install = join(root, 'install');
  const home = join(root, 'home');
  await git(root, ['init', '--bare', '--initial-branch=main', bare]);
  await git(root, ['init', '--initial-branch=main', source]);
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@yichen/codex-to-agents', version: '0.0.0' }, null, 2));
  await writeFile(join(source, 'package-lock.json'), JSON.stringify({ name: '@yichen/codex-to-agents', lockfileVersion: 3, packages: {} }, null, 2));
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'src', 'base.txt'), 'base\n');
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-m', 'initial']);
  await git(source, ['remote', 'add', 'origin', bare]);
  await git(source, ['push', '-u', 'origin', 'main']);
  await git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(root, ['clone', '--quiet', bare, install]);
  const npmCli = join(root, 'fake-npm-cli.js');
  await writeFile(npmCli, "process.stdout.write('10.9.7\\n');\n");
  const commit = async (files, message = 'change') => {
    for (const [name, content] of Object.entries(files)) {
      const path = join(source, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    await git(source, ['add', '-A']);
    await git(source, ['commit', '-m', message]);
    await git(source, ['push', 'origin', 'main']);
    return git(source, ['rev-parse', 'HEAD']);
  };
  const dependencies = (overrides = {}) => ({
    repoRoot: install, remote: bare, find_npm: async () => npmCli,
    async install() { return { dependencies_installed: true, plugin_regenerated: true }; },
    async restart() { return { backend_was_online: false, backend_restarted: false }; },
    ...overrides,
  });
  return {
    root, bare, source, install, home, npmCli, commit, dependencies,
    head: () => git(install, ['rev-parse', 'HEAD']),
    tracked: () => git(install, ['status', '--porcelain', '--untracked-files=no']),
  };
}

test('status reads only the local cache and check reports up_to_date without installing', async t => {
  const repo = await repository(t);
  assert.deepEqual(await status(repo.home), { status: 'idle' });
  await assert.rejects(access(repo.home), { code: 'ENOENT' }, 'status must not create the data directory');

  const before = await repo.head();
  const checked = await start(repo.home, 'check', repo.dependencies());
  assert.equal(checked.status, 'checking');
  const result = await settle(repo.home);
  assert.equal(result.status, 'up_to_date');
  assert.equal(result.current, before);
  assert.equal(result.latest, before);
  assert.equal(result.branch, 'main');
  assert.match(result.message, /已是最新版本/);
  assert.equal(await repo.head(), before, 'a check never changes the checkout');
  assert.equal(await repo.tracked(), '', 'a check never dirties the checkout');

  assert.deepEqual(await status(repo.home), { ...result }, 'status returns the cached check result');

  const calls = [];
  const applying = await start(repo.home, 'apply', repo.dependencies({
    install: async () => { calls.push('install'); },
    restart: async () => { calls.push('restart'); },
  }));
  assert.equal(applying.status, 'updating');
  const applied = await settle(repo.home);
  assert.equal(applied.status, 'up_to_date');
  assert.deepEqual(calls, [], 'no install runs when there is nothing new');
  assert.match(applied.message, /没有安装任何更新/);
});

test('an available update fast-forwards, keeps untracked SDD documents and preserves settings', async t => {
  const repo = await repository(t);
  const install = await realpath(repo.install);
  const sdd = join(repo.install, 'My_TEMP_TASK', 'project', 'task.md');
  await mkdir(dirname(sdd), { recursive: true });
  await writeFile(sdd, '# 任务约定\n\n未跟踪的 SDD 文档。\n');
  await mkdir(repo.home, { recursive: true });
  const settings = '{\n  "providers": ["deepseek-account"]\n}\n';
  await writeFile(join(repo.home, 'settings.json'), settings);
  const latest = await repo.commit({ 'src/feature.txt': 'fast-forwarded\n' }, 'add feature');

  await start(repo.home, 'check', repo.dependencies());
  const available = await settle(repo.home);
  assert.equal(available.status, 'available');
  assert.equal(available.latest, latest);
  assert.notEqual(available.current, latest);
  assert.equal(available.branch, 'main');
  assert.match(available.message, /可更新/);

  const installs = []; const restarts = [];
  const applying = await start(repo.home, 'apply', repo.dependencies({
    install: async context => {
      installs.push(context);
      return { dependencies_installed: true, plugin_regenerated: true };
    },
    restart: async context => {
      restarts.push(context);
      return { backend_was_online: true, backend_restarted: true };
    },
  }));
  assert.equal(applying.status, 'updating');
  const updated = await settle(repo.home);
  assert.equal(updated.status, 'updated');
  assert.equal(updated.current, latest);
  assert.equal(updated.latest, latest);
  assert.equal(updated.branch, 'main');
  assert.equal(updated.dependencies_installed, true);
  assert.equal(updated.plugin_regenerated, true);
  assert.equal(updated.backend_restarted, true);
  assert.equal(updated.pending_install, false);
  assert.equal(updated.restart_required, false, 'no desktop extension needs a reload in this fixture');
  assert.match(updated.message, /已更新到 main@/);
  assert.match(updated.message, /共享后台已重启/);
  assert.equal(installs.length, 1);
  assert.equal(restarts.length, 1);
  assert.equal(installs[0].repoRoot, install);
  assert.equal(installs[0].branch, 'main');
  assert.equal(installs[0].latest, latest);
  assert.equal(installs[0].current, latest);
  assert.equal(installs[0].merged, true);
  assert.equal(installs[0].retry, false);
  assert.match(installs[0].previous.package_json, /^[a-f0-9]{64}$/, 'the pre-update package fingerprint is captured');
  assert.match(installs[0].previous.package_lock, /^[a-f0-9]{64}$/);
  assert.equal(await repo.head(), latest);
  assert.equal(await readFile(join(repo.install, 'src', 'feature.txt'), 'utf8'), 'fast-forwarded\n');
  assert.equal(await readFile(sdd, 'utf8'), '# 任务约定\n\n未跟踪的 SDD 文档。\n', 'untracked SDD documents are never removed');
  assert.equal(await readFile(join(repo.home, 'settings.json'), 'utf8'), settings, 'installation settings are untouched');
  assert.equal(await repo.tracked(), '');
  assert.equal((await status(repo.home)).status, 'updated');

  await start(repo.home, 'check', repo.dependencies());
  assert.equal((await settle(repo.home)).status, 'up_to_date');
});

test('tracked and staged modifications block check and apply', async t => {
  const repo = await repository(t);
  const before = await repo.head();
  const latest = await repo.commit({ 'src/feature.txt': 'hello\n' });

  await writeFile(join(repo.install, 'package.json'), '{"name":"modified"}\n');
  let state = await check(repo.home, repo.dependencies());
  assert.equal(state.status, 'blocked');
  assert.equal(state.reason, 'dirty');
  assert.equal(state.current, before);
  assert.match(state.message, /已跟踪文件/);
  assert.match(state.message, /不会 stash/);

  await git(repo.install, ['checkout', '--', 'package.json']);
  await writeFile(join(repo.install, 'package.json'), '{"name":"staged"}\n');
  await git(repo.install, ['add', 'package.json']);
  state = await check(repo.home, repo.dependencies());
  assert.equal(state.status, 'blocked');
  assert.equal(state.reason, 'dirty');

  const installs = [];
  await start(repo.home, 'apply', repo.dependencies({ install: async () => { installs.push(1); } }));
  const applied = await settle(repo.home);
  assert.equal(applied.status, 'blocked');
  assert.equal(applied.reason, 'dirty');
  assert.deepEqual(installs, []);
  assert.equal(await repo.head(), before, 'a blocked update leaves the checkout alone');
  assert.notEqual(await repo.head(), latest);
});

test('diverged history cannot be fast-forwarded', async t => {
  const repo = await repository(t);
  await writeFile(join(repo.install, 'src', 'local.txt'), 'local commit\n');
  await git(repo.install, ['add', 'src/local.txt']);
  await git(repo.install, ['commit', '-m', 'local only']);
  const local = await repo.head();
  await repo.commit({ 'src/remote.txt': 'remote commit\n' }, 'remote only');

  const state = await check(repo.home, repo.dependencies());
  assert.equal(state.status, 'blocked');
  assert.equal(state.reason, 'diverged');
  assert.match(state.message, /分叉/);
  assert.equal(state.current, local);
  assert.equal(await repo.head(), local, 'the local commit is never reset');
});

test('a branch other than the remote default branch is refused', async t => {
  const repo = await repository(t);
  await git(repo.install, ['checkout', '-b', 'feature/update']);
  await repo.commit({ 'src/remote.txt': 'remote\n' }, 'remote work');

  const state = await check(repo.home, repo.dependencies());
  assert.equal(state.status, 'blocked');
  assert.equal(state.reason, 'branch');
  assert.equal(state.branch, 'feature/update');
  assert.match(state.message, /feature\/update/);
  assert.match(state.message, /main/);
});

test('official origin accepts the current and legacy repository identifiers', () => {
  for (const owner of ['sneezeforever', 'heystarlink']) {
    for (const value of [
      `git@github.com:${owner}/codex-to-agents.git`,
      `git@github.com:${owner}/codex-to-agents`,
      `https://github.com/${owner}/codex-to-agents.git`,
      `https://github.com/${owner}/codex-to-agents`,
      `ssh://git@github.com/${owner}/codex-to-agents.git`,
      `ssh://git@github.com/${owner}/codex-to-agents`,
    ]) assert.equal(isOfficialOrigin(value), true, value);
  }
  for (const value of [
    // Other owners and repositories, including the other repository under an
    // official owner, stay rejected.
    'git@github.com:someone/codex-to-agents.git',
    'https://github.com/other/codex-to-agents',
    'https://github.com/heystarlink/another.git',
    'https://github.com/sneezeforever/another.git',
    // Look-alike hosts, embedded credentials and other hosts are not trusted.
    'https://gitlab.com/heystarlink/codex-to-agents.git',
    'https://gitlab.com/sneezeforever/codex-to-agents.git',
    'https://github.com.evil.example/sneezeforever/codex-to-agents.git',
    'https://github.com@evil.example/sneezeforever/codex-to-agents.git',
    // Extra paths, suffixes and option-like strings are not accepted.
    'https://github.com/sneezeforever/codex-to-agents/tree/main',
    'https://github.com/sneezeforever/codex-to-agents.git/extra',
    'https://github.com/sneezeforever/codex-to-agents.git --upload-pack=evil',
    'https://github.com/sneezeforever/codex-to-agents.git%20--upload-pack=evil',
    // Non-Git, insecure, local and empty values remain rejected.
    '/tmp/local-origin.git',
    'file:///tmp/codex-to-agents.git',
    'git://github.com/sneezeforever/codex-to-agents.git',
    '   ', '', null, undefined,
    '-uhttps://github.com/sneezeforever/codex-to-agents.git',
    '--upload-pack=evil https://github.com/sneezeforever/codex-to-agents.git',
  ]) assert.equal(isOfficialOrigin(value), false, String(value));
});

test('remote failures are reported honestly and the origin must be official', async t => {
  const repo = await repository(t);
  const offline = await check(repo.home, repo.dependencies({
    remote: 'https://127.0.0.1:1/codex-to-agents.git',
  }));
  assert.equal(offline.status, 'blocked');
  assert.equal(offline.reason, 'offline');
  assert.match(offline.message, /无法连接远端仓库/);
  assert.equal((await status(repo.home)).status, 'blocked', 'the offline result stays cached');

  const untrusted = await check(repo.home, repo.dependencies({ remote: null }));
  assert.equal(untrusted.status, 'blocked');
  assert.equal(untrusted.reason, 'origin');
  assert.match(untrusted.message, /sneezeforever\/codex-to-agents/);
  assert.match(untrusted.message, /heystarlink\/codex-to-agents/);
});

test('apply re-verifies the checkout and rejects checks that went stale', async t => {
  const repo = await repository(t);
  const installs = [];
  const deps = () => repo.dependencies({
    install: async () => { installs.push(1); return { dependencies_installed: true, plugin_regenerated: true }; },
  });

  const initial = await repo.head();
  const first = await repo.commit({ 'src/first.txt': 'first\n' }, 'first');
  await start(repo.home, 'check', deps());
  assert.equal((await settle(repo.home)).status, 'available');
  const second = await repo.commit({ 'src/second.txt': 'second\n' }, 'second');
  await start(repo.home, 'apply', deps());
  const changed = await settle(repo.home);
  assert.equal(changed.status, 'blocked');
  assert.equal(changed.reason, 'changed');
  assert.match(changed.message, /重新检查更新/);
  assert.deepEqual(installs, []);
  assert.equal(await repo.head(), initial, 'neither commit is merged when the check is stale');
  assert.notEqual(second, first);

  await start(repo.home, 'check', deps());
  assert.equal((await settle(repo.home)).status, 'available');
  await writeFile(join(repo.install, 'package.json'), '{"name":"dirty after check"}\n');
  await start(repo.home, 'apply', deps());
  const dirty = await settle(repo.home);
  assert.equal(dirty.status, 'blocked');
  assert.equal(dirty.reason, 'dirty');
  assert.deepEqual(installs, []);
});

test('running work orders and live native sessions block apply', async t => {
  const repo = await repository(t);
  const book = new OrderBook(repo.home);
  await book.open();
  const order = await book.submit('work_submit', { executor: 'dsh', goal: '还在运行的任务' });
  await book.transition(order.order_id, 'executing', { conversation_id: 'native-running' });
  const latest = await repo.commit({ 'src/feature.txt': 'hello\n' });
  const installs = [];
  const deps = () => repo.dependencies({
    install: async () => { installs.push(1); return { dependencies_installed: true, plugin_regenerated: true }; },
    restart: async () => ({ backend_was_online: false, backend_restarted: false }),
  });

  await start(repo.home, 'check', deps());
  const checked = await settle(repo.home);
  assert.equal(checked.status, 'available');
  assert.ok(checked.running_tasks >= 1);
  assert.match(checked.message, /任务正在运行/);

  await start(repo.home, 'apply', deps());
  const blocked = await settle(repo.home);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'running');
  assert.deepEqual(installs, []);
  assert.notEqual(await repo.head(), latest);

  await book.transition(order.order_id, 'completed', {});
  await book.runtime({ protocol: 2, executor: 'dsh', active: true, at: new Date().toISOString(), pid: process.pid,
    sessions: [{ id: 'native-running', status: 'running' }] }, 'dsh');
  await start(repo.home, 'apply', deps());
  const sessionBlocked = await settle(repo.home);
  assert.equal(sessionBlocked.status, 'blocked');
  assert.equal(sessionBlocked.reason, 'running');
  // The idle check also covers Qoder: an update must not replace code under a
  // running native Qoder session.
  await book.runtime({ protocol: 2, executor: 'dsh', active: false, at: new Date().toISOString() }, 'dsh');
  await book.runtime({ protocol: 2, executor: 'qoder', active: true, at: new Date().toISOString(), pid: process.pid,
    sessions: [{ id: 'qoder-running', status: 'running' }] }, 'qoder');
  await start(repo.home, 'apply', deps());
  const qoderBlocked = await settle(repo.home);
  assert.equal(qoderBlocked.status, 'blocked');
  assert.equal(qoderBlocked.reason, 'running');
  assert.equal(qoderBlocked.running_sessions, 1);
  assert.deepEqual(installs, []);

  await book.runtime({ protocol: 2, executor: 'dsh', active: false, at: new Date().toISOString(), sessions: [] }, 'dsh');
  await book.runtime({ protocol: 2, executor: 'qoder', active: false, at: new Date().toISOString(), sessions: [] }, 'qoder');
  await start(repo.home, 'apply', deps());
  const updated = await settle(repo.home);
  assert.equal(updated.status, 'updated');
  assert.equal(await repo.head(), latest);
  assert.equal(installs.length, 1);
});

test('concurrent check/apply requests are rejected while an update runs', async t => {
  const repo = await repository(t);
  const latest = await repo.commit({ 'src/feature.txt': 'hello\n' });
  const installs = []; let release; const gate = new Promise(resolve => { release = resolve; });
  const deps = () => repo.dependencies({
    install: async () => { installs.push(1); await gate; return { dependencies_installed: true, plugin_regenerated: true }; },
    restart: async () => ({ backend_was_online: true, backend_restarted: true }),
  });

  await start(repo.home, 'check', deps());
  assert.equal((await settle(repo.home)).status, 'available');
  const applying = await start(repo.home, 'apply', deps());
  assert.equal(applying.status, 'updating');
  const busyApply = await start(repo.home, 'apply', deps());
  assert.equal(busyApply.status, 'blocked');
  assert.equal(busyApply.reason, 'busy');
  const busyCheck = await start(repo.home, 'check', deps());
  assert.equal(busyCheck.status, 'blocked');
  assert.equal(busyCheck.reason, 'busy');
  assert.equal((await status(repo.home)).status, 'updating');

  release();
  const updated = await settle(repo.home);
  assert.equal(updated.status, 'updated');
  assert.equal(updated.current, latest);
  assert.equal(installs.length, 1, 'the lock prevents a duplicate install');
});

test('an install failure stays failed (with a retry path) even after Git advanced', async t => {
  const repo = await repository(t);
  const latest = await repo.commit({ 'src/feature.txt': 'hello\n' });
  const restarts = [];
  const failing = repo.dependencies({
    install: async () => { throw new Error('npm ci: registry unreachable'); },
    restart: async () => { restarts.push(1); return {}; },
  });

  await start(repo.home, 'check', failing);
  assert.equal((await settle(repo.home)).status, 'available');
  await start(repo.home, 'apply', failing);
  const failed = await settle(repo.home);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'install');
  assert.equal(failed.pending_install, true);
  assert.equal(failed.current, latest);
  assert.match(failed.message, /安装失败/);
  assert.match(failed.message, /代码已更新到/);
  assert.match(failed.recovery, /再次应用更新/);
  assert.equal(await repo.head(), latest, 'Git fast-forwarded before the dependency step');
  assert.deepEqual(restarts, [], 'a failed install never claims a successful update');

  await start(repo.home, 'check', repo.dependencies());
  const pending = await settle(repo.home);
  assert.equal(pending.status, 'available', 'an unfinished install must remain actionable in the board');
  assert.equal(pending.reason, 'pending_install');
  assert.equal(pending.pending_install, true);
  assert.match(pending.message, /「应用更新」/);

  const installs = [];
  const retry = repo.dependencies({
    install: async context => {
      installs.push(context);
      return { dependencies_installed: true, plugin_regenerated: true, dsh_configured: true, dsh_profile_updated: true };
    },
    restart: async () => ({ backend_was_online: true, backend_restarted: true }),
  });
  await start(repo.home, 'apply', retry);
  const updated = await settle(repo.home);
  assert.equal(updated.status, 'updated');
  assert.equal(updated.current, latest);
  assert.equal(updated.restart_required, true);
  assert.equal(updated.dsh_reload_required, true);
  assert.match(updated.message, /DSH/);
  assert.match(updated.message, /需要重启 DSH/);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].retry, true);
  assert.equal(installs[0].force_dependencies, true);
  assert.equal(await repo.head(), latest, 'retrying the install does not merge again');
});

test('an untracked file conflict stops the merge without deleting local files', async t => {
  const repo = await repository(t);
  await writeFile(join(repo.install, 'conflict.txt'), 'local untracked content\n');
  await repo.commit({ 'conflict.txt': 'remote content\n' }, 'remote adds conflict');
  const before = await repo.head();
  const installs = [];

  await start(repo.home, 'check', repo.dependencies());
  assert.equal((await settle(repo.home)).status, 'available');
  await start(repo.home, 'apply', repo.dependencies({
    install: async () => { installs.push(1); return {}; },
  }));
  const failed = await settle(repo.home);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'merge');
  assert.match(failed.message, /fast-forward/);
  assert.match(failed.message, /没有使用 stash、reset 或强制覆盖/);
  assert.deepEqual(installs, []);
  assert.equal(await repo.head(), before);
  assert.equal(await readFile(join(repo.install, 'conflict.txt'), 'utf8'), 'local untracked content\n',
    'Git must refuse to overwrite the local untracked file and we keep it');
});

test('an interrupted helper is reported as failed and can be retried', async t => {
  const repo = await repository(t);
  const latest = await repo.commit({ 'src/feature.txt': 'hello\n' });
  await start(repo.home, 'check', repo.dependencies());
  const available = await settle(repo.home);
  assert.equal(available.status, 'available');

  const deadAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(join(repo.home, UPDATE_STATE_FILE), JSON.stringify({
    version: 1, status: 'updating', pid: 999999, started_at: deadAt, last_result: available,
  }));
  await writeFile(join(repo.home, UPDATE_LOCK_FILE), JSON.stringify({
    version: 1, pid: 999999, nonce: 'dead-helper', action: 'apply', at: deadAt,
  }));
  const interrupted = await status(repo.home);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.reason, 'interrupted');
  assert.equal(interrupted.current, available.current);
  assert.equal(interrupted.latest, available.latest);
  assert.match(interrupted.message, /已退出/);

  await start(repo.home, 'apply', repo.dependencies());
  const updated = await settle(repo.home);
  assert.equal(updated.status, 'updated');
  assert.equal(updated.current, latest);
  await assert.rejects(access(join(repo.home, UPDATE_LOCK_FILE)), { code: 'ENOENT' });
});

test('DSH profile refresh rewrites only our node name for the matching home', async t => {
  const repo = await repository(t);
  await mkdir(repo.home, { recursive: true });
  const dshHome = join(repo.root, 'dsh-home');
  const profilesRoot = join(dshHome, 'profiles');
  const nextModule = join(repo.root, '.local', 'dsh-runtime-next', 'extension.mjs');
  const address = JSON.stringify(repo.home);
  const desktopText = [
    '# Desktop cordis patch (fixture)',
    '- insert:',
    '    - id: codex-to-agents-desktop',
    '      name: "/old/runtime-111/extension.mjs" # own module',
    '      config:',
    `        home: ${address}`,
    '        defaultDirectory: "/custom/work"',
    '        providers: ["profile-only-provider"]',
    '    - id: unrelated-plugin',
    '      name: "/plugins/unrelated.mjs"',
    '      config:',
    '        home: "/another-home"',
    '# END CODEX TO AGENTS',
    '',
  ].join('\n');
  const labText = [
    '- insert:',
    '    - id: "codex-to-agents-desktop"',
    "      name: '/old/runtime-222/extension.mjs'",
    '      config:',
    `        home: '${repo.home}'`,
    '        defaultDirectory: "/custom/lab"',
    '        providers: ["lab-provider"]',
    '',
  ].join('\n');
  const otherText = [
    '- insert:',
    '    - id: codex-to-agents-desktop',
    '      name: "/old/runtime-333/extension.mjs"',
    '      config:',
    '        home: "/some/other/home"',
    '        defaultDirectory: "/custom/other"',
    '        providers: ["other-provider"]',
    '',
  ].join('\n');
  const unrelatedText = '# no codex-to-agents node here\n';
  for (const [name, text] of [['desktop', desktopText], ['lab', labText], ['other', otherText], ['unrelated', unrelatedText]]) {
    await mkdir(join(profilesRoot, name), { recursive: true });
    await writeFile(join(profilesRoot, name, 'cordis.patch.yml'), text);
  }

  assert.deepEqual(await refreshDshProfile(repo.home, nextModule, { dshHome }), { configured: true, updated: true });
  const expectedDesktop = desktopText.replace(
    '      name: "/old/runtime-111/extension.mjs" # own module',
    `      name: ${JSON.stringify(nextModule)} # own module`,
  );
  const expectedLab = labText.replace(
    "      name: '/old/runtime-222/extension.mjs'",
    `      name: ${JSON.stringify(nextModule)}`,
  );
  assert.equal(await readFile(join(profilesRoot, 'desktop', 'cordis.patch.yml'), 'utf8'), expectedDesktop,
    'only the module path changes; home, providers, defaultDirectory, comments and other nodes stay verbatim');
  assert.equal(await readFile(join(profilesRoot, 'lab', 'cordis.patch.yml'), 'utf8'), expectedLab,
    'quoted ids and single-quoted scalars are still recognized');
  assert.equal(await readFile(join(profilesRoot, 'other', 'cordis.patch.yml'), 'utf8'), otherText,
    'a profile for another data home is never touched');
  assert.equal(await readFile(join(profilesRoot, 'unrelated', 'cordis.patch.yml'), 'utf8'), unrelatedText);

  assert.deepEqual(await refreshDshProfile(repo.home, nextModule, { dshHome }), { configured: true, updated: false });
});

test('DSH profile refresh replaces a DSH backslash-folded module name as one scalar span', async t => {
  const repo = await repository(t);
  await mkdir(repo.home, { recursive: true });
  const dshHome = join(repo.root, 'dsh-home');
  const profilesRoot = join(dshHome, 'profiles');
  const nextModule = join(repo.root, '.local', 'dsh-runtime-next', 'extension.mjs');
  const lines = [
    '# Desktop cordis patch (fixture)',
    '- insert:',
    '    - id: codex-to-agents-desktop',
    '      name: "/old/.local/dsh-r\\',
    '        untime-dd19f49610332538/extension.mjs" # own module',
    '      config:',
    `        home: ${JSON.stringify(repo.home)}`,
    '        defaultDirectory: "/custom/work"',
    '        providers: ["profile-only-provider"]',
    '    - id: unrelated-plugin',
    '      name: "/plugins/unrelated.mjs"',
    '      config:',
    '        home: "/another-home"',
    '# END CODEX TO AGENTS',
    '',
  ];
  await mkdir(join(profilesRoot, 'desktop'), { recursive: true });
  const file = join(profilesRoot, 'desktop', 'cordis.patch.yml');
  await writeFile(file, lines.join('\n'));

  assert.deepEqual(await refreshDshProfile(repo.home, nextModule, { dshHome }), { configured: true, updated: true });
  const expected = [...lines.slice(0, 3), `      name: ${JSON.stringify(nextModule)} # own module`, ...lines.slice(5)].join('\n');
  assert.equal(await readFile(file, 'utf8'), expected,
    'the whole two-line scalar is replaced; home, providers, comments and the other node stay verbatim');
  assert.doesNotMatch(await readFile(file, 'utf8'), /dsh-r\\\n/, 'no folded continuation line is left behind');
  assert.deepEqual(await refreshDshProfile(repo.home, nextModule, { dshHome }), { configured: true, updated: false });
});

test('DSH profile refresh fails without writing any profile when a name scalar is unsafe', async t => {
  const repo = await repository(t);
  await mkdir(repo.home, { recursive: true });
  const dshHome = join(repo.root, 'dsh-home');
  const profilesRoot = join(dshHome, 'profiles');
  const nextModule = join(repo.root, '.local', 'dsh-runtime-next', 'extension.mjs');
  const profile = (nameLine, continuation) => [
    '- insert:',
    '    - id: codex-to-agents-desktop',
    nameLine,
    ...(continuation ? [continuation] : []),
    '      config:',
    `        home: ${JSON.stringify(repo.home)}`,
    '        providers: ["profile-only-provider"]',
    '',
  ].join('\n');
  const safe = profile('      name: "/old/.local/runtime-222/extension.mjs"');
  // Valid YAML folding without a backslash is not the DSH-generated form the
  // updater can prove safe; it must refuse rather than rewrite only one line.
  const unsafe = profile('      name: "/old/.local/dsh-', '        runtime-333/extension.mjs"');
  for (const [name, text] of [['a-safe', safe], ['z-unsafe', unsafe]]) {
    await mkdir(join(profilesRoot, name), { recursive: true });
    await writeFile(join(profilesRoot, name, 'cordis.patch.yml'), text);
  }
  const safeFile = join(profilesRoot, 'a-safe', 'cordis.patch.yml');
  const unsafeFile = join(profilesRoot, 'z-unsafe', 'cordis.patch.yml');

  await assert.rejects(refreshDshProfile(repo.home, nextModule, { dshHome }), /无法安全识别.*未修改任何配置/);
  assert.equal(await readFile(safeFile, 'utf8'), safe, 'no earlier profile is written when a later one is unsafe');
  assert.equal(await readFile(unsafeFile, 'utf8'), unsafe, 'the unsafe profile is left byte-identical');
});

test('npm is located explicitly so the background does not depend on PATH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cta-npm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const node = join(root, 'node', 'bin', 'node');
  const cli = join(root, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mkdir(dirname(node), { recursive: true });
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(cli, '// npm cli\n');
  assert.equal(await findNpmCli({ node, env: { PATH: '' } }), cli,
    'the npm CLI is derived from the Node executable, not found on PATH');
  assert.equal(await findNpmCli({ node: join(root, 'absent', 'bin', 'node'), env: { PATH: join(root, 'empty'), npm_execpath: cli } }), cli,
    'npm_execpath is honored when present');
});

test('npm is preflighted before the fast-forward, so a missing npm changes nothing', async t => {
  const repo = await repository(t);
  const before = await repo.head();
  await repo.commit({ 'src/feature.txt': 'hello\n' });
  const installs = [];
  await start(repo.home, 'check', repo.dependencies());
  assert.equal((await settle(repo.home)).status, 'available');

  await start(repo.home, 'apply', repo.dependencies({
    find_npm: async () => null,
    install: async () => { installs.push(1); },
  }));
  const state = await settle(repo.home);
  assert.equal(state.status, 'blocked');
  assert.equal(state.reason, 'npm_missing');
  assert.match(state.message, /npm/);
  assert.match(state.message, /没有拉取任何代码/);
  assert.deepEqual(installs, []);
  assert.equal(await repo.head(), before, 'the checkout is not fast-forwarded before npm is verified');
});

test('the pending state is written before the helper and is never overwritten by a fast helper', async t => {
  const repo = await repository(t);
  const helper = join(repo.root, 'fixture-helper.mjs');
  await writeFile(helper, [
    "import { readFile, writeFile } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    'const home = process.argv[2];',
    'const read = async name => { try { return JSON.parse(await readFile(join(home, name), \'utf8\')); } catch { return null; } };',
    'const [state, lock] = await Promise.all([read(\'plugin-update.json\'), read(\'plugin-update.lock\')]);',
    "await writeFile(join(home, 'worker-observed.json'), JSON.stringify({ state, lock, nonce: process.env.CODEX_TO_AGENTS_UPDATE_LOCK }));",
    "await writeFile(join(home, 'plugin-update.json'), JSON.stringify({ version: 1, status: 'up_to_date',",
    "  current: 'f'.repeat(40), latest: 'f'.repeat(40), branch: 'main', message: 'fixture helper finished',",
    "  checked_at: new Date().toISOString() }));",
    '',
  ].join('\n'));

  const started = await runPluginUpdate(repo.home, { action: 'check', dependencies: { detached: true, workerEntry: helper } });
  assert.equal(started.status, 'checking');
  const settled = await settle(repo.home);
  assert.equal(settled.status, 'up_to_date');
  assert.equal(settled.message, 'fixture helper finished');

  const observed = JSON.parse(await readFile(join(repo.home, 'worker-observed.json'), 'utf8'));
  assert.equal(observed.state.status, 'checking', 'the parent wrote the pending state before spawning the helper');
  assert.equal(observed.state.pid, process.pid);
  assert.equal(observed.lock.nonce, observed.nonce, 'the helper inherits the lock nonce from the parent');

  await delay(150);
  assert.equal((await status(repo.home)).message, 'fixture helper finished',
    'the parent close handler must not overwrite a faster helper result');
  await assert.rejects(access(join(repo.home, UPDATE_LOCK_FILE)), { code: 'ENOENT' },
    'the parent releases the lock of the finished helper');
});

test('the helper takes over the lock pid while keeping the nonce', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cta-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, UPDATE_LOCK_FILE), JSON.stringify({
    version: 1, pid: 999999, nonce: 'helper-nonce', action: 'check', at: new Date().toISOString(),
  }));
  assert.equal(await claimHelperLock(home, 'other-nonce', 'check'), null, 'a different nonce never steals the lock');
  const takeover = await claimHelperLock(home, 'helper-nonce', 'check');
  assert.equal(takeover.pid, process.pid, 'the live helper owns the lock, not the spawning background');
  assert.equal(takeover.nonce, 'helper-nonce', 'the parent nonce is preserved for release');
  const saved = JSON.parse(await readFile(join(home, UPDATE_LOCK_FILE), 'utf8'));
  assert.equal(saved.pid, process.pid);
  assert.equal(saved.nonce, 'helper-nonce');
});

test('a helper killed after the fast-forward keeps a retryable pending install', async t => {
  const repo = await repository(t);
  const latest = await repo.commit({ 'src/feature.txt': 'hello\n' });
  await start(repo.home, 'check', repo.dependencies());
  assert.equal((await settle(repo.home)).status, 'available');

  // A real helper process performs the real fast-forward and then dies during
  // the install step, exactly like SIGKILL during npm ci.
  const crashHelper = join(repo.root, 'crash-helper.mjs');
  await writeFile(crashHelper, [
    "const [home, repoRoot, remote, fakeNpm, moduleUrl] = process.argv.slice(2);",
    "const { readFile, writeFile } = await import('node:fs/promises');",
    "const { join } = await import('node:path');",
    'const { runUpdateJob } = await import(moduleUrl);',
    'const deps = {',
    '  repoRoot, remote, find_npm: async () => fakeNpm,',
    '  async install() {',
    "    const state = JSON.parse(await readFile(join(home, 'plugin-update.json'), 'utf8'));",
    "    await writeFile(join(home, 'install-started.json'), JSON.stringify(state));",
    "    process.kill(process.pid, 'SIGKILL');",
    '  },',
    '  async restart() { return {}; },',
    '};',
    "await runUpdateJob(home, { action: 'apply', nonce: 'crash-nonce', dependencies: deps });",
    '',
  ].join('\n'));
  await mkdir(repo.home, { recursive: true });
  await writeFile(join(repo.home, UPDATE_LOCK_FILE), JSON.stringify({
    version: 1, pid: process.pid, nonce: 'crash-nonce', action: 'apply', at: new Date().toISOString(),
  }));
  const child = spawn(process.execPath, [crashHelper, repo.home, repo.install, repo.bare,
    repo.npmCli, import.meta.resolve('../src/plugin-update.mjs')], { stdio: 'ignore' });
  const exit = await new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  assert.ok(exit.signal === 'SIGKILL' || exit.code !== 0, 'the helper was killed mid-install');
  assert.equal(await repo.head(), latest, 'the fast-forward had already happened before the kill');

  const started = JSON.parse(await readFile(join(repo.home, 'install-started.json'), 'utf8'));
  assert.equal(started.last_result.pending_install, true, 'pending_install is persisted before install starts');
  assert.equal(started.last_result.current, latest);

  const killed = await status(repo.home);
  assert.equal(killed.status, 'failed');
  assert.equal(killed.reason, 'interrupted');
  assert.equal(killed.pending_install, true, 'an interrupted install stays retryable');
  assert.match(killed.message, /可能已部分更新/);
  assert.doesNotMatch(killed.message, /未被修改/);

  const recovered = await check(repo.home, repo.dependencies());
  assert.equal(recovered.status, 'available', 'check must not report up_to_date after an interrupted install');
  assert.equal(recovered.pending_install, true);
  assert.equal(recovered.reason, 'pending_install');
  assert.match(recovered.message, /应用更新/);

  const installs = [];
  await start(repo.home, 'apply', repo.dependencies({
    install: async context => {
      installs.push(context);
      return { dependencies_installed: true, plugin_regenerated: true };
    },
    restart: async () => ({ backend_was_online: false, backend_restarted: false }),
  }));
  const updated = await settle(repo.home);
  assert.equal(updated.status, 'updated');
  assert.equal(updated.current, latest);
  assert.equal(updated.pending_install, false);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].retry, true);
  assert.equal(installs[0].force_dependencies, true);
});

test('a late close of an old helper cannot rewrite a newer update state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cta-abandoned-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const oldPid = 111111;
  const state = {
    version: 1, status: 'updating', pid: oldPid, started_at: new Date().toISOString(),
    last_result: { status: 'updating', current: 'a'.repeat(40), latest: 'b'.repeat(40), branch: 'main', pending_install: true },
  };
  await writeFile(join(home, UPDATE_STATE_FILE), JSON.stringify(state));
  await writeFile(join(home, UPDATE_LOCK_FILE), JSON.stringify({
    version: 1, pid: process.pid, nonce: 'new-nonce', action: 'apply', at: new Date().toISOString(),
  }));

  const late = await finishAbandonedHelper(home, {
    nonce: 'old-nonce', pids: [oldPid, process.pid], stage: 'interrupted', message: '旧助手退出',
  });
  assert.equal(late, false, 'a close event without the current nonce must do nothing');
  const untouched = JSON.parse(await readFile(join(home, UPDATE_STATE_FILE), 'utf8'));
  assert.equal(untouched.status, 'updating', 'the newer pending state is preserved');
  assert.equal(JSON.parse(await readFile(join(home, UPDATE_LOCK_FILE), 'utf8')).nonce, 'new-nonce',
    'the newer job keeps its lock');

  await rm(join(home, UPDATE_LOCK_FILE), { force: true });
  await writeFile(join(home, UPDATE_LOCK_FILE), JSON.stringify({
    version: 1, pid: oldPid, nonce: 'old-nonce', action: 'apply', at: new Date().toISOString(),
  }));
  const owned = await finishAbandonedHelper(home, {
    nonce: 'old-nonce', pids: [oldPid], stage: 'interrupted', message: '代码可能已部分更新',
  });
  assert.equal(owned, true, 'the actual lock owner still records the abandoned helper');
  const failed = JSON.parse(await readFile(join(home, UPDATE_STATE_FILE), 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'interrupted');
  assert.equal(failed.pending_install, true, 'a pending install is preserved for retry');
  assert.match(failed.message, /可能已部分更新/);
  await assert.rejects(access(join(home, UPDATE_LOCK_FILE)), { code: 'ENOENT' });
});

test('enabled auto update continues from check to install without board polling, preserving one updater lock', async t => {
  const repo = await repository(t);let installs = 0;
  const update = (home, input) => runPluginUpdate(home, { ...input, dependencies: repo.dependencies({
    install: async () => { installs++;return { plugin_regenerated: true }; },
  }) });
  const latest = await repo.commit({ 'src/feature.txt': 'auto update\n' });
  await runBoardUpdate(repo.home, { action: 'set_auto', enabled: true }, update);
  assert.equal((await runBoardUpdate(repo.home, { action: 'check_daily' }, update)).status, 'checking');
  // Status reads are passive; only the check helper can advance this flow.
  assert.equal((await settle(repo.home)).status, 'updated');
  assert.equal(await repo.head(), latest);assert.equal(installs, 1);
});

test('automatic installation still blocks dirty files and running work without changing HEAD', async t => {
  for (const reason of ['dirty', 'running']) {
    const repo = await repository(t);const before = await repo.head();let installs = 0;
    const update = (home, input) => runPluginUpdate(home, { ...input, dependencies: repo.dependencies({
      install: async () => { installs++;return {}; },
    }) });
    await repo.commit({ 'src/feature.txt': 'new\n' });
    await check(repo.home, repo.dependencies());
    if (reason === 'dirty') await writeFile(join(repo.install, 'src/base.txt'), 'local work\n');
    else {
      const book = new OrderBook(repo.home);await book.open();
      await book.submit('work_submit', { executor: 'dsh', goal: 'running fixture' });
    }
    await runBoardUpdate(repo.home, { action: 'set_auto', enabled: true }, update);
    await runBoardUpdate(repo.home, { action: 'check_daily' }, update);
    const result = await settle(repo.home);
    assert.equal(result.status, 'blocked');assert.equal(result.reason, reason);
    assert.equal(await repo.head(), before);assert.equal(installs, 0);
  }
});

test('an applied project update refreshes the board, model endpoint and installed plugin cache with one saved transport', async t => {
  const repo = await repository(t);
  const marketplace = join(repo.root, 'marketplace');
  const dshHome = join(repo.root, 'dsh-home');
  const codexHome = await isolateCodex(t, repo.root);
  const recordedCodex = await fakeCodex(repo.root);
  await mkdir(repo.home, { recursive: true });
  await writeFile(join(repo.home, 'usage-settings.json'), '{"enabled":false}\n');
  // Start from a real installed state: the source marketplace and Codex's
  // installed plugin cache both use HTTP, then the saved choice becomes stdio.
  const installed = await preparePlugin(repo.home, { root: marketplace, transport: 'http' });
  await runFixture(recordedCodex, ['plugin', 'marketplace', 'add', marketplace]);
  await runFixture(recordedCodex, ['plugin', 'add', installed.selector]);
  const cacheManifest = join(codexHome, 'plugins', 'cache', 'codex-to-agents-local', 'agents-board', '0.1.0', '.mcp.json');
  assert.equal(await boardMode(join(installed.plugin, '.mcp.json')), 'http');
  assert.equal(await boardMode(cacheManifest), 'http', 'the fixture mirrors the installed plugin cache');
  await saveTransport(repo.home, 'stdio');
  await writeFile(join(repo.home, 'plugin-installation.json'), JSON.stringify({ codex: recordedCodex }));
  const latest = await repo.commit({ 'src/feature.txt': 'update\n' });
  await check(repo.home, repo.dependencies());
  const calls = [];
  const dependencies = repo.dependencies({
    dshHome,
    install: context => installProjectUpdate(context, {
      root: marketplace,
      register: async (homePath, executable, transport) => { calls.push({ homePath, executable, transport }); },
      prepareDshExtension: async () => join(marketplace, 'dsh', 'extension.mjs'),
    }),
  });
  try {
    const applying = await start(repo.home, 'apply', dependencies);
    assert.equal(applying.status, 'updating');
    const result = await settle(repo.home);
    assert.equal(result.status, 'updated');
    assert.equal(await repo.head(), latest);
    assert.equal(calls.length, 1, 'the update refreshes the global model entry');
    assert.equal(await realpath(calls[0].homePath), await realpath(repo.home));
    assert.equal(calls[0].executable, recordedCodex, 'the recorded Codex executable is reused');
    assert.equal(calls[0].transport, 'stdio', 'the update reuses the saved transport');

    const board = JSON.parse(await readFile(join(marketplace, 'plugins', 'agents-board', '.mcp.json'), 'utf8'));
    const connection = board.mcpServers.agents_board;
    assert.ok(connection.command, 'the board manifest follows the saved stdio transport');
    assert.equal(connection.url, undefined);
    assert.equal(connection.http_headers_helper, undefined);
    assert.equal(await boardMode(cacheManifest), 'stdio',
      'marketplace add + plugin add refresh the cache Codex actually installed');
  } finally {
    await stopBackend(repo.home).catch(() => {});
  }
});
