/**
 * T3 — source-lock contract tests (DIA-05).
 *
 * Proves the outlet policy file is parsed strictly, that investigation-only
 * sources are never reported as adopted/merged, that adopted-byte verification
 * recomputes sha256 from disk, and that unregistered commands cannot be
 * resolved to an executor.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from '../src/canonical.mjs';
import { validateSchema } from '../src/schema.mjs';
import {
  adoptionSummary,
  executorFor,
  isAbsoluteLocalPath,
  isValidRelativeRef,
  parseSourceLock,
  SOURCE_LOCK_SCHEMA,
  treeDigestOf,
  validateSourceLock,
  verifyLockedFiles,
} from '../src/source-lock.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, '..');
const SOURCE_LOCK_PATH = path.join(PROJECT_ROOT, 'source-lock.json');
const AUTHORITATIVE_SCHEMA_PATH = path.join(PROJECT_ROOT, 'schemas', 'source-lock.schema.json');

/** A minimal lock that follows the v1 schema; individual tests override parts. */
function baseLock(overrides = {}) {
  const lock = {
    schema_version: 1,
    runtime: {
      node: '>=24.9.0',
      tested_node: '26.13.0',
      tested_node_sha256: null,
      host_node: '24.21.0',
      package_manager: 'npm-compatible; no runtime dependencies',
    },
    host: {
      product: 'DeepSeek Harness',
      version: '0.2.1-rc.5',
      electron: '44.7.0',
      host_protocol_version: 4,
      app_asar_sha256: 'e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915',
      installed_checkout: 'E:/dsh/resources/app.asar (read-only interface audit; no Host code vendored)',
      verified_interfaces: [],
    },
    sources: [
      {
        id: 'own-design',
        kind: 'design',
        repository: 'workspace:06-local-diagrams',
        commit: null,
        version: 'DIA-DESIGN-2',
        package: null,
        artifact_sha256: null,
        license: null,
        license_ref: 'docs/software-design.md',
        adopted_files: [],
        resource_manifest_ref: null,
      },
    ],
    commands: [],
    evidence_refs: ['docs/implementation-route.md'],
    limits: { network_mode: 'none', remote_services: [], model_services: [], credential_access: false },
  };
  return deepMerge(lock, overrides);
}

function deepMerge(target, patch) {
  if (patch === undefined) return target;
  if (Array.isArray(patch)) return patch;
  if (patch !== null && typeof patch === 'object' && target !== null && typeof target === 'object' && !Array.isArray(target)) {
    const out = { ...target };
    for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(target[key], value);
    return out;
  }
  return patch;
}

function lockText(lock) {
  return JSON.stringify(lock, null, 2);
}

/**
 * Create a temp root with one adopted file plus a resource manifest that pins
 * its bytes, and return a matching adopted source.
 */
function makeAdoptedSource(root) {
  mkdirSync(path.join(root, 'vendor'), { recursive: true });
  const filePath = path.join(root, 'vendor', 'locked-executor.mjs');
  const bytes = Buffer.from('// adopted fixture bytes\nexport const locked = true;\n', 'utf8');
  writeFileSync(filePath, bytes);
  const fileSha256 = sha256Hex(bytes);
  const artifactSha256 = treeDigestOf([{ path: 'vendor/locked-executor.mjs', sha256: fileSha256 }]);
  writeFileSync(
    path.join(root, 'vendor', 'resource-manifest.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        files: [
          {
            relative_path: 'vendor/locked-executor.mjs',
            media_type: 'text/javascript',
            sha256: fileSha256,
            size: bytes.length,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return {
    source: {
      id: 'fixture-adopted',
      kind: 'test-fixture',
      repository: 'workspace:tests/fixtures/executor',
      commit: null,
      version: '1.0.0',
      package: null,
      artifact_sha256: artifactSha256,
      license: 'Apache-2.0',
      license_ref: 'vendor/LICENSE',
      adopted_files: ['vendor/locked-executor.mjs'],
      resource_manifest_ref: 'vendor/resource-manifest.json',
    },
    fileSha256,
    artifactSha256,
    filePath,
  };
}

function tempRoot(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'dia-source-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('parses the repository source-lock.json and reports zero adopted sources', () => {
  const text = readFileSync(SOURCE_LOCK_PATH, 'utf8');
  const parsed = parseSourceLock(text);
  assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify(parsed.errors));
  assert.equal(parsed.lock.sources.length, 5);
  assert.equal(parsed.lock.commands.length, 0);
  assert.equal(parsed.lock.limits.network_mode, 'none');

  const summary = adoptionSummary(parsed.lock);
  assert.equal(summary.adopted_count, 0);
  assert.equal(summary.not_adopted_count, 5);
  for (const source of summary.sources) {
    assert.equal(source.status, 'not_adopted');
    assert.equal(source.status === 'merged', false);
  }
  // The host baseline has an artifact sha but no adopted files: still not adopted.
  const hostBaseline = summary.sources.find((source) => source.id === 'dsh-host-baseline');
  assert.equal(hostBaseline.status, 'not_adopted');
  assert.equal(hostBaseline.artifact_pinned, true);
});

test('verifyLockedFiles on the real lock verifies nothing and claims nothing', () => {
  const parsed = parseSourceLock(readFileSync(SOURCE_LOCK_PATH, 'utf8'));
  assert.equal(parsed.ok, true);
  const verified = verifyLockedFiles(parsed.lock, PROJECT_ROOT);
  assert.equal(verified.ok, true, JSON.stringify(verified.errors));
  assert.deepEqual(verified.files, []);
  assert.equal(verified.sources.every((source) => source.status === 'not_adopted'), true);
});

test('parseSourceLock rejects malformed JSON and non-string input', () => {
  assert.equal(parseSourceLock('{not json').ok, false);
  assert.equal(parseSourceLock(42).ok, false);
  const notObject = parseSourceLock('[]');
  assert.equal(notObject.ok, false);
});

test('schema is strict: unknown properties, missing fields, wrong consts are rejected', () => {
  const withExtraTopLevel = baseLock({ schema_version: 1, extra: true });
  assert.equal(validateSourceLock(withExtraTopLevel).ok, false);

  const missingSources = baseLock();
  delete missingSources.sources;
  assert.equal(validateSourceLock(missingSources).ok, false);

  const wrongVersion = baseLock({ schema_version: 2 });
  assert.equal(validateSourceLock(wrongVersion).ok, false);

  const mergedFlag = baseLock();
  mergedFlag.sources[0].merged = true;
  const mergedResult = validateSourceLock(mergedFlag);
  assert.equal(mergedResult.ok, false);
  assert.equal(mergedResult.errors.some((error) => error.path.includes('sources[0].merged')), true);

  const missingField = baseLock();
  delete missingField.sources[0].adopted_files;
  assert.equal(validateSourceLock(missingField).ok, false);

  // Note is the single tolerated annotation but has no trust meaning.
  const withNote = baseLock();
  withNote.sources[0].note = 'human note only';
  assert.equal(validateSourceLock(withNote).ok, true);
});

test('limits block must stay closed: no remote/model services, no credential access', () => {
  const remote = baseLock();
  remote.limits.remote_services = ['https://example.invalid'];
  assert.equal(validateSourceLock(remote).ok, false);

  const model = baseLock();
  model.limits.model_services = ['some-model-service'];
  assert.equal(validateSourceLock(model).ok, false);

  const credentials = baseLock();
  credentials.limits.credential_access = true;
  assert.equal(validateSourceLock(credentials).ok, false);

  const networked = baseLock();
  networked.limits.network_mode = 'allowlist';
  assert.equal(validateSourceLock(networked).ok, false);
});

test('rejects duplicate source ids and duplicate command ids', () => {
  const duplicateSources = baseLock();
  duplicateSources.sources.push({ ...duplicateSources.sources[0] });
  const sourceResult = validateSourceLock(duplicateSources);
  assert.equal(sourceResult.ok, false);
  assert.equal(sourceResult.errors.some((error) => error.keyword === 'unique'), true);

  const duplicateCommands = baseLock({
    commands: [
      { id: 'same-command', executable_ref: process.execPath, args_template: [], env_fixed: {} },
      { id: 'same-command', executable_ref: process.execPath, args_template: [], env_fixed: {} },
    ],
  });
  const commandResult = validateSourceLock(duplicateCommands);
  assert.equal(commandResult.ok, false);
  assert.equal(commandResult.errors.some((error) => error.keyword === 'unique'), true);
});

test('rejects unregistered executable shapes and unsafe env_fixed', () => {
  const relative = baseLock({
    commands: [{ id: 'relative', executable_ref: './runtime/node.exe', args_template: [], env_fixed: {} }],
  });
  assert.equal(validateSourceLock(relative).ok, false);

  const remoteShare = baseLock({
    commands: [{ id: 'unc', executable_ref: '\\\\server\\share\\node.exe', args_template: [], env_fixed: {} }],
  });
  assert.equal(validateSourceLock(remoteShare).ok, false);

  const injection = baseLock({
    commands: [
      {
        id: 'inject',
        executable_ref: process.execPath,
        args_template: [],
        env_fixed: { NODE_OPTIONS: '--require=evil.js' },
      },
    ],
  });
  assert.equal(validateSourceLock(injection).ok, false);

  const updateCheck = baseLock({
    commands: [
      {
        id: 'update-check',
        executable_ref: process.execPath,
        args_template: [],
        env_fixed: { ARCHIFY_UPDATE_CHECK_DISABLED: '0' },
      },
    ],
  });
  assert.equal(validateSourceLock(updateCheck).ok, false);
});

test('executorFor resolves only valid registered commands and returns copies', () => {
  const lock = baseLock({
    commands: [
      {
        id: 'fixture-exec',
        executable_ref: process.execPath,
        args_template: ['tests/fixtures/executor/inspect.mjs'],
        env_fixed: { FIXTURE_FIXED: 'yes' },
      },
    ],
  });
  const executor = executorFor(lock, 'fixture-exec');
  assert.notEqual(executor, null);
  assert.equal(executor.executable_ref, process.execPath);
  assert.deepEqual(executor.args_template, ['tests/fixtures/executor/inspect.mjs']);
  assert.deepEqual(executor.env_fixed, { FIXTURE_FIXED: 'yes' });

  executor.args_template.push('mutated');
  assert.deepEqual(executorFor(lock, 'fixture-exec').args_template, ['tests/fixtures/executor/inspect.mjs']);

  assert.equal(executorFor(lock, 'not-registered'), null);
  assert.equal(executorFor(lock, ''), null);
  assert.equal(executorFor(null, 'fixture-exec'), null);

  const badCommand = baseLock({
    commands: [{ id: 'bad', executable_ref: 'relative/node.exe', args_template: [], env_fixed: {} }],
  });
  assert.equal(executorFor(badCommand, 'bad'), null);
});

test('relative-ref helpers reject escapes, absolute paths, and URL schemes', () => {
  assert.equal(isValidRelativeRef('docs/implementation-route.md'), true);
  assert.equal(isValidRelativeRef('vendor\\lib\\file.mjs'), true);
  for (const bad of ['../escape', '/abs/path', 'C:\\abs', 'https://example.invalid/x', 'a//b', 'a/./b', 'a\u0000b', '']) {
    assert.equal(isValidRelativeRef(bad), false, bad);
  }
  assert.equal(isAbsoluteLocalPath(process.execPath), true);
  assert.equal(isAbsoluteLocalPath('./node'), false);
  assert.equal(isAbsoluteLocalPath('\\\\server\\share\\node.exe'), false);

  const escape = baseLock();
  escape.sources[0].adopted_files = ['../escape.mjs'];
  assert.equal(validateSourceLock(escape).ok, false);

  const url = baseLock();
  url.sources[0].adopted_files = ['https://example.invalid/file.mjs'];
  assert.equal(validateSourceLock(url).ok, false);

  const evidenceEscape = baseLock({ evidence_refs: ['../secret.md'] });
  assert.equal(validateSourceLock(evidenceEscape).ok, false);
});

test('adopted sources need tree digest, license, and license_ref', () => {
  const missingProof = baseLock();
  missingProof.sources[0].adopted_files = ['vendor/file.mjs'];
  const result = validateSourceLock(missingProof);
  assert.equal(result.ok, false);
  const keywords = result.errors.map((error) => error.path);
  assert.equal(keywords.some((entry) => entry.includes('artifact_sha256')), true);
  assert.equal(keywords.some((entry) => entry.includes('license')), true);
});

test('adoption proof requires the adopted file to exist under root', (t) => {
  const root = tempRoot(t);
  const fixture = makeAdoptedSource(root);
  const lock = baseLock({ sources: [fixture.source] });

  assert.equal(validateSourceLock(lock, { root, requireAdoptionProof: true }).ok, true);
  assert.equal(validateSourceLock(lock, { root }).ok, true);

  const missingLock = baseLock({ sources: [{ ...fixture.source, adopted_files: ['vendor/not-there.mjs'] }] });
  const missing = validateSourceLock(missingLock, { root, requireAdoptionProof: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.errors.some((error) => error.keyword === 'exists'), true);
});

test('verifyLockedFiles recomputes adopted sha256 and verifies the tree digest', (t) => {
  const root = tempRoot(t);
  const fixture = makeAdoptedSource(root);
  const lock = baseLock({ sources: [fixture.source] });

  const verified = verifyLockedFiles(lock, root);
  assert.equal(verified.ok, true, JSON.stringify(verified.errors));
  assert.equal(verified.files.length, 1);
  assert.equal(verified.files[0].sha256, fixture.fileSha256);
  assert.equal(verified.files[0].matches, true);
  assert.equal(verified.sources[0].status, 'adopted');
  assert.equal(verified.sources[0].tree_matches, true);

  const summary = adoptionSummary(lock);
  assert.equal(summary.adopted_count, 1);
  assert.equal(summary.sources[0].status, 'adopted');
});

test('verifyLockedFiles detects tampered bytes and a broken tree digest', (t) => {
  const root = tempRoot(t);
  const fixture = makeAdoptedSource(root);
  const lock = baseLock({ sources: [fixture.source] });

  writeFileSync(fixture.filePath, '// tampered bytes\n', 'utf8');
  const verified = verifyLockedFiles(lock, root);
  assert.equal(verified.ok, false);
  assert.equal(verified.files[0].matches, false);
  const keywords = verified.errors.map((error) => error.keyword);
  assert.equal(keywords.includes('digest_mismatch'), true);
  assert.equal(keywords.includes('tree_digest_mismatch'), true);
});

test('verifyLockedFiles reports missing files and unpinned files, never silent success', (t) => {
  const root = tempRoot(t);
  const fixture = makeAdoptedSource(root);

  const missingLock = baseLock({ sources: [{ ...fixture.source, adopted_files: ['vendor/missing.mjs'] }] });
  const missing = verifyLockedFiles(missingLock, root);
  assert.equal(missing.ok, false);
  assert.equal(missing.errors.some((error) => error.keyword === 'missing'), true);

  // Same valid bytes, but no resource manifest pins them: digest is recomputed
  // yet NOT verified, so the file must not be reported as matching.
  const unpinnedLock = baseLock({ sources: [{ ...fixture.source, resource_manifest_ref: null }] });
  const unpinned = verifyLockedFiles(unpinnedLock, root);
  assert.equal(unpinned.ok, false);
  assert.equal(unpinned.files[0].matches, false);
  assert.equal(unpinned.files[0].expected_sha256, null);
  assert.equal(unpinned.errors.some((error) => error.keyword === 'unpinned'), true);
});

test('treeDigestOf is deterministic and normalizes separators', () => {
  const left = treeDigestOf([
    { path: 'b.mjs', sha256: 'b'.repeat(64) },
    { path: 'a\\c.mjs', sha256: 'a'.repeat(64) },
  ]);
  const right = treeDigestOf([
    { path: 'a/c.mjs', sha256: 'a'.repeat(64) },
    { path: 'b.mjs', sha256: 'b'.repeat(64) },
  ]);
  assert.equal(left, right);
  assert.match(left, /^[0-9a-f]{64}$/);
});

test('parseSourceLock tolerates a leading UTF-8 BOM without weakening JSON strictness', () => {
  const text = readFileSync(SOURCE_LOCK_PATH, 'utf8');
  const bomText = `\ufeff${text}`;
  assert.equal(parseSourceLock(bomText).ok, true);
  assert.equal(parseSourceLock(bomText.slice(2)).ok, false);
});

test('shared structural schema and this parser both accept the repository lock and a normal lock', () => {
  // `schemas/source-lock.schema.json` is the contracts-owned authoritative
  // structural artifact; this module owns outlet semantics. Both must accept
  // the same ordinary locks, or integration would depend on which validator ran.
  const authoritative = JSON.parse(readFileSync(AUTHORITATIVE_SCHEMA_PATH, 'utf8'));
  const repositoryLock = JSON.parse(readFileSync(SOURCE_LOCK_PATH, 'utf8'));
  assert.deepEqual(validateSchema(authoritative, repositoryLock), []);
  assert.equal(parseSourceLock(readFileSync(SOURCE_LOCK_PATH, 'utf8')).ok, true);

  const normalLock = baseLock({
    commands: [
      {
        id: 'normal-command',
        executable_ref: process.execPath,
        args_template: ['tests/fixtures/executor/inspect.mjs'],
        env_fixed: { FIXTURE_FIXED: 'yes' },
      },
    ],
  });
  assert.deepEqual(validateSchema(authoritative, normalLock), []);
  assert.equal(validateSourceLock(normalLock).ok, true);
});

test('intentional extra outlet strictness beyond the shared structural schema is documented by tests', () => {
  const authoritative = JSON.parse(readFileSync(AUTHORITATIVE_SCHEMA_PATH, 'utf8'));

  // Structurally expressible, policy-rejected: remote services declared despite
  // network_mode=none; the parser must refuse rather than silently accept.
  const remote = baseLock();
  remote.limits.remote_services = ['https://example.invalid'];
  assert.deepEqual(validateSchema(authoritative, remote), []);
  const remoteResult = validateSourceLock(remote);
  assert.equal(remoteResult.ok, false);
  assert.equal(remoteResult.errors.some((error) => error.keyword === 'outlet'), true);

  // Structural schema does not require runtime/host/limits blocks; this parser
  // does, because an unpinned capability lock must not pass as a verified one.
  const noRuntime = baseLock();
  delete noRuntime.runtime;
  assert.deepEqual(validateSchema(authoritative, noRuntime), []);
  assert.equal(validateSourceLock(noRuntime).ok, false);

  // Both validators reject a null repository (source identity must be stated).
  const nullRepository = baseLock();
  nullRepository.sources[0].repository = null;
  assert.notDeepEqual(validateSchema(authoritative, nullRepository), []);
  assert.equal(validateSourceLock(nullRepository).ok, false);
});

test('exports a frozen strict schema for review', () => {
  assert.equal(SOURCE_LOCK_SCHEMA.type, 'object');
  assert.equal(SOURCE_LOCK_SCHEMA.additionalProperties, false);
  assert.deepEqual(SOURCE_LOCK_SCHEMA.required, [
    'schema_version',
    'runtime',
    'sources',
    'commands',
    'evidence_refs',
    'limits',
  ]);
  assert.equal(Object.isFrozen(SOURCE_LOCK_SCHEMA), true);
});
