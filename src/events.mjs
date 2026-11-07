/**
 * 03 fact-event consumption for 06 (DIA-10).
 *
 * The v1 event contract is frozen by docs/references/development-contract.md
 * (§身份、状态与证据): `{schema_version:1, event_id, kind, source_capability,
 * scope_ref, session_ref?, operation_id, generation, affected_refs, outcome,
 * before_snapshot?, after_snapshot?, occurred_at}` with
 * kind in session_surface_rewound|workspace_files_restored|session_removed and
 * outcome in completed|partial|outcome_unknown.
 *
 * Rules implemented here (design §6):
 * - dedupe by event_id; a generation jump re-checks local identity and must not
 *   be guessed as current, so it yields `unknown`;
 * - workspace_files_restored intersecting a declared repo makes source_state stale;
 * - session_surface_rewound does not invalidate an independent code snapshot but
 *   marks annotations that came from the rewound conversation as needing review;
 * - session_removed clears the session association only and never deletes an
 *   independent artifact;
 * - outcome partial/outcome_unknown keeps stale/unknown; a missing
 *   after_snapshot cannot be guessed into current.
 *
 * This module is deliberately local and synchronous: it never reads repos,
 * never verifies runtime behaviour, and never upgrades certainty.
 */
import { validateSchema } from './schema.mjs';
import { LIMITS } from './limits.mjs';
import { rootRefIdentity } from './source-identity.mjs';

const EVENT_KINDS = Object.freeze(['session_surface_rewound', 'workspace_files_restored', 'session_removed']);
const OUTCOMES = Object.freeze(['completed', 'partial', 'outcome_unknown']);

const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'event_id', 'kind', 'source_capability', 'scope_ref', 'operation_id', 'generation', 'affected_refs', 'outcome', 'occurred_at'],
  properties: {
    schema_version: { const: 1 },
    event_id: { type: 'string', minLength: 1, maxLength: LIMITS.label },
    kind: { enum: [...EVENT_KINDS] },
    source_capability: { const: '03' },
    scope_ref: { type: 'string', minLength: 1, maxLength: LIMITS.scope_ref },
    session_ref: { type: 'string', minLength: 1, maxLength: LIMITS.snapshot_ref },
    operation_id: { type: 'string', minLength: 1, maxLength: LIMITS.rpc_operation_id_length },
    generation: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    affected_refs: { type: 'array', maxItems: 256, items: { type: 'string', minLength: 1, maxLength: LIMITS.scope_ref } },
    outcome: { enum: [...OUTCOMES] },
    before_snapshot: { type: ['string', 'null'], maxLength: LIMITS.snapshot_ref },
    after_snapshot: { type: ['string', 'null'], maxLength: LIMITS.snapshot_ref },
    occurred_at: { type: 'string', minLength: 20, maxLength: 40, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$' },
  },
};

/**
 * Strictly validate one 03 fact event.
 * @param {unknown} value
 * @returns {{ok:true, value:object}|{ok:false, errors:object[]}}
 */
export function validateFactEvent(value) {
  const errors = validateSchema(EVENT_SCHEMA, value, '$');
  return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

/**
 * Fresh local consumption state. Callers persist it next to their own registry;
 * it only records dedupe/generation/applied reasons, never event bodies.
 * @returns {{schema_version:1, consumed_event_ids:string[], last_generation:number|null, reasons:string[]}}
 */
export function createInteropState() {
  return Object.freeze({ schema_version: 1, consumed_event_ids: [], last_generation: null, reasons: [] });
}

/**
 * @param {{source_state?:string}} spec
 * @param {string} next
 * @returns {string}
 */
function stricterState(current, next) {
  if (current === 'stale' || next === 'stale') return 'stale';
  if (current === 'unknown' || next === 'unknown') return 'unknown';
  return 'current';
}

/**
 * Apply one 03 fact event to a generated DiagramSpec plus local consumption state.
 *
 * The returned spec is a new object whose `source_state` may be downgraded
 * (never upgraded); facts, layout and overlay are untouched. `action` is one of
 * `applied`, `duplicate`, `noted`, `gap`, `unknown`, `ignored`.
 *
 * @param {object} spec validated DiagramSpecV1 (or a plain object with scope_ref, sources, source_state)
 * @param {unknown} event
 * @param {object} [state] createInteropState() result
 * @returns {{ok:true, spec:object, state:object, action:string, reasons:string[]}|{ok:false, code:string, errors?:object[]}}
 */
export function applyFactEvent(spec, event, state = createInteropState()) {
  const checked = validateFactEvent(event);
  if (!checked.ok) return { ok: false, code: 'INVALID_INPUT', errors: checked.errors };
  const validSpec = spec !== null && typeof spec === 'object' ? spec : null;
  if (validSpec === null) return { ok: false, code: 'INVALID_SPEC' };
  const consumedIds = Array.isArray(state.consumed_event_ids) ? state.consumed_event_ids : [];
  if (consumedIds.includes(event.event_id)) {
    return { ok: true, spec: validSpec, state, action: 'duplicate', reasons: ['duplicate event_id ignored'] };
  }

  const reasons = [];
  let sourceState = typeof validSpec.source_state === 'string' ? validSpec.source_state : 'unknown';
  let action = 'noted';

  if (state.last_generation !== null && event.generation > state.last_generation + 1) {
    sourceState = stricterState(sourceState, 'unknown');
    action = 'gap';
    reasons.push(`event generation gap ${state.last_generation}->${event.generation}; local identity must be re-checked, not assumed current`);
  }

  const sameScope = event.scope_ref === validSpec.scope_ref;
  const repos = Array.isArray(validSpec.sources)
    ? validSpec.sources.flatMap((source) => (Array.isArray(source?.repos) ? source.repos : []))
    : [];
  const affected = event.affected_refs.filter((ref) =>
    repos.some(
      (repo) =>
        repo?.repo_id === ref ||
        repo?.root_ref === ref ||
        // Spec root refs are opaque digests; accept a raw registered root too.
        (typeof repo?.repo_id === 'string' && repo.root_ref === rootRefIdentity(validSpec.scope_ref, repo.repo_id, ref)),
    ));
  const intersects = sameScope && affected.length > 0;

  if (event.kind === 'workspace_files_restored') {
    if (intersects) {
      if (event.after_snapshot === undefined || event.after_snapshot === null) {
        sourceState = stricterState(sourceState, 'unknown');
        action = 'unknown';
        reasons.push('workspace_files_restored intersects a declared repo but carries no after_snapshot; cannot guess current');
      } else {
        sourceState = stricterState(sourceState, 'stale');
        action = action === 'gap' ? 'gap' : 'applied';
        reasons.push(`workspace_files_restored affects ${affected.join(', ')}; source_state stale`);
      }
    } else {
      reasons.push('workspace_files_restored does not intersect this diagram scope');
    }
  } else if (event.kind === 'session_surface_rewound') {
    // The independent code snapshot is not invalidated by a chat-surface rewind.
    reasons.push('session_surface_rewound: independent code snapshot unchanged; annotations sourced from the rewound conversation need review');
  } else if (event.kind === 'session_removed') {
    reasons.push('session_removed: session association cleared; independent artifact retained');
  }

  if (event.outcome !== 'completed') {
    sourceState = stricterState(sourceState, 'unknown');
    if (action === 'applied' || action === 'noted') action = 'unknown';
    reasons.push(`event outcome ${event.outcome}: stale/unknown is kept, never promoted to current`);
  }

  const nextSpec = sourceState === validSpec.source_state ? validSpec : { ...validSpec, source_state: sourceState };
  const nextState = Object.freeze({
    schema_version: 1,
    consumed_event_ids: [...consumedIds, event.event_id].slice(-512),
    last_generation: state.last_generation === null ? event.generation : Math.max(state.last_generation, event.generation),
    reasons: [...(Array.isArray(state.reasons) ? state.reasons : []), ...reasons].slice(-256),
  });
  return { ok: true, spec: nextSpec, state: nextState, action, reasons };
}

/**
 * Stable non-secret artifact reference for 04 learning records / 08 navigation.
 * It carries identity, never XML bodies or paths.
 * @param {{artifact_id:string, diagram_id:string, manifest_digest?:string}} artifact
 * @returns {string}
 */
export function artifactRefFor(artifact) {
  if (artifact === null || typeof artifact !== 'object') throw new TypeError('artifact required');
  const artifactId = String(artifact.artifact_id ?? '');
  const diagramId = String(artifact.diagram_id ?? '');
  if (artifactId === '' || diagramId === '') throw new TypeError('artifact_id and diagram_id required');
  return `diagram-artifact:${diagramId}:${artifactId}`;
}
