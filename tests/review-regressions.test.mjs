/**
 * Regression tests for the independent review findings (docs/review.md).
 *
 * R-01 generated specs carry real layout positions and opened artifacts are
 *      editable with non-zero coordinates;
 * R-02 evidence refs can be content-verified (or are marked structural-only);
 * R-03 tools/validate.mjs honours its own check results;
 * R-04 revoking one scope generation never cascades into a newer generation;
 * R-06 forward-slash UNC paths are not local executables;
 * R-07 external .drawio import is reachable from the CLI;
 * R-08 removing an annotated node/edge also removes notes targeting it;
 * R-09 source root refs are opaque references, not local paths, in specs/RPC;
 * R-10 operation.get/session.close are bound to their document;
 * R-11 corrupted artifact bytes are not reported as saved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { toDiagram } from '../src/evidence.mjs';
import { layoutDiagram } from '../src/layout.mjs';
import { renderLocal } from '../src/archive.mjs';
import { emptyOverlay, specDigest } from '../src/contracts.mjs';
import { exportDrawio, parseDrawioXml } from '../src/drawio/xml.mjs';
import { createEditorModel, executeEdit } from '../src/editor/model.mjs';
import { createDocumentStore } from '../src/editor/document-store.mjs';
import { createAccessRegistry } from '../src/editor/access.mjs';
import { createLocalDiagramsService } from '../src/plugin/service.mjs';
import { isAbsoluteLocalPath } from '../src/source-lock.mjs';
import { runRender } from '../tools/render.mjs';
import { tempRoot } from './fixtures/store/helpers.mjs';

const FIXED_NOW = '2026-11-07T02:00:00.000Z';
const OWNER_PEER = { principal: { kind: 'owner', principal_id: 'owner-1' }, signal: new AbortController().signal };
const SCOPE_REF = 'ws:demo';

function readFixture(relative) {
  const root = path.resolve(import.meta.dirname, '..');
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function evidenceSpec() {
  const result = toDiagram(
    {
      source_identity: readFixture('tests/fixtures/snapshot/source-identity.json'),
      evidence_subset: readFixture('tests/fixtures/snapshot/evidence-subset.json'),
      current_identities: readFixture('tests/fixtures/snapshot/current-identities.json'),
    },
    { now: () => FIXED_NOW },
  );
  assert.equal(result.status, 'ok', JSON.stringify(result));
  return result.spec;
}

function makeRegistry(root, artifactDir) {
  const registry = createAccessRegistry();
  assert.equal(registry.registerContext({ context_ref: 'ctx-1', scope_ref: SCOPE_REF, scope_generation: 0 }).ok, true);
  assert.equal(registry.registerOutputRoot({ output_ref: 'out-1', scope_ref: SCOPE_REF, scope_generation: 0, path: root }).ok, true);
  assert.equal(
    registry.registerDocument({
      document_ref: 'doc-1',
      document_id: 'doc-001',
      scope_ref: SCOPE_REF,
      scope_generation: 0,
      path: artifactDir,
      mode: 'edit',
    }).ok,
    true,
  );
  return registry;
}

let shellCounter = 0;
function shell(input, overrides = {}) {
  shellCounter += 1;
  return {
    schema_version: 1,
    operation_id: `op-regression-${shellCounter}`,
    context_ref: 'ctx-1',
    expected_scope_generation: 0,
    view_epoch: 3,
    input,
    ...overrides,
  };
}

function assertRpcOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

test('R-01: generated spec layout positions are real, deterministic and survive open/export', async (t) => {
  const root = tempRoot(t);
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { recursive: true });
  const spec = evidenceSpec();
  assert.equal(spec.layout.positions.length, spec.nodes.length);
  assert.deepEqual(spec.layout, layoutDiagram(spec, { direction: spec.layout.direction }));

  const first = await renderLocal(
    { spec, output_ref: 'evidence-run', renderer: 'builtin', expected_output_revision: null, operation_id: 'op-r01-render' },
    { granted: true, granted_output_root: out },
  );
  assert.equal(first.status, 'saved', JSON.stringify(first));
  const artifactSpec = JSON.parse(fs.readFileSync(path.join(first.artifact_ref, 'diagram-spec.json'), 'utf8'));
  assert.equal(artifactSpec.layout.positions.length, spec.nodes.length);

  const registry = makeRegistry(out, first.artifact_ref);
  const store = createDocumentStore({ data_root: path.join(root, 'data'), registry, clock: () => FIXED_NOW });
  const opened = await store.openDocument({ document_ref: 'doc-1', expected_scope: { scope_ref: SCOPE_REF, scope_generation: 0 } }, { principal: { kind: 'owner', principal_id: 'owner-1' } });
  assert.equal(opened.status, 'opened', JSON.stringify(opened));
  assert.equal(opened.base_spec.layout.positions.length, opened.base_spec.nodes.length);
  const uniqueCoordinates = new Set(opened.base_spec.layout.positions.map((position) => `${position.x},${position.y}`));
  assert.ok(uniqueCoordinates.size > 1, 'real artifact nodes must not all stack at one point');

  const exported = exportDrawio({ spec: opened.base_spec, annotation_overlay: opened.overlay });
  const geometries = [...exported.xml.matchAll(/<mxCell[^>]*vertex="1"[^>]*>\s*<mxGeometry x="(-?\d+)" y="(-?\d+)"/gu)];
  assert.ok(geometries.length >= opened.base_spec.nodes.length, 'every base node has mxGeometry');
  const positions = new Set(geometries.map((match) => `${match[1]},${match[2]}`));
  assert.ok(positions.size > 1, '.drawio base nodes must not all be at 0,0');
  const parsed = parseDrawioXml(exported.xml);
  assert.equal(parsed.ok, true);
});

test('R-02: a trusted evidence verifier rejects unverifiable refs; no verifier is marked structural-only', () => {
  const input = {
    source_identity: readFixture('tests/fixtures/snapshot/source-identity.json'),
    evidence_subset: readFixture('tests/fixtures/snapshot/evidence-subset.json'),
  };
  const structural = toDiagram(input, { now: () => FIXED_NOW });
  assert.equal(structural.status, 'ok');
  assert.ok(structural.spec.coverage.notes.some((note) => note.includes('structurally validated only')));
  const verified = toDiagram(input, { now: () => FIXED_NOW, verify_evidence: () => ({ ok: true }) });
  assert.equal(verified.status, 'ok');
  assert.ok(verified.spec.coverage.notes.some((note) => note.includes('content-checked by trusted verifier')));
  const rejected = toDiagram(input, { now: () => FIXED_NOW, verify_evidence: (ref) => ({ ok: false, reason: `not in manifest: ${ref.evidence_id}` }) });
  assert.equal(rejected.status, 'invalid');
  assert.equal(rejected.code, 'INVALID_SPEC');
});

test('R-03: tools/validate.mjs report is genuinely green and fail-coded', () => {
  const result = spawnSync(process.execPath, ['tools/validate.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.fail, 0);
  assert.equal(report.pass, 7);
  for (const check of report.checks) {
    assert.equal(check.ok, true, `${check.name} must really pass`);
    if (check.detail !== undefined && check.detail.ok === false) assert.fail(`${check.name} reported ok:false in detail`);
  }
});

test('R-04: revoking one scope generation does not disable a newer generation', () => {
  const registry = createAccessRegistry();
  assert.equal(registry.registerContext({ context_ref: 'ctx-old', scope_ref: 'scope:gen', scope_generation: 0 }).ok, true);
  assert.equal(registry.registerContext({ context_ref: 'ctx-new', scope_ref: 'scope:gen', scope_generation: 1 }).ok, true);
  // Documents are registered outside an output root in this unit test; the
  // registry only needs scopes for revoke cascade semantics.
  const old = registry.revoke({ kind: 'context', ref: 'ctx-old', scope_generation: 0 });
  assert.equal(old.ok, true);
  assert.equal(registry.lookupContext('ctx-old', 0).ok, false);
  assert.equal(registry.lookupContext('ctx-new', 1).ok, true, 'newer generation must stay active');
  // Without an explicit generation, every matching context ref is revoked.
  const both = registry.revoke({ kind: 'context', ref: 'ctx-new' });
  assert.equal(both.ok, true);
  assert.equal(registry.lookupContext('ctx-new', 1).ok, false);
});

test('R-06: forward-slash and backslash UNC paths are not local absolute executables', () => {
  assert.equal(isAbsoluteLocalPath('//server/share/x.exe'), false);
  assert.equal(isAbsoluteLocalPath('\\\\server\\share\\x.exe'), false);
  assert.equal(isAbsoluteLocalPath('\\\\x'), false);
  assert.equal(isAbsoluteLocalPath('x.exe'), false);
  if (process.platform === 'win32') {
    assert.equal(isAbsoluteLocalPath('C:\\tools\\x.exe'), true);
    assert.equal(isAbsoluteLocalPath('/usr/bin/x'), false);
  } else {
    assert.equal(isAbsoluteLocalPath('/usr/bin/x'), true);
  }
});

test('R-07: external .drawio import is reachable from the CLI and stays conceptual', async (t) => {
  const root = tempRoot(t);
  const out = path.join(root, 'out');
  const external = path.join(path.resolve(import.meta.dirname, '..'), 'tests/fixtures/drawio/external-basic.drawio');
  const imported = await runRender(['--import-drawio', external, '--out', out]);
  assert.equal(imported.exitCode, 0, JSON.stringify(imported.summary));
  assert.equal(imported.summary.status, 'saved');
  assert.equal(imported.summary.mode, 'conceptual');
  assert.ok(imported.summary.overlay_items > 0);
  assert.equal(imported.summary.checks.remote_refs, 0);

  const compressed = path.join(path.resolve(import.meta.dirname, '..'), 'tests/fixtures/drawio/compressed.drawio');
  const rejected = await runRender(['--import-drawio', compressed, '--out', path.join(root, 'out2')]);
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.summary.code, 'UNSUPPORTED');
});

test('R-08: removing an annotated node/edge also removes notes that target it', () => {
  const base = {
    schema_version: 1,
    diagram_id: 'diagram:concept',
    revision: 0,
    mode: 'conceptual',
    title: 'concept',
    scope_ref: 'scope:concept',
    sources: [],
    nodes: [
      { id: 'n1', label: 'one', kind: 'module', origin: 'annotation', evidence_refs: [], description: null },
      { id: 'n2', label: 'two', kind: 'module', origin: 'annotation', evidence_refs: [], description: null },
    ],
    edges: [],
    layout: {
      algorithm: 'layered_v1',
      direction: 'LR',
      positions: [
        { node_id: 'n1', x: 10, y: 10, width: 160, height: 64 },
        { node_id: 'n2', x: 300, y: 10, width: 160, height: 64 },
      ],
    },
    coverage: { complete: false, truncated: false, omitted_nodes: 0, omitted_edges: 0, unresolved_count: 0, notes: [] },
    source_state: 'unknown',
    generated_at: FIXED_NOW,
    renderer_ref: 'builtin:renderer-v1',
  };
  let model = createEditorModel(base, emptyOverlay({ diagram_id: base.diagram_id, base_spec_digest: specDigest(base), now: FIXED_NOW }));
  const node = executeEdit(model, {
    command_id: 'cmd-add-node',
    expected_draft_revision: model.draft_revision,
    kind: 'add_annotation_node',
    payload: { id: 'ann:new', label: 'new', description: null, position: { x: 500, y: 10, width: 160, height: 64 } },
  });
  assert.equal(node.status, 'ok', JSON.stringify(node));
  model = node.model;
  const edge = executeEdit(model, {
    command_id: 'cmd-add-edge',
    expected_draft_revision: model.draft_revision,
    kind: 'add_annotation_edge',
    payload: { id: 'ann:edge', from: 'n1', to: 'ann:new', label: 'rel', description: null },
  });
  assert.equal(edge.status, 'ok', JSON.stringify(edge));
  model = edge.model;
  const note = executeEdit(model, {
    command_id: 'cmd-note-edge',
    expected_draft_revision: model.draft_revision,
    kind: 'set_note',
    payload: { annotation_id: 'ann:note-on-edge', target_ref: 'ann:edge', text: 'note on the edge', position: { x: 20, y: 20, width: 120, height: 40 } },
  });
  assert.equal(note.status, 'ok', JSON.stringify(note));
  model = note.model;
  const removedNode = executeEdit(model, {
    command_id: 'cmd-remove-node',
    expected_draft_revision: model.draft_revision,
    kind: 'remove_annotation_node',
    payload: { node_id: 'ann:new' },
  });
  assert.equal(removedNode.status, 'ok', JSON.stringify(removedNode));
  assert.equal(removedNode.model.overlay.items.some((item) => item.id === 'ann:new' || item.id === 'ann:edge' || item.id === 'ann:note-on-edge'), false);

  let model2 = createEditorModel(base, emptyOverlay({ diagram_id: base.diagram_id, base_spec_digest: specDigest(base), now: FIXED_NOW }));
  const e2 = executeEdit(model2, {
    command_id: 'cmd-add-edge-2',
    expected_draft_revision: model2.draft_revision,
    kind: 'add_annotation_edge',
    payload: { id: 'ann:edge2', from: 'n1', to: 'n2', label: 'rel', description: null },
  });
  model2 = e2.model;
  const n2 = executeEdit(model2, {
    command_id: 'cmd-note-edge-2',
    expected_draft_revision: model2.draft_revision,
    kind: 'set_note',
    payload: { annotation_id: 'ann:note-edge2', target_ref: 'ann:edge2', text: 'note', position: { x: 20, y: 20, width: 120, height: 40 } },
  });
  model2 = n2.model;
  const removedEdge = executeEdit(model2, {
    command_id: 'cmd-remove-edge2',
    expected_draft_revision: model2.draft_revision,
    kind: 'remove_annotation',
    payload: { id: 'ann:edge2' },
  });
  assert.equal(removedEdge.status, 'ok', JSON.stringify(removedEdge));
  assert.equal(removedEdge.model.overlay.items.some((item) => item.id === 'ann:edge2' || item.id === 'ann:note-edge2'), false);
});

test('R-09/R-10: RPC open hides raw roots, operation.get/session.close are document-bound', async (t) => {
  const root = tempRoot(t);
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { recursive: true });
  const spec = evidenceSpec();
  const rendered = await renderLocal(
    { spec, output_ref: 'evidence-run', renderer: 'builtin', expected_output_revision: null, operation_id: 'op-r09-render' },
    { granted: true, granted_output_root: out },
  );
  assert.equal(rendered.status, 'saved', JSON.stringify(rendered));
  const registry = makeRegistry(out, rendered.artifact_ref);
  const store = createDocumentStore({ data_root: path.join(root, 'data'), registry, clock: () => FIXED_NOW });
  const service = createLocalDiagramsService({ registry, store, clock: () => FIXED_NOW });

  const opened = assertRpcOk(await service.handle('document.open', shell({ document_ref: 'doc-1' }), undefined, OWNER_PEER));
  assert.equal(opened.status, 'ok', JSON.stringify(opened));
  const serialized = JSON.stringify(opened);
  assert.equal(serialized.includes('H:/fixture/repo-svc'), false, 'RPC must not leak a registered root path');
  assert.equal(/[A-Za-z]:[\\/]/u.test(serialized), false, 'RPC must not leak drive paths');
  for (const source of opened.data.base_spec.sources) {
    for (const repo of source.repos) assert.match(repo.root_ref, /^root-ref:[0-9a-f]{16}$/u);
  }
  const documentId = opened.data.document_id;
  const sessionRef = opened.data.editor_session_ref;
  const version = opened.data.version;

  const saved = assertRpcOk(
    await service.handle(
      'document.save',
      shell({ document_id: documentId, editor_session_ref: sessionRef, expected_version: version, xml: opened.data.xml, overlay: opened.data.overlay }),
      undefined,
      OWNER_PEER,
    ),
  );
  assert.equal(saved.status, 'ok', JSON.stringify(saved));

  const wrongDocLookup = assertRpcOk(
    await service.handle('operation.get', shell({ operation_ref: 'op-does-not-exist', document_id: 'doc-999' }), undefined, OWNER_PEER),
  );
  assert.equal(wrongDocLookup.status, 'ok');
  assert.equal(wrongDocLookup.data.state, 'unknown');

  const wrongDocClose = assertRpcOk(
    await service.handle('session.close', shell({ editor_session_ref: sessionRef, document_id: 'doc-999' }), undefined, OWNER_PEER),
  );
  assert.equal(wrongDocClose.status, 'ok');
  assert.equal(wrongDocClose.data.closed, false, 'a session ref alone must not close another document session');
  const correctClose = assertRpcOk(
    await service.handle('session.close', shell({ editor_session_ref: sessionRef, document_id: documentId }), undefined, OWNER_PEER),
  );
  assert.equal(correctClose.data.closed, true);
  await service.dispose();
});

test('R-11: a tampered artifact is never reported as saved', async (t) => {
  const root = tempRoot(t);
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { recursive: true });
  const spec = evidenceSpec();
  const request = { spec, output_ref: 'evidence-run', renderer: 'builtin', expected_output_revision: null, operation_id: 'op-r11-a' };
  const caller = { granted: true, granted_output_root: out };
  const first = await renderLocal(request, caller);
  assert.equal(first.status, 'saved');
  const svgPath = path.join(first.artifact_ref, 'diagram.svg');
  const original = fs.readFileSync(svgPath, 'utf8');
  fs.writeFileSync(svgPath, original.replace(original.slice(-20), original.slice(-20).replace(/\n?$/u, 'X')));
  const again = await renderLocal({ ...request, operation_id: 'op-r11-b' }, caller);
  assert.notEqual(again.status, 'saved', JSON.stringify(again));
  assert.ok(['conflict', 'outcome_unknown', 'failed'].includes(again.status), JSON.stringify(again));
});
