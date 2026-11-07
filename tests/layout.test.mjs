/**
 * T2 layout tests — determinism, SCC/layering, routes, limits.
 *
 * Run: node --test tests/layout.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutDiagram,
  routeEdges,
  layoutDigest,
  wrapLabel,
  nodeBoxSize,
  compareIds,
  LAYOUT_METRICS,
} from '../src/layout.mjs';
import { LIMITS } from '../src/limits.mjs';

/** @param {string} id @param {string} [label] */
function node(id, label = id) {
  return { id, label, kind: 'module', origin: 'evidence', evidence_refs: [], description: null };
}

/** @param {string} id @param {string} from @param {string} to @param {string} [certainty] */
function edge(id, from, to, certainty = 'exact') {
  return { id, from, to, kind: 'call', certainty, origin: 'evidence', label: id, evidence_refs: [], explanation: null };
}

/** @param {{nodes?:any[],edges?:any[]}} parts */
function spec(parts) {
  return {
    schema_version: 1,
    diagram_id: 'diagram:layout-test',
    revision: 1,
    mode: 'evidence',
    title: 'layout test',
    scope_ref: 'ws:test',
    sources: [],
    nodes: parts.nodes ?? [],
    edges: parts.edges ?? [],
    layout: { algorithm: 'layered_v1', direction: 'LR', positions: [] },
    coverage: { complete: false, truncated: false, omitted_nodes: 0, omitted_edges: 0, unresolved_count: 0, notes: [] },
    source_state: 'unknown',
    generated_at: '2026-11-07T00:00:00.000Z',
    renderer_ref: 'builtin:renderer-v1',
  };
}

/** @param {any} layout @param {string} id */
function positionOf(layout, id) {
  const position = layout.positions.find((entry) => entry.node_id === id);
  assert.ok(position, `layout position for ${id}`);
  return position;
}

test('acyclic chain gets increasing integer x with at least one layer gap', () => {
  const layout = layoutDiagram(spec({
    nodes: [node('c'), node('a'), node('b')],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
  }));
  assert.equal(layout.algorithm, 'layered_v1');
  assert.equal(layout.direction, 'LR');
  assert.equal(layout.positions.length, 3);
  const a = positionOf(layout, 'a');
  const b = positionOf(layout, 'b');
  const c = positionOf(layout, 'c');
  assert.ok(a.x < b.x && b.x < c.x, 'x increases along the chain');
  assert.ok(b.x - a.x >= LAYOUT_METRICS.min_node_width + LAYOUT_METRICS.layer_gap, 'layer gap is 96 plus width');
  assert.ok(c.x - b.x >= LAYOUT_METRICS.layer_gap);
  assert.equal(a.y, b.y, 'single-node layers share y');
  for (const position of layout.positions) {
    assert.ok(Number.isSafeInteger(position.x));
    assert.ok(Number.isSafeInteger(position.y));
    assert.ok(position.width >= LIMITS.node_min_width);
    assert.ok(position.height >= LIMITS.node_min_height);
  }
});

test('layout is deterministic and independent of input node/edge array order', () => {
  const forward = spec({
    nodes: [node('a'), node('b'), node('c'), node('d')],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'd'), edge('e4', 'a', 'd')],
  });
  const reversed = spec({
    nodes: [node('d'), node('c'), node('b'), node('a')],
    edges: [edge('e4', 'a', 'd'), edge('e3', 'c', 'd'), edge('e2', 'b', 'c'), edge('e1', 'a', 'b')],
  });
  const first = layoutDiagram(forward);
  const second = layoutDiagram(reversed);
  assert.deepEqual(second, first, 'same spec content => byte-identical layout');
  assert.equal(layoutDigest(first), layoutDigest(second));
  assert.deepEqual(layoutDiagram(forward), first, 'repeat call is stable');
});

test('cycle members are one SCC layer and the predecessor is one layer left', () => {
  const layout = layoutDiagram(spec({
    nodes: [node('a'), node('b'), node('c'), node('d')],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a'), edge('e4', 'd', 'a')],
  }));
  const a = positionOf(layout, 'a');
  const b = positionOf(layout, 'b');
  const c = positionOf(layout, 'c');
  const d = positionOf(layout, 'd');
  assert.equal(a.x, b.x, 'cycle SCC nodes share a layer column');
  assert.equal(b.x, c.x);
  assert.ok(d.x < a.x, 'predecessor of the SCC is in an earlier layer');
  // SCC members keep stable-ID order when the layer has no external barycenter.
  assert.ok(a.y < b.y && b.y < c.y);
});

test('self loop and back/cycle edges get separate routes', () => {
  const chain = spec({
    nodes: [node('a'), node('b')],
    edges: [edge('e1', 'a', 'b')],
  });
  const chainRoutes = routeEdges(chain, layoutDiagram(chain));
  assert.equal(chainRoutes.length, 1);
  assert.equal(chainRoutes[0].self_loop, false);
  assert.equal(chainRoutes[0].back, false);
  assert.ok(chainRoutes[0].points.length >= 2);
  for (const point of chainRoutes[0].points) {
    assert.ok(Number.isSafeInteger(point.x));
    assert.ok(Number.isSafeInteger(point.y));
  }

  const withLoop = spec({
    nodes: [node('a'), node('b')],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'b')],
  });
  const loopRoutes = routeEdges(withLoop, layoutDiagram(withLoop));
  const selfLoop = loopRoutes.find((route) => route.edge_id === 'e2');
  assert.equal(selfLoop.self_loop, true);
  assert.equal(selfLoop.back, false);
  assert.ok(selfLoop.points.length >= 4, 'self loop uses its own polyline');
  assert.notDeepEqual(selfLoop.points, loopRoutes[0].points);

  const cyclic = spec({
    nodes: [node('a'), node('b'), node('c')],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'a'), edge('e3', 'b', 'c')],
  });
  const cyclicRoutes = routeEdges(cyclic, layoutDiagram(cyclic));
  const back = cyclicRoutes.find((route) => route.edge_id === 'e2');
  assert.equal(back.back, true, 'intra-SCC/back edge is marked back');
  assert.ok(back.points.length >= 4);
  assert.notDeepEqual(back.points, cyclicRoutes.find((route) => route.edge_id === 'e1').points);
});

test('limit boundaries: exactly at limit passes, one over rejects LIMIT_EXCEEDED', () => {
  const two = spec({ nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b')] });
  assert.doesNotThrow(() => layoutDiagram(two, { limits: { nodes: 2, edges: 1 } }));
  assert.throws(
    () => layoutDiagram(spec({ nodes: [node('a'), node('b'), node('c')] }), { limits: { nodes: 2 } }),
    (error) => error.code === 'LIMIT_EXCEEDED',
  );
  assert.throws(
    () => layoutDiagram(spec({ nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')] }), { limits: { edges: 1 } }),
    (error) => error.code === 'LIMIT_EXCEEDED',
  );
  const tooManyNodes = Array.from({ length: LIMITS.nodes + 1 }, (_, index) => node(`n${index}`));
  assert.throws(
    () => layoutDiagram(spec({ nodes: tooManyNodes })),
    (error) => error.code === 'LIMIT_EXCEEDED',
  );
});

test('layer limit rejects before producing coordinates', () => {
  const chain = spec({
    nodes: [node('a'), node('b'), node('c')],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
  });
  assert.throws(
    () => layoutDiagram(chain, { limits: { max_layers: 2 } }),
    (error) => error.code === 'LIMIT_EXCEEDED',
  );
  assert.doesNotThrow(() => layoutDiagram(chain, { limits: { max_layers: 3 } }));
});

test('TB direction stacks layers vertically with the same gaps', () => {
  const layout = layoutDiagram(
    spec({ nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b')] }),
    { direction: 'TB' },
  );
  assert.equal(layout.direction, 'TB');
  const a = positionOf(layout, 'a');
  const b = positionOf(layout, 'b');
  assert.equal(a.x, b.x);
  assert.ok(b.y - a.y >= LIMITS.node_min_height + LIMITS.layer_gap);
});

test('same-layer nodes are ordered by stable ID (tie break)', () => {
  const layout = layoutDiagram(spec({ nodes: [node('b'), node('a'), node('c')] }));
  const a = positionOf(layout, 'a');
  const b = positionOf(layout, 'b');
  const c = positionOf(layout, 'c');
  assert.ok(a.y < b.y && b.y < c.y, 'ID order is the deterministic tie break');
  assert.ok(b.y - a.y >= LIMITS.node_min_height + LIMITS.node_gap);
});

test('two upstream barycenter sweeps are stable and deterministic', () => {
  const build = (reversed) => {
    const nodes = [node('root'), node('p1'), node('p2'), node('leaf1'), node('leaf2')];
    const edges = [
      edge('e1', 'root', 'p1'),
      edge('e2', 'root', 'p2'),
      edge('e3', 'p1', 'leaf1'),
      edge('e4', 'p2', 'leaf2'),
    ];
    return spec({ nodes: reversed ? nodes.reverse() : nodes, edges: reversed ? edges.reverse() : edges });
  };
  const first = layoutDiagram(build(false));
  const second = layoutDiagram(build(true));
  assert.deepEqual(first, second);
  // p1/leaf1 must stay on the same vertical channel as p2/leaf2 positions are
  // independently determined by the same algorithm.
  const p1 = positionOf(first, 'p1');
  const leaf1 = positionOf(first, 'leaf1');
  const p2 = positionOf(first, 'p2');
  const leaf2 = positionOf(first, 'leaf2');
  assert.equal(p1.y, leaf1.y);
  assert.equal(p2.y, leaf2.y);
  assert.ok(p1.y < p2.y, 'upper root branch stays above the lower one');
});

test('routeEdges is deterministic and validates its inputs', () => {
  const sample = spec({
    nodes: [node('a'), node('b'), node('c')],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'a', 'c'), edge('e3', 'b', 'c')],
  });
  const layout = layoutDiagram(sample);
  assert.deepEqual(routeEdges(sample, layout), routeEdges(sample, layout));
  assert.throws(() => routeEdges(sample, { algorithm: 'layered_v1', direction: 'LR', positions: [] }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => routeEdges(sample, { algorithm: 'layered_v1', direction: 'XX', positions: [] }), (error) => error.code === 'INVALID_INPUT');
});

test('invalid graph input fails closed (unknown endpoint, duplicate id)', () => {
  assert.throws(
    () => layoutDiagram(spec({ nodes: [node('a')], edges: [edge('e1', 'a', 'missing')] })),
    (error) => error.code === 'INVALID_SPEC',
  );
  assert.throws(
    () => layoutDiagram(spec({ nodes: [node('a'), node('a')] })),
    (error) => error.code === 'INVALID_SPEC',
  );
  assert.throws(() => layoutDiagram(null), (error) => error.code === 'INVALID_SPEC');
  assert.throws(() => layoutDiagram(spec({ nodes: [] }), { direction: 'diagonal' }), (error) => error.code === 'INVALID_INPUT');
});

test('wrapLabel wraps by code points and keeps explicit newlines', () => {
  assert.deepEqual(wrapLabel('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapLabel('line1\nline2'), ['line1', 'line2']);
  assert.deepEqual(wrapLabel('😀😀😀', 2), ['😀😀', '😀']);
  assert.deepEqual(wrapLabel(''), ['']);
  assert.deepEqual(wrapLabel('x'.repeat(25)), ['x'.repeat(24), 'x']);
});

test('nodeBoxSize honors the 160x64 minimum and grows with wrapped lines', () => {
  assert.deepEqual(nodeBoxSize('A'), { width: LIMITS.node_min_width, height: LIMITS.node_min_height, lines: ['A'] });
  const long = nodeBoxSize('x'.repeat(100));
  assert.ok(long.width >= LIMITS.node_min_width);
  assert.ok(long.height > LIMITS.node_min_height);
  assert.equal(long.lines.length, 5);
});

test('layoutDigest changes with direction and is stable for equal input', () => {
  const sample = spec({ nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b')] });
  const lr = layoutDiagram(sample);
  const tb = layoutDiagram(sample, { direction: 'TB' });
  assert.equal(layoutDigest(lr), layoutDigest(layoutDiagram(sample)));
  assert.notEqual(layoutDigest(lr), layoutDigest(tb));
  assert.match(layoutDigest(lr), /^[0-9a-f]{64}$/);
});

test('compareIds is code-unit stable', () => {
  assert.ok(compareIds('a', 'b') < 0);
  assert.ok(compareIds('b', 'a') > 0);
  assert.equal(compareIds('a', 'a'), 0);
  assert.deepEqual(['b', 'A', 'a'].sort(compareIds), ['A', 'a', 'b']);
});

test('empty graph produces an empty deterministic layout', () => {
  const layout = layoutDiagram(spec({ nodes: [], edges: [] }));
  assert.deepEqual(layout.positions, []);
  assert.deepEqual(routeEdges(spec({ nodes: [], edges: [] }), layout), []);
  assert.equal(typeof layoutDigest(layout), 'string');
});
