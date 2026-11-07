/**
 * 08 workbench navigation descriptor + client adapter contract for 06.
 *
 * DIA-10 / DIA-DESIGN-2 §9.1: the 08 entry point only produces a navigation
 * intent. It never holds XML, a base spec, an overlay, a version token or a
 * filesystem path, and it never saves on 06's behalf. The 08 *client* adapter is
 * the only party that calls `ctx.layout.selectPanel('local-diagrams')`; the
 * actual open request is delivered to the 06 main panel through a local
 * in-page event whose payload is a set of registry references, and the 06 Host
 * RPC channel re-validates every reference against the trusted access registry.
 *
 * This module is pure and has no DOM/Node globals at import time; the browser
 * panel re-uses `OPEN_EVENT` (inlined by tools/build-client.mjs) so producer and
 * consumer cannot drift.
 */

import { PATTERNS } from './contracts.mjs';

/** Capability number owned by this package. */
export const CAPABILITY = '06';
/** Navigation intent id (stable; part of the 08 adapter contract). */
export const INTENT = 'open-diagram';
/** Main keyed-slot panel id registered by the client bundle. */
export const PANEL_ID = 'local-diagrams';
/** Authenticated Host RPC channel. */
export const CHANNEL = '/local-diagrams';
/** In-page event that carries an open request from a navigation adapter. */
export const OPEN_EVENT = 'dsh-local-diagrams:open';
/** Event schema marker; unknown versions are ignored by the panel. */
export const OPEN_EVENT_VERSION = 1;

/** Same ref pattern as the RPC contract (`PATTERNS.id`). */
const REF_PATTERN = new RegExp(PATTERNS.id, 'u');

/** Fields a navigation intent may never carry (data/elevation surface). */
export const FORBIDDEN_INTENT_FIELDS = Object.freeze([
  'xml',
  'drawio',
  'base_spec',
  'overlay',
  'annotations',
  'version',
  'expected_version',
  'path',
  'path_ref',
  'url',
  'data',
  'caller',
  'grant',
  'scope_ref',
  'document_id',
]);

/**
 * The descriptor 08 consumes. Frozen, tiny, no document state.
 * @returns {{schema_version:1, capability:string, intent:string, panel:string, channel:string}}
 */
export function navigationDescriptor() {
  return Object.freeze({
    schema_version: 1,
    capability: CAPABILITY,
    intent: INTENT,
    panel: PANEL_ID,
    channel: CHANNEL,
  });
}

/** Frozen singleton of {@link navigationDescriptor}. */
export const NAVIGATION_DESCRIPTOR = navigationDescriptor();

/**
 * The client-side adapter contract: what 08's client half is allowed to do.
 * It receives an intent, validates it, selects the 06 main panel, and publishes
 * the references through {@link OPEN_EVENT}. It is not allowed to open documents
 * itself, hold editor state, or pass data through.
 */
export const CLIENT_ADAPTER_CONTRACT = Object.freeze({
  schema_version: 1,
  capability: CAPABILITY,
  intent: INTENT,
  panel: PANEL_ID,
  open_event: OPEN_EVENT,
  open_event_version: OPEN_EVENT_VERSION,
  steps: Object.freeze([
    'validateIntent',
    'selectPanel(local-diagrams)',
    'publishOpenEvent({document_ref, context_ref, expected_scope_generation})',
  ]),
  allowed_intent_fields: Object.freeze(['document_ref', 'context_ref', 'expected_scope_generation']),
  forbidden_intent_fields: FORBIDDEN_INTENT_FIELDS,
  holds_document_state: false,
  calls_host_save: false,
});

/** @param {unknown} value @returns {boolean} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {boolean} */
function isRef(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && REF_PATTERN.test(value);
}

/**
 * @param {string} path
 * @param {string} message
 * @returns {{path:string, keyword:string, message:string}}
 */
function issue(path, message) {
  return { path, keyword: 'invalid_navigation_intent', message };
}

/**
 * Validate a navigation intent or the raw `{document_ref, context_ref,
 * expected_scope_generation}` input. Closed object: no extra fields, explicit
 * denial of data/elevation fields, registry references only (never a path).
 *
 * @param {unknown} value
 * @returns {{ok:true, intent:{document_ref:string, context_ref:string, expected_scope_generation:number}} | {ok:false, errors:Array<{path:string,keyword:string,message:string}>}}
 */
export function validateOpenIntent(value) {
  /** @type {Array<{path:string,keyword:string,message:string}>} */
  const errors = [];
  if (!isRecord(value)) {
    errors.push(issue('$', 'intent must be an object'));
    return { ok: false, errors };
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_INTENT_FIELDS.includes(key)) {
      errors.push(issue(`$.${key}`, `navigation intents must not carry "${key}"; 08 holds no document state`));
    }
  }
  const allowed = ['document_ref', 'context_ref', 'expected_scope_generation'];
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) errors.push(issue(`$.${key}`, `missing ${key}`));
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(issue(`$.${key}`, `unexpected field "${key}"`));
  }
  if (Object.hasOwn(value, 'document_ref') && !isRef(value.document_ref)) {
    errors.push(issue('$.document_ref', 'document_ref must be a registry reference (1-128 id chars), not a path'));
  }
  if (Object.hasOwn(value, 'context_ref') && !isRef(value.context_ref)) {
    errors.push(issue('$.context_ref', 'context_ref must be a registered context reference'));
  }
  if (
    Object.hasOwn(value, 'expected_scope_generation') &&
    (typeof value.expected_scope_generation !== 'number' ||
      !Number.isSafeInteger(value.expected_scope_generation) ||
      value.expected_scope_generation < 0)
  ) {
    errors.push(issue('$.expected_scope_generation', 'expected_scope_generation must be a non-negative safe integer'));
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    intent: {
      document_ref: value.document_ref,
      context_ref: value.context_ref,
      expected_scope_generation: value.expected_scope_generation,
    },
  };
}

/**
 * Build a validated open intent for 08 to hand to the client adapter.
 * @param {{document_ref:string, context_ref:string, expected_scope_generation:number}} input
 * @returns {ReturnType<typeof validateOpenIntent>}
 */
export function createOpenIntent(input) {
  return validateOpenIntent(input);
}

/**
 * The open-event payload the 06 panel consumes. Kept separate from the intent
 * so a producer can never inject `view_epoch` or command payloads.
 *
 * @param {{document_ref:string, context_ref:string, expected_scope_generation:number}} input
 * @returns {{ok:true, type:string, version:1, detail:{document_ref:string, context_ref:string, expected_scope_generation:number}} | {ok:false, errors:any[]}}
 */
export function createOpenEventDetail(input) {
  const validated = validateOpenIntent(input);
  if (validated.ok !== true) return { ok: false, errors: validated.errors };
  return {
    ok: true,
    type: OPEN_EVENT,
    version: OPEN_EVENT_VERSION,
    detail: {
      document_ref: validated.intent.document_ref,
      context_ref: validated.intent.context_ref,
      expected_scope_generation: validated.intent.expected_scope_generation,
    },
  };
}

/**
 * Apply one navigation intent through a 08 client adapter. The adapter object
 * is injected (never global) so this function is Node-testable and the caller
 * cannot smuggle extra capabilities.
 *
 * @param {{selectPanel:(panelId:string)=>void, publishOpen:(detail:any)=>void}} adapter
 * @param {unknown} intent
 * @returns {{ok:true, panel:string, published:any} | {ok:false, errors:Array<{path:string,keyword:string,message:string}>}}
 */
export function applyNavigationIntent(adapter, intent) {
  if (!isRecord(adapter) || typeof adapter.selectPanel !== 'function' || typeof adapter.publishOpen !== 'function') {
    return {
      ok: false,
      errors: [issue('$.adapter', 'adapter needs selectPanel(panelId) and publishOpen(detail) functions')],
    };
  }
  const validated = validateOpenIntent(intent);
  if (validated.ok !== true) return { ok: false, errors: validated.errors };
  const detail = {
    document_ref: validated.intent.document_ref,
    context_ref: validated.intent.context_ref,
    expected_scope_generation: validated.intent.expected_scope_generation,
  };
  adapter.selectPanel(PANEL_ID);
  adapter.publishOpen(detail);
  return { ok: true, panel: PANEL_ID, published: detail };
}

/**
 * Validate an event detail received by the 06 panel. Unknown/unsafe payloads
 * are rejected; the panel then asks the Host, which re-checks the registry.
 * @param {unknown} detail
 * @returns {ReturnType<typeof validateOpenIntent>}
 */
export function validateOpenEventDetail(detail) {
  return validateOpenIntent(detail);
}
