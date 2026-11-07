/**
 * Pure editor interaction helpers for the local SVG editor (ui/commands.mjs).
 *
 * Maps DOM-free interaction state to the frozen DIA-API-EDIT command union from
 * docs/software-design.md §7; the actual command semantics live in
 * `src/editor/model.mjs` (inlined into the built client bundle). Keeping the
 * mapping here means drag/keyboard/form behaviour is Node-testable without a
 * DOM and the panel stays a thin renderer.
 *
 * Rules encoded here:
 *  - pointer drag uses a captured pointer id, moves are visual only, and exactly
 *    one `move_node` command is committed on pointerup; cancel commits nothing;
 *  - keyboard arrows move 8 px, Shift+arrows 1 px;
 *  - a coordinate form is the no-drag fallback (integers inside the overlay
 *    coordinate range);
 *  - every command carries `command_id` and `expected_draft_revision` and is
 *    applied through `executeEdit`, never fabricated by the RPC layer.
 */

import { executeEdit } from '../src/editor/model.mjs';

export const KEYBOARD_STEP = 8;
export const KEYBOARD_FINE_STEP = 1;
export const POSITION_MIN = -100000;
export const POSITION_MAX = 100000;
export const DEFAULT_POSITION = Object.freeze({ x: 0, y: 0, width: 160, height: 64 });
export const ARROW_KEYS = Object.freeze(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~=-]*$/u;

/** @param {unknown} value @returns {boolean} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {boolean} */
function isSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Clamp one coordinate into the overlay range.
 * @param {number} value
 * @returns {number}
 */
export function clampCoordinate(value) {
  const rounded = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(POSITION_MAX, Math.max(POSITION_MIN, rounded));
}

/**
 * @param {number} value
 * @returns {boolean}
 */
function inCoordinateRange(value) {
  return isSafeInteger(value) && value >= POSITION_MIN && value <= POSITION_MAX;
}

/**
 * Build a deterministic, unique command id (the model dedupes on it).
 * @param {string} kind
 * @param {number} draftRevision
 * @param {number} sequence
 * @returns {string}
 */
export function makeCommandId(kind, draftRevision, sequence) {
  const id = `cmd:${String(kind).slice(0, 32)}:${Math.max(0, Math.trunc(draftRevision))}:${Math.max(0, Math.trunc(sequence))}`;
  return id.length <= 128 ? id : id.slice(0, 128);
}

/**
 * Hidden-safe node position lookup used for drag start and keyboard moves.
 * Reads an annotation node position, then a layout override, then the base
 * layout, then the default node size. `baseSpec` is the canonical base spec the
 * panel received from `document.open` (the editor model keeps it non-enumerable).
 *
 * @param {any} model EditorModelV1
 * @param {string} nodeId
 * @param {any} [baseSpec]
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
export function nodePosition(model, nodeId, baseSpec) {
  if (!isRecord(model) || !isRecord(model.overlay)) return null;
  const items = Array.isArray(model.overlay.items) ? model.overlay.items : [];
  const annotation = items.find((item) => item.id === nodeId && item.kind === 'annotation_node');
  if (annotation !== undefined) return annotation.position;
  const layout = items.find((item) => item.kind === 'layout' && item.target_ref === nodeId);
  if (layout !== undefined) return layout.position;
  const positions = Array.isArray(baseSpec?.layout?.positions) ? baseSpec.layout.positions : [];
  const fromSpec = positions.find((entry) => entry?.node_id === nodeId);
  if (fromSpec !== undefined) return fromSpec;
  return null;
}

/**
 * Begin one pointer drag. `position` is the node's current rectangle.
 * @param {{node_id:string, pointer_id:number, position:{x:number,y:number,width:number,height:number}, client_x:number, client_y:number}} input
 * @returns {{ok:true, drag:any} | {ok:false, errors:Array<{path:string,message:string}>}}
 */
export function beginDrag(input) {
  if (!isRecord(input) || typeof input.node_id !== 'string' || input.node_id.length === 0) {
    return { ok: false, errors: [{ path: '$.node_id', message: 'node_id is required' }] };
  }
  if (!isSafeInteger(input.pointer_id)) {
    return { ok: false, errors: [{ path: '$.pointer_id', message: 'pointer_id must be an integer' }] };
  }
  const position = isRecord(input.position) ? input.position : DEFAULT_POSITION;
  if (!Number.isFinite(input.client_x) || !Number.isFinite(input.client_y)) {
    return { ok: false, errors: [{ path: '$.client_x', message: 'drag start needs finite client coordinates' }] };
  }
  return {
    ok: true,
    drag: {
      node_id: input.node_id,
      pointer_id: input.pointer_id,
      start_client_x: input.client_x,
      start_client_y: input.client_y,
      start_x: inCoordinateRange(position.x) ? position.x : 0,
      start_y: inCoordinateRange(position.y) ? position.y : 0,
      moved: false,
      committed: false,
    },
  };
}

/**
 * Visual-only drag update: returns the candidate position (clamped ints).
 * @param {any} drag
 * @param {{client_x:number, client_y:number}} point
 * @returns {{x:number,y:number,dx:number,dy:number}}
 */
export function updateDrag(drag, point) {
  const dx = Number.isFinite(point?.client_x) ? point.client_x - drag.start_client_x : 0;
  const dy = Number.isFinite(point?.client_y) ? point.client_y - drag.start_client_y : 0;
  return {
    x: clampCoordinate(drag.start_x + dx),
    y: clampCoordinate(drag.start_y + dy),
    dx,
    dy,
  };
}

/**
 * Commit exactly one move command on pointerup. A cancelled drag commits
 * nothing; a drag whose position did not change still yields a single command
 * (idempotent layout write) so the UI history matches the pointer gesture.
 *
 * @param {any} drag
 * @param {{client_x?:number, client_y?:number}} [point]
 * @returns {{ok:true, payload:{node_id:string,x:number,y:number}} | {ok:false, errors:Array<{path:string,message:string}>}}
 */
export function commitDrag(drag, point) {
  if (!isRecord(drag) || drag.committed === true) {
    return { ok: false, errors: [{ path: '$', message: 'drag is not active' }] };
  }
  const clientX = Number.isFinite(point?.client_x) ? point.client_x : drag.start_client_x;
  const clientY = Number.isFinite(point?.client_y) ? point.client_y : drag.start_client_y;
  const next = updateDrag(drag, { client_x: clientX, client_y: clientY });
  drag.committed = true;
  return { ok: true, payload: { node_id: drag.node_id, x: next.x, y: next.y } };
}

/**
 * @param {any} drag
 * @returns {void}
 */
export function cancelDrag(drag) {
  if (isRecord(drag)) drag.committed = true;
}

/**
 * Keyboard move mapping: arrows 8 px, Shift+arrows 1 px. Returns a `move_node`
 * payload, or `{ok:false, reason:'not_arrow'}` for any other key so the panel
 * can leave the event alone.
 *
 * @param {{node_id:string, position:{x:number,y:number}, key:string, shift?:boolean}} input
 * @returns {{ok:true, payload:{node_id:string,x:number,y:number}, step:number} | {ok:false, reason:string, errors?:any[]}}
 */
export function keyboardMove(input) {
  if (!isRecord(input) || !ARROW_KEYS.includes(input.key)) return { ok: false, reason: 'not_arrow' };
  const position = isRecord(input.position) ? input.position : DEFAULT_POSITION;
  const step = input.shift === true ? KEYBOARD_FINE_STEP : KEYBOARD_STEP;
  let x = inCoordinateRange(position.x) ? position.x : 0;
  let y = inCoordinateRange(position.y) ? position.y : 0;
  if (input.key === 'ArrowLeft') x -= step;
  else if (input.key === 'ArrowRight') x += step;
  else if (input.key === 'ArrowUp') y -= step;
  else y += step;
  return { ok: true, payload: { node_id: input.node_id, x: clampCoordinate(x), y: clampCoordinate(y) }, step };
}

/**
 * Form coordinate fallback. Accepts decimal integer strings or numbers.
 * @param {{node_id:string, x:unknown, y:unknown}} input
 * @returns {{ok:true, payload:{node_id:string,x:number,y:number}} | {ok:false, errors:Array<{path:string,message:string}>}}
 */
export function coordinateMove(input) {
  if (!isRecord(input) || typeof input.node_id !== 'string' || input.node_id.length === 0) {
    return { ok: false, errors: [{ path: '$.node_id', message: 'node_id is required' }] };
  }
  /** @type {Array<{path:string,message:string}>} */
  const errors = [];
  /** @param {'x'|'y'} field @returns {number} */
  const parse = (field) => {
    const raw = input[field];
    if (isSafeInteger(raw)) return raw;
    if (typeof raw === 'string' && /^-?\d{1,7}$/u.test(raw.trim())) return Number.parseInt(raw.trim(), 10);
    errors.push({ path: `$.${field}`, message: `${field} must be an integer between ${POSITION_MIN} and ${POSITION_MAX}` });
    return 0;
  };
  const x = parse('x');
  const y = parse('y');
  if (errors.length === 0) {
    if (!inCoordinateRange(x)) errors.push({ path: '$.x', message: `x must be within ${POSITION_MIN}..${POSITION_MAX}` });
    if (!inCoordinateRange(y)) errors.push({ path: '$.y', message: `y must be within ${POSITION_MIN}..${POSITION_MAX}` });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, payload: { node_id: input.node_id, x, y } };
}

/**
 * Wrap a payload in the frozen command envelope. `expected_draft_revision`
 * always comes from the current model so a stale UI cannot silently mutate a
 * newer draft.
 * @param {{model:any, kind:string, payload:any, sequence:number}} input
 * @returns {any}
 */
export function buildCommand(input) {
  const revision = isRecord(input?.model) && isSafeInteger(input.model.draft_revision) ? input.model.draft_revision : 0;
  return {
    command_id: makeCommandId(input.kind, revision, input.sequence),
    expected_draft_revision: revision,
    kind: input.kind,
    payload: input.payload,
  };
}

/**
 * Apply one command through the editor model. Returns the model result shape
 * (`{status:'ok',model,inverse}` or `{status:'stale'|'invalid',code,errors}`).
 * @param {any} model
 * @param {any} command
 * @param {{now?:string, clock?:()=>string}} [options]
 * @returns {any}
 */
export function applyCommand(model, command, options) {
  return executeEdit(model, command, options);
}

/**
 * Convenience wrapper: build + apply in one call.
 * @param {{model:any, kind:string, payload:any, sequence:number, now?:string}} input
 * @returns {any}
 */
export function runEdit(input) {
  const command = buildCommand(input);
  return executeEdit(input.model, command, input.now === undefined ? {} : { now: input.now });
}

/** @param {number} step @returns {string} */
export function describeStep(step) {
  return step === KEYBOARD_FINE_STEP ? '1 px' : '8 px';
}

/* -------------------------------------------------------------------------- */
/* annotation command builders                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic annotation id (`ann:` prefix required by the overlay contract;
 * never collides with a base entity whose ids cannot start with `ann:` when the
 * editor checks `remove_annotation_node`).
 * @param {'note'|'node'|'edge'} kind
 * @param {number} sequence
 * @returns {string}
 */
export function makeAnnotationId(kind, sequence) {
  const safeKind = ['note', 'node', 'edge'].includes(kind) ? kind : 'node';
  return `ann:${safeKind}-${Math.max(0, Math.trunc(sequence))}`;
}

/**
 * Existing note item bound to a target, if any.
 * @param {any} model
 * @param {string|null} targetRef
 * @returns {any|null}
 */
export function noteForTarget(model, targetRef) {
  const items = Array.isArray(model?.overlay?.items) ? model.overlay.items : [];
  return items.find((item) => item.kind === 'note' && item.target_ref === targetRef) ?? null;
}

/**
 * `set_note` payload. Creates a new note or updates the same-id note.
 * @param {{annotation_id:string, target_ref:string|null, text:string, position:{x:number,y:number,width:number,height:number}}} input
 * @returns {any}
 */
export function notePayload(input) {
  const position = isRecord(input.position) ? input.position : DEFAULT_POSITION;
  return {
    annotation_id: input.annotation_id,
    target_ref: input.target_ref === undefined ? null : input.target_ref,
    text: String(input.text ?? ''),
    position: {
      x: clampCoordinate(position.x),
      y: clampCoordinate(position.y),
      width: Math.max(1, Math.min(10000, Math.trunc(position.width ?? DEFAULT_POSITION.width))),
      height: Math.max(1, Math.min(10000, Math.trunc(position.height ?? DEFAULT_POSITION.height))),
    },
  };
}

/** @param {{id:string,label:string,description?:string|null,position:any}} input @returns {any} */
export function annotationNodePayload(input) {
  const position = isRecord(input.position) ? input.position : DEFAULT_POSITION;
  return {
    id: input.id,
    label: String(input.label ?? ''),
    description: input.description === undefined ? null : input.description,
    position: {
      x: clampCoordinate(position.x),
      y: clampCoordinate(position.y),
      width: Math.max(1, Math.min(10000, Math.trunc(position.width ?? DEFAULT_POSITION.width))),
      height: Math.max(1, Math.min(10000, Math.trunc(position.height ?? DEFAULT_POSITION.height))),
    },
  };
}

/** @param {{id:string,from:string,to:string,label?:string,description?:string|null}} input @returns {any} */
export function annotationEdgePayload(input) {
  return {
    id: input.id,
    from: input.from,
    to: input.to,
    label: String(input.label ?? ''),
    description: input.description === undefined ? null : input.description,
  };
}

/** @param {{id:string}} input @returns {any} */
export function removeAnnotationPayload(input) {
  return { id: input.id };
}

/** @param {{node_id:string}} input @returns {any} */
export function removeAnnotationNodePayload(input) {
  return { node_id: input.node_id };
}

/** @param {{target_ref:string,hidden:boolean}} input @returns {any} */
export function visibilityPayload(input) {
  return { target_ref: input.target_ref, hidden: input.hidden === true };
}

/**
 * Is this id a valid document-entity id for command payloads?
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEntityId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && ID_PATTERN.test(value);
}

/**
 * "Keep both" merge used after a save conflict: the current Host overlay is
 * merged with the local draft overlay. Local items win (they are the edits the
 * user just made), Host items whose id is not present locally are preserved, and
 * a Host layout/visibility item loses to a local item for the same target so the
 * unique-per-target invariant holds. The caller must still validate the merged
 * overlay against its base spec (validateComposite) before editing/saving.
 *
 * @param {any} hostOverlay current Host AnnotationOverlayV1
 * @param {any} localOverlay local draft overlay
 * @returns {any[]} merged item list (local first)
 */
export function mergeOverlayItems(hostOverlay, localOverlay) {
  const localItems = Array.isArray(localOverlay?.items) ? localOverlay.items : [];
  const hostItems = Array.isArray(hostOverlay?.items) ? hostOverlay.items : [];
  const localIds = new Set(localItems.map((item) => item?.id));
  const localTargets = new Set(
    localItems
      .filter((item) => item?.kind === 'layout' || item?.kind === 'visibility')
      .map((item) => `${item.kind}\u0000${item.target_ref}`),
  );
  const merged = localItems.map((item) => structuredClone(item));
  for (const item of hostItems) {
    if (!isRecord(item) || localIds.has(item.id)) continue;
    if (item.kind === 'layout' || item.kind === 'visibility') {
      if (localTargets.has(`${item.kind}\u0000${item.target_ref}`)) continue;
    }
    merged.push(structuredClone(item));
  }
  return merged;
}
