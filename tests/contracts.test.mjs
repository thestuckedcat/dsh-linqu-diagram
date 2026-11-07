/**
 * Contract tests: authoritative JSON schemas, strict validation, semantic
 * invariants, digests and constructors (docs/interfaces.md §1).
 *
 * Negative cases are deliberately first-class: every rule below has a negative
 * case that would pass if the validator were permissive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { canonicalJson } from '../src/canonical.mjs';
import { DiagramError } from '../src/errors.mjs';
import { LIMITS } from '../src/limits.mjs';
import {
  SCHEMAS,
  ADDITIONAL_SCHEMAS,
  ALL_SCHEMAS,
  SCHEMA_FILES,
  PATTERNS,
  EDITOR_COMMAND_KIND_LIST,
  validateSourceIdentity,
  validateEvidenceRef,
  validateDiagramSpec,
  validateOverlay,
  validateManifest,
  validateDocumentVersion,
  validateAccessRegistry,
  validateEditorModel,
  validateRpcRequest,
  validateRpcResponse,
  validateEditorCommand,
  validateSourceLock,
  validateComposite,
  specDigest,
  overlayDigest,
  manifestDigest,
  documentVersionDigest,
  emptyOverlay,
  text,
  id,
  utcTimestamp,
  sha256HexValue,
} from '../src/contracts.mjs';
import { toDiagram, emptyConceptualSpec } from '../src/evidence.mjs';

const CLOCK_TIME = '2026-11-07T00:00:00.000Z';
const CLOCK = () => CLOCK_TIME;
const HEX_A = 'a'.repeat(64);

const readJson = (relative) => JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const sourceIdentity = readJson('tests/fixtures/snapshot/source-identity.json');
const evidenceSubset = readJson('tests/fixtures/snapshot/evidence-subset.json');
const conceptualInput = readJson('tests/fixtures/conceptual/input.json');

/** @returns {any} */
function evidenceSpec(policy = {}) {
  const result = toDiagram({ source_identity: sourceIdentity, evidence_subset: evidenceSubset }, { clock: CLOCK, ...policy });
  assert.equal(result.status, 'ok', `toDiagram failed: ${JSON.stringify(result.errors ?? [])}`);
  return result.spec;
}

/** @returns {any} */
function conceptualSpec(policy = {}) {
  const result = toDiagram({ conceptual_input: conceptualInput }, { clock: CLOCK, ...policy });
  assert.equal(result.status, 'ok', `toDiagram failed: ${JSON.stringify(result.errors ?? [])}`);
  return result.spec;
}

function samplePosition(overrides = {}) {
  return { x: 0, y: 0, width: 160, height: 64, ...overrides };
}

function sampleManifest(overrides = {}) {
  return {
    schema_version: 1,
    artifact_id: 'artifact:demo',
    diagram_id: 'diagram:demo',
    spec_digest: HEX_A,
    source_digests: [{ source_id: 'local-atlas-synthetic', digest: HEX_A }],
    renderer_ref: 'builtin:renderer-v1',
    created_at: CLOCK_TIME,
    files: [{ relative_path: 'index.html', media_type: 'text/html', sha256: HEX_A, size: 0 }],
    network_mode: 'offline',
    source_state: 'unknown',
    ...overrides,
  };
}

function sampleDocumentVersion(overrides = {}) {
  return {
    schema_version: 1,
    document_id: 'doc:demo',
    generation: 0,
    content_sha256: HEX_A,
    byte_length: 0,
    path_identity_digest: 'path:identity:1',
    ...overrides,
  };
}

/**
 * @param {any} result
 * @param {string} [keyword]
 */
function assertInvalid(result, keyword) {
  assert.equal(result.ok, false, 'expected validation failure');
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, 'expected structured errors');
  if (keyword !== undefined) {
    assert.ok(
      result.errors.some((entry) => entry.keyword === keyword),
      `expected keyword ${keyword}, got ${JSON.stringify(result.errors.map((entry) => entry.keyword))}`,
    );
  }
}

/**
 * @param {() => unknown} fn
 * @param {string} code
 */
function assertThrowsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DiagramError, 'expected a DiagramError');
    assert.equal(error.code, code);
    return true;
  });
}

/* ------------------------------------------------------------------------- *
 * Authoritative JSON artifacts
 * ------------------------------------------------------------------------- */

test('schemas: every schemas/*.json file is the authoritative mirror of the JS schema object', () => {
  const schemaDir = new URL('../schemas/', import.meta.url);
  const files = readdirSync(schemaDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const expectedFiles = Object.values(SCHEMA_FILES)
    .map((relative) => relative.split('/').pop())
    .sort();
  assert.deepEqual(files, expectedFiles, 'schemas/ must contain exactly the registered schema files');
  for (const [name, relative] of Object.entries(SCHEMA_FILES)) {
    const fromFile = readJson(relative);
    const fromJs = ALL_SCHEMAS[name];
    assert.ok(fromJs, `missing JS schema object for ${name}`);
    assert.equal(canonicalJson(fromFile), canonicalJson(fromJs), `schemas file ${relative} differs from ALL_SCHEMAS.${name}`);
  }
  assert.equal(Object.isFrozen(SCHEMAS), true);
  assert.equal(Object.isFrozen(ALL_SCHEMAS), true);
});

test('schemas: SCHEMAS exposes exactly the documented §1 names; extra schemas are registered separately', () => {
  assert.deepEqual(Object.keys(SCHEMAS).sort(), [
    'access_registry',
    'annotation_overlay',
    'artifact_manifest',
    'diagram_spec',
    'document_version',
    'editor_model',
    'evidence_ref',
    'rpc_request',
    'rpc_response',
    'source_identity',
  ]);
  assert.deepEqual(Object.keys(ADDITIONAL_SCHEMAS).sort(), ['editor_command', 'source_lock']);
  assert.deepEqual(Object.keys(ALL_SCHEMAS).sort(), Object.keys(SCHEMA_FILES).sort());
});

test('schemas: additionalProperties is false on every object contract (documented endpoint payload/env exceptions only)', () => {
  /** @type {{path: string, node: any}[]} */
  const objectNodes = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (node.type === 'object' || node.properties !== undefined || node.required !== undefined) {
      objectNodes.push({ path, node });
    }
    if (node.properties) {
      for (const [key, value] of Object.entries(node.properties)) walk(value, `${path}.properties.${key}`);
    }
    if (node.items !== undefined) walk(node.items, `${path}.items`);
    for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(node[keyword])) {
        node[keyword].forEach((entry, index) => walk(entry, `${path}.${keyword}[${index}]`));
      }
    }
    if (node.not !== undefined) walk(node.not, `${path}.not`);
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      walk(node.additionalProperties, `${path}.additionalProperties`);
    }
  };
  for (const [name, schema] of Object.entries(ALL_SCHEMAS)) walk(schema, name);

  for (const { path, node } of objectNodes) {
    if (path.endsWith('.properties.env_fixed')) {
      assert.equal(typeof node.additionalProperties, 'object', `${path}: env maps are the only open string maps`);
      continue;
    }
    if (path.endsWith('.properties.input') || path.endsWith('.properties.data')) {
      assert.ok(
        node.additionalProperties === undefined || node.additionalProperties === false,
        `${path}: endpoint-specific payloads must be the only open object slots`,
      );
      continue;
    }
    assert.equal(node.additionalProperties, false, `${path}: additionalProperties must be false`);
  }
});

test('schemas: schema files stay self-contained (no $ref) and only use supported keywords for the built-in validator', () => {
  const supported = new Set([
    '$schema',
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'pattern',
    'minimum',
    'maximum',
    'enum',
    'const',
    'oneOf',
    'anyOf',
    'allOf',
    'not',
    'description',
    'format',
  ]);
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' || key === 'patternProperties') {
        assert.equal(key, 'properties');
        Object.values(value).forEach(walk);
        continue;
      }
      assert.ok(supported.has(key), `unsupported or non-self-contained keyword ${key}`);
      walk(value);
    }
  };
  for (const schema of Object.values(ALL_SCHEMAS)) walk(schema);
});

/* ------------------------------------------------------------------------- *
 * DiagramSpecV1
 * ------------------------------------------------------------------------- */

test('diagram spec: evidence and conceptual fixtures validate', () => {
  const spec = evidenceSpec();
  const result = validateDiagramSpec(spec);
  assert.equal(result.ok, true, JSON.stringify(result.errors ?? []));
  assert.equal(result.value, spec);
  assert.equal(validateDiagramSpec(conceptualSpec()).ok, true);
});

test('diagram spec: rejects unknown properties at every level', () => {
  const spec = evidenceSpec();
  const top = clone(spec);
  top.unexpected = true;
  assertInvalid(validateDiagramSpec(top), 'additionalProperties');
  assert.ok(validateDiagramSpec(top).errors.some((entry) => entry.path === '$.unexpected'));

  const nested = clone(spec);
  nested.edges[0].certainty_hint = 'exact';
  assertInvalid(validateDiagramSpec(nested), 'additionalProperties');
  assert.ok(validateDiagramSpec(nested).errors.some((entry) => entry.path === '$.edges[0].certainty_hint'));

  const source = clone(spec);
  source.sources[0].repos[0].commit = 'abc';
  assertInvalid(validateDiagramSpec(source), 'additionalProperties');
});

test('diagram spec: rejects wrong schema_version, negative/unsafe numbers and non-UTC timestamps', () => {
  assertInvalid(validateDiagramSpec({ ...evidenceSpec(), schema_version: 2 }), 'const');
  assertInvalid(validateDiagramSpec({ ...evidenceSpec(), revision: -1 }), 'minimum');
  assertInvalid(validateDiagramSpec({ ...evidenceSpec(), revision: 1.5 }), 'type');
  assertInvalid(validateDiagramSpec({ ...evidenceSpec(), generated_at: '2026-11-07' }), 'pattern');
  assertInvalid(validateDiagramSpec({ ...evidenceSpec(), generated_at: '2026-11-07T00:00:00Z' }), 'pattern');
  assertInvalid(validateDiagramSpec({ ...evidenceSpec(), source_state: 'verified' }), 'enum');
});

test('diagram spec: rejects control characters and over-long plain text', () => {
  const spec = evidenceSpec();
  const withControl = clone(spec);
  withControl.nodes[0].label = 'a\u0000b';
  assertInvalid(validateDiagramSpec(withControl), 'not');

  const longLabel = clone(spec);
  longLabel.nodes[0].label = 'x'.repeat(LIMITS.label + 1);
  assertInvalid(validateDiagramSpec(longLabel), 'maxLength');

  const maxLabel = clone(spec);
  maxLabel.nodes[0].label = 'x'.repeat(LIMITS.label);
  assert.equal(validateDiagramSpec(maxLabel).ok, true, 'exactly LIMITS.label characters must be accepted');

  const emptyLabel = clone(spec);
  emptyLabel.nodes[0].label = '';
  assert.equal(validateDiagramSpec(emptyLabel).ok, true, 'label has a max bound only; empty labels are allowed by the design');
});

test('diagram spec: rejects non-integer layout coordinates, wrong sizes and dangling/duplicate positions', () => {
  const spec = evidenceSpec();
  const nodeId = spec.nodes[0].id;
  const withPosition = (position) => {
    const next = clone(spec);
    next.layout.positions = [{ node_id: nodeId, ...samplePosition(), ...position }];
    return next;
  };
  assert.equal(validateDiagramSpec(withPosition({})).ok, true);
  assertInvalid(validateDiagramSpec(withPosition({ x: 100001 })), 'maximum');
  assert.equal(validateDiagramSpec(withPosition({ x: 100000, y: -100000 })).ok, true);
  assertInvalid(validateDiagramSpec(withPosition({ width: 0 })), 'minimum');
  assertInvalid(validateDiagramSpec(withPosition({ width: 10001 })), 'maximum');
  assert.equal(validateDiagramSpec(withPosition({ width: 10000 })).ok, true);
  assertInvalid(validateDiagramSpec(withPosition({ x: 0.5 })), 'type');

  const dangling = clone(spec);
  dangling.layout.positions = [{ node_id: 'node:missing', ...samplePosition() }];
  assertInvalid(validateDiagramSpec(dangling), 'unknown_ref');

  const duplicate = clone(spec);
  duplicate.layout.positions = [
    { node_id: nodeId, ...samplePosition() },
    { node_id: nodeId, ...samplePosition({ x: 32 }) },
  ];
  assertInvalid(validateDiagramSpec(duplicate), 'duplicate_id');
});

test('diagram spec: exact evidence edge requires evidence_refs (DIA-01 negative case)', () => {
  const spec = evidenceSpec();
  const exactIndex = spec.edges.findIndex((edge) => edge.certainty === 'exact');
  assert.ok(exactIndex >= 0);
  const broken = clone(spec);
  broken.edges[exactIndex].evidence_refs = [];
  assertInvalid(validateDiagramSpec(broken), 'exact_requires_evidence');
});

test('diagram spec: annotation edges cannot gain certainty or evidence; evidence edges cannot fall to unknown', () => {
  const spec = evidenceSpec();
  const annotationIndex = spec.edges.findIndex((edge) => edge.origin === 'annotation');
  assert.ok(annotationIndex >= 0);

  const certain = clone(spec);
  certain.edges[annotationIndex].certainty = 'exact';
  assertInvalid(validateDiagramSpec(certain), 'annotation_invariant');

  const withEvidence = clone(spec);
  withEvidence.edges[annotationIndex].evidence_refs = [clone(evidenceSubset.edges[0].evidence_refs[0])];
  assertInvalid(validateDiagramSpec(withEvidence), 'annotation_has_evidence');

  const callKind = clone(spec);
  callKind.edges[annotationIndex].kind = 'call';
  assertInvalid(validateDiagramSpec(callKind), 'annotation_invariant');

  const unknownEvidence = clone(spec);
  unknownEvidence.edges[0].certainty = 'unknown';
  assertInvalid(validateDiagramSpec(unknownEvidence), 'inconsistent_edge');

  const annotationKind = clone(spec);
  annotationKind.edges[0].kind = 'annotation';
  assertInvalid(validateDiagramSpec(annotationKind), 'inconsistent_edge');

  const annotationNode = clone(spec);
  annotationNode.nodes[0].origin = 'annotation';
  assertInvalid(validateDiagramSpec(annotationNode), 'annotation_has_evidence');
});

test('diagram spec: conceptual mode rejects sources, evidence edges and non-annotation certainty', () => {
  const spec = conceptualSpec();
  assert.equal(spec.sources.length, 0);

  const withSource = clone(spec);
  withSource.sources = [clone(sourceIdentity)];
  assertInvalid(validateDiagramSpec(withSource), 'conceptual_invariant');

  const evidenceEdge = clone(spec);
  evidenceEdge.edges[0].origin = 'evidence';
  assertInvalid(validateDiagramSpec(evidenceEdge), 'conceptual_invariant');

  const certain = clone(spec);
  certain.edges[0].certainty = 'may';
  assertInvalid(validateDiagramSpec(certain), 'conceptual_invariant');

  const refs = clone(spec);
  refs.edges[0].evidence_refs = [clone(evidenceSubset.edges[0].evidence_refs[0])];
  assertInvalid(validateDiagramSpec(refs), 'conceptual_invariant');

  const evidenceNode = clone(spec);
  evidenceNode.nodes[0].origin = 'evidence';
  assertInvalid(validateDiagramSpec(evidenceNode), 'conceptual_invariant');
});

test('diagram spec: evidence mode requires a source identity and unique document entity ids', () => {
  const spec = evidenceSpec();
  const noSources = clone(spec);
  noSources.sources = [];
  assertInvalid(validateDiagramSpec(noSources), 'evidence_sources_required');

  const collision = clone(spec);
  collision.edges[0].id = collision.nodes[0].id;
  assertInvalid(validateDiagramSpec(collision), 'duplicate_id');

  const dangling = clone(spec);
  dangling.edges[0].to = 'node:missing';
  assertInvalid(validateDiagramSpec(dangling), 'unknown_ref');
});

test('diagram spec: evidence refs must declare a known source/repo and ordered line ranges', () => {
  const spec = evidenceSpec();
  const badRepo = clone(spec);
  badRepo.nodes[0].evidence_refs[0].repo_id = 'repo:missing';
  assertInvalid(validateDiagramSpec(badRepo), 'unknown_ref');

  const badSource = clone(spec);
  badSource.nodes[0].evidence_refs[0].source_id = 'source:missing';
  assertInvalid(validateDiagramSpec(badSource), 'unknown_ref');

  const badRange = clone(spec);
  badRange.nodes[0].evidence_refs[0].line_end = badRange.nodes[0].evidence_refs[0].line_start - 1;
  if (badRange.nodes[0].evidence_refs[0].line_end >= 1) {
    assertInvalid(validateDiagramSpec(badRange), 'invalid_range');
  }
});

test('diagram spec: limit boundaries (nodes, edges, evidence_refs) are enforced at the exact boundary', () => {
  const nodes = Array.from({ length: LIMITS.nodes }, (_, index) => ({ id: `n${index}`, label: `n${index}`, kind: 'module' }));
  const edges = Array.from({ length: LIMITS.edges }, (_, index) => ({
    from: `n${index % LIMITS.nodes}`,
    to: `n${(index + 1) % LIMITS.nodes}`,
    kind: 'control',
    label: `e${index}`,
  }));
  const atLimit = emptyConceptualSpec({ title: 'limits', scope_ref: 'ws:limits', nodes, edges }, { clock: CLOCK });
  assert.equal(atLimit.nodes.length, LIMITS.nodes);
  assert.equal(atLimit.edges.length, LIMITS.edges);
  assert.equal(validateDiagramSpec(atLimit).ok, true, 'exactly LIMITS.nodes/edges must validate');

  const tooManyNodes = clone(atLimit);
  tooManyNodes.nodes.push({ id: 'n-over', label: 'over', kind: 'module', origin: 'annotation', evidence_refs: [], description: null });
  assertInvalid(validateDiagramSpec(tooManyNodes), 'maxItems');

  const tooManyEdges = clone(atLimit);
  tooManyEdges.edges.push({
    id: 'edge-over',
    from: 'n0',
    to: 'n1',
    kind: 'control',
    certainty: 'unknown',
    origin: 'annotation',
    label: 'over',
    evidence_refs: [],
    explanation: null,
  });
  assertInvalid(validateDiagramSpec(tooManyEdges), 'maxItems');

  const spec = evidenceSpec();
  const ref = clone(evidenceSubset.nodes[0].evidence_refs[0]);
  const fillRefs = (count) =>
    Array.from({ length: count }, (_, index) => ({ ...ref, evidence_id: `ev-dup-${index}` }));
  const atRefLimit = clone(spec);
  atRefLimit.nodes[0].evidence_refs = fillRefs(LIMITS.evidence_refs_per_entity);
  assert.equal(validateDiagramSpec(atRefLimit).ok, true, 'exactly LIMITS.evidence_refs_per_entity must validate');
  atRefLimit.nodes[0].evidence_refs = fillRefs(LIMITS.evidence_refs_per_entity + 1);
  assertInvalid(validateDiagramSpec(atRefLimit), 'maxItems');
});

/* ------------------------------------------------------------------------- *
 * AnnotationOverlayV1
 * ------------------------------------------------------------------------- */

function evidenceOverlay(spec, items = []) {
  return {
    ...emptyOverlay({ diagram_id: spec.diagram_id, base_spec_digest: specDigest(spec), now: CLOCK_TIME }),
    items,
  };
}

test('overlay: empty overlay and every item kind validate', () => {
  const spec = evidenceSpec();
  const overlay = evidenceOverlay(spec, [
    { id: 'ann:note-1', kind: 'note', target_ref: spec.nodes[0].id, text: 'check this', position: samplePosition() },
    { id: 'ann:layout-1', kind: 'layout', target_ref: spec.nodes[0].id, position: samplePosition({ x: 100 }) },
    { id: 'ann:vis-1', kind: 'visibility', target_ref: spec.edges[0].id, hidden: true },
  ]);
  const result = validateOverlay(overlay);
  assert.equal(result.ok, true, JSON.stringify(result.errors ?? []));
  assert.equal(overlayDigest(overlay).length, 64);

  const emptyText = evidenceOverlay(spec, [
    { id: 'ann:note-empty', kind: 'note', target_ref: null, text: '', position: samplePosition() },
  ]);
  assert.equal(validateOverlay(emptyText).ok, true, 'note text has a max bound only; empty notes are valid');
});

test('overlay: rejects extra properties, a fourth union kind, bad ids and bad positions', () => {
  const spec = evidenceSpec();
  const base = evidenceOverlay(spec);

  const extra = { ...base, extra: 1 };
  assertInvalid(validateOverlay(extra), 'additionalProperties');

  const unknownKind = {
    ...base,
    items: [{ id: 'ann:x', kind: 'annotation_node_x', label: 'x', description: null, position: samplePosition() }],
  };
  assertInvalid(validateOverlay(unknownKind), 'oneOf');

  const badId = { ...base, items: [{ id: 'note-1', kind: 'note', target_ref: null, text: 'x', position: samplePosition() }] };
  assertInvalid(validateOverlay(badId), 'id_prefix');

  const badPosition = {
    ...base,
    items: [{ id: 'ann:n1', kind: 'note', target_ref: null, text: 'x', position: samplePosition({ x: 100001 }) }],
  };
  assertInvalid(validateOverlay(badPosition), 'oneOf');

  const zeroSize = {
    ...base,
    items: [{ id: 'ann:n1', kind: 'note', target_ref: null, text: 'x', position: samplePosition({ height: 0 }) }],
  };
  assertInvalid(validateOverlay(zeroSize), 'oneOf');
});

test('overlay: annotation_edge items carry no evidence/origin/certainty fields', () => {
  const spec = conceptualSpec();
  const overlay = evidenceOverlay(spec, [
    {
      id: 'ann:e1',
      kind: 'annotation_edge',
      from: spec.nodes[0].id,
      to: spec.nodes[1].id,
      label: 'explains',
      description: null,
      evidence_refs: [],
    },
  ]);
  assertInvalid(validateOverlay(overlay), 'oneOf');
});

test('overlay: ids are unique and each layout/visibility target appears at most once', () => {
  const spec = evidenceSpec();
  const nodeId = spec.nodes[0].id;
  const duplicateIds = evidenceOverlay(spec, [
    { id: 'ann:same', kind: 'note', target_ref: null, text: 'a', position: samplePosition() },
    { id: 'ann:same', kind: 'note', target_ref: null, text: 'b', position: samplePosition() },
  ]);
  assertInvalid(validateOverlay(duplicateIds), 'duplicate_id');

  const duplicateLayout = evidenceOverlay(spec, [
    { id: 'ann:l1', kind: 'layout', target_ref: nodeId, position: samplePosition() },
    { id: 'ann:l2', kind: 'layout', target_ref: nodeId, position: samplePosition({ x: 10 }) },
  ]);
  assertInvalid(validateOverlay(duplicateLayout), 'duplicate_id');

  const duplicateVisibility = evidenceOverlay(spec, [
    { id: 'ann:v1', kind: 'visibility', target_ref: nodeId, hidden: true },
    { id: 'ann:v2', kind: 'visibility', target_ref: nodeId, hidden: false },
  ]);
  assertInvalid(validateOverlay(duplicateVisibility), 'duplicate_id');
});

test('overlay: item count boundary enforced', () => {
  const spec = evidenceSpec();
  const note = (index) => ({
    id: `ann:note-${index}`,
    kind: 'note',
    target_ref: null,
    text: 'n',
    position: samplePosition(),
  });
  const atLimit = evidenceOverlay(spec, Array.from({ length: LIMITS.overlay_items }, (_, index) => note(index)));
  assert.equal(validateOverlay(atLimit).ok, true, 'exactly LIMITS.overlay_items must validate');
  atLimit.items.push(note(LIMITS.overlay_items));
  assertInvalid(validateOverlay(atLimit), 'maxItems');
});

/* ------------------------------------------------------------------------- *
 * validateComposite
 * ------------------------------------------------------------------------- */

test('composite: base spec + context overlay validates for evidence and conceptual diagrams', () => {
  const spec = evidenceSpec();
  const overlay = evidenceOverlay(spec, [
    { id: 'ann:note-1', kind: 'note', target_ref: spec.nodes[0].id, text: 'note', position: samplePosition() },
    { id: 'ann:layout-1', kind: 'layout', target_ref: spec.nodes[0].id, position: samplePosition({ x: 32 }) },
    { id: 'ann:vis-1', kind: 'visibility', target_ref: spec.nodes[1].id, hidden: true },
  ]);
  const result = validateComposite(spec, overlay);
  assert.equal(result.ok, true, JSON.stringify(result.errors ?? []));
  assert.equal(result.value.spec, spec);
  assert.equal(result.value.overlay, overlay);

  const base = conceptualSpec();
  const conceptualOverlay = {
    ...emptyOverlay({ diagram_id: base.diagram_id, base_spec_digest: specDigest(base), now: CLOCK_TIME }),
    items: [
      { id: 'ann:node-1', kind: 'annotation_node', label: '额外说明', description: null, position: samplePosition() },
      { id: 'ann:edge-1', kind: 'annotation_edge', from: base.nodes[0].id, to: 'ann:node-1', label: '人工连线', description: null },
    ],
  };
  const conceptualResult = validateComposite(base, conceptualOverlay);
  assert.equal(conceptualResult.ok, true, JSON.stringify(conceptualResult.errors ?? []));
});

test('composite: digests and diagram ids must match the base spec', () => {
  const spec = evidenceSpec();
  const overlay = evidenceOverlay(spec);

  const wrongDigest = { ...overlay, base_spec_digest: 'b'.repeat(64) };
  const digestResult = validateComposite(spec, wrongDigest);
  assertInvalid(digestResult, 'base_digest_mismatch');

  const wrongDiagram = { ...overlay, diagram_id: 'diagram:other' };
  assertInvalid(validateComposite(spec, wrongDiagram), 'diagram_mismatch');

  const tamperedSpec = { ...clone(spec), generated_at: '2026-11-08T00:00:00.000Z' };
  assert.equal(validateComposite(tamperedSpec, overlay).ok, true, 'generated_at is not part of the base digest');

  const changedSpec = { ...clone(spec), title: 'changed title' };
  assertInvalid(validateComposite(changedSpec, overlay), 'base_digest_mismatch');
});

test('composite: layout targets a base node; visibility targets a base entity; note targets an entity', () => {
  const spec = evidenceSpec();
  const overlay = evidenceOverlay(spec, [
    {
      id: 'ann:node-1',
      kind: 'note',
      target_ref: 'missing:node',
      text: 'x',
      position: samplePosition(),
    },
  ]);
  assertInvalid(validateComposite(spec, overlay), 'unknown_ref');

  const visibilityToMissing = evidenceOverlay(spec, [
    { id: 'ann:v1', kind: 'visibility', target_ref: 'missing:edge', hidden: true },
  ]);
  assertInvalid(validateComposite(spec, visibilityToMissing), 'unknown_ref');

  const conceptual = conceptualSpec();
  const conceptualOverlay = {
    ...emptyOverlay({ diagram_id: conceptual.diagram_id, base_spec_digest: specDigest(conceptual), now: CLOCK_TIME }),
    items: [
      { id: 'ann:node-1', kind: 'annotation_node', label: 'n', description: null, position: samplePosition() },
      { id: 'ann:layout-1', kind: 'layout', target_ref: 'ann:node-1', position: samplePosition() },
    ],
  };
  assertInvalid(validateComposite(conceptual, conceptualOverlay), 'unknown_ref');
});

test('composite: annotation edges need visible, existing node endpoints', () => {
  const spec = evidenceSpec();
  const [first, second] = spec.nodes;
  const unknownEndpoint = evidenceOverlay(spec, [
    { id: 'ann:e1', kind: 'annotation_edge', from: first.id, to: 'node:missing', label: 'x', description: null },
  ]);
  assertInvalid(validateComposite(spec, unknownEndpoint), 'unknown_ref');

  const hiddenEndpoint = evidenceOverlay(spec, [
    { id: 'ann:v1', kind: 'visibility', target_ref: second.id, hidden: true },
    { id: 'ann:e1', kind: 'annotation_edge', from: first.id, to: second.id, label: 'x', description: null },
  ]);
  assertInvalid(validateComposite(spec, hiddenEndpoint), 'not_visible');

  const visible = evidenceOverlay(spec, [
    { id: 'ann:v1', kind: 'visibility', target_ref: second.id, hidden: false },
    { id: 'ann:e1', kind: 'annotation_edge', from: first.id, to: second.id, label: 'x', description: null },
  ]);
  assert.equal(validateComposite(spec, visible).ok, true);
});

test('composite: evidence diagrams forbid annotation_node items; conceptual diagrams allow them', () => {
  const spec = evidenceSpec();
  const overlay = evidenceOverlay(spec, [
    { id: 'ann:node-1', kind: 'annotation_node', label: 'new entity', description: null, position: samplePosition() },
  ]);
  assertInvalid(validateComposite(spec, overlay), 'forbidden_item');

  const conceptual = conceptualSpec();
  const conceptualOverlay = {
    ...emptyOverlay({ diagram_id: conceptual.diagram_id, base_spec_digest: specDigest(conceptual), now: CLOCK_TIME }),
    items: [{ id: 'ann:node-1', kind: 'annotation_node', label: 'new entity', description: null, position: samplePosition() }],
  };
  assert.equal(validateComposite(conceptual, conceptualOverlay).ok, true);
});

test('composite: overlay item ids must not collide with base node/edge ids', () => {
  const spec = clone(evidenceSpec());
  const originalId = spec.nodes[0].id;
  spec.nodes[0].id = 'ann:base-node';
  for (const edge of spec.edges) {
    if (edge.from === originalId) edge.from = 'ann:base-node';
    if (edge.to === originalId) edge.to = 'ann:base-node';
  }
  assert.equal(validateDiagramSpec(spec).ok, true);
  const overlay = evidenceOverlay(spec, [
    { id: 'ann:base-node', kind: 'note', target_ref: null, text: 'collision', position: samplePosition() },
  ]);
  assertInvalid(validateComposite(spec, overlay), 'duplicate_id');
});

/* ------------------------------------------------------------------------- *
 * Digests
 * ------------------------------------------------------------------------- */

test('digests: deterministic, content-bound and volatile-field-tolerant', () => {
  const spec = evidenceSpec();
  const digest = specDigest(spec);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(specDigest(clone(spec)), digest, 'digest must not depend on property insertion order');

  const volatile = clone(spec);
  volatile.generated_at = '2026-01-01T00:00:00.000Z';
  volatile.source_state = 'stale';
  assert.equal(specDigest(volatile), digest, 'specDigest ignores generated_at/source_state');

  const changed = clone(spec);
  changed.title = 'another title';
  assert.notEqual(specDigest(changed), digest);

  const overlay = evidenceOverlay(spec, [
    { id: 'ann:note-1', kind: 'note', target_ref: null, text: 'x', position: samplePosition() },
  ]);
  const overlayValue = overlayDigest(overlay);
  assert.match(overlayValue, /^[0-9a-f]{64}$/u);
  const overlayVolatile = { ...clone(overlay), updated_at: '2026-01-01T00:00:00.000Z' };
  assert.equal(overlayDigest(overlayVolatile), overlayValue, 'overlayDigest ignores updated_at');
  const overlayChanged = { ...clone(overlay) };
  overlayChanged.items[0].text = 'y';
  assert.notEqual(overlayDigest(overlayChanged), overlayValue);

  const manifest = sampleManifest();
  assert.match(manifestDigest(manifest), /^[0-9a-f]{64}$/u);
  assert.equal(manifestDigest(clone(manifest)), manifestDigest(manifest));
  assert.notEqual(manifestDigest({ ...clone(manifest), source_state: 'current' }), manifestDigest(manifest));

  const version = sampleDocumentVersion();
  assert.match(documentVersionDigest(version), /^[0-9a-f]{64}$/u);
  assert.equal(documentVersionDigest(clone(version)), documentVersionDigest(version));
  assert.notEqual(documentVersionDigest({ ...clone(version), generation: 1 }), documentVersionDigest(version));
});

test('digests: invalid input throws a stable DiagramError code', () => {
  assertThrowsCode(() => specDigest({}), 'INVALID_SPEC');
  assertThrowsCode(() => specDigest(null), 'INVALID_SPEC');
  assertThrowsCode(() => overlayDigest({}), 'INVALID_OVERLAY');
  assertThrowsCode(() => manifestDigest({}), 'INVALID_MANIFEST');
  assertThrowsCode(() => documentVersionDigest({}), 'INVALID_INPUT');
});

/* ------------------------------------------------------------------------- *
 * Constructors and helpers
 * ------------------------------------------------------------------------- */

test('emptyOverlay: binds diagram id and spec digest, revision 0, injected timestamp', () => {
  const spec = evidenceSpec();
  const overlay = emptyOverlay({ diagram_id: spec.diagram_id, base_spec_digest: specDigest(spec), now: CLOCK });
  assert.deepEqual(overlay, {
    schema_version: 1,
    diagram_id: spec.diagram_id,
    base_spec_digest: specDigest(spec),
    revision: 0,
    items: [],
    orphaned_annotations: [],
    updated_at: CLOCK_TIME,
  });
  assert.equal(validateOverlay(overlay).ok, true);
  assertThrowsCode(() => emptyOverlay({ diagram_id: 'bad id', base_spec_digest: specDigest(spec) }), 'INVALID_INPUT');
  assertThrowsCode(() => emptyOverlay({ diagram_id: 'diagram:x', base_spec_digest: 'nope' }), 'INVALID_INPUT');
  assertThrowsCode(() => emptyOverlay({ diagram_id: 'diagram:x', base_spec_digest: specDigest(spec), now: 'not-a-time' }), 'INVALID_INPUT');
});

test('text/id helpers: plain text, control characters, length and id charset', () => {
  assert.equal(text('普通文本\t\nwith tabs', 32), '普通文本\t\nwith tabs');
  assert.equal(text('x'.repeat(LIMITS.label), LIMITS.label).length, LIMITS.label);
  assertThrowsCode(() => text('x'.repeat(LIMITS.label + 1), LIMITS.label), 'INVALID_INPUT');
  assertThrowsCode(() => text('a\u0000b', 10), 'INVALID_INPUT');
  assertThrowsCode(() => text('a\u007fb', 10), 'INVALID_INPUT');
  assertThrowsCode(() => text(5, 10), 'INVALID_INPUT');

  assert.equal(id('svc:main'), 'svc:main');
  assert.equal(id('local:0123456789abcdef'), 'local:0123456789abcdef');
  assertThrowsCode(() => id(''), 'INVALID_INPUT');
  assertThrowsCode(() => id('bad id'), 'INVALID_INPUT');
  assertThrowsCode(() => id('bad<id>'), 'INVALID_INPUT');
  assertThrowsCode(() => id(`a${'b'.repeat(LIMITS.node_id_length)}`, LIMITS.node_id_length), 'INVALID_INPUT');

  assert.equal(utcTimestamp(CLOCK_TIME), CLOCK_TIME);
  assertThrowsCode(() => utcTimestamp('2026-11-07'), 'INVALID_INPUT');
  assert.equal(sha256HexValue(HEX_A), HEX_A);
  assertThrowsCode(() => sha256HexValue(HEX_A.toUpperCase()), 'INVALID_INPUT');
  assert.ok(PATTERNS.timestamp.length > 0);
});

/* ------------------------------------------------------------------------- *
 * Other contract artifacts
 * ------------------------------------------------------------------------- */

test('artifact manifest: strict validation, path traversal and remote modes rejected', () => {
  const manifest = sampleManifest();
  assert.equal(validateManifest(manifest).ok, true, JSON.stringify(validateManifest(manifest).errors ?? []));
  assertInvalid(validateManifest({ ...clone(manifest), extra: true }), 'additionalProperties');
  assertInvalid(validateManifest({ ...clone(manifest), network_mode: 'online' }), 'const');
  assertInvalid(validateManifest({ ...clone(manifest), spec_digest: 'ABC' }), 'pattern');
  const traversal = clone(manifest);
  traversal.files[0].relative_path = '../escape.html';
  assertInvalid(validateManifest(traversal), 'pattern');
  const absolute = clone(manifest);
  absolute.files[0].relative_path = 'C:/escape.html';
  assertInvalid(validateManifest(absolute), 'pattern');
  const tooBig = clone(manifest);
  tooBig.files[0].size = LIMITS.package_bytes + 1;
  assertInvalid(validateManifest(tooBig), 'maximum');
  const emptyFiles = clone(manifest);
  emptyFiles.files = [];
  assertInvalid(validateManifest(emptyFiles), 'minItems');
  const badSourceDigest = clone(manifest);
  badSourceDigest.source_digests = [{ source_id: 's1', digest: 'short' }];
  assertInvalid(validateManifest(badSourceDigest), 'pattern');
});

test('document version, access registry, editor model: strict shapes', () => {
  const version = sampleDocumentVersion();
  assert.equal(validateDocumentVersion(version).ok, true);
  assertInvalid(validateDocumentVersion({ ...clone(version), content_sha256: 'zz' }), 'pattern');
  assertInvalid(validateDocumentVersion({ ...clone(version), extra: 1 }), 'additionalProperties');
  assertInvalid(validateDocumentVersion({ ...clone(version), byte_length: LIMITS.document_xml_bytes + 1 }), 'maximum');

  const registry = { schema_version: 1, revision: 0, contexts: [], documents: [], output_roots: [] };
  assert.equal(validateAccessRegistry(registry).ok, true);
  const registryEntry = {
    ...clone(registry),
    documents: [
      {
        document_ref: 'docref:1',
        document_id: 'doc:1',
        scope_ref: 'ws:demo',
        scope_generation: 0,
        path_identity_digest: 'path:1',
        mode: 'edit',
        active: true,
      },
    ],
  };
  assert.equal(validateAccessRegistry(registryEntry).ok, true);
  assertInvalid(validateAccessRegistry({ ...clone(registryEntry), documents: [{ ...registryEntry.documents[0], mode: 'write' }] }), 'enum');
  assertInvalid(validateAccessRegistry({ ...clone(registryEntry), documents: [{ ...registryEntry.documents[0], extra: 1 }] }), 'additionalProperties');

  const spec = conceptualSpec();
  const overlay = emptyOverlay({ diagram_id: spec.diagram_id, base_spec_digest: specDigest(spec), now: CLOCK_TIME });
  const model = {
    schema_version: 1,
    base_spec_digest: specDigest(spec),
    overlay,
    selection: [],
    draft_revision: 0,
    dirty: false,
  };
  assert.equal(validateEditorModel(model).ok, true);
  assertInvalid(validateEditorModel({ ...clone(model), draft_revision: -1 }), 'minimum');
  assertInvalid(validateEditorModel({ ...clone(model), overlay: { bogus: true } }), 'additionalProperties');
});

test('rpc request/response: closed shell, fixed status union and reason-code format', () => {
  const request = {
    schema_version: 1,
    operation_id: 'op:1',
    context_ref: 'ctx:1',
    expected_scope_generation: 0,
    view_epoch: 0,
    input: { document_ref: 'docref:1' },
  };
  assert.equal(validateRpcRequest(request).ok, true);
  assertInvalid(validateRpcRequest({ ...clone(request), extra: 1 }), 'additionalProperties');
  assertInvalid(validateRpcRequest({ ...clone(request), input: 'raw' }), 'type');

  const ok = {
    schema_version: 1,
    operation_id: 'op:1',
    view_epoch: 0,
    scope_generation: 0,
    status: 'ok',
    data: { document_id: 'doc:1' },
  };
  assert.equal(validateRpcResponse(ok).ok, true, JSON.stringify(validateRpcResponse(ok).errors ?? []));
  const conflict = {
    schema_version: 1,
    operation_id: 'op:1',
    view_epoch: 0,
    scope_generation: 0,
    status: 'conflict',
    reason_code: 'STALE_VERSION',
    data: { current_version: sampleDocumentVersion(), draft_ref: 'draft:1' },
  };
  assert.equal(validateRpcResponse(conflict).ok, true, JSON.stringify(validateRpcResponse(conflict).errors ?? []));
  assertInvalid(validateRpcResponse({ ...clone(conflict), status: 'cancelled' }), 'oneOf');
  assertInvalid(validateRpcResponse({ ...clone(conflict), reason_code: 'stale_version' }), 'oneOf');
  assertInvalid(validateRpcResponse({ ...clone(conflict), data: { current_version: sampleDocumentVersion(), real_path: 'C:/secret' } }), 'oneOf');
  const failed = {
    schema_version: 1,
    operation_id: 'op:1',
    view_epoch: 0,
    scope_generation: 0,
    status: 'failed',
    reason_code: 'FAILED',
  };
  assert.equal(validateRpcResponse(failed).ok, true, 'any closed status variant must be representable');
});

test('editor command union: exactly the ten design kinds, closed payloads', () => {
  const position = samplePosition();
  const commands = [
    { kind: 'move_node', payload: { node_id: 'svc:main', x: 1, y: -2 } },
    { kind: 'set_note', payload: { annotation_id: 'ann:note-1', target_ref: null, text: 'text', position } },
    { kind: 'add_annotation_node', payload: { id: 'ann:node-1', label: 'node', description: null, position } },
    { kind: 'set_annotation_node', payload: { id: 'ann:node-1', label: 'node2', description: 'd' } },
    { kind: 'add_annotation_edge', payload: { id: 'ann:edge-1', from: 'a', to: 'b', label: 'edge', description: null } },
    { kind: 'remove_annotation', payload: { id: 'ann:note-1' } },
    { kind: 'remove_annotation_node', payload: { node_id: 'ann:node-1' } },
    { kind: 'set_visibility', payload: { target_ref: 'svc:main', hidden: true } },
    { kind: 'undo', payload: {} },
    { kind: 'redo', payload: {} },
  ];
  assert.deepEqual(
    EDITOR_COMMAND_KIND_LIST,
    commands.map((entry) => entry.kind),
    'exported command kind order must match the schema union',
  );
  for (const [index, command] of commands.entries()) {
    const value = { command_id: `cmd:${index}`, expected_draft_revision: 0, ...command };
    const result = validateEditorCommand(value);
    assert.equal(result.ok, true, `${command.kind}: ${JSON.stringify(result.errors ?? [])}`);
  }
  assertInvalid(
    validateEditorCommand({ command_id: 'cmd:x', expected_draft_revision: 0, kind: 'add_annotation_edge_x', payload: {} }),
    'oneOf',
  );
  assertInvalid(
    validateEditorCommand({ command_id: 'cmd:x', expected_draft_revision: 0, kind: 'undo', payload: { nested: true } }),
    'oneOf',
  );
  assertInvalid(
    validateEditorCommand({ command_id: 'cmd:x', expected_draft_revision: 0, kind: 'move_node', payload: { node_id: 'n', x: 1, y: 2, width: 3 } }),
    'oneOf',
  );
  assertInvalid(validateEditorCommand({ expected_draft_revision: 0, kind: 'undo', payload: {} }), 'oneOf');
});

test('source-lock schema: accepts the project source-lock.json and rejects malformed locks', () => {
  const lock = readJson('source-lock.json');
  const result = validateSourceLock(lock);
  assert.equal(result.ok, true, JSON.stringify(result.errors ?? []));
  const missing = clone(lock);
  delete missing.sources[0].adopted_files;
  assertInvalid(validateSourceLock(missing), 'required');
  const extra = clone(lock);
  extra.unexpected = true;
  assertInvalid(validateSourceLock(extra), 'additionalProperties');
  const badEnv = clone(lock);
  badEnv.commands = [{ id: 'run:1', executable_ref: 'node', args_template: [], env_fixed: { N: 1 } }];
  assertInvalid(validateSourceLock(badEnv), 'type');
});

test('source identity and evidence ref schemas: direct positive/negative cases', () => {
  assert.equal(validateSourceIdentity(sourceIdentity).ok, true);
  assertInvalid(validateSourceIdentity({ ...clone(sourceIdentity), repos: 'nope' }), 'type');
  assertInvalid(validateSourceIdentity({ ...clone(sourceIdentity), extra: 1 }), 'additionalProperties');

  const reference = evidenceSubset.nodes[0].evidence_refs[0];
  assert.equal(validateEvidenceRef(reference).ok, true);
  assertInvalid(validateEvidenceRef({ ...clone(reference), kind: 'guess' }), 'enum');
  assertInvalid(validateEvidenceRef({ ...clone(reference), line_start: 0 }), 'minimum');
  assertInvalid(validateEvidenceRef({ ...clone(reference), path_ref: 'a\u0000b' }), 'not');
});
