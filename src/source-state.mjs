/**
 * 06 local diagrams — source state: current / stale / unknown (DIA-02).
 *
 * `current` only means the registered source identity stored with the diagram
 * still equals the currently registered identity. It never means the code
 * relationships were verified at runtime, and this module never touches the
 * filesystem or a repository: all current identities are injected.
 *
 * Compared fields (docs/software-design.md §6):
 * - source_id / scope_ref / snapshot_ref;
 * - evidence_manifest_digest;
 * - per repo: revision, dirty_digest, build_variant, arch, compdb_digest,
 *   generated_headers_digest.
 *
 * A missing or malformed current identity yields `unknown`, never `current`;
 * any difference yields `stale` with stable `changed_refs` and `reasons`.
 */
import { validateSchema } from './schema.mjs';
import { SCHEMAS, validateDiagramSpec } from './contracts.mjs';

/** Per-repo identity fields whose change makes a generated diagram stale. */
const COMPARED_REPO_FIELDS = Object.freeze([
  'revision',
  'dirty_digest',
  'build_variant',
  'arch',
  'compdb_digest',
  'generated_headers_digest',
]);

const NOT_RUNTIME_VERIFIED =
  'registered snapshot identity matches the diagram source; static identity check only, not a runtime verification';

/**
 * Compare one known (generated-time) source identity with one current identity.
 *
 * @param {unknown} known
 * @param {unknown} current
 * @returns {{equal:boolean, changed_refs:string[], reasons:string[]}}
 */
export function compareIdentity(known, current) {
  const knownIssues = validateSchema(SCHEMAS.source_identity, known);
  if (knownIssues.length > 0) {
    return { equal: false, changed_refs: [], reasons: ['known source identity is not a valid SourceIdentityV1'] };
  }
  const currentIssues = validateSchema(SCHEMAS.source_identity, current);
  if (currentIssues.length > 0) {
    return { equal: false, changed_refs: [], reasons: ['current source identity is not a valid SourceIdentityV1'] };
  }
  const knownValue = /** @type {any} */ (known);
  const currentValue = /** @type {any} */ (current);
  const changed = new Set();
  const reasons = [];

  const compareScalar = (field) => {
    if (knownValue[field] !== currentValue[field]) {
      changed.add(field);
      reasons.push(`${field} differs from the registered value`);
    }
  };
  compareScalar('source_id');
  compareScalar('scope_ref');
  compareScalar('snapshot_ref');
  compareScalar('evidence_manifest_digest');

  const knownRepos = new Map(knownValue.repos.map((repo) => [repo.repo_id, repo]));
  const currentRepos = new Map(currentValue.repos.map((repo) => [repo.repo_id, repo]));
  for (const repoId of [...knownRepos.keys()].sort()) {
    const before = /** @type {any} */ (knownRepos.get(repoId));
    const after = /** @type {any} */ (currentRepos.get(repoId));
    if (after === undefined) {
      changed.add(`repos.${repoId}`);
      reasons.push(`repo ${repoId} is missing from the current identity`);
      continue;
    }
    for (const field of COMPARED_REPO_FIELDS) {
      if (before[field] !== after[field]) {
        changed.add(`repos.${repoId}.${field}`);
        reasons.push(`${field} differs for repo ${repoId}`);
      }
    }
  }
  for (const repoId of [...currentRepos.keys()].sort()) {
    if (!knownRepos.has(repoId)) {
      changed.add(`repos.${repoId}`);
      reasons.push(`repo ${repoId} is not part of the generated identity`);
    }
  }

  const changedRefs = [...changed].sort();
  return { equal: changedRefs.length === 0, changed_refs: changedRefs, reasons };
}

/**
 * Normalize the injected current identities. Accepted shapes: a single
 * SourceIdentityV1, an array of them, or a map {source_id: identity}.
 *
 * @param {unknown} input
 * @returns {{list:any[], invalid:string[], missing:boolean}}
 */
function normalizeCurrentIdentities(input) {
  if (input === undefined || input === null) return { list: [], invalid: [], missing: true };
  const entries = [];
  if (Array.isArray(input)) {
    entries.push(...input);
  } else if (typeof input === 'object' && typeof (/** @type {any} */ (input).source_id) === 'string') {
    entries.push(input);
  } else if (typeof input === 'object') {
    for (const value of Object.values(/** @type {Record<string, unknown>} */ (input))) entries.push(value);
  } else {
    return { list: [], invalid: ['<non-object>'], missing: false };
  }
  const list = [];
  const invalid = [];
  for (const entry of entries) {
    const issues = validateSchema(SCHEMAS.source_identity, entry);
    if (issues.length === 0) {
      list.push(entry);
    } else {
      const sourceId = entry && typeof entry === 'object' && typeof (/** @type {any} */ (entry).source_id) === 'string'
        ? /** @type {any} */ (entry).source_id
        : '<invalid>';
      invalid.push(sourceId);
    }
  }
  return { list, invalid, missing: false };
}

/**
 * Determine the state of the source identities referenced by a DiagramSpecV1
 * against the currently registered identities.
 *
 * @param {unknown} spec
 * @param {unknown} currentIdentities single identity, array, or map (injected; never read from disk here)
 * @returns {{state:'current'|'stale'|'unknown', changed_refs:string[], reasons:string[]}}
 */
export function validateSource(spec, currentIdentities) {
  const specResult = validateDiagramSpec(spec);
  if (!specResult.ok) {
    return {
      state: 'unknown',
      changed_refs: [],
      reasons: ['diagram spec is invalid; source state cannot be determined'],
    };
  }
  const specValue = /** @type {any} */ (specResult.value);
  /** @type {Set<string>} */
  const changed = new Set();
  /** @type {string[]} */
  const reasons = [];

  if (specValue.sources.length === 0) {
    return {
      state: 'unknown',
      changed_refs: [],
      reasons: ['diagram has no source identities to compare (conceptual diagram)'],
    };
  }

  const normalized = normalizeCurrentIdentities(currentIdentities);
  const currentById = new Map();
  for (const identity of normalized.list) {
    if (!currentById.has(identity.source_id)) currentById.set(identity.source_id, identity);
  }
  let missing = normalized.missing;
  let notComparable = false;

  for (const known of specValue.sources) {
    const current = currentById.get(known.source_id);
    if (current === undefined) {
      missing = true;
      reasons.push(`no current identity registered for source ${known.source_id}`);
      continue;
    }
    const result = compareIdentity(known, current);
    for (const ref of result.changed_refs) changed.add(ref);
    for (const reason of result.reasons) {
      reasons.push(specValue.sources.length > 1 ? `[${known.source_id}] ${reason}` : reason);
    }
    if (result.reasons.some((reason) => reason.includes('not a valid SourceIdentityV1'))) notComparable = true;
  }
  for (const invalidSourceId of normalized.invalid) {
    const matchesKnown = specValue.sources.some((source) => source.source_id === invalidSourceId);
    if (matchesKnown || invalidSourceId === '<invalid>' || invalidSourceId === '<non-object>') {
      notComparable = true;
      reasons.push(`current identity for source ${invalidSourceId} is not a valid SourceIdentityV1`);
    }
  }

  const changedRefs = [...changed].sort();
  if (missing || notComparable) {
    return { state: 'unknown', changed_refs: changedRefs, reasons };
  }
  if (changedRefs.length > 0) {
    return { state: 'stale', changed_refs: changedRefs, reasons };
  }
  return { state: 'current', changed_refs: [], reasons: [NOT_RUNTIME_VERIFIED] };
}
