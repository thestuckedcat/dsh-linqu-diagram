/**
 * Source-state tests: current / stale / unknown without filesystem, network or
 * runtime verification (DIA-02, docs/software-design.md §6).
 *
 * `current` means only "registered identity equals the generated-time identity";
 * missing identities are unknown, any identity difference is stale, and the
 * result never claims runtime verification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyConceptualSpec } from '../src/evidence.mjs';
import { toDiagram } from '../src/evidence.mjs';
import { validateDiagramSpec } from '../src/contracts.mjs';
import { compareIdentity, validateSource } from '../src/source-state.mjs';

const CLOCK_TIME = '2026-11-07T00:00:00.000Z';
const CLOCK = () => CLOCK_TIME;

const readJson = (relative) => JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const sourceIdentity = readJson('tests/fixtures/snapshot/source-identity.json');
const currentIdentities = readJson('tests/fixtures/snapshot/current-identities.json');
const staleIdentities = readJson('tests/fixtures/snapshot/stale-identities.json');
const evidenceSubset = readJson('tests/fixtures/snapshot/evidence-subset.json');

function evidenceSpec() {
  const result = toDiagram({ source_identity: sourceIdentity, evidence_subset: evidenceSubset }, { clock: CLOCK });
  assert.equal(result.status, 'ok', JSON.stringify(result.errors ?? []));
  return result.spec;
}

const REPO_FIELD_MUTATIONS = {
  revision: '1111111111111111111111111111111111111111',
  dirty_digest: 'dirty:changed-after-generation',
  build_variant: 'release-with-defines',
  arch: 'arm64',
  compdb_digest: 'compdb:svc:2',
  generated_headers_digest: 'genh:svc:2',
};

/* ------------------------------------------------------------------------- *
 * current
 * ------------------------------------------------------------------------- */

test('current: matching registered identity yields current with a no-runtime-verification reason', () => {
  const spec = evidenceSpec();
  const result = validateSource(spec, currentIdentities);
  assert.deepEqual(Object.keys(result).sort(), ['changed_refs', 'reasons', 'state']);
  assert.equal(result.state, 'current');
  assert.deepEqual(result.changed_refs, []);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /not a runtime verification/u);
  assert.equal('verified' in result, false);
  assert.equal('runtime_verified' in result, false);
});

test('current: stored spec.source_state does not override a fresh comparison', () => {
  const staleResult = toDiagram(
    { source_identity: sourceIdentity, evidence_subset: evidenceSubset, current_identities: staleIdentities },
    { clock: CLOCK },
  );
  assert.equal(staleResult.status, 'ok');
  assert.equal(staleResult.spec.source_state, 'stale');
  assert.equal(validateSource(staleResult.spec, currentIdentities).state, 'current');
});

test('current: single identity, array and map forms are all accepted', () => {
  const spec = evidenceSpec();
  assert.equal(validateSource(spec, currentIdentities).state, 'current');
  assert.equal(validateSource(spec, [currentIdentities]).state, 'current');
  assert.equal(validateSource(spec, { 'local-atlas-synthetic': currentIdentities }).state, 'current');
});

/* ------------------------------------------------------------------------- *
 * stale
 * ------------------------------------------------------------------------- */

test('stale: fixture tick with snapshot, manifest and dirty-digest changes is stale with changed_refs', () => {
  const spec = evidenceSpec();
  const result = validateSource(spec, staleIdentities);
  assert.equal(result.state, 'stale');
  assert.deepEqual(result.changed_refs, [
    'evidence_manifest_digest',
    'repos.repo-svc.dirty_digest',
    'snapshot_ref',
  ]);
  assert.equal(new Set(result.changed_refs).size, result.changed_refs.length);
  assert.deepEqual(result.changed_refs, [...result.changed_refs].sort());
  assert.ok(result.reasons.some((reason) => reason.includes('snapshot_ref')));
  assert.ok(result.reasons.some((reason) => reason.includes('dirty_digest')));
  assert.ok(result.reasons.some((reason) => reason.includes('evidence_manifest_digest')));
  assert.equal(Object.keys(result).sort().join(','), 'changed_refs,reasons,state');
});

test('stale: every compared per-repo field is detected individually', () => {
  const spec = evidenceSpec();
  for (const [field, value] of Object.entries(REPO_FIELD_MUTATIONS)) {
    const current = clone(currentIdentities);
    current.repos[0][field] = value;
    const unit = compareIdentity(sourceIdentity, current);
    assert.equal(unit.equal, false, `${field} must make the identity unequal`);
    assert.deepEqual(unit.changed_refs, [`repos.repo-svc.${field}`], `${field} changed_refs`);
    assert.ok(unit.reasons.some((reason) => reason.includes('repo-svc')), `${field} reason must name the repo`);

    const result = validateSource(spec, current);
    assert.equal(result.state, 'stale', `${field} must make the diagram stale`);
    assert.deepEqual(result.changed_refs, [`repos.repo-svc.${field}`]);
    assert.ok(result.reasons.some((reason) => reason.includes(field)));
  }
});

test('stale: snapshot_ref, scope_ref and evidence_manifest_digest changes are detected', () => {
  const spec = evidenceSpec();
  for (const [field, value] of Object.entries({
    snapshot_ref: 'snap-other',
    scope_ref: 'ws:other',
    evidence_manifest_digest: 'manifest:other',
  })) {
    const current = clone(currentIdentities);
    current[field] = value;
    const unit = compareIdentity(sourceIdentity, current);
    assert.equal(unit.equal, false);
    assert.deepEqual(unit.changed_refs, [field]);
    const result = validateSource(spec, current);
    assert.equal(result.state, 'stale');
    assert.deepEqual(result.changed_refs, [field]);
  }
});

test('stale: a repo missing from the current identity and an extra current repo both count', () => {
  const spec = evidenceSpec();

  const missingRepo = clone(currentIdentities);
  missingRepo.repos = [missingRepo.repos[0]];
  const missingUnit = compareIdentity(sourceIdentity, missingRepo);
  assert.equal(missingUnit.equal, false);
  assert.deepEqual(missingUnit.changed_refs, ['repos.repo-lib']);
  assert.ok(missingUnit.reasons.some((reason) => reason.includes('missing')));
  assert.equal(validateSource(spec, missingRepo).state, 'stale');

  const extraRepo = clone(currentIdentities);
  extraRepo.repos.push({ ...clone(extraRepo.repos[0]), repo_id: 'repo-extra' });
  const extraUnit = compareIdentity(sourceIdentity, extraRepo);
  assert.equal(extraUnit.equal, false);
  assert.deepEqual(extraUnit.changed_refs, ['repos.repo-extra']);
  assert.ok(extraUnit.reasons.some((reason) => reason.includes('not part of')));
  assert.equal(validateSource(spec, extraRepo).state, 'stale');
});

test('stale: multiple differences produce deterministic sorted changed_refs', () => {
  const current = clone(currentIdentities);
  current.snapshot_ref = 'snap-mixed';
  current.evidence_manifest_digest = 'manifest:mixed';
  current.repos[0].dirty_digest = 'dirty:mixed';
  current.repos[1].arch = 'arm64';
  const first = compareIdentity(sourceIdentity, current);
  const second = compareIdentity(sourceIdentity, clone(current));
  assert.deepEqual(first, second);
  assert.deepEqual(first.changed_refs, [
    'evidence_manifest_digest',
    'repos.repo-lib.arch',
    'repos.repo-svc.dirty_digest',
    'snapshot_ref',
  ]);
  const result = validateSource(evidenceSpec(), current);
  assert.equal(result.state, 'stale');
  assert.deepEqual(result.changed_refs, first.changed_refs);
});

/* ------------------------------------------------------------------------- *
 * unknown
 * ------------------------------------------------------------------------- */

test('unknown: missing or empty current identities never claim current or stale', () => {
  const spec = evidenceSpec();
  for (const missing of [undefined, null, []]) {
    const result = validateSource(spec, missing);
    assert.equal(result.state, 'unknown');
    assert.deepEqual(result.changed_refs, []);
    assert.ok(result.reasons.some((reason) => reason.includes('no current identity')));
  }
});

test('unknown: an identity for a different source is unknown, not stale', () => {
  const spec = evidenceSpec();
  const otherSource = { ...clone(currentIdentities), source_id: 'source:other' };
  const result = validateSource(spec, otherSource);
  assert.equal(result.state, 'unknown');
  assert.ok(result.reasons.some((reason) => reason.includes('no current identity')));
});

test('unknown: malformed current identities are unknown and do not throw', () => {
  const spec = evidenceSpec();
  const malformed = clone(currentIdentities);
  delete malformed.repos;
  const malformedResult = validateSource(spec, malformed);
  assert.equal(malformedResult.state, 'unknown');
  assert.ok(malformedResult.reasons.some((reason) => reason.includes('not a valid SourceIdentityV1')));

  const mixed = validateSource(spec, [currentIdentities, { bad: true }]);
  assert.equal(mixed.state, 'unknown');

  const notAnObject = validateSource(spec, 'nope');
  assert.equal(notAnObject.state, 'unknown');
});

test('unknown: invalid spec and conceptual spec are unknown', () => {
  const badSpec = validateSource({}, currentIdentities);
  assert.equal(badSpec.state, 'unknown');
  assert.ok(badSpec.reasons.some((reason) => reason.includes('invalid')));

  const nullSpec = validateSource(null, currentIdentities);
  assert.equal(nullSpec.state, 'unknown');

  const conceptual = emptyConceptualSpec({ title: 'c', scope_ref: 'ws:c' }, { clock: CLOCK });
  const conceptualState = validateSource(conceptual, currentIdentities);
  assert.equal(conceptualState.state, 'unknown');
  assert.ok(conceptualState.reasons.some((reason) => reason.includes('no source identities')));
});

/* ------------------------------------------------------------------------- *
 * compareIdentity and multi-source
 * ------------------------------------------------------------------------- */

test('compareIdentity: equal identities and invalid identities are handled without throwing', () => {
  assert.deepEqual(compareIdentity(sourceIdentity, currentIdentities), { equal: true, changed_refs: [], reasons: [] });
  const knownInvalid = compareIdentity({}, currentIdentities);
  assert.equal(knownInvalid.equal, false);
  assert.deepEqual(knownInvalid.changed_refs, []);
  assert.ok(knownInvalid.reasons.some((reason) => reason.includes('known source identity')));
  const currentInvalid = compareIdentity(sourceIdentity, {});
  assert.equal(currentInvalid.equal, false);
  assert.deepEqual(currentInvalid.changed_refs, []);
  assert.ok(currentInvalid.reasons.some((reason) => reason.includes('current source identity')));
});

test('multi-source: all sources must match; a missing source is unknown and a difference is stale', () => {
  const spec = clone(evidenceSpec());
  const secondKnown = {
    ...clone(sourceIdentity),
    source_id: 'local-atlas-secondary',
    snapshot_ref: 'snap-secondary-1',
    evidence_manifest_digest: 'manifest:secondary:1',
  };
  spec.sources.push(secondKnown);
  spec.source_state = 'unknown';
  assert.equal(validateDiagramSpec(spec).ok, true, JSON.stringify(validateDiagramSpec(spec).errors ?? []));

  const secondCurrent = {
    ...clone(currentIdentities),
    source_id: 'local-atlas-secondary',
    snapshot_ref: 'snap-secondary-1',
    evidence_manifest_digest: 'manifest:secondary:1',
  };
  const currentBoth = validateSource(spec, [currentIdentities, secondCurrent]);
  assert.equal(currentBoth.state, 'current');

  const missingSecond = validateSource(spec, [currentIdentities]);
  assert.equal(missingSecond.state, 'unknown');
  assert.ok(missingSecond.reasons.some((reason) => reason.includes('local-atlas-secondary')));

  const changedSecond = validateSource(spec, [currentIdentities, { ...clone(secondCurrent), snapshot_ref: 'snap-secondary-2' }]);
  assert.equal(changedSecond.state, 'stale');
  assert.deepEqual(changedSecond.changed_refs, ['snapshot_ref']);
  assert.ok(changedSecond.reasons.some((reason) => reason.includes('[local-atlas-secondary]')));
});
