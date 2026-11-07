/**
 * Save/conflict state helpers for the local editor panel (ui/conflict.mjs).
 *
 * DIA-DESIGN-2 §8: a stale `expected_version` is a conflict, never an automatic
 * retry with a fresh token; the user keeps both sides, exports the local draft,
 * or reopens explicitly. When a write outcome is unknown the UI offers a
 * scoped `operation.get` poll (one in flight, stop on panel close/scope change)
 * instead of blind resubmission.
 *
 * Pure module: state machines and fixed UI text only, no DOM and no transport.
 */

/** Fixed user-facing text per save reason code; never echo server messages. */
export const SAVE_REASON_MESSAGES = Object.freeze({
  STALE_VERSION: 'The document changed in another view. Nothing was overwritten.',
  EDITOR_SESSION_EXPIRED: 'The editor session expired. Reopen the document to continue.',
  DOCUMENT_DENIED: 'This document is no longer available for editing.',
  SCOPE_REVOKED: 'The workspace scope changed. Reopen the document from the registered reference.',
  CONTEXT_UNBOUND: 'This document is not registered in the current scope.',
  INVALID_XML: 'The editor produced XML the local validator rejected. Your draft was not saved.',
  INVALID_OVERLAY: 'The local annotation overlay does not match the document base. Nothing was saved.',
  LIMIT_EXCEEDED: 'The document or overlay exceeds the local size limits.',
  UNSUPPORTED_FORMAT: 'The requested export format is not supported locally.',
  OUTCOME_UNKNOWN: 'The save result is unknown. Check the operation status before retrying.',
  CANCELLED: 'The save was cancelled before it completed.',
  OPERATION_CONFLICT: 'This save operation was already used with different content. Reopen and save again.',
  EXPORT_EXISTS: 'A file with this name already exists in the output directory. Nothing was overwritten.',
  INTERNAL_FAILURE: 'The local editor failed unexpectedly. Nothing was overwritten.',
  OWNER_REQUIRED: 'The local editor channel requires the application owner session.',
  UNKNOWN_ENDPOINT: 'The local editor channel does not support this action.',
  INVALID_REQUEST: 'The editor sent an invalid request.',
});

/** Actions offered for each save failure. */
export const SAVE_ACTIONS = Object.freeze({
  STALE_VERSION: Object.freeze(['keep_both', 'export_draft', 'reopen']),
  OUTCOME_UNKNOWN: Object.freeze(['check_status', 'export_draft']),
  CANCELLED: Object.freeze(['check_status', 'export_draft']),
});

export const CONFLICT_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'keep_both',
    label: 'Keep both',
    description: 'Reopen the current Host version, rebase the local annotations onto it and save as a new revision.',
  }),
  Object.freeze({
    id: 'export_draft',
    label: 'Export draft',
    description: 'Download the local XML + overlay draft as a JSON file. Nothing is written to the document.',
  }),
  Object.freeze({
    id: 'reopen',
    label: 'Reopen',
    description: 'Discard the local draft and reload the current Host version.',
  }),
]);

const OPTION_IDS = new Set(CONFLICT_OPTIONS.map((option) => option.id));

/**
 * Describe the failure state for the panel.
 * @param {{status:string, reason_code:string, data?:any}} failure
 * @returns {{title:string, message:string, actions:string[], conflict:any|null}}
 */
export function describeSaveFailure(failure) {
  const reason = typeof failure?.reason_code === 'string' ? failure.reason_code : 'INTERNAL_FAILURE';
  const message = SAVE_REASON_MESSAGES[reason] ?? SAVE_REASON_MESSAGES.INTERNAL_FAILURE;
  if (failure?.status === 'conflict') {
    return {
      title: 'Save conflict',
      message,
      actions: [...(SAVE_ACTIONS.STALE_VERSION ?? [])],
      conflict: {
        current_version: failure?.data?.current_version ?? null,
        draft_ref: typeof failure?.data?.draft_ref === 'string' ? failure.data.draft_ref : null,
      },
    };
  }
  if (reason === 'OUTCOME_UNKNOWN' || reason === 'CANCELLED') {
    return { title: 'Save status unknown', message, actions: [...SAVE_ACTIONS.OUTCOME_UNKNOWN], conflict: null };
  }
  if (reason === 'STALE_VERSION') {
    return { title: 'Save conflict', message, actions: [...SAVE_ACTIONS.STALE_VERSION], conflict: null };
  }
  return { title: 'Save failed', message, actions: [], conflict: null };
}

/**
 * Build the conflict view model.
 * @param {{current_version:any, draft_ref?:string|null, local_overlay?:any, document_id?:string}} input
 * @returns {any}
 */
export function conflictView(input) {
  const currentVersion = input?.current_version ?? null;
  return {
    kind: 'conflict',
    title: 'Save conflict',
    message: SAVE_REASON_MESSAGES.STALE_VERSION,
    options: CONFLICT_OPTIONS.map((option) => ({ ...option })),
    current_version: currentVersion,
    current_generation: Number.isSafeInteger(currentVersion?.generation) ? currentVersion.generation : null,
    draft_ref: typeof input?.draft_ref === 'string' ? input.draft_ref : null,
    has_local_state: input?.local_overlay !== undefined && input?.local_overlay !== null,
  };
}

/**
 * Resolve the user's conflict choice into a plan. The panel executes the plan;
 * this function only validates and describes it.
 *
 * @param {{choice:string, current_version:any, local?:{base_spec?:any, overlay?:any}}} input
 * @returns {{ok:true, action:'reopen_then_resave'|'download_draft'|'reopen', expected_version:any} | {ok:false, code:string}}
 */
export function resolveConflict(input) {
  if (typeof input?.choice !== 'string' || !OPTION_IDS.has(input.choice)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  if (input.choice === 'export_draft') {
    return { ok: true, action: 'download_draft', expected_version: null };
  }
  const currentVersion = input?.current_version;
  if (!currentVersion || typeof currentVersion !== 'object' || !Number.isSafeInteger(currentVersion.generation)) {
    return { ok: false, code: 'STALE_VERSION' };
  }
  if (input.choice === 'keep_both') {
    return { ok: true, action: 'reopen_then_resave', expected_version: currentVersion };
  }
  return { ok: true, action: 'reopen', expected_version: currentVersion };
}

/**
 * Plan an `operation.get` poll for an unknown save outcome.
 * @param {{attempt:number, max_attempts?:number, operation_ref:string, state?:string}} input
 * @returns {{poll:boolean, delay_ms:number, operation_ref:string|null, next_attempt:number, stop_reason:string|null}}
 */
export function operationPollPlan(input) {
  const attempt = Number.isSafeInteger(input?.attempt) && input.attempt >= 0 ? input.attempt : 0;
  const maxAttempts = Number.isSafeInteger(input?.max_attempts) ? input.max_attempts : 30;
  const operationRef = typeof input?.operation_ref === 'string' && input.operation_ref.length > 0 ? input.operation_ref : null;
  if (operationRef === null) {
    return { poll: false, delay_ms: 0, operation_ref: null, next_attempt: attempt, stop_reason: 'no_operation_ref' };
  }
  if (attempt >= maxAttempts) {
    return { poll: false, delay_ms: 0, operation_ref: operationRef, next_attempt: attempt, stop_reason: 'max_attempts' };
  }
  if (input?.state === 'saved' || input?.state === 'failed') {
    return { poll: false, delay_ms: 0, operation_ref: operationRef, next_attempt: attempt, stop_reason: `state_${input.state}` };
  }
  return { poll: true, delay_ms: 1000, operation_ref: operationRef, next_attempt: attempt + 1, stop_reason: null };
}

/**
 * Should the panel accept a response for the current view epoch? Stale-epoch
 * responses are ignored instead of overwriting a replaced document view.
 * @param {{response_view_epoch:number, current_view_epoch:number}} input
 * @returns {boolean}
 */
export function acceptsViewEpoch(input) {
  return (
    Number.isSafeInteger(input?.response_view_epoch) &&
    Number.isSafeInteger(input?.current_view_epoch) &&
    input.response_view_epoch === input.current_view_epoch
  );
}

/**
 * Describe the operation.get result for an unknown save.
 * @param {{state:string, version?:any, reason_code?:string}} data
 * @returns {{state:string, message:string, recovered_version:any|null}}
 */
export function describeOperationResult(data) {
  const state = typeof data?.state === 'string' ? data.state : 'unknown';
  if (state === 'saved') {
    return { state, message: 'The save completed on the Host.', recovered_version: data?.version ?? null };
  }
  if (state === 'failed') {
    const reason = typeof data?.reason_code === 'string' ? data.reason_code : 'INTERNAL_FAILURE';
    return {
      state,
      message: SAVE_REASON_MESSAGES[reason] ?? SAVE_REASON_MESSAGES.INTERNAL_FAILURE,
      recovered_version: null,
    };
  }
  if (state === 'pending' || state === 'revision_written') {
    return { state, message: 'The save is still being finalized on the Host.', recovered_version: null };
  }
  return { state: 'unknown', message: 'No Host record of this operation was found.', recovered_version: null };
}
