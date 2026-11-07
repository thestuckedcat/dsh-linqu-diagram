/**
 * T5 journal / crash-recovery / draft tests (DIA-09):
 * journal order prepared→revision_written→pointer_updated→saved, injected
 * crash points (revision write, pointer swap, journal append, bootstrap),
 * exactly one save after recovery, old pointer preserved, disk-full handling,
 * cancellation before the pointer swap, draft retention (3) and operation
 * status reporting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDocumentStore } from '../src/editor/document-store.mjs';
import {
  buildArtifactPackage,
  canonicalXml,
  clone,
  crashyFs,
  fakeClock,
  ownerCaller,
  readStoreState,
  revisionNames,
  tempRoot,
  testRegistry,
} from './fixtures/store/helpers.mjs';

const SCOPE = Object.freeze({ scope_ref: 'scope-demo', scope_generation: 0 });

/**
 * @param {import('node:test').TestContext} t
 * @param {any} [fsOption]
 */
function setup(t, fsOption) {
  const artifactRoot = tempRoot(t);
  const dataRoot = tempRoot(t);
  const artifactDir = path.join(artifactRoot, 'artifact');
  buildArtifactPackage(artifactDir);
  const registry = testRegistry({ root: artifactRoot, artifact_directory: artifactDir });
  const clock = fakeClock();
  /** @type {any} */
  const options = { data_root: dataRoot, registry, clock: clock.clock };
  if (fsOption !== undefined) options.fs = fsOption;
  const store = createDocumentStore(options);
  return { artifactRoot, dataRoot, artifactDir, registry, clock, store };
}

/**
 * Simulate a process restart: a brand-new store over the same data root and
 * registry, using the real filesystem.
 * @param {{dataRoot:string, registry:any}} context
 * @returns {any}
 */
function freshStore(context) {
  return createDocumentStore({
    data_root: context.dataRoot,
    registry: context.registry,
    clock: fakeClock('2026-11-07T03:00:00.000Z').clock,
  });
}

/** @param {any} store @param {any} [caller] */
function openDocument(store, caller = ownerCaller()) {
  return store.openDocument({ document_ref: 'doc-demo', expected_scope: SCOPE }, caller);
}

/**
 * @param {any} opened
 * @param {string} operationId
 * @param {{overlay?:any, xml?:string}} [overrides]
 */
function saveBody(opened, operationId, overrides = {}) {
  const overlay = overrides.overlay ?? opened.overlay;
  return {
    document_id: opened.document_id,
    editor_session_ref: opened.editor_session_ref,
    expected_version: opened.version,
    xml: overrides.xml ?? canonicalXml(opened.base_spec, overlay),
    overlay,
    operation_id: operationId,
  };
}

/** @param {string} dataRoot @param {string} documentId @param {string} operationId */
function operationTypes(dataRoot, documentId, operationId) {
  return readStoreState(dataRoot, documentId)
    .journal.filter((entry) => entry.operation_id === operationId)
    .map((entry) => entry.type);
}

/** @param {string} dataRoot @param {string} documentId @param {string} operationId */
function savedEntries(dataRoot, documentId, operationId) {
  return readStoreState(dataRoot, documentId).journal.filter(
    (entry) => entry.operation_id === operationId && entry.type === 'saved',
  );
}

/** @param {string} dataRoot @param {string} documentId */
function draftFiles(dataRoot, documentId) {
  const draftsRoot = path.join(dataRoot, 'documents', documentId, 'drafts');
  if (!fs.existsSync(draftsRoot)) return [];
  /** @type {string[]} */
  const files = [];
  for (const sessionDir of fs.readdirSync(draftsRoot)) {
    const directory = path.join(draftsRoot, sessionDir);
    if (!fs.statSync(directory).isDirectory()) continue;
    for (const name of fs.readdirSync(directory)) {
      if (/^[0-9a-f]{64}\.xml$/u.test(name)) files.push(path.join(directory, name));
    }
  }
  return files;
}

test('journal: a successful save records prepared→revision_written→pointer_updated→saved', async (t) => {
  const context = setup(t);
  const opened = await openDocument(context.store);
  const saved = await context.store.saveDiagram(saveBody(opened, 'op-journal-1'), ownerCaller());
  assert.equal(saved.status, 'saved');
  assert.deepEqual(operationTypes(context.dataRoot, 'doc-001', 'op-journal-1'), [
    'prepared',
    'revision_written',
    'pointer_updated',
    'saved',
  ]);
  assert.equal(savedEntries(context.dataRoot, 'doc-001', 'op-journal-1').length, 1);
});

test('crash at the pointer swap: old pointer preserved, recovery saves exactly once', async (t) => {
  // Bootstrap performs pointer rename #1; the save's pointer rename is #2.
  const fsModule = crashyFs([{ op: 'renameSync', pathIncludes: 'pointer.json', occurrence: 2 }]);
  const context = setup(t, fsModule);
  const opened = await openDocument(context.store);
  assert.equal(opened.status, 'opened');

  const crashed = await context.store.saveDiagram(saveBody(opened, 'op-crash-pointer'), ownerCaller());
  assert.equal(crashed.status, 'outcome_unknown');
  assert.equal(crashed.code, 'OUTCOME_UNKNOWN');

  // Old pointer is untouched and the revision was fully written before the crash.
  const afterCrash = readStoreState(context.dataRoot, 'doc-001');
  assert.equal(afterCrash.pointer.generation, 0);
  assert.deepEqual(operationTypes(context.dataRoot, 'doc-001', 'op-crash-pointer'), ['prepared', 'revision_written']);
  assert.equal(revisionNames(context.dataRoot, 'doc-001').length, 2);

  // A "restarted" store finalizes exactly the provably committed operation.
  const store2 = freshStore(context);
  const recovered = await openDocument(store2);
  assert.equal(recovered.status, 'opened');
  assert.equal(recovered.version.generation, 1);
  assert.ok(recovered.warnings.includes('recovered_operation'));
  assert.equal(readStoreState(context.dataRoot, 'doc-001').pointer.generation, 1);
  assert.deepEqual(operationTypes(context.dataRoot, 'doc-001', 'op-crash-pointer'), [
    'prepared',
    'revision_written',
    'pointer_updated',
    'saved',
  ]);
  assert.equal(savedEntries(context.dataRoot, 'doc-001', 'op-crash-pointer').length, 1);
  assert.equal(revisionNames(context.dataRoot, 'doc-001').length, 2);

  const operation = await store2.getOperation({ operation_ref: 'op-crash-pointer' }, ownerCaller());
  assert.equal(operation.state, 'saved');
  assert.equal(operation.version.generation, 1);

  // Recovery is idempotent: a second restart does not create another save.
  const store3 = freshStore(context);
  const reopened = await openDocument(store3);
  assert.equal(reopened.version.generation, 1);
  assert.equal(savedEntries(context.dataRoot, 'doc-001', 'op-crash-pointer').length, 1);
  assert.equal(revisionNames(context.dataRoot, 'doc-001').length, 2);
});

test('crash while writing the revision: nothing is published, recovery records failure', async (t) => {
  // Bootstrap writes revision temp files 1-4; the save's first revision write is #5.
  const fsModule = crashyFs([{ op: 'openSync', pathIncludes: '.drawio.tmp-', occurrence: 2 }]);
  const context = setup(t, fsModule);
  const opened = await openDocument(context.store);
  const crashed = await context.store.saveDiagram(saveBody(opened, 'op-crash-revision'), ownerCaller());
  assert.equal(crashed.status, 'outcome_unknown');
  assert.match(crashed.draft_ref, /^drafts\//u);

  const afterCrash = readStoreState(context.dataRoot, 'doc-001');
  assert.equal(afterCrash.pointer.generation, 0);
  assert.deepEqual(operationTypes(context.dataRoot, 'doc-001', 'op-crash-revision'), ['prepared']);
  assert.equal(revisionNames(context.dataRoot, 'doc-001').length, 1);

  const store2 = freshStore(context);
  const recovered = await openDocument(store2);
  assert.equal(recovered.status, 'opened');
  assert.equal(recovered.version.generation, 0);
  assert.equal(readStoreState(context.dataRoot, 'doc-001').pointer.generation, 0);
  assert.deepEqual(operationTypes(context.dataRoot, 'doc-001', 'op-crash-revision'), ['prepared', 'failed']);
  const operation = await store2.getOperation({ operation_ref: 'op-crash-revision' }, ownerCaller());
  assert.equal(operation.state, 'failed');
});

test('disk full while writing the revision: old pointer + draft preserved', async (t) => {
  // Same injection point as the crash test, but with an ENOSPC error code.
  const fsModule = crashyFs([{ op: 'openSync', pathIncludes: '.drawio.tmp-', occurrence: 2, code: 'ENOSPC' }]);
  const context = setup(t, fsModule);
  const opened = await openDocument(context.store);
  const failed = await context.store.saveDiagram(saveBody(opened, 'op-disk-full'), ownerCaller());
  assert.equal(failed.status, 'outcome_unknown');
  assert.match(failed.draft_ref, /^drafts\//u);

  const draftPath = path.join(context.dataRoot, 'documents', 'doc-001', failed.draft_ref);
  assert.equal(fs.existsSync(draftPath), true);
  assert.equal(fs.readFileSync(draftPath, 'utf8'), canonicalXml(opened.base_spec, opened.overlay));

  const afterFailure = readStoreState(context.dataRoot, 'doc-001');
  assert.equal(afterFailure.pointer.generation, 0);
  assert.equal(afterFailure.pointer.content_sha256, opened.version.content_sha256);

  const store2 = freshStore(context);
  const recovered = await openDocument(store2);
  assert.equal(recovered.status, 'opened');
  assert.equal(recovered.version.generation, 0);
});

test('crash after the pointer swap but before journal saved: recovery completes the journal once', async (t) => {
  // Bootstrap appends journal entries 1-4; the save's saved append is #8.
  const fsModule = crashyFs([{ op: 'openSync', pathIncludes: 'journal.jsonl', occurrence: 8 }]);
  const context = setup(t, fsModule);
  const opened = await openDocument(context.store);
  const crashed = await context.store.saveDiagram(saveBody(opened, 'op-crash-journal'), ownerCaller());
  assert.equal(crashed.status, 'outcome_unknown');

  const afterCrash = readStoreState(context.dataRoot, 'doc-001');
  // The pointer was already swapped atomically before the crash.
  assert.equal(afterCrash.pointer.generation, 1);
  assert.deepEqual(operationTypes(context.dataRoot, 'doc-001', 'op-crash-journal'), [
    'prepared',
    'revision_written',
    'pointer_updated',
  ]);

  const store2 = freshStore(context);
  const recovered = await openDocument(store2);
  assert.equal(recovered.status, 'opened');
  assert.equal(recovered.version.generation, 1);
  assert.ok(recovered.warnings.includes('recovered_operation'));
  assert.deepEqual(operationTypes(context.dataRoot, 'doc-001', 'op-crash-journal'), [
    'prepared',
    'revision_written',
    'pointer_updated',
    'saved',
  ]);
  assert.equal(savedEntries(context.dataRoot, 'doc-001', 'op-crash-journal').length, 1);
  const operation = await store2.getOperation({ operation_ref: 'op-crash-journal' }, ownerCaller());
  assert.equal(operation.state, 'saved');
});

test('crash during generation-0 bootstrap: next open recovers exactly one generation 0', async (t) => {
  // The very first pointer rename (bootstrap) is interrupted.
  const fsModule = crashyFs([{ op: 'renameSync', pathIncludes: 'pointer.json', occurrence: 1 }]);
  const context = setup(t, fsModule);
  const crashed = await openDocument(context.store);
  assert.equal(crashed.status, 'unavailable');
  assert.equal(fs.existsSync(path.join(context.dataRoot, 'documents', 'doc-001', 'pointer.json')), false);
  const journalAfterCrash = readStoreState(context.dataRoot, 'doc-001').journal;
  assert.equal(journalAfterCrash.filter((entry) => entry.type === 'prepared').length, 1);
  assert.equal(journalAfterCrash.filter((entry) => entry.type === 'revision_written').length, 1);

  const store2 = freshStore(context);
  const recovered = await openDocument(store2);
  assert.equal(recovered.status, 'opened');
  assert.equal(recovered.version.generation, 0);
  const journal = readStoreState(context.dataRoot, 'doc-001').journal;
  assert.equal(journal.filter((entry) => entry.type === 'saved').length, 1);
  assert.equal(journal.filter((entry) => entry.type === 'pointer_updated').length, 1);
  assert.equal(revisionNames(context.dataRoot, 'doc-001').length, 1);
});

test('cancellation before the pointer swap keeps the old version and a draft', async (t) => {
  const controller = new AbortController();
  // Abort while the save writes its revision files (bootstrap writes 1-4).
  let revisionOpens = 0;
  const fsModule = new Proxy(fs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return function wrapped(...args) {
        const firstPath = typeof args[0] === 'string' ? args[0] : '';
        if (String(property) === 'openSync' && firstPath.includes('.drawio.tmp-')) {
          revisionOpens += 1;
          if (revisionOpens === 2) controller.abort();
        }
        return value.apply(target, args);
      };
    },
  });
  const context = setup(t, fsModule);
  const opened = await openDocument(context.store);
  const result = await context.store.saveDiagram(saveBody(opened, 'op-cancelled'), ownerCaller(), controller.signal);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.code, 'CANCELLED');
  assert.match(result.draft_ref, /^drafts\//u);
  assert.equal(fs.existsSync(path.join(context.dataRoot, 'documents', 'doc-001', result.draft_ref)), true);

  const afterCancel = readStoreState(context.dataRoot, 'doc-001');
  assert.equal(afterCancel.pointer.generation, 0);
  assert.deepEqual(operationTypes(context.dataRoot, 'doc-001', 'op-cancelled'), ['prepared', 'revision_written', 'failed']);

  // The cancelled revision must never be published by a later recovery.
  const store2 = freshStore(context);
  const recovered = await openDocument(store2);
  assert.equal(recovered.status, 'opened');
  assert.equal(recovered.version.generation, 0);
  const operation = await store2.getOperation({ operation_ref: 'op-cancelled' }, ownerCaller());
  assert.equal(operation.state, 'failed');
  assert.equal(operation.reason_code, 'CANCELLED');
});

test('cancellation before any write creates only a draft', async (t) => {
  const context = setup(t);
  const opened = await openDocument(context.store);
  const controller = new AbortController();
  controller.abort();
  const result = await context.store.saveDiagram(saveBody(opened, 'op-early-cancel'), ownerCaller(), controller.signal);
  assert.equal(result.status, 'cancelled');
  assert.match(result.draft_ref, /^drafts\//u);
  assert.equal(operationTypes(context.dataRoot, 'doc-001', 'op-early-cancel').length, 0);
  assert.equal(readStoreState(context.dataRoot, 'doc-001').pointer.generation, 0);
});

test('drafts: distinct drafts retained to 3 per session; duplicate XML deduplicated', async (t) => {
  const context = setup(t);
  const viewA = await openDocument(context.store);
  const viewB = await openDocument(context.store);
  // View A advances the pointer so view B's token is stale.
  const savedA = await context.store.saveDiagram(saveBody(viewA, 'op-drafts-a'), ownerCaller());
  assert.equal(savedA.status, 'saved');

  const attempts = [];
  for (let index = 0; index < 4; index += 1) {
    // The XML is never validated on the conflict path; distinct payloads create
    // distinct draft digests.
    attempts.push(`<mxfile>draft-${index}</mxfile>`);
    const conflict = await context.store.saveDiagram(
      saveBody(viewB, `op-drafts-${index}`, { xml: attempts[index] }),
      ownerCaller(),
    );
    assert.equal(conflict.status, 'conflict');
    assert.match(conflict.draft_ref, /^drafts\//u);
  }
  let files = draftFiles(context.dataRoot, 'doc-001');
  assert.equal(files.length, 3);
  const retainedContents = files.map((file) => fs.readFileSync(file, 'utf8'));
  for (const content of retainedContents) assert.ok(attempts.includes(content));

  // Repeating the newest draft does not grow the directory beyond 3.
  const repeated = await context.store.saveDiagram(
    saveBody(viewB, 'op-drafts-repeat', { xml: attempts[attempts.length - 1] }),
    ownerCaller(),
  );
  assert.equal(repeated.status, 'conflict');
  files = draftFiles(context.dataRoot, 'doc-001');
  assert.equal(files.length, 3);
  // No draft ever escapes the document's drafts directory inside the data root.
  for (const file of files) {
    assert.equal(file.startsWith(path.join(context.dataRoot, 'documents', 'doc-001', 'drafts')), true);
  }
});

test('getOperation: unknown operations are reported as unknown, not re-sent later', async (t) => {
  const context = setup(t);
  const opened = await openDocument(context.store);
  const saved = await context.store.saveDiagram(saveBody(opened, 'op-lookup'), ownerCaller());
  assert.equal(saved.status, 'saved');

  const unknown = await context.store.getOperation({ operation_ref: 'op-never-existed' }, ownerCaller());
  assert.equal(unknown.state, 'unknown');

  const nonOwner = await context.store.getOperation({ operation_ref: 'op-lookup' }, {
    principal: { kind: 'agent', principal_id: 'agent-1' },
  });
  assert.equal(nonOwner.state, 'unknown');
  assert.equal(nonOwner.reason_code, 'OWNER_REQUIRED');

  // Revoking the document hides its operation history.
  context.registry.revoke({ kind: 'document', ref: 'doc-demo' });
  const revoked = await context.store.getOperation({ operation_ref: 'op-lookup' }, ownerCaller());
  assert.equal(revoked.state, 'unknown');
  assert.equal(revoked.reason_code, 'DOCUMENT_DENIED');

  const invalid = await context.store.getOperation({ operation_ref: 'not an id!' }, ownerCaller());
  assert.equal(invalid.state, 'unknown');
});

test('snapshot and dispose never expose absolute paths and drop sessions', async (t) => {
  const context = setup(t);
  const opened = await openDocument(context.store);
  const snapshot = context.store.snapshot();
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.session_count, 1);
  assert.equal(snapshot.documents[0].document_id, opened.document_id);
  assert.equal(JSON.stringify(snapshot).includes(context.dataRoot), false);
  assert.deepEqual(clone(snapshot).documents[0].generation, 0);

  await context.store.dispose();
  const afterDispose = await openDocument(context.store);
  assert.equal(afterDispose.status, 'denied');
});

