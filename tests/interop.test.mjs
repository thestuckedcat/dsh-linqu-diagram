import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFactEvent,
  artifactRefFor,
  createInteropState,
  validateFactEvent,
} from '../src/events.mjs';

/** Minimal generated-spec stand-in with a declared repo identity. */
function spec() {
  return {
    schema_version: 1,
    diagram_id: 'diagram:demo',
    revision: 1,
    mode: 'evidence',
    title: 'demo',
    scope_ref: 'ws:demo',
    sources: [
      {
        source_id: 'local-atlas-synthetic',
        scope_ref: 'ws:demo',
        snapshot_ref: 'snap-1',
        repos: [
          { repo_id: 'repo-svc', root_ref: 'H:/fixture/repo-svc' },
          { repo_id: 'repo-lib', root_ref: 'H:/fixture/repo-lib' },
        ],
        evidence_manifest_digest: 'manifest:1',
      },
    ],
    nodes: [],
    edges: [],
    source_state: 'current',
  };
}

/** Build a base event; `undefined` overrides remove the property entirely. */
function event(overrides = {}) {
  const base = {
    schema_version: 1,
    event_id: 'evt-1',
    kind: 'workspace_files_restored',
    source_capability: '03',
    scope_ref: 'ws:demo',
    operation_id: 'op-1',
    generation: 1,
    affected_refs: ['repo-svc'],
    outcome: 'completed',
    after_snapshot: 'snap-2',
    occurred_at: '2026-11-07T02:00:00Z',
  };
  const merged = { ...base, ...overrides };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged;
}

test('validateFactEvent accepts a well-formed v1 event', () => {
  assert.equal(validateFactEvent(event()).ok, true);
});

test('validateFactEvent rejects unknown kind, extra fields, bad outcome and bad timestamp', () => {
  assert.equal(validateFactEvent(event({ kind: 'session_rolled_back' })).ok, false);
  assert.equal(validateFactEvent(event({ outcome: 'done' })).ok, false);
  assert.equal(validateFactEvent(event({ occurred_at: '2026-11-07 02:00' })).ok, false);
  assert.equal(validateFactEvent({ ...event(), extra: true }).ok, false);
  assert.equal(validateFactEvent(event({ affected_refs: [1] })).ok, false);
});

test('intersecting workspace_files_restored with after_snapshot downgrades to stale', () => {
  const result = applyFactEvent(spec(), event());
  assert.equal(result.ok, true);
  assert.equal(result.action, 'applied');
  assert.equal(result.spec.source_state, 'stale');
  assert.match(result.reasons.join(' '), /repo-svc/);
});

test('workspace_files_restored without after_snapshot stays unknown instead of guessing current', () => {
  const result = applyFactEvent(spec(), event({ after_snapshot: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.action, 'unknown');
  assert.equal(result.spec.source_state, 'unknown');
});

test('workspace_files_restored outside this scope or repos is noted without changing state', () => {
  const outsideScope = applyFactEvent(spec(), event({ scope_ref: 'ws:other' }));
  assert.equal(outsideScope.spec.source_state, 'current');
  assert.equal(outsideScope.action, 'noted');

  const outsideRepos = applyFactEvent(spec(), event({ affected_refs: ['repo-other'] }));
  assert.equal(outsideRepos.spec.source_state, 'current');
  assert.equal(outsideRepos.action, 'noted');
});

test('session_surface_rewound does not invalidate the independent code snapshot', () => {
  const result = applyFactEvent(spec(), event({ kind: 'session_surface_rewound', affected_refs: [], after_snapshot: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.action, 'noted');
  assert.equal(result.spec.source_state, 'current');
  assert.match(result.reasons.join(' '), /rewound conversation need review/);
});

test('session_removed clears association but keeps the artifact spec', () => {
  const original = spec();
  const result = applyFactEvent(original, event({ kind: 'session_removed', affected_refs: [], after_snapshot: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.action, 'noted');
  assert.equal(result.spec.source_state, 'current');
  assert.equal(result.spec.diagram_id, original.diagram_id);
  assert.equal(original.source_state, 'current');
});

test('duplicate event_id is ignored and never applied twice', () => {
  const first = applyFactEvent(spec(), event());
  const second = applyFactEvent(spec(), event(), first.state);
  assert.equal(second.action, 'duplicate');
  assert.equal(second.spec.source_state, 'current');
  assert.deepEqual(second.state.consumed_event_ids, first.state.consumed_event_ids);
});

test('generation gap forces unknown instead of assuming current', () => {
  const state = createInteropState();
  const first = applyFactEvent(spec(), event({ event_id: 'evt-a', generation: 1 }), state);
  const gap = applyFactEvent(spec(), event({ event_id: 'evt-b', generation: 5 }), first.state);
  assert.equal(gap.action, 'gap');
  assert.notEqual(gap.spec.source_state, 'current');
});

test('partial or outcome_unknown event keeps stale/unknown and never promotes current', () => {
  for (const outcome of ['partial', 'outcome_unknown']) {
    const intersecting = applyFactEvent(spec(), event({ outcome }));
    assert.equal(intersecting.ok, true);
    assert.equal(intersecting.action, 'unknown');
    assert.ok(['stale', 'unknown'].includes(intersecting.spec.source_state));

    const unrelated = applyFactEvent(spec(), event({ outcome, affected_refs: ['repo-other'], after_snapshot: undefined }));
    assert.equal(unrelated.ok, true);
    assert.equal(unrelated.spec.source_state, 'unknown');
  }
});

test('invalid spec or event returns a fixed code instead of throwing', () => {
  const badEvent = applyFactEvent(spec(), {});
  assert.equal(badEvent.ok, false);
  assert.equal(badEvent.code, 'INVALID_INPUT');
  const badSpec = applyFactEvent(null, event());
  assert.equal(badSpec.ok, false);
  assert.equal(badSpec.code, 'INVALID_SPEC');
});

test('artifactRefFor is a stable non-secret reference and validates identity', () => {
  const ref = artifactRefFor({ artifact_id: 'artifact-abc', diagram_id: 'diagram:demo' });
  assert.equal(ref, 'diagram-artifact:diagram:demo:artifact-abc');
  assert.throws(() => artifactRefFor({ artifact_id: '' }), TypeError);
  assert.throws(() => artifactRefFor(null), TypeError);
});
