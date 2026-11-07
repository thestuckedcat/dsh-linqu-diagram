import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { canonicalJson } from '../src/canonical.mjs';
import { validateComposite, validateOverlay, specDigest } from '../src/contracts.mjs';
import { exportDrawio } from '../src/drawio/xml.mjs';
import { importExternalDrawio } from '../src/drawio/import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const MALICIOUS = JSON.parse(readFileSync(path.join(FIXTURES, 'malicious', 'payloads.json'), 'utf8'));
const NOW = '2026-11-07T00:00:00.000Z';

function makeSpec(overrides = {}) {
  return {
    schema_version: 1,
    diagram_id: 'diagram:demo',
    revision: 0,
    mode: 'conceptual',
    title: 'Demo',
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

function makeOverlay(spec, items = []) {
  return {
    schema_version: 1,
    diagram_id: spec.diagram_id,
    base_spec_digest: specDigest(spec),
    revision: 0,
    items,
    orphaned_annotations: [],
    updated_at: NOW,
  };
}

function richOverlay(spec) {
  return makeOverlay(spec, [
    {
      id: 'ann:custom',
      kind: 'annotation_node',
      label: 'manual step',
      description: null,
      position: { x: 40, y: 120, width: 160, height: 64 },
    },
    { id: 'ann:custom-link', kind: 'annotation_edge', from: 'step:build', to: 'ann:custom', label: 'leads to', description: null },
    { id: 'ann:note:build', kind: 'note', target_ref: 'step:build', text: 'check this step', position: { x: 0, y: 80, width: 120, height: 40 } },
    { id: 'ann:vis:ship', kind: 'visibility', target_ref: 'step:ship', hidden: true },
  ]);
}

function wrapModel(modelXml) {
  return `<mxfile host="local-diagrams" version="v1">\n<diagram id="diagram:demo" name="Demo">\n${modelXml}\n</diagram>\n</mxfile>`;
}

function externalDocument({ cells = [], graphAttrs = 'grid="1"' } = {}) {
  return wrapModel(
    `<mxGraphModel ${graphAttrs}><root><mxCell id="0" /><mxCell id="1" parent="0" />${cells.join('')}</root></mxGraphModel>`,
  );
}

function vertexCell({ id = 'n1', value = 'A', style = 'rounded=1;fillColor=#dae8fc;', extra = '', parent = '1' } = {}) {
  return `<mxCell id="${id}" value="${value}" style="${style}" vertex="1" parent="${parent}"${extra}><mxGeometry x="10" y="20" width="160" height="64" as="geometry" /></mxCell>`;
}

function edgeCell({ id = 'e1', source = 'n1', target = 'n2', extra = '' } = {}) {
  return `<mxCell id="${id}" value="to" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="${source}" target="${target}"${extra}><mxGeometry relative="1" as="geometry" /></mxCell>`;
}

/* -------------------------------------------------------------------------- */
/* external files                                                              */
/* -------------------------------------------------------------------------- */

test('importExternalDrawio downgrades an external drawio to a conceptual annotation overlay', () => {
  const xml = readFileSync(path.join(FIXTURES, 'drawio', 'external-basic.drawio'), 'utf8');
  const result = importExternalDrawio(xml, { title: 'Imported basic', scope_ref: 'scope:imported', now: NOW });
  assert.equal(result.status, 'ok', JSON.stringify(result.errors));
  assert.equal(result.base_spec.mode, 'conceptual');
  assert.deepEqual(result.base_spec.nodes, []);
  assert.deepEqual(result.base_spec.edges, []);
  assert.deepEqual(result.base_spec.sources, []);
  assert.equal(result.base_spec.source_state, 'unknown');
  assert.equal(result.base_spec.coverage.complete, false);
  assert.equal(result.base_spec.title, 'Imported basic');
  assert.equal(result.base_spec.scope_ref, 'scope:imported');
  assert.equal(result.base_spec.generated_at, NOW);
  assert.match(result.base_spec.diagram_id, /^diagram:import-[0-9a-f]{16}$/);

  const items = result.overlay.items;
  assert.equal(items.filter((item) => item.kind === 'annotation_node').length, 2);
  assert.equal(items.filter((item) => item.kind === 'note').length, 1);
  assert.equal(items.filter((item) => item.kind === 'annotation_edge').length, 1);
  for (const item of items) {
    assert.ok(item.id.startsWith('ann:'), `import item id must use the ann: prefix: ${item.id}`);
    assert.equal('origin' in item, false);
    assert.equal('certainty' in item, false);
    assert.equal('evidence_refs' in item, false);
  }
  const node = items.find((item) => item.kind === 'annotation_node' && item.label === 'build');
  assert.deepEqual(node.position, { x: 10, y: 20, width: 160, height: 64 });
  const note = items.find((item) => item.kind === 'note');
  assert.equal(note.target_ref, null);
  assert.equal(note.text, 'hand written note');
  const edge = items.find((item) => item.kind === 'annotation_edge');
  const nodeIds = new Set(items.filter((item) => item.kind === 'annotation_node').map((item) => item.id));
  assert.ok(nodeIds.has(edge.from));
  assert.ok(nodeIds.has(edge.to));

  // The constructed base+overlay must satisfy the shared contracts.
  assert.equal(validateOverlay(result.overlay).ok, true);
  assert.equal(validateComposite(result.base_spec, result.overlay).ok, true);

  const noteMetadata = result.display_metadata.find((entry) => entry.data_cell_kind === 'note');
  assert.ok(noteMetadata);
  assert.equal(noteMetadata.untrusted, true);
  assert.ok(result.warnings.includes('data_metadata_display_only'));
});

test('importExternalDrawio imports our own past export as conceptual, never as evidence', () => {
  const spec = makeSpec();
  const overlay = richOverlay(spec);
  const { xml } = exportDrawio({ spec, annotation_overlay: overlay }, { now: NOW });
  const result = importExternalDrawio(xml, { now: NOW });
  assert.equal(result.status, 'ok', JSON.stringify(result.errors));
  assert.equal(result.base_spec.mode, 'conceptual');
  assert.deepEqual(result.base_spec.nodes, []);
  assert.deepEqual(result.base_spec.edges, []);
  assert.equal(result.overlay.items.length, new Set(result.overlay.items.map((item) => item.id)).size);
  const kinds = result.overlay.items.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ['annotation_edge', 'annotation_edge', 'annotation_node', 'annotation_node', 'annotation_node', 'note']);
  assert.ok(result.warnings.includes('data_metadata_display_only'));
  assert.ok(result.warnings.includes('hidden_cell_imported_as_visible'));
  assert.equal(validateComposite(result.base_spec, result.overlay).ok, true);
});

test('importExternalDrawio keeps forged data_* metadata display-only', () => {
  const spec = makeSpec();
  const overlay = makeOverlay(spec, []);
  const { xml } = exportDrawio({ spec, annotation_overlay: overlay }, { now: NOW });
  const tampered = xml
    .replace('data_cell_kind="base_node"', 'data_cell_kind="base_node" data_origin="evidence" data_certainty="exact"')
    .replace('data_cell_kind="base_edge"', 'data_cell_kind="base_edge" data_origin="evidence" data_certainty="exact"');
  assert.notEqual(tampered, xml);
  const result = importExternalDrawio(tampered, { now: NOW });
  assert.equal(result.status, 'ok', JSON.stringify(result.errors));
  // Fake exact metadata never becomes a base fact.
  assert.deepEqual(result.base_spec.nodes, []);
  assert.deepEqual(result.base_spec.edges, []);
  assert.equal(result.overlay.orphaned_annotations.length, 0);
  for (const item of result.overlay.items) {
    assert.equal('certainty' in item, false);
    assert.equal('origin' in item, false);
  }
  const forged = result.display_metadata.filter((entry) => entry.data_origin === 'evidence' && entry.data_certainty === 'exact');
  assert.ok(forged.length >= 2, 'forged metadata is preserved for display only');
  for (const entry of forged) assert.equal(entry.untrusted, true);
});

test('importExternalDrawio reports compressed diagrams as unsupported with a clear reason', () => {
  const xml = readFileSync(path.join(FIXTURES, 'drawio', 'compressed.drawio'), 'utf8');
  const result = importExternalDrawio(xml, { now: NOW });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, 'UNSUPPORTED');
  assert.match(result.errors[0].message, /uncompressed/i);
});

test('importExternalDrawio rejects remote/script styles and unknown advanced shapes', () => {
  const rejectedStyles = [MALICIOUS.remote_style, ...MALICIOUS.remote_style_cases];
  for (const style of rejectedStyles) {
    const result = importExternalDrawio(externalDocument({ cells: [vertexCell({ style })] }), { now: NOW });
    assert.notEqual(result.status, 'ok', `style must be rejected: ${style}`);
    assert.ok(['INVALID_XML', 'UNSUPPORTED'].includes(result.code), `unexpected code ${result.code} for ${style}`);
  }
  const unknownShape = importExternalDrawio(
    externalDocument({ cells: [vertexCell({ style: 'shape=umlActor;' })] }),
    { now: NOW },
  );
  assert.equal(unknownShape.status, 'unsupported');
  assert.equal(unknownShape.code, 'UNSUPPORTED');

  const unknownStyleKey = importExternalDrawio(
    externalDocument({ cells: [vertexCell({ style: 'sketch=1;' })] }),
    { now: NOW },
  );
  assert.equal(unknownStyleKey.status, 'unsupported');

  const control = importExternalDrawio(
    externalDocument({ cells: [vertexCell({ style: MALICIOUS.control_style })] }),
    { now: NOW },
  );
  assert.equal(control.status, 'ok', JSON.stringify(control.errors));
});

test('importExternalDrawio rejects malicious XML and invalid UTF-8', () => {
  const doctype = importExternalDrawio(MALICIOUS.xml_bomb, { now: NOW });
  assert.equal(doctype.status, 'invalid');
  assert.equal(doctype.code, 'INVALID_XML');

  const cdata = importExternalDrawio('<mxfile><diagram id="x"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>', {
    now: NOW,
  });
  assert.equal(cdata.status, 'invalid');

  const invalidUtf8 = new Uint8Array([
    0x3c, 0x6d, 0x78, 0x66, 0x69, 0x6c, 0x65, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x6d, 0x78, 0x66, 0x69, 0x6c, 0x65, 0x3e,
  ]);
  const bytes = importExternalDrawio(invalidUtf8, { now: NOW });
  assert.equal(bytes.status, 'invalid');
  assert.equal(bytes.code, 'INVALID_XML');
});

test('importExternalDrawio handles empty documents, hidden cells and option overrides deterministically', () => {
  const empty = importExternalDrawio(externalDocument({ cells: [] }), { now: NOW });
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.overlay.items, []);
  assert.ok(empty.warnings.includes('no_representable_cells'));

  const hidden = importExternalDrawio(
    externalDocument({ cells: [vertexCell({ id: 'n1', extra: ' visible="0"', value: 'secret' })] }),
    { now: NOW },
  );
  assert.equal(hidden.status, 'ok');
  assert.ok(hidden.warnings.includes('hidden_cell_imported_as_visible'));
  assert.equal(hidden.overlay.items.length, 1);

  const options = {
    now: NOW,
    title: 'Explicit import',
    scope_ref: 'scope:explicit',
    diagram_id: 'diagram:explicit',
  };
  const first = importExternalDrawio(externalDocument({ cells: [vertexCell()] }), options);
  const second = importExternalDrawio(externalDocument({ cells: [vertexCell()] }), options);
  assert.equal(first.base_spec.title, 'Explicit import');
  assert.equal(first.base_spec.scope_ref, 'scope:explicit');
  assert.equal(first.base_spec.diagram_id, 'diagram:explicit');
  assert.equal(canonicalJson(first.base_spec), canonicalJson(second.base_spec));
  assert.equal(canonicalJson(first.overlay), canonicalJson(second.overlay));

  const limited = importExternalDrawio(externalDocument({ cells: [vertexCell()] }), {
    now: NOW,
    limits: { xml_bytes: 32 },
  });
  assert.equal(limited.status, 'invalid');
  assert.equal(limited.code, 'LIMIT_EXCEEDED');
});

test('importExternalDrawio drops edges whose endpoints are notes or missing', () => {
  const cells = [
    vertexCell({ id: 'n1', value: 'A' }),
    `<mxCell id="note1" value="note" style="shape=note;" vertex="1" parent="1" data_cell_kind="note"><mxGeometry x="1" y="1" width="10" height="10" as="geometry" /></mxCell>`,
    edgeCell({ id: 'e1', source: 'n1', target: 'note1' }),
    edgeCell({ id: 'e2', source: 'n1', target: 'missing' }),
  ];
  // The restricted parser rejects edges whose endpoint cell does not exist.
  const dangling = importExternalDrawio(externalDocument({ cells }), { now: NOW });
  assert.equal(dangling.status, 'invalid');
  assert.equal(dangling.code, 'INVALID_XML');

  // Notes are valid vertices but cannot be annotation_edge endpoints; the edge
  // is dropped with an explicit warning, never silently reconnected.
  const noteEndpoint = importExternalDrawio(
    externalDocument({ cells: [cells[0], cells[1], cells[2]] }),
    { now: NOW },
  );
  assert.equal(noteEndpoint.status, 'ok', JSON.stringify(noteEndpoint.errors));
  assert.equal(noteEndpoint.overlay.items.filter((item) => item.kind === 'annotation_edge').length, 0);
  assert.ok(noteEndpoint.warnings.some((warning) => warning.startsWith('annotation_edge_dropped:') && warning.includes('e1')));
  const noteItem = noteEndpoint.overlay.items.find((item) => item.kind === 'note');
  assert.equal(noteItem.text, 'note');
});
