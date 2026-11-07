/**
 * 06 local diagrams — deterministic layered layout (DIA-03).
 *
 * Frozen interface (docs/interfaces.md §4):
 *   layoutDiagram(spec, {direction='LR'}) -> {algorithm:'layered_v1', direction, positions}
 *   routeEdges(spec, layoutResult)         -> [{edge_id, points, back, self_loop}]
 *   layoutDigest(layoutResult)             -> sha256 hex
 *
 * Algorithm:
 *  1. nodes are ordered by stable ID (UTF-16 code-unit order, engine independent);
 *  2. strongly connected components are computed with Tarjan's algorithm;
 *  3. the SCC condensation DAG is layered by longest path;
 *  4. two top-down barycenter sweeps reorder each layer (upstream positions,
 *     ties broken by stable ID; SCC members stay adjacent);
 *  5. integer coordinates: layer gap 96, node gap 32, min node 160x64.
 *
 * The same spec + direction always produces byte-identical positions. Array
 * order in the spec never influences the result. Edges inside an SCC (cycles)
 * and self loops get their own orthogonal route; they are never dropped.
 *
 * Limits are rejected before any output (LIMIT_EXCEEDED); layout never silently
 * drops nodes or edges — coverage truncation is the caller's decision.
 */
import { digestOf } from './canonical.mjs';
import { DiagramError } from './errors.mjs';
import { LIMITS } from './limits.mjs';

export const LAYOUT_ALGORITHM = 'layered_v1';
export const LAYOUT_DIRECTIONS = Object.freeze(['LR', 'TB']);

/** Geometry constants frozen for v1 (engineering values, see LIMITS). */
export const LAYOUT_METRICS = Object.freeze({
  algorithm: LAYOUT_ALGORITHM,
  margin: 24,
  char_width: 8,
  line_height: 18,
  pad_x: 16,
  pad_y: 12,
  max_label_line_chars: 24,
  max_node_width: 480,
  min_node_width: LIMITS.node_min_width,
  min_node_height: LIMITS.node_min_height,
  layer_gap: LIMITS.layer_gap,
  node_gap: LIMITS.node_gap,
  self_loop_offset: 32,
  back_route_offset: 24,
});

const M = LAYOUT_METRICS;

/**
 * Locale-independent stable string comparison (UTF-16 code units).
 * @param {string} a @param {string} b @returns {number}
 */
export function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Split a plain-text label into display lines. Explicit newlines are respected
 * and hard-wrapped every `maxChars` code points. Never returns an empty list.
 * Control characters are kept here (deterministic sizing); the SVG renderer
 * strips characters that are invalid in XML when escaping.
 * @param {string} label
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function wrapLabel(label, maxChars = M.max_label_line_chars) {
  const text = typeof label === 'string' ? label : String(label ?? '');
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : M.max_label_line_chars;
  /** @type {string[]} */
  const lines = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const chars = Array.from(rawLine);
    if (chars.length === 0) {
      lines.push('');
      continue;
    }
    for (let i = 0; i < chars.length; i += limit) lines.push(chars.slice(i, i + limit).join(''));
  }
  return lines.length > 0 ? lines : [''];
}

/**
 * Deterministic node box size from its label.
 * @param {string} label
 * @returns {{width:number,height:number,lines:string[]}}
 */
export function nodeBoxSize(label) {
  const lines = wrapLabel(label);
  let longest = 0;
  for (const line of lines) longest = Math.max(longest, Array.from(line).length);
  const width = Math.max(
    M.min_node_width,
    Math.min(M.max_node_width, longest * M.char_width + 2 * M.pad_x),
  );
  const height = Math.max(M.min_node_height, lines.length * M.line_height + 2 * M.pad_y);
  return { width, height, lines };
}

/** @param {unknown} value @param {string} name @returns {void} */
function assertIdList(value, name) {
  if (!Array.isArray(value)) throw new DiagramError('INVALID_SPEC', `${name} must be an array`);
}

/** @param {any} edge @param {number} index */
function normalizeEdge(edge, index) {
  if (edge === null || typeof edge !== 'object') {
    throw new DiagramError('INVALID_SPEC', `edges[${index}] must be an object`);
  }
  if (typeof edge.id !== 'string' || edge.id.length === 0) {
    throw new DiagramError('INVALID_SPEC', `edges[${index}].id must be a non-empty string`);
  }
  if (typeof edge.from !== 'string' || edge.from.length === 0) {
    throw new DiagramError('INVALID_SPEC', `edges[${index}].from must be a non-empty string`);
  }
  if (typeof edge.to !== 'string' || edge.to.length === 0) {
    throw new DiagramError('INVALID_SPEC', `edges[${index}].to must be a non-empty string`);
  }
  return edge;
}

/**
 * Light structural check at the layout boundary. Full DiagramSpec schema
 * validation belongs to src/contracts.mjs; layout only needs the shape it
 * reads, and it must fail closed rather than drop entities.
 * @param {any} spec
 * @returns {{nodes: any[], edges: any[]}}
 */
function normalizeSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new DiagramError('INVALID_SPEC', 'spec must be an object');
  }
  assertIdList(spec.nodes, 'nodes');
  assertIdList(spec.edges, 'edges');
  const nodes = spec.nodes.map((node, index) => {
    if (node === null || typeof node !== 'object') {
      throw new DiagramError('INVALID_SPEC', `nodes[${index}] must be an object`);
    }
    if (typeof node.id !== 'string' || node.id.length === 0) {
      throw new DiagramError('INVALID_SPEC', `nodes[${index}].id must be a non-empty string`);
    }
    return node;
  });
  const edges = spec.edges.map((edge, index) => normalizeEdge(edge, index));
  const seen = new Set();
  for (const node of nodes) {
    if (seen.has(node.id)) throw new DiagramError('INVALID_SPEC', `duplicate node id: ${node.id}`);
    seen.add(node.id);
  }
  for (const edge of edges) {
    if (!seen.has(edge.from) || !seen.has(edge.to)) {
      throw new DiagramError('INVALID_SPEC', `edge ${edge.id} references an unknown node`);
    }
  }
  return { nodes, edges };
}

/**
 * Enforce layout resource limits up front. `limits` may override the frozen
 * defaults for boundary tests; values are positive safe integers.
 * @param {{nodes:any[],edges:any[]}} graph
 * @param {object} [limits]
 */
function enforceLimits(graph, limits = {}) {
  const maxNodes = limits?.nodes ?? LIMITS.nodes;
  const maxEdges = limits?.edges ?? LIMITS.edges;
  const maxLayers = limits?.max_layers ?? LIMITS.max_layers;
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 0) {
    throw new DiagramError('INVALID_INPUT', 'limits.nodes must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxEdges) || maxEdges < 0) {
    throw new DiagramError('INVALID_INPUT', 'limits.edges must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxLayers) || maxLayers < 0) {
    throw new DiagramError('INVALID_INPUT', 'limits.max_layers must be a non-negative safe integer');
  }
  if (graph.nodes.length > maxNodes) {
    throw new DiagramError('LIMIT_EXCEEDED', `node count ${graph.nodes.length} exceeds limit ${maxNodes}`);
  }
  if (graph.edges.length > maxEdges) {
    throw new DiagramError('LIMIT_EXCEEDED', `edge count ${graph.edges.length} exceeds limit ${maxEdges}`);
  }
  return maxLayers;
}

/**
 * Tarjan strongly connected components (iterative).
 * @param {string[]} nodeIds sorted stable IDs
 * @param {Map<string,string[]>} outAdj sorted adjacency by stable ID
 * @returns {string[][]} components: nodes sorted by ID, list sorted by min ID
 */
function tarjanScc(nodeIds, outAdj) {
  /** @type {Map<string, number>} */ const index = new Map();
  /** @type {Map<string, number>} */ const low = new Map();
  /** @type {Set<string>} */ const onStack = new Set();
  /** @type {string[]} */ const stack = [];
  /** @type {string[][]} */ const components = [];
  let counter = 0;
  for (const start of nodeIds) {
    if (index.has(start)) continue;
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    /** @type {{v:string,i:number}[]} */ const frames = [{ v: start, i: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const v = frame.v;
      const adjacency = outAdj.get(v) ?? [];
      if (frame.i < adjacency.length) {
        const w = adjacency[frame.i];
        frame.i += 1;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter += 1;
          stack.push(w);
          onStack.add(w);
          frames.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(/** @type {number} */ (low.get(v)), /** @type {number} */ (index.get(w))));
        }
        continue;
      }
      frames.pop();
      if (low.get(v) === index.get(v)) {
        /** @type {string[]} */ const component = [];
        for (;;) {
          const w = /** @type {string} */ (stack.pop());
          onStack.delete(w);
          component.push(w);
          if (w === v) break;
        }
        component.sort(compareIds);
        components.push(component);
      }
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].v;
        low.set(parent, Math.min(/** @type {number} */ (low.get(parent)), /** @type {number} */ (low.get(v))));
      }
    }
  }
  components.sort((a, b) => compareIds(a[0], b[0]));
  return components;
}

/** @param {number} value @returns {number} */
function int(value) {
  return Math.round(value);
}

/**
 * Deterministic layered layout.
 * @param {object} spec DiagramSpecV1-shaped value
 * @param {{direction?:'LR'|'TB', limits?:object}} [options]
 */
export function layoutDiagram(spec, options = {}) {
  const direction = options.direction ?? 'LR';
  if (!LAYOUT_DIRECTIONS.includes(direction)) {
    throw new DiagramError('INVALID_INPUT', `direction must be one of ${LAYOUT_DIRECTIONS.join('|')}`);
  }
  const graph = normalizeSpec(spec);
  const maxLayers = enforceLimits(graph, options.limits);
  const nodeIds = graph.nodes.map((node) => node.id).sort(compareIds);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges.slice().sort((a, b) => compareIds(a.id, b.id));

  /** @type {Map<string,string[]>} */ const outAdj = new Map();
  /** @type {Map<string,string[]>} */ const inAdj = new Map();
  for (const id of nodeIds) {
    outAdj.set(id, []);
    inAdj.set(id, []);
  }
  for (const edge of edges) {
    const out = /** @type {string[]} */ (outAdj.get(edge.from));
    const inc = /** @type {string[]} */ (inAdj.get(edge.to));
    if (!out.includes(edge.to)) out.push(edge.to);
    if (!inc.includes(edge.from)) inc.push(edge.from);
  }
  for (const list of outAdj.values()) list.sort(compareIds);
  for (const list of inAdj.values()) list.sort(compareIds);

  const components = tarjanScc(nodeIds, outAdj);
  /** @type {Map<string, number>} */ const componentOf = new Map();
  components.forEach((component, index) => {
    for (const id of component) componentOf.set(id, index);
  });

  // Condensation DAG (edges between distinct SCCs), deterministic order.
  /** @type {Set<number>[]} */ const dagOut = components.map(() => new Set());
  /** @type {Set<number>[]} */ const dagIn = components.map(() => new Set());
  for (const edge of edges) {
    const fromComponent = /** @type {number} */ (componentOf.get(edge.from));
    const toComponent = /** @type {number} */ (componentOf.get(edge.to));
    if (fromComponent === toComponent) continue;
    dagOut[fromComponent].add(toComponent);
    dagIn[toComponent].add(fromComponent);
  }

  // Longest-path layering over the condensation DAG.
  const componentIds = components.map((_, index) => index);
  const indegree = dagIn.map((set) => set.size);
  /** @type {number[]} */ const layerOf = components.map(() => 0);
  const queue = componentIds.filter((index) => indegree[index] === 0).sort((a, b) => compareIds(components[a][0], components[b][0]));
  let head = 0;
  let processed = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    processed += 1;
    const nextComponents = [...dagOut[current]].sort((a, b) => compareIds(components[a][0], components[b][0]));
    for (const next of nextComponents) {
      layerOf[next] = Math.max(layerOf[next], layerOf[current] + 1);
      indegree[next] -= 1;
      if (indegree[next] === 0) queue.push(next);
    }
  }
  if (processed !== components.length) {
    // Tarjan guarantees this cannot happen; fail closed if the invariant breaks.
    throw new DiagramError('INTERNAL_FAILURE', 'condensation DAG is not acyclic');
  }
  const layerCount = components.length === 0 ? 0 : Math.max(...layerOf) + 1;
  if (layerCount > maxLayers) {
    throw new DiagramError('LIMIT_EXCEEDED', `layer count ${layerCount} exceeds limit ${maxLayers}`);
  }

  // Initial order: components sorted by min node ID, then nodes by stable ID.
  /** @type {number[][]} */ const layers = Array.from({ length: layerCount }, () => []);
  for (let index = 0; index < components.length; index += 1) layers[layerOf[index]].push(index);
  for (const layer of layers) layer.sort((a, b) => compareIds(components[a][0], components[b][0]));

  /** Position of a node inside its current layer, for barycenter math. */
  const positionsInLayer = new Map();
  for (const layer of layers) {
    let index = 0;
    for (const componentIndex of layer) {
      for (const id of components[componentIndex]) {
        positionsInLayer.set(id, { layerIndex: layers.indexOf(layer), index, size: 0 });
        index += 1;
      }
    }
  }
  for (const layer of layers) {
    const size = layer.reduce((total, componentIndex) => total + components[componentIndex].length, 0);
    let index = 0;
    for (const componentIndex of layer) {
      for (const id of components[componentIndex]) {
        positionsInLayer.get(id).size = size;
        positionsInLayer.get(id).index = index;
        index += 1;
      }
    }
  }

  // Two top-down upstream barycenter sweeps.
  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (let layerIndex = 1; layerIndex < layers.length; layerIndex += 1) {
      const previous = layers[layerIndex - 1];
      const previousSize = previous.reduce((total, componentIndex) => total + components[componentIndex].length, 0);
      /** @type {Map<string, number>} */ const barycenter = new Map();
      for (const id of components.flatMap((component, componentIndex) => (layers[layerIndex].includes(componentIndex) ? component : []))) {
        const self = positionsInLayer.get(id);
        const own = previousSize <= 1 ? 0 : self.index / Math.max(1, self.size - 1);
        const predecessors = /** @type {string[]} */ (inAdj.get(id) ?? []).filter((pred) => positionsInLayer.get(pred).layerIndex === layerIndex - 1);
        if (predecessors.length === 0) {
          barycenter.set(id, own);
          continue;
        }
        let total = 0;
        for (const pred of predecessors) {
          const position = positionsInLayer.get(pred);
          total += previousSize <= 1 ? 0 : position.index / Math.max(1, previousSize - 1);
        }
        barycenter.set(id, total / predecessors.length);
      }
      /** Average barycenter per component; ties by min node ID. */
      const componentKey = (componentIndex) => {
        const members = components[componentIndex];
        let total = 0;
        for (const id of members) total += /** @type {number} */ (barycenter.get(id));
        return total / members.length;
      };
      layers[layerIndex].sort((a, b) => {
        const delta = componentKey(a) - componentKey(b);
        return delta !== 0 ? delta : compareIds(components[a][0], components[b][0]);
      });
      // Rebuild positions for the next sweep.
      const size = layers[layerIndex].reduce((total, componentIndex) => total + components[componentIndex].length, 0);
      let index = 0;
      for (const componentIndex of layers[layerIndex]) {
        const members = components[componentIndex].slice().sort((a, b) => {
          const delta = /** @type {number} */ (barycenter.get(a)) - /** @type {number} */ (barycenter.get(b));
          return delta !== 0 ? delta : compareIds(a, b);
        });
        components[componentIndex].splice(0, components[componentIndex].length, ...members);
        for (const id of members) {
          const position = positionsInLayer.get(id);
          position.layerIndex = layerIndex;
          position.index = index;
          position.size = size;
          index += 1;
        }
      }
    }
  }

  // Flatten final layer order, then assign integer coordinates.
  /** @type {{node_id:string,x:number,y:number,width:number,height:number}[]} */ const positions = [];
  const boxById = new Map();
  for (const id of nodeIds) {
    const node = nodeById.get(id);
    const box = nodeBoxSize(String(node.label ?? ''));
    boxById.set(id, box);
  }
  const layerNodes = layers.map((layer) => layer.flatMap((componentIndex) => components[componentIndex]));
  if (direction === 'LR') {
    const layerWidths = layerNodes.map((ids) => ids.reduce((max, id) => Math.max(max, boxById.get(id).width), 0));
    let x = M.margin;
    for (let layerIndex = 0; layerIndex < layerNodes.length; layerIndex += 1) {
      let y = M.margin;
      for (const id of layerNodes[layerIndex]) {
        const box = boxById.get(id);
        positions.push({ node_id: id, x: int(x), y: int(y), width: box.width, height: box.height });
        y += box.height + M.node_gap;
      }
      x += layerWidths[layerIndex] + M.layer_gap;
    }
  } else {
    // In TB, layers are rows: nodes are laid out horizontally and a row is as
    // tall as its tallest node.
    let y = M.margin;
    for (let layerIndex = 0; layerIndex < layerNodes.length; layerIndex += 1) {
      let x = M.margin;
      for (const id of layerNodes[layerIndex]) {
        const box = boxById.get(id);
        positions.push({ node_id: id, x: int(x), y: int(y), width: box.width, height: box.height });
        x += box.width + M.node_gap;
      }
      const maxHeight = layerNodes[layerIndex].reduce((max, id) => Math.max(max, boxById.get(id).height), 0);
      y += maxHeight + M.layer_gap;
    }
  }
  positions.sort((a, b) => compareIds(a.node_id, b.node_id));
  return { algorithm: LAYOUT_ALGORITHM, direction, positions };
}

/**
 * Orthogonal edge routes. Forward edges get an S-shaped 2/4 point route;
 * self loops get a top-right loop; intra-layer (cycle) edges get a bottom
 * detour and are reported as `back: true` so callers can style them apart.
 * @param {object} spec
 * @param {{algorithm?:string,direction?:'LR'|'TB',positions:any[]}} layoutResult
 * @returns {{edge_id:string, points:{x:number,y:number}[], back:boolean, self_loop:boolean}[]}
 */
export function routeEdges(spec, layoutResult) {
  const graph = normalizeSpec(spec);
  const direction = layoutResult?.direction ?? 'LR';
  if (!LAYOUT_DIRECTIONS.includes(direction)) {
    throw new DiagramError('INVALID_INPUT', `direction must be one of ${LAYOUT_DIRECTIONS.join('|')}`);
  }
  if (!layoutResult || !Array.isArray(layoutResult.positions)) {
    throw new DiagramError('INVALID_INPUT', 'layoutResult.positions must be an array');
  }
  /** @type {Map<string, {x:number,y:number,width:number,height:number}>} */ const byId = new Map();
  for (const position of layoutResult.positions) {
    byId.set(position.node_id, position);
  }
  for (const node of graph.nodes) {
    if (!byId.has(node.id)) throw new DiagramError('INVALID_INPUT', `layout has no position for node ${node.id}`);
  }
  const routes = [];
  let backIndex = 0;
  for (const edge of graph.edges.slice().sort((a, b) => compareIds(a.id, b.id))) {
    const from = /** @type {any} */ (byId.get(edge.from));
    const to = /** @type {any} */ (byId.get(edge.to));
    const forward = direction === 'LR' ? to.x > from.x : to.y > from.y;
    if (edge.from === edge.to || forward) {
      routes.push({ edge_id: edge.id, ...routeOne(edge, from, to, direction, 0) });
    } else {
      // Stack non-forward (cycle / same-layer) routes so they never overlap:
      // each gets its own deterministic parallel channel.
      backIndex += 1;
      routes.push({
        edge_id: edge.id,
        ...routeOne(edge, from, to, direction, M.back_route_offset + (backIndex - 1) * 14),
      });
    }
  }
  return routes;
}

/** @param {any} from @param {any} to @param {'LR'|'TB'} direction @param {number} offset */
function routeOne(edge, from, to, direction, offset) {
  const isLr = direction === 'LR';
  if (edge.from === edge.to) {
    if (isLr) {
      const points = [
        { x: int(from.x + from.width), y: int(from.y + from.height / 2) },
        { x: int(from.x + from.width + M.self_loop_offset), y: int(from.y + from.height / 2) },
        { x: int(from.x + from.width + M.self_loop_offset), y: int(from.y - M.self_loop_offset / 2) },
        { x: int(from.x + from.width / 2), y: int(from.y - M.self_loop_offset / 2) },
        { x: int(from.x + from.width / 2), y: int(from.y) },
      ];
      return { points, back: false, self_loop: true };
    }
    const points = [
      { x: int(from.x + from.width / 2), y: int(from.y) },
      { x: int(from.x + from.width / 2), y: int(from.y - M.self_loop_offset) },
      { x: int(from.x - M.self_loop_offset / 2), y: int(from.y - M.self_loop_offset) },
      { x: int(from.x - M.self_loop_offset / 2), y: int(from.y + from.height / 2) },
      { x: int(from.x), y: int(from.y + from.height / 2) },
    ];
    return { points, back: false, self_loop: true };
  }
  const channel = Math.max(M.back_route_offset, offset);
  const forward = isLr ? to.x > from.x : to.y > from.y;
  const overlap = isLr
    ? Math.abs(from.x + from.width / 2 - (to.x + to.width / 2)) < Math.max(from.width, to.width)
    : Math.abs(from.y + from.height / 2 - (to.y + to.height / 2)) < Math.max(from.height, to.height);
  if (!forward) {
    // Cycle / same-layer edge: use a side channel when boxes overlap on the
    // layout axis, otherwise a channel past both boxes.
    if (isLr) {
      if (overlap) {
        const right = Math.max(from.x + from.width, to.x + to.width) + channel;
        const points = [
          { x: int(from.x + from.width), y: int(from.y + from.height / 2) },
          { x: int(right), y: int(from.y + from.height / 2) },
          { x: int(right), y: int(to.y + to.height / 2) },
          { x: int(to.x + to.width), y: int(to.y + to.height / 2) },
        ];
        return { points, back: true, self_loop: false };
      }
      const below = Math.max(from.y + from.height, to.y + to.height) + channel;
      const points = [
        { x: int(from.x + from.width / 2), y: int(from.y + from.height) },
        { x: int(from.x + from.width / 2), y: int(below) },
        { x: int(to.x + to.width / 2), y: int(below) },
        { x: int(to.x + to.width / 2), y: int(to.y + to.height) },
      ];
      return { points, back: true, self_loop: false };
    }
    if (overlap) {
      const below = Math.max(from.y + from.height, to.y + to.height) + channel;
      const points = [
        { x: int(from.x + from.width / 2), y: int(from.y + from.height) },
        { x: int(from.x + from.width / 2), y: int(below) },
        { x: int(to.x + to.width / 2), y: int(below) },
        { x: int(to.x + to.width / 2), y: int(to.y + to.height) },
      ];
      return { points, back: true, self_loop: false };
    }
    const right = Math.max(from.x + from.width, to.x + to.width) + channel;
    const points = [
      { x: int(from.x + from.width), y: int(from.y + from.height / 2) },
      { x: int(right), y: int(from.y + from.height / 2) },
      { x: int(right), y: int(to.y + to.height / 2) },
      { x: int(to.x + to.width), y: int(to.y + to.height / 2) },
    ];
    return { points, back: true, self_loop: false };
  }
  if (isLr) {
    const start = { x: int(from.x + from.width), y: int(from.y + from.height / 2) };
    const end = { x: int(to.x), y: int(to.y + to.height / 2) };
    if (start.y === end.y) return { points: [start, end], back: false, self_loop: false };
    const midX = int((from.x + from.width + to.x) / 2);
    return {
      points: [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end],
      back: false,
      self_loop: false,
    };
  }
  const start = { x: int(from.x + from.width / 2), y: int(from.y + from.height) };
  const end = { x: int(to.x + to.width / 2), y: int(to.y) };
  if (start.x === end.x) return { points: [start, end], back: false, self_loop: false };
  const midY = int((from.y + from.height + to.y) / 2);
  return {
    points: [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end],
    back: false,
    self_loop: false,
  };
}

/**
 * Deterministic digest of a layout result (positions are sorted by node ID).
 * @param {{algorithm:string,direction:string,positions:any[]}} layoutResult
 * @returns {string}
 */
export function layoutDigest(layoutResult) {
  if (layoutResult === null || typeof layoutResult !== 'object') {
    throw new DiagramError('INVALID_INPUT', 'layoutResult must be an object');
  }
  return digestOf(layoutResult);
}
