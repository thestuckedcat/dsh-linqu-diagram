/**
 * External `.drawio` import boundary (DIA-06 / DIA-API-RENDER, docs/software-design.md §7).
 *
 * Import never trusts an external file: XML is parsed through the restricted
 * parser (`./xml.mjs`), then every cell is downgraded to a display-only
 * annotation. Geometry, plain text and endpoints become
 * `annotation_node` / `annotation_edge` / `note` overlay items on top of an
 * EMPTY conceptual base spec. `data_*` attributes (including anything claiming
 * `data_origin=evidence` or `data_certainty=exact`) are copied to a
 * `display_metadata` side channel only; they never become spec evidence and
 * never change overlay item semantics. Compressed diagrams, unknown shapes and
 * unsupported style keys fail with a clear `unsupported`/`invalid` status
 * instead of being silently stripped and re-saved.
 */

import { LIMITS } from '../limits.mjs';
import { DiagramError } from '../errors.mjs';
import { sha256Hex } from '../canonical.mjs';
import { parseDrawioXml } from './xml.mjs';

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
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

const DEFAULT_POSITION = Object.freeze({ width: 160, height: 64 });
const MAX_WARNINGS = 128;
const MAX_ITEMS = LIMITS.overlay_items;
const MAX_ANNOTATION_EDGES = LIMITS.annotation_edges;
const MAX_NOTES = LIMITS.notes;

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Deterministic overlay id derived from the external cell id. Overlay ids are
 * limited to 128 characters and must use the `ann:` prefix; collisions are
 * disambiguated with a counter so two external cells can never alias.
 *
 * @param {string} kind
 * @param {string} externalId
 * @param {Set<string>} used
 * @returns {string}
 */
function allocateOverlayId(kind, externalId, used) {
  const safe = externalId.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'cell';
  let candidate = `ann:${kind}-${safe}`;
  if (candidate.length > LIMITS.overlay_id_length) {
    candidate = `ann:${kind}-${sha256Hex(externalId).slice(0, 16)}`;
  }
  let unique = candidate;
  let counter = 2;
  while (used.has(unique)) {
    unique = `${candidate}-${counter}`;
    counter += 1;
  }
  used.add(unique);
  return unique;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function textOr(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Map imported geometry onto a DIA-OVERLAY-01 position. Missing or invalid
 * dimensions use the blocked fallback; coordinates are clamped into the
 * overlay coordinate range so an external file cannot produce an invalid
 * overlay revision.
 *
 * @param {any} geometry
 * @param {string} cellId
 * @param {(message: string) => void} warn
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function importPosition(geometry, cellId, warn) {
  if (!geometry) {
    warn(`geometry_defaulted:${cellId}`);
    return { x: 0, y: 0, width: DEFAULT_POSITION.width, height: DEFAULT_POSITION.height };
  }
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const x = clamp(Math.round(number(geometry.x) ?? 0), -LIMITS.position_coordinate, LIMITS.position_coordinate);
  const y = clamp(Math.round(number(geometry.y) ?? 0), -LIMITS.position_coordinate, LIMITS.position_coordinate);
  let width = Math.round(number(geometry.width) ?? DEFAULT_POSITION.width);
  let height = Math.round(number(geometry.height) ?? DEFAULT_POSITION.height);
  if (!(width >= LIMITS.position_min_size) || width > LIMITS.position_max_size) {
    warn(`geometry_size_defaulted:${cellId}`);
    width = DEFAULT_POSITION.width;
  }
  if (!(height >= LIMITS.position_min_size) || height > LIMITS.position_max_size) {
    warn(`geometry_size_defaulted:${cellId}`);
    height = DEFAULT_POSITION.height;
  }
  return { x, y, width, height };
}

/* -------------------------------------------------------------------------- */
/* import                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Import an external `.drawio` document (including a file this tool exported
 * earlier) as conceptual annotation data.
 *
 * @param {string | Uint8Array} input
 * @param {{limits?: Record<string, number>, scope_ref?: string, title?: string, diagram_id?: string, now?: string, clock?: () => string}} [options]
 * @returns {{status: 'ok', base_spec: any, overlay: any, warnings: string[], display_metadata: Array<any>}
 *   | {status: 'unsupported' | 'invalid', code: string, errors: Array<{path: string, keyword: string, message: string}>}}
 */
export function importExternalDrawio(input, options = {}) {
  const parsed = parseDrawioXml(input, { limits: options.limits });
  if (!parsed.ok) {
    const status = parsed.code === 'UNSUPPORTED' ? 'unsupported' : 'invalid';
    return { status, code: parsed.code, errors: parsed.errors };
  }
  const contracts = requireContracts();
  try {
    return buildConceptualImport(input, parsed.document, options, contracts);
  } catch (error) {
    if (error instanceof DiagramError) {
      return { status: 'invalid', code: error.code, errors: error.details?.errors ?? [{ path: '$', keyword: 'invalid', message: error.message }] };
    }
    throw error;
  }
}

/**
 * @param {string | Uint8Array} input
 * @param {{cells: any[], layers: Array<{id: string, value: string}>}} document
 * @param {Record<string, any>} options
 * @param {any} contracts
 */
function buildConceptualImport(input, document, options, contracts) {
  /** @type {string[]} */
  const warnings = [];
  const warn = (message) => {
    if (warnings.length >= MAX_WARNINGS) {
      if (!warnings.includes('warnings_truncated')) warnings.push('warnings_truncated');
      return;
    }
    warnings.push(message);
  };

  const contentCells = document.cells.filter((cell) => cell.id !== '0' && cell.parent !== '0');
  const vertices = contentCells.filter((cell) => cell.vertex);
  const edgeCells = contentCells.filter((cell) => cell.edge);

  /** Cell id -> overlay annotation_node id (edges may only connect nodes). */
  /** @type {Map<string, string>} */
  const nodeIdByCell = new Map();
  /** @type {Set<string>} */
  const usedIds = new Set();
  /** @type {any[]} */
  const annotationNodes = [];
  /** @type {any[]} */
  const notes = [];
  /** @type {any[]} */
  const annotationEdges = [];
  /** @type {Array<any>} */
  const displayMetadata = [];
  let metadataSeen = false;
  let hiddenSeen = false;

  for (const cell of vertices) {
    const overlayId = allocateOverlayId('node', cell.id, usedIds);
    if (cell.visible === false) hiddenSeen = true;
    const data = cell.data ?? {};
    if (
      data.origin !== null ||
      data.certainty !== null ||
      data.base_digest !== null ||
      data.diagram_id !== null ||
      data.cell_kind !== null
    ) {
      metadataSeen = true;
      displayMetadata.push({
        cell_id: cell.id,
        untrusted: true,
        data_origin: data.origin,
        data_certainty: data.certainty,
        data_base_digest: data.base_digest,
        data_diagram_id: data.diagram_id,
        data_cell_kind: data.cell_kind,
      });
    }
    const position = importPosition(cell.geometry, cell.id, warn);
    if (data.cell_kind === 'note') {
      notes.push({
        id: overlayId,
        kind: 'note',
        target_ref: null,
        text: textOr(cell.value, '(imported note)'),
        position,
      });
    } else {
      nodeIdByCell.set(cell.id, overlayId);
      annotationNodes.push({
        id: overlayId,
        kind: 'annotation_node',
        label: textOr(cell.value, '(imported node)'),
        description: null,
        position,
      });
    }
  }

  for (const cell of edgeCells) {
    if (!nodeIdByCell.has(cell.source) || !nodeIdByCell.has(cell.target)) {
      warn(`annotation_edge_dropped:${cell.id}:endpoint_missing`);
      continue;
    }
    const data = cell.data ?? {};
    if (
      data.origin !== null ||
      data.certainty !== null ||
      data.base_digest !== null ||
      data.diagram_id !== null ||
      data.cell_kind !== null
    ) {
      metadataSeen = true;
      displayMetadata.push({
        cell_id: cell.id,
        untrusted: true,
        data_origin: data.origin,
        data_certainty: data.certainty,
        data_base_digest: data.base_digest,
        data_diagram_id: data.diagram_id,
        data_cell_kind: data.cell_kind,
      });
    }
    annotationEdges.push({
      id: allocateOverlayId('edge', cell.id, usedIds),
      kind: 'annotation_edge',
      from: nodeIdByCell.get(cell.source),
      to: nodeIdByCell.get(cell.target),
      label: textOr(cell.value, '(imported edge)'),
      description: null,
    });
  }

  if (metadataSeen) warn('data_metadata_display_only');
  if (hiddenSeen) warn('hidden_cell_imported_as_visible');
  if (annotationNodes.length === 0 && notes.length === 0 && annotationEdges.length === 0) {
    warn('no_representable_cells');
  }
  if (notes.length > MAX_NOTES) {
    throw new DiagramError('LIMIT_EXCEEDED', `import has ${notes.length} notes; limit is ${MAX_NOTES}`);
  }
  if (annotationEdges.length > MAX_ANNOTATION_EDGES) {
    throw new DiagramError(
      'LIMIT_EXCEEDED',
      `import has ${annotationEdges.length} annotation edges; limit is ${MAX_ANNOTATION_EDGES}`,
    );
  }
  if (annotationNodes.length + notes.length + annotationEdges.length > MAX_ITEMS) {
    throw new DiagramError('LIMIT_EXCEEDED', `import exceeds ${MAX_ITEMS} overlay items`);
  }

  const now = resolveNow(options);
  const inputDigest = sha256Hex(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input));
  const diagramId =
    typeof options.diagram_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+~=-]{0,127}$/.test(options.diagram_id)
      ? options.diagram_id
      : `diagram:import-${inputDigest.slice(0, 16)}`;
  const title = typeof options.title === 'string' && options.title.length > 0 ? options.title : 'Imported diagram';
  const scopeRef =
    typeof options.scope_ref === 'string' && options.scope_ref.length > 0
      ? options.scope_ref
      : 'scope:external-import';

  /** @type {any} */
  const baseSpec = {
    schema_version: 1,
    diagram_id: diagramId,
    revision: 0,
    mode: 'conceptual',
    title,
    scope_ref: scopeRef,
    sources: [],
    nodes: [],
    edges: [],
    layout: { algorithm: 'layered_v1', direction: 'LR', positions: [] },
    coverage: {
      complete: false,
      truncated: false,
      omitted_nodes: 0,
      omitted_edges: 0,
      unresolved_count: 0,
      notes: ['External .drawio import: cells are display-only annotations; no evidence is promoted.'],
    },
    source_state: 'unknown',
    generated_at: now,
    renderer_ref: 'builtin:drawio-import-v1',
  };

  const specResult = contracts.validateDiagramSpec(baseSpec);
  if (!specResult.ok) {
    throw new DiagramError('INVALID_SPEC', 'constructed conceptual base spec is invalid', { errors: specResult.errors });
  }
  const baseSpecDigest = contracts.specDigest(baseSpec);

  /** @type {any} */
  const overlay = {
    schema_version: 1,
    diagram_id: diagramId,
    base_spec_digest: baseSpecDigest,
    revision: 0,
    items: [...annotationNodes, ...notes, ...annotationEdges],
    orphaned_annotations: [],
    updated_at: now,
  };
  const overlayResult = contracts.validateOverlay(overlay);
  if (!overlayResult.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'constructed import overlay is invalid', { errors: overlayResult.errors });
  }

  return {
    status: 'ok',
    base_spec: baseSpec,
    overlay,
    warnings,
    display_metadata: displayMetadata,
  };
}

/**
 * @param {Record<string, any>} options
 * @returns {string}
 */
function resolveNow(options) {
  if (typeof options.now === 'string') return options.now;
  if (typeof options.clock === 'function') {
    const value = options.clock();
    if (typeof value === 'string') return value;
  }
  return new Date().toISOString();
}
