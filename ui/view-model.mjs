/**
 * Pure view model + whitelisted SVG scene builder for the local editor panel.
 *
 * The panel is a view: this module turns the Host-provided canonical
 * `base_spec` and the local `AnnotationOverlayV1` into
 *  - a flat node/edge/note list with resolved positions, visibility, certainty
 *    and selection,
 *  - the source/version bar, certainty legend, unresolved/truncated warnings and
 *    hidden-count summary required by DIA-03/DIA-07,
 *  - a text-equivalent list,
 *  - a declarative SVG scene containing ONLY the whitelisted elements/attributes
 *    from docs/software-design.md §5 (`svg,g,rect,path,line,polyline,text,
 *    tspan,title,desc`). Labels are always text children, never attributes, and
 *    the panel renders each scene node with `createElement(tag)`, so React
 *    escapes all user text.
 *
 * No DOM globals at import time; everything is deterministic and Node-testable.
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** Whitelisted SVG element names (DIA-DESIGN-2 §5). */
export const WHITELISTED_SVG_TAGS = Object.freeze([
  'svg',
  'g',
  'rect',
  'path',
  'line',
  'polyline',
  'text',
  'tspan',
  'title',
  'desc',
]);

/** Whitelisted presentation attributes; no href, style URL, on* or foreignObject. */
export const SAFE_SVG_ATTRIBUTES = Object.freeze([
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'd',
  'points',
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'font-size',
  'font-family',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'dy',
  'transform',
  'opacity',
  'xmlns',
  'viewBox',
  'role',
  'aria-label',
]);

const TAG_SET = new Set(WHITELISTED_SVG_TAGS);
const ATTRIBUTE_SET = new Set(SAFE_SVG_ATTRIBUTES);

export const CERTAINTY_COLORS = Object.freeze({
  exact: '#2e7d32',
  may: '#ef6c00',
  unresolved: '#c62828',
  unknown: '#757575',
});

export const CERTAINTY_ORDER = Object.freeze(['exact', 'may', 'unresolved', 'unknown']);
export const LEGEND_LABELS = Object.freeze({
  exact: 'exact evidence',
  may: 'may / inferred',
  unresolved: 'unresolved',
  unknown: 'annotation / unknown',
});

export const DEFAULT_NODE_SIZE = Object.freeze({ width: 160, height: 64 });
export const NODE_GAP = 32;

/** @param {unknown} value @returns {boolean} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function intOr(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}

/** @param {string} label @param {number} maxChars @returns {string[]} */
export function wrapLabel(label, maxChars = 22) {
  const text = String(label ?? '');
  if (text.length <= maxChars) return [text];
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  /** @type {string[]} */
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    while (current.length > maxChars) {
      lines.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current !== '') lines.push(current);
  return lines.length === 0 ? [''] : lines;
}

/** @param {string} label @param {number} maxChars @returns {string} */
export function truncateLabel(label, maxChars = 42) {
  const text = String(label ?? '');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Resolve positions for every node/note of one document.
 * @param {any} spec
 * @param {any} overlay
 * @returns {{nodes:any[], hidden:Set<string>, layout:Map<string,any>}} sanitized
 */
function resolvePositions(spec, overlay) {
  /** @type {Map<string, any>} */
  const layout = new Map();
  for (const position of Array.isArray(spec?.layout?.positions) ? spec.layout.positions : []) {
    if (isRecord(position) && typeof position.node_id === 'string') layout.set(position.node_id, position);
  }
  const hidden = new Set();
  const items = Array.isArray(overlay?.items) ? overlay.items : [];
  for (const item of items) {
    if (item.kind === 'visibility' && item.hidden === true && typeof item.target_ref === 'string') hidden.add(item.target_ref);
    if (item.kind === 'layout' && isRecord(item.position) && typeof item.target_ref === 'string') {
      layout.set(item.target_ref, item.position);
    }
  }
  /** @type {any[]} */
  const nodes = [];
  for (const node of Array.isArray(spec?.nodes) ? spec.nodes : []) {
    const position = layout.get(node.id) ?? DEFAULT_NODE_SIZE;
    nodes.push({
      id: node.id,
      label: String(node.label ?? ''),
      kind: node.kind,
      origin: node.origin ?? 'evidence',
      evidence_count: Array.isArray(node.evidence_refs) ? node.evidence_refs.length : 0,
      annotation: false,
      hidden: hidden.has(node.id),
      x: intOr(position?.x, 0),
      y: intOr(position?.y, 0),
      width: intOr(position?.width, DEFAULT_NODE_SIZE.width),
      height: intOr(position?.height, DEFAULT_NODE_SIZE.height),
    });
  }
  for (const item of items) {
    if (item.kind !== 'annotation_node') continue;
    const position = item.position ?? DEFAULT_NODE_SIZE;
    nodes.push({
      id: item.id,
      label: String(item.label ?? ''),
      kind: 'note',
      origin: 'annotation',
      evidence_count: 0,
      annotation: true,
      hidden: false,
      x: intOr(position?.x, 0),
      y: intOr(position?.y, 0),
      width: intOr(position?.width, DEFAULT_NODE_SIZE.width),
      height: intOr(position?.height, DEFAULT_NODE_SIZE.height),
      description: item.description ?? null,
    });
  }
  return { nodes, hidden, layout };
}

/**
 * Build the full view state for one opened document.
 * @param {{base_spec:any, overlay:any, selection?:string[], current_version?:any, warnings?:string[]}} input
 * @returns {any}
 */
export function buildViewState(input) {
  const spec = input?.base_spec;
  const overlay = input?.overlay;
  const selection = new Set(Array.isArray(input?.selection) ? input.selection : []);
  const { nodes, hidden } = resolvePositions(spec, overlay);
  const visibleNodeIds = new Set(nodes.filter((node) => node.hidden !== true).map((node) => node.id));

  /** @type {any[]} */
  const edges = [];
  for (const edge of Array.isArray(spec?.edges) ? spec.edges : []) {
    const hiddenEdge = hidden.has(edge.id) || hidden.has(edge.from) || hidden.has(edge.to);
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: String(edge.label ?? ''),
      kind: edge.kind,
      certainty: edge.certainty ?? 'unknown',
      origin: edge.origin ?? 'evidence',
      annotation: false,
      hidden: hiddenEdge,
      visible: !hiddenEdge && visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to),
      selected: selection.has(edge.id),
    });
  }
  const items = Array.isArray(overlay?.items) ? overlay.items : [];
  for (const item of items) {
    if (item.kind !== 'annotation_edge') continue;
    const visible = visibleNodeIds.has(item.from) && visibleNodeIds.has(item.to);
    edges.push({
      id: item.id,
      from: item.from,
      to: item.to,
      label: String(item.label ?? ''),
      kind: 'annotation',
      certainty: 'unknown',
      origin: 'annotation',
      annotation: true,
      hidden: false,
      visible,
      selected: selection.has(item.id),
    });
  }

  /** @type {any[]} */
  const notes = [];
  for (const item of items) {
    if (item.kind !== 'note') continue;
    const position = item.position ?? DEFAULT_NODE_SIZE;
    notes.push({
      id: item.id,
      target_ref: item.target_ref ?? null,
      text: String(item.text ?? ''),
      x: intOr(position?.x, 0),
      y: intOr(position?.y, 0),
      width: intOr(position?.width, DEFAULT_NODE_SIZE.width),
      height: intOr(position?.height, DEFAULT_NODE_SIZE.height),
      selected: selection.has(item.id),
    });
  }

  /** @type {Record<string, number>} */
  const certaintyCounts = {};
  for (const kind of CERTAINTY_ORDER) certaintyCounts[kind] = 0;
  for (const edge of edges) {
    if (edge.visible !== true) continue;
    const kind = CERTAINTY_ORDER.includes(edge.certainty) ? edge.certainty : 'unknown';
    certaintyCounts[kind] += 1;
  }
  const legend = CERTAINTY_ORDER.map((kind) => ({
    kind,
    label: LEGEND_LABELS[kind],
    count: certaintyCounts[kind],
    color: CERTAINTY_COLORS[kind],
  }));

  const coverage = isRecord(spec?.coverage) ? spec.coverage : {};
  const orphaned = Array.isArray(overlay?.orphaned_annotations) ? overlay.orphaned_annotations : [];
  const warnings = {
    unresolved_count: intOr(coverage.unresolved_count, 0),
    truncated: coverage.truncated === true,
    omitted_nodes: intOr(coverage.omitted_nodes, 0),
    omitted_edges: intOr(coverage.omitted_edges, 0),
    hidden_nodes: nodes.filter((node) => node.hidden === true).length,
    hidden_edges: edges.filter((edge) => edge.hidden === true && edge.annotation !== true).length,
    orphaned_annotations: orphaned.length,
    store_warnings: Array.isArray(input?.warnings) ? input.warnings.slice(0, 16) : [],
  };

  /** @type {any[]} */
  const textEquivalent = [];
  for (const node of nodes) textEquivalent.push({ id: node.id, text: `node: ${node.label}` });
  for (const edge of edges) {
    if (edge.visible !== true) continue;
    const source = nodes.find((node) => node.id === edge.from);
    const target = nodes.find((node) => node.id === edge.to);
    textEquivalent.push({
      id: edge.id,
      text: `${source?.label ?? edge.from} -${edge.label === '' ? '' : `[${edge.label}]`}-> ${target?.label ?? edge.to} (${edge.certainty})`,
    });
  }
  for (const note of notes) textEquivalent.push({ id: note.id, text: `note: ${note.text}` });

  const xs = nodes.map((node) => [node.x, node.x + node.width]).flat();
  const ys = nodes.map((node) => [node.y, node.y + node.height]).flat();
  const minX = xs.length > 0 ? Math.min(...xs) : 0;
  const minY = ys.length > 0 ? Math.min(...ys) : 0;
  const maxX = xs.length > 0 ? Math.max(...xs) : 1;
  const maxY = ys.length > 0 ? Math.max(...ys) : 1;
  const padding = 40;
  const bounds = {
    min_x: minX - padding,
    min_y: minY - padding,
    max_x: maxX + padding,
    max_y: maxY + padding,
    width: Math.max(1, maxX - minX + padding * 2),
    height: Math.max(1, maxY - minY + padding * 2),
  };

  return {
    diagram_id: spec?.diagram_id ?? null,
    title: String(spec?.title ?? 'Untitled diagram'),
    mode: spec?.mode ?? 'conceptual',
    source_state: spec?.source_state ?? 'unknown',
    generated_at: spec?.generated_at ?? null,
    renderer_ref: spec?.renderer_ref ?? null,
    revision: intOr(spec?.revision, 0),
    document_id: input?.current_version?.document_id ?? null,
    generation: intOr(input?.current_version?.generation, 0),
    content_sha256: typeof input?.current_version?.content_sha256 === 'string' ? input.current_version.content_sha256 : null,
    nodes: nodes.map((node) => ({ ...node, selected: selection.has(node.id) })),
    edges,
    notes,
    legend,
    warnings,
    text_equivalent: textEquivalent,
    bounds,
  };
}

/* -------------------------------------------------------------------------- */
/* whitelisted SVG scene                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function asRecord(value) {
  return isRecord(value);
}

/**
 * Assert that a scene only contains whitelisted tags/attributes. Throws a coded
 * error instead of ever rendering an unsafe element.
 * @param {any} scene
 * @returns {any} scene
 */
export function assertSafeScene(scene) {
  if (!asRecord(scene) || !TAG_SET.has(scene.tag)) {
    throw new Error('SVG scene contains a non-whitelisted element');
  }
  for (const key of Object.keys(scene.attrs ?? {})) {
    if (!ATTRIBUTE_SET.has(key)) throw new Error(`SVG scene attribute "${key}" is not whitelisted`);
  }
  for (const child of Array.isArray(scene.children) ? scene.children : []) {
    if (typeof child === 'string') continue;
    if (Array.isArray(child)) {
      for (const nested of child) assertSafeScene(nested);
      continue;
    }
    assertSafeScene(child);
  }
  return scene;
}

/** @param {number} value @returns {number} */
function round(value) {
  return Math.round(value);
}

/** @param {string} text @param {number} max @returns {string} */
function clip(text, max) {
  return truncateLabel(text, max);
}

/**
 * Build the whitelisted SVG scene for a view state.
 * @param {any} view
 * @param {{width?:number, height?:number, selected?:string|null, connect_from?:string|null, preview?:{node_id:string,x:number,y:number}|null}} [options]
 * @returns {any} `{tag:'svg', attrs, children}`
 */
export function buildSvgScene(view, options = {}) {
  const bounds = view?.bounds ?? { width: 800, height: 600, min_x: -40, min_y: -40 };
  const width = Math.max(1, intOr(options.width, bounds.width));
  const height = Math.max(1, intOr(options.height, bounds.height));
  const nodeById = new Map((view?.nodes ?? []).map((node) => [node.id, node]));
  const selected = typeof options.selected === 'string' ? options.selected : null;
  const connectFrom = typeof options.connect_from === 'string' ? options.connect_from : null;
  const preview = isRecord(options.preview) && typeof options.preview.node_id === 'string' ? options.preview : null;

  /** @param {any} node @returns {{x:number,y:number}} */
  const nodePositionOf = (node) => {
    if (preview !== null && preview.node_id === node.id) {
      return { x: intOr(preview.x, node.x), y: intOr(preview.y, node.y) };
    }
    return { x: node.x, y: node.y };
  };

  /** @type {any[]} */
  const children = [];

  // Edges first so nodes draw above them.
  for (const edge of view?.edges ?? []) {
    if (edge.visible !== true) continue;
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (source === undefined || target === undefined) continue;
    const color = CERTAINTY_COLORS[edge.certainty] ?? CERTAINTY_COLORS.unknown;
    const dash = edge.certainty === 'exact' ? undefined : '6 4';
    const sourcePoint = nodePositionOf(source);
    const targetPoint = nodePositionOf(target);
    const x1 = round(sourcePoint.x + source.width / 2);
    const y1 = round(sourcePoint.y + source.height / 2);
    const x2 = round(targetPoint.x + target.width / 2);
    const y2 = round(targetPoint.y + target.height / 2);
    children.push({
      tag: 'line',
      attrs: { x1, y1, x2, y2, stroke: color, 'stroke-width': 2, ...(dash === undefined ? {} : { 'stroke-dasharray': dash }) },
      children: [],
    });
    // Small fixed arrowhead path (path is whitelisted; no marker/defs).
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const size = 8;
    const path = [
      `M ${x2} ${y2}`,
      `L ${round(x2 - size * Math.cos(angle - Math.PI / 6))} ${round(y2 - size * Math.sin(angle - Math.PI / 6))}`,
      `L ${round(x2 - size * Math.cos(angle + Math.PI / 6))} ${round(y2 - size * Math.sin(angle + Math.PI / 6))}`,
      'Z',
    ].join(' ');
    children.push({ tag: 'path', attrs: { d: path, fill: color, stroke: 'none' }, children: [] });
    const midX = round((x1 + x2) / 2);
    const midY = round((y1 + y2) / 2) - 6;
    children.push({
      tag: 'text',
      attrs: { x: midX, y: midY, 'font-size': 11, 'text-anchor': 'middle', fill: color, 'font-family': 'sans-serif' },
      children: [clip(edge.label, 42)],
    });
    children.push({ tag: 'title', attrs: {}, children: [`${edge.label || edge.id} (${edge.certainty})`] });
  }

  // Notes render above edges but below nodes.
  for (const note of view?.notes ?? []) {
    const isSelected = selected === note.id;
    children.push({
      tag: 'g',
      attrs: { transform: `translate(${note.x} ${note.y})` },
      children: [
        {
          tag: 'rect',
          attrs: {
            x: 0,
            y: 0,
            width: note.width,
            height: note.height,
            rx: 4,
            fill: '#fff2cc',
            stroke: isSelected ? '#1a73e8' : '#d6b656',
            'stroke-width': isSelected ? 3 : 1,
          },
          children: [],
        },
        {
          tag: 'text',
          attrs: { x: 8, y: 20, 'font-size': 12, fill: '#333333', 'font-family': 'sans-serif' },
          children: wrapLabel(note.text, 28).slice(0, 3),
        },
      ],
    });
  }

  for (const node of view?.nodes ?? []) {
    if (node.hidden === true) continue;
    const isSelected = selected === node.id;
    const isConnectSource = connectFrom === node.id;
    const stroke = isSelected || isConnectSource ? '#1a73e8' : node.annotation ? '#9673a6' : '#6c8ebf';
    const fill = node.annotation ? '#e1d5e7' : '#dae8fc';
    /** @type {any[]} */
    const texts = wrapLabel(node.label, 22)
      .slice(0, 3)
      .map((line, index) => ({
        tag: 'tspan',
        attrs: { x: 10, ...(index === 0 ? { dy: 0 } : { dy: 14 }) },
        children: [line],
      }));
    const rendered = nodePositionOf(node);
    children.push({
      tag: 'g',
      attrs: { transform: `translate(${rendered.x} ${rendered.y})` },
      children: [
        {
          tag: 'rect',
          attrs: {
            x: 0,
            y: 0,
            width: node.width,
            height: node.height,
            rx: 6,
            fill,
            stroke,
            'stroke-width': isSelected || isConnectSource ? 3 : 1,
            opacity: node.origin === 'evidence' ? 1 : 0.95,
          },
          children: [],
        },
        {
          tag: 'text',
          attrs: { x: 0, y: 22, 'font-size': 12, fill: '#1b1b1b', 'font-family': 'sans-serif', 'dominant-baseline': 'middle' },
          children: texts,
        },
        { tag: 'title', attrs: {}, children: [`${node.label} [${node.kind}${node.annotation ? ', annotation' : ''}]`] },
      ],
    });
  }

  const scene = {
    tag: 'svg',
    attrs: {
      xmlns: SVG_NS,
      viewBox: `${bounds.min_x} ${bounds.min_y} ${width} ${height}`,
      width,
      height,
      role: 'img',
      'aria-label': `Diagram: ${clip(view?.title ?? 'diagram', 120)}`,
    },
    children: [{ tag: 'title', attrs: {}, children: [clip(view?.title ?? 'diagram', 160)] }, ...children],
  };
  return assertSafeScene(scene);
}

/**
 * Rendering attributes for the panel's `<svg>` wrapper (from the same scene
 * contract, so the panel cannot drift into unsafe attributes).
 * @param {any} scene
 * @returns {Record<string, any>}
 */
export function svgAttributes(scene) {
  assertSafeScene(scene);
  return { ...scene.attrs };
}
