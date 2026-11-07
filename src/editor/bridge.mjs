/**
 * Editor bridge guard for the message v1 protocol (DIA-07, docs/software-design.md §7).
 *
 * Hardening rules implemented here:
 *  - `event.origin` must equal the locked editor origin, `event.source` must be
 *    the exact iframe `contentWindow`, and the message must carry the 128-bit
 *    in-memory channel nonce plus the current editor session reference;
 *  - every message type has a closed schema (additionalProperties:false) and a
 *    size bound; unknown types are rejected;
 *  - `message_id` is deduplicated: the same id with the same body is a
 *    duplicate (never processed twice), the same id with a different body is a
 *    conflict;
 *  - a `save_request` is bound to the exact XML and overlay digests computed by
 *    the guard itself, so a later operation-id replay cannot swap content;
 *  - the nonce exists only in memory: it is not part of any returned object,
 *    error message or log string.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { LIMITS } from '../limits.mjs';
import { DiagramError } from '../errors.mjs';
import { canonicalJson, sha256Hex, utf8Length } from '../canonical.mjs';
import { validateSchema } from '../schema.mjs';

/* -------------------------------------------------------------------------- */
/* contracts seam                                                              */
/* -------------------------------------------------------------------------- */

let CONTRACTS = null;
try {
  CONTRACTS = await import('../contracts.mjs');
} catch (error) {
  if (!(error && /** @type {any} */ (error).code === 'ERR_MODULE_NOT_FOUND')) throw error;
}

/** @returns {any} */
function requireContracts() {
  if (!CONTRACTS) {
    throw new DiagramError('INVALID_INPUT', 'shared contracts module (src/contracts.mjs) is not available');
  }
  return CONTRACTS;
}

/* -------------------------------------------------------------------------- */
/* constants                                                                   */
/* -------------------------------------------------------------------------- */

export const MESSAGE_TYPES = Object.freeze([
  'ready',
  'load',
  'draft_changed',
  'save_request',
  'save_result',
  'cancel',
  'error',
]);

const MESSAGE_TYPE_LIST = [...MESSAGE_TYPES];
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/@+~=-]{0,127}$';
const NONCE_PATTERN = '^[0-9a-f]{32}$';
const SHA256_PATTERN = '^[0-9a-f]{64}$';
const ID_REGEX = new RegExp(ID_PATTERN, 'u');
const NONCE_REGEX = new RegExp(NONCE_PATTERN, 'u');
const SAVE_STATUSES = Object.freeze(['saved', 'conflict', 'denied', 'invalid', 'cancelled', 'failed', 'outcome_unknown']);

const ENVELOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'channel_nonce', 'message_id', 'editor_session_ref', 'type', 'payload'],
  properties: {
    schema_version: { const: 1 },
    channel_nonce: { type: 'string', pattern: NONCE_PATTERN },
    message_id: { type: 'string', pattern: ID_PATTERN },
    editor_session_ref: { type: 'string', pattern: ID_PATTERN },
    type: { enum: MESSAGE_TYPE_LIST },
    payload: { type: 'object' },
  },
};

const XML_STRING = { type: 'string' };

const PAYLOAD_SCHEMAS = Object.freeze({
  ready: {
    type: 'object',
    additionalProperties: false,
    required: ['protocol_version', 'editor_ref'],
    properties: {
      protocol_version: { const: 1 },
      editor_ref: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
  load: {
    type: 'object',
    additionalProperties: false,
    required: ['base_spec_digest', 'overlay_digest', 'xml'],
    properties: {
      base_spec_digest: { type: 'string', pattern: SHA256_PATTERN },
      overlay_digest: { type: 'string', pattern: SHA256_PATTERN },
      xml: XML_STRING,
    },
  },
  draft_changed: {
    type: 'object',
    additionalProperties: false,
    required: ['draft_revision', 'dirty', 'overlay_digest', 'xml_digest'],
    properties: {
      draft_revision: { type: 'integer', minimum: 0, maximum: LIMITS.editor_draft_revision },
      dirty: { type: 'boolean' },
      overlay_digest: { type: 'string', pattern: SHA256_PATTERN },
      xml_digest: { type: 'string', pattern: SHA256_PATTERN },
    },
  },
  save_request: {
    type: 'object',
    additionalProperties: false,
    required: ['operation_id', 'expected_version', 'xml', 'overlay'],
    properties: {
      operation_id: { type: 'string', pattern: ID_PATTERN },
      expected_version: { type: 'object' },
      xml: XML_STRING,
      overlay: { type: 'object' },
    },
  },
  save_result: {
    type: 'object',
    additionalProperties: false,
    required: ['operation_id', 'status'],
    properties: {
      operation_id: { type: 'string', pattern: ID_PATTERN },
      status: { enum: [...SAVE_STATUSES] },
      version: { type: 'object' },
      reason_code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
    },
  },
  cancel: {
    type: 'object',
    additionalProperties: false,
    required: ['operation_id'],
    properties: {
      operation_id: { type: 'string', pattern: ID_PATTERN },
    },
  },
  error: {
    type: 'object',
    additionalProperties: false,
    required: ['code'],
    properties: {
      code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
      message: { type: 'string', maxLength: 512 },
    },
  },
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} path @param {string} keyword @param {string} message */
function issue(path, keyword, message) {
  return { path, keyword, message };
}

/** @param {string} path @param {string} keyword @param {string} message */
function invalidMessage(path, keyword, message) {
  return { ok: /** @type {const} */ (false), code: 'INVALID_MESSAGE', errors: [issue(path, keyword, message)] };
}

/** @param {Record<string, any>} [limits] */
function resolveLimits(limits) {
  const custom = isRecord(limits) ? limits : {};
  const positive = (value, fallback) => (Number.isSafeInteger(value) && value >= 1 ? value : fallback);
  return {
    bridge_message_bytes: positive(custom.bridge_message_bytes, LIMITS.rpc_json_bytes),
    document_xml_bytes: positive(custom.document_xml_bytes, LIMITS.document_xml_bytes),
    bridge_seen_messages: positive(custom.bridge_seen_messages, 10000),
  };
}

/**
 * Constant-time string comparison for the channel nonce / session reference.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length !== right.length) return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireConfigString(value, name) {
  if (typeof value !== 'string') throw new DiagramError('INVALID_INPUT', `${name} must be a string`);
  return value;
}

/* -------------------------------------------------------------------------- */
/* nonce / digest                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Create the 128-bit (32 hex characters) channel nonce. The nonce is handed to
 * the editor only through the authenticated open response; it must never be
 * placed in a URL or log line.
 *
 * @returns {string}
 */
export function createChannelNonce() {
  return randomBytes(16).toString('hex');
}

/**
 * Digest of a protocol message body; used for message_id dedupe.
 * @param {string} type
 * @param {unknown} payload
 * @returns {string}
 */
export function messageDigest(type, payload) {
  if (typeof type !== 'string' || !MESSAGE_TYPE_LIST.includes(type)) {
    throw new DiagramError('INVALID_INPUT', 'messageDigest requires a known message type');
  }
  return sha256Hex(canonicalJson({ type, payload }));
}

/* -------------------------------------------------------------------------- */
/* message validation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Validate one message against the v1 protocol, the locked session and nonce.
 *
 * @param {unknown} message
 * @param {{editor_session_ref: string, nonce: string, limits?: Record<string, number>}} options
 * @returns {{ok: true, message: any, binding?: {operation_id: string, expected_version: any, xml_digest: string, overlay_digest: string}}
 *   | {ok: false, code: string, errors: Array<{path: string, keyword: string, message: string}>}}
 */
export function validateBridgeMessage(message, options = {}) {
  const editorSessionRef = requireConfigString(
    /** @type {any} */ (options).editor_session_ref,
    'validateBridgeMessage: editor_session_ref',
  );
  const nonce = requireConfigString(/** @type {any} */ (options).nonce, 'validateBridgeMessage: nonce');
  if (!ID_REGEX.test(editorSessionRef)) {
    throw new DiagramError('INVALID_INPUT', 'validateBridgeMessage: editor_session_ref is malformed');
  }
  if (!NONCE_REGEX.test(nonce)) {
    throw new DiagramError('INVALID_INPUT', 'validateBridgeMessage: nonce must be 32 lowercase hex characters');
  }
  const limits = resolveLimits(/** @type {any} */ (options).limits);

  if (!isRecord(message)) return invalidMessage('$', 'type', 'message must be a JSON object');
  let serialized;
  try {
    serialized = JSON.stringify(message);
  } catch {
    return invalidMessage('$', 'json', 'message is not JSON-serializable');
  }
  if (typeof serialized !== 'string') return invalidMessage('$', 'json', 'message must be a JSON object');
  const bytes = utf8Length(serialized);
  if (bytes > limits.bridge_message_bytes) {
    return invalidMessage('$', 'maxBytes', `message is ${bytes} bytes; limit is ${limits.bridge_message_bytes}`);
  }

  const envelopeIssues = validateSchema(ENVELOPE_SCHEMA, message);
  if (envelopeIssues.length > 0) return { ok: false, code: 'INVALID_MESSAGE', errors: envelopeIssues };
  if (!safeEqual(message.channel_nonce, nonce)) {
    return invalidMessage('$.channel_nonce', 'nonce', 'channel nonce does not match the editor session');
  }
  if (!safeEqual(message.editor_session_ref, editorSessionRef)) {
    return invalidMessage('$.editor_session_ref', 'session', 'editor_session_ref does not match the editor session');
  }

  const payloadSchema = PAYLOAD_SCHEMAS[message.type];
  const payloadIssues = validateSchema(payloadSchema, message.payload);
  if (payloadIssues.length > 0) {
    return {
      ok: false,
      code: 'INVALID_MESSAGE',
      errors: payloadIssues.map((entry) => ({ ...entry, path: `$.payload${entry.path.slice(1)}` })),
    };
  }

  if (message.type === 'load' || message.type === 'save_request') {
    const xmlBytes = utf8Length(message.payload.xml);
    if (xmlBytes > limits.document_xml_bytes) {
      return invalidMessage('$.payload.xml', 'maxBytes', `XML payload is ${xmlBytes} bytes; limit is ${limits.document_xml_bytes}`);
    }
  }

  if (message.type === 'save_request') {
    const contracts = requireContracts();
    const versionResult = contracts.validateDocumentVersion(message.payload.expected_version);
    if (!versionResult.ok) {
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        errors: versionResult.errors.map((entry) => ({ ...entry, path: `$.payload.expected_version${entry.path.slice(1)}` })),
      };
    }
    const overlayResult = contracts.validateOverlay(message.payload.overlay);
    if (!overlayResult.ok) {
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        errors: overlayResult.errors.map((entry) => ({ ...entry, path: `$.payload.overlay${entry.path.slice(1)}` })),
      };
    }
    return {
      ok: true,
      message,
      binding: {
        operation_id: message.payload.operation_id,
        expected_version: versionResult.value,
        xml_digest: sha256Hex(message.payload.xml),
        overlay_digest: contracts.overlayDigest(message.payload.overlay),
      },
    };
  }

  if (message.type === 'save_result' && message.payload.version !== undefined) {
    const contracts = requireContracts();
    const versionResult = contracts.validateDocumentVersion(message.payload.version);
    if (!versionResult.ok) {
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        errors: versionResult.errors.map((entry) => ({ ...entry, path: `$.payload.version${entry.path.slice(1)}` })),
      };
    }
    if (message.payload.status === 'saved') {
      return { ok: true, message };
    }
  }
  if (message.type === 'save_result' && message.payload.status === 'saved' && message.payload.version === undefined) {
    return invalidMessage('$.payload.version', 'required', 'a saved result must carry the new document version');
  }

  return { ok: true, message };
}

/* -------------------------------------------------------------------------- */
/* guard                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{
 *   accept(event: {origin?: unknown, source?: unknown, data?: unknown}): {ok: true, message: any, binding?: any}
 *     | {ok: false, code: string, errors?: Array<{path: string, keyword: string, message: string}>, duplicate?: boolean},
 *   reset(): void,
 *   seenCount(): number,
 * }} BridgeGuard
 */

/**
 * Create the bridge guard for one editor iframe/session.
 *
 * @param {{editor_origin: string, editor_window: object, editor_session_ref: string, nonce: string, limits?: Record<string, number>}} config
 * @returns {BridgeGuard}
 */
export function createBridgeGuard(config = {}) {
  const editorOrigin = requireConfigString(/** @type {any} */ (config).editor_origin, 'createBridgeGuard: editor_origin');
  if (editorOrigin.length === 0 || editorOrigin === '*' || editorOrigin === 'null') {
    throw new DiagramError(
      'INVALID_INPUT',
      'editor_origin must be the locked editor origin; wildcard and "null" origins are not allowed',
    );
  }
  const editorWindow = /** @type {any} */ (config).editor_window;
  if (editorWindow === null || typeof editorWindow !== 'object') {
    throw new DiagramError('INVALID_INPUT', 'createBridgeGuard: editor_window must be the iframe contentWindow');
  }
  const editorSessionRef = requireConfigString(
    /** @type {any} */ (config).editor_session_ref,
    'createBridgeGuard: editor_session_ref',
  );
  if (!ID_REGEX.test(editorSessionRef)) {
    throw new DiagramError('INVALID_INPUT', 'createBridgeGuard: editor_session_ref is malformed');
  }
  const nonce = requireConfigString(/** @type {any} */ (config).nonce, 'createBridgeGuard: nonce');
  if (!NONCE_REGEX.test(nonce)) {
    throw new DiagramError('INVALID_INPUT', 'createBridgeGuard: nonce must be 32 lowercase hex characters');
  }
  const limits = resolveLimits(/** @type {any} */ (config).limits);

  /** @type {Map<string, string>} */
  const seen = new Map();

  /** @param {unknown} event */
  function accept(event) {
    if (!isRecord(event)) return invalidMessage('$', 'event', 'bridge event must be an object');
    if (typeof event.origin !== 'string' || event.origin !== editorOrigin) {
      return {
        ok: false,
        code: 'DENIED',
        errors: [issue('$.origin', 'origin', 'message origin is not the locked editor origin')],
      };
    }
    if (event.source !== editorWindow) {
      return {
        ok: false,
        code: 'DENIED',
        errors: [issue('$.source', 'source', 'message source is not the locked editor contentWindow')],
      };
    }
    let result;
    try {
      result = validateBridgeMessage(event.data, {
        editor_session_ref: editorSessionRef,
        nonce,
        limits,
      });
    } catch (error) {
      if (error instanceof DiagramError) {
        return { ok: false, code: error.code, errors: error.details?.errors ?? [issue('$', 'invalid', error.message)] };
      }
      throw error;
    }
    if (!result.ok) return result;

    const digest = messageDigest(result.message.type, result.message.payload);
    if (seen.has(result.message.message_id)) {
      if (seen.get(result.message.message_id) === digest) {
        return {
          ok: false,
          code: 'DUPLICATE_MESSAGE',
          duplicate: true,
          errors: [issue('$.message_id', 'duplicate', 'message_id was already accepted')],
        };
      }
      return {
        ok: false,
        code: 'CONFLICT',
        errors: [issue('$.message_id', 'conflict', 'message_id was already accepted with different content')],
      };
    }
    seen.set(result.message.message_id, digest);
    while (seen.size > limits.bridge_seen_messages) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    if (result.binding) return { ok: true, message: result.message, binding: result.binding };
    return { ok: true, message: result.message };
  }

  function reset() {
    seen.clear();
  }

  function seenCount() {
    return seen.size;
  }

  return Object.freeze({ accept, reset, seenCount });
}
