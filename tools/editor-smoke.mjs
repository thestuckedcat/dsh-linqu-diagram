#!/usr/bin/env node
/**
 * tools/editor-smoke.mjs - isolated end-to-end editor journey for 06.
 *
 * What runs (component level, no real Host/browser):
 *  - a real temporary artifact package + real `src/editor/document-store.mjs`
 *    over a temp data root + real `src/plugin/service.mjs` + registry;
 *  - the GENERATED client bundle (`plugin/client.js`) loaded the way the rc.5
 *    client module system loads it (`window.__ModuleLoader__.load` + fake
 *    platform `require`), so the pure client helpers in the journey are the
 *    exact code the browser runs;
 *  - a service-level transport double standing in for
 *    `ctx.connection.rpc.call('/local-diagrams', ...)` that forwards to the real
 *    service handler and returns the real RpcResult;
 *  - journey: open -> drag one node (one command on pointerup) -> note ->
 *    annotation edge -> undo/redo -> save (exact expected_version) -> stale
 *    conflict in a second view -> keep-both merge + resave -> export
 *    drawio/json/svg (exclusive create) -> operation.get -> close -> unload.
 *
 * Network evidence: a JS-level guard records every `fetch` / `WebSocket` /
 * `XMLHttpRequest` attempt during the journey. The expected count is ZERO, and
 * every transport call must be a registered `/local-diagrams` endpoint. The
 * guard is not a Chromium/OS-level outlet proof (see limitations).
 *
 * Usage:
 *   node tools/editor-smoke.mjs --isolated --fixture [--network-evidence] [--keep-artifacts]
 *
 * Exit: 0 pass, 1 journey/evidence failure, 2 usage/setup failure.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createDocumentStore } from '../src/editor/document-store.mjs';
import { createLocalDiagramsService, ENDPOINTS } from '../src/plugin/service.mjs';
import { createAccessRegistry } from '../src/editor/access.mjs';
import { buildArtifactPackage, fakeClock } from '../tests/fixtures/store/helpers.mjs';

const EXIT = Object.freeze({ PASS: 0, FAIL: 1, USAGE: 2 });
const CHANNEL = '/local-diagrams';
const FIXED_NOW = '2026-11-07T02:00:00.000Z';
const ROOT = path.resolve(import.meta.dirname, '..');

const LIMITATIONS = Object.freeze([
  'Component-level smoke only: no real Host install, no Cordis fiber, no authenticated HTTP peer and no browser were started.',
  'The transport double forwards directly to createLocalDiagramsService().handle; Host buffered-body limits, RpcResult envelope serialization over HTTP and browser CSP are NOT exercised.',
  'The generated client bundle is materialized under a fake window.__ModuleLoader__ + fake platform require; the panel is not rendered by React DOM and Pointer Events/pointer capture are simulated from pure helpers.',
  'Export/draft downloads are planned only; no browser download or clipboard call is executed.',
  'The network guard covers this Node process JS entry points (fetch/WebSocket/XMLHttpRequest); it is not a Chromium/OS outlet proof and cannot certify arbitrary native subprocess traffic.',
  '03/04/05/07/08 cross-capability events and a real 08 navigation adapter run are outside this smoke.',
]);

/* -------------------------------------------------------------------------- */
/* args                                                                        */
/* -------------------------------------------------------------------------- */

function usage() {
  return [
    'usage: node tools/editor-smoke.mjs --isolated --fixture [--network-evidence] [--keep-artifacts]',
    '',
    '  --isolated          required: run entirely in temp dirs (never DSH_HOME)',
    '  --fixture           required: build a synthetic artifact package + registry fixture',
    '  --network-evidence  include the JS-level network guard evidence (always recorded)',
    '  --keep-artifacts    keep the temp data/artifact dirs for inspection',
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* network guard                                                               */
/* -------------------------------------------------------------------------- */

/** @returns {{attempts:object[], uninstall:()=>void, patched:string[]}} */
function installNetworkGuard() {
  /** @type {object[]} */
  const attempts = [];
  /** @type {Array<{target:any, name:string, original:any}>} */
  const saved = [];
  /** @param {string} api @param {unknown} target */
  const record = (api, target) => {
    attempts.push({
      api,
      target: String(target ?? '').slice(0, 200),
      blocked: true,
      at: new Date().toISOString(),
    });
  };
  /** @param {object} holder @param {string} name @param {any} replacement */
  const patch = (holder, name, replacement) => {
    const original = holder?.[name];
    if (original === undefined) return;
    saved.push({ target: holder, name, original });
    try {
      holder[name] = replacement;
    } catch {
      // non-writable globals are left alone; the limitation is reported.
    }
  };
  patch(globalThis, 'fetch', (input) => {
    record('globalThis.fetch', input);
    return Promise.reject(new Error('NETWORK_BLOCKED'));
  });
  if (typeof globalThis.WebSocket !== 'undefined') {
    patch(globalThis, 'WebSocket', function BlockedWebSocket(url) {
      record('globalThis.WebSocket', url);
      throw new Error('NETWORK_BLOCKED');
    });
  } else {
    globalThis.WebSocket = function BlockedWebSocket(url) {
      record('globalThis.WebSocket', url);
      throw new Error('NETWORK_BLOCKED');
    };
    saved.push({ target: globalThis, name: 'WebSocket', original: undefined });
  }
  globalThis.XMLHttpRequest = function BlockedXhr() {
    record('globalThis.XMLHttpRequest', 'open');
    throw new Error('NETWORK_BLOCKED');
  };
  saved.push({ target: globalThis, name: 'XMLHttpRequest', original: undefined });
  const patched = saved.map((entry) => entry.name);
  return {
    attempts,
    patched,
    uninstall() {
      for (const entry of saved.reverse()) {
        if (entry.original === undefined) delete entry.target[entry.name];
        else entry.target[entry.name] = entry.original;
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* rc.5 bundle loading                                                         */
/* -------------------------------------------------------------------------- */

function reactStub() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });
  return {
    createElement,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => [initial, () => {}],
  };
}

/** @returns {Promise<{exports:any, bundleSha256:string}>} */
async function loadClientBundle() {
  const file = path.join(ROOT, 'plugin', 'client.js');
  const bundleSha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  /** @type {any[]} */
  const registrations = [];
  const previousWindow = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: { load: (record) => registrations.push(record) },
    addEventListener() {},
    removeEventListener() {},
  };
  try {
    await import(`${pathToFileURL(file).href}?smoke=${Date.now()}`);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  if (registrations.length !== 1) throw new Error('client bundle did not register exactly one module');
  const registration = registrations[0];
  if (registration.id !== 'dsh-local-diagrams') throw new Error('client bundle id mismatch');
  const platform = { react: reactStub(), 'react/jsx-runtime': { jsx: () => null, jsxs: () => null } };
  const exports = registration.factory((specifier) => {
    if (!Object.hasOwn(platform, specifier)) throw new Error(`client bundle required non-seed module ${specifier}`);
    return platform[specifier];
  });
  if (exports.name !== 'local-diagrams') throw new Error('client plugin name mismatch');
  return { exports, bundleSha256 };
}

/* -------------------------------------------------------------------------- */
/* fixture                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} root
 * @returns {{artifactDir:string, dataRoot:string, registry:any, store:any, service:any}}
 */
function createFixture(root) {
  const artifactRoot = path.join(root, 'artifact-root');
  const artifactDir = path.join(artifactRoot, 'artifact');
  fs.mkdirSync(artifactRoot, { recursive: true });
  buildArtifactPackage(artifactDir);
  const dataRoot = path.join(root, 'data');
  const registry = createAccessRegistry();
  const scopeRef = 'scope-demo';
  const context = registry.registerContext({ context_ref: 'ctx-demo', scope_ref: scopeRef, scope_generation: 0 });
  if (context.ok !== true) throw new Error(`registerContext failed: ${JSON.stringify(context)}`);
  const outputRoot = registry.registerOutputRoot({
    output_ref: 'out-demo',
    scope_ref: scopeRef,
    scope_generation: 0,
    path: artifactRoot,
  });
  if (outputRoot.ok !== true) throw new Error(`registerOutputRoot failed: ${JSON.stringify(outputRoot)}`);
  const document = registry.registerDocument({
    document_ref: 'doc-demo',
    document_id: 'doc-001',
    scope_ref: scopeRef,
    scope_generation: 0,
    path: artifactDir,
    mode: 'edit',
  });
  if (document.ok !== true) throw new Error(`registerDocument failed: ${JSON.stringify(document)}`);
  const store = createDocumentStore({ data_root: dataRoot, registry, clock: fakeClock(FIXED_NOW).clock });
  const service = createLocalDiagramsService({ registry, store });
  return { artifactRoot, artifactDir, dataRoot, registry, store, service };
}

/* -------------------------------------------------------------------------- */
/* journey                                                                     */
/* -------------------------------------------------------------------------- */

async function main(argv) {
  const isolated = argv.includes('--isolated');
  const fixture = argv.includes('--fixture');
  const networkEvidence = argv.includes('--network-evidence');
  const keepArtifacts = argv.includes('--keep-artifacts');
  if (argv.includes('--help') || argv.length === 0) {
    process.stdout.write(usage());
    return argv.length === 0 ? EXIT.USAGE : EXIT.PASS;
  }
  if (!isolated || !fixture) {
    process.stderr.write(`editor-smoke: --isolated and --fixture are required\n${usage()}`);
    return EXIT.USAGE;
  }

  const guard = installNetworkGuard();
  /** @type {any[]} */
  const checks = [];
  /** @type {any[]} */
  const rpcCalls = [];
  /** @type {string[]} */
  const unregisteredEndpoints = [];
  let root = null;
  /** @type {any} */
  let service = null;
  let operatorSequence = 0;

  /** @param {string} name @param {() => Promise<any>|any} fn */
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ step: name, status: 'pass', ...(detail === undefined ? {} : { detail }) });
      return true;
    } catch (error) {
      checks.push({ step: name, status: 'fail', error_code: error?.code ?? 'SMOKE_STEP_FAILED', message: String(error?.message ?? error).slice(0, 300) });
      return false;
    }
  };

  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-06-editor-smoke-'));
    const fixtureState = createFixture(root);
    service = fixtureState.service;

    const { exports: bundle, bundleSha256 } = await loadClientBundle();
    const { rpc, commands, editor, xmlDraft, conflict } = bundle.__test;

    /** @type {any} */
    const ownerPeer = { principal: { kind: 'owner', principal_id: 'owner-1' }, signal: new AbortController().signal };
    /** @type {object[]} */
    const requests = [];
    const transport = {
      async call(channel, endpoint, payload, signal) {
        if (channel !== CHANNEL) throw new Error(`unexpected channel ${channel}`);
        let registered = ENDPOINTS.includes(endpoint);
        if (!registered) unregisteredEndpoints.push(endpoint);
        const result = await service.handle(endpoint, payload, signal, ownerPeer);
        rpcCalls.push({
          channel,
          endpoint,
          operation_id: payload?.operation_id ?? null,
          view_epoch: payload?.view_epoch ?? null,
          registered_endpoint: registered,
          transport_ok: result?.ok === true,
          business_status: result?.ok === true ? result.value?.status ?? null : null,
          reason_code: result?.ok === true ? result.value?.reason_code ?? null : result?.error?.code ?? null,
        });
        return result;
      },
    };

    /** @type {any} */
    let lastRequest = null;
    const callEndpoint = async (endpoint, input, viewEpoch) => {
      operatorSequence += 1;
      const built = rpc.buildRequest({
        operation_id: `op-smoke-${String(operatorSequence).padStart(6, '0')}`,
        context_ref: 'ctx-demo',
        expected_scope_generation: 0,
        view_epoch: viewEpoch,
        input,
      });
      if (built.ok !== true) throw new Error(`request shell invalid for ${endpoint}`);
      lastRequest = built.request;
      requests.push({ endpoint, operation_id: built.request.operation_id });
      const interpreted = await rpc.callEndpoint(transport, endpoint, built.request);
      return { request: built.request, interpreted };
    };

    /** @type {any} */
    const sessions = {};

    // 1. open view A
    await check('open view A (generation 0)', async () => {
      const { interpreted } = await callEndpoint('document.open', { document_ref: 'doc-demo' }, 1);
      if (interpreted.kind !== 'ok') throw new Error(`open failed: ${interpreted.kind}/${interpreted.code ?? interpreted.reason_code}`);
      const data = interpreted.data;
      sessions.A = data;
      if (data.version.generation !== 0) throw new Error('first open must bootstrap generation 0');
      const text = JSON.stringify(data);
      if (text.includes(fixtureState.artifactDir) || text.includes(fixtureState.dataRoot)) throw new Error('open response leaked a filesystem path');
      if (typeof data.xml !== 'string' || !data.xml.startsWith('<mxfile')) throw new Error('open response is missing canonical XML');
      return { document_id: data.document_id, generation: 0, session_bound: typeof data.editor_session_ref === 'string' };
    });

    // 2. open view B (the doomed stale writer)
    await check('open view B (second session)', async () => {
      const { interpreted } = await callEndpoint('document.open', { document_ref: 'doc-demo' }, 2);
      if (interpreted.kind !== 'ok') throw new Error(`second open failed: ${interpreted.kind}`);
      sessions.B = interpreted.data;
      if (sessions.B.editor_session_ref === sessions.A.editor_session_ref) throw new Error('two views must have distinct editor sessions');
      return { generation: sessions.B.version.generation };
    });

    /** @type {any} */
    let modelA = null;
    /** @type {string} */
    let saveNOperation = null;

    // 3. drag exactly one node -> one move_node command
    await check('drag commits exactly one move_node command on pointerup', async () => {
      modelA = editor.createEditorModel(sessions.A.base_spec, sessions.A.overlay);
      const drag = commands.beginDrag({
        node_id: 'n1',
        pointer_id: 11,
        position: { x: 40, y: 40, width: 160, height: 64 },
        client_x: 40,
        client_y: 40,
      });
      if (drag.ok !== true) throw new Error('beginDrag failed');
      commands.updateDrag(drag.drag, { client_x: 80, client_y: 70 });
      const committed = commands.commitDrag(drag.drag, { client_x: 120, client_y: 100 });
      if (committed.ok !== true) throw new Error('commitDrag failed');
      const secondCommit = commands.commitDrag(drag.drag);
      if (secondCommit.ok !== false) throw new Error('pointerup must commit exactly one command');
      const moved = commands.runEdit({ model: modelA, kind: 'move_node', payload: committed.payload, sequence: 1 });
      if (moved.status !== 'ok') throw new Error(`move_node rejected: ${moved.code}`);
      modelA = moved.model;
      if (modelA.draft_revision !== 1) throw new Error('draft revision did not advance');
      return { payload: committed.payload, draft_revision: modelA.draft_revision, commands_committed: 1 };
    });

    // 4. note + annotation edge + undo/redo
    await check('note, annotation edge, undo and redo go through the command union', async () => {
      const note = commands.runEdit({
        model: modelA,
        kind: 'set_note',
        payload: commands.notePayload({ annotation_id: 'ann:note-1', target_ref: 'n1', text: 'smoke note', position: { x: 40, y: 112, width: 200, height: 72 } }),
        sequence: 2,
      });
      if (note.status !== 'ok') throw new Error(`set_note rejected: ${note.code}`);
      modelA = note.model;
      const edge = commands.runEdit({
        model: modelA,
        kind: 'add_annotation_edge',
        payload: commands.annotationEdgePayload({ id: 'ann:edge-1', from: 'n1', to: 'n2', label: 'manual link' }),
        sequence: 3,
      });
      if (edge.status !== 'ok') throw new Error(`add_annotation_edge rejected: ${edge.code}`);
      modelA = edge.model;
      const undone = commands.runEdit({ model: modelA, kind: 'undo', payload: {}, sequence: 4 });
      if (undone.status !== 'ok' || undone.model.overlay.items.some((item) => item.id === 'ann:edge-1')) throw new Error('undo did not remove the annotation edge');
      const redone = commands.runEdit({ model: undone.model, kind: 'redo', payload: {}, sequence: 5 });
      if (redone.status !== 'ok' || !redone.model.overlay.items.some((item) => item.id === 'ann:edge-1')) throw new Error('redo did not restore the annotation edge');
      modelA = redone.model;
      return {
        draft_revision: modelA.draft_revision,
        items: modelA.overlay.items.map((item) => item.kind).sort(),
        annotation_origin_ok: modelA.overlay.items.every((item) => item.kind !== 'annotation_edge' || (item.from === 'n1' && item.to === 'n2')),
      };
    });

    // 5. save A with the exact expected version
    await check('save view A advances the immutable revision to generation 1', async () => {
      const built = xmlDraft.buildSaveInput({
        document_id: sessions.A.document_id,
        editor_session_ref: sessions.A.editor_session_ref,
        expected_version: sessions.A.version,
        base_spec: sessions.A.base_spec,
        overlay: modelA.overlay,
      });
      if (built.ok !== true) throw new Error(`save XML assembly failed: ${built.code}`);
      const { request, interpreted } = await callEndpoint('document.save', built.input, 1);
      saveNOperation = request.operation_id;
      if (interpreted.kind !== 'ok') throw new Error(`save failed: ${interpreted.kind}/${interpreted.code ?? interpreted.reason_code}`);
      if (interpreted.data.version.generation !== 1) throw new Error('save did not advance the generation');
      sessions.A = { ...sessions.A, version: interpreted.data.version, overlay: modelA.overlay };
      return { generation: 1, xml_bytes: built.xml.length, operation_id: saveNOperation };
    });

    // 6. stale conflict from view B
    await check('view B save is a conflict carrying the current version (no auto-retry)', async () => {
      let modelB = editor.createEditorModel(sessions.B.base_spec, sessions.B.overlay);
      const added = commands.runEdit({
        model: modelB,
        kind: 'add_annotation_node',
        payload: commands.annotationNodePayload({ id: 'ann:node-b', label: 'from view B', description: null, position: { x: 360, y: 160, width: 160, height: 64 } }),
        sequence: 1,
      });
      if (added.status !== 'ok') throw new Error(`add_annotation_node rejected: ${added.code}`);
      modelB = added.model;
      const built = xmlDraft.buildSaveInput({
        document_id: sessions.B.document_id,
        editor_session_ref: sessions.B.editor_session_ref,
        expected_version: sessions.B.version,
        base_spec: sessions.B.base_spec,
        overlay: modelB.overlay,
      });
      if (built.ok !== true) throw new Error('view B XML assembly failed');
      const { interpreted } = await callEndpoint('document.save', built.input, 2);
      if (interpreted.kind !== 'business_failure' || interpreted.status !== 'conflict') {
        throw new Error(`expected conflict, got ${interpreted.kind}/${interpreted.status ?? interpreted.code}`);
      }
      if (interpreted.reason_code !== 'STALE_VERSION') throw new Error(`unexpected conflict code ${interpreted.reason_code}`);
      if (interpreted.data.current_version.generation !== 1) throw new Error('conflict must carry the current Host version');
      sessions.B = { ...sessions.B, local_overlay: modelB.overlay };
      const described = conflict.describeSaveFailure(interpreted);
      const view = conflict.conflictView({ current_version: interpreted.data.current_version, draft_ref: interpreted.data.draft_ref ?? null, local_overlay: modelB.overlay });
      const resolution = conflict.resolveConflict({ choice: 'keep_both', current_version: interpreted.data.current_version });
      const draftPlan = xmlDraft.draftExportPlan({ document_id: sessions.B.document_id, generation: sessions.B.version.generation, xml: built.xml, overlay: modelB.overlay });
      if (view.options.map((option) => option.id).join(',') !== 'keep_both,export_draft,reopen') throw new Error('conflict options mismatch');
      if (resolution.ok !== true || resolution.action !== 'reopen_then_resave') throw new Error('keep-both resolution mismatch');
      if (draftPlan.ok !== true) throw new Error('draft export plan failed');
      return {
        conflict_reason: interpreted.reason_code,
        current_generation: interpreted.data.current_version.generation,
        draft_ref_is_token: typeof interpreted.data.draft_ref === 'string' && !interpreted.data.draft_ref.includes('\\') && !interpreted.data.draft_ref.includes('C:'),
        options: view.options.map((option) => option.id),
        draft_plan: draftPlan.filename,
        actions: described.actions,
      };
    });

    // 7. keep both: reopen, merge local + host overlays, resave as generation 2
    await check('keep-both merge preserves both views and saves generation 2', async () => {
      const { interpreted: reopened } = await callEndpoint('document.open', { document_ref: 'doc-demo' }, 3);
      if (reopened.kind !== 'ok') throw new Error('reopen for keep-both failed');
      const data = reopened.data;
      const rebased = editor.rebaseOverlay(data.base_spec, sessions.B.local_overlay);
      const mergedItems = commands.mergeOverlayItems(data.overlay, rebased.overlay);
      const mergedOverlay = { ...rebased.overlay, items: mergedItems };
      const mergedModel = editor.createEditorModel(data.base_spec, mergedOverlay);
      const hasHostNote = mergedModel.overlay.items.some((item) => item.kind === 'note' && item.text === 'smoke note');
      const hasLocalNode = mergedModel.overlay.items.some((item) => item.id === 'ann:node-b');
      if (!hasHostNote || !hasLocalNode) throw new Error('merge lost one side of the conflict');
      const built = xmlDraft.buildSaveInput({
        document_id: data.document_id,
        editor_session_ref: data.editor_session_ref,
        expected_version: data.version,
        base_spec: data.base_spec,
        overlay: mergedModel.overlay,
      });
      if (built.ok !== true) throw new Error('merged XML assembly failed');
      const { interpreted: saved } = await callEndpoint('document.save', built.input, 3);
      if (saved.kind !== 'ok') throw new Error(`keep-both save failed: ${saved.kind}/${saved.code ?? saved.reason_code}`);
      if (saved.data.version.generation !== 2) throw new Error('keep-both save did not create generation 2');
      sessions.C = {
        document_id: data.document_id,
        editor_session_ref: data.editor_session_ref,
        version: saved.data.version,
        base_spec: data.base_spec,
        overlay: mergedModel.overlay,
        xml: built.xml,
      };
      return { generation: 2, host_side_preserved: hasHostNote, local_side_preserved: hasLocalNode, xml_bytes: built.xml.length };
    });

    // 8. export three formats + exclusive-create conflict
    await check('document.export writes drawio/json/svg leaf refs and never overwrites', async () => {
      const results = {};
      for (const format of ['drawio', 'json', 'svg']) {
        const { interpreted } = await callEndpoint(
          'document.export',
          { document_id: sessions.C.document_id, version: sessions.C.version, output_ref: 'out-demo', format },
          4,
        );
        if (interpreted.kind !== 'ok') throw new Error(`${format} export failed: ${interpreted.kind}/${interpreted.code ?? interpreted.reason_code}`);
        const data = interpreted.data;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(drawio|json|svg)$/u.test(data.artifact_ref)) throw new Error(`unsafe artifact ref ${data.artifact_ref}`);
        if (!/^[0-9a-f]{64}$/u.test(data.sha256)) throw new Error('export sha256 malformed');
        const file = path.join(fixtureState.artifactRoot, data.artifact_ref);
        if (!fs.existsSync(file)) throw new Error(`exported file missing: ${data.artifact_ref}`);
        if (fs.statSync(file).size !== data.size_bytes) throw new Error('export size mismatch');
        results[format] = { artifact_ref: data.artifact_ref, sha256: data.sha256, size_bytes: data.size_bytes };
      }
      const again = await callEndpoint(
        'document.export',
        { document_id: sessions.C.document_id, version: sessions.C.version, output_ref: 'out-demo', format: 'drawio' },
        5,
      );
      if (again.interpreted.kind !== 'business_failure' || again.interpreted.reason_code !== 'EXPORT_EXISTS') {
        throw new Error(`second drawio export must be a conflict, got ${again.interpreted.kind}/${again.interpreted.reason_code ?? again.interpreted.code}`);
      }
      return results;
    });

    // 9. operation.get replay record
    await check('operation.get reports the saved operation', async () => {
      if (typeof saveNOperation !== 'string') throw new Error('no save operation id recorded');
      const { interpreted } = await callEndpoint('operation.get', { operation_ref: saveNOperation }, 6);
      if (interpreted.kind !== 'ok' || interpreted.data.state !== 'saved') throw new Error('operation.get did not report saved');
      return { state: interpreted.data.state, generation: interpreted.data.version?.generation ?? null };
    });

    // 10. close sessions
    await check('session.close revokes the editor session (close is not delete)', async () => {
      const closed = await callEndpoint('session.close', { editor_session_ref: sessions.C.editor_session_ref }, 7);
      if (closed.interpreted.kind !== 'ok' || closed.interpreted.data.closed !== true) throw new Error('close did not revoke the session');
      const again = await callEndpoint('session.close', { editor_session_ref: sessions.C.editor_session_ref }, 8);
      if (again.interpreted.kind !== 'ok' || again.interpreted.data.closed !== false) throw new Error('second close must report closed:false');
      return { closed: true, second_close_closed: false, document_preserved: fs.existsSync(path.join(fixtureState.dataRoot, 'documents', 'doc-001', 'pointer.json')) };
    });

    // 11. unload: service disposal rejects old calls
    await check('service unload rejects later calls (fixed transport error, no leak)', async () => {
      await service.dispose();
      const result = await service.handle(
        'document.open',
        lastRequest,
        undefined,
        ownerPeer,
      );
      if (result.ok !== false || result.error.code !== 'INTERNAL_FAILURE') throw new Error('disposed service still served a call');
      if (JSON.stringify(result).includes(fixtureState.dataRoot)) throw new Error('disposal response leaked a path');
      return { ok: false, error_code: result.error.code, message: result.error.message };
    });

    // 12. network + endpoint evidence
    await check('zero network attempts and zero unregistered RPC endpoints', async () => {
      if (guard.attempts.length !== 0) throw new Error(`network attempts recorded: ${guard.attempts.length}`);
      if (unregisteredEndpoints.length !== 0) throw new Error(`unregistered endpoints called: ${unregisteredEndpoints.join(',')}`);
      if (rpcCalls.length !== requests.length) throw new Error('transport call log is incomplete');
      return { network_attempts: guard.attempts.length, unregistered_rpc_endpoints: unregisteredEndpoints.length, rpc_calls: rpcCalls.length };
    });
  } catch (error) {
    checks.push({
      step: 'smoke-setup',
      status: 'fail',
      error_code: error?.code ?? 'SMOKE_SETUP_FAILED',
      message: String(error?.message ?? error).slice(0, 300),
    });
  } finally {
    guard.uninstall();
    if (root !== null && !keepArtifacts) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        // Windows may keep transient handles; the temp root is disposable.
      }
    }
  }

  const pass = checks.length > 0 && checks.every((entry) => entry.status === 'pass');
  const evidence = {
    schema_version: 1,
    tool: 'editor-smoke',
    mode: 'isolated-fixture',
    command: `node tools/editor-smoke.mjs ${argv.join(' ')}`.trim(),
    generated_at: new Date().toISOString(),
    isolated: true,
    network_evidence: networkEvidence,
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    fixture: {
      document_ref: 'doc-demo',
      context_ref: 'ctx-demo',
      document_id: 'doc-001',
      artifact_root: root === null ? null : '<temp>/artifact-root',
      data_root: root === null ? null : '<temp>/data',
      retained: keepArtifacts,
    },
    bundle: { file: 'plugin/client.js', id: 'dsh-local-diagrams', sha256: null },
    steps: checks,
    rpc_calls: rpcCalls,
    requests: operatorSequence,
    network: {
      guard: 'JS-level fetch/WebSocket/XMLHttpRequest counters (this Node process)',
      patched: guard.patched,
      attempts: guard.attempts,
      attempted_count: guard.attempts.length,
      unregistered_attempts: guard.attempts.length,
      registered_rpc_calls: rpcCalls.length,
      unregistered_rpc_endpoints: unregisteredEndpoints,
    },
    checks: {
      total: checks.length,
      passed: checks.filter((entry) => entry.status === 'pass').length,
      failed: checks.filter((entry) => entry.status !== 'pass').length,
    },
    evidence_refs: ['plugin/client.js', 'src/plugin/service.mjs', 'src/editor/document-store.mjs', 'tools/build-client.mjs'],
    pass,
    exit_code: pass ? EXIT.PASS : EXIT.FAIL,
    limitations: LIMITATIONS,
  };
  try {
    evidence.bundle.sha256 = createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'plugin', 'client.js'))).digest('hex');
  } catch {
    evidence.bundle.sha256 = null;
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  return pass ? EXIT.PASS : EXIT.FAIL;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error) => {
  process.stderr.write(`editor-smoke: ${String(error?.message ?? error).slice(0, 500)}\n`);
  process.exitCode = EXIT.FAIL;
});
