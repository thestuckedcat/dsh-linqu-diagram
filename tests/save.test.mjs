/**
 * T5 document-store save tests (DIA-08): generation-0 import from a verified
 * artifact package, immutable revisions, mandatory expected_version, A/B
 * conflicts without auto-retry, operation idempotency, tamper detection,
 * editor sessions and exclusive-create export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDocumentStore } from '../src/editor/document-store.mjs';
import { isWithinRoot } from '../src/editor/access.mjs';
import { parseDrawioXml } from '../src/drawio/xml.mjs';
import { renderLocal } from '../src/archive.mjs';
import { canonicalJson } from '../src/canonical.mjs';
import { specDigest } from '../src/contracts.mjs';
import {
  buildArtifactPackage,
  canonicalXml,
  clone,
  conceptualSpec,
  fakeClock,
  overlayFor,
  ownerCaller,
  readJson,
  readStoreState,
  revisionNames,
  sha256,
  tempRoot,
  testRegistry,
} from './fixtures/store/helpers.mjs';

/**
 * @param {import('node:test').TestContext} t
 * @param {{mode?:'read'|'edit', fs?:any, pkg?:any, limits?:any}} [options]
 */
function setup(t, options = {}) {
  const artifactRoot = tempRoot(t);
  const dataRoot = tempRoot(t);
  const artifactDir = path.join(artifactRoot, 'artifact');
  const pkg = buildArtifactPackage(artifactDir, options.pkg ?? {});
  const registry = testRegistry({
    root: artifactRoot,
    artifact_directory: artifactDir,
    mode: options.mode ?? 'edit',
  });
  const clock = fakeClock();
  /** @type {any} */
  const storeOptions = { data_root: dataRoot, registry, clock: clock.clock };
  if (options.fs !== undefined) storeOptions.fs = options.fs;
  if (options.limits !== undefined) storeOptions.limits = options.limits;
  const store = createDocumentStore(storeOptions);
  return { artifactRoot, dataRoot, artifactDir, pkg, registry, clock, store };
}

const SCOPE = Object.freeze({ scope_ref: 'scope-demo', scope_generation: 0 });

/** @param {any} store @param {any} [caller] */
function openDocument(store, caller = ownerCaller()) {
  return store.openDocument({ document_ref: 'doc-demo', expected_scope: SCOPE }, caller);
}

/**
 * @param {any[]} items
 * @param {any} spec
 * @param {any} overlay
 * @returns {any}
 */
function withItems(spec, overlay, items) {
  const next = clone(overlay);
  next.items = items;
  next.revision = (overlay.revision ?? 0) + 1;
  next.updated_at = '2026-11-07T02:00:05.000Z';
  return next;
}

test('openDocument: bootstraps generation 0 from the verified artifact package', async (t) => {
  const { store, pkg, dataRoot } = setup(t);
  const opened = await openDocument(store);
  assert.equal(opened.status, 'opened');
  assert.equal(opened.document_id, 'doc-001');
  assert.deepEqual(opened.version.content_sha256, sha256(opened.xml));
  assert.equal(opened.version.generation, 0);
  assert.equal(opened.version.byte_length, Buffer.byteLength(opened.xml, 'utf8'));
  assert.match(opened.version.path_identity_digest, /^[0-9a-f]{64}$/u);
  assert.match(opened.channel_nonce, /^[0-9a-f]{32}$/u);
  assert.equal(typeof opened.editor_session_ref, 'string');
  assert.equal(opened.xml, pkg.xml);
  assert.deepEqual(opened.base_spec, pkg.spec);
  assert.deepEqual(opened.overlay, pkg.overlay);
  assert.ok(Array.isArray(opened.warnings));

  const { pointer, journal } = readStoreState(dataRoot, 'doc-001');
  assert.equal(pointer.generation, 0);
  assert.equal(pointer.content_sha256, opened.version.content_sha256);
  assert.deepEqual(
    journal.map((entry) => entry.type),
    ['prepared', 'revision_written', 'pointer_updated', 'saved'],
  );
  assert.equal(journal[journal.length - 1].version.generation, 0);
});

test('openDocument: two opens yield distinct sessions and channel nonces', async (t) => {
  const { store } = setup(t);
  const first = await openDocument(store);
  const second = await openDocument(store);
  assert.equal(first.status, 'opened');
  assert.equal(second.status, 'opened');
  assert.notEqual(first.editor_session_ref, second.editor_session_ref);
  assert.notEqual(first.channel_nonce, second.channel_nonce);
  assert.deepEqual(first.version, second.version);
});

test('openDocument: artifact manifest/hash tampering is unavailable and writes no document', async (t) => {
  const { artifactDir, store, dataRoot } = setup(t);
  const specFile = path.join(artifactDir, 'diagram-spec.json');
  const original = fs.readFileSync(specFile, 'utf8');
  fs.writeFileSync(specFile, original.replace('Demo diagram', 'Evil diagram'));
  const opened = await openDocument(store);
  assert.equal(opened.status, 'unavailable');
  assert.equal(opened.code, 'INVALID_MANIFEST');
  assert.equal(fs.existsSync(path.join(dataRoot, 'documents', 'doc-001', 'pointer.json')), false);
});

test('openDocument: deleted artifact path is denied by the registry identity re-check', async (t) => {
  const { artifactDir, store, dataRoot } = setup(t);
  fs.rmSync(artifactDir, { recursive: true, force: true });
  const opened = await openDocument(store);
  assert.equal(opened.status, 'denied');
  assert.equal(opened.code, 'DOCUMENT_DENIED');
  assert.equal(fs.existsSync(path.join(dataRoot, 'documents', 'doc-001', 'pointer.json')), false);
});

test('saveDiagram: writes one new immutable revision from the expected version', async (t) => {
  const { store, dataRoot } = setup(t);
  const opened = await openDocument(store);
  const note = {
    id: 'ann:note-1',
    kind: 'note',
    target_ref: 'n1',
    text: 'reviewed',
    position: { x: 12, y: 88, width: 120, height: 40 },
  };
  const overlay2 = withItems(opened.base_spec, opened.overlay, [note]);
  const xml2 = canonicalXml(opened.base_spec, overlay2);
  const saved = await store.saveDiagram(
    {
      document_id: opened.document_id,
      editor_session_ref: opened.editor_session_ref,
      expected_version: opened.version,
      xml: xml2,
      overlay: overlay2,
      operation_id: 'op-save-1',
    },
    ownerCaller(),
  );
  assert.equal(saved.status, 'saved');
  assert.equal(saved.version.generation, 1);
  assert.equal(saved.version.content_sha256, sha256(canonicalXml(opened.base_spec, overlay2)));
  assert.equal(saved.version.path_identity_digest, opened.version.path_identity_digest);
  assert.equal(specDigest(opened.base_spec), opened.overlay.base_spec_digest);
  assert.equal(revisionNames(dataRoot, 'doc-001').length, 2);

  const { pointer } = readStoreState(dataRoot, 'doc-001');
  assert.equal(pointer.generation, 1);
  assert.equal(pointer.content_sha256, saved.version.content_sha256);

  // Reopening returns the stored immutable revision, not the older artifact.
  const reopened = await openDocument(store);
  assert.equal(reopened.status, 'opened');
  assert.equal(reopened.version.generation, 1);
  assert.equal(reopened.overlay.items.length, 1);
  assert.equal(reopened.overlay.items[0].id, 'ann:note-1');
  const parsed = parseDrawioXml(reopened.xml);
  assert.equal(parsed.ok, true);
});

test('saveDiagram: expected_version is mandatory and fully validated', async (t) => {
  const { store, dataRoot } = setup(t);
  const opened = await openDocument(store);
  const body = {
    document_id: opened.document_id,
    editor_session_ref: opened.editor_session_ref,
    xml: opened.xml,
    overlay: opened.overlay,
  };
  const noVersion = await store.saveDiagram({ ...body, operation_id: 'op-noversion' }, ownerCaller());
  assert.equal(noVersion.status, 'invalid');
  assert.equal(noVersion.code, 'STALE_VERSION');

  const partial = { generation: opened.version.generation, content_sha256: opened.version.content_sha256 };
  const partialVersion = await store.saveDiagram(
    { ...body, expected_version: partial, operation_id: 'op-partial' },
    ownerCaller(),
  );
  assert.equal(partialVersion.status, 'invalid');
  assert.equal(partialVersion.code, 'STALE_VERSION');

  const wrongDocument = await store.saveDiagram(
    { ...body, expected_version: { ...opened.version, document_id: 'other-doc' }, operation_id: 'op-wrongdoc' },
    ownerCaller(),
  );
  assert.equal(wrongDocument.status, 'invalid');

  // None of the rejected calls advanced the document.
  assert.equal(revisionNames(dataRoot, 'doc-001').length, 1);
  assert.equal(readStoreState(dataRoot, 'doc-001').pointer.generation, 0);
});

test('A/B views: stale token conflicts, returns current version and draft, never auto-retries', async (t) => {
  const { store, dataRoot } = setup(t);
  const viewA = await openDocument(store);
  const viewB = await openDocument(store);
  assert.equal(viewA.version.generation, 0);
  assert.equal(viewB.version.generation, 0);

  const overlayA = withItems(viewA.base_spec, viewA.overlay, [
    { id: 'ann:note-a', kind: 'note', target_ref: 'n1', text: 'A', position: { x: 1, y: 1, width: 80, height: 30 } },
  ]);
  const savedA = await store.saveDiagram(
    {
      document_id: viewA.document_id,
      editor_session_ref: viewA.editor_session_ref,
      expected_version: viewA.version,
      xml: canonicalXml(viewA.base_spec, overlayA),
      overlay: overlayA,
      operation_id: 'op-view-a',
    },
    ownerCaller(),
  );
  assert.equal(savedA.status, 'saved');
  assert.equal(savedA.version.generation, 1);

  const overlayB = withItems(viewB.base_spec, viewB.overlay, [
    { id: 'ann:note-b', kind: 'note', target_ref: 'n2', text: 'B', position: { x: 2, y: 2, width: 80, height: 30 } },
  ]);
  const conflictBody = {
    document_id: viewB.document_id,
    editor_session_ref: viewB.editor_session_ref,
    expected_version: viewB.version,
    xml: canonicalXml(viewB.base_spec, overlayB),
    overlay: overlayB,
    operation_id: 'op-view-b',
  };
  const conflict = await store.saveDiagram(conflictBody, ownerCaller());
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.current_version.generation, 1);
  assert.equal(conflict.current_version.content_sha256, savedA.version.content_sha256);
  assert.match(conflict.draft_ref, /^drafts\/[0-9a-f]{24}\/[0-9a-f]{64}\.xml$/u);
  assert.equal(fs.existsSync(path.join(dataRoot, 'documents', 'doc-001', conflict.draft_ref)), true);

  // Retrying with the same old token must keep failing; the store must not
  // silently pick up generation 1 behind the caller's back.
  const retry = await store.saveDiagram(conflictBody, ownerCaller());
  assert.equal(retry.status, 'conflict');
  assert.equal(retry.current_version.generation, 1);
  assert.deepEqual(revisionNames(dataRoot, 'doc-001').length, 2);
  assert.equal(readStoreState(dataRoot, 'doc-001').pointer.generation, 1);
});

test('saveDiagram: idempotent operation_id returns the same version; different body is rejected', async (t) => {
  const { store, dataRoot } = setup(t);
  const opened = await openDocument(store);
  const overlay2 = withItems(opened.base_spec, opened.overlay, [
    { id: 'ann:note-i', kind: 'note', target_ref: null, text: 'idem', position: { x: 5, y: 5, width: 100, height: 40 } },
  ]);
  const xml2 = canonicalXml(opened.base_spec, overlay2);
  const body = {
    document_id: opened.document_id,
    editor_session_ref: opened.editor_session_ref,
    expected_version: opened.version,
    xml: xml2,
    overlay: overlay2,
    operation_id: 'op-idem-1',
  };
  const first = await store.saveDiagram(body, ownerCaller());
  assert.equal(first.status, 'saved');
  assert.equal(first.version.generation, 1);

  const replay = await store.saveDiagram(body, ownerCaller());
  assert.equal(replay.status, 'saved');
  assert.deepEqual(replay.version, first.version);
  assert.equal(revisionNames(dataRoot, 'doc-001').length, 2);
  const savedEntries = readStoreState(dataRoot, 'doc-001').journal.filter(
    (entry) => entry.operation_id === 'op-idem-1' && entry.type === 'saved',
  );
  assert.equal(savedEntries.length, 1);

  // Same operation id, same expected_version, different overlay: reject.
  const otherOverlay = withItems(opened.base_spec, opened.overlay, [
    { id: 'ann:note-i2', kind: 'note', target_ref: null, text: 'other', position: { x: 6, y: 6, width: 100, height: 40 } },
  ]);
  const differentBody = await store.saveDiagram(
    { ...body, xml: canonicalXml(opened.base_spec, otherOverlay), overlay: otherOverlay },
    ownerCaller(),
  );
  assert.equal(differentBody.status, 'invalid');
  assert.equal(differentBody.code, 'CONFLICT');
  assert.equal(revisionNames(dataRoot, 'doc-001').length, 2);
});

test('saveDiagram: invalid XML/overlay and mismatched client XML are rejected', async (t) => {
  const { store, dataRoot } = setup(t);
  const opened = await openDocument(store);
  const base = {
    document_id: opened.document_id,
    editor_session_ref: opened.editor_session_ref,
    expected_version: opened.version,
    overlay: opened.overlay,
  };
  const notXml = await store.saveDiagram({ ...base, xml: 'this is not xml', operation_id: 'op-badxml' }, ownerCaller());
  assert.equal(notXml.status, 'invalid');
  assert.equal(notXml.code, 'INVALID_XML');

  const wrongBaseDigest = clone(opened.overlay);
  wrongBaseDigest.base_spec_digest = 'a'.repeat(64);
  const badOverlay = await store.saveDiagram(
    { ...base, overlay: wrongBaseDigest, xml: opened.xml, operation_id: 'op-badoverlay' },
    ownerCaller(),
  );
  assert.equal(badOverlay.status, 'invalid');
  assert.equal(badOverlay.code, 'INVALID_OVERLAY');

  const overlay2 = withItems(opened.base_spec, opened.overlay, [
    { id: 'ann:note-x', kind: 'note', target_ref: 'n1', text: 'x', position: { x: 3, y: 3, width: 80, height: 30 } },
  ]);
  // Overlay and XML disagree about the note layer.
  const mismatched = await store.saveDiagram(
    { ...base, overlay: overlay2, xml: opened.xml, operation_id: 'op-mismatch' },
    ownerCaller(),
  );
  assert.equal(mismatched.status, 'invalid');
  assert.equal(mismatched.code, 'INVALID_OVERLAY');

  assert.equal(revisionNames(dataRoot, 'doc-001').length, 1);
});

test('saveDiagram: XML byte limit is enforced before any write', async (t) => {
  const { store, dataRoot } = setup(t, { limits: { document_xml_bytes: 2048 } });
  const opened = await openDocument(store);
  const huge = `${opened.xml}${'x'.repeat(4096)}`;
  const result = await store.saveDiagram(
    {
      document_id: opened.document_id,
      editor_session_ref: opened.editor_session_ref,
      expected_version: opened.version,
      xml: huge,
      overlay: opened.overlay,
      operation_id: 'op-huge',
    },
    ownerCaller(),
  );
  assert.equal(result.status, 'invalid');
  assert.equal(result.code, 'LIMIT_EXCEEDED');
  assert.equal(revisionNames(dataRoot, 'doc-001').length, 1);
});

test('same-size external revision modification is detected, save not applied', async (t) => {
  const { store, dataRoot, registry, pkg } = setup(t);
  const opened = await openDocument(store);
  const revision = revisionNames(dataRoot, 'doc-001')[0];
  const xmlFile = path.join(dataRoot, 'documents', 'doc-001', 'revisions', `${revision}.drawio`);
  const original = fs.readFileSync(xmlFile, 'utf8');
  const tampered = original.replace('Node one', 'Node onE');
  assert.equal(Buffer.byteLength(original, 'utf8'), Buffer.byteLength(tampered, 'utf8'));
  assert.notEqual(original, tampered);
  fs.writeFileSync(xmlFile, tampered);

  const overlay2 = withItems(opened.base_spec, opened.overlay, []);
  const result = await store.saveDiagram(
    {
      document_id: opened.document_id,
      editor_session_ref: opened.editor_session_ref,
      expected_version: opened.version,
      xml: canonicalXml(opened.base_spec, overlay2),
      overlay: overlay2,
      operation_id: 'op-tampered',
    },
    ownerCaller(),
  );
  assert.notEqual(result.status, 'saved');
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(revisionNames(dataRoot, 'doc-001').length, 1);
  assert.equal(readStoreState(dataRoot, 'doc-001').pointer.generation, 0);
  assert.equal(readStoreState(dataRoot, 'doc-001').pointer.content_sha256, opened.version.content_sha256);
  assert.equal(typeof pkg.xml, 'string');

  // A fresh store refuses to open the damaged revision instead of trusting it.
  const fresh = createDocumentStore({ data_root: dataRoot, registry, clock: fakeClock().clock });
  const reopenAfterTamper = await openDocument(fresh);
  assert.equal(reopenAfterTamper.status, 'unavailable');
  assert.equal(reopenAfterTamper.code, 'OUTCOME_UNKNOWN');
});

test('mode=read documents can be opened but never saved', async (t) => {
  const { store } = setup(t, { mode: 'read' });
  const opened = await openDocument(store);
  assert.equal(opened.status, 'opened');
  const result = await store.saveDiagram(
    {
      document_id: opened.document_id,
      editor_session_ref: opened.editor_session_ref,
      expected_version: opened.version,
      xml: opened.xml,
      overlay: opened.overlay,
      operation_id: 'op-readonly',
    },
    ownerCaller(),
  );
  assert.equal(result.status, 'denied');
  assert.equal(result.code, 'DOCUMENT_DENIED');
});

test('editor sessions: TTL expiry, caller binding, close and registry revocation', async (t) => {
  const { store, registry, clock } = setup(t);
  const opened = await openDocument(store);
  const body = (operationId) => ({
    document_id: opened.document_id,
    editor_session_ref: opened.editor_session_ref,
    expected_version: opened.version,
    xml: opened.xml,
    overlay: opened.overlay,
    operation_id: operationId,
  });

  // Caller binding: a different principal cannot use the session.
  const otherCaller = await store.saveDiagram(body('op-other-caller'), ownerCaller('intruder-1'));
  assert.equal(otherCaller.status, 'denied');
  assert.equal(otherCaller.code, 'DOCUMENT_DENIED');

  // TTL: 1 hour default; advancing the injected clock expires the session.
  clock.advance(60 * 60 * 1000 + 1);
  const expired = await store.saveDiagram(body('op-expired'), ownerCaller());
  assert.equal(expired.status, 'denied');
  assert.equal(expired.code, 'EDITOR_SESSION_EXPIRED');

  // A fresh session is usable again.
  const reopened = await openDocument(store);
  assert.equal(reopened.status, 'opened');
  const closeWrongCaller = await store.closeEditorSession(
    { editor_session_ref: reopened.editor_session_ref },
    ownerCaller('someone-else'),
  );
  assert.equal(closeWrongCaller.closed, false);
  const closed = await store.closeEditorSession(
    { editor_session_ref: reopened.editor_session_ref },
    ownerCaller(),
  );
  assert.equal(closed.closed, true);
  const afterClose = await store.saveDiagram(
    {
      document_id: reopened.document_id,
      editor_session_ref: reopened.editor_session_ref,
      expected_version: reopened.version,
      xml: reopened.xml,
      overlay: reopened.overlay,
      operation_id: 'op-after-close',
    },
    ownerCaller(),
  );
  assert.equal(afterClose.status, 'denied');
  assert.equal(afterClose.code, 'EDITOR_SESSION_EXPIRED');

  // Registry revocation invalidates the document for existing sessions too.
  const live = await openDocument(store);
  assert.equal(live.status, 'opened');
  registry.revoke({ kind: 'document', ref: 'doc-demo' });
  const revoked = await store.saveDiagram(
    {
      document_id: live.document_id,
      editor_session_ref: live.editor_session_ref,
      expected_version: live.version,
      xml: live.xml,
      overlay: live.overlay,
      operation_id: 'op-revoked',
    },
    ownerCaller(),
  );
  assert.equal(revoked.status, 'denied');
});

test('exportArtifact: exclusive create, json export, stale token and output root checks', async (t) => {
  const { store, artifactRoot, dataRoot } = setup(t);
  const opened = await openDocument(store);

  const exported = await store.exportArtifact(
    { document_id: opened.document_id, version: opened.version, output_ref: 'out-demo', format: 'drawio' },
    ownerCaller(),
  );
  assert.equal(exported.status, 'exported');
  assert.equal(path.basename(exported.artifact_ref), 'diagram-doc-001-g0.drawio');
  assert.equal(isWithinRoot(artifactRoot, exported.artifact_ref), true);
  assert.equal(sha256(fs.readFileSync(exported.artifact_ref, 'utf8')), exported.sha256);
  assert.equal(fs.statSync(exported.artifact_ref).size, exported.size_bytes);
  assert.equal(parseDrawioXml(fs.readFileSync(exported.artifact_ref, 'utf8')).ok, true);

  // Exclusive create: the same target is never overwritten.
  const duplicate = await store.exportArtifact(
    { document_id: opened.document_id, version: opened.version, output_ref: 'out-demo', format: 'drawio' },
    ownerCaller(),
  );
  assert.equal(duplicate.status, 'conflict');
  assert.equal(duplicate.code, 'CONFLICT');

  const jsonExport = await store.exportArtifact(
    { document_id: opened.document_id, version: opened.version, output_ref: 'out-demo', format: 'json' },
    ownerCaller(),
  );
  assert.equal(jsonExport.status, 'exported');
  const parsedJson = JSON.parse(fs.readFileSync(jsonExport.artifact_ref, 'utf8'));
  assert.equal(parsedJson.document_id, opened.document_id);
  assert.deepEqual(parsedJson.base_spec, opened.base_spec);

  const svgExport = await store.exportArtifact(
    { document_id: opened.document_id, version: opened.version, output_ref: 'out-demo', format: 'svg' },
    ownerCaller(),
  );
  assert.equal(svgExport.status, 'exported');
  const svgText = fs.readFileSync(svgExport.artifact_ref, 'utf8');
  assert.match(svgText, /^<svg /u);
  assert.equal(sha256(svgText), svgExport.sha256);

  // An output root that is not registered for this scope is denied.
  const unregisteredRoot = await store.exportArtifact(
    { document_id: opened.document_id, version: opened.version, output_ref: 'out-missing', format: 'drawio' },
    ownerCaller(),
  );
  assert.equal(unregisteredRoot.status, 'denied');

  // After a save, the old generation token cannot be exported.
  const overlay2 = withItems(opened.base_spec, opened.overlay, []);
  const saved = await store.saveDiagram(
    {
      document_id: opened.document_id,
      editor_session_ref: opened.editor_session_ref,
      expected_version: opened.version,
      xml: canonicalXml(opened.base_spec, overlay2),
      overlay: overlay2,
      operation_id: 'op-export-advance',
    },
    ownerCaller(),
  );
  assert.equal(saved.status, 'saved');
  const staleExport = await store.exportArtifact(
    { document_id: opened.document_id, version: opened.version, output_ref: 'out-demo', format: 'drawio' },
    ownerCaller(),
  );
  assert.equal(staleExport.status, 'invalid');
  assert.equal(staleExport.code, 'STALE_VERSION');
  assert.equal(readJson(path.join(dataRoot, 'documents', 'doc-001', 'pointer.json')).generation, 1);
});

test('concurrent saves: exactly one writer wins, the other conflicts (single writer)', async (t) => {
  const { store, dataRoot } = setup(t);
  const viewA = await openDocument(store);
  const viewB = await openDocument(store);
  const overlayA = withItems(viewA.base_spec, viewA.overlay, []);
  const overlayB = withItems(viewB.base_spec, viewB.overlay, []);
  const [resultA, resultB] = await Promise.all([
    store.saveDiagram(
      {
        document_id: viewA.document_id,
        editor_session_ref: viewA.editor_session_ref,
        expected_version: viewA.version,
        xml: canonicalXml(viewA.base_spec, overlayA),
        overlay: overlayA,
        operation_id: 'op-concurrent-a',
      },
      ownerCaller(),
    ),
    store.saveDiagram(
      {
        document_id: viewB.document_id,
        editor_session_ref: viewB.editor_session_ref,
        expected_version: viewB.version,
        xml: canonicalXml(viewB.base_spec, overlayB),
        overlay: overlayB,
        operation_id: 'op-concurrent-b',
      },
      ownerCaller(),
    ),
  ]);
  const statuses = [resultA.status, resultB.status].sort();
  assert.deepEqual(statuses, ['conflict', 'saved']);
  assert.equal(readJson(path.join(dataRoot, 'documents', 'doc-001', 'pointer.json')).generation, 1);
  assert.equal(revisionNames(dataRoot, 'doc-001').length, 2);
  const conflictResult = resultA.status === 'conflict' ? resultA : resultB;
  assert.equal(conflictResult.current_version.generation, 1);
  assert.match(conflictResult.draft_ref, /^drafts\//u);
});

test('a stale cross-process writer lock file is reclaimed', async (t) => {
  const { store, dataRoot } = setup(t);
  const opened = await openDocument(store);
  const lockFile = path.join(dataRoot, 'documents', 'doc-001', 'writer.lock');
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: 999_999_999, nonce: 'stale', at: Date.now() - 10 * 60 * 1000 }),
  );
  const saved = await store.saveDiagram(
    {
      document_id: opened.document_id,
      editor_session_ref: opened.editor_session_ref,
      expected_version: opened.version,
      xml: opened.xml,
      overlay: opened.overlay,
      operation_id: 'op-stale-lock',
    },
    ownerCaller(),
  );
  assert.equal(saved.status, 'saved');
  // The stale lock was reclaimed, replaced for the save, and released again.
  assert.equal(fs.existsSync(lockFile), false);
});

test('openDocument consumes a real src/archive.mjs artifact package as generation 0', async (t) => {
  const outputRoot = path.join(tempRoot(t), 'output');
  fs.mkdirSync(outputRoot, { recursive: true });
  const dataRoot = tempRoot(t);
  const spec = conceptualSpec();
  const overlay = overlayFor(spec);
  const rendered = await renderLocal(
    {
      spec,
      overlay,
      output_ref: 'packages',
      renderer: 'builtin',
      expected_output_revision: null,
      operation_id: 'op-render-artifact-1',
    },
    { granted: true, granted_output_root: outputRoot },
  );
  assert.equal(rendered.status, 'saved');
  const artifactDir = rendered.artifact_ref;
  for (const fileName of ['index.html', 'diagram-spec.json', 'annotations.json', 'diagram.drawio', 'manifest.json']) {
    assert.equal(fs.existsSync(path.join(artifactDir, fileName)), true, fileName);
  }
  const registry = testRegistry({ root: outputRoot, artifact_directory: artifactDir });
  const store = createDocumentStore({ data_root: dataRoot, registry, clock: fakeClock().clock });
  const opened = await openDocument(store);
  assert.equal(opened.status, 'opened');
  assert.equal(canonicalJson(opened.base_spec), canonicalJson(spec));
  assert.equal(canonicalJson(opened.overlay), canonicalJson(overlay));
  assert.equal(opened.version.generation, 0);
  assert.equal(opened.xml, fs.readFileSync(path.join(artifactDir, 'diagram.drawio'), 'utf8'));
});
