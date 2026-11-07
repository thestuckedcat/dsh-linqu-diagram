import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { LIMITS } from '../src/limits.mjs';
import { DiagramError } from '../src/errors.mjs';
import { canonicalJson } from '../src/canonical.mjs';
import { specDigest } from '../src/contracts.mjs';
import {
  canonicalMxGraph,
  exportDrawio,
  parseDrawioXml,
  parseXmlRestricted,
  serializeMxGraphModel,
} from '../src/drawio/xml.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const MALICIOUS = JSON.parse(readFileSync(path.join(FIXTURES, 'malicious', 'payloads.json'), 'utf8'));
const NOW = '2026-11-07T00:00:00.000Z';

/* -------------------------------------------------------------------------- */
/* fixtures built in-test                                                      */
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

function makeOverlay(spec, items) {
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
    { id: 'ann:layout:ship', kind: 'layout', target_ref: 'step:ship', position: { x: 300, y: 40, width: 160, height: 64 } },
    { id: 'ann:vis:ship', kind: 'visibility', target_ref: 'step:ship', hidden: true },
    { id: 'ann:vis:edge', kind: 'visibility', target_ref: 'edge:b-s', hidden: true },
  ]);
}

function wrapModel(modelXml, diagramId = 'diagram:demo', name = 'Demo') {
  return `<mxfile host="local-diagrams" version="v1">\n<diagram id="${diagramId}" name="${name}">\n${modelXml}\n</diagram>\n</mxfile>`;
}

function minimalDocument({ id = '0', layer = '1', cells = [], attrs = '' } = {}) {
  return wrapModel(
    `<mxGraphModel grid="1">\n<root>\n<mxCell id="${id}" />\n<mxCell id="${layer}" parent="0" />\n${cells.join('\n')}\n</root>\n</mxGraphModel>`,
  );
}

function vertexCell({ id = 'n1', value = 'A', style = 'rounded=1;fillColor=#dae8fc;', parent = '1', extra = '' } = {}) {
  return `<mxCell id="${id}" value="${value}" style="${style}" vertex="1" parent="${parent}"${extra}><mxGeometry x="1" y="2" width="160" height="64" as="geometry" /></mxCell>`;
}

function edgeCell({ id = 'e1', source = 'n1', target = 'n2' } = {}) {
  return `<mxCell id="${id}" value="to" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry" /></mxCell>`;
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DiagramError, `expected DiagramError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* restricted tokenizer                                                        */
/* -------------------------------------------------------------------------- */

test('parseXmlRestricted accepts the restricted subset', () => {
  const parsed = parseXmlRestricted('<?pi?><unused/>');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'INVALID_XML');

  const doc = parseXmlRestricted('\uFEFF<r a="v1" b=\'v2\'>hi<x flag="1"/>there<y>&lt;&amp;&gt;&#65;&#x1F600;</y></r>');
  assert.equal(doc.ok, true);
  assert.equal(doc.root.name, 'r');
  assert.deepEqual(doc.root.attributes, { a: 'v1', b: 'v2' });
  assert.equal(doc.root.text, 'hithere');
  assert.equal(doc.root.children.length, 4);
  assert.deepEqual(doc.root.children[0], { text: 'hi' });
  assert.equal(doc.root.children[1].name, 'x');
  assert.deepEqual(doc.root.children[1].attributes, { flag: '1' });
  assert.deepEqual(doc.root.children[2], { text: 'there' });
  assert.equal(doc.root.children[3].name, 'y');
  assert.equal(doc.root.children[3].text, '<&>A😀');

  const bufferDoc = parseXmlRestricted(Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x61, 0x2f, 0x3e]));
  assert.equal(bufferDoc.ok, true);
  assert.equal(bufferDoc.root.name, 'a');
});

test('parseXmlRestricted rejects DOCTYPE, entities, CDATA, PI, comments and namespaces', () => {
  const cases = [
    ['<!DOCTYPE foo [<!ENTITY x "y">]><foo>&x;</foo>', 'doctype'],
    [MALICIOUS.xml_bomb, 'doctype'],
    ['<a><![CDATA[x]]></a>', 'cdata'],
    ['<?xml version="1.0"?><a/>', 'processingInstruction'],
    ['<a><!-- comment --></a>', 'comment'],
    ['<a xmlns="urn:x"/>', 'namespace'],
    ['<ns:a/>', 'malformedAttribute'],
  ];
  for (const [xml, keyword] of cases) {
    const result = parseXmlRestricted(xml);
    assert.equal(result.ok, false, `expected rejection for ${xml.slice(0, 40)}`);
    assert.equal(result.code, 'INVALID_XML');
    assert.equal(result.errors[0].keyword, keyword);
  }
  // Unknown/illegal entities are rejected without expansion.
  for (const xml of ['<a>&nbsp;</a>', '<a>&#0;</a>', '<a>&#xD800;</a>', '<a>&#x110000;</a>', '<a>&#65</a>', '<a>&;</a>']) {
    const result = parseXmlRestricted(xml);
    assert.equal(result.ok, false, `expected entity rejection for ${xml}`);
  }
});

test('parseXmlRestricted rejects malformed structure and duplicate attributes', () => {
  for (const xml of [
    '<a x="1" x="2"/>',
    '<a x=1/>',
    '<a x="1"',
    '<a',
    '<a><b></a></b>',
    '<a></b>',
    '</a>',
    '<a/><b/>',
    '<a/>trailing',
    '<a>]]></a>',
  ]) {
    const result = parseXmlRestricted(xml);
    assert.equal(result.ok, false, `expected malformed rejection for ${xml}`);
    assert.equal(result.code, 'INVALID_XML');
  }
});

test('parseXmlRestricted enforces UTF-8 and legal XML code points', () => {
  const invalidUtf8 = new Uint8Array([0x3c, 0x61, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x61, 0x3e]);
  const utf8Result = parseXmlRestricted(invalidUtf8);
  assert.equal(utf8Result.ok, false);
  assert.equal(utf8Result.errors[0].keyword, 'invalidUtf8');

  const loneSurrogate = parseXmlRestricted('<a>\uD800</a>');
  assert.equal(loneSurrogate.ok, false);
  assert.equal(loneSurrogate.errors[0].keyword, 'invalidUtf8');

  const control = parseXmlRestricted('<a>\u0001</a>');
  assert.equal(control.ok, false);
  assert.equal(control.errors[0].keyword, 'invalidChar');

  const nonBytes = parseXmlRestricted(42);
  assert.equal(nonBytes.ok, false);
});

test('parseXmlRestricted enforces byte/depth/element/attribute limits before building', () => {
  const bytes = parseXmlRestricted('<a>' + 'x'.repeat(200) + '</a>', { limits: { xml_bytes: 32 } });
  assert.equal(bytes.code, 'LIMIT_EXCEEDED');
  assert.equal(bytes.errors[0].keyword, 'maxBytes');

  const depth = parseXmlRestricted('<a><b><c><d/></c></b></a>', { limits: { xml_depth: 3 } });
  assert.equal(depth.code, 'LIMIT_EXCEEDED');
  assert.equal(depth.errors[0].keyword, 'maxDepth');

  const elements = parseXmlRestricted('<a><b/><c/><d/></a>', { limits: { xml_elements: 3 } });
  assert.equal(elements.code, 'LIMIT_EXCEEDED');
  assert.equal(elements.errors[0].keyword, 'maxElements');

  const attributes = parseXmlRestricted('<a x="1" y="2" z="3"/>', { limits: { xml_attributes_per_element: 2 } });
  assert.equal(attributes.code, 'LIMIT_EXCEEDED');
  assert.equal(attributes.errors[0].keyword, 'maxAttributes');

  // Default depth limit from LIMITS is also enforced.
  const deep = '<r>' + '<n>'.repeat(LIMITS.xml_depth + 2) + '</n>'.repeat(LIMITS.xml_depth + 2) + '</r>';
  assert.equal(parseXmlRestricted(deep).code, 'LIMIT_EXCEEDED');
});

/* -------------------------------------------------------------------------- */
/* mxGraphModel serialization / parsing                                        */
/* -------------------------------------------------------------------------- */

test('serializeMxGraphModel round-trips through parseDrawioXml', () => {
  const model = {
    root_cells: [
      { id: '0', data_diagram_id: 'diagram:demo', data_base_digest: 'a'.repeat(64) },
      {
        id: 'base:step:build',
        parent: 'layer-base',
        value: 'build',
        style: 'rounded=1;whiteSpace=wrap;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=12;',
        vertex: true,
        data_cell_kind: 'base_node',
        geometry: { x: 0, y: 0, width: 160, height: 64, as: 'geometry' },
      },
      {
        id: 'overlay:ann:custom',
        parent: 'layer-annotations',
        value: 'custom',
        style: 'rounded=1;whiteSpace=wrap;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=12;',
        vertex: true,
        data_origin: 'annotation',
        data_certainty: 'unknown',
        data_cell_kind: 'annotation_node',
        geometry: { x: 10, y: 100, width: 160, height: 64, as: 'geometry' },
      },
      {
        id: 'overlay:ann:note',
        parent: 'layer-notes',
        value: 'a note',
        style: 'shape=note;whiteSpace=wrap;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=12;',
        vertex: true,
        visible: false,
        data_origin: 'annotation',
        data_certainty: 'unknown',
        data_cell_kind: 'note',
        geometry: { x: 0, y: 200, width: 120, height: 60, as: 'geometry' },
      },
    ],
    layers: [
      { id: 'layer-base', value: 'Base' },
      { id: 'layer-annotations', value: 'Annotations' },
      { id: 'layer-notes', value: 'Notes' },
    ],
  };
  const modelXml = serializeMxGraphModel(model);
  assert.ok(modelXml.startsWith('<mxGraphModel '));
  const parsed = parseDrawioXml(modelXml);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.deepEqual(
    parsed.document.layers.map((layer) => layer.id),
    ['layer-base', 'layer-annotations', 'layer-notes'],
  );
  const cells = parsed.document.cells;
  assert.equal(cells[0].id, '0');
  assert.equal(cells.find((cell) => cell.id === 'overlay:ann:note').visible, false);
  assert.equal(cells.find((cell) => cell.id === 'overlay:ann:custom').data.cell_kind, 'annotation_node');
  assert.equal(cells.find((cell) => cell.id === 'overlay:ann:custom').data.origin, 'annotation');
  assert.equal(canonicalMxGraph(model), canonicalMxGraph(wrapModel(modelXml)));
});

test('exportDrawio produces root cell 0, three layers, prefixed ids and downgraded annotations', () => {
  const spec = makeSpec();
  const overlay = richOverlay(spec);
  const specBefore = canonicalJson(spec);
  const overlayBefore = canonicalJson(overlay);

  const { xml, warnings } = exportDrawio({ spec, annotation_overlay: overlay }, { now: NOW });
  assert.equal(canonicalJson(spec), specBefore, 'export must not mutate the base spec');
  assert.equal(canonicalJson(overlay), overlayBefore, 'export must not mutate the overlay');
  assert.ok(warnings.includes('note_target_ref_not_serialized'));

  const parsed = parseDrawioXml(xml);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  const { cells, layers } = parsed.document;
  assert.deepEqual(
    layers.map((layer) => layer.id),
    ['layer-base', 'layer-annotations', 'layer-notes'],
  );
  assert.equal(cells[0].id, '0');
  assert.equal(cells[0].data.diagram_id, spec.diagram_id);
  assert.equal(cells[0].data.base_digest, specDigest(spec));

  const content = cells.filter((cell) => cell.id !== '0' && cell.parent !== '0');
  assert.equal(content.length, 6, 'two base nodes, one base edge, one annotation node/edge and one note');
  for (const cell of content) {
    assert.ok(
      cell.id.startsWith('base:') || cell.id.startsWith('overlay:'),
      `content cell ${cell.id} must be prefixed`,
    );
  }
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const ship = byId.get('base:step:ship');
  assert.equal(ship.vertex, true);
  assert.equal(ship.visible, false, 'hidden base node stays in the XML with visible=0');
  assert.deepEqual(
    { x: ship.geometry.x, y: ship.geometry.y, width: ship.geometry.width, height: ship.geometry.height },
    { x: 300, y: 40, width: 160, height: 64 },
    'overlay layout takes priority over spec layout',
  );
  const build = byId.get('base:step:build');
  assert.deepEqual(
    { x: build.geometry.x, y: build.geometry.y, width: build.geometry.width, height: build.geometry.height },
    { x: 0, y: 0, width: 160, height: 64 },
  );
  const baseEdge = byId.get('base:edge:b-s');
  assert.equal(baseEdge.edge, true);
  assert.equal(baseEdge.source, 'base:step:build');
  assert.equal(baseEdge.target, 'base:step:ship');
  assert.equal(baseEdge.visible, false);

  const annotationNode = byId.get('overlay:ann:custom');
  assert.equal(annotationNode.vertex, true);
  assert.equal(annotationNode.data.origin, 'annotation');
  assert.equal(annotationNode.data.certainty, 'unknown');
  assert.equal(annotationNode.data.cell_kind, 'annotation_node');
  const annotationEdge = byId.get('overlay:ann:custom-link');
  assert.equal(annotationEdge.edge, true);
  assert.equal(annotationEdge.data.origin, 'annotation');
  assert.equal(annotationEdge.data.certainty, 'unknown');
  assert.equal(annotationEdge.source, 'base:step:build');
  assert.equal(annotationEdge.target, 'overlay:ann:custom');
  const note = byId.get('overlay:ann:note:build');
  assert.equal(note.parent, 'layer-notes');
  assert.equal(note.data.origin, 'annotation');
  assert.equal(note.data.certainty, 'unknown');
  assert.equal(note.data.cell_kind, 'note');

  // No forged evidence vocabulary is written anywhere.
  for (const cell of content) {
    if (cell.id.startsWith('overlay:')) {
      assert.equal(cell.data.origin, 'annotation');
      assert.equal(cell.data.certainty, 'unknown');
    }
  }
  // The hidden overlay items remain in the JSON overlay (only the XML marks
  // the base cells visible=0).
  assert.equal(overlay.items.filter((item) => item.kind === 'visibility' && item.hidden).length, 2);
});

test('hidden base nodes hide their connected base edges in the view only', () => {
  const spec = makeSpec();
  const overlay = makeOverlay(spec, [
    { id: 'ann:vis:ship', kind: 'visibility', target_ref: 'step:ship', hidden: true },
  ]);
  const { xml } = exportDrawio({ spec, annotation_overlay: overlay }, { now: NOW });
  const parsed = parseDrawioXml(xml);
  assert.equal(parsed.ok, true);
  const edge = parsed.document.cells.find((cell) => cell.id === 'base:edge:b-s');
  assert.equal(edge.visible, false, 'base edge with a hidden endpoint is view-hidden');
  const node = parsed.document.cells.find((cell) => cell.id === 'base:step:ship');
  assert.equal(node.visible, false);
  // The base spec keeps the edge; only the view is hidden.
  assert.equal(spec.edges.length, 1);
  assert.equal(spec.nodes.length, 2);
});

test('exportDrawio canonical semantics are stable across parse/re-serialize', () => {
  const spec = makeSpec();
  const overlay = richOverlay(spec);
  const { xml } = exportDrawio({ spec, annotation_overlay: overlay }, { now: NOW });
  const parsed = parseDrawioXml(xml);
  assert.equal(parsed.ok, true);
  const reSerialized = wrapModel(
    serializeMxGraphModel({ root_cells: parsed.document.cells, layers: parsed.document.layers }),
  );
  assert.equal(canonicalMxGraph(xml), canonicalMxGraph(reSerialized));
  // Deterministic output for the same input.
  assert.equal(exportDrawio({ spec, annotation_overlay: overlay }, { now: NOW }).xml, xml);
});

test('exportDrawio validates its inputs and rejects HTML-looking values', () => {
  // Conceptual mode must not declare sources (contracts semantic rule).
  const badSpec = makeSpec({
    sources: [
      {
        source_id: 'source:demo',
        scope_ref: 'scope:demo',
        snapshot_ref: 'snapshot:demo',
        repos: [],
        evidence_manifest_digest: 'sha256:demo',
      },
    ],
  });
  throwsCode(() => exportDrawio({ spec: badSpec }, { now: NOW }), 'INVALID_SPEC');

  const htmlSpec = makeSpec();
  htmlSpec.nodes[0].label = MALICIOUS.labels.find((label) => label.includes('<script>'));
  throwsCode(() => exportDrawio({ spec: htmlSpec, annotation_overlay: makeOverlay(htmlSpec, []) }, { now: NOW }), 'INVALID_SPEC');

  const validSpec = makeSpec();
  const badOverlay = richOverlay(validSpec);
  badOverlay.items.push({ id: 'ann:dangling', kind: 'annotation_edge', from: 'step:build', to: 'step:missing', label: 'x', description: null });
  throwsCode(
    () => exportDrawio({ spec: validSpec, annotation_overlay: badOverlay }, { now: NOW }),
    'INVALID_OVERLAY',
  );
  // A structurally broken overlay is rejected as well.
  throwsCode(
    () => exportDrawio({ spec: validSpec, annotation_overlay: { ...makeOverlay(validSpec, []), items: 'nope' } }, { now: NOW }),
    'INVALID_OVERLAY',
  );
});

test('exportDrawio refuses every malicious label that is markup or a control string', () => {
  let rejected = 0;
  let accepted = 0;
  for (const label of MALICIOUS.labels) {
    const spec = makeSpec();
    spec.nodes[0].label = label;
    try {
      const { xml } = exportDrawio({ spec, annotation_overlay: makeOverlay(spec, []) }, { now: NOW });
      accepted += 1;
      const parsed = parseDrawioXml(xml);
      assert.equal(parsed.ok, true, `accepted label must round-trip: ${JSON.stringify(label)}`);
      const node = parsed.document.cells.find((cell) => cell.id === 'base:step:build');
      assert.equal(node.value, label);
    } catch (error) {
      assert.ok(error instanceof DiagramError, `unexpected error for ${JSON.stringify(label)}`);
      assert.ok(
        error.code === 'INVALID_SPEC' || error.code === 'INVALID_OVERLAY',
        `unexpected code ${error.code} for ${JSON.stringify(label)}`,
      );
      rejected += 1;
    }
  }
  assert.ok(rejected >= 5, `expected markup/control labels to be rejected, got ${rejected}`);
  assert.ok(accepted >= 1, 'plain-text labels such as URLs must still be exportable');
});

/* -------------------------------------------------------------------------- */
/* restricted drawio parser                                                    */
/* -------------------------------------------------------------------------- */

test('parseDrawioXml accepts an external uncompressed drawio document', () => {
  const xml = readFileSync(path.join(FIXTURES, 'drawio', 'external-basic.drawio'), 'utf8');
  const parsed = parseDrawioXml(xml);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  const { cells, layers } = parsed.document;
  assert.deepEqual(layers, [{ id: '1', value: '' }]);
  assert.equal(cells.length, 6);
  const n1 = cells.find((cell) => cell.id === 'n1');
  assert.equal(n1.value, 'build');
  assert.equal(n1.vertex, true);
  assert.equal(n1.style.rounded, '1');
  assert.equal(n1.style.fillColor, '#dae8fc');
  assert.deepEqual(
    { x: n1.geometry.x, y: n1.geometry.y, width: n1.geometry.width, height: n1.geometry.height },
    { x: 10, y: 20, width: 160, height: 64 },
  );
  const e1 = cells.find((cell) => cell.id === 'e1');
  assert.equal(e1.edge, true);
  assert.equal(e1.source, 'n1');
  assert.equal(e1.target, 'n2');
});

test('parseDrawioXml rejects compressed diagrams as unsupported with a clear reason', () => {
  const xml = readFileSync(path.join(FIXTURES, 'drawio', 'compressed.drawio'), 'utf8');
  const parsed = parseDrawioXml(xml);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNSUPPORTED');
  assert.match(parsed.errors[0].message, /uncompressed/i);
});

test('parseDrawioXml rejects remote/script style values', () => {
  const styles = [MALICIOUS.remote_style, ...MALICIOUS.remote_style_cases];
  for (const style of styles) {
    const xml = minimalDocument({ cells: [vertexCell({ style })] });
    const parsed = parseDrawioXml(xml);
    assert.equal(parsed.ok, false, `style must be rejected: ${style}`);
    assert.ok(
      parsed.code === 'INVALID_XML' || parsed.code === 'UNSUPPORTED',
      `unexpected code ${parsed.code} for ${style}`,
    );
  }
  // The control style is on the closed whitelist.
  const control = minimalDocument({ cells: [vertexCell({ style: MALICIOUS.control_style })] });
  assert.equal(parseDrawioXml(control).ok, true);
});

test('parseDrawioXml rejects unknown advanced shapes and unknown style keys as unsupported', () => {
  for (const style of ['shape=umlActor;', 'sketch=1;', 'rounded=1;comic=1;']) {
    const parsed = parseDrawioXml(minimalDocument({ cells: [vertexCell({ id: 'n1', style })] }));
    assert.equal(parsed.ok, false, `style must be unsupported: ${style}`);
    assert.equal(parsed.code, 'UNSUPPORTED');
  }
  const objectWrapper = wrapModel(
    `<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><object id="n1" label="A" parent="1"><mxCell vertex="1" /></object></root></mxGraphModel>`,
  );
  const parsed = parseDrawioXml(objectWrapper);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'UNSUPPORTED');
});

test('parseDrawioXml rejects HTML values, unknown attributes and broken structure', () => {
  const htmlValue = minimalDocument({ cells: [vertexCell({ id: 'n1' })] }).replace(
    'value="A"',
    'value="&lt;script&gt;alert(1)&lt;/script&gt;"',
  );
  const html = parseDrawioXml(htmlValue);
  assert.equal(html.ok, false);
  assert.equal(html.code, 'INVALID_XML');
  assert.match(html.errors[0].message, /HTML/i);

  const unknownAttribute = minimalDocument({ cells: [vertexCell({ extra: ' image="https://evil.example/x"' })] });
  const unknown = parseDrawioXml(unknownAttribute);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNSUPPORTED');

  const duplicateCell = minimalDocument({ cells: [vertexCell({ id: 'n1' }), vertexCell({ id: 'n1' })] });
  assert.equal(parseDrawioXml(duplicateCell).code, 'INVALID_XML');

  const noLayer = wrapModel('<mxGraphModel><root><mxCell id="0" /></root></mxGraphModel>');
  assert.equal(parseDrawioXml(noLayer).ok, false);

  const nestedGroup = minimalDocument({
    cells: [vertexCell({ id: 'g1' }), vertexCell({ id: 'n1', parent: 'g1' })],
  });
  const nested = parseDrawioXml(nestedGroup);
  assert.equal(nested.ok, false);
  assert.equal(nested.code, 'UNSUPPORTED');

  const danglingEdge = minimalDocument({
    cells: [vertexCell({ id: 'n1' }), edgeCell({ id: 'e1', source: 'n1', target: 'n-missing' })],
  });
  const dangling = parseDrawioXml(danglingEdge);
  assert.equal(dangling.ok, false);
  assert.equal(dangling.code, 'INVALID_XML');

  const badOrigin = minimalDocument({ cells: [vertexCell({ extra: ' data_origin="trusted"' })] });
  const origin = parseDrawioXml(badOrigin);
  assert.equal(origin.ok, false);
  assert.equal(origin.code, 'INVALID_XML');

  const evidenceMetadata = minimalDocument({
    cells: [vertexCell({ extra: ' data_origin="evidence" data_certainty="exact" data_base_digest="' + 'b'.repeat(64) + '"' })],
  });
  const metadata = parseDrawioXml(evidenceMetadata);
  assert.equal(metadata.ok, true);
  const cell = metadata.document.cells.find((entry) => entry.id === 'n1');
  assert.equal(cell.data.origin, 'evidence');
  assert.equal(cell.data.certainty, 'exact');
  assert.equal(cell.data.base_digest, 'b'.repeat(64));
});

test('parseDrawioXml enforces the cell limit', () => {
  const cells = [vertexCell({ id: 'n1' }), vertexCell({ id: 'n2' }), vertexCell({ id: 'n3' })];
  const parsed = parseDrawioXml(minimalDocument({ cells }), { limits: { mx_cells: 2 } });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'LIMIT_EXCEEDED');
});

/* -------------------------------------------------------------------------- */
/* canonical semantic comparison                                               */
/* -------------------------------------------------------------------------- */

test('canonicalMxGraph ignores order and attribute/style ordering', () => {
  const left = {
    root_cells: [
      { id: '0' },
      { id: 'layer-a', parent: '0', value: 'A' },
      {
        id: 'n1',
        parent: 'layer-a',
        value: 'x',
        style: 'fillColor=#fff;rounded=1;',
        vertex: true,
        visible: true,
        geometry: { x: 1, y: 2, width: 3, height: 4, as: 'geometry' },
      },
    ],
    layers: [{ id: 'layer-a', value: 'A' }],
  };
  const right = {
    root_cells: [
      {
        id: 'n1',
        parent: 'layer-a',
        value: 'x',
        style: 'rounded=1;fillColor=#fff;',
        vertex: true,
        geometry: { x: 1, y: 2, width: 3, height: 4, as: 'geometry' },
      },
      { id: 'layer-a', parent: '0', value: 'A' },
      { id: '0' },
    ],
    layers: [{ id: 'layer-a', value: 'A' }],
  };
  assert.equal(canonicalMxGraph(left), canonicalMxGraph(right));

  const hidden = {
    root_cells: [{ id: '0' }, { id: 'n1', parent: '1', vertex: true, visible: false }],
    layers: [{ id: '1', value: 'Layer' }],
  };
  const hiddenXml = wrapModel(
    '<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" value="Layer" /><mxCell id="n1" vertex="1" parent="1" visible="0" /></root></mxGraphModel>',
  );
  assert.equal(canonicalMxGraph(hidden), canonicalMxGraph(hiddenXml));

  throwsCode(() => canonicalMxGraph('<mxfile><diagram id="x">broken'), 'INVALID_XML');
});
