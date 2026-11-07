/**
 * Editor model, command union, history and overlay rebase (DIA-07 / DIA-API-EDIT).
 *
 * Frozen behaviour (docs/software-design.md §7, docs/interfaces.md §7):
 *  - `EditorModelV1` is immutable: every successful command returns a new
 *    model; the caller's previous model is never mutated.
 *  - the base DiagramSpecV1 is held internally (non-enumerable) and is never
 *    mutated; only the AnnotationOverlayV1 changes.
 *  - the command union is exactly the ten kinds from the design. Payload shape
 *    is validated by `src/contracts.mjs` (`validateEditorCommand`, closed
 *    objects); this module adds semantic validation (entity existence,
 *    visibility, endpoint validity, mode rules, limits).
 *  - `command_id` dedupe: same id + same content is idempotent (no extra
 *    revision); same id + different content is a conflict.
 *  - successful edits advance `draft_revision` monotonically. `undo`/`redo`
 *    never decrease it; they replay an internally stored composite patch.
 *  - a `remove_annotation_node` plus all associated edges/notes/layout/
 *    visibility items is one composite history entry.
 *  - history is capped at 100 entries / 2 MiB (oldest complete command is
 *    evicted first); new edits clear the redo stack.
 *  - `undo`/`redo` validate the current revision and the full overlay before
 *    they are applied; invalid replays are refused without touching state.
 *  - inverse patches are returned for internal callers only; they are not an
 *    RPC payload.
 */

import { LIMITS } from '../limits.mjs';
import { DiagramError } from '../errors.mjs';
import { canonicalJson, digestOf, sha256Hex, utf8Length } from '../canonical.mjs';

/* -------------------------------------------------------------------------- */
/* contracts seam (same pattern as src/drawio/xml.mjs)                         */
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
/* internals                                                                   */
/* -------------------------------------------------------------------------- */

const BASE_SPEC = Symbol('local-diagrams.baseSpec');
const HISTORY = Symbol('local-diagrams.history');
const REDO_STACK = Symbol('local-diagrams.redoStack');
const COMMANDS = Symbol('local-diagrams.commands');

const DEFAULT_NODE_SIZE = Object.freeze({ width: 160, height: 64 });
const COMMAND_MAX_KINDS = 1024;
const REDO_STACK_LIMIT = 100;

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
function asRecord(value) {
  return isRecord(value) ? value : null;
}

/** @param {unknown} value */
function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/** @param {any} value */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {Array<{path: string, keyword: string, message: string}>}
 */
function issue(value, path = '$') {
  return [{ path, keyword: 'invalid_command', message: String(value) }];
}

/** @param {string} message @param {string} [path] @returns {never} */
function invalidCommand(message, path = '$') {
  throw new DiagramError('INVALID_COMMAND', message, { errors: issue(message, path) });
}

/** @param {string} message @param {string} [path] @returns {never} */
function limitExceeded(message, path = '$') {
  throw new DiagramError('LIMIT_EXCEEDED', message, { errors: [{ path, keyword: 'limit', message }] });
}

/** @param {Record<string, any>} [options] */
function resolveNow(options) {
  if (options && typeof options.now === 'string') return options.now;
  if (options && typeof options.clock === 'function') {
    const value = options.clock();
    if (typeof value === 'string') return value;
  }
  return new Date().toISOString();
}

/** @param {Record<string, any>} [options] */
function resolveHistoryLimits(options) {
  const custom = isRecord(options?.limits) ? options.limits : {};
  const entries =
    Number.isSafeInteger(custom.editor_history_entries) && custom.editor_history_entries >= 1
      ? custom.editor_history_entries
      : LIMITS.editor_history_entries;
  const bytes =
    Number.isSafeInteger(custom.editor_history_bytes) && custom.editor_history_bytes >= 1024
      ? custom.editor_history_bytes
      : LIMITS.editor_history_bytes;
  return { entries, bytes };
}

/* -------------------------------------------------------------------------- */
/* model construction                                                          */
/* -------------------------------------------------------------------------- */

/**
 * @param {any} baseSpec
 * @param {string} baseSpecDigest
 * @param {any} overlay
 * @param {string[]} selection
 * @param {number} draftRevision
 * @param {boolean} dirty
 * @param {{history?: any[], redoStack?: any[], commands?: Map<string, string>}} internals
 * @returns {any}
 */
function assembleModel(baseSpec, baseSpecDigest, overlay, selection, draftRevision, dirty, internals) {
  /** @type {any} */
  const model = {
    schema_version: 1,
    base_spec_digest: baseSpecDigest,
    overlay,
    selection,
    draft_revision: draftRevision,
    dirty,
  };
  Object.defineProperty(model, BASE_SPEC, { value: baseSpec, enumerable: false, writable: false });
  Object.defineProperty(model, HISTORY, { value: internals.history ?? [], enumerable: false, writable: false });
  Object.defineProperty(model, REDO_STACK, { value: internals.redoStack ?? [], enumerable: false, writable: false });
  Object.defineProperty(model, COMMANDS, { value: internals.commands ?? new Map(), enumerable: false, writable: false });
  return deepFreeze(model);
}

/** @param {unknown} model @returns {boolean} */
function isEditorModel(model) {
  return (
    isRecord(model) &&
    model[BASE_SPEC] !== undefined &&
    model.schema_version === 1 &&
    typeof model.base_spec_digest === 'string' &&
    isRecord(model.overlay) &&
    Array.isArray(model.selection) &&
    Number.isSafeInteger(model.draft_revision) &&
    typeof model.dirty === 'boolean'
  );
}

/** @param {any} model */
function baseSpecOf(model) {
  return model[BASE_SPEC];
}

/**
 * Build the edit model. The base spec and overlay are cloned and frozen so the
 * caller cannot mutate the document through the model.
 *
 * @param {any} spec DiagramSpecV1
 * @param {any} [overlay] AnnotationOverlayV1 (defaults to an empty overlay)
 * @param {{now?: string, clock?: () => string}} [options]
 * @returns {any} EditorModelV1
 */
export function createEditorModel(spec, overlay, options = {}) {
  const contracts = requireContracts();
  const specResult = contracts.validateDiagramSpec(spec);
  if (!specResult.ok) {
    throw new DiagramError('INVALID_SPEC', 'cannot create editor model: invalid diagram spec', {
      errors: specResult.errors,
    });
  }
  const baseSpecDigest = contracts.specDigest(spec);
  let overlayValue;
  if (overlay === undefined || overlay === null) {
    overlayValue = contracts.emptyOverlay({
      diagram_id: spec.diagram_id,
      base_spec_digest: baseSpecDigest,
      now: resolveNow(options),
    });
  } else {
    const composite = contracts.validateComposite(spec, overlay);
    if (!composite.ok) {
      throw new DiagramError('INVALID_OVERLAY', 'cannot create editor model: invalid annotation overlay', {
        errors: composite.errors,
      });
    }
    overlayValue = overlay;
  }
  if (!Number.isSafeInteger(overlayValue.revision) || overlayValue.revision < 0) {
    throw new DiagramError('INVALID_OVERLAY', 'overlay revision must be a non-negative safe integer');
  }
  const baseSpec = deepFreeze(clone(spec));
  const overlayClone = deepFreeze(clone(overlayValue));
  const selection = [];
  const model = assembleModel(baseSpec, baseSpecDigest, overlayClone, selection, overlayValue.revision, false, {});
  const modelResult = contracts.validateEditorModel(model);
  if (!modelResult.ok) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'constructed editor model is invalid', {
      errors: modelResult.errors,
    });
  }
  return model;
}

/* -------------------------------------------------------------------------- */
/* entity helpers                                                              */
/* -------------------------------------------------------------------------- */

/** @param {any} baseSpec */
function baseNodeIds(baseSpec) {
  return new Set((baseSpec.nodes ?? []).map((node) => node.id));
}

/** @param {any} baseSpec */
function baseEdgeIds(baseSpec) {
  return new Set((baseSpec.edges ?? []).map((edge) => edge.id));
}

/** @param {any} baseSpec */
function baseEntityIds(baseSpec) {
  return new Set([...baseNodeIds(baseSpec), ...baseEdgeIds(baseSpec)]);
}

/** @param {{overlay: any}} model @param {string} targetRef */
function visibilityItem(model, targetRef) {
  return model.overlay.items.find((item) => item.kind === 'visibility' && item.target_ref === targetRef) ?? null;
}

/** @param {{overlay: any}} model @param {string} targetRef */
function isHidden(model, targetRef) {
  const item = visibilityItem(model, targetRef);
  return item !== null && item.hidden === true;
}

/** @param {any} model @param {string} id */
function itemById(model, id) {
  return model.overlay.items.find((item) => item.id === id) ?? null;
}

/** @param {any} model */
function annotationNodeIds(model) {
  return new Set(
    model.overlay.items.filter((item) => item.kind === 'annotation_node').map((item) => item.id),
  );
}

/** @param {any} model */
function visibleNodeIds(model) {
  const baseSpec = baseSpecOf(model);
  const ids = new Set();
  for (const nodeId of baseNodeIds(baseSpec)) {
    if (!isHidden(model, nodeId)) ids.add(nodeId);
  }
  for (const item of model.overlay.items) {
    if (item.kind === 'annotation_node') ids.add(item.id);
  }
  return ids;
}

/** @param {any} model */
function documentEntityIds(model) {
  const baseSpec = baseSpecOf(model);
  const ids = baseEntityIds(baseSpec);
  for (const item of model.overlay.items) {
    if (item.kind === 'annotation_node' || item.kind === 'annotation_edge') ids.add(item.id);
  }
  return ids;
}

/** @param {any} baseSpec @param {string} nodeId */
function specPosition(baseSpec, nodeId) {
  const position = (baseSpec.layout?.positions ?? []).find((entry) => entry.node_id === nodeId);
  return position ?? null;
}

/**
 * @param {any} baseSpec
 * @param {any} overlay
 * @param {string} nodeId
 * @param {any[]} items
 * @param {any} currentModel
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function currentBaseNodePosition(currentModel, nodeId) {
  const baseSpec = baseSpecOf(currentModel);
  const layout = currentModel.overlay.items.find((item) => item.kind === 'layout' && item.target_ref === nodeId);
  const fromSpec = specPosition(baseSpec, nodeId);
  const source = layout?.position ?? fromSpec ?? DEFAULT_NODE_SIZE;
  return {
    x: Number.isSafeInteger(source.x) ? source.x : 0,
    y: Number.isSafeInteger(source.y) ? source.y : 0,
    width: Number.isSafeInteger(source.width) && source.width >= 1 ? source.width : DEFAULT_NODE_SIZE.width,
    height: Number.isSafeInteger(source.height) && source.height >= 1 ? source.height : DEFAULT_NODE_SIZE.height,
  };
}

/**
 * Deterministic overlay id for an internal layout/visibility item. The prefix
 * is not required by the overlay schema for layout/visibility, but using it
 * keeps every tool-owned item recognisable and collision-free.
 *
 * @param {any} model
 * @param {string} candidate
 * @returns {string}
 */
function uniqueOverlayItemId(model, candidate) {
  const taken = new Set(model.overlay.items.map((item) => item.id));
  const base = baseEntityIds(baseSpecOf(model));
  let id = candidate;
  let counter = 2;
  while (taken.has(id) || base.has(id)) {
    id = `${candidate}-${counter}`;
    counter += 1;
  }
  return id;
}

/* -------------------------------------------------------------------------- */
/* patch application                                                           */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{before_revision: number, after_revision: number, restore_items: any[], remove_ids: string[], restore_selection: string[]}} Patch
 */

/**
 * Apply an internal composite patch to an overlay clone. The patch removes the
 * listed ids and re-adds the exact prior/new overlay items; the full overlay is
 * validated by the caller afterwards.
 *
 * @param {any} overlay
 * @param {Patch} patch
 * @param {number} revision
 * @param {string} now
 * @returns {any}
 */
function applyPatchToOverlay(overlay, patch, revision, now) {
  const removeIds = new Set(patch.remove_ids ?? []);
  const restoreItems = (patch.restore_items ?? []).map((item) => clone(item));
  const restoreIds = new Set(restoreItems.map((item) => item.id));
  const items = overlay.items.filter((item) => !removeIds.has(item.id) && !restoreIds.has(item.id));
  for (const item of restoreItems) items.push(item);
  return {
    ...overlay,
    revision,
    items,
    updated_at: now,
  };
}

/** @param {any} model @param {any} limit @returns {any[]} */
function trimHistory(history, limit) {
  const entries = [...history];
  let bytes = entries.reduce((sum, entry) => sum + (Number.isSafeInteger(entry.bytes) ? entry.bytes : 0), 0);
  while (entries.length > limit.entries || (bytes > limit.bytes && entries.length > 1)) {
    const removed = entries.shift();
    bytes -= Number.isSafeInteger(removed.bytes) ? removed.bytes : 0;
  }
  return entries;
}

/* -------------------------------------------------------------------------- */
/* command execution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Execute one editor command against an immutable editor model.
 *
 * @param {any} model EditorModelV1
 * @param {{command_id: string, expected_draft_revision: number, kind: string, payload: any}} command
 * @param {{now?: string, clock?: () => string, limits?: Record<string, number>}} [options]
 * @returns {{status: 'ok', model: any, inverse: any, deduplicated?: boolean}
 *   | {status: 'stale' | 'invalid', code: string, errors?: Array<{path: string, keyword: string, message: string}>}}
 */
export function executeEdit(model, command, options = {}) {
  const contracts = requireContracts();
  if (!isEditorModel(model)) {
    return {
      status: 'invalid',
      code: 'INVALID_EDITOR_MODEL',
      errors: issue('model is not an editor model created by createEditorModel'),
    };
  }
  const commandResult = contracts.validateEditorCommand(command);
  if (!commandResult.ok) {
    return { status: 'invalid', code: 'INVALID_COMMAND', errors: commandResult.errors };
  }
  const commandDigest = digestOf({ kind: command.kind, payload: command.payload });
  const seenCommands = model[COMMANDS];
  if (seenCommands.has(command.command_id)) {
    if (seenCommands.get(command.command_id) === commandDigest) {
      return { status: 'ok', model, inverse: null, deduplicated: true };
    }
    return {
      status: 'invalid',
      code: 'CONFLICT',
      errors: [{ path: '$.command_id', keyword: 'conflict', message: 'command_id was already used with different content' }],
    };
  }
  if (
    !Number.isSafeInteger(command.expected_draft_revision) ||
    command.expected_draft_revision !== model.draft_revision
  ) {
    return {
      status: 'stale',
      code: 'STALE_VERSION',
      errors: [
        {
          path: '$.expected_draft_revision',
          keyword: 'stale',
          message: `expected draft revision ${command.expected_draft_revision}, current is ${model.draft_revision}`,
        },
      ],
    };
  }

  const now = resolveNow(options);
  const historyLimits = resolveHistoryLimits(options);
  try {
    if (command.kind === 'undo') {
      return performUndo(model, command, now);
    }
    if (command.kind === 'redo') {
      return performRedo(model, command, now);
    }
    const outcome = runCommand(model, command);
    return commitCommand(model, command, outcome, commandDigest, now, historyLimits);
  } catch (error) {
    if (error instanceof DiagramError) {
      return {
        status: 'invalid',
        code: error.code,
        errors: error.details?.errors ?? issue(error.message),
      };
    }
    throw error;
  }
}

/**
 * @param {any} model
 * @param {any} command
 * @returns {{overlay: any, selection: string[], undo: {remove_ids: string[], restore_items: any[]}, redo: {remove_ids: string[], restore_items: any[]}}}
 */
function runCommand(model, command) {
  const overlay = structuredClone(model.overlay);
  const items = overlay.items;
  const selection = [...model.selection];
  const payload = command.payload;

  /**
   * @param {string} id
   * @returns {number}
   */
  const indexOf = (id) => items.findIndex((item) => item.id === id);

  switch (command.kind) {
    case 'move_node': {
      const nodeId = payload.node_id;
      const baseSpec = baseSpecOf(model);
      const baseNodeExists = (baseSpec.nodes ?? []).some((node) => node.id === nodeId);
      const index = indexOf(nodeId);
      const existing = index === -1 ? null : items[index];
      if (!baseNodeExists && !existing) invalidCommand(`node "${nodeId}" does not exist`, '$.payload.node_id');
      if (existing && existing.kind !== 'annotation_node') {
        invalidCommand(`"${nodeId}" is not a node`, '$.payload.node_id');
      }
      if (baseNodeExists && isHidden(model, nodeId)) {
        invalidCommand(`node "${nodeId}" is hidden`, '$.payload.node_id');
      }
      if (existing) {
        const updated = {
          ...existing,
          position: { x: payload.x, y: payload.y, width: existing.position.width, height: existing.position.height },
        };
        items[index] = updated;
        return {
          overlay,
          selection,
          undo: { remove_ids: [updated.id], restore_items: [existing] },
          redo: { remove_ids: [updated.id], restore_items: [updated] },
        };
      }
      const current = currentBaseNodePosition(model, nodeId);
      const position = { x: payload.x, y: payload.y, width: current.width, height: current.height };
      const layout = items.find((item) => item.kind === 'layout' && item.target_ref === nodeId);
      if (layout) {
        const updated = { ...layout, position };
        items[items.indexOf(layout)] = updated;
        return {
          overlay,
          selection,
          undo: { remove_ids: [updated.id], restore_items: [layout] },
          redo: { remove_ids: [updated.id], restore_items: [updated] },
        };
      }
      const id = uniqueOverlayItemId(model, `ann:layout-${sha256Hex(nodeId).slice(0, 16)}`);
      const item = { id, kind: 'layout', target_ref: nodeId, position };
      items.push(item);
      return {
        overlay,
        selection,
        undo: { remove_ids: [id], restore_items: [] },
        redo: { remove_ids: [], restore_items: [item] },
      };
    }
    case 'set_note': {
      const annotationId = payload.annotation_id;
      if (!annotationId.startsWith('ann:')) {
        invalidCommand('note ids must use the ann: prefix', '$.payload.annotation_id');
      }
      if (baseEntityIds(baseSpecOf(model)).has(annotationId)) {
        invalidCommand('note id collides with a base entity id', '$.payload.annotation_id');
      }
      const index = indexOf(annotationId);
      const existing = index === -1 ? null : items[index];
      if (existing && existing.kind !== 'note') {
        invalidCommand(`"${annotationId}" is not a note`, '$.payload.annotation_id');
      }
      if (payload.target_ref !== null && !documentEntityIds(model).has(payload.target_ref)) {
        invalidCommand(`note target "${payload.target_ref}" is not a document entity`, '$.payload.target_ref');
      }
      const item = {
        id: annotationId,
        kind: 'note',
        target_ref: payload.target_ref,
        text: payload.text,
        position: payload.position,
      };
      if (existing) items[index] = item;
      else items.push(item);
      return {
        overlay,
        selection,
        undo: existing
          ? { remove_ids: [item.id], restore_items: [existing] }
          : { remove_ids: [item.id], restore_items: [] },
        redo: { remove_ids: [item.id], restore_items: [item] },
      };
    }
    case 'add_annotation_node': {
      const baseSpec = baseSpecOf(model);
      if (baseSpec.mode !== 'conceptual') {
        invalidCommand('annotation nodes are only allowed in conceptual diagrams', '$.payload.id');
      }
      if (!payload.id.startsWith('ann:')) {
        invalidCommand('annotation node ids must use the ann: prefix', '$.payload.id');
      }
      if (baseEntityIds(baseSpec).has(payload.id) || indexOf(payload.id) !== -1) {
        invalidCommand(`id "${payload.id}" already exists`, '$.payload.id');
      }
      if (items.length + 1 > LIMITS.overlay_items) limitExceeded('overlay item limit exceeded', '$.payload.id');
      const item = {
        id: payload.id,
        kind: 'annotation_node',
        label: payload.label,
        description: payload.description,
        position: payload.position,
      };
      items.push(item);
      return {
        overlay,
        selection,
        undo: { remove_ids: [item.id], restore_items: [] },
        redo: { remove_ids: [], restore_items: [item] },
      };
    }
    case 'set_annotation_node': {
      const index = indexOf(payload.id);
      if (index === -1) invalidCommand(`annotation node "${payload.id}" does not exist`, '$.payload.id');
      const existing = items[index];
      if (existing.kind !== 'annotation_node') {
        invalidCommand(`"${payload.id}" is not an annotation node`, '$.payload.id');
      }
      const updated = { ...existing, label: payload.label, description: payload.description };
      items[index] = updated;
      return {
        overlay,
        selection,
        undo: { remove_ids: [updated.id], restore_items: [existing] },
        redo: { remove_ids: [updated.id], restore_items: [updated] },
      };
    }
    case 'add_annotation_edge': {
      if (!payload.id.startsWith('ann:')) {
        invalidCommand('annotation edge ids must use the ann: prefix', '$.payload.id');
      }
      if (baseEntityIds(baseSpecOf(model)).has(payload.id) || indexOf(payload.id) !== -1) {
        invalidCommand(`id "${payload.id}" already exists`, '$.payload.id');
      }
      const visible = visibleNodeIds(model);
      for (const endpoint of ['from', 'to']) {
        if (!visible.has(payload[endpoint])) {
          invalidCommand(`annotation edge ${endpoint} "${payload[endpoint]}" must be a visible node`, `$.payload.${endpoint}`);
        }
      }
      if (items.length + 1 > LIMITS.overlay_items) limitExceeded('overlay item limit exceeded', '$.payload.id');
      const annotationEdgeCount = items.filter((item) => item.kind === 'annotation_edge').length;
      if (annotationEdgeCount + 1 > LIMITS.annotation_edges) {
        limitExceeded('annotation edge limit exceeded', '$.payload.id');
      }
      const item = {
        id: payload.id,
        kind: 'annotation_edge',
        from: payload.from,
        to: payload.to,
        label: payload.label,
        description: payload.description,
      };
      items.push(item);
      return {
        overlay,
        selection,
        undo: { remove_ids: [item.id], restore_items: [] },
        redo: { remove_ids: [], restore_items: [item] },
      };
    }
    case 'remove_annotation': {
      const index = indexOf(payload.id);
      if (index === -1) invalidCommand(`overlay item "${payload.id}" does not exist`, '$.payload.id');
      const removed = items[index];
      if (removed.kind !== 'note' && removed.kind !== 'annotation_edge') {
        invalidCommand('remove_annotation only accepts note or annotation_edge items', '$.payload.id');
      }
      items.splice(index, 1);
      return {
        overlay,
        selection: selection.filter((id) => id !== removed.id),
        undo: { remove_ids: [], restore_items: [removed] },
        redo: { remove_ids: [removed.id], restore_items: [] },
      };
    }
    case 'remove_annotation_node': {
      return removeAnnotationNode(model, overlay, selection, payload);
    }
    case 'set_visibility': {
      const targetRef = payload.target_ref;
      if (!baseEntityIds(baseSpecOf(model)).has(targetRef)) {
        invalidCommand('visibility can only target base nodes or edges', '$.payload.target_ref');
      }
      const index = indexOf(visibilityItem(model, targetRef)?.id ?? '');
      const existing = index === -1 ? null : items[index];
      if (existing && existing.kind !== 'visibility') {
        invalidCommand(`"${targetRef}" does not have a visibility item`, '$.payload.target_ref');
      }
      const item = existing
        ? { ...existing, hidden: payload.hidden }
        : {
            id: uniqueOverlayItemId(model, `ann:visibility-${sha256Hex(targetRef).slice(0, 16)}`),
            kind: 'visibility',
            target_ref: targetRef,
            hidden: payload.hidden,
          };
      if (existing) items[index] = item;
      else items.push(item);
      return {
        overlay,
        selection,
        undo: existing
          ? { remove_ids: [item.id], restore_items: [existing] }
          : { remove_ids: [item.id], restore_items: [] },
        redo: { remove_ids: [item.id], restore_items: [item] },
      };
    }
    default:
      invalidCommand(`command kind "${command.kind}" is not supported`);
  }
  /* c8 ignore next */
  invalidCommand('unreachable');
}

/**
 * Composite removal of an annotation node.
 *
 * - overlay annotation node: the node plus all edges/notes/layout/visibility
 *   items that reference it are removed as one history entry.
 * - conceptual base annotation node: the base spec is untouched; a
 *   `visibility hidden` item is written after removing overlay items that
 *   reference the node (the evidence stays in the base, base edges are only
 *   hidden in the view).
 * - evidence base nodes/edges can never be physically removed.
 *
 * @param {any} model
 * @param {any} overlay
 * @param {string[]} selection
 * @param {any} payload
 * @returns {any}
 */
function removeAnnotationNode(model, overlay, selection, payload) {
  const nodeId = payload.node_id;
  const items = overlay.items;
  const baseSpec = baseSpecOf(model);
  const baseNode = (baseSpec.nodes ?? []).find((node) => node.id === nodeId) ?? null;
  const overlayNode = items.find((item) => item.id === nodeId) ?? null;
  if (!baseNode && !overlayNode) invalidCommand(`node "${nodeId}" does not exist`, '$.payload.node_id');
  if (overlayNode && overlayNode.kind !== 'annotation_node') {
    invalidCommand(`"${nodeId}" is not an annotation node`, '$.payload.node_id');
  }

  /** @type {Set<string>} */
  const associatedIds = new Set();
  for (const item of items) {
    if (item.id === nodeId) continue;
    if (item.kind === 'annotation_edge' && (item.from === nodeId || item.to === nodeId)) associatedIds.add(item.id);
    else if (item.kind === 'note' && item.target_ref === nodeId) associatedIds.add(item.id);
    else if (item.kind === 'layout' && item.target_ref === nodeId) associatedIds.add(item.id);
    else if (item.kind === 'visibility' && item.target_ref === nodeId) associatedIds.add(item.id);
  }

  /** @type {any[]} */
  const removedItems = [];
  /** @type {any[]} */
  const remaining = [];
  for (const item of items) {
    if (item.id === nodeId || associatedIds.has(item.id)) removedItems.push(item);
    else remaining.push(item);
  }
  const nextSelection = selection.filter((id) => id !== nodeId && !associatedIds.has(id));

  if (overlayNode) {
    items.length = 0;
    for (const item of remaining) items.push(item);
    return {
      overlay,
      selection: nextSelection,
      undo: { remove_ids: [], restore_items: clone(removedItems) },
      redo: { remove_ids: removedItems.map((item) => item.id), restore_items: [] },
    };
  }

  if (baseSpec.mode !== 'conceptual') {
    invalidCommand('evidence base nodes/edges cannot be removed; use set_visibility', '$.payload.node_id');
  }
  if (baseNode.origin !== 'annotation') {
    invalidCommand('only conceptual annotation-origin base nodes can be hidden', '$.payload.node_id');
  }
  if (isHidden(model, nodeId)) {
    invalidCommand(`node "${nodeId}" is already hidden`, '$.payload.node_id');
  }
  items.length = 0;
  for (const item of remaining) items.push(item);
  const baseIds = baseEntityIds(baseSpec);
  let visibilityId = `ann:visibility-${sha256Hex(nodeId).slice(0, 16)}`;
  let counter = 2;
  while (baseIds.has(visibilityId) || remaining.some((item) => item.id === visibilityId)) {
    visibilityId = `ann:visibility-${sha256Hex(nodeId).slice(0, 16)}-${counter}`;
    counter += 1;
  }
  const visibility = { id: visibilityId, kind: 'visibility', target_ref: nodeId, hidden: true };
  items.push(visibility);
  return {
    overlay,
    selection: nextSelection,
    undo: { remove_ids: [visibilityId], restore_items: clone(removedItems) },
    redo: { remove_ids: removedItems.map((item) => item.id), restore_items: [visibility] },
  };
}

/**
 * @param {any} model
 * @param {any} command
 * @param {{overlay: any, selection: string[], undo: {remove_ids: string[], restore_items: any[]}, redo: {remove_ids: string[], restore_items: any[]}}} outcome
 * @param {string} commandDigest
 * @param {string} now
 * @param {{entries: number, bytes: number}} historyLimits
 * @returns {any}
 */
function commitCommand(model, command, outcome, commandDigest, now, historyLimits) {
  const contracts = requireContracts();
  const baseSpec = baseSpecOf(model);
  const nextRevision = model.draft_revision + 1;
  if (!Number.isSafeInteger(nextRevision) || nextRevision > LIMITS.editor_draft_revision) {
    limitExceeded('draft revision limit exceeded', '$.draft_revision');
  }
  const nextOverlay = clone(outcome.overlay);
  nextOverlay.revision = nextRevision;
  nextOverlay.updated_at = now;
  const overlayResult = contracts.validateOverlay(nextOverlay);
  if (!overlayResult.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'edit produced an invalid annotation overlay', {
      errors: overlayResult.errors,
    });
  }
  const composite = contracts.validateComposite(baseSpec, nextOverlay);
  if (!composite.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'edit produced an invalid spec/overlay composite', {
      errors: composite.errors,
    });
  }
  /** @type {Patch} */
  const undoPatch = {
    before_revision: model.draft_revision,
    after_revision: nextRevision,
    restore_items: clone(outcome.undo.restore_items),
    remove_ids: [...outcome.undo.remove_ids],
    restore_selection: [...model.selection],
  };
  /** @type {Patch} */
  const redoPatch = {
    before_revision: model.draft_revision,
    after_revision: nextRevision,
    restore_items: clone(outcome.redo.restore_items),
    remove_ids: [...outcome.redo.remove_ids],
    restore_selection: [...outcome.selection],
  };
  const entry = {
    undo: undoPatch,
    redo: redoPatch,
    bytes: utf8Length(canonicalJson({ undo: undoPatch, redo: redoPatch })),
  };
  const history = trimHistory([...model[HISTORY], entry], historyLimits);
  const commands = new Map(model[COMMANDS]);
  commands.set(command.command_id, commandDigest);
  while (commands.size > COMMAND_MAX_KINDS) {
    const oldest = commands.keys().next().value;
    if (oldest === undefined) break;
    commands.delete(oldest);
  }
  const nextModel = assembleModel(
    baseSpec,
    model.base_spec_digest,
    deepFreeze(clone(nextOverlay)),
    [...outcome.selection],
    nextRevision,
    true,
    { history, redoStack: [], commands },
  );
  const modelResult = contracts.validateEditorModel(nextModel);
  if (!modelResult.ok) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'edit produced an invalid editor model', {
      errors: modelResult.errors,
    });
  }
  return { status: 'ok', model: nextModel, inverse: undoPatch };
}

/* -------------------------------------------------------------------------- */
/* undo / redo                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {any} model
 * @param {any} command
 * @param {string} now
 * @returns {any}
 */
function performUndo(model, command, now) {
  const history = model[HISTORY];
  if (history.length === 0) invalidCommand('nothing to undo');
  const entry = history[history.length - 1];
  const nextRevision = model.draft_revision + 1;
  if (!Number.isSafeInteger(nextRevision) || nextRevision > LIMITS.editor_draft_revision) {
    limitExceeded('draft revision limit exceeded', '$.draft_revision');
  }
  const nextOverlay = applyPatchToOverlay(model.overlay, entry.undo, nextRevision, now);
  const contracts = requireContracts();
  const baseSpec = baseSpecOf(model);
  const overlayResult = contracts.validateOverlay(nextOverlay);
  if (!overlayResult.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'undo produced an invalid annotation overlay', {
      errors: overlayResult.errors,
    });
  }
  const composite = contracts.validateComposite(baseSpec, nextOverlay);
  if (!composite.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'undo produced an invalid spec/overlay composite', {
      errors: composite.errors,
    });
  }
  const nextHistory = history.slice(0, -1);
  const nextRedo = [...model[REDO_STACK], entry].slice(-REDO_STACK_LIMIT);
  const commands = new Map(model[COMMANDS]);
  commands.set(command.command_id, digestOf({ kind: command.kind, payload: command.payload }));
  const nextModel = assembleModel(
    baseSpec,
    model.base_spec_digest,
    deepFreeze(clone(nextOverlay)),
    entry.undo.restore_selection.map((id) => id),
    nextRevision,
    true,
    { history: nextHistory, redoStack: nextRedo, commands },
  );
  const modelResult = contracts.validateEditorModel(nextModel);
  if (!modelResult.ok) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'undo produced an invalid editor model', {
      errors: modelResult.errors,
    });
  }
  return { status: 'ok', model: nextModel, inverse: clone(entry.redo) };
}

/**
 * @param {any} model
 * @param {any} command
 * @param {string} now
 * @returns {any}
 */
function performRedo(model, command, now) {
  const redoStack = model[REDO_STACK];
  if (redoStack.length === 0) invalidCommand('nothing to redo');
  const entry = redoStack[redoStack.length - 1];
  const nextRevision = model.draft_revision + 1;
  if (!Number.isSafeInteger(nextRevision) || nextRevision > LIMITS.editor_draft_revision) {
    limitExceeded('draft revision limit exceeded', '$.draft_revision');
  }
  const nextOverlay = applyPatchToOverlay(model.overlay, entry.redo, nextRevision, now);
  const contracts = requireContracts();
  const baseSpec = baseSpecOf(model);
  const overlayResult = contracts.validateOverlay(nextOverlay);
  if (!overlayResult.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'redo produced an invalid annotation overlay', {
      errors: overlayResult.errors,
    });
  }
  const composite = contracts.validateComposite(baseSpec, nextOverlay);
  if (!composite.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'redo produced an invalid spec/overlay composite', {
      errors: composite.errors,
    });
  }
  const nextHistory = trimHistory([...model[HISTORY], entry], {
    entries: LIMITS.editor_history_entries,
    bytes: LIMITS.editor_history_bytes,
  });
  const nextRedo = redoStack.slice(0, -1);
  const commands = new Map(model[COMMANDS]);
  commands.set(command.command_id, digestOf({ kind: command.kind, payload: command.payload }));
  const nextModel = assembleModel(
    baseSpec,
    model.base_spec_digest,
    deepFreeze(clone(nextOverlay)),
    entry.redo.restore_selection.map((id) => id),
    nextRevision,
    true,
    { history: nextHistory, redoStack: nextRedo, commands },
  );
  const modelResult = contracts.validateEditorModel(nextModel);
  if (!modelResult.ok) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'redo produced an invalid editor model', {
      errors: modelResult.errors,
    });
  }
  return { status: 'ok', model: nextModel, inverse: clone(entry.undo) };
}

/* -------------------------------------------------------------------------- */
/* standalone undo/redo and serialization                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {any} model
 * @param {{now?: string, clock?: () => string}} [options]
 * @returns {any}
 */
export function undo(model, options = {}) {
  if (!isEditorModel(model)) {
    return { status: 'invalid', code: 'INVALID_EDITOR_MODEL', errors: issue('model is not an editor model') };
  }
  try {
    return performUndo(model, { command_id: `internal:undo:${model.draft_revision}`, kind: 'undo', payload: {} }, resolveNow(options));
  } catch (error) {
    if (error instanceof DiagramError) {
      return {
        status: 'invalid',
        code: error.code,
        errors: error.details?.errors ?? issue(error.message),
      };
    }
    throw error;
  }
}

/**
 * @param {any} model
 * @param {{now?: string, clock?: () => string}} [options]
 * @returns {any}
 */
export function redo(model, options = {}) {
  if (!isEditorModel(model)) {
    return { status: 'invalid', code: 'INVALID_EDITOR_MODEL', errors: issue('model is not an editor model') };
  }
  try {
    return performRedo(model, { command_id: `internal:redo:${model.draft_revision}`, kind: 'redo', payload: {} }, resolveNow(options));
  } catch (error) {
    if (error instanceof DiagramError) {
      return {
        status: 'invalid',
        code: error.code,
        errors: error.details?.errors ?? issue(error.message),
      };
    }
    throw error;
  }
}

/**
 * Deterministic serialization of the public `EditorModelV1` fields
 * (internals are non-enumerable and therefore excluded by construction).
 *
 * @param {any} model
 * @returns {string}
 */
export function serializeEditorModel(model) {
  const contracts = requireContracts();
  if (!isEditorModel(model)) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'cannot serialize a model that is not an editor model');
  }
  const plain = {
    schema_version: 1,
    base_spec_digest: model.base_spec_digest,
    overlay: clone(model.overlay),
    selection: [...model.selection],
    draft_revision: model.draft_revision,
    dirty: model.dirty,
  };
  const result = contracts.validateEditorModel(plain);
  if (!result.ok) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'editor model failed validation before serialization', {
      errors: result.errors,
    });
  }
  return canonicalJson(plain);
}

/* -------------------------------------------------------------------------- */
/* rebase                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rebind an existing overlay to a regenerated base spec by stable ID.
 *
 * Items whose target/endpoint disappeared are preserved in
 * `orphaned_annotations` (never silently dropped, never rebound to a
 * same-labelled entity). The base spec is not mutated.
 *
 * @param {any} spec New DiagramSpecV1
 * @param {any} overlay Existing AnnotationOverlayV1
 * @param {{now?: string, clock?: () => string}} [options]
 * @returns {{overlay: any, orphaned: any[]}}
 */
export function rebaseOverlay(spec, overlay, options = {}) {
  const contracts = requireContracts();
  const specResult = contracts.validateDiagramSpec(spec);
  if (!specResult.ok) {
    throw new DiagramError('INVALID_SPEC', 'rebaseOverlay: invalid diagram spec', { errors: specResult.errors });
  }
  const overlayResult = contracts.validateOverlay(overlay);
  if (!overlayResult.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'rebaseOverlay: invalid annotation overlay', {
      errors: overlayResult.errors,
    });
  }
  const now = resolveNow(options);
  const nodeIds = baseNodeIds(spec);
  const edgeIds = baseEdgeIds(spec);
  const entityIds = new Set([...nodeIds, ...edgeIds]);
  const mode = spec.mode;

  const annotationNodes = new Set(
    overlay.items.filter((item) => item.kind === 'annotation_node').map((item) => item.id),
  );
  const keptAnnotationNodes = new Set(mode === 'conceptual' ? [...annotationNodes] : []);

  const keptVisibility = new Map();
  const hiddenTargets = new Set();
  const orphanedNew = [];
  const keep = new Set();

  /** @param {any} item @param {'target_missing' | 'endpoint_missing'} reason */
  const orphan = (item, reason) => {
    orphanedNew.push({ item: clone(item), reason });
  };

  // Pass 1: annotation nodes (only valid in conceptual mode) and visibility.
  for (const item of overlay.items) {
    if (item.kind === 'annotation_node') {
      if (keptAnnotationNodes.has(item.id)) keep.add(item.id);
      else orphan(item, 'target_missing');
    } else if (item.kind === 'visibility') {
      if (entityIds.has(item.target_ref)) {
        keptVisibility.set(item.id, item);
        keep.add(item.id);
        if (item.hidden === true) hiddenTargets.add(item.target_ref);
      } else {
        orphan(item, 'target_missing');
      }
    }
  }
  const visibleNodes = new Set();
  for (const nodeId of nodeIds) if (!hiddenTargets.has(nodeId)) visibleNodes.add(nodeId);
  for (const nodeId of keptAnnotationNodes) visibleNodes.add(nodeId);

  // Pass 2: annotation edges need two visible nodes.
  const keptEdges = new Set();
  for (const item of overlay.items) {
    if (item.kind !== 'annotation_edge') continue;
    if (visibleNodes.has(item.from) && visibleNodes.has(item.to)) {
      keptEdges.add(item.id);
      keep.add(item.id);
    } else {
      orphan(item, 'endpoint_missing');
    }
  }

  // Pass 3: notes target an existing document entity; layout targets a base
  // node; anything else is orphaned (never rebound by label).
  const documentEntities = new Set([...entityIds, ...keptAnnotationNodes, ...keptEdges]);
  for (const item of overlay.items) {
    if (item.kind === 'note') {
      if (item.target_ref === null || documentEntities.has(item.target_ref)) keep.add(item.id);
      else orphan(item, 'target_missing');
    } else if (item.kind === 'layout') {
      if (nodeIds.has(item.target_ref)) keep.add(item.id);
      else orphan(item, 'target_missing');
    }
  }

  const keptItems = overlay.items.filter((item) => keep.has(item.id)).map((item) => clone(item));
  const existingOrphans = (overlay.orphaned_annotations ?? []).map((entry) => clone(entry));
  const orphaned = [...existingOrphans, ...orphanedNew];
  /** @type {any} */
  const nextOverlay = {
    schema_version: 1,
    diagram_id: spec.diagram_id,
    base_spec_digest: contracts.specDigest(spec),
    revision: overlay.revision,
    items: keptItems,
    orphaned_annotations: orphaned,
    updated_at: now,
  };
  if (orphaned.length > LIMITS.orphaned_annotations) {
    throw new DiagramError('LIMIT_EXCEEDED', `rebase produced ${orphaned.length} orphaned annotations; limit is ${LIMITS.orphaned_annotations}`);
  }
  const nextResult = contracts.validateOverlay(nextOverlay);
  if (!nextResult.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'rebaseOverlay produced an invalid overlay', {
      errors: nextResult.errors,
    });
  }
  const composite = contracts.validateComposite(spec, nextOverlay);
  if (!composite.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'rebaseOverlay produced an invalid composite', {
      errors: composite.errors,
    });
  }
  return { overlay: nextOverlay, orphaned };
}
