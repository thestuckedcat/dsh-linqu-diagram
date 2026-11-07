/**
 * T5 access registry tests (DIA-08 / DIA-RPC-01):
 * strict DiagramAccessRegistryV1, register/revoke/lookup, path identity
 * re-checks on every lookup, owner-login-alone-never-grants-document-access,
 * local registry persistence and the trusted CLI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  createAccessRegistry,
  loadRegistryFromDirectory,
  saveRegistryToDirectory,
  pathIdentityDigest,
} from '../src/editor/access.mjs';
import { validateAccessRegistry } from '../src/contracts.mjs';
import { createDocumentStore } from '../src/editor/document-store.mjs';
import {
  buildArtifactPackage,
  testRegistry,
  ownerCaller,
  fakeClock,
  tempRoot,
} from './fixtures/store/helpers.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} root @param {string} artifactDir */
function registryWithDocument(root, artifactDir) {
  return testRegistry({ root, artifact_directory: artifactDir });
}

test('createAccessRegistry: empty registry is a valid DiagramAccessRegistryV1', () => {
  const registry = createAccessRegistry();
  assert.deepEqual(registry.exportToJson(), {
    schema_version: 1,
    revision: 0,
    contexts: [],
    documents: [],
    output_roots: [],
  });
  assert.equal(validateAccessRegistry(registry.exportToJson()).ok, true);
});

test('createAccessRegistry: rejects an invalid / extra-property initial registry', () => {
  assert.throws(
    () =>
      createAccessRegistry({
        schema_version: 1,
        revision: 0,
        contexts: [],
        documents: [],
        output_roots: [],
        unexpected: true,
      }),
    /DiagramAccessRegistryV1|INVALID_ACCESS_REGISTRY|invalid/i,
  );
  assert.throws(
    () =>
      createAccessRegistry({
        schema_version: 1,
        revision: 0,
        contexts: [],
        documents: [
          {
            document_ref: 'doc-1',
            document_id: 'doc-001',
            scope_ref: 'scope-1',
            scope_generation: 0,
            path_identity_digest: 'x',
            mode: 'write',
            active: true,
          },
        ],
        output_roots: [],
      }),
    /DiagramAccessRegistryV1|INVALID_ACCESS_REGISTRY|invalid/i,
  );
});

test('registerContext: registration is strict, idempotent and conflict-aware', () => {
  const registry = createAccessRegistry();
  const first = registry.registerContext({
    context_ref: 'ctx-1',
    scope_ref: 'scope-1',
    scope_generation: 0,
  });
  assert.equal(first.ok, true);
  assert.equal(registry.exportToJson().revision, 1);

  const idempotent = registry.registerContext({
    context_ref: 'ctx-1',
    scope_ref: 'scope-1',
    scope_generation: 0,
  });
  assert.equal(idempotent.ok, true);
  assert.equal(idempotent.idempotent, true);
  assert.equal(registry.exportToJson().revision, 1);

  const conflict = registry.registerContext({
    context_ref: 'ctx-1',
    scope_ref: 'other-scope',
    scope_generation: 0,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'CONFLICT');

  const invalid = registry.registerContext({ context_ref: '', scope_ref: 'scope-1', scope_generation: -1 });
  assert.equal(invalid.ok, false);

  const context = registry.lookupContext('ctx-1', 0);
  assert.equal(context.ok, true);
  assert.equal(context.entry.scope_ref, 'scope-1');
  assert.equal(registry.lookupContext('ctx-1', 1).ok, false);
  assert.equal(registry.lookupContext('missing', 0).ok, false);
  assert.equal(validateAccessRegistry(registry.exportToJson()).ok, true);
});

test('registerOutputRoot: requires an active context and a real local directory', (t) => {
  const root = tempRoot(t);
  const registry = createAccessRegistry();
  const noContext = registry.registerOutputRoot({ output_ref: 'out-1', scope_ref: 'scope-1', scope_generation: 0, path: root });
  assert.equal(noContext.ok, false);

  registry.registerContext({ context_ref: 'ctx-1', scope_ref: 'scope-1', scope_generation: 0 });
  const missingPath = path.join(root, 'does-not-exist');
  assert.equal(
    registry.registerOutputRoot({ output_ref: 'out-1', scope_ref: 'scope-1', scope_generation: 0, path: missingPath }).ok,
    false,
  );
  assert.equal(
    registry.registerOutputRoot({ output_ref: 'out-1', scope_ref: 'scope-1', scope_generation: 0, path: 'relative' }).ok,
    false,
  );

  const registered = registry.registerOutputRoot({
    output_ref: 'out-1',
    scope_ref: 'scope-1',
    scope_generation: 0,
    path: root,
  });
  assert.equal(registered.ok, true);
  const lookup = registry.lookupOutputRoot('out-1', 0);
  assert.equal(lookup.ok, true);
  assert.equal(lookup.real_path, fs.realpathSync.native(root));
  assert.equal(registry.lookupOutputRoot('out-1', 1).ok, false);
  assert.equal(validateAccessRegistry(registry.exportToJson()).ok, true);
});

test('registerDocument: path must be inside an active output root for its scope', (t) => {
  const root = tempRoot(t);
  const outsideRoot = tempRoot(t);
  const artifact = path.join(root, 'artifact');
  fs.mkdirSync(artifact);
  const outsideArtifact = path.join(outsideRoot, 'artifact');
  fs.mkdirSync(outsideArtifact);
  const registry = createAccessRegistry();
  registry.registerContext({ context_ref: 'ctx-1', scope_ref: 'scope-1', scope_generation: 0 });
  registry.registerOutputRoot({ output_ref: 'out-1', scope_ref: 'scope-1', scope_generation: 0, path: root });

  const outside = registry.registerDocument({
    document_ref: 'doc-outside',
    document_id: 'doc-outside',
    scope_ref: 'scope-1',
    scope_generation: 0,
    path: outsideArtifact,
    mode: 'edit',
  });
  assert.equal(outside.ok, false);

  const wrongGeneration = registry.registerDocument({
    document_ref: 'doc-gen',
    document_id: 'doc-gen',
    scope_ref: 'scope-1',
    scope_generation: 1,
    path: artifact,
    mode: 'edit',
  });
  assert.equal(wrongGeneration.ok, false);

  const registered = registry.registerDocument({
    document_ref: 'doc-1',
    document_id: 'doc-001',
    scope_ref: 'scope-1',
    scope_generation: 0,
    path: artifact,
    mode: 'edit',
  });
  assert.equal(registered.ok, true);
  assert.equal(registered.entry.document_ref, 'doc-1');
  assert.equal(registered.entry.path_identity_digest, pathIdentityDigest(artifact));
  const lookup = registry.lookupDocument('doc-1', 0);
  assert.equal(lookup.ok, true);
  assert.equal(lookup.entry.document_id, 'doc-001');
  assert.equal(lookup.entry.mode, 'edit');
  // The strict contract view never carries the raw local path.
  assert.equal(Object.prototype.hasOwnProperty.call(lookup.entry, 'path'), false);
  assert.equal(JSON.stringify(registry.exportToJson()).includes(root.replaceAll('\\', '\\\\')), false);
  assert.equal(validateAccessRegistry(registry.exportToJson()).ok, true);
});

test('lookupDocument: re-checks path identity on every call (no caching)', (t) => {
  const root = tempRoot(t);
  const artifact = path.join(root, 'artifact');
  fs.mkdirSync(artifact);
  const registry = registryWithDocument(root, artifact);
  assert.equal(registry.lookupDocument('doc-demo', 0).ok, true);
  // Replace the registered artifact directory (rename away + move back).
  const moved = path.join(root, 'artifact-moved');
  fs.renameSync(artifact, moved);
  const denied = registry.lookupDocument('doc-demo', 0);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'DOCUMENT_DENIED');
  fs.renameSync(moved, artifact);
  assert.equal(registry.lookupDocument('doc-demo', 0).ok, true);
});

test('revoke: document, context and output-root revocations fail closed and cascade', (t) => {
  const root = tempRoot(t);
  const artifact = path.join(root, 'artifact');
  fs.mkdirSync(artifact);
  const registry = registryWithDocument(root, artifact);
  assert.equal(registry.lookupDocument('doc-demo', 0).ok, true);

  const revokedDocument = registry.revoke({ kind: 'document', ref: 'doc-demo' });
  assert.equal(revokedDocument.ok, true);
  assert.equal(revokedDocument.revoked, true);
  assert.equal(registry.lookupDocument('doc-demo', 0).ok, false);

  // Re-registering the same entry reactivates it (trusted CLI action).
  const reactivated = registry.registerDocument({
    document_ref: 'doc-demo',
    document_id: 'doc-001',
    scope_ref: 'scope-demo',
    scope_generation: 0,
    path: artifact,
    mode: 'edit',
  });
  assert.equal(reactivated.ok, true);
  assert.equal(reactivated.reactivated, true);
  assert.equal(registry.lookupDocument('doc-demo', 0).ok, true);

  const revokedContext = registry.revoke({ kind: 'context', ref: 'ctx-demo' });
  assert.equal(revokedContext.ok, true);
  assert.equal(revokedContext.affected.documents >= 1, true);
  assert.equal(registry.lookupDocument('doc-demo', 0).ok, false);
  assert.equal(registry.lookupOutputRoot('out-demo', 0).ok, false);
  assert.equal(registry.lookupContext('ctx-demo', 0).ok, false);

  assert.equal(registry.revoke({ kind: 'nope', ref: 'x' }).ok, false);
  assert.equal(registry.revoke({ kind: 'document', ref: 'missing' }).code, 'NOT_FOUND');
});

test('registry persistence: strict registry.json + local path bindings round-trip', (t) => {
  const root = tempRoot(t);
  const dataRoot = tempRoot(t);
  const artifact = path.join(root, 'artifact');
  fs.mkdirSync(artifact);
  const registry = registryWithDocument(root, artifact);
  const saved = saveRegistryToDirectory(dataRoot, registry);
  assert.equal(saved.ok, true);
  const strictJson = JSON.parse(fs.readFileSync(saved.registry_path, 'utf8'));
  assert.equal(validateAccessRegistry(strictJson).ok, true);
  assert.equal(JSON.stringify(strictJson).includes(root.replaceAll('\\', '\\\\')), false);
  assert.equal(fs.existsSync(saved.local_path), true);

  const loaded = loadRegistryFromDirectory(dataRoot);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.had_local_bindings, true);
  assert.equal(loaded.registry.lookupDocument('doc-demo', 0).ok, true);
});

test('owner login alone never grants document access: store denies unregistered refs', async (t) => {
  const artifactRoot = tempRoot(t);
  const dataRoot = tempRoot(t);
  const artifact = path.join(artifactRoot, 'artifact');
  buildArtifactPackage(artifact);
  const registry = registryWithDocument(artifactRoot, artifact);
  const clock = fakeClock();
  const store = createDocumentStore({ data_root: dataRoot, registry, clock: clock.clock });
  const caller = ownerCaller();

  // Owner + a *different* (unregistered) document_ref: denied.
  const unknown = await store.openDocument(
    { document_ref: 'doc-not-registered', expected_scope: { scope_ref: 'scope-demo', scope_generation: 0 } },
    caller,
  );
  assert.equal(unknown.status, 'denied');
  assert.equal(unknown.code, 'DOCUMENT_DENIED');

  // Owner but wrong scope generation: denied.
  const wrongGeneration = await store.openDocument(
    { document_ref: 'doc-demo', expected_scope: { scope_ref: 'scope-demo', scope_generation: 7 } },
    caller,
  );
  assert.equal(wrongGeneration.status, 'denied');

  // Owner but wrong scope_ref: denied.
  const wrongScope = await store.openDocument(
    { document_ref: 'doc-demo', expected_scope: { scope_ref: 'other-scope', scope_generation: 0 } },
    caller,
  );
  assert.equal(wrongScope.status, 'denied');

  // Non-owner callers never reach the document.
  const nonOwner = await store.openDocument(
    { document_ref: 'doc-demo', expected_scope: { scope_ref: 'scope-demo', scope_generation: 0 } },
    { principal: { kind: 'agent', principal_id: 'agent-1' } },
  );
  assert.equal(nonOwner.status, 'denied');
  assert.equal(nonOwner.code, 'OWNER_REQUIRED');

  // After revoking the document even a valid owner is denied.
  registry.revoke({ kind: 'document', ref: 'doc-demo' });
  const revoked = await store.openDocument(
    { document_ref: 'doc-demo', expected_scope: { scope_ref: 'scope-demo', scope_generation: 0 } },
    caller,
  );
  assert.equal(revoked.status, 'denied');
});

test('trusted CLI: registers context/root/document and rejects UNC paths', (t) => {
  const root = tempRoot(t);
  const dataRoot = tempRoot(t);
  const artifact = path.join(root, 'artifact');
  buildArtifactPackage(artifact);
  const cli = path.join(PROJECT_ROOT, 'tools', 'registry.mjs');
  const run = (...args) =>
    spawnSync(process.execPath, [cli, '--data-root', dataRoot, ...args], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });

  const context = run('register-context', '--context-ref', 'ctx-cli', '--scope-ref', 'scope-cli');
  assert.equal(context.status, 0, context.stderr);
  const outputRoot = run(
    'register-output-root',
    '--output-ref', 'out-cli',
    '--scope-ref', 'scope-cli',
    '--path', root,
  );
  assert.equal(outputRoot.status, 0, outputRoot.stderr);
  const document = run(
    'register-document',
    '--document-ref', 'doc-cli',
    '--document-id', 'doc-cli-001',
    '--scope-ref', 'scope-cli',
    '--path', artifact,
    '--mode', 'read',
  );
  assert.equal(document.status, 0, document.stderr);

  const listed = run('list');
  assert.equal(listed.status, 0, listed.stderr);
  const listedJson = JSON.parse(listed.stdout);
  assert.equal(listedJson.ok, true);
  assert.equal(listedJson.documents.length, 1);
  assert.equal(listedJson.documents[0].document_ref, 'doc-cli');
  assert.equal(listedJson.documents[0].mode, 'read');
  assert.equal(listedJson.output_roots.length, 1);

  const loaded = loadRegistryFromDirectory(dataRoot);
  assert.equal(loaded.registry.lookupDocument('doc-cli', 0).ok, true);

  const unc = run(
    'register-output-root',
    '--output-ref', 'out-unc',
    '--scope-ref', 'scope-cli',
    '--path', '\\\\server\\share\\artifact',
  );
  assert.notEqual(unc.status, 0);
  const uncJson = JSON.parse(unc.stdout);
  assert.equal(uncJson.ok, false);

  const unknownOption = run('register-context', '--context-ref', 'ctx-x', '--scope-ref', 'scope-cli', '--bogus', '1');
  assert.equal(unknownOption.status, 2);

  // Only registry files were created under the CLI data root.
  const names = fs.readdirSync(dataRoot).sort();
  assert.deepEqual(names, ['registry.json', 'registry.local.json']);
  void os;
});
