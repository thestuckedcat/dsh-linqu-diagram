import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson } from '../src/canonical.mjs';
import { DiagramError } from '../src/errors.mjs';
import { specDigest, validateOverlay, validateComposite } from '../src/contracts.mjs';
import { exportDrawio, parseDrawioXml } from '../src/drawio/xml.mjs';
import {
  createEditorModel,
  executeEdit,
  rebaseOverlay,
  redo,
  serializeEditorModel,
  undo,
} from '../src/editor/model.mjs';

const NOW = '2026-11-07T00:00:00.000Z';

/* -------------------------------------------------------------------------- */
/* spec fixtures                                                               */
/* -------------------------------------------------------------------------- */

function makeSpec(overrides = {}) {
  return {
    schema_version: 1,
    diagram_id: 'diagram:demo',
    revision: 0,
    mode: 'conceptual',
    title: 'Demo deployment',
    scope_ref: 'scope:demo',
    sources: [],
    nodes: [
      { id: 'step:build', label: 'build', kind: 'module', origin: 'annotation', evidence_refs: [], description: null },
      { id: 'step:ship', label: 'ship', kind: 'module', origin: 'annotation', evidence_refs: [], description: null },
    ],
    edges: [
      {
        id: 'edge:b-s',
        from: 'step:build',
        to: 'step:ship',
        kind: 'control',
        certainty: 'unknown',
        origin: 'annotation',
        label: 'then',
        evidence_refs: [],
        explanation: null,
      },
    ],
    layout: {
      algorithm: 'layered_v1',
      direction: 'LR',
      positions: [
        { node_id: 'step:build', x: 0, y: 0, width: 160, height: 64 },
        { node_id: 'step:ship', x: 256, y: 0, width: 160, height: 64 },
      ],
    },
    coverage: { complete: false, truncated: false, omitted_nodes: 0, omitted_edges: 0, unresolved_count: 0, notes: [] },
    source_state: 'unknown',
    generated_at: NOW,
    renderer_ref: 'builtin:renderer-v1',
    ...overrides,
  };
}

function makeEvidenceSpec() {
  const evidenceRef = {
    evidence_id: 'ev-1',
    source_id: 'source:demo',
    repo_id: 'repo:demo',
    path_ref: 'src/main.c',
    content_digest: 'sha256:aaa',
    line_start: 1,
    line_end: 2,
    kind: 'source',
  };
  return {
    schema_version: 1,
    diagram_id: 'diagram:evidence',
    revision: 0,
    mode: 'evidence',
    title: 'Evidence diagram',
    scope_ref: 'scope:demo',
    sources: [
      {
        source_id: 'source:demo',
        scope_ref: 'scope:demo',
        snapshot_ref: 'snapshot:demo',
        repos: [
          {
            repo_id: 'repo:demo',
            root_ref: 'repo-root',
            revision: null,
            dirty_digest: 'dirty',
            build_variant: 'debug',
            arch: 'x64',
            compdb_digest: null,
            generated_headers_digest: null,
          },
        ],
        evidence_manifest_digest: 'manifest',
      },
    ],
    nodes: [
      { id: 'svc:main', label: 'main', kind: 'function', origin: 'evidence', evidence_refs: [evidenceRef], description: null },
      { id: 'svc:helper', label: 'helper', kind: 'function', origin: 'evidence', evidence_refs: [evidenceRef], description: null },
    ],
    edges: [
      {
        id: 'edge:call',
        from: 'svc:main',
        to: 'svc:helper',
        kind: 'call',
        certainty: 'exact',
        origin: 'evidence',
        label: 'calls',
        evidence_refs: [evidenceRef],
        explanation: null,
      },
    ],
    layout: { algorithm: 'layered_v1', direction: 'LR', positions: [] },
    coverage: { complete: false, truncated: false, omitted_nodes: 0, omitted_edges: 0, unresolved_count: 0, notes: [] },
    source_state: 'current',
    generated_at: NOW,
    renderer_ref: 'builtin:renderer-v1',
  };
}

function emptyOverlayFor(spec) {
  return {
    schema_version: 1,
    diagram_id: spec.diagram_id,
    base_spec_digest: specDigest(spec),
    revision: 0,
    items: [],
    orphaned_annotations: [],
    updated_at: NOW,
  };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

let commandCounter = 0;
function command(kind, payload, expected, commandId) {
  commandCounter += 1;
  return {
    command_id: commandId ?? `cmd:${commandCounter}`,
    expected_draft_revision: expected,
    kind,
    payload,
  };
}

function apply(model, kind, payload, options = {}) {
  return executeEdit(model, command(kind, payload, model.draft_revision), { now: NOW, ...options });
}

function applyOk(model, kind, payload, options) {
  const result = apply(model, kind, payload, options);
  assert.equal(result.status, 'ok', `${kind} failed: ${JSON.stringify(result)}`);
  return result;
}

function items(model) {
  return model.overlay.items;
}

function position(x = 10, y = 20, width = 160, height = 64) {
  return { x, y, width, height };
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DiagramError, `expected DiagramError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* construction and immutability                                               */
/* -------------------------------------------------------------------------- */

test('createEditorModel builds a valid immutable model without mutating its inputs', () => {
  const spec = makeSpec();
  const specBefore = canonicalJson(spec);
  const model = createEditorModel(spec, undefined, { now: NOW });
  assert.equal(canonicalJson(spec), specBefore);
  assert.equal(model.schema_version, 1);
  assert.equal(model.base_spec_digest, specDigest(spec));
  assert.equal(model.draft_revision, 0);
  assert.equal(model.dirty, false);
  assert.deepEqual(model.selection, []);
  assert.deepEqual(model.overlay.items, []);
  assert.equal(model.overlay.base_spec_digest, model.base_spec_digest);
  assert.equal(Object.isFrozen(model), true);
  assert.throws(() => model.overlay.items.push({}), TypeError);

  const serialized = JSON.parse(serializeEditorModel(model));
  assert.deepEqual(Object.keys(serialized).sort(), [
    'base_spec_digest',
    'dirty',
    'draft_revision',
    'overlay',
    'schema_version',
    'selection',
  ]);
  assert.equal(JSON.stringify(serialized).includes('layered_v1'), false, 'internals/base spec are not serialized');
  assert.equal(serializeEditorModel(model), canonicalJson(serialized));

  const overlay = emptyOverlayFor(spec);
  const modelWithOverlay = createEditorModel(spec, overlay, { now: NOW });
  assert.equal(canonicalJson(overlay), canonicalJson(emptyOverlayFor(spec)), 'caller overlay is not mutated');
  assert.deepEqual(modelWithOverlay.overlay, overlay);
});

test('createEditorModel rejects invalid spec and overlay', () => {
  throwsCode(() => createEditorModel({ nope: true }, undefined, { now: NOW }), 'INVALID_SPEC');
  const spec = makeSpec();
  const wrongDigest = { ...emptyOverlayFor(spec), base_spec_digest: 'f'.repeat(64) };
  throwsCode(() => createEditorModel(spec, wrongDigest, { now: NOW }), 'INVALID_OVERLAY');
  const wrongDiagram = { ...emptyOverlayFor(spec), diagram_id: 'diagram:other' };
  throwsCode(() => createEditorModel(spec, wrongDiagram, { now: NOW }), 'INVALID_OVERLAY');
});

/* -------------------------------------------------------------------------- */
/* move_node / layout                                                          */
/* -------------------------------------------------------------------------- */

test('move_node writes one layout item per base node and keeps its size', () => {
  const spec = makeSpec();
  let model = createEditorModel(spec, undefined, { now: NOW });
  const first = applyOk(model, 'move_node', { node_id: 'step:build', x: 32, y: 40 });
  model = first.model;
  assert.equal(model.draft_revision, 1);
  assert.equal(items(model).length, 1);
  const layout = items(model)[0];
  assert.equal(layout.kind, 'layout');
  assert.equal(layout.target_ref, 'step:build');
  assert.deepEqual(layout.position, { x: 32, y: 40, width: 160, height: 64 });

  const second = applyOk(model, 'move_node', { node_id: 'step:build', x: 64, y: 80 });
  model = second.model;
  assert.equal(items(model).filter((item) => item.kind === 'layout').length, 1, 'layout stays unique per target');
  assert.deepEqual(items(model)[0].position, { x: 64, y: 80, width: 160, height: 64 });
});

test('move_node moves an annotation node but keeps its width/height, and refuses hidden/unknown nodes', () => {
  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  model = applyOk(model, 'add_annotation_node', {
    id: 'ann:extra',
    label: 'extra',
    description: null,
    position: position(5, 6, 200, 80),
  }).model;
  model = applyOk(model, 'move_node', { node_id: 'ann:extra', x: 50, y: 60 }).model;
  const node = items(model).find((item) => item.id === 'ann:extra');
  assert.deepEqual(node.position, { x: 50, y: 60, width: 200, height: 80 });

  const hidden = applyOk(model, 'set_visibility', { target_ref: 'step:ship', hidden: true }).model;
  const moveHidden = executeEdit(
    hidden,
    command('move_node', { node_id: 'step:ship', x: 1, y: 1 }, hidden.draft_revision),
    { now: NOW },
  );
  assert.equal(moveHidden.status, 'invalid');
  assert.equal(moveHidden.code, 'INVALID_COMMAND');

  const moveUnknown = executeEdit(
    model,
    command('move_node', { node_id: 'step:missing', x: 1, y: 1 }, model.draft_revision),
    { now: NOW },
  );
  assert.equal(moveUnknown.status, 'invalid');
});

/* -------------------------------------------------------------------------- */
/* notes                                                                       */
/* -------------------------------------------------------------------------- */

test('set_note creates and updates notes and validates its target', () => {
  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  const created = applyOk(model, 'set_note', {
    annotation_id: 'ann:note',
    target_ref: 'step:build',
    text: 'first',
    position: position(),
  });
  model = created.model;
  assert.equal(created.inverse.remove_ids[0], 'ann:note');
  assert.equal(items(model).length, 1);
  assert.equal(items(model)[0].kind, 'note');

  model = applyOk(model, 'set_note', {
    annotation_id: 'ann:note',
    target_ref: null,
    text: 'second',
    position: position(1, 2),
  }).model;
  assert.equal(items(model).filter((item) => item.id === 'ann:note').length, 1);
  assert.equal(items(model)[0].text, 'second');
  assert.equal(items(model)[0].target_ref, null);

  for (const payload of [
    { annotation_id: 'ann:bad', target_ref: 'step:missing', text: 'x', position: position() },
    { annotation_id: 'note-without-prefix', target_ref: null, text: 'x', position: position() },
    { annotation_id: 'edge:b-s', target_ref: null, text: 'x', position: position() },
  ]) {
    const result = executeEdit(model, command('set_note', payload, model.draft_revision), { now: NOW });
    assert.equal(result.status, 'invalid', JSON.stringify(payload));
    assert.equal(result.code, 'INVALID_COMMAND');
  }
});

/* -------------------------------------------------------------------------- */
/* annotation nodes and edges                                                  */
/* -------------------------------------------------------------------------- */

test('add_annotation_node is conceptual-only, ann:-prefixed and collision checked', () => {
  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  const added = applyOk(model, 'add_annotation_node', {
    id: 'ann:manual',
    label: 'manual',
    description: 'a note',
    position: position(),
  });
  model = added.model;
  assert.equal(items(model)[0].kind, 'annotation_node');

  const duplicate = executeEdit(
    model,
    command('add_annotation_node', { id: 'ann:manual', label: 'again', description: null, position: position() }, model.draft_revision),
    { now: NOW },
  );
  assert.equal(duplicate.status, 'invalid');

  const noPrefix = executeEdit(
    model,
    command('add_annotation_node', { id: 'manual', label: 'x', description: null, position: position() }, model.draft_revision),
    { now: NOW },
  );
  assert.equal(noPrefix.status, 'invalid');

  const evidence = createEditorModel(makeEvidenceSpec(), undefined, { now: NOW });
  const evidenceAdd = executeEdit(
    evidence,
    command('add_annotation_node', { id: 'ann:manual', label: 'x', description: null, position: position() }, evidence.draft_revision),
    { now: NOW },
  );
  assert.equal(evidenceAdd.status, 'invalid');
  assert.equal(evidenceAdd.code, 'INVALID_COMMAND');
});

test('set_annotation_node edits pure text only and refuses non-node ids', () => {
  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  model = applyOk(model, 'add_annotation_node', {
    id: 'ann:manual',
    label: 'before',
    description: null,
    position: position(),
  }).model;
  const updated = applyOk(model, 'set_annotation_node', { id: 'ann:manual', label: 'after', description: 'text' });
  assert.equal(items(updated.model)[0].label, 'after');
  assert.equal(items(updated.model)[0].description, 'text');
  assert.equal(items(updated.model)[0].kind, 'annotation_node');
  assert.equal(items(updated.model)[0].position.width, 160, 'position is untouched');

  const base = executeEdit(
    model,
    command('set_annotation_node', { id: 'step:build', label: 'x', description: null }, model.draft_revision),
    { now: NOW },
  );
  assert.equal(base.status, 'invalid');
});

test('add_annotation_edge requires visible node endpoints and ann: ids', () => {
  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  model = applyOk(model, 'add_annotation_node', {
    id: 'ann:manual',
    label: 'manual',
    description: null,
    position: position(),
  }).model;
  const added = applyOk(model, 'add_annotation_edge', {
    id: 'ann:link',
    from: 'step:build',
    to: 'ann:manual',
    label: 'links',
    description: null,
  });
  model = added.model;
  const edge = items(model).find((item) => item.id === 'ann:link');
  assert.equal(edge.kind, 'annotation_edge');
  assert.equal(edge.from, 'step:build');
  assert.equal(edge.to, 'ann:manual');
  assert.equal('certainty' in edge, false);
  assert.equal('origin' in edge, false);

  const hiddenModel = applyOk(model, 'set_visibility', { target_ref: 'step:ship', hidden: true }).model;
  const hiddenEndpoint = executeEdit(
    hiddenModel,
    command('add_annotation_edge', { id: 'ann:link2', from: 'step:build', to: 'step:ship', label: 'x', description: null }, hiddenModel.draft_revision),
    { now: NOW },
  );
  assert.equal(hiddenEndpoint.status, 'invalid');
  assert.equal(hiddenEndpoint.code, 'INVALID_COMMAND');

  const badEndpoint = executeEdit(
    model,
    command('add_annotation_edge', { id: 'ann:link3', from: 'step:build', to: 'step:missing', label: 'x', description: null }, model.draft_revision),
    { now: NOW },
  );
  assert.equal(badEndpoint.status, 'invalid');
});

/* -------------------------------------------------------------------------- */
/* remove_annotation                                                           */
/* -------------------------------------------------------------------------- */

test('remove_annotation only removes notes/annotation edges and restores them through undo', () => {
  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  model = applyOk(model, 'set_note', {
    annotation_id: 'ann:note',
    target_ref: 'step:build',
    text: 'keep as history',
    position: position(),
  }).model;
  const layoutModel = applyOk(model, 'move_node', { node_id: 'step:build', x: 1, y: 2 }).model;
  const visibilityModel = applyOk(layoutModel, 'set_visibility', { target_ref: 'edge:b-s', hidden: true }).model;

  const removeNote = applyOk(visibilityModel, 'remove_annotation', { id: 'ann:note' });
  model = removeNote.model;
  assert.equal(items(model).some((item) => item.id === 'ann:note'), false);

  const undoResult = executeEdit(model, command('undo', {}, model.draft_revision), { now: NOW });
  assert.equal(undoResult.status, 'ok');
  const restored = items(undoResult.model).find((item) => item.id === 'ann:note');
  assert.equal(restored.text, 'keep as history');
  assert.equal(restored.kind, 'note');

  // Layout and visibility items cannot be removed with remove_annotation.
  const layoutId = items(undoResult.model).find((item) => item.kind === 'layout').id;
  const visibilityId = items(undoResult.model).find((item) => item.kind === 'visibility').id;
  for (const target of [layoutId, visibilityId, 'step:build']) {
    const result = executeEdit(undoResult.model, command('remove_annotation', { id: target }, undoResult.model.draft_revision), { now: NOW });
    assert.equal(result.status, 'invalid', `remove_annotation must refuse ${target}`);
  }
});

/* -------------------------------------------------------------------------- */
/* composite remove_annotation_node                                            */
/* -------------------------------------------------------------------------- */

test('remove_annotation_node on an overlay node is one composite history entry', () => {
  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  model = applyOk(model, 'add_annotation_node', {
    id: 'ann:hub',
    label: 'hub',
    description: null,
    position: position(),
  }).model;
  model = applyOk(model, 'add_annotation_node', {
    id: 'ann:spoke',
    label: 'spoke',
    description: null,
    position: position(300, 0),
  }).model;
  model = applyOk(model, 'add_annotation_edge', { id: 'ann:edge-a', from: 'ann:hub', to: 'ann:spoke', label: 'a', description: null }).model;
  model = applyOk(model, 'add_annotation_edge', { id: 'ann:edge-b', from: 'step:build', to: 'ann:hub', label: 'b', description: null }).model;
  model = applyOk(model, 'set_note', {
    annotation_id: 'ann:note:hub',
    target_ref: 'ann:hub',
    text: 'hub note',
    position: position(),
  }).model;
  const before = canonicalJson(items(model));
  assert.equal(items(model).length, 5);

  const removed = applyOk(model, 'remove_annotation_node', { node_id: 'ann:hub' });
  model = removed.model;
  assert.deepEqual(items(model).map((item) => item.id), ['ann:spoke'], 'node and all associated items removed in one command');

  // One undo restores the whole composite patch.
  const undone = executeEdit(model, command('undo', {}, model.draft_revision), { now: NOW });
  assert.equal(undone.status, 'ok');
  const restoredIds = items(undone.model)
    .map((item) => item.id)
    .sort();
  const originalIds = JSON.parse(before)
    .map((item) => item.id)
    .sort();
  assert.deepEqual(restoredIds, originalIds);

  // Redo re-applies the same composite removal.
  const redone = executeEdit(undone.model, command('redo', {}, undone.model.draft_revision), { now: NOW });
  assert.equal(redone.status, 'ok');
  assert.deepEqual(items(redone.model).map((item) => item.id), ['ann:spoke']);
});

test('remove_annotation_node hides a conceptual base node without mutating the base spec', () => {
  const spec = makeSpec();
  const specBefore = canonicalJson(spec);
  let model = createEditorModel(spec, undefined, { now: NOW });
  model = applyOk(model, 'set_note', {
    annotation_id: 'ann:note:hub',
    target_ref: 'step:build',
    text: 'goes away',
    position: position(),
  }).model;
  model = applyOk(model, 'add_annotation_edge', { id: 'ann:link', from: 'step:build', to: 'step:ship', label: 'x', description: null }).model;

  const removed = applyOk(model, 'remove_annotation_node', { node_id: 'step:build' });
  model = removed.model;
  const visibility = items(model).filter((item) => item.kind === 'visibility');
  assert.equal(visibility.length, 1);
  assert.equal(visibility[0].target_ref, 'step:build');
  assert.equal(visibility[0].hidden, true);
  assert.equal(items(model).some((item) => item.id === 'ann:note:hub'), false);
  assert.equal(items(model).some((item) => item.id === 'ann:link'), false);
  assert.equal(canonicalJson(spec), specBefore, 'base spec is never mutated');
  const serialized = JSON.parse(serializeEditorModel(model));
  assert.equal(serialized.overlay.items.some((item) => item.kind === 'visibility'), true);

  // A hidden node cannot be removed twice.
  const twice = executeEdit(model, command('remove_annotation_node', { node_id: 'step:build' }, model.draft_revision), { now: NOW });
  assert.equal(twice.status, 'invalid');
});

test('remove_annotation_node refuses evidence base entities and base edges', () => {
  const evidence = createEditorModel(makeEvidenceSpec(), undefined, { now: NOW });
  for (const nodeId of ['svc:main', 'edge:call']) {
    const result = executeEdit(evidence, command('remove_annotation_node', { node_id: nodeId }, evidence.draft_revision), { now: NOW });
    assert.equal(result.status, 'invalid', `evidence entity ${nodeId} must not be removable`);
    assert.equal(result.code, 'INVALID_COMMAND');
  }
});

/* -------------------------------------------------------------------------- */
/* set_visibility                                                              */
/* -------------------------------------------------------------------------- */

test('set_visibility only targets base entities and keeps one item per target', () => {
  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  model = applyOk(model, 'set_visibility', { target_ref: 'step:build', hidden: true }).model;
  assert.equal(items(model).filter((item) => item.kind === 'visibility').length, 1);
  model = applyOk(model, 'set_visibility', { target_ref: 'edge:b-s', hidden: true }).model;
  assert.equal(items(model).filter((item) => item.kind === 'visibility').length, 2);
  model = applyOk(model, 'set_visibility', { target_ref: 'step:build', hidden: false }).model;
  assert.equal(items(model).filter((item) => item.kind === 'visibility').length, 2);
  assert.equal(items(model).find((item) => item.target_ref === 'step:build').hidden, false);

  const added = applyOk(model, 'add_annotation_node', {
    id: 'ann:manual',
    label: 'manual',
    description: null,
    position: position(),
  }).model;
  const annotationTarget = executeEdit(
    added,
    command('set_visibility', { target_ref: 'ann:manual', hidden: true }, added.draft_revision),
    { now: NOW },
  );
  assert.equal(annotationTarget.status, 'invalid');
  assert.equal(annotationTarget.code, 'INVALID_COMMAND');
});

/* -------------------------------------------------------------------------- */
/* undo / redo                                                                 */
/* -------------------------------------------------------------------------- */

test('undo and redo validate the revision, expose internal patch shapes and never lower draft_revision', () => {
  const empty = executeEdit(createEditorModel(makeSpec(), undefined, { now: NOW }), command('undo', {}, 0), { now: NOW });
  assert.equal(empty.status, 'invalid');
  assert.equal(empty.code, 'INVALID_COMMAND');

  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  const move = applyOk(model, 'move_node', { node_id: 'step:build', x: 10, y: 20 });
  assert.deepEqual(Object.keys(move.inverse).sort(), [
    'after_revision',
    'before_revision',
    'remove_ids',
    'restore_items',
    'restore_selection',
  ]);
  assert.equal(move.inverse.before_revision, 0);
  assert.equal(move.inverse.after_revision, 1);
  model = move.model;

  const undone = executeEdit(model, command('undo', {}, model.draft_revision), { now: NOW });
  assert.equal(undone.status, 'ok');
  assert.equal(undone.model.draft_revision, model.draft_revision + 1, 'undo advances the draft revision monotonically');
  assert.equal(items(undone.model).length, 0);

  const redone = executeEdit(undone.model, command('redo', {}, undone.model.draft_revision), { now: NOW });
  assert.equal(redone.status, 'ok');
  assert.equal(redone.model.draft_revision, undone.model.draft_revision + 1);
  assert.equal(items(redone.model).length, 1);

  // New edits clear the redo stack.
  const undoneAgain = executeEdit(redone.model, command('undo', {}, redone.model.draft_revision), { now: NOW });
  assert.equal(undoneAgain.status, 'ok');
  const newEdit = applyOk(undoneAgain.model, 'add_annotation_node', {
    id: 'ann:new',
    label: 'new',
    description: null,
    position: position(),
  });
  const afterClearedRedo = executeEdit(newEdit.model, command('redo', {}, newEdit.model.draft_revision), { now: NOW });
  assert.equal(afterClearedRedo.status, 'invalid');
  assert.equal(afterClearedRedo.code, 'INVALID_COMMAND');

  // Wrong expected revision is stale, not invalid.
  const stale = executeEdit(
    newEdit.model,
    command('move_node', { node_id: 'step:build', x: 0, y: 0 }, newEdit.model.draft_revision + 5),
    { now: NOW },
  );
  assert.equal(stale.status, 'stale');
  assert.equal(stale.code, 'STALE_VERSION');

  // Standalone undo/redo helpers behave the same way.
  const directUndo = undo(newEdit.model, { now: NOW });
  assert.equal(directUndo.status, 'ok');
  const directRedo = redo(directUndo.model, { now: NOW });
  assert.equal(directRedo.status, 'ok');
});

test('command_id dedupe: idempotent for identical content, conflict otherwise', () => {
  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  const firstCommand = command('move_node', { node_id: 'step:build', x: 5, y: 6 }, 0, 'cmd:dedupe');
  const first = executeEdit(model, firstCommand, { now: NOW });
  assert.equal(first.status, 'ok');
  model = first.model;

  const retry = executeEdit(model, firstCommand, { now: NOW });
  assert.equal(retry.status, 'ok');
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.model, model, 'idempotent replay returns the current model unchanged');
  assert.equal(retry.model.draft_revision, model.draft_revision);

  const different = executeEdit(
    model,
    command('move_node', { node_id: 'step:build', x: 9, y: 9 }, 0, 'cmd:dedupe'),
    { now: NOW },
  );
  assert.equal(different.status, 'invalid');
  assert.equal(different.code, 'CONFLICT');
});

test('command payloads are closed and the command union is fixed', () => {
  const model = createEditorModel(makeSpec(), undefined, { now: NOW });
  const cases = [
    { kind: 'move_node', payload: { node_id: 'step:build', x: 1, y: 1, width: 100 } },
    { kind: 'move_node', payload: { node_id: 'step:build', x: 1 } },
    { kind: 'set_visibility', payload: { target_ref: 'step:build', hidden: 'yes' } },
    { kind: 'undo', payload: { unexpected: true } },
    { kind: 'teleport_node', payload: {} },
  ];
  for (const entry of cases) {
    const result = executeEdit(model, command(entry.kind, entry.payload, model.draft_revision), { now: NOW });
    assert.equal(result.status, 'invalid', JSON.stringify(entry));
    assert.equal(result.code, 'INVALID_COMMAND');
  }
  const missingRevision = executeEdit(
    model,
    { command_id: 'cmd:no-rev', kind: 'undo', payload: {} },
    { now: NOW },
  );
  assert.equal(missingRevision.status, 'invalid');
  assert.equal(missingRevision.code, 'INVALID_COMMAND');
});

test('history is capped at 100 complete commands', () => {
  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  for (let index = 0; index < 105; index += 1) {
    model = applyOk(model, 'move_node', { node_id: 'step:build', x: index, y: index }).model;
  }
  let undoCount = 0;
  for (let index = 0; index < 200; index += 1) {
    const result = executeEdit(model, command('undo', {}, model.draft_revision), { now: NOW });
    if (result.status !== 'ok') break;
    undoCount += 1;
    model = result.model;
  }
  assert.equal(undoCount, 100, 'exactly the capped number of complete commands can be undone');
});

test('history byte cap evicts the oldest complete commands', () => {
  let model = createEditorModel(makeSpec(), undefined, { now: NOW });
  const historyLimits = { limits: { editor_history_entries: 100, editor_history_bytes: 2048 } };
  for (let index = 0; index < 6; index += 1) {
    model = applyOk(
      model,
      'set_note',
      {
        annotation_id: `ann:note-${index}`,
        target_ref: null,
        text: `note ${index} ${'x'.repeat(200)}`,
        position: position(),
      },
      historyLimits,
    ).model;
  }
  let undos = 0;
  for (let index = 0; index < 10; index += 1) {
    const result = executeEdit(model, command('undo', {}, model.draft_revision), {
      now: NOW,
      ...historyLimits,
    });
    if (result.status !== 'ok') break;
    undos += 1;
    model = result.model;
  }
  assert.ok(undos >= 1 && undos < 6, `byte-capped history should retain some but not all entries (got ${undos})`);
});

/* -------------------------------------------------------------------------- */
/* rebase                                                                      */
/* -------------------------------------------------------------------------- */

test('rebaseOverlay re-attaches by stable id and never silently drops items', () => {
  const spec = makeSpec();
  const overlay = {
    schema_version: 1,
    diagram_id: spec.diagram_id,
    base_spec_digest: specDigest(spec),
    revision: 3,
    items: [
      { id: 'ann:keep-node', kind: 'annotation_node', label: 'keep', description: null, position: position() },
      { id: 'ann:keep-edge', kind: 'annotation_edge', from: 'step:build', to: 'ann:keep-node', label: 'keep', description: null },
      { id: 'ann:keep-note', kind: 'note', target_ref: 'step:build', text: 'keep', position: position() },
      { id: 'ann:lost-layout', kind: 'layout', target_ref: 'step:ship', position: position() },
      { id: 'ann:lost-note', kind: 'note', target_ref: 'step:ship', text: 'lost', position: position() },
      { id: 'ann:lost-visibility', kind: 'visibility', target_ref: 'edge:b-s', hidden: true },
    ],
    orphaned_annotations: [
      {
        item: { id: 'ann:old-orphan', kind: 'note', target_ref: null, text: 'old', position: position() },
        reason: 'target_missing',
      },
    ],
    updated_at: NOW,
  };
  assert.equal(validateOverlay(overlay).ok, true);
  const overlayBefore = canonicalJson(overlay);
  const newSpec = makeSpec({
    nodes: [spec.nodes[0]],
    edges: [],
    layout: { algorithm: 'layered_v1', direction: 'LR', positions: [] },
  });
  const newSpecBefore = canonicalJson(newSpec);

  const result = rebaseOverlay(newSpec, overlay, { now: NOW });
  assert.equal(canonicalJson(overlay), overlayBefore, 'rebase must not mutate the input overlay');
  assert.equal(canonicalJson(newSpec), newSpecBefore, 'rebase must not mutate the new base spec');
  assert.equal(result.overlay.base_spec_digest, specDigest(newSpec));
  assert.equal(result.overlay.diagram_id, newSpec.diagram_id);
  assert.deepEqual(
    result.overlay.items.map((item) => item.id).sort(),
    ['ann:keep-edge', 'ann:keep-node', 'ann:keep-note'],
  );
  const reasons = new Map(result.overlay.orphaned_annotations.map((entry) => [entry.item.id, entry.reason]));
  assert.equal(reasons.get('ann:lost-layout'), 'target_missing');
  assert.equal(reasons.get('ann:lost-note'), 'target_missing');
  assert.equal(reasons.get('ann:lost-visibility'), 'target_missing');
  assert.equal(reasons.get('ann:old-orphan'), 'target_missing');
  // Every original item is either kept or preserved as an orphan.
  const accounted = new Set([
    ...result.overlay.items.map((item) => item.id),
    ...result.overlay.orphaned_annotations.map((entry) => entry.item.id),
  ]);
  for (const item of overlay.items) assert.ok(accounted.has(item.id), `item ${item.id} was dropped`);
  assert.equal(validateOverlay(result.overlay).ok, true);
  assert.equal(validateComposite(newSpec, result.overlay).ok, true);
});

test('rebaseOverlay orphans annotation edges whose endpoints became hidden', () => {
  const spec = makeSpec();
  const overlay = {
    ...emptyOverlayFor(spec),
    items: [
      { id: 'ann:hidden', kind: 'visibility', target_ref: 'step:build', hidden: true },
      { id: 'ann:link', kind: 'annotation_edge', from: 'step:build', to: 'step:ship', label: 'x', description: null },
    ],
  };
  assert.equal(validateOverlay(overlay).ok, true);
  const result = rebaseOverlay(spec, overlay, { now: NOW });
  assert.deepEqual(result.overlay.items.map((item) => item.id), ['ann:hidden']);
  assert.equal(result.overlay.orphaned_annotations[0].item.id, 'ann:link');
  assert.equal(result.overlay.orphaned_annotations[0].reason, 'endpoint_missing');
});

test('rebaseOverlay moves annotation nodes out of an evidence-mode diagram', () => {
  const conceptual = makeSpec();
  const overlay = {
    ...emptyOverlayFor(conceptual),
    items: [
      { id: 'ann:manual', kind: 'annotation_node', label: 'manual', description: null, position: position() },
      { id: 'ann:link', kind: 'annotation_edge', from: 'ann:manual', to: 'step:build', label: 'x', description: null },
    ],
  };
  const evidence = makeEvidenceSpec();
  const result = rebaseOverlay(evidence, overlay, { now: NOW });
  const reasons = new Map(result.overlay.orphaned_annotations.map((entry) => [entry.item.id, entry.reason]));
  assert.equal(reasons.get('ann:manual'), 'target_missing');
  assert.equal(reasons.get('ann:link'), 'endpoint_missing');
  assert.deepEqual(result.overlay.items, []);
  assert.equal(validateComposite(evidence, result.overlay).ok, true);
});

/* -------------------------------------------------------------------------- */
/* edited overlay -> .drawio round-trip                                        */
/* -------------------------------------------------------------------------- */

test('edited overlay round-trips through exportDrawio and parseDrawioXml', () => {
  const spec = makeSpec();
  const specBefore = canonicalJson(spec);
  let model = createEditorModel(spec, undefined, { now: NOW });
  model = applyOk(model, 'move_node', { node_id: 'step:build', x: 12, y: 24 }).model;
  model = applyOk(model, 'set_note', {
    annotation_id: 'ann:note',
    target_ref: 'step:build',
    text: 'roundtrip note',
    position: position(),
  }).model;
  model = applyOk(model, 'add_annotation_node', {
    id: 'ann:custom',
    label: 'custom',
    description: null,
    position: position(300, 200),
  }).model;
  model = applyOk(model, 'add_annotation_edge', {
    id: 'ann:custom-link',
    from: 'step:build',
    to: 'ann:custom',
    label: 'links',
    description: null,
  }).model;

  const { xml } = exportDrawio({ spec, annotation_overlay: model.overlay }, { now: NOW });
  const parsed = parseDrawioXml(xml);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  const root = parsed.document.cells.find((cell) => cell.id === '0');
  assert.equal(root.data.base_digest, model.base_spec_digest);
  assert.equal(root.data.diagram_id, spec.diagram_id);
  const annotationCells = parsed.document.cells.filter((cell) => cell.id.startsWith('overlay:'));
  assert.equal(annotationCells.length, 3, 'note + annotation node + annotation edge');
  for (const cell of annotationCells) {
    assert.equal(cell.data.origin, 'annotation');
    assert.equal(cell.data.certainty, 'unknown');
  }
  const baseNode = parsed.document.cells.find((cell) => cell.id === 'base:step:build');
  assert.equal(baseNode.visible, null, 'visible base cells are not marked hidden');
  assert.equal(baseNode.geometry.x, 12);
  assert.equal(baseNode.geometry.y, 24);
  assert.equal(canonicalJson(spec), specBefore, 'the base spec digest is unchanged by the round-trip');
});
