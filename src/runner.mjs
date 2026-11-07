/**
 * 06 local diagrams — locked executor runner (DIA-05 outlet, T3).
 *
 * `runLockedCommand` spawns exactly one command that is registered in the
 * parsed source lock. Everything else is denied: unknown command ids, caller
 * args as a shell string, relative/UNC executables, working directories outside
 * the project root, unsafe environment keys, and oversized env/arg sets.
 *
 * Process contract:
 * - absolute executable from `executorFor` only;
 * - args are an array appended after the lock `args_template`; `shell: false`;
 * - `windowsHide: true`; stdio pipes for stdout/stderr, stdin ignored;
 * - child env = platform allowlist (PATH/SYSTEMROOT/...) + caller `allowed_env`
 *   + lock `env_fixed`, then the runner-forced
 *   `ARCHIFY_UPDATE_CHECK_DISABLED=1`; proxy, NODE_*, credential-shaped and
 *   update-check keys are rejected;
 * - timeout and AbortSignal terminate the *owned process tree* (Windows:
 *   `taskkill /PID <pid> /T /F`; POSIX: detached process group + SIGKILL);
 * - stdout/stderr are capped per stream at `LIMITS.executor_output_bytes`;
 *   crossing the cap terminates the tree and fails with LIMIT_EXCEEDED;
 * - the runner never opens a network path itself; a locked executor that
 *   tries to network is a policy failure detected by the smoke guard, not by
 *   this module.
 *
 * Test coverage here is component-level on the local platform (see
 * `tests/runner.test.mjs` and the T3 evidence). Timeout/cancel tree termination
 * is proven with a fixture executor that spawns a grandchild which writes a
 * heartbeat file; the file stops growing after the tree kill (tested on
 * Windows; the POSIX branch is code-reviewed only on this machine).
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { CODES, LIMITS } from './limits.mjs';
import {
  executorFor,
  isAbsoluteLocalPath,
  isForbiddenEnvKey,
  parseSourceLock,
  validateSourceLock,
} from './source-lock.mjs';

/** Environment the runner always forces (last write wins, never overridable). */
export const FIXED_ENV = Object.freeze({ ARCHIFY_UPDATE_CHECK_DISABLED: '1' });

/** Inherited environment allowlist; everything else is dropped. */
export const INHERITED_ENV_ALLOWLIST = Object.freeze({
  win32: Object.freeze([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'TEMP',
    'TMP',
    'COMSPEC',
    'NUMBER_OF_PROCESSORS',
  ]),
  posix: Object.freeze(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']),
});

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_ARGS = 256;
const MAX_ARG_LENGTH = 4096;
const KILL_SETTLE_FALLBACK_MS = 5000;

/**
 * @typedef {{path:string, keyword:string, message:string}} RunnerIssue
 * @typedef {{status:'ok'|'denied'|'failed'|'timeout'|'cancelled', code?:string,
 *   exit_code?:number|null, stdout?:string, stderr?:string, output_truncated?:boolean,
 *   termination?:string|null, duration_ms?:number, detail?:string, errors?:RunnerIssue[]}} RunnerResult
 */

/** @param {string} platform @returns {readonly string[]} */
function inheritedEnvKeys(platform) {
  return platform === 'win32' ? INHERITED_ENV_ALLOWLIST.win32 : INHERITED_ENV_ALLOWLIST.posix;
}

/** @param {string} root @param {string} candidate @returns {boolean} */
function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** @param {unknown} error @returns {string} */
function safeErrorDetail(error) {
  if (error === null || typeof error !== 'object') return String(error);
  const record = /** @type {Record<string, unknown>} */ (error);
  if (typeof record.code === 'string' && record.code.length > 0) return record.code;
  if (typeof record.message === 'string' && record.message.length > 0) return record.message;
  return 'executor spawn failed';
}

/**
 * Validate caller `allowed_env` into a plain string map.
 * @param {unknown} allowedEnv
 * @returns {{ok:true, env:Record<string,string>} | {ok:false, errors:RunnerIssue[]}}
 */
function normalizeAllowedEnv(allowedEnv) {
  if (allowedEnv === undefined || allowedEnv === null) return { ok: true, env: {} };
  if (typeof allowedEnv !== 'object' || Array.isArray(allowedEnv)) {
    return {
      ok: false,
      errors: [{ path: 'allowed_env', keyword: 'type', message: 'allowed_env must be a plain object of string values' }],
    };
  }
  const entries = Object.entries(allowedEnv);
  /** @type {RunnerIssue[]} */
  const errors = [];
  if (entries.length > LIMITS.executor_env_entries) {
    errors.push({
      path: 'allowed_env',
      keyword: 'limit',
      message: `allowed_env allows at most ${LIMITS.executor_env_entries} entries`,
    });
  }
  /** @type {Record<string,string>} */
  const env = {};
  for (const [key, value] of entries) {
    if (!ENV_NAME_PATTERN.test(key)) {
      errors.push({ path: `allowed_env.${key}`, keyword: 'name', message: 'invalid environment variable name' });
      continue;
    }
    if (isForbiddenEnvKey(key)) {
      errors.push({
        path: `allowed_env.${key}`,
        keyword: 'forbidden',
        message: 'environment key is forbidden for locked executors',
      });
      continue;
    }
    if (typeof value !== 'string') {
      errors.push({ path: `allowed_env.${key}`, keyword: 'type', message: 'environment values must be strings' });
      continue;
    }
    if (value.length > 4096 || /[\u0000-\u001f]/.test(value)) {
      errors.push({ path: `allowed_env.${key}`, keyword: 'value', message: 'invalid environment value' });
      continue;
    }
    env[key] = value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, env };
}

/**
 * Build the final child environment. Order:
 * inherited allowlist -> caller allowed_env -> lock env_fixed -> FIXED_ENV.
 * Caller keys may not shadow inherited allowlist keys or lock-fixed keys.
 * @param {{envFixed:Record<string,string>, allowedEnv:Record<string,string>, baseEnv:Record<string,string|undefined>, platform:string}} input
 * @returns {{ok:true, env:Record<string,string>} | {ok:false, errors:RunnerIssue[]}}
 */
export function buildExecutorEnv({ envFixed, allowedEnv, baseEnv, platform }) {
  const reserved = new Set([
    ...inheritedEnvKeys(platform).map((key) => key.toUpperCase()),
    ...Object.keys(envFixed).map((key) => key.toUpperCase()),
    ...Object.keys(FIXED_ENV).map((key) => key.toUpperCase()),
  ]);
  /** @type {RunnerIssue[]} */
  const errors = [];
  /** @type {Record<string,string>} */
  const env = {};
  for (const key of inheritedEnvKeys(platform)) {
    const value = baseEnv[key];
    if (typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(allowedEnv)) {
    if (reserved.has(key.toUpperCase())) {
      errors.push({
        path: `allowed_env.${key}`,
        keyword: 'reserved',
        message: 'caller environment may not shadow an inherited or lock-fixed variable',
      });
      continue;
    }
    env[key] = value;
  }
  for (const [key, value] of Object.entries(envFixed)) env[key] = value;
  for (const [key, value] of Object.entries(FIXED_ENV)) env[key] = value;
  return errors.length > 0 ? { ok: false, errors } : { ok: true, env };
}

/**
 * Terminate the process tree owned by this runner invocation.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<string>} termination mechanism actually attempted
 */
function terminateOwnedTree(child) {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve('none');
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    const absoluteTaskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    const executable = existsSync(absoluteTaskkill) ? absoluteTaskkill : 'taskkill';
    const env = {};
    for (const key of inheritedEnvKeys('win32')) {
      const value = process.env[key];
      if (typeof value === 'string') env[key] = value;
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (mechanism) => {
        if (settled) return;
        settled = true;
        resolve(mechanism);
      };
      try {
        const killer = spawn(executable, ['/PID', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
          env,
        });
        killer.on('error', () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          done('child-kill-fallback');
        });
        killer.on('close', () => done('windows-taskkill-tree'));
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        done('child-kill-fallback');
      }
    });
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return Promise.resolve('posix-process-group-sigkill');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    return Promise.resolve('child-kill-fallback');
  }
}

/**
 * Validate everything that can be checked before spawning.
 * @param {any} options
 * @returns {{ok:true, value:any} | {ok:false, result:RunnerResult}}
 */
function preflight(sourceLock, commandId, options) {
  const { root, args = [], cwd, timeout_ms, signal, allowed_env = {} } = options ?? {};

  /** @type {any} */
  let lock;
  if (typeof sourceLock === 'string') {
    const parsed = parseSourceLock(sourceLock);
    if (!parsed.ok) {
      return { ok: false, result: { status: 'denied', code: CODES.INVALID_INPUT, errors: parsed.errors } };
    }
    lock = parsed.lock;
  } else if (sourceLock !== null && typeof sourceLock === 'object') {
    lock = sourceLock;
  } else {
    return {
      ok: false,
      result: {
        status: 'denied',
        code: CODES.INVALID_INPUT,
        errors: [{ path: 'source_lock', keyword: 'type', message: 'source_lock must be parsed lock text or an object' }],
      },
    };
  }

  const rootAbs = root === undefined || root === null ? process.cwd() : path.resolve(String(root));
  const lockValidation = validateSourceLock(lock, { root: rootAbs });
  if (!lockValidation.ok) {
    return { ok: false, result: { status: 'denied', code: CODES.INVALID_INPUT, errors: lockValidation.errors } };
  }

  const executor = executorFor(lock, commandId);
  if (executor === null) {
    return {
      ok: false,
      result: {
        status: 'denied',
        code: CODES.INVALID_COMMAND,
        errors: [{ path: 'command_id', keyword: 'registered', message: 'command is not registered in source-lock' }],
      },
    };
  }

  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    return {
      ok: false,
      result: {
        status: 'denied',
        code: CODES.INVALID_INPUT,
        errors: [{ path: 'args', keyword: 'type', message: 'args must be an array of strings, never a shell string' }],
      },
    };
  }
  if (args.length > MAX_ARGS) {
    return {
      ok: false,
      result: {
        status: 'denied',
        code: CODES.INVALID_INPUT,
        errors: [{ path: 'args', keyword: 'limit', message: `args allows at most ${MAX_ARGS} entries` }],
      },
    };
  }
  for (const [index, arg] of args.entries()) {
    if (arg.length > MAX_ARG_LENGTH || /[\u0000-\u001f]/.test(arg)) {
      return {
        ok: false,
        result: {
          status: 'denied',
          code: CODES.INVALID_INPUT,
          errors: [{ path: `args[${index}]`, keyword: 'value', message: 'args entries must be plain text without control characters' }],
        },
      };
    }
  }

  const cwdAbs = cwd === undefined || cwd === null ? rootAbs : path.resolve(String(cwd));
  if (!isWithinRoot(rootAbs, cwdAbs)) {
    return {
      ok: false,
      result: {
        status: 'denied',
        code: CODES.INVALID_INPUT,
        errors: [{ path: 'cwd', keyword: 'containment', message: 'cwd must stay within the project root' }],
      },
    };
  }
  if (!existsSync(cwdAbs) || !statSync(cwdAbs).isDirectory()) {
    return { ok: false, result: { status: 'failed', code: CODES.FAILED, detail: 'cwd does not exist or is not a directory' } };
  }
  try {
    const realRoot = realpathSync(rootAbs);
    const realCwd = realpathSync(cwdAbs);
    if (!isWithinRoot(realRoot, realCwd)) {
      return {
        ok: false,
        result: {
          status: 'denied',
          code: CODES.INVALID_INPUT,
          errors: [{ path: 'cwd', keyword: 'containment', message: 'cwd resolves outside the project root' }],
        },
      };
    }
  } catch {
    return { ok: false, result: { status: 'failed', code: CODES.FAILED, detail: 'cwd could not be resolved' } };
  }

  const timeoutMs = timeout_ms === undefined ? LIMITS.executor_timeout_ms : timeout_ms;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    return {
      ok: false,
      result: {
        status: 'denied',
        code: CODES.INVALID_INPUT,
        errors: [{ path: 'timeout_ms', keyword: 'range', message: `timeout_ms must be an integer in 1..${MAX_TIMEOUT_MS}` }],
      },
    };
  }

  const allowed = normalizeAllowedEnv(allowed_env);
  if (!allowed.ok) return { ok: false, result: { status: 'denied', code: CODES.INVALID_INPUT, errors: allowed.errors } };

  const built = buildExecutorEnv({
    envFixed: executor.env_fixed,
    allowedEnv: allowed.env,
    baseEnv: process.env,
    platform: process.platform,
  });
  if (!built.ok) return { ok: false, result: { status: 'denied', code: CODES.INVALID_INPUT, errors: built.errors } };

  const executable = executor.executable_ref;
  if (!isAbsoluteLocalPath(executable)) {
    return {
      ok: false,
      result: {
        status: 'denied',
        code: CODES.INVALID_COMMAND,
        errors: [{ path: 'executable_ref', keyword: 'absolute', message: 'executable must be an absolute local path' }],
      },
    };
  }
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    return {
      ok: false,
      result: { status: 'failed', code: CODES.FAILED, detail: 'registered executable is missing or is not a file' },
    };
  }

  const signalObject = signal ?? null;
  if (signalObject !== null && typeof signalObject === 'object' && signalObject.aborted === true) {
    return { ok: false, result: { status: 'cancelled', code: CODES.CANCELLED } };
  }

  return {
    ok: true,
    value: {
      ...executor,
      rootAbs,
      cwdAbs,
      args,
      timeoutMs,
      env: built.env,
      signal: signalObject,
    },
  };
}

/**
 * Run one command registered in the source lock.
 *
 * Never rejects: every failure is a stable `status` + `code` object. `ok`
 * means the process exited 0 within the timeout and output caps; a non-zero
 * exit is `failed` with `exit_code`. The object includes captured
 * `stdout`/`stderr` (bounded), `output_truncated`, `termination` and
 * `duration_ms`; `detail`/`errors` are CLI-level diagnostics, not RPC text.
 *
 * @param {object|string} sourceLock parsed lock object or `source-lock.json` text
 * @param {string} commandId registered command id
 * @param {{root?:string, args?:string[], cwd?:string, timeout_ms?:number, signal?:AbortSignal, allowed_env?:Record<string,string>}} [options]
 * @returns {Promise<RunnerResult>}
 */
export async function runLockedCommand(sourceLock, commandId, options = {}) {
  const pre = preflight(sourceLock, commandId, options);
  if (!pre.ok) return pre.result;
  const plan = pre.value;

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let capExceeded = false;
    let termination = null;
    let killRequested = false;
    const startedAt = Date.now();

    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let settleFallback = null;
    /** @type {(() => void) | null} */
    let abortListener = null;

    const decode = (chunks) => Buffer.concat(chunks).toString('utf8');

    const finish = (/** @type {Partial<RunnerResult>} */ partial) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (settleFallback !== null) clearTimeout(settleFallback);
      if (plan.signal !== null && abortListener !== null) {
        try {
          plan.signal.removeEventListener('abort', abortListener);
        } catch {
          /* signal object may be foreign; ignore */
        }
      }
      resolve({
        ...partial,
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
        output_truncated: stdoutTruncated || stderrTruncated,
        termination,
        duration_ms: Date.now() - startedAt,
      });
    };

    const requestTreeKill = (/** @type {'timeout'|'cancelled'|'output_cap'} */ reason) => {
      if (killRequested || settled) return;
      killRequested = true;
      // Record the mechanism synchronously so a close event that beats the
      // async kill helper still reports how termination was attempted.
      termination = process.platform === 'win32' ? 'windows-taskkill-tree' : 'posix-process-group-sigkill';
      Promise.resolve()
        .then(() => terminateOwnedTree(child))
        .then((mechanism) => {
          termination = mechanism;
        })
        .catch(() => {
          termination = 'child-kill-fallback';
        });
      // Never leave the caller hanging if the platform refuses to report close.
      settleFallback = setTimeout(() => {
        if (settled) return;
        if (reason === 'timeout') finish({ status: 'timeout', code: CODES.FAILED });
        else if (reason === 'cancelled') finish({ status: 'cancelled', code: CODES.CANCELLED });
        else finish({ status: 'failed', code: CODES.LIMIT_EXCEEDED });
      }, KILL_SETTLE_FALLBACK_MS);
    };

    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(plan.executable_ref, [...plan.args_template, ...plan.args], {
        cwd: plan.cwdAbs,
        env: plan.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX group kill needs its own group; Windows tree kill uses taskkill /T.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      finish({ status: 'failed', code: CODES.FAILED, detail: safeErrorDetail(error) });
      return;
    }

    const collect = (
      /** @type {any} */ chunk,
      /** @type {Buffer[]} */ chunks,
      /** @type {'stdout'|'stderr'} */ stream,
    ) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (stream === 'stdout') {
        if (stdoutBytes >= LIMITS.executor_output_bytes) {
          stdoutTruncated = true;
          capExceeded = true;
          requestTreeKill('output_cap');
          return;
        }
        const room = LIMITS.executor_output_bytes - stdoutBytes;
        const accepted = buffer.length <= room ? buffer : buffer.subarray(0, room);
        chunks.push(accepted);
        stdoutBytes += accepted.length;
        if (accepted.length < buffer.length) {
          stdoutTruncated = true;
          capExceeded = true;
          requestTreeKill('output_cap');
        }
      } else {
        if (stderrBytes >= LIMITS.executor_output_bytes) {
          stderrTruncated = true;
          capExceeded = true;
          requestTreeKill('output_cap');
          return;
        }
        const room = LIMITS.executor_output_bytes - stderrBytes;
        const accepted = buffer.length <= room ? buffer : buffer.subarray(0, room);
        chunks.push(accepted);
        stderrBytes += accepted.length;
        if (accepted.length < buffer.length) {
          stderrTruncated = true;
          capExceeded = true;
          requestTreeKill('output_cap');
        }
      }
    };

    child.stdout?.on('data', (chunk) => collect(chunk, stdoutChunks, 'stdout'));
    child.stderr?.on('data', (chunk) => collect(chunk, stderrChunks, 'stderr'));

    child.on('error', (error) => {
      finish({ status: 'failed', code: CODES.FAILED, detail: safeErrorDetail(error) });
    });

    child.on('close', (exitCode) => {
      if (timedOut) {
        finish({ status: 'timeout', code: CODES.FAILED, exit_code: exitCode === null ? null : exitCode });
        return;
      }
      if (cancelled) {
        finish({ status: 'cancelled', code: CODES.CANCELLED, exit_code: exitCode === null ? null : exitCode });
        return;
      }
      if (capExceeded) {
        finish({ status: 'failed', code: CODES.LIMIT_EXCEEDED, exit_code: exitCode === null ? null : exitCode });
        return;
      }
      if (exitCode === 0) {
        finish({ status: 'ok', exit_code: 0 });
        return;
      }
      finish({ status: 'failed', code: CODES.FAILED, exit_code: exitCode === null ? null : exitCode });
    });

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      requestTreeKill('timeout');
    }, plan.timeoutMs);

    if (plan.signal !== null) {
      abortListener = () => {
        if (settled) return;
        cancelled = true;
        requestTreeKill('cancelled');
      };
      try {
        plan.signal.addEventListener('abort', abortListener, { once: true });
      } catch {
        /* signal is not an EventTarget; preflight treated it as optional */
      }
    }
  });
}

/**
 * Remote-reference patterns for offline assets (SVG/HTML/JSON/CSS text).
 * These are *data* checks: a match means the generated artifact references a
 * remote resource even though the local network mode is `none`.
 */
const REMOTE_REF_PATTERNS = Object.freeze([
  { keyword: 'http_scheme', label: 'http(s):// URL', pattern: /https?:\/\//giu },
  { keyword: 'ws_scheme', label: 'ws(s):// URL', pattern: /wss?:\/\//giu },
  { keyword: 'ftp_scheme', label: 'ftp:// URL', pattern: /ftp:\/\//giu },
  { keyword: 'protocol_relative_css', label: 'protocol-relative CSS url()', pattern: /url\(\s*['"]?\s*\/\//giu },
  {
    keyword: 'protocol_relative_attr',
    label: 'protocol-relative src/href attribute',
    pattern: /\b(?:src|href)\s*=\s*['"]\s*\/\//giu,
  },
]);

const MAX_REMOTE_REF_FINDINGS = 32;

/**
 * Scan text that will ship inside a local artifact for remote references.
 * Never fetches or parses: pure string policy. A finding is not a network
 * connection; it means the artifact would try to reach the network when opened.
 * @param {string} text
 * @returns {{ok:boolean, errors:{path:string, keyword:string, message:string, offset?:number}[]}}
 */
export function assertNoRemoteRefs(text) {
  if (typeof text !== 'string') {
    return { ok: false, errors: [{ path: '$', keyword: 'type', message: 'text must be a string' }] };
  }
  /** @type {{path:string, keyword:string, message:string, offset?:number}[]} */
  const errors = [];
  for (const { keyword, label, pattern } of REMOTE_REF_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (errors.length >= MAX_REMOTE_REF_FINDINGS) {
        errors.push({
          path: '$',
          keyword: 'scan_limit',
          message: `stopped after ${MAX_REMOTE_REF_FINDINGS} remote-reference findings`,
        });
        return { ok: false, errors };
      }
      errors.push({
        path: '$',
        keyword,
        message: `${label} at offset ${match.index ?? 0}`,
        offset: match.index ?? 0,
      });
    }
  }
  errors.sort((left, right) => (left.offset ?? 0) - (right.offset ?? 0));
  return { ok: errors.length === 0, errors };
}
