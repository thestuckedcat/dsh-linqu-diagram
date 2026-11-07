/**
 * Evidence adapter tests: Atlas-style evidence subset -> DiagramSpecV1 (DIA-01).
 *
 * The negative cases come first in spirit: a relation without locked evidence
 * must never become evidence, a reference must never become a call, manual
 * edges stay annotation/unknown, conceptual diagrams never claim evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../src/canonical.mjs';
import { LIMITS } from '../src/limits.mjs';
import { DiagramError } from '../src/errors.mjs';
import { specDigest, validateDiagramSpec } from '../src/contracts.mjs';
import { toDiagram, emptyConceptualSpec, rendererRef } from '../src/evidence.mjs';

const CLOCK_TIME = '2026-11-07T00:00:00.000Z';
const CLOCK = () => CLOCK_TIME;
const OTHER_CLOCK = () => '2026-01-01T00:00:00.000Z';

const readJson = (relative) => JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const sourceIdentity = readJson('tests/fixtures/snapshot/source-identity.json');
const currentIdentities = readJson('tests/fixtures/snapshot/current-identities.json');
const staleIdentities = readJson('tests/fixtures/snapshot/stale-identities.json');
const evidenceSubset = readJson('tests/fixtures/snapshot/evidence-subset.json');
const conceptualInput = readJson('tests/fixtures/conceptual/input.json');

const SOURCE_REF = Object.freeze({
  evidence_id: 'ev-source-1',
  source_id: 'local-atlas-synthetic',
  repo_id: 'repo-svc',
  path_ref: 'src/main.c',
  content_digest: 'sha256:aaa111',
  line_start: 10,
  line_end: 12,
  kind: 'source',
});
const COMPILER_REF = Object.freeze({ ...SOURCE_REF, evidence_id: 'ev-compiler-1', kind: 'compiler' });

function okSpec(input, policy = {}) {
  const result = toDiagram(input, { clock: CLOCK, ...policy });
  assert.equal(result.status, 'ok', `expected ok, got ${JSON.stringify(result)}`);
  return result.spec;
}

function invalid(input, policy = {}) {
  const result = toDiagram(input, { clock: CLOCK, ...policy });
  assert.notEqual(result.status, 'ok', `expected invalid, got status=${result.status}`);
  assert.equal(typeof result.code, 'string');
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, 'invalid results must carry structured errors');
  return result;
}

function assertThrowsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DiagramError, 'expected DiagramError');
    assert.equal(error.code, code);
    return true;
  });
}

/** @param {any[]} nodes @param {any[]} [edges] */
function subsetOf(nodes, edges = []) {
  return { nodes, edges };
}

function evidenceSpec(policy = {}) {
  return okSpec({ source_identity: sourceIdentity, evidence_subset: evidenceSubset }, policy);
}

/* ------------------------------------------------------------------------- *
 * Core evidence mapping
 * ------------------------------------------------------------------------- */

test('evidence fixture: four edge classes survive into a valid spec', () => {
  const spec = evidenceSpec();
  assert.equal(spec.mode, 'evidence');
  assert.equal(spec.sources.length, 1);
  assert.deepEqual(spec.sources[0], sourceIdentity);
  assert.equal(validateDiagramSpec(spec).ok, true, JSON.stringify(validateDiagramSpec(spec).errors ?? []));
  assert.equal(spec.nodes.length, 5);
  assert.equal(spec.edges.length, 4);
  assert.equal(spec.revision, 0);
  assert.equal(spec.generated_at, CLOCK_TIME);
  assert.equal(spec.renderer_ref, 'builtin:renderer-v1');
  assert.equal(spec.source_state, 'unknown');
  assert.match(spec.diagram_id, /^diagram:[0-9a-f]{16}$/u);
  assert.equal(spec.coverage.complete, false);
  assert.equal(spec.coverage.truncated, false);
  assert.equal(spec.coverage.omitted_nodes, 0);
  assert.equal(spec.coverage.omitted_edges, 0);
  assert.equal(spec.coverage.unresolved_count, 1);
  assert.ok(spec.coverage.notes.some((note) => note.includes('sdk-code-atlas')));
});

test('evidence fixture: certainty, origin and kind are preserved per edge', () => {
  const spec = evidenceSpec();
  const byId = new Map(spec.edges.map((edge) => [edge.id, edge]));

  const exact = byId.get('edge:exact-call');
  assert.equal(exact.certainty, 'exact');
  assert.equal(exact.origin, 'evidence');
  assert.equal(exact.kind, 'call');
  assert.equal(exact.evidence_refs.length, 1);

  const may = byId.get('edge:may-call');
  assert.equal(may.certainty, 'may');
  assert.equal(may.origin, 'evidence');

  const unresolved = byId.get('edge:unresolved');
  assert.equal(unresolved.certainty, 'unresolved');
  assert.equal(unresolved.origin, 'evidence');
  assert.equal(unresolved.kind, 'reference');

  const annotation = byId.get('edge:annotation-review');
  assert.equal(annotation.certainty, 'unknown');
  assert.equal(annotation.origin, 'annotation');
  assert.equal(annotation.kind, 'annotation');
  assert.deepEqual(annotation.evidence_refs, []);

  const byNode = new Map(spec.nodes.map((node) => [node.id, node]));
  assert.equal(byNode.get('svc:main').origin, 'evidence');
  assert.equal(byNode.get('svc:unknown-sink').origin, 'annotation', 'explicit unknown node has no evidence');
  assert.equal(byNode.get('note:review').origin, 'annotation');
  assert.equal(byNode.get('note:review').kind, 'note');
});

test('a reference edge is never upgraded to call', () => {
  const fixtureUnresolved = evidenceSpec().edges.find((edge) => edge.certainty === 'unresolved');
  assert.equal(fixtureUnresolved.kind, 'reference');
  assert.notEqual(fixtureUnresolved.kind, 'call');

  const spec = okSpec({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf(
      [
        { id: 'a', label: 'a', kind: 'function', evidence_refs: [SOURCE_REF] },
        { id: 'b', label: 'b', kind: 'function', evidence_refs: [] },
      ],
      [
        {
          id: 'edge:ref',
          from: 'a',
          to: 'b',
          kind: 'reference',
          certainty: 'exact',
          label: 'references',
          evidence_refs: [COMPILER_REF],
          explanation: null,
        },
      ],
    ),
  });
  assert.equal(spec.edges[0].kind, 'reference');
  assert.equal(spec.edges[0].certainty, 'exact');
});

test('an exact evidence edge without evidence_refs is rejected (DIA-01 negative case)', () => {
  const broken = clone(evidenceSubset);
  const exactIndex = broken.edges.findIndex((edge) => edge.certainty === 'exact');
  broken.edges[exactIndex].evidence_refs = [];
  const result = invalid({ source_identity: sourceIdentity, evidence_subset: broken });
  assert.equal(result.code, 'INVALID_INPUT');
  assert.ok(result.errors.some((entry) => entry.message.includes('evidence_refs')));
});

test('certainty cannot exceed the evidence source level and is never promoted', () => {
  const demote = okSpec({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf(
      [
        { id: 'a', label: 'a', kind: 'function', evidence_refs: [SOURCE_REF] },
        { id: 'b', label: 'b', kind: 'function', evidence_refs: [] },
      ],
      [{ from: 'a', to: 'b', kind: 'call', certainty: 'exact', label: 'calls', evidence_refs: [SOURCE_REF] }],
    ),
  });
  assert.equal(demote.edges[0].certainty, 'may', 'source evidence cannot establish exact');

  const noPromotion = okSpec({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf(
      [
        { id: 'a', label: 'a', kind: 'function', evidence_refs: [SOURCE_REF] },
        { id: 'b', label: 'b', kind: 'function', evidence_refs: [] },
      ],
      [{ from: 'a', to: 'b', kind: 'call', certainty: 'may', label: 'may call', evidence_refs: [COMPILER_REF] }],
    ),
  });
  assert.equal(noPromotion.edges[0].certainty, 'may', 'compiler evidence must not promote a may claim');

  const overrideUp = evidenceSpec({ max_certainty_by_evidence: { source: 'exact' } });
  const overrideEdge = clone(evidenceSubset);
  overrideEdge.edges[0].evidence_refs[0].kind = 'source';
  overrideEdge.edges[0].certainty = 'exact';
  const overridden = okSpec(
    { source_identity: sourceIdentity, evidence_subset: overrideEdge },
    { max_certainty_by_evidence: { source: 'exact' } },
  );
  assert.equal(overridden.edges[0].certainty, 'exact', 'policy may explicitly allow a higher source level');
  assert.equal(overrideUp.edges.find((edge) => edge.id === 'edge:exact-call').certainty, 'exact');

  const overrideDown = evidenceSpec({ max_certainty_by_evidence: { compiler: 'may' } });
  assert.equal(overrideDown.edges.find((edge) => edge.id === 'edge:exact-call').certainty, 'may');

  const unresolved = okSpec({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf(
      [
        { id: 'a', label: 'a', kind: 'function', evidence_refs: [SOURCE_REF] },
        { id: 'b', label: 'b', kind: 'function', evidence_refs: [] },
      ],
      [{ from: 'a', to: 'b', kind: 'reference', certainty: 'unresolved', label: 'ref', evidence_refs: [COMPILER_REF] }],
    ),
  });
  assert.equal(unresolved.edges[0].certainty, 'unresolved', 'unresolved is never promoted');

  invalid(
    { source_identity: sourceIdentity, evidence_subset: evidenceSubset },
    { max_certainty_by_evidence: { guess: 'exact' } },
  );
  invalid(
    { source_identity: sourceIdentity, evidence_subset: evidenceSubset },
    { max_certainty_by_evidence: { source: 'sometimes' } },
  );
});

test('evidence edges require evidence; note nodes and annotation edges cannot carry it', () => {
  const twoNodes = [
    { id: 'a', label: 'a', kind: 'function', evidence_refs: [] },
    { id: 'b', label: 'b', kind: 'function', evidence_refs: [] },
  ];

  const noEvidence = invalid({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf(twoNodes, [{ from: 'a', to: 'b', kind: 'call', certainty: 'exact', label: 'calls' }]),
  });
  assert.equal(noEvidence.code, 'INVALID_INPUT');
  assert.ok(noEvidence.errors.some((entry) => entry.message.includes('evidence_refs')));

  const noteWithEvidence = invalid({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf([
      { id: 'n', label: 'note', kind: 'note', evidence_refs: [SOURCE_REF] },
      { id: 'b', label: 'b', kind: 'function', evidence_refs: [] },
    ]),
  });
  assert.equal(noteWithEvidence.code, 'INVALID_INPUT');

  const annotationWithEvidence = invalid({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf(twoNodes, [
      { from: 'a', to: 'b', kind: 'annotation', label: 'manual', evidence_refs: [SOURCE_REF] },
    ]),
  });
  assert.equal(annotationWithEvidence.code, 'INVALID_INPUT');

  const annotationCertain = invalid({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf(twoNodes, [
      { from: 'a', to: 'b', kind: 'annotation', certainty: 'exact', label: 'manual', evidence_refs: [] },
    ]),
  });
  assert.equal(annotationCertain.code, 'INVALID_INPUT');

  const annotationOk = okSpec({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf(
      [
        { id: 'a', label: 'a', kind: 'function', evidence_refs: [] },
        { id: 'b', label: 'b', kind: 'function', evidence_refs: [] },
      ],
      [{ from: 'a', to: 'b', kind: 'annotation', label: 'manual note' }],
    ),
  });
  assert.equal(annotationOk.edges[0].origin, 'annotation');
  assert.equal(annotationOk.edges[0].certainty, 'unknown');
});

test('evidence refs must belong to the declared source identity', () => {
  const foreignSource = invalid({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf([{ id: 'a', label: 'a', kind: 'function', evidence_refs: [{ ...SOURCE_REF, source_id: 'source:other' }] }]),
  });
  assert.equal(foreignSource.code, 'INVALID_INPUT');

  const foreignRepo = invalid({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf([{ id: 'a', label: 'a', kind: 'function', evidence_refs: [{ ...SOURCE_REF, repo_id: 'repo:elsewhere' }] }]),
  });
  assert.equal(foreignRepo.code, 'INVALID_INPUT');

  const reversedRange = invalid({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf([{ id: 'a', label: 'a', kind: 'function', evidence_refs: [{ ...SOURCE_REF, line_start: 5, line_end: 4 }] }]),
  });
  assert.equal(reversedRange.code, 'INVALID_INPUT');
});

/* ------------------------------------------------------------------------- *
 * Local ids
 * ------------------------------------------------------------------------- */

test('missing ids derive deterministic local: ids instead of stable code identities', () => {
  const input = {
    source_identity: sourceIdentity,
    evidence_subset: subsetOf([
      { label: 'alpha', kind: 'module', evidence_refs: [] },
      { label: 'beta', kind: 'module', evidence_refs: [] },
    ]),
  };
  const first = okSpec(input);
  const second = okSpec(input);
  assert.equal(first.nodes.length, 2);
  for (const node of first.nodes) assert.match(node.id, /^local:[0-9a-f]{16}$/u);
  assert.notEqual(first.nodes[0].id, first.nodes[1].id);
  assert.equal(canonicalJson(first), canonicalJson(second), 'two runs with the same clock must be identical');

  const conceptual = okSpec({
    conceptual_input: {
      title: 'local conceptual',
      scope_ref: 'ws:local',
      nodes: [
        { label: 'same', kind: 'module' },
        { label: 'same', kind: 'module' },
        { id: 'stable:1', label: 'stable', kind: 'module' },
      ],
      edges: [{ from: 'stable:1', to: 'stable:1', kind: 'control', label: 'self' }],
    },
  });
  const localIds = conceptual.nodes.filter((node) => node.id.startsWith('local:')).map((node) => node.id);
  assert.equal(localIds.length, 2);
  assert.notEqual(localIds[0], localIds[1], 'duplicate labels must still get distinct deterministic ids');
  assert.ok(conceptual.nodes.some((node) => node.id === 'stable:1'));
  assert.ok(conceptual.edges[0].id.startsWith('local:'), 'conceptual edges without ids also derive local ids');
});

/* ------------------------------------------------------------------------- *
 * Conceptual mode
 * ------------------------------------------------------------------------- */

test('conceptual diagram: empty sources, annotation/unknown edges only, coverage never complete', () => {
  const spec = okSpec({ conceptual_input: conceptualInput });
  assert.equal(spec.mode, 'conceptual');
  assert.deepEqual(spec.sources, []);
  assert.equal(spec.source_state, 'unknown');
  assert.equal(validateDiagramSpec(spec).ok, true, JSON.stringify(validateDiagramSpec(spec).errors ?? []));
  assert.equal(spec.coverage.complete, false);
  assert.equal(spec.coverage.unresolved_count, 0);
  assert.ok(spec.coverage.notes.some((note) => note.includes('conceptual')));
  for (const node of spec.nodes) {
    assert.equal(node.origin, 'annotation');
    assert.deepEqual(node.evidence_refs, []);
  }
  for (const edge of spec.edges) {
    assert.equal(edge.origin, 'annotation');
    assert.equal(edge.certainty, 'unknown');
    assert.deepEqual(edge.evidence_refs, []);
  }
});

test('conceptual diagram never pretends evidence: evidence-shaped fields are rejected', () => {
  const withNodeEvidence = invalid({
    conceptual_input: {
      title: 't',
      scope_ref: 'ws:x',
      nodes: [{ id: 'a', label: 'A', kind: 'module', evidence_refs: [SOURCE_REF] }],
      edges: [],
    },
  });
  assert.equal(withNodeEvidence.code, 'INVALID_INPUT');

  const withEdgeCertainty = invalid({
    conceptual_input: {
      title: 't',
      scope_ref: 'ws:x',
      nodes: [{ id: 'a', label: 'A', kind: 'module' }],
      edges: [{ from: 'a', to: 'a', kind: 'control', certainty: 'exact', label: 'x' }],
    },
  });
  assert.equal(withEdgeCertainty.code, 'INVALID_INPUT');
});

test('emptyConceptualSpec: empty conceptual base for imported overlays, deterministic id', () => {
  const base = emptyConceptualSpec({ title: '导入图', scope_ref: 'ws:import' }, { clock: CLOCK });
  assert.equal(base.mode, 'conceptual');
  assert.deepEqual(base.nodes, []);
  assert.deepEqual(base.edges, []);
  assert.deepEqual(base.sources, []);
  assert.equal(base.source_state, 'unknown');
  assert.equal(base.coverage.complete, false);
  assert.equal(validateDiagramSpec(base).ok, true);

  const again = emptyConceptualSpec({ title: '导入图', scope_ref: 'ws:import' }, { clock: CLOCK });
  assert.equal(again.diagram_id, base.diagram_id);
  const otherTitle = emptyConceptualSpec({ title: '另一张图', scope_ref: 'ws:import' }, { clock: CLOCK });
  assert.notEqual(otherTitle.diagram_id, base.diagram_id);

  const withNodes = emptyConceptualSpec(
    {
      title: 'concept',
      scope_ref: 'ws:import',
      nodes: [{ label: '入口', kind: 'module' }],
      edges: [],
    },
    { clock: CLOCK },
  );
  assert.equal(withNodes.nodes.length, 1);
  assert.match(withNodes.nodes[0].id, /^local:/u);

  assertThrowsCode(() => emptyConceptualSpec({ scope_ref: 'ws:import' }, { clock: CLOCK }), 'INVALID_INPUT');
  assertThrowsCode(() => emptyConceptualSpec(null, { clock: CLOCK }), 'INVALID_INPUT');
});

/* ------------------------------------------------------------------------- *
 * Limits and truncation
 * ------------------------------------------------------------------------- */

test('truncation: over-limit input is rejected unless policy.truncate=true records omissions', () => {
  const input = { source_identity: sourceIdentity, evidence_subset: evidenceSubset };
  const rejected = invalid(input, { limits: { nodes: 2, edges: 1 } });
  assert.equal(rejected.code, 'LIMIT_EXCEEDED');

  const truncated = okSpec(input, { truncate: true, limits: { nodes: 2, edges: 1 } });
  assert.equal(truncated.nodes.length, 2);
  assert.equal(truncated.edges.length, 1);
  assert.equal(truncated.coverage.truncated, true);
  assert.equal(truncated.coverage.complete, false);
  assert.equal(truncated.coverage.omitted_nodes, 3);
  assert.equal(truncated.coverage.omitted_edges, 3);
  assert.ok(truncated.coverage.notes.some((note) => note.includes('truncated')));
  assert.equal(validateDiagramSpec(truncated).ok, true);

  const atBoundary = okSpec(input, { limits: { nodes: 5, edges: 4 } });
  assert.equal(atBoundary.coverage.truncated, false);
  assert.equal(atBoundary.coverage.omitted_nodes, 0);
  assert.equal(atBoundary.coverage.omitted_edges, 0);
});

test('default limits: 501 nodes / 1001 edges / 65 refs are rejected with LIMIT_EXCEEDED', () => {
  const nodes = Array.from({ length: LIMITS.nodes + 1 }, (_, index) => ({
    id: `n${index}`,
    label: `n${index}`,
    kind: 'module',
    evidence_refs: [],
  }));
  const tooManyNodes = invalid({ source_identity: sourceIdentity, evidence_subset: subsetOf(nodes) });
  assert.equal(tooManyNodes.code, 'LIMIT_EXCEEDED');

  const twoNodes = [
    { id: 'a', label: 'a', kind: 'module', evidence_refs: [] },
    { id: 'b', label: 'b', kind: 'module', evidence_refs: [] },
  ];
  const edges = Array.from({ length: LIMITS.edges + 1 }, (_, index) => ({
    id: `e${index}`,
    from: 'a',
    to: 'b',
    kind: 'annotation',
    certainty: 'unknown',
    label: 'manual',
    evidence_refs: [],
  }));
  const tooManyEdges = invalid({ source_identity: sourceIdentity, evidence_subset: subsetOf(twoNodes, edges) });
  assert.equal(tooManyEdges.code, 'LIMIT_EXCEEDED');

  const tooManyRefs = invalid({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf([
      {
        id: 'a',
        label: 'a',
        kind: 'function',
        evidence_refs: Array.from({ length: LIMITS.evidence_refs_per_entity + 1 }, (_, index) => ({
          ...SOURCE_REF,
          evidence_id: `ev-${index}`,
        })),
      },
    ]),
  });
  assert.equal(tooManyRefs.code, 'LIMIT_EXCEEDED');

  const atRefLimit = okSpec({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf([
      {
        id: 'a',
        label: 'a',
        kind: 'function',
        evidence_refs: Array.from({ length: LIMITS.evidence_refs_per_entity }, (_, index) => ({
          ...SOURCE_REF,
          evidence_id: `ev-${index}`,
        })),
      },
    ]),
  });
  assert.equal(atRefLimit.nodes[0].evidence_refs.length, LIMITS.evidence_refs_per_entity);
  assert.equal(validateDiagramSpec(atRefLimit).ok, true);

  invalid({ source_identity: sourceIdentity, evidence_subset: subsetOf(tooRefs(3)) }, { limits: { evidence_refs_per_entity: 2 } });
  function tooRefs(count) {
    return [
      { id: 'a', label: 'a', kind: 'function', evidence_refs: Array.from({ length: count }, (_, index) => ({ ...SOURCE_REF, evidence_id: `ev-${index}` })) },
    ];
  }
});

test('coverage notes stay within the limit and keep the truncation note', () => {
  const notes = Array.from({ length: LIMITS.coverage_notes }, () => 'note');
  const input = {
    source_identity: sourceIdentity,
    evidence_subset: {
      ...subsetOf([
        { id: 'a', label: 'a', kind: 'module', evidence_refs: [] },
        { id: 'b', label: 'b', kind: 'module', evidence_refs: [] },
      ]),
      coverage: { notes },
    },
  };
  const spec = okSpec(input, { truncate: true, limits: { nodes: 1 } });
  assert.equal(spec.coverage.truncated, true);
  assert.equal(spec.coverage.notes.length, LIMITS.coverage_notes);
  assert.ok(spec.coverage.notes.some((note) => note.includes('truncated')));
  assert.equal(validateDiagramSpec(spec).ok, true);
});

/* ------------------------------------------------------------------------- *
 * Input strictness and state
 * ------------------------------------------------------------------------- */

test('input schema is strict: unknown fields, ambiguity and missing modes are rejected', () => {
  const both = invalid({ source_identity: sourceIdentity, evidence_subset: evidenceSubset, conceptual_input: conceptualInput });
  assert.equal(both.code, 'INVALID_INPUT');
  assert.ok(both.errors.some((entry) => entry.keyword === 'ambiguous_input'));

  const neither = invalid({ source_identity: sourceIdentity });
  assert.equal(neither.code, 'INVALID_INPUT');

  const extra = invalid({ source_identity: sourceIdentity, evidence_subset: evidenceSubset, unexpected: true });
  assert.equal(extra.code, 'INVALID_INPUT');
  assert.ok(extra.errors.some((entry) => entry.keyword === 'additionalProperties'));

  const badIdentity = invalid({ source_identity: { ...clone(sourceIdentity), snapshot_ref: undefined }, evidence_subset: evidenceSubset });
  assert.equal(badIdentity.code, 'INVALID_INPUT');

  const unknownEndpoint = invalid({
    source_identity: sourceIdentity,
    evidence_subset: subsetOf(
      [{ id: 'a', label: 'a', kind: 'module', evidence_refs: [] }],
      [{ from: 'a', to: 'missing', kind: 'annotation', label: 'x' }],
    ),
  });
  assert.equal(unknownEndpoint.code, 'INVALID_INPUT');

  const nonObject = toDiagram('nope', { clock: CLOCK });
  assert.equal(nonObject.status, 'invalid');
  assert.equal(nonObject.code, 'INVALID_INPUT');

  const emptyTitle = invalid({
    conceptual_input: { title: '', scope_ref: 'ws:x', nodes: [], edges: [] },
  });
  assert.equal(emptyTitle.code, 'INVALID_INPUT');
});

test('source_state is derived from injected current identities and never guessed', () => {
  assert.equal(evidenceSpec().source_state, 'unknown');
  assert.equal(evidenceSpec({ current_identities: currentIdentities }).source_state, 'current');
  const viaInput = okSpec({ source_identity: sourceIdentity, evidence_subset: evidenceSubset, current_identities: currentIdentities });
  assert.equal(viaInput.source_state, 'current');
  const viaArray = okSpec({ source_identity: sourceIdentity, evidence_subset: evidenceSubset, current_identities: [currentIdentities] });
  assert.equal(viaArray.source_state, 'current');
  const stale = okSpec({ source_identity: sourceIdentity, evidence_subset: evidenceSubset, current_identities: staleIdentities });
  assert.equal(stale.source_state, 'stale');
  const conceptual = okSpec({ conceptual_input: conceptualInput });
  assert.equal(conceptual.source_state, 'unknown');
});

/* ------------------------------------------------------------------------- *
 * Determinism and policy
 * ------------------------------------------------------------------------- */

test('generation is deterministic with an injectable clock', () => {
  const input = { source_identity: sourceIdentity, evidence_subset: evidenceSubset };
  const first = okSpec(input);
  const second = okSpec(input);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.generated_at, CLOCK_TIME);

  const result = toDiagram(input, { clock: OTHER_CLOCK });
  assert.equal(result.status, 'ok');
  assert.equal(result.spec.generated_at, '2026-01-01T00:00:00.000Z');
  assert.equal(specDigest(result.spec), specDigest(first), 'generated_at is not part of the base spec digest');
});

test('rendererRef: default builtin renderer, injectable override, invalid overrides rejected', () => {
  assert.equal(rendererRef(), 'builtin:renderer-v1');
  assert.equal(rendererRef({ renderer_ref: 'atlas:existing-html' }), 'atlas:existing-html');
  assertThrowsCode(() => rendererRef({ renderer_ref: 'bogus' }), 'INVALID_INPUT');
  assert.equal(evidenceSpec({ renderer_ref: 'test:renderer' }).renderer_ref, 'test:renderer');
});

test('policy: direction, revision, title and diagram_id are honored; invalid values rejected', () => {
  const spec = evidenceSpec({
    direction: 'TB',
    revision: 3,
    diagram_id: 'diagram:custom',
    title: 'My diagram',
    renderer_ref: 'test:renderer',
  });
  assert.equal(spec.layout.direction, 'TB');
  assert.equal(spec.revision, 3);
  assert.equal(spec.diagram_id, 'diagram:custom');
  assert.equal(spec.title, 'My diagram');
  assert.equal(spec.renderer_ref, 'test:renderer');
  assert.equal(validateDiagramSpec(spec).ok, true);

  assert.equal(invalid({ source_identity: sourceIdentity, evidence_subset: evidenceSubset }, { direction: 'RL' }).code, 'INVALID_INPUT');
  assert.equal(invalid({ source_identity: sourceIdentity, evidence_subset: evidenceSubset }, { revision: -1 }).code, 'INVALID_INPUT');
  assert.equal(invalid({ source_identity: sourceIdentity, evidence_subset: evidenceSubset }, { clock: () => 'not-a-time' }).code, 'INVALID_INPUT');
  assert.equal(invalid({ source_identity: sourceIdentity, evidence_subset: evidenceSubset }, { limits: { nodes: -1 } }).code, 'INVALID_INPUT');
  assert.equal(invalid({ source_identity: sourceIdentity, evidence_subset: evidenceSubset }, { limits: { no_such_limit: 1 } }).code, 'INVALID_INPUT');
});

test('toDiagram does not mutate its input', () => {
  const input = { source_identity: clone(sourceIdentity), evidence_subset: clone(evidenceSubset) };
  const before = canonicalJson(input);
  const result = toDiagram(input, { clock: CLOCK });
  assert.equal(result.status, 'ok');
  assert.equal(canonicalJson(input), before);
});
