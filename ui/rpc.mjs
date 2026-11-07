/**
 * Client-side RPC envelope helpers for the rc.5 connection channel.
 *
 * Frozen behaviour (docs/software-design.md §9 DIA-RPC-01):
 *  - `ctx.connection.rpc.call(channel, endpoint, payload, signal)` returns the
 *    RpcResult itself, NOT the business value. The client must check
 *    `result.ok === true` first and only then validate `result.value`.
 *  - A transport failure (`{ok:false,error}` or a malformed envelope) maps to the
 *    fixed `TRANSPORT_FAILURE`; the raw message/details are never displayed and
 *    a write is never retried automatically.
 *  - Business responses are validated against the closed union before any UI
 *    state is updated. A response carrying an older `view_epoch` than the
 *    request is `stale_epoch`: it is ignored instead of overwriting the current
 *    document.
 *  - Request shells are the strict closed union
 *    `{schema_version,operation_id,context_ref,expected_scope_generation,
 *    view_epoch,input}`.
 *
 * Pure module: no DOM globals, no network access; the transport is injected.
 */

/** The one channel owned by this plugin. */
export const CHANNEL = '/local-diagrams';

export const STATUSES = Object.freeze(['ok', 'denied', 'stale', 'invalid', 'conflict', 'unavailable', 'failed']);

/** Fixed reason codes the client accepts from the Host (mirror of the service). */
export const REASON_CODES = Object.freeze([
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
  'INVALID_REQUEST',
  'OPERATION_CONFLICT',
  'EXPORT_EXISTS',
  'UNSUPPORTED_FORMAT',
  'OUTCOME_UNKNOWN',
  'CANCELLED',
]);

const STATUS_SET = new Set(STATUSES);
const REASON_SET = new Set(REASON_CODES);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~=-]*$/u;
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

const OK_KEYS = Object.freeze(['schema_version', 'operation_id', 'view_epoch', 'scope_generation', 'status', 'data']);
const FAILURE_KEYS = Object.freeze(['schema_version', 'operation_id', 'view_epoch', 'scope_generation', 'status', 'reason_code']);

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {boolean} */
function isId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && ID_PATTERN.test(value);
}

/** @param {unknown} value @returns {boolean} */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {Record<string, any>} value
 * @param {readonly string[]} keys
 * @returns {boolean}
 */
function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  return keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Build and client-validate a request shell.
 * @param {{operation_id:string, context_ref:string, expected_scope_generation:number, view_epoch:number, input:Record<string, any>}} input
 * @returns {{ok:true, request:any} | {ok:false, errors:Array<{path:string,message:string}>}}
 */
export function buildRequest(input) {
  /** @type {Array<{path:string,message:string}>} */
  const errors = [];
  if (!isRecord(input)) return { ok: false, errors: [{ path: '$', message: 'request input must be an object' }] };
  if (!isId(input.operation_id)) errors.push({ path: '$.operation_id', message: 'operation_id must be a 1-128 id' });
  if (!isId(input.context_ref)) errors.push({ path: '$.context_ref', message: 'context_ref must be a 1-128 id' });
  if (!isCount(input.expected_scope_generation)) {
    errors.push({ path: '$.expected_scope_generation', message: 'expected_scope_generation must be a non-negative integer' });
  }
  if (!isCount(input.view_epoch)) errors.push({ path: '$.view_epoch', message: 'view_epoch must be a non-negative integer' });
  if (!isRecord(input.input)) errors.push({ path: '$.input', message: 'input must be an object' });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    request: {
      schema_version: 1,
      operation_id: input.operation_id,
      context_ref: input.context_ref,
      expected_scope_generation: input.expected_scope_generation,
      view_epoch: input.view_epoch,
      input: input.input,
    },
  };
}

/** Fixed, non-echoing description for {@link interpretRpcResult} transport failures. */
export const TRANSPORT_FAILURE = Object.freeze({
  kind: 'transport_failure',
  code: 'TRANSPORT_FAILURE',
  message: 'The local editor channel is unavailable. No changes were applied.',
});

/**
 * Interpret one RpcResult for one request. Never throws, never echoes server
 * error text. The caller must not apply UI state for `transport_failure`,
 * `stale_epoch` or `invalid_response`.
 *
 * @param {unknown} result
 * @param {{request:any, expected_scope_generation:number}} expected
 * @returns {{kind:'ok', data:any, scope_generation:number} |
 *           {kind:'business_failure', status:string, reason_code:string, data?:any} |
 *           {kind:'transport_failure', code:string, message:string} |
 *           {kind:'stale_epoch'} |
 *           {kind:'invalid_response', code:string, message:string}}
 */
export function interpretRpcResult(result, expected) {
  // A transport that resolves to anything but an RpcResult object is a
  // protocol-level failure; never inspect or display its contents.
  if (!isRecord(result)) return { ...TRANSPORT_FAILURE };
  if (result.ok !== true) {
    // `{ok:false,error:{code,message,details}}` from the Host transport layer;
    // the raw message/details are deliberately not surfaced.
    return { ...TRANSPORT_FAILURE };
  }
  const response = result.value;
  if (!isRecord(response)) return invalidResponse();
  if (response.schema_version !== 1) return invalidResponse();
  if (!isId(response.operation_id) || !isCount(response.view_epoch) || !isCount(response.scope_generation)) {
    return invalidResponse();
  }
  const request = expected?.request;
  if (!isRecord(request) || response.operation_id !== request.operation_id) return invalidResponse();
  if (response.scope_generation !== expected.expected_scope_generation) return invalidResponse();
  if (response.view_epoch < request.view_epoch) return { kind: 'stale_epoch' };
  if (response.view_epoch !== request.view_epoch) return invalidResponse();
  if (!STATUS_SET.has(response.status)) return invalidResponse();
  if (response.status === 'ok') {
    if (!hasExactKeys(response, OK_KEYS) || !isRecord(response.data)) return invalidResponse();
    return { kind: 'ok', data: response.data, scope_generation: response.scope_generation };
  }
  if (typeof response.reason_code !== 'string' || !REASON_PATTERN.test(response.reason_code)) {
    return invalidResponse();
  }
  if (!REASON_SET.has(response.reason_code)) return invalidResponse();
  if (response.status === 'conflict') {
    if (!hasExactKeys(response, FAILURE_KEYS) && Object.keys(response).length !== FAILURE_KEYS.length + 1) {
      return invalidResponse();
    }
    const extras = Object.keys(response).filter((key) => !FAILURE_KEYS.includes(key));
    if (extras.length > 1 || (extras.length === 1 && extras[0] !== 'data')) return invalidResponse();
    if (Object.hasOwn(response, 'data') && !isRecord(response.data)) return invalidResponse();
  } else if (!hasExactKeys(response, FAILURE_KEYS)) {
    return invalidResponse();
  }
  return {
    kind: 'business_failure',
    status: response.status,
    reason_code: response.reason_code,
    ...(Object.hasOwn(response, 'data') ? { data: response.data } : {}),
  };
}

/** @returns {{kind:'invalid_response', code:string, message:string}} */
function invalidResponse() {
  return {
    kind: 'invalid_response',
    code: 'INVALID_RESPONSE',
    message: 'The local editor channel returned an unexpected response. No changes were applied.',
  };
}

/**
 * Call one endpoint through an injected rc.5-style transport and interpret the
 * result. `transport.call` must have the `(channel, endpoint, payload, signal)`
 * signature; the returned promise resolves to the RpcResult.
 *
 * @param {{call:(channel:string, endpoint:string, payload:any, signal?:AbortSignal)=>Promise<any>}} transport
 * @param {string} endpoint
 * @param {any} request
 * @param {AbortSignal} [signal]
 * @param {number} [expectedScopeGeneration]
 * @returns {Promise<ReturnType<typeof interpretRpcResult>>}
 */
export async function callEndpoint(transport, endpoint, request, signal, expectedScopeGeneration) {
  const expected = {
    request,
    expected_scope_generation:
      typeof expectedScopeGeneration === 'number'
        ? expectedScopeGeneration
        : isRecord(request)
          ? request.expected_scope_generation
          : 0,
  };
  /** @type {any} */
  let result;
  try {
    result = await transport.call(CHANNEL, endpoint, request, signal);
  } catch {
    // Transport throw (network/HTTP/rpcId mismatch): fixed failure, no retry.
    return { ...TRANSPORT_FAILURE };
  }
  return interpretRpcResult(result, expected);
}

/**
 * Deterministic unique operation ids for one editing session.
 * @param {string} prefix
 * @param {number} sequence
 * @returns {string}
 */
export function makeOperationId(prefix, sequence) {
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 48) || 'op';
  const id = `${safePrefix}-${String(sequence).padStart(6, '0')}`;
  return id.length <= 128 ? id : id.slice(0, 128);
}

/** @param {string} documentId @param {number} generation @param {string} format @returns {string} */
export function exportFileName(documentId, generation, format) {
  const safeId = String(documentId).replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 64) || 'diagram';
  return `diagram-${safeId}-g${Math.max(0, Math.trunc(generation))}.${format}`;
}
