/**
 * T3 — locked executor runner tests (DIA-05).
 *
 * These tests really spawn processes: a fake locked executor lives under
 * `tests/fixtures/executor/`. They prove args arrays, env allowlisting, cwd
 * containment, timeout/cancel *process-tree* termination (a grandchild writes
 * a heartbeat file that must stop growing), output caps, and the deny paths.
 * No real network is involved.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { LIMITS } from '../src/limits.mjs';
import { assertNoRemoteRefs, buildExecutorEnv, FIXED_ENV, INHERITED_ENV_ALLOWLIST, runLockedCommand } from '../src/runner.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, '..');
const FIXTURE_DIR = path.join(TEST_DIR, 'fixtures', 'executor');

const fixturePath = (name) => path.join(FIXTURE_DIR, name);

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(stepMs);
  }
  return predicate();
}

/** Minimal valid v1 lock; commands are injected per test. */
function makeLock(commands, overrides = {}) {
  return {
    schema_version: 1,
    runtime: {
      node: '>=24.9.0',
      tested_node: '26.13.0',
      tested_node_sha256: null,
      host_node: '24.21.0',
      package_manager: 'npm-compatible; no runtime dependencies',
    },
    sources: [
      {
        id: 'fixture-outlet',
        kind: 'test-fixture',
        repository: 'workspace:tests/fixtures/executor',
        commit: null,
        version: '1.0.0',
        package: null,
        artifact_sha256: null,
        license: null,
        license_ref: null,
        adopted_files: [],
        resource_manifest_ref: null,
      },
    ],
    commands,
    evidence_refs: ['docs/implementation-route.md'],
    limits: { network_mode: 'none', remote_services: [], model_services: [], credential_access: false },
    ...overrides,
  };
}

/** A command that runs one fixture script through this Node binary. */
function fixtureCommand(id, script, { args = [], envFixed = {} } = {}) {
  return {
    id,
    executable_ref: process.execPath,
    args_template: [fixturePath(script), ...args],
    env_fixed: envFixed,
  };
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    spawnSync(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

function parsePids(stdout) {
  try {
    const payload = JSON.parse(stdout.trim().split('\n')[0]);
    return [payload.parent_pid, payload.grandchild_pid].filter((pid) => Number.isInteger(pid));
  } catch {
    return [];
  }
}

function assertHeartbeatStopped(t, heartbeatPath, stdout) {
  for (const pid of parsePids(stdout)) t.after(() => killTree(pid));
  return delay(350)
    .then(() => {
      const sizeBefore = statSync(heartbeatPath).size;
      return delay(350).then(() => {
        const sizeAfter = statSync(heartbeatPath).size;
        assert.equal(sizeAfter, sizeBefore, 'grandchild heartbeat kept growing: process tree survived');
      });
    });
}

test('runs a registered command with args array, contained cwd, and allowed env only', async (t) => {
  process.env.DIA_RUNNER_SECRET_LEAK = 'must-not-reach-child';
  t.after(() => {
    delete process.env.DIA_RUNNER_SECRET_LEAK;
  });
  const lock = makeLock([fixtureCommand('inspect-exec', 'inspect.mjs', { envFixed: { FIXTURE_FIXED: 'yes' } })]);

  const result = await runLockedCommand(lock, 'inspect-exec', {
    root: PROJECT_ROOT,
    args: ['alpha', 'two words', '; echo injected', '$(whoami)'],
    allowed_env: { LOCAL_DIAGRAM_TEST_FLAG: 'on' },
    timeout_ms: 15000,
  });

  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.exit_code, 0);
  assert.equal(result.output_truncated, false);
  assert.equal(typeof result.duration_ms, 'number');

  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.argv, ['alpha', 'two words', '; echo injected', '$(whoami)']);
  assert.equal(payload.cwd.toLowerCase(), PROJECT_ROOT.toLowerCase());
  assert.equal(payload.env.ARCHIFY_UPDATE_CHECK_DISABLED, '1');
  assert.equal(payload.env.FIXTURE_FIXED, 'yes');
  assert.equal(payload.env.LOCAL_DIAGRAM_TEST_FLAG, 'on');
  assert.equal(payload.env.DIA_RUNNER_SECRET_LEAK, undefined);
  assert.equal(payload.env.NODE_OPTIONS, undefined);
  assert.deepEqual(
    Object.keys(payload.env).filter((key) => /PROXY$/i.test(key)),
    [],
  );
  // shell:string metacharacters arrived as literal argv entries; no shell ran.
  assert.equal(payload.argv.includes('; echo injected'), true);
});

test('accepts source-lock text instead of a parsed object', async () => {
  const lock = makeLock([fixtureCommand('inspect-text', 'inspect.mjs')]);
  const result = await runLockedCommand(JSON.stringify(lock), 'inspect-text', {
    root: PROJECT_ROOT,
    timeout_ms: 15000,
  });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.stdout).argv, []);
});

test('denies unknown commands without spawning anything', async () => {
  const lock = makeLock([fixtureCommand('known', 'inspect.mjs')]);
  const result = await runLockedCommand(lock, 'unknown-command', { root: PROJECT_ROOT });
  assert.equal(result.status, 'denied');
  assert.equal(result.code, 'INVALID_COMMAND');
});

test('denies a shell-string args value and non-string args', async () => {
  const lock = makeLock([fixtureCommand('inspect-args', 'inspect.mjs')]);

  const stringArgs = await runLockedCommand(lock, 'inspect-args', { root: PROJECT_ROOT, args: '--help' });
  assert.equal(stringArgs.status, 'denied');
  assert.equal(stringArgs.code, 'INVALID_INPUT');

  const mixedArgs = await runLockedCommand(lock, 'inspect-args', { root: PROJECT_ROOT, args: ['ok', 42] });
  assert.equal(mixedArgs.status, 'denied');
  assert.equal(mixedArgs.code, 'INVALID_INPUT');
});

test('denies cwd outside the root and invalid timeout values', async () => {
  const lock = makeLock([fixtureCommand('inspect-cwd', 'inspect.mjs')]);

  const outside = await runLockedCommand(lock, 'inspect-cwd', { root: PROJECT_ROOT, cwd: path.dirname(PROJECT_ROOT) });
  assert.equal(outside.status, 'denied');
  assert.equal(outside.code, 'INVALID_INPUT');

  const badTimeout = await runLockedCommand(lock, 'inspect-cwd', { root: PROJECT_ROOT, timeout_ms: 0 });
  assert.equal(badTimeout.status, 'denied');
  assert.equal(badTimeout.code, 'INVALID_INPUT');
});

test('denies unsafe caller environment and reserved overrides', async () => {
  const lock = makeLock([fixtureCommand('inspect-env', 'inspect.mjs')]);

  const injection = await runLockedCommand(lock, 'inspect-env', {
    root: PROJECT_ROOT,
    allowed_env: { NODE_OPTIONS: '--require=evil.js' },
  });
  assert.equal(injection.status, 'denied');
  assert.equal(injection.code, 'INVALID_INPUT');

  const pathOverride = await runLockedCommand(lock, 'inspect-env', {
    root: PROJECT_ROOT,
    allowed_env: { PATH: 'C:\\evil' },
  });
  assert.equal(pathOverride.status, 'denied');

  const updateCheckOverride = await runLockedCommand(lock, 'inspect-env', {
    root: PROJECT_ROOT,
    allowed_env: { ARCHIFY_UPDATE_CHECK_DISABLED: '0' },
  });
  assert.equal(updateCheckOverride.status, 'denied');
});

test('denies an invalid lock and an already-aborted signal', async () => {
  const invalidLock = await runLockedCommand('{"schema_version":2}', 'anything', { root: PROJECT_ROOT });
  assert.equal(invalidLock.status, 'denied');
  assert.equal(invalidLock.code, 'INVALID_INPUT');

  const lock = makeLock([fixtureCommand('inspect-abort', 'inspect.mjs')]);
  const controller = new AbortController();
  controller.abort();
  const aborted = await runLockedCommand(lock, 'inspect-abort', { root: PROJECT_ROOT, signal: controller.signal });
  assert.equal(aborted.status, 'cancelled');
  assert.equal(aborted.code, 'CANCELLED');
});

test('fails when the registered executable is missing', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dia-runner-missing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lock = makeLock([
    {
      id: 'missing-executable',
      executable_ref: path.join(directory, 'no-such-node.exe'),
      args_template: [],
      env_fixed: {},
    },
  ]);
  const result = await runLockedCommand(lock, 'missing-executable', { root: PROJECT_ROOT });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'FAILED');
  assert.equal(typeof result.detail, 'string');
  assert.equal(existsSync(path.join(directory, 'no-such-node.exe')), false);
});

test('reports a non-zero exit as failed with exit code and captured streams', async () => {
  const lock = makeLock([fixtureCommand('failing', 'fail.mjs')]);
  const result = await runLockedCommand(lock, 'failing', { root: PROJECT_ROOT, timeout_ms: 15000 });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'FAILED');
  assert.equal(result.exit_code, 3);
  assert.match(result.stdout, /fail-fixture:stdout/);
  assert.match(result.stderr, /fail-fixture:stderr/);
});

test('timeout terminates the whole owned process tree', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dia-runner-timeout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const heartbeatPath = path.join(directory, 'heartbeat.txt');
  const lock = makeLock([fixtureCommand('hang-timeout', 'hang-tree.mjs', { args: [heartbeatPath] })]);

  const startedAt = Date.now();
  const running = runLockedCommand(lock, 'hang-timeout', { root: PROJECT_ROOT, timeout_ms: 1200 });
  const grew = await waitFor(() => existsSync(heartbeatPath) && statSync(heartbeatPath).size > 40, { timeoutMs: 1000 });
  assert.equal(grew, true, 'grandchild heartbeat never grew before the timeout');

  const result = await running;
  assert.equal(result.status, 'timeout', JSON.stringify(result));
  assert.equal(result.code, 'FAILED');
  assert.equal(
    ['windows-taskkill-tree', 'posix-process-group-sigkill', 'child-kill-fallback'].includes(result.termination),
    true,
    `unexpected termination: ${result.termination}`,
  );
  assert.equal(Date.now() - startedAt < 15000, true, 'timeout took far too long');
  await assertHeartbeatStopped(t, heartbeatPath, result.stdout);
});

test('AbortSignal cancellation terminates the whole owned process tree', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dia-runner-cancel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const heartbeatPath = path.join(directory, 'heartbeat.txt');
  const lock = makeLock([fixtureCommand('hang-cancel', 'hang-tree.mjs', { args: [heartbeatPath] })]);
  const controller = new AbortController();

  const running = runLockedCommand(lock, 'hang-cancel', {
    root: PROJECT_ROOT,
    timeout_ms: 30000,
    signal: controller.signal,
  });
  const grew = await waitFor(() => existsSync(heartbeatPath) && statSync(heartbeatPath).size > 40, { timeoutMs: 1500 });
  assert.equal(grew, true, 'grandchild heartbeat never grew before cancellation');
  controller.abort();

  const result = await running;
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.equal(result.code, 'CANCELLED');
  await assertHeartbeatStopped(t, heartbeatPath, result.stdout);
});

test('aborting after completion does not corrupt an ok result', async () => {
  const lock = makeLock([fixtureCommand('inspect-late-abort', 'inspect.mjs')]);
  const controller = new AbortController();
  const result = await runLockedCommand(lock, 'inspect-late-abort', {
    root: PROJECT_ROOT,
    timeout_ms: 15000,
    signal: controller.signal,
  });
  controller.abort();
  assert.equal(result.status, 'ok');
});

test('caps stdout, terminates the tree, and reports LIMIT_EXCEEDED', async () => {
  const lock = makeLock([fixtureCommand('spew', 'spew.mjs')]);
  const result = await runLockedCommand(lock, 'spew', { root: PROJECT_ROOT, timeout_ms: 30000 });
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.equal(result.code, 'LIMIT_EXCEEDED');
  assert.equal(result.output_truncated, true);
  const stdoutBytes = Buffer.byteLength(result.stdout, 'utf8');
  assert.equal(stdoutBytes <= LIMITS.executor_output_bytes, true);
});

test('buildExecutorEnv keeps the inherited allowlist, rejects reserved keys, forces fixed env', () => {
  const built = buildExecutorEnv({
    envFixed: { FIXTURE_FIXED: 'yes' },
    allowedEnv: { LOCAL_FLAG: 'on' },
    baseEnv: { PATH: 'C:\\bin', SECRET_TOKEN: 'x', HTTP_PROXY: 'http://proxy.invalid' },
    platform: process.platform,
  });
  assert.equal(built.ok, true);
  assert.equal(built.env.PATH, 'C:\\bin');
  assert.equal(built.env.SECRET_TOKEN, undefined);
  assert.equal(built.env.HTTP_PROXY, undefined);
  assert.equal(built.env.FIXTURE_FIXED, 'yes');
  assert.equal(built.env.LOCAL_FLAG, 'on');
  assert.equal(built.env.ARCHIFY_UPDATE_CHECK_DISABLED, '1');

  const reserved = buildExecutorEnv({
    envFixed: { LOCKED_FLAG: '1' },
    allowedEnv: { locked_flag: '0' },
    baseEnv: {},
    platform: process.platform,
  });
  assert.equal(reserved.ok, false);
  assert.equal(reserved.errors[0].keyword, 'reserved');

  const forced = buildExecutorEnv({
    envFixed: { ARCHIFY_UPDATE_CHECK_DISABLED: '0' },
    allowedEnv: {},
    baseEnv: {},
    platform: process.platform,
  });
  assert.equal(forced.ok, true);
  assert.equal(forced.env.ARCHIFY_UPDATE_CHECK_DISABLED, '1');
  assert.equal(FIXED_ENV.ARCHIFY_UPDATE_CHECK_DISABLED, '1');
  assert.equal(INHERITED_ENV_ALLOWLIST.win32.includes('PATH'), true);
});

test('assertNoRemoteRefs flags remote schemes and protocol-relative resources', () => {
  const clean = '<svg><text>safe</text><path d="M0 0 L10 10"/></svg>';
  assert.equal(assertNoRemoteRefs(clean).ok, true);

  for (const text of [
    '<img src="https://example.invalid/a.png">',
    'x = new WebSocket("ws://example.invalid/socket")',
    "url('http://example.invalid/font.woff')",
    'body { background: url(//cdn.invalid/a.png) }',
    '<link href="//cdn.invalid/style.css">',
    'mirror: ftp://example.invalid/file',
  ]) {
    const result = assertNoRemoteRefs(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.errors.length > 0, true);
  }

  assert.equal(assertNoRemoteRefs(42).ok, false);

  const many = 'https://a.invalid '.repeat(64);
  const capped = assertNoRemoteRefs(many);
  assert.equal(capped.ok, false);
  assert.equal(capped.errors.some((error) => error.keyword === 'scan_limit'), true);
});
