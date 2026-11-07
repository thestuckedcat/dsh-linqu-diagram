/**
 * T2 renderer tests — SVG whitelist/escaping, HTML CSP/offline policy,
 * legend/text-equivalent/hidden reporting, malicious label inertness.
 *
 * Run: node --test tests/render.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSvg, escXml, SAFE_ATTRIBUTES } from '../src/render-svg.mjs';
import { renderHtml, cspFor, INLINE_SCRIPT, INLINE_STYLE, SCRIPT_HASH, STYLE_HASH } from '../src/render-html.mjs';
import { emptyOverlay, specDigest } from '../src/contracts.mjs';
import { toDiagram } from '../src/evidence.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'tests', 'fixtures');
const FIXTURE_CLOCK = '2026-11-07T00:00:00.000Z';

const SVG_ELEMENTS = new Set(['svg', 'g', 'rect', 'path', 'line', 'polyline', 'text', 'tspan', 'title', 'desc']);

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

let cachedSpec = null;
/** Fixture-derived, schema-valid evidence spec (deterministic clock). */
async function fixtureSpec() {
  if (cachedSpec !== null) return cachedSpec;
  const sourceIdentity = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'source-identity.json'));
  const evidenceSubset = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'evidence-subset.json'));
  const currentIdentities = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'current-identities.json'));
  const result = toDiagram(
    { source_identity: sourceIdentity, evidence_subset: evidenceSubset, current_identities: currentIdentities },
    { clock: () => FIXTURE_CLOCK, revision: 1, direction: 'LR' },
  );
  assert.equal(result.status, 'ok');
  cachedSpec = result.spec;
  return cachedSpec;
}

/** @param {any} spec */
function overlayFor(spec, items = []) {
  const overlay = emptyOverlay({ diagram_id: spec.diagram_id, base_spec_digest: specDigest(spec), now: FIXTURE_CLOCK });
  overlay.items = items;
  return overlay;
}

/**
 * Remove text-node content, keeping only tags. Text content is inert data; all
 * safety scans must look at markup positions (tags/attributes) only.
 * @param {string} markup
 */
function markupOnly(markup) {
  return markup.replace(/>[^<]*</g, '><');
}

/**
 * Minimal start-tag/attribute parser for generated markup (our own output is
 * well-formed XML/HTML; this is a test helper, not a general parser).
 * @param {string} markup
 */
function extractTags(markup) {
  /** @type {{name:string, attributeNames:string[], attributeValues:string[]}[]} */
  const tags = [];
  const tagPattern = /<([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z][A-Za-z0-9:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
  let match;
  while ((match = tagPattern.exec(markup)) !== null) {
    const attributeNames = [];
    const attributeValues = [];
    const attributePattern = /([A-Za-z][A-Za-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attribute;
    while ((attribute = attributePattern.exec(match[2])) !== null) {
      attributeNames.push(attribute[1]);
      attributeValues.push(attribute[2] ?? attribute[3] ?? '');
    }
    tags.push({ name: match[1], attributeNames, attributeValues });
  }
  return tags;
}

/** @param {string} text */
function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** Allow only characters that are legal in XML 1.0. @param {string} text */
function sanitizedXmlText(text) {
  let output = '';
  for (const character of text) {
    const codePoint = /** @type {number} */ (character.codePointAt(0));
    const legal =
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (legal) output += character;
  }
  return output;
}

/** @param {string} svg */
function nodeTextContent(svg) {
  const chunks = [];
  for (const match of svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)) {
    chunks.push(decodeEntities(match[1].replace(/<[^>]+>/g, '')));
  }
  return chunks.join('');
}

/** @param {string} svg @param {string} nodeId */
function nodeGroup(svg, nodeId) {
  const pattern = new RegExp(`<g class="[^"]*"[^>]*data-node-id="${nodeId}"[^>]*>([\\s\\S]*?)<\\/g>`);
  const match = pattern.exec(svg);
  assert.ok(match, `node group for ${nodeId}`);
  return match[0];
}

test('renderSvg emits only whitelisted elements and fixed safe attributes', async () => {
  const spec = await fixtureSpec();
  const { svg } = renderSvg(spec);
  const tags = extractTags(svg);
  assert.ok(tags.length > 0);
  for (const tag of tags) {
    assert.ok(SVG_ELEMENTS.has(tag.name), `element <${tag.name}> is not whitelisted`);
    for (const attributeName of tag.attributeNames) {
      assert.ok(SAFE_ATTRIBUTES.includes(attributeName), `attribute ${attributeName} is not whitelisted`);
      assert.doesNotMatch(attributeName, /^on/i, 'event handler attribute emitted');
    }
  }
  const markup = markupOnly(svg);
  for (const forbidden of ['<script', '<foreignObject', '<image', '<iframe', '<style', 'href=', 'xlink:', 'url(']) {
    assert.equal(markup.includes(forbidden), false, `svg markup must not contain ${forbidden}`);
  }
  assert.doesNotMatch(markup, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(markup, /https?:\/\//i, 'svg markup must not contain any http(s):// literal');
  assert.match(svg, /^<svg xmlns="http&#x3a;\/\/www\.w3\.org\/2000\/svg"/);
});

test('renderSvg escapes labels, provides text equivalents and certainty legend', async () => {
  const spec = await fixtureSpec();
  const rendered = renderSvg(spec);
  assert.ok(rendered.svg.includes('svc_main'));
  assert.ok(rendered.svg.includes('calls')); // edge label
  assert.equal(rendered.text_equivalent.length, spec.nodes.length + spec.edges.length);
  for (const node of spec.nodes) {
    const entry = rendered.text_equivalent.find((item) => item.id === node.id);
    assert.ok(entry, `text equivalent for node ${node.id}`);
    assert.ok(entry.text.includes(node.label) || node.label.length > 60);
  }
  for (const edge of spec.edges) {
    const entry = rendered.text_equivalent.find((item) => item.id === edge.id);
    assert.ok(entry, `text equivalent for edge ${edge.id}`);
    assert.ok(entry.text.includes(edge.certainty));
  }
  assert.deepEqual(rendered.legend.map((entry) => entry.kind), ['exact', 'may', 'unresolved', 'unknown']);
  assert.deepEqual(rendered.legend.map((entry) => entry.count), [1, 1, 1, 1]);
  assert.deepEqual(rendered.hidden, { nodes: [], edges: [], count: 0 });
  // XML escaping: no raw label markup can appear.
  assert.equal(markupOnly(rendered.svg).includes('<script'), false);
});

test('renderSvg applies overlay visibility and reports hidden counts', async () => {
  const spec = await fixtureSpec();
  const overlay = overlayFor(spec, [
    { id: 'ann:vis-node', kind: 'visibility', target_ref: 'lib:util', hidden: true },
    { id: 'ann:vis-edge', kind: 'visibility', target_ref: 'edge:annotation-review', hidden: true },
  ]);
  const rendered = renderSvg(spec, { overlay });
  assert.equal(rendered.hidden.nodes.includes('lib:util'), true);
  assert.equal(rendered.hidden.edges.includes('edge:may-call'), true, 'edge with hidden endpoint is hidden');
  assert.equal(rendered.hidden.edges.includes('edge:annotation-review'), true);
  assert.equal(rendered.hidden.count, rendered.hidden.nodes.length + rendered.hidden.edges.length);
  assert.equal(rendered.svg.includes('data-node-id="lib:util"'), false);
  assert.equal(rendered.svg.includes('data-edge-id="edge:may-call"'), false);
  assert.equal(rendered.text_equivalent.some((entry) => entry.id === 'lib:util'), false);
  // Evidence is not rewritten: the base spec still contains the hidden nodes.
  assert.equal(spec.nodes.some((node) => node.id === 'lib:util'), true);
});

test('renderSvg applies overlay layout positions and renders annotation node/edge/note', async () => {
  const spec = await fixtureSpec();
  const movedOverlay = overlayFor(spec, [
    {
      id: 'ann:move-main',
      kind: 'layout',
      target_ref: 'svc:main',
      position: { x: 777, y: 555, width: 200, height: 80 },
    },
  ]);
  const moved = renderSvg(spec, { overlay: movedOverlay });
  const group = nodeGroup(moved.svg, 'svc:main');
  assert.match(group, /<rect x="777" y="555" width="200" height="80"/);

  const conceptual = await readJson(path.join(FIXTURE_ROOT, 'conceptual', 'input.json'));
  const conceptualResult = toDiagram({ conceptual_input: conceptual }, { clock: () => FIXTURE_CLOCK, revision: 1, direction: 'LR' });
  assert.equal(conceptualResult.status, 'ok');
  const annotationOverlay = overlayFor(conceptualResult.spec, [
    {
      id: 'ann:note-1',
      kind: 'note',
      target_ref: null,
      text: 'Free reviewer note',
      position: { x: 640, y: 24, width: 200, height: 64 },
    },
    {
      id: 'ann:node-1',
      kind: 'annotation_node',
      label: '额外注解节点',
      description: null,
      position: { x: 900, y: 24, width: 180, height: 64 },
    },
    {
      id: 'ann:edge-1',
      kind: 'annotation_edge',
      from: 'step:build',
      to: 'step:sign',
      label: '人工标注边',
      description: null,
    },
  ]);
  const annotated = renderSvg(conceptualResult.spec, { overlay: annotationOverlay });
  assert.ok(annotated.svg.includes('data-node-id="ann:node-1"'));
  assert.ok(annotated.svg.includes('data-edge-id="ann:edge-1"'));
  assert.ok(annotated.svg.includes('data-node-id="ann:note-1"'));
  assert.ok(annotated.svg.includes('Free reviewer note'));
  assert.ok(annotated.text_equivalent.some((entry) => entry.id === 'ann:node-1' || entry.id === 'ann:edge-1'));
  assert.ok(annotated.legend.find((entry) => entry.kind === 'unknown').count >= 1);
});

test('escXml escapes markup-significant characters and strips non-XML characters', () => {
  assert.equal(escXml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escXml('&lt;img&gt;'), '&amp;lt;img&amp;gt;');
  assert.equal(escXml('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
  assert.equal(escXml(']]>'), ']]&gt;');
  assert.equal(escXml("a'b"), 'a&apos;b');
  assert.equal(escXml('a\u0000b\u0007c'), 'abc');
  assert.equal(escXml('lone \uD800 surrogate'), 'lone  surrogate');
  assert.equal(escXml('emoji 😀 RTL \u202e'), 'emoji 😀 RTL \u202e');
  assert.equal(escXml('line1\nline2'), 'line1\nline2');
  assert.equal(escXml('https://evil.example/x.svg'), 'https&#58;//evil.example/x.svg');
  assert.equal(escXml(undefined), '');
  assert.equal(escXml(42), '42');
});

test('malicious fixture labels render as inert escaped text, never as markup/executables', async () => {
  const payloads = await readJson(path.join(FIXTURE_ROOT, 'malicious', 'payloads.json'));
  const labels = payloads.labels;
  assert.ok(labels.length >= 10);
  for (const label of labels) {
    const spec = {
      schema_version: 1,
      diagram_id: 'diagram:malicious',
      revision: 1,
      mode: 'conceptual',
      title: 'malicious label test',
      scope_ref: 'ws:test',
      sources: [],
      nodes: [{ id: 'n1', label, kind: 'module', origin: 'annotation', evidence_refs: [], description: null }],
      edges: [],
      layout: { algorithm: 'layered_v1', direction: 'LR', positions: [] },
      coverage: { complete: false, truncated: false, omitted_nodes: 0, omitted_edges: 0, unresolved_count: 0, notes: [] },
      source_state: 'unknown',
      generated_at: FIXTURE_CLOCK,
      renderer_ref: 'builtin:renderer-v1',
    };
    const rendered = renderSvg(spec);
    const markup = markupOnly(rendered.svg);
    for (const forbidden of ['<script', '<foreignObject', '<image', '<iframe', '<style', 'href=', 'xlink:', 'onerror=', 'onload=', 'onmouseover=']) {
      assert.equal(markup.includes(forbidden), false, `label ${JSON.stringify(label)} produced markup ${forbidden}`);
    }
    assert.doesNotMatch(markup, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(markup, /https?:\/\//i, 'no URL appears in markup positions');
    for (const tag of extractTags(rendered.svg)) {
      for (const value of tag.attributeValues) assert.doesNotMatch(value, /https?:\/\//i, 'attribute contains a URL');
    }
    // The label must survive as text (escaped, non-executable): decoded text
    // content equals the XML-sanitized label (display wrapping never changes
    // characters, explicit newlines become separate lines).
    assert.equal(nodeTextContent(rendered.svg), sanitizedXmlText(label).replace(/[\r\n]/g, ''), `text content for ${JSON.stringify(label)}`);
  }
  // Spot-check that markup payloads are escaped rather than emitted raw.
  const spec = {
    schema_version: 1,
    diagram_id: 'diagram:malicious-spot',
    revision: 1,
    mode: 'conceptual',
    title: 'spot',
    scope_ref: 'ws:test',
    sources: [],
    nodes: [{ id: 'n1', label: labels[0], kind: 'module', origin: 'annotation', evidence_refs: [], description: null }],
    edges: [],
    layout: { algorithm: 'layered_v1', direction: 'LR', positions: [] },
    coverage: { complete: false, truncated: false, omitted_nodes: 0, omitted_edges: 0, unresolved_count: 0, notes: [] },
    source_state: 'unknown',
    generated_at: FIXTURE_CLOCK,
    renderer_ref: 'builtin:renderer-v1',
  };
  const spotSvg = renderSvg(spec).svg;
  assert.ok(spotSvg.includes('&lt;script&gt;alert(1)'));
  assert.ok(nodeTextContent(spotSvg).includes('</script>'), 'escaped closing tag survives as text');
  assert.equal(spotSvg.includes('<script>alert(1)</script>'), false);
  assert.equal(spotSvg.includes('<!--'), false);
  assert.equal(spotSvg.includes('<!DOCTYPE'), false);
});

test('renderHtml uses one fixed script/style with matching CSP sha256 hashes', async () => {
  const spec = await fixtureSpec();
  const { html, script_hash } = renderHtml({ spec });
  assert.equal(script_hash, SCRIPT_HASH);
  assert.equal(script_hash, createHash('sha256').update(INLINE_SCRIPT, 'utf8').digest('base64'));
  assert.equal(STYLE_HASH, createHash('sha256').update(INLINE_STYLE, 'utf8').digest('base64'));

  const csp = cspFor(script_hash);
  assert.ok(html.includes(csp), 'CSP meta content must equal cspFor(script_hash)');
  assert.deepEqual(csp.split('; '), [
    "default-src 'none'",
    'img-src data:',
    `style-src 'sha256-${STYLE_HASH}'`,
    `script-src 'sha256-${script_hash}'`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]);

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'exactly one fixed inline script');
  assert.equal(createHash('sha256').update(scripts[0][1], 'utf8').digest('base64'), script_hash);
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.equal(styles.length, 1, 'exactly one fixed inline stylesheet');
  assert.equal(createHash('sha256').update(styles[0][1], 'utf8').digest('base64'), STYLE_HASH);

  const markup = markupOnly(html);
  for (const tag of extractTags(html)) {
    for (const attributeName of tag.attributeNames) {
      assert.doesNotMatch(attributeName, /^on/i, `event handler attribute ${attributeName} emitted`);
    }
  }
  assert.doesNotMatch(markup, /\son[a-z]+\s*=/i);
  for (const forbidden of ['http://', 'https://', 'fetch(', 'WebSocket', 'XMLHttpRequest', 'eval(', 'new Function', 'javascript:', 'file:', '<iframe', '<image', 'href=']) {
    assert.equal(markup.toLowerCase().includes(forbidden.toLowerCase()), false, `html markup must not contain ${forbidden}`);
  }
  assert.equal(html.includes('http://'), false);
  assert.equal(html.includes('https://'), false);
  assert.equal(html.includes('connect-src'), true);
  assert.equal(html.includes('Content-Security-Policy'), true);
  // The only script/script-ish element is the fixed one (no injected script tags).
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
});

test('renderHtml shows source/version bar, warnings, legend, text table and footer', async () => {
  const spec = await fixtureSpec();
  const overlay = overlayFor(spec, [
    { id: 'ann:vis-node', kind: 'visibility', target_ref: 'lib:util', hidden: true },
  ]);
  const staleSpec = { ...spec, source_state: 'stale', coverage: { ...spec.coverage, truncated: true, omitted_nodes: 2, omitted_edges: 3 } };
  const rendered = renderSvg(staleSpec, { overlay });
  const { html } = renderHtml({
    spec: staleSpec,
    overlay,
    svg: rendered.svg,
    text_equivalent: rendered.text_equivalent,
    legend: rendered.legend,
    hidden: rendered.hidden,
    manifest: { artifact_id: 'artifact-0123456789abcdef01234567', spec_digest: specDigest(staleSpec) },
    source_state: 'stale',
  });
  // Source/version bar.
  for (const expected of [staleSpec.diagram_id, 'stale', staleSpec.generated_at, staleSpec.renderer_ref, staleSpec.scope_ref === undefined ? '' : 'sources']) {
    if (expected.length > 0) assert.ok(html.includes(expected), `source bar includes ${expected}`);
  }
  assert.ok(html.includes('local-atlas-synthetic'));
  assert.ok(html.includes('snap-2026-11-07-01'));
  assert.ok(html.includes('artifact-0123456789abcdef01234567'));
  assert.ok(html.includes(specDigest(staleSpec)));
  // Warnings: unresolved, truncated, hidden, stale.
  assert.ok(html.includes('未解析关系：1 项'));
  assert.ok(html.includes('覆盖已截断'));
  assert.ok(html.includes('已隐藏证据'));
  assert.ok(html.includes('来源状态为 stale'));
  // Legend + text-equivalent table.
  assert.ok(html.includes('置信图例'));
  assert.ok(html.includes('unresolved 未解析'));
  assert.ok(html.includes('文字等价'));
  const tableRows = (html.match(/<tr>/g) ?? []).length - 1; // minus header row
  assert.equal(tableRows, rendered.text_equivalent.length);
  for (const entry of rendered.text_equivalent) assert.ok(html.includes(entry.id));
  // Footer.
  assert.ok(html.includes('artifact-footer'));
  assert.ok(html.includes('source_state=stale'));
  assert.ok(html.includes('mode=evidence'));
  assert.ok(html.includes(`generated_at=${spec.generated_at}`));
  assert.ok(html.includes(`renderer=${spec.renderer_ref}`));
  // No remote references in the whole document for fixture content.
  assert.equal(html.includes('http://'), false);
  assert.equal(html.includes('https://'), false);
});

test('renderHtml escapes hostile titles/labels into inert text', async () => {
  const spec = await fixtureSpec();
  const hostile = {
    ...spec,
    title: '<script>alert(1)</script>',
    nodes: spec.nodes.map((node) => (node.id === 'svc:main' ? { ...node, label: 'https://evil.example/x.svg' } : node)),
  };
  const { html } = renderHtml({ spec: hostile });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(html.includes('https://evil.example'), false, 'URL-like label text is escaped so no http(s):// literal remains');
  assert.ok(html.includes('https&#58;//evil.example/x.svg'));
  const markup = markupOnly(html);
  assert.doesNotMatch(markup, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(markup, /https?:\/\//i);
});

test('cspFor rejects invalid hashes and renderHtml rejects non-spec input', async () => {
  assert.throws(() => cspFor('not-a-hash'), /script_hash/);
  assert.throws(() => cspFor(''), /script_hash/);
  assert.throws(() => renderHtml({ spec: null }), /spec must be an object/);
  const spec = await fixtureSpec();
  assert.throws(() => renderSvg(null), (error) => error.code === 'INVALID_SPEC');
  assert.throws(() => renderSvg({ nodes: 'x', edges: [] }), (error) => error.code === 'INVALID_SPEC');
  assert.throws(() => renderSvg(spec, { overlay: [] }), (error) => error.code === 'INVALID_OVERLAY');
});

test('renderSvg is deterministic for the same spec/overlay/layout', async () => {
  const spec = await fixtureSpec();
  const overlay = overlayFor(spec, [
    { id: 'ann:vis-node', kind: 'visibility', target_ref: 'note:review', hidden: true },
  ]);
  const first = renderSvg(spec, { overlay });
  const second = renderSvg(spec, { overlay });
  assert.deepEqual(second, first);
});
