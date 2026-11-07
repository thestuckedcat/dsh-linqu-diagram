/**
 * Same-origin Host RPC service for the 06 local diagram editor (DIA-RPC-01).
 *
 * Frozen contract (docs/interfaces.md §10, docs/software-design.md §9):
 *
 *  - `handle(endpoint, payload, signal, peer)` is the rc.5 connection RPC
 *    handler. It ALWAYS returns an `RpcResult` (`{ok:true,value}` /
 *    `{ok:false,error}`) and never throws: the Host transport turns a thrown
 *    handler into `HTTP 500` with `String(error)` in the body (a path / stack
 *    leak vector), so every unexpected condition is converted to a fixed
 *    `INTERNAL_FAILURE` response instead.
 *  - Only `peer.principal.kind === 'owner'` with a live peer signal is served.
 *    Authentication is not document permission: the document store still
 *    re-checks the trusted `DiagramAccessRegistryV1` (scope generation, path
 *    identity, mode) on every open/save/export.
 *  - The request shell is the strict closed union
 *    `{schema_version,operation_id,context_ref,expected_scope_generation,
 *    view_epoch,input}` (additionalProperties:false). Endpoint inputs are their
 *    own closed unions. `input` never carries caller/grants; those come from
 *    the resolved registry context only.
 *  - Business responses are the closed union
 *    `{schema_version,operation_id,view_epoch,scope_generation,status,data}` or
 *    the same envelope with `status in {denied,stale,invalid,conflict,
 *    unavailable,failed}` + fixed `reason_code` (conflict may carry only the
 *    restricted `{current_version,draft_ref}` data). Business rejections stay
 *    in `value`; only an unauthenticated peer or an unparseable shell produces
 *    an `{ok:false,error}` RpcResult, always with a fixed code/message.
 *  - Nothing returned may contain real paths, XML exception text, stack traces,
 *    configuration or scopes. `document.export` maps the store's absolute
 *    artifact path to its leaf file name; operation ids, editor session refs and
 *    draft refs are opaque tool tokens, not paths.
 *  - `document.save` pre-parses the client XML against the restricted drawio
 *    whitelist and validates the overlay, then delegates to the document store.
 *    The store revalidates the overlay against its own canonical base spec,
 *    regenerates canonical XML and compares parsed client-XML semantics to it;
 *    a mismatch is `INVALID_OVERLAY`. The plugin never trusts a client claim
 *    about base identity or exactness.
 *  - Request and response JSON bodies are capped by `LIMITS.rpc_json_bytes` and
 *    `LIMITS.rpc_response_bytes` (12 MiB each by default).
 *  - `operation_id` idempotency: replaying the same endpoint + context + input
 *    is allowed (store-side replay returns the same saved version); reusing the
 *    id for different content is rejected with `OPERATION_CONFLICT`.
 *
 * This module is the Host half. It has no network access, no clock dependency
 * for correctness (results are time-stamped by the document store) and no
 * client-controlled configuration.
 */

import { LIMITS, CODES } from '../limits.mjs';
import { isDiagramError } from '../errors.mjs';
import { canonicalJson, sha256Hex, utf8Length } from '../canonical.mjs';
import {
  PATTERNS,
  validateRpcRequest,
  validateRpcResponse,
  validateOverlay,
  validateDocumentVersion,
} from '../contracts.mjs';
import { parseDrawioXml } from '../drawio/xml.mjs';

/* -------------------------------------------------------------------------- */
/* exposed contract constants                                                  */
/* -------------------------------------------------------------------------- */

/** The one channel owned by this plugin. */
export const CHANNEL = '/local-diagrams';

/** Endpoint union (closed; anything else is UNKNOWN_ENDPOINT). */
export const ENDPOINTS = Object.freeze([
  'document.open',
  'document.save',
  'document.export',
  'operation.get',
  'session.close',
]);

/** Business response status union. */
export const STATUS_VALUES = Object.freeze([
  'ok',
  'denied',
  'stale',
  'invalid',
  'conflict',
  'unavailable',
  'failed',
]);

/** Statuses that may appear with a `reason_code` (i.e. not `ok`). */
export const FAILURE_STATUSES = Object.freeze(['denied', 'stale', 'invalid', 'conflict', 'unavailable', 'failed']);

/**
 * The closed reason-code union. The first block is frozen by DIA-RPC-01; the
 * second block are stable adapter-only codes for conditions the design names
 * but does not label (malformed shell, operation-id reuse, exclusive-create
 * conflict, unsupported export format, unknown save outcome, cancellation).
 */
export const REASON_CODES = Object.freeze([
  // DIA-RPC-01 fixed codes
  'OWNER_REQUIRED',
  'CONTEXT_UNBOUND',
  'SCOPE_REVOKED',
  'DOCUMENT_DENIED',
  'EDITOR_SESSION_EXPIRED',
  'STALE_VERSION',
  'INVALID_XML',
  'INVALID_OVERLAY',
  'LIMIT_EXCEEDED',
  'UNKNOWN_ENDPOINT',
  'INTERNAL_FAILURE',
  // adapter-only fixed codes (documented in docs/interfaces.md §10)
  'INVALID_REQUEST',
  'OPERATION_CONFLICT',
  'EXPORT_EXISTS',
  'UNSUPPORTED_FORMAT',
  'OUTCOME_UNKNOWN',
  'CANCELLED',
]);

const REASON_CODE_SET = new Set(REASON_CODES);
const ENDPOINT_SET = new Set(ENDPOINTS);
const STATUS_SET = new Set(STATUS_VALUES);
const FAILURE_STATUS_SET = new Set(FAILURE_STATUSES);

/** `^[A-Za-z0-9][A-Za-z0-9._:/@+~=-]*$` from the contracts module. */
const ID_PATTERN = new RegExp(PATTERNS.id, 'u');
/** Leaf file names produced by the document store's exclusive-create export. */
const EXPORT_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
/** Editor-session refs minted by the document store (`es-<uuid>`). */
const SESSION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
/** Diagnostic warning tokens the store may emit (short internal codes only). */
const WARNING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

const FIXED_MESSAGES = Object.freeze({
  OWNER_REQUIRED: 'owner peer required',
  INTERNAL_FAILURE: 'internal failure',
  INVALID_REQUEST: 'invalid request',
  UNAVAILABLE: 'service unavailable',
});

const OPERATION_CACHE_LIMIT = 512;
const OPEN_DATA_KEYS = Object.freeze([
  'document_id',
  'xml',
  'base_spec',
  'overlay',
  'version',
  'editor_session_ref',
  'channel_nonce',
  'warnings',
]);
const SAVE_DATA_KEYS = Object.freeze(['version']);
const EXPORT_DATA_KEYS = Object.freeze(['artifact_ref', 'sha256', 'size_bytes']);
const CLOSE_DATA_KEYS = Object.freeze(['closed']);
const OPERATION_STATES = Object.freeze(['pending', 'revision_written', 'saved', 'failed', 'unknown']);

/* -------------------------------------------------------------------------- */
/* small local helpers                                                         */
/* -------------------------------------------------------------------------- */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {boolean} */
function isId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && ID_PATTERN.test(value);
}

/**
 * Strict closed-object key check. Rejects missing keys and extra keys, so a
 * client cannot smuggle `caller`, `grant`, `path`, `scope_ref`, or a second
 * command union member into an endpoint input.
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @returns {boolean}
 */
function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return false;
  }
  return true;
}

/** @param {unknown} value @returns {boolean} */
function isSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** @param {unknown} value @param {number} maxBytes @returns {boolean} */
function byteLengthAtMost(value, maxBytes) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') <= maxBytes;
  try {
    return utf8Length(JSON.stringify(value)) <= maxBytes;
  } catch {
    return false;
  }
}

/**
 * Fixed transport-level error RpcResult. Only used before a trusted business
 * envelope exists (unauthenticated peer, unparseable shell, disposed service).
 * @param {string} code
 * @returns {{ok:false, error:{code:string, message:string, details:Record<string,never>}}}
 */
function transportError(code) {
  const fixed = FIXED_MESSAGES[code] ?? FIXED_MESSAGES.INTERNAL_FAILURE;
  return { ok: false, error: { code, message: fixed, details: {} } };
}

/**
 * Build the success business envelope.
 * @param {{operation_id:string, view_epoch:number}} shell
 * @param {number} scopeGeneration
 * @param {Record<string, any>} data
 * @returns {any}
 */
function okResponse(shell, scopeGeneration, data) {
  return {
    schema_version: 1,
    operation_id: shell.operation_id,
    view_epoch: shell.view_epoch,
    scope_generation: scopeGeneration,
    status: 'ok',
    data,
  };
}

/**
 * Build a business failure envelope with a fixed reason code (never free text).
 * @param {{operation_id:string, view_epoch:number}} shell
 * @param {number} scopeGeneration
 * @param {string} status
 * @param {string} reasonCode
 * @param {Record<string, any>} [data]
 * @returns {any}
 */
function failureResponse(shell, scopeGeneration, status, reasonCode, data) {
  const response = {
    schema_version: 1,
    operation_id: shell.operation_id,
    view_epoch: shell.view_epoch,
    scope_generation: scopeGeneration,
    status: FAILURE_STATUS_SET.has(status) ? status : 'failed',
    reason_code: REASON_CODE_SET.has(reasonCode) ? reasonCode : 'INTERNAL_FAILURE',
  };
  // Conflict is the only non-ok branch allowed restricted `data`; every other
  // failure status has exactly the no-data shape.
  if (data !== undefined && response.status === 'conflict') response.data = data;
  return response;
}

/** @param {any} response @returns {boolean} */
function responseValid(response) {
  const result = validateRpcResponse(response);
  return result.ok === true;
}

/* -------------------------------------------------------------------------- */
/* store result -> business response mapping                                   */
/* -------------------------------------------------------------------------- */

/**
 * Map a document-store `code` to the closed reason-code union. Unknown codes
 * degrade to the endpoint's fixed default instead of leaking store internals.
 * @param {string} code
 * @returns {string}
 */
function mapStoreCode(code) {
  switch (code) {
    case 'OWNER_REQUIRED':
      return 'OWNER_REQUIRED';
    case 'CONTEXT_UNBOUND':
      return 'CONTEXT_UNBOUND';
    case 'SCOPE_REVOKED':
      return 'SCOPE_REVOKED';
    case 'DOCUMENT_DENIED':
      return 'DOCUMENT_DENIED';
    case 'EDITOR_SESSION_EXPIRED':
      return 'EDITOR_SESSION_EXPIRED';
    case 'STALE_VERSION':
      return 'STALE_VERSION';
    case 'INVALID_XML':
      return 'INVALID_XML';
    case 'INVALID_OVERLAY':
      return 'INVALID_OVERLAY';
    case 'LIMIT_EXCEEDED':
      return 'LIMIT_EXCEEDED';
    case 'INVALID_INPUT':
      return 'INVALID_REQUEST';
    case 'UNSUPPORTED':
      return 'UNSUPPORTED_FORMAT';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'OUTCOME_UNKNOWN':
      return 'OUTCOME_UNKNOWN';
    case 'CONFLICT':
      return 'OPERATION_CONFLICT';
    default:
      return 'INTERNAL_FAILURE';
  }
}

/** @param {string} status @returns {string} */
function mapStoreStatus(status) {
  switch (status) {
    case 'denied':
      return 'denied';
    case 'invalid':
      return 'invalid';
    case 'unavailable':
      return 'unavailable';
    case 'conflict':
      return 'conflict';
    case 'cancelled':
    case 'outcome_unknown':
      return 'failed';
    default:
      return 'failed';
  }
}

/**
 * Convert a document-store result into a business response. The envelope fields
 * (`operation_id`, `view_epoch`, `scope_generation`) come from the validated
 * request shell and the resolved registry context, never from the store.
 *
 * Store statuses that are not `ok` are normalized to the closed union:
 *  - `denied`          -> status denied
 *  - `invalid`         -> status invalid
 *  - `unavailable`     -> status unavailable
 *  - `conflict`        -> status conflict (restricted `data` only)
 *  - `cancelled`       -> status failed, CANCELLED
 *  - `outcome_unknown` -> status failed, OUTCOME_UNKNOWN
 * Any unexpected exception in this mapping becomes a fixed INTERNAL_FAILURE.
 *
 * @param {{endpoint:string, operation_id:string, view_epoch:number, scope_generation:number, result:any}} input
 * @returns {any} BusinessResponse
 */
export function normalizeBusinessResponse(input) {
  const fallbackShell = {
    operation_id: typeof input?.operation_id === 'string' ? input.operation_id : 'invalid',
    view_epoch: isSafeInteger(input?.view_epoch) && input.view_epoch >= 0 ? input.view_epoch : 0,
  };
  const scopeGeneration = isSafeInteger(input?.scope_generation) && input.scope_generation >= 0
    ? input.scope_generation
    : 0;
  const endpoint = typeof input?.endpoint === 'string' ? input.endpoint : '';
  const result = isRecord(input?.result) ? input.result : null;
  if (result === null) {
    return failureResponse(fallbackShell, scopeGeneration, 'failed', 'INTERNAL_FAILURE');
  }
  try {
    if (endpoint === 'document.open') return normalizeOpenResult(result, fallbackShell, scopeGeneration);
    if (endpoint === 'document.save') return normalizeSaveResult(result, fallbackShell, scopeGeneration);
    if (endpoint === 'document.export') return normalizeExportResult(result, fallbackShell, scopeGeneration);
    if (endpoint === 'operation.get') return normalizeOperationResult(result, fallbackShell, scopeGeneration);
    if (endpoint === 'session.close') return normalizeCloseResult(result, fallbackShell, scopeGeneration);
    return failureResponse(fallbackShell, scopeGeneration, 'invalid', 'UNKNOWN_ENDPOINT');
  } catch {
    // No exception text may reach the transport.
    return failureResponse(fallbackShell, scopeGeneration, 'failed', 'INTERNAL_FAILURE');
  }
}

/** @param {any} result @param {any} shell @param {number} scopeGeneration @returns {any} */
function normalizeOpenResult(result, shell, scopeGeneration) {
  if (result.status !== 'opened') {
    return failureFromStoreResult(result, shell, scopeGeneration, 'unavailable');
  }
  const warnings = (Array.isArray(result.warnings) ? result.warnings : [])
    .filter((entry) => typeof entry === 'string' && WARNING_PATTERN.test(entry))
    .slice(0, 16);
  const data = {
    document_id: result.document_id,
    xml: result.xml,
    base_spec: result.base_spec,
    overlay: result.overlay,
    version: result.version,
    editor_session_ref: result.editor_session_ref,
    channel_nonce: result.channel_nonce,
    warnings,
  };
  if (!openDataValid(data)) return failureResponse(shell, scopeGeneration, 'unavailable', 'INTERNAL_FAILURE');
  return okResponse(shell, scopeGeneration, data);
}

/** @param {any} result @param {any} shell @param {number} scopeGeneration @returns {any} */
function normalizeSaveResult(result, shell, scopeGeneration) {
  if (result.status === 'saved') {
    const data = { version: result.version };
    if (!hasExactKeys(data, SAVE_DATA_KEYS) || !versionValid(data.version)) {
      return failureResponse(shell, scopeGeneration, 'failed', 'INTERNAL_FAILURE');
    }
    return okResponse(shell, scopeGeneration, data);
  }
  if (result.status === 'conflict') {
    const data = {};
    if (versionValid(result.current_version)) data.current_version = result.current_version;
    if (isId(result.draft_ref)) data.draft_ref = result.draft_ref;
    if (data.current_version === undefined) {
      // The client needs the host version to resolve a conflict; without a
      // valid one this is an internal failure, not a silently empty conflict.
      return failureResponse(shell, scopeGeneration, 'failed', 'INTERNAL_FAILURE');
    }
    return failureResponse(shell, scopeGeneration, 'conflict', 'STALE_VERSION', data);
  }
  if (result.status === 'invalid' && result.code === 'CONFLICT') {
    return failureResponse(shell, scopeGeneration, 'invalid', 'OPERATION_CONFLICT');
  }
  return failureFromStoreResult(result, shell, scopeGeneration, 'failed');
}

/** @param {any} result @param {any} shell @param {number} scopeGeneration @returns {any} */
function normalizeExportResult(result, shell, scopeGeneration) {
  if (result.status === 'exported') {
    const rawRef = typeof result.artifact_ref === 'string' ? result.artifact_ref : '';
    const leaf = rawRef.split(/[\\/]/u).pop() ?? '';
    if (!EXPORT_FILE_PATTERN.test(leaf)) {
      // Never echo a real filesystem path; a non-leaf artifact ref is an
      // internal error.
      return failureResponse(shell, scopeGeneration, 'failed', 'INTERNAL_FAILURE');
    }
    const data = { artifact_ref: leaf, sha256: result.sha256, size_bytes: result.size_bytes };
    const valid =
      hasExactKeys(data, EXPORT_DATA_KEYS) &&
      EXPORT_FILE_PATTERN.test(data.artifact_ref) &&
      typeof data.sha256 === 'string' &&
      /^[0-9a-f]{64}$/u.test(data.sha256) &&
      isSafeInteger(data.size_bytes) &&
      data.size_bytes >= 0;
    if (!valid) return failureResponse(shell, scopeGeneration, 'failed', 'INTERNAL_FAILURE');
    return okResponse(shell, scopeGeneration, data);
  }
  if (result.status === 'conflict') {
    return failureResponse(shell, scopeGeneration, 'conflict', 'EXPORT_EXISTS');
  }
  return failureFromStoreResult(result, shell, scopeGeneration, 'failed');
}

/** @param {any} result @param {any} shell @param {number} scopeGeneration @returns {any} */
function normalizeOperationResult(result, shell, scopeGeneration) {
  if (!OPERATION_STATES.includes(result.state)) {
    return failureResponse(shell, scopeGeneration, 'failed', 'INTERNAL_FAILURE');
  }
  const data = { state: result.state };
  if (versionValid(result.version)) data.version = result.version;
  if (typeof result.reason_code === 'string') {
    data.reason_code = REASON_CODE_SET.has(result.reason_code)
      ? result.reason_code
      : mapStoreCode(result.reason_code);
  }
  if (!operationDataValid(data)) {
    return failureResponse(shell, scopeGeneration, 'failed', 'INTERNAL_FAILURE');
  }
  return okResponse(shell, scopeGeneration, data);
}

/** @param {any} result @param {any} shell @param {number} scopeGeneration @returns {any} */
function normalizeCloseResult(result, shell, scopeGeneration) {
  if (typeof result.closed !== 'boolean') {
    return failureResponse(shell, scopeGeneration, 'failed', 'INTERNAL_FAILURE');
  }
  return okResponse(shell, scopeGeneration, { closed: result.closed });
}

/**
 * Common mapping for non-ok store results.
 * @param {any} result
 * @param {any} shell
 * @param {number} scopeGeneration
 * @param {string} defaultStatus
 * @returns {any}
 */
function failureFromStoreResult(result, shell, scopeGeneration, defaultStatus) {
  const status = mapStoreStatus(result.status);
  const reason = mapStoreCode(typeof result.code === 'string' ? result.code : '');
  if (result.status === 'conflict' && result.code === 'CONFLICT') {
    return failureResponse(shell, scopeGeneration, 'conflict', 'STALE_VERSION');
  }
  if (result.status === 'invalid' && result.code === 'CONFLICT') {
    return failureResponse(shell, scopeGeneration, 'invalid', 'OPERATION_CONFLICT');
  }
  if (reason === 'INTERNAL_FAILURE') {
    return failureResponse(shell, scopeGeneration, defaultStatus, 'INTERNAL_FAILURE');
  }
  return failureResponse(shell, scopeGeneration, status === 'failed' ? defaultStatus : status, reason);
}

/* -------------------------------------------------------------------------- */
/* response data validators (closed unions)                                    */
/* -------------------------------------------------------------------------- */

/** @param {unknown} value @returns {boolean} */
function versionValid(value) {
  if (!isRecord(value)) return false;
  return validateDocumentVersion(value).ok === true;
}

/** @param {any} data @returns {boolean} */
function openDataValid(data) {
  return (
    hasExactKeys(data, OPEN_DATA_KEYS) &&
    isId(data.document_id) &&
    typeof data.xml === 'string' &&
    isRecord(data.base_spec) &&
    isRecord(data.overlay) &&
    versionValid(data.version) &&
    typeof data.editor_session_ref === 'string' &&
    data.editor_session_ref.length <= 128 &&
    SESSION_REF_PATTERN.test(data.editor_session_ref) &&
    typeof data.channel_nonce === 'string' &&
    /^[0-9a-f]{32}$/u.test(data.channel_nonce) &&
    Array.isArray(data.warnings) &&
    data.warnings.every((entry) => typeof entry === 'string' && WARNING_PATTERN.test(entry))
  );
}

/** @param {any} data @returns {boolean} */
function operationDataValid(data) {
  if (!isRecord(data) || !OPERATION_STATES.includes(data.state)) return false;
  const keys = Object.keys(data);
  if (!keys.includes('state')) return false;
  for (const key of keys) {
    if (!['state', 'version', 'reason_code'].includes(key)) return false;
  }
  if (Object.hasOwn(data, 'version') && !versionValid(data.version)) return false;
  if (Object.hasOwn(data, 'reason_code')) {
    if (typeof data.reason_code !== 'string' || !REASON_CODE_SET.has(data.reason_code)) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* input validators (closed unions)                                            */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} endpoint
 * @param {unknown} input
 * @returns {{ok:true, input:any} | {ok:false, reason_code:string}}
 */
function validateEndpointInput(endpoint, input) {
  if (!isRecord(input)) return invalidInput();
  if (endpoint === 'document.open') {
    if (!hasExactKeys(input, ['document_ref']) || !isId(input.document_ref)) return invalidInput();
    return { ok: true, input: { document_ref: input.document_ref } };
  }
  if (endpoint === 'document.save') {
    const keys = ['document_id', 'editor_session_ref', 'expected_version', 'xml', 'overlay'];
    if (!hasExactKeys(input, keys)) return invalidInput();
    if (!isId(input.document_id)) return invalidInput();
    if (
      typeof input.editor_session_ref !== 'string' ||
      input.editor_session_ref.length > 128 ||
      !SESSION_REF_PATTERN.test(input.editor_session_ref)
    ) {
      return invalidInput();
    }
    if (!isRecord(input.expected_version)) return { ok: false, reason_code: 'STALE_VERSION' };
    if (typeof input.xml !== 'string') return { ok: false, reason_code: 'INVALID_XML' };
    if (!isRecord(input.overlay)) return { ok: false, reason_code: 'INVALID_OVERLAY' };
    return {
      ok: true,
      input: {
        document_id: input.document_id,
        editor_session_ref: input.editor_session_ref,
        expected_version: input.expected_version,
        xml: input.xml,
        overlay: input.overlay,
      },
    };
  }
  if (endpoint === 'document.export') {
    const keys = ['document_id', 'version', 'output_ref', 'format'];
    if (!hasExactKeys(input, keys)) return invalidInput();
    if (!isId(input.document_id) || !isId(input.output_ref)) return invalidInput();
    if (!isRecord(input.version)) return { ok: false, reason_code: 'STALE_VERSION' };
    if (!['drawio', 'json', 'svg'].includes(input.format)) {
      return { ok: false, reason_code: 'UNSUPPORTED_FORMAT' };
    }
    return {
      ok: true,
      input: {
        document_id: input.document_id,
        version: input.version,
        output_ref: input.output_ref,
        format: input.format,
      },
    };
  }
  if (endpoint === 'operation.get') {
    if (!hasExactKeys(input, ['operation_ref']) || !isId(input.operation_ref)) return invalidInput();
    return { ok: true, input: { operation_ref: input.operation_ref } };
  }
  if (endpoint === 'session.close') {
    if (!hasExactKeys(input, ['editor_session_ref'])) return invalidInput();
    if (
      typeof input.editor_session_ref !== 'string' ||
      input.editor_session_ref.length > 128 ||
      !SESSION_REF_PATTERN.test(input.editor_session_ref)
    ) {
      return invalidInput();
    }
    return { ok: true, input: { editor_session_ref: input.editor_session_ref } };
  }
  return { ok: false, reason_code: 'UNKNOWN_ENDPOINT' };
}

/** @returns {{ok:false, reason_code:'INVALID_REQUEST'}} */
function invalidInput() {
  return { ok: false, reason_code: 'INVALID_REQUEST' };
}

/* -------------------------------------------------------------------------- */
/* service                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create the stateless Host RPC adapter around a document store + registry.
 *
 * @param {{registry:any, store:any, clock?:() => any, limits?:Record<string, number>}} options
 *   `registry` is the trusted local `DiagramAccessRegistryV1` instance (used to
 *   resolve `context_ref`/scope generation); `store` is the 06 document store.
 *   `clock` is accepted for interface parity but the store owns all timestamps.
 * @returns {{
 *   handle: (endpoint:string, payload:any, signal?:AbortSignal, peer?:any) => Promise<any>,
 *   dispose: () => Promise<void>,
 *   snapshot: () => {disposed:boolean, operation_cache:number},
 * }}
 */
export function createLocalDiagramsService(options) {
  if (!isRecord(options)) throw new TypeError('createLocalDiagramsService requires an options object');
  const { registry, store } = /** @type {any} */ (options);
  if (!registry || typeof registry.lookupContext !== 'function' || typeof registry.exportToJson !== 'function') {
    throw new TypeError('registry must be a created access registry');
  }
  if (
    !store ||
    typeof store.openDocument !== 'function' ||
    typeof store.saveDiagram !== 'function' ||
    typeof store.exportArtifact !== 'function' ||
    typeof store.getOperation !== 'function' ||
    typeof store.closeEditorSession !== 'function'
  ) {
    throw new TypeError('store must be a created document store');
  }
  const limits = { ...LIMITS, ...(isRecord(options.limits) ? /** @type {any} */ (options).limits : {}) };
  const requestBytes = Number.isSafeInteger(limits.rpc_json_bytes) ? limits.rpc_json_bytes : LIMITS.rpc_json_bytes;
  const responseBytes = Number.isSafeInteger(limits.rpc_response_bytes)
    ? limits.rpc_response_bytes
    : LIMITS.rpc_response_bytes;
  const xmlBytes = Number.isSafeInteger(limits.document_xml_bytes)
    ? limits.document_xml_bytes
    : LIMITS.document_xml_bytes;

  /** @type {Map<string, string>} */
  const operations = new Map();
  let disposed = false;

  /** @param {any} peer @returns {boolean} */
  function isLiveOwner(peer) {
    if (!isRecord(peer)) return false;
    const principal = peer.principal;
    if (!isRecord(principal) || principal.kind !== 'owner') return false;
    if (peer.signal && peer.signal.aborted === true) return false;
    return true;
  }

  /**
   * Final gate: closed-union validation + response byte cap. Never throws.
   * @param {any} response
   * @param {{operation_id:string, view_epoch:number}} fallbackShell
   * @param {number} scopeGeneration
   * @returns {any}
   */
  function finalize(response, fallbackShell, scopeGeneration) {
    let candidate = response;
    if (!responseValid(candidate)) {
      candidate = failureResponse(fallbackShell, scopeGeneration, 'failed', 'INTERNAL_FAILURE');
    }
    try {
      if (utf8Length(JSON.stringify(candidate)) <= responseBytes) return candidate;
    } catch {
      // fall through
    }
    return failureResponse(fallbackShell, scopeGeneration, 'failed', 'LIMIT_EXCEEDED');
  }

  /**
   * Wrap a business response in the rc.5 RpcResult success value. Business
   * rejections (denied/stale/invalid/conflict/unavailable/failed) also travel in
   * `value`; only the transport-level fixed errors use `{ok:false,error}`.
   * @param {any} response
   * @param {{operation_id:string, view_epoch:number}} fallbackShell
   * @param {number} scopeGeneration
   * @returns {{ok:true, value:any}}
   */
  function businessResult(response, fallbackShell, scopeGeneration) {
    return { ok: true, value: finalize(response, fallbackShell, scopeGeneration) };
  }

  /**
   * Resolve the trusted context for one validated shell. No filesystem work.
   * @param {any} shell
   * @returns {{ok:true, entry:any} | {ok:false, reason_code:string}}
   */
  function resolveContext(shell) {
    const lookup = registry.lookupContext(shell.context_ref, shell.expected_scope_generation);
    if (lookup && lookup.ok === true && isRecord(lookup.entry)) return { ok: true, entry: lookup.entry };
    const code = lookup?.code === 'SCOPE_REVOKED' ? 'SCOPE_REVOKED' : 'CONTEXT_UNBOUND';
    return { ok: false, reason_code: code };
  }

  /**
   * Record operation-id idempotency. The digest binds endpoint + context + the
   * exact decoded input; replaying it is allowed (store replay is idempotent),
   * reusing it for another body is rejected.
   * @param {string} operationId
   * @param {string} endpoint
   * @param {any} shell
   * @returns {boolean} false when the id was already bound to another body
   */
  function bindOperation(operationId, endpoint, shell) {
    let digest;
    try {
      digest = sha256Hex(
        canonicalJson({
          endpoint,
          context_ref: shell.context_ref,
          expected_scope_generation: shell.expected_scope_generation,
          input: shell.input,
        }),
      );
    } catch {
      digest = null;
    }
    const existing = operations.get(operationId);
    if (existing !== undefined) return existing === digest;
    if (operations.size >= OPERATION_CACHE_LIMIT) {
      const oldest = operations.keys().next();
      if (oldest.done !== true) operations.delete(oldest.value);
    }
    operations.set(operationId, digest ?? '');
    return true;
  }

  /**
   * @param {string} endpoint
   * @param {any} shell validated request shell
   * @param {any} contextEntry resolved registry context
   * @param {any} input validated endpoint input
   * @param {AbortSignal | undefined} signal
   * @param {any} caller trusted caller envelope (principal + context)
   * @returns {Promise<any>}
   */
  async function dispatch(endpoint, shell, contextEntry, input, signal, caller) {
    const scopeGeneration = contextEntry.scope_generation;
    if (signal?.aborted === true) {
      return failureResponse(shell, scopeGeneration, 'failed', 'CANCELLED');
    }
    if (endpoint === 'document.open') {
      const result = await store.openDocument(
        {
          document_ref: input.document_ref,
          expected_scope: {
            scope_ref: contextEntry.scope_ref,
            scope_generation: contextEntry.scope_generation,
          },
        },
        caller,
      );
      return normalizeBusinessResponse({
        endpoint,
        operation_id: shell.operation_id,
        view_epoch: shell.view_epoch,
        scope_generation: scopeGeneration,
        result,
      });
    }
    if (endpoint === 'document.save') {
      // Local pre-checks give stable reason codes before the store's own
      // authoritative revalidation (store.saveDiagram revalidates the overlay
      // against its canonical base and compares parsed canonical XML semantics).
      if (Buffer.byteLength(input.xml, 'utf8') > xmlBytes) {
        return failureResponse(shell, scopeGeneration, 'invalid', 'LIMIT_EXCEEDED');
      }
      const overlayValidation = validateOverlay(input.overlay);
      if (overlayValidation.ok !== true) {
        return failureResponse(shell, scopeGeneration, 'invalid', 'INVALID_OVERLAY');
      }
      const versionValidation = validateDocumentVersion(input.expected_version);
      if (versionValidation.ok !== true || input.expected_version.document_id !== input.document_id) {
        return failureResponse(shell, scopeGeneration, 'stale', 'STALE_VERSION');
      }
      const parsed = parseDrawioXml(input.xml, { limits });
      if (parsed.ok !== true) {
        const reason =
          parsed.code === 'LIMIT_EXCEEDED'
            ? 'LIMIT_EXCEEDED'
            : parsed.code === 'UNSUPPORTED'
              ? 'UNSUPPORTED_FORMAT'
              : 'INVALID_XML';
        return failureResponse(shell, scopeGeneration, 'invalid', reason);
      }
      const result = await store.saveDiagram(
        {
          document_id: input.document_id,
          editor_session_ref: input.editor_session_ref,
          expected_version: input.expected_version,
          xml: input.xml,
          overlay: input.overlay,
          operation_id: shell.operation_id,
        },
        caller,
        signal,
      );
      return normalizeBusinessResponse({
        endpoint,
        operation_id: shell.operation_id,
        view_epoch: shell.view_epoch,
        scope_generation: scopeGeneration,
        result,
      });
    }
    if (endpoint === 'document.export') {
      const versionValidation = validateDocumentVersion(input.version);
      if (versionValidation.ok !== true || input.version.document_id !== input.document_id) {
        return failureResponse(shell, scopeGeneration, 'stale', 'STALE_VERSION');
      }
      const result = await store.exportArtifact(
        {
          document_id: input.document_id,
          version: input.version,
          output_ref: input.output_ref,
          format: input.format,
        },
        caller,
      );
      return normalizeBusinessResponse({
        endpoint,
        operation_id: shell.operation_id,
        view_epoch: shell.view_epoch,
        scope_generation: scopeGeneration,
        result,
      });
    }
    if (endpoint === 'operation.get') {
      const result = await store.getOperation({ operation_ref: input.operation_ref }, caller);
      return normalizeBusinessResponse({
        endpoint,
        operation_id: shell.operation_id,
        view_epoch: shell.view_epoch,
        scope_generation: scopeGeneration,
        result,
      });
    }
    if (endpoint === 'session.close') {
      const result = await store.closeEditorSession({ editor_session_ref: input.editor_session_ref }, caller);
      return normalizeBusinessResponse({
        endpoint,
        operation_id: shell.operation_id,
        view_epoch: shell.view_epoch,
        scope_generation: scopeGeneration,
        result,
      });
    }
    return failureResponse(shell, scopeGeneration, 'invalid', 'UNKNOWN_ENDPOINT');
  }

  /**
   * rc.5 connection RPC handler. Never throws.
   * @param {string} endpoint
   * @param {any} payload decoded request shell
   * @param {AbortSignal} [signal]
   * @param {any} [peer]
   * @returns {Promise<any>} RpcResult
   */
  async function handle(endpoint, payload, signal, peer) {
    if (disposed) return transportError('INTERNAL_FAILURE');
    if (!isLiveOwner(peer)) return transportError('OWNER_REQUIRED');

    // Strict closed-union shell validation. A shell that cannot even echo
    // operation_id/view_epoch cannot be answered with a schema-valid business
    // response, so it gets a fixed transport-level error instead.
    const shellValidation = validateRpcRequest(payload);
    if (shellValidation.ok !== true) return transportError('INVALID_REQUEST');
    const shell = shellValidation.value;

    const fallbackShell = { operation_id: shell.operation_id, view_epoch: shell.view_epoch };
    if (!ENDPOINT_SET.has(endpoint)) {
      const contextProbe = resolveContext(shell);
      const scopeGeneration = contextProbe.ok === true ? contextProbe.entry.scope_generation : shell.expected_scope_generation;
      return businessResult(
        failureResponse(fallbackShell, scopeGeneration, 'invalid', 'UNKNOWN_ENDPOINT'),
        fallbackShell,
        scopeGeneration,
      );
    }

    let serialized = null;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return transportError('INVALID_REQUEST');
    }
    if (utf8Length(serialized) > requestBytes) {
      const contextProbe = resolveContext(shell);
      const scopeGeneration = contextProbe.ok === true ? contextProbe.entry.scope_generation : shell.expected_scope_generation;
      return businessResult(
        failureResponse(fallbackShell, scopeGeneration, 'invalid', 'LIMIT_EXCEEDED'),
        fallbackShell,
        scopeGeneration,
      );
    }

    try {
      if (!bindOperation(shell.operation_id, endpoint, shell)) {
        const contextProbe = resolveContext(shell);
        const scopeGeneration = contextProbe.ok === true ? contextProbe.entry.scope_generation : shell.expected_scope_generation;
        return businessResult(
          failureResponse(fallbackShell, scopeGeneration, 'invalid', 'OPERATION_CONFLICT'),
          fallbackShell,
          scopeGeneration,
        );
      }
      const context = resolveContext(shell);
      if (context.ok !== true) {
        return businessResult(
          failureResponse(fallbackShell, shell.expected_scope_generation, 'denied', context.reason_code),
          fallbackShell,
          shell.expected_scope_generation,
        );
      }
      const scopeGeneration = context.entry.scope_generation;
      const inputValidation = validateEndpointInput(endpoint, shell.input);
      if (inputValidation.ok !== true) {
        const status =
          inputValidation.reason_code === 'STALE_VERSION'
            ? 'stale'
            : inputValidation.reason_code === 'UNKNOWN_ENDPOINT'
              ? 'invalid'
              : 'invalid';
        return businessResult(
          failureResponse(fallbackShell, scopeGeneration, status, inputValidation.reason_code),
          fallbackShell,
          scopeGeneration,
        );
      }
      /** @type {any} */
      const caller = {
        principal: { .../** @type {any} */ (peer).principal },
        context: {
          scope_ref: context.entry.scope_ref,
          scope_generation: context.entry.scope_generation,
        },
      };
      const response = await dispatch(
        endpoint,
        shell,
        context.entry,
        inputValidation.input,
        signal,
        caller,
      );
      return businessResult(response, fallbackShell, scopeGeneration);
    } catch (error) {
      // Fixed failure only: no error.message, path, stack, config or XML text.
      const contextProbe = resolveContext(shell);
      const scopeGeneration = contextProbe.ok === true ? contextProbe.entry.scope_generation : shell.expected_scope_generation;
      const reason =
        isDiagramError(error) && typeof error.code === 'string' && REASON_CODE_SET.has(error.code)
          ? error.code
          : 'INTERNAL_FAILURE';
      return businessResult(
        failureResponse(fallbackShell, scopeGeneration, 'failed', reason),
        fallbackShell,
        scopeGeneration,
      );
    }
  }

  /** Drop editor sessions and permanently reject further calls. */
  async function dispose() {
    if (disposed) return;
    disposed = true;
    operations.clear();
    try {
      if (typeof store.dispose === 'function') await store.dispose();
    } catch {
      // Disposal is best effort; the channel is removed by the plugin fiber.
    }
  }

  /** Sanitized test/inspection view; never contains paths or payload data. */
  function snapshot() {
    return { disposed, operation_cache: operations.size };
  }

  return { handle, dispose, snapshot };
}

export { CODES };
