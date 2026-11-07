#!/usr/bin/env node
/**
 * 06 local diagrams — runtime / source-lock identity check (T3).
 *
 * Prints one JSON object with:
 * - the running Node version, whether it satisfies the lock's `runtime.node`
 *   requirement (never below 24.9.0), platform/arch;
 * - the sha256 of the actual Node executable bytes (`process.execPath`);
 * - `source-lock.json` runtime/host identity, adoption status (investigation
 *   sources stay `not_adopted`), and the adopted-file verification result;
 * - explicit limitations (this proves identity, not OS-level outlet isolation).
 *
 * Exit codes: 0 = identity printed and requirements met; 1 = Node below the
 * required version; 2 = source-lock missing/unreadable/invalid.
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from '../src/canonical.mjs';
import { adoptionSummary, parseSourceLock, SOURCE_LOCK_FILENAME, verifyLockedFiles } from '../src/source-lock.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..');
const BASELINE_NODE = { major: 24, minor: 9, patch: 0 };

/** @param {string} text @param {string} flag @returns {string|null} */
function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

/** @param {string} text @returns {{major:number, minor:number, patch:number}[]|null} */
function parseRequirement(text) {
  if (typeof text !== 'string') return null;
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** @param {number[]} left @param {number[]} right @returns {number} */
function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

/** @param {string} text @returns {number[]|null} */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** @param {string} filePath @returns {string|null} */
function sha256File(filePath) {
  let handle;
  try {
    handle = openSync(filePath, 'r');
  } catch {
    return null;
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } catch {
    return null;
  } finally {
    closeSync(handle);
  }
  return hash.digest('hex');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    process.stdout.write(
      [
        'usage: node tools/check-runtime.mjs [--lock <path>] [--json]',
        '',
        'Prints node/platform/node-binary-sha256 plus source-lock runtime/host identity as JSON.',
        'Exit 0 = requirements met; 1 = node below requirement; 2 = source-lock missing/invalid.',
        '',
      ].join('\n'),
    );
    return 0;
  }

  const lockPath = path.resolve(PROJECT_ROOT, argValue(argv, '--lock') ?? SOURCE_LOCK_FILENAME);
  const nodeVersion = process.versions.node;
  const actualVersion = parseVersion(nodeVersion);
  const execPath = process.execPath;
  const binarySha256 = sha256File(execPath);
  let binarySize = null;
  try {
    binarySize = statSync(execPath).size;
  } catch {
    binarySize = null;
  }

  /** @type {any} */
  const report = {
    schema_version: 1,
    tool: 'check-runtime',
    command: `node tools/check-runtime.mjs${argv.length > 0 ? ` ${argv.join(' ')}` : ''}`,
    generated_at: new Date().toISOString(),
    node: {
      version: nodeVersion,
      exec_path: execPath,
      sha256: binarySha256,
      size_bytes: binarySize,
      requirement: null,
      requirement_source: 'baseline',
      satisfies: false,
    },
    platform: {
      platform: process.platform,
      arch: process.arch,
      release: process.release?.name ?? null,
      libc: process.report?.getReport?.()?.header?.glibcVersionRuntime ?? null,
    },
    source_lock: {
      path: lockPath,
      exists: false,
      sha256: null,
      parsed: false,
      errors: [],
      runtime: null,
      host: null,
      adoption: null,
      locked_files: null,
    },
    limitations: [
      'Identity check only: prints digests and requirements; it does not prove OS-level network isolation, browser CSP, or Host RPC behavior.',
      'Node binary sha256 is computed from process.execPath bytes for the record; the lock currently does not pin tested_node_sha256 unless it is non-null.',
      'source-lock.json is Lead-owned; this tool never edits it.',
    ],
  };

  let exitCode = 0;

  let lockText = null;
  try {
    lockText = readFileSync(lockPath, 'utf8');
    report.source_lock.exists = true;
    report.source_lock.sha256 = sha256Hex(lockText);
  } catch (error) {
    report.source_lock.errors = [
      {
        path: '$.source_lock',
        keyword: 'missing',
        message: `cannot read source-lock.json: ${error instanceof Error ? error.code ?? error.message : String(error)}`,
      },
    ];
    exitCode = 2;
  }

  let lock = null;
  if (lockText !== null) {
    const parsed = parseSourceLock(lockText);
    if (parsed.ok) {
      lock = parsed.lock;
      report.source_lock.parsed = true;
      report.source_lock.runtime = lock.runtime;
      report.source_lock.host = lock.host ?? null;
      report.source_lock.adoption = adoptionSummary(lock);
      const verified = verifyLockedFiles(lock, PROJECT_ROOT);
      report.source_lock.locked_files = {
        ok: verified.ok,
        files_count: verified.files.length,
        sources: verified.sources,
        errors: verified.errors,
      };
    } else {
      report.source_lock.errors = parsed.errors;
      exitCode = 2;
    }
  }

  const lockRequirement = parseRequirement(report.source_lock.runtime?.node);
  const requirement = lockRequirement ?? [BASELINE_NODE.major, BASELINE_NODE.minor, BASELINE_NODE.patch];
  report.node.requirement = requirement.join('.');
  report.node.requirement_source = lockRequirement === null ? 'baseline' : 'source-lock.runtime.node';
  report.node.satisfies = actualVersion === null ? false : compareVersion(actualVersion, requirement) >= 0;
  if (!report.node.satisfies) exitCode = 1;

  report.source_lock.pin = lock
    ? {
        tested_node: lock.runtime.tested_node,
        tested_node_matches_actual: parseVersion(lock.runtime.tested_node) !== null
          && actualVersion !== null
          && compareVersion(parseVersion(lock.runtime.tested_node), actualVersion) === 0,
        tested_node_sha256: lock.runtime.tested_node_sha256,
        tested_node_sha256_pinned: lock.runtime.tested_node_sha256 !== null,
      }
    : null;

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return exitCode;
}

process.exitCode = main();
