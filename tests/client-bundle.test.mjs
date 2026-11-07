/**
 * Client bundle tests (docs/interfaces.md §11).
 *
 *  - tools/build-client.mjs output is deterministic and `--check` clean;
 *  - the built plugin/client.js registers as a lazy CJS rc.5 module
 *    (`window.__ModuleLoader__.load({id, factory})`), exports the plugin shape,
 *    and its `apply` registers the `main` keyed slot with the panel;
 *  - pure helpers the panel uses (RPC envelopes, view/SVG whitelist, command
 *    mapping, save XML, conflict plans, SHA-256) behave under a fake
 *    `window.__ModuleLoader__` + fake `require` — i.e. the same code the browser
 *    loads without the TS build chain;
 *  - the static surface has no eval/new Function/fetch/WebSocket/remote URLs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { buildClient, BUNDLE_ID } from '../tools/build-client.mjs';
import { exportDrawio, parseDrawioXml, canonicalMxGraph } from '../src/drawio/xml.mjs';
import { buildArtifactPackage, tempRoot } from './fixtures/store/helpers.mjs';

const BUNDLE_PATH = path.resolve('plugin/client.js');

/** Minimal React stub sufficient for module materialization + direct panel call. */
function reactStub() {
  const createElement = (type, props, ...children) => ({
    type,
    key: props?.key ?? undefined,
    props: props ?? {},
    children: children.flat(),
  });
  return {
    createElement,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => [initial, () => {}],
  };
}

/**
 * Load the generated bundle exactly like the rc.5 client module system does:
 * capture the loader registration, then materialize the factory with a platform
 * require table.
 * @param {import('node:test').TestContext} t
 */
async function loadBundle(t) {
  const previousWindow = globalThis.window;
  /** @type {any[]} */
  const registrations = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(record) {
        registrations.push(record);
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  await import(`${pathToFileURL(BUNDLE_PATH).href}?v=${Date.now()}`);
  assert.equal(registrations.length, 1, 'bundle must register exactly one module');
  const registration = registrations[0];
  assert.equal(registration.id, BUNDLE_ID);
  assert.equal(typeof registration.factory, 'function');

  /** @type {Record<string, any>} */
  const platform = {
    react: reactStub(),
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
  };
  /** @type {string[]} */
  const platformRequests = [];
  const exports = registration.factory((specifier) => {
    platformRequests.push(specifier);
    if (!Object.hasOwn(platform, specifier)) throw new Error(`unexpected platform require: ${specifier}`);
    return platform[specifier];
  });
  return { exports, registration, platformRequests, react: platform.react };
}

/* -------------------------------------------------------------------------- */
/* build tool                                                                  */
/* -------------------------------------------------------------------------- */

test('build-client: deterministic output and --check is current', (t) => {
  const first = buildClient({ check: true });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.status, 'current');
  assert.ok(first.modules >= 10);
  assert.deepEqual(first.externals, ['react']);
  assert.ok(first.bytes > 100000);

  const again = buildClient({ check: true });
  assert.equal(again.sha256, first.sha256, 'build must be byte-deterministic');
  assert.equal(again.sources_digest, first.sources_digest);

  // A stale file is detected: write a tampered copy and check against it.
  const temp = tempRoot(t);
  const target = path.join(temp, 'client.js');
  fs.writeFileSync(target, '// stale\n', 'utf8');
  const stale = buildClient({ check: true, outFile: target });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 'stale');
});

test('build-client: generated bundle is a single lazy-CJS registration with no ESM syntax', () => {
  const text = fs.readFileSync(BUNDLE_PATH, 'utf8');
  assert.match(text, /window\.__ModuleLoader__\.load\(\{/u);
  assert.match(text, /id: "dsh-local-diagrams"/u);
  assert.equal(/^\s*import\s/mu.test(text), false, 'no import statements may remain');
  assert.equal(/^\s*export\s/mu.test(text), false, 'no export statements may remain');
  // node:crypto is lowered to the inlined browser shim; only the hash module's
  // doc comment may still mention the host specifier.
  assert.equal(text.includes("from 'node:crypto'"), false);
  assert.equal(text.includes('require("node:crypto")'), false);
  assert.equal(text.includes('__require("ui/hash.mjs")') || text.includes("__require('ui/hash.mjs')"), true);
});

test('build-client: static surface has no eval / network / remote resources', () => {
  const text = fs.readFileSync(BUNDLE_PATH, 'utf8');
  // Scan runtime call forms (documentation may name the APIs as prose).
  for (const forbidden of [
    'eval(',
    'new Function(',
    'XMLHttpRequest',
    '.fetch(',
    'globalThis.fetch(',
    'new WebSocket(',
    'importScripts(',
    'navigator.sendBeacon(',
    'document.cookie',
    'dangerouslySetInnerHTML',
  ]) {
    assert.equal(text.includes(forbidden), false, `bundle must not contain ${forbidden}`);
  }
  const ALLOWED_URLS = new Set([
    // Inert identifiers, never fetched: JSON-Schema dialect id and the SVG namespace.
    'https://json-schema.org/draft/2020-12/schema',
    'http://www.w3.org/2000/svg',
  ]);
  const urls = text.match(/https?:\/\/[^\s"'`)]+/gu) ?? [];
  for (const url of urls) {
    assert.equal(ALLOWED_URLS.has(url), true, `unexpected URL in bundle: ${url}`);
  }
});

/* -------------------------------------------------------------------------- */
/* rc.5 module shape + registration                                            */
/* -------------------------------------------------------------------------- */

test('bundle: registers under the rc.5 loader id and exports the plugin shape', async (t) => {
  const { exports, registration, platformRequests } = await loadBundle(t);
  assert.equal(registration.id, 'dsh-local-diagrams');
  assert.equal(exports.name, 'local-diagrams');
  assert.deepEqual([...exports.inject], ['slots', 'layout', 'connection']);
  assert.equal(typeof exports.apply, 'function');
  assert.equal(typeof exports.LocalDiagramsPanel, 'function');
  assert.ok(Object.isFrozen(exports.__test));
  assert.deepEqual(platformRequests.length > 0 ? [...new Set(platformRequests)] : [], ['react']);
});

test('bundle: apply registers the main keyed slot with the panel', async (t) => {
  const { exports } = await loadBundle(t);
  /** @type {any[]} */
  const calls = [];
  const ctx = {
    slots: {
      inject(slotName, callback) {
        calls.push(['inject', slotName]);
        return callback();
      },
      register(options, component) {
        calls.push(['register', options, component]);
        return () => {};
      },
    },
    layout: { selectPanel: () => {} },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  };
  exports.apply(ctx);
  assert.deepEqual(calls[0], ['inject', 'main']);
  assert.deepEqual(calls[1][0], 'register');
  assert.deepEqual(calls[1][1], { name: 'main', key: 'local-diagrams' });
  assert.equal(typeof calls[1][2], 'function');
  // The wrapper renders the exported panel with the plugin ctx.
  const element = calls[1][2]({});
  assert.equal(element.props.ctx, ctx);

  assert.throws(() => exports.apply(undefined), TypeError);
  assert.throws(() => exports.apply({ slots: { inject() {}, register() {} } }), TypeError);
  assert.throws(
    () => exports.apply({ slots: { inject() {}, register() {} }, connection: { rpc: {} } }),
    TypeError,
  );
});
test('bundle: panel renders a safe DOM tree (no session open)', async (t) => {
  const { exports } = await loadBundle(t);
  const element = exports.LocalDiagramsPanel({ ctx: undefined });
  assert.equal(typeof element, 'object');
  assert.equal(element.type, 'div');
  const flatText = JSON.stringify(element);
  assert.equal(flatText.includes('Local diagrams'), true);
  assert.equal(flatText.includes('Open a registered document'), true);
  assert.equal(flatText.includes('dangerouslySetInnerHTML'), false);
});

/* -------------------------------------------------------------------------- */
/* RPC envelope construction + interpretation                                  */
/* -------------------------------------------------------------------------- */

function validShell(overrides = {}) {
  return {
    operation_id: 'op-test-000001',
    context_ref: 'ctx-demo',
    expected_scope_generation: 0,
    view_epoch: 4,
    input: { document_ref: 'doc-demo' },
    ...overrides,
  };
}

test('bundle rpc: builds the strict closed request shell', async (t) => {
  const { exports } = await loadBundle(t);
  const { rpc } = exports.__test;
  const built = rpc.buildRequest(validShell());
  assert.equal(built.ok, true);
  assert.deepEqual(built.request, {
    schema_version: 1,
    operation_id: 'op-test-000001',
    context_ref: 'ctx-demo',
    expected_scope_generation: 0,
    view_epoch: 4,
    input: { document_ref: 'doc-demo' },
  });
  for (const bad of [
    validShell({ operation_id: '' }),
    validShell({ context_ref: '../ctx' }),
    validShell({ expected_scope_generation: -1 }),
    validShell({ view_epoch: 1.5 }),
    validShell({ input: null }),
    null,
  ]) {
    assert.equal(rpc.buildRequest(bad).ok, false);
  }
});

test('bundle rpc: checks result.ok first, then validates the business union', async (t) => {
  const { exports } = await loadBundle(t);
  const { rpc } = exports.__test;
  const request = rpc.buildRequest(validShell()).request;
  /** @type {any[]} */
  const transportCalls = [];
  const okTransport = {
    async call(channel, endpoint, payload, signal) {
      transportCalls.push({ channel, endpoint, payload, signal });
      return {
        ok: true,
        value: {
          schema_version: 1,
          operation_id: request.operation_id,
          view_epoch: request.view_epoch,
          scope_generation: request.expected_scope_generation,
          status: 'ok',
          data: { document_id: 'doc-001' },
        },
      };
    },
  };
  const ok = await rpc.callEndpoint(okTransport, 'document.open', request);
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.data.document_id, 'doc-001');
  assert.equal(transportCalls[0].channel, '/local-diagrams');
  assert.equal(transportCalls[0].endpoint, 'document.open');
  assert.deepEqual(transportCalls[0].payload, request);

  const denied = await rpc.callEndpoint(
    {
      async call() {
        return {
          ok: true,
          value: {
            schema_version: 1,
            operation_id: request.operation_id,
            view_epoch: request.view_epoch,
            scope_generation: 0,
            status: 'denied',
            reason_code: 'DOCUMENT_DENIED',
          },
        };
      },
    },
    'document.open',
    request,
  );
  assert.equal(denied.kind, 'business_failure');
  assert.equal(denied.status, 'denied');
  assert.equal(denied.reason_code, 'DOCUMENT_DENIED');

  const transportFailure = await rpc.callEndpoint(
    {
      async call() {
        return { ok: false, error: { code: 'gateway/boom', message: 'C:/secret/path leak', details: { secret: true } } };
      },
    },
    'document.open',
    request,
  );
  assert.equal(transportFailure.kind, 'transport_failure');
  assert.equal(transportFailure.code, 'TRANSPORT_FAILURE');
  assert.equal(JSON.stringify(transportFailure).includes('secret'), false);
  assert.equal(JSON.stringify(transportFailure).includes('gateway/boom'), false);

  const thrown = await rpc.callEndpoint(
    {
      async call() {
        throw new Error('transport exploded: C:/private');
      },
    },
    'document.open',
    request,
  );
  assert.equal(thrown.kind, 'transport_failure');
  assert.equal(JSON.stringify(thrown).includes('private'), false);
});

test('bundle rpc: ignores stale view epochs and rejects malformed/mismatched responses', async (t) => {
  const { exports } = await loadBundle(t);
  const { rpc } = exports.__test;
  const request = rpc.buildRequest(validShell()).request;
  const respond = (overrides) => ({
    async call() {
      return {
        ok: true,
        value: {
          schema_version: 1,
          operation_id: request.operation_id,
          view_epoch: request.view_epoch,
          scope_generation: 0,
          status: 'ok',
          data: {},
          ...overrides,
        },
      };
    },
  });

  const stale = await rpc.callEndpoint(respond({ view_epoch: request.view_epoch - 1 }), 'document.open', request);
  assert.equal(stale.kind, 'stale_epoch');

  const mismatch = await rpc.callEndpoint(respond({ operation_id: 'op-other' }), 'document.open', request);
  assert.equal(mismatch.kind, 'invalid_response');

  const wrongScope = await rpc.callEndpoint(respond({ scope_generation: 3 }), 'document.open', request);
  assert.equal(wrongScope.kind, 'invalid_response');

  const unknownReason = await rpc.callEndpoint(
    respond({ status: 'denied', reason_code: 'MAKE_TEA', data: null }),
    'document.open',
    request,
  );
  assert.equal(unknownReason.kind, 'invalid_response');

  const extraField = await rpc.callEndpoint(respond({ secret: 'x' }), 'document.open', request);
  assert.equal(extraField.kind, 'invalid_response');

  const unknownStatus = await rpc.callEndpoint(respond({ status: 'weird' }), 'document.open', request);
  assert.equal(unknownStatus.kind, 'invalid_response');

  const notObject = await rpc.callEndpoint({ async call() { return 42; } }, 'document.open', request);
  assert.equal(notObject.kind, 'transport_failure');
});

/* -------------------------------------------------------------------------- */
/* Save XML / view / command logic under the fake loader                       */
/* -------------------------------------------------------------------------- */

test('bundle: save XML is byte-identical to the Node exporter (real SHA-256 + contracts)', (t) => {
  const artifactRoot = tempRoot(t);
  const pkg = buildArtifactPackage(path.join(artifactRoot, 'artifact'));
  return loadBundle(t).then(({ exports }) => {
    const built = exports.__test.xmlDraft.buildSaveXml({ base_spec: pkg.spec, overlay: pkg.overlay });
    assert.equal(built.ok, true, JSON.stringify(built));
    const nodeXml = exportDrawio({ spec: pkg.spec, annotation_overlay: pkg.overlay }).xml;
    assert.equal(built.xml, nodeXml, 'inlined bundle XML must match the Host exporter byte-for-byte');
    const parsed = parseDrawioXml(built.xml);
    assert.equal(parsed.ok, true);
    assert.equal(canonicalMxGraph(built.xml), canonicalMxGraph(nodeXml));

    // A malformed overlay is a fixed failure code, never a thrown exception.
    const broken = { ...pkg.overlay, base_spec_digest: 'f'.repeat(64) };
    const failed = exports.__test.xmlDraft.buildSaveXml({ base_spec: pkg.spec, overlay: broken });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'INVALID_OVERLAY');
  });
});

test('bundle: view model + SVG scene only emit whitelisted tags/attributes with plain-text labels', async (t) => {
  const { exports } = await loadBundle(t);
  const artifactRoot = tempRoot(t);
  const pkg = buildArtifactPackage(path.join(artifactRoot, 'artifact'));
  const malicious = '<script>alert(1)</script><image href="https://evil.invalid/x">';
  const overlay = JSON.parse(JSON.stringify(pkg.overlay));
  overlay.revision += 1;
  overlay.updated_at = '2026-11-07T02:00:10.000Z';
  overlay.items.push({
    id: 'ann:node-evil',
    kind: 'annotation_node',
    label: malicious,
    description: null,
    position: { x: 10, y: 10, width: 160, height: 64 },
  });
  const spec = JSON.parse(JSON.stringify(pkg.spec));
  spec.nodes[0].label = malicious;
  const view = exports.__test.view.buildViewState({ base_spec: spec, overlay, selection: ['ann:node-evil'] });
  assert.equal(view.nodes.some((node) => node.label === malicious), true);
  const scene = exports.__test.view.buildSvgScene(view, { selected: 'ann:node-evil' });

  const WHITELISTED = new Set(exports.__test.view.WHITELISTED_SVG_TAGS);
  const SAFE_ATTRS = new Set(exports.__test.view.SAFE_SVG_ATTRIBUTES);
  /** @param {any} node */
  const walk = (node) => {
    if (typeof node === 'string') {
      assert.equal(node.includes('dangerouslySetInnerHTML'), false);
      return;
    }
    assert.equal(WHITELISTED.has(node.tag), true, `non-whitelisted SVG tag ${node.tag}`);
    for (const key of Object.keys(node.attrs ?? {})) {
      assert.equal(SAFE_ATTRS.has(key), true, `non-whitelisted SVG attribute ${key}`);
      const value = String(node.attrs[key]);
      assert.equal(/on[a-z]+\s*=/iu.test(value), false, 'no event handler attributes');
      assert.equal(value.includes('<'), false, 'attributes never contain markup');
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(scene);
  const serialized = JSON.stringify(scene);
  assert.equal(serialized.includes('<script>alert'), true, 'the malicious label survives as inert text');
  assert.equal(serialized.includes('href="https://evil.invalid'), false, 'it never becomes an attribute');

  // A text equivalent exists for the annotation node (accessibility contract).
  assert.equal(view.text_equivalent.some((entry) => entry.text.includes('<script>')), true);
});

test('bundle: drag commits one move command; keyboard and form fallbacks map to the same union', async (t) => {
  const { exports } = await loadBundle(t);
  const artifactRoot = tempRoot(t);
  const pkg = buildArtifactPackage(path.join(artifactRoot, 'artifact'));
  const { commands, editor } = exports.__test;
  let model = editor.createEditorModel(pkg.spec, pkg.overlay);

  const drag = commands.beginDrag({
    node_id: 'n1',
    pointer_id: 7,
    position: { x: 40, y: 40, width: 160, height: 64 },
    client_x: 40,
    client_y: 40,
  });
  assert.equal(drag.ok, true);
  const preview1 = commands.updateDrag(drag.drag, { client_x: 60, client_y: 55 });
  const preview2 = commands.updateDrag(drag.drag, { client_x: 100, client_y: 80 });
  assert.notDeepEqual(preview1, preview2);
  const committed = commands.commitDrag(drag.drag, { client_x: 100, client_y: 80 });
  assert.deepEqual(committed.payload, { node_id: 'n1', x: 100, y: 80 });
  // A second commit is refused: exactly one command per pointer gesture.
  assert.equal(commands.commitDrag(drag.drag).ok, false);

  const moved = commands.runEdit({ model, kind: 'move_node', payload: committed.payload, sequence: 1 });
  assert.equal(moved.status, 'ok');
  model = moved.model;
  assert.equal(model.draft_revision, 1);

  const arrow = commands.keyboardMove({ node_id: 'n1', position: { x: 100, y: 80 }, key: 'ArrowRight' });
  assert.deepEqual(arrow.payload, { node_id: 'n1', x: 108, y: 80 });
  const fine = commands.keyboardMove({ node_id: 'n1', position: { x: 100, y: 80 }, key: 'ArrowUp', shift: true });
  assert.deepEqual(fine.payload, { node_id: 'n1', x: 100, y: 79 });
  assert.equal(commands.keyboardMove({ node_id: 'n1', position: { x: 0, y: 0 }, key: 'Enter' }).ok, false);

  const form = commands.coordinateMove({ node_id: 'n1', x: '12', y: '-8' });
  assert.equal(form.ok, true);
  assert.deepEqual(form.payload, { node_id: 'n1', x: 12, y: -8 });
  assert.equal(commands.coordinateMove({ node_id: 'n1', x: '12.5', y: '0' }).ok, false);
  assert.equal(commands.coordinateMove({ node_id: 'n1', x: '1e9', y: '0' }).ok, false);

  // Notes / annotation edges / removal / undo / redo through the same model.
  const note = commands.runEdit({
    model,
    kind: 'set_note',
    payload: commands.notePayload({ annotation_id: 'ann:note-1', target_ref: 'n1', text: 'hello', position: { x: 0, y: 0, width: 200, height: 72 } }),
    sequence: 2,
  });
  assert.equal(note.status, 'ok');
  model = note.model;
  assert.equal(model.overlay.items.some((item) => item.kind === 'note' && item.text === 'hello'), true);

  const edge = commands.runEdit({
    model,
    kind: 'add_annotation_edge',
    payload: commands.annotationEdgePayload({ id: 'ann:edge-1', from: 'n1', to: 'n2', label: 'manual' }),
    sequence: 3,
  });
  assert.equal(edge.status, 'ok');
  model = edge.model;
  assert.equal(model.overlay.items.some((item) => item.kind === 'annotation_edge' && item.id === 'ann:edge-1'), true);

  const undo = commands.runEdit({ model, kind: 'undo', payload: {}, sequence: 4 });
  assert.equal(undo.status, 'ok');
  assert.equal(undo.model.overlay.items.some((item) => item.id === 'ann:edge-1'), false);
  const redo = commands.runEdit({ model: undo.model, kind: 'redo', payload: {}, sequence: 5 });
  assert.equal(redo.status, 'ok');
  assert.equal(redo.model.overlay.items.some((item) => item.id === 'ann:edge-1'), true);

  const removed = commands.runEdit({
    model: redo.model,
    kind: 'remove_annotation',
    payload: commands.removeAnnotationPayload({ id: 'ann:edge-1' }),
    sequence: 6,
  });
  assert.equal(removed.status, 'ok');
  assert.equal(removed.model.overlay.items.some((item) => item.id === 'ann:edge-1'), false);
});

test('bundle: conflict helpers expose keep-both / export-draft / reopen plans and unknown-outcome polling', async (t) => {
  const { exports } = await loadBundle(t);
  const { conflict } = exports.__test;
  const failure = conflict.describeSaveFailure({
    status: 'conflict',
    reason_code: 'STALE_VERSION',
    data: { current_version: { generation: 3 }, draft_ref: 'drafts/abc/def.xml' },
  });
  assert.equal(failure.title, 'Save conflict');
  assert.deepEqual([...failure.actions], ['keep_both', 'export_draft', 'reopen']);
  assert.equal(JSON.stringify(failure).includes('C:/'), false);

  const view = conflict.conflictView({ current_version: { generation: 3 }, draft_ref: 'drafts/abc/def.xml', local_overlay: { items: [] } });
  assert.deepEqual(view.options.map((option) => option.id), ['keep_both', 'export_draft', 'reopen']);
  assert.equal(view.current_generation, 3);

  assert.deepEqual(
    conflict.resolveConflict({ choice: 'keep_both', current_version: { generation: 3 } }),
    { ok: true, action: 'reopen_then_resave', expected_version: { generation: 3 } },
  );
  assert.deepEqual(
    conflict.resolveConflict({ choice: 'export_draft' }),
    { ok: true, action: 'download_draft', expected_version: null },
  );
  assert.equal(conflict.resolveConflict({ choice: 'delete_everything' }).ok, false);

  assert.equal(conflict.operationPollPlan({ attempt: 0, operation_ref: 'op-save' }).poll, true);
  assert.equal(conflict.operationPollPlan({ attempt: 30, operation_ref: 'op-save' }).stop_reason, 'max_attempts');
  assert.equal(conflict.operationPollPlan({ attempt: 0, operation_ref: 'op-save', state: 'saved' }).poll, false);
  assert.equal(conflict.describeOperationResult({ state: 'saved', version: { generation: 2 } }).recovered_version.generation, 2);
  assert.equal(conflict.describeOperationResult({ state: 'unknown' }).state, 'unknown');

  const draft = exports.__test.xmlDraft.draftExportPlan({ document_id: 'doc-001', generation: 2, xml: '<mxfile plan="1"></mxfile>', overlay: { items: [] } });
  assert.equal(draft.ok, true);
  assert.equal(draft.filename, 'diagram-doc-001-g2-draft.json');
  assert.equal(draft.media_type, 'application/json');
   assert.equal(JSON.parse(draft.content).kind, 'local-diagrams-draft');
});

test('bundle: browser SHA-256 matches node:crypto for hashing the canonical digests', async (t) => {
  const { exports } = await loadBundle(t);
  const { hash } = exports.__test;
  const vectors = ['', 'abc', 'dsh-local-diagrams', '中文 diagram', 'x'.repeat(1000), 'y'.repeat(55), 'z'.repeat(56)];
  for (const vector of vectors) {
    const expected = createHash('sha256').update(vector, 'utf8').digest('hex');
    assert.equal(hash.sha256Hex(vector), expected);
    const incremental = hash.createHash('sha256');
    incremental.update(vector.slice(0, Math.floor(vector.length / 2)));
    incremental.update(vector.slice(Math.floor(vector.length / 2)));
    assert.equal(incremental.digest('hex'), expected);
  }
});

test('bundle: descriptor open-event contract is inlined and consistent', async (t) => {
  const { exports } = await loadBundle(t);
  const { descriptor } = exports.__test;
  assert.equal(descriptor.OPEN_EVENT, 'dsh-local-diagrams:open');
  assert.equal(descriptor.PANEL_ID, 'local-diagrams');
  const detail = descriptor.validateOpenEventDetail({
    document_ref: 'doc-demo',
    context_ref: 'ctx-demo',
    expected_scope_generation: 0,
  });
  assert.equal(detail.ok, true);
  assert.equal(
    descriptor.validateOpenEventDetail({ document_ref: 'doc-demo', context_ref: 'ctx-demo', expected_scope_generation: 0, xml: '<x/>' }).ok,
    false,
  );
});
