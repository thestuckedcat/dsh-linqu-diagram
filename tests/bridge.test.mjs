import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex } from '../src/canonical.mjs';
import { DiagramError } from '../src/errors.mjs';
import { overlayDigest, specDigest } from '../src/contracts.mjs';
import {
  createBridgeGuard,
  createChannelNonce,
  messageDigest,
  validateBridgeMessage,
} from '../src/editor/bridge.mjs';

const NOW = '2026-11-07T00:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:9876';
const SESSION = 'session:1';

function makeSpec() {
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
  };
}

function makeOverlay() {
  const spec = makeSpec();
  return {
    schema_version: 1,
    diagram_id: spec.diagram_id,
    base_spec_digest: specDigest(spec),
    revision: 0,
    items: [],
    orphaned_annotations: [],
    updated_at: NOW,
  };
}

function makeVersion() {
  return {
    schema_version: 1,
    document_id: 'doc:1',
    generation: 1,
    content_sha256: 'a'.repeat(64),
    byte_length: 123,
    path_identity_digest: 'path:identity',
  };
}

const XML = '<mxfile host="local-diagrams" version="v1"><diagram id="diagram:demo" name="Demo"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel></diagram></mxfile>';

let messageCounter = 0;
function makeMessage(type, payload, overrides = {}) {
  messageCounter += 1;
  return {
    schema_version: 1,
    channel_nonce: overrides.channel_nonce ?? currentNonce,
    message_id: overrides.message_id ?? `msg:${messageCounter}`,
    editor_session_ref: overrides.editor_session_ref ?? SESSION,
    type,
    payload,
    ...overrides,
  };
}

function event(data, overrides = {}) {
  return { origin: overrides.origin ?? ORIGIN, source: overrides.source ?? currentWindow, data };
}

let currentNonce;
let currentWindow;
function setup() {
  currentNonce = createChannelNonce();
  currentWindow = { tag: 'editor-contentWindow' };
  const guard = createBridgeGuard({
    editor_origin: ORIGIN,
    editor_window: currentWindow,
    editor_session_ref: SESSION,
    nonce: currentNonce,
  });
  return { guard, nonce: currentNonce, window: currentWindow };
}

function validPayloads() {
  return {
    ready: { protocol_version: 1, editor_ref: 'editor:v1' },
    load: { base_spec_digest: 'a'.repeat(64), overlay_digest: 'b'.repeat(64), xml: XML },
    draft_changed: { draft_revision: 3, dirty: true, overlay_digest: 'c'.repeat(64), xml_digest: 'd'.repeat(64) },
    save_request: { operation_id: 'op:1', expected_version: makeVersion(), xml: XML, overlay: makeOverlay() },
    save_result: { operation_id: 'op:1', status: 'saved', version: makeVersion() },
    cancel: { operation_id: 'op:1' },
    error: { code: 'INVALID_XML', message: 'nope' },
  };
}

/* -------------------------------------------------------------------------- */
/* nonce                                                                       */
/* -------------------------------------------------------------------------- */

test('createChannelNonce returns 128-bit lowercase hex nonces', () => {
  const first = createChannelNonce();
  const second = createChannelNonce();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.match(second, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second);
});

/* -------------------------------------------------------------------------- */
/* config                                                                      */
/* -------------------------------------------------------------------------- */

test('createBridgeGuard refuses wildcard/opaque origins and malformed credentials', () => {
  const nonce = createChannelNonce();
  const window = {};
  for (const origin of ['*', 'null', '']) {
    throwsCode(
      () => createBridgeGuard({ editor_origin: origin, editor_window: window, editor_session_ref: SESSION, nonce }),
      'INVALID_INPUT',
    );
  }
  throwsCode(
    () => createBridgeGuard({ editor_origin: ORIGIN, editor_window: null, editor_session_ref: SESSION, nonce }),
    'INVALID_INPUT',
  );
  throwsCode(
    () => createBridgeGuard({ editor_origin: ORIGIN, editor_window: window, editor_session_ref: SESSION, nonce: 'abc' }),
    'INVALID_INPUT',
  );
  throwsCode(
    () => createBridgeGuard({ editor_origin: ORIGIN, editor_window: window, editor_session_ref: 'bad session', nonce }),
    'INVALID_INPUT',
  );
});

/* -------------------------------------------------------------------------- */
/* accepted messages                                                           */
/* -------------------------------------------------------------------------- */

test('guard accepts every v1 message type with a strict schema', () => {
  const { guard } = setup();
  const payloads = validPayloads();
  for (const [type, payload] of Object.entries(payloads)) {
    const accepted = guard.accept(event(makeMessage(type, payload)));
    assert.equal(accepted.ok, true, `${type}: ${JSON.stringify(accepted)}`);
    assert.equal(accepted.message.type, type);
  }
  assert.equal(guard.seenCount(), Object.keys(payloads).length);
});

/* -------------------------------------------------------------------------- */
/* origin / source / nonce / session                                           */
/* -------------------------------------------------------------------------- */

test('guard rejects forged origin, wrong source, bad nonce and wrong session', () => {
  const { guard, nonce } = setup();
  const data = makeMessage('ready', validPayloads().ready);

  const forgedOrigin = guard.accept(event(data, { origin: 'http://evil.example' }));
  assert.equal(forgedOrigin.ok, false);
  assert.equal(forgedOrigin.code, 'DENIED');

  const wrongSource = guard.accept(event(data, { source: { tag: 'other-window' } }));
  assert.equal(wrongSource.ok, false);
  assert.equal(wrongSource.code, 'DENIED');

  const missingSource = guard.accept({ origin: ORIGIN, data });
  assert.equal(missingSource.ok, false);
  assert.equal(missingSource.code, 'DENIED');

  const wrongNonce = guard.accept(event(makeMessage('ready', validPayloads().ready, { channel_nonce: createChannelNonce() })));
  assert.equal(wrongNonce.ok, false);
  assert.equal(wrongNonce.code, 'INVALID_MESSAGE');

  const wrongSession = guard.accept(
    event(makeMessage('ready', validPayloads().ready, { editor_session_ref: 'session:other' })),
  );
  assert.equal(wrongSession.ok, false);
  assert.equal(wrongSession.code, 'INVALID_MESSAGE');

  const notAnObject = guard.accept(null);
  assert.equal(notAnObject.ok, false);
  assert.equal(notAnObject.code, 'INVALID_MESSAGE');

  // The nonce never appears in guard output or error text.
  assert.equal(JSON.stringify(guard), '{}');
  for (const result of [forgedOrigin, wrongSource, missingSource, wrongNonce, wrongSession, notAnObject]) {
    assert.equal(JSON.stringify(result).includes(nonce), false);
  }
  assert.equal(JSON.stringify(guard).includes(nonce), false);
});

/* -------------------------------------------------------------------------- */
/* schemas                                                                     */
/* -------------------------------------------------------------------------- */

test('guard rejects unknown types and schema violations', () => {
  const { guard } = setup();
  const readyPayload = validPayloads().ready;

  const unknownType = guard.accept(event(makeMessage('evil_type', readyPayload)));
  assert.equal(unknownType.ok, false);
  assert.equal(unknownType.code, 'INVALID_MESSAGE');

  const extraEnvelope = guard.accept(event({ ...makeMessage('ready', readyPayload), extra: true }));
  assert.equal(extraEnvelope.ok, false);
  assert.equal(extraEnvelope.code, 'INVALID_MESSAGE');

  const extraPayload = guard.accept(event(makeMessage('ready', { ...readyPayload, unexpected: 1 })));
  assert.equal(extraPayload.ok, false);
  assert.equal(extraPayload.code, 'INVALID_MESSAGE');

  const missingField = guard.accept(event(makeMessage('draft_changed', { dirty: false, overlay_digest: 'c'.repeat(64), xml_digest: 'd'.repeat(64) })));
  assert.equal(missingField.ok, false);
  assert.equal(missingField.code, 'INVALID_MESSAGE');

  const badRevision = guard.accept(event(makeMessage('draft_changed', { draft_revision: -1, dirty: false, overlay_digest: 'c'.repeat(64), xml_digest: 'd'.repeat(64) })));
  assert.equal(badRevision.ok, false);
  assert.equal(badRevision.code, 'INVALID_MESSAGE');

  const badVersion = guard.accept(
    event(makeMessage('save_result', { operation_id: 'op:1', status: 'saved', version: { ...makeVersion(), content_sha256: 'nope' } })),
  );
  assert.equal(badVersion.ok, false);
  assert.equal(badVersion.code, 'INVALID_MESSAGE');

  const savedWithoutVersion = guard.accept(event(makeMessage('save_result', { operation_id: 'op:1', status: 'saved' })));
  assert.equal(savedWithoutVersion.ok, false);
  assert.equal(savedWithoutVersion.code, 'INVALID_MESSAGE');

  const conflictWithVersion = guard.accept(
    event(makeMessage('save_result', { operation_id: 'op:1', status: 'conflict', version: makeVersion() })),
  );
  assert.equal(conflictWithVersion.ok, true);
});

/* -------------------------------------------------------------------------- */
/* dedupe                                                                      */
/* -------------------------------------------------------------------------- */

test('message_id dedupe ignores identical replays and rejects different bodies', () => {
  const { guard } = setup();
  const message = makeMessage('ready', validPayloads().ready);
  const first = guard.accept(event(message));
  assert.equal(first.ok, true);

  const replay = guard.accept(event(message));
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'DUPLICATE_MESSAGE');
  assert.equal(replay.duplicate, true);

  const changed = { ...message, payload: { protocol_version: 1, editor_ref: 'editor:v2' } };
  const conflict = guard.accept(event(changed));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'CONFLICT');

  assert.equal(guard.seenCount(), 1);
  guard.reset();
  assert.equal(guard.seenCount(), 0);
  const afterReset = guard.accept(event(message));
  assert.equal(afterReset.ok, true, 'reset clears the dedupe state');
});

/* -------------------------------------------------------------------------- */
/* save binding                                                                */
/* -------------------------------------------------------------------------- */

test('save_request is bound to the exact XML and overlay digests', () => {
  const { guard } = setup();
  const payload = validPayloads().save_request;
  const accepted = guard.accept(event(makeMessage('save_request', payload)));
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.ok(accepted.binding);
  assert.equal(accepted.binding.operation_id, payload.operation_id);
  assert.equal(accepted.binding.xml_digest, sha256Hex(payload.xml));
  assert.equal(accepted.binding.overlay_digest, overlayDigest(payload.overlay));
  assert.deepEqual(accepted.binding.expected_version, payload.expected_version);

  // Same message id with swapped XML is rejected (no silent content swap).
  const messageId = `msg:swap-${Date.now()}`;
  const first = guard.accept(event(makeMessage('save_request', payload, { message_id: messageId })));
  assert.equal(first.ok, true);
  const swapped = guard.accept(
    event(makeMessage('save_request', { ...payload, xml: payload.xml.replace('id="0"', 'id="9"') }, { message_id: messageId })),
  );
  assert.equal(swapped.ok, false);
  assert.equal(swapped.code, 'CONFLICT');

  const invalidOverlay = guard.accept(
    event(makeMessage('save_request', { ...payload, overlay: { ...payload.overlay, items: 'not-an-array' } })),
  );
  assert.equal(invalidOverlay.ok, false);
  assert.equal(invalidOverlay.code, 'INVALID_MESSAGE');

  const invalidVersion = guard.accept(
    event(makeMessage('save_request', { ...payload, expected_version: { ...makeVersion(), generation: -1 } })),
  );
  assert.equal(invalidVersion.ok, false);
  assert.equal(invalidVersion.code, 'INVALID_MESSAGE');
});

/* -------------------------------------------------------------------------- */
/* size bounds                                                                 */
/* -------------------------------------------------------------------------- */

test('guard enforces message and XML size bounds', () => {
  currentNonce = createChannelNonce();
  currentWindow = {};
  const guard = createBridgeGuard({
    editor_origin: ORIGIN,
    editor_window: currentWindow,
    editor_session_ref: SESSION,
    nonce: currentNonce,
    limits: { bridge_message_bytes: 256, document_xml_bytes: 64 },
  });

  const tooBigMessage = guard.accept(event(makeMessage('ready', { protocol_version: 1, editor_ref: 'x'.repeat(400) })));
  assert.equal(tooBigMessage.ok, false);
  assert.equal(tooBigMessage.code, 'INVALID_MESSAGE');

  const tooBigXml = guard.accept(
    event(makeMessage('load', { base_spec_digest: 'a'.repeat(64), overlay_digest: 'b'.repeat(64), xml: '<a>' + 'x'.repeat(100) + '</a>' })),
  );
  assert.equal(tooBigXml.ok, false);
  assert.equal(tooBigXml.code, 'INVALID_MESSAGE');
});

/* -------------------------------------------------------------------------- */
/* low-level helpers                                                           */
/* -------------------------------------------------------------------------- */

test('validateBridgeMessage validates without an event and is reusable', () => {
  const nonce = createChannelNonce();
  const message = makeMessage('ready', validPayloads().ready, { channel_nonce: nonce });
  const result = validateBridgeMessage(message, { editor_session_ref: SESSION, nonce });
  assert.equal(result.ok, true);
  assert.equal(result.message, message);

  throwsCode(() => validateBridgeMessage(message, { editor_session_ref: SESSION }), 'INVALID_INPUT');
  throwsCode(() => validateBridgeMessage(message, { editor_session_ref: 'bad session', nonce }), 'INVALID_INPUT');
  throwsCode(
    () => validateBridgeMessage(message, { editor_session_ref: SESSION, nonce: 'not-hex' }),
    'INVALID_INPUT',
  );
});

test('messageDigest is deterministic and type/payload sensitive', () => {
  const payload = { protocol_version: 1, editor_ref: 'editor:v1' };
  const first = messageDigest('ready', payload);
  assert.equal(first, messageDigest('ready', { ...payload }));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, messageDigest('ready', { ...payload, editor_ref: 'editor:v2' }));
  assert.notEqual(first, messageDigest('load', payload));
  throwsCode(() => messageDigest('unknown', payload), 'INVALID_INPUT');
});

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DiagramError, `expected DiagramError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}
