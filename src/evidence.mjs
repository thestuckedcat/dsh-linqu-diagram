/**
 * 06 local diagrams — evidence subset / conceptual input -> canonical DiagramSpecV1.
 *
 * Rules (DIA-DESIGN-2 §4, tests/evidence.test.mjs):
 * - per-edge certainty is preserved edge by edge;
 * - `reference` is never upgraded to `call`, and no edge ever gains evidence it
 *   did not receive;
 * - evidence-origin edges require locked evidence_refs; `exact` additionally
 *   may not exceed the source level of its evidence (`policy.max_certainty_by_evidence`);
 * - annotation/manual edges are origin=annotation, certainty=unknown, no evidence;
 * - conceptual diagrams have empty sources and only annotation/unknown edges;
 * - `coverage.complete` is always false; truncation is explicit and counted;
 * - missing entity ids derive deterministic `local:` ids from label + scope;
 * - generation is deterministic: clock and limits are injectable, no I/O, no network.
 */
import { validateSchema } from './schema.mjs';
import { canonicalJson, sha256Hex } from './canonical.mjs';
import { LIMITS, CODES } from './limits.mjs';
import { DiagramError, fail } from './errors.mjs';
import {
  PATTERNS,
  SCHEMAS,
  text,
  id,
  rendererRefValue,
  validateDiagramSpec,
  validateSourceIdentity,
} from './contracts.mjs';
import { validateSource } from './source-state.mjs';

const DEFAULT_RENDERER_REF = 'builtin:renderer-v1';
const NODE_KINDS = Object.freeze(['module', 'function', 'type', 'resource', 'note']);
const EDGE_KINDS = Object.freeze(['call', 'reference', 'data', 'ownership', 'control', 'annotation']);
const EVIDENCE_KINDS = new Set(['compiler', 'source', 'runtime', 'user']);
const CERTAINTY_RANK = Object.freeze({ unknown: 0, unresolved: 1, may: 2, exact: 3 });
const RANK_TO_CERTAINTY = Object.freeze({ 0: 'unknown', 1: 'unresolved', 2: 'may', 3: 'exact' });
/** Default: only compiler evidence can establish `exact`; every other evidence kind caps at `may`. */
const DEFAULT_MAX_CERTAINTY_BY_EVIDENCE = Object.freeze({ compiler: 'exact' });
const TIMESTAMP_REGEX = new RegExp(PATTERNS.timestamp, 'u');
const CONTROL_CHARS_PATTERN = PATTERNS.control_chars;

/* ------------------------------------------------------------------------- *
 * Local schema fragments (evidence-subset / conceptual input are adapter
 * inputs, not shipped contract artifacts; they reuse the authoritative
 * evidence_ref / source_identity bodies from SCHEMAS).
 * ------------------------------------------------------------------------- */

const { $schema: _evidenceRefUri, ...EVIDENCE_REF_BODY } = SCHEMAS.evidence_ref;
const { $schema: _sourceIdentityUri, ...SOURCE_IDENTITY_BODY } = SCHEMAS.source_identity;

/** @param {number} maxLength @param {number} [minLength] */
function localTextSchema(maxLength, minLength = 0) {
  return { type: 'string', minLength, maxLength, not: { pattern: CONTROL_CHARS_PATTERN } };
}

/** @param {number} maxLength @param {number} [minLength] */
function localNullableTextSchema(maxLength, minLength = 0) {
  return {
    anyOf: [{ type: 'null' }, { type: 'string', minLength, maxLength, not: { pattern: CONTROL_CHARS_PATTERN } }],
  };
}

/** @param {number} [maxLength] */
function localIdSchema(maxLength = 128) {
  return { type: 'string', minLength: 1, maxLength, pattern: PATTERNS.id };
}

const EVIDENCE_NODE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'kind'],
  properties: {
    id: localIdSchema(LIMITS.node_id_length),
    label: localTextSchema(LIMITS.label),
    kind: { enum: [...NODE_KINDS] },
    description: localNullableTextSchema(LIMITS.description),
    evidence_refs: { type: 'array', minItems: 0, items: EVIDENCE_REF_BODY },
  },
};

const EVIDENCE_EDGE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'kind', 'label'],
  properties: {
    id: localIdSchema(LIMITS.edge_id_length),
    from: localIdSchema(LIMITS.node_id_length),
    to: localIdSchema(LIMITS.node_id_length),
    kind: { enum: [...EDGE_KINDS] },
    certainty: { enum: ['exact', 'may', 'unresolved', 'unknown'] },
    label: localTextSchema(LIMITS.label),
    evidence_refs: { type: 'array', minItems: 0, items: EVIDENCE_REF_BODY },
    explanation: localNullableTextSchema(LIMITS.explanation),
  },
};

const EVIDENCE_COVERAGE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    truncated: { type: 'boolean' },
    omitted_nodes: { type: 'integer', minimum: 0 },
    omitted_edges: { type: 'integer', minimum: 0 },
    unresolved_count: { type: 'integer', minimum: 0 },
    notes: {
      type: 'array',
      minItems: 0,
      maxItems: LIMITS.coverage_notes,
      items: localTextSchema(LIMITS.coverage_notes_length),
    },
  },
};

const EVIDENCE_SUBSET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['nodes', 'edges'],
  properties: {
    atlas_version: localTextSchema(128, 1),
    nodes: { type: 'array', minItems: 0, items: EVIDENCE_NODE_INPUT_SCHEMA },
    edges: { type: 'array', minItems: 0, items: EVIDENCE_EDGE_INPUT_SCHEMA },
    coverage: EVIDENCE_COVERAGE_INPUT_SCHEMA,
  },
};

const CONCEPTUAL_NODE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'kind'],
  properties: {
    id: localIdSchema(LIMITS.node_id_length),
    label: localTextSchema(LIMITS.label),
    kind: { enum: [...NODE_KINDS] },
  },
};

const CONCEPTUAL_EDGE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'kind', 'label'],
  properties: {
    id: localIdSchema(LIMITS.edge_id_length),
    from: localIdSchema(LIMITS.node_id_length),
    to: localIdSchema(LIMITS.node_id_length),
    kind: { enum: [...EDGE_KINDS] },
    label: localTextSchema(LIMITS.label),
    description: localNullableTextSchema(LIMITS.description),
  },
};

const CONCEPTUAL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'scope_ref'],
  properties: {
    title: localTextSchema(LIMITS.title, 1),
    scope_ref: localTextSchema(LIMITS.scope_ref, 1),
    nodes: { type: 'array', minItems: 0, items: CONCEPTUAL_NODE_INPUT_SCHEMA },
    edges: { type: 'array', minItems: 0, items: CONCEPTUAL_EDGE_INPUT_SCHEMA },
  },
};

const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source_identity: SOURCE_IDENTITY_BODY,
    evidence_subset: EVIDENCE_SUBSET_SCHEMA,
    conceptual_input: CONCEPTUAL_INPUT_SCHEMA,
    // Extension: registered current identities used to derive spec.source_state.
    // Missing/undefined means source_state=unknown (never guessed).
    current_identities: {
      anyOf: [SOURCE_IDENTITY_BODY, { type: 'array', minItems: 0, maxItems: LIMITS.sources, items: SOURCE_IDENTITY_BODY }],
    },
  },
};

/* ------------------------------------------------------------------------- *
 * Policy helpers
 * ------------------------------------------------------------------------- */

/**
 * @param {unknown} policy
 * @returns {Record<string, any>}
 */
function normalizePolicy(policy) {
  if (policy === undefined || policy === null) return {};
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    fail(CODES.INVALID_INPUT, 'policy must be a plain object');
  }
  return /** @type {Record<string, any>} */ (policy);
}

/**
 * @param {Record<string, any>} policy
 * @returns {Record<string, any>}
 */
function resolveLimits(policy) {
  const overrides = policy.limits;
  if (overrides !== undefined && (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))) {
    fail(CODES.INVALID_INPUT, 'policy.limits must be a plain object');
  }
  /** @type {Record<string, any>} */
  const limits = { ...LIMITS };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!Object.prototype.hasOwnProperty.call(LIMITS, key)) {
        fail(CODES.INVALID_INPUT, `policy.limits.${key} is not a known resource limit`);
      }
      const base = LIMITS[key];
      if (typeof base === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) {
          fail(CODES.INVALID_INPUT, `policy.limits.${key} must be a non-negative safe integer`);
        }
        limits[key] = value;
      } else if (value !== base) {
        fail(CODES.INVALID_INPUT, `policy.limits.${key} is not overridable`);
      }
    }
  }
  return limits;
}

/** @param {Record<string, any>} policy */
function clockNow(policy) {
  const clock = policy.clock ?? (() => new Date().toISOString());
  if (typeof clock !== 'function') fail(CODES.INVALID_INPUT, 'policy.clock must be a function');
  const value = clock();
  if (typeof value !== 'string' || !TIMESTAMP_REGEX.test(value)) {
    fail(CODES.INVALID_INPUT, 'policy.clock must return a UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
  }
  return value;
}

/** @param {Record<string, any>} policy */
function resolveDirection(policy) {
  const direction = policy.direction ?? 'LR';
  if (direction !== 'LR' && direction !== 'TB') fail(CODES.INVALID_INPUT, 'policy.direction must be LR or TB');
  return direction;
}

/** @param {Record<string, any>} policy */
function resolveRevision(policy) {
  const revision = policy.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    fail(CODES.INVALID_INPUT, 'policy.revision must be a non-negative safe integer');
  }
  return revision;
}

/**
 * Default renderer ref (`builtin:renderer-v1`) or an injected one.
 * @param {Record<string, any>} [policy]
 * @returns {string}
 */
export function rendererRef(policy = {}) {
  const normalized = normalizePolicy(policy);
  if (normalized.renderer_ref === undefined || normalized.renderer_ref === null) return DEFAULT_RENDERER_REF;
  return rendererRefValue(normalized.renderer_ref);
}

function resolveDiagramId(mode, scopeRef, title, nodes, edges, policy) {
  if (policy.diagram_id !== undefined && policy.diagram_id !== null) {
    return id(policy.diagram_id, 128, 'policy.diagram_id');
  }
  const seed = {
    mode,
    scope_ref: scopeRef,
    title,
    nodes: nodes.map((node) => node.id),
    edges: edges.map((edge) => edge.id),
  };
  return `diagram:${sha256Hex(canonicalJson(seed)).slice(0, 16)}`;
}

/**
 * @param {{scope_ref: string, label: string}} parts
 * @param {Set<string>} used
 */
function deriveLocalNodeId(parts, used) {
  return deriveLocalId({ scope_ref: parts.scope_ref, label: parts.label }, used);
}

/**
 * @param {{scope_ref: string, from: string, to: string, kind: string, evidence_ids: string[]}} parts
 * @param {Set<string>} used
 */
function deriveLocalEdgeId(parts, used) {
  return deriveLocalId(
    {
      scope_ref: parts.scope_ref,
      from: parts.from,
      to: parts.to,
      kind: parts.kind,
      evidence_ids: [...parts.evidence_ids].sort(),
    },
    used,
  );
}

/**
 * Deterministic `local:` id; never claims a stable code entity.
 * @param {Record<string, unknown>} parts
 * @param {Set<string>} used
 */
function deriveLocalId(parts, used) {
  const base = `local:${sha256Hex(canonicalJson(parts)).slice(0, 16)}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}~${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Evidence-level certainty ceiling for one edge.
 * @param {string} declared
 * @param {any[]} refs
 * @param {Record<string, any>} policy
 */
function clampCertainty(declared, refs, policy) {
  const map = { ...DEFAULT_MAX_CERTAINTY_BY_EVIDENCE };
  const overrides = policy.max_certainty_by_evidence;
  if (overrides !== undefined && overrides !== null) {
    if (typeof overrides !== 'object' || Array.isArray(overrides)) {
      fail(CODES.INVALID_INPUT, 'policy.max_certainty_by_evidence must be a plain object');
    }
    for (const [kind, level] of Object.entries(overrides)) {
      if (!EVIDENCE_KINDS.has(kind)) {
        fail(CODES.INVALID_INPUT, `policy.max_certainty_by_evidence has unknown evidence kind ${JSON.stringify(kind)}`);
      }
      if (typeof level !== 'string' || !Object.prototype.hasOwnProperty.call(CERTAINTY_RANK, level)) {
        fail(CODES.INVALID_INPUT, `policy.max_certainty_by_evidence.${kind} must be a certainty level`);
      }
      map[kind] = level;
    }
  }
  let capRank = CERTAINTY_RANK.unknown;
  for (const ref of refs) {
    const level = map[ref.kind] ?? 'may';
    capRank = Math.max(capRank, CERTAINTY_RANK[level]);
  }
  const effectiveRank = Math.min(CERTAINTY_RANK[declared], capRank);
  if (effectiveRank < CERTAINTY_RANK.unresolved) {
    fail(CODES.INVALID_INPUT, 'evidence certainty ceiling fell below unresolved; use an annotation edge for unknown relations');
  }
  return RANK_TO_CERTAINTY[effectiveRank];
}

/* ------------------------------------------------------------------------- *
 * Mapping helpers
 * ------------------------------------------------------------------------- */

/**
 * @param {any} refs
 * @param {any} identity
 * @param {Record<string, any>} limits
 * @param {string} path
 */
function mapEvidenceRefs(refs, identity, limits, path) {
  const list = refs ?? [];
  if (list.length > limits.evidence_refs_per_entity) {
    fail(CODES.LIMIT_EXCEEDED, `${path} exceeds the evidence_refs_per_entity limit (${limits.evidence_refs_per_entity})`);
  }
  const repoIds = new Set(identity.repos.map((repo) => repo.repo_id));
  return list.map((ref, index) => {
    const refPath = `${path}[${index}]`;
    if (ref.source_id !== identity.source_id) {
      fail(CODES.INVALID_INPUT, `${refPath}.source_id must equal the declared source_identity.source_id`);
    }
    if (!repoIds.has(ref.repo_id)) {
      fail(CODES.INVALID_INPUT, `${refPath}.repo_id is not declared by source_identity.repos`);
    }
    if (ref.line_end < ref.line_start) {
      fail(CODES.INVALID_INPUT, `${refPath}.line_end must not be smaller than line_start`);
    }
    return {
      evidence_id: ref.evidence_id,
      source_id: ref.source_id,
      repo_id: ref.repo_id,
      path_ref: ref.path_ref,
      content_digest: ref.content_digest,
      line_start: ref.line_start,
      line_end: ref.line_end,
      kind: ref.kind,
    };
  });
}

/** @param {any} identity */
function copySourceIdentity(identity) {
  return {
    source_id: identity.source_id,
    scope_ref: identity.scope_ref,
    snapshot_ref: identity.snapshot_ref,
    repos: identity.repos.map((repo) => ({
      repo_id: repo.repo_id,
      root_ref: repo.root_ref,
      revision: repo.revision,
      dirty_digest: repo.dirty_digest,
      build_variant: repo.build_variant,
      arch: repo.arch,
      compdb_digest: repo.compdb_digest,
      generated_headers_digest: repo.generated_headers_digest,
    })),
    evidence_manifest_digest: identity.evidence_manifest_digest,
  };
}

/**
 * @param {string[]} inputNotes
 * @param {string[]} extraNotes
 * @param {Record<string, any>} limits
 * @returns {string[]}
 */
function mergeCoverageNotes(inputNotes, extraNotes, limits) {
  const validatedExtras = extraNotes.map((note) => text(note, limits.coverage_notes_length, 'coverage note'));
  const max = limits.coverage_notes;
  const room = Math.max(0, max - validatedExtras.length);
  const validatedInput = inputNotes.map((note) => text(note, limits.coverage_notes_length, 'coverage note'));
  const keptInput = validatedInput.slice(0, room);
  const merged = [...keptInput, ...validatedExtras];
  return merged.slice(0, max);
}

function defaultEvidenceTitle(scopeRef, limits) {
  const prefix = 'Evidence diagram: ';
  const prefixLength = [...prefix].length;
  const scope = [...String(scopeRef)].slice(0, Math.max(0, limits.title - prefixLength)).join('');
  const title = `${prefix}${scope}`;
  return title.length > 0 ? title : 'Evidence diagram';
}

function conceptualCoverageNote() {
  return 'conceptual diagram: sources empty; every edge is annotation/unknown, not compiler evidence';
}

/* ------------------------------------------------------------------------- *
 * Spec builders
 * ------------------------------------------------------------------------- */

/**
 * @param {any} input validated toDiagram input
 * @param {Record<string, any>} policy
 * @returns {any} DiagramSpecV1
 */
function buildEvidenceSpec(input, policy) {
  const limits = resolveLimits(policy);
  const subset = input.evidence_subset;
  const identityResult = validateSourceIdentity(input.source_identity);
  if (!identityResult.ok) {
    fail(CODES.INVALID_INPUT, 'source_identity is invalid', { errors: prefixIssues(identityResult.errors, '$.source_identity') });
  }
  const identity = identityResult.value;
  const scopeRef = text(identity.scope_ref, limits.scope_ref, 'source_identity.scope_ref');

  const allNodes = subset.nodes;
  const allEdges = subset.edges;
  const truncate = policy.truncate === true;

  if (allNodes.length > limits.nodes && !truncate) {
    fail(CODES.LIMIT_EXCEEDED, `evidence_subset.nodes (${allNodes.length}) exceeds the limit ${limits.nodes}; reduce scope or pass policy.truncate=true`);
  }
  if (allEdges.length > limits.edges && !truncate) {
    fail(CODES.LIMIT_EXCEEDED, `evidence_subset.edges (${allEdges.length}) exceeds the limit ${limits.edges}; reduce scope or pass policy.truncate=true`);
  }
  const keptInputNodes = allNodes.slice(0, Math.min(allNodes.length, limits.nodes));
  const omittedInputNodes = allNodes.slice(keptInputNodes.length);
  const omittedInputNodeIds = new Set(omittedInputNodes.filter((node) => node.id !== undefined).map((node) => node.id));

  /** @type {Set<string>} */
  const usedIds = new Set();
  /** @type {Map<string, string>} */
  const inputNodeIdToOutputId = new Map();

  for (const [index, node] of keptInputNodes.entries()) {
    if (node.id === undefined) continue;
    const resolved = id(node.id, limits.node_id_length, `nodes[${index}].id`);
    if (usedIds.has(resolved)) fail(CODES.INVALID_INPUT, `duplicate node id ${JSON.stringify(resolved)}`);
    usedIds.add(resolved);
    inputNodeIdToOutputId.set(node.id, resolved);
  }
  for (const [index, edge] of allEdges.entries()) {
    if (edge.id === undefined) continue;
    const resolved = id(edge.id, limits.edge_id_length, `edges[${index}].id`);
    if (usedIds.has(resolved)) fail(CODES.INVALID_INPUT, `duplicate document entity id ${JSON.stringify(resolved)}`);
    usedIds.add(resolved);
  }

  const nodes = keptInputNodes.map((node, index) => {
    const resolvedId =
      node.id !== undefined ? inputNodeIdToOutputId.get(node.id) : deriveLocalNodeId({ scope_ref: scopeRef, label: node.label }, usedIds);
    const refs = mapEvidenceRefs(node.evidence_refs, identity, limits, `nodes[${index}].evidence_refs`);
    if (node.kind === 'note' && refs.length > 0) {
      fail(CODES.INVALID_INPUT, `nodes[${index}] is kind=note and must not carry evidence_refs`);
    }
    const label = text(node.label, limits.label, `nodes[${index}].label`);
    const description =
      node.description === undefined || node.description === null
        ? null
        : text(node.description, limits.description, `nodes[${index}].description`);
    return {
      id: /** @type {string} */ (resolvedId),
      label,
      kind: node.kind,
      origin: refs.length > 0 ? 'evidence' : 'annotation',
      evidence_refs: refs,
      description,
    };
  });

  const mappedEdges = [];
  for (const [index, edge] of allEdges.entries()) {
    const from = inputNodeIdToOutputId.get(edge.from);
    const to = inputNodeIdToOutputId.get(edge.to);
    if (from === undefined || to === undefined) {
      const omitted = omittedInputNodeIds.has(edge.from) || omittedInputNodeIds.has(edge.to);
      if (omitted) continue;
      fail(CODES.INVALID_INPUT, `edges[${index}] endpoints must reference declared nodes`);
    }
    const refs = mapEvidenceRefs(edge.evidence_refs, identity, limits, `edges[${index}].evidence_refs`);
    let certainty;
    let origin;
    if (edge.kind === 'annotation') {
      if (refs.length > 0) fail(CODES.INVALID_INPUT, `edges[${index}] is kind=annotation and must not carry evidence_refs`);
      if (edge.certainty !== undefined && edge.certainty !== 'unknown') {
        fail(CODES.INVALID_INPUT, `edges[${index}] is kind=annotation and must have certainty=unknown`);
      }
      certainty = 'unknown';
      origin = 'annotation';
    } else {
      if (refs.length === 0) {
        fail(CODES.INVALID_INPUT, `edges[${index}] kind=${JSON.stringify(edge.kind)} claims an evidence relation but has no evidence_refs`);
      }
      if (edge.certainty === undefined || edge.certainty === 'unknown') {
        fail(CODES.INVALID_INPUT, `edges[${index}] evidence edges require certainty exact|may|unresolved`);
      }
      certainty = clampCertainty(edge.certainty, refs, policy);
      origin = 'evidence';
    }
    const label = text(edge.label, limits.label, `edges[${index}].label`);
    const explanation =
      edge.explanation === undefined || edge.explanation === null
        ? null
        : text(edge.explanation, limits.explanation, `edges[${index}].explanation`);
    const resolvedEdgeId =
      edge.id !== undefined
        ? id(edge.id, limits.edge_id_length, `edges[${index}].id`)
        : deriveLocalEdgeId(
            { scope_ref: scopeRef, from, to, kind: edge.kind, evidence_ids: refs.map((ref) => ref.evidence_id) },
            usedIds,
          );
    mappedEdges.push({
      id: /** @type {string} */ (resolvedEdgeId),
      from,
      to,
      kind: edge.kind,
      certainty,
      origin,
      label,
      evidence_refs: refs,
      explanation,
    });
  }

  const keptEdges = mappedEdges.slice(0, Math.min(mappedEdges.length, limits.edges));
  const omittedEdges = allEdges.length - keptEdges.length;
  const truncated = keptInputNodes.length < allNodes.length || keptEdges.length < allEdges.length || subset.coverage?.truncated === true;
  const notes = [];
  if (subset.atlas_version !== undefined) notes.push(`evidence subset producer: ${subset.atlas_version}`);
  if (truncated) notes.push('input exceeded diagram limits and was explicitly truncated (policy.truncate=true)');
  const inputCoverage = subset.coverage ?? {};
  const coverage = {
    complete: /** @type {const} */ (false),
    truncated,
    omitted_nodes: (inputCoverage.omitted_nodes ?? 0) + omittedInputNodes.length,
    omitted_edges: (inputCoverage.omitted_edges ?? 0) + omittedEdges,
    unresolved_count: keptEdges.filter((edge) => edge.certainty === 'unresolved').length,
    notes: mergeCoverageNotes(inputCoverage.notes ?? [], notes, limits),
  };

  const title = policy.title === undefined || policy.title === null
    ? defaultEvidenceTitle(scopeRef, limits)
    : text(policy.title, limits.title, 'policy.title');

  const spec = {
    schema_version: /** @type {const} */ (1),
    diagram_id: resolveDiagramId('evidence', scopeRef, title, nodes, keptEdges, policy),
    revision: resolveRevision(policy),
    mode: /** @type {const} */ ('evidence'),
    title,
    scope_ref: scopeRef,
    sources: [copySourceIdentity(identity)],
    nodes,
    edges: keptEdges,
    layout: { algorithm: /** @type {const} */ ('layered_v1'), direction: resolveDirection(policy), positions: [] },
    coverage,
    source_state: /** @type {const} */ ('unknown'),
    generated_at: clockNow(policy),
    renderer_ref: rendererRef(policy),
  };
  spec.source_state = resolveSourceState(spec, input, policy);
  return spec;
}

/**
 * @param {any} conceptual validated conceptual input
 * @param {Record<string, any>} policy
 * @returns {any} DiagramSpecV1
 */
function buildConceptualSpec(conceptual, policy) {
  const limits = resolveLimits(policy);
  const title = text(conceptual.title, limits.title, 'conceptual_input.title');
  const scopeRef = text(conceptual.scope_ref, limits.scope_ref, 'conceptual_input.scope_ref');
  const allNodes = conceptual.nodes ?? [];
  const allEdges = conceptual.edges ?? [];
  const truncate = policy.truncate === true;

  if (allNodes.length > limits.nodes && !truncate) {
    fail(CODES.LIMIT_EXCEEDED, `conceptual_input.nodes exceeds the limit ${limits.nodes}; reduce scope or pass policy.truncate=true`);
  }
  if (allEdges.length > limits.edges && !truncate) {
    fail(CODES.LIMIT_EXCEEDED, `conceptual_input.edges exceeds the limit ${limits.edges}; reduce scope or pass policy.truncate=true`);
  }
  const keptInputNodes = allNodes.slice(0, Math.min(allNodes.length, limits.nodes));
  const omittedInputNodes = allNodes.slice(keptInputNodes.length);
  const omittedInputNodeIds = new Set(omittedInputNodes.filter((node) => node.id !== undefined).map((node) => node.id));

  const usedIds = new Set();
  const inputNodeIdToOutputId = new Map();
  for (const [index, node] of keptInputNodes.entries()) {
    if (node.id === undefined) continue;
    const resolved = id(node.id, limits.node_id_length, `conceptual_input.nodes[${index}].id`);
    if (usedIds.has(resolved)) fail(CODES.INVALID_INPUT, `duplicate node id ${JSON.stringify(resolved)}`);
    usedIds.add(resolved);
    inputNodeIdToOutputId.set(node.id, resolved);
  }
  for (const [index, edge] of allEdges.entries()) {
    if (edge.id === undefined) continue;
    const resolved = id(edge.id, limits.edge_id_length, `conceptual_input.edges[${index}].id`);
    if (usedIds.has(resolved)) fail(CODES.INVALID_INPUT, `duplicate document entity id ${JSON.stringify(resolved)}`);
    usedIds.add(resolved);
  }

  const nodes = keptInputNodes.map((node, index) => {
    const resolvedId =
      node.id !== undefined
        ? inputNodeIdToOutputId.get(node.id)
        : deriveLocalNodeId({ scope_ref: scopeRef, label: node.label }, usedIds);
    return {
      id: /** @type {string} */ (resolvedId),
      label: text(node.label, limits.label, `conceptual_input.nodes[${index}].label`),
      kind: node.kind,
      origin: /** @type {const} */ ('annotation'),
      evidence_refs: [],
      description: null,
    };
  });

  const mappedEdges = [];
  for (const [index, edge] of allEdges.entries()) {
    const from = inputNodeIdToOutputId.get(edge.from);
    const to = inputNodeIdToOutputId.get(edge.to);
    if (from === undefined || to === undefined) {
      const omitted = omittedInputNodeIds.has(edge.from) || omittedInputNodeIds.has(edge.to);
      if (omitted) continue;
      fail(CODES.INVALID_INPUT, `conceptual_input.edges[${index}] endpoints must reference declared nodes`);
    }
    const resolvedEdgeId =
      edge.id !== undefined
        ? id(edge.id, limits.edge_id_length, `conceptual_input.edges[${index}].id`)
        : deriveLocalEdgeId({ scope_ref: scopeRef, from, to, kind: edge.kind, evidence_ids: [] }, usedIds);
    mappedEdges.push({
      id: /** @type {string} */ (resolvedEdgeId),
      from: /** @type {string} */ (from),
      to: /** @type {string} */ (to),
      kind: edge.kind,
      certainty: /** @type {const} */ ('unknown'),
      origin: /** @type {const} */ ('annotation'),
      label: text(edge.label, limits.label, `conceptual_input.edges[${index}].label`),
      evidence_refs: [],
      explanation:
        edge.description === undefined || edge.description === null
          ? null
          : text(edge.description, limits.description, `conceptual_input.edges[${index}].description`),
    });
  }

  const keptEdges = mappedEdges.slice(0, Math.min(mappedEdges.length, limits.edges));
  const omittedEdges = allEdges.length - keptEdges.length;
  const truncated = keptInputNodes.length < allNodes.length || keptEdges.length < allEdges.length;
  const notes = [conceptualCoverageNote()];
  if (truncated) notes.push('input exceeded diagram limits and was explicitly truncated (policy.truncate=true)');

  return {
    schema_version: /** @type {const} */ (1),
    diagram_id: resolveDiagramId('conceptual', scopeRef, title, nodes, keptEdges, policy),
    revision: resolveRevision(policy),
    mode: /** @type {const} */ ('conceptual'),
    title,
    scope_ref: scopeRef,
    sources: [],
    nodes,
    edges: keptEdges,
    layout: { algorithm: /** @type {const} */ ('layered_v1'), direction: resolveDirection(policy), positions: [] },
    coverage: {
      complete: /** @type {const} */ (false),
      truncated,
      omitted_nodes: omittedInputNodes.length,
      omitted_edges: omittedEdges,
      unresolved_count: 0,
      notes: mergeCoverageNotes([], notes, limits),
    },
    source_state: /** @type {const} */ ('unknown'),
    generated_at: clockNow(policy),
    renderer_ref: rendererRef(policy),
  };
}

/* ------------------------------------------------------------------------- *
 * Public API (docs/interfaces.md §2)
 * ------------------------------------------------------------------------- */

/**
 * @param {{path?: string, keyword?: string, message?: string}[]} issues
 * @param {string} prefix
 */
function prefixIssues(issues, prefix) {
  return issues.map((entry) => ({ ...entry, path: `${prefix}${(entry.path ?? '$').replace(/^\$/, '')}` }));
}

/**
 * @param {string} code
 * @param {string} path
 * @param {string} keyword
 * @param {string} message
 */
function invalidResult(code, path, keyword, message) {
  return { status: /** @type {const} */ ('invalid'), code, errors: [{ path, keyword, message }] };
}

/**
 * Derive `source_state` from registered current identities; missing identities
 * always mean `unknown` (never guessed, never a runtime verification claim).
 * @param {any} spec
 * @param {any} input
 * @param {Record<string, any>} policy
 */
function resolveSourceState(spec, input, policy) {
  const identities = input.current_identities !== undefined ? input.current_identities : policy.current_identities;
  if (identities === undefined || identities === null) return 'unknown';
  try {
    return validateSource(spec, identities).state;
  } catch {
    return 'unknown';
  }
}

/**
 * Convert an Atlas-style evidence subset or an explicit conceptual input into a
 * canonical DiagramSpecV1.
 *
 * @param {{source_identity?: any, evidence_subset?: any, conceptual_input?: any, current_identities?: any}} input
 * @param {Record<string, any>} [policy] injectable `clock`, `limits`, `truncate`,
 *   `direction`, `revision`, `title`, `diagram_id`, `renderer_ref`,
 *   `max_certainty_by_evidence`, `current_identities`
 * @returns {{status:'ok', spec:any} | {status:'invalid', code:string, errors?:any[]}}
 */
export function toDiagram(input, policy = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return invalidResult(CODES.INVALID_INPUT, '$', 'type', 'input must be an object');
  }
  const normalizedPolicy = normalizePolicy(policy);
  const schemaIssues = validateSchema(INPUT_SCHEMA, input);
  if (schemaIssues.length > 0) {
    return { status: /** @type {const} */ ('invalid'), code: CODES.INVALID_INPUT, errors: schemaIssues };
  }
  const hasEvidence = input.evidence_subset !== undefined;
  const hasConceptual = input.conceptual_input !== undefined;
  if (hasEvidence && hasConceptual) {
    return invalidResult(CODES.INVALID_INPUT, '$', 'ambiguous_input', 'provide either evidence_subset or conceptual_input, not both');
  }
  if (!hasEvidence && !hasConceptual) {
    return invalidResult(CODES.INVALID_INPUT, '$', 'missing_input', 'one of evidence_subset or conceptual_input is required');
  }
  try {
    let spec;
    if (hasEvidence) {
      if (input.source_identity === undefined) {
        return invalidResult(CODES.INVALID_INPUT, '$.source_identity', 'required', 'evidence mode requires source_identity');
      }
      spec = buildEvidenceSpec(input, normalizedPolicy);
    } else {
      spec = buildConceptualSpec(input.conceptual_input, normalizedPolicy);
    }
    const check = validateDiagramSpec(spec);
    if (!check.ok) {
      return { status: /** @type {const} */ ('invalid'), code: CODES.INVALID_SPEC, errors: check.errors };
    }
    return { status: /** @type {const} */ ('ok'), spec };
  } catch (error) {
    if (error instanceof DiagramError) {
      const details = error.details && Array.isArray(error.details.errors) ? error.details.errors : null;
      return {
        status: /** @type {const} */ ('invalid'),
        code: error.code,
        errors: details ?? [{ path: '$', keyword: 'invalid_input', message: error.message }],
      };
    }
    throw error;
  }
}

/**
 * Build a conceptual DiagramSpecV1 with no evidence sources. With no
 * `nodes`/`edges` this is the empty conceptual base used together with an
 * imported annotation overlay; with nodes/edges it is a plain conceptual
 * diagram. Throws a stable DiagramError on invalid input.
 *
 * @param {any} [input] `{title, scope_ref, nodes?, edges?}`
 * @param {Record<string, any>} [policy]
 * @returns {any} DiagramSpecV1
 */
export function emptyConceptualSpec(input = {}, policy = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(CODES.INVALID_INPUT, 'conceptual input must be an object');
  }
  const normalizedPolicy = normalizePolicy(policy);
  const issues = validateSchema(CONCEPTUAL_INPUT_SCHEMA, input);
  if (issues.length > 0) fail(CODES.INVALID_INPUT, 'invalid conceptual input', { errors: issues });
  const spec = buildConceptualSpec(input, normalizedPolicy);
  const check = validateDiagramSpec(spec);
  if (!check.ok) fail(CODES.INVALID_SPEC, 'constructed conceptual spec failed validation', { errors: check.errors });
  return spec;
}
