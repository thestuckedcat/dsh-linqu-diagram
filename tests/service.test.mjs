/**
 * T4/T6 Host RPC service tests (DIA-RPC-01, docs/interfaces.md §10).
 *
 * Uses the real 06 document store over a temporary data root plus a generated
 * artifact package (no fixture stubs for the happy path), so open -> edit ->
 * save -> conflict -> export -> close runs through the same code the plugin
 * loads. Fake peers exercise the owner gate; a throwing store stub is the
 * exception canary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createDocumentStore } from '../src/editor/document-store.mjs';
import { createLocalDiagramsService, ENDPOINTS, REASON_CODES } from '../src/plugin/service.mjs';
import { validateRpcResponse } from '../src/contracts.mjs';
import { createEditorModel, executeEdit } from '../src/editor/model.mjs';
import { exportDrawio } from '../src/drawio/xml.mjs';
import {
  buildArtifactPackage,
  fakeClock,
  ownerCaller,
  tempRoot,
  testRegistry,
} from './fixtures/store/helpers.mjs';

const SCOPE = Object.freeze({ scope_ref: 'scope-demo', scope_generation: 0 });
const DESIGN_REASON_CODES = Object.freeze([
  'OWNER_REQUIRED',
  'CONTEXT_UNBOUND',
  'SCOPE_REVOKED',
  'DOCUMENT_DENIED',
  'EDITOR_SESSION_EXPIRED',
  'STALE_VERSION',
  'INVALID_XML',
  'INVALID_OVERLAY',
  'LIMIT_EXCEEDED',
  'UNKNOWN_ENDPOINT',
  'INTERNAL_FAILURE',
]);

/** @param {string} [principalId] */
function fakePeer(principalId = 'owner-1') {
  return {
    principal: { kind: 'owner', principal_id: principalId },
    signal: new AbortController().signal,
  };
}

const OWNER_PEER = fakePeer();

/**
 * @param {import('node:test').TestContext} t
 * @param {{serviceLimits?:any, storeLimits?:any}} [options]
 */
function setup(t, options = {}) {
  const artifactRoot = tempRoot(t);
  const dataRoot = tempRoot(t);
  const artifactDir = path.join(artifactRoot, 'artifact');
  const pkg = buildArtifactPackage(artifactDir);
  const registry = testRegistry({ root: artifactRoot, artifact_directory: artifactDir });
  const store = createDocumentStore({
    data_root: dataRoot,
    registry,
    clock: fakeClock().clock,
    ...(options.storeLimits === undefined ? {} : { limits: options.storeLimits }),
  });
  const service = createLocalDiagramsService({
    registry,
    store,
    ...(options.serviceLimits === undefined ? {} : { limits: options.serviceLimits }),
  });
  return { artifactRoot, dataRoot, artifactDir, pkg, registry, store, service };
}

/**
 * Build a valid request shell around an endpoint input.
 * @param {string} endpoint @param {any} input @param {Record<string, any>} [overrides]
 */
let operationCounter = 0;
function shellFor(endpoint, input, overrides = {}) {
  const endpointTag = endpoint.replace('.', '-');
  operationCounter += 1;
  return {
    schema_version: 1,
    operation_id: `op-${endpointTag}-${operationCounter}`,
    context_ref: 'ctx-demo',
    expected_scope_generation: 0,
    view_epoch: 7,
    input,
    ...overrides,
  };
}

/** @param {any} value @param {string} [message] */
function assertRpcOk(value, message = 'expected RpcResult ok:true') {
  assert.equal(value?.ok, true, `${message}: ${JSON.stringify(value)}`);
  return value.value;
}

/** @param {any} business @param {string} status @param {string} [reason] */
function assertBusinessFailure(business, status, reason) {
  assert.equal(business.status, status, JSON.stringify(business));
  if (reason !== undefined) assert.equal(business.reason_code, reason, JSON.stringify(business));
  assert.ok(REASON_CODES.includes(business.reason_code), `reason_code ${business.reason_code} must be fixed`);
  assert.ok(validateRpcResponse(business).ok === true, 'failure response must match the closed union');
}

/** @param {any} response */
function assertNoPathLeak(response, forbiddenPaths = []) {
  const text = JSON.stringify(response);
  for (const forbidden of forbiddenPaths) {
    assert.equal(text.includes(forbidden), false, `response leaked ${forbidden}`);
  }
  assert.equal(/[A-Za-z]:[\\/]/u.test(text), false, 'response leaked a drive path');
  assert.equal(text.includes('    at '), false, 'response leaked a stack frame');
}

/** @param {any} service @param {string} endpoint @param {any} payload @param {any} [peer] @param {any} [signal] */
function call(service, endpoint, payload, peer = OWNER_PEER, signal) {
  return service.handle(endpoint, payload, signal, peer);
}

/** @param {any} service @returns {Promise<any>} opened data */
async function openDocument(service, operationId = 'op-document-open-1') {
  const result = await call(service, 'document.open', shellFor('document.open', { document_ref: 'doc-demo' }, { operation_id: operationId }));
  const business = assertRpcOk(result);
  assert.equal(business.status, 'ok');
  return business.data;
}

/* -------------------------------------------------------------------------- */
/* contract surface                                                            */
/* -------------------------------------------------------------------------- */

test('service: endpoint and reason-code unions are frozen and complete', () => {
  assert.deepEqual([...ENDPOINTS], [
    'document.open',
    'document.save',
    'document.export',
    'operation.get',
    'session.close',
  ]);
  assert.ok(Object.isFrozen(ENDPOINTS));
  assert.ok(Object.isFrozen(REASON_CODES));
  for (const code of DESIGN_REASON_CODES) assert.ok(REASON_CODES.includes(code), `missing fixed code ${code}`);
  for (const code of REASON_CODES) assert.match(code, /^[A-Z][A-Z0-9_]{0,63}$/u);
});

test('service: constructs only with a real registry and document store', () => {
  assert.throws(() => createLocalDiagramsService(), TypeError);
  assert.throws(() => createLocalDiagramsService({ metadata: true }), TypeError);
  assert.throws(
    () => createLocalDiagramsService({ registry: { lookupContext() {} }, store: {} }),
    TypeError,
  );
});

/* -------------------------------------------------------------------------- */
/* owner gate + request shell                                                  */
/* -------------------------------------------------------------------------- */

test('service: non-owner or aborted peer is a fixed transport-level refusal', async (t) => {
  const { service } = setup(t);
  const payload = shellFor('document.open', { document_ref: 'doc-demo' });

  const apiPeer = { principal: { kind: 'api' }, signal: new AbortController().signal };
  const apiDenied = await call(service, 'document.open', payload, apiPeer);
  assert.deepEqual(apiDenied, {
    ok: false,
    error: { code: 'OWNER_REQUIRED', message: 'owner peer required', details: {} },
  });

  const noPeer = await call(service, 'document.open', payload, null);
  assert.equal(noPeer.ok, false);
  assert.equal(noPeer.error.code, 'OWNER_REQUIRED');
  assert.deepEqual(noPeer.error.details, {});

  const controller = new AbortController();
  controller.abort();
  const abortedPeer = { principal: { kind: 'owner' }, signal: controller.signal };
  const aborted = await call(service, 'document.open', payload, abortedPeer);
  assert.deepEqual(aborted, {
    ok: false,
    error: { code: 'OWNER_REQUIRED', message: 'owner peer required', details: {} },
  });
});

test('service: malformed request shells are rejected with a fixed code and no echo', async (t) => {
  const { service } = setup(t);
  const good = shellFor('document.open', { document_ref: 'doc-demo' });
  const cases = [
    { ...good, extra: 'secret-value' },
    { ...good, schema_version: 2 },
    { ...good, operation_id: '' },
    { ...good, context_ref: '../escape' },
    { ...good, expected_scope_generation: -1 },
    { ...good, view_epoch: 1.5 },
    { ...good, input: null },
    { ...good, input: [] },
    { ...good, unknown_field: true },
  ];
  for (const payload of cases) {
    const result = await call(service, 'document.open', payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.deepEqual(result, {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'invalid request', details: {} },
    });
    assert.equal(JSON.stringify(result).includes('secret-value'), false);
  }

  // A shell with extra keys is also rejected even when values are otherwise valid.
  const extra = { ...good, caller: { grant: 'all' } };
  assert.equal((await call(service, 'document.open', extra)).error.code, 'INVALID_REQUEST');
});

test('service: unknown context and stale scope generation are business denials in the value', async (t) => {
  const { service } = setup(t);
  const unknownContext = await call(
    service,
    'document.open',
    shellFor(
      'document.open',
      { document_ref: 'doc-demo' },
      { context_ref: 'ctx-missing', operation_id: 'op-context-missing-1' },
    ),
  );
  const unknownBusiness = assertRpcOk(unknownContext);
  assertBusinessFailure(unknownBusiness, 'denied', 'CONTEXT_UNBOUND');
  assert.equal(unknownBusiness.operation_id, 'op-context-missing-1');
  assert.equal(unknownBusiness.view_epoch, 7);
  assertNoPathLeak(unknownBusiness);

  const staleScope = await call(
    service,
    'document.open',
    shellFor('document.open', { document_ref: 'doc-demo' }, { expected_scope_generation: 9 }),
  );
  assertBusinessFailure(assertRpcOk(staleScope), 'denied', 'SCOPE_REVOKED');
});

test('service: unknown endpoints are rejected inside a valid envelope', async (t) => {
  const { service } = setup(t);
  const result = await call(service, 'document.delete', shellFor('document.delete', { any: true }));
  assertBusinessFailure(assertRpcOk(result), 'invalid', 'UNKNOWN_ENDPOINT');
});

/* -------------------------------------------------------------------------- */
/* document.open                                                               */
/* -------------------------------------------------------------------------- */

test('service: document.open returns the canonical base/overlay/XML/version payload', async (t) => {
  const { service, pkg, artifactDir, dataRoot } = setup(t);
  const response = await call(
    service,
    'document.open',
    shellFor('document.open', { document_ref: 'doc-demo' }, { operation_id: 'op-open-canonical-1' }),
  );
  const business = assertRpcOk(response);
  assert.equal(business.status, 'ok');
  assert.equal(business.schema_version, 1);
  assert.equal(business.operation_id, 'op-open-canonical-1');
  assert.equal(business.view_epoch, 7);
  assert.equal(business.scope_generation, 0);
  assert.ok(validateRpcResponse(business).ok === true);
  const data = business.data;
  assert.equal(data.document_id, 'doc-001');
  assert.equal(data.xml, pkg.xml);
  assert.equal(data.version.generation, 0);
  assert.equal(data.version.document_id, 'doc-001');
  assert.match(data.editor_session_ref, /^es-[0-9a-f-]{36}$/u);
  assert.match(data.channel_nonce, /^[0-9a-f]{32}$/u);
  assert.deepEqual(data.warnings, []);
  assert.deepEqual(data.base_spec, pkg.spec);
  assert.deepEqual(data.overlay, pkg.overlay);
  assertNoPathLeak(business, [artifactDir, dataRoot]);
});

test('service: document.open denies unregistered documents and path-shaped refs', async (t) => {
  const { service } = setup(t);
  const missing = await call(service, 'document.open', shellFor('document.open', { document_ref: 'doc-missing' }));
  assertBusinessFailure(assertRpcOk(missing), 'denied', 'DOCUMENT_DENIED');

  // A path is never resolved: the id-shaped ref fails the store's registry
  // binding check and is reported as an unbound context, not as a filesystem
  // denial that would confirm a path exists.
  const pathLike = await call(
    service,
    'document.open',
    shellFor('document.open', { document_ref: 'C:/Windows/win.ini' }),
  );
  assertBusinessFailure(assertRpcOk(pathLike), 'denied', 'CONTEXT_UNBOUND');

  const slashRef = await call(
    service,
    'document.open',
    shellFor('document.open', { document_ref: 'etc/passwd' }),
  );
  assertBusinessFailure(assertRpcOk(slashRef), 'denied', 'CONTEXT_UNBOUND');
});

test('service: open rejects extra input fields (no caller/grant/path smuggling)', async (t) => {
  const { service } = setup(t);
  const cases = [
    { document_ref: 'doc-demo', caller: { principal: { kind: 'owner' } } },
    { document_ref: 'doc-demo', grant: 'admin' },
    { document_ref: 'doc-demo', path: 'C:/tmp/x' },
  ];
  for (const input of cases) {
    const result = await call(service, 'document.open', shellFor('document.open', input));
    assertBusinessFailure(assertRpcOk(result), 'invalid', 'INVALID_REQUEST');
  }
});

test('service: request JSON caps reject oversized bodies before touching the store', async (t) => {
  const { service } = setup(t, { serviceLimits: { rpc_json_bytes: 2048 } });
  const payload = shellFor('document.open', { document_ref: `${'x'.repeat(4096)}` });
  const result = await call(service, 'document.open', payload);
  assertBusinessFailure(assertRpcOk(result), 'invalid', 'LIMIT_EXCEEDED');
});

test('service: response JSON caps replace an oversized open payload with LIMIT_EXCEEDED', async (t) => {
  const { service } = setup(t, { serviceLimits: { rpc_response_bytes: 1024 } });
  const response = await call(service, 'document.open', shellFor('document.open', { document_ref: 'doc-demo' }));
  const business = assertRpcOk(response);
  assert.equal(business.status, 'failed');
  assert.equal(business.reason_code, 'LIMIT_EXCEEDED');
  assert.equal(Object.hasOwn(business, 'data'), false);
  assert.equal(JSON.stringify(business).includes('<mxfile'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(business), 'utf8') <= 1024);
  assert.ok(validateRpcResponse(business).ok === true);
});

/* -------------------------------------------------------------------------- */
/* document.save                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Extend the opened model with one layout move and return the canonical XML
 * the client would submit, plus the edited overlay.
 * @param {any} data opened data
 * @param {{kind:string, payload:any}} command
 */
function editOnce(data, command) {
  const model = createEditorModel(data.base_spec, data.overlay);
  const edited = executeEdit(model, {
    command_id: `cmd-${command.kind}-1`,
    expected_draft_revision: model.draft_revision,
    kind: command.kind,
    payload: command.payload,
  });
  assert.equal(edited.status, 'ok', JSON.stringify(edited));
  const xml = exportDrawio({ spec: data.base_spec, annotation_overlay: edited.model.overlay }).xml;
  return { model: edited.model, xml };
}

test('service: document.save writes one new revision and returns the version', async (t) => {
  const { service, dataRoot } = setup(t);
  const opened = await openDocument(service);
  const { model, xml } = editOnce(opened, { kind: 'move_node', payload: { node_id: 'n1', x: 100, y: 140 } });
  assert.equal(model.overlay.items.some((item) => item.kind === 'layout' && item.target_ref === 'n1'), true);

  const response = await call(
    service,
    'document.save',
    shellFor(
      'document.save',
      {
        document_id: opened.document_id,
        editor_session_ref: opened.editor_session_ref,
        expected_version: opened.version,
        xml,
        overlay: model.overlay,
      },
      { operation_id: 'op-save-1' },
    ),
  );
  const business = assertRpcOk(response);
  assert.equal(business.status, 'ok');
  assert.ok(validateRpcResponse(business).ok === true);
  assert.equal(business.data.version.generation, 1);
  assert.equal(business.data.version.document_id, 'doc-001');
  assert.notEqual(business.data.version.content_sha256, opened.version.content_sha256);

  const revisions = fs.readdirSync(path.join(dataRoot, 'documents', 'doc-001', 'revisions'));
  assert.equal(revisions.filter((name) => name.endsWith('.drawio')).length, 2);
});

test('service: replaying the same save operation returns the same version (idempotent)', async (t) => {
  const { service } = setup(t);
  const opened = await openDocument(service);
  const { model, xml } = editOnce(opened, { kind: 'move_node', payload: { node_id: 'n1', x: 20, y: 30 } });
  const payload = shellFor(
    'document.save',
    {
      document_id: opened.document_id,
      editor_session_ref: opened.editor_session_ref,
      expected_version: opened.version,
      xml,
      overlay: model.overlay,
    },
    { operation_id: 'op-save-replay' },
  );
  const first = assertRpcOk(await call(service, 'document.save', payload));
  assert.equal(first.status, 'ok');
  const second = assertRpcOk(await call(service, 'document.save', payload));
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.data.version, first.data.version);
});

test('service: reusing an operation_id with different content is rejected', async (t) => {
  const { service } = setup(t);
  const opened = await openDocument(service);
  const { model, xml } = editOnce(opened, { kind: 'move_node', payload: { node_id: 'n1', x: 20, y: 30 } });
  const base = {
    document_id: opened.document_id,
    editor_session_ref: opened.editor_session_ref,
    expected_version: opened.version,
    xml,
    overlay: model.overlay,
  };
  const first = assertRpcOk(
    await call(service, 'document.save', shellFor('document.save', base, { operation_id: 'op-save-differ' })),
  );
  assert.equal(first.status, 'ok');

  const otherModel = createEditorModel(opened.base_spec, opened.overlay);
  const other = executeEdit(otherModel, {
    command_id: 'cmd-other-1',
    expected_draft_revision: 0,
    kind: 'move_node',
    payload: { node_id: 'n2', x: 500, y: 0 },
  });
  assert.equal(other.status, 'ok');
  const otherXml = exportDrawio({ spec: opened.base_spec, annotation_overlay: other.model.overlay }).xml;
  const changed = assertRpcOk(
    await call(
      service,
      'document.save',
      shellFor(
        'document.save',
        { ...base, xml: otherXml, overlay: other.model.overlay },
        { operation_id: 'op-save-differ' },
      ),
    ),
  );
  assertBusinessFailure(changed, 'invalid', 'OPERATION_CONFLICT');
});

test('service: save rejects a tampered XML body (Host canonical comparison)', async (t) => {
  const { service } = setup(t);
  const opened = await openDocument(service);
  const xml = opened.xml.replace('x="40"', 'x="41"');
  assert.notEqual(xml, opened.xml);
  const result = assertRpcOk(
    await call(
      service,
      'document.save',
      shellFor(
        'document.save',
        {
          document_id: opened.document_id,
          editor_session_ref: opened.editor_session_ref,
          expected_version: opened.version,
          xml,
          overlay: opened.overlay,
        },
        { operation_id: 'op-save-tampered-xml' },
      ),
    ),
  );
  assertBusinessFailure(result, 'invalid', 'INVALID_OVERLAY');
});

test('service: save rejects an overlay that does not match the submitted XML', async (t) => {
  const { service } = setup(t);
  const opened = await openDocument(service);
  const overlay = JSON.parse(JSON.stringify(opened.overlay));
  overlay.revision += 1;
  overlay.updated_at = '2026-11-07T02:00:09.000Z';
  overlay.items.push({
    id: 'ann:note-1',
    kind: 'note',
    target_ref: null,
    text: 'draft note not present in the XML body',
    position: { x: 24, y: 24, width: 160, height: 64 },
  });
  const result = assertRpcOk(
    await call(
      service,
      'document.save',
      shellFor(
        'document.save',
        {
          document_id: opened.document_id,
          editor_session_ref: opened.editor_session_ref,
          expected_version: opened.version,
          xml: opened.xml,
          overlay,
        },
        { operation_id: 'op-save-overlay-mismatch' },
      ),
    ),
  );
  assertBusinessFailure(result, 'invalid', 'INVALID_OVERLAY');
});

test('service: save rejects a forged base digest, bad XML and non-drawio input', async (t) => {
  const { service } = setup(t);
  const opened = await openDocument(service);
  const base = {
    document_id: opened.document_id,
    editor_session_ref: opened.editor_session_ref,
    expected_version: opened.version,
    xml: opened.xml,
    overlay: opened.overlay,
  };
  const forgedOverlay = JSON.parse(JSON.stringify(opened.overlay));
  forgedOverlay.base_spec_digest = 'f'.repeat(64);
  const forged = assertRpcOk(
    await call(service, 'document.save', shellFor('document.save', { ...base, overlay: forgedOverlay }, { operation_id: 'op-save-forged' })),
  );
  assertBusinessFailure(forged, 'invalid', 'INVALID_OVERLAY');

  const badXml = assertRpcOk(
    await call(
      service,
      'document.save',
      shellFor('document.save', { ...base, xml: '<!DOCTYPE x><mxfile/>' }, { operation_id: 'op-save-badxml' }),
    ),
  );
  assertBusinessFailure(badXml, 'invalid', 'INVALID_XML');

  const notXml = assertRpcOk(
    await call(
      service,
      'document.save',
      shellFor('document.save', { ...base, xml: '<html><script>x</script></html>' }, { operation_id: 'op-save-html' }),
    ),
  );
  assert.ok(['INVALID_XML', 'UNSUPPORTED_FORMAT'].includes(notXml.reason_code), JSON.stringify(notXml));
});

test('service: save of a stale session is a conflict carrying the current version', async (t) => {
  const { service } = setup(t);
  const viewA = await openDocument(service, 'op-open-a');
  const viewB = await call(
    service,
    'document.open',
    shellFor('document.open', { document_ref: 'doc-demo' }, { operation_id: 'op-open-b' }),
  ).then(assertRpcOk);
  const openedB = viewB.data;

  const { model, xml } = editOnce(viewA, { kind: 'move_node', payload: { node_id: 'n1', x: 60, y: 60 } });
  const first = assertRpcOk(
    await call(
      service,
      'document.save',
      shellFor(
        'document.save',
        {
          document_id: viewA.document_id,
          editor_session_ref: viewA.editor_session_ref,
          expected_version: viewA.version,
          xml,
          overlay: model.overlay,
        },
        { operation_id: 'op-save-a' },
      ),
    ),
  );
  assert.equal(first.status, 'ok');

  const stale = assertRpcOk(
    await call(
      service,
      'document.save',
      shellFor(
        'document.save',
        {
          document_id: openedB.document_id,
          editor_session_ref: openedB.editor_session_ref,
          expected_version: openedB.version,
          xml: openedB.xml,
          overlay: openedB.overlay,
        },
        { operation_id: 'op-save-b' },
      ),
    ),
  );
  assertBusinessFailure(stale, 'conflict', 'STALE_VERSION');
  assert.equal(stale.data.current_version.generation, 1);
  assert.equal(typeof stale.data.draft_ref, 'string');
  assert.equal(stale.data.draft_ref.startsWith('drafts/'), true);
  assert.ok(validateRpcResponse(stale).ok === true);
});

test('service: save rejects a malformed expected_version as stale', async (t) => {
  const { service } = setup(t);
  const opened = await openDocument(service);
  const result = assertRpcOk(
    await call(
      service,
      'document.save',
      shellFor(
        'document.save',
        {
          document_id: opened.document_id,
          editor_session_ref: opened.editor_session_ref,
          expected_version: { schema_version: 1 },
          xml: opened.xml,
          overlay: opened.overlay,
        },
        { operation_id: 'op-save-bad-version' },
      ),
    ),
  );
  assertBusinessFailure(result, 'stale', 'STALE_VERSION');
});

/* -------------------------------------------------------------------------- */
/* document.export / operation.get / session.close                             */
/* -------------------------------------------------------------------------- */

test('service: document.export returns a leaf artifact ref, hash and size (no path)', async (t) => {
  const { service, artifactRoot } = setup(t);
  const opened = await openDocument(service);
  for (const format of ['drawio', 'json', 'svg']) {
    const response = await call(
      service,
      'document.export',
      shellFor(
        'document.export',
        {
          document_id: opened.document_id,
          version: opened.version,
          output_ref: 'out-demo',
          format,
        },
        { operation_id: `op-export-${format}` },
      ),
    );
    const business = assertRpcOk(response);
    assert.equal(business.status, 'ok', JSON.stringify(business));
    assert.ok(validateRpcResponse(business).ok === true);
    const { artifact_ref: artifactRef, sha256, size_bytes: sizeBytes } = business.data;
    assert.match(artifactRef, new RegExp(`^diagram-doc-001-g0\\.${format}$`, 'u'));
    assert.match(sha256, /^[0-9a-f]{64}$/u);
    assert.ok(Number.isSafeInteger(sizeBytes) && sizeBytes > 0);
    assertNoPathLeak(business, [artifactRoot]);
    assert.equal(fs.existsSync(path.join(artifactRoot, artifactRef)), true);
  }
});

test('service: document.export never overwrites an existing target', async (t) => {
  const { service } = setup(t);
  const opened = await openDocument(service);
  const payload = shellFor(
    'document.export',
    { document_id: opened.document_id, version: opened.version, output_ref: 'out-demo', format: 'drawio' },
    { operation_id: 'op-export-twice-1' },
  );
  assert.equal(assertRpcOk(await call(service, 'document.export', payload)).status, 'ok');
  const again = assertRpcOk(
    await call(service, 'document.export', { ...payload, operation_id: 'op-export-twice-2' }),
  );
  assertBusinessFailure(again, 'conflict', 'EXPORT_EXISTS');
});

test('service: document.export rejects unknown formats and output refs', async (t) => {
  const { service } = setup(t);
  const opened = await openDocument(service);
  const badFormat = assertRpcOk(
    await call(
      service,
      'document.export',
      shellFor(
        'document.export',
        { document_id: opened.document_id, version: opened.version, output_ref: 'out-demo', format: 'png' },
        { operation_id: 'op-export-png' },
      ),
    ),
  );
  assertBusinessFailure(badFormat, 'invalid', 'UNSUPPORTED_FORMAT');

  const badRoot = assertRpcOk(
    await call(
      service,
      'document.export',
      shellFor(
        'document.export',
        { document_id: opened.document_id, version: opened.version, output_ref: 'out-missing', format: 'drawio' },
        { operation_id: 'op-export-missing-root' },
      ),
    ),
  );
  assertBusinessFailure(badRoot, 'denied', 'DOCUMENT_DENIED');
});

test('service: operation.get reports saved and unknown states', async (t) => {
  const { service } = setup(t);
  const opened = await openDocument(service);
  const { model, xml } = editOnce(opened, { kind: 'move_node', payload: { node_id: 'n2', x: 0, y: 200 } });
  const saved = assertRpcOk(
    await call(
      service,
      'document.save',
      shellFor(
        'document.save',
        {
          document_id: opened.document_id,
          editor_session_ref: opened.editor_session_ref,
          expected_version: opened.version,
          xml,
          overlay: model.overlay,
        },
        { operation_id: 'op-save-for-lookup' },
      ),
    ),
  );
  assert.equal(saved.status, 'ok');

  const lookup = assertRpcOk(
    await call(service, 'operation.get', shellFor('operation.get', { operation_ref: 'op-save-for-lookup' })),
  );
  assert.equal(lookup.status, 'ok');
  assert.equal(lookup.data.state, 'saved');
  assert.equal(lookup.data.version.generation, 1);

  const unknown = assertRpcOk(
    await call(
      service,
      'operation.get',
      shellFor('operation.get', { operation_ref: 'op-unknown' }, { operation_id: 'op-get-unknown-1' }),
    ),
  );
  assert.equal(unknown.status, 'ok');
  assert.equal(unknown.data.state, 'unknown');
});

test('service: session.close revokes the editor session and later saves fail', async (t) => {
  const { service } = setup(t);
  const opened = await openDocument(service);
  const closed = assertRpcOk(
    await call(
      service,
      'session.close',
      shellFor('session.close', { editor_session_ref: opened.editor_session_ref }, { operation_id: 'op-close-1' }),
    ),
  );
  assert.equal(closed.status, 'ok');
  assert.deepEqual(closed.data, { closed: true });

  const again = assertRpcOk(
    await call(
      service,
      'session.close',
      shellFor('session.close', { editor_session_ref: opened.editor_session_ref }, { operation_id: 'op-close-2' }),
    ),
  );
  assert.deepEqual(again.data, { closed: false });

  const save = assertRpcOk(
    await call(
      service,
      'document.save',
      shellFor(
        'document.save',
        {
          document_id: opened.document_id,
          editor_session_ref: opened.editor_session_ref,
          expected_version: opened.version,
          xml: opened.xml,
          overlay: opened.overlay,
        },
        { operation_id: 'op-save-after-close' },
      ),
    ),
  );
  assertBusinessFailure(save, 'denied', 'EDITOR_SESSION_EXPIRED');
});

/* -------------------------------------------------------------------------- */
/* canaries                                                                    */
/* -------------------------------------------------------------------------- */

test('service: an unexpected store exception becomes a fixed INTERNAL_FAILURE response', async (t) => {
  const artifactRoot = tempRoot(t);
  const artifactDir = path.join(artifactRoot, 'artifact');
  buildArtifactPackage(artifactDir);
  const registry = testRegistry({ root: artifactRoot, artifact_directory: artifactDir });
  const boom = () => {
    throw new Error('SECRET_STORE_PATH C:/private/06-local-diagrams/secret.json');
  };
  const throwingStore = {
    openDocument: boom,
    saveDiagram: boom,
    exportArtifact: boom,
    getOperation: boom,
    closeEditorSession: boom,
    dispose: () => Promise.resolve(),
  };
  const service = createLocalDiagramsService({ registry, store: throwingStore });
  const response = await call(service, 'document.open', shellFor('document.open', { document_ref: 'doc-demo' }));
  const business = assertRpcOk(response);
  assert.equal(business.status, 'failed');
  assert.equal(business.reason_code, 'INTERNAL_FAILURE');
  assert.equal(JSON.stringify(business).includes('SECRET_STORE_PATH'), false);
  assert.equal(JSON.stringify(business).includes('C:/private'), false);
  assert.ok(validateRpcResponse(business).ok === true);
});

test('service: dispose revokes sessions and rejects later calls', async (t) => {
  const { service } = setup(t);
  await openDocument(service);
  assert.equal(service.snapshot().disposed, false);
  await service.dispose();
  assert.equal(service.snapshot().disposed, true);
  const result = await call(service, 'document.open', shellFor('document.open', { document_ref: 'doc-demo' }));
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'INTERNAL_FAILURE', message: 'internal failure', details: {} },
  });
  // dispose is idempotent
  await service.dispose();
});

test('service: business responses never carry caller/scope or absolute path fields', async (t) => {
  const { service, artifactDir, dataRoot } = setup(t);
  const opened = await openDocument(service);
  const text = JSON.stringify(opened);
  assert.equal(text.includes(artifactDir), false);
  assert.equal(text.includes(dataRoot), false);
  assert.equal(Object.hasOwn(opened, 'caller'), false);
  assert.equal(Object.hasOwn(opened, 'scope_ref'), false);
  assert.equal(Object.hasOwn(opened, 'path'), false);
});
