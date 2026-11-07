/**
 * Cross-module integration journey (DIA-AT integration gate).
 *
 * This test exercises the real modules together on synthetic fixtures:
 *   evidence -> spec -> layout -> SVG/HTML -> atomic artifact package
 *   -> restricted .drawio round-trip -> document store revision/conflict/export
 *   -> 03 event consumption.
 *
 * It is component-level only: no browser, no installed Host, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { toDiagram } from '../src/evidence.mjs';
import { validateSource } from '../src/source-state.mjs';
import { layoutDiagram } from '../src/layout.mjs';
import { renderSvg } from '../src/render-svg.mjs';
import { renderHtml } from '../src/render-html.mjs';
import { renderLocal } from '../src/archive.mjs';
import { emptyOverlay, specDigest, validateComposite } from '../src/contracts.mjs';
import { exportDrawio, parseDrawioXml, canonicalMxGraph } from '../src/drawio/xml.mjs';
import { importExternalDrawio } from '../src/drawio/import.mjs';
import { createEditorModel, executeEdit } from '../src/editor/model.mjs';
import { createAccessRegistry } from '../src/editor/access.mjs';
import { createDocumentStore } from '../src/editor/document-store.mjs';
import { applyFactEvent, createInteropState } from '../src/events.mjs';

const FIXED_NOW = '2026-11-07T02:00:00.000Z';
const clock = () => FIXED_NOW;
const ROOT = path.resolve(import.meta.dirname, '..');

function readFixture(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-06-integration-'));
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      // Windows may keep transient handles; cleanup failure is not a behavior result.
    }
  });
  return root;
}

function evidenceSpec() {
  const result = toDiagram(
    {
      source_identity: readFixture('tests/fixtures/snapshot/source-identity.json'),
      evidence_subset: readFixture('tests/fixtures/snapshot/evidence-subset.json'),
      current_identities: readFixture('tests/fixtures/snapshot/current-identities.json'),
    },
    { now: clock },
  );
  assert.equal(result.status, 'ok', JSON.stringify(result));
  return result.spec;
}

test('journey: evidence spec keeps certainty, layout is deterministic, artifact package is offline', async (t) => {
  const root = tempRoot(t);
  const spec = evidenceSpec();

  // 1. Evidence layer preserved: exact/may/unresolved/annotation all survive.
  const certainty = Object.fromEntries(spec.edges.map((edge) => [edge.id, edge.certainty]));
  assert.deepEqual(certainty, {
    'edge:exact-call': 'exact',
    'edge:may-call': 'may',
    'edge:unresolved': 'unresolved',
    'edge:annotation-review': 'unknown',
  });
  const reference = spec.edges.find((edge) => edge.id === 'edge:unresolved');
  assert.equal(reference.kind, 'reference', 'reference must never be upgraded to call');
  assert.equal(reference.origin, 'evidence');
  const manual = spec.edges.find((edge) => edge.id === 'edge:annotation-review');
  assert.equal(manual.origin, 'annotation');
  const layout = layoutDiagram(spec);
  assert.deepEqual(layout, layoutDiagram(spec), 'same spec => identical layout');
  assert.equal(spec.source_state, 'current');

  const state = validateSource(spec, readFixture('tests/fixtures/snapshot/stale-identities.json'));
  assert.equal(state.state, 'stale');
  assert.ok(state.changed_refs.length > 0);

  // 2. Renderers: escaped SVG, offline HTML with CSP and text-equivalent table.
  const svg = renderSvg(spec, { layout });
  const html = renderHtml({
    spec,
    layout,
    svg: svg.svg,
    text_equivalent: svg.text_equivalent,
    legend: svg.legend,
    hidden: svg.hidden,
    renderer_ref: spec.renderer_ref,
    source_state: spec.source_state,
  });
  assert.match(svg.svg, /^<svg/);
  assert.match(html.html, /Content-Security-Policy/);
  assert.match(html.html, /svc_main/);
  assert.doesNotMatch(svg.svg, /<script|<foreignObject|javascript:|https?:\/\//i);

  // 3. Atomic artifact: seven files, manifest digest, deterministic repeat.
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { recursive: true });
  const request = {
    spec,
    output_ref: 'evidence-run',
    renderer: 'builtin',
    expected_output_revision: null,
    operation_id: 'op-integration-1',
  };
  const caller = { granted: true, granted_output_root: out };
  const first = await renderLocal(request, caller);
  assert.equal(first.status, 'saved', JSON.stringify(first));
  const artifactDir = first.artifact_ref;
  assert.equal(fs.existsSync(artifactDir), true, `artifact_ref must resolve: ${artifactDir}`);
  const names = fs.readdirSync(artifactDir).sort();
  assert.deepEqual(names, [
    'annotations.json',
    'diagram-spec.json',
    'diagram.drawio',
    'diagram.svg',
    'evidence.json',
    'index.html',
    'manifest.json',
  ]);
  const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.network_mode, 'offline');
  assert.equal(manifest.spec_digest, specDigest(spec));
  for (const file of manifest.files) {
    assert.equal(fs.statSync(path.join(artifactDir, file.relative_path)).size, file.size);
  }
  const repeat = await renderLocal({ ...request, operation_id: 'op-integration-2' }, caller);
  assert.equal(repeat.status, 'saved');
  assert.equal(repeat.manifest_digest, first.manifest_digest, 'semantic idempotency for the same input');

  // No artifact file may carry an external reference.
  for (const name of names) {
    const text = fs.readFileSync(path.join(artifactDir, name), 'utf8');
    assert.doesNotMatch(text, /https?:\/\//i, `${name} must stay offline`);
  }

  // 4. Restricted .drawio round-trip and external import downgrade.
  const overlay = emptyOverlay({ diagram_id: spec.diagram_id, base_spec_digest: specDigest(spec), now: FIXED_NOW });
  const exported = exportDrawio({ spec, annotation_overlay: overlay });
  const parsed = parseDrawioXml(exported.xml);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(canonicalMxGraph(exported.xml), canonicalMxGraph(parsed.document));
  const imported = importExternalDrawio(exported.xml, { scope_ref: spec.scope_ref, title: 'imported' });
  assert.equal(imported.status, 'ok', JSON.stringify(imported));
  assert.equal(imported.base_spec.mode, 'conceptual');
  assert.equal(imported.base_spec.sources.length, 0);
  for (const item of imported.overlay.items) {
    assert.equal(item.kind === 'annotation_node' || item.kind === 'annotation_edge', true);
  }

  // 5. Store revision journey: open generation 0, edit locally, save, reopen.
  const dataRoot = path.join(root, 'data');
  const registry = createAccessRegistry();
  assert.equal(registry.registerContext({ context_ref: 'ctx-1', scope_ref: spec.scope_ref, scope_generation: 0 }).ok, true);
  assert.equal(registry.registerOutputRoot({ output_ref: 'out-1', scope_ref: spec.scope_ref, scope_generation: 0, path: out }).ok, true);
  assert.equal(registry.registerDocument({
    document_ref: 'doc-1',
    document_id: 'doc-001',
    scope_ref: spec.scope_ref,
    scope_generation: 0,
    path: artifactDir,
    mode: 'edit',
  }).ok, true);
  const store = createDocumentStore({ data_root: dataRoot, registry, clock });
  const caller2 = { principal: { kind: 'owner', principal_id: 'owner-1' } };
  const opened = await store.openDocument({ document_ref: 'doc-1', expected_scope: { scope_ref: spec.scope_ref, scope_generation: 0 } }, caller2);
  assert.equal(opened.status, 'opened', JSON.stringify(opened));
  assert.equal(opened.base_spec.diagram_id, spec.diagram_id);
  assert.equal(opened.overlay.base_spec_digest, specDigest(opened.base_spec));

  let model = createEditorModel(opened.base_spec, opened.overlay);
  const note = executeEdit(model, {
    command_id: 'cmd-note-1',
    expected_draft_revision: model.draft_revision,
    kind: 'set_note',
    payload: { annotation_id: 'ann:note-1', target_ref: 'svc:main', text: 'Review note: exact only means static evidence', position: { x: 40, y: 40, width: 200, height: 80 } },
  });
  assert.equal(note.status, 'ok', JSON.stringify(note));
  model = note.model;
  const move = executeEdit(model, {
    command_id: 'cmd-move-1',
    expected_draft_revision: model.draft_revision,
    kind: 'move_node',
    payload: { node_id: 'svc:helper', x: 480, y: 240 },
  });
  assert.equal(move.status, 'ok', JSON.stringify(move));
  model = move.model;

  const saveOverlay = model.overlay;
  const canonical = exportDrawio({ spec: opened.base_spec, annotation_overlay: saveOverlay }).xml;
  const saved = await store.saveDiagram(
    {
      document_id: opened.document_id,
      editor_session_ref: opened.editor_session_ref,
      expected_version: opened.version,
      xml: canonical,
      overlay: saveOverlay,
      operation_id: 'op-save-1',
    },
    caller2,
  );
  assert.equal(saved.status, 'saved', JSON.stringify(saved));
  assert.equal(saved.version.generation, opened.version.generation + 1);

  // A stale second view must conflict, not silently overwrite.
  const staleSave = await store.saveDiagram(
    {
      document_id: opened.document_id,
      editor_session_ref: opened.editor_session_ref,
      expected_version: opened.version,
      xml: canonical,
      overlay: saveOverlay,
      operation_id: 'op-stale-2',
    },
    caller2,
  );
  assert.equal(['conflict', 'denied'].includes(staleSave.status), true, JSON.stringify(staleSave));

  // Reopen from the immutable revision: same base digest, overlay item retained.
  const reopened = await store.openDocument({ document_ref: 'doc-1', expected_scope: { scope_ref: spec.scope_ref, scope_generation: 0 } }, caller2);
  assert.equal(reopened.status, 'opened', JSON.stringify(reopened));
  assert.equal(specDigest(reopened.base_spec), specDigest(opened.base_spec));
  assert.ok(reopened.overlay.items.some((item) => item.id === 'ann:note-1'));
  assert.equal(validateComposite(reopened.base_spec, reopened.overlay).ok, true);

  // 6. 03 event: a restore touching the declared repo downgrades source_state.
  const event = {
    schema_version: 1,
    event_id: 'evt-integration-1',
    kind: 'workspace_files_restored',
    source_capability: '03',
    scope_ref: spec.scope_ref,
    operation_id: 'op-event-1',
    generation: 1,
    affected_refs: ['repo-svc'],
    outcome: 'completed',
    after_snapshot: 'snap-2',
    occurred_at: FIXED_NOW,
  };
  const applied = applyFactEvent(spec, event, createInteropState());
  assert.equal(applied.ok, true);
  assert.equal(applied.spec.source_state, 'stale');
});
