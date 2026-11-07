/**
 * 06 local diagrams — self-hosted SVG renderer (DIA-03).
 *
 * Frozen interface (docs/interfaces.md §5):
 *   renderSvg(spec, {overlay, layout}) ->
 *     {svg, text_equivalent:[{id,text}], legend:[{kind,label,count}], hidden:{nodes,edges,count}}
 *   escXml(text) -> string
 *
 * Safety contract:
 *  - only the whitelisted elements svg,g,rect,path,line,polyline,text,tspan,title,desc;
 *  - only fixed safe attributes (see SAFE_ATTRIBUTES); no style attributes, no
 *    href/xlink, no images, no script, no foreignObject, no event handlers;
 *  - every dynamic string (labels, titles, ids, data-* values) passes escXml();
 *  - characters that are not legal in XML 1.0 are removed, entity characters
 *    are always escaped (including '>'), lone surrogates cannot survive;
 *  - no remote references are generated. The SVG namespace declaration is
 *    emitted through a numeric character reference (still a valid namespace
 *    URI for XML parsers) so generated files contain no http(s):// substring.
 *
 * The renderer is pure: no clock, randomness, filesystem or network access.
 */
import { DiagramError } from './errors.mjs';
import { layoutDiagram, nodeBoxSize, routeEdges, wrapLabel, LAYOUT_METRICS } from './layout.mjs';

/** Fixed safe attribute names; anything else must never reach the serializer. */
export const SAFE_ATTRIBUTES = Object.freeze([
  'xmlns', 'width', 'height', 'viewBox', 'role', 'aria-labelledby',
  'id', 'class',
  'x', 'y', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray',
  'points', 'd', 'font-size', 'font-family', 'text-anchor',
  'data-node-id', 'data-edge-id', 'data-entity-id', 'data-certainty',
  'data-kind', 'data-origin', 'data-hidden',
]);

const SVG_NS_DECLARATION = 'xmlns="http&#x3a;//www.w3.org/2000/svg"';

const NODE_FONT_SIZE = 13;
const EDGE_FONT_SIZE = 11;
const NOTE_FONT_SIZE = 11;
const ARROW_SIZE = 8;
const NODE_RX = 6;

/** Certainty styles frozen for v1 (colors are fixed literals, never user data). */
export const CERTAINTY_STYLES = Object.freeze({
  exact: { stroke: '#1f2937', dash: null, label: 'exact 精确' },
  may: { stroke: '#b45309', dash: '6 4', label: 'may 可能' },
  unresolved: { stroke: '#b91c1c', dash: '2 4', label: 'unresolved 未解析' },
  unknown: { stroke: '#6b7280', dash: '6 4', label: 'unknown 未知/注释' },
});
export const CERTAINTY_ORDER = Object.freeze(['exact', 'may', 'unresolved', 'unknown']);

const NODE_EVIDENCE_STYLE = Object.freeze({ fill: '#eef2ff', stroke: '#4338ca', dash: null });
const NODE_ANNOTATION_STYLE = Object.freeze({ fill: '#f3f4f6', stroke: '#6b7280', dash: '5 3' });
const NOTE_STYLE = Object.freeze({ fill: '#fffbeb', stroke: '#b45309', dash: '4 3' });
const EDGE_LABEL_FILL = '#374151';
const NODE_TEXT_FILL = '#111827';

/** XML 1.0 legal character ranges. */
function isXmlChar(codePoint) {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/**
 * Escape text for XML text nodes and attribute values.
 * Non-XML characters (including lone surrogates) are dropped, not replaced, so
 * hostile input can never terminate a text node or reopen markup. A colon that
 * is directly followed by '//' is written as a numeric character reference:
 * the rendered glyphs are unchanged, but generated files then contain no
 * http(s):// substring anywhere (even for plain-text data labels), so offline
 * scans cannot mistake inert label text for a resource reference.
 * @param {unknown} text
 * @returns {string}
 */
export function escXml(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  let cleaned = '';
  for (const character of raw) {
    if (isXmlChar(/** @type {number} */ (character.codePointAt(0)))) cleaned += character;
  }
  const escaped = cleaned.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
  return escaped.replace(/:(?=\/\/)/g, '&#58;');
}

/** @param {number} value */
function int(value) {
  return Math.round(value);
}

/** @param {number} value @returns {string} */
function num(value) {
  return String(int(value));
}

/**
 * @param {string} tag
 * @param {Record<string, string|number|undefined|null>} attributes
 * @param {string} [content]
 * @returns {string}
 */
function element(tag, attributes, content) {
  const parts = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (!SAFE_ATTRIBUTES.includes(name) && name !== 'xmlns') {
      throw new DiagramError('INTERNAL_FAILURE', `unsafe SVG attribute: ${name}`);
    }
    parts.push(`${name}="${escXml(value)}"`);
  }
  const serialized = parts.length > 0 ? `${tag} ${parts.join(' ')}` : tag;
  return content === undefined ? `<${serialized}/>` : `<${serialized}>${content}</${tag}>`;
}

/** Normalize certainty for styling/counting; only the four frozen values count. */
function certaintyKey(edge) {
  return CERTAINTY_ORDER.includes(edge?.certainty) ? edge.certainty : 'unknown';
}

/** Position values are integers per DIA-OVERLAY-01; clamp to a safe display range. */
function positionValue(value, fallback) {
  if (!Number.isSafeInteger(value)) return fallback;
  return value;
}

/**
 * Build the renderable entity set from base spec + optional overlay.
 * @param {any} spec
 * @param {any} overlay
 * @param {any} layout
 */
function collectEntities(spec, overlay, layout) {
  const baseNodes = (spec.nodes ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const baseEdges = (spec.edges ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const items = Array.isArray(overlay?.items) ? overlay.items : [];

  /** @type {Map<string, any>} */ const layoutOverride = new Map();
  /** @type {Set<string>} */ const hiddenIds = new Set();
  const annotationNodes = [];
  const annotationEdges = [];
  const notes = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    if (item.kind === 'layout') layoutOverride.set(item.target_ref, item.position);
    else if (item.kind === 'visibility' && item.hidden === true) hiddenIds.add(item.target_ref);
    else if (item.kind === 'annotation_node') annotationNodes.push(item);
    else if (item.kind === 'annotation_edge') annotationEdges.push(item);
    else if (item.kind === 'note') notes.push(item);
  }
  annotationNodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  annotationEdges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  notes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  /** @type {Map<string, any>} */ const positionById = new Map();
  for (const position of layout?.positions ?? []) positionById.set(position.node_id, position);

  /** @type {Map<string, any>} */ const nodes = new Map();
  for (const node of baseNodes) {
    const base = positionById.get(node.id) ?? { x: LAYOUT_METRICS.margin, y: LAYOUT_METRICS.margin, width: 160, height: 64 };
    const override = layoutOverride.get(node.id);
    const box = nodeBoxSize(String(node.label ?? ''));
    const position = override ?? base;
    nodes.set(node.id, {
      id: node.id,
      label: String(node.label ?? ''),
      kind: node.kind,
      origin: node.origin === 'annotation' ? 'annotation' : 'evidence',
      description: typeof node.description === 'string' ? node.description : null,
      x: positionValue(position.x, base.x),
      y: positionValue(position.y, base.y),
      width: Math.max(1, positionValue(position.width, box.width)),
      height: Math.max(1, positionValue(position.height, box.height)),
      overlay: override !== undefined,
      note: false,
    });
  }
  for (const item of annotationNodes) {
    const box = nodeBoxSize(String(item.label ?? ''));
    nodes.set(item.id, {
      id: item.id,
      label: String(item.label ?? ''),
      kind: 'annotation_node',
      origin: 'annotation',
      description: typeof item.description === 'string' ? item.description : null,
      x: positionValue(item.position?.x, LAYOUT_METRICS.margin),
      y: positionValue(item.position?.y, LAYOUT_METRICS.margin),
      width: Math.max(1, positionValue(item.position?.width, box.width)),
      height: Math.max(1, positionValue(item.position?.height, box.height)),
      overlay: true,
      note: false,
    });
  }
  for (const item of notes) {
    nodes.set(item.id, {
      id: item.id,
      label: typeof item.text === 'string' ? item.text : '',
      kind: 'note',
      origin: 'annotation',
      description: null,
      x: positionValue(item.position?.x, LAYOUT_METRICS.margin),
      y: positionValue(item.position?.y, LAYOUT_METRICS.margin),
      width: Math.max(1, positionValue(item.position?.width, 160)),
      height: Math.max(1, positionValue(item.position?.height, 64)),
      overlay: true,
      note: true,
    });
  }

  /** @type {Map<string, any>} */ const edges = new Map();
  for (const edge of baseEdges) {
    edges.set(edge.id, {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      certainty: certaintyKey(edge),
      origin: edge.origin === 'annotation' ? 'annotation' : 'evidence',
      label: typeof edge.label === 'string' ? edge.label : '',
      description: typeof edge.explanation === 'string' ? edge.explanation : null,
      overlay: false,
    });
  }
  for (const item of annotationEdges) {
    edges.set(item.id, {
      id: item.id,
      from: item.from,
      to: item.to,
      kind: 'annotation',
      certainty: 'unknown',
      origin: 'annotation',
      label: typeof item.label === 'string' ? item.label : '',
      description: typeof item.description === 'string' ? item.description : null,
      overlay: true,
    });
  }

  // Visibility: base entity hidden => hidden; an edge with a hidden endpoint is
  // not drawn (still counted, never silently rewritten in the JSON package).
  /** @type {Set<string>} */ const hiddenEdges = new Set();
  for (const edge of edges.values()) {
    if (hiddenIds.has(edge.id) || hiddenIds.has(edge.from) || hiddenIds.has(edge.to)) hiddenEdges.add(edge.id);
  }
  /** @type {string[]} */ const hiddenNodes = [...nodes.keys()].filter((id) => hiddenIds.has(id)).sort();
  /** @type {string[]} */ const hiddenEdgesSorted = [...hiddenEdges].sort();
  return { nodes, edges, hiddenIds, hiddenEdges, hiddenNodes, hiddenEdgesSorted };
}

/**
 * Route list for renderable edges: base edges are routed by the layout engine;
 * overlay annotation edges get a direct (orthogonal fallback) route between the
 * overlay/base node boxes because they are not part of the deterministic base
 * layout geometry.
 */
function routeForRender(spec, layout, entities) {
  /** @type {Map<string, any>} */ const routes = new Map();
  const baseSpec = { nodes: spec.nodes ?? [], edges: spec.edges ?? [] };
  if (baseSpec.nodes.length > 0) {
    const baseLayout = layout ?? layoutDiagram(spec);
    for (const route of routeEdges(baseSpec, baseLayout)) routes.set(route.edge_id, route);
  }
  for (const edge of entities.edges.values()) {
    if (routes.has(edge.id)) continue;
    const from = entities.nodes.get(edge.from);
    const to = entities.nodes.get(edge.to);
    if (!from || !to) continue;
    routes.set(edge.id, { edge_id: edge.id, points: directRoute(from, to), back: true, self_loop: edge.from === edge.to });
  }
  return routes;
}

/** Simple 2/4 point route used for overlay annotation edges. */
function directRoute(from, to) {
  if (from.id === to.id) {
    return [
      { x: int(from.x + from.width), y: int(from.y + from.height / 2) },
      { x: int(from.x + from.width + LAYOUT_METRICS.self_loop_offset), y: int(from.y + from.height / 2) },
      { x: int(from.x + from.width + LAYOUT_METRICS.self_loop_offset), y: int(from.y - LAYOUT_METRICS.self_loop_offset / 2) },
      { x: int(from.x + from.width / 2), y: int(from.y - LAYOUT_METRICS.self_loop_offset / 2) },
      { x: int(from.x + from.width / 2), y: int(from.y) },
    ];
  }
  const start = { x: int(from.x + from.width), y: int(from.y + from.height / 2) };
  const end = { x: int(to.x), y: int(to.y + to.height / 2) };
  if (start.y === end.y) return [start, end];
  const midX = int((from.x + from.width + to.x) / 2);
  return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
}

/** @param {{x:number,y:number}[]} points @returns {string} */
function pathData(points) {
  if (points.length === 0) return '';
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${num(point.x)} ${num(point.y)}`).join(' ');
}

/** @param {{x:number,y:number}[]} points @returns {string} */
function polylinePoints(points) {
  return points.map((point) => `${num(point.x)},${num(point.y)}`).join(' ');
}

/**
 * Arrow head polyline for the last routed segment.
 * @param {{x:number,y:number}[]} points
 * @returns {{x:number,y:number}[]}
 */
function arrowHead(points) {
  if (points.length < 2) return [];
  const tip = points[points.length - 1];
  const previous = points[points.length - 2];
  const dx = tip.x - previous.x;
  const dy = tip.y - previous.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return [];
  const ux = dx / length;
  const uy = dy / length;
  const baseX = tip.x - ux * ARROW_SIZE;
  const baseY = tip.y - uy * ARROW_SIZE;
  const perpX = -uy * (ARROW_SIZE / 2);
  const perpY = ux * (ARROW_SIZE / 2);
  return [
    { x: int(tip.x), y: int(tip.y) },
    { x: int(baseX + perpX), y: int(baseY + perpY) },
    { x: int(baseX - perpX), y: int(baseY - perpY) },
  ];
}

/** @param {{x:number,y:number}[]} points */
function midpointLabelAnchor(points) {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  const total = [];
  for (let index = 1; index < points.length; index += 1) {
    total.push(Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  }
  const sum = total.reduce((left, right) => left + right, 0);
  let target = sum / 2;
  for (let index = 1; index < points.length; index += 1) {
    if (target <= total[index - 1]) {
      const start = points[index - 1];
      const end = points[index];
      const ratio = total[index - 1] === 0 ? 0 : target / total[index - 1];
      return { x: int(start.x + (end.x - start.x) * ratio), y: int(start.y + (end.y - start.y) * ratio) };
    }
    target -= total[index - 1];
  }
  return points[points.length - 1];
}

/**
 * Render a node box with wrapped label text lines.
 * @param {any} node
 * @param {string} styleKind
 */
function renderNode(node, styleKind) {
  const style = styleKind === 'note' ? NOTE_STYLE : node.origin === 'annotation' ? NODE_ANNOTATION_STYLE : NODE_EVIDENCE_STYLE;
  const fontSize = styleKind === 'note' ? NOTE_FONT_SIZE : NODE_FONT_SIZE;
  const centerX = int(node.x + node.width / 2);
  const maxLines = Math.max(1, Math.floor((node.height - 2 * LAYOUT_METRICS.pad_y) / LAYOUT_METRICS.line_height));
  const lines = wrapLabel(node.label).slice(0, maxLines);
  if (lines.length === 0) lines.push('');
  const lineHeight = LAYOUT_METRICS.line_height;
  const firstBaseline = int(node.y + node.height / 2 - ((lines.length - 1) * lineHeight) / 2 + fontSize * 0.35);
  const tspans = lines
    .map((line, index) => element('tspan', { x: centerX, y: firstBaseline + index * lineHeight }, escXml(line)))
    .join('');
  const titleText = node.note
    ? `${node.id}（注释）`
    : `${node.id}（${node.kind}；${node.origin === 'annotation' ? 'annotation' : 'evidence'}）`;
  const child = [
    element('title', {}, escXml(normalizeTitle(titleText, node.description))),
    element('rect', {
      x: num(node.x), y: num(node.y), width: num(node.width), height: num(node.height),
      rx: NODE_RX, ry: NODE_RX,
      fill: style.fill,
      stroke: style.stroke,
      'stroke-width': 1.5,
      'stroke-dasharray': style.dash,
    }),
    element('text', {
      x: centerX, y: firstBaseline, 'font-size': fontSize, 'font-family': 'sans-serif',
      fill: NODE_TEXT_FILL, 'text-anchor': 'middle',
    }, tspans),
  ].join('');
  return element('g', {
    class: styleKind === 'note' ? 'node note' : `node origin-${node.origin} kind-${node.kind}`,
    'data-node-id': node.id,
    'data-entity-id': node.id,
    'data-kind': node.kind,
    'data-origin': node.origin,
  }, child);
}

/** Title strings are data; cap length so fixed title elements stay small. */
function normalizeTitle(base, description) {
  const suffix = typeof description === 'string' && description.length > 0 ? `：${description.slice(0, 256)}` : '';
  return `${base}${suffix}`;
}

/**
 * Render one routed edge.
 * @param {any} edge
 * @param {any} route
 */
function renderEdge(edge, route) {
  const style = CERTAINTY_STYLES[certaintyKey(edge)];
  const points = Array.isArray(route.points) && route.points.length >= 2 ? route.points : [];
  if (points.length === 0) return '';
  const arrow = arrowHead(points);
  const labelAnchor = midpointLabelAnchor(points);
  const labelLines = edge.label.length > 0 ? wrapLabel(edge.label, 20).slice(0, 3) : [];
  const labelTspans = labelLines
    .map((line, index) => element('tspan', { x: labelAnchor.x + 6, y: labelAnchor.y - 6 + index * EDGE_FONT_SIZE }, escXml(line)))
    .join('');
  const child = [
    element('title', {}, escXml(`${edge.id}（${edge.kind}；certainty ${edge.certainty}${edge.origin === 'annotation' ? '；annotation' : ''}）${edge.description ? `：${edge.description.slice(0, 256)}` : ''}`)),
    element('path', {
      d: pathData(points), fill: 'none', stroke: style.stroke, 'stroke-width': 2,
      'stroke-dasharray': style.dash,
    }),
    arrow.length > 0
      ? element('polyline', { points: polylinePoints(arrow), fill: style.stroke, stroke: style.stroke, 'stroke-width': 1 })
      : '',
    labelTspans.length > 0
      ? element('text', {
          x: labelAnchor.x + 6, y: labelAnchor.y - 6, 'font-size': EDGE_FONT_SIZE,
          'font-family': 'sans-serif', fill: EDGE_LABEL_FILL,
        }, labelTspans)
      : '',
  ].join('');
  return element('g', {
    class: `edge certainty-${edge.certainty} origin-${edge.origin}${route.back ? ' back' : ''}${route.self_loop ? ' self-loop' : ''}`,
    'data-edge-id': edge.id,
    'data-entity-id': edge.id,
    'data-certainty': edge.certainty,
    'data-kind': edge.kind,
    'data-origin': edge.origin,
  }, child);
}

/** @param {unknown[]} positions @returns {{minX:number,minY:number,maxX:number,maxY:number}} */
function boundsOf(nodeList, routeList) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const stretch = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const node of nodeList) {
    stretch(node.x, node.y);
    stretch(node.x + node.width, node.y + node.height);
  }
  for (const route of routeList) {
    for (const point of route.points) stretch(point.x, point.y);
  }
  if (!Number.isFinite(minX)) {
    minX = LAYOUT_METRICS.margin;
    minY = LAYOUT_METRICS.margin;
    maxX = LAYOUT_METRICS.margin + 160;
    maxY = LAYOUT_METRICS.margin + 64;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Render the diagram to a standalone, whitelist-only SVG document.
 * @param {any} spec DiagramSpecV1-shaped value
 * @param {{overlay?:any, layout?:any}} [options]
 * @returns {{svg:string, text_equivalent:{id:string,text:string}[], legend:{kind:string,label:string,count:number}[], hidden:{nodes:string[],edges:string[],count:number}}}
 */
export function renderSvg(spec, options = {}) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new DiagramError('INVALID_SPEC', 'spec must be an object');
  }
  if (!Array.isArray(spec.nodes) || !Array.isArray(spec.edges)) {
    throw new DiagramError('INVALID_SPEC', 'spec.nodes and spec.edges must be arrays');
  }
  const overlay = options.overlay ?? null;
  if (overlay !== null && (typeof overlay !== 'object' || Array.isArray(overlay))) {
    throw new DiagramError('INVALID_OVERLAY', 'overlay must be an object');
  }
  const layout = options.layout ?? layoutDiagram(spec);
  const entities = collectEntities(spec, overlay, layout);
  const routes = routeForRender(spec, layout, entities);
  /** @type {Map<string, any>} */ const drawnNodes = new Map();
  for (const node of entities.nodes.values()) {
    if (entities.hiddenIds.has(node.id)) continue;
    drawnNodes.set(node.id, node);
  }
  // Keep a deterministic order: base/overlay nodes by id.
  const drawnNodeList = [...drawnNodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const drawnEdgeList = [...entities.edges.values()]
    .filter((edge) => {
      if (entities.hiddenEdges.has(edge.id)) return false;
      const from = entities.nodes.get(edge.from);
      const to = entities.nodes.get(edge.to);
      return Boolean(from && to && !entities.hiddenIds.has(edge.from) && !entities.hiddenIds.has(edge.to));
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const routeList = drawnEdgeList.map((edge) => routes.get(edge.id)).filter((route) => Boolean(route));

  // Normalize coordinates so negative overlay positions still produce a valid viewBox.
  const bounds = boundsOf(drawnNodeList, routeList);
  const offsetX = bounds.minX < LAYOUT_METRICS.margin ? LAYOUT_METRICS.margin - bounds.minX : 0;
  const offsetY = bounds.minY < LAYOUT_METRICS.margin ? LAYOUT_METRICS.margin - bounds.minY : 0;
  const width = Math.max(1, int(bounds.maxX + offsetX + LAYOUT_METRICS.margin));
  const height = Math.max(1, int(bounds.maxY + offsetY + LAYOUT_METRICS.margin));
  /** @param {{x:number,y:number}} point */
  const shift = (point) => ({ x: point.x + offsetX, y: point.y + offsetY });
  const shiftedNodes = drawnNodeList.map((node) => ({ ...node, x: node.x + offsetX, y: node.y + offsetY }));
  const shiftedRoutes = routeList.map((route) => ({ ...route, points: route.points.map(shift) }));

  const nodeMarkup = shiftedNodes.map((node) => renderNode(node, node.note ? 'note' : node.kind)).join('');
  const edgeMarkup = drawnEdgeList
    .map((edge, index) => renderEdge(edge, shiftedRoutes[index]))
    .join('');

  // Legend counts every base/overlay edge by certainty, including hidden ones
  // (visibility never rewrites evidence; the hidden warning reports the delta).
  const counts = Object.fromEntries(CERTAINTY_ORDER.map((kind) => [kind, 0]));
  for (const edge of entities.edges.values()) counts[certaintyKey(edge)] += 1;
  const legend = CERTAINTY_ORDER.map((kind) => ({
    kind,
    label: CERTAINTY_STYLES[kind].label,
    count: counts[kind],
  }));

  const title = typeof spec.title === 'string' && spec.title.length > 0 ? spec.title : 'diagram';
  const descParts = [
    `diagram ${spec.diagram_id ?? ''}`,
    `mode ${spec.mode ?? ''}`,
    `nodes ${drawnNodeList.length}`,
    `edges ${drawnEdgeList.length}`,
    `source_state ${spec.source_state ?? 'unknown'}`,
  ];
  if (entities.hiddenNodes.length + entities.hiddenEdgesSorted.length > 0) {
    descParts.push(`hidden ${entities.hiddenNodes.length} nodes ${entities.hiddenEdgesSorted.length} edges`);
  }
  const svg = [
    `<svg ${SVG_NS_DECLARATION} width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="ld-title ld-desc">`,
    element('title', { id: 'ld-title' }, escXml(title)),
    element('desc', { id: 'ld-desc' }, escXml(descParts.join('; '))),
    `<g class="edges">${edgeMarkup}</g>`,
    `<g class="nodes">${nodeMarkup}</g>`,
    '</svg>',
  ].join('');

  // Text equivalent: every drawn node and edge in stable order.
  /** @type {{id:string,text:string}[]} */ const textEquivalent = [];
  for (const node of drawnNodeList) {
    const label = node.label.length > 0 ? node.label : node.id;
    textEquivalent.push({
      id: node.id,
      text: `[节点] ${label}（类型 ${node.kind}，来源 ${node.origin === 'annotation' ? 'annotation' : 'evidence'}）`,
    });
  }
  for (const edge of drawnEdgeList) {
    const from = entities.nodes.get(edge.from);
    const to = entities.nodes.get(edge.to);
    const fromLabel = from?.label || edge.from;
    const toLabel = to?.label || edge.to;
    textEquivalent.push({
      id: edge.id,
      text: `[边] ${fromLabel} → ${toLabel}：${edge.label.length > 0 ? edge.label : edge.kind}（置信 ${edge.certainty}，类型 ${edge.kind}）`,
    });
  }

  return {
    svg,
    text_equivalent: textEquivalent,
    legend,
    hidden: {
      nodes: entities.hiddenNodes,
      edges: entities.hiddenEdgesSorted,
      count: entities.hiddenNodes.length + entities.hiddenEdgesSorted.length,
    },
  };
}

export { SVG_NS_DECLARATION };
