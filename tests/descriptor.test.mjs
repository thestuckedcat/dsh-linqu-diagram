/**
 * DIA-10 navigation descriptor tests: 08 only produces an intent and selects the
 * 06 main panel; it never holds XML/base/overlay/version/path state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY,
  CHANNEL,
  CLIENT_ADAPTER_CONTRACT,
  INTENT,
  NAVIGATION_DESCRIPTOR,
  OPEN_EVENT,
  PANEL_ID,
  applyNavigationIntent,
  createOpenEventDetail,
  createOpenIntent,
  navigationDescriptor,
  validateOpenEventDetail,
  validateOpenIntent,
} from '../src/descriptor.mjs';

const VALID_INPUT = Object.freeze({
  document_ref: 'doc-demo',
  context_ref: 'ctx-demo',
  expected_scope_generation: 0,
});

test('descriptor: frozen navigation descriptor names capability 06 and the 06 panel', () => {
  assert.equal(CAPABILITY, '06');
  assert.equal(INTENT, 'open-diagram');
  assert.equal(PANEL_ID, 'local-diagrams');
  assert.equal(CHANNEL, '/local-diagrams');
  assert.ok(Object.isFrozen(NAVIGATION_DESCRIPTOR));
  assert.deepEqual(navigationDescriptor(), {
    schema_version: 1,
    capability: '06',
    intent: 'open-diagram',
    panel: 'local-diagrams',
    channel: '/local-diagrams',
  });
  // The descriptor itself holds no document state.
  assert.deepEqual(Object.keys(NAVIGATION_DESCRIPTOR).sort(), [
    'capability',
    'channel',
    'intent',
    'panel',
    'schema_version',
  ]);
});

test('descriptor: client adapter contract forbids data/state fields and saves', () => {
  assert.ok(Object.isFrozen(CLIENT_ADAPTER_CONTRACT));
  assert.equal(CLIENT_ADAPTER_CONTRACT.holds_document_state, false);
  assert.equal(CLIENT_ADAPTER_CONTRACT.calls_host_save, false);
  assert.deepEqual([...CLIENT_ADAPTER_CONTRACT.allowed_intent_fields].sort(), [
    'context_ref',
    'document_ref',
    'expected_scope_generation',
  ]);
  for (const field of ['xml', 'overlay', 'base_spec', 'version', 'path', 'url', 'grant']) {
    assert.ok(CLIENT_ADAPTER_CONTRACT.forbidden_intent_fields.includes(field), `missing ${field}`);
  }
  assert.equal(CLIENT_ADAPTER_CONTRACT.open_event, OPEN_EVENT);
  assert.deepEqual([...CLIENT_ADAPTER_CONTRACT.steps], [
    'validateIntent',
    'selectPanel(local-diagrams)',
    'publishOpenEvent({document_ref, context_ref, expected_scope_generation})',
  ]);
});

test('descriptor: valid intents stage only registry references', () => {
  const result = createOpenIntent(VALID_INPUT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.intent, VALID_INPUT);

  const event = createOpenEventDetail(VALID_INPUT);
  assert.equal(event.ok, true);
  assert.equal(event.type, OPEN_EVENT);
  assert.equal(event.version, 1);
  assert.deepEqual(event.detail, VALID_INPUT);
  assert.equal(JSON.stringify(event).includes('xml'), false);
});

test('descriptor: rejects data, elevation fields and path-shaped references', () => {
  const cases = [
    { ...VALID_INPUT, xml: '<mxfile/>' },
    { ...VALID_INPUT, overlay: { items: [] } },
    { ...VALID_INPUT, base_spec: { nodes: [] } },
    { ...VALID_INPUT, version: { generation: 1 } },
    { ...VALID_INPUT, path: 'C:/tmp/diagram.drawio' },
    { ...VALID_INPUT, url: 'https://example.invalid/diagram' },
    { ...VALID_INPUT, grant: 'admin' },
    { ...VALID_INPUT, caller: { kind: 'owner' } },
    { ...VALID_INPUT, document_id: 'doc-001' },
  ];
  for (const input of cases) {
    const result = validateOpenIntent(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.ok(result.errors.length > 0);
  }
});

test('descriptor: rejects missing/invalid fields and extra fields', () => {
  assert.equal(validateOpenIntent(null).ok, false);
  assert.equal(validateOpenIntent([]).ok, false);
  assert.equal(validateOpenIntent({}).ok, false);
  assert.equal(validateOpenIntent({ ...VALID_INPUT, document_ref: '' }).ok, false);
  assert.equal(validateOpenIntent({ ...VALID_INPUT, document_ref: 'C:\\temp\\x' }).ok, false);
  assert.equal(validateOpenIntent({ ...VALID_INPUT, context_ref: '../ctx' }).ok, false);
  assert.equal(validateOpenIntent({ ...VALID_INPUT, expected_scope_generation: -1 }).ok, false);
  assert.equal(validateOpenIntent({ ...VALID_INPUT, expected_scope_generation: 1.5 }).ok, false);
  assert.equal(validateOpenIntent({ ...VALID_INPUT, expected_scope_generation: '0' }).ok, false);
  assert.equal(validateOpenIntent({ document_ref: 'doc-demo', context_ref: 'ctx-demo' }).ok, false);
  const extra = validateOpenIntent({ ...VALID_INPUT, view_epoch: 4 });
  assert.equal(extra.ok, false);
  assert.equal(
    CLIENT_ADAPTER_CONTRACT.forbidden_intent_fields.includes('view_epoch'),
    false,
    'view_epoch is simply not in the closed allowed list, not a data field',
  );
  assert.equal(extra.errors.some((error) => error.path === '$.view_epoch'), true);
});

test('descriptor: applyNavigationIntent selects the panel then publishes references', () => {
  const calls = [];
  const adapter = {
    selectPanel(panelId) {
      calls.push(['selectPanel', panelId]);
    },
    publishOpen(detail) {
      calls.push(['publishOpen', detail]);
    },
  };
  const applied = applyNavigationIntent(adapter, VALID_INPUT);
  assert.equal(applied.ok, true);
  assert.equal(applied.panel, 'local-diagrams');
  assert.deepEqual(applied.published, VALID_INPUT);
  assert.deepEqual(calls, [
    ['selectPanel', 'local-diagrams'],
    ['publishOpen', VALID_INPUT],
  ]);
});

test('descriptor: applyNavigationIntent never calls the adapter for an invalid intent', () => {
  const calls = [];
  const adapter = {
    selectPanel() {
      calls.push('selectPanel');
    },
    publishOpen() {
      calls.push('publishOpen');
    },
  };
  const applied = applyNavigationIntent(adapter, { ...VALID_INPUT, xml: '<mxfile/>' });
  assert.equal(applied.ok, false);
  assert.deepEqual(calls, []);
  assert.equal(applyNavigationIntent({}, VALID_INPUT).ok, false);
});

test('descriptor: open event detail validation is the same closed contract', () => {
  assert.equal(validateOpenEventDetail(VALID_INPUT).ok, true);
  assert.equal(validateOpenEventDetail({ ...VALID_INPUT, data: {} }).ok, false);
});
