/**
 * T5 path identity tests (DIA-08): realpath + reparse/junction detection,
 * UNC / outside-root rejection and entry re-verification.
 *
 * All temporary directories come from `fs.mkdtemp`; the Windows junction test
 * uses `mklink /J` and skips with an explicit recorded reason when the host
 * cannot create junctions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  pathIdentityDigest,
  isWithinRoot,
  assertPathAllowed,
  verifyDocumentEntry,
} from '../src/editor/access.mjs';
import { tempRoot } from './fixtures/store/helpers.mjs';

/**
 * Create an NTFS junction. Returns {ok:true} or {ok:false, reason} so the test
 * can skip explicitly instead of silently passing.
 * @param {string} linkPath @param {string} targetPath
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function tryMakeJunction(linkPath, targetPath) {
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, targetPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true };
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? '');
    return { ok: false, reason: `mklink /J unavailable: ${stderr.trim().slice(0, 200)}` };
  }
}

/** @param {string} digest @returns {boolean} */
function isSha256Hex(digest) {
  return typeof digest === 'string' && /^[0-9a-f]{64}$/u.test(digest);
}

test('pathIdentityDigest: stable 64-hex identity for the same real directory', (t) => {
  const root = tempRoot(t);
  const directory = path.join(root, 'artifact');
  fs.mkdirSync(directory);
  const first = pathIdentityDigest(directory);
  const second = pathIdentityDigest(directory);
  assert.ok(isSha256Hex(first));
  assert.equal(first, second);
});

test('pathIdentityDigest: different directories and files get different identities', (t) => {
  const root = tempRoot(t);
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  fs.mkdirSync(left);
  fs.mkdirSync(right);
  const file = path.join(root, 'file.txt');
  fs.writeFileSync(file, 'x');
  const digests = new Set([
    pathIdentityDigest(left),
    pathIdentityDigest(right),
    pathIdentityDigest(file),
  ]);
  assert.equal(digests.size, 3);
});

test('pathIdentityDigest: rejects relative, UNC and device paths', () => {
  assert.throws(() => pathIdentityDigest('relative/path'), /absolute|denied/i);
  assert.throws(() => pathIdentityDigest('\\\\server\\share\\artifact'), /UNC|device/i);
  assert.throws(() => pathIdentityDigest('\\\\?\\C:\\artifact'), /UNC|device/i);
});

test('isWithinRoot: root itself and descendants are inside, siblings are not', (t) => {
  const root = tempRoot(t);
  const inside = path.join(root, 'inside');
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'file.txt'), 'x');
  const sibling = tempRoot(t);
  assert.equal(isWithinRoot(root, root), true);
  assert.equal(isWithinRoot(root, inside), true);
  assert.equal(isWithinRoot(root, path.join(inside, 'file.txt')), true);
  assert.equal(isWithinRoot(root, sibling), false);
  assert.equal(isWithinRoot(root, 'relative'), false);
});

test('isWithinRoot: prefix-similar sibling directory is not inside', (t) => {
  const parent = tempRoot(t);
  const root = path.join(parent, 'a');
  const sibling = path.join(parent, 'ab');
  fs.mkdirSync(root);
  fs.mkdirSync(sibling);
  assert.equal(isWithinRoot(root, sibling), false);
});

test('assertPathAllowed: accepts a descendant and reports real path + identity', (t) => {
  const root = tempRoot(t);
  const child = path.join(root, 'pkg');
  fs.mkdirSync(child);
  const result = assertPathAllowed(root, child);
  assert.equal(result.ok, true);
  assert.equal(result.real_path, fs.realpathSync.native(child));
  assert.ok(isSha256Hex(result.path_identity_digest));
});

test('assertPathAllowed: rejects outside-root, UNC, relative and missing candidates', (t) => {
  const root = tempRoot(t);
  const outside = tempRoot(t);
  fs.writeFileSync(path.join(outside, 'file.txt'), 'x');
  const outsideResult = assertPathAllowed(root, path.join(outside, 'file.txt'));
  assert.equal(outsideResult.ok, false);
  assert.ok(outsideResult.errors.some((issue) => issue.keyword === 'outside_root'));

  const uncResult = assertPathAllowed(root, '\\\\server\\share\\artifact');
  assert.equal(uncResult.ok, false);
  assert.ok(uncResult.errors.some((issue) => issue.keyword === 'unc_path'));

  const relativeResult = assertPathAllowed(root, 'relative/child');
  assert.equal(relativeResult.ok, false);
  assert.ok(relativeResult.errors.some((issue) => issue.keyword === 'not_absolute'));

  const missingResult = assertPathAllowed(root, path.join(root, 'missing'));
  assert.equal(missingResult.ok, false);
});

test('verifyDocumentEntry: re-checks active flag, digest and local binding', (t) => {
  const root = tempRoot(t);
  const artifact = path.join(root, 'artifact');
  fs.mkdirSync(artifact);
  const digest = pathIdentityDigest(artifact);
  const baseEntry = {
    document_ref: 'doc-1',
    document_id: 'doc-001',
    scope_ref: 'scope-1',
    scope_generation: 0,
    path_identity_digest: digest,
    mode: 'edit',
    active: true,
    path: artifact,
  };
  const ok = verifyDocumentEntry(baseEntry);
  assert.equal(ok.ok, true);
  assert.equal(ok.real_path, fs.realpathSync.native(artifact));

  const inactive = verifyDocumentEntry({ ...baseEntry, active: false });
  assert.equal(inactive.ok, false);
  assert.ok(inactive.errors.some((issue) => issue.keyword === 'inactive'));

  const wrongDigest = verifyDocumentEntry({ ...baseEntry, path_identity_digest: 'f'.repeat(64) });
  assert.equal(wrongDigest.ok, false);
  assert.ok(wrongDigest.errors.some((issue) => issue.keyword === 'identity_mismatch'));

  const unbound = verifyDocumentEntry({ ...baseEntry, path: undefined });
  assert.equal(unbound.ok, false);
  assert.ok(unbound.errors.some((issue) => issue.keyword === 'unbound'));

  // A replaced directory has a different identity than the recorded digest.
  const replaced = path.join(root, 'artifact-2');
  fs.mkdirSync(replaced);
  const replacedEntry = verifyDocumentEntry({ ...baseEntry, path: replaced });
  assert.equal(replacedEntry.ok, false);
  assert.ok(replacedEntry.errors.some((issue) => issue.keyword === 'identity_mismatch'));
});

test('junction negative: reparse point inside a registered root is rejected', (t) => {
  const root = tempRoot(t);
  const outside = path.join(tempRoot(t), 'outside-target');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const link = path.join(root, 'link');
  const created = tryMakeJunction(link, outside);
  if (created.ok !== true) {
    t.skip(created.reason);
    return;
  }
  const result = assertPathAllowed(root, link);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((issue) => issue.keyword === 'reparse_point'),
    `expected reparse_point, got ${JSON.stringify(result.errors)}`,
  );
  assert.throws(() => pathIdentityDigest(link), /junction|reparse|symbolic/i);
  assert.equal(isWithinRoot(root, path.join(link, 'secret.txt')), false);
  // A document entry bound to the junction is rejected even though the target
  // is a directory.
  const entry = verifyDocumentEntry({
    document_ref: 'doc-1',
    document_id: 'doc-001',
    scope_ref: 'scope-1',
    scope_generation: 0,
    path_identity_digest: pathIdentityDigest(outside),
    mode: 'edit',
    active: true,
    path: link,
  });
  assert.equal(entry.ok, false);
  assert.ok(entry.errors.some((issue) => issue.keyword === 'reparse_point'));
});

test('junction negative: reparse point whose target is inside the root is still rejected', (t) => {
  const root = tempRoot(t);
  const target = path.join(root, 'real-target');
  fs.mkdirSync(target);
  const link = path.join(root, 'alias');
  const created = tryMakeJunction(link, target);
  if (created.ok !== true) {
    t.skip(created.reason);
    return;
  }
  const result = assertPathAllowed(root, link);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((issue) => issue.keyword === 'reparse_point'));
  // The lexical ancestor walk catches a junction even as a path component.
  assert.throws(() => pathIdentityDigest(path.join(link, 'child')), /junction|reparse|symbolic|denied/i);
});
